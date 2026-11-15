import { REACTIONS, ICONS, CHANNELS, GENERAL } from './chat.js';
import { MAX_LENGTH, TEXT_LENGTH, validate, seed } from './chat.js';
import { pairOf, isPair, directUnit } from './chat.js';
import { isFeed, isPost, containerOf, labelOf, parseTitle } from './chat.js';
import { saveAuthor, createChannel, describe } from './chat.js';
import { createFolder, setVisibility, placeItem } from './chat.js';
import { createMessage, createPost, setReaction, pin } from './chat.js';
import { MAX_FILE_SIZE, attachFile, attachmentsOf } from './chat.js';
import { listChannels, listAuthors, folderTree } from './chat.js';
import { threadsOf, activityOf, reactionsOf, unreadOf } from './chat.js';
import { isImage, storeFile, readFile, saveFile } from './files.js';
import { readBlob, onFileStored } from './files.js';
import { timeOf, dateOf, dayKey, dayOf, dayLabel, plural } from './view.js';
import { formatSize, fitSize, readSetting, writeSetting } from './view.js';
import { readMap, writeMap, cloneTemplate, setBadge } from './view.js';
import { fillText, parseBlocks, excerptOf, isEditable } from './view.js';
import { Toolbar, Menu, Lightbox, Switcher } from './overlays.js';
import { Replica, Uplink } from './globalstorage.js';
import { generateUUID } from './metautil.js';
import { Mesh } from './mesh.js';
import { Application } from './application.js';

