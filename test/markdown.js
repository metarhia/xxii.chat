'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const loadMarkdown = () => import('../application/static/markdown.js');
const loadSyntax = () => import('../application/static/syntax.js');

const text = (value) => ({ type: 'text', text: value });
const para = (...children) => ({ type: 'paragraph', children });

const parse = async (source) => (await loadMarkdown()).parseMarkdown(source);

const inlines = async (source) => {
  const block = (await parse(source))[0];
  return block.children;
};

const plain = async (source) => (await loadMarkdown()).plainOf(source);

test('paragraphs, line breaks, and no setext headings', async () => {
  assert.deepEqual(await parse('one\ntwo\n\nthree'), [
    para(text('one\ntwo')),
    para(text('three')),
  ]);
  assert.deepEqual(await parse('title\n---'), [
    para(text('title')),
    { type: 'rule' },
  ]);
  assert.deepEqual(await parse('a\\\nb'), [
    para(text('a'), { type: 'break' }, text('b')),
  ]);
  assert.deepEqual(await parse(''), []);
  assert.deepEqual(await parse('\r\none\r\ntwo'), [para(text('one\ntwo'))]);
});

test('ATX headings drop the closing run and need a space', async () => {
  const blocks = await parse('# One #\n###### Six\n#tag\n####### seven');
  assert.deepEqual(blocks[0], {
    type: 'heading',
    level: 1,
    children: [text('One')],
  });
  assert.equal(blocks[1].level, 6);
  assert.deepEqual(blocks[2], para(text('#tag\n####### seven')));
});

test('fenced code: info string, tildes, longer fences, unclosed', async () => {
  const js = (await parse('```js title\nlet a;\n```'))[0];
  assert.deepEqual(js, { type: 'code', lang: 'js', text: 'let a;' });
  const tilde = (await parse('~~~\n```\nx\n```\n~~~'))[0];
  assert.deepEqual(tilde, { type: 'code', lang: '', text: '```\nx\n```' });
  const long = (await parse('````\n```\n````'))[0];
  assert.equal(long.text, '```');
  const open = (await parse('```py\nprint(1)\n\nmore'))[0];
  assert.deepEqual(open, {
    type: 'code',
    lang: 'py',
    text: 'print(1)\n\nmore',
  });
  const inline = (await parse('```code``` in a line'))[0];
  assert.equal(inline.type, 'paragraph');
});

test('indented code does not interrupt a paragraph', async () => {
  assert.deepEqual(await parse('    code\n\n    more\ntext'), [
    { type: 'code', lang: '', text: 'code\n\nmore' },
    para(text('text')),
  ]);
  assert.deepEqual(await parse('para\n    still para'), [
    para(text('para\nstill para')),
  ]);
  const tab = (await parse('\tcode'))[0];
  assert.deepEqual(tab, { type: 'code', lang: '', text: 'code' });
});

test('block quotes nest and continue lazily', async () => {
  const quote = (await parse('> one\nlazy\n> > deep'))[0];
  assert.equal(quote.type, 'quote');
  assert.deepEqual(quote.children[0], para(text('one\nlazy')));
  assert.equal(quote.children[1].type, 'quote');
  assert.deepEqual(quote.children[1].children, [para(text('deep'))]);
  const blocks = await parse('> a\n\nb');
  assert.deepEqual(
    blocks.map((block) => block.type),
    ['quote', 'paragraph'],
  );
  const fenced = (await parse('> ```\n> x\n> ```'))[0];
  assert.deepEqual(fenced.children, [{ type: 'code', lang: '', text: 'x' }]);
});

