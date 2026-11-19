'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');

const harness = require('./harness.js');

const { ORIGIN, launch, startCallServer } = harness;
const SELECTOR = '.recording-item[data-id=fixture]';
const SECOND = '.recording-item[data-id=second]';
const NAME = 'xxii !Київ _ R&D 2026-11-19 14-05.webm';
const BYTES = [3, 17, 255, 13, 0, 34];
const OTHER = [93, 11, 8];
const OCCUPIED = [81, 82, 83];

const realClick = async (browser, session, selector) => {
  const point = await harness.run(
    browser,
    session,
    `
    const control = document.querySelector(${JSON.stringify(selector)});
    control.scrollIntoView({ block: 'center' });
    const box = control.getBoundingClientRect();
    return { x: box.x + box.width / 2, y: box.y + box.height / 2 };`,
  );
  for (const type of ['mousePressed', 'mouseReleased']) {
    const params = { ...point, type, button: 'left', clickCount: 1 };
    await browser.request('Input.dispatchMouseEvent', params, session);
  }
};

const checkDownload = async (t, browser, click) => {
  const downloadPath = await fs.mkdtemp(path.join(os.tmpdir(), 'xxii-export-'));
  t.after(() => fs.rm(downloadPath, { force: true, recursive: true }));
  const done = Promise.withResolvers();
  let name = '';
  browser.on('Browser.downloadWillBegin', ({ suggestedFilename }) => {
    name = suggestedFilename;
  });
  browser.on('Browser.downloadProgress', (event) => {
    if (event.state !== 'inProgress') done.resolve(event);
  });
  await browser.request('Browser.setDownloadBehavior', {
    behavior: 'allowAndName',
    downloadPath,
    eventsEnabled: true,
  });
  await click();
  const { state, guid } = await done.promise;
  assert.equal(state, 'completed');
  assert.equal(name, NAME);
  const bytes = await fs.readFile(path.join(downloadPath, guid));
  assert.deepEqual(Array.from(bytes), BYTES);
};

const fixture = `
  const root = await navigator.storage.getDirectory();
  const recordings = await root.getDirectoryHandle('recordings', {
    create: true,
  });
  const folder = await root.getDirectoryHandle('exported', { create: true });
  const write = async (dir, name, contents) => {
    const handle = await dir.getFileHandle(name, { create: true });
    const writable = await handle.createWritable();
    await writable.write(contents);
    await writable.close();
    return handle;
  };
  const exportFile = await write(root, 'picked.webm', Uint8Array.of(91));
  const existing = Uint8Array.from(${JSON.stringify(OCCUPIED)});
  await write(folder, ${JSON.stringify(NAME)}, existing);
  const variants = [
    ['fixture', 'done', ${JSON.stringify(BYTES)}],
    ['second', 'interrupted', ${JSON.stringify(OTHER)}],
    ['paused', 'paused', []],
  ];
  for (const [id, state, bytes] of variants) {
    const dir = await recordings.getDirectoryHandle(id, { create: true });
    const started = new Date(2026, 10, 19, 14, 5).getTime();
    const meta = { chatName: '!Київ / R&D', state, started, extension: 'webm' };
    await write(dir, 'meta.json', JSON.stringify(meta));
    await write(dir, 'program.webm', Uint8Array.from(bytes));
  }
  window.exportTest = { exportFile, picks: [], permissions: [] };
  window.showSaveFilePicker = async (options) => {
    const active = navigator.userActivation.isActive;
    exportTest.picks.push({ options, active });
    return exportFile;
  };
  window.showDirectoryPicker = async (options) => {
    const active = navigator.userActivation.isActive;
    exportTest.folderPicker = { options, active };
    return folder;
  };
  FileSystemDirectoryHandle.prototype.queryPermission = async (options) => {
    exportTest.permissions.push({ query: options.mode });
    return 'prompt';
  };
  FileSystemDirectoryHandle.prototype.requestPermission = async (options) => {
    exportTest.permissions.push({
      request: options.mode, active: navigator.userActivation.isActive,
    });
    return 'granted';
  };
`;

