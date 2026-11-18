let canvas = null;
let context = null;
let abort = null;
let ready = false;

const draw = (frame) => {
  const width = frame.displayWidth;
  const height = frame.displayHeight;
  if (!canvas) {
    canvas = new OffscreenCanvas(width, height);
    context = canvas.getContext('2d');
  }
  if (canvas.width !== width || canvas.height !== height) {
    canvas.width = width;
    canvas.height = height;
  }
  context.setTransform(-1, 0, 0, 1, width, 0);
  context.drawImage(frame, 0, 0, width, height);
  const options = { timestamp: frame.timestamp };
  if (frame.duration !== null) options.duration = frame.duration;
  return new VideoFrame(canvas, options);
};

const transform = (frame, controller) => {
  let output = null;
  try {
    output = draw(frame);
    controller.enqueue(output);
    if (!ready) {
      ready = true;
      self.postMessage({ type: 'ready' });
    }
  } catch (error) {
    if (output) output.close();
    throw error;
  } finally {
    frame.close();
  }
};

const start = async ({ readable, writable }) => {
  abort = new AbortController();
  const stream = new TransformStream({ transform });
  const options = { signal: abort.signal };
  try {
    await readable.pipeThrough(stream).pipeTo(writable, options);
    self.postMessage({ type: 'ended' });
  } catch (error) {
    self.postMessage({ type: 'ended', error: error.message });
  }
};

const startGenerator = async ({ readable }) => {
  if (typeof VideoTrackGenerator !== 'function') {
    readable.cancel();
    const error = 'VideoTrackGenerator is not available';
    self.postMessage({ type: 'ended', error });
    return;
  }
  const generator = new VideoTrackGenerator();
  const track = generator.track;
  self.postMessage({ type: 'track', track }, [track]);
  await start({ readable, writable: generator.writable });
};

self.addEventListener('message', ({ data }) => {
  if (data.type === 'start') {
    const run = data.writable ? start : startGenerator;
    run(data);
  } else if (data.type === 'stop') {
    if (abort) abort.abort();
    self.close();
  }
});
