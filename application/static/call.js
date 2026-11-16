import { Emitter, jsonParse } from './metautil.js';
import { RtcConnection, emitError } from './metacom.js';
import { CODECS, LinkMediaPolicy, validateHint } from './media.js';

const CALL_SLOTS = [
  { slot: 'mic', kind: 'audio' },
  { slot: 'camera', kind: 'video' },
  { slot: 'screen', kind: 'video' },
  { slot: 'screenAudio', kind: 'audio' },
];
const SLOTS = CALL_SLOTS.map((item) => item.slot);
const RECONNECT_MS = [1000, 2000, 5000, 10000];
const HEARTBEAT_MS = 10000;
const RESUME_LIMIT = 12;
const RESUME_WAIT_MS = 300;
const MESSAGE_LIMIT = 4096;
const TYPES = new Set(['hint', 'reaction', 'ping', 'relay']);
const EVENTS = [
  'state',
  'signal',
  'ended',
  'admitted',
  'denied',
  'removed',
  'active',
  'ringing',
  'request',
];
const LIVE = new Set(['joined', 'lobby', 'reconnecting']);
const RESUMABLE = new Set(['joined', 'reconnecting']);

const isOfferer = (local, remote) => {
  if (local.joined !== remote.joined) return local.joined > remote.joined;
  return local.endpoint > remote.endpoint;
};

const delayOf = (attempt) => RECONNECT_MS[Math.min(attempt, 3)];

const participantOf = (list, endpoint) => {
  if (!Array.isArray(list)) return null;
  for (const item of list) {
    if (item.endpoint === endpoint) return item;
  }
  return null;
};

const isRecord = (value) => {
  const isObject = typeof value === 'object' && value !== null;
  return isObject && !Array.isArray(value);
};

const isOffer = (message) => message?.description?.type === 'offer';

const relax = (timer) => {
  if (timer && typeof timer.unref === 'function') timer.unref();
  return timer;
};

const pause = (schedule, ms) =>
  new Promise((resolve) => {
    schedule(resolve, ms);
  });

const RETRYABLE = new Set(['call/not-found', 'call/forbidden']);

const isRetryable = (error) => RETRYABLE.has(error?.code);

const guard = async (work, session) => {
  try {
    await work();
  } catch (error) {
    emitError(session, error);
  }
};

const onEvent = (session, name) => (data) => {
  session.receive(name, data);
};

class SignalRouter {
  #listeners = new Map();
  #buffers = new Map();
  #limit = 256;
  #ttlMs = 30000;

  constructor({ limit = 256, ttlMs = 30000 } = {}) {
    this.#limit = limit;
    this.#ttlMs = ttlMs;
  }

