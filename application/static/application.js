import { Emitter, generateId } from './metautil.js';

const getClientId = () => {
  let clientId = localStorage.getItem('clientId');
  if (!clientId) {
    clientId = generateId();
    localStorage.setItem('clientId', clientId);
  }
  return clientId;
};

const CONFIG_DEFAULTS = {
  serviceWorker: './worker.js',
  pingInterval: 25000,
};

class Application extends Emitter {
  constructor(config = {}) {
    super();
    this.config = { ...CONFIG_DEFAULTS, ...config };
    this.state = new Map();
    this.worker = null;
    this.clientId = getClientId();
    this.serviceWorker = this.config.serviceWorker;
    this.online = navigator.onLine;
    this.connected = false;
    this.#init();
  }

  #init() {
    this.getElements();
    this.#setupServiceWorker();
    this.#setupNetworkStatus();
    this.#setupInstallPrompt();
    this.#setupNotifications();
    this.setupEvents();
    this.updateInterface();
  }

  #setupServiceWorker() {
    const worker = navigator.serviceWorker;
    worker.register(this.serviceWorker, { type: 'module' });
    const ping = () => this.post({ type: 'ping' });
    worker.ready.then((registration) => {
      setInterval(ping, this.config.pingInterval);
      this.worker = registration.active;
      const data = { clientId: this.clientId };
      this.post({ type: 'connect', data });
    });
    worker.addEventListener('message', (event) => {
      const { type, data } = event.data;
      this.emit(type, data);
    });
    this.on('status', (data) => {
      this.connected = data.connected;
    });
    document.addEventListener('visibilitychange', () => {
      this.post({ type: 'ping' });
    });
  }

  #setupNetworkStatus() {
    window.addEventListener('online', () => {
      this.online = true;
      this.post({ type: 'online' });
      this.emit('network', { online: true });
    });

    window.addEventListener('offline', () => {
      this.online = false;
      this.post({ type: 'offline' });
      this.emit('network', { online: false });
    });
  }

  #setupInstallPrompt() {
    window.addEventListener('beforeinstallprompt', (event) => {
      event.preventDefault();
      this.prompt = event;
      this.emit('install', { prompt: event });
    });

    window.addEventListener('appinstalled', () => {
      this.emit('installed');
    });
  }

  async #setupNotifications() {
    if (typeof Notification === 'undefined') return false;
    const permission = await Notification.requestPermission();
    this.notificationPermission = permission === 'granted';
    return this.notificationPermission;
  }

  post(data) {
    this.worker.postMessage(data);
  }

  async install() {
    if (!this.prompt) return;
    this.prompt.prompt();
    const { outcome } = await this.prompt.userChoice;
    this.prompt = null;
    this.emit('installed', { accepted: outcome === 'accepted' });
  }

  async notify(title, text) {
    if (typeof Notification === 'undefined') return;
    if (!this.notificationPermission) return;
    const caption = title || 'XXII Chat';
    const body = text || 'This is a test notification from the PWA!';
    const options = { body, icon: '/icon.svg', badge: '/icon.svg' };
    const notification = new Notification(caption, options);
    notification.onclick = () => {
      window.focus();
      notification.close();
    };
  }
}

export { Application, generateId };
