({
  access: 'public',

  errors: {
    'call/forbidden': 'Forbidden',
    'call/exists': 'Call already exists',
  },

  method: async (args) => domain.call.open(context.client, args),
});
