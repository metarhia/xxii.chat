'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const load = () => import('../application/static/ice.js');

const memory = (key, raw) => {
  const box = new Map();
  if (raw !== undefined) box.set(key, raw);
  return {
    getItem: (name) => (box.has(name) ? box.get(name) : null),
    setItem: (name, value) => box.set(name, value),
  };
};

const defaults = () => ({
  publicStun: false,
  forceRelay: false,
  servers: [],
});

test('ICE urls', async () => {
  const { isIceUrl } = await load();
  const urls = [
    'stun:stun.l.google.com:19302',
    'stuns:stun.example.com:5349',
    'turn:turn.example.com:3478?transport=udp',
    'turns:turn.example.com:5349?transport=tcp',
  ];
  for (const url of urls) assert.equal(isIceUrl(url), true);
  assert.equal(isIceUrl('http://example.com'), false);
  assert.equal(isIceUrl('not a url'), false);
});

test('readIce drops a bad url and defaults broken JSON', async () => {
  const { ICE_KEY, readIce, writeIce } = await load();
  const saved = {
    publicStun: true,
    forceRelay: false,
    servers: [
      {
        url: 'turn:turn.example.com:3478',
        username: 'ada',
        credential: 'secret',
      },
      { url: 'http://example.com', username: 'x', credential: 'y' },
    ],
  };
  const store = memory(ICE_KEY, JSON.stringify(saved));
  const settings = readIce(store);
  assert.equal(settings.publicStun, true);
  assert.equal(settings.forceRelay, false);
  assert.deepEqual(settings.servers, [saved.servers[0]]);
  assert.deepEqual(readIce(memory(ICE_KEY, '{')), defaults());
  assert.deepEqual(readIce(memory(ICE_KEY)), defaults());
  const failing = {
    getItem: () => null,
    setItem: (key, value) => {
      throw new Error(`${key}:${value.length}`);
    },
  };
  assert.equal(writeIce(failing, defaults()), false);
});

test('buildIce appends public STUN, a user server, and relay', async () => {
  const { buildIce } = await load();
  const servers = [{ urls: ['stun:chat.example.com:3478'] }];
  const user = {
    url: 'turn:turn.example.com:3478',
    username: 'ada',
    credential: 'secret',
  };
  const off = buildIce({
    servers,
    settings: defaults(),
    now: 1_000,
  });
  assert.deepEqual(off.iceServers, servers);
  assert.equal(off.iceTransportPolicy, 'all');
  const on = buildIce({
    servers,
    settings: { publicStun: true, forceRelay: true, servers: [user] },
    now: 2_000,
  });
  assert.deepEqual(on.iceServers[0], servers[0]);
  assert.deepEqual(on.iceServers[1], {
    urls: ['stun:stun.l.google.com:19302'],
  });
  assert.deepEqual(on.iceServers[2], {
    urls: ['stun:stun.cloudflare.com:3478'],
  });
  assert.deepEqual(on.iceServers[3], {
    urls: [user.url],
    username: 'ada',
    credential: 'secret',
  });
  assert.equal(on.iceTransportPolicy, 'relay');
  assert.equal(servers.length, 1);
});

test('freshUntil is ten minutes before the smallest expiry', async () => {
  const { buildIce, CACHE_LEAD_SEC } = await load();
  const servers = [
    { urls: ['turn:b.example:3478'], username: '2000:peerB' },
    { urls: ['turn:a.example:3478'], username: '1700:peerA' },
  ];
  const settings = defaults();
  const built = buildIce({ servers, settings, now: 1_000 });
  const until = (1700 - CACHE_LEAD_SEC) * 1000;
  assert.equal(built.freshUntil, until);
  const plain = [{ urls: ['stun:chat.example.com:3478'] }];
  const open = buildIce({ servers: plain, settings, now: 5_000 });
  assert.equal(open.freshUntil, Infinity);
});

test('empty username and credential are omitted', async () => {
  const { buildIce } = await load();
  const settings = {
    publicStun: false,
    forceRelay: false,
    servers: [
      { url: 'stun:stun.example.com:3478', username: '', credential: '' },
      { url: 'turn:turn.example.com:3478', username: 'ada', credential: '' },
    ],
  };
  const built = buildIce({ servers: [], settings, now: 0 });
  assert.deepEqual(built.iceServers[0], {
    urls: ['stun:stun.example.com:3478'],
  });
  assert.equal('username' in built.iceServers[0], false);
  assert.equal('credential' in built.iceServers[0], false);
  assert.deepEqual(built.iceServers[1], {
    urls: ['turn:turn.example.com:3478'],
    username: 'ada',
  });
  assert.equal('credential' in built.iceServers[1], false);
});
