import { askConfirm } from './confirm-dialog.js';
import { cloneTemplate } from './view.js';
import {
  initialEdit,
  timelineOf,
  partsOf,
  segmentsOf,
  segmentTimeOf,
} from './recording-edit-logic.js';
import {
  EditHistory,
  timeInputOf,
  timeFromInput,
} from './recording-edit-logic.js';
import { PartPlayer, readPart, playUntil } from './recording-edit-media.js';
import { editFormatOf } from './recording-edit-render.js';
import { saveEdit } from './recording-edit-save.js';

const TIME_KEYS = { ArrowLeft: -1, ArrowDown: -1, ArrowRight: 1, ArrowUp: 1 };
const HANDLES = ['start', 'end', 'cut-start', 'cut-end'];
const DEFAULT_CUT_MS = 1000;
const KEY_STEP_MS = 100;
const RANGE_ERROR = 'Enter a time within the recording, with start before end.';

const selectedCutOf = (draft, index, cut) => {
  const cuts = draft.cuts.slice();
  cuts[index] = cut;
  return { ...draft, cuts };
};

const positioned = (node, start, end, duration) => {
  node.style.left = `${(100 * start) / duration}%`;
  if (end !== null) node.style.width = `${(100 * (end - start)) / duration}%`;
};

const descriptorsOf = (entry) =>
  (entry.segments ?? [{ name: entry.title }]).map(({ name }, index) => ({
    index,
    name,
  }));

class RecordingEditor {
  constructor(entry, hooks) {
    this.entry = entry;
    this.hooks = hooks;
    const template = document.getElementById('recording-editor-template');
    this.dialog = cloneTemplate(template, 'dialog');
    this.video = this.dialog.querySelector('video');
    this.player = new PartPlayer(this.video, hooks.source);
    this.fields = new Map();
    this.invalid = new Set();
    this.nodes = Object.fromEntries(
      [...this.dialog.querySelectorAll('[data-edit]')].map((node) => [
        node.dataset.edit,
        node,
      ]),
    );
    this.nodes.title.textContent = hooks.name;
    this.nodes['copy-title'].value = `${hooks.name} (edited)`;
    this.lifetime = new AbortController();
    this.work = Promise.resolve();
    this.preview = false;
    this.time = 0;
    this.cutIndex = -1;
    this.pendingCut = null;
    this.saving = null;
    this.finalizing = false;
    this.asking = false;
    this.retry = () => this.load();
    this.setStatus('Loading recording…');
    this.bind();
  }

  open() {
    document.body.append(this.dialog);
    this.dialog.showModal();
    this.load();
  }

  async load() {
    const signal = this.lifetime.signal;
    this.nodes.retry.hidden = true;
    this.setStatus('Loading recording…');
    try {
      const parts = await this.hooks.withSource(async () => {
        const descriptors = descriptorsOf(this.entry);
        const measured = [];
        for (const part of descriptors) {
          measured.push(await readPart(this.player, part, signal));
        }
        return partsOf(measured);
      });
      signal.throwIfAborted();
      this.parts = parts;
      this.duration = parts.at(-1).end;
      this.history = new EditHistory(initialEdit(this.duration));
      this.nodes.body.hidden = false;
      this.setStatus('');
      this.paint();
      this.seek(0);
    } catch (error) {
      if (signal.aborted) return;
      this.player.clear();
      this.setStatus(error.message);
      this.nodes.retry.hidden = false;
    }
  }

  get draft() {
    return this.history.draft;
  }

  get dirty() {
    if (!this.history) return false;
    const { start, end, cuts } = this.draft;
    return (
      start !== 0 ||
      end !== this.duration ||
      Boolean(cuts.length || this.pendingCut)
    );
  }

  bind() {
    const { nodes, dialog } = this;
    const actions = {
      close: () => this.requestClose(),
      retry: () => this.retry(),
      play: () => this.play(),
      'new-cut': () => this.newCut(),
      'apply-cut': () => this.applyCut(),
      'cancel-cut': () => this.selectCut(-1),
      'remove-cut': () => this.removeCut(),
      undo: () => this.restore('undo'),
      redo: () => this.restore('redo'),
      discard: () => this.discard(),
      preview: () => this.togglePreview(),
      save: () => this.save(),
      'cancel-save': () => this.saving?.abort(),
    };
    for (const [name, action] of Object.entries(actions)) {
      nodes[name].onclick = action;
    }
    nodes.scrub.oninput = () => this.seek(Number(nodes.scrub.value));
    nodes['copy-title'].oninput = () => this.paintSave();
    for (const name of HANDLES) this.bindHandle(name);
    dialog.addEventListener('keydown', (event) => event.stopPropagation());
    dialog.addEventListener('cancel', (event) => {
      event.preventDefault();
      this.requestClose();
    });
    window.addEventListener(
      'beforeunload',
      (event) => {
        if (!this.dirty && !this.saving) return;
        event.preventDefault();
        event.returnValue = true;
      },
      { signal: this.lifetime.signal },
    );
  }

