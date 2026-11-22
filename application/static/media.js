import { readCallStats } from './call-stats.js';
import { createMirror, pathOf, capabilitiesOf } from './mirror.js';
import { Emitter, jsonParse } from './metautil.js';

const CAMERA = {
  width: { ideal: 1280 },
  height: { ideal: 720 },
  frameRate: { ideal: 30, max: 30 },
  aspectRatio: { ideal: 16 / 9 },
};

const CAMERA_MOBILE = { width: { ideal: 640 }, height: { ideal: 480 } };

const MIC = {
  echoCancellation: true,
  noiseSuppression: true,
  autoGainControl: true,
  channelCount: 1,
};

const SCREEN = {
  video: { frameRate: { ideal: 15, max: 30 }, displaySurface: 'monitor' },
  audio: true,
  systemAudio: 'include',
  surfaceSwitching: 'include',
  selfBrowserSurface: 'exclude',
  monitorTypeSurfaces: 'include',
};

const SCREEN_MESSAGES = {
  NotAllowedError: 'Screen capture was cancelled or blocked.',
  NotFoundError: 'No screen or window is available to capture.',
  NotReadableError: 'The selected screen could not be captured.',
  InvalidStateError: 'Click share again to choose a screen.',
};

const CLOCK_URL = new URL('./clock-worker.js', import.meta.url);
const CLOCK_FPS = 30;
const MIRROR_NOTICE = 'Camera mirroring is unavailable';

const DEVICES_KEY = 'xxii:devices';
const MOBILE = '(pointer: coarse)';
const MUTE_STOP_MS = 30000;
const BANDWIDTH_ROWS = [
  { bitrate: 1500000, height: 720, fps: 30, screen: 2500000, screenFps: 30 },
  { bitrate: 800000, height: 540, fps: 30, screen: 1500000, screenFps: 30 },
  { bitrate: 500000, height: 360, fps: 24, screen: 1200000, screenFps: 15 },
  { bitrate: 0, height: 180, fps: 24, screen: 1000000, screenFps: 10 },
];
const CODECS = {
  video: ['video/VP9', 'video/VP8', 'video/H264'],
  audio: ['audio/opus'],
};
const LOSS_HOLD_MS = 5000;
const CLEAN_HOLD_MS = 20000;

const MESSAGES = {
  NotAllowedError: 'Blocked. Allow the camera and mic in the site settings.',
  NotFoundError: 'No camera or microphone found.',
  NotReadableError: 'Camera or mic is in use by another app.',
  OverconstrainedError: 'Those camera settings are not supported.',
};

const EMPTY_DEVICES = { camera: '', mic: '', speaker: '' };

const messageOf = (error) =>
  MESSAGES[error?.name] ?? 'Could not open the camera or mic.';

const readDevices = (storage) => {
  if (!storage) return { ...EMPTY_DEVICES };
  let parsed = null;
  try {
    const text = storage.getItem(DEVICES_KEY);
    parsed = text ? jsonParse(text) : null;
  } catch {
    return { ...EMPTY_DEVICES };
  }
  if (!parsed || typeof parsed !== 'object') return { ...EMPTY_DEVICES };
  const camera = typeof parsed.camera === 'string' ? parsed.camera : '';
  const mic = typeof parsed.mic === 'string' ? parsed.mic : '';
  const speaker = typeof parsed.speaker === 'string' ? parsed.speaker : '';
  return { camera, mic, speaker };
};

const writeDevices = (storage, devices) => {
  if (!storage) return;
  try {
    storage.setItem(DEVICES_KEY, JSON.stringify(devices));
  } catch {
    return;
  }
};

const isMobile = () => {
  const query = globalThis.matchMedia;
  if (typeof query !== 'function') return false;
  return query(MOBILE).matches;
};

const pausesCameraInBackground = () => {
  const nav = globalThis.navigator;
  if (/Android|iPhone|iPad|iPod/i.test(nav?.userAgent ?? '')) return true;
  return nav?.platform === 'MacIntel' && nav.maxTouchPoints > 1;
};

const cameraVideo = (deviceId, facing) => {
  const video = isMobile() ? { ...CAMERA_MOBILE } : { ...CAMERA };
  if (facing && !deviceId) video.facingMode = { ideal: facing };
  if (deviceId) video.deviceId = { exact: deviceId };
  return video;
};

