'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const load = () => import('../application/static/layout.js');

const BASE = 1763300000000;
const NAMES = ['ada', 'bob', 'kim', 'sam', 'lea', 'max', 'zoe', 'ivy'];
const TILE_KEYS = [
  'fit',
  'height',
  'id',
  'label',
  'placeholder',
  'radius',
  'speaking',
  'width',
  'x',
  'y',
  'z',
];

const person = (name, extra) => ({
  id: `${name}:1/camera`,
  endpoint: `${name}:1`,
  kind: 'camera',
  nick: name,
  hasVideo: true,
  level: 0,
  spokeAt: 0,
  speakingSince: 0,
  optOut: false,
  stage: true,
  width: 1280,
  height: 720,
  ...extra,
});

const share = (name, extra) =>
  person(name, {
    id: `${name}:1/screen`,
    kind: 'screen',
    width: 1920,
    height: 1080,
    ...extra,
  });

const crowd = (count) =>
  Array.from({ length: count }, (_, index) => person(`p${index}`));

const team = (count) => NAMES.slice(0, count).map((name) => person(name));

const idOf = (name) => `${name}:1/camera`;
const idsOf = (tiles) => tiles.map((tile) => tile.id);
const tileOf = (tiles, id) => tiles.find((tile) => tile.id === id);
const right = (tile) => tile.x + tile.width;
const bottom = (tile) => tile.y + tile.height;

const overlaps = (a, b) =>
  a.x < right(b) && b.x < right(a) && a.y < bottom(b) && b.y < bottom(a);

const assertInside = (tiles, program) => {
  const pad = Math.min(
    program.padding,
    Math.min(program.width, program.height) / 4,
  );
  for (const tile of tiles) {
    for (const key of ['x', 'y', 'width', 'height']) {
      assert.ok(Number.isInteger(tile[key]), `${tile.id} ${key}`);
    }
    assert.ok(tile.width > 0 && tile.height > 0, `${tile.id} size`);
    assert.ok(tile.x >= pad && tile.y >= pad, `${tile.id} origin`);
    assert.ok(right(tile) <= program.width - pad, `${tile.id} right`);
    assert.ok(bottom(tile) <= program.height - pad, `${tile.id} bottom`);
    assert.ok(tile.radius >= 0 && tile.radius <= tile.width / 2);
    assert.ok(tile.radius <= tile.height / 2);
  }
};

const assertSeparate = (tiles) => {
  for (let i = 0; i < tiles.length; i++) {
    for (let j = i + 1; j < tiles.length; j++) {
      if (tiles[i].z !== tiles[j].z) continue;
      assert.ok(!overlaps(tiles[i], tiles[j]), `${tiles[i].id} ${tiles[j].id}`);
    }
  }
};

const assertDrawOrder = (tiles) => {
  for (let i = 1; i < tiles.length; i++) {
    assert.ok(tiles[i - 1].z <= tiles[i].z);
  }
};

const assertSound = (tiles, options, lib) => {
  const program = lib.programOf(options);
  assertInside(tiles, program);
  assertSeparate(tiles);
  assertDrawOrder(tiles);
  assert.equal(new Set(idsOf(tiles)).size, tiles.length);
};

const assertAspect = (tile, tolerance = 0.04) => {
  const aspect = tile.width / tile.height;
  assert.ok(Math.abs(aspect - 16 / 9) < tolerance, `${tile.id} ${aspect}`);
};

test('program options default to the Record panel values', async () => {
  const { programOf } = await load();
  const expected = {
    width: 1920,
    height: 1080,
    padding: 32,
    gap: 16,
    radius: 12,
    people: 'speakers',
    maxSpeakers: 4,
    screen: 'screenSpeakers',
    placement: 'strip',
    others: 'hidden',
    othersPosition: 'bottom',
    names: true,
    noVideo: 'avatar',
    pinned: [],
  };
  assert.deepEqual(programOf(), expected);
  assert.deepEqual(programOf(null), expected);
  assert.deepEqual(programOf({}), expected);
});

test('quality sets the frame and scales padding, gap, and radius', async () => {
  const { programOf, QUALITIES } = await load();
  assert.deepEqual(Object.keys(QUALITIES), ['720p30', '1080p30', '1080p60']);
  const expected = {
    '720p30': [1280, 720, 30, 3000000],
    '1080p30': [1920, 1080, 30, 6000000],
    '1080p60': [1920, 1080, 60, 9000000],
  };
  for (const name in expected) {
    const quality = QUALITIES[name];
    const want = expected[name];
    assert.deepEqual(
      [quality.width, quality.height, quality.fps, quality.bitsPerSecond],
      want,
    );
    const program = programOf({ quality: name });
    assert.equal(program.width, want[0]);
    assert.equal(program.height, want[1]);
  }
  const small = programOf({ quality: '720p30' });
  assert.deepEqual([small.padding, small.gap, small.radius], [21, 11, 8]);
  assert.equal(programOf({ quality: '4k' }).width, 1920);
  assert.equal(programOf({ quality: '__proto__' }).height, 1080);
});

test('explicit sizes and lengths win, bad numbers fall back', async () => {
  const { programOf } = await load();
  const custom = programOf({
    quality: '720p30',
    width: 1279.9,
    height: 719,
    padding: 5,
    gap: 0,
    radius: 3.5,
  });
  assert.equal(custom.width, 1279);
  assert.equal(custom.height, 719);
  assert.deepEqual([custom.padding, custom.gap, custom.radius], [5, 0, 3.5]);
  const bad = programOf({ width: NaN, padding: -4, gap: 'x', radius: null });
  assert.equal(bad.width, 1920);
  assert.equal(bad.padding, 0);
  assert.equal(bad.gap, 16);
  assert.equal(bad.radius, 12);
  assert.equal(programOf({ width: 0, height: 0 }).width, 0);
});

test('maxSpeakers is a whole number from 1 to 6', async () => {
  const { programOf, MIN_SPEAKERS, MAX_SPEAKERS } = await load();
  assert.equal(MIN_SPEAKERS, 1);
  assert.equal(MAX_SPEAKERS, 6);
  const cases = [
    [0, 1],
    [1, 1],
    [2.6, 3],
    [6, 6],
    [7, 6],
    [-3, 1],
    [NaN, 4],
    ['4', 4],
    [undefined, 4],
  ];
  for (const pair of cases) {
    assert.equal(programOf({ maxSpeakers: pair[0] }).maxSpeakers, pair[1]);
  }
});

