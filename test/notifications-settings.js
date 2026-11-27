'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { setTimeout: delay } = require('node:timers/promises');

const harness = require('./harness.js');

const { ORIGIN, MEDIA_FLAGS, launch, startCallServer } = harness;

const FLAGS = MEDIA_FLAGS.concat([
  '--disable-features=WebRtcHideLocalIpsWithMdns',
]);
const READY = `return app.connected && navigator.serviceWorker.controller &&
  app.mesh.peers.has(app.peerId);`;
const GENERAL = JSON.stringify('general');
const SETTINGS_KEY = 'xxii:settings';

const SPY = `if (window.__spy) return true;
  const Real = window.AudioContext;
  const spy = { peaks: [], contexts: 0, asked: 0 };
  window.__spy = spy;
  window.AudioContext = class extends Real {
    constructor(...args) {
      super(...args);
      spy.contexts++;
    }
    createGain() {
      const gain = super.createGain();
      const param = gain.gain;
      const ramp = param.exponentialRampToValueAtTime.bind(param);
      param.exponentialRampToValueAtTime = (value, time) => {
        spy.peaks.push(value);
        return ramp(value, time);
      };
      return gain;
    }
  };
  const request = Notification.requestPermission.bind(Notification);
  Notification.requestPermission = (...args) => {
    spy.asked++;
    return request(...args);
  };
  return true;`;

const setPermission = (browser, browserContextId, setting) =>
  browser.request('Browser.setPermission', {
    origin: ORIGIN,
    browserContextId,
    permission: { name: 'notifications' },
    setting,
  });

const createPeer = async (t, browser, options = {}) => {
  const created = await browser.request('Target.createBrowserContext');
  const { browserContextId } = created;
  t.after(() =>
    browser
      .request('Target.disposeBrowserContext', { browserContextId })
      .catch(() => undefined),
  );
  const tabs = [];
  const open = async (url = `${ORIGIN}/`) => {
    const params = { url: 'about:blank', browserContextId };
    const { targetId } = await browser.request('Target.createTarget', params);
    const attach = { targetId, flatten: true };
    const target = await browser.request('Target.attachToTarget', attach);
    const { sessionId } = target;
    await browser.request('Runtime.enable', {}, sessionId);
    await browser.request('Page.enable', {}, sessionId);
    await browser.request('Page.bringToFront', {}, sessionId);
    if (options.phone) {
      const metrics = { width: 390, height: 844, mobile: true };
      await browser.request(
        'Emulation.setDeviceMetricsOverride',
        { deviceScaleFactor: 1, ...metrics },
        sessionId,
      );
    }
    await browser.request('Page.navigate', { url }, sessionId);
    await harness.wait(browser, sessionId, READY, 30000);
    tabs.push(sessionId);
    return sessionId;
  };
  const away = async () => {
    const params = { url: 'about:blank', browserContextId };
    const { targetId } = await browser.request('Target.createTarget', params);
    const attach = { targetId, flatten: true };
    const target = await browser.request('Target.attachToTarget', attach);
    return target.sessionId;
  };
  return { browserContextId, open, away, tabs };
};

const front = async (browser, session) => {
  await browser.request('Page.bringToFront', {}, session);
  await harness.run(browser, session, 'app.render(); return true;');
};

const settingsOf = (browser, session) =>
  harness.run(
    browser,
    session,
    `return JSON.parse(localStorage.getItem(${JSON.stringify(SETTINGS_KEY)})
      || '{}');`,
  );

const switchOf = (name) => `document.querySelector(
  '[data-page="notifications"] [data-notify="${name}"]')`;

const rowText = (name) => `${switchOf(name)}.closest('.row')
  .querySelector('.row-note').textContent`;

