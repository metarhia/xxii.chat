'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const STATIC = path.join(__dirname, '..', 'application', 'static');
const settings = import('../application/static/app-settings.js');
const appearance = import('../application/static/appearance.js');

const readStatic = (name) => fs.readFileSync(path.join(STATIC, name), 'utf8');

const createStorage = (entries = {}) => {
  const map = new Map(Object.entries(entries));
  return {
    map,
    getItem: (key) => map.get(key) ?? null,
    setItem: (key, value) => map.set(key, value),
  };
};

const runTheme = ({ saved, light = false, broken = false }) => {
  const metas = {
    'color-scheme': { content: 'dark' },
    'theme-color': { content: '#090a0c' },
  };
  const root = { dataset: {} };
  const storage = createStorage();
  if (saved !== undefined) storage.map.set('xxii:settings', saved);
  const document = {
    documentElement: root,
    querySelector: (selector) => metas[selector.match(/"(.+)"/)[1]],
  };
  const context = {
    document,
    localStorage: broken
      ? {
          getItem: () => {
            throw new Error('blocked');
          },
        }
      : storage,
    matchMedia: () => ({ matches: light }),
  };
  vm.runInNewContext(readStatic('theme.js'), context);
  return { dataset: { ...root.dataset }, metas };
};

test('validate keeps known values and replaces unknown ones', async () => {
  const { validate, DEFAULTS } = await settings;
  assert.deepEqual(validate(null), DEFAULTS);
  assert.deepEqual(validate('text'), DEFAULTS);
  const given = {
    theme: 'light',
    textSize: 'xl',
    density: 'compact',
    ring: false,
    ringVolume: 80,
    notifyCalls: false,
    notifyDirect: true,
    notifyReplies: true,
    notifyText: false,
    callToasts: false,
  };
  assert.deepEqual(validate(given), given);
  const unknown = {
    theme: 'sepia',
    textSize: 'xxl',
    density: 'tight',
    ring: 'yes',
    ringVolume: 'loud',
    notifyCalls: 0,
    callToasts: null,
  };
  assert.deepEqual(validate(unknown), DEFAULTS);
});

test('defaults follow the documented table', async () => {
  const { DEFAULTS } = await settings;
  assert.deepEqual(DEFAULTS, {
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
  });
});

test('ringVolume is an integer clamped to 0..100', async () => {
  const { validate } = await settings;
  const volume = (ringVolume) => validate({ ringVolume }).ringVolume;
  assert.equal(volume(-5), 0);
  assert.equal(volume(250), 100);
  assert.equal(volume(33.6), 34);
  assert.equal(volume(0), 0);
  assert.equal(volume(100), 100);
  assert.equal(volume(NaN), 50);
  assert.equal(volume(Infinity), 50);
  assert.equal(volume('70'), 50);
});

test('broken or missing storage returns defaults', async () => {
  const { read, write, DEFAULTS } = await settings;
  assert.deepEqual(read(null), DEFAULTS);
  assert.deepEqual(read(createStorage()), DEFAULTS);
  const broken = createStorage({ 'xxii:settings': '{not json' });
  assert.deepEqual(read(broken), DEFAULTS);
  const array = createStorage({ 'xxii:settings': '[1,2]' });
  assert.deepEqual(read(array), DEFAULTS);
  const throwing = {
    getItem: () => {
      throw new Error('blocked');
    },
    setItem: () => {
      throw new Error('blocked');
    },
  };
  assert.deepEqual(read(throwing), DEFAULTS);
  assert.equal(write(throwing, DEFAULTS), false);
  assert.equal(write(null, DEFAULTS), false);
});

test('write stores only validated values', async () => {
  const { read, write, DEFAULTS } = await settings;
  const storage = createStorage();
  const input = { ...DEFAULTS, theme: 'light', ringVolume: 900, extra: 1 };
  assert.equal(write(storage, input), true);
  const saved = JSON.parse(storage.map.get('xxii:settings'));
  assert.equal(saved.extra, undefined);
  assert.equal(saved.ringVolume, 100);
  assert.deepEqual(read(storage), {
    ...DEFAULTS,
    theme: 'light',
    ringVolume: 100,
  });
});

