'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const harness = require('./harness.js');

const { ORIGIN, MEDIA_FLAGS, launch, startCallServer } = harness;

const READY = `return app.connected && navigator.serviceWorker.controller &&
  app.mesh.peers.has(app.peerId);`;
const SECTIONS = [
  'profile',
  'appearance',
  'notifications',
  'media',
  'network',
  'recordings',
  'streaming',
  'storage',
  'shortcuts',
  'about',
];

const SEED_RECORDINGS = `
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
  const variants = [
    ['first', 'done', 'Team sync'],
    ['second', 'done', 'Interview'],
    ['third', 'interrupted', 'Cut short'],
  ];
  for (const [id, state, title] of variants) {
    const dir = await recordings.getDirectoryHandle(id, { create: true });
    const meta = {
      state, title, chatName: '!general', started: Date.now(),
      duration: 61000, size: 300000, extension: 'webm',
    };
    await write(dir, 'meta.json', JSON.stringify(meta));
    await write(dir, 'program.webm', new Uint8Array(300000));
  }
  return true;
`;

const visible = (selector) => `
  const element = document.querySelector(${JSON.stringify(selector)});
  return element !== null && element.offsetWidth > 0 &&
    element.offsetHeight > 0;
`;

test('settings screen', { timeout: 240000 }, async (t) => {
  await startCallServer(t);
  const browser = await launch(t, MEDIA_FLAGS);

  const open = async (url = `${ORIGIN}/`, phone = false, browserContextId) => {
    const created = await browser.request('Target.createTarget', {
      url: 'about:blank',
      browserContextId,
    });
    const attach = { targetId: created.targetId, flatten: true };
    const { sessionId } = await browser.request(
      'Target.attachToTarget',
      attach,
    );
    await browser.request('Page.bringToFront', {}, sessionId);
    if (phone) {
      await browser.request(
        'Emulation.setDeviceMetricsOverride',
        { width: 390, height: 844, deviceScaleFactor: 1, mobile: true },
        sessionId,
      );
    }
    await browser.request('Page.navigate', { url }, sessionId);
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

  const first = await open();
  await browser.request(
    'Emulation.setDeviceMetricsOverride',
    { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false },
    first,
  );
  const step = (name, body) =>
    t.test(name, async () => {
      await browser.request('Page.bringToFront', {}, first);
      await body();
    });
  await run(first, `app.selectChat('general'); return true;`);

  await step('the profile row is display only and shows the nick', async () => {
    assert.equal(await run(first, visible('#profile-main')), true);
    assert.equal(
      await run(
        first,
        `return document.getElementById('profile-nick')
        .textContent;`,
      ),
      'set your nick',
    );
    const row = await run(
      first,
      `const main = document.getElementById('profile-main');
      const dot = document.getElementById('profile-dot');
      return {
        buttons: main.querySelectorAll('button, a, [role=button]').length,
        tag: main.tagName,
        titled: main.title !== '',
        label: dot.getAttribute('aria-label') === main.title,
        recordings: document.getElementById('recordings-btn').tagName,
        settings: document.getElementById('settings-btn').tagName,
      };`,
    );
    assert.deepEqual(row, {
      buttons: 0,
      tag: 'DIV',
      titled: true,
      label: true,
      recordings: 'BUTTON',
      settings: 'BUTTON',
    });
    for (const id of ['profile-main', 'profile-avatar', 'profile-nick']) {
      await click(first, `#${id}`);
    }
    await click(first, '#profile-dot');
    assert.equal(await run(first, 'return app.settings.isOpen;'), false);
    assert.equal(await run(first, 'return app.layers.length;'), 0);
    await run(first, `app.openSettings('profile'); return true;`);
    await wait(
      first,
      `return app.settings.isOpen && app.settings.section ===
      'profile' && document.getElementById('username-input').offsetWidth > 0;`,
    );
    const second = await open();
    await run(
      first,
      `const input = document.getElementById('username-input');
      input.value = 'alex';
      input.dispatchEvent(new Event('change', { bubbles: true }));
      input.blur();
      return true;`,
    );
    await wait(
      first,
      `return document.getElementById('profile-nick').textContent === 'alex'
        && document.getElementById('profile-avatar').textContent === 'AL';`,
    );
    await wait(
      first,
      `return document.querySelector('[data-page=profile] .saved')
        .textContent === 'saved';`,
    );
    await wait(
      second,
      `return document.getElementById('profile-nick').textContent === 'alex';`,
      20000,
    );
    await run(first, 'app.closeSettings(); return true;');
  });

  await step('profile photos persist and sync to contacts', async () => {
    const { browserContextId } = await browser.request(
      'Target.createBrowserContext',
    );
    const peer = await open(ORIGIN, false, browserContextId);
    const peerId = await run(first, 'return app.peerId;');
    const selector = `.contact-item[data-peer="${peerId}"] img`;
    await run(first, `app.openSettings('profile');`);
    await run(
      first,
      `
      const canvas = document.createElement('canvas');
      canvas.width = 240;
      canvas.height = 160;
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#369';
      ctx.fillRect(0, 0, 240, 160);
      const photo = await new Promise((resolve) => canvas.toBlob(resolve));
      const data = new DataTransfer();
      data.items.add(new File([photo], 'photo.png', { type: 'image/png' }));
      const input = document.getElementById('profile-photo-input');
      input.files = data.files;
      input.dispatchEvent(new Event('change', { bubbles: true }));
    `,
    );
    await wait(
      first,
      `
      const photo = document.querySelector('#profile-preview img');
      return photo?.naturalWidth === 128 && photo.naturalHeight === 128 &&
        photo.src === document.querySelector('#profile-avatar img')?.src;
    `,
    );
    const otherTab = await open();
    await wait(
      otherTab,
      `
      const photo = document.querySelector('#profile-avatar img');
      return photo?.naturalWidth === 128;
    `,
    );
    await wait(
      peer,
      `
      return document.querySelector(${JSON.stringify(selector)})?.naturalWidth
        === 128;
    `,
    );
    await click(first, '#profile-photo-remove');
    for (const session of [first, otherTab]) {
      await wait(
        session,
        `
        return document.getElementById('profile-avatar').textContent === 'AL';
      `,
      );
    }
    await wait(
      peer,
      `return !document.querySelector(${JSON.stringify(selector)});`,
    );
    await browser.request('Target.disposeBrowserContext', { browserContextId });
    await browser.request('Page.close', {}, otherTab);
    await run(first, 'app.closeSettings();');
  });

  await step('every section opens from the list', async () => {
    await click(first, '#settings-btn');
    await wait(first, 'return app.settings.isOpen;');
    for (const id of SECTIONS) {
      await click(first, `.settings-list [data-section="${id}"]`);
      const shown = await run(
        first,
        `const page = document.querySelector('[data-page="${id}"]');
        const current = document.querySelector('[aria-current=page]');
        return !page.hidden && page.offsetHeight > 0 &&
          current.dataset.section === '${id}';`,
      );
      assert.equal(shown, true, id);
    }
    await run(first, 'app.closeSettings(); return true;');
  });

  await step('the list is in the sidebar and the lists are gone', async () => {
    await click(first, '#settings-btn');
    await wait(first, 'return app.settings.isOpen;');
    await click(first, '.settings-list [data-section="profile"]');
    assert.equal(await run(first, visible('#sidebar .settings-list')), true);
    const lists = ['contact-list', 'feed-list', 'chat-list', 'folder-list'];
    for (const id of lists) {
      assert.equal(await run(first, visible(`#${id}`)), false, id);
    }
    assert.equal(await run(first, visible('#sidebar .brand')), false);
    assert.equal(
      await run(first, visible('.settings-view .settings-list')),
      false,
    );
    assert.equal(
      await run(
        first,
        `return document.querySelectorAll('.settings-list').length;`,
      ),
      1,
    );
    assert.equal(await run(first, visible('#settings-exit')), true);
    assert.equal(
      await run(
        first,
        `return document.getElementById('settings-exit').textContent
        .trim();`,
      ),
      '‹ Settings',
    );
    const layout = await run(
      first,
      `const rect = (selector) => document.querySelector(selector)
        .getBoundingClientRect();
      const button = document.getElementById('settings-btn');
      return {
        gap: Math.abs(rect('.settings-content').left - rect('#sidebar').right),
        zones: [rect('#sidebar').width, rect('.settings-view').width],
        row: rect('.profile-row').bottom === innerHeight,
        title: document.getElementById('settings-section-name').textContent,
        name: [...document.querySelectorAll('.settings-view .settings-title')]
          .map((node) => node.textContent.trim()).join(),
        close: document.getElementById('settings-close').offsetWidth > 0,
        active: button.classList.contains('active'),
        pressed: button.getAttribute('aria-pressed'),
      };`,
    );
    assert.equal(layout.gap < 30, true, 'no middle column');
    assert.equal(layout.zones[0], 288);
    assert.equal(layout.row, true);
    assert.equal(layout.title, 'Profile');
    assert.equal(layout.name, 'Profile');
    assert.equal(layout.close, true);
    assert.equal(layout.active, true);
    assert.equal(layout.pressed, 'true');
    await click(first, '#settings-exit');
    await wait(
      first,
      `return !app.settings.isOpen && app.layers.length === 0 &&
      app.pops === 0;`,
    );
    assert.equal(await run(first, visible('#chat-list')), true);
    assert.equal(await run(first, visible('#sidebar .settings-list')), false);
    assert.equal(
      await run(
        first,
        `const button = document.getElementById('settings-btn');
        return button.classList.contains('active') ||
          button.getAttribute('aria-pressed') !== 'false';`,
      ),
      false,
    );
  });

  await step('a hidden sidebar shows while settings are open', async () => {
    await run(first, 'app.toggleSidebar(); return true;');
    assert.equal(await run(first, visible('#sidebar')), false);
    await click(first, '#settings-btn');
    await wait(first, 'return app.settings.isOpen;');
    assert.equal(await run(first, visible('#sidebar .settings-list')), true);
    assert.equal(await run(first, visible('#settings-view')), true);
    assert.equal(
      await run(
        first,
        `return document.querySelector('.settings-view')
        .getBoundingClientRect().left;`,
      ),
      288,
    );
    await click(first, '#settings-exit');
    await wait(first, 'return !app.settings.isOpen && app.pops === 0;');
    assert.equal(await run(first, visible('#sidebar')), false);
    assert.equal(
      await run(first, `return app.app.classList.contains('sidebar-hidden');`),
      true,
    );
    await run(first, 'app.toggleSidebar(); return true;');
    assert.equal(await run(first, visible('#sidebar')), true);
  });

  await step('opening a chat with Ctrl+K closes settings', async () => {
    await run(
      first,
      `const input = document.getElementById('chat-name-input');
      input.value = 'second';
      document.getElementById('chat-form').requestSubmit();
      return true;`,
    );
    await wait(first, `return app.chat !== 'general';`);
    const second = await run(first, 'return app.chat;');
    await run(first, `app.selectChat('general'); return true;`);
    await click(first, '#settings-btn');
    await wait(first, 'return app.settings.isOpen;');
    await press(first, 'k', 'ctrlKey: true');
    await wait(first, 'return app.switcher.isOpen;');
    await run(
      first,
      `const input = document.querySelector('#switcher input');
      input.value = 'second';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new KeyboardEvent('keydown',
        { key: 'Enter', bubbles: true }));
      return true;`,
    );
    await wait(
      first,
      `return app.chat === ${JSON.stringify(second)} && !app.settings.isOpen
      && app.pops === 0 && app.layers.length === 0;`,
    );
    assert.equal(await run(first, visible('#chat-list')), true);
    assert.equal(await run(first, visible('#sidebar .settings-list')), false);
    assert.equal(await run(first, visible('#chat-view')), true);
    await run(first, `app.selectChat('general'); return true;`);
  });

  await step('a deep link opens the section and is replaced', async () => {
    const network = await open(`${ORIGIN}/?settings=network`);
    await wait(network, `return app.settings.section === 'network';`);
    assert.equal(
      await run(
        network,
        `return [location.search, app.settings.isOpen,
        document.getElementById('ice-url').offsetWidth > 0];`,
      ).then(String),
      ['', true, true].join(),
    );
    const unknown = await open(`${ORIGIN}/?settings=nothing`);
    await wait(unknown, `return app.settings.section === 'profile';`);
    assert.equal(
      await run(unknown, `return app.settings.isOpen && !location.search;`),
      true,
    );
  });

  await step('Esc closes the screen and keeps the chat and draft', async () => {
    await run(
      first,
      `const input = document.getElementById('message-input');
      input.value = 'half written';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      return true;`,
    );
    await click(first, '#settings-btn');
    await wait(first, 'return app.settings.isOpen;');
    assert.equal(await run(first, visible('#chat-view')), false);
    await press(first, 'Escape');
    await wait(
      first,
      `return !app.settings.isOpen && app.layers.length === 0 &&
        app.pops === 0 &&
        document.getElementById('message-input').value === 'half written'
        && document.getElementById('chat-view').offsetWidth > 0;`,
    );
    assert.equal(await run(first, 'return app.chat;'), 'general');
  });

  await step('Ctrl+K command opens Settings', async () => {
    await press(first, 'k', 'ctrlKey: true');
    await wait(first, 'return app.switcher.isOpen;');
    await run(
      first,
      `const input = document.querySelector('#switcher input');
      input.value = 'settings';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new KeyboardEvent('keydown',
        { key: 'Enter', bubbles: true }));
      return true;`,
    );
    await wait(first, `return app.settings.isOpen && !app.switcher.isOpen;`);
    await press(first, ',', 'ctrlKey: true');
    await press(first, 'Escape');
    await wait(first, 'return !app.settings.isOpen && app.pops === 0;');
    await press(first, ',', 'ctrlKey: true');
    await wait(first, 'return app.settings.isOpen;');
    await run(first, 'app.closeSettings(); return true;');
    await wait(first, 'return !app.settings.isOpen && app.pops === 0;');
  });

  await step(
    'Audio and video asks for access, then shows a meter',
    async () => {
      await run(
        first,
        `const devices = navigator.mediaDevices;
      const original = devices.getUserMedia.bind(devices);
      const list = devices.enumerateDevices.bind(devices);
      window.opened = [];
      window.calls = 0;
      window.hideNames = true;
      devices.getUserMedia = async (constraints) => {
        window.calls++;
        const stream = await original(constraints);
        window.opened.push(...stream.getTracks());
        window.hideNames = false;
        return stream;
      };
      devices.enumerateDevices = async () => {
        const items = await list();
        if (!window.hideNames) return items;
        return items.map(({ kind }) => ({ kind, deviceId: '', label: '' }));
      };
      app.openSettings('media');
      return true;`,
      );
      await wait(
        first,
        `const select = document.querySelector('[data-device=mic]');
      return select.disabled && select.options.length === 1 &&
        select.options[0].textContent ===
        'Allow camera and microphone to see device names' &&
        document.querySelector('[data-device=camera]').disabled;`,
      );
      assert.equal(
        await run(
          first,
          `const allow = document.querySelectorAll('.allow-devices');
        return [allow.length, allow[0].hidden, allow[1].hidden,
          window.calls, app.preferences.preview.isOn];`,
        ).then(String),
        '2,false,false,0,false',
      );
      await run(first, 'await new Promise((r) => setTimeout(r, 500));');
      assert.equal(await run(first, 'return window.calls;'), 0);
      await click(first, '.allow-devices');
      await wait(
        first,
        `const select = document.querySelector('[data-device=mic]');
      return !select.disabled && select.options.length > 1 &&
        document.querySelector('.allow-devices').hidden;`,
      );
      await wait(first, 'return app.preferences.preview.isOn;');
      await wait(
        first,
        `const bar = document.querySelector('.settings-meter .level-bar');
      return parseFloat(bar.style.width) > 0;`,
        30000,
      );
      await wait(
        first,
        `const video = document.querySelector('.device-preview');
      return video.srcObject?.getVideoTracks()[0]?.readyState === 'live' &&
        video.videoWidth > 0 && video.classList.contains('mirrored') &&
        video.offsetWidth > 0;`,
      );
      const kinds = await run(
        first,
        `return window.opened.filter((track) => track.readyState === 'live')
        .map((track) => track.kind).sort().join();`,
      );
      assert.equal(kinds, 'audio,video');
      await run(first, 'app.closeSettings(); return true;');
      await wait(
        first,
        `return window.opened.every((track) => track.readyState === 'ended') &&
        !app.preferences.preview.isOn;`,
      );
      await run(first, `app.openSettings('media'); return true;`);
      await wait(first, 'return app.preferences.preview.isOn;');
      await click(first, '.settings-list [data-section="network"]');
      await wait(
        first,
        `return !app.preferences.preview.isOn && window.opened.every(
        (track) => track.readyState === 'ended');`,
      );
      await run(first, 'app.closeSettings(); return true;');
    },
  );

  await step(
    'no preview in a call and tracks stop when it starts',
    async () => {
      await run(
        first,
        `app.openSettings('media');
      return true;`,
      );
      await wait(first, 'return app.preferences.preview.isOn;');
      await run(first, `await app.startCall('general'); return true;`);
      await wait(
        first,
        `return !app.settings.isOpen && !app.preferences.preview.isOn;`,
      );
      await click(first, '#prejoin [data-action=join]');
      await wait(first, `return app.callStage?.mode === 'call';`);
      await run(first, `app.openSettings('media'); return true;`);
      await wait(
        first,
        `return app.settings.isOpen && app.callStage.mode === 'mini' &&
        document.querySelector('[data-device=mic]').options.length > 1;`,
      );
      assert.equal(
        await run(first, 'return app.preferences.preview.isOn;'),
        false,
      );
      await run(
        first,
        `app.closeSettings(); await app.closeCall(); return true;`,
      );
      await wait(
        first,
        `return app.callStage?.mode !== 'mini' && !app.callSession;`,
      );
    },
  );

  await step('Audio and video lists devices and stores the mic', async () => {
    await run(
      first,
      `await navigator.mediaDevices.getUserMedia({ audio: true, video: true });
      app.openSettings('media');
      return true;`,
    );
    await wait(
      first,
      `const select = document.querySelector('[data-device=mic]');
      return select.options.length > 1;`,
    );
    const chosen = await run(
      first,
      `const select = document.querySelector('[data-device=mic]');
      select.selectedIndex = select.options.length - 1;
      select.dispatchEvent(new Event('change', { bubbles: true }));
      return select.value;`,
    );
    assert.notEqual(chosen, '');
    await wait(
      first,
      `return JSON.parse(localStorage.getItem('xxii:devices')).mic ===
        ${JSON.stringify(chosen)};`,
    );
    const camera = await run(
      first,
      `return document.querySelector('[data-device=camera]').options.length;`,
    );
    assert.equal(camera > 1, true);
    await run(first, 'app.closeSettings(); return true;');
  });

  await step('About shows the version and the update dot', async () => {
    await wait(
      first,
      `
      const button = document.getElementById('profile-version');
      const version = 'v' + app.version;
      return button.checkVisibility() && button.textContent === version;
    `,
    );
    assert.equal(
      await run(
        first,
        `
      const request = app.checkNow;
      let checked = false;
      app.checkNow = async () => { checked = true; };
      document.getElementById('profile-version').click();
      app.checkNow = request;
      return checked;
    `,
      ),
      true,
    );
    assert.equal(
      await run(
        first,
        `
        const get = (id) => document.getElementById(id);
        const rect = (id) => get(id).getBoundingClientRect();
        const version = rect('profile-version');
        const gear = rect('settings-btn');
        const recordings = rect('recordings-btn');
        return recordings.top === gear.top && recordings.right < gear.left &&
          version.top >= gear.bottom &&
          Math.abs(version.left + version.width / 2 -
            gear.left - gear.width / 2) < 1;
      `,
      ),
      true,
    );
    await run(first, `app.openSettings('about'); return true;`);
    const { version } = await run(first, 'return { version: app.version };');
    await wait(
      first,
      `return document.getElementById('version-text').textContent === 'v' +
        app.version;`,
    );
    assert.equal(version.length > 0, true);
    assert.equal(
      await run(
        first,
        `return document.getElementById('settings-dot').hidden;`,
      ),
      true,
    );
    await run(
      first,
      `app.nextVersion = '9.9.9';
      app.showVersion({ version: app.version, next: '9.9.9' });
      return true;`,
    );
    assert.equal(
      await run(
        first,
        `return [document.getElementById('settings-dot').hidden,
          document.getElementById('version-state').textContent,
          document.getElementById('version-btn').textContent,
          document.getElementById('settings-btn')
            .getAttribute('aria-label'),
          document.getElementById('notification').textContent].join('|');`,
      ),
      'false|Version 9.9.9 is ready|restart now|Settings, update ready|' +
        'Version 9.9.9 is ready · restart',
    );
    assert.equal(
      await run(
        first,
        `
      const restart = app.restart;
      let started = false;
      app.restart = async () => { started = true; };
      const button = document.getElementById('profile-version');
      button.click();
      app.restart = restart;
      return started && button.textContent === 'v9.9.9 ↑' &&
        button.previousElementSibling.id === 'settings-btn';
    `,
      ),
      true,
    );
    await run(
      first,
      `document.getElementById('notification').textContent = '';
      app.showVersion({ version: app.version, next: '9.9.9' });
      return true;`,
    );
    assert.equal(
      await run(
        first,
        `return document.getElementById('notification')
        .textContent;`,
      ),
      '',
    );
    await run(
      first,
      `app.nextVersion = '';
      app.showVersion({ version: app.version, next: '' });
      return true;`,
    );
  });

  await step('Diagnostics shows a line logged after opening', async () => {
    await run(first, `app.openSettings('about'); return true;`);
    await run(first, `app.logger.log('settings-test-line'); return true;`);
    assert.equal(
      await run(
        first,
        `return document.getElementById('output').textContent
          .includes('settings-test-line');`,
      ),
      true,
    );
    await run(first, 'app.closeSettings(); return true;');
  });

  const choose = (session, name, value) =>
    run(
      session,
      `const input = document.querySelector(
        '[data-appearance="${name}"][value="${value}"]');
      input.click();
      return input.checked;`,
    );
  const attribute = (session, name) =>
    run(session, `return document.documentElement.dataset.${name};`);
  const sizeOf = (session, selector) =>
    run(
      session,
      `return getComputedStyle(document.querySelector(
        ${JSON.stringify(selector)})).fontSize;`,
    );
  const emulate = (session, value) =>
    browser.request(
      'Emulation.setEmulatedMedia',
      { features: [{ name: 'prefers-color-scheme', value }] },
      session,
    );

  await step('light theme is set before the body is parsed', async () => {
    await run(first, `app.openSettings('appearance'); return true;`);
    assert.equal(await attribute(first, 'theme'), 'dark');
    assert.equal(await choose(first, 'theme', 'light'), true);
    await wait(
      first,
      `return document.documentElement.dataset.theme ===
      'light';`,
    );
    assert.deepEqual(
      await run(
        first,
        `return [
          document.querySelector('meta[name=color-scheme]').content,
          document.querySelector('meta[name=theme-color]').content,
          getComputedStyle(document.documentElement).colorScheme,
          getComputedStyle(document.body).backgroundColor,
          JSON.parse(localStorage.getItem('xxii:settings')).theme,
        ];`,
      ),
      ['light', '#eef1f4', 'light', 'rgb(238, 241, 244)', 'light'],
    );
    const source = `new MutationObserver((records, observer) => {
      if (!document.body) return;
      const { theme } = document.documentElement.dataset;
      localStorage.setItem('seen-theme', theme);
      observer.disconnect();
    }).observe(document, { childList: true, subtree: true });`;
    await browser.request('Page.enable', {}, first);
    const added = await browser.request(
      'Page.addScriptToEvaluateOnNewDocument',
      { source },
      first,
    );
    await browser.request('Page.reload', {}, first);
    await wait(
      first,
      `return localStorage.getItem('seen-theme') !== null;`,
      30000,
    );
    await wait(first, READY, 30000);
    assert.equal(
      await run(first, `return localStorage.getItem('seen-theme');`),
      'light',
    );
    await browser.request(
      'Page.removeScriptToEvaluateOnNewDocument',
      { identifier: added.identifier },
      first,
    );
    await run(first, `localStorage.removeItem('seen-theme'); return true;`);
    await run(first, `app.openSettings('appearance'); return true;`);
    assert.equal(
      await run(
        first,
        `return document.querySelector(
          '[data-appearance=theme][value=light]').checked;`,
      ),
      true,
    );
    await choose(first, 'theme', 'dark');
    await wait(
      first,
      `return document.documentElement.dataset.theme ===
      'dark';`,
    );
  });

  await step('system follows prefers-color-scheme live', async () => {
    await run(first, `app.openSettings('appearance'); return true;`);
    await emulate(first, 'light');
    await choose(first, 'theme', 'system');
    await wait(
      first,
      `return document.documentElement.dataset.theme ===
      'light';`,
    );
    assert.equal(
      await run(
        first,
        `return document.querySelector('meta[name=color-scheme]').content;`,
      ),
      'light',
    );
    await emulate(first, 'dark');
    await wait(
      first,
      `return document.documentElement.dataset.theme ===
      'dark';`,
    );
    await emulate(first, 'light');
    await wait(
      first,
      `return document.documentElement.dataset.theme ===
      'light';`,
    );
    await choose(first, 'theme', 'dark');
    await wait(
      first,
      `return document.documentElement.dataset.theme ===
      'dark';`,
    );
    await emulate(first, 'light');
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.equal(await attribute(first, 'theme'), 'dark');
    await emulate(first, '');
  });

  await step('text size changes messages and not the chrome', async () => {
    await run(
      first,
      `app.closeSettings(); app.selectChat('general');
      app.writeMessage('general', 'size sample', undefined, []); return true;`,
    );
    await wait(first, `return document.querySelector('.message .content');`);
    const content = '.message .content';
    const chrome = '#chat-list .name';
    assert.equal(await sizeOf(first, content), '13px');
    await run(first, `app.openSettings('appearance'); return true;`);
    assert.equal(await choose(first, 'textSize', 'xl'), true);
    await wait(
      first,
      `return document.documentElement.dataset.text ===
      'xl';`,
    );
    assert.equal(await sizeOf(first, content), '17px');
    assert.equal(await sizeOf(first, '#message-input'), '17px');
    assert.equal(await sizeOf(first, '.sample'), '17px');
    assert.equal(await sizeOf(first, chrome), '13px');
    assert.equal(await sizeOf(first, '.settings-list button'), '13px');
    await choose(first, 'textSize', 's');
    assert.equal(await sizeOf(first, content), '12px');
    await choose(first, 'density', 'compact');
    await wait(
      first,
      `return document.documentElement.dataset.density ===
      'compact';`,
    );
    assert.equal(
      await run(
        first,
        `return getComputedStyle(document.querySelector('.message'))
          .paddingTop;`,
      ),
      '1px',
    );
    await choose(first, 'textSize', 'm');
    await choose(first, 'density', 'comfortable');
    assert.equal(await sizeOf(first, content), '13px');
    await run(first, 'app.closeSettings(); return true;');
  });

  await step('another tab follows appearance through storage', async () => {
    const other = await open();
    await run(first, `app.openSettings('appearance'); return true;`);
    await choose(first, 'theme', 'light');
    await choose(first, 'textSize', 'l');
    await wait(
      other,
      `return document.documentElement.dataset.theme === 'light' &&
        document.documentElement.dataset.text === 'l';`,
      20000,
    );
    await run(other, `app.openSettings('appearance'); return true;`);
    assert.equal(
      await run(
        other,
        `return [
          document.querySelector('[data-appearance=theme][value=light]')
            .checked,
          document.querySelector('[data-appearance=textSize][value=l]')
            .checked,
        ].join();`,
      ),
      'true,true',
    );
    await run(other, `localStorage.removeItem('xxii:settings'); return true;`);
    await wait(
      first,
      `return document.documentElement.dataset.theme === 'dark' &&
        document.documentElement.dataset.text === 'm' &&
        document.querySelector('[data-appearance=theme][value=dark]')
          .checked;`,
      20000,
    );
    await run(first, `app.closeSettings(); return true;`);
  });

  await step(
    'on a phone Back closes the section, then the screen',
    async () => {
      const phone = await open(`${ORIGIN}/`, true);
      await click(phone, '#menu-btn');
      await wait(phone, `return app.layers.includes('sidebar');`);
      await click(phone, '#settings-btn');
      await wait(
        phone,
        `return app.settings.isOpen && app.pops === 0 &&
        app.settings.root.dataset.pane === 'list'
        && !app.layers.includes('sidebar');`,
      );
      await wait(
        phone,
        `const box = document.querySelector('#sidebar .settings-list')
        .getBoundingClientRect();
        const bar = document.querySelector('.profile-row')
        .getBoundingClientRect();
        return box.left >= 0 && box.width === innerWidth &&
          bar.left >= 0 && bar.bottom === innerHeight &&
          document.querySelector('.settings-view').offsetWidth === 0 &&
          document.getElementById('settings-btn').classList
          .contains('active');`,
        10000,
      );
      await click(phone, '.settings-list [data-section="network"]');
      await wait(
        phone,
        `return app.settings.root.dataset.pane === 'section' &&
        document.getElementById('ice-url').offsetWidth > 0 &&
        app.layers.join() === 'settings,settings-section';`,
      );
      await wait(
        phone,
        `const list = document.querySelector('#sidebar .settings-list')
        .getBoundingClientRect();
        const view = document.querySelector('.settings-view');
        const back = document.getElementById('settings-back');
        return list.right <= 0 && view.offsetWidth === innerWidth &&
          back.offsetWidth > 0 && document
          .getElementById('settings-section-name').textContent === 'Network';`,
        10000,
      );
      await run(phone, 'history.back(); return true;');
      await wait(
        phone,
        `return app.settings.isOpen && app.settings.root.dataset.pane === 'list'
        && app.layers.join() === 'settings';`,
      );
      await run(phone, 'history.back(); return true;');
      await wait(
        phone,
        `return !app.settings.isOpen && app.layers.length === 0;`,
      );
      await click(phone, '#menu-btn');
      await wait(phone, `return app.layers.includes('sidebar');`);
      await run(phone, `app.openSettings('profile'); return true;`);
      await wait(
        phone,
        `return app.settings.isOpen && app.settings.section === 'profile' &&
        app.settings.root.dataset.pane === 'section' &&
        app.layers.join() === 'settings,settings-section';`,
      );
      await click(phone, '#settings-close');
      await wait(
        phone,
        `return !app.settings.isOpen && app.layers.length === 0 &&
        app.pops === 0;`,
      );
    },
  );

  const dialogOpen = `const dialog = document.querySelector('dialog.confirm');
    return dialog !== null && dialog.open;`;
  const dialogGone = `return !document.querySelector('dialog.confirm');`;
  const text = (session, selector) =>
    run(session, `return document.querySelector('${selector}').textContent;`);
  const pressReal = async (session, key, code, windowsVirtualKeyCode) => {
    for (const type of ['keyDown', 'keyUp']) {
      const event = { type, key, code, windowsVirtualKeyCode };
      await browser.request('Input.dispatchKeyEvent', event, session);
    }
  };
  const storageRow = (kind) =>
    `[...document.querySelectorAll('[data-page=storage] .row')].find(
      (row) => row.querySelector('.row-label').textContent ===
        ${JSON.stringify(kind)})`;
  const countOf = `const root = await navigator.storage.getDirectory();
    const dir = await root.getDirectoryHandle('recordings', { create: true });
    let count = 0;
    for await (const entry of dir.values()) count++;
    return count;`;

  await step('Storage shows the total and a breakdown', async () => {
    await run(first, SEED_RECORDINGS);
    await run(
      first,
      `app.username = 'alex';
      app.writeMessage(app.chat, 'keep me', undefined, []);
      return true;`,
    );
    await run(first, `app.openSettings('storage'); return true;`);
    await wait(
      first,
      `const total = document.querySelector('.usage-text').textContent;
      const parts = document.querySelectorAll('.usage-part');
      return / of /.test(total) && parts.length === 4 &&
        !app.settings.storage.isCounting;`,
      30000,
    );
    const labels = await run(
      first,
      `return [...document.querySelectorAll('.usage-part')]
        .map((part) => part.textContent.split(' ')[0]).join();`,
    );
    assert.equal(labels, 'Messages,Files,Recordings,App');
    assert.equal(
      await run(
        first,
        `const part = (name) => document.querySelector(
          '.usage-bar [data-part=' + name + ']');
        return [
          parseFloat(part('recordings').style.width) > 0,
          document.querySelector('.usage-bar').getAttribute('role'),
          document.querySelector('.usage-parts').textContent
            .includes('Recordings 0 B'),
          app.settings.storage.isActive,
        ].join();`,
      ),
      'true,img,false,true',
    );
    await wait(
      first,
      `return ${storageRow('Delete recordings in this browser')}
        .querySelector('.row-note').textContent.startsWith('3 recordings');`,
    );
    await run(first, `app.closeSettings(); return true;`);
    await wait(first, 'return !app.settings.storage.isActive;');
  });

  await step('Keep data asks the browser and reports the answer', async () => {
    await run(first, `app.openSettings('storage'); return true;`);
    await wait(first, `return !app.settings.storage.isCounting;`, 30000);
    await run(
      first,
      `const keep = document.querySelector('[data-setting=keep]');
      keep.click();
      return true;`,
    );
    await wait(
      first,
      `const keep = document.querySelector('[data-setting=keep]');
      const note = keep.closest('.row').querySelector('.row-note')
        .textContent;
      return keep.checked
        ? keep.disabled && note === "The browser keeps this site's data"
        : !keep.disabled && note.startsWith('The browser declined');`,
    );
    assert.equal(
      await run(
        first,
        `const keep = document.querySelector('[data-setting=keep]');
        return keep.checked === await navigator.storage.persisted();`,
      ),
      true,
    );
    await run(first, `app.closeSettings(); return true;`);
  });

  await step('Clear messages and files asks first', async () => {
    await run(first, `app.openSettings('storage'); return true;`);
    await wait(first, `return !app.settings.storage.isCounting;`, 30000);
    const clear = `${storageRow('Clear messages and files')}
      .querySelector('button')`;
    await run(first, `${clear}.click(); return true;`);
    await wait(first, dialogOpen);
    assert.equal(
      await run(
        first,
        `const dialog = document.querySelector('dialog.confirm');
        const action = dialog.querySelector('.confirm-action');
        return [
          dialog.querySelector('.confirm-title').textContent,
          dialog.querySelector('.confirm-body').textContent,
          document.activeElement.classList.contains('confirm-cancel'),
          getComputedStyle(action).backgroundColor,
          action.textContent,
          getComputedStyle(dialog).borderTopWidth,
        ].join('|');`,
      ),
      'Clear messages and files?|Messages come back from the server and ' +
        'online peers. Files only this browser has are lost. Recordings ' +
        'and settings stay.|true|rgb(255, 59, 48)|clear|0px',
    );
    await pressReal(first, 'Escape', 'Escape', 27);
    await wait(first, dialogGone);
    assert.equal(await run(first, 'return app.settings.isOpen;'), true);
    await run(first, `${clear}.click(); return true;`);
    await wait(first, dialogOpen);
    await click(first, '.confirm-cancel');
    await wait(first, dialogGone);
    await run(
      first,
      `Object.defineProperty(navigator, 'onLine', {
        get: () => false, configurable: true });
      ${clear}.click();
      return true;`,
    );
    await wait(first, dialogOpen);
    assert.equal(
      (await text(first, '.confirm-body')).endsWith(
        'You are offline: nothing comes back until you reconnect.',
      ),
      true,
    );
    await click(first, '.confirm-cancel');
    await run(first, `delete navigator.onLine; return true;`);
    assert.equal(
      await run(
        first,
        `return [...app.replica.keys('message')].some((id) =>
          app.replica.get(id).content === 'keep me');`,
      ),
      true,
    );
  });

  await step('clear empties the local copy and keeps the rest', async () => {
    await run(
      first,
      `app.preferences.set('mirror', false);
      localStorage.setItem('xxii:keep', 'yes');
      window.log = app.replica.id;
      return true;`,
    );
    await run(
      first,
      `${storageRow('Clear messages and files')}
        .querySelector('button').click();
      return true;`,
    );
    await wait(first, dialogOpen);
    await click(first, '.confirm-action');
    await wait(
      first,
      `return app.replica.cleared.includes(window.log) &&
        document.querySelector('#notification').textContent ===
        'Messages and files cleared';`,
      30000,
    );
    await wait(
      first,
      `return [...app.replica.keys('message')].some((id) =>
        app.replica.get(id).content === 'keep me');`,
      30000,
    );
    assert.equal(await run(first, countOf), 3);
    assert.equal(
      await run(
        first,
        `return [localStorage.getItem('xxii:keep'),
          JSON.parse(localStorage.getItem('xxii:call-settings')).mirror,
        ].join();`,
      ),
      'yes,false',
    );
    await run(first, `app.closeSettings(); return true;`);
  });

  await step('Reset settings keeps the nick and destinations', async () => {
    const other = await open();
    await browser.request('Page.bringToFront', {}, first);
    await run(first, `app.openSettings('appearance'); return true;`);
    await choose(first, 'theme', 'light');
    await wait(
      other,
      `return document.documentElement.dataset.theme === 'light';`,
      20000,
    );
    const kept = JSON.stringify(
      JSON.stringify([{ id: 'd1', name: 'main', url: 'https://x.test/w' }]),
    );
    await run(
      first,
      `localStorage.setItem('xxii:destinations', ${kept});
      localStorage.setItem('xxii:call-volume:p-a', '150');
      localStorage.setItem('xxii:devices', '{"mic":"x"}');
      app.preferences.set('noise', 'strong');
      localStorage.setItem('xxii:ice', JSON.stringify({
        publicStun: true, forceRelay: false, servers: [] }));
      app.renderIce();
      app.openSettings('storage');
      return true;`,
    );
    await wait(first, `return !app.settings.storage.isCounting;`, 30000);
    const reset = `${storageRow('Reset settings')}.querySelector('button')`;
    await run(first, `${reset}.click(); return true;`);
    await wait(first, dialogOpen);
    const body = await text(first, '.confirm-body');
    assert.equal(body.includes('Your nick, peer id, drafts'), true);
    await click(first, '.confirm-cancel');
    await wait(first, dialogGone);
    assert.equal(await attribute(first, 'theme'), 'light');
    await run(first, `${reset}.click(); return true;`);
    await wait(first, dialogOpen);
    await click(first, '.confirm-action');
    await wait(
      first,
      `return document.documentElement.dataset.theme === 'dark' &&
        document.querySelector('#notification').textContent ===
        'Settings reset';`,
    );
    assert.equal(
      await run(
        first,
        `return [
          localStorage.getItem('xxii:settings'),
          localStorage.getItem('xxii:call-settings'),
          localStorage.getItem('xxii:devices'),
          localStorage.getItem('xxii:ice'),
          localStorage.getItem('xxii:call-volume:p-a'),
          app.preferences.settings.noise,
          document.getElementById('ice-public-stun').checked,
          localStorage.getItem('xxii:nick'),
          localStorage.getItem('xxii:destinations') === ${kept},
        ].join();`,
      ),
      ',,,,,standard,false,alex,true',
    );
    await wait(
      other,
      `return document.documentElement.dataset.theme === 'dark';`,
      20000,
    );
    await run(first, `app.closeSettings(); return true;`);
  });

  await step('Delete recordings clears the library', async () => {
    await run(first, `app.openSettings('storage'); return true;`);
    await wait(
      first,
      `return ${storageRow('Delete recordings in this browser')}
        .querySelector('.row-note').textContent.startsWith('3 recordings');`,
      30000,
    );
    const row = storageRow('Delete recordings in this browser');
    await run(
      first,
      `app.capture = { isActive: true, context: () => ({}) };
      app.renderRecordingsState();
      return true;`,
    );
    assert.equal(
      await run(
        first,
        `const button = ${row}.querySelector('button');
        return [button.disabled, button.title].join();`,
      ),
      'true,Allowed only while not recording',
    );
    await run(
      first,
      `app.capture = null;
      app.renderRecordingsState();
      ${row}.querySelector('button').click();
      return true;`,
    );
    await wait(first, dialogOpen);
    const body = await text(first, '.confirm-body');
    assert.equal(
      /^3 recordings \(.+\) will be deleted from this browser\./.test(body),
      true,
    );
    assert.equal(body.includes('Copies saved to a folder'), true);
    await click(first, '.confirm-cancel');
    await wait(first, dialogGone);
    assert.equal(await run(first, countOf), 3);
    await run(first, `${row}.querySelector('button').click(); return true;`);
    await wait(first, dialogOpen);
    await click(first, '.confirm-action');
    await wait(
      first,
      `return document.querySelector('#notification').textContent ===
        'Deleted 3 recordings' && ${row}.querySelector('.row-note')
        .textContent === 'No recordings in this browser';`,
      30000,
    );
    assert.equal(await run(first, countOf), 0);
    await run(first, `app.openLibrary(); return true;`);
    await wait(
      first,
      `return app.recordingsView.isOpen &&
        document.querySelectorAll('.recordings-list .recording-item')
        .length === 0 && document.querySelector('.recordings-status')
        .textContent === 'No recordings yet.';`,
    );
    await run(first, `app.closeRecordings(); return true;`);
  });

  assert.deepEqual(browser.errors, []);
});
