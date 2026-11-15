const REACTIONS = {
  like: '👍',
  fire: '🔥',
  done: '✅',
  think: '🤔',
  love: '❤️',
  laugh: '😂',
};

const REACTION_NAMES = Object.keys(REACTIONS);
const ICONS = { chat: '💬', feed: '📢', folder: '📁' };
const PREFIXES = { chat: '!', feed: '#' };
const CHANNELS = ['feed', 'chat'];
const TIMELINE = ['message', 'post'];
const VISIBILITY = ['unlisted', 'public'];
const GENERAL = 'general';
const MAX_LENGTH = 4096;
const TEXT_LENGTH = 65536;
const MAX_FILE_SIZE = 10 * 1024 * 1024;
const CHECKSUM = /^[0-9a-f]{64}$/;
const PAIR = /^[\w-]{1,64}_[\w-]{1,64}$/;
const ICON_PREFIX = /^(\p{Extended_Pictographic}\S*)\s+(.+)$/u;

const TYPES = {
  string: (value) => typeof value === 'string' && value.length <= MAX_LENGTH,
  text: (value) => typeof value === 'string' && value.length <= TEXT_LENGTH,
  number: (value) => typeof value === 'number',
  boolean: (value) => typeof value === 'boolean',
  checksum: (value) => typeof value === 'string' && CHECKSUM.test(value),
  size: (value) =>
    Number.isSafeInteger(value) && value > 0 && value <= MAX_FILE_SIZE,
};

const CHANNEL = {
  name: 'string',
  icon: 'string',
  description: 'string',
  owner: 'string',
  created: 'number',
};

