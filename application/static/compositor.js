import { REFERENCE_HEIGHT, flagOf, qualityOf, programOf } from './layout.js';
import { drawArgsOf, selectSpeakers } from './layout.js';
import { onScreenOf, layoutProgram } from './layout.js';
import { colorOf, initialsOf } from './avatar.js';
import { idOf } from './members.js';

const CLOCK_URL = new URL('./clock-worker.js', import.meta.url);
const REDUCED_MOTION = '(prefers-reduced-motion: reduce)';
const FONT = '"Fira Code", ui-monospace, "SFMono-Regular", Menlo, monospace';

const SURFACE = '#0f1418';
const PANEL = '#1a242d';
const CHIP = 'rgba(26, 36, 45, 0.88)';
const LIGHT = '#d5d5d5';
const MUTED = '#c5ccc5';
const SPEAKING = '#44d47a';

const MOVE_MS = 250;
const PACE_RATIO = 0.5;
const SMOOTHING = 0.1;

const CHIP_SIZE = 22;
const CHIP_PAD = 8;
const CHIP_RATIO = 0.14;
const CHIP_MIN_HEIGHT = 48;
const RING_WIDTH = 4;
const AVATAR_RATIO = 0.28;
const STATUS_WIDTH_RATIO = 0.1;
const STATUS_HEIGHT_RATIO = 0.14;
const MIN_FONT = 8;

const speechOf = (previous, speaking, now) => {
  if (!speaking) return { spokeAt: previous?.spokeAt ?? 0, speakingSince: 0 };
  const isOngoing = (previous?.speakingSince ?? 0) > 0;
  const since = isOngoing ? previous.speakingSince : now;
  return { spokeAt: now, speakingSince: since };
};

const nextSpeech = (previous, members, now) => {
  const next = new Map();
  for (const member of members) {
    const before = previous.get(member.endpoint);
    next.set(member.endpoint, speechOf(before, member.speaking, now));
  }
  return next;
};

const cameraSource = (member, speech, includeMe) => {
  const heard = speech.get(member.endpoint);
  const isStaged = member.local ? includeMe : true;
  return {
    id: idOf(member.endpoint, 'camera'),
    endpoint: member.endpoint,
    kind: 'camera',
    nick: member.nick,
    hasVideo: member.camera !== null,
    level: member.level,
    spokeAt: heard?.spokeAt ?? 0,
    speakingSince: heard?.speakingSince ?? 0,
    optOut: member.optOut,
    stage: isStaged,
    track: member.optOut ? null : member.camera,
  };
};

const screenSource = (member) => ({
  id: idOf(member.endpoint, 'screen'),
  endpoint: member.endpoint,
  kind: 'screen',
  nick: `${member.nick} · screen`,
  hasVideo: true,
  level: 0,
  spokeAt: 0,
  speakingSince: 0,
  optOut: member.optOut,
  stage: true,
  track: member.optOut ? null : member.screen,
});

const sourcesOf = (members, speech, options) => {
  const includeMe = flagOf(options?.includeMe, true);
  const sources = [];
  for (const member of members) {
    sources.push(cameraSource(member, speech, includeMe));
    if (member.screen) sources.push(screenSource(member));
  }
  return sources;
};

const rectOf = (tile) => ({
  x: tile.x,
  y: tile.y,
  width: tile.width,
  height: tile.height,
});

const isSameRect = (a, b) =>
  a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;

const easeOut = (progress) => 1 - (1 - progress) ** 3;

const rectAt = (entry, now) => {
  const progress = Math.min(1, Math.max(0, (now - entry.start) / MOVE_MS));
  const eased = easeOut(progress);
  const mix = (from, to) => from + (to - from) * eased;
  return {
    x: mix(entry.from.x, entry.to.x),
    y: mix(entry.from.y, entry.to.y),
    width: mix(entry.from.width, entry.to.width),
    height: mix(entry.from.height, entry.to.height),
  };
};

