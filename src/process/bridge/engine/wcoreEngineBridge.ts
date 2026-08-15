/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * IPC bridge for read-only engine introspection (`ipcBridge.wcoreEngine`).
 *
 * WHY THIS EXISTS. Two renderer surfaces need to know what the engine can do:
 * Settings → Darhai Core shows per-capability readiness, and Mission Control
 * decides whether durable goals are available at all. Both were built against
 * the live `capability_activation` stream, and both were therefore permanently
 * empty in the shipped app - those frames are emitted once per engine process
 * START, which by definition happens while the user is in a chat and the
 * Settings pane is unmounted.
 *
 * The main process already retains both answers. This bridge hands them over
 * on demand so a pane can be correct the moment it mounts, no matter what
 * happened before.
 *
 * SECURITY - HUMAN/RENDERER ONLY. Remote-denied in `bridgeAllowlist.ts`: the
 * snapshot states which engine subsystems are enforced (delegate isolation,
 * learned policy) and which contract verbs are available, which is a map of
 * what a paired remote client could still get away with. Read-only: nothing
 * here mutates engine state.
 */

import { readEngineContract } from '@process/agent/wcore/capabilities/engineContractStore';
import { readCapabilityActivationSnapshot } from '@process/agent/wcore/capabilities/handlers/capabilityActivation';
import { ipcBridge } from '@/common';
import type { IWcoreCapabilitySnapshot } from '@/common/adapter/ipcBridge';

/**
 * Build the snapshot from the two retained records.
 *
 * Exported so tests exercise the real assembly rather than a copy of its
 * rules - the shape is the contract between main and renderer, and a copy
 * would keep passing after the real one changed.
 */
export function buildWcoreCapabilitySnapshot(): IWcoreCapabilitySnapshot {
  const activation = readCapabilityActivationSnapshot();
  const { contract, known } = readEngineContract();

  const grades: Record<string, string> = {};
  for (const [capability, grade] of contract.grades) {
    grades[capability] = grade;
  }

  return {
    // Copied out of the readonly record: the renderer receives a structured
    // clone anyway, and handing over the live array would let a future caller
    // believe it can mutate the main-process record.
    activation: activation.rows.map((row) => ({
      capability: row.capability,
      stage: row.stage,
      reason: row.reason,
      health: row.health,
      remedy: row.remedy,
      frames: row.frames,
    })),
    overflowed: activation.overflowed,
    grades,
    contractKnown: known,
    engineVersion: contract.engineVersion,
  };
}

export function initWcoreEngineBridge(): void {
  ipcBridge.wcoreEngine.capabilitySnapshot.provider(async () => buildWcoreCapabilitySnapshot());
}
