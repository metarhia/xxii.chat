import { createButton, createSceneFields } from './record-panel.js';
import { SCENE_TYPES, TRANSITIONS, CORNERS, FONTS } from './studio-layout.js';
import { CHIP_STYLES, OVERLAYS } from './studio-layout.js';
import { groupOf } from './studio-storage.js';

const OVERLAY_LABELS = {
  logo: 'Logo',
  banner: 'Banner',
  ticker: 'Ticker',
  lowerThird: 'Lower third',
  comment: 'Comment',
};

const TYPE_LABELS = {
  live: 'Live',
  countdown: 'Countdown',
  intermission: 'Intermission',
  fade: 'Fade',
  cut: 'Cut',
  'top-left': 'Top left',
  'top-right': 'Top right',
  'bottom-left': 'Bottom left',
  'bottom-right': 'Bottom right',
  'system-ui': 'System font',
  block: 'Block',
  bubble: 'Bubble',
  bar: 'Side bar',
};

const fieldset = (name, label) => {
  const box = document.createElement('fieldset');
  box.className = 'studio-options';
  box.dataset.studioSection = name;
  const legend = document.createElement('legend');
  legend.textContent = label;
  box.append(legend);
  return box;
};

const optionOf = (value, label) => {
  const option = document.createElement('option');
  option.value = value;
  option.textContent = label;
  return option;
};

const labeled = (control, label) => {
  const field = document.createElement('label');
  field.className = control.type === 'checkbox' ? 'check' : 'call-field';
  if (control.type === 'checkbox') {
    field.append(control, label);
  } else {
    const caption = document.createElement('span');
    caption.textContent = label;
    field.append(caption, control);
  }
  return field;
};

const input = (name, label, type, attributes = {}) => {
  const control = document.createElement('input');
  control.dataset.studio = name;
  control.type = type;
  Object.assign(control, attributes);
  return labeled(control, label);
};

const select = (name, label, values = []) => {
  const control = document.createElement('select');
  control.dataset.studio = name;
  control.append(
    ...values.map((value) => optionOf(value, TYPE_LABELS[value] ?? value)),
  );
  return labeled(control, label);
};

const assetSelect = (name, label, group) => {
  const field = select(name, label);
  field.querySelector('select').dataset.assetGroup = group;
  return field;
};

const action = (name, label, id = '') => {
  const button = createButton(name, label);
  delete button.dataset.action;
  button.dataset.studioAction = name;
  if (id) button.dataset.id = id;
  return button;
};

const list = (name) => {
  const node = document.createElement('ul');
  node.className = 'call-roster';
  node.dataset.studioList = name;
  return node;
};

const actions = (...buttons) => {
  const row = document.createElement('div');
  row.className = 'record-actions';
  row.append(...buttons);
  return row;
};

const createSceneEditor = () => {
  const box = fieldset('editor', 'Scene');
  box.hidden = true;
  box.append(
    input('name', 'Scene name', 'text'),
    select('type', 'Scene type', SCENE_TYPES),
    input('text', 'Title', 'text'),
    input('minutes', 'Countdown minutes', 'number', { min: 1, max: 60 }),
    input('color', 'Background', 'color'),
    assetSelect('image', 'Background image', 'image'),
    assetSelect('music', 'Music', 'audio'),
    ...OVERLAYS.map((name) =>
      input(name, `Show ${OVERLAY_LABELS[name].toLowerCase()}`, 'checkbox'),
    ),
    createSceneFields(),
    actions(
      action('save-scene', 'Save scene'),
      action('cancel-scene', 'Cancel'),
      action('delete-scene', 'Delete scene'),
    ),
  );
  return box;
};

const createSceneControls = () => {
  const box = fieldset('scenes', 'Scenes');
  box.append(
    select('transition', 'Transition', TRANSITIONS),
    list('scenes'),
    action('add-scene', 'Add scene'),
  );
  return box;
};

