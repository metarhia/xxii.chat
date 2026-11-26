import { RECORDINGS, sizeText } from './recording-files.js';

const MESSAGE_DIRECTORIES = ['chat', 'dm'];
const FILES_DIRECTORY = 'files';
const DIRECTORIES = [...MESSAGE_DIRECTORIES, FILES_DIRECTORY, RECORDINGS];
const PARTS = [
  ['messages', 'Messages'],
  ['files', 'Files'],
  ['recordings', 'Recordings'],
  ['app', 'App'],
];
const PERCENT = 100;
const MIN_SHARE = 0.5;

const bytesOf = (value) => (Number.isFinite(value) && value > 0 ? value : 0);

const add = (left, right) => left + right;

const estimate = async (storage = globalThis.navigator?.storage) => {
  if (typeof storage?.estimate !== 'function') return null;
  try {
    const { usage, quota } = await storage.estimate();
    return { usage: bytesOf(usage), quota: bytesOf(quota) };
  } catch {
    return null;
  }
};

const fileSize = async (handle) => {
  try {
    return (await handle.getFile()).size;
  } catch {
    return 0;
  }
};

const directorySize = async (directory, signal) => {
  let total = 0;
  for await (const entry of directory.values()) {
    if (signal?.aborted) return total;
    const isFile = entry.kind === 'file';
    const size = isFile ? fileSize : directorySize;
    total += await size(entry, signal);
  }
  return total;
};

const sizeOfName = async (root, name, signal) => {
  try {
    const directory = await root.getDirectoryHandle(name);
    return await directorySize(directory, signal);
  } catch {
    return 0;
  }
};

const measure = async (storage, signal) => {
  if (typeof storage?.getDirectory !== 'function') return null;
  try {
    const root = await storage.getDirectory();
    const sizes = {};
    for (const name of DIRECTORIES) {
      if (signal?.aborted) return null;
      sizes[name] = await sizeOfName(root, name, signal);
    }
    return signal?.aborted ? null : sizes;
  } catch {
    return null;
  }
};

const breakdownOf = ({ usage, quota, sizes } = {}) => {
  const size = (name) => bytesOf(sizes?.[name]);
  const messages = MESSAGE_DIRECTORIES.map(size).reduce(add, 0);
  const files = size(FILES_DIRECTORY);
  const recordings = size(RECORDINGS);
  const known = messages + files + recordings;
  const app = Math.max(0, bytesOf(usage) - known);
  const total = known + app;
  return { messages, files, recordings, app, total, quota: bytesOf(quota) };
};

const sharesOf = ({ messages, files, recordings, app, total, quota }) => {
  const scale = Math.max(quota, total);
  const shareOf = (bytes) => {
    if (scale === 0 || bytes === 0) return 0;
    return Math.max(MIN_SHARE, (bytes / scale) * PERCENT);
  };
  return {
    messages: shareOf(messages),
    files: shareOf(files),
    recordings: shareOf(recordings),
    app: shareOf(app),
  };
};

const usageText = ({ total, quota }) => {
  if (quota === 0) return sizeText(total);
  return `${sizeText(total)} of ${sizeText(quota)}`;
};

const partTexts = (breakdown) =>
  PARTS.map(([name, label]) => ({
    name,
    text: `${label} ${sizeText(breakdown[name])}`,
  }));

const partsText = (breakdown) =>
  partTexts(breakdown)
    .map(({ text }) => text)
    .join(' · ');

export { DIRECTORIES, PARTS, estimate, measure, breakdownOf, sharesOf };
export { usageText, partTexts, partsText };
