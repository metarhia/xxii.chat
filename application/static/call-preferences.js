import {
  SETTINGS_KEY,
  OPTIONS,
  readSettings,
  writeSettings,
} from './call-settings.js';
import { readDevices, writeDevices, canSink } from './media.js';
import { folderHandle } from './recording-folder.js';

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
  recordingLayout: 'Layout',
  recordingAudio: 'Audio mode',
  recordingQuality: 'Quality',
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
      option.textContent = value;
      control.append(option);
    }
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
      panel.querySelector(group).append(settingField(name));
    }
    panel.addEventListener('change', (event) => this.change(event.target));
    const test = panel.querySelector('.test-speaker');
    test.onclick = () =>
      tone(readDevices(localStorage).speaker).catch((error) =>
        notice(error.message),
      );
    const folder = panel.querySelector('.record-folder');
    folder.hidden = !globalThis.showDirectoryPicker || !globalThis.indexedDB;
    folder.onclick = async () => {
      try {
        const handle = await globalThis.showDirectoryPicker({
          mode: 'readwrite',
          id: 'xxii-recordings',
          startIn: 'videos',
        });
        await folderHandle(handle);
        folder.textContent = `folder: ${handle.name}`;
      } catch (error) {
        if (error.name !== 'AbortError') {
          notice('Could not remember the recordings folder');
        }
      }
    };
    if (!folder.hidden) {
      folderHandle()
        .then((handle) => {
          if (handle) folder.textContent = `folder: ${handle.name}`;
        })
        .catch(() => notice('Could not read the recordings folder'));
    }
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
    if (setting) {
      const value =
        control.type === 'checkbox' ? control.checked : control.value;
      this.settings = { ...readSettings(localStorage), [setting]: value };
      if (!writeSettings(localStorage, this.settings)) {
        this.notice('Could not save call settings');
      }
      syncFields(this.panel, this.settings);
      this.stage()?.applyPreferences(this.settings);
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

  async refresh() {
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
