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
    ['fourth', 'done', null, '!design', 5400000, 1500000000],
  ];
  let day = 20;
  const { titleOf } = await import('/recording-files.js');
  for (const [id, state, name, chat, duration, size] of variants) {
    const dir = await recordings.getDirectoryHandle(id, { create: true });
    const year = new Date().getFullYear() - 1;
    const started = new Date(year, 10, day--, 14, 5).getTime();
    const title = name ?? titleOf(chat, started);
    const meta = {
      state, title, chatName: chat, started, duration, size,
      extension: 'webm',
    };
    if (id === 'fourth') {
      meta.folder = 'picked';
      meta.segments = [1, 2, 3].map((n) => ({
        name: 'part 0' + n + '.webm', size: 1000, duration: 1000,
      }));
    }
    await write(dir, 'meta.json', JSON.stringify(meta));
    await write(dir, 'program.webm', Uint8Array.of(1, 2, 3));
    if (id !== 'third') await write(dir, 'poster.jpg', poster);
  }
  return true;
`;

const YEAR = new Date().getFullYear() - 1;
const MENU_LABELS = `
  return Array.from(document.querySelectorAll('.recording-menu .menu-label'),
    (label) => label.textContent);
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
      document.querySelectorAll('${ROW}').length >= 4;`,
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
      boxes: 4,
      placeholder: 'rgb(15, 20, 24)',
    });
  });

  await t.test(
    'cards show the chat once, with the duration on the poster',
    async () => {
      const cards = await run(
        first,
        `return Array.from(document.querySelectorAll('${ROW}'), (row) => {
        const rectOf = (selector) =>
          row.querySelector(selector).getBoundingClientRect();
        const poster = rectOf('.recording-poster');
        const duration = rectOf('.recording-duration');
        const state = row.querySelector('.recording-state');
        const box = state.getBoundingClientRect();
        return {
          id: row.dataset.id,
          title: row.querySelector('.recording-title').textContent,
          meta: row.querySelector('.recording-meta').textContent
            .replace(/\\s+/g, ' ').trim(),
          duration: row.querySelector('.recording-duration').textContent,
          bottomRight: poster.right - duration.right < 12 &&
            poster.bottom - duration.bottom < 12,
          badge: state.hidden ? '' : state.textContent,
          topLeft: state.hidden || (box.left - poster.left < 12 &&
            box.top - poster.top < 12),
          tip: state.title,
          folder: !row.querySelector('.recording-folder').hidden,
          note: row.querySelector('.recording-note'),
          select: row.querySelector('select'),
          text: row.textContent,
        };
      }).sort((a, b) => a.id.localeCompare(b.id));`,
      );
      const byId = Object.fromEntries(cards.map((card) => [card.id, card]));
      assert.equal(byId.first.title, 'Team sync');
      assert.equal(byId.first.meta, `!general · Nov 20 ${YEAR} · 46.0 MB`);
      assert.equal(byId.first.duration, '12:34');
      assert.equal(byId.second.title, 'Interview with a long recording title');
      assert.equal(byId.second.meta, `@sam · Nov 19 ${YEAR} · 867.8 MB`);
      assert.equal(byId.second.duration, '1:02:05');
      assert.equal(byId.third.title, '!design');
      assert.equal(byId.third.meta, `Nov 18 ${YEAR} · 3.0 MB`);
      assert.equal(byId.fourth.title, '!design');
      assert.equal(byId.fourth.meta, `Nov 17 ${YEAR} · 1.4 GB`);
      assert.equal(byId.fourth.folder, true);
      for (const card of cards) {
        assert.equal(card.bottomRight, true, card.id);
        assert.equal(card.topLeft, true, card.id);
        assert.equal(card.note, null);
        assert.equal(card.select, null);
        assert.equal(card.text.includes('Done'), false);
        assert.equal(card.text.includes('Browser storage'), false);
        assert.equal(card.text.includes('Recording ended'), false);
      }
      assert.equal(byId.third.badge, 'interrupted');
      assert.equal(byId.third.tip, 'Recording ended unexpectedly');
      for (const id of ['first', 'second', 'fourth']) {
        assert.equal(byId[id].badge, '', id);
      }
      assert.equal(byId.fourth.meta.includes('!design'), false);
    },
  );

  await t.test(
    'icon buttons have names and the menu holds the rest',
    async () => {
      const names = await run(
        first,
        `const row = document.querySelector('${ROW}[data-id=first]');
      return Array.from(row.querySelectorAll('.recording-actions > *'),
        (control) => [control.tagName, control.getAttribute('aria-label'),
          control.title, control.hidden]);`,
      );
      const expected = ['Play', 'Edit', 'Download', 'Delete', 'More actions'];
      assert.deepEqual(
        names.map(([, label]) => label),
        expected,
      );
      for (const [, label, title, hidden] of names) {
        assert.equal(title, label);
        assert.equal(hidden, false);
      }
      assert.deepEqual(
        names.map(([tag]) => tag),
        ['BUTTON', 'BUTTON', 'A', 'BUTTON', 'BUTTON'],
      );
      await click(first, `${ROW}[data-id=first] .recording-more`);
      await wait(
        first,
        `return !!document.querySelector('.recording-menu .menu-item');`,
      );
      assert.deepEqual(await run(first, MENU_LABELS), [
        'Play',
        'Edit',
        'Share video',
        'Publish to chat or feed…',
        'Properties',
        'Attach to chat',
        'Download',
        'Save as…',
        'Rename',
        'Delete',
      ]);
      assert.equal(
        await run(
          first,
          `return document.querySelector(
          '${ROW}[data-id=first] .recording-more',
        ).getAttribute('aria-expanded');`,
        ),
        'true',
      );
      await press(first, 'Escape');
      await wait(
        first,
        `return app.recordingsView.isOpen && document.querySelector(
          '.recording-menu').classList.contains('hidden');`,
      );
    },
  );

  await t.test(
    'the menu lists parts and a radio switches the part',
    async () => {
      const row = `${ROW}[data-id=fourth]`;
      await click(first, `${row} .recording-more`);
      await wait(
        first,
        `return !!document.querySelector('.recording-menu .menu-item');`,
      );
      assert.deepEqual(await run(first, MENU_LABELS), [
        'Play',
        'Edit',
        'Share video',
        'Publish to chat or feed…',
        'Properties',
        'Attach to chat',
        'Download',
        'Save as…',
        'Rename',
        'Delete',
        'Part 1',
        'Part 2',
        'Part 3',
      ]);
      const radios = `Array.from(document.querySelectorAll(
      '.recording-menu [role=menuitemradio]'))`;
      assert.deepEqual(
        await run(
          first,
          `return ${radios}.map((item) => item.getAttribute('aria-checked'));`,
        ),
        ['true', 'false', 'false'],
      );
      await run(first, `${radios}[2].click(); return true;`);
      await wait(first, `return app.recordings.parts.get('fourth') === 2;`);
      assert.equal(
        await run(
          first,
          `const cards = app.recordings.cards;
        const entry = cards.get(document.querySelector('${row}')).entry;
        return app.recordings.partOf(entry).name;`,
        ),
        'part 03.webm',
      );
      await click(first, `${row} .recording-more`);
      await wait(
        first,
        `return !!document.querySelector('.recording-menu .menu-item');`,
      );
      assert.deepEqual(
        await run(
          first,
          `return ${radios}.map((item) => item.getAttribute('aria-checked'));`,
        ),
        ['false', 'false', 'true'],
      );
      await press(first, 'Escape');
    },
  );

  await t.test('a poster click or Enter plays the recording', async () => {
    const real = async (selector, type) => {
      const point = await run(
        first,
        `const element = document.querySelector(${JSON.stringify(selector)});
        const box = element.getBoundingClientRect();
        return { x: box.x + box.width / 2, y: box.y + box.height / 2 };`,
      );
      const types =
        type === 'move' ? ['mouseMoved'] : ['mousePressed', 'mouseReleased'];
      for (const kind of types) {
        const params = { ...point, type: kind, button: 'left', clickCount: 1 };
        await browser.request('Input.dispatchMouseEvent', params, first);
      }
    };
    const poster = `${ROW}[data-id=first] .recording-poster`;
    const arrow = `getComputedStyle(
      document.querySelector('${poster}-play')).opacity`;
    const rule = `Array.from(document.styleSheets).some((sheet) =>
      Array.from(sheet.cssRules).some((rule) =>
        rule.media?.mediaText === '(hover: none)' &&
        rule.cssText.includes('.recording-poster-play')))`;
    assert.equal(await run(first, `return ${rule};`), true);
    const rest = await run(
      first,
      `return matchMedia('(hover: none)').matches
      ? '1' : '0';`,
    );
    assert.equal(await run(first, `return ${arrow};`), rest);
    await real(poster, 'move');
    assert.equal(await run(first, `return ${arrow};`), '1');
    await real(poster, 'click');
    await wait(
      first,
      `return app.recordings.selected === 'first' &&
      new URL(app.recordings.player.src).pathname ===
      '/recordings/first/program.webm';`,
    );
    await run(
      first,
      `app.recordings.stopPlayback();
      document.querySelector(
        '${ROW}[data-id=second] .recording-poster-play').focus();
      return true;`,
    );
    for (const type of ['keyDown', 'keyUp']) {
      const key = {
        type,
        key: 'Enter',
        code: 'Enter',
        windowsVirtualKeyCode: 13,
        text: type === 'keyDown' ? '\r' : undefined,
      };
      await browser.request('Input.dispatchKeyEvent', key, first);
    }
    await wait(first, `return app.recordings.selected === 'second';`);
    await run(first, `app.recordings.stopPlayback(); return true;`);
  });

  await t.test(
    'a right click opens the card menu and Rename edits in place',
    async () => {
      await run(
        first,
        `const row = document.querySelector('${ROW}[data-id=first]');
      const box = row.getBoundingClientRect();
      const options = { bubbles: true, cancelable: true,
        clientX: box.x + 20, clientY: box.y + 20 };
      row.querySelector('.recording-title').dispatchEvent(
        new MouseEvent('contextmenu', options));
      return true;`,
      );
      await wait(
        first,
        `return !!document.querySelector('.recording-menu .menu-item');`,
      );
      await run(
        first,
        `const items = Array.from(
        document.querySelectorAll('.recording-menu .menu-item'));
      items.find((item) => item.textContent === 'Rename').click();
      return true;`,
      );
      await wait(
        first,
        `const row = document.querySelector('${ROW}[data-id=first]');
      const form = row.querySelector('form');
      return !form.classList.contains('hidden') && form.offsetWidth > 0 &&
        row.querySelector('.recording-title').offsetWidth === 0 &&
        document.activeElement === form.querySelector('input');`,
      );
      await press(first, 'Escape');
      await wait(
        first,
        `const row = document.querySelector('${ROW}[data-id=first]');
      return row.querySelector('form').classList.contains('hidden') &&
        row.querySelector('.recording-title').offsetWidth > 0;`,
      );
    },
  );

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
    await click(first, `${ROW}[data-id=first] .recording-more`);
    await run(
      first,
      `const items = Array.from(
        document.querySelectorAll('.recording-menu .menu-item'));
      items.find((item) => item.textContent === 'Rename').click();
      return true;`,
    );
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
      && document.querySelectorAll('${ROW}').length >= 4;`,
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
      document.querySelectorAll('${ROW}').length >= 4;`,
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
      document.querySelectorAll('${ROW}').length >= 4;`,
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
      document.querySelectorAll('${ROW}').length >= 4;`,
    );
    const columns = await run(
      phone,
      `return getComputedStyle(document.querySelector('.recordings-list'))
        .gridTemplateColumns.split(' ').length;`,
    );
    assert.equal(columns, 1);
    await run(
      phone,
      `const row = document.querySelector('${ROW}[data-id=first]');
      const box = row.getBoundingClientRect();
      const init = { pointerType: 'touch', bubbles: true, isPrimary: true,
        clientX: box.x + 40, clientY: box.y + 20 };
      row.querySelector('.recording-title').dispatchEvent(
        new PointerEvent('pointerdown', init));
      return true;`,
    );
    await wait(
      phone,
      `const menu = document.querySelector('.recording-menu');
      return !menu.classList.contains('hidden') &&
        menu.classList.contains('sheet') && app.layers.includes('menu');`,
    );
    await run(
      phone,
      `document.dispatchEvent(new PointerEvent('pointerup',
        { pointerType: 'touch', bubbles: true }));
      return true;`,
    );
    await run(phone, `app.recordings.menu.dismiss('escape'); return true;`);
    await wait(phone, `return !app.layers.includes('menu') && app.pops === 0;`);
    await run(
      phone,
      `await new Promise((r) => setTimeout(r, 500)); return true;`,
    );
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
