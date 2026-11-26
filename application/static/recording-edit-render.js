import { FORMATS, formatOf, optionsOf, ChunkQueue } from './recorder.js';
import { PartPlayer, playUntil } from './recording-edit-media.js';
import { segmentsOf } from './recording-edit-logic.js';

const CHUNK_MS = 1000;
const MAX_QUEUED_BYTES = 64 * 1024 * 1024;

const videoOnly = (format) => ({
  ...format,
  mime: format.mime.split(',')[0],
});

const editFormatOf = (audio, formats = FORMATS) => {
  if (typeof globalThis.MediaRecorder !== 'function') return null;
  const choices = audio ? formats : formats.map(videoOnly);
  return formatOf(
    (mime) => globalThis.MediaRecorder.isTypeSupported(mime),
    choices,
  );
};

const drawFrame = (context, video) => {
  const { width, height } = context.canvas;
  const scale = Math.min(
    1,
    width / video.videoWidth,
    height / video.videoHeight,
  );
  const w = Math.round(video.videoWidth * scale);
  const h = Math.round(video.videoHeight * scale);
  context.fillRect(0, 0, width, height);
  context.drawImage(video, (width - w) / 2, (height - h) / 2, w, h);
};

const posterOf = (canvas) =>
  new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => {
        if (blob) {
          resolve(blob);
        } else {
          reject(new Error('Could not create a poster for the edited copy.'));
        }
      },
      'image/jpeg',
      0.8,
    );
  });

const recordSegment = async (segment, media, onTime, signal) => {
  const { player, context, track, gain, audio, recorder } = media;
  const { part, start, end, output } = segment;
  await player.seek(part, start, signal);
  const video = player.video;
  let frame = null;
  const draw = () => {
    track.requestFrame();
    drawFrame(context, video);
  };
  const next = (now, { mediaTime }) => {
    if (mediaTime >= end / 1000) return;
    draw();
    frame = video.requestVideoFrameCallback(next);
  };
  const onStart = () => {
    if (recorder.state === 'inactive') recorder.start(CHUNK_MS);
    else recorder.resume();
    draw();
    frame = video.requestVideoFrameCallback(next);
    if (audio) {
      const time = audio.currentTime;
      const left = Math.max(0, end / 1000 - video.currentTime);
      gain.gain.setValueAtTime(1, time);
      gain.gain.setValueAtTime(0, time + left);
    }
  };
  try {
    await playUntil(video, end, signal, onStart, (time) => {
      onTime(output + Math.max(0, time - start));
    });
  } finally {
    if (frame !== null) video.cancelVideoFrameCallback(frame);
    if (audio) {
      gain.gain.cancelScheduledValues(audio.currentTime);
      gain.gain.setValueAtTime(0, audio.currentTime);
    }
    if (recorder.state === 'recording') recorder.pause();
  }
};

const renderEdit = async (options) => {
  const { parts, timeline, source, format, signal, write } = options;
  const abort = new AbortController();
  const active = AbortSignal.any([signal, abort.signal]);
  active.throwIfAborted();
  const video = document.createElement('video');
  video.playsInline = true;
  video.preload = 'auto';
  const player = new PartPlayer(video, source);
  const canvas = document.createElement('canvas');
  const segments = segmentsOf(parts, timeline.kept);
  const { width, height } = segments[0].part;
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d');
  if (!context || !canvas.captureStream || !video.requestVideoFrameCallback) {
    throw new Error('This browser cannot render an edited recording.');
  }
  const stream = canvas.captureStream(0);
  const [track] = stream.getVideoTracks();
  let recorder = null;
  let audio = null;
  let gain = null;
  let stopped = null;
  let time = 0;
  let pending = 0;
  const onTime = (current) => {
    time = current;
    options.progress?.(Math.floor(current), timeline.duration);
  };
  const queue = new ChunkQueue(
    async (chunk, duration) => {
      active.throwIfAborted();
      const length = chunk.byteLength;
      await write(chunk, duration);
      pending -= length;
    },
    (error) => abort.abort(error),
  );
  const visible = () => {
    if (document.hidden) {
      abort.abort(new Error('Keep this tab visible while saving. Try again.'));
    }
  };
  document.addEventListener('visibilitychange', visible, { signal: active });
  try {
    visible();
    active.throwIfAborted();
    if (!track?.requestFrame) {
      throw new Error('This browser cannot capture edited video frames.');
    }
    if (segments.some(({ part }) => part.audio)) {
      audio = new globalThis.AudioContext();
      const destination = audio.createMediaStreamDestination();
      gain = audio.createGain();
      gain.gain.value = 0;
      audio.createMediaElementSource(video).connect(gain).connect(destination);
      stream.addTrack(destination.stream.getAudioTracks()[0]);
      await audio.resume();
    } else {
      video.muted = true;
    }
    const bitsPerSecond = Math.max(
      1000000,
      Math.min(18000000, width * height * 5),
    );
    recorder = new globalThis.MediaRecorder(
      stream,
      optionsOf(format, { bitsPerSecond }),
    );
    recorder.addEventListener('error', (event) => {
      abort.abort(event.error ?? new Error('The video encoder failed.'));
    });
    recorder.addEventListener('dataavailable', ({ data }) => {
      if (active.aborted || !data.size) return;
      pending += data.size;
      if (pending > MAX_QUEUED_BYTES) {
        abort.abort(
          new Error('Browser storage could not keep up with the video.'),
        );
        return;
      }
      queue.push(data, Math.round(time));
    });
    await player.seek(segments[0].part, segments[0].start, active);
    drawFrame(context, video);
    const poster = await posterOf(canvas);
    const media = { player, context, track, recorder, audio, gain };
    for (const segment of segments) {
      await recordSegment(segment, media, onTime, active);
    }
    onTime(timeline.duration);
    stopped = new Promise((resolve) => {
      recorder.addEventListener('stop', resolve, { once: true });
    });
    recorder.stop();
    await stopped;
    await queue.drain();
    active.throwIfAborted();
    return { poster, mime: recorder.mimeType || format.mime };
  } finally {
    if (recorder && recorder.state !== 'inactive') recorder.stop();
    player.clear();
    for (const track of stream.getTracks()) track.stop();
    await audio?.close().catch(() => {});
    await queue.drain();
    abort.abort();
  }
};

export { editFormatOf, renderEdit };
