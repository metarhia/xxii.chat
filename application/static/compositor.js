import { REFERENCE_HEIGHT, flagOf, qualityOf, programOf } from './layout.js';
import { drawArgsOf, selectSpeakers } from './layout.js';
import { onScreenOf, layoutProgram } from './layout.js';
import { colorOf, initialsOf } from './avatar.js';
import { idOf } from './members.js';
import { tickOn } from './clock.js';
import { brandFont, chipStyleOf, countdownText } from './studio-layout.js';
import { logoRect, overlayRect, tickerOffset } from './studio-layout.js';
import { commentLines, clipSource } from './studio-layout.js';

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
  const isStaged = member.stage !== false && (!member.local || includeMe);
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
  stage: member.stage !== false,
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
  const drawn = new Array(tiles.length).fill(null);
  for (let i = 0; i < tiles.length; i++) {
    const tile = tiles[i];
    const entry = stepOf(motion.get(tile.id), tile, now, isMoving);
    next.set(tile.id, entry);
    drawn[i] = { ...tile, ...rectAt(entry, now) };
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

const FIT_LIMIT = 512;
const fitted = new Map();
let wrapped = { key: '', lines: [] };

const measureOf = (context) => (text) => context.measureText(text).width;

const fitText = (context, text, width) => {
  const key = `${context.font}\n${width}\n${text}`;
  let result = fitted.get(key);
  if (result === undefined) {
    if (fitted.size >= FIT_LIMIT) fitted.clear();
    result = ellipsize(measureOf(context), text, width);
    fitted.set(key, result);
  }
  return result;
};

const wrapComment = (context, text, width) => {
  const key = `${context.font}\n${width}\n${text}`;
  if (wrapped.key !== key) {
    const lines = commentLines(text, measureOf(context), width);
    wrapped = { key, lines };
  }
  return wrapped.lines;
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

const paintBackground = (
  context,
  background,
  width,
  height,
  color = SURFACE,
) => {
  context.fillStyle = color;
  if (typeof background === 'string') context.fillStyle = background;
  context.fillRect(0, 0, width, height);
  if (typeof background === 'string' || !background) return;
  const sourceWidth =
    background.naturalWidth || background.videoWidth || background.width;
  const sourceHeight =
    background.naturalHeight || background.videoHeight || background.height;
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

const paintChip = (context, tile, scale, frame = null, nameOnly = false) => {
  const pad = Math.round(CHIP_PAD * scale);
  const limit = tile.height * (nameOnly ? 0.6 : CHIP_RATIO);
  const size = Math.round(Math.min(CHIP_SIZE * scale, limit));
  if ((!nameOnly && tile.height < CHIP_MIN_HEIGHT * scale) || size < MIN_FONT) {
    return;
  }
  const brand = frame?.brand;
  context.font = brand ? brandFont(frame.font, size) : fontOf(size);
  const text = fitText(context, tile.label, tile.width - 4 * pad);
  if (text === '') return;
  const box = {
    x: tile.x + pad,
    y: nameOnly
      ? tile.y + (tile.height - size - pad) / 2
      : tile.y + tile.height - pad - (size + pad),
    width: context.measureText(text).width + 2 * pad,
    height: size + pad,
  };
  const style = brand && chipStyleOf(brand.chipStyle, box.height);
  context.fillStyle = brand?.chip ?? CHIP;
  pathOf(context, box, style?.radius ?? box.height / 4);
  context.fill();
  if (style?.bar) {
    context.fillStyle = brand.accent;
    context.fillRect(box.x, box.y, style.bar, box.height);
  }
  context.fillStyle = brand?.text ?? LIGHT;
  context.textAlign = 'left';
  context.textBaseline = 'middle';
  context.fillText(text, box.x + pad, box.y + box.height / 2);
};

const paintName = (context, tile, source, scale, frame) => {
  if (frame) {
    paintChip(context, tile, scale, frame, true);
    return;
  }
  const pad = Math.round(CHIP_PAD * scale);
  const size = Math.round(Math.min(tile.height * 0.6, CHIP_SIZE * scale));
  if (size < MIN_FONT) return;
  context.font = fontOf(size);
  const text = fitText(context, tile.label, tile.width - 2 * pad);
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

const paintContent = (context, tile, source, video, scale, frame) => {
  const paint = PLACEHOLDERS[tile.placeholder];
  if (paint) return void paint(context, tile, source, scale, frame);
  if (isReady(video)) {
    const { videoWidth, videoHeight } = video;
    const args = drawArgsOf(videoWidth, videoHeight, tile, tile.fit);
    return void context.drawImage(video, ...args);
  }
  if (source.kind === 'camera') paintAvatar(context, tile, source);
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

const paintTile = (context, tile, source, video, scale, frame) => {
  context.save();
  pathOf(context, tile, tile.radius);
  context.clip();
  context.fillStyle = PANEL;
  context.fillRect(tile.x, tile.y, tile.width, tile.height);
  paintContent(context, tile, source, video, scale, frame);
  context.restore();
  const hasChip = tile.label !== '' && tile.placeholder !== 'name';
  if (hasChip) paintChip(context, tile, scale, frame);
  if (tile.speaking) paintRing(context, tile, scale);
};

const paintBrandBox = (context, box, brand) => {
  const style = chipStyleOf(brand.chipStyle, box.height);
  pathOf(context, box, style.radius);
  context.clip();
  context.fillStyle = brand.chip;
  context.fillRect(box.x, box.y, box.width, box.height);
  context.fillStyle = brand.accent;
  if (style.bar) {
    context.fillRect(box.x, box.y, style.bar, box.height);
  } else {
    const edge = box.height * 0.06;
    context.fillRect(box.x, box.y + box.height - edge, box.width, edge);
  }
  return style.bar;
};

const paintOverlay = (context, entry, box, frame, scale) => {
  const { kind, alpha, nick, text } = entry;
  const { brand, font } = frame;
  const { x, y, width, height } = box;
  const pad = 24 * scale;
  const size = (kind === 'comment' ? 23 : 29) * scale;
  context.save();
  try {
    context.globalAlpha = alpha;
    const bar = paintBrandBox(context, box, brand);
    const left = x + pad + bar;
    const limit = width - 2 * pad - bar;
    context.textAlign = 'left';
    context.textBaseline = 'middle';
    context.font = brandFont(font, size);
    if (nick) {
      context.fillStyle = brand.accent;
      const row = text ? y + 28 * scale : y + height / 2;
      context.fillText(fitText(context, nick, limit), left, row);
    }
    context.fillStyle = brand.text;
    if (kind === 'ticker') {
      const textWidth = context.measureText(text).width;
      const offset = tickerOffset(entry.elapsed, width, textWidth);
      context.fillText(text, x + offset, y + height / 2);
    } else if (kind === 'comment') {
      const lines = wrapComment(context, text, limit);
      for (let index = 0; index < lines.length; index++) {
        const line = lines[index];
        context.fillText(line, left, y + (61 + 27 * index) * scale);
      }
    } else {
      const row = nick ? y + 63 * scale : y + height / 2;
      context.fillText(fitText(context, text, limit), left, row);
    }
  } finally {
    context.restore();
  }
};

const overlaysOf = (scene, frame, width, height, full) => {
  const overlays = frame.overlays ?? [];
  const hasTicker =
    scene.overlays.includes('ticker') &&
    overlays.some(({ kind }) => kind === 'ticker');
  return overlays
    .filter(
      ({ kind, local }) =>
        scene.overlays.includes(kind) &&
        (!full || kind === 'ticker') &&
        (!local || scene.program.includeMe),
    )
    .map((entry) => ({
      ...entry,
      rect: overlayRect(entry.kind, width, height, hasTicker),
    }));
};

const paintSlate = (context, scene, frame, now, width, height, scale) => {
  const countdown = scene.type === 'countdown';
  const x = width / 2;
  const y = height / 2;
  const max = width * 0.85;
  if (countdown) {
    const badge = {
      x: width * 0.19,
      y: y - 140 * scale,
      width: width * 0.62,
      height: 250 * scale,
    };
    context.save();
    paintBrandBox(context, badge, frame.brand);
    context.restore();
  }
  context.textAlign = 'center';
  context.textBaseline = 'middle';
  context.fillStyle = frame.brand.text;
  context.font = brandFont(frame.font, Math.round(56 * scale), 600);
  const title = fitText(context, scene.text, max);
  context.fillText(title, x, countdown ? y - 85 * scale : y);
  if (!countdown) return;
  context.fillStyle = frame.brand.accent;
  context.font = brandFont(frame.font, Math.round(128 * scale), 600);
  context.fillText(countdownText(frame.until, now), x, y + 20 * scale, max);
};

const paintLogo = (context, scene, frame, width, height) => {
  if (!scene.overlays.includes('logo')) return;
  const logo = frame.brand.logo;
  const image = frame.image(logo.asset);
  if (!image) return;
  const rect = logoRect(
    logo,
    width,
    height,
    image.naturalWidth,
    image.naturalHeight,
  );
  context.drawImage(image, rect.x, rect.y, rect.width, rect.height);
};

class Compositor {
  #members = null;
  #options = null;
  #context = null;
  #shared = null;
  #untick = null;
  #motion = new Map();
  #speech = new Map();
  #videos = new Map();
  #held = [];
  #outgoingHeld = [];
  #sceneId = '';
  #fadeContext = null;
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
    this.overlays = [];
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
    if (this.#untick || this.#isStopped) return;
    this.#untick = tickOn(this.#shared, this.fps, () => this.#onTick());
    this.draw();
  }

  stop() {
    if (this.#isStopped) return;
    this.#isStopped = true;
    this.#untick?.();
    this.#untick = null;
    for (const entry of this.#videos.values()) releaseVideo(entry.video);
    this.#videos.clear();
    this.#motion.clear();
    this.#speech.clear();
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
    const frame = raw.studio?.frame(now, this.#query?.matches) ?? null;
    const sceneId = frame?.scene.id ?? '';
    const isSwitch = sceneId !== this.#sceneId;
    if (isSwitch) {
      this.#outgoingHeld = this.#held;
      this.#held = [];
      this.#sceneId = sceneId;
    }
    const members = this.#members();
    this.#speech = nextSpeech(this.#speech, members, now);
    const scene = frame?.scene;
    const clip = frame?.clip;
    const layer = this.#layout(members, raw, scene, clip, now, this.#held);
    this.#held = layer.speakers;
    const isMoving = !isSwitch && !frame?.previous && !this.#query?.matches;
    const moved = moveTiles(this.#motion, layer.tiles, now, isMoving);
    this.#motion = moved.motion;
    this.tiles = moved.drawn;
    this.onScreen = new Set(layer.ids);
    this.#syncVideos(layer.sources);
    if (frame?.previous) {
      this.#paintFade(frame, layer, raw, members, now);
    } else {
      this.#fadeContext = null;
      this.overlays = this.#paint(
        this.#context,
        layer,
        this.tiles,
        raw.background,
        frame,
        now,
      );
    }
    if (this.#isManual) this.track.requestFrame();
  }

  #layout(members, raw, scene, clip, now, held) {
    const options = scene?.program ?? raw;
    const live = !scene || scene.type === 'live';
    const sources = sourcesOf(members, this.#speech, options);
    const source = clipSource(clip);
    if (source) sources.unshift(source);
    const { width, height } = this;
    const program = programOf({ ...options, width, height });
    const staged = live
      ? sources
      : sources.filter(({ id }) => id === source?.id);
    const speakers = selectSpeakers(staged, program, now, held);
    const tiles = layoutProgram(program, staged, now, speakers);
    if (source) {
      const tile = tiles.find(({ id }) => id === source.id);
      if (tile) tile.label = source.nick;
    }
    const ids = onScreenOf(program, staged, now, speakers);
    return { scene, sources, speakers, tiles, ids };
  }

  #paintFade(frame, layer, raw, members, now) {
    const previous = frame.previous;
    const old = this.#layout(
      members,
      raw,
      previous.scene,
      frame.clip,
      now,
      this.#outgoingHeld,
    );
    this.#outgoingHeld = old.speakers;
    const context = this.#context;
    const fade = this.#fadeContext ?? this.#createFadeContext();
    this.#paint(
      context,
      old,
      old.tiles,
      null,
      { ...frame, until: previous.until },
      now,
    );
    this.overlays = this.#paint(fade, layer, this.tiles, null, frame, now);
    context.globalAlpha = frame.alpha;
    try {
      context.drawImage(fade.canvas, 0, 0);
    } finally {
      context.globalAlpha = 1;
    }
  }

  #createFadeContext() {
    const canvas = document.createElement('canvas');
    canvas.width = this.width;
    canvas.height = this.height;
    this.#fadeContext = canvas.getContext('2d');
    return this.#fadeContext;
  }

  #paint(context, layer, tiles, background, frame, now) {
    const { width, height } = this;
    const { scene, sources } = layer;
    const scale = height / REFERENCE_HEIGHT;
    const color = scene?.background.color;
    const image = scene ? frame.image(scene.background.image) : background;
    paintBackground(context, image, width, height, color);
    if (scene && scene.type !== 'live') {
      paintSlate(context, scene, frame, now, width, height, scale);
    }
    const byId = new Map(sources.map((source) => [source.id, source]));
    const clip = frame?.clip;
    for (const tile of tiles) {
      const source = byId.get(tile.id);
      const video =
        tile.id === clip?.id ? clip.media : this.#videos.get(tile.id)?.video;
      paintTile(context, tile, source, video, scale, frame);
    }
    if (!scene) return [];
    const full = clip?.mode === 'full' && isReady(clip.media);
    if (full) paintBackground(context, clip.media, width, height, color);
    const overlays = overlaysOf(scene, frame, width, height, full);
    for (const entry of overlays) {
      paintOverlay(context, entry, entry.rect, frame, scale);
    }
    paintLogo(context, scene, frame, width, height);
    return overlays;
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
    for (const id of this.#videos.keys()) {
      if (seen.has(id)) continue;
      releaseVideo(this.#videos.get(id).video);
      this.#videos.delete(id);
    }
  }
}

export { speechOf, nextSpeech, sourcesOf, moveTiles, ellipsize, Compositor };
