({
  access: 'public',

  method: async (args) => domain.call.decline(context.client, args),
});
