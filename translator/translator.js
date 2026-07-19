/**
 * Translator Page Script for Local LLM Translator
 * Google Translate-like interface using local LLM backend
 */

// Use browser API with chrome fallback for Firefox compatibility
const browserAPI = typeof browser !== 'undefined' ? browser : chrome;

// ============================================================================
// Configuration
// ============================================================================

const PINNED_LANGUAGES = ['en', 'es', 'fr', 'de', 'zh', 'ja'];

// DEFAULT_SETTINGS is provided by defaults.js (loaded before this script).

// ============================================================================
// State
// ============================================================================

let currentSettings = { ...DEFAULT_SETTINGS };
let sourceLanguage = 'en';
let targetLanguage = 'es';
let isTranslating = false;
let selectedModel = null;
let selectedModelProvider = null;

// ============================================================================
// DOM Elements
// ============================================================================

const els = {
    // Status & Model
    statusIndicator: document.getElementById('statusIndicator'),
    statusText: document.getElementById('statusText'),
    modelName: document.getElementById('modelName'),
    modelBadge: document.getElementById('modelBadge'),

    // Source
    sourceLangBtn: document.getElementById('sourceLangBtn'),
    sourceLangName: document.getElementById('sourceLangName'),
    sourceLangDropdown: document.getElementById('sourceLangDropdown'),
    sourceLangSearch: document.getElementById('sourceLangSearch'),
    sourceLangPinned: document.getElementById('sourceLangPinned'),
    sourceLangList: document.getElementById('sourceLangList'),
    sourceLangSelector: document.getElementById('sourceLangSelector'),
    sourceText: document.getElementById('sourceText'),
    charCount: document.getElementById('charCount'),
    clearBtn: document.getElementById('clearBtn'),

    // Target
    targetLangBtn: document.getElementById('targetLangBtn'),
    targetLangName: document.getElementById('targetLangName'),
    targetLangDropdown: document.getElementById('targetLangDropdown'),
    targetLangSearch: document.getElementById('targetLangSearch'),
    targetLangPinned: document.getElementById('targetLangPinned'),
    targetLangList: document.getElementById('targetLangList'),
    targetLangSelector: document.getElementById('targetLangSelector'),
    targetOutput: document.getElementById('targetOutput'),
    translationInfo: document.getElementById('translationInfo'),
    copyBtn: document.getElementById('copyBtn'),

    // Actions
    swapBtn: document.getElementById('swapBtn'),
    translateBtn: document.getElementById('translateBtn'),

    // Describe an image (issue #10)
    imageDropZone: document.getElementById('imageDropZone'),
    imageFileInput: document.getElementById('imageFileInput'),
    imagePreview: document.getElementById('imagePreview'),
    dropZoneText: document.getElementById('dropZoneText'),
    describeBtn: document.getElementById('describeBtn'),
    clearImageBtn: document.getElementById('clearImageBtn'),
    describeOutput: document.getElementById('describeOutput'),

    // Toast
    toast: document.getElementById('toast')
};

// Data URL of the image currently staged for description (null when none).
let selectedImageDataUrl = null;
let isDescribing = false;

// ============================================================================
// Language Selector
// ============================================================================