const micAudio = (deviceId, noise) => {
  const audio = { ...MIC };
  if (noise === 'strong') {
    const devices = globalThis.navigator?.mediaDevices;
    if (devices?.getSupportedConstraints?.().voiceIsolation) {
      audio.voiceIsolation = true;
    }
  }
  if (deviceId) audio.deviceId = { exact: deviceId };
  return audio;
};

const canSink = () => {
  const proto = globalThis.HTMLMediaElement?.prototype;
  return typeof proto?.setSinkId === 'function';
};

const hasId = (list, id) => {
  for (const device of list) {
    if (device.deviceId === id) return true;
  }
  return false;
};

const missingId = (list, id) => {
  if (id === '' || list.length === 0) return false;
  return !hasId(list, id);
};

const stopStream = (stream) => {
  const tracks = stream?.getTracks?.() ?? [];
  for (const track of tracks) track.stop();
};

const capture = async (kind, constraints) => {
  const devices = globalThis.navigator?.mediaDevices;
  if (typeof devices?.getUserMedia !== 'function') {
    const error = new Error('This browser has no camera or mic');
    error.name = 'NotFoundError';
    throw error;
  }
  try {
    return await devices.getUserMedia(constraints);
  } catch (error) {
    if (error?.name !== 'OverconstrainedError') throw error;
    const bare = kind === 'video' ? { video: true } : { audio: true };
    return devices.getUserMedia(bare);
  }
};

const bandwidthRow = (participants) => {
  if (participants <= 2) return 0;
  if (participants <= 4) return 1;
  if (participants <= 6) return 2;
  return 3;
};

const validateHint = (message) => {
  if (!message || typeof message !== 'object') return null;
  const { slot, width, height, fps, audioOnly } = message;
  if (slot !== 'camera' && slot !== 'screen') return null;
  const dimensions = [width, height, fps];
  if (!dimensions.every(Number.isFinite)) return null;
  if (dimensions.some((value) => value < 0)) return null;
  if (audioOnly !== undefined && typeof audioOnly !== 'boolean') return null;
  const hidden = width === 0 || height === 0 || fps === 0;
  return {
    slot,
    width: hidden ? 0 : Math.min(7680, Math.max(1, Math.round(width))),
    height: hidden ? 0 : Math.min(4320, Math.max(1, Math.round(height))),
    fps: hidden ? 0 : Math.min(30, Math.max(1, Math.round(fps))),
    audioOnly: slot === 'camera' && audioOnly === true,
  };
};

const encodingPolicy = (options) => {
  const { slot, participants, step = 0, hint, settings = {} } = options;
  if (slot === 'mic' || slot === 'screenAudio') {
    return { active: true, maxBitrate: 32000 };
  }
  const base = bandwidthRow(participants);
  const row = BANDWIDTH_ROWS[Math.min(3, base + step)];
  const screen = slot === 'screen';
  const normal = BANDWIDTH_ROWS[base];
  const maxBitrate = screen ? normal.screen : row.bitrate;
  const maxFps = screen ? normal.screenFps : row.fps;
  const sourceHeight = settings.height || (screen ? 1080 : 720);
  const sourceWidth = settings.width || (sourceHeight * 16) / 9;
  const height = screen ? sourceHeight : row.height;
  let scale = Math.max(1, sourceHeight / height);
  if (hint && hint.height > 0) {
    const hintedScale = Math.max(
      sourceHeight / hint.height,
      sourceWidth / hint.width,
    );
    const minimumScale = Math.max(1, sourceHeight / 180);
    scale = Math.max(scale, Math.min(minimumScale, hintedScale));
  }
  const hidden = hint && hint.height === 0;
  const audioOnly = !screen && options.audioOnly;
  const active = maxBitrate > 0 && !hidden && !audioOnly;
  const fps = hint?.fps || maxFps;
  return {
    active,
    maxBitrate: maxBitrate || 500000,
    maxFramerate: Math.min(maxFps, fps),
    scaleResolutionDownBy: scale,
  };
};

const adaptBandwidth = (state, sample, now) => {
  const { loss, available, required } = sample;
  const hasLoss = Number.isFinite(loss);
  const hasBitrate = Number.isFinite(available) && available >= 0;
  if (!hasLoss && !hasBitrate) {
    return { ...state, poorSince: null, cleanSince: null };
  }
  const poor = (hasLoss && loss > 0.1) || (hasBitrate && available < required);
  const next = { ...state };
  if (poor) {
    next.cleanSince = null;
    next.poorSince ??= now;
    if (now - next.poorSince >= LOSS_HOLD_MS) {
      next.step = Math.min(3, next.step + 1);
      next.poorSince = now;
    }
  } else {
    next.poorSince = null;
    next.cleanSince ??= now;
    if (now - next.cleanSince >= CLEAN_HOLD_MS) {
      next.step = Math.max(0, next.step - 1);
      next.cleanSince = now;
    }
  }
  return next;
};