const stepOf = (previous, tile, now, isMoving) => {
  const target = rectOf(tile);
  if (!previous || !isMoving) return { from: target, to: target, start: now };
  if (isSameRect(previous.to, target)) return previous;
  return { from: rectAt(previous, now), to: target, start: now };
};

const moveTiles = (motion, tiles, now, isMoving) => {
  const next = new Map();
  const drawn = [];
  for (const tile of tiles) {
    const entry = stepOf(motion.get(tile.id), tile, now, isMoving);
    next.set(tile.id, entry);
    drawn.push({ ...tile, ...rectAt(entry, now) });
  }
  return { motion: next, drawn };
};

const ellipsize = (measure, text, width) => {
  if (width <= 0) return '';
  if (measure(text) <= width) return text;
  let end = text.length;
  while (end > 0 && measure(`${text.slice(0, end)}…`) > width) end--;
  const result = `${text.slice(0, end)}…`;
  return measure(result) <= width ? result : '';
};

const fontOf = (size, weight = 500) => `${weight} ${size}px ${FONT}`;

const pathOf = (context, box, radius) => {
  context.beginPath();
  if (typeof context.roundRect !== 'function') {
    context.rect(box.x, box.y, box.width, box.height);
    return;
  }
  context.roundRect(box.x, box.y, box.width, box.height, radius);
};

const isReady = (video) =>
  Boolean(video) && video.readyState >= 2 && video.videoWidth > 0;

const createVideo = (track) => {
  const video = document.createElement('video');
  video.muted = true;
  video.playsInline = true;
  video.srcObject = new MediaStream([track]);
  video.play().catch(() => undefined);
  return video;
};

const releaseVideo = (video) => {
  video.pause();
  video.srcObject = null;
};

const paintBackground = (context, background, width, height) => {
  context.fillStyle = SURFACE;
  if (typeof background === 'string') context.fillStyle = background;
  context.fillRect(0, 0, width, height);
  if (typeof background === 'string' || !background) return;
  const sourceWidth = background.naturalWidth || background.width;
  const sourceHeight = background.naturalHeight || background.height;
  if (!sourceWidth || !sourceHeight) return;
  const area = { x: 0, y: 0, width, height };
  const args = drawArgsOf(sourceWidth, sourceHeight, area, 'cover');
  context.drawImage(background, ...args);
};

const paintAvatar = (context, tile, source) => {
  const x = tile.x + tile.width / 2;
  const y = tile.y + tile.height / 2;
  const radius = Math.min(tile.width, tile.height) * AVATAR_RATIO;
  context.fillStyle = colorOf(source.endpoint);
  context.beginPath();
  context.arc(x, y, radius, 0, Math.PI * 2);
  context.fill();
  context.fillStyle = LIGHT;
  context.font = fontOf(Math.round(radius * 0.8));
  context.textAlign = 'center';
  context.textBaseline = 'middle';
  context.fillText(initialsOf(source.nick), x, y);
};

const paintOptedOut = (context, tile) => {
  const byWidth = tile.width * STATUS_WIDTH_RATIO;
  const byHeight = tile.height * STATUS_HEIGHT_RATIO;
  const size = Math.round(Math.min(byWidth, byHeight));
  if (size < MIN_FONT) return;
  context.fillStyle = MUTED;
  context.font = fontOf(size);
  context.textAlign = 'center';
  context.textBaseline = 'middle';
  const x = tile.x + tile.width / 2;
  const y = tile.y + tile.height / 2;
  context.fillText('opted out', x, y, tile.width);
};

const paintName = (context, tile, source, scale) => {
  const pad = Math.round(CHIP_PAD * scale);
  const size = Math.round(Math.min(tile.height * 0.6, CHIP_SIZE * scale));
  if (size < MIN_FONT) return;
  context.font = fontOf(size);
  const measure = (text) => context.measureText(text).width;
  const text = ellipsize(measure, tile.label, tile.width - 2 * pad);
  context.fillStyle = LIGHT;
  context.textAlign = 'left';
  context.textBaseline = 'middle';
  context.fillText(text, tile.x + pad, tile.y + tile.height / 2);
};

