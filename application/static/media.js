import { jsonParse } from './metautil.js';

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

const DEVICES_KEY = 'xxii:devices';
const MOBILE = '(pointer: coarse)';
const MUTE_STOP_MS = 30000;

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

const cameraVideo = (deviceId) => {
  const video = isMobile() ? { ...CAMERA_MOBILE } : { ...CAMERA };
  if (deviceId) video.deviceId = { exact: deviceId };
  return video;
};

const micAudio = (deviceId) => {
  const audio = { ...MIC };
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

  constructor(storage = globalThis.localStorage) {
    this.storage = storage;
    this.cameraId = '';
    this.micId = '';
    this.speakerId = '';
    this.cameras = [];
    this.mics = [];
    this.speakers = [];
    this.cameraTrack = null;
    this.micTrack = null;
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
    this.#onDevice = () => {
      this.refresh().catch(() => this.#notify());
    };
  }

  async openPreview() {
    try {
      await this.start();
      await this.openMic();
      await this.openCamera();
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

  async setMic(id) {
    this.micId = id;
    this.micMissing = false;
    this.#save();
    if (this.micOn) await this.openMic();
    else this.#notify();
  }

  async setSpeaker(id) {
    this.speakerId = id;
    this.#save();
    this.#notify();
  }

  async toggleMic() {
    if (this.micOn) {
      this.micOn = false;
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
      const stream = await capture('audio', { audio: micAudio(this.micId) });
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
    const generation = this.#cameraGen + 1;
    this.#cameraGen = generation;
    try {
      const video = cameraVideo(this.cameraId);
      const stream = await capture('video', { video });
      if (generation !== this.#cameraGen || !this.cameraOn) {
        return void stopStream(stream);
      }
      const track = stream.getVideoTracks()[0] ?? null;
      this.message = '';
      this.useCamera(track);
    } catch (error) {
      if (generation !== this.#cameraGen) return;
      this.message = messageOf(error);
      this.cameraOn = false;
      this.useCamera(null);
    }
  }

  stopCamera() {
    const track = this.cameraTrack;
    this.cameraTrack = null;
    if (track) track.stop();
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
    this.#bindMeter(track);
    this.#notify();
  }

  useCamera(track) {
    const previous = this.cameraTrack;
    if (previous && previous !== track) previous.stop();
    this.cameraTrack = track;
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
    if (!Context || !Stream) return;
    const context = new Context();
    const source = context.createMediaStreamSource(new Stream([track]));
    const analyser = context.createAnalyser();
    analyser.fftSize = 256;
    source.connect(analyser);
    this.#context = context;
    this.#source = source;
    this.#analyser = analyser;
    this.#data = new Uint8Array(analyser.fftSize);
    const frame = globalThis.requestAnimationFrame;
    if (frame) this.#frame = frame(this.#tick);
    if (context.state === 'suspended') {
      context.resume().catch(() => undefined);
    }
  }

  #closeMeter() {
    const cancel = globalThis.cancelAnimationFrame;
    if (cancel) cancel(this.#frame);
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
    this.level = Math.min(1, Math.sqrt(mean) * 3);
    if (this.onLevel) this.onLevel(this.level);
    if (this.#analyser !== analyser) return;
    const frame = globalThis.requestAnimationFrame;
    if (frame) this.#frame = frame(this.#tick);
  }

  #notify() {
    if (this.onChange) this.onChange();
  }
}

export { CAMERA, CAMERA_MOBILE, MIC, MediaCapture };
