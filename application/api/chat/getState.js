({
  access: 'public',

  method: async () => {
    const state = await domain.sync.getState();
    return { state };
  },
});
