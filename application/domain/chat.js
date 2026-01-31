({
  rooms: new Map(),
  SYNC_ID: 'xxii-chat',

  getRoom(name) {
    let room = domain.chat.rooms.get(name);
    if (room) return room;
    room = new Set();
    domain.chat.rooms.set(name, room);
    return room;
  },

  dropRoom(name) {
    domain.chat.rooms.delete(name);
  },

  send(name, message) {
    const room = domain.chat.rooms.get(name);
    if (!room) throw new Error(`Room ${name} is not found`);
    for (const client of room) {
      client.emit('chat/message', { room: name, message });
    }
  },

  async getStorage() {
    const dataPath = node.path.join(process.cwd(), 'data', 'chat');
    return await npm.globalstorage.open({ path: dataPath });
  },

  async load() {
    const storage = await domain.chat.getStorage();
    const data = await storage.get(domain.chat.SYNC_ID);
    return data || { messages: {}, deltas: [] };
  },

  async save(data) {
    const storage = await domain.chat.getStorage();
    await storage.set(domain.chat.SYNC_ID, data);
  },
});
