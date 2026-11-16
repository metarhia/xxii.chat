'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { setTimeout: delay } = require('node:timers/promises');

const harness = require('./harness.js');

const { MEDIA_FLAGS, ORIGIN, launch, startServer, stopServer } = harness;

const EXTRA = '--disable-features=WebRtcHideLocalIpsWithMdns';
const FLAGS = MEDIA_FLAGS.concat([EXTRA]);
const CHAT = JSON.stringify('general');
const READY =
  'return app.connected === true && app.mesh.peers.has(app.peerId);';
const JOIN = `const button = document.querySelector(
  '#prejoin [data-action=join]');
  if (!button) throw new Error('no join');
  button.click();
  return true;`;
const PING = `setInterval(() => {
  const session = app.callSession;
  if (!session || session.phase !== 'joined') return;
  const call = session.call;
  const endpoint = session.endpoint;
  app.api.call.ping({ call, endpoint });
}, 500);
return true;`;

const untilLoaded = async (browser, sessionId) => {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    const state = await browser
      .evaluate(sessionId, 'document.readyState')
      .catch(() => '');
    if (state === 'complete') return;
    await delay(50);
  }
  throw new Error('Page did not load');
};

const openContext = async (browser) => {
  const created = await browser.request('Target.createBrowserContext');
  const { browserContextId } = created;
  const url = `${ORIGIN}/`;
  const params = { url, browserContextId };
  const { targetId } = await browser.request('Target.createTarget', params);
  const attach = { targetId, flatten: true };
  const target = await browser.request('Target.attachToTarget', attach);
  const { sessionId } = target;
  await browser.request('Runtime.enable', {}, sessionId);
  await browser.request('Page.enable', {}, sessionId);
  await untilLoaded(browser, sessionId);
  return { browserContextId, targetId, sessionId };
};

const detailOf = async (browser, session, body) => {
  try {
    const value = await harness.run(browser, session, body);
    if (value) return '';
    return `returned ${JSON.stringify(value)}`;
  } catch (error) {
    return error.message;
  }
};

const waitFor = async (browser, session, body, timeoutMs = 15000) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const ready = await harness.run(browser, session, body).catch(() => false);
    if (ready) return;
    await delay(100);
  }
  const detail = await detailOf(browser, session, body);
  const message = detail || 'condition was false';
  throw new Error(`Browser condition timed out: ${message}`);
};

const front = async (browser, session) => {
  await browser.request('Page.bringToFront', {}, session);
  await harness.run(browser, session, 'app.render(); return true;');
};

const waitFront = async (browser, session, body, timeoutMs = 15000) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await front(browser, session);
    const ready = await harness.run(browser, session, body).catch(() => false);
    if (ready) return;
    await delay(100);
  }
  await front(browser, session);
  const detail = await detailOf(browser, session, body);
  const message = detail || 'condition was false';
  throw new Error(`Browser condition timed out: ${message}`);
};

const selectorOf = (endpoint) =>
  JSON.stringify(`#call-view [data-endpoint="${endpoint}"]`);

const hasFrame = (endpoint) => {
  const selector = selectorOf(endpoint);
  return `const tile = document.querySelector(${selector});
    const video = tile ? tile.querySelector('video') : null;
    const width = video ? video.videoWidth : 0;
    return width > 0;`;
};

const countFrames = (endpoint) => {
  const selector = selectorOf(endpoint);
  return `if (document.hidden) throw new Error('hidden');
    const tile = document.querySelector(${selector});
    const video = tile ? tile.querySelector('video') : null;
    const width = video ? video.videoWidth : 0;
    if (!video || width <= 0) throw new Error('width ' + width);
    let frames = 0;
    const started = performance.now();
    const done = new Promise((resolve) => {
      const tick = () => {
        frames += 1;
        const elapsed = performance.now() - started;
        if (elapsed >= 2000) resolve(frames);
        else video.requestVideoFrameCallback(tick);
      };
      video.requestVideoFrameCallback(tick);
    });
    const count = await done;
    if (count < 10) throw new Error('frames ' + count);
    return count;`;
};

const audioLevel = (endpoint, limitMs, rising) => {
  const remote = JSON.stringify(endpoint);
  const goal = rising ? 'level > 0' : 'level === 0';
  return `const remote = ${remote};
    const deadline = performance.now() + ${limitMs};
    let level = -1;
    while (performance.now() < deadline) {
      const session = app.callSession;
      const receiver = session ? session.receiver(remote, 'mic') : null;
      const sources = receiver ? receiver.getSynchronizationSources() : [];
      const source = sources.length > 0 ? sources[0] : null;
      level = source ? source.audioLevel : -1;
      if (${goal}) return true;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error('level ' + level);`;
};

