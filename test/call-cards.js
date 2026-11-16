'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { setTimeout: delay } = require('node:timers/promises');

const harness = require('./harness.js');

const { ORIGIN, launch, startServer, stopServer } = harness;

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

const openPage = async (browser) => {
  const url = `${ORIGIN}/`;
  const created = await browser.request('Target.createTarget', { url });
  const targetId = created.targetId;
  const attach = { targetId, flatten: true };
  const target = await browser.request('Target.attachToTarget', attach);
  const sessionId = target.sessionId;
  await browser.request('Runtime.enable', {}, sessionId);
  await browser.request('Page.enable', {}, sessionId);
  await untilLoaded(browser, sessionId);
  return sessionId;
};

const buttonText = `const button = document.querySelector(
  '.topbar [data-action="call"]');
  const text = button ? button.textContent.trim() : '';
  return { action: button ? button.dataset.action : '', text };`;

const esc = `const event = new KeyboardEvent('keydown', {
  key: 'Escape',
  bubbles: true,
  cancelable: true,
});
document.dispatchEvent(event);
return true;`;

const settled = `const button = document.querySelector(
  '.topbar [data-action="call"]');
  const text = button ? button.textContent.trim() : '';
  const open = document.getElementById('prejoin') !== null;
  const leaving = app.callLeaving !== null;
  const live = app.messageList.textContent.includes('in call');
  return !open && !leaving && text === 'call' && !live;`;

test('call button and timeline cards', { timeout: 120000 }, async (t) => {
  const dataPath = await fs.mkdtemp(path.join(os.tmpdir(), 'xxii-data-'));
  t.after(() => fs.rm(dataPath, { recursive: true, force: true }));
  const server = await startServer(dataPath);
  t.after(() => stopServer(server));
  const browser = await launch(t);
  const run = (session, body) => harness.run(browser, session, body);
  const wait = (session, body, timeoutMs = 15000) =>
    harness.wait(browser, session, body, timeoutMs);
  const ready =
    'return app.connected === true && app.mesh.peers.has(app.peerId);';

  const session = await openPage(browser);
  await wait(session, ready);
  await run(session, `app.selectChat('general'); return true;`);
  const button = await run(session, buttonText);
  assert.equal(button.action, 'call');
  assert.equal(button.text, 'call');

  await run(
    session,
    `document.querySelector('.topbar [data-action="call"]').click();
    return true;`,
  );
  await wait(session, 'return document.getElementById("prejoin") !== null;');
  await run(session, esc);
  await wait(session, settled);

  const nick = 'Ada';
  const nickJson = JSON.stringify(nick);
  await run(
    session,
    `const { startCall } = await import('/chat.js');
    startCall(app.replica, {
      id: 'card-call',
      chat: app.chat,
      host: 'ada',
      nick: ${nickJson},
      timestamp: Date.now(),
    });
    return true;`,
  );
  const shown = `const text = app.messageList.textContent;
    return text.includes('in call') || text.includes(${nickJson});`;
  await wait(session, shown);
  await run(
    session,
    `const { endCall } = await import('/chat.js');
    endCall(app.replica, 'card-call', {
      ended: Date.now(),
      peak: 2,
      names: ${nickJson},
    });
    return true;`,
  );
  const quiet = `return !app.messageList.textContent.includes('in call');`;
  await wait(session, quiet);
});
