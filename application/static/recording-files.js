const RECORDINGS = 'recordings';
const META_FILE = 'meta.json';
const POSTER_FILE = 'poster.jpg';
const PROGRAM = 'program';
const STATES = ['recording', 'paused', 'done', 'interrupted'];
const OPEN_STATES = ['recording', 'paused'];

const FLUSH_MS = 5000;
const META_MS = 10000;
const POSTER_MS = 3000;
const MEGABYTE = 1024 * 1024;
const GIGABYTE = 1024 * MEGABYTE;
const LOW_BYTES = 2 * GIGABYTE;
const STOP_BYTES = 500 * MEGABYTE;
const KIBIBYTE = 1024;
const SIZE_UNITS = ['B', 'KB', 'MB', 'GB', 'TB'];
const SECOND_MS = 1000;
const MINUTE_SECONDS = 60;
const HOUR_SECONDS = 3600;
const DAY_MS = 24 * 60 * 60 * 1000;
const MONTHS = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
];

const RANGE = /^bytes=(\d*)-(\d*)$/;
const ROUTE = /^\/recordings\/([\w-]+)\/([\w.-]+)$/;
const UNSAFE_NAME = /[\\/:*?"<>|]/;
const RFC5987 = /['()*]/g;
const NON_ASCII = /[^\x20-\x7e]/g;
const QUOTE = /"/g;

const TYPES = {
  mp4: 'video/mp4',
  webm: 'video/webm',
  jpg: 'image/jpeg',
  json: 'application/json',
};

const pad = (value) => `${value}`.padStart(2, '0');

const dayOf = (date) => {
  const month = pad(date.getMonth() + 1);
  return `${date.getFullYear()}-${month}-${pad(date.getDate())}`;
};

const stampOf = (started, separator = '-') => {
  const date = new Date(started);
  const time = `${pad(date.getHours())}${separator}${pad(date.getMinutes())}`;
  return `${dayOf(date)} ${time}`;
};

const safeChar = (char) => {
  const isControl = char.charCodeAt(0) < 32;
  return isControl || UNSAFE_NAME.test(char) ? '_' : char;
};

const fileNameOf = (chat, started, extension) => {
  const name = `xxii ${chat} ${stampOf(started)}`;
  return `${Array.from(name, safeChar).join('')}.${extension}`;
};

const dayStartOf = (date) =>
  new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();

const dateText = (started, now = Date.now()) => {
  const date = new Date(started);
  const today = new Date(now);
  const clock = `${pad(date.getHours())}:${pad(date.getMinutes())}`;
  const days = Math.round((dayStartOf(today) - dayStartOf(date)) / DAY_MS);
  if (days === 0) return `today ${clock}`;
  if (days === 1) return `yesterday ${clock}`;
  const day = `${MONTHS[date.getMonth()]} ${date.getDate()}`;
  const year = date.getFullYear();
  return year === today.getFullYear() ? day : `${day} ${year}`;
};

const titleOf = (chatName, started) => `${chatName} ${stampOf(started, ':')}`;

const programFileOf = (extension) => `${PROGRAM}.${extension}`;

const recordingUrlOf = (id, file) => `/recordings/${id}/${file}`;

const timeText = (ms) => {
  const total = Math.max(0, Math.floor(ms / SECOND_MS));
  const hours = Math.floor(total / HOUR_SECONDS);
  const minutes = Math.floor((total % HOUR_SECONDS) / MINUTE_SECONDS);
  const seconds = total % MINUTE_SECONDS;
  const base = `${pad(minutes)}:${pad(seconds)}`;
  return hours > 0 ? `${hours}:${base}` : base;
};

const sizeText = (bytes) => {
  let value = Math.max(0, bytes);
  let unit = 0;
  while (value >= KIBIBYTE && unit < SIZE_UNITS.length - 1) {
    value /= KIBIBYTE;
    unit++;
  }
  const digits = unit < 2 ? 0 : 1;
  return `${value.toFixed(digits)} ${SIZE_UNITS[unit]}`;
};

const encodeAttr = (char) =>
  `%${char.charCodeAt(0).toString(16).toUpperCase()}`;

const dispositionOf = (name) => {
  const ascii = name.replace(NON_ASCII, '_').replace(QUOTE, '_');
  const encoded = encodeURIComponent(name).replace(RFC5987, encodeAttr);
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encoded}`;
};

const typeOf = (mime) => {
  const text = typeof mime === 'string' ? mime : '';
  return text.split(';')[0].trim().toLowerCase();
};

const extensionOf = (name) => {
  const index = name.lastIndexOf('.');
  return index < 0 ? '' : name.slice(index + 1).toLowerCase();
};

const routeOf = (pathname) => {
  const match = ROUTE.exec(pathname);
  if (!match) return null;
  return { id: match[1], file: match[2] };
};

const rangeOf = (header, size) => {
  const match = RANGE.exec(header ?? '');
  const full = { status: 200, start: 0, end: size - 1 };
  if (!match || size === 0) return full;
  const hasStart = match[1] !== '';
  const hasEnd = match[2] !== '';
  if (!hasStart && !hasEnd) return full;
  const last = size - 1;
  const suffix = Number(match[2]);
  const start = hasStart ? Number(match[1]) : Math.max(0, size - suffix);
  const end = hasStart && hasEnd ? Math.min(Number(match[2]), last) : last;
  const isValid = start <= end && start < size && (hasStart || suffix > 0);
  if (!isValid) return { status: 416, start: 0, end: last };
  return { status: 206, start, end };
};

const createMeta = (input) => {
  const meta = {
    id: input.id,
    title: input.title,
    chat: input.chat,
    chatName: input.chatName,
    call: input.call,
    started: input.started,
    stopped: 0,
    duration: 0,
    size: 0,
    mime: input.mime,
    extension: input.extension,
    state: 'recording',
    options: input.options,
    people: input.people,
    folder: input.folder || '',
  };
  return meta.folder ? { ...meta, segments: [] } : meta;
};

const isOpen = (meta) => OPEN_STATES.includes(meta?.state);

const isFolderRecording = (meta) => Array.isArray(meta.segments);

const progressOf = (meta, event) => {
  if (!isOpen(meta) || isFolderRecording(meta)) return meta;
  return { ...meta, size: event.size, duration: event.duration };
};

const peopleOf = (meta, event) =>
  Array.isArray(event.people) ? event.people : meta.people;

const closeOf = (meta, event) => {
  if (!isOpen(meta)) return meta;
  const { size, duration } = isFolderRecording(meta) ? meta : event;
  const people = peopleOf(meta, event);
  return {
    ...meta,
    state: 'done',
    stopped: event.time,
    size,
    duration,
    people,
  };
};

const interruptOf = (meta, event) => {
  if (!isOpen(meta)) return meta;
  const { size, duration } = isFolderRecording(meta) ? meta : event;
  return { ...meta, state: 'interrupted', size, duration };
};

const segmentOf = (meta, { segment }) => {
  if (!isOpen(meta) || !isFolderRecording(meta)) return meta;
  const { size, duration } = segment;
  return {
    ...meta,
    segments: meta.segments.concat(segment),
    size: meta.size + size,
    duration: meta.duration + duration,
  };
};

const pauseOf = (meta) =>
  meta.state === 'recording' ? { ...meta, state: 'paused' } : meta;

const resumeOf = (meta) =>
  meta.state === 'paused' ? { ...meta, state: 'recording' } : meta;

const TRANSITIONS = {
  progress: progressOf,
  close: closeOf,
  interrupt: interruptOf,
  pause: pauseOf,
  resume: resumeOf,
  segment: segmentOf,
};

const nextMeta = (meta, event) => {
  const step = TRANSITIONS[event.type];
  return step ? step(meta, event) : meta;
};

const scheduleOf = (marks, now) => {
  const meta = now - marks.metaAt >= META_MS;
  const flush = meta || now - marks.flushedAt >= FLUSH_MS;
  return { flush, meta };
};

const markedOf = (marks, due, now) => ({
  flushedAt: due.flush ? now : marks.flushedAt,
  metaAt: due.meta ? now : marks.metaAt,
});

const spaceOf = (estimate) => {
  const quota = Number.isFinite(estimate?.quota) ? estimate.quota : Infinity;
  const usage = Number.isFinite(estimate?.usage) ? estimate.usage : 0;
  const free = quota - usage;
  if (free < STOP_BYTES) return 'full';
  if (free < LOW_BYTES) return 'low';
  return 'ok';
};

const readMeta = async (handle) => {
  const file = await handle.getFile();
  return JSON.parse(await file.text());
};

const recordingsOf = async (storage) => {
  const root = await storage.getDirectory();
  try {
    return await root.getDirectoryHandle(RECORDINGS);
  } catch (error) {
    if (error.name === 'NotFoundError') return null;
    throw error;
  }
};

export { RECORDINGS, META_FILE, POSTER_FILE, STATES, TYPES };
export { FLUSH_MS, META_MS, POSTER_MS, LOW_BYTES, STOP_BYTES };
export { stampOf, dateText, fileNameOf, titleOf, programFileOf, dispositionOf };
export { recordingUrlOf, timeText, sizeText };
export { typeOf, extensionOf, routeOf, rangeOf };
export { createMeta, nextMeta, isOpen, scheduleOf, markedOf, spaceOf };
export { isFolderRecording, readMeta, recordingsOf };
