// The browser's disk: a small async key-value store, and two of them.
//
// Everything poptart keeps - saved patterns, autosaved sessions, history snapshots, snippets,
// the star library, captured plugin state - is a path and some text on the desktop. In a browser
// there is no path and no text file, so the same things become keys and values in IndexedDB,
// under the SAME names they have on disk. That is deliberate: it means an export is a walk of
// this store writing files, an import is the reverse, and the two builds can hand work to each
// other without either one learning the other's layout.
//
// The interface is the smallest thing every caller needs - get, put, delete, keys - and the two
// implementations of it are the whole point. `memoryStore` is not a test fixture pretending to
// be a database; it is what the app falls back to when IndexedDB is unavailable, which happens
// for real in a private window and behind a blocked-storage setting. A page that refuses to
// start because it cannot save is worse than a page that starts and says nothing will be kept.

/** How a store reports what it can and cannot promise, for the line the app shows about it. */
export const DURABLE = 'durable';
export const EPHEMERAL = 'ephemeral';

/**
 * A store that lives as long as the tab does.
 *
 * Used for the fallback above and for tests, where it is exactly right: the logic on top of a
 * store is worth testing and IndexedDB is not, so the tests drive this and the database driver
 * below stays thin enough to read.
 */
export function memoryStore() {
  const map = new Map();
  return {
    kind: EPHEMERAL,
    async get(key) {
      const held = map.get(String(key));
      // Handed back as a copy. A caller that mutated what it read would otherwise change what is
      // "stored" without storing anything, which works here and fails against a real database -
      // the worst kind of difference between a fallback and the thing it stands in for.
      return held === undefined ? null : structuredClone(held);
    },
    async put(key, value) {
      map.set(String(key), structuredClone(value));
    },
    async delete(key) {
      map.delete(String(key));
    },
    async keys(prefix = '') {
      return [...map.keys()].filter((k) => k.startsWith(prefix)).sort();
    },
    async clear() {
      map.clear();
    },
    async close() {},
  };
}

const DB_NAME = 'poptart';
const DB_VERSION = 1;
const STORE = 'files';

/**
 * Opens the browser's own store.
 *
 * Rejects rather than throwing synchronously, and the caller is expected to catch: every way this
 * can fail - private browsing, blocked site data, a database another tab is holding open at an
 * older version - is a condition the app has to survive rather than a bug to report.
 */
export function openDatabase(name = DB_NAME, version = DB_VERSION) {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new Error('this browser has no IndexedDB'));
      return;
    }
    const request = indexedDB.open(name, version);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('could not open the database'));
    // A second tab holding the database open at an older version blocks the upgrade forever
    // rather than failing, so it is failed here instead of hanging the page on a blank screen.
    request.onblocked = () => reject(new Error('another poptart tab is holding the database open'));
  });
}

const promised = (request) => new Promise((resolve, reject) => {
  request.onsuccess = () => resolve(request.result);
  request.onerror = () => reject(request.error);
});

/** A store backed by IndexedDB. */
export async function databaseStore(name = DB_NAME) {
  const db = await openDatabase(name);
  const run = (mode, fn) => {
    const tx = db.transaction(STORE, mode);
    const result = fn(tx.objectStore(STORE));
    return new Promise((resolve, reject) => {
      tx.oncomplete = () => resolve(result);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error ?? new Error('the write was aborted'));
    }).then(() => result);
  };
  return {
    kind: DURABLE,
    async get(key) {
      const tx = db.transaction(STORE, 'readonly');
      const value = await promised(tx.objectStore(STORE).get(String(key)));
      return value === undefined ? null : value;
    },
    async put(key, value) { await run('readwrite', (s) => s.put(value, String(key))); },
    async delete(key) { await run('readwrite', (s) => s.delete(String(key))); },
    async keys(prefix = '') {
      const tx = db.transaction(STORE, 'readonly');
      const all = await promised(tx.objectStore(STORE).getAllKeys());
      return all.map(String).filter((k) => k.startsWith(prefix)).sort();
    },
    async clear() { await run('readwrite', (s) => s.clear()); },
    async close() { db.close(); },
  };
}

/**
 * The store the app runs on: the browser's if it will have us, memory if it will not.
 *
 * Returns the store and what it is, so the app can say so once rather than discovering halfway
 * through a set that nothing has been saved. Asking for persistence is a request, not a
 * guarantee - a browser may say no, and a browser that says yes may still clear the site under
 * storage pressure - so the answer is reported and never relied on.
 */
export async function openStore({ persist = true } = {}) {
  try {
    const store = await databaseStore();
    let persisted = false;
    if (persist && typeof navigator !== 'undefined' && navigator.storage?.persist) {
      persisted = await navigator.storage.persist().catch(() => false);
    }
    return { store, kind: DURABLE, persisted, reason: null };
  } catch (err) {
    return { store: memoryStore(), kind: EPHEMERAL, persisted: false, reason: err.message };
  }
}
