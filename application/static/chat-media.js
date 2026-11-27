import { MAX_FILE_SIZE } from './chat.js';
import { durationBytesOf, durationSlotOf } from './recording-webm.js';
import { button, element, openCollection } from './collection-dialog.js';

const FORMATS = {
  voice: ['audio/webm;codecs=opus', 'audio/mp4', 'audio/ogg;codecs=opus'],
  circle: ['video/webm;codecs=vp8,opus', 'video/mp4', 'video/webm'],
};

const extensionOf = (mime) => mime.split(';')[0].split('/')[1] || 'webm';

const peaksOf = (samples) => {
  const count = Math.min(samples.length, 48);
  return Array.from({ length: count }, (_, index) => {
    const first = Math.floor((index * samples.length) / count);
    const end = Math.floor(((index + 1) * samples.length) / count);
    const peak = Math.max(...samples.slice(first, end));
    return Math.min(15, Math.round(peak * 15)).toString(16);
  }).join('');
};

const waveform = (stream, samples) => {
  const Audio = globalThis.AudioContext;
  if (!Audio) return () => {};
  const context = new Audio();
  const source = context.createMediaStreamSource(stream);
  const analyser = context.createAnalyser();
  source.connect(analyser);
  const data = new Float32Array(analyser.fftSize);
  const timer = setInterval(() => {
    analyser.getFloatTimeDomainData(data);
    const peak = data.reduce((max, value) => Math.max(max, Math.abs(value)), 0);
    samples.push(peak);
  }, 100);
  return () => {
    clearInterval(timer);
    context.close().catch(() => {});
  };
};

const limits = (kind) => {
  const options = { audioBitsPerSecond: 48000 };
  if (kind === 'circle') options.videoBitsPerSecond = 680000;
  return options;
};

const camera = {
  width: { ideal: 480 },
  height: { ideal: 480 },
  facingMode: 'user',
};

const captureNote = (kind, accept) => {
  let stream;
  let recorder;
  let clock;
  let release = () => {};
  let url;
  let file;
  let size = 0;
  let closed = false;
  let tooLarge = false;
  let started = 0;
  let ended = 0;
  const chunks = [];
  const samples = [];
  const title = kind === 'circle' ? 'Video message' : 'Voice message';
  const clean = () => {
    clearInterval(clock);
    release();
    release = () => {};
    stream?.getTracks().forEach((track) => track.stop());
  };
  const dialog = openCollection(title, (body, close) => {
    const preview = element(kind === 'circle' ? 'video' : 'audio');
    preview.playsInline = true;
    preview.hidden = kind === 'voice';
    preview.classList.toggle('circle-preview', kind === 'circle');
    const status = element('p', '', 'Waiting for permission…');
    status.setAttribute('role', 'status');
    const controls = element('div', 'collection-toolbar');
    const stop = button('Stop', () => {
      if (recorder?.state === 'recording') {
        ended = Date.now();
        recorder.stop();
      }
      stop.disabled = true;
    });
    const use = button('Use recording', () => {
      if (!file) return;
      accept(file, { presentation: kind, waveform: peaksOf(samples) });
      close();
    });
    use.hidden = true;
    stop.disabled = true;
    controls.append(stop, use, button('Cancel', close));
    body.append(preview, status, controls);
    const start = async () => {
      const mime = FORMATS[kind].find((type) =>
        globalThis.MediaRecorder.isTypeSupported(type),
      );
      if (!mime) throw new Error('This browser cannot record this media type.');
      stream = await navigator.mediaDevices.getUserMedia({
        audio: true,
        video: kind === 'circle' ? camera : false,
      });
      if (closed) return void clean();
      if (kind === 'circle') {
        preview.muted = true;
        preview.srcObject = stream;
        preview.play().catch(() => {});
      }
      recorder = new globalThis.MediaRecorder(stream, {
        ...limits(kind),
        mimeType: mime,
      });
      recorder.ondataavailable = ({ data }) => {
        if (data.size === 0) return;
        size += data.size;
        if (size > MAX_FILE_SIZE) {
          tooLarge = true;
          stop.click();
          return;
        }
        chunks.push(data);
      };
      recorder.onerror = () => {
        status.textContent = 'Recording failed.';
        clean();
        stop.disabled = true;
      };
      recorder.onstop = async () => {
        clean();
        if (closed) return;
        stop.hidden = true;
        if (tooLarge || size === 0) {
          status.textContent = tooLarge
            ? 'Recording exceeded 10 MB.'
            : 'No media was recorded.';
          return;
        }
        const type = recorder.mimeType.split(';')[0];
        if (type.endsWith('/webm')) {
          const head = new Uint8Array(await chunks[0].arrayBuffer());
          const slot = durationSlotOf(head);
          if (slot) {
            slot.bytes.set(
              durationBytesOf(ended - started, slot.scale),
              slot.offset,
            );
            chunks[0] = slot.bytes;
          }
        }
        if (closed) return;
        file = new File(chunks, `${title}.${extensionOf(type)}`, { type });
        url = URL.createObjectURL(file);
        preview.srcObject = null;
        preview.src = url;
        preview.muted = false;
        preview.controls = true;
        preview.hidden = false;
        status.textContent = 'Preview your recording';
        use.hidden = false;
      };
      if (kind === 'voice') {
        try {
          release = waveform(stream, samples);
        } catch {
          release = () => {};
        }
      }
      recorder.start(250);
      stop.disabled = false;
      started = Date.now();
      status.textContent = 'Recording…';
      clock = setInterval(() => {
        const seconds = Math.floor((Date.now() - started) / 1000);
        status.textContent = `Recording · ${seconds}s`;
        if (seconds >= 60) stop.click();
      }, 250);
    };
    start().catch((error) => {
      clean();
      status.textContent =
        error.message || 'Could not access the microphone or camera.';
    });
  });
  dialog.addEventListener('close', () => {
    closed = true;
    if (recorder?.state === 'recording') recorder.stop();
    clean();
    if (url) URL.revokeObjectURL(url);
  });
  return dialog;
};

