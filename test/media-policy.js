'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const load = () => import('../application/static/media.js');
const initial = () => ({ step: 0, poorSince: null, cleanSince: null });
const clean = { loss: 0, available: 4000000, required: 1000000 };
const poor = { ...clean, loss: 0.11 };

const install = (t, name, value) => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, name);
  Object.defineProperty(globalThis, name, { configurable: true, value });
  t.after(() => {
    if (previous) Object.defineProperty(globalThis, name, previous);
    else Reflect.deleteProperty(globalThis, name);
  });
};

const fakeLink = () => {
  const events = [];
  const senders = new Map();
  for (const slot of ['mic', 'camera', 'screen', 'screenAudio']) {
    const sender = {
      track: { getSettings: () => ({ width: 1280, height: 720 }) },
      parameters: { encodings: [{ rid: 'main' }] },
      getParameters() {
        return structuredClone(this.parameters);
      },
      async setParameters(parameters) {
        this.parameters = parameters;
      },
    };
    senders.set(slot, sender);
  }
  const receiver = { track: { enabled: true } };
  return {
    connected: true,
    events,
    senders,
    sender: (slot) => senders.get(slot),
    receiver: () => receiver,
    emit: (name, data) => events.push({ name, data }),
  };
};

test('mesh rows follow participant boundaries for each slot', async () => {
  const { bandwidthRow, encodingPolicy } = await load();
  const expected = [0, 0, 1, 1, 2, 2, 3, 3];
  const bitrates = [1500000, 800000, 500000, 500000];
  const heights = [720, 540, 360, 180];
  const frames = [30, 30, 24, 24];
  const screens = [2500000, 1500000, 1200000, 1000000];
  const screenFrames = [30, 30, 15, 10];
  for (let participants = 1; participants <= 8; participants++) {
    const row = expected[participants - 1];
    assert.equal(bandwidthRow(participants), row);
    const camera = encodingPolicy({ slot: 'camera', participants });
    assert.equal(camera.active, participants <= 6);
    assert.equal(camera.maxBitrate, bitrates[row]);
    assert.equal(camera.maxFramerate, frames[row]);
    assert.equal(camera.scaleResolutionDownBy, 720 / heights[row]);
    const screen = encodingPolicy({ slot: 'screen', participants });
    assert.equal(screen.maxBitrate, screens[row]);
    assert.equal(screen.maxFramerate, screenFrames[row]);
    for (const slot of ['mic', 'screenAudio']) {
      assert.deepEqual(encodingPolicy({ slot, participants }), {
        active: true,
        maxBitrate: 32000,
      });
    }
  }
});

test('view limits preserve aspect ratio and the 180p floor', async () => {
  const { encodingPolicy } = await load();
  const options = {
    slot: 'camera',
    participants: 4,
    settings: { width: 1280, height: 720 },
    hint: { width: 640, height: 400, fps: 15 },
  };
  const small = encodingPolicy(options);
  assert.equal(small.scaleResolutionDownBy, 2);
  assert.equal(small.maxFramerate, 15);
  const tiny = encodingPolicy({
    ...options,
    hint: { width: 10, height: 10, fps: 60 },
  });
  assert.equal(tiny.scaleResolutionDownBy, 4);
  assert.equal(tiny.maxFramerate, 30);
  const hidden = encodingPolicy({
    ...options,
    hint: { width: 0, height: 0, fps: 0 },
  });
  assert.equal(hidden.active, false);
  const audioOnly = encodingPolicy({ ...options, audioOnly: true });
  assert.equal(audioOnly.active, false);
  const screen = encodingPolicy({
    ...options,
    slot: 'screen',
    audioOnly: true,
  });
  assert.equal(screen.active, true);
});

