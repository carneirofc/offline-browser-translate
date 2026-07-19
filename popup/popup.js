/**
 * Popup Script for Local LLM Translator
 */

// Use browser API with chrome fallback for Firefox compatibility
const browserAPI = typeof browser !== 'undefined' ? browser : chrome;

// DEFAULT_SETTINGS is provided by defaults.js (loaded before this script).

// DOM Elements
const elements = {
    providerStatus: document.getElementById('providerStatus'),
    modelPickerEl: document.getElementById('modelPickerEl'),
    modelTrigger: document.getElementById('modelTrigger'),
    modelTriggerLabel: document.getElementById('modelTriggerLabel'),
    modelMenu: document.getElementById('modelMenu'),
    modelSearch: document.getElementById('modelSearch'),
    modelList: document.getElementById('modelList'),
    refreshModels: document.getElementById('refreshModels'),
    languagePicker: document.getElementById('languagePicker'),
    langTrigger: document.getElementById('langTrigger'),
    langTriggerLabel: document.getElementById('langTriggerLabel'),
    langMenu: document.getElementById('langMenu'),
    langSearch: document.getElementById('langSearch'),
    langList: document.getElementById('langList'),
    sourceLangGroup: document.getElementById('sourceLangGroup'),
    detectedLang: document.getElementById('detectedLang'),
    sourceLangOverride: document.getElementById('sourceLangOverride'),
    translateBtn: document.getElementById('translateBtn'),
    cancelBtn: document.getElementById('cancelBtn'),
    restoreBtn: document.getElementById('restoreBtn'),
    showGlow: document.getElementById('showGlow'),
    floatingButton: document.getElementById('floatingButton'),
    openOptions: document.getElementById('openOptions'),
    toast: document.getElementById('toast')
};

let currentSettings = { ...DEFAULT_SETTINGS };
/** Log to the console only when debug mode is enabled in settings. */
function debugLog(...args) { if (currentSettings.debug) console.log(...args); }
let isTranslating = false;
let detectedPageLanguage = 'en';

/** Detect page language from active tab (using programmatic injection). */
async function detectPageLanguage() {
    if (elements.detectedLang) {
        elements.detectedLang.textContent = 'Detecting...';
    }

    try {
        const [tab] = await browserAPI.tabs.query({ active: true, currentWindow: true });
        if (tab && tab.id) {
            // DIRECT INJECTION: Read language without requiring content script
            const result = await browserAPI.scripting.executeScript({
                target: { tabId: tab.id },
                func: () => {
                    // Try HTML lang attribute
                    const htmlLang = document.documentElement.lang || document.querySelector('html')?.getAttribute('lang');
                    if (htmlLang) return htmlLang.split('-')[0].toLowerCase();

                    // Try meta tag
                    const metaLang = document.querySelector('meta[http-equiv="content-language"]')?.getAttribute('content');
                    if (metaLang) return metaLang.split('-')[0].toLowerCase();

                    return 'en'; // Default
                }
            });

            if (result && result[0] && result[0].result) {
                detectedPageLanguage = result[0].result;
                if (elements.detectedLang) {
                    const langName = LANGUAGES[detectedPageLanguage] || detectedPageLanguage.toUpperCase();
                    elements.detectedLang.textContent = langName;
                }
            } else {
                throw new Error('No result from script');
            }
        }
    } catch (e) {
        console.error('Language detection failed:', e);
        if (elements.detectedLang) {
            elements.detectedLang.textContent = 'unknown';
        }
    }
}

/** Populate source language override dropdown. */
function populateSourceLangOverride() {
    if (!elements.sourceLangOverride) return;

    elements.sourceLangOverride.innerHTML = '<option value="auto">Use detected</option>';
    const sortedLangs = Object.entries(LANGUAGES).sort((a, b) => a[1].localeCompare(b[1]));

    for (const [code, name] of sortedLangs) {
        const option = document.createElement('option');
        option.value = code;
        option.textContent = name;
        elements.sourceLangOverride.appendChild(option);
    }
}

// Toast status icons (feather-style, inherit currentColor).
const TOAST_ICON_SUCCESS = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="20 6 9 17 4 12"/></svg>';
const TOAST_ICON_ERROR = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg>';

