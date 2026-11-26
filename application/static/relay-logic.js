const RELAY_SLOTS = [
  { slot: 'relayAudio', kind: 'audio' },
  { slot: 'relayVideo', kind: 'video' },
];

const RELAY_WIDTH = 640;
const RELAY_HEIGHT = 360;
const RELAY_FPS = 15;
const RELAY_BITRATE = 500000;

const DENIALS = ['busy', 'not-linked', 'not-joined', 'no-sound'];

const needsRelay = (local, remote, failures) => failures >= 3 && local < remote;

const relayCandidates = (people, from, to, connected) => {
  const candidates = [];
  for (const { endpoint } of people) {
    if (endpoint !== from && endpoint !== to && connected(endpoint)) {
      candidates.push(endpoint);
    }
  }
  return candidates.toSorted();
};

const relayDenial = ({ joined, linked, busy, blocked }) => {
  if (!joined) return 'not-joined';
  if (!linked) return 'not-linked';
  if (busy) return 'busy';
  if (blocked) return 'no-sound';
  return '';
};

const canSilence = (audio) => {
  try {
    audio.volume = 0;
    return audio.volume === 0;
  } catch {
    return false;
  }
};

const readRelayMessage = (message, local, sender) => {
  if (message?.type !== 'relay') return null;
  const { action, from, to, reason, peer } = message;
  if (typeof from !== 'string' || typeof to !== 'string') return null;
  if (!from || from >= to || local === sender) return null;
  const localInPair = local === from || local === to;
  const senderInPair = sender === from || sender === to;
  if (action === 'ask' && !localInPair && sender === from) return message;
  if (action === 'stop' && !localInPair && senderInPair) return message;
  if (!localInPair || senderInPair) return null;
  if (action === 'deny' && local === from && DENIALS.includes(reason)) {
    return message;
  }
  const other = local === from ? to : from;
  if ((action === 'assign' || action === 'release') && peer === other) {
    return message;
  }
  return null;
};

const relayVideoSource = (person) => {
  if (person?.screen === true) return 'screen';
  if (person?.camera === true) return 'camera';
  return '';
};

const relaySlot = (person, slot) => {
  if (slot === 'mic') return 'relayAudio';
  if (slot && slot === relayVideoSource(person)) return 'relayVideo';
  return '';
};

const relayVideoEncoding = (width, height) => {
  if (!(width > 0 && height > 0)) return null;
  const scale = Math.max(1, width / RELAY_WIDTH, height / RELAY_HEIGHT);
  return {
    maxBitrate: RELAY_BITRATE,
    maxFramerate: RELAY_FPS,
    scaleResolutionDownBy: scale,
  };
};

export {
  RELAY_SLOTS,
  RELAY_WIDTH,
  RELAY_HEIGHT,
  RELAY_FPS,
  needsRelay,
  relayCandidates,
  relayDenial,
  canSilence,
  readRelayMessage,
  relayVideoSource,
  relaySlot,
  relayVideoEncoding,
};