const PLACEHOLDERS = {
  avatar: paintAvatar,
  'opted out': paintOptedOut,
  name: paintName,
};

const paintContent = (context, tile, source, video, scale) => {
  const paint = PLACEHOLDERS[tile.placeholder];
  if (paint) return void paint(context, tile, source, scale);
  if (isReady(video)) {
    const { videoWidth, videoHeight } = video;
    const args = drawArgsOf(videoWidth, videoHeight, tile, tile.fit);
    return void context.drawImage(video, ...args);
  }
  if (source.kind === 'camera') paintAvatar(context, tile, source);
};

const paintChip = (context, tile, scale) => {
  const pad = Math.round(CHIP_PAD * scale);
  const limit = tile.height * CHIP_RATIO;
  const size = Math.round(Math.min(CHIP_SIZE * scale, limit));
  if (tile.height < CHIP_MIN_HEIGHT * scale || size < MIN_FONT) return;
  context.font = fontOf(size);
  const measure = (text) => context.measureText(text).width;
  const text = ellipsize(measure, tile.label, tile.width - 4 * pad);
  if (text === '') return;
  const box = {
    x: tile.x + pad,
    y: tile.y + tile.height - pad - (size + pad),
    width: measure(text) + 2 * pad,
    height: size + pad,
  };
  context.fillStyle = CHIP;
  pathOf(context, box, box.height / 4);
  context.fill();
  context.fillStyle = LIGHT;
  context.textAlign = 'left';
  context.textBaseline = 'middle';
  context.fillText(text, box.x + pad, box.y + box.height / 2);
};

const paintRing = (context, tile, scale) => {
  const width = Math.max(2, Math.round(RING_WIDTH * scale));
  const inset = width / 2;
  const box = {
    x: tile.x + inset,
    y: tile.y + inset,
    width: tile.width - width,
    height: tile.height - width,
  };
  context.lineWidth = width;
  context.strokeStyle = SPEAKING;
  pathOf(context, box, Math.max(0, tile.radius - inset));
  context.stroke();
};

const paintTile = (context, tile, source, video, scale) => {
  context.save();
  pathOf(context, tile, tile.radius);
  context.clip();
  context.fillStyle = PANEL;
  context.fillRect(tile.x, tile.y, tile.width, tile.height);
  paintContent(context, tile, source, video, scale);
  context.restore();
  const hasChip = tile.label !== '' && tile.placeholder !== 'name';
  if (hasChip) paintChip(context, tile, scale);
  if (tile.speaking) paintRing(context, tile, scale);
};

class Compositor {
  #members = null;
  #options = null;
  #context = null;
  #shared = null;
  #worker = null;
  #listener = null;
  #motion = new Map();
  #speech = new Map();
  #videos = new Map();
  #held = [];
  #query = null;
  #lastAt = -Infinity;
  #isManual = false;
  #isStopped = false;

  constructor({ members, options, clock = null }) {
    const raw = options?.() ?? {};
    const program = programOf(raw);
    const quality = qualityOf(raw);
    const canvas = document.createElement('canvas');
    canvas.width = program.width;
    canvas.height = program.height;
    this.canvas = canvas;
    this.width = program.width;
    this.height = program.height;
    this.fps = quality.fps;
    this.frames = 0;
    this.drawMs = 0;
    this.error = null;
    this.tiles = [];
    this.onScreen = new Set();
    this.#members = members;
    this.#options = options ?? (() => ({}));
    this.#shared = clock;
    this.#context = canvas.getContext('2d');
    this.#query = globalThis.matchMedia?.(REDUCED_MOTION) ?? null;
    const stream = canvas.captureStream(0);
    this.track = stream.getVideoTracks()[0];
    this.stream = stream;
    this.#isManual = typeof this.track.requestFrame === 'function';
    if (!this.#isManual) {
      this.stream = canvas.captureStream(this.fps);
      this.track = this.stream.getVideoTracks()[0];
    }
  }

