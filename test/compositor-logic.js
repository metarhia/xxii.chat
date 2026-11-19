'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const loadCompositor = () => import('../application/static/compositor.js');
const loadMixer = () => import('../application/static/mixer.js');
const loadMembers = () => import('../application/static/members.js');
const loadLayout = () => import('../application/static/layout.js');
const loadAvatar = () => import('../application/static/avatar.js');

const BASE = 1763300000000;

const track = (extra) => ({ readyState: 'live', muted: false, ...extra });

const member = (name, extra) => ({
  endpoint: `${name}:1`,
  nick: name,
  local: false,
  optOut: false,
  camera: track(),
  screen: null,
  mic: track(),
  screenAudio: null,
  level: 0,
  speaking: false,
  ...extra,
});

const idOf = (name, slot) => `${name}:1/${slot}`;

const noSpeech = new Map();

test('members carry live tracks, speech, and opt-out', async () => {
  const { membersOf } = await loadMembers();
  const ended = track({ readyState: 'ended' });
  const camera = track();
  const mic = track();
  const people = [
    { endpoint: 'me:1', nick: 'me', camera: true, mic: true },
    { endpoint: 'ada:1', nick: 'ada', camera: true, screen: true },
    { endpoint: 'bob:1', nick: '', camera: false, optOut: true },
  ];
  const remote = new Map([
    ['ada:1', { camera, mic, screen: track(), screenAudio: track() }],
    ['bob:1', { camera: track(), mic: ended }],
  ]);
  const media = {
    cameraOn: true,
    cameraTrack: track(),
    micTrack: mic,
    screenTrack: null,
    screenAudioTrack: track(),
  };
  const speech = new Map([['ada:1', { level: 0.4, speaking: true }]]);
  const state = { endpoint: 'me:1', people, remote, media, speech };
  const members = membersOf(state);
  assert.deepEqual(
    members.map((item) => item.endpoint),
    ['me:1', 'ada:1', 'bob:1'],
  );
  const me = members[0];
  const ada = members[1];
  const bob = members[2];
  assert.equal(me.local, true);
  assert.equal(me.camera, media.cameraTrack);
  assert.equal(me.mic, mic);
  assert.equal(me.screen, null);
  assert.equal(me.screenAudio, null);
  assert.equal(me.nick, 'me');
  assert.equal(ada.camera, camera);
  assert.ok(ada.screen && ada.screenAudio);
  assert.equal(ada.level, 0.4);
  assert.equal(ada.speaking, true);
  assert.equal(bob.camera, null);
  assert.equal(bob.mic, null);
  assert.equal(bob.optOut, true);
  assert.equal(bob.nick, 'guest');
  assert.equal(bob.speaking, false);
  assert.equal(ada.optOut, false);
});

test('members skip muted cameras and ended shares', async () => {
  const { membersOf } = await loadMembers();
  const people = [
    { endpoint: 'ada:1', nick: 'ada', camera: true, screen: false },
    { endpoint: 'bob:1', nick: 'bob', camera: true, screen: true },
  ];
  const remote = new Map([
    ['ada:1', { camera: track({ muted: true }), screenAudio: track() }],
    ['bob:1', { camera: track(), screen: track({ readyState: 'ended' }) }],
  ]);
  remote.get('bob:1').screenAudio = track();
  const state = { endpoint: 'me:1', people, remote, media: null };
  const members = membersOf(state);
  assert.equal(members.length, 3);
  assert.equal(members[0].camera, null);
  assert.equal(members[0].screenAudio, null);
  assert.equal(members[1].screen, null);
  assert.equal(members[1].screenAudio, null);
  assert.equal(members[2].endpoint, 'me:1');
  assert.equal(members[2].nick, 'you');
  assert.equal(members[2].camera, null);
});

