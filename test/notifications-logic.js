'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const settings = import('../application/static/app-settings.js');
const notice = import('../application/static/message-notice.js');
const worker = import('../application/static/notifications.js');

const ME = 'p-me';
const OTHER = 'p-alex';
const PAIR = `${ME}_${OTHER}`;
const ON = { notifyDirect: true, notifyReplies: true, notifyText: true };
const names = { nick: (peer) => `nick-${peer}`, chat: (chat) => `!${chat}` };

const input = (record, extra = {}) => ({
  id: 'm1',
  record: { author: OTHER, nick: 'alex', timestamp: 1, ...record },
  parent: null,
  me: ME,
  settings: ON,
  names,
  ...extra,
});

test('ring volume maps linearly to the peak gain', async () => {
  const { ringGainOf } = await settings;
  assert.equal(ringGainOf(0), 0);
  assert.equal(ringGainOf(50), 0.05);
  assert.equal(ringGainOf(100), 0.1);
  assert.equal(ringGainOf(250), 0.1);
  assert.equal(ringGainOf(-5), 0);
  assert.equal(ringGainOf('loud'), 0.05);
  assert.equal(ringGainOf(NaN), 0.05);
});

test('a direct message is titled with the nick', async () => {
  const { noticeOf } = await notice;
  const record = { chat: PAIR, content: 'hello **there**' };
  const result = noticeOf(input(record));
  assert.deepEqual(result, {
    type: 'xxii:notify',
    title: 'alex',
    body: 'hello there',
    tag: 'message:m1',
    chat: PAIR,
    message: 'm1',
  });
});

test('a hidden chat sends no notice', async () => {
  const { noticeOf } = await notice;
  const record = { chat: PAIR, content: 'hello' };
  const isHidden = (chat) => chat === PAIR;
  assert.equal(noticeOf(input(record, { isHidden })), null);
  const returning = (chat, item) => chat === PAIR && item.timestamp <= 0;
  assert.equal(noticeOf(input(record, { isHidden: returning })).chat, PAIR);
  const seen = [];
  const spy = (chat, item) => seen.push([chat, item.content]);
  noticeOf(input(record, { isHidden: spy }));
  assert.deepEqual(seen, [[PAIR, 'hello']]);
  const other = (chat) => chat === 'elsewhere';
  assert.equal(noticeOf(input(record, { isHidden: other })).chat, PAIR);
});

test('a reply in a group names the chat', async () => {
  const { noticeOf } = await notice;
  const record = { chat: 'general', replyTo: 'm0', content: 'agreed' };
  const parent = { author: ME, chat: 'general' };
  const result = noticeOf(input(record, { parent }));
  assert.equal(result.title, 'alex replied in !general');
  assert.equal(result.body, 'agreed');
  assert.equal(result.chat, 'general');
});

test('a post reply uses the feed label', async () => {
  const { noticeOf } = await notice;
  const record = { feed: 'news', replyTo: 'm0', content: 'nice' };
  const parent = { author: ME, feed: 'news' };
  const result = noticeOf(input(record, { parent }));
  assert.equal(result.title, 'alex replied in !news');
});

test('notifyText off hides the text', async () => {
  const { noticeOf } = await notice;
  const record = { chat: PAIR, content: 'secret plan' };
  const off = { ...ON, notifyText: false };
  const result = noticeOf(input(record, { settings: off }));
  assert.equal(result.body, 'New message');
});

test('the body is cut at 100 characters of plain text', async () => {
  const { noticeOf, bodyOf } = await notice;
  const long = 'x'.repeat(250);
  const result = noticeOf(input({ chat: PAIR, content: long }));
  assert.equal(result.body, 'x'.repeat(100));
  assert.equal(
    bodyOf('# Title\n\n**bold** [link](https://a.b)', true).includes('*'),
    false,
  );
  assert.equal(bodyOf('', true), 'New message');
  assert.equal(bodyOf('   ', true), 'New message');
  assert.equal(bodyOf(undefined, true), 'New message');
});

test('settings and authors decide whether to notify', async () => {
  const { noticeOf } = await notice;
  const direct = { chat: PAIR, content: 'hi' };
  const reply = { chat: 'general', replyTo: 'm0', content: 'hi' };
  const parent = { author: ME };
  const plain = { chat: 'general', content: 'hi' };
  const off = { ...ON, notifyDirect: false, notifyReplies: false };
  assert.equal(noticeOf(input(direct, { settings: off })), null);
  assert.equal(noticeOf(input(reply, { parent, settings: off })), null);
  assert.equal(noticeOf(input(plain)), null);
  assert.equal(noticeOf(input(reply, { parent: { author: OTHER } })), null);
  assert.equal(noticeOf(input({ ...direct, author: ME })), null);
  assert.equal(noticeOf(input({ ...direct, deleted: 5 })), null);
  assert.equal(noticeOf(input({ content: 'no chat' })), null);
  const onlyReplies = { ...ON, notifyDirect: false };
  const inDirect = { ...direct, replyTo: 'm0' };
  const result = noticeOf(input(inDirect, { parent, settings: onlyReplies }));
  assert.equal(result.title, 'alex');
});

test('the nick falls back to the contact list', async () => {
  const { noticeOf } = await notice;
  const record = { chat: PAIR, nick: '', content: 'hi' };
  assert.equal(noticeOf(input(record)).title, `nick-${OTHER}`);
});

const createReplica = (records) => {
  const listeners = new Map();
  return {
    on: (name, listener) => listeners.set(name, listener),
    emit: (name, event) => listeners.get(name)?.(event),
    get: (id) => records.get(id),
  };
};

