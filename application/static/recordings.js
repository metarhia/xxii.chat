import { META_FILE, POSTER_FILE } from './recording-files.js';
import { programFileOf, recordingUrlOf, routeOf } from './recording-files.js';
import { stampOf, timeText, sizeText } from './recording-files.js';
import { readMeta, recordingsOf } from './recording-files.js';
import { exportNameOf, downloadUrlOf, exportFile } from './recording-export.js';
import { pickExportFile, exportToFolder } from './recording-export.js';
import { folderHandle } from './recording-folder.js';
import { cloneTemplate } from './view.js';
import { RecordingWriter } from './recorder.js';

const STATE_LABELS = {
  recording: 'Recording',
  paused: 'Recording (paused)',
  done: 'Done',
  interrupted: 'Interrupted',
};
const STORAGE_UNAVAILABLE = 'Storage usage is unavailable.';
const REPAIR_CHANNEL = 'xxii-recording-repair';

const startedOf = ({ started }) => (Number.isFinite(started) ? started : 0);

const sortRecordings = (entries) =>
  entries.toSorted((left, right) => startedOf(right) - startedOf(left));

const textOf = (value) => (typeof value === 'string' ? value.trim() : '');

const labelsOf = (meta) => {
  const { duration, size, started, folder } = meta;
  const state = textOf(meta.state);
  const hasDate =
    Number.isFinite(started) && Number.isFinite(new Date(started).getTime());
  return {
    title: textOf(meta.title) || 'Untitled recording',
    chat: textOf(meta.chatName) || textOf(meta.chat) || 'No chat',
    date: hasDate ? stampOf(started, ':') : 'Unknown date',
    duration: Number.isFinite(duration)
      ? timeText(duration)
      : 'Unknown duration',
    size: Number.isFinite(size) ? sizeText(size) : 'Unknown size',
    state: Object.hasOwn(STATE_LABELS, state) ? STATE_LABELS[state] : 'Unknown',
    location: textOf(folder) || 'Browser storage',
  };
};

const storageText = (estimate = {}) => {
  const { usage, quota } = estimate;
  if (!Number.isFinite(usage) || !Number.isFinite(quota)) {
    return STORAGE_UNAVAILABLE;
  }
  return `${sizeText(usage)} used · ${sizeText(quota - usage)} free`;
};

const canChange = (meta) =>
  meta?.state === 'done' || meta?.state === 'interrupted';

const rememberedFolder = async () => {
  if (!globalThis.showDirectoryPicker || !globalThis.indexedDB) return null;
  return folderHandle();
};

const readEntry = async (directory) => {
  const id = directory.name;
  if (!routeOf(recordingUrlOf(id, META_FILE))) return null;
  try {
    const handle = await directory.getFileHandle(META_FILE);
    const meta = await readMeta(handle);
    if (typeof meta?.state !== 'string') return null;
    const poster = await directory.getFileHandle(POSTER_FILE).catch(() => null);
    const posterUrl = poster ? recordingUrlOf(id, POSTER_FILE) : '';
    return { ...meta, id, posterUrl };
  } catch {
    return null;
  }
};

const entriesOf = async (recordings) => {
  if (!recordings) return [];
  const entries = [];
  for await (const directory of recordings.values()) {
    if (directory.kind !== 'directory') continue;
    const entry = await readEntry(directory);
    if (entry) entries.push(entry);
  }
  return sortRecordings(entries);
};

class Recordings {
  constructor(panel, onRepair) {
    this.panel = panel;
    this.list = panel.querySelector('.recordings-list');
    this.storage = panel.querySelector('.recordings-storage');
    this.status = panel.querySelector('.recordings-status');
    this.repairStatus = panel.querySelector('.recordings-repair');
    this.player = panel.querySelector('video');
    this.template = document.getElementById('recording-item-template');
    this.recordings = null;
    this.selected = '';
    this.revision = 0;
    this.isChanging = false;
    const canBroadcast = typeof BroadcastChannel === 'function';
    this.repairChannel = canBroadcast
      ? new BroadcastChannel(REPAIR_CHANNEL)
      : null;
    this.repairChannel?.addEventListener('message', onRepair);
    this.player.addEventListener('error', () => {
      if (this.selected) this.setStatus('Could not play this recording.');
    });
  }

