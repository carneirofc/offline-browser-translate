/**
 * Translation pipeline: batching, de-duplication, caching, output retries,
 * response parsing, and image-describe orchestration — everything between the
 * content script's TRANSLATE request and the provider's network calls.
 *
 * `createPipeline({ provider, cache })` injects:
 *  - `provider` — an object implementing the llama-server interface
 *    ({ chatCompletion, chatCompletionStream, describeVision }); see llama-server.js.
 *  - `cache` — optional { key, getMany, setMany } (adapts cache.js). Caching is
 *    active only when settings.cacheMode !== 'off' and a cache is supplied.
 *
 * With both injectable, the whole pipeline is unit-testable under Node with a
 * mocked provider + cache. The pure prompt/parse helpers come from
 * translation-core.js and languages.js (globals in the browser, `require`d under
 * CommonJS), matching the dual-target idiom used across this codebase.
 */
(function () {
    'use strict';

    const isCJS = (typeof module !== 'undefined' && module.exports);
    const g = (typeof self !== 'undefined') ? self
        : (typeof globalThis !== 'undefined') ? globalThis : this;

    // Pure helpers: globals in the browser (loaded earlier via background.scripts),
    // required modules under Node.
    const core = isCJS ? require('./translation-core.js') : g;
    const langs = isCJS ? require('./languages.js') : g;
    const defaults = isCJS ? require('./defaults.js') : g;
    const {
        formatTextsForPrompt, buildPrompt, parseTranslationResponse,
        cleanTranslationText, isSuspiciousTranslation, normalizeLangCode
    } = core;
    const getLanguageName = langs.getLanguageName;

    // Built-in translation prompt (single JSON path), shared with the options
    // page via defaults.js. Custom prompts (settings.useAdvanced) override it.
    const DEFAULT_TEMPLATE = defaults.DEFAULT_TRANSLATE_TEMPLATE;

    // JSON schema for the batched translation response (OpenAI `response_format`).
    const TRANSLATION_JSON_SCHEMA = {
        type: 'object',
        properties: {
            translations: {
                type: 'array',
                items: {
                    type: 'object',
                    properties: {
                        id: { type: 'integer' },
                        text: { type: 'string' }
                    },
                    required: ['id', 'text'],
                    additionalProperties: false
                }
            }
        },
        required: ['translations'],
        additionalProperties: false
    };

    /**
     * Small fast non-cryptographic string hash (cyrb53). Folds the prompt shape
     * (templates + sampling params) into a compact cache-key token.
     */
    function hashString(str) {
        let h1 = 0xdeadbeef, h2 = 0x41c6ce57;
        for (let i = 0; i < str.length; i++) {
            const ch = str.charCodeAt(i);
            h1 = Math.imul(h1 ^ ch, 2654435761);
            h2 = Math.imul(h2 ^ ch, 1597334677);
        }
        h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
        h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
        return (h2 >>> 0).toString(36) + (h1 >>> 0).toString(36);
    }

    /**
     * Resolve the model, prompt templates, and source-language variables shared
     * by translate() and translateStream() — the setup that used to be duplicated
     * across both. Returns everything the two paths need to build prompts and
     * cache keys.
     * @param {Settings} settings
     * @param {string} targetLanguage
     */
    function resolveJob(settings, targetLanguage) {
        const modelId = settings.selectedModel;
        if (!modelId) throw new Error('No model selected');

        let systemTemplate = DEFAULT_TEMPLATE.system;
        let userTemplate = DEFAULT_TEMPLATE.user;
        if (settings.useAdvanced) {
            if (settings.customSystemPrompt) systemTemplate = settings.customSystemPrompt;
            if (settings.customUserPromptTemplate) userTemplate = settings.customUserPromptTemplate;
        }

        // The content script resolves the source language (script detection + page
        // metadata) and passes it as settings.sourceLanguage, so a Japanese page
        // arrives here as 'ja', not 'en'.
        const targetLangName = getLanguageName(targetLanguage);
        const explicitSource = (settings.sourceLanguage && settings.sourceLanguage !== 'auto')
            ? (normalizeLangCode(settings.sourceLanguage) || settings.sourceLanguage)
            : '';
        const sourceLangCode = explicitSource || 'en';
        const sourceLangName = explicitSource ? getLanguageName(explicitSource) : 'the source language';
        const baseVars = {
            targetLanguage: targetLangName,
            sourceLang: sourceLangName,
            sourceCode: sourceLangCode.toUpperCase(),
            targetLang: targetLangName,
            targetCode: targetLanguage.toUpperCase()
        };

        return { modelId, systemTemplate, userTemplate, targetLangName, sourceLangCode, baseVars };
    }

    /**
     * Build the pipeline bound to a provider and (optional) cache.
     * @param {{provider: TranslationProvider, cache?: PipelineCache}} deps
     */
    function createPipeline(deps) {
        const provider = deps && deps.provider;
        const cache = deps && deps.cache;

        /**
         * Whether caching is active for this request.
         * @param {Settings} settings
         */
        function cacheEnabledFor(settings) {
            return settings.cacheMode !== 'off' && cache && typeof cache.key === 'function';
        }

        /**
         * Translate a batch of text items: resolve prompt/model, send batched
         * requests, retry missing/malformed results, dedup + cache, and return the
         * translated texts in original order.
         * @param {Array<{id:*, text:string}>} textItems
         * @param {string} targetLanguage
         * @param {Settings} settings
         * @returns {Promise<{translations:Array, fromCache:number, total:number, cacheActive:boolean}>}
         */
        async function translate(textItems, targetLanguage, settings) {
            const { modelId, systemTemplate, userTemplate, sourceLangCode, baseVars } =
                resolveJob(settings, targetLanguage);

            const wantJson = !!settings.useStructuredOutput;

            // Run one batched request for the given subset of items, returning a Map
            // of originalId -> good translation text (suspicious/empty are dropped).
            const requestBatch = async (items) => {
                const mappedItems = items.map((item, index) => ({ id: index, text: item.text, originalId: item.id }));
                const vars = { ...baseVars, texts: formatTextsForPrompt(mappedItems) };
                const userPrompt = buildPrompt(userTemplate, vars);
                const systemPrompt = buildPrompt(systemTemplate, vars);
                const raw = await provider.chatCompletion(modelId, systemPrompt, userPrompt, {
                    jsonSchema: wantJson ? TRANSLATION_JSON_SCHEMA : null,
                    schemaName: 'translation_response',
                    temperature: settings.temperature
                });
                const parsed = parseTranslationResponse(raw, mappedItems);
                const good = new Map();
                for (const t of parsed) {
                    if (t && t.text && !t.error && !isSuspiciousTranslation(t.text)) {
                        const originalItem = mappedItems.find(m => m.id === t.id);
                        if (originalItem) good.set(originalItem.originalId, t.text);
                    }
                }
                return good;
            };

            const results = new Map();

            // ---- Cache + de-duplication ----------------------------------------
            const cacheEnabled = cacheEnabledFor(settings);
            const promptSig = hashString([
                wantJson ? 'json' : 'plain', String(settings.temperature),
                systemTemplate, userTemplate
            ].join(' '));
            const keyFor = cacheEnabled
                ? (text) => cache.key(modelId, sourceLangCode, targetLanguage, promptSig, text)
                : (text) => text;

            const groups = new Map();
            for (const item of textItems) {
                const k = keyFor(item.text);
                const grp = groups.get(k);
                if (grp) grp.ids.push(item.id);
                else groups.set(k, { key: k, item, ids: [item.id] });
            }

            let fromCacheItems = 0;
            let missGroups;
            if (cacheEnabled) {
                try {
                    const found = await cache.getMany([...groups.keys()]);
                    missGroups = [];
                    for (const grp of groups.values()) {
                        const cached = found.get(grp.key);
                        if (cached !== undefined) {
                            results.set(grp.item.id, cached);
                            fromCacheItems += grp.ids.length;
                        } else {
                            missGroups.push(grp);
                        }
                    }
                } catch (e) {
                    missGroups = [...groups.values()];
                }
            } else {
                missGroups = [...groups.values()];
            }

            let pending = missGroups.map(grp => grp.item);

            // Batched request, retrying only items that came back missing/malformed.
            const maxRetries = Number.isInteger(settings.maxOutputRetries) ? settings.maxOutputRetries : 2;
            for (let attempt = 0; attempt <= maxRetries && pending.length > 0; attempt++) {
                let good;
                try {
                    good = await requestBatch(pending);
                } catch (e) {
                    if (attempt === maxRetries) throw e; // bubble transport errors on last try
                    continue;
                }
                for (const item of pending) {
                    const text = good.get(item.id);
                    if (text !== undefined) results.set(item.id, text);
                }
                pending = pending.filter(item => !results.has(item.id));
            }

            // Persist freshly produced translations (awaited so an MV3 worker isn't
            // torn down before the write commits).
            if (cacheEnabled) {
                const entries = [];
                for (const grp of missGroups) {
                    if (results.has(grp.item.id)) entries.push([grp.key, results.get(grp.item.id)]);
                }
                if (entries.length) {
                    try { await cache.setMany(entries); } catch (e) { /* best-effort */ }
                }
            }

            // Fan each group's translation out to every member sharing its text.
            for (const grp of groups.values()) {
                if (!results.has(grp.item.id)) continue;
                const text = results.get(grp.item.id);
                for (const id of grp.ids) results.set(id, text);
            }

            const translations = textItems.map(item => results.has(item.id)
                ? { id: item.id, text: results.get(item.id) }
                : { id: item.id, error: 'translation failed' });
            return { translations, fromCache: fromCacheItems, total: textItems.length, cacheActive: cacheEnabled };
        }

        /**
         * Streaming counterpart to translate(): one plain-text streaming request
         * per unique segment, emitting the growing translation to emit(id, textSoFar).
         * @param {Array<{id:*, text:string}>} textItems
         * @param {string} targetLanguage
         * @param {Settings} settings
         * @param {(id:*, textSoFar:string)=>void} emit
         * @returns {Promise<{translations:Array, fromCache:number, total:number, cacheActive:boolean}>}
         */
        async function translateStream(textItems, targetLanguage, settings, emit) {
            const { modelId, targetLangName, sourceLangCode } = resolveJob(settings, targetLanguage);

            const genericSystem = `You are a professional translator. Translate the user's text into ${targetLangName}. Output ONLY the translation, with no quotes, labels, JSON, or commentary.`;

            const cacheEnabled = cacheEnabledFor(settings);
            // Mark the plain streaming path so streamed and batched-JSON entries
            // never collide in the cache.
            const promptSig = hashString(['stream', String(settings.temperature), sourceLangCode].join(' '));
            const keyFor = cacheEnabled
                ? (text) => cache.key(modelId, sourceLangCode, targetLanguage, promptSig, text)
                : (text) => text;

            const groups = new Map();
            for (const item of textItems) {
                const k = keyFor(item.text);
                const grp = groups.get(k);
                if (grp) grp.ids.push(item.id);
                else groups.set(k, { key: k, item, ids: [item.id] });
            }

            const results = new Map();
            let fromCacheItems = 0;
            let missGroups;
            if (cacheEnabled) {
                try {
                    const found = await cache.getMany([...groups.keys()]);
                    missGroups = [];
                    for (const grp of groups.values()) {
                        const cached = found.get(grp.key);
                        if (cached !== undefined) {
                            for (const id of grp.ids) { results.set(id, cached); emit(id, cached); }
                            fromCacheItems += grp.ids.length;
                        } else {
                            missGroups.push(grp);
                        }
                    }
                } catch (e) {
                    missGroups = [...groups.values()];
                }
            } else {
                missGroups = [...groups.values()];
            }

            // Stream each unique miss sequentially (parallelism comes from the
            // content script running several batches at once).
            const cacheEntries = [];
            for (const grp of missGroups) {
                let acc = '';
                try {
                    await provider.chatCompletionStream(modelId, genericSystem, grp.item.text, (delta) => {
                        acc += delta;
                        const live = cleanTranslationText(acc);
                        for (const id of grp.ids) emit(id, live);
                    }, { temperature: settings.temperature });
                    const final = cleanTranslationText((acc || '').trim());
                    if (final && !isSuspiciousTranslation(final)) {
                        for (const id of grp.ids) { results.set(id, final); emit(id, final); }
                        if (cacheEnabled) cacheEntries.push([grp.key, final]);
                    }
                } catch (e) {
                    // Leave the original text in place (no final emit).
                }
            }

            if (cacheEnabled && cacheEntries.length) {
                try { await cache.setMany(cacheEntries); } catch (e) { /* best-effort */ }
            }

            const translations = textItems.map(item => results.has(item.id)
                ? { id: item.id, text: results.get(item.id) }
                : { id: item.id, error: 'translation failed' });
            return { translations, fromCache: fromCacheItems, total: textItems.length, cacheActive: cacheEnabled };
        }

        /**
         * Describe & interpret one image (already fetched to a base64 `data:` URL):
         * resolve the vision model, build the prompt in the user's target language,
         * serve/store a cached description, and return the model's text.
         * @param {string} imageDataUrl base64 image data URL
         * @param {Settings} settings
         * @returns {Promise<string>}
         */
        async function describe(imageDataUrl, settings) {
            const modelId = settings.visionModel || settings.selectedModel;
            if (!modelId) throw new Error('No vision model configured. Choose one in the extension options.');

            const imageBase64 = (imageDataUrl || '').replace(/^data:[^;]*;base64,/, '');
            if (!imageBase64) throw new Error('No image data to send to the model.');

            const targetLanguage = settings.targetLanguage || 'en';
            const targetLangName = getLanguageName(targetLanguage);
            const defaultPrompt = (typeof g.DEFAULT_DESCRIBE_PROMPT !== 'undefined') ? g.DEFAULT_DESCRIBE_PROMPT : '';
            const promptTemplate = settings.describePrompt || defaultPrompt;
            const prompt = promptTemplate.replace(/{{targetLanguage}}/g, targetLangName);

            // Serve a cached description when the same image bytes were already
            // analyzed with the same model, target language, and prompt.
            const cacheEnabled = cacheEnabledFor(settings);
            const describeKey = cacheEnabled
                ? cache.key(modelId, '', targetLanguage, `describe:${hashString(prompt)}`, hashString(imageBase64))
                : null;
            if (cacheEnabled) {
                try {
                    const found = await cache.getMany([describeKey]);
                    const hit = found.get(describeKey);
                    if (hit !== undefined) return hit;
                } catch (e) { /* fall through to a live call */ }
            }

            const text = await provider.describeVision(modelId, prompt, imageDataUrl, { temperature: settings.temperature });
            if (!text || !text.trim()) throw new Error('The model returned an empty response.');
            const result = text.trim();

            if (cacheEnabled) {
                try { await cache.setMany([[describeKey, result]]); } catch (e) { /* best-effort */ }
            }
            return result;
        }

        return { translate, translateStream, describe };
    }

    const api = { createPipeline, TRANSLATION_JSON_SCHEMA, hashString };

    Object.assign(g, api);

    if (typeof module !== 'undefined' && module.exports) {
        module.exports = api;
    }
})();
