'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { setTimeout: delay } = require('node:timers/promises');

const harness = require('./harness.js');

const { MEDIA_FLAGS, ORIGIN, launch, startCallServer } = harness;

const FLAGS = MEDIA_FLAGS.concat([
  '--disable-features=WebRtcHideLocalIpsWithMdns',
]);
const RECORD_MS = 5000;
const FIELDS = [
  'people',
  'maxSpeakers',
  'screen',
  'placement',
  'others',
  'othersPosition',
  'audio',
  'includeMe',
  'screenAudio',
  'names',
  'noVideo',
  'quality',
  'background',
  'image',
];

const nickScript = (nick) =>
  `localStorage.setItem('xxii:nick', ${JSON.stringify(nick)});`;

const untilLoaded = async (browser, sessionId) => {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    const state = await browser
      .evaluate(sessionId, 'document.readyState')
      .catch(() => '');
    if (state === 'complete') return;
    await delay(50);
  }
  throw new Error('Page did not load');
};

const openPerson = async (t, browser, nick) => {
  const created = await browser.request('Target.createBrowserContext');
  const { browserContextId } = created;
  t.after(() =>
    browser
      .request('Target.disposeBrowserContext', { browserContextId })
      .catch(() => undefined),
  );
  const blank = { url: 'about:blank', browserContextId };
  const { targetId } = await browser.request('Target.createTarget', blank);
  const attach = { targetId, flatten: true };
  const target = await browser.request('Target.attachToTarget', attach);
  const { sessionId } = target;
  await browser.request('Runtime.enable', {}, sessionId);
  await browser.request('Page.enable', {}, sessionId);
  const source = nickScript(nick);
  const script = { source };
  await browser.request(
    'Page.addScriptToEvaluateOnNewDocument',
    script,
    sessionId,
  );
  await browser.request('Page.navigate', { url: `${ORIGIN}/` }, sessionId);
  await untilLoaded(browser, sessionId);
  const ready =
    'return app.connected === true && app.mesh.peers.has(app.peerId);';
  await harness.wait(browser, sessionId, ready);
  return { sessionId, browserContextId };
};

const waitFor = async (browser, session, body, timeoutMs = 20000) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await browser.request('Page.bringToFront', {}, session);
    const result = await harness.run(browser, session, body).catch(() => false);
    if (result) return;
    await delay(100);
  }
  const detail = await harness.run(browser, session, body);
  throw new Error(`Condition failed: ${JSON.stringify(detail)}`);
};

const startCall = async (t, browser) => {
  const run = (session, body) => harness.run(browser, session, body);
  const first = await openPerson(t, browser, 'alex');
  const second = await openPerson(t, browser, 'bob');
  const left = first.sessionId;
  const right = second.sessionId;
  await run(
    left,
    `app.selectChat('general');
    await app.startCall('general');
    return true;`,
  );
  const token = await run(left, 'return app.callToken;');
  await run(
    right,
    `app.selectChat('general');
    await app.startCall('general', { token: ${JSON.stringify(token)} });
    return true;`,
  );
  const join = `document.querySelector('#prejoin [data-action=join]')
    .click(); return true;`;
  await run(left, join);
  await run(right, join);
  const linked = 'return app.callSession?.linkCount === 1;';
  await waitFor(browser, left, linked);
  await waitFor(browser, right, linked);
  return { left, right, first, second };
};

const opfsScript = (wanted = '') => `
  const root = await navigator.storage.getDirectory();
  const recordings = await root.getDirectoryHandle('recordings');
  const ids = [];
  for await (const name of recordings.keys()) ids.push(name);
  const id = ${JSON.stringify(wanted)} || ids[0];
  const directory = await recordings.getDirectoryHandle(id);
  const names = [];
  for await (const name of directory.keys()) names.push(name);
  const metaFile = await (await directory.getFileHandle('meta.json')).getFile();
  const meta = JSON.parse(await metaFile.text());
  const program = 'program.' + meta.extension;
  const file = await (await directory.getFileHandle(program)).getFile();
  const head = new Uint8Array(await file.slice(0, 16).arrayBuffer());
  const poster = await (await directory.getFileHandle('poster.jpg')).getFile();
  const jpeg = new Uint8Array(await poster.slice(0, 2).arrayBuffer());
  return {
    ids,
    names: names.toSorted(),
    meta,
    size: file.size,
    head: Array.from(head),
    poster: poster.size,
    jpeg: Array.from(jpeg),
  };`;

