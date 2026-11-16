({
  access: 'public',

  errors: {
    'call/forbidden': 'Forbidden',
    'call/not-joined': 'Not in the call',
  },

  method: async (args) => domain.call.ping(context.client, args),
});
