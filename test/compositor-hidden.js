'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { setTimeout: delay } = require('node:timers/promises');

const harness = require('./harness.js');

const { MEDIA_FLAGS, ORIGIN, launch, startCallServer } = harness;

const MIN_FPS = 24;
const MEASURE_STEPS = 6;
const STEP_MS = 1000;
const VOICE = 0.05;
const SILENCE = 0.0005;

const openPerson = async (t, browser) => {
  const created = await browser.request('Target.createBrowserContext');
  const { browserContextId } = created;
  t.after(() =>
    browser
      .request('Target.disposeBrowserContext', { browserContextId })
      .catch(() => undefined),
  );
  const url = `${ORIGIN}/`;
  const params = { url, browserContextId };
  const { targetId } = await browser.request('Target.createTarget', params);
  const attach = { targetId, flatten: true };
  const target = await browser.request('Target.attachToTarget', attach);
  const { sessionId } = target;
  await browser.request('Runtime.enable', {}, sessionId);
  await browser.request('Page.enable', {}, sessionId);
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    const state = await browser
      .evaluate(sessionId, 'document.readyState')
      .catch(() => '');
    if (state === 'complete') break;
    await delay(50);
  }
  const ready =
    'return app.connected === true && app.mesh.peers.has(app.peerId);';
  await harness.wait(browser, sessionId, ready);
  return { sessionId, browserContextId };
};

const coverTab = async (browser, person) => {
  const { browserContextId } = person;
  const params = { url: 'about:blank', browserContextId };
  const { targetId } = await browser.request('Target.createTarget', params);
  const attach = { targetId, flatten: true };
  const target = await browser.request('Target.attachToTarget', attach);
  await browser.request('Page.bringToFront', {}, target.sessionId);
};

const waitFor = async (browser, session, body) => {
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    await browser.request('Page.bringToFront', {}, session);
    const result = await harness.run(browser, session, body).catch(() => false);
    if (result) return;
    await delay(100);
  }
  const detail = await harness.run(browser, session, body);
  throw new Error(`Condition failed: ${JSON.stringify(detail)}`);
};

const startCall = async (t, browser) => {
  const run = (session, body) => harness.run(browser, session, body);
  const first = await openPerson(t, browser);
  const second = await openPerson(t, browser);
  const left = first.sessionId;
  const right = second.sessionId;
  await run(
    left,
    `app.selectChat('general');
    await app.startCall('general');
    return true;`,
  );
  const token = await run(left, 'return app.callToken;');
  await run(
    right,
    `app.selectChat('general');
    await app.startCall('general', { token: ${JSON.stringify(token)} });
    return true;`,
  );
  const join = `document.querySelector('#prejoin [data-action=join]')
    .click(); return true;`;
  await run(left, join);
  await run(right, join);
  const linked = 'return app.callSession?.linkCount === 1;';
  await waitFor(browser, left, linked);
  await waitFor(browser, right, linked);
  return { left, right, first };
};

