/**
 * Background Script for Local LLM Translator
 * Handles LLM API calls, settings storage, and message routing
 */

// Use browser API with chrome fallback
const browserAPI = typeof browser !== 'undefined' ? browser : chrome;

// Import shared scripts (for Service Worker context). defaults.js defines the
// shared DEFAULT_SETTINGS used across the background and all UI screens.
if (typeof importScripts === 'function') {
    importScripts('languages.js', 'cache.js', 'defaults.js', 'translation-core.js');
}

// ============================================================================
// Settings & Constants
// ============================================================================
// DEFAULT_SETTINGS is defined in defaults.js (single source of truth).

let debugEnabled = false;
/** Log to console only when debug mode is enabled in settings. */
function debugLog(...args) { if (debugEnabled) console.log(...args); }
/** Warn to console only when debug mode is enabled in settings. */
function debugWarn(...args) { if (debugEnabled) console.warn(...args); }

const PROMPT_TEMPLATES = {
    default: {
        system: `You are a professional translator translating from {{sourceLang}} to {{targetLanguage}}. The numbered texts are consecutive segments of one continuous passage — translate them together so pronouns, dropped subjects, and honorifics stay consistent.
Respond ONLY with a JSON object in this exact format:
{"translations": [{"id": 0, "text": "translated text"}, {"id": 1, "text": "another translation"}]}
Maintain the original meaning, tone, and formatting. Do not add explanations.`,
        user: `Translate the following {{sourceLang}} texts to {{targetLanguage}}:\n{{texts}}`
    },
    translategemma: {
        // TranslateGemma EXACT format - do not modify
        system: '',
        user: `You are a professional {{sourceLang}} ({{sourceCode}}) to {{targetLang}} ({{targetCode}}) translator. Your goal is to accurately convey the meaning and nuances of the original {{sourceLang}} text while adhering to {{targetLang}} grammar, vocabulary, and cultural sensitivities.
Produce only the {{targetLang}} translation, without any additional explanations or commentary. Please translate the following {{sourceLang}} text into {{targetLang}}:


{{texts}}`
    },
    simple: {
        system: `You are a translator. Translate from {{sourceLang}} to {{targetLanguage}}. The numbered texts are one continuous passage. Output JSON only:
{"translations": [{"id": N, "text": "translation"}]}`,
        user: `Translate to {{targetLanguage}}:\n{{texts}}`
    },
    hunyuan: {
        system: '',
        user: `Translate the following segment into {{targetLanguage}}, without additional explanation.\n{{texts}}`
    }
};

// DEFAULT_DESCRIBE_PROMPT is provided by defaults.js (loaded via importScripts
// above), so the background worker and the options-page editor share one default.

// Cache for models to avoid repeated API calls during translation
let cachedModels = null;
let modelsCacheTime = 0;
const MODEL_CACHE_TTL = 60000; // 60 seconds

let cachedSettings = null;

// ============================================================================
// Settings Management
// ============================================================================

/** Load settings from storage, merging over the defaults, and cache the result. */
async function loadSettings() {
    try {
        const result = await browserAPI.storage.local.get('settings');
        cachedSettings = { ...DEFAULT_SETTINGS, ...result.settings };
        debugEnabled = !!cachedSettings.debug;
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
// Provider Detection & Model Listing
// ============================================================================

/**
 * Probe each provider's URL to detect whether it is running and whether it is
 * reachable but CORS-blocked (via a fallback no-cors fetch).
 * @param {string} ollamaUrl
 * @param {string} lmstudioUrl
 * @param {string} llamacppUrl
 * @returns {Promise<object>} availability/blocked flags per provider
 */
async function detectProviders(ollamaUrl, lmstudioUrl, llamacppUrl) {
    const results = { ollama: false, ollama_blocked: false, lmstudio: false, lmstudio_blocked: false, llamacpp: false, llamacpp_blocked: false };

    try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 2000);
        const response = await fetch(`${ollamaUrl}/api/tags`, {
            method: 'GET',
            signal: controller.signal
        });
        clearTimeout(timeout);
        results.ollama = response.ok;
    } catch (e) {
        // Normal fetch failed — could be server not running, or CORS blocking the response.
        // Try a no-cors fetch: it gives an opaque response (can't read status/body) but
        // will not throw if the server is reachable, only if it is truly unreachable.
        try {
            const controller2 = new AbortController();
            const timeout2 = setTimeout(() => controller2.abort(), 2000);
            await fetch(`${ollamaUrl}/api/tags`, {
                method: 'GET',
                mode: 'no-cors',
                signal: controller2.signal
            });
            clearTimeout(timeout2);
            results.ollama_blocked = true;
        } catch (_) {
            results.ollama = false;
        }
    }

    try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 2000);
        const response = await fetch(`${lmstudioUrl}/v1/models`, {
            method: 'GET',
            signal: controller.signal
        });
        clearTimeout(timeout);
        results.lmstudio = response.ok;
    } catch (e) {
        // Try a no-cors fetch to see if server is running but CORS is blocking the response
        try {
            const controller2 = new AbortController();
            const timeout2 = setTimeout(() => controller2.abort(), 2000);
            await fetch(`${lmstudioUrl}/v1/models`, {
                method: 'GET',
                mode: 'no-cors',
                signal: controller2.signal
            });
            clearTimeout(timeout2);
            results.lmstudio_blocked = true;
        } catch (_) {
            results.lmstudio = false;
        }
    }

    try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 2000);
        const response = await fetch(`${llamacppUrl}/v1/models`, {
            method: 'GET',
            signal: controller.signal
        });
        clearTimeout(timeout);
        results.llamacpp = response.ok;
    } catch (e) {
        // Try a no-cors fetch to see if server is running but CORS is blocking the response
        try {
            const controller2 = new AbortController();
            const timeout2 = setTimeout(() => controller2.abort(), 2000);
            await fetch(`${llamacppUrl}/v1/models`, {
                method: 'GET',
                mode: 'no-cors',
                signal: controller2.signal
            });
            clearTimeout(timeout2);
            results.llamacpp_blocked = true;
        } catch (_) {
            results.llamacpp = false;
        }
    }

    return results;
}

