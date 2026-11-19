const EBML_HEADER = 0x1a45dfa3;
const SEGMENT = 0x18538067;
const INFO = 0x1549a966;
const SEEK_HEAD = 0x114d9b74;
const CLUSTER = 0x1f43b675;
const TIMECODE_SCALE = 0x2ad7b1;
const DURATION = 0x4489;

const DEFAULT_SCALE = 1000000;
const NANOSECONDS_PER_MS = 1000000;
const FLOAT_BYTES = 8;
const DURATION_HEAD = [0x44, 0x89, 0x88];
const DURATION_ELEMENT = new Uint8Array(DURATION_HEAD.length + 8);
DURATION_ELEMENT.set(DURATION_HEAD);
const MAX_VINT = 8;
const BYTE_BITS = 8;
const BYTE_RANGE = 256;

const lengthOf = (first) => {
  if (first === 0) return 0;
  return Math.clz32(first) - (32 - BYTE_BITS) + 1;
};

const readId = (bytes, at) => {
  const length = lengthOf(bytes[at] ?? 0);
  const isValid = length > 0 && length <= 4 && at + length <= bytes.length;
  if (!isValid) return null;
  let value = 0;
  for (let i = 0; i < length; i++) value = value * BYTE_RANGE + bytes[at + i];
  return { value, length };
};

const readSize = (bytes, at) => {
  const length = lengthOf(bytes[at] ?? 0);
  const isWide = length > 0 && length <= MAX_VINT;
  const isValid = isWide && at + length <= bytes.length;
  if (!isValid) return null;
  const mask = (1 << (BYTE_BITS - length)) - 1;
  let value = bytes[at] & mask;
  let isOnes = value === mask;
  for (let i = 1; i < length; i++) {
    value = value * BYTE_RANGE + bytes[at + i];
    if (bytes[at + i] !== 0xff) isOnes = false;
  }
  return { value: isOnes ? -1 : value, length };
};

const elementAt = (bytes, at) => {
  const id = readId(bytes, at);
  if (!id) return null;
  const size = readSize(bytes, at + id.length);
  if (!size) return null;
  const start = at + id.length + size.length;
  const end = size.value < 0 ? -1 : start + size.value;
  const idLength = id.length;
  return { at, id: id.value, idLength, size: size.value, start, end };
};

const encodeSize = (value) => {
  let length = 1;
  while (length < MAX_VINT && value >= 2 ** (7 * length) - 1) length++;
  const bytes = new Uint8Array(length);
  let rest = value;
  for (let i = length - 1; i >= 0; i--) {
    bytes[i] = rest % BYTE_RANGE;
    rest = Math.floor(rest / BYTE_RANGE);
  }
  bytes[0] |= 1 << (BYTE_BITS - length);
  return bytes;
};

const unsignedOf = (bytes, element) => {
  let value = 0;
  for (let i = element.start; i < element.end; i++) {
    value = value * BYTE_RANGE + bytes[i];
  }
  return value;
};

const childrenOf = (bytes, parent) => {
  const children = [];
  let at = parent.start;
  while (at < parent.end) {
    const child = elementAt(bytes, at);
    if (!child || child.end < 0 || child.end > parent.end) return null;
    children.push(child);
    at = child.end;
  }
  return children;
};

const scaleOf = (bytes, children) => {
  const found = children.find((child) => child.id === TIMECODE_SCALE);
  if (!found || found.size < 1 || found.size > 4) return DEFAULT_SCALE;
  return unsignedOf(bytes, found);
};

const spliced = (head, info, content) => {
  const idBytes = head.subarray(info.at, info.at + info.idLength);
  const sizeBytes = encodeSize(content.length + DURATION_ELEMENT.length);
  const before = head.subarray(0, info.at);
  const after = head.subarray(info.end);
  const parts = [before, idBytes, sizeBytes, content, DURATION_ELEMENT, after];
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const bytes = new Uint8Array(total);
  let at = 0;
  for (const part of parts) {
    bytes.set(part, at);
    at += part.length;
  }
  const lead = info.at + idBytes.length + sizeBytes.length;
  const offset = lead + content.length + DURATION_ELEMENT.length - FLOAT_BYTES;
  return { bytes, offset };
};

const withDuration = (head, info) => {
  const children = childrenOf(head, info);
  if (!children) return null;
  const scale = scaleOf(head, children);
  const existing = children.find((child) => child.id === DURATION);
  if (existing) {
    if (existing.size !== FLOAT_BYTES) return null;
    return { bytes: head, offset: existing.start, scale };
  }
  const content = head.subarray(info.start, info.end);
  const result = spliced(head, info, content);
  return { bytes: result.bytes, offset: result.offset, scale };
};

const durationSlotOf = (head) => {
  const header = elementAt(head, 0);
  if (!header || header.id !== EBML_HEADER || header.end < 0) return null;
  const segment = elementAt(head, header.end);
  if (!segment || segment.id !== SEGMENT) return null;
  let at = segment.start;
  while (at < head.length) {
    const element = elementAt(head, at);
    if (!element || element.end < 0 || element.end > head.length) return null;
    if (element.id === INFO) return withDuration(head, element);
    if (element.id === SEEK_HEAD || element.id === CLUSTER) return null;
    at = element.end;
  }
  return null;
};

const durationBytesOf = (durationMs, scale = DEFAULT_SCALE) => {
  const bytes = new Uint8Array(FLOAT_BYTES);
  const ticks = (durationMs * NANOSECONDS_PER_MS) / scale;
  new DataView(bytes.buffer).setFloat64(0, ticks);
  return bytes;
};

export { encodeSize, durationSlotOf, durationBytesOf };
