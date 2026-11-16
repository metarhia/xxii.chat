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
const NICK = 'ada';
const READY = `const connected = app.connected === true;
  const mesh = app.mesh;
  const listed = Boolean(mesh && mesh.peers.has(app.peerId));
  const bound = app.callBound === true;
  if (connected && listed && bound) return true;
  const call = app.api ? app.api.call : null;
  const on = call ? typeof call.on : 'none';
  throw new Error('b=' + bound + ' on=' + on);`;

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

const openTab = async (browser, browserContextId) => {
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
  const errors = browser.errors.slice(-3).join(' | ');
  throw new Error(`Browser condition timed out: ${message} ${errors}`);
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

const grantNotes = async (browser, browserContextId) => {
  const permission = { name: 'notifications' };
  const params = {
    origin: ORIGIN,
    browserContextId,
    permission,
    setting: 'granted',
  };
  const attempts = [];
  try {
    await browser.request('Browser.setPermission', params);
    attempts.push('Browser.setPermission ok');
  } catch (error) {
    attempts.push(`Browser.setPermission: ${error.message}`);
  }
  const legacy = {
    origin: ORIGIN,
    browserContextId,
    permissions: ['notifications'],
  };
  try {
    await browser.request('Browser.grantPermissions', legacy);
    attempts.push('Browser.grantPermissions ok');
  } catch (error) {
    attempts.push(`Browser.grantPermissions: ${error.message}`);
  }
  return attempts.join('; ');
};

const dispose = (browser, browserContextId) =>
  browser
    .request('Target.disposeBrowserContext', { browserContextId })
    .catch(() => undefined);

const boot = async (t) => {
  const dataPath = await fs.mkdtemp(path.join(os.tmpdir(), 'xxii-data-'));
  t.after(() => fs.rm(dataPath, { recursive: true, force: true }));
  const server = await startServer(dataPath);
  t.after(() => stopServer(server));
  const browser = await launch(t, FLAGS);
  const callerContext = await browser.request('Target.createBrowserContext');
  const calleeContext = await browser.request('Target.createBrowserContext');
  const callerId = callerContext.browserContextId;
  const calleeId = calleeContext.browserContextId;
  t.after(() => dispose(browser, callerId));
  t.after(() => dispose(browser, calleeId));
  const grant = await grantNotes(browser, calleeId);
  const caller = await openTab(browser, callerId);
  const frontTab = await openTab(browser, calleeId);
  const backTab = await openTab(browser, calleeId);
  const run = (session, body) => harness.run(browser, session, body);
  await waitFor(browser, caller.sessionId, READY);
  await waitFor(browser, frontTab.sessionId, READY);
  await waitFor(browser, backTab.sessionId, READY);
  const calleePeer = await run(frontTab.sessionId, 'return app.peerId;');
  const callerPeer = await run(caller.sessionId, 'return app.peerId;');
  assert.notEqual(callerPeer, calleePeer);
  const same = await run(backTab.sessionId, 'return app.peerId;');
  assert.equal(same, calleePeer);
  return {
    browser,
    run,
    caller,
    frontTab,
    backTab,
    calleePeer,
    callerPeer,
    grant,
  };
};

const directOf = (peer) => {
  const id = JSON.stringify(peer);
  return `await app.openDirect(${id});
    app.selectDirect(${id});
    return true;`;
};

const startOf = (peer) => {
  const id = JSON.stringify(peer);
  return `app.usernameInput.value = '${NICK}';
    app.syncUsername();
    await app.openDirect(${id});
    app.selectDirect(${id});
    await app.startCall(app.chat);
    return app.chat;`;
};

const toastOf = () => `app.render();
  const toast = document.getElementById('incoming-call');
  if (!toast) throw new Error('no toast');
  const text = toast.textContent || '';
  const title = ${JSON.stringify(`${NICK} is calling`)};
  if (!text.includes(title)) throw new Error(text);
  const video = toast.querySelector('[data-action="video"]');
  const audio = toast.querySelector('[data-action="audio"]');
  const decline = toast.querySelector('[data-action="decline"]');
  if (!video || !audio || !decline) throw new Error('buttons');
  return true;`;

const TONE = `const context = app.ring ? app.ring.context : null;
  if (!context) throw new Error('no ringtone');
  if (context.state !== 'running') throw new Error(context.state);
  return true;`;

const GONE = `app.render();
  if (document.getElementById('incoming-call')) {
    throw new Error('toast remains');
  }
  return true;`;

const MISSED = `app.render();
  const list = app.messageList;
  const text = list ? list.textContent : '';
  const title = ${JSON.stringify(`missed call from ${NICK}`)};
  if (text.includes(title) && text.includes('call back')) return true;
  throw new Error(text.slice(0, 180));`;

const NOTE = `if (document.hidden !== true) throw new Error('not hidden');
  const registration = await navigator.serviceWorker.ready;
  const tag = app.ring ? app.ring.tag : '';
  const notes = await registration.getNotifications();
  const found = notes.some((note) => note.tag === tag);
  if (found) return true;
  const titles = notes.map((note) => note.title).join('|');
  const reason = app.ring ? app.ring.noteError : '';
  throw new Error(tag + ' ' + reason + ' ' + titles);`;

const QUIET = `if (document.hidden) throw new Error('hidden');
  const registration = await navigator.serviceWorker.ready;
  const tag = app.ring ? app.ring.tag : '';
  const notes = await registration.getNotifications();
  const found = notes.some((note) => note.tag === tag);
  if (found) throw new Error('visible notified');
  return true;`;

const PERMISSION = `return typeof Notification === 'undefined'
  ? 'missing'
  : Notification.permission;`;

const DECLINE = `const button = document.querySelector(
  '#incoming-call [data-action="decline"]');
  if (!button) throw new Error('no decline');
  button.click();
  return true;`;

const VIDEO = `const button = document.querySelector(
  '#incoming-call [data-action="video"]');
  if (!button) throw new Error('no video');
  button.click();
  return true;`;

const JOIN = `const button = document.querySelector(
  '#prejoin [data-action="join"]');
  if (button) button.click();
  return true;`;

const PREJOIN = `const session = app.callSession;
  if (session && session.phase === 'joined') return true;
  return Boolean(document.querySelector('#prejoin [data-action="join"]'));`;

const linked = (count) => `const session = app.callSession;
  if (!session || session.phase !== 'joined') return false;
  return session.linkCount === ${count};`;

const hiddenIs = (value) => `return document.hidden === ${value};`;

const prepare = async (t) => {
  const room = await boot(t);
  const { browser, run, caller, frontTab, backTab } = room;
  await run(caller.sessionId, directOf(room.calleePeer));
  await run(frontTab.sessionId, directOf(room.callerPeer));
  await run(backTab.sessionId, directOf(room.callerPeer));
  await front(browser, frontTab.sessionId);
  await waitFor(browser, frontTab.sessionId, hiddenIs(false));
  await waitFor(browser, backTab.sessionId, hiddenIs(true));
  return room;
};

const readPermission = async (browser, session) => {
  const deadline = Date.now() + 3000;
  let permission = '';
  while (Date.now() < deadline) {
    permission = await harness.run(browser, session, PERMISSION);
    if (permission === 'granted') return permission;
    await delay(100);
  }
  return permission;
};

test(
  'decline stops both tabs and leaves a missed call',
  { timeout: 180000 },
  async (t) => {
    const room = await prepare(t);
    const { browser, run, caller, frontTab, backTab, grant } = room;
    const contextId = backTab.browserContextId;
    const again = await grantNotes(browser, contextId);
    const permission = await readPermission(browser, backTab.sessionId);
    const noteTry = `${grant}; ${again}; permission=${permission}`;
    await fs.writeFile('/tmp/xxii-calls/grant.txt', noteTry);
    await run(caller.sessionId, startOf(room.calleePeer));
    await waitFront(browser, frontTab.sessionId, toastOf());
    await waitFront(browser, frontTab.sessionId, TONE);
    if (permission === 'granted') {
      await waitFor(browser, backTab.sessionId, NOTE, 8000);
      await waitFor(browser, frontTab.sessionId, QUIET);
    } else {
      t.diagnostic(`notification not granted: ${noteTry}`);
    }
    await waitFront(browser, backTab.sessionId, toastOf());
    await run(backTab.sessionId, DECLINE);
    await waitFront(browser, frontTab.sessionId, GONE);
    await waitFront(browser, backTab.sessionId, GONE);
    await waitFront(browser, caller.sessionId, MISSED);
  },
);

test(
  'video accept connects and clears the other tab',
  { timeout: 180000 },
  async (t) => {
    const room = await prepare(t);
    const { browser, run, caller, frontTab, backTab } = room;
    await run(caller.sessionId, startOf(room.calleePeer));
    await waitFront(browser, frontTab.sessionId, toastOf());
    await waitFront(browser, backTab.sessionId, toastOf());
    await front(browser, frontTab.sessionId);
    await run(frontTab.sessionId, VIDEO);
    await waitFor(browser, frontTab.sessionId, PREJOIN);
    await run(frontTab.sessionId, JOIN);
    await run(caller.sessionId, JOIN);
    await waitFor(browser, caller.sessionId, linked(1), 20000);
    await waitFor(browser, frontTab.sessionId, linked(1), 20000);
    await waitFront(browser, backTab.sessionId, GONE);
  },
);
