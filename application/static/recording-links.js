import { META_FILE, readMeta, recordingsOf } from './recording-files.js';
import { plural } from './view.js';

const isFinished = (meta) =>
  meta?.state === 'done' || meta?.state === 'interrupted';

const idOf = async (directory) => {
  if (directory.kind !== 'directory') return '';
  try {
    const handle = await directory.getFileHandle(META_FILE);
    return isFinished(await readMeta(handle)) ? directory.name : '';
  } catch {
    return '';
  }
};

const localIdsOf = async (storage) => {
  if (typeof storage?.getDirectory !== 'function') return new Set();
  const recordings = await recordingsOf(storage);
  if (!recordings) return new Set();
  const reads = [];
  for await (const directory of recordings.values()) {
    reads.push(idOf(directory));
  }
  return new Set((await Promise.all(reads)).filter(Boolean));
};

const sameIds = (first, second) =>
  first.size === second.size && [...first].every((id) => second.has(id));

const linksOf = (items, local) => {
  const byCall = new Map();
  if (local.size === 0) return byCall;
  for (const item of items) {
    if (item.kind !== 'recording' || !local.has(item.id)) continue;
    if (!item.call) continue;
    const ids = byCall.get(item.call) ?? [];
    ids.push(item.id);
    byCall.set(item.call, ids);
  }
  return byCall;
};

const callLinkText = (count) => `▶ ${plural(count, 'recording', 'recordings')}`;

export { localIdsOf, sameIds, linksOf, callLinkText };
