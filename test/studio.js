'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { setTimeout: delay } = require('node:timers/promises');

const harness = require('./harness.js');

const STUDIO = '.call-bar-menu [data-action=studio]';
const MORE = '.call-controls [data-action=more]';
const RECORD_PANEL = '.call-bar-menu [data-action=record-panel]';
const RECORD = '.call-controls [data-action=record]';
const STUDIO_ACTION = '[data-studio-action]';
const COMMENT_MENU = 'button[data-action="screen-comment"]';
const FLAGS = harness.MEDIA_FLAGS.concat([
  '--disable-features=WebRtcHideLocalIpsWithMdns',
]);
const FIRST = '#cc2020';
const SECOND = '#2020cc';
const IMAGE =
  '<svg xmlns="http://www.w3.org/2000/svg" width="48" height="24">' +
  '<rect width="48" height="24" fill="#00ff00"/></svg>';
const READY = 'app.connected && app.mesh.peers.has(app.peerId)';
const quote = JSON.stringify;

const setup = async (t, settings = {}) => {
  await harness.startCallServer(t);
  const browser = await harness.launch(t, FLAGS);
  const createContext = async () => {
    const { browserContextId } = await browser.request(
      'Target.createBrowserContext',
    );
    t.after(() =>
      browser
        .request('Target.disposeBrowserContext', { browserContextId })
        .catch(() => undefined),
    );
    return browserContextId;
  };
  const open = async (browserContextId) => {
    const target = await browser.request('Target.createTarget', {
      url: 'about:blank',
      browserContextId,
    });
    const { sessionId } = await browser.request('Target.attachToTarget', {
      ...target,
      flatten: true,
    });
    const request = (method, params = {}) =>
      browser.request(method, params, sessionId);
    await request('Page.enable');
    await request('Runtime.enable');
    const run = (body) => harness.run(browser, sessionId, body);
    const evaluate = (body) =>
      browser.evaluate(sessionId, `(async () => { ${body} })()`);
    const close = () => browser.request('Target.closeTarget', target);
    const wait = async (body, execute = run) => {
      const deadline = Date.now() + 15000;
      while (Date.now() < deadline) {
        if (await execute(body).catch(() => false)) return;
        await delay(100);
      }
      const result = await execute(body);
      const detail = JSON.stringify(result);
      throw new Error(`Browser condition failed: ${detail} ${body}`);
    };
    return { request, run, evaluate, wait, close };
  };
  const openPerson = async (nick, defaults = {}) => {
    const context = await createContext();
    const page = await open(context);
    const { request, wait } = page;
    const saved = quote(quote(defaults));
    await request('Page.addScriptToEvaluateOnNewDocument', {
      source: `localStorage.setItem('xxii:nick', ${quote(nick)});
        if (!localStorage.getItem('xxii:call-settings')) {
          localStorage.setItem('xxii:call-settings', ${saved});
        }`,
    });
    await request('Page.navigate', { url: harness.ORIGIN });
    await request('Page.bringToFront');
    await wait(`return ${READY};`);
    return { ...page, open: () => open(context) };
  };
  const page = await openPerson('alex', settings);
  return { ...page, openPerson };
};

const click = (page, selector) =>
  page.run(`${selector === RECORD ? 'window.confirm = () => true;' : ''}
    document.querySelector(${quote(selector)}).click();`);

const change = (page, selector, value) =>
  page.run(`const control = document.querySelector(${quote(selector)});
    if (control.type === 'checkbox') control.checked = ${quote(value)};
    else control.value = ${quote(value)};
    control.dispatchEvent(new Event('change', { bubbles: true }));`);

const field = (name) => `[data-studio="${name}"]`;
const action = (name, id = '') =>
  `[data-studio-action="${name}"]${id ? `[data-id="${id}"]` : ''}`;
const chosen = (id) =>
  `return document.querySelector(${quote(action('switch-scene', id))})
    ?.getAttribute('aria-pressed') === 'true';`;

const join = async (page, token = '') => {
  await page.run(`app.selectChat('general');
    await app.startCall('general', { token: ${quote(token)} });`);
  await click(page, '#prejoin [data-action=join]');
  await page.wait('return app.callStage?.mode === "call";');
};

const openStudio = async (page) => {
  await click(page, MORE);
  await click(page, STUDIO);
  await page.wait('return document.querySelector(".studio-preview canvas");');
};

const edit = async (page, id, values) => {
  await click(page, action('edit-scene', id));
  await page.wait(`
    const editor = document.querySelector('[data-studio-section=editor]');
    return !editor.hidden;
  `);
  const editor = '[data-studio-section=editor]';
  for (const name in values) {
    const value = values[name];
    const record = `[data-record="${name}"]`;
    const selector = `${editor} ${field(name)}, ${editor} ${record}`;
    await change(page, selector, value);
  }
  await click(page, action('save-scene'));
  await page.wait(`return document.querySelector('[data-studio-section=editor]')
    .hidden;`);
};

