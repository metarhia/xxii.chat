const SHORTCUTS = [
  {
    letter: 'd',
    command: true,
    alt: false,
    action: 'mic',
    keys: 'Ctrl D',
    label: 'mute and unmute',
  },
  {
    letter: 'e',
    command: true,
    alt: false,
    action: 'camera',
    keys: 'Ctrl E',
    label: 'camera on and off',
  },
  {
    letter: 'h',
    command: true,
    alt: true,
    action: 'hand',
    keys: 'Ctrl Alt H',
    label: 'raise and lower hand',
  },
  {
    letter: 's',
    command: true,
    alt: true,
    action: 'share',
    keys: 'Ctrl Alt S',
    label: 'share screen and stop',
  },
  {
    letter: 'l',
    command: true,
    alt: true,
    action: 'layout',
    keys: 'Ctrl Alt L',
    label: 'next layout',
  },
  {
    letter: 'f',
    command: false,
    alt: false,
    action: 'fullscreen',
    keys: 'F',
    label: 'full screen stage, outside text fields',
  },
];

const HOLD = { keys: 'hold Space', label: 'push to talk while muted' };
const LEAVE_NOTE = { keys: 'Esc', label: 'close menus, never leaves' };

const letterOf = (event) => {
  const code = event.code ?? '';
  if (code.startsWith('Key')) return code.slice(3).toLowerCase();
  const key = event.key ?? '';
  return `${key}`.toLowerCase();
};

const matches = (row, event, letter) => {
  const command = Boolean(event.ctrlKey || event.metaKey);
  if (row.letter !== letter || row.command !== command) return false;
  return row.alt === Boolean(event.altKey) && !event.shiftKey;
};

const shortcutOf = (event) => {
  const letter = letterOf(event);
  for (const row of SHORTCUTS) {
    if (matches(row, event, letter)) return row;
  }
  return null;
};

const isTalkKey = (event) => {
  const isSpace = event.code === 'Space' || event.key === ' ';
  const modified = event.ctrlKey || event.metaKey || event.altKey;
  return isSpace && !modified && !event.shiftKey;
};

const createTalk = () => ({ held: false });

const stepTalk = (state, kind, micOn) => {
  const idle = { state, unmute: false, mute: false };
  if (kind === 'down') {
    if (state.held || micOn) return idle;
    return { state: { held: true }, unmute: true, mute: false };
  }
  if (!state.held) return idle;
  const mute = kind !== 'cancel' && micOn;
  return { state: { held: false }, unmute: false, mute };
};

const helpOf = () => {
  const rows = SHORTCUTS.map(({ keys, label }) => ({ keys, label }));
  return rows.concat([HOLD, LEAVE_NOTE]);
};

export { SHORTCUTS, shortcutOf, isTalkKey, createTalk, stepTalk, helpOf };
