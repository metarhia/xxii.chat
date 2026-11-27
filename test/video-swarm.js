'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { setTimeout: delay } = require('node:timers/promises');
const harness = require('./harness.js');
const { openTab, fixture } = require('./recording-edit-fixture.js');

const q = JSON.stringify;

const openViewer = async (browser, url) => {
  const { browserContextId } = await browser.request(
    'Target.createBrowserContext',
  );
  const { targetId } = await browser.request('Target.createTarget', {
    url: 'about:blank',
    browserContextId,
  });
  const { sessionId } = await browser.request('Target.attachToTarget', {
    targetId,
    flatten: true,
  });
  await browser.request('Page.navigate', { url }, sessionId);
  const run = (body) =>
    browser.evaluate(
      sessionId,
      `(async () => {
    const video = document.querySelector('#watch-player');
    const status = document.querySelector('#watch-status');
    const keep = document.querySelector('#watch-keep');
    ${body}
  })()`,
    );
  const wait = async (condition) => {
    const deadline = Date.now() + 25000;
    while (Date.now() < deadline) {
      if (await run(`return ${condition};`).catch(() => false)) return;
      await delay(100);
    }
    const status = await run('return status?.textContent;');
    assert.fail(`Timed out waiting for ${condition}. Watch status: ${status}`);
  };
  return { run, wait, sessionId };
};

test(
  'video watch link can stream from a viewer after the publisher leaves',
  {
    timeout: 140000,
  },
  async (t) => {
    await harness.startCallServer(t);
    const browser = await harness.launch(t, harness.MEDIA_FLAGS);
    const owner = await openTab(browser);
    const expected = await owner.run(`
    const { PIECE_BYTES } = await import('/video-pieces.js');
    const media = await (${fixture})('video/mp4');
    const padding = new Uint8Array(3 * PIECE_BYTES);
    new DataView(padding.buffer).setUint32(0, padding.length);
    padding.set(new TextEncoder().encode('free'), 4);
    for (let i = 8; i < padding.length; i++) padding[i] = i % 251;
    const file = new File([media, padding], 'Swarm clip.mp4', {
      type: 'video/mp4',
    });
    const data = new DataTransfer();
    data.items.add(file);
    document.querySelector('#recordings-btn').click();
    const input = document.querySelector('#recordings-files');
    input.files = data.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));
    const start = 2 * PIECE_BYTES - 10;
    const end = start + 20;
    const bytes = await file.slice(start, end + 1).arrayBuffer();
    return { start, end, size: file.size, bytes: [...new Uint8Array(bytes)] };
  `);
    await owner.wait('return document.querySelector(".recording-more");');
    await owner.run(`
    document.querySelector('.recording-more').click();
    document.querySelector('.recording-menu [data-action="share"]').click();
  `);
    await owner.wait(
      'return document.querySelector(".video-share input").value;',
    );
    const link = await owner.run(`
    return document.querySelector('.video-share input').value;
  `);
    assert.match(new URL(link).hash, /^#[a-f0-9]{64}\.[a-f0-9]{64}$/);
    const viewer = await openViewer(browser, link);
    await viewer.wait('video?.videoWidth === 128 && !keep.hidden');
    await viewer.run('keep.click();');
    await viewer.wait('keep.textContent === "copy saved"');

    await owner.run('document.querySelector("[data-share=stop]").click();');
    await viewer.wait('status.textContent.includes("0 peers")');
    await browser.request('Page.reload', {}, viewer.sessionId);
    await viewer.wait('video?.videoWidth === 128 && keep.disabled');
    const next = await openViewer(browser, link);
    await next.wait('video?.videoWidth === 128');
    await next.run('await video.play();');
    await next.wait('video.currentTime > 0');
    const actual = await next.run(`
    const response = await fetch(video.src, {
      headers: { Range: ${q(`bytes=${expected.start}-${expected.end}`)} },
    });
    return {
      status: response.status,
      range: response.headers.get('Content-Range'),
      bytes: [...new Uint8Array(await response.arrayBuffer())],
    };
  `);
    assert.deepEqual(actual, {
      status: 206,
      range: `bytes ${expected.start}-${expected.end}/${expected.size}`,
      bytes: expected.bytes,
    });
    assert.deepEqual(browser.errors, []);
  },
);