const recordingURL = (id) => `
  const root = await navigator.storage.getDirectory();
  const library = await root.getDirectoryHandle('recordings');
  const dir = await library.getDirectoryHandle(${quote(id)});
  const file = await (await dir.getFileHandle('meta.json')).getFile();
  const meta = JSON.parse(await file.text());
  if (meta.state !== 'done') throw new Error(meta.state);
  return '/recordings/' + meta.id + '/program.' + meta.extension;
`;

const playback = (url) => `
  const media = document.createElement('video');
  media.preload = 'auto';
  media.muted = true;
  media.playsInline = true;
  Object.assign(media.style, {
    position: 'fixed', top: '0', left: '0', width: '320px',
    zIndex: '2147483647',
  });
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 1;
  Object.assign(canvas.style, { position: 'fixed', bottom: '0', left: '0' });
  document.body.replaceChildren(media, canvas);
  const context = canvas.getContext('2d', { willReadFrequently: true });
  const history = [];
  let refreshes = 0;
  let callbacks = 0;
  let lastPresented = 0;
  let sampleError = null;
  let animation = 0;
  let videoFrame = 0;
  const refresh = () => {
    refreshes++;
    canvas.style.left = (refreshes % 2) + 'px';
    animation = requestAnimationFrame(refresh);
  };
  const sample = (now, metadata) => {
    callbacks++;
    lastPresented = metadata.presentedFrames;
    videoFrame = media.requestVideoFrameCallback(sample);
    try {
      context.drawImage(media, 8, 8, 1, 1, 0, 0, 1, 1);
      const rgb = context.getImageData(0, 0, 1, 1).data.slice(0, 3);
      history.push({ time: metadata.mediaTime, rgb,
        presented: lastPresented, clock: media.currentTime });
    } catch (error) {
      sampleError ??= error.stack || error.message;
    }
  };
  try {
    await new Promise((resolve, reject) => {
      media.onloadeddata = resolve;
      media.onerror = () => reject(media.error);
      media.src = ${quote(url)};
    });
    if (document.hidden || document.elementFromPoint(12, 12) !== media) {
      throw new Error('Recording playback must be visible in the foreground');
    }
    media.playbackRate = 0.75;
    animation = requestAnimationFrame(refresh);
    videoFrame = media.requestVideoFrameCallback(sample);
    await new Promise((resolve, reject) => {
      media.onended = resolve;
      media.onerror = () => reject(media.error);
      media.play().catch(reject);
    });
    const quality = media.getVideoPlaybackQuality();
    return { frames: history, total: quality.totalVideoFrames,
      dropped: quality.droppedVideoFrames, duration: media.duration,
      rate: media.playbackRate, refreshes, callbacks, lastPresented,
      sampleError };
  } finally {
    cancelAnimationFrame(animation);
    media.cancelVideoFrameCallback(videoFrame);
    media.remove();
    canvas.remove();
  }
`;

const playRecording = async (page, url) => {
  const player = await page.open();
  const documentUrl = `${harness.ORIGIN}/manifest.json`;
  try {
    await player.request('Page.navigate', { url: documentUrl });
    await player.request('Page.bringToFront');
    await player.wait(
      `return location.href === ${quote(documentUrl)} && !document.hidden &&
        document.readyState === 'complete' &&
        Boolean(navigator.serviceWorker.controller);`,
      player.evaluate,
    );
    return await player.evaluate(playback(url));
  } finally {
    await player.close();
    await page.request('Page.bringToFront');
  }
};

const position = `
  const { compositor, recorder } = app.callStage.recording;
  return { drawn: compositor.frames, activeMs: recorder.activeMs };
`;

const hiddenSamples = `
  const { compositor } = app.callStage.recording;
  const context = compositor.canvas.getContext('2d');
  const copy = document.createElement('canvas');
  copy.width = copy.height = 1;
  const pixel = copy.getContext('2d', { willReadFrequently: true });
  const draw = compositor.draw.bind(compositor);
  window.studioSamples = [];
  compositor.draw = () => {
    draw();
    pixel.drawImage(context.canvas, 8, 8, 1, 1, 0, 0, 1, 1);
    const rgb = pixel.getImageData(0, 0, 1, 1).data.slice(0, 3);
    window.studioSamples.push({ rgb, hidden: document.hidden });
  };
`;

const privacyFade = `
  const { Compositor } = await import('/compositor.js');
  const { sceneOf, brandOf } = await import('/studio-layout.js');
  const source = document.createElement('canvas');
  source.width = source.height = 64;
  const fill = source.getContext('2d');
  fill.fillStyle = '#00ff00';
  const camera = source.captureStream(0).getVideoTracks()[0];
  const member = {
    endpoint: 'test',
    nick: 'participant',
    stage: true,
    optOut: false,
    camera
  };
  const live = sceneOf({ id: 'one', name: 'Live', type: 'live',
    background: { color: ${quote(FIRST)} }, program: { people: 'grid' } });
  const slate = sceneOf({ id: 'two', name: 'Break', type: 'intermission',
    background: { color: ${quote(SECOND)} } });
  const frame = { scene: live, previous: null, alpha: 1, until: 0,
    brand: brandOf(), font: 'system-ui', image: () => null };
  const studio = { frame: () => frame };
  const compositor = new Compositor({
    members: () => [member],
    options: () => ({ quality: '720p30', studio })
  });
  const copy = document.createElement('canvas');
  copy.width = copy.height = 1;
  const pixel = copy.getContext('2d', { willReadFrequently: true });
  const sample = () => {
    compositor.draw();
    pixel.drawImage(compositor.canvas, 510, 260, 1, 1, 0, 0, 1, 1);
    return pixel.getImageData(0, 0, 1, 1).data.slice(0, 3);
  };
  try {
    let before;
    for (let attempt = 0; attempt < 40; attempt++) {
      fill.fillRect(0, 0, 64, 64);
      camera.requestFrame();
      before = sample();
      if (before[1] > 245) break;
      await new Promise((resolve) => setTimeout(resolve, 30));
    }
    Object.assign(frame, {
      scene: slate,
      previous: { scene: live },
      alpha: .5
    });
    const visible = sample();
    member.optOut = true;
    const optedOut = sample();
    member.stage = false;
    member.optOut = false;
    return { before, visible, optedOut, backstage: sample() };
  } finally {
    compositor.stop();
    camera.stop();
  }
`;

