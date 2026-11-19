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
const REPLY_ARROW = 'M3 2v5a4 4 0 0 0 4 4h7M10 7l4 4-4 4';

test('Thread colors and replies in Chrome', { timeout: 120000 }, async (t) => {
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

  const resize = (session, { width, height }, mobile = false) =>
    browser.request(
      'Emulation.setDeviceMetricsOverride',
      { width, height, deviceScaleFactor: 1, mobile },
      session,
    );

  const tap = async (session, point, hold = 0) => {
    await browser.request(
      'Input.dispatchTouchEvent',
      { type: 'touchStart', touchPoints: [point] },
      session,
    );
    if (hold) await new Promise((resolve) => setTimeout(resolve, hold));
    await browser.request(
      'Input.dispatchTouchEvent',
      { type: 'touchEnd', touchPoints: [] },
      session,
    );
  };

  const rowOf = (text) =>
    `[...app.messageList.querySelectorAll('.message')].find((row) =>
      row.querySelector('.content').textContent === ${JSON.stringify(text)})`;

  const centerOf = (session, text) =>
    run(
      session,
      `const row = ${rowOf(text)};
      row.scrollIntoView({ block: 'center' });
      const rect = row.querySelector('.content').getBoundingClientRect();
      return { x: rect.left + 2, y: rect.top + rect.height / 2 };`,
    );

  const write = (session, nick, content, replyTo = '', quote = '') =>
    run(
      session,
      `app.username = ${JSON.stringify(nick)};
      const target = ${JSON.stringify(replyTo)};
      const find = (text) => [...app.replica.keys('message')].find((id) =>
        app.replica.get(id).content === text);
      const to = target === '' ? undefined : find(target);
      const content = ${JSON.stringify(content)};
      const quote = ${JSON.stringify(quote)};
      app.writeMessage(app.chat, content, to, [], quote);
      return true;`,
    );

  const press = (session, key) =>
    run(
      session,
      `document.activeElement.dispatchEvent(new KeyboardEvent('keydown',
        { key: ${JSON.stringify(key)}, bubbles: true }));
      return true;`,
    );

  const idOf = (session, text) =>
    run(
      session,
      `return [...app.replica.keys('message')].find((id) =>
        app.replica.get(id).content === ${JSON.stringify(text)});`,
    );

  const sendReply = (session, content) =>
    run(
      session,
      `app.messageInput.value = ${JSON.stringify(content)};
      await app.sendMessage();
      return true;`,
    );

  const replyInMenu = (session, row, action = 'reply-quote', before = '') =>
    run(
      session,
      `${before}
      ${row}.querySelector('.more').click();
      document.querySelector('#menu [data-action="${action}"]').click();
      return true;`,
    );

  const quoteIn = (session, content, expected) =>
    wait(
      session,
      `app.render();
      const row = ${rowOf(content)};
      if (!row) return false;
      const record = app.replica.get(row.dataset.id);
      const quote = row.querySelector('.quote');
      const hasQuote = !quote.classList.contains('hidden');
      const text = quote.querySelector('.quote-text').textContent;
      const expected = ${JSON.stringify(expected)};
      return expected
        ? hasQuote && text === expected && record.quote === expected
        : !hasQuote && record.quote === undefined && Boolean(record.replyTo);`,
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
  await write(ada, 'ada', 'P0');
  await write(ada, 'ada', 'P1');
  const count = `const list = app.messageList;
    return list.querySelectorAll('.message').length === 9;`;
  await wait(bob, count);

  await t.test('rows share the color and grouping of their root', async () => {
    const rows = await run(
      bob,
      `const rows = [...app.messageList.querySelectorAll('.message')];
      return Object.fromEntries(rows.map((row) => {
        const author = getComputedStyle(row.querySelector('.author'));
        const content = getComputedStyle(row.querySelector('.content'));
        const style = getComputedStyle(row);
        return [row.querySelector('.content').textContent, {
          threaded: row.classList.contains('threaded'),
          token: row.style.getPropertyValue('--thread'),
          stripe: style.boxShadow,
          nick: author.color,
          text: content.color,
          isGrouped: row.classList.contains('continued'),
          showsNick: author.visibility === 'visible',
        }];
      }));`,
    );
    for (const name of ['B0', 'B1', 'B2']) {
      const row = rows[name];
      assert.equal(row.threaded, true, name);
      assert.match(row.token, /^var\(--thread-\d+\)$/);
      assert.equal(row.token, rows.B0.token, name);
      assert.equal(row.nick, rows.B0.nick, name);
      assert.match(row.stripe, / 3px 0px 0px 0px inset$/);
      assert.equal(row.text, rows.P0.text, name);
    }
    assert.equal(rows.P0.threaded, false);
    assert.equal(rows.P0.token, '');
    assert.equal(rows.P0.stripe, 'none');
    assert.equal(rows.P0.text, rows.P0.nick);
    assert.equal(rows.P1.isGrouped, true);
    assert.equal(rows.A1.isGrouped, true);
    assert.equal(rows.B0.isGrouped, false);
    assert.equal(rows.B0.showsNick, true);
    assert.equal(rows.P0.showsNick, true);
    const gutters = await run(
      bob,
      `return app.messageList.querySelectorAll('.lanes, .laned').length;`,
    );
    assert.equal(gutters, 0);
  });

  await t.test('the root counter has a right arrow in its color', async () => {
    const info = await run(
      bob,
      `const root = ${rowOf('B0')};
      const counter = root.querySelector('.replies');
      const initials = counter.querySelector('.initials');
      const path = counter.querySelector('path');
      const nested = ${rowOf('B1')}.querySelector('.replies');
      return {
        count: counter.querySelector('.count').textContent,
        label: counter.getAttribute('aria-label'),
        arrow: path.getAttribute('d'),
        stroke: getComputedStyle(path).stroke,
        color: getComputedStyle(counter.querySelector('.count')).color,
        nick: getComputedStyle(root.querySelector('.author')).color,
        initials: initials.textContent,
        showInitials: getComputedStyle(initials).display !== 'none',
        hideNested: nested.classList.contains('hidden'),
      };`,
    );
    assert.equal(info.count, '2');
    assert.equal(info.label, '2 replies, select thread');
    assert.equal(info.arrow, REPLY_ARROW);
    assert.equal(info.stroke, info.nick);
    assert.equal(info.color, info.nick);
    assert.equal(info.initials, 'A');
    assert.equal(info.showInitials, true);
    assert.equal(info.hideNested, true);
    await resize(bob, PHONE);
    await wait(
      bob,
      `const counter = ${rowOf('B0')}.querySelector('.replies');
      return getComputedStyle(counter.querySelector('.initials')).display
        === 'none' && getComputedStyle(counter).display !== 'none';`,
    );
    await resize(bob, DESKTOP);
  });

  const states = (session) =>
    run(
      session,
      `const rows = [...app.messageList.querySelectorAll('.message')];
      return Object.fromEntries(rows.map((row) => {
        const style = getComputedStyle(row);
        return [row.querySelector('.content').textContent, {
          dim: row.classList.contains('dim'),
          chain: row.classList.contains('chain'),
          chosen: row.classList.contains('chosen'),
          opacity: style.opacity,
          stripe: style.boxShadow,
          background: style.backgroundColor,
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
  await write(ada, 'ada', 'D1', 'D0', 'D0');
  await write(ada, 'ada', 'D2', 'D0');
  await write(ada, 'ada', 'D3', 'D1', 'D1');
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

  await t.test('the reply counter selects the whole thread', async () => {
    const before = await distance(bob);
    await run(
      bob,
      `${rowOf('B0')}.querySelector('.replies').click();
      return true;`,
    );
    const root = await idOf(bob, 'B0');
    await wait(bob, `return app.selection?.root === '${root}';`);
    const text = await run(bob, `return app.selectionPosition.textContent;`);
    assert.equal(text, '1 of 3');
    const rows = await states(bob);
    for (const name of ['B0', 'B1', 'B2']) {
      assert.equal(rows[name].dim, false, name);
      assert.equal(rows[name].chain, true, name);
    }
    for (const name of ['A0', 'C1', 'D2', 'F3']) {
      assert.equal(rows[name].dim, true, name);
    }
    await run(bob, `app.closeThread(); return true;`);
    const ended = `return app.selection === null
      && !document.querySelector('.dim');`;
    await wait(bob, ended);
    const after = await distance(bob);
    assert.ok(Math.abs(after - before) < 3);
  });

  await t.test('clicks select, switch and clear threads', async () => {
    const b = await idOf(bob, 'B0');
    const a = await idOf(bob, 'A0');
    const before = await distance(bob);
    await run(bob, `${rowOf('B1')}.querySelector('.content').click();`);
    const selected = await run(
      bob,
      `return [app.selection.root, app.selectionPosition.textContent,
        app.selectionBar.getAttribute('aria-live'), app.selection.moved,
        app.selection.offset, app.messageList.matches('.selecting')];`,
    );
    assert.deepEqual(selected, [b, '2 of 3', 'polite', false, before, true]);
    assert.equal((await states(bob)).P0.opacity, '0.35');
    await run(
      bob,
      `app.chatMessages.scrollTop = 0;
      ${rowOf('B0')}.querySelector('.content').click();`,
    );
    assert.equal(await run(bob, 'return app.replyText.textContent;'), 'B0');
    await run(bob, `${rowOf('A0')}.querySelector('.content').click();`);
    const switched = await run(
      bob,
      `return [app.selection.root, app.selection.offset, app.selection.moved,
        app.layers.filter((layer) => layer === 'selection').length,
        app.replyText.textContent];`,
    );
    assert.deepEqual(switched, [a, before, false, 1, 'A1']);
    await run(bob, `${rowOf('P0')}.querySelector('.content').click();`);
    await wait(bob, `return app.selection === null && app.pops === 0;`);
    assert.equal(await run(bob, 'return app.chatMessages.scrollTop;'), 0);

    for (const outside of [
      'app.messageList',
      'app.chatMessages',
      'app.selectionClose',
    ]) {
      await run(
        bob,
        `${rowOf('B1')}.querySelector('.content').click();
        ${rowOf('B0')}.querySelector('.content').click();
        ${outside}.click();`,
      );
      await wait(
        bob,
        `return app.selection === null && !app.targetId() && !app.pops;`,
      );
    }
    await run(
      bob,
      `${rowOf('B1')}.querySelector('.content').click();
      const top = app.chatMessages.scrollHeight - app.chatMessages.clientHeight;
      app.chatMessages.scrollTop = top / 2;
      return true;`,
    );
    const manual = await run(bob, 'return app.chatMessages.scrollTop;');
    assert.ok(manual > 0);
    await press(bob, 'Escape');
    await wait(bob, `return app.selection === null && app.pops === 0;`);
    assert.equal(await run(bob, 'return app.chatMessages.scrollTop;'), manual);
    await run(
      bob,
      `app.chatMessages.scrollTop = app.chatMessages.scrollHeight;`,
    );
  });

  await t.test('a click in the middle highlights only its chain', async () => {
    await run(bob, `${rowOf('D1')}.querySelector('.content').click();`);
    const rows = await states(bob);
    for (const name of ['D0', 'D1', 'D3']) {
      assert.equal(rows[name].chain, true, name);
    }
    assert.equal(rows.D1.chosen, true);
    assert.equal(rows.D2.chain, false);
    assert.equal(rows.D2.opacity, '1');
    await run(bob, `app.selectionClose.click();`);
    await wait(bob, `return app.selection === null && app.pops === 0;`);
  });

  await t.test('controls keep selection and Esc clears replies', async () => {
    const root = await idOf(bob, 'B0');
    const chosen = await idOf(bob, 'B1');
    const target = await idOf(bob, 'P0');
    await run(
      bob,
      `${rowOf('B1')}.querySelector('.content').click();
      const row = ${rowOf('P0')};
      const content = row.querySelector('.content');
      const link = document.createElement('a');
      link.href = '#';
      link.onclick = (event) => {
        event.preventDefault();
        row.dataset.test = 'link';
      };
      content.append(link);
      link.click();
      link.remove();
      const attachment = row.querySelector('.attachments');
      const image = document.createElement('img');
      attachment.append(image);
      image.click();
      image.remove();
      row.querySelector('.reply-btn').click();`,
    );
    const controls = await run(
      bob,
      `return [${rowOf('P0')}.dataset.test, app.selection.root,
        app.selection.chosen, app.targetId()];`,
    );
    assert.deepEqual(controls, ['link', root, chosen, target]);
    await press(bob, 'Escape');
    const defaults = await run(
      bob,
      `return [app.selection.chosen, app.replyText.textContent];`,
    );
    assert.deepEqual(defaults, [chosen, 'B2']);
    const retargeted = await run(
      bob,
      `const row = ${rowOf('P0')};
      const text = row.querySelector('.content').firstChild;
      const selection = window.getSelection();
      selection.setBaseAndExtent(text, 0, text, 1);
      row.querySelector('.reply-btn').click();
      const quoted = app.replyText.textContent;
      selection.removeAllRanges();
      ${rowOf('B0')}.querySelector('.content').click();
      return [quoted, app.selection.chosen, app.targetId(),
        app.replyText.textContent, app.replyWithQuote.matches('.hidden')];`,
    );
    assert.deepEqual(retargeted, ['P', root, root, 'B0', true]);
    await press(bob, 'Escape');
    const cleared = await run(
      bob,
      `return [app.selection.chosen, app.replyText.textContent];`,
    );
    assert.deepEqual(cleared, [root, 'B2']);
    await press(bob, 'Escape');
    await wait(bob, `return app.selection === null && app.pops === 0;`);
  });

  await t.test('call and recording bodies clear selection', async () => {
    const result = await run(
      bob,
      `const id = 'test-call-card';
      const { chat } = app;
      const timestamp = Date.now();
      app.liveCalls.set(id, { chat, count: 1 });
      const card = app.createCallCard({ id, chat, timestamp, nick: 'ada' });
      app.liveCalls.delete(id);
      app.messageList.append(card);
      let joined = false;
      const startCall = app.startCall;
      app.startCall = async (chatId) => { joined = chatId === chat; };
      ${rowOf('B1')}.click();
      try {
        card.querySelector('button').click();
      } finally {
        app.startCall = startCall;
      }
      const selected = Boolean(app.selection);
      card.querySelector('span').click();
      const cleared = app.selection === null;
      card.remove();
      return [joined, selected, cleared];`,
    );
    assert.deepEqual(result, [true, true, true]);
    await wait(bob, `return !app.pops;`);
    const cleared = await run(
      bob,
      `const record = { id: 'test-recording-card', call: 'test-call-card' };
      const card = app.createRecordingCard(record);
      app.messageList.append(card);
      ${rowOf('B1')}.click();
      card.click();
      card.remove();
      return app.selection === null;`,
    );
    assert.equal(cleared, true);
    await wait(bob, `return !app.pops;`);
  });

  await t.test('menu selection and the no-replies notice', async () => {
    const chosen = await idOf(bob, 'C1');
    await replyInMenu(bob, rowOf('C1'), 'selection');
    await wait(bob, `return app.selection?.chosen === '${chosen}';`);
    await press(bob, 'Escape');
    await wait(bob, `return app.selection === null && app.pops === 0;`);
    await run(bob, `app.selectById(${rowOf('P1')}.dataset.id, false);`);
    await press(bob, 'f');
    const notice = await run(
      bob,
      `return [app.notification.textContent, app.selection];`,
    );
    assert.deepEqual(notice, ['No replies to this message yet', null]);
    await run(bob, `document.activeElement.blur();`);
  });

  await t.test('F jumps to a far row and highlights its chain', async () => {
    const id = await idOf(bob, 'D3');
    await run(bob, `app.selectById('${id}', false); return true;`);
    await press(bob, 'f');
    await wait(
      bob,
      `return app.selection?.chosen === '${id}' && app.selection.moved;`,
    );
    const rows = await states(bob);
    for (const name of ['D0', 'D1', 'D3']) {
      assert.equal(rows[name].chain, true, name);
      assert.notEqual(rows[name].background, rows.D2.background, name);
    }
    assert.equal(rows.D3.chosen, true);
    assert.notEqual(rows.D3.background, rows.D1.background);
    assert.match(rows.D1.stripe, /6px 0px 0px 0px inset/);
    assert.equal(rows.D2.chain, false);
    assert.equal(rows.D2.opacity, '1');
    assert.match(rows.D2.stripe, /3px 0px 0px 0px inset/);
    assert.ok(Number(rows.B0.opacity) < 1);
  });

  await t.test('arrows and brackets step through the thread', async () => {
    const position = () => run(bob, 'return app.selectionPosition.textContent');
    const chosen = async (text) => {
      const id = await idOf(bob, text);
      await wait(bob, `return app.selection.chosen === '${id}';`);
    };
    assert.equal(await position(), '4 of 4');
    await press(bob, 'ArrowUp');
    await chosen('D2');
    assert.equal(await position(), '3 of 4');
    const rows = await states(bob);
    assert.equal(rows.D2.chosen, true);
    assert.equal(rows.D2.chain, true);
    assert.equal(rows.D1.chain, false);
    assert.equal(rows.D3.chain, false);
    await run(bob, `app.selectionPrev.click(); return true;`);
    await chosen('D1');
    await press(bob, '[');
    await chosen('D0');
    await press(bob, '[');
    await chosen('D0');
    await press(bob, ']');
    await chosen('D1');
    await run(bob, `app.selectionNext.click(); return true;`);
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
    await run(bob, `app.closeThread(); return true;`);
    await wait(bob, `return app.selection === null;`);
    await run(
      bob,
      `const box = app.chatMessages;
      box.scrollTop = box.scrollHeight;
      return true;`,
    );
    const before = await distance(bob);
    await run(
      bob,
      `${rowOf('D0')}.querySelector('.replies').click();
      return true;`,
    );
    assert.equal(await run(bob, 'return app.selection.moved;'), false);
    await run(bob, `app.selectionNext.click(); return true;`);
    await wait(bob, `return app.selectionPosition.textContent === '2 of 4';`);
    await wait(bob, `return app.selection.moved;`);
    await run(bob, `${rowOf('B0')}.querySelector('.content').click();`);
    const switched = await run(
      bob,
      `return [app.selectionPosition.textContent, app.selection.moved,
        app.selection.offset];`,
    );
    assert.deepEqual(switched, ['1 of 3', true, before]);
    await press(bob, 'Escape');
    await wait(bob, `return app.selection === null;`);
    await wait(
      bob,
      `const box = app.chatMessages;
      return Math.abs(box.scrollHeight - box.scrollTop - ${before}) < 3;`,
    );
  });

  await t.test('the composer targets the latest by default', async () => {
    await run(
      bob,
      `${rowOf('D0')}.querySelector('.replies').click();
      return true;`,
    );
    await wait(bob, `return app.selection !== null;`);
    const bar = await run(
      bob,
      `return [
        app.replyBar.classList.contains('hidden'),
        app.replyPrefix.textContent,
        app.replyAuthor.textContent,
        app.replyText.textContent,
      ];`,
    );
    assert.deepEqual(bar, [false, '↩ to thread:', 'ada', 'D3']);
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
      return app.selection !== null && app.replyText.textContent === 'D4'
        && app.selectionPosition.textContent === '5 of 5'
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
    await wait(bob, `return app.selection === null;`);
  });

  await t.test('a quote and the root counter select the thread', async () => {
    await run(bob, `app.render(); return true;`);
    await run(bob, `${rowOf('D1')}.querySelector('.quote').click();`);
    const root = await idOf(bob, 'D0');
    await wait(
      bob,
      `return app.selection?.root === '${root}'
        && app.selection.chosen === '${root}';`,
    );
    await press(bob, 'Escape');
    await wait(bob, `return app.selection === null;`);
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
    await wait(bob, `return app.selection?.root === '${root}';`);
    await press(bob, 'Escape');
    await wait(bob, `return app.selection === null;`);
  });

  const target = (session) =>
    run(
      session,
      `const id = app.targetId();
      return [id, app.replyText.textContent,
        !app.replyBar.classList.contains('hidden'), app.selection === null];`,
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

  await t.test('the reply button starts a reply outside a thread', async () => {
    await run(bob, `app.cancelReply(); return true;`);
    await run(bob, `${rowOf('F29')}.querySelector('.reply-btn').click();`);
    const id = await idOf(bob, 'F29');
    assert.deepEqual(await target(bob), [id, 'F29', true, true]);
    const focused = await run(
      bob,
      `return document.activeElement === app.messageInput;`,
    );
    assert.equal(focused, true);
    await sendReply(bob, 'hover reply');
    await quoteIn(bob, 'hover reply', '');
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
    await sendReply(bob, 'keyboard reply');
    await quoteIn(bob, 'keyboard reply', '');
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
    await sendReply(bob, 'double-click reply');
    await quoteIn(bob, 'double-click reply', '');
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
    await sendReply(bob, 'swipe reply');
    await quoteIn(bob, 'swipe reply', '');
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
    await run(
      bob,
      `${across}
      ${rowOf('alpha beta gamma')}.querySelector('.reply-btn').click();`,
    );
    assert.deepEqual((await target(bob)).slice(1, 2), ['alpha beta gamma']);
    await run(bob, `app.cancelReply(); return true;`);
    const one = select('alpha beta gamma', 'beta');
    const row = rowOf('alpha beta gamma');
    await replyInMenu(bob, row, 'reply', one);
    assert.equal((await target(bob))[1], 'alpha beta gamma');
    await sendReply(bob, 'plain menu reply');
    await quoteIn(bob, 'plain menu reply', '');
    await replyInMenu(bob, row, 'reply-quote', one);
    await wait(
      bob,
      `return app.replyText.textContent === 'beta'
        && !app.replyWithQuote.classList.contains('hidden')
        && app.replyWithQuote.textContent === 'with quote';`,
    );
    await sendReply(bob, 'fragment reply');
    await quoteIn(bob, 'fragment reply', 'beta');
    await quoteIn(ada, 'fragment reply', 'beta');
    await run(bob, `window.getSelection().removeAllRanges(); return true;`);
  });

  await t.test('Reply with quote stores a normalized prefix', async () => {
    const padding = 'x'.repeat(310);
    const text = `  alpha  beta\n\ngamma\t ${padding} tail  `;
    await write(ada, 'ada', text);
    const row = rowOf(text);
    await wait(bob, `app.render(); return ${row} !== undefined;`);
    await replyInMenu(bob, row);
    const prefix = `alpha beta gamma ${padding}`.slice(0, 300);
    await wait(
      bob,
      `return app.replyText.textContent === ${JSON.stringify(prefix)}
        && !app.replyWithQuote.classList.contains('hidden');`,
    );
    await sendReply(bob, 'prefix reply');
    await quoteIn(bob, 'prefix reply', prefix);
    await quoteIn(ada, 'prefix reply', prefix);
    await quoteIn(ada, 'hover reply', '');
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
    await wait(bob, `return app.selection !== null;`);
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
    await wait(bob, `return app.selection === null;`);
  });

  await t.test('new messages follow the selection and chain', async () => {
    await run(bob, `${rowOf('D1')}.querySelector('.content').click();`);
    await write(ada, 'ada', 'new descendant', 'D1');
    await write(ada, 'ada', 'new sibling', 'D0');
    await write(ada, 'ada', 'new standalone');
    await wait(
      bob,
      `app.render(); return ${rowOf('new standalone')} !== undefined;`,
    );
    const rows = await states(bob);
    assert.equal(rows['new descendant'].chain, true);
    assert.equal(rows['new sibling'].chain, false);
    assert.equal(rows['new sibling'].dim, false);
    assert.equal(rows['new standalone'].dim, true);
    const reply = await run(bob, 'return app.replyText.textContent');
    assert.equal(reply, 'new sibling');
    await run(bob, `app.searchBtn.click();`);
    await wait(bob, `return app.selection === null && app.pops === 0;`);
    await run(bob, `app.searchBtn.click();`);
  });

  await t.test('dragging text keeps the selected thread', async () => {
    const chosen = await idOf(bob, 'D1');
    await run(bob, `${rowOf('D1')}.querySelector('.content').click();`);
    const point = await run(
      bob,
      `const row = ${rowOf('new standalone')};
      row.scrollIntoView({ block: 'center' });
      const range = document.createRange();
      range.selectNodeContents(row.querySelector('.content'));
      const rect = range.getBoundingClientRect();
      return { x: rect.left + 1, y: rect.top + rect.height / 2 };`,
    );
    const mouse = (type, offset, buttons) =>
      browser.request(
        'Input.dispatchMouseEvent',
        {
          type,
          x: point.x + offset,
          y: point.y,
          button: type === 'mouseMoved' && !buttons ? 'none' : 'left',
          buttons,
          clickCount: type === 'mouseMoved' ? 0 : 1,
        },
        bob,
      );
    await mouse('mouseMoved', 0, 0);
    await mouse('mousePressed', 0, 1);
    await mouse('mouseMoved', 15, 1);
    await mouse('mouseMoved', 48, 1);
    await mouse('mouseReleased', 48, 0);
    const drag = await run(
      bob,
      `return [window.getSelection().toString(), app.selection?.chosen];`,
    );
    assert.ok(drag[0].length > 1, JSON.stringify(drag));
    assert.equal(drag[1], chosen);
    await run(bob, `window.getSelection().removeAllRanges();`);
    await press(bob, 'Escape');
    await wait(bob, `return app.selection === null && app.pops === 0;`);
  });

  await t.test('phone tap, long press and back', async () => {
    await resize(bob, PHONE, true);
    const enable = { enabled: true, maxTouchPoints: 1 };
    await browser.request('Emulation.setTouchEmulationEnabled', enable, bob);
    await run(bob, `app.loadOlder();`);
    const chosen = await idOf(bob, 'B1');
    await wait(
      bob,
      `const sidebar = document.querySelector('.sidebar');
      return sidebar.getBoundingClientRect().right <= 1;`,
    );
    const point = await centerOf(bob, 'B1');
    await tap(bob, point);
    await wait(
      bob,
      `return app.selection?.chosen === '${chosen}'
        && history.state?.layer === 'selection';`,
    );
    await tap(bob, await centerOf(bob, 'B2'), 650);
    await wait(
      bob,
      `return app.menu.isOpen && app.selection?.chosen === '${chosen}';`,
    );
    await run(bob, `history.back();`);
    await wait(
      bob,
      `return !app.menu.isOpen && app.selection?.chosen === '${chosen}';`,
    );
    await run(bob, `history.back();`);
    await wait(bob, `return app.selection === null && app.chat === 'general';`);
    const before = await centerOf(bob, 'B1');
    await tap(bob, before);
    await tap(bob, before);
    await wait(
      bob,
      `return app.selection?.chosen === '${chosen}'
        && app.quotes.get(app.chat) === '${chosen}'
        && !app.fragments.has(app.chat);`,
    );
    await press(bob, 'Escape');
    await run(bob, `history.back();`);
    await wait(bob, `return app.selection === null;`);
    await tap(bob, await centerOf(bob, 'B1'), 650);
    await wait(bob, `return app.menu.isOpen;`);
    await new Promise((resolve) => setTimeout(resolve, 450));
    await run(
      bob,
      `document.querySelector('#menu [data-action="selection"]').click();`,
    );
    await wait(
      bob,
      `return app.selection?.chosen === '${chosen}'
        && !app.pops && history.state?.layer === 'selection';`,
    );
    await run(bob, `history.back();`);
    await wait(bob, `return app.selection === null;`);
    const off = { enabled: false };
    await browser.request('Emulation.setTouchEmulationEnabled', off, bob);
    await resize(bob, DESKTOP);
  });

  await t.test('article comments have their own thread selection', async () => {
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
      `app.writeMessage(app.chat, 'R1', '${post}', [], 'body');
      return true;`,
    );
    const first = await idOf(bob, 'R1');
    await run(
      bob,
      `app.writeMessage(app.chat, 'R2', '${first}', []);
      app.writeMessage(app.chat, 'R3', '${post}', []);
      return true;`,
    );
    await wait(bob, `app.render(); return ${rowOf('R2')} !== undefined;`);
    const thread = await run(
      bob,
      `const root = ${rowOf('R1')};
      const reply = ${rowOf('R2')};
      const plain = ${rowOf('R3')};
      const post = document.querySelector('.post-article');
      const color = (row) => row.style.getPropertyValue('--thread');
      return {
        token: color(root),
        share: color(root) === color(reply),
        threaded: root.matches('.threaded') && reply.matches('.threaded'),
        exempt: [plain, post].every((row) => !row.matches('.threaded')
          && !color(row)),
        count: root.querySelector('.replies .count').textContent,
        noPostCounter: !post.querySelector('.replies'),
      };`,
    );
    assert.match(thread.token, /^var\(--thread-\d+\)$/);
    assert.equal(thread.share, true);
    assert.equal(thread.threaded, true);
    assert.equal(thread.exempt, true);
    assert.equal(thread.count, '1');
    assert.equal(thread.noPostCounter, true);
    await quoteIn(bob, 'R1', 'body');
    await run(bob, `${rowOf('R1')}.querySelector('.quote').click();`);
    const flashed = await run(
      bob,
      `const post = document.querySelector('.post-article');
      return [app.selection, post.getAnimations().length > 0];`,
    );
    assert.deepEqual(flashed, [null, true]);
    await run(bob, `${rowOf('R1')}.querySelector('.replies').click();`);
    await wait(bob, `return app.selection?.root === '${first}';`);
    const shown = await run(
      bob,
      `const article = document.querySelector('.post-article');
      return [
        article.matches('.dim, .chain'),
        ${rowOf('R3')}.classList.contains('dim'),
        app.selectionPosition.textContent,
      ];`,
    );
    assert.deepEqual(shown, [false, true, '1 of 2']);
    await run(bob, `document.querySelector('.post-text').click();`);
    await wait(
      bob,
      `return app.selection === null && app.article === '${post}'
        && !app.pops;`,
    );
    await press(bob, 'Escape');
    await wait(bob, `return app.article === '';`);
    const card = await run(
      bob,
      `const post = document.querySelector('.post');
      const counter = post.querySelector('.replies');
      return [
        post.matches('.threaded'),
        counter.querySelector('.count').textContent,
        counter.querySelector('path').getAttribute('d'),
      ];`,
    );
    assert.deepEqual(card, [false, '3 replies', REPLY_ARROW]);
    await run(bob, `app.selectById('${post}');`);
    await press(bob, 'f');
    const notice = await run(
      bob,
      `return [app.selection, app.notification.textContent];`,
    );
    assert.deepEqual(notice, [null, 'No replies to this message yet']);
  });

  await t.test('article header Back clears both layers', async () => {
    const post = await run(
      bob,
      `return app.view.items.find((item) =>
      item.title === 'Title').id;`,
    );
    await run(
      bob,
      `app.openArticle('${post}');
      ${rowOf('R2')}.click();
      app.backBtn.click();`,
    );
    await wait(
      bob,
      `return !app.article && app.selection === null && !app.pops
        && app.layers.length === 0 && !history.state?.layer;`,
    );
  });

  await t.test('unread replies switch articles and preserve Back', async () => {
    const feed = await run(bob, 'return app.chat;');
    const first = await run(bob, 'return app.view.items[0].id;');
    const parent = await idOf(bob, 'R1');
    const second = await run(
      bob,
      `Object.defineProperty(document, 'hidden', {
        get: () => true, configurable: true,
      });
      app.openArticle('${first}');
      return app.writePost(app.chat, 'Other article', []);`,
    );
    const otherParent = await run(
      bob,
      `return app.writeMessage(app.chat, 'Other comment', '${second}', []);`,
    );
    const writeUnread = (text, id) =>
      run(ada, `return app.writeMessage('${feed}', '${text}', '${id}', []);`);
    const firstReply = await writeUnread('First unread', parent);
    await wait(bob, `return app.replica.get('${firstReply}') !== undefined;`);
    const nextReply = await writeUnread('Second unread', otherParent);
    const ready = `app.render();
      return app.mineBtn.textContent === '↩ 2'
        && !app.mineBtn.matches('.hidden');`;
    await wait(bob, ready);
    await run(bob, `app.mineBtn.click();`);
    await wait(
      bob,
      `return app.article === '${first}'
        && app.selection?.chosen === '${firstReply}';`,
    );
    const selected = `return app.article === '${second}'
      && app.selection?.chosen === '${nextReply}'
      && !app.pops && history.state?.layer === 'selection';`;
    await run(bob, `app.mineBtn.click();`);
    await wait(bob, selected);
    await run(bob, `app.mineBtn.click(); app.mineBtn.click();`);
    await wait(bob, selected);
    await run(bob, `delete document.hidden; history.back();`);
    await wait(
      bob,
      `return app.article === '${second}' && app.selection === null
        && history.state?.layer === 'article';`,
    );
    await run(bob, `history.back();`);
    await wait(bob, `return !app.article && !history.state?.layer;`);
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
      `return app.chat === 'general' && app.selection?.chosen === '${first}'
        && app.selection.root === '${mine}';`,
    );
    const header = await run(
      bob,
      `return [app.mineBtn.textContent,
        app.mineBtn.classList.contains('hidden')];`,
    );
    assert.deepEqual(header, ['↩ 2', false]);
    await run(bob, `app.mineBtn.click(); return true;`);
    const second = await idOf(bob, 'RE2');
    await wait(bob, `return app.selection?.chosen === '${second}';`);
    await run(bob, `app.mineBtn.click(); return true;`);
    await wait(bob, `return app.selection?.chosen === '${first}';`);
    await hide(false);
    await run(bob, `app.closeThread(); return true;`);
    await wait(bob, `return app.selection === null;`);
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
