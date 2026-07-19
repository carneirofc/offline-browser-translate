/**
 * Content Script for Local LLM Translate
 * Handles DOM text extraction, replacement, and auto-translation of new content
 */

// Use browser API with chrome fallback
const browserAPI = typeof browser !== 'undefined' ? browser : chrome;

// Prevent duplicate injection
if (window.hasLLMTranslatorContentScript) {
    console.log('[Translator] Content script already injected, skipping initialization');
    // If we're re-injecting, we might want to ensure the listener returns true to keep the channel open if needed,
    // but usually we just want to stop re-execution.
    throw new Error('Content script already injected'); // Determines this execution stop
}
window.hasLLMTranslatorContentScript = true;

let debugEnabled = false;
/** Log to console.log only when debug mode is enabled. */
function debugLog(...args) { if (debugEnabled) console.log(...args); }
/** Log to console.warn only when debug mode is enabled. */
function debugWarn(...args) { if (debugEnabled) console.warn(...args); }

let floatingButtonEnabled = false;

browserAPI.runtime.sendMessage({ type: 'GET_SETTINGS' }).then(r => {
    if (r?.settings) {
        debugEnabled = !!r.settings.debug;
        if (r.settings.targetLanguage) currentTargetLanguage = r.settings.targetLanguage;
        floatingButtonEnabled = !!r.settings.floatingButton;
        if (Number.isInteger(r.settings.maxItemsPerBatch)) maxItemsPerBatch = r.settings.maxItemsPerBatch;
        if (Number.isInteger(r.settings.maxTokensPerBatch)) maxTokensPerBatch = r.settings.maxTokensPerBatch;
        if (typeof r.settings.sourceLanguage === 'string') sourceLanguageSetting = r.settings.sourceLanguage;
        hoverEnabled = !!r.settings.hoverEnabled;
        if (typeof r.settings.hoverModifier === 'string') hoverModifier = r.settings.hoverModifier;
        applyHoverState();
    }
}).catch(() => {});

// Keep currentTargetLanguage in sync when user changes settings in popup/options
browserAPI.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || !changes.settings) return;
    const newSettings = changes.settings.newValue;
    const newLang = newSettings?.targetLanguage;
    if (newLang && newLang !== currentTargetLanguage) {
        currentTargetLanguage = newLang;
        updateFloatingBtnTitle();
    }
    if (typeof newSettings?.floatingButton === 'boolean') {
        floatingButtonEnabled = newSettings.floatingButton;
        if (!floatingButtonEnabled) hideFloatingBtn();
    }
    if (Number.isInteger(newSettings?.maxItemsPerBatch)) maxItemsPerBatch = newSettings.maxItemsPerBatch;
    if (Number.isInteger(newSettings?.maxTokensPerBatch)) maxTokensPerBatch = newSettings.maxTokensPerBatch;
    if (typeof newSettings?.sourceLanguage === 'string') sourceLanguageSetting = newSettings.sourceLanguage;
    if (typeof newSettings?.hoverModifier === 'string') hoverModifier = newSettings.hoverModifier;
    if (typeof newSettings?.hoverEnabled === 'boolean') {
        hoverEnabled = newSettings.hoverEnabled;
        applyHoverState();
    }
});

// Track text nodes and their segments
const textNodeMap = new Map(); // Maps nodeId -> { node, originalText, segments: [...] }
const segmentToNodeIdMap = new Map(); // Maps segmentId -> nodeId
const translatedNodeSet = new Set(); // Track which nodes have been translated
let translationInProgress = false;
let translationCancelled = false;  // Flag to cancel ongoing translation
let nextNodeId = 0;
let nextSegmentId = 0;
let currentTargetLanguage = 'en';
let maxConcurrentRequests = 4; // Default parallel requests (LMStudio 0.4.0+ supports up to 4)
let maxItemsPerBatch = 8;      // Max text segments per translation request (block-aware batching)
let maxTokensPerBatch = 2000;  // Token budget per translation request
let sourceLanguageSetting = 'auto'; // User's source-language setting ('auto' = detect)
let hoverEnabled = false;           // Hover-to-translate opt-in (issue #6)
let hoverModifier = 'Alt';          // Modifier gating hover translation
let autoTranslateEnabled = false;
let showGlow = false; // Setting for glow effect (disabled by default)
let mutationObserver = null;
let pendingNewNodes = [];
let autoTranslateDebounceTimer = null;

// Translation state for toggle functionality
let hasTranslationCache = false; // True if we have cached translations
let isShowingTranslations = false; // True if currently showing translations

// Queue of pending text items to translate (with dynamic priority)
let pendingTranslationQueue = [];
let scrollDebounceTimer = null;

// Elements to skip
const SKIP_TAGS = new Set([
    'SCRIPT', 'STYLE', 'NOSCRIPT', 'IFRAME', 'OBJECT', 'EMBED',
    'SVG', 'CANVAS', 'VIDEO', 'AUDIO', 'CODE', 'PRE', 'KBD',
    'INPUT', 'TEXTAREA', 'SELECT', 'BUTTON'
]);

// Minimum text length to consider for translation
const MIN_TEXT_LENGTH = 2;

/**
 * Check if an element should be skipped
 */
function shouldSkipElement(element) {
    if (!element || !element.tagName) return true;
    if (element.isContentEditable) return true;

    // Check element and ancestors for SKIP_TAGS, translate="no", or our extension elements
    let curr = element;
    while (curr) {
        if (curr.tagName && SKIP_TAGS.has(curr.tagName)) {
            return true;
        }
        if (curr.getAttribute && curr.getAttribute('translate') === 'no') {
            return true;
        }
        if (curr.id === 'llm-translator-status' || curr.id === 'llm-translator-float-btn') {
            return true;
        }
        curr = curr.parentElement;
    }
    
    return false;
}

/**
 * Check if text is worth translating
 */
function isTranslatableText(text) {
    if (!text) return false;
    // Trim and check minimum length
    const trimmed = text.trim();
    if (trimmed.length < MIN_TEXT_LENGTH) return false;
    // Skip if it's only whitespace, numbers, or punctuation
    // Use Unicode-aware check - look for any letter character
    const hasLetters = /\p{L}/u.test(trimmed);
    return hasLetters;
}

// splitIntoSentences now lives in translation-core.js (a pure helper shared with
// the background worker and unit-tested under Vitest). translation-core.js is
// always injected immediately before content.js, so it is available as a global.

/**
 * Check if a text node has already been processed
 */
function isNodeProcessed(node) {
    return translatedNodeSet.has(node);
}

/**
 * Calculate priority score for a text node (higher = more important, translate first)
 * Factors: viewport visibility, semantic context (main vs sidebar), parent tag type.
 */
const TAG_PRIORITY = {
    P: 80, H1: 70, H2: 60, H3: 50, H4: 40, H5: 40, H6: 40,
    LI: 30, BLOCKQUOTE: 25, FIGCAPTION: 25, TD: 20, TH: 20,
    SPAN: 5, DIV: 5, A: -10, LABEL: -30, BUTTON: -50
};

/** Calculate priority score for a text node based on viewport visibility and parent tag. */
function calculatePriority(node) {
    const parent = node.parentElement;
    if (!parent) return 0;

    let priority = 0;
    const rect = parent.getBoundingClientRect();

    // Viewport visibility (dominant factor)
    if (rect.top < window.innerHeight && rect.bottom > 0 &&
        rect.left < window.innerWidth && rect.right > 0) {
        priority += 1000;
    }

    // Semantic context via closest() — main content vs sidebar/nav
    if (parent.closest('main, article, [role="main"], [role="article"]')) {
        priority += 500;
    } else if (parent.closest('nav, aside, footer, header, [role="navigation"], [role="complementary"]')) {
        priority -= 300;
    }

    // Tag type
    priority += TAG_PRIORITY[parent.tagName] || 0;

    return Math.max(0, priority);
}

