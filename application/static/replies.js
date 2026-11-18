import { containerOf } from './chat.js';

const PALETTE = 8;
const NICKS_SHOWN = 5;
const EMPTY = Object.freeze({ kind: '' });

const byTime = (a, b) => a.timestamp - b.timestamp;

const rootOf = (records, id) => {
  const visited = new Set([id]);
  let current = id;
  while (true) {
    const parent = records.get(current)?.replyTo;
    if (!parent) return current;
    if (visited.has(parent)) return Array.from(visited).sort()[0];
    visited.add(parent);
    current = parent;
  }
};

const conversationOf = (replies, root) => {
  const conversation = [];
  const visited = new Set([root]);
  const parents = [root];
  while (parents.length > 0) {
    const parent = parents.pop();
    for (const reply of replies.get(parent) ?? []) {
      if (visited.has(reply.id)) continue;
      visited.add(reply.id);
      conversation.push(reply);
      parents.push(reply.id);
    }
  }
  return conversation.sort(byTime);
};

const ancestorsOf = (records, id) => {
  const ancestors = [];
  const visited = new Set([id]);
  let parent = records.get(id)?.replyTo;
  while (parent && !visited.has(parent)) {
    visited.add(parent);
    ancestors.unshift(parent);
    parent = records.get(parent)?.replyTo;
  }
  return ancestors;
};

const branchOf = (records, replies, id) => {
  const ancestors = ancestorsOf(records, id);
  const descendants = conversationOf(replies, id).map((reply) => reply.id);
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

const colorOf = (root) => hashOf(root) % PALETTE;

const titleOf = (count, nicks) => {
  const noun = count === 1 ? 'reply' : 'replies';
  const shown = nicks.slice(0, NICKS_SHOWN).join(', ');
  const more = nicks.length > NICKS_SHOWN ? ', …' : '';
  return `${count} ${noun} · ${shown}${more}`;
};

const groupsOf = (rows) => {
  const groups = new Map();
  for (let i = 0; i < rows.length; i++) {
    const { id, root, nick } = rows[i];
    const group = groups.get(root) ?? {
      root,
      first: i,
      last: i,
      count: 0,
      nicks: [],
    };
    group.last = i;
    if (id !== root) group.count++;
    if (nick && !group.nicks.includes(nick)) group.nicks.push(nick);
    groups.set(root, group);
  }
  return Array.from(groups.values()).filter((group) => group.count > 0);
};

const cellOf = (group, index, row) => {
  const { root, count, nicks, first, last } = group;
  const title = titleOf(count, nicks);
  const color = colorOf(root);
  const isOwn = row.root === root;
  let kind = 'pass';
  if (isOwn && row.id === root) kind = 'root';
  else if (isOwn && index === last) kind = 'last';
  else if (isOwn) kind = 'node';
  const cut = isOwn && row.id !== root && index === first;
  return { kind, root, color, title, cut };
};

const overflowCell = (rest, index) => {
  const isSpan = rest.some((g) => index >= g.first && index <= g.last);
  if (!isSpan) return EMPTY;
  const count = rest.reduce((sum, group) => sum + group.count, 0);
  const nicks = Array.from(new Set(rest.flatMap((group) => group.nicks)));
  return { kind: 'overflow', root: '', title: titleOf(count, nicks) };
};

const assignSlots = (chosen, slots, max) => {
  const taken = new Set();
  const next = new Map();
  for (const group of chosen) {
    const slot = slots.get(group.root);
    const isUsable = slot !== undefined && slot < max && !taken.has(slot);
    if (!isUsable) continue;
    taken.add(slot);
    next.set(group.root, slot);
  }
  let free = 0;
  for (const group of chosen) {
    if (next.has(group.root)) continue;
    while (taken.has(free)) free++;
    taken.add(free);
    next.set(group.root, free);
  }
  slots.clear();
  for (const root of next.keys()) slots.set(root, next.get(root));
};

const lanesOf = (rows, max, slots = new Map()) => {
  const groups = groupsOf(rows);
  const latest = groups.toSorted((a, b) => b.last - a.last);
  const chosen = latest.slice(0, max).sort((a, b) => a.first - b.first);
  const rest = latest.slice(max);
  assignSlots(chosen, slots, max);
  const width = chosen.length === 0 ? 0 : Math.max(...slots.values()) + 1;
  const lanes = [];
  for (let i = 0; i < rows.length; i++) {
    const cells = new Array(width).fill(EMPTY);
    for (const group of chosen) {
      const isSpan = i >= group.first && i <= group.last;
      if (isSpan) cells[slots.get(group.root)] = cellOf(group, i, rows[i]);
    }
    if (rest.length > 0) cells.push(overflowCell(rest, i));
    lanes.push(cells);
  }
  return lanes;
};

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

export { rootOf, conversationOf, branchOf, lanesOf, colorOf, repliesToMe };
