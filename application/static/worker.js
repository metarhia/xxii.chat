const CACHE = 'v1';

const ASSETS = [
  '/',
  '/index.html',
  '/default.css',
  '/application.js',
  '/domain.js',
  '/metautil.js',
  '/metacom.js',
  '/worker.js',
  '/manifest.json',
  '/icon.svg',
  '/favicon.ico',
  '/favicon.png',
  '/.404.html',
];

class CacheManager {
  constructor(name = CACHE, assets = ASSETS) {
    this.name = name;
    this.assets = assets;
  }

  async update() {
    const cache = await caches.open(this.name);
    await cache.addAll(this.assets);
  }

  async serve(request) {
    const cache = await caches.open(this.name);
    const response = await cache.match(request);
    return response;
  }

  async fetchFromNetwork(request) {
    const response = await fetch(request);
    if (response.status === 200) {
      const cache = await caches.open(this.name);
      await cache.put(request, response.clone());
    }
    return response;
  }

  async offlineFallback(request) {
    const cachedResponse = await this.serve(request);
    if (cachedResponse) return cachedResponse;
    if (request.mode === 'navigate') {
      const cache = await caches.open(this.name);
      const fallbackResponse = await cache.match('/index.html');
      if (fallbackResponse) {
        return fallbackResponse;
      }
    }
    return new Response('Offline - Content not available', {
      status: 503,
      statusText: 'Service Unavailable',
      headers: { 'Content-Type': 'text/plain' },
    });
  }

  async cleanup() {
    const cacheNames = await caches.keys();
    const deletePromises = cacheNames
      .filter((cacheName) => cacheName !== this.name)
      .map(async (cacheName) => {
        await caches.delete(cacheName);
      });
    await Promise.all(deletePromises);
  }

  handleInstall(event) {
    const install = async () => {
      await this.update();
      await self.skipWaiting();
    };
    event.waitUntil(install());
  }

  handleFetch(event) {
    const { request } = event;
    if (request.method !== 'GET') return;
    if (!request.url.startsWith('http')) return;
    const respond = async () => {
      try {
        const response = await this.serve(request);
        if (response) return response;
        return await this.fetchFromNetwork(request);
      } catch {
        return await this.offlineFallback(request);
      }
    };
    event.respondWith(respond());
  }
}

const cacheManager = new CacheManager();

class SyncManager {
  constructor() {
    this.clientId = '';
    this.lastDeltaId = 0;
    this.state = new Map();
    this.queue = [];
    this.root = null;
    this.init();
  }

  async init() {
    this.root = await navigator.storage.getDirectory();
    await this.loadState();
  }

  async loadState() {
    if (!this.root) return;
    const file = await this.root.getFileHandle('state.json', { create: true });
    const reader = await file.getFile();
    const data = await reader.text();
    if (!data) return;
    const parsed = JSON.parse(data);
    this.lastDeltaId = parsed.lastDeltaId || 0;
    this.queue = parsed.queue || [];
    this.clientId = parsed.clientId;
    const messages = parsed.messages || {};
    for (const [id, message] of Object.entries(messages)) {
      this.state.set(id, message);
    }
  }

  async saveState() {
    if (!this.root) return;
    const messages = {};
    for (const [key, value] of this.state.entries()) {
      messages[key] = value;
    }
    const state = {
      clientId: this.clientId,
      lastDeltaId: this.lastDeltaId,
      queue: this.queue,
      messages,
    };
    const file = await this.root.getFileHandle('state.json', { create: true });
    const writable = await file.createWritable();
    await writable.write(JSON.stringify(state));
    await writable.close();
  }

  applyDelta(records) {
    for (const record of records) {
      this.applyCRDT(record);
    }
    this.saveState();
  }

  applyCRDT(delta) {
    const { strategy, entity, record } = delta;
    if (entity === 'message' && strategy === 'lww') {
      this.state.set(record.id, record);
    } else if (entity === 'reaction' && strategy === 'counter') {
      const { messageId, reaction } = record;
      const message = this.state.get(messageId);
      if (!message) return;
      if (!message.reactions) message.reactions = {};
      const count = message.reactions[reaction] || 0;
      message.reactions[reaction] = count + 1;
    }
  }

  async clearDatabase() {
    this.state.clear();
    this.lastDeltaId = 0;
    this.queue = [];
    await this.saveState();
  }

  getMessages() {
    const messages = {};
    for (const [key, value] of this.state.entries()) {
      messages[key] = value;
    }
    return messages;
  }
}

