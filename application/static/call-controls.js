import { createIcon } from './icons.js';
import { Menu, dismissMenu } from './overlays.js';
import { REACTIONS } from './call-hands.js';
import { helpOf } from './call-keys.js';
import { CALL_LAYOUTS, STRIP_POSITIONS } from './call-layout.js';
import { tone } from './call-preferences.js';
import { readDevices } from './media.js';
import { timeText } from './recording-files.js';

const PIP_MISSING = 'Picture-in-picture is not available in this browser';
const MARGIN = 8;
const MIC_HINT = 'Microphone · Ctrl D (hold Space to talk)';
const REACT_HINT = 'Reactions and raise hand · Ctrl Alt H';
const CAMERA_HINT = 'Camera · Ctrl E';
const SEPARATOR = { kind: 'separator' };
const STAYING = [
  'setting-noise',
  'setting-pushToTalk',
  'setting-mirror',
  'screen-motion',
  'hide-self',
  'hide-no-video',
  'stats-overlay',
];
const STRIP_LAYOUTS = ['spotlight', 'sidebar'];
const DIALOG_LAYER = 'callDialog';
const ARROWS = { ArrowRight: 1, ArrowLeft: -1 };
const MENU_KEYS = { mic: 'mic-menu', camera: 'camera-menu' };

const OPENERS = {
  'mic-menu': { kind: 'mic', label: 'Audio options', placement: 'top' },
  'camera-menu': { kind: 'camera', label: 'Video options', placement: 'top' },
  reactions: { kind: 'reactions', label: 'Reactions', placement: 'top' },
  more: { kind: 'more', label: 'More options', placement: 'top' },
  'sharing-menu': {
    kind: 'sharing',
    label: 'Sharing options',
    placement: 'bottom',
  },
};

const NO_DEVICE = {
  mic: 'No microphone found',
  camera: 'No camera found',
  speaker: 'No speaker found',
};

const deviceKey = (media) => {
  const lists = [media.mics, media.cameras, media.speakers];
  const names = lists.map((list) =>
    list.map(({ deviceId, label }) => [deviceId, label]),
  );
  return JSON.stringify([names, media.canSink]);
};

const pipSupported = () => {
  const api = globalThis.documentPictureInPicture;
  return typeof api?.requestWindow === 'function';
};

const createElement = (tag, className, doc = document) => {
  const element = doc.createElement(tag);
  element.className = className;
  return element;
};

const createControl = (action, icon, label, name, hint) => {
  const button = createElement('button', 'call-control');
  button.type = 'button';
  button.dataset.action = action;
  button.setAttribute('aria-label', name);
  button.title = hint;
  const text = createElement('span', 'call-label');
  text.textContent = label;
  button.append(createIcon(icon), text);
  return button;
};

const createIconButton = (action, icon, name, hint, doc = document) => {
  const button = createElement('button', 'call-icon', doc);
  button.type = 'button';
  button.dataset.action = action;
  button.setAttribute('aria-label', name);
  button.title = hint;
  button.append(createIcon(icon, doc));
  return button;
};

const createCaret = (action, name) => {
  const button = createElement('button', 'call-caret');
  button.type = 'button';
  button.dataset.action = action;
  button.title = name;
  button.setAttribute('aria-label', name);
  button.setAttribute('aria-haspopup', 'menu');
  button.setAttribute('aria-expanded', 'false');
  button.append(createIcon('caret'));
  return button;
};

const createSplit = (kind, icon, label, name, hint, options) => {
  const wrap = createElement('div', `call-split call-${kind}`);
  const main = createControl(kind, icon, label, name, hint);
  main.setAttribute('aria-pressed', 'true');
  wrap.append(main, createCaret(MENU_KEYS[kind], options));
  return wrap;
};

const createBadge = () => {
  const badge = createElement('span', 'call-badge hidden');
  badge.setAttribute('aria-hidden', 'true');
  return badge;
};

