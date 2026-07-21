# Architecture

Local LLM Translate Extension is a Manifest V3 browser extension (Firefox +
Chrome) that translates web pages using a local LLM server — llama.cpp's
OpenAI-compatible `llama-server`. The shipped extension is **vanilla JavaScript
with no runtime dependencies and no build step**; the only tooling is dev-time
lint/test/packaging.

Design principle: the network client is injected into the translation pipeline,
which is injected into the background orchestrator. A future provider is a new
module implementing the same interface — not a pipeline rewrite.

## Surfaces

| Surface | Responsibility | Loads |
|---------|----------------|-------|
| **Background** (service worker on Chrome; `background.scripts` on Firefox) | Loads/saves/migrates settings, wires the provider + pipeline, routes messages, owns context menus and the image-describe flow | `languages.js`, `cache.js`, `defaults.js`, `translation-core.js`, `llama-server.js`, `translate-pipeline.js`, `background.js` |
| **Content script** | Extracts/replaces page text, runs the translation loop, floating button, hover-to-translate bubble, image-describe modal | `translation-core.js`, `content.js` |
| **Popup** (`popup/popup.html`) | Quick-translate UI: model/language pickers, translate / cancel / restore, floating-button toggle | `languages.js`, `defaults.js`, `popup.js` |
| **Options** (`options/options.html`, opens in a tab) | Full settings: server URL, model + vision-model pickers, prompt editor, batching/concurrency, cache mode, debug, hover options | `languages.js`, `defaults.js`, `options.js` |

The UI surfaces (popup, options, content) never talk to `llama-server` directly —
they message the background, which owns the provider and pipeline.

### Cross-browser background loading

