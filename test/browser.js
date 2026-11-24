'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { setTimeout: delay } = require('node:timers/promises');
const harness = require('./harness.js');

const { ORIGIN, startServer, stopServer, launch, readServer } = harness;

const ROOT = path.join(__dirname, '..');
const MANIFEST = path.join(ROOT, 'application/static/manifest.json');

test('XXII Chat in Chrome', { timeout: 240000 }, async (t) => {
  const dataPath = await fs.mkdtemp(path.join(os.tmpdir(), 'xxii-data-'));
  t.after(() => fs.rm(dataPath, { recursive: true, force: true }));
  let server = await startServer(dataPath);
  t.after(() => stopServer(server));
  const browser = await launch(t);

  const restart = async () => {
    server = await startServer(dataPath);
  };

  const stop = async () => {
    await stopServer(server);
  };

  const run = (session, body) => harness.run(browser, session, body);

  const focus = (session) => browser.request('Page.bringToFront', {}, session);

  const wait = (session, body, timeoutMs = 15000) =>
    harness.wait(browser, session, body, timeoutMs);

  const untilServer = async (check, timeoutMs = 15000) => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const deltas = await readServer().catch(() => null);
      if (deltas && check(deltas)) return;
      await delay(200);
    }
    throw new Error('Server condition timed out');
  };

  const targets = new Map();

  const open = async (browserContextId = undefined) => {
    const url = `${ORIGIN}/`;
    const params = { url, browserContextId };
    const { targetId } = await browser.request('Target.createTarget', params);
    const attach = { targetId, flatten: true };
    const target = await browser.request('Target.attachToTarget', attach);
    const { sessionId } = target;
    targets.set(sessionId, targetId);
    await browser.request('Runtime.enable', {}, sessionId);
    await browser.request('Page.enable', {}, sessionId);
    await wait(sessionId, 'return app.uplink?.link.source !== "";');
    return sessionId;
  };

  const send = (session, nick, content) =>
    run(
      session,
      `app.usernameInput.value = ${JSON.stringify(nick)};
      app.messageInput.value = ${JSON.stringify(content)};
      await app.sendMessage();
      return true;`,
    );

  const findText = (content) => {
    const text = JSON.stringify(content);
    return `[...app.replica.keys('message')].find((id) =>
      app.replica.get(id).content === ${text})`;
  };

  const hasText = (content) => `return ${findText(content)} !== undefined;`;

  const shown = (content) =>
    `return app.messageList.textContent.includes(${JSON.stringify(content)});`;

  const serverHas = (content) => (deltas) =>
    deltas.some((delta) => delta.data.content?.$lww.value === content);

  const menuClick = (selector, button) => `{
    const item = document.querySelector('${selector}');
    const rect = item.getBoundingClientRect();
    const x = rect.left + 120;
    const y = rect.top + 4;
    const init = { bubbles: true, cancelable: true, clientX: x, clientY: y };
    const line = item.querySelector('.line, .title');
    line.dispatchEvent(new MouseEvent('contextmenu', init));
    document.querySelector('#menu ${button}').click();
  }`;

  const touch = (type, x, y) => `item.dispatchEvent(new PointerEvent('${type}',
    { bubbles: true, pointerType: 'touch', clientX: ${x}, clientY: ${y} }));`;

  const press = (key, options = {}) => {
    const init = JSON.stringify({ key, bubbles: true, ...options });
    return `document.activeElement.dispatchEvent(
      new KeyboardEvent('keydown', ${init}));`;
  };

  const first = await open();
  const second = await open();

  await t.test('general chat exists everywhere', async () => {
    const title = await run(first, 'return app.chatTitle.textContent;');
    assert.equal(title, '!general');
    await untilServer((deltas) => deltas[0].target === 'general');
  });

  await t.test('tabs share messages and reactions', async () => {
    await send(first, 'ada', 'hello from tab one');
    await wait(second, shown('hello from tab one'));
    await untilServer(serverHas('hello from tab one'));
    const id = await run(first, `return ${findText('hello from tab one')};`);
    const message = `.message[data-id="${id}"]`;
    await focus(second);
    await run(
      second,
      `${menuClick(message, '[data-reaction="like"]')}
      return true;`,
    );
    const reaction = `[...app.replica.keys('reaction')]
      .map((key) => app.replica.get(key))
      .find((record) => record.message === '${id}')`;
    await wait(first, `return ${reaction}?.active === true;`);
    await focus(first);
    const chip = `document.querySelector(
      '${message} .reactions [data-reaction="like"]')`;
    const mine = `app.render(); const chip = ${chip};
      return chip?.dataset.count === '1' && chip.classList.contains('mine');`;
    await wait(first, mine);
    const title = await run(first, `return ${chip}.title;`);
    assert.equal(title, 'you reacted with 👍');
    await run(first, `${chip}.click(); return true;`);
    await wait(second, `return ${reaction}?.active === false;`);
    await wait(second, `app.render(); return ${chip} === null;`);
  });

  await t.test('new chat appears in other tab', async () => {
    await run(
      first,
      `app.chatNameInput.value = 'dev';
      app.addChannel('chat', app.chatNameInput);
      return true;`,
    );
    const chatId = await run(first, 'return app.chat;');
    await wait(second, `return app.replica.get('${chatId}')?.name === 'dev';`);
    await send(first, 'ada', 'in dev chat');
    await focus(second);
    const item = `return document.querySelector(
      '.chat-item[data-id="${chatId}"] .name').textContent === '!dev';`;
    await wait(second, item);
    await run(second, `app.selectChat('${chatId}'); return true;`);
    await wait(second, shown('in dev chat'));
    const badge = `return document.querySelector(
      '.chat-item[data-id="${chatId}"] .badge').classList.contains('hidden');`;
    await wait(second, badge);
  });

  await t.test('plain replies share the root color and selection', async () => {
    await focus(first);
    const id = await run(first, `return ${findText('in dev chat')};`);
    const message = `.message[data-id="${id}"]`;
    await wait(first, `return document.querySelector('${message}') !== null;`);
    await run(
      first,
      `${menuClick(message, '[data-action="reply"]')}
      return true;`,
    );
    const bar = `return !app.replyBar.classList.contains('hidden')
      && app.replyText.textContent === 'in dev chat'
      && app.messageInput.placeholder === '> reply to ada';`;
    await wait(first, bar);
    await run(
      first,
      `app.messageInput.value = 'thread reply';
      await app.sendMessage();
      ${menuClick(message, '[data-action="pin"]')}
      return true;`,
    );
    const replied = `return [...app.replica.keys('message')].some((key) =>
      app.replica.get(key).replyTo === '${id}');`;
    await wait(second, replied);
    await wait(second, `return app.replica.get('${id}').pinned === true;`);
    const replyId = await run(first, `return ${findText('thread reply')};`);
    const reply = `.message[data-id="${replyId}"]`;
    const threaded = `const root = document.querySelector('${message}');
      const reply = document.querySelector('${reply}');
      return app.replyBar.classList.contains('hidden')
        && root.classList.contains('threaded')
        && reply?.classList.contains('threaded')
        && root.style.getPropertyValue('--thread') ===
          reply.style.getPropertyValue('--thread')
        && reply.querySelector('.quote').classList.contains('hidden');`;
    await wait(first, threaded);
    const count = `return document.querySelector('${message} .replies .count')
      ?.textContent === '1';`;
    await wait(first, count);
    await run(first, `document.querySelector('${message} .replies').click();`);
    const opened = `const items = app.messageList.querySelectorAll('.message');
      const dim = app.messageList.querySelectorAll('.dim').length;
      return app.selection?.root === '${id}' && app.chatInfo.textContent !== ''
        && app.selectionPosition.textContent === '1 of 2'
        && app.backBtn.classList.contains('hidden')
        && items.length === 2 && dim === 0
        && [...items].every((row) => row.classList.contains('inside'));`;
    await wait(first, opened);
    await run(first, `${press('Escape')} return true;`);
    await wait(
      first,
      `return app.selection === null
      && !document.querySelector('.dim');`,
    );
    await run(first, `app.togglePanel('pins'); return true;`);
    await wait(
      first,
      'return app.pinList.querySelectorAll(".pin-item").length === 1;',
    );
    await run(first, 'app.closePanel(); return true;');
  });

  let feedId = '';

  await t.test(
    'feed posts open in place with outline and replies',
    async () => {
      await focus(first);
      const firstChat = await run(first, 'return app.chat;');
      const secondChat = await run(second, 'return app.chat;');
      await run(
        first,
        `app.feedNameInput.value = '📣 news';
      app.addChannel('feed', app.feedNameInput);
      return true;`,
      );
      feedId = await run(first, 'return app.chat;');
      const text = 'Release notes\n## Intro\nfirst part\n## Next steps\nmore';
      await send(first, 'ada', text);
      const card = `app.render();
      const title = document.querySelector('.post .title');
      return title?.textContent === 'Release notes';`;
      await wait(first, card);
      await untilServer((deltas) =>
        deltas.some((delta) => {
          const title = delta.data.title?.$lww.value;
          return delta.entity === 'post' && title === 'Release notes';
        }),
      );
      const postId = await run(
        first,
        `return [...app.replica.keys('post')][0];`,
      );
      const listed = `app.render();
      const item = app.feedList.querySelector('[data-id="${feedId}"]');
      if (!item || !app.replica.get('${postId}')) return false;
      const name = item.querySelector('.name').textContent;
      const icon = item.querySelector('.icon').textContent;
      return name === '#news' && icon === '📣';`;
      await wait(second, listed);
      await run(
        second,
        `app.selectChat('${feedId}');
      document.querySelector('.post[data-id="${postId}"] .title').click();
      return true;`,
      );
      const details = `const links = document.querySelectorAll(
        '.post-article .outline button');
      const outline = [...links].map((item) => item.textContent).join('|');
      return app.article === '${postId}'
        && app.chatInfo.textContent === 'post · 0 replies'
        && outline === '→ Intro|→ Next steps';`;
      await wait(second, details);
      await run(
        second,
        `app.usernameInput.value = 'ada';
      app.messageInput.value = 'nice post';
      await app.sendMessage();
      return true;`,
      );
      await wait(second, `app.render(); ${shown('nice post')}`);
      const replied = `app.render();
      const post = document.querySelector('.post[data-id="${postId}"]');
      const count = post?.querySelector('.replies .count').textContent;
      return count === '1 reply';`;
      await wait(first, replied);
      await run(
        first,
        `app.editDescription();
      app.topicInput.value = 'team news';
      app.saveDescription();
      return true;`,
      );
      await run(second, 'app.closeArticle(); return true;');
      await wait(
        second,
        'app.render(); return app.chatInfo.textContent === "team news";',
      );
      const keys = await run(
        second,
        `return [
        app.isSendKey(new KeyboardEvent('keydown', { key: 'Enter' })),
        app.isSendKey(new KeyboardEvent('keydown', { ctrlKey: true })),
      ];`,
      );
      assert.deepEqual(keys, [false, true]);
      await run(second, `app.selectChat('${secondChat}');`);
      await run(first, `app.selectChat('${firstChat}'); return true;`);
    },
  );

  await t.test('older messages load on demand', async () => {
    await focus(first);
    for (let i = 0; i < 55; i++) await send(first, 'ada', `bulk ${i}`);
    const rows = 'app.messageList.querySelectorAll(".message").length';
    await wait(first, `return ${rows} === 50;`);
    const button = 'return !app.loadMoreBtn.classList.contains("hidden");';
    await wait(first, button);
    await run(first, 'app.loadOlder(); return true;');
    await wait(first, `return ${rows} === 57;`);
  });

  await t.test('keyboard: Esc sidebar, select, reply, Ctrl+K', async () => {
    await focus(first);
    const chat = await run(first, 'return app.chat;');
    const isNarrow = await run(
      first,
      'return matchMedia("(max-width: 900px)").matches;',
    );
    const toggled = isNarrow ? 'menu-open' : 'sidebar-hidden';
    await run(
      first,
      `document.activeElement.blur();
      ${press('Escape')}
      return true;`,
    );
    await wait(first, `return app.app.classList.contains('${toggled}');`);
    await run(first, `${press('Escape')} return true;`);
    await wait(first, `return !app.app.classList.contains('${toggled}');`);
    await run(first, `app.messageInput.focus(); ${press('ArrowUp')}`);
    const last = `const items = app.messageList.querySelectorAll('.message');
      return document.activeElement === items[items.length - 1];`;
    await wait(first, last);
    await run(first, `${press('ArrowUp')} ${press('r')} return true;`);
    const quote = `return !app.replyBar.classList.contains('hidden')
      && document.activeElement === app.messageInput
      && app.replyText.textContent === 'bulk 53';`;
    await wait(first, quote);
    await run(first, `${press('Escape')} return true;`);
    await wait(first, `return app.replyBar.classList.contains('hidden');`);
    await run(
      first,
      `app.messageInput.value = 'unsent draft';
      app.messageInput.dispatchEvent(new Event('input'));
      ${press('k', { ctrlKey: true })}
      const input = document.querySelector('#switcher input');
      input.value = 'gene';
      input.dispatchEvent(new Event('input'));
      ${press('Enter')}
      return true;`,
    );
    const switched = `return app.chat === 'general' && !app.switcher.isOpen
      && app.messageInput.value === '';`;
    await wait(first, switched);
    await run(first, `app.selectChat('${chat}'); return true;`);
    const draft = await run(first, 'return app.messageInput.value;');
    assert.equal(draft, 'unsent draft');
    await run(
      first,
      `app.messageInput.value = '';
      app.messageInput.dispatchEvent(new Event('input'));
      return true;`,
    );
  });

  await t.test('touch: swipe right replies, long press lifts', async () => {
    await focus(first);
    const lastMessage = `const list = app.messageList;
      const items = list.querySelectorAll('.message');
      const item = items[items.length - 1];
      const rect = item.getBoundingClientRect();
      const y = rect.top + 4;`;
    await run(
      first,
      `${lastMessage}
      ${touch('pointerdown', 100, 'y')}
      ${touch('pointermove', 120, 'y')}
      ${touch('pointermove', 180, 'y')}
      ${touch('pointerup', 180, 'y')}
      return true;`,
    );
    const quote = `return !app.replyBar.classList.contains('hidden')
      && app.replyText.textContent === 'bulk 54';`;
    await wait(first, quote);
    await run(
      first,
      `app.setQuote(''); ${lastMessage}
      ${touch('pointerdown', 300, 'y')} return true;`,
    );
    const lifted = `return app.menu.isLifted
      && document.querySelector('#menu .lift .content')
        ?.textContent === 'bulk 54'
      && !app.backdrop.classList.contains('hidden');`;
    await wait(first, lifted);
    await run(
      first,
      `${lastMessage} ${touch('pointerup', 300, 'y')}
      ${press('Escape')} return true;`,
    );
    await wait(first, 'return !app.menu.isOpen;');
    await run(
      first,
      `document.body.dispatchEvent(new PointerEvent('pointerdown',
        { bubbles: true, pointerType: 'mouse' }));
      return true;`,
    );
  });

  await t.test('restarted worker loads its replica from OPFS', async () => {
    await stop();
    await browser.request('ServiceWorker.enable', {}, second);
    await browser.request('ServiceWorker.stopAllWorkers', {}, second);
    await browser.request('Page.reload', {}, first);
    await browser.request('Page.reload', {}, second);
    await wait(first, hasText('hello from tab one'));
    await wait(second, hasText('bulk 54'));
  });

  await t.test('offline message reaches the server later', async () => {
    await run(first, `app.selectChat('general'); return true;`);
    await send(first, 'ada', 'written while server is down');
    await wait(second, hasText('written while server is down'));
    await restart();
    await untilServer(serverHas('written while server is down'), 20000);
  });

  const contexts = new Array(2).fill('');
  for (let i = 0; i < contexts.length; i++) {
    const created = await browser.request('Target.createBrowserContext');
    contexts[i] = created.browserContextId;
  }
  const grace = await open(contexts[0]);
  const linus = await open(contexts[1]);
  const graceId = await run(grace, 'return app.peerId;');
  const linusId = await run(linus, 'return app.peerId;');
  const linked = (peer) =>
    `return app.mesh.links.get('${peer}')?.connected === true;`;

  await t.test('peers in two browsers link automatically', async () => {
    assert.notEqual(graceId, linusId);
    await wait(grace, hasText('written while server is down'));
    await wait(grace, linked(linusId), 45000);
    await wait(linus, linked(graceId), 45000);
    const firstId = await run(first, 'return app.peerId;');
    await wait(grace, linked(firstId), 45000);
    await wait(linus, linked(firstId), 45000);
  });

  await t.test('direct messages go over WebRTC only', async () => {
    await run(
      grace,
      `app.usernameInput.value = 'grace';
      app.selectDirect('${linusId}');
      app.messageInput.value = 'secret direct';
      await app.sendMessage();
      return true;`,
    );
    const pair = await run(grace, 'return app.chat;');
    const received = `const direct = app.directs.get('${pair}');
      if (!direct) return false;
      return [...direct.replica.keys('message')].some((key) =>
        direct.replica.get(key).content === 'secret direct');`;
    await wait(linus, received, 30000);
    await focus(linus);
    const badge = `return document.querySelector(
      '.contact-item[data-peer="${graceId}"] .badge').textContent === '1';`;
    await wait(linus, badge);
    const deltas = await readServer();
    assert.equal(serverHas('secret direct')(deltas), false);
  });

  await t.test('folders are listed for the owner or everyone', async () => {
    const folderOf = (name) => `[...app.replica.keys('folder')]
      .find((id) => app.replica.get(id).name === '${name}')`;
    const rowOf = (id) => `document.querySelector(
      '.folder-row[data-folder="${id}"]')`;
    const feedItem = `app.feedList.querySelector('[data-id="${feedId}"]')`;
    await run(
      grace,
      `app.folderNameInput.value = 'Projects/📦 alpha';
      app.addFolders();
      app.selectChat('${feedId}');
      return true;`,
    );
    const projects = await run(grace, `return ${folderOf('Projects')};`);
    const alpha = await run(grace, `return ${folderOf('alpha')};`);
    const folder = await run(grace, `return app.replica.get('${alpha}');`);
    assert.equal(folder.parent, projects);
    assert.equal(folder.icon, '📦');
    assert.equal(folder.visibility, 'unlisted');
    await run(
      grace,
      `app.render();
      ${rowOf(alpha)}.querySelector('[data-action="add"]').click();
      return true;`,
    );
    const placed = `app.render();
      const nested = ${rowOf(projects)}?.closest('.folder')
        .querySelector('.folder-row[data-folder="${alpha}"]');
      const item = nested?.closest('.folder')
        .querySelector('.chat-item[data-id="${feedId}"]');
      return Boolean(item) && ${feedItem} === null;`;
    await wait(grace, placed);
    const synced = `return [...app.replica.keys('entry')].length > 0;`;
    await wait(linus, synced);
    const hidden = await run(
      linus,
      `app.render();
      return app.folderList.children.length === 0 && ${feedItem} !== null;`,
    );
    assert.equal(hidden, true);
    await run(
      grace,
      `app.toggleVisibility('${projects}');
      app.toggleVisibility('${alpha}');
      return true;`,
    );
    const shared = `app.render();
      const row = ${rowOf(alpha)};
      if (!row) return false;
      const item = row.closest('.folder')
        .querySelector('.chat-item[data-id="${feedId}"]');
      const actions = row.querySelector('.folder-actions');
      const isReadOnly = actions.classList.contains('hidden');
      return Boolean(item) && isReadOnly && ${feedItem} === null;`;
    await wait(linus, shared);
    await run(linus, `app.toggleFolder('${projects}'); return true;`);
    const collapsed = await run(
      linus,
      `const isOpen = ${rowOf(projects)}.closest('.folder')
        .classList.contains('open');
      const saved = localStorage.getItem('xxii:collapsed');
      return !isOpen && saved === '${projects}';`,
    );
    assert.equal(collapsed, true);
    await run(
      linus,
      `const chat = await import('/chat.js');
      const owner = app.peerId;
      const created = Date.now();
      const loop = (id, parent) => {
        const name = id.replace('-', ' ');
        const folder = { id, name, icon: '📁', owner, parent, created };
        chat.createFolder(app.replica, folder);
      };
      loop('loop-a', 'loop-b');
      loop('loop-b', 'loop-a');
      return true;`,
    );
    const roots = await run(
      linus,
      `app.render();
      const rows = app.folderList
        .querySelectorAll(':scope > .folder > .folder-row');
      return [...rows].map((row) => row.dataset.folder)
        .filter((id) => id.startsWith('loop-')).sort();`,
    );
    assert.deepEqual(roots, ['loop-a', 'loop-b']);
    await run(
      grace,
      `app.render();
      document.querySelector('.chat-item[data-id="${feedId}"] .remove-btn')
        .click();
      return true;`,
    );
    await wait(linus, `app.render(); return ${feedItem} !== null;`);
    await run(grace, `app.selectChat('general'); return true;`);
  });

  const attach = (session, name, text) =>
    run(
      session,
      `const file = new File([${JSON.stringify(text)}], '${name}');
      app.addFiles([file]);
      await app.sendMessage();
      return true;`,
    );

  const fileOf = (replica, name) => `const replica = ${replica};
    const id = [...replica.keys('file')]
      .find((key) => replica.get(key).name === '${name}');
    const file = id ? { id, ...replica.get(id) } : null;`;

  const checksumOf = (text) =>
    crypto.createHash('sha256').update(text).digest('hex');

  const serverFile = (checksum) => path.join(dataPath, 'files', checksum);

  await t.test(
    'attached files reach other browsers through server',
    async () => {
      const text = 'notes for the team';
      const checksum = checksumOf(text);
      await run(first, `app.selectChat('general'); return true;`);
      await attach(first, 'notes.txt', text);
      const uploaded = async () => {
        const deadline = Date.now() + 15000;
        while (Date.now() < deadline) {
          const content = await fs
            .readFile(serverFile(checksum), 'utf8')
            .catch(() => '');
          if (content === text) return;
          await delay(200);
        }
        throw new Error('File is not uploaded');
      };
      await uploaded();
      const chip = `app.render();
      const file = app.messageList.querySelector('.file');
      return file?.querySelector('.file-name').textContent === 'notes.txt';`;
      await wait(grace, chip);
      const loaded = await run(
        grace,
        `${fileOf('app.replica', 'notes.txt')}
      const blob = await app.loadFile(file);
      return blob.text();`,
      );
      assert.equal(loaded, text);
      await run(
        grace,
        `app.messageList.querySelector('.file .download-btn').click();
      return true;`,
      );
      const log = 'document.getElementById("output").textContent';
      const saved = `return ${log}.includes('Saved file: notes.txt');`;
      await wait(grace, saved);
    },
  );

  await t.test('images show previews and open in the viewer', async () => {
    await focus(first);
    await run(
      first,
      `const canvas = document.createElement('canvas');
      canvas.width = 64;
      canvas.height = 48;
      const context = canvas.getContext('2d');
      context.fillStyle = '#10b981';
      context.fillRect(0, 0, 64, 48);
      const blob = await new Promise((resolve) => canvas.toBlob(resolve));
      const type = 'image/png';
      app.addFiles([new File([blob], 'pixel.png', { type })]);
      await app.sendMessage();
      return true;`,
    );
    await focus(grace);
    const sized = `${fileOf('app.replica', 'pixel.png')}
      return file?.width === 64 && file.height === 48;`;
    await wait(grace, sized);
    const preview = `app.render();
      const image = app.messageList.querySelector('.image img');
      app.chatMessages.scrollTop = app.chatMessages.scrollHeight;
      return image?.src.startsWith('blob:') === true;`;
    await wait(grace, preview, 20000);
    await run(
      grace,
      `app.messageList.querySelector('.image .image-open').click();
      return true;`,
    );
    const opened = `const image = document.querySelector('.lightbox-image');
      return app.lightbox.isOpen && image.src.startsWith('blob:');`;
    await wait(grace, opened);
    await run(grace, `${press('Escape')} return true;`);
    await wait(grace, 'return !app.lightbox.isOpen;');
  });

  await t.test('direct message files go peer to peer only', async () => {
    const text = 'private bytes';
    const checksum = checksumOf(text);
    await run(grace, `app.selectDirect('${linusId}'); return true;`);
    await attach(grace, 'secret.txt', text);
    const pair = await run(grace, 'return app.chat;');
    const direct = `app.directs.get('${pair}')?.replica`;
    const received = `${fileOf(direct, 'secret.txt')}
      if (!file) return false;
      const { readFile } = await import('/files.js');
      const blob = await readFile(file);
      return blob !== null && (await blob.text()) === '${text}';`;
    await wait(linus, received, 30000);
    const isOnServer = await fs.access(serverFile(checksum)).then(
      () => true,
      () => false,
    );
    assert.equal(isOnServer, false);
    const deltas = await readServer();
    const leaked = deltas.some(
      (delta) => delta.data.checksum?.$lww.value === checksum,
    );
    assert.equal(leaked, false);
    await run(grace, `app.selectChat('general'); return true;`);
  });

  await t.test('group chat syncs over WebRTC without server', async () => {
    await run(grace, `app.selectChat('general'); return true;`);
    await stop();
    await wait(grace, 'return !app.connected;');
    await wait(linus, 'return !app.connected;');
    await send(grace, 'grace', 'over webrtc only');
    await wait(linus, hasText('over webrtc only'), 30000);
    await send(linus, 'linus', 'reply over webrtc');
    await wait(grace, hasText('reply over webrtc'), 30000);
  });

  await t.test('dropped link reconnects through a relay peer', async () => {
    await run(
      grace,
      `const link = app.mesh.links.get('${linusId}');
      link.close();
      app.mesh.links.delete('${linusId}');
      app.mesh.update([...app.mesh.peers.values()]);
      return true;`,
    );
    await wait(grace, linked(linusId), 45000);
    await wait(linus, linked(graceId), 45000);
    await send(linus, 'linus', 'after relayed handshake');
    await wait(grace, hasText('after relayed handshake'), 30000);
  });

  await t.test('peer messages reach the server when it is back', async () => {
    await restart();
    await untilServer((deltas) => {
      const hasGrace = serverHas('over webrtc only')(deltas);
      return hasGrace && serverHas('reply over webrtc')(deltas);
    }, 25000);
    await wait(first, hasText('reply over webrtc'));
  });

  await t.test('clear database resets tabs, server refills them', async () => {
    const cleared = (id) => `return app.replica.cleared.includes('${id}');`;
    const firstLog = await run(first, 'return app.replica.id;');
    const secondLog = await run(second, 'return app.replica.id;');
    await run(first, 'await app.clearDatabase(); return true;');
    await wait(first, cleared(firstLog));
    await wait(second, cleared(secondLog));
    await focus(second);
    await wait(second, 'return app.chatTitle.textContent === "!general";');
    await send(second, 'ada', 'after clear');
    await wait(first, hasText('after clear'));
    await wait(first, hasText('hello from tab one'));
  });

  await t.test('new version installs by itself and applies', async () => {
    await focus(first);
    const { version } = JSON.parse(await fs.readFile(MANIFEST, 'utf8'));
    const shown = await run(first, 'return app.versionBtn.textContent;');
    assert.equal(shown, `v${version}`);
    const { targetInfos } = await browser.request('Target.getTargets');
    const page = targetInfos.find(
      (info) => info.targetId === targets.get(first),
    );
    const worker = targetInfos.find((info) => {
      const isWorker = info.type === 'service_worker';
      const isOwn = info.browserContextId === page.browserContextId;
      return isWorker && isOwn && info.url === `${ORIGIN}/worker.js`;
    });
    const attach = { targetId: worker.targetId, flatten: true };
    const { sessionId } = await browser.request(
      'Target.attachToTarget',
      attach,
    );
    const next = '9.9.9';
    const manifest = JSON.stringify({ name: 'XXII Chat', version: next });
    const body = Buffer.from(manifest).toString('base64');
    const headers = [{ name: 'Content-Type', value: 'application/json' }];
    browser.on('Fetch.requestPaused', ({ requestId }, session) => {
      const reply = { requestId, responseCode: 200, body };
      const params = { ...reply, responseHeaders: headers };
      browser.request('Fetch.fulfillRequest', params, session).catch(() => {});
    });
    const patterns = [{ urlPattern: '*/manifest.json' }];
    await browser.request('Fetch.enable', { patterns }, sessionId);
    const ready = await run(first, 'return app.checkUpdate(true);');
    assert.equal(ready, next);
    const label = await run(first, 'return app.versionBtn.textContent;');
    assert.equal(label, `v${version} → v${next}`);
    const keys = await run(first, 'return caches.keys();');
    assert.deepEqual(keys.toSorted(), [`xxii-${next}`, 'xxii-meta']);
    await run(first, 'setTimeout(() => app.restart(), 0); return true;');
    const restarted = (value) => `return app.version === '${value}'
      && app.uplink?.link.source !== ''
      && app.versionBtn.textContent === 'v${value}';`;
    await wait(first, restarted(next), 30000);
    await wait(second, restarted(next), 30000);
    await browser.request('Fetch.disable', {}, sessionId);
    const back = await run(first, 'return app.checkUpdate(true);');
    assert.equal(back, version);
    await run(first, 'setTimeout(() => app.restart(), 0); return true;');
    await wait(first, restarted(version), 30000);
    await wait(second, restarted(version), 30000);
  });

  assert.deepEqual(browser.errors, []);
});
