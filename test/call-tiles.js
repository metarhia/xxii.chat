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
const CAPTURED = `const media = app.callStage.media;
  if (media.screenPending) return false;
  if (!media.screenTrack) throw new Error(media.message || 'no screen');
  return media.screenTrack.readyState === 'live';`;

const openPerson = async (t, browser) => {
  const { browserContextId } = await browser.request(
    'Target.createBrowserContext',
  );
  t.after(() =>
    browser
      .request('Target.disposeBrowserContext', {
        browserContextId,
      })
      .catch(() => undefined),
  );
  const { targetId } = await browser.request('Target.createTarget', {
    url: `${ORIGIN}/`,
    browserContextId,
  });
  const { sessionId } = await browser.request('Target.attachToTarget', {
    targetId,
    flatten: true,
  });
  await browser.request('Runtime.enable', {}, sessionId);
  await browser.request('Page.enable', {}, sessionId);
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    const ready = await browser
      .evaluate(sessionId, 'document.readyState')
      .catch(() => '');
    if (ready === 'complete') break;
    await delay(50);
  }
  await harness.wait(browser, sessionId, READY);
  return sessionId;
};

const waitFor = async (browser, session, body) => {
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    const result = await harness.run(browser, session, body).catch(() => false);
    if (result) return;
    await delay(100);
  }
  const result = await harness.run(browser, session, body);
  throw new Error(`Tile condition failed: ${JSON.stringify(result)}`);
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

const tileFor = (endpoint, slot = 'camera') => {
  const id = JSON.stringify(endpoint);
  return `const tile = [...document.querySelectorAll('.call-tile')].find(
    (item) => item.dataset.endpoint === ${id} &&
      item.dataset.slot === '${slot}');
    if (!tile) throw new Error('Missing tile');`;
};

const openMenu = (endpoint) => `${tileFor(endpoint)}
  tile.querySelector('[data-action="tile-menu"]').click();`;
const setVolume = (endpoint, value) => `${openMenu(endpoint)}
  const input = document.querySelector('.tile-volume input');
  input.value = '${value}';
  input.dispatchEvent(new Event('input', { bubbles: true }));
  app.callStage.tileMenu.close();`;
const volumeCheck = (endpoint, value) => `const entries =
  [...app.callStage.volume.entries.values()].filter(
    (entry) => entry.audio.dataset.endpoint === ${JSON.stringify(endpoint)});
  return entries.length === 2 && entries.every((entry) =>
    entry.audio.isConnected && entry.audio.volume === 0 &&
    entry.source && entry.gain.gain.value === ${value / 100});`;

const checkMenu = async (browser, session, endpoint) => {
  const run = (body) => harness.run(browser, session, body);
  assert.equal(
    await run(`${openMenu(endpoint)}
    const menu = app.callStage.tileMenu;
    return menu.menu.isOpen && menu.element.contains(document.activeElement) &&
      tile.querySelector('[data-action="tile-menu"]').getAttribute(
        'aria-expanded') === 'true';`),
    true,
  );
  await run(`document.activeElement.dispatchEvent(new KeyboardEvent('keydown',
    { key: 'Escape', bubbles: true }));`);
  assert.equal(
    await run(`${tileFor(endpoint)}
    return !app.callStage.tileMenu.menu.isOpen && document.activeElement ===
      tile.querySelector('[data-action="tile-menu"]');`),
    true,
  );
  await run(`${openMenu(endpoint)}
    app.callStage.tileMenu.element.querySelector(
      '[data-action="pin"]').click();`);
  assert.equal(
    await run(`${tileFor(endpoint)}
    return tile.classList.contains('pinned');`),
    true,
  );
  await run(`${openMenu(endpoint)}
    app.callStage.tileMenu.element.querySelector(
      '[data-action="pin"]').click();`);
  await run(`${tileFor(endpoint)}
    tile.dispatchEvent(new PointerEvent('pointerdown', {
      pointerType: 'touch', clientX: 100, clientY: 100, bubbles: true }));`);
  await waitFor(browser, session, 'return app.callStage.tileMenu.menu.isOpen;');
  await run(`document.dispatchEvent(new PointerEvent('pointerup', {
    pointerType: 'touch', bubbles: true }));
    app.callStage.tileMenu.close();`);
  await delay(450);
  const fullscreen = await run(`return document.fullscreenEnabled;`);
  if (fullscreen) {
    await gesture(
      browser,
      session,
      `${openMenu(endpoint)}
      app.callStage.tileMenu.element.querySelector(
        '[data-action="tile-fullscreen"]').click();`,
    );
    await waitFor(
      browser,
      session,
      `${tileFor(endpoint)}
      return document.fullscreenElement === tile;`,
    );
    await gesture(browser, session, 'await document.exitFullscreen();');
  }
};

