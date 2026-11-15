import { Metacom, MetacomPeer } from './metacom.js';
import { SyncService, Uplink } from './globalstorage.js';
import { Emitter } from './metautil.js';

const ICE = { iceServers: [] };
const LOCK = 'xxii:mesh';
const PROTOCOL = 'metacom:rtc';
const LINK_UNITS = ['chat', 'direct', 'mesh'];
const HANDSHAKE_MS = { answerer: 15000, offerer: 10000 };
const HOLD_MS = 5000;
const HOLD_LIMIT = 64;

const isOnline = (entry) => entry.status !== 'offline';

const addListener = (emitter, name, listener) => {
  if (!emitter || emitter.listeners(name).includes(listener)) return;
  emitter.on(name, listener);
};

class PeerLink extends Emitter {
  #mesh = null;
  #host = null;
  #client = null;
  #services = [];
  #groupUplink = null;
  #directUplink = null;
  #onRelay = null;
  #onState = null;

  constructor(mesh, remote, direct) {
    super();
    this.#mesh = mesh;
    this.remote = remote;
    this.role = mesh.peerId < remote ? 'answerer' : 'offerer';
    this.connected = false;
    this.remoteServer = true;
    const rtc = {
      localId: mesh.peerId,
      peerId: remote,
      role: this.role,
      signaling: mesh.signaling(remote),
      configuration: ICE,
      handshakeTimeout: HANDSHAKE_MS[this.role],
    };
    if (this.role === 'answerer') this.#serve(rtc, direct);
    else this.#join(rtc, direct);
  }

  get syncsGroup() {
    const isServerMissing = !this.#mesh.connected || !this.remoteServer;
    return this.connected && isServerMissing;
  }