  setStatus(text) {
    this.status.textContent = text;
    this.status.classList.toggle('hidden', text === '');
  }

  async repair() {
    let writer = null;
    let notice = '';
    try {
      if (typeof Worker !== 'function') {
        throw new Error('Recording workers are unavailable');
      }
      writer = new RecordingWriter();
      const { repaired, failed } = await writer.repair();
      if (repaired > 0) this.repairChannel?.postMessage('repaired');
      if (failed > 0) {
        notice = 'Some interrupted recordings could not be repaired.';
      }
    } catch (error) {
      notice = `Recording repair could not run. ${error.message}.`;
    } finally {
      writer?.stop();
      this.repairStatus.textContent = notice;
      this.repairStatus.hidden = notice === '';
    }
  }

  async refresh() {
    const revision = ++this.revision;
    const storage = navigator.storage;
    if (!storage?.getDirectory) {
      this.setStatus('Browser storage for recordings is unavailable.');
      return;
    }
    this.refreshStorage(storage, revision).catch(() => {
      if (revision === this.revision) {
        this.storage.textContent = STORAGE_UNAVAILABLE;
      }
    });
    try {
      const recordings = await recordingsOf(storage);
      const entries = await entriesOf(recordings);
      const folder = await rememberedFolder().catch(() => null);
      if (revision !== this.revision) return;
      this.recordings = recordings;
      this.list.replaceChildren(
        ...entries.map((entry) => this.createRow(entry, folder)),
      );
      this.setStatus(entries.length ? '' : 'No recordings yet.');
    } catch {
      if (revision === this.revision) {
        this.setStatus('Could not read the recordings in browser storage.');
      }
    }
  }

  async refreshStorage(storage, revision) {
    const estimate = await storage.estimate?.();
    if (revision === this.revision) {
      this.storage.textContent = storageText(estimate);
    }
  }

  close() {
    this.revision++;
    this.stopPlayback();
  }

  stopPlayback() {
    if (!this.selected) return;
    this.selected = '';
    this.player.classList.add('hidden');
    this.player.removeAttribute('src');
    this.player.removeAttribute('poster');
    this.player.load();
  }

  play(entry) {
    if (!navigator.serviceWorker?.controller) {
      this.setStatus('Recording playback is unavailable. Reload to try again.');
      return;
    }
    const file = programFileOf(entry.extension);
    this.setStatus('');
    this.stopPlayback();
    this.selected = entry.id;
    const { title } = labelsOf(entry);
    this.player.setAttribute('aria-label', title);
    if (entry.posterUrl) this.player.poster = entry.posterUrl;
    this.player.src = recordingUrlOf(entry.id, file);
    this.player.classList.remove('hidden');
    this.player.focus();
    this.player.play().catch(() => {});
  }

  createRow(entry, folder) {
    const row = cloneTemplate(this.template, '.recording-item');
    row.dataset.id = entry.id;
    const { title, chat, date, duration, size, state, location } =
      labelsOf(entry);
    row.querySelector('.recording-title').textContent = title;
    row.querySelector('.recording-chat').textContent = `${chat} · ${date}`;
    const details = row.querySelector('.recording-details');
    details.textContent = `${duration} · ${size} · ${state} · ${location}`;
    if (entry.state === 'interrupted') {
      row.querySelector('.recording-note').hidden = false;
    }
    const poster = row.querySelector('img');
    if (entry.posterUrl) {
      poster.addEventListener('error', () => poster.remove());
      poster.src = entry.posterUrl;
    } else {
      poster.remove();
    }
    const play = row.querySelector('.recording-play');
    const rename = row.querySelector('.recording-rename');
    const remove = row.querySelector('.recording-delete');
    const isFinished = canChange(entry);
    const hasVideo = ['mp4', 'webm'].includes(entry.extension);
    const canWrite = globalThis.FileSystemFileHandle?.prototype.createWritable;
    play.disabled = !isFinished || !hasVideo;
    rename.disabled = !isFinished || !canWrite;
    remove.disabled = !isFinished || !this.recordings.removeEntry;
    play.onclick = () => this.play(entry);
    rename.onclick = () => this.openRename(row, entry);
    remove.onclick = () => this.deleteEntry(entry);
    if (isFinished && hasVideo) this.addExports(row, entry, chat, folder);
    return row;
  }

