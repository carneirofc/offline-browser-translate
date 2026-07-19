import js from '@eslint/js';
import globals from 'globals';

// Symbols declared at the top level of languages.js and defaults.js. They are
// loaded before the other scripts in every HTML page (and concatenated ahead of
// background.js), so consuming files reference these as shared globals.
const sharedGlobals = {
  // Defined in defaults.js — the single source of truth for default settings.
  DEFAULT_SETTINGS: 'readonly',
  DEFAULT_DESCRIBE_PROMPT: 'readonly',
  LANGUAGES: 'readonly',
  LOCAL_HOSTNAMES: 'readonly',
  MODEL_FORMAT_RULES: 'readonly',
  PLAIN_TEXT_FORMATS: 'readonly',
  detectRequestFormat: 'readonly',
  resolveRequestFormat: 'readonly',
  ensureHostPermissions: 'readonly',
  hostPermissionPattern: 'readonly',
  getLanguageCode: 'readonly',
  getLanguageName: 'readonly',
  // Exposed by cache.js for the background script.
  cacheKey: 'readonly',
  cacheGetMany: 'readonly',
  cacheSetMany: 'readonly',
  cacheClear: 'readonly',
  cacheCount: 'readonly',
  cachePersistentAvailable: 'readonly',
};

export default [
  {
    ignores: [
      'graphify-out/**',
      'web-ext-artifacts/**',
      '.github/**',
      '.claude/**',
      '.agents/**',
      'node_modules/**',
    ],
  },
  js.configs.recommended,
  {
    files: ['**/*.js'],
    languageOptions: {
      ecmaVersion: 'latest',
      // The extension scripts are loaded as classic scripts (not ES modules)
      // and background scripts share a single global scope.
      sourceType: 'script',
      globals: {
        ...globals.browser,
        ...globals.serviceworker,
        ...globals.webextensions,
        ...sharedGlobals,
      },
    },
    rules: {
      // Real correctness checks stay as errors; the defining file is allowed to
      // declare the shared globals above (builtinGlobals: false).
      'no-redeclare': ['error', { builtinGlobals: false }],
      // Existing, intentional patterns in the DOM-walking code — surfaced, not fatal.
      'no-unused-vars': ['warn', { args: 'none', varsIgnorePattern: '^_' }],
      'no-empty': ['warn', { allowEmptyCatch: true }],
      'no-constant-condition': ['warn', { checkLoops: false }],
      'no-cond-assign': ['warn', 'except-parens'],
      'no-case-declarations': 'warn',
      'no-useless-escape': 'warn',
    },
  },
];
