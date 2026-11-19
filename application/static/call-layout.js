import { TILE_ASPECT, gridShape, gridRects } from './layout.js';

const CALL_LAYOUTS = ['auto', 'grid', 'spotlight', 'sidebar'];
const STRIP_POSITIONS = ['bottom', 'top', 'left', 'right'];
const GAP = 8;
const STRIP_RATIO = 0.22;
const STRIP_MAX = 120;
const STRIP_ASPECT = 4 / 3;

const gapOf = (count, width, height) =>
  Math.min(GAP, width / count, height / count);

const bestGrid = (count, width, height) => {
  const gap = gapOf(count, width, height);
  return gridShape(count, { width, height }, TILE_ASPECT, gap);
};

const gridTiles = (tiles, bounds) => {
  if (!tiles.length) return [];
  const gap = gapOf(tiles.length, bounds.width, bounds.height);
  const rects = gridRects(tiles.length, bounds, TILE_ASPECT, gap);
  const place = (tile, index) => ({
    ...tile,
    ...rects[index],
    featured: false,
  });
  return tiles.map(place);
};

const featuredOf = (tiles, hints) => {
  for (const id of hints) {
    const found = tiles.find((tile) => tile.id === id);
    if (found) return found;
  }
  return tiles[0];
};

const phoneTiles = (tiles, featured, bounds) => {
  const { width, height } = bounds;
  const stripHeight = Math.min(height * STRIP_RATIO, STRIP_MAX);
  const stripWidth = stripHeight * STRIP_ASPECT;
  const mainHeight = Math.max(0, height - stripHeight - GAP);
  const main = { x: 0, y: 0, width, height: mainHeight, featured: true };
  const placed = [{ ...featured, ...main }];
  const others = tiles.filter((tile) => tile !== featured);
  for (let index = 0; index < others.length; index++) {
    placed.push({
      ...others[index],
      x: index * (stripWidth + GAP),
      y: 0,
      width: stripWidth,
      height: stripHeight,
      featured: false,
      strip: true,
    });
  }
  const strip = {
    x: 0,
    y: mainHeight + GAP,
    width,
    height: stripHeight,
  };
  return { layout: 'phone', tiles: placed, strip };
};

const tileId = (endpoint, slot = 'camera') => `${endpoint}/${slot}`;

const callLayout = (people, options = {}) => {
  const width = Math.max(0, options.width ?? 0);
  const height = Math.max(0, options.height ?? 0);
  const bounds = { x: 0, y: 0, width, height };
  const visible = people.filter((person) => {
    if (options.hideSelf && person.endpoint === options.self) return false;
    return !options.hideNoVideo || person.video;
  });
  const cameras = visible.slice(0, 8).map((person) => ({
    id: tileId(person.endpoint),
    endpoint: person.endpoint,
    slot: 'camera',
  }));
  const screens = people
    .filter((person) => person.screen)
    .map((person) => ({
      id: tileId(person.endpoint, 'screen'),
      endpoint: person.endpoint,
      slot: 'screen',
    }));
  const tiles = cameras.concat(screens);
  const requested = CALL_LAYOUTS.includes(options.layout)
    ? options.layout
    : 'auto';
  let layout = requested;
  if (layout === 'auto') {
    const hasFocus = tiles.some(
      (tile) => tile.id === options.pin || tile.id === options.spotlight,
    );
    layout = screens.length || hasFocus ? 'spotlight' : 'grid';
  }
  const phone = options.mobile === true;
  const flat = layout === 'grid' && !phone;
  if (flat || tiles.length < 2) {
    return { layout, tiles: gridTiles(tiles, bounds) };
  }
  const hints = [
    options.pin,
    options.spotlight,
    requested === 'auto' ? screens[0]?.id : '',
    tileId(options.speaker ?? ''),
  ];
  const featured = featuredOf(tiles, hints);
  if (phone) return phoneTiles(tiles, featured, bounds);
  const others = tiles.filter((tile) => tile !== featured);
  const position = STRIP_POSITIONS.includes(options.strip)
    ? options.strip
    : 'bottom';
  const strip = layout === 'sidebar' ? 'right' : position;
  const vertical = strip === 'left' || strip === 'right';
  const gap = Math.min(
    GAP,
    width / (tiles.length * 2),
    height / (tiles.length * 2),
  );
  const stripSize = vertical ? width * 0.23 : height * 0.23;
  const main = { ...bounds };
  const side = { ...bounds };
  if (vertical) {
    main.width = Math.max(0, width - stripSize - gap);
    side.width = stripSize;
    if (strip === 'left') main.x = stripSize + gap;
    else side.x = main.width + gap;
  } else {
    main.height = Math.max(0, height - stripSize - gap);
    side.height = stripSize;
    if (strip === 'top') main.y = stripSize + gap;
    else side.y = main.height + gap;
  }
  const placed = [{ ...featured, ...main, featured: true }];
  const count = others.length;
  for (let index = 0; index < count; index++) {
    const tileWidth = vertical
      ? side.width
      : (side.width - gap * (count - 1)) / count;
    const tileHeight = vertical
      ? (side.height - gap * (count - 1)) / count
      : side.height;
    placed.push({
      ...others[index],
      x: side.x + (vertical ? 0 : index * (tileWidth + gap)),
      y: side.y + (vertical ? index * (tileHeight + gap) : 0),
      width: Math.max(0, tileWidth),
      height: Math.max(0, tileHeight),
      featured: false,
    });
  }
  return { layout, tiles: placed };
};

export { CALL_LAYOUTS, STRIP_POSITIONS, bestGrid, tileId, callLayout };
