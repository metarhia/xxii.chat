const PAIR = /^[\w-]{1,64}_[\w-]{1,64}$/;
const POLICIES = ['open', 'link', 'approval'];
const FLAGS = ['mic', 'camera', 'screen', 'recording', 'optOut', 'live'];
const REQUESTS = new Set(['mute', 'unmute', 'stopCamera', 'stopScreen']);
const EMPTY = Object.freeze([]);
const SIGNAL_BURST = 200;
const UPDATE_BURST = 10;
const MESSAGE_LIMIT = 65536;
const NICK_LIMIT = 32;
const TITLE_LIMIT = 64;
const LABEL_LIMIT = 48;
const SWEEP_MS = 5000;

const ADMISSION = {
  open: { admin: 'join', token: 'join', other: 'join' },
  link: { admin: 'join', token: 'join', other: 'lobby' },
  approval: { admin: 'join', token: 'lobby', other: 'lobby' },
};

const fail = (code, cause) => {
  if (typeof cause === 'string') return new DomainError(code, { cause });
  return new DomainError(code);
};

const clip = (value, limit) => {
  if (typeof value !== 'string') return '';
  return value.slice(0, limit);
};

const tokenOf = () => node.crypto.randomBytes(16).toString('base64url');

const kindOf = (chat) => {
  if (typeof chat !== 'string' || chat.length === 0) return '';
  if (PAIR.test(chat)) return 'direct';
  return 'chat';
};

const halves = (chat) => {
  const index = chat.indexOf('_');
  return [chat.slice(0, index), chat.slice(index + 1)];
};

const inPair = (chat, peer) => {
  const parts = halves(chat);
  return peer === parts[0] || peer === parts[1];
};

const otherPeer = (chat, peer) => {
  const parts = halves(chat);
  if (parts[0] === peer) return parts[1];
  return parts[0];
};

const peerOf = (client) => {
  const peer = domain.presence.owners.get(client);
  if (typeof peer !== 'string') return '';
  return peer;
};

const owns = (client, endpoint) => {
  const peer = peerOf(client);
  if (peer === '' || typeof endpoint !== 'string') return false;
  return endpoint.startsWith(`${peer}:`);
};

const admissionOf = (state, access) => {
  if (access.isAdmin) return 'join';
  if (state.locked) return 'denied';
  const rule = ADMISSION[state.policy];
  if (!rule) return 'denied';
  if (access.hasToken) return rule.token;
  return rule.other;
};

const takeToken = (bucket, rate, burst, now) => {
  const elapsed = (now - bucket.time) / 1000;
  const refilled = bucket.tokens + elapsed * rate;
  bucket.tokens = Math.min(burst, refilled);
  bucket.time = now;
  if (bucket.tokens < 1) return false;
  bucket.tokens -= 1;
  return true;
};

const allow = (endpoint, kind) => {
  const now = Date.now();
  const signal = kind === 'signal';
  const rate = signal ? config.call.signalRate : config.call.updateRate;
  const burst = signal ? SIGNAL_BURST : UPDATE_BURST;
  const key = `${endpoint}\n${kind}`;
  let bucket = domain.call.buckets.get(key);
  if (!bucket) {
    bucket = { tokens: burst, time: now };
    domain.call.buckets.set(key, bucket);
  }
  return takeToken(bucket, rate, burst, now);
};

const readOwner = (record) => {
  if (!record || typeof record !== 'object') return '';
  if (typeof record.owner === 'string' && record.owner !== '') {
    return record.owner;
  }
  const value = record.data?.owner?.$lww?.value;
  if (typeof value !== 'string') return '';
  return value;
};

const ownerOf = async (chat) => {
  const storage = domain.storage;
  if (!storage || typeof storage.get !== 'function') return '';
  try {
    const record = await storage.get(chat);
    return readOwner(record);
  } catch {
    return '';
  }
};

