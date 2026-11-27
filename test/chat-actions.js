'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const harness = require('./harness.js');

const { ORIGIN, startServer, stopServer, launch } = harness;

const DESKTOP = { width: 1200, height: 800 };
const HOVER_SETTINGS = [
  'primaryHoverType=2',
  'availableHoverTypes=2',
  'primaryPointerType=4',
  'availablePointerTypes=4',
].join(',');
const SHOW_TOOLS = `.message-tools, .message-tools .more {
  display: flex !important;
  visibility: visible !important;
}`;
const OWN_TOOLS = [
  'reply-hover',
  'share',
  'forward',
  'edit',
  'delete',
  'pick',
  'menu',
];
const OTHER_TOOLS = ['reply-hover', 'share', 'forward', 'pick', 'menu'];
const REACTIONS = ['👍', '❤️', '😂', '😮', '😢', '🔥', '🤔', '💯', '👎'];

test('Message actions in Chrome', { timeout: 120000 }, async (t) => {
  const dataPath = await fs.mkdtemp(path.join(os.tmpdir(), 'xxii-data-'));
  t.after(() => fs.rm(dataPath, { recursive: true, force: true }));
  const server = await startServer(dataPath);
  t.after(() => stopServer(server));
  const browser = await launch(t, [`--blink-settings=${HOVER_SETTINGS}`]);

  const run = (session, body) => harness.run(browser, session, body);
  const wait = (session, body) => harness.wait(browser, session, body);

  const open = async (url = `${ORIGIN}/`) => {
    const created = await browser.request('Target.createBrowserContext');
    const { browserContextId } = created;
    const params = { url, browserContextId };
    const { targetId } = await browser.request('Target.createTarget', params);
    const attach = { targetId, flatten: true };
    const target = await browser.request('Target.attachToTarget', attach);
    const { sessionId } = target;
    await browser.request('Runtime.enable', {}, sessionId);
    await browser.request('Page.enable', {}, sessionId);
    const metrics = { ...DESKTOP, deviceScaleFactor: 1, mobile: false };
    const emulate = 'Emulation.setDeviceMetricsOverride';
    await browser.request(emulate, metrics, sessionId);
    await wait(sessionId, 'return app.uplink?.link.source !== "";');
    await run(
      sessionId,
      `navigator.clipboard.writeText = async (text) => {
        window.copied = text;
      };
      window.confirm = () => true;
      return true;`,
    );
    return sessionId;
  };

  const rowOf = (text) =>
    `[...app.messageList.querySelectorAll('.message')].find((row) =>
      row.querySelector('.content').textContent === ${JSON.stringify(text)})`;

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

  const shown = (session, text) =>
    wait(session, `app.render(); return Boolean(${rowOf(text)});`);

  const idOf = (session, text) =>
    run(
      session,
      `return [...app.replica.keys('message')].find((id) =>
        app.replica.get(id).content === ${JSON.stringify(text)});`,
    );

  const press = (session, key, target = 'document.activeElement') =>
    run(
      session,
      `${target}.dispatchEvent(new KeyboardEvent('keydown',
        { key: ${JSON.stringify(key)}, bubbles: true }));
      return true;`,
    );

  const tool = (session, text, action) =>
    run(
      session,
      `${rowOf(text)}.querySelector('[data-action="${action}"]').click();
      return true;`,
    );

  const ada = await open();
  const bob = await open();
  const general = await run(ada, 'return app.chat;');

  await write(ada, 'ada', 'my own line');
  await write(bob, 'bob', 'a line from bob');
  await shown(ada, 'a line from bob');
  await shown(bob, 'my own line');

  await t.test(
    'the time is on the right and tools take its place',
    async () => {
      const sidebar = `return ['settings-btn', 'recordings-btn'].map((id) => {
        const button = document.getElementById(id);
        const width = button.getBoundingClientRect().width;
        const style = getComputedStyle(button);
        return width > 0 && style.visibility === 'visible';
      });`;
      assert.deepEqual(await run(ada, sidebar), [true, true]);
      const emulation = { enabled: true, maxTouchPoints: 1 };
      await browser.request(
        'Emulation.setTouchEmulationEnabled',
        emulation,
        ada,
      );
      const touch = await run(
        ada,
        `const row = ${rowOf('my own line')};
      const tools = getComputedStyle(row.querySelector('.message-tools'));
      const time = getComputedStyle(row.querySelector('.time'));
      return [tools.display, time.visibility];`,
      );
      assert.deepEqual(touch, ['none', 'visible']);
      assert.deepEqual(await run(ada, sidebar), [true, true]);
      await run(
        ada,
        `const style = document.createElement('style');
      style.id = 'show-tools';
      style.textContent = ${JSON.stringify(SHOW_TOOLS)};
      document.head.append(style);
      return true;`,
      );
      const measure = (text) =>
        run(
          ada,
          `const row = ${rowOf(text)};
        const box = (selector) =>
          row.querySelector(selector).getBoundingClientRect();
        const rect = row.getBoundingClientRect();
        const shown = (button) => getComputedStyle(button).display !== 'none';
        const tools = [...row.querySelectorAll('.tool')].filter(shown);
        return {
          row: [rect.left, rect.right],
          author: [box('.author').left, box('.author').right],
          time: [box('.time').left, box('.time').right],
          tools: [box('.message-tools').left, box('.message-tools').right],
          actions: tools.map((button) => button.dataset.action),
        };`,
        );
      const own = await measure('my own line');
      const other = await measure('a line from bob');
      await run(ada, `document.getElementById('show-tools').remove();`);
      for (const geometry of [own, other]) {
        assert.ok(geometry.author[0] - geometry.row[0] <= 16, 'nick at left');
        assert.ok(geometry.row[1] - geometry.time[1] <= 12, 'time at right');
        assert.ok(Math.abs(geometry.tools[1] - geometry.time[1]) <= 4);
        assert.ok(geometry.tools[0] > geometry.author[1], 'tools clear nick');
      }
      assert.deepEqual(own.actions, OWN_TOOLS);
      assert.deepEqual(other.actions, OTHER_TOOLS);
    },
  );

  await t.test(
    'hover reveals zero counts only for reacted messages',
    async () => {
      const moveTo = async (selector) => {
        const point = await run(
          bob,
          `const element = ${selector};
        element.scrollIntoView({ block: 'nearest' });
        const { x, y, width, height } = element.getBoundingClientRect();
        return { x: x + width / 2, y: y + height / 2 };`,
        );
        const move = { type: 'mouseMoved', ...point };
        await browser.request('Input.dispatchMouseEvent', move, bob);
        await wait(bob, `return (${selector}).matches(':hover');`);
      };
      const row = rowOf('a line from bob');
      const content = `${row}.querySelector('.content')`;
      const chips = (session) =>
        run(
          session,
          `app.render();
        const row = ${row};
        return [...row.querySelectorAll('.reaction')].map((chip) => [
          chip.querySelector('.emoji').textContent,
          chip.dataset.count,
          chip.classList.contains('none'),
        ]);`,
        );
      await moveTo(content);
      assert.deepEqual(await chips(bob), []);
      const id = await idOf(ada, 'a line from bob');
      await tool(ada, 'a line from bob', 'menu');
      await run(
        ada,
        `app.menuElement.querySelector('[data-reaction="hundred"]').click();`,
      );
      const expected = REACTIONS.map((emoji) =>
        emoji === '💯' ? [emoji, '1', false] : [emoji, '0', true],
      );
      assert.deepEqual(await chips(ada), expected);
      const nine = `app.render();
      return ${row}
        .querySelectorAll('.reaction').length === ${REACTIONS.length};`;
      await wait(bob, nine);
      const like = `${row}.querySelector('[data-reaction="like"]')`;
      const hundred = `${row}.querySelector('[data-reaction="hundred"]')`;
      const display = (session, chip) =>
        run(session, `return getComputedStyle(${chip}).display;`);
      assert.equal(await display(ada, like), 'none');
      await moveTo('app.messageInput');
      assert.equal(await display(bob, like), 'none');
      assert.notEqual(await display(bob, hundred), 'none');
      await moveTo(content);
      assert.notEqual(await display(bob, like), 'none');
      const style = () =>
        run(
          bob,
          `const chip = ${like};
        const css = getComputedStyle(chip);
        const { backgroundColor, borderTopWidth, boxShadow } = css;
        const opacity = getComputedStyle(chip.querySelector('.emoji')).opacity;
        return { backgroundColor, borderTopWidth, boxShadow, opacity };`,
        );
      const zero = await style();
      assert.equal(zero.borderTopWidth, '0px');
      assert.equal(zero.boxShadow, 'none');
      assert.notEqual(zero.backgroundColor, 'rgba(0, 0, 0, 0)');
      assert.ok(Number(zero.opacity) < 1);
      await moveTo(like);
      const hovered = await style();
      assert.notEqual(hovered.backgroundColor, zero.backgroundColor);
      assert.equal(hovered.opacity, '1');
      await run(bob, `${like}.click(); return true;`);
      await wait(ada, `app.render(); return ${like}?.dataset.count === '1';`);
      await run(ada, `app.toggleReaction('${id}', 'hundred'); return true;`);
      await run(bob, `${like}.click(); return true;`);
      await wait(
        ada,
        `app.render();
      return ${rowOf('a line from bob')}
        .querySelectorAll('.reaction').length === 0;`,
      );
    },
  );

  await t.test('the message menu labels actions and shows icons', async () => {
    await tool(ada, 'my own line', 'menu');
    const menu = await run(
      ada,
      `const menu = app.menuElement;
      const reactions = [...menu.querySelectorAll('.menu-reactions button')];
      const actions = [...menu.querySelectorAll('.menu-item')];
      return {
        reactions: reactions.map((button) => button.textContent),
        labels: actions.map((button) => button.textContent.trim()),
        icons: actions.every((button) => button.querySelector('svg')),
      };`,
    );
    assert.deepEqual(menu.reactions, REACTIONS);
    assert.deepEqual(menu.labels, [
      'Reply',
      'Quote',
      'Thread',
      'Share',
      'Forward',
      'Edit',
      'Delete',
      'Select',
      'Pin',
      'Save message',
      'Follow thread',
      'Copy text',
    ]);
    assert.equal(menu.icons, true);
    await press(ada, 'Escape', 'document');
  });

  await t.test('a call record is a pill with the host nick', async () => {
    await run(
      bob,
      `const chat = await import('/chat.js');
      const id = 'pill-call';
      const timestamp = Date.now();
      chat.startCall(app.replica, {
        id, chat: app.chat, host: app.peerId, nick: 'bob', timestamp,
      });
      const ended = timestamp + 3 * 60 * 1000;
      chat.endCall(app.replica, id, { ended, peak: 2, names: 'bob, ada' });
      return true;`,
    );
    const card = `app.messageList.querySelector('[data-id="pill-call"]')`;
    const ended = `app.render(); return ${card}?.textContent.includes('min');`;
    await wait(ada, ended);
    const info = await run(
      ada,
      `const card = ${card};
      const width = app.messageList.getBoundingClientRect().width;
      return [card.textContent, card.getBoundingClientRect().width, width];`,
    );
    assert.equal(info[0], '📞 bob · 3 min · bob, ada');
    assert.ok(info[1] < info[2] / 2, 'the card fits its text');
  });

  await t.test(
    'edit own messages in place and keep the composer draft',
    async () => {
      const id = await idOf(ada, 'my own line');
      const other = await idOf(ada, 'a line from bob');
      await run(
        ada,
        `app.messageInput.value = 'draft text';
      app.saveDraft();
      app.startEdit('${other}');
      return true;`,
      );
      assert.equal(await run(ada, 'return app.editing;'), '');
      await run(ada, `app.selectById('${id}', false); return true;`);
      await press(ada, 'e');
      const state = await run(
        ada,
        `const row = app.itemOf('${id}');
      const editor = row.querySelector('.message-editor textarea');
      const visible = getComputedStyle(row.querySelector('.content')).display;
      return [app.editing, app.messageInput.value, editor.value,
        editor === document.activeElement, visible];`,
      );
      assert.deepEqual(state, [id, 'draft text', 'my own line', true, 'none']);
      await press(ada, 'Escape');
      const restored = await run(
        ada,
        `return [app.editing, app.messageInput.value,
        app.itemOf('${id}').querySelector('.message-editor') === null];`,
      );
      assert.deepEqual(restored, ['', 'draft text', true]);
      await tool(ada, 'my own line', 'edit');
      const afterRender = await run(
        ada,
        `const selector = '.message-editor textarea';
      const input = app.itemOf('${id}').querySelector(selector);
      input.value = 'my edited line';
      input.setSelectionRange(3, 3);
      app.toggleReaction('${id}', 'fire');
      app.render();
      const editor = app.itemOf('${id}').querySelector(selector);
      const focused = editor === document.activeElement;
      return [editor.value, editor.selectionStart, focused];`,
      );
      assert.deepEqual(afterRender, ['my edited line', 3, true]);
      await press(ada, 'Enter');
      const saved = await run(
        ada,
        `const record = app.replica.get('${id}');
      return [record.content, typeof record.edited, app.messageInput.value,
        app.drafts.get(app.chat)];`,
      );
      assert.deepEqual(saved, [
        'my edited line',
        'number',
        'draft text',
        'draft text',
      ]);
      await wait(
        bob,
        `app.render();
      return ${rowOf('my edited line')}
        ?.querySelector('.note').textContent === 'edited';`,
      );
      await run(ada, `app.messageInput.value = ''; app.saveDraft(); return 1;`);
    },
  );

  await t.test('delete own messages, a reply keeps a placeholder', async () => {
    await write(ada, 'ada', 'gone soon');
    await write(ada, 'ada', 'root to delete');
    await shown(bob, 'root to delete');
    await write(bob, 'bob', 'reply keeps it', 'root to delete');
    await shown(ada, 'reply keeps it');
    await shown(bob, 'gone soon');
    const gone = await idOf(ada, 'gone soon');
    const root = await idOf(ada, 'root to delete');
    assert.equal(
      await run(bob, `return app.deleteMessages(['${gone}']);`),
      false,
    );
    await tool(ada, 'gone soon', 'delete');
    await wait(bob, `app.render(); return !app.itemOf('${gone}');`);
    await run(ada, `return app.deleteMessages(['${root}']);`);
    await wait(
      bob,
      `app.render();
      const row = app.itemOf('${root}');
      return row?.classList.contains('deleted') &&
        row.querySelector('.note').textContent === 'message deleted';`,
    );
    const thread = await run(
      bob,
      `const root = app.itemOf('${root}');
      const reply = ${rowOf('reply keeps it')};
      app.openMenuFor(root);
      return [root.style.getPropertyValue('--thread'),
        reply.style.getPropertyValue('--thread'),
        root.querySelector('.content').textContent, app.menu.isOpen];`,
    );
    assert.notEqual(thread[0], '');
    assert.equal(thread[0], thread[1]);
    assert.equal(thread[2], '');
    assert.equal(thread[3], false);
  });

  await t.test(
    'a thread selection tints rows and clicking the chosen row exits',
    async () => {
      const reply = rowOf('reply keeps it');
      await run(bob, `${reply}.querySelector('.content').click(); return 1;`);
      const rows = await run(
        bob,
        `const rows = [${reply}, ${rowOf('a line from bob')}];
      const colors = rows.map((row) => getComputedStyle(row).backgroundColor);
      const copy = colors.slice();
      copy.push(rows[0].classList.contains('inside'));
      return copy;`,
      );
      assert.notEqual(rows[0], 'rgba(0, 0, 0, 0)');
      assert.notEqual(rows[0], rows[1]);
      assert.equal(rows[2], true);
      const root = 'app.itemOf(app.selection.root)';
      const click = (row) =>
        run(bob, `${row}.querySelector('.line').click(); return 1;`);
      await click(root);
      assert.equal(
        await run(bob, `return ${root}.classList.contains('chosen');`),
        true,
      );
      await click(root);
      await wait(bob, 'return app.selection === null && app.pops === 0;');
    },
  );

  await t.test('copy link opens the chat at the message', async () => {
    const id = await idOf(bob, 'a line from bob');
    await tool(bob, 'a line from bob', 'share');
    await wait(bob, 'return typeof window.copied === "string";');
    const url = new URL(await run(bob, 'return window.copied;'));
    assert.equal(url.origin, ORIGIN);
    assert.equal(url.searchParams.get('chat'), general);
    assert.equal(url.searchParams.get('message'), id);
    const carol = await open(url.href);
    await wait(
      carol,
      `return app.chat === ${JSON.stringify(general)} &&
        app.linked === '' && location.search === '' &&
        app.itemOf('${id}') !== null;`,
    );
  });

  await t.test(
    'forward a message to another chat with its origin',
    async () => {
      await run(
        ada,
        `app.chatNameInput.value = 'dev';
      app.addChannel('chat', app.chatNameInput);
      return true;`,
      );
      const dev = await run(ada, 'return app.chat;');
      await run(ada, `app.selectChat(${JSON.stringify(general)}); return 1;`);
      await shown(ada, 'a line from bob');
      const original = await idOf(ada, 'a line from bob');
      await tool(ada, 'a line from bob', 'forward');
      const picker = await run(
        ada,
        `const box = document.getElementById('switcher');
      const names = [...box.querySelectorAll('li .name')];
      return [app.switcher.isOpen, box.querySelector('input').placeholder,
        names.map((name) => name.textContent)];`,
      );
      assert.equal(picker[0], true);
      assert.equal(picker[1], 'Forward 1 message to');
      assert.ok(picker[2].includes('!dev'));
      assert.ok(!picker[2].includes('!general'));
      await run(
        ada,
        `[...document.querySelectorAll('#switcher li')]
        .find((item) => item.querySelector('.name')?.textContent === '!dev')
        .click();
      return true;`,
      );
      const copy = await run(
        ada,
        `const records = [...app.replica.keys('message')]
        .map((id) => app.replica.get(id));
      const copy = records.find((record) => record.chat === '${dev}');
      return [app.switcher.isOpen, app.chat, copy?.content, copy?.forwarded,
        copy?.origin, copy?.author === app.peerId, copy?.nick];`,
      );
      assert.deepEqual(copy, [
        false,
        general,
        'a line from bob',
        original,
        'bob',
        true,
        'ada',
      ]);
      await run(ada, `app.selectChat('${dev}'); return true;`);
      await wait(
        ada,
        `app.render();
      return ${rowOf('a line from bob')}
        ?.querySelector('.origin').textContent === 'from bob';`,
      );
      await run(
        ada,
        `${rowOf('a line from bob')}.querySelector('.forwarded').click();
      return true;`,
      );
      await wait(
        ada,
        `return app.chat === ${JSON.stringify(general)} && app.linked === '';`,
      );
    },
  );

  await t.test('pick messages to copy, forward, or delete', async () => {
    const state = () =>
      run(
        ada,
        `return [app.pickBar.classList.contains('hidden'),
          app.pickCount.textContent, app.pickDelete.disabled,
          app.messageList.querySelectorAll('.picked').length];`,
      );
    const click = (text, shiftKey = false) =>
      run(
        ada,
        `${rowOf(text)}.querySelector('.content').dispatchEvent(
          new MouseEvent('click', { bubbles: true, shiftKey: ${shiftKey} }));
        return true;`,
      );
    await shown(ada, 'reply keeps it');
    await tool(ada, 'my edited line', 'menu');
    await run(
      ada,
      `document.querySelector('#menu [data-action="pick"]').click();`,
    );
    assert.deepEqual(await state(), [false, '1 selected', false, 1]);
    await click('a line from bob');
    assert.deepEqual(await state(), [false, '2 selected', true, 2]);
    await click('a line from bob');
    assert.deepEqual(await state(), [false, '1 selected', false, 1]);
    await click('a line from bob');
    await click('reply keeps it', true);
    assert.deepEqual(await state(), [false, '3 selected', true, 3]);
    assert.equal(await run(ada, 'return app.selection;'), null);
    await run(ada, `app.pickCopy.click(); return true;`);
    await wait(ada, `return window.copied.startsWith('ada: my edited');`);
    assert.equal(
      await run(ada, 'return window.copied;'),
      'ada: my edited line\nbob: a line from bob\nbob: reply keeps it',
    );
    const closed = await state();
    assert.deepEqual([closed[0], closed[3]], [true, 0]);
    await wait(ada, 'return app.pops === 0;');
    const id = await idOf(ada, 'my edited line');
    await run(ada, `app.startPicking('${id}'); return true;`);
    await press(ada, 'Escape', 'document');
    assert.equal(await run(ada, 'return app.picked;'), null);
    await wait(ada, 'return app.pops === 0;');
    await run(ada, `app.startPicking('${id}'); return true;`);
    await click('a line from bob');
    await run(ada, 'app.pickForward.click(); return true;');
    await wait(ada, 'return app.switcher.isOpen;');
    const forward = await run(
      ada,
      `const input = document.querySelector('#switcher input');
      return [app.picked, input.placeholder, app.forwarding.length];`,
    );
    assert.deepEqual(forward, [null, 'Forward 2 messages to', 2]);
    await press(ada, 'Escape', 'document');
    await wait(ada, 'return !app.switcher.isOpen && app.pops === 0;');
    assert.equal(await run(ada, 'return app.forwarding.length;'), 0);
    await run(ada, `app.startPicking('${id}'); return true;`);
    await run(ada, `app.pickDelete.click(); return true;`);
    await wait(ada, `app.render(); return !app.itemOf('${id}');`);
    assert.equal(await run(ada, 'return app.picked;'), null);
  });
});
