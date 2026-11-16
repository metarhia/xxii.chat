import { ParticipantVolume } from './call-volume.js';
import { TileMenu } from './call-tile-menu.js';
import { statsText } from './call-stats.js';
import { MediaCapture, CallLevels } from './media.js';
import { requestCallNotifications } from './notifications.js';
import { notificationClient } from './notifications.js';
import { ViewHints } from './view-hints.js';
import { CALL_LAYOUTS, STRIP_POSITIONS } from './call-layout.js';
import { tileId, callLayout } from './call-layout.js';

const LOBBY = 'waiting for an admin to let you in';
const TONE_HZ = 440;
const RING_MS = 1600;
const RING_PATTERN = [280, 120, 280, 920];

const ACTIONS = {
  mic: (stage) => stage.toggle('mic'),
  camera: (stage) => stage.toggle('camera'),
  share: (stage) => stage.share(),
  'share-call': (stage) => stage.media?.openScreen(true),
  'capture-local': (stage) => stage.media?.openScreen(false),
  'screen-motion': (stage) => stage.media?.toggleScreenMotion(),
  'stop-screen': (stage) => stage.media?.stopScreen(),
  join: (stage) => stage.join(),
  cancel: (stage) => stage.cancel(),
  leave: (stage) => stage.leave(),
  back: (stage) => stage.collapse(),
  fullscreen: (stage) => stage.fullscreen(),
  'stats-overlay': (stage) => stage.toggleStats(),
  'hide-self': (stage) => stage.toggleView('hideSelf'),
  'hide-no-video': (stage) => stage.toggleView('hideNoVideo'),
};

const hueOf = (id) => {
  let hash = 0;
  for (const char of id) hash = (hash * 33 + char.charCodeAt(0)) % 360;
  return hash;
};

const peerOf = (endpoint) => {
  const index = endpoint.indexOf(':');
  if (index <= 0) return endpoint;
  return endpoint.slice(0, index);
};

const colorOf = (endpoint) => {
  const peer = endpoint ? peerOf(endpoint) : 'guest';
  return `hsl(${hueOf(peer)} 42% 32%)`;
};

const initialsOf = (name) => {
  const text = typeof name === 'string' ? name.trim() : '';
  if (text === '') return '?';
  const parts = text.split(/\s+/);
  const first = parts[0];
  const second = parts[1];
  if (!second) return first.slice(0, 2).toUpperCase();
  return `${first[0]}${second[0]}`.toUpperCase();
};

const createButton = (action, label) => {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'link-btn';
  button.dataset.action = action;
  button.textContent = label;
  return button;
};

const createField = (id, label) => {
  const wrap = document.createElement('label');
  wrap.className = 'call-field';
  const caption = document.createElement('span');
  caption.textContent = label;
  const select = document.createElement('select');
  select.id = id;
  wrap.append(caption, select);
  return wrap;
};

const createVideo = (muted) => {
  const video = document.createElement('video');
  video.autoplay = true;
  video.muted = muted;
  video.playsInline = true;
  return video;
};

const createAvatar = () => {
  const wrap = document.createElement('div');
  wrap.className = 'avatar-wrap';
  const avatar = document.createElement('div');
  avatar.className = 'avatar';
  wrap.append(avatar);
  return wrap;
};

const streamOf = (track) => {
  const Stream = globalThis.MediaStream;
  if (!Stream || !track) return null;
  return new Stream([track]);
};

const showTrack = (video, track, mirrored) => {
  video.classList.toggle('mirrored', mirrored);
  const current = video.srcObject?.getVideoTracks?.()[0] ?? null;
  if (current === track) return;
  video.srcObject = streamOf(track);
  if (track) video.play().catch(() => undefined);
};

const paintPerson = (root, track, name, color) => {
  const video = root.querySelector('video');
  const wrap = root.querySelector('.avatar-wrap');
  const avatar = wrap?.querySelector('.avatar');
  const live = Boolean(track);
  if (video) {
    video.classList.toggle('hidden', !live);
    showTrack(video, track, root.classList.contains('local'));
  }
  wrap?.classList.toggle('hidden', live);
  if (!avatar || live) return;
  avatar.style.background = color;
  avatar.textContent = initialsOf(name);
};

const hasOption = (select, value) => {
  for (const option of select.options) {
    if (option.value === value) return true;
  }
  return false;
};

const fillSelect = (select, devices, selected, noun) => {
  if (!select) return;
  select.replaceChildren();
  const blank = document.createElement('option');
  blank.value = '';
  blank.textContent = 'default';
  select.append(blank);
  let index = 0;
  for (const device of devices) {
    if (device.deviceId === '') continue;
    const option = document.createElement('option');
    option.value = device.deviceId;
    const label = device.label || `${noun} ${index + 1}`;
    option.textContent = label;
    select.append(option);
    index += 1;
  }
  const known = selected === '' || hasOption(select, selected);
  select.value = known ? selected : '';
};

const createPrejoin = (title, hasNick) => {
  const section = document.createElement('section');
  section.id = 'prejoin';
  const preview = document.createElement('div');
  preview.className = 'preview';
  const level = document.createElement('div');
  level.className = 'level';
  const bar = document.createElement('div');
  bar.className = 'level-bar';
  level.append(bar);
  const actions = document.createElement('div');
  actions.className = 'prejoin-actions';
  const micButton = createButton('mic', 'mic on');
  const cameraButton = createButton('camera', 'camera on');
  actions.append(micButton, cameraButton);
  preview.append(createVideo(true), createAvatar(), level, actions);
  const side = document.createElement('div');
  side.className = 'prejoin-side';
  const heading = document.createElement('p');
  heading.className = 'chat-title';
  heading.textContent = title;
  const note = document.createElement('p');
  note.className = 'call-note hidden';
  const nick = document.createElement('label');
  nick.className = 'call-field nick-field';
  nick.classList.toggle('hidden', hasNick);
  const nickCaption = document.createElement('span');
  nickCaption.textContent = 'nick';
  const input = document.createElement('input');
  input.id = 'prejoin-nick';
  input.type = 'text';
  input.maxLength = 32;
  input.placeholder = 'your name';
  nick.append(nickCaption, input);
  const camera = createField('prejoin-camera', 'camera');
  const mic = createField('prejoin-mic', 'mic');
  const speaker = createField('prejoin-speaker', 'speaker');
  speaker.classList.add('speaker-field');
  const row = document.createElement('div');
  row.className = 'prejoin-actions';
  row.append(createButton('join', 'join'), createButton('cancel', 'cancel'));
  side.append(heading, note, nick, camera, mic, speaker, row);
  section.append(preview, side);
  return section;
};

const createLobby = () => {
  const section = document.createElement('section');
  section.id = 'lobby';
  section.className = 'lobby';
  const text = document.createElement('p');
  text.textContent = LOBBY;
  section.append(text, createButton('cancel', 'cancel'));
  return section;
};

