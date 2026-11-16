'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { setTimeout: delay } = require('node:timers/promises');

const harness = require('./harness.js');

const { MEDIA_FLAGS, ORIGIN, launch, startServer, stopServer } = harness;

const FLAGS = [...MEDIA_FLAGS, '--disable-features=WebRtcHideLocalIpsWithMdns'];

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
  return { browserContextId, sessionId };
};

const tileBody = (endpoint) => {
  const selector = JSON.stringify(`#call-view [data-endpoint="${endpoint}"]`);
  return `const tile = document.querySelector(${selector});
    const video = tile ? tile.querySelector('video') : null;
    const width = video ? video.videoWidth : 0;
    return Boolean(tile) && width > 0;`;
};

const snapshotBody = `const view = document.getElementById('call-view');
  const tiles = view ? view.querySelectorAll('[data-endpoint]').length : 0;
  const phase = app.callSession ? app.callSession.phase : '';
  return { phase, tiles };`;

const awaitTile = async (browser, session, endpoint) => {
  const body = tileBody(endpoint);
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    const found = await harness.run(browser, session, body).catch(() => false);
    if (found) return;
    await delay(100);
  }
  const snapshot = await harness.run(browser, session, snapshotBody);
  const phase = snapshot?.phase ?? '';
  const tiles = snapshot?.tiles ?? 0;
  throw new Error(`phase ${phase} tiles ${tiles}`);
};

test('pre-join and the call view', { timeout: 180000 }, async (t) => {
  const dataPath = await fs.mkdtemp(path.join(os.tmpdir(), 'xxii-data-'));
  t.after(() => fs.rm(dataPath, { recursive: true, force: true }));
  const server = await startServer(dataPath);
  t.after(() => stopServer(server));
  const browser = await launch(t, FLAGS);
  const run = (session, body) => harness.run(browser, session, body);
  const wait = (session, body, timeoutMs = 15000) =>
    harness.wait(browser, session, body, timeoutMs);
  const ready =
    'return app.connected === true && app.mesh.peers.has(app.peerId);';

  const left = await openContext(browser);
  const right = await openContext(browser);
  t.after(() =>
    browser
      .request('Target.disposeBrowserContext', {
        browserContextId: left.browserContextId,
      })
      .catch(() => undefined),
  );
  t.after(() =>
    browser
      .request('Target.disposeBrowserContext', {
        browserContextId: right.browserContextId,
      })
      .catch(() => undefined),
  );
  await wait(left.sessionId, ready);
  await wait(right.sessionId, ready);

  const chat = crypto.randomUUID();
  const chatJson = JSON.stringify(chat);
  const escaped = await run(
    left.sessionId,
    `await app.startCall(${chatJson});
    const event = new KeyboardEvent('keydown', {
      key: 'Escape',
      bubbles: true,
      cancelable: true,
    });
    document.dispatchEvent(event);
    return document.getElementById('prejoin') === null;`,
  );
  assert.equal(escaped, true);
  const settled =
    'return app.callLeaving === null && !document.getElementById("prejoin");';
  await wait(left.sessionId, settled);

  const leftCall = await run(
    left.sessionId,
    `await app.startCall(${chatJson});
    const endpoint = app.callSession.endpoint;
    const token = app.callToken;
    return { endpoint, token };`,
  );
  const leftEndpoint = leftCall.endpoint;
  const token = leftCall.token;
  assert.equal(typeof token, 'string');
  assert.equal(token.length > 0, true);
  const given = JSON.stringify(token);
  const rightEndpoint = await run(
    right.sessionId,
    `await app.startCall(${chatJson}, { token: ${given} });
    return app.callSession.endpoint;`,
  );
  assert.notEqual(leftEndpoint, rightEndpoint);
  const join = 'document.querySelector("#prejoin [data-action=join]").click();';
  await run(left.sessionId, join);
  await run(right.sessionId, join);
  await awaitTile(browser, left.sessionId, rightEndpoint);
  await awaitTile(browser, right.sessionId, leftEndpoint);
});
