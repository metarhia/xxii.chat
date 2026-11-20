'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { setTimeout: delay } = require('node:timers/promises');

const load = () => import('../application/static/recorder.js');
const loadLayout = () => import('../application/static/layout.js');

const flush = () => new Promise((resolve) => setImmediate(resolve));

const createRecording = (supported, extra) => {
  const created = [];
  class FakeRecording {
    constructor(stream, options) {
      this.stream = stream;
      this.options = options;
      this.state = 'inactive';
      this.listeners = new Map();
      this.slice = 0;
      this.number = created.length + 1;
      created.push(this);
    }

    static isTypeSupported(mime) {
      return supported.includes(mime);
    }

    addEventListener(name, listener) {
      const list = this.listeners.get(name) ?? [];
      list.push(listener);
      this.listeners.set(name, list);
    }

    removeEventListener(name, listener) {
      const list = this.listeners.get(name) ?? [];
      this.listeners.set(
        name,
        list.filter((item) => item !== listener),
      );
    }

    emit(name, event) {
      const list = this.listeners.get(name) ?? [];
      for (const listener of list.slice()) listener(event);
    }

    start(slice) {
      this.slice = slice;
      this.state = 'recording';
      extra.transitions?.push(`start ${this.number}`);
    }

    pause() {
      this.state = 'paused';
    }

    resume() {
      this.state = 'recording';
    }

    stop() {
      this.state = 'inactive';
      extra.transitions?.push(`stop ${this.number}`);
      setImmediate(() => {
        const data = extra.finalChunk?.(this.number);
        if (data) this.emit('dataavailable', { data });
        this.emit('stop', {});
      });
    }
  }
  return { FakeRecording, created };
};

const slowBlob = (text, ms) => ({
  size: text.length,
  arrayBuffer: async () => {
    await delay(ms);
    return new TextEncoder().encode(text).buffer;
  },
});

const createWriter = (extra = {}) => {
  const calls = [];
  const writer = {
    calls,
    async open(recording, meta) {
      calls.push(['open', recording, meta.mime, meta.extension]);
      return { meta };
    },
    async write(recording, chunk, duration) {
      const text = new TextDecoder().decode(chunk);
      calls.push(['write', text, duration]);
      if (extra.failOn === text) throw new Error('disk full');
      return calls.filter((call) => call[0] === 'write').length * 10;
    },
    async pause(recording) {
      calls.push(['pause', recording]);
    },
    async resume(recording) {
      calls.push(['resume', recording]);
    },
    async poster(recording, bytes) {
      calls.push(['poster', recording, bytes.byteLength]);
    },
    async segment(recording, duration) {
      calls.push(['segment', recording, duration]);
      return { id: recording, state: 'recording' };
    },
    async close(recording, duration, people) {
      calls.push(['close', recording, duration, people]);
      return { id: recording, state: 'done', duration, size: 99 };
    },
    async abort(recording, duration) {
      calls.push(['abort', recording, duration]);
      return { id: recording, state: 'interrupted', duration };
    },
  };
  return writer;
};

const posterBlob = { arrayBuffer: async () => new ArrayBuffer(8) };

const createSetup = async (supported, extra = {}) => {
  const { Recorder } = await load();
  const { QUALITIES } = await loadLayout();
  const { FakeRecording, created } = createRecording(supported, extra);
  const writer = createWriter(extra);
  const time = { now: 1000 };
  const canvas = {
    toBlob: (callback) => callback(posterBlob),
  };
  const recorder = new Recorder({
    compositor: { track: 'video-track', canvas },
    mixer: { track: 'audio-track' },
    writer,
    quality: QUALITIES['1080p30'],
    Recording: FakeRecording,
    streamOf: (tracks) => ({ tracks }),
    now: () => time.now,
    folder: extra.folder,
    segmentMs: extra.segmentMs,
  });
  return { recorder, writer, time, created };
};