const PROGRAM = `
  const { Compositor } = await import('/compositor.js');
  const { Mixer } = await import('/mixer.js');
  const { membersOf } = await import('/members.js');
  const stage = app.callStage;
  const local = app.callSession.endpoint;
  const remote = stage.people.find((person) => person.endpoint !== local);
  window.ids = {
    local,
    remote: remote.endpoint,
    localTile: local + '/camera',
    remoteTile: remote.endpoint + '/camera',
    remoteMic: remote.endpoint + '/mic',
    localMic: local + '/mic',
  };
  window.optOut = new Set();
  window.options = { quality: '720p30' };
  window.mixOptions = { includeMe: false };
  window.members = () => {
    const people = stage.people.map((person) => ({
      ...person,
      optOut: window.optOut.has(person.endpoint),
    }));
    return membersOf({
      endpoint: local,
      people,
      remote: stage.remote,
      media: stage.media,
      speech: stage.levels.state.participants,
    });
  };
  const members = window.members;
  const options = () => window.options;
  window.compositor = new Compositor({ members, options });
  window.compositor.start();
  window.mixer = new Mixer({
    members,
    options: () => window.mixOptions,
    onScreen: () => window.compositor.onScreen,
  });
  window.mixer.start();
  const processor = new MediaStreamTrackProcessor({
    track: window.compositor.track,
  });
  const reader = processor.readable.getReader();
  window.read = 0;
  const pump = async () => {
    const result = await reader.read();
    if (result.done) return;
    result.value.close();
    window.read++;
    pump();
  };
  pump();
  window.hashTile = (id) => {
    const tile = window.compositor.tiles.find((item) => item.id === id);
    if (!tile) return -1;
    const canvas = window.compositor.canvas;
    const context = canvas.getContext('2d');
    const x = Math.round(tile.x + tile.width * 0.2);
    const y = Math.round(tile.y + tile.height * 0.2);
    const width = Math.round(tile.width * 0.6);
    const height = Math.round(tile.height * 0.6);
    const data = context.getImageData(x, y, width, height).data;
    let sum = 0;
    for (let i = 0; i < data.length; i += 37) sum = (sum + data[i]) | 0;
    return sum;
  };
  window.sampleProgram = () => ({
    time: performance.now(),
    drawn: window.compositor.frames,
    read: window.read,
    local: window.hashTile(window.ids.localTile),
    remote: window.hashTile(window.ids.remoteTile),
    error: window.compositor.error ? String(window.compositor.error) : '',
  });
  return true;`;

const METER = `
  const code = \`class Peak extends AudioWorkletProcessor {
    constructor() {
      super();
      this.peak = 0;
      this.port.onmessage = () => {
        this.port.postMessage(this.peak);
        this.peak = 0;
      };
    }
    process(inputs) {
      const input = inputs[0][0];
      if (!input) return true;
      for (let i = 0; i < input.length; i++) {
        const value = Math.abs(input[i]);
        if (value > this.peak) this.peak = value;
      }
      return true;
    }
  }
  registerProcessor('peak', Peak);\`;
  const context = new AudioContext();
  const blob = new Blob([code], { type: 'text/javascript' });
  await context.audioWorklet.addModule(URL.createObjectURL(blob));
  const node = new AudioWorkletNode(context, 'peak', { numberOfOutputs: 0 });
  const stream = new MediaStream([window.mixer.track]);
  context.createMediaStreamSource(stream).connect(node);
  await context.resume();
  window.peak = () =>
    new Promise((resolve) => {
      node.port.onmessage = ({ data }) => resolve(data);
      node.port.postMessage(0);
    });
  return true;`;

const distinct = (values) => new Set(values).size;

const peakOf = (browser, session) =>
  harness.run(browser, session, 'return await window.peak();');

const settle = async (browser, session) => {
  await delay(400);
  await peakOf(browser, session);
};

const loudest = async (browser, session, durationMs) => {
  const deadline = Date.now() + durationMs;
  let peak = 0;
  while (Date.now() < deadline) {
    await delay(100);
    peak = Math.max(peak, await peakOf(browser, session));
  }
  return peak;
};

const hears = async (browser, session, durationMs) => {
  const deadline = Date.now() + durationMs;
  let peak = 0;
  while (Date.now() < deadline && peak <= VOICE) {
    await delay(100);
    peak = Math.max(peak, await peakOf(browser, session));
  }
  return peak;
};

