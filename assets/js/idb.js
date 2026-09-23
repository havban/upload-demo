// Minimal promise wrapper over IndexedDB.
//
// Three object stores:
//   sessions — upload session metadata, keyed by uploadId (the "server" side ledger)
//   parts    — one record per received chunk, keyed by `${uploadId}#${index}`
//   files    — completed files handed between pages (upload demo -> preview page)

const DB_NAME = 'upload-demo';
const DB_VERSION = 1;
export const STORES = { sessions: 'sessions', parts: 'parts', files: 'files' };

let dbPromise = null;

export function openDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORES.sessions)) db.createObjectStore(STORES.sessions);
      if (!db.objectStoreNames.contains(STORES.parts)) db.createObjectStore(STORES.parts);
      if (!db.objectStoreNames.contains(STORES.files)) db.createObjectStore(STORES.files);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

async function tx(store, mode, fn) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const t = db.transaction(store, mode);
    const req = fn(t.objectStore(store));
    t.oncomplete = () => resolve(req ? req.result : undefined);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  });
}

export const idbGet = (store, key) => tx(store, 'readonly', (s) => s.get(key));
export const idbPut = (store, key, value) => tx(store, 'readwrite', (s) => s.put(value, key));
export const idbDel = (store, key) => tx(store, 'readwrite', (s) => s.delete(key));
export const idbKeys = (store) => tx(store, 'readonly', (s) => s.getAllKeys());
export const idbAll = (store) => tx(store, 'readonly', (s) => s.getAll());
export const idbClear = (store) => tx(store, 'readwrite', (s) => s.clear());

/** Delete every key that starts with `prefix` (used to drop all parts of one upload). */
export async function idbDeletePrefix(store, prefix) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const t = db.transaction(store, 'readwrite');
    const range = IDBKeyRange.bound(prefix, `${prefix}￿`);
    t.objectStore(store).delete(range);
    t.oncomplete = () => resolve();
    t.onerror = () => reject(t.error);
  });
}

/** Read every key that starts with `prefix`, in key order. */
export async function idbKeysPrefix(store, prefix) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const t = db.transaction(store, 'readonly');
    const range = IDBKeyRange.bound(prefix, `${prefix}\uffff`);
    const req = t.objectStore(store).getAllKeys(range);
    t.oncomplete = () => resolve(req.result);
    t.onerror = () => reject(t.error);
  });
}

/** Read every value whose key starts with `prefix`, in key order. */
export async function idbGetPrefix(store, prefix) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const t = db.transaction(store, 'readonly');
    const range = IDBKeyRange.bound(prefix, `${prefix}￿`);
    const req = t.objectStore(store).getAll(range);
    t.oncomplete = () => resolve(req.result);
    t.onerror = () => reject(t.error);
  });
}

export const partKey = (uploadId, index) => `${uploadId}#${String(index).padStart(6, '0')}`;

/** Stash a finished file so another page can pick it up. Keeps the newest few. */
export async function stashFile(record) {
  const id = `f_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
  await idbPut(STORES.files, id, { id, createdAt: Date.now(), ...record });
  const all = await idbAll(STORES.files);
  const stale = all.sort((a, b) => b.createdAt - a.createdAt).slice(6);
  await Promise.all(stale.map((f) => idbDel(STORES.files, f.id)));
  return id;
}

export async function listStashedFiles() {
  const all = await idbAll(STORES.files);
  return all.sort((a, b) => b.createdAt - a.createdAt);
}