/** Rebuild the pinned chips and full list for a source/target language selector. */
function buildLanguageSelector(type) {
    const pinnedContainer = type === 'source' ? els.sourceLangPinned : els.targetLangPinned;
    const listContainer = type === 'source' ? els.sourceLangList : els.targetLangList;
    const currentLang = type === 'source' ? sourceLanguage : targetLanguage;

    // Clear existing
    pinnedContainer.textContent = '';
    listContainer.textContent = '';

    // Pinned chips
    for (const code of PINNED_LANGUAGES) {
        const name = LANGUAGES[code];
        if (!name) continue;

        const chip = document.createElement('button');
        chip.className = 'lang-chip' + (code === currentLang ? ' active' : '');
        chip.textContent = name;
        chip.dataset.code = code;
        chip.type = 'button';
        chip.addEventListener('click', () => selectLanguage(type, code));
        pinnedContainer.appendChild(chip);
    }

    // Full list (sorted alphabetically)
    const sorted = Object.entries(LANGUAGES).sort((a, b) => a[1].localeCompare(b[1]));

    for (const [code, name] of sorted) {
        const item = document.createElement('div');
        item.className = 'lang-item' + (code === currentLang ? ' active' : '');
        item.dataset.code = code;
        item.dataset.name = name.toLowerCase();

        const codeSpan = document.createElement('span');
        codeSpan.className = 'lang-code';
        codeSpan.textContent = code;

        const nameSpan = document.createElement('span');
        nameSpan.textContent = name;

        item.appendChild(codeSpan);
        item.appendChild(nameSpan);
        item.addEventListener('click', () => selectLanguage(type, code));
        listContainer.appendChild(item);
    }
}

/** Set the source or target language and update the related UI. */
function selectLanguage(type, code) {
    const name = LANGUAGES[code] || code;

    if (type === 'source') {
        sourceLanguage = code;
        els.sourceLangName.textContent = name;
        closeDropdown('source');
        buildLanguageSelector('source'); // Rebuild to update active states
    } else {
        targetLanguage = code;
        els.targetLangName.textContent = name;
        closeDropdown('target');
        buildLanguageSelector('target');
    }
}

/** Open the source or target language dropdown, closing the other one first. */
function openDropdown(type) {
    const selector = type === 'source' ? els.sourceLangSelector : els.targetLangSelector;
    const search = type === 'source' ? els.sourceLangSearch : els.targetLangSearch;

    // Close the other dropdown
    closeDropdown(type === 'source' ? 'target' : 'source');

    selector.classList.add('open');
    search.value = '';
    filterLanguages(type, '');

    // Focus search after a tick (for animation)
    requestAnimationFrame(() => search.focus());
}

/** Close the source or target language dropdown. */
function closeDropdown(type) {
    const selector = type === 'source' ? els.sourceLangSelector : els.targetLangSelector;
    selector.classList.remove('open');
}

/** Toggle the open/closed state of the source or target language dropdown. */
function toggleDropdown(type) {
    const selector = type === 'source' ? els.sourceLangSelector : els.targetLangSelector;
    if (selector.classList.contains('open')) {
        closeDropdown(type);
    } else {
        openDropdown(type);
    }
}

/** Show or hide language list items based on a search query. */
function filterLanguages(type, query) {
    const listContainer = type === 'source' ? els.sourceLangList : els.targetLangList;
    const items = listContainer.querySelectorAll('.lang-item');
    const q = query.toLowerCase().trim();

    for (const item of items) {
        const name = item.dataset.name;
        const code = item.dataset.code;
        const matches = !q || name.includes(q) || code.includes(q);
        item.classList.toggle('hidden', !matches);
    }
}

// ============================================================================
// Swap Languages
// ============================================================================

/** Swap the source and target languages, moving any translated output back into the source. */
function swapLanguages() {
    const tmpLang = sourceLanguage;
    sourceLanguage = targetLanguage;
    targetLanguage = tmpLang;

    els.sourceLangName.textContent = LANGUAGES[sourceLanguage] || sourceLanguage;
    els.targetLangName.textContent = LANGUAGES[targetLanguage] || targetLanguage;

    // Move translation output to source input
    const outputEl = els.targetOutput.querySelector('.translated-text');
    if (outputEl) {
        els.sourceText.value = outputEl.textContent;
        els.targetOutput.textContent = '';
        const placeholder = document.createElement('span');
        placeholder.className = 'placeholder-text';
        placeholder.textContent = 'Translation will appear here...';
        els.targetOutput.appendChild(placeholder);
        els.copyBtn.hidden = true;
        els.translationInfo.textContent = '';
        updateCharCount();
    }

    buildLanguageSelector('source');
    buildLanguageSelector('target');
}

