const VOLUME_KEY = 'xxii:call-volume:';

const volumeValue = (value) => {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(0, Math.min(200, number)) : 100;
};

const disconnectNode = (node) => {
  try {
    node?.disconnect?.();
  } catch {
    return;
  }
};

class ParticipantVolume {
  constructor(notice, storage = null) {
    this.notice = notice;
    this.storage = storage;
    this.values = new Map();
    this.entries = new Map();
    this.context = null;
    this.opening = null;
    this.closed = false;
    this.sink = '';
  }

  get(peer) {
    if (this.values.has(peer)) return this.values.get(peer);
    let value = 100;
    try {
      const storage = this.storage ?? globalThis.localStorage;
      const saved = storage?.getItem(`${VOLUME_KEY}${peer}`);
      if (saved !== null && saved !== undefined) value = volumeValue(saved);
    } catch {
      this.notice('Participant volume cannot be saved in this browser.');
    }
    this.values.set(peer, value);
    return value;
  }

  set(peer, requested) {
    const value = volumeValue(requested);
    this.values.set(peer, value);
    try {
      const storage = this.storage ?? globalThis.localStorage;
      storage?.setItem(`${VOLUME_KEY}${peer}`, `${value}`);
    } catch {
      this.notice('Participant volume cannot be saved in this browser.');
    }
    for (const entry of this.entries.values()) {
      if (entry.peer === peer) this.apply(entry);
    }
    return value;
  }

  attach(audio, peer) {
    if (this.entries.has(audio)) return;
    const entry = { audio, peer, source: null, gain: null, pending: false };
    this.entries.set(audio, entry);
    this.apply(entry);
  }

  detach(audio) {
    const entry = this.entries.get(audio);
    disconnectNode(entry?.source);
    disconnectNode(entry?.gain);
    this.entries.delete(audio);
  }

  apply(entry) {
    const value = this.get(entry.peer) / 100;
    if (entry.gain) {
      entry.audio.volume = 0;
      entry.gain.gain.value = value;
      return;
    }
    entry.audio.volume = Math.min(1, value);
    if (value > 1 && !entry.pending) {
      entry.pending = true;
      this.boost(entry).finally(() => {
        entry.pending = false;
      });
    }
  }

  async openContext() {
    const Context = globalThis.AudioContext ?? globalThis.webkitAudioContext;
    if (!Context) throw new Error('unavailable');
    if (!this.context) this.context = new Context();
    const context = this.context;
    if (this.sink) await this.applySink();
    if (context.state === 'suspended') await context.resume();
    if (context.state !== 'running') throw new Error('blocked');
    return context;
  }

  async boost(entry) {
    let source = null;
    let gain = null;
    try {
      if (!this.opening) this.opening = this.openContext();
      const context = await this.opening;
      const active = !this.closed && this.entries.get(entry.audio) === entry;
      if (!active || this.get(entry.peer) <= 100) return;
      const canRoute =
        typeof context.createMediaStreamSource === 'function' &&
        typeof context.createGain === 'function' &&
        context.destination;
      if (!canRoute) throw new Error('unavailable');
      gain = context.createGain();
      source = context.createMediaStreamSource(entry.audio.srcObject);
      const nodes = [source, gain];
      const canConnect = nodes.every(
        (node) =>
          typeof node?.connect === 'function' &&
          typeof node?.disconnect === 'function',
      );
      if (!canConnect) throw new Error('unavailable');
      gain.gain.value = this.get(entry.peer) / 100;
      source.connect(gain);
      gain.connect(context.destination);
      entry.audio.volume = 0;
      entry.source = source;
      entry.gain = gain;
    } catch {
      disconnectNode(source);
      disconnectNode(gain);
      entry.audio.volume = Math.min(1, this.get(entry.peer) / 100);
      this.opening = null;
      this.notice('Volume boost is unavailable; playback is limited to 100%.');
    }
  }

  setSink(sink) {
    this.sink = sink;
    if (this.context) this.applySink();
  }

  async applySink() {
    const context = this.context;
    if (!context) return;
    if (typeof context.setSinkId !== 'function') {
      if (this.sink) {
        this.notice('Boosted audio uses the default speaker in this browser.');
      }
      return;
    }
    try {
      await context.setSinkId(this.sink);
    } catch {
      this.notice('The browser could not change the boosted audio speaker.');
    }
  }

  resume() {
    const resume = this.context?.resume;
    if (typeof resume === 'function') {
      resume.call(this.context).catch(() => {
        this.notice('Click to enable boosted sound.');
      });
    }
    for (const entry of this.entries.values()) this.apply(entry);
  }

  stop() {
    this.closed = true;
    for (const audio of this.entries.keys()) this.detach(audio);
    const context = this.context;
    this.context = null;
    this.opening = null;
    if (context && context.state !== 'closed') {
      context.close?.().catch(() => undefined);
    }
  }
}

export { volumeValue, disconnectNode, ParticipantVolume };