test('lists: bullets, numbers, start, nesting, tight and loose', async () => {
  const tight = (await parse('- a\n- b\n  - c\n+ d'))[0];
  assert.equal(tight.type, 'list');
  assert.equal(tight.ordered, false);
  assert.equal(tight.loose, false);
  assert.equal(tight.items.length, 2);
  const first = tight.items[1].children[0];
  assert.deepEqual(first, para(text('b')));
  assert.equal(tight.items[1].children[1].type, 'list');
  const blocks = await parse('- a\n- b\n+ d');
  assert.equal(blocks.length, 2);
  const loose = (await parse('- a\n\n- b'))[0];
  assert.equal(loose.loose, true);
  const inner = (await parse('- a\n\n  b\n- c'))[0];
  assert.equal(inner.loose, true);
  const numbers = (await parse('3. x\n4. y\n5) z'))[0];
  assert.equal(numbers.ordered, true);
  assert.equal(numbers.start, 3);
  assert.equal(numbers.items.length, 2);
  const paren = (await parse('1) one\n2) two'))[0];
  assert.equal(paren.items.length, 2);
});

test('lists: interrupting, lazy lines, empty items', async () => {
  const mixed = (await parse('text\n- item'))[0];
  assert.equal(mixed.type, 'paragraph');
  const blocks = await parse('text\n- item');
  assert.deepEqual(
    blocks.map((block) => block.type),
    ['paragraph', 'list'],
  );
  const late = await parse('text\n2. item');
  assert.equal(late.length, 1);
  const first = await parse('text\n1. item');
  assert.equal(first.length, 2);
  const lazy = (await parse('- one\nlazy\n- two'))[0];
  assert.deepEqual(lazy.items[0].children, [para(text('one\nlazy'))]);
  const empty = (await parse('-\n- b'))[0];
  assert.equal(empty.items.length, 2);
  assert.deepEqual(empty.items[0].children, []);
  const indent = (await parse('1.  one\n    more\n2. two'))[0];
  assert.deepEqual(indent.items[0].children, [para(text('one\nmore'))]);
  const code = (await parse('- ```\n  x\n  ```'))[0];
  assert.deepEqual(code.items[0].children, [
    { type: 'code', lang: '', text: 'x' },
  ]);
});

test('task items are checked, unchecked, or plain', async () => {
  const list = (await parse('- [ ] todo\n- [x] done\n- [X] big\n- [y] no'))[0];
  const checked = list.items.map((item) => item.checked);
  assert.deepEqual(checked, [false, true, true, null]);
  assert.deepEqual(list.items[0].children, [para(text('todo'))]);
  assert.deepEqual(list.items[3].children, [para(text('[y] no'))]);
});

test('thematic breaks', async () => {
  for (const line of ['---', '***', '___', '- - -', ' * * * *']) {
    assert.deepEqual(await parse(line), [{ type: 'rule' }], line);
  }
  const bullet = (await parse('* a'))[0];
  assert.equal(bullet.type, 'list');
});

test('tables: alignment, escaped pipes, short and long rows', async () => {
  const source =
    '| a | b | c |\n|:--|:-:|--:|\n| 1 \\| x | 2 |\n| 3 | 4 | 5 | 6 |';
  const table = (await parse(source))[0];
  assert.equal(table.type, 'table');
  assert.deepEqual(table.align, ['left', 'center', 'right']);
  assert.deepEqual(table.head, [[text('a')], [text('b')], [text('c')]]);
  assert.equal(table.rows.length, 2);
  assert.deepEqual(table.rows[0][0], [text('1 | x')]);
  assert.deepEqual(table.rows[0][2], []);
  assert.equal(table.rows[1].length, 3);
  const bare = (await parse('a | b\n--|--\n1 | 2'))[0];
  assert.deepEqual(bare.align, ['', '']);
  const lone = (await parse('| a | b |\n|---|\n| 1 | 2 |'))[0];
  assert.equal(lone.type, 'paragraph');
  const stop = await parse('| a |\n|---|\n| 1 |\n\ntext');
  assert.deepEqual(
    stop.map((block) => block.type),
    ['table', 'paragraph'],
  );
  const cells = await parse('| **a** | `b` |\n|--|--|\n| x | y |');
  assert.equal(cells[0].head[0][0].type, 'strong');
});

