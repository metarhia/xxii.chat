import { choose, flagOf, bounded, countOf } from './layout.js';
import { REFERENCE_HEIGHT } from './layout.js';
import { defaultsOf, PROGRAM_FIELDS } from './record-panel.js';
import { isHashObject } from './metautil.js';

const SCENE_TYPES = ['live', 'countdown', 'intermission'];
const TRANSITIONS = ['fade', 'cut'];
const OVERLAYS = ['logo', 'banner', 'ticker', 'lowerThird', 'comment'];
const CORNERS = ['top-left', 'top-right', 'bottom-left', 'bottom-right'];
const FONTS = ['Fira Code', 'system-ui'];
const CHIP_STYLES = ['block', 'bubble', 'bar'];

const SCENE_BACKGROUND = '#090a0c';
const FADE_MS = 300;
const TICKER_SPEED = 96;
const COMMENT_LIMIT = 280;
const COMMENT_LINES = 4;
const BOXES = {
  banner: { fraction: 0.52, height: 62, bottom: 0 },
  lowerThird: { fraction: 0.42, height: 92, bottom: 76 },
  comment: { fraction: 0.42, height: 166, bottom: 0, right: true },
  ticker: { fraction: 1, height: 48, bottom: 0 },
};
const MINUTE_MS = 60000;
const DEFAULT_MUSIC_VOLUME = 25;
const DEFAULT_BRAND = {
  accent: '#10b981',
  text: '#d5d5d5',
  chip: 'rgba(0, 0, 0, 0.6)',
  font: 'Fira Code',
  logo: { asset: '', corner: 'top-right', size: 96 },
  chipStyle: 'block',
};

const textOf = (value) => (typeof value === 'string' ? value.trim() : '');

const assetOf = (value) =>
  typeof value === 'string' && /^[a-f0-9]{64}$/.test(value) ? value : '';

const colorOf = (value, fallback) =>
  typeof value === 'string' && /^#[a-f\d]{6}$/i.test(value) ? value : fallback;

const chipColorOf = (value) => {
  const hex = colorOf(value, '');
  if (hex) return hex;
  if (typeof value !== 'string') return DEFAULT_BRAND.chip;
  const rgba = /^rgba\(\s*(\d+),\s*(\d+),\s*(\d+),\s*(0?\.\d+|[01])\s*\)$/;
  const match = rgba.exec(value);
  if (!match || match.slice(1, 4).some((part) => Number(part) > 255)) {
    return DEFAULT_BRAND.chip;
  }
  return value;
};

const programOf = (value, defaults) => {
  const input = isHashObject(value) ? value : {};
  const program = {};
  for (const { name, kind, values } of PROGRAM_FIELDS) {
    const option = input[name];
    const fallback = defaults[name];
    program[name] =
      kind === 'flag'
        ? flagOf(option, fallback)
        : choose(option, values, fallback);
  }
  const pins = Array.isArray(input.pinned) ? input.pinned : [];
  const endpoints = pins.filter((pin) => pin && textOf(pin) === pin);
  program.pinned = [...new Set(endpoints)];
  const source = isHashObject(input.volumes) ? input.volumes : null;
  const volumes = {};
  if (source) {
    for (const key in source) {
      const gain = source[key];
      if (!key || !Number.isFinite(gain)) continue;
      volumes[key] = bounded(gain, 0, 2, 1);
    }
  }
  program.volumes = volumes;
  return program;
};

const sceneOf = (value, defaults = defaultsOf()) => {
  if (!isHashObject(value)) return null;
  const id = textOf(value.id);
  const name = textOf(value.name);
  const type = choose(value.type, SCENE_TYPES, '');
  if (!id || !name || !type) return null;
  const background = value.background;
  const overlays = Array.isArray(value.overlays) ? value.overlays : [];
  return {
    id,
    name,
    type,
    program: programOf(value.program, defaults),
    background: {
      color: colorOf(background?.color, SCENE_BACKGROUND),
      image: assetOf(background?.image),
    },
    overlays: OVERLAYS.filter((overlay) => overlays.includes(overlay)),
    text: textOf(value.text),
    minutes: countOf(value.minutes, 1, 60, 5),
    music: assetOf(value.music),
  };
};

const builtInScenes = (defaults = defaultsOf()) => {
  const scenes = [
    { id: 'starting-soon', name: 'Starting soon', type: 'countdown' },
    { id: 'live', name: 'Live', type: 'live' },
    { id: 'break', name: 'Be right back', type: 'intermission' },
    { id: 'ending', name: 'Ending', type: 'intermission' },
  ].map((scene) => {
    const isLive = scene.type === 'live';
    return sceneOf(
      {
        ...scene,
        text: isLive ? '' : scene.name,
        overlays: isLive ? OVERLAYS : ['logo'],
      },
      isLive ? defaults : defaultsOf(),
    );
  });
  return { transition: 'fade', active: 'live', scenes };
};

const scenesOf = (value, defaults = defaultsOf()) => {
  const fallback = () => builtInScenes(defaults);
  if (!isHashObject(value) || !Array.isArray(value.scenes)) {
    return fallback();
  }
  const transition = choose(value.transition, TRANSITIONS, '');
  const scenes = value.scenes.map((scene) => sceneOf(scene, defaults));
  const ids = new Set(scenes.map((scene) => scene?.id));
  const hasDuplicate = ids.has(undefined) || ids.size !== scenes.length;
  const activeMissing = scenes.length
    ? !ids.has(value.active)
    : value.active !== '';
  if (!transition || hasDuplicate || activeMissing) return fallback();
  return { transition, active: value.active, scenes };
};

