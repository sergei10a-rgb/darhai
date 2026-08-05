/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * A refusal must not look like an approval.
 *
 * The permission card painted one green "✓ response sent successfully" banner
 * whichever option was chosen, because it only knew that a response had gone
 * out - not which one. Scrolling back through a session, denying a destructive
 * command was visually indistinguishable from allowing it.
 */

import { describe, expect, it } from 'vitest';
import type { AcpPermissionOption } from '@/common/types/acpTypes';
import { resolvePermissionOutcome } from '@/renderer/pages/conversation/Messages/acp/permissionOutcome';

const options: AcpPermissionOption[] = [
  { optionId: 'o1', name: 'Allow once', kind: 'allow_once' },
  { optionId: 'o2', name: 'Allow always', kind: 'allow_always' },
  { optionId: 'o3', name: 'Reject once', kind: 'reject_once' },
  { optionId: 'o4', name: 'Reject always', kind: 'reject_always' },
];

describe('resolvePermissionOutcome', () => {
  it('reads a refusal as denied', () => {
    expect(resolvePermissionOutcome(options, 'o3')).toBe('denied');
    expect(resolvePermissionOutcome(options, 'o4')).toBe('denied');
  });

  it('reads an approval as allowed', () => {
    expect(resolvePermissionOutcome(options, 'o1')).toBe('allowed');
    expect(resolvePermissionOutcome(options, 'o2')).toBe('allowed');
  });

  it('tells the two apart - the whole point of the fix', () => {
    expect(resolvePermissionOutcome(options, 'o1')).not.toBe(resolvePermissionOutcome(options, 'o3'));
  });

  it('falls back to allowed when nothing was selected or the option is unknown', () => {
    expect(resolvePermissionOutcome(options, null)).toBe('allowed');
    expect(resolvePermissionOutcome(options, 'missing')).toBe('allowed');
    expect(resolvePermissionOutcome(undefined, 'o3')).toBe('allowed');
  });

  it('does not infer a refusal from an unrecognised kind', () => {
    // The reject kinds are matched explicitly, so a kind added to the protocol
    // later cannot silently start reading as a refusal.
    const exotic = [{ optionId: 'x', name: 'Defer', kind: 'defer_once' }] as unknown as AcpPermissionOption[];
    expect(resolvePermissionOutcome(exotic, 'x')).toBe('allowed');
  });
});
