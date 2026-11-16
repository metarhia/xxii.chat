'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

let sequence = 0;

const load = () => {
  const url = '../application/static/notifications.js';
  return import(`${url}?test=${sequence++}`);
};

const stub = (t, name, value) => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, name);
  Object.defineProperty(globalThis, name, { configurable: true, value });
  t.after(() => {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else Reflect.deleteProperty(globalThis, name);
  });
};

test('permission is synchronous, once, and never waits', async (t) => {
  let count = 0;
  const pending = new Promise(() => {});
  const Notification = {
    permission: 'default',
    requestPermission() {
      count++;
      return pending;
    },
  };
  stub(t, 'Notification', Notification);
  stub(t, 'navigator', { userActivation: { isActive: false } });
  const { requestCallNotifications } = await load();
  assert.equal(count, 0);
  requestCallNotifications();
  assert.equal(count, 0);
  navigator.userActivation.isActive = true;
  assert.equal(requestCallNotifications(), undefined);
  assert.equal(count, 1);
  requestCallNotifications();
  assert.equal(count, 1);
});

for (const permission of ['granted', 'denied']) {
  test(`permission ${permission} is never requested`, async (t) => {
    stub(t, 'Notification', {
      permission,
      requestPermission: assert.fail,
    });
    const { requestCallNotifications } = await load();
    requestCallNotifications();
  });
}

test('missing notification API is harmless', async (t) => {
  stub(t, 'Notification', undefined);
  const { requestCallNotifications } = await load();
  assert.doesNotThrow(requestCallNotifications);
});

for (const failure of ['throw', 'reject']) {
  test(`permission ${failure} is handled once`, async (t) => {
    let count = 0;
    stub(t, 'Notification', {
      permission: 'default',
      requestPermission() {
        count++;
        const error = new Error('unsupported');
        if (failure === 'throw') throw error;
        return Promise.reject(error);
      },
    });
    stub(t, 'navigator', { userActivation: { isActive: true } });
    const { requestCallNotifications } = await load();
    assert.doesNotThrow(requestCallNotifications);
    assert.doesNotThrow(requestCallNotifications);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(count, 1);
  });
}

const createWorker = () => {
  const shown = [];
  const focused = [];
  const opened = [];
  const worker = {
    registration: {
      scope: 'https://chat.example/app/',
      async showNotification(title, options) {
        shown.push({ title, options });
        if (options.renotify) throw new Error('renotify unsupported');
      },
    },
    clients: {
      async matchAll(options) {
        assert.deepEqual(options, {
          type: 'window',
          includeUncontrolled: true,
        });
        return worker.windows;
      },
      async openWindow(url) {
        opened.push(url);
      },
    },
    windows: [],
  };
  const client = (id, url) => ({
    id,
    url,
    async focus() {
      focused.push(id);
    },
  });
  return { worker, shown, focused, opened, client };
};

test('worker replies with the sending client identity', async () => {
  const { onNotificationMessage } = await load();
  const replies = [];
  onNotificationMessage(
    {},
    {
      data: { type: 'xxii:client' },
      source: { id: 'ring-tab' },
      ports: [{ postMessage: (id) => replies.push(id) }],
    },
  );
  assert.deepEqual(replies, ['ring-tab']);
});

test('page gets source identity over a transferred port', async () => {
  const { notificationClient, onNotificationMessage } = await load();
  const worker = {
    postMessage(data, ports) {
      onNotificationMessage(
        {},
        {
          data,
          ports,
          source: { id: 'ring-tab' },
        },
      );
    },
  };
  assert.equal(await notificationClient(worker), 'ring-tab');
});

for (const failPage of [false, true]) {
  test(`page ring keeps origin identity, fallback=${failPage}`, async (t) => {
    const { onNotificationMessage } = await load();
    const shown = [];
    const posted = [];
    const active = {
      postMessage(data, ports) {
        if (data.type === 'xxii:ring') {
          posted.push(data);
        } else {
          onNotificationMessage(
            {},
            {
              data,
              ports,
              source: { id: 'ring-tab' },
            },
          );
        }
      },
    };
    const registration = {
      active,
      async showNotification(title, options) {
        shown.push({ title, options });
        const fail = failPage || options.renotify;
        if (fail) throw new Error('unsupported');
      },
    };
    const Notification = () => undefined;
    Notification.permission = 'granted';
    stub(t, 'Notification', Notification);
    stub(t, 'navigator', {
      serviceWorker: { ready: Promise.resolve(registration) },
    });
    stub(t, 'document', { hidden: true });
    const { RingAlert } = await import('../application/static/stage.js');
    const ring = new RingAlert({});
    ring.call = 'call';
    ring.tag = 'call:tab';
    ring.nick = 'Ada';
    ring.alert();
    for (let i = 0; i < 10 && shown.length < 2; i++) {
      await new Promise((resolve) => setImmediate(resolve));
    }
    assert.equal(shown.length, 2);
    for (const note of shown) {
      assert.deepEqual(note.options.data, { clientId: 'ring-tab' });
    }
    assert.equal(posted.length, failPage ? 1 : 0);
    if (failPage) {
      assert.deepEqual(posted[0], {
        type: 'xxii:ring',
        title: 'Ada is calling',
        tag: 'call:tab',
      });
    }
  });
}

test('worker fallback keeps source identity in both attempts', async () => {
  const { onNotificationMessage } = await load();
  const { worker, shown } = createWorker();
  let pending = null;
  onNotificationMessage(worker, {
    data: { type: 'xxii:ring', title: 'Ada is calling', tag: 'call:tab' },
    source: { id: 'ring-tab' },
    waitUntil: (task) => {
      pending = task;
    },
  });
  await pending;
  assert.equal(shown.length, 2);
  for (const note of shown) {
    assert.equal(note.title, 'Ada is calling');
    assert.equal(note.options.tag, 'call:tab');
    assert.deepEqual(note.options.data, { clientId: 'ring-tab' });
  }
});

const click = async (worker, clientId) => {
  const { onNotificationClick } = await load();
  let closed = false;
  let pending = null;
  onNotificationClick(worker, {
    notification: {
      data: { clientId },
      close() {
        closed = true;
      },
    },
    waitUntil: (task) => {
      pending = task;
    },
  });
  assert.equal(closed, true);
  await pending;
};

test('notification click prefers the origin tab', async () => {
  const { worker, client, focused, opened } = createWorker();
  worker.windows = [
    client('recent', 'https://chat.example/app/'),
    client('ring-tab', 'https://chat.example/app/?call=1'),
  ];
  await click(worker, 'ring-tab');
  assert.deepEqual(focused, ['ring-tab']);
  assert.deepEqual(opened, []);
});

test('closed origin falls back to the most recent app window', async () => {
  const { worker, client, focused, opened } = createWorker();
  worker.windows = [
    client('other-origin', 'https://other.example/app/'),
    client('other-path', 'https://chat.example/application/'),
    client('invalid', 'invalid'),
    client('recent', 'https://chat.example/app/'),
    client('older', 'https://chat.example/app/room'),
  ];
  await click(worker, 'other-origin');
  assert.deepEqual(focused, ['recent']);
  assert.deepEqual(opened, []);
});

test('notification click opens the app when its windows are gone', async () => {
  const { worker, client, focused, opened } = createWorker();
  worker.windows = [client('elsewhere', 'https://elsewhere.example/app/')];
  await click(worker, 'missing');
  assert.deepEqual(focused, []);
  assert.deepEqual(opened, ['/']);
});
