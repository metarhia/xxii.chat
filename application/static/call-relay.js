import * as logic from './relay-logic.js';

const {
  RELAY_WIDTH,
  RELAY_HEIGHT,
  RELAY_FPS,
  needsRelay,
  relayCandidates,
  relayDenial,
  readRelayMessage,
  relayVideoSource,
  relaySlot,
  relayVideoEncoding,
} = logic;

const SOUND_MS = 2500;
const HINT_OWNER = 'peer-relay';
const VIDEO_SLOTS = ['camera', 'screen'];
const VIDEO_NOTICE = 'The browser could not limit forwarded video.';
const VIDEO_WORK = new WeakMap();

const liveTrack = (link, slot) => {
  const track = link.receiver(slot)?.track;
  return track?.readyState === 'live' ? track : null;
};

const canPlay = () => {
  const audio = globalThis.HTMLMediaElement?.prototype;
  return typeof audio?.play === 'function' && typeof MediaStream === 'function';
};

const stopPlayback = (element) => {
  if (!element) return;
  element.pause();
  element.srcObject = null;
  element.remove();
};

const playMic = async (audio) => {
  let timer = null;
  const expired = new Promise((resolve, reject) => {
    const fail = () => reject(new Error('Audio playback timed out'));
    timer = setTimeout(fail, SOUND_MS);
  });
  try {
    await Promise.race([audio.play(), expired]);
  } finally {
    clearTimeout(timer);
  }
};

class RelaySource {
  constructor(source, target, soundFailed) {
    this.source = source;
    this.target = target;
    this.soundFailed = soundFailed;
    this.audio = null;
    this.mic = null;
    this.micReady = Promise.resolve();
    this.video = null;
    this.picture = null;
    this.videoSize = '';
    this.closed = false;
    this.onResize = () => this.updateVideo();
  }

  refresh(person) {
    if (this.closed) return this.micReady;
    const received = liveTrack(this.source, 'mic');
    const mic = received?.muted && received !== this.mic ? null : received;
    const slot = relayVideoSource(person);
    const picture = slot ? liveTrack(this.source, slot) : null;
    if (mic !== this.mic) this.setMic(mic);
    if (this.closed) return this.micReady;
    if (picture !== this.picture) this.watchVideo(picture);
    this.updateVideo();
    return this.micReady;
  }

  setMic(track) {
    stopPlayback(this.audio);
    this.audio = null;
    this.mic = track;
    this.clear('relayAudio');
    this.micReady = track ? this.startMic(track) : Promise.resolve();
  }

  async startMic(track) {
    const audio = document.createElement('audio');
    audio.volume = 0;
    audio.hidden = true;
    this.audio = audio;
    try {
      if (audio.volume !== 0) throw new Error('Silent playback is unavailable');
      audio.srcObject = new MediaStream([track]);
      document.body.append(audio);
      await playMic(audio);
      if (this.audio === audio) await this.target.setTrack('relayAudio', track);
    } catch {
      if (this.audio === audio) this.soundFailed(this);
    }
  }

  watchVideo(track) {
    this.video?.removeEventListener('resize', this.onResize);
    stopPlayback(this.video);
    this.video = null;
    this.picture = track;
    this.videoSize = '';
    this.clear('relayVideo');
    if (!track) return;
    const video = document.createElement('video');
    video.muted = true;
    video.hidden = true;
    video.playsInline = true;
    video.srcObject = new MediaStream([track]);
    video.addEventListener('resize', this.onResize);
    document.body.append(video);
    video.play().catch(() => undefined);
    this.video = video;
  }

  updateVideo() {
    const track = this.picture;
    if (!track || this.closed) return;
    const settings = track.getSettings?.() ?? {};
    const width = this.video?.videoWidth || settings.width;
    const height = this.video?.videoHeight || settings.height;
    const size = `${width}x${height}`;
    if (this.videoSize === size) return;
    const encoding = relayVideoEncoding(width, height);
    if (!encoding) return;
    this.videoSize = size;
    const previous = VIDEO_WORK.get(this.target) ?? Promise.resolve();
    const next = this.limitVideo(previous, track, size, encoding);
    VIDEO_WORK.set(this.target, next);
  }