const createShare = () => {
  const wrap = document.createElement('div');
  wrap.className = 'call-share';
  wrap.append(createButton('share', 'share screen'));
  const menu = document.createElement('details');
  const summary = document.createElement('summary');
  summary.textContent = '▾';
  summary.setAttribute('aria-label', 'screen sharing options');
  const choices = document.createElement('div');
  choices.className = 'share-menu';
  choices.append(
    createButton('share-call', 'share to call'),
    createButton('capture-local', 'capture without sharing'),
    createButton('screen-motion', 'video mode off'),
    createButton('stop-screen', 'stop capture'),
  );
  menu.append(summary, choices);
  wrap.append(menu);
  return wrap;
};

const createLayoutControls = () => {
  const choices = document.createElement('details');
  choices.className = 'call-layout-options';
  const summary = document.createElement('summary');
  summary.textContent = 'view';
  const menu = document.createElement('div');
  menu.className = 'share-menu';
  const layout = createField('call-layout', 'layout');
  const strip = createField('call-strip', 'strip position');
  for (const field of [layout, strip]) {
    const select = field.querySelector('select');
    const values = field === layout ? CALL_LAYOUTS : STRIP_POSITIONS;
    for (const value of values) {
      const option = document.createElement('option');
      option.value = value;
      option.textContent = value;
      select.append(option);
    }
  }
  menu.append(
    layout,
    strip,
    createButton('hide-self', 'hide self view'),
    createButton('hide-no-video', 'hide tiles without video'),
    createButton('fullscreen', 'full screen stage'),
    createButton('stats-overlay', 'stats overlay'),
  );
  choices.append(summary, menu);
  return choices;
};

const createCall = (title) => {
  const section = document.createElement('section');
  section.id = 'call-view';
  const bar = document.createElement('header');
  bar.className = 'call-topbar';
  const back = createButton('back', '‹');
  back.setAttribute('aria-label', 'back');
  const heading = document.createElement('span');
  heading.className = 'chat-title';
  heading.textContent = title;
  bar.append(back, heading, createLayoutControls());
  const grid = document.createElement('div');
  grid.className = 'call-grid';
  const controls = document.createElement('footer');
  controls.className = 'call-controls';
  controls.append(
    createButton('mic', 'mic on'),
    createButton('camera', 'camera on'),
    createButton('leave', 'leave'),
  );
  controls.insertBefore(createShare(), controls.lastElementChild);
  const note = document.createElement('p');
  note.className = 'call-note hidden';
  note.setAttribute('role', 'status');
  section.append(bar, note, grid, controls);
  return section;
};

const createMini = () => {
  const tile = document.createElement('div');
  tile.id = 'mini-call';
  const controls = document.createElement('div');
  controls.className = 'mini-controls';
  controls.append(
    createButton('mic', 'mic on'),
    createButton('camera', 'camera on'),
    createButton('leave', 'leave'),
  );
  tile.append(createVideo(true), createAvatar(), controls);
  return tile;
};

const createTile = (endpoint) => {
  const tile = document.createElement('article');
  tile.className = 'call-tile';
  tile.dataset.endpoint = endpoint;
  const name = document.createElement('span');
  name.className = 'call-name';
  const menu = createButton('tile-menu', '⋯');
  menu.setAttribute('aria-label', 'Participant options');
  menu.setAttribute('aria-haspopup', 'true');
  menu.setAttribute('aria-expanded', 'false');
  const bars = document.createElement('span');
  bars.className = 'connection-bars';
  bars.setAttribute('role', 'img');
  const stats = document.createElement('pre');
  stats.className = 'tile-stats hidden';
  const poor = createButton('audio-only', 'Poor connection · try audio only');
  poor.classList.add('call-poor', 'hidden');
  tile.append(createVideo(true), createAvatar(), name, bars, menu, stats, poor);
  return tile;
};

const audioContext = () =>
  globalThis.AudioContext ?? globalThis.webkitAudioContext;

const closeContext = (context) => {
  if (!context || context.state === 'closed') return;
  context.close().catch(() => undefined);
};

const notify = async (registration, title, options) => {
  if (!options.data?.clientId) return false;
  try {
    await registration.showNotification(title, options);
    return true;
  } catch {
    return false;
  }
};

const dismissNotes = (tag) => {
  const run = async () => {
    if (tag === '') return;
    const worker = globalThis.navigator?.serviceWorker;
    if (!worker?.ready) return;
    const registration = await worker.ready;
    if (typeof registration.getNotifications !== 'function') return;
    const notes = await registration.getNotifications({ tag });
    for (const note of notes) note.close();
  };
  run().catch(() => undefined);
};

const createIncoming = (ring) => {
  const toast = document.createElement('aside');
  toast.id = 'incoming-call';
  toast.className = 'incoming';
  const text = document.createElement('p');
  text.className = 'incoming-text';
  text.textContent = `${ring.nick} is calling`;
  const note = document.createElement('p');
  note.className = 'incoming-note hidden';
  const actions = document.createElement('div');
  actions.className = 'incoming-actions';
  const video = createButton('video', 'video');
  const audio = createButton('audio', 'audio');
  const decline = createButton('decline', 'decline');
  actions.append(video, audio, decline);
  toast.append(text, note, actions);
  toast.addEventListener('click', (event) => ring.onClick(event));
  return toast;
};

class RingAlert {
  constructor(hooks) {
    this.hooks = hooks;
    this.generation = 0;
    this.call = '';
    this.chat = '';
    this.nick = '';
    this.peer = '';
    this.tab = '';
    this.tag = '';
    this.notice = '';
    this.noteError = '';
    this.context = null;
    this.oscillator = null;
    this.gain = null;
    this.pulse = 0;
    this.vibe = 0;
    this.root = null;
  }

  show(ring) {
    this.stop();
    this.generation += 1;
    const call = typeof ring.call === 'string' ? ring.call : '';
    if (call === '') return;
    const chat = typeof ring.chat === 'string' ? ring.chat : '';
    const nick = typeof ring.nick === 'string' ? ring.nick : '';
    const peer = typeof ring.peer === 'string' ? ring.peer : '';
    const tab = typeof ring.tab === 'string' ? ring.tab : '';
    this.call = call;
    this.chat = chat;
    this.nick = nick;
    this.peer = peer;
    this.tab = tab;
    this.tag = `${call}:${tab}`;
    this.notice = '';
    this.noteError = '';
    this.root = createIncoming(this);
    document.body.append(this.root);
    const generation = this.generation;
    this.play(generation).catch(() => undefined);
    this.buzz();
    this.alert();
  }

  stop(call = '') {
    const current = this.call;
    if (current === '') return;
    if (call !== '' && call !== current) return;
    const tag = this.tag;
    this.generation += 1;
    this.call = '';
    this.chat = '';
    this.nick = '';
    this.peer = '';
    this.tab = '';
    this.tag = '';
    this.notice = '';
    this.noteError = '';
    this.root?.remove();
    this.root = null;
    this.silence();
    this.quiet();
    dismissNotes(tag);
  }

