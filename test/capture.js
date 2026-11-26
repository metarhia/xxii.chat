'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const harness = require('./harness.js');

const { ORIGIN, MEDIA_FLAGS, launch, startCallServer, script } = harness;
const PANEL = '[data-panel="capture"].panel-body';
const RECORD = `${PANEL} [data-action="record"]`;
const PAUSE = `${PANEL} [data-action="record-pause"]`;
const source = (name) => `${PANEL} [data-source="${name}"]`;

const selection = (name, value) => `
  const select = document.querySelector('${PANEL} [data-record="${name}"]');
  select.value = ${JSON.stringify(value)};
  select.dispatchEvent(new Event('change', { bubbles: true }));
  return true;
`;

const currentId = `return app.capture.recorder.meta.id;`;
const closed = `
  return !app.capture && !document.querySelector('${PANEL} canvas');
`;

const storedMeta = (id) => `
  const root = await navigator.storage.getDirectory();
  const list = await root.getDirectoryHandle('recordings');
  const directory = await list.getDirectoryHandle(${JSON.stringify(id)});
  const handle = await directory.getFileHandle('meta.json');
  const file = await handle.getFile();
  return JSON.parse(await file.text());
`;

const picture = (slots) => `
  const canvas = document.querySelector('${PANEL} canvas');
  const tiles = app.capture.compositor.tiles;
  const slots = tiles.map(({ id }) => id.split('/').at(-1));
  return canvas?.width === 1280 && tiles.every(({ label }) => !label) &&
    slots.join() === ${JSON.stringify(slots.join())};
`;

