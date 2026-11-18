'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const tls = require('node:tls');
const { setTimeout: delay } = require('node:timers/promises');

const harness = require('./harness.js');

const { MEDIA_FLAGS, ORIGIN, launch, reservePort } = harness;
const { startServer, stopServer } = harness;

const LOOPBACK = '--allow-loopback-in-peer-connection';
const FLAGS = MEDIA_FLAGS.concat([LOOPBACK]);
const BLOCKED_PORTS = [0, 3478, 8000, 8001];
const SPKI_LIST = 'BW+uQlcILU9mGlYBk2EcugKe9YmtEG0FvzJMJXedofc=';
const SPKI_FLAG = '--ignore-certificate-errors-spki-list=' + SPKI_LIST;
const METAICE = path.resolve(__dirname, '../../metaice/test/fixtures');
const CERT_DIR = path.join(__dirname, '../application/cert/localhost');
const ALPN_LOG = '/tmp/xxii-calls/a3-alpn.txt';
const TRUST_MARKS = [
  'CERT_AUTHORITY_INVALID',
  'ERR_CERT_AUTHORITY_INVALID',
  'net_error -202',
  'certificate unknown',
  'SSL alert number 46',
];
const CHAT = JSON.stringify('general');
const REMOVE = {
  recursive: true,
  force: true,
  maxRetries: 5,
  retryDelay: 100,
};
const READY =
  'return app.connected === true && app.mesh.peers.has(app.peerId);';
const JOIN = `const button = document.querySelector(
  '#prejoin [data-action=join]');
  if (!button) throw new Error('no join');
  button.click();
  return true;`;
const WATCH = `const Native = globalThis.RTCPeerConnection;
  const peers = [];
  globalThis.xxiiCallPeers = peers;
  const Wrapped = class extends Native {
    constructor(configuration) {
      super(configuration);
      peers.push(this);
    }
  };
  globalThis.RTCPeerConnection = Wrapped;
  return true;`;

const rememberEnv = () => ({
  ice: process.env.XXII_ICE_PORT,
  secret: process.env.XXII_TURN_SECRET,
  address: process.env.XXII_TURN_PUBLIC_ADDRESS,
  peers: process.env.XXII_TURN_PRIVATE_PEERS,
});

const assertEnv = (held) => {
  assert.equal(process.env.XXII_ICE_PORT, held.ice);
  assert.equal(process.env.XXII_TURN_SECRET, held.secret);
  assert.equal(process.env.XXII_TURN_PUBLIC_ADDRESS, held.address);
  assert.equal(process.env.XXII_TURN_PRIVATE_PEERS, held.peers);
};

const environmentFor = (port) => ({
  XXII_ICE_PORT: `${port}`,
  XXII_TURN_SECRET: crypto.randomBytes(32).toString('hex'),
  XXII_TURN_PUBLIC_ADDRESS: '127.0.0.1',
  XXII_TURN_PRIVATE_PEERS: 'true',
});

const probeIce = (port) =>
  new Promise((resolve) => {
    const socket = net.connect({ host: '127.0.0.1', port });
    let settled = false;
    let timer = null;
    const finish = (open) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(open);
    };
    timer = setTimeout(() => finish(false), 500);
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
  });

const waitForIce = async (port) => {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    const open = await probeIce(port);
    if (open) return;
    await delay(100);
  }
  throw new Error(`ICE port ${port} did not open`);
};

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

const openContext = async (browser, origin = ORIGIN) => {
  const created = await browser.request('Target.createBrowserContext');
  const browserContextId = created.browserContextId;
  const url = `${origin}/`;
  const params = { url, browserContextId };
  const opened = await browser.request('Target.createTarget', params);
  const targetId = opened.targetId;
  const attach = { targetId, flatten: true };
  const target = await browser.request('Target.attachToTarget', attach);
  const sessionId = target.sessionId;
  await browser.request('Runtime.enable', {}, sessionId);
  await browser.request('Page.enable', {}, sessionId);
  await untilLoaded(browser, sessionId);
  return { browserContextId, sessionId };
};

