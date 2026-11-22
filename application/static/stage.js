import { ParticipantVolume } from './call-volume.js';
import { TileMenu } from './call-tile-menu.js';
import { peerOf, colorOf, initialsOf } from './avatar.js';
import { statsText } from './call-stats.js';
import { trackOf } from './members.js';
import { MediaCapture, CallLevels, isMobile } from './media.js';
import { pausesCameraInBackground } from './media.js';
import { requestCallNotifications } from './notifications.js';
import { notificationClient } from './notifications.js';
import { ViewHints } from './view-hints.js';
import { CallRecording } from './call-record.js';
import { Streaming } from './streaming.js';
import { createRecordPanel, createRecordControl } from './record-panel.js';
import { createButton } from './record-panel.js';
import {
  Studio,
  createStudioPanel,
  createStageLists,
  stageMove,
} from './studio.js';
import { CALL_LAYOUTS, STRIP_POSITIONS } from './call-layout.js';
import { tileId, callLayout } from './call-layout.js';
import { REACTIONS, REACTION_SHOW_MS, isReaction } from './call-hands.js';
import { orderOf, rosterOf, createLimiter } from './call-hands.js';
import { takeReaction, createAutoLower, stepAutoLower } from './call-hands.js';
import { shortcutOf, isTalkKey, createTalk, stepTalk } from './call-keys.js';
import { helpOf } from './call-keys.js';
import {
  syncFields,
  settingField,
  deviceField,
  fillDevice,
} from './call-preferences.js';
import {
  DEFAULTS,
  createToast,
  addToast,
  showsToast,
  toastText,
  TOAST_SHOW_MS,
  titleOf,
} from './call-settings.js';

const PHONE = '(max-width: 600px), (pointer: coarse) and (max-width: 900px)';
const phoneView = () => matchMedia(PHONE).matches;

const LEAVE_RECORDING =
  'You are recording this call. Stop the recording and leave?';
const LEAVE_LIVE = 'You are live. Stop the stream and leave?';
const LEAVE_BOTH = 'You are recording and live. Stop both and leave?';

const leaveText = (isRecording, isLive) => {
  if (isRecording && isLive) return LEAVE_BOTH;
  return isLive ? LEAVE_LIVE : LEAVE_RECORDING;
};

const LOBBY = 'waiting for an admin to let you in';
const LOCKED = 'Call is locked';
const FULL = 'Call is full';
const ADMISSION = {
  open: { token: 'join', other: 'join' },
  link: { token: 'join', other: 'lobby' },
  approval: { token: 'lobby', other: 'lobby' },
};
const TONE_HZ = 440;
const RING_MS = 1600;
const RING_PATTERN = [280, 120, 280, 920];
const PIP_SIZE = { width: 360, height: 300 };
const PIP_MISSING = 'Picture-in-picture is not available in this browser';
const HINTS = {
  mic: 'Mute and unmute (Ctrl D, hold Space to talk)',
  camera: 'Camera on and off (Ctrl E)',
  share: 'Share screen and stop (Ctrl Alt S)',
  hand: 'Raise and lower hand (Ctrl Alt H)',
  fullscreen: 'Full screen stage (F)',
};

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
  hand: (stage) => stage.toggleHand(),
  'opt-out': (stage) => stage.toggleOptOut(),
  record: (stage) => stage.recording?.toggle(),
  'record-pause': (stage) => stage.recording?.togglePause(),
  'record-panel': (stage) => stage.toggleProgramPanel('record'),
  studio: (stage) => stage.toggleProgramPanel('studio'),
  'go-live': (stage) => stage.streaming?.toggle(),
  'stop-live': (stage) => stage.streaming?.stop(),
  'record-background': (stage) => stage.recording?.resetBackground(),
  recordings: (stage) => {
    stage.closeMenus();
    stage.hooks.recordings();
  },
  layout: (stage) => stage.nextLayout(),
  pip: (stage) => stage.openPip(),
  'pip-back': (stage) => stage.closePip(true),
  expand: (stage) => stage.expand(),
  'switch-camera': (stage) => stage.media?.switchCamera(),
  people: (stage) => stage.openSheet('people'),
  chat: (stage) => stage.openSheet('chat'),
  'close-sheet': (stage) => stage.closeSheet(),
  settings: (stage) => {
    stage.closeMenus();
    stage.hooks.settings();
  },
};

const HOST_ACTIONS = {
  'ask-mute': (stage, endpoint) => {
    const person = stage.personOf(endpoint);
    const action = person?.mic === false ? 'unmute' : 'mute';
    return stage.command(action, endpoint);
  },
  'stop-camera': (stage, endpoint) => stage.command('stopCamera', endpoint),
  'stop-remote-screen': (stage, endpoint) =>
    stage.command('stopScreen', endpoint),
  spotlight: (stage, endpoint) => {
    const value = stage.spotlight === endpoint ? '' : endpoint;
    return stage.command('spotlight', '', value);
  },
  promote: (stage, endpoint) => stage.command('promote', endpoint),
  demote: (stage, endpoint) => stage.command('demote', endpoint),
  remove: (stage, endpoint) => stage.command('remove', endpoint),
  'move-to-stage': (stage, endpoint) => stage.command('stage', endpoint, true),
  'move-to-backstage': (stage, endpoint) =>
    stage.command('stage', endpoint, false),
  'mute-all': (stage) => stage.command('muteAll'),
  'lower-hand': (stage, endpoint) => stage.command('lowerHand', endpoint),
  'lower-hands': (stage) => stage.command('lowerHands'),
  lock: (stage) => stage.command(stage.locked ? 'unlock' : 'lock'),
  end: (stage) => stage.endForAll(),
  'accept-unmute': (stage) => stage.acceptUnmute(),
};

const REMOTE_REQUEST = {
  mute: (nick) => `${nick} muted you`,
  stopCamera: (nick) => `${nick} stopped your camera`,
  stopScreen: (nick) => `${nick} stopped your screen`,
};

const POLICIES = ['open', 'link', 'approval'];

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

const showTrack = (video, track) => {
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
    showTrack(video, track);
  }
  wrap?.classList.toggle('hidden', live);
  if (!avatar || live) return;
  avatar.style.background = color;
  avatar.textContent = initialsOf(name);
};