const isAdmin = (state, peer, owner) => {
  if (peer === '') return false;
  if (peer === state.host) return true;
  if (state.cohosts.has(peer)) return true;
  return owner !== '' && peer === owner;
};

const adminsOf = (state, owner) => {
  const admins = [];
  if (state.host !== '' && !admins.includes(state.host)) {
    admins.push(state.host);
  }
  for (const peer of state.cohosts) {
    if (!admins.includes(peer)) admins.push(peer);
  }
  if (owner !== '' && !admins.includes(owner)) admins.push(owner);
  return admins;
};

const countOn = (state, flag) => {
  let count = 0;
  for (const item of state.participants.values()) {
    if (item[flag]) count += 1;
  }
  return count;
};

const blocked = (state, item, args) => {
  const camera = args.camera === true && !item.camera;
  const cameras = countOn(state, 'camera') >= config.call.maxCameras;
  if (camera && cameras) return true;
  const screen = args.screen === true && !item.screen;
  const screens = countOn(state, 'screen') >= config.call.maxScreens;
  return screen && screens;
};

const memberOf = (client, peer, endpoint, nick, now) => ({
  endpoint,
  peer,
  nick: clip(nick, NICK_LIMIT),
  client,
  joined: now,
  seen: now,
  mic: false,
  camera: false,
  screen: false,
  hand: 0,
  recording: false,
  optOut: false,
  stage: true,
  live: false,
  title: '',
});

const peopleOf = (state, admins) => {
  const people = [];
  for (const item of state.participants.values()) {
    people.push({
      endpoint: item.endpoint,
      peer: item.peer,
      nick: item.nick,
      joined: item.joined,
      admin: admins.includes(item.peer),
      mic: item.mic,
      camera: item.camera,
      screen: item.screen,
      hand: item.hand,
      recording: item.recording,
      optOut: item.optOut,
      stage: item.stage,
      live: item.live,
      title: item.title,
    });
  }
  return people;
};

const lobbyOf = (state) => {
  const lobby = [];
  for (const item of state.lobby.values()) {
    lobby.push({
      endpoint: item.endpoint,
      peer: item.peer,
      nick: item.nick,
      knocked: item.knocked,
    });
  }
  return lobby;
};

const viewOf = (state, admins, participants, lobby, version) => ({
  call: state.id,
  chat: state.chat,
  kind: state.kind,
  title: state.title,
  started: state.started,
  version,
  policy: state.policy,
  locked: state.locked,
  host: state.host,
  admins,
  spotlight: state.spotlight,
  participants,
  lobby,
});

const remember = (client, endpoint, id) => {
  domain.call.endpoints.set(endpoint, { call: id, client });
  let set = domain.call.clientEndpoints.get(client);
  if (!set) {
    set = new Set();
    domain.call.clientEndpoints.set(client, set);
  }
  set.add(endpoint);
  domain.call.watch(client);
};

const forget = (client, endpoint) => {
  domain.call.endpoints.delete(endpoint);
  const set = domain.call.clientEndpoints.get(client);
  if (set) set.delete(endpoint);
  domain.call.buckets.delete(`${endpoint}\nsignal`);
  domain.call.buckets.delete(`${endpoint}\nupdate`);
};

const clearRing = (state) => {
  if (!state?.ringing) return false;
  clearTimeout(state.ringing.timer);
  state.ringing = null;
  return true;
};

const callerClients = (state) => {
  const clients = new Set();
  const current = domain.presence.clients.get(state.host);
  if (current) clients.add(current);
  for (const item of state.participants.values()) {
    if (item.peer === state.host) clients.add(item.client);
  }
  return clients;
};

const emitRinging = (clients, id, name) => {
  const data = Object.freeze({ call: id, state: name });
  for (const client of clients) client.emit('call/ringing', data);
};

