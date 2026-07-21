# Privacy Policy — Local LLM Translate Extension

_Last updated: 2026-07-20_

Local LLM Translate Extension ("the extension") is designed so that **your
content never leaves your device**. This policy explains, in plain terms, what
the extension does and does not do with your data.

## The short version

- **On-device only.** All translation and image description happen by talking to
  a local LLM server (llama.cpp's `llama-server`) that **you** run on your own
  machine. The extension sends page text and images to that local server and
  nowhere else.
- **Localhost-only network.** Out of the box the extension only contacts
  `http://localhost` (default `http://localhost:8080`). It makes **no** requests
  to the extension author, to any analytics endpoint, or to any third party.
- **No analytics, no tracking, no accounts.** There is no telemetry, no
  fingerprinting, no ad SDK, and no sign-in. Nothing about your browsing is
  reported anywhere.
- **No data collection.** The extension does not collect, sell, or share your
  personal data. There is no server operated by the author that receives your
  data — the only server involved is the one running on your own computer.

## What data the extension handles

| Data | Where it goes | Why |
|------|---------------|-----|
| Text extracted from web pages you choose to translate | Your local `llama-server` only | To produce the translation |
| Images you right-click to "Describe & interpret" | Your local `llama-server` only | To generate the description |
| Your settings (server URL, model, target language, prompt, cache mode, etc.) | Your browser's local extension storage | To remember your preferences |
| Optional translation cache | Your device only — in memory, or IndexedDB for the persistent mode | To avoid re-translating identical text |

None of this data is transmitted off your device by the extension.

## The translation cache

Caching is **off by default**. When you enable it:

- It stores the translated output for text segments, keyed locally.
- "Until I close the browser" keeps the cache in memory and wipes it when the
  browser restarts.
- "Keep across sessions" stores it on disk in IndexedDB until you clear it.
- You can clear the cache at any time from Options → **Clear cache**.

The cache never leaves your machine.

## Network destinations

The extension talks only to the LLM server address you configure — `localhost`
by default. If you deliberately point the **Server URL** at a different address
on your own network, the extension will contact that address instead; that is a
configuration choice you make, and the extension still contacts nothing else.

The optional `<all_urls>` permission (see the permission justifications) is used
only to **inject the on-page translation/hover UI into the site you are viewing**
— it is not used to send your data anywhere.

## Data collection disclosure (Firefox)

The Firefox add-on manifest declares data collection as **`none`**, consistent
with this policy.

## Changes to this policy

If this policy changes, the updated version will be committed to this repository
and the "Last updated" date above will change.

## Contact

Questions? Open an issue at
<https://github.com/carneirofc/offline-browser-translate/issues>.
