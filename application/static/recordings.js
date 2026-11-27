import { META_FILE, POSTER_FILE, TYPES, typeOf } from './recording-files.js';
import { programFileOf, recordingUrlOf, routeOf } from './recording-files.js';
import { dateText, titleOf, timeText, sizeText } from './recording-files.js';
import { isFolderRecording, readMeta } from './recording-files.js';
import { recordingsOf } from './recording-files.js';
import { isPendingEdit, recordingLockOf } from './recording-files.js';
import { exportNameOf, downloadUrlOf, exportFile } from './recording-export.js';
import { pickExportFile, exportToFolder } from './recording-export.js';
import { mediaNameOf } from './recording-export.js';
import { canPickFolder, folderHandle } from './recording-folder.js';
import { folderRecord, folderPermission } from './recording-folder.js';
import { cloneTemplate } from './view.js';
import { createIcon } from './icons.js';
import { Menu, Press } from './overlays.js';
import { RecordingWriter } from './recorder.js';
import { RecordingEditor } from './recording-editor.js';
import { importVideo, videoProperties } from './video-library.js';
import { VideoShares } from './video-share.js';

const CARD_ACTIONS = {
  play: (list, card) => list.playCard(card),
  edit: (list, card) => list.openEditor(card),
  share: (list, card) => list.shareVideo(card),
  properties: (list, card) => list.showProperties(card.entry),
  attach: (list, card) => list.attachToChat(card),
  download: (list, card) => {
    card.row.querySelector('.recording-download').click();
  },
  'save-as': (list, card) => card.exports.saveAs.run(),
  'save-folder': (list, card) => card.exports.saveFolder.run(),
  rename: (list, card) => list.openRename(card),
  delete: (list, card) => list.deleteEntry(card.entry),
  part: (list, card, item) => list.selectPart(card, item.index),
};
const BADGES = {
  recording: 'recording',
  paused: 'paused',
  interrupted: 'interrupted',
};
const UNEXPECTED_END = 'Recording ended unexpectedly';
const LOST_PART = `${UNEXPECTED_END}. The last part was lost.`;
const ICON_ACTIONS = ['play', 'edit', 'download', 'delete'];
const STORAGE_UNAVAILABLE = 'Storage usage is unavailable.';
const REPAIR_CHANNEL = 'xxii-recording-repair';
const DOWNLOAD_URL_MS = 30000;

const startedOf = ({ started }) => (Number.isFinite(started) ? started : 0);

const sortRecordings = (entries) =>
  entries.toSorted((left, right) => startedOf(right) - startedOf(left));

const textOf = (value) => (typeof value === 'string' ? value.trim() : '');

const labelsOf = (meta, now = Date.now()) => {
  const { duration, size, started, folder } = meta;
  const state = textOf(meta.state);
  const hasDate =
    Number.isFinite(started) && Number.isFinite(new Date(started).getTime());
  const chat = textOf(meta.chatName) || textOf(meta.chat) || 'No chat';
  const saved = textOf(meta.title);
  const isDefault = hasDate && saved === titleOf(chat, started);
  const isRenamed = saved !== '' && !isDefault;
  const date = hasDate ? dateText(started, now) : 'Unknown date';
  const sizeLabel = Number.isFinite(size) ? sizeText(size) : 'Unknown size';
  const parts = isRenamed ? [chat, date, sizeLabel] : [date, sizeLabel];
  return {
    title: isRenamed ? saved : chat,
    chat,
    isRenamed,
    name: isRenamed ? saved : `${chat} ${date}`,
    date,
    duration: Number.isFinite(duration)
      ? timeText(duration)
      : 'Unknown duration',
    size: sizeLabel,
    meta: parts.join(' · '),
    badge: Object.hasOwn(BADGES, state) ? BADGES[state] : '',
    folder: textOf(folder),
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
    if (typeof meta?.state !== 'string' || isPendingEdit(id, meta)) return null;
    const poster = await directory.getFileHandle(POSTER_FILE).catch(() => null);
    const posterUrl = poster ? recordingUrlOf(id, POSTER_FILE) : '';
    return { ...meta, id, posterUrl };
  } catch {
    return null;
  }
};

