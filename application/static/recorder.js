import { Emitter } from './metautil.js';
import { createMeta, POSTER_MS } from './recording-files.js';

const WORKER_URL = new URL('./recording-worker.js', import.meta.url);
const TIMESLICE_MS = 1000;
const AUDIO_BITS = 128000;
const KEY_FRAME_MS = 2000;
const POSTER_TYPE = 'image/jpeg';
const POSTER_QUALITY = 0.8;

const FORMATS = [
  { mime: 'video/mp4;codecs=avc1.640028,mp4a.40.2', extension: 'mp4' },
  { mime: 'video/mp4;codecs=avc1.640028,opus', extension: 'mp4' },
  { mime: 'video/webm;codecs=vp9,opus', extension: 'webm' },
  { mime: 'video/webm;codecs=vp8,opus', extension: 'webm' },
];

const formatOf = (isSupported, formats = FORMATS) => {
  for (const format of formats) {
    if (isSupported(format.mime)) return format;
  }
  return null;
};

const optionsOf = (format, quality) => ({
  mimeType: format.mime,
  videoBitsPerSecond: quality.bitsPerSecond,
  audioBitsPerSecond: AUDIO_BITS,
  videoKeyFrameIntervalDuration: KEY_FRAME_MS,
});

const ignore = () => undefined;

class ChunkQueue {
  #tail = Promise.resolve();
  #send = null;
  #onError = null;

  constructor(send, onError) {
    this.#send = send;
    this.#onError = onError;
    this.error = null;
  }

  push(blob, duration) {
    const run = async () => {
      if (this.error) return;
      try {
        const chunk = await blob.arrayBuffer();
        await this.#send(chunk, duration);
      } catch (error) {
        this.error = error;
        this.#onError(error);
      }
    };
    this.#tail = this.#tail.then(run);
  }

  drain() {
    return this.#tail;
  }
}

class RecordingWriter {
  #worker = null;
  #pending = new Map();
  #next = 0;
  #onMessage = null;
  #onError = null;

  constructor(worker = null) {
    this.#worker = worker ?? new Worker(WORKER_URL, { type: 'module' });
    this.#onMessage = ({ data }) => this.#settle(data);
    this.#onError = (event) => {
      const message = event?.message || 'The recording worker failed';
      this.#reject(new Error(message));
    };
    this.#worker.addEventListener('message', this.#onMessage);
    this.#worker.addEventListener('error', this.#onError);
  }

  open(recording, meta) {
    return this.#request({ type: 'open', recording, meta });
  }

  async write(recording, chunk, duration) {
    const message = { type: 'write', recording, chunk, duration };
    const reply = await this.#request(message, [chunk]);
    return reply.size;
  }

  pause(recording) {
    return this.#request({ type: 'pause', recording });
  }

  resume(recording) {
    return this.#request({ type: 'resume', recording });
  }

  repair() {
    return this.#request({ type: 'repair' });
  }

  poster(recording, bytes) {
    return this.#request({ type: 'poster', recording, bytes }, [bytes]);
  }

  async close(recording, duration, people) {
    const message = { type: 'close', recording, duration, people };
    const reply = await this.#request(message);
    return reply.meta;
  }

  async abort(recording, duration) {
    const message = { type: 'abort', recording, duration };
    const reply = await this.#request(message);
    return reply.meta;
  }

  stop() {
    if (!this.#worker) return;
    this.#worker.removeEventListener('message', this.#onMessage);
    this.#worker.removeEventListener('error', this.#onError);
    this.#worker.terminate();
    this.#worker = null;
    this.#reject(new Error('The recording worker stopped'));
  }

  #request(message, transfer = []) {
    const worker = this.#worker;
    if (!worker) return Promise.reject(new Error('The writer is stopped'));
    const request = ++this.#next;
    return new Promise((resolve, reject) => {
      this.#pending.set(request, { resolve, reject });
      worker.postMessage({ ...message, request }, transfer);
    });
  }

  #settle(data) {
    const entry = this.#pending.get(data.request);
    if (!entry) return;
    this.#pending.delete(data.request);
    if (data.ok) return void entry.resolve(data);
    const error = new Error(data.error);
    if (data.name) error.name = data.name;
    entry.reject(error);
  }

  #reject(error) {
    const entries = Array.from(this.#pending.values());
    this.#pending.clear();
    for (const entry of entries) entry.reject(error);
  }
}

class Recorder extends Emitter {
  #compositor = null;
  #mixer = null;
  #writer = null;
  #quality = null;
  #formats = null;
  #Recording = null;
  #streamOf = null;
  #now = null;
  #recorder = null;
  #queue = null;
  #listeners = null;
  #meta = null;
  #stopping = null;
  #posterTimer = 0;
  #poster = null;
  #accrued = 0;
  #since = 0;

  constructor(options) {
    super();
    const { compositor, mixer, writer, quality } = options;
    this.#compositor = compositor;
    this.#mixer = mixer;
    this.#writer = writer;
    this.#quality = quality;
    this.#formats = options.formats ?? FORMATS;
    this.#Recording = options.Recording ?? null;
    this.#streamOf = options.streamOf ?? ((tracks) => new MediaStream(tracks));
    this.#now = options.now ?? (() => Date.now());
    this.state = 'idle';
    this.format = null;
    this.id = '';
    this.size = 0;
    this.error = null;
  }

