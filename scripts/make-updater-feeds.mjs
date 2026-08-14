#!/usr/bin/env node
/**
 * Write the electron-updater feeds a release needs.
 *
 * WHY THIS EXISTS. `electron-builder` only emits `latest*.yml` when it is
 * publishing, and every build in this repo runs `--publish=never` on purpose
 * (see `scripts/build-with-builder.js` - implicit tag-based publishing would
 * upload from any branch that happened to be tagged). So the build artifacts
 * carry installers and no feeds, `prepare-release-assets.sh` fails its metadata
 * validation, and the feeds get hand-written - which is how a release ends up
 * with a `sha512` that does not match the file beside it, and every installed
 * copy silently stops updating.
 *
 * This computes them from the actual files instead.
 *
 * Usage:
 *   node scripts/make-updater-feeds.mjs <assets-dir> [--version 0.9.7-mn.11]
 *
 * The version defaults to `package.json`. Files are matched by the names
 * `electron-builder.yml` produces, so a rename there fails here loudly rather
 * than shipping a feed pointing at a file that does not exist.
 */

import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * electron-updater compares this against its own digest of the downloaded
 * file. Base64 of the raw SHA-512 - NOT hex, which is the shape most other
 * tooling prints and would fail every update with an opaque checksum error.
 */
function sha512Base64(path) {
  return createHash('sha512').update(readFileSync(path)).digest('base64');
}

/** One feed: which file an installed copy of that platform should fetch. */
const FEEDS = [
  { feed: 'latest.yml', file: (v) => `Darhai-${v}-win-x64.exe`, platform: 'Windows x64' },
  { feed: 'latest-linux.yml', file: (v) => `Darhai-${v}-linux-x86_64.AppImage`, platform: 'Linux x64' },
  { feed: 'latest-linux-arm64.yml', file: (v) => `Darhai-${v}-linux-arm64.AppImage`, platform: 'Linux arm64' },
];

function main() {
  const [dir, ...rest] = process.argv.slice(2);
  if (!dir) {
    console.error('usage: node scripts/make-updater-feeds.mjs <assets-dir> [--version <v>]');
    process.exit(2);
  }

  const versionFlag = rest.indexOf('--version');
  const version =
    versionFlag >= 0 && rest[versionFlag + 1]
      ? rest[versionFlag + 1]
      : JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf-8')).version;

  // One timestamp for the whole release: three feeds describing the same build
  // with three different times reads as three releases to anyone diffing them.
  const releaseDate = new Date().toISOString().replace(/\.\d{3}Z$/, '.000Z');

  let missing = 0;
  for (const { feed, file, platform } of FEEDS) {
    const name = file(version);
    const path = join(dir, name);
    if (!existsSync(path)) {
      console.error(`::error::${platform}: ${name} not found in ${dir} - no feed written`);
      missing += 1;
      continue;
    }

    const body = [
      `version: ${version}`,
      'files:',
      `  - url: ${name}`,
      `    sha512: ${sha512Base64(path)}`,
      `    size: ${statSync(path).size}`,
      `path: ${name}`,
      `sha512: ${sha512Base64(path)}`,
      `releaseDate: '${releaseDate}'`,
      '',
    ].join('\n');

    writeFileSync(join(dir, feed), body, 'utf-8');
    console.log(`wrote ${feed} -> ${name}`);
  }

  if (missing > 0) {
    // Fail loudly: a release published with a feed missing leaves that platform
    // permanently on the previous version with no error anyone can see.
    console.error(`::error::${missing} feed(s) could not be written`);
    process.exit(1);
  }
}

main();
