import { PEOPLE, SCREENS, PLACEMENTS, OTHERS, POSITIONS } from './layout.js';
import { NO_VIDEO, QUALITIES, MIN_SPEAKERS, MAX_SPEAKERS } from './layout.js';
import { DEFAULTS, OPTIONS, targetLabel } from './call-settings.js';
import { segmentLabel } from './call-settings.js';
import { canPickFolder } from './recording-folder.js';
import { optionOf, labeled } from './view.js';
import { createSideBar, createSideBody } from './call-side.js';

const SURFACE_COLOR = '#0f1418';
const VOLUME_MAX = 200;
const VOLUME_STEP = 5;

const range = (from, to) => {
  const count = Math.max(0, to - from + 1);
  const values = new Array(count).fill(0);
  for (let i = 0; i < count; i++) values[i] = from + i;
  return values;
};

const SHARED_FIELDS = [
  {
    name: 'quality',
    label: 'Quality',
    kind: 'choice',
    values: Object.keys(QUALITIES),
  },
  {
    name: 'recordingTarget',
    label: 'Save recordings to',
    kind: 'choice',
    values: OPTIONS.recordingTarget,
  },
  {
    name: 'recordingSegment',
    label: 'Part length',
    kind: 'count',
    values: OPTIONS.recordingSegment,
  },
];

const PROGRAM_FIELDS = [
  { name: 'people', label: 'People on screen', kind: 'choice', values: PEOPLE },
  {
    name: 'maxSpeakers',
    label: 'Max speakers',
    kind: 'count',
    values: range(MIN_SPEAKERS, MAX_SPEAKERS),
  },
  { name: 'screen', label: 'Screen share', kind: 'choice', values: SCREENS },
  {
    name: 'placement',
    label: 'Speaker placement',
    kind: 'choice',
    values: PLACEMENTS,
  },
  { name: 'others', label: 'Others panel', kind: 'choice', values: OTHERS },
  {
    name: 'othersPosition',
    label: 'Panel position',
    kind: 'choice',
    values: POSITIONS,
  },
  {
    name: 'audio',
    label: 'Audio',
    kind: 'choice',
    values: OPTIONS.recordingAudio,
  },
  { name: 'includeMe', label: 'Include me', kind: 'flag' },
  { name: 'screenAudio', label: 'Screen audio', kind: 'flag' },
  { name: 'names', label: 'Names', kind: 'flag' },
  { name: 'noVideo', label: 'No video', kind: 'choice', values: NO_VIDEO },
];

const FIELDS = PROGRAM_FIELDS.concat(SHARED_FIELDS);

const LABELS = {
  people: {
    speaker: 'one speaker',
    speakers: 'active speakers',
    grid: 'everyone',
    pinned: 'chosen people',
  },
  screen: {
    off: 'off',
    screen: 'screen only',
    screenSpeaker: 'screen and speaker',
    screenSpeakers: 'screen and speakers',
  },
  placement: { strip: 'strip', bubble: 'bubble' },
  others: { hidden: 'hidden', strip: 'small tiles', names: 'names only' },
  audio: {
    all: 'everyone',
    onScreen: 'people on screen',
    duck: 'others quieter',
    custom: 'per person',
  },
  noVideo: { avatar: 'avatar', hide: 'hide' },
};

const defaultsOf = (settings) => ({
  people: settings?.recordingLayout ?? 'speakers',
  maxSpeakers: 4,
  screen: 'screenSpeakers',
  placement: 'strip',
  others: 'hidden',
  othersPosition: 'bottom',
  audio: settings?.recordingAudio ?? 'all',
  includeMe: true,
  screenAudio: true,
  names: true,
  noVideo: 'avatar',
  quality: settings?.recordingQuality ?? '1080p30',
  recordingTarget:
    canPickFolder() && settings?.recordingTarget === 'folder'
      ? 'folder'
      : 'browser',
  recordingSegment: settings?.recordingSegment ?? DEFAULTS.recordingSegment,
  background: '',
  pinned: [],
  volumes: {},
});

const labelOf = (name, value) => {
  if (name === 'recordingTarget') return targetLabel(value);
  if (name === 'recordingSegment') return segmentLabel(value);
  return LABELS[name]?.[value] ?? `${value}`;
};

const valueOf = (control) => {
  if (control.type === 'checkbox') return control.checked;
  if (control.dataset.kind === 'count') return Number(control.value);
  return control.value;
};

const createButton = (action, label) => {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'link-btn';
  button.dataset.action = action;
  button.textContent = label;
  return button;
};

const createSelect = (field) => {
  const select = document.createElement('select');
  select.dataset.record = field.name;
  select.dataset.kind = field.kind;
  for (const value of field.values) {
    const label = field.labels?.[value] ?? labelOf(field.name, value);
    select.append(optionOf(value, label));
  }
  return select;
};

