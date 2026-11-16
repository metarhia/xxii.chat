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
    url: `${ORIGIN}/?test`,
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
  throw new Error(`Layout condition failed: ${JSON.stringify(result)}`);
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

const pressFullscreen = async (browser, session) => {
  await harness.run(browser, session, 'document.activeElement?.blur();');
  const key = {
    key: 'f',
    code: 'KeyF',
    windowsVirtualKeyCode: 70,
    nativeVirtualKeyCode: 70,
  };
  await browser.request(
    'Input.dispatchKeyEvent',
    {
      ...key,
      type: 'keyDown',
    },
    session,
  );
  await browser.request(
    'Input.dispatchKeyEvent',
    {
      ...key,
      type: 'keyUp',
    },
    session,
  );
};

const setView = (
  layout,
) => `const select = document.querySelector('#call-layout');
  select.value = '${layout}';
  select.dispatchEvent(new Event('change', { bubbles: true }));
  return document.querySelector('.call-grid').dataset.layout === '${layout}';`;

const tileFor = (endpoint, slot = 'camera') => {
  const id = JSON.stringify(endpoint);
  return `const tile = [...document.querySelectorAll('.call-tile')].find(
    (item) => item.dataset.endpoint === ${id} &&
      item.dataset.slot === '${slot}');
    if (!tile) throw new Error('Missing tile');`;
};

const checkFullscreen = async (t, browser, session, endpoint) => {
  const available = await harness.run(
    browser,
    session,
    `const view =
    document.querySelector('#call-view');
    return document.fullscreenEnabled === true &&
      typeof view.requestFullscreen === 'function';`,
  );
  await pressFullscreen(browser, session);
  if (!available) {
    await waitFor(
      browser,
      session,
      `const note = document.querySelector(
      '#call-view .call-note');
      const visible = !note.classList.contains('hidden');
      return !document.fullscreenElement && visible &&
        /Full screen is unavailable|could not enter full screen/.test(
          note.textContent);`,
    );
    t.diagnostic('Full screen is unavailable; verified the visible notice.');
    return;
  }
  await waitFor(
    browser,
    session,
    `return document.fullscreenElement ===
    document.querySelector('#call-view');`,
  );
  await pressFullscreen(browser, session);
  await waitFor(
    browser,
    session,
    'return document.fullscreenElement === null;',
  );
  const action = `app.callStage.onAction('tile-fullscreen',
    ${JSON.stringify(endpoint)}, 'camera');`;
  await gesture(browser, session, action);
  await waitFor(
    browser,
    session,
    `${tileFor(endpoint)}
    return document.fullscreenElement === tile;`,
  );
  await gesture(browser, session, action);
  await waitFor(
    browser,
    session,
    'return document.fullscreenElement === null;',
  );
};

