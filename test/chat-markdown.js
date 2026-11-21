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
const CODE = 'const x = 1; // note';
const WIDE_CODE = `const wide = '${'w'.repeat(220)}';`;
const WIDE_CELLS = Array.from({ length: 8 }, () => 'x'.repeat(24));
const WIDE_ROW = `| ${WIDE_CELLS.join(' | ')} |`;

const WIDE_TABLE = [
  `| ${Array.from({ length: 8 }, (_, i) => `column${i}`).join(' | ')} |`,
  `|${'---|'.repeat(8)}`,
  WIDE_ROW,
  WIDE_ROW,
].join('\n');

const RICH = [
  '# Heading',
  '',
  '**bold** *italic* ~~strike~~ `inline` [link](https://example.com/x)',
  '![pic](https://example.com/i.png "Pic")',
  '',
  '- one',
  '  - nested',
  '- two',
  '',
  '- [x] done',
  '- [ ] todo',
  '',
  '> quoted',
  '',
  '---',
  '',
  '| h1 | h2 |',
  '|:--|--:|',
  '| c1 | c2 |',
  '',
  '```js',
  CODE,
  '```',
].join('\n');

test('Markdown in Chrome', { timeout: 180000 }, async (t) => {
  const dataPath = await fs.mkdtemp(path.join(os.tmpdir(), 'xxii-data-'));
  t.after(() => fs.rm(dataPath, { recursive: true, force: true }));
  const server = await startServer(dataPath);
  t.after(() => stopServer(server));
  const browser = await launch(t);

  const run = (session, body) => harness.run(browser, session, body);
  const wait = (session, body) => harness.wait(browser, session, body);

  const resize = (session, size) =>
    browser.request(
      'Emulation.setDeviceMetricsOverride',
      { ...size, deviceScaleFactor: 1, mobile: false },
      session,
    );

  const open = async () => {
    const created = await browser.request('Target.createBrowserContext');
    const { browserContextId } = created;
    const params = { url: `${ORIGIN}/`, browserContextId };
    const { targetId } = await browser.request('Target.createTarget', params);
    const attach = { targetId, flatten: true };
    const target = await browser.request('Target.attachToTarget', attach);
    const { sessionId } = target;
    await browser.request('Runtime.enable', {}, sessionId);
    await browser.request('Page.enable', {}, sessionId);
    await browser.request('Page.bringToFront', {}, sessionId);
    await resize(sessionId, DESKTOP);
    await wait(sessionId, 'return app.uplink?.link.source !== "";');
    await run(
      sessionId,
      `navigator.clipboard.writeText = async (text) => {
        window.copied = text;
      };
      return true;`,
    );
    return sessionId;
  };

  const write = (session, nick, content) =>
    run(
      session,
      `app.username = ${JSON.stringify(nick)};
      app.writeMessage(app.chat, ${JSON.stringify(content)}, undefined, []);
      return true;`,
    );

  const idOf = (session, content) =>
    run(
      session,
      `return [...app.replica.keys('message')].find((id) =>
        app.replica.get(id).content === ${JSON.stringify(content)});`,
    );

  const rowOf = (id) =>
    `app.messageList.querySelector('.message[data-id="${id}"]')`;

  const waitMessage = async (session, content) => {
    await wait(
      session,
      `app.render();
      const id = [...app.replica.keys('message')].find((key) =>
        app.replica.get(key).content === ${JSON.stringify(content)});
      return Boolean(id && app.messageList.querySelector(
        '.message[data-id="' + id + '"]'));`,
    );
    return idOf(session, content);
  };

  const key = (session, params) =>
    browser.request('Input.dispatchKeyEvent', params, session);

  const pressKey = async (session, name, extra = {}) => {
    await key(session, { type: 'keyDown', key: name, ...extra });
    await key(session, { type: 'keyUp', key: name, ...extra });
  };

  const pressEnter = (session) =>
    pressKey(session, 'Enter', {
      code: 'Enter',
      windowsVirtualKeyCode: 13,
      text: '\r',
    });

  const pressCtrl = (session, letter) =>
    pressKey(session, letter, {
      code: `Key${letter.toUpperCase()}`,
      windowsVirtualKeyCode: letter.toUpperCase().charCodeAt(0),
      modifiers: 2,
    });

  const click = async (session, selector) => {
    const point = await run(
      session,
      `const node = document.querySelector(${JSON.stringify(selector)});
      node.scrollIntoView({ block: 'center' });
      const rect = node.getBoundingClientRect();
      return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };`,
    );
    const base = { ...point, button: 'left', clickCount: 1 };
    const send = (type) =>
      browser.request('Input.dispatchMouseEvent', { type, ...base }, session);
    await send('mouseMoved');
    await send('mousePressed');
    await send('mouseReleased');
  };

  const ada = await open();
  const bob = await open();

  await write(ada, 'ada', RICH);
  const richId = await waitMessage(bob, RICH);
  await waitMessage(ada, RICH);
  const rich = `${rowOf(richId)}.querySelector('.content')`;

  await t.test('a rich message renders on the other peer', async () => {
    const found = await run(
      bob,
      `const content = ${rich};
      const q = (selector) => content.querySelector(selector);
      const all = (selector) => content.querySelectorAll(selector);
      const boxes = [...all('input[type="checkbox"]')];
      const cells = [...all('td, th')].map((cell) => cell.textContent);
      const image = q('a[href="https://example.com/i.png"]');
      return {
        isDiv: content.tagName === 'DIV',
        isMd: content.classList.contains('md'),
        h1: q('h1')?.textContent,
        strong: q('strong')?.textContent,
        em: q('em')?.textContent,
        del: q('del')?.textContent,
        inline: q('p code')?.textContent,
        nested: q('ul ul li')?.textContent,
        boxes: boxes.map((box) => [box.checked, box.disabled]),
        quote: q('blockquote')?.textContent,
        rule: Boolean(q('hr')),
        cells,
        align: [...all('th')].map((cell) => cell.style.textAlign),
        wrapper: Boolean(q('div.md-table > table')),
        link: q('a[href="https://example.com/x"]')?.textContent,
        rel: q('a[href="https://example.com/x"]')?.rel,
        target: q('a[href="https://example.com/x"]')?.target,
        image: image?.textContent,
        imageTitle: image?.title,
        images: all('img').length,
        lang: q('.code-lang')?.textContent,
        copy: q('button.code-copy')?.textContent,
        code: q('pre code')?.textContent,
        keyword: q('pre .tok-keyword')?.textContent,
        number: q('pre .tok-number')?.textContent,
        comment: q('pre .tok-comment')?.textContent,
        raw: app.replica.get(${JSON.stringify(richId)}).content,
      };`,
    );
    assert.equal(found.isDiv, true);
    assert.equal(found.isMd, true);
    assert.equal(found.h1, 'Heading');
    assert.equal(found.strong, 'bold');
    assert.equal(found.em, 'italic');
    assert.equal(found.del, 'strike');
    assert.equal(found.inline, 'inline');
    assert.equal(found.nested, 'nested');
    assert.deepEqual(found.boxes, [
      [true, true],
      [false, true],
    ]);
    assert.equal(found.quote, 'quoted');
    assert.equal(found.rule, true);
    assert.deepEqual(found.cells, ['h1', 'h2', 'c1', 'c2']);
    assert.deepEqual(found.align, ['left', 'right']);
    assert.equal(found.wrapper, true);
    assert.equal(found.link, 'link');
    assert.equal(found.rel, 'noopener noreferrer');
    assert.equal(found.target, '_blank');
    assert.equal(found.image, '🖼 pic');
    assert.equal(found.imageTitle, 'Pic');
    assert.equal(found.images, 0);
    assert.equal(found.lang, 'js');
    assert.equal(found.copy, 'copy');
    assert.equal(found.code, CODE);
    assert.equal(found.keyword, 'const');
    assert.equal(found.number, '1');
    assert.equal(found.comment, '// note');
    assert.equal(found.raw, RICH);
  });

  await t.test('unsafe links and raw HTML render as text', async () => {
    const source = [
      '[click](javascript:window.pwned=1) [data](data:text/html,x)',
      '<img src=x onerror="window.pwned=1"> <b>raw</b>',
    ].join('\n');
    await write(ada, 'ada', source);
    const id = await waitMessage(bob, source);
    const found = await run(
      bob,
      `const content = ${rowOf(id)}.querySelector('.content');
      return {
        anchors: content.querySelectorAll('a').length,
        images: content.querySelectorAll('img, b').length,
        text: content.textContent,
        pwned: window.pwned ?? null,
        isMd: content.classList.contains('md'),
      };`,
    );
    assert.equal(found.anchors, 0);
    assert.equal(found.images, 0);
    assert.equal(found.pwned, null);
    assert.ok(found.text.includes('click'));
    assert.ok(found.text.includes('<img src=x onerror="window.pwned=1">'));
    assert.ok(found.text.includes('<b>raw</b>'));
  });

  await t.test('a one-line message keeps the old DOM', async () => {
    const plain = 'just a plain line, nothing special';
    await write(ada, 'ada', plain);
    const id = await waitMessage(bob, plain);
    const found = await run(
      bob,
      `const content = ${rowOf(id)}.querySelector('.content');
      return [content.className, content.childNodes.length,
        content.firstChild.nodeType, content.textContent];`,
    );
    assert.deepEqual(found, ['content', 1, 3, plain]);
    const url = 'see https://example.com/a_b and more';
    await write(ada, 'ada', url);
    const linked = await waitMessage(bob, url);
    const nodes = await run(
      bob,
      `const content = ${rowOf(linked)}.querySelector('.content');
      return [...content.childNodes].map((node) => node.nodeName);`,
    );
    assert.deepEqual(nodes, ['#text', 'A', '#text']);
    const inlineSource = 'one **bold** word';
    await write(ada, 'ada', inlineSource);
    const bold = await waitMessage(bob, inlineSource);
    const inline = await run(
      bob,
      `const content = ${rowOf(bold)}.querySelector('.content');
      return [content.className, content.querySelector('strong')?.textContent,
        content.children.length];`,
    );
    assert.deepEqual(inline, ['content', 'bold', 1]);
  });

  await t.test('copy, links, and checkboxes do not select', async () => {
    const hint = await run(bob, 'return app.messageInput.placeholder;');
    const state = `return [app.selection === null, app.picked === null,
      app.messageInput.placeholder === ${JSON.stringify(hint)}];`;
    const row = `.message[data-id="${richId}"]`;
    await run(
      bob,
      `app.username = 'bob';
      app.writeMessage(app.chat, 'rich reply', ${JSON.stringify(richId)}, []);
      return true;`,
    );
    await waitMessage(bob, 'rich reply');
    await click(bob, `${row} .code-copy`);
    await wait(bob, `return window.copied === ${JSON.stringify(CODE)};`);
    const label = await run(
      bob,
      `return ${rowOf(richId)}.querySelector('.code-copy').textContent;`,
    );
    assert.equal(label, 'copied');
    assert.deepEqual(await run(bob, state), [true, true, true]);
    await wait(
      bob,
      `return ${rowOf(richId)}.querySelector('.code-copy').textContent
        === 'copy';`,
    );
    await run(
      bob,
      `const link = ${rowOf(richId)}.querySelector('a[href]');
      link.addEventListener('click', (event) => event.preventDefault());
      link.click();
      return true;`,
    );
    assert.deepEqual(await run(bob, state), [true, true, true]);
    await click(bob, `${row} input[type="checkbox"]`);
    assert.deepEqual(await run(bob, state), [true, true, true]);
    await click(bob, `${row} blockquote`);
    await wait(bob, 'return app.selection !== null;');
    await run(bob, 'app.closeThread(); return true;');
  });

  await t.test('a drag selection keeps working for Quote', async () => {
    const quoted = await run(
      bob,
      `const node = ${rowOf(richId)}.querySelector('strong');
      const range = document.createRange();
      range.selectNodeContents(node);
      const selection = getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
      return selection.toString();`,
    );
    assert.equal(quoted, 'bold');
    await run(bob, 'getSelection().removeAllRanges(); return true;');
  });

  await t.test('Enter inside an unclosed fence adds a newline', async () => {
    await run(
      ada,
      `app.usernameInput.value = 'ada';
      app.messageInput.value = '\`\`\`js\\nlet a = 1;';
      app.messageInput.focus();
      app.messageInput.setSelectionRange(100, 100);
      return true;`,
    );
    await pressEnter(ada);
    const kept = await run(
      ada,
      `return [app.messageInput.value, app.messageInput.selectionStart];`,
    );
    assert.equal(kept[0], '```js\nlet a = 1;\n');
    const closed = '```js\nlet a = 1;\n```';
    await run(
      ada,
      `app.messageInput.value = ${JSON.stringify(closed)};
      app.messageInput.setSelectionRange(100, 100);
      return true;`,
    );
    await pressEnter(ada);
    await wait(ada, `return app.messageInput.value === '';`);
    await waitMessage(ada, closed);
    await run(
      ada,
      `app.messageInput.value = '\`\`\`\\nopen';
      app.messageInput.setSelectionRange(100, 100);
      return true;`,
    );
    await pressKey(ada, 'Enter', {
      code: 'Enter',
      windowsVirtualKeyCode: 13,
      modifiers: 2,
    });
    await wait(ada, `return app.messageInput.value === '';`);
    await waitMessage(ada, '```\nopen');
  });

  await t.test('the in-place editor follows the same rule', async () => {
    const own = 'edit me please';
    await write(ada, 'ada', own);
    const id = await waitMessage(ada, own);
    await run(ada, `app.startEdit(${JSON.stringify(id)}); return true;`);
    await run(
      ada,
      `app.editInput.value = '\`\`\`\\nx';
      app.editInput.focus();
      app.editInput.setSelectionRange(100, 100);
      return true;`,
    );
    await pressEnter(ada);
    const open = await run(ada, `return [app.editing, app.editInput.value];`);
    assert.deepEqual(open, [id, '```\nx\n']);
    await run(
      ada,
      `app.editInput.value = '\`\`\`\\nx\\n\`\`\`';
      app.editInput.setSelectionRange(100, 100);
      return true;`,
    );
    await pressEnter(ada);
    await wait(ada, `return app.editing === '';`);
    await wait(
      ada,
      `return app.replica.get(${JSON.stringify(id)})
      .content === '\`\`\`\\nx\\n\`\`\`';`,
    );
  });

  await t.test('Ctrl+B and Ctrl+I wrap the selection', async () => {
    await run(
      ada,
      `app.messageInput.value = 'say hello world';
      app.messageInput.focus();
      app.messageInput.setSelectionRange(4, 9);
      return true;`,
    );
    await pressCtrl(ada, 'b');
    const bold = await run(
      ada,
      `const input = app.messageInput;
      return [input.value, input.value.slice(input.selectionStart,
        input.selectionEnd)];`,
    );
    assert.deepEqual(bold, ['say **hello** world', 'hello']);
    await run(
      ada,
      `app.messageInput.value = '';
      app.messageInput.setSelectionRange(0, 0);
      return true;`,
    );
    await pressCtrl(ada, 'i');
    const empty = await run(
      ada,
      `return [app.messageInput.value, app.messageInput.selectionStart];`,
    );
    assert.deepEqual(empty, ['__', 1]);
    await run(ada, `app.messageInput.value = ''; return true;`);
  });

  await t.test('replies and pins show plain text', async () => {
    const source = '**bold** and `code` [link](https://example.com)';
    await write(ada, 'ada', source);
    const id = await waitMessage(bob, source);
    await run(
      bob,
      `app.usernameInput.value = 'bob';
      app.startReply(${JSON.stringify(id)});
      return true;`,
    );
    const bar = await run(bob, 'return app.replyText.textContent;');
    assert.equal(bar, 'bold and code link');
    await run(
      bob,
      `app.cancelReply();
      app.startQuotedReply(${JSON.stringify(id)});
      app.messageInput.value = 'answer';
      await app.sendMessage();
      return true;`,
    );
    await waitMessage(bob, 'answer');
    const label = await run(
      bob,
      `const reply = [...app.messageList.querySelectorAll('.message')]
        .find((row) => row.querySelector('.content')?.textContent === 'answer');
      return reply.querySelector('.quote-text').textContent;`,
    );
    assert.equal(label, 'bold and code link');
    await run(bob, `app.togglePin(${JSON.stringify(id)}); return true;`);
    await wait(
      bob,
      `app.togglePanel('pins');
      app.renderPins();
      const pin = app.pinList.querySelector('.pin-item .text');
      return pin?.textContent === 'bold and code link';`,
    );
    await run(bob, `app.closePanel(); return true;`);
  });

  await t.test('wide code and tables scroll inside the row', async () => {
    const general = await run(bob, 'return app.chat;');
    await run(
      bob,
      `if (app.chat !== ${JSON.stringify(general)}) {
        app.selectChat(${JSON.stringify(general)});
      }
      return true;`,
    );
    const source = `${WIDE_TABLE}\n\n\`\`\`js\n${WIDE_CODE}\n\`\`\``;
    await write(ada, 'ada', source);
    const id = await waitMessage(bob, source);
    await resize(bob, PHONE);
    const found = await run(
      bob,
      `const row = ${rowOf(id)};
      row.scrollIntoView({ block: 'center' });
      const pre = row.querySelector('pre');
      const block = row.querySelector('.code-block');
      const table = row.querySelector('.md-table');
      const root = document.documentElement;
      return {
        page: root.scrollWidth <= window.innerWidth,
        row: row.getBoundingClientRect().right <= window.innerWidth,
        preScroll: pre.scrollWidth > pre.clientWidth,
        preOverflow: getComputedStyle(pre).overflowX,
        tableScroll: table.scrollWidth > table.clientWidth,
        tableOverflow: getComputedStyle(table).overflowX,
        preFits: pre.getBoundingClientRect().right <= window.innerWidth,
        tableFits: table.getBoundingClientRect().right <= window.innerWidth,
        codeBorder: getComputedStyle(block).borderWidth,
        cellBorders: [...table.querySelectorAll('th, td')].map(
          (cell) => getComputedStyle(cell).borderWidth,
        ),
        codeBg: getComputedStyle(block).backgroundColor,
        rowBg: getComputedStyle(row).backgroundColor,
        cellBgs: [...table.querySelectorAll('th, td')].map(
          (cell) => getComputedStyle(cell).backgroundColor,
        ),
      };`,
    );
    await resize(bob, DESKTOP);
    assert.equal(found.page, true);
    assert.equal(found.row, true);
    assert.equal(found.preScroll, true);
    assert.equal(found.preOverflow, 'auto');
    assert.equal(found.tableScroll, true);
    assert.equal(found.tableOverflow, 'auto');
    assert.equal(found.preFits, true);
    assert.equal(found.tableFits, true);
    assert.equal(found.codeBorder, '0px');
    assert.ok(found.cellBorders.length > 0);
    for (const width of found.cellBorders) assert.equal(width, '0px');
    assert.notEqual(found.codeBg, found.rowBg);
    assert.notEqual(found.codeBg, 'rgba(0, 0, 0, 0)');
    assert.ok(new Set(found.cellBgs).size >= 3);
  });

  await t.test('colors are defined for both palettes', async () => {
    const styles = await run(
      bob,
      `const read = () => {
        const style = getComputedStyle(document.documentElement);
        return ['keyword', 'string', 'number', 'comment', 'function', 'type',
          'literal', 'operator', 'punctuation', 'property', 'tag', 'attr',
          'meta', 'regexp', 'inserted', 'deleted']
          .map((name) => style.getPropertyValue('--tok-' + name).trim());
      };
      const dark = read();
      document.documentElement.dataset.theme = 'light';
      const light = read();
      delete document.documentElement.dataset.theme;
      return { dark, light };`,
    );
    for (const color of [...styles.dark, ...styles.light]) {
      assert.match(color, /^#[0-9a-f]{6}$/);
    }
    assert.notDeepEqual(styles.dark, styles.light);
  });

  await t.test('a post shows Markdown in the article only', async () => {
    await run(
      ada,
      `app.feedNameInput.value = '📣 notes';
      app.addChannel('feed', app.feedNameInput);
      return true;`,
    );
    const body = [
      '## Intro',
      '**bold** and [site](https://example.com)',
      '',
      '- first',
      '',
      '### Deep',
      'text',
      '',
      '#### Skipped',
    ].join('\n');
    await run(
      ada,
      `app.usernameInput.value = 'ada';
      app.messageInput.value = 'Notes\\n' + ${JSON.stringify(body)};
      await app.sendMessage();
      return true;`,
    );
    await wait(
      ada,
      `app.render(); return Boolean(document.querySelector('.post'));`,
    );
    const card = await run(
      ada,
      `const excerpt = document.querySelector('.post .excerpt').textContent;
      return [excerpt, document.querySelectorAll('.post strong, .post a')
        .length];`,
    );
    assert.ok(card[0].includes('Intro'));
    assert.ok(card[0].includes('bold and site'));
    assert.ok(!card[0].includes('**'));
    assert.ok(!card[0].includes('##'));
    assert.equal(card[1], 0);
    await run(
      ada,
      `app.openArticle(document.querySelector('.post').dataset.id);
      return true;`,
    );
    const article = await run(
      ada,
      `const text = document.querySelector('.post-article .post-text');
      const outline = '.post-article .outline button';
      const links = [...document.querySelectorAll(outline)];
      return {
        strong: text.querySelector('strong')?.textContent,
        anchor: text.querySelector('a')?.href,
        list: text.querySelector('ul li')?.textContent,
        headings: [...text.querySelectorAll('[data-heading]')]
          .map((node) => [node.tagName, node.textContent]),
        outline: links.map((link) => link.textContent),
        skipped: text.querySelector('h4')?.hasAttribute('data-heading'),
      };`,
    );
    assert.equal(article.strong, 'bold');
    assert.equal(article.anchor, 'https://example.com/');
    assert.equal(article.list, 'first');
    assert.deepEqual(article.headings, [
      ['H2', 'Intro'],
      ['H3', 'Deep'],
    ]);
    assert.deepEqual(article.outline, ['→ Intro', '→ Deep']);
    assert.equal(article.skipped, false);
    await run(ada, `app.closeArticle(); return true;`);
  });
});
