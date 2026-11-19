'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const loadFiles = () => import('../application/static/recording-files.js');
const loadWebm = () => import('../application/static/recording-webm.js');

const input = {
  id: 'r-1',
  title: '!general 2026-11-19 14:05',
  chat: 'general',
  chatName: '!general',
  call: 'call-1',
  started: 1763300000000,
  mime: 'video/mp4;codecs=avc1.640028,opus',
  extension: 'mp4',
  options: { quality: '720p30' },
  people: ['alex'],
};

test('names replace unsafe characters and keep the date', async () => {
  const { fileNameOf, stampOf, titleOf, programFileOf } = await loadFiles();
  const started = new Date(2026, 10, 19, 14, 5).getTime();
  assert.equal(stampOf(started), '2026-11-19 14-05');
  assert.equal(stampOf(started, ':'), '2026-11-19 14:05');
  assert.equal(
    fileNameOf('!general', started, 'mp4'),
    'xxii !general 2026-11-19 14-05.mp4',
  );
  assert.equal(
    fileNameOf('a/b:c*d?"e<f>g|h\\i\u0001', started, 'webm'),
    'xxii a_b_c_d__e_f_g_h_i_ 2026-11-19 14-05.webm',
  );
  assert.equal(titleOf('!general', started), '!general 2026-11-19 14:05');
  assert.equal(programFileOf('webm'), 'program.webm');
});

test('content disposition has ASCII and UTF-8 names', async () => {
  const { dispositionOf } = await loadFiles();
  const mark = String.fromCharCode(39).repeat(2);
  assert.equal(
    dispositionOf('xxii a.mp4'),
    `attachment; filename="xxii a.mp4"; filename*=UTF-8${mark}xxii%20a.mp4`,
  );
  const text = dispositionOf('чат "1" (a).mp4');
  assert.ok(text.includes('filename="___ _1_ (a).mp4"'));
  assert.ok(text.includes(`filename*=UTF-8${mark}%D1%87`));
  assert.ok(text.includes('%28a%29.mp4'));
});

test('types and routes come from the stored names', async () => {
  const { typeOf, extensionOf, routeOf, TYPES } = await loadFiles();
  assert.equal(typeOf('video/mp4;codecs=avc1.64001f,opus'), 'video/mp4');
  assert.equal(typeOf(' Video/WebM ; codecs=vp9'), 'video/webm');
  assert.equal(typeOf(undefined), '');
  assert.equal(extensionOf('program.WEBM'), 'webm');
  assert.equal(extensionOf('noextension'), '');
  assert.equal(TYPES.jpg, 'image/jpeg');
  assert.deepEqual(routeOf('/recordings/abc-1/program.mp4'), {
    id: 'abc-1',
    file: 'program.mp4',
  });
  assert.equal(routeOf('/recordings/abc/../x'), null);
  assert.equal(routeOf('/recordings/abc'), null);
  assert.equal(routeOf('/recordings/a b/program.mp4'), null);
  assert.equal(routeOf('/other/abc/program.mp4'), null);
});

test('byte ranges follow the verified rules', async () => {
  const { rangeOf } = await loadFiles();
  const range = (header, size = 1000) => rangeOf(header, size);
  assert.deepEqual(range(undefined), { status: 200, start: 0, end: 999 });
  assert.deepEqual(range('bytes=0-'), { status: 206, start: 0, end: 999 });
  const partial = (start, end) => ({ status: 206, start, end });
  assert.deepEqual(range('bytes=100-199'), partial(100, 199));
  assert.deepEqual(range('bytes=900-5000'), partial(900, 999));
  assert.deepEqual(range('bytes=-100'), { status: 206, start: 900, end: 999 });
  assert.deepEqual(range('bytes=-5000'), { status: 206, start: 0, end: 999 });
  assert.equal(range('bytes=1000-').status, 416);
  assert.equal(range('bytes=-0').status, 416);
  assert.equal(range('bytes=5-1').status, 416);
  assert.equal(range('bytes=0-1,5-9').status, 200);
  assert.equal(range('items=0-1').status, 200);
  assert.equal(range('bytes=-').status, 200);
  assert.equal(range('bytes=0-', 0).status, 200);
});

