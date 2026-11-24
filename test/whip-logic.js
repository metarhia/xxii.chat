'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const load = () => import('../application/static/whip.js');

const valid = {
  id: 'one',
  name: 'Twitch',
  url: 'https://ingest.example.com/whip',
  token: 'secret',
  bitrate: 6000000,
  enabled: true,
};

test('destinations: a valid entry loads as written', async () => {
  const { destinationOf } = await load();
  assert.deepEqual(destinationOf(valid), valid);
  const bare = { id: 'two', name: ' Me ', url: valid.url };
  const loaded = destinationOf(bare);
  assert.equal(loaded.name, 'Me');
  assert.equal(loaded.token, '');
  assert.equal(loaded.bitrate, 6000000);
  assert.equal(loaded.enabled, false);
});

test('destinations: names are limited to 48 characters', async () => {
  const { destinationOf } = await load();
  const long = { ...valid, name: 'x'.repeat(48) };
  assert.ok(destinationOf(long));
  assert.equal(destinationOf({ ...valid, name: 'x'.repeat(49) }), null);
  assert.equal(destinationOf({ ...valid, name: '   ' }), null);
  assert.equal(destinationOf({ ...valid, name: 7 }), null);
});

test('destinations: https, or http only for loopback', async () => {
  const { isEndpointUrl } = await load();
  assert.equal(isEndpointUrl('https://a.example/whip'), true);
  assert.equal(isEndpointUrl('http://a.example/whip'), false);
  assert.equal(isEndpointUrl('http://localhost:8889/live/whip'), true);
  assert.equal(isEndpointUrl('http://127.0.0.1:8889/whip'), true);
  assert.equal(isEndpointUrl('http://[::1]:8889/whip'), true);
  assert.equal(isEndpointUrl('http://127.0.0.2/whip'), false);
  assert.equal(isEndpointUrl('http://localhost.example/whip'), false);
  assert.equal(isEndpointUrl('https://user:pass@a.example/whip'), false);
  assert.equal(isEndpointUrl('ftp://a.example/whip'), false);
  assert.equal(isEndpointUrl('not a url'), false);
  assert.equal(isEndpointUrl(undefined), false);
});

test('destinations: bitrate is 1 to 20 Mbps', async () => {
  const { destinationOf } = await load();
  assert.ok(destinationOf({ ...valid, bitrate: 1000000 }));
  assert.ok(destinationOf({ ...valid, bitrate: 20000000 }));
  assert.equal(destinationOf({ ...valid, bitrate: 999999 }), null);
  assert.equal(destinationOf({ ...valid, bitrate: 20000001 }), null);
  assert.equal(destinationOf({ ...valid, bitrate: '6000000' }), null);
  assert.equal(destinationOf({ ...valid, bitrate: NaN }), null);
});

test('destinations: token must be text, id must be present', async () => {
  const { destinationOf, problemOf } = await load();
  assert.equal(destinationOf({ ...valid, token: 5 }), null);
  assert.equal(destinationOf({ ...valid, id: '' }), null);
  assert.equal(destinationOf(null), null);
  assert.equal(problemOf(valid), '');
  assert.match(problemOf({ ...valid, url: 'http://a.example' }), /https/);
  assert.match(problemOf({ ...valid, bitrate: 0 }), /1 to 20 Mbps/);
  assert.match(problemOf({ ...valid, name: '' }), /name/);
});

test('destinations: invalid entries are dropped on load', async () => {
  const { destinationsOf, readDestinations } = await load();
  const list = [
    valid,
    { ...valid, id: 'bad', url: 'http://a.example' },
    { ...valid, id: 'one' },
    null,
    'text',
    { ...valid, id: 'two', enabled: 'yes' },
  ];
  const loaded = destinationsOf(list);
  assert.deepEqual(
    loaded.map(({ id }) => id),
    ['one', 'two'],
  );
  assert.equal(loaded[1].enabled, false);
  assert.deepEqual(destinationsOf('nope'), []);
  const storage = { getItem: () => JSON.stringify(list) };
  assert.equal(readDestinations(storage).length, 2);
  const broken = { getItem: () => '{' };
  assert.deepEqual(readDestinations(broken), []);
  const throwing = {
    getItem: () => {
      throw new Error('blocked');
    },
  };
  assert.deepEqual(readDestinations(throwing), []);
});