const measureAudio = async (browser, session, endpoint) => {
  await harness.run(
    browser,
    session,
    `const entry =
    [...app.callStage.volume.entries.values()].find((item) =>
      item.audio.dataset.endpoint === ${JSON.stringify(endpoint)} &&
      item.audio.dataset.slot === 'mic');
    const context = app.callStage.volume.context;
    const analyser = context.createAnalyser();
    analyser.fftSize = 2048;
    const sink = context.createMediaStreamDestination();
    entry.gain.connect(analyser);
    analyser.connect(sink);
    globalThis.tileMeter = { analyser, sink, gain: entry.gain };`,
  );
  const rms = () =>
    harness.run(
      browser,
      session,
      `
    const meter = globalThis.tileMeter;
    const values = new Float32Array(meter.analyser.fftSize);
    meter.analyser.getFloatTimeDomainData(values);
    return Math.sqrt(values.reduce((sum, value) => sum + value * value, 0) /
      values.length);`,
    );
  await harness.run(browser, session, setVolume(endpoint, 100));
  await waitFor(
    browser,
    session,
    `const values = new Float32Array(2048);
    globalThis.tileMeter.analyser.getFloatTimeDomainData(values);
    return values.some((value) => Math.abs(value) > 0.01);`,
  );
  await delay(200);
  const normal = await rms();
  await harness.run(browser, session, setVolume(endpoint, 200));
  await delay(200);
  const boosted = await rms();
  assert.ok(
    boosted / normal > 1.7 && boosted / normal < 2.3,
    `Expected 2x audio, got ${boosted / normal}`,
  );
  await harness.run(browser, session, setVolume(endpoint, 0));
  await delay(200);
  const silent = await rms();
  assert.ok(silent < 0.001);
  await harness.run(
    browser,
    session,
    `const meter = globalThis.tileMeter;
    meter.gain.disconnect(meter.analyser);
    meter.analyser.disconnect();
    for (const track of meter.sink.stream.getTracks()) track.stop();`,
  );
};