test('meta starts recording and follows the state machine', async () => {
  const { createMeta, nextMeta, STATES } = await loadFiles();
  const meta = createMeta(input);
  assert.deepEqual(meta, {
    ...input,
    stopped: 0,
    duration: 0,
    size: 0,
    state: 'recording',
    folder: '',
  });
  assert.deepEqual(STATES, ['recording', 'paused', 'done', 'interrupted']);
  const paused = nextMeta(meta, { type: 'pause' });
  assert.equal(paused.state, 'paused');
  assert.equal(meta.state, 'recording');
  assert.equal(nextMeta(paused, { type: 'pause' }), paused);
  assert.equal(nextMeta(meta, { type: 'resume' }), meta);
  const resumed = nextMeta(paused, { type: 'resume' });
  assert.equal(resumed.state, 'recording');
  const tick = { type: 'progress', size: 10, duration: 2 };
  const progress = nextMeta(resumed, tick);
  assert.equal(progress.size, 10);
  assert.equal(progress.duration, 2);
  assert.equal(progress.state, 'recording');
  const inPause = nextMeta(paused, { type: 'progress', size: 20, duration: 3 });
  assert.equal(inPause.state, 'paused');
  assert.equal(inPause.size, 20);
});

test('closing and interrupting end the recording once', async () => {
  const { createMeta, nextMeta } = await loadFiles();
  const meta = createMeta(input);
  const close = { type: 'close', size: 500, duration: 5000, time: 99 };
  const done = nextMeta(meta, close);
  assert.equal(done.state, 'done');
  assert.equal(done.stopped, 99);
  assert.equal(done.size, 500);
  assert.equal(done.duration, 5000);
  assert.deepEqual(done.people, ['alex']);
  const named = nextMeta(meta, { ...close, people: ['alex', 'bob'] });
  assert.deepEqual(named.people, ['alex', 'bob']);
  const late = { size: 1, duration: 1 };
  assert.equal(nextMeta(done, { type: 'progress', ...late }), done);
  assert.equal(nextMeta(done, { type: 'interrupt', ...late }), done);
  assert.equal(nextMeta(done, { type: 'close', ...close, size: 7 }), done);
  assert.equal(nextMeta(done, { type: 'pause' }), done);
  const cut = nextMeta(nextMeta(meta, { type: 'pause' }), {
    type: 'interrupt',
    size: 40,
    duration: 4,
  });
  assert.equal(cut.state, 'interrupted');
  assert.equal(cut.size, 40);
  assert.equal(cut.stopped, 0);
  assert.equal(nextMeta(meta, { type: 'unknown' }), meta);
});

test('writes flush every 5 s and save meta every 10 s', async () => {
  const { scheduleOf, markedOf, FLUSH_MS, META_MS } = await loadFiles();
  assert.equal(FLUSH_MS, 5000);
  assert.equal(META_MS, 10000);
  let marks = { flushedAt: 0, metaAt: 0 };
  const steps = [];
  for (let now = 1000; now <= 21000; now += 1000) {
    const due = scheduleOf(marks, now);
    marks = markedOf(marks, due, now);
    steps.push([now, due.flush, due.meta]);
  }
  const flushes = steps.filter((step) => step[1]).map((step) => step[0]);
  const saves = steps.filter((step) => step[2]).map((step) => step[0]);
  assert.deepEqual(flushes, [5000, 10000, 15000, 20000]);
  assert.deepEqual(saves, [10000, 20000]);
});

test('free space decides between ok, low, and full', async () => {
  const { spaceOf, LOW_BYTES, STOP_BYTES } = await loadFiles();
  const GB = 1024 ** 3;
  assert.equal(LOW_BYTES, 2 * GB);
  assert.equal(STOP_BYTES, 500 * 1024 * 1024);
  assert.equal(spaceOf({ quota: 10 * GB, usage: 1 * GB }), 'ok');
  assert.equal(spaceOf({ quota: 3 * GB, usage: 2 * GB }), 'low');
  assert.equal(spaceOf({ quota: 3 * GB, usage: 2.8 * GB }), 'full');
  assert.equal(spaceOf({}), 'ok');
  assert.equal(spaceOf(undefined), 'ok');
});

const idBytes = (id) => {
  const bytes = [];
  for (let value = id; value > 0; value = Math.floor(value / 256)) {
    bytes.unshift(value % 256);
  }
  return bytes;
};

const element = (id, content, size = content.length) => {
  const header = idBytes(id);
  const length = size < 127 ? 1 : 2;
  const sizeBytes =
    length === 1 ? [0x80 | size] : [0x40 | (size >> 8), size & 255];
  return header.concat(sizeBytes, content);
};

const unknown = [0x01, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff];
const asciiOf = (text) => Array.from(text, (char) => char.charCodeAt(0));

