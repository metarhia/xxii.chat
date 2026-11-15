'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { setTimeout: delay } = require('node:timers/promises');

const CHROME = process.env.CHROME_BIN ?? '/usr/bin/google-chrome';
const ROOT = path.join(__dirname, '..');
const ORIGIN = 'http://127.0.0.1:8001';

class BrowserProtocol {
  #socket = null;
  #id = 0;
  #pending = new Map();
  errors = [];

  constructor(socket) {
    this.#socket = socket;
    socket.addEventListener('message', ({ data }) => {
      const message = JSON.parse(data);
      if (message.method === 'Runtime.exceptionThrown') {
        const { exceptionDetails } = message.params;
        const description = exceptionDetails.exception?.description;
        this.errors.push(description ?? exceptionDetails.text);
      }
      const request = this.#pending.get(message.id);
      if (!request) return;
      this.#pending.delete(message.id);
      clearTimeout(request.timer);
      if (message.error) request.reject(new Error(message.error.message));
      else request.resolve(message.result);
    });
  }

  request(method, params = {}, sessionId = undefined) {
    const id = ++this.#id;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error(`Browser command timed out: ${method}`));
      }, 25000);
      this.#pending.set(id, { resolve, reject, timer });
      this.#socket.send(JSON.stringify({ id, method, params, sessionId }));
    });
  }

  async evaluate(sessionId, expression) {
    const params = { expression, awaitPromise: true, returnByValue: true };
    const result = await this.request('Runtime.evaluate', params, sessionId);
    const { exceptionDetails } = result;
    if (exceptionDetails) {
      const description = exceptionDetails.exception?.description;
      throw new Error(description ?? JSON.stringify(exceptionDetails));
    }
    return result.result.value;
  }

  close() {
    for (const request of this.#pending.values()) clearTimeout(request.timer);
    this.#pending.clear();
    this.#socket.close();
  }
}

const script = (body) =>
  `(async () => { const { app } = await import('/domain.js'); ${body} })()`;

const startServer = async (dataPath) => {
  const env = { ...process.env, XXII_DATA: dataPath };
  const stdio = ['ignore', 'pipe', 'pipe'];
  const options = { cwd: ROOT, env, stdio };
  const server = spawn(process.execPath, ['server.js'], options);
  let output = '';
  const collect = (data) => {
    output += data.toString();
  };
  server.stdout.on('data', collect);
  server.stderr.on('data', collect);
  for (let attempt = 0; attempt < 150; attempt++) {
    if (output.includes('Listen port 8001')) return server;
    if (server.exitCode !== null) break;
    await delay(100);
  }
  server.kill('SIGKILL');
  throw new Error(`Server did not start:\n${output}`);
};

const stopServer = async (server) => {
  if (server.exitCode !== null) return;
  server.kill('SIGINT');
  await Promise.race([once(server, 'exit'), delay(8000)]);
  if (server.exitCode === null) server.kill('SIGKILL');
};

const launch = async (t) => {
  const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'xxii-chrome-'));
  const args = [
    '--headless=new',
    '--no-sandbox',
    '--disable-gpu',
    '--no-first-run',
    '--no-default-browser-check',
    '--remote-debugging-port=0',
    `--user-data-dir=${profile}`,
    'about:blank',
  ];
  const stdio = ['ignore', 'ignore', 'pipe'];
  const chrome = spawn(CHROME, args, { stdio });
  t.after(async () => {
    chrome.kill();
    await Promise.race([once(chrome, 'exit'), delay(2000)]);
    if (chrome.exitCode === null) chrome.kill('SIGKILL');
    const options = { recursive: true, force: true, maxRetries: 5 };
    await fs.rm(profile, options);
  });
  const file = path.join(profile, 'DevToolsActivePort');
  for (let attempt = 0; attempt < 100; attempt++) {
    const data = await fs.readFile(file, 'utf8').catch(() => '');
    const lines = data.trim().split('\n');
    if (lines.length === 2) {
      const socket = new WebSocket(`ws://127.0.0.1:${lines[0]}${lines[1]}`);
      await once(socket, 'open');
      const browser = new BrowserProtocol(socket);
      t.after(() => browser.close());
      return browser;
    }
    await delay(100);
  }
  throw new Error('Chrome did not start');
};

