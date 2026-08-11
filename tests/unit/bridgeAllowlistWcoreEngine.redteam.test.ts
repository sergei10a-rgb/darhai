/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import { isAllowedForRemote, _getRegisteredKeysForTests } from '@/common/adapter/bridgeAllowlist';
// Imported for its SIDE EFFECT: `buildProvider` records every declared key at
// module-load time, so the registry below is empty until this runs. The
// exhaustiveness test is the whole reason this import exists.
import '@/common/adapter/ipcBridge';

/**
 * `wcoreEngine.*` remote-caller policy.
 *
 * The deny was asserted in three doc comments (`wcoreDiagnosticsBridge.ts`,
 * `wcoreEngineBridge.ts`) and in `docs/architecture/engine-capabilities/
 * README.md`, and verified NOWHERE: deleting all three entries from
 * `bridgeAllowlist.ts` left every allowlist suite in the repo green, because no
 * test in `tests/` had ever called `isAllowedForRemote` with a `wcoreEngine`
 * key. Fifteen comparable namespaces each own a file like this one.
 *
 * What a paired WebUI client would reach without the deny is exactly what those
 * comments say it must not: `withdrawMcpServer` MUTATES a live chat by pulling
 * an MCP server's tools out of it mid-conversation;
 * `requestRuntimeDiagnostics` returns the operator's home directory inside
 * `display_path`, the config file actually in effect, every ignored environment
 * override and which MCP servers failed to launch; `capabilitySnapshot` names
 * which engine subsystems are enforced; `liveness` reports whether the local
 * user has a chat open at all and which engine build serves it.
 */
describe('isAllowedForRemote - wcoreEngine policy', () => {
  const deniedKeys: ReadonlyArray<string> = [
    'wcoreEngine.capabilitySnapshot',
    'wcoreEngine.requestRuntimeDiagnostics',
    'wcoreEngine.withdrawMcpServer',
    'wcoreEngine.liveness',
  ];

  it.each(deniedKeys)('denies subscribe-%s for remote callers', (key) => {
    expect(isAllowedForRemote(`subscribe-${key}`)).toBe(false);
  });

  /**
   * THE EXHAUSTIVENESS GUARD.
   *
   * The list above is a copy, and a copy cannot catch the failure that actually
   * happens: someone adds a fourth `wcoreEngine.*` channel and forgets the deny
   * line. So the registry itself is the source - every key `buildProvider`
   * recorded under this namespace has to be denied, whether or not anyone
   * remembered to name it here.
   */
  it('denies EVERY registered wcoreEngine channel, including ones added later', () => {
    const registered = [..._getRegisteredKeysForTests().providers].filter((key) => key.startsWith('wcoreEngine.'));
    // Guards the guard: an empty set would make the assertion below vacuous.
    expect(registered.length).toBeGreaterThanOrEqual(deniedKeys.length);
    const allowed = registered.filter((key) => isAllowedForRemote(`subscribe-${key}`));
    expect(allowed, 'every wcoreEngine channel is local-only; add it to REMOTE_DENIED_KEYS').toEqual([]);
  });

  /**
   * The counter-check. Without it this file would pass just as happily against
   * an `isAllowedForRemote` that returned false for everything, which would say
   * nothing about the deny list. `wcoreProfiles.list` is the read-only sibling
   * that deliberately stays reachable while its create/clone/activate/remove
   * neighbours are denied.
   */
  it('still allows the read-only wcoreProfiles.list for remote callers', () => {
    expect(isAllowedForRemote('subscribe-wcoreProfiles.list')).toBe(true);
  });
});
