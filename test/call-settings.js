'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const preferences = import('../application/static/call-settings.js');

test('invalid settings use the documented defaults', async () => {
  const { validateSettings, DEFAULTS } = await preferences;
  assert.deepEqual(validateSettings(null), DEFAULTS);
  const invalid = {
    pushToTalk: 'off',
    mirror: 1,
    noise: 'maximum',
    recordingAudio: 'silent',
    recordingTarget: 'network',
    recordingSegment: 2,
  };
  assert.deepEqual(validateSettings(invalid), DEFAULTS);
  assert.equal(DEFAULTS.pushToTalk, true);
  assert.equal(DEFAULTS.autoLower, true);
  assert.equal(DEFAULTS.recordingQuality, '1080p30');
  assert.equal(DEFAULTS.recordingTarget, 'browser');
  assert.equal(DEFAULTS.recordingSegment, 10);
});

test('saved settings take precedence over legacy auto-lower', async () => {
  const { readSettings, writeSettings, DEFAULTS } = await preferences;
  const map = new Map([['xxii:call-auto-lower', 'off']]);
  const storage = {
    getItem: (key) => map.get(key),
    setItem: (key, value) => map.set(key, value),
  };
  assert.equal(readSettings(storage).autoLower, false);
  assert.equal(JSON.parse(map.get('xxii:call-settings')).autoLower, false);
  const settings = {
    ...DEFAULTS,
    recordingAudio: 'duck',
    recordingTarget: 'folder',
    recordingSegment: 15,
    noise: 'strong',
    pushToTalk: false,
  };
  assert.equal(writeSettings(storage, settings), true);
  assert.deepEqual(readSettings(storage), settings);
});

test('membership toast merges and expires after a gap', async () => {
  const { addToast, createToast, showsToast, toastText } = await preferences;
  let toast = addToast(createToast(), { kind: 'join', nick: 'alex' }, 10);
  toast = addToast(toast, { kind: 'join', nick: 'kim' }, 3009);
  toast = addToast(toast, { kind: 'leave', nick: 'sam' }, 3010);
  assert.equal(toastText(toast), 'alex and kim joined · sam left');
  toast = addToast(toast, { kind: 'leave', nick: 'kim' }, 6010);
  assert.equal(toastText(toast), 'kim left');
  assert.equal(showsToast(8), true);
  assert.equal(showsToast(9), false);
});
