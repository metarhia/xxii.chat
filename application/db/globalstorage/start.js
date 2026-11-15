async () => {
  const { port } = application.server;
  if (!config.server.ports.includes(port)) return;
  const { Replica, SyncService } = npm.globalstorage;
  const root = process.cwd();
  const chatPath = node.path.join(root, 'application/static/chat.js');
  const chat = node.module.createRequire(chatPath)(chatPath);
  const dataPath = process.env.XXII_DATA ?? 'application/data';
  const path = node.path.resolve(root, dataPath, 'chat');
  const replica = new Replica({ path, validate: chat.validate });
  await replica.open();
  replica.on('error', (error) => console.error(error));
  chat.seed(replica);
  const service = new SyncService(replica, { unit: 'sync' });
  db.globalstorage = { replica, service };
};
