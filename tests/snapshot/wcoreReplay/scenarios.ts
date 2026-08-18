/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * The recorded sessions the keyless replay gate covers.
 *
 * Each entry names a committed JSONL of real `WCoreEvent` frames — captured
 * from the shipped engine with no API key (see the `observed/` README) or
 * shipped in the vendored contract's adversarial corpus. The gate replays each
 * through the real `WCoreAgent` decoder and byte-pins the emitted frame stream
 * against `golden/<name>.json`.
 *
 * SELECTION IS MEASURED, NOT GUESSED. Every session here was replayed twice in
 * one process and produced byte-identical output (`det=true`), which is the
 * precondition for a byte gate: a session whose decode depends on shared
 * mutable state cannot be pinned without a reset seam the production code does
 * not expose.
 *
 * EXCLUDED — `adversarial/anvil/stale-replay.jsonl`. Measured `det=false`: the
 * anvil receipt ledger is a MODULE SINGLETON (`anvilReceiptsCapability` in
 * `handlers/anvilReceipts.ts` is a top-level `const`, and `createCapabilitySet`
 * reuses that instance), and it deliberately ships no reset-for-tests back door
 * (documented in that file). So the second replay in a process sees the first
 * replay's receipts and rejects them as stale — real production behavior across
 * conversations, but not byte-stable across two isolated replays. Pinning it
 * would require adding a reset door to production code, which is out of scope
 * for this gate. This exclusion is itself a finding, recorded here so a future
 * anvil isolation seam knows a snapshot scenario is waiting for it.
 */

export type ReplayScenario = {
  /** Golden basename and test title. */
  name: string;
  /** Fixture path relative to `tests/fixtures/engine-contract/desktop/v1`. */
  fixture: string;
  /** One line on what the session exercises through the decoder. */
  covers: string;
};

export const REPLAY_SCENARIOS: readonly ReplayScenario[] = [
  {
    name: 'provider-retry-turn',
    fixture: 'observed/provider_retry_path.jsonl',
    covers: 'a full turn that retries an unreachable provider and ends in error (start/info/error/finish)',
  },
  {
    name: 'capability-activation-default',
    fixture: 'observed/capability_activation.default.jsonl',
    covers: 'engine start announcing eight capabilities under an empty config (24 activation frames)',
  },
  {
    name: 'capability-activation-smart-enabled',
    fixture: 'observed/capability_activation.smart-enabled.jsonl',
    covers: 'the same start with `[compact] smart_enabled = true`, so smart_handoff reaches ready (26 frames)',
  },
  {
    name: 'turn-recovery-replay',
    fixture: 'adversarial/recovery/valid-replay.jsonl',
    covers: 'a session recovery snapshot + replay projected into turn_recovery_lifecycle frames',
  },
];
