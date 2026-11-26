'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { setTimeout: delay } = require('node:timers/promises');

const harness = require('./harness.js');

const { MEDIA_FLAGS, ORIGIN, launch, startServer, stopServer } = harness;

const FLAGS = MEDIA_FLAGS.concat([
  '--disable-features=WebRtcHideLocalIpsWithMdns',
]);
const CHAT = JSON.stringify('general');
const READY =
  'return app.connected === true && app.mesh.peers.has(app.peerId);';
const JOINED = `const phase = app.callSession ? app.callSession.phase : '';
  if (phase !== 'joined') throw new Error(phase);
  return true;`;
const JOIN = `const button = document.querySelector(
  '#prejoin [data-action=join]');
  if (!button) throw new Error('no join');
  button.click();
  return true;`;

const CTRL = 2;
const ALT = 1;
const CODES = {
  d: { code: 'KeyD', vk: 68 },
  e: { code: 'KeyE', vk: 69 },
  h: { code: 'KeyH', vk: 72 },
  f: { code: 'KeyF', vk: 70 },
  ' ': { code: 'Space', vk: 32 },
};
const ARROWS = {
  ArrowUp: { code: 'ArrowUp', vk: 38 },
  ArrowDown: { code: 'ArrowDown', vk: 40 },
  ArrowRight: { code: 'ArrowRight', vk: 39 },
  End: { code: 'End', vk: 35 },
  Home: { code: 'Home', vk: 36 },
};
Object.assign(CODES, ARROWS);

const waitLoaded = async (browser, sessionId) => {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    const state = await browser
      .evaluate(sessionId, 'document.readyState + location.href')
      .catch(() => '');
    if (state.startsWith('complete') && state.includes(ORIGIN)) return;
    await delay(50);
  }
  throw new Error('Page did not load');
};

const openPage = async (browser, nick) => {
  const created = await browser.request('Target.createBrowserContext');
  const { browserContextId } = created;
  const blank = { url: 'about:blank', browserContextId };
  const { targetId } = await browser.request('Target.createTarget', blank);
  const attach = { targetId, flatten: true };
  const target = await browser.request('Target.attachToTarget', attach);
  const { sessionId } = target;
  await browser.request('Runtime.enable', {}, sessionId);
  await browser.request('Page.enable', {}, sessionId);
  const source = `localStorage.setItem('xxii:nick', ${JSON.stringify(nick)});`;
  const params = { source };
  await browser.request(
    'Page.addScriptToEvaluateOnNewDocument',
    params,
    sessionId,
  );
  await browser.request('Page.navigate', { url: `${ORIGIN}/` }, sessionId);
  await waitLoaded(browser, sessionId);
  return { browserContextId, sessionId };
};

const front = async (browser, session) => {
  await browser.request('Page.bringToFront', {}, session);
  await harness.run(browser, session, 'app.render(); return true;');
};

const until = async (browser, session, body, timeoutMs = 15000) => {
  const deadline = Date.now() + timeoutMs;
  let last = '';
  while (Date.now() < deadline) {
    await front(browser, session);
    try {
      const value = await harness.run(browser, session, body);
      if (value) return;
      last = `returned ${JSON.stringify(value)}`;
    } catch (error) {
      last = error.message;
    }
    await delay(100);
  }
  throw new Error(`Browser condition timed out: ${last}`);
};

const press = async (browser, session, key, options = {}) => {
  const modifiers = options.modifiers ?? 0;
  const known = CODES[key] ?? { code: options.code, vk: options.vk };
  const base = {
    key,
    code: known.code,
    windowsVirtualKeyCode: known.vk,
    nativeVirtualKeyCode: known.vk,
    modifiers,
  };
  const text = options.text ?? '';
  const down = { ...base, type: text ? 'keyDown' : 'rawKeyDown' };
  if (text) down.text = text;
  await browser.request('Input.dispatchKeyEvent', down, session);
  if (options.hold) return;
  await browser.request(
    'Input.dispatchKeyEvent',
    { ...base, type: 'keyUp' },
    session,
  );
};

