'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { once } = require('node:events');
const { setTimeout: delay } = require('node:timers/promises');

const harness = require('./harness.js');

const FLAGS = harness.MEDIA_FLAGS.concat([
  '--disable-features=WebRtcHideLocalIpsWithMdns',
]);
const STUDIO = '.call-bar-menu [data-action=studio]';
const MORE = '.call-controls [data-action=more]';
const GO_LIVE = '.call-studio [data-action=go-live]';
const STOP_LIVE = '.call-bar-menu [data-action=stop-live]';
const CHIP = '.call-topbar .call-live';
const STATUS = '.call-studio .stream-status';
const TOKEN = 'test-token';
const NAME = 'Local WHIP';
const FRAMES = 30;

const quote = JSON.stringify;

const openPage = async (t, browser, url, nick = '') => {
  const { browserContextId } = await browser.request(
    'Target.createBrowserContext',
  );
  t.after(() =>
    browser
      .request('Target.disposeBrowserContext', { browserContextId })
      .catch(() => undefined),
  );
  const target = await browser.request('Target.createTarget', {
    browserContextId,
    url: 'about:blank',
  });
  const { sessionId } = await browser.request('Target.attachToTarget', {
    ...target,
    flatten: true,
  });
  const request = (method, params = {}) =>
    browser.request(method, params, sessionId);
  await request('Runtime.enable');
  await request('Page.enable');
  if (nick) {
    await request('Page.addScriptToEvaluateOnNewDocument', {
      source: `localStorage.setItem('xxii:nick', ${quote(nick)});`,
    });
  }
  await request('Page.navigate', { url });
  await request('Page.bringToFront');
  const front = () => request('Page.bringToFront');
  const evaluate = (body) =>
    browser.evaluate(sessionId, `(async () => { ${body} })()`);
  const run = (body) => harness.run(browser, sessionId, body);
  const wait = async (body, execute = run, timeoutMs = 25000) => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (await execute(body).catch(() => false)) return;
      await delay(100);
    }
    const result = await execute(body).catch((error) => error.message);
    throw new Error(`Browser condition failed: ${quote(result)} ${body}`);
  };
  const click = (selector) =>
    run(`document.querySelector(${quote(selector)}).click();`);
  return { front, evaluate, run, wait, click };
};

const openPerson = async (t, browser, nick) => {
  const page = await openPage(t, browser, harness.ORIGIN, nick);
  await page.wait('return app.connected && app.mesh.peers.has(app.peerId);');
  return page;
};

const join = async (page, token = '') => {
  await page.front();
  const joined = await page.run(`app.selectChat('general');
    await app.startCall('general', { token: ${quote(token)} });
    return { token: app.callToken, endpoint: app.callSession.endpoint };`);
  await page.click('#prejoin [data-action=join]');
  await page.wait(`return app.callStage?.mode === 'call';`);
  return joined;
};

const receiverCode = (offer) => `
  const connection = new RTCPeerConnection();
  window.receivers = window.receivers ?? [];
  const entry = { connection, frames: 0, audio: null };
  window.receivers.push(entry);
  connection.ontrack = ({ track }) => {
    if (track.kind === 'audio') {
      entry.audio = track;
      return;
    }
    const video = document.createElement('video');
    video.muted = true;
    video.srcObject = new MediaStream([track]);
    document.body.append(video);
    video.play().catch(() => undefined);
    const count = () => {
      entry.frames++;
      video.requestVideoFrameCallback(count);
    };
    video.requestVideoFrameCallback(count);
  };
  const offer = { type: 'offer', sdp: ${quote(offer)} };
  await connection.setRemoteDescription(offer);
  await connection.setLocalDescription(await connection.createAnswer());
  if (connection.iceGatheringState !== 'complete') {
    await new Promise((resolve) => {
      connection.onicegatheringstatechange = () => {
        if (connection.iceGatheringState === 'complete') resolve();
      };
      setTimeout(resolve, 3000);
    });
  }
  return connection.localDescription.sdp;
`;

const readBody = async (request) => {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  return Buffer.concat(chunks).toString();
};