const entriesOf = async (recordings) => {
  if (!recordings) return [];
  const reads = [];
  for await (const directory of recordings.values()) {
    if (directory.kind === 'directory') reads.push(readEntry(directory));
  }
  const entries = await Promise.all(reads);
  return sortRecordings(entries.filter(Boolean));
};

const removableOf = async (storage) => {
  const recordings = await recordingsOf(storage);
  const entries = await entriesOf(recordings);
  return { recordings, entries: entries.filter(canChange) };
};

const countRecordings = async (storage) => {
  if (typeof storage?.getDirectory !== 'function') return 0;
  const { entries } = await removableOf(storage);
  return entries.length;
};

const withRecording = (id, options, run) => {
  if (!navigator.locks?.request) return run(true);
  return navigator.locks.request(
    recordingLockOf(id),
    {
      ifAvailable: true,
      ...options,
    },
    run,
  );
};

const removeRecording = async (recordings, entry) => {
  try {
    return await withRecording(entry.id, {}, async (lock) => {
      if (!lock) return false;
      await recordings.removeEntry(entry.id, { recursive: true });
      if (isFolderRecording(entry)) {
        await folderHandle(null, entry.id).catch(() => {});
      }
      return true;
    });
  } catch {
    return false;
  }
};

const removeRecordings = async (storage) => {
  const { recordings, entries } = await removableOf(storage);
  let removed = 0;
  for (const entry of entries) {
    if (await removeRecording(recordings, entry)) removed++;
  }
  return { removed, failed: entries.length - removed };
};

const noteOf = (isFolder) => (isFolder ? LOST_PART : UNEXPECTED_END);

const paintLabels = ({ row, entry, labels }) => {
  const { title, name, meta, badge, folder } = labels;
  const heading = row.querySelector('.recording-title');
  heading.textContent = title;
  row.querySelector('.recording-meta-text').textContent = meta;
  const mark = row.querySelector('.recording-folder');
  mark.hidden = folder === '';
  if (folder !== '' && mark.childElementCount === 0) {
    mark.append(createIcon('folder'));
  }
  mark.title = folder;
  mark.setAttribute('aria-label', `Saved to ${folder}`);
  const duration = row.querySelector('.recording-duration');
  duration.hidden = !Number.isFinite(entry.duration);
  duration.textContent = labels.duration;
  const state = row.querySelector('.recording-state');
  state.hidden = badge === '';
  state.textContent = badge;
  const isInterrupted = entry.state === 'interrupted';
  const isFolder = isFolderRecording(entry);
  state.title = isInterrupted ? noteOf(isFolder) : '';
  row
    .querySelector('.recording-poster-play')
    .setAttribute('aria-label', `Play ${name}`);
};

const createCardMenu = (overlay) => {
  const element = document.createElement('div');
  element.className = 'menu recording-menu hidden';
  element.setAttribute('aria-label', 'Recording actions');
  document.body.append(element);
  return new Menu(element, overlay);
};

