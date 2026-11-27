import { readMap, writeMap } from './view.js';
import { readShare, shareUrlOf } from './video-pieces.js';
import { timeText } from './recording-files.js';
import { button, element, openCollection } from './collection-dialog.js';
import { filteredCollection } from './collection-dialog.js';

const HISTORY = 'xxii:video-history';
const PLAYLISTS = 'xxii:video-playlists';
const MAX_HISTORY = 100;
const MAX_LISTS = 30;
const MAX_ENTRIES = 100;
const LATER = 'Watch Later';

const videoOf = (share, name) => ({
  room: share.room,
  id: share.id,
  name,
});

const write = (key, items) => {
  if (!writeMap(key, items)) throw new Error('Could not save this video list.');
};

const historyOf = (share) => readMap(HISTORY).get(share.id);

const rememberPosition = (share, name, time, duration) => {
  const items = readMap(HISTORY);
  const position = Math.max(0, time);
  const margin = Math.min(2, duration * 0.02);
  const done = Number.isFinite(duration) && position >= duration - margin;
  if (position < 1 && !done) return;
  items.delete(share.id);
  if (!done) items.set(share.id, { ...videoOf(share, name), time: position });
  while (items.size > MAX_HISTORY) items.delete(items.keys().next().value);
  write(HISTORY, items);
};

const playlists = () => {
  const lists = readMap(PLAYLISTS);
  if (!lists.has(LATER)) lists.set(LATER, []);
  return lists;
};

const namedList = (name, lists) => {
  const label = name.trim().slice(0, 70);
  if (!label) throw new Error('Enter a playlist name.');
  if (lists.has(label)) throw new Error('This playlist already exists.');
  if (lists.size >= MAX_LISTS) {
    throw new Error('You can have up to 30 playlists.');
  }
  return label;
};

const inList = (name, id) =>
  playlists()
    .get(name)
    ?.some((entry) => entry.id === id) ?? false;

const toggleVideo = (name, item) => {
  const lists = playlists();
  const entries = lists.get(name) ?? [];
  const has = entries.some(({ id }) => item.id === id);
  if (!has && entries.length >= MAX_ENTRIES) {
    throw new Error('This playlist is full.');
  }
  lists.set(
    name,
    has ? entries.filter(({ id }) => item.id !== id) : [...entries, item],
  );
  write(PLAYLISTS, lists);
  return !has;
};

const addToPlaylist = (share, name, saved) => {
  const item = videoOf(share, name);
  openCollection('Add to playlist', (body, close) => {
    const select = element('select');
    select.setAttribute('aria-label', 'Playlist');
    for (const name of playlists().keys()) {
      select.append(element('option', '', name));
    }
    const input = element('input');
    input.placeholder = 'New playlist name';
    input.setAttribute('aria-label', input.placeholder);
    input.maxLength = 70;
    const status = element('p', 'muted');
    status.setAttribute('role', 'status');
    const add = button('Save to playlist', () => {
      try {
        const lists = playlists();
        const label = input.value.trim()
          ? namedList(input.value, lists)
          : select.value;
        if (lists.has(label) && inList(label, item.id)) {
          throw new Error('This video is already in that playlist.');
        }
        toggleVideo(label, item);
        close();
        saved(label);
      } catch (error) {
        status.textContent = error.message;
      }
    });
    body.append(select, input, status, add);
  });
};

const openWatchLibrary = (mode = 'Playlists') => {
  const collection = openCollection(mode, (body) => {
    const status = element('p', 'muted');
    status.setAttribute('role', 'status');
    const actions = element('div', 'collection-toolbar');
    const controls = element('div');
    const playlist = element('select');
    playlist.setAttribute('aria-label', 'Playlist');
    let current = LATER;
    let paint = () => {};
    const refresh = () => {
      if (mode === 'Playlists') {
        playlist.replaceChildren(
          ...[...playlists().keys()].map((name) => element('option', '', name)),
        );
        playlist.value = current;
      }
      paint();
    };
    const safely = (run) => {
      try {
        run();
        status.textContent = '';
        refresh();
      } catch (error) {
        status.textContent = error.message;
      }
    };
    const rows = () => {
      const items =
        mode === 'Continue Watching'
          ? [...readMap(HISTORY).values()].reverse()
          : playlists().get(current) || [];
      return items.flatMap((item, index) => {
        const { room, id, name, time } = item;
        if (!readShare(`#${room}.${id}`)) return [];
        const text = Number.isFinite(time)
          ? `${name} · ${timeText(time * 1000)}`
          : name;
        const row = element('li', 'collection-row');
        const link = element('a', 'link-btn', text);
        link.href = shareUrlOf(room, id, { time });
        const move = (offset) =>
          safely(() => {
            const lists = playlists();
            const entries = lists.get(current);
            const from = entries.findIndex((entry) => entry.id === id);
            const to = from + offset;
            if (from < 0 || to < 0 || to >= entries.length) return;
            [entries[from], entries[to]] = [entries[to], entries[from]];
            write(PLAYLISTS, lists);
          });
        const remove = button('Remove', () =>
          safely(() => {
            if (mode !== 'Continue Watching') {
              return void toggleVideo(current, item);
            }
            const history = readMap(HISTORY);
            history.delete(id);
            write(HISTORY, history);
          }),
        );
        row.append(link);
        if (mode === 'Playlists') {
          const up = button('↑', () => move(-1));
          const down = button('↓', () => move(1));
          up.setAttribute('aria-label', 'Move video up');
          down.setAttribute('aria-label', 'Move video down');
          up.disabled = index === 0;
          down.disabled = index === items.length - 1;
          row.append(up, down);
        }
        row.append(remove);
        return [{ text, row }];
      });
    };
    body.append(actions, status, controls);
    paint = filteredCollection(
      controls,
      { Videos: rows },
      'No videos here yet.',
    );
    if (mode === 'Playlists') {
      const input = element('input');
      input.placeholder = 'New playlist name';
      input.setAttribute('aria-label', input.placeholder);
      input.maxLength = 70;
      const remove = button('Delete playlist', () => {
        if (
          current === LATER ||
          !window.confirm(`Delete the playlist “${current}”?`)
        ) {
          return;
        }
        safely(() => {
          const lists = playlists();
          lists.delete(current);
          write(PLAYLISTS, lists);
          current = LATER;
          remove.disabled = true;
        });
      });
      playlist.onchange = () => {
        current = playlist.value;
        remove.disabled = current === LATER;
        paint();
      };
      remove.disabled = true;
      const create = button('Create', () =>
        safely(() => {
          const lists = playlists();
          const label = namedList(input.value, lists);
          lists.set(label, []);
          write(PLAYLISTS, lists);
          current = label;
          input.value = '';
          remove.disabled = false;
        }),
      );
      actions.append(playlist, remove, input, create);
    }
    refresh();
  });
  return collection;
};

export {
  LATER,
  videoOf,
  historyOf,
  rememberPosition,
  inList,
  toggleVideo,
  addToPlaylist,
  openWatchLibrary,
};
