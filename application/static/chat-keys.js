const CHAT_SHORTCUTS = [
  { keys: 'Ctrl K', label: 'jump to a chat, feed, contact, or command' },
  { keys: 'Ctrl F', label: 'search messages in this chat' },
  { keys: 'Ctrl P', label: 'pinned messages' },
  { keys: 'Ctrl ,', label: 'settings' },
  { keys: 'Alt ↑ / Alt ↓', label: 'previous and next chat' },
  { keys: 'Enter', label: 'send, Shift Enter for a new line' },
  { keys: 'Ctrl Enter', label: 'send a post in a feed' },
  { keys: 'Ctrl B / Ctrl I', label: 'bold and italic in the composer' },
  { keys: '↑', label: 'select the last message, in an empty composer' },
  { keys: '↑ / ↓', label: 'move between messages' },
  { keys: 'Enter', label: 'open the menu of the selected message' },
  { keys: 'R', label: 'reply to the selected message' },
  { keys: 'E', label: 'edit the selected message, if it is yours' },
  { keys: 'F', label: 'follow the thread of the selected message' },
  { keys: '[ / ]', label: 'previous and next message of the thread' },
  { keys: 'Esc', label: 'close, go back, or show and hide the sidebar' },
];

const isApple = () => {
  const platform = globalThis.navigator?.userAgentData?.platform;
  const text = platform || globalThis.navigator?.platform || '';
  return /mac|iphone|ipad/i.test(text);
};

const localKeys = (keys, apple = isApple()) =>
  apple ? keys.replaceAll('Ctrl', '⌘') : keys;

export { CHAT_SHORTCUTS, isApple, localKeys };