const createToggle = (action, icon, label, name) => {
  const button = createControl(action, icon, label, name, name);
  button.setAttribute('aria-pressed', 'false');
  button.prepend(createBadge());
  return button;
};

const createGroup = (name, ...controls) => {
  const group = createElement('div', `call-group call-${name}`);
  group.append(...controls);
  return group;
};

const createRecord = () => {
  const button = createControl(
    'record',
    'record',
    'record',
    'Record',
    'Record',
  );
  button.classList.add('call-record-control');
  button.setAttribute('aria-pressed', 'false');
  return button;
};

const createMore = () => {
  const button = createControl('more', 'more', 'more', 'More options', 'More');
  button.setAttribute('aria-haspopup', 'menu');
  button.setAttribute('aria-expanded', 'false');
  button.classList.add('call-more');
  button.prepend(createBadge());
  return button;
};

const createReactions = () => {
  const name = 'Reactions';
  const button = createControl('reactions', 'react', 'react', name, REACT_HINT);
  button.setAttribute('aria-haspopup', 'menu');
  button.setAttribute('aria-expanded', 'false');
  button.classList.add('call-react');
  return button;
};

const createShare = () => {
  const hint = 'Share screen · Ctrl Alt S';
  const button = createControl(
    'share',
    'screen',
    'share',
    'Share screen',
    hint,
  );
  button.setAttribute('aria-pressed', 'false');
  button.classList.add('call-share');
  return button;
};

const createLeave = () => {
  const button = createControl(
    'leave',
    'leave',
    'leave',
    'Leave call',
    'Leave',
  );
  button.classList.add('call-leave');
  return button;
};

const createBar = () => {
  const wrap = createElement('div', 'call-bar');
  const sound = createElement('button', 'link-btn call-sound');
  sound.type = 'button';
  sound.dataset.action = 'enable-sound';
  sound.textContent = 'Enable sound';
  const footer = createElement('footer', 'call-controls');
  footer.setAttribute('role', 'toolbar');
  footer.setAttribute('aria-label', 'Call controls');
  const mic = createSplit(
    'mic',
    'mic',
    'mic',
    'Microphone',
    MIC_HINT,
    'Audio options',
  );
  const camera = createSplit(
    'camera',
    'camera',
    'camera',
    'Camera',
    CAMERA_HINT,
    'Video options',
  );
  const people = createToggle('people', 'people', 'people', 'People');
  const chat = createToggle('chat', 'chat', 'chat', 'Chat');
  footer.append(
    createGroup('left', mic, camera),
    createGroup(
      'center',
      createShare(),
      createReactions(),
      createRecord(),
      createMore(),
    ),
    createGroup('right', people, chat, createLeave()),
  );
  wrap.append(sound, footer);
  return wrap;
};

const createSharing = () => {
  const pill = createElement('span', 'call-sharing hidden');
  const text = createElement('span', 'call-sharing-text');
  text.textContent = '● sharing screen';
  const more = createElement('button', 'call-sharing-menu');
  more.type = 'button';
  more.dataset.action = 'sharing-menu';
  more.textContent = '⋯';
  more.title = 'Sharing options';
  more.setAttribute('aria-label', 'Sharing options');
  more.setAttribute('aria-haspopup', 'menu');
  more.setAttribute('aria-expanded', 'false');
  pill.append(text, more);
  return pill;
};

const createReactionButtons = (doc) =>
  REACTIONS.map((emoji) => {
    const button = createElement('button', '', doc);
    button.type = 'button';
    button.title = emoji;
    button.dataset.action = 'react';
    button.dataset.reaction = emoji;
    button.setAttribute('aria-label', `React ${emoji}`);
    button.textContent = emoji;
    return button;
  });