/** Fetch the list of available models from an Ollama server. */
async function listOllamaModels(url) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 5000);
    try {
        const response = await fetch(`${url}/api/tags`, { signal: controller.signal });
        clearTimeout(timeoutId);
        if (!response.ok) throw new Error('Failed to fetch Ollama models');
        const data = await response.json();
        return (data.models || []).map(m => ({ id: m.name, name: m.name, provider: 'ollama' }));
    } catch (e) {
        clearTimeout(timeoutId);
        if (e.name === 'AbortError') throw new Error('Ollama model listing timed out');
        throw e;
    }
}

/** Fetch the list of available models from an LM Studio server. */
async function listLMStudioModels(url) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 5000);
    try {
        const response = await fetch(`${url}/v1/models`, { signal: controller.signal });
        clearTimeout(timeoutId);
        if (!response.ok) throw new Error('Failed to fetch LMStudio models');
        const data = await response.json();
        return (data.data || []).map(m => ({ id: m.id, name: m.id, provider: 'lmstudio' }));
    } catch (e) {
        clearTimeout(timeoutId);
        if (e.name === 'AbortError') throw new Error('LMStudio model listing timed out');
        throw e;
    }
}

/** Fetch the list of available models from a llama.cpp server. */
async function listLlamaCppModels(url) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 5000);
    try {
        const response = await fetch(`${url}/v1/models`, { signal: controller.signal });
        clearTimeout(timeoutId);
        if (!response.ok) throw new Error('Failed to fetch llama.cpp models');
        const data = await response.json();
        return (data.data || []).map(m => ({ id: m.id, name: m.id, provider: 'llamacpp' }));
    } catch (e) {
        clearTimeout(timeoutId);
        if (e.name === 'AbortError') throw new Error('llama.cpp model listing timed out');
        throw e;
    }
}

/**
 * List models across configured providers (or just the selected one), using a
 * short-lived in-memory cache unless bypassed.
 * @param {object} settings
 * @param {boolean} [useCache] whether to serve/refresh the models cache
 * @returns {Promise<Array<object>>}
 */
async function listModels(settings, useCache = true) {
    // Return cached models if available and not expired
    if (useCache && cachedModels && (Date.now() - modelsCacheTime < MODEL_CACHE_TTL)) {
        return cachedModels;
    }

    const models = [];
    const provider = settings.provider;

    if (provider === 'lmstudio' || provider === 'auto') {
        try {
            const lmstudioModels = await listLMStudioModels(settings.lmstudioUrl);
            models.push(...lmstudioModels);
        } catch (e) {
            if (provider === 'lmstudio') throw e;
        }
    }

    if (provider === 'ollama' || provider === 'auto') {
        try {
            const ollamaModels = await listOllamaModels(settings.ollamaUrl);
            models.push(...ollamaModels);
        } catch (e) {
            if (provider === 'ollama') throw e;
        }
    }

    if (provider === 'llamacpp' || provider === 'auto') {
        try {
            const llamacppModels = await listLlamaCppModels(settings.llamacppUrl);
            models.push(...llamacppModels);
        } catch (e) {
            if (provider === 'llamacpp') throw e;
        }
    }

    // Update cache
    cachedModels = models;
    modelsCacheTime = Date.now();

    return models;
}

// ============================================================================
// Translation Logic
// ============================================================================

// formatTextsForPrompt, buildPrompt, cleanTranslationText, isSuspiciousTranslation,
// extractJsonObject and parseTranslationResponse now live in translation-core.js
// (loaded via importScripts / manifest background.scripts) so they can be shared
// with the content script and unit-tested under Node. They remain available here
// as globals.

/**
 * If no model is configured yet, auto-select and save a preferred available
 * model (favoring a translation-specialized one) from the detected providers.
 * @returns {Promise<object|null>} the selected model, or null if none was chosen
 */
async function autoDetectAndSelectModel() {
    try {
        const settings = await getSettings();
        if (settings.selectedModel) return null; // already configured

        const models = await listModels(settings, false); // force fresh fetch
        if (models.length === 0) return null;

        // Prefer a translation-specialized model if one is loaded, else first available.
        // The request format is derived from the model automatically (requestFormat: 'auto'),
        // so we only need to pick the model and provider here.
        const preferred = models.find(m => detectRequestFormat(m.id) !== 'default') || models[0];

        await saveSettings({
            selectedModel: preferred.id,
            provider: preferred.provider
        });
        console.log(`[Background] Auto-selected model: ${preferred.id} (${preferred.provider})`);
        return preferred;
    } catch (e) {
        console.warn('[Background] Auto model detection failed:', e.message);
        return null;
    }
}

/** Resolve which provider hosts the given model id, using the cached model list. */
async function detectModelProvider(modelId, settings) {
    // Use cached models to avoid extra API calls
    const models = await listModels(settings, true);
    const model = models.find(m => m.id === modelId);
    return model ? model.provider : null;
}

// PLAIN_TEXT_FORMATS comes from languages.js (shared with the UIs).

/** Call Ollama's /api/generate (non-streaming) and return the raw response text. */
async function callOllama(settings, modelId, systemPrompt, userPrompt, jsonOutput) {
    const body = {
        model: modelId,
        stream: false
    };

    // Request a schema-constrained JSON object when the caller wants structure.
    // Passing the full schema (not just 'json') makes Ollama enforce the shape,
    // not just valid-JSON-ness.
    if (jsonOutput) {
        body.format = TRANSLATION_JSON_SCHEMA;
    }

    body.prompt = systemPrompt ? `${systemPrompt}\n\n${userPrompt}` : userPrompt;
    body.keep_alive = '30m';
    body.options = {};
    if (settings.temperature !== undefined) body.options.temperature = settings.temperature;
    if (settings.numCtx) body.options.num_ctx = settings.numCtx;

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 300000);
    let response;
    try {
        response = await fetch(`${settings.ollamaUrl}/api/generate`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
            signal: controller.signal
        });
    } catch (e) {
        clearTimeout(timeoutId);
        if (e.name === 'AbortError') throw new Error('Ollama request timed out after 5 minutes');
        throw e;
    }
    clearTimeout(timeoutId);

    if (!response.ok) {
        if (response.status === 403) {
            throw new Error('Ollama returned 403 Forbidden. The extension is being blocked by Ollama\'s CORS policy. You need to enable CORS in Ollama.');
        }
        const error = await response.text();
        throw new Error(`Ollama error (${response.status}): ${error || '(empty response)'}`);
    }

    const data = await response.json();
    debugLog(`[Background] callOllama: response length=${data.response?.length || 0}`);
    return data.response;
}



