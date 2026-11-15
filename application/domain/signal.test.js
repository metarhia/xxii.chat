({
  name: 'Signal test',
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

    await t.test('Peers in a room receive messages of others', async () => {
      const host = createClient();
      const guest = createClient();
      node.assert.strictEqual(domain.signal.join('test', host), true);
      node.assert.strictEqual(domain.signal.join('test', guest), true);
      const message = { protocol: 'metacom:rtc', source: 'guest' };
      domain.signal.publish('test', message, guest);
      const expected = [{ name: 'signal/message', data: message }];
      node.assert.deepStrictEqual(host.events, expected);
      node.assert.deepStrictEqual(guest.events, []);
      host.close();
      guest.close();
      node.assert.strictEqual(domain.signal.rooms.has('test'), false);
    });

    await t.test('Only RTC signaling messages are relayed', async () => {
      const client = createClient();
      domain.signal.join('test', client);
      const result = domain.signal.publish('test', { text: 'hi' }, client);
      node.assert.strictEqual(result, false);
      client.close();
    });
  },
});
