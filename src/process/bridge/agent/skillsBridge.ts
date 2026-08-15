/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

import path from 'node:path';
import { homedir } from 'node:os';
import { mkdir, writeFile } from 'node:fs/promises';
import { ipcBridge } from '@/common';
import { SkillGuard } from '@process/services/skills/SkillGuard';
import { SkillLibrary } from '@process/services/skills/SkillLibrary';
import { SkillImport } from '@process/services/skills/SkillImport';
import { SkillQuarantine } from '@process/services/skills/SkillQuarantine';
import { SkillRetriever } from '@process/services/skills/SkillRetriever';
import { ProcessConfig } from '@process/utils/initStorage';
import { loadTeamSkills } from '@process/extensions/data/bundle-vendored/teamSkillMerge';
import { loadCliSkills } from '@process/services/skills/CliSkillDiscovery';
import { getDatabase } from '@process/services/database';
import { oneShotComplete, pickBestModel } from '@process/services/completion/oneShot';

/**
 * Prompt for the "Describe it" tab of the skill builder.
 *
 * The structure mirrors what `SkillGuard` and the retrieval layer expect from a
 * SKILL.md: a title, a one-line summary, explicit use / do-not-use guidance
 * (which is what makes the model activate the skill accurately) and concrete
 * instructions. Language is mirrored back to the user deliberately - this is a
 * Mongolian-first product and a Mongolian description must not come back in
 * English.
 */
function buildSkillDraftPrompt(description: string): string {
  return [
    'You are writing a SKILL.md file for an AI coding agent.',
    'Return ONLY the markdown document - no commentary, no code fences around it.',
    '',
    'Required structure:',
    '# <kebab-case-skill-name>',
    '',
    '> <one-sentence summary>',
    '',
    '## Use when',
    '- <concrete trigger>',
    '',
    '## Do NOT use when',
    '- <concrete non-trigger>',
    '',
    '## Instructions',
    '<numbered, actionable steps the agent should follow>',
    '',
    'Write the document in the SAME LANGUAGE as the description below.',
    'Be specific and actionable; do not leave placeholders such as "(fill in)".',
    '',
    'Description of the skill to write:',
    description,
  ].join('\n');
}

/** Strip wrapping ``` fences a chatty model may add around the document. */
function stripCodeFence(raw: string): string {
  return raw
    .replace(/^```(?:markdown|md)?\s*\n?/i, '')
    .replace(/\n?```\s*$/i, '')
    .trim();
}

