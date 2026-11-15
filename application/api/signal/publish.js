({
  access: 'public',

  method: async ({ room, message }) =>
    domain.signal.publish(room, message, context.client),
});
