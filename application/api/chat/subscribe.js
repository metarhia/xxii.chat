({
  access: 'public',

  method: async ({ room }) => {
    const clients = await domain.chat.getRoom(room);
    clients.add(context.client);
    context.client.on('close', () => {
      clients.delete(context.client);
    });
    return true;
  },
});
