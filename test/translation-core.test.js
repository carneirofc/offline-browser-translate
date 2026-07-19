import { describe, test, expect } from 'vitest';
import core from '../translation-core.js';

const {
    normalizeLangCode,
    detectLanguageByScript,
    detectSourceLanguage,
    resolveSourceLanguage,
    parseTranslationResponse,
    cleanTranslationText,
    extractJsonObject,
    splitIntoSentences,
    estimateTokens,
    groupTextNodesIntoBatches,
    buildPrompt,
} = core;

describe('language detection', () => {
    test('normalizeLangCode strips region/script subtags', () => {
        expect(normalizeLangCode('ja-JP')).toBe('ja');
        expect(normalizeLangCode('en_US')).toBe('en');
        expect(normalizeLangCode('zh-Hans')).toBe('zh');
        expect(normalizeLangCode('  PT-br ')).toBe('pt');
        expect(normalizeLangCode('')).toBe('');
        expect(normalizeLangCode(null)).toBe('');
        expect(normalizeLangCode('123')).toBe('');
        expect(normalizeLangCode('english')).toBe('');
    });

    test('detectLanguageByScript identifies non-Latin scripts', () => {
        expect(detectLanguageByScript('これは日本語のテストです')).toBe('ja'); // kana+kanji => ja
        expect(detectLanguageByScript('日本語のテスト')).toBe('ja');           // kana present => ja not zh
        expect(detectLanguageByScript('这是一个中文测试句子')).toBe('zh');      // han only => zh
        expect(detectLanguageByScript('한국어 테스트 문장입니다')).toBe('ko');
        expect(detectLanguageByScript('Это тестовое предложение')).toBe('ru');
        expect(detectLanguageByScript('هذه جملة اختبار')).toBe('ar');
        expect(detectLanguageByScript('Αυτή είναι μια δοκιμή')).toBe('el');
    });

    test('detectLanguageByScript returns "" for Latin / ambiguous / empty', () => {
        expect(detectLanguageByScript('This is plain English text')).toBe('');
        expect(detectLanguageByScript('')).toBe('');
        expect(detectLanguageByScript('12345 !@#$%')).toBe('');
        // A couple of stray foreign glyphs in mostly-Latin text must not flip it.
        expect(detectLanguageByScript('The word café and Ω appear here in English')).toBe('');
    });

    test('detectSourceLanguage: script beats metadata; metadata is the fallback', () => {
        expect(detectSourceLanguage('これは日本語です', { declaredLang: 'en' })).toBe('ja');
        expect(detectSourceLanguage('Bonjour le monde', { declaredLang: 'fr-FR' })).toBe('fr');
        expect(detectSourceLanguage('Hello world', {})).toBe('');
    });

    test('resolveSourceLanguage: explicit setting wins, else detect, else auto', () => {
        expect(resolveSourceLanguage('de', 'これは日本語', 'en')).toBe('de');
        expect(resolveSourceLanguage('auto', 'これは日本語です', 'en')).toBe('ja');
        expect(resolveSourceLanguage('auto', 'Hello world', 'fr-FR')).toBe('fr');
        expect(resolveSourceLanguage('auto', 'Hello world', null)).toBe('auto');
    });
});

