({
  access: 'public',

  method: async (args) => db.globalstorage.service.api.pull(args),
});