/** Show toast notification. */
function showToast(message, type = 'success', duration = 3000) {
    const toast = elements.toast;
    const icon = toast.querySelector('.toast-icon');
    const msg = toast.querySelector('.toast-message');

    icon.innerHTML = type === 'success' ? TOAST_ICON_SUCCESS : TOAST_ICON_ERROR;
    msg.textContent = message;

    if (type === 'error') {
        toast.style.borderColor = 'var(--danger)';
        toast.style.color = 'var(--danger)';
        icon.style.color = 'var(--danger)';
    } else {
        toast.style.borderColor = 'AccentColor';
        toast.style.color = 'AccentColor';
        icon.style.color = 'var(--ok)';
    }

    toast.classList.add('show');
    setTimeout(() => {
        toast.classList.remove('show');
    }, duration);
}

/** Initialize popup. */
async function init() {
    populateLanguageDropdown();
    initModelPicker();
    populateSourceLangOverride();
    await loadSettings();
    applySettingsToUI();
    setupEventListeners();
    await checkProviders();
    await loadModels();
    await checkTranslationStatus();
    await detectPageLanguage();
}

// ============================================================================
// Shared dropdown picker: a searchable list with pinnable items. Pinned items
// float to the top under a "Pinned" header (separated by a line) for quick
// access; a pin toggle lives on each row. Used for both the target-language and
// the model selectors — callers supply the element refs and item accessors via
// createPicker(config), so list/search/keyboard/pin logic lives here once.
// ============================================================================
const PIN_ICON_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 17v5"/><path d="M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H8a2 2 0 0 0 0 4 1 1 0 0 1 1 1z"/></svg>';

/**
 * Build a searchable, pinnable dropdown picker.
 * @param {object} config
 *  - els: { picker, trigger, label, menu, search, list } — DOM refs
 *  - getItems(): item[]                — current full list of selectable items
 *  - getId(item) / getName(item)       — identity + display name for an item
 *  - restGroupLabel: string            — header shown above the non-pinned group
 *  - emptyText(filter): string         — text shown when nothing matches
 *  - labelFor(id): string              — trigger label for the current value
 *  - decorateOption?(li, item): void   — optional hook to append extra markup
 *  - isValidId?(id): boolean           — optional filter applied in setPinned
 *  - initialValue?: string             — starting value (default '')
 */
