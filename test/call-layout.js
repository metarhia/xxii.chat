'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const load = () => import('../application/static/call-layout.js');
const people = [
  { endpoint: 'ada', video: true, screen: false },
  { endpoint: 'bob', video: true, screen: false },
  { endpoint: 'kim', video: false, screen: false },
];
const options = { width: 1200, height: 700, self: 'ada' };
const assertBounds = (result, bounds = options) => {
  for (const tile of result.tiles) {
    assert.ok(tile.x >= 0 && tile.y >= 0);
    assert.ok(tile.width >= 0 && tile.height >= 0);
    assert.ok(tile.x + tile.width <= bounds.width + 0.001);
    assert.ok(tile.y + tile.height <= bounds.height + 0.001);
  }
};

test('Auto selects grid or screen spotlight', async () => {
  const { callLayout } = await load();
  const before = structuredClone(people);
  assert.equal(callLayout(people, options).layout, 'grid');
  const sharing = people.with(1, { ...people[1], screen: true });
  const auto = callLayout(sharing, options);
  assert.equal(auto.layout, 'spotlight');
  assert.equal(auto.tiles[0].id, 'bob/screen');
  assert.equal(auto.tiles.length, 4);
  assert.equal(auto.tiles[0].featured, true);
  assertBounds(auto);
  assert.deepEqual(people, before);
});

test('Grid fits landscape and portrait stages', async () => {
  const { bestGrid, callLayout } = await load();
  assert.equal(bestGrid(4, 1200, 700).columns, 2);
  assert.equal(bestGrid(4, 400, 1000).columns, 1);
  for (const bounds of [options, { width: 350, height: 950 }]) {
    const result = callLayout(people, { ...bounds, layout: 'grid' });
    assertBounds(result, bounds);
    assert.equal(result.tiles.length, 3);
    for (const tile of result.tiles) {
      assert.ok(Math.abs(tile.width / tile.height - 16 / 9) < 0.001);
    }
  }
});

test('Grid caps people at eight and includes extra screen tiles', async () => {
  const { callLayout } = await load();
  const many = Array.from({ length: 10 }, (_, index) => ({
    endpoint: `person${index}`,
    video: true,
    screen: index === 9,
  }));
  const result = callLayout(many, { ...options, layout: 'grid' });
  assert.equal(result.tiles.length, 9);
  assert.equal(result.tiles.at(-1).id, 'person9/screen');
  assertBounds(result);
});

test('Spotlight honors speaker, host hint and local pin', async () => {
  const { callLayout } = await load();
  const config = { ...options, layout: 'spotlight', speaker: 'bob' };
  assert.equal(callLayout(people, config).tiles[0].endpoint, 'bob');
  config.spotlight = 'kim/camera';
  assert.equal(callLayout(people, config).tiles[0].endpoint, 'kim');
  assert.equal(
    callLayout(people, { ...config, layout: 'auto' }).layout,
    'spotlight',
  );
  config.pin = 'ada/camera';
  assert.equal(callLayout(people, config).tiles[0].endpoint, 'ada');
  config.pin = 'gone/camera';
  assert.equal(callLayout(people, config).tiles[0].endpoint, 'kim');
  const sharing = people.with(1, { ...people[1], screen: true });
  config.pin = 'bob/screen';
  assert.equal(callLayout(sharing, config).tiles[0].slot, 'screen');
});

test('strip positions fit; Sidebar uses a right vertical strip', async () => {
  const { callLayout, STRIP_POSITIONS } = await load();
  for (const strip of STRIP_POSITIONS) {
    const result = callLayout(people, {
      ...options,
      layout: 'spotlight',
      strip,
    });
    assertBounds(result);
    const main = result.tiles[0];
    const other = result.tiles[1];
    if (strip === 'left') assert.ok(other.x < main.x);
    if (strip === 'right') assert.ok(other.x > main.x);
    if (strip === 'top') assert.ok(other.y < main.y);
    if (strip === 'bottom') assert.ok(other.y > main.y);
    const sidebar = callLayout(people, {
      ...options,
      layout: 'sidebar',
      strip,
    });
    assertBounds(sidebar);
    assert.ok(sidebar.tiles[1].x > sidebar.tiles[0].x);
    assert.equal(sidebar.tiles[1].x, sidebar.tiles[2].x);
    assert.ok(sidebar.tiles[2].y > sidebar.tiles[1].y);
  }
});

test('hide self and no-video options preserve shared screens', async () => {
  const { callLayout } = await load();
  const sharing = people.with(0, { ...people[0], screen: true });
  const result = callLayout(sharing, {
    ...options,
    hideSelf: true,
    hideNoVideo: true,
  });
  assert.deepEqual(
    result.tiles.map((tile) => tile.id),
    ['ada/screen', 'bob/camera'],
  );
});

test('empty and tiny stages have bounded geometry', async () => {
  const { callLayout } = await load();
  assert.deepEqual(callLayout([], options).tiles, []);
  for (const layout of ['auto', 'grid', 'spotlight', 'sidebar']) {
    for (const width of [0, 1, 10]) {
      const bounds = { width, height: width };
      assertBounds(callLayout(people, { ...bounds, layout }), bounds);
      const single = callLayout(people.slice(0, 1), { ...bounds, layout });
      assertBounds(single, bounds);
    }
  }
});
