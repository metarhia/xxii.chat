({
  LIMIT: 256,

  attached() {
    const { replica, chat } = db.globalstorage;
    return chat.filesOf(replica);
  },

  pathOf(checksum) {
    return node.path.join(db.globalstorage.files, checksum);
  },

  async exists(checksum) {
    const path = domain.files.pathOf(checksum);
    return node.fsp.access(path).then(
      () => true,
      () => false,
    );
  },

  async missing(checksums) {
    if (!Array.isArray(checksums)) return [];
    const attached = domain.files.attached();
    const list = checksums.slice(0, domain.files.LIMIT);
    const known = list.filter((checksum) => attached.has(checksum));
    const found = await Promise.all(known.map(domain.files.exists));
    return known.filter((checksum, index) => !found[index]);
  },

  async *digest(source, hash) {
    for await (const chunk of source) {
      hash.update(chunk);
      yield chunk;
    }
  },

  async save(stream, checksum) {
    const file = domain.files.attached().get(checksum);
    if (file?.size !== stream.size) {
      await stream.terminate();
      throw new Error('File is not attached to any message');
    }
    const path = domain.files.pathOf(checksum);
    const temporary = `${path}.${node.crypto.randomUUID()}`;
    const hash = node.crypto.createHash('sha256');
    const source = domain.files.digest(stream, hash);
    const target = node.fs.createWriteStream(temporary);
    try {
      await node.stream.promises.pipeline(source, target);
      const isSame = hash.digest('hex') === checksum;
      if (!isSame) throw new Error('File does not match its checksum');
      await node.fsp.rename(temporary, path);
      return true;
    } catch (error) {
      await node.fsp.rm(temporary, { force: true });
      throw error;
    }
  },

  async send(client, checksum, id) {
    const isAttached = domain.files.attached().has(checksum);
    if (!isAttached) throw new Error('File is not attached to any message');
    const path = domain.files.pathOf(checksum);
    const { size } = await node.fsp.stat(path);
    const stream = client.createStream(checksum, size, id);
    const source = node.fs.createReadStream(path);
    domain.files.write(source, stream).catch(() => stream.terminate());
    return { id: stream.id, size };
  },

  async write(source, stream) {
    for await (const chunk of source) {
      if (!stream.write(chunk)) await stream.toPromise('drain');
    }
    stream.end();
  },
});
