'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const harness = require('./harness.js');
const {
  openTab,
  fixture,
  inspect,
  readTones,
  assertMedia,
} = require('./recording-edit-fixture.js');

const dialog = '.recording-editor';
const row = (id) => `.recording-item[data-id="${id}"]`;
const control = (name) => `${dialog} [data-edit="${name}"]`;
const q = JSON.stringify;

const library = `
  const root = await navigator.storage.getDirectory();
  const options = { create: true };
  const recordings = await root.getDirectoryHandle('recordings', options);
  const write = async (directory, name, value) => {
    const handle = await directory.getFileHandle(name, options);
    const writable = await handle.createWritable();
    await writable.write(value);
    await writable.close();
  };
  const read = async (directory, name) =>
    (await directory.getFileHandle(name)).getFile();
  const digest = async (file) =>
    Array.from(new Uint8Array(
      await crypto.subtle.digest('SHA-256', await file.arrayBuffer()),
    )).join(',');
`;

const keys = `
  const names = [];
  for await (const key of recordings.keys()) names.push(key);
  return names.sort();
`;

const seed = `
  ${library}
  const { formatOf } = await import('/recorder.js');
  const format = formatOf((type) => MediaRecorder.isTypeSupported(type));
  const source = await (${fixture})(format.mime);
  const directory = await recordings.getDirectoryHandle('original', options);
  const name = 'program.' + format.extension;
  const metadata = {
    state: 'done', id: 'original', title: 'Original', call: 'example',
    chat: 'general', chatName: '!general', started: Date.now(),
    duration: 4210, size: source.size, mime: format.mime,
    extension: format.extension,
  };
  await write(directory, name, source);
  await write(directory, 'meta.json', JSON.stringify(metadata));
  window.original = metadata;
  return digest(source);
`;

const readOriginal = `
  ${library}
  const directory = await recordings.getDirectoryHandle('original');
  const name = 'program.' + original.extension;
  return {
    hash: await digest(await read(directory, name)),
    meta: JSON.parse(await (await read(directory, 'meta.json')).text()),
  };
`;

const editItem = `
  const item = [...document.querySelectorAll('.recording-menu .menu-item')]
    .find((node) => node.textContent === 'Edit');
  item.click();
`;

const click = (tab, selector) =>
  tab.run(`
  document.querySelector(${q(selector)}).click();
`);

const clickEdit = (tab, name) => click(tab, control(name));

const drag = async (browser, tab, start, end) => {
  const send = (type, point, buttons) =>
    browser.request(
      'Input.dispatchMouseEvent',
      {
        type,
        ...point,
        buttons,
        button: 'left',
        clickCount: 1,
      },
      tab.sessionId,
    );
  await send('mousePressed', start, 1);
  await send('mouseMoved', end, 1);
  await send('mouseReleased', end, 0);
};

const trackDrag = async (browser, tab, from, to) => {
  const area = await tab.run(`
    const track = document.querySelector(${q(control('track'))});
    track.scrollIntoView({ block: 'center', inline: 'nearest' });
    const box = track.getBoundingClientRect();
    return { left: box.left, width: box.width, y: box.top + box.height / 2 };
  `);
  const point = (fraction) => ({
    x: area.left + area.width * fraction,
    y: area.y,
  });
  await drag(browser, tab, point(from), point(to));
};

const input = (tab, selector, value, type) =>
  tab.run(`
  const input = document.querySelector(${q(selector)});
  input.value = ${q(value)};
  input.dispatchEvent(new Event(${q(type)}, { bubbles: true }));
`);

const time = (tab, name, value) =>
  input(tab, `${dialog} [data-time="${name}"]`, value, 'change');

const cut = async (tab, start, end) => {
  await clickEdit(tab, 'new-cut');
  await time(tab, 'cut-start', '00:00:00.000');
  await time(tab, 'cut-end', end);
  await time(tab, 'cut-start', start);
  await clickEdit(tab, 'apply-cut');
};

const edit = async (tab, id, ready = true) => {
  await click(tab, `${row(id)} .recording-more`);
  await tab.run(editItem);
  if (ready) {
    await tab.wait(`return document.querySelector(${q(control('body'))})
      ?.checkVisibility();`);
  }
};

