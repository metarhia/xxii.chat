import { isDeleted, threadsOf } from './chat.js';
import { rootOf, threadOf } from './replies.js';
import { isImage } from './files.js';
import { plainOf } from './markdown.js';
import { markdownLinks } from './markdown.js';
import { videoUrlOf } from './video-pieces.js';
import { readMap, writeMap, formatSize } from './view.js';
import {
  button,
  element,
  filteredCollection,
  openCollection,
} from './collection-dialog.js';

const SAVED = 'xxii:saved-messages';
const FOLLOWED = 'xxii:followed-threads';
const BLOCKED = 'xxii:blocked-contacts';

const rowOf = (primary, ...actions) => {
  const row = element('li', 'collection-row');
  row.append(primary, ...actions);
  return row;
};

const descriptionOf = (record, files = []) =>
  record.videoTitle ||
  record.title ||
  plainOf(record.content || '')
    .trim()
    .slice(0, 240) ||
  files.map(({ name }) => name).join(', ') ||
  'Message';

const mediaOf = ({ mime }) => isImage(mime) || /^(video|audio)\//.test(mime);

const linksOf = (content) => {
  const urls = new Map();
  for (const value of markdownLinks(content ?? '')) {
    try {
      const url = new URL(value);
      if (['http:', 'https:'].includes(url.protocol)) urls.set(url.href, url);
    } catch {
      continue;
    }
  }
  return [...urls.values()];
};

const isSaved = (chat, id) => readMap(SAVED).has(`${chat}/${id}`);

const saveRecord = (chat, record, files) => {
  const items = readMap(SAVED);
  const { id, nick } = record;
  const key = `${chat}/${id}`;
  const exists = items.delete(key);
  if (!exists) {
    items.set(key, { chat, id, nick, text: descriptionOf(record, files) });
  }
  if (!writeMap(SAVED, items)) {
    throw new Error('Could not update Saved Messages.');
  }
  return !exists;
};

const isBlocked = (peer) => Boolean(peer) && readMap(BLOCKED).has(peer);

const setBlocked = (peer, blocked) => {
  const items = readMap(BLOCKED);
  if (blocked) items.set(peer, true);
  else items.delete(peer);
  if (!writeMap(BLOCKED, items)) {
    throw new Error('Could not update blocked contacts.');
  }
};

class ChatCollections {
  constructor(app) {
    this.app = app;
  }

  openSaved() {
    const { app } = this;
    openCollection('Saved Messages', (body, close) => {
      let render = () => {};
      const note = element('textarea');
      note.placeholder = 'Write a private note';
      note.setAttribute('aria-label', note.placeholder);
      note.maxLength = 4096;
      note.rows = 2;
      let noteKey = '';
      const add = button('Save note', () => {
        const text = note.value.trim();
        if (!text) return void note.focus();
        const items = readMap(SAVED);
        const key = noteKey || `note-${crypto.randomUUID()}`;
        items.set(key, { text });
        if (!writeMap(SAVED, items)) return;
        noteKey = '';
        note.value = '';
        add.textContent = 'Save note';
        render();
      });
      const rows = () =>
        [...readMap(SAVED)].reverse().map(([key, item]) => {
          const { chat, id, text, nick } = item;
          const label = nick ? `${nick} · ${text}` : text;
          const edit = () => {
            note.value = text;
            noteKey = key;
            note.focus();
            add.textContent = 'Update note';
          };
          const open = chat
            ? button(label, () => {
                close();
                app.openLink({ chat, message: id });
              })
            : button(label, edit);
          const remove = button('Remove', () => {
            const items = readMap(SAVED);
            items.delete(key);
            if (writeMap(SAVED, items)) render();
          });
          return { text: label, row: rowOf(open, remove) };
        });
      body.append(note, add);
      render = filteredCollection(body, { Saved: rows }, 'No saved messages.');
    });
  }

