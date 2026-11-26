'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { setTimeout: delay } = require('node:timers/promises');

const harness = require('./harness.js');

const { MEDIA_FLAGS, ORIGIN, launch, startCallServer } = harness;
const FLAGS = MEDIA_FLAGS.concat([
  '--disable-features=WebRtcHideLocalIpsWithMdns',
]);
const READY = 'return app.connected && app.mesh.peers.has(app.peerId);';
const JOIN = `document.querySelector('#prejoin [data-action=join]').click();
  return true;`;
const BAR = '#call-view .call-controls';
const MENU = '.call-bar-menu';
const MORE = `${BAR} [data-action=more]`;
const CTRL = 2;
const CTRL_ALT = 3;
const KEYS = {
  ArrowRight: { code: 'ArrowRight', vk: 39 },
  ArrowUp: { code: 'ArrowUp', vk: 38 },
  End: { code: 'End', vk: 35 },
  Home: { code: 'Home', vk: 36 },
  Escape: { code: 'Escape', vk: 27 },
};
const PHONE_SIZE = { width: 390, height: 844, deviceScaleFactor: 1 };

const openPerson = async (t, browser, nick) => {
  const { browserContextId } = await browser.request(
    'Target.createBrowserContext',
  );
  t.after(() =>
    browser
      .request('Target.disposeBrowserContext', { browserContextId })
      .catch(() => undefined),
  );
  const { targetId } = await browser.request('Target.createTarget', {
    url: 'about:blank',
    browserContextId,
  });
  const { sessionId } = await browser.request('Target.attachToTarget', {
    targetId,
    flatten: true,
  });
  await browser.request('Runtime.enable', {}, sessionId);
  await browser.request('Page.enable', {}, sessionId);
  const source = `localStorage.setItem('xxii:nick', ${JSON.stringify(nick)});`;
  await browser.request(
    'Page.addScriptToEvaluateOnNewDocument',
    { source },
    sessionId,
  );
  await browser.request('Page.navigate', { url: `${ORIGIN}/` }, sessionId);
  await delay(500);
  await harness.wait(browser, sessionId, READY, 30000);
  return sessionId;
};

const waitFor = async (browser, session, body, timeoutMs = 20000) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await browser.request('Page.bringToFront', {}, session);
    await harness.run(browser, session, 'app.render(); return true;');
    const result = await harness.run(browser, session, body).catch(() => false);
    if (result) return;
    await delay(100);
  }
  const result = await harness.run(browser, session, body);
  throw new Error(`Condition failed: ${JSON.stringify(result)}\n${body}`);
};

const gesture = async (browser, session, body) => {
  await browser.request('Page.bringToFront', {}, session);
  const params = {
    expression: harness.script(body),
    userGesture: true,
    awaitPromise: true,
    returnByValue: true,
  };
  const result = await browser.request('Runtime.evaluate', params, session);
  const details = result.exceptionDetails;
  if (details) {
    const description = details.exception?.description;
    throw new Error(description ?? JSON.stringify(details));
  }
  return result.result.value;
};

const click = (selector) => `const node = document.querySelector(
  ${JSON.stringify(selector)});
  if (!node) throw new Error('Missing ${selector}');
  node.click();
  return true;`;

const press = async (browser, session, key) => {
  const known = KEYS[key];
  const base = {
    key,
    code: known.code,
    windowsVirtualKeyCode: known.vk,
    nativeVirtualKeyCode: known.vk,
  };
  await browser.request(
    'Input.dispatchKeyEvent',
    { ...base, type: 'rawKeyDown' },
    session,
  );
  await browser.request(
    'Input.dispatchKeyEvent',
    { ...base, type: 'keyUp' },
    session,
  );
};

const chord = async (browser, session, key, code, vk, modifiers) => {
  const base = {
    key,
    code,
    windowsVirtualKeyCode: vk,
    nativeVirtualKeyCode: vk,
    modifiers,
  };
  const down = { ...base, type: 'rawKeyDown' };
  await browser.request('Input.dispatchKeyEvent', down, session);
  await browser.request(
    'Input.dispatchKeyEvent',
    { ...base, type: 'keyUp' },
    session,
  );
};

const openMore = `const menu = document.querySelector('${MENU}');
  if (menu.classList.contains('hidden')) {
    document.querySelector('${MORE}').click();
  }`;

const pick = (selector) => `${openMore}
  const item = document.querySelector('${MENU} ${selector}');
  if (!item) throw new Error('Missing ${selector}');
  item.click();
  return true;`;