const info = {
  id: 'r-1',
  title: 'title',
  chat: 'general',
  chatName: '!general',
  call: 'call-1',
  started: 1000,
  options: {},
  people: ['alex'],
};

test('the first supported format wins in list order', async () => {
  const { FORMATS, formatOf } = await load();
  const all = FORMATS.map((format) => format.mime);
  assert.equal(formatOf((mime) => all.includes(mime)).mime, all[0]);
  const withoutAac = all.slice(1);
  const opus = formatOf((mime) => withoutAac.includes(mime));
  assert.equal(opus.mime, 'video/mp4;codecs=avc1.640028,opus');
  assert.equal(opus.extension, 'mp4');
  const webm = formatOf((mime) => mime.startsWith('video/webm'));
  assert.equal(webm.mime, 'video/webm;codecs=vp9,opus');
  assert.equal(webm.extension, 'webm');
  const vp8 = formatOf((mime) => mime.includes('vp8'));
  assert.equal(vp8.mime, 'video/webm;codecs=vp8,opus');
  assert.equal(
    formatOf(() => false),
    null,
  );
  const custom = [{ mime: 'video/webm', extension: 'webm' }];
  assert.equal(formatOf(() => true, custom).mime, 'video/webm');
});

test('formats list MP4 with AAC first, then WebM VP9', async () => {
  const { FORMATS } = await load();
  assert.deepEqual(
    FORMATS.map((format) => format.mime),
    [
      'video/mp4;codecs=avc1.640028,mp4a.40.2',
      'video/mp4;codecs=avc1.640028,opus',
      'video/webm;codecs=vp9,opus',
      'video/webm;codecs=vp8,opus',
    ],
  );
});

test('recorder options take the bitrate from the quality', async () => {
  const { optionsOf, FORMATS } = await load();
  const { QUALITIES } = await loadLayout();
  const options = optionsOf(FORMATS[1], QUALITIES['720p30']);
  assert.equal(options.mimeType, FORMATS[1].mime);
  assert.equal(options.videoBitsPerSecond, 3000000);
  assert.equal(options.audioBitsPerSecond, 128000);
  assert.equal(options.videoKeyFrameIntervalDuration, 2000);
  const hd = optionsOf(FORMATS[2], QUALITIES['1080p60']);
  assert.equal(hd.videoBitsPerSecond, 9000000);
});

test('chunks reach the writer in order when they resolve late', async () => {
  const { ChunkQueue } = await load();
  const sent = [];
  const queue = new ChunkQueue(
    async (chunk, duration) => {
      sent.push([new TextDecoder().decode(chunk), duration]);
    },
    () => assert.fail('no error expected'),
  );
  queue.push(slowBlob('a', 30), 1);
  queue.push(slowBlob('b', 1), 2);
  queue.push(slowBlob('c', 10), 3);
  await queue.drain();
  assert.deepEqual(sent, [
    ['a', 1],
    ['b', 2],
    ['c', 3],
  ]);
});

test('a failed chunk stops the queue and reports once', async () => {
  const { ChunkQueue } = await load();
  const sent = [];
  const errors = [];
  const queue = new ChunkQueue(
    async (chunk) => {
      const text = new TextDecoder().decode(chunk);
      if (text === 'b') throw new Error('quota');
      sent.push(text);
    },
    (error) => errors.push(error.message),
  );
  for (const text of ['a', 'b', 'c', 'd']) queue.push(slowBlob(text, 1), 0);
  await queue.drain();
  assert.deepEqual(sent, ['a']);
  assert.deepEqual(errors, ['quota']);
  assert.equal(queue.error.message, 'quota');
});

