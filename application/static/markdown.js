const MAX_DEPTH = 10;
const MAX_INLINE_DEPTH = 24;
const MAX_LABEL = 999;
const MAX_URL = 2048;
const MAX_TITLE = 1024;
const SCAN_FACTOR = 4;
const SCAN_BASE = 4096;
const TAB_WIDTH = 4;
const ASCII_PUNCTUATION = '!"#$%&\'()*+,-./:;<=>?@[\\]^_`{|}~';
const SAFE_URL = /^(?:https?:|mailto:)/i;
const WHITESPACE = /\s/;
const PUNCTUATION = /[\p{P}\p{S}]/u;
const MARKDOWN_CHARS =
  /[\\`*_~[\]<>&#|]|^ {0,3}(?:[-+]|\d+[.)])(?:\s|$)|^(?: {4}|\t)|^-{3,}/m;

const FENCE = /^ {0,3}(`{3,}|~{3,})[ \t]*(.*)$/;
const ATX = /^ {0,3}(#{1,6})(?:[ \t]+(.*))?$/;
const RULE = /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/;
const QUOTE = /^ {0,3}> ?/;
const ITEM = /^( {0,3})([-*+]|\d{1,9}[.)])(?:([ \t]+)(.*))?$/;
const DELIMITER_ROW =
  /^ {0,3}\|?[ \t]*:?-+:?[ \t]*(?:\|[ \t]*:?-+:?[ \t]*)*\|?$/;
