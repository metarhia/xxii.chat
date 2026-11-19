import { Compositor } from './compositor.js';
import { generateUUID } from './metautil.js';
import { Mixer } from './mixer.js';
import { membersOf } from './members.js';
import { Recorder, RecordingWriter } from './recorder.js';
import { qualityOf } from './layout.js';
import { titleOf, spaceOf } from './recording-files.js';
import { defaultsOf, valueOf, paintRecordControl } from './record-panel.js';

const CLOCK_URL = new URL('./clock-worker.js', import.meta.url);
const TICK_FPS = 2;
const SPACE_TICKS = 20;
const PERSIST_KEY = 'xxii:storage-persist';
const HINT_OWNER = 'recorder';
const HINT_STEP = 40;
const HINT_FPS = 30;
const KIBIBYTE = 1024;
const SIZE_UNITS = ['B', 'KB', 'MB', 'GB', 'TB'];
const SECOND_MS = 1000;
const MINUTE_SECONDS = 60;
const HOUR_SECONDS = 3600;
const DEFAULT_SETTINGS = ['people', 'audio', 'quality'];
const LOW_SPACE = 'Less than 2 GB of free space, the recording may stop early';
const FULL_SPACE = 'Less than 500 MB of free space. Free some space first';

const pad = (value) => `${value}`.padStart(2, '0');

const timeText = (ms) => {
  const total = Math.max(0, Math.floor(ms / SECOND_MS));
  const hours = Math.floor(total / HOUR_SECONDS);
  const minutes = Math.floor((total % HOUR_SECONDS) / MINUTE_SECONDS);
  const seconds = total % MINUTE_SECONDS;
  const base = `${pad(minutes)}:${pad(seconds)}`;
  return hours > 0 ? `${hours}:${base}` : base;
};

const sizeText = (bytes) => {
  let value = Math.max(0, bytes);
  let unit = 0;
  while (value >= KIBIBYTE && unit < SIZE_UNITS.length - 1) {
    value /= KIBIBYTE;
    unit++;
  }
  const digits = unit < 2 ? 0 : 1;
  return `${value.toFixed(digits)} ${SIZE_UNITS[unit]}`;
};

const hintOf = (tile, local) => {
  const split = tile.id.lastIndexOf('/');
  const endpoint = tile.id.slice(0, split);
  const slot = tile.id.slice(split + 1);
  const isMedia = slot === 'camera' || slot === 'screen';
  if (!isMedia || endpoint === local) return null;
  const isVideo = tile.placeholder === '';
  const width = isVideo ? Math.ceil(tile.width / HINT_STEP) * HINT_STEP : 0;
  const height = isVideo ? Math.ceil(tile.height / HINT_STEP) * HINT_STEP : 0;
  const fps = isVideo ? HINT_FPS : 0;
  return { endpoint, slot, width, height, fps };
};

const keyOf = (hint) => `${hint.endpoint}\n${hint.slot}`;

const demandsOf = (tiles, local) => {
  const demands = new Map();
  for (const tile of tiles) {
    const hint = hintOf(tile, local);
    if (hint) demands.set(keyOf(hint), hint);
  }
  return demands;
};

const textOf = (hint) => `${hint.width}x${hint.height}@${hint.fps}`;

const askPersistence = async (storage) => {
  try {
    if (localStorage.getItem(PERSIST_KEY)) return;
    localStorage.setItem(PERSIST_KEY, 'asked');
  } catch {
    return;
  }
  try {
    if (await storage.persisted?.()) return;
    await storage.persist?.();
  } catch {
    return;
  }
};

const report = (stage, error) => stage.hooks.fail(error);

class CallRecording {
  #stage = null;
  #recorder = null;
  #writer = null;
  #mixer = null;
  #compositor = null;
  #clock = null;
  #onClock = null;
  #current = null;
  #defaults = null;
  #sent = new Map();
  #names = new Set();
  #imageUrl = '';
  #ticks = 0;
  #isPanel = false;
  #isFlagged = false;
  #isStarting = false;
  #isStopping = false;
  #isDisposed = false;
  #isWarned = false;

  constructor(stage, settings) {
    this.#stage = stage;
    this.#defaults = defaultsOf(settings);
    this.options = defaultsOf(settings);
    this.image = null;
    this.notice = '';
  }

