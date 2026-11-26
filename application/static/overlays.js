import { PHONE, isReducedMotion } from './view.js';
import { createIcon } from './icons.js';

const MARGIN = 8;
const GAP = 4;
const MIN_ROOM = 120;
const PULL_CLOSE_PX = 64;
const SWIPE_PX = 50;
const SWITCHER_LIMIT = 12;
const HIDDEN_RANK = 2;
const LONG_PRESS_MS = 450;
const CLICK_MS = 400;
const MOVE_PX = 10;
const PULL_PX = 80;
const REPLY_PX = 56;
const EDGE_PX = 24;
const LIFT_MS = 160;

const ITEM = '.menu-item:not([aria-disabled="true"])';
const FIELDS = '.menu-custom :is(input, button):not(:disabled)';
const FOCUSABLE = `${ITEM}, .menu-reactions button, ${FIELDS}`;
const ROW = '.menu-reactions, .menu-group.menu-row';
const KEY_STEPS = { ArrowDown: 1, ArrowUp: -1 };
const ROW_STEPS = { ArrowRight: 1, ArrowLeft: -1 };
const OPPOSITE = { top: 'bottom', bottom: 'top' };
const RETURNING = ['escape', 'tab', 'select'];
const ITEM_ROLES = {
  action: 'menuitem',
  checkbox: 'menuitemcheckbox',
  radio: 'menuitemradio',
};

const LIGHTBOX_ACTIONS = {
  prev: (lightbox) => lightbox.step(-1),
  next: (lightbox) => lightbox.step(1),
  close: (lightbox, handlers) => handlers.close(),
  download: (lightbox, handlers) => handlers.download(lightbox.file),
};

const inputs = new WeakMap();
let current = null;
let counter = 0;

const clamp = (value, min, max) => Math.max(min, Math.min(value, max));

const byRelevance = (a, b) =>
  a.rank - b.rank || b.unread - a.unread || b.time - a.time;

const markMine = (buttons, mine) => {
  for (const button of buttons) {
    button.classList.toggle('mine', mine.has(button.dataset.reaction));
  }
};

const nextId = () => {
  counter++;
  return `menu-${counter}`;
};

const inputOf = (doc) => {
  const known = inputs.get(doc);
  if (known) return known;
  const input = { isKeyboard: false };
  const track = (isKeyboard) => (event) => {
    if (event.isTrusted) input.isKeyboard = isKeyboard;
  };
  const onClick = (event) => {
    if (event.isTrusted) input.isKeyboard = event.detail === 0;
  };
  doc.addEventListener('keydown', track(true), true);
  doc.addEventListener('pointerdown', track(false), true);
  doc.addEventListener('click', onClick, true);
  inputs.set(doc, input);
  return input;
};

const createNode = (doc, tag, className) => {
  const node = doc.createElement(tag);
  node.className = className;
  return node;
};

const createText = (doc, item, button) => {
  const text = createNode(doc, 'span', 'menu-text');
  const label = createNode(doc, 'span', 'menu-label');
  label.textContent = item.label;
  text.append(label);
  if (!item.disabled) return text;
  button.setAttribute('aria-disabled', 'true');
  if (!item.reason) return text;
  const reason = createNode(doc, 'span', 'menu-reason');
  reason.id = nextId();
  reason.textContent = item.reason;
  button.setAttribute('aria-describedby', reason.id);
  text.append(reason);
  return text;
};

const createMenuItem = (doc, item) => {
  const kind = item.kind ?? 'action';
  const button = createNode(doc, 'button', 'menu-item');
  button.type = 'button';
  button.tabIndex = -1;
  button.setAttribute('role', ITEM_ROLES[kind]);
  if (item.action) button.dataset.action = item.action;
  if (item.file) button.dataset.file = item.file;
  if (kind === 'action' && item.glyph) button.append(item.glyph);
  if (kind !== 'action') {
    const mark = createNode(doc, 'span', 'menu-mark');
    mark.append(createIcon('check', doc));
    button.append(mark);
    button.setAttribute('aria-checked', `${item.checked === true}`);
  }
  button.append(createText(doc, item, button));
  return button;
};