test('members use the local nick and add yourself', async () => {
  const { membersOf } = await loadMembers();
  const people = [{ endpoint: 'me:1', nick: 'old' }];
  const named = membersOf({ endpoint: 'me:1', people, nick: 'ada' });
  assert.equal(named[0].nick, 'ada');
  const none = membersOf({ endpoint: '', people: [] });
  assert.deepEqual(none, []);
  assert.deepEqual(membersOf({ endpoint: 'me:1' }).length, 1);
});

test('local screen capture counts even when it is not shared', async () => {
  const { membersOf } = await loadMembers();
  const media = {
    cameraOn: false,
    cameraTrack: track(),
    micTrack: track(),
    screenTrack: track(),
    screenAudioTrack: track(),
    screenShared: false,
  };
  const people = [{ endpoint: 'me:1', nick: 'me', screen: false }];
  const members = membersOf({ endpoint: 'me:1', people, media });
  assert.equal(members[0].camera, null);
  assert.ok(members[0].screen);
  assert.ok(members[0].screenAudio);
});

test('speech starts, continues, and ends with the speaking state', async () => {
  const { speechOf } = await loadCompositor();
  const quiet = speechOf(undefined, false, BASE);
  assert.deepEqual(quiet, { spokeAt: 0, speakingSince: 0 });
  const first = speechOf(quiet, true, BASE + 100);
  assert.deepEqual(first, { spokeAt: BASE + 100, speakingSince: BASE + 100 });
  const next = speechOf(first, true, BASE + 900);
  assert.deepEqual(next, { spokeAt: BASE + 900, speakingSince: BASE + 100 });
  const stopped = speechOf(next, false, BASE + 1000);
  assert.deepEqual(stopped, { spokeAt: BASE + 900, speakingSince: 0 });
  const again = speechOf(stopped, true, BASE + 5000);
  assert.deepEqual(again, { spokeAt: BASE + 5000, speakingSince: BASE + 5000 });
});

test('speech follows the roster and drops people who left', async () => {
  const { nextSpeech } = await loadCompositor();
  const members = [member('ada', { speaking: true }), member('bob')];
  const first = nextSpeech(new Map(), members, BASE);
  assert.equal(first.get('ada:1').speakingSince, BASE);
  assert.equal(first.get('bob:1').spokeAt, 0);
  const second = nextSpeech(first, [members[0]], BASE + 50);
  assert.equal(second.has('bob:1'), false);
  assert.equal(second.get('ada:1').speakingSince, BASE);
  assert.equal(first.get('ada:1').spokeAt, BASE);
});

test('sources hold a camera and a screen per member', async () => {
  const { sourcesOf, nextSpeech } = await loadCompositor();
  const camera = track();
  const screen = track();
  const members = [
    member('ada', { camera, screen, speaking: true, level: 0.3 }),
    member('bob', { camera: null }),
  ];
  const speech = nextSpeech(new Map(), members, BASE);
  const sources = sourcesOf(members, speech, {});
  assert.deepEqual(
    sources.map((source) => source.id),
    [idOf('ada', 'camera'), idOf('ada', 'screen'), idOf('bob', 'camera')],
  );
  const ada = sources[0];
  const share = sources[1];
  const bob = sources[2];
  assert.equal(ada.kind, 'camera');
  assert.equal(ada.hasVideo, true);
  assert.equal(ada.track, camera);
  assert.equal(ada.level, 0.3);
  assert.equal(ada.spokeAt, BASE);
  assert.equal(ada.speakingSince, BASE);
  assert.equal(ada.stage, true);
  assert.equal(share.kind, 'screen');
  assert.equal(share.nick, 'ada · screen');
  assert.equal(share.hasVideo, true);
  assert.equal(share.track, screen);
  assert.equal(share.spokeAt, 0);
  assert.equal(bob.hasVideo, false);
  assert.equal(bob.track, null);
  assert.equal(bob.spokeAt, 0);
});