describe('parseTranslationResponse', () => {
    test('handles clean JSON and remaps sequential ids', () => {
        const out = parseTranslationResponse(
            '{"translations":[{"id":0,"text":"Hola"},{"id":1,"text":"Mundo"}]}',
            [{ id: 10 }, { id: 11 }]
        );
        expect(out).toEqual([
            { id: 10, text: 'Hola', error: undefined },
            { id: 11, text: 'Mundo', error: undefined },
        ]);
    });

    test('extracts JSON embedded in prose', () => {
        const out = parseTranslationResponse(
            'Sure! Here you go:\n{"translations":[{"id":0,"text":"Bonjour"}]}\nHope that helps.',
            [{ id: 5 }]
        );
        expect(out).toEqual([{ id: 5, text: 'Bonjour', error: undefined }]);
    });

    test('falls back to [id]: line markers', () => {
        const out = parseTranslationResponse('[0]: Hallo\n[1]: Welt', [{ id: 'a' }, { id: 'b' }]);
        expect(out).toEqual([{ id: 'a', text: 'Hallo' }, { id: 'b', text: 'Welt' }]);
    });

    test('single item = whole response', () => {
        const out = parseTranslationResponse('Ciao, come va?', [{ id: 42 }]);
        expect(out).toEqual([{ id: 42, text: 'Ciao, come va?' }]);
    });

    test('strips leaked id prefixes/markup', () => {
        const out = parseTranslationResponse('{"translations":[{"id":0,"text":"[0]: <b>Hi</b>"}]}', [{ id: 7 }]);
        expect(out[0].text).toBe('Hi');
    });

    test('strips ```json code fences (LM Studio/llama.cpp)', () => {
        const raw = '```json\n{"translations":[{"id":0,"text":"Hola"},{"id":1,"text":"Adiós"}]}\n```';
        const out = parseTranslationResponse(raw, [{ id: 'x' }, { id: 'y' }]);
        expect(out.map(t => t.text)).toEqual(['Hola', 'Adiós']);
        expect(out.map(t => t.id)).toEqual(['x', 'y']);
    });

    test('accepts a bare JSON array', () => {
        const out = parseTranslationResponse('[{"id":0,"text":"Bonjour"}]', [{ id: 99 }]);
        expect(out[0].id).toBe(99);
        expect(out[0].text).toBe('Bonjour');
    });

    test('preserves matching original (non-sequential) ids', () => {
        const out = parseTranslationResponse(
            '{"translations":[{"id":11,"text":"B"},{"id":10,"text":"A"}]}',
            [{ id: 10 }, { id: 11 }]
        );
        const byId = Object.fromEntries(out.map(t => [t.id, t.text]));
        expect(byId[10]).toBe('A');
        expect(byId[11]).toBe('B');
    });
});

describe('cleanTranslationText', () => {
    test('strips a leading [id]: marker', () => {
        expect(cleanTranslationText('[3]: Hola')).toBe('Hola');
        expect(cleanTranslationText('3: Hola')).toBe('Hola');
    });

    test('removes leaked inline HTML tags but leaves lone angle brackets', () => {
        expect(cleanTranslationText('<b>Hi</b> there')).toBe('Hi there');
        expect(cleanTranslationText('a < b and 3 < 4')).toBe('a < b and 3 < 4');
    });

    test('collapses runs of spaces and passes through falsy input', () => {
        expect(cleanTranslationText('too    many     spaces')).toBe('too many spaces');
        expect(cleanTranslationText('')).toBe('');
        expect(cleanTranslationText(null)).toBe(null);
    });
});

describe('extractJsonObject', () => {
    test('returns the first balanced object, ignoring braces inside strings', () => {
        expect(extractJsonObject('noise {"a":1} tail')).toBe('{"a":1}');
        expect(extractJsonObject('{"a":"}not the end{","b":2} rest')).toBe('{"a":"}not the end{","b":2}');
    });

    test('handles nesting and escaped quotes', () => {
        expect(extractJsonObject('x {"a":{"b":1}} y')).toBe('{"a":{"b":1}}');
        expect(extractJsonObject('{"a":"say \\"hi\\""}')).toBe('{"a":"say \\"hi\\""}');
    });

    test('returns null when there is no object or it is unbalanced', () => {
        expect(extractJsonObject('no braces here')).toBe(null);
        expect(extractJsonObject('{"a":1')).toBe(null);
    });
});

