import { describe, test, expect } from 'vitest';
import llamaServer from '../llama-server.js';

const { createLlamaServer } = llamaServer;

const BASE = 'http://localhost:8080';

/** A fetch double that records calls and returns queued responses. */
function makeFetch(responder) {
    const calls = [];
    const fn = (url, init) => {
        calls.push({ url, init, body: init && init.body ? JSON.parse(init.body) : undefined });
        return responder(url, init, calls.length - 1);
    };
    fn.calls = calls;
    return fn;
}

/** Build a JSON Response double. */
function jsonResponse(obj, ok = true, status = 200) {
    return { ok, status, json: async () => obj, text: async () => JSON.stringify(obj) };
}

/** Build a streaming Response whose body yields the given string chunks. */
function streamResponse(chunks, ok = true) {
    const encoder = new TextEncoder();
    let i = 0;
    return {
        ok,
        status: ok ? 200 : 500,
        text: async () => 'error body',
        body: {
            getReader() {
                return {
                    read() {
                        if (i < chunks.length) {
                            return Promise.resolve({ done: false, value: encoder.encode(chunks[i++]) });
                        }
                        return Promise.resolve({ done: true, value: undefined });
                    },
                    cancel() { return Promise.resolve(); }
                };
            }
        }
    };
}

describe('listModels', () => {
    test('maps /v1/models data[] to {id, name} (no provider field)', async () => {
        const fetch = makeFetch(() => Promise.resolve(jsonResponse({ data: [{ id: 'm1' }, { id: 'm2' }] })));
        const p = createLlamaServer({ serverUrl: BASE, fetch });
        const models = await p.listModels();
        expect(models).toEqual([{ id: 'm1', name: 'm1' }, { id: 'm2', name: 'm2' }]);
        expect(fetch.calls[0].url).toBe(`${BASE}/v1/models`);
    });

    test('throws on a non-ok response', async () => {
        const fetch = makeFetch(() => Promise.resolve(jsonResponse({}, false, 500)));
        const p = createLlamaServer({ serverUrl: BASE, fetch });
        await expect(p.listModels()).rejects.toThrow(/failed/i);
    });
});

describe('probeServer', () => {
    test('reports available when the server responds ok', async () => {
        const fetch = makeFetch(() => Promise.resolve(jsonResponse({ data: [] })));
        const p = createLlamaServer({ serverUrl: BASE, fetch });
        expect(await p.probeServer()).toEqual({ available: true, blocked: false });
    });

    test('reports blocked when the plain fetch fails but a no-cors fetch succeeds', async () => {
        const fetch = makeFetch((url, init) => {
            if (init && init.mode === 'no-cors') return Promise.resolve({ ok: false, type: 'opaque' });
            return Promise.reject(new TypeError('Failed to fetch'));
        });
        const p = createLlamaServer({ serverUrl: BASE, fetch });
        expect(await p.probeServer()).toEqual({ available: false, blocked: true });
    });

    test('reports neither available nor blocked when both fetches fail', async () => {
        const fetch = makeFetch(() => Promise.reject(new TypeError('Failed to fetch')));
        const p = createLlamaServer({ serverUrl: BASE, fetch });
        expect(await p.probeServer()).toEqual({ available: false, blocked: false });
    });
});

