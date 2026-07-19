/**
 * Default settings for Local LLM Translator.
 *
 * This is the single source of truth for default settings. It is loaded before
 * the other scripts in every HTML page (popup, options, translator) and is
 * imported by the background service worker, so all screens share one set of
 * defaults. Do NOT redeclare DEFAULT_SETTINGS anywhere else — a stale copy in
 * one screen silently overrides settings saved by another.
 */

// eslint-disable-next-line no-unused-vars -- shared global used by other scripts
const DEFAULT_SETTINGS = {
    provider: 'auto', // 'auto', 'ollama', 'lmstudio', 'llamacpp'
    ollamaUrl: 'http://localhost:11434',
    lmstudioUrl: 'http://localhost:1234',
    llamacppUrl: 'http://localhost:8080',
    selectedModel: '',
    targetLanguage: 'en',
    sourceLanguage: 'auto', // 'auto' = detect from page, or specific code
    pinnedLanguages: [],     // Languages pinned to the top of the popup picker
    pinnedModels: [],        // Models pinned to the top of the popup picker
    maxTokensPerBatch: 2000,
    maxItemsPerBatch: 8,
    maxConcurrentRequests: 4, // 1-4 parallel requests (LM Studio 0.4.0+ supports up to 4)
    useAdvanced: false,
    customSystemPrompt: '',
    customUserPromptTemplate: '',
    requestFormat: 'auto', // 'auto' (detect from model), 'default', 'translategemma', 'hunyuan', 'simple', 'custom'
    temperature: 0.3,
    useStructuredOutput: true,
    maxOutputRetries: 2,    // Extra attempts when the model returns malformed/missing translations
    plainTextFallback: true, // After JSON retries fail, translate the failed items one-by-one as plain text
    showGlow: false,
    numCtx: 0,          // Ollama context window size (0 = model default)
    // Translation cache: 'persistent' (kept across browser sessions), 'session'
    // (kept until the browser is closed, then wiped), or 'off'. Off by default.
    cacheMode: 'off',
    debug: false,       // Enable verbose logging
    floatingButton: false, // Show floating translate button on text selection (requires <all_urls> permission)
    // Image describe & interpret feature. visionModel is the multimodal model
    // used to describe images (falls back to selectedModel when empty). Both are
    // wired to an options-page UI in a later ticket; describePrompt overrides the
    // built-in default prompt when set. {{targetLanguage}} is substituted at call time.
    visionModel: '',
    describePrompt: ''
};