test('hints reject malformed data and clamp bounds', async () => {
  const { validateHint } = await load();
  const base = { slot: 'camera', width: 640, height: 360, fps: 30 };
  for (const change of [
    { slot: 'mic' },
    { width: '640' },
    { height: NaN },
    { fps: Infinity },
    { width: -1 },
    { audioOnly: 'yes' },
    { fps: null },
  ]) {
    assert.equal(validateHint({ ...base, ...change }), null);
  }
  assert.equal(validateHint(null), null);
  assert.equal(validateHint([]), null);
  assert.deepEqual(
    validateHint({ ...base, width: 10000, height: 9999, fps: 99 }),
    {
      slot: 'camera',
      width: 7680,
      height: 4320,
      fps: 30,
      audioOnly: false,
    },
  );
  assert.deepEqual(validateHint({ ...base, width: 0, audioOnly: true }), {
    slot: 'camera',
    width: 0,
    height: 0,
    fps: 0,
    audioOnly: true,
  });
  assert.equal(
    validateHint({ ...base, slot: 'screen', audioOnly: true }).audioOnly,
    false,
  );
});

test('loss steps down after 5s; clean stats recover after 20s', async () => {
  const { adaptBandwidth } = await load();
  let state = adaptBandwidth(initial(), poor, 0);
  state = adaptBandwidth(state, poor, 4999);
  assert.equal(state.step, 0);
  state = adaptBandwidth(state, poor, 5000);
  assert.equal(state.step, 1);
  state = adaptBandwidth(state, poor, 6000);
  assert.equal(state.step, 1);
  state = adaptBandwidth(state, clean, 7000);
  state = adaptBandwidth(state, clean, 26999);
  assert.equal(state.step, 1);
  state = adaptBandwidth(state, clean, 27000);
  assert.equal(state.step, 0);
});

test('adaptation resets transients and ignores missing stats', async () => {
  const { adaptBandwidth } = await load();
  let state = adaptBandwidth(initial(), poor, 100);
  state = adaptBandwidth(state, clean, 4000);
  state = adaptBandwidth(state, poor, 5000);
  state = adaptBandwidth(state, poor, 9000);
  assert.equal(state.step, 0);
  const insufficient = { ...clean, available: 500000 };
  state = adaptBandwidth(state, insufficient, 10000);
  assert.equal(state.step, 1);
  state = adaptBandwidth(state, clean, 11000);
  state = adaptBandwidth(state, poor, 30000);
  state = adaptBandwidth(state, clean, 31000);
  assert.equal(state.step, 1);
  assert.equal(state.cleanSince, 31000);
  const absent = { loss: undefined, available: undefined, required: 1000 };
  state = adaptBandwidth(state, absent, 100000);
  assert.equal(state.cleanSince, null);
  state = adaptBandwidth(state, clean, 101000);
  assert.equal(state.step, 1);
  assert.equal(state.cleanSince, 101000);
  const zero = { loss: undefined, available: 0, required: 1000 };
  state = adaptBandwidth(state, zero, 102000);
  state = adaptBandwidth(state, zero, 107000);
  assert.equal(state.step, 2);
});

test('adaptation preserves row bounds and screen budget', async () => {
  const { adaptBandwidth, encodingPolicy } = await load();
  let state = initial();
  for (let now = 0; now <= 40000; now += 5000) {
    state = adaptBandwidth(state, poor, now);
  }
  assert.equal(state.step, 3);
  assert.equal(
    encodingPolicy({
      slot: 'camera',
      participants: 4,
      step: state.step,
    }).active,
    false,
  );
  assert.equal(
    encodingPolicy({
      slot: 'screen',
      participants: 4,
      step: state.step,
    }).maxBitrate,
    1500000,
  );
  assert.equal(adaptBandwidth(initial(), { ...clean, loss: 0.1 }, 0).step, 0);
});

