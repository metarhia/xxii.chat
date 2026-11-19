import { choose, flagOf } from './layout.js';
import { idOf } from './members.js';

const CLOCK_URL = new URL('./clock-worker.js', import.meta.url);
const CLOCK_FPS = 30;
const SAMPLE_RATE = 48000;
const RAMP_SECONDS = 0.05;
const DUCK = 0.125;
const MAX_VOLUME = 2;
const AUDIO = ['all', 'onScreen', 'duck', 'custom'];
const SLOTS = [
  { kind: 'mic', shows: 'camera' },
  { kind: 'screenAudio', shows: 'screen' },
];

const RULES = {
  all: () => 1,
  onScreen: (isShown) => (isShown ? 1 : 0),
  duck: (isShown) => (isShown ? 1 : DUCK),
  custom: (isShown, volume) => volume,
};

const isRecord = (value) => typeof value === 'object' && value !== null;

const mixOf = (options) => {
  const input = options ?? {};
  return {
    audio: choose(input.audio, AUDIO, 'all'),
    includeMe: flagOf(input.includeMe, true),
    screenAudio: flagOf(input.screenAudio, true),
    volumes: isRecord(input.volumes) ? input.volumes : {},
  };
};

const volumeOf = (volumes, endpoint) => {
  const value = Object.hasOwn(volumes, endpoint) ? volumes[endpoint] : 1;
  if (!Number.isFinite(value)) return 1;
  return Math.min(MAX_VOLUME, Math.max(0, value));
};

const gainOf = (entry, mix, onScreen) => {
  if (entry.optOut) return 0;
  const isMic = entry.kind === 'mic';
  if (isMic && entry.local && !mix.includeMe) return 0;
  if (!isMic && !mix.screenAudio) return 0;
  const isShown = onScreen.has(entry.shownId);
  if (!isMic && isShown) return 1;
  return RULES[mix.audio](isShown, volumeOf(mix.volumes, entry.endpoint));
};

const audioSourcesOf = (members, options, onScreen) => {
  const mix = mixOf(options);
  const sources = [];
  for (const member of members) {
    for (const slot of SLOTS) {
      const track = member[slot.kind];
      if (!track) continue;
      const entry = {
        endpoint: member.endpoint,
        kind: slot.kind,
        local: member.local,
        optOut: member.optOut,
        shownId: idOf(member.endpoint, slot.shows),
      };
      sources.push({
        id: idOf(member.endpoint, slot.kind),
        endpoint: member.endpoint,
        kind: slot.kind,
        track: member.optOut ? null : track,
        gain: gainOf(entry, mix, onScreen),
      });
    }
  }
  return sources;
};

const createContext = () => {
  const Context = globalThis.AudioContext ?? globalThis.webkitAudioContext;
  if (!Context) throw new Error('Audio mixing is unavailable');
  return new Context({ sampleRate: SAMPLE_RATE });
};

const createMaster = (context) => {
  const master = context.createDynamicsCompressor();
  master.threshold.value = -18;
  master.ratio.value = 4;
  const limiter = context.createDynamicsCompressor();
  limiter.threshold.value = -1;
  limiter.ratio.value = 20;
  const output = context.createMediaStreamDestination();
  master.connect(limiter);
  limiter.connect(output);
  return { master, limiter, output };
};

const disconnectNode = (node) => {
  try {
    node.disconnect();
  } catch {
    return;
  }
};

class Mixer {
  #members = null;
  #options = null;
  #onScreen = null;
  #shared = null;
  #worker = null;
  #listener = null;
  #context = null;
  #chain = null;
  #nodes = new Map();
  #gains = new Map();
  #isStopped = false;

  constructor({ members, options, onScreen, clock = null }) {
    this.#members = members;
    this.#options = options ?? (() => ({}));
    this.#onScreen = onScreen ?? (() => new Set());
    this.#shared = clock;
    this.error = null;
    this.#context = createContext();
    this.#chain = createMaster(this.#context);
    this.stream = this.#chain.output.stream;
    this.track = this.stream.getAudioTracks()[0];
  }

  get context() {
    return this.#context;
  }

  get gains() {
    return new Map(this.#gains);
  }

  start() {
    if (this.#listener || this.#isStopped) return;
    const worker = this.#shared ?? new Worker(CLOCK_URL);
    this.#worker = worker;
    this.#listener = ({ data }) => {
      if (data.type === 'tick') this.update();
    };
    worker.addEventListener('message', this.#listener);
    if (!this.#shared) worker.postMessage({ type: 'start', fps: CLOCK_FPS });
    const context = this.#context;
    if (context.state === 'suspended') context.resume().catch(() => undefined);
    this.update();
  }

  stop() {
    if (this.#isStopped) return;
    this.#isStopped = true;
    const worker = this.#worker;
    if (worker) worker.removeEventListener('message', this.#listener);
    if (worker && !this.#shared) {
      worker.postMessage({ type: 'stop' });
      worker.terminate();
    }
    for (const id of Array.from(this.#nodes.keys())) this.#drop(id);
    this.#gains.clear();
    disconnectNode(this.#chain.master);
    disconnectNode(this.#chain.limiter);
    this.track.stop();
    this.#context.close().catch(() => undefined);
    this.#worker = null;
    this.#listener = null;
  }

  update() {
    if (this.#isStopped) return;
    try {
      const members = this.#members();
      const onScreen = this.#onScreen();
      this.#sync(audioSourcesOf(members, this.#options(), onScreen));
      this.error = null;
    } catch (error) {
      this.error = error;
    }
  }

  #sync(sources) {
    const seen = new Set();
    for (const source of sources) {
      seen.add(source.id);
      this.#gains.set(source.id, source.gain);
      this.#apply(source);
    }
    for (const id of Array.from(this.#nodes.keys())) {
      if (!seen.has(id)) this.#drop(id);
    }
    for (const id of Array.from(this.#gains.keys())) {
      if (!seen.has(id)) this.#gains.delete(id);
    }
  }

  #apply(source) {
    let node = this.#nodes.get(source.id) ?? null;
    if (node && node.track !== source.track) {
      this.#drop(source.id);
      node = null;
    }
    if (!source.track) return;
    if (!node) node = this.#attach(source);
    if (node.target === source.gain) return;
    node.target = source.gain;
    const time = this.#context.currentTime;
    node.gain.gain.setTargetAtTime(source.gain, time, RAMP_SECONDS);
  }

  #attach(source) {
    const context = this.#context;
    const stream = new MediaStream([source.track]);
    const input = context.createMediaStreamSource(stream);
    const gain = context.createGain();
    gain.gain.value = source.gain;
    input.connect(gain);
    gain.connect(this.#chain.master);
    const node = { track: source.track, input, gain, target: source.gain };
    this.#nodes.set(source.id, node);
    return node;
  }

  #drop(id) {
    const node = this.#nodes.get(id);
    if (!node) return;
    disconnectNode(node.input);
    disconnectNode(node.gain);
    this.#nodes.delete(id);
  }
}

export { mixOf, volumeOf, gainOf, audioSourcesOf, Mixer };
