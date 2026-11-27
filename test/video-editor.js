'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const harness = require('./harness.js');
const { openTab, fixture } = require('./recording-edit-fixture.js');

const q = JSON.stringify;
const editor = '.recording-editor';
const edit = (name) => `${editor} [data-edit="${name}"]`;
const toolTab = (name) => `[data-editor-tab="${name}"]`;
const row = (id) => `.recording-item[data-id="${id}"]`;
const click = (tab, selector) =>
  tab.run(`
  document.querySelector(${q(selector)}).click();
`);
const set = (tab, selector, value, event = 'change') =>
  tab.run(`
  const input = document.querySelector(${q(selector)});
  input.value = ${q(value)};
  input.dispatchEvent(new Event(${q(event)}, { bubbles: true }));
`);
const option = (tab, name, value) => set(tab, `[data-option="${name}"]`, value);
const choose = async (tab, id, action) => {
  await click(tab, `${row(id)} .recording-more`);
  await click(tab, `.recording-menu [data-action="${action}"]`);
};

const transfer = (tab, selector, names) =>
  tab.run(`
  const data = new DataTransfer();
  for (const name of ${q(names)}) {
    const file = new File([videoFixture], name + '.' + fixtureExtension,
      { type: videoFixture.type });
    data.items.add(file);
  }
  const input = document.querySelector(${q(selector)});
  input.files = data.files;
  input.dispatchEvent(new Event('change', { bubbles: true }));
`);

const readEntries = `
  const storage = await navigator.storage.getDirectory();
  const recordings = await storage.getDirectoryHandle('recordings');
  const media = async (id) => {
    const dir = await recordings.getDirectoryHandle(id);
    const metaFile = await dir.getFileHandle('meta.json');
    const meta = JSON.parse(await (await metaFile.getFile()).text());
    const handle = await dir.getFileHandle('program.' + meta.extension);
    const file = await handle.getFile();
    return { meta, file };
  };
`;

const originalOf = (tab, title) =>
  tab.run(`
  ${readEntries}
  for await (const id of recordings.keys()) {
    const { meta } = await media(id);
    if (meta.title === ${q(title)}) return id;
  }
  return null;
`);

