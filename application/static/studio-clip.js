const release = (media) => {
  media.pause();
  media.removeAttribute('src');
  media.load();
};

class StudioClip {
  #url = '';
  #ended = null;
  #failed = null;

  constructor(asset, mode, blob, ended, failed) {
    this.id = `clip/${asset.checksum}`;
    this.checksum = asset.checksum;
    this.name = asset.name;
    this.mode = mode;
    this.media = null;
    this.#url = URL.createObjectURL(blob);
    this.#ended = ended;
    this.#failed = failed;
  }

  preview(media = this.media) {
    if (!this.#url || this.media !== media) return;
    if (media?.ended) {
      this.#ended();
    } else {
      this.#play();
    }
  }

  route(attach) {
    return this.#play(attach);
  }

  stop() {
    const media = this.media;
    this.media = null;
    if (media) release(media);
    URL.revokeObjectURL(this.#url);
    this.#url = '';
  }

  #play(attach) {
    const previous = this.media;
    const position = previous?.currentTime ?? 0;
    const media = document.createElement('video');
    media.playsInline = true;
    media.muted = !attach;
    const route = attach?.(media);
    this.media = media;
    if (previous) release(previous);
    media.addEventListener('ended', () => {
      if (this.media === media) this.#ended();
    });
    const fail = (error) => {
      if (this.media === media) this.#failed(error);
    };
    media.addEventListener('error', () =>
      fail(new Error('Unsupported or unreadable video')),
    );
    media.src = this.#url;
    if (position > 0) media.currentTime = position;
    media.play().catch(fail);
    return route;
  }
}

export { StudioClip };
