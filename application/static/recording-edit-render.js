import { FORMATS, formatOf, optionsOf, ChunkQueue } from './recorder.js';
import { PartPlayer, playUntil } from './recording-edit-media.js';
import { segmentsOf } from './recording-edit-logic.js';
import { editOptionsOf, outputFrameOf } from './video-edit-options.js';
import { drawVideoFrame, encodingOf } from './video-edit-options.js';

const CHUNK_MS = 1000;
const MAX_QUEUED_BYTES = 64 * 1024 * 1024;
const AUDIO_FORMATS = [
  { mime: 'audio/webm;codecs=opus', extension: 'webm' },
  { mime: 'audio/mp4;codecs=mp4a.40.2', extension: 'm4a' },
];

const videoOnly = (format) => ({
  ...format,
  mime: format.mime.split(',')[0],
});

const editFormatOf = (audio, formats = FORMATS, output = 'video') => {
  if (typeof globalThis.MediaRecorder !== 'function') return null;
  let choices = audio ? formats : formats.map(videoOnly);
  if (output === 'audio') choices = audio ? AUDIO_FORMATS : [];
  return formatOf(
    (mime) => globalThis.MediaRecorder.isTypeSupported(mime),
    choices,
  );
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
  const { player, context, track, gain, audio, recorder, edit } = media;
  const { part, start, end, output, speed = 1 } = segment;
  await player.seek(part, start, signal);
  const video = player.video;
  video.playbackRate = speed;
  let frame = null;
  const draw = () => {
    track.requestFrame();
    drawVideoFrame(context, video, edit);
  };
  const next = (now, { mediaTime }) => {
    if (mediaTime >= end / 1000) return;
    draw();
    frame = video.requestVideoFrameCallback(next);
  };
  const onStart = () => {
    if (recorder.state === 'inactive') recorder.start(CHUNK_MS);
    else recorder.resume();
    if (track) {
      draw();
      frame = video.requestVideoFrameCallback(next);
    }
    if (audio) {
      const time = audio.currentTime;
      const left = Math.max(0, end / 1000 - video.currentTime) / speed;
      gain.gain.setValueAtTime(1, time);
      gain.gain.setValueAtTime(0, time + left);
    }
  };
  try {
    await playUntil(video, end, signal, onStart, (time) => {
      onTime(output + Math.max(0, time - start) / speed);
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
  const edit = editOptionsOf(options);
  const audioOnly = edit.output === 'audio';
  const segments = segmentsOf(parts, timeline.kept, edit.speed);
  const frame = outputFrameOf(segments[0].part, edit);
  const { width, height } = frame;
  const hasAudio =
    edit.output !== 'mute' && segments.some(({ part }) => part.audio);
  const encoding = encodingOf(frame, timeline.duration, edit, hasAudio);
  if (encoding.error) throw new Error(encoding.error);
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d');
  if (
    !audioOnly &&
    (!context || !canvas.captureStream || !video.requestVideoFrameCallback)
  ) {
    throw new Error('This browser cannot render an edited recording.');
  }
  const stream = audioOnly ? new MediaStream() : canvas.captureStream(0);
  const [track] = stream.getVideoTracks();
  let recorder = null;
  let audio = null;
  let gain = null;
  let stopped = null;
  let time = 0;
  let pending = 0;
  let written = 0;
  const onTime = (current) => {
    time = current;
    options.progress?.(Math.floor(current), timeline.duration);
  };
  const queue = new ChunkQueue(
    async (chunk, duration) => {
      active.throwIfAborted();
      const length = chunk.byteLength;
      written += length;
      if (encoding.maxBytes && written > encoding.maxBytes) {
        throw new Error(
          'The encoder exceeded the size limit. Reduce quality or resolution.',
        );
      }
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
    if (!audioOnly && !track?.requestFrame) {
      throw new Error('This browser cannot capture edited video frames.');
    }
    if (hasAudio) {
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
    const encoderOptions = audioOnly
      ? { mimeType: format.mime }
      : optionsOf(format, { bitsPerSecond: encoding.videoRate });
    if (hasAudio) encoderOptions.audioBitsPerSecond = encoding.audioRate;
    recorder = new globalThis.MediaRecorder(stream, encoderOptions);
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
    let poster = null;
    if (!audioOnly) {
      await player.seek(segments[0].part, segments[0].start, active);
      drawVideoFrame(context, video, edit);
      poster = await posterOf(canvas);
    }
    const media = { player, context, track, recorder, audio, gain, edit };
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

export { editFormatOf, renderEdit, posterOf };
