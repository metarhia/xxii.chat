import { SETTINGS_KEY, read, write, validate } from './app-settings.js';

const LIGHT_QUERY = '(prefers-color-scheme: light)';
const COLORS = { dark: '#090a0c', light: '#f6f7f8' };

const queryOf = (win) => win.matchMedia?.(LIGHT_QUERY) ?? null;

const resolveTheme = (theme, query) => {
  if (theme !== 'system') return theme;
  return query?.matches ? 'light' : 'dark';
};

const paintMeta = (doc, theme) => {
  const scheme = doc.querySelector('meta[name="color-scheme"]');
  const color = doc.querySelector('meta[name="theme-color"]');
  if (scheme) scheme.content = theme;
  if (color) color.content = COLORS[theme];
};

class Appearance {
  constructor(win = window) {
    this.win = win;
    this.query = queryOf(win);
    this.settings = read(win.localStorage);
    this.listeners = new Set();
    this.apply();
    this.query?.addEventListener('change', () => this.apply());
    win.addEventListener('storage', (event) => this.onStorage(event));
  }

  get theme() {
    return resolveTheme(this.settings.theme, this.query);
  }

  apply() {
    const doc = this.win.document;
    const root = doc.documentElement;
    root.dataset.theme = this.theme;
    root.dataset.text = this.settings.textSize;
    root.dataset.density = this.settings.density;
    paintMeta(doc, this.theme);
    for (const listener of this.listeners) listener(this.settings);
  }

  onStorage({ key }) {
    if (key !== SETTINGS_KEY && key !== null) return;
    this.settings = read(this.win.localStorage);
    this.apply();
  }

  watch(listener) {
    this.listeners.add(listener);
  }

  set(name, value) {
    const saved = read(this.win.localStorage);
    this.settings = validate({ ...saved, [name]: value });
    const isSaved = write(this.win.localStorage, this.settings);
    this.apply();
    return isSaved;
  }
}

export { Appearance, resolveTheme };
