'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { setTimeout: delay } = require('node:timers/promises');

const harness = require('./harness.js');

const { MEDIA_FLAGS, ORIGIN, launch, startCallServer } = harness;

const WIDTH = 320;
const HEIGHT = 180;
const FRAMES = 6;
const RED = { y: 76, u: 84, v: 255 };
const BLUE = { y: 29, u: 255, v: 107 };

const planeOf = (width, height, left, right) => {
  const plane = Buffer.alloc(width * height);
  const half = width / 2;
  for (let row = 0; row < height; row++) {
    plane.fill(left, row * width, row * width + half);
    plane.fill(right, row * width + half, (row + 1) * width);
  }
  return plane;
};

const y4mOf = () => {
  const header = `YUV4MPEG2 W${WIDTH} H${HEIGHT} F30:1 Ip A1:1 C420jpeg\n`;
  const luma = planeOf(WIDTH, HEIGHT, RED.y, BLUE.y);
  const blue = planeOf(WIDTH / 2, HEIGHT / 2, RED.u, BLUE.u);
  const red = planeOf(WIDTH / 2, HEIGHT / 2, RED.v, BLUE.v);
  const frame = Buffer.concat([Buffer.from('FRAME\n'), luma, blue, red]);
  const frames = new Array(FRAMES).fill(frame);
  return Buffer.concat([Buffer.from(header)].concat(frames));
};

const openPerson = async (t, browser) => {
  const created = await browser.request('Target.createBrowserContext');
  const { browserContextId } = created;
  t.after(() =>
    browser
      .request('Target.disposeBrowserContext', { browserContextId })
      .catch(() => undefined),
  );
  const url = `${ORIGIN}/`;
  const params = { url, browserContextId };
  const { targetId } = await browser.request('Target.createTarget', params);
  const attach = { targetId, flatten: true };
  const target = await browser.request('Target.attachToTarget', attach);
  const { sessionId } = target;
  await browser.request('Runtime.enable', {}, sessionId);
  await browser.request('Page.enable', {}, sessionId);
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    const state = await browser
      .evaluate(sessionId, 'document.readyState')
      .catch(() => '');
    if (state === 'complete') break;
    await delay(50);
  }
  const ready =
    'return app.connected === true && app.mesh.peers.has(app.peerId);';
  await harness.wait(browser, sessionId, ready);
  return sessionId;
};

const waitFor = async (browser, session, body) => {
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    await browser.request('Page.bringToFront', {}, session);
    const result = await harness.run(browser, session, body).catch(() => false);
    if (result) return;
    await delay(100);
  }
  const detail = await harness.run(browser, session, body);
  throw new Error(`Condition failed: ${JSON.stringify(detail)}`);
};

const SAMPLE = `window.sampleHalves = (selector) => {
  const video = document.querySelector(selector);
  if (!video || video.readyState < 2 || !video.videoWidth) return null;
  const canvas = document.createElement('canvas');
  canvas.width = video.videoWidth;
  canvas.height = video.videoHeight;
  const context = canvas.getContext('2d');
  context.drawImage(video, 0, 0);
  const row = Math.floor(canvas.height / 2);
  const left = context.getImageData(canvas.width * 0.15, row, 1, 1).data;
  const right = context.getImageData(canvas.width * 0.85, row, 1, 1).data;
  const side = (pixel) => {
    if (pixel[0] > 150 && pixel[2] < 100) return 'red';
    if (pixel[2] > 150 && pixel[0] < 100) return 'blue';
    return 'other';
  };
  return side(left) + '/' + side(right);
};
window.setupCounts = () => {
  window.offers = 0;
  const proto = RTCPeerConnection.prototype;
  const original = proto.setLocalDescription;
  proto.setLocalDescription = function (...args) {
    window.offers++;
    return original.apply(this, args);
  };
};
return true;`;

const sampled = (selector, expected) =>
  `const value = window.sampleHalves(${JSON.stringify(selector)});
  return value === ${JSON.stringify(expected)} ? true : value;`;

