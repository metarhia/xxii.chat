'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

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

const row = (id, root, nick = 'x') => ({ id, root, nick });

const kinds = (lanes) => lanes.map((cells) => cells.map((cell) => cell.kind));

test('rootOf ends at a missing parent and stops cycles', async () => {
  const { rootOf } = await load();
  const list = [message('a', ''), message('b', 'a'), message('c', 'b')];
  assert.equal(rootOf(records(list), 'c'), 'a');
  assert.equal(rootOf(records(list), 'a'), 'a');
  const orphan = [message('d', 'gone'), message('e', 'd')];
  assert.equal(rootOf(records(orphan), 'e'), 'gone');
  const loop = [message('x', 'y'), message('y', 'x')];
  assert.equal(rootOf(records(loop), 'x'), 'x');
  assert.equal(rootOf(records(loop), 'y'), 'x');
});

test('conversationOf and branchOf walk a deep tree', async () => {
  const { conversationOf, branchOf } = await load();
  const list = [
    message('r', '', 1),
    message('a', 'r', 2),
    message('b', 'a', 3),
    message('c', 'b', 4),
    message('d', 'r', 5),
    message('e', 'a', 6),
    message('z', '', 7),
  ];
  const replies = repliesOf(list);
  const all = conversationOf(replies, 'r').map((item) => item.id);
  assert.deepEqual(all, ['a', 'b', 'c', 'd', 'e']);
  assert.deepEqual(conversationOf(replies, 'z'), []);
  const branch = branchOf(records(list), replies, 'a');
  assert.deepEqual(branch, ['r', 'a', 'b', 'c', 'e']);
  assert.deepEqual(branchOf(records(list), replies, 'r'), [
    'r',
    'a',
    'b',
    'c',
    'd',
    'e',
  ]);
});

test('lanesOf draws root, node, pass, and last cells', async () => {
  const { lanesOf } = await load();
  const rows = [row('r', 'r'), row('p', 'p'), row('a', 'r'), row('b', 'r')];
  const lanes = lanesOf(rows, 4);
  assert.deepEqual(kinds(lanes), [['root'], ['pass'], ['node'], ['last']]);
  assert.equal(lanes[2][0].title, '2 replies · x');
});

test('lanesOf crosses two conversations in two lanes', async () => {
  const { lanesOf } = await load();
  const rows = [
    row('r1', 'r1'),
    row('r2', 'r2'),
    row('a', 'r1'),
    row('b', 'r2'),
    row('c', 'r1'),
  ];
  const lanes = lanesOf(rows, 4);
  assert.deepEqual(kinds(lanes), [
    ['root', ''],
    ['pass', 'root'],
    ['node', 'pass'],
    ['pass', 'last'],
    ['last', ''],
  ]);
});

test('lanesOf shares an overflow lane beyond max', async () => {
  const { lanesOf } = await load();
  const rows = [
    row('r1', 'r1'),
    row('a1', 'r1'),
    row('r2', 'r2'),
    row('a2', 'r2'),
    row('r3', 'r3'),
    row('a3', 'r3'),
  ];
  const lanes = lanesOf(rows, 2);
  assert.equal(lanes[0].length, 3);
  assert.deepEqual(kinds(lanes)[0], ['', '', 'overflow']);
  const latest = lanes[5].map((cell) => cell.kind);
  assert.deepEqual(latest, ['', 'last', '']);
  assert.equal(lanes[0][2].root, '');
  assert.equal(lanes[1][2].title, '1 reply · x');
  const few = lanesOf(rows, 4);
  assert.equal(few[0].length, 3);
  assert.equal(
    few[0].some((cell) => cell.kind === 'overflow'),
    false,
  );
});

test('lanesOf keeps lanes while the window of rows moves', async () => {
  const { lanesOf } = await load();
  const rows = [
    row('r1', 'r1'),
    row('r2', 'r2'),
    row('a1', 'r1'),
    row('a2', 'r2'),
    row('b1', 'r1'),
    row('b2', 'r2'),
  ];
  const slots = new Map();
  const full = lanesOf(rows, 4, slots);
  const moved = lanesOf(rows.slice(1), 4, slots);
  for (let i = 1; i < moved.length; i++) {
    assert.equal(moved[i][0].root || '', full[i + 1][0].root || '');
    assert.equal(moved[i][1].root || '', full[i + 1][1].root || '');
  }
  const heads = lanesOf(rows.slice(2), 4, slots);
  assert.deepEqual(kinds(heads)[0], ['node', '']);
  assert.equal(heads[0][0].cut, true);
  assert.equal(heads[1][1].root, 'r2');
  assert.equal(heads[0][0].color, full[0][0].color);
});

test('lanesOf drops slots beyond a smaller max', async () => {
  const { lanesOf } = await load();
  const rows = [
    row('r1', 'r1'),
    row('r2', 'r2'),
    row('a1', 'r1'),
    row('a2', 'r2'),
  ];
  const slots = new Map();
  assert.equal(lanesOf(rows, 4, slots)[0].length, 2);
  const narrow = lanesOf(rows.concat(row('r3', 'r3')), 1, slots);
  assert.equal(narrow[0].length, 2);
  assert.equal(slots.size, 1);
  assert.equal(slots.get('r2'), 0);
});

test('lanesOf draws nothing without replies', async () => {
  const { lanesOf } = await load();
  const lanes = lanesOf([row('a', 'a'), row('b', 'b')], 4);
  assert.deepEqual(lanes, [[], []]);
});

test('colorOf is stable and within the palette', async () => {
  const { colorOf } = await load();
  const color = colorOf('0b4c5fc0-1111-4222-8333-444455556666');
  assert.equal(color, colorOf('0b4c5fc0-1111-4222-8333-444455556666'));
  assert.ok(Number.isInteger(color) && color >= 0 && color < 8);
  const seen = new Set();
  for (let i = 0; i < 40; i++) seen.add(colorOf(`root-${i}`));
  assert.ok(seen.size > 4);
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