const fixture = (info, extra = []) => {
  const header = element(0x1a45dfa3, element(0x4286, [1]));
  const tracks = element(0x1654ae6b, [0xae, 0x83, 0xd7, 0x81, 0x01]);
  const cluster = element(0x1f43b675, element(0xe7, [0]));
  const segment = idBytes(0x18538067).concat(unknown, extra, info);
  return Uint8Array.from(header.concat(segment, tracks, cluster));
};

const chromeInfo = element(
  0x1549a966,
  element(0x2ad7b1, [0x0f, 0x42, 0x40]).concat(
    element(0x4d80, asciiOf('Chrome')),
    element(0x5741, asciiOf('Chrome')),
  ),
);

const read = (bytes, offset) =>
  new DataView(bytes.buffer, bytes.byteOffset).getFloat64(offset);

test('webm gets a duration slot inside Info and keeps the rest', async () => {
  const { durationSlotOf, durationBytesOf } = await loadWebm();
  const head = fixture(chromeInfo);
  const slot = durationSlotOf(head);
  assert.ok(slot);
  assert.equal(slot.scale, 1000000);
  assert.equal(slot.bytes.length, head.length + 11);
  const infoAt = head.indexOf(0x15);
  assert.equal(slot.bytes[infoAt + 4], chromeInfo[4] + 11);
  const durationAt = slot.offset - 3;
  assert.deepEqual(
    Array.from(slot.bytes.subarray(durationAt, durationAt + 3)),
    [0x44, 0x89, 0x88],
  );
  assert.equal(read(slot.bytes, slot.offset), 0);
  const patched = Uint8Array.from(slot.bytes);
  patched.set(durationBytesOf(5230, slot.scale), slot.offset);
  assert.equal(read(patched, slot.offset), 5230);
  const tail = head.subarray(infoAt + chromeInfo.length);
  const moved = slot.bytes.subarray(infoAt + chromeInfo.length + 11);
  assert.deepEqual(Array.from(moved), Array.from(tail));
  const before = head.subarray(0, infoAt);
  assert.deepEqual(
    Array.from(slot.bytes.subarray(0, infoAt)),
    Array.from(before),
  );
  const again = durationSlotOf(slot.bytes);
  assert.equal(again.offset, slot.offset);
  assert.equal(again.bytes, slot.bytes);
});

test('duration follows the timecode scale', async () => {
  const { durationSlotOf, durationBytesOf } = await loadWebm();
  const scaled = element(0x1549a966, element(0x2ad7b1, [0x03, 0xd0, 0x90]));
  const slot = durationSlotOf(fixture(scaled));
  assert.equal(slot.scale, 250000);
  const bytes = durationBytesOf(1000, slot.scale);
  assert.equal(read(bytes, 0), 4000);
  const noScale = element(0x1549a966, element(0x4d80, asciiOf('x')));
  assert.equal(durationSlotOf(fixture(noScale)).scale, 1000000);
});

test('webm with other layouts is left alone', async () => {
  const { durationSlotOf } = await loadWebm();
  const seek = element(0x114d9b74, [0xec, 0x80]);
  assert.equal(durationSlotOf(fixture(chromeInfo, seek)), null);
  assert.equal(durationSlotOf(Uint8Array.of(0, 0, 0, 24, 0x66, 0x74)), null);
  assert.equal(durationSlotOf(new Uint8Array(0)), null);
  const head = fixture(chromeInfo);
  assert.equal(durationSlotOf(head.subarray(0, 40)), null);
  const noInfo = fixture([]);
  assert.equal(durationSlotOf(noInfo), null);
  const duration = element(0x4489, [0x40, 0x14, 0, 0, 0, 0, 0, 0]);
  const withDuration = element(0x1549a966, duration);
  const kept = durationSlotOf(fixture(withDuration));
  assert.equal(read(kept.bytes, kept.offset), 5);
  const short = element(0x1549a966, element(0x4489, [0x40, 0x14, 0, 0]));
  assert.equal(durationSlotOf(fixture(short)), null);
});

test('sizes are written as the shortest vint', async () => {
  const { encodeSize } = await loadWebm();
  assert.deepEqual(Array.from(encodeSize(0)), [0x80]);
  assert.deepEqual(Array.from(encodeSize(36)), [0xa4]);
  assert.deepEqual(Array.from(encodeSize(126)), [0xfe]);
  assert.deepEqual(Array.from(encodeSize(127)), [0x40, 0x7f]);
  assert.deepEqual(Array.from(encodeSize(300)), [0x41, 0x2c]);
  assert.deepEqual(Array.from(encodeSize(16382)), [0x7f, 0xfe]);
  assert.deepEqual(Array.from(encodeSize(16383)), [0x20, 0x3f, 0xff]);
});
