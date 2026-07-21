#!/usr/bin/env node
// Dev-only packaging: emit a Firefox zip and a Chrome-clean zip from the single
// source tree, with no runtime build step (mirrors how `web-ext build` zips).
//
// The Firefox package ships the manifest exactly as authored. The Chrome
// package gets a manifest with the Firefox-only keys stripped so it loads
// unpacked in Chrome without warnings:
//   - `browser_specific_settings` (the Gecko add-on id / min-version block)
//   - the top-level `developer` key (a Firefox manifest field Chrome rejects)
//   - `background.scripts` (Firefox loads the module list this way; Chrome uses
//     the single `background.service_worker`, which imports its deps at runtime)
//
// Both zips are produced by `web-ext build`, so the shared `webExt.ignoreFiles`
// list in package.json decides what is bundled — dev-only files never ship.

import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const manifestPath = join(root, 'manifest.json');
const artifactsDir = join(root, 'web-ext-artifacts');
const webExtBin = join(root, 'node_modules', '.bin', 'web-ext');

const manifestRaw = readFileSync(manifestPath, 'utf8');
const manifest = JSON.parse(manifestRaw);
const { version } = manifest;

/**
 * Package the current source tree into `artifactsDir/<filename>`.
 * @param {string} filename Output zip name.
 */
function build(filename) {
  execFileSync(
    webExtBin,
    [
      'build',
      `--source-dir=${root}`,
      `--artifacts-dir=${artifactsDir}`,
      `--filename=${filename}`,
      '--overwrite-dest',
    ],
    { stdio: 'inherit', cwd: root },
  );
}

/**
 * Return a copy of the manifest with Firefox-only keys removed so Chrome loads
 * it without warnings.
 * @param {Record<string, any>} m The authored (Firefox) manifest.
 * @returns {Record<string, any>} The Chrome-clean manifest.
 */
function toChromeManifest(m) {
  const chrome = structuredClone(m);
  delete chrome.browser_specific_settings;
  delete chrome.developer;
  if (chrome.background) {
    chrome.background = { service_worker: chrome.background.service_worker };
  }
  return chrome;
}

mkdirSync(artifactsDir, { recursive: true });

// Clear stale zips so the release glob (`web-ext-artifacts/*.zip`) only ever
// picks up this run's Firefox + Chrome packages.
for (const f of readdirSync(artifactsDir)) {
  if (f.endsWith('.zip')) rmSync(join(artifactsDir, f));
}

console.log('→ Building Firefox package…');
build(`local-llm-translate-${version}-firefox.zip`);

console.log('→ Building Chrome package…');
writeFileSync(manifestPath, `${JSON.stringify(toChromeManifest(manifest), null, 2)}\n`);
try {
  build(`local-llm-translate-${version}-chrome.zip`);
} finally {
  // Always restore the authored manifest, even if the Chrome build throws.
  writeFileSync(manifestPath, manifestRaw);
}

console.log(`✓ Packages written to ${artifactsDir}`);