test('every option accepts its listed values and refuses others', async () => {
  const lib = await load();
  const fields = [
    ['people', lib.PEOPLE, 'speakers'],
    ['screen', lib.SCREENS, 'screenSpeakers'],
    ['placement', lib.PLACEMENTS, 'strip'],
    ['others', lib.OTHERS, 'hidden'],
    ['othersPosition', lib.POSITIONS, 'bottom'],
    ['noVideo', lib.NO_VIDEO, 'avatar'],
  ];
  assert.deepEqual(lib.PEOPLE, ['speaker', 'speakers', 'grid', 'pinned']);
  assert.deepEqual(lib.SCREENS.length, 4);
  assert.deepEqual(lib.POSITIONS, ['bottom', 'right', 'left', 'top']);
  for (const field of fields) {
    for (const value of field[1]) {
      const program = lib.programOf({ [field[0]]: value });
      assert.equal(program[field[0]], value);
    }
    const program = lib.programOf({ [field[0]]: 'nonsense' });
    assert.equal(program[field[0]], field[2]);
  }
  assert.equal(lib.programOf({ names: false }).names, false);
  assert.equal(lib.programOf({ names: 'no' }).names, true);
  assert.deepEqual(lib.programOf({ pinned: ['a'] }).pinned, ['a']);
  assert.deepEqual(lib.programOf({ pinned: 'a' }).pinned, []);
});

test('gridShape picks the columns with the largest 16:9 tile', async () => {
  const { gridShape } = await load();
  const wide = { x: 0, y: 0, width: 1200, height: 700 };
  const tall = { x: 0, y: 0, width: 400, height: 1000 };
  assert.deepEqual(gridShape(0, wide, 16 / 9, 8), {
    columns: 0,
    rows: 0,
    width: 0,
    height: 0,
  });
  assert.equal(gridShape(1, wide, 16 / 9, 8).columns, 1);
  assert.equal(gridShape(4, wide, 16 / 9, 8).columns, 2);
  assert.equal(gridShape(4, tall, 16 / 9, 8).columns, 1);
  assert.equal(
    gridShape(3, { x: 0, y: 0, width: 0, height: 0 }, 2, 8).width,
    0,
  );
});

test('gridRects fits 0, 1, 2, 5 tiles and centers the last row', async () => {
  const { gridRects } = await load();
  const area = { x: 10, y: 20, width: 1000, height: 300 };
  const aspect = 16 / 9;
  assert.deepEqual(gridRects(0, area, aspect, 16), []);
  for (const count of [1, 2, 5]) {
    const rects = gridRects(count, area, aspect, 16);
    assert.equal(rects.length, count);
    for (const rect of rects) {
      assert.ok(rect.x >= area.x - 1e-9 && rect.y >= area.y - 1e-9);
      assert.ok(rect.x + rect.width <= area.x + area.width + 1e-9);
      assert.ok(rect.y + rect.height <= area.y + area.height + 1e-9);
      assert.ok(Math.abs(rect.width / rect.height - aspect) < 1e-9);
    }
    for (let i = 0; i < count; i++) {
      for (let j = i + 1; j < count; j++) {
        assert.ok(!overlaps(rects[i], rects[j]));
      }
    }
  }
  const one = gridRects(1, area, aspect, 16)[0];
  assert.ok(Math.abs(one.x + one.width / 2 - 510) < 1e-9);
  assert.ok(Math.abs(one.y + one.height / 2 - 170) < 1e-9);
  const five = gridRects(5, area, aspect, 16);
  assert.equal(five[0].y, five[2].y);
  assert.ok(five[3].y > five[0].y);
  assert.equal(five[3].y, five[4].y);
  const middle = (five[3].x + right(five[4])) / 2;
  assert.ok(Math.abs(middle - 510) < 1e-9);
  assert.ok(Math.abs(five[3].x - five[0].x - five[0].width / 2 - 8) < 1e-9);
});

test('gridRects keeps tiles non-negative in degenerate areas', async () => {
  const { gridRects } = await load();
  for (const size of [0, 1, 5]) {
    const area = { x: 0, y: 0, width: size, height: size };
    for (const rect of gridRects(7, area, 16 / 9, 16)) {
      assert.ok(rect.x >= 0 && rect.y >= 0);
      assert.ok(rect.width >= 0 && rect.height >= 0);
    }
  }
});

test('drawArgsOf crops for cover and letterboxes for contain', async () => {
  const { drawArgsOf } = await load();
  const tile = { x: 10, y: 20, width: 500, height: 500 };
  assert.deepEqual(
    drawArgsOf(1280, 720, tile, 'cover'),
    [280, 0, 720, 720, 10, 20, 500, 500],
  );
  assert.deepEqual(
    drawArgsOf(1280, 720, tile, 'contain'),
    [0, 0, 1280, 720, 10, 129.375, 500, 281.25],
  );
  const same = { x: 0, y: 0, width: 640, height: 360 };
  assert.deepEqual(
    drawArgsOf(1280, 720, same, 'cover'),
    [0, 0, 1280, 720, 0, 0, 640, 360],
  );
  assert.deepEqual(
    drawArgsOf(1280, 720, same, 'contain'),
    [0, 0, 1280, 720, 0, 0, 640, 360],
  );
  const portrait = drawArgsOf(720, 1280, same, 'cover');
  assert.equal(portrait[0], 0);
  assert.equal(portrait[3], 405);
  assert.equal(portrait[1], 437.5);
});

test('a tile has the documented shape and values', async () => {
  const { layoutProgram } = await load();
  const talking = person('ada', { level: 0.2, spokeAt: BASE - 100 });
  const tiles = layoutProgram({}, [talking], BASE);
  assert.equal(tiles.length, 1);
  assert.deepEqual(Object.keys(tiles[0]).sort(), TILE_KEYS);
  assert.deepEqual(tiles[0], {
    id: 'ada:1/camera',
    x: 57,
    y: 32,
    width: 1806,
    height: 1016,
    fit: 'cover',
    radius: 12,
    z: 1,
    label: 'ada',
    speaking: true,
    placeholder: '',
  });
});

