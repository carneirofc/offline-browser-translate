/**
 * Options Page Script for Local LLM Translator
 */

// Use browser API with chrome fallback for Firefox compatibility
const browserAPI = typeof browser !== 'undefined' ? browser : chrome;

// DEFAULT_SETTINGS is provided by defaults.js (loaded before this script).

// Format descriptions
const FORMAT_DESCRIPTIONS = {
    auto: 'Picks the right format automatically based on the selected model.',
    default: 'Standard JSON output format. Best for most models.',
    translategemma: 'Specialized format for TranslateGemma models.',
    hunyuan: 'Format optimized for Hunyuan-MT models. No system message.',
    simple: 'Simple line-by-line output for smaller models.',
    custom: 'Your custom prompts. Edit below.'
};

// Prompt templates for each format
const PROMPT_TEMPLATES = {
    default: {
        system: `You are a professional translator. Translate the given texts to {{targetLanguage}}. 
Respond ONLY with a JSON object in this exact format:
{"translations": [{"id": 0, "text": "translated text"}, {"id": 1, "text": "another translation"}]}
Maintain the original meaning, tone, and formatting. Do not add explanations.`,
        user: `Translate the following texts to {{targetLanguage}}:\n{{texts}}`
    },
    simple: {
        system: `You are a translator. Translate to {{targetLanguage}}. Output JSON only:
{"translations": [{"id": N, "text": "translation"}]}`,
        user: `Translate to {{targetLanguage}}:\n{{texts}}`
    },
    hunyuan: {
        system: '',
        user: `Translate the following segment into {{targetLanguage}}, without additional explanation.\n{{texts}}`
    },
    translategemma: {
        system: '',
        user: `You are a professional {{sourceLang}} ({{sourceCode}}) to {{targetLang}} ({{targetCode}}) translator. Your goal is to accurately convey the meaning and nuances of the original {{sourceLang}} text while adhering to {{targetLang}} grammar, vocabulary, and cultural sensitivities.
Produce only the {{targetLang}} translation, without any additional explanations or commentary. Please translate the following {{sourceLang}} text into {{targetLang}}:


{{texts}}`
    },
    custom: {
        system: '',
        user: ''
    }
};

// DOM Elements
const elements = {
    providerSelect: document.getElementById('providerSelect'),
    ollamaUrl: document.getElementById('ollamaUrl'),
    lmstudioUrl: document.getElementById('lmstudioUrl'),
    llamacppUrl: document.getElementById('llamacppUrl'),
    modelSelect: document.getElementById('modelSelect'),
    refreshModels: document.getElementById('refreshModels'),
    visionModelSelect: document.getElementById('visionModelSelect'),
    refreshVisionModels: document.getElementById('refreshVisionModels'),
    describePrompt: document.getElementById('describePrompt'),
    resetDescribePrompt: document.getElementById('resetDescribePrompt'),
    sourceLanguage: document.getElementById('sourceLanguage'),
    sourceLanguageGroup: document.getElementById('sourceLanguageGroup'),
    targetLanguage: document.getElementById('targetLanguage'),
    requestFormat: document.getElementById('requestFormat'),
    formatDescription: document.getElementById('formatDescription'),
    systemPrompt: document.getElementById('systemPrompt'),
    userPrompt: document.getElementById('userPrompt'),
    maxTokens: document.getElementById('maxTokens'),
    maxItems: document.getElementById('maxItems'),
    maxConcurrent: document.getElementById('maxConcurrent'),
    maxConcurrentValue: document.getElementById('maxConcurrentValue'),
    temperature: document.getElementById('temperature'),
    temperatureValue: document.getElementById('temperatureValue'),
    useStructuredOutput: document.getElementById('useStructuredOutput'),
    plainTextFallback: document.getElementById('plainTextFallback'),
    showGlow: document.getElementById('showGlow'),
    cacheMode: document.getElementById('cacheMode'),
    cacheBackendWarning: document.getElementById('cacheBackendWarning'),
    clearCache: document.getElementById('clearCache'),
    cacheCount: document.getElementById('cacheCount'),
    debugLogging: document.getElementById('debugLogging'),
    floatingButton: document.getElementById('floatingButton'),
    hoverEnabled: document.getElementById('hoverEnabled'),
    hoverModifier: document.getElementById('hoverModifier'),
    customPromptsSection: document.getElementById('customPromptsSection'),
    customSystem: document.getElementById('customSystem'),
    customUser: document.getElementById('customUser'),
    translateGemmaHelp: document.getElementById('translateGemmaHelp'),
    copyTemplate: document.getElementById('copyTemplate'),
    saveSettings: document.getElementById('saveSettings'),
    resetSettings: document.getElementById('resetSettings'),
    toast: document.getElementById('toast')
};