// ============================================================================
// Translation
// ============================================================================

/** Translate the source text and display the result or an error. */
async function translateText() {
    const rawText = els.sourceText.value;
    const text = rawText.trim();
    if (!text || isTranslating) return;

    if (!selectedModel) {
        showTranslationError('No model available. Start Ollama, LM Studio, or llama.cpp and reload.');
        return;
    }

    isTranslating = true;
    setTranslatingUI(true);

    try {
        const leadingSpace = rawText.match(/^\s*/)[0];
        const trailingSpace = rawText.match(/\s*$/)[0];

        // Build a single text item for the background script
        const textItems = [{ id: 0, text: text }];

        const response = await browserAPI.runtime.sendMessage({
            type: 'TRANSLATE',
            texts: textItems,
            targetLanguage: targetLanguage,
            sourceLanguage: sourceLanguage
        });

        if (response.error) {
            throw new Error(response.error);
        }

        const translations = response.translations || [];
        if (translations.length > 0 && translations[0].text) {
            const trimmedTranslation = (translations[0].text || '').trim();
            
            // For spaceless languages (Japanese, Chinese, etc.), add spacing when translating
            // to spaced languages if there was no original spacing
            let effectiveTrailingSpace = trailingSpace;
            if (!effectiveTrailingSpace && trimmedTranslation) {
                const hasCJK = /[\u3000-\u9fff\uff00-\uffef]/.test(rawText);
                if (hasCJK) {
                    effectiveTrailingSpace = ' ';
                }
            }

            const processedText = leadingSpace + trimmedTranslation + effectiveTrailingSpace;
            showTranslation(processedText);
        } else {
            showTranslationError('No translation returned');
        }
    } catch (e) {
        console.error('Translation error:', e);
        showTranslationError(e.message);
    } finally {
        isTranslating = false;
        setTranslatingUI(false);
    }
}

/** Toggle the translate button's loading state. */
function setTranslatingUI(translating) {
    els.translateBtn.disabled = translating;
    els.translateBtn.querySelector('.btn-text').hidden = translating;
    els.translateBtn.querySelector('.btn-loading').hidden = !translating;
}

/** Render the translated text in the target output area. */
function showTranslation(text) {
    els.targetOutput.textContent = '';
    const span = document.createElement('span');
    span.className = 'translated-text';
    span.textContent = text;
    els.targetOutput.appendChild(span);
    els.copyBtn.hidden = false;
    els.translationInfo.textContent = `${LANGUAGES[sourceLanguage] || sourceLanguage} → ${LANGUAGES[targetLanguage] || targetLanguage}`;
}

/** Render an error message in the target output area. */
function showTranslationError(message) {
    els.targetOutput.textContent = '';
    const span = document.createElement('span');
    span.className = 'placeholder-text';
    span.style.color = 'var(--danger)';
    span.textContent = `Error: ${message}`;
    els.targetOutput.appendChild(span);
    els.copyBtn.hidden = true;
    els.translationInfo.textContent = '';
}

// ============================================================================
// Copy to Clipboard
// ============================================================================

/** Copy the translated text to the clipboard and show a status toast. */
function copyTranslation() {
    const outputEl = els.targetOutput.querySelector('.translated-text');
    if (!outputEl) return;

    navigator.clipboard.writeText(outputEl.textContent).then(() => {
        showToast('Copied to clipboard!');
    }).catch(() => {
        showToast('Failed to copy', 'error');
    });
}

// ============================================================================
// Character Count
// ============================================================================

/** Update the source character counter and clear button visibility. */
function updateCharCount() {
    const len = els.sourceText.value.length;
    els.charCount.textContent = `${len} character${len !== 1 ? 's' : ''}`;
    els.clearBtn.hidden = len === 0;
}

/** Clear the source text input and refocus it. */
function clearSource() {
    els.sourceText.value = '';
    updateCharCount();
    els.sourceText.focus();
}

// ============================================================================
// Provider Status
// ============================================================================

