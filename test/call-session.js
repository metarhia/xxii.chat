'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { setTimeout: delay } = require('node:timers/promises');

const load = () => import('../application/static/call.js');

const flush = () => new Promise((resolve) => setImmediate(resolve));

const person = (endpoint, joined) => ({
  endpoint,
  joined,
  peer: endpoint,
  nick: endpoint,
});

const stateOf = (call, version, participants, lobby = []) => ({
  call,
  version,
  participants,
  lobby,
});

const createApi = () => {
  const call = {
    joined: [],
    left: [],
    pings: [],
    signals: [],
    joinResult: null,
    on() {},
    async join(args) {
      call.joined.push(args);
      return call.joinResult;
    },
    leave(args) {
      call.left.push(args);
      return true;
    },
    ping(args) {
      call.pings.push(args);
      return true;
    },
    signal(args) {
      call.signals.push(args);
      return true;
    },
  };
  return { call };
};

const createConnections = (order, receivers = null) => {
  const connections = [];
  const connection = () => {
    const listeners = new Map();
    const created = {
      closed: false,
      peerId: '',
      opened: null,
      tracks: [],
      channel: null,
      received: [],
      receiver: (slot) => receivers?.get(created.peerId)?.get(slot) ?? null,
      unsubscribe: null,
      open(options) {
        created.peerId = options.peerId;
        created.opened = {
          role: options.role,
          media: options.media,
          localId: options.localId,
          peerId: options.peerId,
          configuration: options.configuration,
        };
        created.signaling = options.signaling;
        const listener = (message) => created.received.push(message);
        created.unsubscribe = options.signaling.subscribe(listener);
        order.push(`open:${options.peerId}`);
        const channel = {
          readyState: 'open',
          sent: [],
          send(text) {
            channel.sent.push(text);
          },
        };
        created.channel = channel;
        return Promise.resolve(channel);
      },
      close() {
        if (created.closed) return;
        created.closed = true;
        const unsubscribe = created.unsubscribe;
        created.unsubscribe = null;
        if (typeof unsubscribe === 'function') unsubscribe();
        order.push(`close:${created.peerId}`);
        created.emit('close');
      },
      setTrack(slot, track) {
        created.tracks.push({ slot, track });
        return Promise.resolve();
      },
      on(name, listener) {
        const list = listeners.get(name) ?? [];
        list.push(listener);
        listeners.set(name, list);
      },
      off(name, listener) {
        const list = listeners.get(name) ?? [];
        const index = list.indexOf(listener);
        if (index >= 0) list.splice(index, 1);
      },
      emit(name, value) {
        const list = (listeners.get(name) ?? []).slice();
        for (const listener of list) listener(value);
      },
    };
    connections.push(created);
    return created;
  };
  return { connections, connection };
};

const configuration = { iceServers: [] };
const ice = async () => configuration;

test('router replays, drops, expires, and unsubscribes', async () => {
  const { SignalRouter } = await load();
  const call = 'room';
  const to = 'ada';
  const from = 'bob';
  const send = (router, message) => {
    router.deliver({ call, from, to, message });
  };
  const replay = new SignalRouter({ ttlMs: 1000 });
  send(replay, 'one');
  send(replay, 'two');
  const ordered = [];
  replay.subscribe(call, to, from, (message) => ordered.push(message));
  assert.deepEqual(ordered, ['one', 'two']);

  const limited = new SignalRouter({ limit: 2, ttlMs: 1000 });
  send(limited, 'a');
  send(limited, 'b');
  send(limited, 'c');
  const kept = [];
  limited.subscribe(call, to, from, (message) => kept.push(message));
  assert.deepEqual(kept, ['b', 'c']);

  const quiet = new SignalRouter({ ttlMs: 1000 });
  const heard = [];
  send(quiet, 'kept');
  const stop = quiet.subscribe(call, to, from, (message) => {
    heard.push(message);
  });
  assert.deepEqual(heard, ['kept']);
  stop();
  send(quiet, 'later');
  assert.deepEqual(heard, ['kept']);
  const drained = [];
  quiet.subscribe(call, to, from, (message) => drained.push(message));
  assert.deepEqual(drained, ['later']);

  const expiring = new SignalRouter({ ttlMs: 40 });
  send(expiring, 'stale');
  await delay(120);
  const missed = [];
  expiring.subscribe(call, to, from, (message) => missed.push(message));
  assert.deepEqual(missed, []);
});