test('the documented program and source are accepted as they are', async () => {
  const { layoutProgram } = await load();
  const program = {
    width: 1920,
    height: 1080,
    padding: 32,
    gap: 16,
    radius: 12,
    people: 'speakers',
    maxSpeakers: 4,
    screen: 'screenSpeakers',
    placement: 'strip',
    others: 'strip',
    othersPosition: 'bottom',
    names: true,
    noVideo: 'avatar',
    pinned: [],
  };
  const sources = [
    {
      id: 'peerA:dev1/camera',
      endpoint: 'peerA:dev1',
      kind: 'camera',
      nick: 'alex',
      hasVideo: true,
      level: 0.2,
      spokeAt: 1763300000000,
      optOut: false,
      stage: true,
      width: 1280,
      height: 720,
    },
  ];
  const tiles = layoutProgram(program, sources, 1763300000100);
  assert.equal(tiles.length, 1);
  assert.equal(tiles[0].label, 'alex');
  assert.equal(tiles[0].speaking, true);
  assertSound(tiles, program, await load());
});

test('speakers shows up to the maximum, in join order when quiet', async () => {
  const lib = await load();
  const everyone = team(8);
  for (let max = 1; max <= 6; max++) {
    const options = { people: 'speakers', maxSpeakers: max };
    const tiles = lib.layoutProgram(options, everyone, BASE);
    assert.deepEqual(idsOf(tiles), NAMES.slice(0, max).map(idOf));
    assertSound(tiles, options, lib);
    for (const tile of tiles) assertAspect(tile);
  }
  const few = lib.layoutProgram({ maxSpeakers: 6 }, team(3), BASE);
  assert.equal(few.length, 3);
});

test('speaker shows one person, the active one', async () => {
  const lib = await load();
  const everyone = team(4).map((source) => {
    if (source.nick !== 'kim') return source;
    return {
      ...source,
      level: 0.4,
      spokeAt: BASE - 50,
      speakingSince: BASE - 3000,
    };
  });
  const options = { people: 'speaker', maxSpeakers: 6 };
  const quiet = lib.layoutProgram(options, team(4), BASE);
  assert.deepEqual(idsOf(quiet), [idOf('ada')]);
  const held = [idOf('ada')];
  const heard = everyone.map((source) =>
    source.nick === 'ada' ? { ...source, spokeAt: BASE - 3000 } : source,
  );
  const picked = lib.selectSpeakers(heard, options, BASE, held);
  assert.deepEqual(picked, [idOf('ada')]);
  const stale = everyone.map((source) =>
    source.nick === 'ada' ? { ...source, spokeAt: BASE - 9000 } : source,
  );
  const next = lib.selectSpeakers(stale, options, BASE, held);
  assert.deepEqual(next, [idOf('kim')]);
  const tiles = lib.layoutProgram(options, stale, BASE, next);
  assert.deepEqual(idsOf(tiles), [idOf('kim')]);
  assert.equal(tiles[0].speaking, true);
  assertSound(tiles, options, lib);
});

test('grid shows everyone with a picture or avatar, up to 16', async () => {
  const lib = await load();
  const options = { people: 'grid', maxSpeakers: 2 };
  const tiles = lib.layoutProgram(options, team(7), BASE);
  assert.deepEqual(idsOf(tiles), NAMES.slice(0, 7).map(idOf));
  assertSound(tiles, options, lib);
  for (const tile of tiles) assertAspect(tile);
  assert.equal(lib.MAX_GRID, 16);
  const many = lib.layoutProgram(options, crowd(30), BASE);
  assert.equal(many.length, 16);
  assertSound(many, options, lib);
  const columns = new Set(many.map((tile) => tile.x)).size;
  assert.equal(columns, 4);
});

test('pinned shows only the chosen people in the pinned order', async () => {
  const lib = await load();
  const options = { people: 'pinned', pinned: [idOf('kim'), 'ada:1'] };
  const tiles = lib.layoutProgram(options, team(5), BASE);
  assert.deepEqual(idsOf(tiles), [idOf('kim'), idOf('ada')]);
  assertSound(tiles, options, lib);
  const gone = lib.layoutProgram(
    { ...options, pinned: ['x:1'] },
    team(5),
    BASE,
  );
  assert.deepEqual(idsOf(gone), NAMES.slice(0, 4).map(idOf));
  const none = lib.layoutProgram({ people: 'pinned' }, team(3), BASE);
  assert.equal(none.length, 3);
  const twice = { ...options, pinned: ['ada:1', idOf('ada')] };
  assert.equal(lib.layoutProgram(twice, team(5), BASE).length, 1);
  const hidden = team(3).map((source) =>
    source.nick === 'ada' ? { ...source, hasVideo: false } : source,
  );
  const options2 = { people: 'pinned', pinned: ['ada:1'], noVideo: 'hide' };
  const fallback = lib.layoutProgram(options2, hidden, BASE);
  assert.deepEqual(idsOf(fallback), [idOf('bob'), idOf('kim')]);
});

test('pinned people come first among speakers too', async () => {
  const lib = await load();
  const options = { people: 'speakers', maxSpeakers: 3, pinned: ['zoe:1'] };
  const absent = lib.selectSpeakers(team(6), options, BASE);
  assert.deepEqual(absent, ['ada', 'bob', 'kim'].map(idOf));
  const more = team(7);
  const picked = lib.selectSpeakers(more, options, BASE);
  assert.deepEqual(picked, [idOf('zoe'), idOf('ada'), idOf('bob')]);
  const tiles = lib.layoutProgram(options, more, BASE);
  assert.deepEqual(idsOf(tiles), picked);
});

test('screen off ignores a share and screen needs a real share', async () => {
  const lib = await load();
  const everyone = team(3).concat([share('bob')]);
  const people = lib.layoutProgram({ screen: 'off' }, everyone, BASE);
  assert.deepEqual(
    idsOf(people),
    team(3).map((source) => source.id),
  );
  const without = lib.layoutProgram({ screen: 'screen' }, team(3), BASE);
  assert.deepEqual(
    idsOf(without),
    team(3).map((source) => source.id),
  );
  const ended = share('bob', { hasVideo: false });
  const stopped = team(3).concat([ended]);
  const tiles = lib.layoutProgram({ screen: 'screen' }, stopped, BASE);
  assert.equal(tileOf(tiles, 'bob:1/screen'), undefined);
  assert.equal(tiles.length, 3);
});

