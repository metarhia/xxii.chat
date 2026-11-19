'use strict';

const dgram = require('node:dgram');
const fs = require('node:fs/promises');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const { once } = require('node:events');
const { setTimeout: delay } = require('node:timers/promises');

const CHROME = process.env.CHROME_BIN ?? '/usr/bin/google-chrome';
const ROOT = path.join(__dirname, '..');
const RESERVE_FLAG = '--reserve-ports';
const APP_FLAG = '--app-tests';
const APP_ATTEMPTS = 4;

let apiPort = 0;
let icePort = 0;
let ORIGIN = '';
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
    if (this.#socket.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error('Browser connection is closed'));
    }
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

const BLOCKED_PORTS = [0, 3478, 8000, 8001];

const closeBound = (socket) =>
  new Promise((resolve) => {
    socket.close(() => resolve());
  });

const bindUdp = () =>
  new Promise((resolve, reject) => {
    const socket = dgram.createSocket('udp4');
    socket.once('error', reject);
    socket.bind({ port: 0, address: '0.0.0.0' }, () => {
      resolve({ socket, port: socket.address().port });
    });
  });

const holdTcp = (port) =>
  new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', () => {
      server.close();
      resolve(null);
    });
    const options = { port, host: '0.0.0.0', exclusive: true };
    server.listen(options, () => resolve(server));
  });

const takePort = async (excluded) => {
  for (let attempt = 0; attempt < 20; attempt++) {
    const udp = await bindUdp();
    const port = udp.port;
    const listed = BLOCKED_PORTS.includes(port);
    const skipped = listed || excluded.includes(port);
    if (skipped) {
      await closeBound(udp.socket);
      continue;
    }
    const tcp = await holdTcp(port);
    if (!tcp) {
      await closeBound(udp.socket);
      continue;
    }
    return { port, udp: udp.socket, tcp };
  }
  throw new Error('No free port');
};

const releaseHeld = async (held) => {
  await closeBound(held.udp);
  await closeBound(held.tcp);
};

const reservePort = async () => {
  const held = await takePort([]);
  await releaseHeld(held);
  return held.port;
};

const reservePair = async () => {
  const first = await takePort([]);
  let second = null;
  try {
    second = await takePort([first.port]);
  } catch (error) {
    await releaseHeld(first);
    throw error;
  }
  await releaseHeld(first);
  await releaseHeld(second);
  return [first.port, second.port];
};

const portFree = (port) =>
  new Promise((resolve) => {
    const server = net.createServer();
    let settled = false;
    const finish = (free) => {
      if (settled) return;
      settled = true;
      if (!server.listening) {
        resolve(free);
        return;
      }
      server.close(() => resolve(free));
    };
    server.once('error', () => finish(false));
    const options = { port, host: '0.0.0.0', exclusive: true };
    server.listen(options, () => finish(true));
  });

const heardPort = (output, port) => {
  const pattern = new RegExp(`Listen port ${port}([^0-9]|$)`);
  return pattern.test(output);
};

const waitForPorts = async (ports) => {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    let free = true;
    for (let index = 0; index < ports.length; index++) {
      const open = await portFree(ports[index]);
      if (!open) free = false;
    }
    if (free) return true;
    await delay(200);
  }
  return false;
};

const concretePort = (environment, name, fallback) => {
  if (!Object.hasOwn(environment, name)) return `${fallback}`;
  const text = `${environment[name]}`;
  const missing = text === '' || text === '0' || text === 'undefined';
  if (missing) return `${fallback}`;
  return text;
};

const stopServer = async (server) => {
  const stopped = server.exitCode !== null || server.signalCode !== null;
  if (!stopped) {
    const exited = once(server, 'exit');
    const timer = setTimeout(() => server.kill('SIGKILL'), 8000);
    try {
      server.kill('SIGINT');
      await exited;
    } finally {
      clearTimeout(timer);
    }
  }
  const ports = server.xxiiPorts ?? [];
  await waitForPorts(ports);
};

const tlsTextOf = (environment) => {
  const raw = environment.XXII_TURN_TLS_PORT;
  if (raw === undefined || `${raw}` === '') return '';
  return `${raw}`;
};

const spawnServer = async (dataPath, environment) => {
  const apiText = concretePort(environment, 'XXII_PORT', apiPort);
  const iceText = concretePort(environment, 'XXII_ICE_PORT', icePort);
  const tlsText = tlsTextOf(environment);
  const ports = [Number(apiText), Number(iceText)];
  if (tlsText !== '') ports.push(Number(tlsText));
  const ready = await waitForPorts(ports);
  if (!ready) {
    const both = `${apiText} and ${iceText}`;
    const listed = tlsText === '' ? both : `${both}, ${tlsText}`;
    const message = `Ports ${listed} are still in use`;
    throw new Error(message);
  }
  const env = {
    ...process.env,
    ...environment,
    XXII_PORT: apiText,
    XXII_ICE_PORT: iceText,
    XXII_DATA: dataPath,
  };
  const stdio = ['ignore', 'pipe', 'pipe'];
  const options = { cwd: ROOT, env, stdio };
  const server = spawn(process.execPath, ['server.js'], options);
  server.xxiiPorts = ports;
  let output = '';
  server.xxiiLog = () => output;
  const collect = (data) => {
    output += data.toString();
  };
  server.stdout.on('data', collect);
  server.stderr.on('data', collect);
  for (let attempt = 0; attempt < 150; attempt++) {
    const apiUp = heardPort(output, apiText);
    const iceUp = heardPort(output, iceText);
    const tlsUp = tlsText === '' || heardPort(output, tlsText);
    if (apiUp && iceUp && tlsUp) return server;
    if (server.exitCode !== null) break;
    await delay(100);
  }
  await stopServer(server);
  throw new Error(`Server did not start:\n${output}`);
};

