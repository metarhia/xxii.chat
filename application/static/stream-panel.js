import { createButton } from './record-panel.js';
import { NAME_LENGTH, MIN_BITRATE, MAX_BITRATE } from './whip.js';

const MBPS = 1000000;

const createField = (name, label, type, attributes = {}) => {
  const control = document.createElement('input');
  control.dataset.stream = name;
  control.type = type;
  Object.assign(control, attributes);
  const field = document.createElement('label');
  field.className = 'call-field';
  const caption = document.createElement('span');
  caption.textContent = label;
  field.append(caption, control);
  return field;
};

const createAction = (name, label, id = '') => {
  const button = createButton(name, label);
  delete button.dataset.action;
  button.dataset.streamAction = name;
  if (id) button.dataset.id = id;
  return button;
};

const createEditor = () => {
  const box = document.createElement('div');
  box.className = 'stream-editor';
  box.dataset.streamEditor = '';
  box.hidden = true;
  const actions = document.createElement('div');
  actions.className = 'record-actions';
  actions.append(
    createAction('save-destination', 'Save destination'),
    createAction('cancel-destination', 'Cancel'),
  );
  box.append(
    createField('name', 'Destination name', 'text', {
      maxLength: NAME_LENGTH,
    }),
    createField('url', 'WHIP endpoint', 'url'),
    createField('token', 'Token', 'password', { autocomplete: 'off' }),
    createField('bitrate', 'Bitrate (Mbps)', 'number', {
      min: MIN_BITRATE / MBPS,
      max: MAX_BITRATE / MBPS,
      step: 0.5,
    }),
    actions,
  );
  return box;
};

const createDestinationControls = () => {
  const box = document.createElement('fieldset');
  box.className = 'studio-options';
  box.dataset.studioSection = 'destinations';
  const legend = document.createElement('legend');
  legend.textContent = 'Destinations';
  const list = document.createElement('ul');
  list.className = 'call-roster';
  list.dataset.streamList = '';
  const note = document.createElement('p');
  note.className = 'call-note stream-note';
  note.setAttribute('role', 'status');
  const live = createButton('go-live', 'Go live');
  live.classList.add('stream-live');
  box.append(
    legend,
    list,
    createAction('add-destination', 'Add destination'),
    createEditor(),
    live,
    note,
  );
  return box;
};

const hostOf = (url) => {
  try {
    return new URL(url).host;
  } catch {
    return '';
  }
};

const createDestinationRow = (destination) => {
  const { id, name, url, enabled } = destination;
  const row = document.createElement('li');
  row.dataset.id = id;
  const label = document.createElement('label');
  label.className = 'check';
  const check = document.createElement('input');
  check.type = 'checkbox';
  check.checked = enabled;
  check.dataset.stream = 'enabled';
  check.dataset.id = id;
  label.append(check, name);
  const host = document.createElement('span');
  host.className = 'stream-host';
  host.textContent = hostOf(url);
  const status = document.createElement('span');
  status.className = 'stream-status';
  const edit = createAction('edit-destination', 'Edit', id);
  edit.setAttribute('aria-label', `Edit destination: ${name}`);
  const remove = createAction('delete-destination', 'Delete', id);
  remove.setAttribute('aria-label', `Delete destination: ${name}`);
  row.append(label, host, status, edit, remove);
  return row;
};

const fillEditor = (editor, destination) => {
  const values = {
    name: destination.name,
    url: destination.url,
    token: destination.token,
    bitrate: destination.bitrate / MBPS,
  };
  for (const [name, value] of Object.entries(values)) {
    editor.querySelector(`[data-stream="${name}"]`).value = value;
  }
};

const readEditor = (editor) => {
  const value = (name) => editor.querySelector(`[data-stream="${name}"]`).value;
  const bitrate = Math.round(Number(value('bitrate')) * MBPS);
  return {
    name: value('name'),
    url: value('url').trim(),
    token: value('token'),
    bitrate,
  };
};

export { MBPS, createDestinationControls, createDestinationRow };
export { fillEditor, readEditor };
