'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');

const harness = require('./harness.js');

const { ORIGIN, MEDIA_FLAGS, launch, startCallServer } = harness;
const ROW = '.recordings-list .recording-item';
const MENU_STATE = `
  const items = document.querySelectorAll('.recording-menu .menu-item');
  return Object.fromEntries(Array.from(items, (item) => [
    item.textContent, item.getAttribute('aria-disabled') === 'true']));
`;
const READY = `return document.readyState === 'complete' &&
  navigator.serviceWorker.controller && window.repairRequest;`;

const TRACK_REPAIR = `
  localStorage.setItem('xxii:nick', 'alex');
  const NativeWorker = window.Worker;
  window.Worker = class extends NativeWorker {
    postMessage(message, transfers) {
      if (message.type !== 'repair') {
        return super.postMessage(message, transfers);
      }
      this.addEventListener('message', ({ data }) => {
        window.repairReply = data;
      }, { once: true, capture: true });
      window.repairRequest = true;
      const send = () => super.postMessage(message, transfers);
      if (sessionStorage.getItem('delay-repair')) window.sendRepair = send;
      else send();
    }
  };
`;

const openTab = async (browser) => {
  const target = { url: 'about:blank' };
  const { targetId } = await browser.request('Target.createTarget', target);
  const attached = await browser.request('Target.attachToTarget', {
    targetId,
    flatten: true,
  });
  const session = attached.sessionId;
  await browser.request('Runtime.enable', {}, session);
  await browser.request('Page.enable', {}, session);
  await browser.request(
    'Page.addScriptToEvaluateOnNewDocument',
    {
      source: TRACK_REPAIR,
    },
    session,
  );
  await browser.request('Page.navigate', { url: `${ORIGIN}/` }, session);
  const run = (body) => harness.run(browser, session, body);
  const wait = (body) => harness.wait(browser, session, body);
  const click = (path) => run(`document.querySelector('${path}').click();`);
  const reply = async () => {
    await wait('return Boolean(window.repairReply);');
    const data = await run('return window.repairReply;');
    assert.equal(data.ok, true, data.error);
    return data;
  };
  await wait(READY);
  return { session, run, wait, click, reply };
};

const startRecording = (extension, id) => `
  const { Recorder, RecordingWriter, FORMATS } = await import('/recorder.js');
  const { QUALITIES } = await import('/layout.js');
  const canvas = document.createElement('canvas');
  canvas.width = 640;
  canvas.height = 360;
  const context = canvas.getContext('2d');
  let frame = 0;
  setInterval(() => {
    context.fillStyle = 'hsl(' + (frame++ * 9 % 360) + ' 80% 50%)';
    context.fillRect(0, 0, canvas.width, canvas.height);
  }, 30);
  const audio = new AudioContext();
  const oscillator = audio.createOscillator();
  const destination = audio.createMediaStreamDestination();
  oscillator.connect(destination);
  oscillator.start();
  const video = canvas.captureStream(30).getVideoTracks()[0];
  const sound = destination.stream.getAudioTracks()[0];
  const compositor = { canvas, track: video };
  const mixer = { track: sound };
  const writer = new RecordingWriter();
  const extension = '${extension}';
  const formats = FORMATS.filter((format) => format.extension === extension);
  const quality = QUALITIES['720p30'];
  const options = { compositor, mixer, writer, quality, formats };
  const recorder = new Recorder(options);
  window.fixture = { recorder, writer };
  return recorder.start({
    id: '${id}', title: 'Unfinished', chat: 'general', chatName: '!general',
    call: '', started: Date.now(), options: {}, people: [],
  });
`;

const storageOf = (id) => `
  const root = await navigator.storage.getDirectory();
  const recordings = await root.getDirectoryHandle('recordings');
  const directory = await recordings.getDirectoryHandle('${id}');
  const read = async (name) => {
    const handle = await directory.getFileHandle(name);
    return handle.getFile();
  };
  const meta = JSON.parse(await (await read('meta.json')).text());
`;

const storedOf = (id) => `
  ${storageOf(id)}
  const file = await read('program.' + meta.extension);
  let headerDuration = null;
  if (meta.extension === 'webm') {
    const { durationSlotOf } = await import('/recording-webm.js');
    const header = await file.slice(0, 4096).arrayBuffer();
    const bytes = new Uint8Array(header);
    const slot = durationSlotOf(bytes);
    if (slot?.bytes === bytes) {
      const ticks = new DataView(header).getFloat64(slot.offset);
      headerDuration = ticks * slot.scale / 1000000;
    }
  }
  return { meta, size: file.size, headerDuration };
`;

const seedFailedEntry = `
  const root = await navigator.storage.getDirectory();
  const recordings = await root.getDirectoryHandle('recordings');
  const options = { create: true };
  const directory = await recordings.getDirectoryHandle('broken', options);
  const handle = await directory.getFileHandle('meta.json', options);
  const writable = await handle.createWritable();
  await writable.write('{');
  await writable.close();
`;

const reloadForRepair = async (browser, tab) => {
  await tab.run(`
    sessionStorage.setItem('delay-repair', 'yes');
  `);
  await browser.request('Page.reload', {}, tab.session);
  await tab.wait('return typeof window.sendRepair === "function";');
};

