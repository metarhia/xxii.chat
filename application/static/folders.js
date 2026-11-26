const FOLDERS_KEY = 'xxii:folders';
const ID_LENGTH = 128;
const NAME_LENGTH = 256;
const ICON_LENGTH = 32;
const MAX_FOLDERS = 1000;
const MAX_ENTRIES = 10000;

const byName = (a, b) => a.name.localeCompare(b.name);

const isText = (value, limit) =>
  typeof value === 'string' && value.length <= limit;

const isId = (value) => isText(value, ID_LENGTH) && value !== '';

const isFolder = (value) =>
  isId(value?.id) &&
  isText(value.name, NAME_LENGTH) &&
  value.name !== '' &&
  isText(value.icon, ICON_LENGTH) &&
  isText(value.parent, ID_LENGTH) &&
  Number.isFinite(value.created);

const isEntry = (value) => isId(value?.folder) && isId(value?.item);

const createStore = () => ({ folders: [], entries: [], migrated: false });

const pickFolder = ({ id, name, icon, parent, created }) => ({
  id,
  name,
  icon,
  parent,
  created,
});

const cleanStore = (data) => {
  const store = createStore();
  store.migrated = data?.migrated === true;
  const ids = new Set();
  const folders = Array.isArray(data?.folders) ? data.folders : [];
  for (const value of folders.slice(0, MAX_FOLDERS)) {
    if (!isFolder(value) || ids.has(value.id)) continue;
    ids.add(value.id);
    store.folders.push(pickFolder(value));
  }
  const keys = new Set();
  const entries = Array.isArray(data?.entries) ? data.entries : [];
  for (const value of entries.slice(0, MAX_ENTRIES)) {
    if (!isEntry(value) || !ids.has(value.folder)) continue;
    const key = `${value.folder}/${value.item}`;
    if (keys.has(key)) continue;
    keys.add(key);
    store.entries.push({ folder: value.folder, item: value.item });
  }
  return store;
};

const parseStore = (text) => {
  try {
    return cleanStore(JSON.parse(text));
  } catch {
    return createStore();
  }
};

const readText = (storage, key) => {
  try {
    return storage?.getItem(key) ?? null;
  } catch {
    return null;
  }
};

const writeText = (storage, key, text) => {
  try {
    storage.setItem(key, text);
    return true;
  } catch {
    return false;
  }
};

// Concurrent edits or old replica records can make parents a loop
const isInLoop = (folders, folder) => {
  const seen = new Set();
  let current = folders.get(folder.parent);
  while (current && !seen.has(current.id)) {
    if (current.id === folder.id) return true;
    seen.add(current.id);
    current = folders.get(current.parent);
  }
  return false;
};

const treeOf = (store) => {
  const folders = new Map();
  for (const folder of store.folders) folders.set(folder.id, folder);
  const children = new Map();
  for (const folder of folders.values()) {
    const isNested = folders.has(folder.parent) && !isInLoop(folders, folder);
    const parent = isNested ? folder.parent : '';
    const siblings = children.get(parent) ?? [];
    siblings.push(folder);
    children.set(parent, siblings);
  }
  for (const siblings of children.values()) siblings.sort(byName);
  const items = new Map();
  for (const { folder, item } of store.entries) {
    const placed = items.get(folder) ?? new Set();
    placed.add(item);
    items.set(folder, placed);
  }
  return { folders, children, items };
};

const removeFolder = (store, id) => {
  const target = store.folders.find((folder) => folder.id === id);
  if (!target) return store;
  const parent = target.parent === id ? '' : target.parent;
  const folders = [];
  for (const folder of store.folders) {
    if (folder.id === id) continue;
    folders.push(folder.parent === id ? { ...folder, parent } : folder);
  }
  const entries = store.entries.filter((entry) => entry.folder !== id);
  return { ...store, folders, entries };
};

