import { SETTINGS_KEY } from './app-settings.js';
import { SETTINGS_KEY as CALL_KEY } from './call-settings.js';
import { LEGACY_AUTO_LOWER_KEY } from './call-settings.js';
import { DEVICES_KEY } from './media.js';
import { ICE_KEY } from './ice.js';
import { VOLUME_KEY } from './call-volume.js';

const NAMES = [
  SETTINGS_KEY,
  CALL_KEY,
  LEGACY_AUTO_LOWER_KEY,
  DEVICES_KEY,
  ICE_KEY,
];

const isResettable = (key) => NAMES.includes(key) || key.startsWith(VOLUME_KEY);

const keysOf = (storage) => {
  const keys = [];
  for (let index = 0; index < storage.length; index++) {
    keys.push(storage.key(index));
  }
  return keys;
};

const resetSettings = (storage) => {
  const keys = keysOf(storage).filter(isResettable);
  for (const key of keys) storage.removeItem(key);
  return keys;
};

export { isResettable, resetSettings };