  deliver({ call, from, to, message }) {
    const key = `${call}\n${to}\n${from}`;
    const listener = this.#listeners.get(key);
    if (listener) return void listener(message);
    const buffer = this.#buffers.get(key) ?? { messages: [], timer: null };
    buffer.messages.push(message);
    if (buffer.messages.length > this.#limit) buffer.messages.shift();
    clearTimeout(buffer.timer);
    buffer.timer = setTimeout(() => this.#buffers.delete(key), this.#ttlMs);
    this.#buffers.set(key, buffer);
  }

  subscribe(call, to, from, listener) {
    const key = `${call}\n${to}\n${from}`;
    this.#listeners.set(key, listener);
    const buffer = this.#buffers.get(key);
    if (buffer) {
      clearTimeout(buffer.timer);
      this.#buffers.delete(key);
      for (const message of buffer.messages) listener(message);
    }
    return () => {
      if (this.#listeners.get(key) === listener) this.#listeners.delete(key);
    };
  }
}

class CallLink extends Emitter {
  #connection = null;
  #channel = null;
  #onTrack = null;
  #onClose = null;
  #onMessage = null;
  #closed = false;
  #notified = false;
  #messageStart = 0;
  #messageCount = 0;

  constructor(options = {}) {
    super();
    const connection = options.connection ?? new RtcConnection();
    this.#connection = connection;
    this.remote = '';
    this.role = '';
    this.connected = false;
    this.retired = false;
    this.connectedAt = 0;
    this.policy = new LinkMediaPolicy(this);
    this.#onTrack = (payload) => this.#emitTrack(payload);
    this.#onClose = (error) => this.#notifyClose(error);
    connection.on('track', this.#onTrack);
    connection.on('close', this.#onClose);
  }

  async open(options) {
    const localId = options.localId;
    const peerId = options.peerId;
    const role = options.role;
    const configuration = options.configuration;
    const signaling = options.signaling;
    this.remote = peerId;
    this.role = role;
    const media = CALL_SLOTS;
    try {
      const channel = await this.#connection.open({
        localId,
        peerId,
        role,
        media,
        configuration,
        signaling,
        codecs: CODECS,
      });
      this.#ready(channel);
    } catch (error) {
      this.#notifyClose(error);
    }
  }

  send(message) {
    const channel = this.#channel;
    const isOpen = channel && channel.readyState === 'open';
    if (!isOpen) return;
    const text = JSON.stringify(message);
    if (typeof text !== 'string' || text.length > MESSAGE_LIMIT) return;
    channel.send(text);
  }

  async setTrack(slot, track) {
    await this.#connection.setTrack(slot, track);
    await this.policy.refresh();
  }

  sender(slot) {
    return this.#connection.sender?.(slot) ?? null;
  }

  get peerConnection() {
    return this.#connection.peerConnection;
  }

  receiver(slot) {
    return this.#connection.receiver?.(slot) ?? null;
  }

  close() {
    if (this.#closed) return;
    this.#closed = true;
    this.connected = false;
    this.policy.stop();
    this.#unlisten();
    const connection = this.#connection;
    if (typeof connection.off === 'function') {
      connection.off('track', this.#onTrack);
      connection.off('close', this.#onClose);
    }
    connection.close();
    this.#notifyClose(null);
  }

  #ready(channel) {
    if (this.#closed || this.#notified || !channel) return;
    this.#channel = channel;
    this.#listen(channel);
    this.connected = true;
    this.policy.start();
    const proto = globalThis.RTCRtpTransceiver?.prototype;
    const canPrefer = typeof proto?.setCodecPreferences === 'function';
    const canRead =
      typeof globalThis.RTCRtpSender?.getCapabilities === 'function';
    if (!canPrefer || !canRead) {
      this.policy.notice('Codec preferences are unavailable in this browser.');
    }
    this.emit('connect');
  }

  #listen(channel) {
    this.#onMessage = (event) => this.#incoming(event);
    if (typeof channel.addEventListener === 'function') {
      channel.addEventListener('message', this.#onMessage);
      return;
    }
    channel.onmessage = this.#onMessage;
  }

  #unlisten() {
    const channel = this.#channel;
    const onMessage = this.#onMessage;
    if (!channel || !onMessage) return;
    if (typeof channel.removeEventListener === 'function') {
      channel.removeEventListener('message', onMessage);
    }
    if (channel.onmessage === onMessage) channel.onmessage = null;
  }

  #incoming(event) {
    const data = typeof event === 'string' ? event : event?.data;
    if (typeof data !== 'string' || data.length > MESSAGE_LIMIT) return;
    const message = jsonParse(data);
    if (!isRecord(message) || !TYPES.has(message.type)) return;
    const now = Date.now();
    if (now - this.#messageStart >= 1000) {
      this.#messageStart = now;
      this.#messageCount = 0;
    }
    this.#messageCount += 1;
    if (this.#messageCount > 20) return;
    if (message.type === 'hint') {
      const hint = validateHint(message);
      if (!hint) return;
      this.policy.hint(hint);
    }
    this.emit('message', message);
  }

  #emitTrack(payload) {
    const slot = payload?.slot;
    const track = payload?.track;
    this.emit('track', { slot, track });
  }

  #notifyClose(error) {
    if (this.#notified) return;
    this.#notified = true;
    this.connected = false;
    this.policy.stop();
    this.emit('close', error);
  }
}

class CallSession extends Emitter {
  #ice = null;
  #now = null;
  #schedule = null;
  #createConnection = null;
  #version = -1;
  #state = null;
  #nick = '';
  #links = new Map();
  #tracks = new Map();
  #token = '';
  #keep = false;
  #attempts = new Map();
  #plans = new Map();
  #planTimers = new Map();
  #heartbeat = null;
  #onPageHide = null;
  #viewHints = new Map();
  #audioOnly = new Set();

  constructor(options) {
    super();
    const { api, endpoint, call, chat } = options;
    const { ice, now, schedule, connection } = options;
    this.api = api;
    this.endpoint = endpoint;
    this.call = call;
    this.chat = chat ?? '';
    this.phase = 'idle';
    this.router = new SignalRouter();
    this.#ice = ice;
    this.#now = typeof now === 'function' ? now : () => Date.now();
    this.#schedule = schedule ?? ((fn, ms) => setTimeout(fn, ms));
    const create = () => new RtcConnection();
    this.#createConnection = connection ?? create;
    this.#bind();
    if (options.pagehide !== false) this.#listenPage();
  }

  begin() {
    const phase = this.phase;
    const ready = phase === 'idle' || phase === 'ended';
    if (!ready) return;
    this.#setPhase('prejoin');
  }

  async join(input) {
    const nick = input.nick;
    if (typeof nick === 'string') this.#nick = nick;
    const given = input.token;
    if (typeof given === 'string' && given !== '') this.#token = given;
    const phase = this.phase;
    this.#setPhase('joining');
    const payload = this.#joinPayload(input);
    try {
      const result = await this.api.call.join(payload);
      return this.#joined(result);
    } catch (error) {
      const kept = input.resume === true && RESUMABLE.has(phase);
      this.#setPhase(kept ? phase : 'idle');
      throw error;
    }
  }

  hold() {
    this.#keep = true;
  }

  async resume(record) {
    this.#keep = true;
    this.#version = -1;
    try {
      const input = this.#resumeInput(record);
      return await this.#attemptResume(input);
    } finally {
      this.#keep = false;
    }
  }

  async leave() {
    this.#setPhase('leaving');
    this.#clearPlans();
    const call = this.call;
    const endpoint = this.endpoint;
    try {
      await this.api.call.leave({ call, endpoint });
    } finally {
      this.#closeLinks();
      this.#setPhase('idle');
    }
  }

  setTrack(slot, track) {
    this.#tracks.set(slot, track);
    for (const link of this.#links.values()) this.#putTrack(link, slot, track);
  }

  receiver(endpoint, slot) {
    const link = this.#links.get(endpoint);
    if (!link) return null;
    return link.receiver(slot);
  }

  sender(endpoint, slot) {
    return this.#links.get(endpoint)?.sender(slot) ?? null;
  }

  send(endpoint, message) {
    this.#links.get(endpoint)?.send(message);
  }

  setViewHint(endpoint, message) {
    const hint = validateHint(message);
    if (!hint) return;
    const key = `${endpoint}\n${hint.slot}`;
    this.#viewHints.set(key, hint);
    this.#sendHint(endpoint, hint);
  }

  setAudioOnly(endpoint, enabled) {
    if (enabled) this.#audioOnly.add(endpoint);
    else this.#audioOnly.delete(endpoint);
    const link = this.#links.get(endpoint);
    if (link) {
      link.policy.localAudioOnly = enabled;
      link.policy.refresh();
    }
    const key = `${endpoint}\ncamera`;
    const hint = this.#viewHints.get(key) ?? {
      slot: 'camera',
      width: 1280,
      height: 720,
      fps: 30,
    };
    this.#viewHints.set(key, hint);
    this.#sendHint(endpoint, hint);
  }

  isAudioOnly(endpoint) {
    const policy = this.#links.get(endpoint)?.policy;
    return this.#audioOnly.has(endpoint) || policy?.audioOnly === true;
  }

  requestedAudioOnly(endpoint) {
    return this.#audioOnly.has(endpoint);
  }

  #sendHint(endpoint, hint) {
    const audioOnly = this.#audioOnly.has(endpoint);
    this.send(endpoint, { ...hint, type: 'hint', audioOnly });
  }

  get linkCount() {
    return this.#links.size;
  }

  receive(eventName, data) {
    if (!data || data.call !== this.call) return;
    if (eventName === 'state') return void this.#onState(data);
    if (eventName === 'signal') return void this.#onSignal(data);
    if (eventName === 'admitted') return void this.#onAdmitted(data);
    if (eventName === 'denied') return void this.#onDenied(data);
    if (eventName === 'removed') return void this.#onRemoved(data);
    if (eventName === 'ended') {
      if (this.#keep) return;
      return void this.#shutdown();
    }
    if (eventName === 'request') return void this.#onRequest(data);
  }

  #resumeInput(record) {
    const nick = this.#nick;
    const call = record.call ?? this.call;
    const chat = record.chat ?? this.chat;
    const host = record.host;
    const started = record.started;
    const given = record.token;
    const hasToken = typeof given === 'string' && given !== '';
    const token = hasToken ? given : this.#token;
    return { nick, token, resume: true, call, chat, host, started };
  }

  async #shown() {
    const call = this.api?.call;
    if (typeof call?.active !== 'function') return true;
    const list = await call.active();
    if (!Array.isArray(list)) return false;
    for (const item of list) {
      if (item.call === this.call && item.count > 0) return true;
    }
    return false;
  }

  async #resumeOnce(input) {
    const result = await this.join(input);
    if (result?.status !== 'joined') return result;
    const shown = await this.#shown();
    if (shown) return result;
    const error = new Error('Call not found');
    error.code = 'call/not-found';
    throw error;
  }

  async #attemptResume(input) {
    let error = null;
    for (let attempt = 0; attempt < RESUME_LIMIT; attempt += 1) {
      try {
        return await this.#resumeOnce(input);
      } catch (caught) {
        error = caught;
        if (!isRetryable(caught)) throw caught;
      }
      const again = attempt + 1 < RESUME_LIMIT;
      if (again) await pause(this.#schedule, RESUME_WAIT_MS);
    }
    throw error;
  }

  #joinPayload(input) {
    const call = input.call ?? this.call;
    const chat = input.chat ?? this.chat;
    const endpoint = this.endpoint;
    const nick = input.nick;
    const token = input.token;
    const resume = input.resume;
    const host = input.host;
    const started = input.started;
    return { call, endpoint, nick, token, resume, chat, host, started };
  }

