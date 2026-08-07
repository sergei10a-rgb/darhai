/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

import { CODEX_MODE_FULL_AUTO } from '@/common/types/codex/codexModes';

/**
 * Full-auto (YOLO) mode ID per backend.
 * Shared by renderer (cron task creation) and process (SessionLifecycle).
 */
const FULL_AUTO_MODE: Record<string, string> = {
  claude: 'bypassPermissions',
  qwen: 'yolo',
  opencode: 'build',
  gemini: 'yolo',
  wcore: 'yolo',
  codex: CODEX_MODE_FULL_AUTO,
  cursor: 'agent',
  snow: 'yolo',
};

/**
 * Get the full-auto mode value for a given backend.
 * Falls back to 'yolo' for unknown backends.
 */
export function getFullAutoMode(backend: string | undefined): string {
  if (!backend) return 'yolo';
  return FULL_AUTO_MODE[backend] || 'yolo';
}

/**
 * ACP mode id in which file edits are auto-approved while commands still
 * prompt. Matches the id the claude bridge advertises via session modes.
 */
const ACP_ACCEPT_EDITS_MODE = 'acceptEdits';

/**
 * True when an ACP permission request may be auto-approved because the user
 * chose Accept Edits mode AND the tool call is an edit. Commands ('execute')
 * and reads intentionally keep prompting - that is the mode's advertised
 * contract ("Auto-approve file edits, prompt for commands").
 */
export function shouldAutoApproveAcpEdit(mode: string | undefined, toolKind: string | undefined): boolean {
  return mode === ACP_ACCEPT_EDITS_MODE && toolKind === 'edit';
}
