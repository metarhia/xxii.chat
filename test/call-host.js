'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { setTimeout: delay } = require('node:timers/promises');

const harness = require('./harness.js');

const { MEDIA_FLAGS, ORIGIN, launch, startServer, stopServer } = harness;

const FLAGS = MEDIA_FLAGS.concat([
  '--disable-features=WebRtcHideLocalIpsWithMdns',
]);
const CHAT = JSON.stringify('general');
const READY =
  'return app.connected === true && app.mesh.peers.has(app.peerId);';
const JOINED = `const phase = app.callSession ? app.callSession.phase : '';
  if (phase !== 'joined') throw new Error(phase);
  return true;`;
const JOIN = `const button = document.querySelector(
  '#prejoin [data-action=join]');
  if (!button) throw new Error('no join');
  button.click();
  return true;`;

const nickScript = (nick) =>
  `localStorage.setItem('xxii:nick', ${JSON.stringify(nick)});`;

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

const waitHref = async (browser, sessionId, part) => {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    const href = await browser
      .evaluate(sessionId, 'location.href')
      .catch(() => '');
    if (typeof href === 'string' && href.includes(part)) return;
    await delay(50);
  }
  throw new Error(`Did not open ${part}`);
};

const openAt = async (browser, url, source = '') => {
  const created = await browser.request('Target.createBrowserContext');
  const { browserContextId } = created;
  const blank = { url: 'about:blank', browserContextId };
  const { targetId } = await browser.request('Target.createTarget', blank);
  const attach = { targetId, flatten: true };
  const target = await browser.request('Target.attachToTarget', attach);
  const { sessionId } = target;
  await browser.request('Runtime.enable', {}, sessionId);
  await browser.request('Page.enable', {}, sessionId);
  if (source !== '') {
    await browser.request(
      'Page.addScriptToEvaluateOnNewDocument',
      { source },
      sessionId,
    );
  }
  await browser.request('Page.navigate', { url }, sessionId);
  const part = url.includes('call=') ? 'call=' : ORIGIN;
  await waitHref(browser, sessionId, part);
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

const front = async (browser, session) => {
  await browser.request('Page.bringToFront', {}, session);
  await harness.run(browser, session, 'app.render(); return true;');
};

const waitFront = async (browser, session, body, timeoutMs = 20000) => {
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

const keep = (t, browser, person) => {
  const id = person.browserContextId;
  t.after(() =>
    browser
      .request('Target.disposeBrowserContext', { browserContextId: id })
      .catch(() => undefined),
  );
  return person;
};

const links = (count) => `const session = app.callSession;
  if (!session || session.phase !== 'joined') return false;
  return session.linkCount === ${count};`;

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

const tileAction = (endpoint, action) => {
  const remote = JSON.stringify(endpoint);
  const name = JSON.stringify(action);
  return `const remote = ${remote};
    const tile = document.querySelector(
      '#call-view [data-endpoint="' + remote + '"]');
    if (!tile) throw new Error('no tile');
    tile.querySelector('[data-action="tile-menu"]').click();
    const item = document.querySelector(
      '.call-tile-menu [data-action="' + ${name} + '"]');
    if (!item) throw new Error('no ' + ${name});
    item.click();
    return true;`;
};

const announced = (text) => `const live = document.querySelector(
    '#call-announcements[aria-live="polite"]');
  const message = live?.textContent;
  if (message !== ${JSON.stringify(text)}) throw new Error(message);
  return true;`;

const MUTED = `const note = document.querySelector('.notification');
  const text = note ? note.textContent : '';
  const mic = document.querySelector('#call-view [data-action="mic"]');
  const label = mic ? mic.textContent : '';
  if (!text.includes('alex muted you') || label !== 'mic off') {
    throw new Error(text + ' / ' + label);
  }
  return true;`;

const REMOVED = `const note = document.querySelector('.notification');
  const text = note ? note.textContent : '';
  if (!text.includes('removed by alex')) throw new Error(text);
  if (app.callSession) throw new Error(app.callSession.phase);
  return true;`;

const LOBBY = `const node = document.getElementById('lobby');
  const text = node ? node.textContent : '';
  const phase = app.callSession ? app.callSession.phase : '';
  if (phase !== 'lobby' || !text.includes('waiting for an admin')) {
    throw new Error(phase + ' ' + text);
  }
  return true;`;

const ENDED = `if (app.callSession) throw new Error(app.callSession.phase);
  if (document.getElementById('call-view')) throw new Error('call');
  if (document.getElementById('lobby')) throw new Error('lobby');
  const list = await app.api.call.active();
  if (!Array.isArray(list)) throw new Error('active');
  for (const item of list) {
    if (item.count > 0) throw new Error(JSON.stringify(item));
  }
  return true;`;

const END = `const menu = document.querySelector('.leave-menu');
  if (!menu || menu.classList.contains('hidden')) throw new Error('no end');
  menu.open = true;
  const button = menu.querySelector('[data-action="end"]');
  if (!button || button.textContent !== 'End for everyone') {
    throw new Error(button ? button.textContent : 'missing');
  }
  button.click();
  return true;`;

test(
  'scenario 11: host mute, remove, and end',
  { timeout: 180000 },
  async (t) => {
    const dataPath = await fs.mkdtemp(path.join(os.tmpdir(), 'xxii-data-'));
    t.after(() => fs.rm(dataPath, { recursive: true, force: true }));
    const server = await startServer(dataPath);
    t.after(() => stopServer(server));
    const browser = await launch(t, FLAGS);
    const run = (session, body) => harness.run(browser, session, body);
    const host = keep(
      t,
      browser,
      await openAt(browser, `${ORIGIN}/`, nickScript('alex')),
    );
    await waitFront(browser, host.sessionId, READY);
    const started = await run(
      host.sessionId,
      `app.selectChat(${CHAT});
      await app.startCall(${CHAT});
      return { token: app.callToken };`,
    );
    assert.equal(typeof started.token, 'string');
    await front(browser, host.sessionId);
    await run(host.sessionId, JOIN);
    await waitFront(browser, host.sessionId, JOINED);
    const url = await run(
      host.sessionId,
      'return app.copyCallLink(app.callSession.call);',
    );
    assert.equal(url.includes('&t='), true);
    const knockUrl = url.split('&t=')[0];
    const given = JSON.stringify(started.token);

    const guest = keep(
      t,
      browser,
      await openAt(browser, `${ORIGIN}/`, nickScript('kim')),
    );
    await waitFront(browser, guest.sessionId, READY);
    const guestId = await run(
      guest.sessionId,
      `app.selectChat(${CHAT});
      await app.startCall(${CHAT}, { token: ${given} });
      return app.callSession.endpoint;`,
    );
    await front(browser, guest.sessionId);
    await run(guest.sessionId, JOIN);
    await waitFront(browser, guest.sessionId, JOINED);

    const extra = keep(
      t,
      browser,
      await openAt(browser, `${ORIGIN}/`, nickScript('sam')),
    );
    await waitFront(browser, extra.sessionId, READY);
    await run(
      extra.sessionId,
      `app.selectChat(${CHAT});
      await app.startCall(${CHAT}, { token: ${given} });
      return true;`,
    );
    await front(browser, extra.sessionId);
    await run(extra.sessionId, JOIN);
    await waitFront(browser, extra.sessionId, JOINED);
    await waitFront(browser, host.sessionId, links(2), 30000);
    await waitFront(browser, extra.sessionId, links(2), 30000);
    await front(browser, host.sessionId);
    await harness.run(browser, host.sessionId, audioLevel(guestId, 6000, true));
    const heard = JSON.stringify(guestId);
    await waitFront(
      browser,
      host.sessionId,
      `const tile = document.querySelector(
        '#call-view [data-endpoint="' + ${heard} + '"]');
      const text = tile ? tile.textContent : '';
      if (!text.includes('mic on')) throw new Error(text);
      return true;`,
    );

    await front(browser, host.sessionId);
    await run(host.sessionId, tileAction(guestId, 'ask-mute'));
    await front(browser, host.sessionId);
    await harness.run(
      browser,
      host.sessionId,
      audioLevel(guestId, 2000, false),
    );
    await waitFront(browser, guest.sessionId, MUTED, 10000);
    await waitFront(browser, guest.sessionId, announced('alex muted you'));

    await front(browser, host.sessionId);
    await run(host.sessionId, tileAction(guestId, 'remove'));
    await waitFront(browser, host.sessionId, links(1), 15000);
    await waitFront(browser, extra.sessionId, links(1), 15000);
    await waitFront(browser, guest.sessionId, REMOVED, 10000);
    await waitFront(browser, guest.sessionId, announced('removed by alex'));

    const lobby = keep(
      t,
      browser,
      await openAt(browser, knockUrl, nickScript('nora')),
    );
    await waitFront(
      browser,
      lobby.sessionId,
      `const button = document.querySelector('#prejoin [data-action=join]');
      const label = button ? button.textContent : '';
      if (label !== 'ask to join' || button.disabled) throw new Error(label);
      button.click();
      return true;`,
      25000,
    );
    await waitFront(browser, lobby.sessionId, LOBBY, 20000);

    await front(browser, host.sessionId);
    await run(host.sessionId, END);
    await waitFront(browser, host.sessionId, ENDED, 15000);
    await waitFront(browser, extra.sessionId, ENDED, 15000);
    await waitFront(browser, extra.sessionId, announced('alex ended the call'));
    await waitFront(browser, lobby.sessionId, ENDED, 15000);
  },
);