test('recorder starts, records in order, and stops with a flush', async () => {
  const { recorder, writer, time, created } = await createSetup([
    'video/mp4;codecs=avc1.640028,opus',
    'video/webm;codecs=vp9,opus',
  ]);
  const states = [];
  const progress = [];
  recorder.on('state', (state) => states.push(state));
  recorder.on('progress', (value) => progress.push(value.size));
  const meta = await recorder.start(info);
  assert.equal(meta.mime, 'video/mp4;codecs=avc1.640028,opus');
  assert.equal(meta.extension, 'mp4');
  assert.equal(meta.state, 'recording');
  assert.equal(recorder.format.extension, 'mp4');
  const source = created[0];
  assert.equal(source.slice, 1000);
  assert.deepEqual(source.stream.tracks, ['video-track', 'audio-track']);
  assert.equal(source.options.videoBitsPerSecond, 6000000);
  time.now = 2000;
  source.emit('dataavailable', { data: slowBlob('one', 20) });
  time.now = 3000;
  source.emit('dataavailable', { data: slowBlob('two', 1) });
  source.emit('dataavailable', { data: slowBlob('', 0) });
  assert.equal(recorder.activeMs, 2000);
  time.now = 3500;
  const stopped = recorder.stop({ people: ['alex', 'bob'] });
  const again = recorder.stop();
  const result = await stopped;
  assert.equal(await again, result);
  assert.equal(result.state, 'done');
  assert.equal(recorder.state, 'stopped');
  const kinds = writer.calls.map((call) => call[0]);
  assert.deepEqual(kinds, ['open', 'write', 'write', 'poster', 'close']);
  assert.deepEqual(writer.calls[1], ['write', 'one', 1000]);
  assert.deepEqual(writer.calls[2], ['write', 'two', 2000]);
  assert.deepEqual(writer.calls[4], ['close', 'r-1', 2500, ['alex', 'bob']]);
  assert.deepEqual(progress, [10, 20]);
  assert.deepEqual(states, ['recording', 'stopped']);
  assert.equal(recorder.size, 20);
  assert.equal(source.listeners.get('dataavailable').length, 0);
});

test('pause stops the clock and resume continues it', async () => {
  const { recorder, writer, time, created } = await createSetup([
    'video/webm;codecs=vp9,opus',
  ]);
  const meta = await recorder.start({ ...info, id: 'r-2' });
  assert.equal(meta.extension, 'webm');
  time.now = 3000;
  recorder.pause();
  assert.equal(recorder.state, 'paused');
  assert.equal(created[0].state, 'paused');
  time.now = 9000;
  assert.equal(recorder.activeMs, 2000);
  recorder.pause();
  recorder.resume();
  assert.equal(recorder.state, 'recording');
  assert.equal(created[0].state, 'recording');
  time.now = 10000;
  assert.equal(recorder.activeMs, 3000);
  recorder.resume();
  await recorder.stop();
  await flush();
  const close = writer.calls.find((call) => call[0] === 'close');
  assert.equal(close[2], 3000);
  const kinds = writer.calls.map((call) => call[0]);
  assert.deepEqual(kinds.slice(0, 3), ['open', 'pause', 'resume']);
});

test('a paused recording can stop and counts only recorded time', async () => {
  const { recorder, writer, time } = await createSetup([
    'video/webm;codecs=vp8,opus',
  ]);
  await recorder.start({ ...info, id: 'r-3' });
  time.now = 2500;
  recorder.pause();
  time.now = 8000;
  await recorder.stop();
  const close = writer.calls.find((call) => call[0] === 'close');
  assert.equal(close[2], 1500);
});