const getRecords = `
  const root = await navigator.storage.getDirectory();
  const dir = await root.getDirectoryHandle('studio');
  const read = async (name) => JSON.parse(await (
    await (await dir.getFileHandle(name)).getFile()).text());
  return { scenes: await read('scenes.json'), brand: await read('brand.json'),
    assets: await read('assets.json') };
`;

const assetFile = `
  const file = new File([${quote(IMAGE)}], 'Green.svg', {
    type: 'image/svg+xml'
  });
`;

const wave = `
  const rate = 8000;
  const length = 4 * rate;
  const bytes = new ArrayBuffer(44 + length * 2);
  const view = new DataView(bytes);
  const label = (offset, word) => {
    for (let index = 0; index < word.length; index++) {
      view.setUint8(offset + index, word.charCodeAt(index));
    }
  };
  label(0, 'RIFF');
  view.setUint32(4, bytes.byteLength - 8, true);
  label(8, 'WAVEfmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, rate, true);
  view.setUint32(28, rate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  label(36, 'data');
  view.setUint32(40, length * 2, true);
  for (let index = 0; index < length; index++) {
    const value = Math.round(12000 * Math.sin(index * Math.PI / 8));
    view.setInt16(44 + index * 2, value, true);
  }
  const file = new File([bytes], 'Tone.wav', { type: 'audio/wav' });
`;

const upload = (page, source) =>
  page.run(`
    ${source}
    const data = new DataTransfer();
    data.items.add(file);
    const input = document.querySelector('[data-studio=upload]');
    input.files = data.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));
  `);

const mediaProbe = `
  window.studioAudio = [];
  const attach = AudioContext.prototype.createMediaElementSource;
  AudioContext.prototype.createMediaElementSource = function (media) {
    window.studioAudio.push(media);
    return attach.call(this, media);
  };
  window.studioAnalyser = null;
  window.musicLevel = () => {
    const { mixer } = app.callStage.recording;
    if (window.studioAnalyser?.context !== mixer.context) {
      const context = mixer.context;
      const analyser = context.createAnalyser();
      const source = context.createMediaStreamSource(mixer.stream);
      source.connect(analyser);
      window.studioAnalyser = analyser;
    }
    const analyser = window.studioAnalyser;
    const samples = new Float32Array(analyser.fftSize);
    analyser.getFloatTimeDomainData(samples);
    const squares = samples.reduce((sum, n) => sum + n * n, 0);
    return Math.sqrt(squares / samples.length);
  };
`;

const isFirst = ({ rgb }) => rgb[0] > 150 && rgb[2] < 75;
const isSecond = ({ rgb }) => rgb[2] > 150 && rgb[0] < 75;