function createPicker(config) {
    const { els, getItems, getId, getName } = config;

    return {
        value: config.initialValue ?? '',
        pinned: [],
        open: false,
        activeIndex: -1,
        visibleIds: [],
        onChange: null,       // (id) => void
        onPinnedChange: null, // (pinnedArray) => void

        init() {
            els.trigger.addEventListener('click', () => this.toggle());
            els.search.addEventListener('input', () => {
                this.activeIndex = -1;
                this.render();
            });
            els.search.addEventListener('keydown', (e) => this.handleKeydown(e));
            // Close when clicking outside the picker
            document.addEventListener('click', (e) => {
                if (this.open && !els.picker.contains(e.target)) this.close();
            });
        },

        getValue() { return this.value; },

        setValue(id) {
            this.value = id;
            els.label.textContent = config.labelFor(id);
        },

        setPinned(arr) {
            const list = Array.isArray(arr) ? arr : [];
            this.pinned = config.isValidId ? list.filter(config.isValidId) : [...list];
        },

        isPinned(id) { return this.pinned.includes(id); },

        togglePin(id) {
            this.pinned = this.isPinned(id)
                ? this.pinned.filter(p => p !== id)
                : [...this.pinned, id];
            if (this.onPinnedChange) this.onPinnedChange([...this.pinned]);
            this.render();
        },

        select(id) {
            this.setValue(id);
            this.close();
            if (this.onChange) this.onChange(id);
        },

        toggle() { this.open ? this.close() : this.openMenu(); },

        openMenu() {
            this.open = true;
            els.picker.classList.add('open');
            els.menu.hidden = false;
            els.trigger.setAttribute('aria-expanded', 'true');
            els.search.value = '';
            this.activeIndex = -1;
            this.render();
            els.search.focus();
            // Scroll the selected row into view
            const sel = els.list.querySelector('.lang-option.selected');
            if (sel) sel.scrollIntoView({ block: 'nearest' });
        },

        close() {
            this.open = false;
            els.picker.classList.remove('open');
            els.menu.hidden = true;
            els.trigger.setAttribute('aria-expanded', 'false');
        },

        // Build the option list, applying the current search filter and pin grouping
        render() {
            const filter = els.search.value.trim().toLowerCase();
            const match = (item) => !filter
                || getName(item).toLowerCase().includes(filter)
                || String(getId(item)).toLowerCase().includes(filter);

            const pinnedSet = new Set(this.pinned);
            const sorted = [...getItems()].sort((a, b) => getName(a).localeCompare(getName(b)));
            const pinnedItems = sorted.filter(i => pinnedSet.has(getId(i)) && match(i));
            const restItems = sorted.filter(i => !pinnedSet.has(getId(i)) && match(i));

            const list = els.list;
            list.innerHTML = '';
            this.visibleIds = [];

            if (!pinnedItems.length && !restItems.length) {
                const empty = document.createElement('li');
                empty.className = 'lang-empty';
                empty.textContent = config.emptyText(filter);
                list.appendChild(empty);
                return;
            }

            if (pinnedItems.length) {
                list.appendChild(this.makeGroupLabel('Pinned'));
                pinnedItems.forEach(i => list.appendChild(this.makeOption(i, true)));
                if (restItems.length) {
                    const sep = document.createElement('li');
                    sep.className = 'lang-separator';
                    sep.setAttribute('aria-hidden', 'true');
                    list.appendChild(sep);
                    list.appendChild(this.makeGroupLabel(config.restGroupLabel));
                }
            }
            restItems.forEach(i => list.appendChild(this.makeOption(i, false)));

            this.updateActive();
        },

        makeGroupLabel(text) {
            const li = document.createElement('li');
            li.className = 'lang-group-label';
            li.textContent = text;
            li.setAttribute('aria-hidden', 'true');
            return li;
        },

        makeOption(item, pinned) {
            const id = getId(item);
            const name = getName(item);
            const li = document.createElement('li');
            li.className = 'lang-option' + (pinned ? ' pinned' : '') + (id === this.value ? ' selected' : '');
            li.setAttribute('role', 'option');
            li.dataset.id = id;
            if (id === this.value) li.setAttribute('aria-selected', 'true');

            const nameEl = document.createElement('span');
            nameEl.className = 'lang-option-name';
            nameEl.textContent = name;
            li.appendChild(nameEl);

            if (config.decorateOption) config.decorateOption(li, item);

            const pinBtn = document.createElement('button');
            pinBtn.type = 'button';
            pinBtn.className = 'lang-pin-btn';
            pinBtn.innerHTML = PIN_ICON_SVG;
            pinBtn.title = pinned ? `Unpin ${name}` : `Pin ${name}`;
            pinBtn.setAttribute('aria-label', pinBtn.title);
            pinBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                this.togglePin(id);
            });
            li.appendChild(pinBtn);

            li.addEventListener('click', () => this.select(id));

            const idx = this.visibleIds.length;
            li.addEventListener('mousemove', () => {
                if (this.activeIndex !== idx) { this.activeIndex = idx; this.updateActive(); }
            });
            this.visibleIds.push(id);
            return li;
        },

        // Reflect activeIndex onto the rows for keyboard navigation highlight
        updateActive() {
            const rows = els.list.querySelectorAll('.lang-option');
            rows.forEach((row, i) => {
                const active = i === this.activeIndex;
                row.classList.toggle('active', active);
                if (active) row.scrollIntoView({ block: 'nearest' });
            });
        },

        handleKeydown(e) {
            if (e.key === 'ArrowDown') {
                e.preventDefault();
                if (this.visibleIds.length) {
                    this.activeIndex = Math.min(this.activeIndex + 1, this.visibleIds.length - 1);
                    this.updateActive();
                }
            } else if (e.key === 'ArrowUp') {
                e.preventDefault();
                if (this.visibleIds.length) {
                    this.activeIndex = Math.max(this.activeIndex - 1, 0);
                    this.updateActive();
                }
            } else if (e.key === 'Enter') {
                e.preventDefault();
                const idx = this.activeIndex >= 0 ? this.activeIndex : 0;
                const id = this.visibleIds[idx];
                if (id) this.select(id);
            } else if (e.key === 'Escape') {
                e.preventDefault();
                this.close();
                els.trigger.focus();
            }
        }
    };
}

// Target-language picker: items are [code, name] entries from LANGUAGES.
const langPicker = createPicker({
    els: {
        picker: elements.languagePicker,
        trigger: elements.langTrigger,
        label: elements.langTriggerLabel,
        menu: elements.langMenu,
        search: elements.langSearch,
        list: elements.langList,
    },
    getItems: () => Object.entries(LANGUAGES),
    getId: (entry) => entry[0],
    getName: (entry) => entry[1],
    restGroupLabel: 'All languages',
    emptyText: () => 'No languages match your search',
    labelFor: (code) => LANGUAGES[code] || code,
    isValidId: (code) => !!LANGUAGES[code],
    initialValue: 'en',
});