const deviceItems = (kind, devices, selected, noun) => {
  const real = devices.filter((device) => device.deviceId);
  if (real.length === 0) {
    return [{ action: 'none', label: NO_DEVICE[kind], disabled: true }];
  }
  const isKnown = real.some(({ deviceId }) => deviceId === selected);
  const current = isKnown ? selected : '';
  const list = [{ deviceId: '', label: 'Default' }, ...real];
  return list.map(({ deviceId, label }, index) => ({
    kind: 'radio',
    group: kind,
    action: `device-${kind}`,
    value: deviceId,
    label: label || `${noun} ${index}`,
    checked: deviceId === current,
  }));
};

const indented = (action, label) => ({
  action,
  label,
  glyph: createElement('span', 'menu-mark'),
});

const checkbox = (action, label, checked) => ({
  kind: 'checkbox',
  action,
  label,
  checked,
});

const micItems = (stage) => {
  const { media, preferences } = stage;
  const talk = preferences.pushToTalk;
  const mics = deviceItems('mic', media.mics, media.micId, 'Microphone');
  const items = [{ kind: 'group', label: 'Microphone', items: mics }];
  if (media.canSink) {
    const speakers = deviceItems(
      'speaker',
      media.speakers,
      media.speakerId,
      'Speaker',
    );
    speakers.push(indented('test-speaker', 'Test speaker'));
    items.push({ kind: 'group', label: 'Speaker', items: speakers });
  }
  const isStrong = preferences.noise === 'strong';
  items.push(
    SEPARATOR,
    checkbox('setting-noise', 'Strong noise suppression', isStrong),
    checkbox('setting-pushToTalk', 'Push-to-talk (hold Space)', talk),
    SEPARATOR,
    indented('settings', 'Audio settings…'),
  );
  return items;
};

const cameraItems = (stage) => {
  const { media, preferences } = stage;
  const cameras = deviceItems(
    'camera',
    media.cameras,
    media.cameraId,
    'Camera',
  );
  const items = [{ kind: 'group', label: 'Camera', items: cameras }];
  items.push(SEPARATOR);
  items.push(checkbox('setting-mirror', 'Mirror camera', preferences.mirror));
  if (stage.phone?.matches) {
    items.push(indented('switch-camera', 'Switch front and back camera'));
  }
  items.push(SEPARATOR, indented('settings', 'Video settings…'));
  return items;
};

const reactionItems = (stage) => [
  checkbox('hand', '✋ Raise hand · Ctrl Alt H', stage.isHandRaised()),
];

const createKeys = () => {
  const keys = createElement('dl', 'call-keys');
  for (const row of helpOf()) {
    const name = document.createElement('dt');
    const key = document.createElement('kbd');
    key.textContent = row.keys;
    name.append(key);
    const text = document.createElement('dd');
    text.textContent = row.label;
    keys.append(name, text);
  }
  return keys;
};

const group = (label, items) => ({ kind: 'group', label, items });

const option = (action, label, icon) => ({
  action,
  label,
  glyph: createIcon(icon),
});

const radioRow = (label, name, values, current) => {
  const items = values.map((value) => ({
    kind: 'radio',
    group: name,
    action: `${name}-choice`,
    value,
    label: value,
    checked: value === current,
    keepOpen: true,
  }));
  return { kind: 'group', label, row: true, items };
};

const hasScreen = (media) => media.screenShared && Boolean(media.screenTrack);

const recordText = (recording) => {
  const recorder = recording?.recorder;
  if (!recorder) return 'Record';
  const time = timeText(recorder.activeMs);
  const isPaused = recorder.state === 'paused';
  return `● Recording${isPaused ? ' paused' : ''} ${time}`;
};

const peopleText = (stage) => {
  const waiting = stage.isAdmin ? stage.lobby.length : 0;
  const note = waiting > 0 ? ` · ${waiting} waiting` : '';
  return `People · ${stage.people.length}${note}`;
};

const unreadOf = (stage) => stage.hooks.unread?.(stage.chat) ?? 0;

const chatText = (stage) => {
  const unread = unreadOf(stage);
  return unread > 0 ? `Chat · ${unread} unread` : 'Chat';
};

