({
  rooms: new Map(),
  membership: new WeakMap(),
  watched: new WeakSet(),

  join(room, client) {
    if (typeof room !== 'string' || room === '') return false;
    const { rooms, membership, watched } = domain.signal;
    if (membership.get(client) === room) return true;
    domain.signal.leave(client);
    const peers = rooms.get(room) ?? new Set();
    peers.add(client);
    rooms.set(room, peers);
    membership.set(client, room);
    if (!watched.has(client)) {
      watched.add(client);
      client.on('close', () => domain.signal.leave(client));
    }
    return true;
  },

  leave(client) {
    const { rooms, membership } = domain.signal;
    const room = membership.get(client);
    if (!room) return;
    membership.delete(client);
    const peers = rooms.get(room);
    if (!peers) return;
    peers.delete(client);
    if (peers.size === 0) rooms.delete(room);
  },

  publish(room, message, sender) {
    if (message?.protocol !== 'metacom:rtc') return false;
    const peers = domain.signal.rooms.get(room);
    if (!peers) return true;
    for (const client of peers) {
      if (client !== sender) client.emit('signal/message', message);
    }
    return true;
  },
});
