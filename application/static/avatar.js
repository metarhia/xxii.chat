import { isAvatar } from './chat.js';

const hueOf = (id) => {
  let hash = 0;
  for (const char of id) hash = (hash * 33 + char.charCodeAt(0)) % 360;
  return hash;
};

const peerOf = (endpoint) => {
  const index = endpoint.indexOf(':');
  if (index <= 0) return endpoint;
  return endpoint.slice(0, index);
};

const colorOf = (endpoint) => {
  const peer = endpoint ? peerOf(endpoint) : 'guest';
  return `hsl(${hueOf(peer)} 42% 32%)`;
};

const initialsOf = (name) => {
  const text = typeof name === 'string' ? name.trim() : '';
  if (text === '') return '?';
  const parts = text.split(/\s+/);
  const first = parts[0];
  const second = parts[1];
  if (!second) return first.slice(0, 2).toUpperCase();
  return `${first[0]}${second[0]}`.toUpperCase();
};

const AVATAR_KEY = 'xxii:avatar';
const SIDE = 128;
const MAX_IMPORT = 10 * 1024 * 1024;
const JPEG = 'image/jpeg';
const PHOTO_TYPES = [
  JPEG,
  'image/png',
  'image/webp',
  'image/gif',
  'image/avif',
];

const avatarOf = async (file) => {
  if (!PHOTO_TYPES.includes(file.type) || file.size > MAX_IMPORT) {
    throw new Error('Choose a JPEG, PNG, WebP, GIF, or AVIF up to 10 MB.');
  }
  const image = await globalThis.createImageBitmap(file).catch(() => null);
  if (!image) throw new Error('This image could not be opened.');
  try {
    const canvas = document.createElement('canvas');
    canvas.width = SIDE;
    canvas.height = SIDE;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('This browser could not prepare the photo.');
    const { width, height } = image;
    const side = Math.min(width, height);
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, SIDE, SIDE);
    const x = (width - side) / 2;
    const y = (height - side) / 2;
    ctx.drawImage(image, x, y, side, side, 0, 0, SIDE, SIDE);
    const avatar = canvas.toDataURL(JPEG, 0.82);
    if (!isAvatar(avatar)) throw new Error('This photo could not be saved.');
    return avatar;
  } finally {
    image.close();
  }
};

const showPhoto = (element, avatar) => {
  if (!avatar || !isAvatar(avatar)) return false;
  if (element.firstElementChild?.getAttribute('src') === avatar) return true;
  const image = element.ownerDocument.createElement('img');
  image.alt = '';
  image.src = avatar;
  element.replaceChildren(image);
  return true;
};

export { peerOf, colorOf, initialsOf };
export { AVATAR_KEY, avatarOf, showPhoto };
