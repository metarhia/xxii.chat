'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');

const harness = require('./harness.js');

const { ORIGIN, MEDIA_FLAGS, launch, startCallServer, script } = harness;
const READY = `return document.readyState === 'complete' &&
  navigator.serviceWorker.controller && app.recordings && app.connected;`;
const ROW = '.recording-item[data-id=folder-complete]';
const HAS_PARTS = `
  const row = document.querySelector('${ROW}');
  const { entry } = app.recordings.cards.get(row);
  return entry.segments.length >= 2 && !row.querySelector('.recording-play')
    .disabled;
`;
const SELECTED_PART = `
  const row = document.querySelector('${ROW}');
  return app.recordings.partOf(app.recordings.cards.get(row).entry).name;
`;

const fixture = (id, occupy) => `
  const { Recorder, RecordingWriter, FORMATS } = await import('/recorder.js');
  const { QUALITIES } = await import('/layout.js');
  const { segmentNameOf } = await import('/recording-export.js');
  const root = await navigator.storage.getDirectory();
  const folder = await root.getDirectoryHandle('picked', { create: true });
  const canvas = document.createElement('canvas');
  canvas.width = 320;
  canvas.height = 180;
  const context = canvas.getContext('2d');
  const tracks = canvas.captureStream(30).getVideoTracks();
  const audio = new AudioContext();
  const oscillator = audio.createOscillator();
  const destination = audio.createMediaStreamDestination();
  oscillator.connect(destination);
  oscillator.start();
  await audio.resume();
  let frame = 0;
  const paint = () => {
    context.fillStyle = 'hsl(' + (frame++ * 7 % 360) + ' 80% 50%)';
    context.fillRect(0, 0, canvas.width, canvas.height);
  };
  paint();
  const timer = setInterval(paint, 33);
  const writer = new RecordingWriter();
  const formats = FORMATS.filter(({ extension }) => extension === 'webm');
  const recorder = new Recorder({
    compositor: { canvas, track: tracks[0] },
    mixer: { track: destination.stream.getAudioTracks()[0] },
    writer, quality: QUALITIES['720p30'], formats, folder, segmentMs: 3000,
  });
  const started = Date.now();
  const info = {
    id: '${id}', title: 'Folder recording', chat: 'general',
    chatName: '!${id}', call: '', started, options: {}, people: [],
  };
  const name = segmentNameOf({ ...info, extension: 'webm' }, 1);
  if (${occupy}) {
    const handle = await folder.getFileHandle(name, { create: true });
    const output = await handle.createWritable();
    await output.write('existing');
    await output.close();
  }
  window.folderFixture = {
    recorder, writer, name, folder,
    release() {
      clearInterval(timer);
      oscillator.stop();
      audio.close();
      tracks[0].stop();
    },
  };
  return recorder.start(info);
`;

const storageOf = (id) => `
  const root = await navigator.storage.getDirectory();
  const recordings = await root.getDirectoryHandle('recordings');
  const directory = await recordings.getDirectoryHandle('${id}');
  const handle = await directory.getFileHandle('meta.json');
  const meta = JSON.parse(await (await handle.getFile()).text());
`;

const inspectParts = `
  ${storageOf('folder-complete')}
  const { durationSlotOf } = await import('/recording-webm.js');
  const folder = window.folderFixture.folder;
  const parts = await Promise.all(meta.segments.map(async ({ name }) => {
    const file = await (await folder.getFileHandle(name)).getFile();
    const raw = await file.slice(0, 4096).arrayBuffer();
    const header = new Uint8Array(raw);
    const slot = durationSlotOf(header);
    const ticks = new DataView(raw).getFloat64(slot.offset);
    const video = document.createElement('video');
    const url = URL.createObjectURL(file);
    try {
      const loaded = new Promise((resolve, reject) => {
        video.onloadedmetadata = resolve;
        video.onerror = () => reject(new Error('Could not play ' + name));
      });
      video.src = url;
      await loaded;
      return {
        duration: video.duration, width: video.videoWidth,
        headerDuration: slot.bytes === header ? ticks * slot.scale / 1e6 : 0,
        size: file.size,
      };
    } finally {
      video.removeAttribute('src');
      video.load();
      URL.revokeObjectURL(url);
    }
  }));
  const original = await folder.getFileHandle(window.folderFixture.name);
  const items = [];
  for await (const item of directory.keys()) items.push(item);
  return {
    meta, parts, items: items.sort(), name: window.folderFixture.name,
    original: await (await original.getFile()).text(),
  };
`;

