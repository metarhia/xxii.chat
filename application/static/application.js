import { Emitter } from './metautil.js';
import { Metacom } from './metacom.js';

const CONFIG_DEFAULTS = {
  notificationTimeout: 3000,
  serviceWorker: './worker.js',
  units: [],
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
    this.#init();
  }

  #init() {
    this.getElements();
    this.#setupServiceWorker().catch((error) => {
      this.logger.log('Service worker setup failed:', error.message);
    });
    this.#setupNetworkStatus();
    this.#setupInstallPrompt();
    this.#setupNotifications();
    this.setupEvents();
    this.updateInterface();
  }

  async #setupServiceWorker() {
    const { serviceWorker } = navigator;
    await serviceWorker.register(this.serviceWorker, { type: 'module' });
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

export { Application };