const stubGlobals = (t, { hidden = true, posted = [] } = {}) => {
  const values = {
    document: { hidden },
    Notification: { permission: 'granted' },
    localStorage: {
      getItem: () => JSON.stringify({ notifyDirect: true }),
    },
    navigator: {
      serviceWorker: {
        ready: Promise.resolve({
          active: { postMessage: (data) => posted.push(data) },
        }),
      },
    },
  };
  for (const name in values) {
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, name);
    const value = values[name];
    Object.defineProperty(globalThis, name, { configurable: true, value });
    t.after(() => {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else Reflect.deleteProperty(globalThis, name);
    });
  }
  return posted;
};

const flush = () => new Promise((resolve) => setImmediate(resolve));

test('only live messages are posted, once each', async (t) => {
  const posted = stubGlobals(t);
  const { MessageNotices } = await notice;
  const now = Date.now();
  const records = new Map([
    ['old', { author: OTHER, nick: 'alex', chat: PAIR, timestamp: now - 5000 }],
    ['new', { author: OTHER, nick: 'alex', chat: PAIR, timestamp: now + 5 }],
  ]);
  const replica = createReplica(records);
  const notices = new MessageNotices({ me: () => ME, names });
  notices.watch(replica);
  const delta = (target) => ({ entity: 'message', target, data: {} });
  replica.emit('log', { deltas: [delta('old'), delta('new')] });
  replica.emit('log', { deltas: [delta('new')] });
  await flush();
  assert.equal(posted.length, 1);
  assert.equal(posted[0].message, 'new');
  replica.emit('clear');
  records.set('after', { ...records.get('new'), timestamp: now });
  replica.emit('log', { deltas: [delta('after')] });
  await flush();
  assert.equal(posted.length, 1);
});

test('a visible page posts nothing', async (t) => {
  const posted = stubGlobals(t, { hidden: false });
  const { MessageNotices } = await notice;
  const record = { author: OTHER, chat: PAIR, timestamp: Date.now() + 5 };
  const replica = createReplica(new Map([['m', record]]));
  const notices = new MessageNotices({ me: () => ME, names });
  notices.watch(replica);
  const deltas = [{ entity: 'message', target: 'm', data: {} }];
  replica.emit('log', { deltas });
  await flush();
  assert.equal(posted.length, 0);
});

const createScope = ({ visible = false, permission = 'granted' } = {}) => {
  const shown = [];
  const scope = {
    shown,
    Notification: { permission },
    registration: {
      scope: 'http://localhost/',
      showNotification: async (title, options) => {
        shown.push({ title, ...options });
      },
    },
    clients: {
      matchAll: async () => [
        { visibilityState: visible ? 'visible' : 'hidden' },
        { visibilityState: 'hidden' },
      ],
    },
  };
  return scope;
};

const send = async (scope, data) => {
  const { onNotificationMessage } = await worker;
  const waits = [];
  const event = {
    data: { type: 'xxii:notify', ...data },
    source: { id: 'tab-1' },
    waitUntil: (promise) => waits.push(promise),
  };
  onNotificationMessage(scope, event);
  await Promise.all(waits);
};

const data = (message, extra = {}) => ({
  title: 'alex',
  body: 'hi',
  tag: `message:${message}`,
  chat: PAIR,
  message,
  ...extra,
});

test('the worker shows one notification per message', async () => {
  const scope = createScope();
  await send(scope, data('a1'));
  await send(scope, data('a1'));
  assert.equal(scope.shown.length, 1);
  const [first] = scope.shown;
  assert.equal(first.tag, 'message:a1');
  assert.equal(first.body, 'hi');
  assert.deepEqual(first.data, {
    chat: PAIR,
    message: 'a1',
    clientId: 'tab-1',
  });
  await Promise.all([send(scope, data('a2')), send(scope, data('a2'))]);
  assert.equal(scope.shown.length, 2);
});

test('the worker skips visible windows, missing permission, junk', async () => {
  const visible = createScope({ visible: true });
  await send(visible, data('b1'));
  assert.equal(visible.shown.length, 0);
  visible.clients.matchAll = async () => [{ visibilityState: 'hidden' }];
  await send(visible, data('b1'));
  assert.equal(visible.shown.length, 1);
  const denied = createScope({ permission: 'denied' });
  await send(denied, data('b2'));
  assert.equal(denied.shown.length, 0);
  const junk = createScope();
  await send(junk, data('b3', { body: 42 }));
  await send(junk, data('b4', { title: '' }));
  assert.equal(junk.shown.length, 0);
});

test('a click focuses the window and sends the route', async () => {
  const { onNotificationClick } = await worker;
  const messages = [];
  const opened = [];
  let focused = 0;
  const client = {
    id: 'tab-1',
    url: 'http://localhost/',
    focus: async () => focused++,
    postMessage: (message) => messages.push(message),
  };
  const scope = createScope();
  scope.clients.matchAll = async () => [client];
  scope.clients.openWindow = async (url) => opened.push(url);
  const click = async (notification) => {
    const waits = [];
    const event = { notification, waitUntil: (p) => waits.push(p) };
    onNotificationClick(scope, event);
    await Promise.all(waits);
  };
  const closed = [];
  const close = () => closed.push(1);
  const note = {
    close,
    data: { chat: PAIR, message: 'm1', clientId: 'tab-1' },
  };
  await click(note);
  assert.equal(focused, 1);
  assert.deepEqual(messages, [
    { type: 'xxii:open', chat: PAIR, message: 'm1' },
  ]);
  assert.equal(closed.length, 1);
  await click({ close, data: { clientId: 'tab-1' } });
  assert.equal(messages.length, 1);
  scope.clients.matchAll = async () => [];
  await click(note);
  assert.deepEqual(opened, [`/?chat=${PAIR}&message=m1`]);
  await click({ close, data: {} });
  assert.equal(opened[1], '/');
});
