'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const harness = require('./harness.js');

const FLAGS = harness.MEDIA_FLAGS.concat([
  '--disable-features=WebRtcHideLocalIpsWithMdns',
]);
const PROGRAM = '.call-bar-menu [data-action=record-panel]';
const MORE = '.call-controls [data-action=more]';
const RECORD = '.call-controls [data-action=record]';
const STUDIO = '.call-bar-menu [data-action=studio]';
const JOIN = 'You are backstage, not in the recording or stream';
const STAGE = 'You are on stage';

const quote = JSON.stringify;

const openPerson = async (t, browser, nick, options = {}) => {
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
  const run = (body) => harness.run(browser, sessionId, body);
  const wait = (body) => harness.wait(browser, sessionId, body, 25000);
  const front = () => request('Page.bringToFront');
  await request('Runtime.enable');
  await request('Page.enable');
  if (options.phone) {
    await request('Emulation.setDeviceMetricsOverride', {
      width: 390,
      height: 844,
      mobile: true,
      deviceScaleFactor: 2,
    });
  }
  await request('Page.addScriptToEvaluateOnNewDocument', {
    source: `localStorage.setItem('xxii:nick', ${quote(nick)});
      ${options.noRecorder ? 'globalThis.MediaRecorder = undefined;' : ''}`,
  });
  await request('Page.navigate', { url: harness.ORIGIN });
  await front();
  await wait('return app.connected && app.mesh.peers.has(app.peerId);');
  const click = (selector) =>
    run(`${selector === RECORD ? 'window.confirm = () => true;' : ''}
      document.querySelector(${quote(selector)}).click();`);
  return { run, wait, front, click };
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

const personRow = (panel, endpoint) =>
  `${panel} li[data-endpoint="${endpoint}"]`;

const cameraTile = (endpoint) =>
  `.call-grid .call-tile[data-endpoint="${endpoint}"][data-slot=camera]`;

const programHas = (endpoint, included) => `
  const { compositor, mixer } = app.callStage.recording;
  const id = ${quote(endpoint)};
  const hasTile = compositor?.tiles.some((tile) => tile.id === id + '/camera');
  const gain = mixer?.gains.get(id + '/mic');
  return hasTile === ${included} && ${included ? 'gain > 0' : 'gain === 0'};
`;

const watchNotices = (page) =>
  page.run(`
  window.stageNotices = [];
  const note = document.querySelector('#notification');
  const live = document.querySelector('#call-announcements');
  const observer = new MutationObserver(() => {
    const text = note.textContent;
    if (note.checkVisibility() && live.textContent === text &&
        live.getAttribute('aria-live') === 'polite') {
      window.stageNotices.push(text);
    }
  });
  observer.observe(note, { attributes: true, childList: true });
  observer.observe(live, { attributes: true, childList: true });
`);

const waitForStage = async (page, backstage) => {
  const text = quote(backstage ? JOIN : STAGE);
  await page.wait(`return window.stageNotices.includes(${text});`);
  await page.wait(`
    const chip = document.querySelector('.call-topbar .call-backstage');
    return chip?.checkVisibility() === ${backstage};
  `);
};

const openStudio = async (page) => {
  await page.click(MORE);
  await page.click(STUDIO);
  await page.wait(`return document.querySelector('.call-studio[data-open]')
    ?.checkVisibility();`);
};

test('scenario 20: stage and backstage', { timeout: 240000 }, async (t) => {
  await harness.startCallServer(t);
  const browser = await harness.launch(t, FLAGS);
  const host = await openPerson(t, browser, 'alex');
  const { token } = await join(host);
  const guest = await openPerson(t, browser, 'kim', { phone: true });
  const { endpoint } = await join(guest, token);
  await watchNotices(guest);
  const row = personRow('.studio-stage-lists', endpoint);
  const roster = personRow('.call-people-roster', endpoint);
  const tile = cameraTile(endpoint);

  await host.front();
  await host.click(MORE);
  await host.click(PROGRAM);
  await host.run(`const people = document.querySelector('[data-record=people]');
    people.value = 'grid';
    people.dispatchEvent(new Event('change', { bubbles: true }));
    window.preview = document.querySelector('.record-preview canvas');`);
  await openStudio(host);
  assert.equal(
    await host.run(`return window.preview ===
      document.querySelector('.studio-preview canvas') &&
      !document.querySelector('.call-record').checkVisibility() &&
      !document.querySelector('[data-studio=enabled]').checked &&
      !document.querySelector('.call-people .call-stage-group');`),
    true,
  );
  await host.click(RECORD);
  await host.wait(programHas(endpoint, true));

  await host.click(`${row} [data-action=move-to-backstage]`);
  await host.wait(programHas(endpoint, false));
  await host.wait(`const tile = document.querySelector(${quote(tile)});
    const audio = app.callStage.audios.get(${quote(endpoint)});
    const groups = [...document.querySelectorAll('.call-people h3')];
    const label = tile?.querySelector('.call-name').textContent;
    const names = groups.map((heading) => heading.textContent).join(',');
    return label?.endsWith('backstage') &&
      audio?.srcObject?.getAudioTracks().length === 1 &&
      names === 'On stage,Backstage'
      && document.querySelector(${quote(roster)})?.closest('section')
        .querySelector('h3').textContent === 'Backstage';`);
  await guest.front();
  await waitForStage(guest, true);
  await openStudio(guest);
  assert.equal(
    await guest.run(`return app.callStage.sheet === 'studio' &&
      document.querySelector('.studio-permission').textContent ===
        'Only hosts can move people' &&
      document.querySelector('[data-studio=join-backstage]').closest('label')
        .hidden &&
      !document.querySelector('.call-studio [data-action^=move-to-]');`),
    true,
  );
  await guest.run(
    `window.preview = document.querySelector('.studio-preview canvas');`,
  );
  await guest.click(MORE);
  await guest.click(PROGRAM);
  assert.equal(
    await guest.run(`return app.callStage.sheet === 'record' &&
      !document.querySelector('.call-studio').checkVisibility() &&
      document.querySelector('.call-record').checkVisibility() &&
      window.preview === document.querySelector('.record-preview canvas') &&
      app.layers.filter((layer) => layer === 'callSheet').length === 1;`),
    true,
  );
  await guest.click('.call-tabs-close');
  await guest.wait(`return app.callStage.sheet === '';`);

  await host.front();
  await host.click(`${row} [data-action=move-to-stage]`);
  await host.wait(programHas(endpoint, true));
  await host.wait(`return !document.querySelector('.call-people h3');`);
  await guest.front();
  await waitForStage(guest, false);
  await host.front();
  await host.click('[data-studio=enabled]');
  assert.equal(await host.run('return app.callStage.studio.enabled;'), true);
  await host.click(`${tile} [data-action=tile-menu]`);
  await host.click('.call-tile-menu [data-action=move-to-backstage]');
  await host.wait(programHas(endpoint, false));
  await host.click('.call-tab-people');
  await host.click(`${roster} [data-action=roster-menu]`);
  await host.click('.call-tile-menu [data-action=move-to-stage]');
  await host.wait(programHas(endpoint, true));
  await host.click('[data-studio=join-backstage]');
  await host.wait(`return app.callStage.joinBackstage &&
    document.querySelectorAll('.call-people h3').length === 2;`);
  const extra = await openPerson(t, browser, 'sam', { noRecorder: true });
  await watchNotices(extra);
  const third = await join(extra, token);
  await waitForStage(extra, true);
  assert.equal(
    await extra.run(`return !document.querySelector('.call-studio') &&
      !document.querySelector(${quote(STUDIO)});`),
    true,
  );
  await host.front();
  await host.wait(programHas(third.endpoint, false));
  await host.click(RECORD);
  await host.wait('return !app.callStage.recording.isActive;');
  assert.deepEqual(browser.errors, []);
});