  #joined(result) {
    const status = result?.status;
    if (status === 'lobby') {
      this.#setPhase('lobby');
      return result;
    }
    if (status === 'joined') {
      if (result.state) this.#apply(result.state);
      if (this.phase === 'joining') this.#setPhase('joined');
      return result;
    }
    this.#setPhase('idle');
    return result;
  }

  #bind() {
    const call = this.api?.call;
    if (typeof call?.on !== 'function') return;
    for (const name of EVENTS) call.on(name, onEvent(this, name));
  }

  #listenPage() {
    if (typeof globalThis.addEventListener !== 'function') return;
    this.#onPageHide = () => {
      const call = this.call;
      const endpoint = this.endpoint;
      this.api.call.leave({ call, endpoint });
    };
    globalThis.addEventListener('pagehide', this.#onPageHide, true);
  }

  #onState(state) {
    const version = state.version;
    const stale = typeof version === 'number' && version < this.#version;
    if (stale || !this.#concerns(state)) return;
    this.#apply(state);
  }

  #onSignal(data) {
    if (data.to !== this.endpoint) return;
    const from = data.from;
    const link = this.#links.get(from);
    const stale = link?.role === 'answerer' && link.connected;
    if (!stale || !isOffer(data.message)) return void this.router.deliver(data);
    this.#drop(from);
    this.router.deliver(data);
    this.#reopen(from, 'answerer');
  }

  #onAdmitted(data) {
    if (data.endpoint && data.endpoint !== this.endpoint) return;
    if (data.state) this.#apply(data.state);
  }

  #onDenied(data) {
    if (data.endpoint && data.endpoint !== this.endpoint) return;
    this.#shutdown();
  }

  #onRemoved(data) {
    if (data.endpoint !== this.endpoint) return;
    this.#shutdown();
  }

  #onRequest(data) {
    if (data.endpoint && data.endpoint !== this.endpoint) return;
    this.emit('request', data);
  }

  #concerns(state) {
    const endpoint = this.endpoint;
    const joined = participantOf(state.participants, endpoint);
    const waiting = participantOf(state.lobby, endpoint);
    if (joined || waiting) return true;
    return LIVE.has(this.phase);
  }

  #apply(state) {
    if (!state) return;
    const version = state.version;
    const stale = typeof version === 'number' && version < this.#version;
    if (stale) return;
    if (typeof version === 'number') this.#version = version;
    this.#state = state;
    for (const link of this.#links.values()) {
      link.policy.participants = state.participants?.length ?? 2;
      link.policy.refresh();
    }
    this.#dropMissing(state.participants);
    const local = participantOf(state.participants, this.endpoint);
    if (local) {
      guard(() => this.#openMissing(state, local), this);
      this.#setPhase('joined');
      return;
    }
    const waiting = participantOf(state.lobby, this.endpoint);
    if (waiting) this.#setPhase('lobby');
  }

  async #openMissing(state, local) {
    const configuration = await this.#ice();
    if (this.#state !== state) return;
    const stopped = this.phase === 'idle' || this.phase === 'leaving';
    if (stopped || !Array.isArray(state.participants)) return;
    for (const remote of state.participants) {
      if (remote.endpoint === this.endpoint) continue;
      if (this.#links.has(remote.endpoint)) continue;
      const role = isOfferer(local, remote) ? 'offerer' : 'answerer';
      this.#open(remote, role, configuration);
    }
  }

  #open(remote, role, configuration) {
    const endpoint = remote.endpoint;
    const connection = this.#createConnection();
    const link = new CallLink({ connection });
    link.policy.participants = this.#state?.participants?.length ?? 2;
    link.policy.localAudioOnly = this.#audioOnly.has(endpoint);
    const signaling = this.#signaling(endpoint);
    this.#links.set(endpoint, link);
    link.on('close', () => this.#onLinkClose(endpoint, link));
    link.on('connect', () => this.#onLinkConnect(endpoint, link));
    link.on('message', (message) => {
      this.emit('message', { endpoint, message });
    });
    link.on('notice', (text) => this.emit('notice', text));
    link.on('stats', (stats) => {
      this.emit('stats', { endpoint, stats });
    });
    link.on('quality', (quality) => {
      this.emit('quality', { endpoint, ...quality });
    });
    link.on('track', (payload) => {
      const slot = payload?.slot;
      const track = payload?.track ?? null;
      this.emit('track', { endpoint, slot, track });
    });
    const localId = this.endpoint;
    const peerId = endpoint;
    const opening = link.open({
      localId,
      peerId,
      role,
      configuration,
      signaling,
    });
    guard(() => opening, this);
    this.#applyTracks(link);
  }

  #signaling(endpoint) {
    const call = this.call;
    const local = this.endpoint;
    const api = this.api;
    const router = this.router;
    return {
      send: (message) =>
        api.call.signal({ call, from: local, to: endpoint, message }),
      subscribe: (listener) =>
        router.subscribe(call, local, endpoint, listener),
    };
  }

  #applyTracks(link) {
    for (const slot of this.#tracks.keys()) {
      this.#putTrack(link, slot, this.#tracks.get(slot));
    }
  }

  #putTrack(link, slot, track) {
    guard(() => link.setTrack(slot, track), this);
  }

  #dropMissing(participants) {
    const present = new Set();
    if (Array.isArray(participants)) {
      for (const item of participants) present.add(item.endpoint);
    }
    const endpoints = [];
    for (const endpoint of this.#links.keys()) endpoints.push(endpoint);
    for (const endpoint of endpoints) {
      if (present.has(endpoint) || this.#keep) continue;
      this.#drop(endpoint);
    }
  }

  #drop(endpoint) {
    this.#cancelPlan(endpoint);
    const link = this.#links.get(endpoint);
    if (!link) return;
    this.#links.delete(endpoint);
    this.#attempts.delete(endpoint);
    link.retired = true;
    link.close();
  }

  #onLinkClose(endpoint, link) {
    if (link.retired || this.#links.get(endpoint) !== link) return;
    this.#links.delete(endpoint);
    link.retired = true;
    link.close();
    if (!this.#paired(endpoint)) return;
    const stopped = this.phase === 'idle' || this.phase === 'leaving';
    if (stopped) return;
    if (link.role !== 'offerer') return void this.#reopen(endpoint, 'answerer');
    const attempt = this.#attempts.get(endpoint) ?? 0;
    this.#attempts.set(endpoint, attempt + 1);
    this.#setPhase('reconnecting');
    this.#plan(endpoint, delayOf(attempt), link.role);
  }

  #onLinkConnect(endpoint, link) {
    if (link.retired || this.#links.get(endpoint) !== link) return;
    link.connectedAt = this.#now();
    this.#attempts.set(endpoint, 0);
    for (const slot of ['camera', 'screen']) {
      const hint = this.#viewHints.get(`${endpoint}\n${slot}`);
      if (hint) this.#sendHint(endpoint, hint);
    }
    if (this.#plans.size > 0 || this.phase !== 'reconnecting') return;
    this.#setPhase('joined');
  }

  #paired(endpoint) {
    const state = this.#state;
    if (!state) return false;
    const local = participantOf(state.participants, this.endpoint);
    const remote = participantOf(state.participants, endpoint);
    return Boolean(local && remote);
  }

  #plan(endpoint, delay, role) {
    this.#cancelPlan(endpoint);
    const run = () => {
      if (this.#plans.get(endpoint) !== run) return;
      this.#plans.delete(endpoint);
      this.#planTimers.delete(endpoint);
      this.#reopen(endpoint, role);
    };
    this.#plans.set(endpoint, run);
    const timer = relax(this.#schedule(run, delay));
    this.#planTimers.set(endpoint, timer);
  }

  #reopen(endpoint, role) {
    if (this.#links.has(endpoint) || !this.#paired(endpoint)) return;
    const stopped = this.phase === 'idle' || this.phase === 'leaving';
    if (stopped) return;
    const remote = participantOf(this.#state.participants, endpoint);
    guard(async () => {
      const configuration = await this.#ice();
      const gone = !this.#paired(endpoint) || this.#links.has(endpoint);
      const halted = this.phase === 'idle' || this.phase === 'leaving';
      if (gone || halted) return;
      this.#open(remote, role, configuration);
    }, this);
  }

  #cancelPlan(endpoint) {
    const timer = this.#planTimers.get(endpoint);
    if (timer === undefined) return;
    this.#plans.delete(endpoint);
    this.#planTimers.delete(endpoint);
    clearTimeout(timer);
  }

  #clearPlans() {
    const timers = [];
    for (const timer of this.#planTimers.values()) timers.push(timer);
    this.#plans.clear();
    this.#planTimers.clear();
    for (const timer of timers) clearTimeout(timer);
  }

  #closeLinks() {
    const links = [];
    for (const link of this.#links.values()) links.push(link);
    this.#links.clear();
    for (const link of links) {
      link.retired = true;
      link.close();
    }
  }

  #shutdown() {
    this.#clearPlans();
    this.#closeLinks();
    this.#attempts.clear();
    this.#setPhase('idle');
  }

  #armHeartbeat() {
    this.#clearHeartbeat();
    const run = () => {
      if (this.#heartbeat?.run !== run) return;
      this.#heartbeat = null;
      if (this.phase !== 'joined') return;
      const call = this.call;
      const endpoint = this.endpoint;
      guard(() => this.api.call.ping({ call, endpoint }), this);
      if (this.phase === 'joined') this.#armHeartbeat();
    };
    const timer = relax(this.#schedule(run, HEARTBEAT_MS));
    this.#heartbeat = { run, timer };
  }

  #clearHeartbeat() {
    const beat = this.#heartbeat;
    if (!beat) return;
    this.#heartbeat = null;
    clearTimeout(beat.timer);
  }

  #setPhase(phase) {
    if (this.phase === phase) return;
    this.phase = phase;
    if (phase === 'joined') this.#armHeartbeat();
    else this.#clearHeartbeat();
    this.emit('state', phase);
  }
}

export { CALL_SLOTS, SLOTS, isOfferer, delayOf };
export { SignalRouter, CallLink, CallSession };
