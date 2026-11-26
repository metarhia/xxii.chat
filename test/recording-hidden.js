'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { setTimeout: delay } = require('node:timers/promises');

const harness = require('./harness.js');

const { MEDIA_FLAGS, ORIGIN, launch, startCallServer } = harness;

const FLAGS = MEDIA_FLAGS.concat([
  '--disable-features=WebRtcHideLocalIpsWithMdns',
]);
const HIDDEN_STEPS = 7;
const STEP_MS = 1000;
const FRAME_TIMES = [0.5, 1.5, 2.5, 3.5, 4.5];

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
  const script = { source: nickScript(nick) };
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

const coverTab = async (browser, person) => {
  const { browserContextId } = person;
  const params = { url: 'about:blank', browserContextId };
  const { targetId } = await browser.request('Target.createTarget', params);
  const attach = { targetId, flatten: true };
  const target = await browser.request('Target.attachToTarget', attach);
  await browser.request('Page.bringToFront', {}, target.sessionId);
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
  return { left, right, first };
};

const PROBE = `
  const stage = app.callStage;
  const local = app.callSession.endpoint;
  const remote = stage.people.find((person) => person.endpoint !== local);
  window.ids = { local, remote: remote.endpoint };
  window.compositor = () => stage.recording.compositor;
  window.hashTile = (id) => {
    const compositor = window.compositor();
    const tile = compositor?.tiles.find((item) => item.id === id);
    if (!tile) return -1;
    const context = compositor.canvas.getContext('2d');
    const x = Math.round(tile.x + tile.width * 0.2);
    const y = Math.round(tile.y + tile.height * 0.2);
    const width = Math.round(tile.width * 0.6);
    const height = Math.round(tile.height * 0.6);
    const data = context.getImageData(x, y, width, height).data;
    let sum = 0;
    for (let i = 0; i < data.length; i += 37) sum = (sum + data[i]) | 0;
    return sum;
  };
  window.sample = () => {
    const compositor = window.compositor();
    const tile = compositor.tiles.find(
      (item) => item.id === window.ids.remote + '/camera');
    const track = stage.remote.get(window.ids.remote)?.camera;
    if (tile) {
      window.rect = {
        x: tile.x, y: tile.y, width: tile.width, height: tile.height,
      };
    }
    return {
      hidden: document.hidden,
      hash: window.hashTile(window.ids.remote + '/camera'),
      placeholder: tile ? tile.placeholder : 'none',
      muted: track ? track.muted : null,
      frames: compositor.frames,
      error: compositor.error ? String(compositor.error) : '',
    };
  };
  return true;`;

const framesScript = (url) => `
  const video = document.createElement('video');
  video.muted = true;
  video.src = ${JSON.stringify(url)};
  document.body.append(video);
  await new Promise((resolve, reject) => {
    video.onloadedmetadata = resolve;
    video.onerror = () => reject(new Error('video error'));
    setTimeout(() => reject(new Error('metadata timeout')), 15000);
  });
  const canvas = document.createElement('canvas');
  canvas.width = 32;
  canvas.height = 18;
  const context = canvas.getContext('2d', { willReadFrequently: true });
  const rect = window.rect;
  const times = ${JSON.stringify(FRAME_TIMES)};
  const hashes = new Array(times.length).fill(0);
  for (let index = 0; index < times.length; index++) {
    const time = times[index];
    video.currentTime = time;
    await new Promise((resolve) => {
      video.onseeked = resolve;
      setTimeout(resolve, 8000);
    });
    await new Promise((resolve) => setTimeout(resolve, 150));
    const x = rect.x + rect.width * 0.2;
    const y = rect.y + rect.height * 0.2;
    context.drawImage(video, x, y, rect.width * 0.6, rect.height * 0.6,
      0, 0, 32, 18);
    const data = context.getImageData(0, 0, 32, 18).data;
    let sum = 0;
    for (let i = 0; i < data.length; i += 3) {
      sum = (sum + data[i] * 31 + data[i + 1]) | 0;
    }
    hashes[index] = sum;
  }
  video.remove();
  return { hashes, duration: video.duration, rect };`;

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
  return { duration: buffer.duration, peak };`;

const distinct = (values) => new Set(values).size;

test(
  'recording keeps remote video changing while the recorder tab is hidden',
  { timeout: 240000 },
  async (t) => {
    await startCallServer(t);
    const browser = await launch(t, FLAGS);
    const call = await startCall(t, browser);
    const left = call.left;
    const run = (body) => harness.run(browser, left, body);
    await browser.request('Page.bringToFront', {}, left);
    await run(
      `const select = document.querySelector('[data-record=quality]');
      select.value = '720p30';
      select.dispatchEvent(new Event('change', { bubbles: true }));
      document.querySelector('.call-controls [data-action=record]')
        .click();
      return true;`,
    );
    await harness.wait(
      browser,
      left,
      `return app.callStage.recording.recorder?.state === 'recording';`,
    );
    await run(PROBE);
    await harness.wait(
      browser,
      left,
      `const sample = window.sample();
      return sample.placeholder === '' && sample.muted === false;`,
    );
    await coverTab(browser, call.first);
    await delay(1500);
    assert.equal(await run('return document.hidden;'), true);

    const samples = new Array(HIDDEN_STEPS).fill(null);
    for (let step = 0; step < HIDDEN_STEPS; step++) {
      samples[step] = await run('return window.sample();');
      await delay(STEP_MS);
    }
    assert.ok(samples.every((item) => item.hidden === true));
    assert.equal(samples.filter((item) => item.error).length, 0);
    assert.ok(samples.every((item) => item.placeholder === ''));
    assert.ok(samples.every((item) => item.muted === false));
    assert.ok(distinct(samples.map((item) => item.hash)) >= 4);
    const frames = samples.at(-1).frames - samples[0].frames;
    t.diagnostic(`hidden: ${frames} frames in ${HIDDEN_STEPS} samples`);

    await browser.request('Page.bringToFront', {}, left);
    await run(
      `window.confirm = () => true;
      document.querySelector('.call-controls [data-action=record]')
        .click(); return true;`,
    );
    await harness.wait(
      browser,
      left,
      `return app.callStage.recording.isActive === false;`,
      20000,
    );
    const stored = await run(
      `const root = await navigator.storage.getDirectory();
      const recordings = await root.getDirectoryHandle('recordings');
      const ids = [];
      for await (const name of recordings.keys()) ids.push(name);
      const directory = await recordings.getDirectoryHandle(ids[0]);
      const file = await (await directory.getFileHandle('meta.json')).getFile();
      return JSON.parse(await file.text());`,
    );
    assert.equal(stored.state, 'done');
    assert.ok(stored.duration >= 7000, `recorded ${stored.duration} ms`);
    await harness.wait(
      browser,
      left,
      'return !!navigator.serviceWorker.controller;',
    );
    const url = `/recordings/${stored.id}/program.${stored.extension}`;
    const played = await run(framesScript(url));
    t.diagnostic(`recorded frames: ${played.hashes.join(', ')}`);
    assert.ok(distinct(played.hashes) >= 4, `${played.hashes}`);
    const sound = await run(audioScript(stored.id, stored.extension));
    t.diagnostic(`audio: ${sound.duration} s, peak ${sound.peak}`);
    assert.ok(sound.duration >= 7);
    assert.ok(sound.peak > 0.02, `peak ${sound.peak}`);
    assert.deepEqual(browser.errors, []);
  },
);
