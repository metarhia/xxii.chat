import { CHAT_SHORTCUTS, localKeys } from './chat-keys.js';
import { helpOf } from './call-keys.js';
import { AboutPage } from './settings-about.js';
import { StreamingPage } from './settings-streaming.js';
import { AppearancePage } from './settings-appearance.js';
import { NotificationsPage } from './settings-notifications.js';
import { StoragePage } from './settings-storage.js';
import { Appearance } from './appearance.js';

const DEFAULT_SECTION = 'profile';
const SAVED_MS = 1000;
const PEER_LENGTH = 8;

const create = (tag, className, text = '') => {
  const element = document.createElement(tag);
  element.className = className;
  element.textContent = text;
  return element;
};

const createKeyRow = ({ keys, label }) => {
  const row = create('div', 'row');
  row.append(create('dt', 'row-label', label));
  const value = create('dd', 'row-keys');
  value.append(create('kbd', '', localKeys(keys)));
  row.append(value);
  return row;
};

const fillKeys = (list, rows) => {
  list.replaceChildren(...rows.map(createKeyRow));
};

class SettingsView {
  #timers = new WeakMap();

  constructor(root, hooks) {
    this.root = root;
    this.hooks = hooks;
    this.app = root.closest('.app');
    this.list = this.app.querySelector('.settings-list');
    this.title = root.querySelector('#settings-section-name');
    this.back = root.querySelector('#settings-back');
    this.buttons = Array.from(this.list.querySelectorAll('button'));
    this.pages = Array.from(root.querySelectorAll('.settings-page'));
    this.section = DEFAULT_SECTION;
    this.last = DEFAULT_SECTION;
    this.about = new AboutPage(root, hooks);
    this.streaming = new StreamingPage(root, hooks);
    this.appearance = new Appearance(window);
    this.appearancePage = new AppearancePage(root, this.appearance);
    this.notifications = new NotificationsPage(root, this.appearance);
    this.storage = new StoragePage(root, hooks);
    this.peer = root.querySelector('#peer-id');
    fillKeys(root.querySelector('#keys-chat'), CHAT_SHORTCUTS);
    fillKeys(root.querySelector('#keys-call'), helpOf());
    this.list.addEventListener('click', (event) => {
      const button = event.target.closest('[data-section]');
      if (button) this.choose(button.dataset.section);
    });
    this.back.onclick = () => hooks.closeLayer('settings-section');
    this.app.querySelector('#settings-exit').onclick = () => hooks.close();
    root.querySelector('#settings-close').onclick = () => hooks.close();
    root.querySelector('#peer-copy').onclick = () => hooks.copy(hooks.peer());
    root.querySelector('#open-recordings').onclick = () => hooks.library();
    root.addEventListener('change', (event) => this.flash(event.target));
    this.select(DEFAULT_SECTION);
  }

  get isOpen() {
    return this.app.dataset.view === 'settings';
  }

  get isHidden() {
    return this.hooks.isNarrow() && this.root.dataset.pane === 'list';
  }

  idOf(section) {
    const known = this.buttons.some(
      (button) => button.dataset.section === section,
    );
    return known ? section : DEFAULT_SECTION;
  }

  open(section = '') {
    const isNew = !this.isOpen;
    if (isNew) {
      this.app.dataset.view = 'settings';
      this.hooks.pushLayer('settings');
    }
    if (section === '' && isNew && this.hooks.isNarrow()) {
      this.root.dataset.pane = 'list';
      this.select(this.last);
      return;
    }
    this.choose(section === '' ? this.last : section);
  }

  hide() {
    delete this.app.dataset.view;
    this.root.dataset.pane = 'list';
    this.hooks.preview(false);
    this.syncStorage();
  }

  syncStorage() {
    const isShown = this.isOpen && !this.isHidden;
    this.storage.watch(this.section === 'storage' && isShown);
  }

  choose(section) {
    this.select(section);
    if (!this.hooks.isNarrow()) return;
    this.root.dataset.pane = 'section';
    this.hooks.pushLayer('settings-section');
    this.hooks.preview(this.section === 'media');
    this.syncStorage();
  }

  showList() {
    this.root.dataset.pane = 'list';
    this.hooks.preview(false);
    this.syncStorage();
  }

  select(section) {
    const id = this.idOf(section);
    this.section = id;
    this.last = id;
    for (const button of this.buttons) {
      const isCurrent = button.dataset.section === id;
      if (isCurrent) button.setAttribute('aria-current', 'page');
      else button.removeAttribute('aria-current');
    }
    for (const page of this.pages) page.hidden = page.dataset.page !== id;
    const current = this.buttons.find(
      (button) => button.dataset.section === id,
    );
    this.title.textContent = current.firstChild.textContent.trim();
    if (id === 'streaming') this.streaming.reload(null);
    this.refresh();
    const isShown = this.isOpen && !this.isHidden;
    this.hooks.preview(id === 'media' && isShown);
    if (id === 'media') this.hooks.devices();
    this.syncStorage();
  }

  refresh() {
    this.peer.textContent = this.hooks.peer().slice(0, PEER_LENGTH);
    this.about.paint();
    if (this.section === 'streaming') this.streaming.paint();
    if (this.section === 'notifications') this.notifications.paint();
    if (this.section === 'storage') this.storage.paint();
  }

  flash(control) {
    const isText = control.type === 'text';
    const row = control.closest('.row');
    if (!isText || !row) return;
    const saved = row.querySelector('.saved');
    if (!saved) return;
    clearTimeout(this.#timers.get(saved));
    saved.textContent = 'saved';
    const timer = setTimeout(() => {
      saved.textContent = '';
    }, SAVED_MS);
    this.#timers.set(saved, timer);
  }

  sync(key) {
    const isMedia = key === null || key.startsWith('xxii:devices');
    if (this.section === 'media' && isMedia) this.hooks.devices();
    if (this.section === 'streaming') this.streaming.reload(key);
    this.refresh();
  }
}

export { SettingsView };
