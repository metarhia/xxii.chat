const DEFAULT_EDIT_OPTIONS = {
  speed: 1,
  aspect: '',
  framing: 'fit',
  rotation: 0,
  mirror: false,
  cropLeft: 0,
  cropRight: 0,
  cropTop: 0,
  cropBottom: 0,
  resolution: 0,
  quality: 'standard',
  target: 0,
  output: 'video',
};

const QUALITY = { small: 2, standard: 5, high: 9 };
const MB = 1024 * 1024;
const AUDIO_RATE = 128000;

const editOptionsOf = (draft) => ({
  ...DEFAULT_EDIT_OPTIONS,
  ...draft.options,
});

const changedOptions = (options) =>
  Object.keys(DEFAULT_EDIT_OPTIONS).some(
    (key) => options[key] !== DEFAULT_EDIT_OPTIONS[key],
  );

const optionsError = (options) => {
  const { cropLeft, cropRight, cropTop, cropBottom, target } = options;
  const edges = [cropLeft, cropRight, cropTop, cropBottom];
  if (
    edges.some((edge) => !Number.isFinite(edge) || edge < 0 || edge > 95) ||
    cropLeft + cropRight >= 98 ||
    cropTop + cropBottom >= 98
  ) {
    return 'Keep at least 2% of the picture in both directions.';
  }
  if (!Number.isFinite(target) || target < 0) {
    return 'Enter a positive size limit or leave it blank.';
  }
  return '';
};

const sourceFrameOf = (width, height, options) => {
  const { cropLeft, cropRight, cropTop, cropBottom, rotation } = options;
  const x = (width * cropLeft) / 100;
  const y = (height * cropTop) / 100;
  const w = width - x - (width * cropRight) / 100;
  const h = height - y - (height * cropBottom) / 100;
  const swap = rotation % 180 !== 0;
  return { x, y, w, h, width: swap ? h : w, height: swap ? w : h };
};

const even = (length) => Math.max(2, Math.floor(length / 2) * 2);

const outputFrameOf = (part, options) => {
  const frame = sourceFrameOf(part.width, part.height, options);
  let { width, height } = frame;
  const aspect = options.aspect ? options.aspect.split(':').map(Number) : null;
  if (aspect) {
    const [w, h] = aspect;
    const ratio = w / h;
    const fill = options.framing === 'fill';
    const wider = width / height >= ratio;
    const fitHeight = wider === fill;
    if (fitHeight) width = height * ratio;
    else height = width / ratio;
  }
  const limit = options.resolution || Infinity;
  const scale = Math.min(
    1,
    limit / Math.min(width, height),
    (options.aspect ? 3840 : Infinity) / Math.max(width, height),
  );
  if (aspect) {
    const [w, h] = aspect;
    const units = Math.min((width * scale) / w, (height * scale) / h);
    const multiple = even(units + 1e-8);
    return { width: w * multiple, height: h * multiple };
  }
  return { width: even(width * scale), height: even(height * scale) };
};

const drawVideoFrame = (context, video, options) => {
  const { width, height } = context.canvas;
  const frame = sourceFrameOf(video.videoWidth, video.videoHeight, options);
  const xScale = width / frame.width;
  const yScale = height / frame.height;
  const scale =
    options.framing === 'fill'
      ? Math.max(xScale, yScale)
      : Math.min(1, xScale, yScale);
  const w = frame.w * scale;
  const h = frame.h * scale;
  context.fillStyle = '#000';
  context.fillRect(0, 0, width, height);
  context.save();
  context.translate(width / 2, height / 2);
  if (options.mirror) context.scale(-1, 1);
  context.rotate((options.rotation * Math.PI) / 180);
  context.drawImage(
    video,
    frame.x,
    frame.y,
    frame.w,
    frame.h,
    -w / 2,
    -h / 2,
    w,
    h,
  );
  context.restore();
};

const encodingOf = (frame, duration, options, audio) => {
  const { width, height } = frame;
  const { output, quality, target } = options;
  const video = output !== 'audio';
  const preferred = Math.max(
    64000,
    Math.min(18000000, width * height * QUALITY[quality]),
  );
  const maxBytes = target * MB;
  const budget = target
    ? Math.floor((maxBytes * 8000 * 0.93) / duration)
    : Infinity;
  const audioRate = audio
    ? Math.min(
        AUDIO_RATE,
        Math.max(32000, Math.floor(video ? budget / 4 : budget)),
      )
    : 0;
  const videoRate = video ? Math.min(preferred, budget - audioRate) : 0;
  const error =
    (video && videoRate < 64000) || audioRate > budget
      ? 'The size limit is too low for this duration.'
      : '';
  const bytes = Math.ceil(((videoRate + audioRate) * duration) / 8000 / 0.93);
  return { videoRate, audioRate, maxBytes, bytes, error };
};

export { editOptionsOf, changedOptions, optionsError };
export { outputFrameOf, drawVideoFrame, encodingOf };
