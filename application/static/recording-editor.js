import { askConfirm } from './confirm-dialog.js';
import { cloneTemplate } from './view.js';
import {
  initialEdit,
  timelineOf,
  partsOf,
  segmentsOf,
  segmentTimeOf,
  remapEdit,
} from './recording-edit-logic.js';
import {
  EditHistory,
  timeInputOf,
  timeFromInput,
} from './recording-edit-logic.js';
import { PartPlayer, readPart, playUntil } from './recording-edit-media.js';
import { editFormatOf } from './recording-edit-render.js';
import { saveEdit } from './recording-edit-save.js';
import {
  editOptionsOf,
  changedOptions,
  optionsError,
} from './video-edit-options.js';
import {
  outputFrameOf,
  drawVideoFrame,
  encodingOf,
} from './video-edit-options.js';
import { findSilentCuts } from './video-edit-silence.js';
import { isVideoFile } from './video-library.js';
import { pickExportFile, mediaNameOf } from './recording-export.js';
import { sizeText } from './recording-files.js';

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
    localIndex: index,
    entry,
    key: crypto.randomUUID(),
    name,
  }));

const fileDescriptor = (file) => ({
  index: 0,
  key: crypto.randomUUID(),
  name: file.name,
  file,
});

const optionValue = (input) => {
  if (input.type === 'checkbox') return input.checked;
  if (
    input.type === 'number' ||
    ['speed', 'rotation', 'resolution'].includes(input.dataset.option)
  ) {
    return Number(input.value);
  }
  return input.value;
};

class RecordingEditor {
  constructor(entry, hooks) {
    this.entry = entry;
    this.hooks = hooks;
    const template = document.getElementById('recording-editor-template');
    this.dialog = cloneTemplate(template, 'dialog');
    this.video = this.dialog.querySelector('video');
    this.player = new PartPlayer(this.video, hooks.source);
    this.fields = new Map();
    this.optionInputs = this.dialog.querySelectorAll('[data-option]');
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
      const parts = partsOf(
        await this.measure(descriptorsOf(this.entry), signal),
      );
      signal.throwIfAborted();
      this.parts = parts;
      this.original = parts;
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

  async measure(descriptors, signal) {
    return this.hooks.withSource(descriptors, async () => {
      const probe = new PartPlayer(
        document.createElement('video'),
        this.hooks.source,
      );
      const measured = [];
      try {
        for (const part of descriptors) {
          measured.push(await readPart(probe, part, signal));
        }
        return measured;
      } finally {
        probe.clear();
      }
    });
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
      this.clipsChanged ||
      changedOptions(editOptionsOf(this.draft)) ||
      Boolean(cuts.length || this.pendingCut)
    );
  }