  onClick(event) {
    const button = event.target.closest('[data-action]');
    if (!button || this.call === '') return;
    const action = button.dataset.action;
    if (action === 'decline') {
      this.hooks.decline();
      return;
    }
    const answering = action === 'video' || action === 'audio';
    if (answering) this.hooks.answer(action);
  }

  onVisibility() {
    if (this.call === '') return;
    if (document.hidden) {
      this.alert();
      return;
    }
    dismissNotes(this.tag);
  }

  setNotice(text) {
    this.notice = text;
    const note = this.root?.querySelector('.incoming-note');
    if (!note) return;
    note.textContent = text;
    note.classList.toggle('hidden', text === '');
  }

  async play(generation) {
    const Context = audioContext();
    if (!Context) {
      this.setNotice('sound is unavailable');
      return;
    }
    let context = null;
    try {
      context = new Context();
    } catch {
      if (this.generation === generation) {
        this.setNotice('sound is unavailable');
      }
      return;
    }
    if (this.generation !== generation) {
      closeContext(context);
      return;
    }
    if (context.state === 'suspended') {
      try {
        await context.resume();
      } catch {
        if (this.generation === generation) this.setNotice('sound is blocked');
        closeContext(context);
        return;
      }
    }
    if (this.generation !== generation) {
      closeContext(context);
      return;
    }
    this.context = context;
    if (context.state !== 'running') {
      this.setNotice('sound is blocked');
      return;
    }
    const oscillator = context.createOscillator();
    const gain = context.createGain();
    oscillator.type = 'sine';
    oscillator.frequency.value = TONE_HZ;
    gain.gain.setValueAtTime(0.0001, context.currentTime);
    oscillator.connect(gain);
    gain.connect(context.destination);
    oscillator.start();
    if (this.generation !== generation) {
      oscillator.stop();
      closeContext(context);
      if (this.context === context) this.context = null;
      return;
    }
    this.oscillator = oscillator;
    this.gain = gain;
    this.pulse = setInterval(() => this.beat(), RING_MS);
    this.beat();
  }

  beat() {
    const gain = this.gain;
    const context = this.context;
    const live = gain && context && context.state === 'running';
    if (!live) return;
    const now = context.currentTime;
    gain.gain.cancelScheduledValues(now);
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.exponentialRampToValueAtTime(0.05, now + 0.03);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.35);
  }

  silence() {
    if (this.pulse) clearInterval(this.pulse);
    this.pulse = 0;
    const oscillator = this.oscillator;
    this.oscillator = null;
    this.gain = null;
    if (oscillator) oscillator.stop();
    const context = this.context;
    this.context = null;
    closeContext(context);
  }

  buzz() {
    const vibrate = globalThis.navigator?.vibrate;
    if (typeof vibrate !== 'function') return;
    const call = this.call;
    const tick = () => {
      if (this.call !== call) return;
      vibrate.call(globalThis.navigator, RING_PATTERN);
    };
    tick();
    this.vibe = setInterval(tick, RING_MS);
  }

  quiet() {
    if (this.vibe) clearInterval(this.vibe);
    this.vibe = 0;
    const vibrate = globalThis.navigator?.vibrate;
    if (typeof vibrate !== 'function') return;
    vibrate.call(globalThis.navigator, 0);
  }

  alert() {
    const call = this.call;
    const tag = this.tag;
    const nick = this.nick;
    const run = async () => {
      if (call === '' || this.call !== call || !document.hidden) return;
      const Notify = globalThis.Notification;
      const worker = globalThis.navigator?.serviceWorker;
      const ready = typeof Notify === 'function' && worker?.ready;
      if (!ready || Notify.permission !== 'granted') return;
      const registration = await worker.ready;
      if (this.call !== call || !document.hidden) return;
      const clientId = await notificationClient(registration.active);
      if (this.call !== call || !document.hidden) return;
      const data = { clientId };
      const title = `${nick} is calling`;
      const loud = { tag, data, renotify: true };
      const didLoud = await notify(registration, title, loud);
      if (this.call !== call) return;
      if (didLoud) {
        this.noteError = '';
        return;
      }
      const quiet = { tag, data };
      const didQuiet = await notify(registration, title, quiet);
      if (this.call !== call) return;
      if (didQuiet) {
        this.noteError = '';
        return;
      }
      const active = registration.active;
      if (!active) {
        this.noteError = 'showNotification failed';
        return;
      }
      active.postMessage({ type: 'xxii:ring', title, tag });
      this.noteError = 'posted to worker';
    };
    run().catch(() => undefined);
  }
}

class CallStage {
  #onKey = null;
  #onPhase = null;
  #onTrack = null;
  #onCall = null;
  #listening = false;
  #onNotice = null;
  #onQuality = null;
  #onStats = null;

