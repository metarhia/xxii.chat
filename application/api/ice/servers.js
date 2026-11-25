({
  access: 'public',

  method: async ({ host }) => {
    const peer = domain.presence.peerOf(context.client);
    return domain.ice.servers(peer, host);
  },
});
