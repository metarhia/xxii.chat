import { MetacomProxy } from './metacom.js';

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
const metacomProxy = new MetacomProxy();

self.addEventListener('install', (e) => cacheManager.handleInstall(e));
self.addEventListener('fetch', (e) => cacheManager.handleFetch(e));

const activate = async () => {
  try {
    await Promise.all([cacheManager.cleanup(), self.clients.claim()]);
  } catch (error) {
    console.error('Service Worker: Activation failed:', error);
  }
};

self.addEventListener('activate', (event) => {
  console.log('Service Worker: Activating...');
  event.waitUntil(
    (async () => {
      await activate();
      await metacomProxy.open();
      await syncManager.loadState();
    })(),
  );
});

const events = {
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
