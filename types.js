/**
 * Shared type vocabulary for Local LLM Translate.
 *
 * This file contains only JSDoc `@typedef` declarations — no runtime code. It is
 * a dev-only artifact: `tsc --checkJs` reads it to type-check the rest of the
 * codebase, and it is excluded from the packaged extension. Because it is a
 * classic (non-module) script, every typedef below is a global/ambient type
 * available to all the other extension scripts without an import.
 *
 * Keep this in sync with `defaults.js` (Settings) and the message handlers in
 * `background.js` / `content.js` (Message) — it is the single written home for
 * the project's ubiquitous language.
 */

// ---- Providers --------------------------------------------------------------

/**
 * An LLM backend the extension can talk to. `'auto'` means "pick the first
 * reachable one".
 * @typedef {'auto'|'ollama'|'lmstudio'|'llamacpp'} Provider
 */

/**
 * A model advertised by a provider, as surfaced to the UI pickers.
 * @typedef {object} ModelInfo
 * @property {string} id - model identifier used in API requests
 * @property {string} name - display name (often identical to `id`)
 * @property {Provider} provider - which backend advertised it
 */

/**
 * Reachability probe result for the three backends. `*_blocked` means the server
 * answered an opaque (CORS-blocked) response, so it is running but unreadable.
 * @typedef {object} ProviderAvailability
 * @property {boolean} ollama
 * @property {boolean} ollama_blocked
 * @property {boolean} lmstudio
 * @property {boolean} lmstudio_blocked
 * @property {boolean} llamacpp
 * @property {boolean} llamacpp_blocked
 */

// ---- Translation units ------------------------------------------------------

/**
 * A single piece of text queued for translation. `id` is caller-assigned and is
 * echoed back on the matching {@link TranslationResult}; `blockId` groups items
 * from the same paragraph/list-item/cell for block-aware batching.
 * @typedef {object} TextItem
 * @property {number|string} id
 * @property {string} text
 * @property {(number|string)=} blockId
 */

/**
 * The translation of one {@link TextItem}, keyed back to its `id`. Exactly one of
 * `text` (success) or `error` (failure) is meaningful for a given result.
 * @typedef {object} TranslationResult
 * @property {number|string} id
 * @property {string=} text
 * @property {*=} error
 */

// ---- Settings ---------------------------------------------------------------

/**
 * Persisted user settings. Mirrors `DEFAULT_SETTINGS` in `defaults.js`, which is
 * the single source of truth for defaults.
 * @typedef {object} Settings
 * @property {Provider} provider
 * @property {string} ollamaUrl
 * @property {string} lmstudioUrl
 * @property {string} llamacppUrl
 * @property {string} selectedModel
 * @property {string} targetLanguage
 * @property {string} sourceLanguage - `'auto'` to detect from the page, or a code
 * @property {string[]} pinnedLanguages
 * @property {string[]} pinnedModels
 * @property {number} maxTokensPerBatch
 * @property {number} maxItemsPerBatch
 * @property {number} maxConcurrentRequests
 * @property {boolean} useAdvanced
 * @property {string} customSystemPrompt
 * @property {string} customUserPromptTemplate
 * @property {string} requestFormat - `'auto'` | `'default'` | a model-family format
 * @property {number} temperature
 * @property {boolean} useStructuredOutput
 * @property {boolean} streamTranslations
 * @property {number} maxOutputRetries
 * @property {boolean} plainTextFallback
 * @property {boolean} showGlow
 * @property {number} numCtx
 * @property {'persistent'|'session'|'off'} cacheMode
 * @property {boolean} debug
 * @property {boolean} floatingButton
 * @property {boolean} hoverEnabled
 * @property {'Alt'|'Control'|'Shift'|'Meta'} hoverModifier
 * @property {string} visionModel
 * @property {string} describePrompt
 */

// ---- Messages ---------------------------------------------------------------
// The runtime message protocol between popup/options/content and the background
// worker. Every message carries a discriminating `type`; the payload-bearing
// variants are spelled out below and collected into the `Message` union.

/** @typedef {{ type: 'GET_SETTINGS' }} GetSettingsMessage */
/** @typedef {{ type: 'SAVE_SETTINGS', settings: Partial<Settings> }} SaveSettingsMessage */
/** @typedef {{ type: 'DETECT_PROVIDERS' }} DetectProvidersMessage */
/** @typedef {{ type: 'LIST_MODELS', forceRefresh?: boolean }} ListModelsMessage */
/** @typedef {{ type: 'REGISTER_CONTENT_SCRIPT' }} RegisterContentScriptMessage */
/** @typedef {{ type: 'UNREGISTER_CONTENT_SCRIPT' }} UnregisterContentScriptMessage */
/** @typedef {{ type: 'TRANSLATE', texts: TextItem[], targetLanguage: string, sourceLanguage?: string }} TranslateMessage */
/** @typedef {{ type: 'CLEAR_CACHE' }} ClearCacheMessage */
/** @typedef {{ type: 'CACHE_COUNT' }} CacheCountMessage */
/** @typedef {{ type: 'CACHE_BACKEND' }} CacheBackendMessage */
/** @typedef {{ type: 'DESCRIBE_IMAGE', imageDataUrl: string }} DescribeImageMessage */
/** @typedef {{ type: 'PARTIAL_TRANSLATION', translations: TranslationResult[] }} PartialTranslationMessage */

/**
 * The discriminated union of every runtime message. Narrow on `type` to get the
 * payload for a given variant.
 * @typedef {(
 *   GetSettingsMessage |
 *   SaveSettingsMessage |
 *   DetectProvidersMessage |
 *   ListModelsMessage |
 *   RegisterContentScriptMessage |
 *   UnregisterContentScriptMessage |
 *   TranslateMessage |
 *   ClearCacheMessage |
 *   CacheCountMessage |
 *   CacheBackendMessage |
 *   DescribeImageMessage |
 *   PartialTranslationMessage
 * )} Message
 */
