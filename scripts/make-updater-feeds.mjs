#!/usr/bin/env node
/**
 * Write the electron-updater feeds a release needs, and own the list of
 * installers that release must carry.
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
 * WHY THE INSTALLER LIST LIVES HERE. Two consumers read these feeds and they
 * want different things:
 *
 *   1. electron-updater (background updates). It fetches ONE channel file whose
 *      name it derives itself - `getUpdateChannel()` in
 *      `src/process/services/autoUpdaterService.ts` picks the channel, and
 *      `Provider.getChannelFilePrefix()` in electron-updater appends the
 *      platform suffix. The six names below are the complete set that mapping
 *      can produce for the six platform/arch pairs the matrix builds. A missing
 *      one is not a degraded update, it is `ERR_UPDATER_CHANNEL_FILE_NOT_FOUND`
 *      on every check for that platform, forever.
 *   2. The in-app downloader (`updateBridge.ts`). It picks an asset with
 *      `pickRecommendedAsset`, downloads it, then demands a sha512 for THAT
 *      EXACT FILE NAME from some `latest*.yml` on the release. No digest means
 *      `assetNotInMetadata`, the downloaded file is deleted and the user sees an
 *      error - fail closed by design. On Linux the asset it recommends is the
 *      `.deb`/`.rpm`, not the AppImage, so listing only the AppImage leaves the
 *      recommended download unverifiable.
 *
 * So a feed is not "one file per platform": it is every installer that platform
 * can install, and the release's installer list is derived from these entries
 * rather than typed separately in the workflow. That makes "an installer with no
 * digest anywhere" unrepresentable instead of merely discouraged - releases up
 * to and including v0.9.7-mn.10 shipped three feeds for ten installers, and
 * five of the six platform/arch pairs could not update by either path.
 *
 * Usage:
 *   node scripts/make-updater-feeds.mjs <assets-dir> [--version 0.9.7-mn.11]
 *   node scripts/make-updater-feeds.mjs --list-feeds
 *   node scripts/make-updater-feeds.mjs --list-installers [--version <v>]
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

/**
 * One feed per channel file electron-updater can ask for, listing every
 * installer that channel's platform/arch can actually install.
 *
 * The names are exact. electron-updater builds them as
 * `${channel}${channelFilePrefix}.yml`, so `latest-arm64-mac.yml` (macOS arm64)
 * and `latest-win-arm64.yml` (Windows arm64) are not typos - they are the
 * channel name from `getUpdateChannel()` with electron-updater's own suffix.
 *
 * Order inside `installers` matters: the first entry becomes the feed's
 * top-level `path`/`sha512`, which is the legacy single-file form older
 * electron-updater builds fall back to when `files` is absent.
 */
const FEEDS = [
  {
    feed: 'latest.yml',
    platform: 'Windows x64',
    installers: (v) => [`Darhai-${v}-win-x64.exe`],
  },
  {
    feed: 'latest-win-arm64.yml',
    platform: 'Windows arm64',
    installers: (v) => [`Darhai-${v}-win-arm64.exe`],
  },
  {
    // macOS self-update through electron-updater additionally needs a `.zip`,
    // which this release deliberately does not upload. This feed exists for the
    // in-app path: it is what gives the `.dmg` the digest it is verified
    // against. See docs/contributing/releasing.md.
    feed: 'latest-mac.yml',
    platform: 'macOS x64',
    installers: (v) => [`Darhai-${v}-mac-x64.dmg`],
  },
  {
    feed: 'latest-arm64-mac.yml',
    platform: 'macOS arm64',
    installers: (v) => [`Darhai-${v}-mac-arm64.dmg`],
  },
  {
    // electron-updater picks the entry by extension (AppImageUpdater looks for
    // `.AppImage`, DebUpdater for `.deb`, RpmUpdater for `.rpm`), so all three
    // packaging formats belong in the one channel file for this arch.
    feed: 'latest-linux.yml',
    platform: 'Linux x64',
    installers: (v) => [
      `Darhai-${v}-linux-x86_64.AppImage`,
      `Darhai-${v}-linux-amd64.deb`,
      `Darhai-${v}-linux-x86_64.rpm`,
    ],
  },
  {
    feed: 'latest-linux-arm64.yml',
    platform: 'Linux arm64',
    installers: (v) => [
      `Darhai-${v}-linux-arm64.AppImage`,
      `Darhai-${v}-linux-arm64.deb`,
      `Darhai-${v}-linux-aarch64.rpm`,
    ],
  },
];

/** Every installer the release must carry, in feed order, deduplicated. */
function installerNames(version) {
  const seen = new Set();
  for (const { installers } of FEEDS) {
    for (const name of installers(version)) seen.add(name);
  }
  return [...seen];
}

function resolveVersion(rest) {
  const flag = rest.indexOf('--version');
  if (flag >= 0 && rest[flag + 1]) return rest[flag + 1];
  return JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf-8')).version;
}

/** Build one feed body, or null when a file it needs is not on disk. */
function renderFeed(dir, version, entry, releaseDate) {
  const parts = [];
  for (const name of entry.installers(version)) {
    const path = join(dir, name);
    if (!existsSync(path)) {
      console.error(`::error::${entry.platform}: ${name} not found in ${dir} - no feed written`);
      return null;
    }
    parts.push({ name, sha512: sha512Base64(path), size: statSync(path).size });
  }

  const body = [`version: ${version}`, 'files:'];
  for (const part of parts) {
    body.push(`  - url: ${part.name}`, `    sha512: ${part.sha512}`, `    size: ${part.size}`);
  }
  body.push(`path: ${parts[0].name}`, `sha512: ${parts[0].sha512}`, `releaseDate: '${releaseDate}'`, '');
  return body.join('\n');
}

function writeFeeds(dir, version) {
  // One timestamp for the whole release: six feeds describing the same build
  // with six different times reads as six releases to anyone diffing them.
  const releaseDate = new Date().toISOString().replace(/\.\d{3}Z$/, '.000Z');

  let missing = 0;
  for (const entry of FEEDS) {
    const body = renderFeed(dir, version, entry, releaseDate);
    if (body === null) {
      missing += 1;
      continue;
    }
    writeFileSync(join(dir, entry.feed), body, 'utf-8');
    console.log(`wrote ${entry.feed} -> ${entry.installers(version).join(', ')}`);
  }

  if (missing > 0) {
    // Fail loudly: a release published with a feed missing leaves that platform
    // permanently on the previous version with no error anyone can see.
    console.error(`::error::${missing} feed(s) could not be written`);
    process.exit(1);
  }
}

function main() {
  const argv = process.argv.slice(2);

  // Listing modes exist so the workflow never restates these names. A second
  // copy of the installer list in YAML is exactly how the feed table and the
  // uploaded assets drifted apart in the first place.
  if (argv.includes('--list-feeds')) {
    for (const { feed } of FEEDS) console.log(feed);
    return;
  }
  if (argv.includes('--list-installers')) {
    for (const name of installerNames(resolveVersion(argv))) console.log(name);
    return;
  }

  const [dir, ...rest] = argv;
  if (!dir || dir.startsWith('--')) {
    console.error('usage: node scripts/make-updater-feeds.mjs <assets-dir> [--version <v>]');
    console.error('       node scripts/make-updater-feeds.mjs --list-feeds');
    console.error('       node scripts/make-updater-feeds.mjs --list-installers [--version <v>]');
    process.exit(2);
  }

  writeFeeds(dir, resolveVersion(rest));
}

main();