/** Check LLM provider connectivity and update the status indicator. */
async function checkStatus() {
    const dot = els.statusIndicator.querySelector('.status-dot');

    try {
        await loadSettings();
        const response = await browserAPI.runtime.sendMessage({ type: 'DETECT_PROVIDERS' });
        const providerSetting = currentSettings.provider; // 'auto', 'ollama', 'lmstudio', 'llamacpp'

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
            dot.className = 'status-dot connected';
            els.statusText.textContent = connectedProviders.join(' + ');
            els.statusIndicator.title = `Connected: ${connectedProviders.join(', ')}`;
        } else if (blocked) {
            dot.className = 'status-dot error';
            els.statusText.textContent = 'CORS Blocked';
            els.statusIndicator.title = blockedType === 'ollama'
                ? 'Ollama is running but blocking the extension (CORS). Enable CORS in Ollama.'
                : blockedType === 'lmstudio'
                    ? 'LM Studio is running but blocking the extension (CORS). Enable CORS in LM Studio Developer settings.'
                    : 'llama.cpp server is running but blocking the extension (CORS). Restart it with --cors-origins "*".';
        } else {
            dot.className = 'status-dot error';
            els.statusText.textContent = 'No provider';
            els.statusIndicator.title = 'No LLM providers found. Start Ollama, LM Studio, or llama.cpp.';
        }
    } catch (e) {
        dot.className = 'status-dot error';
        els.statusText.textContent = 'Error';
        els.statusIndicator.title = 'Error connecting to extension background';
    }
}

// ============================================================================
// Model Loading & Auto-Selection
// ============================================================================

/**
 * Smart model auto-selection priority:
 * 1. "translategemma-4b-it" (LM Studio name)
 * 2. "translategemma" (Ollama name)
 * 3. Any model containing "translategemma"
 * 4. Any model with "translat" in the name
 * 5. First available model
 */
function autoSelectModel(models) {
    if (!models || models.length === 0) return null;

    const exact4b = models.find(m => m.id.toLowerCase() === 'translategemma-4b-it');
    if (exact4b) return exact4b;

    const exactTG = models.find(m => m.id.toLowerCase() === 'translategemma');
    if (exactTG) return exactTG;

    const containsTG = models.find(m => m.id.toLowerCase().includes('translategemma'));
    if (containsTG) return containsTG;

    const containsTranslat = models.find(m => m.id.toLowerCase().includes('translat'));
    if (containsTranslat) return containsTranslat;

    return models[0];
}

/** Fetch available models, select one, and update the model UI/settings. */
async function loadModels() {
    els.modelName.textContent = 'Loading...';

    try {
        const response = await browserAPI.runtime.sendMessage({ type: 'LIST_MODELS' });
        const models = response.models || [];

        if (models.length === 0) {
            els.modelName.textContent = 'No models';
            els.modelBadge.title = 'No models found. Make sure Ollama, LM Studio, or llama.cpp has models loaded.';
            selectedModel = null;
            return;
        }

        // Use settings model if it exists in the list, otherwise auto-select
        let chosen = null;
        if (currentSettings.selectedModel) {
            chosen = models.find(m => m.id === currentSettings.selectedModel);
        }
        if (!chosen) {
            chosen = autoSelectModel(models);
        }

        if (chosen) {
            selectedModel = chosen.id;
            selectedModelProvider = chosen.provider;
            els.modelName.textContent = chosen.name || chosen.id;
            els.modelBadge.title = `Model: ${chosen.id} (${chosen.provider})`;

            // Request format is derived from the model automatically (requestFormat: 'auto')
            // by the background script — no need to set it here.

            // Save the selected model to settings so background.js uses it
            currentSettings.selectedModel = chosen.id;
            await browserAPI.runtime.sendMessage({
                type: 'SAVE_SETTINGS',
                settings: currentSettings
            });
        }
    } catch (e) {
        console.error('Failed to load models:', e);
        els.modelName.textContent = 'Error';
        els.modelBadge.title = 'Failed to load models';
    }
}

