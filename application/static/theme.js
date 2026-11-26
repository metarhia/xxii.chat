(() => {
  const KEY = 'xxii:settings';
  const defaults = { theme: 'dark', textSize: 'm', density: 'comfortable' };
  const choices = {
    theme: ['system', 'dark', 'light'],
    textSize: ['s', 'm', 'l', 'xl'],
    density: ['comfortable', 'compact'],
  };
  const colors = { dark: '#090a0c', light: '#f6f7f8' };

  const readSaved = () => {
    try {
      const saved = JSON.parse(localStorage.getItem(KEY));
      return saved && typeof saved === 'object' ? saved : {};
    } catch {
      return {};
    }
  };

  const pick = (saved, name) =>
    choices[name].includes(saved[name]) ? saved[name] : defaults[name];

  const isLight = () => {
    try {
      return matchMedia('(prefers-color-scheme: light)').matches;
    } catch {
      return false;
    }
  };

  const resolve = (theme) => {
    if (theme !== 'system') return theme;
    return isLight() ? 'light' : 'dark';
  };

  const paint = (theme) => {
    const scheme = document.querySelector('meta[name="color-scheme"]');
    const color = document.querySelector('meta[name="theme-color"]');
    if (scheme) scheme.content = theme;
    if (color) color.content = colors[theme];
  };

  const saved = readSaved();
  const root = document.documentElement;
  const theme = resolve(pick(saved, 'theme'));
  root.dataset.theme = theme;
  root.dataset.text = pick(saved, 'textSize');
  root.dataset.density = pick(saved, 'density');
  paint(theme);
})();
