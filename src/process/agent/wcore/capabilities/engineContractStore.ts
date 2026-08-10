/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * The last `ready` contract, readable outside the agent that received it.
 *
 * WHY THIS EXISTS. `WCoreAgent` negotiates the contract on `ready` and keeps it
 * on the instance, which is the right place for the gates that live in the same
 * process as the engine. The RENDERER needs the same answer - Settings shows
 * engine readiness, Mission Control decides whether durable goals are available
 * at all - and it has no route to an agent instance.
 *
 * The previous attempt read availability off `capability_activation` frames.
 * That is the wrong source and was MEASURED to be: the observed captures
 * (tests/fixtures/engine-contract/desktop/v1/observed/capability_activation.*)
 * name eight ENGINE-INTERNAL ids (cooldown_tracker, delegate_isolation, ...),
 * and not one of them appears in the contract's `capabilities` map, where ids
 * like `durable_goals_v1` live. The two namespaces do not intersect, so a
 * renderer filtering activation frames for a contract id waits forever.
 *
 * WHY A MODULE SINGLETON. One engine child exists per conversation, and the
 * contract is a property of the ENGINE BINARY, not of the conversation - every
 * child of one app run is the same pinned build answering the same way. Keeping
 * the newest is therefore not a blend of disagreeing sources; it is the same
 * answer, refreshed. `recordEngineContract` is called from the `ready` arm, so
 * a respawn overwrites rather than accumulates.
 */

import type { NegotiatedContract } from './contractNegotiation';
import { NO_CONTRACT } from './contractNegotiation';

let latest: NegotiatedContract = NO_CONTRACT;
let known = false;

/** What a reader outside the agent gets. `known` is the honest-unknown flag. */
export type EngineContractSnapshot = {
  /** The contract as negotiated. `NO_CONTRACT` until an engine says otherwise. */
  contract: NegotiatedContract;
  /**
   * False until some engine in this app run published a `ready`.
   *
   * Load-bearing: `NO_CONTRACT` grades everything `unavailable`, which is the
   * safe default for a GATE but a lie for a READOUT. A surface that cannot tell
   * "the engine said no" from "no engine has spoken yet" reports a healthy
   * capability as broken before the first chat is opened.
   */
  known: boolean;
};

/** Record the contract from a `ready`. Called from `wcore/index.ts`'s ready arm. */
export function recordEngineContract(contract: NegotiatedContract): void {
  latest = contract;
  known = true;
}

/** The last recorded contract, plus whether anything was ever recorded. */
export function readEngineContract(): EngineContractSnapshot {
  return { contract: latest, known };
}

/**
 * Forget the recorded contract.
 *
 * For tests only - production never un-learns a contract, because the binary
 * does not change under a running app.
 */
export function resetEngineContract(): void {
  latest = NO_CONTRACT;
  known = false;
}