test('screen shows only the share, filling the area', async () => {
  const lib = await load();
  const everyone = team(3).concat([share('bob')]);
  const options = { screen: 'screen' };
  const tiles = lib.layoutProgram(options, everyone, BASE);
  assert.deepEqual(idsOf(tiles), ['bob:1/screen']);
  const screen = tiles[0];
  assert.deepEqual(
    [screen.x, screen.y, screen.width, screen.height],
    [32, 32, 1856, 1016],
  );
  assert.equal(screen.fit, 'contain');
  assert.equal(screen.label, 'bob');
  assertSound(tiles, options, lib);
});

test('screenSpeaker adds one speaker and screenSpeakers up to N', async () => {
  const lib = await load();
  const everyone = team(6).concat([share('bob')]);
  const one = lib.layoutProgram({ screen: 'screenSpeaker' }, everyone, BASE);
  assert.deepEqual(idsOf(one), ['bob:1/screen', idOf('ada')]);
  assertSound(one, { screen: 'screenSpeaker' }, lib);
  for (let max = 1; max <= 6; max++) {
    const options = { screen: 'screenSpeakers', maxSpeakers: max };
    const tiles = lib.layoutProgram(options, everyone, BASE);
    assert.equal(tiles.length, 1 + max);
    assert.equal(tiles[0].id, 'bob:1/screen');
    assertSound(tiles, options, lib);
  }
});

test('a strip puts speakers beside the screen, or below it', async () => {
  const lib = await load();
  const everyone = team(3).concat([share('bob')]);
  const wide = lib.layoutProgram({ placement: 'strip' }, everyone, BASE);
  const screen = tileOf(wide, 'bob:1/screen');
  const strip = wide.filter((tile) => tile.id !== screen.id);
  assert.equal(strip.length, 3);
  for (const tile of strip) {
    assert.ok(tile.x >= right(screen) + 16 - 1);
    assertAspect(tile);
  }
  assert.equal(new Set(strip.map((tile) => tile.x)).size, 1);
  const portrait = { width: 1080, height: 1920 };
  const tall = lib.layoutProgram(portrait, everyone, BASE);
  const shot = tileOf(tall, 'bob:1/screen');
  for (const tile of tall.filter((item) => item.id !== shot.id)) {
    assert.ok(tile.y >= bottom(shot) + 16 - 1);
  }
  assertSound(wide, {}, lib);
  assertSound(tall, portrait, lib);
});

test('a bubble floats speakers over the screen corner', async () => {
  const lib = await load();
  const everyone = team(3).concat([share('bob')]);
  const options = { placement: 'bubble', maxSpeakers: 3 };
  const tiles = lib.layoutProgram(options, everyone, BASE);
  const screen = tileOf(tiles, 'bob:1/screen');
  assert.deepEqual(
    [screen.x, screen.y, screen.width, screen.height, screen.z],
    [32, 32, 1856, 1016, 1],
  );
  const bubbles = tiles.filter((tile) => tile.id !== screen.id);
  assert.equal(bubbles.length, 3);
  for (const bubble of bubbles) {
    assert.equal(bubble.z, 2);
    assert.ok(overlaps(bubble, screen));
    assert.ok(bubble.x >= screen.x && right(bubble) <= right(screen));
    assert.ok(bubble.y >= screen.y && bottom(bubble) <= bottom(screen));
    assert.ok(right(bubble) > screen.x + screen.width / 2);
    assert.ok(bubble.y > screen.y + screen.height / 2);
    assertAspect(bubble);
  }
  assert.ok(bubbles[0].x < bubbles[1].x && bubbles[1].x < bubbles[2].x);
  assert.equal(right(bubbles[2]), right(screen) - 16);
  assert.equal(bottom(bubbles[2]), bottom(screen) - 16);
  assert.equal(tiles.indexOf(screen), 0);
  assertSound(tiles, options, lib);
});

test('a share without speakers or people takes the whole area', async () => {
  const lib = await load();
  for (const placement of lib.PLACEMENTS) {
    const options = { placement, others: 'strip' };
    const alone = lib.layoutProgram(options, [share('bob')], BASE);
    assert.equal(alone.length, 1);
    assert.deepEqual(
      [alone[0].x, alone[0].y, alone[0].width, alone[0].height],
      [32, 32, 1856, 1016],
    );
    const named = [share('bob'), person('ada', { hasVideo: false })];
    const hide = { ...options, noVideo: 'hide', screen: 'screenSpeakers' };
    const tiles = lib.layoutProgram(hide, named, BASE);
    assert.equal(tiles.length, 1);
    assert.equal(tiles[0].width, 1856);
  }
});

test('two shares split the main area', async () => {
  const lib = await load();
  const everyone = [share('bob'), share('kim'), share('sam'), person('ada')];
  const options = { screen: 'screen' };
  const tiles = lib.layoutProgram(options, everyone, BASE);
  assert.equal(lib.MAX_SCREENS, 2);
  assert.deepEqual(idsOf(tiles), ['bob:1/screen', 'kim:1/screen']);
  assert.ok(right(tiles[0]) < tiles[1].x);
  assert.equal(tiles[0].y, tiles[1].y);
  assertSound(tiles, options, lib);
  const beside = lib.layoutProgram({}, everyone, BASE);
  assert.equal(beside.length, 3);
  assertSound(beside, {}, lib);
});