const avatarShown = (endpoint) => {
  const selector = selectorOf(endpoint);
  return `const deadline = performance.now() + 1000;
    let detail = 'missing';
    while (performance.now() < deadline) {
      app.render();
      const tile = document.querySelector(${selector});
      const video = tile ? tile.querySelector('video') : null;
      const wrap = tile ? tile.querySelector('.avatar-wrap') : null;
      const videoHidden = Boolean(video && video.classList.contains('hidden'));
      const wrapShown = Boolean(wrap && !wrap.classList.contains('hidden'));
      detail = 'video ' + videoHidden + ' wrap ' + wrapShown;
      if (videoHidden && wrapShown) return true;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error(detail);`;
};

const linked = (count) =>
  `const session = app.callSession;
    if (!session || session.phase !== 'joined') return false;
    return session.linkCount === ${count};`;

const click = (action) => {
  const selector = JSON.stringify(`#call-view [data-action="${action}"]`);
  return `const button = document.querySelector(${selector});
    if (!button) throw new Error('no ${action}');
    button.click();
    return true;`;
};

const CARD = `app.render();
  const text = app.messageList ? app.messageList.textContent : '';
  if (text.includes('2 in call')) return true;
  throw new Error(text.slice(0, 120));`;

const RESTORED = `if (!app.connected) throw new Error('down');
  const list = await app.api.call.active();
  const text = JSON.stringify(list);
  if (!Array.isArray(list)) throw new Error(text);
  for (const item of list) {
    if (item.count === 2) return true;
  }
  const phase = app.callSession ? app.callSession.phase : '';
  throw new Error(phase + ' ' + text);`;

const SILENT = `app.api.call.ping = () => true;
  return true;`;

const GONE = `const session = app.callSession;
  if (!session) throw new Error('no session');
  const phase = session.phase;
  const links = session.linkCount;
  if (phase === 'joined' && links === 0) return true;
  throw new Error(phase + ' links ' + links);`;

const openPerson = async (t, browser) => {
  const person = await openContext(browser);
  const id = person.browserContextId;
  t.after(() =>
    browser
      .request('Target.disposeBrowserContext', { browserContextId: id })
      .catch(() => undefined),
  );
  return person;
};

const boot = async (t) => {
  const dataPath = await fs.mkdtemp(path.join(os.tmpdir(), 'xxii-data-'));
  t.after(() => fs.rm(dataPath, { recursive: true, force: true }));
  const server = await startServer(dataPath);
  t.after(() => stopServer(server));
  const browser = await launch(t, FLAGS);
  const run = (session, body) => harness.run(browser, session, body);
  const left = await openPerson(t, browser);
  const right = await openPerson(t, browser);
  await waitFor(browser, left.sessionId, READY);
  await waitFor(browser, right.sessionId, READY);
  return { dataPath, server, browser, run, left, right };
};

const startShort = async (dataPath) => {
  process.env.XXII_CALL_TIMEOUT_MS = '2000';
  try {
    return await startServer(dataPath);
  } finally {
    delete process.env.XXII_CALL_TIMEOUT_MS;
  }
};

const beginPair = async (t) => {
  const room = await boot(t);
  const { run, left, right } = room;
  const host = await run(
    left.sessionId,
    `app.selectChat(${CHAT});
      await app.startCall(${CHAT});
      const endpoint = app.callSession.endpoint;
      const token = app.callToken;
      return { endpoint, token };`,
  );
  assert.equal(typeof host.token, 'string');
  assert.equal(host.token.length > 0, true);
  const given = JSON.stringify(host.token);
  const guest = await run(
    right.sessionId,
    `app.selectChat(${CHAT});
      await app.startCall(${CHAT}, { token: ${given} });
      return app.callSession.endpoint;`,
  );
  assert.notEqual(host.endpoint, guest);
  await run(left.sessionId, JOIN);
  await run(right.sessionId, JOIN);
  return { ...room, host, guest };
};

const watchMedia = async (browser, session, endpoint) => {
  await waitFront(browser, session, hasFrame(endpoint), 20000);
  await front(browser, session);
  const frames = await harness.run(browser, session, countFrames(endpoint));
  assert.equal(frames >= 10, true);
  await front(browser, session);
  await harness.run(browser, session, audioLevel(endpoint, 6000, true));
};