const createCheck = (field) => {
  const input = document.createElement('input');
  input.type = 'checkbox';
  input.dataset.record = field.name;
  input.dataset.kind = field.kind;
  return input;
};

const createField = (field) => {
  const isFlag = field.kind === 'flag';
  const control = isFlag ? createCheck(field) : createSelect(field);
  const label = labeled(control, field.label);
  label.dataset.field = field.name;
  return label;
};

const createBackground = () => {
  const box = document.createElement('div');
  box.className = 'record-background';
  const input = document.createElement('input');
  input.type = 'color';
  input.value = SURFACE_COLOR;
  input.dataset.record = 'background';
  input.dataset.kind = 'color';
  const file = document.createElement('input');
  file.type = 'file';
  file.accept = 'image/*';
  file.dataset.record = 'image';
  box.append(
    labeled(input, 'Background'),
    labeled(file, 'Background image'),
    createButton('record-background', 'default'),
  );
  return box;
};

const createList = (name, label) => {
  const box = document.createElement('fieldset');
  box.className = 'record-list hidden';
  box.dataset.list = name;
  const legend = document.createElement('legend');
  legend.textContent = label;
  box.append(legend);
  return box;
};

const createRecordFields = (options = SHARED_FIELDS) => {
  const fields = document.createElement('div');
  fields.className = 'record-fields';
  for (const field of options) {
    const isFolderField = field.name.startsWith('recording');
    if (!isFolderField || canPickFolder()) fields.append(createField(field));
  }
  return fields;
};

const createProgramControls = () => {
  const preview = document.createElement('div');
  preview.className = 'record-preview';
  const state = document.createElement('p');
  state.className = 'record-state';
  const actions = document.createElement('div');
  actions.className = 'record-actions';
  actions.append(
    createButton('record', 'start recording'),
    createButton('record-pause', 'pause'),
  );
  const note = document.createElement('p');
  note.className = 'call-note record-note hidden';
  note.setAttribute('role', 'status');
  return [state, preview, actions, note];
};

const createRecordPanel = () => {
  const aside = document.createElement('aside');
  aside.className = 'call-record';
  aside.setAttribute('aria-label', 'Recording');
  const fields = createRecordFields(FIELDS);
  fields.append(createBackground());
  const follows = document.createElement('p');
  follows.className = 'call-note record-follows hidden';
  const capture = createButton('capture-local', 'Add a screen to my recording');
  const [state, preview, actions, note] = createProgramControls();
  const body = createSideBody(state, preview, note, follows, capture, fields);
  body.append(createList('pinned', 'Chosen people'));
  body.append(createList('volumes', 'Volume per person'));
  aside.append(body, createSideBar(...actions.children));
  return aside;
};

const CONTROL_LABELS = { idle: 'record', recording: 'stop', paused: 'paused' };

const paintControlLabel = (button, view) => {
  const label = button.querySelector('.call-label');
  label.textContent = CONTROL_LABELS[view.state] ?? 'stop';
  button.title = view.state === 'idle' ? 'Record' : 'Stop recording';
};

const paintIndicator = (root, view) => {
  const indicator = root.querySelector('.call-recording');
  if (!indicator) return;
  if (view.state === 'idle') {
    if (indicator.dataset.own === undefined) return;
    delete indicator.dataset.own;
    indicator.textContent = '';
    indicator.classList.add('hidden');
    return;
  }
  const sign = view.state === 'paused' ? 'paused ' : '';
  indicator.dataset.own = '';
  indicator.textContent = `● ${sign}${view.text}`;
  indicator.classList.remove('hidden');
};

const paintRecordButton = (button, view) => {
  const isControl = button.classList.contains('call-control');
  const isActive = view.state !== 'idle';
  button.setAttribute('aria-pressed', `${isActive}`);
  button.disabled = view.isBusy;
  button.classList.toggle('recording', isActive);
  if (isControl) return void paintControlLabel(button, view);
  button.textContent = isActive ? 'stop recording' : 'start recording';
};

const paintPause = (button, view) => {
  const isActive = view.state !== 'idle';
  button.disabled = !isActive;
  button.textContent = view.state === 'paused' ? 'resume' : 'pause';
};

const syncControl = (control, options, view) => {
  const name = control.dataset.record;
  const value = options[name];
  const isFolderField =
    name === 'recordingTarget' || name === 'recordingSegment';
  const isShared = name === 'quality' || isFolderField;
  control.disabled = isShared
    ? view.state !== 'idle' || view.isBusy
    : Boolean(view.sceneName);
  if (name === 'image') return;
  if (name === 'recordingSegment') {
    control.closest('label').hidden = options.recordingTarget !== 'folder';
  }
  if (control.type === 'checkbox') control.checked = value;
  else if (name === 'background') control.value = value || SURFACE_COLOR;
  else control.value = `${value}`;
};

