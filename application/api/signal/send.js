({
  access: 'public',

  method: async ({ message }) =>
    domain.presence.signal(context.client, message),
});
