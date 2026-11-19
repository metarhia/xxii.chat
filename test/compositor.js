'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { setTimeout: delay } = require('node:timers/promises');

const harness = require('./harness.js');

const { MEDIA_FLAGS, ORIGIN, launch, startCallServer } = harness;

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
  const { Compositor } = await import('/compositor.js');
  const { colorOf } = await import('/avatar.js');
  window.Compositor = Compositor;
  const paint = (width, height, left, right, top, bottom) => {
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext('2d');
    const render = () => {
      context.fillStyle = left;
      context.fillRect(0, 0, width / 2, height);
      context.fillStyle = right;
      context.fillRect(width / 2, 0, width / 2, height);
    };
    render();
    setInterval(render, 20);
    return canvas.captureStream(30).getVideoTracks()[0];
  };
  window.tracks = {
    ada: paint(640, 360, '#ff0000', '#0000ff'),
    kim: paint(640, 360, '#00ff00', '#00ff00'),
    share: paint(1000, 500, '#ffff00', '#ff00ff'),
  };
  window.person = (name, extra) => ({
    endpoint: name + ':1',
    nick: name,
    local: false,
    optOut: false,
    camera: null,
    screen: null,
    mic: null,
    screenAudio: null,
    level: 0,
    speaking: false,
    ...extra,
  });
  window.list = [
    window.person('ada', { camera: window.tracks.ada }),
    window.person('bob'),
    window.person('kim', { camera: window.tracks.kim, optOut: true }),
  ];
  window.options = { quality: '720p30', people: 'grid', screen: 'off' };
  window.compositor = new Compositor({
    members: () => window.list,
    options: () => window.options,
  });
  window.compositor.start();
  const probe = document.createElement('canvas').getContext('2d');
  window.expected = (color) => {
    probe.fillStyle = color;
    probe.fillRect(0, 0, 1, 1);
    return Array.from(probe.getImageData(0, 0, 1, 1).data.slice(0, 3));
  };
  window.avatarColor = (name) => window.expected(colorOf(name + ':1'));
  window.pixel = (x, y) => {
    const context = window.compositor.canvas.getContext('2d');
    return Array.from(
      context.getImageData(Math.round(x), Math.round(y), 1, 1).data.slice(0, 3),
    );
  };
  window.tile = (name, slot) =>
    window.compositor.tiles.find((item) => item.id === name + ':1/' + slot);
  window.at = (name, slot, fx, fy) => {
    const tile = window.tile(name, slot);
    return window.pixel(tile.x + tile.width * fx, tile.y + tile.height * fy);
  };
  return true;`;

const RED_LEFT = `const c = window.at('ada', 'camera', 0.3, 0.5);
  return c[0] > 200;`;

const near = (actual, expected, tolerance = 12) =>
  actual.every(
    (value, index) => Math.abs(value - expected[index]) <= tolerance,
  );

test(
  'compositor draws video, avatars, placeholders, and the screen',
  { timeout: 120000 },
  async (t) => {
    await startCallServer(t);
    const browser = await launch(t, MEDIA_FLAGS);
    const session = await openPage(browser);
    const run = (body) => harness.run(browser, session, body);
    await harness.wait(browser, session, 'return true;');
    await run(SETUP);
    const RED = [255, 0, 0];
    const BLUE = [0, 0, 255];
    const PANEL = [26, 36, 45];
    const SURFACE = [15, 20, 24];

    await harness.wait(browser, session, RED_LEFT);
    const sizes = await run(
      `const c = window.compositor;
      return { width: c.canvas.width, height: c.canvas.height, fps: c.fps,
        w: c.width, h: c.height, count: c.tiles.length,
        placeholders: c.tiles.map((tile) => tile.placeholder).toSorted(),
        error: String(c.error) };`,
    );
    assert.deepEqual(sizes, {
      width: 1280,
      height: 720,
      fps: 30,
      w: 1280,
      h: 720,
      count: 3,
      placeholders: ['', 'avatar', 'opted out'],
      error: 'null',
    });

    const left = await run(`return window.at('ada', 'camera', 0.3, 0.5);`);
    const right = await run(`return window.at('ada', 'camera', 0.7, 0.5);`);
    assert.ok(near(left, RED), `left ${left}`);
    assert.ok(near(right, BLUE), `right ${right}`);

    const avatar = await run(
      `const tile = window.tile('bob', 'camera');
      const radius = Math.min(tile.width, tile.height) * 0.28;
      return [window.pixel(tile.x + tile.width / 2,
        tile.y + tile.height / 2 + radius * 0.85), window.avatarColor('bob')];`,
    );
    assert.ok(near(avatar[0], avatar[1], 6), `avatar ${avatar}`);
    const panel = await run(`return window.at('bob', 'camera', 0.04, 0.5);`);
    assert.ok(near(panel, PANEL, 4), `panel ${panel}`);

    const optedOut = await run(
      `return [window.at('kim', 'camera', 0.2, 0.2),
        window.at('kim', 'camera', 0.8, 0.8)];`,
    );
    assert.ok(near(optedOut[0], PANEL, 4), `opted out ${optedOut[0]}`);
    assert.ok(near(optedOut[1], PANEL, 4), `opted out ${optedOut[1]}`);
    const background = await run('return window.pixel(2, 2);');
    assert.ok(near(background, SURFACE, 2), `background ${background}`);

    const instant = await run(
      `window.list[0].optOut = true;
      window.compositor.draw();
      const tile = window.tile('ada', 'camera');
      return [tile.placeholder, window.at('ada', 'camera', 0.3, 0.5),
        window.at('ada', 'camera', 0.7, 0.5)];`,
    );
    assert.equal(instant[0], 'opted out');
    assert.ok(near(instant[1], PANEL, 4), `ada left ${instant[1]}`);
    assert.ok(near(instant[2], PANEL, 4), `ada right ${instant[2]}`);
    const returned = await run(
      `window.list[0].optOut = false;
      window.compositor.draw();
      return window.tile('ada', 'camera').placeholder;`,
    );
    assert.equal(returned, '');
    await harness.wait(browser, session, RED_LEFT);

    const joined = await run(
      `window.list.push(window.person('sam'));
      window.compositor.draw();
      const count = window.compositor.tiles.length;
      window.list.pop();
      window.compositor.draw();
      return [count, window.compositor.tiles.length];`,
    );
    assert.deepEqual(joined, [4, 3]);

    await run(
      `window.list[1].screen = window.tracks.share;
      window.options = { ...window.options, screen: 'screen',
        people: 'speaker' };
      return true;`,
    );
    await harness.wait(
      browser,
      session,
      `const tile = window.tile('bob', 'screen');
      if (!tile || tile.fit !== 'contain') return false;
      const c = window.at('bob', 'screen', 0.25, 0.5);
      return c[0] > 200 && c[1] > 200;`,
    );
    const shared = await run(
      `const tile = window.tile('bob', 'screen');
      return {
        ids: window.compositor.tiles.map((item) => item.id),
        left: window.at('bob', 'screen', 0.25, 0.5),
        right: window.at('bob', 'screen', 0.75, 0.5),
        bar: window.pixel(tile.x + tile.width / 2, tile.y + 2),
        label: tile.label,
        shown: Array.from(window.compositor.onScreen),
      };`,
    );
    assert.deepEqual(shared.ids, ['bob:1/screen']);
    assert.ok(near(shared.left, [255, 255, 0]), `screen left ${shared.left}`);
    assert.ok(
      near(shared.right, [255, 0, 255]),
      `screen right ${shared.right}`,
    );
    assert.ok(near(shared.bar, PANEL, 4), `letterbox ${shared.bar}`);
    assert.equal(shared.label, 'bob · screen');
    assert.deepEqual(shared.shown, ['bob:1/screen']);

    const changed = await run(
      `window.options = { ...window.options, background: '#ff00ff',
        quality: '1080p60' };
      window.compositor.draw();
      return { pixel: window.pixel(2, 2), width: window.compositor.canvas.width,
        height: window.compositor.canvas.height };`,
    );
    assert.deepEqual(changed, {
      pixel: [255, 0, 255],
      width: 1280,
      height: 720,
    });

    const sized = await run(
      `const big = new window.Compositor({
        members: () => window.list,
        options: () => ({ quality: '1080p60' }),
      });
      const result = [big.canvas.width, big.canvas.height, big.fps,
        big.track.kind, big.track.readyState];
      big.stop();
      return result.concat([big.track.readyState]);`,
    );
    assert.deepEqual(sized, [1920, 1080, 60, 'video', 'live', 'ended']);

    const stopped = await run(
      `const frames = window.compositor.frames;
      window.compositor.stop();
      window.compositor.stop();
      await new Promise((resolve) => setTimeout(resolve, 300));
      return {
        frames: window.compositor.frames - frames,
        output: window.compositor.track.readyState,
        sources: Object.values(window.tracks)
          .map((track) => track.readyState),
      };`,
    );
    assert.deepEqual(stopped, {
      frames: 0,
      output: 'ended',
      sources: ['live', 'live', 'live'],
    });
    assert.deepEqual(browser.errors, []);
  },
);
