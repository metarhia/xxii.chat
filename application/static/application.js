import { Emitter } from './metautil.js';
import { Metacom } from './metacom.js';

const VERSION_URL = '/manifest.json';
const UPDATE_CHANNEL = 'xxii:update';
const CHECK_MS = 30 * 60 * 1000;
const MIN_CHECK_MS = 60 * 1000;
const IDLE_MS = 60 * 1000;
const IDLE_CHECK_MS = 10 * 1000;
const ACTIVITY = ['pointerdown', 'keydown', 'wheel'];

const CONFIG_DEFAULTS = {
  notificationTimeout: 3000,
  serviceWorker: './worker.js',
  units: [],
};

const readVersion = async () => {
  const response = await fetch(VERSION_URL);
  const { version = '' } = await response.json();
  return version;
};

class Application extends Emitter {
  constructor(config = {}) {
    super();
    this.config = { ...CONFIG_DEFAULTS, ...config };
    this.metacom = null;
    this.api = null;
    this.prompt = null;
    this.serviceWorker = this.config.serviceWorker;
    this.logger = this.config.logger;
    this.online = navigator.onLine;
    this.connected = false;
    this.version = '';
    this.nextVersion = '';
    this.checkedAt = 0;
    this.activeAt = Date.now();
    this.isRestarting = false;
    this.#init();
  }

  #init() {
    this.getElements();
    this.#setupServiceWorker().catch((error) => {
      this.logger.log('Service worker setup failed:', error.message);
    });
    this.#setupUpdates();
    this.#setupNetworkStatus();
    this.#setupInstallPrompt();
    this.#setupNotifications();
    this.setupEvents();
    this.updateInterface();
  }

  async #setupServiceWorker() {
    const { serviceWorker } = navigator;
    const options = { type: 'module', updateViaCache: 'none' };
    await serviceWorker.register(this.serviceWorker, options);
    const registration = await serviceWorker.ready;
    const worker = registration.active;
    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const url = `${protocol}//${location.host}`;
    const metacom = Metacom.create(url, { worker });
    metacom.on('status', ({ connected }) => {
      this.connected = connected;
      this.emit('status', { connected });
    });
    metacom.on('error', (error) => {
      this.logger.log('Metacom error:', error.message);
    });
    await metacom.open();
    await metacom.load(...this.config.units);
    this.metacom = metacom;
    this.api = metacom.api;
    this.emit('ready');
  }

  #setupUpdates() {
    const channel = new BroadcastChannel(UPDATE_CHANNEL);
    channel.addEventListener('message', ({ data }) => {
      this.#prepareUpdate(data.version);
    });
    const touch = () => {
      this.activeAt = Date.now();
    };
    for (const type of ACTIVITY) {
      window.addEventListener(type, touch, { capture: true, passive: true });
    }
    const check = () => {
      this.checkUpdate().catch((error) => {
        this.logger.log('Update check failed:', error.message);
      });
    };
    this.on('ready', check);
    this.on('status', ({ connected }) => connected && check());
    window.addEventListener('online', check);
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) this.#applyUpdate();
      else check();
    });
    setInterval(check, CHECK_MS);
    setInterval(() => this.#applyUpdate(), IDLE_CHECK_MS);
    readVersion()
      .then((version) => {
        this.version = version;
        this.emit('version', { version, next: this.nextVersion });
      })
      .catch((error) => this.logger.log('Version unknown:', error.message));
  }

  async checkUpdate(isForced = false) {
    if (!this.api) throw new Error('Service worker is not connected');
    const isRecent = Date.now() - this.checkedAt < MIN_CHECK_MS;
    if (isRecent && !isForced) return this.nextVersion;
    this.checkedAt = Date.now();
    const { version } = await this.api.cache.check();
    this.#prepareUpdate(version);
    return this.nextVersion;
  }

  #prepareUpdate(version) {
    const next = version === this.version ? '' : version;
    if (!this.version || next === this.nextVersion) return;
    this.nextVersion = next;
    this.emit('version', { version: this.version, next });
    if (!next) return;
    this.logger.log(`Version ${next} is ready, restarting when idle`);
    this.#applyUpdate();
  }

  #applyUpdate() {
    if (!this.nextVersion) return;
    const isIdle = Date.now() - this.activeAt > IDLE_MS;
    const isAway = document.hidden || isIdle;
    if (isAway && this.canRestart()) this.restart().catch(() => {});
  }

  canRestart() {
    return !this.isRestarting;
  }

  async restart() {
    this.isRestarting = true;
    this.logger.log(`Restarting with version ${this.nextVersion}`);
    const registration = await navigator.serviceWorker.getRegistration();
    await registration?.update().catch(() => {});
    location.reload();
  }

  #setupNetworkStatus() {
    window.addEventListener('online', () => {
      this.online = true;
      this.emit('network', { online: true });
      this.logger.log('Network: Online');
    });

    window.addEventListener('offline', () => {
      this.online = false;
      this.emit('network', { online: false });
      this.logger.log('Network: Offline');
    });
  }

  #setupInstallPrompt() {
    window.addEventListener('beforeinstallprompt', (event) => {
      event.preventDefault();
      this.prompt = event;
      this.emit('install', { prompt: event });
      this.logger.log('Install prompt available');
    });

    window.addEventListener('appinstalled', () => {
      this.emit('installed');
      this.logger.log('App installed successfully');
    });
  }

  async #setupNotifications() {
    if (typeof Notification === 'undefined') return false;
    const permission = await Notification.requestPermission();
    this.logger.log('Notification permission:', permission);
    return permission === 'granted';
  }

  async install() {
    if (!this.prompt) {
      this.logger.log('Install prompt not available');
      return;
    }
    this.prompt.prompt();
    const { outcome } = await this.prompt.userChoice;
    const message = outcome === 'accepted' ? 'accepted' : 'dismissed';
    this.logger.log(`Install prompt ${message}`);
    this.prompt = null;
    this.emit('installed', { accepted: outcome === 'accepted' });
  }
}

export { VERSION_URL, UPDATE_CHANNEL, Application };
