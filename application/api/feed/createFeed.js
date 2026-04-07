({
  access: 'public',
  method: async ({ id, name, ownerId }) => {
    const delta = await domain.feed.createFeed({ id, name, ownerId });
    return delta;
  },
});