const readLinkStats = (reports, previous, required) => {
  let loss = undefined;
  let available = undefined;
  let sent = 0;
  let lost = 0;
  for (const report of reports.values()) {
    if (report.type === 'candidate-pair' && report.state === 'succeeded') {
      if (report.nominated || report.selected) {
        available = report.availableOutgoingBitrate;
      }
    }
    if (report.type === 'outbound-rtp' && report.kind === 'video') {
      sent += report.packetsSent || 0;
    }
    if (report.type !== 'remote-inbound-rtp' || report.kind !== 'video') {
      continue;
    }
    lost += report.packetsLost || 0;
    if (Number.isFinite(report.fractionLost)) {
      loss = Math.max(loss ?? 0, report.fractionLost);
    }
  }
  const sentDelta = sent - (previous?.sent ?? sent);
  const lostDelta = Math.max(0, lost - (previous?.lost ?? lost));
  if (loss === undefined && sentDelta > 0) loss = lostDelta / sentDelta;
  return { loss, available, required, sent, lost };
};

const createSpeakerState = () => ({
  participants: new Map(),
  speaker: '',
  candidate: '',
  candidateSince: -Infinity,
  changedAt: -Infinity,
});

const selectSpeaker = (state, levels, now) => {
  const participants = new Map();
  let loudest = '';
  let loudestLevel = -1;
  for (const entry of levels) {
    const endpoint = entry[0];
    const value = entry[1];
    const level = Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0;
    const previous = state.participants.get(endpoint);
    const above = level > 0.05;
    const same = previous && previous.above === above;
    const since = same ? previous.since : now;
    let speaking = previous?.speaking ?? false;
    const hold = above ? 300 : 800;
    if (now - since >= hold) speaking = above;
    participants.set(endpoint, { level, above, since, speaking });
    const preferred = level === loudestLevel && endpoint === state.speaker;
    if (speaking && (level > loudestLevel || preferred)) {
      loudest = endpoint;
      loudestLevel = level;
    }
  }
  const present = participants.has(state.speaker);
  let speaker = present ? state.speaker : '';
  const sameCandidate = loudest === state.candidate;
  const candidateSince = sameCandidate ? state.candidateSince : now;
  let changedAt = state.changedAt;
  const settled = loudest && now - candidateSince >= 1500;
  if (settled && loudest !== speaker && now - changedAt >= 2000) {
    speaker = loudest;
    changedAt = now;
  }
  return {
    participants,
    speaker,
    candidate: loudest,
    candidateSince,
    changedAt,
  };
};

class LinkMediaPolicy {
  constructor(link) {
    this.link = link;
    this.participants = 2;
    this.hints = new Map();
    this.localAudioOnly = false;
    this.remoteAudioOnly = false;
    this.adaptation = { step: 0, poorSince: null, cleanSince: null };
    this.previous = null;
    this.previousStats = null;
    this.pending = Promise.resolve();
    this.timer = null;
    this.closed = false;
    this.sampling = false;
    this.notices = new Set();
  }

  get audioOnly() {
    return this.localAudioOnly || this.remoteAudioOnly;
  }

  notice(text) {
    if (this.notices.has(text)) return;
    this.notices.add(text);
    this.link.emit('notice', text);
  }

  start() {
    this.refresh();
    this.timer = setInterval(() => this.sample(), 1000);
    this.timer.unref?.();
  }

  stop() {
    this.closed = true;
    clearInterval(this.timer);
    this.timer = null;
  }

  hint(message) {
    const hint = validateHint(message);
    if (!hint) return;
    this.hints.set(hint.slot, hint);
    if (hint.slot === 'camera') this.remoteAudioOnly = hint.audioOnly;
    this.refresh();
  }

  refresh() {
    this.pending = this.applyAfter(this.pending);
    return this.pending;
  }

  async applyAfter(previous) {
    await previous;
    try {
      await this.apply();
    } catch {
      this.notice('The browser could not apply call bandwidth limits.');
    }
  }

  options(slot, sender) {
    const settings = sender?.track?.getSettings?.() ?? {};
    return encodingPolicy({
      slot,
      settings,
      participants: this.participants,
      step: this.adaptation.step,
      hint: this.hints.get(slot),
      audioOnly: this.audioOnly,
    });
  }

