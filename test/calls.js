'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { setTimeout: delay } = require('node:timers/promises');
const { MEDIA_FLAGS, launch } = require('./harness.js');

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
