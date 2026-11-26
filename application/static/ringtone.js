const TONE_HZ = 440;
const FLOOR = 0.0001;
const ATTACK_S = 0.03;
const DECAY_S = 0.35;
const CYCLE_MS = 450;

const audioContext = () =>
  globalThis.AudioContext ?? globalThis.webkitAudioContext;

const closeContext = (context) => {
  if (!context || context.state === 'closed') return;
  context.close().catch(() => undefined);
};

const shapeBeat = (gain, now, peak) => {
  gain.gain.cancelScheduledValues(now);
  gain.gain.setValueAtTime(FLOOR, now);
  gain.gain.exponentialRampToValueAtTime(peak, now + ATTACK_S);
  gain.gain.exponentialRampToValueAtTime(FLOOR, now + DECAY_S);
};

const testRing = async (peak) => {
  const Context = audioContext();
  if (!Context) throw new Error('Sound is unavailable in this browser');
  if (peak <= 0) return;
  const context = new Context();
  try {
    await context.resume();
    const oscillator = context.createOscillator();
    const gain = context.createGain();
    oscillator.type = 'sine';
    oscillator.frequency.value = TONE_HZ;
    oscillator.connect(gain);
    gain.connect(context.destination);
    shapeBeat(gain, context.currentTime, peak);
    oscillator.start();
    await new Promise((resolve) => setTimeout(resolve, CYCLE_MS));
    oscillator.stop();
  } finally {
    closeContext(context);
  }
};

export { TONE_HZ, audioContext, closeContext, shapeBeat, testRing };
