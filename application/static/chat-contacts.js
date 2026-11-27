import { markdownLinks, parseMarkdown } from './markdown.js';
import { MAX_MENTION_TARGETS, readMentionTargets } from './chat.js';
import { button, element, openCollection } from './collection-dialog.js';

const PEER = /^[a-z0-9-]{1,64}$/i;
const MENTION = /^\/\?mention=([a-z0-9-]{1,64})$/i;
const REQUESTS = 'contactRequest';

const isContactPeer = (peer) => typeof peer === 'string' && PEER.test(peer);
const TAG = /(?<![\p{L}\p{M}\p{N}_#-])#[\p{L}\p{M}\p{N}_-]+/gu;

const mentionTag = (nick) => {
  const slug = nick.trim().replace(/[^\p{L}\p{M}\p{N}_-]+/gu, '_');
  return `#${slug || 'contact'}`;
};

const visitText = (nodes, map) =>
  nodes.flatMap((node) => {
    if (Array.isArray(node)) return [visitText(node, map)];
    if (node.type === 'text') return map(node);
    if (node.type !== 'link' && node.type !== 'quote') {
      for (const key of ['children', 'items', 'head', 'rows']) {
        if (node[key]) node[key] = visitText(node[key], map);
      }
    }
    return [node];
  });

const mentionTags = (text) =>
  new Set(Array.from(text.matchAll(TAG), ([tag]) => tag.toLowerCase()));

const resolveMentions = (text, contacts, selected = new Map()) => {
  if (!text.includes('#')) return '[]';
  const peers = new Map();
  for (const { peer, nick } of contacts) {
    if (!isContactPeer(peer)) continue;
    const tag = mentionTag(nick).toLowerCase();
    peers.set(tag, peers.has(tag) ? '' : peer);
  }
  const references = new Map();
  visitText(parseMarkdown(text), (node) => {
    for (const tag of mentionTags(node.text)) {
      const peer = selected.get(tag) || peers.get(tag);
      if (peer && references.size < MAX_MENTION_TARGETS) {
        references.set(tag, peer);
      }
    }
    return [node];
  });
  return JSON.stringify([...references]);
};

const markMentions = (blocks, value) => {
  const targets = readMentionTargets(value);
  if (!targets?.size) return;
  visitText(blocks, (node) => {
    const items = [];
    let start = 0;
    for (const { 0: tag, index } of node.text.matchAll(TAG)) {
      const peer = targets.get(tag.toLowerCase());
      if (!peer) continue;
      if (index > start) {
        items.push({ type: 'text', text: node.text.slice(start, index) });
      }
      items.push({
        type: 'link',
        href: `/?mention=${peer}`,
        children: [{ type: 'text', text: tag }],
      });
      start = index + tag.length;
    }
    if (start === 0) return [node];
    if (start < node.text.length) {
      items.push({ type: 'text', text: node.text.slice(start) });
    }
    return items;
  });
};

const mentions = ({ content, title, mentions: value }) => {
  const targets = readMentionTargets(value);
  const text = [title, content].filter(Boolean).join('\n');
  const peers = new Set();
  if (targets?.size) {
    visitText(parseMarkdown(text), (node) => {
      for (const tag of mentionTags(node.text)) {
        const peer = targets.get(tag);
        if (peer) peers.add(peer);
      }
      return [node];
    });
  }
  if (text.includes('/?mention=')) {
    for (const href of markdownLinks(text)) {
      const match = MENTION.exec(href);
      if (match) peers.add(match[1]);
    }
  }
  return peers;
};

const inviteUrl = (peer) => {
  const params = new URLSearchParams({ contact: peer });
  return `${location.origin}/?${params}`;
};

const contactLink = () => {
  const peer = new URLSearchParams(location.search).get('contact');
  return isContactPeer(peer) ? peer : '';
};

const requestKey = (peer) => `request-${peer}`;

const requestOf = (replica, chat, peer) => {
  const record = replica.get(requestKey(peer));
  return record?.chat === chat && record.author === peer ? record.state : '';
};

const setRequest = (replica, chat, author, state, nick) =>
  replica.assign(REQUESTS, requestKey(author), { chat, author, state, nick });

const requestState = (replica, chat, me, peer) => {
  const mine = requestOf(replica, chat, me);
  const theirs = requestOf(replica, chat, peer);
  if (mine === 'accepted' || theirs === 'accepted') return '';
  if (mine === 'declined' || theirs === 'declined') return 'declined';
  if (theirs === 'requested') return 'incoming';
  return mine === 'requested' ? 'outgoing' : '';
};

const chooseMention = (contacts, insert) => {
  openCollection('Mention someone', (body, close) => {
    const select = element('select');
    select.setAttribute('aria-label', 'Contact');
    for (const { peer, nick } of contacts) {
      if (!isContactPeer(peer)) continue;
      const option = element('option', '', `${nick} · ${peer.slice(0, 8)}`);
      option.value = peer;
      select.append(option);
    }
    const add = button('Insert mention', () => {
      const contact = contacts.find(({ peer }) => peer === select.value);
      if (!contact) return;
      close();
      insert(mentionTag(contact.nick), contact.peer);
    });
    add.disabled = select.options.length === 0;
    const tools = element('div', 'collection-toolbar');
    tools.append(select, add);
    body.append(tools);
  });
};

export {
  isContactPeer,
  inviteUrl,
  contactLink,
  mentions,
  markMentions,
  mentionTags,
  resolveMentions,
  chooseMention,
  setRequest,
  requestState,
};
