import { timeFromInput, timeInputOf } from './recording-edit-logic.js';
import { timeText } from './recording-files.js';
import { button, element, openCollection } from './collection-dialog.js';

const MAX_DETAILS = 64 * 1024;
const MAX_CHAPTERS = 100;
const MAX_CUES = 10000;
const MAX_TIME = 1000 * 60 * 60 * 48;
const MAX_TITLE = 160;
const MAX_DESCRIPTION = 2000;
const encoder = new TextEncoder();

const isTime = (time) =>
  Number.isSafeInteger(time) && time >= 0 && time <= MAX_TIME;

const isText = (text, size) => typeof text === 'string' && text.length <= size;

const cleanTracks = ({ chapters = [], cues = [] }) => {
  if (!Array.isArray(chapters) || !Array.isArray(cues)) return null;
  if (chapters.length > MAX_CHAPTERS || cues.length > MAX_CUES) return null;
  if (
    chapters.some(
      (chapter) =>
        !chapter ||
        !isTime(chapter.at) ||
        !isText(chapter.title, MAX_TITLE) ||
        !chapter.title.trim(),
    )
  ) {
    return null;
  }
  if (
    cues.some(
      (cue) =>
        !cue ||
        !isTime(cue.start) ||
        !isTime(cue.end) ||
        cue.start >= cue.end ||
        !isText(cue.text, 1200) ||
        !cue.text.trim(),
    )
  ) {
    return null;
  }
  return {
    chapters: chapters
      .map(({ at, title }) => ({ at, title }))
      .sort((a, b) => a.at - b.at),
    cues: cues
      .map(({ start, end, text }) => ({ start, end, text }))
      .sort((a, b) => a.start - b.start),
  };
};

const detailsOf = (value) => {
  if (!value || typeof value !== 'object') return null;
  const { duration = 0, description = '', poster = '' } = value;
  if (
    !isTime(duration) ||
    !isText(description, MAX_DESCRIPTION) ||
    !isText(poster, 24000) ||
    (poster && !/^data:image\/jpeg;base64,[a-z0-9+/]+={0,2}$/i.test(poster))
  ) {
    return null;
  }
  const tracks = cleanTracks(value);
  if (!tracks) return null;
  const details = { duration, description, poster, ...tracks };
  return encoder.encode(JSON.stringify(details)).length <= MAX_DETAILS
    ? details
    : null;
};

const readChapters = (text) =>
  text
    .split(/\r?\n/)
    .filter((line) => line.trim())
    .map((line) => {
      const match = /^(\S+)\s+(.+)$/.exec(line.trim());
      const at = match ? timeFromInput(match[1]) : null;
      if (!match || !isTime(at)) {
        throw new Error(
          'Use one chapter per line, for example 02:30 Introduction.',
        );
      }
      return { at, title: match[2].trim() };
    });

const chapterText = ({ at, title }) => `${timeInputOf(at)} ${title}`;

const captionCues = (text) => {
  const plain = text.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
  const blocks = plain.trim().split(/\n[ \t]*\n+/);
  const cues = [];
  for (const block of blocks) {
    if (/^(?:WEBVTT|NOTE(?:\s|$)|STYLE\b|REGION\b)/.test(block)) continue;
    const lines = block.split('\n');
    const index = lines.findIndex((line) => line.includes('-->'));
    if (index < 0 || index > 1) continue;
    const [first, last] = lines[index].split('-->');
    const toTime = (time) =>
      timeFromInput(time.trim().replace(',', '.').split(/\s+/)[0]);
    const start = toTime(first);
    const end = toTime(last);
    const text = lines
      .slice(index + 1)
      .join('\n')
      .replace(/<[^>]*>/g, '')
      .replace(
        /&(amp|lt|gt|nbsp);/g,
        (entity) =>
          ({ '&amp;': '&', '&lt;': '<', '&gt;': '>', '&nbsp;': ' ' })[entity],
      );
    if (isTime(start) && isTime(end) && start < end && text.trim()) {
      cues.push({ start, end, text: text.trim() });
    }
  }
  if (cues.length === 0) {
    throw new Error('No timed captions found in this WebVTT or SRT file.');
  }
  return cues;
};

