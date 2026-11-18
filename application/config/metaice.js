({
  host: '',
  publicAddress: process.env.XXII_TURN_PUBLIC_ADDRESS ?? '',
  listen: '0.0.0.0',
  port: (() => {
    const raw = process.env.XXII_ICE_PORT ?? '';
    if (raw === '') return 3478;
    return Number(raw);
  })(),
  tlsPort: 0,
  relayPorts: [49160, 49359],
  tls: null,
  realm: 'xxii',
  secret: process.env.XXII_TURN_SECRET ?? '',
  credentialTtl: 24 * 60 * 60,
  allocationsPerPeer: 10,
  allocationLifetime: [600, 3600],
  permissionLifetime: 300,
  channelLifetime: 600,
  relayBitrate: 5_000_000,
  allowPrivatePeers: process.env.XXII_TURN_PRIVATE_PEERS === 'true',
  external: [],
});
