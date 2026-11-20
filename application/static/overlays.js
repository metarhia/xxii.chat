import { isReducedMotion } from './view.js';

const MARGIN = 8;
const SWIPE_PX = 50;
const SWITCHER_LIMIT = 12;
const LONG_PRESS_MS = 450;
const CLICK_MS = 400;
const MOVE_PX = 10;
const PULL_PX = 80;
const REPLY_PX = 56;
const EDGE_PX = 24;
const LIFT_MS = 160;

const MENU_KEYS = { ArrowDown: 1, ArrowRight: 1, ArrowUp: -1, ArrowLeft: -1 };

const LIGHTBOX_ACTIONS = {
  prev: (lightbox) => lightbox.step(-1),
  next: (lightbox) => lightbox.step(1),
  close: (lightbox, handlers) => handlers.close(),
  download: (lightbox, handlers) => handlers.download(lightbox.file),
};

const clamp = (value, min, max) => Math.max(min, Math.min(value, max));

const byRelevance = (a, b) =>
  a.rank - b.rank || b.unread - a.unread || b.time - a.time;

const markMine = (buttons, mine) => {
  for (const button of buttons) {
    button.classList.toggle('mine', mine.has(button.dataset.reaction));
  }
};

const createMenuItem = ({ action, label, file, glyph }) => {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'menu-item';
  button.textContent = label;
  if (glyph) button.prepend(glyph);
  button.dataset.action = action;
  if (file) button.dataset.file = file;
  return button;
};

const liftOf = (item) => {
  const lift = item.cloneNode(true);
  lift.removeAttribute('data-id');
  lift.removeAttribute('tabindex');
  lift.removeAttribute('style');
  lift.classList.remove('swiping', 'swipe-ready', 'targeted');
  lift.classList.add('lift');
  lift.inert = true;
  return lift;
};

class Press {
  #press = null;
  #handlers = null;
  #isHeld = false;
  #releasedAt = -Infinity;

  constructor(handlers) {
    this.#handlers = handlers;
  }

  start(event, item, canSwipe) {
    if (event.pointerType !== 'touch') return;
    const { clientX: x, clientY: y } = event;
    const timer = setTimeout(() => this.#hold(), LONG_PRESS_MS);
    const offset = 0;
    const isSwiping = false;
    const isInside = x >= EDGE_PX;
    const isSwipe = canSwipe && isInside;
    this.#press = { timer, x, y, item, canSwipe: isSwipe, offset, isSwiping };
  }

  move(event) {
    const press = this.#press;
    if (!press) return;
    const dx = event.clientX - press.x;
    const dy = event.clientY - press.y;
    if (press.isSwiping) return void this.#pull(dx);
    if (Math.hypot(dx, dy) <= MOVE_PX) return;
    const isSideways = dx > 0 && Math.abs(dx) > Math.abs(dy);
    if (!press.canSwipe || !isSideways) return void this.cancel();
    clearTimeout(press.timer);
    press.isSwiping = true;
    press.item.classList.add('swiping');
    this.#pull(dx);
  }

  end() {
    if (this.#isHeld) {
      this.#isHeld = false;
      this.#releasedAt = performance.now();
      return;
    }
    const press = this.#press;
    if (!press?.isSwiping) return void this.cancel();
    this.#releasedAt = performance.now();
    const isReply = press.offset >= REPLY_PX;
    this.cancel();
    if (!isReply) return;
    navigator.vibrate?.(10);
    this.#handlers.swipe(press.item);
  }

  cancel() {
    const press = this.#press;
    if (!press) return;
    clearTimeout(press.timer);
    this.#press = null;
    if (!press.isSwiping) return;
    press.item.classList.remove('swiping', 'swipe-ready');
    press.item.style.removeProperty('transform');
  }

  abort() {
    this.#isHeld = false;
    this.cancel();
  }

  suppress(event) {
    const isRecent = performance.now() - this.#releasedAt < CLICK_MS;
    if (!isRecent) return;
    this.#releasedAt = -Infinity;
    event.preventDefault();
    event.stopPropagation();
  }

  #pull(dx) {
    const press = this.#press;
    press.offset = clamp(dx, 0, PULL_PX);
    press.item.style.transform = `translateX(${press.offset}px)`;
    press.item.classList.toggle('swipe-ready', press.offset >= REPLY_PX);
  }

  #hold() {
    const { item, x, y } = this.#press;
    this.#press = null;
    this.#isHeld = true;
    navigator.vibrate?.(15);
    this.#handlers.hold(item, x, y);
  }
}