// Block-level container tags. Text nodes under the same nearest block ancestor
// belong to one on-page passage and are batched together (issue #5).
const BLOCK_TAGS = new Set([
    'P', 'DIV', 'LI', 'TD', 'TH', 'BLOCKQUOTE', 'FIGCAPTION', 'DD', 'DT',
    'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'SECTION', 'ARTICLE', 'ASIDE',
    'HEADER', 'FOOTER', 'MAIN', 'PRE', 'CAPTION', 'SUMMARY', 'DETAILS'
]);

// Per-extraction map of block element -> stable numeric block id. Reset by
// extractTextNodes so ids are contiguous within a translation run.
const blockElementIds = new Map();
let nextBlockId = 0;

/**
 * Climb from an element to its nearest block-level ancestor (inclusive). Returns
 * the block element, `document.body` if the walk reaches it without a match, or
 * null for a null start. Shared by block batching and hover translation.
 * @param {Element|null} startEl
 * @returns {Element|null}
 */
function climbToBlockElement(startEl) {
    let el = startEl;
    while (el && el !== document.body && el.nodeType === Node.ELEMENT_NODE && !BLOCK_TAGS.has(el.tagName)) {
        el = el.parentElement;
    }
    return el;
}

/**
 * Resolve the numeric id of the nearest block-level ancestor of a text node, so
 * segments in the same paragraph/list-item/cell share a block id for batching.
 * @param {Node} node a text node
 * @returns {number} stable block id for this run
 */
function getBlockId(node) {
    const el = climbToBlockElement(node.parentElement);
    const key = el || node.parentElement || document.body;
    let id = blockElementIds.get(key);
    if (id === undefined) {
        id = nextBlockId++;
        blockElementIds.set(key, id);
    }
    return id;
}

/**
 * Register a text node: split into segments, add to maps, return text items for translation.
 */
function registerTextNode(node) {
    const nodeId = nextNodeId++;
    const priority = calculatePriority(node);
    const blockId = getBlockId(node);
    const originalText = node.textContent;
    const segments = [];
    const textItems = [];

    const rawSegments = originalText.length > 200
        ? splitIntoSentences(originalText) : [originalText];

    for (const rawSeg of rawSegments) {
        if (isTranslatableText(rawSeg)) {
            const segmentId = nextSegmentId++;
            segmentToNodeIdMap.set(segmentId, nodeId);
            segments.push({
                id: segmentId, originalText: rawSeg,
                translatedText: null, processedTranslatedText: null, translated: false
            });
            textItems.push({ id: segmentId, text: rawSeg.trim(), priority, blockId });
        } else {
            segments.push({
                id: null, originalText: rawSeg,
                translatedText: null, processedTranslatedText: null, translated: false
            });
        }
    }

    textNodeMap.set(nodeId, { node, originalText, segments });
    translatedNodeSet.add(node);
    return textItems;
}

/**
 * Extract visible text nodes from the page (or from a specific root)
 */
function extractTextNodes(root = document.body, onlyNew = false) {
    if (!onlyNew) {
        textNodeMap.clear();
        segmentToNodeIdMap.clear();
        translatedNodeSet.clear();
        blockElementIds.clear();
        nextNodeId = 0;
        nextSegmentId = 0;
        nextBlockId = 0;
    }

    const walker = document.createTreeWalker(
        root,
        NodeFilter.SHOW_TEXT,
        {
            acceptNode: (node) => {
                // Skip if already processed
                if (onlyNew && isNodeProcessed(node)) {
                    return NodeFilter.FILTER_REJECT;
                }
                const parent = node.parentElement;
                if (!parent || shouldSkipElement(parent)) {
                    return NodeFilter.FILTER_REJECT;
                }
                if (!isTranslatableText(node.textContent)) {
                    return NodeFilter.FILTER_REJECT;
                }
                const style = window.getComputedStyle(parent);
                if (style.display === 'none' || style.visibility === 'hidden') {
                    return NodeFilter.FILTER_REJECT;
                }
                return NodeFilter.FILTER_ACCEPT;
            }
        }
    );

    const textItems = [];
    let node;
    while (node = walker.nextNode()) {
        textItems.push(...registerTextNode(node));
    }

    // Sort by priority (highest first) - visible headings get translated first
    textItems.sort((a, b) => b.priority - a.priority);

    return textItems;
}

/**
 * Extract text nodes from newly added elements
 */
function extractNewTextNodes(addedNodes) {
    const textItems = [];

    for (const node of addedNodes) {
        if (node.nodeType === Node.TEXT_NODE) {
            if (!isNodeProcessed(node) && isTranslatableText(node.textContent)) {
                const parent = node.parentElement;
                if (parent && !shouldSkipElement(parent)) {
                    textItems.push(...registerTextNode(node));
                }
            }
        } else if (node.nodeType === Node.ELEMENT_NODE) {
            // Extract text nodes from the added element (already sorted)
            const items = extractTextNodes(node, true);
            textItems.push(...items);
        }
    }

    // Sort by priority (highest first)
    textItems.sort((a, b) => b.priority - a.priority);

    return textItems;
}

/** Extract translatable text nodes contained within the current user selection. */
function extractSelectionTextNodes(selection) {
    const textItems = [];
    const seenNodes = new Set();

    for (let i = 0; i < selection.rangeCount; i++) {
        const range = selection.getRangeAt(i);
        const ancestor = range.commonAncestorContainer;
        const root = ancestor.nodeType === Node.TEXT_NODE ? ancestor.parentElement : ancestor;
        if (!root) continue;

        const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
            acceptNode: (node) => {
                if (seenNodes.has(node)) return NodeFilter.FILTER_REJECT;
                if (!range.intersectsNode(node)) return NodeFilter.FILTER_REJECT;
                const parent = node.parentElement;
                if (!parent || shouldSkipElement(parent)) return NodeFilter.FILTER_REJECT;
                if (!isTranslatableText(node.textContent)) return NodeFilter.FILTER_REJECT;
                const style = window.getComputedStyle(parent);
                if (style.display === 'none' || style.visibility === 'hidden') return NodeFilter.FILTER_REJECT;
                return NodeFilter.FILTER_ACCEPT;
            }
        });

        let node;
        while (node = walker.nextNode()) {
            seenNodes.add(node);
            
            // Reuse existing entry if this node was already registered
            let existingNodeId = null;
            let existingEntry = null;
            for (const [nodeId, entry] of textNodeMap) {
                if (entry.node === node) {
                    existingNodeId = nodeId;
                    existingEntry = entry;
                    break;
                }
            }

            const priority = calculatePriority(node);
            if (existingEntry !== null) {
                // Node already registered, extract its translatable segments
                const blockId = getBlockId(node);
                for (const seg of existingEntry.segments) {
                    if (seg.id !== null) {
                        textItems.push({
                            id: seg.id,
                            text: seg.originalText.trim(),
                            priority,
                            blockId
                        });
                    }
                }
            } else {
                // New node, register it
                textItems.push(...registerTextNode(node));
            }
        }
    }

    textItems.sort((a, b) => b.priority - a.priority);
    return textItems;
}

/**
 * Opens a runtime.connect port that keeps the background service worker alive
 * during long translation requests (Firefox MV3 terminates idle service workers).
 */
