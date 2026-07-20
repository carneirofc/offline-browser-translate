/**
 * llama-server client: a thin, provider-agnostic client for an
 * OpenAI-compatible server (llama.cpp's `llama-server` / `/v1` endpoints).
 *
 * The extension talks to exactly one such server, but this module is written as
 * a *provider* with a fixed interface — `createLlamaServer({ serverUrl, fetch })`
 * returns an object implementing:
 *   { id, label, probeServer, listModels, chatCompletion, chatCompletionStream, describeVision }
 * `translate-pipeline.js` depends only on that shape, so a future provider is a
 * new module implementing the same interface, not a pipeline change.
 *
 * `fetch` is injectable so the whole client can be unit-tested under Node with a
 * mocked fetch. Like `translation-core.js`/`cache.js`, the same source loads in
 * the background service worker (a global) and under CommonJS (`require`).
 */
(function () {
    'use strict';

    const CHAT_TIMEOUT_MS = 300000; // 5 minutes for a generation request
    const PROBE_TIMEOUT_MS = 2000;
    const LIST_TIMEOUT_MS = 5000;

    /**
     * Create a llama-server provider bound to a base URL and a fetch implementation.
     * @param {{serverUrl?: string, fetch?: typeof fetch}} [opts]
     * @returns {TranslationProvider} provider implementing the standard interface
     */
    function createLlamaServer(opts) {
        const options = opts || {};
        const base = options.serverUrl || '';
        const label = 'llama-server';
        // Resolve fetch lazily so a caller can inject one; fall back to the global.
        const doFetch = options.fetch
            || ((typeof fetch !== 'undefined') ? fetch.bind(globalThis) : null);

        /** Map a fetch/abort error to a friendly, provider-labelled Error. */
        function mapConnError(e) {
            if (e && e.name === 'AbortError') {
                return new Error(`${label} request timed out after 5 minutes`);
            }
            if (e instanceof TypeError) {
                return new Error(`Failed to connect to ${label}. The server is offline or blocking the extension via CORS.`);
            }
            return e;
        }

        /**
         * Fetch with an abort timeout. Returns the Response (even for non-2xx);
         * throws a mapped Error on transport failure/timeout.
         */
        async function requestWithTimeout(url, init, timeoutMs) {
            const controller = new AbortController();
            const timer = setTimeout(() => controller.abort(), timeoutMs);
            try {
                return await doFetch(url, { ...init, signal: controller.signal });
            } catch (e) {
                throw mapConnError(e);
            } finally {
                clearTimeout(timer);
            }
        }

        /** POST a JSON chat-completions body and return the parsed Response. */
        function postChat(body, timeoutMs) {
            return requestWithTimeout(`${base}/v1/chat/completions`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body)
            }, timeoutMs);
        }

        /** Strip a leading/trailing markdown code fence some models wrap JSON in. */
        function stripCodeFence(content) {
            return (content || '')
                .replace(/^```json\s*/, '')
                .replace(/^```\s*/, '')
                .replace(/\s*```$/, '');
        }

        return {
            id: 'llama-server',
            label,

            /**
             * Detect whether the server is reachable, and whether it is running
             * but CORS-blocked (a no-cors fetch succeeds opaquely in that case).
             * @returns {Promise<{available: boolean, blocked: boolean}>}
             */
            async probeServer() {
                try {
                    const res = await requestWithTimeout(`${base}/v1/models`, { method: 'GET' }, PROBE_TIMEOUT_MS);
                    return { available: !!res.ok, blocked: false };
                } catch (e) {
                    // Reachable-but-blocked check: a no-cors fetch gives an opaque
                    // response (no status/body) but only throws if truly unreachable.
                    try {
                        await requestWithTimeout(`${base}/v1/models`, { method: 'GET', mode: 'no-cors' }, PROBE_TIMEOUT_MS);
                        return { available: false, blocked: true };
                    } catch (_) {
                        return { available: false, blocked: false };
                    }
                }
            },

            /**
             * List the models the server advertises on `/v1/models`.
             * @returns {Promise<Array<{id: string, name: string}>>}
             */
            async listModels() {
                const res = await requestWithTimeout(`${base}/v1/models`, { method: 'GET' }, LIST_TIMEOUT_MS);
                if (!res.ok) throw new Error(`${label} model listing failed (HTTP ${res.status})`);
                const data = await res.json();
                return (data.data || []).map(m => ({ id: m.id, name: m.id }));
            },

            /**
             * Non-streaming chat completion. When `jsonSchema` is given, request a
             * schema-constrained JSON object via `response_format`. Returns the raw
             * assistant text (code fences stripped).
             * @param {string} modelId
             * @param {string} systemPrompt
             * @param {string} userPrompt
             * @param {{jsonSchema?: object, schemaName?: string, temperature?: number}} [callOpts]
             * @returns {Promise<string>}
             */
            async chatCompletion(modelId, systemPrompt, userPrompt, callOpts) {
                const co = callOpts || {};
                const messages = [];
                if (systemPrompt) messages.push({ role: 'system', content: systemPrompt });
                messages.push({ role: 'user', content: userPrompt });

                const body = {
                    model: modelId,
                    messages,
                    temperature: co.temperature != null ? co.temperature : 0.3,
                    stream: false
                };
                if (co.jsonSchema) {
                    body.response_format = {
                        type: 'json_schema',
                        json_schema: {
                            name: co.schemaName || 'response',
                            strict: true,
                            schema: co.jsonSchema
                        }
                    };
                }

                const res = await postChat(body, CHAT_TIMEOUT_MS);
                if (!res.ok) {
                    const error = await res.text();
                    throw new Error(`${label} error: ${error}`);
                }
                const data = await res.json();
                return stripCodeFence(data.choices?.[0]?.message?.content || '');
            },

            /**
             * Streaming chat completion (SSE): invokes onDelta(token) as content
             * arrives and returns the full accumulated text.
             * @param {string} modelId
             * @param {string} systemPrompt
             * @param {string} userPrompt
             * @param {(token: string) => void} onDelta
             * @param {{temperature?: number}} [callOpts]
             * @returns {Promise<string>}
             */
            async chatCompletionStream(modelId, systemPrompt, userPrompt, onDelta, callOpts) {
                const co = callOpts || {};
                const messages = [];
                if (systemPrompt) messages.push({ role: 'system', content: systemPrompt });
                messages.push({ role: 'user', content: userPrompt });

                const body = {
                    model: modelId,
                    messages,
                    temperature: co.temperature != null ? co.temperature : 0.3,
                    stream: true
                };

                const res = await postChat(body, CHAT_TIMEOUT_MS);
                if (!res.ok) {
                    const error = await res.text();
                    throw new Error(`${label} error: ${error}`);
                }

                let full = '';
                await readLines(res, (line) => {
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
                return full;
            },

            /**
             * Vision call: send an image (as a `data:` URL) with a text prompt
             * using the OpenAI multimodal `image_url` content shape. Returns the
             * raw assistant text.
             * @param {string} modelId
             * @param {string} prompt
             * @param {string} imageDataUrl
             * @param {{temperature?: number}} [callOpts]
             * @returns {Promise<string>}
             */
            async describeVision(modelId, prompt, imageDataUrl, callOpts) {
                const co = callOpts || {};
                const body = {
                    model: modelId,
                    messages: [{
                        role: 'user',
                        content: [
                            { type: 'text', text: prompt },
                            { type: 'image_url', image_url: { url: imageDataUrl } }
                        ]
                    }],
                    temperature: co.temperature != null ? co.temperature : 0.3,
                    stream: false
                };

                const res = await postChat(body, CHAT_TIMEOUT_MS);
                if (!res.ok) {
                    const error = await res.text();
                    throw new Error(`${label} error: ${error}`);
                }
                const data = await res.json();
                return data.choices?.[0]?.message?.content || '';
            }
        };
    }

    /**
     * Read a fetch Response body as text and invoke onLine for each complete,
     * newline-terminated line, buffering the trailing partial across reads so a
     * token split over a chunk boundary is reassembled before a line is parsed.
     * onLine returns true to stop early (terminator seen).
     * @param {Response} response
     * @param {(line: string) => boolean} onLine
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

    const api = { createLlamaServer };

    const g = (typeof self !== 'undefined') ? self
        : (typeof globalThis !== 'undefined') ? globalThis : this;
    Object.assign(g, api);

    if (typeof module !== 'undefined' && module.exports) {
        module.exports = api;
    }
})();
