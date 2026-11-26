'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { setTimeout: delay } = require('node:timers/promises');

const harness = require('./harness.js');

const { MEDIA_FLAGS, ORIGIN, launch, startCallServer } = harness;

const DESKTOP = { width: 1000, height: 700, mobile: false };
const PHONE = { width: 390, height: 844, mobile: true };
const READY = 'return app.connected && app.mesh.peers.has(app.peerId);';
const JOINED = `return app.callStage?.mode === 'call';`;

const KEYS = {
  ArrowDown: { key: 'ArrowDown', code: 'ArrowDown', vk: 40 },
  ArrowUp: { key: 'ArrowUp', code: 'ArrowUp', vk: 38 },
  ArrowLeft: { key: 'ArrowLeft', code: 'ArrowLeft', vk: 37 },
  ArrowRight: { key: 'ArrowRight', code: 'ArrowRight', vk: 39 },
  Home: { key: 'Home', code: 'Home', vk: 36 },
  End: { key: 'End', code: 'End', vk: 35 },
  Enter: { key: 'Enter', code: 'Enter', vk: 13, text: '\r' },
  Escape: { key: 'Escape', code: 'Escape', vk: 27 },
  Tab: { key: 'Tab', code: 'Tab', vk: 9 },
  Space: { key: ' ', code: 'Space', vk: 32, text: ' ' },
};

const FIXTURE = `
  const { Menu, dismissMenu } = await import('/overlays.js');
  const style = document.createElement('style');
  style.textContent = \`
    .probe { position: fixed; z-index: 5; width: 40px; height: 24px; }
    #t-bottom { left: 120px; bottom: 6px; }
    #t-top { left: 220px; top: 6px; }
    #t-left { left: 0; top: 300px; }
    #t-right { right: 0; top: 300px; }
    #box { position: fixed; z-index: 5; left: 420px; top: 200px;
      width: 160px; height: 120px; overflow: auto; background: #222; }
    #box button { margin-top: 20px; }
    #far { height: 600px; }
    #side { position: fixed; z-index: 5; left: 620px; top: 200px;
      width: 120px; height: 120px; overflow: auto; background: #333; }
    #side div { height: 600px; }
  \`;
  document.head.append(style);
  const create = (tag, id, text = '') => {
    const node = document.createElement(tag);
    node.id = id;
    node.textContent = text;
    document.body.append(node);
    return node;
  };
  for (const id of ['t-bottom', 't-top', 't-left', 't-right']) {
    create('button', id, 'x').className = 'probe';
  }
  const box = create('div', 'box');
  const inner = document.createElement('button');
  inner.id = 't-box';
  inner.textContent = 'y';
  const far = document.createElement('div');
  far.id = 'far';
  box.append(inner, far);
  const side = create('div', 'side');
  side.append(document.createElement('div'));
  const probe = { Menu, dismissMenu, events: [], menus: {} };
  const actions = (count) => Array.from({ length: count }, (_, i) => ({
    action: 'item-' + i,
    label: 'Entry ' + i,
  }));
  probe.items = (isRadio) => [
    { action: 'one', label: 'Alpha' },
    { action: 'two', label: 'Bravo', disabled: true, reason: 'Not now' },
    { action: 'three', label: 'Charlie' },
    { kind: 'separator' },
    { kind: 'checkbox', action: 'check', label: 'Delta', checked: false },
    { kind: 'group', label: 'Mode', items: [
      { kind: 'radio', group: 'mode', action: 'mode-a', label: 'Auto',
        checked: isRadio },
      { kind: 'radio', group: 'mode', action: 'mode-b', label: 'Grid' },
    ] },
    { kind: 'group', label: 'Layout', row: true, items: [
      { kind: 'radio', group: 'layout', action: 'tiles', label: 'Tiles' },
      { kind: 'radio', group: 'layout', action: 'rows', label: 'Rows' },
      { kind: 'radio', group: 'layout', action: 'stage', label: 'Stage' },
    ] },
    { action: 'last', label: 'Echo' },
  ];
  probe.make = (name, options = {}, doc = document) => {
    const element = doc.createElement('div');
    element.className = 'menu hidden';
    element.id = 'menu-' + name;
    doc.body.append(element);
    probe.menus[name] = { menu: new Menu(element, options), element };
  };
  probe.open = (name, id, extra = {}) => {
    const entry = probe.menus[name];
    const trigger = entry.element.ownerDocument.getElementById(id);
    const log = (text) => probe.events.push(name + ':' + text);
    const items = extra.items ?? probe.items(extra.radio === true);
    entry.menu.open({
      items,
      anchor: trigger,
      placement: extra.placement,
      keyboard: extra.keyboard,
      label: 'Probe menu',
      select: (item) => log('select:' + item.action + ':' + item.checked),
      close: (reason) => log('close:' + reason),
    });
  };
  probe.rect = (name) => {
    const { left, top, right, bottom, width, height } =
      probe.menus[name].element.getBoundingClientRect();
    return { left, top, right, bottom, width, height };
  };
  probe.where = () => {
    const active = document.activeElement;
    const label = active.querySelector?.(':scope > .menu-text .menu-label')
      ?? active.querySelector?.('.menu-label');
    if (active.classList.contains('menu')) return 'menu';
    return active.id || label?.textContent || active.tagName;
  };
  probe.actions = actions;
  window.probe = probe;
  return true;
`;

