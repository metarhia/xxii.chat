({
  name: 'Presence test',
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

    const rtc = (source, target) => ({
      protocol: 'metacom:rtc',
      source,
      target,
    });

    await t.test('Peers announce and see each other', async () => {
      const ada = createClient();
      const bob = createClient();
      domain.presence.announce(ada, { peer: 'p-ada', nick: 'ada' });
      const list = domain.presence.announce(bob, {
        peer: 'p-bob',
        nick: 'bob',
      });
      const peers = list.map(({ peer, status }) => `${peer}:${status}`);
      node.assert.ok(peers.includes('p-ada:online'));
      node.assert.ok(peers.includes('p-bob:online'));
      const update = ada.events.at(-1);
      node.assert.strictEqual(update.name, 'presence/update');
      bob.close();
      const entry = domain.presence.peers.get('p-bob');
      node.assert.strictEqual(entry.status, 'offline');
      ada.close();
    });

    await t.test('Signaling goes only to the target peer', async () => {
      const ada = createClient();
      const bob = createClient();
      domain.presence.announce(ada, { peer: 'p-ada', nick: 'ada' });
      domain.presence.announce(bob, { peer: 'p-bob', nick: 'bob' });
      ada.events.length = 0;
      bob.events.length = 0;
      const message = rtc('p-ada', 'p-bob');
      node.assert.strictEqual(domain.presence.signal(ada, message), true);
      node.assert.deepStrictEqual(bob.events, [
        { name: 'signal/message', data: message },
      ]);
      node.assert.deepStrictEqual(ada.events, []);
      const spoofed = rtc('p-bob', 'p-ada');
      node.assert.strictEqual(domain.presence.signal(ada, spoofed), false);
      const missing = rtc('p-ada', 'p-none');
      node.assert.strictEqual(domain.presence.signal(ada, missing), false);
      ada.close();
      bob.close();
    });
  },
});
