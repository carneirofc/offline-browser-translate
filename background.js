/**
 * Background Script for Local LLM Translate
 * Orchestrates the llama-server client + translation pipeline, stores settings,
 * routes messages, and wires the context menus. Provider calls live in
 * llama-server.js; batching/cache/parse/describe live in translate-pipeline.js.
 */

// Use browser API with chrome fallback
const browserAPI = typeof browser !== 'undefined' ? browser : chrome;

// Import shared scripts (for Service Worker context). Order matters: pure helpers
// and the provider/pipeline modules load before this orchestrator uses them.
if (typeof importScripts === 'function') {
    importScripts(
        'languages.js',
        'cache.js',
        'defaults.js',
        'translation-core.js',
        'llama-server.js',
        'translate-pipeline.js'
    );
}

// ============================================================================
// Settings & Constants
// ============================================================================
// DEFAULT_SETTINGS and DEFAULT_DESCRIBE_PROMPT are defined in defaults.js.

let debugEnabled = false;
/** Log to console only when debug mode is enabled in settings. */
function debugLog(...args) { if (debugEnabled) console.log(...args); }
/** Warn to console only when debug mode is enabled in settings. */
function debugWarn(...args) { if (debugEnabled) console.warn(...args); }

// Cache for models to avoid repeated API calls during translation
let cachedModels = null;
let modelsCacheTime = 0;
const MODEL_CACHE_TTL = 60000; // 60 seconds

let cachedSettings = null;

// Legacy setting keys removed in 2.0.0 (multi-provider → llama-server only).
const REMOVED_SETTING_KEYS = ['provider', 'ollamaUrl', 'lmstudioUrl', 'llamacppUrl', 'requestFormat', 'plainTextFallback', 'numCtx'];

// ============================================================================
// Settings Management
// ============================================================================

/**
 * Migrate a legacy stored-settings blob to the llama-server-only shape: fold the
 * old per-provider URLs into `serverUrl` and drop the removed keys.
 * @param {object} stored raw settings from storage
 * @returns {object} migrated settings (still merged over DEFAULT_SETTINGS by the caller)
 */
function migrateSettings(stored) {
    const s = { ...stored };
    if (s.serverUrl == null) {
        s.serverUrl = stored.llamacppUrl || stored.ollamaUrl || stored.lmstudioUrl || DEFAULT_SETTINGS.serverUrl;
    }
    for (const k of REMOVED_SETTING_KEYS) delete s[k];
    return s;
}

/** True when a stored blob still carries removed keys or lacks serverUrl. */
function needsMigration(stored) {
    return !('serverUrl' in stored) || REMOVED_SETTING_KEYS.some(k => k in stored);
}

/** Load settings from storage, migrating + merging over the defaults, and cache the result. */
async function loadSettings() {
    try {
        const result = await browserAPI.storage.local.get('settings');
        const raw = result.settings;
        const migrated = migrateSettings(raw || {});
        cachedSettings = { ...DEFAULT_SETTINGS, ...migrated };
        debugEnabled = !!cachedSettings.debug;
        // Persist the migration so legacy keys don't linger in storage.
        if (raw && needsMigration(raw)) {
            try { await browserAPI.storage.local.set({ settings: cachedSettings }); }
            catch (e) { /* best-effort; migration will retry next load */ }
        }
        return cachedSettings;
    } catch (e) {
        console.error('Failed to load settings:', e);
        cachedSettings = { ...DEFAULT_SETTINGS };
        return cachedSettings;
    }
}

/**
 * Merge new settings over the cached settings (and defaults) and persist to storage.
 * @param {object} settings partial settings to merge in
 * @returns {Promise<object>} the resulting merged settings
 */
async function saveSettings(settings) {
    // Merge defaults < cached < new so fields unknown to the caller are preserved
    cachedSettings = { ...DEFAULT_SETTINGS, ...cachedSettings, ...settings };
    debugEnabled = !!cachedSettings.debug;
    await browserAPI.storage.local.set({ settings: cachedSettings });
    return cachedSettings;
}

/** Get the cached settings, loading them from storage first if not yet cached. */
async function getSettings() {
    if (!cachedSettings) {
        return loadSettings();
    }
    return cachedSettings;
}