  get isActive() {
    return this.#recorder !== null;
  }

  get recorder() {
    return this.#recorder;
  }

  get compositor() {
    return this.#compositor;
  }

  get mixer() {
    return this.#mixer;
  }

  members() {
    const stage = this.#stage;
    const session = stage.session;
    const state = {
      endpoint: session?.endpoint ?? '',
      nick: stage.hooks.nick(),
      people: stage.people,
      remote: stage.remote,
      media: stage.media,
      speech: stage.levels?.state.participants,
    };
    return membersOf(state);
  }

  programOptions() {
    const background = this.image ?? (this.options.background || undefined);
    return { ...this.options, background };
  }

  paint() {
    const stage = this.#stage;
    const host = stage.host;
    if (!host || this.#isDisposed) return;
    const isOpen = this.#isOpen();
    this.#syncPreview(isOpen);
    const recorder = this.#recorder;
    const state = recorder ? recorder.state : 'idle';
    const time = timeText(recorder?.activeMs ?? 0);
    const size = sizeText(recorder?.size ?? 0);
    const people = this.members().filter((member) => !member.local);
    const isBusy = this.#isStarting || this.#isStopping;
    const text = `${time} · ${size}`;
    const { options, notice } = this;
    const view = { state, text, options, people, notice, isOpen, isBusy };
    paintRecordControl(host, view);
    const preview = host.querySelector('.record-preview');
    const canvas = this.#compositor?.canvas ?? null;
    if (!preview || preview.firstChild === canvas) return;
    if (canvas) preview.replaceChildren(canvas);
    else preview.replaceChildren();
  }

  togglePanel() {
    const stage = this.#stage;
    if (stage.mode !== 'call') return;
    if (stage.phone?.matches === true) {
      if (stage.sheet === 'record') stage.closeSheet();
      else stage.openSheet('record');
    } else {
      this.#isPanel = !this.#isPanel;
    }
    this.paint();
  }

  closePanel() {
    const stage = this.#stage;
    const isPhone = stage.phone?.matches === true;
    if (isPhone || !this.#isPanel || stage.mode !== 'call') return false;
    this.#isPanel = false;
    this.paint();
    return true;
  }

  toggle() {
    if (this.isActive) return this.stop();
    return this.start();
  }

  togglePause() {
    const recorder = this.#recorder;
    if (!recorder) return;
    if (recorder.state === 'paused') recorder.resume();
    else recorder.pause();
    this.paint();
  }

  change(control) {
    const { record, pin, volume } = control.dataset;
    if (pin) return void this.#pin(pin, control.checked);
    if (volume) return void this.#volume(volume, Number(control.value));
    if (record === 'image') return void this.#chooseImage(control);
    if (!Object.hasOwn(this.options, record)) return;
    this.options = { ...this.options, [record]: valueOf(control) };
    if (record === 'quality') this.#dropCompositor();
    this.paint();
  }

  resetBackground() {
    this.options = { ...this.options, background: '' };
    this.#dropImage();
    this.paint();
  }

  applyDefaults(settings) {
    if (this.isActive) return;
    const next = defaultsOf(settings);
    const changed = {};
    for (const name of DEFAULT_SETTINGS) {
      if (next[name] !== this.#defaults[name]) changed[name] = next[name];
    }
    this.#defaults = next;
    if (Object.keys(changed).length === 0) return;
    this.options = { ...this.options, ...changed };
    if (changed.quality) this.#dropCompositor();
    this.paint();
  }

  async start() {
    if (this.isActive || this.#isStarting || this.#isDisposed) return;
    this.#isStarting = true;
    this.notice = '';
    this.paint();
    try {
      await this.#begin();
    } catch (error) {
      await this.#abandon();
      this.notice = error.message;
      this.#stage.hooks.notice?.(error.message);
    } finally {
      this.#isStarting = false;
      this.paint();
    }
  }

  async stop() {
    const recorder = this.#recorder;
    if (!recorder || this.#isStopping) return null;
    this.#isStopping = true;
    this.#unflag();
    this.paint();
    try {
      return await recorder.stop({ people: Array.from(this.#names) });
    } catch (error) {
      this.notice = `Recording failed: ${error.message}`;
      report(this.#stage, error);
      return null;
    } finally {
      this.#isStopping = false;
      this.paint();
    }
  }

  dispose() {
    if (this.#isDisposed) return;
    this.#isDisposed = true;
    this.#stopClock();
    const stopping = this.stop();
    const release = () => {
      this.#dropCompositor();
      this.#dropImage();
    };
    stopping.then(release, release);
  }

  #isOpen() {
    const stage = this.#stage;
    if (stage.mode !== 'call') return false;
    if (stage.phone?.matches === true) return stage.sheet === 'record';
    return this.#isPanel;
  }

  #syncPreview(isOpen) {
    if (isOpen) return void this.#ensureCompositor();
    if (!this.isActive && !this.#isStarting) this.#dropCompositor();
  }

  #ensureCompositor() {
    if (this.#compositor) return this.#compositor;
    const members = () => this.members();
    const options = () => this.programOptions();
    const compositor = new Compositor({ members, options });
    compositor.start();
    this.#compositor = compositor;
    return compositor;
  }

  #dropCompositor() {
    if (this.isActive || this.#isStarting) return;
    this.#compositor?.stop();
    this.#compositor = null;
  }

  async #prepareStorage() {
    const storage = globalThis.navigator?.storage;
    if (!storage) throw new Error('Browser storage is unavailable');
    await askPersistence(storage);
    const space = spaceOf(await storage.estimate?.());
    if (space === 'full') throw new Error(FULL_SPACE);
    if (space === 'low') this.#warn();
  }

  #warn() {
    if (this.#isWarned) return;
    this.#isWarned = true;
    this.notice = LOW_SPACE;
    this.#stage.hooks.notice?.(LOW_SPACE);
  }

  #infoOf() {
    const session = this.#stage.session;
    const started = Date.now();
    const chat = session.chat;
    const chatName = this.#stage.hooks.titleOf(chat);
    const id = generateUUID();
    const title = titleOf(chatName, started);
    const background = this.image ? 'image' : this.options.background;
    const options = { ...this.options, background };
    const people = this.#peopleNames();
    const call = session.call;
    return { id, title, chat, chatName, call, started, options, people };
  }

  #peopleNames() {
    const names = this.members().map((member) => member.nick);
    return Array.from(new Set(names));
  }

  async #begin() {
    const stage = this.#stage;
    const session = stage.session;
    if (!session || session.phase !== 'joined') {
      throw new Error('Join the call to record it');
    }
    await this.#prepareStorage();
    this.#isWarned = this.notice === LOW_SPACE;
    const compositor = this.#ensureCompositor();
    const members = () => this.members();
    const options = () => this.programOptions();
    const onScreen = () => compositor.onScreen;
    const mixer = new Mixer({ members, options, onScreen });
    this.#mixer = mixer;
    mixer.start();
    this.#writer = new RecordingWriter();
    const quality = qualityOf(this.options);
    const writer = this.#writer;
    const recorder = new Recorder({ compositor, mixer, writer, quality });
    recorder.on('progress', () => this.paint());
    recorder.on('state', (state) => this.#onState(state));
    recorder.on('failure', (error) => this.#onFailure(error));
    const info = this.#infoOf();
    this.#current = { id: info.id, chat: info.chat };
    this.#names = new Set(info.people);
    await this.#flagOn();
    this.#recorder = recorder;
    await recorder.start(info);
    this.#startClock();
    const timestamp = info.started;
    const { id, chat, call } = info;
    try {
      stage.hooks.recordStart?.({ id, chat, call, timestamp });
    } catch (error) {
      report(stage, error);
    }
  }

  async #abandon() {
    this.#recorder = null;
    this.#stopClock();
    this.#releaseHints();
    this.#mixer?.stop();
    this.#mixer = null;
    this.#writer?.stop();
    this.#writer = null;
    await this.#unflag();
    this.#current = null;
  }

  async #flagOn() {
    await this.#stage.hooks.update({ recording: true });
    this.#isFlagged = true;
  }

  async #unflag() {
    if (!this.#isFlagged) return;
    this.#isFlagged = false;
    try {
      await this.#stage.hooks.update({ recording: false });
    } catch (error) {
      if (!this.#isDisposed) report(this.#stage, error);
    }
  }

  #onState(state) {
    if (state === 'stopped') this.#settle();
    this.paint();
  }

  #onFailure(error) {
    this.notice = `Recording stopped: ${error.message}`;
    this.#stage.hooks.notice?.(this.notice);
  }

  #settle() {
    const recorder = this.#recorder;
    if (!recorder) return;
    this.#recorder = null;
    this.#stopClock();
    this.#releaseHints();
    this.#mixer?.stop();
    this.#mixer = null;
    this.#writer?.stop();
    this.#writer = null;
    this.#unflag();
    const meta = recorder.meta;
    const current = this.#current;
    this.#current = null;
    if (current) {
      const stopped = meta?.stopped || Date.now();
      this.#stage.hooks.recordStop?.({ ...current, stopped });
    }
    if (!recorder.error && meta) {
      this.notice = `Recording saved, ${sizeText(meta.size)}`;
    }
    this.#dropCompositor();
  }

  #startClock() {
    const worker = new Worker(CLOCK_URL);
    this.#clock = worker;
    this.#ticks = 0;
    this.#onClock = ({ data }) => {
      if (data.type === 'tick') this.#onTick();
    };
    worker.addEventListener('message', this.#onClock);
    worker.postMessage({ type: 'start', fps: TICK_FPS });
  }

  #stopClock() {
    const worker = this.#clock;
    if (!worker) return;
    worker.removeEventListener('message', this.#onClock);
    worker.postMessage({ type: 'stop' });
    worker.terminate();
    this.#clock = null;
    this.#onClock = null;
  }

  #onTick() {
    this.#ticks++;
    this.#syncHints();
    for (const name of this.#peopleNames()) this.#names.add(name);
    if (this.#ticks % SPACE_TICKS === 0) this.#checkSpace();
  }

  #syncHints() {
    const session = this.#stage.session;
    const compositor = this.#compositor;
    if (!session || !compositor) return;
    const wanted = demandsOf(compositor.tiles, session.endpoint);
    for (const entry of this.#sent.values()) {
      const key = keyOf(entry.hint);
      const zero = { ...entry.hint, width: 0, height: 0, fps: 0 };
      if (!wanted.has(key)) wanted.set(key, zero);
    }
    for (const hint of wanted.values()) {
      const key = keyOf(hint);
      const text = textOf(hint);
      const before = this.#sent.get(key);
      if (before?.text === text || (!before && hint.fps === 0)) continue;
      this.#sent.set(key, { hint, text });
      const { slot, width, height, fps } = hint;
      const message = { slot, width, height, fps };
      session.setViewHint(hint.endpoint, message, HINT_OWNER);
    }
  }

  #releaseHints() {
    this.#sent.clear();
    this.#stage.session?.releaseViewHints(HINT_OWNER);
  }

  async #checkSpace() {
    try {
      const space = spaceOf(await navigator.storage.estimate());
      if (space === 'low') this.#warn();
      if (space !== 'full' || !this.isActive) return;
      this.notice = `Recording stopped: ${FULL_SPACE}`;
      this.#stage.hooks.notice?.(this.notice);
      await this.stop();
    } catch (error) {
      report(this.#stage, error);
    }
  }

  #pin(endpoint, isPinned) {
    const others = this.options.pinned.filter((item) => item !== endpoint);
    const pinned = isPinned ? others.concat([endpoint]) : others;
    this.options = { ...this.options, pinned };
    this.paint();
  }

  #volume(endpoint, value) {
    const volumes = { ...this.options.volumes, [endpoint]: value / 100 };
    this.options = { ...this.options, volumes };
    this.paint();
  }

  #dropImage() {
    if (this.#imageUrl) URL.revokeObjectURL(this.#imageUrl);
    this.#imageUrl = '';
    this.image = null;
  }

  async #chooseImage(input) {
    const file = input.files?.[0];
    if (!file) return;
    const url = URL.createObjectURL(file);
    const image = document.createElement('img');
    image.src = url;
    try {
      await image.decode();
    } catch {
      URL.revokeObjectURL(url);
      this.notice = 'The image could not be read';
      this.paint();
      return;
    }
    this.#dropImage();
    this.#imageUrl = url;
    this.image = image;
    this.paint();
  }
}

export { timeText, sizeText, hintOf, demandsOf, CallRecording };
