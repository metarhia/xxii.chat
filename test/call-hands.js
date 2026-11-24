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

const clickHand = `const button = document.querySelector(
  '#call-view [data-action="hand"]');
  if (!button) throw new Error('no hand button');
  button.click();
  return true;`;

const rosterIs = (endpoints) => {
  const expected = JSON.stringify(endpoints);
  return `const items = document.querySelectorAll('#call-view .call-roster li');
    const raised = [];
    for (const item of items) {
      const hand = item.querySelector('.roster-hand');
      if (hand) raised.push(item.dataset.endpoint);
    }
    if (JSON.stringify(raised) !== ${JSON.stringify(expected)}) {
      throw new Error(JSON.stringify(raised));
    }
    return true;`;
};

const badgeIs = (endpoint, text) => {
  const remote = JSON.stringify(endpoint);
  return `const tile = document.querySelector(
    '#call-view .call-tile[data-endpoint=' + JSON.stringify(${remote}) + ']');
    const badge = tile ? tile.querySelector('.call-hand-badge') : null;
    const shown = badge && !badge.classList.contains('hidden');
    const got = shown ? badge.textContent : '';
    if (got !== ${JSON.stringify(text)}) throw new Error(got);
    return true;`;
};

const handLabel = (label) => `const button = document.querySelector(
  '#call-view [data-action="hand"]');
  const text = button ? button.textContent : '';
  if (text !== ${JSON.stringify(label)}) throw new Error(text);
  return true;`;

const floats = (endpoint, count, emoji = '') => {
  const remote = JSON.stringify(endpoint);
  return `const tile = document.querySelector(
    '#call-view .call-tile[data-endpoint=' + JSON.stringify(${remote}) + ']');
    const items = tile ? tile.querySelectorAll('.call-reaction') : [];
    if (items.length !== ${count}) throw new Error('count ' + items.length);
    const first = items.length > 0 ? items[0].textContent : '';
    if (${JSON.stringify(emoji)} !== '' && first !== ${JSON.stringify(emoji)}) {
      throw new Error(first);
    }
    return true;`;
};

const burst = (emoji) => `const sent = new Array(10).fill(false);
  for (let index = 0; index < sent.length; index++) {
    sent[index] = app.callStage.react(${JSON.stringify(emoji)});
  }
  return sent.filter(Boolean).length;`;

const flood = (endpoint, emoji) => `for (let index = 0; index < 10; index++) {
    app.callStage.onPeerMessage({
      endpoint: ${JSON.stringify(endpoint)},
      message: { type: 'reaction', emoji: ${JSON.stringify(emoji)} },
    });
  }
  return true;`;

const join = async (t, browser, nick, token, host) => {
  const person = keep(
    t,
    browser,
    await openAt(browser, `${ORIGIN}/`, nickScript(nick)),
  );
  const run = (body) => harness.run(browser, person.sessionId, body);
  await waitFront(browser, person.sessionId, READY);
  const given = JSON.stringify(token);
  const options = host ? '' : `, { token: ${given} }`;
  const endpoint = await run(
    `app.selectChat(${CHAT});
    await app.startCall(${CHAT}${options});
    return app.callSession.endpoint;`,
  );
  await front(browser, person.sessionId);
  await run(JOIN);
  await waitFront(browser, person.sessionId, JOINED);
  return { ...person, endpoint, run };
};