test('opted-out people give no track and show the placeholder', async () => {
  const { sourcesOf } = await loadCompositor();
  const { layoutProgram } = await loadLayout();
  const members = [
    member('ada', { optOut: true, screen: track() }),
    member('bob'),
  ];
  const sources = sourcesOf(members, noSpeech, {});
  assert.equal(sources[0].track, null);
  assert.equal(sources[0].hasVideo, true);
  assert.equal(sources[1].track, null);
  assert.ok(sources[2].track);
  const tiles = layoutProgram({ people: 'grid', screen: 'off' }, sources, BASE);
  const ada = tiles.find((tile) => tile.id === idOf('ada', 'camera'));
  const bob = tiles.find((tile) => tile.id === idOf('bob', 'camera'));
  assert.equal(ada.placeholder, 'opted out');
  assert.equal(ada.speaking, false);
  assert.equal(bob.placeholder, '');
  const shared = layoutProgram({}, sources, BASE);
  const share = shared.find((tile) => tile.id === idOf('ada', 'screen'));
  assert.equal(share.placeholder, 'opted out');
});

test('include me off keeps your own camera out of the program', async () => {
  const { sourcesOf } = await loadCompositor();
  const { layoutProgram } = await loadLayout();
  const members = [member('me', { local: true }), member('ada')];
  const on = sourcesOf(members, noSpeech, { includeMe: true });
  const off = sourcesOf(members, noSpeech, { includeMe: false });
  const defaults = sourcesOf(members, noSpeech, {});
  assert.equal(on[0].stage, true);
  assert.equal(defaults[0].stage, true);
  assert.equal(off[0].stage, false);
  assert.equal(off[1].stage, true);
  const tiles = layoutProgram({ people: 'grid' }, off, BASE);
  assert.deepEqual(
    tiles.map((tile) => tile.id),
    [idOf('ada', 'camera')],
  );
});

test('speech fields let a long speaker take a seat', async () => {
  const { sourcesOf, nextSpeech } = await loadCompositor();
  const { selectSpeakers } = await loadLayout();
  const people = ['ada', 'bob', 'kim'];
  const options = { people: 'speakers', maxSpeakers: 2, screen: 'off' };
  const build = (speaking, now, speech) => {
    const members = people.map((name) =>
      member(name, { speaking: speaking.includes(name) }),
    );
    const next = nextSpeech(speech, members, now);
    return { next, sources: sourcesOf(members, next, options) };
  };
  let held = [];
  let step = build(['ada', 'bob'], BASE, new Map());
  held = selectSpeakers(step.sources, options, BASE, held);
  assert.deepEqual(held, [idOf('ada', 'camera'), idOf('bob', 'camera')]);
  let speech = step.next;
  for (let time = 100; time <= 7000; time += 100) {
    step = build(['kim'], BASE + time, speech);
    speech = step.next;
    held = selectSpeakers(step.sources, options, BASE + time, held);
  }
  assert.equal(held.length, 2);
  assert.ok(held.includes(idOf('kim', 'camera')));
});

test('tiles move over 250 ms and settle on the layout', async () => {
  const { moveTiles } = await loadCompositor();
  const tile = (x, extra) => ({
    id: 'a',
    x,
    y: 10,
    width: 100,
    height: 50,
    z: 1,
    ...extra,
  });
  const first = moveTiles(new Map(), [tile(0)], 0, true);
  assert.equal(first.drawn[0].x, 0);
  const moved = moveTiles(first.motion, [tile(200)], 1000, true);
  assert.equal(moved.drawn[0].x, 0);
  const middle = moveTiles(moved.motion, [tile(200)], 1125, true);
  assert.ok(middle.drawn[0].x > 100 && middle.drawn[0].x < 200);
  const done = moveTiles(middle.motion, [tile(200)], 1250, true);
  assert.equal(done.drawn[0].x, 200);
  const later = moveTiles(done.motion, [tile(200)], 5000, true);
  assert.equal(later.drawn[0].x, 200);
});

