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
  const now = new Date(2026, 10, 26, 9, 0).getTime();
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
  assert.deepEqual(labelsOf(meta, now), {
    title: 'Team notes',
    chat: '!team',
    isRenamed: true,
    name: 'Team notes',
    date: 'Nov 19',
    duration: '1:01:01',
    size: '1.5 MB',
    meta: '!team · Nov 19 · 1.5 MB',
    badge: '',
    folder: '',
  });
  assert.equal(labelsOf({ ...meta, folder: 'Movies' }, now).folder, 'Movies');
  const badges = [
    ['recording', 'recording'],
    ['paused', 'paused'],
    ['interrupted', 'interrupted'],
    ['done', ''],
    ['constructor', ''],
  ];
  for (const pair of badges) {
    const state = pair[0];
    const badge = pair[1];
    assert.equal(labelsOf({ ...meta, state }, now).badge, badge);
  }
});

test('the chat shows once for a default or empty title', async () => {
  const { labelsOf } = await load();
  const { titleOf } = await import('../application/static/recording-files.js');
  const started = new Date(2026, 10, 26, 8, 30).getTime();
  const now = new Date(2026, 10, 26, 9, 0).getTime();
  const meta = {
    chatName: '!general',
    started,
    duration: 1000,
    size: 2048,
    state: 'done',
  };
  const expected = {
    title: '!general',
    chat: '!general',
    isRenamed: false,
    name: '!general today 08:30',
    date: 'today 08:30',
    meta: 'today 08:30 · 2 KB',
  };
  const defaulted = { ...meta, title: titleOf('!general', started) };
  for (const input of [defaulted, { ...meta, title: '' }, meta]) {
    assert.deepEqual(
      Object.fromEntries(
        Object.keys(expected).map((key) => [key, labelsOf(input, now)[key]]),
      ),
      expected,
    );
  }
  const renamed = labelsOf({ ...meta, title: 'Standup' }, now);
  assert.equal(renamed.title, 'Standup');
  assert.equal(renamed.meta, '!general · today 08:30 · 2 KB');
});

test('formats partial metadata and storage estimates', async () => {
  const { labelsOf, storageText } = await load();
  assert.deepEqual(labelsOf({ chat: 'general' }), {
    title: 'general',
    chat: 'general',
    isRenamed: false,
    name: 'general Unknown date',
    date: 'Unknown date',
    duration: 'Unknown duration',
    size: 'Unknown size',
    meta: 'Unknown date · Unknown size',
    badge: '',
    folder: '',
  });
  assert.equal(labelsOf({ title: 'Mine' }).meta.startsWith('No chat'), true);
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
