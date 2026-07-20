# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

> **Note:** This is a fork of
> [Eldoprano/offline-browser-translate](https://github.com/Eldoprano/offline-browser-translate)
> by [Eldoprano](https://github.com/Eldoprano). Entries below track changes made
> in this fork.

## [2.0.0] - 2026-07-20

### Added
- **Streaming translations (typewriter effect)**: on by default, each segment's
  translation is streamed from the local LLM and typed into the page as tokens
  arrive, so the page fills in progressively (highest-priority visible segments
  first, several at once) instead of jumping a batch at a time. Works against
  the local llama-server's OpenAI-compatible streaming endpoint (Server-Sent
  Events), reusing the existing dedup, cache, and error handling. Cached
  segments appear instantly; freshly streamed ones are cached. A **Stream
  translations** toggle in Options → Output Settings restores the previous
  whole-batch behaviour.
- **Internal**: `background.js` was split into node-loadable `llama-server.js`
  (the OpenAI-compatible client) and `translate-pipeline.js` (batching, cache,
  response parsing, image description) modules, each exercised by mocked-fetch
  integration tests.
- **Hover to translate**: an opt-in mode (Advanced Features) where holding a
  configurable modifier key (Alt / Ctrl / Shift / Meta) and hovering a paragraph
  shows its translation in a floating bubble that leaves the page untouched and
  dismisses on mouse-out or Escape. Nothing is sent unless the modifier is held,
  and it reuses the same translation pipeline and cache as full-page translation,
  so repeat hovers are instant. Gated behind the same optional all-websites
  permission as the floating button; the two share one reference-counted
  permission helper, so turning one off never revokes the other.
- **Source-language detection**: when the source is left on *auto*, the extension
  now detects it from the page's declared language and from script analysis of
  the text itself (Japanese kana/kanji, Hangul, Han, Cyrillic, Arabic, Greek,
  Devanagari, Thai, …) instead of assuming English. A Japanese page is translated
  *from Japanese*, and the resolved source is named to the model in the prompt.
- **Block-aware batching**: page and selection translation now group text
  segments by their nearest block-level ancestor and send each block as one
  request described as a continuous passage, so the model sees coherent context.
  The **max items per batch** and **max tokens per batch** settings are now
  honoured (the batch size was previously hard-coded to 8); oversize blocks spill
  across consecutive requests, and each unique string is still translated once.
- **Unit tests**: a dev-only `node:test` suite (`npm test`) covers the pure
  translation helpers — source detection, response parsing, and batch grouping.
  Nothing new ships in the extension bundle.

### Changed
- **BREAKING**: the extension now targets **llama-server only** — the
  OpenAI-compatible `/v1` path is the single supported backend. The
  `llamacppUrl` setting was renamed to `serverUrl` (default
  `http://localhost:8080`); legacy installs are migrated automatically.
- **Renamed** the extension to **Local LLM Translate Extension** (store/manifest
  name; in-app surfaces read "Local LLM Translate") ahead of publishing to the
  Firefox Add-ons store and the Chrome Web Store. No functional change; the MIT
  license and upstream attribution are unchanged.
- **Dev tooling**: `npm run lint` now enforces JSDoc on top-level functions via
  `eslint-plugin-jsdoc` (fails on missing/malformed JSDoc), and existing
  functions across the codebase were documented to satisfy it.
- **Test & type-checking harness**: `npm test` now runs a [Vitest](https://vitest.dev)
  suite (jsdom environment) that locks the current behaviour of the pure helpers
  with characterization tests — translation-response parsing, translation-text
  cleanup, embedded-JSON extraction, sentence segmentation, cache-key
  construction, and request-format resolution — so later refactors can be proven
  behaviour-preserving. A new `npm run typecheck` runs `tsc --noEmit --checkJs`
  over the shared modules against JSDoc typedefs for the core vocabulary
  (`Settings`, the `Message` union, `TextItem`, `TranslationResult`, `Provider`
  in `types.js`); it emits no compiled output. Both run in CI. All of this is
  dev-only — the new test/type files (`test/`, `types.js`, `tsconfig.json`,
  `vitest.config.js`, `globals.d.ts`) are excluded from the packaged zip. To make
  the helpers testable, `splitIntoSentences` moved into `translation-core.js` and
  `cache.js` / `languages.js` gained a `module.exports` guard (no runtime change).
- Pure translation helpers (source detection, response parsing, prompt building,
  block batching) were extracted into a shared `translation-core.js` module used
  by both the background worker and the content script and exercised by the tests.

### Changed (UI)
- **UI icons**: removed all emoji/unicode glyphs from the popup, translator, and
  options pages. Decorative emoji in page titles, section headings, and button
  labels are dropped (text only), while functional control glyphs (refresh,
  cancel, clear, language-dropdown arrows, copy, footer lock) and the toast
  status icons (success / error / warning) are now inline feather-style SVG that
  inherit `currentColor`, matching the existing caret/swap/pin icons and rendering
  consistently across platforms and OS light/dark themes.

### Removed
- **Ollama** and **LM Studio** provider support (code, settings, UI).
- The standalone translator page and its local-image describe path, along with
  the popup's **Open Translator** button.
- Model-family request-format rules (TranslateGemma/Hunyuan plain-text
  handling, the Request Format selector) and the plain-text fallback.
- The `provider`, `ollamaUrl`, `lmstudioUrl`, `numCtx`, `requestFormat`, and
  `plainTextFallback` settings.

## [1.8.0]

### Added
- **Describe & interpret images**: a new right-click context-menu item on images
  sends the picture to a vision-capable local model and shows the result in an
  on-page modal with a Copy button. The default prompt focuses on the **text in
  the image** — it transcribes what is written verbatim and then translates it
  into your target language. Works with all three local providers — **LM Studio**
  and **llama.cpp** (OpenAI `image_url` shape) and **Ollama** (native `images`
  field); uses a new `visionModel` setting (falls back to the selected model).
  The full image is always sent to the model as base64 (data URLs that are not
  already base64, e.g. URL-encoded SVG, are re-encoded first); if no image can be
  read or encoded, the feature errors out instead of sending an empty or malformed
  payload. Cross-origin images request the optional `<all_urls>` permission on
  demand. Descriptions are cached (when the cache is enabled) keyed by the image
  bytes, model, target language, and prompt, so re-describing the same picture is
  instant while editing the prompt still produces a fresh description.
  The options page has a dedicated **Image Description** section with a
  vision-model picker (or "same as preferred model") and an editable prompt with
  a reset.
- **CI/CD** GitHub Actions: static analysis on pull requests (**ESLint** +
  `web-ext lint`), **CodeQL** security scanning, and a release workflow that
  packages the extension into a zip, creates a GitHub Release on version tags
  (`v*`), and auto-submits the signed build to AMO (when
  `AMO_JWT_ISSUER`/`AMO_JWT_SECRET` secrets are configured, using
  `amo-metadata.json` for the listing details).
- Dev tooling: `package.json` (ESLint + web-ext, with `lint`/`lint:ext`/`build`
  scripts and a `webExt` packaging config) and `eslint.config.mjs`. The shipped
  extension still has no runtime dependencies and no build step.
- Package metadata in the manifest: `short_name`, `author`, `developer`, and
  `homepage_url`.
- Version + repository link shown in the Options page footer.
- README lint/CodeQL/release badges and a Releases download link.

### Changed
- Single-sourced default settings into a shared `defaults.js` module, loaded by
  the background service worker and every UI page. Removes the four hand-synced
  `DEFAULT_SETTINGS` copies that had drifted (e.g. the popup defaulted "Show
  Glow" on while every other screen defaulted it off), so a setting changed in
  one screen is no longer silently overridden by a stale default elsewhere.
- Unified branding to **Local LLM Translator** across the popup, translator, and
  options UIs (previously a mix of "Local Translator" / "Local LLM Translator").
- Normalized the "LM Studio" product name across all UI strings (previously
  spelled "LMStudio" in the popup and translator).
- Rewrote the extension description for clarity.
- **Native look** across all three surfaces (popup, options, translator): a
  shared `native.css` renders native OS controls that follow the light/dark
  preference automatically via CSS `color-scheme` and system-colour keywords
  (`AccentColor`, `ButtonFace`, `Canvas`, `Field`, …). The custom Everforest
  colour palette and the translator's manual light/dark theme toggle are gone —
  theming is now automatic with no toggle and no stored theme.
- **Slimmed the toolbar popup** to the essentials: model / target-language /
  source-language pickers, translate / cancel / restore, and quick toggles for
  the floating button and glow effect. Provider, server URLs, batch sizes,
  temperature, and cache controls now live only on the options page. A popup
  save no longer rebuilds the whole settings object, so those options-page
  values are preserved instead of being reset.

### Removed
- The popup's broken drag-to-resize grip (and its persisted size).

### Fixed
- Translator source/target panels no longer desync: the source textarea is no
  longer independently resizable, so both panels stay equal height.

## [1.7.0]

### Added
- **llama.cpp** support as a third local LLM provider (`llama-server`, default
  `http://localhost:8080`), alongside Ollama and LMStudio.

## [1.6.3]

### Fixed
- Content Security Policy (CSP) tightened for extension pages.
- Allow HTTP requests to remote LLM servers on the local network.
- Stuck "translation in progress" status message.
- Sentence splitting no longer corrupts decimal numbers.
- `SKIP_TAGS` are now checked across ancestor elements in `shouldSkipElement`.

### Changed
- Translation cache reworked into a three-mode `cacheMode` (don't cache /
  session-only / persist across sessions) with browser-compatibility fallback,
  a slimmer popup, and general UX polish.

## [1.6.x]

### Added
- Optional **translation cache**: persistent (IndexedDB) or session-only
  (in-memory), plus in-request de-duplication of identical segments.
- Searchable and pinnable language/model selectors, and a resizable popup.
- Sentence-level segmentation and a floating translate button.
- Support for custom (remote) Ollama/LMStudio server URLs.

### Changed
- Shared language definitions extracted to `languages.js`.
- More robust background translation with retry logic and auto request-format
  detection.

## Earlier history

Development prior to this fork — including the initial extension, TranslateGemma
support, context-menu translation, parallel LLM requests, and the privacy-focused
architecture — is credited to the upstream project by
[Eldoprano](https://github.com/Eldoprano/offline-browser-translate).

[Unreleased]: https://github.com/carneirofc/offline-browser-translate/compare/v2.0.0...HEAD
[2.0.0]: https://github.com/carneirofc/offline-browser-translate/compare/v1.8.0...v2.0.0
[1.8.0]: https://github.com/carneirofc/offline-browser-translate/compare/v1.7.0...v1.8.0
[1.7.0]: https://github.com/carneirofc/offline-browser-translate/releases/tag/v1.7.0
[1.6.3]: https://github.com/carneirofc/offline-browser-translate/releases/tag/v1.6.3