test('reference definitions are removed and resolved', async () => {
  const source =
    '[Foo  Bar]: http://x.test "T"\n\n[foo bar] [x][FOO BAR] [foo bar][]';
  const blocks = await parse(source);
  assert.equal(blocks.length, 1);
  const children = blocks[0].children;
  const one = children[0];
  const two = children[2];
  const three = children[4];
  assert.equal(one.href, 'http://x.test');
  assert.equal(one.title, 'T');
  assert.deepEqual(two.children, [text('x')]);
  assert.equal(three.href, 'http://x.test');
  const missing = (await parse('[nope] and [a][b]'))[0];
  assert.deepEqual(missing, para(text('[nope] and [a][b]')));
  const first = await parse('[a]: http://1.test\n[a]: http://2.test\n\n[a]');
  assert.equal(first[0].children[0].href, 'http://1.test');
});

test('emphasis follows the delimiter rules', async () => {
  const parsed = await inlines('*a* _b_ **c**');
  const em = parsed[0];
  const under = parsed[2];
  const strong = parsed[4];
  assert.equal(em.type, 'em');
  assert.equal(under.type, 'em');
  assert.equal(strong.type, 'strong');
  const both = await inlines('***both***');
  assert.deepEqual(both, [
    {
      type: 'em',
      children: [{ type: 'strong', children: [text('both')] }],
    },
  ]);
  assert.deepEqual(await inlines('snake_case_word'), [text('snake_case_word')]);
  assert.deepEqual(await inlines('2 * 3 * 4'), [text('2 * 3 * 4')]);
  assert.deepEqual(await inlines('a*b*c'), [
    text('a'),
    { type: 'em', children: [text('b')] },
    text('c'),
  ]);
  assert.deepEqual(await inlines('**a *b* c**'), [
    {
      type: 'strong',
      children: [text('a '), { type: 'em', children: [text('b')] }, text(' c')],
    },
  ]);
  assert.deepEqual(await inlines('*a **b***'), [
    {
      type: 'em',
      children: [text('a '), { type: 'strong', children: [text('b')] }],
    },
  ]);
  assert.deepEqual(await inlines('**a*'), [
    text('*'),
    { type: 'em', children: [text('a')] },
  ]);
  assert.deepEqual(await inlines('*foo**bar**baz*'), [
    {
      type: 'em',
      children: [
        text('foo'),
        { type: 'strong', children: [text('bar')] },
        text('baz'),
      ],
    },
  ]);
});

test('strikethrough needs exactly two tildes', async () => {
  assert.deepEqual(await inlines('~~gone~~'), [
    { type: 'del', children: [text('gone')] },
  ]);
  assert.deepEqual(await inlines('~one~ and ~~~three~~~'), [
    text('~one~ and ~~~three~~~'),
  ]);
});

test('code spans, escapes, and entities', async () => {
  assert.deepEqual(await inlines('`a` ``b`c`` ` x `'), [
    { type: 'code', text: 'a' },
    text(' '),
    { type: 'code', text: 'b`c' },
    text(' '),
    { type: 'code', text: 'x' },
  ]);
  assert.deepEqual(await inlines('`*not em*` and `unclosed'), [
    { type: 'code', text: '*not em*' },
    text(' and `unclosed'),
  ]);
  assert.deepEqual(await inlines('\\*a\\* \\# \\q'), [text('*a* # \\q')]);
  const entities = '&amp; &lt;b&gt; &quot; &#39; &nbsp; &#65; &#x42; &zzz; &';
  assert.deepEqual(await inlines(entities), [text('& <b> " \'   A B &zzz; &')]);
  assert.deepEqual(await inlines('&#0; &#xD800;'), [text('� �')]);
});