const createGroup = (doc, item) => {
  const group = createNode(doc, 'div', 'menu-group');
  group.setAttribute('role', 'group');
  group.classList.toggle('menu-row', item.row === true);
  const heading = createNode(doc, 'div', 'menu-heading');
  heading.id = nextId();
  heading.textContent = item.label;
  group.setAttribute('aria-labelledby', heading.id);
  group.append(heading);
  return group;
};

const createCustom = (doc, item) => {
  const custom = createNode(doc, 'div', 'menu-custom');
  custom.append(item.element);
  return custom;
};

const createSeparator = (doc) => {
  const separator = createNode(doc, 'div', 'menu-separator');
  separator.setAttribute('role', 'separator');
  return separator;
};

const toggleChecked = (button, entry) => {
  entry.checked = !entry.checked;
  button.setAttribute('aria-checked', `${entry.checked}`);
};

const rowOf = (node) => node?.closest?.(ROW) ?? null;

const columnsOf = (count) => Math.ceil(count / 2);

const lineOf = (nodes, node, columns) => {
  if (!columns) return nodes;
  const start = Math.floor(nodes.indexOf(node) / columns) * columns;
  return nodes.slice(start, start + columns);
};

const gridTarget = (nodes, node, columns, step) => {
  const index = nodes.indexOf(node);
  const line = Math.floor(index / columns) + step;
  const lastLine = Math.floor((nodes.length - 1) / columns);
  if (line < 0 || line > lastLine) return null;
  return nodes[Math.min(line * columns + (index % columns), nodes.length - 1)];
};

const labelOf = (node) => {
  const label = node.querySelector('.menu-label');
  return label ? label.textContent.trim().toLowerCase() : '';
};

const sideOf = (placement, height, above, below) => {
  const room = { top: above, bottom: below };
  const first = placement === 'top' ? 'top' : 'bottom';
  const second = OPPOSITE[first];
  if (height <= room[first]) return first;
  if (height <= room[second]) return second;
  return room[first] >= room[second] ? first : second;
};

