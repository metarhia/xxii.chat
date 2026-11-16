({
  sockets: [],

  async start() {
    const { port, listen } = config.ice;
    const families = [
      { type: 'udp4', address: listen },
      { type: 'udp6', address: '::' },
    ];
    for (const family of families) {
      const socket = await domain.ice.bind(family, port);
      if (socket) domain.ice.sockets.push(socket);
    }
  },

  async stop() {
    const sockets = domain.ice.sockets.splice(0);
    const closed = sockets.map(
      (socket) => new Promise((resolve) => socket.close(resolve)),
    );
    await Promise.all(closed);
  },

  bind(family, port) {
    const { type, address } = family;
    const ipv6Only = type === 'udp6';
    const socket = node.dgram.createSocket({ type, ipv6Only });
    socket.on('message', (buffer, remote) => {
      domain.ice.receive(socket, buffer, remote);
    });
    return new Promise((resolve) => {
      let isSettled = false;
      const onBindError = () => {
        if (isSettled) return;
        isSettled = true;
        console.debug(`ICE ${type} ${address}:${port} is already owned`);
        socket.close();
        resolve(null);
      };
      const onReady = () => {
        if (isSettled) return;
        isSettled = true;
        socket.off('error', onBindError);
        const onError = (error) => {
          console.warn(`ICE ${type}: ${error.message}`);
        };
        socket.on('error', onError);
        resolve(socket);
      };
      socket.once('error', onBindError);
      socket.bind(port, address, onReady);
    });
  },

  receive(socket, buffer, remote) {
    const message = lib.stun.decode(buffer);
    if (!message) return;
    const isBinding = domain.ice.isBinding(message);
    if (!isBinding) return;
    const unknown = domain.ice.unknown(message);
    if (unknown.length > 0) {
      domain.ice.fail(socket, message, remote, unknown);
      return;
    }
    domain.ice.respond(socket, message, remote);
  },

  isBinding(message) {
    const method = message.method === lib.stun.METHODS.binding;
    return method && message.kind === 'request';
  },

  unknown(message) {
    const known = new Set(Object.values(lib.stun.ATTRIBUTES));
    const types = [];
    for (const attribute of message.attributes) {
      const isRequired = attribute.type < 0x8000;
      if (isRequired && !known.has(attribute.type)) types.push(attribute.type);
    }
    return types;
  },

  respond(socket, message, remote) {
    const { transactionId } = message;
    const mapped = domain.ice.mapped(remote);
    const address = lib.stun.writeAddress(mapped, transactionId);
    const { xorMappedAddress, software } = lib.stun.ATTRIBUTES;
    const attributes = [
      { type: xorMappedAddress, value: address },
      { type: software, value: Buffer.from('xxii') },
    ];
    domain.ice.send(socket, message, remote, attributes, 'success');
  },

  fail(socket, message, remote, types) {
    const { errorCode, unknownAttributes } = lib.stun.ATTRIBUTES;
    const attributes = [
      { type: errorCode, value: lib.stun.errorCode(420, 'Unknown Attribute') },
      { type: unknownAttributes, value: domain.ice.types(types) },
    ];
    domain.ice.send(socket, message, remote, attributes, 'error');
  },

  send(socket, message, remote, attributes, kind) {
    const type = lib.stun.typeOf(lib.stun.METHODS.binding, kind);
    const { transactionId } = message;
    const packet = lib.stun.encode({
      type,
      transactionId,
      attributes,
      fingerprint: true,
    });
    socket.send(packet, remote.port, remote.address);
  },

  mapped(remote) {
    const isV4 = remote.family === 4 || remote.family === 'IPv4';
    const family = isV4 ? 'IPv4' : 'IPv6';
    return { family, address: remote.address, port: remote.port };
  },

  types(values) {
    const value = Buffer.alloc(values.length * 2);
    for (let i = 0; i < values.length; i++) {
      value.writeUInt16BE(values[i], i * 2);
    }
    return value;
  },

  credentials(peer, now = Date.now()) {
    const { secret, credentialTtl } = config.ice;
    const expiry = Math.floor(now / 1000) + credentialTtl;
    const username = `${expiry}:${peer}`;
    const hmac = node.crypto.createHmac('sha1', secret).update(username);
    return { username, credential: hmac.digest('base64'), expiry };
  },

  HOST: /^(?:[a-z0-9-]+\.)*[a-z0-9-]+$|^\[[0-9a-f:.]+\]$/i,

  isHost(host) {
    const isText = typeof host === 'string' && host.length <= 253;
    return isText && domain.ice.HOST.test(host);
  },

  servers(peer, host) {
    const { host: configured, port, secret, external } = config.ice;
    const name = configured || (domain.ice.isHost(host) ? host : '');
    if (!name) return external;
    const list = [{ urls: [`stun:${name}:${port}`] }];
    if (secret && peer) list.push(domain.ice.turn(peer, name));
    return list.concat(external);
  },

  turn(peer, name) {
    const { port, tlsPort } = config.ice;
    const urls = [
      `turn:${name}:${port}?transport=udp`,
      `turn:${name}:${port}?transport=tcp`,
    ];
    if (tlsPort) urls.push(`turns:${name}:${tlsPort}?transport=tcp`);
    const { username, credential } = domain.ice.credentials(peer);
    return { urls, username, credential };
  },
});
