({
  access: 'public',

  method: async ({ deltas }) => {
    await domain.sync.applyDelta(deltas);
    return true;
  },
});
