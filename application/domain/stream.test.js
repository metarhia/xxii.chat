({
  name: 'Stream relay test',
  options: {},

  async run(t) {
    const OPEN = {
      allowHttp: true,
      allowPrivate: true,
      timeoutMs: 2000,
      maxBody: 65536,
    };
    const SECRET = 'secret-token-0xB16B00B5';
    const OFFER = 'v=0\r\no=secret-offer-sdp';
    const ANSWER = 'v=0\r\no=answer';

    const createClient = () => {
      const listeners = [];
      const on = (name, listener) => listeners.push(listener);
      const emit = () => undefined;
      const close = () => {
        for (const listener of listeners) listener();
      };
      return { on, emit, close };
    };

    const person = (clients, peer) => {
      const client = createClient();
      clients.push(client);
      domain.presence.announce(client, { peer, nick: peer });
      return client;
    };

    const done = async (clients) => {
      for (const client of clients) {
        await domain.call.drop(client);
        client.close();
      }
      domain.stream.windows.clear();
      node.assert.strictEqual(domain.call.calls.size, 0);
    };

    const isCode = (error, code) => {
      node.assert.ok(error instanceof DomainError);
      node.assert.strictEqual(error.code, code);
    };

    const joined = async (clients, peer) => {
      const client = person(clients, peer);
      const endpoint = `${peer}:1`;
      const opened = await domain.call.open(client, {
        chat: `room-${peer}`,
        endpoint,
        nick: peer,
      });
      return { client, endpoint, call: opened.state.call };
    };

    const serve = async (handler) => {
      const seen = [];
      const server = node.http.createServer((request, response) => {
        const chunks = [];
        request.on('data', (chunk) => chunks.push(chunk));
        request.on('end', () => {
          const body = Buffer.concat(chunks).toString('utf8');
          const entry = { request, body };
          seen.push(entry);
          handler(request, response, entry);
        });
      });
      await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
      const { port } = server.address();
      const base = `http://127.0.0.1:${port}`;
      const close = async () => {
        server.closeAllConnections();
        await new Promise((resolve) => server.close(resolve));
      };
      return { seen, base, port, close };
    };

    const answer = (request, response) => {
      response.writeHead(201, {
        'Content-Type': 'application/sdp',
        Location: '/whip/1',
        Link: '<stun:stun.example.org>; rel="ice-server"',
      });
      response.end(ANSWER);
    };

    const offerOf = (who, url, extra = {}) =>
      domain.stream.whip(
        who.client,
        {
          call: who.call,
          endpoint: who.endpoint,
          action: 'offer',
          url,
          token: SECRET,
          sdp: OFFER,
          ...extra,
        },
        extra.options ?? OPEN,
      );

    const capture = () => {
      const lines = [];
      const names = ['log', 'info', 'warn', 'error', 'debug'];
      const saved = {};
      for (const name of names) {
        saved[name] = console[name];
        console[name] = (...args) => lines.push(args.join(' '));
      }
      const restore = () => {
        for (const name of names) console[name] = saved[name];
      };
      return { lines, restore };
    };

    await t.test('Offer is relayed without Origin and parsed', async () => {
      const clients = [];
      const endpoint = await serve(answer);
      try {
        const who = await joined(clients, 'st-ada');
        const result = await offerOf(who, `${endpoint.base}/whip`);
        node.assert.strictEqual(result.status, 201);
        node.assert.strictEqual(result.sdp, ANSWER);
        node.assert.strictEqual(result.location, `${endpoint.base}/whip/1`);
        node.assert.strictEqual(result.links.length, 1);
        node.assert.strictEqual(
          result.links[0],
          '<stun:stun.example.org>; rel="ice-server"',
        );
        node.assert.strictEqual(endpoint.seen.length, 1);
        const { request, body } = endpoint.seen[0];
        node.assert.strictEqual(request.method, 'POST');
        node.assert.strictEqual(request.url, '/whip');
        node.assert.strictEqual(request.headers.origin, undefined);
        node.assert.strictEqual(
          request.headers.authorization,
          `Bearer ${SECRET}`,
        );
        node.assert.strictEqual(
          request.headers['content-type'],
          'application/sdp',
        );
        node.assert.strictEqual(body, OFFER);
      } finally {
        await endpoint.close();
        await done(clients);
      }
    });

    await t.test('Delete is relayed and returns the status', async () => {
      const clients = [];
      const endpoint = await serve((request, response) => {
        response.writeHead(200);
        response.end('ignored');
      });
      try {
        const who = await joined(clients, 'st-bob');
        const result = await domain.stream.whip(
          who.client,
          {
            call: who.call,
            endpoint: who.endpoint,
            action: 'delete',
            location: `${endpoint.base}/whip/1`,
            token: SECRET,
          },
          OPEN,
        );
        node.assert.strictEqual(result.status, 200);
        node.assert.strictEqual(Object.keys(result).length, 1);
        const { request } = endpoint.seen[0];
        node.assert.strictEqual(request.method, 'DELETE');
        node.assert.strictEqual(request.url, '/whip/1');
        node.assert.strictEqual(
          request.headers.authorization,
          `Bearer ${SECRET}`,
        );
      } finally {
        await endpoint.close();
        await done(clients);
      }
    });

    await t.test('Http needs allowHttp and a loopback host', async () => {
      const clients = [];
      const endpoint = await serve(answer);
      try {
        const who = await joined(clients, 'st-cat');
        const strict = { ...OPEN, allowHttp: false };
        const off = await offerOf(who, endpoint.base, { options: strict });
        isCode(off, 'stream/refused');
        const remote = await offerOf(who, 'http://example.org/whip');
        isCode(remote, 'stream/refused');
        const odd = await offerOf(who, 'ftp://127.0.0.1/whip');
        isCode(odd, 'stream/refused');
        node.assert.strictEqual(endpoint.seen.length, 0);
        const on = await offerOf(who, endpoint.base);
        node.assert.strictEqual(on.status, 201);
        node.assert.strictEqual(endpoint.seen.length, 1);
      } finally {
        await endpoint.close();
        await done(clients);
      }
    });

    await t.test('Private addresses need allowPrivate', async () => {
      const clients = [];
      const endpoint = await serve(answer);
      try {
        const who = await joined(clients, 'st-dan');
        const strict = { ...OPEN, allowPrivate: false };
        const literal = await offerOf(who, endpoint.base, { options: strict });
        isCode(literal, 'stream/refused');
        const named = `http://localhost:${endpoint.port}/whip`;
        const resolved = await offerOf(who, named, { options: strict });
        isCode(resolved, 'stream/refused');
        const v6 = await offerOf(who, 'http://[::1]:9/whip', {
          options: strict,
        });
        isCode(v6, 'stream/refused');
        const mapped = await offerOf(who, 'https://[::ffff:7f00:1]/whip', {
          options: strict,
        });
        isCode(mapped, 'stream/refused');
        const unlocked = await offerOf(who, named);
        node.assert.strictEqual(unlocked.status, 201);
        node.assert.strictEqual(endpoint.seen.length, 1);
      } finally {
        await endpoint.close();
        await done(clients);
      }
    });

    await t.test('URL credentials and bad arguments are refused', async () => {
      const clients = [];
      const endpoint = await serve(answer);
      try {
        const who = await joined(clients, 'st-eve');
        const url = `http://user:pass@127.0.0.1:${endpoint.port}/whip`;
        isCode(await offerOf(who, url), 'stream/refused');
        const plain = `${endpoint.base}/whip`;
        isCode(await offerOf(who, plain, { sdp: '' }), 'stream/refused');
        isCode(await offerOf(who, plain, { sdp: 42 }), 'stream/refused');
        isCode(
          await offerOf(who, plain, { token: 'a\r\nb' }),
          'stream/refused',
        );
        isCode(await offerOf(who, plain, { token: 7 }), 'stream/refused');
        isCode(await offerOf(who, 42), 'stream/refused');
        isCode(await offerOf(who, 'not a url'), 'stream/refused');
        isCode(await offerOf(who, plain, { action: 'get' }), 'stream/refused');
        const noToken = await offerOf(who, plain, { token: '' });
        node.assert.strictEqual(noToken.status, 201);
        const entry = endpoint.seen[0];
        node.assert.strictEqual(entry.request.headers.authorization, undefined);
        node.assert.strictEqual(endpoint.seen.length, 1);
      } finally {
        await endpoint.close();
        await done(clients);
      }
    });

    await t.test('Redirects are returned, not followed', async () => {
      const clients = [];
      const target = await serve(answer);
      const endpoint = await serve((request, response) => {
        response.writeHead(307, { Location: `${target.base}/elsewhere` });
        response.end('moved');
      });
      try {
        const who = await joined(clients, 'st-fay');
        const result = await offerOf(who, `${endpoint.base}/whip`);
        node.assert.strictEqual(result.status, 307);
        node.assert.strictEqual(result.location, `${target.base}/elsewhere`);
        node.assert.strictEqual(result.sdp, '');
        node.assert.strictEqual(endpoint.seen.length, 1);
        node.assert.strictEqual(target.seen.length, 0);
      } finally {
        await endpoint.close();
        await target.close();
        await done(clients);
      }
    });

    await t.test('A slow endpoint is aborted by the timeout', async () => {
      const clients = [];
      const endpoint = await serve(() => undefined);
      try {
        const who = await joined(clients, 'st-gus');
        const options = { ...OPEN, timeoutMs: 150 };
        const started = Date.now();
        const result = await offerOf(who, endpoint.base, { options });
        isCode(result, 'stream/failed');
        node.assert.ok(Date.now() - started < 1500);
      } finally {
        await endpoint.close();
        await done(clients);
      }
    });

    await t.test('Unreachable endpoints fail', async () => {
      const clients = [];
      const closed = await serve(answer);
      const { base } = closed;
      await closed.close();
      try {
        const who = await joined(clients, 'st-hal');
        isCode(await offerOf(who, base), 'stream/failed');
      } finally {
        await done(clients);
      }
    });

    await t.test('Oversized bodies are refused or aborted', async () => {
      const clients = [];
      const endpoint = await serve((request, response) => {
        response.writeHead(201, { 'Content-Type': 'application/sdp' });
        response.end('x'.repeat(5000));
      });
      try {
        const who = await joined(clients, 'st-ivy');
        const small = { ...OPEN, maxBody: 1000 };
        const request = await offerOf(who, endpoint.base, {
          sdp: 'y'.repeat(1001),
          options: small,
        });
        isCode(request, 'stream/refused');
        node.assert.strictEqual(endpoint.seen.length, 0);
        const response = await offerOf(who, endpoint.base, { options: small });
        isCode(response, 'stream/failed');
        node.assert.strictEqual(endpoint.seen.length, 1);
        const fits = await offerOf(who, endpoint.base);
        node.assert.strictEqual(fits.status, 201);
        node.assert.strictEqual(fits.sdp.length, 5000);
      } finally {
        await endpoint.close();
        await done(clients);
      }
    });

    await t.test('The client must own a joined endpoint', async () => {
      const clients = [];
      const endpoint = await serve(answer);
      try {
        const host = await joined(clients, 'st-jon');
        const url = `${endpoint.base}/whip`;
        const stranger = createClient();
        clients.push(stranger);
        const bare = await offerOf({ ...host, client: stranger }, url);
        isCode(bare, 'stream/forbidden');
        const kim = person(clients, 'st-kim');
        const foreign = { ...host, client: kim };
        isCode(await offerOf(foreign, url), 'stream/forbidden');
        const outside = { client: kim, endpoint: 'st-kim:1', call: host.call };
        isCode(await offerOf(outside, url), 'stream/forbidden');
        const missing = { ...host, call: 'missing' };
        isCode(await offerOf(missing, url), 'stream/forbidden');
        isCode(
          await offerOf({ ...host, endpoint: 7 }, url),
          'stream/forbidden',
        );
        const empty = await domain.stream.whip(host.client, undefined, OPEN);
        isCode(empty, 'stream/forbidden');
        node.assert.strictEqual(endpoint.seen.length, 0);
        const own = await offerOf(host, url);
        node.assert.strictEqual(own.status, 201);
      } finally {
        await endpoint.close();
        await done(clients);
      }
    });

    await t.test('Requests are limited per endpoint', async () => {
      const clients = [];
      const endpoint = await serve(answer);
      try {
        const ada = await joined(clients, 'st-lee');
        const bob = await joined(clients, 'st-max');
        const url = `${endpoint.base}/whip`;
        for (let i = 0; i < 30; i++) {
          const result = await offerOf(ada, url);
          node.assert.strictEqual(result.status, 201);
        }
        isCode(await offerOf(ada, url), 'stream/rate');
        const gone = await domain.stream.whip(
          ada.client,
          {
            call: ada.call,
            endpoint: ada.endpoint,
            action: 'delete',
            location: `${endpoint.base}/whip/1`,
          },
          OPEN,
        );
        isCode(gone, 'stream/rate');
        node.assert.strictEqual(endpoint.seen.length, 30);
        const other = await offerOf(bob, url);
        node.assert.strictEqual(other.status, 201);
        const times = domain.stream.windows.get(ada.endpoint);
        const old = Date.now() - 61000;
        domain.stream.windows.set(
          ada.endpoint,
          times.map(() => old),
        );
        const again = await offerOf(ada, url);
        node.assert.strictEqual(again.status, 201);
      } finally {
        await endpoint.close();
        await done(clients);
      }
    });

    await t.test('Tokens and SDP never reach the logs', async () => {
      const clients = [];
      const failing = await serve((request, response) => {
        response.writeHead(500);
        response.end(`${SECRET} ${OFFER}`);
      });
      const slow = await serve(() => undefined);
      const logs = capture();
      try {
        const who = await joined(clients, 'st-nia');
        const plain = `${failing.base}/whip`;
        const fifty = await offerOf(who, plain);
        node.assert.strictEqual(fifty.status, 500);
        const strict = { ...OPEN, allowPrivate: false };
        await offerOf(who, plain, { options: strict });
        const quick = { ...OPEN, timeoutMs: 100 };
        await offerOf(who, slow.base, { options: quick });
        const hang = { ...OPEN, maxBody: 10 };
        await offerOf(who, plain, { sdp: 'z'.repeat(11), options: hang });
        const text = logs.lines.join('\n');
        node.assert.ok(text.includes(`127.0.0.1:${failing.port}: 500`));
        node.assert.ok(!text.includes(SECRET));
        node.assert.ok(!text.includes('secret-offer-sdp'));
        node.assert.ok(!text.includes('Bearer'));
      } finally {
        logs.restore();
        await failing.close();
        await slow.close();
        await done(clients);
      }
    });
  },
});