const keyParams = (type, name) => {
  const info = KEYS[name] ?? name;
  const params = {
    type,
    key: info.key,
    code: info.code,
    windowsVirtualKeyCode: info.vk,
  };
  if (info.text && type === 'keyDown') params.text = info.text;
  return params;
};

const letterKey = (character) => {
  const upper = character.toUpperCase();
  const code = `Key${upper}`;
  return { key: character, code, vk: upper.charCodeAt(0), text: character };
};

const openPage = async (t, browser, viewport = DESKTOP) => {
  const created = await browser.request('Target.createBrowserContext');
  const { browserContextId } = created;
  t.after(() =>
    browser
      .request('Target.disposeBrowserContext', { browserContextId })
      .catch(() => undefined),
  );
  const target = { url: `${ORIGIN}/`, browserContextId };
  const { targetId } = await browser.request('Target.createTarget', target);
  const attach = { targetId, flatten: true };
  const { sessionId } = await browser.request('Target.attachToTarget', attach);
  const send = (method, params = {}) =>
    browser.request(method, params, sessionId);
  await send('Runtime.enable');
  await send('Page.enable');
  await send('Page.bringToFront');
  await send('Emulation.setFocusEmulationEnabled', { enabled: true });
  const run = (body) => harness.run(browser, sessionId, body);
  const wait = (body) => harness.wait(browser, sessionId, body);
  const size = { deviceScaleFactor: 1, ...viewport };
  await send('Emulation.setDeviceMetricsOverride', size);
  await wait(READY);
  return { send, run, wait };
};

const viewportOf = async (page, viewport) => {
  const size = { deviceScaleFactor: 1, ...viewport };
  await page.send('Emulation.setDeviceMetricsOverride', size);
  const touch = { enabled: viewport.mobile };
  await page.send('Emulation.setTouchEmulationEnabled', touch);
  await delay(150);
};

const press = async (page, name) => {
  await page.send('Input.dispatchKeyEvent', keyParams('keyDown', name));
  await page.send('Input.dispatchKeyEvent', keyParams('keyUp', name));
};

const mouse = async (page, x, y) => {
  const point = { x, y, button: 'left', clickCount: 1 };
  await page.send('Input.dispatchMouseEvent', { ...point, type: 'mouseMoved' });
  const pressed = { ...point, type: 'mousePressed', buttons: 1 };
  await page.send('Input.dispatchMouseEvent', pressed);
  const released = { ...point, type: 'mouseReleased', buttons: 0 };
  await page.send('Input.dispatchMouseEvent', released);
};

const centerOf = (page, selector) =>
  page.run(
    `const rect = document.querySelector(${JSON.stringify(selector)})
      .getBoundingClientRect();
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };`,
  );

const clickOn = async (page, selector) => {
  const point = await centerOf(page, selector);
  await mouse(page, point.x, point.y);
};

const itemOf = (name, label) =>
  `[...probe.menus.${name}.element.querySelectorAll('.menu-item')]
    .find((node) => node.textContent.startsWith(${JSON.stringify(label)}))`;

const where = (page) => page.run('return probe.where();');

const isOpen = (page, name) =>
  page.run(`return probe.menus.${name}.menu.isOpen;`);

const eventsOf = (page) => page.run('return probe.events.splice(0);');

const openOn = (page, name, id, extra = {}) =>
  page.run(
    `probe.open(${JSON.stringify(name)}, ${JSON.stringify(id)},
      ${JSON.stringify(extra)}); return true;`,
  );

const rectOf = (page, name) => page.run(`return probe.rect('${name}');`);

const triggerRect = (page, id) =>
  page.run(
    `const { left, top, right, bottom } =
      document.getElementById('${id}').getBoundingClientRect();
    return { left, top, right, bottom };`,
  );

