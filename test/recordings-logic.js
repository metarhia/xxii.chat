'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const load = () => import('../application/static/recordings.js');

test('sorts newest first without changing the input', async () => {
  const { sortRecordings } = await load();
  const entries = [
    { id: 'oldest', started: 1 },
    { id: 'newest', started: 3 },
    { id: 'middle', started: 2 },
    { id: 'unknown', started: '4' },
  ];
  const ids = (rows) => rows.map((row) => row.id);
  assert.deepEqual(ids(sortRecordings(entries)), [
    'newest',
    'middle',
    'oldest',
    'unknown',
  ]);
  assert.deepEqual(ids(entries), ['oldest', 'newest', 'middle', 'unknown']);
});

test('lists recording details and labels', async () => {
  const { labelsOf } = await load();
  const started = new Date(2026, 10, 19, 14, 5).getTime();
  const meta = {
    title: ' Team notes ',
    chatName: '!team',
    chat: 'team',
    started,
    duration: 3661000,
    size: 1536 * 1024,
    state: 'done',
    folder: '',
  };
  assert.deepEqual(labelsOf(meta), {
    title: 'Team notes',
    chat: '!team',
    date: '2026-11-19 14:05',
    duration: '1:01:01',
    size: '1.5 MB',
    state: 'Done',
    location: 'Browser storage',
  });
  assert.equal(labelsOf({ ...meta, folder: 'Movies' }).location, 'Movies');
  const states = [
    ['recording', 'Recording'],
    ['paused', 'Recording (paused)'],
    ['interrupted', 'Interrupted'],
    ['constructor', 'Unknown'],
  ];
  for (const pair of states) {
    const state = pair[0];
    const label = pair[1];
    assert.equal(labelsOf({ ...meta, state }).state, label);
  }
});

test('formats partial metadata and storage estimates', async () => {
  const { labelsOf, storageText } = await load();
  assert.deepEqual(labelsOf({ chat: 'general' }), {
    title: 'Untitled recording',
    chat: 'general',
    date: 'Unknown date',
    duration: 'Unknown duration',
    size: 'Unknown size',
    state: 'Unknown',
    location: 'Browser storage',
  });
  assert.equal(labelsOf({ duration: 0 }).duration, '00:00');
  assert.equal(labelsOf({ duration: 65000 }).duration, '01:05');
  assert.equal(labelsOf({ size: 0 }).size, '0 B');
  assert.equal(labelsOf({ size: 2048 }).size, '2 KB');
  assert.equal(storageText({}), 'Storage usage is unavailable.');
  assert.equal(
    storageText({ usage: 2048, quota: 4096 }),
    '2 KB used · 2 KB free',
  );
  assert.equal(storageText({ usage: 1024, quota: 0 }), '1 KB used · 0 B free');
});