const waitStatus = (tab, text) =>
  tab.wait(`
  return document.querySelector(${q(control('status'))})?.textContent
    .includes(${q(text)});
`);

const waitForCopy = async (tab) => {
  await tab.wait(`return app.recordings.selected.startsWith('edited-') &&
    !!document.querySelector('.recording-item.linked');`);
  return tab.run('return app.recordings.selected;');
};

const savedMedia = (id, silent = false) => `
  ${library}
  const directory = await recordings.getDirectoryHandle(${q(id)});
  const meta = JSON.parse(await (await read(directory, 'meta.json')).text());
  const name = 'program.' + meta.extension;
  const file = await read(directory, name);
  const poster = await read(directory, 'poster.jpg');
  const response = await fetch('/recordings/' + meta.id + '/' + name, {
    headers: { Range: 'bytes=0-15' },
  });
  const result = await (${inspect})(file, ${silent}, ${readTones});
  return { meta, result, size: file.size, poster: poster.size,
    range: response.status };
`;

const folderSeed = `
  ${library}
  const { folderHandle } = await import('/recording-folder.js');
  const folder = await root.getDirectoryHandle('editor-parts', options);
  const mime = 'video/webm;codecs=vp9';
  const source = await (${fixture})(mime, true);
  const segments = ['first.webm', 'second.webm'].map((name) => ({
    name, size: source.size, duration: 1000,
  }));
  await write(folder, segments[0].name, source);
  await folderHandle(folder, 'folder-editor');
  const id = 'folder-editor';
  const directory = await recordings.getDirectoryHandle(id, options);
  const meta = {
    state: 'interrupted', title: 'Two parts', chatName: '!general',
    started: Date.now(), duration: 2000, size: source.size * 2,
    extension: 'webm', mime, folder: folder.name, segments,
  };
  await write(directory, 'meta.json', JSON.stringify(meta));
  FileSystemDirectoryHandle.prototype.queryPermission = async () => 'prompt';
  FileSystemDirectoryHandle.prototype.requestPermission = async () =>
    window.allowFolder ? 'granted' : 'denied';
  window.folderSource = source;
  return { hash: await digest(source), meta };
`;