function startKeepAlive() {
    let port = null;
    let interval = null;
    try {
        port = browserAPI.runtime.connect({ name: 'keepalive' });
        port.onDisconnect.addListener(() => {
            port = null;
            if (interval) { clearInterval(interval); interval = null; }
        });
        interval = setInterval(() => {
            if (port) {
                try { port.postMessage({ type: 'ping' }); }
                catch (e) { clearInterval(interval); interval = null; }
            }
        }, 20000);
    } catch (e) {
        console.warn('[Translator] Could not open keep-alive port:', e.message);
    }
    return function stopKeepAlive() {
        if (interval) clearInterval(interval);
        if (port) { try { port.disconnect(); } catch (e) {} }
    };
}

/**
 * Replace text node content with translation
 */
function replaceTextNode(segmentId, translatedText) {
    const nodeId = segmentToNodeIdMap.get(segmentId);
    if (nodeId === undefined) {
        console.warn(`[Translator] Segment ID ${segmentId} not found in lookup map`);
        return false;
    }

    const entry = textNodeMap.get(nodeId);
    if (!entry) {
        console.warn(`[Translator] Node ID ${nodeId} not found in map`);
        return false;
    }

    const { node, originalText, segments } = entry;
    const segment = segments.find(s => s.id === segmentId);
    if (!segment) {
        console.warn(`[Translator] Segment ${segmentId} not found in node ${nodeId}`);
        return false;
    }

    try {
        const segOriginalText = segment.originalText;
        const leadingSpace = segOriginalText.match(/^\s*/)[0];
        const trailingSpace = segOriginalText.match(/\s*$/)[0];

        // Trim LLM's response to get pure text content first, so we don't end up with doubled spaces
        const trimmedTranslation = (translatedText || '').trim();

        // For spaceless languages (Japanese, Chinese, etc.), add spacing when translating
        // to spaced languages if there was no original spacing
        let effectiveTrailingSpace = trailingSpace;
        if (!effectiveTrailingSpace && trimmedTranslation) {
            // Check if original text looks like a spaceless language (contains CJK characters)
            const hasCJK = /[\u3000-\u9fff\uff00-\uffef]/.test(segOriginalText);
            if (hasCJK) {
                // Always add trailing space for CJK source
                effectiveTrailingSpace = ' ';
            }
        }

        const processedText = leadingSpace + trimmedTranslation + effectiveTrailingSpace;
        segment.translatedText = translatedText;
        segment.processedTranslatedText = processedText;
        segment.translated = true;

        // Reconstruct full node text
        const joinedText = segments.map(s => s.translated && s.processedTranslatedText !== null ? s.processedTranslatedText : s.originalText).join('');
        node.textContent = joinedText;

        // Add blue glow effect to parent element (if enabled)
        const parent = node.parentElement;
        if (parent) {
            if (showGlow) {
                parent.style.textShadow = '0 0 8px #7FBBB3, 0 0 2px #7FBBB3';
            }
            parent.dataset.translated = 'true';
        }

        translatedNodeSet.add(node);
        debugLog(`[Translator] Replaced segment ${segmentId} in node ${nodeId}: "${segOriginalText}" -> "${processedText}"`);
        return true;
    } catch (e) {
        console.error(`[Translator] Failed to replace segment ${segmentId} in node ${nodeId}:`, e);
        return false;
    }
}

/**
 * Restore original text for all translated nodes
 */
function restoreOriginalText() {
    for (const [nodeId, entry] of textNodeMap) {
        let hasAnyTranslated = entry.segments.some(s => s.translated);
        if (hasAnyTranslated) {
            try {
                entry.node.textContent = entry.originalText;
                translatedNodeSet.delete(entry.node);
            } catch (e) {
                // Node may have been removed
            }
        }
    }
    isShowingTranslations = false;
    // Stop auto-translate when restoring
    stopAutoTranslate();
}

/**
 * Restore cached translations (toggle back to translated view)
 */
function restoreCachedTranslations() {
    if (!hasTranslationCache) return false;

    let restoredCount = 0;
    for (const [nodeId, entry] of textNodeMap) {
        let hasAnyTranslated = entry.segments.some(s => s.translated && s.processedTranslatedText !== null);
        if (hasAnyTranslated) {
            try {
                const joinedText = entry.segments.map(s => s.translated && s.processedTranslatedText !== null ? s.processedTranslatedText : s.originalText).join('');
                entry.node.textContent = joinedText;
                translatedNodeSet.add(entry.node);
                restoredCount++;
            } catch (e) {
                // Node may have been removed
            }
        }
    }
    isShowingTranslations = true;
    return restoredCount > 0;
}

/**
 * Show translation status indicator
 */
function showStatus(message, isError = false) {
    let statusEl = document.getElementById('llm-translator-status');

    if (!statusEl) {
        statusEl = document.createElement('div');
        statusEl.id = 'llm-translator-status';
        statusEl.setAttribute('translate', 'no');
        statusEl.style.cssText = `
      position: fixed;
      bottom: 20px;
      right: 20px;
      padding: 12px 20px;
      border-radius: 8px;
      font-family: system-ui, -apple-system, sans-serif;
      font-size: 14px;
      z-index: 999999;
      box-shadow: 0 4px 12px rgba(0,0,0,0.15);
      transition: opacity 0.3s, transform 0.3s;
    `;
        document.body.appendChild(statusEl);
    }

    statusEl.style.backgroundColor = isError ? '#E67E80' : '#A7C080';
    statusEl.style.color = '#1E2326';
    statusEl.textContent = message;
    statusEl.style.opacity = '1';
    statusEl.style.transform = 'translateY(0)';
}

/**
 * Hide status indicator
 */
function hideStatus() {
    const statusEl = document.getElementById('llm-translator-status');
    if (statusEl) {
        statusEl.style.opacity = '0';
        statusEl.style.transform = 'translateY(20px)';
        setTimeout(() => statusEl.remove(), 300);
    }
}

// ============================================================================
// Image describe & interpret overlay (centered modal)
// ============================================================================
// A CSP-safe modal: built from DOM nodes with inline styles inside a shadow root
// (no external assets, no injected <style>/keyframes), so it works on pages with
// strict CSP and is isolated from page CSS. The spinner is rotated from JS to
// avoid relying on CSS keyframes (which a page's style-src could block).

let describeModalHost = null;
let describeBodyEl = null;
let describeCopyBtn = null;
let describeSpinnerTimer = null;
let describeKeyHandler = null;

/** Close the image describe modal, clearing its timer, key handler, and DOM references. */
function closeDescribeModal() {
    if (describeSpinnerTimer) { clearInterval(describeSpinnerTimer); describeSpinnerTimer = null; }
    if (describeKeyHandler) { document.removeEventListener('keydown', describeKeyHandler, true); describeKeyHandler = null; }
    if (describeModalHost) { describeModalHost.remove(); describeModalHost = null; }
    describeBodyEl = null;
    describeCopyBtn = null;
}

/**
 * Build (or rebuild) the empty modal shell and store references to its body and
 * copy button. Returns nothing — callers fill describeBodyEl.
 */
