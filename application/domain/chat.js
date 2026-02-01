({
  rooms: new Map(),

  async getRoom(name) {
    let room = domain.chat.rooms.get(name);
    if (room) return room;
    const id = 'room:' + name;
    const exists = await db.globalstorage.has(id);
    if (!exists) {
      await db.globalstorage.set(id, { name, createdAt: Date.now() });
    }
    room = new Set();
    domain.chat.rooms.set(name, room);
    return room;
  },

  send(name, message) {
    const room = domain.chat.rooms.get(name);
    if (!room) throw new Error(`Room ${name} is not found`);
    for (const client of room) {
      client.emit('chat/message', { room: name, message });
    }
  },

  async getMessage(id) {
    return await db.globalstorage.get(id);
  },

  async setMessage(data) {
    const exists = await db.globalstorage.has(data.id);
    if (exists) return;
    await db.globalstorage.set(data.id, data);
  },

  async updateMessage(id, delta) {
    await db.globalstorage.update(id, delta);
  },

  async getMessageIds(room) {
    const key = 'room:' + room + ':messages';
    const record = await db.globalstorage.get(key);
    return record?.ids ?? [];
  },

  async addMessageId(room, id) {
    const key = 'room:' + room + ':messages';
    const ids = await domain.chat.getMessageIds(room);
    if (ids.includes(id)) return;
    ids.push(id);
    await db.globalstorage.set(key, { ids });
  },

  async getDeltas() {
    const record = await db.globalstorage.get('sync:deltas');
    return record?.deltas ?? [];
  },

  async appendDeltas(deltas) {
    const existing = await domain.chat.getDeltas();
    const deltasRecord = { deltas: existing.concat(deltas) };
    await db.globalstorage.set('sync:deltas', deltasRecord);
  },
});
