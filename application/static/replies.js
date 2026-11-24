import { containerOf } from './chat.js';

const THREAD_COLORS = 32;

const byTime = (a, b) => a.timestamp - b.timestamp;

const rootOf = (records, id, top = '') => {
  const visited = new Set([id]);
  let current = id;
  while (true) {
    const parent = records.get(current)?.replyTo;
    if (!parent || parent === top) return current;
    if (visited.has(parent)) return Array.from(visited).toSorted()[0];
    visited.add(parent);
    current = parent;
  }
};

const threadOf = (replies, root) => {
  const thread = [];
  const visited = new Set([root]);
  const parents = [root];
  while (parents.length > 0) {
    const parent = parents.pop();
    for (const reply of replies.get(parent) ?? []) {
      if (visited.has(reply.id)) continue;
      visited.add(reply.id);
      thread.push(reply);
      parents.push(reply.id);
    }
  }
  return thread.toSorted(byTime);
};

const threadRootOf = (view, id, top = '') => {
  if (id === top) return '';
  const { records, replies } = view;
  const parent = records.get(id)?.replyTo;
  const hasParent = Boolean(parent) && parent !== top;
  return hasParent || replies.has(id) ? rootOf(records, id, top) : '';
};

const hashOf = (text) => {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
};

const colorOf = (root) => hashOf(root) % THREAD_COLORS;

const repliesToMe = (records, me, readAt) => {
  const found = new Map();
  for (const id of records.keys()) {
    const record = records.get(id);
    const parent = records.get(record.replyTo);
    const chat = containerOf(record);
    if (!parent || parent.author !== me || record.author === me) continue;
    if (chat === undefined || record.timestamp <= readAt(chat)) continue;
    const list = found.get(chat) ?? [];
    list.push({ id, timestamp: record.timestamp });
    found.set(chat, list);
  }
  const mine = new Map();
  for (const chat of found.keys()) {
    const ids = found
      .get(chat)
      .toSorted(byTime)
      .map((reply) => reply.id);
    mine.set(chat, ids);
  }
  return mine;
};

export { rootOf, threadOf, threadRootOf, colorOf, repliesToMe };