test('destinations: at most 2 stay enabled', async () => {
  const { destinationsOf } = await load();
  const list = ['a', 'b', 'c'].map((id) => ({ ...valid, id }));
  const loaded = destinationsOf(list);
  assert.deepEqual(
    loaded.map(({ enabled }) => enabled),
    [true, true, false],
  );
});

test('destinations: writing reports a blocked store', async () => {
  const { writeDestinations, STORAGE_KEY } = await load();
  const saved = new Map();
  const storage = { setItem: (key, value) => saved.set(key, value) };
  assert.equal(writeDestinations([valid], storage), true);
  assert.equal(STORAGE_KEY, 'xxii:destinations');
  assert.deepEqual(JSON.parse(saved.get(STORAGE_KEY)), [valid]);
  const full = {
    setItem: () => {
      throw new Error('quota');
    },
  };
  assert.equal(writeDestinations([valid], full), false);
});

test('codecs: H.264 first, then VP8, the rest keep their order', async () => {
  const { orderCodecs } = await load();
  const codecs = [
    { mimeType: 'video/VP9' },
    { mimeType: 'video/VP8' },
    { mimeType: 'video/rtx' },
    { mimeType: 'video/H264', sdpFmtpLine: 'profile-level-id=42e01f' },
    { mimeType: 'video/AV1' },
    { mimeType: 'video/H264', sdpFmtpLine: 'profile-level-id=640c1f' },
  ];
  const names = orderCodecs(codecs, 'video').map(({ mimeType, sdpFmtpLine }) =>
    `${mimeType} ${sdpFmtpLine ?? ''}`.trim(),
  );
  assert.deepEqual(names, [
    'video/H264 profile-level-id=42e01f',
    'video/H264 profile-level-id=640c1f',
    'video/VP8',
    'video/VP9',
    'video/rtx',
    'video/AV1',
  ]);
});

test('codecs: Opus first for audio, input is not changed', async () => {
  const { orderCodecs } = await load();
  const codecs = [
    { mimeType: 'audio/PCMU' },
    { mimeType: 'audio/opus' },
    { mimeType: 'audio/red' },
  ];
  const ordered = orderCodecs(codecs, 'audio');
  assert.deepEqual(
    ordered.map(({ mimeType }) => mimeType),
    ['audio/opus', 'audio/PCMU', 'audio/red'],
  );
  assert.equal(codecs[0].mimeType, 'audio/PCMU');
});

test('Link: ice-server entries with credentials', async () => {
  const { iceServersOf } = await load();
  const header =
    '<stun:stun.example.com>; rel="ice-server", ' +
    '<turn:turn.example.com:3478?transport=udp>; rel="ice-server"; ' +
    'username="user, one"; credential="pass"; credential-type="password"';
  assert.deepEqual(iceServersOf(header), [
    { urls: ['stun:stun.example.com'] },
    {
      urls: ['turn:turn.example.com:3478?transport=udp'],
      username: 'user, one',
      credential: 'pass',
    },
  ]);
});

test('Link: other relations and broken values are ignored', async () => {
  const { iceServersOf } = await load();
  const header =
    '</whip/1>; rel="canonical", garbage, <>; rel="ice-server", ' +
    '<turn:t.example.com>; rel=ice-server; username=u; credential=c, ' +
    '<stun:s.example.com>; rel="Next ICE-SERVER"';
  assert.deepEqual(iceServersOf(header), [
    { urls: ['turn:t.example.com'], username: 'u', credential: 'c' },
    { urls: ['stun:s.example.com'] },
  ]);
  assert.deepEqual(iceServersOf(null), []);
  assert.deepEqual(iceServersOf(''), []);
});

