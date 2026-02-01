({
  access: 'public',

  method: async ({ deltas, room }) => {
    const excludeClient = context?.client;
    await domain.sync.applyDelta(deltas, room, excludeClient);
    return true;
  },
});