test('notification settings', { timeout: 240000 }, async (t) => {
  await startCallServer(t);
  const browser = await launch(t, FLAGS);
  const peer = await createPeer(t, browser);
  const id = peer.browserContextId;
  const session = await peer.open();
  const run = (body) => harness.run(browser, session, body);
  const wait = (body, ms) => harness.wait(browser, session, body, ms);
  const toggle = (name) => run(`${switchOf(name)}.click(); return true;`);
  const status = () =>
    run(`return document.querySelector(
      '[data-group="permission"] .row-value').textContent;`);
  const permissionNote = () =>
    run(`return document.querySelector(
      '[data-group="permission"] .row-note').textContent;`);
  const allow = `document.querySelector(
    '[data-group="permission"] button')`;

  await run(SPY);
  await run(`app.openSettings('notifications'); return true;`);
  await wait(`return app.settings.isOpen &&
    document.querySelector('[data-page="notifications"]').offsetHeight > 0;`);

  await t.test('the section follows Appearance in the list', async () => {
    const order = await run(
      `return [...document.querySelectorAll('.settings-list button')]
        .map((button) => button.dataset.section).slice(0, 4);`,
    );
    assert.deepEqual(order, [
      'profile',
      'appearance',
      'notifications',
      'media',
    ]);
    const title = await run(
      `return document.querySelector('#settings-section-name').textContent;`,
    );
    assert.equal(title, 'Notifications');
  });

  await t.test('the permission row shows every state', async () => {
    await setPermission(browser, id, 'prompt');
    await wait(`return Notification.permission === 'default';`);
    await wait(`return document.querySelector(
      '[data-group="permission"] .row-value').textContent === 'not asked';`);
    assert.equal(await run(`return !${allow}.hidden;`), true);
    await setPermission(browser, id, 'denied');
    await wait(`return document.querySelector(
      '[data-group="permission"] .row-value').textContent === 'blocked';`);
    assert.equal(await run(`return ${allow}.hidden;`), true);
    assert.match(await permissionNote(), /site settings/);
    await setPermission(browser, id, 'granted');
    await wait(`return document.querySelector(
      '[data-group="permission"] .row-value').textContent === 'allowed';`);
    assert.equal(await run(`return ${allow}.hidden;`), true);
    assert.equal(await status(), 'allowed');
    await setPermission(browser, id, 'prompt');
    await wait(`return Notification.permission === 'default';`);
  });

  await t.test('rows that need permission say so', async () => {
    for (const name of ['notifyCalls', 'notifyDirect', 'notifyReplies']) {
      const note = await run(`return ${rowText(name)};`);
      assert.equal(note, 'Needs the browser permission', name);
    }
    const text = await run(`return ${rowText('notifyText')};`);
    assert.notEqual(text, 'Needs the browser permission');
    const ring = await run(`return ${rowText('ring')};`);
    assert.notEqual(ring, 'Needs the browser permission');
    await setPermission(browser, id, 'granted');
    await wait(
      `return ${rowText('notifyDirect')} !== 'Needs the browser permission';`,
    );
    await setPermission(browser, id, 'prompt');
    await wait(
      `return ${rowText('notifyDirect')} === 'Needs the browser permission';`,
    );
  });

  await t.test('turning a row on and allow ask for permission', async () => {
    const asked = () => run('return window.__spy.asked;');
    const before = await asked();
    await toggle('notifyDirect');
    assert.equal(await asked(), before + 1);
    await toggle('notifyText');
    assert.equal(await asked(), before + 1);
    await run(`${allow}.click(); return true;`);
    assert.equal(await asked(), before + 2);
    await setPermission(browser, id, 'prompt');
  });

  await t.test('toggles persist and survive a reload', async () => {
    const saved = await settingsOf(browser, session);
    assert.equal(saved.notifyDirect, true);
    assert.equal(saved.notifyText, false);
    await toggle('notifyReplies');
    await toggle('callToasts');
    await toggle('ring');
    await toggle('notifyCalls');
    const next = await settingsOf(browser, session);
    assert.equal(next.notifyReplies, true);
    assert.equal(next.callToasts, false);
    assert.equal(next.ring, false);
    assert.equal(next.notifyCalls, false);
    await browser.request('Page.reload', {}, session);
    await wait(READY, 30000);
    await run(`app.openSettings('notifications'); return true;`);
    await wait(`return document.querySelector(
      '[data-page="notifications"]').offsetHeight > 0;`);
    const checked = await run(
      `return Object.fromEntries([...document.querySelectorAll(
        '[data-page="notifications"] input[type="checkbox"]')]
        .map((input) => [input.dataset.notify, input.checked]));`,
    );
    assert.deepEqual(checked, {
      ring: false,
      notifyCalls: false,
      notifyDirect: true,
      notifyReplies: true,
      notifyText: false,
      callToasts: false,
    });
    for (const name of Object.keys(checked)) await toggle(name);
    const reset = await settingsOf(browser, session);
    assert.equal(reset.ring, true);
    assert.equal(reset.notifyDirect, false);
    await run(SPY);
  });

  await t.test('test plays one cycle at the volume of the slider', async () => {
    const peak = () =>
      run(`const peaks = window.__spy.peaks;
        window.__spy.peaks = [];
        return Math.max(0, ...peaks);`);
    assert.equal(
      await run(`return Boolean(document.querySelector(
      '[data-page="notifications"] .row-field button'));`),
      true,
    );
    const test = `[...document.querySelectorAll(
      '[data-page="notifications"] button')].find(
      (button) => button.textContent === 'test')`;
    await run(`${test}.click(); return true;`);
    await wait(`return window.__spy.peaks.length > 0;`);
    assert.equal(await peak(), 0.05);
    const slide = (value) =>
      run(`const input = ${switchOf('ringVolume')};
        input.value = '${value}';
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.dispatchEvent(new Event('change', { bubbles: true }));
        return true;`);
    await slide(100);
    assert.equal((await settingsOf(browser, session)).ringVolume, 100);
    await delay(600);
    await run(`${test}.click(); return true;`);
    await wait(`return window.__spy.peaks.length > 0;`);
    assert.equal(await peak(), 0.1);
    await slide(0);
    await delay(600);
    const contexts = await run('return window.__spy.contexts;');
    await run(`${test}.click(); return true;`);
    await delay(300);
    assert.equal(await run('return window.__spy.contexts;'), contexts);
    await slide(50);
  });

  await t.test('an incoming call rings at the saved volume', async () => {
    const ring = `app.ring.show({ call: 'c1', chat: 'x', nick: 'kim',
      tab: 't' }); return true;`;
    const stop = `app.ring.stop(); return true;`;
    const settle = () => delay(400);
    const lastPeak = () =>
      run(`const peaks = window.__spy.peaks;
        window.__spy.peaks = [];
        return Math.max(0, ...peaks);`);
    await run(`window.__spy.peaks = []; return true;`);
    await run(ring);
    await wait(`return app.ring.context !== null;`);
    await settle();
    assert.equal(await lastPeak(), 0.05);
    await run(stop);
    await run(`localStorage.setItem('xxii:settings',
      JSON.stringify({ ringVolume: 100 })); return true;`);
    await run(ring);
    await wait(`return app.ring.context !== null;`);
    await settle();
    assert.equal(await lastPeak(), 0.1);
    await run(stop);
    for (const quiet of [{ ring: false }, { ringVolume: 0 }]) {
      await run(`localStorage.setItem('xxii:settings',
        ${JSON.stringify(JSON.stringify(quiet))}); return true;`);
      const before = await run('return window.__spy.contexts;');
      await run(ring);
      await delay(600);
      const shown = await run(`return Boolean(
        document.querySelector('#incoming-call'));`);
      assert.equal(shown, true, JSON.stringify(quiet));
      assert.equal(await run('return app.ring.context;'), null);
      assert.equal(await run('return window.__spy.contexts;'), before);
      await run(stop);
    }
    await run(`localStorage.removeItem('xxii:settings'); return true;`);
  });
});

