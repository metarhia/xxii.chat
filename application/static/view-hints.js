const tileHint = (tile, hidden) => {
  const rect = tile.getBoundingClientRect();
  const style = globalThis.getComputedStyle(tile);
  const viewportWidth = globalThis.innerWidth;
  const viewportHeight = globalThis.innerHeight;
  const outside =
    rect.bottom <= 0 ||
    rect.right <= 0 ||
    rect.top >= viewportHeight ||
    rect.left >= viewportWidth;
  const invisible =
    hidden ||
    outside ||
    style.visibility === 'hidden' ||
    style.display === 'none' ||
    rect.width <= 0 ||
    rect.height <= 0;
  const slot = tile.dataset.slot ?? 'camera';
  const width = invisible ? 0 : Math.ceil(rect.width);
  const height = invisible ? 0 : Math.ceil(rect.height);
  const fps = invisible ? 0 : 30;
  return { slot, width, height, fps };
};

class ViewHints {
  constructor(send, notice) {
    this.send = send;
    this.notice = notice;
    this.tiles = [];
    this.previous = new Map();
    this.observer = null;
    this.timer = null;
    this.onChange = () => this.refresh();
    if (!('hidden' in globalThis.document)) {
      this.notice('Page visibility detection is unavailable in this browser.');
    }
    const Observer = globalThis.ResizeObserver;
    if (typeof Observer === 'function') {
      this.observer = new Observer(this.onChange);
    } else {
      this.notice(
        'Tile resize detection is unavailable; checking once a second.',
      );
    }
    globalThis.document?.addEventListener('visibilitychange', this.onChange);
    this.timer = setInterval(this.onChange, 1000);
    this.timer.unref?.();
  }

  update(tiles) {
    this.observer?.disconnect();
    this.tiles = tiles;
    for (const tile of tiles) this.observer?.observe(tile);
    this.refresh();
  }

  refresh() {
    const hints = new Map();
    for (const tile of this.tiles) {
      const endpoint = tile.dataset.endpoint;
      const hint = tileHint(tile, globalThis.document?.hidden === true);
      const key = `${endpoint}\n${hint.slot}`;
      const previous = hints.get(key);
      if (previous) {
        hint.width = Math.max(previous.hint.width, hint.width);
        hint.height = Math.max(previous.hint.height, hint.height);
        hint.fps = Math.max(previous.hint.fps, hint.fps);
      }
      hints.set(key, { endpoint, hint });
    }
    for (const key of this.previous.keys()) {
      if (hints.has(key)) continue;
      const item = this.previous.get(key);
      const slot = item.hint.slot;
      const hint = { slot, width: 0, height: 0, fps: 0 };
      hints.set(key, { endpoint: item.endpoint, hint });
    }
    for (const key of hints.keys()) {
      const item = hints.get(key);
      const previous = this.previous.get(key);
      const text = JSON.stringify(item.hint);
      if (previous && text === JSON.stringify(previous.hint)) continue;
      this.send(item.endpoint, item.hint);
    }
    this.previous = hints;
  }

  stop() {
    this.observer?.disconnect();
    clearInterval(this.timer);
    globalThis.document?.removeEventListener('visibilitychange', this.onChange);
    this.tiles = [];
    this.previous.clear();
  }
}

export { ViewHints };
