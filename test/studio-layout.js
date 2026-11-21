'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const layout = () => import('../application/static/studio-layout.js');
const controls = () => import('../application/static/record-panel.js');
const CHECKSUM = 'a'.repeat(64);

test('built-in scenes use the recording defaults for Live', async () => {
  const { builtInScenes } = await layout();
  const { defaultsOf } = await controls();
  const defaults = defaultsOf({
    recordingLayout: 'grid',
    recordingAudio: 'duck',
    recordingQuality: '720p30',
  });
  const { active, transition, scenes } = builtInScenes(defaults);
  assert.equal(active, 'live');
  assert.equal(transition, 'fade');
  assert.deepEqual(
    scenes.map(({ name, type }) => [name, type]),
    [
      ['Starting soon', 'countdown'],
      ['Live', 'live'],
      ['Be right back', 'intermission'],
      ['Ending', 'intermission'],
    ],
  );
  assert.equal(scenes[0].minutes, 5);
  assert.equal(scenes[1].program.people, 'grid');
  assert.equal(scenes[1].program.audio, 'duck');
  assert.equal(Object.hasOwn(scenes[1].program, 'quality'), false);
  assert.deepEqual(scenes[1].overlays, [
    'logo',
    'banner',
    'ticker',
    'lowerThird',
    'comment',
  ]);
  assert.deepEqual(scenes[2].overlays, ['logo']);
});

test('invalid scene files use defaults', async () => {
  const { builtInScenes, scenesOf, sceneOf } = await layout();
  const draft = {
    id: 'x',
    name: ' Scene ',
    type: 'countdown',
    unknown: { yes: true },
    minutes: 1000,
    background: { color: 'red', image: CHECKSUM, extra: true },
    overlays: ['logo', 'invalid', 'logo'],
    music: '../audio',
    until: 16000,
    program: {
      screen: 'screen',
      people: 'bad',
      quality: '720p30',
      pinned: ['a', 3, 'a', 'b'],
      volumes: { a: 3, b: -1, c: '0' },
    },
  };
  const scene = sceneOf(draft);
  assert.equal(scene.name, 'Scene');
  assert.equal(scene.minutes, 60);
  assert.equal(scene.music, '');
  assert.deepEqual(scene.background, { color: '#090a0c', image: CHECKSUM });
  assert.deepEqual(scene.overlays, ['logo']);
  assert.equal(scene.program.screen, 'screen');
  assert.equal(scene.program.people, 'speakers');
  assert.deepEqual(scene.program.pinned, ['a', 'b']);
  assert.deepEqual(scene.program.volumes, { a: 2, b: 0 });
  for (const field of ['unknown', 'until']) {
    assert.equal(Object.hasOwn(scene, field), false);
  }
  const valid = { active: 'x', transition: 'cut', scenes: [scene] };
  assert.deepEqual(scenesOf({ ...valid, extra: true }), valid);
  const empty = { active: '', transition: 'cut', scenes: [] };
  assert.deepEqual(scenesOf(empty), empty);
  for (const bad of [
    null,
    { ...valid, active: 'missing' },
    { ...valid, transition: 'wipe' },
    { ...valid, scenes: [scene, scene] },
    { ...valid, scenes: [{ ...scene, type: 'missing' }] },
  ]) {
    assert.deepEqual(scenesOf(bad), builtInScenes());
  }
});

test('fade reaches full alpha at 300ms and clamps elapsed time', async () => {
  const { fadeAlpha } = await layout();
  assert.equal(fadeAlpha(1000, 999), 0);
  assert.equal(fadeAlpha(1000, 1000), 0);
  assert.equal(fadeAlpha(1000, 1100), 1 / 3);
  assert.equal(fadeAlpha(1000, 1150), 0.5);
  assert.equal(fadeAlpha(1000, 1300), 1);
  assert.equal(fadeAlpha(1000, 1600), 1);
});

test('countdown rounds up and stays at zero after expiry', async () => {
  const { countdownText, countdownUntil } = await layout();
  const until = countdownUntil(5, 100);
  assert.equal(until, 300100);
  assert.equal(countdownText(until, 100), '05:00');
  assert.equal(countdownText(until, 101), '05:00');
  assert.equal(countdownText(until, 1100), '04:59');
  assert.equal(countdownText(until, 299101), '00:01');
  assert.equal(countdownText(until, 300100), '00:00');
  assert.equal(countdownText(until, 400000), '00:00');
});

test('logo uses its corner and scales with program height', async () => {
  const { logoRect } = await layout();
  const corners = {
    'top-left': { x: 24, y: 24 },
    'top-right': { x: 1800, y: 24 },
    'bottom-left': { x: 24, y: 1008 },
    'bottom-right': { x: 1800, y: 1008 },
  };
  for (const [corner, point] of Object.entries(corners)) {
    assert.deepEqual(logoRect({ corner, size: 96 }, 1920, 1080, 120, 60), {
      ...point,
      width: 96,
      height: 48,
    });
  }
  const logo = { corner: 'bottom-right', size: 192 };
  assert.deepEqual(logoRect(logo, 1280, 720, 50, 100), {
    x: 1200,
    y: 576,
    width: 64,
    height: 128,
  });
});

