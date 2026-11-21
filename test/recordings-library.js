'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const harness = require('./harness.js');

const { ORIGIN, MEDIA_FLAGS, launch, startCallServer } = harness;
const READY = `document.readyState === 'complete' && app.connected &&
  app.mesh.peers.has(app.peerId) && navigator.serviceWorker.controller`;
const LIBRARY = '.recordings-list .recording-item';
const CONTROL = '.call-record-control';
const TITLE = 'Review — Київ';

const acceptDelete = async (browser, sessionId, run, accept) => {
  const opened = new Promise((resolve) => {
    browser.on('Page.javascriptDialogOpening', resolve);
  });
  const click = run(`document.querySelector('.recording-delete').click();`);
  const dialog = await Promise.race([opened, click]);
  assert.equal(dialog?.type, 'confirm');
  assert.ok(dialog.message.includes(TITLE));
  await browser.request('Page.handleJavaScriptDialog', { accept }, sessionId);
  await click;
};

test(
  'recordings library lists, seeks, renames, and deletes a call recording',
  { timeout: 120000 },
  async (t) => {
    await startCallServer(t);
    const browser = await launch(t, MEDIA_FLAGS);
    const { targetId } = await browser.request('Target.createTarget', {
      url: 'about:blank',
    });
    const { sessionId } = await browser.request('Target.attachToTarget', {
      targetId,
      flatten: true,
    });
    await browser.request('Runtime.enable', {}, sessionId);
    await browser.request('Page.enable', {}, sessionId);
    const source = 'localStorage.setItem("xxii:nick", "alex");';
    const init = { source };
    await browser.request(
      'Page.addScriptToEvaluateOnNewDocument',
      init,
      sessionId,
    );
    await browser.request('Page.navigate', { url: `${ORIGIN}/` }, sessionId);
    await browser.request('Page.bringToFront', {}, sessionId);
    const run = (body) => harness.run(browser, sessionId, body);
    const wait = (body) => harness.wait(browser, sessionId, body);
    const click = (selector) =>
      run(`document.querySelector('${selector}').click();`);
    await wait(`return ${READY};`);

    await click('#recordings-btn');
    await wait(`
      const panel = document.querySelector('section[data-panel=recordings]');
      const note = panel.querySelector('.recordings-status');
      return panel.getClientRects().length > 0 &&
        note.textContent === 'No recordings yet.';
    `);
    await click('#panel-close-btn');
    await run(`await app.startCall('general');`);
    await click('#prejoin [data-action=join]');
    await wait(`return app.callStage?.mode === 'call' &&
      app.callStage.media.cameraTrack?.readyState === 'live';`);
    await click(`${CONTROL} [data-action=record-panel]`);
    await run(`
      const quality = document.querySelector('[data-record=quality]');
      quality.value = '720p30';
      quality.dispatchEvent(new Event('change', { bubbles: true }));
    `);
    await click(`${CONTROL} [data-action=record]`);
    await wait(
      `return app.callStage.recording.recorder?.state === 'recording';`,
    );

    await click(`${CONTROL} summary`);
    await click(`${CONTROL} [data-action=recordings]`);
    await wait(`
      const row = document.querySelector('${LIBRARY}');
      const panel = row?.closest('.panel-body');
      const details = row?.querySelector('.recording-details').textContent;
      const isVisible = panel?.getClientRects().length > 0;
      return isVisible && details.includes('Recording');
    `);
    const card = await run(`
      const row = document.querySelector('${LIBRARY}');
      const style = getComputedStyle(row);
      return { border: style.borderWidth, background: style.backgroundColor };
    `);
    assert.equal(card.border, '0px');
    assert.notEqual(card.background, 'rgba(0, 0, 0, 0)');
    const activeButtons = await run(`
      const row = document.querySelector('${LIBRARY}');
      const actions = row.querySelector('.recording-actions');
      const buttons = Array.from(
        actions.querySelectorAll('button:not([hidden])'),
        (button) => button.disabled,
      );
      return { buttons, download: actions.querySelector('a').hidden };
    `);
    assert.deepEqual(activeButtons, {
      buttons: [true, true, true],
      download: true,
    });

    await wait(`return app.callStage.recording.recorder.activeMs >= 3500;`);
    await click(`${CONTROL} [data-action=record]`);
    await wait(`
      const row = document.querySelector('${LIBRARY}');
      const details = row?.querySelector('.recording-details').textContent;
      const hasPoster = row?.querySelector('img')?.naturalWidth > 0;
      return details?.includes('Done') && hasPoster;
    `);
    const listed = await run(`
      const row = document.querySelector('${LIBRARY}');
      return {
        id: row.dataset.id,
        title: row.querySelector('.recording-title').textContent,
        chat: row.querySelector('.recording-chat').textContent,
        details: row.querySelector('.recording-details').textContent,
        poster: row.querySelector('img').getAttribute('src'),
        storage: document.querySelector('.recordings-storage').textContent,
      };
    `);
    assert.match(listed.title, /^!general \d{4}-\d\d-\d\d \d\d:\d\d$/);
    assert.match(listed.chat, /^!general · \d{4}-\d\d-\d\d \d\d:\d\d$/);
    assert.match(
      listed.details,
      /^\d\d:\d\d · [\d.]+ \w+ · Done · Browser storage$/,
    );
    assert.equal(listed.poster, `/recordings/${listed.id}/poster.jpg`);
    assert.match(listed.storage, /^[\d.]+ \w+ used · [\d.]+ \w+ free$/);

    await click('.recording-play');
    await wait(`
      const video = document.querySelector('.recordings-player');
      return video.readyState >= HTMLMediaElement.HAVE_METADATA &&
        video.videoWidth === 1280 && video.duration > 3;
    `);
    const playback = await run(`
      const video = document.querySelector('.recordings-player');
      video.pause();
      const seeked = new Promise((resolve) => {
        video.addEventListener('seeked', resolve, { once: true });
      });
      video.currentTime = 2;
      await seeked;
      return {
        source: new URL(video.currentSrc).pathname,
        time: video.currentTime,
        hasControls: video.controls,
      };
    `);
    const program = `/recordings/${listed.id}/program.`;
    assert.ok(playback.source.startsWith(program), playback.source);
    assert.ok(['mp4', 'webm'].includes(playback.source.slice(program.length)));
    assert.ok(Math.abs(playback.time - 2) < 0.2, `seeked to ${playback.time}`);
    assert.equal(playback.hasControls, true);
    const nativeKeys = await run(`
      const video = document.querySelector('.recordings-player');
      video.focus();
      return ['f', 'x', ' ', 'ArrowLeft'].every((key) => {
        const event = new KeyboardEvent('keydown', {
          key, bubbles: true, cancelable: true,
        });
        return video.dispatchEvent(event) && document.activeElement === video;
      });
    `);
    assert.equal(nativeKeys, true);

    await click('.recording-rename');
    await run(`
      const form = document.querySelector('.recording-form');
      const input = form.querySelector('input');
      input.value = ${JSON.stringify(TITLE)};
      form.requestSubmit();
    `);
    const title = JSON.stringify(TITLE);
    const renamed = `return document.querySelector('.recording-title')
      ?.textContent === ${title};`;
    await wait(renamed);
    await run(`
      const video = document.querySelector('.recordings-player');
      video.focus();
      const options = { key: 'Escape', bubbles: true, cancelable: true };
      video.dispatchEvent(new KeyboardEvent('keydown', options));
    `);
    assert.equal(
      await run(`const video = document.querySelector('.recordings-player');
        return video.hasAttribute('src');`),
      false,
    );
    await run('window.beforeRecordingReload = true;');
    await browser.request('Page.reload', {}, sessionId);
    await wait(`return !window.beforeRecordingReload && ${READY};`);
    await click('#recordings-btn');
    await wait(renamed);

    await acceptDelete(browser, sessionId, run, false);
    assert.equal(await run(renamed), true);
    await acceptDelete(browser, sessionId, run, true);
    await wait(`return document.querySelector('.recordings-status').textContent
      === 'No recordings yet.';`);
    const exists = await run(`
      const root = await navigator.storage.getDirectory();
      const recordings = await root.getDirectoryHandle('recordings');
      try {
        await recordings.getDirectoryHandle(${JSON.stringify(listed.id)});
        return true;
      } catch (error) {
        if (error.name !== 'NotFoundError') throw error;
        return false;
      }
    `);
    assert.equal(exists, false);
    assert.deepEqual(browser.errors, []);
  },
);