const copyItems = (stage) => {
  const canCopy = stage.isAdmin && stage.kind !== 'direct';
  return canCopy ? [option('copy-link', 'Copy call link', 'link')] : [];
};

const phoneItems = (stage) => {
  const { media } = stage;
  const items = [];
  if (media.canScreen) {
    const label = hasScreen(media) ? 'Stop sharing' : 'Share screen';
    const share = option('share', label, 'screen');
    if (media.screenPending) share.disabled = true;
    items.push(share);
  }
  items.push(
    option('record', recordText(stage.recording), 'record'),
    option('people', peopleText(stage), 'people'),
    option('chat', chatText(stage), 'chat'),
    ...copyItems(stage),
  );
  return items;
};

const viewItems = (stage) => {
  const items = [];
  if (!stage.phone?.matches) {
    items.push(radioRow('Layout', 'layout', CALL_LAYOUTS, stage.layout));
    if (STRIP_LAYOUTS.includes(stage.layout)) {
      const row = radioRow('Strip', 'strip', STRIP_POSITIONS, stage.strip);
      items.push(row);
    }
  }
  items.push(
    checkbox('hide-self', 'Hide self view', stage.hideSelf),
    checkbox('hide-no-video', 'Hide tiles without video', stage.hideNoVideo),
    checkbox('stats-overlay', 'Stats overlay', stage.statsAll),
    option('fullscreen', 'Full screen · F', 'expand'),
  );
  const pip = option('pip', 'Picture-in-picture', 'pip');
  const missing = { disabled: true, reason: PIP_MISSING };
  items.push(pipSupported() ? pip : Object.assign(pip, missing));
  return items;
};

const programItems = (stage) => {
  const items = [
    option('record-panel', 'Recording options', 'record'),
    option('recordings', 'Recordings library', 'recordings'),
  ];
  if (stage.studio) items.push(option('studio', 'Studio', 'studio'));
  if (stage.streaming?.isActive) {
    items.push(indented('stop-live', 'Stop live'));
  }
  return items;
};

const callItems = (stage, isPhone) => {
  const items = isPhone ? [] : copyItems(stage);
  items.push(
    option('shortcuts', 'Keyboard shortcuts · Ctrl /', 'keyboard'),
    option('settings', 'Settings…', 'settings'),
  );
  return items;
};

const moreItems = (stage) => {
  const isPhone = stage.phone?.matches === true;
  const groups = [];
  if (isPhone) groups.push(group('Call', phoneItems(stage)));
  groups.push(group('View', viewItems(stage)));
  groups.push(group('Recording and studio', programItems(stage)));
  const last = group(isPhone ? 'Settings' : 'Call', callItems(stage, isPhone));
  groups.push(last);
  const items = [];
  for (const entry of groups) {
    if (items.length > 0) items.push(SEPARATOR);
    items.push(entry);
  }
  return items;
};

const sharingItems = (stage) => [
  checkbox('screen-motion', 'Optimize for video', stage.media.screenMotion),
  { action: 'stop-screen', label: 'Stop sharing' },
];

const ITEMS = {
  mic: micItems,
  camera: cameraItems,
  reactions: reactionItems,
  more: moreItems,
  sharing: sharingItems,
};

const CHOICES = {
  'device-mic': (stage, entry) => stage.media?.setMic(entry.value),
  'device-camera': (stage, entry) => stage.media?.setCamera(entry.value),
  'device-speaker': (stage, entry) => stage.media?.setSpeaker(entry.value),
  'test-speaker': () => tone(readDevices(localStorage).speaker),
  'layout-choice': (stage, entry) => {
    stage.setLayout(entry.value);
    stage.controls.reopen();
  },
  'strip-choice': (stage, entry) => {
    stage.setStrip(entry.value);
  },
  'setting-noise': (stage, entry) => {
    const value = entry.checked ? 'strong' : 'standard';
    stage.hooks.preferences.set('noise', value);
  },
  'setting-pushToTalk': (stage, entry) => {
    stage.hooks.preferences.set('pushToTalk', entry.checked);
  },
  'setting-mirror': (stage, entry) => {
    stage.hooks.preferences.set('mirror', entry.checked);
  },
  react: (stage, entry) => stage.react(entry.reaction),
  none: () => undefined,
};

