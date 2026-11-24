const STORAGE_KEY = 'xxii:destinations';
const NAME_LENGTH = 48;
const MIN_BITRATE = 1000000;
const MAX_BITRATE = 20000000;
const DEFAULT_BITRATE = 6000000;
const MAX_ENABLED = 2;
const MAX_FRAMERATE = 30;
const GATHER_MS = 2000;
const POST_MS = 10000;
const DELETE_MS = 5000;
const HEALTH_MS = 2000;
const LOST_MS = 5000;
const WARM_MS = 6000;
const RETRY_DELAYS = [2000, 5000, 10000];
const MAX_ATTEMPTS = 5;
const LOSS_LIMIT = 5;
const FPS_LIMIT = 20;
const LOOPBACK = ['localhost', '127.0.0.1', '[::1]'];
const RETRY_STATUSES = [408, 429];
const VIDEO_ORDER = ['video/h264', 'video/vp8'];
const AUDIO_ORDER = ['audio/opus'];

const STATUS_TEXT = {
  400: 'Bad Request',
  401: 'Unauthorized',
  403: 'Forbidden',
  404: 'Not Found',
  405: 'Method Not Allowed',
  409: 'Conflict',
  415: 'Unsupported Media Type',
};

const PROBLEMS = {
  name: `Enter a name of up to ${NAME_LENGTH} characters`,
  url: 'Enter an https:// address, http:// only for localhost',
  token: 'The token must be text',
  bitrate: 'Bitrate must be from 1 to 20 Mbps',
};

class WhipError extends Error {
  constructor(message, status = 0, statusText = '', isFinal = false) {
    super(message);
    this.status = status;
    this.statusText = statusText;
    this.isFinal = isFinal;
  }
}

const isText = (value) => typeof value === 'string';

const isEndpointUrl = (text) => {
  if (!isText(text)) return false;
  let url = null;
  try {
    url = new URL(text);
  } catch {
    return false;
  }
  if (url.username || url.password) return false;
  if (url.protocol === 'https:') return true;
  return url.protocol === 'http:' && LOOPBACK.includes(url.hostname);
};

const bitrateOf = (value) => {
  if (value === undefined) return DEFAULT_BITRATE;
  const isNumber = typeof value === 'number' && Number.isFinite(value);
  const isInRange = value >= MIN_BITRATE && value <= MAX_BITRATE;
  return isNumber && isInRange ? Math.round(value) : 0;
};

const problemOf = (raw) => {
  if (!raw || typeof raw !== 'object') return PROBLEMS.name;
  const name = isText(raw.name) ? raw.name.trim() : '';
  if (!name || name.length > NAME_LENGTH) return PROBLEMS.name;
  if (!isEndpointUrl(raw.url)) return PROBLEMS.url;
  if (raw.token !== undefined && !isText(raw.token)) return PROBLEMS.token;
  if (!bitrateOf(raw.bitrate)) return PROBLEMS.bitrate;
  return '';
};

const destinationOf = (raw) => {
  if (problemOf(raw) || !isText(raw.id) || !raw.id) return null;
  const { id, name, url, token = '' } = raw;
  const bitrate = bitrateOf(raw.bitrate);
  const enabled = raw.enabled === true;
  return { id, name: name.trim(), url, token, bitrate, enabled };
};

const destinationsOf = (raw) => {
  const list = Array.isArray(raw) ? raw : [];
  const ids = new Set();
  const result = [];
  let enabled = 0;
  for (const item of list) {
    const destination = destinationOf(item);
    if (!destination || ids.has(destination.id)) continue;
    ids.add(destination.id);
    if (destination.enabled && ++enabled > MAX_ENABLED) {
      destination.enabled = false;
    }
    result.push(destination);
  }
  return result;
};

const readDestinations = (storage = globalThis.localStorage) => {
  try {
    return destinationsOf(JSON.parse(storage.getItem(STORAGE_KEY)));
  } catch {
    return [];
  }
};

