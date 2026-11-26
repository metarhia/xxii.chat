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
const MAX_ZONES = 3;

const HELPERS = `
  const shown = (element) => {
    const box = element.getBoundingClientRect();
    return element.checkVisibility() && box.width > 0 && box.height > 0 &&
      box.right > 0 && box.left < innerWidth;
  };
  const all = (list) => list
    .flatMap((selector) => [...document.querySelectorAll(selector)])
    .filter(shown);
  const rectOf = (element) => {
    const box = element.getBoundingClientRect();
    return { left: box.left, right: box.right, top: box.top,
      bottom: box.bottom, height: box.height };
  };
  const backgroundOf = (element) => {
    for (let node = element; node; node = node.parentElement) {
      const color = getComputedStyle(node).backgroundColor;
      if (!/rgba\\(.*, 0\\)|transparent/.test(color)) return color;
    }
    return '';
  };
  const ZONES = ['#sidebar', '#chat-view', '#settings-view',
    '#recordings-view', '#panel', '.call-stage', '#call-view', '.call-side'];
  const BARS = ['.profile-row', '#composer', '.call-controls', '.panel-bar',
    '.call-side .side-bar', '.settings-bar'];
  const PANELS = ['.panel-body', '.side-body', '.timeline', '.call-grid',
    '.settings-content', '.settings-list', '.recordings-body',
    '.sidebar .section'];
  const barHeight = () => parseFloat(
    getComputedStyle(document.documentElement).getPropertyValue(
      '--bar-height'));
  const bars = () => all(BARS);
  const zonesOf = () => {
    const nodes = all(ZONES);
    const leaves = nodes.filter(
      (node) => !nodes.some((other) => other !== node && node.contains(other)));
    const boxes = leaves.map(rectOf).sort((a, b) => a.left - b.left);
    const overlap = boxes.some((box, index) =>
      index > 0 && box.left < boxes[index - 1].right - 1);
    return { count: leaves.length, overlap };
  };
  const overlaps = () => {
    const found = [];
    const barBoxes = bars().map((bar) => [bar, rectOf(bar)]);
    for (const panel of all(PANELS)) {
      const box = rectOf(panel);
      for (const [bar, other] of barBoxes) {
        if (panel.contains(bar) || bar.contains(panel)) continue;
        const width = Math.min(box.right, other.right) -
          Math.max(box.left, other.left);
        const height = Math.min(box.bottom, other.bottom) -
          Math.max(box.top, other.top);
        if (width > 1 && height > 1) {
          found.push([panel.className, bar.className]);
        }
      }
    }
    return found;
  };
  const measure = () => ({
    zones: zonesOf(),
    barHeight: barHeight(),
    viewport: innerHeight,
    bars: bars().map((bar) => ({
      name: bar.className || bar.id,
      top: rectOf(bar).top,
      height: rectOf(bar).height,
      background: backgroundOf(bar),
    })),
    overlaps: overlaps(),
  });
`;

const near = (actual, expected, message) =>
  assert.ok(Math.abs(actual - expected) <= 1, `${message}: ${actual}`);

const checkAligned = (state, label) => {
  const { zones, bars, barHeight, viewport, overlaps } = state;
  assert.ok(zones.count <= MAX_ZONES, `${label}: ${zones.count} zones`);
  assert.equal(zones.overlap, false, `${label}: zones overlap`);
  assert.ok(bars.length > 0, `${label}: no bottom bar`);
  for (const bar of bars) {
    near(bar.height, barHeight, `${label}: ${bar.name} height`);
    near(bar.top, viewport - barHeight, `${label}: ${bar.name} top`);
  }
  assert.deepEqual(overlaps, [], `${label}: panels under a bar`);
};

