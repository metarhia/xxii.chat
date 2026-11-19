import { RECORDINGS, META_FILE, POSTER_FILE } from './recording-files.js';
import { programFileOf, nextMeta } from './recording-files.js';
import { scheduleOf, markedOf } from './recording-files.js';
import { durationSlotOf, durationBytesOf } from './recording-webm.js';

const encoder = new TextEncoder();
const sessions = new Map();
let queue = Promise.resolve();

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

const saveMeta = (session) => {
  const text = JSON.stringify(session.meta, null, 2);
  return writeFile(session.directory, META_FILE, encoder.encode(text));
};

const sessionOf = (recording) => {
  const session = sessions.get(recording);
  if (!session) throw new Error('The recording is not open');
  return session;
};

const headOf = (session, bytes) => {
  const isFirst = session.at === 0 && session.meta.extension === 'webm';
  if (!isFirst) return bytes;
  const slot = durationSlotOf(bytes);
  if (!slot) return bytes;
  session.slot = slot;
  return slot.bytes;
};

const openRecording = async ({ recording, meta }) => {
  const directory = await directoryOf(recording);
  const name = programFileOf(meta.extension);
  const file = await directory.getFileHandle(name, { create: true });
  const handle = await file.createSyncAccessHandle();
  handle.truncate(0);
  const now = Date.now();
  const marks = { flushedAt: now, metaAt: now };
  const session = { directory, handle, meta, at: 0, marks, slot: null };
  sessions.set(recording, session);
  await saveMeta(session);
  return { meta };
};

const writeChunk = async ({ recording, chunk, duration }) => {
  const session = sessionOf(recording);
  const bytes = headOf(session, new Uint8Array(chunk));
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

const closeRecording = async ({ recording, duration, people }) => {
  const session = sessionOf(recording);
  sessions.delete(recording);
  const size = finish(session, duration);
  const time = Date.now();
  const event = { type: 'close', size, duration, time, people };
  session.meta = nextMeta(session.meta, event);
  await saveMeta(session);
  return { meta: session.meta };
};

const abortRecording = async ({ recording, duration }) => {
  const session = sessionOf(recording);
  sessions.delete(recording);
  const size = finish(session, duration);
  const event = { type: 'interrupt', size, duration };
  session.meta = nextMeta(session.meta, event);
  await saveMeta(session);
  return { meta: session.meta };
};

const savePoster = async ({ recording, bytes }) => {
  const directory = await directoryOf(recording);
  await writeFile(directory, POSTER_FILE, new Uint8Array(bytes));
  return {};
};

const HANDLERS = {
  open: openRecording,
  write: writeChunk,
  pause: change('pause'),
  resume: change('resume'),
  close: closeRecording,
  abort: abortRecording,
  poster: savePoster,
};

const dispatch = async (message) => {
  const { request, type } = message;
  try {
    const result = await HANDLERS[type](message);
    self.postMessage({ request, ok: true, ...result });
  } catch (error) {
    const text = error?.message ?? 'The recording failed';
    self.postMessage({ request, ok: false, error: text, name: error?.name });
  }
};

self.addEventListener('message', ({ data }) => {
  queue = queue.then(() => dispatch(data));
});
