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
const READY =
  'return app.connected === true && app.mesh.peers.has(app.peerId);';
const HOLD_SYNC = 'globalThis.__xxiiSyncGate = new Promise(() => {});';
const NICK = `localStorage.setItem('xxii:nick', 'kim');`;

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
    const params = { source };
    await browser.request(
      'Page.addScriptToEvaluateOnNewDocument',
      params,
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

const ASK = `const field = document.querySelector('.nick-field');
  const button = document.querySelector('#prejoin [data-action=join]');
  const visible = Boolean(field && !field.classList.contains('hidden'));
  const label = button ? button.textContent : '';
  const disabled = Boolean(button && button.disabled);
  if (!visible || label !== 'ask to join' || disabled) {
    throw new Error(label + ' visible ' + visible + ' disabled ' + disabled);
  }
  if (app.synced !== false) throw new Error('synced');
  return true;`;

const TYPE = `const input = document.querySelector('#prejoin-nick');
  if (!input) throw new Error('no nick');
  input.value = 'bob';
  document.querySelector('#prejoin [data-action=join]').click();
  return true;`;

const WAITING = `const node = document.getElementById('lobby');
  const text = node ? node.textContent : '';
  const phase = app.callSession ? app.callSession.phase : '';
  const nick = localStorage.getItem('xxii:nick');
  if (phase !== 'lobby' || !text.includes('waiting for an admin')) {
    throw new Error(phase + ' ' + text);
  }
  if (app.synced !== false) throw new Error('synced');
  if (nick !== 'bob') throw new Error(String(nick));
  return true;`;

const TOAST = `app.render();
  const toast = document.querySelector('#knock-toasts .knock');
  const text = toast ? toast.textContent : '';
  const all = document.querySelector('[data-action="admit-all"]');
  const lobby = document.querySelector('.call-lobby');
  const listed = lobby ? lobby.textContent : '';
  if (!text.includes('bob wants to join')) throw new Error(text);
  if (!all || !listed.includes('bob')) throw new Error(listed);
  return true;`;

const ADMIT = `const button = document.querySelector(
  '#knock-toasts [data-action=admit]');
  if (!button) throw new Error('no admit');
  button.click();
  return true;`;

const JOINED = `const phase = app.callSession ? app.callSession.phase : '';
  if (phase !== 'joined') throw new Error(phase);
  return true;`;

const NAMED = `const field = document.querySelector('.nick-field');
  const button = document.querySelector('#prejoin [data-action=join]');
  const hidden = Boolean(field && field.classList.contains('hidden'));
  const label = button ? button.textContent : '';
  if (!hidden || label !== 'join' || button.disabled) {
    throw new Error(label + ' hidden ' + hidden);
  }
  return true;`;

const LOCKED = `const button = document.querySelector(
  '#prejoin [data-action=join]');
  const note = document.querySelector('#prejoin .call-note');
  const text = note ? note.textContent : '';
  const disabled = Boolean(button && button.disabled);
  if (!disabled || !text.includes('Call is locked')) {
    throw new Error(disabled + ' ' + text);
  }
  const event = new KeyboardEvent('keydown', {
    key: 'Enter',
    bubbles: true,
    cancelable: true,
  });
  document.dispatchEvent(event);
  const phase = app.callSession ? app.callSession.phase : '';
  if (phase !== 'prejoin') throw new Error(phase);
  return true;`;

test(
  'scenario 10: link policy, lobby, and lock',
  { timeout: 180000 },
  async (t) => {
    const dataPath = await fs.mkdtemp(path.join(os.tmpdir(), 'xxii-data-'));
    t.after(() => fs.rm(dataPath, { recursive: true, force: true }));
    const server = await startServer(dataPath);
    t.after(() => stopServer(server));
    const browser = await launch(t, FLAGS);
    const run = (session, body) => harness.run(browser, session, body);
    const host = keep(t, browser, await openAt(browser, `${ORIGIN}/`));
    await waitFront(browser, host.sessionId, READY);
    await run(
      host.sessionId,
      `await app.startCall('general');
      document.querySelector('#prejoin [data-action=join]').click();
      return true;`,
    );
    await waitFront(browser, host.sessionId, JOINED);
    await waitFront(
      browser,
      host.sessionId,
      `const button = document.querySelector('[data-action="copy-link"]');
      return Boolean(button && !button.classList.contains('hidden'));`,
    );
    const url = await run(
      host.sessionId,
      `const id = app.callSession.call;
      const record = JSON.stringify(app.replica.get(id) ?? {});
      if (record.includes(app.callToken)) throw new Error('token in replica');
      return app.copyCallLink(id);`,
    );
    assert.equal(url.startsWith(`${ORIGIN}/?call=`), true);
    assert.equal(url.includes('&t='), true);
    const knockUrl = url.split('&t=')[0];

    const guest = keep(t, browser, await openAt(browser, knockUrl, HOLD_SYNC));
    await waitFront(browser, guest.sessionId, ASK, 25000);
    await front(browser, guest.sessionId);
    await run(guest.sessionId, TYPE);
    await waitFront(browser, guest.sessionId, WAITING, 20000);
    await waitFront(browser, host.sessionId, TOAST);
    await front(browser, host.sessionId);
    await run(host.sessionId, ADMIT);
    await waitFront(browser, guest.sessionId, JOINED, 20000);

    const named = keep(t, browser, await openAt(browser, url, NICK));
    await waitFront(browser, named.sessionId, NAMED, 25000);
    await front(browser, named.sessionId);
    await run(
      named.sessionId,
      `document.querySelector('#prejoin [data-action=join]').click();
      return true;`,
    );
    await waitFront(browser, named.sessionId, JOINED, 20000);

    await front(browser, host.sessionId);
    await run(
      host.sessionId,
      `await app.api.call.host({
        call: app.callSession.call,
        action: 'lock',
      });
      return true;`,
    );
    const locked = keep(t, browser, await openAt(browser, url));
    await waitFront(browser, locked.sessionId, LOCKED, 25000);
  },
);
