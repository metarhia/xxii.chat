import { SETTINGS_KEY, OPTIONS, readSettings } from './call-settings.js';
import { writeSettings, targetLabel, segmentLabel } from './call-settings.js';
import { TITLE_LIMIT, validateSettings } from './call-settings.js';
import { readDevices, writeDevices, canSink } from './media.js';
import { canPickFolder, folderRecord, pickFolder } from './recording-folder.js';
import { chooseRecordingFolder } from './recording-folder.js';
import { optionOf } from './view.js';
import { DevicePreview } from './device-preview.js';
import { createRow, createSwitch, createSelect } from './settings-rows.js';
import { createSegments, createInput, createSaved } from './settings-rows.js';

const deviceKinds = {
  mic: 'audioinput',
  camera: 'videoinput',
  speaker: 'audiooutput',
};
const setters = { mic: 'setMic', camera: 'setCamera', speaker: 'setSpeaker' };
const labels = {
  joinMicOff: 'Join with mic off',
  joinCameraOff: 'Join with camera off',
  mirror: 'Mirror camera',
  noise: 'Noise suppression',
  pushToTalk: 'Push-to-talk',
  autoLower: 'Auto-lower raised hand when speaking',
  title: 'Title for lower thirds',
  recordingLayout: 'Layout',
  recordingAudio: 'Audio mode',
  recordingQuality: 'Quality',
  recordingTarget: 'Save recordings to',
  recordingSegment: 'Part length',
};

const notes = {
  joinMicOff: 'Start every call with the microphone muted',
  joinCameraOff: 'Start every call with the camera off',
  mirror: 'Flip your own camera picture, others see it as it is',
  noise: 'How hard the browser filters background noise',
  pushToTalk: 'Hold Space to talk while muted',
  autoLower: 'Lower the raised hand when you start speaking',
  title: 'Shown under your name in studio banners and recordings',
  recordingLayout: 'Picture of the recording',
  recordingAudio: 'Which voices go into the recording',
  recordingQuality: 'Resolution and frame rate',
  recordingTarget: 'Where finished recordings are written',
  recordingSegment: 'A folder recording is saved in parts this long',
};

const deviceNames = {
  mic: 'Microphone',
  camera: 'Camera',
  speaker: 'Speaker',
};

const ALLOW_TEXT = 'Allow camera and microphone to see device names';
const NO_ACCESS_TEXT = 'Camera and microphone are unavailable';

const GROUPS = {
  profile: ['title'],
  audio: ['mic', 'level', 'speaker', 'noise', 'pushToTalk'],
  video: ['camera', 'mirror'],
  joining: ['joinMicOff', 'joinCameraOff'],
  hands: ['autoLower'],
  recording: [
    'recordingLayout',
    'recordingAudio',
    'recordingQuality',
    'recordingTarget',
    'folder',
    'recordingSegment',
  ],
};

const valueLabels = {
  recordingTarget: targetLabel,
  recordingSegment: segmentLabel,
};

const field = (caption, control) => {
  const label = document.createElement('label');
  label.className = control.type === 'checkbox' ? 'check' : 'call-field';
  if (control.type === 'checkbox') label.append(control, caption);
  else label.append(caption, control);
  return label;
};

const settingField = (name) => {
  const choices = OPTIONS[name];
  const control = document.createElement(choices ? 'select' : 'input');
  if (choices) {
    for (const value of choices) {
      control.append(optionOf(value, valueLabels[name]?.(value) ?? value));
    }
  } else if (name === 'title') {
    control.type = 'text';
    control.maxLength = TITLE_LIMIT;
  } else {
    control.type = 'checkbox';
  }
  control.dataset.setting = name;
  return field(labels[name], control);
};

const deviceField = (name) => {
  const select = document.createElement('select');
  select.dataset.device = name;
  return field(name, select);
};

const fillDevice = (select, devices, selected, noun) => {
  if (!select) return;
  const options = [{ deviceId: '', label: 'default' }];
  options.push(...devices.filter((device) => device.deviceId));
  select.replaceChildren(
    ...options.map(({ deviceId, label }, index) =>
      optionOf(deviceId, label || `${noun} ${index}`),
    ),
  );
  select.value = options.some((item) => item.deviceId === selected)
    ? selected
    : '';
};

const syncFields = (root, settings) => {
  for (const control of root.querySelectorAll('[data-setting]')) {
    const value = settings[control.dataset.setting];
    if (control.type === 'checkbox') {
      control.checked = value;
    } else if (control.type === 'radio') {
      control.checked = control.value === value;
    } else {
      control.value = value;
    }
  }
  const segment = root.querySelector('[data-setting="recordingSegment"]');
  const folder = root.querySelector('.record-folder');
  if (segment && folder) {
    segment.closest('.row, label').hidden =
      folder.hidden || settings.recordingTarget !== 'folder';
  }
};