test('a retargeted tile starts from where it is drawn', async () => {
  const { moveTiles } = await loadCompositor();
  const tile = (x) => ({ id: 'a', x, y: 0, width: 10, height: 10, z: 1 });
  let state = moveTiles(new Map(), [tile(0)], 0, true);
  state = moveTiles(state.motion, [tile(100)], 100, true);
  state = moveTiles(state.motion, [tile(100)], 200, true);
  const before = state.drawn[0].x;
  assert.ok(before > 0 && before < 100);
  state = moveTiles(state.motion, [tile(0)], 200, true);
  assert.equal(state.drawn[0].x, before);
  state = moveTiles(state.motion, [tile(0)], 450, true);
  assert.equal(state.drawn[0].x, 0);
});

test('tiles jump with reduced motion, new ones appear', async () => {
  const { moveTiles } = await loadCompositor();
  const tile = (id, x) => ({ id, x, y: 0, width: 10, height: 10, z: 1 });
  let state = moveTiles(new Map(), [tile('a', 0)], 0, false);
  state = moveTiles(state.motion, [tile('a', 300)], 10, false);
  assert.equal(state.drawn[0].x, 300);
  const both = [tile('a', 300), tile('b', 50)];
  state = moveTiles(state.motion, both, 20, true);
  assert.equal(state.drawn[1].x, 50);
  const gone = moveTiles(state.motion, [tile('b', 50)], 30, true);
  assert.equal(gone.motion.has('a'), false);
  assert.equal(gone.drawn.length, 1);
});

test('moving tiles keep the layout order and fields', async () => {
  const { moveTiles } = await loadCompositor();
  const tiles = [
    { id: 'a', x: 1, y: 2, width: 3, height: 4, z: 1, label: 'ada' },
    { id: 'b', x: 5, y: 6, width: 7, height: 8, z: 2, label: 'bob' },
  ];
  const state = moveTiles(new Map(), tiles, 0, true);
  assert.deepEqual(state.drawn, tiles);
  assert.notEqual(state.drawn[0], tiles[0]);
});

test('ellipsize trims text to the width with an ellipsis', async () => {
  const { ellipsize } = await loadCompositor();
  const measure = (text) => text.length * 10;
  assert.equal(ellipsize(measure, 'alex', 100), 'alex');
  assert.equal(ellipsize(measure, 'alexander', 60), 'alexa…');
  assert.equal(ellipsize(measure, 'alexander', 10), '…');
  assert.equal(ellipsize(measure, 'alexander', 5), '');
  assert.equal(ellipsize(measure, 'alex', 0), '');
  assert.equal(ellipsize(measure, '', 10), '');
});

test('on screen lists the featured people and the shares', async () => {
  const { onScreenOf, qualityOf, REFERENCE_HEIGHT } = await loadLayout();
  const camera = (name, extra) => ({
    id: idOf(name, 'camera'),
    endpoint: `${name}:1`,
    kind: 'camera',
    nick: name,
    hasVideo: true,
    level: 0,
    spokeAt: 0,
    speakingSince: 0,
    optOut: false,
    stage: true,
    ...extra,
  });
  const share = camera('ada', {
    id: idOf('ada', 'screen'),
    kind: 'screen',
  });
  const sources = [camera('ada'), camera('bob'), camera('kim'), share];
  const grid = { people: 'grid', screen: 'off', others: 'strip' };
  assert.deepEqual(
    onScreenOf(grid, sources.slice(0, 3), BASE),
    sources.slice(0, 3).map((source) => source.id),
  );
  const one = { people: 'speaker', screen: 'off', others: 'strip' };
  assert.equal(onScreenOf(one, sources.slice(0, 3), BASE).length, 1);
  const screen = { screen: 'screen', others: 'strip' };
  assert.deepEqual(onScreenOf(screen, sources, BASE), [idOf('ada', 'screen')]);
  const hidden = { screen: 'off', people: 'speakers', maxSpeakers: 2 };
  assert.equal(onScreenOf(hidden, sources.slice(0, 3), BASE).length, 2);
  assert.deepEqual(onScreenOf({}, [], BASE), []);
  assert.deepEqual(onScreenOf({ width: 0, height: 0 }, sources, BASE), []);
  assert.equal(qualityOf({ quality: '1080p60' }).fps, 60);
  assert.equal(qualityOf({ quality: 'constructor' }).fps, 30);
  assert.equal(qualityOf().height, REFERENCE_HEIGHT);
});

