import { markdownLinks } from './markdown.js';
import { button, element, openCollection } from './collection-dialog.js';

const PEER = /^[a-z0-9-]{1,64}$/i;
const MENTION = /^\/\?mention=([a-z0-9-]{1,64})$/i;
const REQUESTS = 'contactRequest';

const isContactPeer = (peer) => typeof peer === 'string' && PEER.test(peer);
const mentions = (text = '') => {
  if (!text || !text.includes('/?mention=')) return new Set();
  const peers = markdownLinks(text).flatMap((href) => {
    const match = MENTION.exec(href);
    return match ? [match[1]] : [];
  });
  return new Set(peers);
};

const inviteUrl = (peer) => {
  const params = new URLSearchParams({ contact: peer });
  return `${location.origin}/?${params}`;
};

const contactLink = () => {
  const peer = new URLSearchParams(location.search).get('contact');
  return isContactPeer(peer) ? peer : '';
};

const mentionText = (peer, nick) =>
  `[@${nick.replace(/[\\[\]\n]/g, ' ')}](/?mention=${peer})`;

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
      insert(mentionText(contact.peer, contact.nick));
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
  chooseMention,
  setRequest,
  requestState,
};
