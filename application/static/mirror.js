import { tickOn } from './clock.js';

const FPS = 30;
const START_MS = 5000;
const MIRROR_URL = new URL('./mirror-worker.js', import.meta.url);

const capabilitiesOf = (scope = globalThis) => ({
  processor: typeof scope.MediaStreamTrackProcessor === 'function',
  generator:
    typeof scope.MediaStreamTrackGenerator === 'function' ||
    typeof scope.VideoTrackGenerator === 'function',
});

const pathOf = (capabilities, requested = 'auto') => {
  if (requested === 'canvas') return 'canvas';
  const available = capabilities.processor && capabilities.generator;
  if (requested === 'processor') return available ? 'processor' : '';
  return available ? 'processor' : 'canvas';
};

const withTimeout = (promise, message) => {
  let timer = 0;
  const timeout = new Promise((resolve, reject) => {
    timer = setTimeout(() => reject(new Error(message)), START_MS);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
};

const messageOf = (worker, type) =>
  new Promise((resolve, reject) => {
    const listeners = {};
    const done = (settle, value) => {
      worker.removeEventListener('message', listeners.message);
      worker.removeEventListener('error', listeners.error);
      settle(value);
    };
    listeners.message = ({ data }) => {
      if (data.type === type) done(resolve, data);
      else if (data.type === 'ended') done(reject, new Error(data.error));
    };
    listeners.error = (event) => done(reject, new Error(event.message));
    worker.addEventListener('message', listeners.message);
    worker.addEventListener('error', listeners.error);
  });

const startProcessor = async (track) => {
  const worker = new Worker(MIRROR_URL);
  try {
    const processor = new MediaStreamTrackProcessor({ track });
    const readable = processor.readable;
    const ready = messageOf(worker, 'ready');
    ready.catch(() => {});
    let output = null;
    if (typeof MediaStreamTrackGenerator === 'function') {
      output = new MediaStreamTrackGenerator({ kind: 'video' });
      const writable = output.writable;
      const message = { type: 'start', readable, writable };
      worker.postMessage(message, [readable, writable]);
    } else {
      const received = messageOf(worker, 'track');
      worker.postMessage({ type: 'start', readable }, [readable]);
      const data = await withTimeout(received, 'Mirror worker has no track');
      output = data.track;
    }
    await withTimeout(ready, 'Mirror worker produced no frame');
    const stop = () => {
      worker.postMessage({ type: 'stop' });
      worker.terminate();
    };
    return { output, stop };
  } catch (error) {
    worker.terminate();
    throw error;
  }
};

const waitFrame = (video) =>
  new Promise((resolve, reject) => {
    if (video.readyState >= 2) {
      resolve();
      return;
    }
    video.addEventListener('loadeddata', () => resolve(), { once: true });
    video.addEventListener('error', () => reject(new Error('Video error')), {
      once: true,
    });
  });

const startCanvas = async (track, clock) => {
  const video = document.createElement('video');
  video.muted = true;
  video.playsInline = true;
  video.srcObject = new MediaStream([track]);
  const canvas = document.createElement('canvas');
  const context = canvas.getContext('2d');
  const stopVideo = () => {
    video.pause();
    video.srcObject = null;
  };
  const draw = () => {
    const width = video.videoWidth;
    const height = video.videoHeight;
    if (video.readyState < 2 || !width || !height) return;
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
    }
    context.setTransform(-1, 0, 0, 1, width, 0);
    context.drawImage(video, 0, 0, width, height);
  };
  try {
    await video.play();
    await withTimeout(waitFrame(video), 'Camera produced no frame');
  } catch (error) {
    stopVideo();
    throw error;
  }
  draw();
  const output = canvas.captureStream().getVideoTracks()[0];
  const untick = tickOn(clock, FPS, draw);
  const stop = () => {
    untick();
    stopVideo();
  };
  return { output, stop };
};

const createMirror = async (track, options = {}) => {
  const requested = options.path || 'auto';
  const path = pathOf(capabilitiesOf(), requested);
  if (!path) throw new Error('Mirror path is not available');
  const pipeline = path === 'processor' ? startProcessor : startCanvas;
  const started = await pipeline(track, options.clock);
  const { output, stop: stopPipeline } = started;
  output.contentHint = 'motion';
  const controller = new AbortController();
  const stop = () => {
    if (controller.signal.aborted) return;
    controller.abort();
    stopPipeline();
    output.stop();
  };
  const onEnded = () => {
    stop();
    output.dispatchEvent(new Event('ended'));
  };
  track.addEventListener('ended', onEnded, { signal: controller.signal });
  if (track.readyState === 'ended') onEnded();
  return { track: output, path, stop };
};

export { createMirror, pathOf, capabilitiesOf };
