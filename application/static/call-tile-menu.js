import { Menu, Press } from './overlays.js';
import { tileId } from './call-layout.js';
import { stageMove } from './studio.js';

const adminItems = (stage, endpoint) => {
  if (!stage.isAdmin) return [];
  const person = stage.personOf(endpoint);
  if (!person) return [];
  const move = stageMove(person);
  if (endpoint === stage.session?.endpoint) return [move];
  const mute = person.mic ? 'Ask to mute' : 'Ask to unmute';
  const items = [{ action: 'ask-mute', label: mute }];
  if (person.camera) {
    items.push({ action: 'stop-camera', label: 'Stop camera' });
  }
  if (person.screen) {
    items.push({ action: 'stop-remote-screen', label: 'Stop screen' });
  }
  if (person.hand > 0) {
    items.push({ action: 'lower-hand', label: 'Lower hand' });
  }
  const lit = stage.spotlight === endpoint;
  const spotlight = lit ? 'Clear spotlight' : 'Spotlight';
  items.push({ action: 'spotlight', label: spotlight });
  items.push(move);
  const host = person.peer !== '' && person.peer === stage.hostPeer;
  if (!host) {
    const label = person.admin ? 'Remove co-host' : 'Make co-host';
    const action = person.admin ? 'demote' : 'promote';
    items.push({ action, label });
  }
  items.push({ action: 'remove', label: 'Remove' });
  return items;
};

const audioItem = (stage, endpoint) => {
  const session = stage.session;
  const enabled = session?.isAudioOnly(endpoint);
  const requested = session?.requestedAudioOnly(endpoint);
  const poor = stage.quality.get(endpoint)?.poor;
  const label = enabled ? 'Audio only on' : 'Audio only';
  const offer = poor && !enabled ? 'Poor connection · try audio only' : label;
  const item = { action: 'audio-only', label: offer };
  if (!enabled || requested) return item;
  return { ...item, disabled: true, reason: 'Peer chose audio only' };
};

const personItems = (stage, endpoint, slot) => {
  const local = endpoint === stage.session?.endpoint;
  const pinned = stage.pin === tileId(endpoint, slot);
  const items = [
    { action: 'pin', label: pinned ? 'Unpin' : 'Pin' },
    { action: 'tile-fullscreen', label: 'Full screen tile' },
  ];
  if (!local) {
    const shown = stage.statsVisible(endpoint);
    const label = shown ? 'Hide stats' : 'Show stats';
    items.push({ action: 'tile-stats', label });
    items.push(audioItem(stage, endpoint));
  }
  return items.concat(adminItems(stage, endpoint));
};

const createVolume = (stage, endpoint) => {
  const peer = stage.peerOf(endpoint);
  const box = document.createElement('div');
  const field = document.createElement('label');
  field.className = 'tile-volume';
  const caption = document.createElement('span');
  const input = document.createElement('input');
  input.type = 'range';
  input.min = '0';
  input.max = '200';
  input.step = '1';
  input.value = `${stage.volume.get(peer)}`;
  input.setAttribute('aria-label', 'Local participant volume');
  const paint = () => {
    caption.textContent = `Local volume ${input.value}%`;
  };
  input.addEventListener('input', () => {
    stage.volume.set(peer, Number(input.value));
    paint();
  });
  paint();
  field.append(caption, input);
  const reset = document.createElement('button');
  reset.type = 'button';
  reset.className = 'menu-item';
  reset.textContent = 'Reset volume to 100%';
  reset.addEventListener('click', () => {
    input.value = '100';
    stage.volume.set(peer, 100);
    paint();
  });
  box.append(field, reset);
  return box;
};

