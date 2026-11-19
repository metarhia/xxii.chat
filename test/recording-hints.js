'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const loadCall = () => import('../application/static/call.js');
const loadRecord = () => import('../application/static/call-record.js');

const flush = () => new Promise((resolve) => setImmediate(resolve));

const createSession = async () => {
  const { CallSession } = await loadCall();
  const channel = {
    readyState: 'open',
    sent: [],
    send(text) {
      this.sent.push(JSON.parse(text));
    },
  };
  const sender = {
    track: { getSettings: () => ({ width: 1280, height: 720 }) },
    getParameters: () => ({ encodings: [{ rid: 'main' }] }),
    async setParameters() {},
  };
  const connection = {
    sender: () => sender,
    receiver: () => ({ track: { enabled: true } }),
    async setTrack() {},
    async open() {
      return channel;
    },
    close() {},
    on() {},
    off() {},
  };
  const api = { call: { on() {}, leave() {}, ping() {} } };
  const session = new CallSession({
    api,
    call: 'room',
    endpoint: 'ada',
    pagehide: false,
    ice: async () => ({}),
    connection: () => connection,
  });
  session.receive('state', {
    call: 'room',
    version: 1,
    participants: [
      { endpoint: 'ada', joined: 1 },
      { endpoint: 'bob', joined: 2 },
    ],
  });
  await flush();
  channel.sent.length = 0;
  return { session, channel };
};

const hint = (width, height, fps, slot = 'camera') => ({
  slot,
  width,
  height,
  fps,
});

const lastOf = (channel) => {
  const { type, slot, width, height, fps } = channel.sent.at(-1);
  return { type, slot, width, height, fps };
};

test('a recorder hint wins over a hidden view', async (t) => {
  const { session, channel } = await createSession();
  t.after(() => session.leave());
  session.setViewHint('bob', hint(300, 200, 30));
  assert.deepEqual(lastOf(channel), { type: 'hint', ...hint(300, 200, 30) });
  session.setViewHint('bob', hint(960, 540, 30), 'recorder');
  assert.deepEqual(lastOf(channel), { type: 'hint', ...hint(960, 540, 30) });
  session.setViewHint('bob', hint(0, 0, 0));
  assert.deepEqual(lastOf(channel), { type: 'hint', ...hint(960, 540, 30) });
  session.setViewHint('bob', hint(1280, 720, 30));
  assert.deepEqual(lastOf(channel), { type: 'hint', ...hint(1280, 720, 30) });
  session.setViewHint('bob', hint(0, 0, 0));
  session.releaseViewHints('recorder');
  assert.deepEqual(lastOf(channel), { type: 'hint', ...hint(0, 0, 0) });
  session.setViewHint('bob', hint(640, 360, 15));
  assert.deepEqual(lastOf(channel), { type: 'hint', ...hint(640, 360, 15) });
});

test('hints merge per slot and per endpoint', async (t) => {
  const { session, channel } = await createSession();
  t.after(() => session.leave());
  session.setViewHint('bob', hint(100, 100, 10, 'screen'));
  session.setViewHint('bob', hint(400, 300, 20, 'camera'), 'recorder');
  session.setViewHint('bob', hint(200, 500, 30, 'camera'));
  assert.deepEqual(lastOf(channel), {
    type: 'hint',
    ...hint(400, 500, 30, 'camera'),
  });
  const screen = channel.sent.filter((message) => message.slot === 'screen');
  assert.equal(screen.length, 1);
  assert.equal(screen[0].width, 100);
  session.releaseViewHints('recorder');
  assert.deepEqual(lastOf(channel), {
    type: 'hint',
    ...hint(200, 500, 30, 'camera'),
  });
  const count = channel.sent.length;
  session.releaseViewHints('nobody');
  assert.equal(channel.sent.length, count);
});

test('only the recorder owner is released, bad hints stay out', async (t) => {
  const { session, channel } = await createSession();
  t.after(() => session.leave());
  session.setViewHint('bob', hint(500, 400, 30), 'recorder');
  session.setViewHint('bob', { slot: 'camera', width: 'x', height: 1, fps: 1 });
  assert.equal(channel.sent.length, 1);
  session.releaseViewHints('recorder');
  assert.equal(channel.sent.length, 1);
});

test('program tiles become hints sized in 40 pixel steps', async () => {
  const { hintOf, demandsOf } = await loadRecord();
  const tile = (id, width, height, placeholder = '') => ({
    id,
    width,
    height,
    placeholder,
  });
  assert.deepEqual(hintOf(tile('bob:1/camera', 944.4, 531.2), 'ada:1'), {
    endpoint: 'bob:1',
    slot: 'camera',
    width: 960,
    height: 560,
    fps: 30,
  });
  assert.deepEqual(hintOf(tile('bob:1/screen', 1280, 720), 'ada:1'), {
    endpoint: 'bob:1',
    slot: 'screen',
    width: 1280,
    height: 720,
    fps: 30,
  });
  assert.equal(hintOf(tile('ada:1/camera', 500, 300), 'ada:1'), null);
  assert.equal(hintOf(tile('bob:1/mic', 500, 300), 'ada:1'), null);
  const opted = hintOf(tile('bob:1/camera', 500, 300, 'opted out'), 'ada:1');
  assert.deepEqual([opted.width, opted.height, opted.fps], [0, 0, 0]);
  const avatar = hintOf(tile('bob:1/camera', 500, 300, 'avatar'), 'ada:1');
  assert.equal(avatar.fps, 0);
  const tiles = [
    tile('ada:1/camera', 960, 540),
    tile('bob:1/camera', 960, 540),
    tile('kim:2/camera', 400, 225, 'avatar'),
  ];
  const demands = demandsOf(tiles, 'ada:1');
  assert.deepEqual(Array.from(demands.keys()), [
    'bob:1\ncamera',
    'kim:2\ncamera',
  ]);
});

test('time and size read as clock and bytes', async () => {
  const { timeText, sizeText } = await loadRecord();
  assert.equal(timeText(0), '00:00');
  assert.equal(timeText(999), '00:00');
  assert.equal(timeText(65000), '01:05');
  assert.equal(timeText(3600000 + 61000), '1:01:01');
  assert.equal(timeText(-5), '00:00');
  assert.equal(sizeText(0), '0 B');
  assert.equal(sizeText(1023), '1023 B');
  assert.equal(sizeText(2048), '2 KB');
  assert.equal(sizeText(3.4 * 1024 * 1024), '3.4 MB');
  assert.equal(sizeText(2.5 * 1024 ** 3), '2.5 GB');
});
