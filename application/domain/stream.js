const RATE_LIMIT = 30;
const RATE_WINDOW_MS = 60000;
const RATE_SWEEP = 64;
const URL_LENGTH = 2048;
const TOKEN_LENGTH = 4096;
const TOKEN = /^[\x21-\x7e]+$/;
const LOOPBACK = ['localhost', '127.0.0.1', '[::1]'];
const REFUSED = 'stream/refused';
const FAILED = 'stream/failed';

const isText = (value) => typeof value === 'string';

const fail = (code) => new DomainError(code);

const hostOf = (url) => url.hostname.replace(/^\[|\]$/g, '');

const isBlockedLiteral = (url) => {
  const host = hostOf(url);
  return node.net.isIP(host) !== 0 && npm.metaice.isPrivate(host);
};

const targetOf = (text, options) => {
  if (!isText(text) || text.length > URL_LENGTH) return null;
  let url = null;
  try {
    url = new URL(text);
  } catch {
    return null;
  }
  if (url.username || url.password) return null;
  const isLoopback = LOOPBACK.includes(url.hostname);
  const isHttp = url.protocol === 'http:' && options.allowHttp && isLoopback;
  if (url.protocol !== 'https:' && !isHttp) return null;
  if (!options.allowPrivate && isBlockedLiteral(url)) return null;
  return url;
};

const isTokenValid = (token) =>
  token === undefined ||
  token === '' ||
  (isText(token) && token.length <= TOKEN_LENGTH && TOKEN.test(token));

const headersOf = (token, extra) => {
  const headers = { ...extra };
  if (token) headers.Authorization = `Bearer ${token}`;
  return headers;
};

const locationOf = (location, base) => {
  if (!isText(location) || location === '') return '';
  try {
    return new URL(location, base).href;
  } catch {
    return '';
  }
};

const lookupOf = (options) => (host, lookupOptions, callback) => {
  const query = { ...lookupOptions, all: true };
  node.dns.lookup(host, query, (error, list) => {
    if (error) return void callback(error);
    const isBlocked =
      !options.allowPrivate &&
      list.some((item) => npm.metaice.isPrivate(item.address));
    if (isBlocked) return void callback(new Error('Refused', REFUSED));
    if (lookupOptions.all) return void callback(null, list);
    const item = list[0];
    callback(null, item.address, item.family);
  });
};

const exchange = (url, init, options) =>
  new Promise((resolve, reject) => {
    const { method, headers, body, isReading } = init;
    const transport = url.protocol === 'https:' ? node.https : node.http;
    const chunks = [];
    let size = 0;
    let request = null;
    let timer = 0;
    let isDone = false;

    const done = (error, result) => {
      if (isDone) return;
      isDone = true;
      clearTimeout(timer);
      if (error) {
        request?.destroy();
        reject(error);
      } else {
        resolve(result);
      }
    };

    const onData = (chunk) => {
      size += chunk.length;
      if (size > options.maxBody) return void done(new Error('Large', FAILED));
      chunks.push(chunk);
    };

    const onResponse = (response) => {
      const status = response.statusCode;
      const location = response.headers.location ?? '';
      const links = response.headersDistinct.link ?? [];
      const isOk = status >= 200 && status < 300;
      const result = { status, sdp: '', location, links };
      if (!isReading || !isOk) {
        response.destroy();
        return void done(null, result);
      }
      response.on('data', onData);
      response.on('end', () => {
        result.sdp = Buffer.concat(chunks).toString('utf8');
        done(null, result);
      });
      response.on('close', () => done(new Error('Closed', FAILED)));
      response.on('error', done);
    };

    const settings = { method, headers, agent: false };
    settings.lookup = lookupOf(options);
    try {
      request = transport.request(url, settings, onResponse);
    } catch {
      return void done(new Error('Refused', REFUSED));
    }
    request.on('error', done);
    timer = setTimeout(
      () => done(new Error('Timeout', FAILED)),
      options.timeoutMs,
    );
    request.end(body);
  });

const report = (url, reason) =>
  console.warn(`Stream relay ${url.host}: ${reason}`);

const send = async (url, init, options) => {
  try {
    const result = await exchange(url, init, options);
    if (result.status >= 400) report(url, result.status);
    return result;
  } catch (error) {
    const code = error?.code ?? 'error';
    report(url, code);
    return fail(code === REFUSED ? REFUSED : FAILED);
  }
};

const offer = async (args, options) => {
  const { url, token, sdp } = args;
  const target = targetOf(url, options);
  const isValid = isText(sdp) && sdp !== '' && isTokenValid(token);
  if (!target || !isValid) return fail(REFUSED);
  const body = Buffer.from(sdp, 'utf8');
  if (body.length > options.maxBody) return fail(REFUSED);
  const type = { 'Content-Type': 'application/sdp' };
  const headers = headersOf(token, { ...type, 'Content-Length': body.length });
  const init = { method: 'POST', headers, body, isReading: true };
  const result = await send(target, init, options);
  if (result instanceof DomainError) return result;
  const location = locationOf(result.location, target);
  return { ...result, location };
};

const remove = async (args, options) => {
  const { location, token } = args;
  const target = targetOf(location, options);
  if (!target || !isTokenValid(token)) return fail(REFUSED);
  const init = { method: 'DELETE', headers: headersOf(token, {}) };
  const result = await send(target, init, options);
  if (result instanceof DomainError) return result;
  return { status: result.status };
};

const admit = (windows, endpoint, now) => {
  const times = windows.get(endpoint) ?? [];
  const recent = times.filter((time) => now - time < RATE_WINDOW_MS);
  const isAllowed = recent.length < RATE_LIMIT;
  if (isAllowed) recent.push(now);
  windows.set(endpoint, recent);
  if (windows.size > RATE_SWEEP) {
    for (const [key, list] of windows) {
      const last = list[list.length - 1] ?? 0;
      if (now - last >= RATE_WINDOW_MS) windows.delete(key);
    }
  }
  return isAllowed;
};

({
  windows: new Map(),

  async whip(client, args, options = config.stream) {
    if (!domain.call.member(client, args)) return fail('stream/forbidden');
    const { endpoint, action } = args;
    if (!admit(domain.stream.windows, endpoint, Date.now())) {
      return fail('stream/rate');
    }
    if (action === 'offer') return offer(args, options);
    if (action === 'delete') return remove(args, options);
    return fail(REFUSED);
  },
});
