'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');

const load = () => import('../application/static/replies.js');

const records = (list) => new Map(list.map((record) => [record.id, record]));

const message = (id, replyTo, timestamp) => ({
  id,
  replyTo,
  timestamp,
  nick: `n${id}`,
});

const repliesOf = (list) => {
  const replies = new Map();
  for (const record of list) {
    if (!record.replyTo) continue;
    const siblings = replies.get(record.replyTo) ?? [];
    siblings.push(record);
    replies.set(record.replyTo, siblings);
  }
  return replies;
};

const luminance = (hex) => {
  const channel = (index) => {
    const srgb = parseInt(hex.slice(index, index + 2), 16) / 255;
    if (srgb <= 0.04045) return srgb / 12.92;
    return ((srgb + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(1) + 0.7152 * channel(3) + 0.0722 * channel(5);
};

test('rootOf stops at top, a missing parent, or a cycle', async () => {
  const { rootOf } = await load();
  const list = [message('a', ''), message('b', 'a'), message('c', 'b')];
  assert.equal(rootOf(records(list), 'c'), 'a');
  assert.equal(rootOf(records(list), 'a'), 'a');
  assert.equal(rootOf(records(list), 'c', 'a'), 'b');
  assert.equal(rootOf(records(list), 'c', 'b'), 'c');
  const orphan = [message('d', 'gone'), message('e', 'd')];
  assert.equal(rootOf(records(orphan), 'e'), 'gone');
  const loop = [message('x', 'y'), message('y', 'x')];
  assert.equal(rootOf(records(loop), 'x'), 'x');
  assert.equal(rootOf(records(loop), 'y'), 'x');
});

test('threadOf walks a deep tree', async () => {
  const { threadOf } = await load();
  const list = [
    message('r', '', 1),
    message('a', 'r', 2),
    message('b', 'a', 3),
    message('d', 'r', 5),
    message('c', 'b', 4),
    message('e', 'a', 6),
    message('z', '', 7),
  ];
  const replies = repliesOf(list);
  const all = threadOf(replies, 'r').map((item) => item.id);
  assert.deepEqual(all, ['a', 'b', 'c', 'd', 'e']);
  assert.deepEqual(threadOf(replies, 'z'), []);
});

test('threadRootOf handles messages and article comments', async () => {
  const { threadRootOf } = await load();
  const list = [
    message('r', ''),
    message('a', 'r'),
    message('b', 'a'),
    message('c', 'b'),
    message('plain', ''),
    message('orphan', 'missing'),
    message('post', ''),
    message('comment', 'post'),
    message('nested', 'comment'),
    message('single', 'post'),
  ];
  const view = { records: records(list), replies: repliesOf(list) };
  assert.equal(threadRootOf(view, 'r'), 'r');
  assert.equal(threadRootOf(view, 'c'), 'r');
  assert.equal(threadRootOf(view, 'plain'), '');
  assert.equal(threadRootOf(view, 'orphan'), 'missing');
  assert.equal(threadRootOf(view, 'post', 'post'), '');
  assert.equal(threadRootOf(view, 'comment', 'post'), 'comment');
  assert.equal(threadRootOf(view, 'nested', 'post'), 'comment');
  assert.equal(threadRootOf(view, 'single', 'post'), '');
});

test('colorOf is stable and within the palette', async () => {
  const { colorOf } = await load();
  const root = '0b4c5fc0-1111-4222-8333-444455556666';
  const color = colorOf(root);
  assert.equal(color, colorOf(root));
  const seen = new Set();
  for (let i = 0; i < 400; i++) {
    const index = colorOf(`root-${i}`);
    assert.ok(Number.isInteger(index) && index >= 0 && index < 32);
    seen.add(index);
  }
  assert.equal(seen.size, 32);
});

test('both thread palettes have 32 colors with readable contrast', async () => {
  const file = path.join(__dirname, '../application/static/default.css');
  const css = await fs.readFile(file, 'utf8');
  assert.doesNotMatch(css, /--lane-/);
  const dark = css.match(/^:root \{([^}]+)}/m)[1];
  const light = css.match(/^:root\[data-theme='light'\] \{([^}]+)}/m)[1];
  const background = dark.match(/--bg: (#[0-9a-f]{6});/)[1];
  const check = (theme, backdrop) => {
    const token = /--thread-(\d+): (#[0-9a-f]{6});/g;
    const colors = Array.from(theme.matchAll(token));
    assert.equal(colors.length, 32);
    assert.equal(new Set(colors.map((match) => match[2])).size, 32);
    const back = luminance(backdrop);
    for (let i = 0; i < colors.length; i++) {
      const match = colors[i];
      assert.equal(Number(match[1]), i);
      const color = luminance(match[2]);
      const high = Math.max(color, back) + 0.05;
      const low = Math.min(color, back) + 0.05;
      assert.ok(high / low >= 4.5, match[2]);
    }
  };
  check(dark, background);
  check(light, '#ffffff');
});

test('repliesToMe counts unread replies to my messages', async () => {
  const { repliesToMe } = await load();
  const make = (id, author, replyTo, timestamp, chat = 'c') => [
    id,
    { author, replyTo, timestamp, chat },
  ];
  const list = new Map([
    make('m1', 'me', undefined, 10),
    make('o1', 'you', undefined, 11),
    make('r3', 'you', 'm1', 30),
    make('r1', 'you', 'm1', 20),
    make('old', 'you', 'm1', 5),
    make('own', 'me', 'm1', 25),
    make('toOther', 'me', 'o1', 26),
    make('toMine', 'you', 'toOther', 27),
    make('other', 'you', 'o1', 28),
    make('x', 'you', 'm1', 40, 'd'),
    make('stray', 'you', 'missing', 50),
  ]);
  const read = new Map([['c', 5]]);
  const mine = repliesToMe(list, 'me', (chat) => read.get(chat) ?? 100);
  assert.deepEqual(mine.get('c'), ['r1', 'toMine', 'r3']);
  assert.equal(mine.has('d'), false);
  const later = repliesToMe(list, 'me', () => 20);
  assert.deepEqual(later.get('c'), ['toMine', 'r3']);
  assert.deepEqual(later.get('d'), ['x']);
});