  addExports(row, entry, chat, folder) {
    const { id, started, extension } = entry;
    const name = exportNameOf(chat, started, extension);
    const download = row.querySelector('.recording-download');
    download.href = downloadUrlOf(id, extension, name);
    download.hidden = false;

    const saveAs = row.querySelector('.recording-save-as');
    const saveFolder = row.querySelector('.recording-save-folder');
    const canWrite = globalThis.FileSystemFileHandle?.prototype.createWritable;
    if (!canWrite || !globalThis.TransformStream) return;
    const sourceFile = () => this.sourceFile(entry);
    if (typeof globalThis.showSaveFilePicker === 'function') {
      saveAs.hidden = false;
      saveAs.onclick = () =>
        this.save(row, async (progress) => {
          const target = await pickExportFile(name, extension);
          if (target) await exportFile(await sourceFile(), target, progress);
        });
    }
    const canRequest = folder?.queryPermission && folder.requestPermission;
    if (canRequest && folder.removeEntry) {
      saveFolder.hidden = false;
      saveFolder.title = `Save to ${folder.name}`;
      saveFolder.onclick = () =>
        this.save(row, (progress) =>
          exportToFolder(folder, name, sourceFile, progress),
        );
    }
  }

  async sourceFile(entry) {
    const directory = await this.recordings.getDirectoryHandle(entry.id);
    const name = programFileOf(entry.extension);
    const handle = await directory.getFileHandle(name);
    return handle.getFile();
  }

  async save(row, copy) {
    const progress = row.querySelector('.recording-export-progress');
    const saveAs = row.querySelector('.recording-save-as');
    const saveFolder = row.querySelector('.recording-save-folder');
    this.setStatus('');
    saveAs.disabled = true;
    saveFolder.disabled = true;
    try {
      await copy((percent) => {
        progress.value = percent;
        progress.hidden = false;
      });
    } catch {
      progress.hidden = true;
      this.setStatus('Could not save this recording.');
    } finally {
      saveAs.disabled = false;
      saveFolder.disabled = false;
    }
  }

  openRename(row, entry) {
    const form = row.querySelector('form');
    const input = form.querySelector('input');
    const heading = row.querySelector('.recording-title');
    const button = row.querySelector('.recording-rename');
    const close = () => {
      form.classList.add('hidden');
      button.focus();
    };
    form.classList.remove('hidden');
    input.value = textOf(entry.title);
    input.focus();
    input.select();
    form.querySelector('.recording-cancel').onclick = close;
    form.onsubmit = async (event) => {
      event.preventDefault();
      const title = input.value.trim();
      if (!title) {
        this.setStatus('Enter a title for the recording.');
        input.focus();
        return;
      }
      const saved = await this.change(entry, 'rename', async (handle, meta) => {
        const writable = await handle.createWritable();
        try {
          await writable.write(JSON.stringify({ ...meta, title }, null, 2));
          await writable.close();
        } catch (error) {
          await writable.abort().catch(() => {});
          throw error;
        }
      });
      if (!saved) return;
      entry.title = title;
      heading.textContent = title;
      if (this.selected === entry.id) {
        this.player.setAttribute('aria-label', title);
      }
      close();
    };
  }

  async change(entry, action, update) {
    if (this.isChanging) return false;
    this.isChanging = true;
    this.setStatus('');
    try {
      const directory = await this.recordings.getDirectoryHandle(entry.id);
      const handle = await directory.getFileHandle(META_FILE);
      const meta = await readMeta(handle);
      if (!canChange(meta)) {
        this.setStatus('The recording is still open.');
        return false;
      }
      await update(handle, meta);
      return true;
    } catch {
      this.setStatus(`Could not ${action} this recording.`);
      return false;
    } finally {
      this.isChanging = false;
    }
  }

  async deleteEntry(entry) {
    if (this.isChanging) return;
    const { title } = labelsOf(entry);
    if (!window.confirm(`Delete “${title}” from browser storage?`)) return;
    const removed = await this.change(entry, 'delete', async () => {
      if (this.selected === entry.id) this.stopPlayback();
      await this.recordings.removeEntry(entry.id, { recursive: true });
    });
    if (removed) await this.refresh();
  }
}

export { Recordings, sortRecordings, labelsOf, storageText };
