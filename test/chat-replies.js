'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const harness = require('./harness.js');

const { ORIGIN, startServer, stopServer, launch } = harness;

const DESKTOP = { width: 1200, height: 800 };
const PHONE = { width: 390, height: 800 };

test('Conversation lanes in Chrome', { timeout: 120000 }, async (t) => {
  const dataPath = await fs.mkdtemp(path.join(os.tmpdir(), 'xxii-data-'));
  t.after(() => fs.rm(dataPath, { recursive: true, force: true }));
  const server = await startServer(dataPath);
  t.after(() => stopServer(server));
  const browser = await launch(t);

  const run = (session, body) => harness.run(browser, session, body);
  const wait = (session, body) => harness.wait(browser, session, body);

  const open = async () => {
    const created = await browser.request('Target.createBrowserContext');
    const { browserContextId } = created;
    const url = `${ORIGIN}/`;
    const params = { url, browserContextId };
    const { targetId } = await browser.request('Target.createTarget', params);
    const attach = { targetId, flatten: true };
    const target = await browser.request('Target.attachToTarget', attach);
    const { sessionId } = target;
    await browser.request('Runtime.enable', {}, sessionId);
    await browser.request('Page.enable', {}, sessionId);
    await browser.request('Page.bringToFront', {}, sessionId);
    await wait(sessionId, 'return app.uplink?.link.source !== "";');
    return sessionId;
  };

  const resize = (session, { width, height }) =>
    browser.request(
      'Emulation.setDeviceMetricsOverride',
      { width, height, deviceScaleFactor: 1, mobile: false },
      session,
    );

  const write = (session, nick, content, replyTo = '') =>
    run(
      session,
      `app.username = ${JSON.stringify(nick)};
      const target = ${JSON.stringify(replyTo)};
      const find = (text) => [...app.replica.keys('message')].find((id) =>
        app.replica.get(id).content === text);
      const to = target === '' ? undefined : find(target);
      app.writeMessage(app.chat, ${JSON.stringify(content)}, to, []);
      return true;`,
    );

  const cells = (session) =>
    run(
      session,
      `const rows = [...app.messageList.querySelectorAll('.message')];
      return rows.map((row) => ({
        text: row.querySelector('.content').textContent,
        cells: [...row.querySelectorAll('.lane')].map((lane) =>
          lane.classList.contains('overflow') ? 'overflow' :
            [...lane.classList].find((name) =>
              ['root', 'node', 'pass', 'last'].includes(name)) ?? ''),
      }));`,
    );

  const ada = await open();
  const bob = await open();
  await resize(bob, DESKTOP);

  await write(ada, 'ada', 'A0');
  await write(ada, 'ada', 'A1', 'A0');
  await write(ada, 'ada', 'B0');
  await write(ada, 'ada', 'C0');
  await write(ada, 'ada', 'B1', 'B0');
  await write(ada, 'ada', 'C1', 'C0');
  await write(ada, 'ada', 'B2', 'B1');
  const count = `const list = app.messageList;
    return list.querySelectorAll('.message').length === 7;`;
  await wait(bob, count);

  await t.test('desktop width draws a lane per conversation', async () => {
    await wait(bob, `return app.laneMax === 4;`);
    const rows = await cells(bob);
    const expected = {
      A0: ['root', '', ''],
      A1: ['last', '', ''],
      B0: ['', 'root', ''],
      C0: ['', 'pass', 'root'],
      B1: ['', 'node', 'pass'],
      C1: ['', 'pass', 'last'],
      B2: ['', 'last', ''],
    };
    const actual = Object.fromEntries(rows.map((r) => [r.text, r.cells]));
    assert.deepEqual(actual, expected);
    const title = await run(
      bob,
      `return document.querySelector('.lane.node').title;`,
    );
    assert.equal(title, '2 replies · ada');
    const hot = await run(
      bob,
      `const lane = document.querySelector('.lane.root[data-root]');
      lane.dispatchEvent(new PointerEvent('pointerover', { bubbles: true }));
      const root = lane.dataset.root;
      return document.querySelectorAll('.lane.hot').length > 0
        && [...document.querySelectorAll('.lane.hot')].every(
          (item) => item.dataset.root === root);`,
    );
    assert.equal(hot, true);
  });

  await t.test('phone width draws two lanes and the overflow', async () => {
    await resize(bob, PHONE);
    await wait(bob, `return app.laneMax === 2;`);
    const rows = await cells(bob);
    for (const row of rows) assert.equal(row.cells.length, 3, row.text);
    const named = (text) => rows.find((row) => row.text === text).cells;
    const kinds = (text) => named(text).filter(Boolean).sort();
    assert.deepEqual(kinds('A0'), ['overflow']);
    assert.deepEqual(kinds('A1'), ['overflow']);
    assert.equal(named('A0')[2], 'overflow');
    assert.deepEqual(kinds('B0'), ['root']);
    assert.deepEqual(kinds('C0'), ['pass', 'root']);
    assert.deepEqual(kinds('B1'), ['node', 'pass']);
    assert.deepEqual(kinds('C1'), ['last', 'pass']);
    assert.deepEqual(kinds('B2'), ['last']);
    await resize(bob, DESKTOP);
    await wait(bob, `return app.laneMax === 4;`);
  });

  const press = (session, key) =>
    run(
      session,
      `document.activeElement.dispatchEvent(new KeyboardEvent('keydown',
        { key: ${JSON.stringify(key)}, bubbles: true }));
      return true;`,
    );

  const rowOf = (text) =>
    `[...app.messageList.querySelectorAll('.message')].find((row) =>
      row.querySelector('.content').textContent === ${JSON.stringify(text)})`;

  const idOf = (session, text) =>
    run(
      session,
      `return [...app.replica.keys('message')].find((id) =>
        app.replica.get(id).content === ${JSON.stringify(text)});`,
    );

  const states = (session) =>
    run(
      session,
      `const rows = [...app.messageList.querySelectorAll('.message')];
      return Object.fromEntries(rows.map((row) => {
        const style = getComputedStyle(row);
        return [row.querySelector('.content').textContent, {
          dim: row.classList.contains('dim'),
          branch: row.classList.contains('branch'),
          opacity: style.opacity,
          bar: style.boxShadow,
        }];
      }));`,
    );

  const distance = (session) =>
    run(
      session,
      `const box = app.chatMessages;
      return box.scrollHeight - box.scrollTop;`,
    );

  await write(ada, 'ada', 'D0');
  await write(ada, 'ada', 'D1', 'D0');
  await write(ada, 'ada', 'D2', 'D0');
  await write(ada, 'ada', 'D3', 'D1');
  for (let i = 0; i < 30; i++) await write(ada, 'ada', `F${i}`);
  await wait(
    bob,
    `app.render();
    return app.messageList.textContent.includes('F29');`,
  );
  await run(
    bob,
    `app.chatMessages.scrollTop = app.chatMessages.scrollHeight; return true;`,
  );

  await t.test('a lane click focuses its conversation', async () => {
    const before = await distance(bob);
    await run(
      bob,
      `${rowOf('B0')}.querySelector('.lane[data-root]').click();
      return true;`,
    );
    const root = await idOf(bob, 'B0');
    await wait(bob, `return app.focus?.root === '${root}';`);
    const text = await run(bob, `return app.focusPosition.textContent;`);
    assert.equal(text, '3 of 3');
    const rows = await states(bob);
    for (const name of ['B0', 'B1', 'B2']) assert.equal(rows[name].dim, false);
    for (const name of ['A0', 'C1', 'D2', 'F3']) {
      assert.equal(rows[name].dim, true, name);
    }
    const bold = await run(
      bob,
      `const lanes = document.querySelectorAll('.lane.bold');
      return lanes.length > 0 && [...lanes].every(
        (lane) => lane.dataset.root === '${root}');`,
    );
    assert.equal(bold, true);
    await run(bob, `app.closeFocus(); return true;`);
    const ended = `return app.focus === null
      && !document.querySelector('.dim');`;
    await wait(bob, ended);
    const after = await distance(bob);
    assert.ok(Math.abs(after - before) < 3);
  });

  await t.test('F focuses a message, its branch is brighter', async () => {
    const id = await idOf(bob, 'D3');
    await run(bob, `app.selectById('${id}'); return true;`);
    await press(bob, 'f');
    await wait(bob, `return app.focus?.chosen === '${id}';`);
    const rows = await states(bob);
    for (const name of ['D0', 'D1', 'D3']) {
      assert.equal(rows[name].branch, true, name);
      assert.notEqual(rows[name].bar, 'none', name);
    }
    assert.equal(rows.D2.branch, false);
    assert.equal(rows.D2.bar, 'none');
    assert.equal(rows.D2.opacity, '1');
    assert.ok(Number(rows.B0.opacity) < 1);
  });

  await t.test('arrows and brackets step through a conversation', async () => {
    const position = () => run(bob, 'return app.focusPosition.textContent;');
    const chosen = async (text) => {
      const id = await idOf(bob, text);
      await wait(bob, `return app.focus.chosen === '${id}';`);
    };
    assert.equal(await position(), '4 of 4');
    await press(bob, 'ArrowUp');
    await chosen('D2');
    assert.equal(await position(), '3 of 4');
    await run(bob, `app.focusPrev.click(); return true;`);
    await chosen('D1');
    await press(bob, '[');
    await chosen('D0');
    await press(bob, '[');
    await chosen('D0');
    await press(bob, ']');
    await chosen('D1');
    await run(bob, `app.focusNext.click(); return true;`);
    await chosen('D2');
    await press(bob, 'ArrowDown');
    await chosen('D3');
    await press(bob, '[');
    await press(bob, '[');
    await press(bob, '[');
    await chosen('D0');
    const visible = `const box = app.chatMessages.getBoundingClientRect();
      const row = ${rowOf('D0')}.getBoundingClientRect();
      return row.top >= box.top && row.bottom <= box.bottom;`;
    await wait(bob, visible);
  });

  await t.test('Esc returns to the saved scroll position', async () => {
    await run(bob, `app.closeFocus(); return true;`);
    await wait(bob, `return app.focus === null;`);
    await run(
      bob,
      `const box = app.chatMessages;
      box.scrollTop = box.scrollHeight;
      return true;`,
    );
    const before = await distance(bob);
    await run(
      bob,
      `${rowOf('D0')}.querySelector('.lane[data-root]').click();
      return true;`,
    );
    await wait(bob, `return app.focus !== null;`);
    await run(bob, `app.focusStep(-3); return true;`);
    await wait(bob, `return app.focus.chosen !== '';`);
    await run(bob, `document.activeElement.blur(); return true;`);
    await press(bob, 'Escape');
    await wait(bob, `return app.focus === null;`);
    await wait(
      bob,
      `const box = app.chatMessages;
      return Math.abs(box.scrollHeight - box.scrollTop - ${before}) < 3;`,
    );
  });

  await t.test('the composer in focus targets the latest message', async () => {
    await run(
      bob,
      `${rowOf('D0')}.querySelector('.lane[data-root]').click();
      return true;`,
    );
    await wait(bob, `return app.focus !== null;`);
    const bar = await run(
      bob,
      `return [
        app.replyBar.classList.contains('hidden'),
        app.replyPrefix.textContent,
        app.replyAuthor.textContent,
        app.replyText.textContent,
      ];`,
    );
    assert.deepEqual(bar, [false, '↩ to conversation:', 'ada', 'D3']);
    await run(bob, `${rowOf('D2')}.querySelector('.content').click();`);
    await wait(bob, `return app.replyText.textContent === 'D2';`);
    await run(
      bob,
      `app.username = 'bob';
      app.messageInput.value = 'D4';
      await app.sendMessage();
      return true;`,
    );
    const to = await idOf(bob, 'D2');
    const reply = await idOf(bob, 'D4');
    const sent = await run(bob, `return app.replica.get('${reply}').replyTo;`);
    assert.equal(sent, to);
    await wait(
      bob,
      `app.render();
      return app.focus !== null && app.replyText.textContent === 'D4'
        && app.focusPosition.textContent === '5 of 5'
        && !${rowOf('D4')}.classList.contains('dim');`,
    );
    await run(bob, `app.replyCancel.click(); return true;`);
    await wait(bob, `return app.replyBar.classList.contains('hidden');`);
    await run(
      bob,
      `app.messageInput.value = 'plain';
      await app.sendMessage();
      return true;`,
    );
    const plain = await idOf(bob, 'plain');
    const record = await run(
      bob,
      `return app.replica.get('${plain}').replyTo ?? null;`,
    );
    assert.equal(record, null);
    await wait(bob, `return app.focus === null;`);
  });

  await t.test('a quote and the root counter start focus', async () => {
    await run(bob, `app.render(); return true;`);
    await run(bob, `${rowOf('D1')}.querySelector('.quote').click();`);
    const root = await idOf(bob, 'D0');
    await wait(
      bob,
      `return app.focus?.root === '${root}' && app.focus.chosen === '${root}';`,
    );
    await press(bob, 'Escape');
    await wait(bob, `return app.focus === null;`);
    const counter = await run(
      bob,
      `const counter = ${rowOf('D0')}.querySelector('.replies');
      return [
        counter.querySelector('.count').textContent,
        counter.querySelector('.initials').textContent,
      ];`,
    );
    assert.deepEqual(counter, ['4', 'A B']);
    await run(bob, `${rowOf('D0')}.querySelector('.replies').click();`);
    await wait(bob, `return app.focus?.root === '${root}';`);
    await press(bob, 'Escape');
    await wait(bob, `return app.focus === null;`);
  });

  const target = (session) =>
    run(
      session,
      `const id = app.targetId();
      return [id, app.replyText.textContent,
        !app.replyBar.classList.contains('hidden'), app.focus === null];`,
    );

  const touch = async (session, row, from, to) => {
    const rect = await run(
      session,
      `const row = ${rowOf(row)};
      row.scrollIntoView({ block: 'center' });
      const rect = row.getBoundingClientRect();
      return { left: rect.left, y: rect.top + 6 };`,
    );
    const send = (type, x) =>
      browser.request(
        'Input.dispatchTouchEvent',
        {
          type,
          touchPoints: type === 'touchEnd' ? [] : [{ x, y: rect.y }],
        },
        session,
      );
    await send('touchStart', rect.left + from);
    const steps = 6;
    for (let i = 1; i <= steps; i++) {
      await send('touchMove', rect.left + from + ((to - from) * i) / steps);
    }
    await send('touchEnd', 0);
  };

  await t.test('the reply button starts a reply, not focus mode', async () => {
    await run(bob, `app.cancelReply(); return true;`);
    await run(bob, `${rowOf('F29')}.querySelector('.reply-btn').click();`);
    const id = await idOf(bob, 'F29');
    assert.deepEqual(await target(bob), [id, 'F29', true, true]);
    const focused = await run(
      bob,
      `return document.activeElement === app.messageInput;`,
    );
    assert.equal(focused, true);
  });

  await t.test('R replies to the selected message', async () => {
    await run(
      bob,
      `app.cancelReply();
      app.selectById(${rowOf('F28')}.dataset.id);
      return true;`,
    );
    await press(bob, 'r');
    const id = await idOf(bob, 'F28');
    assert.deepEqual(await target(bob), [id, 'F28', true, true]);
  });

  await t.test('double click replies and selects no word', async () => {
    await run(bob, `app.cancelReply(); return true;`);
    const point = await run(
      bob,
      `const row = ${rowOf('F27')};
      row.scrollIntoView({ block: 'center' });
      const rect = row.querySelector('.content').getBoundingClientRect();
      return { x: rect.left + 6, y: rect.top + rect.height / 2 };`,
    );
    const mouse = (type, clickCount) =>
      browser.request(
        'Input.dispatchMouseEvent',
        { type, ...point, button: 'left', clickCount },
        bob,
      );
    await mouse('mousePressed', 1);
    await mouse('mouseReleased', 1);
    await mouse('mousePressed', 2);
    await mouse('mouseReleased', 2);
    const id = await idOf(bob, 'F27');
    await wait(bob, `return app.targetId() === '${id}';`);
    const selected = await run(bob, `return window.getSelection().toString();`);
    assert.equal(selected, '');
    assert.equal((await target(bob))[3], true);
  });

  await t.test('swipe right replies and swipe left does nothing', async () => {
    await run(bob, `app.cancelReply(); return true;`);
    const enable = { enabled: true, maxTouchPoints: 1 };
    await browser.request('Emulation.setTouchEmulationEnabled', enable, bob);
    await touch(bob, 'F26', 200, 100);
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.equal((await target(bob))[0], '');
    await touch(bob, 'F26', 60, 20);
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.equal((await target(bob))[0], '');
    await touch(bob, 'F26', 60, 140);
    const id = await idOf(bob, 'F26');
    await wait(bob, `return app.targetId() === '${id}';`);
    const off = { enabled: false };
    await browser.request('Emulation.setTouchEmulationEnabled', off, bob);
    await new Promise((resolve) => setTimeout(resolve, 500));
    await run(bob, `app.cancelReply(); return true;`);
  });

  await t.test('a selected fragment becomes the stored quote', async () => {
    await write(ada, 'ada', 'alpha beta gamma');
    await write(ada, 'ada', 'second line');
    await wait(
      bob,
      `app.render(); return ${rowOf('second line')} !== undefined;`,
    );
    const select = (from, text, to = from) => `
      const first = ${rowOf(from)}.querySelector('.content');
      const last = ${rowOf(to)}.querySelector('.content');
      const start = first.firstChild.data.indexOf(${JSON.stringify(text)});
      const end = ${from === to}
        ? start + ${JSON.stringify(text)}.length : last.firstChild.length;
      const range = document.createRange();
      range.setStart(first.firstChild, start);
      range.setEnd(last.firstChild, end);
      const selection = window.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);`;
    const across = select('alpha beta gamma', 'beta', 'second line');
    await run(bob, `${across} return true;`);
    await run(
      bob,
      `${rowOf('alpha beta gamma')}.querySelector('.reply-btn').click();`,
    );
    assert.deepEqual((await target(bob)).slice(1, 2), ['alpha beta gamma']);
    await run(bob, `app.cancelReply(); return true;`);
    const one = select('alpha beta gamma', 'beta');
    await run(bob, `${one} return true;`);
    const items = await run(
      bob,
      `return app.menuItems(${rowOf('alpha beta gamma')}).map((i) => i.label);`,
    );
    assert.ok(items.includes('Reply with quote'));
    await run(bob, `${one} return true;`);
    await run(
      bob,
      `${rowOf('alpha beta gamma')}.querySelector('.reply-btn').click();`,
    );
    assert.deepEqual((await target(bob)).slice(1, 2), ['beta']);
    await run(
      bob,
      `app.messageInput.value = 'answer';
      await app.sendMessage();
      return true;`,
    );
    const id = await idOf(bob, 'answer');
    const stored = await run(bob, `return app.replica.get('${id}').quote;`);
    assert.equal(stored, 'beta');
    await wait(
      ada,
      `app.render();
      const row = ${rowOf('answer')};
      return row?.querySelector('.quote-text').textContent === 'beta';`,
    );
    await run(bob, `window.getSelection().removeAllRanges(); return true;`);
    const none = await run(
      bob,
      `return app.menuItems(${rowOf('alpha beta gamma')}).map((i) => i.label);`,
    );
    assert.ok(!none.includes('Reply with quote'));
  });

  await t.test('a far quote jump shows a back pill that returns', async () => {
    await run(bob, `app.render(); return true;`);
    await run(
      bob,
      `const box = app.chatMessages;
      box.scrollTop = box.scrollHeight;
      return true;`,
    );
    const reply = await idOf(bob, 'D3');
    await run(bob, `${rowOf('D3')}.querySelector('.quote').click();`);
    await wait(bob, `return app.focus !== null;`);
    await wait(bob, `return !app.backPill.classList.contains('hidden');`);
    await run(bob, `app.backPill.click(); return true;`);
    await wait(
      bob,
      `const rect = ${rowOf('D3')}.getBoundingClientRect();
      const box = app.chatMessages.getBoundingClientRect();
      return app.backPill.classList.contains('hidden')
        && rect.top >= box.top - 1 && rect.bottom <= box.bottom + 1;`,
    );
    assert.ok(reply);
    await press(bob, 'Escape');
    await wait(bob, `return app.focus === null;`);
  });

  await t.test('a feed post gets lanes and focus', async () => {
    await run(
      bob,
      `app.feedNameInput.value = '📣 news';
      app.addChannel('feed', app.feedNameInput);
      app.messageInput.value = 'Title\\nbody';
      await app.sendMessage();
      return true;`,
    );
    await wait(bob, `app.render(); return app.view.items.length === 1;`);
    const post = await run(bob, `return app.view.items[0].id;`);
    await run(bob, `app.openArticle('${post}'); return true;`);
    await wait(bob, `return app.article === '${post}';`);
    await run(
      bob,
      `app.writeMessage(app.chat, 'R1', '${post}', []);
      return true;`,
    );
    const first = await idOf(bob, 'R1');
    await run(
      bob,
      `app.writeMessage(app.chat, 'R2', '${first}', []);
      return true;`,
    );
    await wait(bob, `app.render(); return ${rowOf('R2')} !== undefined;`);
    const kinds = await run(
      bob,
      `return [${rowOf('R1')}, ${rowOf('R2')}].map((row) =>
        row.querySelector('.lane').className);`,
    );
    assert.deepEqual(kinds, ['lane node', 'lane last']);
    await run(bob, `${rowOf('R1')}.querySelector('.lane').click();`);
    await wait(bob, `return app.focus?.root === '${post}';`);
    const shown = await run(
      bob,
      `const article = document.querySelector('.post-article');
      return [
        article.classList.contains('dim'),
        app.focusPosition.textContent,
      ];`,
    );
    assert.deepEqual(shown, [false, '3 of 3']);
    await press(bob, 'Escape');
    await wait(bob, `return app.focus === null && app.article === '${post}';`);
    await press(bob, 'Escape');
    await wait(bob, `return app.article === '';`);
  });

  await t.test('replies to me count, step and reset', async () => {
    const hide = (hidden) =>
      run(
        bob,
        `${
          hidden
            ? `Object.defineProperty(document, 'hidden',
                { get: () => true, configurable: true });`
            : `delete document.hidden;`
        }
        return true;`,
      );
    const feed = await run(bob, `return app.chat;`);
    await run(bob, `app.selectChat('general'); return true;`);
    await write(bob, 'bob', 'MINE');
    await wait(
      ada,
      `return [...app.replica.keys('message')].some((id) =>
      app.replica.get(id).content === 'MINE');`,
    );
    await run(bob, `app.selectChat('${feed}'); return true;`);
    await hide(true);
    await write(ada, 'ada', 'RE1', 'MINE');
    await write(ada, 'ada', 'RE2', 'MINE');
    await write(ada, 'ada', 'RE3', 'RE1');
    const item = `const item = document.querySelector(
      '#chat-list .chat-item[data-id="general"]');
      const button = item.querySelector('.mine');`;
    await wait(
      bob,
      `${item} app.render();
      return button.textContent === '↩ 2'
        && !button.classList.contains('hidden');`,
    );
    const mine = await idOf(bob, 'MINE');
    const own = await run(bob, `return app.mine.get('general').length;`);
    assert.equal(own, 2);
    await run(bob, `${item} button.click(); return true;`);
    const first = await idOf(bob, 'RE1');
    await wait(
      bob,
      `return app.chat === 'general' && app.focus?.chosen === '${first}'
        && app.focus.root === '${mine}';`,
    );
    const header = await run(
      bob,
      `return [app.mineBtn.textContent,
        app.mineBtn.classList.contains('hidden')];`,
    );
    assert.deepEqual(header, ['↩ 2', false]);
    await run(bob, `app.mineBtn.click(); return true;`);
    const second = await idOf(bob, 'RE2');
    await wait(bob, `return app.focus?.chosen === '${second}';`);
    await run(bob, `app.mineBtn.click(); return true;`);
    await wait(bob, `return app.focus?.chosen === '${first}';`);
    await hide(false);
    await run(bob, `app.closeFocus(); return true;`);
    await wait(bob, `return app.focus === null;`);
    await run(
      bob,
      `app.chatMessages.scrollTop = app.chatMessages.scrollHeight;
      app.render();
      return true;`,
    );
    await wait(
      bob,
      `app.render();
      return app.mineBtn.classList.contains('hidden')
        && app.repliesCount('general') === 0;`,
    );
  });
});