const syncManager = new SyncManager();

class ConnectionManager {
  constructor() {
    this.websocket = null;
    this.connected = false;
    this.connecting = false;
    this.reconnectTimer = null;
  }

  static async broadcast(packet, exclude) {
    const clients = await self.clients.matchAll({
      includeUncontrolled: true,
    });
    for (const client of clients) {
      if (client.id !== exclude) {
        console.log('Broadcasting to:', client.id);
        client.postMessage(packet);
      }
    }
  }

  send(packet) {
    this.websocket.send(JSON.stringify(packet));
  }

  delivery(packet) {
    if (this.connected) {
      this.send(packet);
    } else {
      syncManager.queue.push(packet);
      syncManager.saveState();
    }
  }

  async connect() {
    if (this.connected || this.connecting) return;
    this.connecting = true;

    const protocol = self.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const url = `${protocol}//${self.location.host}`;
    this.websocket = new WebSocket(url);

    this.websocket.onopen = () => {
      this.connected = true;
      this.connecting = false;
      console.log('Service Worker: websocket connected');
      const message = { type: 'status', data: { connected: true } };
      ConnectionManager.broadcast(message);
      this.flushQueue();
    };

    this.websocket.onmessage = (event) => {
      const message = JSON.parse(event.data);
      console.log('Service Worker: websocket message:', message);
      const { type, data } = message;
      if (type === 'delta') {
        syncManager.lastDeltaId += data.length;
        syncManager.applyDelta(data);
      }
      ConnectionManager.broadcast(message);
    };

    this.websocket.onclose = () => {
      console.log('Service Worker: websocket disconnected');
      if (this.connected) {
        this.connected = false;
        const message = { type: 'status', data: { connected: false } };
        ConnectionManager.broadcast(message);
      }
      this.connecting = false;
      if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
      this.reconnectTimer = setTimeout(() => this.connect(), 3000);
    };
  }

  async flushQueue() {
    if (!this.connected) return;
    if (!syncManager.queue.length) return;
    for (const packet of syncManager.queue) {
      this.send(packet);
    }
    syncManager.queue = [];
    await syncManager.saveState();
  }

  disconnect() {
    if (this.connected) this.websocket.close();
  }
}

const connectionManager = new ConnectionManager();

self.addEventListener('install', (e) => cacheManager.handleInstall(e));
self.addEventListener('fetch', (e) => cacheManager.handleFetch(e));

const activate = async () => {
  try {
    await Promise.all([cacheManager.cleanup(), self.clients.claim()]);
    console.log('Service Worker: Activated successfully');
  } catch (error) {
    console.error('Service Worker: Activation failed:', error);
  }
};

self.addEventListener('activate', (event) => {
  console.log('Service Worker: Activating...');
  event.waitUntil(
    (async () => {
      await activate();
      await syncManager.loadState();
    })(),
  );
});

const events = {
  connect: (source, data) => {
    syncManager.clientId = data.clientId;
    source.postMessage({
      type: 'status',
      data: { connected: connectionManager.connected },
    });
    const messages = syncManager.getMessages();
    console.log({ messages });
    source.postMessage({ type: 'state', data: messages });
  },
  online: () => connectionManager.connect(),
  offline: () => connectionManager.disconnect(),
  delta: (source, data) => {
    syncManager.applyDelta(data);
    syncManager.lastDeltaId += data.length;
    ConnectionManager.broadcast({ type: 'delta', data }, source.id);
    connectionManager.delivery({ type: 'delta', data });
  },
  username: (source, data) => {
    ConnectionManager.broadcast({ type: 'username', data }, source.id);
  },
  ping: (source) => {
    source.postMessage({ type: 'pong' });
  },
  updateCache: async (source) => {
    try {
      await cacheManager.update();
      source.postMessage({ type: 'cacheUpdated' });
    } catch (error) {
      const data = { error: error.message };
      source.postMessage({ type: 'cacheUpdateFailed', data });
    }
  },
  clearDatabase: async (source) => {
    try {
      await syncManager.clearDatabase();
      const messages = syncManager.getMessages();
      ConnectionManager.broadcast({ type: 'state', data: messages });
      source.postMessage({ type: 'databaseCleared' });
    } catch (error) {
      const data = { error: error.message };
      source.postMessage({ type: 'databaseClearFailed', data });
    }
  },
};

self.addEventListener('message', (event) => {
  const { type, data } = event.data;
  const handler = events[type];
  if (handler) handler(event.source, data);
});
