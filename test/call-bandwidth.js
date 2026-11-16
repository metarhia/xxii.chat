'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { setTimeout: delay } = require('node:timers/promises');

const harness = require('./harness.js');

const { MEDIA_FLAGS, ORIGIN, launch, startCallServer } = harness;
const FLAGS = MEDIA_FLAGS.concat([
  '--disable-features=WebRtcHideLocalIpsWithMdns',
]);
const READY = 'return app.connected && app.mesh.peers.has(app.peerId);';
const JOIN = `document.querySelector('#prejoin [data-action=join]').click();
  return true;`;

const openPerson = async (t, browser) => {
  const { browserContextId } = await browser.request(
    'Target.createBrowserContext',
  );
  t.after(() =>
    browser
      .request('Target.disposeBrowserContext', {
        browserContextId,
      })
      .catch(() => undefined),
  );
  const { targetId } = await browser.request('Target.createTarget', {
    url: `${ORIGIN}/?test`,
    browserContextId,
  });
  const { sessionId } = await browser.request('Target.attachToTarget', {
    targetId,
    flatten: true,
  });
  await browser.request('Runtime.enable', {}, sessionId);
  await browser.request('Page.enable', {}, sessionId);
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    const ready = await browser
      .evaluate(sessionId, 'document.readyState')
      .catch(() => '');
    if (ready === 'complete') break;
    await delay(50);
  }
  await harness.wait(browser, sessionId, READY);
  return sessionId;
};

const waitFor = async (browser, session, body) => {
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    const result = await harness.run(browser, session, body).catch(() => false);
    if (result) return;
    await delay(100);
  }
  const result = await harness.run(browser, session, body);
  throw new Error(`Bandwidth condition failed: ${JSON.stringify(result)}`);
};

const encodingCheck = (endpoint, active) => {
  const remote = JSON.stringify(endpoint);
  return `const sender = app.callSession.sender(${remote}, 'camera');
    const encoding = sender?.getParameters().encodings?.[0];
    return encoding?.maxBitrate === 800000 && encoding.active === ${active};`;
};

const tileAction = (endpoint, body) => {
  const remote = JSON.stringify(endpoint);
  return `const tiles = document.querySelectorAll('.call-tile');
    const tile = [...tiles].find(
      (item) => item.dataset.endpoint === ${remote});
    if (!tile) throw new Error('Missing remote tile');
    ${body}
    return true;`;
};

test(
  'four-person bandwidth, hidden tile restoration and audio only',
  {
    timeout: 180000,
  },
  async (t) => {
    await startCallServer(t);
    const browser = await launch(t, FLAGS);
    const run = (session, body) => harness.run(browser, session, body);
    const people = [];
    const left = await openPerson(t, browser);
    people.push(left);
    const host = await run(
      left,
      `app.selectChat('general');
    await app.startCall('general');
    return { endpoint: app.callSession.endpoint, token: app.callToken };`,
    );
    await run(left, JOIN);
    for (let index = 1; index < 4; index++) {
      const session = await openPerson(t, browser);
      people.push(session);
      await run(
        session,
        `app.selectChat('general');
      await app.startCall('general', { token: ${JSON.stringify(host.token)} });
      return true;`,
      );
      await run(session, JOIN);
    }
    const right = people[1];
    for (const session of people) {
      await waitFor(
        browser,
        session,
        `const session = app.callSession;
      if (session?.linkCount !== 3) return false;
      return app.callStage.people.every((person) => {
        if (person.endpoint === session.endpoint) return true;
        const encoding = session.sender(person.endpoint, 'camera')
          ?.getParameters().encodings?.[0];
        return encoding?.maxBitrate === 800000;
      });`,
      );
    }
    const remote = await run(right, 'return app.callSession.endpoint;');
    await browser.request('Page.bringToFront', {}, right);
    await waitFor(browser, left, encodingCheck(remote, true));
    await run(right, tileAction(host.endpoint, `tile.style.display = 'none';`));
    await waitFor(browser, left, encodingCheck(remote, false));
    const independent = await run(
      right,
      `const sender = app.callSession.sender(
    ${JSON.stringify(host.endpoint)}, 'camera');
    return sender.getParameters().encodings[0].maxBitrate === 800000;`,
    );
    assert.equal(independent, true);
    await run(right, tileAction(host.endpoint, `tile.style.display = '';`));
    await waitFor(browser, left, encodingCheck(remote, true));
    await run(
      right,
      tileAction(
        host.endpoint,
        `tile.querySelector('[data-action="tile-menu"]').click();
    document.querySelector(
      '.call-tile-menu [data-action="audio-only"]').click();`,
      ),
    );
    await waitFor(browser, left, encodingCheck(remote, false));
    await waitFor(browser, right, encodingCheck(host.endpoint, false));
    assert.equal(
      await run(
        right,
        `const receiver = app.callSession.receiver(
    ${JSON.stringify(host.endpoint)}, 'camera');
    return receiver.track.enabled === false &&
      app.callStage.videoTrack(${JSON.stringify(host.endpoint)}) === null;`,
      ),
      true,
    );
    await run(
      right,
      tileAction(
        host.endpoint,
        `tile.querySelector('[data-action="tile-menu"]').click();
    document.querySelector(
      '.call-tile-menu [data-action="audio-only"]').click();`,
      ),
    );
    await waitFor(browser, left, encodingCheck(remote, true));
    const restored = await run(
      right,
      `const receiver = app.callSession.receiver(
    ${JSON.stringify(host.endpoint)}, 'camera');
    return receiver.track.enabled === true;`,
    );
    assert.equal(restored, true);
    for (const session of people) await run(session, 'await app.closeCall();');
  },
);
