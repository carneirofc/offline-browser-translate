/**
 * Popup Script for Local LLM Translator
 */

// Use browser API with chrome fallback for Firefox compatibility
const browserAPI = typeof browser !== 'undefined' ? browser : chrome;

// Import default settings
const DEFAULT_SETTINGS = {
    provider: 'auto',
    ollamaUrl: 'http://localhost:11434',
    lmstudioUrl: 'http://localhost:1234',
    selectedModel: '',
    targetLanguage: 'en',
    maxTokensPerBatch: 2000,
    maxItemsPerBatch: 8,
    maxConcurrentRequests: 4, // 1-4 parallel requests (LMStudio 0.4.0+ supports parallelism)
    useAdvanced: false,
    customSystemPrompt: '',
    customUserPromptTemplate: '',
    requestFormat: 'default',
    temperature: 0.3,
    useStructuredOutput: true,
    showGlow: true
};

// DOM Elements
const elements = {
    providerStatus: document.getElementById('providerStatus'),
    modelSelect: document.getElementById('modelSelect'),
    refreshModels: document.getElementById('refreshModels'),
    languageSelect: document.getElementById('languageSelect'),
    sourceLangGroup: document.getElementById('sourceLangGroup'),
    detectedLang: document.getElementById('detectedLang'),
    sourceLangOverride: document.getElementById('sourceLangOverride'),
    translateBtn: document.getElementById('translateBtn'),
    cancelBtn: document.getElementById('cancelBtn'),
    restoreBtn: document.getElementById('restoreBtn'),
    toggleAdvanced: document.getElementById('toggleAdvanced'),
    advancedSection: document.getElementById('advancedSection'),
    providerSelect: document.getElementById('providerSelect'),
    ollamaUrl: document.getElementById('ollamaUrl'),
    lmstudioUrl: document.getElementById('lmstudioUrl'),
    maxTokens: document.getElementById('maxTokens'),
    maxItems: document.getElementById('maxItems'),
    temperature: document.getElementById('temperature'),
    temperatureValue: document.getElementById('temperatureValue'),
    requestFormat: document.getElementById('requestFormat'),
    formatDescription: document.getElementById('formatDescription'),
    useStructuredOutput: document.getElementById('useStructuredOutput'),
    showGlow: document.getElementById('showGlow'),
    floatingButton: document.getElementById('floatingButton'),
    customPrompts: document.getElementById('customPrompts'),
    customSystem: document.getElementById('customSystem'),
    customUser: document.getElementById('customUser'),
    saveSettings: document.getElementById('saveSettings'),
    openOptions: document.getElementById('openOptions'),
    resetSettings: document.getElementById('resetSettings'),
    toast: document.getElementById('toast')
};

// Format descriptions for each request format type
const FORMAT_DESCRIPTIONS = {
    default: 'Standard JSON output format. Best for most models. Returns translations as a structured JSON array.',
    translategemma: 'Specialized format for TranslateGemma models. Uses the exact prompt structure required by TranslateGemma. Auto-detects source language from the page.',
    hunyuan: 'Format optimized for Hunyuan-MT models. Minimal prompt with no system message.',
    simple: 'Simple line-by-line output. Good for smaller models that struggle with JSON formatting.',
    custom: 'Use your own custom system and user prompts. Full control over the translation request.'
};

let currentSettings = { ...DEFAULT_SETTINGS };
function debugLog(...args) { if (currentSettings.debug) console.log(...args); }
let isTranslating = false;
let detectedPageLanguage = 'en';

// Detect page language from active tab (using programmatic injection)
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

// Populate source language override dropdown
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

// Show/hide source language group (Always show now per user request)
function updateSourceLangVisibility() {
    if (!elements.sourceLangGroup) return;
    // Always show source language options so user can see detection status
    elements.sourceLangGroup.hidden = false;
}

// Show toast notification
function showToast(message, type = 'success', duration = 3000) {
    const toast = elements.toast;
    const icon = toast.querySelector('.toast-icon');
    const msg = toast.querySelector('.toast-message');

    icon.textContent = type === 'success' ? '✅' : '❌';
    msg.textContent = message;

    if (type === 'error') {
        toast.style.borderColor = 'var(--red)';
        toast.style.color = 'var(--red)';
    } else {
        toast.style.borderColor = 'var(--accent)';
        toast.style.color = 'var(--accent)';
    }

    toast.classList.add('show');
    setTimeout(() => {
        toast.classList.remove('show');
    }, duration);
}

// Initialize popup
async function init() {
    populateLanguageDropdown();
    populateSourceLangOverride();
    await loadSettings();
    applySettingsToUI();
    updateSourceLangVisibility();
    await checkProviders();
    await loadModels();
    setupEventListeners();
    await checkTranslationStatus();
    await detectPageLanguage();
}