let currentSettings = { ...DEFAULT_SETTINGS };

// Highlight variables in text
function highlightVariables(text) {
    if (!text) return text;
    // Escape HTML first
    let escaped = text
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;");

    // Wrap {{variable}} in span
    return escaped.replace(/(\{\{[a-zA-Z0-9_]+\}\})/g, '<span class="highlight-var">$1</span>');
}

// Sync textarea with backdrop for highlighting
function syncEditor(textareaId, backdropId) {
    const textarea = document.getElementById(textareaId);
    const backdrop = document.getElementById(backdropId);

    if (!textarea || !backdrop) return;

    const handleInput = () => {
        // Handle scroll first
        backdrop.scrollTop = textarea.scrollTop;

        let text = textarea.value;
        if (text[text.length - 1] === '\n') {
            text += ' ';
        }
        // Use DOMParser instead of innerHTML to avoid Firefox AMO warnings
        const parser = new DOMParser();
        const doc = parser.parseFromString('<div>' + highlightVariables(text) + '</div>', 'text/html');
        // Clear backdrop using DOM methods
        while (backdrop.firstChild) {
            backdrop.removeChild(backdrop.firstChild);
        }
        // Append parsed content
        const content = doc.body.firstChild;
        while (content.firstChild) {
            backdrop.appendChild(content.firstChild);
        }
    };

    textarea.addEventListener('input', handleInput);
    textarea.addEventListener('scroll', () => {
        backdrop.scrollTop = textarea.scrollTop;
    });

    handleInput();
}

// Initialize prompt editors
function initPromptEditors() {
    syncEditor('systemPrompt', 'systemPromptBackdrop');
    syncEditor('userPrompt', 'userPromptBackdrop');
    syncEditor('describePrompt', 'describePromptBackdrop');
}

// Initialize
function showVersion() {
    const el = document.getElementById('versionInfo');
    if (!el) return;
    const manifest = browserAPI.runtime.getManifest();
    el.textContent = `${manifest.name} v${manifest.version}`;
}

async function init() {
    showVersion();
    populateLanguageDropdowns();
    await loadSettings();
    applySettingsToUI();
    initPromptEditors(); // Initialize editors
    await loadModels();
    setupEventListeners();
    refreshCacheCount();
    refreshCacheBackend();

    // The options page opens in a persistent tab, so init() only runs once. Refresh
    // the cached-entry count whenever the tab is re-focused (e.g. after translating
    // a page in another tab) so it doesn't show a stale value.
    document.addEventListener('visibilitychange', () => {
        if (!document.hidden) refreshCacheCount();
    });
}

// Grey out "Keep across sessions" when the browser blocks IndexedDB (e.g. hardened
// Firefox forks like Mullvad/Tor), since persistence can't work there.
async function refreshCacheBackend() {
    if (!elements.cacheMode) return;
    let persistent = true;
    try {
        const res = await browserAPI.runtime.sendMessage({ type: 'CACHE_BACKEND' });
        persistent = !(res && res.persistent === false);
    } catch (e) { /* assume available on error */ }

    const opt = elements.cacheMode.querySelector('option[value="persistent"]');
    if (opt) opt.disabled = !persistent;
    if (elements.cacheBackendWarning) elements.cacheBackendWarning.hidden = persistent;
    // If persistence isn't available but it was the saved choice, fall back to session.
    if (!persistent && elements.cacheMode.value === 'persistent') {
        elements.cacheMode.value = 'session';
    }
}

