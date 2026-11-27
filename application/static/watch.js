import { sizeText } from './recording-files.js';
import { VideoSwarm } from './video-swarm.js';
import { readShare } from './video-pieces.js';
import { videoPath } from './video-range.js';

const KEEP_BATCH = 4;
const byId = (id) => document.getElementById(id);
const video = byId('watch-player');
const title = byId('watch-title');
const status = byId('watch-status');
const keep = byId('watch-keep');
const retry = byId('watch-retry');
const share = readShare(location.hash);
let swarm = null;
let controlled = false;
let saving = false;
let notice = '';
let workerReady = null;

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
  status.textContent = [notice, peers, progress, transfer]
    .filter(Boolean)
    .join(' · ');
  keep.hidden = false;
  keep.disabled = saving || copies === total;
  keep.textContent = copies === total ? 'copy saved' : 'keep a copy';
  if (!controlled || video.getAttribute('src')) return;
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
    video.load();
    video.play().catch(() => {});
  } else {
    swarm?.close();
    start().catch(failed);
  }
};

window.addEventListener('pagehide', () => swarm?.close());
start().catch(failed);