// JSON schema for the batched translation response. The inner shape is shared:
// Ollama wants the bare schema in `format`, LMStudio/OpenAI want it wrapped.
const TRANSLATION_JSON_SCHEMA = {
    "type": "object",
    "properties": {
        "translations": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "id": { "type": "integer" },
                    "text": { "type": "string" }
                },
                "required": ["id", "text"],
                "additionalProperties": false
            }
        }
    },
    "required": ["translations"],
    "additionalProperties": false
};
/** Call LM Studio's /v1/chat/completions (non-streaming) and return the raw response text. */
async function callLMStudio(settings, modelId, systemPrompt, userPrompt, jsonOutput) {
    const messages = [];

    if (systemPrompt) {
        messages.push({ role: 'system', content: systemPrompt });
    }
    messages.push({ role: 'user', content: userPrompt });

    const body = {
        model: modelId,
        messages,
        temperature: settings.temperature || 0.3,
        stream: false
    };

    if (jsonOutput) {
        body.response_format = {
            "type": "json_schema",
            "json_schema": {
                "name": "translation_response",
                "strict": true,
                "schema": TRANSLATION_JSON_SCHEMA
            }
        };
    }

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 300000);
    let response;
    try {
        response = await fetch(`${settings.lmstudioUrl}/v1/chat/completions`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
            signal: controller.signal
        });
    } catch (e) {
        clearTimeout(timeoutId);
        if (e.name === 'AbortError') throw new Error('LMStudio request timed out after 5 minutes');
        if (e instanceof TypeError) {
            throw new Error('Failed to connect to LMStudio. The extension is being blocked by LMStudio\'s CORS policy or the server is offline. You need to enable CORS in LMStudio.');
        }
        throw e;
    }
    clearTimeout(timeoutId);

    if (!response.ok) {
        const error = await response.text();
        throw new Error(`LMStudio error: ${error}`);
    }

    const data = await response.json();
    let content = data.choices[0]?.message?.content || '';

    // Clean up markdown code blocks if present
    content = content.replace(/^```json\s*/, '').replace(/^```\s*/, '').replace(/\s*```$/, '');

    return content;
}

/** Call llama.cpp's /v1/chat/completions (non-streaming) and return the raw response text. */
async function callLlamaCpp(settings, modelId, systemPrompt, userPrompt, jsonOutput) {
    const messages = [];

    if (systemPrompt) {
        messages.push({ role: 'system', content: systemPrompt });
    }
    messages.push({ role: 'user', content: userPrompt });

    const body = {
        model: modelId,
        messages,
        temperature: settings.temperature || 0.3,
        stream: false
    };

    if (jsonOutput) {
        body.response_format = {
            "type": "json_schema",
            "json_schema": {
                "name": "translation_response",
                "strict": true,
                "schema": TRANSLATION_JSON_SCHEMA
            }
        };
    }

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 300000);
    let response;
    try {
        response = await fetch(`${settings.llamacppUrl}/v1/chat/completions`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
            signal: controller.signal
        });
    } catch (e) {
        clearTimeout(timeoutId);
        if (e.name === 'AbortError') throw new Error('llama.cpp request timed out after 5 minutes');
        if (e instanceof TypeError) {
            throw new Error('Failed to connect to llama.cpp server. The extension is being blocked by CORS or the server is offline. You need to start llama-server with CORS enabled.');
        }
        throw e;
    }
    clearTimeout(timeoutId);

    if (!response.ok) {
        const error = await response.text();
        throw new Error(`llama.cpp error: ${error}`);
    }

    const data = await response.json();
    let content = data.choices[0]?.message?.content || '';

    // Clean up markdown code blocks if present
    content = content.replace(/^```json\s*/, '').replace(/^```\s*/, '').replace(/\s*```$/, '');

    return content;
}

/** Low-level call to whichever provider, returning the raw text response. */
async function callProvider(provider, settings, modelId, systemPrompt, userPrompt, jsonOutput) {
    if (provider === 'ollama') {
        return callOllama(settings, modelId, systemPrompt, userPrompt, jsonOutput);
    }
    if (provider === 'llamacpp') {
        return callLlamaCpp(settings, modelId, systemPrompt, userPrompt, jsonOutput);
    }
    return callLMStudio(settings, modelId, systemPrompt, userPrompt, jsonOutput);
}

// ============================================================================
// Streaming provider calls (issue #20)
// ============================================================================
// Plain-text streaming siblings of the calls above. Each reads the response
// body incrementally and invokes onDelta(token) as tokens arrive, buffering
// across network reads so a token split over a chunk boundary is reassembled
// before a line/event is parsed. They return the full accumulated text.

/**
 * Stream from Ollama's /api/generate (newline-delimited JSON, each object
 * carrying an incremental `response`, terminated by `{ "done": true }`).
 * @param {object} settings
 * @param {string} modelId
 * @param {string} systemPrompt
 * @param {string} userPrompt
 * @param {(token:string)=>void} onDelta
 * @returns {Promise<string>} the full response text
 */