const paintRows = (box, rows, make) => {
  const keyOf = (person) => `${person.endpoint}|${person.nick}`;
  const key = rows.map(keyOf).join('\n');
  box.classList.toggle('hidden', rows.length === 0);
  if (box.dataset.key === key) return;
  box.dataset.key = key;
  const legend = box.querySelector('legend');
  box.replaceChildren(legend, ...rows.map(make));
};

const createPinRow = (person) => {
  const input = document.createElement('input');
  input.type = 'checkbox';
  input.dataset.pin = person.endpoint;
  return labeled(input, person.nick || 'guest');
};

const createVolumeRow = (person) => {
  const input = document.createElement('input');
  input.type = 'range';
  input.min = '0';
  input.max = `${VOLUME_MAX}`;
  input.step = `${VOLUME_STEP}`;
  input.dataset.volume = person.endpoint;
  return labeled(input, person.nick || 'guest');
};

const volumeOf = (options, endpoint) => {
  const saved = options.volumes[endpoint];
  return Number.isFinite(saved) ? Math.round(saved * 100) : 100;
};

const syncLists = (box, options) => {
  const isIdle = (input) => input !== document.activeElement;
  for (const input of box.querySelectorAll('[data-pin]')) {
    input.checked = options.pinned.includes(input.dataset.pin);
  }
  for (const input of box.querySelectorAll('[data-volume]')) {
    const volume = volumeOf(options, input.dataset.volume);
    if (isIdle(input)) input.value = `${volume}`;
  }
};

const paintLists = (root, options, people, disabled = false) => {
  const pins = root.querySelector('[data-list="pinned"]');
  const volumes = root.querySelector('[data-list="volumes"]');
  const pinRows = options.people === 'pinned' ? people : [];
  const volumeRows = options.audio === 'custom' ? people : [];
  paintRows(pins, pinRows, createPinRow);
  paintRows(volumes, volumeRows, createVolumeRow);
  syncLists(pins, options);
  syncLists(volumes, options);
  pins.disabled = disabled;
  volumes.disabled = disabled;
};

const createSceneFields = () => {
  const fields = createRecordFields(PROGRAM_FIELDS);
  fields.append(createList('pinned', 'Chosen people'));
  fields.append(createList('volumes', 'Volume per person'));
  return fields;
};

const paintSceneFields = (root, program, people) => {
  const view = { state: 'idle' };
  for (const control of root.querySelectorAll('[data-record]')) {
    if (control !== document.activeElement) syncControl(control, program, view);
  }
  paintLists(root, program, people);
};

const paintCaptureHeader = (root, text) => {
  const meta = root.closest('.panel')?.querySelector('.panel-meta');
  if (!meta) return;
  meta.textContent = text;
  meta.hidden = text === '';
};

const paintRecordPanel = (root, view) => {
  const isCall = !root.matches('.capture-panel');
  const panel = isCall ? root.querySelector('.call-record') : root;
  if (!panel) return;
  const state = panel.querySelector('.record-state');
  const isActive = view.state !== 'idle';
  const label = view.state === 'paused' ? 'paused' : 'recording';
  const status = isCall ? `${label} · ${view.text}` : label;
  state.textContent = isActive ? status : 'not recording';
  const pause = view.state === 'paused' ? 'paused ' : '';
  if (!isCall) paintCaptureHeader(panel, isActive ? pause + view.text : '');
  const note = panel.querySelector('.record-note');
  note.textContent = view.notice;
  note.classList.toggle('hidden', view.notice === '');
  for (const control of panel.querySelectorAll('[data-record]')) {
    syncControl(control, view.options, view);
  }
  if (isCall) {
    const follows = panel.querySelector('.record-follows');
    follows.classList.toggle('hidden', !view.sceneName);
    follows.textContent = view.sceneName
      ? `Program follows the Studio scene ${view.sceneName}`
      : '';
    panel.querySelector('[data-action="record-background"]').disabled = Boolean(
      view.sceneName,
    );
    paintLists(panel, view.options, view.people, Boolean(view.sceneName));
    panel.toggleAttribute('data-open', view.isOpen);
  }
};

const paintRecordControl = (root, view) => {
  for (const button of root.querySelectorAll('[data-action="record"]')) {
    paintRecordButton(button, view);
  }
  for (const button of root.querySelectorAll('[data-action="record-pause"]')) {
    paintPause(button, view);
  }
  paintRecordPanel(root, view);
  paintIndicator(root, view);
};

export { FIELDS, PROGRAM_FIELDS, defaultsOf, labelOf, valueOf };
export { createSceneFields, paintSceneFields };
export { createRecordPanel, paintRecordControl };
export { createProgramControls, createRecordFields, createField };
export { createButton, paintCaptureHeader };
