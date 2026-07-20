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
 * A model advertised by the server, as surfaced to the UI pickers.
 * @typedef {object} ModelInfo
 * @property {string} id - model identifier used in API requests
 * @property {string} name - display name (often identical to `id`)
 */

/**
 * Reachability probe result for the llama-server. `blocked` means the server
 * answered an opaque (CORS-blocked) response, so it is running but unreadable.
 * @typedef {object} ServerStatus
 * @property {boolean} available
 * @property {boolean} blocked
 */

/**
 * A translation provider: the interface `translate-pipeline.js` depends on.
 * `llama-server.js` implements it; a future provider is a new implementation.
 * @typedef {object} TranslationProvider
 * @property {string} [id]
 * @property {string} [label]
 * @property {() => Promise<ServerStatus>} [probeServer]
 * @property {() => Promise<ModelInfo[]>} [listModels]
 * @property {(modelId: string, system: string, user: string, opts?: {jsonSchema?: object|null, schemaName?: string, temperature?: number}) => Promise<string>} [chatCompletion]
 * @property {(modelId: string, system: string, user: string, onDelta: (t: string) => void, opts?: {temperature?: number}) => Promise<string>} [chatCompletionStream]
 * @property {(modelId: string, prompt: string, imageDataUrl: string, opts?: {temperature?: number}) => Promise<string>} [describeVision]
 */

/**
 * The cache seam the pipeline uses (adapts cache.js). Optional — caching is only
 * active when supplied and settings.cacheMode !== 'off'.
 * @typedef {object} PipelineCache
 * @property {(model: string, sourceCode: string, targetCode: string, format: string, text: string) => string} key
 * @property {(keys: string[]) => Promise<Map<string, string>>} getMany
 * @property {(entries: Array<[string, string]>) => Promise<*>} setMany
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
 * @property {string} serverUrl - the llama-server (OpenAI-compatible) base URL
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
 * @property {number} temperature
 * @property {boolean} useStructuredOutput
 * @property {boolean} streamTranslations
 * @property {number} maxOutputRetries
 * @property {boolean} showGlow
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
 *   PartialTranslationMessage
 * )} Message
 */
