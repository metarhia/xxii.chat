import { TYPES, fileNameOf } from './recording-files.js';
import { programFileOf, recordingUrlOf } from './recording-files.js';
import { folderPermission } from './recording-folder.js';

const FOLDER_EXPORT_LOCK = 'xxii:recording-export';

const exportNameOf = (chat, started, extension) => {
  const hasDate =
    Number.isFinite(started) && Number.isFinite(new Date(started).getTime());
  return hasDate
    ? fileNameOf(chat, started, extension)
    : programFileOf(extension);
};

const downloadUrlOf = (id, extension, name) => {
  const url = recordingUrlOf(id, programFileOf(extension));
  const query = new URLSearchParams({ download: '1', name });
  return `${url}?${query}`;
};

const suffixNameOf = (name, number) => {
  const dot = name.lastIndexOf('.');
  const end = dot > 0 ? dot : name.length;
  return `${name.slice(0, end)} (${number})${name.slice(end)}`;
};

const partLabel = (number) => {
  const index = `${number}`.padStart(2, '0');
  return `part ${index}`;
};

const segmentNameOf = ({ chatName, started, extension }, number) => {
  const name = exportNameOf(chatName, started, extension);
  const dot = name.lastIndexOf('.');
  return `${name.slice(0, dot)} ${partLabel(number)}${name.slice(dot)}`;
};

const pickExportFile = async (name, extension) => {
  const accept = { [TYPES[extension]]: [`.${extension}`] };
  try {
    return await globalThis.showSaveFilePicker({
      suggestedName: name,
      types: [{ accept }],
    });
  } catch (error) {
    if (error.name === 'AbortError') return null;
    throw error;
  }
};

const findAvailableFile = async (folder, name) => {
  for (let number = 1; ; number++) {
    const candidate = number === 1 ? name : suffixNameOf(name, number);
    try {
      await folder.getFileHandle(candidate);
    } catch (error) {
      if (error.name === 'NotFoundError') {
        return folder.getFileHandle(candidate, { create: true });
      }
      if (error.name !== 'TypeMismatchError') throw error;
    }
  }
};

const createAvailableFile = (folder, name) => {
  const create = () => findAvailableFile(folder, name);
  const locks = navigator.locks;
  return locks?.request ? locks.request(FOLDER_EXPORT_LOCK, create) : create();
};

const exportFile = async (file, target, progress) => {
  let bytes = 0;
  let percent = 0;
  const { size } = file;
  progress(percent);
  const counter = new TransformStream({
    transform(chunk, controller) {
      bytes += chunk.byteLength;
      const next = Math.min(99, Math.floor((100 * bytes) / size));
      if (next > percent) {
        percent = next;
        progress(percent);
      }
      controller.enqueue(chunk);
    },
  });
  const writable = await target.createWritable();
  await file.stream().pipeThrough(counter).pipeTo(writable);
  progress(100);
};

const removeEmptyExport = async (folder, target) => {
  const file = await target.getFile();
  if (file.size === 0) await folder.removeEntry(target.name);
};

const exportToFolder = async (folder, name, sourceFile, progress) => {
  const permission = await folderPermission(folder);
  if (permission !== 'granted') {
    throw new DOMException('Folder access was denied.', 'NotAllowedError');
  }
  const file = await sourceFile();
  const target = await createAvailableFile(folder, name);
  try {
    await exportFile(file, target, progress);
  } catch (error) {
    await removeEmptyExport(folder, target).catch(() => {});
    throw error;
  }
};

export { exportNameOf, downloadUrlOf, suffixNameOf };
export { pickExportFile, exportToFolder, exportFile };
export { partLabel, segmentNameOf, createAvailableFile, removeEmptyExport };