// ============================================================================
// Settings
// ============================================================================

/** Load extension settings from the background script into currentSettings. */
async function loadSettings() {
    try {
        const response = await browserAPI.runtime.sendMessage({ type: 'GET_SETTINGS' });
        if (response.settings) {
            currentSettings = { ...DEFAULT_SETTINGS, ...response.settings };
        }
    } catch (e) {
        console.error('Failed to load settings:', e);
    }
    return currentSettings;
}

// ============================================================================
// Toast
// ============================================================================

// Toast status icons (feather-style, inherit currentColor).
const TOAST_ICON_SUCCESS = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="20 6 9 17 4 12"/></svg>';
const TOAST_ICON_ERROR = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg>';

/** Show a transient toast message with a success or error style. */
function showToast(message, type = 'success') {
    const toast = els.toast;
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
    }, 2500);
}

// ============================================================================
// Event Listeners
// ============================================================================

/** Wire up all page-level UI event listeners. */
function setupEventListeners() {
    // Language selector buttons
    els.sourceLangBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        toggleDropdown('source');
    });
    els.targetLangBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        toggleDropdown('target');
    });

    // Language search
    els.sourceLangSearch.addEventListener('input', (e) => {
        filterLanguages('source', e.target.value);
    });
    els.targetLangSearch.addEventListener('input', (e) => {
        filterLanguages('target', e.target.value);
    });

    // Prevent dropdown close when clicking inside
    els.sourceLangDropdown.addEventListener('click', (e) => e.stopPropagation());
    els.targetLangDropdown.addEventListener('click', (e) => e.stopPropagation());

    // Close dropdowns on outside click
    document.addEventListener('click', () => {
        closeDropdown('source');
        closeDropdown('target');
    });

    // Swap
    els.swapBtn.addEventListener('click', swapLanguages);

    // Translate
    els.translateBtn.addEventListener('click', translateText);

    // Ctrl+Enter to translate
    els.sourceText.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
            e.preventDefault();
            translateText();
        }
    });

    // Character count
    els.sourceText.addEventListener('input', updateCharCount);

    // Clear
    els.clearBtn.addEventListener('click', clearSource);

    // Copy
    els.copyBtn.addEventListener('click', copyTranslation);

    // Describe an image
    setupImageDescribe();
}

// ============================================================================
// Describe an image (issue #10)
// ============================================================================

/**
 * Read a File/Blob into a base64 image data URL.
 * @param {Blob} file
 * @returns {Promise<string>}
 */
function readImageAsDataUrl(file) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = () => reject(new Error('Could not read the image file.'));
        reader.readAsDataURL(file);
    });
}

/**
 * Stage an image (from drop, paste, or file-pick) for description.
 * @param {Blob} file
 */
async function stageImage(file) {
    if (!file || !file.type || !file.type.startsWith('image/')) {
        showToast('That file is not an image', 'error');
        return;
    }
    try {
        selectedImageDataUrl = await readImageAsDataUrl(file);
        els.imagePreview.src = selectedImageDataUrl;
        els.imagePreview.hidden = false;
        els.dropZoneText.hidden = true;
        els.describeBtn.disabled = false;
        els.clearImageBtn.hidden = false;
        els.describeOutput.hidden = true;
        els.describeOutput.classList.remove('error');
    } catch (e) {
        showToast(e.message, 'error');
    }
}

/** Clear the staged image and any description. */
function clearImage() {
    selectedImageDataUrl = null;
    els.imagePreview.src = '';
    els.imagePreview.hidden = true;
    els.dropZoneText.hidden = false;
    els.describeBtn.disabled = true;
    els.clearImageBtn.hidden = true;
    els.describeOutput.hidden = true;
    els.describeOutput.textContent = '';
    els.imageFileInput.value = '';
}

