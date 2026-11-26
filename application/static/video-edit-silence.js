import { PartPlayer, playUntil } from './recording-edit-media.js';

const WINDOW_MS = 50;
const QUIET_LEVEL = 0.0126;
const EDGE_MS = 125;
const MAX_DECODE_MS = 120000;
const MAX_DECODE_BYTES = 48 * 1024 * 1024;

const silenceCuts = (levels, duration, minimum) => {
  const cuts = [];
  let start = null;
  const finish = (end) => {
    if (start !== null && end - start >= minimum) {
      cuts.push({ start: start + EDGE_MS, end: end - EDGE_MS });
    }
    start = null;
  };
  for (const { time, level } of levels) {
    if (level < QUIET_LEVEL) start ??= time;
    else finish(time);
  }
  finish(duration);
  return cuts;
};

const audioLevels = (audio, signal) => {
  const levels = [];
  const channels = Array.from(
    { length: audio.numberOfChannels },
    (v, channel) => audio.getChannelData(channel),
  );
  const step = Math.max(1, Math.floor((audio.sampleRate * WINDOW_MS) / 1000));
  for (let offset = 0; offset < audio.length; offset += step) {
    signal.throwIfAborted();
    const end = Math.min(audio.length, offset + step);
    let level = 0;
    for (const samples of channels) {
      let square = 0;
      for (let i = offset; i < end; i++) square += samples[i] ** 2;
      level = Math.max(level, Math.sqrt(square / (end - offset)));
    }
    levels.push({
      time: Math.round((offset * 1000) / audio.sampleRate),
      level,
    });
  }
  return levels;
};

const sampledLevels = async (part, source, signal, progress) => {
  const video = document.createElement('video');
  const player = new PartPlayer(video, source);
  const audio = new globalThis.AudioContext();
  const analyser = audio.createAnalyser();
  const mute = audio.createGain();
  mute.gain.value = 0;
  audio
    .createMediaElementSource(video)
    .connect(analyser)
    .connect(mute)
    .connect(audio.destination);
  const samples = new Float32Array(analyser.fftSize);
  const levels = [];
  let last = -WINDOW_MS;
  try {
    await audio.resume();
    await player.seek(part, 0, signal);
    video.playbackRate = 2;
    await playUntil(video, part.duration, signal, null, (time) => {
      if (time - last < WINDOW_MS) return;
      last = time;
      progress(part.start + time);
      analyser.getFloatTimeDomainData(samples);
      const square = samples.reduce((sum, value) => sum + value ** 2, 0);
      levels.push({
        time: Math.round(time),
        level: Math.sqrt(square / samples.length),
      });
    });
    return levels;
  } finally {
    player.clear();
    await audio.close().catch(() => {});
  }
};

const levelsOf = async (part, source, signal, progress) => {
  if (!part.audio) return [{ time: 0, level: 0 }];
  if (part.duration <= MAX_DECODE_MS && globalThis.OfflineAudioContext) {
    try {
      const file = await source(part, signal, true);
      if (typeof file !== 'string' && file.size <= MAX_DECODE_BYTES) {
        const audio = new globalThis.OfflineAudioContext(1, 1, 16000);
        const bytes = await file.arrayBuffer();
        signal.throwIfAborted();
        return audioLevels(await audio.decodeAudioData(bytes), signal);
      }
    } catch {
      signal.throwIfAborted();
    }
  }
  return sampledLevels(part, source, signal, progress);
};

const findSilentCuts = async (parts, source, minimum, signal, progress) => {
  const cuts = [];
  for (const part of parts) {
    signal.throwIfAborted();
    if (!part.audio) continue;
    progress(part.start);
    const levels = await levelsOf(part, source, signal, progress);
    progress(part.end);
    if (!levels.some(({ level }) => level >= QUIET_LEVEL)) continue;
    const ranges = silenceCuts(levels, part.duration, minimum);
    for (const { start, end } of ranges) {
      cuts.push({ start: part.start + start, end: part.start + end });
    }
  }
  return cuts;
};

export { silenceCuts, findSilentCuts };