async function callOllamaStream(settings, modelId, systemPrompt, userPrompt, onDelta) {
    const body = {
        model: modelId,
        prompt: systemPrompt ? `${systemPrompt}\n\n${userPrompt}` : userPrompt,
        stream: true,
        keep_alive: '30m',
        options: {}
    };
    if (settings.temperature !== undefined) body.options.temperature = settings.temperature;
    if (settings.numCtx) body.options.num_ctx = settings.numCtx;

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 300000);
    let response;
    try {
        response = await fetch(`${settings.ollamaUrl}/api/generate`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
            signal: controller.signal
        });
    } catch (e) {
        clearTimeout(timeoutId);
        if (e.name === 'AbortError') throw new Error('Ollama request timed out after 5 minutes');
        if (e instanceof TypeError) throw new Error('Failed to connect to Ollama. The server is offline or blocking the extension via CORS.');
        throw e;
    }
    if (!response.ok) {
        clearTimeout(timeoutId);
        if (response.status === 403) throw new Error('Ollama returned 403 Forbidden. The extension is being blocked by Ollama\'s CORS policy. You need to enable CORS in Ollama.');
        const error = await response.text();
        throw new Error(`Ollama error (${response.status}): ${error || '(empty response)'}`);
    }

    let full = '';
    try {
        await readLines(response, (line) => {
            const trimmed = line.trim();
            if (!trimmed) return false;
            let obj;
            try { obj = JSON.parse(trimmed); } catch (e) { return false; }
            if (typeof obj.response === 'string' && obj.response) {
                full += obj.response;
                onDelta(obj.response);
            }
            return obj.done === true; // stop
        });
    } finally {
        clearTimeout(timeoutId);
    }
    return full;
}

/**
 * Stream from an OpenAI-compatible /v1/chat/completions endpoint (LM Studio,
 * llama.cpp) — Server-Sent Events: `data: {json}` lines carrying
 * choices[0].delta.content, terminated by `data: [DONE]`.
 * @param {string} baseUrl
 * @param {string} providerLabel
 * @param {object} settings
 * @param {string} modelId
 * @param {string} systemPrompt
 * @param {string} userPrompt
 * @param {(token:string)=>void} onDelta
 * @returns {Promise<string>} the full response text
 */
async function callOpenAIStream(baseUrl, providerLabel, settings, modelId, systemPrompt, userPrompt, onDelta) {
    const messages = [];
    if (systemPrompt) messages.push({ role: 'system', content: systemPrompt });
    messages.push({ role: 'user', content: userPrompt });

    const body = {
        model: modelId,
        messages,
        temperature: settings.temperature || 0.3,
        stream: true
    };

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 300000);
    let response;
    try {
        response = await fetch(`${baseUrl}/v1/chat/completions`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
            signal: controller.signal
        });
    } catch (e) {
        clearTimeout(timeoutId);
        if (e.name === 'AbortError') throw new Error(`${providerLabel} request timed out after 5 minutes`);
        if (e instanceof TypeError) throw new Error(`Failed to connect to ${providerLabel}. The server is offline or blocking the extension via CORS.`);
        throw e;
    }
    if (!response.ok) {
        clearTimeout(timeoutId);
        const error = await response.text();
        throw new Error(`${providerLabel} error: ${error}`);
    }

    let full = '';
    try {
        await readLines(response, (line) => {
            const trimmed = line.trim();
            if (!trimmed.startsWith('data:')) return false;
            const payload = trimmed.slice(5).trim();
            if (payload === '[DONE]') return true; // stop
            let obj;
            try { obj = JSON.parse(payload); } catch (e) { return false; }
            const delta = obj.choices?.[0]?.delta?.content;
            if (typeof delta === 'string' && delta) {
                full += delta;
                onDelta(delta);
            }
            return false;
        });
    } finally {
        clearTimeout(timeoutId);
    }
    return full;
}

/**
 * Read a fetch Response body as text and invoke onLine for each complete,
 * newline-terminated line, buffering the trailing partial across reads. onLine
 * returns true to stop early (terminator seen).
 * @param {Response} response
 * @param {(line:string)=>boolean} onLine
 * @returns {Promise<void>}
 */
async function readLines(response, onLine) {
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let nl;
        while ((nl = buffer.indexOf('\n')) !== -1) {
            const line = buffer.slice(0, nl);
            buffer = buffer.slice(nl + 1);
            if (onLine(line)) { try { await reader.cancel(); } catch (e) { /* ignore */ } return; }
        }
    }
    // Flush any trailing content that never got a newline.
    if (buffer && onLine(buffer)) { try { await reader.cancel(); } catch (e) { /* ignore */ } }
}

/**
 * Dispatch a streaming call to the resolved provider.
 * @param {string} provider
 * @param {object} settings
 * @param {string} modelId
 * @param {string} systemPrompt
 * @param {string} userPrompt
 * @param {(token:string)=>void} onDelta
 * @returns {Promise<string>}
 */
async function callProviderStream(provider, settings, modelId, systemPrompt, userPrompt, onDelta) {
    if (provider === 'ollama') {
        return callOllamaStream(settings, modelId, systemPrompt, userPrompt, onDelta);
    }
    if (provider === 'llamacpp') {
        return callOpenAIStream(settings.llamacppUrl, 'llama.cpp', settings, modelId, systemPrompt, userPrompt, onDelta);
    }
    return callOpenAIStream(settings.lmstudioUrl, 'LMStudio', settings, modelId, systemPrompt, userPrompt, onDelta);
}

// ============================================================================
// Image describe & interpret
// ============================================================================

/**
 * Vision call for OpenAI-compatible providers (LM Studio, llama.cpp). Sends the
 * image as a data: URL using the OpenAI multimodal `image_url` content shape and
 * returns the raw text response. Ollama uses a different shape (see follow-up).
 */
async function callOpenAIVision(baseUrl, providerLabel, settings, modelId, prompt, imageDataUrl) {
    const body = {
        model: modelId,
        messages: [{
            role: 'user',
            content: [
                { type: 'text', text: prompt },
                { type: 'image_url', image_url: { url: imageDataUrl } }
            ]
        }],
        temperature: settings.temperature || 0.3,
        stream: false
    };

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 300000);
    let response;
    try {
        response = await fetch(`${baseUrl}/v1/chat/completions`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
            signal: controller.signal
        });
    } catch (e) {
        clearTimeout(timeoutId);
        if (e.name === 'AbortError') throw new Error(`${providerLabel} request timed out after 5 minutes`);
        if (e instanceof TypeError) throw new Error(`Failed to connect to ${providerLabel}. The server is offline or blocking the extension via CORS.`);
        throw e;
    }
    clearTimeout(timeoutId);

    if (!response.ok) {
        const error = await response.text();
        throw new Error(`${providerLabel} error: ${error}`);
    }

    const data = await response.json();
    return data.choices?.[0]?.message?.content || '';
}