const playScript = (url) => `
  const video = document.createElement('video');
  video.muted = true;
  video.preload = 'auto';
  video.src = ${JSON.stringify(url)};
  document.body.append(video);
  await new Promise((resolve, reject) => {
    video.onloadedmetadata = resolve;
    video.onerror = () => reject(new Error('video error ' + video.error?.code));
    setTimeout(() => reject(new Error('metadata timeout')), 15000);
  });
  const duration = video.duration;
  const width = video.videoWidth;
  const height = video.videoHeight;
  video.currentTime = Math.min(1, duration / 2);
  const seeked = await new Promise((resolve) => {
    video.onseeked = () => resolve(true);
    setTimeout(() => resolve(false), 8000);
  });
  video.remove();
  return { duration, width, height, seeked };`;

const fetchScript = (url) => `
  const full = await fetch(${JSON.stringify(url)});
  const bytes = (await full.arrayBuffer()).byteLength;
  const part = await fetch(${JSON.stringify(url)}, {
    headers: { Range: 'bytes=0-9' },
  });
  const partBytes = (await part.arrayBuffer()).byteLength;
  const missing = await fetch('/recordings/none/program.mp4');
  const named = ${JSON.stringify(url)} + '?download=1&name=a.mp4';
  const download = await fetch(named);
  return {
    full: [full.status, full.headers.get('content-type'), bytes,
      full.headers.get('accept-ranges')],
    part: [part.status, part.headers.get('content-range'), partBytes],
    missing: missing.status,
    disposition: download.headers.get('content-disposition'),
  };`;

const clustersScript = (id, extension) => `
  const root = await navigator.storage.getDirectory();
  const recordings = await root.getDirectoryHandle('recordings');
  const directory = await recordings.getDirectoryHandle(${JSON.stringify(id)});
  const handle = await directory.getFileHandle('program.${extension}');
  const bytes = new Uint8Array(await (await handle.getFile()).arrayBuffer());
  const times = [];
  for (let i = 0; i < bytes.length - 16; i++) {
    const isCluster = bytes[i] === 0x1f && bytes[i + 1] === 0x43 &&
      bytes[i + 2] === 0xb6 && bytes[i + 3] === 0x75;
    if (!isCluster) continue;
    let at = i + 4;
    const length = Math.clz32(bytes[at]) - 23;
    at += length;
    if (bytes[at] !== 0xe7) continue;
    const size = bytes[at + 1] & 0x7f;
    let value = 0;
    for (let k = 0; k < size; k++) value = value * 256 + bytes[at + 2 + k];
    times.push(value);
  }
  return times;`;

const audioScript = (id, extension) => `
  const root = await navigator.storage.getDirectory();
  const recordings = await root.getDirectoryHandle('recordings');
  const directory = await recordings.getDirectoryHandle(${JSON.stringify(id)});
  const handle = await directory.getFileHandle('program.${extension}');
  const bytes = await (await handle.getFile()).arrayBuffer();
  const context = new AudioContext();
  const buffer = await context.decodeAudioData(bytes);
  const data = buffer.getChannelData(0);
  let peak = 0;
  for (const value of data) peak = Math.max(peak, Math.abs(value));
  await context.close();
  const channels = buffer.numberOfChannels;
  return { duration: buffer.duration, peak, channels };`;

const CHOSEN = `
  const { FORMATS } = await import('/recorder.js');
  const found = FORMATS.find((format) =>
    MediaRecorder.isTypeSupported(format.mime));
  return found ? found.mime : '';`;

