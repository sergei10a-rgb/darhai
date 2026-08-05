/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * What the user actually decided on a permission prompt.
 *
 * The confirmation card used to paint the same green "✓ sent successfully"
 * banner however the prompt was answered, because it only knew that A response
 * had been sent - not which one. Approving a command and refusing it looked
 * identical afterwards, so a user scrolling back through a session could not
 * tell whether the agent had been allowed to run something destructive.
 */

import type { AcpPermissionOption } from '@/common/types/acpTypes';

export type PermissionOutcome = 'allowed' | 'denied';

/**
 * Which way a permission prompt was answered, from the option the user picked.
 *
 * Defaults to `allowed` only when the option cannot be found at all - the two
 * `reject_*` kinds are matched explicitly rather than inferred, so an option
 * kind added later cannot silently start reading as a refusal.
 */
export function resolvePermissionOutcome(
  options: readonly AcpPermissionOption[] | undefined,
  selectedOptionId: string | null | undefined
): PermissionOutcome {
  if (!selectedOptionId) return 'allowed';
  const chosen = options?.find((option) => option?.optionId === selectedOptionId);
  if (!chosen) return 'allowed';
  return chosen.kind === 'reject_once' || chosen.kind === 'reject_always' ? 'denied' : 'allowed';
}
