import { Compositor } from './compositor.js';
import { generateUUID } from './metautil.js';
import { Mixer } from './mixer.js';
import { Recorder, RecordingWriter } from './recorder.js';
import { qualityOf } from './layout.js';
import { titleOf, spaceOf, timeText, sizeText } from './recording-files.js';
import { defaultsOf, valueOf, paintRecordControl } from './record-panel.js';
import { canPickFolder, chooseRecordingFolder } from './recording-folder.js';
import { requireRecordingFolder } from './recording-folder.js';
import { tickOn } from './clock.js';

const TICK_FPS = 2;
const SPACE_TICKS = 20;
const PERSIST_KEY = 'xxii:storage-persist';
const MINUTE_MS = 60000;
const DEFAULT_SETTINGS = [
  'people',
  'audio',
  'quality',
  'recordingTarget',
  'recordingSegment',
];
const LOW_SPACE = 'Less than 2 GB of free space, the recording may stop early';
const FULL_SPACE = 'Less than 500 MB of free space. Free some space first';

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

class RecordingSession {
  #hooks = null;
  #recorder = null;
  #writer = null;
  #mixer = null;
  #compositor = null;
  #untick = null;
  #current = null;
  #holds = new Set();
  #defaults = null;
  #names = new Set();
  #ticks = 0;
  #starting = null;
  #stopping = null;
  #disposing = null;
  #isChoosingFolder = false;
  #isDisposed = false;
  #isWarned = false;

  constructor(settings, hooks) {
    this.#hooks = hooks;
    this.#defaults = defaultsOf(settings);
    this.options = defaultsOf(settings);
    this.notice = '';
  }

  get isActive() {
    return this.#recorder !== null;
  }

