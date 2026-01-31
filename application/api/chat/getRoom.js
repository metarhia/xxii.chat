({
  access: 'public',

  method: async ({ name }) => {
    domain.chat.getRoom(name);
    return { name };
  },
});