test(
  'call notifications and toasts follow the settings',
  {
    timeout: 240000,
  },
  async (t) => {
    await startCallServer(t);
    const browser = await launch(t, FLAGS);
    const peer = await createPeer(t, browser);
    await setPermission(browser, peer.browserContextId, 'granted');
    const session = await peer.open();
    const run = (body) => harness.run(browser, session, body);
    const ring = `app.ring.show({ call: 'c1', chat: 'x', nick: 'kim',
    tab: 'tab' }); return true;`;
    const notes = () =>
      run(`const registration = await navigator.serviceWorker.ready;
      const notes = await registration.getNotifications();
      return notes.map((note) => note.title);`);
    const other = await peer.open();
    await front(browser, other);
    assert.equal(await run('return document.hidden;'), true);
    await run(`localStorage.setItem('xxii:settings',
    JSON.stringify({ notifyCalls: false })); return true;`);
    await run(ring);
    await delay(1500);
    assert.equal(
      await run(`return Boolean(document.querySelector('#incoming-call'));`),
      true,
    );
    assert.deepEqual(await notes(), []);
    await run('app.ring.stop(); return true;');
    await run(`localStorage.setItem('xxii:settings',
    JSON.stringify({ notifyCalls: true })); return true;`);
    await run(ring);
    await harness.wait(
      browser,
      session,
      `const registration = await navigator.serviceWorker.ready;
    const notes = await registration.getNotifications();
    return notes.some((note) => note.title === 'kim is calling');`,
      10000,
    );
  },
);

