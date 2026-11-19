'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');

const {
  storedDurationOf,
} = require('../application/static/recording-duration.js');
const { durationBytesOf } = require('../application/static/recording-webm.js');

const fallback = 875;
const webmHead = Buffer.from('1a45dfa3801853806701ffffffffffffff', 'hex');
const scale = Buffer.from('2ad7b1831e8480', 'hex');
const durationSlot = Buffer.from('4489880000000000000000', 'hex');

const handleOf = (bytes) => ({
  read(target, { at }) {
    assert.ok(target.length <= 12);
    const source = bytes.subarray(at, at + Math.min(target.length, 5));
    target.set(source);
    return source.length;
  },
});

const measure = (bytes, extension) =>
  storedDurationOf(handleOf(bytes), bytes.length, extension, fallback);

const element = (id, ...parts) => {
  const body = Buffer.concat(parts);
  assert.ok(body.length < 127);
  return Buffer.concat([
    Buffer.from(`${id}`, 'hex'),
    Buffer.from([0x80 | body.length]),
    body,
  ]);
};

const webmCluster = (timecode) => {
  const time = Buffer.alloc(2);
  time.writeUInt16BE(timecode);
  return element('1f43b675', element('e7', time));
};

test('WebM finds the last Cluster timecode and Duration slot', () => {
  const info = element('1549a966', durationSlot);
  const bytes = Buffer.concat([
    webmHead,
    info,
    webmCluster(0),
    webmCluster(3400),
  ]);
  const { duration, slot } = measure(bytes, 'webm');
  assert.equal(duration, 3400);
  assert.equal(slot.scale, 1000000);
  assert.equal(slot.offset, webmHead.length + info.length - 8);
  const patched = durationBytesOf(duration, slot.scale);
  assert.equal(Buffer.from(patched).readDoubleBE(), 3400);
});

test('WebM handles unknown Clusters, scale, and a truncated tail', () => {
  const info = element('1549a966', scale, durationSlot);
  const cluster = (value) =>
    Buffer.concat([
      Buffer.from('1f43b675ff', 'hex'),
      element('e7', Buffer.from([value])),
      element('a3', webmCluster(3999)),
    ]);
  const bytes = Buffer.concat([
    webmHead,
    info,
    cluster(100),
    cluster(170),
    Buffer.from('1f43b67589e78201', 'hex'),
  ]);
  const { duration, slot } = measure(bytes, 'webm');
  assert.equal(duration, 340);
  assert.equal(slot.scale, 2000000);
  assert.equal(
    Buffer.from(durationBytesOf(duration, slot.scale)).readDoubleBE(),
    170,
  );
});

test('WebM reads a timecode before a partial Cluster payload', () => {
  const bytes = Buffer.concat([
    webmHead,
    webmCluster(0),
    Buffer.from('1f43b675bee78207d0a3', 'hex'),
  ]);
  assert.deepEqual(measure(bytes, 'webm'), { duration: 2000, slot: null });
});

test('WebM keeps the saved duration with no Cluster timecode', () => {
  const info = element('1549a966', scale, durationSlot);
  const bytes = Buffer.concat([webmHead, info]);
  const { duration, slot } = measure(bytes, 'webm');
  assert.equal(duration, fallback);
  assert.equal(slot.offset, bytes.length - 8);
});

const box = (type, ...parts) => {
  const data = Buffer.concat(parts);
  const header = Buffer.alloc(8);
  header.writeUInt32BE(header.length + data.length);
  header.write(type, 4);
  return Buffer.concat([header, data]);
};

const fullBox = (type, offset, value, version = 0, wide = false) => {
  const data = Buffer.alloc(offset + (wide ? 8 : 4));
  data[0] = version;
  if (typeof value === 'string') data.write(value, offset);
  else if (wide) data.writeBigUInt64BE(BigInt(value), offset);
  else data.writeUInt32BE(value, offset);
  return box(type, data);
};

const track = (id, scale, type, version = 0) => {
  const offset = version === 0 ? 12 : 20;
  return box(
    'trak',
    box(
      'mdia',
      fullBox('hdlr', 8, type),
      fullBox('mdhd', offset, scale, version),
    ),
    fullBox('tkhd', offset, id, version),
  );
};

const trackFragment = (id, ticks, version = 0) =>
  box(
    'traf',
    fullBox('tfhd', 4, id),
    fullBox('tfdt', 4, ticks, version, version === 1),
  );

test('fMP4 takes the last video tfdt and uses that track timescale', () => {
  const movie = box(
    'moov',
    track(1, 48000, 'soun'),
    track(2, 90000, 'vide', 1),
  );
  const earlier = box('moof', trackFragment(2, 90000), trackFragment(1, 48000));
  const videoTicks = 90000 * 50000;
  const last = box(
    'moof',
    trackFragment(2, videoTicks, 1),
    trackFragment(1, 32),
  );
  const audioOnly = box('moof', trackFragment(1, 480000));
  const bytes = Buffer.concat([box('ftyp'), movie, earlier, last, audioOnly]);
  assert.deepEqual(measure(bytes, 'mp4'), { duration: 50000000, slot: null });
});

test('fMP4 ignores an incomplete or unsupported tfdt at the tail', () => {
  const movie = box('moov', track(3, 30000, 'vide'));
  const first = box('moof', trackFragment(3, 61500));
  const unsupported = box('moof', trackFragment(3, 90000, 2));
  const last = box('moof', trackFragment(3, 90000, 1));
  const bytes = Buffer.concat([
    movie,
    first,
    unsupported,
    last.subarray(0, -1),
  ]);
  assert.deepEqual(measure(bytes, 'mp4'), { duration: 2050, slot: null });
});

test('fMP4 skips a large media box using its extended size', () => {
  const movie = box('moov', track(2, 1000, 'vide'));
  const media = box('mdat', Buffer.alloc(8));
  const mediaSize = 5 * 1024 ** 3;
  media.writeUInt32BE(1);
  media.writeBigUInt64BE(BigInt(mediaSize), 8);
  const start = movie.length + mediaSize;
  const head = Buffer.concat([movie, media]);
  const tail = box('moof', trackFragment(2, 1720));
  const handle = {
    read(target, { at }) {
      assert.ok(at < head.length || at >= start, `read media payload at ${at}`);
      if (at < head.length) return handleOf(head).read(target, { at });
      return handleOf(tail).read(target, { at: at - start });
    },
  };
  const size = start + tail.length;
  const result = storedDurationOf(handle, size, 'mp4', fallback);
  assert.deepEqual(result, { duration: 1720, slot: null });
});

test('unrecognized formats and audio-only MP4 use saved duration', () => {
  const bytes = Buffer.from('arbitrary bytes');
  for (const extension of ['webm', 'mp4', 'unknown']) {
    assert.deepEqual(measure(bytes, extension), {
      duration: fallback,
      slot: null,
    });
  }
  const movie = box('moov', track(1, 48000, 'soun'));
  const audio = box('moof', trackFragment(1, 48000));
  assert.deepEqual(measure(Buffer.concat([movie, audio]), 'mp4'), {
    duration: fallback,
    slot: null,
  });
});
