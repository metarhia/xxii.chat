import { RECORDINGS, META_FILE, POSTER_FILE } from './recording-files.js';
import { programFileOf, nextMeta } from './recording-files.js';
import { scheduleOf, markedOf } from './recording-files.js';
import { isOpen, readMeta, recordingsOf } from './recording-files.js';
import { isFolderRecording } from './recording-files.js';
import { durationSlotOf, durationBytesOf } from './recording-webm.js';
import { storedDurationOf } from './recording-duration.js';
import { folderHandle } from './recording-folder.js';
import {
  createAvailableFile,
  removeEmptyExport,
  segmentNameOf,
} from './recording-export.js';

const encoder = new TextEncoder();
const sessions = new Map();
let queue = Promise.resolve();

const IF_AVAILABLE = { ifAvailable: true };
const SESSION_WRITES = ['write', 'pause', 'resume'];

const lockNameOf = (recording) => `xxii-recording-${recording}`;

const requireStorage = () => {
  if (
    !navigator.storage?.getDirectory ||
    !globalThis.FileSystemFileHandle?.prototype.createSyncAccessHandle
  ) {
    throw new Error('Browser storage for recordings is unavailable');
  }
  if (!navigator.locks?.request) {
    throw new Error('Browser locks for recordings are unavailable');
  }
};

const holdLock = (recording) =>
  new Promise((resolve, reject) => {
    const done = navigator.locks.request(
      lockNameOf(recording),
      IF_AVAILABLE,
      (lock) => {
        if (!lock) throw new Error('The recording is already open');
        return new Promise((release) => {
          resolve(async () => {
            release();
            await done;
          });
        });
      },
    );
    done.catch(reject);
  });

const directoryOf = async (recording) => {
  const root = await navigator.storage.getDirectory();
  const options = { create: true };
  const recordings = await root.getDirectoryHandle(RECORDINGS, options);
  return recordings.getDirectoryHandle(recording, options);
};

const writeAll = (handle, bytes, start) => {
  let written = 0;
  while (written < bytes.length) {
    const rest = bytes.subarray(written);
    const count = handle.write(rest, { at: start + written });
    if (count === 0) throw new Error('The recording could not be written');
    written += count;
  }
};

const writeFile = async (directory, name, bytes) => {
  const file = await directory.getFileHandle(name, { create: true });
  const handle = await file.createSyncAccessHandle();
  try {
    handle.truncate(0);
    writeAll(handle, bytes, 0);
    handle.flush();
  } finally {
    handle.close();
  }
};

const saveMeta = async (session) => {
  const { directory, meta } = session;
  const text = JSON.stringify(meta, null, 2);
  if (!isFolderRecording(meta)) {
    await writeFile(directory, META_FILE, encoder.encode(text));
    return;
  }
  const file = await directory.getFileHandle(META_FILE, { create: true });
  const writable = await file.createWritable();
  try {
    await writable.write(text);
    await writable.close();
  } catch (error) {
    await writable.abort().catch(() => {});
    throw error;
  }
};

const sessionOf = (recording) => {
  const session = sessions.get(recording);
  if (!session) throw new Error('The recording is not open');
  return session;
};

const headOf = (target, extension, bytes) => {
  const isFirst = target.at === 0 && extension === 'webm';
  if (!isFirst) return bytes;
  const slot = durationSlotOf(bytes);
  if (!slot) return bytes;
  target.slot = slot;
  return slot.bytes;
};

const openRecording = async ({ recording, meta, folder }) => {
  requireStorage();
  const release = await holdLock(recording);
  let handle = null;
  try {
    const directory = await directoryOf(recording);
    if (folder) {
      await folderHandle(folder, recording);
    } else {
      const name = programFileOf(meta.extension);
      const file = await directory.getFileHandle(name, { create: true });
      handle = await file.createSyncAccessHandle();
      handle.truncate(0);
    }
    const now = Date.now();
    const marks = { flushedAt: now, metaAt: now };
    const session = {
      directory,
      handle,
      meta,
      at: 0,
      marks,
      slot: null,
      release,
      folder,
      part: null,
    };
    await saveMeta(session);
    sessions.set(recording, session);
    return { meta };
  } catch (error) {
    try {
      handle?.close();
    } finally {
      await release();
    }
    throw error;
  }
};

const openFolderPart = async (session) => {
  const { folder, meta } = session;
  const name = segmentNameOf(meta, meta.segments.length + 1);
  const target = await createAvailableFile(folder, name);
  try {
    const writer = await target.createWritable();
    return { target, writer, at: 0, slot: null };
  } catch (error) {
    await removeEmptyExport(folder, target).catch(() => {});
    throw error;
  }
};

const writeFolderChunk = async (session, chunk) => {
  session.part ??= await openFolderPart(session);
  const { part, meta } = session;
  const bytes = headOf(part, meta.extension, chunk);
  await part.writer.write(bytes);
  part.at += bytes.length;
  return { size: meta.size + part.at };
};

const finishFolderPart = async (session, duration) => {
  const part = session.part;
  if (!part) return;
  const { target, writer, at, slot } = part;
  if (slot) {
    const data = durationBytesOf(duration, slot.scale);
    await writer.write({ type: 'write', position: slot.offset, data });
  }
  await writer.close();
  session.part = null;
  const segment = { name: target.name, size: at, duration };
  session.meta = nextMeta(session.meta, { type: 'segment', segment });
};