const LIBRARY_FIXTURE = `
  const root = await navigator.storage.getDirectory();
  const other = await root.getDirectoryHandle('new default', { create: true });
  const { folderHandle } = await import('/recording-folder.js');
  await folderHandle(other);
  const target = await root.getFileHandle('save-as.webm', { create: true });
  window.folderTest = { permissions: [], picks: [] };
  window.showSaveFilePicker = async ({ suggestedName }) => {
    folderTest.picks.push(suggestedName);
    return target;
  };
  FileSystemDirectoryHandle.prototype.queryPermission = async ({ mode }) => {
    folderTest.permissions.push({ query: mode });
    return 'prompt';
  };
  FileSystemDirectoryHandle.prototype.requestPermission = async ({ mode }) => {
    const active = navigator.userActivation.isActive;
    folderTest.permissions.push({ request: mode, active });
    return 'granted';
  };
`;

test(
  'scenario 19: record straight to a folder',
  { timeout: 120000 },
  async (t) => {
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
    const wait = (body) => harness.wait(browser, sessionId, body);
    const activated = async (body) => {
      const params = {
        expression: script(body),
        userGesture: true,
        returnByValue: true,
        awaitPromise: true,
      };
      const result = await browser.request(
        'Runtime.evaluate',
        params,
        sessionId,
      );
      assert.equal(result.exceptionDetails, undefined);
    };
    const click = (selector) =>
      activated(`
    document.querySelector(${JSON.stringify(selector)}).click();
  `);
    const choose = async (row, action, index = 0) => {
      await click(`${row} .recording-more`);
      await wait(`return !!document.querySelector(
        '.recording-menu [data-action=${action}]');`);
      await activated(`document.querySelectorAll(
        '.recording-menu [data-action=${action}]')[${index}].click();`);
    };
    await wait(READY);

    await t.test(
      'writes playable WebM parts and preserves duplicate names',
      async () => {
        const started = await run(fixture('folder-complete', true));
        assert.equal(started.folder, 'picked');
        await wait('return folderFixture.recorder.activeMs >= 6900;');
        await run(`
      await folderFixture.recorder.stop();
      folderFixture.writer.stop();
      folderFixture.release();
    `);
        const result = await run(inspectParts);
        const { meta, parts } = result;
        assert.equal(meta.state, 'done');
        assert.equal(result.original, 'existing');
        assert.equal(
          meta.segments[0].name,
          result.name.replace('.webm', ' (2).webm'),
        );
        assert.deepEqual(result.items, ['meta.json', 'poster.jpg']);
        assert.ok(parts.length >= 2);
        assert.equal(
          meta.size,
          parts.reduce((sum, part) => sum + part.size, 0),
        );
        assert.ok(meta.duration >= 6900 && meta.duration < 8500);
        for (let index = 0; index < parts.length; index++) {
          const part = parts[index];
          assert.ok(part.duration > 0 && Number.isFinite(part.duration));
          assert.ok(part.headerDuration > 0);
          const difference =
            part.headerDuration - meta.segments[index].duration;
          assert.ok(Math.abs(difference) < 1e-6);
          assert.equal(part.size, meta.segments[index].size);
          assert.equal(part.width, 320);
        }
      },
    );

    await t.test(
      'library reads the selected part and leaves folder files on delete',
      async () => {
        await run(LIBRARY_FIXTURE);
        await click('#recordings-btn');
        await wait(HAS_PARTS);
        await click(`${ROW} .recording-more`);
        const controls = await run(`
      const menu = document.querySelector('.recording-menu');
      const radios = menu.querySelectorAll('[role=menuitemradio]');
      const labels = Array.from(menu.querySelectorAll('.menu-label'),
        (label) => label.textContent);
      return {
        texts: Array.from(radios).slice(0, 2).map((part) => part.textContent),
        checked: Array.from(radios, (part) =>
          part.getAttribute('aria-checked')).slice(0, 2),
        hasFolder: labels.some((label) => label.startsWith('Save to')),
      };
    `);
        assert.deepEqual(controls, {
          texts: ['Part 1', 'Part 2'],
          checked: ['true', 'false'],
          hasFolder: false,
        });
        await run(`document.querySelector('.recording-menu').dispatchEvent(
          new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));`);
        await click(`${ROW} .recording-play`);
        const ready = `
      const video = document.querySelector('.recordings-player');
      return video.src.startsWith('blob:') &&
        Number.isFinite(video.duration) && video.duration > 0;
    `;
        await wait(ready);
        const url = await run('return app.recordings.player.src;');
        await choose(ROW, 'part', 1);
        await wait(ready);
        assert.match(await run(SELECTED_PART), / part 02\.webm$/);
        assert.notEqual(await run('return app.recordings.player.src;'), url);
        const canFetch = (link) =>
          run(`
      return fetch(${JSON.stringify(link)}).then(() => true, () => false);
    `);
        assert.equal(await canFetch(url), false);

        await choose(ROW, 'save-as');
        await wait(
          `return document.querySelector('${ROW} progress').value === 100;`,
        );
        const selected = await run(`
      const row = document.querySelector('${ROW}');
      const entry = app.recordings.cards.get(row).entry;
      const name = app.recordings.partOf(entry).name;
      const original = await folderFixture.folder.getFileHandle(name);
      const root = await navigator.storage.getDirectory();
      const saved = await root.getFileHandle('save-as.webm');
      const size = (await (await original.getFile()).arrayBuffer()).byteLength;
      const copy = (await (await saved.getFile()).arrayBuffer()).byteLength;
      return { name, size, copy, permissions: folderTest.permissions,
        picks: folderTest.picks };
    `);
        assert.equal(selected.copy, selected.size);
        assert.deepEqual(selected.picks, [selected.name]);
        const permission = { request: 'read', active: true };
        assert.deepEqual(
          selected.permissions.filter((entry) => entry.request),
          Array(3).fill(permission),
        );

        const directory = await fs.mkdtemp(
          path.join(os.tmpdir(), 'xxii-part-'),
        );
        t.after(() => fs.rm(directory, { force: true, recursive: true }));
        const downloaded = Promise.withResolvers();
        const named = Promise.withResolvers();
        browser.on('Browser.downloadWillBegin', named.resolve);
        browser.on('Browser.downloadProgress', (event) => {
          if (event.state !== 'inProgress') downloaded.resolve(event);
        });
        await browser.request('Browser.setDownloadBehavior', {
          behavior: 'allowAndName',
          downloadPath: directory,
          eventsEnabled: true,
        });
        await click(`${ROW} .recording-download`);
        const { suggestedFilename } = await named.promise;
        const { guid, state } = await downloaded.promise;
        assert.equal(suggestedFilename, selected.name);
        assert.equal(state, 'completed');
        assert.equal(
          (await fs.stat(path.join(directory, guid))).size,
          selected.size,
        );

        const playing = await run('return app.recordings.player.src;');
        await click('#recordings-close');
        assert.equal(await canFetch(playing), false);
        assert.ok(await run(`return !document.querySelector('${ROW}');`));
        await click('#recordings-btn');
        await wait(HAS_PARTS);
        await run(`
      const row = document.querySelector('${ROW}');
      const entry = app.recordings.cards.get(row).entry;
      await folderFixture.folder.removeEntry(app.recordings.partOf(entry).name);
    `);
        await click(`${ROW} .recording-play`);
        await wait(`
      return app.recordings.status.textContent === 'Part not found in picked.';
    `);
        await run(`
      window.confirm = (message) => {
        window.deleteMessage = message;
        return true;
      };
    `);
        await click(`${ROW} .recording-delete`);
        await wait(`return !document.querySelector('${ROW}');`);
        assert.match(
          await run('return deleteMessage;'),
          /Files stay in picked/,
        );
        assert.equal(
          await run(`
      const handle = await folderFixture.folder.getFileHandle(
        ${JSON.stringify(selected.name)},
      );
      return (await handle.getFile()).size;
    `),
          selected.size,
        );
      },
    );

    await t.test('startup repair keeps only closed parts', async () => {
      const id = 'folder-interrupted';
      await run(fixture(id, false));
      await wait(`
      const { recorder } = folderFixture;
      return recorder.meta.segments.length === 1 &&
        recorder.size > recorder.meta.size;
    `);
      await run('folderFixture.writer.stop();');
      const lock = `xxii-recording-${id}`;
      await wait(`
      const { held } = await navigator.locks.query();
      return !held.some(({ name }) => name === '${lock}');
    `);
      const stored = `${storageOf(id)} return meta;`;
      const before = await run(stored);
      assert.equal(before.state, 'recording');
      assert.equal(before.segments.length, 1);
      await browser.request('Page.reload', {}, sessionId);
      await wait(READY);
      await wait(`${storageOf(id)} return meta.state === 'interrupted';`);
      const after = await run(stored);
      assert.deepEqual(after, { ...before, state: 'interrupted' });
      await click('#recordings-btn');
      await wait(`
      const row = document.querySelector('[data-id="${id}"]');
      return row?.querySelector('.recording-state').title
        .includes('The last part was lost.');
    `);
      await click('#recordings-close');
    });

    await t.test(
      'target selection and recording permission use the active gesture',
      async () => {
        await run(`
      const { folderHandle } = await import('/recording-folder.js');
      await folderHandle(null);
      const root = await navigator.storage.getDirectory();
      const folder = await root.getDirectoryHandle('picked');
      window.folderSettings = {
        picks: [], permissions: [], cancel: true, grant: false, quota: 0,
      };
      window.showDirectoryPicker = async (options) => {
        const active = navigator.userActivation.isActive;
        folderSettings.picks.push({ options, active });
        if (folderSettings.cancel) throw new DOMException('', 'AbortError');
        return folder;
      };
      const prototype = FileSystemDirectoryHandle.prototype;
      prototype.queryPermission = async ({ mode }) => {
        folderSettings.permissions.push({ query: mode });
        return 'prompt';
      };
      prototype.requestPermission = async ({ mode }) => {
        const active = navigator.userActivation.isActive;
        folderSettings.permissions.push({ request: mode, active });
        return folderSettings.grant ? 'granted' : 'denied';
      };
      app.selectChat('general');
      await app.startCall('general');
    `);
        await click('#prejoin [data-action=join]');
        await wait(`return app.callStage?.mode === 'call';`);
        await run(`app.openSettings('recordings'); return true;`);
        const choose = `
      const select = document.querySelector('[data-setting=recordingTarget]');
      select.value = 'folder';
      select.dispatchEvent(new Event('change', { bubbles: true }));
    `;
        await activated(choose);
        await wait(`
      const select = document.querySelector('[data-setting=recordingTarget]');
      return !select.disabled && select.value === 'browser' &&
        folderSettings.picks.length === 1;
    `);
        await run('folderSettings.cancel = false;');
        await activated(choose);
        await wait(`
      const segment = document.querySelector('[data-setting=recordingSegment]');
      return app.preferences.settings.recordingTarget === 'folder' &&
        segment.value === '10';
    `);
        await run('app.closeSettings(); return true;');
        await wait(`return !app.settings.isOpen &&
          app.callStage.mode === 'mini' &&
          document.querySelector('#mini-call')?.checkVisibility() === true;`);
        await click('#mini-call');
        await wait(`return app.callStage.mode === 'call';`);
        await click('.call-controls [data-action=more]');
        await click('.call-bar-menu [data-action=record-panel]');
        const panel = await run(`
      const target = document.querySelector('[data-record=recordingTarget]');
      const segment = document.querySelector('[data-record=recordingSegment]');
      return {
        target: target.value,
        minutes: Array.from(segment.options, (option) => +option.value),
      };
    `);
        assert.deepEqual(panel, { target: 'folder', minutes: [5, 10, 15, 30] });
        await click('.call-record [data-action=record]');
        await wait(`
      const notice = document.querySelector('.record-note');
      return notice.textContent.includes('switch to browser storage');
    `);
        const outcome = await run(`
      const { picks, permissions } = folderSettings;
      const recording = app.callStage.recording.isActive;
      return { picks, permissions, recording };
    `);
        assert.deepEqual(outcome, {
          picks: Array(2).fill({
            options: {
              mode: 'readwrite',
              id: 'xxii-recordings',
              startIn: 'videos',
            },
            active: true,
          }),
          permissions: [
            { query: 'readwrite' },
            { request: 'readwrite', active: true },
          ],
          recording: false,
        });

        await run(`
      folderSettings.grant = true;
      navigator.storage.estimate = async () => {
        folderSettings.quota++;
        return { quota: 1, usage: 1 };
      };
    `);
        await click('.call-record [data-action=record]');
        await wait(`
      const recorder = app.callStage.recording.recorder;
      return recorder?.state === 'recording' && recorder.activeMs >= 1200;
    `);
        const id = await run('return app.callStage.recording.recorder.id;');
        await run('window.confirm = () => true;');
        await click('.call-record [data-action=record]');
        await wait(`${storageOf(id)} return meta.state === 'done';`);
        const direct = await run(`
      ${storageOf(id)}
      return { folder: meta.folder, parts: meta.segments.length,
        quota: folderSettings.quota, size: meta.size };
    `);
        assert.deepEqual(direct, {
          folder: 'picked',
          parts: 1,
          quota: 0,
          size: direct.size,
        });
        assert.ok(direct.size > 0);
      },
    );
    assert.deepEqual(browser.errors, []);
  },
);
