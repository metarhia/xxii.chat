import { PARTS, estimate, measure, breakdownOf } from './storage-usage.js';
import { sharesOf, usageText, partTexts, partsText } from './storage-usage.js';
import { sizeText } from './recording-files.js';
import { askConfirm } from './confirm-dialog.js';
import { createRow, createSwitch } from './settings-rows.js';
import { plural } from './view.js';

const COUNTING = 'counting…';
const UNAVAILABLE = 'Storage usage is unavailable in this browser';
const KEEP_NOTE = 'Asks the browser not to clear this data';
const KEPT_NOTE = `The browser keeps this site's data`;
const DECLINED_NOTE =
  'The browser declined; it keeps data of installed or often used sites';
const UNSUPPORTED_NOTE = 'Not supported in this browser';
const BUSY_TITLE = 'Allowed only while not recording';
const NO_RECORDINGS = 'No recordings in this browser';

const CLEAR_TEXT =
  'Messages come back from the server and online peers. Files only this ' +
  'browser has are lost. Recordings and settings stay.';
const OFFLINE_TEXT = 'You are offline: nothing comes back until you reconnect.';
const RESET_TEXT =
  'Theme, text size, notifications, call and device choices, network ' +
  'settings, and participant volumes go back to their defaults.';
const RESET_KEPT_TEXT =
  'Your nick, peer id, drafts, read marks, folders, and streaming ' +
  'destinations stay.';

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

const createBar = () => {
  const bar = create('div', 'usage-bar');
  bar.setAttribute('role', 'img');
  for (const [name] of PARTS) {
    const part = create('span');
    part.dataset.part = name;
    bar.append(part);
  }
  return bar;
};

const createUsage = () => {
  const box = create('div', 'usage');
  const bar = createBar();
  const text = create('p', 'usage-text');
  const parts = create('p', 'usage-parts');
  text.setAttribute('role', 'status');
  box.append(bar, text, parts);
  return { box, bar, text, parts };
};

const createLegend = (breakdown) =>
  partTexts(breakdown).map(({ name, text }) => {
    const part = create('span', 'usage-part', text);
    part.dataset.part = name;
    return part;
  });

const recordingsText = (count) => plural(count, 'recording', 'recordings');

const dialogOf = (kind, { count, bytes, isOffline }) => {
  if (kind === 'clear') {
    const lines = [CLEAR_TEXT];
    if (isOffline) lines.push(OFFLINE_TEXT);
    return { title: 'Clear messages and files?', lines, action: 'clear' };
  }
  if (kind === 'delete') {
    const line =
      `${recordingsText(count)} (${sizeText(bytes)}) ` +
      'will be deleted from this browser. Copies saved to a folder are not ' +
      'touched.';
    return { title: 'Delete recordings?', lines: [line], action: 'delete' };
  }
  return {
    title: 'Reset settings?',
    lines: [RESET_TEXT, RESET_KEPT_TEXT],
    action: 'reset',
  };
};

class StoragePage {
  constructor(root, hooks) {
    this.hooks = hooks;
    this.page = root.querySelector('[data-page="storage"]');
    this.walk = null;
    this.isCounting = false;
    this.isPersisted = false;
    this.isDeclined = false;
    this.estimate = null;
    this.sizes = null;
    this.count = 0;
    this.usage = createUsage();
    this.keep = createSwitch('keep');
    this.keepRow = createRow(
      'Keep data when the device is low on space',
      KEEP_NOTE,
      this.keep,
    );
    this.buttons = {
      clear: createButton('clear'),
      delete: createButton('delete'),
      reset: createButton('reset'),
    };
    this.rows = {
      clear: createRow(
        'Clear messages and files',
        'Messages come back from the server and online peers',
        this.buttons.clear,
      ),
      delete: createRow(
        'Delete recordings in this browser',
        COUNTING,
        this.buttons.delete,
      ),
      reset: createRow(
        'Reset settings',
        'Preferences go back to their defaults',
        this.buttons.reset,
      ),
    };
    this.page
      .querySelector('[data-group="usage"]')
      .append(this.usage.box, this.keepRow);
    this.page
      .querySelector('[data-group="danger"]')
      .append(this.rows.clear, this.rows.delete, this.rows.reset);
    this.keep.onchange = () => this.persist();
    for (const kind in this.buttons) {
      this.buttons[kind].onclick = () => this.confirm(kind);
    }
    this.paint();
  }

