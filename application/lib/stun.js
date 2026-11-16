({
  COOKIE: 0x2112a442,
  HEADER_SIZE: 20,
  FINGERPRINT_XOR: 0x5354554e,
  INTEGRITY_SIZE: 24,
  FINGERPRINT_SIZE: 8,
  CLASSES: ['request', 'indication', 'success', 'error'],

  METHODS: {
    binding: 0x001,
    allocate: 0x003,
    refresh: 0x004,
    send: 0x006,
    data: 0x007,
    createPermission: 0x008,
    channelBind: 0x009,
  },

  ATTRIBUTES: {
    mappedAddress: 0x0001,
    username: 0x0006,
    messageIntegrity: 0x0008,
    errorCode: 0x0009,
    unknownAttributes: 0x000a,
    channelNumber: 0x000c,
    lifetime: 0x000d,
    xorPeerAddress: 0x0012,
    data: 0x0013,
    realm: 0x0014,
    nonce: 0x0015,
    xorRelayedAddress: 0x0016,
    requestedTransport: 0x0019,
    xorMappedAddress: 0x0020,
    software: 0x8022,
    fingerprint: 0x8028,
  },

  typeOf(method, kind) {
    const index = lib.stun.CLASSES.indexOf(kind);
    const low = method & 0x000f;
    const middle = (method & 0x0070) << 1;
    const high = (method & 0x0f80) << 2;
    const lowBit = (index & 1) << 4;
    const highBit = (index & 2) << 7;
    return low | middle | high | lowBit | highBit;
  },

  methodOf(type) {
    const low = type & 0x000f;
    const middle = (type >> 1) & 0x0070;
    const high = (type >> 2) & 0x0f80;
    return low | middle | high;
  },

  classOf(type) {
    const index = ((type >> 7) & 0x2) | ((type >> 4) & 0x1);
    return lib.stun.CLASSES[index];
  },

  isStun(buffer) {
    if (buffer.length < lib.stun.HEADER_SIZE) return false;
    const isZeroTop = (buffer[0] & 0xc0) === 0;
    return isZeroTop && buffer.readUInt32BE(4) === lib.stun.COOKIE;
  },

  decode(buffer) {
    if (!lib.stun.isStun(buffer)) return null;
    const length = buffer.readUInt16BE(2);
    const end = lib.stun.HEADER_SIZE + length;
    if (length % 4 !== 0 || end > buffer.length) return null;
    const type = buffer.readUInt16BE(0);
    const transactionId = buffer.subarray(8, lib.stun.HEADER_SIZE);
    const attributes = [];
    let offset = lib.stun.HEADER_SIZE;
    while (offset + 4 <= end) {
      const size = buffer.readUInt16BE(offset + 2);
      const start = offset + 4;
      if (start + size > end) return null;
      const value = buffer.subarray(start, start + size);
      const attribute = { type: buffer.readUInt16BE(offset), value, offset };
      attributes.push(attribute);
      offset = start + Math.ceil(size / 4) * 4;
    }
    const method = lib.stun.methodOf(type);
    const kind = lib.stun.classOf(type);
    return { type, method, kind, length, transactionId, attributes };
  },

  find(message, type) {
    return message.attributes.find((attribute) => attribute.type === type);
  },

  attribute(type, value) {
    const padding = (4 - (value.length % 4)) % 4;
    const header = Buffer.alloc(4);
    header.writeUInt16BE(type, 0);
    header.writeUInt16BE(value.length, 2);
    return Buffer.concat([header, value, Buffer.alloc(padding)]);
  },

  header(type, length, transactionId) {
    const header = Buffer.alloc(lib.stun.HEADER_SIZE);
    header.writeUInt16BE(type, 0);
    header.writeUInt16BE(length, 2);
    header.writeUInt32BE(lib.stun.COOKIE, 4);
    transactionId.copy(header, 8);
    return header;
  },

  encode({ type, transactionId, attributes, key, fingerprint }) {
    const parts = attributes.map(({ type: name, value }) =>
      lib.stun.attribute(name, value),
    );
    let body = Buffer.concat(parts);
    if (key) {
      const length = body.length + lib.stun.INTEGRITY_SIZE;
      const header = lib.stun.header(type, length, transactionId);
      const hmac = lib.stun.hmac(key, Buffer.concat([header, body]));
      const integrity = lib.stun.ATTRIBUTES.messageIntegrity;
      body = Buffer.concat([body, lib.stun.attribute(integrity, hmac)]);
    }
    if (fingerprint) {
      const length = body.length + lib.stun.FINGERPRINT_SIZE;
      const header = lib.stun.header(type, length, transactionId);
      const crc = lib.stun.crc(Buffer.concat([header, body]));
      const name = lib.stun.ATTRIBUTES.fingerprint;
      body = Buffer.concat([body, lib.stun.attribute(name, crc)]);
    }
    const head = lib.stun.header(type, body.length, transactionId);
    return Buffer.concat([head, body]);
  },

  hmac(key, data) {
    return node.crypto.createHmac('sha1', key).update(data).digest();
  },

  crc(data) {
    const value = Buffer.alloc(4);
    const crc = node.zlib.crc32(data) ^ lib.stun.FINGERPRINT_XOR;
    value.writeUInt32BE(crc >>> 0, 0);
    return value;
  },

  verifyIntegrity(buffer, message, key) {
    const integrity = lib.stun.ATTRIBUTES.messageIntegrity;
    const attribute = lib.stun.find(message, integrity);
    if (!attribute || attribute.value.length !== 20) return false;
    const signed = Buffer.from(buffer.subarray(0, attribute.offset));
    const length = attribute.offset + lib.stun.INTEGRITY_SIZE;
    signed.writeUInt16BE(length - lib.stun.HEADER_SIZE, 2);
    const expected = lib.stun.hmac(key, signed);
    return node.crypto.timingSafeEqual(expected, attribute.value);
  },

  verifyFingerprint(buffer, message) {
    const name = lib.stun.ATTRIBUTES.fingerprint;
    const last = message.attributes.at(-1);
    if (last?.type !== name || last.value.length !== 4) return false;
    const expected = lib.stun.crc(buffer.subarray(0, last.offset));
    return expected.equals(last.value);
  },

  longTermKey(username, realm, password) {
    const text = `${username}:${realm}:${password}`;
    return node.crypto.createHash('md5').update(text).digest();
  },

  readAddress(value, transactionId) {
    const isV4 = value[1] === 0x01;
    const port = value.readUInt16BE(2) ^ (lib.stun.COOKIE >>> 16);
    const mask = Buffer.alloc(16);
    mask.writeUInt32BE(lib.stun.COOKIE, 0);
    transactionId.copy(mask, 4);
    const size = isV4 ? 4 : 16;
    const bytes = Buffer.alloc(size);
    for (let i = 0; i < size; i++) bytes[i] = value[4 + i] ^ mask[i];
    const family = isV4 ? 'IPv4' : 'IPv6';
    const address = isV4 ? bytes.join('.') : lib.stun.formatV6(bytes);
    return { family, address, port };
  },

  writeAddress({ family, address, port }, transactionId) {
    const isV4 = family === 'IPv4';
    const bytes = isV4 ? lib.stun.parseV4(address) : lib.stun.parseV6(address);
    const value = Buffer.alloc(4 + bytes.length);
    value[1] = isV4 ? 0x01 : 0x02;
    value.writeUInt16BE(port ^ (lib.stun.COOKIE >>> 16), 2);
    const mask = Buffer.alloc(16);
    mask.writeUInt32BE(lib.stun.COOKIE, 0);
    transactionId.copy(mask, 4);
    for (let i = 0; i < bytes.length; i++) value[4 + i] = bytes[i] ^ mask[i];
    return value;
  },

  parseV4(address) {
    return Buffer.from(address.split('.').map(Number));
  },

  parseV6(address) {
    const halves = address.split('::');
    const head = halves[0] ? halves[0].split(':') : [];
    const tail = halves.length > 1 && halves[1] ? halves[1].split(':') : [];
    const missing = 8 - head.length - tail.length;
    const zeros = new Array(missing).fill('0');
    const groups = halves.length > 1 ? head.concat(zeros, tail) : head;
    const bytes = Buffer.alloc(16);
    for (let i = 0; i < groups.length; i++) {
      bytes.writeUInt16BE(parseInt(groups[i], 16), i * 2);
    }
    return bytes;
  },

  formatV6(bytes) {
    const groups = [];
    for (let i = 0; i < 16; i += 2) {
      groups.push(bytes.readUInt16BE(i).toString(16));
    }
    return groups.join(':');
  },

  errorCode(code, reason) {
    const text = Buffer.from(reason);
    const value = Buffer.alloc(4 + text.length);
    value[2] = Math.floor(code / 100);
    value[3] = code % 100;
    text.copy(value, 4);
    return value;
  },
});
