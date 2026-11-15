import { REACTIONS, GENERAL, validate, seed } from './chat.js';
import { createChat, createMessage, react } from './chat.js';
import { listChats, listMessages, chatActivity } from './chat.js';
import { Replica, Uplink } from './globalstorage.js';
import { generateUUID } from './metautil.js';
import { createPeerSession } from './peer.js';
import { Application } from './application.js';

const EMOJI = {
  like: '👍',
  dislike: '👎',
  love: '❤️',
  smile: '😊',
  poo: '💩',
};

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

const UNITS = ['chat', 'cache', 'signal'];
const PAGE_SIZE = 50;
const CHAT_KEY = 'xxii:chat';
const NICK_KEY = 'xxii:nick';
const NARROW_WIDTH = 900;

const pad = (value) => `${value}`.padStart(2, '0');

const timeOf = (timestamp) => {
  const date = new Date(timestamp);
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
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
    this.username = readSetting(NICK_KEY, '');
    this.syncTimeout = null;
    this.peerConnected = false;
    this.openedAt = Date.now();
    this.chat = readSetting(CHAT_KEY, GENERAL);
    this.limit = PAGE_SIZE;
    this.filter = '';
    this.unread = new Map();
    this.isRenderScheduled = false;
    this.replica = new Replica({ validate });
    this.uplink = null;
    this.peers = createPeerSession(this);
    this.replica.on('log', (event) => this.showChanges(event));
    this.replica.on('clear', () => this.resetView());
    seed(this.replica);
    this.usernameInput.value = this.username;
    if (window.innerWidth < NARROW_WIDTH) this.app.classList.add('no-details');
    this.render();
  }

  getElements() {
    this.app = document.querySelector('.app');
    this.menuBtn = document.getElementById('menu-btn');
    this.installBtn = document.getElementById('install-btn');
    this.installStatus = document.getElementById('install-status');
    this.updateCacheBtn = document.getElementById('update-cache-btn');
    this.clearBtn = document.getElementById('clear-btn');
    this.clearMessagesBtn = document.getElementById('clear-messages-btn');
    this.connectionStatus = document.getElementById('connection-status');
    this.usernameInput = document.getElementById('username-input');
    this.chatList = document.getElementById('chat-list');
    this.chatForm = document.getElementById('chat-form');
    this.chatNameInput = document.getElementById('chat-name-input');
    this.peerRoom = document.getElementById('peer-room');
    this.peerHostBtn = document.getElementById('peer-host-btn');
    this.peerJoinBtn = document.getElementById('peer-join-btn');
    this.peerLeaveBtn = document.getElementById('peer-leave-btn');
    this.peerStatus = document.getElementById('peer-status');
    this.chatTitle = document.getElementById('chat-title');
    this.chatInfo = document.getElementById('chat-info');
    this.searchBtn = document.getElementById('search-btn');
    this.logBtn = document.getElementById('log-btn');
    this.searchBar = document.getElementById('search-bar');
    this.searchInput = document.getElementById('search-input');
    this.chatMessages = document.getElementById('chat-messages');
    this.messageList = document.getElementById('message-list');
    this.loadMoreBtn = document.getElementById('load-more-btn');
    this.composer = document.getElementById('composer');
    this.messageInput = document.getElementById('message-input');
    this.composerInfo = document.getElementById('composer-info');
    this.notification = document.getElementById('notification');
    this.chatTemplate = document.getElementById('chat-item-template');
    this.messageTemplate = document.getElementById('chat-message-template');
    this.reactionTemplate = document.getElementById('reaction-button-template');
  }

  setupEvents() {
    this.menuBtn.onclick = () => this.app.classList.toggle('menu-open');
    this.installBtn.onclick = () => this.install();
    this.updateCacheBtn.onclick = () => this.updateCache();
    this.clearBtn.onclick = () => this.logger.clear();
    this.clearMessagesBtn.onclick = () => this.clearDatabase();
    this.peerHostBtn.onclick = () => this.startPeer('host');
    this.peerJoinBtn.onclick = () => this.startPeer('join');
    this.peerLeaveBtn.onclick = () => {
      this.peers.leave().catch((error) => this.report(error));
    };
    this.searchBtn.onclick = () => this.toggleSearch();
    this.logBtn.onclick = () => this.app.classList.toggle('no-details');
    this.loadMoreBtn.onclick = () => this.loadOlder();

    this.searchInput.addEventListener('input', () => {
      this.filter = this.searchInput.value.trim().toLowerCase();
      this.renderMessages();
    });
    this.chatForm.addEventListener('submit', (event) => {
      event.preventDefault();
      this.createChat();
    });
    this.composer.addEventListener('submit', (event) => {
      event.preventDefault();
      this.submit();
    });
    this.messageInput.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter' || event.shiftKey) return;
      event.preventDefault();
      this.submit();
    });
    this.chatList.addEventListener('click', (event) => {
      const item = event.target.closest('.chat-item');
      if (item) this.selectChat(item.dataset.id);
    });
    this.messageList.addEventListener('click', (event) => {
      const button = event.target.closest('.reaction');
      if (button) this.addReaction(button.dataset);
    });
    this.usernameInput.addEventListener('blur', () => this.syncUsername());
    this.usernameInput.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') this.syncUsername();
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
    window.addEventListener('pagehide', () => {
      this.peers.leave({ quiet: true }).catch((error) => this.report(error));
    });
  }

  startSync() {
    const options = { unit: 'chat', name: 'worker', clear: 'follow' };
    this.uplink = new Uplink(this.replica, this.metacom, options);
    this.uplink.on('error', (error) => {
      this.logger.log('Sync with worker failed:', error.message);
    });
    this.uplink.start();
    this.api.chat.on('username', (username) => this.showUsername(username));
  }

  showChanges({ deltas, origin }) {
    const source = origin || 'this tab';
    if (deltas.length > 1) {
      this.logger.log(`Synced ${deltas.length} changes from ${source}`);
    } else {
      const { entity, target, data } = deltas[0];
      const kind = data.reactions ? 'reaction' : entity;
      this.logger.log(`New ${kind} from ${source}:`, target);
    }
    if (origin) this.countUnread(deltas);
    this.scheduleRender();
  }

  countUnread(deltas) {
    for (const { entity, target, data } of deltas) {
      if (entity !== 'message' || !data.content) continue;
      const message = this.replica.get(target);
      const isOld = message.timestamp <= this.openedAt;
      if (isOld || message.chat === this.chat) continue;
      const count = this.unread.get(message.chat) ?? 0;
      this.unread.set(message.chat, count + 1);
    }
  }

  resetView() {
    this.logger.log('Local copy cleared');
    this.unread.clear();
    seed(this.replica);
    this.chat = GENERAL;
    writeSetting(CHAT_KEY, GENERAL);
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
    this.renderChats();
    this.renderMessages();
  }

  renderChats() {
    const activity = chatActivity(this.replica);
    const chats = listChats(this.replica);
    const items = chats.map((chat) => {
      const time = activity.get(chat.id) ?? chat.created;
      return this.createChatItem(chat, time);
    });
    this.chatList.replaceChildren(...items);
  }

  createChatItem(chat, time) {
    const fragment = this.chatTemplate.content.cloneNode(true);
    const item = fragment.querySelector('.chat-item');
    item.dataset.id = chat.id;
    item.classList.toggle('active', chat.id === this.chat);
    item.querySelector('.name').textContent = chat.name;
    item.querySelector('.time').textContent = dayOf(time);
    const badge = item.querySelector('.badge');
    const count = this.unread.get(chat.id) ?? 0;
    badge.textContent = count;
    badge.classList.toggle('hidden', count === 0);
    return item;
  }

  renderMessages() {
    const box = this.chatMessages;
    const distance = box.scrollHeight - box.scrollTop - box.clientHeight;
    const isAtBottom = distance < 40;
    const messages = listMessages(this.replica, this.chat);
    const matched = this.filter
      ? messages.filter((m) => this.isMatch(m))
      : messages;
    const visible = matched.slice(-this.limit);
    const elements = visible.map((message) => this.createMessage(message));
    this.messageList.replaceChildren(...elements);
    this.loadMoreBtn.classList.toggle('hidden', matched.length <= this.limit);
    this.renderHeader(messages);
    if (isAtBottom) box.scrollTop = box.scrollHeight;
  }

  isMatch(message) {
    const text = `${message.username} ${message.content}`.toLowerCase();
    return text.includes(this.filter);
  }

  renderHeader(messages) {
    const name = this.replica.get(this.chat)?.name ?? this.chat;
    const authors = new Set(messages.map((message) => message.username));
    const count = `${messages.length} messages, ${authors.size} authors`;
    this.chatTitle.textContent = `!${name}`;
    this.chatInfo.textContent = count;
    this.messageInput.placeholder = `> message to !${name}`;
    const nick = this.username ? `@${this.username}` : 'set your nick first';
    this.composerInfo.textContent = nick;
  }

  createMessage(message) {
    const fragment = this.messageTemplate.content.cloneNode(true);
    const element = fragment.querySelector('.message');
    element.querySelector('.time').textContent = timeOf(message.timestamp);
    element.querySelector('.author').textContent = message.username;
    element.querySelector('.content').textContent = message.content;
    const reactions = element.querySelector('.reactions');
    for (const reaction of REACTIONS) {
      const count = message.reactions?.[reaction] ?? 0;
      reactions.append(this.createReaction(message.id, reaction, count));
    }
    return element;
  }

  createReaction(messageId, reaction, count) {
    const fragment = this.reactionTemplate.content.cloneNode(true);
    const button = fragment.querySelector('.reaction');
    button.dataset.messageId = messageId;
    button.dataset.reaction = reaction;
    button.dataset.count = count;
    button.querySelector('.emoji').textContent = EMOJI[reaction];
    button.querySelector('.count').textContent = count;
    return button;
  }

  selectChat(id) {
    this.chat = id;
    this.limit = PAGE_SIZE;
    this.unread.delete(id);
    writeSetting(CHAT_KEY, id);
    this.app.classList.remove('menu-open');
    this.render();
    this.chatMessages.scrollTop = this.chatMessages.scrollHeight;
    this.messageInput.focus();
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

  createChat() {
    const name = this.chatNameInput.value.trim();
    if (!name) return;
    const id = generateUUID();
    createChat(this.replica, { id, name, created: Date.now() });
    this.chatNameInput.value = '';
    this.logger.log('Created chat:', name);
    this.selectChat(id);
  }

  syncUsername() {
    const username = this.usernameInput.value.trim();
    if (!username || username === this.username) return;
    this.username = username;
    writeSetting(NICK_KEY, username);
    this.renderHeader(listMessages(this.replica, this.chat));
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
    this.logger.log('Username updated from other tab:', username);
    this.showNotification(`Username updated from other tab: ${username}`);
  }

  submit() {
    this.sendMessage().catch((error) => this.report(error));
  }

  async sendMessage() {
    const content = this.messageInput.value.trim();
    if (!content) return;
    this.syncUsername();
    if (!this.username) {
      this.showNotification('Please enter your nick', 'warning');
      this.usernameInput.focus();
      return;
    }
    this.messageInput.value = '';
    const id = generateUUID();
    const { username, chat } = this;
    const timestamp = Date.now();
    createMessage(this.replica, { id, chat, username, content, timestamp });
    this.chatMessages.scrollTop = this.chatMessages.scrollHeight;
    const isSaved = this.uplink ? await this.uplink.flush() : false;
    if (isSaved && this.connected) {
      this.logger.log('Sent message:', content);
    } else if (this.peerConnected) {
      this.logger.log('Sent to peer, queued for the server:', content);
      this.showNotification('Sent to peer, queued for the server');
    } else {
      this.logger.log('Message queued (offline):', content);
      this.showNotification('Message queued - will send when online');
    }
  }

  addReaction({ messageId, reaction }) {
    react(this.replica, messageId, reaction);
    this.logger.log('Added reaction:', reaction, 'to message:', messageId);
  }

  roomName() {
    const room = this.peerRoom.value.trim();
    return room || 'xxii';
  }

  setPeerStatus(text) {
    this.peerStatus.textContent = text;
  }

  startPeer(kind) {
    const room = this.roomName();
    this.peerHostBtn.disabled = true;
    this.peerJoinBtn.disabled = true;
    const run = kind === 'host' ? this.peers.host(room) : this.peers.join(room);
    run
      .catch((error) => this.report(error))
      .finally(() => {
        const isBusy = this.peers.role !== '';
        this.peerHostBtn.disabled = isBusy;
        this.peerJoinBtn.disabled = isBusy;
        this.peerLeaveBtn.disabled = !isBusy;
      });
  }

  updateInterface() {
    const online = this.online ? 'online' : 'offline';
    let link = 'offline';
    if (this.peerConnected) link = 'peer';
    else if (this.connected) link = 'server';
    this.connectionStatus.textContent = `${online} / ${link}`;
    this.connectionStatus.className = `status ${link}`;
  }

  showStatus(connected) {
    const text = connected ? 'Server connected' : 'Server disconnected';
    this.logger.log(text);
    this.showNotification(text, connected ? 'info' : 'warning');
    this.updateInterface();
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
    this.installStatus.classList.toggle('hidden', !visible);
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
