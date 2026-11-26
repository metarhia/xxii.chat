const DAY_MS = 24 * 60 * 60 * 1000;
const SIZE_UNITS = ['B', 'KB', 'MB'];
const URL_PATTERN = /\bhttps?:\/\/[^\s<>"']+/g;
const URL_TAIL = /[.,;:!?)\]]+$/;
const DATE_OPTIONS = { weekday: 'long', month: 'long', day: 'numeric' };
const REDUCED_MOTION = '(prefers-reduced-motion: reduce)';
const PHONE = '(max-width: 600px), (pointer: coarse) and (max-width: 900px)';

const pad = (value) => `${value}`.padStart(2, '0');

const timeOf = (timestamp) => {
  const date = new Date(timestamp);
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
};

const dateOf = (timestamp) => {
  const date = new Date(timestamp);
  const day = `${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
  return `${date.getFullYear()}-${day} ${timeOf(timestamp)}`;
};

const dayKey = (timestamp) => new Date(timestamp).toDateString();

const dayOf = (timestamp) => {
  if (!timestamp) return '';
  const date = new Date(timestamp);
  const isToday = dayKey(timestamp) === dayKey(Date.now());
  if (isToday) return timeOf(timestamp);
  return `${pad(date.getDate())}.${pad(date.getMonth() + 1)}`;
};

const dayLabel = (timestamp) => {
  const key = dayKey(timestamp);
  if (key === dayKey(Date.now())) return 'Today';
  if (key === dayKey(Date.now() - DAY_MS)) return 'Yesterday';
  return new Date(timestamp).toLocaleDateString(undefined, DATE_OPTIONS);
};

const plural = (count, one, many) => `${count} ${count === 1 ? one : many}`;

const formatSize = (bytes) => {
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < SIZE_UNITS.length - 1) {
    value /= 1024;
    unit++;
  }
  const digits = unit === 0 ? 0 : 1;
  return `(${value.toFixed(digits)}${SIZE_UNITS[unit]})`;
};

const fitSize = (file, maxWidth, maxHeight) => {
  const { width, height } = file;
  const isSized = width > 0 && height > 0;
  if (!isSized) return { width: maxWidth, height: maxHeight };
  const scale = Math.min(1, maxWidth / width, maxHeight / height);
  return {
    width: Math.round(width * scale),
    height: Math.round(height * scale),
  };
};

const readSetting = (key, fallback) => {
  try {
    return localStorage.getItem(key) ?? fallback;
  } catch {
    return fallback;
  }
};

const writeSetting = (key, value) => {
  try {
    localStorage.setItem(key, value);
    return true;
  } catch {
    return false;
  }
};

const readMap = (key) => {
  try {
    const entries = JSON.parse(readSetting(key, '[]'));
    return new Map(Array.isArray(entries) ? entries : []);
  } catch {
    return new Map();
  }
};

const writeMap = (key, map) => writeSetting(key, JSON.stringify([...map]));

const readJson = (storage, key) => {
  try {
    const text = storage?.getItem(key);
    return text ? JSON.parse(text) : null;
  } catch {
    return null;
  }
};

const writeJson = (storage, key, value) => {
  try {
    storage.setItem(key, JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
};

const cloneTemplate = (template, selector) => {
  const fragment = template.content.cloneNode(true);
  return fragment.querySelector(selector);
};

const optionOf = (value, label) => {
  const option = document.createElement('option');
  option.value = `${value}`;
  option.textContent = label;
  return option;
};

const labeled = (control, label) => {
  const field = document.createElement('label');
  if (control.type === 'checkbox') {
    field.className = 'check';
    field.append(control, label);
    return field;
  }
  field.className = 'call-field';
  const caption = document.createElement('span');
  caption.textContent = label;
  field.append(caption, control);
  return field;
};

const syncChildren = (parent, nodes) => {
  const wanted = new Set(nodes);
  for (const child of [...parent.childNodes]) {
    if (!wanted.has(child)) child.remove();
  }
  let current = parent.firstChild;
  for (const node of nodes) {
    if (node === current) current = current.nextSibling;
    else parent.insertBefore(node, current);
  }
};

const setBadge = (badge, count) => {
  badge.textContent = count;
  badge.classList.toggle('hidden', count === 0);
};

const createLink = (href) => {
  const link = document.createElement('a');
  link.href = href;
  link.target = '_blank';
  link.rel = 'noopener noreferrer';
  link.textContent = href;
  return link;
};

const fillText = (element, text) => {
  const nodes = [];
  let position = 0;
  for (const match of text.matchAll(URL_PATTERN)) {
    const href = match[0].replace(URL_TAIL, '');
    nodes.push(text.slice(position, match.index), createLink(href));
    position = match.index + href.length;
  }
  nodes.push(text.slice(position));
  element.replaceChildren(...nodes);
};

const isEditable = (element) => {
  if (!element) return false;
  const isField = ['INPUT', 'TEXTAREA', 'SELECT'].includes(element.tagName);
  return isField || element.isContentEditable;
};

const isReducedMotion = () => matchMedia(REDUCED_MOTION).matches;

export { timeOf, dateOf, dayKey, dayOf, dayLabel, plural };
export { formatSize, fitSize, readSetting, writeSetting, readMap, writeMap };
export { readJson, writeJson };
export { cloneTemplate, optionOf, labeled };
export { syncChildren, setBadge, fillText };
export { PHONE, isEditable, isReducedMotion };
