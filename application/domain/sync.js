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

  async applyDelta(deltasToApply, room, excludeClient) {
    for (const delta of deltasToApply) {
      const { strategy, entity, record } = delta;
      if (entity === 'message' && strategy === 'lww') {
        const existing = await domain.chat.getMessage(record.id);
        const base = existing ?? {};
        const merged = { ...base, ...record };
        await domain.chat.setMessage(merged);
        await domain.chat.addMessageId(room, record.id);
      } else if (entity === 'reaction' && strategy === 'counter') {
        const messageId = record.messageId;
        const message = await domain.chat.getMessage(messageId);
        if (!message) return;
        const reactions = { ...message.reactions };
        const count = reactions[record.reaction] || 0;
        reactions[record.reaction] = count + 1;
        await domain.chat.updateMessage(messageId, { reactions });
      }
    }
    await domain.chat.appendDeltas(deltasToApply);

    const packet = { type: 'delta', data: deltasToApply };
    const clients = await domain.chat.getRoom(room);
    if (clients && clients.size > 0) {
      for (const client of clients) {
        if (client === excludeClient) continue;
        client.emit('chat/delta', packet);
      }
    }
  },

  async getDeltasSince(lastDeltaId) {
    const deltas = await domain.chat.getDeltas();
    return deltas.slice(lastDeltaId);
  },

  async getState(room) {
    const ids = await domain.chat.getMessageIds(room);
    const messages = {};
    for (const id of ids) {
      const message = await domain.chat.getMessage(id);
      if (message) messages[id] = message;
    }
    return messages;
  },
});
