import { META_FILE, POSTER_FILE } from './recording-files.js';
import { programFileOf, recordingUrlOf, routeOf } from './recording-files.js';
import { stampOf, timeText, sizeText } from './recording-files.js';
import {
  isFolderRecording,
  readMeta,
  recordingsOf,
} from './recording-files.js';
import { exportNameOf, downloadUrlOf, exportFile } from './recording-export.js';
import {
  pickExportFile,
  exportToFolder,
  partLabel,
} from './recording-export.js';
import {
  canPickFolder,
  folderHandle,
  folderRecord,
  folderPermission,
} from './recording-folder.js';
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
const DOWNLOAD_URL_MS = 30000;

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

const missingPart = (entry) => `Part not found in ${entry.folder}.`;

const partFileOf = async (entry, part, isCurrent) => {
  const folder = await folderHandle(undefined, entry.id);
  if (!isCurrent()) return null;
  if (!folder) throw new Error(missingPart(entry));
  const permission = await folderPermission(folder, 'read', isCurrent);
  if (!isCurrent()) return null;
  if (permission !== 'granted') {
    throw new Error(`Allow access to ${entry.folder} to open this part.`);
  }
  try {
    const handle = await folder.getFileHandle(part.name);
    return await handle.getFile();
  } catch (error) {
    if (error.name === 'NotFoundError' || error.name === 'TypeMismatchError') {
      throw new Error(missingPart(entry));
    }
    throw error;
  }
};