test('Anchored menus in Chrome', { timeout: 240000 }, async (t) => {
  await startCallServer(t);
  const browser = await launch(t);
  const page = await openPage(t, browser);
  await page.run(FIXTURE);
  await page.run(`probe.make('main'); probe.make('other'); return true;`);
  const { run, wait } = page;

  await t.test('anchored above a trigger at the bottom', async () => {
    await openOn(page, 'main', 't-bottom', { placement: 'top' });
    const menu = await rectOf(page, 'main');
    const trigger = await triggerRect(page, 't-bottom');
    assert.ok(menu.bottom <= trigger.top, `${menu.bottom} ${trigger.top}`);
    assert.ok(trigger.top - menu.bottom < 16);
    assert.equal(Math.round(menu.left), Math.round(trigger.left));
    const roles = await run(
      `const element = probe.menus.main.element;
      const trigger = document.getElementById('t-bottom');
      return {
        role: element.getAttribute('role'),
        label: element.getAttribute('aria-label'),
        expanded: trigger.getAttribute('aria-expanded'),
        controls: trigger.getAttribute('aria-controls') === element.id,
      };`,
    );
    assert.deepEqual(roles, {
      role: 'menu',
      label: 'Probe menu',
      expanded: 'true',
      controls: true,
    });
    await page.run(`probe.menus.main.menu.close(); return true;`);
    const closed = await run(
      `const trigger = document.getElementById('t-bottom');
      return [trigger.getAttribute('aria-expanded'),
        trigger.hasAttribute('aria-controls')];`,
    );
    assert.deepEqual(closed, ['false', false]);
    await openOn(page, 'main', 't-bottom', { placement: 'auto' });
    const auto = await rectOf(page, 'main');
    assert.ok(auto.bottom <= trigger.top, 'auto flips above at the bottom');
    await run(`probe.menus.main.menu.close(); return true;`);
  });

  await t.test('flipped below a trigger at the top', async () => {
    await openOn(page, 'main', 't-top', { placement: 'top' });
    const menu = await rectOf(page, 'main');
    const trigger = await triggerRect(page, 't-top');
    assert.ok(menu.top >= trigger.bottom, `${menu.top} ${trigger.bottom}`);
    assert.ok(menu.top - trigger.bottom < 16);
    await run(`probe.menus.main.menu.close(); return true;`);
  });

  await t.test('clamped at both sides of the viewport', async () => {
    await openOn(page, 'main', 't-left');
    const left = await rectOf(page, 'main');
    assert.equal(left.left, 8);
    await run(`probe.menus.main.menu.close(); return true;`);
    await openOn(page, 'main', 't-right');
    const right = await rectOf(page, 'main');
    assert.equal(Math.round(right.right), DESKTOP.width - 8);
    assert.ok(right.left >= 8);
    await run(`probe.menus.main.menu.close(); return true;`);
  });

  await t.test('a tall menu is limited and scrolls', async () => {
    const items = Array.from({ length: 40 }, (_, i) => ({
      action: `entry-${i}`,
      label: `Entry ${i}`,
    }));
    await openOn(page, 'main', 't-left', { items });
    const menu = await rectOf(page, 'main');
    assert.ok(menu.top >= 8);
    assert.ok(menu.bottom <= DESKTOP.height - 8);
    const scrolls = await run(
      `const element = probe.menus.main.element;
      return element.scrollHeight > element.clientHeight;`,
    );
    assert.equal(scrolls, true);
    await run(`probe.menus.main.menu.close(); return true;`);
  });

  await t.test('roles, groups, and the disabled reason', async () => {
    await openOn(page, 'main', 't-top', { radio: true });
    const tree = await run(
      `const element = probe.menus.main.element;
      const find = (label) => [...element.querySelectorAll('.menu-item')]
        .find((node) => node.textContent.startsWith(label));
      const bravo = find('Bravo');
      const reason = document.getElementById(
        bravo.getAttribute('aria-describedby'));
      const groups = [...element.querySelectorAll('[role="group"]')]
        .map((group) => [
          document.getElementById(group.getAttribute('aria-labelledby'))
            .textContent,
          group.classList.contains('menu-row'),
        ]);
      return {
        roles: ['Alpha', 'Delta', 'Auto', 'Tiles'].map(
          (label) => find(label).getAttribute('role')),
        checked: ['Delta', 'Auto', 'Grid'].map(
          (label) => find(label).getAttribute('aria-checked')),
        disabled: bravo.getAttribute('aria-disabled'),
        reason: reason.textContent,
        separators: element.querySelectorAll('[role="separator"]').length,
        marks: element.querySelectorAll('.menu-mark svg').length,
        groups,
      };`,
    );
    assert.deepEqual(tree.roles, [
      'menuitem',
      'menuitemcheckbox',
      'menuitemradio',
      'menuitemradio',
    ]);
    assert.deepEqual(tree.checked, ['false', 'true', 'false']);
    assert.equal(tree.disabled, 'true');
    assert.equal(tree.reason, 'Not now');
    assert.equal(tree.separators, 1);
    assert.equal(tree.marks, 6);
    assert.deepEqual(tree.groups, [
      ['Mode', false],
      ['Layout', true],
    ]);
    await run(`probe.menus.main.menu.close(); return true;`);
  });

  await t.test('keyboard open focuses the checked radio', async () => {
    await openOn(page, 'main', 't-top', { radio: true, keyboard: true });
    assert.equal(await where(page), 'Auto');
    await run(`probe.menus.main.menu.close(); return true;`);
    await openOn(page, 'main', 't-top', { keyboard: true });
    assert.equal(await where(page), 'Alpha');
    await run(`probe.menus.main.menu.close(); return true;`);
  });

  await t.test('a pointer open focuses the menu element', async () => {
    await clickOn(page, '#t-top');
    await openOn(page, 'main', 't-top', { keyboard: false });
    assert.equal(await where(page), 'menu');
    await press(page, 'ArrowDown');
    assert.equal(await where(page), 'Alpha');
    await run(`probe.menus.main.menu.close(); return true;`);
    await openOn(page, 'main', 't-top', { keyboard: false });
    await press(page, 'ArrowUp');
    assert.equal(await where(page), 'Echo');
    await run(`probe.menus.main.menu.close(); return true;`);
  });

  await t.test('arrows, Home, End, rows, and disabled items', async () => {
    await openOn(page, 'main', 't-top', { keyboard: true });
    const walk = async (name, expected) => {
      await press(page, name);
      assert.equal(await where(page), expected, `${name} -> ${expected}`);
    };
    await walk('ArrowDown', 'Charlie');
    await walk('ArrowDown', 'Delta');
    await walk('ArrowDown', 'Auto');
    await walk('ArrowDown', 'Grid');
    await walk('ArrowDown', 'Tiles');
    await walk('ArrowRight', 'Rows');
    await walk('ArrowRight', 'Stage');
    await walk('ArrowRight', 'Tiles');
    await walk('ArrowLeft', 'Stage');
    await walk('ArrowRight', 'Tiles');
    await walk('ArrowDown', 'Echo');
    await walk('ArrowDown', 'Alpha');
    await walk('ArrowUp', 'Echo');
    await walk('Home', 'Alpha');
    await walk('End', 'Echo');
    await walk('ArrowUp', 'Tiles');
    assert.equal(await isOpen(page, 'main'), true);
    await run(`probe.menus.main.menu.close(); return true;`);
  });

  await t.test('type-ahead jumps to the next matching item', async () => {
    await openOn(page, 'main', 't-top', { keyboard: true });
    const typed = async (character, expected) => {
      await press(page, letterKey(character));
      assert.equal(await where(page), expected, `${character}`);
    };
    await typed('c', 'Charlie');
    await typed('e', 'Echo');
    await typed('d', 'Delta');
    await typed('a', 'Auto');
    await typed('b', 'Auto');
    await typed('g', 'Grid');
    await run(`probe.menus.main.menu.close(); return true;`);
  });

  await t.test('Enter and Space activate and the menu closes', async () => {
    await openOn(page, 'main', 't-top', { keyboard: true });
    await press(page, 'ArrowDown');
    await press(page, 'Enter');
    assert.deepEqual(await eventsOf(page), ['main:select:three:undefined']);
    assert.equal(await isOpen(page, 'main'), false);
    assert.equal(await where(page), 't-top');
    await openOn(page, 'main', 't-top', { keyboard: true });
    await press(page, 'End');
    await press(page, 'Space');
    assert.deepEqual(await eventsOf(page), ['main:select:last:undefined']);
    assert.equal(await isOpen(page, 'main'), false);
    assert.equal(await where(page), 't-top');
  });

  await t.test('a checkbox stays open, a radio closes', async () => {
    await openOn(page, 'main', 't-top', { keyboard: true, radio: true });
    await run(`${itemOf('main', 'Delta')}.focus(); return true;`);
    await press(page, 'Enter');
    assert.deepEqual(await eventsOf(page), ['main:select:check:true']);
    assert.equal(await isOpen(page, 'main'), true);
    const checked = () =>
      run(`return ${itemOf('main', 'Delta')}.getAttribute('aria-checked');`);
    assert.equal(await checked(), 'true');
    await press(page, 'Enter');
    assert.deepEqual(await eventsOf(page), ['main:select:check:false']);
    assert.equal(await checked(), 'false');
    assert.equal(await isOpen(page, 'main'), true);
    await run(`${itemOf('main', 'Grid')}.focus(); return true;`);
    await press(page, 'Enter');
    assert.deepEqual(await eventsOf(page), ['main:select:mode-b:true']);
    assert.equal(await isOpen(page, 'main'), false);
    const radios = await run(
      `return [${itemOf('main', 'Auto')}.getAttribute('aria-checked'),
        ${itemOf('main', 'Grid')}.getAttribute('aria-checked')];`,
    );
    assert.deepEqual(radios, ['false', 'true']);
    const expanded = await run(
      `return document.getElementById('t-top').getAttribute('aria-expanded');`,
    );
    assert.equal(expanded, 'false');
  });

  await t.test('a pointer click acts, a disabled item does not', async () => {
    await openOn(page, 'main', 't-top');
    await run(
      `${itemOf('main', 'Bravo')}.id = 'bravo';
      ${itemOf('main', 'Alpha')}.id = 'alpha';
      ${itemOf('main', 'Delta')}.id = 'delta';
      return true;`,
    );
    await clickOn(page, '#bravo');
    assert.deepEqual(await eventsOf(page), []);
    assert.equal(await isOpen(page, 'main'), true);
    await clickOn(page, '#delta');
    assert.deepEqual(await eventsOf(page), ['main:select:check:true']);
    assert.equal(await isOpen(page, 'main'), true);
    await clickOn(page, '#alpha');
    assert.deepEqual(await eventsOf(page), ['main:select:one:undefined']);
    assert.equal(await isOpen(page, 'main'), false);
    assert.equal(await where(page), 't-top');
  });

  await t.test('Esc returns focus to the trigger and Tab closes', async () => {
    await openOn(page, 'main', 't-top', { keyboard: true });
    await press(page, 'Escape');
    assert.deepEqual(await eventsOf(page), ['main:close:escape']);
    assert.equal(await isOpen(page, 'main'), false);
    assert.equal(await where(page), 't-top');
    await openOn(page, 'main', 't-top', { keyboard: false });
    await press(page, 'Escape');
    assert.deepEqual(await eventsOf(page), ['main:close:escape']);
    assert.equal(await where(page), 't-top');
    await openOn(page, 'main', 't-top', { keyboard: true });
    await press(page, 'Tab');
    assert.deepEqual(await eventsOf(page), ['main:close:tab']);
    assert.equal(await isOpen(page, 'main'), false);
    assert.equal(await where(page), 't-left');
  });

  await t.test('a second menu closes the first', async () => {
    await openOn(page, 'main', 't-top');
    await openOn(page, 'other', 't-left');
    assert.deepEqual(await eventsOf(page), ['main:close:other']);
    assert.equal(await isOpen(page, 'main'), false);
    assert.equal(await isOpen(page, 'other'), true);
    const expanded = await run(
      `return ['t-top', 't-left'].map((id) =>
        document.getElementById(id).getAttribute('aria-expanded'));`,
    );
    assert.deepEqual(expanded, ['false', 'true']);
    const closed = await run(`return probe.dismissMenu('test');`);
    assert.equal(closed, true);
    assert.deepEqual(await eventsOf(page), ['other:close:test']);
    assert.equal(await isOpen(page, 'other'), false);
    assert.equal(await run(`return probe.dismissMenu('test');`), false);
  });

  await t.test('a pointer down outside closes the menu', async () => {
    await openOn(page, 'main', 't-top');
    await mouse(page, 600, 450);
    assert.deepEqual(await eventsOf(page), ['main:close:pointer']);
    assert.equal(await isOpen(page, 'main'), false);
    await openOn(page, 'main', 't-top');
    await page.run(
      `document.getElementById('t-top').dispatchEvent(
        new PointerEvent('pointerdown', { bubbles: true }));
      return true;`,
    );
    assert.deepEqual(await eventsOf(page), []);
    assert.equal(await isOpen(page, 'main'), true);
    await page.run(`probe.menus.main.menu.close(); return true;`);
    await eventsOf(page);
  });

  await t.test('scroll of the container and resize close it', async () => {
    await openOn(page, 'main', 't-box');
    await run(`document.getElementById('side').scrollTop = 40; return true;`);
    await delay(150);
    assert.equal(await isOpen(page, 'main'), true);
    await run(`document.getElementById('box').scrollTop = 30; return true;`);
    await wait(`return !probe.menus.main.menu.isOpen;`);
    assert.deepEqual(await eventsOf(page), ['main:close:scroll']);
    await run(`document.getElementById('box').scrollTop = 0; return true;`);
    await delay(150);
    await openOn(page, 'main', 't-top');
    await viewportOf(page, { ...DESKTOP, width: DESKTOP.width - 120 });
    await wait(`return !probe.menus.main.menu.isOpen;`);
    assert.deepEqual(await eventsOf(page), ['main:close:resize']);
    await viewportOf(page, DESKTOP);
  });

  await t.test('a menu serves the document of its host element', async () => {
    const prepared = await run(
      `const frame = document.createElement('iframe');
      frame.id = 'probe-frame';
      frame.style.cssText = 'position: fixed; left: 0; top: 0; z-index: 50;' +
        'width: 700px; height: 400px; border: 0; background: #000;';
      frame.srcdoc = '<!doctype html><body></body>';
      const loaded = new Promise((resolve) => {
        frame.onload = resolve;
      });
      document.body.append(frame);
      await loaded;
      const doc = frame.contentDocument;
      const link = doc.createElement('link');
      link.rel = 'stylesheet';
      link.href = '/default.css';
      const styled = new Promise((resolve) => {
        link.onload = resolve;
      });
      doc.head.append(link);
      await styled;
      const trigger = doc.createElement('button');
      trigger.id = 'frame-trigger';
      trigger.textContent = 'z';
      trigger.style.cssText = 'position: fixed; left: 50px; bottom: 10px;';
      doc.body.append(trigger);
      probe.make('frame', {}, doc);
      return doc === probe.menus.frame.element.ownerDocument;`,
    );
    assert.equal(prepared, true);
    await openOn(page, 'frame', 'frame-trigger', { placement: 'top' });
    const inside = await run(
      `const frame = document.getElementById('probe-frame');
      const view = frame.contentWindow;
      const element = probe.menus.frame.element;
      const rect = element.getBoundingClientRect();
      const trigger = view.document.getElementById('frame-trigger');
      return {
        open: probe.menus.frame.menu.isOpen,
        fits: rect.top >= 8 && rect.bottom <= view.innerHeight - 8,
        above: rect.bottom <= trigger.getBoundingClientRect().top,
        expanded: trigger.getAttribute('aria-expanded'),
      };`,
    );
    assert.deepEqual(inside, {
      open: true,
      fits: true,
      above: true,
      expanded: 'true',
    });
    await run(`document.body.dispatchEvent(new PointerEvent('pointerdown',
      { bubbles: true })); return true;`);
    assert.equal(await isOpen(page, 'frame'), true);
    await run(
      `const frame = document.getElementById('probe-frame');
      frame.contentDocument.body.dispatchEvent(
        new PointerEvent('pointerdown', { bubbles: true }));
      return true;`,
    );
    assert.equal(await isOpen(page, 'frame'), false);
    assert.deepEqual(await eventsOf(page), ['frame:close:pointer']);
    await run(`document.getElementById('probe-frame').remove(); return true;`);
  });

  await t.test('the message menu keeps its reactions and roles', async () => {
    await run(
      `app.username = 'ada';
      app.writeMessage(app.chat, 'menu line', undefined, [], '');
      return true;`,
    );
    await wait(
      `app.render(); return [...app.messageList.querySelectorAll('.message')]
        .some((row) => row.querySelector('.content').textContent ===
          'menu line');`,
    );
    await run(
      `const style = document.createElement('style');
      style.textContent = '.message-tools, .message-tools .more { display:' +
        ' flex !important; visibility: visible !important; }';
      document.head.append(style);
      const row = [...app.messageList.querySelectorAll('.message')]
        .find((item) => item.querySelector('.content').textContent ===
          'menu line');
      row.querySelector('.more').click();
      return true;`,
    );
    const shown = await run(
      `const element = app.menuElement;
      const more = [...app.messageList.querySelectorAll('.more')]
        .find((button) => button.getAttribute('aria-expanded') === 'true');
      const items = [...element.querySelectorAll('.menu-item')];
      return {
        open: app.menu.isOpen,
        lifted: app.menu.isLifted,
        role: element.getAttribute('role'),
        reactions: element.querySelectorAll('.menu-reactions button').length,
        roles: [...new Set(items.map((node) => node.getAttribute('role')))],
        trigger: Boolean(more),
        controls: more?.getAttribute('aria-controls') === element.id,
        focus: document.activeElement === element,
      };`,
    );
    assert.deepEqual(shown, {
      open: true,
      lifted: false,
      role: 'menu',
      reactions: 9,
      roles: ['menuitem'],
      trigger: true,
      controls: true,
      focus: true,
    });
    await press(page, 'ArrowDown');
    assert.equal(
      await run(`return document.activeElement.dataset.action;`),
      'react',
    );
    await press(page, 'ArrowDown');
    assert.equal(
      await run(`return document.activeElement.dataset.action;`),
      'reply',
    );
    await press(page, 'Escape');
    assert.equal(await run(`return app.menu.isOpen;`), false);
    const row = await run(
      `return document.activeElement.classList.contains('message');`,
    );
    assert.equal(row, true);
  });

  await t.test('the phone gets a sheet over the backdrop', async () => {
    await viewportOf(page, PHONE);
    await run(
      `const element = document.createElement('div');
      element.className = 'menu hidden';
      document.body.append(element);
      const layers = {
        push: (name) => app.pushLayer(name),
        pop: (name) => app.popLayer(name),
      };
      probe.menus.sheet = {
        element,
        menu: new probe.Menu(element, { backdrop: app.backdrop, layers }),
      };
      return true;`,
    );
    await openOn(page, 'sheet', 't-bottom', { keyboard: true });
    const sheet = await run(
      `const element = probe.menus.sheet.element;
      await Promise.all(element.getAnimations().map((a) => a.finished));
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return {
        sheet: element.classList.contains('sheet'),
        left: rect.left,
        width: Math.round(rect.width) === innerWidth,
        bottom: Math.round(rect.bottom) === innerHeight,
        short: rect.height <= innerHeight * 0.7 + 1,
        fixed: style.position,
        backdrop: !app.backdrop.classList.contains('hidden'),
        over: Number(style.zIndex) > Number(
          getComputedStyle(app.backdrop).zIndex),
        layer: app.layers.at(-1),
        grabber: element.querySelector('.menu-grabber') !== null,
      };`,
    );
    assert.deepEqual(sheet, {
      sheet: true,
      left: 0,
      width: true,
      bottom: true,
      short: true,
      fixed: 'fixed',
      backdrop: true,
      over: true,
      layer: 'menu',
      grabber: true,
    });
    await run(`history.back(); return true;`);
    await wait(`return !probe.menus.sheet.menu.isOpen && app.pops === 0;`);
    assert.deepEqual(await eventsOf(page), ['sheet:close:back']);
    const backed = await run(
      `return [app.layers.length, app.backdrop.classList.contains('hidden')];`,
    );
    assert.deepEqual(backed, [0, true]);

    await openOn(page, 'sheet', 't-bottom', { keyboard: false });
    await run(
      `const grabber = probe.menus.sheet.element
        .querySelector('.menu-grabber');
      const fire = (type, y) => grabber.dispatchEvent(new PointerEvent(type,
        { bubbles: true, pointerType: 'touch', clientY: y }));
      fire('pointerdown', 600);
      fire('pointermove', 660);
      fire('pointermove', 720);
      fire('pointerup', 720);
      return true;`,
    );
    await wait(`return !probe.menus.sheet.menu.isOpen && app.pops === 0;`);
    assert.deepEqual(await eventsOf(page), ['sheet:close:swipe']);
    assert.equal(await run(`return app.layers.length;`), 0);

    await openOn(page, 'sheet', 't-bottom', { keyboard: false });
    await run(
      `const grabber = probe.menus.sheet.element
        .querySelector('.menu-grabber');
      const fire = (type, y) => grabber.dispatchEvent(new PointerEvent(type,
        { bubbles: true, pointerType: 'touch', clientY: y }));
      fire('pointerdown', 600);
      fire('pointermove', 620);
      fire('pointerup', 620);
      return true;`,
    );
    assert.equal(await isOpen(page, 'sheet'), true);
    await run(`${itemOf('sheet', 'Alpha')}.click(); return true;`);
    await wait(`return !probe.menus.sheet.menu.isOpen && app.pops === 0;`);
    assert.deepEqual(await eventsOf(page), ['sheet:select:one:undefined']);
    assert.equal(await run(`return app.layers.length;`), 0);

    await openOn(page, 'sheet', 't-bottom', { keyboard: false });
    await mouse(page, 195, 60);
    await wait(`return !probe.menus.sheet.menu.isOpen && app.pops === 0;`);
    assert.deepEqual(await eventsOf(page), ['sheet:close:backdrop']);
    assert.equal(await run(`return app.layers.length;`), 0);

    const items = Array.from({ length: 30 }, (_, i) => ({
      action: `entry-${i}`,
      label: `Entry ${i}`,
    }));
    await openOn(page, 'sheet', 't-bottom', { items });
    const tall = await run(
      `const element = probe.menus.sheet.element;
      return element.scrollHeight > element.clientHeight &&
        element.getBoundingClientRect().height <= innerHeight * 0.7 + 1;`,
    );
    assert.equal(tall, true);
    await run(`probe.menus.sheet.menu.close(); return true;`);
    await wait(`return app.pops === 0 && app.layers.length === 0;`);
  });

  await t.test('the lifted message menu still shows the message', async () => {
    await run(
      `const row = [...app.messageList.querySelectorAll('.message')]
        .find((item) => item.querySelector('.content').textContent ===
          'menu line');
      const rect = row.getBoundingClientRect();
      app.openMenu(row, { x: rect.left + 20, y: rect.bottom }, true);
      return true;`,
    );
    const lifted = await run(
      `const element = app.menuElement;
      return {
        lifted: app.menu.isLifted,
        modal: app.menu.isModal,
        copy: element.querySelector('.lift .content')?.textContent,
        reactions: element.querySelectorAll('.menu-reactions button').length,
        grabber: element.querySelector('.menu-grabber') !== null,
        sheet: element.classList.contains('sheet'),
        backdrop: !app.backdrop.classList.contains('hidden'),
        layer: app.layers.at(-1),
      };`,
    );
    assert.deepEqual(lifted, {
      lifted: true,
      modal: true,
      copy: 'menu line',
      reactions: 9,
      grabber: false,
      sheet: false,
      backdrop: true,
      layer: 'menu',
    });
    await run(`history.back(); return true;`);
    await wait(
      `return !app.menu.isOpen && app.layers.length === 0 && app.pops === 0
        && app.backdrop.classList.contains('hidden');`,
    );
  });
});