const isNote = ({ presentation, mime }) =>
  (presentation === 'voice' && mime?.startsWith('audio/')) ||
  (presentation === 'circle' && mime?.startsWith('video/'));

class ChatMedia {
  #active = null;

  close() {
    const active = this.#active;
    this.#active = null;
    if (!active) return;
    active.player.pause();
    active.player.removeAttribute('src');
    active.player.load();
    active.player.hidden = true;
    active.play.hidden = false;
    if (active.url) URL.revokeObjectURL(active.url);
  }

  create(file, load) {
    const circle = file.presentation === 'circle';
    const box = element(
      'div',
      circle ? 'chat-note circle-note' : 'chat-note voice-note',
    );
    const player = element(circle ? 'video' : 'audio');
    player.controls = true;
    player.playsInline = true;
    player.hidden = true;
    player.setAttribute('aria-label', file.name);
    const status = element('span', 'muted');
    status.setAttribute('role', 'status');
    const play = button(
      circle ? '▶ Video message' : '▶ Voice message',
      async () => {
        this.close();
        play.disabled = true;
        status.textContent = '';
        const active = { player, play, url: '' };
        this.#active = active;
        try {
          const blob = await load(file);
          if (this.#active !== active || !box.isConnected) return;
          if (!blob) {
            throw new Error('Waiting for the file. Try again shortly.');
          }
          active.url = URL.createObjectURL(
            new Blob([blob], { type: file.mime }),
          );
          player.src = active.url;
          player.hidden = false;
          play.hidden = true;
          player.play().catch(() => {});
        } catch (error) {
          status.textContent = error.message;
        } finally {
          play.disabled = false;
        }
      },
    );
    box.append(play, player);
    if (!circle && file.waveform) {
      const wave = element('span', 'note-wave');
      wave.setAttribute('aria-hidden', 'true');
      for (const peak of file.waveform.slice(0, 48)) {
        const bar = element('i');
        bar.style.setProperty('--peak', Number.parseInt(peak, 16) || 1);
        wave.append(bar);
      }
      box.append(wave);
      player.addEventListener('timeupdate', () => {
        const at = player.currentTime / player.duration || 0;
        const count = wave.children.length;
        for (let i = 0; i < count; i++) {
          wave.children[i].classList.toggle('played', i < at * count);
        }
      });
    }
    if (!circle) {
      const speed = element('select');
      speed.setAttribute('aria-label', 'Playback speed');
      for (const rate of [1, 1.25, 1.5, 2]) {
        const option = element('option', '', `${rate}×`);
        option.value = rate;
        speed.append(option);
      }
      speed.onchange = () => {
        player.playbackRate = Number(speed.value);
      };
      player.addEventListener('loadedmetadata', speed.onchange);
      box.append(speed);
    }
    box.append(status);
    return box;
  }
}

export { captureNote, isNote, ChatMedia };
