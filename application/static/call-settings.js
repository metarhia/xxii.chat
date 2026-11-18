const SETTINGS_KEY = 'xxii:call-settings';
const LEGACY_AUTO_LOWER_KEY = 'xxii:call-auto-lower';
const NOISE_LEVELS = ['standard', 'strong'];
const TOAST_LIMIT = 8;
const TOAST_MERGE_MS = 3000;
const TOAST_SHOW_MS = 4000;

const DEFAULTS = {
  joinMicOff: false,
  joinCameraOff: false,
  mirror: true,
  noise: 'standard',
  pushToTalk: true,
  autoLower: true,
  recordingLayout: 'speakers',
  recordingAudio: 'all',
  recordingQuality: '1080p30',
};

const OPTIONS = {
  noise: NOISE_LEVELS,
  recordingLayout: ['speaker', 'speakers', 'grid', 'pinned'],
  recordingAudio: ['all', 'onScreen', 'duck', 'custom'],
  recordingQuality: ['720p30', '1080p30', '1080p60'],
};

const flagOf = (value, fallback) =>
  typeof value === 'boolean' ? value : fallback;

const validateSettings = (input) => {
  const source = input && typeof input === 'object' ? input : {};
  const settings = { ...DEFAULTS };
  for (const [name, fallback] of Object.entries(DEFAULTS)) {
    if (typeof fallback === 'boolean') {
      settings[name] = flagOf(source[name], fallback);
    } else if (OPTIONS[name].includes(source[name])) {
      settings[name] = source[name];
    }
  }
  return settings;
};

const parse = (text) => {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
};

const writeSettings = (storage, settings) => {
  if (!storage) return false;
  try {
    const clean = validateSettings(settings);
    storage.setItem(SETTINGS_KEY, JSON.stringify(clean));
    return true;
  } catch {
    return false;
  }
};

const readSettings = (storage) => {
  if (!storage) return { ...DEFAULTS };
  try {
    const text = storage.getItem(SETTINGS_KEY);
    const saved = parse(text);
    if (saved && typeof saved === 'object') return validateSettings(saved);
    const legacy = storage.getItem(LEGACY_AUTO_LOWER_KEY);
    const settings = { ...DEFAULTS };
    if (legacy === 'off' || legacy === 'on') {
      settings.autoLower = legacy === 'on';
      writeSettings(storage, settings);
    }
    return settings;
  } catch {
    return { ...DEFAULTS };
  }
};

const nameOf = (nick) => (typeof nick === 'string' && nick ? nick : 'guest');

const listText = (names) => {
  if (names.length === 1) return names[0];
  if (names.length === 2) return `${names[0]} and ${names[1]}`;
  const rest = names.length - 1;
  return `${names[0]} and ${rest} others`;
};

const createToast = () => ({ joined: [], left: [], at: -Infinity });

const addToast = (toast, event, now) => {
  const fresh = now - toast.at >= TOAST_MERGE_MS;
  const base = fresh ? createToast() : toast;
  const name = nameOf(event.nick);
  const joined = base.joined.slice();
  const left = base.left.slice();
  if (event.kind === 'join') joined.push(name);
  if (event.kind === 'leave') left.push(name);
  return { joined, left, at: now };
};

const toastText = (toast) => {
  const parts = [];
  if (toast.joined.length > 0) parts.push(`${listText(toast.joined)} joined`);
  if (toast.left.length > 0) parts.push(`${listText(toast.left)} left`);
  return parts.join(' · ');
};

const showsToast = (count) => count <= TOAST_LIMIT;

export { SETTINGS_KEY, OPTIONS, DEFAULTS, TOAST_LIMIT, TOAST_SHOW_MS };
export { TOAST_MERGE_MS, validateSettings, readSettings, writeSettings };
export { createToast, addToast, toastText, showsToast };