// Populate language dropdown from LANGUAGES object (defined in languages.js)
function populateLanguageDropdown() {
    const select = elements.languageSelect;
    select.innerHTML = '';

    // Sort languages by name for better UX
    const sortedLangs = Object.entries(LANGUAGES).sort((a, b) => a[1].localeCompare(b[1]));

    for (const [code, name] of sortedLangs) {
        const option = document.createElement('option');
        option.value = code;
        option.textContent = name;
        select.appendChild(option);
    }
}

// Check if translation is already running in active tab
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
    elements.languageSelect.value = currentSettings.targetLanguage;
    elements.providerSelect.value = currentSettings.provider;
    elements.ollamaUrl.value = currentSettings.ollamaUrl;
    elements.lmstudioUrl.value = currentSettings.lmstudioUrl;
    elements.maxTokens.value = currentSettings.maxTokensPerBatch;
    elements.maxItems.value = currentSettings.maxItemsPerBatch || 8;
    elements.temperature.value = currentSettings.temperature;
    elements.temperatureValue.textContent = currentSettings.temperature;
    elements.requestFormat.value = currentSettings.requestFormat;
    elements.useStructuredOutput.checked = currentSettings.useStructuredOutput;
    elements.showGlow.checked = currentSettings.showGlow !== false;
    if (elements.floatingButton) elements.floatingButton.checked = !!currentSettings.floatingButton;
    elements.customSystem.value = currentSettings.customSystemPrompt || '';
    elements.customUser.value = currentSettings.customUserPromptTemplate || '';

    // Restore source language override
    if (elements.sourceLangOverride && currentSettings.sourceLanguage) {
        elements.sourceLangOverride.value = currentSettings.sourceLanguage;
    }

    // Show custom prompts if custom format selected
    elements.customPrompts.hidden = currentSettings.requestFormat !== 'custom';

    // Update format description
    updateFormatDescription(currentSettings.requestFormat);
}

// Update format description text
function updateFormatDescription(format) {
    if (elements.formatDescription) {
        elements.formatDescription.textContent = FORMAT_DESCRIPTIONS[format] || '';
    }
}

// Check if a model is a TranslateGemma model
function isTranslateGemmaModel(modelId) {
    if (!modelId) return false;
    const lowerName = modelId.toLowerCase();
    return lowerName.includes('translategemma') ||
        lowerName.includes('translate-gemma') ||
        lowerName.includes('translate_gemma');
}

// Automatically set format based on model type
function autoSetFormatForModel(modelId) {
    if (!modelId) return;

    const isTranslateGemma = isTranslateGemmaModel(modelId);

    if (isTranslateGemma) {
        if (currentSettings.requestFormat !== 'translategemma') {
            elements.requestFormat.value = 'translategemma';
            currentSettings.requestFormat = 'translategemma';
            updateFormatDescription('translategemma');
            elements.customPrompts.hidden = true;
            showToast('Switched to TranslateGemma format', 'success', 1500);
        }
        // TranslateGemma outputs plain text, not JSON — disable structured output
        if (currentSettings.useStructuredOutput) {
            currentSettings.useStructuredOutput = false;
            elements.useStructuredOutput.checked = false;
        }
    } else {
        // If switching away from TranslateGemma model and format is still TranslateGemma,
        // switch back to default
        if (currentSettings.requestFormat === 'translategemma') {
            elements.requestFormat.value = 'default';
            currentSettings.requestFormat = 'default';
            updateFormatDescription('default');
            elements.customPrompts.hidden = true;
        }
    }
}

// Check which providers are available
let providersAvailable = false;