// Show how many translations are currently cached.
async function refreshCacheCount() {
    if (!elements.cacheCount) return;
    try {
        const res = await browserAPI.runtime.sendMessage({ type: 'CACHE_COUNT' });
        elements.cacheCount.textContent = (res && typeof res.count === 'number') ? res.count.toLocaleString() : '0';
    } catch (e) {
        elements.cacheCount.textContent = '0';
    }
}

// Load available models from providers
async function loadModels() {
    if (!elements.modelSelect) return;

    elements.modelSelect.innerHTML = '<option value="">Loading models...</option>';
    elements.modelSelect.disabled = true;
    try {
        const response = await browserAPI.runtime.sendMessage({ type: 'LIST_MODELS' });
        const models = response.models || [];

        elements.modelSelect.innerHTML = '';

        if (models.length === 0) {
            elements.modelSelect.innerHTML = '<option value="">No models found</option>';
        } else {
            for (const model of models) {
                const option = document.createElement('option');
                option.value = model.id;
                option.textContent = `${model.name} (${model.provider})`;
                option.dataset.provider = model.provider;
                elements.modelSelect.appendChild(option);
            }

            // Select current model if set
            if (currentSettings.selectedModel) {
                elements.modelSelect.value = currentSettings.selectedModel;
            }

            // Refresh the "Auto → detected format" hint for the selected model
            updateFormatDescription(elements.requestFormat.value);
            updateVisibility();
        }

        populateVisionModels(models);
    } catch (e) {
        console.error('Failed to load models:', e);
        elements.modelSelect.innerHTML = '<option value="">Error loading models</option>';
        if (elements.visionModelSelect) {
            // DOM node (not innerHTML) — the codebase avoids innerHTML for AMO.
            const errOption = document.createElement('option');
            errOption.value = '';
            errOption.textContent = 'Error loading models';
            elements.visionModelSelect.replaceChildren(errOption);
        }
    } finally {
        elements.modelSelect.disabled = false;
    }
}

// Fill the vision-model dropdown from the same provider model list as the
// translation model. A leading empty option means "reuse the preferred model"
// (visionModel = '', the background fallback).
function populateVisionModels(models) {
    const select = elements.visionModelSelect;
    if (!select) return;

    select.replaceChildren();
    const fallbackOption = document.createElement('option');
    fallbackOption.value = '';
    fallbackOption.textContent = 'Same as preferred model';
    select.appendChild(fallbackOption);

    for (const model of models) {
        const option = document.createElement('option');
        option.value = model.id;
        option.textContent = `${model.name} (${model.provider})`;
        option.dataset.provider = model.provider;
        select.appendChild(option);
    }

    // Restore the saved choice; falls back to the empty option when the model is
    // no longer listed (e.g. provider changed) or was never set.
    select.value = currentSettings.visionModel || '';
}

// Populate language dropdowns from LANGUAGES object
function populateLanguageDropdowns() {
    const sortedLangs = Object.entries(LANGUAGES).sort((a, b) => a[1].localeCompare(b[1]));

    // Source language dropdown - add "auto" option first
    elements.sourceLanguage.innerHTML = '<option value="auto">Auto-detect from page</option>';
    for (const [code, name] of sortedLangs) {
        const option = document.createElement('option');
        option.value = code;
        option.textContent = name;
        elements.sourceLanguage.appendChild(option);
    }

    // Target language dropdown
    elements.targetLanguage.innerHTML = '';
    for (const [code, name] of sortedLangs) {
        const option = document.createElement('option');
        option.value = code;
        option.textContent = name;
        elements.targetLanguage.appendChild(option);
    }
}

// Load settings from storage
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

