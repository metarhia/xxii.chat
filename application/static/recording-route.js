import { RECORDINGS, META_FILE, TYPES } from './recording-files.js';
import { routeOf, rangeOf, typeOf } from './recording-files.js';
import { dispositionOf, extensionOf } from './recording-files.js';
import { EDIT_PREFIX, isPendingEdit } from './recording-files.js';

const NOT_FOUND = { status: 404, headers: { 'Content-Type': 'text/plain' } };

const notFound = () => new Response('Not found', NOT_FOUND);

const directoryOf = async (id) => {
  const root = await navigator.storage.getDirectory();
  const recordings = await root.getDirectoryHandle(RECORDINGS);
  return recordings.getDirectoryHandle(id);
};

const metaOf = async (directory) => {
  try {
    const handle = await directory.getFileHandle(META_FILE);
    const file = await handle.getFile();
    return JSON.parse(await file.text());
  } catch {
    return null;
  }
};

const mimeOf = async (directory, name) => {
  const extension = extensionOf(name);
  const fallback = TYPES[extension] ?? 'application/octet-stream';
  const isProgram = name === `program.${extension}`;
  if (!isProgram) return fallback;
  const meta = await metaOf(directory);
  return typeOf(meta?.mime) || fallback;
};

const headersOf = (type, url) => {
  const headers = new Headers({ 'Accept-Ranges': 'bytes' });
  headers.set('Content-Type', type);
  if (!url.searchParams.has('download')) return headers;
  const name = url.searchParams.get('name') ?? 'recording';
  headers.set('Content-Disposition', dispositionOf(name));
  return headers;
};

const answerOf = (file, request, headers) => {
  const range = rangeOf(request.headers.get('Range'), file.size);
  if (range.status === 416) {
    headers.set('Content-Range', `bytes */${file.size}`);
    return new Response(null, { status: 416, headers });
  }
  const body = file.slice(range.start, range.end + 1);
  headers.set('Content-Length', `${body.size}`);
  if (range.status === 206) {
    const total = `${range.start}-${range.end}/${file.size}`;
    headers.set('Content-Range', `bytes ${total}`);
  }
  return new Response(body, { status: range.status, headers });
};

const serveRecording = async (request, url) => {
  const route = routeOf(url.pathname);
  if (!route) return notFound();
  try {
    const directory = await directoryOf(route.id);
    if (route.id.startsWith(EDIT_PREFIX)) {
      const meta = await metaOf(directory);
      if (isPendingEdit(route.id, meta)) return notFound();
    }
    const handle = await directory.getFileHandle(route.file);
    const file = await handle.getFile();
    const type = await mimeOf(directory, route.file);
    return answerOf(file, request, headersOf(type, url));
  } catch {
    return notFound();
  }
};

const isRecordingUrl = (url) => {
  const isSameOrigin = url.origin === self.location.origin;
  return isSameOrigin && url.pathname.startsWith('/recordings/');
};

export { isRecordingUrl, serveRecording };