const createLeaveDialog = () => {
  const dialog = createElement('dialog', 'call-leave-dialog');
  dialog.setAttribute('aria-label', 'Leave the call?');
  const title = createElement('p', 'call-leave-title');
  title.textContent = 'Leave the call?';
  const actions = createElement('div', 'call-leave-actions');
  const make = (value, label, className) => {
    const button = createElement('button', `link-btn ${className}`);
    button.type = 'button';
    button.value = value;
    button.textContent = label;
    button.dataset.choice = value;
    return button;
  };
  actions.append(
    make('leave', 'leave', 'call-leave-now'),
    make('end', 'end for everyone', 'call-leave-end'),
    make('cancel', 'cancel', 'call-leave-cancel'),
  );
  dialog.append(title, actions);
  return dialog;
};

const createKeysDialog = () => {
  const dialog = createElement('dialog', 'call-keys-dialog');
  dialog.setAttribute('aria-label', 'Keyboard shortcuts');
  const title = createElement('p', 'call-keys-title');
  title.textContent = 'Keyboard shortcuts';
  const actions = createElement('div', 'call-keys-actions');
  const make = (value, label) => {
    const button = createElement('button', 'link-btn');
    button.type = 'button';
    button.value = value;
    button.textContent = label;
    button.dataset.choice = value;
    return button;
  };
  actions.append(make('all', 'all shortcuts'), make('close', 'close'));
  dialog.append(title, createKeys(), actions);
  return dialog;
};

const placeDialog = (dialog, trigger) => {
  const rect = trigger.getBoundingClientRect();
  const width = dialog.offsetWidth;
  const height = dialog.offsetHeight;
  const room = window.innerWidth - width - MARGIN;
  const left = Math.max(MARGIN, Math.min(rect.right - width, room));
  const top = Math.max(MARGIN, rect.top - height - MARGIN);
  dialog.style.left = `${Math.round(left)}px`;
  dialog.style.top = `${Math.round(top)}px`;
};

const setIcon = (button, name) => {
  const current = button.querySelector('svg');
  if (current?.dataset.icon === name) return;
  current.replaceWith(createIcon(name, button.ownerDocument));
};

const paintSplit = (wrap, isOn, icons) => {
  const main = wrap.querySelector('.call-control');
  wrap.classList.toggle('off', !isOn);
  main.setAttribute('aria-pressed', `${isOn}`);
  setIcon(main, isOn ? icons[0] : icons[1]);
};

const paintIconToggle = (button, isOn, icons, isMissing) => {
  button.classList.toggle('off', !isOn);
  button.classList.toggle('warn', isMissing);
  button.setAttribute('aria-pressed', `${isOn}`);
  setIcon(button, isOn ? icons[0] : icons[1]);
};

const paintReaction = (button, isRaised) => {
  const name = isRaised ? 'Reactions, hand raised' : 'Reactions';
  button.classList.toggle('raised', isRaised);
  button.setAttribute('aria-label', name);
  const label = button.querySelector('.call-label');
  if (label) label.textContent = isRaised ? 'hand' : 'react';
  setIcon(button, isRaised ? 'hand' : 'react');
};

const paintPanel = (button, isShown, count, name) => {
  button.setAttribute('aria-pressed', `${isShown}`);
  button.classList.toggle('open', isShown);
  const badge = button.querySelector('.call-badge');
  badge.textContent = count;
  badge.classList.toggle('hidden', count === '');
  button.title = name;
};