class Menu {
  #element = null;
  #createReactions = null;
  target = '';
  isLifted = false;

  constructor(element, createReactions) {
    this.#element = element;
    this.#createReactions = createReactions;
    element.addEventListener('keydown', (event) => this.#handleKey(event));
  }

  get isOpen() {
    return this.target !== '';
  }

  open({ id, mine, items, point, item }) {
    this.target = id;
    this.isLifted = item !== null;
    const row = document.createElement('div');
    row.className = 'menu-reactions';
    row.append(...this.#createReactions());
    markMine(row.children, mine);
    const list = document.createElement('div');
    list.className = 'menu-items';
    list.append(...items.map(createMenuItem));
    const parts = item ? [row, liftOf(item), list] : [row, list];
    this.#element.replaceChildren(...parts);
    this.#element.classList.toggle('lifted', this.isLifted);
    this.#element.classList.remove('hidden');
    if (item) this.#lift(item);
    else this.#point(point);
  }

  focus() {
    this.#element.querySelector('.menu-item')?.focus();
  }

  contains(node) {
    return this.#element.contains(node);
  }

  close() {
    this.target = '';
    this.isLifted = false;
    this.#element.classList.add('hidden');
  }

  #point({ x, y }) {
    const element = this.#element;
    element.style.removeProperty('width');
    const width = element.offsetWidth;
    const height = element.offsetHeight;
    const left = clamp(x, MARGIN, window.innerWidth - width - MARGIN);
    const fits = y + height + MARGIN <= window.innerHeight;
    const near = fits ? y : y - height;
    const top = clamp(near, MARGIN, window.innerHeight - height - MARGIN);
    element.style.left = `${Math.round(left)}px`;
    element.style.top = `${Math.round(top)}px`;
  }

  #lift(item) {
    const element = this.#element;
    const rect = item.getBoundingClientRect();
    const width = Math.min(rect.width, window.innerWidth - MARGIN * 2);
    const left = clamp(rect.left, MARGIN, window.innerWidth - width - MARGIN);
    element.style.width = `${Math.round(width)}px`;
    element.style.left = `${Math.round(left)}px`;
    const style = getComputedStyle(element);
    const min = MARGIN + parseFloat(style.scrollPaddingTop);
    const bottom = MARGIN + parseFloat(style.scrollPaddingBottom);
    const max = window.innerHeight - element.offsetHeight - bottom;
    const lift = element.querySelector('.lift');
    const desired = rect.top - lift.offsetTop;
    const top = clamp(desired, min, max);
    element.style.top = `${Math.round(top)}px`;
    if (isReducedMotion()) return;
    const shift = Math.round(desired - top);
    const from = { transform: `translateY(${shift}px)`, opacity: 0.6 };
    const to = { transform: 'none', opacity: 1 };
    element.animate([from, to], { duration: LIFT_MS, easing: 'ease-out' });
  }

  #handleKey(event) {
    const step = MENU_KEYS[event.key];
    if (!step) return;
    event.preventDefault();
    const buttons = Array.from(this.#element.querySelectorAll('button'));
    const index = buttons.indexOf(document.activeElement);
    const count = buttons.length;
    buttons[(index + step + count) % count].focus();
  }
}

class Lightbox {
  #element = null;
  #image = null;
  #name = null;
  #count = null;
  #files = [];
  #index = 0;
  #startX = 0;
  #isSwiped = false;
  #handlers = null;