// ============================================================================
// Provider + pipeline wiring
// ============================================================================
// createLlamaServer / createPipeline come from llama-server.js / translate-pipeline.js.

/** Build the llama-server provider for the current settings. */
function makeProvider(settings) {
    return createLlamaServer({ serverUrl: settings.serverUrl });
}

// Adapt cache.js's globals to the pipeline's { key, getMany, setMany } shape.
const cacheAdapter = (typeof cacheKey === 'function')
    ? {
        key: (model, sourceCode, targetCode, format, text) => cacheKey(model, sourceCode, targetCode, format, text),
        getMany: (keys) => cacheGetMany(keys),
        setMany: (entries) => cacheSetMany(entries)
    }
    : null;

/** Build a translation pipeline bound to the current settings' provider + cache. */
function makePipeline(settings) {
    return createPipeline({ provider: makeProvider(settings), cache: cacheAdapter });
}

// ============================================================================
// Model listing & auto-selection
// ============================================================================

/**
 * List the models the configured server advertises, using a short-lived
 * in-memory cache unless bypassed.
 * @param {object} settings
 * @param {boolean} [useCache]
 * @returns {Promise<Array<{id: string, name: string}>>}
 */
async function listModels(settings, useCache = true) {
    if (useCache && cachedModels && (Date.now() - modelsCacheTime < MODEL_CACHE_TTL)) {
        return cachedModels;
    }
    const models = await makeProvider(settings).listModels();
    cachedModels = models;
    modelsCacheTime = Date.now();
    return models;
}

/**
 * If no model is configured yet, auto-select and save the first available model.
 * @returns {Promise<object|null>} the selected model, or null if none was chosen
 */
async function autoDetectAndSelectModel() {
    try {
        const settings = await getSettings();
        if (settings.selectedModel) return null; // already configured

        const models = await listModels(settings, false); // force fresh fetch
        if (models.length === 0) return null;

        const preferred = models[0];
        await saveSettings({ selectedModel: preferred.id });
        console.log(`[Background] Auto-selected model: ${preferred.id}`);
        return preferred;
    } catch (e) {
        console.warn('[Background] Auto model detection failed:', e.message);
        return null;
    }
}

// ============================================================================
// Image describe & interpret
// ============================================================================
// The pipeline's describe() takes an already-fetched base64 data URL; fetching an
// arbitrary image URL (which needs host access) stays here in the background.

/**
 * Encode a Blob as a base64 data: URL. Runs in the service worker (no FileReader),
 * so it reads the bytes via arrayBuffer() and base64-encodes with btoa in chunks
 * (String.fromCharCode.apply blows the arg limit on large images otherwise).
 */
async function blobToDataUrl(blob) {
    const bytes = new Uint8Array(await blob.arrayBuffer());
    let binary = '';
    const CHUNK = 0x8000;
    for (let i = 0; i < bytes.length; i += CHUNK) {
        binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
    }
    return `data:${blob.type || 'image/png'};base64,${btoa(binary)}`;
}

/** True only for a canonical base64-encoded image data URL with a non-empty payload. */
function isBase64ImageDataUrl(url) {
    return typeof url === 'string' && /^data:image\/[^;,]+;base64,.+/.test(url);
}

/**
 * Fetch an image URL and return it as a base64 image data: URL. Already-base64
 * `data:` image URLs are returned as-is. Everything else — http(s) URLs and
 * non-base64 data URLs (e.g. URL-encoded SVG) — goes through fetch + blobToDataUrl.
 * For http(s) URLs the service worker needs host access; the on-demand <all_urls>
 * request happens up front in the context-menu click handler (a user gesture).
 */
async function fetchImageAsDataUrl(srcUrl) {
    if (!srcUrl) throw new Error('No image URL found.');
    if (isBase64ImageDataUrl(srcUrl)) return srcUrl;

    let response;
    try {
        response = await fetch(srcUrl);
    } catch (e) {
        throw new Error('Could not download the image. The site may be blocking it, or permission to read images from other sites was denied.');
    }
    if (!response.ok) throw new Error(`Image download failed (HTTP ${response.status}).`);
    const blob = await response.blob();
    if (blob.type && !blob.type.startsWith('image/')) throw new Error('That URL did not return an image.');
    const dataUrl = await blobToDataUrl(blob);
    if (!isBase64ImageDataUrl(dataUrl)) throw new Error('Could not read the image data to send to the model.');
    return dataUrl;
}