/**
 * Vision call for Ollama. Ollama's multimodal API does not use the OpenAI
 * `image_url` shape — the base64 image (no `data:` prefix) goes in the native
 * `images` array on /api/generate. Mirrors callOllama's error handling.
 */
async function callOllamaVision(settings, modelId, prompt, imageBase64) {
    const body = {
        model: modelId,
        prompt,
        images: [imageBase64],
        stream: false,
        keep_alive: '30m',
        options: {}
    };
    if (settings.temperature !== undefined) body.options.temperature = settings.temperature;

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 300000);
    let response;
    try {
        response = await fetch(`${settings.ollamaUrl}/api/generate`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
            signal: controller.signal
        });
    } catch (e) {
        clearTimeout(timeoutId);
        if (e.name === 'AbortError') throw new Error('Ollama request timed out after 5 minutes');
        if (e instanceof TypeError) throw new Error('Failed to connect to Ollama. The server is offline or blocking the extension via CORS.');
        throw e;
    }
    clearTimeout(timeoutId);

    if (!response.ok) {
        if (response.status === 403) {
            throw new Error('Ollama returned 403 Forbidden. The extension is being blocked by Ollama\'s CORS policy. You need to enable CORS in Ollama.');
        }
        const error = await response.text();
        throw new Error(`Ollama error (${response.status}): ${error || '(empty response)'}`);
    }

    const data = await response.json();
    return data.response || '';
}

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
 * `data:` image URLs are returned as-is (fast path, avoids re-encoding large inline
 * images). Everything else — http(s) URLs and non-base64 data URLs (e.g. URL-encoded
 * SVG) — goes through fetch + blobToDataUrl, which re-encodes to canonical
 * `data:<type>;base64,...` while preserving the same image bytes. For http(s) URLs
 * the service worker needs host access; the on-demand <all_urls> request happens up
 * front in the context-menu click handler (a user gesture), so a failure here means
 * it was denied or the site blocked the image. Always returns a base64 image data
 * URL or throws — callers can rely on the payload being the full image bytes.
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

/**
 * Orchestrate describe & interpret for one image: resolve the vision model and
 * provider (same selection/auto-detect as translation), fetch+encode the image,
 * build the prompt in the user's target language, and return the model's text.
 */
async function describeImage(srcUrl) {
    const settings = await getSettings();

    const modelId = settings.visionModel || settings.selectedModel;
    if (!modelId) throw new Error('No vision model configured. Choose one in the extension options.');

    let provider = settings.provider;
    if (provider === 'auto') {
        provider = await detectModelProvider(modelId, settings);
        if (!provider) throw new Error('Could not determine the provider for the vision model.');
    }
    const imageDataUrl = await fetchImageAsDataUrl(srcUrl);
    // Raw base64 (no `data:` prefix): sent as-is to Ollama, and hashed for the
    // cache key so the key tracks the image *bytes*, not its srcUrl.
    const imageBase64 = imageDataUrl.replace(/^data:[^;]*;base64,/, '');
    if (!imageBase64) throw new Error('No image data to send to the model.');

    const targetLanguage = settings.targetLanguage || 'en';
    const targetLangName = getLanguageName(targetLanguage);
    const promptTemplate = settings.describePrompt || DEFAULT_DESCRIBE_PROMPT;
    const prompt = promptTemplate.replace(/{{targetLanguage}}/g, targetLangName);

    // Serve a cached description when the same image was already analyzed with the
    // same model, target language, and prompt. Honors the user's cacheMode (off =
    // no caching, same as translation). cacheKey/cache* come from cache.js, unchanged.
    // The resolved prompt is folded into the format token so editing describePrompt
    // (or the default changing) doesn't serve a stale description from the old prompt.
    const cacheEnabled = settings.cacheMode !== 'off'
        && typeof cacheGetMany === 'function' && typeof cacheKey === 'function';
    const describeKey = cacheEnabled
        ? cacheKey(modelId, '', targetLanguage, `describe:${hashString(prompt)}`, hashString(imageBase64))
        : null;
    if (cacheEnabled) {
        try {
            const found = await cacheGetMany([describeKey]);
            const hit = found.get(describeKey);
            if (hit !== undefined) return hit;
        } catch (e) {
            debugWarn('[Background] describe cache read failed:', e && e.message);
        }
    }

    let text;
    if (provider === 'ollama') {
        text = await callOllamaVision(settings, modelId, prompt, imageBase64);
    } else {
        const baseUrl = provider === 'llamacpp' ? settings.llamacppUrl : settings.lmstudioUrl;
        const label = provider === 'llamacpp' ? 'llama.cpp' : 'LM Studio';
        text = await callOpenAIVision(baseUrl, label, settings, modelId, prompt, imageDataUrl);
    }
    if (!text || !text.trim()) throw new Error('The model returned an empty response.');
    const result = text.trim();

    // Awaited so an MV3 service worker isn't torn down before the write commits.
    if (cacheEnabled) {
        try { await cacheSetMany([[describeKey, result]]); }
        catch (e) { debugWarn('[Background] describe cache write failed:', e && e.message); }
    }
    return result;
}

/**
 * Ensure content.js is present in a tab before messaging it. PING first (cheap,
 * handled by the content script); inject only if that fails, matching the
 * inject-then-retry pattern used by the translation context-menu handlers.
 */
async function ensureContentScript(tabId) {
    try {
        await browserAPI.tabs.sendMessage(tabId, { type: 'PING' });
    } catch (e) {
        await browserAPI.scripting.executeScript({ target: { tabId }, files: ['translation-core.js', 'content.js'] });
        await new Promise(resolve => setTimeout(resolve, 200));
    }
}

/**
 * Translate a single text as plain text (no JSON), used as the last-resort
 * fallback when structured output keeps failing. The whole response IS the
 * translation — nothing to parse, nothing to break the page.
 */
async function translatePlainItem(provider, settings, modelId, text, vars) {
    const systemPrompt = `You are a professional translator. Translate the user's text into ${vars.targetLang}. Output ONLY the translation, with no quotes, labels, JSON, or commentary.`;
    const userPrompt = text;
    const raw = await callProvider(provider, settings, modelId, systemPrompt, userPrompt, false);
    return cleanTranslationText((raw || '').trim());
}

