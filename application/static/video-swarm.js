import { Metacom, RtcConnection, RtcChannelEndpoint } from './metacom.js';
import { VideoPieces, checkedManifest, validIndex } from './video-pieces.js';
import { MAX_PIECES } from './video-pieces.js';
import { MAX_DETAILS } from './video-metadata.js';

const HEARTBEAT_MS = 8000;
const REQUEST_MS = 9000;
const PIECE_WAIT_MS = 30000;
const MAX_SIGNALS = 80;

class VideoLink {
  constructor(swarm, peer) {
    this.swarm = swarm;
    this.peer = peer;
    this.connection = new RtcConnection();
    this.full = false;
    this.indices = new Set();
    this.missing = new Set();
    this.endpoint = null;
    this.signal = null;
    this.held = [];
    this.pending = null;
    this.closed = false;
    this.connection.on('close', () => this.close());
  }

  async open() {
    const { swarm, peer } = this;
    const localId = swarm.peer;
    const signaling = {
      send: (message) => swarm.sendSignal(peer, message),
      subscribe: (receive) => {
        this.signal = receive;
        for (const message of this.held.splice(0)) receive(message);
        return () => {
          this.signal = null;
        };
      },
    };
    const role = localId < peer ? 'answerer' : 'offerer';
    const channel = await this.connection.open({
      localId,
      peerId: peer,
      role,
      signaling,
      configuration: { iceServers: swarm.iceServers },
      handshakeTimeout: 18000,
    });
    if (this.closed) return;
    const maxMessageSize = this.connection.peerConnection?.sctp?.maxMessageSize;
    const endpoint = new RtcChannelEndpoint(channel, {
      maxMessageSize,
      maxMessageBytes: MAX_PIECES * 77 + MAX_DETAILS,
    });
    this.endpoint = endpoint;
    endpoint.on('close', () => this.close());
    endpoint.on('message', (data) => {
      this.receive(data).catch(() => this.close());
    });
    this.state();
    swarm.changed();
  }

  receiveSignal(message) {
    if (this.signal) this.signal(message);
    else if (this.held.length < MAX_SIGNALS) this.held.push(message);
  }

  send(data) {
    if (!this.endpoint || this.endpoint.closed) return false;
    try {
      this.endpoint.write(JSON.stringify(data));
      return true;
    } catch {
      this.close();
      return false;
    }
  }

  state() {
    const { pieces } = this.swarm;
    this.send({
      type: 'state',
      manifest: pieces.manifest,
      full: Boolean(pieces.source),
      indices: [...pieces.pieces],
    });
  }

  canSend(index) {
    return (
      this.endpoint &&
      !this.pending &&
      !this.missing.has(index) &&
      (this.full || this.indices.has(index))
    );
  }

  ask(index) {
    const result = new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.missing.add(index);
        this.settle(null);
      }, REQUEST_MS);
      this.pending = { index, resolve, timer };
    });
    if (!this.send({ type: 'get', index })) this.settle(null);
    return result;
  }

  settle(value) {
    const pending = this.pending;
    this.pending = null;
    if (pending) {
      clearTimeout(pending.timer);
      pending.resolve(value);
    }
    this.swarm.changed();
  }

  async receive(data) {
    if (typeof data !== 'string') {
      if (data.length < 5 || !this.pending) return;
      const index = new DataView(data.buffer, data.byteOffset, 4).getUint32(0);
      if (this.pending.index !== index) return;
      this.settle(data.slice(4).buffer);
      return;
    }
    const message = JSON.parse(data);
    const { index } = message;
    if (message.type === 'state') {
      const { full, indices, manifest } = message;
      this.full = full === true;
      this.indices = new Set(
        Array.isArray(indices)
          ? indices.filter(
              (i) => Number.isInteger(i) && i >= 0 && i < MAX_PIECES,
            )
          : [],
      );
      this.missing.clear();
      if (manifest) await this.swarm.acceptManifest(manifest);
    } else if (message.type === 'have') {
      if (Number.isInteger(index) && index >= 0 && index < MAX_PIECES) {
        this.indices.add(index);
        this.missing.delete(index);
      }
    } else if (message.type === 'get') {
      await this.sendPiece(index);
    } else if (message.type === 'miss' && this.pending?.index === index) {
      this.missing.add(index);
      this.settle(null);
    }
    this.swarm.changed();
  }

  async sendPiece(index) {
    const { pieces } = this.swarm;
    if (!pieces.manifest || !validIndex(pieces.manifest, index)) return;
    if (this.sending) return;
    this.sending = true;
    try {
      const bytes = await pieces.get(index);
      if (this.closed) return;
      if (!bytes) {
        this.send({ type: 'miss', index });
        return;
      }
      const payload = new Uint8Array(bytes.byteLength + 4);
      new DataView(payload.buffer).setUint32(0, index);
      payload.set(new Uint8Array(bytes), 4);
      this.endpoint.write(payload);
      this.swarm.uploaded += bytes.byteLength;
      this.swarm.changed();
    } finally {
      this.sending = false;
    }
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    this.endpoint?.close();
    this.connection.close();
    this.swarm.links.delete(this.peer);
    this.settle(null);
  }
}

