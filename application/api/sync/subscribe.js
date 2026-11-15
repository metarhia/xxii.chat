({
  access: 'public',

  method: async (args) => db.globalstorage.service.api.subscribe(args, context),
});
