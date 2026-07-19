/**
 * Translation core: pure, side-effect-free helpers shared by the background
 * worker and the content script, and unit-tested under Node with `node:test`.
 *
 * Nothing here touches the DOM, `chrome`/`browser` APIs, or the network, so the
 * same source loads three ways:
 *  - in the background service worker (listed in manifest `background.scripts`),
 *  - in the content script (injected right before `content.js`), and
 *  - in Node tests (`require('./translation-core.js')`).
 *
 * It exposes its API on the global object (like `cache.js`/`defaults.js`) and,
 * when running under CommonJS, on `module.exports`.
 */
(function () {
    'use strict';

    // ---- Source-language detection -----------------------------------------

    // Per-script Unicode ranges, in priority order. Kana is checked first so a
    // Japanese sentence (kana + kanji) resolves to `ja` rather than `zh`.
    const SCRIPT_RANGES = [
        { code: 'ja', re: /[぀-ゟ゠-ヿ]/g },              // Hiragana + Katakana
        { code: 'ko', re: /[가-힣ᄀ-ᇿ㄰-㆏]/g }, // Hangul
        { code: 'zh', re: /[一-鿿㐀-䶿]/g },             // Han (no kana)
        { code: 'ru', re: /[Ѐ-ӿ]/g },                          // Cyrillic
        { code: 'ar', re: /[؀-ۿݐ-ݿ]/g },             // Arabic
        { code: 'he', re: /[֐-׿]/g },                          // Hebrew
        { code: 'el', re: /[Ͱ-Ͽ]/g },                          // Greek
        { code: 'hi', re: /[ऀ-ॿ]/g },                          // Devanagari
        { code: 'th', re: /[฀-๿]/g },                          // Thai
    ];

    /**
     * Normalise a BCP-47-ish language tag to a bare ISO-639 base code.
     * @param {*} lang e.g. "ja-JP", "en_US", "zh-Hans"
     * @returns {string} lowercased 2-3 letter base code, or '' if unusable
     */
    function normalizeLangCode(lang) {
        if (!lang || typeof lang !== 'string') return '';
        const base = lang.trim().toLowerCase().split(/[-_]/)[0];
        return /^[a-z]{2,3}$/.test(base) ? base : '';
    }

    /**
     * Detect the dominant written script of a string and map it to a language
     * code. Non-Latin scripts (CJK, Hangul, Cyrillic, …) are unambiguous enough
     * to identify from characters alone; Latin text returns '' (undetermined).
     * @param {string} text
     * @returns {string} language code (e.g. 'ja') or '' when undetermined
     */
    function detectLanguageByScript(text) {
        if (!text || typeof text !== 'string') return '';
        const letters = text.match(/\p{L}/gu);
        const total = letters ? letters.length : 0;
        if (total === 0) return '';

        const counts = {};
        for (const { code, re } of SCRIPT_RANGES) {
            const m = text.match(re);
            counts[code] = m ? m.length : 0;
        }

        // Any real kana presence ⇒ Japanese, even when kanji outnumber kana.
        if (counts.ja >= 2 && counts.ja / total >= 0.05) return 'ja';

        let best = '';
        let bestCount = 0;
        for (const { code } of SCRIPT_RANGES) {
            if (code === 'ja') continue;
            if (counts[code] > bestCount) {
                bestCount = counts[code];
                best = code;
            }
        }
        // Require a meaningful share so a few stray glyphs don't flip the result.
        if (best && bestCount >= 2 && bestCount / total >= 0.1) return best;
        return '';
    }

    /**
     * Resolve the source language of page text from its script and, failing
     * that, from declared page metadata. Does NOT fall back to English — an
     * undetermined result is returned as '' for the caller to handle.
     * @param {string} text sample of the page's text
     * @param {{declaredLang?:string, contentLanguage?:string}} [metadata]
     * @returns {string} language code or ''
     */
    function detectSourceLanguage(text, metadata = {}) {
        const byScript = detectLanguageByScript(text || '');
        if (byScript) return byScript;
        const meta = normalizeLangCode(
            metadata && (metadata.declaredLang || metadata.contentLanguage)
        );
        return meta || '';
    }

    /**
     * Pick the source language for a translation request. An explicit user
     * setting wins; otherwise detect from the text and declared page language.
     * @param {string} setting user setting ('auto' or a specific code)
     * @param {string} text sample page text used for script detection
     * @param {string} [pageLang] declared page language (html lang / meta)
     * @returns {string} resolved code, or 'auto' when nothing could be determined
     */
    function resolveSourceLanguage(setting, text, pageLang) {
        if (setting && setting !== 'auto') return normalizeLangCode(setting) || setting;
        const detected = detectSourceLanguage(text, { declaredLang: pageLang });
        return detected || normalizeLangCode(pageLang) || 'auto';
    }

    // ---- Prompt helpers -----------------------------------------------------

    /**
     * Render the `[id]: text` block that structured prompts embed.
     * @param {Array<{id:*, text:string}>} textItems
     * @returns {string}
     */
    function formatTextsForPrompt(textItems) {
        return textItems.map(item => `[${item.id}]: ${item.text}`).join('\n');
    }

    /**
     * Substitute `{{key}}` placeholders in a prompt template.
     * @param {string} template
     * @param {{[key: string]: string}} vars
     * @returns {string}
     */
    function buildPrompt(template, vars) {
        let result = template;
        for (const [key, value] of Object.entries(vars)) {
            result = result.replace(new RegExp(`{{${key}}}`, 'g'), value);
        }
        return result;
    }

    // ---- Response parsing ---------------------------------------------------

    // A small allowlist of inline HTML tags that occasionally leak from models.
    // We only strip these — arbitrary "<...>" is left alone so legitimate text
    // like "a < b" or "<3" is never mangled.
    const LEAKED_HTML_TAG = /<\/?(?:div|span|p|br|b|i|em|strong|ul|ol|li|a|h[1-6])\b[^>]*>/gi;

    /**
     * Strip id prefixes and leaked markup a model may prepend to a translation.
     * @param {string} text
     * @returns {string}
     */
    function cleanTranslationText(text) {
        if (!text) return text;
        let cleaned = text.replace(/^\[?\d+\]?:\s*/g, '');
        cleaned = cleaned.replace(LEAKED_HTML_TAG, '');
        cleaned = cleaned.replace(/  +/g, ' ');
        return cleaned;
    }

    /**
     * Heuristic: does this look like leaked structure (JSON/markup) rather than
     * an actual translation? Conservative to avoid false positives.
     * @param {*} text
     * @returns {boolean}
     */
    function isSuspiciousTranslation(text) {
        if (text === null || text === undefined) return true;
        const t = String(text).trim();
        if (!t) return true;
        if (!/\p{L}/u.test(t)) return true;
        if (/["']?(?:translations|id|text)["']?\s*:/.test(t)) return true;
        if (/^[[{][\s\S]*[\]}]$/.test(t) && /["':]/.test(t)) return true;
        if (t.includes('```')) return true;
        return false;
    }

    /**
     * Extract the first balanced `{...}` object from a string, respecting
     * strings and escapes. More reliable than a greedy regex when the model
     * wraps JSON in prose.
     * @param {string} text
     * @returns {string|null} the JSON substring, or null if none/unbalanced
     */
    function extractJsonObject(text) {
        const start = text.indexOf('{');
        if (start === -1) return null;
        let depth = 0;
        let inString = false;
        let escaped = false;
        for (let i = start; i < text.length; i++) {
            const ch = text[i];
            if (inString) {
                if (escaped) escaped = false;
                else if (ch === '\\') escaped = true;
                else if (ch === '"') inString = false;
            } else if (ch === '"') {
                inString = true;
            } else if (ch === '{') {
                depth++;
            } else if (ch === '}') {
                depth--;
                if (depth === 0) return text.slice(start, i + 1);
            }
        }
        return null;
    }

    /**
     * Parse a model response into `{id, text}` translations, tolerating JSON,
     * JSON-in-prose, `[id]:` line markers, and bare line-per-item output, and
     * remapping sequential model ids back onto the caller's original ids.
     * @param {string} response raw model output
     * @param {Array<{id:(number|string)}>} originalItems items sent, in order
     * @returns {TranslationResult[]}
     */
    function parseTranslationResponse(response, originalItems) {
        const expectedCount = originalItems.length;
        let translations = [];

        try {
            let cleanResponse = response
                .replace(/^```json\s*/m, '')
                .replace(/^```\s*/m, '')
                .replace(/\s*```$/m, '')
                .trim();

            const parsed = JSON.parse(cleanResponse);
            if (parsed.translations && Array.isArray(parsed.translations)) {
                translations = parsed.translations;
            } else if (Array.isArray(parsed)) {
                translations = parsed;
            }
        } catch (e) {
            const jsonStr = extractJsonObject(response);
            if (jsonStr) {
                try {
                    const parsed = JSON.parse(jsonStr);
                    if (parsed.translations && Array.isArray(parsed.translations)) {
                        translations = parsed.translations;
                    } else if (Array.isArray(parsed)) {
                        translations = parsed;
                    }
                } catch (e2) {
                    // Fall through to line-by-line parsing
                }
            }
        }

        if (translations.length > 0) {
            translations = translations.map(t => ({
                ...t,
                text: cleanTranslationText(t.text)
            }));

            const llmIds = translations.map(t => t.id);
            const ourIds = originalItems.map(t => t.id);
            const llmUsedSequential = llmIds.every((id, i) => id === i);
            const idsMismatch = !llmIds.some(id => ourIds.includes(id));

            if (llmUsedSequential || idsMismatch) {
                translations = translations.map((t, index) => ({
                    id: originalItems[index]?.id ?? t.id,
                    text: t.text,
                    error: t.error
                }));
            }

            return translations;
        }

        if (expectedCount === 1) {
            let text = response.trim().replace(/^\[?\d+\]?:\s*/, '');
            return [{ id: originalItems[0].id, text: cleanTranslationText(text) }];
        }

        const idMarkerRegex = /^\[?(\d+)\]?:\s*(.*)$/;
        const segments = [];
        let current = null;

        for (const line of response.split('\n')) {
            const match = line.match(idMarkerRegex);
            if (match) {
                if (current) segments.push(current);
                current = { id: parseInt(match[1]), text: match[2] };
            } else if (current) {
                current.text += '\n' + line;
            }
        }
        if (current) segments.push(current);

        if (segments.length > 0) {
            for (let i = 0; i < segments.length; i++) {
                const seg = segments[i];
                const text = seg.text.trim();
                if (!text) continue;
                const isOurId = originalItems.some(item => item.id === seg.id);
                translations.push({
                    id: isOurId ? seg.id : (originalItems[i]?.id ?? seg.id),
                    text: cleanTranslationText(text)
                });
            }
            return translations;
        }

        const nonEmptyLines = response.split('\n').filter(l => l.trim());
        for (let i = 0; i < Math.min(nonEmptyLines.length, expectedCount); i++) {
            const line = nonEmptyLines[i];
            const originalId = originalItems[i]?.id;
            if (originalId !== undefined) translations.push({ id: originalId, text: cleanTranslationText(line.trim()) });
        }
        return translations;
    }

    // ---- Sentence segmentation ---------------------------------------------

    /**
     * Split text into sentence-level segments while preserving all whitespace and
     * punctuation, so re-joining the segments reproduces the original string. CJK
     * terminators (。？！) end a segment immediately; Latin terminators (.!?) end
     * one only when followed by whitespace or end-of-text, and a period between
     * two digits (e.g. "3.14") is treated as a decimal point, not a sentence end.
     * @param {string} text
     * @returns {string[]} segments; `[text]` when nothing splits, `[]` for empty input
     */
    function splitIntoSentences(text) {
        if (!text) return [];
        const segments = [];
        let current = '';

        for (let i = 0; i < text.length; i++) {
            const ch = text[i];
            current += ch;

            if ('。？！'.includes(ch)) {
                segments.push(current);
                current = '';
                continue;
            }

            if (!'.!?'.includes(ch)) continue;

            const prev = text[i - 1] || '';
            const next = text[i + 1] || '';
            if (ch === '.' && /\d/.test(prev) && /\d/.test(next)) {
                continue;
            }

            while (i + 1 < text.length && '.!?'.includes(text[i + 1])) {
                current += text[++i];
            }

            if (i + 1 >= text.length || /\s/.test(text[i + 1])) {
                while (i + 1 < text.length && /\s/.test(text[i + 1])) {
                    current += text[++i];
                }
                segments.push(current);
                current = '';
            }
        }

        if (current) segments.push(current);
        return segments.length > 0 ? segments : [text];
    }

    // ---- Block-aware batching ----------------------------------------------

    /**
     * Rough token estimate for budgeting. ~4 chars/token is a decent proxy for
     * Latin text and is deliberately conservative for CJK (over-counts, so
     * batches stay small enough), which keeps single requests from overflowing
     * the model context.
     * @param {string} text
     * @returns {number}
     */
    function estimateTokens(text) {
        if (!text) return 0;
        return Math.ceil(text.length / 4) + 1;
    }

    /**
     * Group text descriptors into translation batches. Items sharing a block are
     * kept adjacent (and in a single request when they fit) so the model sees a
     * coherent passage; small blocks are packed together up to the item/token
     * budget to avoid a request-per-paragraph slowdown; a block larger than one
     * batch is spilled across dedicated consecutive batches. Input order (which
     * the caller sorts by priority) is preserved.
     * @param {TextItem[]} descriptors
     * @param {{maxItems?:number, maxTokens?:number}} [options]
     * @returns {TextItem[][]} batches
     */
    function groupTextNodesIntoBatches(descriptors, options = {}) {
        const maxItems = Math.max(1, options.maxItems || 8);
        const maxTokens = Math.max(1, options.maxTokens || 2000);

        // Collect items grouped by block, in first-seen (priority) order.
        const order = [];
        const byBlock = new Map();
        let anon = 0;
        for (const d of descriptors || []) {
            const key = (d.blockId === undefined || d.blockId === null)
                ? (' anon' + (anon++))
                : d.blockId;
            if (!byBlock.has(key)) { byBlock.set(key, []); order.push(key); }
            byBlock.get(key).push(d);
        }

        const batches = [];
        let batch = [];
        let tokens = 0;
        const fits = (n, t) => (batch.length + n <= maxItems) && (tokens + t <= maxTokens);
        const flush = () => { if (batch.length) { batches.push(batch); batch = []; tokens = 0; } };

        for (const key of order) {
            const items = byBlock.get(key);
            const blockTokens = items.reduce((s, it) => s + estimateTokens(it.text), 0);

            // Whole block fits in one batch → keep it together as a passage.
            if (items.length <= maxItems && blockTokens <= maxTokens) {
                if (!fits(items.length, blockTokens)) flush();
                batch.push(...items);
                tokens += blockTokens;
                continue;
            }

            // Oversize block: isolate it and spill greedily across batches.
            flush();
            for (const it of items) {
                const t = estimateTokens(it.text);
                if (batch.length && !fits(1, t)) flush();
                batch.push(it);
                tokens += t;
            }
            flush();
        }
        flush();
        return batches;
    }

    // ---- Exports ------------------------------------------------------------

    const api = {
        normalizeLangCode,
        detectLanguageByScript,
        detectSourceLanguage,
        resolveSourceLanguage,
        formatTextsForPrompt,
        buildPrompt,
        cleanTranslationText,
        isSuspiciousTranslation,
        extractJsonObject,
        parseTranslationResponse,
        splitIntoSentences,
        estimateTokens,
        groupTextNodesIntoBatches,
    };

    const g = (typeof self !== 'undefined') ? self
        : (typeof globalThis !== 'undefined') ? globalThis : this;
    Object.assign(g, api);

    if (typeof module !== 'undefined' && module.exports) {
        module.exports = api;
    }
})();