const announce = (state, ended) => {
  const data = {
    call: state.id,
    chat: state.chat,
    count: state.participants.size,
    started: state.started,
  };
  if (ended) data.ended = true;
  const payload = Object.freeze(data);
  for (const client of domain.presence.clients.values()) {
    client.emit('call/active', payload);
  }
};

const publish = async (state) => {
  const version = state.version;
  state.version += 1;
  const owner = await ownerOf(state.chat);
  const admins = Object.freeze(adminsOf(state, owner));
  const people = Object.freeze(peopleOf(state, admins));
  const lobby = Object.freeze(lobbyOf(state));
  const member = Object.freeze(viewOf(state, admins, people, EMPTY, version));
  const admin = Object.freeze(viewOf(state, admins, people, lobby, version));
  for (const item of state.participants.values()) {
    const data = isAdmin(state, item.peer, owner) ? admin : member;
    item.client.emit('call/state', data);
  }
  return { member, admin, owner };
};

const callOfChat = (chat) => {
  for (const state of domain.call.calls.values()) {
    if (state.chat === chat) return state;
  }
  return null;
};

const hosted = (peer) => {
  let count = 0;
  for (const state of domain.call.calls.values()) {
    if (state.host === peer) count += 1;
  }
  return count;
};

const createCall = (fields) => {
  const state = {
    id: fields.id,
    chat: fields.chat,
    kind: fields.kind,
    title: fields.title,
    started: fields.started,
    version: 1,
    policy: fields.policy,
    token: tokenOf(),
    locked: false,
    spotlight: '',
    host: fields.host,
    cohosts: new Set(),
    participants: new Map(),
    lobby: new Map(),
    ringing: null,
  };
  domain.call.calls.set(state.id, state);
  return state;
};

const enter = async (state, client, peer, endpoint, nick) => {
  const now = Date.now();
  const member = memberOf(client, peer, endpoint, nick, now);
  state.participants.set(endpoint, member);
  state.lobby.delete(endpoint);
  remember(client, endpoint, state.id);
  clearRing(state);
  const sent = await publish(state);
  announce(state, false);
  const admin = isAdmin(state, peer, sent.owner);
  const payload = admin ? sent.admin : sent.member;
  return { status: 'joined', state: payload };
};

const knock = async (state, client, peer, endpoint, nick) => {
  const entry = {
    endpoint,
    peer,
    nick: clip(nick, NICK_LIMIT),
    knocked: Date.now(),
    client,
  };
  state.lobby.set(endpoint, entry);
  remember(client, endpoint, state.id);
  await publish(state);
  return { status: 'lobby' };
};

const finish = async (state, by, actor) => {
  clearRing(state);
  const clients = new Set();
  for (const item of state.participants.values()) {
    clients.add(item.client);
    forget(item.client, item.endpoint);
  }
  for (const item of state.lobby.values()) {
    clients.add(item.client);
    forget(item.client, item.endpoint);
  }
  if (actor) clients.add(actor);
  state.participants.clear();
  state.lobby.clear();
  domain.call.calls.delete(state.id);
  const data = Object.freeze({ call: state.id, by });
  for (const client of clients) client.emit('call/ended', data);
  announce(state, true);
};

const releaseParticipant = async (state, endpoint) => {
  if (!domain.call.calls.has(state.id)) return;
  const item = state.participants.get(endpoint);
  if (!item) return;
  state.participants.delete(endpoint);
  forget(item.client, endpoint);
  if (state.participants.size === 0) {
    await finish(state, '', item.client);
    return;
  }
  await publish(state);
  announce(state, false);
};

const release = async (client, endpoint) => {
  const located = domain.call.endpoints.get(endpoint);
  if (!located || located.client !== client) {
    forget(client, endpoint);
    return;
  }
  const state = domain.call.calls.get(located.call);
  if (!state) {
    forget(client, endpoint);
    return;
  }
  if (state.participants.has(endpoint)) {
    await releaseParticipant(state, endpoint);
    return;
  }
  if (!state.lobby.has(endpoint)) {
    forget(client, endpoint);
    return;
  }
  state.lobby.delete(endpoint);
  forget(client, endpoint);
  if (!domain.call.calls.has(state.id)) return;
  await publish(state);
};

