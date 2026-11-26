import { membersOf } from './members.js';
import { timeText, sizeText } from './recording-files.js';
import { RecordingSession } from './recording-session.js';

const HINT_OWNER = 'recorder';
const HINT_STEP = 40;
const HINT_FPS = 30;

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

class CallRecording extends RecordingSession {
  #stage = null;
  #sent = new Map();
  #imageUrl = '';
  #flagged = null;

  constructor(stage, settings) {
    super(settings, stage.hooks);
    this.#stage = stage;
    this.image = null;
  }

  members() {
    const stage = this.#stage;
    const session = stage.session;
    const state = {
      session,
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
    const scene = this.#scene;
    if (scene) {
      const studio = this.#stage.studio;
      return { ...this.options, ...scene.program, studio };
    }
    const background = this.image ?? (this.options.background || undefined);
    return { ...this.options, background };
  }

  get #scene() {
    const studio = this.#stage.studio;
    return studio?.enabled ? studio.activeScene : null;
  }

  storedOptions() {
    const scene = this.#scene;
    if (scene) {
      const background = scene.background.image
        ? 'image'
        : scene.background.color;
      return { ...this.options, ...scene.program, background };
    }
    const background = this.image ? 'image' : this.options.background;
    return { ...this.options, background };
  }

  paint() {
    const stage = this.#stage;
    if (!stage.host || this.isDisposed) return;
    const people = this.members().filter((member) => !member.local);
    const panel = stage.programPanel;
    const studio = stage.host.querySelector('.call-studio');
    studio?.toggleAttribute('data-open', panel === 'studio');
    const preview = panel
      ? stage.host.querySelector(`.${panel}-preview`)
      : null;
    this.paintPanel(stage.host, panel === 'record', people, preview);
    const note = studio?.querySelector('.studio-note');
    if (note && note.textContent !== this.notice) {
      note.textContent = this.notice;
    }
    if (panel === 'studio') stage.studio?.paint();
    stage.paintTabs();
  }

  recordView() {
    const scene = this.#scene;
    if (!scene) return null;
    const { color } = scene.background;
    const options = { ...this.options, ...scene.program, background: color };
    return { options, sceneName: scene.name };
  }

  change(control) {
    const { record, pin, volume } = control.dataset;
    if (this.#stage.studio?.enabled && control.disabled) return;
    if (pin) return void this.#pin(pin, control.checked);
    if (volume) return void this.#volume(volume, Number(control.value));
    if (record === 'image') return void this.#chooseImage(control);
    super.change(control);
  }

  resetBackground() {
    this.options = { ...this.options, background: '' };
    this.#dropImage();
    this.paint();
  }

  dispose() {
    return super.dispose().finally(() => this.#dropImage());
  }

  context() {
    const stage = this.#stage;
    const session = stage.session;
    if (!session || session.phase !== 'joined') {
      throw new Error('Join the call to record it');
    }
    const { chat, call } = session;
    const chatName = stage.hooks.titleOf(chat);
    return { chat, chatName, call, isCurrent: () => stage.session === session };
  }

  async beforeStart() {
    const stage = this.#stage;
    const session = stage.session;
    await stage.hooks.update({ recording: true });
    this.#flagged = session;
  }

  afterStart({ id, chat, call, started }) {
    this.#stage.hooks.recordStart?.({ id, chat, call, timestamp: started });
  }

  beforeStop() {
    const session = this.#flagged;
    this.#flagged = null;
    const stage = this.#stage;
    if (!session || stage.session !== session) return;
    stage.hooks.update({ recording: false }).catch((error) => {
      if (!this.isDisposed) stage.hooks.fail(error);
    });
  }

  afterStop({ id, chat }, meta) {
    const stopped = meta?.stopped || Date.now();
    this.#stage.hooks.recordStop?.({ id, chat, stopped });
  }

  release() {
    this.beforeStop();
  }

  idle() {
    this.#releaseHints();
  }

  tick() {
    this.#syncHints();
  }

  #syncHints() {
    const session = this.#stage.session;
    const compositor = this.compositor;
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
    if (this.isDisposed) return void URL.revokeObjectURL(url);
    this.#dropImage();
    this.#imageUrl = url;
    this.image = image;
    this.paint();
  }
}

export { timeText, sizeText, hintOf, demandsOf, CallRecording };
