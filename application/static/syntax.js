const words = (text) => new Set(text.split(/\s+/).filter(Boolean));

const NUMBER = [
  /0[xX][\da-fA-F_]+n?/,
  /0[bB][01_]+n?/,
  /0[oO][0-7_]+n?/,
  /\d[\d_]*(?:\.\d[\d_]*)?(?:[eE][+-]?\d+)?[a-zA-Z]{0,3}/,
  /\.\d[\d_]*(?:[eE][+-]?\d+)?/,
]
  .map((pattern) => pattern.source)
  .join('|');

const QUOTED = {
  double: /"(?:\\.|[^"\\\n])*"?/,
  single: /'(?:\\.|[^'\\\n])*'?/,
  template: /`(?:\\[\s\S]|[^`\\])*`?/,
  tdouble: /"""[\s\S]*?(?:"""|$)/,
  tsingle: /'''[\s\S]*?(?:'''|$)/,
  raw: /`[^`]*`?/,
  char: /'(?:\\[^'\n]+|[^'\\\n])'/,
  rust: /b?r(#*)"[\s\S]*?"\1/,
};

const C_COMMENTS = { line: ['//'], block: [['/*', '*/']] };
const HASH_COMMENTS = { line: ['#'], block: [] };

const BASE = {
  keywords: new Set(),
  literals: new Set(),
  types: new Set(),
  line: [],
  block: [],
  strings: [],
  prefix: '',
  capitalTypes: false,
  ignoreCase: false,
  meta: null,
  property: null,
  regexp: false,
  macros: false,
  lifetimes: false,
};

const JS_KEYWORDS = `break case catch class const continue debugger default
  delete do else export extends finally for function if import in instanceof
  let new of return static super switch this throw try typeof var void while
  with yield async await get set`;
const JS_LITERALS = 'true false null undefined NaN Infinity';
const TS_KEYWORDS = `${JS_KEYWORDS} interface type enum implements namespace
  declare readonly abstract as keyof infer satisfies public private protected
  module is asserts override`;
const TS_TYPES = `string number boolean any void never unknown object bigint
  symbol`;

const javascript = {
  ...C_COMMENTS,
  keywords: words(JS_KEYWORDS),
  literals: words(JS_LITERALS),
  strings: ['double', 'single', 'template'],
  capitalTypes: true,
  regexp: true,
  meta: /#!.*/y,
};

const typescript = {
  ...javascript,
  keywords: words(TS_KEYWORDS),
  types: words(TS_TYPES),
  meta: /#!.*|@[A-Za-z_$][\w$.]*/y,
};

const json = {
  ...C_COMMENTS,
  literals: words('true false null'),
  strings: ['double'],
  property: /"(?:\\.|[^"\\\n])*"(?=\s*:)/y,
};

const SH_KEYWORDS = `if then else elif fi for while until do done case esac in
  function select time return exit break continue export local readonly
  declare unset shift source alias set trap eval exec`;
const SH_BUILTINS = `echo cd pwd ls cat grep sed awk cp mv rm mkdir rmdir touch
  chmod chown curl wget git npm node sudo test read printf kill ps tar`;

