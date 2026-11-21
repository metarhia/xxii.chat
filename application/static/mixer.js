import { choose, flagOf } from './layout.js';
import { idOf } from './members.js';

const CLOCK_URL = new URL('./clock-worker.js', import.meta.url);
const CLOCK_FPS = 30;
const SAMPLE_RATE = 48000;
const RAMP_SECONDS = 0.05;
const MUSIC_FADE_SECONDS = 1;
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
  if (entry.optOut || entry.stage === false) return 0;
  const isMic = entry.kind === 'mic';
  if (isMic && entry.local && !mix.includeMe) return 0;
  if (!isMic && !mix.screenAudio) return 0;
  const isShown = onScreen.has(entry.shownId);
  if (!isMic && isShown) return 1;
  return RULES[mix.audio](isShown, volumeOf(mix.volumes, entry.endpoint));
};

const audioSourcesOf = (members, options, onScreen) => {
  const mix = mixOf(options);
  const slate = options?.studio?.activeScene?.type;
  const isSlate = Boolean(slate && slate !== 'live');
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
        stage: member.stage,
        shownId: idOf(member.endpoint, slot.shows),
      };
      sources.push({
        id: idOf(member.endpoint, slot.kind),
        endpoint: member.endpoint,
        kind: slot.kind,
        track: member.optOut || member.stage === false ? null : track,
        gain: isSlate ? 0 : gainOf(entry, mix, onScreen),
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

const rampTo = (param, value, now, seconds) => {
  if (typeof param.cancelAndHoldAtTime === 'function') {
    param.cancelAndHoldAtTime(now);
  } else {
    const current = param.value;
    param.cancelScheduledValues(now);
    param.setValueAtTime(current, now);
  }
  param.linearRampToValueAtTime(value, now + seconds);
};

const releaseMusic = (entry) => {
  entry.media.pause();
  entry.media.removeAttribute('src');
  entry.media.load();
  URL.revokeObjectURL(entry.url);
  disconnectNode(entry.source);
  disconnectNode(entry.gain);
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
  #music = new Map();
  #currentMusic = '';
  #clip = null;
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
    this.#clearMusic();
    this.#dropClip();
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
      const options = this.#options();
      this.#sync(audioSourcesOf(members, options, onScreen));
      const studio = options?.studio;
      if (studio) this.#syncMusic(studio);
      else if (this.#currentMusic || this.#music.size) this.#clearMusic();
      this.#syncClip(studio);
      this.error = null;
    } catch (error) {
      this.error = error;
    }
  }

  #syncClip(studio) {
    const clip = studio?.clip;
    if (this.#clip?.clip === clip) {
      if (clip) this.#gains.set(clip.id, 1);
      return;
    }
    this.#dropClip();
    if (!clip) return;
    try {
      const { context } = this;
      if (typeof context.createMediaElementSource !== 'function') {
        throw new Error('Program clip audio is unavailable');
      }
      this.#clip = clip.route((media) => {
        const source = context.createMediaElementSource(media);
        const gain = context.createGain();
        gain.gain.value = 1;
        source.connect(gain).connect(this.#chain.master);
        return { clip, media, source, gain };
      });
      this.#gains.set(clip.id, 1);
    } catch (error) {
      studio.clipFailed(error);
    }
  }

  #dropClip() {
    const entry = this.#clip;
    if (!entry) return;
    this.#clip = null;
    this.#gains.delete(entry.clip.id);
    disconnectNode(entry.source);
    disconnectNode(entry.gain);
    entry.clip.preview(entry.media);
  }

  #clearMusic() {
    this.#currentMusic = '';
    for (const entry of this.#music.values()) releaseMusic(entry);
    this.#music.clear();
  }

  #syncMusic(studio) {
    const music = studio.music;
    const id = music?.checksum ?? '';
    const now = this.#context.currentTime;
    if (this.#currentMusic !== id) {
      const leaving = this.#music.get(this.#currentMusic);
      if (leaving) {
        rampTo(leaving.gain.gain, 0, now, MUSIC_FADE_SECONDS);
        leaving.until = now + MUSIC_FADE_SECONDS;
      }
      this.#currentMusic = id;
      if (music) {
        try {
          const entry = this.#music.get(id) ?? this.#attachMusic(music, studio);
          entry.until = Infinity;
          entry.target = music.volume;
          rampTo(entry.gain.gain, music.volume, now, MUSIC_FADE_SECONDS);
        } catch (error) {
          studio.musicFailed(error);
        }
      }
    }
    for (const [id, entry] of this.#music) {
      if (entry.until <= now) {
        releaseMusic(entry);
        this.#music.delete(id);
      }
    }
    const entry = this.#music.get(id);
    if (!entry || entry.target === music.volume) return;
    entry.target = music.volume;
    rampTo(entry.gain.gain, entry.target, now, RAMP_SECONDS);
  }

  #attachMusic(music, studio) {
    const context = this.#context;
    if (typeof context.createMediaElementSource !== 'function') {
      throw new Error('Program music is unavailable');
    }
    const media = document.createElement('audio');
    const source = context.createMediaElementSource(media);
    const gain = context.createGain();
    gain.gain.value = 0;
    source.connect(gain).connect(this.#chain.master);
    media.loop = true;
    const url = URL.createObjectURL(music.blob);
    media.src = url;
    const entry = { media, source, gain, url, until: 0, target: 0 };
    this.#music.set(music.checksum, entry);
    media.play().catch((error) => {
      const isCurrent = this.#currentMusic === music.checksum;
      if (isCurrent && this.#music.get(music.checksum) === entry) {
        studio.musicFailed(error);
      }
    });
    return entry;
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