describe('chatCompletion', () => {
    test('sends a plain chat body (no response_format) and returns the content', async () => {
        const fetch = makeFetch(() => Promise.resolve(jsonResponse({ choices: [{ message: { content: 'Hola' } }] })));
        const p = createLlamaServer({ serverUrl: BASE, fetch });
        const out = await p.chatCompletion('m1', 'sys', 'user', { temperature: 0.2 });
        expect(out).toBe('Hola');
        const body = fetch.calls[0].body;
        expect(fetch.calls[0].url).toBe(`${BASE}/v1/chat/completions`);
        expect(body.model).toBe('m1');
        expect(body.stream).toBe(false);
        expect(body.temperature).toBe(0.2);
        expect(body.messages).toEqual([
            { role: 'system', content: 'sys' },
            { role: 'user', content: 'user' }
        ]);
        expect(body.response_format).toBeUndefined();
    });

    test('wraps a json schema into response_format when given', async () => {
        const fetch = makeFetch(() => Promise.resolve(jsonResponse({ choices: [{ message: { content: '{}' } }] })));
        const p = createLlamaServer({ serverUrl: BASE, fetch });
        const schema = { type: 'object' };
        await p.chatCompletion('m1', '', 'u', { jsonSchema: schema, schemaName: 'translation_response' });
        const rf = fetch.calls[0].body.response_format;
        expect(rf.type).toBe('json_schema');
        expect(rf.json_schema.name).toBe('translation_response');
        expect(rf.json_schema.strict).toBe(true);
        expect(rf.json_schema.schema).toEqual(schema);
        // No system message when systemPrompt is empty.
        expect(fetch.calls[0].body.messages).toEqual([{ role: 'user', content: 'u' }]);
    });

    test('strips a markdown code fence around the content', async () => {
        const fetch = makeFetch(() => Promise.resolve(jsonResponse({ choices: [{ message: { content: '```json\n{"a":1}\n```' } }] })));
        const p = createLlamaServer({ serverUrl: BASE, fetch });
        expect(await p.chatCompletion('m', '', 'u', {})).toBe('{"a":1}');
    });

    test('throws a labelled error on a non-ok response', async () => {
        const fetch = makeFetch(() => Promise.resolve({ ok: false, status: 500, text: async () => 'boom' }));
        const p = createLlamaServer({ serverUrl: BASE, fetch });
        await expect(p.chatCompletion('m', '', 'u', {})).rejects.toThrow(/llama-server error: boom/);
    });

    test('maps a connection TypeError to a friendly message', async () => {
        const fetch = makeFetch(() => Promise.reject(new TypeError('Failed to fetch')));
        const p = createLlamaServer({ serverUrl: BASE, fetch });
        await expect(p.chatCompletion('m', '', 'u', {})).rejects.toThrow(/Failed to connect to llama-server/);
    });

    test('maps an AbortError to a timeout message', async () => {
        const fetch = makeFetch(() => {
            const e = new Error('aborted');
            e.name = 'AbortError';
            return Promise.reject(e);
        });
        const p = createLlamaServer({ serverUrl: BASE, fetch });
        await expect(p.chatCompletion('m', '', 'u', {})).rejects.toThrow(/timed out/);
    });
});

describe('chatCompletionStream', () => {
    test('parses SSE deltas, invokes onDelta, and returns the full text', async () => {
        const chunks = [
            'data: {"choices":[{"delta":{"content":"Hola"}}]}\n',
            'data: {"choices":[{"delta":{"content":" mundo"}}]}\n',
            'data: [DONE]\n'
        ];
        const fetch = makeFetch(() => Promise.resolve(streamResponse(chunks)));
        const p = createLlamaServer({ serverUrl: BASE, fetch });
        const deltas = [];
        const full = await p.chatCompletionStream('m', 'sys', 'u', (d) => deltas.push(d), {});
        expect(deltas).toEqual(['Hola', ' mundo']);
        expect(full).toBe('Hola mundo');
        expect(fetch.calls[0].body.stream).toBe(true);
    });

    test('reassembles a delta split across chunk boundaries', async () => {
        // The JSON for one SSE event is split mid-line across two reads.
        const chunks = [
            'data: {"choices":[{"delta":{"con',
            'tent":"Bonjour"}}]}\n',
            'data: [DONE]\n'
        ];
        const fetch = makeFetch(() => Promise.resolve(streamResponse(chunks)));
        const p = createLlamaServer({ serverUrl: BASE, fetch });
        const deltas = [];
        const full = await p.chatCompletionStream('m', '', 'u', (d) => deltas.push(d), {});
        expect(full).toBe('Bonjour');
        expect(deltas).toEqual(['Bonjour']);
    });
});

describe('describeVision', () => {
    test('sends the multimodal image_url content shape and returns the text', async () => {
        const fetch = makeFetch(() => Promise.resolve(jsonResponse({ choices: [{ message: { content: 'a cat' } }] })));
        const p = createLlamaServer({ serverUrl: BASE, fetch });
        const dataUrl = 'data:image/png;base64,AAAA';
        const out = await p.describeVision('vm', 'describe this', dataUrl, {});
        expect(out).toBe('a cat');
        const content = fetch.calls[0].body.messages[0].content;
        expect(content[0]).toEqual({ type: 'text', text: 'describe this' });
        expect(content[1]).toEqual({ type: 'image_url', image_url: { url: dataUrl } });
    });
});