test('others strip lists people not on screen on every side', async () => {
  const lib = await load();
  const everyone = team(6);
  const sides = {
    bottom: (main, other) => other.y > bottom(main),
    top: (main, other) => bottom(other) < main.y,
    left: (main, other) => right(other) < main.x,
    right: (main, other) => other.x > right(main),
  };
  assert.deepEqual(Object.keys(sides).sort(), lib.POSITIONS.toSorted());
  for (const position of lib.POSITIONS) {
    const options = {
      people: 'speaker',
      others: 'strip',
      othersPosition: position,
    };
    const tiles = lib.layoutProgram(options, everyone, BASE);
    assert.equal(tiles.length, 6, position);
    const main = tiles.find((tile) => tile.id === idOf('ada'));
    const others = tiles.filter((tile) => tile !== main);
    assert.deepEqual(idsOf(others), NAMES.slice(1, 6).map(idOf));
    for (const other of others) {
      assert.ok(sides[position](main, other), position);
      assert.equal(other.placeholder, '');
      assertAspect(other);
      assert.ok(other.width < main.width / 2);
    }
    assertSound(tiles, options, lib);
  }
});

test('others strip shrinks tiles to fit and stops at 12', async () => {
  const lib = await load();
  assert.equal(lib.MAX_OTHERS, 12);
  for (const position of lib.POSITIONS) {
    const options = {
      people: 'speaker',
      others: 'strip',
      othersPosition: position,
    };
    const tiles = lib.layoutProgram(options, crowd(30), BASE);
    assert.equal(tiles.length, 13, position);
    assertSound(tiles, options, lib);
    const few = lib.layoutProgram(options, crowd(2), BASE);
    assert.ok(few[1].width > tiles[1].width, position);
  }
});

test('others hidden gives the whole frame to the main area', async () => {
  const lib = await load();
  const everyone = team(5);
  const hidden = lib.layoutProgram({ people: 'speaker' }, everyone, BASE);
  const strip = lib.layoutProgram(
    { people: 'speaker', others: 'strip' },
    everyone,
    BASE,
  );
  assert.equal(hidden.length, 1);
  assert.ok(strip[0].height < hidden[0].height);
  assert.equal(hidden[0].height, 1016);
  const all = lib.layoutProgram(
    { people: 'grid', others: 'strip' },
    team(5),
    BASE,
  );
  const plain = lib.layoutProgram({ people: 'grid' }, team(5), BASE);
  assert.deepEqual(all, plain);
});

test('names lists everyone not on screen as name rows', async () => {
  const lib = await load();
  const everyone = team(5).map((source) => {
    if (source.nick === 'kim') return { ...source, hasVideo: false };
    if (source.nick === 'sam') return { ...source, optOut: true };
    return source;
  });
  for (const position of lib.POSITIONS) {
    const options = {
      people: 'speaker',
      others: 'names',
      othersPosition: position,
      noVideo: 'hide',
      names: false,
    };
    const tiles = lib.layoutProgram(options, everyone, BASE);
    const rows = tiles.filter((tile) => tile.id !== idOf('ada'));
    assert.deepEqual(idsOf(rows), NAMES.slice(1, 5).map(idOf), position);
    for (const row of rows) {
      assert.equal(row.placeholder, 'name');
      assert.equal(row.label, row.id.split(':')[0]);
      assert.ok(row.height <= 60);
      assert.ok(row.width > row.height);
    }
    assert.equal(tiles[0].label, '');
    assertSound(tiles, options, lib);
  }
  const crowded = { people: 'speaker', others: 'names' };
  assert.equal(lib.layoutProgram(crowded, crowd(30), BASE).length, 13);
});

test('padding, gap, and radius come from the program', async () => {
  const lib = await load();
  const options = { people: 'grid', padding: 100, gap: 40, radius: 20 };
  const tiles = lib.layoutProgram(options, team(4), BASE);
  assert.equal(tiles.length, 4);
  assertSound(tiles, options, lib);
  for (const tile of tiles) assert.equal(tile.radius, 20);
  const first = tiles[0];
  const second = tiles[1];
  assert.equal(second.x - right(first), 40);
  assert.equal(tiles[2].y - bottom(first), 40);
  const minX = Math.min(...tiles.map((tile) => tile.x));
  assert.ok(minX >= 100);
  const flush = { people: 'speaker', padding: 0, gap: 0 };
  const edge = lib.layoutProgram(flush, team(1), BASE)[0];
  assert.equal(edge.y, 0);
  assert.equal(edge.height, 1080);
  const pair = { width: 2000, height: 500, padding: 0, gap: 0 };
  const wide = lib.layoutProgram(pair, team(2), BASE);
  assert.equal(right(wide[0]), wide[1].x);
  const round = lib.layoutProgram({ radius: 5000 }, team(2), BASE);
  for (const tile of round) assert.equal(tile.radius, tile.height / 2);
  const small = lib.layoutProgram({ quality: '720p30' }, team(2), BASE);
  assert.equal(small[0].radius, 8);
  assertInside(small, lib.programOf({ quality: '720p30' }));
});

test('names controls the chips on tiles', async () => {
  const lib = await load();
  const everyone = [person('ada'), person('bob', { nick: undefined })];
  const shown = lib.layoutProgram({ names: true }, everyone, BASE);
  assert.deepEqual(
    shown.map((tile) => tile.label),
    ['ada', ''],
  );
  const hidden = lib.layoutProgram({ names: false }, everyone, BASE);
  assert.deepEqual(
    hidden.map((tile) => tile.label),
    ['', ''],
  );
  const named = team(1).concat([share('ada')]);
  const screen = lib.layoutProgram({ names: false }, named, BASE);
  assert.ok(screen.every((tile) => tile.label === ''));
});

test('people without video get an avatar or are hidden', async () => {
  const lib = await load();
  const everyone = team(4).map((source) =>
    source.nick === 'bob' ? { ...source, hasVideo: false } : source,
  );
  const avatar = lib.layoutProgram({ noVideo: 'avatar' }, everyone, BASE);
  assert.equal(avatar.length, 4);
  assert.equal(tileOf(avatar, idOf('bob')).placeholder, 'avatar');
  assert.equal(tileOf(avatar, idOf('ada')).placeholder, '');
  const hide = lib.layoutProgram({ noVideo: 'hide' }, everyone, BASE);
  assert.deepEqual(idsOf(hide), ['ada', 'kim', 'sam'].map(idOf));
  const grid = lib.layoutProgram(
    { people: 'grid', noVideo: 'hide' },
    everyone,
    BASE,
  );
  assert.equal(grid.length, 3);
  const strip = { people: 'speaker', others: 'strip', noVideo: 'hide' };
  const side = lib.layoutProgram(strip, everyone, BASE);
  assert.deepEqual(idsOf(side), ['ada', 'kim', 'sam'].map(idOf));
  const bubble = { screen: 'screenSpeakers', noVideo: 'hide', maxSpeakers: 6 };
  const shared = lib.layoutProgram(
    bubble,
    everyone.concat([share('bob')]),
    BASE,
  );
  assert.equal(shared.length, 4);
  assert.equal(tileOf(shared, idOf('bob')), undefined);
  assert.equal(tileOf(shared, 'bob:1/screen').placeholder, '');
});

