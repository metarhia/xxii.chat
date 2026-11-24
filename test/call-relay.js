'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const harness = require('./harness.js');

const FLAGS = harness.MEDIA_FLAGS.concat([
  '--disable-features=WebRtcHideLocalIpsWithMdns',
]);
const JOIN = '#prejoin [data-action=join]';
const SOUND = '#call-view [data-action=enable-sound]';
const CAMERA = 'camera';
const quote = JSON.stringify;

const openPerson = async (t, browser, nick) => {
  const { browserContextId } = await browser.request(
    'Target.createBrowserContext',
  );
  t.after(() =>
    browser
      .request('Target.disposeBrowserContext', { browserContextId })
      .catch(() => undefined),
  );
  const target = await browser.request('Target.createTarget', {
    browserContextId,
    url: 'about:blank',
  });
  const { sessionId } = await browser.request('Target.attachToTarget', {
    ...target,
    flatten: true,
  });
  const request = (method, params = {}) =>
    browser.request(method, params, sessionId);
  const run = (body) => harness.run(browser, sessionId, body);
  const wait = (body, ms = 20000) => harness.wait(browser, sessionId, body, ms);
  const front = () => request('Page.bringToFront');
  await request('Runtime.enable');
  await request('Page.enable');
  await request('Page.addScriptToEvaluateOnNewDocument', {
    source: `localStorage.setItem('xxii:nick', ${quote(nick)});`,
  });
  await request('Page.navigate', { url: harness.ORIGIN });
  await front();
  await wait('return app.connected && app.mesh.peers.has(app.peerId);');
  const click = (selector) =>
    run(`document.querySelector(${quote(selector)}).click();`);
  return { request, run, wait, front, click, nick, endpoint: '', token: '' };
};

const prepare = async (page, token = '') => {
  const call = await page.run(`
    app.selectChat('general');
    await app.startCall('general', { token: ${quote(token)} });
    return { token: app.callToken, endpoint: app.callSession.endpoint };
  `);
  Object.assign(page, call);
};

const join = async (page) => {
  await page.front();
  await page.click(JOIN);
  await page.wait('return app.callStage?.mode === "call";');
};

const blocked = (page, other, value = true) =>
  page.run(`app.callSession.blockLink(${quote(other.endpoint)}, ${value});`);

const tile = (page, slot = CAMERA) => {
  const endpoint = page.endpoint;
  return `.call-tile[data-endpoint="${endpoint}"][data-slot=${slot}]`;
};

const chip = (other, relay) => `
  const chip = document.querySelector(${quote(tile(other) + ' .call-name')});
  return chip?.textContent.includes(${quote('via ' + relay.nick)});
`;

const clickTrusted = async (page, selector) => {
  await page.front();
  const position = await page.run(`
    const button = document.querySelector(${quote(selector)});
    const rect = button.getBoundingClientRect();
    return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
  `);
  const mouse = { ...position, button: 'left', clickCount: 1 };
  const dispatch = (type) =>
    page.request('Input.dispatchMouseEvent', { ...mouse, type });
  await dispatch('mousePressed');
  await dispatch('mouseReleased');
};

const watchRelay = (page, blockPlayback) =>
  page.run(`
  const session = app.callSession;
  const send = session.send;
  window.relayMessages = [];
  window.relayElements = new Set();
  const prototype = HTMLMediaElement.prototype;
  const play = window.nativeMediaPlay ?? prototype.play;
  window.nativeMediaPlay = play;
  window.relayPlaybackBlocked = ${blockPlayback};
  document.addEventListener('click', (event) => {
    if (event.isTrusted && event.target.closest(${quote(SOUND)})) {
      window.relayPlaybackBlocked = false;
    }
  }, true);
  prototype.play = function () {
    const relay = this instanceof HTMLAudioElement && this.hidden;
    if (relay) {
      window.relayElements.add(this);
      if (window.relayPlaybackBlocked) {
        const denied = new DOMException('Playback blocked', 'NotAllowedError');
        return Promise.reject(denied);
      }
    }
    return play.call(this);
  };
  session.send = function (endpoint, message) {
    if (message.type === 'relay') {
      window.relayMessages.push({ ...message, endpoint, time: Date.now() });
    }
    return send.call(this, endpoint, message);
  };
`);