test('media, mute, and a third participant', { timeout: 180000 }, async (t) => {
  const room = await beginPair(t);
  const { browser, run, left, right, host, guest } = room;
  await waitFor(browser, left.sessionId, linked(1), 20000);
  await waitFor(browser, right.sessionId, linked(1), 20000);
  await waitFront(browser, left.sessionId, CARD, 10000);
  await watchMedia(browser, left.sessionId, guest);
  await watchMedia(browser, right.sessionId, host.endpoint);

  await front(browser, right.sessionId);
  await run(left.sessionId, click('mic'));
  await harness.run(
    browser,
    right.sessionId,
    audioLevel(host.endpoint, 1000, false),
  );
  await front(browser, right.sessionId);
  await run(left.sessionId, click('camera'));
  await harness.run(browser, right.sessionId, avatarShown(host.endpoint));

  const third = await openPerson(t, browser);
  await waitFor(browser, third.sessionId, READY);
  const given = JSON.stringify(host.token);
  await run(
    third.sessionId,
    `app.selectChat(${CHAT});
      await app.startCall(${CHAT}, { token: ${given} });
      return app.callSession.endpoint;`,
  );
  await run(third.sessionId, JOIN);
  await waitFor(browser, left.sessionId, linked(2), 20000);
  await waitFor(browser, right.sessionId, linked(2), 20000);
  await waitFor(browser, third.sessionId, linked(2), 20000);
  await run(third.sessionId, click('leave'));
  await waitFor(browser, left.sessionId, linked(1), 3000);
  await waitFor(browser, right.sessionId, linked(1), 3000);
});

const silenceCase = async (t, hide) => {
  const dataPath = await fs.mkdtemp(path.join(os.tmpdir(), 'xxii-data-'));
  t.after(() => fs.rm(dataPath, { recursive: true, force: true }));
  const server = await startShort(dataPath);
  t.after(() => stopServer(server));
  const browser = await launch(t, FLAGS);
  const run = (session, body) => harness.run(browser, session, body);
  const left = await openPerson(t, browser);
  const right = await openPerson(t, browser);
  await waitFor(browser, left.sessionId, READY);
  await waitFor(browser, right.sessionId, READY);
  const opened = await run(
    left.sessionId,
    `app.selectChat(${CHAT});
      await app.startCall(${CHAT});
      const endpoint = app.callSession.endpoint;
      const token = app.callToken;
      return { endpoint, token };`,
  );
  const given = JSON.stringify(opened.token);
  await run(
    right.sessionId,
    `app.selectChat(${CHAT});
      await app.startCall(${CHAT}, { token: ${given} });
      return true;`,
  );
  await run(left.sessionId, JOIN);
  await run(right.sessionId, JOIN);
  await run(left.sessionId, PING);
  await run(right.sessionId, PING);
  await waitFor(browser, left.sessionId, linked(1), 15000);
  await waitFor(browser, right.sessionId, linked(1), 15000);
  assert.equal(typeof opened.endpoint, 'string');
  if (hide) {
    const called = await run(
      right.sessionId,
      `let calls = 0;
        const original = app.api.call.leave.bind(app.api.call);
        app.api.call.leave = (args) => {
          calls += 1;
          return original(args);
        };
        window.dispatchEvent(new Event('pagehide'));
        return calls;`,
    );
    assert.equal(called > 0, true);
    await waitFor(browser, left.sessionId, GONE, 1000);
    return;
  }
  await run(right.sessionId, SILENT);
  await waitFor(browser, left.sessionId, GONE, 12000);
};

test('a silent endpoint is swept', { timeout: 120000 }, async (t) => {
  await silenceCase(t, false);
});

test('pagehide leaves at once', { timeout: 120000 }, async (t) => {
  await silenceCase(t, true);
});

test('video survives a server restart', { timeout: 180000 }, async (t) => {
  const room = await beginPair(t);
  const { browser, run, left, right, host, guest } = room;
  let server = room.server;
  await waitFor(browser, left.sessionId, linked(1), 20000);
  await waitFor(browser, right.sessionId, linked(1), 20000);
  await watchMedia(browser, left.sessionId, guest);
  await stopServer(server);
  await front(browser, left.sessionId);
  const during = await run(left.sessionId, countFrames(guest));
  assert.equal(during >= 10, true);
  server = await startServer(room.dataPath);
  t.after(() => stopServer(server));
  await waitFor(browser, left.sessionId, RESTORED, 20000);
  await waitFor(browser, right.sessionId, RESTORED, 20000);
  await watchMedia(browser, left.sessionId, guest);
  await watchMedia(browser, right.sessionId, host.endpoint);
});
