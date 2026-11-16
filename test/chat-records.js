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
