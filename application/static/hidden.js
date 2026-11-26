const HIDDEN_KEY = 'xxii:hidden';
const KINDS = ['chats', 'feeds', 'contacts'];
const ID_LENGTH = 128;
const MAX_HIDDEN = 10000;

const isId = (value) =>
  typeof value === 'string' && value !== '' && value.length <= ID_LENGTH;

const idOf = (value) => (typeof value === 'object' ? value?.id : value);

const atOf = (value) => {
  const at = typeof value === 'object' ? value?.at : 0;
  return Number.isFinite(at) ? at : 0;
};

const cleanKind = (values) => {
  const items = new Map();
  const list = Array.isArray(values) ? values : [];
  for (const value of list.slice(0, MAX_HIDDEN)) {
    const id = idOf(value);
    if (isId(id) && !items.has(id)) items.set(id, atOf(value));
  }
  return items;
};

const createState = () => ({
  chats: new Map(),
  feeds: new Map(),
  contacts: new Map(),
});

const parseHidden = (text) => {
  const state = createState();
  try {
    const data = JSON.parse(text);
    for (const kind of KINDS) state[kind] = cleanKind(data?.[kind]);
  } catch {
    return state;
  }
  return state;
};

const dumpHidden = (state) => {
  const dump = {
    chats: Array.from(state.chats.keys()),
    feeds: Array.from(state.feeds.keys()),
    contacts: [],
  };
  for (const [id, at] of state.contacts) dump.contacts.push({ id, at });
  return JSON.stringify(dump);
};

const isReturning = (replica, pair, me, at) => {
  for (const id of replica.keys('message')) {
    const record = replica.get(id);
    const isNew = record.timestamp > at;
    const isTheirs = record.chat === pair && record.author !== me;
    if (isNew && isTheirs && typeof record.deleted !== 'number') return true;
  }
  return false;
};

class Hidden {
  #storage = null;
  #state = createState();

  constructor(storage) {
    this.#storage = storage;
    this.reload();
  }

  reload() {
    let text = null;
    try {
      text = this.#storage?.getItem(HIDDEN_KEY) ?? null;
    } catch {
      text = null;
    }
    this.#state = text === null ? createState() : parseHidden(text);
  }

  has(kind, id) {
    return this.#state[kind].has(id);
  }

  size(kind) {
    return this.#state[kind].size;
  }

  hiddenAt(kind, id) {
    return this.#state[kind].get(id) ?? 0;
  }

  ids(kind) {
    return Array.from(this.#state[kind].keys());
  }

  hide(kind, id, at = Date.now()) {
    if (!isId(id) || this.#state[kind].size >= MAX_HIDDEN) return false;
    this.#state[kind].set(id, kind === 'contacts' ? at : 0);
    this.#save();
    return true;
  }

  restore(kind, id) {
    if (!this.#state[kind].delete(id)) return false;
    this.#save();
    return true;
  }

  #save() {
    try {
      this.#storage.setItem(HIDDEN_KEY, dumpHidden(this.#state));
    } catch {
      return false;
    }
    return true;
  }
}

export { HIDDEN_KEY, KINDS, Hidden, parseHidden, dumpHidden, isReturning };
