import { MediaCapture } from './media.js';
import { membersOf } from './members.js';
import { RecordingSession } from './recording-session.js';
import { createField, createProgramControls } from './record-panel.js';
import { createRecordFields } from './record-panel.js';

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
    const label = document.createElement('label');
    label.className = 'check';
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.dataset.source = name;
    label.append(input, labels[name]);
    sources.append(label);
  }
  return sources;
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
  const fields = createRecordFields();
  fields.prepend(layout);
  panel.replaceChildren(
    ...createProgramControls(),
    createSources(),
    note,
    fields,
  );
};

class SoloCapture extends RecordingSession {
  #panel = null;
  #hooks = null;
  #context = null;
  #disposing = null;

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
    const note = panel.querySelector('.capture-note');
    const unsupported = !supported
      ? 'Camera and mic capture are unavailable.'
      : '';
    const noScreen = !media.canScreen ? 'Screen capture is unavailable.' : '';
    note.textContent = media.message || media.notice || unsupported || noScreen;
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
    this.#panel.onclick = null;
    this.#panel.onchange = null;
    this.#panel.replaceChildren();
    this.#disposing = needsTracks
      ? disposed.finally(() => media.stop())
      : disposed;
    return this.#disposing;
  }

  #click(event) {
    const action = event.target.closest('button')?.dataset.action;
    if (action === 'record') this.toggle();
    if (action === 'record-pause') this.togglePause();
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
