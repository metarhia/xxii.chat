import { REACTIONS, ICONS, CHANNELS, TIMELINE, GENERAL } from './chat.js';
import { MAX_LENGTH, TEXT_LENGTH, validate, seed } from './chat.js';
import { pairOf, isPair, directUnit } from './chat.js';
import { isFeed, isPost, containerOf, labelOf, parseTitle } from './chat.js';
import { saveAuthor, createChannel, describe } from './chat.js';
import { createFolder, setVisibility, placeItem } from './chat.js';
import { createMessage, createPost, react, pin } from './chat.js';
import { listChannels, listAuthors, folderTree } from './chat.js';
import { threadsOf, activityOf } from './chat.js';
import { Replica, Uplink } from './globalstorage.js';
import { generateUUID } from './metautil.js';
import { Mesh } from './mesh.js';
import { Application } from './application.js';

const TASKS = {
  cache: {
    label: '[update cache]',
    busy: '[updating...]',
    request: 'Cache update requested',
    done: 'Cache updated successfully',
    failed: 'Cache update failed',
  },
  clear: {
    label: '[clear database]',
    busy: '[clearing...]',
    request: 'Database clear requested',
    done: 'Database cleared successfully',
    failed: 'Database clear failed',
  },
};

const PANELS = {
  thread: 'Thread',
  post: 'POST DETAILS',
  pins: 'Pinned',
  members: 'Members',
  log: 'Log',
};

const SHORTCUTS = {
  f: (app) => app.toggleSearch(),
  p: (app) => app.togglePanel('pins'),
};

const NAV_ACTIONS = {
  add: (app, { folder }) => app.addToFolder(folder),
  visibility: (app, { folder }) => app.toggleVisibility(folder),
  remove: (app, { folder, item }) => app.removeFromFolder(folder, item),
};

const NEXT_VISIBILITY = { unlisted: 'public', public: 'unlisted' };

const STATES = {
  linked: 'webrtc',
  online: 'online',
  away: 'away',
  offline: 'offline',
  unknown: 'known author',
};

const STATUS_ORDER = ['linked', 'online', 'away', 'offline', 'unknown'];
const UNITS = ['chat', 'cache', 'presence', 'signal'];
const THREADS = ['thread', 'post'];
const PAGE_SIZE = 50;
const CHAT_KEY = 'xxii:chat';
const NICK_KEY = 'xxii:nick';
const PEER_KEY = 'xxii:peer';
const COLLAPSED_KEY = 'xxii:collapsed';
const HEADING = /^#{1,3}\s+(.+)$/;

const pad = (value) => `${value}`.padStart(2, '0');

const timeOf = (timestamp) => {
  const date = new Date(timestamp);
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
};

