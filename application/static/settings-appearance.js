import { OPTIONS } from './app-settings.js';
import { createSegments } from './settings-rows.js';

const SAMPLE_TEXT = 'The quick brown fox jumps over the lazy dog';
const SIZE_LABELS = { s: 'S', m: 'M', l: 'L', xl: 'XL' };
const KEY = 'appearance';

const create = (tag, className, text = '') => {
  const element = document.createElement(tag);
  element.className = className;
  element.textContent = text;
  return element;
};

const createSample = () => {
  const sample = create('div', 'sample');
  sample.setAttribute('aria-hidden', 'true');
  sample.append(
    create('span', 'sample-author', 'alex'),
    create('span', 'sample-text', SAMPLE_TEXT),
  );
  return sample;
};

const createChoice = (caption, note, name, labelOf) =>
  createSegments(caption, note, name, OPTIONS[name], { key: KEY, labelOf });

const createRows = () => ({
  theme: [
    createChoice('Theme', 'System follows the theme of your device', 'theme'),
  ],
  messages: [
    createChoice(
      'Message text size',
      'Messages, posts, articles, and the composer',
      'textSize',
      (value) => SIZE_LABELS[value],
    ),
    createSample(),
    createChoice('Density', 'Space between messages and list items', 'density'),
  ],
});

class AppearancePage {
  constructor(root, appearance) {
    this.page = root.querySelector('[data-page="appearance"]');
    this.appearance = appearance;
    const rows = createRows();
    for (const group in rows) {
      this.page.querySelector(`[data-group="${group}"]`).append(...rows[group]);
    }
    this.page.addEventListener('change', (event) => this.change(event.target));
    this.appearance.watch((settings) => this.paint(settings));
    this.paint(this.appearance.settings);
  }

  change({ dataset, checked, value }) {
    const name = dataset[KEY];
    if (name && checked) this.appearance.set(name, value);
  }

  paint(settings) {
    for (const input of this.page.querySelectorAll('input[data-appearance]')) {
      input.checked = settings[input.dataset.appearance] === input.value;
    }
  }
}

export { AppearancePage };
