/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { isAllowedForRemote } from '@/common/adapter/bridgeAllowlist';

/**
 * Cron. Scheduling IS delayed execution, so every mutating verb here is a
 * remote code-execution primitive wearing a scheduler's clothes.
 *
 * `cron.run-now` starts a conversation and runs the agent immediately.
 * `cron.save-skill` writes a skill file the agent then loads - code that
 * survives a restart. `add-job` / `update-job` do the same on a timer, which is
 * worse, because the payload fires when nobody is watching. `confirm-proposal`
 * accepts a job the AGENT proposed, and rubber-stamping what the model asked
 * for is the one decision that has to stay with the person at the machine.
 *
 * A paired WebUI user is deliberately less trusted than the local user - that
 * is what the whole remote denylist is for. Without these entries that user
 * could escalate straight to running code on the host.
 *
 * The read verbs stay allowed so the paired UI can still show what is
 * scheduled.
 */
describe('isAllowedForRemote - cron mutations denied for remote callers', () => {
  const DENIED = [
    'cron.add-job',
    'cron.update-job',
    'cron.remove-job',
    'cron.run-now',
    'cron.save-skill',
    'cron.confirm-proposal',
  ];

  const ALLOWED_READS = ['cron.list-jobs', 'cron.list-jobs-by-conversation', 'cron.get-job', 'cron.has-skill'];

  it.each(DENIED)('denies subscribe-%s', (key) => {
    expect(isAllowedForRemote(`subscribe-${key}`)).toBe(false);
  });

  it.each(ALLOWED_READS)('still allows the read verb subscribe-%s', (key) => {
    expect(isAllowedForRemote(`subscribe-${key}`)).toBe(true);
  });
});

describe('no future cron verb slips through', () => {
  /**
   * The denylist is a hand-maintained list against an API that grows. The
   * failure that put this file here was not a wrong entry - it was a MISSING
   * one: `isAllowedForRemote` returns true by default, so every cron verb was
   * reachable from a paired device simply because nobody had written them down.
   *
   * This test reads the verbs out of the bridge itself, so adding
   * `cron.duplicate-job` without a decision fails here instead of shipping.
   */
  const source = readFileSync(resolve(__dirname, '../../src/common/adapter/ipcBridge.ts'), 'utf8');

  /** Every `buildProvider<...>('cron.x')` key declared on the bridge. */
  const declared = [...source.matchAll(/buildProvider<[^>]*>\(\s*'(cron\.[a-z0-9-]+)'/gi)]
    .map((m) => m[1])
    // The generic can itself contain `>`; a second, looser pass catches those.
    .concat([...source.matchAll(/buildProvider<[\s\S]{0,300}?>\(\s*'(cron\.[a-z0-9-]+)'/g)].map((m) => m[1]));

  const uniqueDeclared = [...new Set(declared)];

  /**
   * Verbs that only READ. Anything not on this list must be denied for remote
   * callers - the default is deny-by-review, which is the opposite of the
   * bridge's own default and deliberately so.
   */
  const READ_ONLY = new Set([
    'cron.list-jobs',
    'cron.list-jobs-by-conversation',
    'cron.get-job',
    'cron.has-skill',
    // Events are emitters, not invocable providers, but if the regex ever
    // catches one it is a read of state the paired UI already renders.
    'cron.job-created',
    'cron.job-updated',
    'cron.job-removed',
  ]);

  it('found the cron verbs on the bridge at all', () => {
    // If this fails the regex has drifted from the source and every assertion
    // below would pass vacuously.
    expect(uniqueDeclared.length, 'no cron.* providers found in ipcBridge.ts').toBeGreaterThanOrEqual(9);
  });

  it('every declared cron verb is either a known read or denied for remote callers', () => {
    const unclassified: string[] = [];
    const wronglyDenied: string[] = [];

    for (const key of uniqueDeclared) {
      const allowed = isAllowedForRemote(`subscribe-${key}`);
      if (READ_ONLY.has(key)) {
        if (!allowed) wronglyDenied.push(key);
      } else if (allowed) {
        unclassified.push(key);
      }
    }

    expect(
      unclassified,
      `these cron verbs are reachable from a paired device and nobody classified them - ` +
        `deny them in REMOTE_DENIED_KEYS, or add them to READ_ONLY with a reason: ${unclassified.join(', ')}`
    ).toEqual([]);
    expect(wronglyDenied, `these are reads but are denied: ${wronglyDenied.join(', ')}`).toEqual([]);
  });
});
