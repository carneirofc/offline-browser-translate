# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

> **Note:** This is a fork of
> [Eldoprano/offline-browser-translate](https://github.com/Eldoprano/offline-browser-translate)
> by [Eldoprano](https://github.com/Eldoprano). Entries below track changes made
> in this fork.

## [Unreleased]

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
