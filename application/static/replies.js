import { containerOf } from './chat.js';

const THREAD_COLORS = 32;

const byTime = (a, b) => a.timestamp - b.timestamp;

const rootOf = (records, id, top = '') => {
  const visited = new Set([id]);
  let current = id;
  while (true) {
    const parent = records.get(current)?.replyTo;
    if (!parent || parent === top) return current;
    if (visited.has(parent)) return Array.from(visited).sort()[0];
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
  return thread.sort(byTime);
};

const threadRootOf = (view, id, top = '') => {
  if (id === top) return '';
  const { records, replies } = view;
  const parent = records.get(id)?.replyTo;
  const hasParent = Boolean(parent) && parent !== top;
  return hasParent || replies.has(id) ? rootOf(records, id, top) : '';
};

const ancestorsOf = (records, id, top) => {
  const ancestors = [];
  const visited = new Set([id]);
  let parent = records.get(id)?.replyTo;
  while (parent && parent !== top && !visited.has(parent)) {
    visited.add(parent);
    ancestors.unshift(parent);
    parent = records.get(parent)?.replyTo;
  }
  return ancestors;
};

const branchOf = (records, replies, id, top = '') => {
  const ancestors = ancestorsOf(records, id, top);
  const descendants = threadOf(replies, id).map((reply) => reply.id);
  return ancestors.concat([id], descendants);
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
      .sort(byTime)
      .map((reply) => reply.id);
    mine.set(chat, ids);
  }
  return mine;
};

export { rootOf, threadOf, threadRootOf, branchOf, colorOf, repliesToMe };