const vttOf = (cues) => {
  const escape = (text) =>
    text
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replace(/\n[ \t]*\n/g, '\n');
  const blocks = cues.map(
    ({ start, end, text }) =>
      `${timeInputOf(start)} --> ${timeInputOf(end)}\n${escape(text)}`,
  );
  return `WEBVTT\n\n${blocks.join('\n\n')}\n`;
};

const remapTracks = ({ chapters = [], cues = [] }, kept, speed = 1) => {
  const output = { chapters: [], cues: [] };
  let at = 0;
  for (const { start, end } of kept) {
    const base = at - start;
    const toOutput = (time) => Math.round((base + time) / speed);
    for (const chapter of chapters) {
      if (chapter.at >= start && chapter.at < end) {
        output.chapters.push({
          at: toOutput(chapter.at),
          title: chapter.title,
        });
      }
    }
    for (const cue of cues) {
      const first = Math.max(start, cue.start);
      const last = Math.min(end, cue.end);
      if (first >= last) continue;
      const startAt = toOutput(first);
      const endAt = toOutput(last);
      if (startAt < endAt) {
        output.cues.push({ start: startAt, end: endAt, text: cue.text });
      }
    }
    at += end - start;
  }
  return output;
};

const addLabel = (parent, text, input) => {
  const label = element('label', 'collection-field', text);
  label.append(input);
  parent.append(label);
};

const chapterField = (body, chapters, at) => {
  const field = element('textarea');
  field.rows = 4;
  field.maxLength = 20000;
  field.placeholder = '02:30 Introduction';
  field.value = chapters.map(chapterText).join('\n');
  addLabel(body, 'Chapters', field);
  if (Number.isFinite(at)) {
    body.append(
      button('Add chapter at playhead', () => {
        field.value += `${field.value.trim() ? '\n' : ''}${timeInputOf(at)} `;
        field.focus();
        field.setSelectionRange(field.value.length, field.value.length);
      }),
    );
  }
  return field;
};

const checkedChapters = (text, duration) => {
  const chapters = readChapters(text);
  if (
    chapters.length > MAX_CHAPTERS ||
    chapters.some(
      ({ at, title }) =>
        !title || title.length > MAX_TITLE || (duration > 0 && at >= duration),
    )
  ) {
    throw new Error('Use up to 100 titled chapters within the video.');
  }
  return chapters;
};

const editChapters = (chapters, at, duration, save) =>
  openCollection('Video chapters', (body, close) => {
    const field = chapterField(body, chapters, at);
    const status = element('p', 'muted');
    status.setAttribute('role', 'status');
    body.append(
      status,
      button('Apply chapters', () => {
        try {
          save(checkedChapters(field.value, duration));
          close();
        } catch (error) {
          status.textContent = error.message;
        }
      }),
    );
  });

