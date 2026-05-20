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
import { ProcessConfig } from '@process/utils/initStorage';

export function initSkillsBridge(): void {
  ipcBridge.skills.scan.provider(async ({ name }) => {
    const lib = SkillLibrary.getInstance();
    return lib.rescanIfStale(name) ?? null;
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

  ipcBridge.skills.list.provider(async () => {
    const lib = SkillLibrary.getInstance();
    return lib.list();
  });

  ipcBridge.skills.stats.provider(async () => {
    const lib = SkillLibrary.getInstance();
    return lib.stats();
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

  // ---------------------------------------------------------------------------
  // Skill builder
  // ---------------------------------------------------------------------------

  ipcBridge.skills.build.draft.provider(async ({ description }) => {
    // TODO: replace with a real model call to generate a SKILL.md from the description.
    // The stub returns a minimal valid template so the UI can bootstrap the Write tab.
    const skillMd = [
      '# new-skill',
      '',
      `> ${description}`,
      '',
      '## Use when',
      '',
      '- (fill in)',
      '',
      '## Do NOT use when',
      '',
      '- (fill in)',
      '',
      '## Instructions',
      '',
      description,
    ].join('\n');
    return { skillMd };
  });

  ipcBridge.skills.save.provider(async ({ name, description, category, tags, body }) => {
    const kebab = name
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '');

    const destDir = path.join(homedir(), '.wayland', 'skills', kebab);
    await mkdir(destDir, { recursive: true });
    const destFile = path.join(destDir, 'SKILL.md');
    await writeFile(destFile, body, 'utf-8');

    const [report] = await SkillGuard.scan([{ name: kebab, body, description, tags }]);

    if (report.verdict !== 'blocked') {
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
    }

    return { name: kebab, verdict: report.verdict };
  });
}