const brandOf = (value) => {
  const input = isHashObject(value) ? value : {};
  const { accent, text, font, chipStyle, logo } = DEFAULT_BRAND;
  return {
    accent: colorOf(input.accent, accent),
    text: colorOf(input.text, text),
    chip: chipColorOf(input.chip),
    font: choose(input.font, FONTS, font),
    logo: {
      asset: assetOf(input.logo?.asset),
      corner: choose(input.logo?.corner, CORNERS, logo.corner),
      size: countOf(input.logo?.size, 48, 192, logo.size),
    },
    chipStyle: choose(input.chipStyle, CHIP_STYLES, chipStyle),
  };
};

const countdownUntil = (minutes, now) => now + minutes * MINUTE_MS;

const countdownText = (until, now) => {
  const total = Math.max(0, Math.ceil((until - now) / 1000));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return [minutes, seconds].map((part) => `${part}`.padStart(2, '0')).join(':');
};

const fadeAlpha = (started, now) => bounded((now - started) / FADE_MS, 0, 1, 1);

const logoRect = (logo, width, height, sourceWidth, sourceHeight) => {
  const scale = height / REFERENCE_HEIGHT;
  const pad = Math.round(24 * scale);
  const size = Math.min(logo.size * scale, width - 2 * pad, height - 2 * pad);
  const ratio = size / Math.max(sourceWidth, sourceHeight);
  const w = sourceWidth * ratio;
  const h = sourceHeight * ratio;
  const x = logo.corner.endsWith('right') ? width - pad - w : pad;
  const y = logo.corner.startsWith('bottom') ? height - pad - h : pad;
  return { x, y, width: w, height: h };
};

const chipStyleOf = (style, height) => {
  if (style === 'bubble') return { radius: height / 2, bar: 0 };
  if (style === 'bar') return { radius: 0, bar: Math.round(height / 5) };
  return { radius: 0, bar: 0 };
};

const brandFont = (family, size, weight = 500) =>
  `${weight} ${size}px ${family === 'Fira Code' ? '"Fira Code"' : 'system-ui'}`;

const textsOf = (value) => {
  const source = isHashObject(value) ? value : {};
  const saved = Array.isArray(source.banners) ? source.banners : [];
  const banners = new Map();
  for (const item of saved) {
    const id = textOf(item?.id);
    const text = textOf(item?.text);
    if (id && text) banners.set(id, { id, text });
  }
  return { banners: [...banners.values()], ticker: textOf(source.ticker) };
};

const overlayOpacity = ({ from, to, started }, now, reduced = false) =>
  reduced ? to : from + (to - from) * fadeAlpha(started, now);

const overlayRect = (kind, width, height, hasTicker = false) => {
  const box = BOXES[kind];
  const scale = height / REFERENCE_HEIGHT;
  const h = box.height * scale;
  if (kind === 'ticker') return { x: 0, y: height - h, width, height: h };
  const pad = 24 * scale;
  const w = Math.max(0, Math.min(width - 2 * pad, width * box.fraction));
  const reserved = hasTicker ? BOXES.ticker.height : 0;
  return {
    x: box.right ? width - pad - w : pad,
    y: height - pad - (box.bottom + reserved) * scale - h,
    width: w,
    height: h,
  };
};

const tickerOffset = (elapsed, width, textWidth) => {
  const span = width + textWidth;
  return width - (((Math.max(0, elapsed) / 1000) * TICKER_SPEED) % span);
};

const shorten = (characters, fits) => {
  while (characters.length && !fits(characters.join('') + '…')) {
    characters.pop();
  }
  return fits('…') ? characters.join('') + '…' : '';
};

const commentText = (value) => {
  const plain = textOf(value).replace(/\r\n?/g, '\n');
  const characters = Array.from(plain);
  if (characters.length <= COMMENT_LIMIT) return plain;
  return characters.slice(0, COMMENT_LIMIT - 1).join('') + '…';
};

const commentLines = (text, measure, width) => {
  const fits = (line) => measure(line) <= width;
  const rows = [];
  for (const paragraph of commentText(text).split('\n')) {
    let line = '';
    for (const word of paragraph.trim().split(/\s+/)) {
      const combined = line ? line + ' ' + word : word;
      if (fits(combined)) {
        line = combined;
        continue;
      }
      if (line) rows.push(line);
      line = '';
      for (const character of word) {
        if (line && !fits(line + character)) {
          rows.push(line);
          line = '';
        }
        if (fits(character)) line += character;
      }
    }
    rows.push(line);
    if (rows.length > COMMENT_LINES) break;
  }
  if (rows.length <= COMMENT_LINES) return rows;
  const visible = rows.slice(0, COMMENT_LINES);
  visible[COMMENT_LINES - 1] = shorten(Array.from(visible.at(-1)), fits);
  return visible;
};

const clipSource = (clip) => {
  if (clip?.mode !== 'tile') return null;
  const { id, name } = clip;
  return { id, kind: 'screen', nick: name, hasVideo: true, stage: true };
};

export { SCENE_TYPES, TRANSITIONS, CORNERS, FONTS, CHIP_STYLES, OVERLAYS };
export { DEFAULT_MUSIC_VOLUME };
export { assetOf, sceneOf, scenesOf, builtInScenes, brandOf };
export { countdownUntil, countdownText, fadeAlpha, logoRect, chipStyleOf };
export { brandFont };
export { textsOf, overlayOpacity, overlayRect, tickerOffset };
export { commentText, commentLines, clipSource };
