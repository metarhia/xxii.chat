import { MetacomProxy } from './metacom.js';
import { Replica, SyncService, Uplink } from './globalstorage.js';
import { validate, seed } from './chat.js';

const CACHE = 'v4';

const ASSETS = [
  '/',
  '/index.html',
  '/default.css',
  '/application.js',
  '/domain.js',
  '/chat.js',
  '/peer.js',
  '/metautil.js',
  '/metacom.js',
  '/globalstorage.js',
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
    return cache.match(request);
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
      if (fallbackResponse) return fallbackResponse;
    }
    return new Response('Offline - Content not available', {
      status: 503,
      statusText: 'Service Unavailable',
      headers: { 'Content-Type': 'text/plain' },
    });
  }

  async cleanup() {
    const cacheNames = await caches.keys();
    const obsolete = cacheNames.filter((cacheName) => cacheName !== this.name);
    await Promise.all(obsolete.map((cacheName) => caches.delete(cacheName)));
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
const proxy = new MetacomProxy();

const replica = new Replica({ path: 'chat', validate });
const service = new SyncService(replica, { unit: 'chat', name: 'tab' });
const server = { unit: 'sync', name: 'server' };
const uplink = new Uplink(replica, proxy.server, server);

const report = (error) => {
  console.log('Service Worker:', error.message);
};

replica.on('error', report);
uplink.on('error', report);
uplink.start();

proxy.on('error', (error) => {
  console.log('Service Worker: metacom error:', error.message);
});

proxy.register('chat', {
  ...service.api,

  username: async ({ username }, context) => {
    context.broadcast('chat/username', username);
    return true;
  },

  clear: async () => {
    await replica.clear();
    seed(replica);
    return true;
  },
});

proxy.register('cache', {
  update: async () => {
    await cacheManager.update();
    return true;
  },
});

self.addEventListener('install', (event) => cacheManager.handleInstall(event));
self.addEventListener('fetch', (event) => cacheManager.handleFetch(event));

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
  event.waitUntil(activate());
});

const opening = replica.open();
opening.then(() => seed(replica)).catch(report);

proxy.open().catch((error) => {
  console.log('Service Worker: server is unreachable:', error.message);
});