  bindHandle(name) {
    const input = this.dialog.querySelector(`[data-time="${name}"]`);
    const handle = this.dialog.querySelector(`[data-handle="${name}"]`);
    handle.setAttribute('role', 'slider');
    handle.setAttribute('aria-valuemin', '0');
    this.fields.set(name, { input, handle });
    input.onchange = () =>
      this.applyTime(name, timeFromInput(input.value), input);
    handle.onkeydown = (event) => {
      const direct = TIME_KEYS[event.key];
      if (!direct && !['Home', 'End'].includes(event.key)) return;
      event.preventDefault();
      const move =
        this.timeOf(name) + direct * (event.shiftKey ? 1000 : KEY_STEP_MS);
      const edge = event.key === 'Home' ? 0 : this.duration;
      const time = direct ? move : edge;
      this.applyTime(name, this.clampTime(name, time));
    };
    handle.onpointerdown = (event) => {
      if (event.button !== 0) return;
      event.preventDefault();
      handle.focus();
      handle.setPointerCapture(event.pointerId);
      this.drag = { name, time: this.timeOf(name), pointer: event.pointerId };
    };
    handle.onpointermove = (event) => {
      if (this.drag?.pointer !== event.pointerId) return;
      const track = this.nodes.track.getBoundingClientRect();
      const time = Math.round(
        ((event.clientX - track.left) / track.width) * this.duration,
      );
      this.drag.time = this.clampTime(name, time);
      this.paintRanges();
      this.seek(this.drag.time);
    };
    const finish = (event, commit) => {
      if (this.drag?.pointer !== event.pointerId) return;
      const { time } = this.drag;
      this.drag = null;
      if (commit) this.applyTime(name, time);
      else this.paint();
    };
    handle.onpointerup = (event) => finish(event, true);
    handle.onlostpointercapture = (event) => finish(event, false);
  }

  timeOf(name) {
    if (name.startsWith('cut-')) return this.pendingCut?.[name.slice(4)] ?? 0;
    return this.draft[name];
  }

  clampTime(name, time) {
    const isCut = name.startsWith('cut-');
    const { start, end } = isCut ? this.pendingCut : this.draft;
    if (name.endsWith('start')) return Math.max(0, Math.min(end - 1, time));
    return Math.max(start + 1, Math.min(this.duration, time));
  }

  applyTime(name, time, input) {
    if (!Number.isSafeInteger(time) || time !== this.clampTime(name, time)) {
      this.invalid.add(name);
      this.setStatus(RANGE_ERROR);
      input?.setAttribute('aria-invalid', 'true');
      this.paintSave();
      return;
    }
    this.invalid.delete(name);
    if (name.startsWith('cut-')) {
      this.pendingCut = { ...this.pendingCut, [name.slice(4)]: time };
    } else {
      this.history.apply({ ...this.draft, [name]: time });
    }
    this.setStatus('');
    this.paint();
    this.seek(time);
  }

  newCut() {
    const start = Math.min(this.time, this.duration - 1);
    const end = Math.min(this.duration, start + DEFAULT_CUT_MS);
    this.cutIndex = this.draft.cuts.length;
    this.pendingCut = { start, end };
    this.paint();
    this.fields.get('cut-start').input.focus();
  }

  selectCut(index) {
    this.cutIndex = index;
    const cut = this.draft.cuts[index];
    this.pendingCut = cut ?? null;
    this.invalid.delete('cut-start');
    this.invalid.delete('cut-end');
    this.setStatus('');
    this.paint();
    if (cut) {
      this.seek(cut.start);
      this.fields.get('cut-start').input.focus();
    } else {
      this.nodes['new-cut'].focus();
    }
  }

  applyCut() {
    this.history.apply(
      selectedCutOf(this.draft, this.cutIndex, this.pendingCut),
    );
    this.selectCut(-1);
  }

  removeCut() {
    const cuts = this.draft.cuts.filter(
      (cut, index) => index !== this.cutIndex,
    );
    this.history.apply({ ...this.draft, cuts });
    this.selectCut(-1);
  }

  restore(action) {
    this.invalid.clear();
    this.history[action]();
    this.selectCut(-1);
  }

