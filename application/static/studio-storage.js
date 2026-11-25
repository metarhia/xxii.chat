import { assetOf } from './studio-layout.js';
import { isHashObject } from './metautil.js';

const LOCK = 'xxii:studio';
const DIRECTORY = 'studio';
const ASSETS = 'assets';
const SCENES = 'scenes.json';
const BRAND = 'brand.json';
const MANIFEST = 'assets.json';
const MUSIC = 'music.json';
const TEXTS = 'texts.json';
const MB = 1000 * 1000;
const LIMITS = { image: 10, audio: 50, video: 200 };

const groupOf = (type) => {
  const slash = typeof type === 'string' ? type.indexOf('/') : -1;
  const group = slash > 0 ? type.slice(0, slash) : '';
  return Object.hasOwn(LIMITS, group) ? group : '';
};

const readJSON = async (directory, name) => {
  try {
    const handle = await directory.getFileHandle(name);
    const file = await handle.getFile();
    return JSON.parse(await file.text());
  } catch (error) {
    if (error.name === 'NotFoundError' || error instanceof SyntaxError) {
      return null;
    }
    throw error;
  }
};

const write = async (directory, name, contents) => {
  const handle = await directory.getFileHandle(name, { create: true });
  const stream = await handle.createWritable();
  try {
    await stream.write(contents);
    await stream.close();
  } catch (error) {
    await stream.abort().catch(() => undefined);
    throw error;
  }
};

const writeJSON = (directory, name, value) =>
  write(directory, name, JSON.stringify(value));

const withStudioDirectory = async (work) => {
  const storage = navigator.storage;
  if (!storage?.getDirectory) throw new Error('Studio storage is unavailable');
  const change = async () => {
    const root = await storage.getDirectory();
    const directory = await root.getDirectoryHandle(DIRECTORY, {
      create: true,
    });
    return work(directory);
  };
  return navigator.locks ? navigator.locks.request(LOCK, change) : change();
};

const assetsOf = (value) => {
  const assets = new Map();
  if (!Array.isArray(value)) return assets;
  for (const entry of value) {
    if (!isHashObject(entry)) continue;
    const { checksum, name, type, size } = entry;
    const group = groupOf(type);
    if (!assetOf(checksum) || typeof name !== 'string' || !name || !group) {
      continue;
    }
    if (!Number.isInteger(size) || size <= 0 || size > LIMITS[group] * MB) {
      continue;
    }
    assets.set(checksum, { checksum, name, type, size });
  }
  return assets;
};

const readAssets = async (directory) =>
  assetsOf(await readJSON(directory, MANIFEST));

const saveAssets = (directory, assets) =>
  writeJSON(directory, MANIFEST, [...assets.values()]);

const readAsset = async (directory, asset) => {
  try {
    const files = await directory.getDirectoryHandle(ASSETS);
    const handle = await files.getFileHandle(asset.checksum);
    const file = await handle.getFile();
    return file.size === asset.size
      ? new Blob([file], { type: asset.type })
      : null;
  } catch (error) {
    if (error.name === 'NotFoundError') return null;
    throw error;
  }
};

const addAsset = async (directory, file) => {
  const group = groupOf(file.type);
  if (!group || !file.size) {
    throw new Error('Choose an image, audio or video file');
  }
  const limit = LIMITS[group];
  if (file.size > limit * MB) {
    throw new Error(`File exceeds the ${limit} MB limit`);
  }
  const { checksumOf } = await import('./files.js');
  const checksum = await checksumOf(file);
  const assets = await readAssets(directory);
  const files = await directory.getDirectoryHandle(ASSETS, { create: true });
  const saved = assets.get(checksum);
  const exists = saved ? await readAsset(directory, saved) : null;
  if (!exists) {
    await write(files, checksum, file);
    assets.set(checksum, {
      checksum,
      name: file.name || 'file',
      type: file.type,
      size: file.size,
    });
    await saveAssets(directory, assets);
  }
  return assets;
};

const deleteAsset = async (directory, assets, checksum) => {
  assets.delete(checksum);
  await saveAssets(directory, assets);
  try {
    const files = await directory.getDirectoryHandle(ASSETS);
    await files.removeEntry(checksum);
  } catch (error) {
    if (error.name !== 'NotFoundError') return error;
  }
  return null;
};

export { SCENES, BRAND, MUSIC, TEXTS, groupOf, readJSON, writeJSON };
export { withStudioDirectory, readAssets, addAsset, readAsset, deleteAsset };