test('theme.js falls back to the defaults of app-settings.js', async () => {
  const { DEFAULTS } = await settings;
  const expected = {
    theme: DEFAULTS.theme,
    text: DEFAULTS.textSize,
    density: DEFAULTS.density,
  };
  assert.deepEqual(runTheme({}).dataset, expected);
  assert.deepEqual(runTheme({ saved: '{not json' }).dataset, expected);
  assert.deepEqual(runTheme({ saved: '"text"' }).dataset, expected);
  assert.deepEqual(runTheme({ broken: true }).dataset, expected);
  const unknown = JSON.stringify({ theme: 'sepia', textSize: 1 });
  assert.deepEqual(runTheme({ saved: unknown }).dataset, expected);
});

test('theme.js accepts every option of app-settings.js', async () => {
  const { OPTIONS } = await settings;
  for (const theme of ['dark', 'light']) {
    const saved = JSON.stringify({ theme });
    assert.equal(runTheme({ saved }).dataset.theme, theme);
  }
  for (const textSize of OPTIONS.textSize) {
    const saved = JSON.stringify({ textSize });
    assert.equal(runTheme({ saved }).dataset.text, textSize);
  }
  for (const density of OPTIONS.density) {
    const saved = JSON.stringify({ density });
    assert.equal(runTheme({ saved }).dataset.density, density);
  }
});

test('theme.js resolves system and paints the meta tags', () => {
  const saved = JSON.stringify({ theme: 'system' });
  const dark = runTheme({ saved, light: false });
  assert.equal(dark.dataset.theme, 'dark');
  assert.equal(dark.metas['color-scheme'].content, 'dark');
  const light = runTheme({ saved, light: true });
  assert.equal(light.dataset.theme, 'light');
  assert.equal(light.metas['color-scheme'].content, 'light');
  assert.equal(light.metas['theme-color'].content, '#eef1f4');
});

test('resolveTheme follows the media query only for system', async () => {
  const { resolveTheme } = await appearance;
  assert.equal(resolveTheme('system', { matches: true }), 'light');
  assert.equal(resolveTheme('system', { matches: false }), 'dark');
  assert.equal(resolveTheme('system', null), 'dark');
  assert.equal(resolveTheme('dark', { matches: true }), 'dark');
  assert.equal(resolveTheme('light', { matches: false }), 'light');
});

const BASES = ['--bg', '--surface', '--panel'];
const FOREGROUNDS = {
  dark: [
    ['--text', 4.5],
    ['--muted', 4.5],
    ['--light', 4.5],
    ['--link', 4.5],
    ['--placeholder', 3],
  ],
  light: [
    ['--text', 7],
    ['--muted', 7],
    ['--light', 7],
    ['--link', 4.5],
    ['--placeholder', 4.5],
  ],
};
const BARS = ['--bar-left', '--bar-center', '--bar-right'];
const NEIGHBORS = [
  ['--bg', '--surface'],
  ['--bg', '--panel'],
  ['--surface', '--panel'],
  ['--panel', '--raised'],
  ['--bg', '--raised'],
  ['--panel', '--field'],
  ['--bg', '--field'],
  ['--bar-left', '--bar-center'],
  ['--bar-center', '--bar-right'],
  ['--bar-left', '--panel'],
  ['--bar-right', '--panel'],
  ['--bar-center', '--bg'],
];
const OVERLAYS = ['--button', '--button-hover', '--active-bg'];
const SEPARATION = 1.08;
const blockOf = (css, selector) => {
  const start = css.indexOf(`${selector} {`);
  assert.notEqual(start, -1, selector);
  return css.slice(start, css.indexOf('}', start));
};

const tokensOf = (block) => {
  const tokens = {};
  for (const match of block.matchAll(/(--[\w-]+):\s*([^;]+);/g)) {
    tokens[match[1]] = match[2].trim();
  }
  return tokens;
};

const channelOf = (value) => {
  const unit = value / 255;
  return unit <= 0.03928 ? unit / 12.92 : ((unit + 0.055) / 1.055) ** 2.4;
};

const luminanceOf = (hex) => {
  const [red, green, blue] = [1, 3, 5].map((index) =>
    parseInt(hex.slice(index, index + 2), 16),
  );
  return (
    0.2126 * channelOf(red) +
    0.7152 * channelOf(green) +
    0.0722 * channelOf(blue)
  );
};

