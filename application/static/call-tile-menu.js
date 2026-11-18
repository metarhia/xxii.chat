import { Menu, Press } from './overlays.js';
import { tileId } from './call-layout.js';

const adminItems = (stage, endpoint) => {
  if (!stage.isAdmin || endpoint === stage.session?.endpoint) return [];
  const person = stage.personOf(endpoint);
  if (!person) return [];
  const mute = person.mic ? 'Ask to mute' : 'Ask to unmute';
  const items = [{ action: 'ask-mute', label: mute }];
  if (person.camera) {
    items.push({ action: 'stop-camera', label: 'Stop camera' });
  }
  if (person.screen) {
    items.push({ action: 'stop-remote-screen', label: 'Stop screen' });
  }
  const lit = stage.spotlight === endpoint;
  const spotlight = lit ? 'Clear spotlight' : 'Spotlight';
  items.push({ action: 'spotlight', label: spotlight });
  const host = person.peer !== '' && person.peer === stage.hostPeer;
  if (!host) {
    const label = person.admin ? 'Remove co-host' : 'Make co-host';
    const action = person.admin ? 'demote' : 'promote';
    items.push({ action, label });
  }
  items.push({ action: 'remove', label: 'Remove' });
  return items;
};

class TileMenu {
  constructor(stage) {
    this.stage = stage;
    this.tile = null;
    this.trigger = null;
    this.element = document.createElement('div');
    this.element.className = 'menu call-tile-menu hidden';
    this.element.setAttribute('aria-label', 'Participant options');
    this.menu = new Menu(this.element, () => []);
    this.press = new Press({
      hold: (tile, x, y) => {
        this.open(tile, { x, y });
      },
    });
    this.onDown = (event) => this.pointerDown(event);
    this.onMove = (event) => this.press.move(event);
    this.onUp = () => this.press.end();
    this.onCancel = () => this.press.abort();
    this.onClick = (event) => this.click(event);
    this.onFocus = (event) => {
      const inside = this.element.contains(event.target);
      if (this.menu.isOpen && !inside && event.target !== this.trigger) {
        this.close(false);
      }
    };
    this.element.addEventListener('click', this.onClick);
    document.addEventListener('pointerdown', this.onDown, true);
    document.addEventListener('pointermove', this.onMove);
    document.addEventListener('pointerup', this.onUp);
    document.addEventListener('pointercancel', this.onCancel);
    document.addEventListener('focusin', this.onFocus);
    document.body.append(this.element);
  }

  pointerDown(event) {
    const inside = this.element.contains(event.target);
    const button = event.target.closest?.('[data-action="tile-menu"]');
    if (this.menu.isOpen && !inside && !button) this.close(false);
    const tile = event.target.closest?.('.call-tile');
    if (!tile || !this.stage.host?.contains(tile)) return;
    if (event.target.closest('button, input, select, summary')) return;
    this.press.start(event, tile, false);
  }

  toggle(tile, trigger) {
    if (this.tile === tile && this.menu.isOpen) return void this.close();
    const rect = trigger.getBoundingClientRect();
    this.open(tile, { x: rect.left, y: rect.bottom });
  }

  open(tile, point) {
    this.close(false);
    this.tile = tile;
    this.trigger = tile.querySelector('[data-action="tile-menu"]');
    const endpoint = tile.dataset.endpoint;
    const slot = tile.dataset.slot;
    const stage = this.stage;
    const local = endpoint === stage.session?.endpoint;
    const pinned = stage.pin === tileId(endpoint, slot);
    const items = [
      { action: 'pin', label: pinned ? 'Unpin' : 'Pin' },
      { action: 'tile-fullscreen', label: 'Full screen tile' },
    ];
    if (!local) {
      const shown = stage.statsAll
        ? !stage.statsHidden.has(endpoint)
        : stage.statsShown.has(endpoint);
      items.push({
        action: 'tile-stats',
        label: shown ? 'Hide stats' : 'Show stats',
      });
      const enabled = stage.session?.isAudioOnly(endpoint);
      const poor = stage.quality.get(endpoint)?.poor;
      const label =
        poor && !enabled ? 'Poor connection · try audio only' : 'Audio only';
      items.push({
        action: 'audio-only',
        label: enabled ? 'Audio only on' : label,
      });
    }
    const menuItems = items.concat(adminItems(stage, endpoint));
    const parent = document.fullscreenElement ?? document.body;
    parent.append(this.element);
    this.menu.open({
      id: tileId(endpoint, slot),
      mine: new Set(),
      items: menuItems,
      point,
      item: null,
    });
    const audio = this.element.querySelector('[data-action="audio-only"]');
    if (audio) {
      const enabled = stage.session?.isAudioOnly(endpoint);
      const requested = stage.session?.requestedAudioOnly(endpoint);
      audio.disabled = enabled && !requested;
      if (audio.disabled) audio.textContent = 'Peer chose audio only';
    }
    if (!local) this.addVolume(endpoint);
    const bottom =
      parseFloat(this.element.style.top) + this.element.offsetHeight;
    if (bottom > window.innerHeight - 8) {
      const top = Math.max(
        8,
        window.innerHeight - this.element.offsetHeight - 8,
      );
      this.element.style.top = `${top}px`;
    }
    tile.classList.add('targeted');
    this.trigger?.setAttribute('aria-expanded', 'true');
    this.menu.focus();
  }

  addVolume(endpoint) {
    const peer = this.stage.peerOf(endpoint);
    const field = document.createElement('label');
    field.className = 'tile-volume';
    const caption = document.createElement('span');
    const input = document.createElement('input');
    input.type = 'range';
    input.min = '0';
    input.max = '200';
    input.step = '1';
    input.value = `${this.stage.volume.get(peer)}`;
    input.setAttribute('aria-label', 'Local participant volume');
    const paint = () => {
      caption.textContent = `Local volume ${input.value}%`;
    };
    input.addEventListener('input', () => {
      this.stage.volume.set(peer, Number(input.value));
      paint();
    });
    input.addEventListener('keydown', (event) => {
      if (event.key !== 'Escape') event.stopPropagation();
    });
    paint();
    field.append(caption, input);
    const reset = document.createElement('button');
    reset.type = 'button';
    reset.className = 'menu-item';
    reset.textContent = 'Reset volume to 100%';
    reset.addEventListener('click', () => {
      input.value = '100';
      this.stage.volume.set(peer, 100);
      paint();
    });
    this.element.append(field, reset);
  }

  click(event) {
    event.stopPropagation();
    const action = event.target.closest('[data-action]')?.dataset.action;
    if (!action || !this.tile) return;
    const { endpoint, slot } = this.tile.dataset;
    this.close();
    this.stage.onAction(action, endpoint, slot);
  }

  close(restore = true) {
    const trigger = this.trigger;
    this.tile?.classList.remove('targeted');
    trigger?.setAttribute('aria-expanded', 'false');
    this.menu.close();
    this.tile = null;
    this.trigger = null;
    if (restore && trigger?.isConnected) trigger.focus();
  }

  stop() {
    this.close(false);
    this.press.abort();
    document.removeEventListener('pointerdown', this.onDown, true);
    document.removeEventListener('pointermove', this.onMove);
    document.removeEventListener('pointerup', this.onUp);
    document.removeEventListener('pointercancel', this.onCancel);
    document.removeEventListener('focusin', this.onFocus);
    this.element.remove();
  }
}

export { TileMenu };