const admissionOf = (preview, token) => {
  if (!preview) return { action: 'join', reason: '' };
  const direct = preview.kind === 'direct';
  if (direct || preview.admin === true) return { action: 'join', reason: '' };
  if (preview.locked === true) return { action: 'locked', reason: LOCKED };
  const rule = ADMISSION[preview.policy] ?? ADMISSION.link;
  const action = token ? rule.token : rule.other;
  const blocked = action === 'join' && preview.full === true;
  if (blocked) return { action: 'full', reason: FULL };
  return { action, reason: '' };
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

const createHostControls = () => {
  const box = document.createElement('div');
  box.className = 'call-host hidden';
  const policy = createField('call-policy', 'policy');
  const select = policy.querySelector('select');
  for (const value of POLICIES) {
    const option = document.createElement('option');
    option.value = value;
    option.textContent = value;
    select.append(option);
  }
  const muteAll = createButton('mute-all', 'Mute all');
  const lock = createButton('lock', 'Lock');
  const lower = createButton('lower-hands', 'Lower all hands');
  box.append(muteAll, lower, lock, policy);
  return box;
};

const createPeople = () => {
  const aside = document.createElement('aside');
  aside.className = 'call-people';
  const lobby = document.createElement('div');
  lobby.className = 'call-lobby hidden';
  const roster = document.createElement('div');
  roster.className = 'call-people-roster';
  const copy = createButton('copy-link', 'copy link');
  copy.classList.add('hidden');
  const optOut = createButton('opt-out', 'opt out of recordings');
  optOut.classList.add('people-opt-out');
  optOut.setAttribute('aria-pressed', 'false');
  aside.append(
    createButton('close-sheet', 'close people'),
    lobby,
    roster,
    optOut,
    createHostControls(),
    copy,
  );
  return aside;
};

const createCaptureControl = (name) => {
  const wrap = document.createElement('div');
  wrap.className = 'call-device';
  wrap.append(createButton(name, `${name} on`));
  const menu = document.createElement('details');
  const summary = document.createElement('summary');
  summary.textContent = '▾';
  summary.setAttribute('aria-label', `${name} options`);
  const choices = document.createElement('div');
  choices.className = 'share-menu';
  choices.append(deviceField(name));
  if (name === 'mic') {
    choices.append(settingField('noise'), settingField('pushToTalk'));
  } else {
    choices.append(
      settingField('mirror'),
      createButton('switch-camera', 'switch front/back camera'),
    );
  }
  menu.append(summary, choices);
  wrap.append(menu);
  return wrap;
};

const createHand = () => createButton('hand', 'raise hand');

const isControl = (element) =>
  Boolean(element?.closest?.('button, summary, select, input, a'));

const pipSupported = () => {
  const api = globalThis.documentPictureInPicture;
  return typeof api?.requestWindow === 'function';
};

const createMore = (hasStudio) => {
  const wrap = document.createElement('div');
  wrap.className = 'call-more';
  const menu = document.createElement('details');
  const summary = document.createElement('summary');
  summary.textContent = 'more';
  summary.setAttribute('aria-label', 'more options');
  const choices = document.createElement('div');
  choices.className = 'share-menu';
  const pip = createButton('pip', 'picture-in-picture');
  const note = document.createElement('p');
  note.className = 'call-pip-note';
  note.setAttribute('role', 'status');
  if (!pipSupported()) {
    pip.disabled = true;
    note.textContent = PIP_MISSING;
  }
  const keys = document.createElement('dl');
  keys.className = 'call-keys';
  for (const row of helpOf()) {
    const name = document.createElement('dt');
    name.textContent = row.keys;
    const text = document.createElement('dd');
    text.textContent = row.label;
    keys.append(name, text);
  }
  const stopLive = createButton('stop-live', 'Stop live');
  stopLive.hidden = true;
  if (hasStudio) choices.append(createButton('studio', 'Studio'), stopLive);
  choices.append(pip, createButton('settings', 'call settings'), note, keys);
  menu.append(summary, choices);
  wrap.append(menu);
  return wrap;
};

const createReact = () => {
  const wrap = document.createElement('div');
  wrap.className = 'call-react';
  const menu = document.createElement('details');
  const summary = document.createElement('summary');
  summary.textContent = 'react';
  summary.setAttribute('aria-label', 'reactions');
  const choices = document.createElement('div');
  choices.className = 'share-menu react-menu';
  for (const emoji of REACTIONS) {
    const button = createButton('react', emoji);
    button.dataset.emoji = emoji;
    button.setAttribute('aria-label', `react ${emoji}`);
    choices.append(button);
  }
  menu.append(summary, choices);
  wrap.append(menu);
  return wrap;
};

const createLeave = () => {
  const wrap = document.createElement('div');
  wrap.className = 'call-leave';
  wrap.append(createButton('leave', 'leave'));
  const menu = document.createElement('details');
  menu.className = 'leave-menu hidden';
  const summary = document.createElement('summary');
  summary.textContent = '▾';
  summary.setAttribute('aria-label', 'leave options');
  const choices = document.createElement('div');
  choices.className = 'share-menu';
  choices.append(createButton('end', 'End for everyone'));
  menu.append(summary, choices);
  wrap.append(menu);
  return wrap;
};

const createPrompt = () => {
  const row = document.createElement('div');
  row.className = 'call-prompt hidden';
  const text = document.createElement('span');
  row.append(text, createButton('accept-unmute', 'unmute'));
  return row;
};

const createKnock = (item) => {
  const toast = document.createElement('aside');
  toast.className = 'knock';
  toast.dataset.endpoint = item.endpoint;
  const text = document.createElement('p');
  const nick = item.nick || 'someone';
  text.textContent = `${nick} wants to join`;
  const actions = document.createElement('div');
  actions.className = 'knock-actions';
  const admit = createButton('admit', 'admit');
  const deny = createButton('deny', 'deny');
  actions.append(admit, deny);
  toast.append(text, actions);
  return toast;
};

const createCall = (title, hasStudio) => {
  const section = document.createElement('section');
  section.id = 'call-view';
  const bar = document.createElement('header');
  bar.className = 'call-topbar';
  const back = createButton('back', '‹');
  back.setAttribute('aria-label', 'back');
  const heading = document.createElement('span');
  heading.className = 'chat-title';
  heading.textContent = title;
  const recording = document.createElement('span');
  recording.className = 'call-recording hidden';
  const live = document.createElement('span');
  live.className = 'call-live hidden';
  const backstage = document.createElement('span');
  backstage.className = 'call-backstage';
  backstage.textContent = 'backstage';
  backstage.hidden = true;
  const optOut = createButton('opt-out', 'opt out');
  optOut.classList.add('call-opt-out', 'hidden');
  optOut.setAttribute('aria-pressed', 'false');
  bar.append(
    back,
    heading,
    recording,
    live,
    backstage,
    optOut,
    createButton('people', 'people'),
    createButton('chat', 'chat'),
    createLayoutControls(),
  );
  const grid = document.createElement('div');
  grid.className = 'call-grid';
  const strip = document.createElement('div');
  strip.className = 'phone-strip';
  strip.tabIndex = 0;
  strip.setAttribute('aria-label', 'Other call tiles');
  strip.setAttribute('role', 'region');
  strip.hidden = true;
  grid.append(strip);
  const body = document.createElement('div');
  body.className = 'call-body';
  body.append(grid, createPeople(), createRecordPanel());
  if (hasStudio) body.append(createStudioPanel());
  const controls = document.createElement('footer');
  controls.className = 'call-controls';
  controls.append(
    createCaptureControl('mic'),
    createCaptureControl('camera'),
    createButton('enable-sound', 'Enable sound'),
    createLeave(),
  );
  const leave = controls.lastElementChild;
  controls.insertBefore(createShare(), leave);
  controls.insertBefore(createHand(), leave);
  controls.insertBefore(createReact(), leave);
  controls.insertBefore(createRecordControl(), leave);
  controls.insertBefore(createMore(hasStudio), leave);
  const note = document.createElement('p');
  note.className = 'call-note hidden';
  note.setAttribute('role', 'status');
  section.append(bar, note, createPrompt(), body, controls);
  for (const action of Object.keys(HINTS)) {
    const button = section.querySelector(`[data-action="${action}"]`);
    if (button) button.title = HINTS[action];
  }
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
    createButton('expand', 'expand'),
    createButton('enable-sound', 'Enable sound'),
  );
  tile.append(createVideo(true), createAvatar(), controls);
  return tile;
};

const createPip = () => {
  const root = document.createElement('div');
  root.id = 'pip-call';
  const name = document.createElement('span');
  name.className = 'pip-name';
  const controls = document.createElement('div');
  controls.className = 'pip-controls';
  const back = createButton('pip-back', '‹');
  back.setAttribute('aria-label', 'back to the call');
  const mic = createButton('mic', 'mic on');
  const camera = createButton('camera', 'camera on');
  mic.title = HINTS.mic;
  camera.title = HINTS.camera;
  controls.append(back, mic, camera, createHand(), createReact());
  controls.append(
    createButton('leave', 'leave'),
    createButton('enable-sound', 'Enable sound'),
  );
  root.append(createVideo(true), createAvatar(), name, controls);
  return root;
};

