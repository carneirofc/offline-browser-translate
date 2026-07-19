import { defineConfig } from 'vitest/config';

// Dev-only test configuration. Never shipped in the extension bundle.
//
// The DOM environment (jsdom) is used even though the current characterization
// tests exercise pure functions: the extension's `self`/`window`/`document`
// globals exist under jsdom, so the dual-target modules load cleanly here, and
// later DOM-level tests for the content script can be added without reconfiguring.
export default defineConfig({
  test: {
    environment: 'jsdom',
    include: ['test/**/*.test.js'],
    globals: true,
  },
});