function ensureDescribeModal() {
    closeDescribeModal();

    const host = document.createElement('div');
    host.id = 'llm-translator-describe-host';
    host.setAttribute('translate', 'no');
    const shadow = host.attachShadow({ mode: 'open' });

    const backdrop = document.createElement('div');
    backdrop.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.5);z-index:2147483647;display:flex;align-items:center;justify-content:center;';

    const card = document.createElement('div');
    card.style.cssText = 'box-sizing:border-box;background:#2b3339;color:#d3c6aa;font-family:system-ui,-apple-system,sans-serif;font-size:15px;line-height:1.55;max-width:560px;width:calc(100% - 40px);max-height:80vh;border-radius:12px;box-shadow:0 12px 40px rgba(0,0,0,0.45);display:flex;flex-direction:column;overflow:hidden;';

    const header = document.createElement('div');
    header.style.cssText = 'display:flex;align-items:center;justify-content:space-between;padding:14px 18px;border-bottom:1px solid rgba(255,255,255,0.08);';
    const titleEl = document.createElement('div');
    titleEl.textContent = 'Image description';
    titleEl.style.cssText = 'font-weight:600;font-size:15px;';
    const closeBtn = document.createElement('button');
    closeBtn.textContent = '✕';
    closeBtn.setAttribute('aria-label', 'Close');
    closeBtn.style.cssText = 'background:none;border:none;color:#d3c6aa;font-size:18px;cursor:pointer;padding:4px 8px;line-height:1;';
    closeBtn.addEventListener('click', closeDescribeModal);
    header.appendChild(titleEl);
    header.appendChild(closeBtn);

    const bodyEl = document.createElement('div');
    bodyEl.style.cssText = 'padding:18px;overflow-y:auto;white-space:pre-wrap;word-break:break-word;';

    const footer = document.createElement('div');
    footer.style.cssText = 'display:flex;justify-content:flex-end;gap:8px;padding:12px 18px;border-top:1px solid rgba(255,255,255,0.08);';
    const copyBtn = document.createElement('button');
    copyBtn.textContent = 'Copy';
    copyBtn.style.cssText = 'background:#a7c080;color:#2b3339;border:none;border-radius:6px;padding:8px 16px;font-size:14px;font-weight:600;cursor:pointer;';
    copyBtn.disabled = true;
    copyBtn.style.opacity = '0.5';
    copyBtn.addEventListener('click', async () => {
        const text = describeBodyEl ? describeBodyEl.textContent : '';
        const flash = () => { copyBtn.textContent = 'Copied'; setTimeout(() => { copyBtn.textContent = 'Copy'; }, 1500); };
        try {
            await navigator.clipboard.writeText(text);
            flash();
        } catch (e) {
            // Fallback for pages/contexts where the async clipboard API is blocked.
            const ta = document.createElement('textarea');
            ta.value = text;
            ta.style.cssText = 'position:fixed;top:0;left:0;opacity:0;';
            document.body.appendChild(ta);
            ta.select();
            try { document.execCommand('copy'); flash(); } catch (e2) { /* give up silently */ }
            ta.remove();
        }
    });
    footer.appendChild(copyBtn);

    card.appendChild(header);
    card.appendChild(bodyEl);
    card.appendChild(footer);
    backdrop.appendChild(card);
    shadow.appendChild(backdrop);
    document.body.appendChild(host);

    backdrop.addEventListener('click', (e) => { if (e.target === backdrop) closeDescribeModal(); });
    describeKeyHandler = (e) => { if (e.key === 'Escape') { e.stopPropagation(); closeDescribeModal(); } };
    document.addEventListener('keydown', describeKeyHandler, true);

    describeModalHost = host;
    describeBodyEl = bodyEl;
    describeCopyBtn = copyBtn;
}

/** Show the describe modal with a loading spinner while the image analysis request is in flight. */
function showDescribeLoading() {
    ensureDescribeModal();

    const wrap = document.createElement('div');
    wrap.style.cssText = 'display:flex;align-items:center;gap:12px;';
    const spinner = document.createElement('div');
    spinner.style.cssText = 'box-sizing:border-box;width:20px;height:20px;border:3px solid rgba(211,198,170,0.3);border-top-color:#a7c080;border-radius:50%;';
    const label = document.createElement('span');
    label.textContent = 'Analyzing image…';
    wrap.appendChild(spinner);
    wrap.appendChild(label);
    describeBodyEl.appendChild(wrap);

    let deg = 0;
    describeSpinnerTimer = setInterval(() => {
        deg = (deg + 30) % 360;
        spinner.style.transform = `rotate(${deg}deg)`;
    }, 80);
}

/** Display the resulting image description text in the modal and enable the copy button. */
function showDescribeResult(text) {
    // The user may have closed the modal while the request was in flight.
    if (!describeModalHost || !describeBodyEl) return;
    if (describeSpinnerTimer) { clearInterval(describeSpinnerTimer); describeSpinnerTimer = null; }
    describeBodyEl.textContent = text || '';
    if (describeCopyBtn) {
        describeCopyBtn.disabled = false;
        describeCopyBtn.style.opacity = '1';
    }
}

/** Display an error message in the describe modal in place of a result. */
function showDescribeError(errorMessage) {
    if (!describeModalHost || !describeBodyEl) return;
    if (describeSpinnerTimer) { clearInterval(describeSpinnerTimer); describeSpinnerTimer = null; }
    describeBodyEl.textContent = errorMessage || 'Something went wrong.';
    describeBodyEl.style.color = '#e67e80';
}

// ============================================================================
// Hover-to-translate (issue #6)
// ============================================================================
// Hold a configurable modifier and hover a paragraph to see its translation in
// a floating bubble. Non-destructive (the page DOM is never modified), gated by
// the modifier (no requests fire otherwise), and it reuses the same background
// TRANSLATE pipeline + cache as full-page translation, so repeat hovers are
// instant.

const HOVER_MODIFIER_PROP = { Alt: 'altKey', Control: 'ctrlKey', Shift: 'shiftKey', Meta: 'metaKey' };
let hoverBubbleHost = null;
let hoverBubbleBody = null;
let hoverDebounceTimer = null;
let hoverBlockEl = null;
let hoverReqToken = 0;
let hoverListenersOn = false;

/**
 * @param {MouseEvent} e
 * @returns {boolean} whether the configured hover modifier is held.
 */
function isHoverModifierHeld(e) {
    const prop = HOVER_MODIFIER_PROP[hoverModifier] || 'altKey';
    return !!e[prop];
}

/** Lazily build the shadow-DOM bubble used to render hover translations. */
function ensureHoverBubble() {
    if (hoverBubbleHost) return;
    hoverBubbleHost = document.createElement('div');
    hoverBubbleHost.setAttribute('data-llm-translator-hover', '');
    hoverBubbleHost.style.cssText = 'all:initial; position:fixed; z-index:2147483646; display:none;';
    const shadow = hoverBubbleHost.attachShadow({ mode: 'open' });
    const style = document.createElement('style');
    style.textContent = `
        :host { color-scheme: light dark; }
        .bubble {
            max-width: 360px; max-height: 40vh; overflow:auto;
            font: 13px/1.5 system-ui, -apple-system, sans-serif;
            background: Canvas; color: CanvasText;
            border: 1px solid color-mix(in srgb, CanvasText 25%, transparent);
            border-radius: 8px; padding: 8px 10px;
            box-shadow: 0 4px 16px rgba(0,0,0,0.25);
            white-space: pre-wrap; word-break: break-word;
        }
        .bubble.loading { opacity: 0.8; font-style: italic; }
        .bubble.error { color: #e67e80; }
    `;
    hoverBubbleBody = document.createElement('div');
    hoverBubbleBody.className = 'bubble';
    shadow.append(style, hoverBubbleBody);
    (document.documentElement || document.body).appendChild(hoverBubbleHost);
}

/**
 * Set bubble text/state.
 * @param {string} text
 * @param {boolean} [loading]
 * @param {boolean} [isError]
 */
function showHoverContent(text, loading = false, isError = false) {
    ensureHoverBubble();
    hoverBubbleBody.className = 'bubble' + (loading ? ' loading' : '') + (isError ? ' error' : '');
    hoverBubbleBody.textContent = text;
    hoverBubbleHost.style.display = 'block';
}

/**
 * Anchor the bubble just below the hovered block, flipping above / clamping to
 * the viewport when there isn't room.
 * @param {DOMRect} rect
 */
