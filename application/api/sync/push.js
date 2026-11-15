({
  access: 'public',

  method: async (args) => db.globalstorage.service.api.push(args),
});
