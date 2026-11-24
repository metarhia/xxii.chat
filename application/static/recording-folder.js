const FOLDER_KEY = 'recordings';
const FOLDER_DENIED = 'Allow access to the folder or switch to browser storage';

const canPickFolder = () =>
  typeof globalThis.showDirectoryPicker === 'function' &&
  !!globalThis.indexedDB;

const folderRecord = async (handle, recording = '') => {
  const key = recording ? `${FOLDER_KEY}/${recording}` : FOLDER_KEY;
  const entry = handle && { handle, name: handle.name };
  const db = await new Promise((resolve, reject) => {
    const request = globalThis.indexedDB.open('xxii', 1);
    request.onupgradeneeded = () => request.result.createObjectStore('handles');
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  try {
    return await new Promise((resolve, reject) => {
      const mode = handle === undefined ? 'readonly' : 'readwrite';
      const tx = db.transaction('handles', mode);
      const store = tx.objectStore('handles');
      let request = null;
      if (handle === null) store.delete(key);
      else if (entry) store.put(entry, key);
      else request = store.get(key);
      tx.oncomplete = () => {
        const saved = entry ?? request?.result;
        const legacy = saved && !Object.hasOwn(saved, 'handle');
        resolve(legacy ? { handle: saved, name: saved.name } : saved);
      };
      tx.onabort = () => reject(tx.error);
    });
  } finally {
    db.close();
  }
};

const folderHandle = async (handle, recording) =>
  (await folderRecord(handle, recording))?.handle;

const pickFolder = async () => {
  try {
    const handle = await globalThis.showDirectoryPicker({
      mode: 'readwrite',
      id: 'xxii-recordings',
      startIn: 'videos',
    });
    return await folderRecord(handle);
  } catch (error) {
    if (error.name === 'AbortError') return null;
    throw error;
  }
};

const chooseRecordingFolder = async () => {
  const folder = await folderRecord();
  return folder ?? pickFolder();
};

const folderPermission = async (
  folder,
  mode = 'readwrite',
  canRequest = () => true,
) => {
  const options = { mode };
  const permission = await folder.queryPermission(options);
  if (permission !== 'prompt' || !canRequest()) return permission;
  return folder.requestPermission(options);
};

const requireRecordingFolder = async (isCurrent) => {
  const folder = await folderRecord();
  if (!isCurrent()) return null;
  if (!folder) throw new Error(FOLDER_DENIED);
  const access = folderPermission(folder.handle, 'readwrite', isCurrent);
  const permission = await access.catch((error) => {
    if (error.name === 'NotAllowedError' || error.name === 'SecurityError') {
      return 'denied';
    }
    throw error;
  });
  if (isCurrent() && permission !== 'granted') {
    throw new Error(FOLDER_DENIED);
  }
  return folder;
};

export { canPickFolder, folderHandle, pickFolder, chooseRecordingFolder };
export { folderRecord, folderPermission, requireRecordingFolder };
