import { Application } from './application.js';

class ChatApplication extends Application {
  constructor(config = {}) {
    super(config);
    this.config = config;
  }

  getElements() {
    this.installBtn = document.getElementById('install-btn');
    this.templateName = document.getElementById('template-name');
  }

  setupEvents() {
    this.installBtn.onclick = () => this.install();
    this.on('network', () => {});
    this.on('install', () => {});
    this.on('installed', () => {});
    document.addEventListener('visibilitychange', () => {});
    window.addEventListener('beforeunload', () => {});
    window.addEventListener('blur', () => {});
  }

  updateInterface() {
    const online = this.online ? 'online' : 'offline';
    const connected = this.connected ? 'connected' : 'disconnected';
    const status = `${online} / ${connected}`;
    console.log(status);
  }
}

const config = {};
const app = new ChatApplication(config);

export { ChatApplication, app };
