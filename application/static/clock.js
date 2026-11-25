const CLOCK_URL = new URL('./clock-worker.js', import.meta.url);

const createClock = (fps) => {
  const worker = new Worker(CLOCK_URL);
  worker.postMessage({ type: 'start', fps });
  return worker;
};

const tickOn = (shared, fps, onTick) => {
  const worker = shared ?? createClock(fps);
  const listener = ({ data }) => {
    if (data.type === 'tick') onTick();
  };
  worker.addEventListener('message', listener);
  return () => {
    worker.removeEventListener('message', listener);
    if (!shared) worker.terminate();
  };
};

export { createClock, tickOn };
