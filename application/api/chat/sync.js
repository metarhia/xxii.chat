({
  access: 'public',

  method: async ({ lastDeltaId = 0 }) => {
    const deltas = await domain.sync.getDeltasSince(lastDeltaId);
    return { deltas };
  },
});