test('rollover counts active time and drains the old part first', async () => {
  const transitions = [];
  const extra = {
    transitions,
    folder: { name: 'videos' },
    segmentMs: 3000,
    finalChunk: (number) => slowBlob(`end ${number}`, 1),
  };
  const { recorder, writer, time, created } = await createSetup(
    ['video/webm;codecs=vp8,opus'],
    extra,
  );
  await recorder.start(info);
  time.now = 3000;
  recorder.pause();
  time.now = 10000;
  created[0].emit('dataavailable', { data: slowBlob('first', 10) });
  assert.equal(created.length, 1);
  recorder.resume();
  time.now = 10999;
  created[0].emit('dataavailable', { data: slowBlob('old', 10) });
  assert.equal(created.length, 1);
  time.now = 11000;
  created[0].emit('dataavailable', { data: slowBlob('boundary', 10) });
  assert.deepEqual(transitions, ['start 1', 'start 2', 'stop 1']);
  assert.equal(created[0].stream, created[1].stream);
  time.now = 12000;
  created[1].emit('dataavailable', { data: slowBlob('next', 1) });
  await recorder.stop();
  const writes = writer.calls.filter((call) =>
    ['segment', 'write', 'close'].includes(call[0]),
  );
  assert.deepEqual(writes, [
    ['write', 'first', 2000],
    ['write', 'old', 2999],
    ['write', 'boundary', 3000],
    ['write', 'end 1', 3000],
    ['segment', info.id, 3000],
    ['write', 'next', 4000],
    ['write', 'end 2', 4000],
    ['close', info.id, 4000, undefined],
  ]);
});

test('a folder write failure keeps an earlier closed part', async () => {
  const extra = {
    folder: { name: 'videos' },
    segmentMs: 3000,
    failOn: 'bad',
  };
  const { recorder, writer, created, time } = await createSetup(
    ['video/webm;codecs=vp8,opus'],
    extra,
  );
  await recorder.start(info);
  time.now = 4000;
  created[0].emit('dataavailable', { data: slowBlob('closed', 1) });
  time.now = 5000;
  created[1].emit('dataavailable', { data: slowBlob('bad', 1) });
  await recorder.stop();
  const stages = writer.calls.map((call) => call[0]);
  assert.deepEqual(stages, [
    'open',
    'write',
    'segment',
    'write',
    'poster',
    'abort',
  ]);
  assert.equal(recorder.meta.state, 'interrupted');
});

test('a writer failure aborts the recording and reports it', async () => {
  const { recorder, writer, created } = await createSetup(
    ['video/webm;codecs=vp9,opus'],
    { failOn: 'bad' },
  );
  const failures = [];
  recorder.on('failure', (error) => failures.push(error.message));
  await recorder.start({ ...info, id: 'r-4' });
  created[0].emit('dataavailable', { data: slowBlob('ok', 1) });
  created[0].emit('dataavailable', { data: slowBlob('bad', 1) });
  created[0].emit('dataavailable', { data: slowBlob('late', 1) });
  for (let attempt = 0; attempt < 50; attempt++) {
    if (recorder.state === 'stopped') break;
    await delay(10);
  }
  assert.equal(recorder.state, 'stopped');
  assert.deepEqual(failures, ['disk full']);
  const kinds = writer.calls.map((call) => call[0]);
  assert.equal(kinds.includes('abort'), true);
  assert.equal(kinds.includes('close'), false);
  const writes = writer.calls.filter((call) => call[0] === 'write');
  assert.deepEqual(
    writes.map((call) => call[1]),
    ['ok', 'bad'],
  );
  assert.equal(recorder.meta.state, 'interrupted');
});

test('recorder refuses to start without a supported format', async () => {
  const { recorder, writer } = await createSetup([]);
  await assert.rejects(recorder.start(info), /cannot record/);
  assert.equal(recorder.state, 'idle');
  assert.equal(writer.calls.length, 0);
  assert.equal(await recorder.stop(), null);
});

test('recorder ignores pause before start and a second start', async () => {
  const { recorder, writer, created } = await createSetup([
    'video/webm;codecs=vp9,opus',
  ]);
  recorder.pause();
  recorder.resume();
  assert.equal(recorder.state, 'idle');
  const first = await recorder.start(info);
  const second = await recorder.start(info);
  assert.equal(second, first);
  assert.equal(created.length, 1);
  assert.equal(writer.calls.filter((call) => call[0] === 'open').length, 1);
  await recorder.stop();
});
