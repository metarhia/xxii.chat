async () => {
  const { replica, service } = db.globalstorage;
  if (!replica) return;
  service.close();
  await replica.save();
};
