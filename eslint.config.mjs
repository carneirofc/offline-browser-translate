import js from '@eslint/js';
import globals from 'globals';
import jsdoc from 'eslint-plugin-jsdoc';

// Symbols declared at the top level of languages.js and defaults.js. They are
// loaded before the other scripts in every HTML page (and concatenated ahead of
// background.js), so consuming files reference these as shared globals.
const sharedGlobals = {
  // Defined in defaults.js — the single source of truth for default settings.
  DEFAULT_SETTINGS: 'readonly',
  DEFAULT_DESCRIBE_PROMPT: 'readonly',
  DEFAULT_TRANSLATE_TEMPLATE: 'readonly',
  LANGUAGES: 'readonly',
  LOCAL_HOSTNAMES: 'readonly',
  ensureHostPermissions: 'readonly',
  hostPermissionPattern: 'readonly',
  getLanguageCode: 'readonly',
  getLanguageName: 'readonly',
  // Exposed by llama-server.js / translate-pipeline.js for the background script.
  createLlamaServer: 'readonly',
  createPipeline: 'readonly',
  TRANSLATION_JSON_SCHEMA: 'readonly',
  // Exposed by cache.js for the background script.
  cacheKey: 'readonly',
  cacheGetMany: 'readonly',
  cacheSetMany: 'readonly',
  cacheClear: 'readonly',
  cacheCount: 'readonly',
  cachePersistentAvailable: 'readonly',
  // Exposed by translation-core.js — pure helpers shared by the background
  // worker and the content script (and unit-tested under Node).
  normalizeLangCode: 'readonly',
  detectLanguageByScript: 'readonly',
  detectSourceLanguage: 'readonly',
  resolveSourceLanguage: 'readonly',
  formatTextsForPrompt: 'readonly',
  buildPrompt: 'readonly',
  cleanTranslationText: 'readonly',
  isSuspiciousTranslation: 'readonly',
  extractJsonObject: 'readonly',
  parseTranslationResponse: 'readonly',
  splitIntoSentences: 'readonly',
  estimateTokens: 'readonly',
  groupTextNodesIntoBatches: 'readonly',
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
  {
    // Dev-only JSDoc enforcement (issue #3). Requires a JSDoc block on every
    // top-level function declaration and fails on malformed JSDoc. The plugin
    // and this config are dev dependencies only — nothing here ships in the
    // extension bundle, which loads with no node_modules present.
    files: ['**/*.js'],
    plugins: { jsdoc },
    rules: {
      'jsdoc/require-jsdoc': ['error', {
        require: { FunctionDeclaration: true },
        // Only top-level functions; nested helpers/callbacks aren't required.
        contexts: [':not(:matches(BlockStatement, ForStatement, WhileStatement)) > FunctionDeclaration'],
        exemptEmptyFunctions: true,
      }],
      // Malformed-JSDoc checks (only fire on blocks that exist).
      'jsdoc/check-alignment': 'error',
      'jsdoc/check-param-names': 'error',
      'jsdoc/check-property-names': 'error',
      'jsdoc/check-tag-names': ['error', { definedTags: ['returns'] }],
      'jsdoc/check-types': 'error',
      'jsdoc/no-undefined-types': 'off', // classic-script globals aren't importable
      'jsdoc/require-param-name': 'error',
      'jsdoc/require-property-name': 'error',
      'jsdoc/valid-types': 'error',
      // Keep the requirement light: a description is enough; param/return prose
      // and full type annotations are encouraged but not enforced.
      'jsdoc/require-param': 'off',
      'jsdoc/require-returns': 'off',
      'jsdoc/require-param-description': 'off',
      'jsdoc/require-returns-description': 'off',
    },
  },
  {
    // These files are dual-target: browser/worker global modules AND CommonJS
    // modules required by the Vitest suite. Give them Node globals so their
    // `module.exports` guard lints clean.
    files: ['translation-core.js', 'cache.js', 'languages.js', 'defaults.js', 'llama-server.js', 'translate-pipeline.js'],
    languageOptions: {
      globals: { ...globals.node },
    },
  },
  {
    // Unit tests run under Vitest (dev-only; never shipped). They are ES modules
    // and use Vitest's global describe/it/expect.
    files: ['test/**/*.js'],
    languageOptions: {
      sourceType: 'module',
      globals: { ...globals.node, ...globals.vitest },
    },
  },
  {
    // Vitest config is an ES module (dev-only; never shipped).
    files: ['vitest.config.js'],
    languageOptions: {
      sourceType: 'module',
      globals: { ...globals.node },
    },
  },
  {
    // Dev-only packaging scripts — ES modules run under Node, never shipped.
    files: ['scripts/**'],
    languageOptions: {
      sourceType: 'module',
      globals: { ...globals.node },
    },
  },
];