const openBlockedPair = async (relay, first, second, relayFirst) => {
  await prepare(relay);
  await join(relay);
  await prepare(first, relay.token);
  await prepare(second, relay.token);
  const compare = (a, b) => (a.endpoint < b.endpoint ? -1 : 1);
  const order = [first, second].toSorted(compare);
  const a = order[0];
  const b = order[1];
  await blocked(a, b);
  await blocked(b, a);
  await join(relayFirst ? a : b);
  return { a, b };
};

const checkVideo = (other, slot) => `
  const source = document.querySelector(${quote(tile(other, slot) + ' video')});
  return source?.videoWidth > 0 && source.videoHeight > 0 &&
    source.videoWidth <= 640 && source.videoHeight <= 360;
`;

const checkFlow = async (page, other, relay) => {
  await page.front();
  await page.wait(chip(other, relay));
  await page.wait(checkVideo(other, CAMERA));
  const result = await page.run(`
    const video = document.querySelector(${quote(tile(other) + ' video')});
    const picture = new Promise((resolve) => {
      const timer = setTimeout(() => resolve(0), 5000);
      let frames = 0;
      const count = () => {
        frames++;
        if (frames < 3) return void video.requestVideoFrameCallback(count);
        clearTimeout(timer);
        resolve(frames);
      };
      video.requestVideoFrameCallback(count);
    });
    const session = app.callSession;
    const receiver = session.receiver(${quote(relay.endpoint)}, 'relayAudio');
    const logical = session.receiver(${quote(other.endpoint)}, 'mic');
    const audio = app.callStage.audios.get(${quote(other.endpoint)});
    const track = receiver.track;
    const deadline = Date.now() + 6000;
    let level = 0;
    let energy = 0;
    while (Date.now() < deadline) {
      const sources = receiver.getSynchronizationSources();
      level = Math.max(level, sources[0]?.audioLevel ?? 0);
      const reports = await receiver.getStats();
      for (const report of reports.values()) {
        if (report.type !== 'inbound-rtp') continue;
        energy = report.totalAudioEnergy ?? 0;
      }
      if (level > 0 && energy > 0) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    return {
      frames: await picture, level, energy,
      logical: logical === receiver,
      playback: !audio.paused && audio.srcObject.getAudioTracks()[0] === track,
      program: app.callStage.recording.members().some((member) => {
        const camera = video.srcObject.getVideoTracks()[0];
        return member.endpoint === ${quote(other.endpoint)} &&
          member.mic === track && member.camera === camera;
      }),
    };
  `);
  assert.ok(result.frames >= 3, JSON.stringify(result));
  assert.ok(result.level > 0 && result.energy > 0, JSON.stringify(result));
  assert.equal(result.logical && result.playback && result.program, true);
};

const senderLimits = (source, sink, slot = 'camera', minimum = 1) => `
  const session = app.callSession;
  const receiver = session.receiver(${quote(source.endpoint)}, ${quote(slot)});
  const input = receiver?.track;
  const sender = session.sender(${quote(sink.endpoint)}, 'relayVideo');
  const settings = input?.getSettings();
  const encoding = sender?.getParameters().encodings?.[0];
  const scale = Math.max(1, settings?.width / 640, settings?.height / 360);
  return input && sender?.track === input && scale >= ${minimum} &&
    encoding?.maxFramerate === 15 && encoding.maxBitrate === 500000 &&
    Math.abs(encoding.scaleResolutionDownBy - scale) < 0.01;
`;

