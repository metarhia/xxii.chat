import { fsi } from './globalstorage.js';

const DIRECTORY = 'files';
const DEFAULT_NAME = 'file';
const DEFAULT_MIME = 'application/octet-stream';
const STORED_CHANNEL = 'xxii:files';
const IMAGE = /^image\/(png|jpeg|gif|webp|avif|bmp|svg\+xml)$/;

const stored = new BroadcastChannel(STORED_CHANNEL);

const toHex = (buffer) => {
  const bytes = Array.from(new Uint8Array(buffer));
  return bytes.map((byte) => byte.toString(16).padStart(2, '0')).join('');
};

const checksumOf = async (blob) => {
  const data = await blob.arrayBuffer();
  const digest = await crypto.subtle.digest('SHA-256', data);
  return toHex(digest);
};

const ifMissing = (error) => {
  if (error.name === 'NotFoundError') return null;
  throw error;
};

const openFile = async (checksum) => {
  const root = await navigator.storage.getDirectory();
  const directory = await root.getDirectoryHandle(DIRECTORY);
  const handle = await directory.getFileHandle(checksum);
  return handle.getFile();
};

const readFile = async ({ checksum, size }) => {
  const file = await openFile(checksum).catch(ifMissing);
  return file?.size === size ? file : null;
};

const isImage = (mime) => IMAGE.test(mime);

const imageSize = async (file) => {
  if (!isImage(file.type)) return {};
  const bitmap = await createImageBitmap(file).catch(() => null);
  if (!bitmap) return {};
  const { width, height } = bitmap;
  bitmap.close();
  return { width, height };
};

const writeFile = async (checksum, blob) => {
  await fsi.write(DIRECTORY, checksum, blob);
  stored.postMessage(checksum);
};

const saveFile = async ({ checksum, size }, blob) => {
  const actual = blob.size === size ? await checksumOf(blob) : '';
  if (actual !== checksum) throw new Error('File does not match its checksum');
  await writeFile(checksum, blob);
};

const onFileStored = (listener) => {
  const channel = new BroadcastChannel(STORED_CHANNEL);
  channel.addEventListener('message', ({ data }) => listener(data));
  return channel;
};

const storeFile = async (file) => {
  const checksum = await checksumOf(file);
  await writeFile(checksum, file);
  const name = file.name || DEFAULT_NAME;
  const mime = file.type || DEFAULT_MIME;
  const dimensions = await imageSize(file);
  return { name, mime, size: file.size, checksum, ...dimensions };
};

const localFiles = async (files) => {
  const local = [];
  for (const file of files) {
    if (await readFile(file)) local.push(file);
  }
  return local;
};

const writeBlob = async (stream, blob) => {
  for await (const chunk of blob.stream()) {
    if (!stream.write(chunk)) await stream.toPromise('drain');
  }
  stream.end();
};

const sendBlob = async (client, blob, call) => {
  const uploader = client.createBlobUploader(blob);
  const results = await Promise.all([call(uploader.id), uploader.upload()]);
  return results[0];
};

const readBlob = async (client, call) => {
  const readable = client.createReadable();
  const reading = readable.toBlob();
  try {
    await call(readable.id);
  } catch (error) {
    await readable.terminate();
    throw error;
  }
  return reading;
};

const clearFiles = async () => {
  const names = await fsi.list(DIRECTORY);
  await Promise.all(names.map((name) => fsi.remove(DIRECTORY, name)));
};

class SerialTask {
  #task = null;
  #onError = null;
  #isRunning = false;
  #isPending = false;

  constructor(task, onError) {
    this.#task = task;
    this.#onError = onError;
  }

  schedule() {
    this.#isPending = true;
    if (!this.#isRunning) this.#run();
  }

  async #run() {
    this.#isRunning = true;
    while (this.#isPending) {
      this.#isPending = false;
      await this.#task().catch(this.#onError);
    }
    this.#isRunning = false;
  }
}

export { isImage, checksumOf, storeFile, readFile, saveFile, onFileStored };
export { localFiles, clearFiles, writeBlob, sendBlob, readBlob, SerialTask };
