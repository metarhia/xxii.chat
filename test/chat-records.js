'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const load = () => import('../application/static/chat.js');

const lww = (value) => ({ $lww: { value } });

const replica = () => {
  const values = new Map();
  const entities = new Map();
  const assign = (entity, id, fields) => {
    const current = values.get(id) ?? {};
    const next = { ...current, ...fields };
    values.set(id, next);
    const ids = entities.get(entity) ?? [];
    if (!ids.includes(id)) ids.push(id);
    entities.set(entity, ids);
    return next;
  };
  const keys = (entity) => {
    const ids = entities.get(entity);
    return ids === undefined ? [] : ids.slice();
  };
  const get = (id) => values.get(id) ?? null;
  return { assign, keys, get };
};

test('validate accepts a call delta and rejects a bad peak', async () => {
  const { validate } = await load();
  const data = {
    chat: lww('room'),
    host: lww('ada'),
    nick: lww('Ada'),
    timestamp: lww(10),
  };
  assert.equal(validate({ entity: 'call', data }), true);
  const peak = lww('many');
  const invalid = { entity: 'call', data: { ...data, peak } };
  assert.equal(validate(invalid), false);
});

test('threadsOf places a call by time and feeds stay posts', async () => {
  const { startCall, createMessage, createPost, threadsOf } = await load();
  const store = replica();
  createMessage(store, {
    id: 'm1',
    chat: 'room',
    author: 'bob',
    nick: 'Bob',
    content: 'before',
    timestamp: 10,
  });
  startCall(store, {
    id: 'c1',
    chat: 'room',
    host: 'ada',
    nick: 'Ada',
    title: 'Standup',
    timestamp: 20,
  });
  createMessage(store, {
    id: 'm2',
    chat: 'room',
    author: 'bob',
    nick: 'Bob',
    content: 'after',
    timestamp: 30,
  });
  startCall(store, {
    id: 'c-other',
    chat: 'lobby',
    host: 'ada',
    nick: 'Ada',
    timestamp: 15,
  });
  store.assign('call', 'c-text', {
    chat: 'room',
    host: 'ada',
    nick: 'Ada',
    timestamp: '25',
  });
  const thread = threadsOf(store, 'room');
  const call = {
    id: 'c1',
    kind: 'call',
    chat: 'room',
    host: 'ada',
    nick: 'Ada',
    title: 'Standup',
    timestamp: 20,
  };
  assert.deepEqual(thread.items, [
    {
      id: 'm1',
      chat: 'room',
      author: 'bob',
      nick: 'Bob',
      content: 'before',
      timestamp: 10,
    },
    call,
    {
      id: 'm2',
      chat: 'room',
      author: 'bob',
      nick: 'Bob',
      content: 'after',
      timestamp: 30,
    },
  ]);
  assert.deepEqual(thread.records.get('c1'), call);
  assert.equal(thread.replies.has('c1'), false);

  const feed = replica();
  feed.assign('feed', 'news', { name: 'News' });
  createPost(feed, {
    id: 'p1',
    feed: 'news',
    author: 'ada',
    nick: 'Ada',
    title: 'Hello',
    content: 'body',
    timestamp: 5,
  });
  startCall(feed, {
    id: 'c1',
    chat: 'news',
    host: 'ada',
    nick: 'Ada',
    timestamp: 6,
  });
  const posts = threadsOf(feed, 'news');
  assert.deepEqual(
    posts.items.map((item) => item.id),
    ['p1'],
  );
  assert.equal(posts.records.has('c1'), false);
});

test('endCall sets ended, peak, and clips names', async () => {
  const { startCall, endCall, MAX_LENGTH } = await load();
  const store = replica();
  startCall(store, {
    id: 'c1',
    chat: 'room',
    host: 'ada',
    nick: 'Ada',
    timestamp: 10,
  });
  const names = 'n'.repeat(MAX_LENGTH + 24);
  endCall(store, 'c1', { ended: 80, peak: 4, names });
  const record = store.get('c1');
  assert.equal(record.ended, 80);
  assert.equal(record.peak, 4);
  assert.equal(record.names, names.slice(0, MAX_LENGTH));
  assert.equal(record.chat, 'room');
});

test('unreadOf counts a call hosted by someone else', async () => {
  const { startCall, unreadOf } = await load();
  const store = replica();
  const readAt = () => 100;
  startCall(store, {
    id: 'c-old',
    chat: 'room',
    host: 'bob',
    nick: 'Bob',
    timestamp: 90,
  });
  startCall(store, {
    id: 'c-bob',
    chat: 'room',
    host: 'bob',
    nick: 'Bob',
    timestamp: 150,
  });
  startCall(store, {
    id: 'c-ada',
    chat: 'room',
    host: 'ada',
    nick: 'Ada',
    timestamp: 160,
  });
  const unread = unreadOf(store, 'ada', readAt);
  assert.equal(unread.get('room'), 1);
});

