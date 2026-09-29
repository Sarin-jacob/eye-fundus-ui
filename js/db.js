// Tiny IndexedDB wrapper: captured images are stored as JPEG blobs (localStorage is far too small for real photos).
const DB = 'fundusview', STORE = 'shots';
let dbp = null;

function open() {
  if (!dbp) {
    dbp = new Promise((res, rej) => {
      const r = indexedDB.open(DB, 1);
      r.onupgradeneeded = () => r.result.createObjectStore(STORE, { keyPath: 'id' });
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
  }
  return dbp;
}

function run(mode, fn) {
  return open().then((db) => new Promise((res, rej) => {
    const tx = db.transaction(STORE, mode), req = fn(tx.objectStore(STORE));
    tx.oncomplete = () => res(req ? req.result : undefined);
    tx.onerror = () => rej(tx.error);
    tx.onabort = () => rej(tx.error);
  }));
}

export const db = {
  all: () => run('readonly', (s) => s.getAll()),
  put: (rec) => run('readwrite', (s) => { s.put(rec); }),
  del: (id) => run('readwrite', (s) => { s.delete(id); }),
  clear: () => run('readwrite', (s) => { s.clear(); }),
};
