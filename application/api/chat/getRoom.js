({
  access: 'public',

  method: async ({ name }) => {
    await domain.chat.getRoom(name);
    return { name };
  },
});