// Model picker: items are { id, name, provider } objects loaded from providers.
// allModels lives on the instance and feeds getItems(); model-specific helpers
// (setModels / getSelectedProvider) are attached after creation.
const modelPicker = createPicker({
    els: {
        picker: elements.modelPickerEl,
        trigger: elements.modelTrigger,
        label: elements.modelTriggerLabel,
        menu: elements.modelMenu,
        search: elements.modelSearch,
        list: elements.modelList,
    },
    getItems: () => modelPicker.allModels,
    getId: (m) => m.id,
    getName: (m) => m.name,
    restGroupLabel: 'All models',
    emptyText: () => modelPicker.allModels.length === 0 ? 'No models available' : 'No models match your search',
    labelFor: (id) => {
        const m = modelPicker.allModels.find(x => x.id === id);
        return m ? m.name : (id || 'Select a model');
    },
    decorateOption: (li, m) => {
        const badge = document.createElement('span');
        badge.className = 'model-provider-badge';
        badge.textContent = m.provider;
        li.appendChild(badge);
    },
});

modelPicker.allModels = [];

modelPicker.getSelectedProvider = function () {
    const m = this.allModels.find(x => x.id === this.value);
    return m ? m.provider : null;
};

modelPicker.setModels = function (models) {
    this.allModels = models;
    // Drop pinned ids that no longer exist in the model list
    const ids = new Set(models.map(m => m.id));
    this.pinned = this.pinned.filter(id => ids.has(id));
};

/** Initialize the model picker and wire it to settings persistence. */
function initModelPicker() {
    modelPicker.onChange = (id) => {
        currentSettings.selectedModel = id;
        saveCurrentSettings();
    };
    modelPicker.onPinnedChange = (pinned) => {
        currentSettings.pinnedModels = pinned;
        saveCurrentSettings();
    };
    modelPicker.init();
}

/** Initialize the language picker and wire it to settings persistence. */
function populateLanguageDropdown() {
    langPicker.onChange = (code) => {
        currentSettings.targetLanguage = code;
        saveCurrentSettings();
    };
    langPicker.onPinnedChange = (pinned) => {
        currentSettings.pinnedLanguages = pinned;
        saveCurrentSettings();
    };
    langPicker.init();
}

/** Check if translation is already running in active tab. */
async function checkTranslationStatus() {
    try {
        const [tab] = await browserAPI.tabs.query({ active: true, currentWindow: true });
        if (tab && tab.id) {
            const response = await browserAPI.tabs.sendMessage(tab.id, { type: 'GET_TRANSLATION_STATUS' });
            if (response && response.isTranslating) {
                isTranslating = true;
                elements.translateBtn.disabled = true;
                elements.translateBtn.querySelector('.btn-text').hidden = true;
                elements.translateBtn.querySelector('.btn-loading').hidden = false;
                elements.cancelBtn.hidden = false;
            }
        }
    } catch (e) {
        // Content script might not be injected yet, which is fine
    }
}

/** Load settings from storage. */
async function loadSettings() {
    try {
        const response = await browserAPI.runtime.sendMessage({ type: 'GET_SETTINGS' });
        if (response.settings) {
            currentSettings = { ...DEFAULT_SETTINGS, ...response.settings };
        }
    } catch (e) {
        console.error('Failed to load settings:', e);
    }
}

/** Apply settings to UI. */
function applySettingsToUI() {
    langPicker.setPinned(currentSettings.pinnedLanguages || []);
    langPicker.setValue(currentSettings.targetLanguage);
    modelPicker.setPinned(currentSettings.pinnedModels || []);
    elements.showGlow.checked = currentSettings.showGlow !== false;
    if (elements.floatingButton) elements.floatingButton.checked = !!currentSettings.floatingButton;

    // Restore source language override
    if (elements.sourceLangOverride && currentSettings.sourceLanguage) {
        elements.sourceLangOverride.value = currentSettings.sourceLanguage;
    }
}

// Check which providers are available
let providersAvailable = false;