test(
  'scenario 13: record 5 s, the file is done, the player loads it',
  { timeout: 240000 },
  async (t) => {
    await startCallServer(t);
    const browser = await launch(t, FLAGS);
    const call = await startCall(t, browser);
    const left = call.left;
    const right = call.right;
    const run = (body) => harness.run(browser, left, body);
    await browser.request('Page.bringToFront', {}, left);
    assert.equal(
      await run(`return document.querySelector('.call-recording').
        classList.contains('hidden');`),
      true,
    );
    await run(
      `document.querySelector('.call-record-control [data-action=record-panel]')
        .click(); return true;`,
    );
    const names = await run(
      `const panel = document.querySelector('.call-record');
      if (!panel.hasAttribute('data-open')) throw new Error('panel closed');
      return Array.from(panel.querySelectorAll('[data-record]'))
        .map((control) => control.dataset.record);`,
    );
    assert.deepEqual(names, FIELDS);
    await run(
      `const select = document.querySelector('[data-record=quality]');
      select.value = '720p30';
      select.dispatchEvent(new Event('change', { bubbles: true }));
      const people = document.querySelector('[data-record=people]');
      people.value = 'grid';
      people.dispatchEvent(new Event('change', { bubbles: true }));
      return true;`,
    );
    await harness.wait(
      browser,
      left,
      `const canvas = document.querySelector('.record-preview canvas');
      return canvas?.width === 1280 && canvas.height === 720 &&
        app.callStage.recording.compositor?.frames > 10;`,
    );
    const stateText = await run(
      `return document.querySelector('.record-state').textContent;`,
    );
    assert.equal(stateText, 'not recording');

    await run(
      `document.querySelector('.call-record-control [data-action=record]')
        .click(); return true;`,
    );
    await harness.wait(
      browser,
      left,
      `return app.callStage.recording.recorder?.state === 'recording';`,
    );
    const noticed = `const note = document.querySelector('.call-recording');
      return !note.classList.contains('hidden') &&
        note.textContent === '● alex recording';`;
    await waitFor(browser, left, noticed);
    await waitFor(browser, right, noticed);
    const announced = await harness.run(
      browser,
      right,
      `return document.getElementById('call-announcements').textContent;`,
    );
    assert.ok(announced.includes('alex started recording'), announced);

    await delay(RECORD_MS);
    const control = await run(
      `const button = document.querySelector(
        '.call-record-control [data-action=record]');
      return {
        text: button.textContent,
        dot: button.querySelector('.rec-dot')?.textContent,
        pressed: button.getAttribute('aria-pressed'),
        state: document.querySelector('.record-state').textContent,
        active: app.callStage.recording.recorder.activeMs,
      };`,
    );
    assert.equal(control.dot, '●');
    assert.match(control.text, /^ ?● \d\d:\d\d · [\d.]+ (B|KB|MB)$/);
    assert.equal(control.pressed, 'true');
    assert.match(control.state, /^recording · \d\d:\d\d · /);
    assert.ok(control.active >= RECORD_MS, `active ${control.active}`);
    await run(
      `document.querySelector('.call-record-control [data-action=record]')
        .click(); return true;`,
    );
    await harness.wait(
      browser,
      left,
      `return app.callStage.recording.isActive === false;`,
      20000,
    );
    const quiet = `return document.querySelector('.call-recording')
      .classList.contains('hidden');`;
    await waitFor(browser, left, quiet);
    await waitFor(browser, right, quiet);

    const alive = `return app.callSession.phase === 'joined' &&
      app.callSession.linkCount === 1 &&
      app.callStage.media.cameraTrack.readyState === 'live';`;
    await waitFor(browser, left, alive);
    await waitFor(browser, right, alive);

    const stored = await run(opfsScript());
    const chosen = await run(CHOSEN);
    assert.equal(stored.ids.length, 1);
    const program = `program.${stored.meta.extension}`;
    assert.deepEqual(stored.names, ['meta.json', 'poster.jpg', program]);
    assert.equal(stored.meta.state, 'done');
    assert.ok(stored.meta.size > 0);
    assert.equal(stored.meta.size, stored.size);
    assert.equal(stored.meta.mime, chosen);
    assert.ok(chosen.startsWith('video/'), chosen);
    assert.equal(stored.meta.id, stored.ids[0]);
    assert.equal(stored.meta.chat, 'general');
    assert.equal(stored.meta.chatName, '!general');
    assert.equal(stored.meta.call, await run('return app.callSession.call;'));
    assert.ok(stored.meta.stopped >= stored.meta.started + RECORD_MS);
    assert.ok(stored.meta.duration >= RECORD_MS);
    assert.ok(stored.meta.duration < RECORD_MS + 2500);
    assert.deepEqual(stored.meta.people.toSorted(), ['alex', 'bob']);
    assert.equal(stored.meta.options.quality, '720p30');
    assert.equal(stored.meta.options.people, 'grid');
    assert.equal(stored.meta.folder, '');
    assert.ok(stored.meta.title.startsWith('!general 20'));
    assert.deepEqual(stored.jpeg, [0xff, 0xd8]);
    assert.ok(stored.poster > 0);
    t.diagnostic(
      `${stored.meta.mime}, ${stored.size} bytes, ` +
        `${stored.meta.duration} ms, state ${stored.meta.state}`,
    );
    if (stored.meta.extension === 'mp4') {
      const ftyp = String.fromCharCode(...stored.head.slice(4, 8));
      assert.equal(ftyp, 'ftyp');
    } else {
      assert.deepEqual(stored.head.slice(0, 4), [0x1a, 0x45, 0xdf, 0xa3]);
    }

    const sound = await run(audioScript(stored.meta.id, stored.meta.extension));
    t.diagnostic(
      `audio: ${sound.duration} s, ${sound.channels} channels, ` +
        `peak ${sound.peak}`,
    );
    assert.ok(sound.duration >= 4 && sound.duration <= 6);
    assert.ok(sound.peak > 0.02, `peak ${sound.peak}`);
    const file = `program.${stored.meta.extension}`;
    const url = `/recordings/${stored.meta.id}/${file}`;
    const played = await run(playScript(url));
    assert.ok(
      played.duration >= 4 && played.duration <= 6,
      `${played.duration}`,
    );
    assert.equal(played.width, 1280);
    assert.equal(played.height, 720);
    t.diagnostic(`player: ${played.duration} s, seeked ${played.seeked}`);
    const fetched = await run(fetchScript(url));
    const type = stored.meta.mime.split(';')[0];
    assert.deepEqual(fetched.full, [200, type, stored.size, 'bytes']);
    assert.deepEqual(fetched.part, [206, `bytes 0-9/${stored.size}`, 10]);
    assert.equal(fetched.missing, 404);
    assert.ok(fetched.disposition.startsWith('attachment; filename="a.mp4"'));

    const record = await run(
      `const ids = Array.from(app.replica.keys('recording'));
      const record = app.replica.get(ids[0]);
      return { count: ids.length, ...record, peer: app.peerId };`,
    );
    assert.equal(record.count, 1);
    assert.equal(record.chat, 'general');
    assert.equal(record.nick, 'alex');
    assert.equal(record.author, record.peer);
    assert.equal(record.call, await run('return app.callSession.call;'));
    assert.ok(record.stopped >= record.timestamp + RECORD_MS);
    await waitFor(
      browser,
      left,
      `return Array.from(document.querySelectorAll('.recording-card'))
        .some((card) => /^● alex recorded \\d+ min$/.test(card.textContent));`,
    );
    await waitFor(
      browser,
      right,
      `const ids = Array.from(app.replica.keys('recording'));
      return ids.length === 1 &&
        typeof app.replica.get(ids[0]).stopped === 'number';`,
    );
    assert.deepEqual(browser.errors, []);
  },
);

