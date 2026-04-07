({
  access: 'public',
  method: async ({
    feed,
    author,
    title,
    subtitle,
    content,
    status = 'draft',
    attachments = [],
  }) => {
    const delta = await domain.feed.createPost({
      feed,
      author,
      title,
      subtitle,
      content,
      status,
      attachments,
    });
    return delta;
  },
});