test('later join offers and a tie uses the larger endpoint', async () => {
  const { isOfferer } = await load();
  const early = { endpoint: 'zoe', joined: 1 };
  const late = { endpoint: 'ada', joined: 2 };
  assert.equal(isOfferer(late, early), true);
  assert.equal(isOfferer(early, late), false);
  const ada = { endpoint: 'ada', joined: 10 };
  const bob = { endpoint: 'bob', joined: 10 };
  assert.equal(isOfferer(bob, ada), true);
  assert.equal(isOfferer(ada, bob), false);
});

test('delayOf follows the reconnect schedule', async () => {
  const { delayOf } = await load();
  assert.equal(delayOf(0), 1000);
  assert.equal(delayOf(1), 2000);
  assert.equal(delayOf(2), 5000);
  assert.equal(delayOf(3), 10000);
  assert.equal(delayOf(9), 10000);
});

test('session ignores a lower version', async (t) => {
  const { CallSession } = await load();
  const order = [];
  const links = createConnections(order);
  const api = createApi();
  const call = 'room';
  const session = new CallSession({
    api,
    endpoint: 'ada',
    call,
    chat: 'general',
    ice,
    connection: links.connection,
  });
  t.after(() => session.receive('ended', { call }));
  const ada = person('ada', 1);
  session.receive('state', stateOf(call, 2, [ada, person('bob', 1)]));
  await flush();
  session.receive('state', stateOf(call, 1, [ada, person('cara', 3)]));
  await flush();
  assert.deepEqual(order, ['open:bob']);
  assert.equal(links.connections.length, 1);
});

test('a dropped participant is closed before the new link', async (t) => {
  const { CallSession } = await load();
  const order = [];
  const links = createConnections(order);
  const api = createApi();
  const call = 'room';
  const session = new CallSession({
    api,
    endpoint: 'ada',
    call,
    chat: 'general',
    ice,
    connection: links.connection,
  });
  t.after(() => session.receive('ended', { call }));
  const ada = person('ada', 1);
  session.receive('state', stateOf(call, 1, [ada, person('bob', 1)]));
  await flush();
  session.receive('state', stateOf(call, 2, [ada, person('cara', 4)]));
  await flush();
  assert.deepEqual(order, ['open:bob', 'close:bob', 'open:cara']);
});

test('the later joiner offers and signaling uses the router', async (t) => {
  const { CallSession, CALL_SLOTS } = await load();
  const order = [];
  const links = createConnections(order);
  const api = createApi();
  const call = 'room';
  const session = new CallSession({
    api,
    endpoint: 'ada',
    call,
    chat: 'general',
    ice,
    connection: links.connection,
  });
  t.after(() => session.receive('ended', { call }));
  const ada = person('ada', 5);
  const bob = person('bob', 2);
  session.receive('state', stateOf(call, 1, [ada, bob]));
  await flush();
  const opened = links.connections[0].opened;
  assert.equal(opened.role, 'offerer');
  assert.deepEqual(opened.media, CALL_SLOTS);
  assert.equal(opened.localId, 'ada');
  assert.equal(opened.peerId, 'bob');
  assert.equal(opened.configuration, configuration);

  const early = createConnections([]);
  const other = new CallSession({
    api: createApi(),
    endpoint: 'ada',
    call,
    chat: 'general',
    ice,
    connection: early.connection,
  });
  t.after(() => other.receive('ended', { call }));
  const first = person('ada', 1);
  const second = person('bob', 5);
  other.receive('state', stateOf(call, 1, [first, second]));
  await flush();
  assert.equal(early.connections[0].opened.role, 'answerer');

  const heard = [];
  const message = { type: 'ping', time: 1 };
  links.connections[0].signaling.subscribe((item) => heard.push(item));
  session.receive('signal', { call, from: 'bob', to: 'ada', message });
  session.receive('signal', { call, from: 'bob', to: 'cara', message });
  assert.deepEqual(heard, [message]);
  await links.connections[0].signaling.send(message);
  const sent = [{ call, from: 'ada', to: 'bob', message }];
  assert.deepEqual(api.call.signals, sent);
});