  constructor(element, handlers) {
    this.#element = element;
    this.#image = element.querySelector('.lightbox-image');
    this.#name = element.querySelector('.lightbox-name');
    this.#count = element.querySelector('.lightbox-count');
    this.#handlers = handlers;
    element.addEventListener('pointerdown', (event) => {
      this.#startX = event.clientX;
    });
    element.addEventListener('pointerup', (event) => {
      const distance = event.clientX - this.#startX;
      const isTouch = event.pointerType !== 'mouse';
      this.#isSwiped = isTouch && Math.abs(distance) > SWIPE_PX;
      if (this.#isSwiped) this.step(distance < 0 ? 1 : -1);
    });
    element.addEventListener('click', (event) => this.#handleClick(event));
  }

  #handleClick(event) {
    if (this.#isSwiped) return void (this.#isSwiped = false);
    if (event.target === this.#image) return;
    const control = event.target.closest('[data-lightbox]');
    const action = LIGHTBOX_ACTIONS[control?.dataset.lightbox];
    if (action) action(this, this.#handlers);
  }

  get isOpen() {
    return this.#files.length > 0;
  }

  get file() {
    return this.#files[this.#index] ?? null;
  }

  open(files, index) {
    this.#files = files;
    this.#index = index;
    this.#element.classList.toggle('single', files.length < 2);
    this.#element.classList.remove('hidden');
    this.#show().catch(() => {});
  }

  step(delta) {
    const count = this.#files.length;
    if (count < 2) return;
    this.#index = (this.#index + delta + count) % count;
    this.#show().catch(() => {});
  }

  async #show() {
    const { file } = this;
    this.#name.textContent = file.name;
    this.#count.textContent = `${this.#index + 1} / ${this.#files.length}`;
    this.#image.removeAttribute('src');
    this.#image.alt = file.name;
    const url = await this.#handlers.load(file);
    if (url && this.file === file) this.#image.src = url;
  }

  close() {
    this.#files = [];
    this.#image.removeAttribute('src');
    this.#element.classList.add('hidden');
  }
}

class Switcher {
  #element = null;
  #input = null;
  #list = null;
  #entries = [];
  #matches = [];
  #index = 0;
  #onSelect = null;
  #placeholder = '';

  constructor(element, onSelect) {
    this.#element = element;
    this.#input = element.querySelector('input');
    this.#placeholder = this.#input.placeholder;
    this.#list = element.querySelector('ul');
    this.#onSelect = onSelect;
    this.#input.addEventListener('input', () => this.#render());
    this.#input.addEventListener('keydown', (event) => this.#handleKey(event));
    this.#list.addEventListener('click', (event) => {
      const item = event.target.closest('[data-index]');
      if (item) this.#select(Number(item.dataset.index));
    });
    this.#list.addEventListener('pointermove', (event) => {
      const item = event.target.closest('[data-index]');
      if (item) this.#highlight(Number(item.dataset.index));
    });
  }

  get isOpen() {
    return !this.#element.classList.contains('hidden');
  }

  open(entries, placeholder = this.#placeholder) {
    this.#entries = entries;
    this.#input.value = '';
    this.#input.placeholder = placeholder;
    this.#element.classList.remove('hidden');
    this.#render();
    this.#input.focus();
  }

  close() {
    this.#element.classList.add('hidden');
    this.#entries = [];
  }

  #handleKey(event) {
    const moves = { ArrowDown: 1, ArrowUp: -1 };
    const move = moves[event.key];
    if (move) {
      event.preventDefault();
      const count = this.#matches.length;
      return void this.#highlight((this.#index + move + count) % count);
    }
    if (event.key !== 'Enter') return;
    event.preventDefault();
    this.#select(this.#index);
  }

  #render() {
    const query = this.#input.value.trim().toLowerCase();
    const matches = [];
    for (const entry of this.#entries) {
      const label = entry.label.toLowerCase();
      if (!label.includes(query)) continue;
      const isPrefix = label.slice(1).startsWith(query);
      const rank = query && !isPrefix ? 1 : 0;
      matches.push({ ...entry, rank });
    }
    this.#matches = matches.toSorted(byRelevance).slice(0, SWITCHER_LIMIT);
    const items = this.#matches.map((entry, index) => {
      const item = document.createElement('li');
      item.dataset.index = index;
      item.setAttribute('role', 'option');
      const icon = document.createElement('span');
      icon.className = 'icon';
      icon.textContent = entry.icon;
      const label = document.createElement('span');
      label.className = 'name';
      label.textContent = entry.label;
      const kind = document.createElement('span');
      kind.className = 'kind';
      kind.textContent = entry.unread > 0 ? `${entry.unread} new` : entry.kind;
      item.append(icon, label, kind);
      return item;
    });
    if (items.length === 0) {
      const empty = document.createElement('li');
      empty.className = 'empty';
      empty.textContent = 'Nothing found';
      items.push(empty);
    }
    this.#list.replaceChildren(...items);
    this.#highlight(0);
  }

  #highlight(index) {
    this.#index = index;
    for (const item of this.#list.children) {
      const isActive = Number(item.dataset.index) === index;
      item.classList.toggle('active', isActive);
      if (isActive) item.scrollIntoView({ block: 'nearest' });
    }
  }

  #select(index) {
    const entry = this.#matches[index];
    if (entry) this.#onSelect(entry);
  }
}

export { Press, Menu, Lightbox, Switcher };
