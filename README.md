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

- Chats: `!general` exists everywhere, new chats sync to all clients
- Messages and reactions, unread badges, last activity, message search,
  older messages loaded by pages of 50
- Offline-first: service worker caches the app and keeps the chat in OPFS,
  messages written offline reach the server after reconnect
- One WebSocket connection for all tabs through `MetacomProxy`
- WebRTC peers: host in one browser, join in another, chat keeps going
  over the data channel while the server is down
- Nick shared between tabs, install prompt, cache update, clear database,
  and activity log

## Sync

Every copy of the chat is a globalstorage `Replica` synced with
`SyncService` (serves a replica as a metacom unit) and `Uplink` (syncs a
replica with a served one):

```text
server: Replica in application/data/chat, unit `sync`
  ^ worker Uplink over WebSocket, one connection for all tabs
worker: Replica in OPFS, unit `chat`
  ^ tab Uplink over MessagePort, follows a clear of the worker
tab: Replica in memory, host tab serves it to a peer over WebRTC
  ^ guest Uplink over RTCDataChannel
```

Records are CRDT states: chat and message fields are last-writer-wins
registers, reactions are per-replica counters, so a reaction is counted once
whichever way it travels. `application/static/chat.js` validates deltas in
browsers and on the server. Only one server thread (`ports: [8001]`) owns
the server replica files.

| Call                             | Handled by | Description                       |
| -------------------------------- | ---------- | --------------------------------- |
| `sync/subscribe`, `pull`, `push` | server     | Worker replica syncs with server  |
| `signal/join`, `signal/publish`  | server     | WebRTC signaling between browsers |
| `chat/subscribe`, `pull`, `push` | worker     | Tab replica syncs with worker     |
| `chat/username`                  | worker     | Pass nick to other tabs           |
| `chat/clear`                     | worker     | Clear worker replica, tabs follow |
| `cache/update`                   | worker     | Reload static cache               |
| `chat/subscribe`, `pull`, `push` | host tab   | Guest tab syncs over WebRTC       |

## Testing

- `npm test`: lint and types
- `npm run test:app`: application tests in impress test mode
- `npm run test:browser`: tabs, chats, offline writes, OPFS, WebRTC peers,
  and clear database in headless Chrome; ports `8000` and `8001` must be free
