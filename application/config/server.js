({
  api: {
    ports: [Number(process.env.XXII_PORT ?? 8000)],
    protocols: ['http/1.1'],
    cors: { origin: '*' },
  },
  rtc: {
    ports: [Number(process.env.XXII_ICE_PORT || 3478)],
    transports: ['udp', 'tcp'],
    protocols: ['stun.turn'],
  },
  ...(() => {
    const raw = process.env.XXII_TURN_TLS_PORT ?? '';
    if (raw === '') return {};
    const ports = [Number(raw)];
    const protocols = ['h2', 'http/1.1', 'stun.turn'];
    const domains = ['localhost', '127.0.0.1'];
    const turnTls = {
      tls: true,
      application: false,
      protocols,
      host: '127.0.0.1',
      ports,
      domains,
    };
    return { turnTls };
  })(),
});
