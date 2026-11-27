import { colorOf, initialsOf } from './avatar.js';
import { avatarOf, showPhoto } from './avatar.js';
import { createIcon } from './icons.js';
import { plural } from './view.js';

const NO_NICK = 'set your nick';
const STATUS_OF = { server: 'online', p2p: 'away', offline: 'offline' };
const WORDS = { server: 'online', p2p: 'peers only', offline: 'offline' };

const statusOf = (link) => STATUS_OF[link] ?? 'offline';

const lineOf = ({ link, isLeader, peers }) => {
  const word = WORDS[link] ?? WORDS.offline;
  if (word === WORDS.offline) return word;
  const how = isLeader ? word : 'via leader tab';
  return `${how} · ${plural(peers, 'peer', 'peers')}`;
};

class ProfileRow {
  #main = null;
  #avatar = null;
  #preview = null;
  #nick = null;
  #dot = null;
  #state = null;
  #info = { link: 'offline', isLeader: true, peers: 0 };
  #gear = null;
  #version = null;
  #removePhoto = null;
  #marks = [];

  constructor(setAvatar, root = document) {
    const byId = (id) => root.getElementById(id);
    this.#main = byId('profile-main');
    this.#avatar = byId('profile-avatar');
    this.#preview = byId('profile-preview');
    this.#nick = byId('profile-nick');
    this.#dot = byId('profile-dot');
    this.#state = byId('profile-state');
    this.#gear = byId('settings-btn');
    this.#version = byId('profile-version');
    byId('recordings-btn').prepend(createIcon('recordings', root));
    this.#gear.prepend(createIcon('settings', root));
    this.#marks = [byId('settings-dot'), byId('about-dot')];
    this.#removePhoto = byId('profile-photo-remove');
    const choose = byId('profile-photo-choose');
    const file = byId('profile-photo-input');
    const status = byId('profile-photo-status');
    choose.onclick = () => file.click();
    file.onchange = async () => {
      const photo = file.files[0];
      file.value = '';
      if (!photo || choose.disabled) return;
      choose.disabled = this.#removePhoto.disabled = true;
      status.textContent = 'Preparing photo…';
      try {
        setAvatar(await avatarOf(photo));
        status.textContent = 'Profile photo saved.';
      } catch (error) {
        status.textContent = error.message;
      } finally {
        choose.disabled = this.#removePhoto.disabled = false;
      }
    };
    this.#removePhoto.onclick = () => {
      try {
        setAvatar('');
        status.textContent = 'Profile photo removed.';
        choose.focus();
      } catch (error) {
        status.textContent = error.message;
      }
    };
  }

  paint({
    nick = '',
    photo = '',
    peer = '',
    link = 'offline',
    isLeader = true,
    text = '',
  }) {
    const name = nick.trim();
    const initials = initialsOf(name);
    const color = colorOf(peer);
    for (const avatar of [this.#avatar, this.#preview]) {
      if (!showPhoto(avatar, photo)) avatar.textContent = initials;
      avatar.style.background = color;
    }
    this.#removePhoto.hidden = !photo;
    this.#nick.textContent = name || NO_NICK;
    this.#nick.classList.toggle('muted', name === '');
    this.#dot.dataset.status = statusOf(link);
    this.#main.title = text;
    this.#dot.setAttribute('aria-label', text);
    this.#info = { ...this.#info, link, isLeader };
    this.#paintLine();
  }

  countPeers(peers) {
    this.#info = { ...this.#info, peers };
    this.#paintLine();
  }

  #paintLine() {
    this.#state.textContent = lineOf(this.#info);
  }

  markUpdate(isReady) {
    for (const mark of this.#marks) mark.hidden = !isReady;
    const label = isReady ? 'Settings, update ready' : 'Settings';
    this.#gear.setAttribute('aria-label', label);
  }

  paintVersion({ version, next }) {
    const control = this.#version;
    control.hidden = !version;
    control.textContent = next ? `v${next} ↑` : `v${version}`;
    control.classList.toggle('ready', Boolean(next));
    const label = next
      ? `Restart to update to version ${next}`
      : `Version ${version}. Check for updates`;
    control.title = label;
    control.setAttribute('aria-label', label);
  }
}

export { ProfileRow, lineOf };