const removeClient = async (client) => {
  const set = domain.call.clientEndpoints.get(client);
  if (!set) return;
  const endpoints = Array.from(set);
  for (const endpoint of endpoints) await release(client, endpoint);
};

const ring = (state, peer, nick) => {
  const callee = otherPeer(state.chat, peer);
  const timer = setTimeout(() => {
    domain.call.miss(state.id);
  }, config.call.ringMs);
  state.ringing = { peer: callee, timer };
  const client = domain.presence.clients.get(callee);
  if (!client) return;
  const data = Object.freeze({
    call: state.id,
    chat: state.chat,
    from: { peer, nick },
  });
  client.emit('call/ring', data);
};

const again = async (state, peer, endpoint) => {
  const item = state.participants.get(endpoint);
  item.seen = Date.now();
  const owner = await ownerOf(state.chat);
  const admins = adminsOf(state, owner);
  const people = peopleOf(state, admins);
  const show = isAdmin(state, peer, owner);
  const lobby = show ? lobbyOf(state) : EMPTY;
  const version = state.version - 1;
  const data = viewOf(state, admins, people, lobby, version);
  return { status: 'joined', state: data };
};

const wait = async (state, client, peer, endpoint, args) => {
  const sitting = state.lobby.has(endpoint);
  const full = state.lobby.size >= config.call.maxLobby;
  if (full && !sitting) return fail('call/full');
  return knock(state, client, peer, endpoint, args.nick);
};

const arrive = async (client, state, args) => {
  const peer = peerOf(client);
  const endpoint = args.endpoint;
  if (state.participants.has(endpoint)) return again(state, peer, endpoint);
  const direct = state.kind === 'direct';
  if (direct && !inPair(state.chat, peer)) return fail('call/forbidden');
  const owner = await ownerOf(state.chat);
  const admin = isAdmin(state, peer, owner);
  if (!direct) {
    const decision = admissionOf(state, {
      isAdmin: admin,
      hasToken: args.token === state.token,
    });
    if (decision === 'denied') return fail('call/locked');
    if (decision === 'lobby') return wait(state, client, peer, endpoint, args);
  }
  const full = state.participants.size >= config.call.maxParticipants;
  if (full) return fail('call/full');
  return enter(state, client, peer, endpoint, args.nick);
};

const canResume = (peer, host, kind, chat, owner) => {
  if (peer === host) return true;
  if (kind === 'direct' && inPair(chat, peer)) return true;
  return owner !== '' && peer === owner;
};

const restore = async (client, args) => {
  const peer = peerOf(client);
  const id = args.call;
  const chat = args.chat;
  const host = args.host;
  const started = args.started;
  const ready =
    typeof id === 'string' &&
    id !== '' &&
    typeof chat === 'string' &&
    chat !== '' &&
    typeof host === 'string' &&
    host !== '' &&
    typeof started === 'number';
  if (!ready) return fail('call/not-found');
  const kind = kindOf(chat);
  if (!kind) return fail('call/not-found');
  const owner = await ownerOf(chat);
  if (!canResume(peer, host, kind, chat, owner)) {
    return fail('call/not-found');
  }
  const existing = domain.call.calls.get(id);
  if (existing) return arrive(client, existing, args);
  const state = createCall({
    id,
    chat,
    kind,
    title: '',
    started,
    host,
    policy: config.call.defaultPolicy,
  });
  return enter(state, client, peer, args.endpoint, args.nick);
};

