'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { setTimeout: delay } = require('node:timers/promises');

const CHROME = process.env.CHROME_BIN ?? '/usr/bin/google-chrome';
const ROOT = path.join(__dirname, '..');
const ORIGIN = 'http://127.0.0.1:8001';

class BrowserProtocol {
  #socket = null;
  #id = 0;
  #pending = new Map();
  errors = [];

  constructor(socket) {
    this.#socket = socket;
    socket.addEventListener('message', ({ data }) => {
      const message = JSON.parse(data);
      if (message.method === 'Runtime.exceptionThrown') {
        const { exceptionDetails } = message.params;
        const description = exceptionDetails.exception?.description;
        this.errors.push(description ?? exceptionDetails.text);
      }
      const request = this.#pending.get(message.id);
      if (!request) return;
      this.#pending.delete(message.id);
      clearTimeout(request.timer);
      if (message.error) request.reject(new Error(message.error.message));
      else request.resolve(message.result);
    });
  }

  request(method, params = {}, sessionId = undefined) {
    const id = ++this.#id;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error(`Browser command timed out: ${method}`));
      }, 25000);
      this.#pending.set(id, { resolve, reject, timer });
      this.#socket.send(JSON.stringify({ id, method, params, sessionId }));
    });
  }

  async evaluate(sessionId, expression) {
    const params = { expression, awaitPromise: true, returnByValue: true };
    const result = await this.request('Runtime.evaluate', params, sessionId);
    const { exceptionDetails } = result;
    if (exceptionDetails) {
      const description = exceptionDetails.exception?.description;
      throw new Error(description ?? JSON.stringify(exceptionDetails));
    }
    return result.result.value;
  }

  close() {
    for (const request of this.#pending.values()) clearTimeout(request.timer);
    this.#pending.clear();
    this.#socket.close();
  }
}

const script = (body) =>
  `(async () => { const { app } = await import('/domain.js'); ${body} })()`;

const startServer = async (dataPath) => {
  const env = { ...process.env, XXII_DATA: dataPath };
  const stdio = ['ignore', 'pipe', 'pipe'];
  const options = { cwd: ROOT, env, stdio };
  const server = spawn(process.execPath, ['server.js'], options);
  let output = '';
  const collect = (data) => {
    output += data.toString();
  };
  server.stdout.on('data', collect);
  server.stderr.on('data', collect);
  for (let attempt = 0; attempt < 150; attempt++) {
    if (output.includes('Listen port 8001')) return server;
    if (server.exitCode !== null) break;
    await delay(100);
  }
  server.kill('SIGKILL');
  throw new Error(`Server did not start:\n${output}`);
};

const stopServer = async (server) => {
  if (server.exitCode !== null) return;
  server.kill('SIGINT');
  await Promise.race([once(server, 'exit'), delay(8000)]);
  if (server.exitCode === null) server.kill('SIGKILL');
};

const launch = async (t) => {
  const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'xxii-chrome-'));
  const args = [
    '--headless=new',
    '--no-sandbox',
    '--disable-gpu',
    '--no-first-run',
    '--no-default-browser-check',
    '--remote-debugging-port=0',
    `--user-data-dir=${profile}`,
    'about:blank',
  ];
  const stdio = ['ignore', 'ignore', 'pipe'];
  const chrome = spawn(CHROME, args, { stdio });
  t.after(async () => {
    chrome.kill();
    await Promise.race([once(chrome, 'exit'), delay(2000)]);
    if (chrome.exitCode === null) chrome.kill('SIGKILL');
    const options = { recursive: true, force: true, maxRetries: 5 };
    await fs.rm(profile, options);
  });
  const file = path.join(profile, 'DevToolsActivePort');
  for (let attempt = 0; attempt < 100; attempt++) {
    const data = await fs.readFile(file, 'utf8').catch(() => '');
    const lines = data.trim().split('\n');
    if (lines.length === 2) {
      const socket = new WebSocket(`ws://127.0.0.1:${lines[0]}${lines[1]}`);
      await once(socket, 'open');
      const browser = new BrowserProtocol(socket);
      t.after(() => browser.close());
      return browser;
    }
    await delay(100);
  }
  throw new Error('Chrome did not start');
};