const readServer = async () => {
  const { Metacom } = require('metacom');
  const client = await Metacom.connect(`${ORIGIN.replace('http', 'ws')}/`);
  try {
    await client.load('sync');
    let position = 0;
    let source = '';
    const deltas = [];
    let more = true;
    while (more) {
      const reply = await client.api.sync.pull({ source, position });
      deltas.push(...reply.deltas);
      ({ source, position, more } = reply);
    }
    return deltas;
  } finally {
    client.close();
  }
};

test('XXII Chat in Chrome', { timeout: 240000 }, async (t) => {
  const dataPath = await fs.mkdtemp(path.join(os.tmpdir(), 'xxii-data-'));
  t.after(() => fs.rm(dataPath, { recursive: true, force: true }));
  let server = await startServer(dataPath);
  t.after(() => stopServer(server));
  const browser = await launch(t);

  const restart = async () => {
    server = await startServer(dataPath);
  };

  const stop = async () => {
    await stopServer(server);
  };

  const run = (session, body) => browser.evaluate(session, script(body));

  const focus = (session) => browser.request('Page.bringToFront', {}, session);

  const wait = async (session, body, timeoutMs = 15000) => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const isReady = await run(session, body).catch(() => false);
      if (isReady) return;
      await delay(100);
    }
    throw new Error(`Browser condition timed out: ${body}`);
  };

  const untilServer = async (check, timeoutMs = 15000) => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const deltas = await readServer().catch(() => null);
      if (deltas && check(deltas)) return;
      await delay(200);
    }
    throw new Error('Server condition timed out');
  };

  const open = async (browserContextId = undefined) => {
    const url = `${ORIGIN}/`;
    const params = { url, browserContextId };
    const { targetId } = await browser.request('Target.createTarget', params);
    const attach = { targetId, flatten: true };
    const target = await browser.request('Target.attachToTarget', attach);
    const { sessionId } = target;
    await browser.request('Runtime.enable', {}, sessionId);
    await browser.request('Page.enable', {}, sessionId);
    await wait(sessionId, 'return app.uplink?.link.source !== "";');
    return sessionId;
  };

  const send = (session, nick, content) =>
    run(
      session,
      `app.usernameInput.value = ${JSON.stringify(nick)};
      app.messageInput.value = ${JSON.stringify(content)};
      await app.sendMessage();
      return true;`,
    );

  const findText = (content) => {
    const text = JSON.stringify(content);
    return `[...app.replica.keys('message')].find((id) =>
      app.replica.get(id).content === ${text})`;
  };

  const hasText = (content) => `return ${findText(content)} !== undefined;`;

  const shown = (content) =>
    `return app.messageList.textContent.includes(${JSON.stringify(content)});`;

  const serverHas = (content) => (deltas) =>
    deltas.some((delta) => delta.data.content?.$lww.value === content);

  const first = await open();
  const second = await open();

  await t.test('general chat exists everywhere', async () => {
    const title = await run(first, 'return app.chatTitle.textContent;');
    assert.equal(title, '!general');
    await untilServer((deltas) => deltas[0].target === 'general');
  });

  await t.test('tabs share messages and reactions', async () => {
    await send(first, 'ada', 'hello from tab one');
    await wait(second, shown('hello from tab one'));
    await untilServer(serverHas('hello from tab one'));
    const id = await run(first, `return ${findText('hello from tab one')};`);
    await run(
      second,
      `document.querySelector('.reaction[data-message-id="${id}"]' +
        '[data-reaction="like"]').click(); return true;`,
    );
    const liked = `return app.replica.get('${id}').reactions?.like === 1;`;
    await wait(first, liked);
    await focus(first);
    await wait(first, shown('hello from tab one'));
    const count = await run(
      first,
      `return document.querySelector('.reaction[data-message-id="${id}"]' +
        '[data-reaction="like"]').dataset.count;`,
    );
    assert.equal(count, '1');
  });

  await t.test('new chat appears in other tab with unread badge', async () => {
    await run(
      first,
      `app.chatNameInput.value = 'dev';
      app.createChat();
      return true;`,
    );
    const chatId = await run(first, 'return app.chat;');
    await wait(second, `return app.replica.get('${chatId}')?.name === 'dev';`);
    await send(first, 'ada', 'in dev chat');
    await focus(second);
    const badge = `return document.querySelector(
      '.chat-item[data-id="${chatId}"] .badge').textContent === '1';`;
    await wait(second, badge);
    await run(second, `app.selectChat('${chatId}'); return true;`);
    await wait(second, shown('in dev chat'));
    const hidden = `return document.querySelector(
      '.chat-item[data-id="${chatId}"] .badge').classList.contains('hidden');`;
    await wait(second, hidden);
  });

  await t.test('older messages load on demand', async () => {
    await focus(first);
    for (let i = 0; i < 55; i++) await send(first, 'ada', `bulk ${i}`);
    await wait(first, 'return app.messageList.children.length === 50;');
    const button = 'return !app.loadMoreBtn.classList.contains("hidden");';
    await wait(first, button);
    await run(first, 'app.loadOlder(); return true;');
    await wait(first, 'return app.messageList.children.length === 56;');
  });

  await t.test('restarted worker loads its replica from OPFS', async () => {
    await stop();
    await browser.request('ServiceWorker.enable', {}, second);
    await browser.request('ServiceWorker.stopAllWorkers', {}, second);
    await browser.request('Page.reload', {}, first);
    await browser.request('Page.reload', {}, second);
    await wait(first, hasText('hello from tab one'));
    await wait(second, hasText('bulk 54'));
  });

  await t.test('offline message reaches the server later', async () => {
    await run(first, `app.selectChat('general'); return true;`);
    await send(first, 'ada', 'written while server is down');
    await wait(second, hasText('written while server is down'));
    await restart();
    await untilServer(serverHas('written while server is down'), 20000);
  });

  await t.test('peers in two browsers chat over WebRTC', async () => {
    const contexts = [];
    for (let i = 0; i < 2; i++) {
      const created = await browser.request('Target.createBrowserContext');
      contexts.push(created.browserContextId);
    }
    const host = await open(contexts[0]);
    const guest = await open(contexts[1]);
    await wait(guest, hasText('written while server is down'));
    await run(host, `await app.peers.host('e2e'); return true;`);
    await run(guest, `app.peers.join('e2e'); return true;`);
    await wait(host, 'return app.peerConnected;', 30000);
    await wait(guest, 'return app.peerConnected;', 30000);
    await stop();
    await wait(host, 'return !app.connected;');
    await send(host, 'grace', 'over webrtc only');
    await wait(guest, hasText('over webrtc only'));
    await send(guest, 'linus', 'reply over webrtc');
    await wait(host, hasText('reply over webrtc'));
    await restart();
    await untilServer((deltas) => {
      const hasHost = serverHas('over webrtc only')(deltas);
      return hasHost && serverHas('reply over webrtc')(deltas);
    }, 25000);
    await wait(first, hasText('reply over webrtc'));
    await run(host, 'await app.peers.leave(); return true;');
    await run(guest, 'await app.peers.leave(); return true;');
  });

  await t.test('clear database empties tabs until next sync', async () => {
    await run(first, 'await app.clearDatabase(); return true;');
    await wait(first, 'return [...app.replica.keys("message")].length === 0;');
    await wait(second, 'return [...app.replica.keys("message")].length === 0;');
    await focus(second);
    await wait(second, 'return app.chatTitle.textContent === "!general";');
    await send(second, 'ada', 'after clear');
    await wait(first, hasText('after clear'));
    await wait(first, hasText('hello from tab one'));
  });

  assert.deepEqual(browser.errors, []);
});