const dateOf = (timestamp) => {
  const date = new Date(timestamp);
  const day = `${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
  return `${date.getFullYear()}-${day} ${timeOf(timestamp)}`;
};

const dayOf = (timestamp) => {
  if (!timestamp) return '';
  const date = new Date(timestamp);
  const isToday = date.toDateString() === new Date().toDateString();
  if (isToday) return timeOf(timestamp);
  return `${pad(date.getDate())}.${pad(date.getMonth() + 1)}`;
};

const readSetting = (key, fallback) => {
  try {
    return localStorage.getItem(key) ?? fallback;
  } catch {
    return fallback;
  }
};

const writeSetting = (key, value) => {
  try {
    localStorage.setItem(key, value);
    return true;
  } catch {
    return false;
  }
};

const loadPeerId = () => {
  const saved = readSetting(PEER_KEY, '');
  if (saved) return saved;
  const id = generateUUID();
  writeSetting(PEER_KEY, id);
  return id;
};

const shortId = (peer) => `peer-${peer.slice(0, 6)}`;

const byStatus = (a, b) => {
  const order = STATUS_ORDER.indexOf(a.status) - STATUS_ORDER.indexOf(b.status);
  return order || (a.nick > b.nick ? 1 : -1);
};

const createContact = (peer) => ({
  peer,
  nick: '',
  status: 'unknown',
  time: 0,
});

const cloneTemplate = (template, selector) => {
  const fragment = template.content.cloneNode(true);
  return fragment.querySelector(selector);
};

const fillActions = (element, message) => {
  const buttons = element.querySelectorAll('.message-actions button');
  for (const button of buttons) button.dataset.id = message.id;
  const pinText = message.pinned ? '[unpin]' : '[pin]';
  element.querySelector('.pin-btn').textContent = pinText;
};

const fillPostHeader = (element, post) => {
  element.dataset.id = post.id;
  element.classList.toggle('pinned', post.pinned === true);
  element.querySelector('.title').textContent = post.title;
  element.querySelector('.nick').textContent = post.nick;
  element.querySelector('.date').textContent = dateOf(post.timestamp);
};

const setBadge = (badge, count) => {
  badge.textContent = count;
  badge.classList.toggle('hidden', count === 0);
};

const parseBlocks = (content = '') => {
  const blocks = [];
  for (const line of content.split('\n')) {
    const heading = line.match(HEADING);
    const last = blocks.at(-1);
    if (heading) blocks.push({ isHeading: true, text: heading[1].trim() });
    else if (last && !last.isHeading) last.text += `\n${line}`;
    else blocks.push({ isHeading: false, text: line });
  }
  return blocks.filter((block) => block.text.trim() !== '');
};

const excerptOf = (content) => {
  const blocks = parseBlocks(content);
  return blocks.map((block) => block.text.trim()).join(' ');
};

const readCollapsed = () => {
  const saved = readSetting(COLLAPSED_KEY, '');
  return new Set(saved.split(',').filter(Boolean));
};

class Logger {
  #output;

  constructor(outputId) {
    this.#output = document.getElementById(outputId);
  }

  log(...args) {
    const lines = args.map(Logger.#serialize);
    const timestamp = new Date().toISOString();
    this.#output.append(`[${timestamp}] ${lines.join(' ')}\n`);
    this.#output.scrollTop = this.#output.scrollHeight;
  }

  clear() {
    this.#output.textContent = '';
  }

  static #serialize(x) {
    return typeof x === 'object' ? JSON.stringify(x, null, 2) : x;
  }
}

class ChatApplication extends Application {
  constructor(config = {}) {
    super(config);
    this.peerId = loadPeerId();
    this.username = readSetting(NICK_KEY, '');
    this.syncTimeout = null;
    this.openedAt = Date.now();
    this.chat = readSetting(CHAT_KEY, GENERAL);
    this.limit = PAGE_SIZE;
    this.filter = '';
    this.panel = '';
    this.thread = '';
    this.paletteTarget = '';
    this.unread = new Map();
    this.collapsed = readCollapsed();
    this.isRenderScheduled = false;
    this.started = new Promise((resolve) => this.on('ready', resolve));
    this.replica = new Replica({ validate });
    this.uplink = null;
    this.directs = new Map();
    this.mesh = new Mesh(this);
    this.replica.on('log', (event) => this.showChanges(event, this.replica));
    this.replica.on('clear', () => this.resetView());
    this.mesh.on('peers', () => this.scheduleRender());
    this.mesh.on('links', () => this.showLinks());
    this.mesh.on('leader', () => this.logger.log('This tab runs the mesh'));
    this.mesh.on('error', (error) => this.logger.log('Mesh:', error.message));
    seed(this.replica);
    this.usernameInput.value = this.username;
    this.fillPalette();
    this.mesh.start();
    this.render();
  }

  getElements() {
    const byId = (id) => document.getElementById(id);
    this.app = document.querySelector('.app');
    this.sidebar = byId('sidebar');
    this.menuBtn = byId('menu-btn');
    this.installBtn = byId('install-btn');
    this.updateCacheBtn = byId('update-cache-btn');
    this.clearMessagesBtn = byId('clear-messages-btn');
    this.clearLogBtn = byId('clear-log-btn');
    this.connectionStatus = byId('connection-status');
    this.meshStatus = byId('mesh-status');
    this.peerCount = byId('peer-count');
    this.usernameInput = byId('username-input');
    this.contactList = byId('contact-list');
    this.contactsEmpty = byId('contacts-empty');
    this.feedList = byId('feed-list');
    this.feedForm = byId('feed-form');
    this.feedNameInput = byId('feed-name-input');
    this.chatList = byId('chat-list');
    this.chatForm = byId('chat-form');
    this.chatNameInput = byId('chat-name-input');
    this.folderList = byId('folder-list');
    this.folderForm = byId('folder-form');
    this.folderNameInput = byId('folder-name-input');
    this.chatTitle = byId('chat-title');
    this.chatInfo = byId('chat-info');
    this.topicForm = byId('topic-form');
    this.topicInput = byId('topic-input');
    this.searchBtn = byId('search-btn');
    this.pinsBtn = byId('pins-btn');
    this.membersBtn = byId('members-btn');
    this.logBtn = byId('log-btn');
    this.searchBar = byId('search-bar');
    this.searchInput = byId('search-input');
    this.chatMessages = byId('chat-messages');
    this.messageList = byId('message-list');
    this.loadMoreBtn = byId('load-more-btn');
    this.composer = byId('composer');
    this.messageInput = byId('message-input');
    this.composerInfo = byId('composer-info');
    this.emojiBtn = byId('emoji-btn');
    this.panelTitle = byId('panel-title');
    this.panelCloseBtn = byId('panel-close-btn');
    this.threadRoot = byId('thread-root');
    this.postInfo = byId('post-info');
    this.postReplies = byId('post-replies');
    this.postReactions = byId('post-reactions');
    this.outlineSection = byId('outline-section');
    this.postOutline = byId('post-outline');
    this.threadCount = byId('thread-count');
    this.threadReplies = byId('thread-replies');
    this.replyForm = byId('reply-form');
    this.replyInput = byId('reply-input');
    this.pinList = byId('pin-list');
    this.memberList = byId('member-list');
    this.palette = byId('palette');
    this.notification = byId('notification');
    this.contactTemplate = byId('contact-item-template');
    this.chatTemplate = byId('chat-item-template');
    this.folderTemplate = byId('folder-item-template');
    this.messageTemplate = byId('message-template');
    this.postTemplate = byId('post-template');
    this.articleTemplate = byId('article-template');
    this.threadTemplate = byId('thread-item-template');
    this.pinTemplate = byId('pin-item-template');
    this.memberTemplate = byId('member-item-template');
    this.reactionTemplate = byId('reaction-button-template');
  }

  setupEvents() {
    const onEnter = (input, action) => {
      input.addEventListener('keydown', (event) => {
        if (event.key !== 'Enter' || event.shiftKey) return;
        event.preventDefault();
        action();
      });
    };
    const onSubmit = (form, action) => {
      form.addEventListener('submit', (event) => {
        event.preventDefault();
        action();
      });
    };

    this.menuBtn.onclick = () => this.app.classList.toggle('menu-open');
    this.installBtn.onclick = () => this.install();
    this.updateCacheBtn.onclick = () => this.updateCache();
    this.clearMessagesBtn.onclick = () => this.clearDatabase();
    this.clearLogBtn.onclick = () => this.logger.clear();
    this.searchBtn.onclick = () => this.toggleSearch();
    this.pinsBtn.onclick = () => this.togglePanel('pins');
    this.membersBtn.onclick = () => this.togglePanel('members');
    this.logBtn.onclick = () => this.togglePanel('log');
    this.panelCloseBtn.onclick = () => this.closePanel();
    this.loadMoreBtn.onclick = () => this.loadOlder();
    this.emojiBtn.onclick = () => this.openPalette(this.emojiBtn, '');

    this.searchInput.addEventListener('input', () => {
      this.filter = this.searchInput.value.trim().toLowerCase();
      this.renderMessages();
    });
    onSubmit(this.feedForm, () => this.addChannel('feed', this.feedNameInput));
    onSubmit(this.chatForm, () => this.addChannel('chat', this.chatNameInput));
    onSubmit(this.folderForm, () => this.addFolders());
    onSubmit(this.topicForm, () => this.saveDescription());
    onSubmit(this.composer, () => this.submit());
    onSubmit(this.replyForm, () => this.submitReply());
    onEnter(this.replyInput, () => this.submitReply());
    this.messageInput.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter' || !this.isSendKey(event)) return;
      event.preventDefault();
      this.submit();
    });
    this.chatInfo.onclick = () => this.editDescription();
    this.topicInput.addEventListener('blur', () => this.closeDescription());

    this.sidebar.addEventListener('click', (event) => {
      this.handleNavClick(event);
    });
    this.memberList.addEventListener('click', (event) => {
      const item = event.target.closest('.member[data-peer]');
      if (item) this.selectDirect(item.dataset.peer);
    });
    const onMessageClick = (event) => this.handleMessageClick(event);
    this.messageList.addEventListener('click', onMessageClick);
    this.threadRoot.addEventListener('click', onMessageClick);
    this.threadReplies.addEventListener('click', onMessageClick);
    this.pinList.addEventListener('click', (event) => this.handlePin(event));
    this.postOutline.addEventListener('click', (event) => {
      const button = event.target.closest('button');
      if (button) this.scrollToHeading(button.dataset.heading);
    });
    this.palette.addEventListener('click', (event) => {
      const button = event.target.closest('button');
      if (button) this.choose(button.dataset.reaction);
    });
    this.usernameInput.addEventListener('blur', () => this.syncUsername());
    this.usernameInput.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') this.syncUsername();
    });
    document.addEventListener('keydown', (event) => this.handleKey(event));
    document.addEventListener('click', (event) => {
      const isPalette = event.target.closest(
        '#palette, .react-btn, #emoji-btn',
      );
      if (!isPalette) this.closePalette();
    });

    this.on('ready', () => this.startSync());
    this.on('status', ({ connected }) => this.showStatus(connected));
    this.on('network', () => this.updateInterface());
    this.on('install', () => this.showInstallButton(true));
    this.on('installed', () => this.showInstallButton(false));

    document.addEventListener('visibilitychange', () => {
      if (document.hidden) this.syncUsername();
    });
    window.addEventListener('beforeunload', () => this.syncUsername());
    window.addEventListener('pagehide', () => this.mesh.stop());
  }

  async startSync() {
    const options = { unit: 'chat', name: 'worker', clear: 'follow' };
    this.uplink = new Uplink(this.replica, this.metacom, options);
    this.uplink.on('error', (error) => {
      this.logger.log('Sync with worker failed:', error.message);
    });
    this.uplink.start();
    this.api.chat.on('username', (username) => this.showUsername(username));
    this.api.chat.on('direct', ({ pair }) => this.restoreDirect(pair));
    try {
      await this.uplink.sync();
      this.saveAuthor();
      const pairs = await this.api.chat.directs();
      for (const pair of pairs) this.restoreDirect(pair);
      await this.mesh.attach();
    } catch (error) {
      this.report(error);
    }
  }

  peerOf(pair) {
    if (!isPair(pair)) return '';
    const ids = pair.split('_');
    if (ids[0] === this.peerId) return ids[1];
    if (ids[1] === this.peerId) return ids[0];
    return '';
  }

  restoreDirect(pair) {
    const peer = this.peerOf(pair);
    if (peer) this.openDirect(peer).catch((error) => this.report(error));
  }

  openDirect(peer) {
    const pair = pairOf(this.peerId, peer);
    const existing = this.directs.get(pair);
    if (existing) return existing.ready;
    const replica = new Replica({ validate });
    const direct = { pair, peer, replica, uplink: null, ready: null };
    replica.on('log', (event) => this.showChanges(event, replica));
    replica.on('clear', () => this.scheduleRender());
    this.directs.set(pair, direct);
    direct.ready = this.connectDirect(direct);
    this.scheduleRender();
    return direct.ready;
  }

  async connectDirect(direct) {
    await this.started;
    const { pair, replica } = direct;
    await this.api.chat.openDirect({ pair });
    const unit = directUnit(pair);
    await this.metacom.load(unit);
    const options = { unit, name: 'worker', clear: 'follow' };
    direct.uplink = new Uplink(replica, this.metacom, options);
    direct.uplink.on('error', (error) => {
      this.logger.log('Direct chat sync failed:', error.message);
    });
    direct.uplink.start();
    return direct;
  }

  replicaOf(chat) {
    if (!isPair(chat)) return this.replica;
    const peer = this.peerOf(chat);
    if (!peer) return this.replica;
    if (!this.directs.has(chat)) {
      this.openDirect(peer).catch((error) => this.report(error));
    }
    return this.directs.get(chat).replica;
  }

  uplinkOf(chat) {
    if (!isPair(chat)) return this.uplink;
    return this.directs.get(chat)?.uplink ?? null;
  }

  saveAuthor() {
    if (!this.username) return;
    const author = this.replica.get(this.peerId);
    if (author?.nick === this.username) return;
    saveAuthor(this.replica, this.peerId, this.username);
  }

  showChanges({ deltas, origin }, replica) {
    const source = origin || 'this tab';
    if (deltas.length > 1) {
      this.logger.log(`Synced ${deltas.length} changes from ${source}`);
    } else {
      const { entity, target, data } = deltas[0];
      const kind = data.reactions ? 'reaction' : entity;
      this.logger.log(`New ${kind} from ${source}:`, target);
    }
    if (origin) this.countUnread(deltas, replica);
    this.scheduleRender();
  }

  countUnread(deltas, replica) {
    for (const { entity, target, data } of deltas) {
      const isCreated = TIMELINE.includes(entity) && data.timestamp;
      if (!isCreated) continue;
      const record = replica.get(target);
      const chat = containerOf(record);
      const isOld = record.timestamp <= this.openedAt;
      const isMine = record.author === this.peerId;
      const isOpen = chat === this.chat;
      if (isOld || isMine || isOpen) continue;
      this.unread.set(chat, this.unreadOf(chat) + 1);
    }
  }

  unreadOf(chat) {
    return this.unread.get(chat) ?? 0;
  }

  resetView() {
    this.logger.log('Local copy cleared');
    this.unread.clear();
    seed(this.replica);
    this.chat = GENERAL;
    this.thread = '';
    writeSetting(CHAT_KEY, GENERAL);
    this.saveAuthor();
    this.scheduleRender();
  }

  scheduleRender() {
    if (this.isRenderScheduled) return;
    this.isRenderScheduled = true;
    requestAnimationFrame(() => {
      this.isRenderScheduled = false;
      this.render();
    });
  }

  render() {
    this.renderContacts();
    this.renderChannels();
    this.renderMessages();
    this.renderPanel();
  }

  listContacts() {
    const contacts = new Map();
    const contactOf = (peer) => {
      const contact = contacts.get(peer) ?? createContact(peer);
      contacts.set(peer, contact);
      return contact;
    };
    for (const author of listAuthors(this.replica)) {
      contactOf(author.id).nick = author.nick;
    }
    for (const entry of this.mesh.peers.values()) {
      const contact = contactOf(entry.peer);
      contact.nick = entry.nick;
      contact.status = entry.status;
      contact.time = entry.seen;
    }
    for (const direct of this.directs.values()) {
      const contact = contactOf(direct.peer);
      const last = activityOf(direct.replica).get(direct.pair) ?? 0;
      if (last > 0) contact.time = last;
    }
    for (const link of this.mesh.links.values()) {
      if (link.connected) contactOf(link.remote).status = 'linked';
    }
    contacts.delete(this.peerId);
    for (const contact of contacts.values()) {
      if (!contact.nick) contact.nick = shortId(contact.peer);
    }
    return Array.from(contacts.values()).toSorted(byStatus);
  }

  renderContacts() {
    const contacts = this.listContacts();
    const online = contacts.filter((contact) => contact.status !== 'offline');
    const reachable = online.filter((contact) => contact.status !== 'unknown');
    this.peerCount.textContent = reachable.length;
    const items = contacts.map((contact) => this.createContactItem(contact));
    this.contactList.replaceChildren(...items);
    this.contactsEmpty.classList.toggle('hidden', items.length > 0);
  }

  createContactItem(contact) {
    const item = cloneTemplate(this.contactTemplate, '.contact-item');
    const pair = pairOf(this.peerId, contact.peer);
    item.dataset.peer = contact.peer;
    item.classList.toggle('active', pair === this.chat);
    item.querySelector('.dot').dataset.status = contact.status;
    item.querySelector('.dot').title = STATES[contact.status];
    item.querySelector('.name').textContent = contact.nick;
    item.querySelector('.time').textContent = dayOf(contact.time);
    setBadge(item.querySelector('.badge'), this.unreadOf(pair));
    return item;
  }

  renderChannels() {
    const activity = activityOf(this.replica);
    const tree = folderTree(this.replica, this.peerId);
    const channels = new Map();
    const placed = new Set();
    for (const items of tree.items.values()) {
      for (const item of items) placed.add(item);
    }
    const lists = { feed: [], chat: [] };
    for (const entity of CHANNELS) {
      for (const channel of listChannels(this.replica, entity)) {
        channels.set(channel.id, channel);
        if (placed.has(channel.id)) continue;
        lists[entity].push(this.createChannelItem(channel, activity, null));
      }
    }
    this.feedList.replaceChildren(...lists.feed);
    this.chatList.replaceChildren(...lists.chat);
    const nav = { activity, tree, channels };
    const roots = tree.children.get('') ?? [];
    const folders = roots.map((folder) => this.createFolderItem(folder, nav));
    this.folderList.replaceChildren(...folders);
  }

  createChannelItem(channel, activity, folder) {
    const item = cloneTemplate(this.chatTemplate, '.chat-item');
    const time = activity.get(channel.id) ?? channel.created;
    item.dataset.id = channel.id;
    item.classList.toggle('active', channel.id === this.chat);
    item.querySelector('.icon').textContent = channel.icon ?? ICONS.chat;
    item.querySelector('.name').textContent = labelOf(channel);
    item.querySelector('.time').textContent = dayOf(time);
    setBadge(item.querySelector('.badge'), this.unreadOf(channel.id));
    const isRemovable = folder?.owner === this.peerId;
    const remove = item.querySelector('.remove-btn');
    remove.classList.toggle('hidden', !isRemovable);
    if (!isRemovable) return item;
    remove.dataset.folder = folder.id;
    remove.dataset.item = channel.id;
    return item;
  }

  createFolderItem(folder, nav) {
    const element = cloneTemplate(this.folderTemplate, '.folder');
    const row = element.querySelector('.folder-row');
    const visibility = folder.visibility ?? 'unlisted';
    const isOwn = folder.owner === this.peerId;
    row.dataset.folder = folder.id;
    element.classList.toggle('open', !this.collapsed.has(folder.id));
    row.querySelector('.icon').textContent = folder.icon ?? ICONS.folder;
    row.querySelector('.name').textContent = folder.name;
    row.querySelector('.folder-actions').classList.toggle('hidden', !isOwn);
    for (const button of row.querySelectorAll('[data-action]')) {
      button.dataset.folder = folder.id;
    }
    const toggle = row.querySelector('[data-action="visibility"]');
    toggle.textContent = `[${visibility}]`;
    setBadge(row.querySelector('.badge'), this.unreadIn(folder.id, nav));
    const subfolders = nav.tree.children.get(folder.id) ?? [];
    const placed = nav.tree.items.get(folder.id) ?? new Set();
    const children = subfolders.map((child) =>
      this.createFolderItem(child, nav),
    );
    for (const channel of nav.channels.values()) {
      if (!placed.has(channel.id)) continue;
      children.push(this.createChannelItem(channel, nav.activity, folder));
    }
    element.querySelector('.folder-items').replaceChildren(...children);
    return element;
  }

  unreadIn(folder, nav) {
    let count = 0;
    for (const item of nav.tree.items.get(folder) ?? []) {
      count += this.unreadOf(item);
    }
    for (const child of nav.tree.children.get(folder) ?? []) {
      count += this.unreadIn(child.id, nav);
    }
    return count;
  }

  currentView() {
    const replica = this.replicaOf(this.chat);
    return { replica, ...threadsOf(replica, this.chat) };
  }

  renderMessages() {
    const box = this.chatMessages;
    const distance = box.scrollHeight - box.scrollTop - box.clientHeight;
    const isAtBottom = distance < 40;
    const { roots, replies } = this.currentView();
    const matched = this.filter
      ? roots.filter((message) => this.isMatch(message))
      : roots;
    const visible = matched.slice(-this.limit);
    const elements = visible.map((message) => {
      const count = replies.get(message.id)?.length ?? 0;
      if (isPost(message)) return this.createPostCard(message, count);
      return this.createMessage(message, count);
    });
    this.messageList.replaceChildren(...elements);
    this.loadMoreBtn.classList.toggle('hidden', matched.length <= this.limit);
    this.renderHeader(roots);
    if (isAtBottom) box.scrollTop = box.scrollHeight;
  }

  isMatch(message) {
    const { nick, title = '', content } = message;
    const text = `${nick} ${title} ${content}`.toLowerCase();
    return text.includes(this.filter);
  }

  channelEntity() {
    return isFeed(this.replica, this.chat) ? 'feed' : 'chat';
  }

  chatName() {
    if (!isPair(this.chat)) {
      const entity = this.channelEntity();
      const name = this.replica.get(this.chat)?.name ?? this.chat;
      return labelOf({ entity, name });
    }
    const peer = this.peerOf(this.chat);
    const contact = this.listContacts().find((item) => item.peer === peer);
    return `@${contact?.nick ?? shortId(peer)}`;
  }

  chatDescription(roots) {
    if (!isPair(this.chat)) {
      const description = this.replica.get(this.chat)?.description;
      if (description) return description;
      const noun = this.channelEntity() === 'feed' ? 'posts' : 'messages';
      const authors = new Set(roots.map((message) => message.author));
      return `${roots.length} ${noun}, ${authors.size} authors`;
    }
    const peer = this.peerOf(this.chat);
    const link = this.mesh.links.get(peer);
    if (link?.connected) return 'direct messages over webrtc: linked';
    const via = this.mesh.isLeader ? 'waiting for peer' : 'via leader tab';
    return `direct messages over webrtc: ${via}`;
  }

  renderHeader(roots) {
    const name = this.chatName();
    const isFeedOpen = this.channelEntity() === 'feed';
    this.chatTitle.textContent = name;
    this.chatInfo.textContent = this.chatDescription(roots);
    this.chatInfo.classList.toggle('editable', this.canDescribe());
    const noun = isFeedOpen ? 'post' : 'message';
    this.messageInput.placeholder = `> new ${noun} to ${name}`;
    this.messageInput.maxLength = isFeedOpen ? TEXT_LENGTH : MAX_LENGTH;
    const nick = this.username ? `@${this.username}` : 'set your nick first';
    const hint = isFeedOpen ? ', first line is the title, Ctrl+Enter' : '';
    this.composerInfo.textContent = `${nick}${hint}`;
  }

  createMessage(message, replyCount) {
    const element = cloneTemplate(this.messageTemplate, '.message');
    element.dataset.id = message.id;
    element.classList.toggle('pinned', message.pinned === true);
    element.querySelector('.time').textContent = timeOf(message.timestamp);
    element.querySelector('.author').textContent = message.nick;
    element.querySelector('.content').textContent = message.content;
    this.fillReactions(element.querySelector('.reactions'), message);
    const replies = element.querySelector('.replies');
    replies.dataset.id = message.id;
    replies.classList.toggle('hidden', replyCount === 0);
    replies.querySelector('.count').textContent = `${replyCount} replies`;
    fillActions(element, message);
    return element;
  }

  createPostCard(post, replyCount) {
    const element = cloneTemplate(this.postTemplate, '.post');
    fillPostHeader(element, post);
    element.querySelector('.excerpt').textContent = excerptOf(post.content);
    const replies = element.querySelector('.replies');
    replies.dataset.id = post.id;
    replies.querySelector('.count').textContent = `${replyCount} replies`;
    this.fillReactions(element.querySelector('.reactions'), post);
    fillActions(element, post);
    return element;
  }

  createArticle(post) {
    const element = cloneTemplate(this.articleTemplate, '.post-article');
    fillPostHeader(element, post);
    const blocks = parseBlocks(post.content);
    const nodes = [];
    for (let i = 0; i < blocks.length; i++) {
      const { isHeading, text } = blocks[i];
      const node = document.createElement(isHeading ? 'h4' : 'p');
      node.textContent = text.trim();
      if (isHeading) node.dataset.heading = i;
      nodes.push(node);
    }
    element.querySelector('.post-text').replaceChildren(...nodes);
    this.fillReactions(element.querySelector('.reactions'), post);
    fillActions(element, post);
    return element;
  }

  fillReactions(container, message) {
    for (const reaction in REACTIONS) {
      const count = message.reactions?.[reaction] ?? 0;
      if (count === 0) continue;
      container.append(this.createReaction(message.id, reaction, count));
    }
  }

  createReaction(messageId, reaction, count) {
    const button = cloneTemplate(this.reactionTemplate, '.reaction');
    button.dataset.messageId = messageId;
    button.dataset.reaction = reaction;
    button.dataset.count = count;
    button.querySelector('.emoji').textContent = REACTIONS[reaction];
    button.querySelector('.count').textContent = count;
    return button;
  }

  handleMessageClick(event) {
    const button = event.target.closest('button');
    const card = event.target.closest('.post');
    if (!button && card) return void this.openThread(card.dataset.id);
    if (!button) return;
    const { id } = button.dataset;
    if (button.classList.contains('reaction')) {
      return void this.addReaction(button.dataset);
    }
    if (button.classList.contains('react-btn')) {
      return void this.openPalette(button, id);
    }
    if (button.classList.contains('pin-btn')) return void this.togglePin(id);
    const isThread = button.matches('.reply-btn, .replies');
    if (isThread) this.openThread(id);
  }

  handlePin(event) {
    const item = event.target.closest('.pin-item');
    if (!item) return;
    const { id, root } = item.dataset;
    const isUnpin = event.target.closest('.unpin-btn');
    if (isUnpin) return void this.togglePin(id);
    this.openThread(root);
  }

  renderPanel() {
    this.app.dataset.panel = this.panel;
    if (!this.panel) return;
    this.panelTitle.textContent = PANELS[this.panel];
    if (THREADS.includes(this.panel)) this.renderThread();
    else if (this.panel === 'pins') this.renderPins();
    else if (this.panel === 'members') this.renderMembers();
  }

  renderThread() {
    const { replica, replies } = this.currentView();
    const root = replica.get(this.thread);
    const isShown = root !== null && containerOf(root) === this.chat;
    const isPostShown = isShown && isPost(root);
    this.postInfo.classList.toggle('hidden', !isPostShown);
    if (!isShown) {
      const empty = document.createElement('p');
      empty.className = 'empty';
      empty.textContent = 'Choose [reply] on a message to open its thread';
      this.threadRoot.replaceChildren(empty);
      this.threadReplies.replaceChildren();
      this.threadCount.textContent = '0 replies';
      return;
    }
    const thread = replies.get(this.thread) ?? [];
    const message = { id: this.thread, ...root };
    const head = isPostShown
      ? this.createArticle(message)
      : this.createThreadItem(message);
    this.threadRoot.replaceChildren(head);
    if (isPostShown) this.renderPostInfo(message, thread.length);
    this.threadCount.textContent = `${thread.length} replies`;
    const items = thread.map((reply) => this.createThreadItem(reply));
    this.threadReplies.replaceChildren(...items);
  }

  renderPostInfo(post, replyCount) {
    const reactions = [];
    for (const reaction in REACTIONS) {
      const count = post.reactions?.[reaction] ?? 0;
      if (count > 0) reactions.push(`${REACTIONS[reaction]} ${count}`);
    }
    this.postReplies.textContent = replyCount;
    this.postReactions.textContent = reactions.join('  ') || 'none';
    const blocks = parseBlocks(post.content);
    const outline = [];
    for (let i = 0; i < blocks.length; i++) {
      if (!blocks[i].isHeading) continue;
      const button = document.createElement('button');
      button.className = 'link-btn';
      button.dataset.heading = i;
      button.textContent = `→ ${blocks[i].text}`;
      outline.push(button);
    }
    this.postOutline.replaceChildren(...outline);
    this.outlineSection.classList.toggle('hidden', outline.length === 0);
  }

  scrollToHeading(index) {
    const selector = `[data-heading="${index}"]`;
    const heading = this.threadRoot.querySelector(selector);
    heading?.scrollIntoView({ block: 'start', behavior: 'smooth' });
  }

  createThreadItem(message) {
    const element = cloneTemplate(this.threadTemplate, '.thread-item');
    const time = timeOf(message.timestamp);
    element.dataset.id = message.id;
    element.classList.toggle('pinned', message.pinned === true);
    element.querySelector('.who').textContent = `${message.nick} at ${time}:`;
    element.querySelector('.text').textContent = message.content;
    this.fillReactions(element.querySelector('.reactions'), message);
    fillActions(element, message);
    return element;
  }

  renderPins() {
    const { roots, replies } = this.currentView();
    const messages = [];
    for (const root of roots) {
      if (root.pinned) messages.push(root);
      for (const reply of replies.get(root.id) ?? []) {
        if (reply.pinned) messages.push(reply);
      }
    }
    const items = messages.map((message) => this.createPinItem(message));
    if (items.length === 0) {
      const empty = document.createElement('p');
      empty.className = 'empty';
      empty.textContent = 'No pinned messages in this chat';
      items.push(empty);
    }
    this.pinList.replaceChildren(...items);
  }

  createPinItem(message) {
    const element = cloneTemplate(this.pinTemplate, '.pin-item');
    const time = timeOf(message.timestamp);
    element.dataset.id = message.id;
    element.dataset.root = message.replyTo ?? message.id;
    element.querySelector('.who').textContent = `${message.nick} at ${time}:`;
    element.querySelector('.text').textContent =
      message.title ?? message.content;
    return element;
  }

  renderMembers() {
    const self = createContact(this.peerId);
    self.nick = this.username || 'you';
    self.status = this.connected || this.mesh.linked > 0 ? 'online' : 'offline';
    const role = this.mesh.isLeader ? 'mesh tab' : 'follower tab';
    const items = [this.createMember(self, `you, ${role}`)];
    for (const contact of this.listContacts()) {
      const state = STATES[contact.status];
      const seen = contact.time ? `, ${dayOf(contact.time)}` : '';
      items.push(this.createMember(contact, `${state}${seen}`));
    }
    this.memberList.replaceChildren(...items);
  }

  createMember(contact, state) {
    const item = cloneTemplate(this.memberTemplate, '.member');
    if (contact.peer !== this.peerId) item.dataset.peer = contact.peer;
    item.querySelector('.dot').dataset.status = contact.status;
    item.querySelector('.name').textContent = contact.nick;
    item.querySelector('.state').textContent = state;
    return item;
  }

  togglePanel(name) {
    if (this.panel === name) return void this.closePanel();
    this.panel = name;
    this.renderPanel();
  }

  closePanel() {
    this.panel = '';
    this.renderPanel();
  }

  openThread(id) {
    const root = this.recordOf(id);
    const isPostRoot = root !== null && isPost(root);
    this.thread = id;
    this.panel = isPostRoot ? 'post' : 'thread';
    this.renderPanel();
    if (isPostRoot) this.threadRoot.parentElement.scrollTop = 0;
    else this.replyInput.focus();
  }

  fillPalette() {
    const buttons = [];
    for (const reaction in REACTIONS) {
      const button = document.createElement('button');
      button.type = 'button';
      button.dataset.reaction = reaction;
      button.textContent = REACTIONS[reaction];
      buttons.push(button);
    }
    this.palette.replaceChildren(...buttons);
  }

  openPalette(anchor, messageId) {
    this.paletteTarget = messageId;
    const rect = anchor.getBoundingClientRect();
    this.palette.classList.remove('hidden');
    const width = this.palette.offsetWidth;
    const left = Math.min(rect.left, window.innerWidth - width - 8);
    const top = rect.top - this.palette.offsetHeight - 4;
    this.palette.style.left = `${Math.max(8, left)}px`;
    this.palette.style.top = `${Math.max(8, top)}px`;
  }

  closePalette() {
    this.palette.classList.add('hidden');
    this.paletteTarget = '';
  }

  choose(reaction) {
    const messageId = this.paletteTarget;
    this.closePalette();
    if (messageId) return void this.addReaction({ messageId, reaction });
    const input = this.messageInput;
    const position = input.selectionStart ?? input.value.length;
    const before = input.value.slice(0, position);
    const after = input.value.slice(position);
    input.value = `${before}${REACTIONS[reaction]}${after}`;
    input.focus();
  }

  handleKey(event) {
    if (event.key === 'Escape') return void this.closeTop();
    const isCommand = event.ctrlKey || event.metaKey;
    if (!isCommand) return;
    const shortcut = SHORTCUTS[event.key.toLowerCase()];
    if (!shortcut) return;
    event.preventDefault();
    shortcut(this);
  }

  closeTop() {
    const isPaletteOpen = !this.palette.classList.contains('hidden');
    if (isPaletteOpen) return void this.closePalette();
    const isTopicOpen = !this.topicForm.classList.contains('hidden');
    if (isTopicOpen) return void this.closeDescription();
    const isSearchOpen = !this.searchBar.classList.contains('hidden');
    if (isSearchOpen) return void this.toggleSearch();
    if (this.panel) return void this.closePanel();
    this.app.classList.remove('menu-open');
  }

  selectChat(id) {
    this.chat = id;
    this.limit = PAGE_SIZE;
    this.unread.delete(id);
    writeSetting(CHAT_KEY, id);
    this.app.classList.remove('menu-open');
    if (THREADS.includes(this.panel)) this.panel = '';
    this.thread = '';
    this.closeDescription();
    this.render();
    this.chatMessages.scrollTop = this.chatMessages.scrollHeight;
    this.messageInput.focus();
  }

  selectDirect(peer) {
    const pair = pairOf(this.peerId, peer);
    this.openDirect(peer).catch((error) => this.report(error));
    this.selectChat(pair);
  }

  loadOlder() {
    const box = this.chatMessages;
    const fromBottom = box.scrollHeight - box.scrollTop;
    this.limit += PAGE_SIZE;
    this.renderMessages();
    box.scrollTop = box.scrollHeight - fromBottom;
  }

  toggleSearch() {
    const isHidden = this.searchBar.classList.toggle('hidden');
    if (!isHidden) return void this.searchInput.focus();
    this.searchInput.value = '';
    this.filter = '';
    this.renderMessages();
  }

  handleNavClick(event) {
    const action = event.target.closest('[data-action]');
    if (action) {
      const { dataset } = action;
      return void NAV_ACTIONS[dataset.action](this, dataset);
    }
    const item = event.target.closest('.nav-item');
    if (!item) return;
    const { peer, folder, id } = item.dataset;
    if (peer) return void this.selectDirect(peer);
    if (folder) return void this.toggleFolder(folder);
    if (id) this.selectChat(id);
  }

  addChannel(entity, input) {
    if (!input.value.trim()) return;
    const { icon, name } = parseTitle(input.value, entity);
    const id = generateUUID();
    const owner = this.peerId;
    const created = Date.now();
    createChannel(this.replica, entity, { id, name, icon, owner, created });
    input.value = '';
    this.logger.log(`Created ${entity}:`, name);
    this.selectChat(id);
  }

  addFolders() {
    const path = this.folderNameInput.value.split('/');
    const names = path.map((name) => name.trim()).filter(Boolean);
    if (names.length === 0) return;
    const { children } = folderTree(this.replica, this.peerId);
    let parent = '';
    for (const text of names) {
      const { icon, name } = parseTitle(text, 'folder');
      const siblings = children.get(parent) ?? [];
      const existing = siblings.find((folder) => folder.name === name);
      this.collapsed.delete(parent);
      if (existing) {
        parent = existing.id;
        continue;
      }
      const id = generateUUID();
      const owner = this.peerId;
      const created = Date.now();
      const folder = { id, name, icon, owner, parent, created };
      createFolder(this.replica, folder);
      this.logger.log('Created folder:', name);
      parent = id;
    }
    this.folderNameInput.value = '';
    this.saveCollapsed();
  }

  addToFolder(folder) {
    if (isPair(this.chat)) {
      const text = 'Direct messages stay in contacts';
      return void this.showNotification(text, 'warning');
    }
    const { items } = folderTree(this.replica, this.peerId);
    if (items.get(folder)?.has(this.chat)) return;
    placeItem(this.replica, folder, this.chat, true);
    this.collapsed.delete(folder);
    this.saveCollapsed();
  }

  removeFromFolder(folder, item) {
    placeItem(this.replica, folder, item, false);
  }

  toggleVisibility(id) {
    const folder = this.replica.get(id);
    if (folder?.owner !== this.peerId) return;
    const visibility = NEXT_VISIBILITY[folder.visibility ?? 'unlisted'];
    setVisibility(this.replica, id, visibility);
    this.logger.log(`Folder ${folder.name} is now ${visibility}`);
  }

  toggleFolder(id) {
    if (this.collapsed.has(id)) this.collapsed.delete(id);
    else this.collapsed.add(id);
    this.saveCollapsed();
    this.renderChannels();
  }

  saveCollapsed() {
    const ids = Array.from(this.collapsed).join(',');
    writeSetting(COLLAPSED_KEY, ids);
  }

  canDescribe() {
    if (isPair(this.chat)) return false;
    const channel = this.replica.get(this.chat);
    if (!channel) return false;
    return !channel.owner || channel.owner === this.peerId;
  }

  editDescription() {
    if (!this.canDescribe()) return;
    const { description = '' } = this.replica.get(this.chat);
    this.topicInput.value = description;
    this.chatInfo.classList.add('hidden');
    this.topicForm.classList.remove('hidden');
    this.topicInput.focus();
  }

  saveDescription() {
    const description = this.topicInput.value.trim();
    if (this.canDescribe()) {
      const entity = this.channelEntity();
      describe(this.replica, entity, this.chat, description);
    }
    this.closeDescription();
  }

  closeDescription() {
    this.topicForm.classList.add('hidden');
    this.chatInfo.classList.remove('hidden');
  }

  syncUsername() {
    const username = this.usernameInput.value.trim();
    if (!username || username === this.username) return;
    this.username = username;
    writeSetting(NICK_KEY, username);
    this.saveAuthor();
    this.announce();
    this.scheduleRender();
    if (this.syncTimeout) clearTimeout(this.syncTimeout);
    this.syncTimeout = setTimeout(() => {
      const { username } = this;
      this.api?.chat
        .username({ username })
        .catch((error) => this.report(error));
      this.logger.log('Username auto-synced:', username);
    }, this.config.syncTimeout);
  }

  showUsername(username) {
    this.username = username;
    this.usernameInput.value = username;
    writeSetting(NICK_KEY, username);
    this.announce();
    this.scheduleRender();
    this.logger.log('Username updated from other tab:', username);
  }

  announce() {
    this.mesh
      .announce()
      .then((list) => this.mesh.update(list))
      .catch((error) => this.logger.log('Announce failed:', error.message));
  }

  hasNick() {
    this.syncUsername();
    if (this.username) return true;
    this.showNotification('Please enter your nick', 'warning');
    this.usernameInput.focus();
    return false;
  }

  isSendKey(event) {
    if (this.channelEntity() !== 'feed') return !event.shiftKey;
    return event.ctrlKey || event.metaKey;
  }

  writePost(text) {
    const lines = text.split('\n');
    const id = generateUUID();
    const feed = this.chat;
    const author = this.peerId;
    const nick = this.username;
    const title = lines[0].trim();
    const content = lines.slice(1).join('\n').trim();
    const timestamp = Date.now();
    const post = { id, feed, author, nick, title, content, timestamp };
    createPost(this.replica, post);
    return id;
  }

  writeMessage(content, replyTo) {
    const { chat } = this;
    const replica = this.replicaOf(chat);
    const id = generateUUID();
    const author = this.peerId;
    const nick = this.username;
    const timestamp = Date.now();
    const message = { id, chat, author, nick, content, timestamp, replyTo };
    createMessage(replica, message);
    return id;
  }

  submit() {
    this.sendMessage().catch((error) => this.report(error));
  }

  async sendMessage() {
    const content = this.messageInput.value.trim();
    if (!content || !this.hasNick()) return;
    this.messageInput.value = '';
    if (this.channelEntity() === 'feed') this.writePost(content);
    else this.writeMessage(content, '');
    this.chatMessages.scrollTop = this.chatMessages.scrollHeight;
    await this.reportDelivery(content);
  }

  submitReply() {
    this.sendReply().catch((error) => this.report(error));
  }

  async sendReply() {
    const content = this.replyInput.value.trim();
    if (!content || !this.thread || !this.hasNick()) return;
    this.replyInput.value = '';
    this.writeMessage(content, this.thread);
    await this.reportDelivery(content);
  }

  async reportDelivery(content) {
    const uplink = this.uplinkOf(this.chat);
    const isSaved = uplink ? await uplink.flush() : false;
    if (isPair(this.chat)) return void this.reportDirect(content, isSaved);
    if (isSaved && this.connected) {
      this.logger.log('Sent message:', content);
    } else if (this.mesh.linked > 0) {
      this.logger.log('Sent to peers, queued for the server:', content);
      this.showNotification('Sent to peers, queued for the server');
    } else {
      this.logger.log('Message queued (offline):', content);
      this.showNotification('Message queued - will send when online');
    }
  }

  reportDirect(content, isSaved) {
    const peer = this.peerOf(this.chat);
    const isLinked = this.mesh.links.get(peer)?.connected === true;
    if (isLinked) return void this.logger.log('Sent over WebRTC:', content);
    const where = isSaved ? 'saved locally' : 'queued in this tab';
    this.logger.log(`Direct message ${where}, waiting for peer:`, content);
    this.showNotification('Direct message waits until the peer is reachable');
  }

  recordOf(id) {
    const record = this.replicaOf(this.chat).get(id);
    return record ? { id, ...record } : null;
  }

  addReaction({ messageId, reaction }) {
    const record = this.recordOf(messageId);
    if (!record) return;
    react(this.replicaOf(this.chat), record, reaction);
    this.logger.log('Added reaction:', reaction, 'to message:', messageId);
  }

  togglePin(id) {
    const record = this.recordOf(id);
    if (!record) return;
    pin(this.replicaOf(this.chat), record, record.pinned !== true);
  }

  showLinks() {
    this.updateInterface();
    this.scheduleRender();
  }

  updateInterface() {
    const linked = this.mesh?.linked ?? 0;
    let link = 'offline';
    if (this.connected) link = 'server';
    else if (linked > 0) link = 'p2p';
    this.connectionStatus.textContent = link;
    this.connectionStatus.className = `status ${link}`;
    const isLeader = this.mesh?.isLeader === true;
    const mesh = isLeader ? `rtc: ${linked} linked` : 'rtc: via leader tab';
    this.meshStatus.textContent = this.online ? mesh : 'network offline';
  }

  showStatus(connected) {
    const text = connected ? 'Server connected' : 'Server disconnected';
    this.logger.log(text);
    this.showNotification(text, connected ? 'info' : 'warning');
    this.updateInterface();
    this.mesh.serverChanged();
  }

  report(error) {
    this.logger.log('Request failed:', error.message);
    this.showNotification('Request failed', 'error');
  }

  async runTask(button, name, action) {
    const task = TASKS[name];
    this.logger.log(`${task.request}...`);
    button.disabled = true;
    button.textContent = task.busy;
    try {
      await action();
      this.logger.log(task.done);
      this.showNotification(task.done);
    } catch (error) {
      this.logger.log(`${task.failed}:`, error.message);
      this.showNotification(task.failed, 'error');
    } finally {
      button.disabled = false;
      button.textContent = task.label;
    }
  }

  updateCache() {
    const update = () => this.api.cache.update();
    return this.runTask(this.updateCacheBtn, 'cache', update);
  }

  clearDatabase() {
    const clear = () => this.api.chat.clear();
    return this.runTask(this.clearMessagesBtn, 'clear', clear);
  }

  showInstallButton(visible = true) {
    const text = 'App installed successfully!';
    if (!visible) this.showNotification(text);
    this.installBtn.classList.toggle('hidden', !visible);
  }

  showNotification(message, type = 'info') {
    this.notification.textContent = message;
    this.notification.className = `notification ${type}`;
    setTimeout(() => {
      this.notification.classList.add('hidden');
    }, this.config.notificationTimeout);
  }
}

const logger = new Logger('output');
const options = { logger, syncTimeout: 2000, units: UNITS };
const app = new ChatApplication(options);

export { ChatApplication, app };