const createBrandControls = () => {
  const box = fieldset('brand', 'Branding');
  box.append(
    input('accent', 'Accent color', 'color'),
    input('brandText', 'Text color', 'color'),
    input('chip', 'Chip color', 'text', { maxLength: 32 }),
    select('chipStyle', 'Chip style', CHIP_STYLES),
    select('font', 'Font', FONTS),
    assetSelect('logoAsset', 'Logo image', 'image'),
    select('corner', 'Logo corner', CORNERS),
    input('size', 'Logo size', 'number', { min: 48, max: 192, step: 1 }),
  );
  return box;
};

const createAssetControls = () => {
  const box = fieldset('assets', 'Assets');
  box.append(
    input('upload', 'Add image, audio or video', 'file', {
      accept: 'image/*,audio/*,video/*',
    }),
    input('musicVolume', 'Music volume', 'range', { min: 0, max: 100 }),
    list('assets'),
  );
  return box;
};

const createTextControls = () => {
  const box = fieldset('texts', 'On-screen text');
  const editor = fieldset('banner-editor', 'Banner');
  editor.hidden = true;
  editor.append(
    input('bannerText', 'Banner text', 'text'),
    actions(
      action('save-banner', 'Save banner'),
      action('cancel-banner', 'Cancel'),
    ),
  );
  box.append(
    list('banners'),
    action('add-banner', 'Add banner'),
    editor,
    input('tickerText', 'Ticker text', 'text'),
  );
  return box;
};

const createBannerRow = ({ id, text }) => {
  const row = document.createElement('li');
  const caption = document.createElement('span');
  caption.textContent = text;
  row.append(
    caption,
    action('show-banner', 'Show', id),
    action('edit-banner', 'Edit', id),
    action('delete-banner', 'Delete', id),
  );
  for (const button of row.querySelectorAll('button')) {
    button.setAttribute('aria-label', `${button.textContent} banner: ${text}`);
  }
  return row;
};

const createLowerThird = (person) =>
  action('lower-third', 'Lower third', person.endpoint);

const createSceneRow = (scene) => {
  const row = document.createElement('li');
  const choose = action('switch-scene', scene.name, scene.id);
  const edit = action('edit-scene', 'Edit', scene.id);
  edit.setAttribute('aria-label', `Edit ${scene.name}`);
  row.append(choose, edit);
  return row;
};

const createAssetRow = (asset) => {
  const row = document.createElement('li');
  const name = document.createElement('span');
  name.textContent = asset.name;
  const remove = action('delete-asset', 'Delete', asset.checksum);
  remove.setAttribute('aria-label', `Delete ${asset.name}`);
  row.append(name);
  if (groupOf(asset.type) === 'video') {
    row.append(
      action('play-full', 'Play full frame', asset.checksum),
      action('play-tile', 'Play as tile', asset.checksum),
      action('stop-clip', 'Stop', asset.checksum),
    );
  }
  row.append(remove);
  return row;
};

const paintValues = (box, values) => {
  for (const [name, value] of Object.entries(values)) {
    const control = box.querySelector(`[data-studio="${name}"]`);
    if (control.type === 'checkbox') control.checked = value;
    else if (control !== document.activeElement) control.value = value;
  }
};

const paintOptions = (panel, assets, key) => {
  for (const control of panel.querySelectorAll('[data-asset-group]')) {
    if (control.dataset.key === key) continue;
    control.dataset.key = key;
    const group = control.dataset.assetGroup;
    const options = [...assets.values()]
      .filter((asset) => groupOf(asset.type) === group)
      .map((asset) => optionOf(asset.checksum, asset.name));
    control.replaceChildren(optionOf('', 'None'), ...options);
  }
};

const paintList = (panel, name, key, items, createRow) => {
  const target = panel.querySelector(`[data-studio-list="${name}"]`);
  if (target.dataset.key === key) return;
  target.dataset.key = key;
  target.replaceChildren(...items.map(createRow));
};

export { createSceneControls, createSceneEditor, createBrandControls };
export { createAssetControls, createSceneRow, createAssetRow, paintValues };
export { paintOptions, paintList };
export { createTextControls, createBannerRow, createLowerThird };