test('The roster menu', { timeout: 180000 }, async (t) => {
  await startCallServer(t);
  const browser = await launch(t, MEDIA_FLAGS);
  const page = await openPage(t, browser);
  const { run, wait } = page;
  await run(
    `app.usernameInput.value = 'alex'; app.syncUsername(); return true;`,
  );
  await run(
    `app.selectChat('general');
    await app.startCall('general');
    return true;`,
  );
  await run(
    `document.querySelector('#prejoin [data-action=join]').click();
    return true;`,
  );
  await wait(JOINED);
  await wait(`return document.querySelector('.call-roster li') !== null;`);

  const rosterButton = '.call-roster li [data-action="roster-menu"]';
  const query = `document.querySelector('${rosterButton}')`;
  const open = `${query}.click(); return true;`;
  const rosterState = () =>
    run(
      `const button = document.querySelector('${rosterButton}');
      const stage = app.callStage;
      const menu = stage.tileMenu;
      return {
        details: document.querySelectorAll('details.roster-menu').length,
        expanded: button.getAttribute('aria-expanded'),
        open: menu.menu.isOpen,
        actions: [...menu.element.querySelectorAll('[data-action]')]
          .map((node) => node.dataset.action),
        focus: document.activeElement === button,
        pin: stage.pin,
      };`,
    );

  await t.test('the roster button replaces the details element', async () => {
    const before = await rosterState();
    assert.equal(before.details, 0);
    assert.equal(before.expanded, 'false');
    assert.equal(before.open, false);
    await run(open);
    const after = await rosterState();
    assert.equal(after.expanded, 'true');
    assert.equal(after.open, true);
    assert.ok(after.actions.includes('pin'));
    assert.ok(after.actions.includes('tile-fullscreen'));
    assert.ok(after.actions.includes('move-to-backstage'));
    const visible = await run(
      `return app.callStage.tileMenu.element.checkVisibility();`,
    );
    assert.equal(visible, true);
  });

  await t.test('Esc closes it and returns focus to the button', async () => {
    await press(page, 'Escape');
    const closed = await rosterState();
    assert.equal(closed.open, false);
    assert.equal(closed.expanded, 'false');
    assert.equal(closed.focus, true);
  });

  await t.test('choosing an action runs it for that person', async () => {
    await run(open);
    await run(
      `app.callStage.tileMenu.element
        .querySelector('[data-action="pin"]').click();
      return true;`,
    );
    const pinned = await rosterState();
    assert.equal(pinned.open, false);
    assert.match(pinned.pin, /\/camera$/);
  });

  await t.test('only one menu is open: the tile menu replaces it', async () => {
    await run(open);
    await run(
      `document.querySelector('.call-tile [data-action="tile-menu"]').click();
      return true;`,
    );
    const state = await run(
      `const menu = app.callStage.tileMenu;
      const roster = document.querySelector('${rosterButton}');
      const tile = document.querySelector('.call-tile');
      return {
        open: menu.menu.isOpen,
        roster: roster.getAttribute('aria-expanded'),
        tile: tile.querySelector('[data-action="tile-menu"]')
          .getAttribute('aria-expanded'),
        targeted: tile.classList.contains('targeted'),
        count: document.querySelectorAll('.call-tile-menu:not(.hidden)')
          .length,
      };`,
    );
    assert.deepEqual(state, {
      open: true,
      roster: 'false',
      tile: 'true',
      targeted: true,
      count: 1,
    });
    await press(page, 'Escape');
    await delay(50);
  });

  await t.test('on a phone they are sheets and Back keeps it', async () => {
    await viewportOf(page, PHONE);
    await wait(`return app.callStage.phone.matches;`);
    const tileButton = `.call-tile [data-action="tile-menu"]`;
    await run(`document.querySelector('${tileButton}').click(); return true;`);
    await wait(`return app.callStage.tileMenu.menu.isOpen;`);
    await run(`await Promise.all(app.callStage.tileMenu.element
      .getAnimations().map((a) => a.finished)); return true;`);
    const tile = await run(
      `const element = app.callStage.tileMenu.element;
      const rect = element.getBoundingClientRect();
      return {
        sheet: element.classList.contains('sheet'),
        bottom: Math.round(rect.bottom) === innerHeight,
        backdrop: !app.backdrop.classList.contains('hidden'),
        layers: app.layers.filter((name) => name === 'menu').length,
      };`,
    );
    assert.deepEqual(tile, {
      sheet: true,
      bottom: true,
      backdrop: true,
      layers: 1,
    });
    await run(`history.back(); return true;`);
    await wait(
      `return !app.callStage.tileMenu.menu.isOpen && app.pops === 0 &&
        app.backdrop.classList.contains('hidden');`,
    );
    const kept = await run(
      `return [app.callStage.mode,
        app.layers.filter((name) => name === 'menu').length];`,
    );
    assert.deepEqual(kept, ['call', 0]);

    await run(
      `document.querySelector('#call-view [data-action="people"]').click();
      return true;`,
    );
    await wait(`return app.callStage.sheet === 'people';`);
    await run(`${query}.click(); return true;`);
    await wait(`return app.callStage.tileMenu.menu.isOpen;`);
    await run(`await Promise.all(app.callStage.tileMenu.element
      .getAnimations().map((a) => a.finished)); return true;`);
    const over = await run(
      `const element = app.callStage.tileMenu.element;
      const rect = element.getBoundingClientRect();
      const top = document.elementFromPoint(
        rect.left + rect.width / 2, rect.top + 40);
      return {
        sheet: element.classList.contains('sheet'),
        covers: element.contains(top),
        people: app.callStage.sheet,
      };`,
    );
    assert.deepEqual(over, { sheet: true, covers: true, people: 'people' });
    await run(`history.back(); return true;`);
    await wait(`return !app.callStage.tileMenu.menu.isOpen && app.pops === 0;`);
    const stays = await run(
      `return [app.callStage.mode, app.callStage.sheet];`,
    );
    assert.deepEqual(stays, ['call', 'people']);
  });
});