const release = (browser, session, key) => {
  const known = CODES[key];
  const base = {
    key,
    code: known.code,
    windowsVirtualKeyCode: known.vk,
    nativeVirtualKeyCode: known.vk,
    type: 'keyUp',
  };
  return browser.request('Input.dispatchKeyEvent', base, session);
};

const tab = (browser, session, shift = false) =>
  press(browser, session, 'Tab', {
    code: 'Tab',
    vk: 9,
    modifiers: shift ? 8 : 0,
  });

const FOCUSED = `const element = document.activeElement;
  if (!element) return '';
  const action = element.dataset ? element.dataset.action : '';
  const emoji = element.dataset.emoji || element.dataset.reaction || '';
  return action ? action + emoji : element.tagName;`;

const state = (browser, session) =>
  harness.run(
    browser,
    session,
    `const media = app.callStage.media;
    return {
      mic: media.micOn,
      camera: media.cameraOn,
      hand: app.callStage.isHandRaised(),
      held: app.callStage.talk.held,
    };`,
  );

test(
  'call keyboard: shortcuts, push to talk, reachability, picture-in-picture',
  { timeout: 240000 },
  async (t) => {
    const dataPath = await fs.mkdtemp(path.join(os.tmpdir(), 'xxii-data-'));
    t.after(() => fs.rm(dataPath, { recursive: true, force: true }));
    const server = await startServer(dataPath);
    t.after(() => stopServer(server));
    const browser = await launch(t, FLAGS);
    const page = await openPage(browser, 'alex');
    const id = page.browserContextId;
    t.after(() =>
      browser
        .request('Target.disposeBrowserContext', { browserContextId: id })
        .catch(() => undefined),
    );
    const session = page.sessionId;
    const run = (body) => harness.run(browser, session, body);
    const check = (expected) => until(browser, session, expected);
    await check(READY);
    await run(`app.selectChat(${CHAT}); await app.startCall(${CHAT});
      return true;`);
    await front(browser, session);
    await run(JOIN);
    await check(JOINED);
    await check(`return app.callStage.mode === 'call' &&
      app.callStage.media.micOn === true;`);
    const key = (name, options) => press(browser, session, name, options);

    await key('d', { modifiers: CTRL });
    await check('return app.callStage.media.micOn === false;');
    await key('d', { modifiers: CTRL });
    await check('return app.callStage.media.micOn === true;');
    await key('e', { modifiers: CTRL });
    await check('return app.callStage.media.cameraOn === false;');
    await key('e', { modifiers: CTRL });
    await check('return app.callStage.media.cameraOn === true;');
    await key('h', { modifiers: CTRL | ALT });
    await check('return app.callStage.isHandRaised() === true;');
    await key('h', { modifiers: CTRL | ALT });
    await check('return app.callStage.isHandRaised() === false;');
    await key('h', { modifiers: CTRL });
    await delay(300);
    assert.equal((await state(browser, session)).hand, false);

    await run(`app.messageInput.focus(); return true;`);
    await key('d', { modifiers: CTRL });
    await check('return app.callStage.media.micOn === false;');
    await key(' ', { text: ' ' });
    await key('f', { text: 'f' });
    await delay(300);
    const typed = await run(`return {
      value: app.messageInput.value,
      mic: app.callStage.media.micOn,
      full: document.fullscreenElement === null,
      held: app.callStage.talk.held,
    };`);
    assert.equal(typed.value, ' f');
    assert.equal(typed.mic, false);
    assert.equal(typed.full, true);
    assert.equal(typed.held, false);
    await run(`app.messageInput.value = ''; app.messageInput.blur();
      return true;`);

    await key(' ', { text: ' ', hold: true });
    await check('return app.callStage.media.micOn === true;');
    await key(' ', { text: ' ', hold: true });
    assert.equal((await state(browser, session)).held, true);
    await release(browser, session, ' ');
    await check('return app.callStage.media.micOn === false;');
    assert.equal((await state(browser, session)).held, false);

    await key(' ', { text: ' ', hold: true });
    await check('return app.callStage.media.micOn === true;');
    await run(`window.dispatchEvent(new Event('blur')); return true;`);
    await check('return app.callStage.media.micOn === false;');
    await release(browser, session, ' ');
    await delay(200);
    assert.equal((await state(browser, session)).mic, false);

    await key(' ', { text: ' ', hold: true });
    await check('return app.callStage.media.micOn === true;');
    await key('d', { modifiers: CTRL });
    await check('return app.callStage.media.micOn === false;');
    await release(browser, session, ' ');
    await delay(200);
    assert.equal((await state(browser, session)).mic, false);
    await key('d', { modifiers: CTRL });
    await check('return app.callStage.media.micOn === true;');

    const focus = (selector) =>
      run(`document.querySelector(${JSON.stringify(selector)}).focus();
        return true;`);
    const bar = '#call-view .call-controls';
    await focus(`${bar} [data-action="mic"]`);
    const expected = [
      'mic',
      'mic-menu',
      'camera',
      'camera-menu',
      'share',
      'reactions',
      'record',
      'more',
      'people',
      'chat',
      'leave',
    ];
    const seen = [];
    for (let index = 0; index < expected.length; index++) {
      seen.push(await run(FOCUSED));
      await key('ArrowRight');
    }
    assert.deepEqual(seen, expected);
    assert.equal(await run(FOCUSED), 'mic');
    await key('End');
    assert.equal(await run(FOCUSED), 'leave');
    await key('Home');
    assert.equal(await run(FOCUSED), 'mic');
    const stops = await run(`return document.querySelectorAll(
      '${bar} button[tabindex="0"]').length;`);
    assert.equal(stops, 1);
    await tab(browser, session);
    assert.equal(
      await run(`return document.activeElement.closest('.call-controls');`),
      null,
    );

    await focus(`${bar} [data-action="mic"]`);
    await key('Enter', { code: 'Enter', vk: 13, text: '\r' });
    await check('return app.callStage.media.micOn === false;');
    await key(' ', { text: ' ' });
    await check('return app.callStage.media.micOn === true;');
    await focus(`${bar} [data-action="camera"]`);
    await key('Enter', { code: 'Enter', vk: 13, text: '\r' });
    await check('return app.callStage.media.cameraOn === false;');
    await key(' ', { text: ' ' });
    await check('return app.callStage.media.cameraOn === true;');

    await focus(`${bar} [data-action="mic"]`);
    await key('ArrowUp');
    await check(`return app.callStage.controls.menu.isOpen &&
      document.activeElement.getAttribute('role') === 'menuitemradio';`);
    for (let step = 0; step < 20; step++) {
      const current = await run(FOCUSED);
      if (current === 'setting-pushToTalk') break;
      await key('ArrowDown');
    }
    assert.equal(await run(FOCUSED), 'setting-pushToTalk');
    await key(' ', { text: ' ' });
    await check('return app.callStage.preferences.pushToTalk === false;');
    assert.equal(await run('return app.callStage.controls.menu.isOpen;'), true);
    await key('Escape', { code: 'Escape', vk: 27 });
    assert.equal(await run(FOCUSED), 'mic-menu');
    assert.equal(await run('return app.callStage.mode;'), 'call');

    await focus(`${bar} [data-action="reactions"]`);
    await key('Enter', { code: 'Enter', vk: 13, text: '\r' });
    await check(`return app.callStage.controls.menu.isOpen;`);
    await key('ArrowUp');
    assert.equal(await run(FOCUSED), 'react\u{1F44D}');
    await key('Enter', { code: 'Enter', vk: 13, text: '\r' });
    await check(`const tile = document.querySelector(
      '#call-view .call-tile[data-endpoint="' +
      app.callSession.endpoint + '"]');
      return tile.querySelectorAll('.call-reaction').length === 1 &&
        !app.callStage.controls.menu.isOpen;`);

    await focus(`${bar} [data-action="more"]`);
    await key('Enter', { code: 'Enter', vk: 13, text: '\r' });
    const groups = await run(`return [...document.querySelectorAll(
      '.call-bar-menu [role=group] > .menu-heading')].map(
      (node) => node.textContent);`);
    assert.deepEqual(groups, [
      'View',
      'Layout',
      'Recording and studio',
      'Call',
    ]);
    const actions = await run(`return [...document.querySelectorAll(
      '.call-bar-menu [data-action]')].map((node) => node.dataset.action);`);
    assert.ok(actions.includes('shortcuts'));
    assert.ok(actions.includes('settings'));
    const pip = await run(
      `const item = document.querySelector(
        '.call-bar-menu [data-action="pip"]');
      return {
        api: typeof globalThis.documentPictureInPicture,
        disabled: item.getAttribute('aria-disabled') === 'true',
        note: item.textContent,
      };`,
    );
    await key('Escape', { code: 'Escape', vk: 27 });
    await check(`return !app.callStage.controls.menu.isOpen;`);
    assert.equal(await run(FOCUSED), 'more');

    if (pip.api === 'undefined') {
      assert.equal(pip.disabled, true);
      assert.match(pip.note, /not available/);
      t.diagnostic('documentPictureInPicture missing: manual check');
      return;
    }
    assert.equal(pip.disabled, false);
    const opened = await browser.request(
      'Runtime.evaluate',
      {
        expression: `(async () => {
          const { app } = await import('/domain.js');
          await app.callStage.openPip();
          return app.callStage.pip !== null;
        })()`,
        awaitPromise: true,
        returnByValue: true,
        userGesture: true,
      },
      session,
    );
    t.diagnostic(`pip open: ${JSON.stringify(opened.result.value)}`);
    assert.equal(opened.result.value, true);
    await check(`return app.callStage.mode === 'mini' &&
      document.getElementById('mini-call').classList.contains('hidden');`);
    const inPip = (body) =>
      run(`const root = app.callStage.pip.root;
        const doc = root.ownerDocument;
        ${body}`);
    const labels = await inPip(
      `return Array.from(root.querySelectorAll('[data-action]'),
        (item) => item.dataset.action).join(',');`,
    );
    assert.match(labels, /pip-back,mic,camera,reactions,leave/);
    assert.doesNotMatch(labels, /hand|react,/);
    await inPip(`root.querySelector('[data-action="mic"]').click();
      return true;`);
    await check('return app.callStage.media.micOn === false;');
    await inPip(`doc.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'd', code: 'KeyD', ctrlKey: true, bubbles: true }));
      return true;`);
    await check('return app.callStage.media.micOn === true;');
    await inPip(`root.querySelector('[data-action="reactions"]').click();
      return true;`);
    const menu = await inPip(`const menu = doc.querySelector('.pip-menu');
      return {
        shown: !menu.classList.contains('hidden'),
        inside: menu.ownerDocument === doc && doc !== document,
        reactions: menu.querySelectorAll('[data-action="react"]').length,
        expanded: root.querySelector('[data-action="reactions"]')
          .getAttribute('aria-expanded'),
      };`);
    assert.deepEqual(menu, {
      shown: true,
      inside: true,
      reactions: 6,
      expanded: 'true',
    });
    await inPip(`doc.querySelector('.pip-menu [data-action="hand"]').click();
      return true;`);
    await check(`return app.callStage.isHandRaised() === true &&
      app.callStage.pip.root.querySelector('[data-action="reactions"]')
        .getAttribute('aria-label') === 'Reactions, hand raised' &&
      app.callStage.pip.root.ownerDocument.querySelector('.pip-menu')
        .classList.contains('hidden');`);
    await delay(1500);
    await inPip(`root.querySelector('[data-action="reactions"]').click();
      doc.querySelector('.pip-menu [data-action="react"]').click();
      return true;`);
    await check(`const root = app.callStage.pip.root;
      return root.querySelectorAll('.call-reaction').length === 1;`);
    await inPip(`root.querySelector('[data-action="pip-back"]').click();
      return true;`);
    await check(`return app.callStage.pip === null &&
      app.callStage.mode === 'call';`);
  },
);