test('Location: resolved against the endpoint URL', async () => {
  const { locationOf } = await load();
  const url = 'https://media.example.com/live/whip';
  assert.equal(locationOf('/whip/1', url), 'https://media.example.com/whip/1');
  assert.equal(locationOf('1', url), 'https://media.example.com/live/1');
  assert.equal(
    locationOf('https://other.example.com/r/9', url),
    'https://other.example.com/r/9',
  );
  assert.equal(locationOf(null, url), '');
  assert.equal(locationOf('', url), '');
  assert.equal(locationOf('http://[bad', url), '');
});

test('retries: 2, 5, then 10 seconds, and give up after 5', async () => {
  const { retryOf, retryText, giveUpText } = await load();
  assert.deepEqual(retryOf(1), { stop: false, delay: 2000 });
  assert.deepEqual(retryOf(2), { stop: false, delay: 5000 });
  assert.deepEqual(retryOf(3), { stop: false, delay: 10000 });
  assert.deepEqual(retryOf(4), { stop: false, delay: 10000 });
  assert.equal(retryOf(5).stop, true);
  assert.equal(retryOf(6).stop, true);
  assert.equal(retryText(2, 5000), 'retrying in 5 s (attempt 2 of 5)');
  assert.equal(
    giveUpText('Twitch'),
    'Stream to Twitch stopped after 5 failed attempts',
  );
});

test('retries: which statuses retry and which stop', async () => {
  const { isRetryStatus, verdictOf } = await load();
  for (const status of [408, 429, 500, 502, 503, 504, 599]) {
    assert.equal(isRetryStatus(status), true, `${status}`);
  }
  for (const status of [200, 204, 301, 400, 401, 403, 404, 409, 415]) {
    assert.equal(isRetryStatus(status), false, `${status}`);
  }
  assert.deepEqual(verdictOf({ status: 503, statusText: 'Unavailable' }), {
    retry: true,
    reason: 'Unavailable (503)',
  });
  assert.deepEqual(verdictOf({ status: 401, statusText: 'Unauthorized' }), {
    retry: false,
    reason: 'Unauthorized (401)',
  });
  assert.deepEqual(verdictOf({ status: 404, statusText: '' }), {
    retry: false,
    reason: 'Not Found (404)',
  });
  assert.equal(verdictOf({ status: 418 }).reason, 'Rejected (418)');
});

test('retries: network errors and lost connections retry', async () => {
  const { verdictOf, WhipError } = await load();
  const refused = new WhipError('could not reach the endpoint');
  assert.deepEqual(verdictOf(refused), {
    retry: true,
    reason: 'could not reach the endpoint',
  });
  assert.deepEqual(verdictOf(new Error('')), {
    retry: true,
    reason: 'connection failed',
  });
  assert.equal(verdictOf(null).retry, true);
});

const outbound = (bytes, extra = {}) => ({
  type: 'outbound-rtp',
  kind: 'video',
  bytesSent: bytes,
  framesPerSecond: 30,
  qualityLimitationReason: 'none',
  ...extra,
});

const remote = (fractionLost, roundTripTime) => ({
  type: 'remote-inbound-rtp',
  kind: 'video',
  fractionLost,
  roundTripTime,
});

test('health: Mbps from two byte counters with one decimal', async () => {
  const { sampleOf, healthOf } = await load();
  const before = sampleOf([outbound(1000000)], 10000);
  const after = sampleOf([outbound(1000000 + 1450000)], 12000);
  const health = healthOf(before, after, 3000);
  assert.equal(health.mbps, 5.8);
  assert.deepEqual(health.warnings, []);
  assert.equal(health.text, 'LIVE · 5.8 Mbps');
});