test('layout zones and bottom bars', { timeout: 280000 }, async (t) => {
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
  const measure = (session) =>
    run(
      session,
      `${HELPERS} await new Promise((r) => setTimeout(r, 300));
      return measure();`,
    );
  const theme = (session, name) =>
    run(
      session,
      `document.documentElement.dataset.theme = '${name}';
      await new Promise((r) => setTimeout(r, 100));
      return true;`,
    );
  const click = (session, selector) =>
    run(
      session,
      `document.querySelector(${JSON.stringify(selector)}).click();
      return true;`,
    );
  const backgrounds = (state) => state.bars.map((bar) => bar.background);

  const first = await open(DESKTOP);
  await run(first, `app.selectChat('general'); return true;`);
  await run(
    first,
    `app.writeMessage(app.chat, 'a pinned line', undefined, []);
    return true;`,
  );
  await wait(
    first,
    `app.render();
    return app.messageList.querySelectorAll('.message').length >= 1;`,
  );
  await run(
    first,
    `app.togglePin(app.messageList.querySelector('.message').dataset.id);
    return true;`,
  );

  await t.test('chat: three bars share one top edge and height', async () => {
    const state = await measure(first);
    checkAligned(state, 'chat');
    assert.equal(state.zones.count, 2);
    assert.deepEqual(state.bars.map((bar) => bar.name.split(' ')[0]).sort(), [
      'composer',
      'profile-row',
    ]);
    assert.ok(state.barHeight >= 60 && state.barHeight <= 80);
  });

  await t.test('chat with pins: the right panel has a bar', async () => {
    await run(first, `app.showPanel('pins'); return true;`);
    const state = await measure(first);
    checkAligned(state, 'pins');
    assert.equal(state.zones.count, 3);
    assert.equal(state.bars.length, 3);
    assert.equal(
      await run(
        first,
        `const bar = document.querySelector('#panel .panel-bar');
        const close = document.getElementById('panel-close-btn');
        const body = document.querySelector('.panel-body[data-panel=pins]');
        return [bar.contains(close),
          body.getBoundingClientRect().bottom <=
            bar.getBoundingClientRect().top + 1,
          document.querySelector('.panel-header').contains(close)].join();`,
      ),
      'true,true,false',
    );
    assert.equal(new Set(backgrounds(state)).size, 3);
  });

  await t.test('the composer grows upward, the other bars stay', async () => {
    const before = await measure(first);
    await run(
      first,
      `const input = document.getElementById('message-input');
      input.focus();
      input.value = 'one\\ntwo\\nthree';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      return true;`,
    );
    const after = await measure(first);
    const find = (state, name) =>
      state.bars.find((bar) => bar.name.startsWith(name));
    const grown = find(after, 'composer');
    const normal = find(before, 'composer');
    assert.ok(grown.height > normal.height + 10, `${grown.height}`);
    near(grown.top + grown.height, normal.top + normal.height, 'bottom edge');
    for (const name of ['profile-row', 'panel-bar']) {
      const was = find(before, name);
      const now = find(after, name);
      near(now.top, was.top, `${name} top`);
      near(now.height, was.height, `${name} height`);
    }
    assert.deepEqual(after.overlaps, []);
    await run(
      first,
      `const input = document.getElementById('message-input');
      input.value = '';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      app.hidePanel(false);
      return true;`,
    );
  });

  await t.test('settings: two zones, two bars', async () => {
    await run(first, `app.openSettings('profile'); return true;`);
    await wait(first, 'return app.settings.isOpen;');
    const state = await measure(first);
    checkAligned(state, 'settings');
    assert.equal(state.zones.count, 2);
    assert.deepEqual(
      state.bars.map((bar) => bar.name),
      ['profile-row', 'settings-bar'],
    );
    assert.equal(new Set(state.bars.map((bar) => bar.background)).size, 2);
    await run(first, 'app.closeSettings(); return true;');
  });

  await t.test('recordings with the capture panel', async () => {
    await run(first, `app.openLibrary(); return true;`);
    await wait(first, 'return app.recordingsView.isOpen;');
    checkAligned(await measure(first), 'recordings');
    await run(first, `app.openCapture(null); return true;`);
    await wait(first, `return app.panel === 'capture' && app.capture;`);
    const state = await measure(first);
    checkAligned(state, 'recordings with capture');
    assert.equal(state.zones.count, 3);
    assert.equal(
      state.bars.some((bar) => bar.name.startsWith('panel-bar')),
      true,
    );
    await click(first, '#panel-close-btn');
    await wait(first, `return app.panel === '';`);
    await run(first, 'app.closeRecordings(); return true;');
  });

  await t.test('the three bars differ in dark and light', async () => {
    await run(first, `app.showPanel('pins'); return true;`);
    for (const name of ['dark', 'light']) {
      await theme(first, name);
      const state = await measure(first);
      assert.equal(new Set(backgrounds(state)).size, 3, name);
    }
    await theme(first, 'dark');
    await run(first, `app.hidePanel(false); return true;`);
  });

  await t.test('pre-join keeps two zones and the profile bar', async () => {
    await run(
      first,
      `app.selectChat('general');
      await app.startCall('general');
      return true;`,
    );
    await wait(first, `return app.callStage?.mode === 'prejoin';`);
    const state = await measure(first);
    assert.ok(state.zones.count <= MAX_ZONES);
    assert.equal(state.zones.overlap, false);
    assert.ok(state.bars.some((bar) => bar.name.startsWith('profile-row')));
    near(
      state.bars[0].height,
      state.barHeight,
      `prejoin ${state.bars[0].name}`,
    );
  });

  await t.test('call: every right tab keeps the bars aligned', async () => {
    await click(first, '#prejoin [data-action=join]');
    await wait(first, `return app.callStage?.mode === 'call';`);
    const tabs = ['chat', 'people', 'record', 'studio'];
    for (const tab of tabs) {
      await run(first, `app.callStage.selectTab('${tab}'); return true;`);
      await wait(first, `return app.callStage.shownTab === '${tab}';`);
      const state = await measure(first);
      checkAligned(state, `call ${tab}`);
      assert.equal(state.zones.count, 3, tab);
      const names = state.bars.map((bar) => bar.name.split(' ')[0]).sort();
      const expected = tab === 'chat' ? 'composer' : 'side-bar';
      const want = ['call-controls', expected, 'profile-row'].sort();
      assert.deepEqual(names, want, tab);
      assert.equal(new Set(backgrounds(state)).size, 3, tab);
    }
    await run(first, `app.callStage.closeSide(); return true;`);
    const closed = await measure(first);
    checkAligned(closed, 'call closed');
    assert.equal(closed.zones.count, 2);
  });

  await t.test('the call bars differ in dark and light', async () => {
    await run(first, `app.callStage.selectTab('people'); return true;`);
    for (const name of ['dark', 'light']) {
      await theme(first, name);
      const state = await measure(first);
      assert.equal(new Set(backgrounds(state)).size, 3, name);
    }
    await theme(first, 'dark');
  });

  await t.test('the call composer grows, the bars stay', async () => {
    await run(first, `app.callStage.selectTab('chat'); return true;`);
    const before = await measure(first);
    await run(
      first,
      `const input = document.getElementById('message-input');
      input.value = 'one\\ntwo\\nthree';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      return true;`,
    );
    const after = await measure(first);
    const find = (state, name) =>
      state.bars.find((bar) => bar.name.startsWith(name));
    assert.ok(
      find(after, 'composer').height > find(before, 'composer').height + 10,
    );
    for (const name of ['profile-row', 'call-controls']) {
      near(find(after, name).top, find(before, name).top, `${name} top`);
      near(find(after, name).height, find(before, name).height, name);
    }
    await run(
      first,
      `const input = document.getElementById('message-input');
      input.value = '';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      return true;`,
    );
  });

  await t.test('the last tab is remembered for the call', async () => {
    await run(first, `app.callStage.selectTab('record'); return true;`);
    await run(first, `app.callStage.closeSide(); return true;`);
    await run(first, `app.callStage.selectTab('people'); return true;`);
    await run(first, `app.callStage.collapse(); return true;`);
    await wait(first, `return app.callStage.mode === 'mini';`);
    assert.equal(
      await run(
        first,
        `return [document.querySelector('.call-side'),
          document.querySelector('.call-stage > #chat-view'),
          document.getElementById('chat-view').parentElement.className]
          .map(String).join();`,
      ),
      'null,null,app',
    );
    await run(first, `app.callStage.expand(); return true;`);
    await wait(first, `return app.callStage.mode === 'call';`);
    assert.equal(await run(first, `return app.callStage.shownTab;`), 'people');
    assert.equal(
      await run(first, `return document.querySelector('.app').dataset.side;`),
      'people',
    );
    await run(first, `app.callStage.selectTab('chat'); return true;`);
  });

  await t.test('the composer placeholder has no prompt sign', async () => {
    assert.equal(
      await run(
        first,
        `return document.getElementById('message-input').placeholder;`,
      ),
      'new message to !general',
    );
  });

  await t.test('phone: one zone, bars follow the composer', async () => {
    const token = await run(first, `return app.callToken;`);
    const phone = await open(PHONE);
    await run(phone, `app.selectChat('general'); return true;`);
    const state = await measure(phone);
    assert.equal(state.zones.count, 1);
    const composer = state.bars.find((bar) => bar.name.startsWith('composer'));
    near(composer.height, state.barHeight, 'phone composer');
    near(composer.top, state.viewport - state.barHeight, 'phone composer top');
    await run(
      phone,
      `await app.startCall('general', { token: ${JSON.stringify(token)} });
      return true;`,
    );
    await wait(phone, `return app.callStage?.mode === 'prejoin';`);
    await click(phone, '#prejoin [data-action=join]');
    await wait(phone, `return app.callStage?.mode === 'call';`);
    await delay(300);
    await run(phone, `app.callStage.selectTab('people'); return true;`);
    await wait(phone, `return app.callStage.sheet === 'people';`);
    const sheet = await run(
      phone,
      `${HELPERS}
      const side = document.querySelector('.call-side');
      const tabs = document.querySelector('.call-tabs');
      const bar = document.querySelector('.call-people .side-bar');
      return {
        side: rectOf(side),
        tabs: rectOf(tabs),
        bar: rectOf(bar),
        height: innerHeight,
        barHeight: barHeight(),
        focus: document.activeElement.className,
      };`,
    );
    near(sheet.side.bottom, sheet.height, 'sheet bottom');
    near(sheet.tabs.top, sheet.side.top, 'tabs at the sheet top');
    near(sheet.bar.height, sheet.barHeight, 'sheet bar height');
    assert.equal(sheet.focus, 'call-tabs-close');
    await run(phone, `app.callStage.selectTab('chat'); return true;`);
    await wait(phone, `return app.callStage.sheet === 'chat';`);
    const chat = await measure(phone);
    const composer2 = chat.bars.find((bar) => bar.name.startsWith('composer'));
    near(composer2.height, chat.barHeight, 'sheet composer');
  });

  assert.deepEqual(browser.errors, []);
});
