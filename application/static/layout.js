const TILE_ASPECT = 16 / 9;
const REFERENCE_HEIGHT = 1080;
const DEFAULT_QUALITY = '1080p30';
const QUALITIES = {
  '720p30': { width: 1280, height: 720, fps: 30, bitsPerSecond: 3000000 },
  '1080p30': { width: 1920, height: 1080, fps: 30, bitsPerSecond: 6000000 },
  '1080p60': { width: 1920, height: 1080, fps: 60, bitsPerSecond: 9000000 },
};
const QUALITY_NAMES = Object.keys(QUALITIES);
const PEOPLE = ['speaker', 'speakers', 'grid', 'pinned'];
const SCREENS = ['off', 'screen', 'screenSpeaker', 'screenSpeakers'];
const PLACEMENTS = ['strip', 'bubble'];
const OTHERS = ['hidden', 'strip', 'names'];
const POSITIONS = ['bottom', 'right', 'left', 'top'];
const NO_VIDEO = ['avatar', 'hide'];

const MIN_SPEAKERS = 1;
const MAX_SPEAKERS = 6;
const DEFAULT_SPEAKERS = 4;
const MAX_GRID = 16;
const MAX_OTHERS = 12;
const MAX_SCREENS = 2;

const PADDING = 32;
const GAP = 16;
const RADIUS = 12;
const OTHERS_RATIO = 0.2;
const SIDE_RATIO = 0.25;
const BUBBLE_RATIO = 0.18;
const BUBBLE_SPAN = 0.6;
const BUBBLE_HEIGHT = 0.5;
const NAME_HEIGHT_RATIO = 0.045;
const NAME_WIDTH_RATIO = 0.18;

const ENTER_MS = 1500;
const LEAVE_MS = 4000;
const RECENT_MS = 10000;
const HOLD_MS = 800;
const SPEAKING_LEVEL = 0.05;

const SIDES = {
  top: { vertical: false, first: true },
  bottom: { vertical: false, first: false },
  left: { vertical: true, first: true },
  right: { vertical: true, first: false },
};
const FITS = { camera: 'cover', screen: 'contain' };
const FIXED_COUNTS = {
  screen: 0,
  screenSpeaker: 1,
  speaker: 1,
  grid: 0,
  pinned: 0,
};

const choose = (value, allowed, fallback) =>
  allowed.includes(value) ? value : fallback;

const flagOf = (value, fallback) =>
  typeof value === 'boolean' ? value : fallback;

const lengthOf = (value, fallback) =>
  Number.isFinite(value) ? Math.max(0, value) : fallback;

const sizeOf = (value, fallback) =>
  Number.isFinite(value) ? Math.max(0, Math.floor(value)) : fallback;

const countOf = (value) => {
  if (!Number.isFinite(value)) return DEFAULT_SPEAKERS;
  return Math.min(MAX_SPEAKERS, Math.max(MIN_SPEAKERS, Math.round(value)));
};

const qualityOf = (options) => {
  const name = choose(options?.quality, QUALITY_NAMES, DEFAULT_QUALITY);
  return QUALITIES[name];
};

const programOf = (options) => {
  const input = options ?? {};
  const quality = qualityOf(input);
  const width = sizeOf(input.width, quality.width);
  const height = sizeOf(input.height, quality.height);
  const scale = height / REFERENCE_HEIGHT;
  return {
    width,
    height,
    padding: lengthOf(input.padding, Math.round(PADDING * scale)),
    gap: lengthOf(input.gap, Math.round(GAP * scale)),
    radius: lengthOf(input.radius, Math.round(RADIUS * scale)),
    people: choose(input.people, PEOPLE, 'speakers'),
    maxSpeakers: countOf(input.maxSpeakers),
    screen: choose(input.screen, SCREENS, 'screenSpeakers'),
    placement: choose(input.placement, PLACEMENTS, 'strip'),
    others: choose(input.others, OTHERS, 'hidden'),
    othersPosition: choose(input.othersPosition, POSITIONS, 'bottom'),
    names: flagOf(input.names, true),
    noVideo: choose(input.noVideo, NO_VIDEO, 'avatar'),
    pinned: Array.isArray(input.pinned) ? input.pinned : [],
  };
};

