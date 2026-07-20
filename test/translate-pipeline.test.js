import { describe, test, expect } from 'vitest';
import pipeline from '../translate-pipeline.js';

const { createPipeline } = pipeline;

const NUL = String.fromCharCode(0);

/** In-memory cache double implementing the { key, getMany, setMany } shape. */
function makeCache() {
    const store = new Map();
    const setCalls = [];
    return {
        store,
        setCalls,
        key: (model, s, t, fmt, text) => [model, s, t, fmt, text].join(NUL),
        async getMany(keys) {
            const m = new Map();
            for (const k of keys) if (store.has(k)) m.set(k, store.get(k));
            return m;
        },
        async setMany(entries) {
            setCalls.push(entries);
            for (const [k, v] of entries) store.set(k, v);
        }
    };
}

/** A provider whose chatCompletion returns queued responses (strings or Errors). */
function chatProvider(responses) {
    const queue = [...responses];
    const calls = [];
    return {
        calls,
        async chatCompletion(model, system, user, opts) {
            calls.push({ model, system, user, opts });
            const r = queue.shift();
            if (r instanceof Error) throw r;
            return r;
        }
    };
}

const jsonBatch = (pairs) => JSON.stringify({ translations: pairs.map(([id, text]) => ({ id, text })) });
const baseSettings = (over) => ({ selectedModel: 'm', useStructuredOutput: true, cacheMode: 'off', temperature: 0.3, ...over });

describe('translate', () => {
    test('returns translations in original order and requests a JSON schema', async () => {
        const provider = chatProvider([jsonBatch([[0, 'A'], [1, 'B']])]);
        const pipe = createPipeline({ provider });
        const res = await pipe.translate(
            [{ id: 'x', text: 'a' }, { id: 'y', text: 'b' }],
            'en',
            baseSettings()
        );
        expect(res.translations).toEqual([{ id: 'x', text: 'A' }, { id: 'y', text: 'B' }]);
        expect(res.total).toBe(2);
        expect(res.fromCache).toBe(0);
        expect(res.cacheActive).toBe(false);
        expect(provider.calls).toHaveLength(1);
        expect(provider.calls[0].opts.jsonSchema).toBeTruthy();
    });

    test('omits the JSON schema when structured output is disabled', async () => {
        const provider = chatProvider([jsonBatch([[0, 'A']])]);
        const pipe = createPipeline({ provider });
        await pipe.translate([{ id: 'x', text: 'a' }], 'en', baseSettings({ useStructuredOutput: false }));
        expect(provider.calls[0].opts.jsonSchema).toBeNull();
    });

    test('de-duplicates identical source text into one request', async () => {
        const provider = chatProvider([jsonBatch([[0, 'HI']])]);
        const pipe = createPipeline({ provider });
        const res = await pipe.translate(
            [{ id: 'x', text: 'hi' }, { id: 'y', text: 'hi' }],
            'en',
            baseSettings()
        );
        expect(provider.calls).toHaveLength(1);
        expect(res.translations).toEqual([{ id: 'x', text: 'HI' }, { id: 'y', text: 'HI' }]);
    });

    test('retries only the items that came back missing', async () => {
        // First attempt resolves id 0 only; the retry (a fresh 1-item batch) resolves the rest.
        const provider = chatProvider([jsonBatch([[0, 'A']]), jsonBatch([[0, 'B']])]);
        const pipe = createPipeline({ provider });
        const res = await pipe.translate(
            [{ id: 'x', text: 'a' }, { id: 'y', text: 'b' }],
            'en',
            baseSettings()
        );
        expect(res.translations).toEqual([{ id: 'x', text: 'A' }, { id: 'y', text: 'B' }]);
        expect(provider.calls).toHaveLength(2);
    });

    test('marks items that never resolve with an error', async () => {
        const provider = chatProvider([jsonBatch([]), jsonBatch([]), jsonBatch([])]);
        const pipe = createPipeline({ provider });
        const res = await pipe.translate([{ id: 'x', text: 'a' }], 'en', baseSettings({ maxOutputRetries: 2 }));
        expect(res.translations).toEqual([{ id: 'x', error: 'translation failed' }]);
    });

    test('serves a second run from the cache without calling the provider', async () => {
        const cache = makeCache();
        const settings = baseSettings({ cacheMode: 'persistent' });

        const provider1 = chatProvider([jsonBatch([[0, 'A'], [1, 'B']])]);
        const pipe1 = createPipeline({ provider: provider1, cache });
        const first = await pipe1.translate([{ id: 'x', text: 'a' }, { id: 'y', text: 'b' }], 'en', settings);
        expect(first.cacheActive).toBe(true);
        expect(cache.setCalls.length).toBeGreaterThan(0);

        // A provider that throws if used — the second run must be all cache hits.
        const provider2 = { chatCompletion: async () => { throw new Error('should not be called'); }, calls: [] };
        const pipe2 = createPipeline({ provider: provider2, cache });
        const second = await pipe2.translate([{ id: 'x', text: 'a' }, { id: 'y', text: 'b' }], 'en', settings);
        expect(second.fromCache).toBe(2);
        expect(second.translations).toEqual([{ id: 'x', text: 'A' }, { id: 'y', text: 'B' }]);
    });

    test('throws when no model is selected', async () => {
        const pipe = createPipeline({ provider: chatProvider([]) });
        await expect(pipe.translate([{ id: 'x', text: 'a' }], 'en', baseSettings({ selectedModel: '' })))
            .rejects.toThrow(/No model selected/);
    });
});