const startEndpoint = async (t, receiver, isCors = true) => {
  const requests = [];
  const plan = [];
  const server = http.createServer(async (request, response) => {
    if (isCors) {
      response.setHeader('Access-Control-Allow-Origin', '*');
      response.setHeader('Access-Control-Expose-Headers', 'Location, Link');
    }
    if (request.method === 'OPTIONS') {
      if (isCors) {
        response.setHeader(
          'Access-Control-Allow-Headers',
          'Authorization, Content-Type',
        );
        response.setHeader(
          'Access-Control-Allow-Methods',
          'POST, DELETE, OPTIONS',
        );
      }
      requests.push({ method: 'OPTIONS', headers: request.headers });
      response.writeHead(204).end();
      return;
    }
    const body = await readBody(request);
    const at = Date.now();
    const { method, url, headers } = request;
    requests.push({ method, url, headers, body, at });
    if (method === 'DELETE') {
      response.writeHead(200).end();
      return;
    }
    const status = plan.length > 0 ? plan.shift() : 201;
    if (status !== 201) {
      response.writeHead(status).end();
      return;
    }
    try {
      const answer = await receiver.evaluate(receiverCode(body));
      response.setHeader('Content-Type', 'application/sdp');
      response.setHeader('Location', '/whip/1');
      response.writeHead(201).end(answer);
    } catch (error) {
      response.writeHead(500).end(error.message);
    }
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  const { port } = server.address();
  const of = (method) => requests.filter((item) => item.method === method);
  return { url: `http://127.0.0.1:${port}/whip`, requests, plan, of };
};

const addDestination = async (page, url) => {
  await page.click(MORE);
  await page.click(STUDIO);
  await page.wait(`return document.querySelector('.call-studio[data-open]')
    ?.checkVisibility();`);
  await page.click('[data-stream-action=add-destination]');
  await page.wait(
    `return !document.querySelector('[data-stream-editor]').hidden;`,
  );
  await page.run(`const set = (name, value) => {
      const control = document.querySelector('[data-stream=' + name + ']');
      control.value = value;
      control.dispatchEvent(new Event('change', { bubbles: true }));
    };
    set('name', ${quote(NAME)});
    set('url', ${quote(url)});
    set('token', ${quote(TOKEN)});
    set('bitrate', '4');`);
  await page.click('[data-stream-action=save-destination]');
  await page.wait(`return document.querySelector('[data-stream-list] li');`);
  await page.click('[data-stream=enabled]');
  await page.wait(`return app.callStage.streaming.destinations[0]?.enabled &&
    !document.querySelector(${quote(GO_LIVE)}).disabled;`);
};

const mbpsOf = (page) =>
  page.run(`const text = document.querySelector(${quote(STATUS)}).textContent;
    const match = /^LIVE · (\\d+\\.\\d) Mbps/.exec(text);
    return match ? Number(match[1]) : 0;`);

const hasChip = (shown, title) => `
  const chip = document.querySelector(${quote(CHIP)});
  return chip.checkVisibility() === ${shown} && ${
    shown
      ? `chip.textContent === '● LIVE' && chip.title === ${quote(title)}`
      : 'true'
  };`;

const watchAnnouncements = (page) =>
  page.run(`window.announced = [];
    const region = document.querySelector('#call-announcements');
    const options = { childList: true, subtree: true, characterData: true };
    new MutationObserver(() => window.announced.push(region.textContent))
      .observe(region, options);`);

const announced = (text) =>
  `return window.announced.some((line) => line.includes(${quote(text)}));`;

const startRelayServer = async (t) => {
  const dataPath = await fs.mkdtemp(path.join(os.tmpdir(), 'xxii-data-'));
  const environment = {
    XXII_STREAM_ALLOW_HTTP: 'true',
    XXII_STREAM_ALLOW_PRIVATE: 'true',
  };
  const server = await harness.startServer(dataPath, environment);
  t.after(async () => {
    await harness.stopServer(server);
    const options = { recursive: true, force: true, maxRetries: 5 };
    await fs.rm(dataPath, { ...options, retryDelay: 100 });
  });
  return server;
};

test(
  'scenario 21: WHIP over the direct path',
  { timeout: 240000 },
  async (t) => {
    await harness.startCallServer(t);
    const browser = await harness.launch(t, FLAGS);
    const receiver = await openPage(
      t,
      browser,
      `${harness.ORIGIN}/manifest.json`,
    );
    const endpoint = await startEndpoint(t, receiver);
    const host = await openPerson(t, browser, 'alex');
    const { token } = await join(host);
    const guest = await openPerson(t, browser, 'kim');
    await join(guest, token);
    await watchAnnouncements(guest);
    await host.front();
    await host.wait('return app.callStage.people.length === 2;');
    assert.equal(
      await host.run(
        `return document.querySelector(${quote(STOP_LIVE)}) === null;`,
      ),
      true,
    );

    await addDestination(host, endpoint.url);
    assert.equal(
      await host.run(`const text = localStorage.getItem('xxii:destinations');
      return text.includes(${quote(TOKEN)}) &&
        JSON.parse(text)[0].bitrate === 4000000 &&
        document.querySelector('[data-stream=token]').type === 'password';`),
      true,
    );
    await host.click(GO_LIVE);
    await host.wait(`return app.callStage.streaming.isActive;`);
    await host.wait(
      'return app.callStage.people.some((person) => person.live);',
    );
    await host.wait(`return document.querySelector(${quote(STATUS)}).textContent
    .startsWith('LIVE');`);
    await host.wait(
      `const match = /^LIVE · (\\d+\\.\\d) Mbps/.exec(
      document.querySelector(${quote(STATUS)}).textContent);
    return match && Number(match[1]) > 0;`,
    );
    const posts = endpoint.of('POST');
    assert.equal(posts.length, 1);
    assert.equal(posts[0].url, '/whip');
    assert.equal(posts[0].headers.authorization, `Bearer ${TOKEN}`);
    assert.equal(posts[0].headers['content-type'], 'application/sdp');
    assert.equal(posts[0].headers.origin, harness.ORIGIN);
    assert.match(posts[0].body, /^v=0/);
    const preflight = endpoint.of('OPTIONS')[0];
    assert.match(
      preflight.headers['access-control-request-headers'],
      /authorization/,
    );
    const mbps = await mbpsOf(host);
    assert.ok(mbps > 0);

    await receiver.front();
    await receiver.wait(
      `const entry = window.receivers.at(-1);
    return entry.frames >= ${FRAMES} && entry.audio?.readyState === 'live';`,
      receiver.evaluate,
    );
    const received = await receiver.evaluate(`
    const entry = window.receivers.at(-1);
    const report = await entry.connection.getStats();
    const kinds = {};
    for (const item of report.values()) {
      if (item.type === 'inbound-rtp') kinds[item.kind] = item.packetsReceived;
    }
    return { kinds, frames: entry.frames };`);
    assert.ok(received.frames >= FRAMES, `frames ${received.frames}`);
    assert.ok(received.kinds.audio > 0, 'audio packets');
    assert.ok(received.kinds.video > 0, 'video packets');

    await guest.front();
    await guest.wait(hasChip(true, 'alex is live'));
    await guest.wait(announced('alex went live'));
    await host.front();
    await host.wait(hasChip(true, 'alex is live'));
    assert.equal(
      await host.run(`return document.querySelector('.call-opt-out')
      .checkVisibility() === false;`),
      true,
    );
    await guest.front();
    assert.equal(
      await guest.run(`return document.querySelector('.call-opt-out')
      .checkVisibility() === true;`),
      true,
    );

    await host.front();
    await host.click(MORE);
    await host.wait(`return document.querySelector(${quote(STOP_LIVE)})
    .checkVisibility();`);
    await host.click(STOP_LIVE);
    await host.wait(`return !app.callStage.streaming.isActive;`);
    await delay(300);
    const deletes = endpoint.of('DELETE');
    assert.equal(deletes.length, 1);
    assert.equal(deletes[0].url, '/whip/1');
    assert.equal(deletes[0].headers.authorization, `Bearer ${TOKEN}`);
    await host.wait(hasChip(false, ''));
    await guest.front();
    await guest.wait(hasChip(false, ''));
    await guest.wait(announced('Live stream ended'));
    await host.front();
    assert.equal(
      await host.run(`const button = document.querySelector(${quote(GO_LIVE)});
      return button.textContent === 'Go live' &&
        document.querySelector(${quote(STATUS)}).textContent === '';`),
      true,
    );

    endpoint.plan.push(503);
    await host.click(GO_LIVE);
    await host.wait(`return document.querySelector(${quote(STATUS)}).textContent
    === 'retrying in 2 s (attempt 1 of 5)';`);
    await host.wait(`return document.querySelector(${quote(STATUS)}).textContent
    .startsWith('LIVE');`);
    const attempts = endpoint.of('POST');
    assert.equal(attempts.length, 3);
    const gap = attempts[2].at - attempts[1].at;
    assert.ok(gap >= 1800 && gap <= 8000, `retry after ${gap} ms`);
    await receiver.front();
    await receiver.wait(
      `return window.receivers.at(-1).frames >= ${FRAMES};`,
      receiver.evaluate,
    );
    await host.front();
    await host.click(MORE);
    await host.click(STOP_LIVE);
    await host.wait(`return !app.callStage.streaming.isActive;`);
    await delay(300);
    assert.equal(endpoint.of('DELETE').length, 2);
    assert.deepEqual(browser.errors, []);
  },
);

test(
  'scenario 21: WHIP through the relay without CORS',
  { timeout: 240000 },
  async (t) => {
    await startRelayServer(t);
    const browser = await harness.launch(t, FLAGS);
    const receiver = await openPage(
      t,
      browser,
      `${harness.ORIGIN}/manifest.json`,
    );
    const endpoint = await startEndpoint(t, receiver, false);
    const host = await openPerson(t, browser, 'alex');
    const { token } = await join(host);
    const guest = await openPerson(t, browser, 'kim');
    await join(guest, token);
    await host.front();
    await host.wait('return app.callStage.people.length === 2;');

    await addDestination(host, endpoint.url);
    await host.click(GO_LIVE);
    await host.wait(`return app.callStage.streaming.isActive;`);
    await host.wait(
      `const match = /^LIVE · (\\d+\\.\\d) Mbps/.exec(
      document.querySelector(${quote(STATUS)}).textContent);
    return match && Number(match[1]) > 0;`,
    );
    const posts = endpoint.of('POST');
    assert.equal(posts.length, 1);
    assert.equal(posts[0].url, '/whip');
    assert.equal(posts[0].headers.authorization, `Bearer ${TOKEN}`);
    assert.equal(posts[0].headers['content-type'], 'application/sdp');
    assert.equal(posts[0].headers.origin, undefined);
    assert.match(posts[0].body, /^v=0/);
    assert.ok(endpoint.of('OPTIONS').length >= 1, 'direct attempt first');

    await receiver.front();
    await receiver.wait(
      `const entry = window.receivers.at(-1);
    return entry.frames >= ${FRAMES} && entry.audio?.readyState === 'live';`,
      receiver.evaluate,
    );
    await guest.front();
    await guest.wait(hasChip(true, 'alex is live'));

    await host.front();
    await host.click(MORE);
    await host.wait(`return document.querySelector(${quote(STOP_LIVE)})
    .checkVisibility();`);
    await host.click(STOP_LIVE);
    await host.wait(`return !app.callStage.streaming.isActive;`);
    await host.wait(hasChip(false, ''));
    await delay(300);
    const deletes = endpoint.of('DELETE');
    assert.equal(deletes.length, 1);
    assert.equal(deletes[0].url, '/whip/1');
    assert.equal(deletes[0].headers.authorization, `Bearer ${TOKEN}`);
    assert.equal(deletes[0].headers.origin, undefined);
    assert.equal(endpoint.of('POST').length, 1);
    await guest.front();
    await guest.wait(hasChip(false, ''));
  },
);
