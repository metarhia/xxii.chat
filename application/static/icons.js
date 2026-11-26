const SVG_NS = 'http://www.w3.org/2000/svg';

const MIC = [
  'M8 1.5a2 2 0 0 0-2 2v4a2 2 0 0 0 4 0v-4a2 2 0 0 0-2-2z',
  'M3.5 7.5a4.5 4.5 0 0 0 9 0M8 12v2.5M5.5 14.5h5',
];
const CAMERA = ['M1.5 4.5h9v7h-9z', 'M10.5 7.2 15 4.8v6.4l-4.5-2.4'];
const SCREEN = ['M1.5 2.5h13V11h-13z', 'M5.5 14h5M8 11v3'];
const SLASH = 'M2.5 1.5l11 13';
const CIRCLE = 'M8 1.5a6.5 6.5 0 1 0 0 13 6.5 6.5 0 0 0 0-13z';

const GEAR_TEETH = 8;
const GEAR_BASE = 5;
const GEAR_TIP = 6.9;
const GEAR_FLANK = 15;
const GEAR_CROWN = 8;

const pointAt = (degrees, radius) => {
  const angle = ((degrees - 90) * Math.PI) / 180;
  const x = 8 + radius * Math.cos(angle);
  const y = 8 + radius * Math.sin(angle);
  return `${x.toFixed(2)} ${y.toFixed(2)}`;
};

const toothAt = (center) => [
  pointAt(center - GEAR_FLANK, GEAR_BASE),
  pointAt(center - GEAR_CROWN, GEAR_TIP),
  pointAt(center + GEAR_CROWN, GEAR_TIP),
  pointAt(center + GEAR_FLANK, GEAR_BASE),
];

const createGear = () => {
  const step = 360 / GEAR_TEETH;
  const teeth = Array.from({ length: GEAR_TEETH }, (_, i) => toothAt(i * step));
  return `M${teeth.flat().join('L')}z`;
};

