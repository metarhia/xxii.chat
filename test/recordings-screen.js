'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const harness = require('./harness.js');

const { ORIGIN, MEDIA_FLAGS, launch, startCallServer } = harness;

const READY = `return app.connected && navigator.serviceWorker.controller &&
  app.mesh.peers.has(app.peerId);`;
const ROW = '.recordings-list .recording-item';
const CONTROL = '.call-controls';
const MENU = '.call-bar-menu';
const PANEL = '[data-panel="capture"].panel-body';

const fixture = `
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
  const canvas = document.createElement('canvas');
  canvas.width = 320;
  canvas.height = 180;
  const context = canvas.getContext('2d');
  context.fillStyle = '#2b6b57';
  context.fillRect(0, 0, 320, 180);
  const poster = await new Promise((resolve) => {
    canvas.toBlob(resolve, 'image/jpeg');
  });
  const variants = [
    ['first', 'done', 'Team sync', '!general', 754000, 48200000],
    ['second', 'done', 'Interview with a long recording title', '@sam',
      3725000, 910000000],
    ['third', 'interrupted', '', '!design', 61000, 3100000],
  ];
  let day = 20;
  for (const [id, state, title, chat, duration, size] of variants) {
    const dir = await recordings.getDirectoryHandle(id, { create: true });
    const started = new Date(2026, 10, day--, 14, 5).getTime();
    const meta = {
      state, title, chatName: chat, started, duration, size,
      extension: 'webm',
    };
    await write(dir, 'meta.json', JSON.stringify(meta));
    await write(dir, 'program.webm', Uint8Array.of(1, 2, 3));
    if (id !== 'third') await write(dir, 'poster.jpg', poster);
  }
  return true;
`;

const visible = (selector) => `
  const element = document.querySelector(${JSON.stringify(selector)});
  return element !== null && element.offsetWidth > 0 &&
    element.offsetHeight > 0;
`;