test(
  'scenario 24: edit and save a new recording from the library',
  {
    timeout: 150000,
  },
  async (t) => {
    await harness.startCallServer(t);
    const browser = await harness.launch(t, harness.MEDIA_FLAGS);
    const peer = await openTab(browser);
    const tab = await openTab(browser);
    const hash = await tab.run(seed);
    const meta = await tab.run('return original;');
    await click(tab, '#recordings-btn');
    await tab.wait(`return !!document.querySelector(${q(row('original'))});`);
    await edit(tab, 'original');
    await t.test(
      'full-screen editor cuts, zooms and scrolls by mouse',
      async () => {
        assert.equal(
          await tab.run(`
        const dialog = document.querySelector('.recording-editor');
        const { top, left, width, height } = dialog.getBoundingClientRect();
        return top === 0 && left === 0 && width === innerWidth &&
          height === innerHeight && !app.canRestart();
      `),
          true,
        );
        await trackDrag(browser, tab, 0.16, 0.29);
        const first = await tab.run('return app.recordings.editor.pendingCut;');
        assert.ok(first.end > first.start);
        await clickEdit(tab, 'apply-cut');
        await trackDrag(browser, tab, 0.7, 0.55);
        await clickEdit(tab, 'apply-cut');
        assert.equal(
          await tab.run(`
        return document.querySelectorAll('.recording-edit-cut-range').length;
      `),
          2,
        );
        await click(tab, `${control('cut-lane')} button:first-child`);
        const edge = await tab.run(`
        const handle = document.querySelector('[data-handle="cut-end"]');
        const box = handle.getBoundingClientRect();
        return { x: box.x + box.width / 2, y: box.y + box.height * .7 };
      `);
        await drag(browser, tab, edge, { x: edge.x + 28, y: edge.y });
        assert.ok(
          await tab.run(`
        return app.recordings.editor.pendingCut.end > ${first.end};
      `),
        );
        await clickEdit(tab, 'apply-cut');
        await clickEdit(tab, 'zoom-in');
        await clickEdit(tab, 'zoom-in');
        await tab.wait(`
        return document.querySelector(${q(control('zoom-level'))})
          .textContent === '4×';
      `);
        await input(tab, control('pan'), 650, 'input');
        const ruler = await tab.run(`
        const viewport = document.querySelector(${q(control('viewport'))});
        const ruler = document.querySelector(${q(control('ruler'))});
        const box = viewport.getBoundingClientRect();
        const rail = ruler.getBoundingClientRect();
        const x = box.left + box.width * .5;
        const expected = (x - rail.left) / rail.width *
          app.recordings.editor.duration;
        return { x, y: rail.y + rail.height / 2, expected,
          scroll: viewport.scrollLeft, width: viewport.scrollWidth };
      `);
        assert.ok(ruler.scroll > 0);
        assert.ok(ruler.width > 3 * ruler.x);
        const point = { x: ruler.x, y: ruler.y };
        await drag(browser, tab, point, point);
        assert.ok(
          await tab.run(`
        return Math.abs(app.recordings.editor.time - ${ruler.expected}) < 5;
      `),
        );
        await clickEdit(tab, 'zoom-out');
        await clickEdit(tab, 'zoom-fit');
        assert.equal(
          await tab.run(`
        return document.querySelector(${q(control('viewport'))}).scrollLeft;
      `),
          0,
        );
        for (let i = 0; i < 3; i++) await clickEdit(tab, 'undo');
        assert.equal(
          await tab.run('return app.recordings.editor.dirty;'),
          false,
        );
      },
    );
    await t.test(
      'play skips applied cuts and the selected cut being adjusted',
      async () => {
        assert.equal(
          await tab.run(`
      const handle = document.querySelector('[data-handle=start]');
      handle.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight' }));
      return handle.getAttribute('aria-valuenow');
    `),
          '100',
        );
        await clickEdit(tab, 'undo');
        await time(tab, 'start', '00:00:05.000');
        await waitStatus(tab, 'start before end');
        await time(tab, 'start', '00:00:00.300');
        await time(tab, 'end', '00:00:04.020');
        await cut(tab, '00:00:01.110', '00:00:01.910');
        await cut(tab, '00:00:02.460', '00:00:03.260');
        await clickEdit(tab, 'undo');
        assert.equal(
          await tab.run(`
      return document.querySelectorAll('.recording-edit-cuts li').length;
    `),
          1,
        );
        await clickEdit(tab, 'redo');
        await click(tab, `${control('cuts')} li:nth-child(2) button`);
        await time(tab, 'cut-end', '00:00:03.410');
        await tab.run(`
          const { video } = app.recordings.editor;
          const play = video.play.bind(video);
          window.playStarts = [];
          video.play = () => {
            playStarts.push(Math.round(video.currentTime * 1000));
            return play();
          };
        `);
        await input(tab, control('scrub'), 1000, 'input');
        await clickEdit(tab, 'play');
        await tab.wait(`
          const { nodes, video } = app.recordings.editor;
          const label = nodes.play.getAttribute('aria-label');
          return label === 'Play' && video.paused && playStarts.length === 3;
        `);
        assert.deepEqual(
          await tab.run('return playStarts;'),
          [1000, 1910, 3410],
        );
        assert.equal(
          await tab.run(`
          const editor = app.recordings.editor;
          return Number(editor.nodes.scrub.max) === editor.duration;
        `),
          true,
        );
        await clickEdit(tab, 'cancel-cut');
        await tab.run('history.back();');
        await tab.wait(
          'return Boolean(document.querySelector(".confirm[open]"));',
        );
        await click(tab, '.confirm-cancel');
        assert.equal(
          await tab.run(`return app.recordings.editor.dirty;`),
          true,
        );
      },
    );
    await t.test(
      'another tab cannot repair or publish an active save',
      async () => {
        await clickEdit(tab, 'save');
        assert.equal(
          await tab.run(`
            const progress = document.querySelector('[data-edit=progress]');
            const style = getComputedStyle(progress);
            return progress.checkVisibility() && style.height === '10px' &&
              style.borderTopWidth === '0px' && style.borderRadius === '8px';
          `),
          true,
        );
        await tab.wait(`
      const root = await navigator.storage.getDirectory();
      const recordings = await root.getDirectoryHandle('recordings');
      for await (const key of recordings.keys()) {
        if (key.startsWith('edited-')) return true;
      }
      return false;
    `);
        assert.equal(
          await peer.run(`
      const { RecordingWriter } = await import('/recorder.js');
      const writer = new RecordingWriter();
      try { return (await writer.repair()).repaired; }
      finally { writer.stop(); }
    `),
          0,
        );
        await peer.run('await app.recordings.refresh();');
        assert.equal(
          await peer.run(`
      return !!document.querySelector('.recording-item[data-id^=edited]');
    `),
          false,
        );
        await clickEdit(tab, 'cancel-save');
        await waitStatus(tab, 'Saving canceled');
        assert.deepEqual(await tab.run(library + keys), ['original']);
      },
    );
    await t.test(
      'a storage write failure preserves the draft and source',
      async () => {
        await tab.run(`
      const { RecordingWriter } = await import('/recorder.js');
      window.nativeWrite = RecordingWriter.prototype.write;
      RecordingWriter.prototype.write = async () => {
        throw new Error('Injected storage failure');
      };
    `);
        await clickEdit(tab, 'save');
        await waitStatus(tab, 'Injected storage failure');
        assert.deepEqual(await tab.run(library + keys), ['original']);
        assert.deepEqual(await tab.run(readOriginal), { hash, meta });
        await tab.run(`
      const { RecordingWriter } = await import('/recorder.js');
      RecordingWriter.prototype.write = nativeWrite;
    `);
      },
    );
    await t.test(
      'an undecodable export never reaches the library',
      async () => {
        await tab.run(`
      ${library}
      const { RecordingWriter } = await import('/recorder.js');
      const prototype = RecordingWriter.prototype;
      const finish = prototype.finishEdit;
      window.nativeFinish = finish;
      prototype.finishEdit = async function (id, duration) {
        await finish.call(this, id, duration);
        const directory = await recordings.getDirectoryHandle(id);
        for await (const name of directory.keys()) {
          if (name.startsWith('program.')) {
            await write(directory, name, new Uint8Array([1, 2, 3]));
          }
        }
      };
    `);
        await clickEdit(tab, 'save');
        await waitStatus(tab, 'could not be decoded');
        assert.deepEqual(await tab.run(library + keys), ['original']);
        assert.deepEqual(await tab.run(readOriginal), { hash, meta });
        await tab.run(`
      const { RecordingWriter } = await import('/recorder.js');
      RecordingWriter.prototype.finishEdit = nativeFinish;
    `);
      },
    );
    await t.test(
      'decodes a saved copy and keeps it after source deletion',
      async (t) => {
        await input(tab, control('copy-title'), 'Interview excerpt', 'input');
        await clickEdit(tab, 'save');
        await clickEdit(tab, 'save');
        const id = await waitForCopy(tab);
        const saved = await tab.run(savedMedia(id));
        assert.equal(saved.meta.title, 'Interview excerpt');
        assert.ok(Math.abs(saved.meta.duration - 2120) <= 100);
        assert.equal(saved.meta.state, 'done');
        assert.equal(saved.meta.call, undefined);
        assert.equal(saved.meta.size, saved.size);
        assert.ok(saved.poster > 0);
        assert.equal(saved.range, 206);
        assertMedia(t, saved.result, 2.12, [0.81, 1.36]);
        assert.deepEqual(await tab.run(readOriginal), { hash, meta });
        await tab.run('window.confirm = () => true;');
        await click(tab, `${row('original')} .recording-delete`);
        await tab.wait(
          `return !document.querySelector(${q(row('original'))});`,
        );
        assert.deepEqual(await tab.run(library + keys), [id]);
        const reopened = await tab.run(savedMedia(id));
        assert.equal(reopened.result.duration, saved.result.duration);
        await edit(tab, id);
        await clickEdit(tab, 'close');
        await tab.wait('return !app.recordings.editor;');
      },
    );
    await t.test(
      'startup repair deletes an abandoned editor write',
      async () => {
        await tab.run(`
      ${library}
      const { RecordingWriter } = await import('/recorder.js');
      const writer = new RecordingWriter();
      const meta = { ...original, id: 'edited-abandoned', state: 'recording' };
      await writer.open(meta.id, meta);
      await writer.write(meta.id, Uint8Array.of(1, 2, 3).buffer, 100);
      writer.stop();
      const directory = await recordings.getDirectoryHandle('edited-ended',
        options);
      await write(directory, 'meta.json', JSON.stringify({
        ...meta, id: 'edited-ended', state: 'interrupted',
      }));
    `);
        await peer.wait(`
      const { RecordingWriter } = await import('/recorder.js');
      const writer = new RecordingWriter();
      try {
        await writer.repair();
        ${library}
        for await (const name of recordings.keys()) {
          if (['edited-abandoned', 'edited-ended'].includes(name)) return false;
        }
        return true;
      }
      finally { writer.stop(); }
    `);
        const names = await tab.run(library + keys);
        assert.equal(names.includes('edited-abandoned'), false);
        assert.equal(names.includes('edited-ended'), false);
        assert.equal(names.length, 1);
      },
    );
  },
);

