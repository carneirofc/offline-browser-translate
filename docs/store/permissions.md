# Permission justifications (store review)

Reviewer-facing rationale for every permission requested by
`manifest.json`. All processing is on-device; no permission is used to collect
or transmit user data off the device. See [`PRIVACY.md`](../../PRIVACY.md).

## Required permissions

| Permission | Justification |
|------------|---------------|
| `activeTab` | Grants access to the current tab when the user clicks the toolbar button or a context-menu item, so the extension can read the page text to translate and write the translation back. Scoped to explicit user action. |
| `storage` | Persists the user's own settings (server URL, chosen model, target language, prompt template, cache mode) and, when the user enables it, the optional local translation cache. All data stays in the browser's local storage. |
| `scripting` | Injects the content script that extracts page text and renders translations in place. Injection happens on user action (translate a page/selection) or, for the opt-in hover feature, into pages the user has granted access to. |
| `contextMenus` | Adds the right-click entries: "Translate selection", "Translate page", and "Describe & interpret image". These are the primary way users trigger the extension without opening the popup. |

## Host permissions

| Host permission | Justification |
|-----------------|---------------|
| `http://localhost/*` (required) | The extension talks to the user's **own** local LLM server (llama.cpp's `llama-server`, default `http://localhost:8080`) to perform translation and image description. This is the only network destination in the default configuration. |
| `<all_urls>` (**optional**, requested on demand) | Requested only when the user opts into a feature that must run on arbitrary sites: the persistent hover-to-translate bubble and cross-origin image "Describe & interpret". It is used solely to inject the on-page UI into the site the user is viewing — never to send page data to any third party. Users can decline it, and the core translate-page/selection flows work without it via `activeTab`. |

## Data collection

None. The Firefox manifest declares `data_collection_permissions.required = ["none"]`.
No analytics, no tracking, no remote logging, no accounts.
