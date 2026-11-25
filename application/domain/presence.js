({
  peers: new Map(),
  clients: new Map(),
  owners: new WeakMap(),
  watched: new WeakSet(),

  isId(value) {
    return typeof value === 'string' && value.length > 0 && value.length <= 64;
  },

  announce(client, { peer, nick, status }) {
    const { peers, clients, owners, watched } = domain.presence;
    if (!domain.presence.isId(peer) || typeof nick !== 'string') return false;
    const previous = owners.get(client);
    if (previous && previous !== peer) domain.presence.leave(client);
    owners.set(client, peer);
    clients.set(peer, client);
    const state = status === 'away' ? 'away' : 'online';
    peers.set(peer, {
      peer,
      nick: nick.slice(0, 32),
      status: state,
      seen: Date.now(),
    });
    if (!watched.has(client)) {
      watched.add(client);
      client.on('close', () => domain.presence.leave(client));
    }
    return domain.presence.publish();
  },

  leave(client) {
    const { peers, clients, owners } = domain.presence;
    const peer = owners.get(client);
    if (!peer) return;
    owners.delete(client);
    if (clients.get(peer) !== client) return;
    clients.delete(peer);
    const entry = peers.get(peer);
    if (entry) {
      entry.status = 'offline';
      entry.seen = Date.now();
    }
    domain.presence.publish();
  },

  peerOf(client) {
    const peer = domain.presence.owners.get(client);
    return typeof peer === 'string' ? peer : '';
  },

  list() {
    return Array.from(domain.presence.peers.values());
  },

  publish() {
    const peers = domain.presence.list();
    const data = Object.freeze({ peers });
    for (const client of domain.presence.clients.values()) {
      client.emit('presence/update', data);
    }
    return peers;
  },

  signal(sender, message) {
    const source = domain.presence.peerOf(sender);
    const isRtc = message?.protocol === 'metacom:rtc';
    if (!isRtc || !source || message.source !== source) return false;
    const client = domain.presence.clients.get(message.target);
    if (!client) return false;
    client.emit('signal/message', message);
    return true;
  },
});