test('setTrack reaches the current link and a link opened later', async (t) => {
  const { CallSession } = await load();
  const links = createConnections([]);
  const api = createApi();
  const call = 'room';
  const session = new CallSession({
    api,
    endpoint: 'ada',
    call,
    chat: 'general',
    ice,
    connection: links.connection,
  });
  t.after(() => session.receive('ended', { call }));
  const ada = person('ada', 1);
  const track = { id: 'mic' };
  session.receive('state', stateOf(call, 1, [ada, person('bob', 1)]));
  await flush();
  session.setTrack('mic', track);
  session.setTrack('camera', null);
  const bob = links.connections[0];
  assert.deepEqual(bob.tracks, [
    { slot: 'mic', track },
    { slot: 'camera', track: null },
  ]);
  const cara = person('cara', 3);
  session.receive('state', stateOf(call, 2, [ada, person('bob', 1), cara]));
  await flush();
  assert.deepEqual(links.connections[1].tracks, [
    { slot: 'mic', track },
    { slot: 'camera', track: null },
  ]);
});

test('pagehide calls leave and does not await it', async () => {
  const { CallSession } = await load();
  const left = [];
  const pending = new Promise(() => {});
  const api = createApi();
  api.call.leave = (args) => {
    left.push(args);
    return pending;
  };
  const previous = globalThis.addEventListener;
  const listeners = [];
  globalThis.addEventListener = (name, listener) => {
    listeners.push({ name, listener });
  };
  try {
    const session = new CallSession({
      api,
      endpoint: 'ada',
      call: 'room',
      chat: 'general',
      ice,
    });
    const found = listeners.find((item) => item.name === 'pagehide');
    const result = found.listener();
    assert.equal(result, undefined);
    assert.equal(session.phase, 'idle');
    assert.deepEqual(left, [{ call: 'room', endpoint: 'ada' }]);
  } finally {
    if (previous) globalThis.addEventListener = previous;
    else delete globalThis.addEventListener;
  }
});

test('pagehide can be managed by the application', async () => {
  const { CallSession } = await load();
  const api = createApi();
  const previous = globalThis.addEventListener;
  const listeners = [];
  globalThis.addEventListener = (name, listener) => {
    listeners.push({ name, listener });
  };
  try {
    const session = new CallSession({
      api,
      endpoint: 'ada',
      call: 'room',
      ice,
      pagehide: false,
    });
    assert.deepEqual(listeners, []);
    const leaving = session.leave();
    assert.deepEqual(api.call.left, [{ call: 'room', endpoint: 'ada' }]);
    await leaving;
    assert.equal(session.phase, 'idle');
  } finally {
    if (previous) globalThis.addEventListener = previous;
    else delete globalThis.addEventListener;
  }
});

test('ended closes links and returns to idle', async (t) => {
  const { CallSession } = await load();
  const order = [];
  const links = createConnections(order);
  const api = createApi();
  const call = 'room';
  const session = new CallSession({
    api,
    endpoint: 'ada',
    call,
    chat: 'general',
    ice,
    connection: links.connection,
  });
  t.after(() => session.receive('ended', { call }));
  const phases = [];
  session.on('state', (phase) => phases.push(phase));
  const people = [person('ada', 1), person('bob', 2)];
  session.receive('state', stateOf(call, 1, people));
  await flush();
  session.receive('ended', { call: 'other', by: 'ada' });
  assert.equal(links.connections[0].closed, false);
  session.receive('ended', { call, by: 'ada' });
  assert.equal(session.phase, 'idle');
  assert.equal(links.connections[0].closed, true);
  assert.equal(order.includes('close:bob'), true);
  assert.equal(phases.at(-1), 'idle');
});

test('join failure returns to idle and resume sends the record', async (t) => {
  const { CallSession } = await load();
  const api = createApi();
  const call = 'room';
  const session = new CallSession({
    api,
    endpoint: 'ada',
    call,
    chat: 'general',
    ice,
  });
  t.after(() => session.receive('ended', { call }));
  const phases = [];
  session.on('state', (phase) => phases.push(phase));
  session.begin();
  api.call.join = async () => {
    throw new Error('call/full');
  };
  await assert.rejects(() => session.join({ nick: 'Ada' }), /call\/full/);
  assert.equal(session.phase, 'idle');
  assert.deepEqual(phases, ['prejoin', 'joining', 'idle']);

  const resumed = createApi();
  const next = new CallSession({
    api: resumed,
    endpoint: 'ada',
    call,
    chat: 'general',
    ice,
  });
  t.after(() => next.receive('ended', { call }));
  resumed.call.joinResult = { status: 'lobby' };
  await next.join({ nick: 'Ada', token: 'secret' });
  assert.equal(next.phase, 'lobby');
  const record = { call, chat: 'general', host: 'ada', started: 9 };
  resumed.call.joinResult = {
    status: 'joined',
    state: stateOf(call, 1, [person('ada', 9)]),
  };
  await next.resume(record);
  const sent = resumed.call.joined[1];
  assert.equal(sent.resume, true);
  assert.equal(sent.nick, 'Ada');
  assert.equal(sent.host, 'ada');
  assert.equal(sent.started, 9);
  assert.equal(sent.chat, 'general');
  assert.equal(next.phase, 'joined');
});