  async apply() {
    if (this.closed || !this.link.connected) return;
    const receiver = this.link.receiver('camera');
    if (receiver?.track) receiver.track.enabled = !this.audioOnly;
    for (const slot of ['mic', 'camera', 'screen', 'screenAudio']) {
      const sender = this.link.sender(slot);
      if (!sender) continue;
      const canSet = typeof sender.setParameters === 'function';
      const canGet = typeof sender.getParameters === 'function';
      if (!canSet || !canGet) {
        this.notice('Call bandwidth control is unavailable in this browser.');
        continue;
      }
      const params = sender.getParameters();
      if (!params.encodings?.length) continue;
      const encoding = this.options(slot, sender);
      params.encodings = params.encodings.map((item) => ({
        ...item,
        ...encoding,
      }));
      if (slot === 'camera') params.degradationPreference = 'balanced';
      if (slot === 'screen') {
        params.degradationPreference = 'maintain-resolution';
      }
      try {
        await sender.setParameters(params);
      } catch {
        this.notice('The browser could not apply call bandwidth limits.');
      }
    }
    this.link.emit('quality', {
      audioOnly: this.audioOnly,
      poor: this.adaptation.step > 0,
    });
  }

  async sample() {
    if (this.closed || this.sampling) return;
    const pc = this.link.peerConnection;
    if (typeof pc?.getStats !== 'function') {
      this.notice('Call quality monitoring is unavailable in this browser.');
      return;
    }
    this.sampling = true;
    try {
      const reports = await pc.getStats();
      if (this.closed) return;
      const lanes = new Map();
      const slots = ['mic', 'camera', 'screen', 'screenAudio'];
      for (const slot of slots.concat(['relayAudio', 'relayVideo'])) {
        const sent = this.link.sender(slot)?.track;
        const received = this.link.receiver(slot)?.track;
        if (sent) lanes.set(sent.id, slot);
        if (received) lanes.set(received.id, slot);
      }
      const stats = readCallStats(reports, this.previousStats, lanes);
      this.previousStats = stats;
      this.link.emit('stats', stats);
      let required = 0;
      for (const slot of ['mic', 'camera', 'screen', 'screenAudio']) {
        const sender = this.link.sender(slot);
        if (!sender?.track) continue;
        const policy = this.options(slot, sender);
        if (policy.active) required += policy.maxBitrate;
      }
      const sample = readLinkStats(reports, this.previous, required);
      this.previous = sample;
      const next = adaptBandwidth(this.adaptation, sample, Date.now());
      const changed = next.step !== this.adaptation.step;
      this.adaptation = next;
      if (changed) this.refresh();
    } catch {
      this.notice('The browser could not read call quality.');
    } finally {
      this.sampling = false;
    }
  }
}

class CallLevels extends Emitter {
  constructor(session, media, people) {
    super();
    this.session = session;
    this.media = media;
    this.people = people;
    this.state = createSpeakerState();
    this.levels = new Map();
    this.timer = null;
    this.notices = new Set();
  }

  start() {
    if (this.timer) return;
    this.sample();
    this.timer = setInterval(() => this.sample(), 100);
    this.timer.unref?.();
  }

  notice(text) {
    if (this.notices.has(text)) return;
    this.notices.add(text);
    this.emit('notice', text);
  }

  remoteLevel(endpoint) {
    const receiver = this.session.receiver(endpoint, 'mic');
    if (!receiver) return 0;
    if (typeof receiver.getSynchronizationSources !== 'function') {
      this.notice('Remote speaking detection is unavailable in this browser.');
      return 0;
    }
    try {
      const source = receiver.getSynchronizationSources()[0];
      if (source && !Number.isFinite(source.audioLevel)) {
        this.notice('Remote microphone levels are unavailable.');
      }
      return source?.audioLevel ?? 0;
    } catch {
      this.notice('The browser could not read remote microphone levels.');
      return 0;
    }
  }

  sample(now = performance.now()) {
    const levels = new Map();
    for (const person of this.people()) {
      const endpoint = person.endpoint;
      const local = endpoint === this.session.endpoint;
      const level = local ? this.media.level : this.remoteLevel(endpoint);
      const enabled = local ? this.media.micOn : person.mic !== false;
      levels.set(endpoint, enabled ? level : 0);
    }
    const previous = this.state.speaker;
    this.state = selectSpeaker(this.state, levels, now);
    this.levels = new Map();
    for (const entry of this.state.participants) {
      this.levels.set(entry[0], entry[1].level);
    }
    this.emit('levels', this.levels);
    if (this.state.speaker !== previous) {
      this.emit('speaker', this.state.speaker);
    }
  }