describe('translateStream', () => {
    test('emits progressive text and returns the final translation', async () => {
        const provider = {
            async chatCompletionStream(model, system, user, onDelta) {
                onDelta('Ho');
                onDelta('la');
                return 'Hola';
            }
        };
        const pipe = createPipeline({ provider });
        const emits = [];
        const res = await pipe.translateStream(
            [{ id: 'x', text: 'hi' }],
            'es',
            baseSettings(),
            (id, text) => emits.push([id, text])
        );
        expect(res.translations).toEqual([{ id: 'x', text: 'Hola' }]);
        expect(emits[emits.length - 1]).toEqual(['x', 'Hola']);
        expect(emits.length).toBeGreaterThan(1); // progressive
    });

    test('fans a cache hit out to every duplicate immediately', async () => {
        const cache = makeCache();
        const settings = baseSettings({ cacheMode: 'session' });
        const provider1 = {
            async chatCompletionStream(m, s, u, onDelta) { onDelta('Hola'); return 'Hola'; }
        };
        const pipe1 = createPipeline({ provider: provider1, cache });
        await pipe1.translateStream([{ id: 'x', text: 'hi' }], 'es', settings, () => {});

        const provider2 = { chatCompletionStream: async () => { throw new Error('should not be called'); } };
        const pipe2 = createPipeline({ provider: provider2, cache });
        const emits = [];
        const res = await pipe2.translateStream([{ id: 'a', text: 'hi' }, { id: 'b', text: 'hi' }], 'es', settings, (id, t) => emits.push([id, t]));
        expect(res.fromCache).toBe(2);
        expect(res.translations).toEqual([{ id: 'a', text: 'Hola' }, { id: 'b', text: 'Hola' }]);
    });
});

describe('describe', () => {
    test('substitutes the target language, calls the vision model, and returns trimmed text', async () => {
        let seen;
        const provider = {
            async describeVision(model, prompt, imageDataUrl, opts) {
                seen = { model, prompt, imageDataUrl, opts };
                return '  a cat  ';
            }
        };
        const pipe = createPipeline({ provider });
        const settings = baseSettings({ visionModel: 'vm', targetLanguage: 'en', describePrompt: 'Describe in {{targetLanguage}}.' });
        const out = await pipe.describe('data:image/png;base64,AAAA', settings);
        expect(out).toBe('a cat');
        expect(seen.model).toBe('vm');
        expect(seen.prompt).toBe('Describe in English.');
        expect(seen.imageDataUrl).toBe('data:image/png;base64,AAAA');
    });

    test('caches the description and serves the second call from cache', async () => {
        const cache = makeCache();
        const settings = baseSettings({ visionModel: 'vm', targetLanguage: 'en', describePrompt: 'X', cacheMode: 'persistent' });
        const provider1 = { describeVision: async () => 'first' };
        const out1 = await createPipeline({ provider: provider1, cache }).describe('data:image/png;base64,ZZ', settings);
        expect(out1).toBe('first');

        const provider2 = { describeVision: async () => { throw new Error('should not be called'); } };
        const out2 = await createPipeline({ provider: provider2, cache }).describe('data:image/png;base64,ZZ', settings);
        expect(out2).toBe('first');
    });

    test('throws when no vision or preferred model is configured', async () => {
        const pipe = createPipeline({ provider: { describeVision: async () => 'x' } });
        await expect(pipe.describe('data:image/png;base64,AA', baseSettings({ selectedModel: '', visionModel: '' })))
            .rejects.toThrow(/No vision model/);
    });

    test('throws when the data URL carries no base64 payload', async () => {
        const pipe = createPipeline({ provider: { describeVision: async () => 'x' } });
        await expect(pipe.describe('data:image/png;base64,', baseSettings({ visionModel: 'vm' })))
            .rejects.toThrow(/No image data/);
    });
});
