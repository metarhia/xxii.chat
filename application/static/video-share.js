import { cloneTemplate } from './view.js';
import {
  describeVideo,
  newRoom,
  readShare,
  shareUrlOf,
} from './video-pieces.js';
import { VideoSwarm } from './video-swarm.js';

const KEY_PREFIX = 'xxii:video-share:';

const savedRoom = (key, id) => {
  let previous;
  try {
    previous = readShare(localStorage.getItem(KEY_PREFIX + key) ?? '');
  } catch {
    return newRoom();
  }
  if (previous?.id === id) return previous.room;
  const room = newRoom();
  try {
    localStorage.setItem(KEY_PREFIX + key, `#${room}.${id}`);
  } catch {
    return room;
  }
  return room;
};

class VideoShares {
  constructor(layers) {
    this.layers = layers;
    this.seeds = new Map();
    this.dialog = null;
    window.addEventListener('pagehide', () => {
      for (const seed of this.seeds.values()) seed.close();
      this.seeds.clear();
    });
  }

  get active() {
    return this.seeds.size > 0 || Boolean(this.dialog);
  }

  closeDialog() {
    this.dialog?.close();
  }

  async open({ key, name, mime, source }) {
    if (this.dialog) return;
    const template = document.getElementById('video-share-template');
    const dialog = cloneTemplate(template, 'dialog');
    const status = dialog.querySelector('[data-share="status"]');
    const details = dialog.querySelector('[data-share="details"]');
    const input = dialog.querySelector('input');
    const watch = dialog.querySelector('a');
    const progress = dialog.querySelector('progress');
    const stop = dialog.querySelector('[data-share="stop"]');
    const control = new AbortController();
    const { signal } = control;
    this.dialog = dialog;
    dialog.querySelector('[data-share="close"]').onclick = () => dialog.close();
    dialog.addEventListener('keydown', (event) => event.stopPropagation());
    dialog.addEventListener(
      'close',
      () => {
        control.abort();
        dialog.remove();
        this.dialog = null;
        this.layers?.pop('video-share');
      },
      { once: true },
    );
    document.body.append(dialog);
    this.layers?.push('video-share');
    dialog.showModal();
    const show = (seed) => {
      const url = shareUrlOf(seed.room, seed.pieces.id);
      input.value = url;
      watch.href = url;
      details.hidden = false;
      progress.hidden = true;
      status.textContent = 'Sharing while this tab stays open.';
      stop.onclick = () => {
        seed.close();
        this.seeds.delete(key);
        dialog.close();
      };
    };
    dialog.querySelector('[data-share="copy"]').onclick = async () => {
      try {
        await navigator.clipboard.writeText(input.value);
        status.textContent = 'Video link copied.';
      } catch {
        input.focus();
        input.select();
        status.textContent = 'Select and copy the video link.';
      }
    };
    const active = this.seeds.get(key);
    if (active) return void show(active);
    let seed = null;
    try {
      const file = await source(signal);
      const { id, manifest } = await describeVideo(
        file,
        name,
        mime,
        (value) => {
          progress.value = value;
        },
        signal,
      );
      const room = savedRoom(key, id);
      seed = new VideoSwarm({ id, room, manifest, source: file });
      const stopPending = () => seed.close();
      signal.addEventListener('abort', stopPending, { once: true });
      await seed.start();
      signal.throwIfAborted();
      signal.removeEventListener('abort', stopPending);
      this.seeds.set(key, seed);
      show(seed);
    } catch (error) {
      seed?.close();
      if (signal.aborted) return;
      progress.hidden = true;
      status.textContent = error.message;
    }
  }
}

export { VideoShares };