test('links: inline, titles, pointed, balanced parentheses', async () => {
  const plainLink = (await inlines('[a](http://x.test)'))[0];
  assert.deepEqual(plainLink, {
    type: 'link',
    href: 'http://x.test',
    title: '',
    children: [text('a')],
  });
  const titled = (await inlines('[a](https://x.test/p "The title")'))[0];
  assert.equal(titled.title, 'The title');
  const single = (await inlines(`[a](https://x.test 'T')`))[0];
  assert.equal(single.title, 'T');
  const pointed = (await inlines('[a](<https://x.test/a b>)'))[0];
  assert.equal(pointed.href, 'https://x.test/a b');
  const paren = (await inlines('[a](https://x.test/a_(b)_c)'))[0];
  assert.equal(paren.href, 'https://x.test/a_(b)_c');
  const rich = (await inlines('[**bold** `c`](http://x.test)'))[0];
  assert.equal(rich.children[0].type, 'strong');
  const mail = (await inlines('[m](mailto:a@b.test)'))[0];
  assert.equal(mail.href, 'mailto:a@b.test');
  assert.deepEqual(
    await inlines('[a] (http://x.test)').then((n) => n[0]),
    text('[a] ('),
  );
});

test('links never nest', async () => {
  const nodes = await inlines('[a [b](http://in.test) c](http://out.test)');
  const links = nodes.filter((node) => node.type === 'link');
  const hrefs = links.map((node) => node.href);
  assert.deepEqual(hrefs, ['http://in.test', 'http://out.test']);
  assert.ok(links[0].children.every((node) => node.type === 'text'));
  const bare = (await inlines('[http://x.test](http://x.test)'))[0];
  assert.deepEqual(bare.children, [text('http://x.test')]);
});

test('images become links data and never load', async () => {
  const image = (await inlines('![alt *x*](https://x.test/i.png "T")'))[0];
  assert.deepEqual(image, {
    type: 'image',
    src: 'https://x.test/i.png',
    alt: 'alt x',
    title: 'T',
  });
  assert.deepEqual(await inlines('![bad](data:image/png;base64,AAAA)'), [
    text('bad'),
  ]);
});

test('autolinks: pointed, emails, bare URLs and trimming', async () => {
  const pointed = (await inlines('<https://x.test/a?b=c>'))[0];
  assert.equal(pointed.href, 'https://x.test/a?b=c');
  assert.deepEqual(pointed.children, [text('https://x.test/a?b=c')]);
  const mail = (await inlines('<me@host.test>'))[0];
  assert.equal(mail.href, 'mailto:me@host.test');
  const word = (await inlines('<javascript:alert(1)>'))[0];
  assert.equal(word.type, 'text');
  const bare = await inlines(
    'see https://x.test/a_b, (http://y.test/q) and www.z.test.',
  );
  const links = bare.filter((node) => node.type === 'link');
  assert.deepEqual(
    links.map((node) => node.href),
    ['https://x.test/a_b', 'http://y.test/q', 'https://www.z.test'],
  );
  assert.deepEqual(bare.at(-1), text('.'));
  const wiki = (await inlines('https://x.test/w_(v)).'))[0];
  assert.equal(wiki.href, 'https://x.test/w_(v)');
  const nope = await inlines('nohttp://x and xwww.y');
  assert.equal(nope.length, 1);
});

test('URL safety: only http, https, and mailto become links', async () => {
  const bad = [
    '[x](javascript:alert(1))',
    '[x](JaVaScRiPt:alert(1))',
    '[x](data:text/html,hi)',
    '[x](vbscript:run)',
    '[x](file:///etc/passwd)',
    '[x](/relative/path)',
    '[x](//host.test/p)',
    '[x](  java\tscript:alert(1))',
    '[x](<javascript:alert(1)>)',
  ];
  for (const source of bad) {
    const nodes = await inlines(source);
    const links = nodes.filter((node) => node.type === 'link');
    assert.equal(links.length, 0, source);
    assert.ok(
      nodes.every((node) => node.type === 'text'),
      source,
    );
  }
  const reference = (await parse('[x]: javascript:alert(1)\n\n[x]'))[0];
  assert.deepEqual(reference, para(text('x')));
  const upper = await inlines('[x](HTTPS://X.TEST)');
  assert.equal(upper[0].type, 'link');
});

test('raw HTML is text', async () => {
  const source = '<img src=x onerror=alert(1)> <b>bold</b> <script>x</script>';
  assert.deepEqual(await inlines(source), [text(source)]);
  const block = (await parse('<div>\nhi\n</div>'))[0];
  assert.deepEqual(block, para(text('<div>\nhi\n</div>')));
});

