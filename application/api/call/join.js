({
  access: 'public',

  errors: {
    'call/forbidden': 'Forbidden',
    'call/not-found': 'Call not found',
    'call/locked': 'Call is locked',
    'call/full': 'Call is full',
  },

  method: async (args) => domain.call.join(context.client, args),
});