  async discard() {
    const confirmed = await this.confirmDiscard(false);
    if (!confirmed) return;
    this.preview = false;
    this.time = 0;
    this.invalid.clear();
    this.history = new EditHistory(initialEdit(this.duration));
    this.selectCut(-1);
    this.seek(0);
  }

  togglePreview() {
    this.preview = !this.preview;
    this.time = 0;
    this.paint();
    this.seek(0);
  }

  get segments() {
    const kept = this.preview
      ? this.timeline.kept
      : [{ start: 0, end: this.duration, output: 0 }];
    return segmentsOf(this.parts, kept);
  }

  runPlayback(run) {
    this.playback?.abort();
    if (!this.nodes.retry.hidden) this.setStatus('');
    this.nodes.retry.hidden = true;
    const control = new AbortController();
    this.playback = control;
    const signal = AbortSignal.any([control.signal, this.lifetime.signal]);
    this.work = this.work.then(async () => {
      if (signal.aborted) return;
      try {
        await run(signal);
      } catch (error) {
        if (!signal.aborted) {
          this.setStatus(error.message);
          this.nodes.retry.hidden = false;
          this.retry = () => this.runPlayback(run);
        }
      }
    });
  }

  seek(time) {
    this.paintTime(time);
    const position = segmentTimeOf(this.segments, time);
    this.runPlayback((signal) =>
      this.player.seek(position.segment.part, position.time, signal),
    );
    this.nodes.play.textContent = 'play';
  }

  play() {
    if (this.nodes.play.textContent === 'pause') {
      return void this.seek(this.time);
    }
    const segments = this.segments;
    const elapsed = this.time < Number(this.nodes.scrub.max) ? this.time : 0;
    const first = segmentTimeOf(segments, elapsed);
    this.runPlayback(async (signal) => {
      this.nodes.play.textContent = 'pause';
      try {
        for (const segment of segments.slice(segments.indexOf(first.segment))) {
          const { part, start, end, output } = segment;
          const from = segment === first.segment ? first.time : start;
          await this.player.seek(part, from, signal);
          await playUntil(this.video, end, signal, null, (time) => {
            this.paintTime(output + Math.max(0, time - start));
          });
        }
      } finally {
        if (!signal.aborted) this.nodes.play.textContent = 'play';
      }
    });
  }

  paintTime(value) {
    const duration = this.preview ? this.timeline.duration : this.duration;
    this.time = Math.min(duration, Math.max(0, Math.round(value)));
    this.nodes.scrub.value = this.time;
    const time = timeInputOf(this.time);
    this.nodes.time.textContent = `${time} / ${timeInputOf(duration)}`;
    this.nodes.scrub.setAttribute('aria-valuetext', time);
  }

  paintRanges() {
    const draft = this.draft;
    const { track, removals, boundaries } = this.nodes;
    const drag = this.drag;
    const start = drag?.name === 'start' ? drag.time : draft.start;
    const end = drag?.name === 'end' ? drag.time : draft.end;
    const ranges = [
      [0, start],
      [end, this.duration],
    ];
    const cuts = draft.cuts.slice();
    if (this.pendingCut) {
      const cut = { ...this.pendingCut };
      if (drag?.name.startsWith('cut-')) cut[drag.name.slice(4)] = drag.time;
      cuts[this.cutIndex] = cut;
    }
    for (const cut of cuts) ranges.push([cut.start, cut.end]);
    removals.replaceChildren(
      ...ranges
        .filter(([a, b]) => a < b)
        .map(([a, b]) => {
          const mark = document.createElement('span');
          positioned(mark, a, b, this.duration);
          return mark;
        }),
    );
    boundaries.replaceChildren(
      ...this.parts.slice(1).map(({ index, start }) => {
        const mark = document.createElement('span');
        mark.textContent = `Part ${index + 1}`;
        positioned(mark, start, null, this.duration);
        return mark;
      }),
    );
    track.hidden = this.preview;
    for (const [name, { input, handle }] of this.fields) {
      const time =
        this.drag?.name === name ? this.drag.time : this.timeOf(name);
      const text = timeInputOf(time);
      if (!this.invalid.has(name)) {
        if (input.value !== text) input.value = text;
        input.removeAttribute('aria-invalid');
      }
      positioned(handle, time, null, this.duration);
      handle.title = text;
      handle.setAttribute('aria-valuemax', String(this.duration));
      handle.setAttribute('aria-valuenow', String(time));
      handle.setAttribute('aria-valuetext', text);
      handle.hidden = name.startsWith('cut-') && !this.pendingCut;
    }
  }

