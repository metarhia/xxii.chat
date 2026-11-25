let timer = 0;

const stop = () => {
  clearInterval(timer);
  timer = 0;
};

const start = (fps) => {
  stop();
  const interval = 1000 / fps;
  timer = setInterval(() => self.postMessage({ type: 'tick' }), interval);
};

self.addEventListener('message', ({ data }) => {
  if (data.type === 'start') start(data.fps || 30);
  else if (data.type === 'stop') stop();
});
