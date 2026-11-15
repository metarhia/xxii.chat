const REACTIONS = ['like', 'dislike', 'love', 'smile', 'poo'];
const GENERAL = 'general';
const MAX_LENGTH = 4096;

const FIELDS = {
  chat: { name: 'string', created: 'number' },
  message: {
    chat: 'string',
    username: 'string',
    content: 'string',
    timestamp: 'number',
  },
};

const genesis = (value) => ({ $lww: { value, time: 0, replica: GENERAL } });

const GENERAL_CHAT = {
  id: 'chat-general',
  entity: 'chat',
  target: GENERAL,
  data: { name: genesis(GENERAL), created: genesis(0) },
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
    if (!REACTIONS.includes(name)) return false;
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

const createChat = (replica, chat) => {
  const { id, name, created } = chat;
  return replica.assign('chat', id, { name, created });
};

const createMessage = (replica, message) => {
  const { id, chat, username, content, timestamp } = message;
  return replica.assign('message', id, { chat, username, content, timestamp });
};

const react = (replica, messageId, reaction) => {
  const path = ['reactions', reaction];
  return replica.increment('message', messageId, path);
};

const byCreated = (a, b) => a.created - b.created || (a.name > b.name ? 1 : -1);

const listChats = (replica) => {
  const chats = [];
  for (const id of replica.keys('chat')) {
    const record = replica.get(id);
    if (record.name !== undefined) chats.push({ id, ...record });
  }
  return chats.toSorted(byCreated);
};

const listMessages = (replica, chat) => {
  const messages = [];
  for (const id of replica.keys('message')) {
    const record = replica.get(id);
    const isShown = record.chat === chat && record.timestamp !== undefined;
    if (isShown) messages.push({ id, ...record });
  }
  return messages.toSorted((a, b) => a.timestamp - b.timestamp);
};

const chatActivity = (replica) => {
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
export { createChat, createMessage, react };
export { listChats, listMessages, chatActivity };