class Recordings {
  constructor(root, onRepair, overlay = {}, onList = null, attach = null) {
    this.root = root;
    this.onList = onList;
    this.attach = attach;
    this.linked = null;
    this.list = root.querySelector('.recordings-list');
    this.storage = root.querySelector('.recordings-storage');
    this.status = root.querySelector('.recordings-status');
    this.repairStatus = root.querySelector('.recordings-repair');
    this.player = root.querySelector('video');
    this.template = document.getElementById('recording-item-template');
    this.recordings = null;
    this.selected = '';
    this.selectedPart = '';
    this.playUrl = '';
    this.playRequest = 0;
    this.revision = 0;
    this.isChanging = false;
    this.cards = new WeakMap();
    this.parts = new Map();
    this.partRevision = 0;
    this.editor = null;
    this.editorLayers = overlay.layers;
    this.shares = new VideoShares(overlay.layers);
    this.menu = createCardMenu(overlay);
    const picker = root.querySelector('#recordings-files');
    const importer = root.querySelector('#recordings-import');
    importer.hidden = !navigator.storage?.getDirectory;
    importer.onclick = () => picker.click();
    picker.onchange = () => {
      const files = Array.from(picker.files);
      picker.value = '';
      if (files.length) this.importFiles(files, importer);
    };
    this.press = new Press({
      hold: (row, x, y) => this.openMenu(row, { point: { x, y } }),
    });
    this.setupMenuEvents();
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
      this.onList?.(entries.filter(canChange).map(({ id }) => id));
      this.showLinked();
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

  link(ids) {
    this.linked = ids;
  }

  showLinked() {
    const ids = this.linked;
    this.linked = null;
    if (!ids) return;
    const rows = [...this.list.querySelectorAll('.recording-item')];
    const marked = rows.filter((row) => ids.includes(row.dataset.id));
    for (const row of marked) row.classList.add('linked');
    if (marked.length === 0) return;
    marked[0].scrollIntoView({ block: 'nearest' });
    if (marked.length > 1) return;
    const card = this.cards.get(marked[0]);
    if (card.canPlay) this.playCard(card);
  }

  close() {
    this.closeEditor();
    this.closeProperties();
    this.shares.closeDialog();
    this.revision++;
    this.linked = null;
    this.menu.close();
    this.parts.clear();
    this.stopPlayback();
    this.list.replaceChildren();
    this.setStatus('');
  }

  dismiss() {
    if (this.editor) {
      this.editor.requestClose();
      return true;
    }
    if (this.menu.dismiss('escape')) return true;
    if (this.selected) {
      this.stopPlayback();
      return true;
    }
    const form = this.list.querySelector('form:not(.hidden)');
    if (!form) return false;
    form.querySelector('.recording-cancel').click();
    return true;
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
    this.player.setAttribute('aria-label', labelsOf(entry).name);
    if (entry.posterUrl) this.player.poster = entry.posterUrl;
    this.player.src = url;
    this.player.classList.remove('hidden');
    this.player.focus();
    this.player.play().catch(() => {});
  }

  setupMenuEvents() {
    const list = this.list;
    list.addEventListener('pointerdown', (event) => {
      const row = event.target.closest('.recording-item');
      if (!row || event.target.closest('form')) return;
      this.press.start(event, row, false);
    });
    list.addEventListener('contextmenu', (event) => {
      const row = event.target.closest('.recording-item');
      if (!row || event.target.closest('form')) return;
      event.preventDefault();
      this.press.cancel();
      const point = { x: event.clientX, y: event.clientY };
      this.openMenu(row, { point });
    });
    document.addEventListener('pointermove', (event) => this.press.move(event));
    document.addEventListener('pointerup', () => this.press.end());
    document.addEventListener('pointercancel', () => this.press.abort());
    document.addEventListener('click', (event) => this.press.suppress(event), {
      capture: true,
    });
  }

  createRow(entry, folder) {
    const row = cloneTemplate(this.template, '.recording-item');
    row.dataset.id = entry.id;
    const labels = labelsOf(entry);
    const card = { row, entry, labels, folder, exports: {} };
    this.cards.set(row, card);
    paintLabels(card);
    const poster = row.querySelector('img');
    if (entry.posterUrl) {
      poster.addEventListener('error', () => poster.remove());
      poster.src = entry.posterUrl;
    } else {
      poster.remove();
    }
    const isFolder = isFolderRecording(entry);
    const isFinished = canChange(entry);
    const hasMedia =
      ['mp4', 'webm', 'mov', 'ogv', 'm4a'].includes(entry.extension) &&
      (!isFolder || entry.segments.length > 0);
    const canWrite = globalThis.FileSystemFileHandle?.prototype.createWritable;
    card.canPlay = isFinished && hasMedia;
    card.canEdit =
      card.canPlay &&
      entry.size !== 0 &&
      !typeOf(entry.mime).startsWith('audio/') &&
      entry.extension !== 'm4a';
    card.canRename = Boolean(isFinished && canWrite);
    card.canDelete = Boolean(isFinished && this.recordings.removeEntry);
    if (card.canPlay) {
      card.exports = isFolder
        ? this.partExports(card)
        : this.fileExports(card, folder);
    }
    this.bindActions(card);
    return row;
  }

  bindActions(card) {
    const { row } = card;
    for (const name of ICON_ACTIONS) {
      row.querySelector(`.recording-${name}`).prepend(createIcon(name));
    }
    row.querySelector('.recording-poster-play').append(createIcon('play'));
    const more = row.querySelector('.recording-more');
    more.prepend(createIcon('more'));
    card.more = more;
    const play = row.querySelector('.recording-play');
    const edit = row.querySelector('.recording-edit');
    const poster = row.querySelector('.recording-poster-play');
    const remove = row.querySelector('.recording-delete');
    const download = row.querySelector('.recording-download');
    const { exports } = card;
    play.disabled = !card.canPlay;
    edit.hidden = !card.canEdit;
    poster.disabled = !card.canPlay;
    remove.disabled = !card.canDelete;
    play.onclick = () => this.playCard(card);
    edit.onclick = () => this.openEditor(card);
    poster.onclick = () => this.playCard(card);
    remove.onclick = () => this.deleteEntry(card.entry);
    more.onclick = () => this.toggleMenu(card);
    download.hidden = !exports.download;
    if (exports.download) {
      download.href = exports.download.href ?? '#';
      download.onclick = exports.download.run ?? null;
    }
  }

  playCard({ entry }) {
    const part = this.partOf(entry);
    return part ? this.play(entry, part) : this.play(entry);
  }

  openEditor({ entry, labels }) {
    if (this.editor) return;
    this.stopPlayback();
    this.editor = new RecordingEditor(entry, {
      name: textOf(entry.title) || labels.name,
      library: () => this.editableSources(),
      source: (part, signal, bytes) => this.editSource(part, signal, bytes),
      withSource: (parts, run) => this.withEditSources(parts, run),
      exportCopy: (id, extension, name, target) =>
        this.exportCopy(id, extension, name, target),
      close: () => this.closeEditor(),
      saved: async (id, status) => {
        this.closeEditor();
        this.link([id]);
        await this.refresh();
        if (status) this.setStatus(status);
      },
    });
    this.editorLayers?.push('recording-editor');
    this.editor.open();
  }

  editableSources() {
    const cards = Array.from(this.list.children, (row) => this.cards.get(row));
    return cards
      .filter((card) => card?.canEdit)
      .map(({ entry, labels }) => ({
        id: entry.id,
        name: textOf(entry.title) || labels.name,
        entry,
      }));
  }

  async importFiles(files, button) {
    if (button.disabled) return;
    button.disabled = true;
    const ids = [];
    const errors = [];
    const signal = new AbortController().signal;
    try {
      for (const file of files) {
        this.setStatus(`Importing ${file.name}…`);
        try {
          ids.push(await importVideo(file, signal));
        } catch (error) {
          errors.push(`${file.name}. ${error.message}`);
        }
      }
      if (this.root.closest('.app').dataset.view === 'recordings') {
        if (ids.length) this.link(ids);
        await this.refresh();
        if (errors.length) this.setStatus(errors.join(' '));
      }
    } finally {
      button.disabled = false;
    }
  }

  withEditSources(parts, run) {
    const entries = new Map(
      parts.filter(({ entry }) => entry).map(({ entry }) => [entry.id, entry]),
    );
    const locks = [...entries.keys()].sort();
    const next = (i) =>
      i === locks.length
        ? run()
        : this.withEditSource(entries.get(locks[i]), () => next(i + 1));
    return next(0);
  }

  async withEditSource(entry, run) {
    if (!navigator.locks?.request) {
      throw new Error('Recording locks are unavailable.');
    }
    return withRecording(entry.id, { mode: 'shared' }, async (lock) => {
      if (!lock) throw new Error('The recording is still open.');
      const directory = await this.recordings.getDirectoryHandle(entry.id);
      const file = await directory.getFileHandle(META_FILE);
      if (!canChange(await readMeta(file))) {
        throw new Error('The recording is still open.');
      }
      return run();
    });
  }

  async editSource(part, signal, bytes = false) {
    signal.throwIfAborted();
    if (part.file) return part.file;
    const { entry } = part;
    if (entry.segments) {
      try {
        const file = await partFileOf(entry, part, () => !signal.aborted);
        signal.throwIfAborted();
        return file;
      } catch (error) {
        signal.throwIfAborted();
        const label = `Part ${(part.localIndex ?? 0) + 1} (${part.name})`;
        throw new Error(`${label}. ${error.message}`, { cause: error });
      }
    }
    if (!bytes && navigator.serviceWorker?.controller) {
      return recordingUrlOf(entry.id, programFileOf(entry.extension));
    }
    return this.sourceFile(entry);
  }

  async exportCopy(id, extension, name, target) {
    if (target) {
      const file = await this.sourceFile({ id, extension });
      await exportFile(file, target, () => {});
      return;
    }
    const link = document.createElement('a');
    link.href = downloadUrlOf(id, extension, name);
    link.download = name;
    link.click();
  }

  attachToChat({ entry, labels }) {
    const part = this.partOf(entry);
    this.attach?.(async () => {
      const signal = new AbortController().signal;
      const file = await this.editSource({ ...part, entry }, signal, true);
      const name = part?.name ?? mediaNameOf(labels.name, entry.extension);
      const type = typeOf(entry.mime) || TYPES[entry.extension];
      return new File([file], name, { type });
    });
  }

  shareVideo({ entry, labels }) {
    const part = this.partOf(entry);
    const key = part ? `${entry.id}/${part.name}` : entry.id;
    const name = part?.name ?? labels.name;
    const mime = typeOf(entry.mime) || TYPES[entry.extension];
    const source = (signal) =>
      this.editSource({ ...part, entry }, signal, true);
    this.shares.open({ key, name, mime, source });
  }

  async showProperties(entry) {
    if (this.propertyDialog) return;
    const dialog = document.createElement('dialog');
    const header = document.createElement('header');
    const heading = document.createElement('h2');
    const body = document.createElement('dl');
    const status = document.createElement('p');
    const close = document.createElement('button');
    const control = new AbortController();
    const { signal } = control;
    const part = this.partOf(entry);
    dialog.className = 'confirm recording-properties';
    dialog.setAttribute('aria-label', 'Media properties');
    heading.textContent = 'Media properties';
    status.textContent = 'Reading media…';
    status.setAttribute('role', 'status');
    close.className = 'icon-btn';
    close.type = 'button';
    close.title = 'Close media properties';
    close.setAttribute('aria-label', close.title);
    close.append(createIcon('close'));
    close.onclick = () => dialog.close();
    header.append(heading, close);
    dialog.append(header, status, body);
    const outside = ({ target, clientX, clientY }) => {
      if (target !== dialog) return false;
      const { left, top, right, bottom } = dialog.getBoundingClientRect();
      return (
        clientX < left || clientX >= right || clientY < top || clientY >= bottom
      );
    };
    let fromBackdrop = false;
    dialog.addEventListener('pointerdown', (event) => {
      fromBackdrop = outside(event);
    });
    dialog.addEventListener('click', (event) => {
      if (fromBackdrop && outside(event)) dialog.close();
      fromBackdrop = false;
    });
    dialog.addEventListener('keydown', (event) => event.stopPropagation());
    dialog.addEventListener(
      'close',
      () => {
        control.abort();
        dialog.remove();
        this.propertyDialog = null;
        this.editorLayers?.pop('recording-properties');
      },
      { once: true },
    );
    this.propertyDialog = dialog;
    document.body.append(dialog);
    this.editorLayers?.push('recording-properties');
    dialog.showModal();
    const source = () => this.editSource({ ...part, entry }, signal);
    try {
      const media = await this.withEditSource(entry, () =>
        videoProperties(source, signal),
      );
      const size = part?.size ?? entry.size;
      const bitrate = Math.round((size * 8) / media.duration);
      const rows = [
        ['File', part?.name ?? labelsOf(entry).name],
        ['Format', typeOf(entry.mime) || TYPES[entry.extension]],
        ['Duration', timeText(media.duration)],
        [
          'Dimensions',
          media.width ? `${media.width} × ${media.height}` : 'Audio only',
        ],
        ['Size', Number.isFinite(size) ? sizeText(size) : 'Unknown'],
        ['Average bitrate', bitrate ? `${bitrate} kbps` : 'Unknown'],
        ['Sound', media.audio ? 'Audio track' : 'Silent'],
      ];
      status.hidden = true;
      body.replaceChildren(
        ...rows.map(([key, value]) => {
          const tile = document.createElement('div');
          const term = document.createElement('dt');
          const detail = document.createElement('dd');
          term.textContent = key;
          detail.textContent = value;
          tile.append(term, detail);
          return tile;
        }),
      );
    } catch (error) {
      if (!signal.aborted) status.textContent = error.message;
    }
  }

  closeProperties() {
    this.propertyDialog?.close();
  }

  requestEditorClose() {
    if (!this.editor) return true;
    this.editor.requestClose();
    return false;
  }

  closeEditor() {
    if (!this.editor) return;
    this.editor.close();
    this.editor = null;
    this.editorLayers?.pop('recording-editor');
  }

  partOf(entry) {
    if (!isFolderRecording(entry)) return null;
    const index = this.parts.get(entry.id) ?? 0;
    return entry.segments[index] ?? entry.segments[0] ?? null;
  }

  toggleMenu(card) {
    const isOwn = this.menu.isOpen && this.menu.target === card.entry.id;
    if (isOwn) return void this.menu.close();
    this.openMenu(card.row, { anchor: card.more });
  }

  openMenu(row, place) {
    const card = this.cards.get(row);
    if (!card) return;
    const { entry } = card;
    const anchor = place.anchor ?? null;
    this.menu.open({
      id: entry.id,
      items: this.menuItems(card),
      anchor,
      point: anchor ? null : place.point,
      trigger: anchor ?? card.more,
      label: 'Recording actions',
      select: (item) => queueMicrotask(() => this.choose(card, item)),
    });
  }

  menuItems(card) {
    const { exports, entry } = card;
    const isSaving = card.row.dataset.saving !== undefined;
    const items = [{ action: 'play', label: 'Play', disabled: !card.canPlay }];
    if (card.canEdit) {
      items.push({ action: 'edit', label: 'Edit' });
      items.push({ action: 'share', label: 'Share video' });
    }
    if (card.canPlay) {
      items.push({ action: 'properties', label: 'Properties' });
      if (this.attach) {
        items.push({ action: 'attach', label: 'Attach to chat' });
      }
    }
    if (exports.download) items.push({ action: 'download', label: 'Download' });
    if (exports.saveAs) {
      items.push({ action: 'save-as', label: 'Save as…', disabled: isSaving });
    }
    if (exports.saveFolder) {
      const label = `Save to ${exports.saveFolder.name}`;
      items.push({ action: 'save-folder', label, disabled: isSaving });
    }
    const rename = { action: 'rename', label: 'Rename' };
    const remove = { action: 'delete', label: 'Delete' };
    items.push({ ...rename, disabled: !card.canRename });
    items.push({ ...remove, disabled: !card.canDelete });
    if (card.canPlay && entry.segments?.length > 1) {
      items.push({ kind: 'separator' }, this.partsGroup(entry));
    }
    return items;
  }

  partsGroup(entry) {
    const current = this.partOf(entry);
    const items = entry.segments.map((part, index) => ({
      kind: 'radio',
      group: 'part',
      action: 'part',
      index,
      label: `Part ${index + 1}`,
      checked: part === current,
    }));
    return { kind: 'group', label: 'Part', items };
  }

  choose(card, item) {
    CARD_ACTIONS[item.action]?.(this, card, item);
  }

  selectPart({ row, entry }, index) {
    this.parts.set(entry.id, index);
    this.partRevision++;
    row.querySelector('progress').hidden = true;
    if (this.selected === entry.id) this.play(entry, this.partOf(entry));
  }

  partExports(card) {
    const { entry } = card;
    const exports = {};
    const partAction = (action) => {
      const { revision, partRevision } = this;
      const part = this.partOf(entry);
      const isCurrent = () =>
        revision === this.revision && partRevision === this.partRevision;
      return part ? action(part, isCurrent) : null;
    };
    exports.download = {
      run: (event) => {
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
      },
    };
    const canWrite = globalThis.FileSystemFileHandle?.prototype.createWritable;
    const canStream = Boolean(globalThis.TransformStream);
    const canSave = typeof globalThis.showSaveFilePicker === 'function';
    if (!canWrite || !canStream || !canSave) return exports;
    exports.saveAs = {
      run: () =>
        partAction((part, isCurrent) =>
          this.save(
            card,
            async (progress) => {
              const file = await partFileOf(entry, part, isCurrent);
              if (!file || !isCurrent()) return;
              if (navigator.userActivation?.isActive === false) {
                throw new Error('Folder access granted. Click Save as again.');
              }
              const target = await pickExportFile(part.name, entry.extension);
              if (target && isCurrent()) {
                await exportFile(file, target, progress);
              }
            },
            isCurrent,
          ),
        ),
    };
    return exports;
  }

  fileExports(card, folder) {
    const { entry, labels } = card;
    const { id, started, extension } = entry;
    const name = labels.isRenamed
      ? mediaNameOf(labels.name, extension)
      : exportNameOf(labels.chat, started, extension);
    const exports = {
      download: { href: downloadUrlOf(id, extension, name) },
    };
    const canWrite = globalThis.FileSystemFileHandle?.prototype.createWritable;
    if (!canWrite || !globalThis.TransformStream) return exports;
    const sourceFile = () => this.sourceFile(entry);
    if (typeof globalThis.showSaveFilePicker === 'function') {
      exports.saveAs = {
        run: () =>
          this.save(card, async (progress) => {
            const target = await pickExportFile(name, extension, entry.mime);
            if (target) await exportFile(await sourceFile(), target, progress);
          }),
      };
    }
    const handle = folder?.handle;
    const canRequest = handle?.queryPermission && handle.requestPermission;
    if (canRequest && handle.removeEntry) {
      exports.saveFolder = {
        name: folder.name,
        run: () =>
          this.save(card, (progress) =>
            exportToFolder(handle, name, sourceFile, progress),
          ),
      };
    }
    return exports;
  }

  async sourceFile(entry) {
    const directory = await this.recordings.getDirectoryHandle(entry.id);
    const name = programFileOf(entry.extension);
    const handle = await directory.getFileHandle(name);
    return handle.getFile();
  }

  async save({ row }, copy, isCurrent) {
    if (row.dataset.saving !== undefined) return;
    const progress = row.querySelector('.recording-export-progress');
    this.setStatus('');
    row.dataset.saving = '';
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
      delete row.dataset.saving;
    }
  }