const openCall = async (client, args) => {
  const peer = peerOf(client);
  if (!owns(client, args.endpoint)) return fail('call/forbidden');
  const kind = kindOf(args.chat);
  if (!kind) return fail('call/forbidden');
  if (kind === 'direct' && !inPair(args.chat, peer)) {
    return fail('call/forbidden');
  }
  const existing = callOfChat(args.chat);
  if (existing) return fail('call/exists', existing.id);
  if (hosted(peer) >= config.call.maxCallsPerPeer) {
    return fail('call/forbidden');
  }
  const picked = POLICIES.includes(args.policy);
  const policy = picked ? args.policy : config.call.defaultPolicy;
  const nick = clip(args.nick, NICK_LIMIT);
  const state = createCall({
    id: node.crypto.randomUUID(),
    chat: args.chat,
    kind,
    title: clip(args.title, TITLE_LIMIT),
    started: Date.now(),
    host: peer,
    policy,
  });
  const joined = await enter(state, client, peer, args.endpoint, nick);
  if (kind === 'direct') ring(state, peer, nick);
  return { state: joined.state, token: state.token };
};

const bytesOf = (message) => {
  if (!message || typeof message !== 'object') return -1;
  try {
    const text = JSON.stringify(message);
    if (typeof text !== 'string') return -1;
    return text.length;
  } catch {
    return -1;
  }
};

const envelopeOk = (from, to, message) => {
  if (!message || typeof message !== 'object') return false;
  if (message.source !== from || message.target !== to) return false;
  const size = bytesOf(message);
  return size >= 0 && size <= MESSAGE_LIMIT;
};

const applyUpdate = (item, args) => {
  let changed = false;
  for (const name of FLAGS) {
    if (typeof args[name] !== 'boolean') continue;
    item[name] = args[name];
    changed = true;
  }
  if (typeof args.hand === 'boolean') {
    item.hand = args.hand ? Date.now() : 0;
    changed = true;
  }
  if (typeof args.title === 'string') {
    item.title = args.title.slice(0, LABEL_LIMIT);
    changed = true;
  }
  return changed;
};

const request = (state, by, endpoint, action) => {
  const target = state.participants.get(endpoint);
  if (!target) return true;
  const data = Object.freeze({
    call: state.id,
    endpoint: target.endpoint,
    action,
    by,
  });
  target.client.emit('call/request', data);
  return true;
};

const removeTarget = async (state, by, endpoint) => {
  const target = state.participants.get(endpoint);
  if (!target) return true;
  state.participants.delete(endpoint);
  forget(target.client, endpoint);
  const data = Object.freeze({ call: state.id, endpoint, by });
  target.client.emit('call/removed', data);
  if (state.participants.size === 0) {
    await finish(state, '', target.client);
    return true;
  }
  await publish(state);
  announce(state, false);
  return true;
};

const promote = async (state, endpoint) => {
  const target = state.participants.get(endpoint);
  if (!target) return true;
  state.cohosts.add(target.peer);
  await publish(state);
  return true;
};

const demote = async (state, endpoint) => {
  const target = state.participants.get(endpoint);
  if (!target) return true;
  state.cohosts.delete(target.peer);
  await publish(state);
  return true;
};

const setStage = async (state, endpoint, value) => {
  if (typeof value !== 'boolean') return fail('call/bad-action');
  const target = state.participants.get(endpoint);
  if (!target) return true;
  target.stage = value;
  await publish(state);
  return true;
};

const lowerOne = async (state, endpoint) => {
  const target = state.participants.get(endpoint);
  if (!target) return true;
  target.hand = 0;
  await publish(state);
  return true;
};

const muteAll = (state, by, owner) => {
  for (const item of state.participants.values()) {
    if (isAdmin(state, item.peer, owner)) continue;
    const data = Object.freeze({
      call: state.id,
      endpoint: item.endpoint,
      action: 'mute',
      by,
    });
    item.client.emit('call/request', data);
  }
  return true;
};

const lowerAll = async (state) => {
  for (const item of state.participants.values()) item.hand = 0;
  await publish(state);
  return true;
};