/** Fetch+encode an image URL and run the pipeline's describe flow on it. */
async function describeImage(srcUrl) {
    const settings = await getSettings();
    const imageDataUrl = await fetchImageAsDataUrl(srcUrl);
    return makePipeline(settings).describe(imageDataUrl, settings);
}

/**
 * Ensure content.js is present in a tab before messaging it. PING first (cheap,
 * handled by the content script); inject only if that fails.
 */
async function ensureContentScript(tabId) {
    try {
        await browserAPI.tabs.sendMessage(tabId, { type: 'PING' });
    } catch (e) {
        await browserAPI.scripting.executeScript({ target: { tabId }, files: ['translation-core.js', 'content.js'] });
        await new Promise(resolve => setTimeout(resolve, 200));
    }
}

// ============================================================================
// Message Handler
// ============================================================================

browserAPI.runtime.onMessage.addListener((message, sender, sendResponse) => {
    (async () => {
        try {
            const settings = await getSettings();

            switch (message.type) {
                case 'GET_SETTINGS':
                    sendResponse({ settings });
                    break;

                case 'SAVE_SETTINGS': {
                    const saved = await saveSettings(message.settings);
                    sendResponse({ settings: saved });
                    break;
                }

                case 'DETECT_PROVIDERS': {
                    // Single-server probe. Response: { available, blocked }.
                    const status = await makeProvider(settings).probeServer();
                    sendResponse(status);
                    break;
                }

                case 'LIST_MODELS': {
                    // Pass forceRefresh to bypass cache when user clicks refresh
                    const models = await listModels(settings, !message.forceRefresh);
                    sendResponse({ models });
                    break;
                }

                case 'REGISTER_CONTENT_SCRIPT':
                    try {
                        await browserAPI.scripting.registerContentScripts([{
                            id: 'llm-translator-content',
                            matches: ['http://*/*', 'https://*/*'],
                            js: ['translation-core.js', 'content.js'],
                            runAt: 'document_idle'
                        }]);
                    } catch (e) {
                        // Already registered — not an error
                    }
                    sendResponse({ ok: true });
                    break;

                case 'UNREGISTER_CONTENT_SCRIPT':
                    try {
                        await browserAPI.scripting.unregisterContentScripts({ ids: ['llm-translator-content'] });
                    } catch (e) {
                        // Not registered — not an error
                    }
                    sendResponse({ ok: true });
                    break;

                case 'TRANSLATE': {
                    let settingsWithSource = {
                        ...settings,
                        sourceLanguage: message.sourceLanguage || settings.sourceLanguage || 'en'
                    };

                    // Auto-detect model if none selected (e.g. fresh install)
                    if (!settingsWithSource.selectedModel) {
                        await autoDetectAndSelectModel();
                        const refreshed = await getSettings();
                        settingsWithSource = { ...settingsWithSource, selectedModel: refreshed.selectedModel };
                    }

                    const pipeline = makePipeline(settingsWithSource);

                    // Stream when enabled and we can push deltas back to the
                    // originating tab; otherwise use the stable batched-JSON path.
                    const streamTabId = sender && sender.tab && sender.tab.id;
                    let result;
                    if (settingsWithSource.streamTranslations !== false && streamTabId !== undefined && streamTabId !== null) {
                        // Coalesce deltas so we don't flood the messaging channel.
                        const pending = new Map();
                        let flushTimer = null;
                        const flush = () => {
                            flushTimer = null;
                            if (pending.size === 0) return;
                            const translations = [...pending.entries()].map(([id, text]) => ({ id, text }));
                            pending.clear();
                            browserAPI.tabs.sendMessage(streamTabId, { type: 'PARTIAL_TRANSLATION', translations }).catch(() => {});
                        };
                        const emit = (id, text) => {
                            pending.set(id, text);
                            if (!flushTimer) flushTimer = setTimeout(flush, 60);
                        };
                        result = await pipeline.translateStream(
                            message.texts,
                            message.targetLanguage,
                            settingsWithSource,
                            emit
                        );
                        if (flushTimer) clearTimeout(flushTimer);
                        flush(); // push any remaining deltas before resolving
                    } else {
                        result = await pipeline.translate(
                            message.texts,
                            message.targetLanguage,
                            settingsWithSource
                        );
                    }
                    sendResponse({
                        translations: result.translations,
                        fromCache: result.fromCache,
                        total: result.total,
                        cacheActive: result.cacheActive
                    });
                    break;
                }

                case 'CLEAR_CACHE':
                    try {
                        await cacheClear();
                        sendResponse({ ok: true });
                    } catch (e) {
                        sendResponse({ ok: false, error: e && e.message });
                    }
                    break;

                case 'CACHE_COUNT':
                    try {
                        sendResponse({ count: await cacheCount() });
                    } catch (e) {
                        sendResponse({ count: 0, error: e && e.message });
                    }
                    break;

                case 'CACHE_BACKEND':
                    try {
                        sendResponse({ persistent: await cachePersistentAvailable() });
                    } catch (e) {
                        sendResponse({ persistent: false, error: e && e.message });
                    }
                    break;

                default:
                    sendResponse({ error: 'Unknown message type' });
            }
        } catch (e) {
            console.error('[Background] Error:', e);
            sendResponse({ error: e.message });
        }
    })();

    return true; // Keep the message channel open for async response
});

