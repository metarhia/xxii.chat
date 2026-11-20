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

const unlisten = ({ recorder, onData, onError }) => {
  recorder.removeEventListener('dataavailable', onData);
  recorder.removeEventListener('error', onError);
};

const drainPart = async (part) => {
  const { recorder, queue } = part;
  const isActive = recorder.state !== 'inactive';
  const stopped = new Promise((resolve) => {
    if (!isActive) return void resolve();
    recorder.addEventListener('stop', resolve, { once: true });
  });
  try {
    if (isActive) recorder.stop();
    await stopped;
  } finally {
    unlisten(part);
  }
  await queue.drain();
};

class ChunkQueue {
  #tail = null;
  #send = null;
  #onError = null;

  constructor(send, onError, ready = Promise.resolve()) {
    this.#send = send;
    this.#onError = onError;
    this.#tail = ready;
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

  open(recording, meta, folder) {
    return this.#request({ type: 'open', recording, meta, folder });
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

  async segment(recording, duration) {
    const reply = await this.#request({ type: 'segment', recording, duration });
    return reply.meta;
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
      try {
        worker.postMessage({ ...message, request }, transfer);
      } catch (error) {
        this.#pending.delete(request);
        reject(error);
      }
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
  #folder = null;
  #folderName = '';
  #segmentMs = 0;
  #segmentTimer = 0;
  #makeRecorder = null;
  #part = null;
  #meta = null;
  #stopping = null;
  #posterTimer = 0;
  #poster = null;
  #accrued = 0;
  #since = null;

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
    this.#now = options.now ?? (() => performance.now());
    this.#folder = options.folder;
    this.#folderName = options.folderName || this.#folder?.name || 'Folder';
    this.#segmentMs = options.segmentMs ?? 0;
    this.state = 'idle';
    this.format = null;
    this.id = '';
    this.size = 0;
    this.error = null;
  }

  get activeMs() {
    const isRunning = this.#since !== null;
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
    const stream = this.#streamOf(tracks);
    this.#makeRecorder = () => new Recording(stream, options);
    const recorder = this.#makeRecorder();
    const { mime, extension } = format;
    const folder = this.#folder;
    const folderName = folder ? this.#folderName : '';
    const meta = createMeta({ ...info, mime, extension, folder: folderName });
    await this.#writer.open(meta.id, meta, folder);
    this.format = format;
    this.id = meta.id;
    this.#meta = meta;
    this.#part = this.#listen(recorder, 0);
    try {
      recorder.start(TIMESLICE_MS);
    } catch (error) {
      unlisten(this.#part);
      await this.#writer.abort(meta.id, 0).catch(ignore);
      throw error;
    }
    this.#since = this.#now();
    this.#setState('recording');
    this.#scheduleSegment();
    this.#posterTimer = setTimeout(() => this.#takePoster(), POSTER_MS);
    return meta;
  }

  pause() {
    if (this.state !== 'recording' || this.#stopping) return;
    this.#freeze();
    this.#part.recorder.pause();
    this.#setState('paused');
    this.#writer.pause(this.id).catch((error) => this.#fail(error));
  }

  resume() {
    if (this.state !== 'paused' || this.#stopping) return;
    this.#since = this.#now();
    this.#part.recorder.resume();
    this.#setState('recording');
    this.#scheduleSegment();
    this.#writer.resume(this.id).catch((error) => this.#fail(error));
  }

  stop(extra = {}) {
    const isOpen = this.state === 'recording' || this.state === 'paused';
    if (!isOpen) return Promise.resolve(this.#meta);
    this.#stopping ??= this.#finish(extra);
    return this.#stopping;
  }

  async #store(chunk, duration) {
    if (this.#folder && this.error) return;
    this.size = await this.#writer.write(this.id, chunk, duration);
    this.emit('progress', { size: this.size, duration });
  }

  #listen(recorder, started, ready) {
    const send = (chunk, duration) => this.#store(chunk, duration);
    const queue = new ChunkQueue(send, (error) => this.#fail(error), ready);
    const part = { recorder, queue, started, ended: null };
    const onData = ({ data }) => {
      const duration = part.ended ?? this.activeMs;
      if (data.size > 0) queue.push(data, duration);
      if (part === this.#part) this.#rollover(duration);
    };
    const onError = (event) => {
      this.#fail(event.error ?? new Error('The recorder failed'));
    };
    recorder.addEventListener('dataavailable', onData);
    recorder.addEventListener('error', onError);
    return Object.assign(part, { onData, onError });
  }

  #freeze() {
    this.#accrued = this.activeMs;
    this.#since = null;
    clearTimeout(this.#segmentTimer);
  }

  #scheduleSegment() {
    if (!this.#segmentMs || this.#since === null) return;
    clearTimeout(this.#segmentTimer);
    const deadline = this.#part.started + this.#segmentMs;
    const remaining = Math.max(0, deadline - this.activeMs);
    this.#segmentTimer = setTimeout(() => {
      this.#rollover(this.activeMs);
      if (this.#part.started < deadline) this.#scheduleSegment();
    }, remaining);
  }

  #rollover(active) {
    if (!this.#segmentMs || this.#since === null || this.error) return;
    const previous = this.#part;
    const duration = active - previous.started;
    if (duration < this.#segmentMs) return;
    try {
      const ready = Promise.withResolvers();
      const recorder = this.#makeRecorder();
      const next = this.#listen(recorder, active, ready.promise);
      try {
        recorder.start(TIMESLICE_MS);
      } catch (error) {
        unlisten(next);
        throw error;
      }
      this.#part = next;
      previous.ended = active;
      drainPart(previous)
        .then(async () => {
          if (!this.error) {
            this.#meta = await this.#writer.segment(this.id, duration);
          }
        })
        .catch((error) => this.#fail(error))
        .finally(ready.resolve);
      this.#scheduleSegment();
    } catch (error) {
      this.#fail(error);
    }
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
    const part = this.#part;
    this.#freeze();
    clearTimeout(this.#posterTimer);
    try {
      await drainPart(part);
      await this.#takePoster();
      const duration = this.#accrued;
      const id = this.id;
      const failed = part.queue.error !== null || (this.#folder && this.error);
      const people = extra.people;
      const meta = failed
        ? await this.#writer.abort(id, duration)
        : await this.#writer.close(id, duration, people);
      this.#meta = meta;
      return meta;
    } finally {
      this.#setState('stopped');
    }
  }
}

export { FORMATS, formatOf, optionsOf, ChunkQueue };
export { RecordingWriter, Recorder };
