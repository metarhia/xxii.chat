import { MediaCapture } from './media.js';
import { membersOf } from './members.js';
import { RecordingSession } from './recording-session.js';
import { createField, createProgramControls } from './record-panel.js';
import { createButton, createRecordFields } from './record-panel.js';
import { paintCaptureHeader } from './record-panel.js';
import { targetLabel } from './call-settings.js';
import { canPickFolder, folderRecord } from './recording-folder.js';
import { labeled } from './view.js';

const LAYOUTS = {
  bubble: { people: 'speaker', screen: 'screenSpeaker', placement: 'bubble' },
  camera: { screen: 'off' },
  screen: { screen: 'screen' },
};

const LABELS = {
  bubble: 'screen with camera bubble',
  camera: 'camera only',
  screen: 'screen only',
};

const layoutOf = (layout) => ({ ...LAYOUTS[layout], names: false });

const createSources = () => {
  const sources = document.createElement('div');
  sources.className = 'capture-sources';
  const labels = {
    camera: 'camera',
    mic: 'mic',
    screen: 'screen or window',
    screenAudio: 'screen audio',
  };
  for (const name of Object.keys(labels)) {
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.dataset.source = name;
    sources.append(labeled(input, labels[name]));
  }
  return sources;
};

const targetOf = (target, folder) => {
  if (target !== 'folder') return targetLabel(target).toLowerCase();
  return folder ? `folder: ${folder}` : 'folder';
};

const summaryOf = ({ quality, recordingTarget }, folder) =>
  `${quality} · ${targetOf(recordingTarget, folder)} · `;

const createSummary = () => {
  const summary = document.createElement('p');
  summary.className = 'muted capture-summary';
  const text = document.createElement('span');
  text.className = 'capture-summary-text';
  const change = createButton('capture-settings', 'change');
  change.title = 'Change in Settings > Recordings';
  summary.append(text, change);
  return summary;
};

const createCapturePanel = (panel) => {
  const layout = createField({
    name: 'captureLayout',
    label: 'Layout',
    kind: 'choice',
    values: Object.keys(LAYOUTS),
    labels: LABELS,
  });
  const note = document.createElement('p');
  note.className = 'call-note capture-note';
  note.setAttribute('role', 'status');
  note.hidden = true;
  const fields = createRecordFields([]);
  fields.prepend(layout);
  panel.replaceChildren(
    ...createProgramControls(),
    createSources(),
    note,
    fields,
    createSummary(),
  );
};

class SoloCapture extends RecordingSession {
  #panel = null;
  #hooks = null;
  #context = null;
  #disposing = null;
  folderName = '';

  constructor(panel, context, settings, hooks) {
    super(settings, hooks);
    this.#panel = panel;
    this.#hooks = hooks;
    this.#context = context;
    this.options = {
      ...this.options,
      captureLayout: 'bubble',
      audio: 'all',
      noVideo: 'hide',
      screenAudio: false,
    };
    const media = new MediaCapture();
    this.media = media;
    media.cameraOn = false;
    media.micOn = false;
    media.noise = settings.noise;
    media.mirrorOn = settings.mirror;
    media.onChange = () => this.paint();
    createCapturePanel(panel);
    panel.onclick = (event) => this.#click(event);
    panel.onchange = (event) => this.#change(event.target);
    this.paint();
    this.#loadFolderName();
    media.start().catch((error) => {
      if (!this.isDisposed) hooks.fail(error);
    });
  }

  context() {
    return this.#context;
  }

  programOptions() {
    const layout = layoutOf(this.options.captureLayout);
    return { ...this.options, ...layout };
  }

  members() {
    const member = {
      endpoint: this.#hooks.endpoint,
      nick: this.#hooks.nick(),
      media: this.media,
    };
    const members = membersOf(member);
    if (this.options.captureLayout === 'screen') members[0].camera = null;
    return members;
  }

  paint() {
    if (this.isDisposed) return;
    const { media } = this;
    const panel = this.#panel;
    this.paintPanel(panel, true);
    const supported =
      typeof globalThis.navigator?.mediaDevices?.getUserMedia === 'function';
    const state = {
      camera: { checked: media.cameraOn, disabled: !supported },
      mic: { checked: media.micOn, disabled: !supported },
      screen: {
        checked: Boolean(media.screenTrack) || media.screenPending,
        disabled: !media.canScreen,
      },
      screenAudio: {
        checked: this.options.screenAudio,
        disabled: !media.canScreen,
      },
    };
    const track = media.screenAudioTrack;
    if (track) track.enabled = this.options.screenAudio;
    for (const control of panel.querySelectorAll('[data-source]')) {
      Object.assign(control, state[control.dataset.source]);
    }
    const summary = panel.querySelector('.capture-summary-text');
    summary.textContent = summaryOf(this.options, this.folderName);
    const note = panel.querySelector('.capture-note');
    const unsupported = !supported
      ? 'Camera and mic capture are unavailable.'
      : '';
    const noScreen = !media.canScreen ? 'Screen capture is unavailable.' : '';
    note.textContent = media.note || unsupported || noScreen;
    note.hidden = note.textContent === '';
  }

  afterStop(info, meta, isSaved) {
    if (isSaved) this.#hooks.saved(info, meta);
  }

  dispose() {
    if (this.#disposing) return this.#disposing;
    const { media } = this;
    const needsTracks = this.isActive;
    const disposed = super.dispose();
    if (!needsTracks) media.stop();
    paintCaptureHeader(this.#panel, '');
    this.#panel.onclick = null;
    this.#panel.onchange = null;
    this.#panel.replaceChildren();
    this.#disposing = needsTracks
      ? disposed.finally(() => media.stop())
      : disposed;
    return this.#disposing;
  }

  #loadFolderName() {
    if (!canPickFolder() || this.options.recordingTarget !== 'folder') return;
    folderRecord()
      .then((record) => {
        this.folderName = record?.name ?? '';
        this.paint();
      })
      .catch(() => {});
  }

  #click(event) {
    const action = event.target.closest('button')?.dataset.action;
    if (action === 'record') this.toggle();
    if (action === 'record-pause') this.togglePause();
    if (action === 'capture-settings') this.#hooks.settings();
  }

  #change(control) {
    const { source } = control.dataset;
    if (!source) return void this.change(control);
    const { media } = this;
    const isOn = control.checked;
    if (source === 'camera') {
      media.toggleCamera();
    } else if (source === 'mic') {
      media.toggleMic(true);
    } else if (source === 'screen') {
      if (isOn) media.openScreen(false);
      else media.stopScreen();
    } else if (source === 'screenAudio') {
      this.options = { ...this.options, screenAudio: isOn };
    }
    this.paint();
  }
}

export { SoloCapture, layoutOf };
