import { rangeOf } from './recording-files.js';
import { PIECE_BYTES, isHash } from './video-pieces.js';

const MEDIA = '/shared-video/';
const TIMEOUT_MS = 35000;

const videoPath = (id) => MEDIA + id;

const isSharedVideo = (url) =>
  url.origin === self.location.origin && url.pathname.startsWith(MEDIA);

const ask = (port, message, signal) =>
  new Promise((resolve, reject) => {
    signal.throwIfAborted();
    const timeout = new AbortController();
    const pending = AbortSignal.any([signal, timeout.signal]);
    const timer = setTimeout(() => timeout.abort(), TIMEOUT_MS);
    const onAbort = () => {
      clearTimeout(timer);
      port.onmessage = null;
      reject(pending.reason);
    };
    pending.addEventListener('abort', onAbort, { once: true });
    port.onmessage = ({ data }) => {
      clearTimeout(timer);
      pending.removeEventListener('abort', onAbort);
      port.onmessage = null;
      if (data.error) reject(new Error(data.error));
      else resolve(data);
    };
    port.postMessage(message);
  });

const sendRange = async (event, url) => {
  const id = url.pathname.slice(MEDIA.length);
  if (!isHash(id)) return new Response(null, { status: 404 });
  const client = await self.clients.get(event.clientId);
  if (!client) return new Response(null, { status: 404 });
  const channel = new MessageChannel();
  const { port1: port, port2 } = channel;
  const transfer = new AbortController();
  const { signal } = transfer;
  client.postMessage({ type: 'xxii:video-range', id }, [port2]);
  const close = () => {
    if (signal.aborted) return;
    transfer.abort();
    port.postMessage({ type: 'cancel' });
    port.close();
  };
  const request = event.request;
  try {
    const { size, mime } = await ask(port, { type: 'stat' }, signal);
    const { status, start, end } = rangeOf(request.headers.get('Range'), size);
    const headers = new Headers({
      'Content-Type': mime,
      'Accept-Ranges': 'bytes',
      'Cache-Control': 'no-store',
    });
    if (status === 416) {
      close();
      headers.set('Content-Range', `bytes */${size}`);
      return new Response(null, { status, headers });
    }
    if (status === 206) {
      headers.set('Content-Range', `bytes ${start}-${end}/${size}`);
    }
    headers.set('Content-Length', String(end - start + 1));
    let at = start;
    const stream = new ReadableStream({
      async pull(controller) {
        try {
          const index = Math.floor(at / PIECE_BYTES);
          const { bytes } = await ask(port, { type: 'read', index }, signal);
          const offset = at % PIECE_BYTES;
          const length = Math.min(bytes.byteLength - offset, end - at + 1);
          if (length <= 0) throw new Error('Incomplete video piece.');
          controller.enqueue(new Uint8Array(bytes, offset, length));
          at += length;
          if (at <= end) return;
          close();
          controller.close();
        } catch (error) {
          close();
          controller.error(error);
        }
      },
      cancel: close,
    });
    return new Response(stream, { status, headers });
  } catch {
    close();
    return new Response(null, { status: 503 });
  }
};

export { videoPath, isSharedVideo, sendRange };