  constructor(root, hooks) {
    this.root = root;
    this.hooks = hooks;
    this.session = null;
    this.media = null;
    this.token = '';
    this.chat = '';
    this.mode = '';
    this.joining = false;
    this.host = null;
    this.mini = null;
    this.people = [];
    this.remote = new Map();
    this.audios = new Map();
    this.soundBlocked = false;
    this.volume = null;
    this.tileMenu = null;
    this.stats = new Map();
    this.statsShown = new Set();
    this.statsHidden = new Set();
    this.statsAll = false;
    this.viewHints = null;
    this.quality = new Map();
    this.qualityNotices = new Set();
    this.levels = null;
    this.layout = 'auto';
    this.strip = 'bottom';
    this.hideSelf = false;
    this.hideNoVideo = false;
    this.pin = '';
    this.spotlight = '';
    this.resizeObserver = null;
    this.resizeTimer = null;
    this.trackListeners = new Map();
    this.#onKey = (event) => this.onKey(event);
    this.#onPhase = (phase) => this.onPhase(phase);
    this.#onTrack = (payload) => this.onRemoteTrack(payload);
    this.#onCall = (state) => this.onCallState(state);
    this.#onNotice = (text) => {
      this.qualityNotices.add(text);
      this.showNote(this.media?.message || this.media?.notice || '');
    };
    this.#onQuality = (quality) => this.onQuality(quality);
    this.#onStats = ({ endpoint, stats }) => {
      if (!this.session || !this.tileList().includes(endpoint)) return;
      this.stats.set(endpoint, stats);
      this.paintStats();
    };
  }

  attach(session, token, camera = true) {
    this.detach();
    this.session = session;
    this.token = token;
    this.chat = session.chat;
    this.joining = false;
    this.people = [];
    this.remote = new Map();
    this.volume = new ParticipantVolume(this.#onNotice);
    this.tileMenu = new TileMenu(this);
    this.media = new MediaCapture();
    this.media.cameraOn = camera;
    this.media.onChange = () => this.onMedia();
    this.media.onLevel = (level) => this.paintLevel(level);
    this.levels = new CallLevels(session, this.media, () => this.people);
    this.levels.on('levels', () => this.paintSpeaking());
    this.levels.on('speaker', () => this.renderTiles());
    this.levels.on('notice', this.#onNotice);
    session.on('state', this.#onPhase);
    session.on('track', this.#onTrack);
    session.on('notice', this.#onNotice);
    session.on('quality', this.#onQuality);
    session.on('stats', this.#onStats);
    this.viewHints = new ViewHints(
      (endpoint, hint) => session.setViewHint(endpoint, hint),
      this.#onNotice,
    );
    this.hooks.listen(this.#onCall);
    document.addEventListener('keydown', this.#onKey, true);
    this.#listening = true;
    this.mount('prejoin');
    this.media.openPreview().catch((error) => this.hooks.fail(error));
  }

  detach() {
    const session = this.session;
    if (session) {
      session.off('state', this.#onPhase);
      session.off('track', this.#onTrack);
      session.off('notice', this.#onNotice);
      session.off('quality', this.#onQuality);
      session.off('stats', this.#onStats);
    }
    this.tileMenu?.stop();
    this.tileMenu = null;
    this.volume?.stop();
    this.volume = null;
    this.stats.clear();
    this.statsShown.clear();
    this.statsHidden.clear();
    this.statsAll = false;
    this.levels?.stop();
    this.levels = null;
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
    clearInterval(this.resizeTimer);
    this.resizeTimer = null;
    for (const track of this.trackListeners.keys()) this.unwatchTrack(track);
    this.pin = '';
    this.spotlight = '';
    this.viewHints?.stop();
    this.viewHints = null;
    this.quality.clear();
    this.qualityNotices.clear();
    if (this.#listening) {
      this.hooks.unlisten(this.#onCall);
      document.removeEventListener('keydown', this.#onKey, true);
      this.#listening = false;
    }
    if (this.media) this.media.stop();
    this.media = null;
    this.session = null;
    this.mode = '';
    this.joining = false;
    this.host?.remove();
    this.host = null;
    this.mini?.remove();
    this.mini = null;
    this.stopAudios();
    this.people = [];
    this.remote = new Map();
    this.root.removeAttribute('data-call');
    this.hooks.closed();
    this.hooks.changed();
  }

  mount(mode) {
    this.tileMenu?.close(false);
    this.mode = mode;
    this.ensureHost();
    this.host.classList.remove('hidden');
    const title = this.hooks.titleOf(this.chat);
    const view = this.viewOf(mode, title);
    this.resizeObserver?.disconnect();
    clearInterval(this.resizeTimer);
    this.resizeTimer = null;
    this.host.replaceChildren(view);
    this.root.dataset.call = mode;
    this.mini?.remove();
    this.mini = null;
    this.parkAudios();
    if (mode === 'prejoin') this.onMedia();
    if (mode === 'call') {
      this.levels?.start();
      this.observeLayout();
      this.syncControls();
      this.showNote(this.media?.message || this.media?.notice || '');
      this.renderTiles();
      this.hooks.focusChat(this.chat);
      this.hooks.changed();
    }
  }

  showLobby() {
    this.joining = false;
    this.mount('lobby');
  }

  showCall(state) {
    if (state) this.onCallState(state);
    this.joining = false;
    this.mount('call');
  }

  collapse() {
    if (this.mode !== 'call') return;
    this.tileMenu?.close(false);
    this.mode = 'mini';
    this.resizeObserver?.disconnect();
    clearInterval(this.resizeTimer);
    this.resizeTimer = null;
    this.host.classList.add('hidden');
    this.host.replaceChildren();
    this.root.dataset.call = 'mini';
    this.mini = createMini();
    this.mini.addEventListener('click', (event) => this.onMiniClick(event));
    document.body.append(this.mini);
    this.syncControls();
    this.showNote(this.media?.message || this.media?.notice || '');
    this.paintMini();
    this.updateViewHints();
    this.hooks.changed();
  }

  expand() {
    if (this.mode !== 'mini') return;
    this.showCall();
  }

  onMiniClick(event) {
    const button = event.target.closest('[data-action]');
    if (button) return void this.onAction(button.dataset.action);
    this.expand();
  }

  onAction(action, endpoint = '', slot = 'camera') {
    if (action === 'tile-stats') return void this.toggleStats(endpoint);
    if (action === 'pin') return void this.togglePin(endpoint, slot);
    if (action === 'tile-fullscreen') {
      return void this.fullscreen(endpoint, slot);
    }
    if (action === 'audio-only' && endpoint && this.session) {
      const enabled = !this.session.isAudioOnly(endpoint);
      this.session.setAudioOnly(endpoint, enabled);
      this.renderTiles();
      return;
    }
    const run = ACTIONS[action];
    if (!run) return;
    const result = run(this);
    if (result?.catch) result.catch((error) => this.hooks.fail(error));
  }

  onKey(event) {
    if (event.isComposing) return;
    if (event.key === 'Escape' && this.tileMenu?.menu.isOpen) {
      event.preventDefault();
      event.stopImmediatePropagation();
      this.tileMenu.close();
      return;
    }
    if (this.tileMenu?.menu.contains(event.target)) return;
    if (this.mode === 'prejoin') return void this.onPrejoinKey(event);
    if (this.mode !== 'call') return;
    if (this.hooks.isText(event.target)) return;
    this.onCallKey(event);
  }

  onPrejoinKey(event) {
    const isEsc = event.key === 'Escape';
    const isEnter = event.key === 'Enter' && !event.isComposing;
    if (!isEsc && !isEnter) return;
    event.preventDefault();
    event.stopPropagation();
    if (isEsc) this.cancel();
    else this.join();
  }

  onCallKey(event) {
    const command = event.ctrlKey || event.metaKey;
    const key = event.key.toLowerCase();
    const isFullscreen = key === 'f' && !command && !event.altKey;
    const isLayout = key === 'l' && event.ctrlKey && event.altKey;
    if (isFullscreen || isLayout) {
      event.preventDefault();
      event.stopPropagation();
      if (isFullscreen) this.fullscreen();
      else this.nextLayout();
      return;
    }
    if (!command || event.altKey) return;
    if (key !== 'd' && key !== 'e') return;
    event.preventDefault();
    event.stopPropagation();
    const kind = key === 'd' ? 'mic' : 'camera';
    this.toggle(kind);
  }

  async join() {
    if (this.mode !== 'prejoin' || this.joining || !this.session) return;
    requestCallNotifications();
    this.joining = true;
    this.syncControls();
    this.media?.resume();
    const nick = this.readNick();
    this.pushTracks();
    const input = { nick };
    if (this.token) input.token = this.token;
    try {
      const result = await this.session.join(input);
      const status = result?.status;
      if (status === 'lobby') {
        this.showLobby();
      } else if (status === 'joined') {
        await this.updateServer();
        this.showCall(result.state);
      } else {
        this.joining = false;
      }
    } catch (error) {
      this.joining = false;
      this.showNote(error.message || 'Could not join');
      this.syncControls();
    }
  }

  cancel() {
    const leaving = this.hooks.leave();
    if (leaving?.catch) leaving.catch((error) => this.hooks.fail(error));
  }

  leave() {
    this.cancel();
  }

  async share() {
    const media = this.media;
    if (!media) return;
    if (media.screenTrack) media.stopScreen();
    else await media.openScreen(true);
  }

  async toggle(kind) {
    const media = this.media;
    if (!media) return;
    media.resume();
    if (kind === 'mic') await media.toggleMic();
    else await media.toggleCamera();
  }

  onPhase(phase) {
    if (phase === 'lobby' && this.mode !== 'lobby') this.showLobby();
    if (phase === 'joined' && this.mode === 'lobby') this.showCall();
    const showing = this.mode === 'call' || this.mode === 'mini';
    if (phase === 'joined' && showing) {
      this.updateServer().catch((error) => this.hooks.fail(error));
    }
    const idle = phase === 'idle';
    const open = this.mode !== 'prejoin' && this.mode !== '';
    if (idle && open) this.detach();
  }

  onCallState(state) {
    if (!this.session || state?.call !== this.session.call) return;
    const list = Array.isArray(state.participants) ? state.participants : [];
    const people = [];
    for (const item of list) {
      const endpoint = item.endpoint;
      if (!endpoint) continue;
      const nick = typeof item.nick === 'string' ? item.nick : '';
      const peer = typeof item.peer === 'string' ? item.peer : '';
      const camera = item.camera === true;
      const screen = item.screen === true;
      const mic = item.mic !== false;
      people.push({ endpoint, nick, peer, camera, screen, mic });
    }
    this.people = people;
    this.spotlight = typeof state.spotlight === 'string' ? state.spotlight : '';
    const present = new Set(people.map((person) => person.endpoint));
    for (const endpoint of this.remote.keys()) {
      if (present.has(endpoint)) continue;
      const tracks = this.remote.get(endpoint);
      for (const track of Object.values(tracks)) this.unwatchTrack(track);
      this.remote.delete(endpoint);
      this.quality.delete(endpoint);
      this.stats.delete(endpoint);
      this.statsShown.delete(endpoint);
      this.statsHidden.delete(endpoint);
      if (this.tileMenu?.tile?.dataset.endpoint === endpoint) {
        this.tileMenu.close(false);
      }
      this.attachAudio(endpoint, null);
      this.attachAudio(endpoint, null, 'screenAudio');
    }
    this.restoreRemote();
    this.levels?.sample();
    for (const endpoint of this.remote.keys()) {
      const screen = this.screenTrack(endpoint);
      const audio = screen ? this.remote.get(endpoint)?.screenAudio : null;
      this.attachAudio(endpoint, audio, 'screenAudio');
    }
    if (this.mode === 'call' || this.mode === 'mini') this.renderTiles();
  }

  restoreRemote() {
    for (const person of this.people) {
      const endpoint = person.endpoint;
      if (endpoint === this.session.endpoint) continue;
      for (const slot of ['mic', 'camera', 'screen', 'screenAudio']) {
        const current = this.remote.get(endpoint)?.[slot];
        if (current?.readyState === 'live') continue;
        const track = this.session.receiver(endpoint, slot)?.track;
        if (track?.readyState !== 'live') continue;
        this.onRemoteTrack({ endpoint, slot, track });
      }
    }
  }

  onRemoteTrack(payload) {
    const endpoint = payload?.endpoint;
    const slot = payload?.slot;
    const valid = ['mic', 'camera', 'screen', 'screenAudio'].includes(slot);
    if (!endpoint || !valid) return;
    const track = payload.track ?? null;
    const current = this.remote.get(endpoint) ?? {
      mic: null,
      camera: null,
      screen: null,
      screenAudio: null,
    };
    const previous = current[slot];
    if (previous !== track) this.unwatchTrack(previous);
    current[slot] = track;
    this.remote.set(endpoint, current);
    if (track) this.watchTrack(endpoint, slot, track);
    if (slot === 'mic') this.attachAudio(endpoint, track);
    if (slot === 'screenAudio' || slot === 'screen') {
      const audio = this.screenTrack(endpoint) ? current.screenAudio : null;
      this.attachAudio(endpoint, audio, 'screenAudio');
    }
    if (this.mode === 'call' || this.mode === 'mini') this.renderTiles();
  }

  onQuality(quality) {
    const endpoint = quality.endpoint;
    const previous = this.quality.get(endpoint);
    this.quality.set(endpoint, quality);
    const unchanged =
      previous &&
      previous.poor === quality.poor &&
      previous.audioOnly === quality.audioOnly;
    if (!unchanged) this.renderTiles();
  }

  unwatchTrack(track) {
    const listener = this.trackListeners.get(track);
    if (!listener) return;
    for (const name of ['ended', 'mute', 'unmute']) {
      track.removeEventListener(name, listener);
    }
    this.trackListeners.delete(track);
  }

  watchTrack(endpoint, slot, track) {
    if (this.trackListeners.has(track)) return;
    const refresh = () => {
      const current = this.remote.get(endpoint);
      const ended = track.readyState === 'ended';
      if (ended) this.unwatchTrack(track);
      if (ended && current && current[slot] === track) current[slot] = null;
      if (ended && (slot === 'mic' || slot === 'screenAudio')) {
        this.attachAudio(endpoint, null, slot);
      }
      if (this.mode === 'call' || this.mode === 'mini') this.renderTiles();
    };
    this.trackListeners.set(track, refresh);
    track.addEventListener('ended', refresh);
    track.addEventListener('mute', refresh);
    track.addEventListener('unmute', refresh);
  }

  onMedia() {
    if (!this.media) return;
    this.fillSelects();
    this.volume?.setSink(this.media.speakerId);
    this.syncControls();
    this.paintPreview();
    this.showNote(this.media.message || this.media.notice);
    if (this.mode !== 'call' && this.mode !== 'mini') return;
    this.renderTiles();
    this.pushTracks();
    this.updateServer().catch((error) => this.hooks.fail(error));
  }

  readNick() {
    const input = this.host?.querySelector('#prejoin-nick');
    if (!input || input.closest('.nick-field')?.classList.contains('hidden')) {
      return this.hooks.nick();
    }
    const nick = input.value.trim();
    if (nick) this.hooks.saveNick(nick);
    return nick || this.hooks.nick();
  }

  pushTracks() {
    const session = this.session;
    const media = this.media;
    if (!session || !media) return;
    if (media.micTrack) media.micTrack.enabled = media.micOn;
    session.setTrack('mic', media.micTrack);
    if (!media.cameraOn) media.stopCamera();
    const camera = media.cameraOn ? media.cameraTrack : null;
    session.setTrack('camera', camera);
    const screen = media.screenShared ? media.screenTrack : null;
    const screenAudio = media.screenShared ? media.screenAudioTrack : null;
    session.setTrack('screen', screen);
    session.setTrack('screenAudio', screenAudio);
  }

  async updateServer() {
    const session = this.session;
    const media = this.media;
    if (!session || !media) return;
    const live = session.phase === 'joined' || session.phase === 'reconnecting';
    if (!live) return;
    const mic = media.micOn;
    const camera = media.cameraOn;
    const screen = media.screenShared && Boolean(media.screenTrack);
    await this.hooks.update({ mic, camera, screen });
  }

  ensureHost() {
    if (this.host) return;
    const host = document.createElement('div');
    host.className = 'call-stage';
    this.hooks.before(host);
    host.addEventListener('click', (event) => {
      if (this.soundBlocked) this.resumeAudio();
      const button = event.target.closest('[data-action]');
      if (!button) return;
      if (button.dataset.action === 'tile-menu') {
        const tile = button.closest('.call-tile');
        this.tileMenu?.toggle(tile, button);
        return;
      }
      const endpoint = button.closest('[data-endpoint]')?.dataset.endpoint;
      const slot = button.closest('[data-slot]')?.dataset.slot ?? 'camera';
      this.onAction(button.dataset.action, endpoint, slot);
    });
    host.addEventListener(
      'click',
      (event) => {
        this.tileMenu?.press.suppress(event);
      },
      true,
    );
    host.addEventListener('contextmenu', (event) => {
      const tile = event.target.closest('.call-tile');
      if (!tile) return;
      event.preventDefault();
      this.tileMenu?.press.abort();
      this.tileMenu?.open(tile, { x: event.clientX, y: event.clientY });
    });
    host.addEventListener('dblclick', (event) => {
      if (event.target.closest('button, select, summary')) return;
      const tile = event.target.closest('.call-tile');
      if (!tile) return;
      this.togglePin(tile.dataset.endpoint, tile.dataset.slot ?? 'camera');
    });
    host.addEventListener('change', (event) => this.onDevice(event));
    this.host = host;
  }

  viewOf(mode, title) {
    if (mode === 'prejoin') return createPrejoin(title, this.hooks.hasNick());
    if (mode === 'lobby') return createLobby();
    return createCall(title);
  }

  onDevice(event) {
    const select = event.target;
    if (select.id === 'call-layout') this.setLayout(select.value);
    if (select.id === 'call-strip') {
      this.strip = select.value;
      this.renderTiles();
    }
    const media = this.media;
    if (!media) return;
    if (select.id === 'prejoin-camera') media.setCamera(select.value);
    if (select.id === 'prejoin-mic') media.setMic(select.value);
    if (select.id === 'prejoin-speaker') media.setSpeaker(select.value);
  }

  fillSelects() {
    const media = this.media;
    const host = this.host;
    if (!media || !host) return;
    const camera = host.querySelector('#prejoin-camera');
    const mic = host.querySelector('#prejoin-mic');
    fillSelect(camera, media.cameras, media.cameraId, 'camera');
    fillSelect(mic, media.mics, media.micId, 'microphone');
    fillSelect(
      host.querySelector('#prejoin-speaker'),
      media.speakers,
      media.speakerId,
      'speaker',
    );
    const speaker = host.querySelector('.speaker-field');
    speaker?.classList.toggle('hidden', !media.canSink);
  }

  syncControls() {
    const roots = [this.host, this.mini];
    for (const root of roots) {
      if (root) this.paintButtons(root);
    }
    const media = this.media;
    const host = this.host;
    if (!media || !host) return;
    const cameraSelect = host.querySelector('#prejoin-camera');
    const micSelect = host.querySelector('#prejoin-mic');
    const camera = cameraSelect?.closest('.call-field');
    const mic = micSelect?.closest('.call-field');
    camera?.classList.toggle('warn', media.cameraMissing);
    mic?.classList.toggle('warn', media.micMissing);
    const join = host.querySelector('[data-action="join"]');
    if (join) join.disabled = this.joining;
  }

  paintButtons(root) {
    const media = this.media;
    if (!media) return;
    this.paintShare(root);
    const mics = root.querySelectorAll('[data-action="mic"]');
    for (const button of mics) {
      button.textContent = media.micOn ? 'mic on' : 'mic off';
      button.classList.toggle('off', !media.micOn);
      button.classList.toggle('warn', media.micMissing);
    }
    const cameras = root.querySelectorAll('[data-action="camera"]');
    for (const button of cameras) {
      button.textContent = media.cameraOn ? 'camera on' : 'camera off';
      button.classList.toggle('off', !media.cameraOn);
      button.classList.toggle('warn', media.cameraMissing);
    }
  }

  paintShare(root) {
    const media = this.media;
    const controls = root.querySelector('.call-share');
    controls?.classList.toggle('hidden', !media.canScreen);
    const share = root.querySelector('[data-action="share"]');
    if (share) {
      let label = 'share screen';
      if (media.screenTrack) {
        label = media.screenShared ? 'stop sharing' : 'captured, not shared';
      }
      share.textContent = label;
      share.disabled = media.screenPending;
    }
    const motion = root.querySelector('[data-action="screen-motion"]');
    if (motion) {
      const mode = media.screenMotion ? 'on' : 'off';
      motion.textContent = `video mode ${mode}`;
      motion.setAttribute('aria-pressed', `${media.screenMotion}`);
    }
    for (const action of ['share-call', 'capture-local']) {
      const button = root.querySelector(`[data-action="${action}"]`);
      if (button) button.disabled = media.screenPending;
    }
    const stop = root.querySelector('[data-action="stop-screen"]');
    if (stop) stop.disabled = !media.screenTrack;
  }

  paintLevel(level) {
    const bar = this.host?.querySelector('.level-bar');
    if (!bar) return;
    const width = Math.round(level * 100);
    bar.style.width = `${width}%`;
  }

  paintPreview() {
    const preview = this.host?.querySelector('.preview');
    if (!preview || !this.media) return;
    const track = this.media.cameraOn ? this.media.cameraTrack : null;
    const live = track && track.readyState === 'live' ? track : null;
    preview.classList.toggle('local', true);
    const nick = this.hooks.nick() || 'you';
    const color = colorOf(this.session?.endpoint);
    paintPerson(preview, live, nick, color);
  }

  showNote(text) {
    const note = this.host?.querySelector('.call-note');
    if (!note) return;
    const unavailable = this.media && !this.media.canScreen;
    const message = unavailable ? 'Screen capture is unavailable.' : '';
    const notices = [...this.qualityNotices];
    const value = [text, message, ...notices].filter(Boolean).join(' ');
    note.textContent = value;
    note.classList.toggle('hidden', value === '');
  }

  renderTiles() {
    if (this.mode === 'mini') {
      this.paintMini();
      this.updateViewHints();
      return;
    }
    const grid = this.host?.querySelector('.call-grid');
    if (!grid) return;
    const endpoints = this.tileList();
    const seen = new Set(endpoints);
    const tiles = grid.querySelectorAll('.call-tile:not(.screen-tile)');
    for (const tile of tiles) {
      if (!seen.has(tile.dataset.endpoint)) tile.remove();
    }
    for (const endpoint of endpoints) this.paintTile(grid, endpoint);
    this.paintScreens(grid, endpoints);
    this.paintStats();
    this.applyLayout();
    this.paintSpeaking();
    this.paintMini();
    this.updateViewHints();
  }

  observeLayout() {
    const grid = this.host?.querySelector('.call-grid');
    if (!grid) return;
    const resize = () => {
      this.applyLayout();
      this.updateViewHints();
    };
    const Observer = globalThis.ResizeObserver;
    if (typeof Observer === 'function') {
      this.resizeObserver = new Observer(resize);
      this.resizeObserver.observe(grid);
    } else {
      this.#onNotice(
        'Stage resize detection is unavailable; checking each second.',
      );
      this.resizeTimer = setInterval(resize, 1000);
    }
  }

  setLayout(layout) {
    if (!CALL_LAYOUTS.includes(layout)) return;
    this.layout = layout;
    this.renderTiles();
  }

  nextLayout() {
    const index = (CALL_LAYOUTS.indexOf(this.layout) + 1) % CALL_LAYOUTS.length;
    this.setLayout(CALL_LAYOUTS[index]);
  }

  toggleView(option) {
    if (option !== 'hideSelf' && option !== 'hideNoVideo') return;
    this[option] = !this[option];
    this.renderTiles();
  }

  togglePin(endpoint, slot = 'camera') {
    const id = tileId(endpoint, slot);
    this.pin = this.pin === id ? '' : id;
    if (this.pin) this.layout = 'spotlight';
    this.renderTiles();
  }

  async fullscreen(endpoint = '', slot = 'camera') {
    let target = this.host?.querySelector('#call-view');
    if (endpoint) {
      const tiles = this.host?.querySelectorAll('.call-tile') ?? [];
      target = [...tiles].find(
        (tile) =>
          tile.dataset.endpoint === endpoint && tile.dataset.slot === slot,
      );
    }
    if (!target) return;
    const active = document.fullscreenElement;
    if (active === target && typeof document.exitFullscreen === 'function') {
      try {
        await document.exitFullscreen();
      } catch {
        this.#onNotice('The browser could not exit full screen.');
      }
      return;
    }
    if (typeof target.requestFullscreen !== 'function') {
      this.#onNotice('Full screen is unavailable in this browser.');
      return;
    }
    try {
      await target.requestFullscreen();
    } catch {
      this.#onNotice('The browser could not enter full screen.');
    }
  }

  applyLayout() {
    const grid = this.host?.querySelector('.call-grid');
    if (!grid) return;
    const people = this.tileList().map((endpoint) => ({
      endpoint,
      video: Boolean(this.videoTrack(endpoint)),
      screen: Boolean(this.screenTrack(endpoint)),
    }));
    const ids = new Set();
    for (const person of people) {
      ids.add(tileId(person.endpoint));
      if (person.screen) ids.add(tileId(person.endpoint, 'screen'));
    }
    if (this.pin && !ids.has(this.pin)) this.pin = '';
    const hint = this.spotlight;
    const spotlight = ids.has(hint) ? hint : tileId(hint);
    const result = callLayout(people, {
      width: Math.max(0, grid.clientWidth - 16),
      height: Math.max(0, grid.clientHeight - 16),
      self: this.session?.endpoint,
      layout: this.layout,
      strip: this.strip,
      pin: this.pin,
      spotlight,
      speaker: this.levels?.state.speaker,
      hideSelf: this.hideSelf,
      hideNoVideo: this.hideNoVideo,
    });
    const placed = new Map(result.tiles.map((tile) => [tile.id, tile]));
    grid.dataset.layout = result.layout;
    for (const tile of grid.querySelectorAll('.call-tile')) {
      const id = tileId(tile.dataset.endpoint, tile.dataset.slot);
      const position = placed.get(id);
      tile.hidden = !position;
      tile.classList.toggle('pinned', id === this.pin);
      tile.classList.toggle('featured', position?.featured === true);
      if (!position) continue;
      tile.style.left = `${position.x + 8}px`;
      tile.style.top = `${position.y + 8}px`;
      tile.style.width = `${position.width}px`;
      tile.style.height = `${position.height}px`;
    }
    const select = this.host.querySelector('#call-layout');
    if (select) select.value = this.layout;
    const strip = this.host.querySelector('#call-strip');
    if (strip) strip.value = this.strip;
    const options = {
      'hide-self': this.hideSelf,
      'hide-no-video': this.hideNoVideo,
    };
    for (const action in options) {
      const button = this.host.querySelector(`[data-action="${action}"]`);
      button?.setAttribute('aria-pressed', `${options[action]}`);
    }
  }

  paintSpeakingTile(tile, endpoint) {
    const participant = this.levels?.state.participants.get(endpoint);
    const level = participant?.level ?? 0;
    tile.classList.toggle('speaking', participant?.speaking === true);
    tile.style.setProperty('--speaking-ring', `${Math.round(level * 20)}px`);
  }

  paintSpeaking() {
    const tiles =
      this.host?.querySelectorAll('.call-tile:not(.screen-tile)') ?? [];
    for (const tile of tiles) {
      this.paintSpeakingTile(tile, tile.dataset.endpoint);
    }
    if (this.mini) {
      this.paintSpeakingTile(this.mini, this.mini.dataset.endpoint);
    }
  }

  updateViewHints() {
    const root = this.mode === 'mini' ? this.mini : this.host;
    const tiles = root ? [...root.querySelectorAll('.call-tile')] : [];
    if (this.mode === 'mini' && root) tiles.push(root);
    const remote = tiles.filter((tile) => {
      const endpoint = tile.dataset.endpoint;
      return endpoint && endpoint !== this.session?.endpoint;
    });
    this.viewHints?.update(remote);
  }

  paintTile(grid, endpoint) {
    let tile = null;
    const tiles = grid.querySelectorAll('.call-tile:not(.screen-tile)');
    for (const item of tiles) {
      if (item.dataset.endpoint === endpoint) tile = item;
    }
    if (!tile) {
      tile = createTile(endpoint);
      grid.append(tile);
    }
    const local = endpoint === this.session?.endpoint;
    tile.classList.toggle('local', local);
    tile.dataset.slot = 'camera';
    const name = this.nameOf(endpoint);
    const color = colorOf(endpoint);
    paintPerson(tile, this.videoTrack(endpoint), name, color);
    const chip = tile.querySelector('.call-name');
    const mic = local
      ? this.media?.micOn
      : this.people.find((person) => person.endpoint === endpoint)?.mic;
    if (chip) chip.textContent = `${name} · mic ${mic ? 'on' : 'off'}`;
    const poor =
      !local &&
      this.quality.get(endpoint)?.poor === true &&
      !this.session?.isAudioOnly(endpoint);
    tile.querySelector('.call-poor').classList.toggle('hidden', !poor);
  }

  peerOf(endpoint) {
    return (
      this.people.find((person) => person.endpoint === endpoint)?.peer ||
      peerOf(endpoint)
    );
  }

  toggleStats(endpoint = '') {
    if (endpoint) {
      const shown = this.statsAll
        ? !this.statsHidden.has(endpoint)
        : this.statsShown.has(endpoint);
      if (shown) {
        this.statsShown.delete(endpoint);
        this.statsHidden.add(endpoint);
      } else {
        this.statsShown.add(endpoint);
        this.statsHidden.delete(endpoint);
      }
    } else {
      this.statsAll = !this.statsAll;
      this.statsShown.clear();
      this.statsHidden.clear();
    }
    this.paintStats();
  }

  paintStats() {
    const tiles = this.host?.querySelectorAll('.call-tile') ?? [];
    for (const tile of tiles) {
      const endpoint = tile.dataset.endpoint;
      const local = endpoint === this.session?.endpoint;
      const sample = this.stats.get(endpoint);
      const overlay = tile.querySelector('.tile-stats');
      const shown = this.statsAll
        ? !this.statsHidden.has(endpoint)
        : this.statsShown.has(endpoint);
      overlay.classList.toggle('hidden', local || !shown);
      if (!local && shown) overlay.textContent = statsText(sample);
      const bars = tile.querySelector('.connection-bars');
      bars.classList.toggle('hidden', local);
      const count = sample?.bars ?? 0;
      bars.textContent = '▮'.repeat(count) + '▯'.repeat(4 - count);
      const label = count
        ? `Connection quality ${count} of 4`
        : 'Connection quality unavailable';
      bars.setAttribute('aria-label', label);
      bars.title = label;
    }
    const button = this.host?.querySelector('[data-action="stats-overlay"]');
    button?.setAttribute('aria-pressed', `${this.statsAll}`);
  }

  screenTrack(endpoint) {
    if (endpoint === this.session?.endpoint) {
      const track = this.media?.screenTrack;
      return track?.readyState === 'live' ? track : null;
    }
    const sharing = this.people.some(
      (person) => person.endpoint === endpoint && person.screen,
    );
    if (!sharing) return null;
    const track = this.remote.get(endpoint)?.screen;
    return track?.readyState === 'live' ? track : null;
  }

  paintScreens(grid, endpoints) {
    for (const tile of grid.querySelectorAll('.screen-tile')) {
      if (!this.screenTrack(tile.dataset.endpoint)) {
        showTrack(tile.querySelector('video'), null, false);
        tile.remove();
      }
    }
    for (const endpoint of endpoints) {
      const track = this.screenTrack(endpoint);
      if (!track) continue;
      let tile = null;
      for (const item of grid.querySelectorAll('.screen-tile')) {
        if (item.dataset.endpoint === endpoint) tile = item;
      }
      if (!tile) {
        tile = createTile(endpoint);
        tile.classList.add('screen-tile');
        tile.dataset.slot = 'screen';
        tile.querySelector('.avatar-wrap').remove();
        grid.append(tile);
      }
      showTrack(tile.querySelector('video'), track, false);
      const local = endpoint === this.session?.endpoint;
      const localOnly = local && !this.media.screenShared;
      const label = localOnly ? 'captured, not shared' : 'screen';
      tile.querySelector('.call-name').textContent =
        `${this.nameOf(endpoint)} · ${label}`;
    }
  }

  paintMini() {
    const mini = this.mini;
    if (!mini || !this.session) return;
    const endpoint = this.featured();
    mini.dataset.endpoint = endpoint;
    const local = endpoint === this.session.endpoint;
    mini.classList.toggle('local', local);
    const name = this.nameOf(endpoint);
    const color = colorOf(endpoint);
    paintPerson(mini, this.videoTrack(endpoint), name, color);
    this.paintSpeakingTile(mini, endpoint);
  }

  tileList() {
    const endpoints = [];
    const seen = new Set();
    const add = (endpoint) => {
      if (!endpoint || seen.has(endpoint)) return;
      seen.add(endpoint);
      endpoints.push(endpoint);
    };
    for (const person of this.people) add(person.endpoint);
    add(this.session?.endpoint);
    return endpoints;
  }

  featured() {
    const speaker = this.levels?.state.speaker;
    if (speaker && this.tileList().includes(speaker)) return speaker;
    for (const endpoint of this.tileList()) {
      if (endpoint === this.session?.endpoint) continue;
      if (this.videoTrack(endpoint)) return endpoint;
    }
    return this.session?.endpoint ?? '';
  }

  videoTrack(endpoint) {
    if (endpoint === this.session?.endpoint) {
      const track = this.media?.cameraTrack;
      const live = track && track.readyState === 'live' && this.media.cameraOn;
      return live ? track : null;
    }
    if (this.session?.isAudioOnly(endpoint)) return null;
    let listed = false;
    let cameraOn = false;
    for (const person of this.people) {
      if (person.endpoint !== endpoint) continue;
      listed = true;
      cameraOn = person.camera === true;
      break;
    }
    if (listed && !cameraOn) return null;
    const track = this.remote.get(endpoint)?.camera ?? null;
    const live = track && track.readyState === 'live' && !track.muted;
    if (!live) return null;
    return track;
  }

  nameOf(endpoint) {
    if (endpoint === this.session?.endpoint) return this.hooks.nick() || 'you';
    for (const person of this.people) {
      if (person.endpoint === endpoint) return person.nick || 'guest';
    }
    return 'guest';
  }

  attachAudio(endpoint, track, slot = 'mic') {
    const key = slot === 'mic' ? endpoint : `${endpoint}:${slot}`;
    let current = this.audios.get(key) ?? null;
    const live = track && track.readyState === 'live';
    if (!live) {
      if (current) this.volume?.detach(current);
      current?.remove();
      if (current) current.srcObject = null;
      this.audios.delete(key);
      return;
    }
    const before = current?.srcObject?.getAudioTracks?.()[0];
    if (current && before !== track) {
      this.volume?.detach(current);
      current.srcObject = null;
      current.remove();
      current = null;
    }
    const audio = current ?? document.createElement('audio');
    audio.autoplay = true;
    const playing = audio.srcObject?.getAudioTracks?.()[0] ?? null;
    if (playing !== track) audio.srcObject = streamOf(track);
    this.audios.set(key, audio);
    audio.dataset.slot = slot;
    audio.dataset.endpoint = endpoint;
    this.parkAudios();
    this.media?.applySink(audio);
    this.volume?.attach(audio, this.peerOf(endpoint));
    audio.play().catch(() => {
      this.soundBlocked = true;
      this.showNote('Click to enable sound.');
    });
  }

  resumeAudio() {
    this.volume?.resume();
    this.soundBlocked = false;
    this.showNote('');
    for (const audio of this.audios.values()) {
      audio.play().catch(() => {
        this.soundBlocked = true;
        this.showNote('Click to enable sound.');
      });
    }
  }

  parkAudios() {
    if (!this.host) return;
    for (const audio of this.audios.values()) this.host.append(audio);
  }

  stopAudios() {
    for (const audio of this.audios.values()) {
      this.volume?.detach(audio);
      audio.srcObject = null;
      audio.remove();
    }
    this.audios.clear();
  }
}

export { CallStage, RingAlert };