/** Check which LLM providers are reachable and update the status UI accordingly. */
async function checkProviders() {
    const statusWrapper = elements.providerStatus;
    const statusDot = statusWrapper.querySelector('.status-dot');

    try {
        const response = await browserAPI.runtime.sendMessage({ type: 'DETECT_PROVIDERS' });
        
        // Resolve active provider using setting or currently selected model's provider
        const providerSetting = currentSettings.provider; // 'auto', 'ollama', 'lmstudio', 'llamacpp'
        const selectedModelProvider = modelPicker.getSelectedProvider();

        let activeProvider = providerSetting;
        if (activeProvider === 'auto' && selectedModelProvider) {
            activeProvider = selectedModelProvider;
        }

        let connected = false;
        let blocked = false;
        let blockedType = ''; // 'ollama', 'lmstudio', or 'llamacpp'
        const connectedProviders = [];

        if (response.ollama) connectedProviders.push('Ollama');
        if (response.lmstudio) connectedProviders.push('LM Studio');
        if (response.llamacpp) connectedProviders.push('llama.cpp');

        if (activeProvider === 'ollama') {
            connected = response.ollama;
            blocked = response.ollama_blocked;
            blockedType = 'ollama';
        } else if (activeProvider === 'lmstudio') {
            connected = response.lmstudio;
            blocked = response.lmstudio_blocked;
            blockedType = 'lmstudio';
        } else if (activeProvider === 'llamacpp') {
            connected = response.llamacpp;
            blocked = response.llamacpp_blocked;
            blockedType = 'llamacpp';
        } else {
            // 'auto' mode with no specific model selected yet
            connected = connectedProviders.length > 0;
            if (!connected) {
                blocked = response.ollama_blocked || response.lmstudio_blocked || response.llamacpp_blocked;
                blockedType = response.ollama_blocked ? 'ollama' : (response.lmstudio_blocked ? 'lmstudio' : 'llamacpp');
            }
        }

        if (connected) {
            statusDot.className = 'status-dot connected';
            statusWrapper.title = `Connected: ${connectedProviders.join(', ')}`;
            providersAvailable = true;
            hideSetupBanner();
        } else if (blocked) {
            statusDot.className = 'status-dot error';
            statusWrapper.title = blockedType === 'ollama'
                ? 'Ollama is running but blocking the extension (CORS)'
                : blockedType === 'lmstudio'
                    ? 'LM Studio is running but blocking the extension (CORS)'
                    : 'llama.cpp server is running but blocking the extension (CORS)';
            providersAvailable = false;
            showSetupBanner(
                blockedType === 'ollama' ? 'cors-blocked-ollama'
                    : blockedType === 'lmstudio' ? 'cors-blocked-lmstudio'
                        : 'cors-blocked-llamacpp'
            );
        } else {
            statusDot.className = 'status-dot error';
            statusWrapper.title = 'No providers found';
            providersAvailable = false;
            showSetupBanner();
        }
    } catch (e) {
        statusDot.className = 'status-dot error';
        statusWrapper.title = 'Error checking providers';
        providersAvailable = false;
        showSetupBanner();
    }
}