  openRename(card) {
    const { row, entry } = card;
    const form = row.querySelector('form');
    const input = form.querySelector('input');
    const heading = row.querySelector('.recording-title');
    const close = () => {
      form.classList.add('hidden');
      heading.hidden = false;
      card.more.focus();
    };
    heading.hidden = true;
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
      card.labels = labelsOf(entry);
      paintLabels(card);
      if (!isFolderRecording(entry)) {
        card.exports = this.fileExports(card, card.folder);
        const download = row.querySelector('.recording-download');
        download.href = card.exports.download.href;
      }
      if (this.selected === entry.id) {
        this.player.setAttribute('aria-label', card.labels.name);
      }
      close();
    };
  }

  async change(entry, action, update) {
    if (this.isChanging) return false;
    this.isChanging = true;
    this.setStatus('');
    try {
      return await withRecording(entry.id, {}, async (lock) => {
        if (!lock) {
          this.setStatus('The recording is in use.');
          return false;
        }
        const directory = await this.recordings.getDirectoryHandle(entry.id);
        const handle = await directory.getFileHandle(META_FILE);
        const meta = await readMeta(handle);
        if (!canChange(meta)) {
          this.setStatus('The recording is still open.');
          return false;
        }
        await update(handle, meta);
        return true;
      });
    } catch {
      this.setStatus(`Could not ${action} this recording.`);
      return false;
    } finally {
      this.isChanging = false;
    }
  }

  async removeAll(storage) {
    if (this.isChanging) return { removed: 0, failed: 0 };
    this.isChanging = true;
    try {
      this.stopPlayback();
      return await removeRecordings(storage);
    } finally {
      this.isChanging = false;
    }
  }

  async deleteEntry(entry) {
    if (this.isChanging) return;
    const { name } = labelsOf(entry);
    const isFolder = isFolderRecording(entry);
    const message = isFolder
      ? `Delete “${name}” from the library? Files stay in ${entry.folder}.`
      : `Delete “${name}” from browser storage?`;
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
export { countRecordings, removeRecordings };
