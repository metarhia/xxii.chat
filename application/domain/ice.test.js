({
  name: 'ICE server list',
  options: {},

  async run(t) {
    const ice = config.metaice;
    const saved = {
      host: ice.host,
      port: ice.port,
      tlsPort: ice.tlsPort,
      secret: ice.secret,
      external: ice.external,
    };

    const restore = () => {
      ice.host = saved.host;
      ice.port = saved.port;
      ice.tlsPort = saved.tlsPort;
      ice.secret = saved.secret;
      ice.external = saved.external;
    };

    const baseline = () => {
      ice.host = '';
      ice.port = 3478;
      ice.tlsPort = 0;
      ice.secret = '';
      ice.external = [];
    };

    const sameUrls = (actual, expected) => {
      node.assert.strictEqual(actual.length, expected.length);
      for (let index = 0; index < expected.length; index++) {
        node.assert.strictEqual(actual[index], expected[index]);
      }
    };

    const expectStun = (entry, url) => {
      sameUrls(entry.urls, [url]);
      node.assert.strictEqual(Object.keys(entry).length, 1);
    };

    const expectTurn = (entry, peer, urls) => {
      sameUrls(entry.urls, urls);
      const separator = entry.username.indexOf(':');
      const expiryText = entry.username.slice(0, separator);
      const peerName = entry.username.slice(separator + 1);
      node.assert.strictEqual(peerName, peer);
      const expiry = Number(expiryText);
      const { secret, credentialTtl } = ice;
      const now = (expiry - credentialTtl) * 1000;
      const expected = npm.metaice.credentials({
        secret,
        peer,
        credentialTtl,
        now,
      });
      node.assert.strictEqual(entry.username, expected.username);
      node.assert.strictEqual(entry.credential, expected.credential);
      node.assert.strictEqual(Object.keys(entry).length, 3);
    };

    try {
      await t.test('tab host is used when config host is empty', async () => {
        baseline();
        const servers = domain.ice.servers('peerA', 'chat.example.com');
        node.assert.strictEqual(servers.length, 1);
        expectStun(servers[0], 'stun:chat.example.com:3478');
      });

      await t.test('IPv4 host is a STUN URL', async () => {
        baseline();
        const servers = domain.ice.servers('peerA', '127.0.0.1');
        node.assert.strictEqual(servers.length, 1);
        expectStun(servers[0], 'stun:127.0.0.1:3478');
      });

      await t.test('config host overrides the tab host', async () => {
        baseline();
        ice.host = 'stun.internal';
        const named = domain.ice.servers('peerA', 'chat.example.com');
        const ignored = domain.ice.servers('peerA', 'a b');
        node.assert.strictEqual(named.length, 1);
        node.assert.strictEqual(ignored.length, 1);
        expectStun(named[0], 'stun:stun.internal:3478');
        expectStun(ignored[0], 'stun:stun.internal:3478');
      });

      await t.test('bracketed IPv6 host is a STUN URL', async () => {
        baseline();
        const servers = domain.ice.servers('peerA', '[::1]');
        node.assert.strictEqual(servers.length, 1);
        expectStun(servers[0], 'stun:[::1]:3478');
      });

      await t.test('invalid or missing host returns external', async () => {
        baseline();
        const extra = { urls: ['stun:extra.example:3478'] };
        ice.external = [extra];
        ice.secret = 'turn-secret';
        const spaced = domain.ice.servers('peerA', 'a b');
        const missing = domain.ice.servers('peerA', undefined);
        const empty = domain.ice.servers('peerA', '');
        node.assert.strictEqual(spaced, ice.external);
        node.assert.strictEqual(missing, ice.external);
        node.assert.strictEqual(empty, ice.external);
        node.assert.strictEqual(spaced[0], extra);
      });

      await t.test('TURN only when secret and a peer are set', async () => {
        baseline();
        ice.secret = 'turn-secret';
        ice.port = 3499;
        const servers = domain.ice.servers('peerA', 'chat.example.com');
        const stun = 'stun:chat.example.com:3499';
        node.assert.strictEqual(servers.length, 2);
        expectStun(servers[0], stun);
        const udp = 'turn:chat.example.com:3499?transport=udp';
        const tcp = 'turn:chat.example.com:3499?transport=tcp';
        expectTurn(servers[1], 'peerA', [udp, tcp]);
        const absent = domain.ice.servers(undefined, 'chat.example.com');
        const blank = domain.ice.servers('', 'chat.example.com');
        node.assert.strictEqual(absent.length, 1);
        node.assert.strictEqual(blank.length, 1);
        expectStun(absent[0], stun);
        expectStun(blank[0], stun);
      });

      await t.test('no TURN without a secret', async () => {
        baseline();
        const servers = domain.ice.servers('peerA', 'chat.example.com');
        node.assert.strictEqual(servers.length, 1);
        expectStun(servers[0], 'stun:chat.example.com:3478');
      });

      await t.test('turns only when tlsPort is set', async () => {
        baseline();
        ice.secret = 'turn-secret';
        ice.tlsPort = 5349;
        const host = 'chat.example.com';
        const servers = domain.ice.servers('peerA', host);
        const udp = `turn:${host}:3478?transport=udp`;
        const tcp = `turn:${host}:3478?transport=tcp`;
        const tls = `turns:${host}:5349?transport=tcp`;
        node.assert.strictEqual(servers.length, 2);
        expectStun(servers[0], `stun:${host}:3478`);
        expectTurn(servers[1], 'peerA', [udp, tcp, tls]);
        ice.tlsPort = 0;
        const plain = domain.ice.servers('peerA', host);
        node.assert.strictEqual(plain.length, 2);
        expectTurn(plain[1], 'peerA', [udp, tcp]);
      });

      await t.test('external servers are appended unchanged', async () => {
        baseline();
        const extra = {
          urls: ['turn:extra.example:3478'],
          username: 'user',
          credential: 'pass',
        };
        ice.external = [extra];
        ice.secret = 'turn-secret';
        const servers = domain.ice.servers('peerA', 'chat.example.com');
        node.assert.strictEqual(servers.length, 3);
        node.assert.strictEqual(servers[2], extra);
      });
    } finally {
      restore();
    }
  },
});