  get isDisposed() {
    return this.#isDisposed;
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

  programOptions() {
    return this.options;
  }

  storedOptions() {
    return this.programOptions();
  }

  paintPanel(
    root,
    isOpen,
    people,
    preview = isOpen ? root.querySelector('.record-preview') : null,
  ) {
    if (this.#isDisposed) return;
    if (preview && !this.#compositor && typeof MediaRecorder === 'function') {
      try {
        this.#ensureCompositor();
      } catch (error) {
        this.notice = error.message;
      }
    } else if (!preview) {
      this.#dropCompositor();
    }
    const { options, notice } = this;
    const recorder = this.#recorder;
    const state = recorder ? recorder.state : 'idle';
    const time = timeText(recorder?.activeMs ?? 0);
    const size = sizeText(recorder?.size ?? 0);
    const isBusy = Boolean(
      this.#starting || this.#stopping || this.#isChoosingFolder,
    );
    const text = `${time} · ${size}`;
    const studio = this.recordView?.();
    const view = {
      state,
      text,
      options,
      people,
      notice,
      isOpen,
      isBusy,
      ...studio,
    };
    paintRecordControl(root, view);
    const canvas = this.#compositor?.canvas ?? null;
    if (!preview) {
      canvas?.remove();
      return;
    }
    if (preview.firstChild === canvas) return;
    if (canvas) preview.replaceChildren(canvas);
    else preview.replaceChildren();
  }

  toggle() {
    if (this.isActive) return this.stop();
    return this.start();
  }

  togglePause() {
    const recorder = this.#recorder;
    if (!recorder || this.#stopping) return;
    if (recorder.state === 'paused') recorder.resume();
    else recorder.pause();
    this.paint();
  }

  change(control) {
    const { record } = control.dataset;
    if (!Object.hasOwn(this.options, record)) return;
    const value = valueOf(control);
    if (record === 'recordingTarget' && value === 'folder') {
      return void this.#chooseFolder();
    }
    this.options = { ...this.options, [record]: value };
    if (record === 'quality') this.#dropCompositor();
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

  start() {
    const isRunning = this.isActive || this.#starting || this.#stopping;
    const isBlocked = this.#isChoosingFolder || this.#isDisposed;
    if (isRunning || isBlocked) return this.#starting;
    this.notice = '';
    this.#starting = this.#begin()
      .catch((error) => {
        this.#recorder = null;
        this.#release();
        if (this.#isDisposed) return;
        this.notice = error.message;
        this.#hooks.notice?.(error.message);
      })
      .finally(() => {
        this.#starting = null;
        if (this.#isDisposed) this.#dropCompositor();
        this.paint();
      });
    this.paint();
    return this.#starting;
  }

  stop() {
    if (this.#stopping) return this.#stopping;
    const recorder = this.#recorder;
    if (!recorder || recorder.state === 'idle') return Promise.resolve(null);
    this.beforeStop?.();
    this.#stopping = recorder
      .stop({ people: Array.from(this.#names) })
      .catch((error) => {
        this.notice = `Recording failed: ${error.message}`;
        this.#hooks.fail(error);
        return null;
      })
      .finally(() => {
        this.#stopping = null;
        this.paint();
      });
    this.paint();
    return this.#stopping;
  }

  hold(owner) {
    if (this.#isDisposed) throw new Error('The call has ended');
    const compositor = this.#ensureCompositor();
    const mixer = this.#ensureMixer();
    this.#holds.add(owner);
    this.#ensureClock();
    return { compositor, mixer };
  }

  unhold(owner) {
    if (!this.#holds.delete(owner)) return;
    this.#settleProgram();
    this.#dropCompositor();
    this.paint();
  }

  dispose() {
    if (this.#disposing) return this.#disposing;
    this.#isDisposed = true;
    this.#holds.delete('stream');
    this.#stopClock();
    this.#settleProgram();
    this.#dropCompositor();
    const stopped = this.#starting ?? this.stop();
    this.#disposing = stopped.finally(() => this.#dropCompositor());
    return this.#disposing;
  }

  #ensureCompositor() {
    if (this.#compositor) return this.#compositor;
    const members = () => this.members();
    const options = () => this.programOptions();
    const compositor = new Compositor({ members, options });
    try {
      compositor.start();
    } catch (error) {
      compositor.stop();
      throw error;
    }
    this.#compositor = compositor;
    return compositor;
  }

  #ensureMixer() {
    if (this.#mixer) return this.#mixer;
    const members = () => this.members();
    const options = () => this.programOptions();
    const onScreen = () => this.#compositor?.onScreen ?? new Set();
    this.#ensureCompositor();
    const mixer = new Mixer({ members, options, onScreen });
    this.#mixer = mixer;
    mixer.start();
    return mixer;
  }

  #dropCompositor() {
    const isHeld = this.#holds.size > 0;
    if (isHeld || this.isActive || (this.#starting && !this.#isDisposed)) {
      return;
    }
    this.#compositor?.canvas.remove();
    this.#compositor?.stop();
    this.#compositor = null;
  }

  async #prepareStorage(isCurrent) {
    const storage = globalThis.navigator?.storage;
    if (!storage) throw new Error('Browser storage is unavailable');
    await askPersistence(storage);
    if (!isCurrent()) return;
    const space = spaceOf(await storage.estimate?.());
    if (!isCurrent()) return;
    if (space === 'full') throw new Error(FULL_SPACE);
    if (space === 'low') this.#warn();
  }

  async #chooseFolder() {
    const isUnavailable = !canPickFolder() || this.#isChoosingFolder;
    const isBusy = this.isActive || this.#starting || this.#isDisposed;
    if (isUnavailable || isBusy) return;
    this.#isChoosingFolder = true;
    this.paint();
    try {
      if (await chooseRecordingFolder()) {
        this.options = { ...this.options, recordingTarget: 'folder' };
      }
    } catch {
      this.notice = 'Could not remember the recordings folder';
    } finally {
      this.#isChoosingFolder = false;
      this.paint();
    }
  }

  #warn() {
    if (this.#isWarned) return;
    this.#isWarned = true;
    this.notice = LOW_SPACE;
    this.#hooks.notice?.(LOW_SPACE);
  }

  #infoOf(context) {
    const { chat, chatName, call } = context;
    const started = Date.now();
    const id = generateUUID();
    const title = titleOf(chatName, started);
    const options = this.storedOptions();
    const people = this.#peopleNames();
    return { id, title, chat, chatName, call, started, options, people };
  }

  #peopleNames() {
    const names = this.members().map((member) => member.nick);
    return Array.from(new Set(names));
  }

  async #begin() {
    const context = this.context();
    const toFolder =
      canPickFolder() && this.options.recordingTarget === 'folder';
    const isCurrent = () =>
      !this.#isDisposed && (context.isCurrent?.() ?? true);
    const target = toFolder ? await requireRecordingFolder(isCurrent) : null;
    if (!isCurrent()) return;
    if (!target) await this.#prepareStorage(isCurrent);
    if (!isCurrent()) return;
    this.#isWarned = this.notice === LOW_SPACE;
    this.#holds.add('record');
    const compositor = this.#ensureCompositor();
    const mixer = this.#ensureMixer();
    const writer = new RecordingWriter();
    this.#writer = writer;
    const quality = qualityOf(this.options);
    const segmentMs = target ? this.options.recordingSegment * MINUTE_MS : 0;
    const recorder = new Recorder({
      compositor,
      mixer,
      writer,
      quality,
      folder: target?.handle,
      folderName: target?.name,
      segmentMs,
    });
    recorder.on('progress', () => this.paint());
    recorder.on('state', (state) => this.#onState(state));
    recorder.on('failure', (error) => this.#onFailure(error));
    const info = this.#infoOf(context);
    this.#names = new Set(info.people);
    await this.beforeStart?.();
    if (!isCurrent()) return void this.#release();
    this.#recorder = recorder;
    await recorder.start(info);
    if (!isCurrent()) {
      await this.stop();
      return;
    }
    this.#current = info;
    try {
      this.#ensureClock();
      this.afterStart?.(info);
    } catch (error) {
      this.#hooks.fail(error);
    }
  }

  #release() {
    this.release?.();
    this.#writer?.stop();
    this.#writer = null;
    this.#holds.delete('record');
    this.#settleProgram();
  }

  #settleProgram() {
    if (this.#holds.size > 0) return;
    this.#stopClock();
    this.idle?.();
    this.#mixer?.stop();
    this.#mixer = null;
  }

  #onState(state) {
    if (state === 'stopped') this.#settle();
    this.paint();
  }

  #onFailure(error) {
    this.notice = `Recording stopped: ${error.message}`;
    this.#hooks.notice?.(this.notice);
  }

  #settle() {
    const recorder = this.#recorder;
    if (!recorder) return;
    this.#recorder = null;
    this.#release();
    const meta = recorder.meta;
    const current = this.#current;
    this.#current = null;
    const isSaved = !recorder.error && meta?.state === 'done';
    if (current) {
      try {
        this.afterStop?.(current, meta, isSaved);
      } catch (error) {
        this.#hooks.fail(error);
      }
    }
    if (isSaved) this.notice = `Recording saved, ${sizeText(meta.size)}`;
    this.#dropCompositor();
  }

  #ensureClock() {
    if (this.#untick) return;
    this.#ticks = 0;
    this.#untick = tickOn(null, TICK_FPS, () => this.#onTick());
  }

  #stopClock() {
    this.#untick?.();
    this.#untick = null;
  }

  #onTick() {
    this.#ticks++;
    this.tick?.();
    for (const name of this.#peopleNames()) this.#names.add(name);
    const recorder = this.#recorder;
    if (recorder && !recorder.meta.folder && this.#ticks % SPACE_TICKS === 0) {
      this.#checkSpace();
    }
  }

  async #checkSpace() {
    const recorder = this.#recorder;
    try {
      const space = spaceOf(await navigator.storage.estimate());
      if (recorder !== this.#recorder || !recorder) return;
      if (space === 'low') this.#warn();
      if (space !== 'full') return;
      this.notice = `Recording stopped: ${FULL_SPACE}`;
      this.#hooks.notice?.(this.notice);
      await this.stop();
    } catch (error) {
      this.#hooks.fail(error);
    }
  }
}

export { RecordingSession };
