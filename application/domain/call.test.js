({
  name: 'Call test',
  options: {},

  async run(t) {
    const createClient = () => {
      const events = [];
      const listeners = [];
      const on = (name, listener) => listeners.push(listener);
      const emit = (name, data) => events.push({ name, data });
      const close = () => {
        for (const listener of listeners) listener();
      };
      return { events, on, emit, close };
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
      node.assert.strictEqual(domain.call.calls.size, 0);
      node.assert.strictEqual(domain.call.endpoints.size, 0);
    };

    const isCode = (error, code) => {
      node.assert.ok(error instanceof DomainError);
      node.assert.strictEqual(error.code, code);
      return error;
    };

    const named = (client, name) =>
      client.events.filter((event) => event.name === name);

    const last = (client, name) => {
      const found = named(client, name);
      return found[found.length - 1];
    };

    const patch = (values) => {
      const previous = {};
      for (const key in values) {
        previous[key] = config.call[key];
        config.call[key] = values[key];
      }
      return () => {
        for (const key in previous) config.call[key] = previous[key];
      };
    };

    const ownedBy = (owner) => {
      const previous = db.globalstorage;
      const replica = { get: () => ({ owner }) };
      db.globalstorage = { ...previous, replica };
      return () => {
        db.globalstorage = previous;
      };
    };

    const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

    const begin = (client, chat, endpoint, extra = {}) =>
      domain.call.start(client, {
        chat,
        endpoint,
        nick: extra.nick ?? 'nick',
        title: extra.title,
        policy: extra.policy,
      });

    const enter = (client, call, endpoint, extra = {}) =>
      domain.call.join(client, {
        call,
        endpoint,
        nick: extra.nick ?? 'nick',
        token: extra.token,
        resume: extra.resume,
        chat: extra.chat,
        host: extra.host,
        started: extra.started,
      });

    const crash = () => {
      for (const state of domain.call.calls.values()) {
        if (state.ringing) clearTimeout(state.ringing.timer);
      }
      domain.call.calls.clear();
      domain.call.endpoints.clear();
      domain.call.buckets.clear();
    };

    const row = (state, endpoint) =>
      state.participants.find((item) => item.endpoint === endpoint);

    await t.test('Endpoint must belong to the client', async () => {
      const clients = [];
      try {
        const bare = createClient();
        clients.push(bare);
        const missing = await domain.call.join(bare, {
          call: 'none',
          endpoint: 'z-ada:1',
          nick: 'ada',
        });
        isCode(missing, 'call/forbidden');
        const ada = person(clients, 'z-ada');
        const foreign = await begin(ada, 'general', 'z-bob:1');
        isCode(foreign, 'call/forbidden');
      } finally {
        await done(clients);
      }
    });

    await t.test('Start and join', async () => {
      const clients = [];
      try {
        const ada = person(clients, 's-ada');
        const bob = person(clients, 's-bob');
        const absent = await enter(ada, 'missing', 's-ada:1');
        isCode(absent, 'call/not-found');
        const opened = await begin(ada, 'general', 's-ada:1', {
          nick: 'n'.repeat(40),
          title: 't'.repeat(80),
        });
        const id = opened.state.call;
        node.assert.strictEqual(opened.state.version, 1);
        node.assert.strictEqual(opened.state.policy, 'link');
        node.assert.strictEqual(opened.state.kind, 'chat');
        node.assert.strictEqual(opened.state.title.length, 64);
        node.assert.strictEqual(opened.state.participants[0].nick.length, 32);
        node.assert.strictEqual(opened.state.participants[0].admin, true);
        node.assert.ok(opened.token);
        const cards = domain.call.active();
        node.assert.strictEqual(cards.length, 1);
        node.assert.strictEqual(cards[0].count, 1);
        node.assert.strictEqual(cards[0].call, id);
        const joined = await enter(bob, id, 's-bob:1', {
          token: opened.token,
        });
        node.assert.strictEqual(joined.status, 'joined');
        node.assert.strictEqual(joined.state.version, 2);
        node.assert.strictEqual(joined.state.participants.length, 2);
        node.assert.strictEqual(joined.state.lobby.length, 0);
        node.assert.strictEqual(row(joined.state, 's-bob:1').admin, false);
        node.assert.ok(Object.isFrozen(last(ada, 'call/state').data));
        const live = named(ada, 'call/active');
        node.assert.ok(live.some((event) => event.data.count === 2));
        node.assert.strictEqual(
          await domain.call.leave(bob, { call: id, endpoint: 's-bob:1' }),
          true,
        );
        node.assert.strictEqual(domain.call.calls.get(id).participants.size, 1);
        const lobby = await enter(bob, id, 's-bob:1');
        node.assert.strictEqual(lobby.status, 'lobby');
        node.assert.strictEqual(lobby.state, undefined);
        node.assert.strictEqual(last(ada, 'call/state').data.lobby.length, 1);
        node.assert.strictEqual(await domain.call.end(ada, { call: id }), true);
        node.assert.strictEqual(last(ada, 'call/ended').data.by, 's-ada');
        node.assert.strictEqual(last(bob, 'call/ended').data.call, id);
        const ended = last(ada, 'call/active').data;
        node.assert.strictEqual(ended.ended, true);
        node.assert.strictEqual(ended.count, 0);
        node.assert.strictEqual(domain.call.calls.has(id), false);
      } finally {
        await done(clients);
      }
    });

    await t.test('A live chat returns call/exists', async () => {
      const clients = [];
      const restore = patch({ maxCallsPerPeer: 1 });
      try {
        const ada = person(clients, 'e-ada');
        const first = await begin(ada, 'one', 'e-ada:1');
        const again = await begin(ada, 'one', 'e-ada:2');
        isCode(again, 'call/exists');
        node.assert.strictEqual(again.cause, first.state.call);
        const other = await begin(ada, 'two', 'e-ada:3');
        isCode(other, 'call/forbidden');
      } finally {
        restore();
        await done(clients);
      }
    });

    await t.test('Admission follows policy, token, and lock', async () => {
      const clients = [];
      let restore = null;
      try {
        const host = person(clients, 'm-host');
        const token = person(clients, 'm-tok');
        const other = person(clients, 'm-out');
        const owner = person(clients, 'm-own');
        const expect = {
          open: { token: 'joined', other: 'joined' },
          link: { token: 'joined', other: 'lobby' },
          approval: { token: 'lobby', other: 'lobby' },
        };
        for (const policy of ['open', 'link', 'approval']) {
          const opened = await begin(host, `room-${policy}`, 'm-host:1', {
            policy,
          });
          const id = opened.state.call;
          const admin = await enter(host, id, `m-host:${policy}`, {
            token: opened.token,
          });
          node.assert.strictEqual(admin.status, 'joined');
          const withToken = await enter(token, id, `m-tok:${policy}`, {
            token: opened.token,
          });
          node.assert.strictEqual(withToken.status, expect[policy].token);
          const plain = await enter(other, id, `m-out:${policy}`);
          node.assert.strictEqual(plain.status, expect[policy].other);
          if (expect[policy].token === 'joined') {
            node.assert.strictEqual(withToken.state.lobby.length, 0);
          }
          await domain.call.end(host, { call: id });
        }
        const opened = await begin(host, 'room-lock', 'm-host:lock');
        const id = opened.state.call;
        await domain.call.host(host, { call: id, action: 'lock' });
        isCode(
          await enter(token, id, 'm-tok:lock', { token: opened.token }),
          'call/locked',
        );
        isCode(await enter(other, id, 'm-out:lock'), 'call/locked');
        node.assert.strictEqual(domain.call.calls.get(id).lobby.size, 0);
        const admin = await enter(host, id, 'm-host:lock2');
        node.assert.strictEqual(admin.status, 'joined');
        await domain.call.end(host, { call: id });
        restore = ownedBy('m-own');
        const owned = await begin(host, 'room-own', 'm-host:own', {
          policy: 'approval',
        });
        const ownedId = owned.state.call;
        const asOwner = await enter(owner, ownedId, 'm-own:1');
        node.assert.strictEqual(asOwner.status, 'joined');
        node.assert.strictEqual(row(asOwner.state, 'm-own:1').admin, true);
        await domain.call.end(host, { call: ownedId });
      } finally {
        if (restore) restore();
        await done(clients);
      }
    });

    await t.test('An omitted policy follows the config', async () => {
      const clients = [];
      const restore = patch({ defaultPolicy: 'approval' });
      try {
        const ada = person(clients, 'p-ada');
        const bob = person(clients, 'p-bob');
        const opened = await begin(ada, 'policy', 'p-ada:1');
        const id = opened.state.call;
        node.assert.strictEqual(opened.state.policy, 'approval');
        const knock = await enter(bob, id, 'p-bob:1', {
          token: opened.token,
        });
        node.assert.strictEqual(knock.status, 'lobby');
        const read = await domain.call.link(ada, { call: id });
        node.assert.strictEqual(read.token, opened.token);
        const again = await domain.call.link(ada, { call: id });
        node.assert.strictEqual(again.token, read.token);
      } finally {
        restore();
        await done(clients);
      }
    });

    await t.test('Lobby admit and deny', async () => {
      const clients = [];
      try {
        const ada = person(clients, 'l-ada');
        const bob = person(clients, 'l-bob');
        const cam = person(clients, 'l-cam');
        const opened = await begin(ada, 'lobby', 'l-ada:1');
        const id = opened.state.call;
        const knock = await enter(bob, id, 'l-bob:1');
        node.assert.strictEqual(knock.status, 'lobby');
        node.assert.strictEqual(named(bob, 'call/state').length, 0);
        const listed = last(ada, 'call/state').data.lobby[0];
        node.assert.strictEqual(listed.endpoint, 'l-bob:1');
        node.assert.strictEqual(listed.peer, 'l-bob');
        node.assert.strictEqual(typeof listed.knocked, 'number');
        bob.events.length = 0;
        node.assert.strictEqual(
          await domain.call.admit(ada, { call: id, endpoint: 'missing' }),
          true,
        );
        node.assert.strictEqual(bob.events.length, 0);
        node.assert.strictEqual(
          await domain.call.deny(ada, { call: id, endpoint: 'l-bob:1' }),
          true,
        );
        node.assert.deepStrictEqual(last(bob, 'call/denied').data, {
          call: id,
          endpoint: 'l-bob:1',
        });
        node.assert.strictEqual(domain.call.calls.get(id).lobby.size, 0);
        await enter(bob, id, 'l-bob:1');
        node.assert.strictEqual(
          await domain.call.admit(ada, { call: id, endpoint: 'l-bob:1' }),
          true,
        );
        const admitted = last(bob, 'call/admitted').data;
        node.assert.strictEqual(admitted.endpoint, 'l-bob:1');
        node.assert.ok(row(admitted.state, 'l-bob:1'));
        node.assert.strictEqual(domain.call.calls.get(id).lobby.size, 0);
        await enter(cam, id, 'l-cam:1');
        isCode(
          await domain.call.deny(bob, { call: id, endpoint: 'l-cam:1' }),
          'call/admin-only',
        );
        node.assert.strictEqual(
          await domain.call.deny(ada, { call: id, endpoint: 'l-cam:1' }),
          true,
        );
      } finally {
        await done(clients);
      }
    });

    await t.test('A full call rejects a join and accepts a knock', async () => {
      const clients = [];
      const restore = patch({ maxParticipants: 2 });
      try {
        const ada = person(clients, 'f-ada');
        const bob = person(clients, 'f-bob');
        const cam = person(clients, 'f-cam');
        const opened = await begin(ada, 'full', 'f-ada:1');
        const id = opened.state.call;
        const joined = await enter(bob, id, 'f-bob:1', {
          token: opened.token,
        });
        node.assert.strictEqual(joined.status, 'joined');
        isCode(await enter(ada, id, 'f-ada:2'), 'call/full');
        const knock = await enter(cam, id, 'f-cam:1');
        node.assert.strictEqual(knock.status, 'lobby');
        node.assert.strictEqual(domain.call.calls.get(id).participants.size, 2);
        isCode(
          await domain.call.admit(ada, { call: id, endpoint: 'f-cam:1' }),
          'call/full',
        );
        node.assert.strictEqual(domain.call.calls.get(id).lobby.size, 1);
      } finally {
        restore();
        await done(clients);
      }
    });

    await t.test('Camera and screen limits', async () => {
      const clients = [];
      const restore = patch({ maxCameras: 1, maxScreens: 1 });
      try {
        const ada = person(clients, 'c-ada');
        const bob = person(clients, 'c-bob');
        const opened = await begin(ada, 'media', 'c-ada:1', {
          policy: 'open',
        });
        const id = opened.state.call;
        await enter(bob, id, 'c-bob:1');
        node.assert.strictEqual(
          await domain.call.update(ada, {
            call: id,
            endpoint: 'c-ada:1',
            camera: true,
          }),
          true,
        );
        isCode(
          await domain.call.update(bob, {
            call: id,
            endpoint: 'c-bob:1',
            camera: true,
          }),
          'call/limit',
        );
        const guest = domain.call.calls.get(id).participants.get('c-bob:1');
        node.assert.strictEqual(guest.camera, false);
        node.assert.strictEqual(
          await domain.call.update(ada, {
            call: id,
            endpoint: 'c-ada:1',
            camera: true,
          }),
          true,
        );
        node.assert.strictEqual(
          await domain.call.update(bob, {
            call: id,
            endpoint: 'c-bob:1',
            screen: true,
          }),
          true,
        );
        isCode(
          await domain.call.update(ada, {
            call: id,
            endpoint: 'c-ada:1',
            screen: true,
          }),
          'call/limit',
        );
        node.assert.strictEqual(
          await domain.call.update(bob, {
            call: id,
            endpoint: 'c-bob:1',
            title: 'x'.repeat(60),
            hand: true,
          }),
          true,
        );
        node.assert.strictEqual(guest.title.length, 48);
        node.assert.ok(guest.hand > 0);
      } finally {
        restore();
        await done(clients);
      }
    });

    await t.test('Signal and update rates', async () => {
      const clients = [];
      const restore = patch({ signalRate: 0, updateRate: 0 });
      try {
        const ada = person(clients, 'r-ada');
        const bob = person(clients, 'r-bob');
        const opened = await begin(ada, 'rates', 'r-ada:1', {
          policy: 'open',
        });
        const id = opened.state.call;
        await enter(bob, id, 'r-bob:1');
        isCode(
          await domain.call.update(ada, {
            call: id,
            endpoint: 'r-ada:9',
            mic: true,
          }),
          'call/not-joined',
        );
        let updates = 0;
        for (let i = 0; i < 10; i++) {
          const result = await domain.call.update(ada, {
            call: id,
            endpoint: 'r-ada:1',
            mic: i % 2 === 0,
          });
          if (result === true) updates += 1;
        }
        node.assert.strictEqual(updates, 10);
        isCode(
          await domain.call.update(ada, {
            call: id,
            endpoint: 'r-ada:1',
            mic: true,
          }),
          'call/rate',
        );
        const message = { source: 'r-ada:1', target: 'r-bob:1' };
        let signals = 0;
        for (let i = 0; i < 200; i++) {
          const result = domain.call.signal(ada, {
            call: id,
            from: 'r-ada:1',
            to: 'r-bob:1',
            message,
          });
          if (result === true) signals += 1;
        }
        node.assert.strictEqual(signals, 200);
        isCode(
          domain.call.signal(ada, {
            call: id,
            from: 'r-ada:1',
            to: 'r-bob:1',
            message,
          }),
          'call/rate',
        );
      } finally {
        restore();
        await done(clients);
      }
    });

    await t.test('Signal envelope is rejected', async () => {
      const clients = [];
      try {
        const ada = person(clients, 'g-ada');
        const bob = person(clients, 'g-bob');
        const opened = await begin(ada, 'wire', 'g-ada:1', {
          policy: 'open',
        });
        const id = opened.state.call;
        await enter(bob, id, 'g-bob:1');
        const message = {
          protocol: 'metacom:rtc',
          source: 'g-ada:1',
          target: 'g-bob:1',
          description: { type: 'offer', sdp: 'v=0' },
        };
        bob.events.length = 0;
        node.assert.strictEqual(
          domain.call.signal(ada, {
            call: id,
            from: 'g-ada:1',
            to: 'g-bob:1',
            message,
          }),
          true,
        );
        node.assert.deepStrictEqual(last(bob, 'call/signal').data, {
          call: id,
          from: 'g-ada:1',
          to: 'g-bob:1',
          message,
        });
        isCode(
          domain.call.signal(ada, {
            call: id,
            from: 'g-ada:1',
            to: 'g-bob:1',
            message: { source: 'g-bob:1', target: 'g-bob:1' },
          }),
          'call/forbidden',
        );
        isCode(
          domain.call.signal(ada, {
            call: id,
            from: 'g-ada:1',
            to: 'g-bob:1',
            message: { source: 'g-ada:1', target: 'g-ada:1' },
          }),
          'call/forbidden',
        );
        isCode(
          domain.call.signal(ada, {
            call: id,
            from: 'g-ada:1',
            to: 'g-bob:1',
            message: {
              source: 'g-ada:1',
              target: 'g-bob:1',
              blob: 'x'.repeat(70000),
            },
          }),
          'call/forbidden',
        );
        isCode(
          domain.call.signal(ada, {
            call: id,
            from: 'g-ada:1',
            to: 'g-bob:missing',
            message: {
              source: 'g-ada:1',
              target: 'g-bob:missing',
            },
          }),
          'call/not-joined',
        );
        isCode(
          domain.call.signal(ada, {
            call: id,
            from: 'g-bob:1',
            to: 'g-ada:1',
            message: { source: 'g-bob:1', target: 'g-ada:1' },
          }),
          'call/forbidden',
        );
        isCode(
          domain.call.signal(bob, {
            call: id,
            from: 'g-bob:9',
            to: 'g-ada:1',
            message: { source: 'g-bob:9', target: 'g-ada:1' },
          }),
          'call/not-joined',
        );
      } finally {
        await done(clients);
      }
    });

    await t.test('Liveness sweep drops silent endpoints', async () => {
      const clients = [];
      const restore = patch({ timeoutMs: 1000 });
      try {
        const ada = person(clients, 'v-ada');
        const bob = person(clients, 'v-bob');
        const opened = await begin(ada, 'live', 'v-ada:1', {
          policy: 'open',
        });
        const id = opened.state.call;
        await enter(bob, id, 'v-bob:1');
        isCode(
          domain.call.ping(ada, { call: id, endpoint: 'v-ada:9' }),
          'call/not-joined',
        );
        node.assert.strictEqual(
          domain.call.ping(ada, { call: id, endpoint: 'v-ada:1' }),
          true,
        );
        await domain.call.sweep();
        node.assert.strictEqual(domain.call.calls.get(id).participants.size, 2);
        const state = domain.call.calls.get(id);
        state.participants.get('v-bob:1').seen = Date.now() - 1001;
        await domain.call.sweep();
        node.assert.strictEqual(state.participants.has('v-bob:1'), false);
        node.assert.strictEqual(state.participants.has('v-ada:1'), true);
        node.assert.strictEqual(domain.call.calls.has(id), true);
        state.participants.get('v-ada:1').seen = Date.now() - 1001;
        await domain.call.sweep();
        node.assert.strictEqual(domain.call.calls.has(id), false);
        node.assert.strictEqual(last(ada, 'call/ended').data.by, '');
      } finally {
        restore();
        await done(clients);
      }
    });

    await t.test('Client close drops endpoints and knocks', async () => {
      const clients = [];
      try {
        const ada = person(clients, 'x-ada');
        const bob = person(clients, 'x-bob');
        const opened = await begin(ada, 'close', 'x-ada:1');
        const id = opened.state.call;
        await enter(bob, id, 'x-bob:1');
        node.assert.strictEqual(domain.call.calls.get(id).lobby.size, 1);
        bob.close();
        await domain.call.drop(bob);
        node.assert.strictEqual(domain.call.calls.get(id).lobby.size, 0);
        node.assert.strictEqual(domain.call.endpoints.has('x-bob:1'), false);
        node.assert.strictEqual(domain.call.calls.has(id), true);
        ada.close();
        await domain.call.drop(ada);
        node.assert.strictEqual(domain.call.calls.has(id), false);
        node.assert.strictEqual(domain.call.endpoints.has('x-ada:1'), false);
      } finally {
        await done(clients);
      }
    });

    await t.test('Resume recreates a lost call', async () => {
      const clients = [];
      let restore = null;
      try {
        const ada = person(clients, 'u-ada');
        const bob = person(clients, 'u-bob');
        const cam = person(clients, 'u-cam');
        const opened = await begin(ada, 'room', 'u-ada:1', {
          policy: 'open',
        });
        const id = opened.state.call;
        const started = opened.state.started;
        const token = opened.token;
        crash();
        isCode(
          await enter(cam, id, 'u-cam:1', {
            resume: true,
            chat: 'room',
            host: 'u-ada',
            started,
          }),
          'call/not-found',
        );
        isCode(
          await enter(ada, id, 'u-ada:1', { resume: true }),
          'call/not-found',
        );
        const restored = await enter(ada, id, 'u-ada:1', {
          resume: true,
          chat: 'room',
          host: 'u-ada',
          started,
        });
        node.assert.strictEqual(restored.status, 'joined');
        node.assert.strictEqual(restored.state.call, id);
        node.assert.strictEqual(restored.state.host, 'u-ada');
        node.assert.strictEqual(restored.state.policy, 'link');
        node.assert.strictEqual(restored.state.started, started);
        const linked = await domain.call.link(ada, { call: id });
        node.assert.notStrictEqual(linked.token, token);
        const direct = await begin(ada, 'u-ada_u-bob', 'u-ada:2', {
          nick: 'ada',
        });
        const directId = direct.state.call;
        const directStarted = direct.state.started;
        crash();
        const bobBack = await enter(bob, directId, 'u-bob:1', {
          resume: true,
          chat: 'u-ada_u-bob',
          host: 'u-ada',
          started: directStarted,
          nick: 'bob',
        });
        node.assert.strictEqual(bobBack.status, 'joined');
        node.assert.strictEqual(bobBack.state.kind, 'direct');
        node.assert.strictEqual(bobBack.state.host, 'u-ada');
        restore = ownedBy('u-cam');
        const secret = await begin(ada, 'secret', 'u-ada:3');
        const secretId = secret.state.call;
        const secretStarted = secret.state.started;
        crash();
        const camBack = await enter(cam, secretId, 'u-cam:1', {
          resume: true,
          chat: 'secret',
          host: 'u-ada',
          started: secretStarted,
        });
        node.assert.strictEqual(camBack.status, 'joined');
        node.assert.strictEqual(domain.call.calls.get(secretId).host, 'u-ada');
      } finally {
        if (restore) restore();
        await done(clients);
      }
    });

    await t.test('Direct calls ring, decline, and time out', async () => {
      const clients = [];
      const restore = patch({ ringMs: 40 });
      try {
        const ada = person(clients, 'd-ada');
        const bob = person(clients, 'd-bob');
        const zoe = person(clients, 'd-zoe');
        const chat = 'd-ada_d-bob';
        isCode(await begin(zoe, chat, 'd-zoe:1'), 'call/forbidden');
        ada.events.length = 0;
        bob.events.length = 0;
        const declined = await begin(ada, chat, 'd-ada:1', { nick: 'ada' });
        const declinedId = declined.state.call;
        node.assert.deepStrictEqual(last(bob, 'call/ring').data, {
          call: declinedId,
          chat,
          from: { peer: 'd-ada', nick: 'ada' },
        });
        node.assert.strictEqual(
          await domain.call.decline(bob, { call: declinedId }),
          true,
        );
        node.assert.deepStrictEqual(last(ada, 'call/ringing').data, {
          call: declinedId,
          state: 'declined',
        });
        node.assert.strictEqual(domain.call.calls.has(declinedId), false);
        ada.events.length = 0;
        const missed = await begin(ada, chat, 'd-ada:1', { nick: 'ada' });
        const missedId = missed.state.call;
        await wait(150);
        node.assert.deepStrictEqual(last(ada, 'call/ringing').data, {
          call: missedId,
          state: 'missed',
        });
        node.assert.strictEqual(domain.call.calls.has(missedId), false);
        ada.events.length = 0;
        const opened = await begin(ada, chat, 'd-ada:1', { nick: 'ada' });
        const id = opened.state.call;
        const joined = await enter(bob, id, 'd-bob:1');
        node.assert.strictEqual(joined.status, 'joined');
        node.assert.strictEqual(domain.call.calls.get(id).lobby.size, 0);
        await wait(150);
        node.assert.strictEqual(named(ada, 'call/ringing').length, 0);
        node.assert.strictEqual(domain.call.calls.has(id), true);
        isCode(await enter(zoe, id, 'd-zoe:1'), 'call/forbidden');
      } finally {
        restore();
        await done(clients);
      }
    });

    await t.test('Host mute, remove, lock, policy, and spotlight', async () => {
      const clients = [];
      try {
        const ada = person(clients, 'h-ada');
        const bob = person(clients, 'h-bob');
        const cam = person(clients, 'h-cam');
        const zoe = person(clients, 'h-zoe');
        const opened = await begin(ada, 'studio', 'h-ada:1', {
          policy: 'open',
        });
        const id = opened.state.call;
        await enter(bob, id, 'h-bob:1');
        isCode(
          await domain.call.host(bob, { call: id, action: 'lock' }),
          'call/admin-only',
        );
        await domain.call.update(bob, {
          call: id,
          endpoint: 'h-bob:1',
          mic: true,
          hand: true,
        });
        bob.events.length = 0;
        node.assert.strictEqual(
          await domain.call.host(ada, {
            call: id,
            action: 'mute',
            target: 'h-bob:1',
          }),
          true,
        );
        node.assert.deepStrictEqual(last(bob, 'call/request').data, {
          call: id,
          endpoint: 'h-bob:1',
          action: 'mute',
          by: 'h-ada',
        });
        const guest = domain.call.calls.get(id).participants.get('h-bob:1');
        node.assert.strictEqual(guest.mic, true);
        node.assert.strictEqual(
          await domain.call.host(ada, {
            call: id,
            action: 'lowerHand',
            target: 'h-bob:1',
          }),
          true,
        );
        node.assert.strictEqual(guest.hand, 0);
        await domain.call.host(ada, {
          call: id,
          action: 'promote',
          target: 'h-bob:1',
        });
        const promoted = row(last(bob, 'call/state').data, 'h-bob:1');
        node.assert.strictEqual(promoted.admin, true);
        await domain.call.host(ada, {
          call: id,
          action: 'demote',
          target: 'h-bob:1',
        });
        node.assert.strictEqual(
          row(last(bob, 'call/state').data, 'h-bob:1').admin,
          false,
        );
        node.assert.strictEqual(
          await domain.call.host(ada, {
            call: id,
            action: 'remove',
            target: 'h-bob:1',
          }),
          true,
        );
        node.assert.deepStrictEqual(last(bob, 'call/removed').data, {
          call: id,
          endpoint: 'h-bob:1',
          by: 'h-ada',
        });
        node.assert.strictEqual(
          domain.call.calls.get(id).participants.has('h-bob:1'),
          false,
        );
        await domain.call.host(ada, { call: id, action: 'lock' });
        isCode(await enter(cam, id, 'h-cam:1'), 'call/locked');
        node.assert.strictEqual(domain.call.calls.get(id).lobby.size, 0);
        await domain.call.host(ada, { call: id, action: 'unlock' });
        isCode(
          await domain.call.host(ada, {
            call: id,
            action: 'policy',
            value: 'nope',
          }),
          'call/bad-action',
        );
        await domain.call.host(ada, {
          call: id,
          action: 'policy',
          value: 'link',
        });
        node.assert.strictEqual(
          (await enter(cam, id, 'h-cam:1')).status,
          'lobby',
        );
        await domain.call.host(ada, {
          call: id,
          action: 'policy',
          value: 'open',
        });
        node.assert.strictEqual(
          (await enter(cam, id, 'h-cam:1')).status,
          'joined',
        );
        isCode(
          await domain.call.host(ada, {
            call: id,
            action: 'spotlight',
            value: 'missing',
          }),
          'call/bad-action',
        );
        await domain.call.host(ada, {
          call: id,
          action: 'spotlight',
          value: 'h-cam:1',
        });
        const spotlight = last(ada, 'call/state').data.spotlight;
        node.assert.strictEqual(spotlight, 'h-cam:1');
        await domain.call.host(ada, {
          call: id,
          action: 'spotlight',
          value: '',
        });
        node.assert.strictEqual(last(ada, 'call/state').data.spotlight, '');
        isCode(
          await domain.call.host(ada, { call: id, action: 'dance' }),
          'call/bad-action',
        );
        const rotated = await domain.call.link(ada, {
          call: id,
          rotate: true,
        });
        node.assert.notStrictEqual(rotated.token, opened.token);
        isCode(await domain.call.link(bob, { call: id }), 'call/admin-only');
        await domain.call.host(ada, {
          call: id,
          action: 'policy',
          value: 'link',
        });
        node.assert.strictEqual(
          (await enter(zoe, id, 'h-zoe:1', { token: opened.token })).status,
          'lobby',
        );
        node.assert.strictEqual(
          (await enter(zoe, id, 'h-zoe:2', { token: rotated.token })).status,
          'joined',
        );
      } finally {
        await done(clients);
      }
    });

    await t.test('Hands are raised, ordered, and lowered', async () => {
      const clients = [];
      try {
        const ada = person(clients, 'r-ada');
        const bob = person(clients, 'r-bob');
        const cam = person(clients, 'r-cam');
        const opened = await begin(ada, 'hands', 'r-ada:1', {
          policy: 'open',
        });
        const id = opened.state.call;
        await enter(bob, id, 'r-bob:1');
        await enter(cam, id, 'r-cam:1');
        const raise = (client, endpoint, hand) =>
          domain.call.update(client, { call: id, endpoint, hand });
        const hands = () => {
          const state = last(ada, 'call/state').data;
          const raised = state.participants.filter((item) => item.hand > 0);
          raised.sort((a, b) => a.hand - b.hand);
          return raised.map((item) => item.endpoint);
        };
        node.assert.strictEqual(await raise(cam, 'r-cam:1', true), true);
        await wait(5);
        await raise(bob, 'r-bob:1', true);
        await wait(5);
        await raise(ada, 'r-ada:1', true);
        node.assert.deepStrictEqual(hands(), ['r-cam:1', 'r-bob:1', 'r-ada:1']);
        const stored = domain.call.calls.get(id).participants.get('r-cam:1');
        const first = stored.hand;
        await wait(5);
        await raise(cam, 'r-cam:1', true);
        node.assert.strictEqual(stored.hand, first);
        node.assert.strictEqual(await raise(bob, 'r-bob:1', false), true);
        node.assert.deepStrictEqual(hands(), ['r-cam:1', 'r-ada:1']);
        isCode(
          await domain.call.host(bob, {
            call: id,
            action: 'lowerHand',
            target: 'r-cam:1',
          }),
          'call/admin-only',
        );
        node.assert.ok(stored.hand > 0);
        isCode(await raise(bob, 'r-cam:1', false), 'call/forbidden');
        node.assert.ok(stored.hand > 0);
        await domain.call.host(ada, {
          call: id,
          action: 'lowerHand',
          target: 'r-cam:1',
        });
        node.assert.strictEqual(stored.hand, 0);
        node.assert.deepStrictEqual(hands(), ['r-ada:1']);
        await raise(cam, 'r-cam:1', true);
        await domain.call.host(ada, { call: id, action: 'lowerHands' });
        node.assert.deepStrictEqual(hands(), []);
        const seen = last(cam, 'call/state').data;
        node.assert.strictEqual(row(seen, 'r-cam:1').hand, 0);
      } finally {
        await done(clients);
      }
    });

    await t.test('Co-host can act and cannot demote the host', async () => {
      const clients = [];
      let restore = null;
      try {
        const ada = person(clients, 'c-ada');
        const bob = person(clients, 'c-bob');
        const cam = person(clients, 'c-cam');
        const zoe = person(clients, 'c-zoe');
        const owner = person(clients, 'c-own');
        const gus = person(clients, 'c-gus');
        restore = ownedBy('c-own');
        const opened = await begin(ada, 'roles', 'c-ada:1', {
          policy: 'open',
        });
        const id = opened.state.call;
        await enter(bob, id, 'c-bob:1');
        await enter(cam, id, 'c-cam:1');
        await enter(zoe, id, 'c-zoe:1');
        await enter(owner, id, 'c-own:1');
        isCode(
          await domain.call.host(bob, {
            call: id,
            action: 'mute',
            target: 'c-cam:1',
          }),
          'call/admin-only',
        );
        await domain.call.host(ada, {
          call: id,
          action: 'promote',
          target: 'c-bob:1',
        });
        node.assert.strictEqual(
          await domain.call.host(bob, {
            call: id,
            action: 'mute',
            target: 'c-cam:1',
          }),
          true,
        );
        node.assert.strictEqual(last(cam, 'call/request').data.by, 'c-bob');
        isCode(
          await domain.call.host(bob, {
            call: id,
            action: 'demote',
            target: 'c-ada:1',
          }),
          'call/bad-action',
        );
        node.assert.strictEqual(domain.call.calls.get(id).host, 'c-ada');
        const hostRow = row(last(ada, 'call/state').data, 'c-ada:1');
        node.assert.strictEqual(hostRow.admin, true);
        await domain.call.host(ada, {
          call: id,
          action: 'promote',
          target: 'c-cam:1',
        });
        await domain.call.host(bob, {
          call: id,
          action: 'demote',
          target: 'c-cam:1',
        });
        const demoted = row(last(cam, 'call/state').data, 'c-cam:1');
        node.assert.strictEqual(demoted.admin, false);
        const guest = domain.call.calls.get(id).participants.get('c-cam:1');
        guest.mic = true;
        await domain.call.host(bob, {
          call: id,
          action: 'unmute',
          target: 'c-cam:1',
        });
        node.assert.strictEqual(guest.mic, true);
        const asked = last(cam, 'call/request').data.action;
        node.assert.strictEqual(asked, 'unmute');
        ada.events.length = 0;
        bob.events.length = 0;
        cam.events.length = 0;
        zoe.events.length = 0;
        owner.events.length = 0;
        await domain.call.host(bob, { call: id, action: 'muteAll' });
        node.assert.strictEqual(named(ada, 'call/request').length, 0);
        node.assert.strictEqual(named(bob, 'call/request').length, 0);
        node.assert.strictEqual(named(owner, 'call/request').length, 0);
        node.assert.strictEqual(named(cam, 'call/request').length, 1);
        node.assert.strictEqual(named(zoe, 'call/request').length, 1);
        node.assert.strictEqual(last(cam, 'call/request').data.action, 'mute');
        await domain.call.host(ada, {
          call: id,
          action: 'policy',
          value: 'approval',
        });
        const waiting = await enter(gus, id, 'c-gus:1');
        node.assert.strictEqual(waiting.status, 'lobby');
        await domain.call.admit(bob, { call: id, endpoint: 'c-gus:1' });
        const joined = domain.call.calls.get(id).participants.has('c-gus:1');
        node.assert.strictEqual(joined, true);
      } finally {
        if (restore) restore();
        await done(clients);
      }
    });
  },
});
