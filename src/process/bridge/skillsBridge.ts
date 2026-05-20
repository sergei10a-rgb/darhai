/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

import { ipcBridge } from '@/common';
import { SkillLibrary } from '@process/services/skills/SkillLibrary';
import { SkillImport } from '@process/services/skills/SkillImport';

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

  ipcBridge.skills.import.folder.provider(async ({ srcPath }) => {
    return importer.importFolder(srcPath);
  });

  ipcBridge.skills.import.git.provider(async ({ url }) => {
    return importer.importGit(url);
  });

  ipcBridge.skills.import.zip.provider(async ({ zipPath }) => {
    return importer.importZip(zipPath);
  });

  ipcBridge.skills.import.singleSkillMd.provider(async ({ srcPath }) => {
    return importer.importSingleSkillMd(srcPath);
  });
}