const startServer = async (dataPath, environment = {}) => {
  let last = new Error('Server did not start');
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      return await spawnServer(dataPath, environment);
    } catch (error) {
      last = error;
      const busy = `${error.message}`.includes('EADDRINUSE');
      const held = `${error.message}`.includes('still in use');
      if (!busy && !held) throw error;
      await delay(500);
    }
  }
  throw last;
};

const startCallServer = async (t) => {
  const dataPath = await fs.mkdtemp(path.join(os.tmpdir(), 'xxii-data-'));
  let server = null;
  t.after(async () => {
    if (server) await stopServer(server);
    const options = {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 100,
    };
    await fs.rm(dataPath, options);
  });
  server = await startServer(dataPath);
  return server;
};

const launch = async (t, flags, env = null) => {
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
  const options = { stdio };
  if (env) options.env = { ...process.env, ...env };
  const chrome = spawn(CHROME, args, options);
  const stderr = { text: '' };
  const readStderr = () => stderr.text;
  chrome.stderr.on('data', (chunk) => {
    stderr.text += chunk.toString();
  });
  const ended = () => chrome.exitCode !== null || chrome.signalCode !== null;
  const stopChrome = async () => {
    if (ended()) return;
    chrome.kill();
    await Promise.race([once(chrome, 'exit'), delay(2000)]);
    if (!ended()) chrome.kill('SIGKILL');
  };
  t.after(async () => {
    await stopChrome();
    const remove = { recursive: true, force: true, maxRetries: 5 };
    await fs.rm(profile, remove);
  });
  const file = path.join(profile, 'DevToolsActivePort');
  for (let attempt = 0; attempt < 100; attempt++) {
    const data = await fs.readFile(file, 'utf8').catch(() => '');
    const lines = data.trim().split('\n');
    if (lines.length === 2) {
      const socket = new WebSocket(`ws://127.0.0.1:${lines[0]}${lines[1]}`);
      await once(socket, 'open');
      const browser = new BrowserProtocol(socket);
      browser.stderrText = readStderr;
      browser.stopChrome = stopChrome;
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

const runAppOnce = (apiPort, icePort) =>
  new Promise((resolve) => {
    const env = {
      ...process.env,
      MODE: 'test',
      XXII_PORT: `${apiPort}`,
      XXII_ICE_PORT: `${icePort}`,
    };
    const stdio = ['ignore', 'pipe', 'pipe'];
    const options = { cwd: ROOT, env, stdio };
    const child = spawn(process.execPath, ['server.js'], options);
    let output = '';
    const collect = (chunk) => {
      output += chunk.toString();
      process.stdout.write(chunk);
    };
    child.stdout.on('data', collect);
    child.stderr.on('data', collect);
    child.once('exit', (code) => {
      const status = code === null ? 1 : code;
      resolve({ code: status, output });
    });
  });

const runAppTests = async () => {
  let lastCode = 1;
  for (let attempt = 0; attempt < APP_ATTEMPTS; attempt++) {
    const ports = await reservePair();
    const apiPort = ports[0];
    const icePort = ports[1];
    const result = await runAppOnce(apiPort, icePort);
    lastCode = result.code;
    const failed = result.code !== 0;
    const busy = failed && result.output.includes('EADDRINUSE');
    if (!busy) break;
  }
  process.exitCode = lastCode;
};

const readReserved = () => {
  const args = [__filename, RESERVE_FLAG];
  const stdio = ['ignore', 'pipe', 'pipe'];
  const options = { encoding: 'utf8', stdio };
  const result = spawnSync(process.execPath, args, options);
  if (result.status !== 0) {
    const detail = `${result.stderr || result.stdout}`.trim();
    throw new Error(detail || 'No free port');
  }
  const lines = result.stdout.trim().split('\n');
  return [Number(lines[0]), Number(lines[1])];
};

if (process.argv.includes(RESERVE_FLAG)) {
  reservePair()
    .then((ports) => {
      process.stdout.write(`${ports[0]}\n${ports[1]}\n`);
    })
    .catch((error) => {
      process.stderr.write(`${error.stack}\n`);
      process.exitCode = 1;
    });
} else if (process.argv.includes(APP_FLAG)) {
  runAppTests().catch((error) => {
    process.stderr.write(`${error.stack}\n`);
    process.exitCode = 1;
  });
} else {
  const reserved = readReserved();
  apiPort = reserved[0];
  icePort = reserved[1];
  ORIGIN = `http://127.0.0.1:${apiPort}`;
}

module.exports = {
  ORIGIN,
  MEDIA_FLAGS,
  BrowserProtocol,
  script,
  stopServer,
  startServer,
  reservePort,
  reservePair,
  startCallServer,
  launch,
  readServer,
  run,
  wait,
};
