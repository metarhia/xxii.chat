import { generateUUID } from './metautil.js';
import { STORAGE_KEY, DESTINATIONS_EVENT } from './whip.js';
import { MAX_ENABLED, DEFAULT_BITRATE } from './whip.js';
import { problemOf, destinationOf } from './whip.js';
import { readDestinations, writeDestinations } from './whip.js';
import { createDestinationRow, createEditor } from './stream-panel.js';
import { fillEditor, readEditor } from './stream-panel.js';

const LIMIT_TEXT = `At most ${MAX_ENABLED} destinations can go live at once`;
const EMPTY_TEXT = 'No destinations yet';

const create = (tag, className, text = '') => {
  const element = document.createElement(tag);
  element.className = className;
  element.textContent = text;
  return element;
};

const createButton = (action, text) => {
  const button = create('button', 'link-btn', text);
  button.type = 'button';
  button.dataset.streamAction = action;
  return button;
};

const lower = (root) => {
  for (const button of root.querySelectorAll('button')) {
    button.textContent = button.textContent.toLowerCase();
  }
};

const createReveal = (editor) => {
  const token = editor.querySelector('[data-stream="token"]');
  const button = create('button', 'link-btn', 'show token');
  button.type = 'button';
  button.onclick = () => {
    const isHidden = token.type === 'password';
    token.type = isHidden ? 'text' : 'password';
    button.textContent = isHidden ? 'hide token' : 'show token';
  };
  token.closest('label').after(button);
};

const sameList = (a, b) => JSON.stringify(a) === JSON.stringify(b);

class StreamingPage {
  #draft = null;
  #shown = null;
  #notice = '';

  constructor(root) {
    const box = root.querySelector('#settings-streaming');
    this.list = create('ul', 'call-roster');
    this.empty = create('p', 'settings-note', EMPTY_TEXT);
    this.add = createButton('add-destination', 'add destination');
    this.editor = createEditor();
    this.note = create('p', 'settings-note');
    this.note.setAttribute('role', 'status');
    lower(this.editor);
    createReveal(this.editor);
    box.append(this.list, this.empty, this.add, this.editor, this.note);
    this.destinations = readDestinations();
    this.key = '';
    box.addEventListener('click', (event) => this.click(event));
    box.addEventListener('change', (event) => this.change(event.target));
  }

  click(event) {
    const button = event.target.closest('[data-stream-action]');
    if (!button) return;
    const { streamAction: action, id } = button.dataset;
    this.#notice = '';
    if (action === 'save-destination') this.#saveDraft();
    else if (action === 'add-destination') this.#addDraft();
    else if (action === 'edit-destination') this.#editDraft(id);
    else if (action === 'cancel-destination') this.#draft = null;
    else if (action === 'delete-destination') this.#remove(id);
    this.paint();
  }

  change(control) {
    if (control.dataset.stream !== 'enabled') return;
    const { id } = control.dataset;
    const others = this.destinations.filter((item) => item.id !== id);
    const count = others.filter((item) => item.enabled).length;
    this.#notice = '';
    if (control.checked && count >= MAX_ENABLED) this.#notice = LIMIT_TEXT;
    else this.#save(this.#toggled(id, control.checked));
    this.paint();
  }

  reload(key) {
    if (key !== null && key !== STORAGE_KEY) return;
    this.destinations = readDestinations();
    this.paint();
  }

  paint() {
    const rows = this.destinations;
    const key = JSON.stringify(
      rows.map(({ id, name, url }) => [id, name, url]),
    );
    if (key !== this.key) {
      this.key = key;
      const items = rows.map(createDestinationRow);
      for (const item of items) lower(item);
      this.list.replaceChildren(...items);
    }
    for (const row of this.list.children) {
      const found = rows.find((item) => item.id === row.dataset.id);
      row.querySelector('[data-stream="enabled"]').checked = found.enabled;
    }
    this.empty.hidden = rows.length > 0;
    this.#paintEditor();
    this.note.textContent = this.#notice;
    this.note.hidden = this.#notice === '';
  }

  #paintEditor() {
    const draft = this.#draft;
    this.editor.hidden = !draft;
    this.add.hidden = Boolean(draft);
    if (!draft) {
      this.#shown = null;
      return;
    }
    if (this.#shown === draft) return;
    this.#shown = draft;
    fillEditor(this.editor, draft);
  }

  #toggled(id, enabled) {
    const flip = (item) => (item.id === id ? { ...item, enabled } : item);
    return this.destinations.map(flip);
  }

  #addDraft() {
    const empty = { name: '', url: '', token: '', bitrate: DEFAULT_BITRATE };
    this.#draft = { id: generateUUID(), enabled: false, ...empty };
  }

  #editDraft(id) {
    const found = this.destinations.find((item) => item.id === id);
    if (found) this.#draft = { ...found };
  }

  #remove(id) {
    if (this.#draft?.id === id) this.#draft = null;
    this.#save(this.destinations.filter((item) => item.id !== id));
  }

  #saveDraft() {
    const draft = this.#draft;
    if (!draft) return;
    const raw = { id: draft.id, enabled: draft.enabled };
    const destination = { ...raw, ...readEditor(this.editor) };
    const problem = problemOf(destination);
    const saved = destinationOf(destination);
    if (problem || !saved) {
      this.#notice = problem;
      return;
    }
    const exists = this.destinations.some((item) => item.id === draft.id);
    const replace = (item) => (item.id === draft.id ? saved : item);
    const list = exists
      ? this.destinations.map(replace)
      : this.destinations.concat(saved);
    this.#draft = null;
    this.#save(list);
  }

  #save(list) {
    const isSaved = writeDestinations(list);
    if (!isSaved) {
      this.#notice = 'Could not save destinations in this browser';
    } else if (!sameList(list, this.destinations)) {
      window.dispatchEvent(new Event(DESTINATIONS_EVENT));
    }
    this.destinations = list;
  }
}

export { StreamingPage };
