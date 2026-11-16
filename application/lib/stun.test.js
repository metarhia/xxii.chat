({
  name: 'STUN codec',
  options: {},

  async run(t) {
    const hex = (lines) => Buffer.from(lines.join(''), 'hex');
    const password = 'VOkJxbRl1RmTxUk/WvJxBt';
    const request = hex([
      '000100582112a442b7e7a701bc34d686fa87dfae',
      '802200105354554e207465737420636c69656e74',
      '002400046e0001ff80290008932ff9b151263b36',
      '000600096576746a3a6836765920202000080014',
      '9aeaa70cbfd8cb56781ef2b5b2d3f249c1b571a2',
      '80280004e57a3bcf',
    ]);
    const ipv4 = hex([
      '0101003c2112a442b7e7a701bc34d686fa87dfae',
      '8022000b7465737420766563746f722000200008',
      '0001a147e112a643000800142b91f599fd9e90c3',
      '8c7489f92af9ba53f06be7d780280004c07d4c96',
    ]);
    const ipv6 = hex([
      '010100482112a442b7e7a701bc34d686fa87dfae',
      '8022000b7465737420766563746f722000200014',
      '0002a1470113a9faa5d3f179bc25f4b5bed2b9d9',
      '00080014a382954e4be67bf11784c97c8292c275',
      'bfe3ed4180280004c8fb0b4c',
    ]);

    const check = (packet) => {
      const message = lib.stun.decode(packet);
      node.assert.ok(message);
      node.assert.ok(lib.stun.verifyIntegrity(packet, message, password));
      node.assert.ok(lib.stun.verifyFingerprint(packet, message));
      return message;
    };

    await t.test('RFC 5769 request keeps space padding', async () => {
      const message = check(request);
      node.assert.strictEqual(message.method, lib.stun.METHODS.binding);
      node.assert.strictEqual(message.kind, 'request');
      const username = lib.stun.find(message, lib.stun.ATTRIBUTES.username);
      node.assert.strictEqual(username.value.toString(), 'evtj:h6vY');
      node.assert.ok(request.includes(0x20));
    });

    await t.test('RFC 5769 IPv4 XOR-MAPPED-ADDRESS', async () => {
      const message = check(ipv4);
      const name = lib.stun.ATTRIBUTES.xorMappedAddress;
      const mapped = lib.stun.readAddress(
        lib.stun.find(message, name).value,
        message.transactionId,
      );
      node.assert.deepStrictEqual(mapped, {
        family: 'IPv4',
        address: '192.0.2.1',
        port: 32853,
      });
    });

    await t.test('RFC 5769 IPv6 XOR-MAPPED-ADDRESS', async () => {
      const message = check(ipv6);
      const name = lib.stun.ATTRIBUTES.xorMappedAddress;
      const mapped = lib.stun.readAddress(
        lib.stun.find(message, name).value,
        message.transactionId,
      );
      const address = '2001:db8:1234:5678:11:2233:4455:6677';
      node.assert.deepStrictEqual(mapped, {
        family: 'IPv6',
        address,
        port: 32853,
      });
    });

    await t.test('message types for Allocate and Send', async () => {
      const allocate = lib.stun.typeOf(lib.stun.METHODS.allocate, 'error');
      const send = lib.stun.typeOf(lib.stun.METHODS.send, 'indication');
      node.assert.strictEqual(allocate, 0x0113);
      node.assert.strictEqual(send, 0x0016);
      node.assert.strictEqual(lib.stun.methodOf(allocate), 0x003);
      node.assert.strictEqual(lib.stun.classOf(send), 'indication');
    });

    await t.test('long-term integrity round trip', async () => {
      const transactionId = node.crypto.randomBytes(12);
      const key = lib.stun.longTermKey('ada', 'xxii', 'secret');
      const unknown = Buffer.from([0x0a, 0x0b, 0x0c]);
      const attributes = [{ type: 0x0002, value: unknown }];
      const type = lib.stun.typeOf(lib.stun.METHODS.binding, 'request');
      const packet = lib.stun.encode({
        type,
        transactionId,
        attributes,
        key,
        fingerprint: true,
      });
      const message = lib.stun.decode(packet);
      node.assert.ok(lib.stun.verifyIntegrity(packet, message, key));
      node.assert.ok(lib.stun.verifyFingerprint(packet, message));
      const found = lib.stun.find(message, 0x0002);
      node.assert.strictEqual(found.value.length, 3);
      node.assert.ok(found.value.equals(unknown));
    });

    await t.test('address round trip and non-STUN input', async () => {
      const transactionId = node.crypto.randomBytes(12);
      const ipv4Address = { family: 'IPv4', address: '192.0.2.1', port: 32853 };
      const encoded4 = lib.stun.writeAddress(ipv4Address, transactionId);
      const read4 = lib.stun.readAddress(encoded4, transactionId);
      node.assert.deepStrictEqual(read4, ipv4Address);
      const address = '2001:db8:1234:5678:11:2233:4455:6677';
      const ipv6Address = { family: 'IPv6', address, port: 32853 };
      const encoded6 = lib.stun.writeAddress(ipv6Address, transactionId);
      const read6 = lib.stun.readAddress(encoded6, transactionId);
      node.assert.deepStrictEqual(read6, ipv6Address);
      node.assert.strictEqual(lib.stun.decode(Buffer.from('hello')), null);
      node.assert.strictEqual(lib.stun.decode(Buffer.alloc(10)), null);
    });
  },
});
