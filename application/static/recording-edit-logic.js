const validTime = (time) => Number.isSafeInteger(time) && time >= 0;

const validRange = ({ start, end }, duration) =>
  validTime(start) && validTime(end) && start < end && end <= duration;

const initialEdit = (duration) => ({ start: 0, end: duration, cuts: [] });

const timelineOf = (duration, draft) => {
  if (!validRange(draft, duration)) return { error: 'Check the trim times.' };
  const { start, end, cuts } = draft;
  if (cuts.some((cut) => !validRange(cut, duration))) {
    return { error: 'A cut must start before it ends, within the recording.' };
  }
  const inside = cuts
    .map((cut) => ({
      start: Math.max(start, cut.start),
      end: Math.min(end, cut.end),
    }))
    .filter((cut) => cut.start < cut.end)
    .sort((left, right) => left.start - right.start);
  const kept = [];
  let cursor = start;
  let output = 0;
  const keep = (stop) => {
    kept.push({ start: cursor, end: stop, output });
    output += stop - cursor;
  };
  for (const cut of inside) {
    if (cursor < cut.start) keep(cut.start);
    cursor = Math.max(cursor, cut.end);
  }
  if (cursor < end) keep(end);
  if (!output) return { error: 'Keep at least one part of the recording.' };
  return { kept, duration: output, changed: output !== duration };
};

const partsOf = (parts) => {
  let start = 0;
  return parts.map((part, index) => {
    const end = start + part.duration;
    const span = { ...part, index, start, end };
    start = end;
    return span;
  });
};

const segmentsOf = (parts, kept) => {
  const segments = [];
  let index = 0;
  for (const range of kept) {
    while (parts[index].end <= range.start) index++;
    for (let i = index; i < parts.length && parts[i].start < range.end; i++) {
      const part = parts[i];
      const start = Math.max(range.start, part.start);
      const end = Math.min(range.end, part.end);
      segments.push({
        part,
        start: start - part.start,
        end: end - part.start,
        output: range.output + start - range.start,
      });
    }
  }
  return segments;
};

const segmentTimeOf = (segments, time) => {
  const segment =
    segments.find((span) => time < span.output + span.end - span.start) ??
    segments.at(-1);
  return {
    segment,
    time: Math.min(segment.end, segment.start + time - segment.output),
  };
};

const timeInputOf = (time) => {
  const seconds = Math.floor(time / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const pad = (value) => String(value).padStart(2, '0');
  const fraction = String(time % 1000).padStart(3, '0');
  return `${pad(hours)}:${pad(minutes % 60)}:${pad(seconds % 60)}.${fraction}`;
};

const timeFromInput = (text) => {
  const match = /^(?:(\d+):)?([0-5]?\d):([0-5]?\d)(?:\.(\d{1,3}))?$/.exec(
    text.trim(),
  );
  if (!match) return NaN;
  const [, hours = '0', minutes, seconds, ms = '0'] = match;
  return (
    ((+hours * 60 + +minutes) * 60 + +seconds) * 1000 +
    Number(ms.padEnd(3, '0'))
  );
};

class EditHistory {
  #undo = [];
  #redo = [];

  constructor(draft) {
    this.draft = draft;
  }

  get canUndo() {
    return this.#undo.length > 0;
  }

  get canRedo() {
    return this.#redo.length > 0;
  }

  apply(draft) {
    if (JSON.stringify(draft) === JSON.stringify(this.draft)) return false;
    this.#undo.push(this.draft);
    this.#redo.length = 0;
    this.draft = draft;
    return true;
  }

  undo() {
    if (!this.canUndo) return;
    this.#redo.push(this.draft);
    this.draft = this.#undo.pop();
  }

  redo() {
    if (!this.canRedo) return;
    this.#undo.push(this.draft);
    this.draft = this.#redo.pop();
  }
}

export { initialEdit, timelineOf, partsOf, segmentsOf, segmentTimeOf };
export { timeInputOf, timeFromInput, EditHistory };