  get clipsChanged() {
    return (
      this.parts.length !== this.original.length ||
      this.parts.some(({ key }, index) => key !== this.original[index]?.key)
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
      'save-as': () => this.save(true),
      'add-videos': () => nodes['video-files'].click(),
      'add-recording': () => this.addRecording(),
      silence: () => this.cutSilence(),
      'cancel-save': () => (this.saving ?? this.tool)?.abort(),
    };
    for (const [name, action] of Object.entries(actions)) {
      nodes[name].onclick = action;
    }
    nodes.scrub.oninput = () => this.seek(Number(nodes.scrub.value));
    nodes['copy-title'].oninput = () => this.paintSave();
    nodes['video-files'].onchange = () => {
      const files = Array.from(nodes['video-files'].files);
      nodes['video-files'].value = '';
      if (files.length > 0) {
        this.addParts(files.filter(isVideoFile).map(fileDescriptor));
      }
    };
    for (const input of this.optionInputs) {
      input.onchange = () => this.updateOption(input);
    }
    const sources = this.hooks.library();
    nodes['library-source'].replaceChildren(
      ...sources.map(({ id, name }) => {
        const option = document.createElement('option');
        option.value = id;
        option.textContent = name;
        return option;
      }),
    );
    nodes['add-recording'].disabled = !sources.length;
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

  updateOption(input) {
    const options = {
      ...editOptionsOf(this.draft),
      [input.dataset.option]: optionValue(input),
    };
    this.history.apply({ ...this.draft, options });
    this.paint();
    if (this.preview && !this.timeline.error) this.seek(this.time);
  }

  addRecording() {
    const id = this.nodes['library-source'].value;
    const recording = this.hooks.library().find((item) => item.id === id);
    if (recording) this.addParts(descriptorsOf(recording.entry));
  }

  async runTool(title, run) {
    if (this.tool || this.saving) return;
    const control = new AbortController();
    const signal = AbortSignal.any([control.signal, this.lifetime.signal]);
    this.tool = control;
    this.playback?.abort();
    this.nodes.play.textContent = 'play';
    this.nodes.body.disabled = true;
    this.nodes['save-status'].hidden = false;
    this.nodes['cancel-save'].disabled = false;
    this.nodes['cancel-save'].textContent = 'cancel';
    this.nodes.progress.removeAttribute('value');
    this.setStatus(title);
    try {
      await run(signal);
    } catch (error) {
      if (!this.lifetime.signal.aborted) {
        this.setStatus(signal.aborted ? 'Canceled.' : error.message);
      }
    } finally {
      this.tool = null;
      this.nodes.body.disabled = false;
      this.nodes['save-status'].hidden = true;
      this.paintSave();
    }
  }

  addParts(descriptors) {
    if (!descriptors.length) {
      this.setStatus('Choose a video file.');
      return;
    }
    this.runTool('Reading video clips…', async (signal) => {
      const parts = await this.measure(descriptors, signal);
      signal.throwIfAborted();
      this.replaceParts([...this.parts, ...parts]);
    });
  }

  replaceParts(items) {
    this.playback?.abort();
    const parts = partsOf(items);
    const draft = remapEdit(this.draft, this.parts, parts);
    this.history.apply({ ...draft, sourceParts: parts });
    this.parts = parts;
    this.duration = parts.at(-1).end;
    this.preview = false;
    this.invalid.clear();
    this.selectCut(-1);
    this.seek(0);
  }

  cutSilence() {
    const minimum = Number(this.nodes['pause-minimum'].value);
    this.runTool('Detecting silent pauses…', async (signal) => {
      const cuts = await this.hooks.withSource(this.parts, () =>
        findSilentCuts(
          this.parts,
          this.hooks.source,
          minimum,
          signal,
          (time) => {
            this.nodes.progress.max = this.duration;
            this.nodes.progress.value = time;
          },
        ),
      );
      signal.throwIfAborted();
      const combined = [...this.draft.cuts, ...cuts];
      const draft = { ...this.draft, cuts: combined };
      const next = timelineOf(this.duration, draft);
      if (
        !cuts.length ||
        next.error ||
        next.duration === timelineOf(this.duration, this.draft).duration
      ) {
        this.setStatus('No additional silent pauses to cut.');
        return;
      }
      this.history.apply(draft);
      this.selectCut(-1);
      this.setStatus(`${cuts.length} silent sections marked for removal.`);
    });
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
    this.parts = this.draft.sourceParts ?? this.original;
    this.duration = this.parts.at(-1).end;
    this.selectCut(-1);
    this.seek(this.time);
  }

  async discard() {
    const confirmed = await this.confirmDiscard(false);
    if (!confirmed) return;
    this.preview = false;
    this.time = 0;
    this.invalid.clear();
    this.parts = this.original;
    this.duration = this.parts.at(-1).end;
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
    return segmentsOf(this.parts, kept, this.preview ? this.options.speed : 1);
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
    const position = segmentTimeOf(this.segments, this.time);
    this.runPlayback(async (signal) => {
      await this.player.seek(position.segment.part, position.time, signal);
      this.paintFrame();
    });
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
      this.video.playbackRate = this.preview ? this.options.speed : 1;
      this.video.muted = this.preview && this.options.output === 'mute';
      let callback = null;
      const frame = () => {
        this.paintFrame();
        callback = this.video.requestVideoFrameCallback(frame);
      };
      if (this.preview && this.video.requestVideoFrameCallback) frame();
      try {
        for (const segment of segments.slice(segments.indexOf(first.segment))) {
          const { part, start, end, output, speed = 1 } = segment;
          const from = segment === first.segment ? first.time : start;
          await this.player.seek(part, from, signal);
          await playUntil(this.video, end, signal, null, (time) => {
            this.paintTime(output + Math.max(0, time - start) / speed);
          });
        }
      } finally {
        if (callback !== null) this.video.cancelVideoFrameCallback(callback);
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
        mark.textContent = this.clipsChanged
          ? `Clip ${index + 1}`
          : `Part ${index + 1}`;
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
    this.options = editOptionsOf(draft);
    this.timeline = timelineOf(this.duration, draft);
    if (!this.timeline.error) {
      this.timeline.duration = Math.max(
        1,
        Math.round(this.timeline.duration / this.options.speed),
      );
      this.timeline.changed ||=
        this.clipsChanged || changedOptions(this.options);
    }
    if (this.timeline.error) this.preview = false;
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
    this.paintClips();
    for (const input of this.optionInputs) {
      const value = this.options[input.dataset.option];
      if (input.type === 'checkbox') input.checked = value;
      else if (input.value !== String(value)) input.value = value;
    }
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
    this.paintFrame();
  }

  paintClips() {
    this.nodes.clips.replaceChildren(
      ...this.parts.map((part, index) => {
        const item = document.createElement('li');
        const name = document.createElement('span');
        name.textContent =
          part.name || part.entry?.title || `Clip ${index + 1}`;
        const button = (text, title, disabled, action) => {
          const node = document.createElement('button');
          node.type = 'button';
          node.className = 'link-btn';
          node.textContent = text;
          node.setAttribute('aria-label', `${title} ${name.textContent}`);
          node.disabled = disabled;
          node.onclick = action;
          return node;
        };
        const move = (step) => {
          const parts = this.parts.toSpliced(index, 1);
          parts.splice(index + step, 0, part);
          this.replaceParts(parts);
        };
        item.append(
          name,
          button('↑', 'Move up', index === 0, () => move(-1)),
          button('↓', 'Move down', index === this.parts.length - 1, () =>
            move(1),
          ),
          button('×', 'Remove', this.parts.length === 1, () =>
            this.replaceParts(this.parts.toSpliced(index, 1)),
          ),
        );
        return item;
      }),
    );
  }

  paintFrame() {
    const canvas = this.nodes.frame;
    const audioOnly = this.preview && this.options.output === 'audio';
    const visual = this.video.parentElement;
    visual.hidden = audioOnly;
    visual.dataset.edited = String(this.preview && !audioOnly);
    canvas.hidden = !this.preview || audioOnly;
    if (
      canvas.hidden ||
      !this.frame ||
      !this.video.videoWidth ||
      optionsError(this.options)
    ) {
      return;
    }
    const { width, height } = this.frame;
    const scale = Math.min(1, 960 / Math.max(width, height));
    const w = Math.max(2, Math.round(width * scale));
    const h = Math.max(2, Math.round(height * scale));
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
    }
    const context = canvas.getContext('2d');
    if (context) drawVideoFrame(context, this.video, this.options);
  }

  paintSave() {
    const timeline = this.timeline;
    const { nodes } = this;
    const segments = timeline.kept ? segmentsOf(this.parts, timeline.kept) : [];
    const { output } = this.options;
    const audio = output !== 'mute' && segments.some(({ part }) => part.audio);
    const audioOnly = output === 'audio';
    this.format = editFormatOf(audio, undefined, output);
    const validation = optionsError(this.options);
    this.frame =
      !validation && segments.length
        ? outputFrameOf(segments[0].part, this.options)
        : null;
    const encoding =
      this.frame &&
      encodingOf(this.frame, timeline.duration, this.options, audio);
    const picture =
      this.video.requestVideoFrameCallback &&
      globalThis.HTMLCanvasElement?.prototype.captureStream;
    const canRender = Boolean(
      (audioOnly || picture) &&
      (!audio || globalThis.AudioContext) &&
      this.format,
    );
    const error =
      timeline.error ||
      validation ||
      encoding?.error ||
      (audioOnly && !audio && 'There is no audio in the kept clips.') ||
      (!canRender && 'This browser cannot render an edited recording.');
    nodes.preview.disabled = Boolean(
      timeline.error || this.pendingCut || this.invalid.size,
    );
    nodes['apply-cut'].disabled =
      this.invalid.has('cut-start') || this.invalid.has('cut-end');
    nodes.validation.textContent = error || '';
    nodes.validation.hidden = !error;
    const properties = canRender ? [this.format.extension.toUpperCase()] : [];
    if (this.frame && !audioOnly) {
      properties.push(`${this.frame.width} × ${this.frame.height}`);
    }
    if (encoding && !encoding.error) {
      properties.push(`about ${sizeText(encoding.bytes)}`);
    }
    nodes.format.textContent = properties.join(' · ');
    nodes.save.disabled = Boolean(
      error ||
      this.invalid.size ||
      !timeline.changed ||
      this.pendingCut ||
      !nodes['copy-title'].value.trim() ||
      this.saving ||
      this.tool,
    );
    nodes['save-as'].disabled = nodes.save.disabled;
  }

  async save(toFile = false) {
    const { nodes, timeline, format } = this;
    if (this.saving || nodes.save.disabled) return;
    const title = nodes['copy-title'].value.trim();
    const name = mediaNameOf(title, format.extension);
    this.playback?.abort();
    nodes.play.textContent = 'play';
    const control = new AbortController();
    this.saving = control;
    nodes.body.disabled = true;
    nodes.retry.hidden = true;
    nodes['save-status'].hidden = false;
    nodes['cancel-save'].disabled = false;
    nodes['cancel-save'].textContent = 'cancel save';
    nodes.progress.value = 0;
    nodes.progress.max = timeline.duration;
    this.setStatus('Saving edited copy…');
    try {
      const pick =
        toFile && typeof globalThis.showSaveFilePicker === 'function';
      const target = pick
        ? await pickExportFile(name, format.extension, format.mime)
        : null;
      if (pick && !target) {
        this.setStatus('');
        return;
      }
      const id = await this.hooks.withSource(this.parts, () =>
        saveEdit({
          signal: AbortSignal.any([control.signal, this.lifetime.signal]),
          title,
          entry: this.entry,
          parts: this.parts,
          timeline,
          options: this.options,
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
      let status = '';
      if (toFile) {
        try {
          await this.hooks.exportCopy(id, format.extension, name, target);
        } catch {
          status =
            'The copy is in Recordings. Save as could not write the file.';
        }
      }
      this.hooks.saved(id, status);
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
