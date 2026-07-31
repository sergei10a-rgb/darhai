/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Mechanical guard for visual coverage.
 *
 * A visual suite is only trustworthy if it grows with the app. Relying on
 * people to remember "add a baseline when you add a screen" fails silently -
 * the suite stays green while coverage shrinks in relative terms. These tests
 * turn that convention into something that breaks the build:
 *
 *   - a route added to the router with no registry entry fails,
 *   - a registry entry for a route that no longer exists fails,
 *   - a registry entry claiming a baseline that is not on disk fails,
 *   - a baseline on disk that no registry entry claims fails.
 *
 * Deliberately a plain unit test: it parses source and reads the filesystem,
 * so it runs in milliseconds and gates every commit, not just visual runs.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { SCREEN_REGISTRY, type ScreenCoverage } from '../e2e/visual/screenRegistry';

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const ROUTER_FILE = path.join(REPO_ROOT, 'src/renderer/components/layout/Router.tsx');
const BASELINE_ROOT = path.join(REPO_ROOT, 'tests/e2e/visual/__baselines__');

/** Every `path='...'` declared in the router, deduplicated. */
function routerPaths(): string[] {
  const source = fs.readFileSync(ROUTER_FILE, 'utf-8');
  const matches = source.matchAll(/path=(?:'([^']*)'|"([^"]*)")/g);
  return [...new Set([...matches].map((m) => m[1] ?? m[2]))].sort();
}

function hasBaselines(entry: ScreenCoverage): entry is { readonly baselines: readonly string[] } {
  return 'baselines' in entry;
}

/** Baseline PNGs recorded for each platform directory that exists. */
function recordedBaselines(): { platform: string; file: string }[] {
  if (!fs.existsSync(BASELINE_ROOT)) return [];
  return fs
    .readdirSync(BASELINE_ROOT, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .flatMap((dir) =>
      fs
        .readdirSync(path.join(BASELINE_ROOT, dir.name))
        .filter((f) => f.endsWith('.png'))
        .map((file) => ({ platform: dir.name, file }))
    );
}

describe('visual screen registry', () => {
  it('accounts for every route declared in the router', () => {
    const unregistered = routerPaths().filter((p) => !(p in SCREEN_REGISTRY));

    expect(
      unregistered,
      `These routes exist in Router.tsx but are missing from SCREEN_REGISTRY:\n` +
        unregistered.map((p) => `  ${p}`).join('\n') +
        `\n\nAdd each one to tests/e2e/visual/screenRegistry.ts with either a ` +
        `baseline that covers it or an explicit skip reason. This check exists so a ` +
        `new screen cannot ship without that decision being made.`
    ).toEqual([]);
  });

  it('has no stale entries for routes that no longer exist', () => {
    const live = new Set(routerPaths());
    const stale = Object.keys(SCREEN_REGISTRY).filter((p) => !live.has(p));

    expect(
      stale,
      `These entries are in SCREEN_REGISTRY but no longer exist in Router.tsx:\n` +
        stale.map((p) => `  ${p}`).join('\n') +
        `\n\nRemove them, or fix the path if the route was renamed.`
    ).toEqual([]);
  });

  it('requires every skip reason to actually say something', () => {
    const empty = Object.entries(SCREEN_REGISTRY)
      .filter(([, entry]) => !hasBaselines(entry) && entry.skip.trim().length < 10)
      .map(([route]) => route);

    expect(empty, `These routes are skipped without a real reason: ${empty.join(', ')}`).toEqual([]);
  });

  it('every claimed baseline exists on disk for at least one platform', () => {
    const recorded = new Set(recordedBaselines().map((b) => b.file));
    const claimed = Object.entries(SCREEN_REGISTRY).flatMap(([route, entry]) =>
      hasBaselines(entry) ? entry.baselines.map((file) => ({ route, file })) : []
    );
    const missing = claimed.filter((c) => !recorded.has(c.file));

    expect(
      missing.map((m) => `${m.route} -> ${m.file}`),
      `The registry claims these baselines but no recorded image matches:\n` +
        missing.map((m) => `  ${m.route} -> ${m.file}`).join('\n') +
        `\n\nEither record the baseline (run the visual project) or correct the registry.`
    ).toEqual([]);
  });

  it('every recorded baseline is claimed by a registry entry', () => {
    const claimed = new Set(
      Object.values(SCREEN_REGISTRY).flatMap((entry) => (hasBaselines(entry) ? [...entry.baselines] : []))
    );
    const orphans = recordedBaselines()
      .filter((b) => !claimed.has(b.file))
      .map((b) => `${b.platform}/${b.file}`);

    expect(
      orphans,
      `These baseline images are recorded but no registry entry claims them:\n` +
        orphans.map((o) => `  ${o}`).join('\n') +
        `\n\nAn unclaimed baseline is a screenshot nobody owns: add it to the route it ` +
        `covers in screenRegistry.ts, or delete it if it is stale.`
    ).toEqual([]);
  });
});