test(
  'scenario 14: the program keeps drawing and mixing in a hidden tab',
  { timeout: 240000 },
  async (t) => {
    await startCallServer(t);
    const flags = MEDIA_FLAGS.concat([
      '--disable-features=WebRtcHideLocalIpsWithMdns',
    ]);
    const browser = await launch(t, flags);
    const call = await startCall(t, browser);
    const session = call.left;
    const run = (body) => harness.run(browser, session, body);
    await run(PROGRAM);
    await run(METER);
    const shown = `const tiles = window.compositor.tiles;
      const isVideo = (tile) => tile.placeholder === '';
      return tiles.length === 2 && tiles.every(isVideo);`;
    await harness.wait(browser, session, shown);
    await coverTab(browser, call.first);
    await delay(1500);
    assert.equal(await run('return document.hidden;'), true);
    await run(
      `app.callSession.setViewHint(window.ids.remote, {
        slot: 'camera', width: 1280, height: 720, fps: 30,
      });
      return true;`,
    );
    await delay(1500);

    const samples = new Array(MEASURE_STEPS + 1).fill(null);
    for (let step = 0; step <= MEASURE_STEPS; step++) {
      samples[step] = await run('return window.sampleProgram();');
      await delay(STEP_MS);
    }
    const first = samples[0];
    const last = samples[samples.length - 1];
    const seconds = (last.time - first.time) / 1000;
    const drawnFps = (last.drawn - first.drawn) / seconds;
    const readFps = (last.read - first.read) / seconds;
    assert.ok(seconds >= 5, `measured ${seconds} s`);
    assert.ok(drawnFps >= MIN_FPS, `drawn ${drawnFps} fps in a hidden tab`);
    assert.ok(readFps >= MIN_FPS, `read ${readFps} fps in a hidden tab`);
    t.diagnostic(
      `hidden tab, ${seconds.toFixed(1)} s: ${drawnFps.toFixed(1)} fps ` +
        `drawn, ${readFps.toFixed(1)} fps read`,
    );
    assert.ok(distinct(samples.map((item) => item.remote)) >= 3);
    assert.ok(distinct(samples.map((item) => item.local)) >= 3);
    assert.equal(samples.filter((item) => item.error).length, 0);
    const tiles = await run(
      `return window.compositor.tiles.map((tile) =>
        [tile.id, tile.placeholder]);`,
    );
    assert.deepEqual(
      tiles.toSorted(),
      [
        [await run('return window.ids.localTile;'), ''],
        [await run('return window.ids.remoteTile;'), ''],
      ].toSorted(),
    );

    const heard = await hears(browser, session, 8000);
    assert.ok(heard > VOICE, `remote voice peak ${heard}`);
    const gains = await run(
      `const gains = window.mixer.gains;
      return [gains.get(window.ids.remoteMic),
        gains.get(window.ids.localMic)];`,
    );
    assert.deepEqual(gains, [1, 0]);
    assert.equal(await run('return window.mixer.context.state;'), 'running');

    await run('window.optOut.add(window.ids.remote); return true;');
    await harness.wait(
      browser,
      session,
      `const tile = window.compositor.tiles.find(
        (item) => item.id === window.ids.remoteTile);
      return tile?.placeholder === 'opted out' &&
        window.mixer.gains.get(window.ids.remoteMic) === 0;`,
      2000,
    );
    await settle(browser, session);
    const muted = await loudest(browser, session, 3000);
    assert.ok(muted < SILENCE, `opted-out voice peak ${muted}`);
    const frozen = new Array(4).fill(0);
    for (let i = 0; i < frozen.length; i++) {
      frozen[i] = await run('return window.sampleProgram().remote;');
      await delay(300);
    }
    assert.equal(distinct(frozen), 1);

    await run('window.optOut.clear(); return true;');
    await harness.wait(
      browser,
      session,
      `const tile = window.compositor.tiles.find(
        (item) => item.id === window.ids.remoteTile);
      return tile?.placeholder === '' &&
        window.mixer.gains.get(window.ids.remoteMic) === 1;`,
      2000,
    );
    const back = await hears(browser, session, 8000);
    assert.ok(back > VOICE, `voice peak after opting back in ${back}`);

    const stopped = await run(
      `const media = app.callStage.media;
      const remote = app.callStage.remote.get(window.ids.remote);
      window.compositor.stop();
      window.mixer.stop();
      window.compositor.stop();
      window.mixer.stop();
      const frames = window.compositor.frames;
      await new Promise((resolve) => setTimeout(resolve, 500));
      return {
        frames: window.compositor.frames - frames,
        video: window.compositor.track.readyState,
        audio: window.mixer.track.readyState,
        context: window.mixer.context.state,
        camera: media.cameraTrack.readyState,
        mic: media.micTrack.readyState,
        remote: [remote.camera.readyState, remote.mic.readyState],
      };`,
    );
    assert.deepEqual(stopped, {
      frames: 0,
      video: 'ended',
      audio: 'ended',
      context: 'closed',
      camera: 'live',
      mic: 'live',
      remote: ['live', 'live'],
    });
    assert.deepEqual(browser.errors, []);
  },
);
