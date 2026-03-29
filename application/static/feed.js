import { Application } from './application.js';
import { Logger } from './logger.js';
import { Notification } from './ui-common.js';

class FeedsApplication extends Application {
  constructor(config = {}) {
    super(config);
    this.logger = new Logger('output');
    this.room = 'sync';
    this.feeds = new Map();
    this.username = '';
    this.notification = new Notification();
  }

  getElements() {
    this.statusEl = document.getElementById('connection-status');
    this.createFeedBtn = document.getElementById('create-feed-btn');
    this.feedInput = document.getElementById('new-feed-name');
    this.usernameInput = document.getElementById('username-input');
    this.publishBtn = document.getElementById('publish-btn');
    this.feedsList = document.getElementById('feeds-list');
    this.feedPosts = document.getElementById('feed-posts');
    this.feedTemplate = document.getElementById('feed-template');
    this.postTemplate = document.getElementById('post-template');
    this.feedSelect = document.getElementById('feed-select');
  }

  setupEvents() {
    this.createFeedBtn?.addEventListener('click', () => this.createFeed());
    this.publishBtn?.addEventListener('click', () => this.publishPost());

    if (this.usernameInput) {
      this.usernameInput.addEventListener('blur', () => this.syncUsername());
      this.usernameInput.addEventListener('keypress', (event) => {
        if (event.key === 'Enter') this.syncUsername();
      });
    }

    this.on('status', (data) => this.onStatus(data));
    this.on('network', () => this.updateInterface());
    this.on('metacom-ready', () => this.setupMetacomEvents());

    document.addEventListener('visibilitychange', () => {
      if (document.hidden) this.syncUsername();
    });
    window.addEventListener('beforeunload', () => this.syncUsername());
    window.addEventListener('blur', () => this.syncUsername());
  }

  syncUsername() {
    const username = this.usernameInput?.value?.trim();
    if (!username || username === this.username) return;
    this.username = username;
  }

  async createFeed() {
    if (!this.username) {
      this.showNotification('Enter username first', 'warning');
      return;
    }

    const name = this.feedInput?.value?.trim();
    if (!name) {
      this.showNotification('Enter feed name first', 'warning');
      return;
    }

    let createFeedResult;
    try {
      createFeedResult = await this.metacom.api.feed.createFeed({
        name,
        ownerId: this.username,
      });
    } catch (e) {
      this.showNotification(e.message, 'error');
      return;
    }

    if (!createFeedResult?.record) {
      this.showNotification('Something went wrong', 'error');
      return;
    }

    this.feeds.set(name, createFeedResult.record);
    this.renderFeeds();
    this.showNotification(`Feed '${name}' created`, 'success');
  }

  async subscribeFeed(feedId) {
    if (!this.username) {
      this.showNotification('Enter username first', 'warning');
      return;
    }

    const feed = this.feeds.get(feedId);
    if (!feed) {
      this.showNotification(`Feed ${feedId} not found`, 'error');
      return;
    }

    if (feed.members?.includes(this.username)) {
      this.showNotification(`Already subscribed to ${feedId}`, 'warning');
      return;
    }

    let updateFeedResult;
    try {
      updateFeedResult = await this.metacom.api.feed.subscribeFeed({
        feedId,
        userId: this.username,
      });
    } catch (e) {
      this.showNotification(e.message, 'error');
      return;
    }

    if (!updateFeedResult?.record) {
      this.showNotification('Something went wrong', 'error');
      return;
    }

    this.feeds.set(feedId, updateFeedResult.record);
    this.renderFeeds();
    this.showNotification(
      `User ${this.username} subscribed to feed ${feedId}`,
      'success',
    );
  }

  async unsubscribeFeed(feedId) {
    if (!this.username) {
      this.showNotification('Enter username first', 'warning');
      return;
    }

    const feed = this.feeds.get(feedId);
    if (!feed) {
      this.showNotification(`Feed ${feedId} not found`, 'error');
      return;
    }

    if (!feed.members?.includes(this.username)) {
      this.showNotification(`Not subscribed to ${feedId}`, 'warning');
      return;
    }

    let updateFeedResult;
    try {
      updateFeedResult = await this.metacom.api.feed.unsubscribeFeed({
        feedId,
        userId: this.username,
      });
    } catch (e) {
      this.showNotification(e.message, 'error');
      return;
    }

    if (!updateFeedResult?.record) {
      this.showNotification('Something went wrong', 'error');
      return;
    }

    this.feeds.set(feedId, updateFeedResult.record);
    this.renderFeeds();
    this.showNotification(
      `User ${this.username} unsubscribed from feed ${feedId}`,
      'success',
    );
  }