const writeDestinations = (destinations, storage = globalThis.localStorage) => {
  try {
    storage.setItem(STORAGE_KEY, JSON.stringify(destinations));
    return true;
  } catch {
    return false;
  }
};

const rankOf = (codec, order) => {
  const index = order.indexOf(codec.mimeType.toLowerCase());
  return index === -1 ? order.length : index;
};

const orderCodecs = (codecs, kind) => {
  const order = kind === 'video' ? VIDEO_ORDER : AUDIO_ORDER;
  const ranked = codecs.map((codec, index) => ({
    codec,
    index,
    rank: rankOf(codec, order),
  }));
  ranked.sort((a, b) => a.rank - b.rank || a.index - b.index);
  return ranked.map(({ codec }) => codec);
};

const splitLinks = (header) => {
  const parts = [];
  let current = '';
  let isQuoted = false;
  let isBracketed = false;
  for (const char of header) {
    if (char === '"' && !isBracketed) isQuoted = !isQuoted;
    if (char === '<' && !isQuoted) isBracketed = true;
    if (char === '>' && !isQuoted) isBracketed = false;
    const isSplit = char === ',' && !isQuoted && !isBracketed;
    if (isSplit) {
      parts.push(current);
      current = '';
    } else {
      current += char;
    }
  }
  parts.push(current);
  return parts;
};

const paramsOf = (text) => {
  const params = new Map();
  const pattern = /;\s*([^=;\s]+)\s*=\s*(?:"([^"]*)"|([^;\s]*))/g;
  for (const match of text.matchAll(pattern)) {
    const name = match[1].toLowerCase();
    if (!params.has(name)) params.set(name, match[2] ?? match[3]);
  }
  return params;
};

const iceServersOf = (header) => {
  if (!isText(header)) return [];
  const servers = [];
  for (const part of splitLinks(header)) {
    const match = /^\s*<([^>]*)>(.*)$/s.exec(part);
    if (!match || !match[1]) continue;
    const params = paramsOf(match[2]);
    const rels = (params.get('rel') ?? '').toLowerCase().split(/\s+/);
    if (!rels.includes('ice-server')) continue;
    const server = { urls: [match[1]] };
    const username = params.get('username');
    const credential = params.get('credential');
    if (username !== undefined) server.username = username;
    if (credential !== undefined) server.credential = credential;
    servers.push(server);
  }
  return servers;
};

const locationOf = (location, url) => {
  if (!isText(location) || location === '') return '';
  try {
    return new URL(location, url).href;
  } catch {
    return '';
  }
};

const isRetryStatus = (status) =>
  RETRY_STATUSES.includes(status) || (status >= 500 && status <= 599);

const verdictOf = (error) => {
  if (error?.isFinal) return { retry: false, reason: error.message };
  const status = error?.status ?? 0;
  if (!status) {
    const reason = error?.message || 'connection failed';
    return { retry: true, reason };
  }
  const text = error.statusText || STATUS_TEXT[status] || 'Rejected';
  const reason = `${text} (${status})`;
  return { retry: isRetryStatus(status), reason };
};

const retryOf = (failures) => {
  if (failures >= MAX_ATTEMPTS) return { stop: true, delay: 0 };
  const index = Math.min(failures, RETRY_DELAYS.length) - 1;
  return { stop: false, delay: RETRY_DELAYS[Math.max(index, 0)] };
};

const retryText = (failures, delay) =>
  `retrying in ${delay / 1000} s (attempt ${failures} of ${MAX_ATTEMPTS})`;

const giveUpText = (name) =>
  `Stream to ${name} stopped after ${MAX_ATTEMPTS} failed attempts`;

const sampleOf = (entries, at) => {
  const sample = { at, bytes: 0, fps: null, reason: 'none', loss: 0, rtt: 0 };
  for (const entry of entries) {
    const kind = entry.kind ?? entry.mediaType;
    if (kind !== 'video') continue;
    if (entry.type === 'outbound-rtp') {
      sample.bytes = entry.bytesSent ?? 0;
      sample.fps = entry.framesPerSecond ?? null;
      sample.reason = entry.qualityLimitationReason ?? 'none';
    }
    if (entry.type === 'remote-inbound-rtp') {
      sample.loss = (entry.fractionLost ?? 0) * 100;
      sample.rtt = (entry.roundTripTime ?? 0) * 1000;
    }
  }
  return sample;
};