  start() {
    if (this.#listener || this.#isStopped) return;
    const worker = this.#shared ?? new Worker(CLOCK_URL);
    this.#worker = worker;
    this.#listener = ({ data }) => {
      if (data.type === 'tick') this.#onTick();
    };
    worker.addEventListener('message', this.#listener);
    if (!this.#shared) worker.postMessage({ type: 'start', fps: this.fps });
    this.draw();
  }

  stop() {
    if (this.#isStopped) return;
    this.#isStopped = true;
    const worker = this.#worker;
    if (worker) worker.removeEventListener('message', this.#listener);
    if (worker && !this.#shared) {
      worker.postMessage({ type: 'stop' });
      worker.terminate();
    }
    for (const entry of this.#videos.values()) releaseVideo(entry.video);
    this.#videos.clear();
    this.#motion.clear();
    this.#speech.clear();
    this.#worker = null;
    this.#listener = null;
    this.track.stop();
  }

  draw() {
    if (this.#isStopped) return;
    const began = performance.now();
    this.#lastAt = began;
    try {
      this.#render(Date.now());
      this.error = null;
    } catch (error) {
      this.error = error;
    }
    const spent = performance.now() - began;
    const smoothed = this.drawMs + (spent - this.drawMs) * SMOOTHING;
    this.drawMs = this.frames === 0 ? spent : smoothed;
    this.frames++;
  }

  #onTick() {
    const interval = 1000 / this.fps;
    const since = performance.now() - this.#lastAt;
    if (since >= interval * PACE_RATIO) this.draw();
  }

  #render(now) {
    const raw = this.#options();
    const options = { ...raw, width: this.width, height: this.height };
    const program = programOf(options);
    const members = this.#members();
    this.#speech = nextSpeech(this.#speech, members, now);
    const sources = sourcesOf(members, this.#speech, options);
    const speakers = selectSpeakers(sources, program, now, this.#held);
    this.#held = speakers;
    const tiles = layoutProgram(program, sources, now, speakers);
    const ids = onScreenOf(program, sources, now, speakers);
    const isMoving = !this.#query?.matches;
    const moved = moveTiles(this.#motion, tiles, now, isMoving);
    this.#motion = moved.motion;
    this.tiles = moved.drawn;
    this.onScreen = new Set(ids);
    this.#syncVideos(sources);
    this.#paint(raw.background, program, sources);
    if (this.#isManual) this.track.requestFrame();
  }

  #paint(background, program, sources) {
    const context = this.#context;
    const scale = program.height / REFERENCE_HEIGHT;
    const byId = new Map(sources.map((source) => [source.id, source]));
    paintBackground(context, background, this.width, this.height);
    for (const tile of this.tiles) {
      const source = byId.get(tile.id);
      const video = this.#videos.get(tile.id)?.video;
      paintTile(context, tile, source, video, scale);
    }
  }

  #syncVideos(sources) {
    const seen = new Set();
    for (const source of sources) {
      if (!source.track) continue;
      seen.add(source.id);
      const entry = this.#videos.get(source.id);
      if (entry?.track === source.track) continue;
      if (entry) releaseVideo(entry.video);
      const video = createVideo(source.track);
      this.#videos.set(source.id, { track: source.track, video });
    }
    for (const id of Array.from(this.#videos.keys())) {
      if (seen.has(id)) continue;
      releaseVideo(this.#videos.get(id).video);
      this.#videos.delete(id);
    }
  }
}

export { speechOf, nextSpeech, sourcesOf, moveTiles, ellipsize, Compositor };
