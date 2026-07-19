# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

> **Note:** This is a fork of
> [Eldoprano/offline-browser-translate](https://github.com/Eldoprano/offline-browser-translate)
> by [Eldoprano](https://github.com/Eldoprano). Entries below track changes made
> in this fork.

## [Unreleased]

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
  bytes, model, and target language, so re-describing the same picture is instant.
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

[Unreleased]: https://github.com/carneirofc/offline-browser-translate/compare/v1.7.0...HEAD
[1.7.0]: https://github.com/carneirofc/offline-browser-translate/releases/tag/v1.7.0
[1.6.3]: https://github.com/carneirofc/offline-browser-translate/releases/tag/v1.6.3