export function initSkillsBridge(): void {
  // Register the waylandteams bundle's 88 curated skills as the second
  // source on the Skills page (alongside the 1,965 vendored library
  // skills). Runs once per process, fail-soft when the bundle isn't on
  // disk (e.g. packaged build with no team install).
  loadTeamSkills();
  // Opt-in CLI skill discovery (~/.claude/skills, ~/.codex/skills,
  // ~/.gemini/skills). Default off - gated on the
  // `skills.cliDiscovery.enabled` config flag. Async-fire-and-forget
  // because each root requires fs I/O; we don't block boot waiting.
  void loadCliSkills();
  ipcBridge.skills.scan.provider(async ({ name }) => {
    const lib = SkillLibrary.getInstance();
    return (await lib.rescanIfStale(name)) ?? null;
  });

  ipcBridge.skills.getReport.provider(async ({ name }) => {
    const lib = SkillLibrary.getInstance();
    const entry = await lib.get(name);
    return entry?.security ?? null;
  });

  ipcBridge.skills.rescanAll.provider(async () => {
    const lib = SkillLibrary.getInstance();
    const { SKILL_SCANNER_VERSION } = await import('@/common/types/skillTypes');
    const all = await lib.list();
    let rescanned = 0;
    for (const e of all) {
      const sv = e.security?.scannerVersion ?? 0;
      if (sv < SKILL_SCANNER_VERSION) {
        await lib.rescanIfStale(e.name);
        rescanned += 1;
      }
    }
    return { rescanned };
  });

  const importer = new SkillImport();

  ipcBridge.skills.import.folder.provider(async ({ srcPath }) => importer.importFolder(srcPath));
  ipcBridge.skills.import.git.provider(async ({ url }) => importer.importGit(url));
  ipcBridge.skills.import.zip.provider(async ({ zipPath }) => importer.importZip(zipPath));
  ipcBridge.skills.import.singleSkillMd.provider(async ({ srcPath }) => importer.importSingleSkillMd(srcPath));

  ipcBridge.skills.list.provider(async (req) => {
    // Default to `type: 'skill'` so the existing Skills page (which invokes
    // with no args) sees only the 1,965 + 88 + N skills. Workflows page
    // calls with `{ type: 'workflow' }`; agent-profiles never surface
    // via this IPC (they're merged into Workspace > Assistants).
    const lib = SkillLibrary.getInstance();
    return lib.list({ type: req?.type ?? 'skill' });
  });

  ipcBridge.skills.stats.provider(async () => {
    // Stats must mirror the list filter so the four health cards count the
    // same set the user is browsing. Otherwise the page shows e.g.
    // "2,105 skills" while the row list has 1,973.
    const lib = SkillLibrary.getInstance();
    return lib.stats({ type: 'skill' });
  });

  // CLI skill discovery flag (default off; restart required to take effect).
  ipcBridge.skills.getCliDiscoveryEnabled.provider(async () => {
    return (await ProcessConfig.get('skills.cliDiscovery.enabled')) ?? false;
  });
  ipcBridge.skills.setCliDiscoveryEnabled.provider(async ({ enabled }) => {
    await ProcessConfig.set('skills.cliDiscovery.enabled', enabled);
  });

  ipcBridge.skills.getBody.provider(async ({ name }) => {
    return SkillLibrary.getInstance().loadBody(name);
  });

  /**
   * Rank the library for the `/skill` autocomplete.
   *
   * Uses the same BM25 retriever the agent does, so what the user is offered
   * when they type is what the model would have found on its own - one library,
   * one ranking, whichever way you reach it.
   *
   * Prefix-matched names are hoisted above BM25 hits: someone typing `/skill
   * kube` is naming a skill, not describing a task, and expects the name they
   * are spelling to be first.
   */
  ipcBridge.skills.search.provider(async ({ query, limit }) => {
    const capped = Math.min(Math.max(1, limit ?? 10), 25);
    const trimmed = (query ?? '').trim();
    const lib = SkillLibrary.getInstance();
    const entries = await lib.list({ type: 'skill' });

    if (!trimmed) {
      return entries.slice(0, capped).map((e) => ({ name: e.name, description: e.description ?? '' }));
    }

    const lower = trimmed.toLowerCase();
    const byPrefix = entries.filter((e) => e.name.toLowerCase().startsWith(lower));

    SkillRetriever.resetInstance();
    const ranked = SkillRetriever.getInstance({ entries }).retrieve(trimmed, capped);

    const seen = new Set<string>();
    const out: Array<{ name: string; description: string }> = [];
    for (const e of [...byPrefix, ...ranked]) {
      if (seen.has(e.name)) continue;
      seen.add(e.name);
      out.push({ name: e.name, description: e.description ?? '' });
      if (out.length >= capped) break;
    }
    return out;
  });

  ipcBridge.skills.updateBody.provider(async ({ name, body }) => {
    const lib = SkillLibrary.getInstance();
    const entry = await lib.get(name);
    if (!entry) {
      return { ok: false, error: 'not-found' };
    }
    // Only user-authored / imported skills live in a writable path. Bundled
    // library, team, and cli-discovered skills are read-only.
    if (entry.source !== 'user' && entry.source !== 'imported') {
      return { ok: false, error: 'read-only' };
    }
    if (!entry.path || !path.isAbsolute(entry.path)) {
      return { ok: false, error: 'no-writable-path' };
    }
    // Re-scan before writing - never persist a body that fails the guard.
    const [report] = await SkillGuard.scan(
      [{ name: entry.name, body, description: entry.description ?? '', tags: entry.metadata.tags ?? [] }],
      { llm: true }
    );
    if (report.verdict === 'blocked') {
      return { ok: false, error: 'blocked' };
    }
    await writeFile(entry.path, body, 'utf-8');
    lib.registerSource([{ ...entry, security: report }]);
    return { ok: true, verdict: report.verdict };
  });

  ipcBridge.skills.setPinned.provider(async ({ name, pinned }) => {
    const prefs = (await ProcessConfig.get('skills.preferences')) ?? { pinned: [], disabled: [], revision: 0 };
    const current = prefs.pinned ?? [];
    const next = pinned ? [...new Set([...current, name])] : current.filter((n) => n !== name);
    await ProcessConfig.set('skills.preferences', {
      pinned: next,
      disabled: prefs.disabled ?? [],
      revision: (prefs.revision ?? 0) + 1,
    });
  });

  ipcBridge.skills.addToConversation.provider(async ({ conversationId, name }) => {
    const lib = SkillLibrary.getInstance();
    const entry = await lib.get(name);
    if (!entry) return { ok: false, error: 'not-found' };
    if (entry.security?.verdict === 'blocked') return { ok: false, error: 'blocked' };
    try {
      const db = await getDatabase();
      const res = db.getConversation(conversationId);
      if (!res.success || !res.data) return { ok: false, error: 'conversation-not-found' };
      const conversation = res.data;
      const extra = (conversation.extra ?? {}) as {
        sessionSkills?: string[];
        loadedSkills?: Array<{ name: string; description: string }>;
      };
      const sessionSkills = new Set(extra.sessionSkills ?? []);
      sessionSkills.add(name);
      const loaded = extra.loadedSkills ?? [];
      const updatedExtra = {
        ...conversation.extra,
        sessionSkills: Array.from(sessionSkills),
        loadedSkills: loaded.some((s) => s.name === name)
          ? loaded
          : [...loaded, { name, description: entry.description ?? '' }],
      };
      db.updateConversation(conversationId, { extra: updatedExtra } as Partial<typeof conversation>);
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : 'failed' };
    }
  });

  // ---------------------------------------------------------------------------
  // Skill builder
  // ---------------------------------------------------------------------------

  ipcBridge.skills.build.draft.provider(async ({ description }) => {
    // Rarely run and high-stakes (the output becomes a skill the agent follows),
    // so use the best model the user has rather than the cheap one - same choice
    // the project-knowledge wizard makes.
    try {
      const model = await pickBestModel();
      if (!model) return { skillMd: '', error: 'no-model' as const };
      const raw = await oneShotComplete(buildSkillDraftPrompt(description), {
        model,
        maxTokens: 1200,
        timeoutMs: 90_000,
      });
      const skillMd = stripCodeFence(raw);
      if (!skillMd) return { skillMd: '', error: 'failed' as const };
      return { skillMd };
    } catch (err) {
      console.error('[skillsBridge] build.draft failed:', err);
      const msg = err instanceof Error ? err.message : '';
      return { skillMd: '', error: msg === 'no-usable-model' ? ('no-model' as const) : ('failed' as const) };
    }
  });

  ipcBridge.skills.save.provider(async ({ name, description, category, tags, body }) => {
    const kebab = name
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '');

    // C3: scan BEFORE writing. The previous flow wrote the body to
    // ~/.darhai/skills/<name>/SKILL.md, scanned it, and only skipped the
    // SkillLibrary registration when blocked - leaving the body permanently
    // on the user's filesystem. Now the body never lands in the live skills
    // tree until the verdict is known. Blocked content goes straight to
    // ~/.darhai/skills/.quarantine/<name>/SKILL.md instead.
    const [report] = await SkillGuard.scan([{ name: kebab, body, description, tags }], { llm: true });

    if (report.verdict === 'blocked') {
      const quarantinedAt = await SkillQuarantine.quarantineFromMemory({ name: kebab, body });
      return { name: kebab, verdict: report.verdict, quarantinedAt };
    }

    const destDir = path.join(homedir(), '.darhai', 'skills', kebab);
    await mkdir(destDir, { recursive: true });
    const destFile = path.join(destDir, 'SKILL.md');
    await writeFile(destFile, body, 'utf-8');

    SkillLibrary.getInstance().registerSource([
      {
        name: kebab,
        description,
        type: 'skill',
        source: 'user',
        metadata: { tags, category: category || undefined },
        path: destFile,
        security: report,
      },
    ]);

    return { name: kebab, verdict: report.verdict };
  });
}
