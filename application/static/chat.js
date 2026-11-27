const REACTIONS = {
  like: '👍',
  love: '❤️',
  laugh: '😂',
  wow: '😮',
  sad: '😢',
  fire: '🔥',
  think: '🤔',
  hundred: '💯',
  dislike: '👎',
};

const REACTION_NAMES = Object.keys(REACTIONS).concat('done');
const ICONS = { chat: '💬', feed: '📢', folder: '📁' };
const PREFIXES = { chat: '!', feed: '#' };
const CHANNELS = ['feed', 'chat'];
const TIMELINE = ['message', 'post'];
const VISIBILITY = ['unlisted', 'public'];
const GENERAL = 'general';
const MAX_LENGTH = 4096;
const TEXT_LENGTH = 65536;
const QUOTE_LENGTH = 300;
const MAX_FILE_SIZE = 10 * 1024 * 1024;
const MAX_AVATAR = 24 * 1024;
const PHOTO = /^data:image\/jpeg;base64,[A-Za-z0-9+/]+={0,2}$/;
const CHECKSUM = /^[0-9a-f]{64}$/;
const PAIR = /^[\w-]{1,64}_[\w-]{1,64}$/;
const ICON_PREFIX = /^(\p{Extended_Pictographic}\S*)\s+(.+)$/u;

const isAvatar = (value) =>
  typeof value === 'string' &&
  value.length <= MAX_AVATAR &&
  (value === '' || PHOTO.test(value));