function positionHoverBubble(rect) {
    if (!hoverBubbleHost) return;
    const margin = 6;
    const bubbleRect = hoverBubbleHost.getBoundingClientRect();
    let top = rect.bottom + margin;
    if (top + bubbleRect.height > window.innerHeight && rect.top - margin - bubbleRect.height > 0) {
        top = rect.top - margin - bubbleRect.height;
    }
    top = Math.max(margin, Math.min(top, window.innerHeight - bubbleRect.height - margin));
    let left = rect.left;
    left = Math.max(margin, Math.min(left, window.innerWidth - bubbleRect.width - margin));
    hoverBubbleHost.style.top = `${top}px`;
    hoverBubbleHost.style.left = `${left}px`;
}

/** Hide the bubble and invalidate any in-flight hover request. */
function hideHoverBubble() {
    if (hoverBubbleHost) hoverBubbleHost.style.display = 'none';
    hoverBlockEl = null;
    hoverReqToken++;
}

/**
 * Nearest block-level ancestor of an event target, or null.
 * @param {EventTarget} target
 * @returns {Element|null}
 */
function getHoverBlockElement(target) {
    const el = climbToBlockElement(target);
    return (el && el !== document.body && el.nodeType === Node.ELEMENT_NODE) ? el : null;
}

/**
 * Translate the block under the cursor and show it in the bubble. Reuses the
 * background TRANSLATE pipeline (source detection + cache).
 * @param {EventTarget} target
 */
async function translateHoverTarget(target) {
    const block = getHoverBlockElement(target);
    if (!block) { hideHoverBubble(); return; }
    if (block === hoverBlockEl) return; // already showing this block
    const text = (block.innerText || '').trim().slice(0, 4000);
    if (!text || !isTranslatableText(text)) { hideHoverBubble(); return; }

    hoverBlockEl = block;
    const token = ++hoverReqToken;
    showHoverContent('Translating…', true);
    positionHoverBubble(block.getBoundingClientRect());

    try {
        const resolved = resolveSourceLanguage(sourceLanguageSetting, text, getDeclaredPageLanguage());
        const resp = await browserAPI.runtime.sendMessage({
            type: 'TRANSLATE',
            texts: [{ id: 0, text }],
            targetLanguage: currentTargetLanguage,
            sourceLanguage: resolved
        });
        if (token !== hoverReqToken) return; // superseded by a newer hover
        if (!resp || resp.error) {
            showHoverContent(`Translation failed: ${resp?.error || 'no response from background'}`, false, true);
            return;
        }
        const translated = resp.translations?.[0]?.text;
        if (!translated) {
            showHoverContent('No translation returned.', false, true);
            return;
        }
        showHoverContent(translated, false);
        positionHoverBubble(block.getBoundingClientRect());
    } catch (err) {
        if (token === hoverReqToken) showHoverContent(`Translation failed: ${err.message}`, false, true);
    }
}

/** Modifier-gated, debounced hover handler. Fires nothing without the modifier. */
function onHoverMove(e) {
    if (!hoverEnabled) return;
    if (!isHoverModifierHeld(e)) {
        if (hoverBubbleHost && hoverBubbleHost.style.display !== 'none') hideHoverBubble();
        return;
    }
    // Never react to hovering our own bubble.
    if (hoverBubbleHost && typeof e.composedPath === 'function' && e.composedPath().includes(hoverBubbleHost)) return;
    // Mouse-out: moved off any block into empty space — dismiss promptly.
    if (!getHoverBlockElement(e.target)) {
        if (hoverDebounceTimer) clearTimeout(hoverDebounceTimer);
        hideHoverBubble();
        return;
    }
    if (hoverDebounceTimer) clearTimeout(hoverDebounceTimer);
    const target = e.target;
    hoverDebounceTimer = setTimeout(() => translateHoverTarget(target), 180);
}

/** @param {KeyboardEvent} e */
function onHoverKey(e) {
    if (e.key === 'Escape') hideHoverBubble();
}

/**
 * Dismiss the bubble when the pointer leaves the document/window entirely
 * (pointermove stops firing, so the mouse-out check in onHoverMove can't).
 * @param {MouseEvent} e
 */
function onHoverLeave(e) {
    if (!e.relatedTarget && !e.toElement) hideHoverBubble();
}

/** Attach/detach hover listeners to match the current hoverEnabled setting. */
function applyHoverState() {
    if (hoverEnabled && !hoverListenersOn) {
        document.addEventListener('pointermove', onHoverMove, true);
        document.addEventListener('keydown', onHoverKey, true);
        document.addEventListener('mouseout', onHoverLeave, true);
        window.addEventListener('scroll', hideHoverBubble, true);
        hoverListenersOn = true;
    } else if (!hoverEnabled && hoverListenersOn) {
        document.removeEventListener('pointermove', onHoverMove, true);
        document.removeEventListener('keydown', onHoverKey, true);
        document.removeEventListener('mouseout', onHoverLeave, true);
        window.removeEventListener('scroll', hideHoverBubble, true);
        if (hoverDebounceTimer) clearTimeout(hoverDebounceTimer);
        hideHoverBubble();
        hoverListenersOn = false;
    }
}

/**
 * Detect page source language from HTML lang attribute
 * Returns base language code (e.g., "en" from "en-US")
 */
// Returns the page's explicitly declared language code, or null when the page
// declares none. Kept separate from getPageLanguage() so callers that need to
// reason about "unknown" (e.g. the floating button) aren't fooled by a default.
function getDeclaredPageLanguage() {
    const htmlLang = document.documentElement.lang || document.querySelector('html')?.getAttribute('lang');
    if (htmlLang) {
        // Extract base language code (e.g., "en" from "en-US")
        return htmlLang.split('-')[0].toLowerCase();
    }
    // Fallback: try meta tag
    const metaLang = document.querySelector('meta[http-equiv="content-language"]')?.getAttribute('content');
    if (metaLang) {
        return metaLang.split('-')[0].toLowerCase();
    }
    return null; // No declared language
}

/** Get the page's source language, defaulting to "en" when none is declared. */
function getPageLanguage() {
    return getDeclaredPageLanguage() || 'en'; // Default fallback for translation source
}

/**
 * Translate a batch of text items with retry logic
 * Returns { applied: number, failed: Array } 
 */