/** Build the inner HTML markup for the setup banner, based on its type. */
function bannerHTML(type) {
    if (type === 'no-models') {
        return `
            <div style="font-weight: bold; margin-bottom: 4px; color: var(--warn);">No translation models found</div>
            <div>Your LLM provider is connected, but you have not downloaded a translation model yet.</div>
            <div style="margin-top: 6px;">Recommended model:</div>
            <div style="background: ButtonFace; padding: 4px 8px; border-radius: 4px; font-family: monospace; display: flex; align-items: center; justify-content: space-between; margin-top: 4px;">
                <code>ollama pull translategemma</code>
            </div>
            <div style="margin-top: 6px; font-size: 11px; opacity: 0.8;">Or download a model in LM Studio (search for "translate"). Click the refresh button above when done.</div>
        `;
    }
    if (type === 'cors-blocked-ollama') {
        return `
            <div style="font-weight: bold; margin-bottom: 4px; color: var(--warn);">Ollama is blocking the extension</div>
            <div>Ollama is running, but it is not allowing requests from browser extensions (CORS policy).</div>
            <div style="margin-top: 6px; font-size: 11px; opacity: 0.8;"><a href="https://api.onlyoffice.com/docs/plugin-and-macros/ai/configuring-ollama-with-cors/" target="_blank" style="color: AccentColor;">See CORS instructions for Ollama here</a>. Click the refresh button above when done.</div>
        `;
    }
    if (type === 'cors-blocked-lmstudio') {
        return `
            <div style="font-weight: bold; margin-bottom: 4px; color: var(--warn);">LM Studio is blocking the extension</div>
            <div>LM Studio server is running, but Cross-Origin Resource Sharing (CORS) is disabled.</div>
            <div style="margin-top: 6px; line-height: 1.4;">
                To enable CORS:
                <ol style="margin: 4px 0; padding-left: 18px;">
                    <li>Open <b>LM Studio</b></li>
                    <li>Go to the <b>Developer</b> tab (server icon on the left sidebar)</li>
                    <li>Under <b>Server Settings</b>, activate <b>"Enable CORS"</b></li>
                    <li>Restart the server</li>
                </ol>
            </div>
            <div style="margin-top: 6px; font-size: 11px; opacity: 0.8;">Click the refresh button above when done.</div>
        `;
    }
    if (type === 'cors-blocked-llamacpp') {
        return `
            <div style="font-weight: bold; margin-bottom: 4px; color: var(--warn);">llama.cpp server is blocking the extension</div>
            <div>llama-server is running, but its <code style="background: ButtonFace; padding: 1px 4px; border-radius: 3px;">--cors-origins</code> setting does not allow requests from this extension.</div>
            <div style="margin-top: 6px; font-size: 11px; opacity: 0.8;">Restart llama-server with <code style="background: ButtonFace; padding: 1px 4px; border-radius: 3px;">--cors-origins "*"</code> (the default) or add this extension's origin explicitly. Click the refresh button above when done.</div>
        `;
    }
    return `
        <div style="font-weight: bold; margin-bottom: 4px; color: var(--warn);">No LLM provider detected</div>
        <div>To use this extension, you need a local LLM server running:</div>
        <ol style="margin: 6px 0 2px 18px; padding: 0;">
            <li>Install <a href="https://ollama.com" target="_blank" style="color: AccentColor;">Ollama</a>, <a href="https://lmstudio.ai" target="_blank" style="color: AccentColor;">LM Studio</a>, or <a href="https://github.com/ggml-org/llama.cpp" target="_blank" style="color: AccentColor;">llama.cpp</a></li>
            <li>Load a translation model (e.g. <code style="background: ButtonFace; padding: 1px 4px; border-radius: 3px;">ollama pull translategemma</code>)</li>
            <li>Click the refresh button above</li>
        </ol>
    `;
}

/** Show/hide first-run setup guidance banner. */
function showSetupBanner(type = 'no-provider') {
    let banner = document.getElementById('setup-banner');
    if (banner) {
        banner.hidden = false;
        // Update content if it already exists
        banner.innerHTML = bannerHTML(type);
        return;
    }

    banner = document.createElement('div');
    banner.id = 'setup-banner';
    banner.style.cssText = `
        background: Field;
        border: 1px solid var(--warn);
        border-radius: 8px;
        padding: 10px 14px;
        margin: 8px 0;
        font-size: 12px;
        line-height: 1.5;
        color: CanvasText;
    `;
    banner.innerHTML = bannerHTML(type);

    // Insert after the model selector row
    const modelRow = elements.modelPickerEl?.closest('.row') || elements.modelPickerEl?.parentElement;
    if (modelRow) {
        modelRow.parentNode.insertBefore(banner, modelRow.nextSibling);
    } else {
        document.querySelector('.popup-body, .container, body')?.prepend(banner);
    }
}

/** Hide the setup banner once a provider becomes available. */
function hideSetupBanner() {
    const banner = document.getElementById('setup-banner');
    if (banner && providersAvailable) banner.hidden = true;
}

/** Load available models. */
async function loadModels(forceRefresh = false) {
    elements.modelTrigger.disabled = true;
    elements.modelTriggerLabel.textContent = 'Loading models...';

    try {
        const response = await browserAPI.runtime.sendMessage({ type: 'LIST_MODELS', forceRefresh });
        const models = response.models || [];

        if (models.length === 0) {
            modelPicker.setModels([]);
            elements.modelTriggerLabel.textContent = 'No models found';
            elements.modelTrigger.disabled = false;
            if (providersAvailable) {
                // If any provider is blocked by CORS, prioritize showing the CORS banner
                const detectResponse = await browserAPI.runtime.sendMessage({ type: 'DETECT_PROVIDERS' }).catch(() => ({}));
                if (detectResponse.ollama_blocked || detectResponse.lmstudio_blocked || detectResponse.llamacpp_blocked) {
                    showSetupBanner(
                        detectResponse.ollama_blocked ? 'cors-blocked-ollama'
                            : detectResponse.lmstudio_blocked ? 'cors-blocked-lmstudio'
                                : 'cors-blocked-llamacpp'
                    );
                } else {
                    showSetupBanner('no-models');
                }
            }
            return;
        }

        // We have models — hide any setup banner
        hideSetupBanner();
        modelPicker.setModels(models);

        // Apply pinned now that we know the real model ids
        modelPicker.setPinned(currentSettings.pinnedModels || []);

        // Select previously saved model if still available, else first model
        const targetId = currentSettings.selectedModel && models.some(m => m.id === currentSettings.selectedModel)
            ? currentSettings.selectedModel
            : models[0].id;
        modelPicker.setValue(targetId);

        elements.modelTrigger.disabled = false;
        elements.translateBtn.disabled = false;

    } catch (e) {
        console.error('Failed to load models:', e);
        elements.modelTriggerLabel.textContent = 'Error loading models';
        elements.modelTrigger.disabled = false;
    }
}

