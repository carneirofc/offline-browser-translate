'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
    normalizeLangCode,
    detectLanguageByScript,
    detectSourceLanguage,
    resolveSourceLanguage,
    parseTranslationResponse,
    estimateTokens,
    groupTextNodesIntoBatches,
    buildPrompt,
} = require('../translation-core.js');

test('normalizeLangCode strips region/script subtags', () => {
    assert.equal(normalizeLangCode('ja-JP'), 'ja');
    assert.equal(normalizeLangCode('en_US'), 'en');
    assert.equal(normalizeLangCode('zh-Hans'), 'zh');
    assert.equal(normalizeLangCode('  PT-br '), 'pt');
    assert.equal(normalizeLangCode(''), '');
    assert.equal(normalizeLangCode(null), '');
    assert.equal(normalizeLangCode('123'), '');
    assert.equal(normalizeLangCode('english'), '');
});

test('detectLanguageByScript identifies non-Latin scripts', () => {
    assert.equal(detectLanguageByScript('これは日本語のテストです'), 'ja', 'kana+kanji => ja');
    assert.equal(detectLanguageByScript('日本語のテスト'), 'ja', 'kana present => ja not zh');
    assert.equal(detectLanguageByScript('这是一个中文测试句子'), 'zh', 'han only => zh');
    assert.equal(detectLanguageByScript('한국어 테스트 문장입니다'), 'ko');
    assert.equal(detectLanguageByScript('Это тестовое предложение'), 'ru');
    assert.equal(detectLanguageByScript('هذه جملة اختبار'), 'ar');
    assert.equal(detectLanguageByScript('Αυτή είναι μια δοκιμή'), 'el');
});

test('detectLanguageByScript returns "" for Latin / ambiguous / empty', () => {
    assert.equal(detectLanguageByScript('This is plain English text'), '');
    assert.equal(detectLanguageByScript(''), '');
    assert.equal(detectLanguageByScript('12345 !@#$%'), '');
    // A couple of stray foreign glyphs in mostly-Latin text must not flip it.
    assert.equal(detectLanguageByScript('The word café and Ω appear here in English'), '');
});

test('detectSourceLanguage: script beats metadata; metadata is the fallback', () => {
    // Japanese content with a (wrong) declared lang still detects as ja.
    assert.equal(detectSourceLanguage('これは日本語です', { declaredLang: 'en' }), 'ja');
    // Latin content falls back to declared metadata.
    assert.equal(detectSourceLanguage('Bonjour le monde', { declaredLang: 'fr-FR' }), 'fr');
    // No signal at all => ''.
    assert.equal(detectSourceLanguage('Hello world', {}), '');
});

test('resolveSourceLanguage: explicit setting wins, else detect, else auto', () => {
    assert.equal(resolveSourceLanguage('de', 'これは日本語', 'en'), 'de', 'explicit wins');
    assert.equal(resolveSourceLanguage('auto', 'これは日本語です', 'en'), 'ja', 'detect from text');
    assert.equal(resolveSourceLanguage('auto', 'Hello world', 'fr-FR'), 'fr', 'fall to page lang');
    assert.equal(resolveSourceLanguage('auto', 'Hello world', null), 'auto', 'nothing known');
});

test('parseTranslationResponse handles clean JSON', () => {
    const out = parseTranslationResponse(
        '{"translations":[{"id":0,"text":"Hola"},{"id":1,"text":"Mundo"}]}',
        [{ id: 10 }, { id: 11 }]
    );
    // Model used sequential ids -> remapped onto our original ids.
    assert.deepEqual(out, [{ id: 10, text: 'Hola', error: undefined }, { id: 11, text: 'Mundo', error: undefined }]);
});

test('parseTranslationResponse extracts JSON embedded in prose', () => {
    const out = parseTranslationResponse(
        'Sure! Here you go:\n{"translations":[{"id":0,"text":"Bonjour"}]}\nHope that helps.',
        [{ id: 5 }]
    );
    assert.equal(out.length, 1);
    assert.equal(out[0].id, 5);
    assert.equal(out[0].text, 'Bonjour');
});

