/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Vendored agent-profile → Assistants merge (2026-05-21).
 *
 * The FoundrySkills bundle vendored at `src/process/resources/skills-library/`
 * carries 25 `type: 'agent-profile'` entries — single-character personas like
 * `executive-communicator`, `marketing-strategist`, `legal-compliance-reviewer`.
 * These are NOT skills (the agent doesn't reach for them mid-task); they're
 * mini assistants. Before this merge, they landed on the Skills page as if
 * they were skills, and the Workspace > Assistants page never saw them.
 *
 * This overlay reads the 25 entries on registry init, converts each to the
 * assistant shape used by the rest of the system (mirrors the bundled
 * waylandteams `assistants.json`), and appends them to the live assistants
 * list with id-dedup against the existing set: when an id is already taken
 * by a live waylandteams or extension-contributed assistant, the live record
 * wins (it's hand-curated for the team release). New ids get added.
 *
 * The `prompts.system` field is populated inline from the body SKILL.md, so
 * the assistant is self-contained and works without a new contextFile
 * resolution path.
 *
 * Idempotent (cached after first build). Degrades cleanly when any input
 * file is unreadable.
 */

import path from 'path';
import { existsSync, readFileSync } from 'fs';

const TAG = '[AgentProfileMerge]';

type VendoredAgentProfile = {
  id: string;
  name: string;
  description: string;
  presetAgentType: 'agent-profile';
  category: string;
  prompts: { system: string };
  isPreset: true;
  kind: 'specialist';
  /** Provenance tag so downstream code can identify these vs hand-curated. */
  _source: 'vendored-agent-profile';
};

let cached: VendoredAgentProfile[] | null = null;

/**
 * Same path-resolution pattern as `resolveSkillsLibraryDir()` in SkillLibrary.ts —
 * walks the candidate list once to find `index.json` on disk. Inlined here so
 * this overlay has no dependency on the SkillLibrary singleton (the overlay
 * runs at ExtensionRegistry init time, which is before any IPC bridge is up).
 */
function resolveSkillsLibraryDir(): string | null {
  const myDir = path.dirname(__filename);
  const baseDir = path.basename(myDir) === 'chunks' ? path.dirname(myDir) : myDir;
  // ExtensionRegistry lives in `out/main/` (dev) or `app.asar/out/main/`
  // (packaged); from there walk back to the project / asar-unpacked root.
  const baseDirUnpacked = baseDir.replace('app.asar', 'app.asar.unpacked');
  const candidates = [
    path.resolve(baseDirUnpacked, '../../resources/skills-library'),
    path.resolve(baseDir, '../../src/process/resources/skills-library'),
    path.resolve(baseDir, '../../resources/skills-library'),
    path.resolve(baseDir, '../resources/skills-library'),
  ];
  for (const c of candidates) {
    if (existsSync(path.join(c, 'index.json'))) return c;
  }
  return null;
}

function toDisplayName(slug: string): string {
  // Mirror the renderer's displayName.ts logic so the names look the same on
  // both sides without sharing a renderer dep (renderer/process boundary).
  const ACRONYMS = new Set(['AI', 'API', 'CLI', 'CSS', 'HTML', 'HTTP', 'ID', 'IP', 'JS', 'JSON', 'ML', 'OS', 'PR', 'QA', 'SDK', 'SEO', 'SQL', 'SSH', 'TS', 'UI', 'URL', 'UX', 'VPN', 'XML']);
  let label = slug
    .split('-')
    .filter(Boolean)
    .map((word) => {
      const upper = word.toUpperCase();
      if (ACRONYMS.has(upper)) return upper;
      return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();
    })
    .join(' ');
  label = label.replace(/\bAI Machine Learning\b/g, 'AI & Machine Learning');
  label = label.replace(/\bMarketing Sales\b/g, 'Marketing & Sales');
  label = label.replace(/\bDevOps Cloud\b/g, 'DevOps & Cloud');
  return label;
}

/**
 * Best-effort map from the FoundrySkills category slug to one of the seven
 * assistant categories used by the chat-surface picker. Unmapped categories
 * fall back to 'general' so we never drop an assistant for a category we
 * haven't seen yet.
 */
function mapCategory(rawCategory: string | undefined): string {
  if (!rawCategory) return 'general';
  const c = rawCategory.toLowerCase();
  if (c.includes('finance') || c.includes('business') || c.includes('sales') || c.includes('marketing')) return 'sell';
  if (c.includes('writ') || c.includes('content') || c.includes('communication')) return 'write';
  if (c.includes('research') || c.includes('analy') || c.includes('legal')) return 'research';
  if (c.includes('engineer') || c.includes('develop') || c.includes('code') || c.includes('build')) return 'build';
  if (c.includes('ops') || c.includes('operat') || c.includes('manag') || c.includes('product')) return 'run';
  if (c.includes('office') || c.includes('admin')) return 'office';
  return 'general';
}

/**
 * Build the 25-entry overlay once and cache it. Returns [] on any I/O failure.
 */
function buildOverlay(): VendoredAgentProfile[] {
  if (cached !== null) return cached;

  const dir = resolveSkillsLibraryDir();
  if (!dir) {
    console.warn(`${TAG} Skills library not found on disk; agent-profile merge disabled.`);
    cached = [];
    return cached;
  }

  let index: unknown;
  try {
    const raw = readFileSync(path.join(dir, 'index.json'), 'utf-8');
    index = JSON.parse(raw);
  } catch (err) {
    console.warn(`${TAG} Failed to read skills-library index.json: ${String(err)}`);
    cached = [];
    return cached;
  }
  if (!Array.isArray(index)) {
    console.warn(`${TAG} skills-library index.json is not an array; merge disabled.`);
    cached = [];
    return cached;
  }

  const out: VendoredAgentProfile[] = [];
  const seen = new Set<string>();

  for (const entry of index) {
    if (!entry || typeof entry !== 'object') continue;
    const e = entry as Record<string, unknown>;
    if (e.type !== 'agent-profile') continue;
    const name = typeof e.name === 'string' ? e.name : null;
    if (!name) continue;
    // Index has duplicate slugs in places — keep the first.
    if (seen.has(name)) continue;
    seen.add(name);

    const description = typeof e.description === 'string' ? e.description : '';
    const metadata = (e.metadata ?? {}) as Record<string, unknown>;
    const relPath = typeof e.path === 'string' ? e.path : null;
    const rawCategory = typeof metadata.category === 'string' ? metadata.category : undefined;

    let body = '';
    if (relPath) {
      try {
        body = readFileSync(path.join(dir, relPath), 'utf-8');
      } catch {
        // Skip silently — the metadata-only assistant still surfaces.
      }
    }

    out.push({
      id: name,
      name: toDisplayName(name),
      description,
      presetAgentType: 'agent-profile',
      category: mapCategory(rawCategory),
      prompts: { system: body },
      isPreset: true,
      kind: 'specialist',
      _source: 'vendored-agent-profile',
    });
  }

  cached = out;
  return out;
}

/**
 * Merge the 25 vendored agent-profiles into the live assistants list.
 *
 * - If an id already exists in `liveAssistants`, the live record wins.
 * - New ids are appended (the renderer sorts on display).
 * - Always returns the input array's contents plus any non-colliding overlays.
 * - The input is never mutated.
 */
export function mergeVendoredAgentProfiles(
  liveAssistants: Record<string, unknown>[],
): Record<string, unknown>[] {
  const overlay = buildOverlay();
  if (overlay.length === 0) return liveAssistants;

  const liveIds = new Set<string>();
  for (const a of liveAssistants) {
    const id = (a as { id?: unknown }).id;
    if (typeof id === 'string') liveIds.add(id);
  }

  const merged: Record<string, unknown>[] = liveAssistants.slice();
  let added = 0;
  for (const profile of overlay) {
    if (liveIds.has(profile.id)) continue;
    merged.push(profile as unknown as Record<string, unknown>);
    added += 1;
  }

  if (added > 0) {
    console.log(`${TAG} Added ${added} vendored agent-profile assistant(s).`);
  }
  return merged;
}

/** Test-only: drop the cached overlay so a fresh build runs. */
export function __resetAgentProfileMergeCacheForTests(): void {
  cached = null;
}