test('on screen follows the speakers handed to the layout', async () => {
  const { onScreenOf, layoutProgram } = await loadLayout();
  const camera = (name) => ({
    id: idOf(name, 'camera'),
    endpoint: `${name}:1`,
    kind: 'camera',
    nick: name,
    hasVideo: true,
    level: 0,
    spokeAt: 0,
    speakingSince: 0,
    optOut: false,
    stage: true,
  });
  const sources = ['ada', 'bob', 'kim'].map(camera);
  const options = { screen: 'off', people: 'speakers', maxSpeakers: 2 };
  const speakers = [idOf('kim', 'camera'), idOf('bob', 'camera')];
  const ids = onScreenOf(options, sources, BASE, speakers);
  assert.deepEqual(ids.toSorted(), speakers.toSorted());
  const tiles = layoutProgram(options, sources, BASE, speakers);
  assert.deepEqual(tiles.map((tile) => tile.id).toSorted(), ids.toSorted());
});

test('mix options fall back to hearing everyone', async () => {
  const { mixOf, volumeOf } = await loadMixer();
  assert.deepEqual(mixOf(), {
    audio: 'all',
    includeMe: true,
    screenAudio: true,
    volumes: {},
  });
  assert.equal(mixOf({ audio: 'duck' }).audio, 'duck');
  assert.equal(mixOf({ audio: 'loud' }).audio, 'all');
  assert.equal(mixOf({ includeMe: false }).includeMe, false);
  assert.equal(mixOf({ screenAudio: 0 }).screenAudio, true);
  assert.deepEqual(mixOf({ volumes: 'x' }).volumes, {});
  const volumes = { a: 0.5, b: -1, c: 9, d: NaN };
  assert.equal(volumeOf(volumes, 'a'), 0.5);
  assert.equal(volumeOf(volumes, 'b'), 0);
  assert.equal(volumeOf(volumes, 'c'), 2);
  assert.equal(volumeOf(volumes, 'd'), 1);
  assert.equal(volumeOf(volumes, 'missing'), 1);
  assert.equal(volumeOf(volumes, 'constructor'), 1);
});

const entry = (name, extra) => ({
  endpoint: `${name}:1`,
  kind: 'mic',
  local: false,
  optOut: false,
  shownId: idOf(name, 'camera'),
  ...extra,
});

test('gains follow the audio option and who is on screen', async () => {
  const { gainOf, mixOf } = await loadMixer();
  const onScreen = new Set([idOf('ada', 'camera')]);
  const ada = entry('ada');
  const bob = entry('bob');
  const gains = (audio, extra) => {
    const mix = mixOf({ audio, ...extra });
    return [gainOf(ada, mix, onScreen), gainOf(bob, mix, onScreen)];
  };
  assert.deepEqual(gains('all'), [1, 1]);
  assert.deepEqual(gains('onScreen'), [1, 0]);
  assert.deepEqual(gains('duck'), [1, 0.125]);
  const volumes = { 'ada:1': 0.5, 'bob:1': 1.5 };
  assert.deepEqual(gains('custom', { volumes }), [0.5, 1.5]);
  assert.deepEqual(gains('custom'), [1, 1]);
});

test('opted-out sources are silent in every mode', async () => {
  const { gainOf, mixOf } = await loadMixer();
  const onScreen = new Set([idOf('ada', 'camera'), idOf('ada', 'screen')]);
  const mic = entry('ada', { optOut: true });
  const share = entry('ada', {
    kind: 'screenAudio',
    optOut: true,
    shownId: idOf('ada', 'screen'),
  });
  for (const audio of ['all', 'onScreen', 'duck', 'custom']) {
    const mix = mixOf({ audio, volumes: { 'ada:1': 2 } });
    assert.equal(gainOf(mic, mix, onScreen), 0, audio);
    assert.equal(gainOf(share, mix, onScreen), 0, audio);
  }
});

