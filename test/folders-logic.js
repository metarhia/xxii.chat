'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const folders = import('../application/static/folders.js');
const hidden = import('../application/static/hidden.js');

const ME = 'p-me';
const OTHER = 'p-alex';

const createStorage = (entries = {}) => {
  const map = new Map(Object.entries(entries));
  return {
    map,
    getItem: (key) => map.get(key) ?? null,
    setItem: (key, value) => map.set(key, `${value}`),
  };
};

const folder = (id, parent = '', name = id) => ({
  id,
  name,
  icon: '📁',
  parent,
  created: 1,
});

const createReplica = (records) => {
  const entries = new Map(Object.entries(records));
  return {
    keys: (entity) =>
      Array.from(entries.keys()).filter(
        (id) => entries.get(id).entity === entity,
      ),
    get: (id) => entries.get(id),
  };
};

const saved = (storage) => JSON.parse(storage.map.get('xxii:folders'));

test('a missing key is unknown and a broken one is empty', async () => {
  const { Folders } = await folders;
  const absent = new Folders(createStorage());
  assert.equal(absent.isMigrated, false);
  assert.deepEqual(absent.list(), []);
  const broken = new Folders(createStorage({ 'xxii:folders': '{not json' }));
  assert.equal(broken.isMigrated, false);
  assert.deepEqual(broken.list(), []);
  const wrong = new Folders(createStorage({ 'xxii:folders': '[1,2]' }));
  assert.deepEqual(wrong.list(), []);
  const failing = new Folders({
    getItem: () => {
      throw new Error('blocked');
    },
    setItem: () => {
      throw new Error('blocked');
    },
  });
  assert.equal(failing.isMigrated, false);
  assert.equal(failing.create({ id: 'a', name: 'a', icon: '📁' }).id, 'a');
  assert.equal(failing.list().length, 1);
});

test('the store drops invalid folders and entries', async () => {
  const { parseStore } = await folders;
  const text = JSON.stringify({
    folders: [
      folder('a'),
      folder('a', '', 'duplicate'),
      { ...folder('b'), name: '' },
      { ...folder('c'), created: 'now' },
      { ...folder('d'), name: 'x'.repeat(257) },
      null,
      folder('e', 'a'),
    ],
    entries: [
      { folder: 'a', item: 'chat-1' },
      { folder: 'a', item: 'chat-1' },
      { folder: 'zzz', item: 'chat-1' },
      { folder: 'a', item: 5 },
      { folder: 'e', item: 'peer-1' },
    ],
  });
  const store = parseStore(text);
  assert.deepEqual(
    store.folders.map((item) => item.id),
    ['a', 'e'],
  );
  assert.deepEqual(store.entries, [
    { folder: 'a', item: 'chat-1' },
    { folder: 'e', item: 'peer-1' },
  ]);
});

test('the tree keeps loops and missing parents at the root', async () => {
  const { treeOf } = await folders;
  const store = {
    folders: [
      folder('root', '', 'Root'),
      folder('child', 'root', 'Child'),
      folder('orphan', 'gone', 'Orphan'),
      folder('loop-a', 'loop-b', 'A'),
      folder('loop-b', 'loop-a', 'B'),
      folder('self', 'self', 'Self'),
    ],
    entries: [{ folder: 'child', item: 'x' }],
  };
  const tree = treeOf(store);
  const roots = tree.children.get('').map((item) => item.id);
  assert.deepEqual(roots, ['loop-a', 'loop-b', 'orphan', 'root', 'self']);
  assert.deepEqual(
    tree.children.get('root').map((item) => item.id),
    ['child'],
  );
  assert.deepEqual([...tree.items.get('child')], ['x']);
});

test('create, rename, place, and unplace are saved', async () => {
  const { Folders } = await folders;
  const storage = createStorage();
  const store = new Folders(storage);
  assert.equal(store.create({ id: 'a', name: 'Work', icon: '💼' }).id, 'a');
  assert.equal(store.create({ id: 'a', name: 'Again', icon: '' }), null);
  assert.equal(store.create({ id: 'b', name: '', icon: '' }), null);
  assert.equal(store.place('a', 'chat-1'), true);
  assert.equal(store.place('a', 'chat-1'), false);
  assert.equal(store.place('missing', 'chat-1'), false);
  assert.equal(store.has('a', 'chat-1'), true);
  assert.equal(store.rename('a', 'Jobs', '🧰'), true);
  assert.equal(store.rename('missing', 'x', ''), false);
  assert.equal(store.rename('a', '', ''), false);
  assert.deepEqual(saved(storage).folders[0], {
    id: 'a',
    name: 'Jobs',
    icon: '🧰',
    parent: '',
    created: saved(storage).folders[0].created,
  });
  assert.equal(store.unplace('a', 'chat-1'), true);
  assert.equal(store.unplace('a', 'chat-1'), false);
  assert.deepEqual(saved(storage).entries, []);
});