/**
 * Small fast non-cryptographic string hash (cyrb53). Folds the prompt shape
 * (templates + sampling params) into a compact token for the cache key without
 * bloating it with the full template text.
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
 * Translate a batch of text items to the target language: resolves the
 * provider/model/prompt template, sends the (batched) requests, retries
 * failed/suspicious results, and returns the translated texts.
 * @param {Array<object>} textItems items with an id and text to translate
 * @param {string} targetLanguage target language code
 * @param {object} settings
 * @returns {Promise<*>}
 */
async function translate(textItems, targetLanguage, settings) {
    const modelId = settings.selectedModel;
    if (!modelId) throw new Error('No model selected');

    // Detect provider if auto
    let provider = settings.provider;
    if (provider === 'auto') {
        provider = await detectModelProvider(modelId, settings);
        if (!provider) throw new Error('Could not detect model provider');
    }

    // Resolve the effective request format ('auto' -> derived from the model).
    const format = resolveRequestFormat(settings, modelId);
    const isPlainText = PLAIN_TEXT_FORMATS.has(format);
    const template = PROMPT_TEMPLATES[format] || PROMPT_TEMPLATES.default;

    // Use custom prompts if advanced mode is enabled
    let systemTemplate = template.system;
    let userTemplate = template.user;
    if (settings.useAdvanced) {
        if (settings.customSystemPrompt) systemTemplate = settings.customSystemPrompt;
        if (settings.customUserPromptTemplate) userTemplate = settings.customUserPromptTemplate;
    }

    // Template variables shared across attempts. The content script resolves the
    // source language (script detection + page metadata) and passes it as
    // settings.sourceLanguage, so a Japanese page arrives here as 'ja', not 'en'.
    const targetLangName = getLanguageName(targetLanguage);
    const explicitSource = (settings.sourceLanguage && settings.sourceLanguage !== 'auto')
        ? (normalizeLangCode(settings.sourceLanguage) || settings.sourceLanguage)
        : '';
    // Plain-text formats (e.g. TranslateGemma) require a concrete source code;
    // fall back to English only as a last resort when nothing was resolved.
    const sourceLangCode = explicitSource || 'en';
    // Structured prompts name the source in prose; stay neutral when unknown so
    // we don't assert "English" for an undetected page.
    const sourceLangName = explicitSource ? getLanguageName(explicitSource) : 'the source language';
    const baseVars = {
        targetLanguage: targetLangName,
        sourceLang: sourceLangName,
        sourceCode: sourceLangCode.toUpperCase(),
        targetLang: targetLangName,
        targetCode: targetLanguage.toUpperCase()
    };

    // Whether to request schema-constrained JSON for this (structured) format.
    const wantJson = !!settings.useStructuredOutput && !isPlainText;

    // Run one batched request for the given subset of items, returning a Map of
    // id -> good translation text (suspicious/empty results are dropped).
    const requestBatch = async (items) => {
        // Map items to 0-indexed sequential IDs for the prompt to avoid confusing the LLM
        const mappedItems = items.map((item, index) => ({ id: index, text: item.text, originalId: item.id }));
        
        const vars = { ...baseVars, texts: formatTextsForPrompt(mappedItems) };
        const userPrompt = buildPrompt(userTemplate, vars);
        const systemPrompt = buildPrompt(systemTemplate, vars);
        const raw = await callProvider(provider, settings, modelId, systemPrompt, userPrompt, wantJson);
        debugLog(`[Background] Raw LLM response (first 300 chars):`, (raw || '').substring(0, 300));
        
        // Parse using the mapped items so it expects 0, 1, 2...
        const parsed = parseTranslationResponse(raw, mappedItems);
        const good = new Map();
        for (const t of parsed) {
            if (t && t.text && !t.error && !isSuspiciousTranslation(t.text)) {
                // Find the original item to get its real ID
                const originalItem = mappedItems.find(m => m.id === t.id);
                if (originalItem) {
                    good.set(originalItem.originalId, t.text);
                }
            }
        }
        return good;
    };

    const results = new Map();          // originalId -> final translated text

    // ---- Cache + de-duplication --------------------------------------------
    // Group items by a key capturing everything that determines the model output
    // (model, languages, prompt shape/params) plus the source text, so each unique
    // string is translated once and identical strings reuse the result across
    // batches, pages, and sessions. promptSig folds in the resolved prompt
    // templates + structured-output mode + temperature so changing any of them
    // doesn't serve stale output. When the cache is off/unavailable we key by raw
    // text, which still de-dups within the request. cacheKey/cache* come from cache.js.
    const cacheEnabled = settings.cacheMode !== 'off'
        && typeof cacheGetMany === 'function' && typeof cacheKey === 'function';
    const promptSig = hashString([
        format, wantJson ? 'json' : 'plain', String(settings.temperature),
        systemTemplate, userTemplate
    ].join('\u0000'));
    const keyFor = cacheEnabled
        ? (text) => cacheKey(modelId, sourceLangCode, targetLanguage, promptSig, text)
        : (text) => text;

    // key -> { key, item: representative, ids: [every originalId sharing this text] }
    const groups = new Map();
    for (const item of textItems) {
        const k = keyFor(item.text);
        const g = groups.get(k);
        if (g) g.ids.push(item.id);
        else groups.set(k, { key: k, item, ids: [item.id] });
    }

    // Serve cache hits up front; only unresolved groups go to the model.
    let cacheHitCount = 0;      // unique source strings served from cache
    let fromCacheItems = 0;     // text elements served from cache (incl. duplicates)
    let missGroups;
    if (cacheEnabled) {
        try {
            const found = await cacheGetMany([...groups.keys()]);
            missGroups = [];
            for (const g of groups.values()) {
                const cached = found.get(g.key);
                if (cached !== undefined) {
                    results.set(g.item.id, cached);
                    cacheHitCount++;
                    fromCacheItems += g.ids.length;
                } else {
                    missGroups.push(g);
                }
            }
        } catch (e) {
            debugWarn('[Background] cache read failed, translating all:', e && e.message);
            missGroups = [...groups.values()];
        }
    } else {
        missGroups = [...groups.values()];
    }
    debugLog(`[Background] cache: ${cacheHitCount} hit / ${missGroups.length} miss (${groups.size} unique of ${textItems.length} total)`);

    let pending = missGroups.map(g => g.item);   // representative item per unresolved group

    // Attempt the batched request, retrying only the items that came back
    // missing or malformed. maxOutputRetries extra attempts after the first.
    const maxRetries = Number.isInteger(settings.maxOutputRetries) ? settings.maxOutputRetries : 2;
    debugLog(`[Background] translate: provider=${provider} model=${modelId} format=${format} items=${textItems.length} json=${wantJson}`);
    for (let attempt = 0; attempt <= maxRetries && pending.length > 0; attempt++) {
        let good;
        try {
            good = await requestBatch(pending);
        } catch (e) {
            if (attempt === maxRetries) throw e; // bubble transport errors on last try
            debugWarn(`[Background] batch attempt ${attempt + 1} threw:`, e.message);
            continue;
        }
        for (const item of pending) {
            const text = good.get(item.id);
            if (text !== undefined) results.set(item.id, text);
        }
        pending = pending.filter(item => !results.has(item.id));
        if (pending.length) {
            debugWarn(`[Background] ${pending.length} item(s) malformed/missing after attempt ${attempt + 1}`);
        }
    }

    // Plain-text fallback: translate the still-failing items one-by-one with no
    // structure to parse. Only for JSON-style formats (plain formats already are).
    if (pending.length > 0 && !isPlainText && settings.plainTextFallback !== false) {
        debugWarn(`[Background] Falling back to plain-text translation for ${pending.length} item(s)`);
        for (const item of pending) {
            try {
                const text = await translatePlainItem(provider, settings, modelId, item.text, baseVars);
                if (text && !isSuspiciousTranslation(text)) results.set(item.id, text);
            } catch (e) {
                debugWarn(`[Background] plain-text fallback failed for id ${item.id}:`, e.message);
            }
        }
    }

    // Persist freshly produced translations. Awaited so an MV3 service worker
    // isn't torn down before the IndexedDB write commits.
    if (cacheEnabled) {
        const entries = [];
        for (const g of missGroups) {
            if (results.has(g.item.id)) entries.push([g.key, results.get(g.item.id)]);
        }
        if (entries.length) {
            try { await cacheSetMany(entries); }
            catch (e) { debugWarn('[Background] cache write failed:', e && e.message); }
        }
    }

    // Fan each group's translation out to every member sharing its source text.
    for (const g of groups.values()) {
        if (!results.has(g.item.id)) continue;
        const text = results.get(g.item.id);
        for (const id of g.ids) results.set(id, text);
    }

    // Build the final array in original order. Items that never succeeded are
    // returned with an error so the content script keeps their original text.
    const translations = textItems.map(item => results.has(item.id)
        ? { id: item.id, text: results.get(item.id) }
        : { id: item.id, error: 'translation failed' });
    return { translations, fromCache: fromCacheItems, total: textItems.length, cacheActive: cacheEnabled };
}

