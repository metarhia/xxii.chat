import { generateUUID } from './metautil.js';
import { MAX_ENABLED, DEFAULT_BITRATE } from './whip.js';
import { WhipStream, problemOf, destinationOf } from './whip.js';
import { readDestinations, writeDestinations } from './whip.js';
import { createDestinationRow, fillEditor } from './stream-panel.js';
import { readEditor } from './stream-panel.js';

const OWNER = 'stream';
const LIMIT_TEXT = `At most ${MAX_ENABLED} destinations can go live at once`;
const NO_DESTINATION = 'Enable a destination to go live';
const NO_BROWSER = 'This browser cannot stream';

const isSupported = () => typeof globalThis.RTCPeerConnection === 'function';

const toggled = (item, id, control) =>
  item.id === id ? { ...item, enabled: control.checked } : item;

class Streaming {
  #stage = null;
  #streams = new Map();
  #draft = null;
  #shown = null;
  #notice = '';
  #queue = Promise.resolve();
  #isFlagged = false;
  #isHolding = false;
  #isDisposed = false;

  constructor(stage) {
    this.#stage = stage;
    this.destinations = readDestinations();
  }

  get isActive() {
    for (const stream of this.#streams.values()) {
      if (stream.isActive) return true;
    }
    return false;
  }

  get isFlagged() {
    return this.#isFlagged;
  }

  get canGoLive() {
    return isSupported() && this.destinations.some((item) => item.enabled);
  }

  toggle() {
    return this.isActive ? this.stop() : this.goLive();
  }

