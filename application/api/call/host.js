({
  access: 'public',

  errors: {
    'call/not-found': 'Call not found',
    'call/admin-only': 'Admin only',
    'call/bad-action': 'Unknown action',
  },

  method: async (args) => domain.call.host(context.client, args),
});