test('offerer backs off and answerer reopens at once', async (t) => {
  const { CallSession } = await load();
  const planned = [];
  const schedule = (fn, ms) => {
    const id = planned.length + 1;
    planned.push({ fn, ms, id });
    return id;
  };
  const links = createConnections([]);
  const api = createApi();
  const call = 'room';
  const session = new CallSession({
    api,
    endpoint: 'ada',
    call,
    chat: 'general',
    ice,
    schedule,
    connection: links.connection,
  });
  t.after(() => session.receive('ended', { call }));
  const track = { id: 'mic' };
  session.setTrack('mic', track);
  const ada = person('ada', 5);
  const bob = person('bob', 1);
  session.receive('state', stateOf(call, 1, [ada, bob]));
  await flush();
  assert.equal(links.connections[0].opened.role, 'offerer');
  assert.equal(planned[0].ms, 10000);
  links.connections[0].emit('close');
  assert.equal(planned[1].ms, 1000);
  planned[1].fn();
  await flush();
  assert.equal(links.connections[1].opened.role, 'offerer');
  assert.deepEqual(links.connections[1].tracks, [{ slot: 'mic', track }]);
  links.connections[1].emit('close');
  assert.equal(planned.at(-1).ms, 1000);

  const earlyPlanned = [];
  const earlySchedule = (fn, ms) => {
    earlyPlanned.push({ fn, ms });
    return earlyPlanned.length;
  };
  const earlyLinks = createConnections([]);
  const early = new CallSession({
    api: createApi(),
    endpoint: 'ada',
    call,
    chat: 'general',
    ice,
    schedule: earlySchedule,
    connection: earlyLinks.connection,
  });
  t.after(() => early.receive('ended', { call }));
  const first = person('ada', 1);
  const second = person('bob', 5);
  early.receive('state', stateOf(call, 1, [first, second]));
  await flush();
  assert.equal(earlyLinks.connections[0].opened.role, 'answerer');
  const before = earlyPlanned.length;
  earlyLinks.connections[0].emit('close');
  await flush();
  assert.equal(earlyPlanned.length, before);
  assert.equal(earlyLinks.connections.length, 2);
  assert.equal(earlyLinks.connections[1].opened.role, 'answerer');
});

test('a new offer replaces a connected answerer', async (t) => {
  const { CallSession } = await load();
  const links = createConnections([]);
  const api = createApi();
  const call = 'room';
  const session = new CallSession({
    api,
    endpoint: 'ada',
    call,
    chat: 'general',
    ice,
    connection: links.connection,
  });
  t.after(() => session.receive('ended', { call }));
  const ada = person('ada', 1);
  const bob = person('bob', 5);
  session.receive('state', stateOf(call, 1, [ada, bob]));
  await flush();
  const first = links.connections[0];
  assert.equal(first.opened.role, 'answerer');
  assert.equal(first.closed, false);
  const offer = {
    description: { type: 'offer', sdp: 'v=1' },
    generation: 'gen-2',
  };
  const signal = { call, from: 'bob', to: 'ada', message: offer };
  session.receive('signal', signal);
  await flush();
  assert.equal(first.received.includes(offer), false);
  assert.equal(links.connections.length, 2);
  const next = links.connections[1];
  assert.equal(next.opened.role, 'answerer');
  assert.deepEqual(next.received, [offer]);
});