  paint() {
    const { nodes, draft } = this;
    this.timeline = timelineOf(this.duration, draft);
    this.paintRanges();
    nodes.scrub.max = this.preview ? this.timeline.duration : this.duration;
    this.paintTime(this.time);
    nodes['source-controls'].hidden = this.preview;
    nodes['cut-fields'].hidden = !this.pendingCut;
    nodes['remove-cut'].hidden = this.cutIndex >= draft.cuts.length;
    nodes['new-cut'].disabled = Boolean(this.pendingCut);
    nodes.undo.disabled = !this.history.canUndo;
    nodes.redo.disabled = !this.history.canRedo;
    nodes.discard.disabled = !this.dirty;
    nodes.preview.textContent = this.preview ? 'back to edit' : 'preview edit';
    nodes.scrub.setAttribute(
      'aria-label',
      this.preview ? 'Edited playhead' : 'Source playhead',
    );
    nodes.cuts.replaceChildren(
      ...draft.cuts.map(({ start, end }, index) => {
        const item = document.createElement('li');
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'link-btn';
        const range = `${timeInputOf(start)}–${timeInputOf(end)}`;
        button.textContent = `Cut ${index + 1} · ${range}`;
        button.setAttribute('aria-pressed', String(this.cutIndex === index));
        button.onclick = () => this.selectCut(index);
        item.append(button);
        return item;
      }),
    );
    this.paintSave();
  }

  paintSave() {
    const timeline = this.timeline;
    const { nodes } = this;
    const segments = timeline.kept ? segmentsOf(this.parts, timeline.kept) : [];
    const audio = segments.some(({ part }) => part.audio);
    this.format = editFormatOf(audio);
    const canRender = Boolean(
      this.video.requestVideoFrameCallback &&
      globalThis.HTMLCanvasElement?.prototype.captureStream &&
      (!audio || globalThis.AudioContext) &&
      this.format,
    );
    const error =
      timeline.error ||
      (!canRender && 'This browser cannot render an edited recording.');
    nodes.preview.disabled = Boolean(
      timeline.error || this.pendingCut || this.invalid.size,
    );
    nodes['apply-cut'].disabled =
      this.invalid.has('cut-start') || this.invalid.has('cut-end');
    nodes.validation.textContent = error || '';
    nodes.validation.hidden = !error;
    nodes.format.textContent = canRender
      ? this.format.extension.toUpperCase()
      : 'Unavailable';
    nodes.save.disabled = Boolean(
      error ||
      this.invalid.size ||
      !timeline.changed ||
      this.pendingCut ||
      !nodes['copy-title'].value.trim() ||
      this.saving,
    );
  }

  async save() {
    const { nodes, timeline, format } = this;
    if (this.saving || nodes.save.disabled) return;
    const title = nodes['copy-title'].value.trim();
    this.playback?.abort();
    nodes.play.textContent = 'play';
    const control = new AbortController();
    this.saving = control;
    nodes.body.disabled = true;
    nodes.retry.hidden = true;
    nodes['save-status'].hidden = false;
    nodes['cancel-save'].disabled = false;
    nodes.progress.value = 0;
    nodes.progress.max = timeline.duration;
    this.setStatus('Saving edited copy…');
    try {
      const id = await this.hooks.withSource(() =>
        saveEdit({
          signal: AbortSignal.any([control.signal, this.lifetime.signal]),
          title,
          entry: this.entry,
          parts: this.parts,
          timeline,
          format,
          source: this.hooks.source,
          progress: (time) => {
            nodes.progress.value = time;
          },
          finalizing: () => {
            this.finalizing = true;
            nodes['cancel-save'].disabled = true;
          },
        }),
      );
      this.hooks.saved(id);
    } catch (error) {
      if (this.lifetime.signal.aborted) return;
      this.setStatus(
        control.signal.aborted
          ? 'Saving canceled.'
          : error.message || 'Could not save the edited copy.',
      );
    } finally {
      this.saving = null;
      this.finalizing = false;
      nodes.body.disabled = false;
      nodes['save-status'].hidden = true;
      this.paintSave();
    }
  }

  setStatus(text) {
    this.nodes.status.textContent = text;
  }

  async confirmDiscard(closing) {
    if (this.asking || this.finalizing) return false;
    if (!this.dirty && !this.saving) return true;
    this.asking = true;
    try {
      return await askConfirm({
        title: 'Discard changes?',
        lines: [
          closing
            ? 'Your edits will be lost. The original recording stays.'
            : 'Restore the original timeline and clear its edit history.',
        ],
        action: 'discard changes',
      });
    } finally {
      this.asking = false;
    }
  }

  async requestClose() {
    if (await this.confirmDiscard(true)) this.hooks.close();
  }

  close() {
    this.lifetime.abort();
    this.player.clear();
    this.dialog.close();
    this.dialog.remove();
  }
}

export { RecordingEditor };
