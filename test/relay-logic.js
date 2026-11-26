'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const load = () => import('../application/static/relay-logic.js');

test('the lower endpoint asks after three failures', async () => {
  const { needsRelay } = await load();
  assert.equal(needsRelay('ada', 'bob', 2), false);
  assert.equal(needsRelay('ada', 'bob', 3), true);
  assert.equal(needsRelay('ada', 'bob', 4), true);
  assert.equal(needsRelay('bob', 'ada', 4), false);
});

test('asks only connected third participants, in endpoint order', async () => {
  const { relayCandidates } = await load();
  const names = ['zoe', 'ada', 'bob', 'carl', 'cara'];
  const people = names.map((endpoint) => ({ endpoint }));
  const connected = (endpoint) => endpoint !== 'carl';
  const candidates = relayCandidates(people, 'ada', 'zoe', connected);
  assert.deepEqual(candidates, ['bob', 'cara']);
});

test('a candidate denies disconnected, busy, or blocked requests', async () => {
  const { relayDenial } = await load();
  const ready = { joined: true, linked: true, busy: false, blocked: false };
  assert.equal(relayDenial({ ...ready, joined: false }), 'not-joined');
  assert.equal(relayDenial({ ...ready, linked: false }), 'not-linked');
  assert.equal(relayDenial({ ...ready, busy: true }), 'busy');
  assert.equal(relayDenial({ ...ready, blocked: true }), 'no-sound');
  assert.equal(relayDenial(ready), '');
});

test('validates relay actions, pair, roles and fields', async () => {
  const { readRelayMessage } = await load();
  const pair = { type: 'relay', from: 'ada', to: 'bob' };
  const ask = { ...pair, action: 'ask' };
  assert.equal(readRelayMessage(ask, 'cara', 'ada'), ask);
  assert.equal(readRelayMessage(ask, 'cara', 'bob'), null);
  assert.equal(readRelayMessage(ask, 'bob', 'ada'), null);
  assert.equal(readRelayMessage({ ...ask, from: '' }, 'cara', 'ada'), null);
  assert.equal(readRelayMessage({ ...ask, to: 'ada' }, 'cara', 'ada'), null);
  assert.equal(readRelayMessage({ ...ask, to: 7 }, 'cara', 'ada'), null);
  assert.equal(readRelayMessage({ ...ask, to: 'aaron' }, 'cara', 'ada'), null);
  const deny = { ...pair, action: 'deny', reason: 'no-sound' };
  assert.equal(readRelayMessage(deny, 'ada', 'cara'), deny);
  assert.equal(readRelayMessage(deny, 'bob', 'cara'), null);
  assert.equal(readRelayMessage(deny, 'ada', 'bob'), null);
  const fake = { ...deny, reason: 'unknown' };
  assert.equal(readRelayMessage(fake, 'ada', 'cara'), null);
  const assignment = { ...pair, action: 'assign', peer: 'ada' };
  assert.equal(readRelayMessage(assignment, 'bob', 'cara'), assignment);
  assert.equal(readRelayMessage(assignment, 'ada', 'cara'), null);
  assert.equal(readRelayMessage(assignment, 'bob', 'ada'), null);
  assert.equal(readRelayMessage(assignment, 'bob', 'bob'), null);
  const release = { ...assignment, action: 'release' };
  assert.equal(readRelayMessage(release, 'bob', 'cara'), release);
  const stop = { ...pair, action: 'stop' };
  assert.equal(readRelayMessage(stop, 'cara', 'ada'), stop);
  assert.equal(readRelayMessage(stop, 'cara', 'bob'), stop);
  assert.equal(readRelayMessage(stop, 'cara', 'dan'), null);
  const unknown = { ...pair, action: 'change' };
  assert.equal(readRelayMessage(unknown, 'bob', 'cara'), null);
});

test('silent playback requires a working volume setter', async () => {
  const { canSilence } = await load();
  const adjustable = { volume: 1 };
  const fixed = {};
  Object.defineProperty(fixed, 'volume', {
    get: () => 1,
    set: () => {},
  });
  assert.equal(canSilence(adjustable), true);
  assert.equal(adjustable.volume, 0);
  assert.equal(canSilence(fixed), false);
  assert.equal(canSilence(Object.freeze({ volume: 1 })), false);
});

test('maps screen in preference to camera and omits screen audio', async () => {
  const { relayVideoSource, relaySlot } = await load();
  const person = { camera: true, screen: true };
  const camera = { ...person, screen: false };
  assert.equal(relayVideoSource(person), 'screen');
  assert.equal(relayVideoSource(camera), 'camera');
  assert.equal(relayVideoSource({}), '');
  assert.equal(relaySlot(person, 'mic'), 'relayAudio');
  assert.equal(relaySlot(person, 'screen'), 'relayVideo');
  assert.equal(relaySlot(person, 'camera'), '');
  assert.equal(relaySlot(camera, 'camera'), 'relayVideo');
  assert.equal(relaySlot(camera, 'screen'), '');
  assert.equal(relaySlot(person, 'screenAudio'), '');
});

test('caps width and height without scaling up', async () => {
  const { relayVideoEncoding } = await load();
  const limits = { maxBitrate: 500000, maxFramerate: 15 };
  assert.equal(relayVideoEncoding(0, 360), null);
  assert.deepEqual(relayVideoEncoding(320, 180), {
    ...limits,
    scaleResolutionDownBy: 1,
  });
  assert.equal(relayVideoEncoding(1280, 360).scaleResolutionDownBy, 2);
  assert.equal(relayVideoEncoding(640, 1080).scaleResolutionDownBy, 3);
});