const sendersClear = (a, b) => `
  return [${quote(a.endpoint)}, ${quote(b.endpoint)}].every((endpoint) =>
    ['relayAudio', 'relayVideo'].every((slot) =>
      app.callSession.sender(endpoint, slot)?.track === null));
`;

const noChip = (page, other) =>
  page.wait(`
  const chip = document.querySelector(${quote(tile(other) + ' .call-name')});
  return chip && !chip.textContent.includes('via ');
`);

const checkScreen = async (a, b, c) => {
  await a.front();
  await a.run(`
    const canvas = document.createElement('canvas');
    canvas.width = 960;
    canvas.height = 540;
    const context = canvas.getContext('2d');
    const paint = () => {
      context.fillStyle = Date.now() % 2 === 0 ? 'blue' : 'green';
      context.fillRect(0, 0, canvas.width, canvas.height);
    };
    const timer = setInterval(paint, 40);
    const media = app.callStage.media;
    media.screenTrack = canvas.captureStream(20).getVideoTracks()[0];
    media.screenShared = true;
    window.relayScreen = { canvas, timer };
    app.callStage.pushTracks();
    await app.callStage.updateServer();
    return true;
  `);
  await c.run(`
    app.callSession.setViewHint(${quote(a.endpoint)},
      { slot: 'screen', width: 1920, height: 1080, fps: 30 }, 'test');
  `);
  await c.wait(senderLimits(a, b, 'screen', 1.5));
  await b.front();
  await b.wait(checkVideo(a, 'screen'));
  await b.wait(`
    const session = app.callSession;
    return session.receiver(${quote(a.endpoint)}, 'screen') ===
      session.receiver(${quote(c.endpoint)}, 'relayVideo') &&
      !session.receiver(${quote(a.endpoint)}, 'camera') &&
      !session.receiver(${quote(a.endpoint)}, 'screenAudio');
  `);
  await a.run(`
    window.relayScreen.canvas.width = 1280;
    window.relayScreen.canvas.height = 720;
  `);
  await c.wait(senderLimits(a, b, 'screen', 2));
  await b.wait(checkVideo(a, 'screen'));
  await a.run(`
    clearInterval(window.relayScreen.timer);
    const media = app.callStage.media;
    media.screenTrack.stop();
    media.stopScreen();
    app.callStage.pushTracks();
    await app.callStage.updateServer();
    return true;
  `);
  await c.run('app.callSession.releaseViewHints("test");');
  await c.wait(senderLimits(a, b));
  await b.wait(checkVideo(a, CAMERA));
};