// Apply settings to UI
function applySettingsToUI() {
    elements.providerSelect.value = currentSettings.provider;
    elements.ollamaUrl.value = currentSettings.ollamaUrl;
    elements.lmstudioUrl.value = currentSettings.lmstudioUrl;
    elements.llamacppUrl.value = currentSettings.llamacppUrl;
    elements.sourceLanguage.value = currentSettings.sourceLanguage || 'auto';
    elements.targetLanguage.value = currentSettings.targetLanguage;
    elements.requestFormat.value = currentSettings.requestFormat;
    elements.maxTokens.value = currentSettings.maxTokensPerBatch;
    elements.maxItems.value = currentSettings.maxItemsPerBatch || 8;
    elements.temperature.value = currentSettings.temperature;
    elements.temperatureValue.textContent = currentSettings.temperature;
    // Parallel requests slider
    if (elements.maxConcurrent) {
        elements.maxConcurrent.value = currentSettings.maxConcurrentRequests || 4;
        if (elements.maxConcurrentValue) {
            elements.maxConcurrentValue.textContent = currentSettings.maxConcurrentRequests || 4;
        }
    }
    elements.useStructuredOutput.checked = currentSettings.useStructuredOutput;
    if (elements.plainTextFallback) elements.plainTextFallback.checked = currentSettings.plainTextFallback !== false;
    elements.showGlow.checked = currentSettings.showGlow !== false;
    if (elements.cacheMode) elements.cacheMode.value = currentSettings.cacheMode || 'off';
    elements.debugLogging.checked = !!currentSettings.debug;
    elements.floatingButton.checked = !!currentSettings.floatingButton;
    if (elements.hoverEnabled) elements.hoverEnabled.checked = !!currentSettings.hoverEnabled;
    if (elements.hoverModifier) elements.hoverModifier.value = currentSettings.hoverModifier || 'Alt';
    elements.customSystem.value = currentSettings.customSystemPrompt || '';
    elements.customUser.value = currentSettings.customUserPromptTemplate || '';

    // Image-describe prompt: show the saved override, or the shared default when
    // unset so the user always sees the actual prompt. (The vision-model dropdown
    // is populated separately in loadModels once the model list is available.)
    if (elements.describePrompt) {
        elements.describePrompt.value = currentSettings.describePrompt || DEFAULT_DESCRIBE_PROMPT;
        elements.describePrompt.dispatchEvent(new Event('input'));
    }

    // Update format description
    updateFormatDescription(currentSettings.requestFormat);

    // Show/hide sections based on format
    updateVisibility();
}

// The effective format = the explicit choice, or (for 'auto') the one detected
// from the selected model. resolveRequestFormat/detectRequestFormat come from languages.js.
function getEffectiveFormat() {
    const modelId = elements.modelSelect?.value || currentSettings.selectedModel;
    return resolveRequestFormat({ requestFormat: elements.requestFormat.value }, modelId);
}

// Update format description and prompt editor. Shows the *effective* template so
// the user can see what 'auto' resolved to for the current model.
function updateFormatDescription(format) {
    const effective = format === 'auto' ? getEffectiveFormat() : format;

    let desc = FORMAT_DESCRIPTIONS[format] || '';
    if (format === 'auto' && (elements.modelSelect?.value || currentSettings.selectedModel)) {
        desc += ` Detected for this model: ${effective}.`;
    }
    elements.formatDescription.textContent = desc;

    // Populate prompt editor with the effective format's template
    const template = PROMPT_TEMPLATES[effective] || PROMPT_TEMPLATES.default;
    if (template && elements.systemPrompt && elements.userPrompt) {
        if (effective === 'custom') {
            elements.systemPrompt.value = currentSettings.customSystemPrompt || '';
            elements.userPrompt.value = currentSettings.customUserPromptTemplate || '';
        } else {
            elements.systemPrompt.value = template.system || '';
            elements.userPrompt.value = template.user || '';
        }
        elements.systemPrompt.dispatchEvent(new Event('input'));
        elements.userPrompt.dispatchEvent(new Event('input'));
    }
}