const openPerson = async (t, browser, origin = ORIGIN) => {
  const person = await openContext(browser, origin);
  const id = person.browserContextId;
  t.after(() =>
    browser
      .request('Target.disposeBrowserContext', { browserContextId: id })
      .catch(() => undefined),
  );
  return person;
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

const iceScript = (port, secure) => {
  const scheme = secure ? 'turns:' : 'turn:';
  const query = secure ? '?transport=tcp' : '?transport=udp';
  return `const host = location.hostname;
  const list = await app.api.ice.servers({ host });
  const url = '${scheme}' + host + ':' + ${port} + '${query}';
  let username = '';
  let credential = '';
  let found = false;
  for (const entry of list) {
    const urls = Array.isArray(entry.urls) ? entry.urls : [entry.urls];
    if (!urls.includes(url)) continue;
    found = true;
    if (typeof entry.username === 'string') username = entry.username;
    if (typeof entry.credential === 'string') credential = entry.credential;
  }
  const configuration = await app.iceConfiguration();
  return {
    host,
    url,
    found,
    username,
    credential,
    policy: configuration.iceTransportPolicy,
  };`;
};

const watchTls = (port) => `const Native = globalThis.RTCPeerConnection;
  const peers = [];
  globalThis.xxiiCallPeers = peers;
  const turns = 'turns:' + location.hostname + ':' + ${port};
  const suffix = '?transport=tcp';
  const url = turns + suffix;
  const Wrapped = class extends Native {
    constructor(configuration) {
      const next = configuration ? { ...configuration } : {};
      const servers = next.iceServers;
      const list = Array.isArray(servers) ? servers : [];
      const kept = [];
      for (const entry of list) {
        const urls = Array.isArray(entry.urls) ? entry.urls : [entry.urls];
        if (!urls.includes(url)) continue;
        kept.push({ ...entry, urls: [url] });
      }
      next.iceServers = kept;
      super(next);
      peers.push(this);
    }
  };
  globalThis.RTCPeerConnection = Wrapped;
  return true;`;

const prepare = async (browser, session, port, secure = false) => {
  const run = (body) => harness.run(browser, session, body);
  const saved = await run(`return app.commitIce({
    publicStun: false,
    forceRelay: true,
    servers: [],
  });`);
  assert.equal(saved, true);
  const turn = await run(iceScript(port, secure));
  const scheme = secure ? 'turns' : 'turn';
  const transport = secure ? 'tcp' : 'udp';
  const expected = `${scheme}:${turn.host}:${port}?transport=${transport}`;
  const expectedHost = secure ? 'localhost' : '127.0.0.1';
  assert.equal(turn.host, expectedHost);
  assert.equal(turn.found, true);
  assert.equal(turn.url, expected);
  assert.equal(turn.policy, 'relay');
  assert.equal(turn.username.length > 0, true);
  assert.equal(turn.credential.length > 0, true);
  assert.equal(port === 0 || port === 3478, false);
  const watch = secure ? watchTls(port) : WATCH;
  await run(watch);
};

const selectorOf = (endpoint) =>
  JSON.stringify(`#call-view [data-endpoint="${endpoint}"]`);

const selectedRelay = (endpoint) => {
  const remote = JSON.stringify(endpoint);
  return `const remote = ${remote};
    const session = app.callSession;
    const sender = session ? session.sender(remote, 'camera') : null;
    if (!sender) throw new Error('no sender');
    const peers = globalThis.xxiiCallPeers || [];
    const track = sender.track;
    const trackId = track ? track.id : '';
    let connection = null;
    for (const peer of peers) {
      const senders = peer.getSenders();
      for (const item of senders) {
        const itemTrack = item.track;
        const itemId = itemTrack ? itemTrack.id : '';
        const sameTrack = trackId !== '' && itemId === trackId;
        if (item === sender || sameTrack) connection = peer;
      }
    }
    if (!connection) throw new Error('no peer connection');
    const report = await connection.getStats();
    let pairId = '';
    for (const item of report.values()) {
      const selected = item.selectedCandidatePairId;
      if (item.type === 'transport' && selected) pairId = selected;
    }
    const pair = pairId ? report.get(pairId) : null;
    const localId = pair ? pair.localCandidateId : '';
    const local = localId ? report.get(localId) : null;
    const type = local ? local.candidateType : 'none';
    const state = pair ? pair.state : 'none';
    const selected = state === 'succeeded' && type === 'relay';
    if (!selected) throw new Error('pair ' + state + ' candidate ' + type);
    return true;`;
};

const mediaFlow = (endpoint) => {
  const selector = selectorOf(endpoint);
  const remote = JSON.stringify(endpoint);
  return `app.render();
    const remote = ${remote};
    const session = app.callSession;
    const receiver = session ? session.receiver(remote, 'mic') : null;
    const sources = receiver ? receiver.getSynchronizationSources() : [];
    let level = 0;
    for (const source of sources) {
      if (source.audioLevel > level) level = source.audioLevel;
    }
    const tile = document.querySelector(${selector});
    const video = tile ? tile.querySelector('video') : null;
    const width = video ? video.videoWidth : 0;
    if (level > 0 && width > 0) return true;
    throw new Error('level ' + level + ' width ' + width);`;
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
    return await done;`;
};

const linked = (count) => `const session = app.callSession;
  if (!session || session.phase !== 'joined') return false;
  return session.linkCount === ${count};`;

const expectFlow = async (browser, session, endpoint) => {
  await waitFor(browser, session, selectedRelay(endpoint), 30000);
  await front(browser, session);
  await waitFor(browser, session, mediaFlow(endpoint), 20000);
  await front(browser, session);
  const frames = await harness.run(browser, session, countFrames(endpoint));
  assert.equal(frames >= 10, true);
  const relay = await harness.run(browser, session, selectedRelay(endpoint));
  assert.equal(relay, true);
};

const startPair = async (run, left, right) => {
  const host = await run(
    left,
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
    right,
    `app.selectChat(${CHAT});
      await app.startCall(${CHAT}, { token: ${given} });
      return app.callSession.endpoint;`,
  );
  assert.notEqual(host.endpoint, guest);
  await run(left, JOIN);
  await run(right, JOIN);
  return { host, guest };
};

test(
  'scenario 9: force relay through own TURN in both contexts',
  { timeout: 120000 },
  async (t) => {
    const held = rememberEnv();
    t.after(() => assertEnv(held));
    const port = await reservePort();
    assert.equal(BLOCKED_PORTS.includes(port), false);
    const environment = environmentFor(port);
    const dataPath = await fs.mkdtemp(path.join(os.tmpdir(), 'xxii-data-'));
    t.after(() => fs.rm(dataPath, REMOVE));
    const server = await startServer(dataPath, environment);
    t.after(() => stopServer(server));
    await waitForIce(port);
    const browser = await launch(t, FLAGS);
    const run = (session, body) => harness.run(browser, session, body);
    const left = await openPerson(t, browser);
    const right = await openPerson(t, browser);
    await waitFor(browser, left.sessionId, READY);
    await waitFor(browser, right.sessionId, READY);
    const leftPeer = await run(left.sessionId, 'return app.peerId;');
    const rightPeer = await run(right.sessionId, 'return app.peerId;');
    assert.notEqual(leftPeer, rightPeer);
    await prepare(browser, left.sessionId, port);
    await prepare(browser, right.sessionId, port);
    const pair = await startPair(run, left.sessionId, right.sessionId);
    await waitFor(browser, left.sessionId, linked(1), 30000);
    await waitFor(browser, right.sessionId, linked(1), 30000);
    await expectFlow(browser, left.sessionId, pair.guest);
    await expectFlow(browser, right.sessionId, pair.host.endpoint);
    await run(left.sessionId, 'await app.closeCall();');
    await run(right.sessionId, 'await app.closeCall();');
  },
);

const originPort = () => {
  const index = ORIGIN.lastIndexOf(':');
  return Number(ORIGIN.slice(index + 1));
};

const listingOf = () => {
  const result = spawnSync('ss', ['-ltnp'], { encoding: 'utf8' });
  return `${result.stdout || ''}`;
};

const heldLine = (listing, port) => {
  const pattern = new RegExp(`:${port}(?:\\s|$)`);
  const lines = listing.split('\n');
  for (const line of lines) {
    if (pattern.test(line)) return line.trim();
  }
  return '';
};

const requireFree = (listing, port) => {
  const held = heldLine(listing, port);
  if (!held) return;
  throw new Error(`Port ${port} is held: ${held}`);
};

const reserveFree = async (taken) => {
  for (let attempt = 0; attempt < 20; attempt++) {
    const port = await reservePort();
    const blocked = BLOCKED_PORTS.includes(port) || taken.includes(port);
    if (blocked) continue;
    const listing = listingOf();
    requireFree(listing, port);
    return port;
  }
  throw new Error('No free TLS port');
};

const installFixture = async () => {
  await fs.rm(CERT_DIR, REMOVE);
  await fs.mkdir(CERT_DIR, { recursive: true });
  const cert = path.join(METAICE, 'turn-cert.pem');
  const key = path.join(METAICE, 'turn-key.pem');
  await fs.copyFile(cert, path.join(CERT_DIR, 'cert.pem'));
  await fs.copyFile(key, path.join(CERT_DIR, 'key.pem'));
};

const spkiOf = (raw) => {
  const x509 = new crypto.X509Certificate(raw);
  const der = x509.publicKey.export({ type: 'spki', format: 'der' });
  return crypto.createHash('sha256').update(der).digest('base64');
};

const presentedSpki = (port, servername) =>
  new Promise((resolve, reject) => {
    let settled = false;
    let socket = null;
    let timer = null;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (socket) socket.destroy();
      if (error) reject(error);
      else resolve(value);
    };
    timer = setTimeout(() => {
      finish(new Error(`TLS timeout for ${servername}`));
    }, 5000);
    const options = {
      host: '127.0.0.1',
      port,
      servername,
      rejectUnauthorized: false,
      ALPNProtocols: ['http/1.1'],
    };
    socket = tls.connect(options, () => {
      const peer = socket.getPeerCertificate();
      const raw = peer && peer.raw ? peer.raw : null;
      if (!raw) {
        finish(new Error(`no certificate for ${servername}`));
        return;
      }
      finish(null, spkiOf(raw));
    });
    socket.once('error', (error) => finish(error));
  });

const assertFixture = async (port) => {
  const local = await presentedSpki(port, 'localhost');
  const loopback = await presentedSpki(port, '127.0.0.1');
  assert.equal(local, SPKI_LIST);
  assert.equal(loopback, SPKI_LIST);
};

const writeAlpn = async (server) => {
  const text = server && server.xxiiLog ? server.xxiiLog() : '';
  const lines = [];
  for (const line of text.split('\n')) {
    if (line.includes('alpn')) lines.push(line);
  }
  await fs.mkdir('/tmp/xxii-calls', { recursive: true });
  const body = lines.length === 0 ? '' : `${lines.join('\n')}\n`;
  await fs.writeFile(ALPN_LOG, body);
};

const runCertutil = (args) => {
  const result = spawnSync('certutil', args, { encoding: 'utf8' });
  if (result.status === 0) return;
  const detail = `${result.stderr || result.stdout}`.trim();
  throw new Error(detail || 'certutil failed');
};

const trustHome = async (t) => {
  const home = await fs.mkdtemp(path.join('/tmp', 'xxii-nss-'));
  t.after(() => fs.rm(home, REMOVE));
  const db = path.join(home, '.pki', 'nssdb');
  await fs.mkdir(db, { recursive: true });
  const dir = `sql:${db}`;
  runCertutil(['-N', '--empty-password', '-d', dir]);
  const cert = path.join(CERT_DIR, 'cert.pem');
  const add = ['-A', '-d', dir, '-n', 'turn', '-t', 'C,,', '-i', cert];
  runCertutil(add);
  return home;
};

const trustFailure = (error, browser) => {
  const stderr = browser.stderrText();
  const message = `${error.message}\n${stderr}`;
  for (const mark of TRUST_MARKS) {
    if (message.includes(mark)) return message;
  }
  return '';
};

const driveCall = async (t, browser, port, origin) => {
  const run = (session, body) => harness.run(browser, session, body);
  const left = await openPerson(t, browser, origin);
  const right = await openPerson(t, browser, origin);
  await waitFor(browser, left.sessionId, READY);
  await waitFor(browser, right.sessionId, READY);
  const leftPeer = await run(left.sessionId, 'return app.peerId;');
  const rightPeer = await run(right.sessionId, 'return app.peerId;');
  assert.notEqual(leftPeer, rightPeer);
  await prepare(browser, left.sessionId, port, true);
  await prepare(browser, right.sessionId, port, true);
  const pair = await startPair(run, left.sessionId, right.sessionId);
  await waitFor(browser, left.sessionId, linked(1), 30000);
  await waitFor(browser, right.sessionId, linked(1), 30000);
  await expectFlow(browser, left.sessionId, pair.guest);
  await expectFlow(browser, right.sessionId, pair.host.endpoint);
  await run(left.sessionId, 'await app.closeCall();');
  await run(right.sessionId, 'await app.closeCall();');
};

test(
  'scenario 9 TLS: force relay through TURN over TLS',
  { timeout: 240000 },
  async (t) => {
    const held = rememberEnv();
    t.after(() => assertEnv(held));
    let server = null;
    t.after(() => writeAlpn(server));
    t.after(() => fs.rm(CERT_DIR, REMOVE));
    const ice = await reservePort();
    assert.equal(BLOCKED_PORTS.includes(ice), false);
    const api = originPort();
    const tlsPort = await reserveFree([api, ice]);
    const listing = listingOf();
    requireFree(listing, api);
    requireFree(listing, ice);
    requireFree(listing, tlsPort);
    await installFixture();
    const environment = environmentFor(ice);
    environment.XXII_TURN_TLS_PORT = `${tlsPort}`;
    const dataPath = await fs.mkdtemp(path.join(os.tmpdir(), 'xxii-data-'));
    t.after(() => fs.rm(dataPath, REMOVE));
    server = await startServer(dataPath, environment);
    t.after(() => stopServer(server));
    await waitForIce(ice);
    await assertFixture(tlsPort);
    const flags = FLAGS.concat([SPKI_FLAG, '--disable-ipv6']);
    const origin = `http://localhost:${api}`;
    const browser = await launch(t, flags);
    try {
      await driveCall(t, browser, tlsPort, origin);
    } catch (error) {
      const failure = trustFailure(error, browser);
      if (!failure) {
        const stderr = browser.stderrText().slice(-1500);
        throw new Error(`${error.message}\n${stderr}`);
      }
      await browser.stopChrome();
      const home = await trustHome(t);
      const retry = await launch(t, flags, { HOME: home });
      try {
        await driveCall(t, retry, tlsPort, origin);
      } catch (retryError) {
        const again = trustFailure(retryError, retry);
        const detail = again || retryError.message;
        const message = `SPKI list failed:\n${failure}\nNSS failed:\n${detail}`;
        throw new Error(message);
      }
    }
  },
);
