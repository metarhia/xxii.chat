import { MetacomProxy } from './metacom.js';
import { Replica, SyncService, Uplink, fsi } from './globalstorage.js';
import { validate, seed, isPair, directUnit, filesOf } from './chat.js';
import { readFile, localFiles, clearFiles } from './files.js';
import { sendBlob, SerialTask } from './files.js';
import { VERSION_URL, UPDATE_CHANNEL } from './application.js';
import { onNotificationMessage, onNotificationClick } from './notifications.js';
import { isRecordingUrl, serveRecording } from './recording-route.js';

const CACHE_PREFIX = 'xxii-';
const META_CACHE = 'xxii-meta';
const VERSION_KEY = '/version';
const DIRECT_PATH = 'dm';

const ASSETS = [
  '/',
  '/index.html',
  '/default.css',
  '/application.js',
  '/domain.js',
  '/ice.js',
  '/chat.js',
  '/replies.js',
  '/mesh.js',
  '/call.js',
  '/media.js',
  '/mirror.js',
  '/mirror-worker.js',
  '/clock-worker.js',
  '/call-hands.js',
  '/call-settings.js',
  '/call-preferences.js',
  '/call-keys.js',
  '/layout.js',
  '/avatar.js',
  '/members.js',
  '/compositor.js',
  '/mixer.js',
  '/recording-files.js',
  '/recording-folder.js',
  '/recording-export.js',
  '/recording-duration.js',
  '/recording-mp4.js',
  '/recording-webm.js',
  '/recording-worker.js',
  '/recording-route.js',
  '/recordings.js',
  '/recorder.js',
  '/record-panel.js',
  '/call-record.js',
  '/call-layout.js',
  '/call-stats.js',
  '/call-volume.js',
  '/call-tile-menu.js',
  '/view-hints.js',
  '/stage.js',
  '/notifications.js',
  '/files.js',
  '/view.js',
  '/overlays.js',
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

const report = (error) => {
  console.log('Service Worker:', error.message);
};

const isFileLog = ({ deltas }) =>
  deltas.some((delta) => delta.entity === 'file');

const fetchVersion = async () => {
  const response = await fetch(VERSION_URL, { cache: 'no-store' });
  if (!response.ok) throw new Error(`Version check: HTTP ${response.status}`);
  const { version } = await response.json();
  if (typeof version !== 'string' || version === '') {
    throw new Error('Version check: no version in the manifest');
  }
  return version;
};

const readVersion = async () => {
  const meta = await caches.open(META_CACHE);
  const response = await meta.match(VERSION_KEY);
  return response ? response.text() : '';
};

const fresh = (url) => new Request(url, { cache: 'reload' });

class CacheManager {
  #assets = [];
  #version = null;
  #checking = null;
  #channel = new BroadcastChannel(UPDATE_CHANNEL);

  constructor(assets = ASSETS) {
    this.#assets = assets;
  }

  get version() {
    this.#version ??= readVersion();
    return this.#version;
  }

  check() {
    this.#checking ??= this.#check().finally(() => {
      this.#checking = null;
    });
    return this.#checking;
  }

  async #check() {
    const current = await this.version;
    const latest = await fetchVersion();
    if (latest === current) return { version: current, isUpdated: false };
    await this.#install(latest);
    console.log(`Service Worker: updated from ${current} to ${latest}`);
    this.#channel.postMessage({ version: latest });
    return { version: latest, isUpdated: true };
  }

  async #install(version) {
    const cache = await caches.open(CACHE_PREFIX + version);
    await cache.addAll(this.#assets.map(fresh));
    const meta = await caches.open(META_CACHE);
    await meta.put(VERSION_KEY, new Response(version));
    this.#version = Promise.resolve(version);
    await this.cleanup();
  }

  async open() {
    const version = await this.version;
    return caches.open(CACHE_PREFIX + version);
  }

  async serve(request) {
    const cache = await this.open();
    return cache.match(request);
  }

  async fetchFromNetwork(request) {
    const response = await fetch(request);
    if (response.status === 200) {
      const cache = await this.open();
      await cache.put(request, response.clone());
    }
    return response;
  }

  async offlineFallback(request) {
    const cachedResponse = await this.serve(request);
    if (cachedResponse) return cachedResponse;
    if (request.mode === 'navigate') {
      const cache = await this.open();
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
    const version = await this.version;
    const active = CACHE_PREFIX + version;
    const names = await caches.keys();
    const kept = [active, META_CACHE];
    const obsolete = names.filter((name) => !kept.includes(name));
    await Promise.all(obsolete.map((name) => caches.delete(name)));
  }

  handleInstall(event) {
    const install = async () => {
      await this.check();
      await self.skipWaiting();
    };
    event.waitUntil(install());
  }

  handleFetch(event) {
    const { request } = event;
    if (request.method !== 'GET') return;
    if (!request.url.startsWith('http')) return;
    const url = new URL(request.url);
    if (isRecordingUrl(url)) {
      return void event.respondWith(serveRecording(request, url));
    }
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

class FileUploader {
  #replica = null;
  #uplink = null;
  #server = null;
  #stored = new Set();
  #task = null;

  constructor(replica, uplink, server) {
    this.#replica = replica;
    this.#uplink = uplink;
    this.#server = server;
    this.#task = new SerialTask(() => this.#uploadAll(), report);
  }

  schedule() {
    this.#task.schedule();
  }

  forget() {
    this.#stored.clear();
  }

  async #uploadAll() {
    if (!this.#server.active) return;
    const attached = Array.from(filesOf(this.#replica).values());
    const unknown = attached.filter((file) => !this.#stored.has(file.checksum));
    const files = await localFiles(unknown);
    if (files.length === 0) return;
    await this.#uplink.flush();
    await this.#server.load('files');
    const checksums = files.map((file) => file.checksum);
    const reply = await this.#server.api.files.missing({ checksums });
    const missing = new Set(reply);
    for (const file of files) {
      if (missing.has(file.checksum)) await this.#upload(file);
      this.#stored.add(file.checksum);
    }
  }

  async #upload(file) {
    const blob = await readFile(file);
    if (!blob) return;
    const { checksum } = file;
    const { upload } = this.#server.api.files;
    await sendBlob(this.#server, blob, (id) => upload({ id, checksum }));
  }
}

const cacheManager = new CacheManager();
const proxy = new MetacomProxy();

const replica = new Replica({ path: 'chat', validate });
const service = new SyncService(replica, { unit: 'chat', name: 'tab' });
const server = { unit: 'sync', name: 'server' };
const uplink = new Uplink(replica, proxy.server, server);

const uploader = new FileUploader(replica, uplink, proxy.server);

replica.on('error', report);
replica.on('log', (event) => {
  if (isFileLog(event)) uploader.schedule();
});
uplink.on('error', report);
uplink.start();
proxy.server.on('open', () => uploader.schedule());

proxy.on('error', (error) => {
  console.log('Service Worker: metacom error:', error.message);
});

const directs = new Map();

const openDirect = async (pair) => {
  if (!isPair(pair)) throw new Error('Invalid direct chat');
  const existing = directs.get(pair);
  if (existing) return existing.open();
  const path = `${DIRECT_PATH}/${pair}`;
  const direct = new Replica({ path, validate });
  const unit = directUnit(pair);
  const directService = new SyncService(direct, { unit, name: 'tab' });
  direct.on('error', report);
  directs.set(pair, direct);
  proxy.register(unit, directService.api);
  proxy.broadcast('chat/direct', { pair });
  return direct.open();
};

const restoreDirects = async () => {
  const names = await fsi.list(DIRECT_PATH);
  const pairs = names.filter(isPair);
  await Promise.all(pairs.map(openDirect));
};

const restoring = restoreDirects().catch(report);

const clearAll = async () => {
  uploader.forget();
  const clearing = [replica.clear(), clearFiles()];
  for (const direct of directs.values()) clearing.push(direct.clear());
  await Promise.all(clearing);
  seed(replica);
};

proxy.register('chat', {
  ...service.api,

  username: async ({ username }, context) => {
    context.broadcast('chat/username', username);
    return true;
  },

  directs: async () => {
    await restoring;
    return Array.from(directs.keys());
  },

  openDirect: async ({ pair }) => {
    await openDirect(pair);
    return true;
  },

  clear: async () => {
    await clearAll();
    return true;
  },
});

proxy.register('cache', {
  check: () => cacheManager.check(),
});

self.addEventListener('message', (event) => {
  onNotificationMessage(self, event);
});

self.addEventListener('notificationclick', (event) => {
  onNotificationClick(self, event);
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

const start = async () => {
  await replica.open();
  seed(replica);
  uploader.schedule();
};

start().catch(report);

proxy.open().catch((error) => {
  console.log('Service Worker: server is unreachable:', error.message);
});