test('plainOf removes Markdown and keeps code and link text', async () => {
  const source =
    '# Title\n\n**bold** and [link](http://x.test) `code`\n\n- a\n- b';
  assert.equal(await plain(source), 'Title\nbold and link code\na\nb');
  assert.equal(await plain('```js\nlet a = 1;\n```'), 'let a = 1;');
  assert.equal(
    await plain('> quote\n\n---\n| a | b |\n|-|-|\n| 1 | 2 |'),
    'quote\na b\n1 2',
  );
  assert.equal(await plain('![alt](https://x.test/i.png)'), 'alt');
  assert.equal(await plain('just text, plain'), 'just text, plain');
  assert.equal(await plain(''), '');
  assert.equal(await plain(undefined), '');
});

test('open fence detection for the composer', async () => {
  const { hasOpenFence } = await loadMarkdown();
  assert.equal(hasOpenFence('```js'), true);
  assert.equal(hasOpenFence('```js\ncode\n```'), false);
  assert.equal(hasOpenFence('```js\ncode\n```\n~~~'), true);
  assert.equal(hasOpenFence('````\n```\n'), true);
  assert.equal(hasOpenFence('text ``` inline'), false);
  assert.equal(hasOpenFence(''), false);
});

test('nesting stops at depth ten', async () => {
  const depthOf = (blocks) => {
    let depth = 0;
    let level = blocks;
    while (level[0]?.type === 'quote') {
      depth++;
      level = level[0].children;
    }
    return { depth, rest: level[0] };
  };
  const { depth, rest } = depthOf(await parse(`${'>'.repeat(14)} deep`));
  assert.equal(depth, 10);
  assert.deepEqual(rest, para(text('>>>> deep')));
  const lines = Array.from(
    { length: 14 },
    (_, i) => `${'  '.repeat(i)}- x${i}`,
  );
  let level = await parse(lines.join('\n'));
  let lists = 0;
  while (level[0]?.type === 'list') {
    lists++;
    level = level[0].items[0].children.slice(1);
  }
  assert.equal(lists, 10);
});

test('pathological 64 KB messages parse fast', async () => {
  const { parseMarkdown } = await loadMarkdown();
  const size = 64 * 1024;
  const cases = {
    stars: '*a '.repeat(size / 3),
    closers: 'a* '.repeat(size / 3),
    mixed: '*_'.repeat(size / 2),
    nested: `${'*a '.repeat(size / 6)}${'a* '.repeat(size / 6)}`,
    brackets: '['.repeat(size),
    closing: ']'.repeat(size),
    links: '[a](x'.repeat(size / 5),
    refs: '[a]: x\n\n' + '[a][b]'.repeat(size / 6),
    ticks: '`'.repeat(size),
    ticksOdd: '`a``'.repeat(size / 4),
    quotes: '>'.repeat(size),
    lists: '- '.repeat(size / 2),
    deepLists: Array.from(
      { length: size / 8 },
      (_, i) => `${' '.repeat(i % 40)}- a`,
    ).join('\n'),
    pipes: `|${'a|'.repeat(size / 2 - 4)}\n|${'-|'.repeat(size / 2 - 4)}`,
    lines: 'line\n'.repeat(size / 5),
    blank: '\n'.repeat(size),
    urls: 'http://a.b/'.repeat(size / 11),
    angle: '<a:'.repeat(size / 3),
    entities: '&amp'.repeat(size / 4),
    tilde: '~~a '.repeat(size / 4),
    fences: '```\n'.repeat(size / 4),
    backslash: '\\'.repeat(size),
  };
  // Linear parsing takes tens of milliseconds even on a busy machine;
  // quadratic work on 64 KB takes seconds, so one second tells them apart.
  const LIMIT_MS = 1000;
  const timeOf = (source) => {
    const started = performance.now();
    parseMarkdown(source);
    return performance.now() - started;
  };
  for (const name in cases) {
    const source = cases[name];
    const runs = Array.from({ length: 3 }, () => timeOf(source));
    const elapsed = Math.min(...runs);
    assert.ok(elapsed < LIMIT_MS, `${name} took ${elapsed.toFixed(0)} ms`);
  }
});

