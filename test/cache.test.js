import { describe, test, expect } from 'vitest';
import cache from '../cache.js';

const { cacheKey } = cache;
const NUL = String.fromCharCode(0);

describe('cacheKey', () => {
    test('joins the prompt-determining inputs with a NUL separator', () => {
        expect(cacheKey('llama3', 'ja', 'en', 'default', 'こんにちは'))
            .toBe(['llama3', 'ja', 'en', 'default', 'こんにちは'].join(NUL));
    });

    test('is stable for identical inputs and distinct when any field changes', () => {
        const base = cacheKey('m', 's', 't', 'f', 'text');
        expect(cacheKey('m', 's', 't', 'f', 'text')).toBe(base);
        expect(cacheKey('m2', 's', 't', 'f', 'text')).not.toBe(base);
        expect(cacheKey('m', 's2', 't', 'f', 'text')).not.toBe(base);
        expect(cacheKey('m', 's', 't2', 'f', 'text')).not.toBe(base);
        expect(cacheKey('m', 's', 't', 'f2', 'text')).not.toBe(base);
        expect(cacheKey('m', 's', 't', 'f', 'text2')).not.toBe(base);
    });

    test('coerces nullish leading fields to empty strings, keeping the key well-formed', () => {
        expect(cacheKey(null, undefined, '', 0, 'body'))
            .toBe(['', '', '', '', 'body'].join(NUL));
    });

    test('the same text under different fields does not collide', () => {
        expect(cacheKey('a', '', '', '', 'x')).not.toBe(cacheKey('', 'a', '', '', 'x'));
    });
});
