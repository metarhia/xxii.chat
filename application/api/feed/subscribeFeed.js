({
  access: 'public',
  method: async ({ feedId, userId }) => {
    const delta = await domain.feed.subscribeFeed({ feedId, userId });
    return delta;
  },
});