  async limitVideo(previous, track, size, encoding) {
    await previous;
    const same = () => this.picture === track && this.videoSize === size;
    if (this.closed || !same()) return;
    try {
      const sender = this.target.sender('relayVideo');
      const parameters = sender.getParameters();
      if (!parameters.encodings?.length) throw new Error(VIDEO_NOTICE);
      parameters.encodings = parameters.encodings.map((item) => ({
        ...item,
        ...encoding,
      }));
      await sender.setParameters(parameters);
      if (this.closed || !same()) return;
      if (sender.track !== track) {
        await this.target.setTrack('relayVideo', track);
      }
    } catch {
      if (this.closed || !same()) return;
      this.clear('relayVideo');
      this.target.policy.notice(VIDEO_NOTICE);
    }
  }

  clear(slot) {
    this.target.setTrack(slot, null).catch(() => undefined);
  }

  close() {
    this.closed = true;
    stopPlayback(this.audio);
    this.audio = null;
    this.watchVideo(null);
    this.clear('relayAudio');
  }
}

class PeerRelay {
  #session = null;
  #links = null;
  #people = [];
  #served = null;
  #routes = new Map();
  #requests = new Map();
  #soundBlocked = false;

  constructor(session, links) {
    this.#session = session;
    this.#links = links;
  }

