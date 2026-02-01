({
  access: 'public',

  method: async ({ deltas, room }) => {
    await domain.sync.applyDelta(deltas, room, context.client);
    return true;
  },
});
