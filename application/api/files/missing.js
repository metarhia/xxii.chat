({
  access: 'public',

  method: async ({ checksums }) => domain.files.missing(checksums),
});