  get #local() {
    return this.#session.endpoint;
  }

  get forwarding() {
    const pair = this.#served;
    return pair?.assigned ? { from: pair.from, to: pair.to } : null;
  }

  get soundBlocked() {
    return this.#soundBlocked;
  }

  enableSound() {
    this.#soundBlocked = false;
  }

  blockSound() {
    const pair = this.#served;
    if (pair) return void this.#onSoundFailed(pair);
    this.#soundBlocked = true;
  }

  route(endpoint) {
    return this.#routes.get(endpoint)?.relay ?? '';
  }

  receiver(endpoint, slot) {
    const relay = this.route(endpoint);
    if (!relay || !['mic', 'camera', 'screen', 'screenAudio'].includes(slot)) {
      return this.#links.get(endpoint)?.receiver(slot) ?? null;
    }
    const source = relaySlot(this.#person(endpoint), slot);
    if (!source) return null;
    return this.#links.get(relay)?.receiver(source) ?? null;
  }

  update(people) {
    this.#people = people ?? [];
    const pair = this.#served;
    if (pair && !this.#joined(pair)) this.#release(pair, 'not-joined');
    for (const item of this.#routes.values()) {
      const absent = !this.#joined(item) || !this.#person(item.relay);
      if (absent) this.#endRoute(item);
    }
    for (const item of this.#requests.values()) {
      if (!this.#joined(item) || !this.#person(item.relay)) this.#cancel(item);
    }
    this.refresh();
  }

  refresh() {
    const pair = this.#served;
    if (!pair) return;
    pair.left.refresh(this.#person(pair.from));
    if (this.#served === pair) pair.right.refresh(this.#person(pair.to));
  }

  failed(endpoint, count) {
    if (!needsRelay(this.#local, endpoint, count)) return;
    if (this.#routes.has(endpoint)) return;
    const pending = this.#requests.get(endpoint);
    if (pending) this.#cancel(pending);
    const from = this.#local;
    const to = endpoint;
    if (!this.#joined({ from, to })) return;
    const connected = (peer) => this.#linked(peer);
    const candidates = relayCandidates(this.#people, from, to, connected);
    this.#ask({ from, to, candidates, relay: '' });
  }

  connected(endpoint) {
    const route = this.#routes.get(endpoint);
    const request = this.#requests.get(endpoint);
    if (route) this.#endRoute(route);
    if (request) this.#cancel(request);
  }

  disconnected(endpoint) {
    const pair = this.#served;
    if (pair && (pair.from === endpoint || pair.to === endpoint)) {
      this.#release(pair, 'not-linked');
    }
    for (const route of this.#routes.values()) {
      if (route.relay === endpoint) this.#endRoute(route);
    }
    for (const request of this.#requests.values()) {
      if (request.relay !== endpoint) continue;
      this.#requests.delete(request.to);
      this.#ask(request);
    }
  }

  receive(sender, data) {
    const message = readRelayMessage(data, this.#local, sender);
    if (!message || !this.#linked(sender) || !this.#person(sender)) return;
    const { action, from, to, peer } = message;
    if (action === 'ask') return void this.#accept(message);
    const pair = this.#served;
    if (action === 'stop' && pair?.from === from && pair.to === to) {
      return void this.#release(pair);
    }
    const pending = this.#requests.get(to);
    if (action === 'deny' && pending?.relay === sender) {
      this.#requests.delete(to);
      return void this.#ask(pending);
    }
    if (action === 'assign') return void this.#assign(sender, message, pending);
    const route = this.#routes.get(peer);
    if (action === 'release' && route?.relay === sender) {
      this.#endRoute(route, false);
    }
  }

  close() {
    if (this.#served) this.#release(this.#served);
    for (const route of this.#routes.values()) this.#endRoute(route);
    for (const request of this.#requests.values()) this.#cancel(request);
    this.#people = [];
    this.#soundBlocked = false;
  }

  #person(endpoint) {
    return this.#people.find((person) => person.endpoint === endpoint);
  }

  #joined({ from, to }) {
    if (!this.#person(this.#local)) return false;
    return Boolean(this.#person(from) && this.#person(to));
  }

  #linked(endpoint) {
    return this.#links.get(endpoint)?.connected === true;
  }

  #send(endpoint, action, pair, extra = {}) {
    const { from, to } = pair;
    const message = { type: 'relay', action, from, to, ...extra };
    try {
      this.#session.send(endpoint, message);
    } catch {
      return;
    }
  }

  #ask(request) {
    const { to, candidates } = request;
    if (!this.#joined(request) || this.#linked(to)) return;
    while (candidates.length > 0) {
      const relay = candidates.shift();
      if (!this.#linked(relay) || !this.#person(relay)) continue;
      request.relay = relay;
      this.#requests.set(to, request);
      this.#send(relay, 'ask', request);
      return;
    }
  }

  #cancel(request) {
    this.#requests.delete(request.to);
    this.#send(request.relay, 'stop', request);
  }

  #assign(relay, message, pending) {
    const { from, to, peer } = message;
    const expected = this.#local === to || pending?.relay === relay;
    const existing = this.#routes.get(peer);
    if (existing?.relay === relay) return;
    if (!expected || existing || !this.#joined(message) || this.#linked(peer)) {
      return void this.#send(relay, 'stop', message);
    }
    if (pending && this.#local === from) this.#requests.delete(to);
    this.#routes.set(peer, { from, to, relay, peer });
    this.#session.emit('relay', peer);
  }

  #endRoute(route, notify = true) {
    this.#routes.delete(route.peer);
    if (notify) this.#send(route.relay, 'stop', route);
    this.#session.emit('relay', route.peer);
  }

  async #accept(message) {
    const { from, to } = message;
    const first = this.#links.get(from);
    const second = this.#links.get(to);
    const linked = Boolean(first?.connected && second?.connected);
    const reason = relayDenial({
      joined: this.#joined(message),
      linked,
      busy: this.#served !== null,
      blocked: this.#soundBlocked || !canPlay(),
    });
    if (reason) {
      if (reason === 'no-sound' && !this.#soundBlocked) {
        this.#session.emit('notice', 'This browser cannot play relay audio.');
      }
      return void this.#send(from, 'deny', message, { reason });
    }
    const failed = (source) => {
      const pair = this.#served;
      if (pair?.left === source || pair?.right === source) {
        this.#onSoundFailed(pair);
      }
    };
    const pair = {
      from,
      to,
      assigned: false,
      left: new RelaySource(first, second, failed),
      right: new RelaySource(second, first, failed),
    };
    this.#served = pair;
    for (const endpoint of [from, to]) {
      for (const slot of VIDEO_SLOTS) {
        this.#session.setViewHint(
          endpoint,
          {
            slot,
            width: RELAY_WIDTH,
            height: RELAY_HEIGHT,
            fps: RELAY_FPS,
          },
          HINT_OWNER,
        );
      }
    }
    const left = pair.left.refresh(this.#person(from));
    if (this.#served !== pair) return;
    const right = pair.right.refresh(this.#person(to));
    await Promise.all([left, right]);
    if (this.#served !== pair) return;
    pair.assigned = true;
    this.#send(from, 'assign', pair, { peer: to });
    this.#send(to, 'assign', pair, { peer: from });
    this.#session.emit('relay');
  }

  #onSoundFailed(pair) {
    if (this.#served !== pair) return;
    this.#soundBlocked = true;
    this.#release(pair, 'no-sound');
  }

  #release(pair, reason) {
    this.#served = null;
    pair.left.close();
    pair.right.close();
    this.#session.releaseViewHints(HINT_OWNER);
    const { from, to } = pair;
    if (pair.assigned) {
      this.#send(from, 'release', pair, { peer: to });
      this.#send(to, 'release', pair, { peer: from });
    } else if (reason) {
      this.#send(from, 'deny', pair, { reason });
    }
    this.#session.emit('relay');
  }
}

export { PeerRelay };
