/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * The engine version shown in Settings must be the engine version we ship.
 *
 * Two files carry it: `scripts/prepareWaylandCore.js` decides which release tag
 * the bundled binary is fetched from, and the Overview card falls back to a
 * pinned literal until the running engine reports its own version. Those two
 * had already drifted - the card said `v0.9.6-rc.1` while the shipped binary
 * was `wayland-core 0.10.0` - so anyone opening Settings before the live
 * version arrived read a version that had not been shipped for two releases.
 *
 * A literal in a component is invisible to every other check, which is exactly
 * why it went stale. This test is the mechanical one.
 */

import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { PINNED_VERSION } from '@/renderer/pages/settings/WCoreConfig';

const REPO_ROOT = process.cwd();

/** The tag `prepareWaylandCore.js` fetches when nothing overrides it. */
function defaultWcoreVersion(): string {
  const source = readFileSync(join(REPO_ROOT, 'scripts', 'prepareWaylandCore.js'), 'utf-8');
  const match = /const\s+DEFAULT_WCORE_VERSION\s*=\s*['"]([^'"]+)['"]/.exec(source);
  if (!match) throw new Error('DEFAULT_WCORE_VERSION not found in scripts/prepareWaylandCore.js');
  return match[1];
}

describe('pinned engine version', () => {
  it('matches the tag the bundled binary is fetched from', () => {
    expect(PINNED_VERSION).toBe(defaultWcoreVersion());
  });

  it('is a v-prefixed semver-ish tag, so the card never shows a bare number', () => {
    expect(PINNED_VERSION).toMatch(/^v\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/);
  });

  /**
   * When a binary IS present (dev machine, or CI after prepare), its manifest
   * is the ground truth - it records what the engine actually reports. Skipped
   * on a clean checkout where the binary has not been fetched yet.
   */
  it('matches the manifest of a locally prepared binary', () => {
    const root = join(REPO_ROOT, 'resources', 'bundled-wayland-core');
    if (!existsSync(root)) return;
    const { readdirSync } = require('node:fs') as typeof import('node:fs');
    const manifests = readdirSync(root, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => join(root, e.name, 'manifest.json'))
      .filter((p) => existsSync(p));
    if (manifests.length === 0) return;

    for (const path of manifests) {
      const manifest = JSON.parse(readFileSync(path, 'utf-8')) as { version?: string };
      // e.g. "wayland-core 0.10.0" -> "0.10.0"
      const reported = /(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)/.exec(manifest.version ?? '')?.[1];
      expect(reported, `no version in ${path}`).toBeTruthy();
      expect(`v${reported}`, `manifest ${path} disagrees with PINNED_VERSION`).toBe(PINNED_VERSION);
    }
  });
});