async function translateBatch(textItems, targetLanguage, sourceLanguage = 'auto', retries = 3) {
    if (textItems.length === 0) return { applied: 0, failed: [] };

    debugLog(`[Translator] translateBatch called for ${textItems.length} items:`, textItems);

    // Use the caller's resolved source language when concrete; otherwise resolve
    // it here from the page's declared language and script analysis of the batch.
    const sample = textItems.map(i => i.text).join('\n').slice(0, 4000);
    const pageLanguage = (sourceLanguage && sourceLanguage !== 'auto')
        ? sourceLanguage
        : resolveSourceLanguage('auto', sample, getDeclaredPageLanguage());

    let lastError = null;
    for (let attempt = 0; attempt < retries; attempt++) {
        try {
            if (attempt > 0) {
                debugLog(`[Translator] Retrying batch, attempt ${attempt + 1}/${retries}`);
            }
            const response = await browserAPI.runtime.sendMessage({
                type: 'TRANSLATE',
                texts: textItems,
                targetLanguage,
                sourceLanguage: pageLanguage // Pass detected page language for TranslateGemma
            });

            debugLog(`[Translator] translateBatch response:`, response);

            // sendMessage resolves undefined if the background worker was asleep
            // or a handler returned without responding — treat as retryable.
            if (!response) {
                throw new Error('No response from background (worker asleep?)');
            }
            if (response.error) {
                throw new Error(response.error);
            }

            const { translations } = response;
            debugLog(`[Translator] Got ${translations?.length} translations back for ${textItems.length} items`);

            let applied = 0;
            const failed = [];
            const receivedIds = new Set();

            // Process received translations
            for (const t of (translations || [])) {
                receivedIds.add(t.id);
                if (!t.error && t.text) {
                    if (replaceTextNode(t.id, t.text)) {
                        applied++;
                    } else {
                        // Node replacement failed
                        const original = textItems.find(item => item.id === t.id);
                        if (original) failed.push(original);
                    }
                } else if (t.error) {
                    console.warn(`[Translator] Translation error for id ${t.id}: ${t.error}`);
                    const original = textItems.find(item => item.id === t.id);
                    if (original) failed.push(original);
                }
            }

            // Check for items that weren't returned at all
            for (const item of textItems) {
                if (!receivedIds.has(item.id)) {
                    console.warn(`[Translator] Item ${item.id} was not returned by LLM`);
                    failed.push(item);
                }
            }

            if (failed.length > 0) {
                console.warn(`[Translator] ${failed.length} items failed in this batch`);
            }

            return {
                applied, failed,
                fromCache: response.fromCache || 0,
                total: (typeof response.total === 'number') ? response.total : textItems.length,
                cacheActive: !!response.cacheActive
            };

        } catch (e) {
            lastError = e;
            console.warn(`[Translator] Attempt ${attempt + 1}/${retries} failed:`, e.message);
            debugWarn(`[Translator] Batch translation failed with exception:`, e, 'on items:', textItems);

            // Wait before retry (exponential backoff)
            if (attempt < retries - 1) {
                await new Promise(r => setTimeout(r, 500 * (attempt + 1)));
            }
        }
    }

    // All retries failed - return all items as failed
    console.error(`[Translator] All retries failed for batch of ${textItems.length} items. Last error: ${lastError?.message}`);
    return { applied: 0, failed: textItems, fromCache: 0, total: textItems.length, cacheActive: false };
}


/**
 * Handle scroll event - recalculate priorities after user stops scrolling
 */
function onScroll() {
    if (scrollDebounceTimer) {
        clearTimeout(scrollDebounceTimer);
    }
    scrollDebounceTimer = setTimeout(() => {
        if (pendingTranslationQueue.length > 0) {
            recalculatePendingPriorities();
        }
    }, 100); // 100ms debounce for snappier updates
}

/**
 * Main translation function with queue and cancellation support
 */
async function translatePage(targetLanguage, sourceLanguage = 'auto', enableAutoTranslate = true) {
    if (translationInProgress) {
        showStatus('Translation already in progress...', true);
        setTimeout(hideStatus, 2000);
        return;
    }

    currentTargetLanguage = targetLanguage;
    translationInProgress = true;
    translationCancelled = false;
    showStatus('Extracting text...');

    // Add scroll listener for dynamic priority
    window.addEventListener('scroll', onScroll, { passive: true });
    const stopKeepAlive = startKeepAlive();

    try {
        const textItems = extractTextNodes();

        if (textItems.length === 0) {
            showStatus('No translatable text found', true);
            setTimeout(hideStatus, 3000);
            translationInProgress = false;
            return;
        }

        // Resolve the source language once for the whole run, from the user's
        // setting, the page's declared language, and script analysis of the text
        // itself, so a Japanese page is translated from Japanese, not English.
        const effectiveSetting = (sourceLanguage && sourceLanguage !== 'auto')
            ? sourceLanguage : sourceLanguageSetting;
        const sample = textItems.slice(0, 40).map(i => i.text).join('\n').slice(0, 4000);
        const resolvedSource = resolveSourceLanguage(effectiveSetting, sample, getDeclaredPageLanguage());
        debugLog(`[Translator] Resolved source language: ${resolvedSource} (setting=${effectiveSetting})`);

        // Group segments into block-aware batches: same-block segments stay
        // together as one passage, packed up to the configured item/token budget.
        pendingTranslationQueue = groupTextNodesIntoBatches(textItems, {
            maxItems: maxItemsPerBatch,
            maxTokens: maxTokensPerBatch
        });

        showStatus(`Found ${textItems.length} text elements. Translating...`);

        let totalApplied = 0;
        let totalProcessed = 0; // Track how many items we've attempted
        let totalFromCache = 0; // Elements served from the translation cache
        let cacheActive = false; // Whether the cache was on for this run
        const totalItems = textItems.length;
        const failedItems = []; // Track items that failed for potential retry
        let inFlightBatches = []; // Track in-flight batch promises

        // Main translation loop with parallel processing
        while ((pendingTranslationQueue.length > 0 || inFlightBatches.length > 0) && !translationCancelled) {
            // Fill up to maxConcurrentRequests parallel batches
            while (inFlightBatches.length < maxConcurrentRequests && pendingTranslationQueue.length > 0) {
                const batch = pendingTranslationQueue.shift();
                totalProcessed += batch.length;

                // Create a trackable batch object with unique ID
                const batchId = Date.now() + Math.random();
                const batchPromise = translateBatch(batch, targetLanguage, resolvedSource)
                    .then(result => ({ batchId, result, batch, success: true }))
                    .catch(error => ({ batchId, error, batch, success: false }));

                inFlightBatches.push({ batchId, promise: batchPromise });
            }

            // Cap percentage at 100%
            const percent = Math.min(100, Math.round((totalProcessed / totalItems) * 100));
            showStatus(`Translating... ${percent}%`);

            // Wait for any one batch to complete
            if (inFlightBatches.length > 0) {
                const completed = await Promise.race(inFlightBatches.map(b => b.promise));

                // Remove the completed batch from inFlightBatches by its ID
                inFlightBatches = inFlightBatches.filter(b => b.batchId !== completed.batchId);

                if (completed.success) {
                    totalApplied += completed.result.applied;
                    totalFromCache += completed.result.fromCache || 0;
                    if (completed.result.cacheActive) cacheActive = true;
                    if (completed.result.failed && completed.result.failed.length > 0) {
                        failedItems.push(...completed.result.failed);
                    }
                } else {
                    console.error('Batch error:', completed.error);
                    failedItems.push(...completed.batch);
                }
            }

            // Check cancellation between batches
            if (translationCancelled) {
                showStatus('Translation cancelled');
                setTimeout(hideStatus, 2000);
                break;
            }
        }

        if (!translationCancelled) {
            // Show completion message with stats
            const successRate = Math.round((totalApplied / totalItems) * 100);
            let statusMsg = `Translated ${totalApplied}/${totalItems} elements (${successRate}%)`;

            if (failedItems.length > 0) {
                console.warn(`[Translator] ${failedItems.length} items failed:`,
                    failedItems.slice(0, 5).map(f => f.text.substring(0, 30)));
                statusMsg += ` - ${failedItems.length} failed`;
            }

            // If the cache was active and served some entries, tell the user
            if (cacheActive && totalFromCache > 0 && totalItems > 0) {
                const cachePercent = Math.round((totalFromCache / totalItems) * 100);
                statusMsg += ` - ${cachePercent}% from cache`;
            }

            // Mark that we have cached translations for toggle
            if (totalApplied > 0) {
                hasTranslationCache = true;
                isShowingTranslations = true;
            }

            showStatus(statusMsg);

            // Start auto-translate for new content if enabled
            if (enableAutoTranslate) {
                startAutoTranslate(targetLanguage);
                setTimeout(() => {
                    showStatus(`${statusMsg}. Auto-translate ON`);
                    setTimeout(hideStatus, 4000);
                }, 1000);
            } else {
                setTimeout(hideStatus, 4000);
            }
        }

    } catch (e) {
        console.error('Translation error:', e);
        showStatus(`Error: ${e.message}`, true);
        setTimeout(hideStatus, 5000);
    } finally {
        stopKeepAlive();
        translationInProgress = false;
        translationCancelled = false;
        pendingTranslationQueue = [];
        window.removeEventListener('scroll', onScroll);
        // Let the popup know translation is done so it can reset its button
        // (e.g. when everything was served from cache and finished instantly).
        try {
            browserAPI.runtime.sendMessage({ type: 'TRANSLATION_COMPLETE' }).catch(() => {});
        } catch (e) { /* popup may be closed */ }
    }
}

