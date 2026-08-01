/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

import * as path from 'path';
import { existsSync } from 'fs';
import type { LoadedExtension, ExtSkill } from '../types';
import { isPathWithinDirectory } from '../sandbox/pathSafety';
import type { SkillIndexEntry } from '@/common/types/skillTypes';
import { SkillLibrary } from '@process/services/skills/SkillLibrary';

export type ResolvedSkill = {
  name: string;
  description: string;
  location: string;
};

export function resolveSkills(extensions: LoadedExtension[]): ResolvedSkill[] {
  const skills: ResolvedSkill[] = [];
  for (const ext of extensions) {
    const declaredSkills = ext.manifest.contributes.skills;
    if (!declaredSkills || declaredSkills.length === 0) continue;
    for (const skill of declaredSkills) {
      const resolved = convertSkill(skill, ext);
      if (resolved) {
        skills.push(resolved);
      }
    }
  }
  return skills;
}

function convertSkill(skill: ExtSkill, ext: LoadedExtension): ResolvedSkill | null {
  const absolutePath = path.resolve(ext.directory, skill.file);
  if (!isPathWithinDirectory(absolutePath, ext.directory)) {
    console.warn(`[Extensions] Skill file path traversal attempt: ${skill.file} in ${ext.manifest.name}`);
    return null;
  }
  if (!existsSync(absolutePath)) {
    console.warn(`[Extensions] Skill file not found: ${absolutePath} (extension: ${ext.manifest.name})`);
    return null;
  }
  return {
    name: skill.name,
    description: skill.description || `Skill from extension: ${ext.manifest.name}`,
    location: absolutePath,
  };
}

// ---------------------------------------------------------------------------
// Publishing to the SkillLibrary
// ---------------------------------------------------------------------------

const TAG = '[ExtensionSkillMerge]';

/** Convert one resolved extension skill into a library index entry. */
function toIndexEntry(skill: ResolvedSkill): SkillIndexEntry {
  return {
    name: skill.name,
    description: skill.description,
    type: 'skill',
    source: 'extension',
    // Absolute `path` (already verified to live inside the extension directory
    // by `convertSkill`), so `SkillLibrary.loadBody` reads it directly - the
    // same arrangement `teamSkillMerge` uses.
    metadata: { tags: [], category: 'extension' },
    path: skill.location,
  };
}

/**
 * Make the library's `extension` source exactly `skills`.
 *
 * Until this existed, `resolveSkills`' output went no further than
 * `ExtensionRegistry.getSkills()`, which is read only by the first-message
 * skills index. Everything else in the app - the Skills page, `skills.stats`,
 * and crucially the per-turn BM25 retrieval in `buildTurnSkillContext` - reads
 * `SkillLibrary`, so a user with 75 extension-contributed skills installed had
 * them advertised exactly once at session start and never surfaced or
 * auto-loaded again.
 *
 * Uses `replaceSource` rather than `registerSource` because extensions can be
 * enabled and disabled while the app runs; `ExtensionRegistry` re-resolves its
 * contributions on every such change and calls straight back in here. Safe to
 * call repeatedly and safe to call with an empty list (that is how a user
 * disabling their last skill-contributing extension is handled).
 */
export function syncExtensionSkills(skills: readonly ResolvedSkill[]): void {
  const seen = new Set<string>();
  const entries: SkillIndexEntry[] = [];
  for (const skill of skills) {
    if (!skill?.name || seen.has(skill.name)) continue;
    seen.add(skill.name);
    entries.push(toIndexEntry(skill));
  }

  try {
    SkillLibrary.getInstance().replaceSource('extension', entries);
    if (entries.length > 0) {
      console.log(`${TAG} Registered ${entries.length} extension skill(s) for retrieval.`);
    }
  } catch (error) {
    // Extension skills are additive - never let this break extension loading.
    console.warn(`${TAG} Failed to register extension skills:`, error);
  }
}
