const MEDIA_TIMEOUT = 12000;
const CHECK_MS = 5;

const waitForMedia = (video, type, signal, action) => {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const listeners = new AbortController();
    const options = { once: true, signal: listeners.signal };
    let timer = null;
    const finish = (error) => {
      clearTimeout(timer);
      listeners.abort();
      if (error) reject(error);
      else resolve();
    };
    timer = setTimeout(
      () => finish(new Error('The recording took too long to load or seek.')),
      MEDIA_TIMEOUT,
    );
    video.addEventListener(type, () => finish(), options);
    video.addEventListener(
      'error',
      () => {
        finish(new Error('The recording could not be decoded.'));
      },
      options,
    );
    signal.addEventListener('abort', () => finish(signal.reason), options);
    try {
      action();
    } catch (error) {
      finish(error);
    }
  });
};

class PartPlayer {
  constructor(video, source) {
    this.video = video;
    this.source = source;
    this.part = null;
    this.url = '';
  }

  async open(part, signal) {
    if (this.part?.index === part.index) return;
    const source = await this.source(part, signal);
    signal.throwIfAborted();
    const video = this.video;
    this.clear();
    const url =
      typeof source === 'string' ? source : URL.createObjectURL(source);
    if (typeof source !== 'string') this.url = url;
    try {
      await waitForMedia(video, 'loadeddata', signal, () => {
        video.src = url;
      });
      this.part = part;
    } catch (error) {
      signal.throwIfAborted();
      this.clear();
      throw error;
    }
  }

  async seek(part, time, signal) {
    await this.open(part, signal);
    signal.throwIfAborted();
    const video = this.video;
    video.pause();
    const target = Math.min(time / 1000, video.duration);
    if (target === video.currentTime && !video.seeking) return;
    await waitForMedia(video, 'seeked', signal, () => {
      video.currentTime = target;
    });
  }

  clear() {
    const video = this.video;
    video.pause();
    video.removeAttribute('src');
    video.load();
    if (this.url) URL.revokeObjectURL(this.url);
    this.url = '';
    this.part = null;
  }
}

const playUntil = async (video, end, signal, onStart, onTime) => {
  signal.throwIfAborted();
  const listeners = new AbortController();
  const options = { once: true, signal: listeners.signal };
  try {
    const pause = () => video.pause();
    signal.addEventListener('abort', pause, options);
    await video.play();
    signal.throwIfAborted();
    onStart?.();
    await new Promise((resolve, reject) => {
      let last = video.currentTime;
      let advancedAt = performance.now();
      let timer = null;
      const finish = (error) => {
        clearInterval(timer);
        if (error) reject(error);
        else resolve();
      };
      const check = () => {
        if (video.currentTime !== last) {
          last = video.currentTime;
          advancedAt = performance.now();
        }
        const time = last * 1000;
        onTime?.(Math.min(end, time));
        if (time >= end || video.ended) return void finish();
        if (performance.now() - advancedAt > MEDIA_TIMEOUT) {
          finish(new Error('Playback stopped advancing.'));
        }
      };
      timer = setInterval(check, CHECK_MS);
      video.addEventListener('ended', check, options);
      video.addEventListener(
        'error',
        () => {
          finish(new Error('The recording could not be played.'));
        },
        options,
      );
      signal.addEventListener('abort', () => finish(signal.reason), options);
      check();
    });
  } catch (error) {
    signal.throwIfAborted();
    throw error;
  } finally {
    listeners.abort();
    video.pause();
  }
};

const readPart = async (player, part, signal) => {
  await player.open(part, signal);
  const video = player.video;
  const { videoWidth: width, videoHeight: height } = video;
  const duration = Math.round(video.duration * 1000);
  if (!width || !height || !Number.isSafeInteger(duration) || duration <= 0) {
    throw new Error(`${part.name || 'The video'} has no playable duration.`);
  }
  const stream = video.captureStream?.();
  const audio = stream ? stream.getAudioTracks().length > 0 : true;
  for (const track of stream?.getTracks() ?? []) track.stop();
  return { ...part, duration, width, height, audio };
};

export { PartPlayer, playUntil, readPart };
