({
  access: 'public',

  method: async ({ room }) => {
    const state = await domain.sync.getState(room);
    return { state };
  },
});