test('opted-out people show opted out and no activity', async () => {
  const lib = await load();
  const loud = { level: 0.9, spokeAt: BASE, speakingSince: BASE - 5000 };
  const everyone = [
    person('ada', { optOut: true, ...loud }),
    person('bob', { optOut: true, hasVideo: false }),
    person('kim', loud),
  ];
  const tiles = lib.layoutProgram({ maxSpeakers: 3 }, everyone, BASE);
  const ada = tileOf(tiles, idOf('ada'));
  assert.equal(ada.placeholder, 'opted out');
  assert.equal(ada.speaking, false);
  assert.equal(ada.label, 'ada');
  assert.equal(ada.fit, 'cover');
  assert.equal(tileOf(tiles, idOf('bob')).placeholder, 'opted out');
  assert.equal(tileOf(tiles, idOf('kim')).speaking, true);
  assert.equal(tileOf(tiles, idOf('kim')).placeholder, '');
  const options = { screen: 'screenSpeaker' };
  const screens = everyone.concat([share('kim', { optOut: true })]);
  const mixed = lib.layoutProgram(options, screens, BASE);
  const screen = tileOf(mixed, 'kim:1/screen');
  assert.equal(screen.placeholder, 'opted out');
  assert.equal(screen.fit, 'contain');
  assert.equal(mixed[1].id, idOf('kim'));
  const hide = { noVideo: 'hide' };
  const away = lib.layoutProgram(hide, [everyone[1], everyone[2]], BASE);
  assert.deepEqual(idsOf(away), [idOf('kim')]);
});

test('sources off stage and unknown kinds are skipped', async () => {
  const lib = await load();
  const everyone = [
    person('ada'),
    person('bob', { stage: false }),
    person('kim', { stage: undefined }),
    person('sam', { kind: 'clip' }),
    share('lea', { stage: false }),
    share('max'),
  ];
  const tiles = lib.layoutProgram(
    { others: 'names', maxSpeakers: 2 },
    everyone,
    BASE,
  );
  assert.deepEqual(idsOf(tiles), ['max:1/screen', idOf('ada'), idOf('kim')]);
  const grid = lib.layoutProgram(
    { people: 'grid', screen: 'off' },
    everyone,
    BASE,
  );
  assert.deepEqual(idsOf(grid), [idOf('ada'), idOf('kim')]);
  const picked = lib.selectSpeakers(everyone, {}, BASE);
  assert.deepEqual(picked, [idOf('ada'), idOf('kim')]);
});

test('speaking follows the level and a short hold', async () => {
  const lib = await load();
  const speaking = (extra) => {
    const tiles = lib.layoutProgram({}, [person('ada', extra)], BASE);
    return tiles[0].speaking;
  };
  assert.equal(speaking({ level: 0.06 }), true);
  assert.equal(speaking({ level: 0.05 }), false);
  assert.equal(speaking({ level: 0 }), false);
  assert.equal(speaking({ spokeAt: BASE - 799 }), true);
  assert.equal(speaking({ spokeAt: BASE - 800 }), false);
  assert.equal(speaking({ spokeAt: 0 }), false);
  assert.equal(speaking({ level: undefined, spokeAt: undefined }), false);
});

const roster = (spoke) =>
  team(6).map((source) => {
    const ago = spoke[source.nick];
    if (ago === undefined) return source;
    return { ...source, spokeAt: BASE - ago };
  });

test('selection: pinned, then recent speech, then join order', async () => {
  const { selectSpeakers, RECENT_MS } = await load();
  assert.equal(RECENT_MS, 10000);
  const everyone = roster({ bob: 2000, sam: 5000, kim: 11000 });
  const options = { maxSpeakers: 4, pinned: ['lea:1'] };
  const picked = selectSpeakers(everyone, options, BASE);
  assert.deepEqual(picked, ['lea', 'bob', 'sam', 'ada'].map(idOf));
  const same = selectSpeakers(everyone, { maxSpeakers: 4 }, BASE);
  assert.deepEqual(same, ['bob', 'sam', 'ada', 'kim'].map(idOf));
  const edge = roster({ bob: 9999, sam: 10000 });
  const nearly = selectSpeakers(edge, { maxSpeakers: 2 }, BASE);
  assert.deepEqual(nearly, ['bob', 'ada'].map(idOf));
});

test('selection: a pin list longer than the room is cut', async () => {
  const { selectSpeakers } = await load();
  const options = { maxSpeakers: 2, pinned: ['kim:1', 'bob:1', 'sam:1'] };
  const picked = selectSpeakers(team(6), options, BASE);
  assert.deepEqual(picked, ['kim', 'bob'].map(idOf));
});

const talking = (name, since, ago = 0) => ({
  id: idOf(name),
  level: 0.3,
  speakingSince: BASE - since,
  spokeAt: BASE - ago,
});

const withTalk = (sources, talk) =>
  sources.map((source) => {
    if (source.id !== talk.id) return source;
    return { ...source, ...talk };
  });

test('selection: a new speaker enters after 1.5 s of speaking', async () => {
  const { selectSpeakers, ENTER_MS } = await load();
  assert.equal(ENTER_MS, 1500);
  const options = { maxSpeakers: 2 };
  const held = [idOf('ada'), idOf('bob')];
  const quiet = team(4);
  const before = withTalk(quiet, talking('kim', 1499));
  assert.deepEqual(selectSpeakers(before, options, BASE, held), held);
  const after = withTalk(quiet, talking('kim', 1500));
  const picked = selectSpeakers(after, options, BASE, held);
  assert.deepEqual(picked, [idOf('kim'), idOf('bob')]);
});

