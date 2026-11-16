({
  name: 'ICE server',
  options: {},

  async run(t) {
    const exchange = (attributes) => {
      const socket = node.dgram.createSocket('udp4');
      const transactionId = node.crypto.randomBytes(12);
      const type = lib.stun.typeOf(lib.stun.METHODS.binding, 'request');
      const packet = lib.stun.encode({
        type,
        transactionId,
        attributes,
        fingerprint: true,
      });
      const reply = new Promise((resolve, reject) => {
        const fail = () => reject(new Error('no STUN reply'));
        const timer = setTimeout(fail, 2000);
        socket.once('message', (buffer) => {
          clearTimeout(timer);
          resolve(buffer);
        });
      });
      return new Promise((resolve, reject) => {
        socket.bind(0, '127.0.0.1', () => {
          socket.send(packet, config.ice.port, '127.0.0.1', (error) => {
            if (error) reject(error);
          });
        });
        reply.then(
          (buffer) => {
            const local = socket.address();
            socket.close();
            resolve({ buffer, local });
          },
          (error) => {
            socket.close();
            reject(error);
          },
        );
      });
    };

    await t.test('Binding returns the source address', async () => {
      const { buffer, local } = await exchange([]);
      const message = lib.stun.decode(buffer);
      node.assert.ok(lib.stun.verifyFingerprint(buffer, message));
      node.assert.strictEqual(message.kind, 'success');
      const name = lib.stun.ATTRIBUTES.xorMappedAddress;
      const mapped = lib.stun.readAddress(
        lib.stun.find(message, name).value,
        message.transactionId,
      );
      node.assert.strictEqual(mapped.address, local.address);
      node.assert.strictEqual(mapped.port, local.port);
      const software = lib.stun.find(message, lib.stun.ATTRIBUTES.software);
      node.assert.strictEqual(software.value.toString(), 'xxii');
    });

    await t.test('unknown required attribute gets 420', async () => {
      const value = Buffer.from([1]);
      const { buffer } = await exchange([{ type: 0x0002, value }]);
      const message = lib.stun.decode(buffer);
      node.assert.strictEqual(message.kind, 'error');
      const error = lib.stun.find(message, lib.stun.ATTRIBUTES.errorCode);
      const code = error.value[2] * 100 + error.value[3];
      node.assert.strictEqual(code, 420);
      const unknown = lib.stun.ATTRIBUTES.unknownAttributes;
      const list = lib.stun.find(message, unknown);
      node.assert.strictEqual(list.value.readUInt16BE(0), 0x0002);
    });

    await t.test('tab host is used when config host is empty', async () => {
      const servers = domain.ice.servers('peerA', 'chat.example.com');
      const urls = ['stun:chat.example.com:3478'];
      node.assert.deepStrictEqual(servers[0], { urls });
      const now = 1_700_000_000_000;
      const credential = domain.ice.credentials('peerA', now);
      const ttl = config.ice.credentialTtl;
      const expiry = Math.floor(now / 1000) + ttl;
      node.assert.strictEqual(credential.username, `${expiry}:peerA`);
      node.assert.strictEqual(credential.expiry, expiry);
      node.assert.ok(credential.credential.length > 0);
    });

    await t.test('config host overrides the tab host', async () => {
      config.ice.host = 'stun.internal';
      try {
        const servers = domain.ice.servers('peerA', 'chat.example.com');
        const urls = ['stun:stun.internal:3478'];
        node.assert.deepStrictEqual(servers[0], { urls });
      } finally {
        config.ice.host = '';
      }
    });

    await t.test('invalid or missing host returns external', async () => {
      const { external } = config.ice;
      const spaced = domain.ice.servers('peerA', 'a b');
      const missing = domain.ice.servers('peerA', undefined);
      const empty = domain.ice.servers('peerA', '');
      node.assert.deepStrictEqual(spaced, external);
      node.assert.deepStrictEqual(missing, external);
      node.assert.deepStrictEqual(empty, external);
    });

    await t.test('bracketed IPv6 host is a STUN URL', async () => {
      const servers = domain.ice.servers('peerA', '[::1]');
      const urls = ['stun:[::1]:3478'];
      node.assert.deepStrictEqual(servers[0], { urls });
    });

    await t.test('turn uses the given name', async () => {
      const relay = domain.ice.turn('peerA', 'turn.example.com');
      const udp = 'turn:turn.example.com:3478?transport=udp';
      const tcp = 'turn:turn.example.com:3478?transport=tcp';
      node.assert.strictEqual(relay.urls[0], udp);
      node.assert.strictEqual(relay.urls[1], tcp);
    });
  },
});