test('recordings screen', { timeout: 240000 }, async (t) => {
  await startCallServer(t);
  const browser = await launch(t, MEDIA_FLAGS);

  const open = async (phone = false) => {
    const created = await browser.request('Target.createTarget', {
      url: 'about:blank',
    });
    const attach = { targetId: created.targetId, flatten: true };
    const { sessionId } = await browser.request(
      'Target.attachToTarget',
      attach,
    );
    await browser.request('Page.bringToFront', {}, sessionId);
    const size = phone
      ? { width: 390, height: 844, deviceScaleFactor: 1, mobile: true }
      : { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false };
    await browser.request(
      'Emulation.setDeviceMetricsOverride',
      size,
      sessionId,
    );
    const init = { source: 'localStorage.setItem("xxii:nick", "alex");' };
    await browser.request(
      'Page.addScriptToEvaluateOnNewDocument',
      init,
      sessionId,
    );
    await browser.request('Page.navigate', { url: `${ORIGIN}/` }, sessionId);
    await harness.wait(browser, sessionId, READY, 30000);
    return sessionId;
  };

  const run = (session, body) => harness.run(browser, session, body);
  const wait = (session, body, ms) => harness.wait(browser, session, body, ms);
  const click = (session, selector) =>
    run(
      session,
      `document.querySelector(${JSON.stringify(selector)}).click();
      return true;`,
    );
  const press = (session, key, extra = '') =>
    run(
      session,
      `document.dispatchEvent(new KeyboardEvent('keydown',
        { key: ${JSON.stringify(key)}, bubbles: true, ${extra} }));
      return true;`,
    );
  const isClosed = `return !app.recordingsView.isOpen &&
    app.layers.length === 0 && app.pops === 0 &&
    document.getElementById('chat-view').offsetWidth > 0;`;

  const first = await open();
  await run(first, `app.selectChat('general'); return true;`);
  await run(first, fixture);

  await t.test('the profile row button opens the screen', async () => {
    assert.equal(await run(first, visible('#recordings-view')), false);
    await click(first, '#recordings-btn');
    await wait(
      first,
      `return app.recordingsView.isOpen &&
      app.app.dataset.view === 'recordings' &&
      document.querySelectorAll('${ROW}').length >= 3;`,
    );
    assert.equal(await run(first, visible('#recordings-view')), true);
    assert.equal(await run(first, visible('#chat-view')), false);
    const state = await run(
      first,
      `return {
        active: document.getElementById('recordings-btn')
          .classList.contains('active'),
        layers: app.layers.join(),
        title: document.querySelector('#recordings-view h2').textContent,
        columns: getComputedStyle(document.querySelector(
          '.recordings-list')).gridTemplateColumns.split(' ').length,
        border: getComputedStyle(document.querySelector('${ROW}'))
          .borderTopWidth,
        poster: document.querySelector('${ROW} img').naturalWidth > 0,
        boxes: [...document.querySelectorAll('${ROW} .recording-poster')]
          .filter((box) => Math.abs(box.offsetHeight -
            box.offsetWidth * 9 / 16) <= 1).length,
        placeholder: getComputedStyle(document.querySelector(
          '${ROW}[data-id=third] .recording-poster')).backgroundColor,
      };`,
    );
    assert.deepEqual(state, {
      active: true,
      layers: 'recordings',
      title: 'Recordings',
      columns: 3,
      border: '0px',
      poster: true,
      boxes: 3,
      placeholder: 'rgb(15, 20, 24)',
    });
  });

  await t.test('new capture opens the capture panel', async () => {
    assert.equal(await run(first, visible('#recordings-capture')), true);
    await click(first, '#recordings-capture');
    await wait(
      first,
      `return app.panel === 'capture' && app.capture !== null &&
      document.querySelector('.capture-panel').offsetWidth > 0 &&
      document.getElementById('recordings-view').offsetWidth > 0;`,
    );
    await click(first, '#panel-close-btn');
    await wait(first, `return app.panel === '' && app.capture === null;`);
    assert.equal(await run(first, 'return app.recordingsView.isOpen;'), true);
  });

  await t.test('Esc closes a rename form, then the screen', async () => {
    await click(first, `${ROW}[data-id=first] .recording-rename`);
    await wait(
      first,
      `return document.querySelector('${ROW}[data-id=first] form')
      .classList.contains('hidden') === false;`,
    );
    await press(first, 'Escape');
    await wait(
      first,
      `return document.querySelector('${ROW}[data-id=first] form')
      .classList.contains('hidden') && app.recordingsView.isOpen;`,
    );
    await press(first, 'Escape');
    await wait(first, isClosed);
    assert.equal(await run(first, 'return app.chat;'), 'general');
    assert.equal(
      await run(first, `return !!document.querySelector('${ROW}');`),
      false,
    );
  });

  await t.test('Ctrl+K commands open the screen and the capture', async () => {
    const command = async (text) => {
      await press(first, 'k', 'ctrlKey: true');
      await wait(first, 'return app.switcher.isOpen;');
      await run(
        first,
        `const input = document.querySelector('#switcher input');
        input.value = ${JSON.stringify(text)};
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.dispatchEvent(new KeyboardEvent('keydown',
          { key: 'Enter', bubbles: true }));
        return true;`,
      );
    };
    await command('recordings');
    await wait(
      first,
      `return app.recordingsView.isOpen && !app.switcher.isOpen
      && document.querySelectorAll('${ROW}').length >= 3;`,
    );
    await press(first, 'Escape');
    await wait(first, isClosed);
    await command('new capture');
    await wait(
      first,
      `return app.panel === 'capture' && app.capture !== null;`,
    );
    await click(first, '#panel-close-btn');
    await wait(first, `return app.panel === '' && app.capture === null;`);
  });

  await t.test('the settings link opens the screen', async () => {
    await run(first, `app.openSettings('recordings'); return true;`);
    await wait(
      first,
      `return app.settings.isOpen &&
      document.getElementById('open-recordings').offsetWidth > 0;`,
    );
    await click(first, '#open-recordings');
    await wait(
      first,
      `return app.recordingsView.isOpen && !app.settings.isOpen &&
      app.layers.join() === 'recordings' && app.pops === 0 &&
      document.querySelectorAll('${ROW}').length >= 3;`,
    );
    await click(first, '#recordings-close');
    await wait(first, isClosed);
  });

  await t.test('settings replace the screen and back', async () => {
    await click(first, '#recordings-btn');
    await wait(first, 'return app.recordingsView.isOpen;');
    await run(first, `app.openSettings('profile'); return true;`);
    await wait(
      first,
      `return app.settings.isOpen && !app.recordingsView.isOpen &&
      app.layers.join() === 'settings' && app.pops === 0;`,
    );
    await click(first, '#recordings-btn');
    await wait(
      first,
      `return app.recordingsView.isOpen && !app.settings.isOpen &&
      app.layers.join() === 'recordings' && app.pops === 0;`,
    );
    await run(first, `app.selectChat('general'); return true;`);
    await wait(first, isClosed);
  });

  await t.test('a solo capture colors the profile row button', async () => {
    const button = `document.getElementById('recordings-btn')
      .classList.contains('recording')`;
    const color = `return ${button};`;
    assert.equal(await run(first, color), false);
    await run(first, `app.openCapture(''); return true;`);
    await click(first, `${PANEL} [data-source="mic"]`);
    await wait(
      first,
      `return app.capture.media.micTrack?.readyState === 'live';`,
    );
    await click(first, `${PANEL} [data-action="record"]`);
    await wait(first, `return app.capture.recorder?.state === 'recording';`);
    await wait(first, color);
    await click(first, `${PANEL} [data-action="record"]`);
    await wait(first, `return app.capture.isActive === false;`);
    await wait(first, `return !${button};`);
    await click(first, '#panel-close-btn');
    await wait(first, `return app.panel === '' && app.capture === null;`);
  });

  await t.test('in a call the entry collapses the call', async () => {
    await run(first, `await app.startCall('general'); return true;`);
    await click(first, '#prejoin [data-action=join]');
    await wait(
      first,
      `return app.callStage?.mode === 'call' &&
      app.callStage.media.cameraTrack?.readyState === 'live';`,
    );
    await click(first, `${CONTROL} [data-action=more]`);
    await click(first, `${MENU} [data-action=recordings]`);
    await wait(
      first,
      `return app.callStage.mode === 'mini' && app.recordingsView.isOpen &&
      document.querySelectorAll('${ROW}').length >= 3;`,
    );
    const button = await run(
      first,
      `const button = document.getElementById('recordings-capture');
      return [button.disabled, button.title];`,
    );
    assert.deepEqual(button, [true, 'Use the record control in your call']);
    await press(first, 'Escape');
    await wait(first, `return !app.recordingsView.isOpen && app.pops === 0;`);
    await run(first, `await app.closeCall(); return true;`);
    await wait(first, `return app.callStage?.mode !== 'mini';`);
  });

  await t.test('on a phone Back closes the screen', async () => {
    const phone = await open(true);
    await run(phone, fixture);
    await click(phone, '#menu-btn');
    await wait(phone, `return app.layers.includes('sidebar');`);
    await click(phone, '#recordings-btn');
    await wait(
      phone,
      `return app.recordingsView.isOpen && app.pops === 0 &&
      app.layers.join() === 'recordings' &&
      document.querySelectorAll('${ROW}').length >= 3;`,
    );
    const columns = await run(
      phone,
      `return getComputedStyle(document.querySelector('.recordings-list'))
        .gridTemplateColumns.split(' ').length;`,
    );
    assert.equal(columns, 1);
    await click(phone, '#recordings-capture');
    await wait(
      phone,
      `return app.panel === 'capture' &&
      app.layers.join() === 'recordings,panel';`,
    );
    await run(phone, 'history.back(); return true;');
    await wait(
      phone,
      `return app.panel === '' && app.recordingsView.isOpen &&
      app.layers.join() === 'recordings';`,
    );
    await run(phone, 'history.back(); return true;');
    await wait(
      phone,
      `return !app.recordingsView.isOpen &&
      app.layers.length === 0;`,
    );
  });

  assert.deepEqual(browser.errors, []);
});
