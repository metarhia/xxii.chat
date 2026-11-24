'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const harness = require('./harness.js');

const { ORIGIN, launch, startCallServer } = harness;

test('scenario 16: serve recording ranges and Unicode filenames', async (t) => {
  await startCallServer(t);
  const browser = await launch(t);
  const { targetId } = await browser.request('Target.createTarget', {
    url: `${ORIGIN}/`,
  });
  const { sessionId } = await browser.request('Target.attachToTarget', {
    targetId,
    flatten: true,
  });
  const run = (body) => harness.run(browser, sessionId, body);
  await harness.wait(
    browser,
    sessionId,
    'return Boolean(navigator.serviceWorker.controller);',
  );
  const bytes = [3, 8, 13, 21, 34, 55, 89, 144];
  const url = '/recordings/fixture/program.mp4';
  await run(`
    const root = await navigator.storage.getDirectory();
    const recordings = await root.getDirectoryHandle('recordings', {
      create: true,
    });
    const directory = await recordings.getDirectoryHandle('fixture', {
      create: true,
    });
    const file = await directory.getFileHandle('program.mp4', { create: true });
    const writable = await file.createWritable();
    await writable.write(Uint8Array.from(${JSON.stringify(bytes)}));
    await writable.close();
  `);
  const request = (range) =>
    run(`
    const reply = await fetch('${url}', { headers: { Range: '${range}' } });
    return {
      status: reply.status,
      range: reply.headers.get('Content-Range'),
      length: reply.headers.get('Content-Length'),
      bytes: Array.from(new Uint8Array(await reply.arrayBuffer())),
    };
  `);
  const ranges = [
    ['bytes=2-4', 2, 4],
    ['bytes=5-', 5, 7],
    ['bytes=-4', 4, 7],
  ];
  for (const pair of ranges) {
    const header = pair[0];
    const start = pair[1];
    const end = pair[2];
    assert.deepEqual(await request(header), {
      status: 206,
      range: `bytes ${start}-${end}/${bytes.length}`,
      length: `${end - start + 1}`,
      bytes: bytes.slice(start, end + 1),
    });
  }
  assert.deepEqual(await request('bytes=8-'), {
    status: 416,
    range: 'bytes */8',
    length: null,
    bytes: [],
  });
  const download = await run(`
    const { fileNameOf } = await import('/recording-files.js');
    const started = new Date(2026, 10, 19, 14, 5).getTime();
    const name = fileNameOf('!Київ 日本語', started, 'mp4');
    const query = new URLSearchParams({ download: '1', name });
    const reply = await fetch('${url}?' + query);
    return {
      status: reply.status,
      header: reply.headers.get('Content-Disposition'),
      bytes: Array.from(new Uint8Array(await reply.arrayBuffer())),
    };
  `);
  assert.equal(download.status, 200);
  assert.match(download.header, /^attachment; filename="[^"]+"; filename\*=/);
  const filename = /filename\*=UTF-8''(.+)$/.exec(download.header);
  assert.ok(filename);
  assert.equal(
    decodeURIComponent(filename[1]),
    'xxii !Київ 日本語 2026-11-19 14-05.mp4',
  );
  assert.deepEqual(download.bytes, bytes);
  const missing = await run(`
    const reply = await fetch('/recordings/unknown/program.mp4');
    return reply.status;
  `);
  assert.equal(missing, 404);
});