test('deleting a folder moves children up and drops its entries', async () => {
  const { Folders } = await folders;
  const storage = createStorage();
  const store = new Folders(storage);
  store.create({ id: 'top', name: 'Top', icon: '' });
  store.create({ id: 'mid', name: 'Mid', icon: '', parent: 'top' });
  store.create({ id: 'leaf', name: 'Leaf', icon: '', parent: 'mid' });
  store.place('mid', 'chat-1');
  store.place('leaf', 'chat-2');
  assert.equal(store.remove('mid'), true);
  assert.equal(store.remove('mid'), false);
  const tree = store.tree();
  assert.deepEqual(
    tree.children.get('top').map((item) => item.id),
    ['leaf'],
  );
  assert.equal(tree.items.has('mid'), false);
  assert.deepEqual([...tree.items.get('leaf')], ['chat-2']);
  assert.equal(store.remove('top'), true);
  assert.deepEqual(
    store
      .tree()
      .children.get('')
      .map((item) => item.id),
    ['leaf'],
  );
});

test('migration copies only own folders and active entries once', async () => {
  const { Folders } = await folders;
  const replica = createReplica({
    f1: { entity: 'folder', name: 'Mine', icon: '📦', owner: ME, parent: '' },
    f2: { entity: 'folder', name: 'Sub', owner: ME, parent: 'f1', created: 5 },
    f3: { entity: 'folder', name: 'Theirs', owner: OTHER, parent: '' },
    f4: { entity: 'folder', owner: ME },
    'f1/c1': { entity: 'entry', folder: 'f1', item: 'c1', active: true },
    'f1/c2': { entity: 'entry', folder: 'f1', item: 'c2', active: false },
    'f3/c1': { entity: 'entry', folder: 'f3', item: 'c1', active: true },
    'f2/c3': { entity: 'entry', folder: 'f2', item: 'c3', active: true },
  });
  const storage = createStorage();
  const store = new Folders(storage);
  assert.equal(store.migrate(replica, ME), true);
  assert.equal(store.isMigrated, true);
  const data = saved(storage);
  assert.deepEqual(
    data.folders.map((item) => item.id),
    ['f1', 'f2'],
  );
  assert.equal(data.folders[0].icon, '📦');
  assert.equal(data.folders[1].icon, '');
  assert.deepEqual(data.entries, [
    { folder: 'f1', item: 'c1' },
    { folder: 'f2', item: 'c3' },
  ]);
  store.remove('f2');
  assert.equal(store.migrate(replica, ME), false);
  const again = new Folders(storage);
  assert.equal(again.migrate(replica, ME), false);
  assert.deepEqual(
    again.list().map((item) => item.id),
    ['f1'],
  );
});

test('migration merges own replica folders into local ones', async () => {
  const { Folders } = await folders;
  const storage = createStorage();
  const store = new Folders(storage);
  store.create({ id: 'local', name: 'Local', icon: '' });
  store.create({ id: 'f1', name: 'Same', icon: '' });
  store.place('local', 'c0');
  store.place('f1', 'c1');
  const replica = createReplica({
    f1: { entity: 'folder', name: 'Old', owner: ME, parent: '' },
    f2: { entity: 'folder', name: 'Other', owner: ME, parent: '' },
    f3: { entity: 'folder', name: 'Theirs', owner: OTHER, parent: '' },
    'f1/c1': { entity: 'entry', folder: 'f1', item: 'c1', active: true },
    'f1/c2': { entity: 'entry', folder: 'f1', item: 'c2', active: true },
    'f2/c3': { entity: 'entry', folder: 'f2', item: 'c3', active: true },
  });
  assert.equal(store.isMigrated, false);
  assert.equal(store.migrate(replica, ME), true);
  assert.equal(store.isMigrated, true);
  const data = saved(storage);
  assert.equal(data.migrated, true);
  assert.deepEqual(
    data.folders.map((item) => item.id),
    ['local', 'f1', 'f2'],
  );
  assert.equal(data.folders[1].name, 'Same');
  assert.deepEqual(data.entries, [
    { folder: 'local', item: 'c0' },
    { folder: 'f1', item: 'c1' },
    { folder: 'f1', item: 'c2' },
    { folder: 'f2', item: 'c3' },
  ]);
  assert.equal(store.migrate(replica, ME), false);
  store.remove('f2');
  const other = new Folders(storage);
  assert.equal(other.migrate(replica, ME), false);
  assert.deepEqual(
    other.list().map((item) => item.id),
    ['local', 'f1'],
  );
});