// Update visibility of sections based on the effective format.
function updateVisibility() {
    const selected = elements.requestFormat.value;
    const effective = getEffectiveFormat();

    // Custom prompts section — only when the user explicitly chose 'custom'
    elements.customPromptsSection.hidden = selected !== 'custom';

    // TranslateGemma help — when the effective format is translategemma
    elements.translateGemmaHelp.hidden = effective !== 'translategemma';

    // Source language only matters for TranslateGemma's prompt
    if (elements.sourceLanguageGroup) {
        elements.sourceLanguageGroup.hidden = effective !== 'translategemma';
    }

    // Structured JSON output is meaningless for plain-text formats; grey it out.
    elements.useStructuredOutput.disabled = PLAIN_TEXT_FORMATS.has(effective);
}

// The describe-prompt value to persist: '' when it still matches the shared
// default (so DEFAULT_DESCRIBE_PROMPT stays the source of truth), else the edit.
function describePromptOverride() {
    if (!elements.describePrompt) return currentSettings.describePrompt || '';
    const value = elements.describePrompt.value;
    return value.trim() === DEFAULT_DESCRIBE_PROMPT.trim() ? '' : value;
}

// Save current settings
async function saveCurrentSettings() {
    currentSettings = {
        ...currentSettings,
        provider: elements.providerSelect.value,
        ollamaUrl: elements.ollamaUrl.value,
        lmstudioUrl: elements.lmstudioUrl.value,
        llamacppUrl: elements.llamacppUrl.value,
        selectedModel: elements.modelSelect?.value || currentSettings.selectedModel,
        visionModel: elements.visionModelSelect ? elements.visionModelSelect.value : (currentSettings.visionModel || ''),
        // Store '' when the prompt is left at the default so a future default change
        // still reaches the user; store the edited text otherwise.
        describePrompt: describePromptOverride(),
        sourceLanguage: elements.sourceLanguage.value,
        targetLanguage: elements.targetLanguage.value,
        requestFormat: elements.requestFormat.value,
        maxTokensPerBatch: parseInt(elements.maxTokens.value) || 2000,
        maxItemsPerBatch: parseInt(elements.maxItems.value) || 8,
        maxConcurrentRequests: parseInt(elements.maxConcurrent?.value) || 4,
        temperature: parseFloat(elements.temperature.value) || 0.3,
        useStructuredOutput: elements.useStructuredOutput.checked,
        plainTextFallback: elements.plainTextFallback ? elements.plainTextFallback.checked : true,
        showGlow: elements.showGlow.checked,
        cacheMode: elements.cacheMode ? elements.cacheMode.value : 'off',
        debug: elements.debugLogging.checked,
        floatingButton: elements.floatingButton.checked,
        hoverEnabled: elements.hoverEnabled ? elements.hoverEnabled.checked : false,
        hoverModifier: elements.hoverModifier ? elements.hoverModifier.value : 'Alt',
        // Save custom prompts from the new prompt editor
        customSystemPrompt: elements.systemPrompt?.value || elements.customSystem?.value || '',
        customUserPromptTemplate: elements.userPrompt?.value || elements.customUser?.value || '',
        useAdvanced: elements.requestFormat.value === 'custom'
    };

    await browserAPI.runtime.sendMessage({
        type: 'SAVE_SETTINGS',
        settings: currentSettings
    });
}

// Toast status icons (feather-style, inherit currentColor).
const TOAST_ICON_SUCCESS = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="20 6 9 17 4 12"/></svg>';
const TOAST_ICON_ERROR = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg>';
const TOAST_ICON_WARN = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>';

// Show toast notification
function showToast(message, type = 'success', duration = 3000) {
    const toast = elements.toast;
    const icon = toast.querySelector('.toast-icon');
    const msg = toast.querySelector('.toast-message');

    if (type === 'error') {
        icon.innerHTML = TOAST_ICON_ERROR;
        icon.style.color = 'var(--danger)';
    } else if (type === 'success') {
        icon.innerHTML = TOAST_ICON_SUCCESS;
        icon.style.color = 'var(--ok)';
    } else {
        icon.innerHTML = TOAST_ICON_WARN;
        icon.style.color = 'var(--warn)';
    }
    msg.textContent = message;

    toast.classList.add('show');
    setTimeout(() => {
        toast.classList.remove('show');
    }, duration);
}