/** Send the staged image to the background vision pipeline and show the result. */
async function describeSelectedImage() {
    if (!selectedImageDataUrl || isDescribing) return;
    isDescribing = true;
    els.describeBtn.disabled = true;
    els.describeBtn.querySelector('.btn-text').hidden = true;
    els.describeBtn.querySelector('.btn-loading').hidden = false;
    els.describeOutput.hidden = true;
    els.describeOutput.classList.remove('error');

    try {
        const resp = await browserAPI.runtime.sendMessage({
            type: 'DESCRIBE_IMAGE',
            imageDataUrl: selectedImageDataUrl
        });
        if (!resp || resp.error) {
            els.describeOutput.textContent = resp?.error
                || 'No response from the background worker.';
            els.describeOutput.classList.add('error');
        } else {
            els.describeOutput.textContent = resp.text || '(empty description)';
        }
    } catch (e) {
        els.describeOutput.textContent = e.message;
        els.describeOutput.classList.add('error');
    } finally {
        els.describeOutput.hidden = false;
        isDescribing = false;
        els.describeBtn.disabled = !selectedImageDataUrl;
        els.describeBtn.querySelector('.btn-text').hidden = false;
        els.describeBtn.querySelector('.btn-loading').hidden = true;
    }
}

/** Wire the drop zone, paste, file-pick, describe, and clear controls. */
function setupImageDescribe() {
    if (!els.imageDropZone) return;

    els.imageDropZone.addEventListener('click', () => els.imageFileInput.click());
    els.imageDropZone.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            els.imageFileInput.click();
        }
    });

    els.imageFileInput.addEventListener('change', (e) => {
        const file = e.target.files && e.target.files[0];
        if (file) stageImage(file);
    });

    els.imageDropZone.addEventListener('dragover', (e) => {
        e.preventDefault();
        els.imageDropZone.classList.add('dragover');
    });
    els.imageDropZone.addEventListener('dragleave', () => {
        els.imageDropZone.classList.remove('dragover');
    });
    els.imageDropZone.addEventListener('drop', (e) => {
        e.preventDefault();
        els.imageDropZone.classList.remove('dragover');
        const file = e.dataTransfer.files && e.dataTransfer.files[0];
        if (file) stageImage(file);
    });

    // Paste an image anywhere on the page.
    document.addEventListener('paste', (e) => {
        const items = e.clipboardData && e.clipboardData.items;
        if (!items) return;
        for (const item of items) {
            if (item.type && item.type.startsWith('image/')) {
                const file = item.getAsFile();
                if (file) { stageImage(file); e.preventDefault(); }
                break;
            }
        }
    });

    els.describeBtn.addEventListener('click', describeSelectedImage);
    els.clearImageBtn.addEventListener('click', clearImage);
}

// ============================================================================
// Initialization
// ============================================================================

/** Initialize the translator page: settings, languages, events, and models. */
async function init() {
    // Load settings to get user preferences
    await loadSettings();

    // Set initial languages from settings, fallback to defaults
    if (currentSettings.sourceLanguage && currentSettings.sourceLanguage !== 'auto' && LANGUAGES[currentSettings.sourceLanguage]) {
        sourceLanguage = currentSettings.sourceLanguage;
    }
    if (currentSettings.targetLanguage && LANGUAGES[currentSettings.targetLanguage]) {
        targetLanguage = currentSettings.targetLanguage;
    }

    // Make sure source and target are different
    if (sourceLanguage === targetLanguage) {
        targetLanguage = sourceLanguage === 'en' ? 'es' : 'en';
    }

    // Update UI
    els.sourceLangName.textContent = LANGUAGES[sourceLanguage] || sourceLanguage;
    els.targetLangName.textContent = LANGUAGES[targetLanguage] || targetLanguage;

    // Build language selectors
    buildLanguageSelector('source');
    buildLanguageSelector('target');

    // Setup events
    setupEventListeners();

    // Check provider status & load models
    await checkStatus();
    await loadModels();

    // Update char count
    updateCharCount();
}

document.addEventListener('DOMContentLoaded', init);
