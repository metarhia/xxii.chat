({
  access: 'public',
  method: async ({ name, ownerId }) => {
    const delta = await domain.feed.createFeed({ name, ownerId });
    return delta;
  },
});