const TASKS = {
  cache: {
    label: 'update cache',
    busy: 'updating...',
    request: 'Cache update requested',
    done: 'Cache updated successfully',
    failed: 'Cache update failed',
  },
  clear: {
    label: 'clear database',
    busy: 'clearing...',
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
  k: (app) => app.toggleSwitcher(),
};

const NAV_ACTIONS = {
  add: (app, { folder }) => app.addToFolder(folder),
  visibility: (app, { folder }) => app.toggleVisibility(folder),
  remove: (app, { folder, item }) => app.removeFromFolder(folder, item),
};

const MESSAGE_ACTIONS = {
  react: (app, id, { reaction }) => app.toggleReaction(id, reaction),
  thread: (app, id) => app.openThread(id),
  pin: (app, id) => app.togglePin(id),
  copy: (app, id) => app.copyText(id),
  view: (app, id, { file }) => app.viewImage(file),
  download: (app, id, { file }) => app.downloadFile(file),
};

const LAYERS = {
  menu: (app) => app.hideMenu(),
  lightbox: (app) => app.lightbox.close(),
  switcher: (app) => app.hideSwitcher(),
  sidebar: (app) => app.app.classList.remove('menu-open'),
  panel: (app) => app.hidePanel(),
};

const THREAD_LABELS = { message: 'reply', post: 'open', detail: '' };
const THREAD_ITEMS = { message: 'Reply in thread', post: 'Open post' };
const LIGHTBOX_KEYS = { ArrowLeft: -1, ArrowRight: 1 };
const CHAT_KEYS = { ArrowUp: -1, ArrowDown: 1 };
const NEXT_VISIBILITY = { unlisted: 'public', public: 'unlisted' };

const STATES = {
  linked: 'webrtc',
  online: 'online',
  away: 'away',
  offline: 'offline',
  unknown: 'known author',
};

const STATUS_ORDER = ['linked', 'online', 'away', 'offline', 'unknown'];
const UNITS = ['chat', 'cache', 'presence', 'signal', 'files'];
const THREADS = ['thread', 'post'];
const ITEMS = '.message, .post, .post-article, .thread-item';
const CHAT_ITEMS = '.nav-item[data-id], .nav-item[data-peer]';
const DEFAULT_PANEL = 'members';
const TITLE = 'XXII Chat';
const NARROW = '(max-width: 900px)';
const COARSE = '(pointer: coarse)';
const REDUCED_MOTION = '(prefers-reduced-motion: reduce)';
const MAX_FILE_MB = MAX_FILE_SIZE / 1024 / 1024;
const PAGE_SIZE = 50;
const GROUP_MS = 5 * 60 * 1000;
const LONG_PRESS_MS = 450;
const REVOKE_MS = 10000;
const RETRY_MS = 2000;
const MAX_RETRY_MS = 30000;
const MOVE_PX = 10;
const BOTTOM_PX = 40;
const PREVIEW_WIDTH = 320;
const PREVIEW_HEIGHT = 240;
const INPUT_RATIO = 0.4;
const CHAT_KEY = 'xxii:chat';
const NICK_KEY = 'xxii:nick';
const PEER_KEY = 'xxii:peer';
const SINCE_KEY = 'xxii:since';
const READ_KEY = 'xxii:read';
const DRAFTS_KEY = 'xxii:drafts';
const COLLAPSED_KEY = 'xxii:collapsed';

const loadPeerId = () => {
  const saved = readSetting(PEER_KEY, '');
  if (saved) return saved;
  const id = generateUUID();
  writeSetting(PEER_KEY, id);
  return id;
};

const loadSince = () => {
  const saved = Number(readSetting(SINCE_KEY, '0'));
  if (saved > 0) return saved;
  const now = Date.now();
  writeSetting(SINCE_KEY, `${now}`);
  return now;
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

const createReactionButtons = () => {
  const buttons = [];
  for (const reaction in REACTIONS) {
    const button = document.createElement('button');
    button.type = 'button';
    button.title = reaction;
    button.dataset.action = 'react';
    button.dataset.reaction = reaction;
    button.textContent = REACTIONS[reaction];
    buttons.push(button);
  }
  return buttons;
};

const fillPostHeader = (element, post) => {
  element.dataset.id = post.id;
  element.classList.toggle('pinned', post.pinned === true);
  element.querySelector('.title').textContent = post.title;
  element.querySelector('.nick').textContent = post.nick;
  element.querySelector('.date').textContent = dateOf(post.timestamp);
};

const readCollapsed = () => {
  const saved = readSetting(COLLAPSED_KEY, '');
  return new Set(saved.split(',').filter(Boolean));
};

const kindOf = (item) => {
  if (item.classList.contains('message')) return 'message';
  if (item.classList.contains('post')) return 'post';
  return 'detail';
};

const isGrouped = (previous, message) => {
  if (!previous || isPost(previous) || isPost(message)) return false;
  const isSameAuthor = previous.author === message.author;
  const isClose = message.timestamp - previous.timestamp < GROUP_MS;
  return isSameAuthor && isClose;
};

const createLabel = (className, text) => {
  const element = document.createElement('div');
  element.className = className;
  const label = document.createElement('span');
  label.textContent = text;
  element.append(label);
  return element;
};

const createDay = (timestamp) => {
  const section = document.createElement('section');
  section.className = 'day';
  section.append(createLabel('day-label', dayLabel(timestamp)));
  return section;
};

const imagesOf = (checksum) => {
  const selector = `.image[data-checksum="${checksum}"]`;
  return document.querySelectorAll(selector);
};

const isNarrow = () => matchMedia(NARROW).matches;

const resizeInput = (input) => {
  input.style.height = 'auto';
  const limit = Math.round(window.innerHeight * INPUT_RATIO);
  input.style.height = `${Math.min(input.scrollHeight, limit)}px`;
};

const scrollBehavior = () => {
  const isReduced = matchMedia(REDUCED_MOTION).matches;
  return isReduced ? 'auto' : 'smooth';
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
    this.since = loadSince();
    this.chat = readSetting(CHAT_KEY, GENERAL);
    this.limit = PAGE_SIZE;
    this.filter = '';
    this.panel = '';
    this.lastPanel = '';
    this.thread = '';
    this.view = null;
    this.readAt = readMap(READ_KEY);
    this.drafts = readMap(DRAFTS_KEY);
    this.pending = new Map();
    this.unread = new Map();
    this.divider = { chat: this.chat, at: this.readAtOf(this.chat) };
    this.collapsed = readCollapsed();
    this.cache = new Map();
    this.previews = new Map();
    this.loading = new Map();
    this.waiting = new Map();
    this.layers = [];
    this.pops = 0;
    this.press = null;
    this.isPressed = false;
    this.pointerType = 'mouse';
    this.hasConnected = false;
    this.isRenderScheduled = false;
    this.started = new Promise((resolve) => this.on('ready', resolve));
    this.replica = new Replica({ validate });
    this.uplink = null;
    this.directs = new Map();
    this.mesh = new Mesh(this);
    this.observer = new IntersectionObserver(
      (entries) => this.showPreviews(entries),
      { rootMargin: '200px' },
    );
    this.stored = onFileStored((checksum) => this.fileStored(checksum));
    this.replica.on('log', (event) => this.showChanges(event));
    this.replica.on('clear', () => this.resetView());
    this.mesh.on('peers', () => this.scheduleRender());
    this.mesh.on('links', () => this.showLinks());
    this.mesh.on('leader', () => this.logger.log('This tab runs the mesh'));
    this.mesh.on('error', (error) => this.logger.log('Mesh:', error.message));
    this.mesh.on('file', (file) => {
      this.logger.log('File received over WebRTC:', file.checksum);
    });
    seed(this.replica);
    this.usernameInput.value = this.username;
    this.fillPalette();
    this.restoreDraft();
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
    this.chatView = byId('chat-view');
    this.chatMessages = byId('chat-messages');
    this.messageList = byId('message-list');
    this.loadMoreBtn = byId('load-more-btn');
    this.jumpBtn = byId('jump-btn');
    this.jumpCount = byId('jump-count');
    this.composer = byId('composer');
    this.messageInput = byId('message-input');
    this.composerInfo = byId('composer-info');
    this.pendingList = byId('pending-files');
    this.attachBtn = byId('attach-btn');
    this.fileInput = byId('file-input');
    this.emojiBtn = byId('emoji-btn');
    this.panelTitle = byId('panel-title');
    this.panelCloseBtn = byId('panel-close-btn');
    this.threadRoot = byId('thread-root');
    this.threadBody = this.threadRoot.parentElement;
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
    this.backdrop = byId('backdrop');
    this.toolbarElement = byId('toolbar');
    this.menuElement = byId('menu');
    this.toolbar = new Toolbar(this.toolbarElement, createReactionButtons());
    this.menu = new Menu(this.menuElement, createReactionButtons);
    this.lightbox = new Lightbox(byId('lightbox'), {
      load: (file) => this.previewOf(file),
      close: () => this.closeLayer('lightbox'),
      download: (file) => this.downloadFile(file.id),
    });
    this.switcher = new Switcher(byId('switcher'), (entry) => {
      this.selectEntry(entry);
    });
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
    this.imageTemplate = byId('image-template');
    this.fileTemplate = byId('file-template');
    this.pendingFileTemplate = byId('pending-file-template');
  }

  setupEvents() {
    const onSubmit = (form, action) => {
      form.addEventListener('submit', (event) => {
        event.preventDefault();
        action();
      });
    };
    const onSendKey = (input, isSendKey, action) => {
      input.addEventListener('keydown', (event) => {
        const isEnter = event.key === 'Enter' && !event.isComposing;
        if (!isEnter || !isSendKey(event)) return;
        event.preventDefault();
        action();
      });
    };

    this.menuBtn.onclick = () => this.toggleSidebar();
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
    this.jumpBtn.onclick = () => this.jumpToLatest();
    this.emojiBtn.onclick = () => this.openPalette(this.emojiBtn);
    this.attachBtn.onclick = () => this.fileInput.click();
    this.backdrop.onclick = () => this.closeTop();

    this.fileInput.addEventListener('change', () => {
      this.addFiles(this.fileInput.files);
      this.fileInput.value = '';
    });
    this.pendingList.addEventListener('click', (event) => {
      const button = event.target.closest('.remove-file');
      if (button) this.removeFile(Number(button.dataset.index));
    });
    this.chatView.addEventListener('dragover', (event) => {
      event.preventDefault();
    });
    this.chatView.addEventListener('drop', (event) => {
      event.preventDefault();
      this.addFiles(event.dataTransfer.files);
    });
    this.messageInput.addEventListener('paste', (event) => {
      const { files } = event.clipboardData;
      if (files.length > 0) this.addFiles(files);
    });
    this.messageInput.addEventListener('input', () => this.saveDraft());
    this.replyInput.addEventListener('input', () => {
      resizeInput(this.replyInput);
    });
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
    onSendKey(
      this.messageInput,
      (event) => this.isSendKey(event),
      () => {
        this.submit();
      },
    );
    onSendKey(
      this.replyInput,
      (event) => !event.shiftKey,
      () => {
        this.submitReply();
      },
    );
    this.chatInfo.onclick = () => this.editDescription();
    this.topicInput.addEventListener('blur', () => this.closeDescription());

    this.sidebar.addEventListener('click', (event) => {
      this.handleNavClick(event);
    });
    this.memberList.addEventListener('click', (event) => {
      const item = event.target.closest('.member[data-peer]');
      if (item) this.selectDirect(item.dataset.peer);
    });
    const timelines = [this.messageList, this.threadRoot, this.threadReplies];
    for (const timeline of timelines) {
      timeline.addEventListener('click', (event) => {
        this.handleMessageClick(event);
      });
      timeline.addEventListener('pointerover', (event) => {
        this.handlePointerOver(event);
      });
      timeline.addEventListener('pointerout', (event) => {
        this.handlePointerOut(event);
      });
      timeline.addEventListener('pointerdown', (event) => {
        this.startPress(event);
      });
      timeline.addEventListener('contextmenu', (event) => {
        this.handleContextMenu(event);
      });
    }
    this.toolbarElement.addEventListener('click', (event) => {
      this.handleToolbarClick(event);
    });
    this.toolbarElement.addEventListener('pointerout', (event) => {
      this.handlePointerOut(event);
    });
    this.menuElement.addEventListener('click', (event) => {
      this.handleMenuClick(event);
    });
    this.chatMessages.addEventListener('scroll', () => this.handleScroll());
    this.threadBody.addEventListener('scroll', () => this.toolbar.hide());
    this.pinList.addEventListener('click', (event) => this.handlePin(event));
    this.postOutline.addEventListener('click', (event) => {
      const button = event.target.closest('button');
      if (button) this.scrollToHeading(button.dataset.heading);
    });
    this.palette.addEventListener('click', (event) => {
      const button = event.target.closest('button');
      if (button) this.insertEmoji(button.textContent);
    });
    this.usernameInput.addEventListener('blur', () => this.syncUsername());
    this.usernameInput.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') this.syncUsername();
    });
    document.addEventListener('keydown', (event) => this.handleKey(event));
    document.addEventListener(
      'pointerdown',
      (event) => this.handlePointerDown(event),
      true,
    );
    document.addEventListener('pointermove', (event) => this.movePress(event));
    document.addEventListener('pointerup', () => this.cancelPress());
    document.addEventListener('pointercancel', () => this.cancelPress());
    document.addEventListener(
      'click',
      (event) => this.suppressPressClick(event),
      true,
    );
    document.addEventListener('click', (event) => {
      const isPalette = event.target.closest('#palette, #emoji-btn');
      if (!isPalette) this.closePalette();
    });

    this.on('ready', () => this.startSync());
    this.on('status', ({ connected }) => this.showStatus(connected));
    this.on('network', () => this.updateInterface());
    this.on('install', () => this.showInstallButton(true));
    this.on('installed', () => this.showInstallButton(false));

    document.addEventListener('visibilitychange', () => {
      if (document.hidden) this.syncUsername();
      else this.scheduleRender();
    });
    window.addEventListener('resize', () => this.toolbar.hide());
    window.addEventListener('popstate', () => this.handlePopState());
    window.addEventListener('storage', (event) => this.handleStorage(event));
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
    replica.on('log', (event) => this.showChanges(event));
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

  showChanges({ deltas, origin }) {
    const source = origin || 'this tab';
    if (deltas.length > 1) {
      this.logger.log(`Synced ${deltas.length} changes from ${source}`);
    } else {
      const { entity, target, data } = deltas[0];
      const kind = data.reactions ? 'reaction' : entity;
      this.logger.log(`New ${kind} from ${source}:`, target);
    }
    this.scheduleRender();
  }

  readAtOf(chat) {
    return this.readAt.get(chat) ?? this.since;
  }

  countUnread() {
    const reader = this.peerId;
    const readAt = (chat) => this.readAtOf(chat);
    const unread = unreadOf(this.replica, reader, readAt);
    for (const direct of this.directs.values()) {
      const counts = unreadOf(direct.replica, reader, readAt);
      const count = counts.get(direct.pair) ?? 0;
      if (count > 0) unread.set(direct.pair, count);
    }
    return unread;
  }

  unreadOf(chat) {
    return this.unread.get(chat) ?? 0;
  }

  markRead(isAtBottom) {
    const isSeen = isAtBottom && !document.hidden;
    if (!isSeen || this.unreadOf(this.chat) === 0) return;
    this.readAt.set(this.chat, Date.now());
    writeMap(READ_KEY, this.readAt);
    this.unread.set(this.chat, 0);
  }

  handleStorage({ key }) {
    if (key !== READ_KEY) return;
    this.readAt = readMap(READ_KEY);
    this.scheduleRender();
  }

  resetView() {
    this.logger.log('Local copy cleared');
    seed(this.replica);
    this.chat = GENERAL;
    this.thread = '';
    this.cache.clear();
    for (const url of this.previews.values()) URL.revokeObjectURL(url);
    this.previews.clear();
    this.waiting.clear();
    writeSetting(CHAT_KEY, GENERAL);
    this.saveAuthor();
    this.restoreDraft();
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
    const isAtBottom = this.isAtBottom();
    this.unread = this.countUnread();
    this.markRead(isAtBottom);
    this.renderContacts();
    this.renderChannels();
    this.renderMessages(isAtBottom);
    this.renderPanel();
    this.updateTitle();
    this.refreshToolbar();
  }

  updateTitle() {
    let total = 0;
    for (const count of this.unread.values()) total += count;
    const title = total > 0 ? `(${total}) ${TITLE}` : TITLE;
    if (title === document.title) return;
    document.title = title;
    if (!navigator.setAppBadge) return;
    if (total > 0) navigator.setAppBadge(total).catch(() => {});
    else navigator.clearAppBadge().catch(() => {});
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

  nickMap() {
    const nicks = new Map();
    for (const author of listAuthors(this.replica)) {
      nicks.set(author.id, author.nick);
    }
    for (const entry of this.mesh.peers.values()) {
      nicks.set(entry.peer, entry.nick);
    }
    nicks.set(this.peerId, 'you');
    return nicks;
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
    toggle.textContent = visibility;
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
    const { chat } = this;
    const replica = this.replicaOf(chat);
    const attachments = attachmentsOf(replica, chat);
    const reactions = reactionsOf(replica, chat);
    const nicks = this.nickMap();
    const threads = threadsOf(replica, chat);
    return { replica, attachments, reactions, nicks, ...threads };
  }

  isAtBottom() {
    const box = this.chatMessages;
    const distance = box.scrollHeight - box.scrollTop - box.clientHeight;
    return distance < BOTTOM_PX;
  }

  detailsOf(message, view) {
    const replyCount = view.replies.get(message.id)?.length ?? 0;
    const files = view.attachments.get(message.id) ?? [];
    const byReaction = view.reactions.get(message.id);
    const reactions = this.summarize(byReaction, view.nicks);
    return { replyCount, files, reactions, isContinued: false };
  }

  renderMessages(isAtBottom = this.isAtBottom()) {
    const view = this.currentView();
    this.view = view;
    const matched = this.filter
      ? view.roots.filter((message) => this.isMatch(message, view))
      : view.roots;
    const visible = matched.slice(-this.limit);
    const cache = new Map();
    const sections = [];
    let section = null;
    let previous = null;
    let day = '';
    let isMarked = false;
    for (const message of visible) {
      const key = dayKey(message.timestamp);
      if (key !== day) {
        day = key;
        section = createDay(message.timestamp);
        sections.push(section);
        previous = null;
      }
      if (!isMarked && this.isNew(message)) {
        section.append(createLabel('new-divider', 'new messages'));
        isMarked = true;
        previous = null;
      }
      const details = this.detailsOf(message, view);
      details.isContinued = isGrouped(previous, message);
      section.append(this.messageElement(message, details, cache));
      previous = message;
    }
    this.forget(cache);
    this.cache = cache;
    if (sections.length === 0) sections.push(this.createEmpty());
    this.messageList.replaceChildren(...sections);
    this.loadMoreBtn.classList.toggle('hidden', matched.length <= this.limit);
    this.renderHeader(view.roots);
    const box = this.chatMessages;
    if (isAtBottom) box.scrollTop = box.scrollHeight;
    this.updateJump();
  }

  isNew(message) {
    const { chat, at } = this.divider;
    const isOthers = message.author !== this.peerId;
    return chat === this.chat && isOthers && message.timestamp > at;
  }

  messageElement(message, details, cache) {
    const key = JSON.stringify([message, details]);
    const cached = this.cache.get(message.id);
    const element =
      cached?.key === key
        ? this.observePending(cached.element)
        : this.createTimeline(message, details);
    cache.set(message.id, { key, element });
    return element;
  }

  createTimeline(message, details) {
    if (isPost(message)) return this.createPostCard(message, details);
    return this.createMessage(message, details);
  }

  forget(cache) {
    for (const id of this.cache.keys()) {
      if (cache.has(id)) continue;
      const { element } = this.cache.get(id);
      for (const image of element.querySelectorAll('.image')) {
        this.observer.unobserve(image);
      }
    }
  }

  createEmpty() {
    const isFeedOpen = this.channelEntity() === 'feed';
    const text = isFeedOpen
      ? 'No posts yet: the first line of a post is its title'
      : 'No messages yet, say hello 👋';
    return createLabel('empty-chat', text);
  }

  isMatch(message, view) {
    const { nick, title = '', content } = message;
    const files = view.attachments.get(message.id) ?? [];
    const names = files.map((file) => file.name).join(' ');
    const text = `${nick} ${title} ${content} ${names}`.toLowerCase();
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
      const isFeedOpen = this.channelEntity() === 'feed';
      const noun = isFeedOpen ? ['post', 'posts'] : ['message', 'messages'];
      const authors = new Set(roots.map((message) => message.author));
      const count = plural(roots.length, noun[0], noun[1]);
      return `${count}, ${plural(authors.size, 'author', 'authors')}`;
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

  createMessage(message, details) {
    const element = cloneTemplate(this.messageTemplate, '.message');
    element.dataset.id = message.id;
    element.classList.toggle('pinned', message.pinned === true);
    element.classList.toggle('continued', details.isContinued);
    const time = element.querySelector('.time');
    time.textContent = timeOf(message.timestamp);
    time.title = dateOf(message.timestamp);
    element.querySelector('.author').textContent = message.nick;
    fillText(element.querySelector('.content'), message.content);
    this.fillFiles(element.querySelector('.attachments'), details.files);
    this.fillReactions(element.querySelector('.reactions'), details.reactions);
    const { replyCount } = details;
    const replies = element.querySelector('.replies');
    replies.classList.toggle('hidden', replyCount === 0);
    const count = plural(replyCount, 'reply', 'replies');
    replies.querySelector('.count').textContent = count;
    return element;
  }

  createPostCard(post, details) {
    const element = cloneTemplate(this.postTemplate, '.post');
    fillPostHeader(element, post);
    element.querySelector('.excerpt').textContent = excerptOf(post.content);
    this.fillFiles(element.querySelector('.attachments'), details.files);
    const count = plural(details.replyCount, 'reply', 'replies');
    element.querySelector('.replies .count').textContent = count;
    this.fillReactions(element.querySelector('.reactions'), details.reactions);
    return element;
  }

  createArticle(post, details) {
    const element = cloneTemplate(this.articleTemplate, '.post-article');
    fillPostHeader(element, post);
    const blocks = parseBlocks(post.content);
    const nodes = [];
    for (let i = 0; i < blocks.length; i++) {
      const { isHeading, text } = blocks[i];
      const node = document.createElement(isHeading ? 'h4' : 'p');
      fillText(node, text.trim());
      if (isHeading) node.dataset.heading = i;
      nodes.push(node);
    }
    element.querySelector('.post-text').replaceChildren(...nodes);
    this.fillFiles(element.querySelector('.attachments'), details.files);
    this.fillReactions(element.querySelector('.reactions'), details.reactions);
    return element;
  }

  createThreadItem(message, details) {
    const element = cloneTemplate(this.threadTemplate, '.thread-item');
    const time = timeOf(message.timestamp);
    element.dataset.id = message.id;
    element.classList.toggle('pinned', message.pinned === true);
    element.querySelector('.who').textContent = `${message.nick} at ${time}:`;
    fillText(element.querySelector('.text'), message.content);
    this.fillFiles(element.querySelector('.attachments'), details.files);
    this.fillReactions(element.querySelector('.reactions'), details.reactions);
    return element;
  }

  fillFiles(container, files) {
    const images = files.filter((file) => isImage(file.mime));
    const others = files.filter((file) => !isImage(file.mime));
    const items = others.map((file) => this.createFile(file));
    if (images.length > 0) {
      const gallery = document.createElement('div');
      gallery.className = 'gallery';
      gallery.append(...images.map((file) => this.createImage(file)));
      items.unshift(gallery);
    }
    container.replaceChildren(...items);
  }

  createFile(file) {
    const element = cloneTemplate(this.fileTemplate, '.file');
    element.title = file.name;
    element.querySelector('.file-name').textContent = file.name;
    element.querySelector('.file-size').textContent = formatSize(file.size);
    element.querySelector('.download-btn').dataset.file = file.id;
    return element;
  }

  createImage(file) {
    const element = cloneTemplate(this.imageTemplate, '.image');
    const image = element.querySelector('img');
    const { width, height } = fitSize(file, PREVIEW_WIDTH, PREVIEW_HEIGHT);
    image.width = width;
    image.height = height;
    image.alt = file.name;
    element.title = `${file.name} ${formatSize(file.size)}`;
    element.dataset.checksum = file.checksum;
    element.dataset.file = file.id;
    for (const button of element.querySelectorAll('button')) {
      button.dataset.file = file.id;
    }
    const url = this.previews.get(file.checksum);
    if (url) image.src = url;
    else this.observer.observe(element);
    return element;
  }

  summarize(byReaction, nicks) {
    const summary = [];
    for (const reaction in REACTIONS) {
      const authors = byReaction?.get(reaction);
      if (!authors || authors.size === 0) continue;
      const names = Array.from(authors, (id) => nicks.get(id) ?? shortId(id));
      const mine = authors.has(this.peerId);
      const count = authors.size;
      summary.push({ reaction, count, mine, names: names.toSorted() });
    }
    return summary;
  }

  fillReactions(container, reactions) {
    const buttons = reactions.map((reaction) => this.createReaction(reaction));
    container.replaceChildren(...buttons);
  }

  createReaction({ reaction, count, mine, names }) {
    const button = cloneTemplate(this.reactionTemplate, '.reaction');
    const emoji = REACTIONS[reaction];
    button.dataset.reaction = reaction;
    button.dataset.count = count;
    button.classList.toggle('mine', mine);
    button.setAttribute('aria-pressed', `${mine}`);
    button.title = `${names.join(', ')} reacted with ${emoji}`;
    button.querySelector('.emoji').textContent = emoji;
    button.querySelector('.count').textContent = count;
    return button;
  }

  showPreviews(entries) {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      this.observer.unobserve(entry.target);
      const file = this.recordOf(entry.target.dataset.file);
      if (!file) continue;
      this.previewOf(file).catch((error) => this.report(error));
    }
  }

  previewOf(file) {
    const ready = this.previews.get(file.checksum);
    if (ready) return Promise.resolve(ready);
    const loading = this.loading.get(file.checksum) ?? this.loadPreview(file);
    this.loading.set(file.checksum, loading);
    return loading;
  }

  async loadPreview(file) {
    try {
      const blob = await this.loadFile(file);
      if (!blob) return this.waitPreview(file);
      const url = URL.createObjectURL(blob);
      this.previews.set(file.checksum, url);
      this.waiting.delete(file.checksum);
      for (const element of imagesOf(file.checksum)) {
        element.classList.remove('waiting');
        element.querySelector('img').src = url;
      }
      return url;
    } finally {
      this.loading.delete(file.checksum);
    }
  }

  waitPreview(file) {
    const { checksum } = file;
    const previous = this.waiting.get(checksum) ?? RETRY_MS / 2;
    const delay = Math.min(previous * 2, MAX_RETRY_MS);
    this.waiting.set(checksum, delay);
    for (const element of imagesOf(checksum)) {
      element.classList.add('waiting');
    }
    setTimeout(() => this.retryPreview(file), delay);
    return '';
  }

  retryPreview(file) {
    if (!this.waiting.has(file.checksum)) return;
    const isShown = imagesOf(file.checksum).length > 0;
    if (!isShown) return void this.waiting.delete(file.checksum);
    this.previewOf(file).catch(() => {});
  }

  observePending(element) {
    for (const image of element.querySelectorAll('.image')) {
      const isLoaded = image.querySelector('img').hasAttribute('src');
      if (!isLoaded) this.observer.observe(image);
    }
    return element;
  }

  fileStored(checksum) {
    if (!this.waiting.has(checksum)) return;
    for (const files of this.view?.attachments.values() ?? []) {
      const file = files.find((item) => item.checksum === checksum);
      if (file) return void this.previewOf(file).catch(() => {});
    }
  }

  handleMessageClick(event) {
    const item = event.target.closest('[data-id]');
    if (!item) return;
    const { id } = item.dataset;
    const button = event.target.closest('button');
    const isCard = !button && item.classList.contains('post');
    const isLink = event.target.closest('a') !== null;
    if (isCard && !isLink) return void this.openThread(id);
    const action = MESSAGE_ACTIONS[button?.dataset.action];
    if (action) action(this, id, button.dataset);
  }

  handlePointerOver(event) {
    if (event.pointerType === 'touch') return;
    const item = event.target.closest(ITEMS);
    if (!item?.dataset.id || this.toolbar.target?.item === item) return;
    const area = item.closest('.messages, .panel-body');
    const target = { id: item.dataset.id, item, x: event.clientX, area };
    this.toolbar.show(target, this.toolbarState(item));
  }

  handlePointerOut(event) {
    const { target } = this.toolbar;
    if (!target) return;
    const next = event.relatedTarget;
    const isInItem = target.item.contains(next);
    const isInToolbar = this.toolbar.contains(next);
    if (!next || (!isInItem && !isInToolbar)) this.toolbar.hide();
  }

  toolbarState(item) {
    const { id } = item.dataset;
    const record = this.recordOf(id);
    const thread = THREAD_LABELS[kindOf(item)];
    return { mine: this.mineOf(id), thread, pinned: record?.pinned === true };
  }

  mineOf(id) {
    const mine = new Set();
    const byReaction = this.view?.reactions.get(id);
    if (!byReaction) return mine;
    for (const reaction of byReaction.keys()) {
      if (byReaction.get(reaction).has(this.peerId)) mine.add(reaction);
    }
    return mine;
  }

  refreshToolbar() {
    const { target } = this.toolbar;
    if (!target) return;
    const selector = `[data-id="${CSS.escape(target.id)}"]`;
    const item = target.area.querySelector(selector);
    if (!item?.isConnected) return void this.toolbar.hide();
    this.toolbar.show({ ...target, item }, this.toolbarState(item));
  }

  handleToolbarClick(event) {
    const button = event.target.closest('button[data-action]');
    const { target } = this.toolbar;
    if (!button || !target) return;
    MESSAGE_ACTIONS[button.dataset.action](this, target.id, button.dataset);
  }

  handlePointerDown(event) {
    this.pointerType = event.pointerType;
    const isOutside = !this.menuElement.contains(event.target);
    if (this.menu.isOpen && !this.menu.isSheet && isOutside) this.closeMenu();
  }

  startPress(event) {
    if (event.pointerType !== 'touch') return;
    const item = event.target.closest(ITEMS);
    if (!item?.dataset.id) return;
    const { clientX: x, clientY: y } = event;
    const timer = setTimeout(() => this.longPress(), LONG_PRESS_MS);
    this.press = { timer, x, y, item };
  }

  movePress(event) {
    if (!this.press) return;
    const dx = event.clientX - this.press.x;
    const dy = event.clientY - this.press.y;
    if (Math.hypot(dx, dy) > MOVE_PX) this.cancelPress();
  }

  cancelPress() {
    if (!this.press) return;
    clearTimeout(this.press.timer);
    this.press = null;
  }

  longPress() {
    const { item, x, y } = this.press;
    this.press = null;
    this.isPressed = true;
    navigator.vibrate?.(15);
    this.openMenu(item, x, y, true);
  }

  suppressPressClick(event) {
    if (!this.isPressed) return;
    this.isPressed = false;
    event.preventDefault();
    event.stopPropagation();
  }

  handleContextMenu(event) {
    const item = event.target.closest(ITEMS);
    if (!item?.dataset.id) return;
    const isSheet = this.pointerType === 'touch';
    if (this.menu.isOpen && this.menu.isSheet) {
      return void event.preventDefault();
    }
    const isLink = event.target.closest('a') !== null;
    const hasSelection = window.getSelection().toString() !== '';
    if (!isSheet && (isLink || hasSelection)) return;
    event.preventDefault();
    this.cancelPress();
    this.openMenu(item, event.clientX, event.clientY, isSheet);
  }

  openMenu(item, x, y, isSheet) {
    const { id } = item.dataset;
    const items = this.menuItems(item);
    const mine = this.mineOf(id);
    this.toolbar.hide();
    this.menu.open({ id, x, y, isSheet, mine, items });
    this.updateBackdrop();
    if (isSheet) this.pushLayer('menu');
  }

  menuItems(item) {
    const { id } = item.dataset;
    const record = this.recordOf(id);
    const items = [];
    const thread = THREAD_ITEMS[kindOf(item)];
    if (thread) items.push({ action: 'thread', label: thread });
    const pinLabel = record?.pinned ? 'Unpin' : 'Pin';
    items.push({ action: 'pin', label: pinLabel });
    const hasText = Boolean(record?.content || record?.title);
    if (hasText) items.push({ action: 'copy', label: 'Copy text' });
    for (const file of this.view?.attachments.get(id) ?? []) {
      const label = `Download ${file.name}`;
      items.push({ action: 'download', label, file: file.id });
    }
    return items;
  }

  handleMenuClick(event) {
    const button = event.target.closest('button[data-action]');
    if (!button) return;
    const id = this.menu.target;
    this.closeMenu();
    MESSAGE_ACTIONS[button.dataset.action](this, id, button.dataset);
  }

  closeMenu() {
    if (!this.menu.isOpen) return;
    if (this.menu.isSheet) return void this.closeLayer('menu');
    this.hideMenu();
  }

  hideMenu() {
    this.menu.close();
    this.updateBackdrop();
  }

  updateBackdrop() {
    const isSheet = this.menu.isOpen && this.menu.isSheet;
    const isShown = isSheet || this.switcher.isOpen;
    this.backdrop.classList.toggle('hidden', !isShown);
  }

  pushLayer(name) {
    history.pushState({ layer: name }, '');
    this.layers.push(name);
  }

  popLayer(name) {
    const index = this.layers.lastIndexOf(name);
    if (index < 0) return;
    const isTop = index === this.layers.length - 1;
    this.layers.splice(index, 1);
    if (!isTop) return;
    this.pops++;
    history.back();
  }

  closeLayer(name) {
    LAYERS[name](this);
    this.popLayer(name);
  }

  handlePopState() {
    if (this.pops > 0) return void this.pops--;
    const name = this.layers.pop();
    if (name) LAYERS[name](this);
  }

  toggleSidebar() {
    const isOpen = this.app.classList.contains('menu-open');
    if (isOpen) return void this.closeLayer('sidebar');
    this.app.classList.add('menu-open');
    this.pushLayer('sidebar');
  }

  closeSidebar() {
    const isOpen = this.app.classList.contains('menu-open');
    if (isOpen) this.closeLayer('sidebar');
  }

  viewImage(id) {
    const images = this.chatImages();
    const index = images.findIndex((file) => file.id === id);
    if (index < 0) return;
    this.toolbar.hide();
    this.lightbox.open(images, index);
    this.pushLayer('lightbox');
  }

  chatImages() {
    const { roots, replies, attachments } = this.view;
    const images = [];
    const collect = (message) => {
      for (const file of attachments.get(message.id) ?? []) {
        if (isImage(file.mime)) images.push(file);
      }
    };
    for (const root of roots) {
      collect(root);
      for (const reply of replies.get(root.id) ?? []) collect(reply);
    }
    return images;
  }

  toggleSwitcher() {
    if (this.switcher.isOpen) return void this.closeLayer('switcher');
    this.toolbar.hide();
    this.switcher.open(this.switchEntries());
    this.updateBackdrop();
    this.pushLayer('switcher');
  }

  hideSwitcher() {
    this.switcher.close();
    this.updateBackdrop();
  }

  switchEntries() {
    const activity = activityOf(this.replica);
    const entries = [];
    for (const entity of CHANNELS) {
      for (const channel of listChannels(this.replica, entity)) {
        const { id } = channel;
        const icon = channel.icon ?? ICONS[entity];
        const label = labelOf(channel);
        const unread = this.unreadOf(id);
        const time = activity.get(id) ?? channel.created;
        entries.push({ id, kind: entity, icon, label, unread, time });
      }
    }
    for (const contact of this.listContacts()) {
      const id = pairOf(this.peerId, contact.peer);
      const { peer, time } = contact;
      const label = `@${contact.nick}`;
      const unread = this.unreadOf(id);
      entries.push({
        id,
        peer,
        kind: 'contact',
        icon: '👤',
        label,
        unread,
        time,
      });
    }
    return entries;
  }

  selectEntry(entry) {
    this.closeLayer('switcher');
    if (entry.peer) this.selectDirect(entry.peer);
    else this.selectChat(entry.id);
  }

  moveChat(step) {
    const items = this.sidebar.querySelectorAll(CHAT_ITEMS);
    const visible = Array.from(items).filter((item) => item.offsetParent);
    if (visible.length === 0) return;
    const isActive = (item) => item.classList.contains('active');
    const current = visible.findIndex(isActive);
    const count = visible.length;
    const index = current < 0 ? 0 : (current + step + count) % count;
    const { peer, id } = visible[index].dataset;
    if (peer) this.selectDirect(peer);
    else this.selectChat(id);
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
    this.pinsBtn.classList.toggle('active', this.panel === 'pins');
    this.membersBtn.classList.toggle('active', this.panel === 'members');
    this.logBtn.classList.toggle('active', this.panel === 'log');
    if (!this.panel) return;
    this.panelTitle.textContent = PANELS[this.panel];
    if (THREADS.includes(this.panel)) this.renderThread();
    else if (this.panel === 'pins') this.renderPins();
    else if (this.panel === 'members') this.renderMembers();
  }

  renderThread() {
    const view = this.currentView();
    const root = view.replica.get(this.thread);
    const isShown = root !== null && containerOf(root) === this.chat;
    const isPostShown = isShown && isPost(root);
    this.postInfo.classList.toggle('hidden', !isPostShown);
    if (!isShown) {
      const empty = document.createElement('p');
      empty.className = 'empty';
      empty.textContent = 'Choose reply on a message to open its thread';
      this.threadRoot.replaceChildren(empty);
      this.threadReplies.replaceChildren();
      this.threadCount.textContent = plural(0, 'reply', 'replies');
      return;
    }
    const thread = view.replies.get(this.thread) ?? [];
    const message = { id: this.thread, ...root };
    const details = this.detailsOf(message, view);
    const head = isPostShown
      ? this.createArticle(message, details)
      : this.createThreadItem(message, details);
    this.threadRoot.replaceChildren(head);
    if (isPostShown) this.renderPostInfo(message, details);
    this.threadCount.textContent = plural(thread.length, 'reply', 'replies');
    const createReply = (reply) =>
      this.createThreadItem(reply, this.detailsOf(reply, view));
    const items = thread.map(createReply);
    this.threadReplies.replaceChildren(...items);
  }

  renderPostInfo(post, details) {
    const reactions = details.reactions.map(
      ({ reaction, count }) => `${REACTIONS[reaction]} ${count}`,
    );
    this.postReplies.textContent = details.replyCount;
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
    const behavior = scrollBehavior();
    heading?.scrollIntoView({ block: 'start', behavior });
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
    const text = message.title ?? message.content;
    element.querySelector('.text').textContent = text || '📎 files';
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
    this.showPanel(name);
  }

  showPanel(name) {
    const isOpen = this.panel !== '';
    this.panel = name;
    this.lastPanel = name;
    this.renderPanel();
    if (!isOpen && isNarrow()) this.pushLayer('panel');
  }

  hidePanel() {
    this.panel = '';
    this.renderPanel();
  }

  closePanel() {
    if (this.panel) this.closeLayer('panel');
  }

  togglePanelView() {
    if (this.panel) return void this.closePanel();
    const isThread = THREADS.includes(this.lastPanel);
    if (isThread && this.thread) return void this.showPanel(this.lastPanel);
    const panel = isThread ? DEFAULT_PANEL : this.lastPanel || DEFAULT_PANEL;
    this.showPanel(panel);
  }

  openThread(id) {
    const root = this.recordOf(id);
    const isPostRoot = root !== null && isPost(root);
    this.thread = id;
    this.showPanel(isPostRoot ? 'post' : 'thread');
    if (isPostRoot) this.threadBody.scrollTop = 0;
    else if (!matchMedia(COARSE).matches) this.replyInput.focus();
  }

  fillPalette() {
    this.palette.replaceChildren(...createReactionButtons());
  }

  openPalette(anchor) {
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
  }

  insertEmoji(emoji) {
    this.closePalette();
    const input = this.messageInput;
    const position = input.selectionStart ?? input.value.length;
    const before = input.value.slice(0, position);
    const after = input.value.slice(position);
    input.value = `${before}${emoji}${after}`;
    input.focus();
    this.saveDraft();
  }

  handleKey(event) {
    if (event.isComposing) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      return void this.closeTop();
    }
    if (this.lightbox.isOpen) {
      const step = LIGHTBOX_KEYS[event.key];
      if (step) this.lightbox.step(step);
      return;
    }
    const chatStep = CHAT_KEYS[event.key];
    if (event.altKey && chatStep) {
      event.preventDefault();
      return void this.moveChat(chatStep);
    }
    const isCommand = event.ctrlKey || event.metaKey;
    if (!isCommand) return void this.focusComposer(event);
    const shortcut = SHORTCUTS[event.key.toLowerCase()];
    if (!shortcut) return;
    event.preventDefault();
    shortcut(this);
  }

  focusComposer(event) {
    const isPrintable = event.key.length === 1 && event.key !== ' ';
    const isOverlay = this.switcher.isOpen || this.menu.isOpen;
    const isTyping = isEditable(document.activeElement);
    if (!isPrintable || event.altKey || isOverlay || isTyping) return;
    this.messageInput.focus();
  }

  closeTop() {
    if (this.menu.isOpen) return void this.closeMenu();
    if (this.lightbox.isOpen) return void this.closeLayer('lightbox');
    if (this.switcher.isOpen) return void this.closeLayer('switcher');
    const isPaletteOpen = !this.palette.classList.contains('hidden');
    if (isPaletteOpen) return void this.closePalette();
    const isTopicOpen = !this.topicForm.classList.contains('hidden');
    if (isTopicOpen) return void this.closeDescription();
    const isSearchOpen = !this.searchBar.classList.contains('hidden');
    if (isSearchOpen) return void this.toggleSearch();
    const isSidebarOpen = this.app.classList.contains('menu-open');
    if (isSidebarOpen) return void this.closeSidebar();
    this.togglePanelView();
  }

  selectChat(id) {
    this.chat = id;
    this.limit = PAGE_SIZE;
    const at = this.unreadOf(id) > 0 ? this.readAtOf(id) : Infinity;
    this.divider = { chat: id, at };
    writeSetting(CHAT_KEY, id);
    this.closeSidebar();
    if (THREADS.includes(this.panel)) this.closePanel();
    this.thread = '';
    this.toolbar.hide();
    this.closeDescription();
    this.restoreDraft();
    this.render();
    this.scrollToStart();
    if (!matchMedia(COARSE).matches) this.messageInput.focus();
  }

  scrollToStart() {
    const divider = this.messageList.querySelector('.new-divider');
    const box = this.chatMessages;
    if (divider) divider.scrollIntoView({ block: 'center' });
    else box.scrollTop = box.scrollHeight;
    this.updateJump();
  }

  selectDirect(peer) {
    const pair = pairOf(this.peerId, peer);
    this.openDirect(peer).catch((error) => this.report(error));
    this.selectChat(pair);
  }

  handleScroll() {
    this.toolbar.hide();
    if (this.menu.isOpen && !this.menu.isSheet) this.closeMenu();
    this.updateJump();
    const isRead = this.unreadOf(this.chat) === 0;
    if (this.isAtBottom() && !isRead) this.scheduleRender();
  }

  updateJump() {
    const isAway = !this.isAtBottom();
    const count = this.unreadOf(this.chat);
    this.jumpBtn.classList.toggle('hidden', !isAway);
    this.jumpCount.textContent = count;
    this.jumpCount.classList.toggle('hidden', count === 0);
  }

  jumpToLatest() {
    const box = this.chatMessages;
    const behavior = scrollBehavior();
    box.scrollTo({ top: box.scrollHeight, behavior });
  }

  loadOlder() {
    const box = this.chatMessages;
    const fromBottom = box.scrollHeight - box.scrollTop;
    this.limit += PAGE_SIZE;
    this.renderMessages(false);
    box.scrollTop = box.scrollHeight - fromBottom;
  }

  toggleSearch() {
    const isHidden = this.searchBar.classList.toggle('hidden');
    this.searchBtn.classList.toggle('active', !isHidden);
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

  saveDraft() {
    const text = this.messageInput.value;
    if (text) this.drafts.set(this.chat, text);
    else this.drafts.delete(this.chat);
    writeMap(DRAFTS_KEY, this.drafts);
    resizeInput(this.messageInput);
  }

  restoreDraft() {
    this.messageInput.value = this.drafts.get(this.chat) ?? '';
    resizeInput(this.messageInput);
    this.renderPending();
  }

  pendingOf(chat) {
    return this.pending.get(chat) ?? [];
  }

  writePost(feed, text, files) {
    const lines = text.split('\n');
    const id = generateUUID();
    this.attachFiles(this.replica, feed, id, files);
    const author = this.peerId;
    const nick = this.username;
    const title = lines[0].trim() || files[0].name;
    const content = lines.slice(1).join('\n').trim();
    const timestamp = Date.now();
    const post = { id, feed, author, nick, title, content, timestamp };
    createPost(this.replica, post);
    return id;
  }

  writeMessage(chat, content, replyTo, files) {
    const replica = this.replicaOf(chat);
    const id = generateUUID();
    this.attachFiles(replica, chat, id, files);
    const author = this.peerId;
    const nick = this.username;
    const timestamp = Date.now();
    const message = { id, chat, author, nick, content, timestamp, replyTo };
    createMessage(replica, message);
    return id;
  }

  attachFiles(replica, chat, message, files) {
    const author = this.peerId;
    const created = Date.now();
    for (const file of files) {
      const id = generateUUID();
      attachFile(replica, { ...file, id, chat, message, author, created });
    }
  }

  addFiles(files) {
    const pending = this.pendingOf(this.chat).slice();
    for (const file of files) {
      const isAllowed = file.size > 0 && file.size <= MAX_FILE_SIZE;
      if (isAllowed) {
        pending.push(file);
        continue;
      }
      const text = `${file.name}: files from 1 byte to ${MAX_FILE_MB} MB`;
      this.showNotification(text, 'warning');
    }
    this.pending.set(this.chat, pending);
    this.renderPending();
    this.messageInput.focus();
  }

  removeFile(index) {
    const pending = this.pendingOf(this.chat).toSpliced(index, 1);
    this.pending.set(this.chat, pending);
    this.renderPending();
  }

  renderPending() {
    const items = this.pendingOf(this.chat).map((file, index) => {
      const template = this.pendingFileTemplate;
      const element = cloneTemplate(template, '.pending-file');
      element.title = file.name;
      element.querySelector('.file-name').textContent = file.name;
      element.querySelector('.file-size').textContent = formatSize(file.size);
      element.querySelector('.remove-file').dataset.index = index;
      return element;
    });
    this.pendingList.replaceChildren(...items);
    this.pendingList.classList.toggle('hidden', items.length === 0);
  }

  submit() {
    this.sendMessage().catch((error) => this.report(error));
  }

  async sendMessage() {
    const content = this.messageInput.value.trim();
    const { chat } = this;
    const pending = this.pendingOf(chat);
    const isEmpty = content === '' && pending.length === 0;
    if (isEmpty || !this.hasNick()) return;
    const isFeedOpen = this.channelEntity() === 'feed';
    this.messageInput.value = '';
    this.pending.delete(chat);
    this.saveDraft();
    this.renderPending();
    const files = await Promise.all(pending.map(storeFile));
    if (isFeedOpen) this.writePost(chat, content, files);
    else this.writeMessage(chat, content, '', files);
    this.chatMessages.scrollTop = this.chatMessages.scrollHeight;
    const names = files.map((file) => file.name).join(', ');
    await this.reportDelivery(content || names);
  }

  submitReply() {
    this.sendReply().catch((error) => this.report(error));
  }

  async sendReply() {
    const content = this.replyInput.value.trim();
    if (!content || !this.thread || !this.hasNick()) return;
    this.replyInput.value = '';
    resizeInput(this.replyInput);
    this.writeMessage(this.chat, content, this.thread, []);
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

  toggleReaction(id, reaction) {
    const { chat } = this;
    const replica = this.replicaOf(chat);
    if (!replica.get(id)) return;
    const authors = reactionsOf(replica, chat).get(id)?.get(reaction);
    const author = this.peerId;
    const active = authors?.has(author) !== true;
    setReaction(replica, { chat, message: id, author, reaction, active });
    const verb = active ? 'Added' : 'Removed';
    this.logger.log(`${verb} reaction:`, reaction, 'to message:', id);
  }

  async copyText(id) {
    const record = this.recordOf(id);
    const parts = [record?.title, record?.content].filter(Boolean);
    try {
      await navigator.clipboard.writeText(parts.join('\n'));
      this.showNotification('Copied to clipboard');
    } catch (error) {
      this.report(error);
    }
  }

  downloadFile(id) {
    this.exportFile(id).catch((error) => this.report(error));
  }

  async exportFile(id) {
    const file = this.recordOf(id);
    if (!file) return;
    const blob = await this.loadFile(file);
    if (!blob) {
      const source = isPair(file.chat) ? 'peer' : 'server';
      const text = `File is not available yet, waiting for the ${source}`;
      return void this.showNotification(text, 'warning');
    }
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = file.name;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), REVOKE_MS);
    this.logger.log('Saved file:', file.name);
  }

  async loadFile(file) {
    const local = await readFile(file);
    if (local) return local;
    const isServed = !isPair(file.chat) && this.connected;
    if (!isServed) return null;
    const { checksum } = file;
    const { download } = this.api.files;
    const call = (id) => download({ id, checksum });
    const blob = await readBlob(this.metacom, call).catch(() => null);
    if (!blob) return null;
    await saveFile(file, blob);
    return blob;
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
    const isReconnect = !connected || this.hasConnected;
    const type = connected ? 'info' : 'warning';
    this.hasConnected ||= connected;
    this.logger.log(text);
    if (isReconnect) this.showNotification(text, type);
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