  stop() {
    clearInterval(this.timer);
    this.timer = null;
    this.state = createSpeakerState();
    this.levels.clear();
  }
}

class MediaCapture {
  #context = null;
  #source = null;
  #analyser = null;
  #data = null;
  #frame = 0;
  #listening = false;
  #refreshing = false;
  #cameraGen = 0;
  #micGen = 0;
  #tick = null;
  #onDevice = null;
  #muteTimer = null;
  #screenGen = 0;
  #screenStream = null;
  #onScreenEnd = null;
  #mirror = null;
  #mirrorGen = 0;
  #clock = null;

  constructor(storage = globalThis.localStorage) {
    this.storage = storage;
    this.facing = isMobile() ? 'user' : '';
    this.cameraPaused = false;
    this.noise = 'standard';
    this.cameraId = '';
    this.micId = '';
    this.speakerId = '';
    this.cameras = [];
    this.mics = [];
    this.speakers = [];
    this.cameraTrack = null;
    this.cameraSource = null;
    this.mirrorOn = false;
    this.mirrorState = 'off';
    this.micTrack = null;
    this.screenTrack = null;
    this.screenAudioTrack = null;
    this.screenShared = false;
    this.screenMotion = false;
    this.screenPending = false;
    this.canScreen =
      typeof globalThis.navigator?.mediaDevices?.getDisplayMedia === 'function';
    this.micOn = true;
    this.cameraOn = true;
    this.level = 0;
    this.message = '';
    this.notice = '';
    this.cameraMissing = false;
    this.micMissing = false;
    this.canSink = false;
    this.onChange = null;
    this.onLevel = null;
    this.#tick = () => this.#sample();
    this.#onScreenEnd = () => this.stopScreen();
    this.#onDevice = () => {
      this.refresh().catch(() => this.#notify());
    };
  }

  async openPreview() {
    try {
      await this.start();
      if (this.micOn) await this.openMic();
      if (this.cameraOn) await this.openCamera();
      await this.refresh();
    } catch (error) {
      this.message = messageOf(error);
      this.#notify();
    }
  }

