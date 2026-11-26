import { ringGainOf } from './app-settings.js';
import { createCaption, createSwitch, createRange } from './settings-rows.js';
import { createSaved } from './settings-rows.js';
import { testRing } from './ringtone.js';

const KEY = 'notify';
const NEEDS_TEXT = 'Needs the browser permission';
const BLOCKED_TEXT =
  'Allow notifications for this site in the site settings of the browser';
const PERMISSION_NOTE = 'Calls and messages while no tab is in front';
const FAILED_MS = 3000;

const STATES = {
  granted: 'allowed',
  default: 'not asked',
  denied: 'blocked',
  unsupported: 'not supported',
};

const SWITCHES = {
  ring: ['Ringtone', 'Play a sound for an incoming call', false],
  notifyCalls: [
    'Notify when the tab is hidden',
    'Show a system notification for an incoming call',
    true,
  ],
  notifyDirect: ['Direct messages', 'Every new message in a direct chat', true],
  notifyReplies: ['Replies to me', 'Replies to your messages and posts', true],
  notifyText: [
    'Show message text',
    'Off shows New message instead of the text',
    false,
  ],
  callToasts: [
    'Join and leave toasts',
    'Shown for calls of up to 8 people',
    false,
  ],
};

const GROUPS = {
  calls: ['ring', 'volume', 'notifyCalls'],
  messages: ['notifyDirect', 'notifyReplies', 'notifyText'],
  incall: ['callToasts'],
};

const create = (tag, className = '', text = '') => {
  const element = document.createElement(tag);
  element.className = className;
  element.textContent = text;
  return element;
};

const createButton = (text) => {
  const button = create('button', 'link-btn', text);
  button.type = 'button';
  return button;
};

const permissionOf = () => globalThis.Notification?.permission ?? 'unsupported';

const askPermission = () => {
  const Notify = globalThis.Notification;
  if (typeof Notify?.requestPermission !== 'function') return Promise.resolve();
  try {
    return Promise.resolve(Notify.requestPermission()).catch(() => undefined);
  } catch {
    return Promise.resolve();
  }
};

const createRow = (caption, note, ...controls) => {
  const row = create('label', 'row');
  const field = create('span', 'row-field');
  field.append(...controls);
  row.append(createCaption(caption, note), field);
  return row;
};

class NotificationsPage {
  #timer = 0;

  constructor(root, appearance) {
    this.page = root.querySelector('[data-page="notifications"]');
    this.appearance = appearance;
    this.status = create('span', 'row-value');
    this.allow = createButton('allow');
    this.volume = createRange('ringVolume', KEY);
    this.percent = create('span', 'row-value');
    this.test = createButton('test');
    this.failed = createSaved();
    this.switches = new Map();
    this.notes = new Map();
    this.permissionNote = null;
    this.fill();
    this.page.addEventListener('change', (event) => this.change(event.target));
    this.page.addEventListener('input', (event) => this.slide(event.target));
    this.allow.onclick = () => this.request();
    this.test.onclick = () => this.ring();
    this.appearance.watch(() => this.paint());
    this.watchPermission();
    this.paint();
  }

  fill() {
    const permission = create('div', 'row');
    const caption = createCaption('Notifications', PERMISSION_NOTE);
    this.permissionNote = caption.querySelector('.row-note');
    permission.append(caption);
    const state = create('span', 'row-field');
    state.append(this.status, this.allow);
    permission.append(state);
    this.page.querySelector('[data-group="permission"]').append(permission);
    for (const group in GROUPS) {
      const rows = GROUPS[group].map((name) => this.createRow(name));
      this.page.querySelector(`[data-group="${group}"]`).append(...rows);
    }
  }

  createRow(name) {
    if (name === 'volume') {
      const note = 'Peak loudness of the ringtone';
      const row = createRow('Ringtone volume', note, this.volume);
      row.classList.add('row-volume');
      const field = row.querySelector('.row-field');
      field.append(this.percent, this.failed, this.test);
      return row;
    }
    const [caption, note] = SWITCHES[name];
    const control = createSwitch(name, KEY);
    const row = createRow(caption, note, control);
    this.switches.set(name, control);
    this.notes.set(name, row.querySelector('.row-note'));
    return row;
  }

  watchPermission() {
    const query = globalThis.navigator?.permissions?.query;
    if (typeof query !== 'function') return;
    const request = { name: 'notifications' };
    query
      .call(globalThis.navigator.permissions, request)
      .then((status) => {
        status.onchange = () => this.paint();
      })
      .catch(() => undefined);
  }

  change({ dataset, checked }) {
    const name = dataset[KEY];
    if (!name || name === 'ringVolume') return;
    this.appearance.set(name, checked);
    const needsPermission = SWITCHES[name]?.[2] === true;
    if (checked && needsPermission) this.request();
  }

  slide({ dataset, value }) {
    if (dataset[KEY] !== 'ringVolume') return;
    this.appearance.set('ringVolume', Number(value));
  }

  request() {
    if (permissionOf() !== 'default') return;
    askPermission().then(() => this.paint());
  }

  ring() {
    const peak = ringGainOf(this.appearance.settings.ringVolume);
    testRing(peak).catch(() => {
      this.failed.textContent = 'sound is unavailable';
      clearTimeout(this.#timer);
      this.#timer = setTimeout(() => {
        this.failed.textContent = '';
      }, FAILED_MS);
    });
  }

  paint() {
    const { settings } = this.appearance;
    const permission = permissionOf();
    const isMissing = permission !== 'granted';
    this.status.textContent = STATES[permission];
    this.allow.hidden = permission !== 'default';
    const isBlocked = permission === 'denied';
    const text = isBlocked ? BLOCKED_TEXT : PERMISSION_NOTE;
    this.permissionNote.textContent = text;
    for (const [name, control] of this.switches) {
      control.checked = settings[name];
      const needsPermission = SWITCHES[name][2] && isMissing;
      const text = needsPermission ? NEEDS_TEXT : SWITCHES[name][1];
      this.notes.get(name).textContent = text;
    }
    this.volume.value = String(settings.ringVolume);
    this.percent.textContent = `${settings.ringVolume}%`;
    this.volume.disabled = !settings.ring;
  }
}

export { NotificationsPage, permissionOf };