test(
  'call layouts, pinning, visibility, active speaker and screen Auto',
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
    await waitFor(
      browser,
      right,
      `return app.callSession?.linkCount === 1 &&
    app.callStage.people.length === 2;`,
    );
    const remote = await run(right, 'return app.callSession.endpoint;');
    await browser.request('Page.bringToFront', {}, left);
    await waitFor(
      browser,
      left,
      `${tileFor(remote)}
    return tile.querySelector('video').videoWidth > 0;`,
    );
    await checkFullscreen(t, browser, left, remote);
    for (const layout of ['grid', 'spotlight', 'sidebar']) {
      assert.equal(await run(left, setView(layout)), true);
    }
    await run(
      left,
      `${tileFor(remote)}
    tile.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));`,
    );
    assert.equal(
      await run(
        left,
        `${tileFor(remote)}
    return tile.classList.contains('pinned') &&
      tile.classList.contains('featured');`,
      ),
      true,
    );
    await run(
      left,
      `${tileFor(remote)}
    tile.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));`,
    );
    assert.equal(await run(left, `return app.callStage.pin === '';`), true);
    await run(
      left,
      `document.querySelector('[data-action="hide-self"]').click();`,
    );
    assert.equal(
      await run(
        left,
        `${tileFor(host.endpoint)}
    return tile.hidden;`,
      ),
      true,
    );
    await run(
      left,
      `document.querySelector('[data-action="hide-self"]').click();`,
    );
    await run(right, `await app.callStage.toggle('camera');`);
    await waitFor(
      browser,
      left,
      `${tileFor(remote)}
    return !tile.querySelector('.avatar-wrap').classList.contains('hidden') &&
      tile.querySelector('.call-name').textContent.includes('mic on');`,
    );
    await run(
      left,
      `document.querySelector('[data-action="hide-no-video"]').click();`,
    );
    assert.equal(
      await run(left, `${tileFor(remote)} return tile.hidden;`),
      true,
    );
    await run(
      left,
      `document.querySelector('[data-action="hide-no-video"]').click();`,
    );
    await run(left, `await app.callStage.toggle('mic');`);
    await run(
      right,
      `const context = new AudioContext();
    await context.resume();
    const oscillator = context.createOscillator();
    const gain = context.createGain();
    const destination = context.createMediaStreamDestination();
    gain.gain.value = 0.5;
    oscillator.connect(gain);
    gain.connect(destination);
    oscillator.start();
    globalThis.layoutAudio = { context, oscillator };
    app.callStage.media.useMic(destination.stream.getAudioTracks()[0]);`,
    );
    await waitFor(
      browser,
      left,
      `const receiver = app.callSession.receiver(
    ${JSON.stringify(remote)}, 'mic');
    return receiver?.getSynchronizationSources().some(
      (source) => source.audioLevel > 0.05);`,
    );
    await waitFor(
      browser,
      left,
      `${tileFor(remote)}
    return tile.classList.contains('speaking') &&
      app.callStage.levels.state.speaker === ${JSON.stringify(remote)} &&
      parseFloat(tile.style.getPropertyValue('--speaking-ring')) > 0;`,
    );
    await run(left, `app.callStage.collapse();`);
    assert.equal(
      await run(
        left,
        `const mini = document.querySelector('#mini-call');
    return mini.dataset.endpoint === ${JSON.stringify(remote)} &&
      mini.classList.contains('speaking');`,
      ),
      true,
    );
    await run(left, 'app.callStage.expand();');
    await run(
      left,
      `const select = document.querySelector('#call-layout');
    select.value = 'auto';
    select.dispatchEvent(new Event('change', { bubbles: true }));`,
    );
    await gesture(
      browser,
      left,
      `const button = document.querySelector(
      '#call-view [data-action="share-call"]');
      if (!button) throw new Error('Missing share to call control');
      button.click();`,
    );
    await waitFor(browser, left, CAPTURED);
    await waitFor(
      browser,
      left,
      `${tileFor(host.endpoint, 'screen')}
    const layout = document.querySelector('.call-grid').dataset.layout;
    return layout === 'spotlight' && tile.classList.contains('featured');`,
    );
    await run(left, `app.callStage.togglePin(${JSON.stringify(remote)});`);
    assert.equal(
      await run(
        left,
        `${tileFor(remote)}
    return tile.classList.contains('featured');`,
      ),
      true,
    );
    await run(
      left,
      `app.callStage.togglePin(${JSON.stringify(remote)});
    app.callStage.setLayout('auto');
    app.callStage.media.stopScreen();`,
    );
    await waitFor(
      browser,
      left,
      `return document.querySelector(
    '.call-grid').dataset.layout === 'grid' &&
      !document.querySelector('.screen-tile');`,
    );
    await run(
      right,
      `globalThis.layoutAudio.oscillator.stop();
    await globalThis.layoutAudio.context.close();
    await app.closeCall();`,
    );
    await waitFor(
      browser,
      left,
      `return app.callStage.people.length === 1 &&
    !app.callStage.remote.has(${JSON.stringify(remote)}) &&
    !app.callStage.levels.state.participants.has(${JSON.stringify(remote)}) &&
    !app.callStage.audios.has(${JSON.stringify(remote)});`,
    );
    await run(left, 'await app.closeCall();');
  },
);