  async start() {
    const saved = readDevices(this.storage);
    this.cameraId = saved.camera;
    this.micId = saved.mic;
    this.speakerId = saved.speaker;
    this.canSink = canSink();
    const devices = globalThis.navigator?.mediaDevices;
    if (devices && !this.#listening) {
      devices.addEventListener('devicechange', this.#onDevice);
      this.#listening = true;
    }
    await this.refresh();
  }

  stop() {
    this.#clearMute();
    this.onChange = null;
    this.onLevel = null;
    this.#cameraGen += 1;
    this.#micGen += 1;
    this.stopScreen();
    const devices = globalThis.navigator?.mediaDevices;
    if (devices && this.#listening) {
      devices.removeEventListener('devicechange', this.#onDevice);
    }
    this.#listening = false;
    this.stopCamera();
    this.useMic(null);
    this.#closeMeter();
  }

  async refresh() {
    if (this.#refreshing) return;
    this.#refreshing = true;
    try {
      const devices = globalThis.navigator?.mediaDevices;
      if (typeof devices?.enumerateDevices !== 'function') return;
      const list = await devices.enumerateDevices();
      this.cameras = list.filter((item) => item.kind === 'videoinput');
      this.mics = list.filter((item) => item.kind === 'audioinput');
      this.speakers = list.filter((item) => item.kind === 'audiooutput');
      this.#reconcile();
    } finally {
      this.#refreshing = false;
      this.#notify();
    }
  }

  async setCamera(id) {
    this.cameraId = id;
    this.cameraMissing = false;
    this.#save();
    if (this.cameraOn) await this.openCamera();
    else this.#notify();
  }

  async switchCamera() {
    const actual = this.cameraTrack?.getSettings?.().facingMode || this.facing;
    this.facing = actual === 'environment' ? 'user' : 'environment';
    this.stopCamera();
    await this.setCamera('');
  }

  async setCameraPaused(paused) {
    if (this.cameraPaused === paused) return;
    this.cameraPaused = paused;
    if (!this.cameraOn) return;
    if (!paused) {
      await this.openCamera();
      return;
    }
    this.#cameraGen++;
    this.stopCamera();
    this.#notify();
  }

  async setNoise(noise) {
    if (this.noise === noise) return;
    this.noise = noise;
    if (this.micTrack) await this.openMic();
  }

  async setMic(id) {
    this.micId = id;
    this.micMissing = false;
    this.#save();
    if (this.micOn) {
      await this.openMic();
    } else {
      this.#micGen++;
      this.useMic(null);
    }
  }

  async setSpeaker(id) {
    this.speakerId = id;
    this.#save();
    this.#notify();
  }

  async toggleMic(release = false) {
    if (this.micOn) {
      this.micOn = false;
      if (release) {
        this.#micGen++;
        this.useMic(null);
        return;
      }
      if (this.micTrack) this.micTrack.enabled = false;
      this.#armMute();
      this.#notify();
      return;
    }
    this.micOn = true;
    this.#clearMute();
    const live = this.micTrack && this.micTrack.readyState === 'live';
    if (live) {
      this.micTrack.enabled = true;
      this.#notify();
      return;
    }
    await this.openMic();
  }

  async toggleCamera() {
    if (this.cameraOn) {
      this.cameraOn = false;
      this.#cameraGen += 1;
      this.stopCamera();
      this.#notify();
      return;
    }
    this.cameraOn = true;
    await this.openCamera();
  }

  async openMic() {
    const generation = this.#micGen + 1;
    this.#micGen = generation;
    try {
      const stream = await capture('audio', {
        audio: micAudio(this.micId, this.noise),
      });
      if (generation !== this.#micGen) return void stopStream(stream);
      const track = stream.getAudioTracks()[0] ?? null;
      this.message = '';
      this.useMic(track);
    } catch (error) {
      if (generation !== this.#micGen) return;
      this.message = messageOf(error);
      this.micOn = false;
      this.useMic(null);
    }
  }

  async openCamera() {
    if (this.cameraPaused) return;
    const generation = this.#cameraGen + 1;
    this.#cameraGen = generation;
    try {
      const video = cameraVideo(this.cameraId, this.facing);
      const stream = await capture('video', { video });
      if (generation !== this.#cameraGen || !this.cameraOn) {
        return void stopStream(stream);
      }
      const source = stream.getVideoTracks()[0] ?? null;
      const wrapped = await this.#wrapCamera(source);
      if (generation !== this.#cameraGen || !this.cameraOn) {
        wrapped.mirror?.stop();
        source?.stop();
        return;
      }
      this.message = '';
      this.#useWrapped(source, wrapped);
    } catch (error) {
      if (generation !== this.#cameraGen) return;
      this.message = messageOf(error);
      this.cameraOn = false;
      this.useCamera(null);
    }
  }

  async setMirror(on) {
    if (this.mirrorOn === on) return;
    this.mirrorOn = on;
    const source = this.cameraSource;
    if (!source || source.readyState !== 'live') {
      this.mirrorState = on ? '' : 'off';
      this.#notify();
      return;
    }
    const generation = ++this.#mirrorGen;
    const wrapped = await this.#wrapCamera(source);
    const current = generation === this.#mirrorGen;
    if (!current || this.cameraSource !== source) {
      wrapped.mirror?.stop();
      return;
    }
    this.#useWrapped(source, wrapped);
  }

  stopCamera() {
    this.#mirrorGen++;
    const source = this.cameraSource;
    this.cameraSource = null;
    this.cameraTrack = null;
    this.#stopMirror();
    this.#releaseClock();
    this.mirrorState = this.mirrorOn ? '' : 'off';
    if (source) source.stop();
  }

  async #wrapCamera(source) {
    const raw = { track: source, mirror: null, state: 'off' };
    if (!source || !this.mirrorOn) return raw;
    try {
      const needClock = pathOf(capabilitiesOf()) === 'canvas';
      const clock = needClock ? this.#clockWorker() : undefined;
      const mirror = await createMirror(source, { clock });
      return { track: mirror.track, mirror, state: mirror.path };
    } catch {
      this.notice = MIRROR_NOTICE;
      return { track: source, mirror: null, state: 'failed' };
    }
  }

  #useWrapped(source, wrapped) {
    const previous = this.#mirror;
    const old = this.cameraSource;
    this.#mirror = wrapped.mirror;
    this.cameraSource = source;
    this.cameraTrack = wrapped.track;
    this.mirrorState = wrapped.state;
    if (wrapped.state !== 'failed' && this.notice === MIRROR_NOTICE) {
      this.notice = '';
    }
    previous?.stop();
    if (old && old !== source) old.stop();
    this.#notify();
  }

  #stopMirror() {
    const mirror = this.#mirror;
    this.#mirror = null;
    mirror?.stop();
  }

  #clockWorker() {
    if (this.#clock) return this.#clock;
    const worker = new Worker(CLOCK_URL);
    worker.postMessage({ type: 'start', fps: CLOCK_FPS });
    this.#clock = worker;
    return worker;
  }

  #releaseClock() {
    const worker = this.#clock;
    this.#clock = null;
    if (!worker) return;
    worker.postMessage({ type: 'stop' });
    worker.terminate();
  }

  async openScreen(shared = true) {
    if (this.screenPending) return;
    if (this.screenTrack?.readyState === 'live') {
      this.screenShared = shared;
      this.#notify();
      return;
    }
    if (!this.canScreen) {
      this.message = 'Screen capture is unavailable in this browser.';
      this.#notify();
      return;
    }
    const generation = this.#screenGen + 1;
    this.#screenGen = generation;
    this.screenPending = true;
    this.message = '';
    this.notice = '';
    this.#notify();
    let stream = null;
    try {
      const Controller = globalThis.CaptureController;
      const controller =
        typeof Controller === 'function' ? new Controller() : null;
      const ideal = this.screenMotion ? 30 : 15;
      const frameRate = { ideal, max: 30 };
      const video = { ...SCREEN.video, frameRate };
      const options = { ...SCREEN, video };
      if (controller) options.controller = controller;
      stream = await globalThis.navigator.mediaDevices.getDisplayMedia(options);
      if (generation !== this.#screenGen) return void stopStream(stream);
      const track = stream.getVideoTracks()[0] ?? null;
      if (!track || track.readyState !== 'live') {
        throw new Error('No live screen video was returned.');
      }
      this.#focusScreen(controller, track);
      this.#screenStream = stream;
      this.screenTrack = track;
      this.screenAudioTrack = stream.getAudioTracks()[0] ?? null;
      this.screenShared = shared;
      track.addEventListener('ended', this.#onScreenEnd);
      await this.#screenQuality(track);
    } catch (error) {
      stopStream(stream);
      if (generation !== this.#screenGen) return;
      this.stopScreen();
      this.message =
        SCREEN_MESSAGES[error?.name] ?? 'Could not capture the screen.';
    } finally {
      if (generation === this.#screenGen) this.screenPending = false;
      this.#notify();
    }
  }

  stopScreen() {
    this.#screenGen += 1;
    this.screenTrack?.removeEventListener('ended', this.#onScreenEnd);
    const stream = this.#screenStream;
    this.#screenStream = null;
    this.screenTrack = null;
    this.screenAudioTrack = null;
    this.screenShared = false;
    this.screenPending = false;
    stopStream(stream);
    this.#notify();
  }

  async toggleScreenMotion() {
    this.screenMotion = !this.screenMotion;
    if (this.screenTrack) await this.#screenQuality(this.screenTrack);
    this.#notify();
  }

  #focusScreen(controller, track) {
    const surface = track.getSettings?.().displaySurface;
    const canFocus = typeof controller?.setFocusBehavior === 'function';
    if (!canFocus) {
      this.notice = 'Screen focus control is unavailable in this browser.';
      return;
    }
    if (surface !== 'browser' && surface !== 'window') return;
    try {
      controller.setFocusBehavior('no-focus-change');
    } catch {
      this.notice = 'The browser could not keep the call in front.';
    }
  }

  async #screenQuality(track) {
    if ('contentHint' in track) {
      track.contentHint = this.screenMotion ? 'motion' : 'detail';
    } else {
      this.notice = 'Screen content hints are unavailable in this browser.';
    }
    if (typeof track.applyConstraints !== 'function') {
      this.notice = 'Screen frame rate control is unavailable.';
      return;
    }
    const ideal = this.screenMotion ? 30 : 15;
    try {
      await track.applyConstraints({ frameRate: { ideal, max: 30 } });
    } catch {
      this.notice = 'The browser could not apply the screen frame rate.';
    }
  }

  previewStream() {
    const track = this.cameraTrack;
    const Stream = globalThis.MediaStream;
    const live = track && track.readyState === 'live' && this.cameraOn;
    if (!live || !Stream) return null;
    return new Stream([track]);
  }

  async applySink(element) {
    if (!this.canSink || typeof element?.setSinkId !== 'function') return;
    try {
      await element.setSinkId(this.speakerId);
    } catch {
      this.notice = 'That speaker is not available.';
    }
  }

  resume() {
    const context = this.#context;
    if (context?.state === 'suspended') context.resume();
  }

  useMic(track) {
    this.#clearMute();
    const previous = this.micTrack;
    if (previous && previous !== track) previous.stop();
    this.micTrack = track;
    if (track) track.enabled = this.micOn;
    try {
      this.#bindMeter(track);
    } catch {
      this.#closeMeter();
      this.notice = 'Local speaking detection is unavailable in this browser.';
    }
    if (track && !this.micOn) this.#armMute();
    this.#notify();
  }

  useCamera(track) {
    if (!track) this.stopCamera();
    this.#notify();
  }

  #armMute() {
    this.#clearMute();
    const timer = setTimeout(() => this.#stopMuted(), MUTE_STOP_MS);
    if (typeof timer.unref === 'function') timer.unref();
    this.#muteTimer = timer;
  }

  #clearMute() {
    const timer = this.#muteTimer;
    this.#muteTimer = null;
    if (timer) clearTimeout(timer);
  }

  #stopMuted() {
    this.#muteTimer = null;
    if (this.micOn) return;
    this.useMic(null);
  }

  #save() {
    const camera = this.cameraId;
    const mic = this.micId;
    const speaker = this.speakerId;
    writeDevices(this.storage, { camera, mic, speaker });
  }

  #reconcile() {
    const cameraGone = missingId(this.cameras, this.cameraId);
    const micGone = missingId(this.mics, this.micId);
    const speakerGone = missingId(this.speakers, this.speakerId);
    if (cameraGone) {
      this.cameraId = '';
      this.cameraMissing = true;
      this.cameraOn = false;
      this.notice = 'Saved camera is missing. Using the default.';
      this.#cameraGen += 1;
      this.stopCamera();
    }
    if (micGone) {
      this.micId = '';
      this.micMissing = true;
      this.micOn = false;
      this.notice = 'Saved microphone is missing. Using the default.';
      this.#micGen += 1;
      this.useMic(null);
    }
    if (speakerGone) {
      this.speakerId = '';
      this.notice = 'Saved speaker is missing. Using the default.';
    }
    if (cameraGone || micGone || speakerGone) this.#save();
  }

  #bindMeter(track) {
    this.#closeMeter();
    this.level = 0;
    if (!track) return;
    const Context = globalThis.AudioContext ?? globalThis.webkitAudioContext;
    const Stream = globalThis.MediaStream;
    if (!Context || !Stream) {
      this.notice = 'Local speaking detection is unavailable in this browser.';
      return;
    }
    const context = new Context();
    this.#context = context;
    const source = context.createMediaStreamSource(new Stream([track]));
    this.#source = source;
    const analyser = context.createAnalyser();
    analyser.fftSize = 256;
    source.connect(analyser);
    this.#analyser = analyser;
    this.#data = new Uint8Array(analyser.fftSize);
    this.#frame = setTimeout(this.#tick, 100);
    if (context.state === 'suspended') {
      context.resume().catch(() => undefined);
    }
  }

