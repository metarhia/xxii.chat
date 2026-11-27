'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { setTimeout: delay } = require('node:timers/promises');
const harness = require('./harness.js');
const { fixture } = require('./recording-edit-fixture.js');

const q = JSON.stringify;
const modal = (title) => {
  const selector = `dialog[open][aria-label="${title}"]`;
  return `document.querySelector(${q(selector)})`;
};
const modalText = (text) => `
  const dialog = document.querySelector('dialog[open]');
  return dialog?.textContent.includes(${q(text)});
`;
const choose = (label) => `
  const buttons = document.querySelectorAll('dialog[open] button');
  const label = ${q(label)};
  const action = [...buttons].find((node) => node.textContent.trim() === label);
  action.click();
`;
const statusIs = (text) => `
  const status = document.querySelector('dialog[open] [role=status]');
  return status?.textContent.includes(${q(text)});
`;

const open = async (browser, path = '/') => {
  const context = await browser.request('Target.createBrowserContext');
  const { browserContextId } = context;
  const { targetId } = await browser.request('Target.createTarget', {
    url: harness.ORIGIN + path,
    browserContextId,
  });
  const { sessionId } = await browser.request('Target.attachToTarget', {
    targetId,
    flatten: true,
  });
  const isWatch = path.startsWith('/watch.html');
  const run = (code) => {
    if (!isWatch) return harness.run(browser, sessionId, code);
    return browser.evaluate(sessionId, `(async () => { ${code} })()`);
  };
  const wait = async (code, ms = 15000) => {
    if (!isWatch) {
      await harness.wait(browser, sessionId, code, ms);
      return;
    }
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      if (await run(code).catch(() => false)) return;
      await delay(100);
    }
    throw new Error(`Watch condition timed out: ${code}`);
  };
  return { sessionId, browserContextId, run, wait };
};

const identify = async (tab, nick) => {
  await tab.wait('return app.recordings && app.connected;');
  return tab.run(`
    app.usernameInput.value = ${q(nick)};
    app.syncUsername();
    return app.peerId;
  `);
};

test('captions and chapters follow cuts and speed changes', async () => {
  const { captionCues, remapTracks, vttOf } =
    await import('../application/static/video-metadata.js');
  const captions = [
    '1',
    '00:00:00,500 --> 00:00:03,000',
    '<b>One &amp; two</b>',
  ].join('\n');
  const chapters = [
    { at: 800, title: 'First' },
    { at: 1500, title: 'Cut' },
    { at: 2200, title: 'Second' },
  ];
  const kept = [
    { start: 600, end: 1000 },
    { start: 2000, end: 2800 },
  ];
  const result = remapTracks(
    { chapters, cues: captionCues(captions) },
    kept,
    2,
  );
  assert.deepEqual(result, {
    chapters: [
      { at: 100, title: 'First' },
      { at: 300, title: 'Second' },
    ],
    cues: [
      { start: 0, end: 200, text: 'One & two' },
      { start: 200, end: 600, text: 'One & two' },
    ],
  });
  assert.deepEqual(captionCues(vttOf(result.cues)), result.cues);
});