/** Save current settings. */
async function saveCurrentSettings() {
    // Spread the current settings and override ONLY the fields the slim popup
    // owns. Provider, server URLs, token/temperature and cache mode now live on
    // the options page; keeping them out of this write means the background merge
    // preserves whatever was configured there instead of clobbering it with
    // now-deleted popup fields.
    currentSettings = {
        ...currentSettings,
        selectedModel: modelPicker.getValue(),
        pinnedModels: [...modelPicker.pinned],
        targetLanguage: langPicker.getValue(),
        pinnedLanguages: langPicker.pinned,
        showGlow: elements.showGlow.checked,
        sourceLanguage: elements.sourceLangOverride
            ? elements.sourceLangOverride.value
            : (currentSettings.sourceLanguage || 'auto')
    };

    await browserAPI.runtime.sendMessage({
        type: 'SAVE_SETTINGS',
        settings: currentSettings
    });
}

/** Reset the translate button back to its idle state. */
function resetTranslateButton() {
    isTranslating = false;
    elements.translateBtn.disabled = false;
    elements.translateBtn.querySelector('.btn-text').hidden = false;
    elements.translateBtn.querySelector('.btn-loading').hidden = true;
    elements.cancelBtn.hidden = true;
}

/** Start translation. */
async function startTranslation() {
    if (isTranslating) return;

    // --- Pre-flight checks with clear error messages ---
    const model = modelPicker.getValue();
    if (!model) {
        showToast('Please select a model first', 'error');
        return;
    }

    if (!providersAvailable) {
        showToast('No LLM provider running. Start Ollama, LM Studio, or llama.cpp first.', 'error');
        return;
    }

    isTranslating = true;
    elements.translateBtn.disabled = true;
    elements.translateBtn.querySelector('.btn-text').hidden = true;
    elements.translateBtn.querySelector('.btn-loading').hidden = false;
    elements.cancelBtn.hidden = false;

    try {
        // Save settings first
        await saveCurrentSettings();

        // Get current tab
        const [tab] = await browserAPI.tabs.query({ active: true, currentWindow: true });

        if (!tab || !tab.id) {
            throw new Error('No active tab found');
        }

        // Check if page is a restricted URL
        if (tab.url && (tab.url.startsWith('about:') || tab.url.startsWith('chrome:') ||
            tab.url.startsWith('moz-extension:') || tab.url.startsWith('chrome-extension:'))) {
            throw new Error('Cannot translate browser internal pages.');
        }

        // Try to inject content script
        try {
            await browserAPI.scripting.executeScript({
                target: { tabId: tab.id },
                files: ['/content.js']
            });
        } catch (injectErr) {
            debugLog('[Popup] Script injection note:', injectErr.message);
            // May already be injected or page doesn't allow scripts
        }

        // Wait for content script readiness (replaces fragile 100ms delay)
        let scriptReady = false;
        for (let i = 0; i < 15; i++) {
            try {
                const resp = await browserAPI.tabs.sendMessage(tab.id, { type: 'PING' });
                if (resp && resp.pong) {
                    scriptReady = true;
                    break;
                }
            } catch { }
            await new Promise(r => setTimeout(r, 100));
        }

        if (!scriptReady) {
            throw new Error('Could not connect to page. Try refreshing the page first.');
        }

        // Resolve source language: if auto, use the detected language we found earlier
        let finalSourceLang = currentSettings.sourceLanguage;
        if (finalSourceLang === 'auto' && detectedPageLanguage) {
            finalSourceLang = detectedPageLanguage;
        }

        // Send translation message (script is confirmed ready)
        try {
            const response = await browserAPI.tabs.sendMessage(tab.id, {
                type: 'START_TRANSLATION',
                targetLanguage: currentSettings.targetLanguage,
                sourceLanguage: finalSourceLang,
                showGlow: currentSettings.showGlow,
                maxConcurrentRequests: currentSettings.maxConcurrentRequests || 4
            });
            if (response && response.started) {
                return; // Success! UI stays in translating state
            }
        } catch (msgErr) {
            throw new Error('Lost connection to page. Please refresh and try again.');
        }

    } catch (e) {
        console.error('Translation error:', e);
        showToast(`Error: ${e.message}`, 'error');

        // Only reset UI on error
        resetTranslateButton();
    }
}

