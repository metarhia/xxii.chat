const ROOM = /^[0-9a-f]{64}$/;
const PEER = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
const LEASE_MS = 45000;
const MAX_ROOMS = 512;
const MAX_MEMBERS = 12;
const MAX_SHARES = 4;
const SIGNAL_WINDOW = 10000;
const MAX_SIGNALS = 120;

const isRoom = (value) => typeof value === 'string' && ROOM.test(value);
const isPeer = (value) => typeof value === 'string' && PEER.test(value);
const isSmallString = (value, limit) =>
  typeof value === 'string' && value.length <= limit;

const validSignal = (from, to, data) => {
  if (
    data?.protocol !== 'metacom:rtc' ||
    data.version !== 1 ||
    data.source !== from ||
    data.target !== to ||
    !isPeer(data.generation)
  ) {
    return false;
  }
  const { description, candidate } = data;
  if (description) {
    return (
      candidate === undefined &&
      ['offer', 'answer'].includes(description.type) &&
      typeof description.sdp === 'string' &&
      description.sdp.length <= 65536
    );
  }
  return (
    isSmallString(candidate?.candidate, 2048) &&
    (candidate.sdpMid === null || isSmallString(candidate.sdpMid, 64)) &&
    (candidate.sdpMLineIndex === null ||
      Number.isSafeInteger(candidate.sdpMLineIndex)) &&
    (candidate.usernameFragment === null ||
      candidate.usernameFragment === undefined ||
      isSmallString(candidate.usernameFragment, 256))
  );
};

({
  rooms: new Map(),
  members: new WeakMap(),

  publish(room, group) {
    const peers = [...group.keys()];
    for (const { client } of group.values()) {
      client.emit('video/peers', { room, peers });
    }
  },

  leave(client, { room, peer }) {
    const { rooms, members } = domain.video;
    const group = rooms.get(room);
    if (group?.get(peer)?.client !== client) return false;
    group.delete(peer);
    members.get(client)?.delete(room);
    if (group.size) domain.video.publish(room, group);
    else rooms.delete(room);
    return true;
  },

  sweep() {
    const cutoff = Date.now() - LEASE_MS;
    for (const [room, group] of domain.video.rooms) {
      for (const [peer, { last, client }] of group) {
        if (last < cutoff) domain.video.leave(client, { room, peer });
      }
    }
  },

  announce(client, { room, peer, host }) {
    if (!isRoom(room) || !isPeer(peer)) return null;
    const { rooms, members } = domain.video;
    domain.video.sweep();
    const now = Date.now();
    let group = rooms.get(room);
    const existing = group?.get(peer);
    if (existing && existing.client !== client) return null;
    if (existing) {
      existing.last = now;
      return { peers: [...group.keys()] };
    }
    if (group?.size >= MAX_MEMBERS || (!group && rooms.size >= MAX_ROOMS)) {
      return null;
    }
    let joined = members.get(client);
    if (!joined) {
      joined = new Map();
      members.set(client, joined);
      client.on('close', () => {
        for (const [room, peer] of joined) {
          domain.video.leave(client, { room, peer });
        }
      });
    }
    if (joined.has(room) || joined.size >= MAX_SHARES) return null;
    if (!group) {
      group = new Map();
      rooms.set(room, group);
    }
    joined.set(room, peer);
    group.set(peer, { client, last: now, window: now, signals: 0 });
    domain.video.publish(room, group);
    return {
      peers: [...group.keys()],
      iceServers: domain.ice.servers(peer, host),
    };
  },

  signal(client, { room, from, to, message }) {
    const group = domain.video.rooms.get(room);
    const source = group?.get(from);
    const target = group?.get(to);
    if (
      source?.client !== client ||
      !target ||
      from === to ||
      !validSignal(from, to, message)
    ) {
      return false;
    }
    const now = Date.now();
    if (now - source.window >= SIGNAL_WINDOW) {
      source.window = now;
      source.signals = 0;
    }
    if (++source.signals > MAX_SIGNALS) return false;
    const { protocol, version, generation, description, candidate } = message;
    const data = { protocol, version, source: from, target: to, generation };
    if (description) {
      data.description = { type: description.type, sdp: description.sdp };
    } else {
      const {
        candidate: line,
        sdpMid,
        sdpMLineIndex,
        usernameFragment,
      } = candidate;
      data.candidate = {
        candidate: line,
        sdpMid,
        sdpMLineIndex,
        usernameFragment,
      };
    }
    target.client.emit('video/signal', { room, message: data });
    return true;
  },
});
