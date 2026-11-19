import { REACTIONS, ICONS, CHANNELS, GENERAL } from './chat.js';
import { MAX_LENGTH, TEXT_LENGTH, QUOTE_LENGTH } from './chat.js';
import { validate, seed } from './chat.js';
import { pairOf, isPair, directUnit } from './chat.js';
import { isFeed, isPost, labelOf, parseTitle } from './chat.js';
import { saveAuthor, createChannel, describe } from './chat.js';
import { createFolder, setVisibility, placeItem } from './chat.js';
import { createMessage, createPost, setReaction, pin } from './chat.js';
import { startCall as saveCall, endCall as saveCallEnd } from './chat.js';
import { startRecording as saveRecording } from './chat.js';
import { stopRecording as saveRecordingStop } from './chat.js';
import { MAX_FILE_SIZE, attachFile, attachmentsOf } from './chat.js';
import { listChannels, listAuthors, folderTree } from './chat.js';
import { threadsOf, activityOf, reactionsOf, unreadOf } from './chat.js';
import { lineageOf } from './chat.js';
import { rootOf, conversationOf, branchOf } from './replies.js';
import { lanesOf, repliesToMe } from './replies.js';
import { isImage, storeFile, readFile, saveFile } from './files.js';
import { readBlob, onFileStored } from './files.js';
import { timeOf, dateOf, dayKey, dayOf, dayLabel, plural } from './view.js';
import { formatSize, fitSize, readSetting, writeSetting } from './view.js';
import { readMap, writeMap, cloneTemplate, setBadge } from './view.js';
import { fillText, parseBlocks, excerptOf, isEditable } from './view.js';
import { isReducedMotion } from './view.js';
import { CallPreferences } from './call-preferences.js';
import { isIceUrl, readIce, writeIce, buildIce } from './ice.js';
import { Press, Menu, Lightbox, Switcher } from './overlays.js';
import { Replica, Uplink } from './globalstorage.js';
import { generateUUID } from './metautil.js';
import { Mesh } from './mesh.js';
import { Application } from './application.js';
import { CallSession } from './call.js';
import { requestCallNotifications } from './notifications.js';
import { CallStage, RingAlert } from './stage.js';

const TASKS = {
  clear: {
    label: 'clear database',
    busy: 'clearing...',
    request: 'Database clear requested',
    done: 'Database cleared successfully',
    failed: 'Database clear failed',
  },
};

const PANELS = {
  pins: 'Pinned',
  members: 'Members',
  log: 'Log',
  calls: 'Calls',
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
  mine: (app, { chat }) => app.jumpToReply(chat),
};

const beginCall = (app) => {
  requestCallNotifications();
  app.startCall(app.chat).catch((error) => app.report(error));
};

const callUrl = (id, token) => {
  const call = encodeURIComponent(id);
  const base = `${location.origin}/?call=${call}`;
  if (!token) return base;
  return `${base}&t=${encodeURIComponent(token)}`;
};

const readCallLink = () => {
  const params = new URLSearchParams(location.search);
  const call = params.get('call') ?? '';
  if (call === '') return null;
  return { call, token: params.get('t') ?? '' };
};

const fragmentOf = (id) => {
  const selection = window.getSelection();
  const text = selection.toString().trim();
  if (!text || selection.rangeCount === 0) return '';
  const owner = (node) => node?.parentElement?.closest('.message');
  const first = owner(selection.anchorNode);
  const last = owner(selection.focusNode);
  const isInside = first && first === last && first.dataset.id === id;
  return isInside ? text.slice(0, QUOTE_LENGTH).trim() : '';
};

const MESSAGE_ACTIONS = {
  react: (app, id, { dataset }) => app.toggleReaction(id, dataset.reaction),
  reply: (app, id) => app.startReply(id),
  'reply-hover': (app, id) => app.startReply(id, fragmentOf(id)),
  'reply-quote': (app, id) => app.startReply(id, app.menuFragment),
  article: (app, id) => app.openArticle(id),
  focus: (app, id) => app.focusConversation(id),
  counter: (app, id) => app.focusConversation(id, ''),
  quote: (app, id, { dataset }) => app.focusQuoted(dataset.target, id),
  menu: (app, id, button) => app.toggleMenuAt(id, button),
  pin: (app, id) => app.togglePin(id),
  copy: (app, id) => app.copyText(id),
  view: (app, id, { dataset }) => app.viewImage(dataset.file),
  download: (app, id, { dataset }) => app.downloadFile(dataset.file),
  heading: (app, id, { dataset }) => app.scrollToHeading(dataset.heading),
  'join-call': beginCall,
  'call-back': beginCall,
};

const ITEM_KEYS = {
  ArrowUp: (app, item) => app.moveSelection(item, -1),
  ArrowDown: (app, item) => app.moveSelection(item, 1),
  Enter: (app, item) => app.openMenuFor(item),
  r: (app, item) => {
    const { id } = item.dataset;
    app.startReply(id, fragmentOf(id));
  },
  f: (app, item) => app.focusConversation(item.dataset.id),
};

const FOCUS_KEYS = { '[': -1, ']': 1, ArrowUp: -1, ArrowDown: 1 };

const LAYERS = {
  menu: (app) => app.hideMenu(),
  lightbox: (app) => app.lightbox.close(),
  switcher: (app) => app.hideSwitcher(),
  sidebar: (app) => app.app.classList.remove('menu-open'),
  panel: (app) => app.hidePanel(),
  call: (app) => app.callStage?.collapse(),
  callSheet: (app) => app.callStage?.hideSheet(),
  focus: (app) => app.leaveFocus(),
  article: (app) => app.leaveArticle(),
};

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
const UNITS = ['chat', 'cache', 'presence', 'signal', 'files', 'ice', 'call'];
const ITEMS = '.message, .post, .post-article';
const CHAT_ITEMS = '.nav-item[data-id], .nav-item[data-peer]';
const TITLE = 'XXII Chat';
const NARROW = '(max-width: 900px)';
const COARSE = '(pointer: coarse)';
const FLASH_COLOR = 'rgba(255, 97, 0, 0.25)';
const MAX_FILE_MB = MAX_FILE_SIZE / 1024 / 1024;
const PAGE_SIZE = 50;
const GROUP_MS = 5 * 60 * 1000;
const MINUTE_MS = 60 * 1000;
const REVOKE_MS = 10000;
const RETRY_MS = 2000;
const MAX_RETRY_MS = 30000;
const FLASH_MS = 1600;
const MENU_INDENT_PX = 48;
const BOTTOM_PX = 40;
const WIDE_PX = 640;
const WIDE_LANES = 4;
const NARROW_LANES = 2;
const FOCUS_PAGES = 10;
const MAX_INITIALS = 3;
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
const SIDEBAR_KEY = 'xxii:sidebar';
const TAB_KEY = 'xxii:tab';

const tabId = () => {
  const storage = globalThis.sessionStorage;
  if (!storage) return generateUUID();
  const saved = storage.getItem(TAB_KEY);
  if (saved) return saved;
  const id = generateUUID();
  storage.setItem(TAB_KEY, id);
  return id;
};

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

const createHeadingLink = (index, text) => {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'link-btn';
  button.dataset.action = 'heading';
  button.dataset.heading = index;
  button.textContent = `→ ${text.trim()}`;
  return button;
};

const replyTargetOf = (event) => {
  const item = event.target.closest('.message');
  if (!item?.dataset.id) return null;
  const isControl = event.target.closest('button, a, .lane') !== null;
  return isControl ? null : item;
};

const quoteText = (parent, fragment) =>
  parent && fragment ? { ...parent, text: fragment } : parent;

const quoteOf = (id, view) => {
  const parent = view.records.get(id);
  if (!parent) return { id, nick: '', text: 'message is not loaded yet' };
  const files = view.attachments.get(id) ?? [];
  const names = files.map((file) => file.name).join(', ');
  const line = (parent.title ?? parent.content).split('\n')[0];
  const text = line || (names ? `📎 ${names}` : '');
  return { id, nick: parent.nick, text };
};

const articleInfo = (view) => {
  const count = plural(view.shown.length - 1, 'reply', 'replies');
  return `post · ${count}`;
};

const initialsOf = (conversation) => {
  const initials = [];
  for (const reply of conversation) {
    const initial = Array.from(reply.nick ?? '')[0]?.toUpperCase();
    if (!initial || initials.includes(initial)) continue;
    initials.push(initial);
  }
  return initials.slice(0, MAX_INITIALS);
};

const readDrafts = () => {
  const drafts = readMap(DRAFTS_KEY);
  for (const key of drafts.keys()) {
    if (key.includes('/')) drafts.delete(key);
  }
  return drafts;
};

const fillQuote = (button, quote) => {
  button.classList.toggle('hidden', !quote);
  if (!quote) return;
  button.dataset.target = quote.id;
  button.querySelector('.quote-author').textContent = quote.nick;
  button.querySelector('.quote-text').textContent = quote.text;
};