class VideoSwarm {
  constructor({ room, id, source = null, manifest = null, update = () => {} }) {
    this.room = room;
    this.peer = crypto.randomUUID();
    this.pieces = new VideoPieces(id, source);
    this.seed = manifest;
    this.update = update;
    this.links = new Map();
    this.signals = new Map();
    this.waiters = new Set();
    this.inflight = new Map();
    this.iceServers = [];
    this.received = 0;
    this.uploaded = 0;
    this.lastPeer = '';
    this.closed = false;
    this.onSignal = (event) => {
      if (event.room !== this.room || event.message.target !== this.peer) {
        return;
      }
      const { source } = event.message;
      if (this.joined) {
        this.connect(source).receiveSignal(event.message);
      } else {
        const pending = this.signals.get(source) ?? [];
        if (pending.length < MAX_SIGNALS) pending.push(event.message);
        this.signals.set(source, pending);
      }
    };
    this.onPeers = ({ room, peers }) => {
      if (room === this.room && this.joined) this.reconcile(peers);
    };
  }

  async start() {
    if (this.seed) await this.pieces.install(this.seed);
    else await this.pieces.restore().catch(() => {});
    if (this.closed) return;
    this.changed();
    const url = location.origin.replace(/^http/, 'ws');
    this.client = Metacom.create(url);
    await this.client.open();
    if (this.closed) {
      this.client.close();
      return;
    }
    await this.client.load('video');
    if (this.closed) return;
    this.api = this.client.api.video;
    this.api.on('signal', this.onSignal);
    this.api.on('peers', this.onPeers);
    await this.announce();
    if (this.closed) return;
    this.timer = setInterval(() => {
      this.announce().catch(() => {});
    }, HEARTBEAT_MS);
  }

  async announce() {
    const { peer, room } = this;
    const result = await this.api.announce({
      room,
      peer,
      host: location.hostname,
    });
    if (this.closed) {
      await this.api.leave({ room, peer }).catch(() => {});
      return;
    }
    if (!result) throw new Error('The video swarm is full. Try again shortly.');
    this.iceServers = result.iceServers ?? this.iceServers;
    this.joined = true;
    this.reconcile(result.peers);
    for (const [peer, pending] of this.signals) {
      const link = this.links.get(peer);
      if (!link) continue;
      for (const message of pending) link.receiveSignal(message);
    }
    this.signals.clear();
  }

  reconcile(peers) {
    if (this.closed) return;
    const online = new Set(peers);
    for (const [peer, link] of this.links) {
      if (!online.has(peer)) link.close();
    }
    for (const peer of online) {
      if (peer !== this.peer) this.connect(peer);
    }
  }

  connect(peer) {
    const existing = this.links.get(peer);
    if (existing) return existing;
    const link = new VideoLink(this, peer);
    this.links.set(peer, link);
    queueMicrotask(() => {
      if (!link.closed) link.open().catch(() => link.close());
    });
    return link;
  }

  async sendSignal(to, message) {
    const { room, peer: from } = this;
    await this.api.signal({ room, from, to, message });
  }

  async acceptManifest(value) {
    if (this.pieces.manifest) return;
    const manifest = await checkedManifest(this.pieces.id, value);
    if (!manifest || this.pieces.manifest || this.closed) return;
    await this.pieces.install(manifest);
    for (const link of this.links.values()) link.state();
    this.changed();
  }

  changed() {
    for (const wake of this.waiters) wake();
    this.waiters.clear();
    this.update(this);
  }

  wait(deadline) {
    const time = Math.max(0, deadline - Date.now());
    return new Promise((resolve) => {
      let timer = null;
      const wake = () => {
        clearTimeout(timer);
        this.waiters.delete(wake);
        resolve();
      };
      timer = setTimeout(wake, time);
      this.waiters.add(wake);
    });
  }

  get(index) {
    if (!this.pieces.manifest || !validIndex(this.pieces.manifest, index)) {
      return Promise.reject(new Error('Invalid video piece.'));
    }
    if (this.inflight.has(index)) return this.inflight.get(index);
    const task = this.fetch(index).finally(() => this.inflight.delete(index));
    this.inflight.set(index, task);
    return task;
  }

  async fetch(index) {
    const local = await this.pieces.get(index);
    if (local) return local;
    const deadline = Date.now() + PIECE_WAIT_MS;
    while (!this.closed && Date.now() < deadline) {
      const sources = [...this.links.values()];
      const start = sources.findIndex(({ peer }) => peer === this.lastPeer) + 1;
      const ordered = [...sources.slice(start), ...sources.slice(0, start)];
      const link = ordered.find((source) => source.canSend(index));
      if (!link) {
        await this.wait(deadline);
        continue;
      }
      this.lastPeer = link.peer;
      const bytes = await link.ask(index);
      if (!bytes) continue;
      const verified = await this.pieces.put(index, bytes);
      if (!verified) {
        link.close();
        continue;
      }
      this.received += bytes.byteLength;
      for (const other of this.links.values()) {
        other.send({ type: 'have', index });
      }
      this.changed();
      return bytes;
    }
    throw new Error('Waiting for a peer with this part of the video.');
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    clearInterval(this.timer);
    this.api?.off('signal', this.onSignal);
    this.api?.off('peers', this.onPeers);
    if (this.api) {
      this.api
        .leave({ room: this.room, peer: this.peer })
        .catch(() => {})
        .finally(() => this.client.close());
    } else {
      this.client?.close();
    }
    for (const link of this.links.values()) link.close();
    this.signals.clear();
    this.changed();
  }
}

export { VideoSwarm };