const tone = async (speaker) => {
  const Context = globalThis.AudioContext ?? globalThis.webkitAudioContext;
  if (!Context) throw new Error('Speaker test unavailable in this browser');
  const context = new Context();
  let output = null;
  try {
    let destination = context.destination;
    if (speaker && typeof context.setSinkId === 'function') {
      await context.setSinkId(speaker);
    } else if (speaker) {
      output = document.createElement('audio');
      destination = context.createMediaStreamDestination();
      output.srcObject = destination.stream;
      await output.setSinkId(speaker);
      await output.play();
    }
    await context.resume();
    const oscillator = context.createOscillator();
    const gain = context.createGain();
    gain.gain.value = 0.08;
    oscillator.connect(gain).connect(destination);
    const ended = new Promise((resolve) => {
      oscillator.onended = resolve;
    });
    oscillator.start();
    oscillator.stop(context.currentTime + 0.4);
    await ended;
  } finally {
    output?.pause();
    await context.close();
  }
};

const createFolderButton = () => {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'record-folder link-btn';
  button.textContent = 'choose folder';
  return button;
};

const createAllow = () => {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'allow-devices link-btn';
  button.textContent = 'allow';
  button.hidden = true;
  return button;
};

const createDeviceRow = (name) => {
  const select = document.createElement('select');
  select.dataset.device = name;
  const hasAccess = name === 'mic' || name === 'camera';
  const allow = hasAccess ? createAllow() : null;
  const row = createRow(deviceNames[name], '', select, allow);
  if (name !== 'camera') return row;
  const video = document.createElement('video');
  video.className = 'device-preview';
  video.muted = true;
  video.playsInline = true;
  video.setAttribute('aria-label', 'Camera preview');
  row.insertBefore(video, row.lastChild);
  return row;
};

const createLevelRow = () => {
  const meter = document.createElement('div');
  meter.className = 'settings-meter';
  meter.setAttribute('role', 'meter');
  meter.setAttribute('aria-label', 'Microphone level');
  meter.setAttribute('aria-valuemin', '0');
  meter.setAttribute('aria-valuemax', '100');
  meter.setAttribute('aria-valuenow', '0');
  const bar = document.createElement('div');
  bar.className = 'level-bar';
  meter.append(bar);
  const row = createRow('Level', '', meter);
  row.classList.add('meter-row');
  return row;
};

const needsAccess = (list) => {
  const inputs = list.filter((item) => item.kind !== 'audiooutput');
  return inputs.length > 0 && inputs.every((item) => !item.label);
};

const canCapture = () =>
  typeof globalThis.navigator?.mediaDevices?.getUserMedia === 'function';

const requestAccess = async () => {
  const devices = globalThis.navigator.mediaDevices;
  const attempts = [
    { audio: true, video: true },
    { audio: true },
    { video: true },
  ];
  for (const constraints of attempts) {
    try {
      const stream = await devices.getUserMedia(constraints);
      for (const track of stream.getTracks()) track.stop();
      return true;
    } catch {
      continue;
    }
  }
  return false;
};

const fillAccess = (select, text) => {
  select.replaceChildren(optionOf('', text));
  select.value = '';
  select.disabled = true;
};

const createSettingRow = (name) => {
  const choices = OPTIONS[name];
  const caption = labels[name];
  const note = notes[name];
  if (name === 'noise') return createSegments(caption, note, name, choices);
  if (name === 'title') {
    const control = createInput(name, TITLE_LIMIT);
    return createRow(caption, note, control, createSaved());
  }
  if (!choices) return createRow(caption, note, createSwitch(name));
  const control = createSelect(name, choices, valueLabels[name]);
  return createRow(caption, note, control);
};

class CallPreferences {
  constructor(panel, stage, notice) {
    this.panel = panel;
    this.stage = stage;
    this.notice = notice;
    this.settings = readSettings(localStorage);
    this.folder = createFolderButton();
    this.isPickingFolder = false;
    this.folderRevision = 0;
    this.hasAccess = false;
    this.isPreviewWanted = false;
    this.folder.hidden = !canPickFolder();
    for (const group in GROUPS) {
      const rows = GROUPS[group].map((name) => this.createRow(name));
      panel.querySelector(`[data-group="${group}"]`).append(...rows);
    }
    this.preview = new DevicePreview({
      meter: panel.querySelector('.settings-meter'),
      video: panel.querySelector('.device-preview'),
      noise: () => this.settings.noise,
      report: (text) => this.notice(text),
    });
    this.preview.mirror(this.settings.mirror);
    for (const button of panel.querySelectorAll('.allow-devices')) {
      button.onclick = () => this.allow();
    }
    panel.addEventListener('change', (event) => this.change(event.target));
    this.folder.onclick = () => this.selectFolder(pickFolder);
    this.refreshFolder();
    globalThis.navigator.mediaDevices?.addEventListener('devicechange', () => {
      if (panel.offsetWidth) this.refresh();
    });
    window.addEventListener('storage', (event) => {
      if (event.key !== SETTINGS_KEY && event.key !== null) return;
      this.settings = readSettings(localStorage);
      syncFields(panel, this.settings);
      this.preview.mirror(this.settings.mirror);
      this.stage()?.applyPreferences(this.settings);
    });
    syncFields(panel, this.settings);
  }