const assertLiveAcrossTab = async (browser, id, left) => {
  const right = await openTab(browser);
  const active = `${storageOf(id)} return meta.state;`;
  assert.equal((await right.reply()).repaired, 0);
  assert.equal(await right.run(active), 'recording');
  await left.wait('return window.fixture.recorder.activeMs >= 6500;');
  await left.run('window.fixture.recorder.pause();');
  await left.wait(`${storageOf(id)} return meta.state === 'paused';`);
  await reloadForRepair(browser, right);
  await right.run('window.sendRepair();');
  assert.equal((await right.reply()).repaired, 0);
  assert.equal(await right.run(active), 'paused');
  await right.click('#recordings-btn');
  await right.wait(`
    const row = document.querySelector('${ROW}');
    return row?.querySelector('.recording-state').textContent === 'paused' &&
      row.querySelector('.recording-play').disabled &&
      row.querySelector('.recording-delete').disabled &&
      row.querySelector('.recording-download').hidden;
  `);
  await right.click(`${ROW} .recording-more`);
  assert.deepEqual(await right.run(MENU_STATE), {
    Play: true,
    Rename: true,
    Delete: true,
  });
  await right.run(`document.querySelector('.recording-menu').dispatchEvent(
    new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));`);
  return right;
};

const waitForPlayback = async (tab, id, extension, duration) => {
  await tab.click('.recording-play');
  await tab.wait(`
    const video = document.querySelector('.recordings-player');
    return video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA &&
      video.videoWidth === 640 && Number.isFinite(video.duration) &&
      video.currentTime > 0;
  `);
  const played = await tab.run(`
    const video = document.querySelector('.recordings-player');
    return { path: new URL(video.src).pathname, duration: video.duration };
  `);
  assert.equal(played.path, `/recordings/${id}/program.${extension}`);
  assert.ok(played.duration >= duration / 1000 - 0.1, `${played.duration} s`);
};

for (const extension of ['webm', 'mp4']) {
  test(
    `scenario 17: startup repairs and plays interrupted ${extension}`,
    {
      timeout: 120000,
    },
    async (t) => {
      await startCallServer(t);
      const browser = await launch(t, MEDIA_FLAGS);
      const tab = await openTab(browser);
      await tab.reply();
      await browser.request('Page.bringToFront', {}, tab.session);
      const id = `interrupted-${extension}`;
      const lock = `xxii-recording-${id}`;
      const isHeld = `(await navigator.locks.query()).held.some(
      ({ name }) => name === '${lock}')`;
      const meta = await tab.run(startRecording(extension, id));
      assert.equal(meta.state, 'recording');
      assert.equal(await tab.run(`return ${isHeld};`), true);

      let other = null;
      if (extension === 'mp4') {
        other = await assertLiveAcrossTab(browser, id, tab);
      } else {
        await tab.run(seedFailedEntry);
      }
      await tab.wait('return window.fixture.recorder.activeMs >= 6500;');
      await tab.run('window.fixture.writer.stop();');
      await tab.wait(`return !${isHeld};`);
      const before = await tab.run(storedOf(id));
      assert.equal(before.meta.state, other ? 'paused' : 'recording');
      assert.ok(before.size > 0);
      if (extension === 'webm') {
        assert.equal(before.meta.duration, 0);
        assert.equal(before.meta.size, 0);
        assert.equal(before.headerDuration, 0);
      }

      await reloadForRepair(browser, tab);
      await browser.request('Page.bringToFront', {}, tab.session);
      await tab.click('#recordings-btn');
      await tab.wait(`return document.querySelector('${ROW} .recording-play')
      ?.disabled === true;`);
      if (other) {
        await reloadForRepair(browser, other);
        await Promise.all([
          tab.run('window.sendRepair();'),
          other.run('window.sendRepair();'),
        ]);
        const replies = await Promise.all([tab.reply(), other.reply()]);
        assert.equal(replies[0].repaired + replies[1].repaired, 1);
        assert.equal(replies[0].failed + replies[1].failed, 0);
      } else {
        await tab.run('window.sendRepair();');
        const reply = await tab.reply();
        assert.equal(reply.repaired, 1);
        assert.equal(reply.failed, 1);
        assert.equal(
          await tab.run(`return document.querySelector(
        '.recordings-repair').hidden;`),
          false,
        );
      }

      await tab.wait(`return document.querySelector('${ROW} .recording-state')
      ?.textContent === 'interrupted';`);
      const after = await tab.run(storedOf(id));
      assert.equal(after.meta.state, 'interrupted');
      assert.equal(after.meta.size, before.size);
      assert.equal(after.size, before.size);
      const duration = after.meta.duration;
      assert.ok(duration > 500 && duration <= 6500, `${duration} ms`);
      assert.notEqual(duration, before.meta.duration);
      if (extension === 'webm') assert.equal(after.headerDuration, duration);
      const details = await tab.run(`
      const row = document.querySelector('${ROW}');
      const badge = row.querySelector('.recording-state');
      const enabled = (selector) => !row.querySelector(selector).disabled;
      const actions = ['.recording-play', '.recording-delete'].every(enabled);
      return { badge: badge.textContent, note: badge.title, actions,
        download: !row.querySelector('.recording-download').hidden };
    `);
      assert.deepEqual(details, {
        badge: 'interrupted',
        note: 'Recording ended unexpectedly',
        actions: true,
        download: true,
      });
      await waitForPlayback(tab, id, extension, duration);
      assert.deepEqual(browser.errors, []);
    },
  );
}
