/**
 * Translation cache.
 *
 * Stores translated strings keyed by the exact inputs that determine the model
 * prompt — model id + source lang + target lang + request format + source text.
 * Because the extension translates each text segment context-free, a cached hit
 * is a translation produced under identical conditions, so it can be reused both
 * later on the same page and across completely different pages/sessions.
 *
 * Two layers:
 *  - An in-memory Map (`mem`) that acts as a fast lookup layer and as the *only*
 *    store when IndexedDB is unavailable. Some hardened browsers (e.g. Mullvad /
 *    Tor-based Firefox) block IndexedDB schema creation; there the cache silently
 *    falls back to memory-only, so it still de-dups and reuses within a session
 *    even though nothing is written to disk.
 *  - IndexedDB, for persistence across sessions when the browser allows it.
 *
 * Loaded in the background context (service worker on Chrome, event-page script
 * on Firefox). Exposes its API on the global object: cacheKey, cacheGetMany,
 * cacheSetMany, cacheClear, cacheCount.
 */
(function () {
    const DB_NAME = 'llm-translator-cache';
    const STORE = 'translations';
    const DB_VERSION = 1;
    const MAX_ENTRIES = 100000;   // soft cap for IndexedDB; oldest entries trimmed when exceeded
    const MEM_MAX = 50000;        // cap for the in-memory layer (bounds RAM use)
    const SEP = String.fromCharCode(0); // NUL — cannot appear in page text

    // In-memory layer: key -> translated text. Fast hits and the fallback store.
    const mem = new Map();
    let idbDisabled = false;   // flipped on once IndexedDB proves unusable, so we
                               // stop retrying (and log-spamming) for this context.
    let dbPromise = null;
    let approxCount = null;    // in-memory entry count; avoids a COUNT on every write

    /** Insert/update a key in the in-memory layer, evicting the oldest entry if over capacity. */
    function memSet(k, v) {
        if (mem.has(k)) mem.delete(k); // re-insert so it counts as most-recent
        mem.set(k, v);
        if (mem.size > MEM_MAX) mem.delete(mem.keys().next().value); // drop oldest
    }

    /** Open (or reuse) the IndexedDB connection, creating the object store on first use. */
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
            // If the DB can't be opened/upgraded (e.g. hardened browsers that
            // block IndexedDB), disable it for this context and fall back to memory.
            req.onerror = () => { dbPromise = null; idbDisabled = true; reject(req.error); };
        });
        return dbPromise;
    }

    /** Build a composite, collision-free cache key (NUL-separated). */
    function cacheKey(model, sourceCode, targetCode, format, text) {
        return [model || '', sourceCode || '', targetCode || '', format || '', text].join(SEP);
    }

    /**
     * Look up many keys at once. Returns a Map of key -> translated text for the
     * keys that were present. Serves from memory first, then IndexedDB for the rest;
     * IndexedDB hits are folded back into the memory layer. Never rejects — on any
     * IndexedDB error it returns whatever the memory layer had.
     */
    function cacheGetMany(keys) {
        if (!keys || keys.length === 0) return Promise.resolve(new Map());
        const out = new Map();
        const missing = [];
        for (const key of keys) {
            if (mem.has(key)) out.set(key, mem.get(key));
            else missing.push(key);
        }
        if (missing.length === 0 || idbDisabled) return Promise.resolve(out);
        return openDB().then(db => new Promise((resolve) => {
            const store = db.transaction(STORE, 'readonly').objectStore(STORE);
            let remaining = missing.length;
            const done = () => { if (--remaining === 0) resolve(out); };
            missing.forEach((key) => {
                const r = store.get(key);
                r.onsuccess = () => { if (r.result) { out.set(key, r.result.v); memSet(key, r.result.v); } done(); };
                r.onerror = () => done();
            });
        })).catch(() => out);
    }

    /**
     * Persist many [key, value] pairs. Always written to the memory layer; also
     * written to IndexedDB when available. Never rejects — an IndexedDB failure
     * just disables it and leaves the entries in memory.
     */
    function cacheSetMany(entries) {
        if (!entries || entries.length === 0) return Promise.resolve();
        for (const [k, v] of entries) memSet(k, v);
        if (idbDisabled) return Promise.resolve();
        const ts = Date.now();
        return openDB().then(db => new Promise((resolve, reject) => {
            const t = db.transaction(STORE, 'readwrite');
            const store = t.objectStore(STORE);
            for (const [k, v] of entries) store.put({ k, v, ts });
            t.oncomplete = () => resolve();
            t.onerror = () => reject(t.error);
        })).then(() => maybeTrim(entries.length))
           .catch(() => { idbDisabled = true; });
    }

    /**
     * Evict oldest entries (by write time) when the store grows past MAX_ENTRIES.
     * Tracks the count in memory so the common path doesn't COUNT the whole store
     * on every write (only once to seed, then on the rare over-cap trim).
     */
    function maybeTrim(added) {
        const seed = (approxCount !== null)
            ? Promise.resolve(approxCount)
            : cacheCount().then(c => (approxCount = c));
        return seed.then(() => {
            approxCount += (added || 0);
            if (approxCount <= MAX_ENTRIES) return;
            let toDelete = approxCount - MAX_ENTRIES + Math.floor(MAX_ENTRIES * 0.1); // slack
            return openDB().then(db => new Promise((resolve) => {
                const store = db.transaction(STORE, 'readwrite').objectStore(STORE);
                const cur = store.index('ts').openCursor();
                cur.onsuccess = () => {
                    const c = cur.result;
                    if (c && toDelete > 0) { c.delete(); toDelete--; approxCount--; c.continue(); }
                    else resolve();
                };
                cur.onerror = () => resolve();
            }));
        });
    }

    /** Clear both the in-memory layer and the IndexedDB store. */
    function cacheClear() {
        mem.clear();
        if (idbDisabled) return Promise.resolve();
        return openDB().then(db => new Promise((resolve, reject) => {
            const r = db.transaction(STORE, 'readwrite').objectStore(STORE).clear();
            r.onsuccess = () => { approxCount = 0; resolve(); };
            r.onerror = () => reject(r.error);
        })).catch(() => { /* memory already cleared */ });
    }

    /**
     * Entry count for display. IndexedDB count when available (authoritative, since
     * memory is a subset of it); otherwise the memory layer's size.
     */
    function cacheCount() {
        if (idbDisabled) return Promise.resolve(mem.size);
        return openDB().then(db => new Promise((resolve, reject) => {
            const r = db.transaction(STORE, 'readonly').objectStore(STORE).count();
            r.onsuccess = () => resolve(r.result);
            r.onerror = () => reject(r.error);
        })).catch(() => mem.size);
    }

    /**
     * Whether real cross-session persistence (IndexedDB) is usable in this browser.
     * Probes by actually opening the DB, so it detects hardened browsers that block
     * schema creation (the open fails and flips idbDisabled). Used by the UI to grey
     * out the "Keep across sessions" option where it can't work.
     */
    function cachePersistentAvailable() {
        if (idbDisabled) return Promise.resolve(false);
        return openDB().then(() => true).catch(() => false);
    }

    const g = (typeof self !== 'undefined') ? self
        : (typeof globalThis !== 'undefined') ? globalThis : window;
    Object.assign(g, { cacheKey, cacheGetMany, cacheSetMany, cacheClear, cacheCount, cachePersistentAvailable });
})();