const gridShape = (count, area, aspect, gap) => {
  if (count === 0) return { columns: 0, rows: 0, width: 0, height: 0 };
  let best = { columns: 1, rows: count, width: -1, height: 0 };
  for (let columns = 1; columns <= count; columns++) {
    const rows = Math.ceil(count / columns);
    const cellWidth = Math.max(0, (area.width - gap * (columns - 1)) / columns);
    const cellHeight = Math.max(0, (area.height - gap * (rows - 1)) / rows);
    const width = Math.min(cellWidth, cellHeight * aspect);
    if (width > best.width) {
      best = { columns, rows, width, height: width / aspect };
    }
  }
  return best;
};

const gridRects = (count, area, aspect, gap) => {
  const shape = gridShape(count, area, aspect, gap);
  const { columns, rows, width, height } = shape;
  const blockHeight = rows * height + (rows - 1) * gap;
  const top = Math.max(area.y, area.y + (area.height - blockHeight) / 2);
  const rects = new Array(count).fill(null);
  for (let i = 0; i < count; i++) {
    const row = Math.floor(i / columns);
    const inRow = Math.min(columns, count - row * columns);
    const rowWidth = inRow * width + (inRow - 1) * gap;
    const left = Math.max(area.x, area.x + (area.width - rowWidth) / 2);
    const x = left + (i % columns) * (width + gap);
    const y = top + row * (height + gap);
    rects[i] = { x, y, width, height };
  }
  return rects;
};

const drawArgsOf = (sourceWidth, sourceHeight, tile, fit) => {
  const scaleX = tile.width / sourceWidth;
  const scaleY = tile.height / sourceHeight;
  if (fit === 'cover') {
    const scale = Math.max(scaleX, scaleY);
    const width = tile.width / scale;
    const height = tile.height / scale;
    const sx = (sourceWidth - width) / 2;
    const sy = (sourceHeight - height) / 2;
    return [sx, sy, width, height, tile.x, tile.y, tile.width, tile.height];
  }
  const scale = Math.min(scaleX, scaleY);
  const width = sourceWidth * scale;
  const height = sourceHeight * scale;
  const dx = tile.x + (tile.width - width) / 2;
  const dy = tile.y + (tile.height - height) / 2;
  return [0, 0, sourceWidth, sourceHeight, dx, dy, width, height];
};

const heardAt = (source) => {
  if (source.optOut) return 0;
  return source.spokeAt ?? 0;
};

const isHeard = (source, now) => {
  const at = heardAt(source);
  return at > 0 && now - at < HOLD_MS;
};

const isSpeaking = (source, now) => {
  if (source.optOut) return false;
  return source.level > SPEAKING_LEVEL || isHeard(source, now);
};

const isRecent = (source, now) => {
  const at = heardAt(source);
  return at > 0 && now - at < RECENT_MS;
};

const isQualified = (source, now) => {
  const since = source.speakingSince ?? 0;
  const isLong = since > 0 && now - since >= ENTER_MS;
  return isLong && isSpeaking(source, now);
};

const isStale = (source, now) => {
  const at = heardAt(source);
  return at === 0 || now - at >= LEAVE_MS;
};

const byRecent = (a, b) => heardAt(b) - heardAt(a);

const bySpeechStart = (a, b) => a.speakingSince - b.speakingSince;

const isPerson = (source) => source.kind === 'camera';

const isStaged = (source) => source.stage !== false;

const isShare = (source) => source.kind === 'screen' && source.hasVideo;

const isVisible = (source, program) =>
  source.hasVideo || program.noVideo === 'avatar';

const pinnedOf = (people, pinned) => {
  const found = [];
  for (const entry of pinned) {
    const match = (source) => source.id === entry || source.endpoint === entry;
    const source = people.find(match);
    if (source && !found.includes(source)) found.push(source);
  }
  return found;
};

const modeOf = (program, hasScreen, hasPinned) => {
  if (hasScreen) return program.screen;
  const isEmptyPin = program.people === 'pinned' && !hasPinned;
  return isEmptyPin ? 'speakers' : program.people;
};

