'use strict';

const assert = require('node:assert/strict');
const harness = require('./harness.js');

const openTab = async (browser) => {
  const { targetId } = await browser.request('Target.createTarget', {
    url: harness.ORIGIN,
  });
  const { sessionId } = await browser.request('Target.attachToTarget', {
    targetId,
    flatten: true,
  });
  await browser.request('Page.bringToFront', {}, sessionId);
  const run = (body) => harness.run(browser, sessionId, body);
  const wait = (body) => harness.wait(browser, sessionId, body);
  await wait('return app.recordings && navigator.serviceWorker.controller;');
  return { sessionId, run, wait };
};

const open = async (t) => {
  await harness.startCallServer(t);
  const browser = await harness.launch(t, harness.MEDIA_FLAGS);
  const { run } = await openTab(browser);
  return run;
};

const fixture = async (mime, silent = false, pause = false) => {
  const colors = ['#f00000', '#00f000', '#0000f0', '#f0f000', '#f000f0'];
  const pitches = [375, 562.5, 750, 937.5, 1125];
  const times = [0, 1.26, 1.76, 2.61, 3.11];
  const canvas = document.createElement('canvas');
  canvas.width = 128;
  canvas.height = 72;
  const context = canvas.getContext('2d');
  const stream = canvas.captureStream(30);
  const audio = silent
    ? null
    : new globalThis.AudioContext({ sampleRate: 48000 });
  const oscillator = audio?.createOscillator();
  const gain = audio?.createGain();
  if (audio) {
    await audio.resume();
    const output = audio.createMediaStreamDestination();
    oscillator.connect(gain).connect(output);
    stream.addTrack(output.stream.getAudioTracks()[0]);
  }
  const paint = (index) => {
    context.fillStyle = colors[index];
    context.fillRect(0, 0, 128, 72);
    context.fillStyle = '#fff';
    context.fillRect(Math.floor(performance.now() / 33) % 128, 0, 4, 8);
  };
  const recorder = new globalThis.MediaRecorder(stream, {
    mimeType: mime,
    videoKeyFrameIntervalDuration: 2000,
  });
  const chunks = [];
  recorder.ondataavailable = ({ data }) => chunks.push(data);
  const stopped = new Promise((resolve) => {
    recorder.onstop = resolve;
  });
  paint(0);
  recorder.start();
  const started = performance.now();
  if (audio) {
    const at = audio.currentTime;
    pitches.forEach((pitch, i) => {
      oscillator.frequency.setValueAtTime(pitch, at + times[i]);
    });
    if (pause) {
      gain.gain.setValueAtTime(0, at + 1);
      gain.gain.setValueAtTime(1, at + 2.5);
    }
    oscillator.start(at);
  }
  await new Promise((resolve) => {
    const advance = () => {
      const time = (performance.now() - started) / 1000;
      paint(times.findLastIndex((start) => time >= start));
      if (time >= 4.2) resolve();
      else globalThis.requestAnimationFrame(advance);
    };
    globalThis.requestAnimationFrame(advance);
  });
  recorder.stop();
  await stopped;
  for (const track of stream.getTracks()) track.stop();
  await audio?.close();
  return new Blob(chunks, { type: mime });
};

const readTones = async (blob, audio) => {
  const pcm = await audio.decodeAudioData(await blob.arrayBuffer());
  const channel = pcm.getChannelData(0);
  const size = 1024;
  const hop = 480;
  const tones = [];
  const waves = [8, 12, 16, 20, 24].map((pitch) => {
    const phase = (2 * Math.PI * pitch) / size;
    const basis = (fn) => Array.from({ length: size }, (v, i) => fn(phase * i));
    return { pitch, real: basis(Math.cos), imaginary: basis(Math.sin) };
  });
  for (let offset = 0; offset + size <= channel.length; offset += hop) {
    let marker = null;
    let strength = size * 0.08;
    for (const { pitch, real, imaginary } of waves) {
      let x = 0;
      let y = 0;
      for (let i = 0; i < size; i++) {
        const value = channel[offset + i];
        x += value * real[i];
        y += value * imaginary[i];
      }
      const power = Math.hypot(x, y);
      if (power <= strength) continue;
      strength = power;
      marker = pitch;
    }
    if (marker) tones.push([(offset + size / 2) / pcm.sampleRate, marker]);
  }
  return tones;
};