test(
  'call control bar: toolbar, menus, share, react, record, leave',
  { timeout: 240000 },
  async (t) => {
    await startCallServer(t);
    const browser = await launch(t, FLAGS);
    const run = (session, body) => harness.run(browser, session, body);
    const left = await openPerson(t, browser, 'alex');
    const right = await openPerson(t, browser, 'kim');
    const host = await run(
      left,
      `app.selectChat('general');
      await app.startCall('general');
      return { endpoint: app.callSession.endpoint, token: app.callToken };`,
    );
    await run(left, JOIN);
    await run(
      right,
      `app.selectChat('general');
      await app.startCall('general', { token: ${JSON.stringify(host.token)} });
      return true;`,
    );
    await run(right, JOIN);
    await waitFor(browser, left, 'return app.callSession?.linkCount === 1;');
    await waitFor(browser, left, 'return app.callStage.people.length === 2;');
    await waitFor(browser, right, 'return app.callStage.mode === "call";');
    await browser.request('Page.bringToFront', {}, left);

    await t.test('the bar is a toolbar of named controls', async () => {
      const bar = await run(
        left,
        `const root = document.querySelector('${BAR}');
        const names = Array.from(root.querySelectorAll('button'),
          (button) => button.getAttribute('aria-label'));
        const mic = root.querySelector('[data-action=mic]');
        const camera = root.querySelector('[data-action=camera]');
        const lastGroup = root.lastElementChild.lastElementChild;
        return {
          tag: root.tagName,
          role: root.getAttribute('role'),
          label: root.getAttribute('aria-label'),
          names,
          mic: mic.getAttribute('aria-pressed'),
          camera: camera.getAttribute('aria-pressed'),
          last: lastGroup.dataset.action,
          stops: root.querySelectorAll('button[tabindex="0"]').length,
          hasDetails: document.querySelector('#call-view .call-controls ' +
            'details') !== null,
        };`,
      );
      assert.equal(bar.tag, 'FOOTER');
      assert.equal(bar.role, 'toolbar');
      assert.equal(bar.label, 'Call controls');
      assert.ok(bar.names.every((name) => name));
      assert.deepEqual(bar.names, [
        'Microphone',
        'Audio options',
        'Camera',
        'Video options',
        'Share screen',
        'Reactions',
        'Record',
        'More options',
        'People',
        'Chat',
        'Leave call',
      ]);
      assert.equal(bar.mic, 'true');
      assert.equal(bar.camera, 'true');
      assert.equal(bar.last, 'leave');
      assert.equal(bar.stops, 1);
      assert.equal(bar.hasDetails, false);
    });

    await t.test('arrow keys move between controls', async () => {
      const focused = `return document.activeElement.dataset.action;`;
      await run(
        left,
        `document.querySelector('${BAR} [data-action=mic]').focus();
        return true;`,
      );
      await press(browser, left, 'ArrowRight');
      assert.equal(await run(left, focused), 'mic-menu');
      await press(browser, left, 'End');
      assert.equal(await run(left, focused), 'leave');
      await press(browser, left, 'ArrowRight');
      assert.equal(await run(left, focused), 'mic');
      await press(browser, left, 'Home');
      assert.equal(await run(left, focused), 'mic');
    });

    await t.test('the device menu, choosing a mic, push-to-talk', async () => {
      await run(
        left,
        `document.querySelector('${BAR} [data-action=mic]').focus();
        return true;`,
      );
      await press(browser, left, 'ArrowUp');
      await waitFor(
        browser,
        left,
        `const caret = document.querySelector('${BAR} [data-action=mic-menu]');
        const menu = document.querySelector('${MENU}');
        return !menu.classList.contains('hidden') &&
          caret.getAttribute('aria-expanded') === 'true' &&
          menu.contains(document.activeElement) &&
          menu.querySelectorAll('[role=menuitemradio]').length > 1;`,
      );
      const before = await run(
        left,
        `return app.callStage.media.micTrack.getSettings().deviceId;`,
      );
      const picked = await run(
        left,
        `const radios = [...document.querySelectorAll(
          '${MENU} [data-action=device-mic]')];
        const target = radios.find((item) =>
          item.textContent.includes('Audio Input 1'));
        target.click();
        return radios.length;`,
      );
      assert.ok(picked > 1);
      await waitFor(
        browser,
        left,
        `const media = app.callStage.media;
        const saved = JSON.parse(localStorage.getItem('xxii:devices'));
        const id = media.micTrack?.getSettings().deviceId;
        return document.querySelector('${MENU}').classList.contains('hidden') &&
          media.micId !== '' && saved.mic === media.micId &&
          id === media.micId && id !== ${JSON.stringify(before)};`,
      );
      await run(left, click(`${BAR} [data-action=mic-menu]`));
      const talk = await run(
        left,
        `const item = document.querySelector(
          '${MENU} [data-action=setting-pushToTalk]');
        const was = item.getAttribute('aria-checked');
        item.click();
        return {
          was,
          now: item.getAttribute('aria-checked'),
          open: !document.querySelector('${MENU}').classList
            .contains('hidden'),
          stored: app.callStage.preferences.pushToTalk,
        };`,
      );
      assert.equal(talk.was, 'true');
      assert.equal(talk.now, 'false');
      assert.equal(talk.open, true);
      assert.equal(talk.stored, false);
      await run(
        left,
        `document.querySelector('${MENU} [data-action=setting-pushToTalk]')
          .click();
        app.callStage.controls.menu.close();
        return true;`,
      );
    });

    await t.test('mic and camera toggles show state', async () => {
      await run(left, click(`${BAR} [data-action=mic]`));
      const muted = await run(
        left,
        `const wrap = document.querySelector('${BAR} .call-mic');
        const main = wrap.querySelector('.call-control');
        return [main.getAttribute('aria-pressed'),
          wrap.classList.contains('off'),
          main.querySelector('svg').dataset.icon,
          main.getAttribute('aria-label')];`,
      );
      assert.deepEqual(muted, ['false', true, 'mic-off', 'Microphone']);
      await run(left, click(`${BAR} [data-action=mic]`));
      const on = await run(
        left,
        `return document.querySelector('${BAR} .call-mic .call-control svg')
          .dataset.icon;`,
      );
      assert.equal(on, 'mic');
    });

    await t.test('share, the sharing pill, and stop', async () => {
      await gesture(browser, left, click(`${BAR} [data-action=share]`));
      await waitFor(
        browser,
        left,
        `const share = document.querySelector('${BAR} [data-action=share]');
        const pill = document.querySelector('.call-sharing');
        return app.callStage.media.screenShared &&
          share.textContent === 'stop' &&
          share.getAttribute('aria-pressed') === 'true' &&
          !pill.classList.contains('hidden') &&
          pill.textContent.includes('sharing screen');`,
      );
      await run(left, click('.call-sharing-menu'));
      await run(left, click(`${MENU} [data-action=screen-motion]`));
      const motion = await run(
        left,
        `const item = document.querySelector(
          '${MENU} [data-action=screen-motion]');
        return [app.callStage.media.screenMotion,
          item.getAttribute('aria-checked'),
          !document.querySelector('${MENU}').classList.contains('hidden')];`,
      );
      assert.deepEqual(motion, [true, 'true', true]);
      await run(left, click(`${MENU} [data-action=screen-motion]`));
      assert.equal(
        await run(left, 'return app.callStage.media.screenMotion;'),
        false,
      );
      await run(left, click(`${MENU} [data-action=stop-screen]`));
      await waitFor(
        browser,
        left,
        `const share = document.querySelector('${BAR} [data-action=share]');
        return !app.callStage.media.screenTrack &&
          share.textContent === 'share' &&
          document.querySelector('.call-sharing')
            .classList.contains('hidden');`,
      );
    });

    await t.test('react, raise hand, and lower from the tile', async () => {
      await run(left, click(`${BAR} [data-action=reactions]`));
      await run(
        left,
        `return document.querySelectorAll(
        '${MENU} [data-action=react]').length === 6 ? true : false;`,
      );
      await run(left, click(`${MENU} [data-action=react]`));
      await waitFor(
        browser,
        left,
        `const tile = document.querySelector(
          '.call-tile.local:not(.screen-tile)');
          return tile.querySelectorAll('.call-reaction').length === 1 &&
            document.querySelector('${MENU}').classList.contains('hidden');`,
      );
      await delay(1500);
      await run(left, click(`${BAR} [data-action=reactions]`));
      await run(left, click(`${MENU} [data-action=hand]`));
      await waitFor(
        browser,
        left,
        `const control = document.querySelector(
          '${BAR} [data-action=reactions]');
        const badge = document.querySelector('.call-tile.local ' +
          '.call-hand-badge');
        return app.callStage.isHandRaised() &&
          control.getAttribute('aria-label') === 'Reactions, hand raised' &&
          control.querySelector('.call-label').textContent === 'hand' &&
          control.querySelector('svg').dataset.icon === 'hand' &&
          badge.tagName === 'BUTTON' && !badge.classList.contains('hidden') &&
          badge.getAttribute('aria-label') === 'Lower hand' &&
          document.querySelector('${MENU}').classList.contains('hidden');`,
      );
      await delay(2500);
      await run(left, click('.call-tile.local .call-hand-badge'));
      await waitFor(
        browser,
        left,
        `const control = document.querySelector(
          '${BAR} [data-action=reactions]');
        return !app.callStage.isHandRaised() &&
          control.getAttribute('aria-label') === 'Reactions';`,
      );
    });

    await t.test('record, the topbar indicator, and the panel', async () => {
      await run(
        left,
        `window.asked = [];
        window.answer = false;
        window.confirm = (text) => {
          window.asked.push(text);
          return window.answer;
        };
        return true;`,
      );
      await delay(1500);
      await chord(browser, left, 'r', 'KeyR', 82, CTRL_ALT);
      await waitFor(
        browser,
        left,
        `return app.callStage.recording.recorder?.state === 'recording';`,
      );
      assert.deepEqual(await run(left, 'return window.asked;'), []);
      await delay(1500);
      const state = await run(
        left,
        `const control = document.querySelector(
          '${BAR} [data-action=record]');
        const note = document.querySelector('.call-recording');
        return {
          label: control.textContent,
          pressed: control.getAttribute('aria-pressed'),
          recording: control.classList.contains('recording'),
          note: note.textContent,
          noteTag: note.tagName,
          panel: document.querySelector('.call-record .record-state')
            .textContent,
          first: document.querySelector('.call-record').firstElementChild
            .nextElementSibling.className,
        };`,
      );
      assert.equal(state.label, 'stop');
      assert.equal(state.pressed, 'true');
      assert.equal(state.recording, true);
      assert.match(state.note, /^● \d\d:\d\d · [\d.]+ (B|KB|MB)$/);
      assert.equal(state.noteTag, 'BUTTON');
      assert.match(state.panel, /^recording · \d\d:\d\d · /);
      assert.equal(state.first, 'record-state');
      await waitFor(
        browser,
        right,
        `return document.querySelector('.call-recording')
          .textContent === '● alex recording';`,
      );
      await run(left, click('.call-recording'));
      await waitFor(
        browser,
        left,
        `return document.querySelector('.call-record')
          .hasAttribute('data-open') &&
          app.callStage.programPanel === 'record';`,
      );
      await run(left, click('.call-recording'));
      await gesture(browser, left, click(`${BAR} [data-action=record]`));
      await chord(browser, left, 'r', 'KeyR', 82, CTRL_ALT);
      const asked = await run(left, 'return window.asked;');
      assert.deepEqual(asked, ['Stop the recording?', 'Stop the recording?']);
      assert.equal(
        await run(left, 'return app.callStage.recording.isActive;'),
        true,
      );
      await run(left, 'window.answer = true; return true;');
      await chord(browser, left, 'r', 'KeyR', 82, CTRL_ALT);
      await waitFor(
        browser,
        left,
        `const label = document.querySelector(
          '${BAR} [data-action=record] .call-label').textContent;
        return app.callStage.recording.isActive === false &&
          label === 'record' &&
          document.querySelector('.call-recording')
            .classList.contains('hidden');`,
        30000,
      );
      assert.equal((await run(left, 'return window.asked;')).length, 3);
    });

    await t.test('more: groups, layout radios, and the strip row', async () => {
      await run(left, click(MORE));
      const menu = await run(
        left,
        `const root = document.querySelector('${MENU}');
        const text = (nodes) => [...nodes].map((node) => node.textContent);
        return {
          headings: text(root.querySelectorAll(
            '[role=group] > .menu-heading')),
          radios: [...root.querySelectorAll('[data-action=layout-choice]')]
            .map((node) => [node.textContent, node.getAttribute('role'),
              node.getAttribute('aria-checked')]),
          checks: text(root.querySelectorAll('[role=menuitemcheckbox]')),
          strip: root.querySelector('[data-action=strip-choice]') !== null,
          labels: text(root.querySelectorAll('[role=menuitem]')),
          actions: [...root.querySelectorAll('[data-action]')]
            .map((node) => node.dataset.action),
          expanded: document.querySelector('${MORE}')
            .getAttribute('aria-expanded'),
          sheet: root.classList.contains('sheet'),
        };`,
      );
      assert.deepEqual(menu.headings, [
        'View',
        'Layout',
        'Recording and studio',
        'Call',
      ]);
      assert.deepEqual(menu.radios, [
        ['auto', 'menuitemradio', 'true'],
        ['grid', 'menuitemradio', 'false'],
        ['spotlight', 'menuitemradio', 'false'],
        ['sidebar', 'menuitemradio', 'false'],
      ]);
      assert.deepEqual(menu.checks, [
        'Hide self view',
        'Hide tiles without video',
        'Stats overlay',
      ]);
      assert.equal(menu.strip, false);
      assert.deepEqual(menu.labels, [
        'Full screen · F',
        'Picture-in-picture',
        'Recording options',
        'Recordings library',
        'Studio',
        'Copy call link',
        'Keyboard shortcuts · Ctrl /',
        'Settings…',
      ]);
      assert.ok(!menu.actions.includes('stop-live'));
      assert.equal(menu.expanded, 'true');
      assert.equal(menu.sheet, false);
      const layout = (name) =>
        `const item = [...document.querySelectorAll(
          '${MENU} [data-action=layout-choice]')]
          .find((node) => node.textContent === '${name}');
        item.click();
        return true;`;
      await run(left, layout('spotlight'));
      await waitFor(
        browser,
        left,
        `const radios = [...document.querySelectorAll(
          '${MENU} [data-action=strip-choice]')];
        return app.callStage.layout === 'spotlight' &&
          document.querySelector('.call-grid').dataset.layout ===
            'spotlight' &&
          !document.querySelector('${MENU}').classList.contains('hidden') &&
          radios.map((node) => node.textContent).join() ===
            'bottom,top,left,right' &&
          radios[0].getAttribute('aria-checked') === 'true';`,
      );
      await run(
        left,
        `[...document.querySelectorAll('${MENU} [data-action=strip-choice]')]
          .find((node) => node.textContent === 'right').click();
        return true;`,
      );
      await waitFor(
        browser,
        left,
        `return app.callStage.strip === 'right' &&
          !document.querySelector('${MENU}').classList.contains('hidden');`,
      );
      await run(left, layout('grid'));
      await waitFor(
        browser,
        left,
        `return document.querySelector('.call-grid').dataset.layout ===
            'grid' &&
          document.querySelector('${MENU} [data-action=strip-choice]') ===
            null;`,
      );
      await run(left, layout('auto'));
      await run(left, 'app.callStage.setStrip("bottom"); return true;');
      await press(browser, left, 'Escape');
      await waitFor(
        browser,
        left,
        `return document.querySelector('${MENU}').classList.contains('hidden')
          && document.activeElement === document.querySelector('${MORE}')
          && document.querySelector('${MORE}')
            .getAttribute('aria-expanded') === 'false';`,
      );
    });

    await t.test('view checkboxes keep the menu open', async () => {
      await run(left, pick('[data-action=hide-self]'));
      const state = await run(
        left,
        `const item = document.querySelector(
          '${MENU} [data-action=hide-self]');
        return [app.callStage.hideSelf, item.getAttribute('aria-checked'),
          document.querySelector('${MENU}').classList.contains('hidden')];`,
      );
      assert.deepEqual(state, [true, 'true', false]);
      await run(left, pick('[data-action=hide-self]'));
      assert.equal(await run(left, 'return app.callStage.hideSelf;'), false);
      await press(browser, left, 'Escape');
    });

    await t.test(
      'keyboard shortcuts: menu, Ctrl /, all shortcuts',
      async () => {
        await run(left, pick('[data-action=shortcuts]'));
        const dialog = await run(
          left,
          `const dialog = document.querySelector('.call-keys-dialog');
        return {
          open: dialog.open,
          label: dialog.getAttribute('aria-label'),
          keys: [...dialog.querySelectorAll('dt kbd')].map(
            (node) => node.textContent),
          rows: dialog.querySelectorAll('dd').length,
          buttons: [...dialog.querySelectorAll('button')].map(
            (node) => node.textContent),
          menu: document.querySelector('${MENU}').classList
            .contains('hidden'),
        };`,
        );
        assert.equal(dialog.open, true);
        assert.equal(dialog.label, 'Keyboard shortcuts');
        assert.ok(dialog.keys.includes('Ctrl D'));
        assert.ok(dialog.keys.includes('Ctrl Alt R'));
        assert.ok(dialog.keys.includes('Ctrl /'));
        assert.ok(dialog.keys.includes('hold Space'));
        assert.equal(dialog.rows, dialog.keys.length);
        assert.deepEqual(dialog.buttons, ['all shortcuts', 'close']);
        assert.equal(dialog.menu, true);
        await press(browser, left, 'Escape');
        await waitFor(
          browser,
          left,
          `return document.querySelector('.call-keys-dialog') === null &&
          app.callStage.mode === 'call';`,
        );
        await chord(browser, left, '/', 'Slash', 191, CTRL);
        await waitFor(
          browser,
          left,
          `return document.querySelector('.call-keys-dialog')?.open === true;`,
        );
        await press(browser, left, 'Escape');
        await waitFor(
          browser,
          left,
          `return document.querySelector('.call-keys-dialog') === null;`,
        );
        await chord(browser, left, '/', 'Slash', 191, CTRL);
        await run(left, click('.call-keys-dialog [data-choice=all]'));
        await waitFor(
          browser,
          left,
          `return app.settings.isOpen && app.settings.section === 'shortcuts' &&
          app.callStage.mode === 'mini' &&
          document.querySelector('.call-keys-dialog') === null;`,
        );
        await run(left, 'app.callStage.expand(); return true;');
        await waitFor(
          browser,
          left,
          `return app.callStage.mode === 'call' && !app.settings.isOpen;`,
        );
      },
    );

    await t.test('Settings… collapses the call; the mini tile', async () => {
      await run(left, pick('[data-action=settings]'));
      await waitFor(
        browser,
        left,
        `return app.settings.isOpen && app.settings.section === 'media' &&
          app.callStage.mode === 'mini' &&
          document.querySelector('#mini-call') !== null;`,
      );
      const mini = await run(
        left,
        `const root = document.querySelector('#mini-call');
        const buttons = [...root.querySelectorAll('.call-icon')];
        return {
          actions: buttons.map((node) => node.dataset.action),
          names: buttons.map((node) => node.getAttribute('aria-label')),
          titles: buttons.map((node) => node.title),
          text: buttons.map((node) => node.textContent),
          icons: buttons.map((node) => node.querySelector('svg')
            .dataset.icon),
        };`,
      );
      assert.deepEqual(mini.actions, ['mic', 'camera', 'leave', 'expand']);
      assert.deepEqual(mini.names, [
        'Microphone',
        'Camera',
        'Leave call',
        'Expand the call',
      ]);
      assert.match(mini.titles[0], /Ctrl D/);
      assert.match(mini.titles[1], /Ctrl E/);
      assert.deepEqual(mini.text, ['', '', '', '']);
      assert.deepEqual(mini.icons, ['mic', 'camera', 'leave', 'expand']);
      await run(left, click('#mini-call [data-action=mic]'));
      await waitFor(
        browser,
        left,
        `const button = document.querySelector(
          '#mini-call [data-action=mic]');
        return app.callStage.media.micOn === false &&
          button.getAttribute('aria-pressed') === 'false' &&
          button.classList.contains('off') &&
          button.querySelector('svg').dataset.icon === 'mic-off';`,
      );
      await run(left, click('#mini-call [data-action=mic]'));
      await waitFor(
        browser,
        left,
        `const button = document.querySelector(
          '#mini-call [data-action=mic]');
        return app.callStage.media.micOn === true &&
          button.querySelector('svg').dataset.icon === 'mic';`,
      );
      await run(left, click('#mini-call [data-action=leave]'));
      const leaving = await run(
        left,
        `const dialog = document.querySelector('.call-leave-dialog');
        return [dialog?.open, app.callSession?.phase];`,
      );
      assert.deepEqual(leaving, [true, 'joined']);
      await run(left, click('.call-leave-dialog [data-choice=cancel]'));
      await run(left, click('#mini-call [data-action=expand]'));
      await waitFor(
        browser,
        left,
        `return app.callStage.mode === 'call' && !app.settings.isOpen &&
          document.querySelector('#mini-call') === null;`,
      );
    });

    await t.test(
      'picture-in-picture: icons and the react menu',
      async (sub) => {
        const api = await run(
          left,
          'return typeof globalThis.documentPictureInPicture;',
        );
        if (api === 'undefined') {
          return void sub.skip('documentPictureInPicture is missing');
        }
        const opened = await gesture(
          browser,
          left,
          `await app.callStage.openPip();
        return app.callStage.pip !== null;`,
        );
        assert.equal(opened, true);
        const inPip = (body) =>
          run(
            left,
            `const root = app.callStage.pip.root;
          const doc = root.ownerDocument;
          ${body}`,
          );
        const controls = await inPip(
          `const buttons = [...root.querySelectorAll('.call-icon')];
        return {
          actions: buttons.map((node) => node.dataset.action),
          names: buttons.map((node) => node.getAttribute('aria-label')),
          text: buttons.map((node) => node.textContent).join(''),
          carets: root.querySelectorAll('.call-caret').length,
          other: doc !== document,
        };`,
        );
        assert.deepEqual(controls.actions, [
          'pip-back',
          'mic',
          'camera',
          'reactions',
          'leave',
        ]);
        assert.ok(controls.names.every((name) => name));
        assert.equal(controls.text, '');
        assert.equal(controls.carets, 0);
        assert.equal(controls.other, true);
        await inPip(
          `root.querySelector('[data-action=reactions]').click();
        return true;`,
        );
        const menu = await inPip(
          `const menus = doc.querySelectorAll('.pip-menu');
        const menu = menus[0];
        return {
          here: document.querySelectorAll('.pip-menu').length,
          there: menus.length,
          shown: !menu.classList.contains('hidden'),
          reactions: menu.querySelectorAll('[data-action=react]').length,
          hand: menu.querySelector('[data-action=hand]')
            .getAttribute('role'),
          expanded: root.querySelector('[data-action=reactions]')
            .getAttribute('aria-expanded'),
        };`,
        );
        assert.deepEqual(menu, {
          here: 0,
          there: 1,
          shown: true,
          reactions: 6,
          hand: 'menuitemcheckbox',
          expanded: 'true',
        });
        await inPip(
          `doc.dispatchEvent(new KeyboardEvent('keydown', {
          key: 'Escape', code: 'Escape', bubbles: true }));
        return true;`,
        );
        await waitFor(
          browser,
          left,
          `const root = app.callStage.pip.root;
        const menu = root.ownerDocument.querySelector('.pip-menu');
        return menu.classList.contains('hidden') &&
          root.querySelector('[data-action=reactions]')
            .getAttribute('aria-expanded') === 'false';`,
        );
        await inPip(
          `root.querySelector('[data-action=pip-back]').click();
        return true;`,
        );
        await waitFor(
          browser,
          left,
          `return app.callStage.pip === null && app.callStage.mode === 'call';`,
        );
      },
    );

    await t.test('people and chat toggle their panels', async () => {
      const people = await run(
        left,
        `const button = document.querySelector('${BAR} [data-action=people]');
        const badge = button.querySelector('.call-badge').textContent;
        const before = button.getAttribute('aria-pressed');
        button.click();
        const panel = document.querySelector('.call-people');
        return [badge, before, button.getAttribute('aria-pressed'),
          getComputedStyle(panel).display];`,
      );
      assert.deepEqual(people, ['2', 'true', 'false', 'none']);
      await run(left, click(`${BAR} [data-action=people]`));
      await run(left, click(`${BAR} [data-action=chat]`));
      assert.equal(
        await run(
          left,
          `return document.querySelector('${BAR} [data-action=chat]')
            .getAttribute('aria-pressed');`,
        ),
        'false',
      );
      await run(left, click(`${BAR} [data-action=chat]`));
    });

    await t.test('phone: one row, the rest inside more, sheets', async () => {
      const send = (method, params = {}) =>
        browser.request(method, params, left);
      await send('Emulation.setDeviceMetricsOverride', {
        ...PHONE_SIZE,
        mobile: true,
      });
      await send('Emulation.setTouchEmulationEnabled', { enabled: true });
      await waitFor(
        browser,
        left,
        `return app.callStage.phone.matches &&
          document.querySelector('${BAR} .call-share')
            .classList.contains('hidden');`,
      );
      const bar = await run(
        left,
        `const root = document.querySelector('${BAR}');
        const all = [...root.querySelectorAll('button')];
        const seen = all.filter((node) => node.getClientRects().length > 0);
        const tops = seen.map((node) => node.getBoundingClientRect().top);
        const caret = root.querySelector('[data-action=mic-menu]')
          .getBoundingClientRect();
        return {
          actions: seen.map((node) => node.dataset.action),
          named: all.every((node) => node.getAttribute('aria-label')),
          labels: [...root.querySelectorAll('.call-label')].every(
            (node) => getComputedStyle(node).display === 'none'),
          oneRow: Math.max(...tops) - Math.min(...tops) < 4,
          fits: Math.max(...seen.map(
            (node) => node.getBoundingClientRect().right)) <=
            window.innerWidth,
          caret: [caret.width, caret.height],
          stops: root.querySelectorAll('button[tabindex="0"]').length,
        };`,
      );
      assert.deepEqual(bar.actions, [
        'mic',
        'mic-menu',
        'camera',
        'camera-menu',
        'reactions',
        'more',
        'leave',
      ]);
      assert.equal(bar.named, true);
      assert.equal(bar.labels, true);
      assert.equal(bar.oneRow, true);
      assert.equal(bar.fits, true);
      assert.ok(bar.caret[0] >= 44 && bar.caret[1] >= 44);
      assert.equal(bar.stops, 1);
      await run(
        left,
        `app.unread.set(app.callStage.chat, 2);
        app.callStage.paintCounts();
        return true;`,
      );
      const badge = await run(
        left,
        `const more = document.querySelector('${MORE}');
        return [more.querySelector('.call-badge').textContent,
          more.getAttribute('aria-label')];`,
      );
      assert.deepEqual(badge, ['2', 'More options, 2 new']);
      await run(left, click(MORE));
      const unread = await run(
        left,
        `return document.querySelector('${MENU} [data-action=chat]')
          .textContent;`,
      );
      assert.equal(unread, 'Chat · 2 unread');
      await run(left, 'history.back(); return true;');
      await run(
        left,
        `app.unread.delete(app.callStage.chat);
        app.callStage.paintCounts();
        return true;`,
      );
      await delay(300);
      await run(left, click(MORE));
      const sheet = await run(
        left,
        `const root = document.querySelector('${MENU}');
        const groups = [...root.querySelectorAll('[role=group]')];
        const text = (node) => [...node.querySelectorAll('.menu-item')]
          .map((item) => item.textContent);
        return {
          sheet: root.classList.contains('sheet'),
          backdrop: !document.getElementById('backdrop')
            .classList.contains('hidden'),
          headings: groups.map((node) => node.firstElementChild
            .textContent),
          first: text(groups[0]),
          layouts: root.querySelectorAll('[data-action=layout-choice]').length,
        };`,
      );
      assert.equal(sheet.sheet, true);
      assert.equal(sheet.backdrop, true);
      assert.deepEqual(sheet.headings, [
        'Call',
        'View',
        'Recording and studio',
        'Settings',
      ]);
      assert.deepEqual(sheet.first, [
        'Share screen',
        'Record',
        'People · 2',
        'Chat',
        'Copy call link',
      ]);
      assert.equal(sheet.layouts, 0);
      await run(left, 'history.back(); return true;');
      const closed = `return document.querySelector('${MENU}')
        .classList.contains('hidden') && app.callStage.mode === 'call' &&
        app.callSession.phase === 'joined' &&
        document.getElementById('backdrop').classList.contains('hidden');`;
      await waitFor(browser, left, closed);
      for (const action of ['reactions', 'mic-menu', 'camera-menu']) {
        await run(left, click(`${BAR} [data-action=${action}]`));
        const isSheet = await run(
          left,
          `return document.querySelector('${MENU}').classList
            .contains('sheet');`,
        );
        assert.equal(isSheet, true);
        await run(left, 'history.back(); return true;');
        await waitFor(browser, left, closed);
      }
      await run(left, pick('[data-action=people]'));
      await waitFor(
        browser,
        left,
        `return app.callStage.sheet === 'people' &&
          app.callStage.mode === 'call';`,
      );
      await run(left, 'history.back(); return true;');
      await waitFor(
        browser,
        left,
        `return !app.callStage.sheet && app.callStage.mode === 'call' &&
          app.callSession.phase === 'joined';`,
      );
      await run(left, pick('[data-action=shortcuts]'));
      await waitFor(
        browser,
        left,
        `return document.querySelector('.call-keys-dialog')?.open === true;`,
      );
      await delay(500);
      assert.equal(
        await run(
          left,
          `return document.querySelector('.call-keys-dialog')?.open;`,
        ),
        true,
      );
      await run(left, 'history.back(); return true;');
      await waitFor(
        browser,
        left,
        `return document.querySelector('.call-keys-dialog') === null &&
          app.callStage.mode === 'call' &&
          app.callSession.phase === 'joined';`,
      );
      await delay(1500);
      await run(left, pick('[data-action=record]'));
      await waitFor(
        browser,
        left,
        `return app.callStage.recording.recorder?.state === 'recording';`,
      );
      await delay(1200);
      const asked = await run(left, 'return window.asked.length;');
      await run(left, openMore);
      const label = await run(
        left,
        `return document.querySelector('${MENU} [data-action=record]')
          .textContent;`,
      );
      assert.match(label, /^● Recording \d\d:\d\d$/);
      await run(left, 'window.answer = true; return true;');
      await run(left, pick('[data-action=record]'));
      await waitFor(
        browser,
        left,
        `return app.callStage.recording.isActive === false;`,
        30000,
      );
      const after = await run(left, 'return window.asked;');
      assert.equal(after.length, asked + 1);
      assert.equal(after.at(-1), 'Stop the recording?');
      await gesture(browser, left, pick('[data-action=share]'));
      await waitFor(browser, left, 'return app.callStage.media.screenShared;');
      const stop = await run(
        left,
        `${openMore}
        return document.querySelector('${MENU} [data-action=share]')
          .textContent;`,
      );
      assert.equal(stop, 'Stop sharing');
      await run(
        left,
        `document.querySelector('${MENU} [data-action=share]').click();
        return true;`,
      );
      await waitFor(browser, left, 'return !app.callStage.media.screenTrack;');
      await send('Emulation.clearDeviceMetricsOverride');
      await send('Emulation.setTouchEmulationEnabled', { enabled: false });
      await waitFor(
        browser,
        left,
        `return !app.callStage.phone.matches &&
          !document.querySelector('${BAR} .call-share')
            .classList.contains('hidden');`,
      );
    });

    await t.test('everyone gets the roster menu', async () => {
      await waitFor(
        browser,
        right,
        `return document.querySelectorAll(
          '.call-roster [data-action=roster-menu]').length === 2;`,
      );
      await run(
        right,
        `const row = [...document.querySelectorAll('.call-roster li')]
          .find((item) => item.dataset.endpoint !== app.callSession.endpoint);
        row.querySelector('[data-action=roster-menu]').click();
        return true;`,
      );
      const items = await run(
        right,
        `return [...document.querySelectorAll(
          '.call-tile-menu [data-action]')].map((item) =>
          item.dataset.action);`,
      );
      assert.ok(items.includes('pin'));
      assert.ok(!items.includes('remove'));
      await run(right, 'app.callStage.tileMenu.close(); return true;');
    });

    await t.test('leave: a dialog for admins, at once for others', async () => {
      await run(left, click(`${BAR} [data-action=leave]`));
      const dialog = await run(
        left,
        `const dialog = document.querySelector('.call-leave-dialog');
        return {
          open: dialog.open,
          title: dialog.querySelector('.call-leave-title').textContent,
          focus: document.activeElement.textContent,
          buttons: [...dialog.querySelectorAll('button')].map((item) =>
            item.textContent),
        };`,
      );
      assert.equal(dialog.open, true);
      assert.equal(dialog.title, 'Leave the call?');
      assert.equal(dialog.focus, 'leave');
      assert.deepEqual(dialog.buttons, ['leave', 'end for everyone', 'cancel']);
      await run(left, click('.call-leave-dialog [data-choice=cancel]'));
      await waitFor(
        browser,
        left,
        `return document.querySelector('.call-leave-dialog') === null &&
          app.callSession?.phase === 'joined';`,
      );
      await run(left, click(`${BAR} [data-action=leave]`));
      await browser.request(
        'Input.dispatchKeyEvent',
        {
          type: 'rawKeyDown',
          key: 'Escape',
          code: 'Escape',
          windowsVirtualKeyCode: 27,
        },
        left,
      );
      await browser.request(
        'Input.dispatchKeyEvent',
        { type: 'keyUp', key: 'Escape', code: 'Escape' },
        left,
      );
      await waitFor(
        browser,
        left,
        `return document.querySelector('.call-leave-dialog') === null &&
          app.callSession?.phase === 'joined';`,
      );

      await run(right, click(`${BAR} [data-action=leave]`));
      await waitFor(
        browser,
        right,
        `return !app.callSession && !document.getElementById('call-view');`,
      );
      await waitFor(browser, left, 'return app.callStage.people.length === 1;');

      await run(left, click(`${BAR} [data-action=leave]`));
      await run(left, click('.call-leave-dialog [data-choice=end]'));
      await waitFor(
        browser,
        left,
        `return !app.callSession && !document.getElementById('call-view');`,
      );
    });
    assert.deepEqual(browser.errors, []);
  },
);
