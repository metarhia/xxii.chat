import { optionOf } from './view.js';

let counter = 0;

const create = (tag, className, text = '') => {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text) element.textContent = text;
  return element;
};

const createCaption = (caption, note, id = '') => {
  const box = create('span', 'row-text');
  const label = create('span', 'row-label', caption);
  if (id) label.id = id;
  box.append(label);
  if (note) box.append(create('span', 'row-note', note));
  return box;
};

const createRow = (caption, note, control, extra = null) => {
  const isButton = control.tagName === 'BUTTON';
  const row = create(isButton ? 'div' : 'label', 'row');
  row.append(createCaption(caption, note));
  if (extra) {
    const field = create('span', 'row-field');
    field.append(control, extra);
    row.append(field);
  } else {
    row.append(control);
  }
  return row;
};

const createSwitch = (name, key = 'setting') => {
  const control = create('input');
  control.type = 'checkbox';
  control.setAttribute('role', 'switch');
  control.dataset[key] = name;
  return control;
};

const createRange = (name, key = 'setting') => {
  const control = create('input');
  control.type = 'range';
  control.min = '0';
  control.max = '100';
  control.step = '1';
  control.dataset[key] = name;
  return control;
};

const createSelect = (name, values, labelOf) => {
  const control = create('select');
  for (const value of values) {
    control.append(optionOf(value, labelOf?.(value) ?? value));
  }
  control.dataset.setting = name;
  return control;
};

const createInput = (name, limit, placeholder = '') => {
  const control = create('input');
  control.type = 'text';
  if (placeholder) control.placeholder = placeholder;
  control.maxLength = limit;
  control.autocomplete = 'off';
  control.dataset.setting = name;
  return control;
};

const createSaved = () => {
  const saved = create('span', 'saved');
  saved.setAttribute('role', 'status');
  return saved;
};

const createSegments = (caption, note, name, values, options = {}) => {
  const { labelOf, key = 'setting' } = options;
  const row = create('div', 'row');
  const id = `segments-${++counter}`;
  const group = create('div', 'segmented');
  group.setAttribute('role', 'radiogroup');
  group.setAttribute('aria-labelledby', id);
  for (const value of values) {
    const segment = create('label', 'segment');
    const input = create('input');
    input.type = 'radio';
    input.name = `setting-${name}-${counter}`;
    input.value = value;
    input.dataset[key] = name;
    segment.append(input, create('span', '', labelOf?.(value) ?? value));
    group.append(segment);
  }
  row.append(createCaption(caption, note, id), group);
  return row;
};

export { createRow, createSwitch, createSelect, createSegments };
export { createCaption };
export { createInput, createSaved, createRange };