test('stage restores retained receivers after partial resume', async (t) => {
  const { CallSession } = await load();
  const { CallStage } = await import('../application/static/stage.js');
  const { CallLevels } = await import('../application/static/media.js');
  const volume = await import('../application/static/call-volume.js');
  const install = (name, value) => {
    const before = Object.getOwnPropertyDescriptor(globalThis, name);
    Object.defineProperty(globalThis, name, { configurable: true, value });
    t.after(() => {
      if (before) Object.defineProperty(globalThis, name, before);
      else Reflect.deleteProperty(globalThis, name);
    });
  };
  class Stream {
    constructor(tracks) {
      this.tracks = tracks;
    }

    getAudioTracks() {
      return this.tracks;
    }
  }
  const createAudio = () => ({
    dataset: {},
    srcObject: null,
    volume: 1,
    removed: false,
    play: async () => undefined,
    remove() {
      this.removed = true;
    },
  });
  install('MediaStream', Stream);
  install('document', { createElement: createAudio });
  const call = 'room';
  const ada = { ...person('ada', 1), mic: true, camera: true, screen: false };
  const bob = { ...person('bob', 2), mic: true, camera: true, screen: true };
  const slots = ['mic', 'camera', 'screen', 'screenAudio'];
  const remote = new Map();
  for (const slot of slots) {
    const track = new EventTarget();
    track.readyState = 'live';
    track.muted = false;
    remote.set(slot, {
      track,
      getSynchronizationSources: () => [{ audioLevel: 0.4 }],
    });
  }
  const api = createApi();
  const links = createConnections([], new Map([['bob', remote]]));
  const session = new CallSession({
    api,
    call,
    endpoint: 'ada',
    ice,
    connection: links.connection,
    pagehide: false,
  });
  t.after(() => session.receive('ended', { call }));
  const stage = new CallStage(null, { nick: () => 'Ada' });
  stage.session = session;
  stage.media = { level: 0, micOn: false, applySink: async () => undefined };
  stage.volume = new volume.ParticipantVolume(assert.fail);
  stage.volume.set('bob', 50);
  stage.levels = new CallLevels(session, stage.media, () => stage.people);
  const initial = stateOf(call, 1, [ada, bob]);
  session.receive('state', initial);
  await flush();
  stage.onCallState(initial);
  for (const slot of slots) {
    const track = remote.get(slot).track;
    stage.onRemoteTrack({ endpoint: 'bob', slot, track });
  }
  assert.equal(stage.audios.size, 2);
  assert.equal(stage.volume.entries.size, 2);
  assert.equal(stage.trackListeners.size, 4);
  const previousAudios = [...stage.audios.values()];
  const partial = stateOf(call, 0, [ada]);
  api.call.joinResult = { status: 'joined', state: partial };
  session.hold();
  await session.resume({ call });
  stage.onCallState(partial);
  assert.equal(session.linkCount, 1);
  assert.equal(stage.remote.size, 0);
  assert.equal(stage.audios.size, 0);
  assert.equal(stage.volume.entries.size, 0);
  assert.equal(stage.trackListeners.size, 0);
  assert.equal(stage.levels.levels.has('bob'), false);
  for (const audio of previousAudios) {
    assert.equal(audio.srcObject, null);
    assert.equal(audio.removed, true);
  }
  const restored = stateOf(call, 1, [ada, bob]);
  session.receive('state', restored);
  stage.onCallState(restored);
  assert.equal(links.connections.length, 1);
  assert.equal(stage.videoTrack('bob'), remote.get('camera').track);
  assert.equal(stage.screenTrack('bob'), remote.get('screen').track);
  assert.equal(stage.audios.size, 2);
  assert.equal(stage.volume.entries.size, 2);
  assert.equal(stage.trackListeners.size, 4);
  assert.equal(stage.levels.levels.get('bob'), 0.4);
  for (const audio of stage.audios.values()) assert.equal(audio.volume, 0.5);
  const mutedCamera = { ...bob, camera: false, screen: false };
  const flags = stateOf(call, 2, [ada, mutedCamera]);
  session.receive('state', flags);
  stage.onCallState(flags);
  assert.equal(stage.videoTrack('bob'), null);
  assert.equal(stage.screenTrack('bob'), null);
  assert.equal(stage.audios.size, 1);
  stage.stats.set('bob', {});
  stage.quality.set('bob', {});
  stage.statsShown.add('bob');
  stage.statsHidden.add('bob');
  const departed = stateOf(call, 3, [ada]);
  session.receive('state', departed);
  stage.onCallState(departed);
  assert.equal(session.linkCount, 0);
  assert.equal(stage.remote.size, 0);
  assert.equal(stage.audios.size, 0);
  assert.equal(stage.volume.entries.size, 0);
  assert.equal(stage.trackListeners.size, 0);
  assert.equal(stage.levels.levels.has('bob'), false);
  assert.equal(stage.stats.has('bob'), false);
  assert.equal(stage.quality.has('bob'), false);
  assert.equal(stage.statsShown.has('bob'), false);
  assert.equal(stage.statsHidden.has('bob'), false);
  stage.levels.stop();
  stage.volume.stop();
});