const readServer = async () => {
  const { Metacom } = require('metacom');
  const client = await Metacom.connect(`${ORIGIN.replace('http', 'ws')}/`);
  try {
    await client.load('sync');
    let position = 0;
    let source = '';
    const deltas = [];
    let more = true;
    while (more) {
      const reply = await client.api.sync.pull({ source, position });
      deltas.push(...reply.deltas);
      ({ source, position, more } = reply);
    }
    return deltas;
  } finally {
    client.close();
  }
};

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

  const run = (session, body) => browser.evaluate(session, script(body));

  const focus = (session) => browser.request('Page.bringToFront', {}, session);

  const wait = async (session, body, timeoutMs = 15000) => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const isReady = await run(session, body).catch(() => false);
      if (isReady) return;
      await delay(100);
    }
    throw new Error(`Browser condition timed out: ${body}`);
  };

  const untilServer = async (check, timeoutMs = 15000) => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const deltas = await readServer().catch(() => null);
      if (deltas && check(deltas)) return;
      await delay(200);
    }
    throw new Error('Server condition timed out');
  };

  const open = async (browserContextId = undefined) => {
    const url = `${ORIGIN}/`;
    const params = { url, browserContextId };
    const { targetId } = await browser.request('Target.createTarget', params);
    const attach = { targetId, flatten: true };
    const target = await browser.request('Target.attachToTarget', attach);
    const { sessionId } = target;
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
    const like = `${message} .quick-reactions [data-reaction="like"]`;
    await run(
      second,
      `document.querySelector('${like}').click();
      return true;`,
    );
    const liked = `return app.replica.get('${id}').reactions?.like === 1;`;
    await wait(first, liked);
    await focus(first);
    await wait(first, shown('hello from tab one'));
    const count = await run(
      first,
      `return document.querySelector(
        '${message} .reactions [data-reaction="like"]').dataset.count;`,
    );
    assert.equal(count, '1');
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

  await t.test('replies open in a thread and pins are listed', async () => {
    await focus(first);
    const id = await run(first, `return ${findText('in dev chat')};`);
    const message = `.message[data-id="${id}"]`;
    await wait(first, `return document.querySelector('${message}') !== null;`);
    await run(
      first,
      `document.querySelector('${message} .reply-btn').click();
      app.replyInput.value = 'thread reply';
      await app.sendReply();
      document.querySelector('${message} .pin-btn').click();
      return true;`,
    );
    const replied = `return [...app.replica.keys('message')].some((key) =>
      app.replica.get(key).replyTo === '${id}');`;
    await wait(second, replied);
    await wait(second, `return app.replica.get('${id}').pinned === true;`);
    const count = `return document.querySelector('${message} .replies .count')
      .textContent === '1 replies';`;
    await wait(first, count);
    await wait(first, 'return app.threadReplies.children.length === 1;');
    await run(first, `app.togglePanel('pins'); return true;`);
    await wait(
      first,
      'return app.pinList.querySelectorAll(".pin-item").length === 1;',
    );
    await run(first, 'app.closePanel(); return true;');
  });

  let feedId = '';

  await t.test('feed posts open details with outline and replies', async () => {
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
    const postId = await run(first, `return [...app.replica.keys('post')][0];`);
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
    const details = `const outline = [...app.postOutline.children]
        .map((item) => item.textContent).join('|');
      const title = app.panelTitle.textContent;
      return title === 'POST DETAILS' && outline === '→ Intro|→ Next steps';`;
    await wait(second, details);
    await run(
      second,
      `app.usernameInput.value = 'ada';
      app.replyInput.value = 'nice post';
      await app.sendReply();
      return true;`,
    );
    const replied = `app.render();
      const post = document.querySelector('.post[data-id="${postId}"]');
      const count = post?.querySelector('.replies .count').textContent;
      return count === '1 replies';`;
    await wait(first, replied);
    await run(
      first,
      `app.editDescription();
      app.topicInput.value = 'team news';
      app.saveDescription();
      return true;`,
    );
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
    await run(second, `app.closePanel(); app.selectChat('${secondChat}');`);
    await run(first, `app.selectChat('${firstChat}'); return true;`);
  });

  await t.test('older messages load on demand', async () => {
    await focus(first);
    for (let i = 0; i < 55; i++) await send(first, 'ada', `bulk ${i}`);
    await wait(first, 'return app.messageList.children.length === 50;');
    const button = 'return !app.loadMoreBtn.classList.contains("hidden");';
    await wait(first, button);
    await run(first, 'app.loadOlder(); return true;');
    await wait(first, 'return app.messageList.children.length === 56;');
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

  const contexts = [];
  for (let i = 0; i < 2; i++) {
    const created = await browser.request('Target.createBrowserContext');
    contexts.push(created.browserContextId);
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

  assert.deepEqual(browser.errors, []);
});