test(
  'Studio cut in a recording, hidden fade, OPFS settings and music',
  {
    timeout: 240000,
  },
  async (t) => {
    const page = await setup(t);
    const { run, wait, request, open } = page;
    await join(page);
    await click(page, MORE);
    await click(page, RECORD_PANEL);
    await change(page, '.call-record [data-record=people]', 'grid');
    await change(page, '.call-record [data-record=quality]', '720p30');
    await openStudio(page);
    await wait(chosen('live'));
    const groups = await run(`
      return [...document.querySelectorAll('.studio-options')]
        .filter((group) => group.getClientRects().length > 0)
        .map((group) => {
          const box = group.getBoundingClientRect();
          const legend = group.querySelector('legend').getBoundingClientRect();
          const style = getComputedStyle(group);
          return {
            border: style.borderWidth,
            background: style.backgroundColor,
            isInside: legend.top >= box.top && legend.bottom <= box.bottom,
            isIndented: legend.left >= box.left,
          };
        });
    `);
    assert.ok(groups.length >= 2);
    for (const group of groups) {
      assert.equal(group.border, '0px');
      assert.notEqual(group.background, 'rgba(0, 0, 0, 0)');
      assert.equal(group.isInside, true);
      assert.equal(group.isIndented, true);
    }
    await edit(page, 'break', { name: 'Warm', color: FIRST });
    await edit(page, 'ending', { name: 'Cool', color: SECOND });
    await change(page, field('transition'), 'cut');
    await click(page, action('switch-scene', 'break'));
    await wait(chosen('break'));
    await change(page, field('enabled'), true);
    await wait('return app.callStage.studio.enabled;');

    await click(page, MORE);
    await click(page, RECORD_PANEL);
    assert.equal(
      await run(`
      const panel = document.querySelector('.call-record[data-open]');
      const quality = panel.querySelector('[data-record=quality]');
      const shared = ['quality', 'recordingTarget', 'recordingSegment'];
      return quality.value === '720p30' && !quality.disabled &&
        !panel.querySelector('[data-record=recordingTarget]')?.disabled &&
        [...panel.querySelectorAll('[data-record]')]
          .filter((control) => !shared.includes(control.dataset.record))
          .every((control) => control.disabled) &&
        panel.querySelector('.record-follows').textContent ===
          'Program follows the Studio scene Warm';
    `),
      true,
    );
    await openStudio(page);
    await wait(`
      const canvas = document.querySelector('.studio-preview canvas');
      const rgb = canvas.getContext('2d').getImageData(8, 8, 1, 1).data;
      return rgb[0] > 185 && rgb[2] < 50;
    `);
    await click(page, RECORD);
    await wait('return app.callStage.recording.recorder?.meta?.id;');
    const id = await run('return app.callStage.recording.recorder.meta.id;');
    const startAt = await run(position);
    await wait('return app.callStage.recording.recorder.activeMs >= 2900;');
    const cutAt = await run(position);
    await click(page, action('switch-scene', 'ending'));
    await wait(chosen('ending'));
    await wait('return app.callStage.recording.recorder.activeMs >= 6000;');
    const stopAt = await run(position);
    await click(page, RECORD);
    await wait('return !app.callStage.recording.isActive;');
    await click(page, '.call-studio [data-action=studio]');
    const url = await run(recordingURL(id));
    assert.match(url, /^\/recordings\/[^/]+\/program\.mp4$/);
    const { frames, ...playbackInfo } = await playRecording(page, url);
    t.diagnostic(`capture clock ${quote({ startAt, cutAt, stopAt })}`);
    t.diagnostic(
      `playback ${quote(playbackInfo)} ${quote(frames.slice(0, 4))}`,
    );
    assert.equal(playbackInfo.sampleError, null);
    assert.ok(frames.length >= 90, `only ${frames.length} frames`);
    const before = frames.filter(({ time }) => time < 2);
    const after = frames.filter(({ time }) => time > 4);
    assert.ok(
      before.length > 25 && before.every(isFirst),
      `early frames ${before.length}, first mismatch ${quote(
        before.find((frame) => !isFirst(frame)),
      )}`,
    );
    assert.ok(
      after.length > 25 && after.every(isSecond),
      `late frames ${after.length}, first mismatch ${quote(
        after.find((frame) => !isSecond(frame)),
      )}`,
    );
    const cut = frames.find(isSecond);
    assert.ok(cut.time >= 2 && cut.time <= 4, `cut at ${cut.time}s`);
    assert.ok(frames.every((frame) => isFirst(frame) || isSecond(frame)));
    t.diagnostic(
      `sampled ${frames.length} playback frames, cut at ${cut.time}s`,
    );

    await openStudio(page);
    await change(page, field('transition'), 'fade');
    await run(hiddenSamples);
    const cover = await open();
    await cover.request('Page.bringToFront');
    await wait('return document.hidden;');
    await run('window.studioSamples.length = 0;');
    await click(page, action('switch-scene', 'break'));
    await wait(`
    return window.studioSamples.some(({ rgb }) => rgb[0] > 185 && rgb[2] < 50);
  `);
    const hidden = await run('return window.studioSamples;');
    assert.ok(hidden.every(({ hidden }) => hidden));
    assert.ok(hidden.some(({ rgb }) => rgb[0] > 55 && rgb[2] > 55));
    await request('Page.bringToFront');
    const privacy = await run(privacyFade);
    assert.ok(privacy.before[1] > 245);
    assert.ok(privacy.visible[1] > 120);
    assert.ok(privacy.optedOut[1] < 100);
    const backstage = privacy.backstage;
    const blend = Math.abs(backstage[0] - backstage[2]);
    assert.ok(blend <= 2 && backstage[0] > 116 && backstage[0] < 121);
    assert.equal(backstage[1], 32);

    await upload(
      page,
      `
      const bytes = new Uint8Array(10000001);
      const file = new File([bytes], 'Large.png', { type: 'image/png' });
    `,
    );
    await wait(`
      const notice = document.querySelector('.studio-status');
      return notice.textContent.includes('10 MB');
    `);
    await upload(page, assetFile);
    await wait(
      'return document.querySelector("[data-studio-list=assets] li");',
    );
    const image = await run(`return document.querySelector(
    '[data-studio-list=assets] button').dataset.id;`);
    await change(page, field('accent'), '#e04f19');
    await change(page, field('chipStyle'), 'bar');
    await change(page, field('font'), 'system-ui');
    await change(page, field('logoAsset'), image);
    await change(page, field('corner'), 'bottom-right');
    await change(page, field('size'), 132);
    await edit(page, 'ending', { image });
    await wait(`
    const { brand, scenes } = await (async () => { ${getRecords} })();
    return brand.logo.size === 132 && scenes.scenes.find(
      (scene) => scene.id === 'ending').background.image === ${quote(image)};
  `);
    await click(page, action('add-scene'));
    await wait(`return !document.querySelector('[data-studio-section=editor]')
    .hidden;`);
    await change(page, field('name'), 'New scene');
    await click(page, action('save-scene'));
    await wait(`return [...document.querySelectorAll(${quote(STUDIO_ACTION)})]
    .some((button) => button.textContent === 'New scene');`);
    const saved = await run(getRecords);
    assert.equal(image, createHash('sha256').update(IMAGE).digest('hex'));
    assert.deepEqual(saved.assets[0], {
      checksum: image,
      name: 'Green.svg',
      type: 'image/svg+xml',
      size: Buffer.byteLength(IMAGE),
    });
    await run('window.studioBeforeReload = true;');
    await request('Page.reload');
    await wait(`return !window.studioBeforeReload && ${READY};`);
    await join(page);
    await openStudio(page);
    await wait(`return document.querySelector('[data-studio=logoAsset]')
    .value === ${quote(image)};`);
    assert.deepEqual(await run(getRecords), saved);
    assert.equal(await run('return app.callStage.studio.enabled;'), false);
    await wait(chosen('break'));
    await click(page, MORE);
    await click(page, RECORD_PANEL);
    await change(page, '.call-record [data-record=includeMe]', false);
    await openStudio(page);
    await change(page, field('enabled'), true);
    await wait(`
    const canvas = document.querySelector('.studio-preview canvas');
    const y = canvas.height - 30;
    const x = canvas.width - 30;
    const pixel = canvas.getContext('2d').getImageData(x, y, 1, 1).data;
    return pixel[1] > 230 && pixel[0] < 30;
  `);
    await click(page, action('switch-scene', 'ending'));
    await wait(`
      const canvas = document.querySelector('.studio-preview canvas');
      const rgb = canvas.getContext('2d').getImageData(8, 8, 1, 1).data;
      return rgb[1] > 240 && rgb[0] < 10 && rgb[2] < 10;
    `);
    await click(page, action('switch-scene', 'break'));
    await wait(chosen('break'));
    await click(page, action('delete-asset', image));
    await wait(`
    const { brand, scenes, assets } = await (async () => { ${getRecords} })();
    return !brand.logo.asset && !assets.length &&
      scenes.scenes.every((scene) => !scene.background.image);
  `);

    await upload(page, wave);
    await wait(
      'return document.querySelector("[data-studio-list=assets] li");',
    );
    const audio = await run(`return document.querySelector(
    '[data-studio-list=assets] button').dataset.id;`);
    await edit(page, 'break', { music: audio });
    await edit(page, 'ending', { music: audio });
    await run(mediaProbe);
    assert.equal(
      await run(
        `const volume = document.querySelector('[data-studio=musicVolume]');
        return Number(volume.value);`,
      ),
      25,
    );
    await click(page, RECORD);
    await wait(
      `const music = window.studioAudio[0];
      return music?.currentTime > 1.1 && window.musicLevel() > 0.02;`,
    );
    const audioTime = await run('return window.studioAudio[0].currentTime;');
    await click(page, action('switch-scene', 'ending'));
    await wait(chosen('ending'));
    await wait(
      `return window.studioAudio[0].currentTime > ${audioTime + 0.3};`,
    );
    assert.equal(
      await run(`
    const media = window.studioAudio[0];
    return window.studioAudio.length === 1 && media.loop && !media.isConnected;
  `),
      true,
    );
    await change(page, field('musicVolume'), 0);
    await wait('return window.musicLevel() < 0.003;');
    await change(page, field('musicVolume'), 25);
    await wait('return window.musicLevel() > 0.02;');
    await click(page, RECORD);
    await wait('return !app.callStage.recording.isActive;');
    await click(page, RECORD);
    await wait(
      `const music = window.studioAudio[1];
      return music?.currentTime > 1.1 && window.musicLevel() > 0.02;`,
    );
    await run('window.musicFadeAt = performance.now();');
    await click(page, action('switch-scene', 'starting-soon'));
    await wait('return window.studioAudio[1].paused;');
    const musicFade = await run(
      'return performance.now() - window.musicFadeAt;',
    );
    assert.ok(musicFade >= 850 && musicFade < 1600, `fade ${musicFade}ms`);
    await wait('return window.musicLevel() < 0.003;');

    await click(page, action('switch-scene', 'ending'));
    await wait(`const music = window.studioAudio[2];
      return music?.currentTime > 1.1 && window.musicLevel() > 0.02;`);
    await change(page, field('enabled'), false);
    await wait('return !app.callStage.studio.enabled;');
    assert.equal(
      await run(`
        const { mixer, isActive } = app.callStage.recording;
        mixer.update();
        const media = window.studioAudio[2];
        return isActive && media.paused && !media.hasAttribute('src');
      `),
      true,
    );
    await wait('return window.musicLevel() < 0.003;');
    await change(page, field('enabled'), true);
    await wait(`const music = window.studioAudio[3];
      return music?.currentTime > 1.1 && window.musicLevel() > 0.02;`);
    await click(page, RECORD);
    await wait('return !app.callStage.recording.isActive;');
    assert.ok(
      await run('return window.studioAudio.every((media) => media.paused);'),
    );
  },
);