test('include me silences only your own microphone', async () => {
  const { gainOf, mixOf } = await loadMixer();
  const onScreen = new Set([idOf('me', 'camera'), idOf('me', 'screen')]);
  const mix = mixOf({ includeMe: false });
  const mic = entry('me', { local: true });
  const share = entry('me', {
    kind: 'screenAudio',
    local: true,
    shownId: idOf('me', 'screen'),
  });
  const other = entry('ada');
  assert.equal(gainOf(mic, mix, onScreen), 0);
  assert.equal(gainOf(share, mix, onScreen), 1);
  assert.equal(gainOf(other, mix, onScreen), 1);
  assert.equal(gainOf(mic, mixOf({ includeMe: true }), onScreen), 1);
});

test('screen audio is heard with its screen or by the audio rule', async () => {
  const { gainOf, mixOf } = await loadMixer();
  const share = entry('ada', {
    kind: 'screenAudio',
    shownId: idOf('ada', 'screen'),
  });
  const shown = new Set([idOf('ada', 'screen')]);
  const hidden = new Set();
  const cases = [
    ['all', 1, 1],
    ['onScreen', 1, 0],
    ['duck', 1, 0.125],
    ['custom', 1, 1],
  ];
  for (const item of cases) {
    const mix = mixOf({ audio: item[0] });
    assert.equal(gainOf(share, mix, shown), item[1], item[0]);
    assert.equal(gainOf(share, mix, hidden), item[2], item[0]);
  }
  const off = mixOf({ screenAudio: false });
  assert.equal(gainOf(share, off, shown), 0);
  assert.equal(gainOf(share, off, hidden), 0);
  const custom = mixOf({ audio: 'custom', volumes: { 'ada:1': 0.25 } });
  assert.equal(gainOf(share, custom, hidden), 0.25);
});

test('audio sources list microphones and screen audio with gains', async () => {
  const { audioSourcesOf } = await loadMixer();
  const mic = track();
  const audio = track();
  const members = [
    member('ada', { mic, screen: track(), screenAudio: audio }),
    member('bob', { optOut: true }),
    member('kim', { mic: null }),
  ];
  const onScreen = new Set([idOf('ada', 'camera')]);
  const sources = audioSourcesOf(members, { audio: 'onScreen' }, onScreen);
  assert.deepEqual(
    sources.map((source) => source.id),
    [idOf('ada', 'mic'), idOf('ada', 'screenAudio'), idOf('bob', 'mic')],
  );
  assert.equal(sources[0].track, mic);
  assert.equal(sources[0].gain, 1);
  assert.equal(sources[1].track, audio);
  assert.equal(sources[1].gain, 0);
  assert.equal(sources[2].track, null);
  assert.equal(sources[2].gain, 0);
  assert.equal(sources[2].endpoint, 'bob:1');
  const everyone = audioSourcesOf(members, {}, new Set());
  assert.deepEqual(
    everyone.map((source) => source.gain),
    [1, 1, 0],
  );
  assert.deepEqual(audioSourcesOf([], {}, new Set()), []);
});

test('avatars keep their initials and color per person', async () => {
  const { initialsOf, colorOf, peerOf } = await loadAvatar();
  assert.equal(initialsOf('alex'), 'AL');
  assert.equal(initialsOf('alex smith'), 'AS');
  assert.equal(initialsOf('  '), '?');
  assert.equal(initialsOf(null), '?');
  assert.equal(peerOf('peer:dev1'), 'peer');
  assert.equal(peerOf('plain'), 'plain');
  assert.equal(colorOf('peer:dev1'), colorOf('peer:dev2'));
  assert.match(colorOf('peer:dev1'), /^hsl\(\d+ 42% 32%\)$/);
  assert.match(colorOf(''), /^hsl\(\d+ 42% 32%\)$/);
});
