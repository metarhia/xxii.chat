({
  access: 'public',

  errors: {
    'call/not-found': 'Call not found',
    'call/admin-only': 'Admin only',
    'call/full': 'Call is full',
  },

  method: async (args) => domain.call.admit(context.client, args),
});