const discardFolderPart = async (session) => {
  const part = session.part;
  if (!part) return;
  session.part = null;
  await part.writer.abort().catch(() => {});
  await removeEmptyExport(session.folder, part.target).catch(() => {});
};

const closeSegment = async ({ recording, duration }) => {
  const session = sessionOf(recording);
  await finishFolderPart(session, duration);
  await saveMeta(session);
  return { meta: session.meta };
};

const writeChunk = async ({ recording, chunk, duration }) => {
  const session = sessionOf(recording);
  const source = new Uint8Array(chunk);
  if (session.folder) return writeFolderChunk(session, source);
  const bytes = headOf(session, session.meta.extension, source);
  writeAll(session.handle, bytes, session.at);
  session.at += bytes.length;
  const now = Date.now();
  const due = scheduleOf(session.marks, now);
  session.marks = markedOf(session.marks, due, now);
  if (due.flush) session.handle.flush();
  const progress = { type: 'progress', size: session.at, duration };
  session.meta = nextMeta(session.meta, progress);
  if (due.meta) await saveMeta(session);
  return { size: session.at };
};

const change =
  (type) =>
  async ({ recording }) => {
    const session = sessionOf(recording);
    session.meta = nextMeta(session.meta, { type });
    await saveMeta(session);
    return { meta: session.meta };
  };

const finish = (session, duration) => {
  const { handle, slot } = session;
  try {
    if (slot) {
      const bytes = durationBytesOf(duration, slot.scale);
      writeAll(handle, bytes, slot.offset);
    }
    handle.flush();
    return handle.getSize();
  } finally {
    handle.close();
  }
};

const endRecording =
  (type) =>
  async ({ recording, duration, people }) => {
    const session = sessionOf(recording);
    sessions.delete(recording);
    try {
      duration ??= session.meta.duration;
      let size = session.meta.size;
      if (session.folder) {
        if (type === 'close') {
          await finishFolderPart(session, duration - session.meta.duration);
        } else {
          await discardFolderPart(session);
        }
      } else {
        size = finish(session, duration);
      }
      const time = Date.now();
      const event = { type, size, duration, time, people };
      session.meta = nextMeta(session.meta, event);
      await saveMeta(session);
      return { meta: session.meta };
    } catch (error) {
      if (session.folder) {
        await discardFolderPart(session);
        session.meta = nextMeta(session.meta, { type: 'interrupt' });
        await saveMeta(session).catch(() => {});
      }
      throw error;
    } finally {
      await session.release();
    }
  };

const abortRecording = endRecording('interrupt');

const savePoster = async ({ recording, bytes }) => {
  const { directory } = sessionOf(recording);
  await writeFile(directory, POSTER_FILE, new Uint8Array(bytes));
  return {};
};

const readRecording = async (directory) => {
  try {
    const file = await directory.getFileHandle(META_FILE);
    return await readMeta(file);
  } catch (error) {
    if (error.name === 'NotFoundError') return null;
    throw error;
  }
};

const interruptedEvent = async (directory, meta) => {
  const type = 'interrupt';
  if (isFolderRecording(meta)) return { type };
  const name = programFileOf(meta.extension);
  let file;
  try {
    file = await directory.getFileHandle(name);
  } catch (error) {
    if (error.name === 'NotFoundError') {
      return { type, size: 0, duration: meta.duration };
    }
    throw error;
  }
  const handle = await file.createSyncAccessHandle();
  try {
    const size = handle.getSize();
    const result = storedDurationOf(
      handle,
      size,
      meta.extension,
      meta.duration,
    );
    const { duration, slot } = result;
    if (slot) {
      const bytes = durationBytesOf(duration, slot.scale);
      writeAll(handle, bytes, slot.offset);
      handle.flush();
    }
    return { type, size, duration };
  } finally {
    handle.close();
  }
};

const repairRecording = async (directory, lock) => {
  if (!lock) return false;
  const current = await readRecording(directory);
  if (!isOpen(current)) return false;
  const event = await interruptedEvent(directory, current);
  const meta = nextMeta(current, event);
  await saveMeta({ directory, meta });
  return true;
};

const repair = async () => {
  requireStorage();
  const recordings = await recordingsOf(navigator.storage);
  let repaired = 0;
  let failed = 0;
  if (!recordings) return { repaired, failed };
  for await (const directory of recordings.values()) {
    if (directory.kind !== 'directory') continue;
    const meta = await readRecording(directory).catch(() => null);
    if (meta && !isOpen(meta)) continue;
    const name = lockNameOf(directory.name);
    try {
      const fix = (lock) => repairRecording(directory, lock);
      if (await navigator.locks.request(name, IF_AVAILABLE, fix)) repaired++;
    } catch {
      failed++;
    }
  }
  return { repaired, failed };
};

const HANDLERS = {
  open: openRecording,
  write: writeChunk,
  segment: closeSegment,
  pause: change('pause'),
  resume: change('resume'),
  close: endRecording('close'),
  abort: abortRecording,
  poster: savePoster,
  repair,
};

const dispatch = async (message) => {
  const { request, type } = message;
  try {
    const result = await HANDLERS[type](message);
    self.postMessage({ request, ok: true, ...result });
  } catch (error) {
    const session = sessions.get(message.recording);
    if (SESSION_WRITES.includes(type) && session && !session.folder) {
      await abortRecording(message).catch(() => {});
    }
    const text = error?.message ?? 'The recording failed';
    self.postMessage({ request, ok: false, error: text, name: error?.name });
  }
};

self.addEventListener('message', ({ data }) => {
  queue = queue.then(() => dispatch(data));
});
