const BOX_HEADER = 8;
const WIDE_SIZE = 8;
const MILLISECONDS_PER_SECOND = 1000;

const fourcc = (bytes) =>
  String.fromCharCode(bytes[0], bytes[1], bytes[2], bytes[3]);

const viewOf = (bytes) =>
  new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

const boxAt = (read, at, limit) => {
  if (limit - at < BOX_HEADER) return null;
  const head = read(at, BOX_HEADER);
  if (head.length !== BOX_HEADER) return null;
  const type = fourcc(head.subarray(4));
  let size = viewOf(head).getUint32(0);
  let header = BOX_HEADER;
  if (size === 1) {
    if (limit - at < BOX_HEADER + WIDE_SIZE) return null;
    const extra = read(at + BOX_HEADER, WIDE_SIZE);
    if (extra.length !== WIDE_SIZE) return null;
    size = Number(viewOf(extra).getBigUint64(0));
    header += WIDE_SIZE;
  } else if (size === 0) {
    size = limit - at;
  }
  const start = at + header;
  const stop = at + size;
  if (!Number.isSafeInteger(stop) || stop < start) return null;
  return { type, start, end: Math.min(stop, limit) };
};

const boxesOf = function* (read, start, end) {
  let at = start;
  while (at < end) {
    const box = boxAt(read, at, end);
    if (!box) break;
    yield box;
    at = box.end;
  }
};

const fieldAt = (read, box, offset, length) => {
  const at = box.start + offset;
  if (at + length > box.end) return null;
  const bytes = read(at, length);
  return bytes.length === length ? bytes : null;
};

const uintAt = (read, box, offset, wide = false) => {
  const bytes = fieldAt(read, box, offset, wide ? 8 : 4);
  if (!bytes) return null;
  const view = viewOf(bytes);
  return wide ? Number(view.getBigUint64(0)) : view.getUint32(0);
};

const versionOf = (read, box) => fieldAt(read, box, 0, 1)?.[0];

const afterDates = (read, box) => {
  const version = versionOf(read, box);
  if (version === 0) return uintAt(read, box, 12);
  if (version === 1) return uintAt(read, box, 20);
  return null;
};

const videoScaleOf = (read, media) => {
  let handler;
  let scale;
  for (const box of boxesOf(read, media.start, media.end)) {
    if (box.type === 'hdlr') {
      const bytes = fieldAt(read, box, 8, 4);
      if (bytes) handler = fourcc(bytes);
    }
    if (box.type === 'mdhd') scale = afterDates(read, box);
  }
  return handler === 'vide' ? scale : undefined;
};

const videoTracksOf = (read, movie) => {
  const scales = new Map();
  for (const track of boxesOf(read, movie.start, movie.end)) {
    if (track.type !== 'trak') continue;
    let id;
    let scale;
    for (const box of boxesOf(read, track.start, track.end)) {
      if (box.type === 'tkhd') id = afterDates(read, box);
      if (box.type === 'mdia') scale = videoScaleOf(read, box);
    }
    if (id > 0 && scale > 0) scales.set(id, scale);
  }
  return scales;
};

const decodeTimeOf = (read, box) => {
  const version = versionOf(read, box);
  if (version === 0 || version === 1) {
    return uintAt(read, box, 4, version === 1);
  }
  return null;
};

const fragmentDurationOf = (read, fragment, scales) => {
  let duration;
  for (const track of boxesOf(read, fragment.start, fragment.end)) {
    if (track.type !== 'traf') continue;
    let id;
    let time = null;
    for (const box of boxesOf(read, track.start, track.end)) {
      if (box.type === 'tfhd') id = uintAt(read, box, 4);
      if (box.type === 'tfdt') time = decodeTimeOf(read, box);
    }
    const scale = scales.get(id);
    if (scale && time !== null) {
      duration = (time / scale) * MILLISECONDS_PER_SECOND;
    }
  }
  return duration;
};

const mp4DurationOf = (read, size) => {
  let scales = new Map();
  let duration;
  for (const box of boxesOf(read, 0, size)) {
    if (box.type === 'moov') scales = videoTracksOf(read, box);
    if (box.type === 'moof' && scales.size > 0) {
      duration = fragmentDurationOf(read, box, scales) ?? duration;
    }
  }
  return duration;
};

export { mp4DurationOf };