// Setup event listeners
function setupEventListeners() {
    // Temperature slider
    elements.temperature.addEventListener('input', (e) => {
        elements.temperatureValue.textContent = e.target.value;
    });

    // Parallel requests slider
    if (elements.maxConcurrent) {
        elements.maxConcurrent.addEventListener('input', (e) => {
            if (elements.maxConcurrentValue) {
                elements.maxConcurrentValue.textContent = e.target.value;
            }
        });
    }

    // Request format change
    elements.requestFormat.addEventListener('change', (e) => {
        updateFormatDescription(e.target.value);
        updateVisibility();
    });

    // Model selection
    if (elements.modelSelect) {
        elements.modelSelect.addEventListener('change', () => {
            currentSettings.selectedModel = elements.modelSelect.value;
            updateFormatDescription(elements.requestFormat.value);
            updateVisibility(); // Refresh detected-format hint + TranslateGemma help
        });
    }

    // Refresh models (repopulates both the translation and vision dropdowns)
    if (elements.refreshModels) {
        elements.refreshModels.addEventListener('click', async () => {
            await loadModels();
            showToast('Models refreshed');
        });
    }

    // Vision model selection
    if (elements.visionModelSelect) {
        elements.visionModelSelect.addEventListener('change', () => {
            currentSettings.visionModel = elements.visionModelSelect.value;
        });
    }

    // Refresh vision models — shares the same model list as the translation dropdown
    if (elements.refreshVisionModels) {
        elements.refreshVisionModels.addEventListener('click', async () => {
            await loadModels();
            showToast('Models refreshed');
        });
    }

    // Restore the built-in describe prompt
    if (elements.resetDescribePrompt) {
        elements.resetDescribePrompt.addEventListener('click', () => {
            elements.describePrompt.value = DEFAULT_DESCRIBE_PROMPT;
            elements.describePrompt.dispatchEvent(new Event('input'));
            showToast('Describe prompt reset to default');
        });
    }

    // Save settings
    elements.saveSettings.addEventListener('click', async () => {
        // Request host permission for any non-localhost server URL (opt-in).
        // Must run inside this click gesture, before any other awaits.
        const granted = await ensureHostPermissions([
            elements.ollamaUrl.value,
            elements.lmstudioUrl.value,
            elements.llamacppUrl.value
        ]);
        await saveCurrentSettings();
        if (!granted) {
            showToast('Saved, but permission for the custom server was denied — remote models won\'t load until you allow it.', 'error', 5000);
        } else {
            showToast('Settings saved!');
        }
    });

    // Reset settings
    elements.resetSettings.addEventListener('click', async () => {
        currentSettings = { ...DEFAULT_SETTINGS };
        await browserAPI.runtime.sendMessage({
            type: 'SAVE_SETTINGS',
            settings: currentSettings
        });
        applySettingsToUI();
        await loadModels();
        showToast('Settings reset to defaults');
    });

    // Clear translation cache
    if (elements.clearCache) {
        elements.clearCache.addEventListener('click', async () => {
            try {
                await browserAPI.runtime.sendMessage({ type: 'CLEAR_CACHE' });
                await refreshCacheCount();
                showToast('Translation cache cleared');
            } catch (e) {
                showToast('Failed to clear cache', 'error');
            }
        });
    }

    // Copy LM Studio template
    elements.copyTemplate.addEventListener('click', () => {
        const template = `{{ bos_token }}
{%- for message in messages -%}
    {%- if message['role'] == 'user' or message['role'] == 'system' -%}
        {{ '<start_of_turn>user\\n' + message['content'] | trim + '<end_of_turn>\\n' }}
    {%- elif message['role'] == 'assistant' -%}
        {{ '<start_of_turn>model\\n' + message['content'] | trim + '<end_of_turn>\\n' }}
    {%- endif -%}
{%- endfor -%}
{%- if add_generation_prompt -%}
    {{ '<start_of_turn>model\\n' }}
{%- endif -%}`;

        navigator.clipboard.writeText(template).then(() => {
            showToast('Template copied to clipboard!');
        }).catch(() => {
            showToast('Failed to copy template', 'error');
        });
    });
}

