'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const {
  initialEdit,
  timelineOf,
  partsOf,
  segmentsOf,
  segmentTimeOf,
  timeInputOf,
  timeFromInput,
  EditHistory,
} = require('../application/static/recording-edit-logic.js');

test('keeps half-open intervals and seeks into the next kept range', () => {
  const cuts = [
    { start: 6000, end: 9000 },
    { start: 12000, end: 14000 },
  ];
  const timeline = timelineOf(20000, { start: 2000, end: 18000, cuts });
  assert.deepEqual(timeline, {
    kept: [
      { start: 2000, end: 6000, output: 0 },
      { start: 9000, end: 12000, output: 4000 },
      { start: 14000, end: 18000, output: 7000 },
    ],
    duration: 11000,
    changed: true,
  });
  const segments = segmentsOf(partsOf([{ duration: 20000 }]), timeline.kept);
  assert.equal(segmentTimeOf(segments, 3999).time, 5999);
  assert.equal(segmentTimeOf(segments, 4000).time, 9000);
  assert.equal(segmentTimeOf(segments, 11000).time, 18000);
});

test('clamps, sorts and merges cuts while retaining the original draft', () => {
  const cuts = [
    { start: 60, end: 90 },
    { start: 0, end: 20 },
    { start: 40, end: 60 },
    { start: 34, end: 42 },
  ];
  const edit = new EditHistory({ ...initialEdit(100), cuts });
  edit.apply({ ...edit.draft, start: 10, end: 70 });
  assert.deepEqual(timelineOf(100, edit.draft).kept, [
    { start: 20, end: 34, output: 0 },
  ]);
  edit.undo();
  assert.equal(edit.draft.cuts, cuts);
  assert.deepEqual(timelineOf(100, edit.draft).kept, [
    { start: 20, end: 34, output: 0 },
    { start: 90, end: 100, output: 14 },
  ]);
  edit.redo();
  assert.equal(edit.draft.start, 10);
  assert.equal(edit.draft.end, 70);
  edit.undo();
  edit.apply(initialEdit(100));
  assert.equal(edit.canRedo, false);
  assert.equal(timelineOf(100, edit.draft).changed, false);
});

test('rejects impossible times and accepts millisecond time fields', () => {
  const cuts = [{ start: 20, end: 70 }];
  assert.ok(timelineOf(100, { start: 20, end: 70, cuts }).error);
  assert.ok(timelineOf(100, { start: 90, end: 30, cuts }).error);
  cuts[0].end = 10;
  assert.ok(timelineOf(100, { start: 0, end: 100, cuts }).error);
  assert.equal(timeInputOf(43928741), '12:12:08.741');
  assert.equal(timeFromInput('12:12:08.741'), 43928741);
  assert.equal(timeFromInput('01:02.09'), 62090);
  assert.ok(Number.isNaN(timeFromInput('00:00:61')));
});

test('a cut across folder parts skips both sides of the boundary', () => {
  const parts = partsOf([{ duration: 100 }, { duration: 150 }]);
  const cuts = [{ start: 80, end: 140 }];
  const { kept } = timelineOf(250, { start: 20, end: 200, cuts });
  const spans = segmentsOf(parts, kept);
  const segments = spans.map(({ part, ...segment }) => ({
    part: part.index,
    ...segment,
  }));
  assert.deepEqual(segments, [
    { part: 0, start: 20, end: 80, output: 0 },
    { part: 1, start: 40, end: 100, output: 60 },
  ]);
  assert.deepEqual(segmentTimeOf(spans, 60), { segment: spans[1], time: 40 });
  assert.deepEqual(segmentTimeOf(spans, 120), { segment: spans[1], time: 100 });
});