test(
  'scenario 12: hands ordered by time, reactions on other tiles',
  { timeout: 240000 },
  async (t) => {
    const dataPath = await fs.mkdtemp(path.join(os.tmpdir(), 'xxii-data-'));
    t.after(() => fs.rm(dataPath, { recursive: true, force: true }));
    const server = await startServer(dataPath);
    t.after(() => stopServer(server));
    const browser = await launch(t, FLAGS);
    const host = keep(
      t,
      browser,
      await openAt(browser, `${ORIGIN}/`, nickScript('alex')),
    );
    await waitFront(browser, host.sessionId, READY);
    const started = await harness.run(
      browser,
      host.sessionId,
      `app.selectChat(${CHAT});
      await app.startCall(${CHAT});
      return { token: app.callToken, endpoint: app.callSession.endpoint };`,
    );
    await front(browser, host.sessionId);
    await harness.run(browser, host.sessionId, JOIN);
    await waitFront(browser, host.sessionId, JOINED);
    const kim = await join(t, browser, 'kim', started.token, false);
    const announced = (text) => `const live = document.querySelector(
      '#call-announcements[aria-live="polite"]');
      return live.textContent.includes(${JSON.stringify(text)});`;
    const visibleToast = (
      name,
      action,
    ) => `const toast = document.querySelector('#call-toast');
      const nick = ${JSON.stringify(name)};
      return !toast.hidden && toast.textContent.includes(nick) &&
        toast.textContent.includes(${JSON.stringify(action)});`;
    await waitFront(browser, host.sessionId, announced('kim joined'));
    await waitFront(browser, host.sessionId, visibleToast('kim', 'joined'));
    const sam = await join(t, browser, 'sam', started.token, false);
    const all = [host, kim, sam];
    for (const person of all) {
      await waitFront(browser, person.sessionId, links(2), 30000);
    }
    const hostId = started.endpoint;
    const wait = (person, body, ms = 10000) =>
      waitFront(browser, person.sessionId, body, ms);
    const click = async (person, body) => {
      await front(browser, person.sessionId);
      await harness.run(browser, person.sessionId, body);
    };

    await click(kim, clickHand);
    await wait(host, rosterIs([kim.endpoint]));
    await wait(host, announced('kim raised a hand'));
    await click(sam, clickHand);
    await wait(host, rosterIs([kim.endpoint, sam.endpoint]));
    await click(host, clickHand);
    const order = [kim.endpoint, sam.endpoint, hostId];
    for (const person of all) {
      await wait(person, rosterIs(order));
      await wait(person, badgeIs(kim.endpoint, '✋ 1'));
      await wait(person, badgeIs(sam.endpoint, '✋ 2'));
      await wait(person, badgeIs(hostId, '✋ 3'));
    }
    await wait(sam, handLabel('lower hand'));

    await click(host, tileAction(sam.endpoint, 'lower-hand'));
    for (const person of all) {
      await wait(person, rosterIs([kim.endpoint, hostId]));
      await wait(person, badgeIs(hostId, '✋ 2'));
    }
    await wait(sam, handLabel('raise hand'));
    await click(kim, clickHand);
    await wait(host, rosterIs([hostId]));
    await wait(kim, handLabel('raise hand'));

    await click(
      kim,
      `document.querySelector(
      '#call-view [data-action="react"][data-emoji="🎉"]').click();
      return true;`,
    );
    await wait(kim, floats(kim.endpoint, 1, '🎉'));
    await wait(host, floats(kim.endpoint, 1, '🎉'));
    await wait(sam, floats(kim.endpoint, 1, '🎉'));
    await wait(host, floats(kim.endpoint, 0), 8000);
    await wait(sam, floats(kim.endpoint, 0), 8000);

    await front(browser, kim.sessionId);
    const sent = await harness.run(browser, kim.sessionId, burst('👏'));
    assert.equal(sent, 3);
    await wait(host, floats(kim.endpoint, 3, '👏'));
    await wait(sam, floats(kim.endpoint, 3, '👏'));
    await delay(500);
    await wait(host, floats(kim.endpoint, 3, '👏'));
    await wait(host, floats(kim.endpoint, 0), 8000);

    await front(browser, host.sessionId);
    await harness.run(browser, host.sessionId, flood(kim.endpoint, '😂'));
    await wait(host, floats(kim.endpoint, 3, '😂'));
    await harness.run(browser, host.sessionId, flood(kim.endpoint, '💩'));
    await wait(host, floats(kim.endpoint, 3, '😂'));
    await browser.request(
      'Emulation.setDeviceMetricsOverride',
      { width: 320, height: 650, mobile: true, deviceScaleFactor: 2 },
      host.sessionId,
    );
    await wait(
      host,
      `const strip = document.querySelector('.phone-strip');
      const main = document.querySelector('.call-tile.featured');
      return strip && !strip.hidden && strip.children.length === 2 &&
        main.getBoundingClientRect().height > strip.clientHeight;`,
    );
    await click(sam, 'await app.closeCall(); return true;');
    await wait(host, announced('sam left'));
    await wait(host, visibleToast('sam', 'left'));
  },
);
