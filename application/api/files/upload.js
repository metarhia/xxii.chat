({
  access: 'public',
  timeout: 120000,

  method: async ({ id, checksum }) => {
    const stream = context.client.getStream(id);
    return domain.files.save(stream, checksum);
  },
});
