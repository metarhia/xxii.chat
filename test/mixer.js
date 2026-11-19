'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { setTimeout: delay } = require('node:timers/promises');

const harness = require('./harness.js');

const { MEDIA_FLAGS, ORIGIN, launch, startCallServer } = harness;

const SETTLE_MS = 1200;
const PRESENT = -60;
const ABSENT = -90;
const DUCK_DB = -18.06;

const openPage = async (browser) => {
  const target = { url: 'about:blank' };
  const { targetId } = await browser.request('Target.createTarget', target);
  const attach = { targetId, flatten: true };
  const attached = await browser.request('Target.attachToTarget', attach);
  const { sessionId } = attached;
  await browser.request('Runtime.enable', {}, sessionId);
  await browser.request('Page.enable', {}, sessionId);
  await browser.request('Page.navigate', { url: `${ORIGIN}/` }, sessionId);
  for (let attempt = 0; attempt < 150; attempt++) {
    const state = await browser
      .evaluate(sessionId, 'document.readyState + location.href')
      .catch(() => '');
    if (state.startsWith('complete') && state.includes(ORIGIN)) break;
    await delay(100);
  }
  await browser.request('Page.bringToFront', {}, sessionId);
  return sessionId;
};

const SETUP = `
  const { Mixer } = await import('/mixer.js');
  const source = new AudioContext({ sampleRate: 48000 });
  const tone = (frequency) => {
    const oscillator = source.createOscillator();
    oscillator.frequency.value = frequency;
    const gain = source.createGain();
    gain.gain.value = 0.05;
    const destination = source.createMediaStreamDestination();
    oscillator.connect(gain);
    gain.connect(destination);
    oscillator.start();
    return destination.stream.getAudioTracks()[0];
  };
  window.FREQUENCIES = {
    ada: 978.515625,
    bob: 1775.390625,
    kim: 2167.96875,
    share: 2384.765625,
  };
  window.tones = {};
  for (const name of Object.keys(window.FREQUENCIES)) {
    window.tones[name] = tone(window.FREQUENCIES[name]);
  }
  window.person = (name, extra) => ({
    endpoint: name + ':1',
    nick: name,
    local: false,
    optOut: false,
    camera: null,
    screen: null,
    mic: window.tones[name],
    screenAudio: null,
    level: 0,
    speaking: false,
    ...extra,
  });
  window.list = [window.person('ada'), window.person('bob')];
  window.mix = {};
  window.shown = new Set();
  window.mixer = new Mixer({
    members: () => window.list,
    options: () => window.mix,
    onScreen: () => window.shown,
  });
  window.mixer.start();
  const probe = new AudioContext({ sampleRate: 48000 });
  const analyser = probe.createAnalyser();
  analyser.fftSize = 8192;
  analyser.smoothingTimeConstant = 0;
  const stream = new MediaStream([window.mixer.track]);
  probe.createMediaStreamSource(stream).connect(analyser);
  await Promise.all([source.resume(), probe.resume()]);
  window.levels = () => {
    const data = new Float32Array(analyser.frequencyBinCount);
    analyser.getFloatFrequencyData(data);
    const width = probe.sampleRate / analyser.fftSize;
    const result = {};
    for (const name of Object.keys(window.FREQUENCIES)) {
      const bin = Math.round(window.FREQUENCIES[name] / width);
      const peak = Math.max(...Array.from(data.slice(bin - 3, bin + 4)));
      result[name] = Number.isFinite(peak) ? peak : -1000;
    }
    return result;
  };
  window.gains = () => Object.fromEntries(window.mixer.gains);
  return true;`;