const setLock = async (state, locked) => {
  state.locked = locked;
  await publish(state);
  return true;
};

const setPolicy = async (state, value) => {
  if (!POLICIES.includes(value)) return fail('call/bad-action');
  state.policy = value;
  await publish(state);
  return true;
};

const setSpotlight = async (state, value) => {
  const clear = value === '';
  const joined = typeof value === 'string' && state.participants.has(value);
  if (!clear && !joined) return fail('call/bad-action');
  state.spotlight = value;
  await publish(state);
  return true;
};

const HOST = {
  remove: (access, args) =>
    removeTarget(access.state, access.peer, args.target),
  promote: (access, args) => promote(access.state, args.target),
  demote: (access, args) => demote(access.state, args.target),
  stage: (access, args) => setStage(access.state, args.target, args.value),
  lowerHand: (access, args) => lowerOne(access.state, args.target),
  muteAll: (access) => muteAll(access.state, access.peer, access.owner),
  lowerHands: (access) => lowerAll(access.state),
  lock: (access) => setLock(access.state, true),
  unlock: (access) => setLock(access.state, false),
  policy: (access, args) => setPolicy(access.state, args.value),
  spotlight: (access, args) => setSpotlight(access.state, args.value),
};

const accessOf = async (client, id) => {
  const state = domain.call.calls.get(id) ?? null;
  if (!state) {
    return { error: fail('call/not-found'), state, peer: '', owner: '' };
  }
  const peer = peerOf(client);
  const owner = await ownerOf(state.chat);
  if (!isAdmin(state, peer, owner)) {
    return { error: fail('call/admin-only'), state: null, peer, owner };
  }
  return { error: null, state, peer, owner };
};

const arm = () => {
  if (domain.call.timer) return;
  const timer = setInterval(() => {
    domain.call.sweep();
  }, SWEEP_MS);
  if (typeof timer.unref === 'function') timer.unref();
  domain.call.timer = timer;
};

const sweepAll = async () => {
  const now = Date.now();
  const limit = config.call.timeoutMs;
  const ids = Array.from(domain.call.calls.keys());
  for (const id of ids) {
    const state = domain.call.calls.get(id);
    if (!state) continue;
    const stale = [];
    for (const item of state.participants.values()) {
      if (now - item.seen > limit) stale.push(item.endpoint);
    }
    for (const endpoint of stale) await releaseParticipant(state, endpoint);
  }
};

