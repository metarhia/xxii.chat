({
  access: 'public',

  errors: {
    'call/forbidden': 'Forbidden',
    'call/not-joined': 'Not in the call',
    'call/limit': 'Media limit reached',
    'call/rate': 'Too many requests',
  },

  method: async (args) => domain.call.update(context.client, args),
});
