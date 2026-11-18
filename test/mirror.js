'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { setTimeout: delay } = require('node:timers/promises');

const harness = require('./harness.js');

const { MEDIA_FLAGS, ORIGIN, launch, startServer, stopServer } = harness;

const SETUP = `
  const { createMirror } = await import('/mirror.js');
  const source = document.createElement('canvas');
  source.width = 320;
  source.height = 180;
  const paint = source.getContext('2d');
  const render = () => {
    paint.fillStyle = '#ff0000';
    paint.fillRect(0, 0, 160, 180);
    paint.fillStyle = '#0000ff';
    paint.fillRect(160, 0, 160, 180);
  };
  render();
  const timer = setInterval(render, 20);
  const track = source.captureStream(30).getVideoTracks()[0];
  window.mirrorTest = { createMirror, track, timer };
  window.sample = async (output) => {
    const video = document.createElement('video');
    video.muted = true;
    video.srcObject = new MediaStream([output]);
    await video.play();
    await new Promise((resolve) => video.requestVideoFrameCallback(resolve));
    const canvas = document.createElement('canvas');
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    const context = canvas.getContext('2d');
    context.drawImage(video, 0, 0);
    const left = context.getImageData(20, 90, 1, 1).data;
    const right = context.getImageData(canvas.width - 20, 90, 1, 1).data;
    const width = video.videoWidth;
    const height = video.videoHeight;
    video.srcObject = null;
    return {
      width,
      height,
      left: [left[0], left[2]],
      right: [right[0], right[2]],
    };
  };
  return true;`;

const probe = (browser, session, body) => harness.run(browser, session, body);

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
  await probe(browser, sessionId, SETUP);
  return { targetId, sessionId };
};

const checkPath = async (browser, session, requested) => {
  const result = await probe(
    browser,
    session,
    `const { createMirror, track } = window.mirrorTest;
    const mirror = await createMirror(track, { path: '${requested}' });
    const pixels = await window.sample(mirror.track);
    const hint = mirror.track.contentHint;
    mirror.stop();
    const again = (() => {
      mirror.stop();
      return true;
    })();
    await new Promise((resolve) => setTimeout(resolve, 100));
    return {
      path: mirror.path,
      pixels,
      hint,
      again,
      output: mirror.track.readyState,
      source: track.readyState,
    };`,
  );
  assert.equal(result.path, requested);
  assert.equal(result.pixels.width, 320);
  assert.equal(result.pixels.height, 180);
  assert.ok(result.pixels.left[1] > 200 && result.pixels.left[0] < 50);
  assert.ok(result.pixels.right[0] > 200 && result.pixels.right[1] < 50);
  assert.equal(result.hint, 'motion');
  assert.equal(result.again, true);
  assert.equal(result.output, 'ended');
  assert.equal(result.source, 'live');
};

test(
  'mirror pipeline flips frames on both paths and stops cleanly',
  { timeout: 120000 },
  async (t) => {
    const dataPath = await fs.mkdtemp(path.join(os.tmpdir(), 'xxii-data-'));
    t.after(() => fs.rm(dataPath, { recursive: true, force: true }));
    const server = await startServer(dataPath);
    t.after(() => stopServer(server));
    const browser = await launch(t, MEDIA_FLAGS);
    const { sessionId } = await openPage(browser);
    await checkPath(browser, sessionId, 'processor');
    await checkPath(browser, sessionId, 'canvas');

    const ended = await probe(
      browser,
      sessionId,
      `const { createMirror, track } = window.mirrorTest;
      const clone = track.clone();
      const mirror = await createMirror(clone, { path: 'canvas' });
      const gone = new Promise((resolve) =>
        mirror.track.addEventListener('ended', resolve));
      clone.stop();
      clone.dispatchEvent(new Event('ended'));
      await gone;
      return mirror.track.readyState;`,
    );
    assert.equal(ended, 'ended');
  },
);

test(
  'canvas fallback keeps its frame rate in a hidden tab',
  { timeout: 120000 },
  async (t) => {
    const dataPath = await fs.mkdtemp(path.join(os.tmpdir(), 'xxii-data-'));
    t.after(() => fs.rm(dataPath, { recursive: true, force: true }));
    const server = await startServer(dataPath);
    t.after(() => stopServer(server));
    const browser = await launch(t, MEDIA_FLAGS);
    const hidden = await openPage(browser);
    const session = hidden.sessionId;
    await probe(
      browser,
      session,
      `const { createMirror, track } = window.mirrorTest;
      const mirror = await createMirror(track, { path: 'canvas' });
      window.mirrorTest.mirror = mirror;
      window.mirrorTest.frames = 0;
      const processor = new MediaStreamTrackProcessor({
        track: mirror.track,
      });
      const reader = processor.readable.getReader();
      const count = async () => {
        const result = await reader.read();
        if (result.done) return;
        result.value.close();
        window.mirrorTest.frames++;
        count();
      };
      count();
      return true;`,
    );
    const other = await openPage(browser);
    await browser.request('Page.bringToFront', {}, other.sessionId);
    await delay(500);
    const state = await probe(browser, session, 'return document.hidden;');
    assert.equal(state, true);
    const before = await probe(
      browser,
      session,
      'return window.mirrorTest.frames;',
    );
    await delay(2000);
    const after = await probe(
      browser,
      session,
      'return window.mirrorTest.frames;',
    );
    const fps = (after - before) / 2;
    assert.ok(fps >= 20, `hidden frame rate ${fps}`);
    await probe(browser, session, 'window.mirrorTest.mirror.stop(); return 1;');
  },
);