test(
  'contact, chat collection, and video publishing flows',
  {
    timeout: 140000,
  },
  async (t) => {
    await harness.startCallServer(t);
    const browser = await harness.launch(t, harness.MEDIA_FLAGS);
    const ada = await open(browser);
    const lin = await open(browser);
    const adaId = await identify(ada, 'Ada');
    const linId = await identify(lin, 'Lin');

    await t.test(
      'invites open a request that travels over the direct link',
      async () => {
        const url = await ada.run(`
      app.inviteBtn.click();
      return document.querySelector('[aria-label="Contact link"]').value;
    `);
        assert.equal(new URL(url).searchParams.get('contact'), adaId);
        await ada.run('document.querySelector("dialog[open]").close();');
        await browser.request('Page.navigate', { url }, lin.sessionId);
        await lin.wait(`return ${modal('Request contact')};`);
        await lin.run(choose('Send request'));
        await ada.run(`app.selectDirect(${q(linId)});`);
        await ada.wait('return app.contactState(app.chat) === "incoming";');
        assert.equal(
          await ada.run('return app.composer.classList.contains("hidden");'),
          true,
        );
        await ada.run(`
      [...app.requestBar.querySelectorAll('button')]
        .find((button) => button.textContent === 'Accept').click();
    `);
        await lin.wait('return app.contactState(app.chat) === "";');
        await lin.run(
          `app.messageInput.value = 'Hello Ada'; await app.sendMessage();`,
        );
        await ada.wait(
          'return app.messageList.textContent.includes("Hello Ada");',
        );
        await Promise.all([
          ada.run('app.selectChat("general");'),
          lin.run('app.selectChat("general");'),
        ]);
      },
    );

    await t.test('mentions, saved messages and followed threads', async () => {
      const id = await lin.run(`
      return app.writeMessage("general", "A thread with a useful link https://example.com/",
        "", []);
    `);
      await ada.wait(`return app.view.records.has(${q(id)});`);
      await ada.run(`
      app.saveMessage(${q(id)});
      app.followMessage(${q(id)});
      app.collections.openSaved();
    `);
      await ada.wait(modalText('useful link'));
      await ada.run('document.querySelector("dialog[open]").close();');
      await lin.run(`
      app.writeMessage("general", "A reply for [@Ada](/?mention=${adaId})",
        ${q(id)}, []);
    `);
      await ada.wait('return document.querySelector(".message.mentioned a");');
      await ada.run('app.collections.openFollowed();');
      await ada.wait(modalText('1 new'));
      await ada.run('document.querySelector("dialog[open]").close();');
      await ada.run(`
      app.collections.openMedia();
      const category = document.querySelector('dialog[open] select');
      category.value = 'Links';
      category.dispatchEvent(new Event('change'));
    `);
      await ada.wait(
        'return document.querySelector("dialog[open] a").href === "https://example.com/";',
      );
      await ada.run('document.querySelector("dialog[open]").close();');
    });

    await t.test(
      'voice and circle recordings arrive as playable chat media',
      async () => {
        for (const [kind, selector] of [
          ['voice', 'audio'],
          ['circle', 'video'],
        ]) {
          await ada.run(`app.openNote(${q(kind)});`);
          await ada.wait(statusIs('Recording'));
          await delay(650);
          await ada.run(`
        [...document.querySelectorAll('dialog[open] button')]
          .find((button) => button.textContent === 'Stop').click();
      `);
          await ada.wait(statusIs('Preview'));
          await ada.run(`
        [...document.querySelectorAll('dialog[open] button')]
          .find((button) => button.textContent === 'Use recording').click();
        await app.sendMessage();
      `);
          await lin.wait(
            `return document.querySelector(".${kind}-note button");`,
          );
          await lin.run(
            `document.querySelector(".${kind}-note button").click();`,
          );
          await lin.wait(
            `const media = document.querySelector('.${kind}-note ${selector}');
             return media.readyState > 0;`,
          );
        }
      },
    );

    await t.test(
      'publish, caption search, timestamp and personal video lists',
      async () => {
        await browser.request('Page.bringToFront', {}, ada.sessionId);
        await ada.run(`
      const clip = await (${fixture})('video/mp4');
      const data = new DataTransfer();
      const file = new File([clip], 'Training.mp4', { type: 'video/mp4' });
      data.items.add(file);
      document.querySelector('#recordings-btn').click();
      const input = document.querySelector('#recordings-files');
      input.files = data.files;
      input.dispatchEvent(new Event('change', { bubbles: true }));
    `);
        await ada.wait('return document.querySelector(".recording-more");');
        await ada.run(`
      document.querySelector('.recording-more').click();
      document.querySelector('.recording-menu [data-action="publish"]').click();
    `);
        await ada.wait(`return ${modal('Publish video')};`);
        await ada.run(`
      const modal = document.querySelector('dialog[open]');
      modal.querySelector('input:not([type=file])').value = 'A lesson';
      modal.querySelector('textarea[placeholder]').value = '00:02 Next step';
      const caption = ['WEBVTT', '', '00:00:01.500 --> 00:00:03.000',
        'Search this line'].join('\\n');
      const data = new DataTransfer();
      data.items.add(new File([caption], 'training.vtt', { type: 'text/vtt' }));
      const field = modal.querySelector('input[type=file]');
      field.files = data.files;
      field.dispatchEvent(new Event('change'));
    `);
        await ada.wait(statusIs('1 captions loaded'));
        await ada.run(`
      [...document.querySelectorAll('dialog[open] button')]
        .find((button) => button.textContent === 'Publish').click();
    `);
        await lin.wait('return document.querySelector("a.video-post");', 25000);
        const url = await lin.run(
          'return document.querySelector("a.video-post").href;',
        );
        const watch = new URL(url);
        watch.searchParams.set('t', '1.5');
        const viewer = await open(
          browser,
          watch.pathname + watch.search + watch.hash,
        );
        await viewer.wait(
          `return document.querySelector('#watch-player')?.readyState > 0;`,
          25000,
        );
        await viewer.wait(
          'return document.querySelector("#watch-player").currentTime >= 1.45;',
        );
        await viewer.run(`
      document.querySelector('#watch-later').click();
      document.querySelector('#watch-playlist').click();
      document.querySelector('dialog[open] input').value = 'Lessons';
      [...document.querySelectorAll('dialog[open] button')]
        .find((button) => button.textContent === 'Save to playlist').click();
      const search = document.querySelector('.video-transcript input');
      search.value = 'search this';
      search.dispatchEvent(new Event('input'));
      return true;
    `);
        assert.match(
          await viewer.run(
            `const list = document.querySelector('.video-transcript-list');
             return list.textContent;`,
          ),
          /Search this line/,
        );
        await viewer.run(`
      document.querySelector('.video-chapters button').click();
      const video = document.querySelector('#watch-player');
      await video.play();
    `);
        await delay(250);
        await viewer.run(`
      document.querySelector('#watch-player').pause();
      document.querySelector('#watch-continue').click();
    `);
        await viewer.wait(modalText('A lesson'));
        await viewer.run('document.querySelector("dialog[open]").close();');
        const reply = await viewer.run(
          'return document.querySelector("#watch-discuss").href;',
        );
        const route = new URL(reply);
        assert.equal(route.searchParams.get('chat'), 'general');
        assert.ok(Number(route.searchParams.get('at')) >= 2);
        await browser.request('Page.navigate', { url: reply }, lin.sessionId);
        await lin.wait(
          'return app.messageInput.value.includes("watch.html?t=");',
        );
      },
    );
    assert.deepEqual(browser.errors, []);
  },
);
