/**
 * Translation cache (IndexedDB).
 *
 * Stores translated strings keyed by the exact inputs that determine the model
 * prompt — model id + source lang + target lang + request format + source text.
 * Because the extension translates each text segment context-free, a cached hit
 * is a translation produced under identical conditions, so it can be reused both
 * later on the same page and across completely different pages/sessions.
 *
 * Loaded in the background context (service worker on Chrome, event-page script
 * on Firefox). Exposes its API on the global object: cacheKey, cacheGetMany,
 * cacheSetMany, cacheClear, cacheCount.
 */
(function () {
    const DB_NAME = 'llm-translator-cache';
    const STORE = 'translations';
    const DB_VERSION = 1;
    const MAX_ENTRIES = 100000;   // soft cap; oldest entries trimmed when exceeded
    const SEP = String.fromCharCode(0); // NUL — cannot appear in page text

    let dbPromise = null;

    function openDB() {
        if (dbPromise) return dbPromise;
        dbPromise = new Promise((resolve, reject) => {
            const req = indexedDB.open(DB_NAME, DB_VERSION);
            req.onupgradeneeded = () => {
                const db = req.result;
                if (!db.objectStoreNames.contains(STORE)) {
                    const store = db.createObjectStore(STORE, { keyPath: 'k' });
                    store.createIndex('ts', 'ts', { unique: false });
                }
            };
            req.onsuccess = () => resolve(req.result);
            req.onerror = () => reject(req.error);
        });
        return dbPromise;
    }

    // Composite, collision-free key (NUL-separated).
    function cacheKey(model, sourceCode, targetCode, format, text) {
        return [model || '', sourceCode || '', targetCode || '', format || '', text].join(SEP);
    }

    // Look up many keys at once. Returns a Map of key -> translated text for the
    // keys that were present (missing keys are simply absent from the Map).
    function cacheGetMany(keys) {
        if (!keys || keys.length === 0) return Promise.resolve(new Map());
        return openDB().then(db => new Promise((resolve) => {
            const store = db.transaction(STORE, 'readonly').objectStore(STORE);
            const out = new Map();
            let remaining = keys.length;
            const done = () => { if (--remaining === 0) resolve(out); };
            keys.forEach((key) => {
                const r = store.get(key);
                r.onsuccess = () => { if (r.result) out.set(key, r.result.v); done(); };
                r.onerror = () => done();
            });
        }));
    }

    // Persist many [key, value] pairs in a single transaction, then trim if over cap.
    function cacheSetMany(entries) {
        if (!entries || entries.length === 0) return Promise.resolve();
        const ts = Date.now();
        return openDB().then(db => new Promise((resolve, reject) => {
            const t = db.transaction(STORE, 'readwrite');
            const store = t.objectStore(STORE);
            for (const [k, v] of entries) store.put({ k, v, ts });
            t.oncomplete = () => resolve();
            t.onerror = () => reject(t.error);
        })).then(maybeTrim);
    }

    // Evict oldest entries (by write time) when the store grows past MAX_ENTRIES.
    function maybeTrim() {
        return openDB().then(db => new Promise((resolve) => {
            const store = db.transaction(STORE, 'readwrite').objectStore(STORE);
            const cnt = store.count();
            cnt.onsuccess = () => {
                let toDelete = cnt.result - MAX_ENTRIES;
                if (toDelete <= 0) { resolve(); return; }
                toDelete += Math.floor(MAX_ENTRIES * 0.1); // delete a slack chunk to avoid trimming every write
                const cur = store.index('ts').openCursor();
                cur.onsuccess = () => {
                    const c = cur.result;
                    if (c && toDelete > 0) { c.delete(); toDelete--; c.continue(); }
                    else resolve();
                };
                cur.onerror = () => resolve();
            };
            cnt.onerror = () => resolve();
        }));
    }

    function cacheClear() {
        return openDB().then(db => new Promise((resolve, reject) => {
            const r = db.transaction(STORE, 'readwrite').objectStore(STORE).clear();
            r.onsuccess = () => resolve();
            r.onerror = () => reject(r.error);
        }));
    }

    function cacheCount() {
        return openDB().then(db => new Promise((resolve, reject) => {
            const r = db.transaction(STORE, 'readonly').objectStore(STORE).count();
            r.onsuccess = () => resolve(r.result);
            r.onerror = () => reject(r.error);
        }));
    }

    const g = (typeof self !== 'undefined') ? self
        : (typeof globalThis !== 'undefined') ? globalThis : window;
    Object.assign(g, { cacheKey, cacheGetMany, cacheSetMany, cacheClear, cacheCount });
})();