test(
  'video editor joins, crops and exports media for chat',
  {
    timeout: 120000,
  },
  async (t) => {
    await harness.startCallServer(t);
    const browser = await harness.launch(t, harness.MEDIA_FLAGS);
    const tab = await openTab(browser);
    await tab.run(`
    app.usernameInput.value = 'Editor';
    app.syncUsername();
    const { formatOf } = await import('/recorder.js');
    const format = formatOf((type) => MediaRecorder.isTypeSupported(type));
    window.fixtureExtension = format.extension;
    window.videoFixture = await (${fixture})(format.mime, false, true);
    window.saveRequests = [];
    const root = await navigator.storage.getDirectory();
    window.saveTarget = await root.getFileHandle('saved-as', { create: true });
    window.showSaveFilePicker = async (request) => {
      saveRequests.push(request);
      return saveTarget;
    };
  `);
    await click(tab, '#recordings-btn');
    await transfer(tab, '#recordings-files', ['First clip', 'Second clip']);
    await tab.wait(`
    return document.querySelectorAll('.recording-item').length === 2;
  `);
    const first = await originalOf(tab, 'First clip');
    const second = await originalOf(tab, 'Second clip');
    await choose(tab, first, 'properties');
    await tab.wait(`
    return document.querySelector('.recording-properties dl')?.textContent
      .includes('128 × 72');
  `);
    assert.equal(
      await tab.run(`
      const dialog = document.querySelector('.recording-properties');
      const close = dialog.querySelector('header button');
      const styles = getComputedStyle(dialog.querySelector('dl'));
      return !!close.querySelector('svg') && styles.display === 'grid' &&
        close.getAttribute('aria-label') === 'Close media properties';
    `),
      true,
    );
    await click(tab, '.recording-properties button');
    await tab.wait('return !document.querySelector(".recording-properties");');
    await choose(tab, first, 'properties');
    await tab.wait(
      'return Boolean(document.querySelector(".recording-properties"));',
    );
    for (const type of ['mousePressed', 'mouseReleased']) {
      const point = { type, x: 3, y: 3, button: 'left', clickCount: 1 };
      await browser.request('Input.dispatchMouseEvent', point, tab.sessionId);
    }
    await tab.wait('return !document.querySelector(".recording-properties");');
    await click(tab, `${row(first)} .recording-edit`);
    await tab.wait(
      `return !document.querySelector(${q(edit('body'))})?.hidden;`,
    );
    for (const [width, height] of [
      [1024, 600],
      [390, 844],
      [667, 375],
    ]) {
      await browser.request(
        'Emulation.setDeviceMetricsOverride',
        { width, height, deviceScaleFactor: 1, mobile: width < 720 },
        tab.sessionId,
      );
      for (const tool of ['cuts', 'clips', 'picture', 'output']) {
        await click(tab, toolTab(tool));
        const layout = await tab.run(`
          const tab = document.querySelector('[aria-selected=true]' +
            '[data-editor-tab]');
          const panelId = tab.getAttribute('aria-controls');
          const panel = document.getElementById(panelId);
          const editor = document.querySelector('.recording-edit-content');
          const preview = document.querySelector('.recording-edit-visual');
          return {
            tab: tab.dataset.editorTab,
            visible: panel.checkVisibility(),
            overflow: editor.scrollHeight - editor.clientHeight,
            panelWidth: panel.scrollWidth - panel.clientWidth,
            preview: Math.round(preview.getBoundingClientRect().height),
          };
        `);
        assert.equal(layout.tab, tool);
        assert.equal(layout.visible, true);
        assert.equal(layout.overflow, 0, JSON.stringify({ width, ...layout }));
        assert.equal(layout.panelWidth, 0);
        assert.ok(layout.preview >= 100);
      }
    }
    await browser.request(
      'Emulation.clearDeviceMetricsOverride',
      {},
      tab.sessionId,
    );
    await tab.run(`
      const tab = document.querySelector(${q(toolTab('output'))});
      tab.focus();
      tab.dispatchEvent(new KeyboardEvent('keydown', {
        key: 'Home', bubbles: true, cancelable: true,
      }));
    `);
    assert.equal(
      await tab.run(`return document.activeElement.dataset.editorTab;`),
      'cuts',
    );
    await click(tab, toolTab('output'));
    assert.equal(
      await tab.run(`
      const select = document.querySelector('[data-option=quality]');
      const styles = getComputedStyle(select);
      return styles.appearance === 'none' &&
        styles.borderTopWidth === '0px' && styles.borderRadius === '4px' &&
        styles.backgroundPosition.includes('12px') &&
        parseInt(styles.paddingRight, 10) >= 30;
    `),
      true,
    );
    assert.deepEqual(
      await tab.run(`
      const names = ['play', 'undo', 'redo', 'zoom-fit'];
      return names.map((name) => {
        const button = document.querySelector('[data-edit=' + name + ']');
        return [Boolean(button.querySelector('svg')),
          button.getAttribute('aria-label')];
      });
    `),
      [
        [true, 'Play'],
        [true, 'Undo'],
        [true, 'Redo'],
        [true, 'Fit timeline'],
      ],
    );
    await tab.run(`document.querySelector(${q(edit('speed'))}).focus();`);
    for (const type of ['keyDown', 'keyUp']) {
      const key = 'ArrowRight';
      await browser.request(
        'Input.dispatchKeyEvent',
        {
          type,
          key,
          code: key,
          windowsVirtualKeyCode: 39,
        },
        tab.sessionId,
      );
    }
    assert.deepEqual(
      await tab.run(`
      const editor = app.recordings.editor;
      return [editor.options.speed, editor.nodes['speed-value'].value];
    `),
      [1.05, '1.05×'],
    );
    await click(tab, edit('undo'));
    await click(tab, toolTab('clips'));
    await set(tab, edit('library-source'), second);
    await click(tab, edit('add-recording'));
    await tab.wait('return app.recordings.editor.parts.length === 2;');
    await transfer(tab, edit('video-files'), ['Device clip']);
    await tab.wait('return app.recordings.editor.parts.length === 3;');
    await click(tab, `${edit('clips')} li:nth-child(3) button`);
    assert.deepEqual(
      await tab.run(`
    return app.recordings.editor.parts.map((part) => part.name);
  `),
      [
        'First clip',
        `Device clip.${await tab.run('return fixtureExtension;')}`,
        'Second clip',
      ],
    );
    await click(tab, edit('undo'));
    assert.equal(
      await tab.run(`
    return app.recordings.editor.parts[1].name;
  `),
      'Second clip',
    );
    await click(tab, edit('redo'));
    await click(tab, toolTab('cuts'));
    await click(tab, edit('silence'));
    await tab.wait(`
    const editor = app.recordings.editor;
    return editor.draft.cuts.length >= 3 && !editor.tool;
  `);
    await click(tab, toolTab('picture'));
    await option(tab, 'rotation', '90');
    await click(tab, '[data-option="mirror"]');
    await option(tab, 'cropLeft', '25');
    await option(tab, 'aspect', '1:1');
    await option(tab, 'framing', 'fill');
    await click(tab, toolTab('output'));
    await option(tab, 'quality', 'small');
    await option(tab, 'target', '1');
    await option(tab, 'speed', '2');
    const duration = await tab.run(
      `return app.recordings.editor.timeline.duration;`,
    );
    assert.ok(duration > 3000 && duration < 5500, duration);
    await set(tab, edit('scrub'), 0, 'input');
    await click(tab, edit('play'));
    await tab.wait(`
    const frame = document.querySelector(${q(edit('frame'))});
    const video = document.querySelector('.recording-editor video');
    const play = document.querySelector(${q(edit('play'))});
    return !frame.hidden && frame.width === 72 && frame.height === 72 &&
      !video.paused && video.playbackRate === 2 &&
      play.getAttribute('aria-label') === 'Pause';
  `);
    await set(tab, edit('copy-title'), 'Square version', 'input');
    await click(tab, edit('save-as'));
    await tab.wait(`
    return !app.recordings.editor && app.recordings.selected &&
      document.querySelectorAll('.recording-item').length === 3;
  `);
    const square = await originalOf(tab, 'Square version');
    const result = await tab.run(`
    ${readEntries}
    const { videoProperties } = await import('/video-library.js');
    const { meta, file } = await media(${q(square)});
    const signal = new AbortController().signal;
    const picture = await videoProperties(() => file, signal);
    const target = await saveTarget.getFile();
    return { meta, picture, target: target.size, picks: saveRequests };
  `);
    assert.equal(result.picture.width, 72);
    assert.equal(result.picture.height, 72);
    assert.ok(Math.abs(result.picture.duration - duration) < 250);
    assert.ok(result.meta.size <= 1024 * 1024);
    assert.equal(result.target, result.meta.size);
    assert.equal(
      result.picks[0].suggestedName,
      `Square version.${result.meta.extension}`,
    );

    await choose(tab, square, 'rename');
    await set(tab, `${row(square)} .recording-form input`, 'Edited square');
    await tab.run(`document.querySelector('.recording-form:not(.hidden)')
    .requestSubmit();`);
    await tab.wait(`
    return document.querySelector(${q(row(square) + ' .recording-title')})
      .textContent === 'Edited square';
  `);
    await choose(tab, square, 'attach');
    await tab.wait('return app.pendingOf(app.chat).length === 1;');
    assert.equal(
      await tab.run('return app.pendingOf(app.chat)[0].name;'),
      `Edited square.${result.meta.extension}`,
    );
    await tab.run('await app.sendMessage();');
    await tab.wait(`return Boolean(document.querySelector(
    '.attachments [data-action="save-video"]')); `);
    await click(tab, '.attachments [data-action="save-video"]');
    await tab.wait(`return app.localRecordings.size === 4;`);
    assert.equal(
      await tab.run(`
    ${readEntries}
    const { file } = await media(${q(square)});
    const bytes = new Uint8Array(await file.arrayBuffer());
    for await (const id of recordings.keys()) {
      if (id === ${q(square)}) continue;
      const copy = await media(id);
      if (copy.meta.title !== 'Edited square') continue;
      const saved = new Uint8Array(await copy.file.arrayBuffer());
      return saved.length === bytes.length &&
        saved.every((value, i) => value === bytes[i]);
    }
    return false;
  `),
      true,
    );

    await click(tab, '#recordings-btn');
    await tab.wait(`return Boolean(document.querySelector(${q(row(first))}));`);
    await choose(tab, first, 'edit');
    await tab.wait(
      `return !document.querySelector(${q(edit('body'))})?.hidden;`,
    );
    await click(tab, toolTab('output'));
    await option(tab, 'output', 'audio');
    await set(tab, edit('copy-title'), 'Audio extract', 'input');
    await click(tab, edit('save'));
    await tab
      .wait(
        `
    return !app.recordings.editor &&
      document.querySelectorAll('.recording-item').length === 5;
  `,
      )
      .catch(async (error) => {
        const status = await tab.run(`
        const editor = app.recordings.editor;
        return {
          status: editor?.nodes.status.textContent,
          validation: editor?.nodes.validation.textContent,
          format: editor?.format,
          saving: Boolean(editor?.saving),
        };
      `);
        throw new Error(JSON.stringify(status), { cause: error });
      });
    const audio = await originalOf(tab, 'Audio extract');
    const sound = await tab.run(`
    ${readEntries}
    const { videoProperties } = await import('/video-library.js');
    const { meta, file } = await media(${q(audio)});
    const signal = new AbortController().signal;
    const data = await videoProperties(() => file, signal);
    return { mime: meta.mime, width: data.width, audio: data.audio };
  `);
    assert.match(sound.mime, /^audio\//);
    assert.equal(sound.width, 0);
    assert.equal(sound.audio, true);
  },
);
