'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const usage = import('../application/static/storage-usage.js');
const reset = import('../application/static/settings-reset.js');

const MB = 1024 * 1024;

const createFile = (size, fails = false) => ({
  kind: 'file',
  getFile: async () => {
    if (fails) throw new Error('locked');
    return { size };
  },
});

const createDirectory = (entries) => ({
  kind: 'directory',
  values: async function* values() {
    yield* Object.values(entries);
  },
  getDirectoryHandle: async (name) => {
    if (!entries[name]) throw new DOMException('missing', 'NotFoundError');
    return entries[name];
  },
});

const createStorage = (root) => ({ getDirectory: async () => root });

test('breakdown sums messages, files, recordings, and the app', async () => {
  const { breakdownOf } = await usage;
  const sizes = { chat: 3 * MB, dm: MB, files: 80 * MB, recordings: 200 * MB };
  const parts = breakdownOf({ usage: 300 * MB, quota: 6000 * MB, sizes });
  assert.deepEqual(parts, {
    messages: 4 * MB,
    files: 80 * MB,
    recordings: 200 * MB,
    app: 16 * MB,
    total: 300 * MB,
    quota: 6000 * MB,
  });
});

test('the app part never goes below zero', async () => {
  const { breakdownOf } = await usage;
  const sizes = { chat: 5, dm: 5, files: 50, recordings: 100 };
  const parts = breakdownOf({ usage: 100, quota: 1000, sizes });
  assert.equal(parts.app, 0);
  assert.equal(parts.total, 160);
});

test('missing, zero, and bad numbers count as zero', async () => {
  const { breakdownOf } = await usage;
  const empty = {
    messages: 0,
    files: 0,
    recordings: 0,
    app: 0,
    total: 0,
    quota: 0,
  };
  assert.deepEqual(breakdownOf(), empty);
  assert.deepEqual(breakdownOf({}), empty);
  assert.deepEqual(breakdownOf({ usage: 0, quota: 0, sizes: {} }), empty);
  const bad = { usage: NaN, quota: -1, sizes: { chat: 'x', files: null } };
  assert.deepEqual(breakdownOf(bad), empty);
  const only = breakdownOf({ usage: 2048 });
  assert.equal(only.app, 2048);
  assert.equal(only.total, 2048);
});

test('shares scale to the quota and keep small parts visible', async () => {
  const { breakdownOf, sharesOf } = await usage;
  const sizes = { chat: 0, dm: 0, files: 500, recordings: 1, extra: 9 };
  const parts = breakdownOf({ usage: 600, quota: 1000, sizes });
  const shares = sharesOf(parts);
  assert.equal(shares.files, 50);
  assert.equal(shares.app, 9.9);
  assert.equal(shares.recordings, 0.5);
  assert.equal(shares.messages, 0);
  const none = sharesOf(breakdownOf({}));
  assert.deepEqual(Object.values(none), [0, 0, 0, 0]);
  const total = sharesOf(breakdownOf({ usage: 400, quota: 0 }));
  assert.equal(total.app, 100);
});

test('texts show the total, the quota, and each part', async () => {
  const { breakdownOf, usageText, partsText } = await usage;
  const sizes = { chat: 2 * MB, dm: 0, files: 81 * MB, recordings: 0 };
  const parts = breakdownOf({ usage: 100 * MB, quota: 1024 * MB, sizes });
  assert.equal(usageText(parts), '100.0 MB of 1.0 GB');
  assert.equal(
    partsText(parts),
    'Messages 2.0 MB · Files 81.0 MB · Recordings 0 B · App 17.0 MB',
  );
  assert.equal(usageText({ total: 2048, quota: 0 }), '2 KB');
});

test('estimate is feature detected and survives failures', async () => {
  const { estimate } = await usage;
  assert.equal(await estimate(null), null);
  assert.equal(await estimate({}), null);
  const failing = { estimate: async () => Promise.reject(new Error('no')) };
  assert.equal(await estimate(failing), null);
  const working = { estimate: async () => ({ usage: 5, quota: 10 }) };
  assert.deepEqual(await estimate(working), { usage: 5, quota: 10 });
  const odd = { estimate: async () => ({ usage: undefined, quota: 7 }) };
  assert.deepEqual(await estimate(odd), { usage: 0, quota: 7 });
});

test('the walk sums files per top-level directory', async () => {
  const { measure } = await usage;
  const root = createDirectory({
    chat: createDirectory({ a: createFile(10), b: createFile(20) }),
    dm: createDirectory({ c: createFile(5, true) }),
    files: createDirectory({
      d: createDirectory({ e: createFile(100), f: createFile(1) }),
    }),
    other: createDirectory({ g: createFile(999) }),
  });
  const sizes = await measure(createStorage(root));
  assert.deepEqual(sizes, { chat: 30, dm: 0, files: 101, recordings: 0 });
  assert.equal(await measure({}), null);
  assert.equal(await measure(null), null);
});

test('the walk stops when the signal aborts', async () => {
  const { measure } = await usage;
  const controller = new AbortController();
  let reads = 0;
  const counting = {
    kind: 'file',
    getFile: async () => {
      reads++;
      controller.abort();
      return { size: 1 };
    },
  };
  const root = createDirectory({
    chat: createDirectory({ a: counting, b: counting, c: counting }),
    files: createDirectory({ d: counting }),
  });
  const sizes = await measure(createStorage(root), controller.signal);
  assert.equal(sizes, null);
  assert.equal(reads, 1);
  const done = new AbortController();
  done.abort();
  assert.equal(await measure(createStorage(root), done.signal), null);
});

test('reset removes only settings keys', async () => {
  const { resetSettings, isResettable } = await reset;
  const entries = {
    'xxii:settings': '{}',
    'xxii:call-settings': '{}',
    'xxii:call-auto-lower': 'off',
    'xxii:devices': '{}',
    'xxii:ice': '{}',
    'xxii:call-volume:p-a': '150',
    'xxii:call-volume:p-b': '50',
    'xxii:nick': 'alex',
    'xxii:peer': 'p-me',
    'xxii:drafts': '[]',
    'xxii:read': '[]',
    'xxii:destinations': '[]',
    'xxii:storage-persist': '1',
    other: 'x',
  };
  const map = new Map(Object.entries(entries));
  const storage = {
    get length() {
      return map.size;
    },
    key: (index) => Array.from(map.keys())[index] ?? null,
    removeItem: (key) => map.delete(key),
  };
  const removed = resetSettings(storage);
  assert.equal(removed.length, 7);
  assert.deepEqual(Array.from(map.keys()), [
    'xxii:nick',
    'xxii:peer',
    'xxii:drafts',
    'xxii:read',
    'xxii:destinations',
    'xxii:storage-persist',
    'other',
  ]);
  assert.equal(isResettable('xxii:call-volume:'), true);
  assert.equal(isResettable('xxii:call-volumes'), false);
});
