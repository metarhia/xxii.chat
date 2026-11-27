'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { setTimeout: delay } = require('node:timers/promises');

const harness = require('./harness.js');

const { ORIGIN, MEDIA_FLAGS, launch, startCallServer } = harness;

const READY = `return app.connected && navigator.serviceWorker.controller &&
  app.mesh.peers.has(app.peerId);`;
const DESKTOP = { width: 1280, height: 800, mobile: false };

const KEYS = {
  Enter: { key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r' },
  Escape: { key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 },
};

test('sidebar actions', { timeout: 290000 }, async (t) => {
  await startCallServer(t);
  const browser = await launch(t, MEDIA_FLAGS);

  const createContext = async () => {
    const { browserContextId } = await browser.request(
      'Target.createBrowserContext',
    );
    t.after(() =>
      browser
        .request('Target.disposeBrowserContext', { browserContextId })
        .catch(() => undefined),
    );
    return browserContextId;
  };

  const open = async (browserContextId, nick) => {
    const created = await browser.request('Target.createTarget', {
      url: 'about:blank',
      browserContextId,
    });
    const attach = { targetId: created.targetId, flatten: true };
    const { sessionId } = await browser.request(
      'Target.attachToTarget',
      attach,
    );
    await browser.request('Runtime.enable', {}, sessionId);
    await browser.request('Page.enable', {}, sessionId);
    await browser.request('Page.bringToFront', {}, sessionId);
    await browser.request(
      'Emulation.setDeviceMetricsOverride',
      { ...DESKTOP, deviceScaleFactor: 1 },
      sessionId,
    );
    const source = `localStorage.setItem('xxii:nick', '${nick}');`;
    await browser.request(
      'Page.addScriptToEvaluateOnNewDocument',
      { source },
      sessionId,
    );
    await browser.request('Page.navigate', { url: `${ORIGIN}/` }, sessionId);
    await harness.wait(browser, sessionId, READY, 30000);
    return sessionId;
  };

  const run = (session, body) => harness.run(browser, session, body);
  const wait = (session, body, ms) => harness.wait(browser, session, body, ms);
  const front = (session) => browser.request('Page.bringToFront', {}, session);

  const key = async (session, name) => {
    const params = { ...KEYS[name], type: 'keyDown' };
    await browser.request('Input.dispatchKeyEvent', params, session);
    const up = { ...KEYS[name], type: 'keyUp' };
    await browser.request('Input.dispatchKeyEvent', up, session);
  };

  const click = async (session, selector) => {
    const point = await run(
      session,
      `const box = document.querySelector(${JSON.stringify(selector)})
        .getBoundingClientRect();
      return { x: box.left + box.width / 2, y: box.top + box.height / 2 };`,
    );
    const base = { ...point, button: 'left', clickCount: 1 };
    const moved = { ...base, type: 'mouseMoved' };
    await browser.request('Input.dispatchMouseEvent', moved, session);
    const down = { ...base, type: 'mousePressed' };
    await browser.request('Input.dispatchMouseEvent', down, session);
    const up = { ...base, type: 'mouseReleased' };
    await browser.request('Input.dispatchMouseEvent', up, session);
  };

  const chatRow = (id) =>
    `document.querySelector('#chat-list [data-id="${id}"]')`;
  const feedRow = (id) =>
    `document.querySelector('#feed-list [data-id="${id}"]')`;
  const contactRow = (peer) =>
    `document.querySelector('#contact-list [data-peer="${peer}"]')`;
  const folderRow = (id) =>
    `document.querySelector('.folder-row[data-folder="${id}"]')`;

  const labels = (session) =>
    run(
      session,
      `return [...document.querySelectorAll('#nav-menu .menu-label')]
        .map((item) => item.textContent.trim());`,
    );

  const choose = async (session, action) => {
    await run(
      session,
      `document.querySelector('#nav-menu [data-action="${action}"]').click();
      return true;`,
    );
    await wait(session, `return !app.navMenu.isOpen;`);
  };

  const openRowMenu = async (session, row) => {
    await run(
      session,
      `app.render();
      app.toggleNavMenu(${row}.querySelector('.row-more'));
      return true;`,
    );
    await wait(session, `return app.navMenu.isOpen;`);
  };

  const hiddenOf = (session) =>
    run(
      session,
      `return JSON.parse(localStorage.getItem('xxii:hidden') ?? '{}');`,
    );

  const toast = (session) =>
    run(
      session,
      `return app.undoToast.classList.contains('hidden') ? '' :
        app.undoText.textContent;`,
    );

  const say = (session, chat, text) =>
    run(
      session,
      `return app.writeMessage(${JSON.stringify(chat)}, ${JSON.stringify(text)},
        undefined, []);`,
    );

  const adaContext = await createContext();
  const bobContext = await createContext();
  const ada = await open(adaContext, 'ada');
  const bob = await open(bobContext, 'bob');
  const adaId = await run(ada, 'return app.peerId;');
  const bobId = await run(bob, 'return app.peerId;');
  const pair = [adaId, bobId].sort().join('_');

  await run(
    ada,
    `app.chatNameInput.value = 'design';
    app.addChannel('chat', app.chatNameInput);
    app.feedNameInput.value = '📢 news';
    app.addChannel('feed', app.feedNameInput);
    return true;`,
  );
  const designId = await run(
    ada,
    `return [...app.replica.keys('chat')]
      .find((id) => app.replica.get(id).name === 'design');`,
  );
  const newsId = await run(
    ada,
    `return [...app.replica.keys('feed')]
      .find((id) => app.replica.get(id).name === 'news');`,
  );
  await wait(
    bob,
    `app.render();
    return app.replica.get('${designId}')?.name === 'design' &&
      app.replica.get('${newsId}')?.name === 'news';`,
    30000,
  );
  await wait(ada, `return app.mesh.peers.has('${bobId}');`, 30000);

  await t.test('leaving a chat hides it and its unread count', async () => {
    await front(ada);
    await run(ada, `app.selectChat('general'); return true;`);
    await say(bob, designId, 'one');
    await say(bob, designId, 'two');
    await wait(
      ada,
      `app.render();
      return app.unreadOf('${designId}') === 2 &&
        document.title.startsWith('(2)') &&
        ${chatRow(designId)}.querySelector('.badge').textContent === '2';`,
    );
    await openRowMenu(ada, chatRow(designId));
    const items = await labels(ada);
    assert.deepEqual(items, ['Add to folder…', 'Leave chat']);
    await choose(ada, 'leave');
    await wait(ada, `app.render(); return ${chatRow(designId)} === null;`);
    assert.equal(await toast(ada), 'Left !design');
    assert.deepEqual((await hiddenOf(ada)).chats, [designId]);
    await say(bob, designId, 'three');
    await wait(
      ada,
      `app.render();
      return app.replica.keys('message').some((id) =>
        app.replica.get(id).content === 'three');`,
    );
    const counts = await run(
      ada,
      `return { unread: app.unreadOf('${designId}'),
        title: document.title, listed: ${chatRow(designId)} !== null };`,
    );
    assert.deepEqual(counts, {
      unread: 0,
      title: 'XXII Chat',
      listed: false,
    });
  });

  await t.test(
    'Ctrl+K finds a hidden chat and opening restores it',
    async () => {
      await run(ada, `app.toggleSwitcher(); return true;`);
      const found = await run(
        ada,
        `const items = [...document.querySelectorAll('.switcher-list li')];
      const item = items.find((li) =>
        li.querySelector('.name')?.textContent === '!design');
      return { mark: item?.querySelector('.hidden-mark')?.textContent,
        others: items.filter((li) => li.querySelector('.hidden-mark'))
          .length };`,
      );
      assert.deepEqual(found, { mark: 'hidden', others: 1 });
      await run(
        ada,
        `const input = document.querySelector('#switcher input');
      input.value = 'design';
      input.dispatchEvent(new Event('input'));
      return true;`,
      );
      await key(ada, 'Enter');
      await wait(
        ada,
        `app.render();
      return app.chat === '${designId}' && ${chatRow(designId)} !== null;`,
      );
      assert.deepEqual((await hiddenOf(ada)).chats, []);
      assert.equal(await toast(ada), '');
    },
  );

  await t.test('undo brings an item back and the toast expires', async () => {
    await run(
      ada,
      `app.hideTarget({ kind: 'chat', id: '${designId}' });
      return true;`,
    );
    await wait(ada, `app.render(); return ${chatRow(designId)} === null;`);
    await click(ada, '#undo-btn');
    await wait(ada, `app.render(); return ${chatRow(designId)} !== null;`);
    assert.equal(await toast(ada), '');
    assert.deepEqual((await hiddenOf(ada)).chats, []);
    await run(
      ada,
      `app.hideTarget({ kind: 'chat', id: '${designId}' });
      return true;`,
    );
    assert.equal(await toast(ada), 'Left !design');
    await wait(ada, `return app.undoToast.classList.contains('hidden');`, 9000);
    await run(ada, `app.revealChat('${designId}'); app.render(); return true;`);
  });

  await t.test('unsubscribe hides a feed', async () => {
    await openRowMenu(ada, feedRow(newsId));
    assert.deepEqual(await labels(ada), ['Add to folder…', 'Unsubscribe']);
    await choose(ada, 'leave');
    await wait(ada, `app.render(); return ${feedRow(newsId)} === null;`);
    assert.equal(await toast(ada), 'Unsubscribed from #news');
    assert.deepEqual((await hiddenOf(ada)).feeds, [newsId]);
    await click(ada, '#undo-btn');
    await wait(ada, `app.render(); return ${feedRow(newsId)} !== null;`);
  });

  await t.test('general cannot be left', async () => {
    await run(
      ada,
      `app.selectChat('general');
      app.toggleNavMenu(app.chatMenuBtn);
      return true;`,
    );
    assert.deepEqual(await labels(ada), ['Add to folder…', 'Shared media']);
    await run(ada, `app.navMenu.close(); return true;`);
  });

  await t.test('the topbar menu leaves the open chat', async () => {
    await run(ada, `app.selectChat('${designId}'); return true;`);
    await click(ada, '#chat-menu-btn');
    await wait(ada, `return app.navMenu.isOpen;`);
    assert.deepEqual(await labels(ada), [
      'Add to folder…',
      'Shared media',
      'Leave chat',
    ]);
    await choose(ada, 'leave');
    await wait(ada, `app.render(); return app.chat === 'general';`);
    await click(ada, '#undo-btn');
    await wait(ada, `app.render(); return ${chatRow(designId)} !== null;`);
  });

  await t.test('a removed contact returns on a newer message', async () => {
    await wait(
      ada,
      `app.render(); return ${contactRow(bobId)} !== null;`,
      20000,
    );
    await run(bob, `app.selectDirect('${adaId}'); return true;`);
    await say(bob, pair, 'old hello');
    await wait(
      ada,
      `const direct = app.directs.get('${pair}');
      return Boolean(direct) && [...direct.replica.keys('message')]
        .some((id) => direct.replica.get(id).content === 'old hello');`,
      30000,
    );
    await run(
      ada,
      `app.selectChat('general');
      app.render();
      return true;`,
    );
    await openRowMenu(ada, contactRow(bobId));
    assert.deepEqual(await labels(ada), [
      'Add to folder…',
      'Request contact',
      'Block contact',
      'Remove contact',
    ]);
    await choose(ada, 'leave');
    await wait(ada, `app.render(); return ${contactRow(bobId)} === null;`);
    assert.match(await toast(ada), /^Removed @/);
    const entry = (await hiddenOf(ada)).contacts[0];
    assert.equal(entry.id, bobId);
    assert.ok(entry.at > 0);
    await delay(300);
    const quiet = await run(
      ada,
      `app.render();
      return { listed: ${contactRow(bobId)} !== null,
        unread: app.unreadOf('${pair}'),
        hidden: app.isHiddenChat('${pair}') };`,
    );
    assert.deepEqual(quiet, { listed: false, unread: 0, hidden: true });
    await run(
      ada,
      `app.onRing({ call: 'ring-1', chat: '${pair}',
        from: { nick: 'bob', peer: '${bobId}' } });
      return true;`,
    );
    assert.equal(await run(ada, `return app.ring.call;`), '');
    await delay(50);
    await say(bob, pair, 'new hello');
    await wait(
      ada,
      `app.render();
      return ${contactRow(bobId)} !== null;`,
      30000,
    );
    assert.deepEqual((await hiddenOf(ada)).contacts, []);
    const badge = await run(
      ada,
      `return ${contactRow(bobId)}.querySelector('.badge').textContent;`,
    );
    assert.equal(badge, '2');
    await run(
      ada,
      `app.onRing({ call: 'ring-2', chat: '${pair}',
        from: { nick: 'bob', peer: '${bobId}' } });
      return true;`,
    );
    assert.equal(await run(ada, `return app.ring.call;`), 'ring-2');
    await run(ada, `app.ring.stop(); return true;`);
  });

  await t.test('a returning contact still sends a notice', async () => {
    await run(
      ada,
      `localStorage.setItem('xxii:settings',
        JSON.stringify({ notifyDirect: true }));
      window.notices = [];
      Object.defineProperty(Notification, 'permission', {
        get: () => 'granted',
        configurable: true,
      });
      Object.defineProperty(document, 'hidden', {
        get: () => true,
        configurable: true,
      });
      const post = ServiceWorker.prototype.postMessage;
      ServiceWorker.prototype.postMessage = function (message) {
        if (message?.type === 'xxii:notify') window.notices.push(message);
        return post.apply(this, arguments);
      };
      app.hideTarget({ kind: 'contact', id: '${bobId}' });
      return true;`,
    );
    assert.equal(await run(ada, `return app.isHiddenChat('${pair}');`), true);
    await delay(50);
    await say(bob, pair, 'notice me');
    await wait(
      ada,
      `return window.notices.some((item) => item.body === 'notice me');`,
      30000,
    );
    const state = await run(
      ada,
      `app.render();
      return { listed: ${contactRow(bobId)} !== null,
        hidden: app.isHiddenChat('${pair}'),
        chat: window.notices[0].chat };`,
    );
    assert.deepEqual(state, { listed: true, hidden: false, chat: pair });
    await run(
      ada,
      `localStorage.removeItem('xxii:settings');
      delete document.hidden;
      return true;`,
    );
  });

  await t.test('folders are personal and delete only themselves', async () => {
    await run(
      ada,
      `app.folderNameInput.value = 'Work';
      app.addFolders();
      app.folderNameInput.value = 'Home';
      app.addFolders();
      app.render();
      return true;`,
    );
    const work = await run(
      ada,
      `return app.folders.list().find((item) => item.name === 'Work').id;`,
    );
    await openRowMenu(ada, folderRow(work));
    assert.deepEqual(await labels(ada), [
      'Add the open chat',
      'New subfolder',
      'Rename',
      'Delete folder',
    ]);
    await choose(ada, 'folder-rename');
    await wait(
      ada,
      `return document.activeElement.className === 'rename-input';`,
    );
    await browser.request('Input.insertText', { text: '💼 Jobs' }, ada);
    await key(ada, 'Enter');
    await wait(
      ada,
      `app.render();
      return ${folderRow(work)}.querySelector('.name').textContent === 'Jobs'
        && ${folderRow(work)}.querySelector('.icon').textContent === '💼';`,
    );
    await openRowMenu(ada, folderRow(work));
    await choose(ada, 'folder-new');
    await wait(
      ada,
      `return document.activeElement.className === 'rename-input';`,
    );
    await browser.request('Input.insertText', { text: 'Sub' }, ada);
    await key(ada, 'Enter');
    await wait(
      ada,
      `return app.folders.list().some((item) =>
        item.name === 'Sub' && item.parent === '${work}');`,
    );
    const sub = await run(
      ada,
      `return app.folders.list().find((item) => item.name === 'Sub').id;`,
    );
    await run(ada, `app.selectChat('${designId}'); return true;`);
    await openRowMenu(ada, chatRow(designId));
    assert.deepEqual(await labels(ada), [
      'Home',
      'Jobs',
      'Jobs / Sub',
      'Leave chat',
    ]);
    await run(
      ada,
      `[...document.querySelectorAll('#nav-menu .menu-item')]
        .find((item) => item.textContent.trim() === 'Jobs / Sub').click();
      return true;`,
    );
    await run(ada, `app.navMenu.close(); app.render(); return true;`);
    const placed = await run(
      ada,
      `const inFolder = ${folderRow(sub)}.closest('.folder')
        .querySelector('.chat-item[data-id="${designId}"]');
      return { inFolder: inFolder !== null,
        listed: ${chatRow(designId)} !== null,
        records: [...app.replica.keys('folder')].length +
          [...app.replica.keys('entry')].length };`,
    );
    assert.deepEqual(placed, { inFolder: true, listed: true, records: 0 });
    await run(
      ada,
      `app.selectDirect('${bobId}');
      app.addToFolder('${work}');
      app.render();
      return true;`,
    );
    const contact = await run(
      ada,
      `return ${folderRow(work)}.closest('.folder')
        .querySelector(':scope > .folder-items > .contact-item') !== null &&
        ${contactRow(bobId)} !== null;`,
    );
    assert.equal(contact, true);
    const other = await run(
      bob,
      `app.render();
      return { folders: app.folderList.children.length,
        records: [...app.replica.keys('folder')].length +
          [...app.replica.keys('entry')].length,
        listed: ${chatRow(designId)} !== null };`,
    );
    assert.deepEqual(other, { folders: 0, records: 0, listed: true });
    await openRowMenu(ada, folderRow(work));
    await choose(ada, 'folder-delete');
    await wait(ada, `return document.querySelector('dialog.confirm')?.open;`);
    const lines = await run(
      ada,
      `return [...document.querySelectorAll('.confirm-body p')]
        .map((line) => line.textContent);`,
    );
    assert.deepEqual(lines, [
      'Jobs will be deleted.',
      'Items stay in their sections.',
    ]);
    await click(ada, '.confirm-action');
    await wait(
      ada,
      `app.render();
      return ${folderRow(work)} === null && ${folderRow(sub)} !== null;`,
    );
    const after = await run(
      ada,
      `const roots = [...app.folderList
        .querySelectorAll(':scope > .folder > .folder-row')]
        .map((row) => row.querySelector('.name').textContent).sort();
      return { roots, listed: ${chatRow(designId)} !== null,
        contact: ${contactRow(bobId)} !== null,
        inFolder: ${folderRow(sub)}.closest('.folder')
          .querySelector('.chat-item') !== null };`,
    );
    assert.deepEqual(after, {
      roots: ['Home', 'Sub'],
      listed: true,
      contact: true,
      inFolder: true,
    });
  });

  await t.test(
    'a folder item that is left disappears from folders',
    async () => {
      await run(ada, `app.selectChat('general'); return true;`);
      await run(
        ada,
        `app.hideTarget({ kind: 'chat', id: '${designId}' });
      return true;`,
      );
      const gone = await run(
        ada,
        `app.render();
      return document.querySelectorAll('.chat-item[data-id="${designId}"]')
        .length;`,
      );
      assert.equal(gone, 0);
      await click(ada, '#undo-btn');
      await wait(
        ada,
        `app.render();
      return document.querySelectorAll('.chat-item[data-id="${designId}"]')
        .length === 2;`,
      );
    },
  );

  await t.test('folders migrate once from own replica records', async () => {
    await run(
      ada,
      `const created = Date.now();
      app.replica.assign('folder', 'old-own', { name: 'Old', icon: '📦',
        owner: app.peerId, parent: '', created, visibility: 'public' });
      app.replica.assign('folder', 'old-other', { name: 'Theirs', icon: '📁',
        owner: '${bobId}', parent: '', created, visibility: 'public' });
      app.replica.assign('entry', 'old-own/${newsId}', { folder: 'old-own',
        item: '${newsId}', active: true });
      app.replica.assign('entry', 'old-own/gone', { folder: 'old-own',
        item: 'gone', active: false });
      localStorage.removeItem('xxii:folders');
      app.folders.reload();
      app.migrateFolders();
      app.render();
      return true;`,
    );
    const migrated = await run(
      ada,
      `return { folders: app.folders.list().map((item) => item.id),
        items: [...(app.folders.tree().items.get('old-own') ?? [])],
        saved: localStorage.getItem('xxii:folders') !== null };`,
    );
    assert.deepEqual(migrated, {
      folders: ['old-own'],
      items: [newsId],
      saved: true,
    });
    await run(
      ada,
      `app.folders.remove('old-own'); app.migrateFolders(); return true;`,
    );
    assert.equal(await run(ada, `return app.folders.list().length;`), 0);
  });

  await t.test('another tab follows hidden ids and folders', async () => {
    const tab = await open(adaContext, 'ada');
    await run(
      ada,
      `app.hideTarget({ kind: 'feed', id: '${newsId}' });
      return true;`,
    );
    await wait(
      tab,
      `app.render();
      return app.hidden.has('feeds', '${newsId}') &&
        ${feedRow(newsId)} === null;`,
    );
    await run(
      ada,
      `app.runUndo();
      app.folderNameInput.value = 'Shared';
      app.addFolders();
      return true;`,
    );
    await wait(
      tab,
      `app.render();
      return !app.hidden.has('feeds', '${newsId}') &&
        app.folders.list().some((item) => item.name === 'Shared') &&
        ${feedRow(newsId)} !== null;`,
    );
  });

  await t.test('Escape cancels a folder name', async () => {
    await front(ada);
    const home = await run(
      ada,
      `app.render();
      return app.folders.list().find((item) => item.name === 'Shared').id;`,
    );
    await openRowMenu(ada, folderRow(home));
    await choose(ada, 'folder-rename');
    await wait(
      ada,
      `return document.activeElement.className === 'rename-input';`,
    );
    await browser.request('Input.insertText', { text: 'Changed' }, ada);
    await key(ada, 'Escape');
    await wait(ada, `return !document.querySelector('.rename-input');`);
    const name = await run(
      ada,
      `return ${folderRow(home)}.querySelector('.name').textContent;`,
    );
    assert.equal(name, 'Shared');
  });
});
