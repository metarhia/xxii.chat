({
  access: 'public',

  method: async (args) => domain.video.announce(context.client, args),
});
