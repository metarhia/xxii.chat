const hueOf = (id) => {
  let hash = 0;
  for (const char of id) hash = (hash * 33 + char.charCodeAt(0)) % 360;
  return hash;
};

const peerOf = (endpoint) => {
  const index = endpoint.indexOf(':');
  if (index <= 0) return endpoint;
  return endpoint.slice(0, index);
};

const colorOf = (endpoint) => {
  const peer = endpoint ? peerOf(endpoint) : 'guest';
  return `hsl(${hueOf(peer)} 42% 32%)`;
};

const initialsOf = (name) => {
  const text = typeof name === 'string' ? name.trim() : '';
  if (text === '') return '?';
  const parts = text.split(/\s+/);
  const first = parts[0];
  const second = parts[1];
  if (!second) return first.slice(0, 2).toUpperCase();
  return `${first[0]}${second[0]}`.toUpperCase();
};

export { peerOf, colorOf, initialsOf };