test('stats select nominated bitrate and packet loss deltas', async () => {
  const { readLinkStats } = await load();
  const reports = new Map([
    [
      'pair',
      {
        type: 'candidate-pair',
        state: 'succeeded',
        nominated: true,
        availableOutgoingBitrate: 700000,
      },
    ],
    [
      'unused',
      {
        type: 'candidate-pair',
        state: 'succeeded',
        availableOutgoingBitrate: 10000000,
      },
    ],
    ['send', { type: 'outbound-rtp', kind: 'video', packetsSent: 200 }],
    ['loss', { type: 'remote-inbound-rtp', kind: 'video', packetsLost: 30 }],
  ]);
  const stats = readLinkStats(reports, { sent: 100, lost: 10 }, 832000);
  assert.equal(stats.loss, 0.2);
  assert.equal(stats.available, 700000);
  assert.equal(stats.required, 832000);
  reports.get('loss').fractionLost = 0.15;
  assert.equal(readLinkStats(reports, stats, 832000).loss, 0.15);
});

test('sender policy applies per link, pauses hidden and restores', async () => {
  const { LinkMediaPolicy } = await load();
  const link = fakeLink();
  const policy = new LinkMediaPolicy(link);
  policy.participants = 4;
  await policy.refresh();
  const camera = link.sender('camera');
  assert.equal(camera.parameters.encodings[0].maxBitrate, 800000);
  assert.equal(camera.parameters.encodings[0].rid, 'main');
  assert.equal(camera.parameters.degradationPreference, 'balanced');
  assert.equal(
    link.sender('screen').parameters.degradationPreference,
    'maintain-resolution',
  );
  policy.hint({ slot: 'camera', width: 0, height: 0, fps: 0 });
  await policy.pending;
  assert.equal(camera.parameters.encodings[0].active, false);
  policy.hint({ slot: 'camera', width: 640, height: 360, fps: 15 });
  await policy.pending;
  assert.equal(camera.parameters.encodings[0].active, true);
  assert.equal(camera.parameters.encodings[0].scaleResolutionDownBy, 2);
  assert.equal(camera.parameters.encodings[0].maxFramerate, 15);
  policy.stop();
});

test('audio-only keeps audio and screen, disabling both cameras', async () => {
  const { LinkMediaPolicy } = await load();
  const link = fakeLink();
  const policy = new LinkMediaPolicy(link);
  const hint = { slot: 'camera', width: 640, height: 360, fps: 30 };
  policy.hint({ ...hint, audioOnly: true });
  await policy.pending;
  assert.equal(link.sender('camera').parameters.encodings[0].active, false);
  assert.equal(link.receiver().track.enabled, false);
  assert.equal(link.sender('mic').parameters.encodings[0].active, true);
  assert.equal(link.sender('screen').parameters.encodings[0].active, true);
  policy.localAudioOnly = true;
  policy.hint({ ...hint, audioOnly: false });
  await policy.pending;
  assert.equal(link.receiver().track.enabled, false);
  policy.localAudioOnly = false;
  await policy.refresh();
  assert.equal(link.receiver().track.enabled, true);
  assert.equal(link.sender('camera').parameters.encodings[0].active, true);
  policy.stop();
});

test('missing APIs produce deduplicated notices', async () => {
  const { LinkMediaPolicy } = await load();
  const link = fakeLink();
  link.sender('camera').setParameters = undefined;
  link.sender('screen').setParameters = async () => {
    throw new Error('unsupported');
  };
  const policy = new LinkMediaPolicy(link);
  await policy.refresh();
  await policy.refresh();
  await policy.sample();
  const notices = link.events.filter((event) => event.name === 'notice');
  assert.equal(notices.length, 3);
  policy.stop();
  const before = link.events.length;
  await policy.refresh();
  assert.equal(link.events.length, before);
});