  async publishPost() {
    const input = document.getElementById('post-input');
    const select = document.getElementById('feed-select');
    const feedId = select?.value;
    const content = input?.value?.trim();

    if (!this.username) {
      this.showNotification('Enter username first', 'warning');
      return;
    }

    if (!feedId) {
      this.showNotification('Select a feed first', 'warning');
      return;
    }

    if (!content) return;

    const postData = {
      title: content.slice(0, 30),
      subtitle: null,
      content,
      feed: feedId,
      author: this.username,
      attachments: [],
      status: 'published',
    };

    const delta = await this.metacom.api.feed.publishPost(postData);
    const post = delta?.record;

    if (!post) {
      this.showNotification('Failed to publish post', 'error');
      return;
    }

    const feed = this.feeds.get(feedId);
    if (feed?.members?.includes(this.username)) {
      this.showPostInFeed(post);
    }

    input.value = '';
    this.showNotification(`Post published to '${feedId}'`, 'success');
  }

  setupMetacomEvents() {
    if (!this.metacom?.api?.chat) return;

    this.metacom.api.chat.subscribe({ room: this.room });
    this.metacom.api.chat.on('delta', (packet) => {
      if (packet?.data) this.handleDelta(packet.data);
    });
  }

  handleDelta(data) {
    const deltas = Array.isArray(data) ? data : [data];

    for (const d of deltas) {
      if (d.entity === 'feed') {
        const prev = this.feeds.get(d.record.id) || {};
        const merged = {
          ...prev,
          ...d.record,
          members: d.record.members ?? prev.members ?? [],
        };
        this.feeds.set(d.record.id, merged);
        this.renderFeeds();
      }

      if (d.entity === 'post') {
        const feed = this.feeds.get(d.record.feed);
        if (feed?.members?.includes(this.username)) {
          this.showPostInFeed(d.record);
        }
      }
    }
  }

  renderFeeds() {
    const list = this.feedsList;
    const template = this.feedTemplate;
    const select = this.feedSelect;

    if (!list || !template) return;

    list.innerHTML = '';
    select.innerHTML = '<option value="">-- select feed --</option>';

    for (const feed of this.feeds.values()) {
      const el = template.content.cloneNode(true);
      const node = el.querySelector('.chat-message');

      const members = feed.members || [];
      const isMember = members.includes(this.username);
      const isOwner = feed.owner === this.username;

      node.querySelector('.feed-name').textContent = feed.name;
      node.querySelector('.feed-owner').textContent =
        `by ${feed.owner || 'unknown'}`;
      node.querySelector('.feed-members').textContent =
        `members: ${members.length}`;

      const subscribeBtn = node.querySelector('.subscribe-btn');
      const unsubscribeBtn = node.querySelector('.unsubscribe-btn');

      subscribeBtn.style.display = isMember ? 'none' : 'inline-block';
      unsubscribeBtn.style.display = isMember ? 'inline-block' : 'none';

      subscribeBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        this.subscribeFeed(feed.id);
      });

      unsubscribeBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        this.unsubscribeFeed(feed.id);
      });

      node.addEventListener('click', () => {
        this.selectFeed?.(feed.id);
      });

      list.appendChild(node);

      if (isOwner) {
        const option = document.createElement('option');
        option.value = feed.id;
        option.textContent = feed.name;
        select.appendChild(option);
      }
    }
  }

  showPostInFeed(post) {
    if (!this.feedPosts) return;

    const el = this.postTemplate.content.cloneNode(true);
    el.querySelector('.post-user').textContent = post.author;
    el.querySelector('.post-time').textContent = new Date(
      post.created,
    ).toLocaleString();
    el.querySelector('.post-content').textContent = post.content;
    el.querySelector('.post-feed').textContent = post.feed;
    this.feedPosts.appendChild(el);
  }

  onStatus(data) {
    this.updateInterface();
    const isConnected = data?.connected;
    this.logger.log(
      `[DEBUG] WebSocket: ${isConnected ? 'connected' : 'disconnected'}`,
    );
  }

  updateInterface() {
    if (!this.statusEl) return;

    const online = this.online ? 'online' : 'offline';
    const connected = this.connected ? 'connected' : 'disconnected';
    this.statusEl.textContent = `${online} / ${connected}`.toUpperCase();
    this.statusEl.className = `status-indicator ${connected}`;
  }

  showNotification(message, type = 'info') {
    this.notification.showNotification(message, type);
  }
}

const app = new FeedsApplication();
export { FeedsApplication, app };