const videoFile = `
  const canvas = document.createElement('canvas');
  canvas.width = 320;
  canvas.height = 180;
  const paint = canvas.getContext('2d');
  const frame = (index) => {
    paint.fillStyle = '#00bddd';
    paint.fillRect(0, 0, 320, 180);
    paint.fillStyle = index % 2 ? '#eeeeee' : '#101010';
    paint.fillRect(0, 0, 4, 4);
  };
  frame(0);
  const video = canvas.captureStream(20);
  const context = new AudioContext();
  const oscillator = context.createOscillator();
  const gain = context.createGain();
  const audio = context.createMediaStreamDestination();
  oscillator.frequency.value = 1000;
  gain.gain.value = 0.2;
  oscillator.connect(gain).connect(audio);
  oscillator.start();
  await context.resume();
  const tracks = video.getTracks().concat(audio.stream.getTracks());
  const mimeType = 'video/webm;codecs=vp8,opus';
  const recorder = new MediaRecorder(new MediaStream(tracks), { mimeType });
  const chunks = [];
  recorder.ondataavailable = ({ data }) => chunks.push(data);
  const complete = new Promise((resolve) => { recorder.onstop = resolve; });
  recorder.start();
  let index = 0;
  const timer = setInterval(() => frame(index++), 50);
  try {
    await new Promise((resolve) => setTimeout(resolve, 5500));
    recorder.stop();
    await complete;
  } finally {
    clearInterval(timer);
    oscillator.stop();
    tracks.forEach((track) => track.stop());
    await context.close();
  }
  const file = new File(chunks, 'Clip.webm', { type: 'video/webm' });
`;

