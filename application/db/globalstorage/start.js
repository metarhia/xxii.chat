async () => {
  if (application.worker.id === 'W1') {
    console.debug('Open globalstorage');
  }
  const dataPath = node.path.join(process.cwd(), 'application/data');
  db.globalstorage = await npm.globalstorage.open({ path: dataPath });
};