class TileMenu {
  constructor(stage) {
    this.stage = stage;
    this.tile = null;
    this.endpoint = '';
    this.slot = 'camera';
    this.trigger = null;
    this.element = document.createElement('div');
    this.element.className = 'menu call-tile-menu hidden';
    this.element.setAttribute('aria-label', 'Participant options');
    const hooks = stage.hooks;
    const layers = {
      push: (name) => hooks.pushLayer?.(name),
      pop: (name) => hooks.popLayer?.(name),
    };
    const backdrop = document.getElementById('backdrop');
    this.menu = new Menu(this.element, { backdrop, layers });
    this.press = new Press({
      hold: (tile, x, y) => {
        this.open(tile, { x, y });
      },
    });
    this.onDown = (event) => this.pointerDown(event);
    this.onMove = (event) => this.press.move(event);
    this.onUp = () => this.press.end();
    this.onCancel = () => this.press.abort();
    document.addEventListener('pointerdown', this.onDown, true);
    document.addEventListener('pointermove', this.onMove);
    document.addEventListener('pointerup', this.onUp);
    document.addEventListener('pointercancel', this.onCancel);
    document.body.append(this.element);
  }

  pointerDown(event) {
    const tile = event.target.closest?.('.call-tile');
    if (!tile || !this.stage.host?.contains(tile)) return;
    if (event.target.closest('button, input, select, summary')) return;
    this.press.start(event, tile, false);
  }

  tileOf(endpoint, slot) {
    const tiles = this.stage.host?.querySelectorAll('.call-tile') ?? [];
    const isTile = (tile) =>
      tile.dataset.endpoint === endpoint && tile.dataset.slot === slot;
    return Array.from(tiles).find(isTile) ?? null;
  }

  toggle(tile, trigger) {
    if (this.menu.isOpen && this.trigger === trigger) return void this.close();
    const { endpoint, slot } = tile.dataset;
    this.show(endpoint, slot ?? 'camera', { tile, anchor: trigger });
  }

  toggleRoster(endpoint, trigger) {
    if (this.menu.isOpen && this.trigger === trigger) return void this.close();
    const tile = this.tileOf(endpoint, 'camera');
    this.show(endpoint, 'camera', { tile, anchor: trigger });
  }

  open(tile, point) {
    const { endpoint, slot } = tile.dataset;
    this.show(endpoint, slot ?? 'camera', { tile, point });
  }

  show(endpoint, slot, place) {
    this.release();
    const { tile, anchor, point } = place;
    const stage = this.stage;
    const items = personItems(stage, endpoint, slot);
    if (endpoint !== stage.session?.endpoint) {
      const element = createVolume(stage, endpoint);
      items.push({ kind: 'custom', element });
    }
    const target = tile?.querySelector('[data-action="tile-menu"]');
    this.tile = tile;
    this.endpoint = endpoint;
    this.slot = slot;
    this.trigger = anchor ?? target ?? null;
    const parent = document.fullscreenElement ?? document.body;
    parent.append(this.element);
    this.menu.open({
      id: tileId(endpoint, slot),
      items,
      anchor: anchor ?? null,
      point: point ?? null,
      trigger: this.trigger,
      select: (item, button, event) => this.choose(item, event),
      close: () => this.release(),
    });
    tile?.classList.add('targeted');
  }

  choose(item, event) {
    event.stopPropagation();
    const { endpoint, slot } = this;
    this.close();
    this.stage.onAction(item.action, endpoint, slot);
  }

  release() {
    this.tile?.classList.remove('targeted');
    this.tile = null;
    this.trigger = null;
  }

  close(restore = true) {
    const trigger = this.trigger;
    this.menu.close();
    this.release();
    if (restore && trigger?.isConnected) trigger.focus();
  }

  stop() {
    this.close(false);
    this.press.abort();
    document.removeEventListener('pointerdown', this.onDown, true);
    document.removeEventListener('pointermove', this.onMove);
    document.removeEventListener('pointerup', this.onUp);
    document.removeEventListener('pointercancel', this.onCancel);
    this.element.remove();
  }
}

export { TileMenu };