const tokensOf = async (code, lang) =>
  (await loadSyntax()).highlight(code, lang);

const typesOf = (tokens) =>
  tokens.filter((token) => token.type !== 'text').map((token) => token.type);

const has = (tokens, type, value) =>
  tokens.some((token) => token.type === type && token.text === value);

const joined = (tokens) => tokens.map((token) => token.text).join('');

test('highlight: unknown or missing language returns null', async () => {
  assert.equal(await tokensOf('x', 'nonsense'), null);
  assert.equal(await tokensOf('x', ''), null);
  assert.equal(await tokensOf('x', undefined), null);
});

test('highlight: every alias is known, case-insensitive', async () => {
  const aliases = `js javascript mjs cjs jsx ts typescript tsx json jsonc html
    xml svg css sh bash shell zsh console py python sql go rs rust c h cpp c++
    hpp java cs csharp php rb ruby yaml yml toml ini diff patch`.split(/\s+/);
  for (const alias of aliases) {
    const tokens = await tokensOf('x', alias);
    assert.ok(Array.isArray(tokens), alias);
    assert.ok(Array.isArray(await tokensOf('x', alias.toUpperCase())), alias);
  }
});

test('highlight: JavaScript and TypeScript', async () => {
  const code =
    'const a = `t${1}`; // c\nfunction f(x) { return /re/g.test("s") + 1; }';
  const tokens = await tokensOf(code, 'js');
  assert.equal(joined(tokens), code);
  assert.ok(has(tokens, 'keyword', 'const'));
  assert.ok(has(tokens, 'string', '`t${1}`'));
  assert.ok(has(tokens, 'comment', '// c'));
  assert.ok(has(tokens, 'function', 'f'));
  assert.ok(has(tokens, 'regexp', '/re/g'));
  assert.ok(has(tokens, 'string', '"s"'));
  assert.ok(has(tokens, 'number', '1'));
  const division = await tokensOf('a / b / c', 'js');
  assert.ok(!typesOf(division).includes('regexp'));
  const ts = await tokensOf(
    'interface A { x: number }\nlet y: Foo = null',
    'ts',
  );
  assert.ok(has(ts, 'keyword', 'interface'));
  assert.ok(has(ts, 'type', 'number'));
  assert.ok(has(ts, 'type', 'Foo'));
  assert.ok(has(ts, 'literal', 'null'));
  const lines = await tokensOf('/* a\nb */ x', 'js');
  assert.ok(has(lines, 'comment', '/* a\nb */'));
});

test('highlight: JSON properties and values', async () => {
  const tokens = await tokensOf(
    '{"a": [1, -2.5e3, true, null], "b": "c"}',
    'json',
  );
  assert.ok(has(tokens, 'property', '"a"'));
  assert.ok(has(tokens, 'property', '"b"'));
  assert.ok(has(tokens, 'string', '"c"'));
  assert.ok(has(tokens, 'number', '2.5e3'));
  assert.ok(has(tokens, 'literal', 'true'));
  assert.ok(has(tokens, 'literal', 'null'));
});

test('highlight: HTML and XML tags, attributes, comments', async () => {
  const code =
    '<!doctype html><a href="/x" data-y=z>t &amp; u</a><!-- c --><br/>';
  const tokens = await tokensOf(code, 'html');
  assert.equal(joined(tokens), code);
  assert.ok(has(tokens, 'meta', '<!doctype html>'));
  assert.ok(has(tokens, 'tag', '<a'));
  assert.ok(has(tokens, 'attr', 'href'));
  assert.ok(has(tokens, 'string', '"/x"'));
  assert.ok(has(tokens, 'attr', 'data-y'));
  assert.ok(has(tokens, 'string', 'z'));
  assert.ok(has(tokens, 'comment', '<!-- c -->'));
  assert.ok(has(tokens, 'literal', '&amp;'));
  const xml = await tokensOf('<?xml version="1.0"?><svg:g/>', 'xml');
  assert.ok(has(xml, 'meta', '<?xml version="1.0"?>'));
});