test('activityOf uses the call timestamp', async () => {
  const { startCall, createMessage, activityOf } = await load();
  const store = replica();
  createMessage(store, {
    id: 'm1',
    chat: 'room',
    author: 'bob',
    nick: 'Bob',
    content: 'hi',
    timestamp: 10,
  });
  startCall(store, {
    id: 'c1',
    chat: 'room',
    host: 'ada',
    nick: 'Ada',
    timestamp: 40,
  });
  createMessage(store, {
    id: 'm2',
    chat: 'lobby',
    author: 'bob',
    nick: 'Bob',
    content: 'yo',
    timestamp: 70,
  });
  const activity = activityOf(store);
  assert.equal(activity.get('room'), 40);
  assert.equal(activity.get('lobby'), 70);
});

test('validate accepts quote only with replyTo, 300 chars', async () => {
  const { validate, createMessage } = await load();
  const base = {
    chat: lww('room'),
    author: lww('ada'),
    nick: lww('Ada'),
    content: lww('hi'),
    timestamp: lww(10),
  };
  const check = (data) => validate({ entity: 'message', data });
  const replyTo = lww('m1');
  assert.equal(check({ ...base, replyTo, quote: lww('part') }), true);
  assert.equal(check({ ...base, quote: lww('part') }), false);
  assert.equal(check({ ...base, replyTo, quote: lww('x'.repeat(300)) }), true);
  assert.equal(check({ ...base, replyTo, quote: lww('x'.repeat(301)) }), false);
  assert.equal(check({ ...base, replyTo }), true);
  const store = replica();
  const message = { id: 'm2', chat: 'room', author: 'a', nick: 'A' };
  const fields = { ...message, content: 'x', timestamp: 1, replyTo: 'm1' };
  createMessage(store, fields);
  assert.equal(Object.hasOwn(store.get('m2'), 'quote'), false);
  createMessage(store, { ...fields, id: 'm3', quote: 'part' });
  assert.equal(store.get('m3').quote, 'part');
  createMessage(store, { ...fields, id: 'm4', replyTo: '', quote: 'part' });
  assert.equal(Object.hasOwn(store.get('m4'), 'quote'), false);
});

test('validate accepts recording deltas and rejects bad fields', async () => {
  const { validate } = await load();
  const data = {
    chat: lww('room'),
    call: lww('call-1'),
    author: lww('ada'),
    nick: lww('Ada'),
    timestamp: lww(10),
  };
  assert.equal(validate({ entity: 'recording', data }), true);
  const stopped = { stopped: lww(20) };
  assert.equal(validate({ entity: 'recording', data: stopped }), true);
  const bad = { ...data, stopped: lww('late') };
  assert.equal(validate({ entity: 'recording', data: bad }), false);
  const unknown = { ...data, size: lww(5) };
  assert.equal(validate({ entity: 'recording', data: unknown }), false);
});

test('a recording shows in the timeline from start to stop', async () => {
  const { startRecording, stopRecording, startCall, threadsOf } = await load();
  const { createMessage, unreadOf, activityOf } = await load();
  const store = replica();
  createMessage(store, {
    id: 'm1',
    chat: 'room',
    author: 'bob',
    nick: 'Bob',
    content: 'before',
    timestamp: 10,
  });
  startCall(store, {
    id: 'c1',
    chat: 'room',
    host: 'bob',
    nick: 'Bob',
    timestamp: 15,
  });
  const record = {
    id: 'r1',
    chat: 'room',
    call: 'c1',
    author: 'ada',
    nick: 'Ada',
    timestamp: 20,
  };
  startRecording(store, record);
  startRecording(store, { ...record, id: 'r-other', chat: 'lobby' });
  const open = threadsOf(store, 'room');
  const found = open.items.find((item) => item.id === 'r1');
  assert.deepEqual(found, { ...record, kind: 'recording' });
  assert.deepEqual(
    open.items.map((item) => item.id),
    ['m1', 'c1', 'r1'],
  );
  assert.equal(open.replies.has('r1'), false);
  stopRecording(store, 'r1', { stopped: 90 });
  const closed = threadsOf(store, 'room').records.get('r1');
  assert.equal(closed.stopped, 90);
  assert.equal(closed.nick, 'Ada');
  const readAt = () => 5;
  assert.equal(unreadOf(store, 'ada', readAt).get('room'), 2);
  assert.equal(unreadOf(store, 'bob', readAt).get('room'), 1);
  assert.equal(unreadOf(store, 'bob', () => 50).get('room'), undefined);
  assert.equal(activityOf(store).get('room'), 20);
  assert.equal(activityOf(store).get('lobby'), 20);
  store.assign('recording', 'r-text', { chat: 'room', timestamp: '25' });
  assert.equal(threadsOf(store, 'room').records.has('r-text'), false);
});

test('feeds have no recordings', async () => {
  const { startRecording, threadsOf } = await load();
  const store = replica();
  store.assign('feed', 'news', { name: 'News' });
  startRecording(store, {
    id: 'r1',
    chat: 'news',
    call: 'c1',
    author: 'ada',
    nick: 'Ada',
    timestamp: 20,
  });
  assert.equal(threadsOf(store, 'news').items.length, 0);
});
