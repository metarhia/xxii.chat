({
  async follow(userId, roomId) {
    if (!userId || !roomId) {
      throw new Error('userId and roomId are required');
    }

    const room = await domain.chat.getRoom(roomId);

    if (!room) {
      throw new Error(`Room ${roomId} does not exists`);
    }

    const userKey = `user:${userId}:subscriptions`;
    const userRecord = (await db.globalstorage.get(userKey)) || { rooms: [] };

    if (!userRecord.rooms.includes(roomId)) {
      userRecord.rooms.push(roomId);
      await db.globalstorage.set(userKey, userRecord);
    }

    const roomKey = `room:${roomId}:followers`;
    const roomRecord = (await db.globalstorage.get(roomKey)) || { users: [] };

    if (!roomRecord.users.includes(userId)) {
      roomRecord.users.push(userId);
      await db.globalstorage.set(roomKey, roomRecord);
    }

    return { userId, room: roomId };
  },

  async unfollow(userId, roomId) {
    const userKey = `user:${userId}:subscriptions`;
    const roomKey = `room:${roomId}:followers`;

    const userRecord = await db.globalstorage.get(userKey);
    const roomRecord = await db.globalstorage.get(roomKey);

    if (userRecord?.rooms) {
      userRecord.rooms = userRecord.rooms.filter((r) => r !== roomId);
      await db.globalstorage.set(userKey, userRecord);
    }

    if (roomRecord?.users) {
      roomRecord.users = roomRecord.users.filter((u) => u !== userId);
      await db.globalstorage.set(roomKey, roomRecord);
    }

    return { userId, room: roomId };
  },

  async getFollowers(roomId) {
    const key = `room:${roomId}:followers`;
    const record = await db.globalstorage.get(key);
    return record?.users ?? [];
  },

  async getUserSubscriptions(userId) {
    const key = `user:${userId}:subscriptions`;
    const record = await db.globalstorage.get(key);
    return record?.rooms ?? [];
  },
});