test(
  'messages notify through the service worker',
  {
    timeout: 300000,
  },
  async (t) => {
    await startCallServer(t);
    const browser = await launch(t, FLAGS);
    const ann = await createPeer(t, browser);
    const bob = await createPeer(t, browser);
    await setPermission(browser, ann.browserContextId, 'granted');
    const bobTab = await bob.open();
    const annTab = await ann.open();
    const annBack = await ann.open();
    const runIn = (session, body) => harness.run(browser, session, body);
    const waitIn = (session, body, ms = 15000) =>
      harness.wait(browser, session, body, ms);
    await runIn(
      bobTab,
      `app.usernameInput.value = 'bob';
    app.syncUsername(); return true;`,
    );
    await runIn(
      annTab,
      `app.usernameInput.value = 'ann';
    app.syncUsername(); return true;`,
    );
    const annPeer = await runIn(annTab, 'return app.peerId;');
    const bobPeer = await runIn(bobTab, 'return app.peerId;');
    assert.notEqual(annPeer, bobPeer);
    for (const [session, peer] of [
      [annTab, bobPeer],
      [annBack, bobPeer],
      [bobTab, annPeer],
    ]) {
      await runIn(
        session,
        `await app.openDirect(${JSON.stringify(peer)});
      return true;`,
      );
    }
    await runIn(
      annTab,
      `localStorage.setItem('xxii:settings',
    JSON.stringify({ notifyDirect: true, notifyReplies: true }));
    return true;`,
    );
    await runIn(
      bobTab,
      `app.selectDirect(${JSON.stringify(annPeer)});
    return true;`,
    );

    const awayTab = await ann.away();
    const hide = async () => {
      await browser.request('Page.bringToFront', {}, awayTab);
      for (const session of [annTab, annBack]) {
        await waitIn(session, 'return document.hidden === true;');
      }
    };
    const notesIn = (session) =>
      runIn(
        session,
        `const registration = await navigator.serviceWorker.ready;
      const notes = await registration.getNotifications();
      return notes.map((note) => ({ title: note.title, body: note.body,
        tag: note.tag, data: note.data }));`,
      );
    const send = (text) =>
      runIn(
        bobTab,
        `app.messageInput.value = ${JSON.stringify(text)};
      await app.sendMessage();
      return [...app.replica.keys('message'), ...[...app.directs.values()]
        .flatMap((direct) => [...direct.replica.keys('message')])]
        .find((id) => app.recordOf(id)?.content === ${JSON.stringify(text)});`,
      );
    const arrived = (text) => `return [...app.directs.values()].some((direct) =>
    direct.replica.keys('message').some((id) =>
    direct.replica.get(id).content === ${JSON.stringify(text)}));`;
    const waitNote = (session, title, count = 1) =>
      waitIn(
        session,
        `const registration = await navigator.serviceWorker.ready;
      const notes = await registration.getNotifications();
      return notes.filter((note) => note.title === ${JSON.stringify(title)})
        .length === ${count};`,
      );

    await hide();

    await t.test(
      'a direct message notifies once with two hidden tabs',
      async () => {
        const id = await send('hello from bob');
        await waitNote(annTab, 'bob');
        await delay(1500);
        const notes = await notesIn(annTab);
        assert.equal(notes.length, 1);
        assert.equal(notes[0].title, 'bob');
        assert.equal(notes[0].body, 'hello from bob');
        assert.equal(notes[0].tag, `message:${id}`);
        assert.equal(notes[0].data.message, id);
        assert.match(notes[0].data.chat, /_/);
      },
    );

    await t.test('notifyText off shows New message', async () => {
      await runIn(
        annTab,
        `localStorage.setItem('xxii:settings',
      JSON.stringify({ notifyDirect: true, notifyReplies: true,
        notifyText: false })); return true;`,
      );
      await send('a secret');
      await waitIn(
        annTab,
        `const registration = await navigator.serviceWorker.ready;
      const notes = await registration.getNotifications();
      return notes.some((note) => note.body === 'New message');`,
      );
      const notes = await notesIn(annTab);
      assert.equal(notes.length, 2);
      assert.equal(
        notes.some((note) => note.body.includes('secret')),
        false,
      );
    });

    await t.test('a visible tab of the same peer suppresses it', async () => {
      await front(browser, annTab);
      await waitIn(annTab, 'return document.hidden === false;');
      await waitIn(annBack, 'return document.hidden === true;');
      await send('seen on screen');
      await waitIn(annTab, arrived('seen on screen'));
      await delay(1500);
      assert.equal((await notesIn(annTab)).length, 2);
      await hide();
    });

    await t.test(
      'notifications off for direct messages stay silent',
      async () => {
        await runIn(
          annTab,
          `localStorage.setItem('xxii:settings',
      JSON.stringify({ notifyDirect: false, notifyReplies: true }));
      return true;`,
        );
        await send('silent one');
        await waitIn(annTab, arrived('silent one'));
        await delay(1500);
        assert.equal((await notesIn(annTab)).length, 2);
      },
    );

    await t.test('a reply to my message in a group notifies', async () => {
      await runIn(
        annTab,
        `app.selectChat(${GENERAL});
      app.messageInput.value = 'question for bob';
      await app.sendMessage(); return true;`,
      );
      await runIn(bobTab, `app.selectChat(${GENERAL}); return true;`);
      await waitIn(
        bobTab,
        `return [...app.replica.keys('message')].some((id) =>
        app.replica.get(id).content === 'question for bob');`,
      );
      await runIn(
        bobTab,
        `app.messageInput.value = 'plain chatter';
      await app.sendMessage(); return true;`,
      );
      await runIn(
        bobTab,
        `const id = [...app.replica.keys('message')].find((key) =>
        app.replica.get(key).content === 'question for bob');
      app.writeMessage(app.chat, 'answer for ann', id, [], '');
      return true;`,
      );
      await waitNote(annTab, 'bob replied in !general');
      await delay(1500);
      const notes = await notesIn(annTab);
      assert.equal(notes.length, 3);
      const reply = notes.find((note) => note.title.includes('replied'));
      assert.equal(reply.body, 'answer for ann');
      assert.equal(
        notes.some((note) => note.body === 'plain chatter'),
        false,
      );
    });

    await t.test('a plain hashtag mention notifies its contact', async () => {
      const id = await send('Look here #ann');
      const title = 'bob mentioned you in !general';
      await waitNote(annTab, title);
      const notice = (await notesIn(annTab)).find(
        (note) => note.title === title,
      );
      assert.equal(notice.body, 'Look here #ann');
      assert.equal(notice.data.message, id);
    });

    await t.test(
      'opening a notification route reveals the message',
      async () => {
        await front(browser, annTab);
        await runIn(annTab, `app.selectChat(${GENERAL}); return true;`);
        const notes = await notesIn(annTab);
        const direct = notes.find((note) => note.body === 'hello from bob');
        await runIn(
          annTab,
          `navigator.serviceWorker.dispatchEvent(new MessageEvent('message', {
        data: { type: 'xxii:open', chat: ${JSON.stringify(direct.data.chat)},
          message: ${JSON.stringify(direct.data.message)} } }));
      return true;`,
        );
        await waitIn(
          annTab,
          `return app.chat === ${JSON.stringify(direct.data.chat)} &&
          app.linked === '';`,
        );
      },
    );
  },
);