  #closeMeter() {
    clearTimeout(this.#frame);
    this.#frame = 0;
    this.#source?.disconnect();
    this.#source = null;
    this.#analyser = null;
    this.#data = null;
    const context = this.#context;
    this.#context = null;
    if (context) context.close().catch(() => undefined);
  }

  #sample() {
    const analyser = this.#analyser;
    const data = this.#data;
    if (!analyser || !data) return;
    analyser.getByteTimeDomainData(data);
    let sum = 0;
    for (let i = 0; i < data.length; i++) {
      const sample = (data[i] - 128) / 128;
      sum += sample * sample;
    }
    const mean = data.length === 0 ? 0 : sum / data.length;
    this.level = Math.min(1, Math.sqrt(mean));
    if (this.onLevel) this.onLevel(this.level);
    if (this.#analyser !== analyser) return;
    this.#frame = setTimeout(this.#tick, 100);
  }

  #notify() {
    if (this.onChange) this.onChange();
  }
}

export { CAMERA, CAMERA_MOBILE, MIC, SCREEN, MediaCapture };
export { BANDWIDTH_ROWS, CODECS, LOSS_HOLD_MS, CLEAN_HOLD_MS };
export { bandwidthRow, validateHint, encodingPolicy, adaptBandwidth };
export { readLinkStats, LinkMediaPolicy };
export { createSpeakerState, selectSpeaker, CallLevels };

export {
  readDevices,
  writeDevices,
  canSink,
  isMobile,
  pausesCameraInBackground,
};
