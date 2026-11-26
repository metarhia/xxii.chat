import {
  EDIT_PREFIX,
  META_FILE,
  POSTER_FILE,
  RECORDINGS,
  TYPES,
} from './recording-files.js';
import {
  extensionOf,
  programFileOf,
  recordingLockOf,
  typeOf,
} from './recording-files.js';
import { PartPlayer, readPart } from './recording-edit-media.js';
import { posterOf } from './recording-edit-render.js';

const VIDEO_TYPES = new Map([
  ['video/mp4', 'mp4'],
  ['video/webm', 'webm'],
  ['video/quicktime', 'mov'],
  ['video/ogg', 'ogv'],
  ['video/x-m4v', 'mp4'],
]);
const VIDEO_EXTENSIONS = ['mp4', 'webm', 'mov', 'ogv', 'm4v'];

const videoExtension = ({ name, type, mime }) => {
  const content = typeOf(type ?? mime);
  if (content && content !== 'application/octet-stream') {
    return VIDEO_TYPES.get(content) ?? '';
  }
  const extension = extensionOf(name ?? '');
  if (extension === 'm4v') return 'mp4';
  return VIDEO_EXTENSIONS.includes(extension) ? extension : '';
};

const isVideoFile = (file) =>
  Boolean(
    videoExtension(file) || typeOf(file.type ?? file.mime).startsWith('video/'),
  );

const writeBlob = async (directory, name, data, signal) => {
  const handle = await directory.getFileHandle(name, { create: true });
  const writable = await handle.createWritable();
  await data.stream().pipeTo(writable, { signal });
};

const videoProperties = async (source, signal, makePoster = false) => {
  const video = document.createElement('video');
  video.preload = 'auto';
  const player = new PartPlayer(video, source);
  try {
    const part = await readPart(player, { index: 0 }, signal, !makePoster);
    if (!makePoster) return part;
    const canvas = document.createElement('canvas');
    const scale = Math.min(1, 480 / Math.max(part.width, part.height));
    canvas.width = Math.max(1, Math.round(part.width * scale));
    canvas.height = Math.max(1, Math.round(part.height * scale));
    const context = canvas.getContext('2d');
    context.drawImage(video, 0, 0, canvas.width, canvas.height);
    return { ...part, poster: await posterOf(canvas) };
  } finally {
    player.clear();
  }
};

const importVideo = async (file, signal, chat = {}) => {
  const extension = videoExtension(file);
  if (!extension) throw new Error('Choose an MP4, WebM, MOV, or Ogg video.');
  if (!navigator.locks?.request || !navigator.storage?.getDirectory) {
    throw new Error('Browser storage for videos is unavailable.');
  }
  const mime = TYPES[extension];
  const source = new File([file], file.name, { type: mime });
  const { duration, width, height, audio, poster } = await videoProperties(
    () => source,
    signal,
    true,
  );
  signal.throwIfAborted();
  const id = EDIT_PREFIX + crypto.randomUUID();
  const root = await navigator.storage.getDirectory();
  const recordings = await root.getDirectoryHandle(RECORDINGS, {
    create: true,
  });
  return navigator.locks.request(recordingLockOf(id), async () => {
    const directory = await recordings.getDirectoryHandle(id, { create: true });
    const title = file.name.replace(/\.[^.]+$/, '').trim() || 'Imported video';
    const now = Date.now();
    const meta = {
      id,
      title,
      ...chat,
      started: now,
      stopped: now,
      duration,
      size: file.size,
      mime,
      extension,
      width,
      height,
      audio,
      state: 'done',
    };
    try {
      await writeBlob(directory, programFileOf(extension), file, signal);
      await writeBlob(directory, POSTER_FILE, poster, signal);
      const json = new Blob([JSON.stringify(meta)], {
        type: 'application/json',
      });
      await writeBlob(directory, META_FILE, json, signal);
      return id;
    } catch (error) {
      await recordings.removeEntry(id, { recursive: true }).catch(() => {});
      throw error;
    }
  });
};

export { isVideoFile, videoExtension, videoProperties, importVideo };