const createLane = (cell) => {
  const lane = document.createElement('i');
  lane.className = `lane ${cell.kind}`;
  if (cell.kind === '') return lane;
  lane.title = cell.title;
  lane.dataset.root = cell.root;
  lane.classList.toggle('cut', cell.cut === true);
  const color = cell.kind === 'overflow' ? 'var(--lane-gray)' : null;
  lane.style.setProperty('--lane', color ?? `var(--lane-${cell.color})`);
  return lane;
};

const fillLanes = (element, cells) => {
  const container = element.querySelector('.lanes');
  container.replaceChildren(...cells.map(createLane));
  element.classList.toggle('laned', cells.length > 0);
  element.style.setProperty('--lanes', cells.length);
};

const selectItem = (item) => {
  item.tabIndex = -1;
  item.addEventListener('blur', () => item.removeAttribute('tabindex'), {
    once: true,
  });
  item.focus({ preventScroll: true });
  item.scrollIntoView({ block: 'nearest' });
};

const readCollapsed = () => {
  const saved = readSetting(COLLAPSED_KEY, '');
  return new Set(saved.split(',').filter(Boolean));
};

const kindOf = (item) => {
  if (item.classList.contains('message')) return 'message';
  if (item.classList.contains('post')) return 'post';
  return 'article';
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

const minutesBetween = (start, end) => {
  const rounded = Math.round((end - start) / MINUTE_MS);
  if (rounded < 1) return 1;
  return rounded;
};

const minutesOf = (record) => minutesBetween(record.timestamp, record.ended);

const recordingLabel = (record, isLive) => {
  const nick = record.nick || 'guest';
  if (typeof record.stopped === 'number') {
    const minutes = minutesBetween(record.timestamp, record.stopped);
    return `● ${nick} recorded ${minutes} min`;
  }
  return isLive ? `● ${nick} recording` : `● ${nick} recorded`;
};

const callLabel = (record, live) => {
  const nick = record.nick ?? '';
  if (typeof record.ended === 'number') {
    const missed = record.peak === 1 && isPair(record.chat);
    if (missed) return `📞 missed call from ${nick}`;
    const minutes = minutesOf(record);
    const names = record.names ?? '';
    return `📞 call · ${minutes} min · ${names}`;
  }
  const time = timeOf(record.timestamp);
  const started = `📞 call · ${nick} · started ${time}`;
  if (!live) return started;
  return `${started} · ${live.count} in call`;
};

const callAction = (record, live) => {
  if (typeof record.ended !== 'number') {
    if (!live) return null;
    return { action: 'join-call', label: 'join' };
  }
  const missed = record.peak === 1 && isPair(record.chat);
  if (!missed) return null;
  return { action: 'call-back', label: 'call back' };
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

const scrollBehavior = () => (isReducedMotion() ? 'auto' : 'smooth');

const isItem = (element) => element?.matches?.(ITEMS) === true;

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

const createIceRow = (server, index) => {
  const row = document.createElement('li');
  row.className = 'ice-server';
  const url = document.createElement('span');
  url.textContent = server.url;
  const remove = document.createElement('button');
  remove.type = 'button';
  remove.className = 'link-btn';
  remove.dataset.index = `${index}`;
  remove.textContent = 'remove';
  row.append(url, remove);
  return row;
};

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
    this.article = '';
    this.focus = null;
    this.timelineOffset = 0;
    this.view = null;
    this.readAt = readMap(READ_KEY);
    this.drafts = readDrafts();
    this.pending = new Map();
    this.quotes = new Map();
    this.fragments = new Map();
    this.menuFragment = '';
    this.backTo = '';
    this.unread = new Map();
    this.mine = new Map();
    this.lastMine = '';
    this.divider = { chat: this.chat, at: this.readAtOf(this.chat) };
    this.collapsed = readCollapsed();
    this.cache = new Map();
    this.laneMax = WIDE_LANES;
    this.laneSlots = new Map();
    this.hotRoot = '';
    this.iceCache = null;
    this.previews = new Map();
    this.loading = new Map();
    this.waiting = new Map();
    this.layers = [];
    this.pops = 0;
    this.menuItem = null;
    this.pointerType = 'mouse';
    this.hasConnected = false;
    this.isRenderScheduled = false;
    this.started = new Promise((resolve) => this.on('ready', resolve));
    this.callStage = null;
    this.callSession = null;
    this.callToken = '';
    this.callLeaving = null;
    this.callHold = false;
    this.liveCalls = new Map();
    this.callBook = null;
    this.callBound = false;
    this.callBinding = null;
    this.callLost = false;
    this.linkReady = null;
    this.synced = false;
    this.ring = new RingAlert({
      answer: (kind) => {
        this.answerRing(kind).catch((error) => this.report(error));
      },
      decline: () => {
        this.declineRing().catch((error) => this.report(error));
      },
    });
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
    const isSidebarHidden = readSetting(SIDEBAR_KEY, '') === 'hidden';
    this.app.classList.toggle('sidebar-hidden', isSidebarHidden);
    this.usernameInput.value = this.username;
    this.preferences = new CallPreferences(
      document.querySelector('.panel-body[data-panel="calls"]'),
      () => this.callStage,
      (text) => this.showNotification(text, 'warning'),
    );
    this.renderIce();
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
    this.versionBtn = byId('version-btn');
    this.clearMessagesBtn = byId('clear-messages-btn');
    this.callsBtn = byId('calls-btn');
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
    this.backBtn = byId('back-btn');
    this.mineBtn = byId('mine-btn');
    this.chatTitle = byId('chat-title');
    this.chatInfo = byId('chat-info');
    this.topicForm = byId('topic-form');
    this.topicInput = byId('topic-input');
    this.callBtn = byId('call-btn');
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
    this.backPill = byId('back-pill');
    this.composer = byId('composer');
    this.messageInput = byId('message-input');
    this.composerInfo = byId('composer-info');
    this.pendingList = byId('pending-files');
    this.replyBar = byId('reply-bar');
    this.replyTarget = byId('reply-target');
    this.replyPrefix = this.replyBar.querySelector('.reply-prefix');
    this.replyAuthor = this.replyBar.querySelector('.reply-author');
    this.replyText = this.replyBar.querySelector('.reply-text');
    this.replyCancel = byId('reply-cancel');
    this.focusBar = byId('focus-bar');
    this.focusPosition = byId('focus-position');
    this.focusPrev = byId('focus-prev');
    this.focusNext = byId('focus-next');
    this.focusClose = byId('focus-close');
    this.attachBtn = byId('attach-btn');
    this.fileInput = byId('file-input');
    this.emojiBtn = byId('emoji-btn');
    this.panelTitle = byId('panel-title');
    this.panelCloseBtn = byId('panel-close-btn');
    this.pinList = byId('pin-list');
    this.memberList = byId('member-list');
    this.icePublicStun = byId('ice-public-stun');
    this.iceForceRelay = byId('ice-force-relay');
    this.iceForm = byId('ice-form');
    this.iceUrl = byId('ice-url');
    this.iceUsername = byId('ice-username');
    this.iceCredential = byId('ice-credential');
    this.iceServers = byId('ice-servers');
    this.palette = byId('palette');
    this.notification = byId('notification');
    this.backdrop = byId('backdrop');
    this.menuElement = byId('menu');
    this.menu = new Menu(this.menuElement, createReactionButtons);
    this.press = new Press({
      hold: (item, x, y) => this.openMenu(item, { x, y }, true),
      swipe: (item) => this.startReply(item.dataset.id),
    });
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
    this.versionBtn.onclick = () => this.handleVersionClick();
    this.clearMessagesBtn.onclick = () => this.clearDatabase();
    this.clearLogBtn.onclick = () => this.logger.clear();
    document.getElementById('close-call-chat').onclick = () =>
      this.callStage?.closeSheet();
    this.callBtn.onclick = () => beginCall(this);
    this.searchBtn.onclick = () => this.toggleSearch();
    this.pinsBtn.onclick = () => this.togglePanel('pins');
    this.membersBtn.onclick = () => this.togglePanel('members');
    this.logBtn.onclick = () => this.togglePanel('log');
    this.callsBtn.onclick = () => this.togglePanel('calls');
    this.icePublicStun.addEventListener('change', () => this.saveIceFlags());
    this.iceForceRelay.addEventListener('change', () => this.saveIceFlags());
    onSubmit(this.iceForm, () => this.addIceServer());
    this.iceServers.addEventListener('click', (event) => {
      const button = event.target.closest('button');
      if (!button) return;
      this.removeIceServer(Number(button.dataset.index));
    });
    this.panelCloseBtn.onclick = () => this.closePanel();
    this.backBtn.onclick = () => this.closeArticle();
    this.mineBtn.onclick = () => this.jumpToReply(this.chat);
    this.chatTitle.onclick = () => this.closeArticle();
    this.replyTarget.onclick = () => this.revealMessage(this.targetId());
    this.replyCancel.onclick = () => this.cancelReply();
    this.focusPrev.onclick = () => this.focusStep(-1);
    this.focusNext.onclick = () => this.focusStep(1);
    this.focusClose.onclick = () => this.closeFocus();
    this.loadMoreBtn.onclick = () => this.loadOlder();
    this.jumpBtn.onclick = () => this.jumpToLatest();
    this.backPill.onclick = () => this.goBack();
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
    this.searchInput.addEventListener('input', () => {
      this.filter = this.searchInput.value.trim().toLowerCase();
      this.renderMessages();
    });
    onSubmit(this.feedForm, () => this.addChannel('feed', this.feedNameInput));
    onSubmit(this.chatForm, () => this.addChannel('chat', this.chatNameInput));
    onSubmit(this.folderForm, () => this.addFolders());
    onSubmit(this.topicForm, () => this.saveDescription());
    onSubmit(this.composer, () => this.submit());
    onSendKey(
      this.messageInput,
      (event) => this.isSendKey(event),
      () => {
        this.submit();
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
    this.messageList.addEventListener('click', (event) => {
      this.handleMessageClick(event);
    });
    this.messageList.addEventListener('pointerdown', (event) => {
      this.startPress(event);
    });
    this.messageList.addEventListener('mousedown', (event) => {
      if (event.detail > 1 && replyTargetOf(event)) event.preventDefault();
    });
    this.messageList.addEventListener('dblclick', (event) => {
      const item = replyTargetOf(event);
      if (item) this.startReply(item.dataset.id);
    });
    this.messageList.addEventListener('contextmenu', (event) => {
      this.handleContextMenu(event);
    });
    this.menuElement.addEventListener('click', (event) => {
      this.handleMenuClick(event);
    });
    this.chatMessages.addEventListener('scroll', () => this.handleScroll());
    this.pinList.addEventListener('click', (event) => this.handlePin(event));
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
    document.addEventListener('pointermove', (event) => this.press.move(event));
    document.addEventListener('pointerup', () => this.press.end());
    document.addEventListener('pointercancel', () => this.press.abort());
    document.addEventListener('click', (event) => this.press.suppress(event), {
      capture: true,
    });
    document.addEventListener('click', (event) => {
      const isPalette = event.target.closest('#palette, #emoji-btn');
      if (!isPalette) this.closePalette();
    });

    this.on('ready', () => {
      const link = readCallLink();
      if (link) this.presentCallLink(link);
      this.startSync();
      this.bindCalls().catch((error) => this.report(error));
    });
    this.on('status', ({ connected }) => {
      this.showStatus(connected);
      if (!connected) {
        this.noteCallDown();
        return;
      }
      this.restoreCall();
    });
    this.on('network', () => this.updateInterface());
    this.on('version', (versions) => this.showVersion(versions));
    this.on('install', () => this.showInstallButton(true));
    this.on('installed', () => this.showInstallButton(false));

    document.addEventListener('visibilitychange', () => {
      if (document.hidden) this.syncUsername();
      else this.scheduleRender();
      this.ring.onVisibility();
    });
    window.addEventListener('resize', () => {
      this.closeMenu();
      if (this.laneMaxOf() !== this.laneMax) this.renderMessages(false);
    });
    this.messageList.addEventListener('pointerover', (event) => {
      this.heatLane(event.target.closest('.lane[data-root]'));
    });
    this.messageList.addEventListener('pointerout', () => this.heatLane(null));
    window.addEventListener('popstate', () => this.handlePopState());
    window.addEventListener('storage', (event) => this.handleStorage(event));
    window.addEventListener('beforeunload', () => this.syncUsername());
    window.addEventListener('pagehide', () => {
      const session = this.callSession;
      if (session) session.leave().catch((error) => this.report(error));
      this.mesh.stop();
    });
  }

  async startSync() {
    const gate = globalThis.__xxiiSyncGate;
    if (gate && typeof gate.then === 'function') await gate;
    const options = { unit: 'chat', name: 'worker', clear: 'follow' };
    this.uplink = new Uplink(this.replica, this.metacom, options);
    this.uplink.on('error', (error) => {
      this.logger.log('Sync with worker failed:', error.message);
    });
    this.uplink.start();
    this.api.chat.on('username', (username) => this.showUsername(username));
    this.api.chat.on('direct', ({ pair }) => this.restoreDirect(pair));
    this.bindCalls().catch((error) => this.report(error));
    try {
      await this.uplink.sync();
      this.synced = true;
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

  countMine() {
    const records = new Map();
    const replicas = [this.replica];
    for (const direct of this.directs.values()) replicas.push(direct.replica);
    for (const replica of replicas) {
      for (const entity of ['message', 'post']) {
        for (const id of replica.keys(entity)) {
          records.set(id, replica.get(id));
        }
      }
    }
    const readAt = (chat) => this.readAtOf(chat);
    return repliesToMe(records, this.peerId, readAt);
  }

  unreadOf(chat) {
    return this.unread.get(chat) ?? 0;
  }

  repliesCount(chat) {
    return this.mine.get(chat)?.length ?? 0;
  }

  jumpToReply(chat) {
    const list = this.mine.get(chat) ?? [];
    if (list.length === 0) return;
    const index = list.indexOf(this.lastMine);
    const reply = list[(index + 1) % list.length];
    this.lastMine = reply;
    if (chat !== this.chat) {
      const peer = this.peerOf(chat);
      if (peer) this.selectDirect(peer);
      else this.selectChat(chat);
    }
    this.focusQuoted(reply);
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
    this.dropArticle();
    this.quotes.clear();
    this.fragments.clear();
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
    this.mine = this.countMine();
    this.markRead(isAtBottom);
    this.renderContacts();
    this.renderChannels();
    this.renderMessages(isAtBottom);
    this.renderPanel();
    this.renderComposer();
    this.updateTitle();
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
    this.setMine(item.querySelector('.mine'), pair);
    this.setCallMark(item, pair);
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
    this.setMine(item.querySelector('.mine'), channel.id);
    const chatId = channel.entity === 'chat' ? channel.id : '';
    this.setCallMark(item, chatId);
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
    const { id, replyTo } = message;
    const isArticle = id === this.article;
    const isRoot = !replyTo && !isArticle && view.replies.has(id);
    const conversation = isRoot ? conversationOf(view.replies, id) : [];
    const replyCount = conversation.length;
    const initials = initialsOf(conversation);
    const isQuoted = Boolean(replyTo) && replyTo !== this.article;
    const parent = isQuoted ? quoteOf(replyTo, view) : null;
    const quote = quoteText(parent, message.quote);
    const files = view.attachments.get(id) ?? [];
    const byReaction = view.reactions.get(id);
    const reactions = this.summarize(byReaction, view.nicks);
    const isContinued = false;
    const lanes = [];
    return {
      isArticle,
      replyCount,
      initials,
      quote,
      files,
      reactions,
      isContinued,
      lanes,
    };
  }

  shownOf(view) {
    const root = view.records.get(this.article);
    if (root) return [root].concat(conversationOf(view.replies, root.id));
    if (!this.filter) return view.items;
    return view.items.filter((message) => this.isMatch(message, view));
  }

  renderMessages(isAtBottom = this.isAtBottom()) {
    const view = this.currentView();
    view.shown = this.shownOf(view);
    this.view = view;
    const isArticleShown = view.records.has(this.article);
    const limit = isArticleShown ? Infinity : this.limit;
    const visible = view.shown.slice(-limit);
    const lanes = this.lanesFor(visible, view);
    const focused = isItem(document.activeElement)
      ? document.activeElement.dataset.id
      : '';
    const cache = new Map();
    const sections = [];
    let section = null;
    let previous = null;
    let day = '';
    let isMarked = false;
    for (let i = 0; i < visible.length; i++) {
      const message = visible[i];
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
      if (message.kind === 'call') {
        section.append(this.createCallCard(message));
        previous = null;
        continue;
      }
      if (message.kind === 'recording') {
        section.append(this.createRecordingCard(message));
        previous = null;
        continue;
      }
      const details = this.detailsOf(message, view);
      details.isContinued = isGrouped(previous, message);
      details.lanes = lanes[i];
      section.append(this.messageElement(message, details, cache));
      previous = message;
      if (!details.isArticle) continue;
      const count = plural(visible.length - 1, 'reply', 'replies');
      section.append(createLabel('replies-divider', count));
      previous = null;
    }
    this.forget(cache);
    this.cache = cache;
    if (sections.length === 0) sections.push(this.createEmpty());
    this.messageList.replaceChildren(...sections);
    const hasOlder = view.shown.length > limit;
    this.loadMoreBtn.classList.toggle('hidden', !hasOlder);
    this.renderHeader(view);
    const box = this.chatMessages;
    if (isAtBottom) box.scrollTop = box.scrollHeight;
    this.renderFocus();
    this.updateJump();
    if (focused) this.selectById(focused);
  }

  laneMaxOf() {
    const isWide = this.messageList.clientWidth > WIDE_PX;
    return isWide ? WIDE_LANES : NARROW_LANES;
  }

  lanesFor(visible, view) {
    this.laneMax = this.laneMaxOf();
    const rows = visible.map((message) => {
      const root = rootOf(view.records, message.id);
      return { id: message.id, root, nick: message.nick };
    });
    return lanesOf(rows, this.laneMax, this.laneSlots);
  }

  heatLane(target) {
    const root = target ? target.dataset.root : '';
    if (root === this.hotRoot) return;
    this.hotRoot = root;
    for (const lane of this.messageList.querySelectorAll('.lane.hot')) {
      lane.classList.remove('hot');
    }
    if (!root) return;
    const selector = `.lane[data-root="${CSS.escape(root)}"]`;
    for (const lane of this.messageList.querySelectorAll(selector)) {
      lane.classList.add('hot');
    }
  }

  isNew(message) {
    const { chat, at } = this.divider;
    const author = message.kind === 'call' ? message.host : message.author;
    const isOthers = author !== this.peerId;
    const isTimeline = chat === this.chat && !this.article;
    return isTimeline && isOthers && message.timestamp > at;
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
    if (!isPost(message)) return this.createMessage(message, details);
    if (details.isArticle) return this.createArticle(message, details);
    return this.createPostCard(message, details);
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
    const nick = message.nick ?? '';
    const title = message.title ?? '';
    const content = message.content ?? '';
    const names = message.names ?? '';
    const files = view.attachments.get(message.id) ?? [];
    const fileNames = files.map((file) => file.name).join(' ');
    const text = `${nick} ${title} ${content} ${names} ${fileNames}`;
    return text.toLowerCase().includes(this.filter);
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

  chatDescription(items) {
    if (!isPair(this.chat)) {
      const description = this.replica.get(this.chat)?.description;
      if (description) return description;
      const isFeedOpen = this.channelEntity() === 'feed';
      const noun = isFeedOpen ? ['post', 'posts'] : ['message', 'messages'];
      const authors = new Set(items.map((message) => message.author));
      const count = plural(items.length, noun[0], noun[1]);
      return `${count}, ${plural(authors.size, 'author', 'authors')}`;
    }
    const peer = this.peerOf(this.chat);
    const link = this.mesh.links.get(peer);
    if (link?.connected) return 'direct messages over webrtc: linked';
    const via = this.mesh.isLeader ? 'waiting for peer' : 'via leader tab';
    return `direct messages over webrtc: ${via}`;
  }

  setMine(button, chat) {
    const count = this.repliesCount(chat);
    button.dataset.chat = chat;
    button.textContent = `↩ ${count}`;
    button.classList.toggle('hidden', count === 0);
  }

  renderHeader(view) {
    this.setMine(this.mineBtn, this.chat);
    const root = view.records.get(this.article);
    this.chatTitle.textContent = this.chatName();
    this.chatTitle.classList.toggle('crumb', Boolean(root));
    this.backBtn.classList.toggle('hidden', !root);
    const info = root ? articleInfo(view) : this.chatDescription(view.items);
    this.chatInfo.textContent = info;
    this.chatInfo.classList.toggle('editable', !root && this.canDescribe());
    this.renderCallButton();
  }

  renderCallButton() {
    const isFeedOpen = this.channelEntity() === 'feed';
    const live = isFeedOpen ? null : this.liveOf(this.chat);
    const label = live ? `join · ${live.count}` : 'call';
    this.callBtn.textContent = label;
    this.callBtn.classList.toggle('hidden', isFeedOpen);
    this.callBtn.classList.toggle('active', live !== null);
  }

  liveOf(chat) {
    for (const item of this.liveCalls.values()) {
      if (item.chat === chat) return item;
    }
    return null;
  }

  setCallMark(item, chat) {
    const mark = item.querySelector('.call-mark');
    const live = chat === '' ? null : this.liveOf(chat);
    mark.classList.toggle('hidden', live === null);
    mark.textContent = live === null ? '' : `📞 ${live.count}`;
  }

  createCallCard(record) {
    const live = this.liveCalls.get(record.id) ?? null;
    const element = document.createElement('div');
    element.className = 'call-card';
    element.dataset.id = record.id;
    const text = document.createElement('span');
    text.textContent = callLabel(record, live);
    element.append(text);
    const choice = callAction(record, live);
    if (!choice) return element;
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'link-btn';
    button.dataset.action = choice.action;
    button.textContent = choice.label;
    element.append(button);
    return element;
  }

  createRecordingCard(record) {
    const isLive = this.liveCalls.has(record.call);
    const element = document.createElement('div');
    element.className = 'call-card recording-card';
    element.dataset.id = record.id;
    element.textContent = recordingLabel(record, isLive);
    return element;
  }

  renderComposer() {
    const isPostMode = this.isPostMode();
    const quote = this.currentQuote();
    const root = this.view?.records.get(this.article);
    const to = quote?.nick || root?.nick;
    const noun = isPostMode ? 'post' : 'message';
    const target = to ? `reply to ${to}` : `new ${noun} to ${this.chatName()}`;
    this.messageInput.placeholder = `> ${target}`;
    this.messageInput.maxLength = isPostMode ? TEXT_LENGTH : MAX_LENGTH;
    const nick = this.username ? `@${this.username}` : 'set your nick first';
    const hint = isPostMode ? ', first line is the title, Ctrl+Enter' : '';
    const mode = this.callStage?.mode;
    const inCall = mode === 'call' || mode === 'mini';
    const keys = inCall ? ' · Ctrl D mic · Ctrl E camera' : '';
    this.composerInfo.textContent = `${nick}${hint}${keys}`;
    this.replyBar.classList.toggle('hidden', !quote);
    if (!quote) return;
    const inConversation = this.focusItems().includes(quote.id);
    this.replyBar.classList.toggle('in-focus', inConversation);
    const prefix = inConversation ? '↩ to conversation:' : 'reply to';
    this.replyPrefix.textContent = prefix;
    this.replyAuthor.textContent = quote.nick;
    this.replyText.textContent = quote.text;
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
    fillLanes(element, details.lanes);
    fillQuote(element.querySelector('.quote'), details.quote);
    this.fillFiles(element.querySelector('.attachments'), details.files);
    this.fillReactions(element.querySelector('.reactions'), details.reactions);
    const { replyCount } = details;
    const replies = element.querySelector('.replies');
    replies.classList.toggle('hidden', replyCount === 0);
    replies.querySelector('.count').textContent = replyCount;
    replies.querySelector('.initials').textContent = details.initials.join(' ');
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
    const links = [];
    for (let i = 0; i < blocks.length; i++) {
      const { isHeading, text } = blocks[i];
      const node = document.createElement(isHeading ? 'h4' : 'p');
      fillText(node, text.trim());
      nodes.push(node);
      if (!isHeading) continue;
      node.dataset.heading = i;
      links.push(createHeadingLink(i, text));
    }
    element.querySelector('.post-text').replaceChildren(...nodes);
    const outline = element.querySelector('.outline');
    outline.replaceChildren(...links);
    outline.classList.toggle('hidden', links.length < 2);
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
    if (this.handleLaneClick(event)) return;
    const item = event.target.closest('[data-id]');
    if (!item) return;
    const { id } = item.dataset;
    const button = event.target.closest('button');
    const isCard = !button && item.classList.contains('post');
    const isLink = event.target.closest('a') !== null;
    if (isCard && !isLink) return void this.openArticle(id);
    const action = MESSAGE_ACTIONS[button?.dataset.action];
    if (action) return void action(this, id, button);
    const hasSelection = window.getSelection().toString() !== '';
    if (!button && !isLink && !hasSelection) this.clickInFocus(id);
  }

  handleLaneClick(event) {
    const lane = event.target.closest('.lane[data-root]');
    if (!lane?.dataset.root) return false;
    this.enterFocus(lane.dataset.root, '');
    return true;
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

  handlePointerDown(event) {
    this.pointerType = event.pointerType;
    const isInside = this.menu.contains(event.target);
    const isHandle = event.target.closest?.('.more') !== null;
    const isOutside = !isInside && !isHandle;
    if (this.menu.isOpen && !this.menu.isLifted && isOutside) this.closeMenu();
  }

  startPress(event) {
    const item = event.target.closest(ITEMS);
    if (!item?.dataset.id) return;
    const canSwipe = item.classList.contains('message');
    this.press.start(event, item, canSwipe);
  }

  handleContextMenu(event) {
    const item = event.target.closest(ITEMS);
    if (!item?.dataset.id) return;
    if (this.menu.isLifted) return void event.preventDefault();
    const isKeyboard = event.target === item && item === document.activeElement;
    if (isKeyboard) {
      event.preventDefault();
      return void this.openMenuFor(item);
    }
    const isTouch = this.pointerType === 'touch';
    const isLink = event.target.closest('a') !== null;
    const hasSelection = window.getSelection().toString() !== '';
    if (!isTouch && (isLink || hasSelection)) return;
    event.preventDefault();
    this.press.cancel();
    const point = { x: event.clientX, y: event.clientY };
    this.openMenu(item, point, isTouch);
  }

  toggleMenuAt(id, button) {
    if (this.menu.target === id) return void this.closeMenu();
    const rect = button.getBoundingClientRect();
    const point = { x: rect.left, y: rect.bottom };
    this.openMenu(button.closest(ITEMS), point, false);
  }

  openMenuFor(item) {
    const rect = item.getBoundingClientRect();
    const point = { x: rect.left + MENU_INDENT_PX, y: rect.bottom };
    this.openMenu(item, point, false);
    this.menu.focus();
  }

  openMenu(item, point, isLifted) {
    const { id } = item.dataset;
    const items = this.menuItems(item);
    const mine = this.mineOf(id);
    this.menuItem?.classList.remove('targeted');
    this.menuItem = item;
    item.classList.add('targeted');
    const lifted = isLifted ? item : null;
    this.menu.open({ id, mine, items, point, item: lifted });
    this.updateBackdrop();
    if (isLifted) this.pushLayer('menu');
  }

  menuItems(item) {
    const { id } = item.dataset;
    const record = this.recordOf(id);
    const kind = kindOf(item);
    const items = [];
    this.menuFragment = fragmentOf(id);
    if (kind === 'post') items.push({ action: 'article', label: 'Open post' });
    else items.push({ action: 'reply', label: 'Reply' });
    if (kind !== 'post' && this.menuFragment) {
      items.push({ action: 'reply-quote', label: 'Reply with quote' });
    }
    const { records, replies } = this.view;
    const hasConversation = replies.has(rootOf(records, id));
    if (kind !== 'post' && hasConversation) {
      items.push({ action: 'focus', label: 'Focus conversation' });
    }
    const pinLabel = record?.pinned ? 'Unpin' : 'Pin';
    items.push({ action: 'pin', label: pinLabel });
    const hasText = Boolean(record?.content || record?.title);
    if (hasText) items.push({ action: 'copy', label: 'Copy text' });
    for (const file of this.view.attachments.get(id) ?? []) {
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
    MESSAGE_ACTIONS[button.dataset.action](this, id, button);
  }

  closeMenu() {
    if (!this.menu.isOpen) return;
    const hasFocus = this.menu.contains(document.activeElement);
    const id = this.menu.target;
    if (this.menu.isLifted) this.closeLayer('menu');
    else this.hideMenu();
    if (hasFocus) this.selectById(id);
  }

  hideMenu() {
    this.menu.close();
    this.menuItem?.classList.remove('targeted');
    this.menuItem = null;
    this.updateBackdrop();
  }

  updateBackdrop() {
    const isLifted = this.menu.isOpen && this.menu.isLifted;
    const isShown = isLifted || this.switcher.isOpen;
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
    if (!isNarrow()) {
      const isHidden = this.app.classList.toggle('sidebar-hidden');
      return void writeSetting(SIDEBAR_KEY, isHidden ? 'hidden' : '');
    }
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
    this.lightbox.open(images, index);
    this.pushLayer('lightbox');
  }

  chatImages() {
    const { shown, attachments } = this.view;
    const images = [];
    for (const message of shown) {
      for (const file of attachments.get(message.id) ?? []) {
        if (isImage(file.mime)) images.push(file);
      }
    }
    return images;
  }

  toggleSwitcher() {
    if (this.switcher.isOpen) return void this.closeLayer('switcher');
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
    const { id } = item.dataset;
    const isUnpin = event.target.closest('.unpin-btn');
    if (isUnpin) return void this.togglePin(id);
    if (isNarrow()) this.closePanel();
    this.revealMessage(id);
  }

  renderPanel() {
    this.app.dataset.panel = this.panel;
    this.pinsBtn.classList.toggle('active', this.panel === 'pins');
    this.membersBtn.classList.toggle('active', this.panel === 'members');
    this.logBtn.classList.toggle('active', this.panel === 'log');
    this.callsBtn.classList.toggle('active', this.panel === 'calls');
    if (!this.panel) return;
    this.panelTitle.textContent = PANELS[this.panel];
    if (this.panel === 'pins') this.renderPins();
    else if (this.panel === 'members') this.renderMembers();
  }

  scrollToHeading(index) {
    const selector = `h4[data-heading="${index}"]`;
    const heading = this.messageList.querySelector(selector);
    const behavior = scrollBehavior();
    heading?.scrollIntoView({ block: 'start', behavior });
  }

  renderPins() {
    const records = Array.from(this.view.records.values());
    const pinned = records.filter((record) => record.pinned === true);
    const messages = pinned.toSorted((a, b) => a.timestamp - b.timestamp);
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
    if (name === 'calls') this.preferences.refresh();
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

  renderIce() {
    const settings = readIce(localStorage);
    this.icePublicStun.checked = settings.publicStun;
    this.iceForceRelay.checked = settings.forceRelay;
    const rows = settings.servers.map(createIceRow);
    this.iceServers.replaceChildren(...rows);
  }

  commitIce(settings) {
    const saved = writeIce(localStorage, settings);
    this.iceCache = null;
    if (!saved) {
      this.showNotification('Could not save network settings', 'error');
    }
    this.renderIce();
    return saved;
  }

  saveIceFlags() {
    const settings = readIce(localStorage);
    const publicStun = this.icePublicStun.checked;
    const forceRelay = this.iceForceRelay.checked;
    this.commitIce({ ...settings, publicStun, forceRelay });
  }

  addIceServer() {
    const url = this.iceUrl.value.trim();
    if (!isIceUrl(url)) {
      const text = 'Use a stun: or turn: URL';
      return void this.showNotification(text, 'warning');
    }
    const settings = readIce(localStorage);
    const username = this.iceUsername.value;
    const credential = this.iceCredential.value;
    const server = { url, username, credential };
    const servers = settings.servers.concat([server]);
    const saved = this.commitIce({ ...settings, servers });
    if (!saved) return;
    this.iceUrl.value = '';
    this.iceUsername.value = '';
    this.iceCredential.value = '';
  }

  removeIceServer(index) {
    if (!Number.isInteger(index)) return;
    const settings = readIce(localStorage);
    const servers = settings.servers.toSpliced(index, 1);
    this.commitIce({ ...settings, servers });
  }

  async iceConfiguration(now = Date.now()) {
    const cache = this.iceCache;
    if (cache && now < cache.freshUntil) return cache.value;
    const host = location.hostname;
    const servers = await this.api.ice.servers({ host });
    const settings = readIce(localStorage);
    const built = buildIce({ servers, settings, now });
    const { iceServers, iceTransportPolicy, freshUntil } = built;
    const value = { iceServers, iceTransportPolicy };
    this.iceCache = { freshUntil, value };
    return value;
  }

  openArticle(id) {
    const root = this.recordOf(id);
    if (!root || !isPost(root)) return;
    if (!this.article) {
      const box = this.chatMessages;
      this.timelineOffset = box.scrollHeight - box.scrollTop;
      this.pushLayer('article');
    }
    this.focus = null;
    this.article = id;
    this.closeSearch();
    this.render();
    this.chatMessages.scrollTop = 0;
    this.updateJump();
  }

  leaveArticle() {
    if (!this.article) return;
    this.focus = null;
    this.article = '';
    this.render();
    const box = this.chatMessages;
    box.scrollTop = box.scrollHeight - this.timelineOffset;
    this.updateJump();
  }

  closeArticle() {
    this.closeFocus();
    if (this.article) this.closeLayer('article');
  }

  dropArticle() {
    this.dropFocus();
    if (!this.article) return;
    this.article = '';
    this.popLayer('article');
  }

  focusItems() {
    const { focus, view } = this;
    if (!focus || !view) return [];
    const root = view.records.has(focus.root) ? [focus.root] : [];
    const replies = conversationOf(view.replies, focus.root);
    return root.concat(replies.map((reply) => reply.id));
  }

  chosenOf() {
    const ids = this.focusItems();
    const chosen = this.focus?.chosen;
    if (ids.includes(chosen)) return chosen;
    return ids.at(-1) ?? '';
  }

  focusConversation(id, chosen = id) {
    const view = this.view;
    if (!view?.records.has(id)) return;
    const root = rootOf(view.records, id);
    if (view.replies.has(root)) return void this.enterFocus(root, chosen);
    this.showNotification('No replies to focus on yet', 'warning');
  }

  focusQuoted(id, from = '') {
    const { records } = this.view;
    if (!records.has(id)) {
      const text = 'The message is not loaded yet';
      return void this.showNotification(text, 'warning');
    }
    const root = rootOf(records, id);
    const record = records.get(root);
    const isCard = record && isPost(record) && this.article !== root;
    if (isCard) this.openArticle(root);
    this.enterFocus(root, id);
    const isFar = this.isFar(id);
    this.flash(id);
    if (isFar && from) this.showBack(from);
    else this.hideBack();
  }

  isFar(id) {
    const element = this.itemOf(id);
    if (!element) return true;
    const rect = element.getBoundingClientRect();
    const box = this.chatMessages.getBoundingClientRect();
    return rect.bottom < box.top || rect.top > box.bottom;
  }

  loadThrough(id) {
    const { items } = this.view;
    const index = items.findIndex((message) => message.id === id);
    if (index < 0) return;
    const pages = Math.ceil((items.length - index) / PAGE_SIZE);
    const most = this.limit + FOCUS_PAGES * PAGE_SIZE;
    this.limit = Math.max(this.limit, Math.min(pages * PAGE_SIZE, most));
  }

  enterFocus(root, chosen) {
    const isNew = this.focus === null;
    if (isNew) this.closeSearch();
    const box = this.chatMessages;
    const offset = isNew ? box.scrollHeight - box.scrollTop : this.focus.offset;
    const fromBottom = box.scrollHeight - box.scrollTop;
    this.focus = { root, chosen, offset, cleared: false };
    if (isNew) this.pushLayer('focus');
    if (!this.article) this.loadThrough(root);
    this.renderMessages(false);
    box.scrollTop = box.scrollHeight - fromBottom;
    this.renderComposer();
  }

  leaveFocus() {
    this.hideBack();
    if (!this.focus) return;
    const { offset } = this.focus;
    this.focus = null;
    this.renderMessages(false);
    this.renderComposer();
    const box = this.chatMessages;
    box.scrollTop = box.scrollHeight - offset;
    this.updateJump();
  }

  closeFocus() {
    if (this.focus) this.closeLayer('focus');
  }

  dropFocus() {
    if (!this.focus) return;
    this.focus = null;
    this.popLayer('focus');
  }

  renderFocus() {
    const list = this.messageList;
    const { focus, view } = this;
    list.classList.toggle('focusing', focus !== null);
    const items = list.querySelectorAll(`${ITEMS}, .call-card`);
    const members = new Set(this.focusItems());
    const chosen = this.chosenOf();
    const branch = focus
      ? new Set(branchOf(view.records, view.replies, chosen))
      : new Set();
    for (const item of items) {
      const { id } = item.dataset;
      const isArticle = item.classList.contains('post-article');
      const isMember = members.has(id) || isArticle;
      item.classList.toggle('dim', focus !== null && !isMember);
      item.classList.toggle('branch', focus !== null && branch.has(id));
    }
    for (const lane of list.querySelectorAll('.lane[data-root]')) {
      lane.classList.toggle('bold', lane.dataset.root === focus?.root);
    }
    this.renderFocusBar();
  }

  renderFocusBar() {
    this.focusBar.classList.toggle('hidden', this.focus === null);
    if (!this.focus) return;
    const ids = this.focusItems();
    const index = ids.indexOf(this.chosenOf());
    this.focusPosition.textContent = `${index + 1} of ${ids.length}`;
    this.focusPrev.disabled = index <= 0;
    this.focusNext.disabled = index >= ids.length - 1;
  }

  focusStep(step) {
    if (!this.focus) return;
    const ids = this.focusItems();
    const index = ids.indexOf(this.chosenOf()) + step;
    if (index < 0 || index >= ids.length) return;
    const id = ids[index];
    this.focus.chosen = id;
    this.renderFocus();
    const element = this.itemOf(id);
    if (!element) return;
    element.scrollIntoView({ block: 'center', behavior: scrollBehavior() });
    if (isItem(document.activeElement)) selectItem(element);
  }

  clickInFocus(id) {
    if (!this.focus) return;
    const isMember = this.focusItems().includes(id);
    const element = this.itemOf(id);
    const isArticle = element?.classList.contains('post-article');
    if (!isMember && !isArticle) return void this.closeFocus();
    this.focus.chosen = id;
    this.setQuote(id);
    this.renderFocus();
  }

  targetId() {
    const explicit = this.quotes.get(this.chat) ?? '';
    if (explicit || !this.focus || this.focus.cleared) return explicit;
    return this.focusItems().at(-1) ?? '';
  }

  currentQuote() {
    const id = this.targetId();
    const quote = id && this.view ? quoteOf(id, this.view) : null;
    const fragment = this.fragments.get(this.chat);
    if (quote && fragment) quote.text = fragment;
    return quote;
  }

  setQuote(id, fragment = '') {
    if (id && this.focus) this.focus.cleared = false;
    if (id) this.quotes.set(this.chat, id);
    else this.quotes.delete(this.chat);
    if (id && fragment) this.fragments.set(this.chat, fragment);
    else this.fragments.delete(this.chat);
    this.renderComposer();
  }

  cancelReply() {
    if (this.focus) this.focus.cleared = true;
    this.setQuote('');
  }

  startReply(id, fragment = '') {
    const record = this.recordOf(id);
    if (!record) return;
    const isCard = isPost(record) && id !== this.article;
    if (isCard) return void this.openArticle(id);
    const isPlain = id === this.article && !this.focus;
    this.setQuote(isPlain ? '' : id, fragment);
    this.messageInput.focus();
  }

  goBack() {
    const id = this.backTo;
    this.hideBack();
    if (id) this.flash(id);
  }

  hideBack() {
    this.backTo = '';
    this.backPill.classList.add('hidden');
  }

  showBack(id) {
    this.backTo = id;
    this.backPill.classList.remove('hidden');
  }

  revealMessage(id) {
    const { records } = this.view;
    const lineage = lineageOf(records, id);
    if (lineage.length === 0) {
      const text = 'The message is not loaded yet';
      return void this.showNotification(text, 'warning');
    }
    const root = records.get(lineage.at(-1));
    const isInArticle = this.article !== '' && lineage.includes(this.article);
    if (!isInArticle && isPost(root)) this.openArticle(root.id);
    else if (!isInArticle) this.showInTimeline(id);
    this.flash(id);
  }

  showInTimeline(id) {
    this.closeArticle();
    this.closeSearch();
    const { items } = this.view;
    const index = items.findIndex((message) => message.id === id);
    const fromEnd = items.length - index;
    if (index < 0 || fromEnd <= this.limit) return;
    this.limit = Math.ceil(fromEnd / PAGE_SIZE) * PAGE_SIZE;
    this.renderMessages(false);
  }

  flash(id) {
    const element = this.itemOf(id);
    if (!element) return;
    element.scrollIntoView({ block: 'center', behavior: scrollBehavior() });
    const from = { backgroundColor: FLASH_COLOR };
    const to = { backgroundColor: 'transparent' };
    element.animate([from, to], { duration: FLASH_MS, easing: 'ease-in' });
  }

  itemOf(id) {
    const selector = `[data-id="${CSS.escape(id)}"]`;
    return this.messageList.querySelector(selector);
  }

  selectById(id) {
    const item = this.itemOf(id);
    if (item) selectItem(item);
    else this.messageInput.focus();
  }

  selectLast() {
    const items = this.messageList.querySelectorAll(ITEMS);
    const last = items[items.length - 1];
    if (last) selectItem(last);
  }

  moveSelection(item, step) {
    const items = Array.from(this.messageList.querySelectorAll(ITEMS));
    const index = items.indexOf(item) + step;
    if (index >= items.length) return void this.messageInput.focus();
    if (index >= 0) return void selectItem(items[index]);
    if (this.loadMoreBtn.classList.contains('hidden')) return;
    const { id } = item.dataset;
    this.loadOlder();
    const current = this.itemOf(id);
    if (current) this.moveSelection(current, step);
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
    const hasModifier = event.ctrlKey || event.metaKey || event.altKey;
    const isEmpty = this.messageInput.value === '';
    const isComposer = event.target === this.messageInput;
    const isUp = event.key === 'ArrowUp' && !hasModifier && !event.shiftKey;
    if (isComposer && isEmpty && isUp) {
      event.preventDefault();
      if (this.focus) return void this.selectById(this.chosenOf());
      return void this.selectLast();
    }
    const isOverlay = this.menu.isOpen || this.switcher.isOpen;
    const isTyping = isEditable(event.target);
    const isFocusKey = this.focus && !hasModifier && !isOverlay && !isTyping;
    const focusStep = isFocusKey && FOCUS_KEYS[event.key];
    if (focusStep) {
      event.preventDefault();
      return void this.focusStep(focusStep);
    }
    const key = event.key.length === 1 ? event.key.toLowerCase() : event.key;
    const itemAction = isItem(event.target) && !hasModifier && ITEM_KEYS[key];
    if (itemAction) {
      event.preventDefault();
      return void itemAction(this, event.target);
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
    if (isItem(document.activeElement)) return void this.messageInput.focus();
    if (this.quotes.get(this.chat)) return void this.setQuote('');
    if (this.focus) return void this.closeFocus();
    if (this.article) return void this.closeArticle();
    if (this.panel && isNarrow()) return void this.closePanel();
    this.toggleSidebar();
  }

  selectChat(id) {
    const stage = this.callStage;
    const other = stage?.mode === 'call' && id !== stage.chat;
    if (other && !this.callHold) stage.collapse();
    this.chat = id;
    this.limit = PAGE_SIZE;
    const at = this.unreadOf(id) > 0 ? this.readAtOf(id) : Infinity;
    this.divider = { chat: id, at };
    writeSetting(CHAT_KEY, id);
    this.closeSidebar();
    this.dropArticle();
    this.hideBack();
    this.closeMenu();
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
    if (this.menu.isOpen && !this.menu.isLifted) this.closeMenu();
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

  closeSearch() {
    const isOpen = !this.searchBar.classList.contains('hidden');
    if (isOpen) this.toggleSearch();
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
    if (this.article || !this.canDescribe()) return;
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

  isPostMode() {
    return !this.article && this.channelEntity() === 'feed';
  }

  isSendKey(event) {
    if (!this.isPostMode()) return !event.shiftKey;
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

  pendingOf(key) {
    return this.pending.get(key) ?? [];
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

  writeMessage(chat, content, replyTo, files, quote = '') {
    const replica = this.replicaOf(chat);
    const id = generateUUID();
    this.attachFiles(replica, chat, id, files);
    const author = this.peerId;
    const nick = this.username;
    const timestamp = Date.now();
    const message = { id, chat, author, nick, content, timestamp, replyTo };
    if (quote) message.quote = quote;
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
    const files = this.pendingOf(this.chat);
    const items = files.map((file, index) => {
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
    const { chat, focus } = this;
    const pending = this.pendingOf(chat);
    const isEmpty = content === '' && pending.length === 0;
    if (isEmpty || !this.hasNick()) return;
    const isPostMode = this.isPostMode();
    const replyTo = this.targetId() || this.article;
    const quote = this.fragments.get(chat) ?? '';
    const isInside = this.focusItems().includes(replyTo);
    const isEnding = focus !== null && (focus.cleared || !isInside);
    this.messageInput.value = '';
    this.pending.delete(chat);
    this.quotes.delete(chat);
    this.fragments.delete(chat);
    this.saveDraft();
    this.renderPending();
    this.renderComposer();
    const files = await Promise.all(pending.map(storeFile));
    const id = isPostMode
      ? this.writePost(chat, content, files)
      : this.writeMessage(chat, content, replyTo, files, quote);
    if (isEnding) this.closeFocus();
    else if (this.focus) this.focus.chosen = id;
    this.chatMessages.scrollTop = this.chatMessages.scrollHeight;
    const names = files.map((file) => file.name).join(', ');
    await this.reportDelivery(content || names);
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

  showVersion({ version, next }) {
    const button = this.versionBtn;
    button.textContent = next ? `v${version} → v${next}` : `v${version}`;
    button.classList.toggle('active', next !== '');
    button.title = next
      ? 'Update is ready, restarts when idle; click to restart now'
      : 'Updates install automatically; click to check now';
  }

  handleVersionClick() {
    const action = this.nextVersion ? this.restart() : this.checkNow();
    action.catch((error) => this.report(error));
  }

  async checkNow() {
    this.versionBtn.disabled = true;
    try {
      const next = await this.checkUpdate(true);
      const text = next
        ? `Version ${next} is ready`
        : 'This is the latest version';
      this.showNotification(text);
    } finally {
      this.versionBtn.disabled = false;
    }
  }

  canRestart() {
    const hasFiles = Array.from(this.pending.values()).some(
      (files) => files.length > 0,
    );
    const isBusy = this.lightbox.isOpen || this.menu.isOpen;
    const isFree = !hasFiles && !isBusy && !this.switcher.isOpen;
    return isFree && super.canRestart();
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

  callTitle(chat) {
    const current = this.chat;
    if (current === chat) return this.chatName();
    this.chat = chat;
    const title = this.chatName();
    this.chat = current;
    return title;
  }

  ensureCallStage() {
    if (this.callStage) return this.callStage;
    const hooks = {
      preferences: this.preferences,
      closeSettings: () => this.closePanel(),
      settings: () => {
        this.showPanel('calls');
        this.panelCloseBtn.focus();
      },
      pushLayer: (name) => {
        if (!this.layers.includes(name)) this.pushLayer(name);
      },
      popLayer: (name) => this.popLayer(name),
      nick: () => this.username,
      hasNick: () => this.username !== '',
      saveNick: (nick) => {
        this.usernameInput.value = nick;
        this.syncUsername();
      },
      titleOf: (chat) => this.callTitle(chat),
      update: (flags) => this.pushCallState(flags),
      recordStart: (record) => this.recordRecordingStart(record),
      recordStop: (record) => this.recordRecordingStop(record),
      confirm: (text) => window.confirm(text),
      focusChat: (id) => this.focusCallChat(id),
      changed: () => this.scheduleRender(),
      fail: (error) => this.report(error),
      notice: (text, region) => this.showNotification(text, 'warning', region),
      admit: (call, endpoint) => this.api.call.admit({ call, endpoint }),
      deny: (call, endpoint) => this.api.call.deny({ call, endpoint }),
      host: (args) => this.api.call.host(args),
      end: (call) => this.api.call.end({ call }),
      copyLink: (call) => this.copyCallLink(call),
      ready: () => this.linkReady ?? Promise.resolve(),
      closed: () => {
        this.callSession = null;
      },
      leave: () => this.closeCall(),
      isText: (element) => isEditable(element),
      before: (node) => this.chatView.before(node),
      listen: (listener) => this.api.call.on('state', listener),
      unlisten: (listener) => this.api.call.off('state', listener),
    };
    this.callStage = new CallStage(this.app, hooks);
    return this.callStage;
  }

  bindCalls() {
    if (this.callBound) return Promise.resolve();
    this.attachCallEvents();
    if (this.callBound) return Promise.resolve();
    if (this.callBinding) return this.callBinding;
    this.callBinding = this.openCallEvents();
    return this.callBinding;
  }

  noteCallDown() {
    if (!this.hasConnected) return;
    const session = this.callSession;
    const phase = session?.phase ?? '';
    const joined = phase === 'joined';
    const live = joined || phase === 'reconnecting';
    if (!live) return;
    this.callLost = true;
    session.hold();
  }

  restoreCall() {
    const run = async () => {
      await this.bindCalls();
      const mesh = this.mesh;
      if (mesh?.connected && this.connected) await mesh.attach();
      await this.resumeCall();
    };
    run().catch((error) => this.report(error));
  }

  async resumeCall() {
    if (!this.callLost) return;
    this.callLost = false;
    const session = this.callSession;
    const phase = session?.phase ?? '';
    const joined = phase === 'joined';
    const live = joined || phase === 'reconnecting';
    if (!session || !live) return;
    const stored = this.replicaOf(session.chat).get(session.call);
    const started = stored?.timestamp;
    const host = typeof stored?.host === 'string' ? stored.host : '';
    const named = typeof stored?.chat === 'string';
    const chat = named ? stored.chat : session.chat;
    const call = session.call;
    const token = this.callToken;
    const record = { call, chat, host, started, token };
    await session.resume(record);
  }

  async openCallEvents() {
    try {
      if (this.callBound || !this.metacom?.active) return;
      await this.metacom.load('call');
      this.attachCallEvents();
    } finally {
      this.callBinding = null;
    }
  }

  onCallActive(data) {
    if (!data || typeof data.call !== 'string') return;
    const call = data.call;
    if (data.ended === true) {
      this.liveCalls.delete(call);
      this.markBookEnded(call);
      this.ring.stop(call);
    } else {
      const chat = typeof data.chat === 'string' ? data.chat : '';
      const count = typeof data.count === 'number' ? data.count : 0;
      const started = typeof data.started === 'number' ? data.started : 0;
      this.liveCalls.set(call, { call, chat, count, started });
      this.raisePeak(call, count);
      if (count >= 2) this.ring.stop(call);
    }
    this.scheduleRender();
  }

  onCallEnded(data) {
    const call = data?.call;
    if (typeof call !== 'string') return;
    const stage = this.callStage;
    if (stage?.session?.call === call && data.by) {
      const text = `${stage.nickOf(data.by)} ended the call`;
      this.showNotification(text, 'info', stage.announcements);
    }
    this.liveCalls.delete(call);
    this.markBookEnded(call);
    this.ring.stop(call);
    this.dropPrejoin(call);
    this.scheduleRender();
  }

  async loadLiveCalls() {
    const list = await this.api.call.active();
    if (!Array.isArray(list)) return;
    for (const item of list) this.onCallActive(item);
  }

  noteRoster(state) {
    const book = this.callBook;
    if (!book || !state || state.call !== book.id) return;
    const list = Array.isArray(state.participants) ? state.participants : [];
    if (list.length > book.peak) book.peak = list.length;
    for (const item of list) {
      const nick = typeof item.nick === 'string' ? item.nick : '';
      if (nick === '' || book.names.includes(nick)) continue;
      book.names.push(nick);
    }
  }

  raisePeak(call, count) {
    const book = this.callBook;
    if (!book || book.id !== call) return;
    if (count > book.peak) book.peak = count;
  }

  markBookEnded(call) {
    const book = this.callBook;
    if (!book || book.id !== call) return;
    book.ended = true;
    if (book.phase === 'idle') this.writeCallEnd(book);
  }

  beginCallBook(id, chat, isHost, nick) {
    const names = [];
    if (nick) names.push(nick);
    this.callBook = {
      id,
      chat,
      isHost,
      joined: false,
      ended: false,
      closed: false,
      phase: '',
      peak: 1,
      names,
    };
  }

  storedTitle(chat) {
    if (isPair(chat)) return '';
    const name = this.replica.get(chat)?.name;
    if (typeof name !== 'string') return '';
    return name;
  }

  recordCallStart(chat, opened) {
    const state = opened.state;
    const id = opened.id;
    const host = this.peerId;
    const nick = this.username;
    const started = state?.started;
    const timestamp = typeof started === 'number' ? started : Date.now();
    const title = this.storedTitle(chat);
    const record = { id, chat, host, nick, timestamp, title };
    saveCall(this.replicaOf(chat), record);
    this.beginCallBook(id, chat, true, nick);
    if (state) this.noteRoster(state);
  }

  prepareJoinedCall(chat, id) {
    this.beginCallBook(id, chat, false, this.username);
    const live = this.liveOf(chat);
    if (!live || live.call !== id) return;
    if (live.count > this.callBook.peak) this.callBook.peak = live.count;
  }

  followCall(session) {
    const book = this.callBook;
    if (!book || book.id !== session.call) return;
    if (session.phase === 'joined') book.joined = true;
    book.phase = session.phase;
    const onPhase = (phase) => {
      book.phase = phase;
      if (phase === 'joined') book.joined = true;
      if (phase !== 'idle') return;
      session.off('state', onPhase);
      this.writeCallEnd(book);
    };
    session.on('state', onPhase);
  }

  writeCallEnd(book) {
    if (book.closed || !book.joined || !book.ended) return;
    const replica = this.replicaOf(book.chat);
    const current = replica.get(book.id);
    book.closed = true;
    if (typeof current?.ended === 'number') return;
    const ended = Date.now();
    const peak = book.peak > 0 ? book.peak : 1;
    const names = book.names.join(', ');
    saveCallEnd(replica, book.id, { ended, peak, names });
  }

  async existingCall(error, chat) {
    if (error?.code !== 'call/exists') return '';
    if (typeof error.cause === 'string' && error.cause !== '') {
      return error.cause;
    }
    const list = await this.api.call.active();
    if (!Array.isArray(list)) return '';
    for (const item of list) {
      if (item.chat === chat) return item.call;
    }
    return '';
  }

  async openCall(chat, endpoint, nick) {
    try {
      const result = await this.api.call.start({ chat, endpoint, nick });
      const state = result?.state ?? null;
      const id = state?.call;
      const token = typeof result?.token === 'string' ? result.token : '';
      if (typeof id !== 'string' || id === '') {
        throw new Error('Call did not start');
      }
      return { id, token, state, created: true };
    } catch (error) {
      const id = await this.existingCall(error, chat);
      if (!id) throw error;
      return { id, token: '', state: null, created: false };
    }
  }

  async closeCall() {
    this.linkReady = null;
    if (this.callLeaving) await this.callLeaving;
    const session = this.callStage?.session;
    if (!session) return;
    this.callStage.detach();
    const leaving = session.leave().catch((error) => this.report(error));
    this.callLeaving = leaving;
    try {
      await leaving;
    } finally {
      if (this.callLeaving === leaving) this.callLeaving = null;
    }
  }

  attachCallEvents() {
    if (this.callBound) return;
    const call = this.api?.call;
    if (!call?.on) return;
    this.callBound = true;
    call.on('active', (data) => this.onCallActive(data));
    call.on('state', (data) => this.noteRoster(data));
    call.on('ended', (data) => this.onCallEnded(data));
    call.on('ring', (data) => this.onRing(data));
    call.on('ringing', (data) => this.onRinging(data));
    this.loadLiveCalls().catch((error) => this.report(error));
  }

  onRing(data) {
    if (!data || typeof data.call !== 'string') return;
    const from = data.from ?? {};
    const nick = typeof from.nick === 'string' ? from.nick : '';
    const peer = typeof from.peer === 'string' ? from.peer : '';
    const chat = typeof data.chat === 'string' ? data.chat : '';
    const tab = tabId();
    this.ring.show({ call: data.call, chat, nick, peer, tab });
  }

  onRinging(data) {
    const call = data?.call;
    const state = data?.state;
    if (typeof call !== 'string') return;
    const missed = state === 'declined' || state === 'missed';
    if (!missed) return;
    this.recordMissed(call);
  }

  recordMissed(call) {
    const book = this.callBook;
    if (!book || book.id !== call || book.closed) return;
    if (!isPair(book.chat)) return;
    book.ended = true;
    if (book.peak > 1) return;
    book.peak = 1;
    const replica = this.replicaOf(book.chat);
    const current = replica.get(book.id);
    if (typeof current?.ended === 'number') {
      book.closed = true;
      return;
    }
    book.closed = true;
    const ended = Date.now();
    const names = book.names.join(', ');
    saveCallEnd(replica, book.id, { ended, peak: 1, names });
    this.scheduleRender();
  }

  async answerRing(kind) {
    const chat = this.ring.chat;
    if (chat === '') return;
    requestCallNotifications();
    const camera = kind === 'video';
    await this.startCall(chat, { camera });
  }

  async declineRing() {
    const call = this.ring.call;
    if (call === '') return;
    this.ring.stop(call);
    await this.api.call.decline({ call });
  }

  dropPrejoin(call) {
    const stage = this.callStage;
    const session = stage?.session;
    if (!session || session.call !== call) return;
    if (stage.mode !== 'prejoin') return;
    stage.detach();
  }

  presentCallLink(link) {
    this.attachCallEvents();
    const endpoint = `${this.peerId}:${tabId()}`;
    const ice = () => this.iceConfiguration();
    const session = new CallSession({
      api: this.api,
      endpoint,
      call: link.call,
      chat: '',
      ice,
      pagehide: false,
    });
    const token = link.token;
    if (token !== '') this.callToken = token;
    const stage = this.ensureCallStage();
    stage.attach(session, token, true);
    this.callSession = session;
    session.begin();
    this.linkReady = this.finishCallLink(session);
  }

  async finishCallLink(session) {
    await this.mesh.greet();
    if (this.callSession !== session) return;
    const list = await this.api.call.active();
    if (this.callSession !== session || !Array.isArray(list)) return;
    const preview = list.find((item) => item.call === session.call) ?? null;
    const chat = typeof preview?.chat === 'string' ? preview.chat : '';
    if (chat) {
      session.chat = chat;
      this.prepareJoinedCall(chat, session.call);
      this.followCall(session);
    }
    this.callStage?.applyPreview(preview);
  }

  async copyCallLink(call) {
    const result = await this.api.call.link({ call });
    const token = typeof result?.token === 'string' ? result.token : '';
    const url = callUrl(call, token);
    const write = navigator.clipboard?.writeText;
    if (!write) return url;
    try {
      await write.call(navigator.clipboard, url);
      this.showNotification('Link copied');
    } catch (error) {
      this.logger.log('Clipboard:', error.message);
    }
    return url;
  }

  async startCall(chat, options = {}) {
    await this.closeCall();
    await this.bindCalls();
    this.attachCallEvents();
    const endpoint = `${this.peerId}:${tabId()}`;
    const nick = this.username;
    const opened = await this.openCall(chat, endpoint, nick);
    const given = options.token;
    const hasToken = typeof given === 'string' && given !== '';
    const token = hasToken ? given : opened.token;
    const camera = options.camera !== false;
    if (token !== '') this.callToken = token;
    if (opened.created) this.recordCallStart(chat, opened);
    else this.prepareJoinedCall(chat, opened.id);
    const ice = () => this.iceConfiguration();
    const session = new CallSession({
      api: this.api,
      endpoint,
      call: opened.id,
      chat,
      ice,
      pagehide: false,
    });
    const stage = this.ensureCallStage();
    stage.attach(session, token, camera);
    this.callSession = session;
    this.followCall(session);
    session.begin();
    if (opened.state) stage.onCallState(opened.state);
  }

  focusCallChat(id) {
    if (!id || this.chat === id) return;
    this.callHold = true;
    this.selectChat(id);
    this.callHold = false;
  }

  async pushCallState(flags) {
    const session = this.callSession;
    if (!session) return;
    const call = session.call;
    const endpoint = session.endpoint;
    const args = { call, endpoint };
    const names = ['mic', 'camera', 'screen', 'hand', 'recording', 'optOut'];
    for (const name of names) {
      if (typeof flags[name] === 'boolean') args[name] = flags[name];
    }
    await this.api.call.update(args);
  }

  recordRecordingStart({ id, chat, call, timestamp }) {
    const author = this.peerId;
    const nick = this.username;
    const record = { id, chat, call, author, nick, timestamp };
    saveRecording(this.replicaOf(chat), record);
  }

  recordRecordingStop({ id, chat, stopped }) {
    saveRecordingStop(this.replicaOf(chat), id, { stopped });
  }

  showNotification(message, type = 'info', region = this.notification) {
    const separate = region !== this.notification;
    this.notification.setAttribute('aria-live', separate ? 'off' : 'polite');
    if (separate) region.textContent = message;
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
