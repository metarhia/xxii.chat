const MARGIN = 8;
const OVERLAP = 2;
const SWIPE_PX = 50;
const SWITCHER_LIMIT = 12;

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

class Toolbar {
  #element = null;
  #thread = null;
  #pin = null;
  target = null;

  constructor(element, reactions) {
    this.#element = element;
    element.querySelector('.quick-reactions').append(...reactions);
    this.#thread = element.querySelector('[data-action="thread"]');
    this.#pin = element.querySelector('[data-action="pin"]');
  }

  contains(node) {
    return this.#element.contains(node);
  }

  show(target, state) {
    this.target = target;
    this.update(state);
    this.#element.classList.remove('hidden');
    this.place();
  }

  update({ mine, thread, pinned }) {
    markMine(this.#element.querySelectorAll('[data-reaction]'), mine);
    this.#thread.textContent = thread;
    this.#thread.classList.toggle('hidden', thread === '');
    this.#pin.textContent = pinned ? 'unpin' : 'pin';
  }

  place() {
    const { item, x, area } = this.target;
    const rect = item.getBoundingClientRect();
    const bounds = area.getBoundingClientRect();
    const width = this.#element.offsetWidth;
    const height = this.#element.offsetHeight;
    const above = rect.top - height + OVERLAP;
    const below = rect.bottom - OVERLAP;
    const isAboveFree = above >= bounds.top;
    const top = isAboveFree ? above : below;
    const right = Math.min(rect.right, window.innerWidth - MARGIN) - width;
    const inside = clamp(x - width / 2, rect.left, right);
    const left = clamp(inside, MARGIN, window.innerWidth - width - MARGIN);
    this.#element.style.left = `${Math.round(left)}px`;
    this.#element.style.top = `${Math.round(top)}px`;
  }

  hide() {
    this.target = null;
    this.#element.classList.add('hidden');
  }
}

class Menu {
  #element = null;
  #createReactions = null;
  target = '';
  isSheet = false;

  constructor(element, createReactions) {
    this.#element = element;
    this.#createReactions = createReactions;
  }

  get isOpen() {
    return this.target !== '';
  }

  open({ id, x, y, isSheet, mine, items }) {
    this.target = id;
    this.isSheet = isSheet;
    const row = document.createElement('div');
    row.className = 'menu-reactions';
    row.append(...this.#createReactions());
    markMine(row.children, mine);
    const entries = items.map((entry) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'menu-item';
      button.textContent = entry.label;
      button.dataset.action = entry.action;
      if (entry.file) button.dataset.file = entry.file;
      return button;
    });
    this.#element.replaceChildren(row, ...entries);
    this.#element.classList.toggle('sheet', isSheet);
    this.#element.classList.remove('hidden');
    if (isSheet) {
      this.#element.style.removeProperty('left');
      this.#element.style.removeProperty('top');
      return;
    }
    const width = this.#element.offsetWidth;
    const height = this.#element.offsetHeight;
    const left = clamp(x, MARGIN, window.innerWidth - width - MARGIN);
    const fits = y + height + MARGIN <= window.innerHeight;
    const top = fits ? y : Math.max(MARGIN, y - height);
    this.#element.style.left = `${Math.round(left)}px`;
    this.#element.style.top = `${Math.round(top)}px`;
  }

  close() {
    this.target = '';
    this.#element.classList.add('hidden');
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

  constructor(element, onSelect) {
    this.#element = element;
    this.#input = element.querySelector('input');
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

  open(entries) {
    this.#entries = entries;
    this.#input.value = '';
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

export { Toolbar, Menu, Lightbox, Switcher };