  openMedia() {
    const { app } = this;
    const { chat } = app;
    const view = app.currentView();
    const entries = [...view.records.values()].filter(
      (item) => !isDeleted(item),
    );
    entries.sort((a, b) => b.timestamp - a.timestamp);
    openCollection('Shared media', (body, close) => {
      const origin = (id) =>
        button('Go to message', () => {
          close();
          app.openLink({ chat, message: id });
        });
      const files = (media) =>
        entries.flatMap(({ id }) =>
          (view.attachments.get(id) ?? [])
            .filter((file) => mediaOf(file) === media)
            .map((file) => {
              const text = `${file.name} · ${formatSize(file.size)}`;
              const open = button(text, () => app.downloadFile(file.id));
              return { text, row: rowOf(open, origin(id)) };
            }),
        );
      const videos = () =>
        entries.flatMap((record) => {
          if (!record.video) return [];
          const href = videoUrlOf(record.video, { chat, message: record.id });
          if (!href) return [];
          const text = descriptionOf(record);
          const link = element('a', 'link-btn', text);
          link.href = href;
          link.target = '_blank';
          link.rel = 'noreferrer';
          return [{ text, row: rowOf(link, origin(record.id)) }];
        });
      const sharedLinks = () =>
        entries.flatMap(({ id, content, video }) => {
          const urls = linksOf(content);
          if (video) {
            const url = videoUrlOf(video);
            if (url && !urls.some((link) => link.href === url)) {
              urls.unshift(new URL(url));
            }
          }
          return urls.map(({ href }) => {
            const link = element('a', 'link-btn', href);
            link.href = href;
            link.target = '_blank';
            link.rel = 'noreferrer';
            return { text: href, row: rowOf(link, origin(id)) };
          });
        });
      const groups = {
        Media: () => videos().concat(files(true)),
        Files: () => files(false),
        Links: sharedLinks,
      };
      filteredCollection(body, groups, 'Nothing here yet.');
    });
  }

  threadRoot(chat, id) {
    const view = threadsOf(this.app.replicaOf(chat), chat);
    return rootOf(view.records, id);
  }

  isFollowing(chat, id) {
    const root = this.threadRoot(chat, id);
    return readMap(FOLLOWED).has(`${chat}/${root}`);
  }

  follow(chat, id) {
    const root = this.threadRoot(chat, id);
    const key = `${chat}/${root}`;
    const follows = readMap(FOLLOWED);
    const existed = follows.delete(key);
    if (!existed) follows.set(key, Date.now());
    if (!writeMap(FOLLOWED, follows)) {
      throw new Error('Could not update followed threads.');
    }
    return !existed;
  }

  openFollowed() {
    const { app } = this;
    openCollection('Followed threads', (body, close) => {
      let render = () => {};
      const rows = () =>
        [...readMap(FOLLOWED)].reverse().flatMap(([key, at]) => {
          const [chat, id] = key.split('/');
          if (app.isHiddenChat(chat)) return [];
          const view = threadsOf(app.replicaOf(chat), chat);
          const root = view.records.get(id);
          if (!root) return [];
          const unread = threadOf(view.replies, id).filter(
            (reply) =>
              reply.timestamp > at &&
              reply.author !== app.peerId &&
              !isDeleted(reply),
          );
          const text = descriptionOf(root);
          const label = unread.length ? `${text} · ${unread.length} new` : text;
          const open = button(label, () => {
            const follows = readMap(FOLLOWED);
            follows.set(
              key,
              Math.max(at, ...unread.map(({ timestamp }) => timestamp)),
            );
            writeMap(FOLLOWED, follows);
            close();
            app.openLink({ chat, message: unread[0]?.id ?? id });
          });
          const remove = button('Unfollow', () => {
            this.follow(chat, id);
            render();
          });
          return [{ text: label, row: rowOf(open, remove) }];
        });
      render = filteredCollection(
        body,
        { Threads: rows },
        'No followed threads.',
      );
    });
  }
}

export { ChatCollections, linksOf, isSaved, saveRecord, isBlocked, setBlocked };