const overlayProbe = `
  const copy = document.createElement('canvas');
  const pixel = copy.getContext('2d', { willReadFrequently: true });
  window.studioPixel = (canvas, x, y) => {
    copy.width = copy.height = 1;
    pixel.drawImage(canvas, x, y, 1, 1, 0, 0, 1, 1);
    return pixel.getImageData(0, 0, 1, 1).data.slice(0, 3);
  };
  window.studioCards = () => {
    const { compositor } = app.callStage.recording;
    const { canvas, overlays } = compositor;
    return Object.fromEntries(overlays.map((entry) => {
      const { kind, rect } = entry;
      const { x, y, width, height } = rect;
      const w = copy.width = Math.ceil(width);
      const h = copy.height = Math.ceil(height);
      pixel.drawImage(canvas, Math.floor(x), Math.floor(y), w, h, 0, 0, w, h);
      const data = pixel.getImageData(0, 0, copy.width, copy.height).data;
      let letters = 0;
      for (let index = 0; index < data.length; index += 4) {
        if (data[index] === 148 && data[index + 1] === 251 &&
            data[index + 2] === 47) letters++;
      }
      return [kind, { ...entry, letters,
        accent: window.studioPixel(canvas, x + 2, y + 3),
        chip: window.studioPixel(canvas, x + width - 3, y + height - 4) }];
    }));
  };
  window.clipPixel = () => {
    const { compositor } = app.callStage.recording;
    const { canvas, tiles } = compositor;
    const tile = tiles.find(({ id }) => id.startsWith('clip/'));
    const x = tile ? tile.x + tile.width / 2 : canvas.width / 2;
    const y = tile ? tile.y + tile.height / 3 : canvas.height / 3;
    const pixel = window.studioPixel(canvas, x, y);
    const r = pixel[0];
    const g = pixel[1];
    const b = pixel[2];
    return r < 15 && g > 173 && g < 205 && b > 200;
  };
`;

const menuOf = (id, click = false) => `
  app.render();
  const id = ${quote(id)};
  app.openMenuFor(app.itemOf(id));
  if (app.menu.target !== id || !app.menuElement.checkVisibility()) {
    throw new Error('Message menu did not open');
  }
  const button = app.menuElement.querySelector(${quote(COMMENT_MENU)});
  if (button && !button.checkVisibility()) {
    throw new Error('Comment action is hidden');
  }
  const label = button?.textContent.trim() ?? '';
  if (!${click}) return label;
  button?.click();
  return { label, shown: app.callStage.studio.isCommentShown(id) };
`;

const titleIs = (endpoint, title) => `
  const person = app.callStage.personOf(${quote(endpoint)});
  return person?.title === ${quote(title)};
`;