  get activeMs() {
    const isRunning = this.state === 'recording';
    return this.#accrued + (isRunning ? this.#now() - this.#since : 0);
  }

  get meta() {
    return this.#meta;
  }

  async start(info) {
    if (this.state !== 'idle') return this.#meta;
    const Recording = this.#Recording ?? globalThis.MediaRecorder;
    if (typeof Recording !== 'function') {
      throw new Error('Recording is unavailable in this browser');
    }
    const isSupported = (mime) => Recording.isTypeSupported(mime);
    const format = formatOf(isSupported, this.#formats);
    if (!format) throw new Error('This browser cannot record video');
    const tracks = [this.#compositor.track, this.#mixer.track];
    const options = optionsOf(format, this.#quality);
    const recorder = new Recording(this.#streamOf(tracks), options);
    const { mime, extension } = format;
    const meta = createMeta({ ...info, mime, extension });
    await this.#writer.open(meta.id, meta);
    this.format = format;
    this.id = meta.id;
    this.#meta = meta;
    this.#recorder = recorder;
    const send = (chunk, duration) => this.#store(chunk, duration);
    this.#queue = new ChunkQueue(send, (error) => this.#fail(error));
    this.#listen(recorder);
    try {
      recorder.start(TIMESLICE_MS);
    } catch (error) {
      this.#unlisten(recorder);
      await this.#writer.abort(meta.id, 0).catch(ignore);
      throw error;
    }
    this.#since = this.#now();
    this.#setState('recording');
    this.#posterTimer = setTimeout(() => this.#takePoster(), POSTER_MS);
    return meta;
  }

  pause() {
    if (this.state !== 'recording') return;
    this.#accrued += this.#now() - this.#since;
    this.#recorder.pause();
    this.#setState('paused');
    this.#writer.pause(this.id).catch((error) => this.#fail(error));
  }

  resume() {
    if (this.state !== 'paused') return;
    this.#since = this.#now();
    this.#recorder.resume();
    this.#setState('recording');
    this.#writer.resume(this.id).catch((error) => this.#fail(error));
  }

  stop(extra = {}) {
    const isOpen = this.state === 'recording' || this.state === 'paused';
    if (!isOpen) return Promise.resolve(this.#meta);
    this.#stopping ??= this.#finish(extra);
    return this.#stopping;
  }

  async #store(chunk, duration) {
    this.size = await this.#writer.write(this.id, chunk, duration);
    this.emit('progress', { size: this.size, duration });
  }

  #listen(recorder) {
    const onData = ({ data }) => {
      if (data.size > 0) this.#queue.push(data, this.activeMs);
    };
    const onError = (event) => {
      this.#fail(event.error ?? new Error('The recorder failed'));
    };
    recorder.addEventListener('dataavailable', onData);
    recorder.addEventListener('error', onError);
    this.#listeners = { onData, onError };
  }

  #unlisten(recorder) {
    const listeners = this.#listeners;
    if (!listeners) return;
    recorder.removeEventListener('dataavailable', listeners.onData);
    recorder.removeEventListener('error', listeners.onError);
    this.#listeners = null;
  }

  #setState(state) {
    this.state = state;
    this.emit('state', state);
  }

  #fail(error) {
    if (this.error) return;
    this.error = error;
    this.emit('failure', error);
    this.stop().catch(ignore);
  }

  #takePoster() {
    this.#poster ??= this.#savePoster();
    return this.#poster;
  }

  async #savePoster() {
    try {
      const canvas = this.#compositor.canvas;
      const blob = await new Promise((resolve) => {
        canvas.toBlob(resolve, POSTER_TYPE, POSTER_QUALITY);
      });
      if (!blob) return;
      const bytes = await blob.arrayBuffer();
      await this.#writer.poster(this.id, bytes);
    } catch {
      return;
    }
  }

  async #finish(extra) {
    const recorder = this.#recorder;
    if (this.state === 'recording') this.#accrued += this.#now() - this.#since;
    clearTimeout(this.#posterTimer);
    const isActive = recorder.state !== 'inactive';
    const stopped = new Promise((resolve) => {
      if (!isActive) return void resolve();
      recorder.addEventListener('stop', resolve, { once: true });
    });
    if (isActive) recorder.stop();
    await stopped;
    try {
      await this.#queue.drain();
      await this.#takePoster();
      const duration = this.#accrued;
      const id = this.id;
      const failed = this.#queue.error !== null;
      const people = extra.people;
      const meta = failed
        ? await this.#writer.abort(id, duration)
        : await this.#writer.close(id, duration, people);
      this.#meta = meta;
      return meta;
    } finally {
      this.#unlisten(recorder);
      this.#setState('stopped');
    }
  }
}

export { FORMATS, formatOf, optionsOf, ChunkQueue };
export { RecordingWriter, Recorder };
