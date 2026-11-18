'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const load = () => import('../application/static/call-hands.js');
const people = [
  { endpoint: 'ada', hand: 0 },
  { endpoint: 'bob', hand: 300 },
  { endpoint: 'kim', hand: 100 },
  { endpoint: 'sam', hand: 200 },
];

test('hands are numbered by raise time', async () => {
  const hands = await load();
  const order = hands.orderOf(people);
  assert.equal(order.get('kim'), 1);
  assert.equal(order.get('sam'), 2);
  assert.equal(order.get('bob'), 3);
  assert.equal(order.has('ada'), false);
});

test('the roster lists raised hands first, then the rest', async () => {
  const hands = await load();
  const names = hands.rosterOf(people).map((person) => person.endpoint);
  assert.deepEqual(names, ['kim', 'sam', 'bob', 'ada']);
});

test('equal raise times fall back to the endpoint', async () => {
  const hands = await load();
  const same = [
    { endpoint: 'b', hand: 5 },
    { endpoint: 'a', hand: 5 },
  ];
  assert.equal(hands.orderOf(same).get('a'), 1);
});

test('only the reaction set is accepted', async () => {
  const hands = await load();
  for (const emoji of hands.REACTIONS) {
    assert.equal(hands.isReaction(emoji), true);
  }
  assert.equal(hands.isReaction('💩'), false);
  assert.equal(hands.isReaction(undefined), false);
  assert.equal(hands.isReaction({ emoji: '👍' }), false);
});

test('at most 3 reactions per second', async () => {
  const hands = await load();
  const limiter = hands.createLimiter();
  assert.equal(hands.takeReaction(limiter, 0), true);
  assert.equal(hands.takeReaction(limiter, 100), true);
  assert.equal(hands.takeReaction(limiter, 200), true);
  assert.equal(hands.takeReaction(limiter, 300), false);
  assert.equal(hands.takeReaction(limiter, 999), false);
  assert.equal(hands.takeReaction(limiter, 1000), true);
  assert.equal(hands.takeReaction(limiter, 1050), false);
  assert.equal(hands.takeReaction(limiter, 1100), true);
});

test('auto-lower fires after 3 seconds of speaking', async () => {
  const hands = await load();
  const on = { enabled: true, raised: true, speaking: true };
  let step = hands.stepAutoLower(hands.createAutoLower(), on, 1000);
  assert.equal(step.lower, false);
  step = hands.stepAutoLower(step.state, on, 3900);
  assert.equal(step.lower, false);
  step = hands.stepAutoLower(step.state, on, 4000);
  assert.equal(step.lower, true);
  step = hands.stepAutoLower(step.state, on, 4100);
  assert.equal(step.lower, false);
});

test('auto-lower needs speech, a raised hand, and the setting', async () => {
  const hands = await load();
  const on = { enabled: true, raised: true, speaking: true };
  let step = hands.stepAutoLower(hands.createAutoLower(), on, 0);
  step = hands.stepAutoLower(step.state, { ...on, speaking: false }, 2000);
  step = hands.stepAutoLower(step.state, on, 2100);
  step = hands.stepAutoLower(step.state, on, 4000);
  assert.equal(step.lower, false);
  const off = { ...on, enabled: false };
  step = hands.stepAutoLower(hands.createAutoLower(), off, 0);
  step = hands.stepAutoLower(step.state, off, 9000);
  assert.equal(step.lower, false);
  const down = { ...on, raised: false };
  step = hands.stepAutoLower(hands.createAutoLower(), down, 0);
  step = hands.stepAutoLower(step.state, down, 9000);
  assert.equal(step.lower, false);
});
