import { colorOf, initialsOf } from './avatar.js';
import { createIcon } from './icons.js';

const NO_NICK = 'set your nick';
const STATUSES = ['online', 'away', 'offline'];

const statusOf = (status) => (STATUSES.includes(status) ? status : 'offline');

class ProfileRow {
  #main = null;
  #avatar = null;
  #preview = null;
  #nick = null;
  #dot = null;
  #gear = null;
  #marks = [];

  constructor(root = document) {
    const byId = (id) => root.getElementById(id);
    this.#main = byId('profile-main');
    this.#avatar = byId('profile-avatar');
    this.#preview = byId('profile-preview');
    this.#nick = byId('profile-nick');
    this.#dot = byId('profile-dot');
    this.#gear = byId('settings-btn');
    byId('recordings-btn').prepend(createIcon('recordings', root));
    this.#gear.prepend(createIcon('settings', root));
    this.#marks = [byId('settings-dot'), byId('about-dot')];
  }

  paint({ nick = '', peer = '', status = 'offline', text = '' }) {
    const name = nick.trim();
    const initials = initialsOf(name);
    const color = colorOf(peer);
    for (const avatar of [this.#avatar, this.#preview]) {
      avatar.textContent = initials;
      avatar.style.background = color;
    }
    this.#nick.textContent = name || NO_NICK;
    this.#nick.classList.toggle('muted', name === '');
    this.#dot.dataset.status = statusOf(status);
    this.#main.title = text;
    this.#dot.setAttribute('aria-label', text);
  }

  markUpdate(isReady) {
    for (const mark of this.#marks) mark.hidden = !isReady;
    const label = isReady ? 'Settings, update ready' : 'Settings';
    this.#gear.setAttribute('aria-label', label);
  }
}

export { ProfileRow };