  async goLive() {
    if (this.isActive || this.#isDisposed || !this.canGoLive) return;
    const stage = this.#stage;
    const recording = stage.recording;
    if (stage.session?.phase !== 'joined' || !recording) {
      return void this.#warn('Join the call to go live');
    }
    this.#notice = '';
    this.#streams.clear();
    let program = null;
    try {
      program = recording.hold(OWNER);
    } catch (error) {
      return void this.#warn(`Could not start the program: ${error.message}`);
    }
    this.#isHolding = true;
    const { call, endpoint } = stage.session;
    const relay = (args) => stage.hooks.stream({ call, endpoint, ...args });
    const tracks = [program.compositor.track, program.mixer.track];
    const chosen = this.destinations.filter((item) => item.enabled);
    for (const destination of chosen) {
      const stream = new WhipStream({
        destination,
        tracks,
        iceServers: () => this.#iceServers(),
        relay,
        onChange: () => this.#changed(),
        onNotice: (text) => this.#warn(text),
      });
      this.#streams.set(destination.id, stream);
    }
    for (const stream of this.#streams.values()) {
      stream.start().catch((error) => stage.hooks.fail(error));
    }
  }

  async stop() {
    const streams = [...this.#streams.values()];
    await Promise.all(streams.map((stream) => stream.stop()));
    this.#changed();
  }

  dispose() {
    this.#isDisposed = true;
    for (const stream of this.#streams.values()) {
      stream.stop().catch((error) => this.#stage.hooks.fail(error));
    }
  }

  abandon() {
    for (const stream of this.#streams.values()) stream.abandon();
  }

  change(control) {
    const { stream, id } = control.dataset;
    if (stream !== 'enabled') return;
    const found = this.destinations.find((item) => item.id === id);
    const others = this.destinations.filter((item) => item.id !== id);
    const count = others.filter((item) => item.enabled).length;
    this.#notice = '';
    if (!found || this.isActive) {
      this.#notice = 'Stop the stream to change destinations';
    } else if (control.checked && count >= MAX_ENABLED) {
      this.#notice = LIMIT_TEXT;
    } else {
      this.#save(this.destinations.map((item) => toggled(item, id, control)));
    }
    this.#stage.recording?.paint();
  }

  action(control) {
    const { streamAction, id } = control.dataset;
    if (streamAction === 'save-destination') return void this.#saveDraft();
    this.#notice = '';
    if (this.isActive && streamAction !== 'cancel-destination') {
      this.#notice = 'Stop the stream to change destinations';
    } else if (streamAction === 'add-destination') {
      const bitrate = DEFAULT_BITRATE;
      const empty = { name: '', url: '', token: '', bitrate };
      this.#draft = { id: generateUUID(), enabled: false, ...empty };
    } else if (streamAction === 'edit-destination') {
      const found = this.destinations.find((item) => item.id === id);
      if (found) this.#draft = { ...found };
    } else if (streamAction === 'cancel-destination') {
      this.#draft = null;
    } else if (streamAction === 'delete-destination') {
      if (this.#draft?.id === id) this.#draft = null;
      this.#save(this.destinations.filter((item) => item.id !== id));
    }
    this.#stage.recording?.paint();
  }

  paint(panel) {
    const section = panel.querySelector('[data-studio-section="destinations"]');
    if (!section) return;
    const list = section.querySelector('[data-stream-list]');
    const key = JSON.stringify(
      this.destinations.map(({ id, name, url }) => [id, name, url]),
    );
    if (list.dataset.key !== key) {
      list.dataset.key = key;
      list.replaceChildren(...this.destinations.map(createDestinationRow));
    }
    const isActive = this.isActive;
    for (const row of list.children) {
      this.#paintRow(row, isActive);
    }
    this.#paintEditor(section);
    const button = section.querySelector('[data-action="go-live"]');
    button.textContent = isActive ? 'Stop live' : 'Go live';
    button.setAttribute('aria-pressed', `${isActive}`);
    button.disabled = !isActive && !this.canGoLive;
    const note = section.querySelector('.stream-note');
    note.textContent = this.#noteText();
    note.hidden = note.textContent === '';
  }

  #paintRow(row, isActive) {
    const destination = this.destinations.find(
      (item) => item.id === row.dataset.id,
    );
    if (!destination) return;
    const check = row.querySelector('[data-stream="enabled"]');
    check.checked = destination.enabled;
    check.disabled = isActive;
    for (const button of row.querySelectorAll('button')) {
      button.disabled = isActive;
    }
    const text = this.#streams.get(destination.id)?.text ?? '';
    const status = row.querySelector('.stream-status');
    if (status.textContent !== text) status.textContent = text;
  }

  #paintEditor(section) {
    const editor = section.querySelector('[data-stream-editor]');
    const draft = this.#draft;
    editor.hidden = !draft;
    if (!draft) {
      this.#shown = null;
      return;
    }
    if (this.#shown === draft) return;
    this.#shown = draft;
    fillEditor(editor, draft);
  }

  #noteText() {
    if (this.#notice) return this.#notice;
    if (!isSupported()) return NO_BROWSER;
    if (!this.canGoLive && !this.isActive) return NO_DESTINATION;
    return '';
  }

  #save(destinations) {
    const isSaved = writeDestinations(destinations);
    this.destinations = destinations;
    if (!isSaved) this.#notice = 'Could not save destinations in this browser';
  }

  #saveDraft() {
    const draft = this.#draft;
    const stage = this.#stage;
    const editor = stage.host?.querySelector('[data-stream-editor]');
    if (!draft || !editor) return;
    const raw = { id: draft.id, enabled: draft.enabled, ...readEditor(editor) };
    const problem = problemOf(raw);
    const destination = destinationOf(raw);
    if (problem || !destination) {
      this.#notice = problem;
    } else {
      const exists = this.destinations.some((item) => item.id === draft.id);
      const list = exists
        ? this.destinations.map((item) =>
            item.id === draft.id ? destination : item,
          )
        : this.destinations.concat(destination);
      this.#notice = '';
      this.#draft = null;
      this.#save(list);
    }
    stage.recording?.paint();
  }

  async #iceServers() {
    try {
      const configuration = await this.#stage.hooks.ice?.();
      return configuration?.iceServers ?? [];
    } catch {
      return [];
    }
  }

  #warn(text) {
    this.#notice = text;
    const stage = this.#stage;
    stage.hooks.notice?.(text, stage.announcements);
    if (!this.#isDisposed) stage.recording?.paint();
  }

  #changed() {
    if (this.#isDisposed) return;
    const stage = this.#stage;
    const streams = [...this.#streams.values()];
    const isActive = streams.some((stream) => stream.isActive);
    const isLive = streams.some((stream) => stream.state === 'live');
    if (isLive && !this.#isFlagged) {
      this.#isFlagged = true;
      this.#send(true);
    }
    if (!isActive && this.#isFlagged) {
      this.#isFlagged = false;
      this.#send(false);
    }
    if (!isActive && this.#isHolding) {
      this.#isHolding = false;
      stage.recording?.unhold(OWNER);
    }
    stage.paintLive?.();
    stage.recording?.paint();
  }

  #send(live) {
    const hooks = this.#stage.hooks;
    const update = () => hooks.update({ live });
    const warn = (error) => {
      const text = `Could not tell the call about the stream: ${error.message}`;
      hooks.notice?.(text);
    };
    this.#queue = this.#queue.then(update).catch(warn);
  }
}

export { Streaming };