test(
  'mixer carries each source and follows the audio rules',
  { timeout: 120000 },
  async (t) => {
    await startCallServer(t);
    const browser = await launch(t, MEDIA_FLAGS);
    const session = await openPage(browser);
    const run = (body) => harness.run(browser, session, body);
    await harness.wait(browser, session, 'return true;');
    await run(SETUP);

    const measure = async (change) => {
      if (change) await run(change);
      await delay(SETTLE_MS);
      return run('return { levels: window.levels(), gains: window.gains() };');
    };
    const all = await measure('');
    assert.ok(all.levels.ada > PRESENT, `ada ${all.levels.ada}`);
    assert.ok(all.levels.bob > PRESENT, `bob ${all.levels.bob}`);
    assert.ok(all.levels.kim < ABSENT, `kim ${all.levels.kim}`);
    assert.deepEqual(all.gains, { 'ada:1/mic': 1, 'bob:1/mic': 1 });
    assert.equal(await run('return window.mixer.context.sampleRate;'), 48000);
    assert.equal(await run('return window.mixer.context.state;'), 'running');
    assert.equal(await run('return window.mixer.error === null;'), true);

    const joined = await measure(
      'window.list.push(window.person("kim")); return true;',
    );
    assert.ok(joined.levels.kim > PRESENT, `joined kim ${joined.levels.kim}`);
    assert.equal(joined.gains['kim:1/mic'], 1);
    const left = await measure('window.list.pop(); return true;');
    assert.ok(left.levels.kim < ABSENT, `left kim ${left.levels.kim}`);
    assert.equal('kim:1/mic' in left.gains, false);

    const out = await measure('window.list[1].optOut = true; return true;');
    assert.equal(out.gains['bob:1/mic'], 0);
    assert.ok(out.levels.bob < ABSENT, `opted-out bob ${out.levels.bob}`);
    const kept = out.levels.ada - all.levels.ada;
    assert.ok(Math.abs(kept) < 1, `ada changed by ${kept} dB`);
    const back = await measure('window.list[1].optOut = false; return true;');
    assert.equal(back.gains['bob:1/mic'], 1);
    assert.ok(back.levels.bob > PRESENT, `opted back in ${back.levels.bob}`);

    const shown = 'window.shown = new Set(["ada:1/camera"]);';
    const onScreen = await measure(
      `${shown} window.mix = { audio: 'onScreen' }; return true;`,
    );
    assert.ok(
      onScreen.levels.ada > PRESENT,
      `on screen ${onScreen.levels.ada}`,
    );
    assert.ok(
      onScreen.levels.bob < ABSENT,
      `off screen ${onScreen.levels.bob}`,
    );
    assert.equal(onScreen.gains['bob:1/mic'], 0);

    const duck = await measure(`window.mix = { audio: 'duck' }; return true;`);
    const drop = duck.levels.bob - duck.levels.ada;
    assert.ok(Math.abs(drop - DUCK_DB) < 2, `ducked by ${drop} dB`);
    assert.equal(duck.gains['bob:1/mic'], 0.125);

    const custom = await measure(
      `window.mix = { audio: 'custom', volumes: { 'ada:1': 0.5, 'bob:1': 0 } };
      return true;`,
    );
    const half = custom.levels.ada - all.levels.ada;
    assert.ok(Math.abs(half + 6.02) < 1, `half volume ${half} dB`);
    assert.ok(custom.levels.bob < ABSENT, `muted bob ${custom.levels.bob}`);
    assert.equal(custom.gains['ada:1/mic'], 0.5);

    const me = await measure(
      `window.list[0].local = true;
      window.mix = { includeMe: false };
      return true;`,
    );
    assert.ok(me.levels.ada < ABSENT, `own voice ${me.levels.ada}`);
    assert.ok(me.levels.bob > PRESENT, `other voice ${me.levels.bob}`);
    assert.equal(me.gains['ada:1/mic'], 0);

    const share = await measure(
      `window.list[0].local = false;
      window.list[1].screen = window.tones.share;
      window.list[1].screenAudio = window.tones.share;
      window.shown = new Set(['bob:1/screen']);
      window.mix = { audio: 'onScreen' };
      return true;`,
    );
    assert.ok(share.levels.share > PRESENT, `screen ${share.levels.share}`);
    assert.ok(share.levels.bob < ABSENT, `bob under share ${share.levels.bob}`);
    assert.equal(share.gains['bob:1/screenAudio'], 1);
    const hiddenShare = await measure('window.shown = new Set(); return true;');
    const hiddenLevel = hiddenShare.levels.share;
    assert.ok(hiddenLevel < ABSENT, `hidden share ${hiddenLevel}`);
    const noScreenAudio = await measure(
      `window.shown = new Set(['bob:1/screen']);
      window.mix = { audio: 'all', screenAudio: false };
      return true;`,
    );
    const noShare = noScreenAudio.levels.share;
    assert.ok(noShare < ABSENT, `screen audio off ${noShare}`);
    assert.equal(noScreenAudio.gains['bob:1/screenAudio'], 0);
    const bobLevel = noScreenAudio.levels.bob;
    assert.ok(bobLevel > PRESENT, `bob with screen audio off ${bobLevel}`);

    const swapped = await measure(
      `window.mix = {};
      window.list[0].mic = window.tones.kim;
      return true;`,
    );
    assert.ok(swapped.levels.kim > PRESENT, `swapped ${swapped.levels.kim}`);
    assert.ok(swapped.levels.ada < ABSENT, `old track ${swapped.levels.ada}`);

    const stopped = await run(
      `window.mixer.stop();
      window.mixer.stop();
      await new Promise((resolve) => setTimeout(resolve, 200));
      const live = Object.values(window.tones)
        .every((track) => track.readyState === 'live');
      return {
        track: window.mixer.track.readyState,
        context: window.mixer.context.state,
        live,
        gains: window.gains(),
      };`,
    );
    assert.deepEqual(stopped, {
      track: 'ended',
      context: 'closed',
      live: true,
      gains: {},
    });
    assert.deepEqual(browser.errors, []);
  },
);