// Initialize on DOM ready
document.addEventListener('DOMContentLoaded', init);

// ============================================================================
// All-URLs content-script permission management
// ============================================================================
//
// Both the floating button and hover-to-translate run from the persistent,
// all-URLs content script and share the same <all_urls> permission. The two
// toggles therefore share one enable/disable helper: the content script is
// registered while *either* feature is on, and only unregistered (and the
// permission removed) once *both* are off — so turning one off never breaks the
// other.

/** @returns {boolean} whether any all-URLs feature toggle is currently on. */
function anyAllUrlsFeatureEnabled() {
    return !!(elements.floatingButton && elements.floatingButton.checked)
        || !!(elements.hoverEnabled && elements.hoverEnabled.checked);
}

/**
 * Request the <all_urls> permission (must run inside a user gesture) and
 * register the content script.
 * @returns {Promise<boolean>} true if granted and registered.
 */
async function enableAllUrlsFeature() {
    const granted = await browserAPI.permissions.request({ origins: ['<all_urls>'] });
    if (!granted) return false;
    // Delegate registration to background so the path resolves from the extension root.
    await browserAPI.runtime.sendMessage({ type: 'REGISTER_CONTENT_SCRIPT' });
    return true;
}

/**
 * Tear down the content script and drop the <all_urls> permission, but only if
 * no all-URLs feature remains enabled.
 * @returns {Promise<void>}
 */
async function disableAllUrlsFeatureIfUnused() {
    if (anyAllUrlsFeatureEnabled()) return;
    await browserAPI.runtime.sendMessage({ type: 'UNREGISTER_CONTENT_SCRIPT' });
    try {
        await browserAPI.permissions.remove({ origins: ['<all_urls>'] });
    } catch (e) {
        // Permission may already be absent
    }
}

document.addEventListener('DOMContentLoaded', () => {
    elements.floatingButton.addEventListener('change', async (e) => {
        if (e.target.checked) {
            const ok = await enableAllUrlsFeature();
            if (ok) {
                showToast('Floating button enabled — reload pages to activate');
            } else {
                elements.floatingButton.checked = false;
                showToast('Permission denied — floating button not enabled', 'error');
            }
        } else {
            await disableAllUrlsFeatureIfUnused();
            showToast('Floating button disabled');
        }
        currentSettings.floatingButton = elements.floatingButton.checked;
        await browserAPI.runtime.sendMessage({ type: 'SAVE_SETTINGS', settings: currentSettings });
    });

    if (elements.hoverEnabled) {
        elements.hoverEnabled.addEventListener('change', async () => {
            if (elements.hoverEnabled.checked) {
                const ok = await enableAllUrlsFeature();
                if (ok) {
                    showToast('Hover to translate enabled — reload pages to activate');
                } else {
                    elements.hoverEnabled.checked = false;
                    showToast('Permission denied — hover to translate not enabled', 'error');
                }
            } else {
                await disableAllUrlsFeatureIfUnused();
                showToast('Hover to translate disabled');
            }
            currentSettings.hoverEnabled = elements.hoverEnabled.checked;
            await browserAPI.runtime.sendMessage({ type: 'SAVE_SETTINGS', settings: currentSettings });
        });
    }

    if (elements.hoverModifier) {
        elements.hoverModifier.addEventListener('change', async () => {
            currentSettings.hoverModifier = elements.hoverModifier.value;
            await browserAPI.runtime.sendMessage({ type: 'SAVE_SETTINGS', settings: currentSettings });
        });
    }
});