const sceneOf = (program, sources) => {
  const staged = sources.filter(isStaged);
  const shares = staged.filter(isShare);
  const screens = program.screen === 'off' ? [] : shares.slice(0, MAX_SCREENS);
  const everyone = staged.filter(isPerson);
  const people = everyone.filter((source) => isVisible(source, program));
  const pinned = pinnedOf(people, program.pinned);
  const mode = modeOf(program, screens.length > 0, pinned.length > 0);
  const count = FIXED_COUNTS[mode] ?? program.maxSpeakers;
  return { screens, everyone, people, pinned, mode, count };
};

const membersOf = (people, held) => {
  const members = [];
  for (const id of held) {
    const source = people.find((item) => item.id === id);
    if (source && !members.includes(source)) members.push(source);
  }
  return members;
};

const trimmed = (members, room) => {
  if (members.length <= room) return members;
  const keep = members.toSorted(byRecent).slice(0, room);
  return members.filter((source) => keep.includes(source));
};

const rankOutsiders = (outsiders, now) => {
  const isLong = (source) => isQualified(source, now);
  const isFresh = (source) => isRecent(source, now);
  const qualified = outsiders.filter(isLong).toSorted(bySpeechStart);
  const quiet = outsiders.filter((source) => !isLong(source));
  const recent = quiet.filter(isFresh).toSorted(byRecent);
  const rest = quiet.filter((source) => !isFresh(source));
  return qualified.concat(recent, rest);
};

const stalestOf = (seated, now) => {
  let found = -1;
  for (let i = 0; i < seated.length; i++) {
    if (!isStale(seated[i], now)) continue;
    if (found < 0 || heardAt(seated[i]) < heardAt(seated[found])) found = i;
  }
  return found;
};

const replaceStale = (slots, waiting, now) => {
  const seated = slots.slice();
  for (const source of waiting) {
    const index = stalestOf(seated, now);
    if (index < 0) break;
    seated[index] = source;
  }
  return seated;
};

const pickSpeakers = (scene, now, held) => {
  const pinned = scene.pinned.slice(0, scene.count);
  const room = Math.max(0, scene.count - pinned.length);
  const rest = scene.people.filter((source) => !pinned.includes(source));
  const members = trimmed(membersOf(rest, held), room);
  const outsiders = rest.filter((source) => !members.includes(source));
  const ranked = rankOutsiders(outsiders, now);
  const free = room - members.length;
  const slots = members.concat(ranked.slice(0, free));
  const isLong = (source) => isQualified(source, now);
  const waiting = ranked.slice(free).filter(isLong);
  const seated = replaceStale(slots, waiting, now);
  return pinned.concat(seated).map((source) => source.id);
};

const selectSpeakers = (sources, program, now, held = []) => {
  const scene = sceneOf(programOf(program), sources);
  return pickSpeakers(scene, now, held);
};

const FEATURED = {
  grid: (scene) => scene.people.slice(0, MAX_GRID),
  pinned: (scene) => scene.pinned.slice(0, MAX_GRID),
};

const featuredOf = (scene, speakers) => {
  const pick = FEATURED[scene.mode];
  if (pick) return pick(scene);
  const find = (id) => scene.people.find((source) => source.id === id);
  return speakers.map(find).filter(Boolean).slice(0, scene.count);
};

const othersOf = (program, scene, featured) => {
  if (program.others === 'hidden') return [];
  const pool = program.others === 'names' ? scene.everyone : scene.people;
  const rest = pool.filter((source) => !featured.includes(source));
  return rest.slice(0, MAX_OTHERS);
};

const carve = (area, side, thickness, gap) => {
  const info = SIDES[side];
  const span = info.vertical ? area.width : area.height;
  const origin = info.vertical ? area.x : area.y;
  const size = Math.min(thickness, span);
  const rest = Math.max(0, span - size - gap);
  const stripAt = info.first ? origin : origin + span - size;
  const mainAt = info.first ? origin + span - rest : origin;
  if (info.vertical) {
    const strip = { x: stripAt, y: area.y, width: size, height: area.height };
    const main = { x: mainAt, y: area.y, width: rest, height: area.height };
    return { main, strip };
  }
  const strip = { x: area.x, y: stripAt, width: area.width, height: size };
  const main = { x: area.x, y: mainAt, width: area.width, height: rest };
  return { main, strip };
};

