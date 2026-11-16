({
  access: 'public',

  method: async ({ host }) => {
    const peer = domain.presence.owners.get(context.client);
    return domain.ice.servers(peer, host);
  },
});
