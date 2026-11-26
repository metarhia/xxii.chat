'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { setTimeout: delay } = require('node:timers/promises');
const harness = require('./harness.js');

const ready = 'return app.connected && app.mesh.peers.has(app.peerId);';
const joined = `return app.callStage?.mode === 'call';`;
const setup = `Object.defineProperty(navigator.mediaDevices, 'getDisplayMedia',
  { value: undefined });
  localStorage.setItem('xxii:nick', 'alex');
  window.showDirectoryPicker = async () => {
    const root = await navigator.storage.getDirectory();
    return root.getDirectoryHandle('Call recordings', { create: true });
  };
  window.screenLocks = [];
  Object.defineProperty(navigator, 'wakeLock', { value: {
    async request() {
      const lock = new EventTarget();
      lock.released = false;
      lock.release = async () => {
        lock.released = true;
        lock.dispatchEvent(new Event('release'));
      };
      window.screenLocks.push(lock);
      return lock;
    }
  }});`;

test(
  'saved call settings and the phone stage',
  { timeout: 120000 },
  async (t) => {
    await harness.startCallServer(t);
    const browser = await harness.launch(t, harness.MEDIA_FLAGS);
    const blank = await browser.request('Target.createTarget', {
      url: 'about:blank',
    });
    const page = await browser.request('Target.attachToTarget', {
      ...blank,
      flatten: true,
    });
    const session = page.sessionId;
    const request = (method, params = {}) =>
      browser.request(method, params, session);
    const run = (body) => harness.run(browser, session, body);
    const wait = (body) => harness.wait(browser, session, body);
    await request('Page.enable');
    await request('Runtime.enable');
    await request('Emulation.setDeviceMetricsOverride', {
      width: 390,
      height: 844,
      mobile: true,
      deviceScaleFactor: 2,
    });
    await request('Emulation.setTouchEmulationEnabled', { enabled: true });
    await request('Emulation.setUserAgentOverride', {
      userAgent: 'Mozilla/5.0 (Linux; Android 15) Chrome/157.0 Mobile',
    });
    await request('Page.addScriptToEvaluateOnNewDocument', { source: setup });
    await request('Page.navigate', { url: harness.ORIGIN });
    await wait(ready);
    await run(`app.openSettings('media');
    const flags = ['pushToTalk', 'autoLower', 'joinMicOff'];
    for (const name of flags.concat(['joinCameraOff', 'mirror'])) {
      document.querySelector('[data-setting="' + name + '"]').click();
    }
    const select = document.querySelector('[data-setting=recordingAudio]');
    select.value = 'duck';
    select.dispatchEvent(new Event('change', { bubbles: true }));
    document.querySelector('.record-folder').click();
    sessionStorage.setItem('firstPage', String(performance.timeOrigin));`);
    const folder = `return document.querySelector('.record-folder')
      .textContent.includes('Call recordings');`;
    await wait(folder);
    await request('Page.reload');
    await wait(`const now = String(performance.timeOrigin);
      return sessionStorage.firstPage !== now
    && app.connected && app.mesh.peers.has(app.peerId);`);
    await wait(folder);
    await run(`app.openSettings('media');`);
    assert.deepEqual(
      await run(`const flags = ['pushToTalk', 'autoLower', 'joinMicOff'];
        return flags.concat(['mirror', 'recordingAudio'])
    .map((name) => {
      const field = document.querySelector('[data-setting="' + name + '"]');
      return field.type === 'checkbox' ? field.checked : field.value;
    });`),
      [false, false, true, false, 'duck'],
    );
    await run(
      `app.closePanel(); app.selectChat('general');
        await app.startCall('general');`,
    );
    assert.equal(await run('return app.callStage.media.cameraOn;'), false);
    await run(
      `document.querySelector('#prejoin [data-action=camera]').click();`,
    );
    await wait('return !!app.callStage.media.cameraTrack;');
    assert.equal(
      await run('return app.callStage.media.micTrack === null;'),
      true,
    );
    await run(`document.querySelector('#prejoin [data-action=join]').click();`);
    await wait(joined);
    await wait('return window.screenLocks.length === 1;');
    const press = async (key, code, vk, target = '') => {
      if (target) {
        await run(`document.querySelector(${JSON.stringify(target)}).focus();`);
      }
      const args = {
        key,
        code,
        windowsVirtualKeyCode: vk,
        nativeVirtualKeyCode: vk,
      };
      const down =
        key === 'Enter'
          ? { type: 'keyDown', text: '\r' }
          : { type: 'rawKeyDown' };
      await request('Input.dispatchKeyEvent', { ...args, ...down });
      await request('Input.dispatchKeyEvent', { ...args, type: 'keyUp' });
    };
    await run('document.activeElement.blur();');
    await request('Input.dispatchKeyEvent', {
      key: ' ',
      code: 'Space',
      type: 'rawKeyDown',
      windowsVirtualKeyCode: 32,
    });
    assert.equal(
      await run('return app.callStage.media.micOn || app.callStage.talk.held;'),
      false,
    );
    await request('Input.dispatchKeyEvent', {
      key: ' ',
      code: 'Space',
      type: 'keyUp',
    });
    const enter = (selector) => press('Enter', 'Enter', 13, selector);
    await enter('.call-controls [data-action=reactions]');
    await enter('.call-bar-menu [data-action=hand]');
    await wait('return app.callStage.isHandRaised();');
    await run(`const stage = app.callStage;
    const me = stage.levels.state.participants.get(stage.session.endpoint);
    me.speaking = true;
    stage.lowerState.since = performance.now() - 4000;
    stage.checkAutoLower();`);
    await delay(250);
    assert.equal(await run('return app.callStage.isHandRaised();'), true);
    const bounds = await run(`const rect = (q) =>
      document.querySelector(q).getBoundingClientRect();
    const stage = rect('.call-stage');
    const controls = rect('.call-controls');
    return [stage.left, stage.top, stage.width, controls.bottom,
      document.querySelector('.call-share').offsetWidth];`);
    assert.deepEqual(bounds, [0, 0, 390, 844, 0]);
    await enter('.call-controls [data-action=camera-menu]');
    await enter('.call-bar-menu [data-action="switch-camera"]');
    await wait(`return app.callStage.media.facing === 'environment' &&
    app.callStage.media.cameraTrack?.readyState === 'live';`);
    await press('Escape', 'Escape', 27);
    await wait('return !app.callStage.controls.menu.isOpen;');

    const other = await browser.request('Target.createTarget', {
      url: 'about:blank',
    });
    await browser.request('Target.activateTarget', other);
    await wait(`const m = app.callStage.media;
    const name = document.querySelector('.call-tile.local .call-name');
    return document.hidden && m.cameraPaused && !m.cameraTrack &&
      name.textContent.includes('camera paused');`);
    await browser.request('Target.closeTarget', other);
    await request('Page.bringToFront');
    await wait(`const m = app.callStage.media;
      return !m.cameraPaused && !!m.cameraTrack &&
    window.screenLocks.length >= 2 && window.screenLocks[0].released;`);

    await enter('.call-controls [data-action=more]');
    await enter('.call-bar-menu [data-action=people]');
    await wait(`return app.callStage.sheet === 'people' &&
    document.activeElement.dataset.action === 'close-sheet';`);
    await run('history.back();');
    await wait(`return !app.callStage.sheet && app.callStage.mode === 'call';`);
    await enter('.call-controls [data-action=more]');
    await enter('.call-bar-menu [data-action=chat]');
    await wait(`return app.callStage.sheet === 'chat' &&
    document.activeElement.dataset.action === 'close-sheet';`);
    await enter('.call-tabs-close');
    await wait('return !app.callStage.sheet && app.pops === 0;');
    await enter('.call-controls [data-action=more]');
    await enter('.call-bar-menu [data-action=settings]');
    await wait(
      `return app.settings.isOpen && app.settings.section === 'media'
        && app.settings.root.dataset.pane === 'section'
        && app.callStage.mode === 'mini';`,
    );
    await run('history.back();');
    await wait(
      `return app.settings.isOpen &&
        app.settings.root.dataset.pane === 'list';`,
    );
    await run('history.back();');
    await wait(
      `return !app.settings.isOpen && app.callStage.mode === 'mini' &&
        app.callSession.phase === 'joined';`,
    );
    await run('await app.closeCall();');
    await wait('return window.screenLocks.every((lock) => lock.released);');
    assert.deepEqual(browser.errors, []);
  },
);
