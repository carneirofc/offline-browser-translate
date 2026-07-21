# Store listing copy — AMO + Chrome Web Store

Paste-ready listing content for both stores. Keep in sync with the extension
name (`Local LLM Translate Extension`) and version (`2.0.0`) in
[`manifest.json`](../../manifest.json).

- **Extension name:** Local LLM Translate Extension
- **Short name:** LLMTranslate
- **Category:** Privacy & Security (`privacy-security`)
- **Homepage:** https://github.com/carneirofc/offline-browser-translate
- **Privacy policy URL:** https://github.com/carneirofc/offline-browser-translate/blob/main/PRIVACY.md

## Summary / short description

Used for the AMO "Summary" and the Chrome Web Store short description
(Chrome limit: 132 characters — the line below is within it).

> Translate any web page with your own local LLM (llama.cpp). 100% private — your text never leaves your device.

## Long description

> **Translate the web with a local LLM — privately.**
>
> Local LLM Translate Extension translates web pages using an LLM you run on
> your own machine (llama.cpp's OpenAI-compatible `llama-server`). Your page
> text and images are sent only to `localhost` — never to us, never to any
> cloud service, never to any analytics endpoint.
>
> **Why you'll like it**
>
> - 🔒 **100% private** — all translation happens on your device; nothing leaves your machine.
> - 🌍 **Many languages** — with source-language auto-detection so you don't have to pick.
> - ⚡ **Optional local cache** — reuse identical translations (great for forums); off by default, and it never leaves your device.
> - 🖱️ **Right-click to translate** a selection or the whole page, or hover-to-translate with a modifier key.
> - 🖼️ **Describe & interpret images** with a local vision model.
> - 🧩 **No account, no telemetry, no tracking.**
>
> **Requirements**
>
> You need llama.cpp's `llama-server` running locally with a translation-capable
> model loaded (e.g. TranslateGemma, Hunyuan-MT, Qwen3):
>
>     llama-server -hf <model> --port 8080
>
> Then point the extension's Server URL at `http://localhost:8080` (the default).
>
> Open source (MIT): https://github.com/carneirofc/offline-browser-translate

## Screenshot & promo-tile requirements

> ⚠️ **Manual step — not producible from code.** The images below must be
> captured from the running extension against a live `llama-server`, then added
> to `assets/store/`. Existing raw material lives in `assets/` (`translating.png`,
> `screenshot.png`) but has not been resized/cropped to store specs.

**Screenshots to capture**

1. A web page mid-translation (glow/typewriter visible).
2. The toolbar popup (model + language pickers, Translate Page).
3. The Options page (server URL, model, cache mode).

**Chrome Web Store dimensions**

- Screenshots: **1280×800** or **640×400** (1280×800 preferred), PNG/JPEG.
- Small promo tile: **440×280** PNG/JPEG.
- (Optional) Marquee promo tile: **1400×560**.

**Firefox AMO dimensions**

- Screenshots: no fixed size; **1280×800** captures reuse cleanly.

## AMO metadata

The machine-readable AMO fields (summary, category, release-notes pointer) live
in [`amo-metadata.json`](../../amo-metadata.json) and are consumed by
`web-ext sign` in the release workflow. Keep its `summary` in sync with the
short description above.