const healthOf = (before, after, age) => {
  const seconds = (after.at - before.at) / 1000;
  const bits = Math.max(0, after.bytes - before.bytes) * 8;
  const mbps = seconds > 0 ? bits / seconds / 1e6 : 0;
  const warnings = [];
  const { reason, loss, fps } = after;
  if (reason === 'bandwidth' || reason === 'cpu') {
    warnings.push(`limited by ${reason}`);
  }
  if (loss > LOSS_LIMIT) warnings.push(`${Math.round(loss)}% loss`);
  if (age > WARM_MS && fps !== null && fps < FPS_LIMIT) {
    warnings.push(`${Math.round(fps)} fps`);
  }
  const live = ['LIVE', `${mbps.toFixed(1)} Mbps`];
  const text = live.concat(warnings).join(' · ');
  return { mbps, warnings, text };
};

const gathered = (connection, timeoutMs) =>
  new Promise((resolve) => {
    let timer = 0;
    const done = () => {
      if (connection.iceGatheringState !== 'complete') return;
      clearTimeout(timer);
      connection.removeEventListener('icegatheringstatechange', done);
      resolve();
    };
    timer = setTimeout(() => {
      connection.removeEventListener('icegatheringstatechange', done);
      resolve();
    }, timeoutMs);
    connection.addEventListener('icegatheringstatechange', done);
    done();
  });

const headersOf = (token, extra = {}) => {
  const headers = { ...extra };
  if (token) headers.Authorization = `Bearer ${token}`;
  return headers;
};

const timeoutOf = (ms) => globalThis.AbortSignal?.timeout?.(ms);

const preferCodecs = (transceiver, kind) => {
  const capabilities = globalThis.RTCRtpReceiver?.getCapabilities?.(kind);
  if (!capabilities || typeof transceiver.setCodecPreferences !== 'function') {
    return;
  }
  try {
    transceiver.setCodecPreferences(orderCodecs(capabilities.codecs, kind));
  } catch {
    return;
  }
};

const directErrorOf = (error) => {
  const isTimeout = error?.name === 'TimeoutError';
  const text = isTimeout ? 'no answer' : 'could not reach the endpoint';
  return new WhipError(text);
};

const relayErrorOf = (error) => {
  const code = error?.code;
  const message = error?.message || 'relay failed';
  if (code === 'stream/refused' || code === 'stream/forbidden') {
    return new WhipError(message, 0, '', true);
  }
  if (code === 'stream/failed') {
    return new WhipError('could not reach the endpoint');
  }
  return new WhipError(message);
};

const within = (promise, ms) => {
  let timer = 0;
  const limit = new Promise((resolve) => {
    timer = setTimeout(resolve, ms);
  });
  return Promise.race([promise, limit]).finally(() => clearTimeout(timer));
};

const limitSender = async (sender, bitrate) => {
  const params = sender.getParameters();
  if (!params.encodings?.length) params.encodings = [{}];
  params.encodings[0].maxBitrate = bitrate;
  params.encodings[0].maxFramerate = MAX_FRAMERATE;
  try {
    await sender.setParameters(params);
  } catch {
    return;
  }
};

class WhipStream {
  #destination = null;
  #tracks = null;
  #iceServers = null;
  #onChange = null;
  #onNotice = null;
  #relay = null;
  #connection = null;
  #location = '';
  #links = [];
  #failures = 0;
  #run = 0;
  #retryTimer = 0;
  #lostTimer = 0;
  #healthTimer = 0;
  #sample = null;
  #connectedAt = 0;
  #isRelayed = false;
  #isStopped = false;