describe('splitIntoSentences', () => {
    test('re-joining the segments reproduces the original string', () => {
        const text = 'First sentence. Second one! And a third?  Trailing.';
        const segments = splitIntoSentences(text);
        expect(segments.join('')).toBe(text);
    });

    test('splits Latin sentences on terminator + whitespace', () => {
        expect(splitIntoSentences('One. Two. Three.')).toEqual(['One. ', 'Two. ', 'Three.']);
    });

    test('splits CJK sentences immediately on 。？！', () => {
        expect(splitIntoSentences('これは一つ。これは二つ！')).toEqual(['これは一つ。', 'これは二つ！']);
    });

    test('does not split a decimal point between digits', () => {
        expect(splitIntoSentences('Pi is 3.14 today.')).toEqual(['Pi is 3.14 today.']);
    });

    test('keeps consecutive terminators together', () => {
        expect(splitIntoSentences('Really?! Yes.')).toEqual(['Really?! ', 'Yes.']);
    });

    test('empty input yields no segments; unsplittable input yields itself', () => {
        expect(splitIntoSentences('')).toEqual([]);
        expect(splitIntoSentences('no terminator here')).toEqual(['no terminator here']);
    });
});

describe('batching helpers', () => {
    test('estimateTokens grows with length and is non-zero for content', () => {
        expect(estimateTokens('')).toBe(0);
        expect(estimateTokens('a')).toBeGreaterThanOrEqual(1);
        expect(estimateTokens('a'.repeat(400))).toBeGreaterThan(estimateTokens('a'.repeat(40)));
    });

    test('keeps a block together', () => {
        const items = [
            { id: 1, text: 'one', blockId: 'p1' },
            { id: 2, text: 'two', blockId: 'p1' },
            { id: 3, text: 'three', blockId: 'p1' },
        ];
        const batches = groupTextNodesIntoBatches(items, { maxItems: 8, maxTokens: 2000 });
        expect(batches.length).toBe(1);
        expect(batches[0].map(i => i.id)).toEqual([1, 2, 3]);
    });

    test('packs small blocks up to maxItems', () => {
        const items = [];
        for (let i = 0; i < 10; i++) items.push({ id: i, text: 'x', blockId: 'b' + i });
        const batches = groupTextNodesIntoBatches(items, { maxItems: 4, maxTokens: 2000 });
        expect(batches.map(b => b.length)).toEqual([4, 4, 2]);
    });

    test('never splits a block that fits maxItems', () => {
        const items = [
            { id: 1, text: 'a', blockId: 'p1' },
            { id: 2, text: 'b', blockId: 'p1' },
            { id: 3, text: 'c', blockId: 'p1' },
            { id: 4, text: 'd', blockId: 'p2' },
            { id: 5, text: 'e', blockId: 'p2' },
        ];
        const batches = groupTextNodesIntoBatches(items, { maxItems: 4, maxTokens: 2000 });
        expect(batches.map(b => b.map(i => i.id))).toEqual([[1, 2, 3], [4, 5]]);
    });

    test('spills an oversize block across batches, preserving order', () => {
        const items = [];
        for (let i = 0; i < 5; i++) items.push({ id: i, text: 'word', blockId: 'big' });
        const batches = groupTextNodesIntoBatches(items, { maxItems: 2, maxTokens: 2000 });
        expect(batches.map(b => b.length)).toEqual([2, 2, 1]);
        expect(batches.flat().map(i => i.id)).toEqual([0, 1, 2, 3, 4]);
    });

    test('respects the token budget', () => {
        const items = [
            { id: 1, text: 'a'.repeat(400), blockId: 'p1' }, // ~101 tokens
            { id: 2, text: 'b'.repeat(400), blockId: 'p2' }, // ~101 tokens
        ];
        const batches = groupTextNodesIntoBatches(items, { maxItems: 8, maxTokens: 120 });
        expect(batches.length).toBe(2);
    });
});

describe('buildPrompt', () => {
    test('substitutes all occurrences of every placeholder', () => {
        expect(
            buildPrompt('from {{src}} to {{tgt}} ({{tgt}})', { src: 'Japanese', tgt: 'English' })
        ).toBe('from Japanese to English (English)');
    });
});
