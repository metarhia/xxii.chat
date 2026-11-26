import { webmDurationOf } from './recording-webm.js';
import { mp4DurationOf } from './recording-mp4.js';

const READ_BYTES = 12;

const readerOf = (handle) => {
  const buffer = new Uint8Array(READ_BYTES);
  return (at, length) => {
    const target = buffer.subarray(0, length);
    let count = 0;
    while (count < length) {
      const read = handle.read(target.subarray(count), { at: at + count });
      if (read === 0) break;
      count += read;
    }
    return buffer.subarray(0, count);
  };
};

const storedDurationOf = (handle, size, extension, fallback) => {
  const read = readerOf(handle);
  if (extension === 'webm') {
    const result = webmDurationOf(read, size);
    if (result) {
      const { duration, slot } = result;
      return { duration: duration ?? fallback, slot };
    }
  }
  if (extension === 'mp4' || extension === 'm4a') {
    const duration = mp4DurationOf(read, size) ?? fallback;
    return { duration, slot: null };
  }
  return { duration: fallback, slot: null };
};

export { storedDurationOf };
