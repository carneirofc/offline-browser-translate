// Ambient declarations for host globals the extension relies on but that have no
// bundled type packages. Dev-only: consumed by `tsc --checkJs`, never shipped.
//
// The WebExtension APIs are exposed under both `chrome` (Chromium) and `browser`
// (Firefox); the code accesses them dynamically, so a permissive `any` is enough
// to keep type-checking focused on the extension's own logic rather than on
// modelling the entire WebExtension surface.
declare const chrome: any;
declare const browser: any;
