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
    this.on('metacom-ready', () => this.runE2ETest());
    document.addEventListener('visibilitychange', () => {});
    window.addEventListener('beforeunload', () => {});
    window.addEventListener('blur', () => {});
  }

  async runE2ETest() {
    try {
      const units = await this.metacom.api.system.introspect([]);
      const ok = units && typeof units === 'object';
      const msg = ok
        ? 'E2E PASS: Tab -> SW Proxy -> WebSocket -> Server -> OK'
        : 'E2E FAIL: invalid response';
      console.log(msg, ok ? units : '');
      this.emit('e2e-test', { pass: ok, units });
    } catch (err) {
      console.error('E2E FAIL: Tab -> SW Proxy -> WebSocket -> Server', err);
      this.emit('e2e-test', { pass: false, error: err });
    }
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