const shell = {
  ...HASH_COMMENTS,
  keywords: words(SH_KEYWORDS),
  literals: words('true false'),
  functions: words(SH_BUILTINS),
  strings: ['double', 'single'],
  meta: /#!.*|(?<=^|\n)[$%] /y,
  variable: /\$(?:\{[^}\n]*\}|[A-Za-z_]\w*|[0-9@*#?$!-])/y,
  flag: /(?<=\s|^)--?[A-Za-z][\w-]*/y,
};

const PY_KEYWORDS = `and as assert async await break class continue def del
  elif else except finally for from global if import in is lambda nonlocal not
  or pass raise return try while with yield match case`;
const PY_BUILTINS = `print len range int str float list dict set tuple bool
  open type isinstance super enumerate zip map filter sorted sum min max`;

const python = {
  ...HASH_COMMENTS,
  keywords: words(PY_KEYWORDS),
  literals: words('True False None'),
  functions: words(PY_BUILTINS),
  strings: ['tdouble', 'tsingle', 'double', 'single'],
  prefix: '[rRbBfFuU]{1,2}',
  capitalTypes: true,
  meta: /@[A-Za-z_][\w.]*/y,
};

const SQL_KEYWORDS = `select from where and or not insert into values update
  set delete create table alter drop index view join inner outer left right
  full cross on as group by order having limit offset union all distinct case
  when then else end in is like between exists primary key foreign references
  default unique check constraint begin commit rollback transaction with
  returning asc desc if truncate grant revoke database schema`;
const SQL_TYPES = `int integer bigint smallint tinyint serial boolean bool
  varchar char text date time timestamp datetime decimal numeric float double
  real blob json jsonb uuid`;

const sql = {
  line: ['--'],
  block: [['/*', '*/']],
  keywords: words(SQL_KEYWORDS),
  literals: words('true false null'),
  types: words(SQL_TYPES),
  strings: ['single', 'double'],
  ignoreCase: true,
};

const GO_KEYWORDS = `break case chan const continue default defer else
  fallthrough for func go goto if import interface map package range return
  select struct switch type var`;
const GO_TYPES = `string int int8 int16 int32 int64 uint uint8 uint16 uint32
  uint64 uintptr float32 float64 complex64 complex128 bool byte rune error any`;

const go = {
  ...C_COMMENTS,
  keywords: words(GO_KEYWORDS),
  literals: words('true false nil iota'),
  types: words(GO_TYPES),
  strings: ['double', 'raw', 'char'],
  capitalTypes: true,
};

const RUST_KEYWORDS = `as async await break const continue crate dyn else enum
  extern fn for if impl in let loop match mod move mut pub ref return self
  Self static struct super trait type unsafe use where while`;
const RUST_TYPES = `i8 i16 i32 i64 i128 isize u8 u16 u32 u64 u128 usize f32
  f64 bool char str String Vec Option Result Box Rc Arc`;

const rust = {
  ...C_COMMENTS,
  keywords: words(RUST_KEYWORDS),
  literals: words('true false None Some Ok Err'),
  types: words(RUST_TYPES),
  strings: ['rust', 'double', 'char'],
  capitalTypes: true,
  meta: /#!?\[[^\]\n]*\]/y,
  macros: true,
  lifetimes: true,
};

const C_KEYWORDS = `auto break case const continue default do else enum extern
  for goto if inline register restrict return sizeof static struct switch
  typedef union volatile while`;
const CPP_KEYWORDS = `${C_KEYWORDS} class namespace template typename public
  private protected virtual override new delete using try catch throw this
  operator constexpr noexcept final friend mutable explicit nullptr_t`;
const C_TYPES = `void char short int long float double signed unsigned bool
  size_t int8_t int16_t int32_t int64_t uint8_t uint16_t uint32_t uint64_t
  string vector map auto`;

const c = {
  ...C_COMMENTS,
  keywords: words(C_KEYWORDS),
  literals: words('true false NULL nullptr'),
  types: words(C_TYPES),
  strings: ['double', 'char'],
  meta: /(?<=^[ \t]*)#[ \t]*\w+(?:[^\n\\]|\\\n|\\)*/my,
};

const cpp = { ...c, keywords: words(CPP_KEYWORDS), capitalTypes: false };

const JAVA_KEYWORDS = `abstract assert break case catch class const continue
  default do else enum extends final finally for goto if implements import
  instanceof interface native new package private protected public return
  static strictfp super switch synchronized this throw throws transient try
  void volatile while var record sealed permits yield`;
const JAVA_TYPES = `boolean byte char short int long float double String
  Object Integer Long List Map Set`;

const java = {
  ...C_COMMENTS,
  keywords: words(JAVA_KEYWORDS),
  literals: words('true false null'),
  types: words(JAVA_TYPES),
  strings: ['tdouble', 'double', 'char'],
  capitalTypes: true,
  meta: /@[A-Za-z_][\w.]*/y,
};

const CS_KEYWORDS = `abstract as base break case catch checked class const
  continue default delegate do else enum event explicit extern finally fixed
  for foreach goto if implicit in interface internal is lock namespace new
  operator out override params private protected public readonly ref return
  sealed sizeof stackalloc static struct switch this throw try typeof unchecked
  unsafe using virtual volatile while async await var yield record init get set
  partial where`;
const CS_TYPES = `bool byte char decimal double float int long object sbyte
  short string uint ulong ushort void dynamic`;

const csharp = {
  ...C_COMMENTS,
  keywords: words(CS_KEYWORDS),
  literals: words('true false null'),
  types: words(CS_TYPES),
  strings: ['tdouble', 'double', 'char'],
  prefix: '[$@]{1,2}',
  capitalTypes: true,
  meta: /(?<=^[ \t]*)#[ \t]*\w+[^\n]*/my,
};

const PHP_KEYWORDS = `abstract and array as break callable case catch class
  clone const continue declare default do echo else elseif empty enddeclare
  endfor endforeach endif endswitch endwhile extends final finally fn for
  foreach function global goto if implements include include_once instanceof
  insteadof interface isset list match namespace new or print private protected
  public readonly require require_once return static switch throw trait try
  unset use var while xor yield`;

const php = {
  line: ['//', '#'],
  block: [['/*', '*/']],
  keywords: words(PHP_KEYWORDS),
  literals: words('true false null'),
  strings: ['double', 'single'],
  capitalTypes: true,
  ignoreCase: true,
  meta: /<\?(?:php|=)?|\?>/y,
  variable: /\$[A-Za-z_]\w*/y,
};

const RUBY_KEYWORDS = `alias and begin break case class def defined do else
  elsif end ensure for if in module next not or redo rescue retry return self
  super then undef unless until when while yield require require_relative
  attr_accessor attr_reader attr_writer private public protected lambda proc`;

const ruby = {
  ...HASH_COMMENTS,
  keywords: words(RUBY_KEYWORDS),
  literals: words('true false nil'),
  strings: ['double', 'single', 'template'],
  capitalTypes: true,
  variable: /@{1,2}[A-Za-z_]\w*|\$[A-Za-z_]\w*/y,
  symbol: /(?<![\w:]):[A-Za-z_]\w*[?!]?/y,
};

const YAML_VALUE = {
  line: [],
  block: [],
  literals: words('true false null yes no on off ~ True False Null'),
  strings: ['double', 'single'],
  meta: /[&*][\w-]+|!{1,2}[\w!-]*/y,
  comment: /(?<=^|\s)#.*/y,
};

const DAY = /\d{4}-\d\d-\d\d/.source;
const CLOCK = /[Tt ]\d\d:\d\d(?::\d\d(?:\.\d+)?)?(?:[Zz]|[+-]\d\d:\d\d)?/
  .source;
const DATE = new RegExp(`${DAY}(?:${CLOCK})?`, 'y');

const TOML_VALUE = {
  ...HASH_COMMENTS,
  literals: words('true false inf nan'),
  strings: ['tdouble', 'tsingle', 'double', 'single'],
  date: DATE,
};

const INI_VALUE = { ...TOML_VALUE, line: ['#', ';'] };

const LANGUAGES = {
  javascript,
  typescript,
  json,
  shell,
  python,
  sql,
  go,
  rust,
  c,
  cpp,
  java,
  csharp,
  php,
  ruby,
};

const FAMILIES = {
  js: 'javascript',
  javascript: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  jsx: 'javascript',
  ts: 'typescript',
  typescript: 'typescript',
  tsx: 'typescript',
  json: 'json',
  jsonc: 'json',
  html: 'html',
  xml: 'html',
  svg: 'html',
  css: 'css',
  sh: 'shell',
  bash: 'shell',
  shell: 'shell',
  zsh: 'shell',
  console: 'shell',
  py: 'python',
  python: 'python',
  sql: 'sql',
  go: 'go',
  rs: 'rust',
  rust: 'rust',
  c: 'c',
  h: 'c',
  cpp: 'cpp',
  'c++': 'cpp',
  hpp: 'cpp',
  java: 'java',
  cs: 'csharp',
  csharp: 'csharp',
  php: 'php',
  rb: 'ruby',
  ruby: 'ruby',
  yaml: 'yaml',
  yml: 'yaml',
  toml: 'toml',
  ini: 'ini',
  diff: 'diff',
  patch: 'diff',
};

const createTokens = () => ({ list: [], last: null });

const pushToken = (tokens, type, text) => {
  if (text === '') return;
  const last = tokens.list.at(-1);
  if (last && last.type === type) last.text += text;
  else tokens.list.push({ type, text });
  const isSpace = type === 'text' && text.trim() === '';
  if (!isSpace) tokens.last = { type: type === 'text' ? 'value' : type, text };
};

const sticky = (pattern) => new RegExp(pattern.source, 'y');

const stringRule = (name, prefix) => {
  const pattern = QUOTED[name];
  const isPrefixed = prefix && !['char', 'raw', 'rust'].includes(name);
  const source = isPrefixed
    ? `(?:${prefix})?${pattern.source}`
    : pattern.source;
  return new RegExp(source, 'y');
};

const commentRules = (def) => {
  const rules = new Array(def.block.length + def.line.length).fill(null);
  let index = 0;
  for (const pair of def.block) {
    const open = pair[0];
    const close = pair[1];
    const escape = (text) => text.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
    const source = `${escape(open)}[\\s\\S]*?(?:${escape(close)}|$)`;
    rules[index++] = new RegExp(source, 'y');
  }
  for (const start of def.line) {
    const escape = start.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
    rules[index++] = new RegExp(`${escape}[^\\n]*`, 'y');
  }
  return rules;
};

const REGEXP = /\/(?![/*])(?:\\.|\[(?:\\.|[^\]\\\n])*\]|[^/\\\n[])+\/[a-z]*/y;
const IDENTIFIER = /[A-Za-z_$][\w$]*/y;
const NUMBER_RULE = new RegExp(NUMBER, 'y');
const OPERATOR = /[+\-*/%=<>!&|^~?:@]+/y;
const PUNCTUATION = /[{}()[\];,.]/y;
const SPACE = /\s+/y;
const LIFETIME = /'[A-Za-z_]\w*/y;

const VALUE_BEFORE = [
  'literal',
  'number',
  'string',
  'regexp',
  'type',
  'value',
  'property',
  'function',
];

const canStartRegexp = ({ last }) => {
  if (!last) return true;
  if (VALUE_BEFORE.includes(last.type)) return false;
  if (last.type === 'keyword') return !['this', 'super'].includes(last.text);
  const isClose = last.type === 'punctuation' && ')]}'.includes(last.text);
  return !isClose;
};

const compile = (def) => {
  const rules = [];
  const add = (type, regex, guard) => rules.push({ type, regex, guard });
  if (def.meta) add('meta', sticky(def.meta));
  if (def.comment) add('comment', sticky(def.comment));
  for (const regex of commentRules(def)) add('comment', regex);
  if (def.property) add('property', sticky(def.property));
  if (def.symbol) add('literal', sticky(def.symbol));
  if (def.date) add('number', sticky(def.date));
  for (const name of def.strings) add('string', stringRule(name, def.prefix));
  if (def.regexp) add('regexp', REGEXP, canStartRegexp);
  if (def.variable) add('property', sticky(def.variable));
  if (def.flag) add('attr', sticky(def.flag));
  if (def.lifetimes) add('type', LIFETIME);
  return rules;
};

const wordType = (def, word, rest) => {
  const key = def.ignoreCase ? word.toLowerCase() : word;
  if (def.keywords.has(key)) return 'keyword';
  if (def.literals.has(key)) return 'literal';
  if (def.types.has(key)) return 'type';
  const isCall = /^\s*\(/.test(rest);
  const isMacro = def.macros && /^!\s*[([{]/.test(rest);
  const isKnown = def.functions?.has(word);
  if (isCall || isMacro || isKnown) return 'function';
  if (def.capitalTypes && /^[A-Z]/.test(word)) return 'type';
  return 'text';
};

const matchAt = (regex, code, pos) => {
  regex.lastIndex = pos;
  return regex.exec(code);
};

const tryRules = (rules, code, pos, tokens) => {
  for (const { type, regex, guard } of rules) {
    if (guard && !guard(tokens)) continue;
    const match = matchAt(regex, code, pos);
    if (match && match[0] !== '') return { type, text: match[0] };
  }
  return null;
};

const scanWord = (def, code, pos) => {
  const match = matchAt(IDENTIFIER, code, pos);
  if (!match) return null;
  const word = match[0];
  const rest = code.slice(pos + word.length, pos + word.length + 8);
  return { type: wordType(def, word, rest), text: word };
};

const scanSimple = (code, pos) => {
  const checks = [
    ['text', SPACE],
    ['number', NUMBER_RULE],
    ['operator', OPERATOR],
    ['punctuation', PUNCTUATION],
  ];
  for (const pair of checks) {
    const type = pair[0];
    const regex = pair[1];
    const match = matchAt(regex, code, pos);
    if (match) return { type, text: match[0] };
  }
  return { type: 'text', text: code[pos] };
};

const PREPARED = new WeakMap();

const prepare = (source) => {
  const cached = PREPARED.get(source);
  if (cached) return cached;
  const def = { ...BASE, ...source };
  const prepared = { def, rules: compile(def) };
  PREPARED.set(source, prepared);
  return prepared;
};

const tokenizeGeneric = (code, source) => {
  const { def, rules } = prepare(source);
  const tokens = createTokens();
  let pos = 0;
  while (pos < code.length) {
    const found =
      tryRules(rules, code, pos, tokens) ??
      scanWord(def, code, pos) ??
      scanSimple(code, pos);
    pushToken(tokens, found.type, found.text);
    pos += found.text.length;
  }
  return tokens.list;
};

const TAG_OPEN = /<\/?[A-Za-z][\w:.-]*/y;
const TAG_END = /\/?>/y;
const ATTRIBUTE = /[^\s=<>/"']+/y;
const ATTR_VALUE = /"[^"]*"?|'[^']*'?|[^\s"'<>`]+/y;
const COMMENT_HTML = /<!--[\s\S]*?(?:-->|$)/y;
const DECLARATION = /<[!?][^>]*>?/y;
const ENTITY_HTML = /&#?\w+;/y;

const scanAttribute = (code, pos, tokens) => {
  const space = matchAt(SPACE, code, pos);
  if (space) {
    pushToken(tokens, 'text', space[0]);
    return space[0].length;
  }
  const name = matchAt(ATTRIBUTE, code, pos);
  if (name) {
    pushToken(tokens, 'attr', name[0]);
    return name[0].length;
  }
  if (code[pos] !== '=') {
    pushToken(tokens, 'text', code[pos]);
    return 1;
  }
  pushToken(tokens, 'punctuation', '=');
  const value = matchAt(ATTR_VALUE, code, pos + 1);
  if (value) pushToken(tokens, 'string', value[0]);
  return 1 + (value ? value[0].length : 0);
};

const scanAttributes = (code, start, tokens) => {
  let pos = start;
  while (pos < code.length) {
    const end = matchAt(TAG_END, code, pos);
    if (end) {
      pushToken(tokens, 'tag', end[0]);
      return pos + end[0].length;
    }
    if (code[pos] === '<') return pos;
    pos += scanAttribute(code, pos, tokens);
  }
  return pos;
};

const NEXT_MARKUP = /[<&]/g;

const scanText = (code, pos, tokens) => {
  NEXT_MARKUP.lastIndex = pos + 1;
  const next = NEXT_MARKUP.exec(code);
  const stop = next ? next.index : code.length;
  pushToken(tokens, 'text', code.slice(pos, stop));
  return stop - pos;
};

const SCANNERS = [
  ['comment', COMMENT_HTML],
  ['meta', DECLARATION],
  ['literal', ENTITY_HTML],
];

const scanMarkup = (code, pos, tokens) => {
  for (const pair of SCANNERS) {
    const type = pair[0];
    const regex = pair[1];
    const match = matchAt(regex, code, pos);
    if (!match) continue;
    pushToken(tokens, type, match[0]);
    return match[0].length;
  }
  const open = matchAt(TAG_OPEN, code, pos);
  if (!open) return scanText(code, pos, tokens);
  pushToken(tokens, 'tag', open[0]);
  return scanAttributes(code, pos + open[0].length, tokens) - pos;
};

const tokenizeHtml = (code) => {
  const tokens = createTokens();
  let pos = 0;
  while (pos < code.length) pos += scanMarkup(code, pos, tokens);
  return tokens.list;
};

const CSS_COMMENT = /\/\*[\s\S]*?(?:\*\/|$)/y;
const CSS_STRING = /"(?:\\.|[^"\\\n])*"?|'(?:\\.|[^'\\\n])*'?/y;
const CSS_STATEMENT = new RegExp(
  [
    /\/\*[\s\S]*?\*\//,
    /"(?:\\.|[^"\\\n])*"?/,
    /'(?:\\.|[^'\\\n])*'?/,
    /\([^)]*\)?/,
    /[^{};"'(/]/,
    /\//,
  ]
    .map((part) => `(?:${part.source})`)
    .join('|')
    .replace(/^/, '(?:')
    .concat(')*'),
  'y',
);
const CSS_AT = /@[\w-]+/y;
const CSS_CLASS = /[.#][\w-]+/y;
const CSS_PSEUDO = /::?[\w-]+(?:\([^)]*\))?/y;
const CSS_ATTRIBUTE = /\[[^\]]*\]/y;
const CSS_TAG = /[A-Za-z][\w-]*|\*/y;
const CSS_PROPERTY = /[\w-]+(?=\s*:)/y;
const CSS_VALUE_NUMBER =
  /#[\da-fA-F]{3,8}\b|[+-]?(?:\d*\.)?\d+(?:%|[a-zA-Z]+)?/y;