test('health: audio entries and missing fields are ignored', async () => {
  const { sampleOf } = await load();
  const entries = [
    { type: 'outbound-rtp', kind: 'audio', bytesSent: 999 },
    { type: 'outbound-rtp', mediaType: 'video', bytesSent: 500 },
    { type: 'candidate-pair', bytesSent: 7 },
  ];
  const sample = sampleOf(entries, 1);
  assert.equal(sample.bytes, 500);
  assert.equal(sample.fps, null);
  assert.equal(sample.reason, 'none');
  assert.equal(sample.loss, 0);
});

test('health: warns when limited by bandwidth or cpu', async () => {
  const { sampleOf, healthOf } = await load();
  const before = sampleOf([outbound(0)], 0);
  const slow = outbound(300000, { qualityLimitationReason: 'bandwidth' });
  const health = healthOf(before, sampleOf([slow], 2000), 3000);
  assert.equal(health.text, 'LIVE · 1.2 Mbps · limited by bandwidth');
  const busy = outbound(300000, { qualityLimitationReason: 'cpu' });
  const cpu = healthOf(before, sampleOf([busy], 2000), 3000);
  assert.deepEqual(cpu.warnings, ['limited by cpu']);
});

test('health: warns above 5% loss with the rounded percentage', async () => {
  const { sampleOf, healthOf } = await load();
  const before = sampleOf([outbound(0)], 0);
  const lossy = (fraction) =>
    sampleOf([outbound(750000), remote(fraction, 0.04)], 2000);
  const high = healthOf(before, lossy(0.07), 3000);
  assert.equal(high.text, 'LIVE · 3.0 Mbps · 7% loss');
  assert.deepEqual(healthOf(before, lossy(0.05), 3000).warnings, []);
  assert.deepEqual(healthOf(before, lossy(0), 3000).warnings, []);
  assert.equal(lossy(0.04).rtt, 40);
});

test('health: low frame rate warns only after 6 seconds', async () => {
  const { sampleOf, healthOf } = await load();
  const before = sampleOf([outbound(0)], 0);
  const slow = sampleOf([outbound(750000, { framesPerSecond: 14 })], 2000);
  assert.deepEqual(healthOf(before, slow, 4000).warnings, []);
  assert.deepEqual(healthOf(before, slow, 6000).warnings, []);
  const late = healthOf(before, slow, 6001);
  assert.equal(late.text, 'LIVE · 3.0 Mbps · 14 fps');
  const edge = sampleOf([outbound(750000, { framesPerSecond: 20 })], 2000);
  assert.deepEqual(healthOf(before, edge, 9000).warnings, []);
  const unknown = sampleOf([outbound(750000, { framesPerSecond: null })], 2000);
  assert.deepEqual(healthOf(before, unknown, 9000).warnings, []);
});

test('health: warnings combine and a reset counter reads zero', async () => {
  const { sampleOf, healthOf } = await load();
  const before = sampleOf([outbound(5000000)], 0);
  const entries = [
    outbound(100, { framesPerSecond: 10, qualityLimitationReason: 'cpu' }),
    remote(0.2, 0.1),
  ];
  const health = healthOf(before, sampleOf(entries, 2000), 8000);
  assert.equal(
    health.text,
    'LIVE · 0.0 Mbps · limited by cpu · 20% loss · 10 fps',
  );
  const same = healthOf(before, sampleOf([outbound(5000000)], 0), 8000);
  assert.equal(same.mbps, 0);
});

test('retries: a final relay error stops at once', async () => {
  const { verdictOf, WhipError } = await load();
  const refused = new WhipError('The address is not allowed', 0, '', true);
  assert.deepEqual(verdictOf(refused), {
    retry: false,
    reason: 'The address is not allowed',
  });
});

const fakes = { connection: null };

class FakeConnection {
  constructor() {
    const getParameters = () => ({ encodings: [{}] });
    const sender = { getParameters, setParameters: async () => undefined };
    const connection = {
      iceGatheringState: 'complete',
      connectionState: 'new',
      localDescription: null,
      remoteDescription: null,
      isClosed: false,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      addTransceiver: () => ({ sender }),
      createOffer: async () => ({ type: 'offer', sdp: 'v=0 offer' }),
      setLocalDescription: async (description) => {
        connection.localDescription = description;
      },
      setRemoteDescription: async (description) => {
        connection.remoteDescription = description;
      },
      close: () => {
        connection.isClosed = true;
      },
    };
    fakes.connection = connection;
    return connection;
  }
}