const ownFolders = (replica, peer) => {
  const store = createStore();
  const own = new Set();
  for (const id of replica.keys('folder')) {
    const record = replica.get(id);
    const isOwn = record.owner === peer && typeof record.name === 'string';
    if (!isOwn) continue;
    own.add(id);
    const { name, icon = '', parent = '', created = 0 } = record;
    store.folders.push({ id, name, icon, parent, created });
  }
  for (const id of replica.keys('entry')) {
    const { folder, item, active } = replica.get(id);
    if (active !== true || !own.has(folder)) continue;
    store.entries.push({ folder, item });
  }
  return cleanStore(store);
};

const mergeStores = (store, extra) => {
  const ids = new Set(store.folders.map((folder) => folder.id));
  const folders = store.folders.slice();
  for (const folder of extra.folders) {
    if (ids.has(folder.id)) continue;
    ids.add(folder.id);
    folders.push(folder);
  }
  const keys = new Set(store.entries.map((e) => `${e.folder}/${e.item}`));
  const entries = store.entries.slice();
  for (const entry of extra.entries) {
    const key = `${entry.folder}/${entry.item}`;
    if (keys.has(key) || !ids.has(entry.folder)) continue;
    keys.add(key);
    entries.push(entry);
  }
  return cleanStore({ folders, entries, migrated: true });
};

class Folders {
  #storage = null;
  #store = createStore();

  constructor(storage) {
    this.#storage = storage;
    this.reload();
  }

  get isMigrated() {
    return this.#store.migrated;
  }

  reload() {
    const text = readText(this.#storage, FOLDERS_KEY);
    this.#store = text === null ? createStore() : parseStore(text);
  }

  migrate(replica, peer) {
    const text = readText(this.#storage, FOLDERS_KEY);
    if (text !== null) this.#store = parseStore(text);
    if (this.#store.migrated) return false;
    this.#store = mergeStores(this.#store, ownFolders(replica, peer));
    this.#save();
    return true;
  }

  list() {
    return this.#store.folders.slice();
  }

  tree() {
    return treeOf(this.#store);
  }

  has(folder, item) {
    const isSame = (entry) => entry.folder === folder && entry.item === item;
    return this.#store.entries.some(isSame);
  }

  create({ id, name, icon, parent = '', created = Date.now() }) {
    const folder = { id, name, icon, parent, created };
    if (!isFolder(folder) || this.#store.folders.length >= MAX_FOLDERS) {
      return null;
    }
    const isTaken = this.#store.folders.some((other) => other.id === id);
    if (isTaken) return null;
    this.#store.folders.push(folder);
    this.#save();
    return folder;
  }

  rename(id, name, icon) {
    const index = this.#store.folders.findIndex((folder) => folder.id === id);
    if (index < 0) return false;
    const folder = { ...this.#store.folders[index], name, icon };
    if (!isFolder(folder)) return false;
    this.#store.folders[index] = folder;
    this.#save();
    return true;
  }

  remove(id) {
    const next = removeFolder(this.#store, id);
    if (next === this.#store) return false;
    this.#store = next;
    this.#save();
    return true;
  }

  place(folder, item) {
    const known = this.#store.folders.some(({ id }) => id === folder);
    const isFull = this.#store.entries.length >= MAX_ENTRIES;
    if (!known || !isId(item) || isFull || this.has(folder, item)) {
      return false;
    }
    this.#store.entries.push({ folder, item });
    this.#save();
    return true;
  }

  unplace(folder, item) {
    const isSame = (entry) => entry.folder === folder && entry.item === item;
    const entries = this.#store.entries.filter((entry) => !isSame(entry));
    if (entries.length === this.#store.entries.length) return false;
    this.#store.entries = entries;
    this.#save();
    return true;
  }

  #save() {
    const text = JSON.stringify(this.#store);
    writeText(this.#storage, FOLDERS_KEY, text);
  }
}

export { FOLDERS_KEY, Folders, parseStore, treeOf, removeFolder, ownFolders };
export { mergeStores };
export { isInLoop };