test(
  'Studio produces live chat overlays and one program-only clip',
  {
    timeout: 240000,
  },
  async (t) => {
    const quiet = {
      joinMicOff: true,
      joinCameraOff: true,
      recordingQuality: '720p30',
    };
    const host = await setup(t, quiet);
    await join(host);
    const token = await host.run('return app.callToken;');
    const guest = await host.openPerson('river', {
      ...quiet,
      title: 'Producer',
    });
    await join(guest, token);
    const endpoint = await guest.run('return app.callStage.session.endpoint;');
    await host.wait(titleIs(endpoint, 'Producer'));
    const comment =
      '<b>A plain comment</b> with **bold**\nSecond line\nThird line\n' +
      'Fourth\n' +
      'A sentence beyond the limit. '.repeat(14);
    const id = await guest.run(`return app.writeMessage('general',
    ${quote(comment)}, '', []);`);
    assert.equal(await guest.run(menuOf(id)), '');
    await guest.run('app.closeMenu();');
    const empty = await guest.run(
      `return app.writeMessage('general', '', '', []);`,
    );
    await host.request('Page.bringToFront');
    await host.wait(`app.render(); return document.querySelector(
    '.message[data-id="' + ${quote(id)} + '"]');`);
    assert.equal(await host.run(menuOf(id)), '');
    await host.run('app.closeMenu();');
    await openStudio(host);
    await host.wait(chosen('live'));
    await change(host, field('accent'), '#e617b7');
    await change(host, field('brandText'), '#94fb2f');
    await change(host, field('chip'), '#37195d');
    await change(host, field('chipStyle'), 'bar');
    await change(host, field('font'), 'system-ui');
    await change(host, field('transition'), 'cut');
    await edit(host, 'live', {
      audio: 'custom',
      screen: 'screen',
      names: false,
    });
    await edit(host, 'ending', {
      type: 'live',
      ticker: true,
      lowerThird: true,
      comment: true,
    });
    await change(host, field('enabled'), true);
    await host.wait('return app.callStage.studio.enabled;');
    await host.run(overlayProbe);

    await click(host, action('add-banner'));
    await change(host, field('bannerText'), 'Temporary banner');
    await click(host, action('save-banner'));
    await host.wait(`
      return document.querySelector('${action('edit-banner')}');
    `);
    const bannerId = await host.run(`return document.querySelector(
    '${action('edit-banner')}').dataset.id;`);
    await click(host, action('edit-banner', bannerId));
    await change(host, field('bannerText'), 'Studio banner');
    await click(host, action('save-banner'));
    await host.wait(`return document.querySelector('[data-studio-list=banners]')
    .textContent.includes('Studio banner');`);
    await click(host, action('show-banner', bannerId));
    await click(host, action('lower-third', endpoint));
    await change(host, field('tickerText'), 'This ticker keeps rolling');
    assert.deepEqual(await host.run(menuOf(id, true)), {
      label: 'Show on screen',
      shown: true,
    });
    assert.equal(await host.run(menuOf(id)), 'Hide from screen');
    await host.run('app.closeMenu();');
    await host.wait(`app.render(); return document.querySelector(
    '.message[data-id="' + ${quote(empty)} + '"]');`);
    assert.equal(await host.run(menuOf(empty)), '');
    await host.run('app.closeMenu();');

    await host
      .wait(
        `
      const cards = window.studioCards();
      return Object.keys(cards).length === 4 && Object.values(cards)
        .every(({ alpha, letters }) => alpha === 1 && letters >= 5);
    `,
      )
      .catch(async (error) => {
        const snapshot = await host.run(`
        const { compositor } = app.callStage.recording;
        return {
          cards: window.studioCards(),
          error: compositor.error?.stack,
          scene: app.callStage.studio.activeScene.overlays,
        };
      `);
        t.diagnostic(quote(snapshot));
        throw error;
      });
    const cards = await host.run('return window.studioCards();');
    assert.equal(cards.banner.text, 'Studio banner');
    assert.equal(cards.ticker.text, 'This ticker keeps rolling');
    assert.equal(cards.lowerThird.nick, 'river');
    assert.equal(cards.lowerThird.text, 'Producer');
    assert.equal(cards.comment.nick, 'river');
    assert.equal(cards.comment.text.length, 280);
    const start = '<b>A plain comment</b> with bold\nSecond line';
    assert.ok(cards.comment.text.startsWith(start));
    for (const card of Object.values(cards)) {
      assert.deepEqual(card.accent, [230, 23, 183]);
      assert.deepEqual(card.chip, [55, 25, 93]);
      assert.ok(card.letters >= 5);
    }

    await click(host, action('switch-scene', 'ending'));
    await host.wait(`
    const { compositor } = app.callStage.recording;
    return compositor.overlays.length === 3 &&
      !compositor.overlays.some(({ kind }) => kind === 'banner');
  `);
    const { x, y, height } = cards.banner.rect;
    assert.notDeepEqual(
      await host.run(`
    const { canvas } = app.callStage.recording.compositor;
    return window.studioPixel(canvas, ${x + 2}, ${y + height / 2});
  `),
      [230, 23, 183],
    );
    await click(host, action('switch-scene', 'live'));
    await host.wait('return window.studioCards().banner?.letters > 5;');

    await guest.run(`app.openSettings('profile');`);
    assert.equal(
      await guest.run(`return document.querySelector(
    '[data-setting=title]').maxLength;`),
      48,
    );
    await change(guest, '[data-setting=title]', 'Guest title has changed');
    await host.wait(titleIs(endpoint, 'Guest title has changed'));
    await host.wait(`return app.callStage.recording.compositor.overlays
    .some(({ kind, text }) =>
      kind === 'lowerThird' && text === 'Guest title has changed');`);
    await guest.run('await app.callStage.setOptOut(true);');
    await host.wait(`return !app.callStage.recording.compositor.overlays
    .some(({ kind }) => kind === 'lowerThird');`);
    await guest.run('await app.callStage.setOptOut(false);');
    await host.wait('return window.studioCards().lowerThird?.letters > 5;');
    assert.deepEqual(await host.run(menuOf(id, true)), {
      label: 'Hide from screen',
      shown: false,
    });
    await host.wait('return !window.studioCards().comment;');

    await host.request('Emulation.setEmulatedMedia', {
      features: [{ name: 'prefers-reduced-motion', value: 'reduce' }],
    });
    await click(host, action('show-banner', bannerId));
    assert.equal(
      await host.run(`
    const { compositor } = app.callStage.recording;
    compositor.draw();
    return compositor.overlays.some(({ kind }) => kind === 'banner');
  `),
      false,
    );
    await click(host, action('show-banner', bannerId));

    await upload(host, videoFile);
    await host.wait(`return document.querySelector('${action('play-tile')}');`);
    const asset = await host.run(`return document.querySelector(
    '${action('play-tile')}').dataset.id;`);
    const clipId = 'clip/' + asset;
    await host.run(mediaProbe);
    await click(host, action('play-tile', asset));
    await host.wait(`const clip = app.callStage.studio.clip;
    return clip?.media.currentTime > 0.25 && clip.media.muted &&
      window.clipPixel() && app.callStage.recording.compositor.tiles.some(
        ({ id, label }) => id === ${quote(clipId)} && label === 'Clip.webm'
      );`);
    await click(host, RECORD);
    await host.wait(`
    const { recording, studio } = app.callStage;
    const media = window.studioAudio[0];
    return recording.isActive && media === studio.clip?.media &&
      !media.muted && !media.isConnected &&
      recording.mixer.gains.get(${quote(clipId)}) === 1 &&
      media.currentTime > 0.4 && window.musicLevel() > 0.025;
  `);
    const before = await host.run(`
    window.firstRouted = app.callStage.studio.clip.media;
    return window.firstRouted.currentTime;
  `);
    await click(host, RECORD);
    await host.wait(`const { recording, studio } = app.callStage;
    const media = studio.clip?.media;
    return !recording.isActive && media?.muted &&
      media.currentTime >= ${before} && window.firstRouted.paused &&
      !window.firstRouted.hasAttribute('src');`);
    await click(host, RECORD);
    await host.wait(`const { recording, studio } = app.callStage;
    const media = window.studioAudio[1];
    return recording.isActive && media === studio.clip?.media &&
      media?.currentTime >= ${before} && window.musicLevel() > 0.025;`);
    const rms = await host.run('return window.musicLevel();');
    t.diagnostic(`clip mix RMS ${rms.toFixed(3)} after mixer recreation`);

    await click(host, action('play-full', asset));
    await host.wait(`const { studio, recording } = app.callStage;
    return studio.clip?.mode === 'full' && window.clipPixel() &&
      !recording.compositor.tiles.some(({ id }) => id === ${quote(clipId)}) &&
      window.studioAudio[1].paused &&
      recording.compositor.overlays.some(({ kind }) => kind === 'ticker');
  `);
    await click(host, action('stop-clip', asset));
    await host.wait(`const { recording, studio } = app.callStage;
    return !studio.clip && window.studioAudio[2].paused &&
      !recording.mixer.gains.has(${quote(clipId)}) &&
      window.musicLevel() < 0.003;
  `);
    await click(host, action('play-full', asset));
    await host.wait('return window.musicLevel() > 0.025;');
    await change(host, field('enabled'), false);
    await host.wait(`const { studio, recording } = app.callStage;
    return !studio.enabled && !studio.clip && window.studioAudio[3].paused &&
      !recording.mixer.gains.has(${quote(clipId)}) &&
      window.musicLevel() < 0.003;
  `);
    await click(host, RECORD);
    await host.wait('return !app.callStage.recording.isActive;');
    await change(host, field('enabled'), true);
    await click(host, action('play-tile', asset));
    await host.wait(
      'return app.callStage.studio.clip?.media.currentTime > 0.3;',
    );
    await host.wait(`return !app.callStage.studio.clip &&
    !app.callStage.recording.compositor.tiles.some(
      ({ id }) => id === ${quote(clipId)}
    );`);

    const saved = await host.run(`
    const root = await navigator.storage.getDirectory();
    const dir = await root.getDirectoryHandle('studio');
    const file = await (await dir.getFileHandle('texts.json')).getFile();
    return JSON.parse(await file.text());
  `);
    assert.deepEqual(saved, {
      banners: [{ id: bannerId, text: 'Studio banner' }],
      ticker: 'This ticker keeps rolling',
    });
    await click(host, action('delete-banner', bannerId));
    await host.wait(`
      return !document.querySelector('${action('show-banner')}') &&
        !window.studioCards().banner;
    `);
    const other = await host.run(`
      app.chatNameInput.value = 'another chat';
      app.addChannel('chat', app.chatNameInput);
      return app.writeMessage(app.chat, 'Other call chat', '', []);
    `);
    assert.equal(await host.run(menuOf(other)), '');
  },
);
