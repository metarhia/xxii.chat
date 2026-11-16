({
  access: 'public',

  errors: {
    'call/forbidden': 'Forbidden',
  },

  method: async (args) => domain.call.leave(context.client, args),
});
