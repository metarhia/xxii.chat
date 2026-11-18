'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const load = () => import('../application/static/mirror.js');

test('auto picks the processor only with processor and generator', async () => {
  const { pathOf } = await load();
  const both = { processor: true, generator: true };
  assert.equal(pathOf(both), 'processor');
  assert.equal(pathOf(both, 'auto'), 'processor');
  assert.equal(pathOf({ processor: true, generator: false }), 'canvas');
  assert.equal(pathOf({ processor: false, generator: true }), 'canvas');
  assert.equal(pathOf({ processor: false, generator: false }), 'canvas');
});

test('forced canvas always works, forced processor needs both', async () => {
  const { pathOf } = await load();
  const both = { processor: true, generator: true };
  const none = { processor: false, generator: false };
  const half = { processor: true, generator: false };
  assert.equal(pathOf(both, 'canvas'), 'canvas');
  assert.equal(pathOf(none, 'canvas'), 'canvas');
  assert.equal(pathOf(both, 'processor'), 'processor');
  assert.equal(pathOf(none, 'processor'), '');
  assert.equal(pathOf(half, 'processor'), '');
});

test('capabilities are read from the scope', async () => {
  const { capabilitiesOf } = await load();
  assert.deepEqual(capabilitiesOf({}), { processor: false, generator: false });
  const scope = {
    MediaStreamTrackProcessor() {},
    VideoTrackGenerator() {},
  };
  assert.deepEqual(capabilitiesOf(scope), { processor: true, generator: true });
});