const openPage = async (browser) => {
  const target = { url: 'about:blank' };
  const { targetId } = await browser.request('Target.createTarget', target);
  const attach = { targetId, flatten: true };
  const attached = await browser.request('Target.attachToTarget', attach);
  const { sessionId } = attached;
  await browser.request('Runtime.enable', {}, sessionId);
  await browser.request('Page.enable', {}, sessionId);
  await browser.request('Page.navigate', { url: `${ORIGIN}/` }, sessionId);
  for (let attempt = 0; attempt < 150; attempt++) {
    const state = await browser
      .evaluate(sessionId, 'document.readyState + location.href')
      .catch(() => '');
    if (state.startsWith('complete') && state.includes(ORIGIN)) break;
    await delay(100);
  }
  await browser.request('Page.bringToFront', {}, sessionId);
  return sessionId;
};

const SETUP = `
  const { Compositor } = await import('/compositor.js');
  const { Mixer } = await import('/mixer.js');
  const { Recorder, RecordingWriter, FORMATS } = await import('/recorder.js');
  const { QUALITIES } = await import('/layout.js');
  const canvas = document.createElement('canvas');
  canvas.width = 640;
  canvas.height = 360;
  const context = canvas.getContext('2d');
  let step = 0;
  setInterval(() => {
    context.fillStyle = 'hsl(' + (step++ * 9 % 360) + ' 80% 50%)';
    context.fillRect(0, 0, 640, 360);
  }, 20);
  const audio = new AudioContext();
  const oscillator = audio.createOscillator();
  const destination = audio.createMediaStreamDestination();
  oscillator.connect(destination);
  oscillator.start();
  window.list = [{
    endpoint: 'ada:1', nick: 'ada', local: false, optOut: false,
    camera: canvas.captureStream(30).getVideoTracks()[0], screen: null,
    mic: destination.stream.getAudioTracks()[0], screenAudio: null,
    level: 0, speaking: false,
  }];
  window.record = async (extension, id) => {
    const options = { quality: '720p30', people: 'grid', screen: 'off' };
    const members = () => window.list;
    const compositor = new Compositor({ members, options: () => options });
    compositor.start();
    const mixer = new Mixer({
      members, options: () => options, onScreen: () => compositor.onScreen,
    });
    mixer.start();
    const writer = new RecordingWriter();
    const formats = FORMATS.filter((format) => format.extension === extension);
    const recorder = new Recorder({
      compositor, mixer, writer, quality: QUALITIES['720p30'], formats,
    });
    const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    await recorder.start({
      id, title: 'test', chat: 'general', chatName: '!general', call: '',
      started: Date.now(), options, people: ['ada'],
    });
    await wait(2000);
    recorder.pause();
    await wait(1500);
    recorder.resume();
    await wait(2000);
    const meta = await recorder.stop({ people: ['ada', 'late'] });
    compositor.stop();
    mixer.stop();
    writer.stop();
    return { meta, state: recorder.state, error: String(recorder.error) };
  };
  return true;`;

