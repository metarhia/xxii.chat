'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { setTimeout: delay } = require('node:timers/promises');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const harness = require('./harness.js');

const { MEDIA_FLAGS, ORIGIN, launch, startServer, stopServer } = harness;

const page = () =>
  new Promise((resolve) => {
    const server = http.createServer((request, response) => {
      response.writeHead(200, { 'content-type': 'text/html' });
      response.end('<!doctype html><title>calls</title>');
    });
    server.listen(0, '127.0.0.1', () => resolve(server));
  });

const open = async (browser, url) => {
  const params = { url };
  const { targetId } = await browser.request('Target.createTarget', params);
  const attach = { targetId, flatten: true };
  const target = await browser.request('Target.attachToTarget', attach);
  const { sessionId } = target;
  await browser.request('Runtime.enable', {}, sessionId);
  await browser.request('Page.enable', {}, sessionId);
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    const href = await browser
      .evaluate(sessionId, 'location.href')
      .catch(() => '');
    if (href === url) return sessionId;
    await delay(50);
  }
  throw new Error(`Page did not open: ${url}`);
};

test('fake media devices in Chrome', { timeout: 60000 }, async (t) => {
  const server = await page();
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const { port } = server.address();
  const browser = await launch(t, MEDIA_FLAGS);
  const session = await open(browser, `http://127.0.0.1:${port}/`);
  const devices = await browser.evaluate(
    session,
    `(async () => {
      if (document.readyState === 'loading') {
        await new Promise((resolve) => {
          const options = { once: true };
          document.addEventListener('DOMContentLoaded', resolve, options);
        });
      }
      const camera = await navigator.mediaDevices.getUserMedia({
        audio: true,
        video: true,
      });
      const labels = camera.getTracks().map((track) => track.label);
      camera.getTracks().forEach((track) => track.stop());
      const screen = await navigator.mediaDevices.getDisplayMedia({
        video: true,
        audio: true,
      });
      const video = screen.getVideoTracks()[0];
      const audio = screen.getAudioTracks()[0];
      const surface = video.getSettings().displaySurface;
      screen.getTracks().forEach((track) => track.stop());
      return { labels, surface, hasAudio: Boolean(audio) };
    })()`,
  );
  assert.ok(devices.labels.includes('fake_device_0'));
  assert.ok(devices.labels.includes('Fake Default Audio Input'));
  assert.equal(devices.surface, 'monitor');
  assert.equal(devices.hasAudio, true);
});

test('network settings for ICE servers', { timeout: 120000 }, async (t) => {
  const dataPath = await fs.mkdtemp(path.join(os.tmpdir(), 'xxii-data-'));
  t.after(() => fs.rm(dataPath, { recursive: true, force: true }));
  const server = await startServer(dataPath);
  t.after(() => stopServer(server));
  const browser = await launch(t);
  const run = (session, body) => harness.run(browser, session, body);
  const wait = (session, body) => harness.wait(browser, session, body);

  const untilLoaded = async (sessionId) => {
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

  const openApp = async () => {
    const url = `${ORIGIN}/`;
    const params = { url };
    const { targetId } = await browser.request('Target.createTarget', params);
    const attach = { targetId, flatten: true };
    const target = await browser.request('Target.attachToTarget', attach);
    const { sessionId } = target;
    await browser.request('Runtime.enable', {}, sessionId);
    await browser.request('Page.enable', {}, sessionId);
    await untilLoaded(sessionId);
    const ready = 'return app.uplink?.link.source !== "";';
    await wait(sessionId, ready);
    return sessionId;
  };

  const session = await openApp();
  const rejected = await run(
    session,
    `document.getElementById('settings-btn').click();
    document.querySelector('[data-section="network"]').click();
    document.getElementById('ice-url').value = 'http://example.com';
    document.getElementById('ice-add').click();
    const note = document.getElementById('notification');
    const visible = getComputedStyle(note).display !== 'none';
    const stored = localStorage.getItem('xxii:ice') ?? '';
    const listed = document.getElementById('ice-servers').textContent;
    return {
      view: document.querySelector('.app').dataset.view,
      section: document.querySelector('[aria-current=page]').dataset.section,
      visible,
      text: note.textContent,
      stored,
      listed,
    };`,
  );
  assert.equal(rejected.view, 'settings');
  assert.equal(rejected.section, 'network');
  assert.equal(rejected.visible, true);
  assert.equal(rejected.text.length > 0, true);
  assert.equal(rejected.stored.includes('http://example.com'), false);
  assert.equal(rejected.listed.includes('http://example.com'), false);

  const url = 'stun:stun.example.com:3478';
  const added = await run(
    session,
    `document.getElementById('ice-url').value = ${JSON.stringify(url)};
    document.getElementById('ice-add').click();
    const listed = document.getElementById('ice-servers').textContent;
    const stored = localStorage.getItem('xxii:ice') ?? '';
    return { listed, stored };`,
  );
  assert.equal(added.listed.includes(url), true);
  assert.equal(added.stored.includes(url), true);

  await run(session, 'window.__xxiiReload = 1; return true;');
  await browser.request('Page.reload', {}, session);
  let isReloaded = false;
  const reloadDeadline = Date.now() + 15000;
  while (Date.now() < reloadDeadline) {
    const expression =
      'document.readyState === "complete" && window.__xxiiReload !== 1';
    const result = browser.evaluate(session, expression);
    isReloaded = await result.catch(() => false);
    if (isReloaded) break;
    await delay(50);
  }
  assert.equal(isReloaded, true);
  const ready = 'return app.uplink?.link.source !== "";';
  await wait(session, ready);
  const kept = await run(
    session,
    `const listed = document.getElementById('ice-servers').textContent;
    const stored = localStorage.getItem('xxii:ice') ?? '';
    return { listed, stored };`,
  );
  assert.equal(kept.listed.includes(url), true);
  assert.equal(kept.stored.includes(url), true);
});
