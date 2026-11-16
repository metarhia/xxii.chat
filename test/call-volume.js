'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const load = () => import('../application/static/call-volume.js');
const tick = () => new Promise((resolve) => setImmediate(resolve));
const storage = () => {
  const values = new Map();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
  };
};
const install = (t, value) => {
  const before = Object.getOwnPropertyDescriptor(globalThis, 'AudioContext');
  Object.defineProperty(globalThis, 'AudioContext', {
    configurable: true,
    value,
  });
  t.after(() => {
    if (before) Object.defineProperty(globalThis, 'AudioContext', before);
    else Reflect.deleteProperty(globalThis, 'AudioContext');
  });
};

class AudioContextMock {
  constructor() {
    this.state = 'running';
    this.destination = {};
    this.sources = [];
    this.gains = [];
  }

  createMediaStreamSource(stream) {
    const source = {
      stream,
      connected: null,
      connect(target) {
        this.connected = target;
      },
      disconnect() {
        this.connected = null;
      },
    };
    this.sources.push(source);
    return source;
  }

  createGain() {
    const gain = {
      gain: { value: 1 },
      connected: null,
      connect(target) {
        this.connected = target;
      },
      disconnect() {
        this.connected = null;
      },
    };
    this.gains.push(gain);
    return gain;
  }

  async close() {
    this.state = 'closed';
  }
}

test('volume defaults to 100, clamps inputs, remembers per peer', async () => {
  const { ParticipantVolume, volumeValue } = await load();
  const saved = storage();
  const first = new ParticipantVolume(assert.fail, saved);
  assert.equal(first.get('one'), 100);
  assert.equal(volumeValue('bad'), 100);
  assert.equal(first.set('one', 250), 200);
  assert.equal(first.get('two'), 100);
  const next = new ParticipantVolume(assert.fail, saved);
  assert.equal(next.get('one'), 200);
  assert.equal(next.set('one', -1), 0);
});

test('peer audio tracks share gain 0/1/2', async (t) => {
  install(t, AudioContextMock);
  const { ParticipantVolume } = await load();
  const volume = new ParticipantVolume(assert.fail, storage());
  const mic = { volume: 1, srcObject: {} };
  const screen = { volume: 1, srcObject: {} };
  const otherTab = { volume: 1, srcObject: {} };
  const otherPeer = { volume: 1, srcObject: {} };
  volume.attach(mic, 'one');
  volume.attach(screen, 'one');
  volume.attach(otherTab, 'one');
  volume.attach(otherPeer, 'two');
  volume.set('one', 0);
  assert.equal(mic.volume, 0);
  assert.equal(screen.volume, 0);
  assert.equal(otherTab.volume, 0);
  assert.equal(otherPeer.volume, 1);
  volume.set('one', 200);
  await tick();
  const context = volume.context;
  assert.equal(context.sources.length, 3);
  for (const value of [0, 100, 200]) {
    volume.set('one', value);
    for (const entry of volume.entries.values()) {
      if (entry.peer !== 'one') continue;
      assert.equal(entry.audio.volume, 0);
      assert.equal(entry.gain.gain.value, value / 100);
      assert.equal(entry.source.connected, entry.gain);
      assert.equal(entry.gain.connected, context.destination);
    }
  }
  const entry = volume.entries.get(mic);
  volume.detach(mic);
  assert.equal(entry.source.connected, null);
  assert.equal(entry.gain.connected, null);
  assert.equal(volume.entries.has(mic), false);
  volume.stop();
  assert.equal(context.state, 'closed');
  assert.equal(volume.entries.size, 0);
});

test('missing Web Audio limits boost visibly', async (t) => {
  install(t, undefined);
  const { ParticipantVolume } = await load();
  const notices = [];
  const notice = (text) => notices.push(text);
  const volume = new ParticipantVolume(notice, storage());
  const audio = { volume: 1, srcObject: {} };
  volume.attach(audio, 'one');
  volume.set('one', 200);
  await tick();
  assert.equal(audio.volume, 1);
  assert.match(notices[0], /limited to 100%/);
  volume.set('one', 0);
  assert.equal(audio.volume, 0);
  volume.stop();
});

test('storage errors preserve session choice and show a notice', async () => {
  const { ParticipantVolume } = await load();
  const notices = [];
  const broken = {
    getItem() {
      throw new Error('blocked');
    },
    setItem() {
      throw new Error('quota');
    },
  };
  const volume = new ParticipantVolume((text) => notices.push(text), broken);
  assert.equal(volume.get('one'), 100);
  volume.set('one', 75);
  assert.equal(volume.get('one'), 75);
  assert.equal(notices.length, 2);
});

test('leave cancels pending Web Audio setup', async (t) => {
  install(t, AudioContextMock);
  const { ParticipantVolume } = await load();
  const volume = new ParticipantVolume(assert.fail, storage());
  volume.set('one', 200);
  volume.attach({ volume: 1, srcObject: {} }, 'one');
  const context = volume.context;
  volume.stop();
  await tick();
  assert.equal(context.sources.length, 0);
  assert.equal(context.state, 'closed');
});

test('routing failures preserve native playback', async (t) => {
  const { ParticipantVolume } = await load();
  for (const failing of ['source', 'gain', 'capability']) {
    class FailingContext extends AudioContextMock {
      createMediaStreamSource(stream) {
        const source = super.createMediaStreamSource(stream);
        if (failing === 'source') {
          source.connect = () => {
            throw new Error('source failure');
          };
        }
        if (failing === 'capability') source.connect = undefined;
        return source;
      }

      createGain() {
        const gain = super.createGain();
        if (failing === 'gain') {
          gain.connect = () => {
            throw new Error('destination failure');
          };
        }
        return gain;
      }
    }
    install(t, FailingContext);
    const notices = [];
    const notice = (text) => notices.push(text);
    const volume = new ParticipantVolume(notice, storage());
    const audio = { volume: 1, srcObject: {} };
    volume.attach(audio, 'one');
    volume.set('one', 200);
    await tick();
    const context = volume.context;
    assert.equal(audio.volume, 1);
    assert.equal(volume.entries.get(audio).source, null);
    assert.equal(volume.entries.get(audio).gain, null);
    assert.equal(context.sources[0].connected, null);
    assert.equal(context.gains[0].connected, null);
    assert.match(notices[0], /limited to 100%/);
    volume.set('one', 0);
    assert.equal(audio.volume, 0);
    volume.stop();
  }
});
