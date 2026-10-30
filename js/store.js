/* Tiny IndexedDB wrapper. Everything is written to the phone as it happens,
 * so a reloaded tab, a crash or a dead signal never loses a hunt. */
(function () {
  'use strict';

  const DB_NAME = 'treasure-hunt';
  const STORES = {
    meta: {},                         // key/value: the current session
    events: { autoIncrement: true },  // interaction log
    gps: { autoIncrement: true },     // GPS fixes
  };

  let dbPromise;
  function open() {
    if (!dbPromise) {
      dbPromise = new Promise((resolve, reject) => {
        const req = indexedDB.open(DB_NAME, 1);
        req.onupgradeneeded = () => {
          for (const [name, opts] of Object.entries(STORES)) {
            if (!req.result.objectStoreNames.contains(name)) req.result.createObjectStore(name, opts);
          }
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
    }
    return dbPromise;
  }

  async function run(storeName, mode, fn) {
    const db = await open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(storeName, mode);
      const req = fn(tx.objectStore(storeName));
      tx.oncomplete = () => resolve(req ? req.result : undefined);
      tx.onerror = tx.onabort = () => reject(tx.error);
    });
  }

  window.Store = {
    get: (store, key) => run(store, 'readonly', (s) => s.get(key)),
    put: (store, value, key) => run(store, 'readwrite', (s) => (key === undefined ? s.put(value) : s.put(value, key))),
    add: (store, value) => run(store, 'readwrite', (s) => s.add(value)),
    getAll: (store) => run(store, 'readonly', (s) => s.getAll()),
    clearAll: () => Promise.all(Object.keys(STORES).map((name) => run(name, 'readwrite', (s) => s.clear()))),
  };
})();
