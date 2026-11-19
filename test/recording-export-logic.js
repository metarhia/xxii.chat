'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const load = () => import('../application/static/recording-export.js');

test('names exports from the chat and encodes the download URL', async () => {
  const { exportNameOf, downloadUrlOf } = await load();
  const started = new Date(2026, 10, 19, 14, 5).getTime();
  const name = exportNameOf('Київ: R&D / #2', started, 'mp4');
  assert.equal(name, 'xxii Київ_ R&D _ #2 2026-11-19 14-05.mp4');
  const url = new URL(downloadUrlOf('fixture', 'mp4', name), 'https://test');
  assert.equal(url.pathname, '/recordings/fixture/program.mp4');
  assert.equal(url.searchParams.get('download'), '1');
  assert.equal(url.searchParams.get('name'), name);
  assert.equal(exportNameOf('team', undefined, 'webm'), 'program.webm');
});

test('puts the duplicate number before the final extension', async () => {
  const { suffixNameOf } = await load();
  assert.equal(suffixNameOf('team.notes.webm', 2), 'team.notes (2).webm');
  assert.equal(suffixNameOf('team.notes.webm', 3), 'team.notes (3).webm');
  assert.equal(suffixNameOf('team', 4), 'team (4)');
});

test('reports 100 percent after the writable closes', async () => {
  const { exportFile } = await load();
  const closing = Promise.withResolvers();
  const closed = Promise.withResolvers();
  const writable = new WritableStream({
    close() {
      closing.resolve();
      return closed.promise;
    },
  });
  const target = { createWritable: async () => writable };
  const values = [];
  const progress = (value) => values.push(value);
  const copy = exportFile(new Blob(['recording']), target, progress);
  await closing.promise;
  assert.deepEqual(values, [0, 99]);
  closed.resolve();
  await copy;
  assert.deepEqual(values, [0, 99, 100]);
});

test('does not report 100 percent when closing fails', async () => {
  const { exportFile } = await load();
  const writable = new WritableStream({
    close() {
      throw new Error('Write failed');
    },
  });
  const target = { createWritable: async () => writable };
  const values = [];
  const progress = (value) => values.push(value);
  await assert.rejects(
    exportFile(new Blob(['recording']), target, progress),
    /Write failed/,
  );
  assert.deepEqual(values, [0, 99]);
});
