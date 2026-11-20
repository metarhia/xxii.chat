'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const load = async () => {
  const { layoutOf } = await import('../application/static/capture.js');
  const { layoutProgram } = await import('../application/static/layout.js');
  const { sourcesOf } = await import('../application/static/compositor.js');
  const local = {
    endpoint: 'local',
    nick: 'alex',
    local: true,
    camera: {},
    screen: {},
  };
  return (name) => {
    const options = layoutOf(name);
    const sources = sourcesOf([local], new Map(), options);
    return layoutProgram(options, sources, 0);
  };
};

test('solo camera bubble sits inside the screen', async () => {
  const tiles = await load();
  const picture = tiles('bubble');
  assert.deepEqual(
    picture.map(({ id }) => id),
    ['local/screen', 'local/camera'],
  );
  const screen = picture[0];
  const camera = picture[1];
  assert.ok(camera.z > screen.z);
  assert.ok(camera.x > screen.x);
  assert.ok(camera.y > screen.y);
  assert.ok(camera.x + camera.width < screen.x + screen.width);
  assert.ok(camera.y + camera.height < screen.y + screen.height);
  assert.equal(camera.label, '');
  assert.equal(screen.label, '');
});

test('solo camera only shows the camera without its name', async () => {
  const tiles = await load();
  const picture = tiles('camera');
  assert.deepEqual(
    picture.map(({ id, label }) => [id, label]),
    [['local/camera', '']],
  );
});

test('solo screen only shows the screen without its name', async () => {
  const tiles = await load();
  const picture = tiles('screen');
  assert.deepEqual(
    picture.map(({ id, label }) => [id, label]),
    [['local/screen', '']],
  );
});
