import { Metacom, MetacomPeer } from './metacom.js';
import { SyncService, Uplink } from './globalstorage.js';

const HOST_ID = 'host';
const GUEST_ID = 'guest';
const ICE = { iceServers: [] };

const channelName = (room) => `xxii-chat:${room}`;

const broadcastSignaling = (name) => {
  const channel = new BroadcastChannel(name);
  return {
    send(message) {
      channel.postMessage(message);
    },
    subscribe(listener) {
      const receive = ({ data }) => listener(data);
      channel.addEventListener('message', receive);
      return () => channel.removeEventListener('message', receive);
    },
    close() {
      channel.close();
    },
  };
};

const serverSignaling = (app) => {
  const listeners = new Set();
  let room = '';
  let warned = false;

  const receive = (message) => {
    for (const listener of listeners) listener(message);
  };

  const signal = () => app.api?.signal;

  const bind = () => {
    const api = signal();
    if (!api?.on) return;
    if (api.listeners('message').includes(receive)) return;
    api.on('message', receive);
  };

  const warn = (error) => {
    if (warned) return;
    warned = true;
    app.logger.log('Server signaling is unavailable:', error.message);
  };

  return {
    async join(next) {
      room = next;
      const api = signal();
      if (!api?.join) return;
      try {
        await api.join({ room });
        bind();
      } catch (error) {
        warn(error);
      }
    },
    async send(message) {
      const api = signal();
      if (!api?.publish || room === '') return;
      try {
        await api.publish({ room, message });
      } catch (error) {
        warn(error);
      }
    },
    subscribe(listener) {
      bind();
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    close() {
      signal()?.off('message', receive);
      listeners.clear();
    },
  };
};

const combineSignaling = (adapters) => ({
  join: (room) => Promise.all(adapters.map((adapter) => adapter.join?.(room))),
  async send(message) {
    for (const adapter of adapters) await adapter.send(message);
  },
  subscribe(listener) {
    const unsubscribe = adapters.map((adapter) => adapter.subscribe(listener));
    return () => {
      for (const stop of unsubscribe) stop();
    };
  },
  close() {
    for (const adapter of adapters) adapter.close?.();
  },
});

const rtcOptions = (signaling, localId, peerId, role) => ({
  localId,
  peerId,
  role,
  signaling,
  configuration: ICE,
  handshakeTimeout: role === 'answerer' ? 120000 : 10000,
});

const createPeerSession = (app) => {
  let role = '';
  let stop = null;
  let signaling = null;

  const setStatus = (text) => app.setPeerStatus(text);

  const mark = (connected) => {
    app.peerConnected = connected;
    app.updateInterface();
  };

  const openSignaling = async (room) => {
    if (app.metacom) await app.metacom.load('signal').catch(() => {});
    const link = combineSignaling([
      broadcastSignaling(channelName(room)),
      serverSignaling(app),
    ]);
    await link.join(room);
    return link;
  };

  const session = {
    get role() {
      return role;
    },

    async host(room) {
      await session.leave({ quiet: true });
      signaling = await openSignaling(room);
      const peer = new MetacomPeer({
        rtc: rtcOptions(signaling, HOST_ID, GUEST_ID, 'answerer'),
      });
      const options = { unit: 'chat', name: 'peer' };
      const service = new SyncService(app.replica, options);
      peer.register('chat', service.api);
      peer.on('connect', () => {
        mark(true);
        const text = `Peer connected in "${room}". Chat syncs to the server.`;
        setStatus(text);
        app.logger.log('WebRTC peer connected');
      });
      peer.on('disconnect', () => {
        mark(false);
        setStatus(`Hosting "${room}". Waiting for the other peer to rejoin.`);
        app.logger.log('WebRTC peer disconnected');
      });
      peer.on('error', (error) => {
        app.logger.log('Peer error:', error.message);
      });
      stop = () => {
        service.close();
        peer.close();
      };
      role = 'host';
      mark(false);
      await peer.open();
      const text = [
        `Hosting "${room}".`,
        'Join from another tab, or another browser while the server is up.',
        'Messages sync to the peer and to the server.',
      ].join(' ');
      setStatus(text);
      app.logger.log('Hosting WebRTC room:', room);
    },

    async join(room) {
      await session.leave({ quiet: true });
      signaling = await openSignaling(room);
      const client = Metacom.create('peer', {
        transport: 'webrtc',
        rtc: rtcOptions(signaling, GUEST_ID, HOST_ID, 'offerer'),
      });
      const options = { unit: 'chat', name: 'peer', clear: 'follow' };
      const uplink = new Uplink(app.replica, client, options);
      uplink.on('error', (error) => {
        app.logger.log('Peer sync failed:', error.message);
      });
      uplink.start();
      client.on('open', () => {
        mark(true);
        const text = `Joined "${room}". The same chat syncs to the server.`;
        setStatus(text);
        app.logger.log('WebRTC peer connected');
      });
      client.on('close', () => {
        mark(false);
        app.logger.log('WebRTC peer disconnected');
      });
      client.on('error', (error) => {
        app.logger.log('Peer error:', error.message);
      });
      stop = () => {
        uplink.stop();
        client.close();
      };
      role = 'join';
      mark(false);
      setStatus(`Joining "${room}". Start Host in the other tab first.`);
      try {
        await client.open();
      } catch (error) {
        app.logger.log('Waiting for the host:', error.message);
      }
    },

    async leave(options = {}) {
      const quiet = options.quiet === true;
      const wasActive = role !== '';
      role = '';
      if (stop) stop();
      signaling?.close();
      stop = null;
      signaling = null;
      mark(false);
      if (!wasActive || quiet) return;
      const text = 'Left the peer room. Chat still syncs with the server.';
      setStatus(text);
      app.logger.log('Left WebRTC room');
    },
  };

  return session;
};

export { createPeerSession };