const lineRects = (count, cell, strip, vertical, gap) => {
  const length = vertical ? strip.height : strip.width;
  const step = (vertical ? cell.height : cell.width) + gap;
  const start = Math.max(0, (length - (step * count - gap)) / 2);
  const rects = new Array(count).fill(null);
  for (let i = 0; i < count; i++) {
    const offset = start + i * step;
    const x = vertical ? strip.x : strip.x + offset;
    const y = vertical ? strip.y + offset : strip.y;
    rects[i] = { x, y, width: cell.width, height: cell.height };
  }
  return rects;
};

const stripCell = (count, area, vertical, ratio, gap) => {
  const length = vertical ? area.height : area.width;
  const cross = vertical ? area.width : area.height;
  const fit = Math.max(0, (length - gap * (count - 1)) / count);
  const limit = cross * ratio;
  const alongWidth = vertical ? fit * TILE_ASPECT : fit;
  const crossWidth = vertical ? limit : limit * TILE_ASPECT;
  const width = Math.min(alongWidth, crossWidth);
  return { width, height: width / TILE_ASPECT };
};

const nameCell = (count, area, vertical, gap, program) => {
  const length = vertical ? area.height : area.width;
  const fit = Math.max(0, (length - gap * (count - 1)) / count);
  const chip = program.height * NAME_HEIGHT_RATIO;
  const wide = area.width * NAME_WIDTH_RATIO;
  const height = Math.min(chip, vertical ? fit : area.height);
  const width = Math.min(wide, vertical ? area.width : fit);
  return { width, height };
};

const placeLine = (cell, count, area, side, gap) => {
  const vertical = SIDES[side].vertical;
  const thickness = vertical ? cell.width : cell.height;
  const parts = carve(area, side, thickness, gap);
  const rects = lineRects(count, cell, parts.strip, vertical, gap);
  return { main: parts.main, rects };
};

const sideStrip = (count, area, gap) => {
  const side = area.width >= area.height ? 'right' : 'bottom';
  const vertical = SIDES[side].vertical;
  const cell = stripCell(count, area, vertical, SIDE_RATIO, gap);
  const placed = placeLine(cell, count, area, side, gap);
  return { area: placed.main, rects: placed.rects, z: 1 };
};

const bubbleRects = (count, area, gap) => {
  const span = area.width * BUBBLE_SPAN - gap * (count - 1);
  const limit = area.width * BUBBLE_RATIO;
  const tall = area.height * BUBBLE_HEIGHT * TILE_ASPECT;
  const width = Math.max(0, Math.min(limit, span / count, tall));
  const height = width / TILE_ASPECT;
  const right = area.x + area.width - gap;
  const y = area.y + area.height - gap - height;
  const rects = new Array(count).fill(null);
  for (let i = 0; i < count; i++) {
    const x = right - (count - i) * width - (count - 1 - i) * gap;
    rects[i] = { x, y, width, height };
  }
  return rects;
};

const bubbles = (count, area, gap) => {
  const rects = bubbleRects(count, area, gap);
  return { area, rects, z: 2 };
};

const PLACERS = { strip: sideStrip, bubble: bubbles };

const placeOthers = (program, others, inner) => {
  const count = others.length;
  if (count === 0) return { main: inner, rects: [] };
  const side = program.othersPosition;
  const vertical = SIDES[side].vertical;
  const gap = program.gap;
  const isNames = program.others === 'names';
  const names = nameCell(count, inner, vertical, gap, program);
  const strip = stripCell(count, inner, vertical, OTHERS_RATIO, gap);
  return placeLine(isNames ? names : strip, count, inner, side, gap);
};

const snapRect = (rect) => {
  const left = Math.round(rect.x);
  const top = Math.round(rect.y);
  const right = Math.round(rect.x + rect.width);
  const bottom = Math.round(rect.y + rect.height);
  return { x: left, y: top, width: right - left, height: bottom - top };
};

const placeholderOf = (source) => {
  if (source.optOut) return 'opted out';
  return source.hasVideo ? '' : 'avatar';
};