for (const extension of ['mp4', 'webm']) {
  test(
    `recording ${extension}: pause leaves no gap and the duration is set`,
    { timeout: 120000 },
    async (t) => {
      await startCallServer(t);
      const browser = await launch(t, MEDIA_FLAGS);
      const session = await openPage(browser);
      const run = (body) => harness.run(browser, session, body);
      await harness.wait(browser, session, 'return true;');
      await run(SETUP);
      const id = `${extension}-test`;
      const result = await run(
        `return await window.record(
          ${JSON.stringify(extension)}, ${JSON.stringify(id)});`,
      );
      assert.equal(result.state, 'stopped');
      assert.equal(result.error, 'null');
      assert.equal(result.meta.state, 'done');
      const stored = await run(opfsScript(id));
      assert.deepEqual(stored.names, [
        'meta.json',
        'poster.jpg',
        `program.${extension}`,
      ]);
      assert.equal(stored.meta.extension, extension);
      assert.equal(stored.meta.size, stored.size);
      assert.deepEqual(stored.meta.people, ['ada', 'late']);
      assert.ok(stored.meta.duration >= 3900 && stored.meta.duration < 4600);
      const waiting = 'return !!navigator.serviceWorker.controller;';
      await harness.wait(browser, session, waiting);
      const url = `/recordings/${id}/program.${extension}`;
      const played = await run(playScript(url));
      t.diagnostic(
        `${stored.meta.mime}: ${stored.meta.duration} ms stored, ` +
          `${played.duration} s in the player, seeked ${played.seeked}`,
      );
      assert.ok(Number.isFinite(played.duration));
      assert.ok(played.duration >= 3.6 && played.duration <= 4.7);
      if (extension === 'webm') {
        assert.deepEqual(stored.head.slice(0, 4), [0x1a, 0x45, 0xdf, 0xa3]);
        const times = await run(clustersScript(id, extension));
        assert.ok(times.length >= 3, `${times}`);
        const last = times.at(-1);
        assert.ok(last <= stored.meta.duration + 300, `last cluster ${last}`);
        assert.ok(last >= 2500, `last cluster ${last}`);
      }
      assert.deepEqual(browser.errors, []);
    },
  );
}

