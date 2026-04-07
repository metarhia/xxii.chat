import { generateUUID } from './metautil.js';
import { Application } from './application.js';
import { Logger } from './logger.js';
import { Notification } from './ui-common.js';

const REACTIONS = { like: 0, dislike: 0, love: 0, smile: 0, poo: 0 };

class ChatApplication extends Application {
  constructor(config = {}) {
    super(config);
    this.logger = new Logger('output');
    this.username = '';
    this.syncTimeout = null;
    this.notification = new Notification();
  }

  getElements() {
    this.installBtn = document.getElementById('install-btn');
    this.updateCacheBtn = document.getElementById('update-cache-btn');
    this.clearBtn = document.getElementById('clear-btn');
    this.clearMessagesBtn = document.getElementById('clear-messages-btn');
    this.sendBtn = document.getElementById('send-btn');
    this.messageInput = document.getElementById('message-input');
    this.usernameInput = document.getElementById('username-input');
    this.connectionStatus = document.getElementById('connection-status');
    this.installStatus = document.getElementById('install-status');
    this.chatMessages = document.getElementById('chat-messages');
    this.messageTemplate = document.getElementById('chat-message-template');
    this.reactionTemplate = document.getElementById('reaction-button-template');
  }

  setupEvents() {
    this.installBtn.onclick = () => this.install();
    this.updateCacheBtn.onclick = () => this.updateCache();
    this.clearBtn.onclick = () => this.logger.clear();
    this.clearMessagesBtn.onclick = () => this.clearDatabase();
    this.sendBtn.onclick = () => this.sendMessage();
    if (this.messageInput) {
      this.messageInput.addEventListener('keypress', (event) => {
        if (event.key === 'Enter') this.sendMessage();
      });
    }
    if (this.usernameInput) {
      this.usernameInput.addEventListener('blur', () => this.syncUsername());
      this.usernameInput.addEventListener('keypress', (event) => {
        if (event.key === 'Enter') this.syncUsername();
      });
    }

    this.on('network', () => this.updateInterface());
    this.on('install', () => this.showInstallButton(true));
    this.on('installed', () => this.showInstallButton(false));
    this.on('status', (data) => this.onStatus(data));
    this.on('cacheUpdated', () => this.onCacheUpdated());
    this.on('cacheUpdateFailed', (data) => this.onCacheUpdateFailed(data));
    this.on('databaseCleared', () => this.onDatabaseCleared());
    this.on('metacom-ready', () => this.setupMetacomEvents());

    document.addEventListener('visibilitychange', () => {
      if (document.hidden) this.syncUsername();
    });
    window.addEventListener('beforeunload', () => this.syncUsername());
    window.addEventListener('blur', () => this.syncUsername());
  }

  setupMetacomEvents() {
    if (!this.metacom?.api?.chat) return;
    this.metacom.api.chat.on('delta', (packet) => {
      if (packet?.data) this.onDelta(packet.data);
    });
  }

  syncUsername() {
    const username = this.usernameInput?.value?.trim();
    if (!username || username === this.username) return;
    this.username = username;
  }

  onStatus(data) {
    this.updateInterface();
    if (data?.connected) {
      this.logger.log('Websocket connected');
      this.showNotification('Websocket connected', 'success');
    } else {
      this.logger.log('Websocket disconnected');
      this.showNotification('Websocket disconnected', 'warning');
    }
  }

  onCacheUpdated() {
    this.logger.log('Cache updated successfully');
    this.showNotification('Cache updated successfully!', 'success');
    if (this.updateCacheBtn) {
      this.updateCacheBtn.disabled = false;
      this.updateCacheBtn.textContent = 'Update Cache';
    }
  }

  onCacheUpdateFailed(data) {
    this.logger.log('Cache update failed:', data?.error);
    this.showNotification('Cache update failed', 'error');
    if (this.updateCacheBtn) {
      this.updateCacheBtn.disabled = false;
      this.updateCacheBtn.textContent = 'Update Cache';
    }
  }

  onDatabaseCleared() {
    this.logger.log('Database cleared successfully');
    this.showNotification('Database cleared successfully!', 'success');
    if (this.clearMessagesBtn) {
      this.clearMessagesBtn.disabled = false;
      this.clearMessagesBtn.textContent = 'Clear Database';
    }
  }

  onDelta(data) {
    const deltas = Array.isArray(data) ? data : [data];
    for (const delta of deltas) {
      const { strategy, entity, record } = delta;
      if (entity === 'message' && strategy === 'lww') {
        this.state.set(record.id, record);
        this.logger.log('Message updated from CRDT:', record.id);
      } else if (entity === 'reaction' && strategy === 'counter') {
        const { messageId, reaction } = record;
        const message = this.state.get(messageId);
        if (!message) continue;
        if (!message.reactions) message.reactions = {};
        const count = message.reactions[reaction] || 0;
        message.reactions[reaction] = count + 1;
        this.logger.log(`Reaction from CRDT: ${reaction} for: ${messageId}`);
      }
    }
    this.renderChatMessages();
  }