/** Cancel translation. */
async function cancelTranslation() {
    try {
        const [tab] = await browserAPI.tabs.query({ active: true, currentWindow: true });
        if (tab && tab.id) {
            await browserAPI.tabs.sendMessage(tab.id, { type: 'CANCEL_TRANSLATION' });
        }
    } catch (e) {
        console.error('Cancel error:', e);
    }

    resetTranslateButton();
}

/** Toggle translation on/off (uses cached translations if available). */
async function toggleTranslation() {
    try {
        const [tab] = await browserAPI.tabs.query({ active: true, currentWindow: true });
        const response = await browserAPI.tabs.sendMessage(tab.id, { type: 'TOGGLE_TRANSLATION' });

        // Update button text based on state
        if (response && response.showing === 'translated') {
            elements.restoreBtn.textContent = 'Original';
        } else {
            elements.restoreBtn.textContent = response?.hasCache ? 'Translated' : 'Restore';
        }
    } catch (e) {
        console.error('Toggle error:', e);
    }
}

/** Setup event listeners. */
function setupEventListeners() {
    // Reset the button when the content script signals it's done (e.g. a
    // cache-only run that finishes near-instantly with no progress updates).
    browserAPI.runtime.onMessage.addListener((message) => {
        if (message && message.type === 'TRANSLATION_COMPLETE') {
            resetTranslateButton();
        }
    });

    // Translate button
    elements.translateBtn.addEventListener('click', startTranslation);

    // Cancel button
    elements.cancelBtn.addEventListener('click', cancelTranslation);

    // Restore/Toggle button
    elements.restoreBtn.addEventListener('click', toggleTranslation);

    // Refresh models
    elements.refreshModels.addEventListener('click', async () => {
        await checkProviders();
        await loadModels(true); // Force refresh, bypass cache
    });

    // Floating button toggle — permission required to enable
    if (elements.floatingButton) {
        elements.floatingButton.addEventListener('change', async (e) => {
            if (e.target.checked) {
                const granted = await browserAPI.permissions.request({ origins: ['<all_urls>'] });
                if (!granted) {
                    e.target.checked = false;
                    showToast('Permission denied', 'error');
                    return;
                }
                await browserAPI.runtime.sendMessage({ type: 'REGISTER_CONTENT_SCRIPT' });
                showToast('Floating button enabled — reload pages to activate');
            } else {
                await browserAPI.runtime.sendMessage({ type: 'UNREGISTER_CONTENT_SCRIPT' });
                try { await browserAPI.permissions.remove({ origins: ['<all_urls>'] }); } catch (e) {}
                showToast('Floating button disabled — permission removed');
            }
            currentSettings.floatingButton = e.target.checked;
            await browserAPI.runtime.sendMessage({ type: 'SAVE_SETTINGS', settings: currentSettings });
        });
    }

    // (Target-language changes are handled by langPicker.onChange.)
    // (Model changes are handled by modelPicker.onChange.)

    // Glow toggle - update in real-time
    elements.showGlow.addEventListener('change', async () => {
        currentSettings.showGlow = elements.showGlow.checked;
        await saveCurrentSettings();
        // Send to content script to update existing translations
        try {
            const [tab] = await browserAPI.tabs.query({ active: true, currentWindow: true });
            if (tab && tab.id) {
                await browserAPI.tabs.sendMessage(tab.id, {
                    type: 'SET_GLOW',
                    enabled: currentSettings.showGlow
                });
            }
        } catch (e) {
            // Content script may not be loaded
        }
    });


    // Open options page
    if (elements.openOptions) {
        elements.openOptions.addEventListener('click', () => {
            browserAPI.runtime.openOptionsPage();
        });
    }

    // Open translator page
    const openTranslatorBtn = document.getElementById('openTranslator');
    if (openTranslatorBtn) {
        openTranslatorBtn.addEventListener('click', () => {
            browserAPI.tabs.create({ url: browserAPI.runtime.getURL('translator/translator.html') });
        });
    }
}

// Initialize on DOM ready
document.addEventListener('DOMContentLoaded', init);