const paintCapture = (root, media) => {
  const mic = root.querySelector('.call-mic');
  const camera = root.querySelector('.call-camera');
  paintSplit(mic, media.micOn, ['mic', 'mic-off']);
  paintSplit(camera, media.cameraOn, ['camera', 'camera-off']);
  mic.classList.toggle('warn', media.micMissing);
  camera.classList.toggle('warn', media.cameraMissing);
  const micNote = media.micMissing ? ' · No microphone found' : '';
  const cameraNote = media.cameraMissing ? ' · No camera found' : '';
  mic.querySelector('.call-control').title = MIC_HINT + micNote;
  camera.querySelector('.call-control').title = CAMERA_HINT + cameraNote;
};

const paintShare = (root, media, isPhone) => {
  const button = root.querySelector('.call-share');
  button.classList.toggle('hidden', !media.canScreen || isPhone);
  const isOn = hasScreen(media);
  button.classList.toggle('active', isOn);
  button.setAttribute('aria-pressed', `${isOn}`);
  button.disabled = media.screenPending;
  button.querySelector('.call-label').textContent = isOn ? 'stop' : 'share';
  setIcon(button, isOn ? 'screen-off' : 'screen');
};

const paintMore = (root, count) => {
  const more = root.querySelector('.call-more');
  const badge = more.querySelector('.call-badge');
  badge.textContent = count > 0 ? `${count}` : '';
  badge.classList.toggle('hidden', count === 0);
  more.classList.toggle('alert', count > 0);
  const name = count > 0 ? `More options, ${count} new` : 'More options';
  more.setAttribute('aria-label', name);
};

const PHONE_HIDDEN = [
  '.call-record-control',
  '[data-action="people"]',
  '[data-action="chat"]',
];

const paintPhone = (root, isPhone) => {
  for (const selector of PHONE_HIDDEN) {
    root.querySelector(selector).classList.toggle('hidden', isPhone);
  }
};

class CallControls {
  #stage = null;
  #root = null;
  #menu = null;
  #pip = null;
  #active = null;
  #trigger = null;
  #kind = '';
  #key = '';
  #dialog = null;

  constructor(stage) {
    this.#stage = stage;
    const element = createElement('div', 'menu call-bar-menu hidden');
    const hooks = stage.hooks;
    const layers = {
      push: (name) => hooks.pushLayer?.(name),
      pop: (name) => hooks.popLayer?.(name),
    };
    const backdrop = document.getElementById('backdrop');
    this.element = element;
    this.#menu = new Menu(element, { backdrop, layers });
    this.#active = this.#menu;
    document.body.append(element);
  }

  get menu() {
    return this.#menu;
  }

  get pipMenu() {
    return this.#pip;
  }