const ICONS = {
  mic: { paths: MIC },
  'mic-off': { paths: [...MIC, SLASH] },
  camera: { paths: CAMERA },
  'camera-off': { paths: [...CAMERA, SLASH] },
  screen: { paths: [...SCREEN, 'M8 9V5M6 6.8 8 4.8l2 2'] },
  'screen-off': { paths: [...SCREEN, SLASH] },
  hand: {
    paths: [
      'M5 7.5V3.2a1 1 0 0 1 2 0V7M7 7V2.2a1 1 0 0 1 2 0V7',
      'M9 7V3.2a1 1 0 0 1 2 0V8',
      'M11 6.2a1 1 0 0 1 2 0V10c0 2.8-1.8 4.5-4.8 4.5-2 0-3.2-.8-4.3-2.4',
      'L2.3 9.6a1 1 0 0 1 1.6-1.2L5 9.8V7.5',
    ],
  },
  react: {
    paths: [
      CIRCLE,
      'M5.2 9.6a3.2 3.2 0 0 0 5.6 0',
      'M5.8 6.2h.01M10.2 6.2h.01',
    ],
  },
  record: {
    paths: [CIRCLE],
    fills: ['M8 5a3 3 0 1 0 0 6 3 3 0 0 0 0-6z'],
  },
  search: {
    paths: ['M6.8 1.8a5 5 0 1 0 0 10 5 5 0 0 0 0-10z', 'M10.4 10.4l4 4'],
  },
  more: {
    fills: [
      'M3.5 6.8a1.2 1.2 0 1 0 0 2.4 1.2 1.2 0 0 0 0-2.4z',
      'M8 6.8a1.2 1.2 0 1 0 0 2.4 1.2 1.2 0 0 0 0-2.4z',
      'M12.5 6.8a1.2 1.2 0 1 0 0 2.4 1.2 1.2 0 0 0 0-2.4z',
    ],
  },
  people: {
    paths: [
      'M6 7.5a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5z',
      'M1.5 13.5c0-2.5 2-4 4.5-4s4.5 1.5 4.5 4',
      'M10.8 2.8a2.3 2.3 0 0 1 0 4.4M12.2 9.6c1.5.5 2.3 1.8 2.3 3.9',
    ],
  },
  chat: {
    paths: ['M2 2.5h12V11H8l-3.5 3V11H2z'],
  },
  leave: {
    paths: [
      'M6.5 2.5h-3a1 1 0 0 0-1 1v9a1 1 0 0 0 1 1h3',
      'M10 5l3 3-3 3M13 8H6',
    ],
  },
  caret: { paths: ['m4 10 4-4 4 4'] },
  check: { paths: ['M3 8.5 6.5 12 13 4.5'] },
  settings: {
    paths: [createGear(), 'M8 6.1a1.9 1.9 0 1 0 0 3.8 1.9 1.9 0 0 0 0-3.8z'],
  },
  recordings: {
    paths: ['M8 2.5a5.5 5.5 0 1 0 0 11 5.5 5.5 0 0 0 0-11z'],
    fills: ['M8 6a2 2 0 1 0 0 4 2 2 0 0 0 0-4z'],
  },
  pip: { paths: ['M2 3.5h12v9H2z', 'M8.5 8h4.5v3.5H8.5z'] },
  layout: {
    paths: ['M2 2.5h5v5H2zM9 2.5h5v5H9zM2 9.5h5v4H2zM9 9.5h5v4H9z'],
  },
  keyboard: {
    paths: [
      'M1.5 4h13v8h-13z',
      'M4 6.5h.01M6.5 6.5h.01M9 6.5h.01M11.5 6.5h.01M5 9.5h6',
    ],
  },
  link: {
    paths: [
      'M6.5 9.5a3 3 0 0 0 4.2 0l2-2a3 3 0 0 0-4.2-4.2l-1 1',
      'M9.5 6.5a3 3 0 0 0-4.2 0l-2 2a3 3 0 0 0 4.2 4.2l1-1',
    ],
  },
  back: { paths: ['M10 3 5 8l5 5'] },
  expand: {
    paths: ['M9.5 2.5h4v4M13.5 2.5 9 7M6.5 13.5h-4v-4M2.5 13.5 7 9'],
  },
  play: { fills: ['M5 2.8v10.4l8.5-5.2z'] },
  download: { paths: ['M8 2v8.5M4.5 7.2 8 10.7l3.5-3.5M2.5 13.5h11'] },
  save: {
    paths: ['M2.5 2.5h9l2 2v9h-11z', 'M5 2.5v3.5h5V2.5M5 13.5V9h6v4.5'],
  },
  delete: {
    paths: [
      'M2.5 4h11M6 4V2.5h4V4M4 4l.7 9.5h6.6L12 4',
      'M6.7 6.5v4.5M9.3 6.5v4.5',
    ],
  },
  folder: { paths: ['M1.5 3.5h4.5l1.5 1.8h7v7.7h-13z'] },
  studio: {
    paths: [
      'M1.5 6h13v7.5h-13z',
      'M1.5 6l1.5-3.5h2L3.5 6M5.5 6 7 2.5h2L7.5 6M9.5 6 11 2.5h2L11.5 6',
    ],
  },
};

const createShape = (doc, d, isFilled) => {
  const path = doc.createElementNS(SVG_NS, 'path');
  path.setAttribute('d', d);
  if (!isFilled) return path;
  path.setAttribute('fill', 'currentColor');
  path.setAttribute('stroke', 'none');
  return path;
};

const createIcon = (name, doc = document) => {
  const icon = ICONS[name];
  if (!icon) throw new Error(`Unknown icon ${name}`);
  const svg = doc.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 16 16');
  svg.setAttribute('aria-hidden', 'true');
  svg.dataset.icon = name;
  const { paths = [], fills = [] } = icon;
  for (const d of paths) svg.append(createShape(doc, d, false));
  for (const d of fills) svg.append(createShape(doc, d, true));
  return svg;
};

export { createIcon };
