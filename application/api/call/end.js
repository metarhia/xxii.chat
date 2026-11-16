({
  access: 'public',

  errors: {
    'call/not-found': 'Call not found',
    'call/admin-only': 'Admin only',
  },

  method: async (args) => domain.call.end(context.client, args),
});