({
  calls: new Map(),
  endpoints: new Map(),
  clientEndpoints: new WeakMap(),
  watched: new WeakSet(),
  buckets: new Map(),
  pending: new WeakMap(),
  timer: null,

  async start(client, args) {
    if (args === undefined) {
      arm();
      return true;
    }
    return openCall(client, args);
  },

  async stop() {
    if (!domain.call.timer) return;
    clearInterval(domain.call.timer);
    domain.call.timer = null;
  },

  watch(client) {
    if (domain.call.watched.has(client)) return;
    domain.call.watched.add(client);
    client.on('close', () => {
      domain.call.drop(client);
    });
  },

  async drop(client) {
    const current = domain.call.pending.get(client);
    if (current) return current;
    const task = removeClient(client);
    domain.call.pending.set(client, task);
    try {
      return await task;
    } finally {
      domain.call.pending.delete(client);
    }
  },

  async join(client, args) {
    if (!owns(client, args.endpoint)) return fail('call/forbidden');
    const state = domain.call.calls.get(args.call);
    if (!state) {
      if (args.resume === true) return restore(client, args);
      return fail('call/not-found');
    }
    return arrive(client, state, args);
  },

  async leave(client, args) {
    if (!owns(client, args.endpoint)) return fail('call/forbidden');
    await release(client, args.endpoint);
    return true;
  },

  ping(client, args) {
    if (!owns(client, args.endpoint)) return fail('call/forbidden');
    const state = domain.call.calls.get(args.call);
    const item = state?.participants.get(args.endpoint);
    if (!item) return fail('call/not-joined');
    item.seen = Date.now();
    return true;
  },

  async update(client, args) {
    if (!owns(client, args.endpoint)) return fail('call/forbidden');
    const state = domain.call.calls.get(args.call);
    const item = state?.participants.get(args.endpoint);
    if (!item) return fail('call/not-joined');
    if (!allow(args.endpoint, 'update')) return fail('call/rate');
    if (blocked(state, item, args)) return fail('call/limit');
    const changed = applyUpdate(item, args);
    if (changed) await publish(state);
    return true;
  },

  signal(client, args) {
    const from = args.from;
    const to = args.to;
    if (!owns(client, from)) return fail('call/forbidden');
    const state = domain.call.calls.get(args.call);
    const source = state?.participants.get(from);
    const target = state?.participants.get(to);
    if (!source || !target) return fail('call/not-joined');
    if (!envelopeOk(from, to, args.message)) return fail('call/forbidden');
    if (!allow(from, 'signal')) return fail('call/rate');
    const data = Object.freeze({
      call: state.id,
      from,
      to,
      message: args.message,
    });
    target.client.emit('call/signal', data);
    return true;
  },

  async admit(client, args) {
    const access = await accessOf(client, args.call);
    if (access.error) return access.error;
    const entry = access.state.lobby.get(args.endpoint);
    if (!entry) return true;
    const full = access.state.participants.size >= config.call.maxParticipants;
    if (full) return fail('call/full');
    const joined = await enter(
      access.state,
      entry.client,
      entry.peer,
      entry.endpoint,
      entry.nick,
    );
    const data = Object.freeze({
      call: access.state.id,
      endpoint: entry.endpoint,
      state: joined.state,
    });
    entry.client.emit('call/admitted', data);
    return true;
  },

  async deny(client, args) {
    const access = await accessOf(client, args.call);
    if (access.error) return access.error;
    const entry = access.state.lobby.get(args.endpoint);
    if (!entry) return true;
    access.state.lobby.delete(args.endpoint);
    forget(entry.client, args.endpoint);
    const data = Object.freeze({
      call: access.state.id,
      endpoint: args.endpoint,
    });
    entry.client.emit('call/denied', data);
    await publish(access.state);
    return true;
  },

  async host(client, args) {
    const access = await accessOf(client, args.call);
    if (access.error) return access.error;
    if (REQUESTS.has(args.action)) {
      return request(access.state, access.peer, args.target, args.action);
    }
    const handler = HOST[args.action];
    if (!handler) return fail('call/bad-action');
    return handler(access, args);
  },

  async link(client, args) {
    const access = await accessOf(client, args.call);
    if (access.error) return access.error;
    if (args.rotate === true) access.state.token = tokenOf();
    return { token: access.state.token };
  },

  async decline(client, args) {
    const state = domain.call.calls.get(args.call);
    const peer = peerOf(client);
    if (!state?.ringing || peer !== state.ringing.peer) return true;
    const callers = callerClients(state);
    clearRing(state);
    await finish(state, '', client);
    emitRinging(callers, state.id, 'declined');
    return true;
  },

  async end(client, args) {
    const access = await accessOf(client, args.call);
    if (access.error) return access.error;
    await finish(access.state, access.peer, client);
    return true;
  },

  active() {
    const list = [];
    for (const state of domain.call.calls.values()) {
      list.push({
        call: state.id,
        chat: state.chat,
        count: state.participants.size,
        started: state.started,
      });
    }
    return list;
  },

  async sweep() {
    await sweepAll();
  },

  async miss(id) {
    const state = domain.call.calls.get(id);
    if (!clearRing(state)) return;
    const callers = callerClients(state);
    await finish(state, '', null);
    emitRinging(callers, id, 'missed');
  },
});