/**
 * Streaming counterpart to translate(): one plain-text streaming request per
 * unique segment, emitting the growing translation to `emit(id, textSoFar)` so
 * the content script can type it into the page. Reuses the same provider/format
 * resolution, source-language handling, and group/dedup/cache machinery, and
 * returns the same summary shape. Cache hits emit immediately; misses stream,
 * are cleaned on completion, and are written to the cache.
 * @param {Array<{id:*, text:string}>} textItems
 * @param {string} targetLanguage
 * @param {object} settings
 * @param {(id:*, textSoFar:string)=>void} emit
 * @returns {Promise<{translations:Array, fromCache:number, total:number, cacheActive:boolean}>}
 */
async function translateStream(textItems, targetLanguage, settings, emit) {
    const modelId = settings.selectedModel;
    if (!modelId) throw new Error('No model selected');

    let provider = settings.provider;
    if (provider === 'auto') {
        provider = await detectModelProvider(modelId, settings);
        if (!provider) throw new Error('Could not detect model provider');
    }

    const format = resolveRequestFormat(settings, modelId);
    const isPlainText = PLAIN_TEXT_FORMATS.has(format);
    const template = PROMPT_TEMPLATES[format] || PROMPT_TEMPLATES.default;

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

    // Build the single-item plain-text prompt. Model-specific plain-text formats
    // (TranslateGemma, Hunyuan) keep their required template; everything else uses
    // a generic "output only the translation" prompt.
    const genericSystem = `You are a professional translator. Translate the user's text into ${targetLangName}. Output ONLY the translation, with no quotes, labels, JSON, or commentary.`;
    const buildStreamPrompt = (text) => {
        if (isPlainText) {
            const vars = { ...baseVars, texts: text };
            return {
                system: buildPrompt(template.system || '', vars),
                user: buildPrompt(template.user || '{{texts}}', vars)
            };
        }
        return { system: genericSystem, user: text };
    };

    // Cache/dedup — mirrors translate(), but the prompt signature marks the plain
    // streaming path so streamed and batched-JSON entries never collide.
    const cacheEnabled = settings.cacheMode !== 'off'
        && typeof cacheGetMany === 'function' && typeof cacheKey === 'function';
    const promptSig = hashString(['stream', format, String(settings.temperature), sourceLangCode].join(' '));
    const keyFor = cacheEnabled
        ? (text) => cacheKey(modelId, sourceLangCode, targetLanguage, promptSig, text)
        : (text) => text;

    const groups = new Map(); // key -> { key, item, ids: [] }
    for (const item of textItems) {
        const k = keyFor(item.text);
        const g = groups.get(k);
        if (g) g.ids.push(item.id);
        else groups.set(k, { key: k, item, ids: [item.id] });
    }

    const results = new Map();
    let fromCacheItems = 0;
    let missGroups;
    if (cacheEnabled) {
        try {
            const found = await cacheGetMany([...groups.keys()]);
            missGroups = [];
            for (const g of groups.values()) {
                const cached = found.get(g.key);
                if (cached !== undefined) {
                    for (const id of g.ids) { results.set(id, cached); emit(id, cached); }
                    fromCacheItems += g.ids.length;
                } else {
                    missGroups.push(g);
                }
            }
        } catch (e) {
            debugWarn('[Background] stream cache read failed:', e && e.message);
            missGroups = [...groups.values()];
        }
    } else {
        missGroups = [...groups.values()];
    }

    // Stream each unique miss sequentially (parallelism comes from the content
    // script running several batches at once).
    const cacheEntries = [];
    for (const g of missGroups) {
        const { system, user } = buildStreamPrompt(g.item.text);
        let acc = '';
        try {
            await callProviderStream(provider, settings, modelId, system, user, (delta) => {
                acc += delta;
                const live = cleanTranslationText(acc);
                for (const id of g.ids) emit(id, live);
            });
            const final = cleanTranslationText((acc || '').trim());
            if (final && !isSuspiciousTranslation(final)) {
                for (const id of g.ids) { results.set(id, final); emit(id, final); }
                if (cacheEnabled) cacheEntries.push([g.key, final]);
            }
        } catch (e) {
            debugWarn(`[Background] stream failed for a segment:`, e && e.message);
            // Leave the original text in place (no final emit).
        }
    }

    if (cacheEnabled && cacheEntries.length) {
        try { await cacheSetMany(cacheEntries); }
        catch (e) { debugWarn('[Background] stream cache write failed:', e && e.message); }
    }

    const translations = textItems.map(item => results.has(item.id)
        ? { id: item.id, text: results.get(item.id) }
        : { id: item.id, error: 'translation failed' });
    return { translations, fromCache: fromCacheItems, total: textItems.length, cacheActive: cacheEnabled };
}