  #serve(rtc, direct) {
    const name = `peer:${this.remote}`;
    const group = new SyncService(this.#mesh.replica, { unit: 'chat', name });
    const pair = new SyncService(direct, { unit: 'direct', name });
    const host = new MetacomPeer({ rtc });
    host.register('chat', group.api);
    host.register('direct', pair.api);
    host.register('mesh', {
      relay: async ({ message }) => this.#mesh.receive(message),
      state: async () => ({ server: this.#mesh.connected }),
    });
    host.on('connect', () => this.#setConnected(true));
    host.on('disconnect', () => this.#setConnected(false));
    host.on('error', (error) => this.emit('error', error));
    this.#host = host;
    this.#services = [group, pair];
    host.open().catch((error) => this.emit('error', error));
  }

  #join(rtc, direct) {
    const name = `peer:${this.remote}`;
    const client = Metacom.create(this.remote, { transport: 'webrtc', rtc });
    const replica = this.#mesh.replica;
    this.#client = client;
    this.#directUplink = new Uplink(direct, client, { unit: 'direct', name });
    this.#groupUplink = new Uplink(replica, client, { unit: 'chat', name });
    this.#directUplink.on('error', (error) => this.emit('error', error));
    this.#groupUplink.on('error', (error) => this.emit('error', error));
    this.#onRelay = (message) => this.#mesh.receive(message);
    this.#onState = ({ server }) => this.#setRemoteServer(server);
    client.on('open', () => {
      this.#joined().catch((error) => this.emit('error', error));
    });
    client.on('close', () => this.#setConnected(false));
    client.on('error', (error) => this.emit('error', error));
    this.#directUplink.start();
    client.open().catch(() => {});
  }

  async #joined() {
    const client = this.#client;
    await client.load(...LINK_UNITS);
    const { mesh } = client.api;
    addListener(mesh, 'relay', this.#onRelay);
    addListener(mesh, 'state', this.#onState);
    const { server } = await mesh.state();
    this.remoteServer = server;
    this.#setConnected(true);
  }

  #setConnected(connected) {
    if (this.connected === connected) return;
    this.connected = connected;
    if (connected) this.announce();
    this.update();
    this.emit('state', connected);
  }

  #setRemoteServer(server) {
    this.remoteServer = server === true;
    this.update();
    this.emit('state', this.connected);
  }

  update() {
    if (!this.#groupUplink) return;
    if (this.syncsGroup) this.#groupUplink.start();
    else this.#groupUplink.stop();
  }

  announce() {
    if (!this.#host || !this.connected) return;
    const server = this.#mesh.connected;
    this.#host.broadcast('mesh/state', { server });
  }

  deliver(message) {
    if (!this.connected) return false;
    if (this.#host) {
      this.#host.broadcast('mesh/relay', message);
      return true;
    }
    const relay = this.#client.api.mesh?.relay;
    if (!relay) return false;
    relay({ message }).catch((error) => this.emit('error', error));
    return true;
  }

  close() {
    this.#groupUplink?.stop();
    this.#directUplink?.stop();
    for (const service of this.#services) service.close();
    this.#host?.close();
    this.#client?.close();
    this.connected = false;
  }
}

class Mesh extends Emitter {
  #app = null;
  #links = new Map();
  #pending = new Set();
  #listeners = new Map();
  #held = new Map();
  #release = null;
  #onUpdate = null;
  #onSignal = null;

  constructor(app) {
    super();
    this.#app = app;
    this.peers = new Map();
    this.isLeader = false;
    this.#onUpdate = ({ peers }) => this.update(peers);
    this.#onSignal = (message) => this.receive(message);
  }

  get peerId() {
    return this.#app.peerId;
  }

  get replica() {
    return this.#app.replica;
  }

  get connected() {
    return this.#app.connected;
  }

  get links() {
    return this.#links;
  }

  get linked() {
    let count = 0;
    for (const link of this.#links.values()) if (link.connected) count++;
    return count;
  }

  start() {
    const { locks } = navigator;
    if (!locks) return void this.#lead();
    const hold = () =>
      new Promise((resolve) => {
        this.#release = resolve;
        this.#lead();
      });
    locks.request(LOCK, hold).catch((error) => this.emit('error', error));
  }

  #lead() {
    this.isLeader = true;
    this.emit('leader');
    this.attach().catch((error) => this.emit('error', error));
  }

  async attach() {
    const { metacom } = this.#app;
    if (!metacom || !this.connected) return;
    await metacom.load('presence', 'signal');
    const { presence, signal } = metacom.api;
    addListener(presence, 'update', this.#onUpdate);
    addListener(signal, 'message', this.#onSignal);
    const list = this.isLeader ? await this.announce() : await presence.list();
    this.update(list);
  }

  async announce() {
    const presence = this.#app.api?.presence;
    const isReady = this.isLeader && this.connected && presence?.announce;
    if (!isReady) return null;
    const peer = this.peerId;
    const nick = this.#app.username || 'anonymous';
    const status = document.hidden ? 'away' : 'online';
    return presence.announce({ peer, nick, status });
  }

  update(list) {
    if (!Array.isArray(list)) return;
    this.peers = new Map(list.map((entry) => [entry.peer, entry]));
    if (this.isLeader) this.#reconcile();
    this.emit('peers');
  }

  #reconcile() {
    for (const link of this.#links.values()) {
      const entry = this.peers.get(link.remote);
      const isGone = !entry || !isOnline(entry);
      if (!isGone || link.connected) continue;
      link.close();
      this.#links.delete(link.remote);
    }
    for (const entry of this.peers.values()) {
      const isSelf = entry.peer === this.peerId;
      if (isSelf || !isOnline(entry)) continue;
      this.#connect(entry.peer).catch((error) => this.emit('error', error));
    }
  }

  async #connect(remote) {
    if (this.#links.has(remote) || this.#pending.has(remote)) return;
    this.#pending.add(remote);
    try {
      const direct = await this.#app.openDirect(remote);
      if (!this.isLeader || this.#links.has(remote)) return;
      const link = new PeerLink(this, remote, direct.replica);
      link.on('state', () => this.emit('links'));
      link.on('error', (error) => this.emit('error', error));
      this.#links.set(remote, link);
      this.emit('links');
    } finally {
      this.#pending.delete(remote);
    }
  }

  serverChanged() {
    for (const link of this.#links.values()) {
      link.update();
      link.announce();
    }
    this.emit('links');
    if (this.connected) {
      this.attach().catch((error) => this.emit('error', error));
    }
  }

  signaling(remote) {
    return {
      send: (message) => this.route(message),
      subscribe: (listener) => this.#listen(remote, listener),
      close: () => {},
    };
  }

  #listen(remote, listener) {
    const listeners = this.#listeners.get(remote) ?? new Set();
    listeners.add(listener);
    this.#listeners.set(remote, listeners);
    this.#replay(remote, listener);
    return () => listeners.delete(listener);
  }

  #hold(message) {
    const { source, generation } = message;
    const held = this.#held.get(source);
    const isSame = held?.generation === generation;
    const isFull = !held && this.#held.size >= HOLD_LIMIT;
    if (isFull) return false;
    const entry = isSame ? held : { generation, messages: [], time: 0 };
    if (entry.messages.length >= HOLD_LIMIT) return false;
    entry.messages.push(message);
    entry.time = Date.now();
    this.#held.set(source, entry);
    return true;
  }

  #replay(remote, listener) {
    const held = this.#held.get(remote);
    if (!held) return;
    this.#held.delete(remote);
    const isFresh = Date.now() - held.time < HOLD_MS;
    if (!isFresh) return;
    queueMicrotask(() => {
      for (const message of held.messages) listener(message);
    });
  }

  async route(message) {
    const signal = this.#app.api?.signal;
    if (this.connected && signal?.send) {
      const isSent = await signal.send({ message }).catch(() => false);
      if (isSent) return;
    }
    for (const link of this.#links.values()) {
      if (link.remote !== message.target) link.deliver(message);
    }
  }

  receive(message) {
    if (message?.protocol !== PROTOCOL) return false;
    if (message.target !== this.peerId) return this.#forward(message);
    const listeners = this.#listeners.get(message.source);
    const isWaiting = !listeners || listeners.size === 0;
    if (isWaiting) return this.isLeader && this.#hold(message);
    for (const listener of listeners) listener(message);
    return true;
  }

  #forward(message) {
    const link = this.#links.get(message.target);
    if (!link?.connected) return false;
    return link.deliver(message);
  }

  stop() {
    for (const link of this.#links.values()) link.close();
    this.#links.clear();
    this.#held.clear();
    this.isLeader = false;
    this.#release?.();
    this.#release = null;
  }
}

export { Mesh };