test(
  'tile menus, participant volume, real stats and restoration',
  {
    timeout: 120000,
  },
  async (t) => {
    await startCallServer(t);
    const browser = await launch(t, FLAGS);
    const run = (session, body) => harness.run(browser, session, body);
    const left = await openPerson(t, browser);
    const right = await openPerson(t, browser);
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
    await app.startCall('general', { token: ${JSON.stringify(host.token)} });`,
    );
    await run(right, JOIN);
    const endpoint = await run(right, 'return app.callSession.endpoint;');
    await browser.request('Page.bringToFront', {}, left);
    await waitFor(
      browser,
      left,
      `${tileFor(endpoint)}
    return tile.querySelector('video').videoWidth > 0;`,
    );

    await checkMenu(browser, left, endpoint);
    assert.equal(
      await run(
        left,
        `app.callSession.emit('quality', {
      endpoint: ${JSON.stringify(endpoint)}, poor: true, audioOnly: false });
      ${tileFor(endpoint)}
      const suggestion = tile.querySelector('.call-poor');
      return !suggestion.classList.contains('hidden') &&
        suggestion.textContent.includes('try audio only') &&
        !app.callStage.tileMenu.menu.isOpen;`,
      ),
      true,
    );
    assert.equal(
      await run(
        left,
        `${tileFor(endpoint)}
      tile.querySelector('.call-poor').click();
      return app.callSession.isAudioOnly(${JSON.stringify(endpoint)}) &&
        tile.querySelector('.call-poor').classList.contains('hidden');`,
      ),
      true,
    );
    await run(
      left,
      `app.callSession.setAudioOnly(
      ${JSON.stringify(endpoint)}, false);
      app.callSession.emit('quality', { endpoint: ${JSON.stringify(endpoint)},
        poor: false, audioOnly: false });`,
    );

    await run(
      left,
      `${openMenu(endpoint)}
    app.callStage.tileMenu.element.querySelector(
      '[data-action="tile-stats"]').click();`,
    );
    await waitFor(
      browser,
      left,
      `${tileFor(endpoint)}
    const text = tile.querySelector('.tile-stats').textContent;
    return /RTT \\d+ ms/.test(text) && /video[/]/.test(text) &&
      /\\d+×\\d+/.test(text) && /\\d+ fps/.test(text) &&
      /\\d+ kbps/.test(text) &&
      /Candidates (host|srflx|prflx|relay)/.test(text);`,
    );
    assert.equal(
      await run(
        left,
        `${tileFor(endpoint)}
    const overlay = tile.querySelector('.tile-stats');
    const bars = tile.querySelector('.connection-bars');
    return !overlay.classList.contains('hidden') &&
      bars.getAttribute('aria-label').includes('of 4');`,
      ),
      true,
    );
    await run(
      left,
      `document.querySelector('#call-view [data-action="more"]').click();
    document.querySelector(
      '.call-bar-menu [data-action="stats-overlay"]').click();
    app.callStage.controls.menu.close();`,
    );
    await run(
      left,
      `${openMenu(endpoint)}
    app.callStage.tileMenu.element.querySelector(
      '[data-action="tile-stats"]').click();`,
    );
    assert.equal(
      await run(
        left,
        `${tileFor(endpoint)}
    return tile.querySelector('.tile-stats').classList.contains(
      'hidden');`,
      ),
      true,
    );
    await run(
      right,
      `const context = new AudioContext();
    await context.resume();
    const oscillator = context.createOscillator();
    const gain = context.createGain();
    const destination = context.createMediaStreamDestination();
    gain.gain.value = 0.1;
    oscillator.connect(gain);
    gain.connect(destination);
    oscillator.start();
    globalThis.tileAudio = { context, oscillator };
    app.callStage.media.useMic(destination.stream.getAudioTracks()[0]);`,
    );
    await gesture(browser, right, `app.callStage.media.openScreen(true);`);
    await waitFor(browser, right, CAPTURED);
    await waitFor(
      browser,
      left,
      `return [...app.callStage.audios.values()].filter(
    (audio) => audio.dataset.endpoint ===
      ${JSON.stringify(endpoint)}).length === 2;`,
    );
    await gesture(browser, left, setVolume(endpoint, 200));
    await waitFor(browser, left, volumeCheck(endpoint, 200));
    for (const value of [0, 100, 200]) {
      await run(left, setVolume(endpoint, value));
      assert.equal(await run(left, volumeCheck(endpoint, value)), true);
    }
    await measureAudio(browser, left, endpoint);
    await run(
      left,
      `${openMenu(endpoint)}
    [...app.callStage.tileMenu.element.querySelectorAll('button')].find(
      (button) => button.textContent === 'Reset volume to 100%').click();
    app.callStage.tileMenu.close();`,
    );
    assert.equal(await run(left, volumeCheck(endpoint, 100)), true);
    await run(left, setVolume(endpoint, 175));
    await run(
      right,
      `app.callStage.media.stopScreen();
    globalThis.tileAudio.oscillator.stop();
    await globalThis.tileAudio.context.close();
    await app.closeCall();`,
    );
    await waitFor(
      browser,
      left,
      `return app.callStage.people.length === 1 &&
    app.callStage.volume.entries.size === 0 &&
    !app.callStage.stats.has(${JSON.stringify(endpoint)});`,
    );
    await run(
      right,
      `await app.startCall('general', {
    token: ${JSON.stringify(host.token)} });`,
    );
    await run(right, JOIN);
    await waitFor(
      browser,
      left,
      `return app.callStage.audios.size === 1 &&
    [...app.callStage.volume.entries.values()].every(
      (entry) => entry.gain?.gain.value === 1.75);`,
    );
    await run(
      left,
      `globalThis.previousVolume = app.callStage.volume;
    globalThis.previousContext = app.callStage.volume.context;
    await app.closeCall();`,
    );
    assert.equal(
      await run(
        left,
        `return globalThis.previousVolume.entries.size === 0 &&
    globalThis.previousContext.state === 'closed' &&
    document.querySelector('.call-tile-menu') === null;`,
      ),
      true,
    );
    await run(
      left,
      `await app.startCall('general', {
    token: ${JSON.stringify(host.token)} });`,
    );
    await run(left, JOIN);
    await waitFor(
      browser,
      left,
      `return app.callStage.audios.size === 1 &&
    [...app.callStage.volume.entries.values()].every(
      (entry) => entry.gain?.gain.value === 1.75);`,
    );
    await run(right, 'await app.closeCall();');
    await run(left, 'await app.closeCall();');
  },
);
