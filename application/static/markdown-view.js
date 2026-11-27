import { parseMarkdown, hasMarkdown, plainInline } from './markdown.js';
import { highlight } from './syntax.js';
import { fillText } from './view.js';

const MAX_HIGHLIGHT = 20000;
const COPIED_MS = 1500;
const IMAGE_MARK = '🖼 ';

const createNode = (tag, className = '') => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  return node;
};

const createAnchor = (href, title) => {
  const link = createNode('a');
  link.href = href;
  link.target = '_blank';
  link.rel = 'noopener noreferrer';
  if (title) link.title = title;
  return link;
};

const INLINE = {};

const renderInline = (nodes) => nodes.map((node) => INLINE[node.type](node));

const inlineText = ({ text }) => document.createTextNode(text);

const inlineCode = ({ text }) => {
  const code = createNode('code');
  code.textContent = text;
  return code;
};

const inlineBreak = () => createNode('br');

const inlineWrap = ({ type, children }) => {
  const node = createNode(type);
  node.append(...renderInline(children));
  return node;
};

const inlineLink = ({ href, title, children }) => {
  const link = createAnchor(href, title);
  const label = href.startsWith('/?mention=') ? plainInline(children) : '';
  if (label.startsWith('@')) link.textContent = `#${label.slice(1)}`;
  else link.append(...renderInline(children));
  return link;
};

const inlineImage = ({ src, alt, title }) => {
  const link = createAnchor(src, title);
  link.textContent = `${IMAGE_MARK}${alt || src}`;
  return link;
};

Object.assign(INLINE, {
  text: inlineText,
  code: inlineCode,
  break: inlineBreak,
  em: inlineWrap,
  strong: inlineWrap,
  del: inlineWrap,
  link: inlineLink,
  image: inlineImage,
});

const tokenNode = ({ type, text }) => {
  if (type === 'text') return document.createTextNode(text);
  const span = createNode('span', `tok-${type}`);
  span.textContent = text;
  return span;
};

const fillCode = (code, text, lang) => {
  const isShort = text.length <= MAX_HIGHLIGHT;
  const tokens = isShort && lang ? highlight(text, lang) : null;
  if (!tokens) {
    code.textContent = text;
    return;
  }
  code.replaceChildren(...tokens.map(tokenNode));
};

const flashCopied = (button) => {
  button.textContent = 'copied';
  clearTimeout(button.timer);
  button.timer = setTimeout(() => {
    button.textContent = 'copy';
  }, COPIED_MS);
};

const copyCode = (button, text) => {
  const clipboard = navigator.clipboard;
  if (!clipboard) return;
  clipboard
    .writeText(text)
    .then(() => flashCopied(button))
    .catch(() => {});
};

const createCodeHead = (text, lang) => {
  const head = createNode('div', 'code-head');
  if (lang) {
    const label = createNode('span', 'code-lang');
    label.textContent = lang;
    head.append(label);
  }
  const button = createNode('button', 'code-copy');
  button.type = 'button';
  button.textContent = 'copy';
  button.title = 'Copy code';
  button.onclick = () => copyCode(button, text);
  head.append(button);
  return head;
};

const BLOCKS = {};

const renderBlock = (block, tasks) => BLOCKS[block.type](block, tasks);

const blockCode = ({ text, lang }) => {
  const wrapper = createNode('div', 'code-block');
  const pre = createNode('pre');
  const code = createNode('code');
  fillCode(code, text, lang);
  pre.append(code);
  wrapper.append(createCodeHead(text, lang), pre);
  return wrapper;
};

const blockParagraph = ({ children }) => {
  const paragraph = createNode('p');
  paragraph.append(...renderInline(children));
  return paragraph;
};

const blockHeading = ({ level, children }) => {
  const heading = createNode(`h${level}`);
  heading.append(...renderInline(children));
  return heading;
};

const blockQuote = ({ children }) => {
  const quote = createNode('blockquote');
  quote.append(...children.map((child) => renderBlock(child)));
  return quote;
};

const blockRule = () => createNode('hr');

const renderTight = (child, tasks) => {
  if (child.type === 'paragraph') return renderInline(child.children);
  return [renderBlock(child, tasks)];
};

const createItem = (item, isLoose, tasks) => {
  const node = createNode('li');
  const isTask = item.checked !== null;
  let result;
  if (isTask) {
    const box = createNode('input');
    box.type = 'checkbox';
    box.disabled = true;
    box.checked = item.checked;
    node.className = 'task';
    result = tasks?.get(item)?.(box);
    node.append(box);
  }
  const nodes = isLoose
    ? item.children.map((child) => renderBlock(child, tasks))
    : item.children.flatMap((child) => renderTight(child, tasks));
  if (result && !isLoose && item.children[0]?.type === 'paragraph') {
    nodes.splice(item.children[0].children.length, 0, result);
  } else if (result) {
    nodes[0]?.append(result);
  }
  node.append(...nodes);
  return node;
};

const blockList = ({ ordered, start, loose, items }, tasks) => {
  const list = createNode(ordered ? 'ol' : 'ul');
  if (ordered && start !== 1) list.start = start;
  list.append(...items.map((item) => createItem(item, loose, tasks)));
  return list;
};

const createCell = (tag, nodes, align) => {
  const cell = createNode(tag);
  if (align) cell.style.textAlign = align;
  cell.append(...renderInline(nodes));
  return cell;
};

const createRow = (cells, tag, align) => {
  const row = createNode('tr');
  const items = cells.map((cell, index) => createCell(tag, cell, align[index]));
  row.append(...items);
  return row;
};

const blockTable = ({ align, head, rows }) => {
  const wrapper = createNode('div', 'md-table');
  const table = createNode('table');
  const header = createNode('thead');
  header.append(createRow(head, 'th', align));
  const body = createNode('tbody');
  body.append(...rows.map((row) => createRow(row, 'td', align)));
  table.append(header, body);
  wrapper.append(table);
  return wrapper;
};

Object.assign(BLOCKS, {
  paragraph: blockParagraph,
  heading: blockHeading,
  code: blockCode,
  quote: blockQuote,
  list: blockList,
  table: blockTable,
  rule: blockRule,
});

const isSingleParagraph = (blocks) =>
  blocks.length === 1 && blocks[0].type === 'paragraph';

const renderMarkdown = (element, source, decorateTasks) => {
  element.classList.remove('md');
  if (!hasMarkdown(source)) return void fillText(element, source);
  const blocks = parseMarkdown(source);
  const tasks = decorateTasks?.(blocks);
  if (isSingleParagraph(blocks)) {
    return void element.replaceChildren(...renderInline(blocks[0].children));
  }
  element.classList.add('md');
  element.replaceChildren(...blocks.map((block) => renderBlock(block, tasks)));
};

const FORMAT_MARKS = { b: '**', i: '_' };

const wrapSelection = (input, mark) => {
  const { selectionStart: start, selectionEnd: end, value } = input;
  const inner = value.slice(start, end);
  input.setRangeText(`${mark}${inner}${mark}`, start, end);
  const size = mark.length;
  input.setSelectionRange(start + size, end + size);
  input.dispatchEvent(new Event('input', { bubbles: true }));
};

const formatKey = (event, input) => {
  const isCommand = event.ctrlKey || event.metaKey;
  const isPlain = !event.altKey && !event.shiftKey && !event.isComposing;
  const mark = FORMAT_MARKS[event.key.toLowerCase()];
  if (!isCommand || !isPlain) return;
  if (!mark) return;
  event.preventDefault();
  wrapSelection(input, mark);
};

export { renderMarkdown, renderBlock, formatKey };