  addMessage(content) {
    const id = generateUUID();
    const username = this.username;
    const timestamp = Date.now();
    const reactions = { ...REACTIONS };
    const message = { id, username, timestamp, content, reactions };
    this.state.set(id, message);
    return { strategy: 'lww', entity: 'message', record: message };
  }

  async sendMessage() {
    const content = this.messageInput?.value?.trim();
    if (this.messageInput) this.messageInput.value = '';
    if (!content) {
      this.showNotification('Please enter a message', 'warning');
      return;
    }
    this.syncUsername();
    if (!this.username) {
      this.showNotification('Please enter a username', 'warning');
      return;
    }
    const delta = this.addMessage(content);
    const deltas = [delta];
    this.renderChatMessages();
    try {
      await this.metacom.api.chat.applyDelta({ deltas, room: 'sync' });
      this.logger.log('Sent message:', content);
      this.showNotification('Message sent!', 'success');
    } catch (err) {
      this.logger.log('Failed to send message:', err.message);
      this.showNotification('Failed to send message', 'error');
    }
  }

  renderChatMessages() {
    if (!this.chatMessages) return;
    this.chatMessages.innerHTML = '';
    const items = Array.from(this.state.values());
    items.sort((a, b) => b.timestamp - a.timestamp);
    for (const message of items) {
      const el = this.createMessageElement(message);
      this.addReactionHandlers(el);
      this.chatMessages.appendChild(el);
    }
    this.chatMessages.scrollTop = this.chatMessages.scrollHeight;
  }

  createMessageElement(message) {
    const el = this.messageTemplate?.content?.cloneNode(true);
    if (!el) return document.createElement('div');
    const div = el.querySelector('.chat-message');
    div.querySelector('.username').textContent = message.username;
    const timestamp = new Date(message.timestamp).toLocaleString();
    div.querySelector('.timestamp').textContent = timestamp;
    div.querySelector('.content').textContent = message.content;
    const reactions = div.querySelector('.reactions');
    this.addReactionButtons(reactions, message);
    return div;
  }

  addReactionButtons(container, message) {
    if (!container) return;
    const reactions = [
      { type: 'like', emoji: '👍' },
      { type: 'dislike', emoji: '👎' },
      { type: 'love', emoji: '❤️' },
      { type: 'smile', emoji: '😊' },
      { type: 'poo', emoji: '💩' },
    ];
    for (const { type, emoji } of reactions) {
      const el = this.reactionTemplate?.content?.cloneNode(true);
      if (!el) continue;
      const button = el.querySelector('.reaction-btn');
      button.dataset.messageId = message.id;
      button.dataset.reaction = type;
      button.querySelector('.emoji').textContent = emoji;
      const count = message.reactions?.[type] || 0;
      button.querySelector('.count').textContent = count;
      container.appendChild(button);
    }
  }

  addReactionHandlers(el) {
    const reactionBtns = el?.querySelectorAll('.reaction-btn');
    if (!reactionBtns) return;
    for (const btn of reactionBtns) {
      const { messageId, reaction } = btn.dataset;
      btn.addEventListener('click', async () => {
        const record = { messageId, reaction };
        const delta = { strategy: 'counter', entity: 'reaction', record };
        const message = this.state.get(messageId);
        if (message) {
          if (!message.reactions) message.reactions = {};
          const count = message.reactions[reaction] || 0;
          message.reactions[reaction] = count + 1;
          this.renderChatMessages();
        }
        try {
          await this.metacom.api.chat.applyDelta({
            deltas: [delta],
            room: 'sync',
          });
          const msg = `${reaction} to message:${messageId}`;
          this.logger.log('Added reaction:', msg);
        } catch (err) {
          this.logger.log('Failed to add reaction:', err.message);
        }
      });
    }
  }

  showInstallButton(visible = true) {
    if (visible) {
      if (this.installBtn) this.installBtn.classList.remove('hidden');
      if (this.installStatus) this.installStatus.classList.remove('hidden');
    } else {
      this.showNotification('App installed successfully!', 'success');
      if (this.installBtn) this.installBtn.classList.add('hidden');
      if (this.installStatus) this.installStatus.classList.add('hidden');
    }
  }

  showNotification(message, type = 'info') {
    this.notification.showNotification(message, type);
  }

  clearDatabase() {
    this.logger.log('Requesting database clear...');
    if (this.clearMessagesBtn) {
      this.clearMessagesBtn.disabled = true;
      this.clearMessagesBtn.textContent = 'Clearing...';
    }
    this.showNotification('Database clear requested', 'info');
    this.post({ type: 'clearDatabase' });
  }

  updateInterface() {
    const connected = this.connected ? 'connected' : 'disconnected';
    if (this.connectionStatus) {
      const online = this.online ? 'online' : 'offline';
      const status = `${online} / ${connected}`.toUpperCase();
      this.connectionStatus.textContent = status;
      this.connectionStatus.className = `status-indicator ${connected}`;
    }
  }
}

const app = new ChatApplication();

export { ChatApplication, app };