test('brand validation and chip shapes', async () => {
  const { brandOf, brandFont, chipStyleOf } = await layout();
  const validated = brandOf({
    accent: '#112233',
    text: 'bad',
    chip: 'rgba(24, 25, 26, .5)',
    font: 'Inter',
    logo: { asset: CHECKSUM, corner: 'bottom-left', size: 12 },
    chipStyle: 'bar',
  });
  assert.deepEqual(validated, {
    accent: '#112233',
    text: '#d5d5d5',
    chip: 'rgba(24, 25, 26, .5)',
    font: 'Fira Code',
    logo: { asset: CHECKSUM, corner: 'bottom-left', size: 48 },
    chipStyle: 'bar',
  });
  assert.equal(brandOf({ logo: { size: 300 } }).logo.size, 192);
  assert.deepEqual(chipStyleOf('block', 20), { radius: 0, bar: 0 });
  assert.deepEqual(chipStyleOf('bubble', 20), { radius: 10, bar: 0 });
  assert.deepEqual(chipStyleOf('bar', 20), { radius: 0, bar: 4 });
  assert.equal(brandFont('system-ui', 20), '500 20px system-ui');
  assert.equal(brandFont('Fira Code', 20), '500 20px "Fira Code"');
});

test('text cards fit in the frame above the ticker', async () => {
  const { overlayRect } = await layout();
  for (const height of [720, 1080]) {
    const width = (height * 16) / 9;
    const banner = overlayRect('banner', width, height, true);
    const ticker = overlayRect('ticker', width, height, true);
    const lowerThird = overlayRect('lowerThird', width, height, true);
    const comment = overlayRect('comment', width, height, true);
    for (const rect of [banner, ticker, lowerThird, comment]) {
      assert.ok(rect.x >= 0 && rect.y >= 0);
      assert.ok(rect.width > 0 && rect.height > 0);
      assert.ok(rect.x + rect.width <= width);
      assert.ok(rect.y + rect.height <= height);
    }
    assert.ok(banner.y + banner.height < ticker.y);
    assert.ok(lowerThird.y + lowerThird.height < banner.y);
    assert.ok(banner.x + banner.width < comment.x);
    assert.equal(ticker.y + ticker.height, height);
  }
});

test('text cards fade with support for reduced motion', async () => {
  const { overlayOpacity } = await layout();
  const enter = { from: 0, to: 1, started: 1000 };
  const exit = { from: 1, to: 0, started: 2000 };
  assert.equal(overlayOpacity(enter, 1000), 0);
  assert.equal(overlayOpacity(enter, 1150), 0.5);
  assert.equal(overlayOpacity(enter, 1300), 1);
  assert.equal(overlayOpacity(exit, 2000), 1);
  assert.equal(overlayOpacity(exit, 2150), 0.5);
  assert.equal(overlayOpacity(exit, 2300), 0);
  assert.equal(overlayOpacity(enter, 1000, true), 1);
  assert.equal(overlayOpacity(exit, 2000, true), 0);
});

test('ticker moves at a fixed speed and wraps after exit', async () => {
  const { tickerOffset } = await layout();
  assert.equal(tickerOffset(1000, 1280, 160), 1184);
  assert.equal(tickerOffset(1000, 1920, 160), 1824);
  assert.equal(tickerOffset(14999, 1280, 160).toFixed(1), '-159.9');
  assert.equal(tickerOffset(15000, 1280, 160), 1280);
});

test('saved texts are validated and long comments are clipped', async () => {
  const { textsOf, commentText, commentLines } = await layout();
  const input = {
    banners: [null, { id: 'a', text: ' one ' }, { id: 'b', text: '' }],
    ticker: ' rolling ',
    selected: 'a',
  };
  assert.deepEqual(textsOf(input), {
    banners: [{ id: 'a', text: 'one' }],
    ticker: 'rolling',
  });
  const text = commentText('🙂'.repeat(300));
  assert.equal(Array.from(text).length, 280);
  assert.equal(text, '🙂'.repeat(279) + '…');
  const measure = (value) => value.length;
  const lines = commentLines('01234567890123456789012345', measure, 5);
  assert.deepEqual(lines, ['01234', '56789', '01234', '5678…']);
  assert.deepEqual(
    commentLines('<b>plain</b>\r\nnext\nline\nlast\nfifth', measure, 40),
    ['<b>plain</b>', 'next', 'line', 'last…'],
  );
});

test('clip uses its checksum and file name as a share source', async () => {
  const { clipSource } = await layout();
  const { layoutProgram, programOf } =
    await import('../application/static/layout.js');
  const clip = { id: 'clip/' + CHECKSUM, mode: 'tile', name: 'Test.webm' };
  assert.equal(clipSource({ ...clip, mode: 'full' }), null);
  const tiles = layoutProgram(
    programOf({ screen: 'screen' }),
    [clipSource(clip)],
    0,
  );
  assert.equal(tiles.length, 1);
  assert.equal(tiles[0].id, clip.id);
  assert.equal(tiles[0].label, clip.name);
  assert.equal(tiles[0].fit, 'contain');
  const hidden = layoutProgram(
    programOf({ screen: 'off' }),
    [clipSource(clip)],
    0,
  );
  assert.equal(hidden.length, 0);
});

test('lower-third titles fit the call update limit', async () => {
  const { validateSettings } =
    await import('../application/static/call-settings.js');
  const title = 'a'.repeat(47);
  assert.equal(validateSettings({ title: '  Name  ' }).title, 'Name');
  assert.equal(validateSettings({ title: title + '🙂' }).title, title);
  assert.equal(validateSettings({ title: 'a'.repeat(52) }).title.length, 48);
  assert.equal(validateSettings({ title: 48 }).title, '');
});