test('highlight: CSS selectors, properties, values', async () => {
  const code =
    '@media (min-width: 600px) {\n' +
    '  a.b:hover > #c { color: #fff; margin: 0 -1.5em !important; }\n}\n' +
    '/* c */';
  const tokens = await tokensOf(code, 'css');
  assert.equal(joined(tokens), code);
  assert.ok(has(tokens, 'keyword', '@media'));
  assert.ok(has(tokens, 'tag', 'a'));
  assert.ok(has(tokens, 'type', '.b'));
  assert.ok(has(tokens, 'attr', ':hover'));
  assert.ok(has(tokens, 'type', '#c'));
  assert.ok(has(tokens, 'property', 'color'));
  assert.ok(has(tokens, 'number', '#fff'));
  assert.ok(has(tokens, 'number', '-1.5em'));
  assert.ok(has(tokens, 'keyword', '!important'));
  assert.ok(has(tokens, 'comment', '/* c */'));
});

test('highlight: shell, Python, SQL', async () => {
  const sh = await tokensOf(
    '#!/bin/sh\n$ echo "hi $USER" # c\nif [ -f x ]; then ls --all; fi',
    'sh',
  );
  assert.ok(has(sh, 'meta', '#!/bin/sh'));
  assert.ok(has(sh, 'keyword', 'if'));
  assert.ok(has(sh, 'string', '"hi $USER"'));
  assert.ok(has(sh, 'comment', '# c'));
  assert.ok(has(sh, 'attr', '--all'));
  const py = await tokensOf(
    '@dec\ndef f(x):\n    """doc"""\n    return f"a{x}" # c\nprint(None, 0x1F)',
    'py',
  );
  assert.ok(has(py, 'meta', '@dec'));
  assert.ok(has(py, 'keyword', 'def'));
  assert.ok(has(py, 'string', '"""doc"""'));
  assert.ok(has(py, 'string', 'f"a{x}"'));
  assert.ok(has(py, 'literal', 'None'));
  assert.ok(has(py, 'number', '0x1F'));
  const sql = await tokensOf(
    `SELECT id FROM t WHERE a = 'x' -- c\nAND b > 10;`,
    'sql',
  );
  assert.ok(has(sql, 'keyword', 'SELECT'));
  assert.ok(has(sql, 'string', `'x'`));
  assert.ok(has(sql, 'comment', '-- c'));
  assert.ok(has(sql, 'number', '10'));
  const lower = await tokensOf('select * from t', 'sql');
  assert.ok(has(lower, 'keyword', 'select'));
});

test('highlight: Go, Rust, C, C++, Java, C#', async () => {
  const goCode = `package main\nfunc main() { s := \`raw\`; r := 'a' }`;
  const go = await tokensOf(goCode, 'go');
  assert.ok(has(go, 'keyword', 'func'));
  assert.ok(has(go, 'string', '`raw`'));
  assert.ok(has(go, 'string', `'a'`));
  const rust = await tokensOf(
    'fn f<\'a>() { let s = r#"x"#; println!("hi"); }\n#[derive(Debug)]',
    'rs',
  );
  assert.ok(has(rust, 'keyword', 'fn'));
  assert.ok(has(rust, 'type', `'a`));
  assert.ok(has(rust, 'string', 'r#"x"#'));
  assert.ok(has(rust, 'function', 'println'));
  assert.ok(has(rust, 'meta', '#[derive(Debug)]'));
  const c = await tokensOf(
    '#include <stdio.h>\nint main(void) { return 0; }',
    'c',
  );
  assert.ok(has(c, 'meta', '#include <stdio.h>'));
  assert.ok(has(c, 'type', 'int'));
  assert.ok(has(c, 'keyword', 'return'));
  const cpp = await tokensOf(
    'class A { public: virtual void f() override; };',
    'c++',
  );
  assert.ok(has(cpp, 'keyword', 'class'));
  assert.ok(has(cpp, 'keyword', 'virtual'));
  const java = await tokensOf(
    '@Override public class A { String s = "x"; }',
    'java',
  );
  assert.ok(has(java, 'meta', '@Override'));
  assert.ok(has(java, 'keyword', 'public'));
  assert.ok(has(java, 'type', 'String'));
  const cs = await tokensOf('using System; var s = $"x"; // c', 'cs');
  assert.ok(has(cs, 'keyword', 'using'));
  assert.ok(has(cs, 'string', '$"x"'));
  assert.ok(has(cs, 'comment', '// c'));
});