const tileOf = (source, rect, program, now, z) => {
  const box = snapRect(rect);
  const radius = Math.min(program.radius, box.width / 2, box.height / 2);
  const isLabeled = program.names && source.nick;
  return {
    id: source.id,
    x: box.x,
    y: box.y,
    width: box.width,
    height: box.height,
    fit: FITS[source.kind],
    radius,
    z,
    label: isLabeled ? source.nick : '',
    speaking: isSpeaking(source, now),
    placeholder: placeholderOf(source),
  };
};

const rowOf = (source, rect, program, now, z) => {
  const tile = tileOf(source, rect, program, now, z);
  tile.label = source.nick ?? '';
  tile.placeholder = 'name';
  return tile;
};

const MAKERS = { strip: tileOf, names: rowOf };

const placeSpeakers = (program, count, main) => {
  if (count === 0) return { area: main, rects: [], z: 1 };
  return PLACERS[program.placement](count, main, program.gap);
};

const screenCells = (shares, area, gap) => {
  if (shares.length === 1) return [area];
  return gridRects(shares.length, area, TILE_ASPECT, gap);
};

const placeScreens = (program, scene, featured, main, now) => {
  const shares = scene.screens;
  const placed = placeSpeakers(program, featured.length, main);
  const cells = screenCells(shares, placed.area, program.gap);
  const shown = (source, i) => tileOf(source, cells[i], program, now, 1);
  const seated = (source, i) =>
    tileOf(source, placed.rects[i], program, now, placed.z);
  return shares.map(shown).concat(featured.map(seated));
};

const placePeople = (program, featured, main, now) => {
  const count = featured.length;
  const rects = gridRects(count, main, TILE_ASPECT, program.gap);
  const seated = (source, i) => tileOf(source, rects[i], program, now, 1);
  return featured.map(seated);
};

const innerOf = (program) => {
  const shortSide = Math.min(program.width, program.height);
  const pad = Math.min(program.padding, shortSide / 4);
  const width = program.width - 2 * pad;
  const height = program.height - 2 * pad;
  return { x: pad, y: pad, width, height };
};

const hasArea = (tile) => tile.width > 0 && tile.height > 0;

const byZ = (a, b) => a.z - b.z;

const stageOf = (program, sources, now, speakers) => {
  const scene = sceneOf(program, sources);
  const chosen = speakers ?? pickSpeakers(scene, now, []);
  const featured = featuredOf(scene, chosen);
  return { scene, featured };
};

const onScreenOf = (input, sources, now, speakers) => {
  const program = programOf(input);
  const inner = innerOf(program);
  if (inner.width <= 0 || inner.height <= 0) return [];
  const { scene, featured } = stageOf(program, sources, now, speakers);
  return scene.screens.concat(featured).map((source) => source.id);
};

const layoutProgram = (input, sources, now, speakers) => {
  const program = programOf(input);
  const inner = innerOf(program);
  if (inner.width <= 0 || inner.height <= 0) return [];
  const { scene, featured } = stageOf(program, sources, now, speakers);
  const others = othersOf(program, scene, featured);
  const panel = placeOthers(program, others, inner);
  const hasScreen = scene.screens.length > 0;
  const main = hasScreen
    ? placeScreens(program, scene, featured, panel.main, now)
    : placePeople(program, featured, panel.main, now);
  const make = MAKERS[program.others];
  const side = others.map((source, i) =>
    make(source, panel.rects[i], program, now, 1),
  );
  return main.concat(side).filter(hasArea).toSorted(byZ);
};

export { TILE_ASPECT, REFERENCE_HEIGHT, QUALITIES, PEOPLE, SCREENS };
export { PLACEMENTS, OTHERS, POSITIONS, NO_VIDEO };
export { MIN_SPEAKERS, MAX_SPEAKERS, MAX_GRID, MAX_OTHERS, MAX_SCREENS };
export { ENTER_MS, LEAVE_MS, RECENT_MS };
export { choose, flagOf, qualityOf, programOf, gridShape, gridRects };
export { drawArgsOf, selectSpeakers, onScreenOf, layoutProgram };
