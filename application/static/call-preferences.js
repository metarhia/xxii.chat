import {
  SETTINGS_KEY,
  OPTIONS,
  readSettings,
  writeSettings,
  targetLabel,
  segmentLabel,
  TITLE_LIMIT,
  validateSettings,
} from './call-settings.js';
import { readDevices, writeDevices, canSink } from './media.js';
import { canPickFolder, folderRecord, pickFolder } from './recording-folder.js';
import { chooseRecordingFolder } from './recording-folder.js';

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
      const option = document.createElement('option');
      option.value = `${value}`;
      option.textContent = valueLabels[name]?.(value) ?? value;
      control.append(option);
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
    ...options.map(({ deviceId, label }, index) => {
      const option = document.createElement('option');
      option.value = deviceId;
      option.textContent = label || `${noun} ${index}`;
      return option;
    }),
  );
  select.value = options.some((item) => item.deviceId === selected)
    ? selected
    : '';
};

const syncFields = (root, settings) => {
  for (const control of root.querySelectorAll('[data-setting]')) {
    const value = settings[control.dataset.setting];
    if (control.type === 'checkbox') control.checked = value;
    else control.value = value;
  }
  const segment = root.querySelector('[data-setting="recordingSegment"]');
  const folder = root.querySelector('.record-folder');
  if (segment && folder) {
    segment.closest('label').hidden =
      folder.hidden || settings.recordingTarget !== 'folder';
  }
};

const tone = async (speaker) => {
  const Context = globalThis.AudioContext ?? globalThis.webkitAudioContext;
  if (!Context) throw new Error('Speaker test unavailable in this browser');
  const context = new Context();
  let output;
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

class CallPreferences {
  constructor(panel, stage, notice) {
    this.panel = panel;
    this.stage = stage;
    this.notice = notice;
    this.settings = readSettings(localStorage);
    this.folder = panel.querySelector('.record-folder');
    this.isPickingFolder = false;
    this.folderRevision = 0;
    this.folder.hidden = !canPickFolder();
    const devices = panel.querySelector('.call-device-fields');
    for (const name of ['camera', 'mic', 'speaker']) {
      const row = deviceField(name);
      row.hidden = name === 'speaker' && !canSink();
      devices.append(row);
    }
    for (const name of Object.keys(labels)) {
      const group = name.startsWith('recording')
        ? '.record-defaults'
        : '.join-defaults';
      const row = settingField(name);
      if (name === 'recordingTarget') row.hidden = this.folder.hidden;
      panel.querySelector(group).append(row);
      if (name === 'recordingTarget') row.after(this.folder);
    }
    panel.addEventListener('change', (event) => this.change(event.target));
    const test = panel.querySelector('.test-speaker');
    test.onclick = () =>
      tone(readDevices(localStorage).speaker).catch((error) =>
        notice(error.message),
      );
    this.folder.onclick = () => this.selectFolder(pickFolder);
    this.refreshFolder();
    globalThis.navigator.mediaDevices?.addEventListener('devicechange', () => {
      if (panel.offsetWidth) this.refresh();
    });
    window.addEventListener('storage', (event) => {
      if (event.key !== SETTINGS_KEY && event.key !== null) return;
      this.settings = readSettings(localStorage);
      syncFields(panel, this.settings);
      this.stage()?.applyPreferences(this.settings);
    });
    syncFields(panel, this.settings);
  }

  change(control) {
    const { setting, device } = control.dataset;
    if (setting === 'recordingTarget' && control.value === 'folder') {
      syncFields(this.panel, this.settings);
      return void this.selectFolder(chooseRecordingFolder, true);
    }
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
    this.stage()?.applyPreferences(this.settings);
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
      for (const select of this.panel.querySelectorAll('[data-device]')) {
        const name = select.dataset.device;
        const available = list.filter(
          (item) => item.kind === deviceKinds[name],
        );
        fillDevice(select, available, saved[name], name);
      }
      if (!devices?.enumerateDevices) {
        this.notice('Device selection unavailable in this browser');
      }
    } catch {
      this.notice('Could not list media devices');
    }
  }
}

export { CallPreferences, syncFields, settingField, deviceField, fillDevice };