/**
 * Recalculate priorities for pending items based on current viewport, then
 * reorder the pending batches so blocks now in view translate first. Batches
 * themselves stay intact (block cohesion is preserved); only their order changes.
 */
function recalculatePendingPriorities() {
    for (const batch of pendingTranslationQueue) {
        for (const item of batch) {
            const nodeId = segmentToNodeIdMap.get(item.id);
            if (nodeId !== undefined) {
                const entry = textNodeMap.get(nodeId);
                if (entry && entry.node && entry.node.parentElement) {
                    item.priority = calculatePriority(entry.node);
                }
            }
        }
    }
    // Re-sort batches by their highest-priority (most visible) member.
    const batchPriority = (batch) => batch.reduce((m, it) => Math.max(m, it.priority || 0), 0);
    pendingTranslationQueue.sort((a, b) => batchPriority(b) - batchPriority(a));
}

/**
 * Start watching for new content and auto-translate
 */
function startAutoTranslate(targetLanguage) {
    if (mutationObserver) {
        mutationObserver.disconnect();
    }

    autoTranslateEnabled = true;
    currentTargetLanguage = targetLanguage;
    pendingNewNodes = [];

    mutationObserver = new MutationObserver((mutations) => {
        if (!autoTranslateEnabled) return;

        for (const mutation of mutations) {
            if (mutation.type === 'childList') {
                for (const node of mutation.addedNodes) {
                    pendingNewNodes.push(node);
                }
            }
        }

        // Debounce: wait for DOM to settle before translating
        if (autoTranslateDebounceTimer) {
            clearTimeout(autoTranslateDebounceTimer);
        }
        autoTranslateDebounceTimer = setTimeout(() => {
            translatePendingNodes();
        }, 500);
    });

    mutationObserver.observe(document.body, {
        childList: true,
        subtree: true
    });

    console.log('Auto-translate enabled for new content');
}

/**
 * Stop auto-translate
 */
function stopAutoTranslate() {
    autoTranslateEnabled = false;
    if (mutationObserver) {
        mutationObserver.disconnect();
        mutationObserver = null;
    }
    if (autoTranslateDebounceTimer) {
        clearTimeout(autoTranslateDebounceTimer);
        autoTranslateDebounceTimer = null;
    }
    pendingNewNodes = [];
    console.log('Auto-translate disabled');
}

/**
 * Translate pending new nodes
 */
async function translatePendingNodes() {
    if (pendingNewNodes.length === 0 || translationInProgress) return;

    const nodesToProcess = [...pendingNewNodes];
    pendingNewNodes = [];

    const textItems = extractNewTextNodes(nodesToProcess);

    if (textItems.length === 0) return;

    translationInProgress = true;
    showStatus(`Translating ${textItems.length} new elements...`);

    try {
        const result = await translateBatch(textItems, currentTargetLanguage);
        showStatus(`Translated ${result.applied} new elements`);
        setTimeout(hideStatus, 2000);
    } catch (e) {
        console.error('Auto-translate error:', e);
        showStatus(`Auto-translate error: ${e.message}`, true);
        setTimeout(hideStatus, 3000);
    } finally {
        translationInProgress = false;
    }
}

/** Translate the current user text selection in place, showing status messages as it progresses. */
async function translateSelection(targetLanguage, sourceLanguage = 'auto') {
    if (translationInProgress) {
        showStatus('Translation already in progress...', true);
        setTimeout(hideStatus, 2000);
        return;
    }

    const selection = window.getSelection();
    if (!selection || selection.isCollapsed || selection.rangeCount === 0) {
        showStatus('No text selected', true);
        setTimeout(hideStatus, 2000);
        return;
    }

    currentTargetLanguage = targetLanguage;
    translationInProgress = true;
    translationCancelled = false;
    const stopKeepAlive = startKeepAlive();
    showStatus('Extracting selected text...');

    try {
        const textItems = extractSelectionTextNodes(selection);

        if (textItems.length === 0) {
            showStatus('No translatable text in selection', true);
            setTimeout(hideStatus, 3000);
            return;
        }

        showStatus(`Translating ${textItems.length} selected elements...`);

        // Resolve source once and batch the selection block-aware, like the page.
        const effectiveSetting = (sourceLanguage && sourceLanguage !== 'auto')
            ? sourceLanguage : sourceLanguageSetting;
        const sample = textItems.slice(0, 40).map(i => i.text).join('\n').slice(0, 4000);
        const resolvedSource = resolveSourceLanguage(effectiveSetting, sample, getDeclaredPageLanguage());
        const batches = groupTextNodesIntoBatches(textItems, {
            maxItems: maxItemsPerBatch,
            maxTokens: maxTokensPerBatch
        });

        let totalApplied = 0;
        let processed = 0;
        const failedItems = [];

        for (const batch of batches) {
            if (translationCancelled) break;
            const result = await translateBatch(batch, targetLanguage, resolvedSource);
            totalApplied += result.applied;
            if (result.failed && result.failed.length > 0) failedItems.push(...result.failed);
            processed += batch.length;
            const percent = Math.min(100, Math.round((processed / textItems.length) * 100));
            showStatus(`Translating selection... ${percent}%`);
        }

        if (totalApplied > 0) {
            hasTranslationCache = true;
            isShowingTranslations = true;
        }

        let statusMsg = `Translated ${totalApplied}/${textItems.length} selected elements`;
        if (failedItems.length > 0) statusMsg += ` - ${failedItems.length} failed`;
        showStatus(statusMsg);
        setTimeout(hideStatus, 4000);

    } catch (e) {
        console.error('[Translator] Selection translation error:', e);
        showStatus(`Error: ${e.message}`, true);
        setTimeout(hideStatus, 5000);
    } finally {
        stopKeepAlive();
        translationInProgress = false;
        translationCancelled = false;
        // Suppress the button briefly so it doesn't reappear on the now-translated selection
        suppressFloatingBtn = true;
        setTimeout(() => { suppressFloatingBtn = false; }, 1000);
    }
}

