'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { setTimeout: delay } = require('node:timers/promises');

const harness = require('./harness.js');

const { ORIGIN, MEDIA_FLAGS, launch, startCallServer } = harness;

const FLAGS = MEDIA_FLAGS.concat([
  '--disable-features=WebRtcHideLocalIpsWithMdns',
]);
const READY = `return app.connected && navigator.serviceWorker.controller &&
  app.mesh.peers.has(app.peerId);`;
const DESKTOP = { width: 1280, height: 800, mobile: false };
const PHONE = { width: 390, height: 844, mobile: true };
const FILLERS = 40;

const KEYS = {
  Escape: { key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 },
  Tab: { key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 },
};

test('search closes itself', { timeout: 280000 }, async (t) => {
  await startCallServer(t);
  const browser = await launch(t, FLAGS);

  const open = async (viewport) => {
    const { browserContextId } = await browser.request(
      'Target.createBrowserContext',
    );
    t.after(() =>
      browser
        .request('Target.disposeBrowserContext', { browserContextId })
        .catch(() => undefined),
    );
    const created = await browser.request('Target.createTarget', {
      url: 'about:blank',
      browserContextId,
    });
    const attach = { targetId: created.targetId, flatten: true };
    const { sessionId } = await browser.request(
      'Target.attachToTarget',
      attach,
    );
    await browser.request('Runtime.enable', {}, sessionId);
    await browser.request('Page.enable', {}, sessionId);
    await browser.request('Page.bringToFront', {}, sessionId);
    await browser.request(
      'Emulation.setDeviceMetricsOverride',
      { ...viewport, deviceScaleFactor: 1 },
      sessionId,
    );
    await browser.request(
      'Emulation.setTouchEmulationEnabled',
      { enabled: viewport.mobile },
      sessionId,
    );
    const source = `localStorage.setItem('xxii:nick', 'alex');`;
    await browser.request(
      'Page.addScriptToEvaluateOnNewDocument',
      { source },
      sessionId,
    );
    await browser.request('Page.navigate', { url: `${ORIGIN}/` }, sessionId);
    await harness.wait(browser, sessionId, READY, 30000);
    return sessionId;
  };

  const run = (session, body) => harness.run(browser, session, body);
  const wait = (session, body, ms) => harness.wait(browser, session, body, ms);

  const mouse = (session, type, point) =>
    browser.request(
      'Input.dispatchMouseEvent',
      { type, x: point.x, y: point.y, button: 'left', clickCount: 1 },
      session,
    );
  const press = async (session, point) => {
    await mouse(session, 'mouseMoved', point);
    await mouse(session, 'mousePressed', point);
  };
  const release = (session, point) => mouse(session, 'mouseReleased', point);
  const clickAt = async (session, point) => {
    await press(session, point);
    await release(session, point);
  };
  const key = async (session, name) => {
    const params = { ...KEYS[name], type: 'rawKeyDown' };
    await browser.request('Input.dispatchKeyEvent', params, session);
    const up = { ...KEYS[name], type: 'keyUp' };
    await browser.request('Input.dispatchKeyEvent', up, session);
  };
  const pointOf = (session, selector) =>
    run(
      session,
      `const box = document.querySelector(${JSON.stringify(selector)})
        .getBoundingClientRect();
      return { x: box.left + box.width / 2, y: box.top + box.height / 2 };`,
    );
  const rowOf = (text) =>
    `[...app.messageList.querySelectorAll('.message')].find((row) =>
      row.querySelector('.content').textContent === ${JSON.stringify(text)})`;
  const rowPoint = (session, text) =>
    run(
      session,
      `const box = ${rowOf(text)}.querySelector('.content')
        .getBoundingClientRect();
      return { x: box.left + 4, y: box.top + box.height / 2 };`,
    );

  const write = (session, content, replyTo = '') =>
    run(
      session,
      `return app.writeMessage(app.chat, ${JSON.stringify(content)},
        ${JSON.stringify(replyTo || undefined)}, []);`,
    );

  const search = async (session, text = 'needle') => {
    await run(
      session,
      `app.closeSearch();
      app.toggleSearch();
      app.searchInput.value = ${JSON.stringify(text)};
      app.searchInput.dispatchEvent(new Event('input'));
      return true;`,
    );
    await wait(
      session,
      `return app.filter === ${JSON.stringify(text)} && app.isSearching()
        && app.searchInput === document.activeElement;`,
    );
  };

  const state = (session) =>
    run(
      session,
      `return {
        open: app.isSearching(),
        filter: app.filter,
        value: app.searchInput.value,
        active: app.searchBtn.classList.contains('active'),
        pressed: app.searchBtn.getAttribute('aria-pressed'),
        rows: app.messageList.querySelectorAll('.message').length,
        focus: document.activeElement.id,
      };`,
    );

  const expectClosed = async (session, label, hasRows = true) => {
    await wait(session, `return !app.isSearching();`);
    const closed = await state(session);
    assert.equal(closed.open, false, label);
    assert.equal(closed.filter, '', label);
    assert.equal(closed.value, '', label);
    assert.equal(closed.active, false, label);
    assert.equal(closed.pressed, 'false', label);
    if (hasRows) assert.ok(closed.rows > 2, `${label}: messages are back`);
  };

  const expectOpen = async (session, label) => {
    const opened = await state(session);
    assert.equal(opened.open, true, label);
    assert.equal(opened.filter, 'needle', label);
    assert.equal(opened.active, true, label);
    assert.equal(opened.pressed, 'true', label);
    assert.equal(opened.rows, 2, `${label}: only found messages`);
  };

  const session = await open(DESKTOP);
  await run(session, `app.selectChat('general'); return true;`);
  const first = await write(session, 'needle first');
  await write(session, 'plain reply', first);
  for (let index = 0; index < FILLERS; index++) {
    await write(session, `filler ${index}`);
  }
  await write(session, 'needle last');
  await wait(
    session,
    `app.render();
    return ${rowOf('needle last')} !== undefined;`,
  );

  const triggers = {
    'composer click': async () =>
      clickAt(session, await pointOf(session, '#message-input')),
    'composer focus': () =>
      run(session, `app.messageInput.focus(); return true;`),
    'click outside': async () =>
      clickAt(session, await pointOf(session, '.sidebar .brand')),
    escape: () => key(session, 'Escape'),
    'input blur': () => run(session, `app.searchInput.blur(); return true;`),
    'chat change': () => run(session, `app.selectChat('random'); return true;`),
    'pins panel': () => run(session, `app.togglePanel('pins'); return true;`),
    'members panel': () =>
      run(session, `app.togglePanel('members'); return true;`),
    settings: () => run(session, `app.openSettings(''); return true;`),
    recordings: () => run(session, `app.openLibrary(); return true;`),
    'message menu': () =>
      run(
        session,
        `app.openMenuFor(${rowOf('needle last')});
        return true;`,
      ),
    'call pre-join': () => run(session, `app.callBtn.click(); return true;`),
    'search button': async () =>
      clickAt(session, await pointOf(session, '#search-btn')),
  };

  const restore = async () => {
    await run(
      session,
      `if (app.settings.isOpen) app.closeSettings();
      if (app.recordingsView.isOpen) app.closeRecordings();
      if (app.panel) app.closePanel();
      app.closeMenu();
      return true;`,
    );
    await wait(
      session,
      `return !app.settings.isOpen && !app.recordingsView.isOpen
        && app.panel === '' && !app.menu.isOpen;`,
    );
    await run(session, `app.selectChat('general'); return true;`);
    await wait(
      session,
      `return app.messageList.querySelectorAll('.message')
      .length > 2;`,
    );
  };

  for (const name of Object.keys(triggers)) {
    await t.test(`closes on ${name}`, async () => {
      if (name === 'call pre-join') {
        await run(session, `return app.selectChat('general');`);
      }
      await search(session);
      await expectOpen(session, name);
      await triggers[name]();
      await expectClosed(session, name, name !== 'chat change');
      if (name === 'call pre-join') {
        await wait(session, `return app.callStage?.mode === 'prejoin';`);
        await run(session, `app.callStage.cancel(); return true;`);
      }
      await restore();
    });
  }

  await t.test('the search button reopens a closed search', async () => {
    await search(session);
    await clickAt(session, await pointOf(session, '#search-btn'));
    await expectClosed(session, 'button off');
    await delay(100);
    assert.equal((await state(session)).open, false);
    await clickAt(session, await pointOf(session, '#search-btn'));
    await wait(session, `return app.isSearching();`);
  });

  await t.test('window blur closes an empty search only', async () => {
    await search(session, '');
    await run(session, `window.dispatchEvent(new Event('blur')); return true;`);
    await expectClosed(session, 'window blur');
  });

  await t.test('typing and window blur keep a filled search', async () => {
    await run(session, `app.closeSearch(); return true;`);
    await search(session);
    await run(session, `window.dispatchEvent(new Event('blur')); return true;`);
    await expectOpen(session, 'window blur with a query');
    await run(session, `app.closeSearch(); return true;`);
  });

  await t.test('focus inside the found messages keeps it open', async () => {
    await search(session);
    await run(
      session,
      `${rowOf('needle last')}.querySelector('button').focus();
      return true;`,
    );
    await delay(150);
    await expectOpen(session, 'button in a found message');
    await run(session, `app.closeSearch(); return true;`);
  });

  await t.test('a press on a found message waits for the click', async () => {
    await search(session);
    const point = await rowPoint(session, 'needle last');
    await press(session, point);
    await delay(150);
    await expectOpen(session, 'pressed');
    await release(session, point);
    await expectClosed(session, 'released');
  });

  await t.test('a click on a found message keeps it in view', async () => {
    await run(session, `app.closeSearch(); return true;`);
    await run(
      session,
      `app.chatMessages.scrollTop = app.chatMessages.scrollHeight; return 1;`,
    );
    await search(session);
    const point = await rowPoint(session, 'needle first');
    await clickAt(session, point);
    await expectClosed(session, 'click');
    await wait(
      session,
      `const box = app.chatMessages.getBoundingClientRect();
      const rect = ${rowOf('needle first')}.getBoundingClientRect();
      return rect.top >= box.top - 1 && rect.bottom <= box.bottom + 1;`,
    );
    const found = await run(
      session,
      `const row = ${rowOf('needle first')};
      return {
        focused: document.activeElement === row,
        chosen: row.classList.contains('chosen'),
        marked: row.classList.contains('found'),
        root: app.selection?.root === row.dataset.id,
        pops: app.pops,
      };`,
    );
    assert.equal(found.focused, true);
    assert.equal(found.marked, true);
    assert.equal(found.chosen, true);
    assert.equal(found.root, true);
  });

  await t.test('a found message without replies stays selected', async () => {
    await run(session, `app.closeThread(); return true;`);
    await wait(session, `return app.selection === null && app.pops === 0;`);
    await run(session, `app.chatMessages.scrollTop = 0; return true;`);
    await search(session, 'filler 7');
    const point = await rowPoint(session, 'filler 7');
    await clickAt(session, point);
    await wait(session, `return !app.isSearching();`);
    await wait(
      session,
      `const box = app.chatMessages.getBoundingClientRect();
      const row = ${rowOf('filler 7')};
      const rect = row.getBoundingClientRect();
      return rect.top >= box.top - 1 && rect.bottom <= box.bottom + 1
        && document.activeElement === row;`,
    );
    const found = await run(
      session,
      `const row = ${rowOf('filler 7')};
      return {
        marked: row.classList.contains('found'),
        shadow: getComputedStyle(row).boxShadow,
      };`,
    );
    assert.equal(found.marked, true);
    assert.notEqual(found.shadow, 'none');
    assert.equal((await state(session)).filter, '');
  });

  await t.test('a plain click outside search leaves no highlight', async () => {
    const point = await rowPoint(session, 'filler 9');
    await clickAt(session, point);
    await delay(200);
    const plain = await run(
      session,
      `const rows = [...app.messageList.querySelectorAll('.message')];
      const row = ${rowOf('filler 9')};
      return {
        found: rows.some((item) => item.classList.contains('found')),
        shadow: getComputedStyle(row).boxShadow,
        focused: document.activeElement === row,
      };`,
    );
    assert.equal(plain.found, false);
    assert.equal(plain.shadow, 'none');
    assert.equal(plain.focused, false);
  });

  await t.test('on the phone the search closes the same way', async () => {
    await browser.request(
      'Emulation.setDeviceMetricsOverride',
      { ...PHONE, deviceScaleFactor: 1 },
      session,
    );
    await run(session, `app.selectChat('general'); return true;`);
    await search(session);
    await expectOpen(session, 'phone');
    await key(session, 'Escape');
    await expectClosed(session, 'phone escape');
    await search(session);
    await run(session, `app.toggleSidebar(); return true;`);
    await run(session, `app.selectChat('random'); return true;`);
    await expectClosed(session, 'phone chat change', false);
  });
});
