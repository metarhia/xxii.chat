import { Emitter, generateId } from './metautil.js';
import { Metacom } from './metacom.js';

window.addEventListener('online', () => Metacom.online());
window.addEventListener('offline', () => Metacom.offline());

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
    const clientId = getClientId();
    this.clientId = clientId;
    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const url = `${protocol}//${location.host}`;
    this.metacom = Metacom.create(url, { clientId });
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
      this.#setupMetacom();
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

  async #setupMetacom() {
    try {
      await this.metacom.load('system');
      const units = await this.metacom.api.system.introspect(['chat']);
      this.emit('metacom-ready', { units });
    } catch (err) {
      this.emit('metacom-error', { error: err });
      return;
    }
    try {
      await this.metacom.load('chat');
      const room = await this.metacom.api.chat.getRoom({ name: 'lobby' });
      this.emit('metacom-room', { room });
    } catch (err) {
      this.emit('metacom-error', { error: err });
    }
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