Firefox loads the ordered `background.scripts` array; Chrome loads a single
`background.service_worker` (`background.js`), which `importScripts()`es the same
dependency list at startup. Both entry points are declared in `manifest.json`;
the Chrome package (see [packaging](#packaging)) keeps only `service_worker`.

## Module map

All runtime modules except `background.js` and `content.js` are **dual-target**:
they expose a global (for the browser/worker) *and* `module.exports` (for
Node/Vitest), so the pure logic is unit-testable outside a browser.

| Module | Responsibility | Key exports | Dual-target |
|--------|----------------|-------------|:-----------:|
| `background.js` | Orchestrator: settings load/save/migrate, provider+pipeline wiring, message dispatch, context menus, image fetch | entry point (no exported API) | — |
| `content.js` | DOM extraction/replacement, translation run loop, batching orchestration, floating button + hover UI, describe modal | entry point (no exported API) | — |
| `llama-server.js` | OpenAI-compatible client for `llama-server` (`/v1/models`, `/v1/chat/completions`) | `createLlamaServer({ serverUrl, fetch })` | ✅ |
| `translate-pipeline.js` | Batching, dedup, caching, retry, response parsing, image-describe orchestration | `createPipeline({ provider, cache })` → `{ translate, translateStream, describe }`; `TRANSLATION_JSON_SCHEMA`, `hashString` | ✅ |
| `defaults.js` | Single source of truth for defaults | `DEFAULT_SETTINGS`, `DEFAULT_DESCRIBE_PROMPT`, `DEFAULT_TRANSLATE_TEMPLATE` | ✅ |
| `cache.js` | Two-layer (in-memory Map + IndexedDB) translation cache | `cacheKey`, `cacheGetMany`, `cacheSetMany`, `cacheClear`, `cacheCount`, `cachePersistentAvailable` | ✅ |
| `languages.js` | Language code↔name table + host-permission helpers | `LANGUAGES`, `getLanguageName`, `getLanguageCode`, `hostPermissionPattern`, `ensureHostPermissions` | ✅ |
| `translation-core.js` | Pure helpers: source-language detection, prompt templating, response parsing, sentence splitting, block-aware batching | `detectSourceLanguage`, `resolveSourceLanguage`, `buildPrompt`, `parseTranslationResponse`, `splitIntoSentences`, `groupTextNodesIntoBatches`, … | ✅ |

`types.js` is a dev-only JSDoc-typedef file (excluded from the package) defining
`TranslationProvider`, `PipelineCache`, `TextItem`, `TranslationResult`,
`Settings`, and the `Message` union.

## Provider interface

`createPipeline({ provider, cache })` depends on a `provider` implementing:

```
provider.chatCompletion(modelId, systemPrompt, userPrompt, { jsonSchema?, schemaName?, temperature? }) -> Promise<string>
provider.chatCompletionStream(modelId, systemPrompt, userPrompt, onDelta, { temperature? })            -> Promise<string>   // onDelta(token) => void
provider.describeVision(modelId, prompt, imageDataUrl, { temperature? })                               -> Promise<string>
```

The full `TranslationProvider` interface also includes `probeServer()` and
`listModels()`, which the **background** calls directly (not the pipeline).
`createLlamaServer({ serverUrl, fetch })` returns an object satisfying the whole
interface (`id`, `label`, `probeServer`, `listModels`, `chatCompletion`,
`chatCompletionStream`, `describeVision`).

The pipeline's `cache` dependency is the `PipelineCache` shape
(`key(model, sourceCode, targetCode, format, text)`, `getMany(keys)`,
`setMany(entries)`); in production `background.js` adapts `cache.js`'s globals.

## Message protocol

The UI surfaces and the background communicate exclusively via
`runtime.sendMessage` / `tabs.sendMessage`, dispatched on `message.type`. The
background handler is a single `runtime.onMessage` listener; the content script
has its own `runtime.onMessage` listener.

### To the background

| `type` | Sender → | Payload | Response |
|--------|----------|---------|----------|
| `GET_SETTINGS` | popup / options / content | — | `{ settings }` |
| `SAVE_SETTINGS` | popup / options | `{ settings }` (partial) | `{ settings }` |
| `DETECT_PROVIDERS` | popup | — | `{ available, blocked }` |
| `LIST_MODELS` | popup / options | `{ forceRefresh? }` | `{ models: [{ id, name }] }` |
| `REGISTER_CONTENT_SCRIPT` | popup / options | — | `{ ok: true }` |
| `UNREGISTER_CONTENT_SCRIPT` | popup / options | — | `{ ok: true }` |
| `TRANSLATE` | content | `{ texts: [{ id, text }], targetLanguage, sourceLanguage }` | `{ translations, fromCache, total, cacheActive }` |
| `CLEAR_CACHE` | options | — | `{ ok, error? }` |
| `CACHE_COUNT` | options | — | `{ count, error? }` |
| `CACHE_BACKEND` | options | — | `{ persistent, error? }` |

### To the content script

| `type` | Sender → | Payload | Response |
|--------|----------|---------|----------|
| `START_TRANSLATION` | background (context menu) / popup | `{ targetLanguage, sourceLanguage, showGlow, maxConcurrentRequests }` | `{ started: true }` |
| `TRANSLATE_SELECTION` | background (context menu) | `{ targetLanguage, sourceLanguage, showGlow, maxConcurrentRequests }` | `{ started: true }` |
| `PARTIAL_TRANSLATION` | background (streaming) | `{ translations: [{ id, text }] }` | `{ applied: true }` |
| `SET_GLOW` | popup | `{ enabled }` | `{ showGlow }` |
| `TOGGLE_TRANSLATION` | popup | — | `{ showing, hasCache }` |
| `CANCEL_TRANSLATION` | popup | — | `{ cancelled: true }` |
| `GET_TRANSLATION_STATUS` | popup | — | `{ isTranslating, isAutoTranslating }` |
| `DESCRIBE_IMAGE_START` | background (context menu) | — | `{ ok: true }` |
| `DESCRIBE_IMAGE_RESULT` | background | `{ text }` | `{ ok: true }` |
| `DESCRIBE_IMAGE_ERROR` | background | `{ error }` | `{ ok: true }` |
| `PING` | background / popup | — | `{ pong: true }` |

`TRANSLATION_COMPLETE` is a fire-and-forget content → popup notification that
resets the popup button. Several content-script handlers (`RESTORE_ORIGINAL`,
`TRANSLATION_PROGRESS`, `TOGGLE_AUTO_TRANSLATE`, `GET_PAGE_LANGUAGE`) are
reserved/legacy with no current sender.

### Other channels

- **Keep-alive port** — the content script opens a `runtime.connect({ name: 'keepalive' })` port and pings it periodically so the MV3 service worker is not suspended during long-running page translations.
- **Storage reactivity** — the content script listens to `storage.onChanged` on the `settings` key and live-updates target language, floating-button state, batching limits, source-language setting, and hover options without a reload.

## Packaging

`npm run build` (`scripts/build.mjs`) emits two zips from the single source
tree via `web-ext build`, sharing the `webExt.ignoreFiles` list so dev-only
files never ship:

- **Firefox** — the manifest exactly as authored.
- **Chrome** — a manifest with Firefox-only keys stripped (`browser_specific_settings`, the top-level `developer` key, and `background.scripts` — keeping `background.service_worker`).

On a `v*` tag, `.github/workflows/release.yml` runs the build and attaches both
zips to the GitHub Release.