  createRow(name) {
    if (name === 'speaker') return this.createSpeakerRow();
    if (name === 'level') return createLevelRow();
    if (name === 'folder') {
      const note = 'Used when saving to a folder';
      const row = createRow('Folder', note, this.folder);
      row.hidden = this.folder.hidden;
      return row;
    }
    if (deviceNames[name]) return createDeviceRow(name);
    const row = createSettingRow(name);
    if (name === 'recordingTarget') row.hidden = this.folder.hidden;
    return row;
  }

  createSpeakerRow() {
    const select = document.createElement('select');
    select.dataset.device = 'speaker';
    const test = document.createElement('button');
    test.type = 'button';
    test.className = 'test-speaker link-btn';
    test.textContent = 'test speaker';
    test.onclick = () =>
      tone(readDevices(localStorage).speaker).catch((error) =>
        this.notice(error.message),
      );
    const row = createRow(deviceNames.speaker, '', select, test);
    row.hidden = !canSink();
    return row;
  }

  change(control) {
    const { setting, device } = control.dataset;
    if (setting === 'recordingTarget' && control.value === 'folder') {
      syncFields(this.panel, this.settings);
      return void this.selectFolder(chooseRecordingFolder, true);
    }
    if (setting && control.type === 'radio' && !control.checked) return;
    if (setting) {
      const value =
        control.type === 'checkbox' ? control.checked : control.value;
      const settingValue =
        setting === 'recordingSegment' ? Number(value) : value;
      this.set(setting, settingValue);
    }
    if (!device) return;
    const media = this.stage()?.media;
    if (media) {
      media[setters[device]](control.value).catch((error) =>
        this.notice(error.message),
      );
    } else {
      writeDevices(localStorage, {
        ...readDevices(localStorage),
        [device]: control.value,
      });
      this.preview.restart();
    }
  }

  set(setting, value) {
    this.settings = validateSettings({
      ...readSettings(localStorage),
      [setting]: value,
    });
    if (!writeSettings(localStorage, this.settings)) {
      this.notice('Could not save call settings');
    }
    syncFields(this.panel, this.settings);
    this.preview.mirror(this.settings.mirror);
    if (setting === 'noise') this.preview.restart();
    this.stage()?.applyPreferences(this.settings);
  }

  setPreview(isWanted) {
    this.isPreviewWanted = isWanted;
    this.syncPreview();
  }

  syncPreview() {
    const isFree = !this.stage()?.media;
    const isLive = this.isPreviewWanted && this.hasAccess && isFree;
    if (isLive) this.preview.start();
    else this.preview.stop();
  }

  async allow() {
    await requestAccess();
    await this.refresh();
  }

  async selectFolder(pick, isTarget = false) {
    if (this.folder.hidden || this.isPickingFolder) return;
    const target = this.panel.querySelector('[data-setting="recordingTarget"]');
    this.folderRevision++;
    this.isPickingFolder = true;
    this.folder.disabled = true;
    target.disabled = true;
    try {
      const folder = await pick();
      if (!folder) return;
      this.folder.textContent = `folder: ${folder.name}`;
      if (isTarget) this.set('recordingTarget', 'folder');
    } catch {
      this.notice('Could not remember the recordings folder');
    } finally {
      this.isPickingFolder = false;
      this.folder.disabled = false;
      target.disabled = false;
    }
  }

  async refreshFolder() {
    if (this.folder.hidden || this.isPickingFolder) return;
    const revision = ++this.folderRevision;
    try {
      const folder = await folderRecord();
      if (revision !== this.folderRevision) return;
      this.folder.textContent = folder
        ? `folder: ${folder.name}`
        : 'choose folder';
    } catch {
      if (revision === this.folderRevision) {
        this.notice('Could not read the recordings folder');
      }
    }
  }

  async refresh() {
    this.refreshFolder();
    const devices = globalThis.navigator.mediaDevices;
    try {
      const list = devices?.enumerateDevices
        ? await devices.enumerateDevices()
        : [];
      const saved = readDevices(localStorage);
      const isBlocked = needsAccess(list);
      const canAsk = isBlocked && canCapture();
      this.hasAccess = canCapture() && !isBlocked;
      for (const select of this.panel.querySelectorAll('[data-device]')) {
        const name = select.dataset.device;
        const available = list.filter(
          (item) => item.kind === deviceKinds[name],
        );
        select.disabled = false;
        if (name !== 'speaker' && isBlocked) {
          fillAccess(select, canAsk ? ALLOW_TEXT : NO_ACCESS_TEXT);
        } else {
          fillDevice(select, available, saved[name], name);
        }
      }
      for (const button of this.panel.querySelectorAll('.allow-devices')) {
        button.hidden = !canAsk;
      }
      if (!devices?.enumerateDevices) {
        this.notice('Device selection unavailable in this browser');
      }
    } catch {
      this.notice('Could not list media devices');
    }
    this.syncPreview();
  }
}

export { CallPreferences, syncFields, settingField, deviceField, fillDevice };