const createMark = () => {
  const mark = document.createElement('span');
  mark.className = 'hidden-mark';
  mark.textContent = 'hidden';
  return mark;
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
  #doc = null;
  #win = null;
  #options = null;
  #items = new Map();
  #handlers = null;
  #anchor = null;
  #offsets = null;
  #trigger = null;
  #size = null;
  #previous = null;
  #reason = '';
  #pull = null;
  #lastInRow = new WeakMap();
  #columns = new WeakMap();
  #isOpen = false;
  #isSheet = false;
  #hasLayer = false;
  #onDown = null;
  #onScroll = null;
  #onResize = null;
  #onFocus = null;
  target = '';
  isLifted = false;

  constructor(element, options = {}) {
    this.#element = element;
    this.#doc = element.ownerDocument;
    this.#win = this.#doc.defaultView;
    this.#options = options;
    this.#onDown = (event) => this.#handleDown(event);
    this.#onScroll = (event) => this.#handleScroll(event);
    this.#onResize = () => this.#handleResize();
    this.#onFocus = (event) => this.#handleFocus(event);
    inputOf(this.#doc);
    element.setAttribute('role', 'menu');
    element.tabIndex = -1;
    if (!element.id) element.id = nextId();
    element.addEventListener('keydown', (event) => this.#handleKey(event));
    element.addEventListener('click', (event) => this.#handleClick(event));
    element.addEventListener('focusin', (event) => this.#remember(event));
    element.addEventListener('pointerdown', (event) => this.#startPull(event));
    element.addEventListener('pointermove', (event) => this.#movePull(event));
    element.addEventListener('pointerup', () => this.#endPull());
    element.addEventListener('pointercancel', () => this.#endPull());
  }

  get isOpen() {
    return this.#isOpen;
  }

  get isModal() {
    return this.#isOpen && (this.isLifted || this.#isSheet);
  }

  get hasFocusedItem() {
    const active = this.#doc.activeElement;
    return this.contains(active) && active !== this.#element;
  }

  open(options) {
    if (current && current !== this) current.dismiss('other');
    if (this.#isOpen) this.#teardown(false);
    const element = this.#element;
    const item = options.item ?? null;
    const anchor = options.anchor ?? null;
    const point = options.point ?? null;
    const isSheet = item === null && this.#win.matchMedia(PHONE).matches;
    const isKeyboard = options.keyboard ?? inputOf(this.#doc).isKeyboard;
    const active = this.#doc.activeElement;
    if (!this.contains(active)) this.#previous = active;
    this.#offsets = this.#snapshot(anchor ?? this.#originOf(point));
    this.#anchor = anchor;
    this.#trigger = options.trigger ?? anchor;
    this.#handlers = options;
    this.#isSheet = isSheet;
    this.#isOpen = true;
    this.#size = { width: this.#win.innerWidth, height: this.#win.innerHeight };
    this.target = options.id ?? '';
    this.isLifted = item !== null;
    current = this;
    this.#render(options);
    element.style.cssText = '';
    element.classList.toggle('lifted', this.isLifted);
    element.classList.toggle('sheet', isSheet);
    element.classList.remove('hidden');
    if (options.label) element.setAttribute('aria-label', options.label);
    this.#showBackdrop();
    this.#syncLayer(this.isModal);
    this.#place(options);
    this.#markTrigger('true');
    this.#listen(true);
    if (isKeyboard) this.focus();
    else element.focus({ preventScroll: true });
  }

  focus() {
    const element = this.#element;
    const checked = element.querySelector(
      '[role="menuitemradio"][aria-checked="true"]:not([aria-disabled="true"])',
    );
    const target = checked ?? element.querySelector(ITEM);
    const fallback = target ?? element.querySelector(FOCUSABLE);
    fallback?.focus({ preventScroll: true });
  }

  contains(node) {
    return this.#element.contains(node);
  }

  close() {
    this.#teardown(true);
  }

  dismiss(reason) {
    if (!this.#isOpen) return false;
    this.#reason = reason;
    this.#handlers.close?.(reason);
    this.close();
    this.#reason = '';
    return true;
  }

  #teardown(shouldRelease) {
    if (!this.#isOpen) return;
    this.#returnFocus();
    this.#markTrigger('false');
    this.#hideBackdrop();
    this.#isOpen = false;
    this.#isSheet = false;
    this.#handlers = null;
    this.#anchor = null;
    this.#offsets = null;
    this.#trigger = null;
    this.target = '';
    this.isLifted = false;
    this.#element.classList.add('hidden');
    this.#element.classList.remove('lifted', 'sheet');
    this.#listen(false);
    if (current === this) current = null;
    if (shouldRelease) this.#syncLayer(false);
  }

  #returnFocus() {
    const active = this.#doc.activeElement;
    if (!this.contains(active)) return;
    const isReturning = RETURNING.includes(this.#reason);
    const isMenu = active === this.#element;
    const home = this.#trigger ?? this.#previous;
    const target = isReturning ? home : null;
    const fallback = isMenu ? this.#previous : null;
    const focused = target ?? fallback;
    if (focused?.isConnected) focused.focus({ preventScroll: true });
  }

  #markTrigger(expanded) {
    const trigger = this.#trigger;
    if (!trigger) return;
    const id = this.#element.id;
    trigger.setAttribute('aria-expanded', expanded);
    if (expanded === 'true') trigger.setAttribute('aria-controls', id);
    else trigger.removeAttribute('aria-controls');
  }

  #syncLayer(isNeeded) {
    const layers = this.#options.layers;
    if (!layers || isNeeded === this.#hasLayer) return;
    this.#hasLayer = isNeeded;
    if (isNeeded) layers.push('menu');
    else layers.pop('menu');
  }

  #showBackdrop() {
    const backdrop = this.#options.backdrop;
    if (!backdrop || !this.#isSheet) return;
    backdrop.classList.add('sheet');
    backdrop.classList.remove('hidden');
  }

  #hideBackdrop() {
    const backdrop = this.#options.backdrop;
    if (!backdrop || !this.#isSheet) return;
    backdrop.classList.remove('sheet');
    backdrop.classList.add('hidden');
  }

  #listen(isOn) {
    const method = isOn ? 'addEventListener' : 'removeEventListener';
    this.#doc[method]('pointerdown', this.#onDown, true);
    this.#doc[method]('scroll', this.#onScroll, true);
    this.#doc[method]('focusin', this.#onFocus);
    this.#win[method]('resize', this.#onResize);
  }

  #offsetOf(node) {
    const win = this.#win;
    if (node === this.#doc) return { x: win.scrollX, y: win.scrollY };
    return { x: node.scrollLeft, y: node.scrollTop };
  }

  #snapshot(origin) {
    const offsets = new Map();
    offsets.set(this.#doc, this.#offsetOf(this.#doc));
    for (let node = origin; node; node = node.parentElement) {
      offsets.set(node, this.#offsetOf(node));
    }
    return offsets;
  }

  #originOf(point) {
    if (!point) return null;
    const node = this.#doc.elementFromPoint(point.x, point.y);
    return this.contains(node) ? null : node;
  }

  #render(options) {
    this.#items.clear();
    const doc = this.#doc;
    const parts = [];
    if (this.#isSheet) parts.push(this.#createGrabber());
    if (options.reactions) parts.push(this.#createReactions(options));
    if (options.item) parts.push(liftOf(options.item));
    const list = createNode(doc, 'div', 'menu-items');
    for (const item of options.items) list.append(this.#create(item));
    parts.push(list);
    this.#element.replaceChildren(...parts);
  }

  #create(item) {
    const doc = this.#doc;
    const kind = item.kind ?? 'action';
    if (kind === 'separator') return createSeparator(doc);
    if (kind === 'custom') return createCustom(doc, item);
    if (kind === 'group') {
      const group = createGroup(doc, item);
      for (const child of item.items) group.append(this.#create(child));
      return group;
    }
    const entry = { ...item };
    const button = createMenuItem(doc, entry);
    this.#items.set(button, entry);
    return button;
  }

  #createGrabber() {
    return createNode(this.#doc, 'div', 'menu-grabber');
  }

  #createReactions({ reactions, mine }) {
    const row = createNode(this.#doc, 'div', 'menu-reactions');
    row.setAttribute('role', 'group');
    row.setAttribute('aria-label', 'Reactions');
    const buttons = reactions();
    const columns = columnsOf(buttons.length);
    row.style.setProperty('--columns', `${columns}`);
    this.#columns.set(row, columns);
    for (const button of buttons) {
      button.tabIndex = -1;
      button.setAttribute('role', 'menuitem');
      const { action, reaction } = button.dataset;
      this.#items.set(button, { action, reaction });
    }
    row.append(...buttons);
    markMine(buttons, mine ?? new Set());
    return row;
  }

  #place(options) {
    const item = options.item;
    if (item) return void this.#lift(item);
    if (this.#isSheet) return void this.#slide();
    if (options.anchor) {
      return void this.#anchorTo(options.anchor, options.placement);
    }
    const trigger = options.trigger;
    const fallback = { x: MARGIN, y: MARGIN };
    if (options.point || !trigger) this.#point(options.point ?? fallback);
    else this.#anchorTo(trigger, options.placement);
  }

  #slide() {
    const element = this.#element;
    const isFixed = element.scrollHeight <= element.clientHeight;
    element.style.touchAction = isFixed ? 'none' : 'auto';
    if (isReducedMotion()) return;
    const from = { transform: 'translateY(100%)' };
    const to = { transform: 'none' };
    element.animate([from, to], { duration: LIFT_MS, easing: 'ease-out' });
  }

  #anchorTo(anchor, placement) {
    const element = this.#element;
    const view = this.#win;
    const rect = anchor.getBoundingClientRect();
    const width = element.offsetWidth;
    const height = element.offsetHeight;
    const above = rect.top - GAP - MARGIN;
    const below = view.innerHeight - rect.bottom - GAP - MARGIN;
    const side = sideOf(placement, height, above, below);
    const room = Math.max(side === 'top' ? above : below, MIN_ROOM);
    const shown = Math.min(height, room);
    if (height > room) element.style.maxHeight = `${Math.round(shown)}px`;
    const near = side === 'top' ? rect.top - GAP - shown : rect.bottom + GAP;
    const top = clamp(near, MARGIN, view.innerHeight - shown - MARGIN);
    const left = clamp(rect.left, MARGIN, view.innerWidth - width - MARGIN);
    element.style.left = `${Math.round(left)}px`;
    element.style.top = `${Math.round(top)}px`;
  }

  #point({ x, y }) {
    const element = this.#element;
    const view = this.#win;
    element.style.removeProperty('width');
    const width = element.offsetWidth;
    const height = element.offsetHeight;
    const left = clamp(x, MARGIN, view.innerWidth - width - MARGIN);
    const fits = y + height + MARGIN <= view.innerHeight;
    const near = fits ? y : y - height;
    const top = clamp(near, MARGIN, view.innerHeight - height - MARGIN);
    element.style.left = `${Math.round(left)}px`;
    element.style.top = `${Math.round(top)}px`;
  }

  #lift(item) {
    const element = this.#element;
    const view = this.#win;
    const rect = item.getBoundingClientRect();
    const width = Math.min(rect.width, view.innerWidth - MARGIN * 2);
    const left = clamp(rect.left, MARGIN, view.innerWidth - width - MARGIN);
    element.style.width = `${Math.round(width)}px`;
    element.style.left = `${Math.round(left)}px`;
    const style = view.getComputedStyle(element);
    const min = MARGIN + parseFloat(style.scrollPaddingTop);
    const bottom = MARGIN + parseFloat(style.scrollPaddingBottom);
    const max = view.innerHeight - element.offsetHeight - bottom;
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

  #handleDown(event) {
    const target = event.target;
    const isBackdrop = target === this.#options.backdrop;
    const isOwn = this.contains(target) || this.#trigger?.contains(target);
    if (isBackdrop || isOwn || this.#anchor?.contains(target)) return;
    this.dismiss('pointer');
  }

  #handleScroll(event) {
    if (this.isModal) return;
    const target = event.target;
    const before = this.#offsets.get(target);
    if (!before) return;
    const after = this.#offsetOf(target);
    if (after.x !== before.x || after.y !== before.y) this.dismiss('scroll');
  }

  #handleResize() {
    const size = this.#size;
    const view = this.#win;
    const isWider = view.innerWidth !== size.width;
    const isTaller = view.innerHeight !== size.height;
    if (isWider || (isTaller && !this.isModal)) this.dismiss('resize');
  }

  #handleFocus(event) {
    const target = event.target;
    const isOwn = this.contains(target) || this.#trigger?.contains(target);
    if (this.isLifted || isOwn || this.#anchor?.contains(target)) return;
    this.dismiss('focus');
  }

  #handleClick(event) {
    const button = event.target.closest('button');
    const entry = button ? this.#items.get(button) : null;
    if (!entry) return;
    if (entry.disabled) {
      event.preventDefault();
      return void event.stopImmediatePropagation();
    }
    if (entry.kind === 'checkbox') toggleChecked(button, entry);
    if (entry.kind === 'radio') this.#pick(entry);
    const isStaying = entry.kind === 'checkbox' || entry.keepOpen === true;
    this.#reason = isStaying ? '' : 'select';
    this.#handlers.select?.(entry, button, event);
    if (!isStaying && this.#isOpen) this.close();
    this.#reason = '';
  }

  #pick(entry) {
    for (const node of this.#items.keys()) {
      const other = this.#items.get(node);
      const isSame = other.kind === 'radio' && other.group === entry.group;
      if (!isSame) continue;
      other.checked = other === entry;
      node.setAttribute('aria-checked', `${other.checked}`);
    }
  }

  #handleKey(event) {
    event.stopPropagation();
    const { key, target } = event;
    if (key === 'Tab') return void this.dismiss('tab');
    if (key === 'Escape') {
      event.preventDefault();
      return void this.dismiss('escape');
    }
    if (event.ctrlKey || event.metaKey || event.altKey) return;
    const step = KEY_STEPS[key];
    const rowStep = rowOf(target) ? ROW_STEPS[key] : 0;
    if (step && this.#moveInGrid(target, step)) {
      return void event.preventDefault();
    }
    if (step || rowStep) {
      event.preventDefault();
      return void (step ? this.#move(step) : this.#moveInRow(rowStep));
    }
    if (target.matches('input')) return;
    if (key === 'Home' || key === 'End') {
      event.preventDefault();
      return void this.#jump(key === 'Home' ? 0 : -1);
    }
    if (key === ' ' && target === this.#element) event.preventDefault();
    if (key.length === 1) this.#typeAhead(key);
  }

  #stops() {
    const stops = [];
    for (const node of this.#element.querySelectorAll(FOCUSABLE)) {
      const stop = rowOf(node) ?? node;
      if (!stops.includes(stop)) stops.push(stop);
    }
    return stops;
  }

  #stopTarget(stop) {
    if (!stop.matches(ROW)) return stop;
    const checked = stop.querySelector(
      '[aria-checked="true"]:not([aria-disabled="true"])',
    );
    const last = this.#lastInRow.get(stop);
    return checked ?? last ?? stop.querySelector(FOCUSABLE);
  }

  #move(step) {
    const stops = this.#stops();
    const count = stops.length;
    if (count === 0) return;
    const active = this.#doc.activeElement;
    const index = stops.indexOf(rowOf(active) ?? active);
    const fallback = step > 0 ? -1 : 0;
    const from = index === -1 ? fallback : index;
    const next = stops[(from + step + count) % count];
    this.#stopTarget(next).focus({ preventScroll: true });
  }

  #moveInRow(step) {
    const active = this.#doc.activeElement;
    const row = rowOf(active);
    const all = Array.from(row.querySelectorAll(FOCUSABLE));
    const nodes = lineOf(all, active, this.#columns.get(row));
    const count = nodes.length;
    const index = nodes.indexOf(active);
    const next = nodes[(index + step + count) % count];
    next.focus({ preventScroll: true });
  }

  #moveInGrid(target, step) {
    const row = rowOf(target);
    const columns = this.#columns.get(row);
    if (!columns) return false;
    const nodes = Array.from(row.querySelectorAll(FOCUSABLE));
    const next = gridTarget(nodes, target, columns, step);
    next?.focus({ preventScroll: true });
    return next !== null;
  }

  #jump(index) {
    const stops = this.#stops();
    const stop = stops.at(index);
    if (stop) this.#stopTarget(stop).focus({ preventScroll: true });
  }

  #typeAhead(key) {
    const letter = key.toLowerCase();
    const items = Array.from(this.#element.querySelectorAll(ITEM));
    const from = items.indexOf(this.#doc.activeElement) + 1;
    const ordered = items.slice(from).concat(items.slice(0, from));
    const match = ordered.find((node) => labelOf(node).startsWith(letter));
    match?.focus({ preventScroll: true });
  }

  #remember(event) {
    const row = rowOf(event.target);
    if (row) this.#lastInRow.set(row, event.target);
  }

  #startPull(event) {
    if (!this.#isSheet || event.pointerType === 'mouse') return;
    const element = this.#element;
    const isGrabber = event.target.closest('.menu-grabber') !== null;
    const isFixed = element.scrollHeight <= element.clientHeight;
    const canPull = (isGrabber || isFixed) && element.scrollTop <= 0;
    this.#pull = { y: event.clientY, offset: 0, canPull };
  }

  #movePull(event) {
    const pull = this.#pull;
    if (!pull?.canPull) return;
    pull.offset = Math.max(event.clientY - pull.y, 0);
    if (pull.offset <= MOVE_PX) return;
    this.#element.style.transform = `translateY(${pull.offset}px)`;
  }

  #endPull() {
    const pull = this.#pull;
    this.#pull = null;
    if (!pull) return;
    this.#element.style.removeProperty('transform');
    if (pull.canPull && pull.offset >= PULL_CLOSE_PX) this.dismiss('swipe');
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
      const base = query && !isPrefix ? 1 : 0;
      const rank = entry.hidden ? base + HIDDEN_RANK : base;
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
      item.append(icon, label);
      if (entry.hidden) item.append(createMark());
      item.append(kind);
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

const dismissMenu = (reason) => current?.dismiss(reason) ?? false;

const isInMenu = (node) => current?.contains(node) ?? false;

export { Press, Menu, Lightbox, Switcher, dismissMenu, isInMenu };
