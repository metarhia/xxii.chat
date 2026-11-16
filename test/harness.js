'use strict';

const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { setTimeout: delay } = require('node:timers/promises');

const CHROME = process.env.CHROME_BIN ?? '/usr/bin/google-chrome';
const ROOT = path.join(__dirname, '..');
const ORIGIN = 'http://127.0.0.1:8001';
const MEDIA_FLAGS = [
  '--use-fake-ui-for-media-stream',
  '--use-fake-device-for-media-stream',
  '--auto-accept-this-tab-capture',
  '--auto-select-desktop-capture-source=Entire screen',
  '--autoplay-policy=no-user-gesture-required',
];

class BrowserProtocol {
  #socket = null;
  #id = 0;
  #pending = new Map();
  #listeners = new Map();
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
      const listener = this.#listeners.get(message.method);
      if (listener) listener(message.params, message.sessionId);
      const request = this.#pending.get(message.id);
      if (!request) return;
      this.#pending.delete(message.id);
      clearTimeout(request.timer);
      if (message.error) request.reject(new Error(message.error.message));
      else request.resolve(message.result);
    });
  }

  on(method, listener) {
    this.#listeners.set(method, listener);
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

const launch = async (t, flags) => {
  const extra = flags ?? [];
  const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'xxii-chrome-'));
  const args = [
    '--headless=new',
    '--no-sandbox',
    '--disable-gpu',
    '--no-first-run',
    '--no-default-browser-check',
    '--remote-debugging-port=0',
    `--user-data-dir=${profile}`,
    ...extra,
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

const run = (browser, session, body) => browser.evaluate(session, script(body));

const wait = async (browser, session, body, timeoutMs = 15000) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const isReady = await run(browser, session, body).catch(() => false);
    if (isReady) return;
    await delay(100);
  }
  throw new Error(`Browser condition timed out: ${body}`);
};

module.exports = {
  ORIGIN,
  MEDIA_FLAGS,
  BrowserProtocol,
  script,
  startServer,
  stopServer,
  launch,
  readServer,
  run,
  wait,
};
