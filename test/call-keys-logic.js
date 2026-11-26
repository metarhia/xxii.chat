'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const load = () => import('../application/static/call-keys.js');

test('shortcuts map to call actions', async () => {
  const keys = await load();
  const of = (event) => keys.shortcutOf(event)?.action ?? '';
  assert.equal(of({ key: 'd', code: 'KeyD', ctrlKey: true }), 'mic');
  assert.equal(of({ key: 'e', code: 'KeyE', metaKey: true }), 'camera');
  const hand = { key: '˙', code: 'KeyH', ctrlKey: true, altKey: true };
  assert.equal(of(hand), 'hand');
  const share = { key: 's', code: 'KeyS', ctrlKey: true, altKey: true };
  assert.equal(of(share), 'share');
  const layout = { key: 'L', code: 'KeyL', ctrlKey: true, altKey: true };
  assert.equal(of(layout), 'layout');
  assert.equal(of({ key: 'f', code: 'KeyF' }), 'fullscreen');
  const record = { key: 'r', code: 'KeyR', ctrlKey: true, altKey: true };
  assert.equal(of(record), 'record');
  assert.equal(of({ key: 'r', code: 'KeyR', ctrlKey: true }), '');
  const help = { key: '/', code: 'Slash', ctrlKey: true };
  assert.equal(of(help), 'shortcuts');
  assert.equal(of({ key: '/', code: 'Slash' }), '');
});

test('shortcuts need the exact modifiers', async () => {
  const keys = await load();
  const of = (event) => keys.shortcutOf(event)?.action ?? '';
  assert.equal(of({ key: 'd', code: 'KeyD' }), '');
  assert.equal(of({ key: 'd', code: 'KeyD', ctrlKey: true, altKey: true }), '');
  assert.equal(of({ key: 'h', code: 'KeyH', ctrlKey: true }), '');
  assert.equal(of({ key: 'f', code: 'KeyF', ctrlKey: true }), '');
  assert.equal(of({ key: 'F', code: 'KeyF', shiftKey: true }), '');
  assert.equal(of({ key: 'x', code: 'KeyX', ctrlKey: true }), '');
});

test('plain shortcuts are only the full screen key', async () => {
  const keys = await load();
  const plain = keys.SHORTCUTS.filter((row) => !row.command && !row.alt);
  assert.deepEqual(
    plain.map((row) => row.action),
    ['fullscreen'],
  );
});

test('space without modifiers is the talk key', async () => {
  const keys = await load();
  assert.equal(keys.isTalkKey({ key: ' ', code: 'Space' }), true);
  const withCtrl = { key: ' ', code: 'Space', ctrlKey: true };
  assert.equal(keys.isTalkKey(withCtrl), false);
  assert.equal(keys.isTalkKey({ key: 'a', code: 'KeyA' }), false);
});

test('push to talk unmutes on press and mutes on release', async () => {
  const keys = await load();
  const pressed = keys.stepTalk(keys.createTalk(), 'down', false);
  assert.equal(pressed.unmute, true);
  assert.equal(pressed.state.held, true);
  const repeat = keys.stepTalk(pressed.state, 'down', true);
  assert.equal(repeat.unmute, false);
  assert.equal(repeat.state.held, true);
  const released = keys.stepTalk(pressed.state, 'up', true);
  assert.equal(released.mute, true);
  assert.equal(released.state.held, false);
});

test('push to talk mutes on blur and ignores an open mic', async () => {
  const keys = await load();
  const held = keys.stepTalk(keys.createTalk(), 'down', false).state;
  const blurred = keys.stepTalk(held, 'blur', true);
  assert.equal(blurred.mute, true);
  assert.equal(blurred.state.held, false);
  const open = keys.stepTalk(keys.createTalk(), 'down', true);
  assert.equal(open.unmute, false);
  assert.equal(open.state.held, false);
  const stray = keys.stepTalk(keys.createTalk(), 'up', true);
  assert.equal(stray.mute, false);
});

test('push to talk leaves a mic the user toggled by hand', async () => {
  const keys = await load();
  const held = keys.stepTalk(keys.createTalk(), 'down', false).state;
  const cancelled = keys.stepTalk(held, 'cancel', true);
  assert.equal(cancelled.mute, false);
  assert.equal(cancelled.state.held, false);
  const after = keys.stepTalk(cancelled.state, 'up', true);
  assert.equal(after.mute, false);
});

test('help lists every shortcut and push to talk', async () => {
  const keys = await load();
  const text = keys.helpOf().map((row) => row.keys);
  assert.equal(text.includes('Ctrl D'), true);
  assert.equal(text.includes('Ctrl Alt R'), true);
  assert.equal(text.includes('Ctrl /'), true);
  assert.equal(text.includes('hold Space'), true);
  assert.equal(text.includes('Esc'), true);
});
