'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

class Track extends EventTarget {
  constructor(kind, surface = 'browser') {
    super();
    this.kind = kind;
    this.surface = surface;
    this.readyState = 'live';
    this.contentHint = '';
    this.constraints = null;
    this.stops = 0;
  }

  stop() {
    this.stops += 1;
    this.readyState = 'ended';
  }

  end() {
    this.readyState = 'ended';
    this.dispatchEvent(new Event('ended'));
  }

  getSettings() {
    return { displaySurface: this.surface };
  }

  async applyConstraints(constraints) {
    this.constraints = constraints;
  }
}

const source = (surface = 'browser') => {
  const video = new Track('video', surface);
  const audio = new Track('audio');
  return {
    video,
    audio,
    getTracks: () => [video, audio],
    getVideoTracks: () => [video],
    getAudioTracks: () => [audio],
  };
};

const environment = async (t, display, search = '') => {
  const replace = (key, value) => {
    const original = Object.getOwnPropertyDescriptor(globalThis, key);
    Object.defineProperty(globalThis, key, { configurable: true, value });
    t.after(() => {
      if (original) Object.defineProperty(globalThis, key, original);
      else Reflect.deleteProperty(globalThis, key);
    });
  };
  replace('navigator', { mediaDevices: { getDisplayMedia: display } });
  replace('location', { search });
  const focuses = [];
  class Controller {
    constructor() {
      this.focuses = focuses;
    }

    setFocusBehavior(value) {
      this.focuses.push(value);
    }
  }
  replace('CaptureController', Controller);
  const { MediaCapture } = await import('../application/static/media.js');
  const media = new MediaCapture(null);
  t.after(() => media.stop());
  return { media, focuses };
};

test('screen capture options, focus, quality, and browser stop', async (t) => {
  const stream = source();
  let options = null;
  const display = async (input) => {
    options = input;
    return stream;
  };
  const { media, focuses } = await environment(t, display);
  let changes = 0;
  media.onChange = () => changes++;
  await media.openScreen();
  assert.equal(options.audio, true);
  assert.equal(options.systemAudio, 'include');
  assert.equal(options.surfaceSwitching, 'include');
  assert.equal(options.selfBrowserSurface, 'exclude');
  assert.equal(options.monitorTypeSurfaces, 'include');
  assert.equal(options.video.frameRate.ideal, 15);
  assert.equal(options.video.frameRate.max, 30);
  assert.deepEqual(focuses, ['no-focus-change']);
  assert.equal(media.screenTrack, stream.video);
  assert.equal(media.screenAudioTrack, stream.audio);
  assert.equal(media.screenShared, true);
  assert.equal(stream.video.contentHint, 'detail');
  await media.toggleScreenMotion();
  assert.equal(stream.video.contentHint, 'motion');
  assert.deepEqual(stream.video.constraints, {
    frameRate: { ideal: 30, max: 30 },
  });
  stream.video.end();
  assert.equal(media.screenTrack, null);
  assert.equal(media.screenAudioTrack, null);
  assert.equal(media.screenShared, false);
  assert.equal(stream.audio.readyState, 'ended');
  assert.ok(changes >= 3);
});

test('focus is only controlled for tabs and windows', async (t) => {
  const stream = source('monitor');
  const { media, focuses } = await environment(t, async () => stream);
  await media.openScreen();
  assert.deepEqual(focuses, []);
});

test('local capture keeps the source and clears both send slots', async (t) => {
  const stream = source('window');
  const { media } = await environment(t, async () => stream);
  const { CallStage } = await import('../application/static/stage.js');
  const tracks = new Map();
  const flags = [];
  const hooks = { update: async (state) => flags.push(state) };
  const stage = new CallStage(null, hooks);
  stage.media = media;
  stage.session = {
    phase: 'joined',
    setTrack: (slot, track) => tracks.set(slot, track),
  };
  await media.openScreen(false);
  stage.pushTracks();
  await stage.updateServer();
  assert.equal(media.screenTrack, stream.video);
  assert.equal(media.screenAudioTrack, stream.audio);
  assert.equal(stream.video.readyState, 'live');
  assert.equal(tracks.get('screen'), null);
  assert.equal(tracks.get('screenAudio'), null);
  assert.equal(flags.at(-1).screen, false);
  await media.openScreen(true);
  stage.pushTracks();
  await stage.updateServer();
  assert.equal(tracks.get('screen'), stream.video);
  assert.equal(tracks.get('screenAudio'), stream.audio);
  assert.equal(flags.at(-1).screen, true);
  media.stopScreen();
  stage.pushTracks();
  await stage.updateServer();
  assert.equal(tracks.get('screen'), null);
  assert.equal(tracks.get('screenAudio'), null);
  assert.equal(flags.at(-1).screen, false);
  assert.equal(stream.audio.readyState, 'ended');
});

test('leaving during the picker stops every late track', async (t) => {
  const stream = source();
  let finish = null;
  const result = new Promise((resolve) => {
    finish = resolve;
  });
  const { media } = await environment(t, () => result);
  const opening = media.openScreen();
  assert.equal(media.screenPending, true);
  media.stop();
  finish(stream);
  await opening;
  assert.equal(media.screenTrack, null);
  assert.equal(media.screenShared, false);
  assert.equal(stream.video.stops, 1);
  assert.equal(stream.audio.stops, 1);
});

test('cancelled and malformed capture leave no source', async (t) => {
  const blocked = new Error('cancelled');
  blocked.name = 'NotAllowedError';
  const { media } = await environment(t, async () => {
    throw blocked;
  });
  await media.openScreen();
  assert.match(media.message, /cancelled or blocked/);
  assert.equal(media.screenPending, false);
  assert.equal(media.screenShared, false);
  const broken = source();
  broken.getVideoTracks = () => [];
  globalThis.navigator.mediaDevices.getDisplayMedia = async () => broken;
  await media.openScreen();
  assert.match(media.message, /Could not capture/);
  assert.equal(broken.audio.readyState, 'ended');
  assert.equal(broken.video.readyState, 'ended');
});

test('screen capture degrades when browser APIs are missing', async (t) => {
  const { media } = await environment(t, undefined);
  assert.equal(media.canScreen, false);
  await media.openScreen();
  assert.match(media.message, /unavailable/);
});

test('screen fallback runs only after failure in test pages', async (t) => {
  const stream = source();
  const error = new Error('capture unavailable');
  const { media } = await environment(t, async () => {
    throw error;
  });
  media.testScreen = async () => stream;
  await media.openScreen();
  assert.equal(media.screenTrack, null);
  assert.equal(stream.video.readyState, 'live');
  globalThis.location.search = '?test';
  const { MediaCapture } = await import('../application/static/media.js');
  const testing = new MediaCapture(null);
  t.after(() => testing.stop());
  testing.testScreen = async () => stream;
  await testing.openScreen();
  assert.equal(testing.screenTrack, stream.video);
});