const copyStyles = (target) => {
  const theme = document.documentElement.dataset.theme;
  if (theme) target.documentElement.dataset.theme = theme;
  for (const sheet of document.styleSheets) {
    try {
      const rules = Array.from(sheet.cssRules, (rule) => rule.cssText);
      const style = target.createElement('style');
      style.textContent = rules.join('\n');
      target.head.append(style);
    } catch {
      if (!sheet.href) continue;
      const link = target.createElement('link');
      link.rel = 'stylesheet';
      link.href = sheet.href;
      target.head.append(link);
    }
  }
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
  const hand = document.createElement('span');
  hand.className = 'call-hand-badge hidden';
  tile.append(createVideo(true), createAvatar(), name, bars, menu, stats, poor);
  tile.append(hand);
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
  #onRelay = null;
  #onCall = null;
  #listening = false;
  #onNotice = null;
  #onQuality = null;
  #onStats = null;
  #onDenied = null;
  #onRequest = null;
  #onRemoved = null;
  #onMessage = null;
  #onKeyUp = null;
  #onBlur = null;
  #onClick = null;
  #onPipClose = null;

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
    this.lobby = [];
    this.preview = null;
    this.isAdmin = false;
    this.hostPeer = '';
    this.policy = '';
    this.locked = false;
    this.joinBackstage = false;
    this.prompt = '';
    this.kind = '';
    this.mediaNote = '';
    this.knocks = null;
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
    this.recording = null;
    this.studio = null;
    this.streaming = null;
    this.desktopPanel = '';
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
    this.hands = new Map();
    this.preferences = DEFAULTS;
    this.sheet = '';
    this.wakeRequest = null;
    this.wakeLock = null;
    this.toast = createToast();
    this.toastTimer = null;
    this.announcements = null;
    this.onVisibility = () => this.updateVisibility();
    this.phone = null;
    this.onPhone = () => this.updatePhone();
    this.lowerState = createAutoLower();
    this.sendLimiter = createLimiter();
    this.limiters = new Map();
    this.floats = new Set();
    this.pip = null;
    this.talk = createTalk();
    this.#onKey = (event) => this.onKey(event);
    this.#onPhase = (phase) => this.onPhase(phase);
    this.#onTrack = (payload) => this.onRemoteTrack(payload);
    this.#onRelay = (endpoint) => this.onRelay(endpoint);
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
    this.#onDenied = () => {
      this.hooks.notice?.('The admin did not let you in');
    };
    this.#onRequest = (data) => {
      this.onRequest(data).catch((error) => this.hooks.fail(error));
    };
    this.#onRemoved = (data) => this.onRemoved(data);
    this.#onMessage = (payload) => this.onPeerMessage(payload);
    this.#onKeyUp = (event) => this.onKeyUp(event);
    this.#onBlur = () => this.talkStep('blur');
    this.#onClick = (event) => this.onClick(event);
    this.#onPipClose = () => this.closePip(false);
  }

  attach(session, token, camera = true) {
    this.detach();
    this.session = session;
    this.token = token;
    this.chat = session.chat;
    this.joining = false;
    this.people = [];
    this.lobby = [];
    this.preview = null;
    this.isAdmin = false;
    this.hostPeer = '';
    this.policy = '';
    this.locked = false;
    this.prompt = '';
    this.kind = '';
    this.mediaNote = '';
    this.remote = new Map();
    this.volume = new ParticipantVolume(this.#onNotice);
    this.tileMenu = new TileMenu(this);
    this.media = new MediaCapture();
    this.announcements = document.getElementById('call-announcements');
    this.phone = matchMedia(PHONE);
    this.preferences = this.hooks.preferences.settings;
    this.recording = new CallRecording(this, this.preferences);
    if (typeof MediaRecorder === 'function') this.studio = new Studio(this);
    this.streaming = new Streaming(this);
    this.media.cameraOn = camera && !this.preferences.joinCameraOff;
    this.media.micOn = !this.preferences.joinMicOff;
    this.media.noise = this.preferences.noise;
    this.media.mirrorOn = this.preferences.mirror;
    this.media.mirrorState = this.preferences.mirror ? '' : 'off';
    this.media.onChange = () => this.onMedia();
    this.media.onLevel = (level) => this.paintLevel(level);
    this.levels = new CallLevels(session, this.media, () => this.people);
    this.levels.on('levels', () => {
      this.paintSpeaking();
      this.checkAutoLower();
    });
    this.levels.on('speaker', () => this.renderTiles());
    this.levels.on('notice', this.#onNotice);
    session.on('state', this.#onPhase);
    session.on('track', this.#onTrack);
    session.on('relay', this.#onRelay);
    session.on('notice', this.#onNotice);
    session.on('quality', this.#onQuality);
    session.on('stats', this.#onStats);
    session.on('denied', this.#onDenied);
    session.on('request', this.#onRequest);
    session.on('removed', this.#onRemoved);
    session.on('message', this.#onMessage);
    this.hands = new Map();
    this.lowerState = createAutoLower();
    this.sendLimiter = createLimiter();
    this.limiters = new Map();
    this.viewHints = new ViewHints(
      (endpoint, hint) => session.setViewHint(endpoint, hint),
      this.#onNotice,
    );
    this.hooks.listen(this.#onCall);
    this.talk = createTalk();
    document.addEventListener('keydown', this.#onKey, true);
    document.addEventListener('keyup', this.#onKeyUp, true);
    document.addEventListener('visibilitychange', this.onVisibility);
    this.phone.addEventListener?.('change', this.onPhone);
    window.addEventListener('blur', this.#onBlur);
    this.#listening = true;
    this.mount('prejoin');
    this.media.openPreview().catch((error) => this.hooks.fail(error));
  }

  detach() {
    const session = this.session;
    this.streaming?.dispose();
    this.streaming = null;
    this.recording?.dispose();
    this.recording = null;
    this.studio?.dispose();
    this.studio = null;
    this.desktopPanel = '';
    this.releaseWake();
    this.closeSheet();
    this.hooks.popLayer('call');
    clearTimeout(this.toastTimer);
    this.toast = createToast();
    document.getElementById('call-toast').hidden = true;
    this.closePip(false);
    if (session) {
      session.off('state', this.#onPhase);
      session.off('track', this.#onTrack);
      session.off('relay', this.#onRelay);
      session.off('notice', this.#onNotice);
      session.off('quality', this.#onQuality);
      session.off('stats', this.#onStats);
      session.off('denied', this.#onDenied);
      session.off('request', this.#onRequest);
      session.off('removed', this.#onRemoved);
      session.off('message', this.#onMessage);
    }
    for (const timer of this.floats) clearTimeout(timer);
    this.floats.clear();
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
      document.removeEventListener('keyup', this.#onKeyUp, true);
      document.removeEventListener('visibilitychange', this.onVisibility);
      this.phone.removeEventListener?.('change', this.onPhone);
      window.removeEventListener('blur', this.#onBlur);
      this.#listening = false;
    }
    this.talkStep('cancel');
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
    this.soundBlocked = false;
    this.people = [];
    this.lobby = [];
    this.preview = null;
    this.isAdmin = false;
    this.hostPeer = '';
    this.policy = '';
    this.locked = false;
    this.joinBackstage = false;
    this.prompt = '';
    this.kind = '';
    this.mediaNote = '';
    this.knocks?.remove();
    this.knocks = null;
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
    this.closePip(false);
    this.mini?.remove();
    this.mini = null;
    this.parkAudios();
    if (mode === 'prejoin') this.onMedia();
    if (mode === 'call') {
      this.updatePhone();
      this.updateVisibility();
      this.fillSelects();
      this.levels?.start();
      this.observeLayout();
      this.syncControls();
      this.paintPrompt();
      this.showNote(this.media?.message || this.media?.notice || '');
      this.renderTiles();
      this.paintPeople();
      this.paintRecording();
      this.paintLive();
      this.paintBackstage();
      this.studio?.paint();
      this.hooks.focusChat(this.chat);
      this.hooks.changed();
    }
  }

  showLobby() {
    this.joining = false;
    this.mount('lobby');
  }

  showCall(state) {
    if (state && !this.personOf(this.session?.endpoint)) {
      this.onCallState(state);
    }
    this.joining = false;
    this.mount('call');
  }

  collapse() {
    if (this.mode !== 'call') return;
    this.tileMenu?.close(false);
    this.closeSheet();
    this.hooks.popLayer('call');
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

  updatePhone() {
    if (this.mode !== 'call') return;
    if (phoneView()) {
      this.hooks.pushLayer('call');
    } else {
      this.closeSheet();
      this.hooks.popLayer('call');
    }
    this.renderTiles();
    this.recording?.paint();
  }

  get programPanel() {
    if (this.mode !== 'call') return '';
    if (!this.phone?.matches) return this.desktopPanel;
    if (this.sheet === 'record' || this.sheet === 'studio') return this.sheet;
    return '';
  }

  toggleProgramPanel(name) {
    if (this.mode !== 'call') return;
    this.closeMenus();
    const open = this.programPanel === name;
    if (this.phone?.matches) {
      if (open) this.closeSheet();
      else this.openSheet(name);
    } else {
      this.desktopPanel = open ? '' : name;
      this.recording?.paint();
    }
  }

  closeProgramPanel() {
    if (this.phone?.matches || !this.programPanel) return false;
    this.desktopPanel = '';
    this.recording?.paint();
    return true;
  }

  openSheet(name) {
    if (!phoneView() || this.mode !== 'call') return;
    const isFirst = this.sheet === '';
    this.sheet = name;
    this.root.dataset.callSheet = name;
    if (isFirst) this.hooks.pushLayer('callSheet');
    const panels = {
      people: '.call-people button',
      record: '.call-record button',
      studio: '.call-studio button',
    };
    this.recording?.paint();
    const panel = panels[name];
    const close = panel
      ? this.host.querySelector(panel)
      : this.root.querySelector('.close-call-chat');
    close?.focus();
  }

  hideSheet() {
    if (!this.sheet) return;
    const triggers = {
      record: '.call-record-control [data-action="record"]',
      studio: '.call-more summary',
    };
    const selector = triggers[this.sheet] ?? `[data-action="${this.sheet}"]`;
    const trigger = this.host?.querySelector(selector);
    this.sheet = '';
    delete this.root.dataset.callSheet;
    trigger?.focus();
    this.recording?.paint();
  }

  closeSheet() {
    if (!this.sheet) return;
    this.hideSheet();
    this.hooks.popLayer('callSheet');
  }

  releaseWake() {
    this.wakeRequest = null;
    if (this.wakeLock) this.wakeLock.release().catch(() => undefined);
    this.wakeLock = null;
  }

  async updateVisibility() {
    if (document.hidden) this.talkStep('blur');
    const active = this.mode === 'call' || this.mode === 'mini';
    if (!active) return;
    if (pausesCameraInBackground()) {
      this.media
        ?.setCameraPaused(document.hidden)
        .catch((error) => this.hooks.fail(error));
    }
    if (document.hidden || !(isMobile() || phoneView())) {
      return void this.releaseWake();
    }
    if (this.wakeRequest || this.wakeLock) return;
    if (!navigator.wakeLock?.request) {
      this.#onNotice('Screen wake lock unavailable in this browser.');
      return;
    }
    const request = navigator.wakeLock.request('screen');
    this.wakeRequest = request;
    try {
      const lock = await request;
      if (request !== this.wakeRequest) {
        await lock.release();
        return;
      }
      this.wakeLock = lock;
      lock.addEventListener('release', () => {
        if (this.wakeLock === lock) this.wakeLock = null;
      });
    } catch {
      if (this.wakeRequest === request) {
        this.#onNotice('Could not keep the screen awake.');
      }
    } finally {
      if (this.wakeRequest === request) this.wakeRequest = null;
    }
  }

  expand() {
    if (this.mode !== 'mini') return;
    this.showCall();
  }

  onMiniClick(event) {
    const button = event.target.closest('[data-action]');
    if (button && event.detail > 0) button.blur();
    if (button) return void this.onAction(button.dataset.action);
    this.expand();
  }

  onAction(action, endpoint = '', slot = 'camera') {
    if (action === 'enable-sound') return void this.resumeAudio(true);
    if (action === 'tile-stats') return void this.toggleStats(endpoint);
    if (action === 'pin') return void this.togglePin(endpoint, slot);
    if (action === 'tile-fullscreen') {
      return void this.fullscreen(endpoint, slot);
    }
    if (action === 'admit') return void this.admit(endpoint);
    if (action === 'deny') return void this.deny(endpoint);
    if (action === 'admit-all') return void this.admitAll();
    if (action === 'copy-link') return void this.copyLink();
    const hostAction = HOST_ACTIONS[action];
    if (hostAction) {
      const result = hostAction(this, endpoint);
      if (result?.catch) result.catch((error) => this.hooks.fail(error));
      return;
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
    const { panel } = this.root.dataset;
    if (event.key === 'Escape' && ['calls', 'recordings'].includes(panel)) {
      event.preventDefault();
      event.stopImmediatePropagation();
      this.hooks.closeSidePanel();
      return;
    }
    if (event.target.closest?.('.recordings-player')) return;
    if (event.key === 'Escape' && this.tileMenu?.menu.isOpen) {
      event.preventDefault();
      event.stopImmediatePropagation();
      this.tileMenu.close();
      return;
    }
    if (event.key === 'Escape' && this.closeMenus()) {
      event.preventDefault();
      event.stopImmediatePropagation();
      return;
    }
    if (event.key === 'Escape' && this.closeProgramPanel()) {
      event.preventDefault();
      event.stopImmediatePropagation();
      return;
    }
    if (event.key === 'Escape' && this.sheet) {
      event.preventDefault();
      event.stopImmediatePropagation();
      this.closeSheet();
      return;
    }
    if (this.tileMenu?.menu.contains(event.target)) return;
    if (this.mode === 'prejoin' && event.target.closest?.('#panel')) return;
    if (this.mode === 'prejoin') return void this.onPrejoinKey(event);
    if (this.mode !== 'call' && this.mode !== 'mini') return;
    this.onCallKey(event);
  }

  onKeyUp(event) {
    const isSpace = event.code === 'Space' || event.key === ' ';
    if (!isSpace || !this.talk.held) return;
    if (!event.target.closest?.('.recordings-player')) {
      event.preventDefault();
      event.stopPropagation();
    }
    this.talkStep('up');
  }

  closeMenus() {
    const roots = [this.host, this.mini, this.pip?.root];
    let closed = false;
    for (const root of roots) {
      const open = root ? root.querySelectorAll('details[open]') : [];
      for (const menu of open) {
        const summary = menu.querySelector('summary');
        const inside = menu.contains(menu.ownerDocument.activeElement);
        menu.open = false;
        closed = true;
        if (inside) summary?.focus();
      }
    }
    return closed;
  }

  onPrejoinKey(event) {
    const isEsc = event.key === 'Escape';
    const isEnter = event.key === 'Enter' && !event.isComposing;
    if (!isEsc && !isEnter) return;
    if (isEnter && isControl(event.target)) return;
    event.preventDefault();
    event.stopPropagation();
    if (isEsc) this.cancel();
    else this.join();
  }

  onCallKey(event) {
    const typing = this.hooks.isText(event.target);
    if (isTalkKey(event)) return void this.onTalkKey(event, typing);
    const row = shortcutOf(event);
    if (!row || (typing && !row.command)) return;
    const stage = this.mode === 'call';
    if (!stage && (row.action === 'fullscreen' || row.action === 'layout')) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    this.onAction(row.action);
  }

  onTalkKey(event, typing) {
    if (!this.preferences.pushToTalk || typing || isControl(event.target)) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    if (event.repeat) return;
    this.talkStep('down');
  }

  talkStep(kind) {
    const media = this.media;
    if (!media) {
      this.talk = createTalk();
      return;
    }
    const step = stepTalk(this.talk, kind, media.micOn);
    this.talk = step.state;
    if (!step.unmute && !step.mute) return;
    media.resume();
    media.toggleMic().catch((error) => this.hooks.fail(error));
  }

  async join() {
    if (this.mode !== 'prejoin' || this.joining || !this.session) return;
    const admission = admissionOf(this.preview, this.token);
    const blocked =
      admission.action === 'locked' || admission.action === 'full';
    if (blocked) return;
    requestCallNotifications();
    this.joining = true;
    this.syncControls();
    const nick = this.readNick();
    try {
      if (this.hooks.ready) await this.hooks.ready();
      if (this.mode !== 'prejoin' || !this.session) return;
      const next = admissionOf(this.preview, this.token);
      const stopped = next.action === 'locked' || next.action === 'full';
      if (stopped) {
        this.joining = false;
        this.syncControls();
        return;
      }
      this.media?.resume();
      this.pushTracks();
      const input = { nick };
      if (this.token) input.token = this.token;
      const result = await this.session.join(input);
      const status = result?.status;
      if (status === 'lobby') {
        this.showLobby();
      } else if (status === 'joined') {
        await this.updateServer(true);
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
    const isRecording = this.recording?.isActive === true;
    const isLive = this.streaming?.isActive === true;
    const text = leaveText(isRecording, isLive);
    const isBusy = isRecording || isLive;
    if (isBusy && this.hooks.confirm?.(text) === false) return;
    this.cancel();
  }

  pagehide() {
    this.streaming?.abandon();
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
    if (kind === 'mic') this.talkStep('cancel');
    media.resume();
    if (kind === 'mic') await media.toggleMic();
    else await media.toggleCamera();
  }

  onPhase(phase) {
    if (phase === 'lobby' && this.mode !== 'lobby') this.showLobby();
    if (phase === 'joined' && this.mode === 'lobby') this.showCall();
    const showing = this.mode === 'call' || this.mode === 'mini';
    if (phase === 'joined' && showing) {
      this.updateServer(true).catch((error) => this.hooks.fail(error));
    }
    const idle = phase === 'idle';
    const open = this.mode !== 'prejoin' && this.mode !== '';
    if (idle && open) this.detach();
  }

  onCallState(state) {
    if (!this.session || state?.call !== this.session.call) return;
    const list = Array.isArray(state.participants) ? state.participants : [];
    const people = [];
    let isAdmin = false;
    for (const item of list) {
      const endpoint = item.endpoint;
      if (!endpoint) continue;
      const nick = typeof item.nick === 'string' ? item.nick : '';
      const peer = typeof item.peer === 'string' ? item.peer : '';
      const camera = item.camera === true;
      const screen = item.screen === true;
      const mic = item.mic !== false;
      const admin = item.admin === true;
      const hand = item.hand > 0 ? item.hand : 0;
      if (endpoint === this.session.endpoint) isAdmin = admin;
      const person = { endpoint, nick, peer, camera, screen, mic };
      people.push({
        ...person,
        admin,
        hand,
        recording: item.recording === true,
        live: item.live === true,
        optOut: item.optOut === true,
        stage: item.stage !== false,
        title: titleOf(item.title),
      });
    }
    if (this.mode === 'call' || this.mode === 'mini') {
      this.announceChanges(people);
    }
    const me = this.session.endpoint;
    const wasBackstage = this.personOf(me)?.stage === false;
    const local = people.find((person) => person.endpoint === me);
    this.people = people;
    this.hands = orderOf(people);
    this.isAdmin = isAdmin;
    this.hostPeer = typeof state.host === 'string' ? state.host : '';
    this.policy = typeof state.policy === 'string' ? state.policy : '';
    this.locked = state.locked === true;
    this.joinBackstage = state.joinBackstage === true;
    this.kind = typeof state.kind === 'string' ? state.kind : '';
    this.lobby = Array.isArray(state.lobby) ? state.lobby : [];
    this.spotlight = typeof state.spotlight === 'string' ? state.spotlight : '';
    const present = new Set(people.map((person) => person.endpoint));
    for (const endpoint of this.remote.keys()) {
      if (present.has(endpoint)) continue;
      const tracks = this.remote.get(endpoint);
      for (const track of Object.values(tracks)) this.unwatchTrack(track);
      this.remote.delete(endpoint);
      this.limiters.delete(endpoint);
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
      const audio = screen ? trackOf(this, endpoint, 'screenAudio') : null;
      this.attachAudio(endpoint, audio, 'screenAudio');
    }
    if (this.mode === 'call' || this.mode === 'mini') {
      this.renderTiles();
      this.syncControls();
    }
    this.paintPeople();
    this.paintRecording();
    this.paintLive();
    this.paintBackstage();
    this.studio?.paint();
    this.paintKnocks();
    if (local && wasBackstage !== !local.stage) {
      const text = local.stage
        ? 'You are on stage'
        : 'You are backstage, not in the recording or stream';
      this.hooks.notice?.(text, this.announcements);
    }
  }

  paintBackstage() {
    const chip = this.host?.querySelector('.call-backstage');
    if (chip) chip.hidden = !this.isBackstage(this.session?.endpoint);
  }

  paintRecording() {
    const note = this.host?.querySelector('.call-recording');
    if (!note) return;
    const recorders = this.people.filter((person) => person.recording);
    const names = recorders.map((person) => person.nick || 'guest');
    const text = names.length > 0 ? `● ${names.join(', ')} recording` : '';
    note.textContent = text;
    note.classList.toggle('hidden', text === '');
    const me = this.session?.endpoint;
    const makers = this.people.filter(
      (person) => person.recording || person.live,
    );
    const byOthers = makers.some((person) => person.endpoint !== me);
    const optOut = this.host?.querySelector('.call-opt-out');
    if (!optOut) return;
    const isOut = this.isOptedOut();
    optOut.classList.toggle('hidden', !byOthers);
    optOut.textContent = isOut ? 'opted out · undo' : 'opt out';
    optOut.setAttribute('aria-pressed', `${isOut}`);
  }

  paintLive() {
    const chip = this.host?.querySelector('.call-live');
    const stop = this.host?.querySelector('[data-action="stop-live"]');
    if (stop) stop.hidden = this.streaming?.isActive !== true;
    if (!chip) return;
    const names = this.people
      .filter((person) => person.live)
      .map((person) => person.nick || 'guest');
    chip.textContent = names.length > 0 ? '● LIVE' : '';
    chip.title = names.length > 0 ? `${names.join(', ')} is live` : '';
    chip.classList.toggle('hidden', names.length === 0);
  }

  announceChanges(people) {
    const previous = new Map(
      this.people.map((person) => [person.endpoint, person]),
    );
    const membership = [];
    const lines = [];
    for (const person of people) {
      const { endpoint, hand, recording, admin } = person;
      const nick = person.nick || 'guest';
      const before = previous.get(endpoint);
      previous.delete(endpoint);
      const local = endpoint === this.session.endpoint;
      if (!before && !local) membership.push({ kind: 'join', nick });
      if (hand && !before?.hand) lines.push(`${nick} raised a hand`);
      if (before?.hand && !hand && local) lines.push('Your hand was lowered');
      if (before && local && before.admin !== admin) {
        lines.push(
          admin ? 'You are now a call admin' : 'You are no longer a call admin',
        );
      }
      if (recording !== Boolean(before?.recording)) {
        lines.push(`${nick} ${recording ? 'started' : 'stopped'} recording`);
      }
      if (person.live && !before?.live) lines.push(`${nick} went live`);
    }
    for (const person of previous.values()) {
      if (person.endpoint === this.session.endpoint) continue;
      membership.push({ kind: 'leave', nick: person.nick });
      if (person.recording) lines.push(`${person.nick} stopped recording`);
    }
    const wasLive = this.people.some((person) => person.live);
    if (wasLive && !people.some((person) => person.live)) {
      lines.push('Live stream ended');
    }
    if (membership.length) {
      let recent = createToast();
      const now = performance.now();
      for (const event of membership) {
        recent = addToast(recent, event, now);
        this.toast = addToast(this.toast, event, now);
      }
      lines.unshift(toastText(recent));
      const toast = document.getElementById('call-toast');
      toast.hidden = !showsToast(Math.max(this.people.length, people.length));
      toast.textContent = toastText(this.toast);
      clearTimeout(this.toastTimer);
      this.toastTimer = setTimeout(() => {
        toast.hidden = true;
      }, TOAST_SHOW_MS);
    }
    if (lines.length) this.announcements.textContent = lines.join('. ');
  }

  restoreRemote() {
    for (const person of this.people) {
      const endpoint = person.endpoint;
      const local = endpoint === this.session.endpoint;
      if (local || this.session.relayFor?.(endpoint)) continue;
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
    const direct = ['mic', 'camera', 'screen', 'screenAudio'].includes(slot);
    const relay = slot === 'relayAudio' || slot === 'relayVideo';
    if (!endpoint || (!direct && !relay)) return;
    const track = payload.track ?? null;
    const current = this.remote.get(endpoint) ?? {
      mic: null,
      camera: null,
      screen: null,
      screenAudio: null,
      relayAudio: null,
      relayVideo: null,
    };
    const previous = current[slot];
    if (previous !== track) this.unwatchTrack(previous);
    current[slot] = track;
    this.remote.set(endpoint, current);
    if (track) this.watchTrack(endpoint, slot, track);
    if (slot === 'mic') {
      this.attachAudio(endpoint, trackOf(this, endpoint, slot));
    }
    if (slot === 'relayAudio') this.syncRelayAudios(endpoint);
    if (slot === 'screenAudio' || slot === 'screen') {
      const playing = this.screenTrack(endpoint);
      const audio = playing ? trackOf(this, endpoint, 'screenAudio') : null;
      this.attachAudio(endpoint, audio, 'screenAudio');
    }
    if (this.mode === 'call' || this.mode === 'mini') this.renderTiles();
  }

  syncRelayAudios(relay) {
    for (const person of this.people) {
      const { endpoint } = person;
      if (this.session?.relayFor?.(endpoint) === relay) {
        this.attachAudio(endpoint, trackOf(this, endpoint, 'mic'));
      }
    }
  }

  onRelay(endpoint) {
    if (endpoint) {
      this.attachAudio(endpoint, trackOf(this, endpoint, 'mic'));
      const screen = this.screenTrack(endpoint);
      const audio = screen ? trackOf(this, endpoint, 'screenAudio') : null;
      this.attachAudio(endpoint, audio, 'screenAudio');
    }
    this.paintSound();
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
        this.attachAudio(endpoint, trackOf(this, endpoint, slot), slot);
      }
      if (ended && slot === 'relayAudio') this.syncRelayAudios(endpoint);
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
    this.paintStats();
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

  async updateServer(includeTitle = false) {
    const session = this.session;
    const media = this.media;
    if (!session || !media) return;
    const live = session.phase === 'joined' || session.phase === 'reconnecting';
    if (!live) return;
    const mic = media.micOn;
    const camera = media.cameraOn && !media.cameraPaused;
    const screen = media.screenShared && Boolean(media.screenTrack);
    const flags = { mic, camera, screen };
    if (includeTitle) flags.title = this.preferences.title;
    if (this.recording?.isActive) flags.recording = true;
    if (this.streaming?.isFlagged) flags.live = true;
    await this.hooks.update(flags);
  }

  ensureHost() {
    if (this.host) return;
    const host = document.createElement('div');
    host.className = 'call-stage';
    this.hooks.before(host);
    host.addEventListener('click', this.#onClick);
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

  onClick(event) {
    const sound = event.target.closest('[data-action="enable-sound"]');
    if (this.soundBlocked && !sound) this.resumeAudio();
    const streamAction = event.target.closest('[data-stream-action]');
    if (streamAction) {
      this.streaming?.action(streamAction);
      return;
    }
    const studioAction = event.target.closest('[data-studio-action]');
    if (studioAction) {
      this.studio?.action(studioAction).catch(this.hooks.fail);
      return;
    }
    const button = event.target.closest('[data-action]');
    if (!button) return;
    if (button.dataset.action === 'tile-menu') {
      const tile = button.closest('.call-tile');
      this.tileMenu?.toggle(tile, button);
      return;
    }
    if (event.detail > 0) button.blur();
    if (button.dataset.action === 'react') {
      this.react(button.dataset.emoji);
      const menu = button.closest('details');
      if (menu) menu.open = false;
      return;
    }
    const endpoint = button.closest('[data-endpoint]')?.dataset.endpoint;
    const slot = button.closest('[data-slot]')?.dataset.slot ?? 'camera';
    this.onAction(button.dataset.action, endpoint, slot);
  }

  viewOf(mode, title) {
    if (mode === 'prejoin') return createPrejoin(title, this.hooks.hasNick());
    if (mode === 'lobby') return createLobby();
    return createCall(title, Boolean(this.studio));
  }

  onDevice(event) {
    const select = event.target;
    const { record, pin, volume, studio, stream } = select.dataset;
    if (stream) return void this.streaming?.change(select);
    if (studio || select.closest('[data-studio-section="editor"]')) {
      this.studio?.change(select).catch((error) => this.hooks.fail(error));
      return;
    }
    if (record || pin || volume) return void this.recording?.change(select);
    if (select.dataset.setting || select.dataset.device) {
      this.hooks.preferences.change(select);
      return;
    }
    if (select.id === 'call-policy') {
      this.command('policy', '', select.value);
      return;
    }
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
    fillDevice(
      host.querySelector('[data-device="camera"]'),
      media.cameras,
      media.cameraId,
      'camera',
    );
    fillDevice(
      host.querySelector('[data-device="mic"]'),
      media.mics,
      media.micId,
      'mic',
    );
    const camera = host.querySelector('#prejoin-camera');
    const mic = host.querySelector('#prejoin-mic');
    fillDevice(camera, media.cameras, media.cameraId, 'camera');
    fillDevice(mic, media.mics, media.micId, 'microphone');
    fillDevice(
      host.querySelector('#prejoin-speaker'),
      media.speakers,
      media.speakerId,
      'speaker',
    );
    const speaker = host.querySelector('.speaker-field');
    speaker?.classList.toggle('hidden', !media.canSink);
  }

  syncControls() {
    this.recording?.paint();
    this.paintSound();
    const roots = [this.host, this.mini, this.pip?.root];
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
    if (!join) return;
    const admission = admissionOf(this.preview, this.token);
    const blocked =
      admission.action === 'locked' || admission.action === 'full';
    join.disabled = this.joining || blocked;
    const asking = admission.action === 'lobby';
    join.textContent = asking ? 'ask to join' : 'join';
    this.paintNote();
  }

  paintButtons(root) {
    const media = this.media;
    if (!media) return;
    this.paintShare(root);
    this.paintLeave(root);
    const mics = root.querySelectorAll('[data-action="mic"]');
    for (const button of mics) {
      button.textContent = media.micOn ? 'mic on' : 'mic off';
      button.classList.toggle('off', !media.micOn);
      button.classList.toggle('warn', media.micMissing);
    }
    const raised = this.isHandRaised();
    for (const button of root.querySelectorAll('[data-action="hand"]')) {
      button.textContent = raised ? 'lower hand' : 'raise hand';
      button.classList.toggle('off', !raised);
      button.setAttribute('aria-pressed', raised ? 'true' : 'false');
    }
    syncFields(root, this.preferences);
    const cameras = root.querySelectorAll('[data-action="camera"]');
    for (const button of cameras) {
      button.textContent = media.cameraOn ? 'camera on' : 'camera off';
      button.classList.toggle('off', !media.cameraOn);
      button.classList.toggle('warn', media.cameraMissing);
    }
  }

  paintLeave(root) {
    const menu = root.querySelector('.leave-menu');
    menu?.classList.toggle('hidden', !this.isAdmin);
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
    this.mediaNote = typeof text === 'string' ? text : '';
    this.paintNote();
  }

  paintNote() {
    const note = this.host?.querySelector('.call-note');
    if (!note) return;
    const admission = admissionOf(this.preview, this.token);
    const reason = this.mode === 'prejoin' ? admission.reason : '';
    const unavailable = this.media && !this.media.canScreen;
    const message = unavailable ? 'Screen capture is unavailable.' : '';
    const notices = [...this.qualityNotices];
    const strong = this.preferences.noise === 'strong';
    const supported = navigator.mediaDevices?.getSupportedConstraints?.();
    if (strong && !supported?.voiceIsolation) {
      notices.push('Strong noise suppression unavailable. Using standard.');
    }
    const parts = [reason, this.mediaNote, message, ...notices];
    const value = parts.filter(Boolean).join(' ');
    note.textContent = value;
    note.classList.toggle('hidden', value === '');
  }

  applyPreview(preview) {
    this.preview = preview ?? null;
    const kind = preview?.kind;
    if (typeof kind === 'string') this.kind = kind;
    this.syncControls();
    if (this.mode !== 'prejoin') return;
    const chat = typeof preview?.chat === 'string' ? preview.chat : '';
    const title = this.host?.querySelector('#prejoin .chat-title');
    if (title && chat) title.textContent = this.hooks.titleOf(chat);
  }

  async admit(endpoint) {
    const call = this.session?.call;
    if (!call || !endpoint || !this.isAdmin) return;
    await this.hooks.admit(call, endpoint);
  }

  async deny(endpoint) {
    const call = this.session?.call;
    if (!call || !endpoint || !this.isAdmin) return;
    await this.hooks.deny(call, endpoint);
  }

  async admitAll() {
    const call = this.session?.call;
    if (!call || !this.isAdmin) return;
    const endpoints = this.lobby.map((item) => item.endpoint);
    for (const endpoint of endpoints) await this.hooks.admit(call, endpoint);
  }

  copyLink() {
    const call = this.session?.call;
    if (!call || !this.isAdmin || this.kind === 'direct') return;
    const copying = this.hooks.copyLink(call);
    if (copying?.catch) copying.catch((error) => this.hooks.fail(error));
  }

  async command(action, target = '', value) {
    const call = this.session?.call;
    if (!call || !this.isAdmin) return;
    const args = { call, action };
    if (target !== '') args.target = target;
    if (value !== undefined) args.value = value;
    try {
      await this.hooks.host(args);
    } catch (error) {
      this.hooks.fail(error);
    }
  }

  async endForAll() {
    const call = this.session?.call;
    if (!call || !this.isAdmin) return;
    try {
      await this.hooks.end(call);
    } catch (error) {
      this.hooks.fail(error);
    }
  }

  isHandRaised() {
    const endpoint = this.session?.endpoint;
    return this.personOf(endpoint)?.hand > 0;
  }

  async setHand(value) {
    const session = this.session;
    if (!session) return;
    await this.hooks.update({ hand: value });
  }

  toggleHand() {
    return this.setHand(!this.isHandRaised());
  }

  isOptedOut() {
    const endpoint = this.session?.endpoint;
    return this.personOf(endpoint)?.optOut === true;
  }

  async setOptOut(value) {
    if (!this.session) return;
    await this.hooks.update({ optOut: value });
  }

  toggleOptOut() {
    return this.setOptOut(!this.isOptedOut());
  }

  applyPreferences(settings) {
    if (!settings.pushToTalk) this.talkStep('up');
    const changedTitle = settings.title !== this.preferences.title;
    this.preferences = settings;
    if (changedTitle && this.session?.phase === 'joined') {
      this.hooks.update({ title: settings.title }).catch(this.hooks.fail);
    }
    this.lowerState = createAutoLower();
    this.media
      ?.setNoise(settings.noise)
      .catch((error) => this.hooks.fail(error));
    this.media
      ?.setMirror(settings.mirror)
      .catch((error) => this.hooks.fail(error));
    this.recording?.applyDefaults(settings);
    this.syncControls();
    this.paintPreview();
    this.paintNote();
    this.renderTiles();
  }

  checkAutoLower() {
    const endpoint = this.session?.endpoint;
    if (!endpoint) return;
    const entry = this.levels?.state.participants.get(endpoint);
    const speaking = entry?.speaking === true;
    const raised = this.isHandRaised();
    const input = { enabled: this.preferences.autoLower, raised, speaking };
    const step = stepAutoLower(this.lowerState, input, performance.now());
    this.lowerState = step.state;
    if (!step.lower) return;
    this.setHand(false).catch((error) => this.hooks.fail(error));
  }

  react(emoji) {
    const session = this.session;
    if (!session || !isReaction(emoji)) return false;
    if (!takeReaction(this.sendLimiter, performance.now())) return false;
    this.showReaction(session.endpoint, emoji);
    const message = { type: 'reaction', emoji };
    for (const person of this.people) {
      if (person.endpoint !== session.endpoint) {
        session.send(person.endpoint, message);
      }
    }
    return true;
  }

  onPeerMessage(payload) {
    const endpoint = payload?.endpoint;
    const message = payload?.message;
    if (message?.type !== 'reaction' || !isReaction(message.emoji)) return;
    if (!this.personOf(endpoint)) return;
    let limiter = this.limiters.get(endpoint);
    if (!limiter) {
      limiter = createLimiter();
      this.limiters.set(endpoint, limiter);
    }
    if (!takeReaction(limiter, performance.now())) return;
    this.showReaction(endpoint, message.emoji);
  }

  floatOn(target, text) {
    const float = document.createElement('span');
    float.className = 'call-reaction';
    float.textContent = text;
    float.setAttribute('aria-hidden', 'true');
    target.append(float);
    const timer = setTimeout(() => {
      this.floats.delete(timer);
      float.remove();
    }, REACTION_SHOW_MS);
    this.floats.add(timer);
  }

  showReaction(endpoint, emoji) {
    if (this.mode === 'mini') {
      const root = this.pip ? this.pip.root : this.mini;
      if (!root) return;
      const own = root.dataset.endpoint === endpoint;
      const text = own ? emoji : `${emoji} ${this.nameOf(endpoint)}`;
      return void this.floatOn(root, text);
    }
    const tiles = this.host?.querySelectorAll('.call-tile:not(.screen-tile)');
    for (const tile of tiles ?? []) {
      if (tile.dataset.endpoint === endpoint) this.floatOn(tile, emoji);
    }
  }

  async acceptUnmute() {
    this.prompt = '';
    this.paintPrompt();
    const media = this.media;
    if (!media || media.micOn) return;
    await media.toggleMic();
  }

  async onRequest(data) {
    const mine = this.session?.endpoint;
    if (!data || !mine || data.endpoint !== mine) return;
    const nick = this.nickOf(data.by);
    if (data.action === 'unmute') {
      this.prompt = `${nick} asks you to unmute`;
      this.announcements.textContent = this.prompt;
      this.paintPrompt();
      return;
    }
    const text = REMOTE_REQUEST[data.action];
    if (!text) return;
    if (data.action === 'mute') await this.forceMute();
    if (data.action === 'stopCamera') await this.forceStopCamera();
    if (data.action === 'stopScreen') this.forceStopScreen();
    this.prompt = '';
    this.paintPrompt();
    this.hooks.notice?.(text(nick), this.announcements);
  }

  onRemoved(data) {
    const nick = this.nickOf(data?.by);
    this.hooks.notice?.(`removed by ${nick}`, this.announcements);
  }

  async forceMute() {
    const media = this.media;
    if (!media?.micOn) return;
    await media.toggleMic();
  }

  async forceStopCamera() {
    const media = this.media;
    if (!media?.cameraOn) return;
    await media.toggleCamera();
  }

  forceStopScreen() {
    const media = this.media;
    const sharing = Boolean(media?.screenTrack || media?.screenShared);
    if (!sharing) return;
    media.stopScreen();
  }

  personOf(endpoint) {
    for (const person of this.people) {
      if (person.endpoint === endpoint) return person;
    }
    return null;
  }

  isBackstage(endpoint) {
    return this.personOf(endpoint)?.stage === false;
  }

  backstageSuffix(endpoint) {
    return this.isBackstage(endpoint) ? ' · backstage' : '';
  }

  nickOf(peer) {
    if (typeof peer !== 'string' || peer === '') return 'someone';
    for (const person of this.people) {
      if (person.peer === peer && person.nick !== '') return person.nick;
    }
    return peer;
  }

  paintPrompt() {
    const row = this.host?.querySelector('.call-prompt');
    if (!row) return;
    const label = row.querySelector('span');
    if (label) label.textContent = this.prompt;
    row.classList.toggle('hidden', this.prompt === '');
  }

  paintPeople() {
    const aside = this.host?.querySelector('.call-people');
    if (!aside) return;
    this.paintLobby(aside);
    this.paintRoster(aside);
    this.paintHost(aside);
    const copy = aside.querySelector('[data-action="copy-link"]');
    const showCopy = this.isAdmin && this.kind !== 'direct';
    copy?.classList.toggle('hidden', !showCopy);
    const optOut = aside.querySelector('.people-opt-out');
    if (!optOut) return;
    const isOut = this.isOptedOut();
    optOut.textContent = isOut
      ? 'opted out of recordings · undo'
      : 'opt out of recordings';
    optOut.setAttribute('aria-pressed', `${isOut}`);
  }

  paintHost(aside) {
    const box = aside.querySelector('.call-host');
    if (!box) return;
    box.classList.toggle('hidden', !this.isAdmin);
    if (!this.isAdmin) return;
    const lock = box.querySelector('[data-action="lock"]');
    if (lock) lock.textContent = this.locked ? 'Unlock' : 'Lock';
    const select = box.querySelector('#call-policy');
    const current = POLICIES.includes(this.policy) ? this.policy : 'link';
    if (select && document.activeElement !== select) select.value = current;
  }

  paintLobby(aside) {
    const box = aside.querySelector('.call-lobby');
    box.replaceChildren();
    const show = this.isAdmin && this.lobby.length > 0;
    box.classList.toggle('hidden', !show);
    if (!show) return;
    box.append(createButton('admit-all', 'admit all'));
    for (const item of this.lobby) {
      const row = document.createElement('div');
      row.className = 'lobby-row';
      row.dataset.endpoint = item.endpoint;
      const name = document.createElement('span');
      const nick = item.nick || 'someone';
      name.textContent = nick;
      const admit = createButton('admit', 'admit');
      const deny = createButton('deny', 'deny');
      row.append(name, admit, deny);
      box.append(row);
    }
  }

  paintRoster(aside) {
    const roster = aside.querySelector('.call-people-roster');
    const people = rosterOf(this.people);
    const group =
      this.joinBackstage || people.some(({ stage }) => stage === false);
    const key = JSON.stringify([
      this.isAdmin,
      group,
      people.map((person) => ({
        endpoint: person.endpoint,
        nick: person.nick,
        stage: person.stage,
        optOut: person.optOut,
        order: this.hands.get(person.endpoint),
      })),
    ]);
    if (roster.dataset.key === key) return;
    roster.dataset.key = key;
    const row = (person) => this.createRosterRow(person);
    if (group) {
      roster.replaceChildren(...createStageLists(people, row));
    } else {
      const list = document.createElement('ul');
      list.className = 'call-roster';
      list.append(...people.map(row));
      roster.replaceChildren(list);
    }
  }

  createRosterRow(person) {
    const item = document.createElement('li');
    item.dataset.endpoint = person.endpoint;
    const name = document.createElement('span');
    name.textContent = person.nick || person.endpoint;
    item.append(name);
    const order = this.hands.get(person.endpoint);
    if (order) {
      const hand = document.createElement('span');
      hand.className = 'roster-hand';
      hand.textContent = `✋ ${order}`;
      hand.setAttribute('aria-label', `hand raised, number ${order}`);
      item.append(hand);
      if (this.isAdmin) item.append(createButton('lower-hand', 'lower'));
    }
    if (person.optOut) {
      const opted = document.createElement('span');
      opted.className = 'roster-opted';
      opted.textContent = 'opted out';
      item.append(opted);
    }
    if (this.isAdmin) {
      const menu = document.createElement('details');
      menu.className = 'roster-menu';
      const summary = document.createElement('summary');
      summary.textContent = '⋯';
      summary.setAttribute('aria-label', `Options for ${name.textContent}`);
      const { action, label } = stageMove(person);
      menu.append(summary, createButton(action, label));
      item.append(menu);
    }
    return item;
  }

  ensureKnocks() {
    if (this.knocks) return;
    const root = document.createElement('div');
    root.id = 'knock-toasts';
    root.addEventListener('click', (event) => {
      const button = event.target.closest('[data-action]');
      if (!button) return;
      const endpoint = button.closest('[data-endpoint]')?.dataset.endpoint;
      this.onAction(button.dataset.action, endpoint ?? '');
    });
    document.body.append(root);
    this.knocks = root;
  }

  paintKnocks() {
    if (!this.isAdmin) {
      this.knocks?.replaceChildren();
      return;
    }
    this.ensureKnocks();
    const root = this.knocks;
    const seen = new Set();
    for (const item of this.lobby) {
      seen.add(item.endpoint);
      let toast = null;
      for (const node of root.children) {
        if (node.dataset.endpoint === item.endpoint) toast = node;
      }
      const nick = item.nick || 'someone';
      const text = `${nick} wants to join`;
      if (!toast) {
        root.append(createKnock(item));
        continue;
      }
      const label = toast.querySelector('p');
      if (label) label.textContent = text;
    }
    const stale = [];
    for (const node of root.children) {
      if (!seen.has(node.dataset.endpoint)) stale.push(node);
    }
    for (const node of stale) node.remove();
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
      mobile: phoneView(),
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
    const tray = grid.querySelector('.phone-strip');
    tray.hidden = !result.strip;
    if (result.strip) {
      tray.style.top = `${result.strip.y + 8}px`;
      tray.style.height = `${result.strip.height}px`;
    }
    for (const tile of grid.querySelectorAll('.call-tile')) {
      const id = tileId(tile.dataset.endpoint, tile.dataset.slot);
      const position = placed.get(id);
      tile.hidden = !position;
      tile.classList.toggle('pinned', id === this.pin);
      tile.classList.toggle('featured', position?.featured === true);
      const parent = position?.strip ? tray : grid;
      if (tile.parentNode !== parent) parent.append(tile);
      if (!position) continue;
      tile.style.left = `${position.x + 8}px`;
      tile.style.top = `${position.y + (position.strip ? 0 : 8)}px`;
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
    for (const root of this.miniRoots()) {
      this.paintSpeakingTile(root, root.dataset.endpoint);
    }
  }

  updateViewHints() {
    const mini = this.pip ? this.pip.root : this.mini;
    const root = this.mode === 'mini' ? mini : this.host;
    const tiles = root ? Array.from(root.querySelectorAll('.call-tile')) : [];
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
    const paused = local && this.media?.cameraOn && this.media?.cameraPaused;
    const status = paused ? ' · camera paused' : '';
    const via = this.relaySuffix(endpoint);
    const tags = status + this.backstageSuffix(endpoint) + via;
    if (chip) {
      chip.textContent = `${name} · mic ${mic ? 'on' : 'off'}${tags}`;
    }
    const poor =
      !local &&
      this.quality.get(endpoint)?.poor === true &&
      !this.session?.isAudioOnly(endpoint);
    tile.querySelector('.call-poor').classList.toggle('hidden', !poor);
    const badge = tile.querySelector('.call-hand-badge');
    const order = this.hands.get(endpoint);
    badge.classList.toggle('hidden', !order);
    badge.textContent = order ? `✋ ${order}` : '';
    if (order) badge.setAttribute('aria-label', `hand raised, number ${order}`);
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

  statsOf(local, sample) {
    if (!local) return statsText(sample);
    const mirror = `mirror: ${this.media?.mirrorState || 'off'}`;
    const pair = this.session?.forwarding;
    if (!pair) return mirror;
    const from = this.nameOf(pair.from);
    const to = this.nameOf(pair.to);
    return `${mirror}
relaying for ${from} and ${to}`;
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
      overlay.classList.toggle('hidden', !shown);
      if (shown) overlay.textContent = this.statsOf(local, sample);
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
    const track = trackOf(this, endpoint, 'screen');
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
      const backstage = this.backstageSuffix(endpoint);
      const via = this.relaySuffix(endpoint);
      tile.querySelector('.call-name').textContent =
        `${this.nameOf(endpoint)} · ${label}${backstage}${via}`;
    }
  }

  miniRoots() {
    const roots = [];
    if (this.mini) roots.push(this.mini);
    if (this.pip) roots.push(this.pip.root);
    return roots;
  }

  paintMini() {
    if (!this.session) return;
    const endpoint = this.featured();
    const local = endpoint === this.session.endpoint;
    const name = this.nameOf(endpoint);
    const color = colorOf(endpoint);
    for (const root of this.miniRoots()) {
      root.dataset.endpoint = endpoint;
      root.classList.toggle('local', local);
      paintPerson(root, this.videoTrack(endpoint), name, color);
      this.paintSpeakingTile(root, endpoint);
      const chip = root.querySelector('.pip-name');
      const tags = this.backstageSuffix(endpoint) + this.relaySuffix(endpoint);
      if (chip) chip.textContent = name + tags;
    }
  }

  async openPip() {
    if (this.pip || !this.session) return;
    const api = globalThis.documentPictureInPicture;
    if (!pipSupported()) return void this.hooks.notice?.(PIP_MISSING);
    const popup = await api.requestWindow(PIP_SIZE);
    if (!this.session || this.pip) return void popup.close();
    const root = createPip();
    copyStyles(popup.document);
    popup.document.body.append(root);
    root.addEventListener('click', this.#onClick);
    popup.document.addEventListener('keydown', this.#onKey, true);
    popup.document.addEventListener('keyup', this.#onKeyUp, true);
    popup.addEventListener('blur', this.#onBlur);
    popup.addEventListener('pagehide', this.#onPipClose);
    this.pip = { window: popup, root };
    if (this.mode === 'call') this.collapse();
    this.mini?.classList.add('hidden');
    this.syncControls();
    this.paintMini();
    this.updateViewHints();
  }

  closePip(expand) {
    const pip = this.pip;
    if (!pip) return;
    this.pip = null;
    this.talkStep('blur');
    const popup = pip.window;
    popup.removeEventListener('pagehide', this.#onPipClose);
    popup.removeEventListener('blur', this.#onBlur);
    popup.document.removeEventListener('keydown', this.#onKey, true);
    popup.document.removeEventListener('keyup', this.#onKeyUp, true);
    pip.root.removeEventListener('click', this.#onClick);
    popup.close();
    this.mini?.classList.remove('hidden');
    if (expand) return void this.expand();
    this.updateViewHints();
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
    const track = trackOf(this, endpoint, 'camera');
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

  relaySuffix(endpoint) {
    const relay = this.session?.relayFor?.(endpoint);
    return relay ? ` · via ${this.nameOf(relay)}` : '';
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
    this.playAudio(key, audio);
  }

  playAudio(key, audio) {
    audio.play().catch((error) => {
      const canceled = error?.name === 'AbortError';
      if (canceled || this.audios.get(key) !== audio) return;
      this.soundBlocked = true;
      if (error?.name === 'NotAllowedError') {
        this.session?.blockRelaySound?.();
      }
      this.paintSound();
    });
  }

  paintSound() {
    const blocked = this.soundBlocked || this.session?.relaySoundBlocked;
    for (const root of [this.host, this.mini, this.pip?.root]) {
      const button = root?.querySelector('[data-action="enable-sound"]');
      if (button) button.classList.toggle('hidden', !blocked);
    }
  }

  resumeAudio(enableRelay = false) {
    this.volume?.resume();
    this.soundBlocked = false;
    if (enableRelay) this.session?.enableRelaySound?.();
    this.paintSound();
    for (const entry of this.audios) this.playAudio(entry[0], entry[1]);
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
