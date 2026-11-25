const PAIR = /^[\w-]{1,64}_[\w-]{1,64}$/;
const POLICIES = ['open', 'link', 'approval'];
const FLAGS = ['mic', 'camera', 'screen', 'recording', 'optOut', 'live'];
const REQUESTS = ['mute', 'unmute', 'stopCamera', 'stopScreen'];
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

const peerOf = (client) => domain.presence.peerOf(client);

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

const ownerOf = (chat) => {
  const record = db.globalstorage?.replica?.get(chat);
  return record?.owner ?? '';
};

const isAdmin = (state, peer, owner) => {
  if (peer === '') return false;
  if (peer === state.host) return true;
  if (state.cohosts.has(peer)) return true;
  return owner !== '' && peer === owner;
};

const adminsOf = (state, owner) => {
  const admins = new Set([state.host, ...state.cohosts, owner]);
  admins.delete('');
  return Array.from(admins);
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
  if (camera && countOn(state, 'camera') >= config.call.maxCameras) {
    return true;
  }
  const screen = args.screen === true && !item.screen;
  return screen && countOn(state, 'screen') >= config.call.maxScreens;
};

const memberOf = (state, client, peer, endpoint, nick, now) => ({
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
  stage: !state.joinBackstage || peer === state.host || state.cohosts.has(peer),
  live: false,
  title: '',
  limits: {
    signal: { tokens: SIGNAL_BURST, time: now },
    update: { tokens: UPDATE_BURST, time: now },
  },
});

const peopleOf = (state, admins) => {
  const people = new Array(state.participants.size).fill(null);
  let index = 0;
  for (const item of state.participants.values()) {
    people[index++] = {
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
    };
  }
  return people;
};