  create() {
    const bar = createBar();
    const root = bar.querySelector('.call-controls');
    this.#root = root;
    root.addEventListener('keydown', (event) => this.#onKey(event));
    root.addEventListener('focusin', (event) => this.#onFocus(event));
    this.#syncStops();
    return bar;
  }

  get #host() {
    return this.#stage.host;
  }

  attachPip(doc) {
    const element = createElement('div', 'menu pip-menu hidden', doc);
    doc.body.append(element);
    this.#pip = new Menu(element, {});
  }

  detachPip() {
    this.#pip?.close();
    this.#pip = null;
    this.#active = this.#menu;
  }

  handle(button) {
    const { action } = button.dataset;
    const opener = OPENERS[action];
    if (action === 'leave') return this.askLeave(button);
    if (!opener) {
      if (this.#root?.contains(button)) dismissMenu('pointer');
      return false;
    }
    const isOwn = this.#active.isOpen && this.#trigger === button;
    if (isOwn) this.#active.close();
    else this.open(action, button);
    return true;
  }

  open(action, trigger, options = {}) {
    const stage = this.#stage;
    const { kind, label, placement } = OPENERS[action];
    if (!stage.media) return;
    const doc = trigger.ownerDocument;
    const menu = doc === document ? this.#menu : this.#pip;
    if (!menu) return;
    const items = ITEMS[kind](stage);
    const anchor = trigger.closest('.call-split') ?? trigger;
    const reactions =
      kind === 'reactions' ? () => createReactionButtons(doc) : null;
    this.#active = menu;
    this.#kind = kind;
    this.#trigger = trigger;
    this.#key = deviceKey(stage.media);
    if (menu === this.#menu) {
      const parent = document.fullscreenElement ?? document.body;
      parent.append(this.element);
    }
    menu.open({
      id: kind,
      items,
      anchor,
      placement,
      trigger,
      label,
      reactions,
      select: (entry, button, event) => this.#choose(entry, event),
      close: () => this.#forget(),
      ...options,
    });
  }

  reopen() {
    const trigger = this.#trigger;
    const menu = this.#active;
    if (!trigger || !menu.isOpen) return;
    const keyboard = menu.hasFocusedItem;
    const action = Object.keys(OPENERS).find(
      (name) => OPENERS[name].kind === this.#kind,
    );
    this.open(action, trigger, { keyboard });
  }

  refresh() {
    const kind = this.#kind;
    const isDevice = kind === 'mic' || kind === 'camera';
    if (!this.#active.isOpen || !isDevice) return;
    if (deviceKey(this.#stage.media) === this.#key) return;
    this.reopen();
  }

  stop() {
    this.#menu.close();
    this.#pip?.close();
    const dialog = this.#dialog;
    this.#dialog = null;
    dialog?.close();
    this.element.remove();
  }

  showShortcuts() {
    if (this.#dialog) return;
    dismissMenu('pointer');
    const dialog = createKeysDialog();
    const decide = (value) => {
      if (value === 'all') this.#stage.hooks.shortcuts?.();
    };
    const focus = () => dialog.querySelector('[data-choice="close"]').focus();
    this.#present(dialog, decide, focus);
  }

  #forget() {
    this.#kind = '';
    this.#key = '';
  }

  #choose(entry, event) {
    event.stopPropagation();
    const stage = this.#stage;
    if (!STAYING.includes(entry.action) && entry.kind !== 'radio') {
      this.#active.dismiss('select');
    }
    const choice = CHOICES[entry.action];
    const result = choice ? choice(stage, entry) : stage.onAction(entry.action);
    if (result?.catch) result.catch((error) => stage.hooks.fail(error));
  }

  #present(dialog, decide, onShown) {
    this.#dialog = dialog;
    const { hooks } = this.#stage;
    dialog.addEventListener('keydown', (event) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      dialog.close('cancel');
    });
    dialog.addEventListener('click', (event) => {
      const choice = event.target.closest('[data-choice]');
      if (choice) dialog.close(choice.dataset.choice);
      else if (event.target === dialog) dialog.close('cancel');
    });
    dialog.addEventListener('close', () => {
      hooks.popLayer?.(DIALOG_LAYER);
      this.#dialog = null;
      dialog.remove();
      decide(dialog.returnValue);
    });
    const show = () => {
      if (this.#dialog !== dialog) return;
      document.body.append(dialog);
      dialog.showModal();
      hooks.pushLayer?.(DIALOG_LAYER);
      onShown();
    };
    if (hooks.afterPop) hooks.afterPop(show);
    else show();
  }

  closeDialog() {
    this.#dialog?.close('cancel');
  }

  askLeave(button) {
    const stage = this.#stage;
    const isShown = stage.mode === 'call' || stage.mode === 'mini';
    const isNeeded = stage.isAdmin && isShown;
    if (!isNeeded || button.ownerDocument !== document) return false;
    dismissMenu('pointer');
    if (this.#dialog) return true;
    const dialog = createLeaveDialog();
    const place = () => {
      placeDialog(dialog, button);
      dialog.querySelector('.call-leave-now').focus();
    };
    this.#present(dialog, (value) => this.#decide(value), place);
    return true;
  }

  #decide(choice) {
    const stage = this.#stage;
    if (choice === 'leave') stage.leave();
    if (choice === 'end') stage.endEveryone();
  }

  #stops() {
    const root = this.#root;
    if (!root) return [];
    const buttons = Array.from(root.querySelectorAll('button'));
    const isUsable = (button) =>
      !button.disabled && !button.closest('.hidden, [hidden]');
    return buttons.filter(isUsable);
  }

  #syncStops() {
    const root = this.#root;
    if (!root) return;
    const stops = this.#stops();
    const active = root.querySelector('button[tabindex="0"]');
    const keep = stops.includes(active) ? active : stops[0];
    for (const button of root.querySelectorAll('button')) {
      button.tabIndex = button === keep ? 0 : -1;
    }
  }

  #onFocus(event) {
    const target = event.target.closest('button');
    if (!target || !this.#root) return;
    for (const button of this.#root.querySelectorAll('button')) {
      button.tabIndex = button === target ? 0 : -1;
    }
  }

  #onKey(event) {
    if (event.ctrlKey || event.metaKey || event.altKey) return;
    const target = event.target.closest('button');
    const { key } = event;
    if (key === 'ArrowUp' && target?.dataset.action in MENU_KEYS) {
      event.preventDefault();
      const caret = target.nextElementSibling;
      return void this.open(MENU_KEYS[target.dataset.action], caret, {
        keyboard: true,
      });
    }
    const step = ARROWS[key];
    const isEdge = key === 'Home' || key === 'End';
    if (!step && !isEdge) return;
    const stops = this.#stops();
    const index = stops.indexOf(target);
    if (stops.length === 0 || index === -1) return;
    event.preventDefault();
    const edge = key === 'Home' ? 0 : stops.length - 1;
    const wrapped = (index + step + stops.length) % stops.length;
    stops[step ? wrapped : edge].focus();
  }