const TASK = /^\[([ xX])\](?:[ \t]+|$)/;
const DEFINITION = new RegExp(
  '^ {0,3}\\[((?:[^\\\\\\[\\]]|\\\\.){1,999})\\]:[ \\t]*\\n?[ \\t]*' +
    '(<[^<>\\n]*>|[^\\s<]\\S*)' +
    '(?:[ \\t]*\\n?[ \\t]*("(?:[^"\\\\]|\\\\.)*"|\'(?:[^\'\\\\]|\\\\.)*\'' +
    '|\\((?:[^()\\\\]|\\\\.)*\\)))?[ \\t]*(?:\\n|$)',
);
const ENTITY = /&(?:#[xX]([0-9a-fA-F]{1,6})|#(\d{1,7})|(\w{2,6}));/y;
const AUTOLINK = /<([a-zA-Z][a-zA-Z0-9+.-]{1,31}:[^\s<>]*)>/y;
const EMAIL = /<([\w.+-]+@[\w-]+(?:\.[\w-]+)*)>/y;
const BARE_URL = /(?:https?:\/\/|www\.)[^\s<]+/y;
const SPECIAL = /[\\`*_~[\]!<&]|https?:\/\/|www\./g;
const NAMED = { amp: '&', lt: '<', gt: '>', quot: '"', apos: `'` };
const NBSP = ' ';
const URL_END = '?!.,:;*_~\'"';

const isBlank = (line) => line.trim() === '';

const isPunctuation = (char) =>
  char.length === 1 && ASCII_PUNCTUATION.includes(char);

const expandTabs = (line) => {
  let out = '';
  let i = 0;
  for (; i < line.length; i++) {
    const char = line[i];
    if (char !== ' ' && char !== '\t') break;
    out +=
      char === ' ' ? ' ' : ' '.repeat(TAB_WIDTH - (out.length % TAB_WIDTH));
  }
  return out + line.slice(i);
};

const nextFilled = (lines, from) => {
  let i = from;
  while (i < lines.length && isBlank(lines[i])) i++;
  return i < lines.length ? i : -1;
};

const indentOf = (line) => line.length - line.trimStart().length;

const codePointOf = (value) => {
  const isValid = value > 0 && value <= 0x10ffff;
  const isSurrogate = value >= 0xd800 && value <= 0xdfff;
  return isValid && !isSurrogate ? String.fromCodePoint(value) : '\ufffd';
};

const decodeEntity = (hex, decimal, name) => {
  if (hex) return codePointOf(parseInt(hex, 16));
  if (decimal) return codePointOf(parseInt(decimal, 10));
  if (name === 'nbsp') return NBSP;
  return NAMED[name];
};

const unescape = (text) => {
  const pattern =
    /\\([^\\\n])|\\\\|&(?:#[xX]([0-9a-fA-F]{1,6})|#(\d{1,7})|(\w{2,6}));/g;
  return text.replace(pattern, (all, char, hex, decimal, name) => {
    if (char !== undefined) return isPunctuation(char) ? char : all;
    if (all === '\\\\') return '\\';
    return decodeEntity(hex, decimal, name) ?? all;
  });
};

const normalizeLabel = (label) =>
  label.trim().replace(/\s+/g, ' ').toLowerCase();

const createState = (source, refs) => ({
  source,
  refs,
  head: null,
  tail: null,
  dhead: null,
  dtail: null,
  brackets: [],
  runs: new Map(),
  scanned: 0,
});

const appendToken = (state, token) => {
  token.prev = state.tail;
  token.next = null;
  if (state.tail) state.tail.next = token;
  else state.head = token;
  state.tail = token;
  return token;
};

const appendText = (state, text) => {
  if (text) appendToken(state, { type: 'text', text, depth: 0 });
};

const collectRuns = (source) => {
  const runs = new Map();
  for (const match of source.matchAll(/`+/g)) {
    const { length } = match[0];
    const list = runs.get(length) ?? [];
    list.push(match.index);
    runs.set(length, list);
  }
  return runs;
};

const findRun = (list = [], from) => {
  let low = 0;
  let high = list.length;
  while (low < high) {
    const middle = (low + high) >> 1;
    if (list[middle] < from) low = middle + 1;
    else high = middle;
  }
  return low < list.length ? list[low] : -1;
};

const spanText = (content) => {
  const text = content.replace(/\n/g, ' ');
  const hasEdges = text.startsWith(' ') && text.endsWith(' ');
  const isFilled = text.trim() !== '';
  return hasEdges && isFilled ? text.slice(1, -1) : text;
};

const readCode = (state, pos) => {
  const { source } = state;
  let end = pos;
  while (source[end] === '`') end++;
  const size = end - pos;
  const closer = findRun(state.runs.get(size), end);
  if (closer < 0) {
    appendText(state, '`'.repeat(size));
    return end;
  }
  const text = spanText(source.slice(end, closer));
  appendToken(state, { type: 'code', text, depth: 0 });
  return closer + size;
};

const isSpace = (char) => {
  const code = char.charCodeAt(0);
  if (code < 128) return code <= 32;
  return WHITESPACE.test(char);
};

const ASCII_TABLE = Array.from({ length: 128 }, (_, code) =>
  ASCII_PUNCTUATION.includes(String.fromCharCode(code)),
);

const isPunct = (char) => {
  const code = char.charCodeAt(0);
  if (code < 128) return ASCII_TABLE[code];
  return PUNCTUATION.test(char);
};

const flankOf = (before, after, char) => {
  const spaceBefore = isSpace(before);
  const spaceAfter = isSpace(after);
  const punctBefore = !spaceBefore && isPunct(before);
  const punctAfter = !spaceAfter && isPunct(after);
  const left = !spaceAfter && (!punctAfter || spaceBefore || punctBefore);
  const right = !spaceBefore && (!punctBefore || spaceAfter || punctAfter);
  if (char !== '_') return { open: left, close: right };
  return {
    open: left && (!right || punctBefore),
    close: right && (!left || punctAfter),
  };
};

const appendDelimiter = (state, delimiter) => {
  delimiter.dprev = state.dtail;
  delimiter.dnext = null;
  if (state.dtail) state.dtail.dnext = delimiter;
  else state.dhead = delimiter;
  state.dtail = delimiter;
};

const removeDelimiter = (state, delimiter) => {
  const { dprev, dnext } = delimiter;
  if (dprev) dprev.dnext = dnext;
  else state.dhead = dnext;
  if (dnext) dnext.dprev = dprev;
  else state.dtail = dprev;
};

const readDelimiters = (state, pos) => {
  const { source } = state;
  const char = source[pos];
  let end = pos;
  while (source[end] === char) end++;
  const size = end - pos;
  const isTilde = char === '~';
  if (isTilde && size !== 2) {
    appendText(state, char.repeat(size));
    return end;
  }
  const before = source[pos - 1] ?? ' ';
  const after = source[end] ?? ' ';
  const { open, close } = flankOf(before, after, char);
  const text = char.repeat(size);
  const token = { type: 'text', text, depth: 0, char, size, open, close };
  token.orig = size;
  appendDelimiter(state, appendToken(state, token));
  return end;
};

const depthOf = (first, last = null) => {
  let depth = 0;
  for (let token = first; token; token = token.next) {
    if (token.depth > depth) depth = token.depth;
    if (token === last) break;
  }
  return depth + 1;
};

const detach = (first, last) => {
  if (first) first.prev = null;
  if (last) last.next = null;
};

const isMatch = (opener, closer) => {
  if (opener.char !== closer.char || !opener.open) return false;
  if (closer.char === '~') return opener.size === 2;
  const isBoth = opener.close || closer.open;
  const sum = opener.orig + closer.orig;
  const isAllowed = opener.orig % 3 === 0 && closer.orig % 3 === 0;
  return !(isBoth && sum % 3 === 0 && !isAllowed);
};

const findOpener = (closer, bottom, floor) => {
  for (let item = closer.dprev; item; item = item.dprev) {
    if (item === bottom || item === floor) return null;
    if (isMatch(item, closer)) return item;
  }
  return null;
};

const wrapEmphasis = (opener, closer) => {
  const first = opener.next;
  const last = closer.prev;
  const isEmpty = first === closer;
  const depth = isEmpty ? 1 : depthOf(first, last);
  if (depth > MAX_INLINE_DEPTH) return false;
  const isDel = closer.char === '~';
  const used = isDel || (opener.size >= 2 && closer.size >= 2) ? 2 : 1;
  const type = isDel ? 'del' : ['em', 'strong'][used - 1];
  const kids = isEmpty ? null : first;
  if (kids) detach(first, last);
  const node = { type, kids, depth, prev: opener, next: closer };
  opener.size -= used;
  closer.size -= used;
  opener.text = opener.char.repeat(opener.size);
  closer.text = closer.char.repeat(closer.size);
  opener.next = node;
  closer.prev = node;
  opener.dnext = closer;
  closer.dprev = opener;
  return true;
};

const processEmphasis = (state, bottom) => {
  const floors = new Map();
  let closer = bottom ? bottom.dnext : state.dhead;
  while (closer) {
    if (!closer.close) {
      closer = closer.dnext;
      continue;
    }
    const mod = closer.orig % 3;
    const key = closer.char.charCodeAt(0) * 8 + (closer.open ? 4 : 0) + mod;
    const opener = findOpener(closer, bottom, floors.get(key));
    if (opener && wrapEmphasis(opener, closer)) {
      if (opener.size === 0) removeDelimiter(state, opener);
      const after = closer.dnext;
      if (closer.size === 0) {
        removeDelimiter(state, closer);
        closer = after;
      }
      continue;
    }
    floors.set(key, closer.dprev);
    const following = closer.dnext;
    if (!closer.open || opener) removeDelimiter(state, closer);
    closer = following;
  }
  state.dtail = bottom;
  if (bottom) bottom.dnext = null;
  else state.dhead = null;
};

const skipSpace = (source, from) => {
  let pos = from;
  while (pos < source.length && /\s/.test(source[pos])) pos++;
  return pos;
};

const readPointed = (state, from) => {
  const { source } = state;
  const limit = Math.min(source.length, from + MAX_URL);
  let pos = from + 1;
  let end = -1;
  for (; pos < limit && end < 0; pos++) {
    const char = source[pos];
    if (char === '\n' || char === '<') break;
    if (char === '\\') pos++;
    else if (char === '>') end = pos;
  }
  state.scanned += pos - from;
  return end;
};

const readBare = (state, from) => {
  const { source } = state;
  const limit = Math.min(source.length, from + MAX_URL);
  let depth = 0;
  let pos = from;
  for (; pos < limit; pos++) {
    const char = source[pos];
    const isEscape = char === '\\' && isPunctuation(source[pos + 1] ?? ' ');
    if (isEscape) {
      pos++;
    } else if (char <= ' ' || char === '\u007f') {
      break;
    } else if (char === '(') {
      depth++;
    } else if (char === ')') {
      if (depth === 0) break;
      depth--;
    }
  }
  state.scanned += pos - from;
  return depth === 0 ? pos : -1;
};

const readDestination = (state, from) => {
  const { source } = state;
  const isPointed = source[from] === '<';
  const end = isPointed ? readPointed(state, from) : readBare(state, from);
  if (end < 0) return null;
  const raw = source.slice(from + (isPointed ? 1 : 0), end);
  return { href: unescape(raw), end: end + (isPointed ? 1 : 0) };
};

const CLOSERS = { '"': '"', [`'`]: `'`, '(': ')' };

const readTitle = (state, from) => {
  const { source } = state;
  const closer = CLOSERS[source[from]];
  if (!closer) return null;
  const limit = Math.min(source.length, from + MAX_TITLE);
  let pos = from + 1;
  let found = null;
  for (; pos < limit && !found; pos++) {
    if (source[pos] === '\\') {
      pos++;
    } else if (source[pos] === closer) {
      const title = unescape(source.slice(from + 1, pos));
      found = { title, end: pos + 1 };
    }
  }
  state.scanned += pos - from;
  return found;
};

const readTail = (state, from) => {
  const { source } = state;
  const start = skipSpace(source, from + 1);
  const destination = readDestination(state, start);
  if (!destination) return null;
  const { href } = destination;
  const gap = skipSpace(source, destination.end);
  const title = gap > destination.end ? readTitle(state, gap) : null;
  const end = skipSpace(source, title ? title.end : destination.end);
  if (source[end] !== ')') return null;
  return { href, title: title?.title ?? '', end: end + 1 };
};

const labelAt = (state, opener, pos) => {
  const { source, refs } = state;
  if (refs.size === 0) return null;
  const next = source[pos + 1];
  const own = source.slice(opener.pos, pos);
  if (next === '[') {
    const close = source.indexOf(']', pos + 2);
    const isFar = close < 0 || close - pos > MAX_LABEL;
    if (isFar) return null;
    const label = source.slice(pos + 2, close);
    const key = normalizeLabel(label === '' ? own : label);
    return { key, end: close + 1 };
  }
  if (own.length > MAX_LABEL) return null;
  return { key: normalizeLabel(own), end: pos + 1 };
};

const findReference = (state, opener, pos) => {
  const label = labelAt(state, opener, pos);
  if (!label) return null;
  const ref = state.refs.get(label.key);
  return ref ? { href: ref.href, title: ref.title, end: label.end } : null;
};

const findLink = (state, opener, pos) => {
  const { source } = state;
  const budget = source.length * SCAN_FACTOR + SCAN_BASE;
  if (source[pos + 1] === '(' && state.scanned < budget) {
    const tail = readTail(state, pos + 1);
    if (tail) return tail;
  }
  return findReference(state, opener, pos);
};

const buildLink = (state, opener, found) => {
  const { token } = opener;
  processEmphasis(state, opener.bottom);
  const first = token.next;
  const depth = first ? depthOf(first) : 1;
  if (depth > MAX_INLINE_DEPTH) return false;
  const type = opener.image ? 'image' : 'link';
  const { href, title } = found;
  Object.assign(token, { type, href, title, depth, kids: first });
  detach(first, state.tail);
  token.next = null;
  state.tail = token;
  return true;
};

const closeBracket = (state, pos) => {
  const opener = state.brackets.pop();
  if (!opener || !opener.active) {
    appendText(state, ']');
    return pos + 1;
  }
  const found = findLink(state, opener, pos);
  if (!found || !buildLink(state, opener, found)) {
    appendText(state, ']');
    return pos + 1;
  }
  if (!opener.image) {
    for (const bracket of state.brackets) bracket.active = false;
  }
  return found.end;
};

const openBracket = (state, pos) => {
  const { source } = state;
  const image = source[pos] === '!';
  const text = image ? '![' : '[';
  const token = appendToken(state, { type: 'text', text, depth: 0 });
  const bottom = state.dtail;
  const start = pos + text.length;
  state.brackets.push({ token, image, active: true, bottom, pos: start });
  return start;
};

const readEntity = (state, pos) => {
  ENTITY.lastIndex = pos;
  const match = ENTITY.exec(state.source);
  const text = match ? decodeEntity(match[1], match[2], match[3]) : undefined;
  if (text === undefined) {
    appendText(state, '&');
    return pos + 1;
  }
  appendText(state, text);
  return pos + match[0].length;
};

const createLink = (href, text) => {
  const kid = { type: 'text', text, depth: 0, prev: null, next: null };
  return { type: 'link', href, title: '', depth: 1, kids: kid };
};

const readPointedLink = (state, pos) => {
  const { source } = state;
  AUTOLINK.lastIndex = pos;
  EMAIL.lastIndex = pos;
  const url = AUTOLINK.exec(source);
  const mail = EMAIL.exec(source);
  const match = url ?? mail;
  if (!match) {
    appendText(state, '<');
    return pos + 1;
  }
  const href = url ? match[1] : `mailto:${match[1]}`;
  appendToken(state, createLink(href, match[1]));
  return pos + match[0].length;
};

const trimUrl = (url) => {
  let end = url.length;
  while (end > 0) {
    const char = url[end - 1];
    const body = url.slice(0, end);
    const isOpen = body.split('(').length - 1;
    const isClosed = body.split(')').length - 1;
    const isEdge = URL_END.includes(char) || char === ']';
    const isExtra = char === ')' && isClosed > isOpen;
    if (!isEdge && !isExtra) break;
    end--;
  }
  return url.slice(0, end);
};

const readBareUrl = (state, pos) => {
  BARE_URL.lastIndex = pos;
  const match = BARE_URL.exec(state.source);
  const cut = state.brackets.length > 0 ? match?.[0].indexOf(']') : -1;
  const found = cut >= 0 ? match[0].slice(0, cut) : match?.[0];
  const url = found ? trimUrl(found) : '';
  const isWww = url.startsWith('www.');
  const prefix = url.match(/^(?:https?:\/\/|www\.)/)?.[0].length ?? 0;
  if (url.length <= prefix) return -1;
  const href = isWww ? `https://${url}` : url;
  appendToken(state, createLink(href, url));
  return pos + url.length;
};

const isWord = (char) => char !== undefined && /\w/.test(char);

const nextSpecial = (source, from) => {
  SPECIAL.lastIndex = from;
  for (let match = SPECIAL.exec(source); match; match = SPECIAL.exec(source)) {
    const char = match[0];
    const isUrl = char.length > 1;
    const isBang = char === '!' && source[match.index + 1] !== '[';
    const isInner = isUrl && isWord(source[match.index - 1]);
    if (!isBang && !isInner) return match.index;
    SPECIAL.lastIndex = match.index + 1;
  }
  return source.length;
};

const readEscape = (state, pos) => {
  const { source } = state;
  const next = source[pos + 1];
  if (next === '\n') {
    appendToken(state, { type: 'break', depth: 0 });
    return pos + 2;
  }
  const isEscape = next !== undefined && isPunctuation(next);
  appendText(state, isEscape ? next : '\\');
  return pos + (isEscape ? 2 : 1);
};

const readUrlOrText = (state, pos) => {
  const end = readBareUrl(state, pos);
  if (end >= 0) return end;
  appendText(state, state.source[pos]);
  return pos + 1;
};

const READERS = {
  '\\': readEscape,
  '`': readCode,
  '*': readDelimiters,
  _: readDelimiters,
  '~': readDelimiters,
  '[': openBracket,
  '!': openBracket,
  ']': closeBracket,
  '<': readPointedLink,
  '&': readEntity,
  h: readUrlOrText,
  w: readUrlOrText,
};

const scanInline = (state) => {
  const { source } = state;
  let pos = 0;
  while (pos < source.length) {
    const next = nextSpecial(source, pos);
    appendText(state, source.slice(pos, next));
    if (next >= source.length) break;
    pos = READERS[source[next]](state, next);
  }
  processEmphasis(state, null);
};

const mergeText = (nodes) => {
  const merged = [];
  for (const node of nodes) {
    const last = merged.at(-1);
    if (node.type === 'text' && last?.type === 'text') last.text += node.text;
    else if (node.type !== 'text' || node.text) merged.push(node);
  }
  return merged;
};

const plainInline = (nodes) => {
  let text = '';
  for (const node of nodes) {
    if (node.type === 'text' || node.type === 'code') text += node.text;
    else if (node.type === 'break') text += '\n';
    else if (node.type === 'image') text += node.alt;
    else text += plainInline(node.children);
  }
  return text;
};

const CONVERTERS = {};

const convertNodes = (first, isInLink = false) => {
  const nodes = [];
  for (let token = first; token; token = token.next) {
    const converted = CONVERTERS[token.type](token, isInLink);
    if (Array.isArray(converted)) nodes.push(...converted);
    else nodes.push(converted);
  }
  return mergeText(nodes);
};

const convertText = ({ text }) => ({ type: 'text', text });
const convertCode = ({ text }) => ({ type: 'code', text });
const convertBreak = () => ({ type: 'break' });

const convertWrap = (token, isInLink) => {
  const { type } = token;
  return { type, children: convertNodes(token.kids, isInLink) };
};

const convertLink = (token, isInLink) => {
  const { href, title } = token;
  const children = convertNodes(token.kids, true);
  if (isInLink || !SAFE_URL.test(href)) return children;
  return { type: 'link', href, title, children };
};

const convertImage = (token) => {
  const { href: src, title } = token;
  const alt = plainInline(convertNodes(token.kids, true));
  if (!SAFE_URL.test(src)) return { type: 'text', text: alt || src };
  return { type: 'image', src, alt, title };
};

Object.assign(CONVERTERS, {
  text: convertText,
  code: convertCode,
  break: convertBreak,
  em: convertWrap,
  strong: convertWrap,
  del: convertWrap,
  link: convertLink,
  image: convertImage,
});

const parseInline = (source, refs) => {
  const state = createState(source, refs);
  state.runs = collectRuns(source);
  scanInline(state);
  return convertNodes(state.head);
};

const fenceOf = (line) => {
  const match = FENCE.exec(line);
  if (!match) return null;
  const marks = match[1];
  const info = match[2];
  if (marks[0] === '`' && info.includes('`')) return null;
  const indent = indentOf(line);
  return { char: marks[0], size: marks.length, indent, info: info.trim() };
};

const isClosing = (fence, line) => {
  const text = line.trim();
  const isLong = text.length >= fence.size;
  return (
    isLong && indentOf(line) < 4 && text === fence.char.repeat(text.length)
  );
};

const itemOf = (line) => {
  const match = ITEM.exec(line);
  if (!match) return null;
  const indent = match[1];
  const marker = match[2];
  const gap = match[3] ?? '';
  const text = match[4] ?? '';
  const isOrdered = marker.length > 1 || /\d/.test(marker);
  const sign = isOrdered ? marker.slice(-1) : marker;
  const spaces = gap.replace(/\t/g, '    ').length;
  const isIndented = spaces > TAB_WIDTH || text === '';
  const width = indent.length + marker.length;
  const contentIndent = width + (isIndented ? 1 : spaces);
  const rest = ' '.repeat(isIndented && text ? spaces - 1 : 0) + text;
  const start = isOrdered ? parseInt(marker, 10) : null;
  return { isOrdered, sign, start, contentIndent, rest, isEmpty: text === '' };
};

const startsBlock = (line, depth) => {
  if (fenceOf(line) || ATX.test(line) || RULE.test(line)) return true;
  if (depth >= MAX_DEPTH) return false;
  if (QUOTE.test(line)) return true;
  const item = itemOf(line);
  return (
    item !== null && !item.isEmpty && (!item.isOrdered || item.start === 1)
  );
};

const trackFence = (fence, line) => {
  if (fence) return isClosing(fence, line) ? null : fence;
  return fenceOf(line);
};

const takeDefinitions = (refs, text) => {
  let rest = text;
  for (
    let match = DEFINITION.exec(rest);
    match;
    match = DEFINITION.exec(rest)
  ) {
    const key = normalizeLabel(match[1]);
    const dest = match[2];
    const href = unescape(dest.startsWith('<') ? dest.slice(1, -1) : dest);
    const title = match[3] ? unescape(match[3].slice(1, -1)) : '';
    if (!refs.has(key)) refs.set(key, { href, title });
    rest = rest.slice(match[0].length);
  }
  return rest;
};

const flushParagraph = (state) => {
  if (state.para.length === 0) return;
  const text = state.para.map((line) => line.trim()).join('\n');
  state.para = [];
  const raw = text.startsWith('[') ? takeDefinitions(state.refs, text) : text;
  const gap = state.paraGap;
  if (raw.trim() !== '') state.blocks.push({ type: 'paragraph', raw, gap });
};

const addBlock = (state, block) => {
  flushParagraph(state);
  state.blocks.push({ ...block, gap: state.gap });
  state.gap = false;
};

const STARTERS = [];

const readBlocks = (lines, depth, refs) => {
  const state = { lines, depth, refs, i: 0, blocks: [], para: [] };
  state.gap = false;
  state.paraGap = false;
  while (state.i < lines.length) {
    const line = lines[state.i];
    if (isBlank(line)) {
      flushParagraph(state);
      state.gap = true;
      state.i++;
      continue;
    }
    if (STARTERS.some((starter) => starter(state))) continue;
    if (state.para.length === 0) {
      state.paraGap = state.gap;
      state.gap = false;
    }
    state.para.push(line);
    state.i++;
  }
  flushParagraph(state);
  return state.blocks;
};

const readFence = (state) => {
  const { lines } = state;
  const fence = fenceOf(lines[state.i]);
  if (!fence) return false;
  const body = [];
  let i = state.i + 1;
  for (; i < lines.length; i++) {
    if (isClosing(fence, lines[i])) break;
    const strip = Math.min(fence.indent, indentOf(lines[i]));
    body.push(lines[i].slice(strip));
  }
  const lang = fence.info.split(/\s+/)[0];
  addBlock(state, { type: 'code', lang, text: body.join('\n') });
  state.i = i + 1;
  return true;
};

const readHeading = (state) => {
  const match = ATX.exec(state.lines[state.i]);
  if (!match) return false;
  const body = (match[2] ?? '').replace(/(?:^|[ \t]+)#+[ \t]*$/, '').trim();
  addBlock(state, { type: 'heading', level: match[1].length, raw: body });
  state.i++;
  return true;
};

const readRule = (state) => {
  if (!RULE.test(state.lines[state.i])) return false;
  addBlock(state, { type: 'rule' });
  state.i++;
  return true;
};

const readQuote = (state) => {
  const { lines, depth } = state;
  if (depth >= MAX_DEPTH || !QUOTE.test(lines[state.i])) return false;
  const inner = [];
  let fence = null;
  let i = state.i;
  for (; i < lines.length; i++) {
    const line = lines[i];
    const isMarked = QUOTE.test(line);
    const last = inner.at(-1);
    const isLazy = !isMarked && last !== undefined && !isBlank(last);
    const canLazy = isLazy && !fence && !isBlank(line);
    if (!isMarked && !(canLazy && !startsBlock(line, depth))) break;
    const text = isMarked ? line.replace(QUOTE, '') : line;
    fence = trackFence(fence, text);
    inner.push(text);
  }
  const children = readBlocks(inner, depth + 1, state.refs);
  addBlock(state, { type: 'quote', children });
  state.i = i;
  return true;
};

const collectItem = (lines, from, item, depth) => {
  const inner = [item.rest];
  let fence = trackFence(null, item.rest);
  let i = from + 1;
  for (; i < lines.length; i++) {
    const line = lines[i];
    if (isBlank(line)) {
      const next = nextFilled(lines, i);
      const isEnd = next < 0 || indentOf(lines[next]) < item.contentIndent;
      const isEmptyStart = inner.length === 1 && item.isEmpty;
      if (isEnd || isEmptyStart) break;
      for (; i < next; i++) inner.push('');
      i = next - 1;
      continue;
    }
    if (indentOf(line) >= item.contentIndent) {
      const text = line.slice(item.contentIndent);
      fence = trackFence(fence, text);
      inner.push(text);
      continue;
    }
    const last = inner.at(-1);
    const canLazy = !isBlank(last) && !fence && !startsBlock(line, depth);
    if (!canLazy || itemOf(line)) break;
    inner.push(line);
  }
  return { inner, next: i };
};

const isSibling = (line, first) => {
  const item = itemOf(line);
  return item && item.isOrdered === first.isOrdered && item.sign === first.sign;
};

const taskOf = (children) => {
  const first = children[0];
  const match = first?.type === 'paragraph' ? TASK.exec(first.raw) : null;
  if (!match) return { checked: null, children };
  const raw = first.raw.slice(match[0].length);
  const rest = children.slice(1);
  const kids = raw === '' ? rest : [{ ...first, raw }].concat(rest);
  return { checked: match[1] !== ' ', children: kids };
};

const readList = (state) => {
  const { lines, depth } = state;
  if (depth >= MAX_DEPTH) return false;
  const first = itemOf(lines[state.i]);
  if (!first) return false;
  const canInterrupt =
    !first.isEmpty && (!first.isOrdered || first.start === 1);
  if (state.para.length > 0 && !canInterrupt) return false;
  const items = [];
  let i = state.i;
  let isLoose = false;
  while (i < lines.length) {
    const item = itemOf(lines[i]);
    const { inner, next } = collectItem(lines, i, item, depth);
    const children = readBlocks(inner, depth + 1, state.refs);
    const gaps = children.slice(1).some((child) => child.gap);
    if (gaps) isLoose = true;
    items.push(taskOf(children));
    const after = nextFilled(lines, next);
    const isNext = after >= 0 && isSibling(lines[after], first);
    i = isNext ? after : next;
    if (!isNext) break;
    if (after > next) isLoose = true;
  }
  const { isOrdered, start } = first;
  const loose = isLoose;
  addBlock(state, { type: 'list', ordered: isOrdered, start, loose, items });
  state.i = i;
  return true;
};

const splitRow = (line) => {
  let text = line.trim();
  if (text.startsWith('|')) text = text.slice(1);
  if (text.endsWith('|') && !text.endsWith('\\|')) text = text.slice(0, -1);
  const cells = [];
  let cell = '';
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (char === '\\' && text[i + 1] === '|') {
      cell += '|';
      i++;
    } else if (char === '|') {
      cells.push(cell.trim());
      cell = '';
    } else {
      cell += char;
    }
  }
  cells.push(cell.trim());
  return cells;
};

const ALIGNS = { ':-': 'left', '-:': 'right', '::': 'center' };

const alignOf = (cell) => {
  const left = cell.startsWith(':') ? ':' : '-';
  const right = cell.endsWith(':') ? ':' : '-';
  const key = left + right;
  return ALIGNS[key] ?? '';
};

const fitRow = (cells, size) =>
  Array.from({ length: size }, (_, index) => cells[index] ?? '');

const readTable = (state) => {
  const { lines, depth } = state;
  const head = lines[state.i];
  const divider = lines[state.i + 1];
  if (!head.includes('|') || divider === undefined) return false;
  if (!DELIMITER_ROW.test(divider)) return false;
  const marks = splitRow(divider);
  const titles = splitRow(head);
  if (marks.length !== titles.length) return false;
  const rows = [];
  let i = state.i + 2;
  while (i < lines.length && !isBlank(lines[i])) {
    if (startsBlock(lines[i], depth) && !itemOf(lines[i])) break;
    rows.push(fitRow(splitRow(lines[i]), titles.length));
    i++;
  }
  const align = marks.map(alignOf);
  addBlock(state, { type: 'table', align, head: titles, rows });
  state.i = i;
  return true;
};

const readIndented = (state) => {
  const { lines } = state;
  const isCode = (line) => line.startsWith('    ');
  if (state.para.length > 0 || !isCode(lines[state.i])) return false;
  const body = [];
  let end = state.i;
  for (let i = state.i; i < lines.length; i++) {
    if (isCode(lines[i])) end = i;
    else if (!isBlank(lines[i])) break;
    body.push(lines[i].slice(4));
  }
  const text = body.slice(0, end - state.i + 1).join('\n');
  addBlock(state, { type: 'code', lang: '', text });
  state.i = end + 1;
  return true;
};

STARTERS.push(
  readFence,
  readHeading,
  readRule,
  readQuote,
  readList,
  readTable,
  readIndented,
);

const FINISHERS = {};

const finishBlock = (block, refs) => FINISHERS[block.type](block, refs);

const finishParagraph = (block, refs) => ({
  type: 'paragraph',
  children: parseInline(block.raw, refs),
});

const finishHeading = (block, refs) => ({
  type: 'heading',
  level: block.level,
  children: parseInline(block.raw, refs),
});

const finishCode = ({ lang, text }) => ({ type: 'code', lang, text });

const finishQuote = (block, refs) => ({
  type: 'quote',
  children: block.children.map((child) => finishBlock(child, refs)),
});

const finishItem = (item, refs) => ({
  checked: item.checked,
  children: item.children.map((child) => finishBlock(child, refs)),
});

const finishList = (block, refs) => {
  const { ordered, start, loose } = block;
  const items = block.items.map((item) => finishItem(item, refs));
  return { type: 'list', ordered, start, loose, items };
};

const finishTable = (block, refs) => {
  const cell = (text) => parseInline(text, refs);
  const head = block.head.map(cell);
  const rows = block.rows.map((row) => row.map(cell));
  return { type: 'table', align: block.align, head, rows };
};

const finishRule = () => ({ type: 'rule' });

Object.assign(FINISHERS, {
  paragraph: finishParagraph,
  heading: finishHeading,
  code: finishCode,
  quote: finishQuote,
  list: finishList,
  table: finishTable,
  rule: finishRule,
});

const parseMarkdown = (source) => {
  const text = `${source ?? ''}`.replace(/\r\n?/g, '\n');
  const lines = text.split('\n').map(expandTabs);
  const refs = new Map();
  const blocks = readBlocks(lines, 0, refs);
  return blocks.map((block) => finishBlock(block, refs));
};

const PLAIN = {};

const plainBlocks = (blocks) =>
  blocks
    .map((block) => PLAIN[block.type](block))
    .filter((text) => text !== '')
    .join('\n');

const plainItem = (item) => plainBlocks(item.children);

const plainTable = ({ head, rows }) => {
  const cells = (row) => row.map(plainInline).join(' ');
  const lines = [head].concat(rows).map(cells);
  return lines.join('\n');
};

Object.assign(PLAIN, {
  paragraph: ({ children }) => plainInline(children),
  heading: ({ children }) => plainInline(children),
  code: ({ text }) => text,
  quote: ({ children }) => plainBlocks(children),
  list: ({ items }) => items.map(plainItem).join('\n'),
  table: plainTable,
  rule: () => '',
});

const plainOf = (source = '') => {
  if (!MARKDOWN_CHARS.test(source)) return source;
  return plainBlocks(parseMarkdown(source));
};

const hasMarkdown = (source) => MARKDOWN_CHARS.test(source);

const hasOpenFence = (text) => {
  let fence = null;
  for (const line of text.split('\n')) fence = trackFence(fence, line);
  return fence !== null;
};

export { parseMarkdown, plainOf, plainInline };
export { hasMarkdown, hasOpenFence };
