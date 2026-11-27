import { EDIT_PREFIX, createMeta, spaceOf } from './recording-files.js';
import { META_FILE, readMeta, recordingsOf } from './recording-files.js';
import { programFileOf } from './recording-files.js';
import { RecordingWriter } from './recorder.js';
import { renderEdit } from './recording-edit-render.js';
import { PartPlayer, readPart } from './recording-edit-media.js';
import { segmentsOf } from './recording-edit-logic.js';

const isPublished = async (id) => {
  try {
    const recordings = await recordingsOf(navigator.storage);
    const directory = await recordings.getDirectoryHandle(id);
    const file = await directory.getFileHandle(META_FILE);
    return (await readMeta(file)).state === 'done';
  } catch {
    return false;
  }
};

const verifyEdit = async (id, config) => {
  const { format, parts, timeline, signal, options } = config;
  const recordings = await recordingsOf(navigator.storage);
  const directory = await recordings.getDirectoryHandle(id);
  const name = programFileOf(format.extension);
  const handle = await directory.getFileHandle(name);
  const video = document.createElement('video');
  const player = new PartPlayer(video, () => handle.getFile());
  try {
    const audioOnly = options?.output === 'audio';
    const output = await readPart(player, { index: 0 }, signal, audioOnly);
    const segments = segmentsOf(parts, timeline.kept);
    if (
      options?.output !== 'mute' &&
      !output.audio &&
      segments.some(({ part }) => part.audio)
    ) {
      throw new Error('The encoder did not preserve the audio in this edit.');
    }
    return output.duration;
  } finally {
    player.clear();
  }
};

const saveEdit = async (options) => {
  const { title, entry, format, timeline, signal } = options;
  signal.throwIfAborted();
  const estimate = await navigator.storage.estimate?.();
  if (spaceOf(estimate) === 'full') {
    throw new Error('There is too little browser storage for an edited copy.');
  }
  signal.throwIfAborted();
  const id = EDIT_PREFIX + crypto.randomUUID();
  const meta = createMeta({
    id,
    title,
    chat: entry.chat,
    chatName: entry.chatName,
    started: Date.now(),
    mime: format.mime,
    extension: format.extension,
    videoDetails: options.videoDetails,
  });
  const writer = new RecordingWriter();
  let saved = false;
  try {
    await writer.open(id, meta);
    const write = (chunk, duration) => writer.write(id, chunk, duration);
    const { poster, mime } = await renderEdit({ ...options, write });
    signal.throwIfAborted();
    if (poster) await writer.poster(id, await poster.arrayBuffer());
    await writer.finishEdit(id, timeline.duration);
    const duration = await verifyEdit(id, options);
    signal.throwIfAborted();
    options.finalizing?.();
    try {
      await writer.close(id, duration, [], mime);
    } catch (error) {
      const published = await isPublished(id);
      if (!published) throw error;
    }
    saved = true;
    return id;
  } finally {
    if (!saved) await writer.discardEdit(id).catch(() => {});
    writer.stop();
  }
};

export { saveEdit };
