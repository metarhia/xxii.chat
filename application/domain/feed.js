({
  async getFeedByName(name) {
    const id = await db.globalstorage.get(`feed:name:${name}`);
    if (!id) return null;
    return await this.getFeed(id);
  },

  async setFeedNameIndex(name, id) {
    await db.globalstorage.set(`feed:name:${name}`, id);
  },

  async getFeed(id) {
    return await db.globalstorage.get(`feed:${id}`);
  },

  async setFeed(feed) {
    await db.globalstorage.set(`feed:${feed.id}`, feed);
  },

  async createFeed({ id, name, ownerId }) {
    const existing = await this.getFeedByName(name);
    if (existing) throw new Error(`Feed ${name} already exists`);

    const feed = {
      id,
      name,
      owner: ownerId,
      members: [],
      createdAt: Date.now(),
    };

    await this.setFeed(feed);
    await this.setFeedNameIndex(name, id);

    return {
      strategy: 'lww',
      entity: 'feed',
      record: feed,
    };
  },

  async subscribeFeed({ feedId, userId }) {
    const feed = await this.getFeed(feedId);
    if (!feed) throw new Error(`Feed ${feedId} not found`);

    // TODO: consider CRDT LWW strategy limitation:
    // concurrent updates to members array may overwrite each other.
    if (!feed.members.includes(userId)) feed.members.push(userId);
    await this.setFeed(feed);

    return {
      strategy: 'lww',
      entity: 'feed',
      record: feed,
    };
  },

  async unsubscribeFeed({ feedId, userId }) {
    const feed = await this.getFeed(feedId);
    if (!feed) throw new Error(`Feed ${feedId} not found`);

    // TODO: consider CRDT LWW strategy limitation:
    // concurrent updates to members array may overwrite each other.
    feed.members = feed.members.filter((id) => id !== userId);
    await this.setFeed(feed);

    return {
      strategy: 'lww',
      entity: 'feed',
      record: feed,
    };
  },

  async setPost(post) {
    await db.globalstorage.set(`post:${post.id}`, post);
    return post;
  },

  async createPost({
    feed,
    author,
    title,
    subtitle,
    content,
    status = 'draft',
    attachments = [],
  }) {
    const id = `${Date.now()}:${Math.random()}`;
    const post = {
      id,
      feed,
      author,
      title,
      subtitle: subtitle || null,
      content,
      created: new Date().toISOString(),
      edited: null,
      published: null,
      deleted: null,
      status,
      reactions: {},
      pinned: false,
      attachments,
    };

    await this.setPost(post);
    return { record: post };
  },
});
