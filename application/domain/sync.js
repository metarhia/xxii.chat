({
  applyCRDT(messages, delta) {
    const { strategy, entity, record } = delta;
    if (entity === 'message' && strategy === 'lww') {
      messages[record.id] = record;
    } else if (entity === 'reaction' && strategy === 'counter') {
      const { messageId, reaction } = record;
      const message = messages[messageId];
      if (!message) return;
      if (!message.reactions) message.reactions = {};
      const count = message.reactions[reaction] || 0;
      message.reactions[reaction] = count + 1;
    }
  },

  async applyDelta(deltasToApply) {
    const data = await domain.chat.load();
    const messages = data.messages || {};
    const deltas = data.deltas || [];
    for (const delta of deltasToApply) {
      this.applyCRDT(messages, delta);
      deltas.push(delta);
    }
    await domain.chat.save({ messages, deltas });
    const packet = { type: 'delta', data: deltasToApply };
    const room = domain.chat.getRoom('sync');
    if (room && room.size > 0) {
      for (const client of room) {
        client.emit('chat/delta', packet);
      }
    }
  },

  async getDeltasSince(lastDeltaId) {
    const data = await domain.chat.load();
    const deltas = data.deltas || [];
    return deltas.slice(lastDeltaId);
  },

  async getState() {
    const data = await domain.chat.load();
    return data.messages || {};
  },
});
