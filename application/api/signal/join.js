({
  access: 'public',

  method: async ({ room }) => domain.signal.join(room, context.client),
});