const inspect = async (blob, videoOnly = false, detect = null) => {
  const video = document.createElement('video');
  const url = URL.createObjectURL(blob);
  const audio = videoOnly
    ? null
    : new globalThis.AudioContext({ sampleRate: 48000 });
  const frame = document.createElement('canvas');
  frame.width = 1;
  frame.height = 1;
  const context = frame.getContext('2d', { willReadFrequently: true });
  const frames = [];
  let callback;
  try {
    const ready = new Promise((resolve, reject) => {
      video.onloadeddata = resolve;
      video.onerror = () => reject(new Error(video.error.message));
    });
    video.src = url;
    await ready;
    const stream = video.captureStream();
    const hasAudio = stream.getAudioTracks().length > 0;
    stream.getTracks().forEach((track) => track.stop());
    const tones = audio ? await detect(blob, audio) : [];
    video.muted = true;
    const sample = (now, { mediaTime }) => {
      context.drawImage(video, 64, 36, 1, 1, 0, 0, 1, 1);
      const pixel = context.getImageData(0, 0, 1, 1).data;
      const color = Array.from(pixel.subarray(0, 3), (value) => +(value > 100));
      frames.push([mediaTime, color.join('')]);
      callback = video.requestVideoFrameCallback(sample);
    };
    callback = video.requestVideoFrameCallback(sample);
    const ended = new Promise((resolve) => {
      video.onended = resolve;
    });
    await video.play();
    await ended;
    const duration = video.duration;
    const sought = new Promise((resolve) => {
      video.onseeked = resolve;
    });
    video.currentTime = duration / 2;
    await sought;
    return {
      duration,
      seek: video.currentTime,
      frames,
      tones,
      hasAudio,
      width: video.videoWidth,
      height: video.videoHeight,
    };
  } finally {
    video.cancelVideoFrameCallback(callback);
    video.removeAttribute('src');
    video.load();
    URL.revokeObjectURL(url);
    await audio?.close();
  }
};

const assertMedia = (t, result, duration, seams, silent = false) => {
  const { frames, tones } = result;
  const colors = ['100', '001', '101'];
  const pitches = [8, 16, 24];
  const firstOf = (samples) =>
    Object.fromEntries(
      [...new Set(samples.map(([, marker]) => marker))].map((marker) => [
        marker,
        samples.find(([, value]) => value === marker)[0],
      ]),
    );
  t.diagnostic(
    JSON.stringify({
      duration: result.duration,
      frames: frames.length,
      picture: firstOf(frames),
      tones: firstOf(tones),
    }),
  );
  assert.equal(result.width, 128);
  assert.equal(result.height, 72);
  assert.equal(result.hasAudio, !silent);
  assert.ok(Math.abs(result.duration - duration) <= 0.1, result.duration);
  assert.ok(Math.abs(result.seek - duration / 2) <= 0.1, result.seek);
  assert.ok(frames.length / duration >= 12, frames.length);
  assert.ok(frames.every(([, color]) => colors.includes(color)));
  assert.ok(tones.every(([, pitch]) => ![12, 20].includes(pitch)));
  const errors = seams.map((seam, index) => {
    const picture = frames.find(([, color]) => color === colors[index + 1]);
    assert.ok(picture, 'kept picture marker');
    const tone = tones.find(([, pitch]) => pitch === pitches[index + 1]);
    if (!silent) assert.ok(tone, 'kept tone marker');
    const video = Math.round((picture[0] - seam) * 1000);
    const audio = tone ? Math.round((tone[0] - seam) * 1000) : null;
    assert.ok(Math.abs(video) <= 100, `picture seam error ${video} ms`);
    if (!silent) {
      assert.ok(Math.abs(audio) <= 100, `tone seam error ${audio} ms`);
      const sync = Math.abs(audio - video);
      assert.ok(sync <= 100, `picture and tone differ by ${sync} ms`);
    }
    return { video, audio };
  });
  assert.ok(frames.some(([, color]) => color === colors[0]));
  if (!silent) assert.ok(tones.some(([, pitch]) => pitch === pitches[0]));
  t.diagnostic(JSON.stringify({ duration: result.duration, errors }));
};

module.exports = { open, openTab, fixture, inspect, readTones, assertMedia };
