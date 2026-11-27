({
  access: 'public',

  method: async (args) => domain.video.signal(context.client, args),
});
