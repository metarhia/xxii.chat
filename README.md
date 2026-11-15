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
  reactions, `POST DETAILS` panel shows the full post, stats, outline from
  `#`, `##`, `###` headings, and threaded replies
- Folders: organize chats, feeds, and nested folders (`a/b` creates a path),
  `unlisted` folders are listed only for the owner, `public` folders for
  everyone; a channel in a listed folder leaves the `FEEDS` or `CHATS` list,
  collapsed folders are remembered per browser
- Channel names may start with an emoji icon (`📣 news`), owners edit the
  description by clicking it in the top bar
- Messages with reactions, threads (replies), pinned messages, unread
  badges, last activity, message search, older messages by pages of 50
- Direct messages go only over WebRTC between the two browsers and are
  kept in OPFS of both, never on the server
- Automatic mesh: no host or join buttons, browsers connect to every
  online peer, group chats sync between peers while the server is down,
  and a dropped link is renegotiated through another linked peer
- Offline-first: service worker caches the app and keeps all replicas in
  OPFS, messages written offline reach the server after reconnect
- One WebSocket connection for all tabs through `MetacomProxy`, one tab per
  browser (Web Locks) runs the WebRTC mesh for all of them
- Keyboard: `Ctrl+F` search, `Ctrl+P` pinned, `Esc` closes panels
- Nick shared between tabs, install prompt, cache update, clear database,
  members list, and activity log

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
`message`, `folder`, and `entry` (folder to channel link) are
last-writer-wins registers, reactions are per-replica counters, so a change
is applied once whichever way it travels. A folder `parent` loop made by
concurrent moves shows the looped folders at the root. `application/static/chat.js`
validates deltas in browsers and on the server. Only one server thread
(`ports: [8001]`) owns the server replica files.

## Mesh

`application/static/mesh.js` runs in the tab that holds the `xxii:mesh`
lock. It announces `{ peer, nick }` with `presence/announce`, gets
`presence/update` events, and opens a link to every online peer. The peer
with the smaller id answers (serves `chat`, `direct`, and `mesh` units with
`MetacomPeer`), the other one offers (metacom client over WebRTC with
uplinks). Signaling goes through `signal/send` while the server is up, and
through `mesh/relay` of linked peers otherwise.

| Call                             | Handled by  | Description                        |
| -------------------------------- | ----------- | ---------------------------------- |
| `sync/subscribe`, `pull`, `push` | server      | Worker replica syncs with server   |
| `presence/announce`, `list`      | server      | Peer coordinates and presence      |
| `signal/send`                    | server      | WebRTC signaling to a peer by id   |
| `chat/subscribe`, `pull`, `push` | worker      | Tab replica syncs with worker      |
| `chat/directs`, `openDirect`     | worker      | Direct chat replicas in OPFS       |
| `dm_<pair>/pull`, `push`, ...    | worker      | Tab direct replica syncs           |
| `chat/username`                  | worker      | Pass nick to other tabs            |
| `chat/clear`                     | worker      | Clear worker replicas, tabs follow |
| `cache/update`                   | worker      | Reload static cache                |
| `chat`, `direct` units           | answer peer | Offer peer syncs over WebRTC       |
| `mesh/relay`, `mesh/state`       | answer peer | Relay signaling, server state      |

## Testing

- `npm test`: lint and types
- `npm run test:app`: application tests in impress test mode
- `npm run test:browser`: tabs, chats, threads, pins, feeds and post
  details, folders and their visibility between peers, offline writes, OPFS,
  automatic WebRTC links, direct messages, group sync and relayed
  reconnection without server, and clear database in headless Chrome;
  ports `8000` and `8001` must be free