const publishDetails = ({ name, media, destinations, current }, publish) =>
  openCollection('Publish video', (body, close) => {
    const title = element('input');
    title.value = name.slice(0, MAX_TITLE);
    title.maxLength = MAX_TITLE;
    const targets = element('select');
    for (const { id, label } of destinations) {
      const option = element('option', '', label);
      option.value = id;
      targets.append(option);
    }
    if (destinations.some(({ id }) => id === current)) targets.value = current;
    const description = element('textarea');
    description.rows = 2;
    description.maxLength = MAX_DESCRIPTION;
    description.value = media.description || '';
    addLabel(body, 'Post to', targets);
    addLabel(body, 'Video title', title);
    addLabel(body, 'Description', description);
    const chapters = chapterField(body, media.chapters ?? []);
    const captions = element('input');
    captions.type = 'file';
    captions.accept = '.vtt,.srt,text/vtt';
    addLabel(body, 'Captions (.vtt or .srt)', captions);
    const status = element('p', 'muted');
    status.setAttribute('role', 'status');
    let cues = media.cues ?? [];
    let reading = 0;
    const submit = button('Publish', () => {
      try {
        const target = targets.value;
        if (!target || !title.value.trim()) {
          throw new Error('Choose a destination and enter a title.');
        }
        const details = detailsOf({
          ...media,
          description: description.value,
          cues,
          chapters: checkedChapters(chapters.value, media.duration),
        });
        if (!details) throw new Error('Video details exceed the 64 KB limit.');
        close();
        publish({ target, name: title.value.trim(), details });
      } catch (error) {
        status.textContent = error.message;
      }
    });
    const remove = button('Remove captions', () => {
      reading++;
      cues = [];
      captions.value = '';
      status.textContent = 'Captions removed.';
      remove.hidden = true;
      submit.disabled = false;
    });
    remove.hidden = cues.length === 0;
    captions.onchange = async () => {
      const file = captions.files[0];
      if (!file) return;
      const revision = ++reading;
      submit.disabled = true;
      try {
        if (file.size > MAX_DETAILS) {
          throw new Error('Choose a caption file up to 64 KB.');
        }
        const loaded = captionCues(await file.text());
        if (revision !== reading) return;
        if (!detailsOf({ cues: loaded })) {
          throw new Error('Caption data exceeds the 64 KB limit.');
        }
        cues = loaded;
        status.textContent = `${cues.length} captions loaded`;
        remove.hidden = false;
      } catch (error) {
        if (revision === reading) status.textContent = error.message;
      } finally {
        if (revision === reading) submit.disabled = false;
      }
    };
    body.append(remove, status, submit);
  });

const renderTracks = (video, body, details) => {
  const { chapters, cues, description } = details;
  body.replaceChildren();
  body.hidden = !description && chapters.length === 0 && cues.length === 0;
  if (description) body.append(element('p', 'video-description', description));
  const seek = (time) => {
    if (video.readyState > 0) video.currentTime = time / 1000;
  };
  const timeButton = (time, title) =>
    button(`${timeText(time)} ${title}`, () => seek(time));
  if (chapters.length) {
    const section = element('section', 'video-chapters');
    section.setAttribute('aria-label', 'Chapters');
    section.append(element('h2', '', 'Chapters'));
    for (const { at, title } of chapters) section.append(timeButton(at, title));
    body.append(section);
  }
  if (!cues.length) return () => {};
  const source = URL.createObjectURL(
    new Blob([vttOf(cues)], { type: 'text/vtt' }),
  );
  const track = element('track');
  track.kind = 'captions';
  track.label = 'Captions';
  track.src = source;
  video.append(track);
  const panel = element('section', 'video-transcript');
  panel.append(element('h2', '', 'Transcript'));
  const search = element('input');
  search.type = 'search';
  search.placeholder = 'Search transcript';
  search.setAttribute('aria-label', search.placeholder);
  const list = element('div', 'video-transcript-list');
  const paint = () => {
    const query = search.value.trim().toLowerCase();
    const matches = cues.filter(({ text }) =>
      text.toLowerCase().includes(query),
    );
    list.replaceChildren(
      ...matches.map(({ start, text }) => timeButton(start, text)),
    );
    if (!matches.length) {
      list.append(element('p', 'muted', 'No matching captions.'));
    }
  };
  search.oninput = paint;
  paint();
  panel.append(search, list);
  body.append(panel);
  return () => {
    track.remove();
    URL.revokeObjectURL(source);
  };
};

export {
  MAX_DETAILS,
  detailsOf,
  captionCues,
  vttOf,
  remapTracks,
  editChapters,
  publishDetails,
  renderTracks,
};