test('selection: a speaker leaves when replaced and silent 4 s', async () => {
  const { selectSpeakers, LEAVE_MS } = await load();
  assert.equal(LEAVE_MS, 4000);
  const options = { maxSpeakers: 2 };
  const held = [idOf('ada'), idOf('bob')];
  const base = withTalk(team(4), talking('kim', 3000));
  const heard = (adaAgo, bobAgo) => {
    const spoke = { ada: adaAgo, bob: bobAgo };
    return base.map((source) => {
      const ago = spoke[source.nick];
      return ago === undefined ? source : { ...source, spokeAt: BASE - ago };
    });
  };
  const fresh = heard(3999, 3500);
  assert.deepEqual(selectSpeakers(fresh, options, BASE, held), held);
  const one = heard(3999, 4000);
  const left = selectSpeakers(one, options, BASE, held);
  assert.deepEqual(left, [idOf('ada'), idOf('kim')]);
  const both = heard(6000, 4000);
  const oldest = selectSpeakers(both, options, BASE, held);
  assert.deepEqual(oldest, [idOf('kim'), idOf('bob')]);
});

test('selection: nobody leaves while there is room', async () => {
  const { selectSpeakers } = await load();
  const options = { maxSpeakers: 4 };
  const held = [idOf('ada'), idOf('bob'), idOf('kim')];
  const silent = team(3).map((source) => ({
    ...source,
    spokeAt: BASE - 600000,
  }));
  assert.deepEqual(selectSpeakers(silent, options, BASE, held), held);
  const wider = withTalk(team(5), talking('lea', 5000));
  const picked = selectSpeakers(wider, options, BASE, held);
  assert.deepEqual(picked, ['ada', 'bob', 'kim', 'lea'].map(idOf));
});

test('selection: a long speaker takes a free seat first', async () => {
  const { selectSpeakers } = await load();
  const options = { maxSpeakers: 3 };
  const held = [idOf('ada'), idOf('bob')];
  const everyone = withTalk(team(5), talking('lea', 2000));
  const picked = selectSpeakers(everyone, options, BASE, held);
  assert.deepEqual(picked, [idOf('ada'), idOf('bob'), idOf('lea')]);
  const early = withTalk(team(5), talking('lea', 900, 100));
  const recent = selectSpeakers(early, options, BASE, held);
  assert.deepEqual(recent, [idOf('ada'), idOf('bob'), idOf('lea')]);
  const six = withTalk(team(6), talking('lea', 2000));
  const two = withTalk(six, talking('max', 3000));
  const second = selectSpeakers(two, { maxSpeakers: 3 }, BASE, [idOf('ada')]);
  assert.deepEqual(second, [idOf('ada'), idOf('max'), idOf('lea')]);
});

test('selection: seats stay put and replacements take the seat', async () => {
  const { selectSpeakers } = await load();
  const options = { maxSpeakers: 3 };
  const everyone = withTalk(team(5), talking('lea', 2000));
  const held = ['ada', 'bob', 'kim'].map(idOf);
  const picked = selectSpeakers(everyone, options, BASE, held);
  assert.deepEqual(picked, ['lea', 'bob', 'kim'].map(idOf));
  const again = selectSpeakers(everyone, options, BASE, picked);
  assert.deepEqual(again, picked);
  const start = selectSpeakers(team(5), options, BASE);
  assert.deepEqual(selectSpeakers(team(5), options, BASE, start), start);
});

test('selection: held ids that left or repeat are dropped', async () => {
  const { selectSpeakers } = await load();
  const options = { maxSpeakers: 2 };
  const held = ['gone:1/camera', idOf('kim'), idOf('kim'), idOf('bob')];
  const picked = selectSpeakers(team(4), options, BASE, held);
  assert.deepEqual(picked, [idOf('kim'), idOf('bob')]);
  const shrunk = selectSpeakers(team(4), { maxSpeakers: 1 }, BASE, held);
  assert.equal(shrunk.length, 1);
  const spoke = roster({ bob: 1000, kim: 3000 });
  const trimmed = selectSpeakers(spoke, { maxSpeakers: 2 }, BASE, [
    idOf('kim'),
    idOf('ada'),
    idOf('bob'),
  ]);
  assert.deepEqual(trimmed, [idOf('kim'), idOf('bob')]);
});

test('selection: opted-out people get no speech priority', async () => {
  const { selectSpeakers } = await load();
  const options = { maxSpeakers: 2 };
  const everyone = withTalk(team(4), talking('sam', 5000));
  const silenced = everyone.map((source) =>
    source.nick === 'sam' ? { ...source, optOut: true } : source,
  );
  const held = [idOf('ada'), idOf('bob')];
  assert.deepEqual(selectSpeakers(silenced, options, BASE, held), held);
  const open = selectSpeakers(everyone, options, BASE, held);
  assert.deepEqual(open, [idOf('sam'), idOf('bob')]);
  const heard = roster({ kim: 100 }).map((source) =>
    source.nick === 'kim' ? { ...source, optOut: true } : source,
  );
  assert.deepEqual(selectSpeakers(heard, options, BASE), held);
});

test('selection: hidden people without video are never seated', async () => {
  const { selectSpeakers } = await load();
  const everyone = team(4).map((source) =>
    source.nick === 'ada' ? { ...source, hasVideo: false } : source,
  );
  const hide = selectSpeakers(
    everyone,
    { maxSpeakers: 2, noVideo: 'hide' },
    BASE,
  );
  assert.deepEqual(hide, [idOf('bob'), idOf('kim')]);
  const avatar = selectSpeakers(everyone, { maxSpeakers: 2 }, BASE);
  assert.deepEqual(avatar, [idOf('ada'), idOf('bob')]);
});

test('selection counts follow the people and screen modes', async () => {
  const { selectSpeakers } = await load();
  const everyone = team(8);
  const withShare = everyone.concat([share('bob')]);
  const count = (options, sources) =>
    selectSpeakers(sources, { maxSpeakers: 5, ...options }, BASE).length;
  assert.equal(count({ people: 'speaker' }, everyone), 1);
  assert.equal(count({ people: 'speakers' }, everyone), 5);
  assert.equal(count({ people: 'grid' }, everyone), 0);
  const pinned = { people: 'pinned', pinned: ['ada:1'] };
  assert.equal(count(pinned, everyone), 0);
  assert.equal(count({ people: 'pinned' }, everyone), 5);
  assert.equal(count({ screen: 'off' }, withShare), 5);
  assert.equal(count({ screen: 'screen' }, withShare), 0);
  assert.equal(count({ screen: 'screenSpeaker' }, withShare), 1);
  assert.equal(count({ screen: 'screenSpeakers' }, withShare), 5);
  assert.equal(count({ screen: 'screenSpeakers' }, everyone), 5);
  assert.equal(count({ screen: 'screen' }, everyone), 5);
  assert.equal(count({ people: 'speakers' }, []), 0);
});