test('migration keeps local folders when storage is blocked', async () => {
  const { Folders } = await folders;
  const blocked = {
    getItem: () => null,
    setItem: () => {
      throw new Error('blocked');
    },
  };
  const store = new Folders(blocked);
  store.create({ id: 'a', name: 'A', icon: '' });
  const replica = createReplica({
    f1: { entity: 'folder', name: 'Old', owner: ME, parent: '' },
  });
  assert.equal(store.migrate(replica, ME), true);
  assert.deepEqual(
    store.list().map((item) => item.id),
    ['a', 'f1'],
  );
});

test('a reload picks up changes made by another tab', async () => {
  const { Folders } = await folders;
  const storage = createStorage();
  const first = new Folders(storage);
  const second = new Folders(storage);
  first.create({ id: 'a', name: 'A', icon: '' });
  first.place('a', 'chat-1');
  assert.deepEqual(second.list(), []);
  second.reload();
  assert.equal(second.has('a', 'chat-1'), true);
});

test('hidden items parse, save, and ignore broken data', async () => {
  const { Hidden, parseHidden, HIDDEN_KEY } = await hidden;
  const broken = parseHidden('{oops');
  assert.equal(broken.chats.size, 0);
  const state = parseHidden(
    JSON.stringify({
      chats: ['c1', 'c1', '', 7, 'c2'],
      feeds: 'nope',
      contacts: [{ id: 'p1', at: 10 }, { id: 'p2' }, 'p3', null],
    }),
  );
  assert.deepEqual([...state.chats.keys()], ['c1', 'c2']);
  assert.equal(state.feeds.size, 0);
  assert.deepEqual(
    [...state.contacts],
    [
      ['p1', 10],
      ['p2', 0],
      ['p3', 0],
    ],
  );
  const storage = createStorage();
  const items = new Hidden(storage);
  assert.equal(items.hide('chats', 'c9'), true);
  assert.equal(items.hide('contacts', 'p9', 42), true);
  assert.equal(items.hide('feeds', ''), false);
  assert.equal(items.has('chats', 'c9'), true);
  assert.equal(items.hiddenAt('contacts', 'p9'), 42);
  const saved = JSON.parse(storage.map.get(HIDDEN_KEY));
  assert.deepEqual(saved, {
    chats: ['c9'],
    feeds: [],
    contacts: [{ id: 'p9', at: 42 }],
  });
  const other = new Hidden(storage);
  assert.equal(other.has('contacts', 'p9'), true);
  assert.equal(items.restore('chats', 'c9'), true);
  assert.equal(items.restore('chats', 'c9'), false);
  other.reload();
  assert.equal(other.has('chats', 'c9'), false);
});

test('a removed contact returns on a newer message from them', async () => {
  const { isReturning } = await hidden;
  const pair = `${ME}_${OTHER}`;
  const message = (author, timestamp, extra = {}) => ({
    entity: 'message',
    chat: pair,
    author,
    timestamp,
    ...extra,
  });
  const check = (records, at) =>
    isReturning(createReplica(records), pair, ME, at);
  assert.equal(check({ a: message(OTHER, 5) }, 10), false);
  assert.equal(check({ a: message(ME, 20) }, 10), false);
  assert.equal(check({ a: message(OTHER, 20, { deleted: 21 }) }, 10), false);
  assert.equal(check({ a: message(OTHER, 20) }, 10), true);
  const elsewhere = { a: message(OTHER, 20, { chat: 'other' }) };
  assert.equal(check(elsewhere, 10), false);
});

test('resetting settings keeps folders and hidden items', async () => {
  const { resetSettings } =
    await import('../application/static/settings-reset.js');
  const storage = {
    entries: new Map([
      ['xxii:folders', '{}'],
      ['xxii:hidden', '{}'],
      ['xxii:settings', '{}'],
    ]),
    get length() {
      return this.entries.size;
    },
    key(index) {
      return Array.from(this.entries.keys())[index];
    },
    removeItem(key) {
      this.entries.delete(key);
    },
  };
  resetSettings(storage);
  assert.deepEqual(Array.from(storage.entries.keys()), [
    'xxii:folders',
    'xxii:hidden',
  ]);
});