// Listen for messages from background/popup
browserAPI.runtime.onMessage.addListener((message, sender, sendResponse) => {
    // console.log(`[Translator] Received message: ${message.type}`, message);

    switch (message.type) {
        case 'START_TRANSLATION':
            if (message.showGlow !== undefined) showGlow = message.showGlow;
            if (message.maxConcurrentRequests !== undefined) {
                maxConcurrentRequests = Math.max(1, Math.min(4, message.maxConcurrentRequests));
            }
            translatePage(message.targetLanguage, message.sourceLanguage, true);
            sendResponse({ started: true });
            break;

        case 'TRANSLATE_SELECTION':
            if (message.showGlow !== undefined) showGlow = message.showGlow;
            if (message.maxConcurrentRequests !== undefined) {
                maxConcurrentRequests = Math.max(1, Math.min(4, message.maxConcurrentRequests));
            }
            translateSelection(message.targetLanguage, message.sourceLanguage);
            sendResponse({ started: true });
            break;

        case 'SET_GLOW':
            showGlow = message.enabled;
            // Update existing translated elements
            document.querySelectorAll('[data-translated="true"]').forEach(el => {
                el.style.textShadow = showGlow ? '0 0 8px #7FBBB3, 0 0 2px #7FBBB3' : '';
            });
            sendResponse({ showGlow });
            break;

        case 'RESTORE_ORIGINAL':
            restoreOriginalText();
            showStatus('Restored original text');
            setTimeout(hideStatus, 2000);
            sendResponse({ restored: true, hasCache: hasTranslationCache });
            break;

        case 'TOGGLE_TRANSLATION':
            // Toggle between translated and original
            if (isShowingTranslations) {
                restoreOriginalText();
                showStatus('Showing original text');
                setTimeout(hideStatus, 2000);
                sendResponse({ showing: 'original', hasCache: hasTranslationCache });
            } else if (hasTranslationCache) {
                restoreCachedTranslations();
                showStatus('Restored translations');
                setTimeout(hideStatus, 2000);
                sendResponse({ showing: 'translated', hasCache: hasTranslationCache });
            } else {
                sendResponse({ showing: 'original', hasCache: false });
            }
            break;

        case 'TRANSLATION_PROGRESS':
            showStatus(message.status);
            sendResponse({ received: true });
            break;

        case 'PARTIAL_TRANSLATION':
            console.log(`[Translator] PARTIAL_TRANSLATION with ${message.translations?.length} items`);
            let applied = 0;
            for (const t of message.translations) {
                if (!t.error && t.text) {
                    if (replaceTextNode(t.id, t.text)) {
                        applied++;
                    }
                }
            }
            console.log(`[Translator] Applied ${applied} partial translations`);
            sendResponse({ applied: true });
            break;

        case 'TOGGLE_AUTO_TRANSLATE':
            if (autoTranslateEnabled) {
                stopAutoTranslate();
                showStatus('Auto-translate disabled');
            } else {
                startAutoTranslate(message.targetLanguage || currentTargetLanguage);
                showStatus('Auto-translate enabled');
            }
            setTimeout(hideStatus, 2000);
            sendResponse({ autoTranslate: autoTranslateEnabled });
            break;

        case 'CANCEL_TRANSLATION':
            console.log('[Translator] Cancellation requested');
            translationCancelled = true;
            pendingTranslationQueue = [];
            stopAutoTranslate();
            sendResponse({ cancelled: true });
            break;

        case 'GET_TRANSLATION_STATUS':
            sendResponse({
                isTranslating: translationInProgress,
                isAutoTranslating: autoTranslateEnabled
            });
            break;

        case 'GET_PAGE_LANGUAGE':
            sendResponse({
                language: getPageLanguage()
            });
            break;

        case 'DESCRIBE_IMAGE_START':
            showDescribeLoading();
            sendResponse({ ok: true });
            break;

        case 'DESCRIBE_IMAGE_RESULT':
            showDescribeResult(message.text);
            sendResponse({ ok: true });
            break;

        case 'DESCRIBE_IMAGE_ERROR':
            showDescribeError(message.error);
            sendResponse({ ok: true });
            break;

        case 'PING':
            sendResponse({ pong: true });
            break;

        default:
            sendResponse({ unknown: true });
    }
    return true;
});

console.log('Local LLM Translate content script loaded');

// ============================================================================
// Floating translate button (only active when auto-injected via optional permission)
// ============================================================================

let floatingTranslateBtn = null;
let suppressFloatingBtn = false;

/** Get the display name for a language code in the browser's UI language, falling back to the uppercased code. */
function getLanguageName(code) {
    try {
        return new Intl.DisplayNames([navigator.language || 'en'], { type: 'language' }).of(code);
    } catch (e) {
        return code.toUpperCase();
    }
}

/** Update the floating translate button's tooltip to reflect the current target language. */
function updateFloatingBtnTitle() {
    if (floatingTranslateBtn) {
        floatingTranslateBtn.title = `Translate to ${getLanguageName(currentTargetLanguage)}`;
    }
}

/** Lazily create (or return the existing) floating translate button element and append it to the document. */
function getFloatingTranslateBtn() {
    if (floatingTranslateBtn) return floatingTranslateBtn;

    const btn = document.createElement('div');
    btn.id = 'llm-translator-float-btn';
    btn.setAttribute('translate', 'no');
    btn.title = `Translate to ${getLanguageName(currentTargetLanguage)}`;
    btn.style.cssText = [
        'position:absolute', 'width:2em', 'height:2em', 'cursor:pointer',
        'z-index:999999', 'display:none', 'align-items:center', 'justify-content:center',
        'transition:opacity 0.1s,transform 0.1s', 'opacity:0', 'transform:scale(0.8)'
    ].join(';');

    const img = document.createElement('img');
    img.src = browserAPI.runtime.getURL('icons/icon48.png');
    img.style.cssText = 'width:100%;height:100%;pointer-events:none;filter:drop-shadow(0 1px 3px rgba(0,0,0,0.35))';
    btn.appendChild(img);

    btn.addEventListener('mouseenter', () => { btn.style.opacity = '1'; });
    btn.addEventListener('mouseleave', () => { btn.style.opacity = '0.65'; });
    btn.addEventListener('mousedown', (e) => { e.preventDefault(); e.stopPropagation(); });
    btn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        hideFloatingBtn();
        translateSelection(currentTargetLanguage, getPageLanguage());
    });

    document.body.appendChild(btn);
    floatingTranslateBtn = btn;
    return btn;
}

/** Position and reveal the floating translate button next to the end of the given selection. */
function showFloatingBtn(selection) {
    if (!selection || selection.isCollapsed || selection.rangeCount === 0) return;
    const range = selection.getRangeAt(selection.rangeCount - 1);
    const rects = range.getClientRects();
    const rect = rects.length > 0 ? rects[rects.length - 1] : range.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) return;

    const btn = getFloatingTranslateBtn();
    btn.style.left = (rect.right + window.scrollX + 4) + 'px';
    btn.style.top = (rect.bottom + window.scrollY + 4) + 'px';
    btn.style.display = 'flex';
    requestAnimationFrame(() => { btn.style.opacity = '0.65'; btn.style.transform = 'scale(1)'; });
}

/** Fade out and hide the floating translate button. */
function hideFloatingBtn() {
    if (!floatingTranslateBtn) return;
    floatingTranslateBtn.style.opacity = '0';
    floatingTranslateBtn.style.transform = 'scale(0.8)';
    setTimeout(() => { if (floatingTranslateBtn) floatingTranslateBtn.style.display = 'none'; }, 80);
}

/** Show the floating translate button for the current selection if conditions allow it. */
function tryShowFloatingBtn() {
    if (!floatingButtonEnabled) return;
    const selection = window.getSelection();
    const selectedText = selection?.toString().trim() || '';
    // Only suppress when the page *explicitly* declares the target language; an
    // undeclared page (null) is treated as unknown so the button still appears.
    const declaredLang = getDeclaredPageLanguage();
    const sameLanguage = declaredLang !== null && declaredLang === currentTargetLanguage;
    if (selection && !selection.isCollapsed && selectedText.length >= MIN_TEXT_LENGTH
            && !sameLanguage && !translationInProgress && !suppressFloatingBtn) {
        showFloatingBtn(selection);
    }
}

// mouseup/keyup: selection is final, safe to show the button.
// selectionchange: only used to hide when selection is cleared, avoiding
// the double-click problem where it briefly collapses before expanding.
document.addEventListener('mouseup', tryShowFloatingBtn);
document.addEventListener('keyup', (e) => {
    if (e.shiftKey || e.key === 'End' || e.key === 'Home') tryShowFloatingBtn();
});

document.addEventListener('selectionchange', () => {
    const selection = window.getSelection();
    const selectedText = selection?.toString().trim() || '';
    if (!selection || selection.isCollapsed || selectedText.length < MIN_TEXT_LENGTH) {
        hideFloatingBtn();
    }
});

window.addEventListener('scroll', () => {
    if (floatingTranslateBtn && floatingTranslateBtn.style.display !== 'none') hideFloatingBtn();
}, { passive: true });
