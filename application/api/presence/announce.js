({
  access: 'public',

  method: async ({ peer, nick, status }) =>
    domain.presence.announce(context.client, { peer, nick, status }),
});
