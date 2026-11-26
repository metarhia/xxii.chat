import { readJson } from './view.js';

const SETTINGS_KEY = 'xxii:settings';
const VOLUME_MAX = 100;

const DEFAULTS = {
  theme: 'dark',
  textSize: 'm',
  density: 'comfortable',
  ring: true,
  ringVolume: 50,
  notifyCalls: true,
  notifyDirect: false,
  notifyReplies: false,
  notifyText: true,
  callToasts: true,
};

const OPTIONS = {
  theme: ['system', 'dark', 'light'],
  textSize: ['s', 'm', 'l', 'xl'],
  density: ['comfortable', 'compact'],
};

const flagOf = (value, fallback) =>
  typeof value === 'boolean' ? value : fallback;

const volumeOf = (value, fallback) => {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.min(VOLUME_MAX, Math.max(0, Math.round(value)));
};

const ringGainOf = (volume) => volumeOf(volume, DEFAULTS.ringVolume) / 1000;

const validate = (input) => {
  const source = input && typeof input === 'object' ? input : {};
  const settings = { ...DEFAULTS };
  for (const name in DEFAULTS) {
    const fallback = DEFAULTS[name];
    if (typeof fallback === 'boolean') {
      settings[name] = flagOf(source[name], fallback);
    } else if (name === 'ringVolume') {
      settings.ringVolume = volumeOf(source.ringVolume, fallback);
    } else if (OPTIONS[name].includes(source[name])) {
      settings[name] = source[name];
    }
  }
  return settings;
};

const write = (storage, settings) => {
  if (!storage) return false;
  try {
    storage.setItem(SETTINGS_KEY, JSON.stringify(validate(settings)));
    return true;
  } catch {
    return false;
  }
};

const read = (storage) => {
  if (!storage) return { ...DEFAULTS };
  try {
    return validate(readJson(storage, SETTINGS_KEY));
  } catch {
    return { ...DEFAULTS };
  }
};

export { SETTINGS_KEY, DEFAULTS, OPTIONS };
export { validate, read, write, ringGainOf };