const withFakes = async (fetchFake, body) => {
  const saved = { fetch: globalThis.fetch, rtc: globalThis.RTCPeerConnection };
  globalThis.fetch = fetchFake;
  globalThis.RTCPeerConnection = FakeConnection;
  try {
    await body();
  } finally {
    globalThis.fetch = saved.fetch;
    globalThis.RTCPeerConnection = saved.rtc;
  }
};

const makeStream = async (relay) => {
  const { WhipStream } = await load();
  return new WhipStream({
    destination: valid,
    tracks: [{ kind: 'video' }, { kind: 'audio' }],
    iceServers: async () => [],
    relay,
  });
};

test('relay: a rejected fetch moves the stream to the relay', async () => {
  const calls = [];
  const fetches = [];
  const relay = async (args) => {
    calls.push(args);
    if (args.action === 'delete') return { status: 200 };
    return {
      status: 201,
      sdp: 'v=0 answer',
      location: 'https://ingest.example.com/whip/9',
      links: ['<turn:turn.example.com>; rel="ice-server"; username="u"'],
    };
  };
  const fetchFake = async (url, init) => {
    fetches.push({ url, method: init.method });
    throw new TypeError('Failed to fetch');
  };
  await withFakes(fetchFake, async () => {
    const stream = await makeStream(relay);
    await stream.start();
    assert.equal(fetches.length, 1);
    assert.equal(fetches[0].method, 'POST');
    assert.deepEqual(calls[0], {
      action: 'offer',
      url: valid.url,
      token: valid.token,
      sdp: 'v=0 offer',
    });
    assert.equal(fakes.connection.remoteDescription.sdp, 'v=0 answer');
    assert.equal(stream.state, 'connecting');
    await stream.stop();
    assert.deepEqual(calls[1], {
      action: 'delete',
      location: 'https://ingest.example.com/whip/9',
      token: valid.token,
    });
    assert.equal(fetches.length, 1);
    assert.equal(fakes.connection.isClosed, true);
  });
});

test('relay: a refusal fails the destination without retrying', async () => {
  const refusal = Object.assign(new Error('The address is not allowed'), {
    code: 'stream/refused',
  });
  const relay = async () => {
    throw refusal;
  };
  const fetchFake = async () => {
    throw new TypeError('Failed to fetch');
  };
  await withFakes(fetchFake, async () => {
    const stream = await makeStream(relay);
    await stream.start();
    assert.equal(stream.state, 'failed');
    assert.equal(stream.text, 'failed: The address is not allowed');
  });
});

test('relay: relay statuses follow the same retry rules', async () => {
  const relay = async () => ({ status: 401, sdp: '', location: '', links: [] });
  const fetchFake = async () => {
    throw new TypeError('Failed to fetch');
  };
  await withFakes(fetchFake, async () => {
    const stream = await makeStream(relay);
    await stream.start();
    assert.equal(stream.state, 'failed');
    assert.equal(stream.text, 'failed: Unauthorized (401)');
  });
});

test('relay: a reachable endpoint is never relayed', async () => {
  const calls = [];
  const relay = async (args) => calls.push(args);
  const fetches = [];
  const fetchFake = async (url, init) => {
    fetches.push(init.method);
    if (init.method === 'DELETE') return { status: 200 };
    const headers = new Map([['Location', '/whip/2']]);
    const text = async () => 'v=0 answer';
    return { status: 201, statusText: 'Created', headers, text };
  };
  await withFakes(fetchFake, async () => {
    const stream = await makeStream(relay);
    await stream.start();
    await stream.stop();
    assert.deepEqual(fetches, ['POST', 'DELETE']);
    assert.equal(calls.length, 0);
  });
});