test(
  'scenario 22: peer relay sound, bandwidth, recovery and departure',
  { timeout: 180000 },
  async (t) => {
    await harness.startCallServer(t);
    const browser = await harness.launch(t, FLAGS);
    const c = await openPerson(t, browser, 'Casey');
    const first = await openPerson(t, browser, 'Ada');
    const second = await openPerson(t, browser, 'Bea');

    const pair = await openBlockedPair(c, first, second, true);
    const { a, b } = pair;
    await c.front();
    await c.wait(`
      const audio = app.callStage.audios.get(${quote(a.endpoint)});
      return audio && !audio.paused;
    `);
    await c.run(`
      const stage = app.callStage;
      const endpoint = ${quote(a.endpoint)};
      stage.volume.set(stage.peerOf(endpoint), 0);
      document.querySelector(${quote(tile(a))}).style.display = 'none';
    `);
    await watchRelay(c, true);
    const joinedAt = Date.now();
    await join(b);
    await c.wait(`
      return window.relayMessages.some((message) =>
        message.action === 'deny' && message.reason === 'no-sound') &&
        document.querySelector(${quote(SOUND)}).checkVisibility();
    `);
    const denial = await c.run(`return window.relayMessages.find((message) =>
      message.action === 'deny' && message.reason === 'no-sound');`);
    assert.equal(denial.endpoint, a.endpoint);
    assert.ok(denial.time - joinedAt >= 2900);
    await c.wait(sendersClear(a, b));
    assert.equal(
      await c.run(`
      return !app.callSession.forwarding && window.relayElements.size > 0 &&
        [...window.relayElements].every((audio) =>
          !audio.isConnected && !audio.srcObject);
    `),
      true,
    );
    await noChip(a, b);
    await noChip(b, a);
    await c.wait(`
      const refusals = window.relayMessages.filter((message) =>
        message.action === 'deny' && message.reason === 'no-sound');
      return refusals.length >= 2;
    `);
    await clickTrusted(c, SOUND);
    await c.wait(`return !window.relayPlaybackBlocked &&
      !document.querySelector(${quote(SOUND)}).checkVisibility();`);
    await c.wait(`
      return app.callSession.forwarding?.from === ${quote(a.endpoint)};
    `);
    assert.equal(
      await c.run(`
      const audio = app.callStage.audios.get(${quote(a.endpoint)});
      const elements = [...window.relayElements];
      const sinks = elements.filter((element) => element.isConnected);
      return audio.volume === 0 && sinks.length === 2 && sinks.every((sink) =>
        sink !== audio && !sink.muted && sink.volume === 0 && !sink.paused);
    `),
      true,
    );
    await c.run('app.callStage.toggleStats();');
    await c.wait(`return document.querySelector(
      ${quote(tile(c) + ' .tile-stats')}).textContent.includes(
        ${quote('relaying for ' + a.nick + ' and ' + b.nick)});`);
    await a.wait(`
      const sender = app.callSession.sender(${quote(c.endpoint)}, 'camera');
      return sender?.getParameters().encodings[0].active === true;
    `);
    await c.wait(senderLimits(a, b));
    await c.wait(senderLimits(b, a));
    await checkFlow(a, b, c);
    await checkFlow(b, a, c);
    await checkScreen(a, b, c);

    const unblockedAt = Date.now();
    await blocked(a, b, false);
    await blocked(b, a, false);
    for (const entry of [a, b]) {
      const other = entry === a ? b : a;
      await entry.wait(
        `
        const session = app.callSession;
        return !session.relayFor(${quote(other.endpoint)}) &&
          session.sender(${quote(other.endpoint)}, 'mic')?.track;
      `,
        15000,
      );
      await noChip(entry, other);
    }
    assert.ok(Date.now() - unblockedAt < 15500);
    await c.wait(sendersClear(a, b));
    await a.wait(`
      const sender = app.callSession.sender(${quote(c.endpoint)}, 'camera');
      return sender?.getParameters().encodings[0].active === false;
    `);
    await c.wait(`
      const stats = document.querySelector(${quote(tile(c) + ' .tile-stats')});
      const released = !app.callSession.forwarding;
      return released && !stats.textContent.includes('relaying') &&
        [...window.relayElements].every((audio) =>
          !audio.isConnected && !audio.srcObject);
    `);
    for (const page of [a, b, c]) await page.run('await app.closeCall();');

    const nextPair = await openBlockedPair(c, first, second, false);
    const nextA = nextPair.a;
    const nextB = nextPair.b;
    await watchRelay(c, false);
    await join(nextA);
    await nextA.wait(chip(nextB, c));
    await nextB.wait(chip(nextA, c));
    await c.run('await app.closeCall();');
    await noChip(nextA, nextB);
    await noChip(nextB, nextA);
    for (const entry of [nextA, nextB]) {
      await entry.wait(`return app.callStage?.mode === 'call' &&
        app.callStage.people.length === 2 && app.callSession.linkCount === 0;`);
    }
    for (const entry of [nextA, nextB]) {
      await entry.run('await app.closeCall();');
    }
    assert.equal(
      await c.run(`return [...window.relayElements].every((audio) =>
      !audio.isConnected && !audio.srcObject);`),
      true,
    );
  },
);