const CSS_FUNCTION = /[\w-]+(?=\()/y;
const CSS_IMPORTANT = /!\s*important/y;
const CSS_WORD = /[\w-]+/y;
const CSS_CUSTOM = /--[\w-]+/y;

const SELECTOR_RULES = [
  ['comment', CSS_COMMENT],
  ['string', CSS_STRING],
  ['type', CSS_CLASS],
  ['attr', CSS_PSEUDO],
  ['attr', CSS_ATTRIBUTE],
  ['keyword', CSS_AT],
  ['tag', CSS_TAG],
  ['operator', /[>+~,*]+/y],
  ['text', SPACE],
];

const VALUE_RULES = [
  ['comment', CSS_COMMENT],
  ['string', CSS_STRING],
  ['keyword', CSS_IMPORTANT],
  ['keyword', CSS_AT],
  ['number', CSS_VALUE_NUMBER],
  ['function', CSS_FUNCTION],
  ['property', CSS_CUSTOM],
  ['text', CSS_WORD],
  ['text', SPACE],
  ['punctuation', /[(),:/]/y],
  ['operator', /[+\-*=<>~|^]+/y],
];

const scanRules = (rules, chunk, tokens) => {
  let pos = 0;
  while (pos < chunk.length) {
    let found = null;
    for (const pair of rules) {
      const type = pair[0];
      const regex = pair[1];
      const match = matchAt(regex, chunk, pos);
      if (match && match[0] !== '') {
        found = { type, text: match[0] };
        break;
      }
    }
    found ??= { type: 'text', text: chunk[pos] };
    pushToken(tokens, found.type, found.text);
    pos += found.text.length;
  }
};

const scanDeclaration = (chunk, tokens) => {
  const lead = matchAt(SPACE, chunk, 0)?.[0] ?? '';
  pushToken(tokens, 'text', lead);
  const name = matchAt(CSS_PROPERTY, chunk, lead.length);
  const size = lead.length + (name ? name[0].length : 0);
  if (name) pushToken(tokens, 'property', name[0]);
  scanRules(VALUE_RULES, chunk.slice(size), tokens);
};

const scanStatement = (code, pos, tokens) => {
  const match = matchAt(CSS_STATEMENT, code, pos);
  const chunk = match[0];
  const end = pos + chunk.length;
  const stop = code[end];
  const isRule = stop === '{';
  const isAt = chunk.trimStart().startsWith('@');
  if (isRule && !isAt) scanRules(SELECTOR_RULES, chunk, tokens);
  else if (isRule) scanRules(VALUE_RULES, chunk, tokens);
  else scanDeclaration(chunk, tokens);
  if (stop === undefined) return end;
  pushToken(tokens, 'punctuation', stop);
  return end + 1;
};

const tokenizeCss = (code) => {
  const tokens = createTokens();
  let pos = 0;
  while (pos < code.length) {
    const before = pos;
    pos = scanStatement(code, pos, tokens);
    if (pos === before) pos++;
  }
  return tokens.list;
};

const splitLines = (code) => code.match(/[^\n]*\n|[^\n]+$/g) ?? [];

const DIFF_META = [
  'diff ',
  'index ',
  '--- ',
  '+++ ',
  '@@',
  'new file',
  'deleted file',
  'similarity',
  'rename',
  'old mode',
  'new mode',
];

const diffTypeOf = (line) => {
  if (DIFF_META.some((prefix) => line.startsWith(prefix))) return 'meta';
  if (line.startsWith('+')) return 'inserted';
  if (line.startsWith('-')) return 'deleted';
  return 'text';
};

const tokenizeDiff = (code) => {
  const tokens = createTokens();
  for (const line of splitLines(code)) {
    pushToken(tokens, diffTypeOf(line), line);
  }
  return tokens.list;
};

const YAML_KEY = new RegExp(
  [
    /^(\s*(?:-\s+)*)/,
    /((?:"[^"]*"|'[^']*'|[^\s#:'"-][^#:]*?|-[^\s#:][^#:]*?))/,
    /(:)(?=\s|$)/,
  ]
    .map((part) => part.source)
    .join(''),
);
const YAML_SCALAR = /^[|>][+-]?\d?\s*(?:#.*)?$/;
const YAML_DASH = /^(\s*)(-)(?=\s|$)/;

const yamlLine = (line, tokens) => {
  const key = YAML_KEY.exec(line);
  if (key) {
    const all = key[0];
    const lead = key[1];
    const name = key[2];
    const colon = key[3];
    pushToken(tokens, 'text', lead);
    pushToken(tokens, 'property', name);
    pushToken(tokens, 'punctuation', colon);
    return line.slice(all.length);
  }
  const dash = YAML_DASH.exec(line);
  if (!dash) return line;
  pushToken(tokens, 'text', dash[1]);
  pushToken(tokens, 'punctuation', dash[2]);
  return line.slice(dash[0].length);
};

const scanValue = (text, def, tokens) => {
  for (const token of tokenizeGeneric(text, def)) {
    pushToken(tokens, token.type, token.text);
  }
};

const tokenizeYaml = (code) => {
  const tokens = createTokens();
  let block = -1;
  for (const line of splitLines(code)) {
    const body = line.replace(/\n$/, '');
    const indent = body.length - body.trimStart().length;
    const isInside = block >= 0 && (body.trim() === '' || indent > block);
    if (isInside) {
      pushToken(tokens, 'string', line);
      continue;
    }
    block = -1;
    if (/^(?:---|\.\.\.)\s*$/.test(body)) {
      pushToken(tokens, 'meta', line);
      continue;
    }
    const rest = yamlLine(body, tokens);
    if (YAML_SCALAR.test(rest.trim())) block = indent;
    scanValue(rest + line.slice(body.length), YAML_VALUE, tokens);
  }
  return tokens.list;
};

const SECTION = /^(\s*)(\[\[?[^\]\n]*\]\]?)(.*)$/;
const ASSIGN = /^(\s*)([\w.\-"' ]+?)(\s*)([=:])(\s*)(.*)$/;

const tokenizeProperties = (code, def) => {
  const tokens = createTokens();
  for (const line of splitLines(code)) {
    const body = line.replace(/\n$/, '');
    const eol = line.slice(body.length);
    const section = SECTION.exec(body);
    const assign = section ? null : ASSIGN.exec(body);
    const isComment = def.line.includes(body.trimStart()[0]);
    if (isComment) {
      pushToken(tokens, 'comment', line);
    } else if (section) {
      pushToken(tokens, 'text', section[1]);
      pushToken(tokens, 'type', section[2]);
      scanValue(section[3] + eol, def, tokens);
    } else if (assign) {
      pushToken(tokens, 'text', assign[1]);
      pushToken(tokens, 'property', assign[2]);
      pushToken(tokens, 'text', assign[3]);
      pushToken(tokens, 'operator', assign[4]);
      pushToken(tokens, 'text', assign[5]);
      scanValue(assign[6] + eol, def, tokens);
    } else {
      scanValue(line, def, tokens);
    }
  }
  return tokens.list;
};

const tokenizeToml = (code) => tokenizeProperties(code, TOML_VALUE);
const tokenizeIni = (code) => tokenizeProperties(code, INI_VALUE);

const TOKENIZERS = {
  html: tokenizeHtml,
  css: tokenizeCss,
  yaml: tokenizeYaml,
  toml: tokenizeToml,
  ini: tokenizeIni,
  diff: tokenizeDiff,
};

const highlight = (code, lang) => {
  const family = FAMILIES[`${lang ?? ''}`.toLowerCase()];
  if (!family) return null;
  const tokenize = TOKENIZERS[family];
  if (tokenize) return tokenize(code);
  return tokenizeGeneric(code, LANGUAGES[family]);
};

export { highlight };
