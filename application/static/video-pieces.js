const PIECE_BYTES = 256 * 1024;
const MAX_PIECES = 4096;
const MAX_VIDEO_BYTES = PIECE_BYTES * MAX_PIECES;
const HASH = /^[0-9a-f]{64}$/;
const VIDEO_TYPES = ['video/mp4', 'video/webm', 'video/quicktime', 'video/ogg'];
const CACHE_DIR = 'shared-videos';
const MEMORY_PIECES = 16;

const isHash = (value) => typeof value === 'string' && HASH.test(value);

const hex = (bytes) =>
  Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');

const hashOf = async (bytes) =>
  hex(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)));

const newRoom = () => hex(crypto.getRandomValues(new Uint8Array(32)));

const shareUrlOf = (room, id) => {
  const url = new URL('/watch.html', location.origin);
  url.hash = `${room}.${id}`;
  return url.href;
};

const readShare = (fragment) => {
  const [room, id, extra] = fragment.slice(1).split('.');
  return isHash(room) && isHash(id) && extra === undefined
    ? { room, id }
    : null;
};

const validIndex = (manifest, index) =>
  Number.isInteger(index) && index >= 0 && index < manifest?.hashes.length;

const pieceSize = (manifest, index) =>
  Math.min(PIECE_BYTES, manifest.size - index * PIECE_BYTES);

const sealManifest = (manifest) => {
  const { name, mime, size, hashes } = manifest;
  return hashOf(
    new TextEncoder().encode(JSON.stringify([name, mime, size, hashes])),
  );
};

const checkedManifest = async (id, value) => {
  if (!value || !isHash(id)) return null;
  const { name, mime, size, hashes } = value;
  const valid =
    typeof name === 'string' &&
    name.length > 0 &&
    name.length <= 160 &&
    VIDEO_TYPES.includes(mime) &&
    Number.isSafeInteger(size) &&
    size > 0 &&
    size <= MAX_VIDEO_BYTES &&
    Array.isArray(hashes) &&
    hashes.length === Math.ceil(size / PIECE_BYTES) &&
    hashes.every(isHash);
  if (!valid) return null;
  const manifest = { name, mime, size, hashes };
  const seal = await sealManifest(manifest);
  return seal === id ? manifest : null;
};

const describeVideo = async (file, title, mime, progress, signal) => {
  const { size } = file;
  if (!size || size > MAX_VIDEO_BYTES) {
    throw new Error('Share a video between 1 byte and 1 GB.');
  }
  if (!VIDEO_TYPES.includes(mime)) {
    throw new Error('Share an MP4, WebM, MOV, or Ogg video.');
  }
  const name = title.trim().slice(0, 160) || 'Shared video';
  const hashes = [];
  for (let offset = 0; offset < size; offset += PIECE_BYTES) {
    signal.throwIfAborted();
    const end = Math.min(size, offset + PIECE_BYTES);
    hashes.push(await hashOf(await file.slice(offset, end).arrayBuffer()));
    progress(end / size);
  }
  signal.throwIfAborted();
  const manifest = { name, mime, size, hashes };
  const id = await sealManifest(manifest);
  return { id, manifest };
};

const write = async (dir, name, contents) => {
  const handle = await dir.getFileHandle(name, { create: true });
  const writer = await handle.createWritable();
  try {
    await writer.write(contents);
    await writer.close();
  } catch (error) {
    await writer.abort().catch(() => {});
    throw error;
  }
};

const read = async (dir, name) => {
  const handle = await dir?.getFileHandle(name);
  return handle?.getFile();
};

class VideoPieces {
  constructor(id, source = null) {
    this.id = id;
    this.source = source;
    this.manifest = null;
    this.pieces = new Set();
    this.persisted = new Set();
    this.memory = new Map();
    this.directory = this.openDirectory().catch(() => null);
  }

  async openDirectory() {
    const root = await navigator.storage.getDirectory();
    const parent = await root.getDirectoryHandle(CACHE_DIR, { create: true });
    return parent.getDirectoryHandle(this.id, { create: true });
  }

  async restore() {
    const file = await read(await this.directory, 'manifest.json').catch(
      () => null,
    );
    if (!file || file.size > MAX_PIECES * 70) return null;
    const manifest = await checkedManifest(
      this.id,
      JSON.parse(await file.text()),
    );
    if (manifest) await this.install(manifest);
    return this.manifest;
  }

  async install(manifest) {
    this.manifest = manifest;
    const directory = await this.directory;
    if (!directory) return;
    await write(directory, 'manifest.json', JSON.stringify(manifest)).catch(
      () => {},
    );
    try {
      for await (const name of directory.keys()) {
        const index = Number(name);
        if (name === String(index) && validIndex(manifest, index)) {
          this.pieces.add(index);
          this.persisted.add(index);
        }
      }
    } catch {
      return;
    }
  }

  has(index) {
    return Boolean(this.source) || this.pieces.has(index);
  }

  async get(index) {
    if (!this.has(index) || !validIndex(this.manifest, index)) return null;
    const { manifest, source } = this;
    const offset = index * PIECE_BYTES;
    const cached = async () => read(await this.directory, String(index));
    const file = source
      ? source.slice(offset, offset + PIECE_BYTES)
      : await cached().catch(() => null);
    let bytes = this.memory.get(index);
    if (!bytes) bytes = await file?.arrayBuffer();
    if (bytes?.byteLength === pieceSize(manifest, index)) {
      const hash = await hashOf(bytes);
      if (hash === manifest.hashes[index]) return bytes;
    }
    this.pieces.delete(index);
    this.persisted.delete(index);
    this.memory.delete(index);
    return null;
  }

  async put(index, bytes) {
    if (
      !validIndex(this.manifest, index) ||
      bytes.byteLength !== pieceSize(this.manifest, index)
    ) {
      return false;
    }
    const hash = await hashOf(bytes);
    if (hash !== this.manifest.hashes[index]) return false;
    const directory = await this.directory;
    let persisted = false;
    if (directory) {
      persisted = await write(directory, String(index), bytes).then(
        () => true,
        () => false,
      );
    }
    this.pieces.add(index);
    if (persisted) {
      this.persisted.add(index);
      this.memory.delete(index);
      return true;
    }
    if (this.memory.size >= MEMORY_PIECES) {
      const first = this.memory.keys().next().value;
      this.memory.delete(first);
      this.pieces.delete(first);
    }
    this.memory.set(index, bytes);
    return true;
  }
}

export { PIECE_BYTES, MAX_PIECES, checkedManifest, validIndex, pieceSize };
export { isHash, newRoom, shareUrlOf, readShare, describeVideo, VideoPieces };
