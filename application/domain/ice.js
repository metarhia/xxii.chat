({
  HOST: /^(?:[a-z0-9-]+\.)*[a-z0-9-]+$|^\[[0-9a-f:.]+\]$/i,

  isHost(host) {
    const isText = typeof host === 'string' && host.length <= 253;
    return isText && domain.ice.HOST.test(host);
  },

  servers(peer, host) {
    const configured = config.metaice.host;
    const tabHost = domain.ice.isHost(host) ? host : '';
    const name = configured || tabHost;
    if (!name) return config.metaice.external;
    const { port, tlsPort, secret, credentialTtl } = config.metaice;
    const options = { name, port, tlsPort, secret, peer, credentialTtl };
    const list = npm.metaice.iceServers(options);
    return list.concat(config.metaice.external);
  },
});
