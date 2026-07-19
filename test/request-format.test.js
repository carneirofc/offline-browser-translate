import { describe, test, expect } from 'vitest';
import languages from '../languages.js';

const { detectRequestFormat, resolveRequestFormat } = languages;

describe('detectRequestFormat', () => {
    test('maps known model families by case-insensitive substring', () => {
        expect(detectRequestFormat('TranslateGemma-9B')).toBe('translategemma');
        expect(detectRequestFormat('translate-gemma:latest')).toBe('translategemma');
        expect(detectRequestFormat('hunyuan-mt-7b')).toBe('hunyuan');
    });

    test('falls back to "default" for unknown or empty ids', () => {
        expect(detectRequestFormat('llama3.1:8b')).toBe('default');
        expect(detectRequestFormat('')).toBe('default');
        expect(detectRequestFormat(null)).toBe('default');
    });
});

describe('resolveRequestFormat', () => {
    test('honours an explicit non-auto requestFormat', () => {
        expect(resolveRequestFormat({ requestFormat: 'simple', selectedModel: 'translategemma' }))
            .toBe('simple');
    });

    test('"auto" derives the format from the model id', () => {
        expect(resolveRequestFormat({ requestFormat: 'auto', selectedModel: 'TranslateGemma' }))
            .toBe('translategemma');
        expect(resolveRequestFormat({ requestFormat: 'auto', selectedModel: 'mistral' }))
            .toBe('default');
    });

    test('a missing requestFormat is treated as auto', () => {
        expect(resolveRequestFormat({ selectedModel: 'hunyuan-mt' })).toBe('hunyuan');
    });

    test('an explicit modelId argument overrides settings.selectedModel', () => {
        expect(resolveRequestFormat({ requestFormat: 'auto', selectedModel: 'mistral' }, 'hunyuan-mt'))
            .toBe('hunyuan');
    });
});