// ============================================================================
// Message Handler
// ============================================================================

browserAPI.runtime.onMessage.addListener((message, sender, sendResponse) => {
    // console.log('[Background] Received message:', message.type);

    (async () => {
        try {
            const settings = await getSettings();

            switch (message.type) {
                case 'GET_SETTINGS':
                    sendResponse({ settings });
                    break;

                case 'SAVE_SETTINGS':
                    const saved = await saveSettings(message.settings);
                    sendResponse({ settings: saved });
                    break;

                case 'DETECT_PROVIDERS':
                    const providers = await detectProviders(
                        settings.ollamaUrl,
                        settings.lmstudioUrl,
                        settings.llamacppUrl
                    );
                    sendResponse(providers);
                    break;

                case 'LIST_MODELS':
                    // Pass forceRefresh to bypass cache when user clicks refresh
                    const models = await listModels(settings, !message.forceRefresh);
                    sendResponse({ models });
                    break;

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

                case 'TRANSLATE':
                    // Pass sourceLanguage for TranslateGemma support
                    let settingsWithSource = {
                        ...settings,
                        sourceLanguage: message.sourceLanguage || settings.sourceLanguage || 'en'
                    };

                    // WARNING LOG: Check if source language is missing or 'auto'
                    if (!settingsWithSource.sourceLanguage || settingsWithSource.sourceLanguage === 'auto') {
                        console.warn('[Background] WARNING: Source language is "auto" or missing. Some models (like TranslateGemma) require a specific source language code to function correctly.');
                    }

                    // Auto-detect model if none selected (e.g. fresh install, providers not ready at install time)
                    if (!settingsWithSource.selectedModel) {
                        await autoDetectAndSelectModel();
                        const refreshed = await getSettings();
                        settingsWithSource = {
                            ...settingsWithSource,
                            selectedModel: refreshed.selectedModel,
                            provider: refreshed.provider,
                            requestFormat: refreshed.requestFormat
                        };
                    }

                    // Stream when enabled and we can push deltas back to the
                    // originating tab; otherwise use the stable batched-JSON path.
                    const streamTabId = sender && sender.tab && sender.tab.id;
                    let result;
                    if (settingsWithSource.streamTranslations !== false && streamTabId !== undefined && streamTabId !== null) {
                        // Coalesce deltas so we don't flood the messaging channel:
                        // buffer id->latest-text and flush on a short timer.
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
                        result = await translateStream(
                            message.texts,
                            message.targetLanguage,
                            settingsWithSource,
                            emit
                        );
                        if (flushTimer) clearTimeout(flushTimer);
                        flush(); // push any remaining deltas before resolving
                    } else {
                        result = await translate(
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

                case 'DESCRIBE_IMAGE':
                    // Describe a local image supplied as a base64 data URL (from
                    // the translator page's drop/paste/file-pick). Reuses the same
                    // vision pipeline + cache as the right-click describe flow.
                    try {
                        const text = await describeImage(message.imageDataUrl);
                        sendResponse({ text });
                    } catch (e) {
                        sendResponse({ error: e && e.message });
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
// 'session' mode (keep until the browser closes). onStartup fires when the
// profile launches but not on extension reload/update, so within-session
// worker restarts don't lose the cache — only a real browser restart does.
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
    // registerContentScripts() registrations are cleared on extension update/reinstall.
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
            // Already registered (e.g. fresh install where registration survived)
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

            // Helper to send message
            const sendTranslationMessage = async () => {
                await browserAPI.tabs.sendMessage(tab.id, {
                    type: 'START_TRANSLATION',
                    targetLanguage: settings.targetLanguage,
                    sourceLanguage: sourceLang || 'auto', // Use detected or fall back to auto
                    showGlow: settings.showGlow,
                    maxConcurrentRequests: settings.maxConcurrentRequests || 4
                });
            };

            try {
                await sendTranslationMessage();
            } catch (e) {
                console.log('[Background] Initial translation connection failed, attempting injection:', e);

                // If message failed, content script might not be loaded. Inject it.
                await browserAPI.scripting.executeScript({
                    target: { tabId: tab.id },
                    files: ['translation-core.js', 'content.js']
                });

                // Wait briefly for script to initialize
                await new Promise(resolve => setTimeout(resolve, 200));

                // Retry message
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
        // would be gone after the async fetch. No-ops (returns immediately, no
        // prompt) if already granted; skipped for data: URLs which need no fetch.
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
    console.log('[Background] Local LLM Translator background script loaded');
});
