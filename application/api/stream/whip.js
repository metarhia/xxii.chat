({
  access: 'public',

  errors: {
    'stream/forbidden': 'Forbidden',
    'stream/rate': 'Too many requests',
    'stream/refused': 'The address is not allowed',
    'stream/failed': 'The endpoint did not answer',
  },

  method: async (args) => domain.stream.whip(context.client, args),
});