const lobbyOf = (state) => {
  const lobby = new Array(state.lobby.size).fill(null);
  let index = 0;
  for (const item of state.lobby.values()) {
    lobby[index++] = {
      endpoint: item.endpoint,
      peer: item.peer,
      nick: item.nick,
      knocked: item.knocked,
    };
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
  joinBackstage: state.joinBackstage,
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

const viewsOf = (state) => {
  const version = state.version;
  const owner = ownerOf(state.chat);
  const admins = Object.freeze(adminsOf(state, owner));
  const people = Object.freeze(peopleOf(state, admins));
  const lobby = Object.freeze(lobbyOf(state));
  const member = Object.freeze(viewOf(state, admins, people, EMPTY, version));
  const admin = Object.freeze(viewOf(state, admins, people, lobby, version));
  return (peer) => (isAdmin(state, peer, owner) ? admin : member);
};

const publish = async (state) => {
  state.version += 1;
  const viewFor = viewsOf(state);
  for (const item of state.participants.values()) {
    item.client.emit('call/state', viewFor(item.peer));
  }
  return viewFor;
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
  const given = fields.token;
  const hasToken = typeof given === 'string' && given !== '';
  const token = hasToken ? given : tokenOf();
  const state = {
    id: fields.id,
    chat: fields.chat,
    kind: fields.kind,
    title: fields.title,
    started: fields.started,
    version: 0,
    policy: fields.policy,
    token,
    locked: false,
    joinBackstage: false,
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
  const full = state.participants.size >= config.call.maxParticipants;
  if (full) return fail('call/full');
  const now = Date.now();
  const member = memberOf(state, client, peer, endpoint, nick, now);
  state.participants.set(endpoint, member);
  state.lobby.delete(endpoint);
  remember(client, endpoint, state.id);
  clearRing(state);
  const viewFor = await publish(state);
  announce(state, false);
  return { status: 'joined', state: viewFor(peer) };
};

const wait = async (state, client, peer, endpoint, args) => {
  const sitting = state.lobby.has(endpoint);
  const full = state.lobby.size >= config.call.maxLobby;
  if (full && !sitting) return fail('call/full');
  const entry = {
    endpoint,
    peer,
    nick: clip(args.nick, NICK_LIMIT),
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
  for (const items of [state.participants, state.lobby]) {
    for (const item of items.values()) {
      clients.add(item.client);
      forget(item.client, item.endpoint);
    }
  }
  if (actor) clients.add(actor);
  state.participants.clear();
  state.lobby.clear();
  domain.call.calls.delete(state.id);
  const data = Object.freeze({ call: state.id, by });
  for (const client of clients) client.emit('call/ended', data);
  announce(state, true);
};

const depart = async (state, item) => {
  state.participants.delete(item.endpoint);
  forget(item.client, item.endpoint);
  if (state.participants.size === 0) {
    await finish(state, '', item.client);
    return;
  }
  await publish(state);
  announce(state, false);
};

const unknock = async (state, entry) => {
  state.lobby.delete(entry.endpoint);
  forget(entry.client, entry.endpoint);
  await publish(state);
};

const release = async (client, endpoint) => {
  const located = domain.call.endpoints.get(endpoint);
  const own = located?.client === client;
  const state = own ? domain.call.calls.get(located.call) : undefined;
  const item = state?.participants.get(endpoint);
  if (item) return depart(state, item);
  const entry = state?.lobby.get(endpoint);
  if (entry) return unknock(state, entry);
  return forget(client, endpoint);
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
  return { status: 'joined', state: viewsOf(state)(peer) };
};

const arrive = async (client, state, args) => {
  const peer = peerOf(client);
  const endpoint = args.endpoint;
  if (state.participants.has(endpoint)) return again(state, peer, endpoint);
  const direct = state.kind === 'direct';
  if (direct && !inPair(state.chat, peer)) return fail('call/forbidden');
  const owner = ownerOf(state.chat);
  const admin = isAdmin(state, peer, owner);
  if (!direct) {
    const decision = admissionOf(state, {
      isAdmin: admin,
      hasToken: args.token === state.token,
    });
    if (decision === 'denied') return fail('call/locked');
    if (decision === 'lobby') return wait(state, client, peer, endpoint, args);
  }
  return enter(state, client, peer, endpoint, args.nick);
};

const canResume = (peer, host, kind, chat, owner) => {
  if (peer === host) return true;
  if (kind === 'direct' && inPair(chat, peer)) return true;
  return owner !== '' && peer === owner;
};

const restore = async (client, args) => {
  const id = args.call;
  const existing = domain.call.calls.get(id);
  if (existing) return arrive(client, existing, args);
  const peer = peerOf(client);
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
  const owner = ownerOf(chat);
  if (!canResume(peer, host, kind, chat, owner)) {
    return fail('call/not-found');
  }
  const state = createCall({
    id,
    chat,
    kind,
    title: '',
    started,
    host,
    policy: config.call.defaultPolicy,
    token: args.token,
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
  try {
    return JSON.stringify(message).length;
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
    const raised = item.hand > 0;
    if (!args.hand) item.hand = 0;
    else if (!raised) item.hand = Date.now();
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
  const data = Object.freeze({ call: state.id, endpoint, by });
  target.client.emit('call/removed', data);
  await depart(state, target);
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
  if (target.peer === state.host) return fail('call/bad-action');
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

const setJoinBackstage = async (state, value) => {
  if (typeof value !== 'boolean') return fail('call/bad-action');
  state.joinBackstage = value;
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
    if (!isAdmin(state, item.peer, owner)) {
      request(state, by, item.endpoint, 'mute');
    }
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
  joinBackstage: (access, args) => setJoinBackstage(access.state, args.value),
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
  const owner = ownerOf(state.chat);
  if (!isAdmin(state, peer, owner)) {
    return { error: fail('call/admin-only'), state: null, peer, owner };
  }
  return { error: null, state, peer, owner };
};

const joinedOf = (client, id, endpoint) => {
  if (!owns(client, endpoint)) return { error: fail('call/forbidden') };
  const state = domain.call.calls.get(id);
  const item = state?.participants.get(endpoint);
  if (!item) return { error: fail('call/not-joined') };
  return { error: null, state, item };
};

const arm = () => {
  if (domain.call.timer) return;
  const timer = setInterval(() => {
    domain.call.sweep();
  }, SWEEP_MS);
  if (typeof timer.unref === 'function') timer.unref();
  domain.call.timer = timer;
};

const hangUp = async (state, actor, name) => {
  const callers = callerClients(state);
  await finish(state, '', actor);
  emitRinging(callers, state.id, name);
};

({
  calls: new Map(),
  endpoints: new Map(),
  clientEndpoints: new WeakMap(),
  watched: new WeakSet(),
  pending: new WeakMap(),
  timer: null,
  stopping: false,

  async start() {
    arm();
    return true;
  },

  async open(client, args) {
    return openCall(client, args);
  },

  async stop() {
    domain.call.stopping = true;
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
    if (domain.call.stopping) return null;
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
    const joined = joinedOf(client, args.call, args.endpoint);
    if (joined.error) return joined.error;
    joined.item.seen = Date.now();
    return true;
  },

  member(client, args) {
    if (!owns(client, args?.endpoint)) return false;
    const state = domain.call.calls.get(args.call);
    return state?.participants.has(args.endpoint) === true;
  },

  async update(client, args) {
    const joined = joinedOf(client, args.call, args.endpoint);
    if (joined.error) return joined.error;
    const { state, item } = joined;
    const rate = config.call.updateRate;
    if (!takeToken(item.limits.update, rate, UPDATE_BURST, Date.now())) {
      return fail('call/rate');
    }
    if (blocked(state, item, args)) return fail('call/limit');
    const changed = applyUpdate(item, args);
    if (changed) await publish(state);
    return true;
  },

  signal(client, args) {
    const from = args.from;
    const to = args.to;
    const joined = joinedOf(client, args.call, from);
    if (joined.error) return joined.error;
    const state = joined.state;
    const target = state.participants.get(to);
    if (!target) return fail('call/not-joined');
    if (!envelopeOk(from, to, args.message)) return fail('call/forbidden');
    const rate = config.call.signalRate;
    const limit = joined.item.limits.signal;
    if (!takeToken(limit, rate, SIGNAL_BURST, Date.now())) {
      return fail('call/rate');
    }
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
    const joined = await enter(
      access.state,
      entry.client,
      entry.peer,
      entry.endpoint,
      entry.nick,
    );
    if (joined instanceof Error) return joined;
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
    const data = Object.freeze({
      call: access.state.id,
      endpoint: args.endpoint,
    });
    entry.client.emit('call/denied', data);
    await unknock(access.state, entry);
    return true;
  },

  async host(client, args) {
    const access = await accessOf(client, args.call);
    if (access.error) return access.error;
    if (REQUESTS.includes(args.action)) {
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
    await hangUp(state, client, 'declined');
    return true;
  },

  async end(client, args) {
    const access = await accessOf(client, args.call);
    if (access.error) return access.error;
    await finish(access.state, access.peer, client);
    return true;
  },

  active(client) {
    const peer = peerOf(client);
    const list = new Array(domain.call.calls.size).fill(null);
    let index = 0;
    for (const state of domain.call.calls.values()) {
      const owner = ownerOf(state.chat);
      const count = state.participants.size;
      const full = count >= config.call.maxParticipants;
      list[index++] = {
        call: state.id,
        chat: state.chat,
        count,
        started: state.started,
        policy: state.policy,
        locked: state.locked,
        kind: state.kind,
        full,
        admin: isAdmin(state, peer, owner),
      };
    }
    return list;
  },

  async sweep() {
    const now = Date.now();
    const limit = config.call.timeoutMs;
    for (const state of Array.from(domain.call.calls.values())) {
      if (!domain.call.calls.has(state.id)) continue;
      let last = null;
      for (const item of state.participants.values()) {
        if (now - item.seen <= limit) continue;
        state.participants.delete(item.endpoint);
        forget(item.client, item.endpoint);
        last = item;
      }
      if (!last) continue;
      if (state.participants.size === 0) {
        await finish(state, '', last.client);
        continue;
      }
      await publish(state);
      announce(state, false);
    }
  },

  async miss(id) {
    const state = domain.call.calls.get(id);
    if (!clearRing(state)) return;
    await hangUp(state, null, 'missed');
  },
});