  get isActive() {
    return this.walk !== null;
  }

  watch(isOn) {
    if (!isOn) return void this.stop();
    if (this.isActive) return;
    this.measure();
    this.refreshPersisted();
  }

  stop() {
    this.walk?.abort();
    this.walk = null;
    this.isCounting = false;
  }

  async measure() {
    this.walk?.abort();
    const walk = new AbortController();
    this.walk = walk;
    this.isCounting = true;
    this.paint();
    const storage = globalThis.navigator?.storage;
    const counting = this.hooks.countRecordings().catch(() => 0);
    this.estimate = await estimate(storage);
    if (walk.signal.aborted) return;
    this.paint();
    const sizes = await measure(storage, walk.signal);
    const count = await counting;
    if (walk.signal.aborted) return;
    this.sizes = sizes;
    this.count = count;
    this.isCounting = false;
    this.paint();
  }

  async refreshPersisted() {
    const storage = globalThis.navigator?.storage;
    try {
      this.isPersisted = await storage.persisted();
    } catch {
      this.isPersisted = false;
    }
    this.paint();
  }

  async persist() {
    const storage = globalThis.navigator?.storage;
    this.isDeclined = false;
    if (this.keep.checked) {
      try {
        this.isPersisted = await storage.persist();
      } catch {
        this.isPersisted = false;
      }
      this.isDeclined = !this.isPersisted;
    }
    this.paint();
  }

  context() {
    const bytes = this.sizes?.recordings ?? 0;
    const { count } = this;
    return { count, bytes, isOffline: this.hooks.isOffline() };
  }

  async confirm(kind) {
    if (kind === 'delete' && this.hooks.isRecording()) return;
    const button = this.buttons[kind];
    const isConfirmed = await askConfirm(dialogOf(kind, this.context()));
    if (!isConfirmed) return void button.focus();
    button.disabled = true;
    try {
      await this.hooks[kind]();
    } finally {
      if (this.isActive) this.measure();
      this.paint();
    }
  }

  paintUsage() {
    const { box, bar, text, parts } = this.usage;
    const { sizes } = this;
    const hasData = this.estimate !== null || sizes !== null;
    const breakdown = breakdownOf({ ...this.estimate, sizes });
    const shares = sharesOf(breakdown);
    for (const span of bar.children) {
      span.style.width = `${shares[span.dataset.part]}%`;
    }
    box.classList.toggle('counting', this.isCounting);
    if (!hasData) {
      text.textContent = UNAVAILABLE;
      parts.replaceChildren();
      return void bar.removeAttribute('aria-label');
    }
    text.textContent = usageText(breakdown);
    if (sizes === null) {
      parts.textContent = COUNTING;
      return void bar.setAttribute('aria-label', text.textContent);
    }
    parts.replaceChildren(...createLegend(breakdown));
    const label = `${text.textContent}. ${partsText(breakdown)}`;
    bar.setAttribute('aria-label', label);
  }

  paintKeep() {
    const storage = globalThis.navigator?.storage;
    const canPersist = typeof storage?.persist === 'function';
    const note = this.keepRow.querySelector('.row-note');
    this.keep.checked = this.isPersisted;
    this.keep.disabled = !canPersist || this.isPersisted;
    if (!canPersist) note.textContent = UNSUPPORTED_NOTE;
    else if (this.isPersisted) note.textContent = KEPT_NOTE;
    else note.textContent = this.isDeclined ? DECLINED_NOTE : KEEP_NOTE;
  }

  paintDanger() {
    const isRecording = this.hooks.isRecording();
    const note = this.rows.delete.querySelector('.row-note');
    const button = this.buttons.delete;
    const bytes = this.sizes?.recordings ?? 0;
    if (this.isCounting && this.sizes === null) note.textContent = COUNTING;
    else if (this.count === 0) note.textContent = NO_RECORDINGS;
    else note.textContent = `${recordingsText(this.count)}, ${sizeText(bytes)}`;
    button.disabled = isRecording || this.count === 0;
    button.title = isRecording ? BUSY_TITLE : '';
    this.buttons.clear.disabled = false;
    this.buttons.reset.disabled = false;
  }

  paint() {
    this.paintUsage();
    this.paintKeep();
    this.paintDanger();
  }
}

export { StoragePage };