test(
  'scenario 15: opt-out shows opted out and silences that voice',
  { timeout: 240000 },
  async (t) => {
    await startCallServer(t);
    const browser = await launch(t, FLAGS);
    const call = await startCall(t, browser);
    const left = call.left;
    const right = call.right;
    const run = (session, body) => harness.run(browser, session, body);
    await browser.request('Page.bringToFront', {}, left);
    await run(
      left,
      `document.querySelector('.call-record-control [data-action=record-panel]')
        .click();
      const people = document.querySelector('[data-record=people]');
      people.value = 'grid';
      people.dispatchEvent(new Event('change', { bubbles: true }));
      document.querySelector('.call-record-control [data-action=record]')
        .click();
      return true;`,
    );
    await harness.wait(
      browser,
      left,
      `return app.callStage.recording.recorder?.state === 'recording';`,
    );
    const bob = await run(
      left,
      `const person = app.callStage.people.find((item) => item.nick === 'bob');
      return person ? person.endpoint : '';`,
    );
    assert.ok(bob);
    const mic = JSON.stringify(`${bob}/mic`);
    const heard = `const mixer = app.callStage.recording.mixer;
      return (mixer.gains.get(${mic}) ?? 0) > 0;`;
    await waitFor(browser, left, heard);

    const offered = `const button = document.querySelector('.call-opt-out');
      return !button.classList.contains('hidden') &&
        button.getAttribute('aria-pressed') === 'false';`;
    await waitFor(browser, right, offered);
    const ownHidden = `return document.querySelector('.call-opt-out')
      .classList.contains('hidden');`;
    assert.equal(await run(left, ownHidden), true);

    await run(
      right,
      `document.querySelector('.call-opt-out').click(); return true;`,
    );
    const opted = `const recording = app.callStage.recording;
      const tiles = recording.compositor.tiles;
      const tile = tiles.find((item) => item.placeholder === 'opted out');
      const gain = recording.mixer.gains.get(${mic}) ?? 0;
      return Boolean(tile) && gain === 0;`;
    await waitFor(browser, left, opted);
    const marked = `return Array.from(
      document.querySelectorAll('.call-roster .roster-opted'),
    ).length === 1;`;
    await waitFor(browser, left, marked);
    const pressed = `const notice = document.querySelector('.call-opt-out');
      const people = document.querySelector('.people-opt-out');
      return notice.getAttribute('aria-pressed') === 'true' &&
        people.getAttribute('aria-pressed') === 'true' &&
        notice.textContent === 'opted out · undo';`;
    await waitFor(browser, right, pressed);

    await run(
      right,
      `document.querySelector('.call-opt-out').click(); return true;`,
    );
    const back = `const recording = app.callStage.recording;
      const tiles = recording.compositor.tiles;
      const tile = tiles.find((item) => item.placeholder === 'opted out');
      return !tile && (recording.mixer.gains.get(${mic}) ?? 0) > 0;`;
    await waitFor(browser, left, back);

    await run(
      left,
      `document.querySelector('.call-record-control [data-action=record]')
        .click(); return true;`,
    );
    await harness.wait(
      browser,
      left,
      `return app.callStage.recording.isActive === false;`,
      20000,
    );
  },
);
