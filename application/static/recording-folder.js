const folderHandle = async (handle) => {
  const db = await new Promise((resolve, reject) => {
    const request = globalThis.indexedDB.open('xxii', 1);
    request.onupgradeneeded = () => request.result.createObjectStore('handles');
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction('handles', handle ? 'readwrite' : 'readonly');
      const store = tx.objectStore('handles');
      const request = handle
        ? store.put(handle, 'recordings')
        : store.get('recordings');
      tx.oncomplete = () => resolve(handle || request.result);
      tx.onabort = () => reject(tx.error);
    });
  } finally {
    db.close();
  }
};

export { folderHandle };