// On browser startup, wipe the translation cache if the user chose the
// 'session' mode (keep until the browser closes).
browserAPI.runtime.onStartup.addListener(async () => {
    try {
        const settings = await getSettings();
        if (settings.cacheMode === 'session' && typeof cacheClear === 'function') {
            await cacheClear();
        }
    } catch (e) {
        // Best-effort; a failed clear just leaves the previous session's cache.
    }
});

// ============================================================================
// Context Menu
// ============================================================================

browserAPI.runtime.onInstalled.addListener(async () => {
    browserAPI.contextMenus.create({
        id: "translate-page",
        title: "Translate Page",
        contexts: ["page"]
    }, () => { if (browserAPI.runtime.lastError) {} });

    browserAPI.contextMenus.create({
        id: "translate-selection",
        title: "Translate Selection",
        contexts: ["selection"]
    }, () => { if (browserAPI.runtime.lastError) {} });

    browserAPI.contextMenus.create({
        id: "describe-image",
        title: "Describe & interpret image",
        contexts: ["image"]
    }, () => { if (browserAPI.runtime.lastError) {} });

    // Auto-detect and select a model on fresh install (when none is configured yet)
    await autoDetectAndSelectModel();

    // Re-register content script auto-injection if the user had the floating button enabled.
    const settings = await getSettings();
    if (settings.floatingButton) {
        try {
            await browserAPI.scripting.registerContentScripts([{
                id: 'llm-translator-content',
                matches: ['http://*/*', 'https://*/*'],
                js: ['translation-core.js', 'content.js'],
                runAt: 'document_idle'
            }]);
        } catch (e) {
            // Already registered
        }
    }
});

