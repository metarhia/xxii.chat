# XXII Chat Implementation

Local-first chat on Metarhia: [impress](https://github.com/metarhia/impress)
server, [metacom](https://github.com/metarhia/metacom) transport, and
[globalstorage](https://github.com/metarhia/globalstorage) CRDT replicas with
sync. Terminal-like UI follows the
[chat terminal theme](https://www.figma.com/design/eMClRRHH4GKf3G58RhfK8d).

- Install dependencies: `npm i`, `metacom`, `globalstorage`, `impress`, and
  `metaice` are linked from `../..`, `../globalstorage`, `../impress`, and
  `../metaice`
- Start server: `node server`
- The `api` group serves the app on `XXII_PORT` (default `8000`):
  [`http://127.0.0.1:8000/`](http://127.0.0.1:8000/). One port, no balancer,
  so call state stays in that thread
- The `rtc` group serves STUN and TURN on `XXII_ICE_PORT` (default `3478`)
  over UDP and TCP. metaice is the provider behind that group, and impress
  owns the sockets
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
- Replies stay in the chat in time order. A thread contains a root message
  and all its replies. Each thread uses one of 32 colors for author nicks
  and the stripe at the left of each row. The root shows a right-pointing
  reply arrow, the count, and up to three author initials. Phones show the
  arrow and count.
- Start a reply with the hover reply button, `R` on the selected message,
  a double click or tap, or a swipe to the right on touch screens. Start
  the swipe at least 24 px from the left edge. Drag to select text.
- `Reply with quote` in the message menu quotes the start of the message
  or the text you selected in that message, up to 300 characters. Reply
  gestures also quote text selected in the message. The quote appears on
  every peer. Click a quote to jump to its message. For distant jumps,
  `↓ back` returns to the reply.
- Click or tap any thread message, its root's reply counter, or a quote to
  select the thread. The chosen message, its ancestors, and its replies
  get a wider stripe, and other threads and standalone messages dim.
  The selection bar shows the chosen message's position and buttons to
  step through the thread. Select another thread to switch. Click outside
  the thread, use the selection bar's `✕`, press `Esc`, or use the phone's
  back button to clear. Clearing restores the saved scroll position after
  a jump or step. If the root is above the loaded messages, selection
  loads up to 10 older pages.
- The composer replies to the latest message of the selected thread by
  default. Click a member of the selected thread to reply to it. The reply
  bar's `✕` makes the next send a plain message and clears the selection
  when it is sent.
- Pinned messages, clickable links, message search, older messages by pages
  of 50; consecutive messages of one author are grouped, days have sticky
  labels
- Message actions live in one menu: right click or the `⋯` handle on hover
  opens reactions, reply, thread selection, pin, copy, and downloads; on touch screens
  a long press lifts the message with reactions above and actions below,
  and a swipe to the right replies, a double tap replies too
- Reactions toggle: clicking your reaction again removes it, your reactions
  are highlighted, a reaction shows who reacted on hover
- Replies to me: `↩ N` next to the unread count in the chat header and the
  chat list counts unread replies to your messages. Click it to select the
  thread of the next unread reply and jump to it
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
  opens the menu, `R` replies, and `F` selects the thread of the current
  message. Use `[`, `]`, `↑`, or `↓` to step through the selected thread.
  `Esc` closes the top overlay, clears a reply target or thread selection,
  closes an open post, or toggles the sidebar
- Mobile: the back button closes the sidebar, panel, viewer, menu, thread
  selection, or post. The layout respects safe areas and the on-screen
  keyboard and offers bigger touch targets
- Nick shared between tabs, install prompt, clear database, members list,
  and activity log

## Calls

Calls in the session block stores network settings in the browser: public
STUN off by default, user STUN and TURN servers, and force relay.
The chat topbar starts a call. A direct call rings in every tab of the
other person: video, audio, and decline, a generated tone, and a system
notification while the page is hidden. Decline or a miss leaves a
missed-call card with call back. Notification permission is requested once
when starting, joining, or accepting a call, while permission is undecided.
The prompt does not hold up the call. A notification click focuses the tab
that rang, a recent app window, or opens the app; answer in the call toast.

The share control sends a screen or window and its available audio to everyone
in the call, including later arrivals. Its menu can capture without sharing,
keeping the source local, and switch between detail and 30 fps video mode.
Stopping capture in the browser or leaving the call releases the source.

Call senders budget bandwidth per participant count and receiver tile size.
Hidden tiles pause their camera encoding on that link and resume when shown.
Each remote tile menu has an audio-only control for both camera directions, with
a suggestion after sustained poor quality. Five poor seconds lower camera
quality one row; twenty clean seconds restore one row. Screen sharing keeps
its own budget. Browsers without the required controls show a notice.

The call view offers Auto, Grid, Spotlight and Sidebar layouts, self and
camera visibility options, and strip placement. Double-click a tile to pin
or unpin it. Auto features a shared screen; Spotlight follows the active
speaker. Speaking tiles show a green bar and an avatar ring that follows the
microphone level. The mini call follows the active speaker. Press `F` outside
text fields for full screen, or `Ctrl+Alt+L` to cycle layouts.

The call controls have a hand button and a reactions menu. Raised hands are
call state: the People panel lists them first, ordered by raise time, and
tiles show the order number. Anyone lowers their own hand; admins lower any
hand from the tile menu or the People panel, or all hands at once. A hand
also lowers itself after three seconds of speaking unless auto-lower is off
in Calls settings. The reactions 👍 ❤️ 😂 😮 👏 🎉 float up from the sender's tile for three
seconds. They travel as `reaction` messages on the call data channel, at most
three per second per sender.

Shortcuts in a call: `Ctrl+D` mutes and unmutes, `Ctrl+E` turns the camera
on and off, `Ctrl+Alt+H` raises and lowers the hand, `Ctrl+Alt+S` starts and
stops screen sharing, `Ctrl+Alt+L` cycles layouts, `F` toggles full screen,
and `Esc` closes open menus without leaving the call. The combinations with
`Ctrl` also work in the composer; `F` and `Space` do not fire in text fields.
Hold `Space` outside text fields while muted to talk: the microphone opens
while the key is down and closes on release, when the window loses focus, or
when the tab is hidden. The `more` menu lists the keys and offers
picture-in-picture: in browsers with Document Picture-in-Picture the call
moves into a small window with the active speaker, mic, camera, hand,
reactions, and leave, and closing it returns to the mini call; elsewhere the
menu says that it is not available. Every control is reachable with `Tab` and
operated with `Enter` or `Space`.

The sidebar’s session block and the call’s more menu open Calls settings.
This browser remembers device choices, join defaults, camera mirroring,
noise suppression, push-to-talk, auto-lower, and network settings. The mic
chevron offers a device picker, noise suppression, and push-to-talk. Recording
defaults include layout, audio mode, quality, and a folder in browsers with
directory access. A speaker test plays a short tone on the selected output.

Mirror camera is on by default, in the camera menu and Calls settings. The
camera is flipped once at capture, so the self view, the preview, the mini
call, and what other people receive all show the same picture; with it off
nothing is mirrored. Toggling it in a call swaps the camera track without
renegotiation. Screen shares are never mirrored. If the browser cannot
mirror, the raw camera is used with a notice, and the stats overlay on your
own tile shows the mirror path.

Recording is local: the record control starts a recording of the call in
this browser, nothing is uploaded. The recorder composes its own picture, the
program, from the call (active speakers, a grid, or chosen people, with the
shared screen, an others panel, name chips, and an avatar or nothing for
people without video) and mixes its own sound (everyone, only people on
screen, others quieter, or a volume per person). The record panel, opened from
the record control menu, has these options with a live preview of the program,
and every change applies on the next frame; quality (720p30, 1080p30,
1080p60) is fixed while recording. The panel starts from the layout, audio,
and quality defaults of Calls settings. The browser picks the first format it
can encode: MP4 with H.264 and AAC, MP4 with H.264 and Opus (Chrome on Linux),
WebM with VP9 and Opus, then VP8. Chunks of one second go to a dedicated worker
that writes the file into the browser storage (OPFS, `recordings/<id>/` with
`program.mp4` or `program.webm`, `poster.jpg`, and `meta.json` holding the
state, size, duration, MIME, options, and people); it flushes every 5 seconds
and saves the metadata every 10, so a crash loses only the last seconds. WebM
gets its duration written into the header, MP4 needs no fix. Pause leaves no
gap in the file. The recorder asks the browser for persistent storage once,
warns below 2 GB of free space, and stops below 500 MB. While recording the
topbar shows `● nick recording` to everyone in the call, the record control
shows a red dot with time and size, and the chat gets a `● nick recorded 12
min` note. The recorder keeps rendering when its tab is hidden: it asks other
people for video sized to their tiles of the program, so they keep sending
even though the hidden call view asks for nothing. Leaving the call asks
whether to stop the recording. A recording plays from `/recordings/<id>/<file>`,
served by the service worker from OPFS with `Range` support. Anyone in the call can
opt out of other people's recordings from the recording notice or the People
panel: the recording then shows `opted out` instead of their video and drops
their voice within a frame, and the roster marks them. The recorder's app
honors this; a modified app could ignore it.

Phones show the active tile above a horizontally scrollable strip with the
controls above the safe area. Chat and People open as bottom sheets. Back
closes the sheet, then returns to the mini call. The camera menu switches
between front and back cameras. On Android and iOS the camera pauses while
the tab is hidden and resumes on return. The call requests a screen wake lock
when available. Nearby joins and leaves share a toast for calls of up to eight.
Screen readers also announce raised hands and host requests.

Tile options open with the ellipsis, keyboard focus, or touch long press.
The menu offers pin, full screen, audio only, stats, and local volume from
0–200%. Volume is remembered per peer for all their microphone and screen
audio tracks. Boost uses Web Audio; a visible notice explains a 100% limit
when unavailable. Recording will have an independent audio mix. Escape closes
the menu and returns focus. The view menu toggles stats for all remote tiles;
each tile can also show or hide its own stats. Connection bars use RTT and
loss. Stats include bitrate, codecs, video size and frame rate, and candidate
types where the browser supplies them, reusing the bandwidth policy sample.

## STUN and TURN

STUN and TURN are metaice behind the `rtc` group. impress owns the sockets.
`application/config/metaice.js` keeps the host, external servers, secret, and
port that build the ICE server list.

- `XXII_PORT` defaults to `8000` when unset. It is the `api` group port.
- `XXII_ICE_PORT` defaults to `3478` when unset or empty. It is the `rtc`
  group port over UDP and TCP, and the port in the ICE server list. `0`
  means port `0`.
- `XXII_TURN_SECRET` defaults to empty. Empty turns TURN off and leaves STUN
  on.
- `XXII_TURN_PUBLIC_ADDRESS` defaults to empty when unset. It is the numeric
  relay address.
- `XXII_TURN_PRIVATE_PEERS` defaults to `false`. Exactly `true` sets
  `allowPrivatePeers`. Anything else, including unset, is `false`.

The same server can run as the `metaice` CLI: `metaice [config]`. The
config is a `.js` or `.json` options file. `SIGINT` and `SIGTERM` exit 0.
A failed listen exits 1.

Open the ICE port for UDP and TCP and the relay range for UDP. The default
relay range is `49160-49359`. Open the TLS port only when TLS is configured.

Calls settings still hold public STUN, user servers, and force relay.

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
validates deltas in browsers and on the server. Only the `api` thread
owns the server replica files.

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

| Call                             | Handled by  | Description                                                        |
| -------------------------------- | ----------- | ------------------------------------------------------------------ |
| `sync/subscribe`, `pull`, `push` | server      | Worker replica syncs with server                                   |
| `presence/announce`, `list`      | server      | Peer coordinates and presence                                      |
| `signal/send`                    | server      | WebRTC signaling to a peer by id                                   |
| `files/missing`, `upload`        | server      | Worker uploads attached files                                      |
| `files/download`                 | server      | Tab downloads a group chat file                                    |
| `chat/subscribe`, `pull`, `push` | worker      | Tab replica syncs with worker                                      |
| `chat/directs`, `openDirect`     | worker      | Direct chat replicas in OPFS                                       |
| `dm_<pair>/pull`, `push`, ...    | worker      | Tab direct replica syncs                                           |
| `chat/username`                  | worker      | Pass nick to other tabs                                            |
| `chat/clear`                     | worker      | Clear worker replicas, tabs follow                                 |
| `xxii:client`, `xxii:ring`       | worker      | Notification source identity and incoming ring fallback            |
| `cache/check`                    | worker      | Check and install a new version                                    |
| `chat`, `direct` units           | answer peer | Offer peer syncs over WebRTC                                       |
| `mesh/relay`, `mesh/state`       | answer peer | Relay signaling, server state                                      |
| `files/have`, `get`, `put`       | answer peer | File exchange between peers                                        |
| `CallSession` event `stats`      | call tab    | Per-link RTT, loss, streams and candidates sampled once per second |
| `call/update`                    | server      | Mic, camera, shared screen, and raised hand for the endpoint       |
| `reaction` peer message          | call link   | One emoji from the reaction set, at most 3 per second per sender   |
| `hint` peer message              | call link   | Rendered slot size, frame cap, and camera audio-only request       |
| `ice/servers`                    | server      | ICE server list for the call tab; host is location.hostname        |

## Testing

- `npm test`: lint and types
- `npm run test:app`: application tests in impress test mode
- `npm run test:calls`: headless Chrome with fake camera, microphone, and
  screen capture for call scenarios
- `node --test test/ice.js`: STUN and TURN URL checks. Calls network
  settings keep public STUN off by default, store user servers, and can
  force relay
- `npm run test:browser`: the chat scenarios and `test:calls`; tabs, chats,
  menu reactions that toggle, quoted replies, thread selection, pins, feeds opened
  in place, keyboard selection, `Esc`,
  `Ctrl+K`, drafts, swipe and long press,
  folders and their visibility between peers, offline writes, OPFS,
  automatic WebRTC links, direct messages, files through the server and
  peer to peer, image previews and viewer, group sync and relayed
  reconnection without server, clear database, and an automatic update to
  a new version and back in headless Chrome;
  `test/call-scenarios.js` runs the Chrome call scenarios (media both ways,
  mute and camera, a third participant, liveness, and resume after restart);
  `test/call-ring.js` rings a direct call in two tabs, declines to a missed
  card, and accepts into one link each way; real mouse and keyboard gestures
  check permission timing, one pending prompt, and granted/denied states;
  `node --test test/call-notifications.js` checks notification click focus
  priority, app window matching, source identity, and permission failures;
  native permission prompts and OS notification clicks need a manual check;
  `node --test test/media-capture.js` checks capture cleanup, focus, mode,
  cancellation, local-only slots, and stale picker results;
  `test/call-media.js` checks screen video and audio, stop, local capture,
  and sharing inherited by a later participant (scenario 7);
  `node --test test/media-policy.js` checks bandwidth rows, hint validation,
  scaling, adaptation timing, sender controls, audio-only and view visibility;
  `test/call-bandwidth.js` checks four-person bitrate, hidden tile pause and
  restoration, and both camera directions in audio-only mode (scenario 8);
  `node --test test/call-speaker.js test/call-layout.js` checks speaker hold
  clocks, candidate stability, layout geometry, filtering and pin priority;
  `test/call-layouts.js` checks layout controls, double-click pinning, screen
  Auto, hidden tiles, real remote speaking levels and the mini call;
  `node --test test/call-stats.js test/call-volume.js` checks stats deltas,
  missing fields, connection bars, peer volume storage, gain and cleanup;
  `test/call-tiles.js` checks menus, volume, restoration, real Chrome stats,
  screen audio and teardown;
  `test/call-turn.js` forces relay through the `rtc` group and checks
  that both sides select a relay pair while audio and video flow
  (scenario 9), and again through TURN over TLS on a port that also
  offers HTTP;
  `test/call-link.js` checks link policy: without a token the visitor
  waits in the lobby until an admin admits them, a token joins, and a
  lock denies (scenario 10);
  `test/call-host.js` checks ask to mute, remove, and end for everyone
  (scenario 11);
  `test/call-hands.js` covers hand order, reactions, membership toasts and
  screen reader announcements. `test/call-keys.js` covers shortcuts,
  keyboard menus and picture-in-picture. `test/call-settings.js` checks
  settings validation, migration and toast timing. `test/call-phone.js`
  checks saved defaults, push-to-talk, auto-lower, mobile controls and Back;
  `test/call-mirror.js` checks the mirrored self view and remote tile, the
  toggle without renegotiation, the stats path, and camera off (scenario 23);
  `npm run test:app` reserves two different free ports and passes them as
  `XXII_PORT` and `XXII_ICE_PORT`, then runs `MODE=test node server.js`, so
  it does not bind `8000` or `3478`. The browser harness picks free
  `XXII_PORT` and `XXII_ICE_PORT`
  (not `0`, and not a port it found busy) and opens that api port
