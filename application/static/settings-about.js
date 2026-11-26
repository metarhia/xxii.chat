import { timeOf, plural } from './view.js';

const STANDALONE = '(display-mode: standalone)';

const versionTextOf = ({ version }) => (version ? `v${version}` : 'v…');

const stateTextOf = ({ next, checkedAt }) => {
  if (next) return `Version ${next} is ready`;
  if (!checkedAt) return 'Updates install automatically';
  return `Up to date · checked ${timeOf(checkedAt)}`;
};

const meshTextOf = ({ online, leader, linked }) => {
  if (!online) return 'network offline';
  return leader ? `rtc: ${linked} linked` : 'rtc: via leader tab';
};

const linkOf = ({ connected, linked }) => {
  if (connected) return 'server';
  return linked > 0 ? 'p2p' : 'offline';
};

const WORDS = { server: 'online', p2p: 'peers only', offline: 'offline' };

const summaryOf = (info) => {
  const word = WORDS[linkOf(info)];
  if (!info.online) return `${word} · network offline`;
  const role = info.leader ? 'mesh tab' : 'follower tab';
  return `${word} · ${role} · ${plural(info.linked, 'peer', 'peers')}`;
};

const isStandalone = () => globalThis.matchMedia?.(STANDALONE).matches === true;

class AboutPage {
  constructor(root, hooks) {
    this.hooks = hooks;
    this.version = root.querySelector('#version-text');
    this.state = root.querySelector('#version-state');
    this.action = root.querySelector('#version-btn');
    this.install = root.querySelector('#install-btn');
    this.installState = root.querySelector('#install-state');
    this.server = root.querySelector('#connection-status');
    this.mesh = root.querySelector('#mesh-status');
    this.tab = root.querySelector('#tab-role');
    this.peers = root.querySelector('#peers-linked');
    this.output = root.querySelector('#output');
    this.action.onclick = () => hooks.versionAction();
    this.install.onclick = () => hooks.install();
    root.querySelector('#clear-log-btn').onclick = () => hooks.clearLog();
    root.querySelector('#log-copy').onclick = () =>
      hooks.copy(this.output.textContent, 'Log copied');
  }

  paint() {
    const info = this.hooks.about();
    this.version.textContent = versionTextOf(info);
    this.state.textContent = stateTextOf(info);
    this.action.textContent = info.next ? 'restart now' : 'check now';
    const link = linkOf(info);
    this.server.textContent = WORDS[link];
    this.server.className = `status ${link}`;
    this.mesh.textContent = meshTextOf(info);
    this.tab.textContent = info.leader ? 'mesh tab' : 'follower tab';
    this.peers.textContent = plural(info.linked, 'peer', 'peers');
    const installed = isStandalone();
    this.install.classList.toggle('hidden', !info.canInstall);
    this.installState.textContent = installed ? 'Installed' : '';
    this.installState.hidden = !installed;
    this.install.closest('.row').hidden = !installed && !info.canInstall;
  }
}

export { AboutPage, meshTextOf, linkOf, summaryOf };