test('tile hints aggregate size and visibility', async (t) => {
  const { ViewHints } = await import('../application/static/view-hints.js');
  const listeners = new Map();
  const document = {
    hidden: false,
    addEventListener: (name, listener) => listeners.set(name, listener),
    removeEventListener: (name) => listeners.delete(name),
  };
  install(t, 'document', document);
  install(t, 'ResizeObserver', undefined);
  install(t, 'innerWidth', 1000);
  install(t, 'innerHeight', 1000);
  install(t, 'getComputedStyle', (tile) => tile.style);
  const sent = [];
  const notices = [];
  const hints = new ViewHints(
    (endpoint, hint) => {
      sent.push({ endpoint, ...hint });
    },
    (notice) => notices.push(notice),
  );
  t.after(() => hints.stop());
  const tile = (size) => ({
    dataset: { endpoint: 'bob', slot: 'camera' },
    style: { display: 'grid', visibility: 'visible' },
    getBoundingClientRect: () => ({
      width: size,
      height: size,
      top: 0,
      left: 0,
      right: size,
      bottom: size,
    }),
  });
  const small = tile(100);
  const big = tile(400);
  hints.update([small, big]);
  assert.equal(sent.at(-1).height, 400);
  assert.equal(notices.length, 1);
  hints.refresh();
  assert.equal(sent.length, 1);
  big.style.display = 'none';
  hints.refresh();
  assert.equal(sent.at(-1).height, 100);
  document.hidden = true;
  listeners.get('visibilitychange')();
  assert.equal(sent.at(-1).height, 0);
  document.hidden = false;
  listeners.get('visibilitychange')();
  assert.equal(sent.at(-1).height, 100);
  hints.update([]);
  assert.equal(sent.at(-1).height, 0);
});

test('session retains hints and validates peer messages', async (t) => {
  const { CallSession } = await import('../application/static/call.js');
  const media = fakeLink();
  const listeners = new Map();
  const channel = {
    readyState: 'open',
    onmessage: null,
    sent: [],
    send(text) {
      this.sent.push(JSON.parse(text));
    },
  };
  const connection = {
    codecs: null,
    sender: (slot) => media.sender(slot),
    receiver: () => media.receiver(),
    async setTrack() {},
    async open(options) {
      this.codecs = options.codecs;
      return channel;
    },
    close() {},
    on(name, listener) {
      listeners.set(name, listener);
    },
    off(name) {
      listeners.delete(name);
    },
  };
  const api = { call: { on() {}, leave() {}, ping() {} } };
  const session = new CallSession({
    api,
    call: 'room',
    endpoint: 'ada',
    pagehide: false,
    ice: async () => ({}),
    connection: () => connection,
  });
  t.after(() => session.leave());
  const hint = { slot: 'camera', width: 640, height: 360, fps: 15 };
  session.setViewHint('bob', hint);
  session.setAudioOnly('bob', true);
  session.receive('state', {
    call: 'room',
    version: 1,
    participants: [
      { endpoint: 'ada', joined: 1 },
      { endpoint: 'bob', joined: 2 },
    ],
  });
  const flush = () => new Promise((resolve) => setImmediate(resolve));
  await flush();
  assert.equal(channel.sent.at(-1).audioOnly, true);
  assert.deepEqual(connection.codecs.video, [
    'video/VP9',
    'video/VP8',
    'video/H264',
  ]);
  assert.equal(session.sender('bob', 'camera'), media.sender('camera'));
  session.setAudioOnly('bob', false);
  await flush();
  assert.equal(channel.sent.at(-1).audioOnly, false);
  const messages = [];
  session.on('message', (message) => messages.push(message));
  const post = (message) => {
    const data = JSON.stringify(message);
    channel.onmessage({ data });
  };
  post({ type: 'hint', ...hint, audioOnly: true });
  await flush();
  assert.equal(session.isAudioOnly('bob'), true);
  assert.equal(session.requestedAudioOnly('bob'), false);
  assert.equal(media.receiver().track.enabled, false);
  assert.equal(messages.length, 1);
  post({ type: 'hint', ...hint, width: 'bad' });
  post({ type: 'unknown' });
  assert.equal(messages.length, 1);
  post({ type: 'hint', ...hint, audioOnly: false });
  await flush();
  assert.equal(session.isAudioOnly('bob'), false);
  assert.equal(media.receiver().track.enabled, true);
  session.send('bob', { type: 'ping', time: 123 });
  assert.deepEqual(channel.sent.at(-1), { type: 'ping', time: 123 });
});