const TYPES = {
  string: (value) => typeof value === 'string' && value.length <= MAX_LENGTH,
  text: (value) => typeof value === 'string' && value.length <= TEXT_LENGTH,
  quote: (value) => typeof value === 'string' && value.length <= QUOTE_LENGTH,
  number: (value) => typeof value === 'number',
  boolean: (value) => typeof value === 'boolean',
  video: (value) =>
    typeof value === 'string' && /^[0-9a-f]{64}\.[0-9a-f]{64}$/.test(value),
  videoDuration: (value) => Number.isSafeInteger(value) && value >= 0,
  checksum: (value) => typeof value === 'string' && CHECKSUM.test(value),
  avatar: isAvatar,
  waveform: (value) =>
    typeof value === 'string' && /^[0-9a-f]{0,48}$/.test(value),
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

const VIDEO_POST = {
  video: 'video',
  videoTitle: 'string',
  videoPoster: 'avatar',
  videoDuration: 'videoDuration',
};

const FIELDS = {
  author: { nick: 'string', avatar: 'avatar', created: 'number' },
  chat: CHANNEL,
  feed: CHANNEL,
  folder: { ...CHANNEL, parent: 'string', visibility: VISIBILITY },
  entry: { folder: 'string', item: 'string', active: 'boolean' },
  message: {
    ...VIDEO_POST,
    chat: 'string',
    author: 'string',
    nick: 'string',
    content: 'string',
    timestamp: 'number',
    replyTo: 'string',
    quote: 'quote',
    forwarded: 'string',
    origin: 'string',
    edited: 'number',
    deleted: 'number',
    pinned: 'boolean',
  },
  post: {
    ...VIDEO_POST,
    feed: 'string',
    author: 'string',
    nick: 'string',
    title: 'string',
    content: 'text',
    timestamp: 'number',
    pinned: 'boolean',
  },
  call: {
    chat: 'string',
    host: 'string',
    nick: 'string',
    title: 'string',
    timestamp: 'number',
    ended: 'number',
    peak: 'number',
    names: 'string',
  },
  recording: {
    chat: 'string',
    call: 'string',
    author: 'string',
    nick: 'string',
    timestamp: 'number',
    stopped: 'number',
  },
  contactRequest: {
    chat: 'string',
    author: 'string',
    nick: 'string',
    state: ['requested', 'accepted', 'declined'],
  },
  file: {
    chat: 'string',
    message: 'string',
    author: 'string',
    name: 'string',
    mime: 'string',
    size: 'size',
    checksum: 'checksum',
    presentation: ['voice', 'circle'],
    waveform: 'waveform',
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
    if (!REACTION_NAMES.includes(name)) return false;
    if (!reactions[name].$counter) return false;
  }
  return true;
};

const validate = (delta) => {
  const { entity, data } = delta;
  if (!Object.hasOwn(FIELDS, entity)) return false;
  const fields = FIELDS[entity];
  const hasReactions = TIMELINE.includes(entity);
  if (Object.hasOwn(data, 'quote') && !Object.hasOwn(data, 'replyTo')) {
    return false;
  }
  if (Object.hasOwn(data, 'origin') && !Object.hasOwn(data, 'forwarded')) {
    return false;
  }
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

const saveAuthor = (replica, peer, nick, avatar = '') => {
  const author = replica.get(peer);
  const fields = {};
  if (!author) fields.created = Date.now();
  if (author?.nick !== nick) fields.nick = nick;
  const change = Object.keys(fields).length
    ? replica.assign('author', peer, fields)
    : null;
  return (author?.avatar ?? '') === avatar
    ? change
    : replica.assign('author', peer, { avatar });
};

const createChannel = (replica, entity, channel) => {
  const { id, name, icon, owner, created } = channel;
  return replica.assign(entity, id, { name, icon, owner, created });
};

const describe = (replica, entity, id, description) =>
  replica.assign(entity, id, { description });

const attachVideoPost = (replica, entity, record) => {
  const { id, video, videoTitle, videoPoster, videoDuration } = record;
  if (!video) return null;
  return replica.assign(entity, id, {
    video,
    videoTitle,
    videoPoster,
    videoDuration,
  });
};

const createMessage = (replica, message) => {
  const { id, chat, author, nick, content, timestamp } = message;
  const fields = { chat, author, nick, content, timestamp };
  if (message.replyTo) fields.replyTo = message.replyTo;
  if (message.quote && message.replyTo) fields.quote = message.quote;
  if (message.forwarded) {
    fields.forwarded = message.forwarded;
    fields.origin = message.origin ?? '';
  }
  const change = replica.assign('message', id, fields);
  return attachVideoPost(replica, 'message', message) ?? change;
};

const editMessage = (replica, id, { content, edited }) =>
  replica.assign('message', id, { content, edited });

const deleteMessage = (replica, record, deleted) => {
  const fields = { content: '', deleted };
  if (record.pinned) fields.pinned = false;
  return replica.assign('message', record.id, fields);
};

const createPost = (replica, post) => {
  const { id, feed, author, nick, title, content, timestamp } = post;
  const fields = { feed, author, nick, title, content, timestamp };
  const change = replica.assign('post', id, fields);
  return attachVideoPost(replica, 'post', post) ?? change;
};

const startCall = (replica, record) => {
  const { id, chat, host, nick, title, timestamp } = record;
  const fields = { chat, host, nick, timestamp };
  if (title) fields.title = title;
  return replica.assign('call', id, fields);
};

const endCall = (replica, id, { ended, peak, names }) => {
  const clipped = names.slice(0, MAX_LENGTH);
  return replica.assign('call', id, { ended, peak, names: clipped });
};

const startRecording = (replica, record) => {
  const { id, chat, call, author, nick, timestamp, stopped } = record;
  const fields = { chat, call, author, nick, timestamp };
  if (typeof stopped === 'number') fields.stopped = stopped;
  return replica.assign('recording', id, fields);
};

const stopRecording = (replica, id, { stopped }) =>
  replica.assign('recording', id, { stopped });

const attachFile = (replica, file) => {
  const { id, chat, message, author, name, mime, size, checksum } = file;
  const { width, height, created } = file;
  const fields = { chat, message, author, name, mime, size, checksum, created };
  const isSized = Number.isFinite(width) && Number.isFinite(height);
  const sized = isSized ? { ...fields, width, height } : fields;
  const change = replica.assign('file', id, sized);
  if (!file.presentation) return change;
  return replica.assign('file', id, {
    presentation: file.presentation,
    waveform: file.waveform ?? '',
  });
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

const isDeleted = (record) => typeof record.deleted === 'number';

const isKept = (id, replies, kept) => {
  if (kept.has(id)) return kept.get(id);
  kept.set(id, false);
  const thread = replies.get(id) ?? [];
  const isShown = (reply) =>
    !isDeleted(reply) || isKept(reply.id, replies, kept);
  const result = thread.some(isShown);
  kept.set(id, result);
  return result;
};

const dropDeleted = (messages, records, replies) => {
  const kept = new Map();
  const dropped = new Set();
  for (const message of messages) {
    if (!isDeleted(message)) continue;
    if (!isKept(message.id, replies, kept)) dropped.add(message.id);
  }
  if (dropped.size === 0) return messages;
  for (const id of dropped) records.delete(id);
  for (const parent of replies.keys()) {
    const thread = replies.get(parent);
    const shown = thread.filter((reply) => !dropped.has(reply.id));
    if (shown.length > 0) replies.set(parent, shown);
    else replies.delete(parent);
  }
  return messages.filter((message) => !dropped.has(message.id));
};

const threadsOf = (replica, chat) => {
  const posts = [];
  const messages = [];
  const records = new Map();
  const replies = new Map();
  for (const id of replica.keys('post')) {
    const record = replica.get(id);
    const isShown = record.feed === chat && record.timestamp !== undefined;
    if (!isShown) continue;
    const post = { id, ...record };
    posts.push(post);
    records.set(id, post);
  }
  for (const id of replica.keys('message')) {
    const record = replica.get(id);
    const isShown = record.chat === chat && record.timestamp !== undefined;
    if (!isShown) continue;
    const message = { id, ...record };
    messages.push(message);
    records.set(id, message);
    if (!record.replyTo) continue;
    const thread = replies.get(record.replyTo) ?? [];
    thread.push(message);
    replies.set(record.replyTo, thread);
  }
  const calls = [];
  const isFeedChannel = isFeed(replica, chat);
  if (!isFeedChannel) {
    for (const id of replica.keys('call')) {
      const record = replica.get(id);
      const hasTime = typeof record.timestamp === 'number';
      const isShown = record.chat === chat && hasTime;
      if (!isShown) continue;
      const call = { id, kind: 'call', ...record };
      calls.push(call);
      records.set(id, call);
    }
  }
  const recordings = [];
  if (!isFeedChannel) {
    for (const id of replica.keys('recording')) {
      const record = replica.get(id);
      const hasTime = typeof record.timestamp === 'number';
      const isShown = record.chat === chat && hasTime;
      const isDraft = record.call === '' && !Number.isFinite(record.stopped);
      if (!isShown || isDraft) continue;
      const recording = { id, kind: 'recording', ...record };
      recordings.push(recording);
      records.set(id, recording);
    }
  }
  for (const thread of replies.values()) thread.sort(byTime);
  const shownMessages = dropDeleted(messages, records, replies);
  const timeline = shownMessages.concat(calls, recordings);
  const shown = isFeedChannel ? posts : timeline;
  return { items: shown.toSorted(byTime), records, replies };
};

const lineageOf = (records, id) => {
  const lineage = [];
  let record = records.get(id);
  while (record && !lineage.includes(record.id)) {
    lineage.push(record.id);
    record = records.get(record.replyTo);
  }
  return lineage;
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

const countOthers = (unread, replica, entity, field, others) => {
  for (const id of replica.keys(entity)) {
    const record = replica.get(id);
    const chat = record.chat;
    const isOthers = record[field] !== others.reader;
    const isNew = record.timestamp > others.readAt(chat);
    if (chat === undefined || !isOthers || !isNew) continue;
    unread.set(chat, (unread.get(chat) ?? 0) + 1);
  }
};

const unreadOf = (replica, reader, readAt) => {
  const unread = new Map();
  for (const entity of TIMELINE) {
    for (const id of replica.keys(entity)) {
      const record = replica.get(id);
      const chat = containerOf(record);
      const isOthers = record.author !== reader;
      const isNew = record.timestamp > readAt(chat);
      const isShown = isOthers && isNew && !isDeleted(record);
      if (chat === undefined || !isShown) continue;
      unread.set(chat, (unread.get(chat) ?? 0) + 1);
    }
  }
  const others = { reader, readAt };
  countOthers(unread, replica, 'call', 'host', others);
  countOthers(unread, replica, 'recording', 'author', others);
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
  const entities = TIMELINE.concat(['call', 'recording']);
  for (const entity of entities) {
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
export { MAX_LENGTH, TEXT_LENGTH, QUOTE_LENGTH, MAX_FILE_SIZE, validate, seed };
export { pairOf, isPair, directUnit };
export { isFeed, isPost, containerOf, labelOf, parseTitle };
export { saveAuthor, createChannel, describe };
export { isAvatar };
export { createMessage, editMessage, deleteMessage, isDeleted };
export { createPost, startCall, endCall };
export { startRecording, stopRecording };
export { attachFile, setReaction, pin };
export { listChannels, listAuthors, activityOf };
export { threadsOf, lineageOf };
export { attachmentsOf, reactionsOf, unreadOf, filesOf };