test('solo capture', { timeout: 180000 }, async (t) => {
  await startCallServer(t);
  const browser = await launch(t, MEDIA_FLAGS);
  const { targetId } = await browser.request('Target.createTarget', {
    url: `${ORIGIN}/`,
  });
  const { sessionId } = await browser.request('Target.attachToTarget', {
    targetId,
    flatten: true,
  });
  await browser.request('Page.bringToFront', {}, sessionId);
  const run = (body) => harness.run(browser, sessionId, body);
  const wait = (body, ms) => harness.wait(browser, sessionId, body, ms);
  const click = async (selector) => {
    const result = await browser.request(
      'Runtime.evaluate',
      {
        expression: script(
          `document.querySelector(${JSON.stringify(selector)}).click();`,
        ),
        userGesture: true,
        returnByValue: true,
        awaitPromise: true,
      },
      sessionId,
    );
    assert.equal(result.exceptionDetails, undefined);
  };
  const set = (name, value) => run(selection(name, value));
  const recording = `return app.capture?.recorder?.state === 'recording';`;
  const elapsed = (ms) => `return app.capture?.recorder?.activeMs >= ${ms};`;
  await wait(`return app.connected && navigator.serviceWorker.controller &&
    app.mesh.peers.has(app.peerId);`);
  await run(`app.usernameInput.value = 'alex'; app.syncUsername();
    app.selectChat('general'); return true;`);

  await t.test(
    'session capture previews three layouts and saves locally',
    async () => {
      await run(`app.openCapture(''); return true;`);
      await set('quality', '720p30');
      assert.equal(
        await run(`return app.capture.media.cameraTrack === null &&
      app.capture.media.micTrack === null;`),
        true,
      );
      await click(source('camera'));
      await click(source('mic'));
      await click(source('screen'));
      await wait(`return app.capture.media.micTrack?.readyState === 'live' &&
      app.capture.media.screenTrack?.readyState === 'live' &&
      app.capture.media.cameraTrack?.readyState === 'live';`);
      await wait(picture(['screen', 'camera']));
      assert.equal(
        await run(`
      const tiles = app.capture.compositor.tiles;
      const screen = tiles[0];
      const camera = tiles[1];
      return camera.x > screen.x && camera.y > screen.y &&
        camera.x + camera.width < screen.x + screen.width &&
        camera.y + camera.height < screen.y + screen.height;
    `),
        true,
      );
      await set('captureLayout', 'camera');
      await wait(picture(['camera']));
      await set('captureLayout', 'screen');
      await wait(picture(['screen']));
      await set('captureLayout', 'bubble');
      await wait(picture(['screen', 'camera']));
      await click(source('screenAudio'));
      assert.equal(await run(`return app.capture.options.screenAudio;`), true);
      await click(RECORD);
      await wait(recording);
      const id = await run(currentId);
      await wait(elapsed(1000));
      await click(PAUSE);
      await wait(`return app.capture.recorder.state === 'paused';`);
      await click(PAUSE);
      await wait(recording);
      await wait(elapsed(3000));
      await click(RECORD);
      await wait(`return app.capture.isActive === false;`);
      const meta = await run(storedMeta(id));
      assert.equal(meta.state, 'done');
      assert.equal(meta.call, '');
      assert.equal(meta.chat, '');
      assert.equal(meta.chatName, 'capture');
      assert.ok(meta.duration >= 3000);
      assert.ok(meta.size > 0);
      const records = `return Array.from(app.replica.keys('recording'));`;
      assert.deepEqual(await run(records), []);
      assert.equal(
        await run(`
      const { cameraTrack, micTrack, screenTrack } = app.capture.media;
      window.captureTracks = [cameraTrack, micTrack, screenTrack];
      return captureTracks.every((track) => track.readyState === 'live');
    `),
        true,
      );
      await click('#recordings-btn');
      await wait(
        `return !!document.querySelector('.recording-item[data-id="${id}"]');`,
      );
      await click('#panel-close-btn');
      assert.equal(
        await run(`return captureTracks.every(
      (track) => track.readyState === 'ended');`),
        true,
      );
      await click('#recordings-close');
    },
  );

  await t.test(
    'direct capture publishes a final card and confirms closing',
    async () => {
      await run(`
      const peer = crypto.randomUUID();
      await app.openDirect(peer);
      app.selectDirect(peer);
      const close = window.confirm;
      window.captureConfirms = [];
      window.captureConfirm = false;
      window.confirm = (text) => {
        captureConfirms.push(text);
        return captureConfirm;
      };
      window.restoreConfirm = () => { window.confirm = close; };
      return true;
    `);
      await click('#direct-capture-btn');
      await set('quality', '720p30');
      await click(source('camera'));
      await wait(
        `return app.capture.media.cameraTrack?.readyState === 'live';`,
      );
      await click(RECORD);
      await wait(recording);
      const id = await run(currentId);
      const records = `
        const replica = app.replicaOf(app.chat);
        return Array.from(replica.keys('recording'));
      `;
      assert.deepEqual(await run(records), []);
      assert.equal(
        await run(`return !!document.querySelector('.recording-card');`),
        false,
      );
      await run(
        `window.directCamera = app.capture.media.cameraTrack; return true;`,
      );
      await click('#panel-close-btn');
      assert.equal(await run(recording), true);
      await wait(elapsed(1500));
      await run(`window.captureConfirm = true; return true;`);
      await click('#panel-close-btn');
      await wait(closed);
      await wait(`return directCamera.readyState === 'ended';`);
      const card = `.recording-card[data-id="${id}"]`;
      await wait(`return !!document.querySelector('${card}');`);
      const saved = await run(`const replica = app.replicaOf(app.chat);
      restoreConfirm();
      return {
        chat: app.chat,
        meta: replica.get('${id}'),
        text: document.querySelector('${card}').textContent,
        confirms: captureConfirms,
        general: Array.from(app.replica.keys('recording')),
      };
    `);
      assert.equal(saved.meta.call, '');
      assert.equal(saved.meta.chat, saved.chat);
      assert.ok(saved.meta.stopped >= saved.meta.timestamp);
      assert.match(saved.text, /^● alex captured \d+ min$/);
      assert.equal(saved.confirms.length, 2);
      assert.match(saved.confirms[0], /Stop the recording/);
      assert.deepEqual(saved.general, []);
    },
  );

  await t.test('folder capture creates playable parts', async () => {
    await run(`
      const root = await navigator.storage.getDirectory();
      const options = { create: true };
      const folder = await root.getDirectoryHandle('solo-folder', options);
      window.captureFolder = folder;
      window.showDirectoryPicker = () => Promise.resolve(captureFolder);
      return true;
    `);
    await run(`app.openCapture(''); return true;`);
    await set('quality', '720p30');
    await set('recordingTarget', 'folder');
    await wait(`return app.capture.options.recordingTarget === 'folder';`);
    await run(`app.capture.options.recordingSegment = 0.05; return true;`);
    await click(source('camera'));
    await wait(`return app.capture.media.cameraTrack?.readyState === 'live';`);
    await click(RECORD);
    await wait(recording);
    const id = await run(currentId);
    await wait(elapsed(6500));
    await click(RECORD);
    await wait(`return app.capture.isActive === false;`);
    const meta = await run(storedMeta(id));
    assert.equal(meta.state, 'done');
    assert.equal(meta.folder, 'solo-folder');
    assert.ok(meta.segments.length >= 2);
    const files = await run(`
      const segments = ${JSON.stringify(meta.segments)};
      return Promise.all(segments.map(async ({ name }) => {
        const handle = await captureFolder.getFileHandle(name);
        const file = await handle.getFile();
        const video = document.createElement('video');
        const url = URL.createObjectURL(file);
        try {
          const loaded = new Promise((resolve, reject) => {
            video.onloadedmetadata = resolve;
            video.onerror = () => reject(new Error('Could not play ' + name));
          });
          video.src = url;
          await loaded;
          return { size: file.size, playable: video.duration > 0 };
        } finally {
          video.removeAttribute('src');
          URL.revokeObjectURL(url);
        }
      }));
    `);
    const expected = meta.segments.map(({ size }) => ({
      size,
      playable: true,
    }));
    assert.deepEqual(files, expected);
    await click('#panel-close-btn');
  });

  await t.test('capture is unavailable while in a call', async () => {
    await click('#call-btn');
    await wait(`return app.callStage.mode === 'prejoin';`);
    await click('#prejoin [data-action=join]');
    await wait(`return app.callStage.mode === 'call';`);
    assert.deepEqual(
      await run(`
      return [app.directCaptureBtn].map(({ disabled, title }) =>
        [disabled, title]);
    `),
      [[true, 'Use the record control in your call']],
    );
    await run(`app.openCapture(''); return true;`);
    assert.equal(await run(closed), true);
    await run(`await app.closeCall(); return true;`);
    await wait(`return !app.directCaptureBtn.disabled;`);
  });

  await t.test('closing releases a pending microphone', async () => {
    await run(`
      const devices = navigator.mediaDevices;
      const capture = devices.getUserMedia.bind(devices);
      window.releaseMic = Promise.withResolvers();
      devices.getUserMedia = async (options) => {
        const stream = await capture(options);
        window.pendingTrack = stream.getAudioTracks()[0];
        await releaseMic.promise;
        return stream;
      };
      window.restoreMic = () => { delete devices.getUserMedia; };
    `);
    await run(`app.openCapture(''); return true;`);
    await click(source('mic'));
    await wait(`return window.pendingTrack?.readyState === 'live';`);
    await click('#panel-close-btn');
    await wait(closed);
    await run(`releaseMic.resolve(); restoreMic();`);
    await wait(`return pendingTrack.readyState === 'ended';`);
  });
});
