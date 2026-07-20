<h1 align="center">
  <img src="assets/logo.png" width="48" valign="middle"> Local LLM Translate
</h1>

A privacy-focused browser extension that translates web pages using a local llama-server (llama.cpp's OpenAI-compatible server). **Your data never leaves your machine.**

<p align="center">
  <a href="https://github.com/carneirofc/offline-browser-translate/actions/workflows/lint.yml"><img src="https://github.com/carneirofc/offline-browser-translate/actions/workflows/lint.yml/badge.svg" alt="Lint"></a>
  <a href="https://github.com/carneirofc/offline-browser-translate/actions/workflows/codeql.yml"><img src="https://github.com/carneirofc/offline-browser-translate/actions/workflows/codeql.yml/badge.svg" alt="CodeQL"></a>
  <a href="https://github.com/carneirofc/offline-browser-translate/actions/workflows/release.yml"><img src="https://github.com/carneirofc/offline-browser-translate/actions/workflows/release.yml/badge.svg" alt="Release"></a>
  <a href="https://github.com/carneirofc/offline-browser-translate/releases/latest"><img src="https://img.shields.io/github/v/release/carneirofc/offline-browser-translate" alt="Latest release"></a>
</p>

[![Get the Add-on](https://extensionworkshop.com/assets/img/documentation/publish/get-the-addon-178x60px.dad84b42.png)](https://addons.mozilla.org/en-GB/firefox/addon/local-llm-translator/)

> ### About this fork
>
> This is a **hard fork** of [**Eldoprano/offline-browser-translate**](https://github.com/Eldoprano/offline-browser-translate) — the original
> privacy-focused local-LLM page translator by [Eldoprano](https://github.com/Eldoprano). Building on that
> foundation, this repository is **tailored to my own needs** and made publicly
> available under the same MIT license.
>
> It is deliberately **not** a drop-in mirror of upstream: I plan **major
> refactoring** and intend to follow a **different roadmap**, which is why it
> lives as an independent, separately-maintained fork rather than a branch or a
> stream of pull requests back to the original. Full credit for the original
> extension, its architecture, and its privacy-first design goes to Eldoprano;
> the [CHANGELOG](CHANGELOG.md) tracks what has diverged here.

## Features

- 🔒 **100% Private** - All translations happen on your local machine via a local llama-server (llama.cpp's OpenAI-compatible server)
- 🎯 **Smart Prioritization** - Visible content and headings are translated first
- 🌍 **Many Languages** - Supports many many languages :3
- ⚡ **Translation Cache** - Optional: translate identical text once and reuse it (great for forums). Off by default; stored locally with a session-only or persistent mode

## Requirements

You need [**llama.cpp**](https://github.com/ggml-org/llama.cpp)'s `llama-server` running locally with a translation-capable model loaded (e.g. `TranslateGemma`, `tencent.hunyuan-mt`, `qwen3`, etc.):

```bash
llama-server -hf <model> --port 8080
```

Then point the extension's **Server URL** (in Advanced Settings / Options) at `http://localhost:8080` — this is the default.

## Installation

Download the latest packaged zip from the [Releases page](https://github.com/carneirofc/offline-browser-translate/releases/latest) and unzip it, then load it as an unpacked/temporary add-on below. (Or clone the repo and point the loader at your local copy.)

### Firefox / Mullvad Browser
1. Go to `about:debugging#/runtime/this-firefox`
2. Click **Load Temporary Add-on**
3. Select the `manifest.json` file

### Chrome / Chromium
1. Go to `chrome://extensions`
2. Enable **Developer mode**
3. Click **Load unpacked**
4. Select the extension folder

**Coming Soon:** Extension in Chrome Web Store

## Preview

<p align="center">
  <img src="assets/translating.png" width="600" alt="Extension Screenshot">
</p>

## Usage

1. Click the extension icon
2. Select a model from the dropdown
3. Choose your target language
4. Click **Translate Page**

The extension will:
- Extract all visible text from the page
- Prioritize headings and visible content
- Translate in batches with progress percentage
- Auto-translate new content (infinite scroll)

## Privacy

This extension is designed to be privacy-focused:

- ✅ Only connects to `localhost` - no external network requests
- ✅ No analytics or tracking
- ✅ No data collection
- ✅ Minimal permissions (only `localhost` host permissions)
- ✅ The translation cache is **off by default**. When enabled it is stored **locally** (in memory, or IndexedDB for the persistent mode) and never leaves your machine; it can be set to clear on browser close, turned off, or cleared at any time

## Settings

Click **Advanced Settings** to configure:

| Setting | Description |
|---------|-------------|
| Server URL | Endpoint for your local llama-server (default `http://localhost:8080`) |
| Max tokens/items per batch | Control batch sizes |
| Temperature | Model creativity (lower = more consistent) |
| Show Glow | Toggle visual indicator on translated text |
| Cache translations | Reuse stored translations for identical text — *off* (default), *until browser close*, or *across sessions*; includes a "Clear cache" button |

## Translation Cache

To avoid re-translating the same text over and over (forum boilerplate, menus, usernames, repeated phrases), translations can be cached locally and reused — both later on the same page and across other pages. It is **off by default**; enable it in Options or the popup's Advanced Settings.

- **Modes (Options → Translation Cache):**
  - **Don't cache** (default) — every segment is translated fresh.
  - **Until I close the browser** — cache speeds things up while you browse, then is wiped on the next browser start. Kept in memory, so nothing translation-related lingers on disk between sessions. Works in every browser.
  - **Keep across sessions** — cache persists on disk (IndexedDB) until you clear it. Best for repeatedly visiting the same sites. Hardened browsers that block IndexedDB (e.g. Mullvad/Tor-based Firefox) disable this option automatically and fall back to the in-memory session cache.
- **What's cached:** the translated output for each source text segment, stored locally (in memory, or IndexedDB for the persistent mode) — nothing is uploaded.
- **How it's keyed:** by the source text plus everything that determines the model's output — model, source & target language, prompt template, structured-output mode, and temperature. Changing any of these yields fresh translations instead of stale cached ones, so the cache never serves output that wouldn't match your current settings.
- **De-duplication:** within a single page, identical strings are translated only once and the result is reused for every occurrence (this happens regardless of cache mode).
- **Clearing:** use **Clear cache** to wipe it at any time (the button shows the current entry count). The cache is capped (oldest entries are evicted first).

## File Structure

```
├── manifest.json      # Extension manifest (MV3)
├── background.js      # Background script (settings, message routing)
├── llama-server.js    # OpenAI-compatible llama-server client
├── translate-pipeline.js # Batching, cache, response parsing, image description
├── content.js         # Content script (DOM manipulation)
├── popup/
│   ├── popup.html     # Popup UI
│   ├── popup.css      # Styles (Everforest Dark theme)
│   └── popup.js       # Popup logic
└── icons/             # Extension icons
```

## Development

The **shipped extension** is intentionally simple — pure vanilla JavaScript, no
runtime dependencies, no bundler, and no build step. Load the folder directly in
the browser and it runs.

The only tooling is **dev-time linting and packaging** (it never ships to users):

```bash
npm ci            # install dev tools (ESLint, web-ext)
npm test          # run the unit tests (Node's built-in test runner)
npm run lint      # ESLint — static analysis + JSDoc enforcement
npm run lint:ext  # web-ext lint (validates manifest.json)
npm run build     # package into web-ext-artifacts/*.zip
```

`npm run lint` uses ESLint with **`eslint-plugin-jsdoc`**, which fails the build
on missing or malformed JSDoc for top-level functions, so the codebase stays
documented. `npm test` runs the pure translation helpers
(`translation-core.js`) under `node --test`. Both are **dev-only**: the shipped
extension contains no `node_modules` and no test/lint files.

CI runs these on every PR (`ESLint` + `web-ext lint`), plus **CodeQL** security
analysis. Pushing a `v*` tag builds the zip, creates a GitHub Release, and — when
the `AMO_JWT_ISSUER` / `AMO_JWT_SECRET` repository secrets are set — auto-submits
the signed build to [addons.mozilla.org](https://addons.mozilla.org/) using
`amo-metadata.json` for the listing details.

### Debug Logging

Enable **"Enable debug logging"** in Options → Output Settings, then Save.

To view logs, go to `about:debugging#/runtime/this-firefox`, find **Local LLM Translate Extension**, and click **Inspect** — messages with `[Background]` prefix appear in the Console tab.

## Credits

The original **offline-browser-translate** extension — the core idea, the
privacy-first on-device architecture, and the bulk of the initial
implementation — was created by [**Eldoprano**](https://github.com/Eldoprano/offline-browser-translate). All credit for that
groundwork goes to them.

This repository is a **hard fork** maintained by
[carneirofc](https://github.com/carneirofc/offline-browser-translate), tailored to my own needs and published
independently. It carries the upstream MIT license and copyright notice, and it
is heading in its own direction — expect major refactoring and a roadmap that
diverges from upstream over time.

## License

[MIT](LICENSE) — see the [LICENSE](LICENSE) file for the full text.
