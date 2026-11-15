({
  access: 'public',

  method: async ({ id, checksum }) =>
    domain.files.send(context.client, checksum, id),
});
