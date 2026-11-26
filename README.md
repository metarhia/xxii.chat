# XXII Chat Implementation

Local-first chat on Metarhia: [impress](https://github.com/metarhia/impress)
server, [metacom](https://github.com/metarhia/metacom) transport, and
[globalstorage](https://github.com/metarhia/globalstorage) CRDT replicas with
sync. Terminal-like UI follows the
[chat terminal theme](https://www.figma.com/design/eMClRRHH4GKf3G58RhfK8d).

- Run `npm ci` to install metacom and globalstorage from `master`,
  metaice from `main`, and impress from `metacom-4`.
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
  reply arrow and the reply count.
- Start a reply with the hover reply button, `R` on the selected message,
  a double click or tap, or a swipe to the right on touch screens. Start
  the swipe at least 24 px from the left edge. Drag to select text.
- `Quote` in the message menu quotes the start of the message
  or the text you selected in that message, up to 300 characters. Right-click
  selected message text to open the menu. Reply gestures also quote text
  selected in the message. The quote appears on
  every peer. Click a quote to jump to its message. For distant jumps,
  `↓ back` returns to the reply.
- Click or tap any thread message, its root's reply counter, or a quote to
  select the thread. All its rows take one shade of the thread color and
  the chosen message a stronger one, so stepping changes only two rows.
  Other threads and standalone messages dim, and their stripes darken.
  The bar above the messages shows the chosen message's position and buttons
  to step through the thread. Select another thread to switch. Click the chosen
  message again or click outside the thread to clear. The selection bar's `✕`,
  `Esc`, and the phone's back button also clear it. Clearing restores the saved
  scroll position after a jump or step. If the root is above the loaded
  messages, selection loads up to 10 older pages.
- The composer replies to the latest message of the selected thread by
  default. Click a member of the selected thread to reply to it. Thread
  selection keeps the composer clear of quote previews. Use `Quote` to
  include quoted text and the thread bar's `✕` to leave the thread.
- Pinned messages, clickable links, message search, older messages by pages
  of 50; consecutive messages of one author are grouped, days have sticky
  labels
- A message row shows the nick on the left and the time on the right. On
  hover the time gives way to a toolbar: reply, share, forward, edit and
  delete for your own messages, select, and `⋯` for the menu
- The menu opens with right click or `⋯` and has reactions and icons for
  Reply, Quote, Thread, the toolbar actions, Pin, Copy text, and downloads.
  On touch screens a long press lifts the message with
  reactions above and actions below, and a swipe to the right replies, a
  double tap replies too
- Every menu of the app is one component with menu roles. `↓`/`↑` move
  through the items and wrap around, `Home` and `End` jump, `Enter` and
  `Space` choose, a letter jumps to the next item that starts with it, and
  `←`/`→` move inside a row of choices. Disabled items are skipped and say
  why in a muted line. `Esc` closes the menu and returns focus to its
  button, `Tab` closes it and moves on, and only one menu is open at a time.
  A menu next to a button opens above or below it, whichever has room,
  and closes on a click outside, a scroll of the list behind it, or a
  resize. On a phone every menu is a bottom sheet over a dimmed screen: a
  swipe down or the back button closes it
- Share puts `/?chat=<id>&message=<id>` on the clipboard. Opening it switches
  to the chat and scrolls to the message once it is loaded
- Forward picks a chat or contact in the jump dialog and posts a copy with
  its text and files there, marked `from <nick>`; a click on the mark opens
  the original
- Edit opens an editor in the message row. `Save` or `Enter` saves, and
  `Cancel` or `Esc` closes the editor. `Shift`+`Enter` inserts a line break.
  The main composer keeps its draft, and the message shows `edited` after
  saving. Delete asks first and clears the text. A deleted message
  without replies disappears, one with replies stays as `message deleted`
  so its thread keeps its shape and color
- Select starts picking messages: a click toggles one, `Shift`+click adds a
  range, and the bar copies them as `nick: text` lines, forwards them, or
  deletes them when all are yours; `Esc` or `✕` ends it
- Reactions toggle: clicking your reaction again removes it, your reactions
  are highlighted, and a reaction shows who reacted on hover. Messages show
  their active reactions. Hover over a message with reactions to see all nine
  options (👍 ❤️ 😂 😮 😢 🔥 🤔 💯 👎). Open the message menu to add the first
  reaction or to choose any reaction on a touch screen.
- Markdown: messages and posts render headings, emphasis, lists, task
  lists, quotes, tables, links, and fenced code with syntax highlighting.
  The composer, the editor, and `Copy text` keep the raw text, and images
  never load
- Call records in the chat are compact cards: the host nick, duration, and
  people, or a live call with a join button
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
- Automatic updates: the version is shown in Settings > About, the settings
  button gets a dot when an update is ready, and updates install without
  user action, see [Releases](#releases)
- One WebSocket connection for all tabs through `MetacomProxy`, one tab per
  browser (Web Locks) runs the WebRTC mesh for all of them
- Keyboard: `Ctrl+K` jumps to a chat, feed, contact, or command (Settings,
  Keyboard shortcuts, Recordings, New capture), `Ctrl+,` opens settings, `Alt+↑`/`Alt+↓`
  previous or next chat, `Ctrl+F` search, `Ctrl+P` pinned; `↑` in an empty
  composer selects the last message, `↑`/`↓` move, `Enter` or `Shift+F10`
  opens the menu, `R` replies, `E` edits your own message, and `F`
  selects the thread of the current message. Use `[`/`]`, `↑`/`↓`, or
  `←`/`→` to step through the selected thread.
  `Esc` closes the top overlay, clears a reply target or thread selection,
  closes an open post, or toggles the sidebar
- Mobile: the back button closes the sidebar, panel, viewer, menu, thread
  selection, or post. The layout respects safe areas and the on-screen
  keyboard and offers bigger touch targets
- Nick shared between tabs, members list, and activity log
- Profile row at the bottom of the sidebar: your avatar, nick, and a
  connection dot (hover for the connection, mesh role, and peers), a
  recordings button (it turns red while a capture or call recording runs),
  and a settings button
- Settings screen in the main area (`?settings=<section>` opens a section,
  `Esc` or `×` returns to the chat with its draft): Profile (nick, title for
  lower thirds, peer id), Appearance, Notifications, Audio & video, Network,
  Recordings defaults, Streaming destinations, Storage, Keyboard shortcuts,
  and About (version, update, install, connection, diagnostics log). On a
  phone the list comes first and Back closes the
  section, then the screen
- Appearance (Settings > Appearance, saved in `xxii:settings`): theme
  `system`, `dark` (default), or `light`, message text size S, M, L, or XL
  (12, 13, 15, 17 px for messages, posts, articles, Markdown, and the
  composer), and compact density for message rows and sidebar items. A
  sample message shows the size. Changes apply at once and in every open tab;
  `system` follows the device theme live; `theme.js` sets the attributes
  before the first paint. Browser zoom still scales the whole interface
- Notifications (Settings > Notifications, saved in `xxii:settings`): the
  browser permission with an `allow` button (a blocked site shows how to
  unblock it), the ringtone on or off with a volume from 0 to 100 (50 is the
  old loudness) and `test`, the system notification for calls while the tab
  is hidden, notifications for new direct messages and replies to your
  messages (off by default) with or without the message text, and the join
  and leave toasts of calls. Rows that need the permission say so and ask
  for it when turned on. A message notification appears only while no
  xxii.chat tab is visible, only for messages that arrive while the app is
  open, once per message even with several tabs; a click focuses a tab and
  opens the message
- Storage (Settings > Storage): browser storage used and available, split
  into messages, files, recordings, and the app (counted while the section
  is open), and a switch that asks the browser to keep this site's data when
  space is low. The danger zone has three actions, each behind a dialog that
  says what is lost and what stays: `clear` empties the local messages and
  files (they come back from the server and online peers), `delete` removes
  every recording from browser storage (copies saved in a folder stay; not
  available while a recording runs), and `reset` returns the settings of
  this browser to their defaults in every open tab while keeping the nick,
  peer id, drafts, read marks, folders, and streaming destinations
- Recordings screen in the main area (profile row button, the `Recordings`
  command, the call's `more` menu, or Settings > Recordings): a grid of cards
  with poster, title, chat, duration, size, and actions, a full-width player,
  and `new capture`. `Esc` or Back closes it. In Settings > Audio & video the
  microphone shows a live level meter and the camera a small mirrored preview
  while the section is open outside a call; without permission the lists ask
  you to allow camera and microphone

## Calls

Settings > Network stores network settings in the browser: public
STUN off by default, user STUN and TURN servers, and force relay.
If two participants cannot connect, a third can forward their mic and video
while the direct link retries. The tiles show who is relaying.
The chat topbar starts a call. A direct call rings in every tab of the
other person: video, audio, and decline, a generated tone, and a system
notification while the page is hidden. Decline or a miss leaves a
missed-call card with call back. Notification permission is requested once
when starting, joining, or accepting a call, while permission is undecided.
The prompt does not hold up the call. A notification click focuses the tab
that rang, a recent app window, or opens the app; answer in the call toast.

The share control sends a screen or window and its available audio to everyone
in the call, including later arrivals; while sharing it reads `stop`, and a
`● sharing screen` pill in the call topbar has a menu with `Optimize for video`
(detail or 30 fps video mode) and `Stop sharing`. The Record panel has `Add a
screen to my recording`, which captures without sharing and keeps the source
local. Stopping capture in the browser or leaving the call releases the source.

Call senders budget bandwidth per participant count and receiver tile size.
Hidden tiles pause their camera encoding on that link and resume when shown.
Each remote tile menu has an audio-only control for both camera directions, with
a suggestion after sustained poor quality. Five poor seconds lower camera
quality one row; twenty clean seconds restore one row. Screen sharing keeps
its own budget. Browsers without the required controls show a notice.

The `more` menu of the call offers Auto, Grid, Spotlight and Sidebar layouts,
self and camera visibility options, stats, and strip placement (for Spotlight
and Sidebar). Double-click a tile to pin or unpin it. Auto features a shared screen; Spotlight follows the active
speaker. Speaking tiles show a green bar and an avatar ring that follows the
microphone level. The mini call follows the active speaker. Press `F` outside
text fields for full screen, or `Ctrl+Alt+L` to cycle layouts.

The call controls are a toolbar at the bottom of the call: an icon over a short
label for mic, camera (each with a caret for its device menu), share, react,
record, more, people, chat, and a red leave at the end. `←`/`→`, `Home` and
`End` move between them and `Tab` enters and leaves the bar; `↑` on mic or
camera opens its menu. Muted mic and camera show a red slashed icon. People
and chat are toggles with counts (`People, 1 waiting` for a knock, unread
messages on chat) that hide and show those panels, or open them as sheets on a
phone. As an admin, `leave` asks whether to leave or end the call for everyone.
`Record` asks `Stop the recording?` before it stops, from the control, the
Record panel, and `Ctrl+Alt+R`.
The reactions menu has the reactions and `Raise hand`. Raised hands are
call state: the People panel lists them first, ordered by raise time, and
tiles show the order number. Anyone lowers their own hand from the `Lower hand`
badge on their tile; admins lower any
hand from the tile menu or the People panel, or all hands at once. A hand
also lowers itself after three seconds of speaking unless auto-lower is off
in Settings > Audio & video. The reactions 👍 ❤️ 😂 😮 👏 🎉 float up from the sender's tile for three
seconds. They travel as `reaction` messages on the call data channel, at most
three per second per sender.

Shortcuts in a call: `Ctrl+D` mutes and unmutes, `Ctrl+E` turns the camera
on and off, `Ctrl+Alt+H` raises and lowers the hand, `Ctrl+Alt+S` starts and
stops screen sharing, `Ctrl+Alt+R` starts recording and asks before it stops,
`Ctrl+Alt+L` cycles layouts, `F` toggles full screen, `Ctrl+/` lists the call
keys in a dialog (with a link to Settings > Keyboard shortcuts), and `Esc`
closes open menus without leaving the call. The combinations with
`Ctrl` also work in the composer; `F` and `Space` do not fire in text fields.
Hold `Space` outside text fields while muted to talk: the microphone opens
while the key is down and closes on release, when the window loses focus, or
when the tab is hidden. The `more` menu has groups: View (layout and strip
rows, hide self view, hide tiles without video, stats overlay, full screen,
picture-in-picture), Recording and studio (the Record panel, the recordings
library, Studio, Stop live), and Call (copy the call link as an admin, the
keyboard shortcuts, Settings). Picture-in-picture, in browsers with Document
Picture-in-Picture, moves the call into a small window with the active speaker
and icon buttons for back, mic, camera, reactions, and leave; the reactions
menu opens inside that window, and closing it returns to the mini call;
elsewhere the menu says that it is not available. The mini call has icon
buttons for mic, camera, leave, and expand. Every control is operated with
`Enter` or `Space`.

The sidebar’s settings button and the call’s more menu open Settings;
opening it from a call collapses the call to the mini window.
This browser remembers device choices, join defaults, camera mirroring,
noise suppression, push-to-talk, auto-lower, and network settings. The mic
caret offers microphone and speaker pickers, a speaker test, strong noise
suppression, and push-to-talk; the camera caret offers the camera picker,
mirroring, and on a phone switching cameras. Recording
defaults include layout, audio mode, quality, and a folder in browsers with
directory access. A speaker test plays a short tone on the selected output.

Mirror camera is on by default, in the camera menu and Settings > Audio & video. The
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
`more` or from the recording indicator in the call topbar, shows the time and
size at its top and has these options with a live preview of the program,
and every change applies on the next frame; quality (720p30, 1080p30,
1080p60) is fixed while recording. The panel starts from the layout, audio,
and quality defaults of Settings > Recordings. The browser picks the first format it
can encode: MP4 with H.264 and AAC, MP4 with H.264 and Opus (Chrome on Linux),
WebM with VP9 and Opus, then VP8. Chunks of one second go to a dedicated worker
that writes the file into the browser storage (OPFS, `recordings/<id>/` with
`program.mp4` or `program.webm`, `poster.jpg`, and `meta.json` holding the
state, size, duration, MIME, options, and people); it flushes every 5 seconds
and saves the metadata every 10, so a crash loses only the last seconds. WebM
gets its duration written into the header, MP4 needs no fix. Pause leaves no
gap in the file. The recorder asks the browser for persistent storage once,
warns below 2 GB of free space, and stops below 500 MB. While recording the
topbar shows `● nick recording` to everyone in the call, the recorder's own
indicator reads `● 12:31 · 84 MB` (`● paused 12:31 · 84 MB`) and opens the record
panel, the record control reads `stop` on red (`paused` while paused) without
time or size, and the chat gets a `● nick recorded 12
min` note. The recorder keeps rendering when its tab is hidden: it asks other
people for video sized to their tiles of the program, so they keep sending
even though the hidden call view asks for nothing. Leaving the call asks
whether to stop the recording. Anyone in the call can opt out of other people's
recordings from the recording notice or the People panel. The recording then
shows `opted out` instead of their video and drops
their voice within a frame, and the roster marks them. The recorder's app
honors this; a modified app could ignore it.

Open **Studio** from the call's **more** menu to preview the program and see
who is on stage or backstage. A host can move people from the Studio lists,
a tile's menu, or a People row menu. Backstage participants stay visible and
audible in the call, and their camera, screen, mic, and screen audio are
excluded from the program. They see a backstage chip and a notice when they
move. Hosts can turn on **New people go backstage** for the call, so guests
start backstage when they join or are admitted. Hosts and co-hosts start on
stage. Studio and Record share one program preview and open one at a time.

Turn on **Enable Studio** to switch between **Starting soon**, **Live**,
**Be right back**, and **Ending**. Edit or add scenes with their own layout,
background color or image, title, and music. Scene changes use a cut or a
300 ms fade and appear in the recording. A countdown stays on screen at zero.
Studio settings and assets are saved in browser storage. Branding controls
set the colors, font, name chips, and logo. Music loops in the program and
fades when the track changes. Record still controls recording quality and
storage target while Studio is enabled.

Choose which overlays each scene shows. Save banners and a scrolling ticker
in Studio, and show one banner and one participant lower third at a time.
Participants can set **Title for lower thirds** in Settings > Profile. In the
active call chat, use **Show on screen** from a text message's menu to put
that message and its author's nick on the program. Studio plays one local
video clip at a time, full frame or as a share tile. Clip sound goes to the
recording mix.

Studio can also send the program live over WHIP (RFC 9725) to a media server
such as MediaMTX or a service with a WHIP ingest. In the Studio panel, add
**Destinations** with a name, the WHIP address (`https:`, or `http:` for
`localhost`), a token, and a bitrate of 1 to 20 Mbps, and enable up to two.
They are saved in this browser (`xxii:destinations`), and the token is never
sent to the call. **Go live** works with Studio on or off and uses the same
program as recording, so both can run together. Each destination shows
`connecting`, then `LIVE · 5.8 Mbps` with a warning when bandwidth, CPU, or
packet loss limits the stream, or `retrying in 5 s (attempt 2 of 5)`. A server
error, timeout, or lost connection is retried after 2, 5, and 10 s and stops
after 5 failed attempts in a row; a rejected token stops at once. **Stop live**
is in the Studio panel and the call's **more** menu. Everyone in the call sees
`● LIVE` in the topbar and gets an announcement, and anyone can opt out of the
program as with recording. Leaving the call or closing the page ends the
stream and deletes it on the media server (closing the page deletes only
streams sent directly). The browser posts to the media server itself; when
the server has no CORS for this app, the signaling goes through the app's
server relay instead, `stream/whip`, which only members of the call may use
(30 requests a minute), and the media still flows straight to the media server.

Open **Recordings** from the profile row or the call's `more` menu (the
call shrinks to its mini tile) to see local recordings and browser storage
usage. Play and seek in the library
using the service worker's `/recordings/<id>/<file>` route with `Range` support.
Finished recordings can be renamed, deleted, or downloaded. In browsers that
offer file and folder pickers, **Save as** lets you pick a file and **Save to
folder** copies to the folder remembered in Settings > Recordings. Both show progress,
and saving to a folder adds ` (2)`, ` (3)`, and so on to duplicate names.

In Chromium with a folder picker, **Save recordings to** in Settings > Recordings or
the Record panel can send recordings straight to a chosen folder. Choose
5-, 10-, 15-, or 30-minute parts, with 10 minutes by default. Paused time
doesn't count toward the part length. Each part is a playable file. In the
library, select a part to play, download, or save a copy. Browser storage
holds the library entry and its poster. Deleting that entry leaves the
files in the folder.

Use **new capture** on the Recordings screen, the **New capture** command of
`Ctrl+K`, or a direct chat to record without a call; it opens in the right
panel.
Select a camera, microphone, screen or window, and screen audio, and preview
camera only, screen only, or a screen with a camera bubble. Save to browser
storage or a chosen folder. Closing Capture while recording asks whether to
stop. A finished capture started from a direct chat adds a **captured** card
there.

On app start, a recording left open after a crash is marked **Interrupted**.
For browser recordings, the app recovers the stored file size and duration
and fills in the existing WebM duration field. If the file does not provide
timing, the library uses the last saved duration. Folder entries keep the
parts closed before the interruption. Each active or paused recording
holds a browser lock, so opening
another tab leaves it alone. Interrupted recordings can be played, renamed,
deleted, and exported. Recording and startup repair require browser Web Locks
and synchronous OPFS access in a worker.

Phones show the active tile above a horizontally scrollable strip with the
controls above the safe area. The bar is one row with mic, camera, react, more,
and leave, without labels; share, record, people, and chat are the first group
of the `more` menu with their state (`Stop sharing`, `● Recording 12:31`,
`People · 3`, `Chat · 2 unread`). Menus, Chat, and People open as bottom
sheets. Back closes the sheet, then returns to the mini call. The camera menu switches
between front and back cameras. On Android and iOS the camera pauses while
the tab is hidden and resumes on return. The call requests a screen wake lock
when available. Nearby joins and leaves share a toast for calls of up to eight.
Screen readers also announce raised hands and host requests.

Tile options open with the ellipsis, keyboard focus, or touch long press.
The ellipsis on a People row, shown to everyone, opens the same menu for that
person. The menu offers pin, full screen, audio only, stats, and local volume from
0–200%. Volume is remembered per peer for all their microphone and screen
audio tracks. Boost uses Web Audio; a visible notice explains a 100% limit
when unavailable. Recording will have an independent audio mix. Escape closes
the menu and returns focus. The `more` menu toggles stats for all remote tiles;
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
- `XXII_STREAM_ALLOW_HTTP` and `XXII_STREAM_ALLOW_PRIVATE` default to
  `false`. Exactly `true` lets the WHIP relay use `http:` for loopback hosts
  and reach private addresses (`application/config/stream.js`; for tests and
  a local media server).

The same server can run as the `metaice` CLI: `metaice [config]`. The
config is a `.js` or `.json` options file. `SIGINT` and `SIGTERM` exit 0.
A failed listen exits 1.

Open the ICE port for UDP and TCP and the relay range for UDP. The default
relay range is `49160-49359`. Open the TLS port only when TLS is configured.

Settings > Network still holds public STUN, user servers, and force relay.

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
travels. An edit writes `content` and `edited`, a delete writes an empty
`content` and `deleted` (records are never removed), and a forwarded copy
carries `forwarded` (the original id) and `origin` (its author's nick). A folder `parent` loop made by
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
| `xxii:notify`                    | worker      | Message notification; the click answers a tab with `xxii:open`     |
| `cache/check`                    | worker      | Check and install a new version                                    |
| `chat`, `direct` units           | answer peer | Offer peer syncs over WebRTC                                       |
| `mesh/relay`, `mesh/state`       | answer peer | Relay signaling, server state                                      |
| `files/have`, `get`, `put`       | answer peer | File exchange between peers                                        |
| `CallSession` event `stats`      | call tab    | Per-link RTT, loss, streams and candidates sampled once per second |
| `call/update`                    | server      | Updates endpoint mic, camera, screen, hand, and lower-third title  |
| `call/host`                      | server      | Admin actions including `stage` and `joinBackstage`                |
| `reaction` peer message          | call link   | One emoji from the reaction set, at most 3 per second per sender   |
| `hint` peer message              | call link   | Rendered slot size, frame cap, and camera audio-only request       |
| `ice/servers`                    | server      | ICE server list for the call tab; host is location.hostname        |
| `GET /recordings/<id>/<file>`    | worker      | Local playback and downloads with byte ranges                      |
| `repair`                         | recorder    | Recover interrupted recordings on app start                        |

## Testing

- `npm test`: lint and types
- `npm run test:app`: application tests in impress test mode
- `npm run test:calls`: headless Chrome with fake camera, microphone, and
  screen capture for call scenarios
- `node --test test/ice.js`: STUN and TURN URL checks. Calls network
  settings keep public STUN off by default, store user servers, and can
  force relay
- `npm run test:browser`: the chat scenarios and `test:calls`; tabs, chats,
  menu reactions that toggle, quoted replies, thread selection, message
  toolbar, edit, delete, forward, copy link, picking, pins, feeds opened
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
  `test/call-controls.js` checks the call control bar: toolbar and arrow keys,
  the device menus, share and its pill, react and raise hand, record and its
  topbar indicator and the stop confirm, the `more` menu groups, layout and
  strip rows, the keyboard shortcuts dialog and `Ctrl /`, `Settings…`, the mini
  tile icons, picture-in-picture, the phone bar and its sheets, people and chat
  toggles, the People row menu, and the leave dialog;
  `test/menu.js` checks anchored menus: placement, flipping and clamping,
  keys and type-ahead, focus, one open menu, closing, the phone sheet with
  Back and swipe, and the People row menu;
  `test/call-turn.js` forces relay through the `rtc` group and checks
  that both sides select a relay pair while audio and video flow
  (scenario 9), and again through TURN over TLS on a port that also
  offers HTTP;
  `test/relay-logic.js` checks peer relay decisions and slot mapping.
  `test/call-relay.js` checks relay playback, recovery, limits, and cleanup
  when the direct link reconnects or the relay leaves (scenario 22);
  `test/call-link.js` checks link policy: without a token the visitor
  waits in the lobby until an admin admits them, a token joins, and a
  lock denies (scenario 10);
  `test/call-host.js` checks ask to mute, remove, and end for everyone
  (scenario 11);
  `test/call-hands.js` covers hand order, reactions, membership toasts and
  screen reader announcements. `test/call-keys.js` covers shortcuts,
  keyboard menus and picture-in-picture. `test/call-settings.js` checks
  settings validation, migration and toast timing. `test/settings.js`
  checks the settings screen, profile row, deep links, Back, devices,
  appearance, storage and About. `test/app-settings-logic.js` checks the appearance
  settings, `theme.js`, and the contrast of both themes.
  `test/storage-usage-logic.js` checks the usage breakdown, the cancellable
  OPFS walk, and which keys a settings reset removes.
  `test/notifications-logic.js` checks the ring volume mapping, the message
  notification text, live-message filtering, and the worker handler and
  click route; `test/notifications-settings.js` checks the permission row,
  toggles, ring volume, call gates, and message notifications with hidden
  and visible tabs. `test/call-phone.js`
  checks saved defaults, push-to-talk, auto-lower, mobile controls and Back;
  `test/call-mirror.js` checks the mirrored self view and remote tile, the
  toggle without renegotiation, the stats path, and camera off (scenario 23);
  `test/recording-route.js` checks byte ranges (scenario 16),
  `test/recording-repair.js` checks startup recovery and playback (scenario 17),
  `test/recording-export.js` checks picker and folder export (scenario 18),
  and `test/recording-folder.js` checks direct-to-folder parts, permissions,
  and repair (scenario 19).
  `test/capture-logic.js` checks the solo layouts, and `test/capture.js` checks
  solo capture, storage targets, the direct-chat card, and source cleanup.
  `test/recording-duration.js` covers timing in WebM and fragmented MP4.
  `test/studio-stage.js` checks stage moves, program picture and mix,
  the Studio preview, and new people joining backstage (scenario 20).
  `test/studio-layout.js` checks saved data, overlay placement and animation,
  comment clipping, ticker speed, and clip layout.
  `test/studio.js` plays a recorded scene cut, observes a hidden-tab fade,
  and checks saved settings, assets, the program music mix, call chat overlays,
  and audible clips in the recording mix.
  `test/whip-logic.js` checks destination validation, codec order, `Link` and
  `Location` handling, retries, and the health text. `test/stream.js` goes live
  to a local WHIP endpoint that hands the offer to another tab, and checks the
  token and `Origin`, received frames and audio, the `● LIVE` chip, `DELETE` on
  stop, and a retry after a `503`; a second run against an endpoint without
  CORS checks the server relay: no `Origin`, the token, frames, and `DELETE`
  through the relay (scenario 21). `application/domain/stream.test.js` covers
  the relay rules.
  `npm run test:app` reserves two different free ports and passes them as
  `XXII_PORT` and `XXII_ICE_PORT`, then runs `MODE=test node server.js`, so
  it does not bind `8000` or `3478`. The browser harness picks free
  `XXII_PORT` and `XXII_ICE_PORT`
  (not `0`, and not a port it found busy) and opens that api port