const JOIN = `const button = document.querySelector(
  '#prejoin [data-action=join]');
  if (!button) throw new Error('no join');
  button.click();
  return true;`;
const JOINED = `const phase = app.callSession ? app.callSession.phase : '';
  if (phase !== 'joined') throw new Error(phase);
  return true;`;

test(
  'join and leave toasts follow the setting',
  {
    timeout: 240000,
  },
  async (t) => {
    await startCallServer(t);
    const browser = await launch(t, FLAGS);
    const waitFront = async (session, body, ms = 20000) => {
      const deadline = Date.now() + ms;
      while (Date.now() < deadline) {
        await front(browser, session);
        const ready = await harness
          .run(browser, session, body)
          .catch(() => false);
        if (ready) return;
        await delay(100);
      }
      throw new Error(`Browser condition timed out: ${body}`);
    };
    const enter = async (nick, token) => {
      const peer = await createPeer(t, browser);
      const session = await peer.open();
      const run = (body) => harness.run(browser, session, body);
      await run(`app.usernameInput.value = ${JSON.stringify(nick)};
      app.syncUsername(); return true;`);
      const options = token ? `, { token: ${JSON.stringify(token)} }` : '';
      const started = await run(
        `app.selectChat(${GENERAL});
      await app.startCall(${GENERAL}${options});
      return app.callToken;`,
      );
      await front(browser, session);
      await run(JOIN);
      await waitFront(session, JOINED);
      return { session, run, token: started };
    };
    const host = await enter('alex');
    const toast = (name, isShown) => `const toast = document.querySelector(
    '#call-toast');
    const live = document.querySelector('#call-announcements');
    const said = live.textContent.includes('${name} joined');
    if (!said) throw new Error('not announced');
    if (${isShown}) {
      return !toast.hidden && toast.textContent.includes('${name} joined');
    }
    return toast.hidden;`;
    await host.run(`localStorage.setItem('xxii:settings',
    JSON.stringify({ callToasts: false })); return true;`);
    await enter('kim', host.token);
    await waitFront(host.session, toast('kim', false));
    await host.run(`localStorage.setItem('xxii:settings',
    JSON.stringify({ callToasts: true })); return true;`);
    await enter('sam', host.token);
    await waitFront(host.session, toast('sam', true));
  },
);
