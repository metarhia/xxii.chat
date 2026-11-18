({
  api: {
    ports: [Number(process.env.XXII_PORT ?? 8000)],
    protocols: ['http/1.1'],
    cors: { origin: '*' },
  },
  rtc: {
    ports: [Number(process.env.XXII_ICE_PORT ?? 3478)],
    transports: ['udp', 'tcp'],
    protocols: ['stun.turn'],
  },
});