const downloadPart = (file, name) => {
  const url = URL.createObjectURL(file);
  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), DOWNLOAD_URL_MS);
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
    this.selectedPart = '';
    this.playUrl = '';
    this.playRequest = 0;
    this.revision = 0;
    this.isChanging = false;
    const canBroadcast = typeof BroadcastChannel === 'function';
    this.repairChannel = canBroadcast
      ? new BroadcastChannel(REPAIR_CHANNEL)
      : null;
    this.repairChannel?.addEventListener('message', onRepair);
    this.player.addEventListener('error', () => {
      if (this.selected && this.player.error) {
        this.setStatus('Could not play this recording.');
      }
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
      const folder = canPickFolder()
        ? await folderRecord().catch(() => null)
        : null;
      if (revision !== this.revision) return;
      if (this.selected && !entries.some((item) => item.id === this.selected)) {
        this.stopPlayback();
      }
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
    this.list.replaceChildren();
    this.setStatus('');
  }

  stopPlayback() {
    this.playRequest++;
    if (!this.selected) return;
    this.selected = '';
    this.selectedPart = '';
    this.player.classList.add('hidden');
    this.player.removeAttribute('src');
    this.player.removeAttribute('poster');
    this.player.load();
    if (this.playUrl) URL.revokeObjectURL(this.playUrl);
    this.playUrl = '';
  }

  async play(entry, part) {
    if (!part && !navigator.serviceWorker?.controller) {
      this.setStatus('Recording playback is unavailable. Reload to try again.');
      return;
    }
    this.setStatus('');
    this.stopPlayback();
    const request = this.playRequest;
    this.selected = entry.id;
    this.selectedPart = part?.name ?? '';
    const isCurrent = () => request === this.playRequest;
    let url = recordingUrlOf(entry.id, programFileOf(entry.extension));
    if (part) {
      try {
        const file = await partFileOf(entry, part, isCurrent);
        if (!file || !isCurrent()) return;
        url = URL.createObjectURL(file);
        this.playUrl = url;
      } catch (error) {
        if (isCurrent()) {
          this.stopPlayback();
          this.setStatus(error.message);
        }
        return;
      }
    }
    const { title } = labelsOf(entry);
    this.player.setAttribute('aria-label', title);
    if (entry.posterUrl) this.player.poster = entry.posterUrl;
    this.player.src = url;
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
    const isFolder = isFolderRecording(entry);
    if (entry.state === 'interrupted') {
      const note = row.querySelector('.recording-note');
      if (isFolder) {
        note.textContent =
          'Recording ended unexpectedly. The last part was lost.';
      }
      note.hidden = false;
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
    const hasVideo =
      ['mp4', 'webm'].includes(entry.extension) &&
      (!isFolder || entry.segments.length > 0);
    const canWrite = globalThis.FileSystemFileHandle?.prototype.createWritable;
    play.disabled = !isFinished || !hasVideo;
    rename.disabled = !isFinished || !canWrite;
    remove.disabled = !isFinished || !this.recordings.removeEntry;
    if (isFolder) {
      if (isFinished && hasVideo) this.addPartActions(row, entry, play);
    } else {
      play.onclick = () => this.play(entry);
      if (isFinished && hasVideo) this.addExports(row, entry, chat, folder);
    }
    rename.onclick = () => this.openRename(row, entry);
    remove.onclick = () => this.deleteEntry(entry);
    return row;
  }

  addPartActions(row, entry, play) {
    const select = row.querySelector('.recording-part');
    select.hidden = false;
    for (const [index, part] of entry.segments.entries()) {
      const option = document.createElement('option');
      option.value = part.name;
      option.textContent = partLabel(index + 1);
      select.append(option);
    }
    if (this.selected === entry.id && this.selectedPart) {
      select.value = this.selectedPart;
    }
    const partOf = () => entry.segments[select.selectedIndex];
    play.onclick = () => this.play(entry, partOf());
    let selection = 0;
    select.onchange = () => {
      selection++;
      row.querySelector('progress').hidden = true;
      if (this.selected === entry.id) this.play(entry, partOf());
    };
    const partAction = (action) => {
      const { revision } = this;
      const choice = selection;
      const part = partOf();
      const isCurrent = () =>
        revision === this.revision && choice === selection;
      return part ? action(part, isCurrent) : null;
    };
    const download = row.querySelector('.recording-download');
    download.href = '#';
    download.hidden = false;
    download.onclick = (event) => {
      event.preventDefault();
      return partAction(async (part, isCurrent) => {
        this.setStatus('');
        try {
          const file = await partFileOf(entry, part, isCurrent);
          if (file && isCurrent()) downloadPart(file, part.name);
        } catch (error) {
          if (isCurrent()) this.setStatus(error.message);
        }
      });
    };
    const canWrite = globalThis.FileSystemFileHandle?.prototype.createWritable;
    if (
      !canWrite ||
      !globalThis.TransformStream ||
      typeof globalThis.showSaveFilePicker !== 'function'
    ) {
      return;
    }
    const saveAs = row.querySelector('.recording-save-as');
    saveAs.hidden = false;
    saveAs.onclick = () =>
      partAction((part, isCurrent) =>
        this.save(
          row,
          async (progress) => {
            const file = await partFileOf(entry, part, isCurrent);
            if (!file || !isCurrent()) return;
            if (navigator.userActivation?.isActive === false) {
              throw new Error('Folder access granted. Click Save as again.');
            }
            const target = await pickExportFile(part.name, entry.extension);
            if (target && isCurrent()) await exportFile(file, target, progress);
          },
          isCurrent,
        ),
      );
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
    const handle = folder?.handle;
    const canRequest = handle?.queryPermission && handle.requestPermission;
    if (canRequest && handle.removeEntry) {
      saveFolder.hidden = false;
      saveFolder.title = `Save to ${folder.name}`;
      saveFolder.onclick = () =>
        this.save(row, (progress) =>
          exportToFolder(handle, name, sourceFile, progress),
        );
    }
  }

  async sourceFile(entry) {
    const directory = await this.recordings.getDirectoryHandle(entry.id);
    const name = programFileOf(entry.extension);
    const handle = await directory.getFileHandle(name);
    return handle.getFile();
  }

  async save(row, copy, isCurrent) {
    const progress = row.querySelector('.recording-export-progress');
    const saveAs = row.querySelector('.recording-save-as');
    const saveFolder = row.querySelector('.recording-save-folder');
    this.setStatus('');
    saveAs.disabled = true;
    saveFolder.disabled = true;
    try {
      await copy((percent) => {
        if (isCurrent && !isCurrent()) return;
        progress.value = percent;
        progress.hidden = false;
      });
    } catch (error) {
      if (isCurrent && !isCurrent()) return;
      progress.hidden = true;
      this.setStatus(
        isCurrent ? error.message : 'Could not save this recording.',
      );
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
    const isFolder = isFolderRecording(entry);
    const message = isFolder
      ? `Delete “${title}” from the library? Files stay in ${entry.folder}.`
      : `Delete “${title}” from browser storage?`;
    if (!window.confirm(message)) return;
    const revision = this.revision;
    const removed = await this.change(entry, 'delete', async () => {
      if (this.selected === entry.id) this.stopPlayback();
      await this.recordings.removeEntry(entry.id, { recursive: true });
      if (isFolder) await folderHandle(null, entry.id).catch(() => {});
    });
    if (removed && revision === this.revision) await this.refresh();
  }
}

export { Recordings, sortRecordings, labelsOf, storageText };