test('layoutProgram uses the chosen speakers', async () => {
  const { layoutProgram, selectSpeakers } = await load();
  const everyone = withTalk(team(6), talking('zoe', 0));
  const options = { maxSpeakers: 2, others: 'strip' };
  const chosen = [idOf('sam'), idOf('kim')];
  const tiles = layoutProgram(options, everyone, BASE, chosen);
  assert.deepEqual(idsOf(tiles).slice(0, 2), chosen);
  assert.equal(tiles.length, 6);
  const own = layoutProgram(options, everyone, BASE);
  const picked = selectSpeakers(everyone, options, BASE, []);
  assert.deepEqual(own, layoutProgram(options, everyone, BASE, picked));
  const stale = layoutProgram(options, everyone, BASE, ['gone', idOf('kim')]);
  assert.equal(stale[0].id, idOf('kim'));
  const extra = layoutProgram({ maxSpeakers: 1 }, everyone, BASE, picked);
  assert.equal(extra.length, 1);
  const loose = layoutProgram({ people: 'grid' }, everyone, BASE, chosen);
  assert.equal(loose.length, 6);
});

test('layout and selection leave their inputs alone', async () => {
  const lib = await load();
  const everyone = team(5).concat([share('bob')]);
  const program = { others: 'strip', pinned: ['kim:1'] };
  const held = [idOf('ada')];
  const copies = structuredClone([everyone, program, held]);
  lib.layoutProgram(program, everyone, BASE, held);
  lib.selectSpeakers(everyone, program, BASE, held);
  assert.deepEqual([everyone, program, held], copies);
});

test('empty and tiny calls have bounded geometry', async () => {
  const lib = await load();
  assert.deepEqual(lib.layoutProgram({}, [], BASE), []);
  assert.deepEqual(lib.selectSpeakers([], {}, BASE), []);
  for (const people of lib.PEOPLE) {
    for (const others of lib.OTHERS) {
      const options = { people, others };
      assert.deepEqual(lib.layoutProgram(options, [], BASE), []);
      const one = lib.layoutProgram(options, team(1), BASE);
      assert.equal(one.length, 1);
      assertSound(one, options, lib);
    }
  }
  const lonely = lib.layoutProgram({ screen: 'screen' }, [], BASE);
  assert.deepEqual(lonely, []);
  for (const size of [0, 1, 2, 7, 10, 33]) {
    const options = { width: size, height: size, others: 'strip' };
    const sources = team(5).concat([share('bob')]);
    const tiles = lib.layoutProgram(options, sources, BASE);
    assert.ok(tiles.length <= 6);
    assertSound(tiles, options, lib);
  }
  const zero = { width: 0, height: 1080 };
  assert.deepEqual(lib.layoutProgram(zero, team(3), BASE), []);
});

test('odd and unusual frame sizes keep every tile in bounds', async () => {
  const lib = await load();
  const sizes = [
    [1279, 719],
    [853, 481],
    [1081, 1921],
    [641, 360],
    [3840, 2160],
    [2561, 1081],
    [333, 1001],
    [1001, 333],
  ];
  const sources = team(7).concat([share('bob')]);
  for (const size of sizes) {
    for (const others of lib.OTHERS) {
      for (const screen of ['off', 'screenSpeakers']) {
        const options = { width: size[0], height: size[1], others, screen };
        const tiles = lib.layoutProgram(options, sources, BASE);
        assert.ok(tiles.length > 0, `${size} ${others} ${screen}`);
        assertSound(tiles, options, lib);
      }
    }
  }
});

test('every combination of options packs tiles without overlap', async () => {
  const lib = await load();
  const sources = team(8).concat([share('bob')]);
  let checked = 0;
  for (const people of lib.PEOPLE) {
    for (const screen of lib.SCREENS) {
      for (const placement of lib.PLACEMENTS) {
        for (const others of lib.OTHERS) {
          for (const othersPosition of lib.POSITIONS) {
            const options = {
              people,
              screen,
              placement,
              others,
              othersPosition,
              maxSpeakers: 5,
              pinned: ['kim:1'],
            };
            const tiles = lib.layoutProgram(options, sources, BASE);
            assert.ok(tiles.length > 0);
            assertSound(tiles, options, lib);
            checked++;
          }
        }
      }
    }
  }
  assert.equal(checked, 4 * 4 * 2 * 3 * 4);
});

test('a crowd keeps every mode within its maximum', async () => {
  const lib = await load();
  const sources = crowd(40).concat([share('p3')]);
  const counts = {
    speaker: 1,
    speakers: 6,
    grid: 16,
    pinned: 6,
  };
  for (const people of lib.PEOPLE) {
    const options = {
      people,
      screen: 'off',
      maxSpeakers: 6,
      pinned: crowd(6).map((source) => source.id),
    };
    const tiles = lib.layoutProgram(options, sources, BASE);
    assert.equal(tiles.length, counts[people], people);
    assertSound(tiles, options, lib);
  }
  const screen = { screen: 'screenSpeakers', maxSpeakers: 6 };
  const shared = lib.layoutProgram(screen, sources, BASE);
  assert.equal(shared.length, 7);
  const options = { ...screen, others: 'strip' };
  assert.equal(lib.layoutProgram(options, sources, BASE).length, 7 + 12);
});

test('the video aspect of cover tiles stays 16:9 at every count', async () => {
  const lib = await load();
  for (let count = 1; count <= 16; count++) {
    const options = { people: 'grid' };
    const tiles = lib.layoutProgram(options, crowd(count), BASE);
    assert.equal(tiles.length, count);
    assertSound(tiles, options, lib);
    for (const tile of tiles) assertAspect(tile);
  }
});
