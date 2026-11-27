import { sizeText } from './recording-files.js';
import { VideoSwarm } from './video-swarm.js';
import { readShare, shareUrlOf } from './video-pieces.js';
import { renderTracks } from './video-metadata.js';
import {
  LATER,
  videoOf,
  historyOf,
  rememberPosition,
  inList,
  toggleVideo,
  addToPlaylist,
  openWatchLibrary,
} from './watch-library.js';
import { videoPath } from './video-range.js';

const KEEP_BATCH = 4;
const byId = (id) => document.getElementById(id);
const video = byId('watch-player');
const title = byId('watch-title');
const status = byId('watch-status');
const keep = byId('watch-keep');
const retry = byId('watch-retry');
const share = readShare(location.hash);
const params = new URLSearchParams(location.search);
const chat = params.get('chat');
const message = params.get('message');
const tools = byId('watch-tools');
const discuss = byId('watch-discuss');
const atButton = byId('watch-time');
const later = byId('watch-later');
const playlist = byId('watch-playlist');
let tracksId = '';
let releaseTracks = null;
let lastSaved = 0;
let watched = false;
const fromUrl = params.get('t');
let initialTime =
  fromUrl !== null && /^\d+(?:\.\d{1,3})?$/.test(fromUrl)
    ? Number(fromUrl)
    : null;
let swarm = null;
let controlled = false;
let saving = false;
let notice = '';
let workerReady = null;

const paintLater = () => {
  const saved = inList(LATER, share.id);
  later.textContent = saved ? 'Remove from Watch Later' : 'Watch Later';
  later.setAttribute('aria-pressed', String(saved));
};

const paint = (session) => {
  const { pieces, links, received, uploaded } = session;
  const manifest = pieces.manifest;
  if (!manifest) {
    status.textContent = notice || 'Waiting for a peer with this video…';
    return;
  }
  title.textContent = manifest.name;
  document.title = `${manifest.name} · xxii.chat`;
  const count = [...links.values()].filter(({ endpoint }) => endpoint).length;
  const peers = count === 1 ? '1 peer' : `${count} peers`;
  const copies = pieces.persisted.size;
  const total = manifest.hashes.length;
  const progress = `${copies} / ${total} pieces saved`;
  const transfer = `↓ ${sizeText(received)} · ↑ ${sizeText(uploaded)}`;
  const source = [...links.values()].some(
    ({ full, indices }) => full || indices.size,
  );
  const waiting =
    !source && copies < total ? 'Waiting for a peer with this video…' : '';
  status.textContent = [notice || waiting, peers, progress, transfer]
    .filter(Boolean)
    .join(' · ');
  keep.hidden = false;
  keep.disabled = saving || copies === total;
  keep.textContent = copies === total ? 'copy saved' : 'keep a copy';
  tools.hidden = false;
  paintLater();
  if (!controlled || video.getAttribute('src')) return;
  if (manifest.details && tracksId !== pieces.id) {
    tracksId = pieces.id;
    if (manifest.details.poster) video.poster = manifest.details.poster;
    releaseTracks = renderTracks(
      video,
      byId('watch-details'),
      manifest.details,
    );
  }
  video.hidden = false;
  video.src = videoPath(pieces.id);
};

const serve = (port, session) => {
  const manifest = session.pieces.manifest;
  let open = true;
  port.onmessage = async ({ data }) => {
    if (data.type === 'cancel') {
      open = false;
      port.close();
      return;
    }
    try {
      if (!manifest) throw new Error('Waiting for the video details.');
      if (data.type === 'stat') {
        port.postMessage({ size: manifest.size, mime: manifest.mime });
        return;
      }
      if (data.type !== 'read') throw new Error('Invalid video request.');
      const { index } = data;
      const bytes = await session.get(index);
      if (!open) return;
      const copy = bytes.slice(0);
      port.postMessage({ bytes: copy }, [copy]);
      for (
        let i = index + 1;
        i <= index + 2 && i < manifest.hashes.length;
        i++
      ) {
        if (!session.pieces.has(i)) session.get(i).catch(() => {});
      }
    } catch (error) {
      if (open) port.postMessage({ error: error.message });
    }
  };
};

const worker = async () => {
  const service = navigator.serviceWorker;
  service.addEventListener('message', (event) => {
    const { type, id } = event.data ?? {};
    if (type === 'xxii:video-range' && id === share.id && swarm) {
      serve(event.ports[0], swarm);
    }
  });
  await service.register('/worker.js', {
    type: 'module',
    updateViaCache: 'none',
  });
  await service.ready;
  if (!service.controller) {
    await new Promise((resolve) => {
      service.addEventListener('controllerchange', resolve, { once: true });
    });
  }
  controlled = true;
  if (swarm) paint(swarm);
};