test('parseTranslationResponse falls back to [id]: line markers', () => {
    const out = parseTranslationResponse('[0]: Hallo\n[1]: Welt', [{ id: 'a' }, { id: 'b' }]);
    assert.deepEqual(out, [{ id: 'a', text: 'Hallo' }, { id: 'b', text: 'Welt' }]);
});

test('parseTranslationResponse: single item = whole response', () => {
    const out = parseTranslationResponse('Ciao, come va?', [{ id: 42 }]);
    assert.deepEqual(out, [{ id: 42, text: 'Ciao, come va?' }]);
});

test('parseTranslationResponse strips leaked id prefixes/markup', () => {
    const out = parseTranslationResponse('{"translations":[{"id":0,"text":"[0]: <b>Hi</b>"}]}', [{ id: 7 }]);
    assert.equal(out[0].text, 'Hi');
});

test('estimateTokens grows with length and is non-zero for content', () => {
    assert.ok(estimateTokens('') === 0);
    assert.ok(estimateTokens('a') >= 1);
    assert.ok(estimateTokens('a'.repeat(400)) > estimateTokens('a'.repeat(40)));
});

test('groupTextNodesIntoBatches keeps a block together', () => {
    const items = [
        { id: 1, text: 'one', blockId: 'p1' },
        { id: 2, text: 'two', blockId: 'p1' },
        { id: 3, text: 'three', blockId: 'p1' },
    ];
    const batches = groupTextNodesIntoBatches(items, { maxItems: 8, maxTokens: 2000 });
    assert.equal(batches.length, 1);
    assert.deepEqual(batches[0].map(i => i.id), [1, 2, 3]);
});

test('groupTextNodesIntoBatches packs small blocks up to maxItems', () => {
    const items = [];
    for (let i = 0; i < 10; i++) items.push({ id: i, text: 'x', blockId: 'b' + i });
    const batches = groupTextNodesIntoBatches(items, { maxItems: 4, maxTokens: 2000 });
    // 10 single-item blocks packed 4/4/2.
    assert.deepEqual(batches.map(b => b.length), [4, 4, 2]);
});

test('groupTextNodesIntoBatches never splits a block that fits maxItems', () => {
    const items = [
        { id: 1, text: 'a', blockId: 'p1' },
        { id: 2, text: 'b', blockId: 'p1' },
        { id: 3, text: 'c', blockId: 'p1' },
        { id: 4, text: 'd', blockId: 'p2' },
        { id: 5, text: 'e', blockId: 'p2' },
    ];
    // maxItems 4: p1(3) fits; adding p2(2) would exceed 4, so p2 starts a new batch.
    const batches = groupTextNodesIntoBatches(items, { maxItems: 4, maxTokens: 2000 });
    assert.deepEqual(batches.map(b => b.map(i => i.id)), [[1, 2, 3], [4, 5]]);
});

test('groupTextNodesIntoBatches spills an oversize block across batches', () => {
    const items = [];
    for (let i = 0; i < 5; i++) items.push({ id: i, text: 'word', blockId: 'big' });
    const batches = groupTextNodesIntoBatches(items, { maxItems: 2, maxTokens: 2000 });
    assert.deepEqual(batches.map(b => b.length), [2, 2, 1]);
    // Order preserved across the spill.
    assert.deepEqual(batches.flat().map(i => i.id), [0, 1, 2, 3, 4]);
});

test('groupTextNodesIntoBatches respects the token budget', () => {
    const items = [
        { id: 1, text: 'a'.repeat(400), blockId: 'p1' }, // ~101 tokens
        { id: 2, text: 'b'.repeat(400), blockId: 'p2' }, // ~101 tokens
    ];
    const batches = groupTextNodesIntoBatches(items, { maxItems: 8, maxTokens: 120 });
    // Each block alone (~101) fits 120, but together (~202) exceeds it.
    assert.equal(batches.length, 2);
});

test('buildPrompt substitutes all occurrences', () => {
    assert.equal(
        buildPrompt('from {{src}} to {{tgt}} ({{tgt}})', { src: 'Japanese', tgt: 'English' }),
        'from Japanese to English (English)'
    );
});