const FIELDS = {
  author: { nick: 'string', created: 'number' },
  chat: CHANNEL,
  feed: CHANNEL,
  folder: { ...CHANNEL, parent: 'string', visibility: VISIBILITY },
  entry: { folder: 'string', item: 'string', active: 'boolean' },
  message: {
    chat: 'string',
    author: 'string',
    nick: 'string',
    content: 'string',
    timestamp: 'number',
    replyTo: 'string',
    pinned: 'boolean',
  },
  post: {
    feed: 'string',
    author: 'string',
    nick: 'string',
    title: 'string',
    content: 'text',
    timestamp: 'number',
    pinned: 'boolean',
  },
  file: {
    chat: 'string',
    message: 'string',
    author: 'string',
    name: 'string',
    mime: 'string',
    size: 'size',
    checksum: 'checksum',
    width: 'number',
    height: 'number',
    created: 'number',
  },
  reaction: {
    chat: 'string',
    message: 'string',
    author: 'string',
    reaction: REACTION_NAMES,
    active: 'boolean',
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
  const type = fields[key];
  const value = node?.$lww?.value;
  if (Array.isArray(type)) return type.includes(value);
  return TYPES[type](value);
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
  const hasReactions = TIMELINE.includes(entity);
  for (const key in data) {
    const node = data[key];
    const isReaction = hasReactions && key === 'reactions';
    const isValid = isReaction ? isReactions(node) : isField(fields, key, node);
    if (!isValid) return false;
  }
  return true;
};

const seed = (replica) => replica.merge([GENERAL_CHAT]);

const pairOf = (a, b) => (a < b ? `${a}_${b}` : `${b}_${a}`);

const isPair = (value) => typeof value === 'string' && PAIR.test(value);

const directUnit = (pair) => `dm_${pair}`;

const isFeed = (replica, id) => replica.keys('feed').some((key) => key === id);

const isPost = (record) => typeof record.feed === 'string';

const entityOf = (record) => (isPost(record) ? 'post' : 'message');

const containerOf = (record) => record.feed ?? record.chat;

const labelOf = (channel) => `${PREFIXES[channel.entity]}${channel.name}`;

const parseTitle = (text, entity) => {
  const title = text.trim();
  const match = title.match(ICON_PREFIX);
  if (!match) return { icon: ICONS[entity], name: title };
  return { icon: match[1], name: match[2] };
};

const saveAuthor = (replica, peer, nick) => {
  const fields = { nick };
  if (!replica.get(peer)) fields.created = Date.now();
  return replica.assign('author', peer, fields);
};

const createChannel = (replica, entity, channel) => {
  const { id, name, icon, owner, created } = channel;
  return replica.assign(entity, id, { name, icon, owner, created });
};

const describe = (replica, entity, id, description) =>
  replica.assign(entity, id, { description });

const createFolder = (replica, folder) => {
  const { id, name, icon, owner, parent, created } = folder;
  const fields = { name, icon, owner, parent, created };
  return replica.assign('folder', id, { ...fields, visibility: 'unlisted' });
};

const setVisibility = (replica, id, visibility) =>
  replica.assign('folder', id, { visibility });

const placeItem = (replica, folder, item, active) =>
  replica.assign('entry', `${folder}/${item}`, { folder, item, active });

const createMessage = (replica, message) => {
  const { id, chat, author, nick, content, timestamp } = message;
  const fields = { chat, author, nick, content, timestamp };
  if (message.replyTo) fields.replyTo = message.replyTo;
  return replica.assign('message', id, fields);
};

const createPost = (replica, post) => {
  const { id, feed, author, nick, title, content, timestamp } = post;
  const fields = { feed, author, nick, title, content, timestamp };
  return replica.assign('post', id, fields);
};

const attachFile = (replica, file) => {
  const { id, chat, message, author, name, mime, size, checksum } = file;
  const { width, height, created } = file;
  const fields = { chat, message, author, name, mime, size, checksum, created };
  const isSized = Number.isFinite(width) && Number.isFinite(height);
  const sized = isSized ? { ...fields, width, height } : fields;
  return replica.assign('file', id, sized);
};

const setReaction = (replica, fields) => {
  const { chat, message, author, reaction, active } = fields;
  const id = `${message}/${author}/${reaction}`;
  const record = { chat, message, author, reaction, active };
  return replica.assign('reaction', id, record);
};

const pin = (replica, record, pinned) =>
  replica.assign(entityOf(record), record.id, { pinned });

const byCreated = (a, b) => a.created - b.created || (a.name > b.name ? 1 : -1);
const byName = (a, b) => a.name.localeCompare(b.name);
const byTime = (a, b) => a.timestamp - b.timestamp;

const listChannels = (replica, entity) => {
  const channels = [];
  for (const id of replica.keys(entity)) {
    const record = replica.get(id);
    if (record.name !== undefined) channels.push({ id, entity, ...record });
  }
  return channels.toSorted(byCreated);
};

const listAuthors = (replica) => {
  const authors = [];
  for (const id of replica.keys('author')) {
    const record = replica.get(id);
    if (record.nick !== undefined) authors.push({ id, ...record });
  }
  return authors;
};

const isVisible = (folder, viewer) =>
  folder.visibility === 'public' || folder.owner === viewer;

const listFolders = (replica, viewer) => {
  const folders = new Map();
  for (const id of replica.keys('folder')) {
    const record = replica.get(id);
    const isShown = record.name !== undefined && isVisible(record, viewer);
    if (isShown) folders.set(id, { id, ...record });
  }
  return folders;
};

// Concurrent moves can make parents a loop, such folders stay at the root
const isInLoop = (folders, folder) => {
  const seen = new Set();
  let current = folders.get(folder.parent);
  while (current && !seen.has(current.id)) {
    if (current.id === folder.id) return true;
    seen.add(current.id);
    current = folders.get(current.parent);
  }
  return false;
};

const folderTree = (replica, viewer) => {
  const folders = listFolders(replica, viewer);
  const children = new Map();
  for (const folder of folders.values()) {
    const isNested = folders.has(folder.parent) && !isInLoop(folders, folder);
    const parent = isNested ? folder.parent : '';
    const siblings = children.get(parent) ?? [];
    siblings.push(folder);
    children.set(parent, siblings);
  }
  for (const siblings of children.values()) siblings.sort(byName);
  const items = new Map();
  for (const id of replica.keys('entry')) {
    const { folder, item, active } = replica.get(id);
    if (active !== true || !folders.has(folder)) continue;
    const placed = items.get(folder) ?? new Set();
    placed.add(item);
    items.set(folder, placed);
  }
  return { folders, children, items };
};

const threadsOf = (replica, chat) => {
  const roots = [];
  const replies = new Map();
  for (const id of replica.keys('post')) {
    const record = replica.get(id);
    const isShown = record.feed === chat && record.timestamp !== undefined;
    if (isShown) roots.push({ id, ...record });
  }
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

const attachmentsOf = (replica, chat) => {
  const attachments = new Map();
  for (const id of replica.keys('file')) {
    const record = replica.get(id);
    const isShown = record.chat === chat && record.checksum !== undefined;
    if (!isShown) continue;
    const files = attachments.get(record.message) ?? [];
    files.push({ id, ...record });
    attachments.set(record.message, files);
  }
  for (const files of attachments.values()) files.sort(byCreated);
  return attachments;
};

const reactionsOf = (replica, chat) => {
  const reactions = new Map();
  for (const id of replica.keys('reaction')) {
    const record = replica.get(id);
    if (record.chat !== chat || record.active !== true) continue;
    const byMessage = reactions.get(record.message) ?? new Map();
    const authors = byMessage.get(record.reaction) ?? new Set();
    authors.add(record.author);
    byMessage.set(record.reaction, authors);
    reactions.set(record.message, byMessage);
  }
  return reactions;
};

const unreadOf = (replica, reader, readAt) => {
  const unread = new Map();
  for (const entity of TIMELINE) {
    for (const id of replica.keys(entity)) {
      const record = replica.get(id);
      const chat = containerOf(record);
      const isOthers = record.author !== reader;
      const isNew = record.timestamp > readAt(chat);
      if (chat === undefined || !isOthers || !isNew) continue;
      unread.set(chat, (unread.get(chat) ?? 0) + 1);
    }
  }
  return unread;
};

const filesOf = (replica) => {
  const files = new Map();
  for (const id of replica.keys('file')) {
    const { checksum, size } = replica.get(id);
    if (checksum !== undefined) files.set(checksum, { checksum, size });
  }
  return files;
};

const activityOf = (replica) => {
  const activity = new Map();
  for (const entity of TIMELINE) {
    for (const id of replica.keys(entity)) {
      const record = replica.get(id);
      const chat = containerOf(record);
      const { timestamp } = record;
      if (chat === undefined || timestamp === undefined) continue;
      const last = activity.get(chat) ?? 0;
      if (timestamp > last) activity.set(chat, timestamp);
    }
  }
  return activity;
};

export { REACTIONS, ICONS, CHANNELS, TIMELINE, GENERAL };
export { MAX_LENGTH, TEXT_LENGTH, MAX_FILE_SIZE, validate, seed };
export { pairOf, isPair, directUnit };
export { isFeed, isPost, containerOf, labelOf, parseTitle };
export { saveAuthor, createChannel, describe };
export { createFolder, setVisibility, placeItem };
export { createMessage, createPost, attachFile, setReaction, pin };
export { listChannels, listAuthors, folderTree, threadsOf, activityOf };
export { attachmentsOf, reactionsOf, unreadOf, filesOf };