test(
  'scenario 24: a playable interrupted folder recording has one timeline',
  {
    timeout: 90000,
  },
  async (t) => {
    await harness.startCallServer(t);
    const browser = await harness.launch(t, harness.MEDIA_FLAGS);
    const tab = await openTab(browser);
    const { hash, meta } = await tab.run(folderSeed);
    await click(tab, '#recordings-btn');
    await tab.wait(`
    return Boolean(document.querySelector(${q(row('folder-editor'))}));
  `);
    await edit(tab, 'folder-editor', false);
    await waitStatus(tab, 'Allow access');
    await tab.run('window.allowFolder = true;');
    await clickEdit(tab, 'retry');
    await waitStatus(tab, 'Part 2 (second.webm)');
    await tab.run(`
    ${library}
    const folder = await root.getDirectoryHandle('editor-parts');
    await write(folder, 'second.webm', folderSource);
  `);
    await clickEdit(tab, 'retry');
    await tab.wait(`
    return document.querySelector(${q(control('body'))})?.checkVisibility();
  `);
    assert.equal(
      await tab.run(`
    return document.querySelector(${q(control('boundaries'))}).textContent;
  `),
      'Part 2',
    );
    const boundary = await tab.run(
      'return app.recordings.editor.parts[1].start;',
    );
    assert.ok(boundary > 4000, boundary);
    const editor =
      await import('../application/static/recording-edit-logic.js');
    const text = editor.timeInputOf;
    await time(tab, 'start', text(boundary - 700));
    await time(tab, 'end', text(boundary + 700));
    await cut(tab, text(boundary - 200), text(boundary + 200));
    await input(tab, control('scrub'), boundary - 300, 'input');
    await clickEdit(tab, 'play');
    await tab.wait(`
    const editor = app.recordings.editor;
    return editor.player.part?.index === 1 && !editor.video.seeking &&
      editor.video.currentTime >= .199 && editor.video.currentTime <= .7;
  `);
    await clickEdit(tab, 'save');
    const id = await waitForCopy(tab);
    const saved = await tab.run(savedMedia(id, true));
    assert.ok(Math.abs(saved.meta.duration - 1000) <= 100);
    assert.equal(saved.result.hasAudio, false);
    assert.ok(
      Math.abs(saved.result.duration - 1) <= 0.1,
      saved.result.duration,
    );
    assert.equal(saved.range, 206);
    const original = await tab.run(`
    ${library}
    const folder = await root.getDirectoryHandle('editor-parts');
    const directory = await recordings.getDirectoryHandle('folder-editor');
    const file = await read(directory, 'meta.json');
    const metadata = JSON.parse(await file.text());
    const hashes = await Promise.all(metadata.segments.map(async ({ name }) =>
      digest(await read(folder, name)),
    ));
    return { hashes, metadata };
  `);
    assert.deepEqual(original, { hashes: [hash, hash], metadata: meta });
  },
);