test('scenario 18: export recordings through the library', async (t) => {
  await startCallServer(t);
  const browser = await launch(t);
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
  const click = (selector) =>
    run(`document.querySelector('${selector}').click();`);
  const activate = (selector) => realClick(browser, sessionId, selector);
  await wait(`return document.readyState === 'complete' &&
    app.recordings && navigator.serviceWorker.controller;`);
  await run(fixture);
  await click('#recordings-btn');
  await wait(`
    return document.querySelectorAll('.recording-item').length === 3;
  `);

  await t.test('download link works', { timeout: 10000 }, async (t) => {
    const behavior = await run(`
      const row = document.querySelector('${SELECTOR}');
      const link = row.querySelector('.recording-download');
      const url = new URL(link.href);
      const paused = document.querySelector('[data-id=paused]');
      const pausedActions = paused.querySelectorAll(
        '.recording-download, .recording-save-as, .recording-save-folder',
      );
      return {
        path: url.pathname,
        name: url.searchParams.get('name'),
        download: url.searchParams.get('download'),
        hasFolder: !row.querySelector('.recording-save-folder').hidden,
        pausedCanExport: [...pausedActions].some((action) => !action.hidden),
      };`);
    assert.equal(behavior.path, '/recordings/fixture/program.webm');
    assert.equal(behavior.name, NAME);
    assert.equal(behavior.download, '1');
    assert.equal(behavior.hasFolder, false);
    assert.equal(behavior.pausedCanExport, false);
    await checkDownload(t, browser, () =>
      activate(`${SELECTOR} .recording-download`),
    );
  });

  await t.test('Save as writes exact bytes and completes', async () => {
    await activate(`${SELECTOR} .recording-save-as`);
    await wait(`
      const bar = document.querySelector('${SELECTOR} progress');
      return !bar.hidden && bar.value === bar.max && bar.max === 100;
    `);
    const result = await run(`
      const file = await exportTest.exportFile.getFile();
      return {
        picks: exportTest.picks,
        bytes: Array.from(new Uint8Array(await file.arrayBuffer())),
      };
    `);
    assert.deepEqual(result.picks, [
      {
        options: {
          suggestedName: NAME,
          types: [{ accept: { 'video/webm': ['.webm'] } }],
        },
        active: true,
      },
    ]);
    assert.deepEqual(result.bytes, BYTES);
  });

  await t.test('folder saves preserve and disambiguate filenames', async () => {
    await click('#panel-close-btn');
    await click('#calls-btn');
    await activate('.record-folder');
    await wait(`return document.querySelector('.record-folder').textContent
      === 'folder: exported';`);
    assert.deepEqual(await run('return exportTest.folderPicker;'), {
      options: { mode: 'readwrite', id: 'xxii-recordings', startIn: 'videos' },
      active: true,
    });
    await click('#panel-close-btn');
    await click('#recordings-btn');
    await wait(`return !document.querySelector(
      '${SELECTOR} .recording-save-folder',
    ).hidden;`);
    await activate(`${SELECTOR} .recording-save-folder`);
    await click(`${SECOND} .recording-save-folder`);
    await wait(`
      const bars = document.querySelectorAll(
        '${SELECTOR} progress, ${SECOND} progress',
      );
      return [...bars].every((bar) => !bar.hidden && bar.value === 100);
    `);
    const result = await run(`
      const root = await navigator.storage.getDirectory();
      const folder = await root.getDirectoryHandle('exported');
      const files = {};
      for await (const [name, handle] of folder.entries()) {
        const file = await handle.getFile();
        files[name] = Array.from(new Uint8Array(await file.arrayBuffer()));
      }
      return { files, permissions: exportTest.permissions };
    `);
    const secondName = NAME.replace('.webm', ' (2).webm');
    const thirdName = NAME.replace('.webm', ' (3).webm');
    assert.deepEqual(Object.keys(result.files).sort(), [
      secondName,
      thirdName,
      NAME,
    ]);
    assert.deepEqual(result.files[NAME], OCCUPIED);
    const exports = [result.files[secondName], result.files[thirdName]];
    assert.deepEqual(exports.sort(), [BYTES, OTHER].sort());
    const queries = result.permissions.filter(({ query }) => query);
    const grants = result.permissions.filter(({ request }) => request);
    assert.deepEqual(queries, Array(2).fill({ query: 'readwrite' }));
    const expectedGrant = { request: 'readwrite', active: true };
    assert.deepEqual(grants, Array(2).fill(expectedGrant));
  });

  await t.test('failed writes leave the name free for retry', async () => {
    const nextName = NAME.replace('.webm', ' (4).webm');
    await run(`
      const prototype = FileSystemFileHandle.prototype;
      const createWritable = prototype.createWritable;
      prototype.createWritable = async function () {
        prototype.createWritable = createWritable;
        throw new DOMException('Write failed', 'QuotaExceededError');
      };
    `);
    await activate(`${SELECTOR} .recording-save-folder`);
    await wait(`return document.querySelector('.recordings-status').textContent
      === 'Could not save this recording.';`);
    const readRetry = () =>
      run(`
        const root = await navigator.storage.getDirectory();
        const folder = await root.getDirectoryHandle('exported');
        const name = ${JSON.stringify(nextName)};
        try {
          const handle = await folder.getFileHandle(name);
          const file = await handle.getFile();
          return Array.from(new Uint8Array(await file.arrayBuffer()));
        } catch (error) {
          if (error.name === 'NotFoundError') return null;
          throw error;
        }
      `);
    assert.equal(await readRetry(), null);
    await activate(`${SELECTOR} .recording-save-folder`);
    await wait(`
      const bar = document.querySelector('${SELECTOR} progress');
      return !bar.hidden && bar.value === 100;
    `);
    assert.deepEqual(await readRetry(), BYTES);
  });

  assert.deepEqual(browser.errors, []);
});
