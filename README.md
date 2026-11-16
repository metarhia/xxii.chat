# XXII Chat Implementation

Local-first chat on Metarhia: [impress](https://github.com/metarhia/impress)
server, [metacom](https://github.com/metarhia/metacom) transport, and
[globalstorage](https://github.com/metarhia/globalstorage) CRDT replicas with
sync. Terminal-like UI follows the
[chat terminal theme](https://www.figma.com/design/eMClRRHH4GKf3G58RhfK8d).

- Install dependencies: `npm i`, `metacom`, `globalstorage`, and `impress`
  are linked from `../..`, `../globalstorage`, and `../impress`
- Start server: `node server`
- Open in browser: [`http://127.0.0.1:8000/`](http://127.0.0.1:8000/), the
  balancer redirects to the server port `8001`
- Server data is kept in `application/data`, set `XXII_DATA` to use another
  folder
- `npm run static` copies browser builds of metacom, globalstorage, and
  metautil into `application/static`

## Features

- Contacts: every browser is a peer with a stable id, peers announce
  themselves to the server and show up with presence (online, offline,
  linked over WebRTC) and unread direct messages
- Chats: `!general` exists everywhere, new chats sync to all clients
- Feeds: `#feed` timelines of posts, the first line of a post is its title
  (`Ctrl+Enter` publishes), cards show author, date, excerpt, replies, and
  reactions, a card opens the full post in place with an outline from
  `#`, `##`, `###` headings and its replies under it
- Folders: organize chats, feeds, and nested folders (`a/b` creates a path),
  `unlisted` folders are listed only for the owner, `public` folders for
  everyone; a channel in a listed folder leaves the `FEEDS` or `CHATS` list,
  collapsed folders are remembered per browser
- Channel names may start with an emoji icon (`📣 news`), owners edit the
  description by clicking it in the top bar
- One composer for everything: `Reply` puts a `reply to` bar above it, the
  reply stays in the chat with a quote that jumps to the original; a message
  with replies shows `N replies`, which opens the thread in place (the
  message and all its replies) with the same composer, `‹` or `Esc` returns
  to the chat at the same position
- Pinned messages, clickable links, message search, older messages by pages
  of 50; consecutive messages of one author are grouped, days have sticky
  labels
- Message actions live in one menu: right click or the `⋯` handle on hover
  opens reactions, reply, thread, pin, copy, and downloads; on touch screens
  a long press lifts the message with reactions above and actions below,
  and a swipe to the left replies
- Reactions toggle: clicking your reaction again removes it, your reactions
  are highlighted, a reaction shows who reacted on hover
- Unread: per chat read time kept in the browser, badges, a `new messages`
  line, a jump-to-latest button with the count, unread total in the tab
  title and on the installed app icon
- Files: `attach`, drop, or paste files up to 10 MB into messages and posts,
  each file is stored once by its SHA-256 checksum, the download button saves
  it from OPFS, the server, or a linked peer; images show previews sized
  before loading and open in a viewer with arrows and swipe
- Composer grows with the text, keeps a draft per chat, typing anywhere
  focuses it
- Direct messages go only over WebRTC between the two browsers and are
  kept in OPFS of both, never on the server
- Automatic mesh: no host or join buttons, browsers connect to every
  online peer, group chats sync between peers while the server is down,
  and a dropped link is renegotiated through another linked peer
- Offline-first: service worker caches the app and keeps all replicas in
  OPFS, messages written offline reach the server after reconnect
- Automatic updates: the app version is shown in the sidebar and updates
  install without user action, see [Releases](#releases)
- One WebSocket connection for all tabs through `MetacomProxy`, one tab per
  browser (Web Locks) runs the WebRTC mesh for all of them
- Keyboard: `Ctrl+K` jumps to a chat, feed, or contact, `Alt+↑`/`Alt+↓`
  previous or next chat, `Ctrl+F` search, `Ctrl+P` pinned; `↑` in an empty
  composer selects the last message, `↑`/`↓` move, `Enter` or `Shift+F10`
  opens the menu, `R` replies; `Esc` closes the top overlay, cancels a reply,
  leaves a thread, or shows and hides the sidebar
- Mobile: back button closes the sidebar, panel, viewer, menu, and thread, layout
  respects safe areas and the on-screen keyboard, bigger touch targets
- Nick shared between tabs, install prompt, clear database, members list,
  and activity log

## Calls

Calls in the session block stores network settings in the browser: public
STUN off by default, user STUN and TURN servers, and force relay.

## Releases

The app version lives in `application/static/manifest.json` as `"version"`;
increase it with every release that changes static files, nothing else is
needed:

- The service worker keeps one cache per version (`xxii-<version>`) and a
  record of the active one in `xxii-meta`
- Tabs ask the worker to check on start, on server reconnect (a deploy), when
  the tab becomes visible, when the network returns, and every 30 minutes;
  the worker reads `manifest.json` from the network bypassing the HTTP cache
- A new version is downloaded into a new cache in one `addAll`, becomes
  active, old caches are removed, and every tab is told over
  `BroadcastChannel`
- A tab restarts itself when hidden, or after a minute without input when no
  unsent files, viewer, or menu are open; drafts survive the restart; the
  version label shows `v0.1.0 → v0.1.1` meanwhile, a click restarts at once
  or checks for updates when there is none

## Sync

Every copy of the chat is a globalstorage `Replica` synced with
`SyncService` (serves a replica as a metacom unit) and `Uplink` (syncs a
replica with a served one):

```text
server: Replica in application/data/chat, unit `sync`
  ^ worker Uplink over WebSocket, one connection for all tabs
worker: Replica in OPFS, unit `chat`; Replica per direct pair in OPFS
        `dm/<pair>`, unit `dm_<pair>`
  ^ tab Uplinks over MessagePort, follow a clear of the worker
tab: Replicas in memory; the mesh tab serves them to peers over WebRTC
  ^ peer Uplinks over RTCDataChannel: direct pair always, group chats
    while either side has no server
```

Records are CRDT states: fields of `author`, `chat`, `feed`, `post`,
`message`, `file` (attachment metadata), `reaction` (message, author, and
emoji switched on or off), `folder`, and `entry` (folder to channel link) are
last-writer-wins registers, so a change is applied once whichever way it
travels. A folder `parent` loop made by
concurrent moves shows the looped folders at the root. `application/static/chat.js`
validates deltas in browsers and on the server. Only one server thread
(`ports: [8001]`) owns the server replica files.

File bytes never go into replicas. A `file` record carries name, mime,
size, and checksum; the bytes live in OPFS `files/<sha256>` shared by tabs
and the worker, and on the server in `files/<sha256>` next to the replica.
The worker uploads group chat files the server is missing, the server
accepts only bytes that match a `file` record in its replica. Direct
message files are exchanged only between the two peers over WebRTC.

## Mesh

`application/static/mesh.js` runs in the tab that holds the `xxii:mesh`
lock. It announces `{ peer, nick }` with `presence/announce`, gets
`presence/update` events, and opens a link to every online peer. The peer
with the smaller id answers (serves `chat`, `direct`, and `mesh` units with
`MetacomPeer`), the other one offers (metacom client over WebRTC with
uplinks). Signaling goes through `signal/send` while the server is up, and
through `mesh/relay` of linked peers otherwise. The offering peer exchanges
files of the direct chat (and of group chats while either side has no
server) with `files/have`, `get`, and `put`.

| Call                             | Handled by  | Description                                                 |
| -------------------------------- | ----------- | ----------------------------------------------------------- |
| `sync/subscribe`, `pull`, `push` | server      | Worker replica syncs with server                            |
| `presence/announce`, `list`      | server      | Peer coordinates and presence                               |
| `signal/send`                    | server      | WebRTC signaling to a peer by id                            |
| `files/missing`, `upload`        | server      | Worker uploads attached files                               |
| `files/download`                 | server      | Tab downloads a group chat file                             |
| `chat/subscribe`, `pull`, `push` | worker      | Tab replica syncs with worker                               |
| `chat/directs`, `openDirect`     | worker      | Direct chat replicas in OPFS                                |
| `dm_<pair>/pull`, `push`, ...    | worker      | Tab direct replica syncs                                    |
| `chat/username`                  | worker      | Pass nick to other tabs                                     |
| `chat/clear`                     | worker      | Clear worker replicas, tabs follow                          |
| `cache/check`                    | worker      | Check and install a new version                             |
| `chat`, `direct` units           | answer peer | Offer peer syncs over WebRTC                                |
| `mesh/relay`, `mesh/state`       | answer peer | Relay signaling, server state                               |
| `files/have`, `get`, `put`       | answer peer | File exchange between peers                                 |
| `ice/servers`                    | server      | ICE server list for the call tab; host is location.hostname |

## Testing

- `npm test`: lint and types
- `npm run test:app`: application tests in impress test mode
- `npm run test:calls`: headless Chrome with fake camera, microphone, and
  screen capture for call scenarios
- `node --test test/ice.js`: STUN and TURN URL checks. Calls network
  settings keep public STUN off by default, store user servers, and can
  force relay
- `npm run test:browser`: the chat scenarios and `test:calls`; tabs, chats,
  menu reactions that toggle, quoted replies, threads, pins, feeds opened
  in place, keyboard selection, `Esc`,
  `Ctrl+K`, drafts, swipe and long press,
  folders and their visibility between peers, offline writes, OPFS,
  automatic WebRTC links, direct messages, files through the server and
  peer to peer, image previews and viewer, group sync and relayed
  reconnection without server, clear database, and an automatic update to
  a new version and back in headless Chrome;
  ports `8000` and `8001` must be free
