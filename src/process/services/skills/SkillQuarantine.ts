/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

import { stat, mkdir, rename } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';

export type SkillQuarantineIo = {
  exists: (p: string) => Promise<boolean>;
  mkdir: (p: string) => Promise<void>;
  move: (from: string, to: string) => Promise<void>;
};

export const QUARANTINE_DIR = path.join(homedir(), '.wayland', 'skills', '.quarantine');

export const defaultSkillQuarantineIo: SkillQuarantineIo = {
  exists: async (p) => {
    try {
      await stat(p);
      return true;
    } catch {
      return false;
    }
  },
  mkdir: async (p) => {
    await mkdir(p, { recursive: true });
  },
  move: async (from, to) => {
    await rename(from, to);
  },
};

export class SkillQuarantine {
  static async quarantine(
    skillName: string,
    fromPath: string,
    io: SkillQuarantineIo = defaultSkillQuarantineIo,
  ): Promise<string> {
    const dest = path.join(QUARANTINE_DIR, skillName);
    await io.mkdir(path.dirname(dest));
    await io.move(fromPath, dest);
    return dest;
  }

  static async isQuarantined(
    skillName: string,
    io: SkillQuarantineIo = defaultSkillQuarantineIo,
  ): Promise<boolean> {
    return io.exists(path.join(QUARANTINE_DIR, skillName));
  }
}