test(
  'mirrored camera reaches the self view and the remote tile',
  { timeout: 240000 },
  async (t) => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'xxii-y4m-'));
    t.after(() => fs.rm(directory, { recursive: true, force: true }));
    const video = path.join(directory, 'camera.y4m');
    await fs.writeFile(video, y4mOf());
    await startCallServer(t);
    const flags = MEDIA_FLAGS.concat([
      '--disable-features=WebRtcHideLocalIpsWithMdns',
      `--use-file-for-fake-video-capture=${video}`,
    ]);
    const browser = await launch(t, flags);
    const run = (session, body) => harness.run(browser, session, body);
    const left = await openPerson(t, browser);
    const right = await openPerson(t, browser);
    const host = await run(
      left,
      `app.selectChat('general');
      await app.startCall('general');
      return { endpoint: app.callSession.endpoint, token: app.callToken };`,
    );
    const token = JSON.stringify(host.token);
    await run(
      right,
      `app.selectChat('general');
      await app.startCall('general', { token: ${token} }); return true;`,
    );
    const join = `document.querySelector('#prejoin [data-action=join]')
      .click(); return true;`;
    await run(left, join);
    await run(right, join);
    const linked = 'return app.callSession?.linkCount === 1;';
    await waitFor(browser, left, linked);
    await waitFor(browser, right, linked);
    await run(left, SAMPLE);
    await run(right, SAMPLE);

    const self = '.call-tile.local video';
    const remote = `.call-tile[data-endpoint=${JSON.stringify(
      host.endpoint,
    )}] video`;
    await waitFor(browser, left, sampled(self, 'blue/red'));
    await waitFor(browser, right, sampled(remote, 'blue/red'));
    const state = await run(
      left,
      `const media = app.callStage.media;
      return { path: media.mirrorState, mirrored: media.cameraTrack !==
        media.cameraSource, source: media.cameraSource.readyState };`,
    );
    assert.match(state.path, /^(processor|canvas)$/);
    assert.equal(state.mirrored, true);
    assert.equal(state.source, 'live');

    await run(
      left,
      `document.querySelector('[data-action="stats-overlay"]').click();
      return true;`,
    );
    await waitFor(
      browser,
      left,
      `const tile = document.querySelector('.call-tile.local .tile-stats');
      return tile.textContent === 'mirror: ' +
        app.callStage.media.mirrorState && !tile.classList.contains('hidden');`,
    );

    await run(left, 'window.setupCounts();');
    const before = await run(
      left,
      `window.senderBefore = app.callSession.sender(
        app.callStage.people.find(
          (p) => p.endpoint !== app.callSession.endpoint).endpoint,
        'camera');
      window.mirrorTrack = app.callStage.media.cameraTrack;
      window.rawTrack = app.callStage.media.cameraSource;
      return window.offers;`,
    );
    assert.equal(before, 0);
    await run(
      left,
      `document.querySelector('#call-view [data-setting="mirror"]').click();
      return true;`,
    );
    await waitFor(browser, left, sampled(self, 'red/blue'));
    await waitFor(browser, right, sampled(remote, 'red/blue'));
    const after = await run(
      left,
      `const media = app.callStage.media;
      const other = app.callStage.people.find(
        (p) => p.endpoint !== app.callSession.endpoint).endpoint;
      const sender = app.callSession.sender(other, 'camera');
      return {
        offers: window.offers,
        sameSender: sender === window.senderBefore,
        sentRaw: sender.track === window.rawTrack,
        path: media.mirrorState,
        mirrorEnded: window.mirrorTrack.readyState,
        sourceLive: window.rawTrack.readyState,
        links: app.callSession.linkCount,
      };`,
    );
    assert.deepEqual(after, {
      offers: 0,
      sameSender: true,
      sentRaw: true,
      path: 'off',
      mirrorEnded: 'ended',
      sourceLive: 'live',
      links: 1,
    });
    await waitFor(
      browser,
      left,
      `return document.querySelector('.call-tile.local .tile-stats')
        .textContent === 'mirror: off';`,
    );

    await run(
      left,
      `document.querySelector('#call-view [data-setting="mirror"]').click();
      return true;`,
    );
    await waitFor(browser, right, sampled(remote, 'blue/red'));
    const offers = await run(left, 'return window.offers;');
    assert.equal(offers, 0);

    await run(
      left,
      `const media = app.callStage.media;
      window.cameras = [media.cameraSource, media.cameraTrack];
      document.querySelector('#call-view [data-action="camera"]').click();
      return true;`,
    );
    await waitFor(
      browser,
      left,
      `const media = app.callStage.media;
      return window.cameras.every((track) => track.readyState === 'ended') &&
        !media.cameraTrack && !media.cameraSource;`,
    );
    assert.deepEqual(browser.errors, []);
  },
);