  constructor({ destination, tracks, iceServers, ...hooks }) {
    this.#destination = destination;
    this.#tracks = tracks;
    this.#iceServers = iceServers;
    this.#onChange = hooks.onChange;
    this.#onNotice = hooks.onNotice;
    this.#relay = hooks.relay ?? null;
    this.id = destination.id;
    this.name = destination.name;
    this.state = 'idle';
    this.text = '';
  }

  get isActive() {
    return ['connecting', 'live', 'retrying'].includes(this.state);
  }

  start() {
    return this.#attempt();
  }

  async stop() {
    if (this.#isStopped) return;
    this.#isStopped = true;
    this.#run++;
    clearTimeout(this.#retryTimer);
    const gone = this.#drop();
    this.#set('stopped', '');
    await gone;
  }

  abandon() {
    if (this.#isStopped) return;
    this.#isStopped = true;
    this.#run++;
    const { token } = this.#destination;
    if (this.#location && !this.#isRelayed) {
      const headers = headersOf(token);
      fetch(this.#location, { method: 'DELETE', headers, keepalive: true })
        .then(() => undefined)
        .catch(() => undefined);
    }
    this.#clear();
    this.#connection?.close();
    this.#connection = null;
    this.#location = '';
  }

  #set(state, text) {
    this.state = state;
    this.text = text;
    this.#onChange?.(this);
  }

  #isCurrent(run) {
    return run === this.#run && !this.#isStopped;
  }

  #clear() {
    clearTimeout(this.#lostTimer);
    clearInterval(this.#healthTimer);
    this.#lostTimer = 0;
    this.#healthTimer = 0;
    this.#sample = null;
  }

  #drop() {
    this.#clear();
    this.#connection?.close();
    this.#connection = null;
    const location = this.#location;
    this.#location = '';
    if (!location) return Promise.resolve();
    const { token } = this.#destination;
    if (this.#isRelayed) {
      const request = this.#relay({ action: 'delete', location, token });
      return within(request, DELETE_MS)
        .then(() => undefined)
        .catch(() => undefined);
    }
    const headers = headersOf(token);
    const signal = timeoutOf(DELETE_MS);
    return fetch(location, { method: 'DELETE', headers, signal })
      .then(() => undefined)
      .catch(() => undefined);
  }

  async #attempt() {
    const run = ++this.#run;
    this.#set('connecting', 'connecting');
    try {
      const servers = await this.#iceServers();
      if (!this.#isCurrent(run)) return;
      const Connection = globalThis.RTCPeerConnection;
      const iceServers = servers.concat(this.#links);
      const connection = new Connection({ iceServers });
      this.#connection = connection;
      connection.addEventListener('connectionstatechange', () => {
        this.#onState(run, connection);
      });
      const senders = this.#addTracks(connection);
      await connection.setLocalDescription(await connection.createOffer());
      await gathered(connection, GATHER_MS);
      if (!this.#isCurrent(run)) return;
      const sdp = await this.#post(connection.localDescription.sdp);
      if (!this.#isCurrent(run)) return void this.#drop();
      await connection.setRemoteDescription({ type: 'answer', sdp });
      if (!this.#isCurrent(run)) return;
      const { bitrate } = this.#destination;
      if (senders.video) await limitSender(senders.video, bitrate);
      if (connection.connectionState === 'connected') this.#onState(run);
    } catch (error) {
      if (this.#isCurrent(run)) await this.#fail(run, error);
    }
  }

  #addTracks(connection) {
    const senders = {};
    for (const track of this.#tracks) {
      const direction = 'sendonly';
      const transceiver = connection.addTransceiver(track, { direction });
      preferCodecs(transceiver, track.kind);
      senders[track.kind] = transceiver.sender;
    }
    return senders;
  }

  async #post(offer) {
    const { url } = this.#destination;
    const reply = this.#isRelayed
      ? await this.#relayOffer(offer)
      : await this.#directOffer(offer);
    if (reply.status !== 201) {
      const { status, statusText } = reply;
      throw new WhipError(`HTTP ${status}`, status, statusText);
    }
    this.#location = locationOf(reply.location, url);
    this.#links = iceServersOf(reply.links);
    if (!reply.sdp.trim()) throw new WhipError('empty answer');
    return reply.sdp;
  }

  async #directOffer(offer) {
    const { url, token } = this.#destination;
    const type = { 'Content-Type': 'application/sdp' };
    const headers = headersOf(token, type);
    const signal = timeoutOf(POST_MS);
    let response = null;
    try {
      const body = offer;
      response = await fetch(url, { method: 'POST', headers, body, signal });
    } catch (error) {
      if (!this.#relay) throw directErrorOf(error);
      this.#isRelayed = true;
      return this.#relayOffer(offer);
    }
    const { status, statusText } = response;
    const location = response.headers.get('Location');
    const links = response.headers.get('Link');
    const sdp = status === 201 ? await response.text() : '';
    return { status, statusText, location, links, sdp };
  }

  async #relayOffer(offer) {
    const { url, token } = this.#destination;
    let reply = null;
    try {
      reply = await this.#relay({ action: 'offer', url, token, sdp: offer });
    } catch (error) {
      throw relayErrorOf(error);
    }
    const { status, location } = reply;
    const links = (reply.links ?? []).join(', ');
    return { status, statusText: '', location, links, sdp: reply.sdp ?? '' };
  }

  #onState(run, connection = this.#connection) {
    if (!this.#isCurrent(run) || connection !== this.#connection) return;
    const state = connection.connectionState;
    if (state === 'connected') return void this.#connected(run);
    clearTimeout(this.#lostTimer);
    this.#lostTimer = 0;
    if (state === 'failed') {
      this.#fail(run, new WhipError('connection failed'));
    } else if (state === 'disconnected') {
      this.#lostTimer = setTimeout(() => {
        const error = new WhipError('connection lost');
        if (this.#isCurrent(run)) this.#fail(run, error);
      }, LOST_MS);
    }
  }

  #connected(run) {
    clearTimeout(this.#lostTimer);
    this.#lostTimer = 0;
    if (this.#healthTimer) return;
    this.#failures = 0;
    this.#connectedAt = performance.now();
    this.#set('live', 'LIVE');
    this.#poll(run);
    this.#healthTimer = setInterval(() => this.#poll(run), HEALTH_MS);
  }

  async #poll(run) {
    const connection = this.#connection;
    if (!connection) return;
    let report = null;
    try {
      report = await connection.getStats();
    } catch {
      return;
    }
    if (!this.#isCurrent(run) || connection !== this.#connection) return;
    const sample = sampleOf([...report.values()], performance.now());
    const before = this.#sample;
    this.#sample = sample;
    if (!before) return;
    const health = healthOf(before, sample, sample.at - this.#connectedAt);
    this.#set('live', health.text);
  }

  async #fail(run, error) {
    this.#run++;
    const verdict = verdictOf(error);
    const gone = this.#drop();
    if (!verdict.retry) {
      this.#set('failed', `failed: ${verdict.reason}`);
      await gone;
      return;
    }
    const failures = ++this.#failures;
    const step = retryOf(failures);
    if (step.stop) {
      this.#set('failed', `failed: ${verdict.reason}`);
      this.#onNotice?.(giveUpText(this.name));
      await gone;
      return;
    }
    const next = this.#run;
    this.#set('retrying', retryText(failures, step.delay));
    this.#retryTimer = setTimeout(() => {
      if (next === this.#run && !this.#isStopped) this.#attempt();
    }, step.delay);
    await gone;
  }
}

export { STORAGE_KEY, NAME_LENGTH, DEFAULT_BITRATE, MAX_ENABLED };
export { MIN_BITRATE, MAX_BITRATE, MAX_ATTEMPTS };
export { WhipError, WhipStream };
export { isEndpointUrl, problemOf, destinationOf, destinationsOf };
export { readDestinations, writeDestinations };
export { orderCodecs, iceServersOf, locationOf };
export { isRetryStatus, verdictOf, retryOf, retryText, giveUpText };
export { sampleOf, healthOf };