async function checkProviders() {
    const statusWrapper = elements.providerStatus;
    const statusDot = statusWrapper.querySelector('.status-dot');

    try {
        const response = await browserAPI.runtime.sendMessage({ type: 'DETECT_PROVIDERS' });

        const providers = [];
        if (response.ollama) providers.push('Ollama');
        if (response.lmstudio) providers.push('LMStudio');

        if (providers.length > 0) {
            statusDot.className = 'status-dot connected';
            statusWrapper.title = `Connected: ${providers.join(', ')}`;
            providersAvailable = true;
            hideSetupBanner();
        } else if (response.ollama_blocked) {
            statusDot.className = 'status-dot error';
            statusWrapper.title = 'Ollama is running but blocking the extension (CORS)';
            providersAvailable = false;
            showSetupBanner('cors-blocked');
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

function bannerHTML(type) {
    if (type === 'no-models') {
        return `
            <div style="font-weight: bold; margin-bottom: 4px; color: var(--yellow, #dbbc7f);">No translation models found</div>
            <div>Your LLM provider is connected, but you have not downloaded a translation model yet.</div>
            <div style="margin-top: 6px;">Recommended model:</div>
            <div style="background: var(--bg1, #2b2b2b); padding: 4px 8px; border-radius: 4px; font-family: monospace; display: flex; align-items: center; justify-content: space-between; margin-top: 4px;">
                <code>ollama pull translategemma</code>
            </div>
            <div style="margin-top: 6px; font-size: 11px; opacity: 0.8;">Or download a model in LMStudio (search for "translate"). Click the refresh button above when done.</div>
        `;
    }
    if (type === 'cors-blocked') {
        return `
            <div style="font-weight: bold; margin-bottom: 4px; color: var(--yellow, #dbbc7f);">Ollama is blocking the extension</div>
            <div>Ollama is running, but it is not allowing requests from browser extensions. You need to enable CORS.</div>
            <div style="margin-top: 6px; font-size: 11px; opacity: 0.8;"><a href="https://api.onlyoffice.com/docs/plugin-and-macros/ai/configuring-ollama-with-cors/" target="_blank" style="color: var(--accent, #a7c080);">See instructions for your OS here</a>. Click the refresh button above when done.</div>
        `;
    }
    return `
        <div style="font-weight: bold; margin-bottom: 4px; color: var(--yellow, #dbbc7f);">No LLM provider detected</div>
        <div>To use this extension, you need a local LLM server running:</div>
        <ol style="margin: 6px 0 2px 18px; padding: 0;">
            <li>Install <a href="https://ollama.com" target="_blank" style="color: var(--accent, #a7c080);">Ollama</a> or <a href="https://lmstudio.ai" target="_blank" style="color: var(--accent, #a7c080);">LMStudio</a></li>
            <li>Load a translation model (e.g. <code style="background: var(--bg1, #2b2b2b); padding: 1px 4px; border-radius: 3px;">ollama pull translategemma</code>)</li>
            <li>Click the refresh button above</li>
        </ol>
    `;
}

// Show/hide first-run setup guidance banner
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
        background: var(--bg3, #3a3a3a);
        border: 1px solid var(--yellow, #dbbc7f);
        border-radius: 8px;
        padding: 10px 14px;
        margin: 8px 0;
        font-size: 12px;
        line-height: 1.5;
        color: var(--fg, #d3c6aa);
    `;
    banner.innerHTML = bannerHTML(type);

    // Insert after the model selector row
    const modelRow = elements.modelSelect?.closest('.row') || elements.modelSelect?.parentElement;
    if (modelRow) {
        modelRow.parentNode.insertBefore(banner, modelRow.nextSibling);
    } else {
        document.querySelector('.popup-body, .container, body')?.prepend(banner);
    }
}

function hideSetupBanner() {
    const banner = document.getElementById('setup-banner');
    if (banner) banner.hidden = true;
}

// Load available models
async function loadModels(forceRefresh = false) {
    elements.modelSelect.disabled = true;
    elements.modelSelect.innerHTML = '<option value="">Loading models...</option>';

    try {
        const response = await browserAPI.runtime.sendMessage({ type: 'LIST_MODELS', forceRefresh });
        const models = response.models || [];

        if (models.length === 0) {
            elements.modelSelect.innerHTML = '<option value="">No models found</option>';
            if (providersAvailable) {
                showSetupBanner('no-models');
            }
            return;
        }

        // We have models, hide banner if it's the "no-models" type (or any type)
        hideSetupBanner();

        elements.modelSelect.innerHTML = '';
        models.forEach(m => {
            const option = document.createElement('option');
            option.value = m.id;
            option.dataset.provider = m.provider;
            option.textContent = m.name;
            elements.modelSelect.appendChild(option);
        });

        // Select previously selected model if available
        if (currentSettings.selectedModel) {
            const exists = models.some(m => m.id === currentSettings.selectedModel);
            if (exists) {
                elements.modelSelect.value = currentSettings.selectedModel;
            }
        }

        elements.modelSelect.disabled = false;
        elements.translateBtn.disabled = false;

        // Auto-configure format for the selected model
        autoSetFormatForModel(elements.modelSelect.value);

    } catch (e) {
        console.error('Failed to load models:', e);
        elements.modelSelect.innerHTML = '<option value="">Error loading models</option>';
    }
}

// Save current settings
async function saveCurrentSettings() {
    currentSettings = {
        ...currentSettings,
        provider: elements.providerSelect.value,
        ollamaUrl: elements.ollamaUrl.value,
        lmstudioUrl: elements.lmstudioUrl.value,
        selectedModel: elements.modelSelect.value,
        targetLanguage: elements.languageSelect.value,
        maxTokensPerBatch: parseInt(elements.maxTokens.value) || 2000,
        maxItemsPerBatch: parseInt(elements.maxItems.value) || 8,
        temperature: parseFloat(elements.temperature.value) || 0.3,
        requestFormat: elements.requestFormat.value,
        useStructuredOutput: elements.useStructuredOutput.checked,
        showGlow: elements.showGlow.checked,
        // Save the source language override preference
        sourceLanguage: elements.sourceLangOverride ? elements.sourceLangOverride.value : 'auto',
        customSystemPrompt: elements.customSystem.value,
        customUserPromptTemplate: elements.customUser.value
    };

    await browserAPI.runtime.sendMessage({
        type: 'SAVE_SETTINGS',
        settings: currentSettings
    });
}

// Start translation
async function startTranslation() {
    if (isTranslating) return;

    // --- Pre-flight checks with clear error messages ---
    const model = elements.modelSelect.value;
    if (!model) {
        showToast('Please select a model first', 'error');
        return;
    }

    if (!providersAvailable) {
        showToast('No LLM provider running. Start Ollama or LMStudio first.', 'error');
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
        isTranslating = false;
        elements.translateBtn.disabled = false;
        elements.translateBtn.querySelector('.btn-text').hidden = false;
        elements.translateBtn.querySelector('.btn-loading').hidden = true;
        elements.cancelBtn.hidden = true;
    }
}

// Cancel translation
async function cancelTranslation() {
    try {
        const [tab] = await browserAPI.tabs.query({ active: true, currentWindow: true });
        if (tab && tab.id) {
            await browserAPI.tabs.sendMessage(tab.id, { type: 'CANCEL_TRANSLATION' });
        }
    } catch (e) {
        console.error('Cancel error:', e);
    }

    isTranslating = false;
    elements.translateBtn.disabled = false;
    elements.translateBtn.querySelector('.btn-text').hidden = false;
    elements.translateBtn.querySelector('.btn-loading').hidden = true;
    elements.cancelBtn.hidden = true;
}

// Toggle translation on/off (uses cached translations if available)
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

// Setup event listeners
function setupEventListeners() {
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

    // Toggle advanced settings
    elements.toggleAdvanced.addEventListener('click', () => {
        const isHidden = elements.advancedSection.hidden;
        elements.advancedSection.hidden = !isHidden;
        elements.toggleAdvanced.classList.toggle('active', !isHidden);
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

    // Temperature slider
    elements.temperature.addEventListener('input', (e) => {
        elements.temperatureValue.textContent = e.target.value;
    });

    // Request format change
    elements.requestFormat.addEventListener('change', (e) => {
        const format = e.target.value;
        elements.customPrompts.hidden = format !== 'custom';
        currentSettings.requestFormat = format;
        updateFormatDescription(format);
        updateSourceLangVisibility();
    });

    // Save settings button
    elements.saveSettings.addEventListener('click', async () => {
        await saveCurrentSettings();
        await checkProviders();
        await loadModels();
        showToast('Settings saved!');
    });

    // Auto-save model and language selection
    elements.modelSelect.addEventListener('change', () => {
        const modelId = elements.modelSelect.value;
        currentSettings.selectedModel = modelId;

        // Auto-detect TranslateGemma model and auto-switch format
        autoSetFormatForModel(modelId);

        saveCurrentSettings();
    });

    elements.languageSelect.addEventListener('change', () => {
        currentSettings.targetLanguage = elements.languageSelect.value;
        saveCurrentSettings();
    });

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

    // Variable helpers
    document.querySelectorAll('.var-tag').forEach(tag => {
        tag.addEventListener('click', () => {
            const targetId = tag.dataset.target;
            const textToInsert = tag.dataset.insert;
            const textarea = document.getElementById(targetId);

            if (textarea) {
                const start = textarea.selectionStart;
                const end = textarea.selectionEnd;
                const text = textarea.value;
                const before = text.substring(0, start);
                const after = text.substring(end, text.length);

                textarea.value = before + textToInsert + after;
                textarea.selectionStart = textarea.selectionEnd = start + textToInsert.length;
                textarea.focus();

                // Trigger change to update settings
                textarea.dispatchEvent(new Event('change'));
            }
        });
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

    // Reset settings to defaults
    if (elements.resetSettings) {
        elements.resetSettings.addEventListener('click', async () => {
            currentSettings = { ...DEFAULT_SETTINGS };
            await browserAPI.runtime.sendMessage({
                type: 'SAVE_SETTINGS',
                settings: currentSettings
            });
            applySettingsToUI();
            showToast('Settings reset to defaults');
        });
    }
}

// Initialize on DOM ready
document.addEventListener('DOMContentLoaded', init);
