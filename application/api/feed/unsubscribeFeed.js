({
  access: 'public',
  method: async ({ feedId, userId }) => {
    const delta = await domain.feed.unsubscribeFeed({ feedId, userId });
    return delta;
  },
});
