const REACTIONS = {
  like: '👍',
  fire: '🔥',
  done: '✅',
  think: '🤔',
  love: '❤️',
  laugh: '😂',
};

const GENERAL = 'general';
const MAX_LENGTH = 4096;
const PAIR = /^[\w-]{1,64}_[\w-]{1,64}$/;

const FIELDS = {
  author: { nick: 'string', created: 'number' },
  chat: { name: 'string', icon: 'string', created: 'number' },
  message: {
    chat: 'string',
    author: 'string',
    nick: 'string',
    content: 'string',
    timestamp: 'number',
    replyTo: 'string',
    pinned: 'boolean',
  },
};

const genesis = (value) => ({ $lww: { value, time: 0, replica: GENERAL } });

const GENERAL_CHAT = {
  id: 'chat-general',
  entity: 'chat',
  target: GENERAL,
  data: { name: genesis(GENERAL), icon: genesis('💬'), created: genesis(0) },
};

const isField = (fields, key, node) => {
  if (!Object.hasOwn(fields, key)) return false;
  const value = node.$lww?.value;
  if (typeof value !== fields[key]) return false;
  return typeof value !== 'string' || value.length <= MAX_LENGTH;
};

const isReactions = (reactions) => {
  const isTagged = Boolean(reactions.$lww || reactions.$counter);
  if (Array.isArray(reactions) || isTagged) return false;
  for (const name in reactions) {
    if (!Object.hasOwn(REACTIONS, name)) return false;
    if (!reactions[name].$counter) return false;
  }
  return true;
};

const validate = (delta) => {
  const { entity, data } = delta;
  if (!Object.hasOwn(FIELDS, entity)) return false;
  const fields = FIELDS[entity];
  for (const key in data) {
    const node = data[key];
    const isReaction = entity === 'message' && key === 'reactions';
    const isValid = isReaction ? isReactions(node) : isField(fields, key, node);
    if (!isValid) return false;
  }
  return true;
};

const seed = (replica) => replica.merge([GENERAL_CHAT]);

const pairOf = (a, b) => (a < b ? `${a}_${b}` : `${b}_${a}`);

const isPair = (value) => typeof value === 'string' && PAIR.test(value);

const directUnit = (pair) => `dm_${pair}`;

const saveAuthor = (replica, peer, nick) => {
  const fields = { nick };
  if (!replica.get(peer)) fields.created = Date.now();
  return replica.assign('author', peer, fields);
};

const createChat = (replica, chat) => {
  const { id, name, icon, created } = chat;
  return replica.assign('chat', id, { name, icon, created });
};

const createMessage = (replica, message) => {
  const { id, chat, author, nick, content, timestamp } = message;
  const fields = { chat, author, nick, content, timestamp };
  if (message.replyTo) fields.replyTo = message.replyTo;
  return replica.assign('message', id, fields);
};

const react = (replica, messageId, reaction) => {
  const path = ['reactions', reaction];
  return replica.increment('message', messageId, path);
};

const pin = (replica, messageId, pinned) =>
  replica.assign('message', messageId, { pinned });

const byCreated = (a, b) => a.created - b.created || (a.name > b.name ? 1 : -1);
const byTime = (a, b) => a.timestamp - b.timestamp;

const listChats = (replica) => {
  const chats = [];
  for (const id of replica.keys('chat')) {
    const record = replica.get(id);
    if (record.name !== undefined) chats.push({ id, ...record });
  }
  return chats.toSorted(byCreated);
};

const listAuthors = (replica) => {
  const authors = [];
  for (const id of replica.keys('author')) {
    const record = replica.get(id);
    if (record.nick !== undefined) authors.push({ id, ...record });
  }
  return authors;
};

const threadsOf = (replica, chat) => {
  const roots = [];
  const replies = new Map();
  for (const id of replica.keys('message')) {
    const record = replica.get(id);
    const isShown = record.chat === chat && record.timestamp !== undefined;
    if (!isShown) continue;
    const message = { id, ...record };
    if (!record.replyTo) {
      roots.push(message);
      continue;
    }
    const thread = replies.get(record.replyTo) ?? [];
    thread.push(message);
    replies.set(record.replyTo, thread);
  }
  for (const thread of replies.values()) thread.sort(byTime);
  return { roots: roots.toSorted(byTime), replies };
};

const activityOf = (replica) => {
  const activity = new Map();
  for (const id of replica.keys('message')) {
    const { chat, timestamp } = replica.get(id);
    if (chat === undefined || timestamp === undefined) continue;
    const last = activity.get(chat) ?? 0;
    if (timestamp > last) activity.set(chat, timestamp);
  }
  return activity;
};

export { REACTIONS, GENERAL, validate, seed };
export { pairOf, isPair, directUnit };
export { saveAuthor, createChat, createMessage, react, pin };
export { listChats, listAuthors, threadsOf, activityOf };