const start = async () => {
  if (!share) throw new Error('This video link is incomplete.');
  swarm = new VideoSwarm({ ...share, update: paint });
  workerReady ??= worker();
  await Promise.all([workerReady, swarm.start()]);
};

keep.onclick = async () => {
  if (!swarm || saving) return;
  saving = true;
  notice = 'Saving a full copy';
  paint(swarm);
  const { pieces } = swarm;
  try {
    const total = pieces.manifest.hashes.length;
    for (let first = 0; first < total; first += KEEP_BATCH) {
      const batch = [];
      const end = Math.min(total, first + KEEP_BATCH);
      for (let index = first; index < end; index++) {
        if (pieces.persisted.has(index)) continue;
        batch.push(
          swarm.get(index).then(async (bytes) => {
            if (!pieces.persisted.has(index)) await pieces.put(index, bytes);
            if (!pieces.persisted.has(index)) {
              throw new Error('Browser storage could not save the whole copy.');
            }
          }),
        );
      }
      await Promise.all(batch);
    }
    notice = '';
  } catch (error) {
    notice = error.message;
  } finally {
    saving = false;
    paint(swarm);
  }
};

video.addEventListener('error', () => {
  notice = 'Playback paused while waiting for video pieces.';
  retry.hidden = false;
  paint(swarm);
});

video.addEventListener('playing', () => {
  notice = '';
  retry.hidden = true;
  paint(swarm);
});

const failed = (error) => {
  if (swarm?.pieces.manifest && controlled) {
    notice = error.message;
    paint(swarm);
    return;
  }
  status.textContent = error.message;
  retry.hidden = !share;
};

retry.onclick = () => {
  notice = '';
  retry.hidden = true;
  if (video.getAttribute('src')) {
    if (video.currentTime) initialTime = video.currentTime;
    video.load();
    video.play().catch(() => {});
  } else {
    swarm?.close();
    start().catch(failed);
  }
};

const currentTime = () =>
  Math.max(0, Math.round(video.currentTime * 1000) / 1000);

const paintDiscuss = () => {
  if (!chat || !message) return;
  const reply = new URLSearchParams({
    chat,
    message,
    at: String(currentTime()),
  });
  discuss.href = `/?${reply}`;
  discuss.hidden = false;
};

const savePosition = () => {
  if (!watched || !swarm?.pieces.manifest) return;
  const { name } = swarm.pieces.manifest;
  try {
    rememberPosition(share, name, video.currentTime, video.duration);
  } catch {
    return;
  }
};

video.addEventListener('loadedmetadata', () => {
  const target = initialTime ?? historyOf(share)?.time ?? 0;
  initialTime = null;
  if (target > 0) {
    video.currentTime = Number.isFinite(video.duration)
      ? Math.min(target, video.duration)
      : target;
  }
  atButton.disabled = false;
  paintDiscuss();
});
video.addEventListener('playing', () => {
  watched = true;
});
video.addEventListener('timeupdate', () => {
  paintDiscuss();
  if (Date.now() - lastSaved < 3000) return;
  lastSaved = Date.now();
  savePosition();
});
video.addEventListener('pause', savePosition);
video.addEventListener('ended', savePosition);
atButton.disabled = true;
atButton.onclick = async () => {
  try {
    const url = shareUrlOf(share.room, share.id, { time: currentTime() });
    await navigator.clipboard.writeText(url);
    notice = 'Timestamp link copied.';
  } catch {
    notice = 'Could not copy the timestamp link.';
  }
  paint(swarm);
};
later.onclick = () => {
  try {
    const { name } = swarm.pieces.manifest;
    toggleVideo(LATER, videoOf(share, name));
    paintLater();
  } catch (error) {
    notice = error.message;
    paint(swarm);
  }
};
playlist.onclick = () => {
  addToPlaylist(share, swarm.pieces.manifest.name, (label) => {
    notice = `Saved to ${label}`;
    paint(swarm);
  });
};
byId('watch-lists').onclick = () => openWatchLibrary();
byId('watch-continue').onclick = () => {
  savePosition();
  openWatchLibrary('Continue Watching');
};
window.addEventListener('storage', () => {
  if (share) paintLater();
});
window.addEventListener('pagehide', () => {
  savePosition();
  releaseTracks?.();
  swarm?.close();
});
start().catch(failed);
