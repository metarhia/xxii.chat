'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const harness = require('./harness.js');

const { ORIGIN, MEDIA_FLAGS, launch, startCallServer } = harness;

const READY = `return app.connected && navigator.serviceWorker.controller &&
  app.mesh.peers.has(app.peerId);`;
const ROW = '.recordings-list .recording-item';

const library = (ids) => `
  const root = await navigator.storage.getDirectory();
  const recordings = await root.getDirectoryHandle('recordings', {
    create: true,
  });
  const write = async (dir, name, contents) => {
    const handle = await dir.getFileHandle(name, { create: true });
    const writable = await handle.createWritable();
    await writable.write(contents);
    await writable.close();
  };
  let day = 1;
  for (const id of ${JSON.stringify(ids)}) {
    const dir = await recordings.getDirectoryHandle(id, { create: true });
    const meta = {
      state: 'done', title: 'Recording ' + id, chatName: '!general',
      started: Date.now() - 86400000 * day++, duration: 60000, size: 3,
      extension: 'webm',
    };
    await write(dir, 'meta.json', JSON.stringify(meta));
    await write(dir, 'program.webm', Uint8Array.of(1, 2, 3));
  }
  return true;
`;

const records = `
  const { startCall, endCall, startRecording } = await import('/chat.js');
  const now = Date.now();
  const mine = app.peerId;
  const calls = ['one', 'two', 'three'];
  for (const [index, id] of calls.entries()) {
    startCall(app.replica, {
      id: 'call-' + id, chat: 'general', host: mine, nick: 'alex',
      timestamp: now - 600000 + index * 1000,
    });
    endCall(app.replica, 'call-' + id, {
      ended: now - 300000 + index * 1000, peak: 2, names: 'alex, sam',
    });
  }
  const recorded = [
    ['solo', 'call-one', mine, 'alex'],
    ['pair-a', 'call-two', mine, 'alex'],
    ['pair-b', 'call-two', mine, 'alex'],
    ['stranger', 'call-three', 'other-peer', 'sam'],
    ['deleted', 'call-three', mine, 'alex'],
  ];
  for (const [index, [id, call, author, nick]] of recorded.entries()) {
    startRecording(app.replica, {
      id, chat: 'general', call, author, nick,
      timestamp: now - 590000 + index * 1000,
      stopped: now - 400000 + index * 1000,
    });
  }
  return true;
`;

const links = `
  const read = (element) => Array.from(
    element.querySelectorAll('[data-action="watch-recording"]'),
    (button) => button.textContent);
  const texts = {};
  for (const card of app.messageList.querySelectorAll('.call-card')) {
    texts[card.dataset.id] = read(card);
  }
  return texts;
`;

