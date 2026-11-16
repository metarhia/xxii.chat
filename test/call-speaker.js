'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const load = () => import('../application/static/media.js');
const levels = (ada = 0, bob = 0) =>
  new Map([
    ['ada', ada],
    ['bob', bob],
  ]);

test('speaking needs 300ms above threshold and 800ms silence', async () => {
  const { createSpeakerState, selectSpeaker } = await load();
  let state = createSpeakerState();
  state = selectSpeaker(state, levels(0.05), 0);
  state = selectSpeaker(state, levels(0.05), 500);
  assert.equal(state.participants.get('ada').speaking, false);
  state = selectSpeaker(state, levels(0.051), 600);
  state = selectSpeaker(state, levels(0.051), 899);
  assert.equal(state.participants.get('ada').speaking, false);
  state = selectSpeaker(state, levels(0.051), 900);
  assert.equal(state.participants.get('ada').speaking, true);
  state = selectSpeaker(state, levels(), 1000);
  state = selectSpeaker(state, levels(), 1799);
  assert.equal(state.participants.get('ada').speaking, true);
  state = selectSpeaker(state, levels(), 1800);
  assert.equal(state.participants.get('ada').speaking, false);
});

test('interrupted speech and silence reset their hold clocks', async () => {
  const { createSpeakerState, selectSpeaker } = await load();
  let state = createSpeakerState();
  for (const now of [0, 100, 200]) {
    state = selectSpeaker(state, levels(0.3), now);
  }
  state = selectSpeaker(state, levels(), 250);
  state = selectSpeaker(state, levels(0.3), 300);
  state = selectSpeaker(state, levels(0.3), 599);
  assert.equal(state.participants.get('ada').speaking, false);
  state = selectSpeaker(state, levels(0.3), 600);
  state = selectSpeaker(state, levels(), 700);
  state = selectSpeaker(state, levels(0.3), 1400);
  state = selectSpeaker(state, levels(), 1500);
  state = selectSpeaker(state, levels(), 2299);
  assert.equal(state.participants.get('ada').speaking, true);
  state = selectSpeaker(state, levels(), 2300);
  assert.equal(state.participants.get('ada').speaking, false);
});

test('speaker settles for 1.5s and switches at most every 2s', async () => {
  const { createSpeakerState, selectSpeaker } = await load();
  let state = createSpeakerState();
  state = selectSpeaker(state, levels(0.5, 0.3), 0);
  state = selectSpeaker(state, levels(0.5, 0.3), 300);
  state = selectSpeaker(state, levels(0.5, 0.3), 1799);
  assert.equal(state.speaker, '');
  state = selectSpeaker(state, levels(0.5, 0.3), 1800);
  assert.equal(state.speaker, 'ada');
  state = selectSpeaker(state, levels(0.3, 0.6), 1900);
  state = selectSpeaker(state, levels(0.3, 0.6), 3400);
  assert.equal(state.speaker, 'ada');
  state = selectSpeaker(state, levels(0.3, 0.6), 3799);
  assert.equal(state.speaker, 'ada');
  state = selectSpeaker(state, levels(0.3, 0.6), 3800);
  assert.equal(state.speaker, 'bob');
  state = selectSpeaker(state, levels(0.7, 0.6), 4000);
  state = selectSpeaker(state, levels(0.3, 0.6), 5000);
  state = selectSpeaker(state, levels(0.7, 0.6), 5500);
  state = selectSpeaker(state, levels(0.7, 0.6), 6999);
  assert.equal(state.speaker, 'bob');
  state = selectSpeaker(state, levels(0.7, 0.6), 7000);
  assert.equal(state.speaker, 'ada');
});

test('selection clamps levels and drops departed endpoints', async () => {
  const { createSpeakerState, selectSpeaker } = await load();
  const initial = createSpeakerState();
  const input = new Map([
    ['ada', 4],
    ['bob', NaN],
    ['kim', -1],
  ]);
  let state = selectSpeaker(initial, input, 0);
  assert.equal(initial.participants.size, 0);
  assert.equal(input.get('ada'), 4);
  assert.equal(state.participants.get('ada').level, 1);
  assert.equal(state.participants.get('bob').level, 0);
  state = selectSpeaker(state, input, 300);
  state = selectSpeaker(state, input, 1800);
  assert.equal(state.speaker, 'ada');
  state = selectSpeaker(state, new Map(), 1900);
  assert.equal(state.participants.size, 0);
  assert.equal(state.speaker, '');
});

test('monitor emits levels and speaker and clears lifecycle', async () => {
  const { CallLevels } = await load();
  const media = { level: 0.2, micOn: true };
  const receiver = { getSynchronizationSources: () => [{ audioLevel: 0.6 }] };
  let people = [
    { endpoint: 'ada', mic: true },
    { endpoint: 'bob', mic: true },
  ];
  const session = { endpoint: 'ada', receiver: () => receiver };
  const monitor = new CallLevels(session, media, () => people);
  const events = [];
  monitor.on('levels', (value) => events.push(value));
  monitor.on('speaker', (value) => events.push(value));
  monitor.sample(0);
  monitor.sample(300);
  monitor.sample(1800);
  assert.ok(events[0] instanceof Map);
  assert.equal(events.at(-1), 'bob');
  media.micOn = false;
  people[1].mic = false;
  monitor.sample(1900);
  assert.equal(monitor.levels.get('ada'), 0);
  assert.equal(monitor.levels.get('bob'), 0);
  people = [{ endpoint: 'ada', mic: false }];
  monitor.sample(2000);
  assert.equal(monitor.state.speaker, '');
  assert.equal(monitor.levels.has('bob'), false);
  monitor.start();
  monitor.stop();
  assert.equal(monitor.timer, null);
  assert.equal(monitor.state.participants.size, 0);
  assert.equal(monitor.levels.size, 0);
});

test('monitor detects remote APIs and deduplicates notices', async () => {
  const { CallLevels } = await load();
  let receiver = {};
  const session = { endpoint: 'ada', receiver: () => receiver };
  const monitor = new CallLevels(session, {}, () => [{ endpoint: 'bob' }]);
  const notices = [];
  monitor.on('notice', (value) => notices.push(value));
  monitor.sample(0);
  monitor.sample(100);
  assert.equal(notices.length, 1);
  receiver = { getSynchronizationSources: () => [{ audioLevel: undefined }] };
  monitor.sample(200);
  assert.equal(notices.length, 2);
  receiver = {
    getSynchronizationSources() {
      throw new Error('missing');
    },
  };
  monitor.sample(300);
  assert.equal(notices.length, 3);
  assert.equal(monitor.levels.get('bob'), 0);
  monitor.stop();
});

test('meter failure preserves the microphone and shows a notice', async (t) => {
  const { MediaCapture } = await load();
  const original = Object.getOwnPropertyDescriptor(globalThis, 'AudioContext');
  class UnavailableContext {
    constructor() {
      throw new Error('unavailable');
    }
  }
  Object.defineProperty(globalThis, 'AudioContext', {
    configurable: true,
    value: UnavailableContext,
  });
  t.after(() => {
    if (original) {
      Object.defineProperty(globalThis, 'AudioContext', original);
    } else {
      Reflect.deleteProperty(globalThis, 'AudioContext');
    }
  });
  const media = new MediaCapture(null);
  t.after(() => media.stop());
  const track = { enabled: true, stop() {} };
  media.useMic(track);
  assert.equal(media.micTrack, track);
  assert.equal(media.micOn, true);
  assert.match(media.notice, /Local speaking detection is unavailable/);
});
