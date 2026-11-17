'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { setTimeout: delay } = require('node:timers/promises');

const harness = require('./harness.js');

const { MEDIA_FLAGS, ORIGIN, launch, startCallServer } = harness;
const FLAGS = MEDIA_FLAGS.concat([
  '--disable-features=WebRtcHideLocalIpsWithMdns',
]);
const READY =
  'return app.connected === true && app.mesh.peers.has(app.peerId);';
const JOIN = `document.querySelector('#prejoin [data-action=join]').click();
  return true;`;

const openPerson = async (t, browser) => {
  const created = await browser.request('Target.createBrowserContext');
  const { browserContextId } = created;
  t.after(() =>
    browser
      .request('Target.disposeBrowserContext', {
        browserContextId,
      })
      .catch(() => undefined),
  );
  const url = `${ORIGIN}/`;
  const { targetId } = await browser.request('Target.createTarget', {
    url,
    browserContextId,
  });
  const target = await browser.request('Target.attachToTarget', {
    targetId,
    flatten: true,
  });
  const { sessionId } = target;
  await browser.request('Runtime.enable', {}, sessionId);
  await browser.request('Page.enable', {}, sessionId);
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    const state = await browser
      .evaluate(sessionId, 'document.readyState')
      .catch(() => '');
    if (state === 'complete') break;
    await delay(50);
  }
  await harness.wait(browser, sessionId, READY);
  return sessionId;
};

const waitFor = async (browser, session, body) => {
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    await browser.request('Page.bringToFront', {}, session);
    const result = await harness.run(browser, session, body).catch(() => false);
    if (result) return;
    await delay(100);
  }
  const detail = await harness.run(browser, session, body);
  throw new Error(`Screen condition failed: ${JSON.stringify(detail)}`);
};

const gesture = async (browser, session, action) => {
  await browser.request('Page.bringToFront', {}, session);
  const expression = harness.script(`const button = document.querySelector(
    '#call-view [data-action="${action}"]');
    if (!button) throw new Error('Missing ${action}');
    button.click();
    return true;`);
  const params = {
    expression,
    userGesture: true,
    awaitPromise: true,
    returnByValue: true,
  };
  const result = await browser.request('Runtime.evaluate', params, session);
  assert.equal(result.exceptionDetails, undefined);
};

const screenShown = (endpoint) => {
  const remote = JSON.stringify(endpoint);
  return `const tile = document.querySelector(
    '.screen-tile[data-endpoint=' + JSON.stringify(${remote}) + ']');
    const video = tile?.querySelector('video');
    return Boolean(video && video.videoWidth > 0 && video.muted);`;
};

const screenSound = (endpoint) => {
  const remote = JSON.stringify(endpoint);
  return `const receiver = app.callSession.receiver(${remote}, 'screenAudio');
    const sources = receiver?.getSynchronizationSources() ?? [];
    const audio = document.querySelector('audio[data-slot=screenAudio]');
    const level = sources[0]?.audioLevel ?? 0;
    return Boolean(audio?.srcObject && !audio.muted && level > 0);`;
};

const screenGone = (endpoint) => {
  const remote = JSON.stringify(endpoint);
  return `const person = app.callStage.people.find(
    (item) => item.endpoint === ${remote});
    const tile = document.querySelector('.screen-tile');
    const audio = document.querySelector('audio[data-slot=screenAudio]');
    return Boolean(person && !person.screen && !tile && !audio);`;
};

const CAPTURED = `const media = app.callStage.media;
  if (media.screenPending) return false;
  if (!media.screenTrack) throw new Error(media.message || 'no screen');
  return media.screenTrack.readyState === 'live';`;

const PREPARE = `window.screenSends = [];
  const session = app.callSession;
  const putTrack = session.setTrack.bind(session);
  session.setTrack = (slot, track) => {
    if (slot === 'screen' || slot === 'screenAudio') {
      window.screenSends.push({ slot, shared: Boolean(track) });
    }
    return putTrack(slot, track);
  };
  return true;`;

const LOCAL = `const media = app.callStage.media;
  const button = document.querySelector('[data-action=share]');
  const sent = window.screenSends.some((item) => item.shared);
  return Boolean(media.screenTrack && !media.screenShared && !sent &&
    button.textContent === 'captured, not shared');`;

const SHARED = `const person = app.callStage.people.find(
  (item) => item.endpoint === app.callSession.endpoint);
  return Boolean(person?.screen && app.callStage.media.screenShared);`;

const STOPPED = `const media = app.callStage.media;
  return !media.screenTrack && !media.screenAudioTrack && !media.screenShared;`;

test(
  'screen and audio, local capture, late join, and stop',
  {
    timeout: 180000,
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
    const token = JSON.stringify(host.token);
    await run(
      right,
      `app.selectChat('general');
    await app.startCall('general', { token: ${token} }); return true;`,
    );
    await run(left, JOIN);
    await run(right, JOIN);
    const linked = 'return app.callSession?.linkCount === 1;';
    await waitFor(browser, left, linked);
    await waitFor(browser, right, linked);
    await run(left, PREPARE);
    await gesture(browser, left, 'capture-local');
    await waitFor(browser, left, CAPTURED);
    assert.equal(await run(left, LOCAL), true);
    assert.equal(await run(right, screenGone(host.endpoint)), true);
    const noScreenPackets = await run(
      right,
      `const receiver =
    app.callSession.receiver(${JSON.stringify(host.endpoint)}, 'screen');
    const stats = await receiver.getStats();
    for (const report of stats.values()) {
      if (report.type === 'inbound-rtp' && report.bytesReceived > 0) {
        return false;
      }
    }
    return true;`,
    );
    assert.equal(noScreenPackets, true);

    await gesture(browser, left, 'share-call');
    await waitFor(browser, left, SHARED);
    await waitFor(browser, right, screenShown(host.endpoint));
    await waitFor(browser, right, screenSound(host.endpoint));
    await gesture(browser, left, 'screen-motion');
    const motion = await run(
      left,
      `const track = app.callStage.media.screenTrack;
    return track.contentHint === 'motion';`,
    );
    assert.equal(motion, true);
    await gesture(browser, left, 'stop-screen');
    await waitFor(browser, left, STOPPED);
    await waitFor(browser, right, screenGone(host.endpoint));

    await gesture(browser, left, 'share');
    await waitFor(browser, left, CAPTURED);
    await waitFor(browser, right, screenShown(host.endpoint));
    const third = await openPerson(t, browser);
    await run(
      third,
      `app.selectChat('general');
    await app.startCall('general', { token: ${token} }); return true;`,
    );
    await run(third, JOIN);
    await waitFor(browser, third, screenShown(host.endpoint));
    await waitFor(browser, third, screenSound(host.endpoint));

    await run(
      left,
      `const track = app.callStage.media.screenTrack;
    track.stop();
    track.dispatchEvent(new Event('ended'));
    return true;`,
    );
    await waitFor(browser, left, STOPPED);
    await waitFor(browser, right, screenGone(host.endpoint));
    await waitFor(browser, third, screenGone(host.endpoint));

    await gesture(browser, left, 'capture-local');
    await waitFor(browser, left, CAPTURED);
    const stoppedOnLeave = await run(
      left,
      `const media = app.callStage.media;
    const video = media.screenTrack;
    const audio = media.screenAudioTrack;
    await app.closeCall();
    return video.readyState === 'ended' && audio?.readyState === 'ended';`,
    );
    assert.equal(stoppedOnLeave, true);
  },
);