browserAPI.contextMenus.onClicked.addListener(async (info, tab) => {
    if (info.menuItemId === "translate-page") {
        if (!tab || !tab.id) return;

        try {
            const settings = await getSettings();

            // Resolve source language - if 'auto', try to detect it programmatically
            let sourceLang = settings.sourceLanguage;
            if (!sourceLang || sourceLang === 'auto') {
                try {
                    const result = await browserAPI.scripting.executeScript({
                        target: { tabId: tab.id },
                        func: () => {
                            const htmlLang = document.documentElement.lang || document.querySelector('html')?.getAttribute('lang');
                            if (htmlLang) return htmlLang.split('-')[0].toLowerCase();
                            const metaLang = document.querySelector('meta[http-equiv="content-language"]')?.getAttribute('content');
                            if (metaLang) return metaLang.split('-')[0].toLowerCase();
                            return null;
                        }
                    });
                    if (result && result[0] && result[0].result) {
                        sourceLang = result[0].result;
                        console.log(`[Background] Detected page language for context menu: ${sourceLang}`);
                    }
                } catch (detectErr) {
                    console.log('[Background] Could not detect language from background:', detectErr);
                }
            }

            const sendTranslationMessage = async () => {
                await browserAPI.tabs.sendMessage(tab.id, {
                    type: 'START_TRANSLATION',
                    targetLanguage: settings.targetLanguage,
                    sourceLanguage: sourceLang || 'auto',
                    showGlow: settings.showGlow,
                    maxConcurrentRequests: settings.maxConcurrentRequests || 4
                });
            };

            try {
                await sendTranslationMessage();
            } catch (e) {
                console.log('[Background] Initial translation connection failed, attempting injection:', e);
                await browserAPI.scripting.executeScript({
                    target: { tabId: tab.id },
                    files: ['translation-core.js', 'content.js']
                });
                await new Promise(resolve => setTimeout(resolve, 200));
                await sendTranslationMessage();
            }

        } catch (e) {
            console.error('[Background] Context menu translation failed:', e);
        }
    } else if (info.menuItemId === "translate-selection") {
        if (!tab || !tab.id) return;

        try {
            const settings = await getSettings();

            let sourceLang = settings.sourceLanguage;
            if (!sourceLang || sourceLang === 'auto') {
                try {
                    const result = await browserAPI.scripting.executeScript({
                        target: { tabId: tab.id },
                        func: () => {
                            const htmlLang = document.documentElement.lang || document.querySelector('html')?.getAttribute('lang');
                            if (htmlLang) return htmlLang.split('-')[0].toLowerCase();
                            const metaLang = document.querySelector('meta[http-equiv="content-language"]')?.getAttribute('content');
                            if (metaLang) return metaLang.split('-')[0].toLowerCase();
                            return null;
                        }
                    });
                    if (result?.[0]?.result) sourceLang = result[0].result;
                } catch (detectErr) { /* ignore */ }
            }

            const sendSelectionMessage = async () => {
                await browserAPI.tabs.sendMessage(tab.id, {
                    type: 'TRANSLATE_SELECTION',
                    targetLanguage: settings.targetLanguage,
                    sourceLanguage: sourceLang || 'auto',
                    showGlow: settings.showGlow,
                    maxConcurrentRequests: settings.maxConcurrentRequests || 4
                });
            };

            try {
                await sendSelectionMessage();
            } catch (e) {
                await browserAPI.scripting.executeScript({ target: { tabId: tab.id }, files: ['translation-core.js', 'content.js'] });
                await new Promise(resolve => setTimeout(resolve, 200));
                await sendSelectionMessage();
            }

        } catch (e) {
            console.error('[Background] Context menu selection translation failed:', e);
        }
    } else if (info.menuItemId === "describe-image") {
        if (!tab || !tab.id) return;

        const srcUrl = info.srcUrl;

        // Request the optional <all_urls> host permission up front, while we still
        // have the click's user gesture — permissions.request needs one, and it
        // would be gone after the async fetch. No-ops if already granted; skipped
        // for data: URLs which need no fetch.
        if (srcUrl && !srcUrl.startsWith('data:')) {
            try {
                await browserAPI.permissions.request({ origins: ['<all_urls>'] });
            } catch (permErr) {
                // Proceed anyway — same-origin/already-permitted images may still fetch.
            }
        }

        try {
            await ensureContentScript(tab.id);
            await browserAPI.tabs.sendMessage(tab.id, { type: 'DESCRIBE_IMAGE_START' });
        } catch (e) {
            console.error('[Background] Could not open the description overlay:', e);
            return;
        }

        try {
            const text = await describeImage(srcUrl);
            await browserAPI.tabs.sendMessage(tab.id, { type: 'DESCRIBE_IMAGE_RESULT', text });
        } catch (e) {
            console.error('[Background] Image description failed:', e);
            try {
                await browserAPI.tabs.sendMessage(tab.id, { type: 'DESCRIBE_IMAGE_ERROR', error: e.message });
            } catch (sendErr) { /* overlay gone */ }
        }
    }
});

// Initialize settings on startup
loadSettings().then(() => {
    console.log('[Background] Local LLM Translate background script loaded');
});