const hexOf = (rgb) => {
  const parts = rgb.map((value) => Math.round(value).toString(16));
  return `#${parts.map((part) => part.padStart(2, '0')).join('')}`;
};

const overlayOn = (overlay, base) => {
  const match = overlay.match(/rgba\(([^)]+)\)/);
  assert.ok(match, overlay);
  const [red, green, blue, alpha] = match[1].split(',').map(Number);
  const under = [1, 3, 5].map((index) =>
    parseInt(base.slice(index, index + 2), 16),
  );
  const over = [red, green, blue];
  return hexOf(
    over.map((value, index) => value * alpha + under[index] * (1 - alpha)),
  );
};

const contrastOf = (first, second) => {
  const lights = [luminanceOf(first), luminanceOf(second)];
  const [high, low] = [Math.max(...lights), Math.min(...lights)];
  return (high + 0.05) / (low + 0.05);
};

const css = readStatic('default.css');
const themeRoot = (theme) => `:root[data-theme='${theme}']`;
const LIGHT = themeRoot('light');
const themes = { dark: tokensOf(blockOf(css, ':root')) };
themes.light = { ...themes.dark, ...tokensOf(blockOf(css, LIGHT)) };

const LIGHT_TOKENS = [
  '--bg',
  '--surface',
  '--panel',
  '--raised',
  '--field',
  '--button',
  '--button-hover',
  '--mine',
  '--text',
  '--muted',
  '--light',
  '--placeholder',
  '--link',
  '--active',
  '--active-bg',
  '--unread-bg',
  '--online',
  '--away',
  '--offline',
  '--shadow',
];

test('the light theme defines the full token set', () => {
  const own = tokensOf(blockOf(css, LIGHT));
  for (const name of LIGHT_TOKENS) assert.ok(own[name], name);
  assert.match(blockOf(css, LIGHT), /color-scheme: light/);
  assert.match(blockOf(css, ':root'), /color-scheme: dark/);
});

const failuresOf = (theme) => {
  const failures = [];
  for (const base of BASES) {
    for (const [name, minimum] of FOREGROUNDS[theme]) {
      const ratio = contrastOf(themes[theme][name], themes[theme][base]);
      const label = `${theme} ${name} on ${base}`;
      if (ratio < minimum) {
        failures.push(`${label}: ${ratio.toFixed(2)}`);
      }
    }
  }
  return failures;
};

for (const theme of ['dark', 'light']) {
  test(`text colors reach their contrast in the ${theme} theme`, () => {
    assert.deepEqual(failuresOf(theme), []);
  });
}

test('light bars keep their text readable', () => {
  const failures = [];
  for (const base of BARS) {
    for (const [name] of FOREGROUNDS.light) {
      const ratio = contrastOf(themes.light[name], themes.light[base]);
      if (ratio < 4.5) failures.push(`${name} on ${base}: ${ratio}`);
    }
  }
  assert.deepEqual(failures, []);
});

test('neighboring light surfaces are told apart without borders', () => {
  const tokens = themes.light;
  const failures = [];
  for (const [first, second] of NEIGHBORS) {
    const ratio = contrastOf(tokens[first], tokens[second]);
    if (ratio < SEPARATION) failures.push(`${first} ${second}: ${ratio}`);
  }
  for (const base of [...BASES, ...BARS]) {
    for (const name of OVERLAYS) {
      const mixed = overlayOn(tokens[name], tokens[base]);
      const ratio = contrastOf(mixed, tokens[base]);
      if (ratio < SEPARATION) failures.push(`${name} on ${base}: ${ratio}`);
    }
  }
  assert.deepEqual(failures, []);
});

test('index.html loads theme.js before the stylesheets', () => {
  const html = readStatic('index.html');
  const script = html.indexOf('<script src="/theme.js"></script>');
  const sheet = html.indexOf('rel="stylesheet"');
  assert.ok(script > 0 && script < sheet);
});

test('the service worker caches the appearance files', () => {
  const worker = readStatic('worker.js');
  const files = ['theme', 'app-settings', 'appearance', 'settings-appearance'];
  for (const name of files) assert.ok(worker.includes(`'/${name}.js'`), name);
});
