'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const {
  editOptionsOf,
  outputFrameOf,
  drawVideoFrame,
  encodingOf,
} = require('../application/static/video-edit-options.js');
const {
  partsOf,
  timelineOf,
  segmentsOf,
  segmentTimeOf,
  remapEdit,
} = require('../application/static/recording-edit-logic.js');
const { silenceCuts } = require('../application/static/video-edit-silence.js');

test('resizes and frames turned, cropped video for shorts', () => {
  const part = { width: 1920, height: 1080 };
  const settings = {
    rotation: 90,
    cropLeft: 10,
    cropRight: 10,
    aspect: '9:16',
    framing: 'fill',
    resolution: 720,
    mirror: true,
  };
  const options = editOptionsOf({ options: settings });
  const frame = outputFrameOf(part, options);
  assert.deepEqual(frame, { width: 720, height: 1280 });
  assert.deepEqual(outputFrameOf({ width: 123, height: 83 }, options), {
    width: 54,
    height: 96,
  });
  const draw = [];
  const video = { videoWidth: part.width, videoHeight: part.height };
  const context = {
    canvas: frame,
    fillRect() {},
    save() {},
    restore() {},
    translate: (...args) => draw.push(args),
    scale: (...args) => draw.push(args),
    rotate: (...args) => draw.push(args),
    drawImage: (...args) => draw.push(args),
  };
  drawVideoFrame(context, video, options);
  assert.deepEqual(draw.slice(0, 3), [[360, 640], [-1, 1], [Math.PI / 2]]);
  assert.deepEqual(draw[3].slice(0, 5), [video, 192, 0, 1536, 1080]);
  assert.deepEqual(draw[3].slice(7), [1280, 900]);
});

test('a size limit budgets both streams and rejects impossible targets', () => {
  const frame = { width: 1920, height: 1080 };
  const options = editOptionsOf({ options: { target: 10 } });
  const encoding = encodingOf(frame, 60000, options, true);
  assert.equal(encoding.error, '');
  assert.ok(encoding.bytes <= encoding.maxBytes + 1);
  assert.ok(encoding.audioRate > 0);
  assert.ok(encoding.videoRate < 18000000);
  assert.ok(encodingOf(frame, 7200000, options, true).error);
});

test('reordering keeps cuts and seeking follows output speed', () => {
  const clips = [
    { key: 'a', duration: 3000 },
    { key: 'b', duration: 3000 },
  ];
  const parts = partsOf(clips);
  const draft = { start: 100, end: 6000, cuts: [{ start: 400, end: 600 }] };
  const reordered = partsOf([clips[1], clips[0]]);
  const remapped = remapEdit(draft, parts, reordered);
  assert.deepEqual(remapped.cuts, [
    { start: 3000, end: 3100 },
    { start: 3400, end: 3600 },
  ]);
  const { kept } = timelineOf(6000, remapped);
  const segments = segmentsOf(reordered, kept, 2);
  const { segment, time } = segmentTimeOf(segments, 1550);
  assert.equal(segment.part.key, 'a');
  assert.equal(time, 200);
});

test('silence detection keeps padding and ignores short gaps', () => {
  const levels = [
    { time: 0, level: 0.4 },
    { time: 500, level: 0.005 },
    { time: 700, level: 0.4 },
    { time: 1000, level: 0.005 },
    { time: 2250, level: 0.4 },
  ];
  assert.deepEqual(silenceCuts(levels, 3000, 1000), [
    { start: 1125, end: 2125 },
  ]);
});
