/**
 * Default settings for Local LLM Translate.
 *
 * This is the single source of truth for default settings. It is loaded before
 * the other scripts in every HTML page (popup, options) and is imported by the
 * background service worker, so all screens share one set of defaults. Do NOT
 * redeclare DEFAULT_SETTINGS anywhere else — a stale copy in one screen silently
 * overrides settings saved by another.
 */

// eslint-disable-next-line no-unused-vars -- shared global used by other scripts
const DEFAULT_SETTINGS = {
    // OpenAI-compatible llama-server endpoint (llama.cpp `/v1`). Legacy
    // ollamaUrl/lmstudioUrl/llamacppUrl installs migrate to this in loadSettings().
    serverUrl: 'http://localhost:8080',
    selectedModel: '',
    targetLanguage: 'en',
    sourceLanguage: 'auto', // 'auto' = detect from page, or specific code
    pinnedLanguages: [],     // Languages pinned to the top of the popup picker
    pinnedModels: [],        // Models pinned to the top of the popup picker
    maxTokensPerBatch: 2000,
    maxItemsPerBatch: 8,
    maxConcurrentRequests: 4, // 1-4 parallel requests to the server
    useAdvanced: false,      // Use the custom system/user prompt below instead of the built-in template
    customSystemPrompt: '',
    customUserPromptTemplate: '',
    temperature: 0.3,
    useStructuredOutput: true,
    // Stream each segment's translation and type it into the page as tokens
    // arrive (typewriter effect). One plain-text request per unique segment.
    // Turn off to restore the batched-JSON path exactly.
    streamTranslations: true,
    maxOutputRetries: 2,    // Extra attempts when the model returns malformed/missing translations
    showGlow: false,
    // Translation cache: 'persistent' (kept across browser sessions), 'session'
    // (kept until the browser is closed, then wiped), or 'off'. Off by default.
    cacheMode: 'off',
    debug: false,       // Enable verbose logging
    floatingButton: false, // Show floating translate button on text selection (requires <all_urls> permission)
    // Hover-to-translate: hold the modifier and hover a paragraph to see its
    // translation in a floating bubble. Opt-in and gated behind the same
    // <all_urls> content-script permission as the floating button.
    hoverEnabled: false,
    hoverModifier: 'Alt', // 'Alt' | 'Control' | 'Shift' | 'Meta'
    // Image describe & interpret feature. visionModel is the multimodal model
    // used to describe images (falls back to selectedModel when empty).
    // describePrompt overrides DEFAULT_DESCRIBE_PROMPT when set. Both are
    // configurable on the options page. {{targetLanguage}} is substituted at call time.
    visionModel: '',
    describePrompt: ''
};

// Default prompt for the image describe & interpret feature. Used when
// settings.describePrompt is empty. Shared by the background worker (which makes
// the vision call) and the options page (which pre-fills the editable prompt),
// so there is one source of truth. {{targetLanguage}} is substituted at call time.
// eslint-disable-next-line no-unused-vars -- shared global used by other scripts
const DEFAULT_DESCRIBE_PROMPT = `Read the text in this image and respond with two parts.

Text: transcribe every piece of text visible in the image exactly as written, preserving the original wording, order, and line breaks. If there is no readable text, write "(no text found)".

Translation: translate that text into {{targetLanguage}}.`;

// Built-in translation prompt (single OpenAI JSON path). This is the one source
// of truth for the default template: the pipeline uses it at translate time and
// the options page pre-fills its editable prompt fields from it, so the two can
// never silently diverge. Custom prompts (settings.useAdvanced) override it.
// {{sourceLang}}, {{targetLanguage}}, and {{texts}} are substituted at call time.
// eslint-disable-next-line no-unused-vars -- shared global used by other scripts
const DEFAULT_TRANSLATE_TEMPLATE = {
    system: `You are a professional translator translating from {{sourceLang}} to {{targetLanguage}}. The numbered texts are consecutive segments of one continuous passage — translate them together so pronouns, dropped subjects, and honorifics stay consistent.
Respond ONLY with a JSON object in this exact format:
{"translations": [{"id": 0, "text": "translated text"}, {"id": 1, "text": "another translation"}]}
Maintain the original meaning, tone, and formatting. Do not add explanations.`,
    user: `Translate the following {{sourceLang}} texts to {{targetLanguage}}:\n{{texts}}`
};

// Attach to the global object explicitly: top-level `const` in a classic script
// does NOT create a globalThis property, and translate-pipeline.js reads these
// as properties (`g.DEFAULT_TRANSLATE_TEMPLATE`), not bare identifiers.
(function () {
    const g = (typeof self !== 'undefined') ? self
        : (typeof globalThis !== 'undefined') ? globalThis : this;
    Object.assign(g, { DEFAULT_SETTINGS, DEFAULT_DESCRIBE_PROMPT, DEFAULT_TRANSLATE_TEMPLATE });
})();

// Node/CommonJS callers (translate-pipeline.js under Vitest) load the shared
// defaults via require(); the browser reads them as globals declared above.
if (typeof module !== 'undefined' && module.exports) {
    module.exports = { DEFAULT_SETTINGS, DEFAULT_DESCRIBE_PROMPT, DEFAULT_TRANSLATE_TEMPLATE };
}