test('highlight: PHP and Ruby', async () => {
  const php = await tokensOf('<?php $a = 1; echo "x"; # c\n?>', 'php');
  assert.ok(has(php, 'meta', '<?php'));
  assert.ok(has(php, 'property', '$a'));
  assert.ok(has(php, 'keyword', 'echo'));
  assert.ok(has(php, 'comment', '# c'));
  const ruby = await tokensOf('def f(x)\n  @a = :sym # c\nend', 'rb');
  assert.ok(has(ruby, 'keyword', 'def'));
  assert.ok(has(ruby, 'property', '@a'));
  assert.ok(has(ruby, 'literal', ':sym'));
  assert.ok(has(ruby, 'comment', '# c'));
});

test('highlight: YAML, TOML, INI', async () => {
  const yaml =
    '# c\nname: test\nlist:\n  - a: 1\n  - b: "x"\n' +
    'text: |\n  keep: raw\nok: true';
  const tokens = await tokensOf(yaml, 'yml');
  assert.equal(joined(tokens), yaml);
  assert.ok(has(tokens, 'comment', '# c'));
  assert.ok(has(tokens, 'property', 'name'));
  assert.ok(has(tokens, 'number', '1'));
  assert.ok(has(tokens, 'string', '"x"'));
  assert.ok(has(tokens, 'literal', 'true'));
  assert.ok(!has(tokens, 'property', 'keep'));
  const toml = '# c\n[server]\nport = 8080\nname="x"\nwhen = 2020-01-01';
  const rows = await tokensOf(toml, 'toml');
  assert.equal(joined(rows), toml);
  assert.ok(has(rows, 'type', '[server]'));
  assert.ok(has(rows, 'property', 'port'));
  assert.ok(has(rows, 'number', '8080'));
  assert.ok(has(rows, 'string', '"x"'));
  assert.ok(has(rows, 'number', '2020-01-01'));
  const ini = '; c\n[s]\nkey = value';
  const pairs = await tokensOf(ini, 'ini');
  assert.equal(joined(pairs), ini);
  assert.ok(has(pairs, 'comment', '; c\n'));
  assert.ok(has(pairs, 'property', 'key'));
});

test('highlight: diff lines', async () => {
  const diff =
    'diff --git a b\n--- a\n+++ b\n@@ -1,2 +1,2 @@\n-old\n+new\n same\n';
  const tokens = await tokensOf(diff, 'patch');
  assert.equal(joined(tokens), diff);
  assert.ok(tokens.some((t) => t.type === 'meta' && t.text.startsWith('diff')));
  assert.ok(has(tokens, 'deleted', '-old\n'));
  assert.ok(has(tokens, 'inserted', '+new\n'));
  assert.ok(has(tokens, 'text', ' same\n'));
});

test('highlight keeps every character for all languages', async () => {
  const code = 'a = "b\n\' ` /* x\n\t<!-- {{ ((( 1e 0x $ @ # \\ é 😀\n';
  const langs = [
    'js',
    'ts',
    'json',
    'html',
    'css',
    'sh',
    'py',
    'sql',
    'go',
    'rs',
    'c',
    'cpp',
    'java',
    'cs',
    'php',
    'rb',
    'yaml',
    'toml',
    'ini',
    'diff',
  ];
  for (const lang of langs) {
    const tokens = await tokensOf(code, lang);
    assert.equal(joined(tokens), code, lang);
  }
});