  paint() {
    const root = this.#root;
    const media = this.#stage.media;
    if (!root || !media) return;
    const isPhone = this.#stage.phone?.matches === true;
    paintCapture(root, media);
    paintShare(root, media, isPhone);
    paintPhone(root, isPhone);
    paintReaction(
      root.querySelector('.call-react'),
      this.#stage.isHandRaised(),
    );
    this.#paintPanels(root, isPhone);
    this.#paintSharing(media);
    this.#syncStops();
    this.refresh();
  }

  #paintPanels(root, isPhone = this.#stage.phone?.matches === true) {
    const stage = this.#stage;
    const waiting = stage.isAdmin ? stage.lobby.length : 0;
    const people = root.querySelector('[data-action="people"]');
    const chat = root.querySelector('[data-action="chat"]');
    const isPeople = stage.isPanelShown('people');
    const isChat = stage.isPanelShown('chat');
    paintPanel(people, isPeople, `${stage.people.length}`, 'People');
    const peopleName = waiting > 0 ? `People, ${waiting} waiting` : 'People';
    people.setAttribute('aria-label', peopleName);
    people.classList.toggle('alert', waiting > 0);
    const unread = isChat ? 0 : unreadOf(stage);
    const count = unread > 0 ? `${unread}` : '';
    paintPanel(chat, isChat, count, 'Chat');
    const chatName = unread > 0 ? `Chat, ${unread} unread` : 'Chat';
    chat.setAttribute('aria-label', chatName);
    paintMore(root, isPhone ? waiting + unread : 0);
  }

  #paintSharing(media) {
    const pill = this.#host?.querySelector('.call-sharing');
    if (!pill) return;
    const isOn = hasScreen(media);
    pill.classList.toggle('hidden', !isOn);
    if (!isOn && this.#kind === 'sharing') this.#active.close();
  }

  paintCounts() {
    const root = this.#root;
    if (!root || !this.#stage.media) return;
    this.#paintPanels(root);
  }
}

export { CallControls, createSharing, createIconButton, pipSupported };
export { paintIconToggle, paintReaction, PIP_MISSING };
export { MIC_HINT, CAMERA_HINT, REACT_HINT };
