import { plainOf } from './markdown.js';
import { read } from './app-settings.js';
import { containerOf, isDeleted, isPair } from './chat.js';

const TEXT_LIMIT = 100;
const NO_TEXT = 'New message';
const TIMELINE = ['message', 'post'];

const bodyOf = (content, withText) => {
  if (!withText || typeof content !== 'string') return NO_TEXT;
  const text = plainOf(content).trim().slice(0, TEXT_LIMIT);
  return text === '' ? NO_TEXT : text;
};

const kindOf = ({ isDirect, isReply, isMention, settings }) => {
  if (isMention && settings.notifyReplies) return 'mention';
  if (isDirect && settings.notifyDirect) return 'direct';
  if (isReply && settings.notifyReplies) return isDirect ? 'direct' : 'reply';
  return '';
};

const noticeOf = ({
  id,
  record,
  parent,
  me,
  settings,
  names,
  isHidden,
  isMention,
  isFollowed,
  canDirect,
}) => {
  const chat = containerOf(record);
  const isOwn = record.author === me;
  if (chat === undefined || isOwn || isDeleted(record)) return null;
  if (isHidden?.(chat, record)) return null;
  const isDirect = isPair(chat);
  if (isDirect && canDirect?.(chat) === false) return null;
  const isReply =
    parent?.author === me ||
    Boolean(parent && isFollowed?.(chat, record.replyTo));
  const kind = kindOf({
    isDirect,
    isReply,
    isMention: isMention?.(record),
    settings,
  });
  if (kind === '') return null;
  const nick = record.nick || names.nick(record.author);
  const place = kind === 'reply' ? ` replied in ${names.chat(chat)}` : '';
  const title =
    kind === 'mention'
      ? `${nick} mentioned you in ${names.chat(chat)}`
      : `${nick}${place}`;
  const body = bodyOf(record.content, settings.notifyText);
  const tag = `message:${id}`;
  return { type: 'xxii:notify', title, body, tag, chat, message: id };
};

const canNotify = () => {
  const isHidden = globalThis.document?.hidden === true;
  return isHidden && globalThis.Notification?.permission === 'granted';
};

const postNotice = async (notice) => {
  const worker = globalThis.navigator?.serviceWorker;
  if (!worker?.ready) return;
  const registration = await worker.ready;
  registration.active?.postMessage(notice);
};

class MessageNotices {
  #seen = new Set();
  #from = Date.now();

  constructor(hooks) {
    this.hooks = hooks;
  }

  watch(replica) {
    replica.on('log', (event) => this.receive(replica, event));
    replica.on('clear', () => this.reset());
  }

  reset() {
    this.#from = Date.now();
    this.#seen.clear();
  }

  receive(replica, { deltas }) {
    for (const { entity, target } of deltas) {
      if (!TIMELINE.includes(entity) || this.#seen.has(target)) continue;
      const record = replica.get(target);
      if (!record || !(record.timestamp > this.#from)) continue;
      this.#seen.add(target);
      this.notify(replica, target, record);
    }
  }

  notify(replica, id, record) {
    if (!canNotify()) return;
    const { hooks } = this;
    const settings = read(globalThis.localStorage);
    const parent = record.replyTo ? replica.get(record.replyTo) : null;
    const names = hooks.names;
    const notice = noticeOf({
      id,
      record,
      parent,
      me: hooks.me(),
      settings,
      names,
      isHidden: hooks.isHidden,
      isMention: hooks.isMention,
      isFollowed: hooks.isFollowed,
      canDirect: hooks.canDirect,
    });
    if (notice) postNotice(notice).catch(() => undefined);
  }
}

export { noticeOf, bodyOf, MessageNotices, canNotify };
