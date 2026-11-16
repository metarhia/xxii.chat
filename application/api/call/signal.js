({
  access: 'public',

  errors: {
    'call/forbidden': 'Forbidden',
    'call/not-joined': 'Not in the call',
    'call/rate': 'Too many requests',
  },

  method: async (args) => domain.call.signal(context.client, args),
});