test('recordings from the chat', { timeout: 240000 }, async (t) => {
  await startCallServer(t);
  const browser = await launch(t, MEDIA_FLAGS);
  const created = await browser.request('Target.createTarget', {
    url: 'about:blank',
  });
  const attach = { targetId: created.targetId, flatten: true };
  const { sessionId: session } = await browser.request(
    'Target.attachToTarget',
    attach,
  );
  await browser.request('Page.bringToFront', {}, session);
  const size = {
    width: 1280,
    height: 800,
    deviceScaleFactor: 1,
    mobile: false,
  };
  await browser.request('Emulation.setDeviceMetricsOverride', size, session);
  const init = { source: 'localStorage.setItem("xxii:nick", "alex");' };
  await browser.request('Page.addScriptToEvaluateOnNewDocument', init, session);
  await browser.request('Page.navigate', { url: `${ORIGIN}/` }, session);
  await harness.wait(browser, session, READY, 30000);

  const run = (body) => harness.run(browser, session, body);
  const wait = (body, ms) => harness.wait(browser, session, body, ms);
  const closeLibrary = async () => {
    await run(`app.closeRecordings(); return true;`);
    await wait(`return !app.recordingsView.isOpen && app.pops === 0;`);
  };

  await run(`app.selectChat('general'); return true;`);
  await run(records);
  await wait(`return app.messageList.querySelectorAll('.call-card').length
    >= 8;`);

  await t.test('no links while the library is empty', async () => {
    assert.deepEqual(await run(links), {
      'call-one': [],
      'call-two': [],
      'call-three': [],
      solo: [],
      'pair-a': [],
      'pair-b': [],
      stranger: [],
      deleted: [],
    });
  });

  await run(library(['solo', 'pair-a', 'pair-b']));
  await run(`app.refreshRecordings(); return true;`);

  await t.test('notices and pills link to local recordings only', async () => {
    await wait(`return app.messageList.querySelectorAll(
      '[data-action="watch-recording"]').length === 5;`);
    assert.deepEqual(await run(links), {
      'call-one': ['▶ 1 recording'],
      'call-two': ['▶ 2 recordings'],
      'call-three': [],
      solo: ['▶ watch'],
      'pair-a': ['▶ watch'],
      'pair-b': ['▶ watch'],
      stranger: [],
      deleted: [],
    });
  });

  await t.test('the library is read once per render', async () => {
    const reads = await run(`
      const before = app.localRecordings;
      let count = 0;
      const original = app.localRecordings.has.bind(before);
      before.has = (id) => {
        count++;
        return original(id);
      };
      app.render();
      const after = app.messageList.querySelectorAll(
        '[data-action="watch-recording"]').length;
      return { count, after };
    `);
    assert.equal(reads.after, 5);
    assert.ok(reads.count <= 16, String(reads.count));
  });

  await t.test('a single link opens the screen and plays', async () => {
    await run(`document.querySelector(
      '.call-card[data-id="solo"] [data-action="watch-recording"]').click();
      return true;`);
    await wait(`return app.recordingsView.isOpen &&
      app.recordings.selected === 'solo';`);
    const state = await run(`
      const player = document.querySelector('#recordings-view video');
      return {
        shown: !player.classList.contains('hidden'),
        src: player.getAttribute('src'),
        linked: Array.from(document.querySelectorAll(
          '${ROW}.linked'), (row) => row.dataset.id),
      };
    `);
    assert.equal(state.shown, true);
    assert.equal(state.src, '/recordings/solo/program.webm');
    assert.deepEqual(state.linked, ['solo']);
    await closeLibrary();
  });

  await t.test('a call with several recordings highlights them', async () => {
    await run(`document.querySelector(
      '.call-card[data-id="call-two"] [data-action="watch-recording"]')
      .click();
      return true;`);
    await wait(`return app.recordingsView.isOpen &&
      document.querySelectorAll('${ROW}').length === 3;`);
    const state = await run(`
      return {
        selected: app.recordings.selected,
        linked: Array.from(document.querySelectorAll('${ROW}.linked'),
          (row) => row.dataset.id).sort(),
        bar: getComputedStyle(document.querySelector('${ROW}.linked'))
          .boxShadow !== 'none',
      };
    `);
    assert.deepEqual(state, {
      selected: '',
      linked: ['pair-a', 'pair-b'],
      bar: true,
    });
    await closeLibrary();
    const left = await run(`return document.querySelectorAll(
      '${ROW}.linked').length;`);
    assert.equal(left, 0);
  });

  await t.test(
    'opening the library from the button marks nothing',
    async () => {
      await run(`document.getElementById('recordings-btn').click();
      return true;`);
      await wait(`return app.recordingsView.isOpen &&
      document.querySelectorAll('${ROW}').length === 3;`);
      const count = await run(`return document.querySelectorAll(
      '${ROW}.linked').length;`);
      assert.equal(count, 0);
      await closeLibrary();
    },
  );

  await t.test('deleting a recording removes its link', async () => {
    await run(`
      const root = await navigator.storage.getDirectory();
      const recordings = await root.getDirectoryHandle('recordings');
      await recordings.removeEntry('pair-b', { recursive: true });
      app.refreshRecordings();
      return true;
    `);
    await wait(`return app.messageList.querySelectorAll(
      '[data-action="watch-recording"]').length === 4;`);
    const texts = await run(links);
    assert.deepEqual(texts['call-two'], ['▶ 1 recording']);
    assert.deepEqual(texts['pair-b'], []);
    assert.deepEqual(texts['pair-a'], ['▶ watch']);
  });
});
