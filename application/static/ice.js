const ICE_KEY = 'xxii:ice';
const PUBLIC_STUN = [
  'stun:stun.l.google.com:19302',
  'stun:stun.cloudflare.com:3478',
];
const ICE_SCHEMES = ['stun:', 'stuns:', 'turn:', 'turns:'];
const CACHE_LEAD_SEC = 10 * 60;
const TURN_USER = /^(\d+):/;

const isIceUrl = (value) => {
  try {
    const url = new URL(value);
    return ICE_SCHEMES.includes(url.protocol);
  } catch {
    return false;
  }
};

const iceDefaults = () => ({
  publicStun: false,
  forceRelay: false,
  servers: [],
});

const textOf = (value) => (typeof value === 'string' ? value : '');

const iceRecord = (server) => {
  if (!server || typeof server !== 'object') return null;
  if (!isIceUrl(server.url)) return null;
  const username = textOf(server.username);
  const credential = textOf(server.credential);
  return { url: server.url, username, credential };
};

const keptServers = (servers) => {
  if (!Array.isArray(servers)) return [];
  const kept = [];
  for (const server of servers) {
    const record = iceRecord(server);
    if (record) kept.push(record);
  }
  return kept;
};

const normalizeIce = (value) => {
  const isRecord = value && typeof value === 'object' && !Array.isArray(value);
  if (!isRecord) return iceDefaults();
  const publicStun = value.publicStun === true;
  const forceRelay = value.forceRelay === true;
  const servers = keptServers(value.servers);
  return { publicStun, forceRelay, servers };
};

const readIce = (storage) => {
  try {
    const raw = storage.getItem(ICE_KEY);
    if (typeof raw !== 'string' || raw === '') return iceDefaults();
    return normalizeIce(JSON.parse(raw));
  } catch {
    return iceDefaults();
  }
};

const writeIce = (storage, settings) => {
  try {
    storage.setItem(ICE_KEY, JSON.stringify(settings));
    return true;
  } catch {
    return false;
  }
};

const rtcServer = (server) => {
  const entry = { urls: [server.url] };
  if (server.username) entry.username = server.username;
  if (server.credential) entry.credential = server.credential;
  return entry;
};

const expiryOf = (entry) => {
  const { username } = entry;
  if (typeof username !== 'string') return Infinity;
  const match = TURN_USER.exec(username);
  if (!match) return Infinity;
  return Number(match[1]);
};

const freshUntilOf = (entries) => {
  let expiry = Infinity;
  for (const entry of entries) {
    const value = expiryOf(entry);
    if (value < expiry) expiry = value;
  }
  if (expiry === Infinity) return Infinity;
  return (expiry - CACHE_LEAD_SEC) * 1000;
};

const buildIce = ({ servers, settings }) => {
  const iceServers = servers.slice();
  if (settings.publicStun) {
    for (const url of PUBLIC_STUN) iceServers.push({ urls: [url] });
  }
  for (const server of settings.servers) iceServers.push(rtcServer(server));
  const iceTransportPolicy = settings.forceRelay ? 'relay' : 'all';
  const freshUntil = freshUntilOf(iceServers);
  return { iceServers, iceTransportPolicy, freshUntil };
};

export {
  ICE_KEY,
  PUBLIC_STUN,
  ICE_SCHEMES,
  CACHE_LEAD_SEC,
  isIceUrl,
  readIce,
  writeIce,
  buildIce,
};
