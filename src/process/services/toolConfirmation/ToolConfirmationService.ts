/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * The main-process half of the MCP tool-confirmation gate.
 *
 * One method matters: {@link ToolConfirmationService.requestUserConfirmation}.
 * It pushes a request to the renderer, waits for a human press, and resolves an
 * outcome. Everything else in this file exists to make the FAILURE paths land
 * on a denial, because the only property worth having here is that no code path
 * can produce `approved: true` without a person having pressed the button.
 *
 * The deny-by-construction inventory
 * ----------------------------------
 *  - no window to show a dialog in           -> `no-window`
 *  - the app is quitting                     -> `shutting-down`
 *  - the emit to the renderer throws         -> `transport-error`
 *  - nobody answers within the timeout       -> `timeout`
 *  - the user presses Cancel / closes it     -> `declined`
 *  - a reply arrives for an unknown id       -> ignored entirely
 *  - a reply arrives twice                   -> the second is ignored
 *
 * The last two are what makes concurrency safe. Pending requests live in a Map
 * keyed by a freshly minted `requestId`, `settle()` deletes the entry before it
 * resolves, and `respond()` is a no-op for an id that is not pending. So a
 * stale reply - a renderer reload, a double click, a dialog answered after its
 * own timeout - cannot approve a different request, and two dialogs open at
 * once cannot cross-talk.
 *
 * Deliberately absent: any "approve all", "remember this", "don't ask again",
 * scope, allowlist, or batch. One human press buys exactly one action. There is
 * also no argument, option or environment variable anywhere in this class that
 * skips the dialog - `requestUserConfirmation` has exactly one way to reach
 * `approved: true`, and it runs through {@link ToolConfirmationService.respond}.
 */

import { randomUUID } from 'node:crypto';
import {
  denied,
  TOOL_CONFIRM_TIMEOUT_MS,
  type ToolConfirmationDenyReason,
  type ToolConfirmationOutcome,
  type ToolConfirmationRequest,
  type ToolConfirmationRequestInput,
  type ToolConfirmationResponse,
} from './types';

/**
 * Everything this service touches outside itself, injected.
 *
 * Same seam as `LoopbackSocketFactory` in `loopbackConnect.ts`: the production
 * wiring reaches Electron and the IPC bridge, and a test can drive a REAL
 * decision path (approve / cancel / timeout / no window) without either.
 */
export type ToolConfirmationDeps = {
  /** True when a renderer window exists that could show the dialog. */
  hasWindow: () => boolean;
  /** Push the request to the renderer. May throw; a throw is a denial. */
  emitRequest: (request: ToolConfirmationRequest) => void;
  /** Tell the renderer to take the dialog down (timeout / shutdown). */
  emitCancel: (requestId: string) => void;
  /** Per-request wait budget. */
  timeoutMs?: number;
};

type PendingEntry = {
  request: ToolConfirmationRequest;
  settle: (outcome: ToolConfirmationOutcome) => void;
  timer: ReturnType<typeof setTimeout>;
};

export class ToolConfirmationService {
  private readonly pending = new Map<string, PendingEntry>();
  private readonly deps: ToolConfirmationDeps;
  private readonly timeoutMs: number;
  private shuttingDown = false;

  constructor(deps: ToolConfirmationDeps) {
    this.deps = deps;
    this.timeoutMs = deps.timeoutMs ?? TOOL_CONFIRM_TIMEOUT_MS;
  }

  /** Number of dialogs currently waiting on a human. */
  get pendingCount(): number {
    return this.pending.size;
  }

  /** Snapshot of open requests, so a reloading renderer can re-render them. */
  listPending(): ToolConfirmationRequest[] {
    return [...this.pending.values()].map((entry) => entry.request);
  }

  /**
   * Ask the human. Resolves approved ONLY after a press on the confirm button.
   *
   * Never rejects: a caller must not be able to turn a thrown error into an
   * `catch {}` that then proceeds. Every failure is a resolved denial.
   */
  async requestUserConfirmation(input: ToolConfirmationRequestInput): Promise<ToolConfirmationOutcome> {
    const requestId = randomUUID();

    const invalid = validate(input);
    if (invalid) return denied(requestId, 'invalid-request', invalid);

    if (this.shuttingDown) {
      return denied(requestId, 'shutting-down', 'Дархай is closing, so nothing was confirmed and nothing was done.');
    }

    // A dialog nobody can see is not consent. Refusing here is what makes
    // "headless / background / window closed" a denial rather than a hang.
    if (!this.deps.hasWindow()) {
      return denied(
        requestId,
        'no-window',
        'No Дархай window is open, so the confirmation could not be shown and nothing was done.'
      );
    }

    const request: ToolConfirmationRequest = { ...input, details: [...input.details], requestId };

    return new Promise<ToolConfirmationOutcome>((resolve) => {
      const timer = setTimeout(() => {
        this.deps.emitCancel(requestId);
        this.settle(
          requestId,
          denied(requestId, 'timeout', 'The confirmation was not answered in time, so nothing was done.')
        );
      }, this.timeoutMs);
      // A pending confirmation must never hold the process open by itself.
      timer.unref?.();

      this.pending.set(requestId, { request, settle: resolve, timer });

      try {
        this.deps.emitRequest(request);
      } catch (error) {
        this.settle(
          requestId,
          denied(
            requestId,
            'transport-error',
            `The confirmation dialog could not be delivered (${
              error instanceof Error ? error.message : String(error)
            }), so nothing was done.`
          )
        );
      }
    });
  }

  /**
   * The renderer's answer.
   *
   * Returns true when it settled a live request. An unknown or already-settled
   * `requestId` returns false and changes nothing - that is the stale-reply
   * defence, and it is the reason approval cannot be replayed onto a different
   * request.
   */
  respond(response: ToolConfirmationResponse): boolean {
    const entry = this.pending.get(response.requestId);
    if (!entry) return false;

    if (response.approved === true) {
      return this.settle(response.requestId, {
        approved: true,
        requestId: response.requestId,
        fingerprint: entry.request.fingerprint,
      });
    }
    return this.settle(
      response.requestId,
      denied(response.requestId, 'declined', 'The user pressed Cancel, so nothing was done.')
    );
  }

  /**
   * Deny everything still open and refuse anything new.
   *
   * Called on app quit and on the last window closing. Without it a tool would
   * sit on a promise that can no longer be answered, and - far worse - a
   * confirmation raised before quit could be answered by a window that comes
   * back later, long after the user's attention moved on.
   */
  shutdown(message = 'Дархай closed before the confirmation was answered, so nothing was done.'): void {
    this.shuttingDown = true;
    this.denyAllPending('shutting-down', message);
  }

  /**
   * Deny every open dialog without closing the gate for good.
   *
   * Used when the last window disappears: the dialog went with it, so nobody
   * can press anything, and a tool blocked on it must be told "nothing was
   * done" now rather than when the timeout eventually fires.
   */
  denyAllPending(reason: ToolConfirmationDenyReason, message: string): number {
    const ids = [...this.pending.keys()];
    for (const requestId of ids) {
      this.deps.emitCancel(requestId);
      this.settle(requestId, denied(requestId, reason, message));
    }
    return ids.length;
  }

  /** Re-open for business (test teardown / a new window after a close). */
  resume(): void {
    this.shuttingDown = false;
  }

  /** Delete-then-resolve, so a request can settle exactly once. */
  private settle(requestId: string, outcome: ToolConfirmationOutcome): boolean {
    const entry = this.pending.get(requestId);
    if (!entry) return false;
    this.pending.delete(requestId);
    clearTimeout(entry.timer);
    entry.settle(outcome);
    return true;
  }
}

/**
 * Reject a request that could not be shown honestly.
 *
 * A dialog with no fingerprint could be spent on any payload, and a dialog with
 * no details would ask the user to approve something they cannot see. Both are
 * worse than refusing.
 */
function validate(input: ToolConfirmationRequestInput): string | null {
  // Null-safe on purpose. A malformed caller must get a DENIAL, not a thrown
  // TypeError that some outer `catch` could turn into "well, carry on".
  if (!input || typeof input !== 'object') {
    return 'The confirmation request was empty, so nothing was done.';
  }
  if (typeof input.fingerprint !== 'string' || input.fingerprint.length === 0) {
    return 'The confirmation carried no payload fingerprint, so it could not be bound to an action.';
  }
  if (!Array.isArray(input.details) || input.details.length === 0) {
    return 'The confirmation carried nothing to show the user, so it was refused.';
  }
  if (typeof input.toolName !== 'string' || input.toolName.length === 0) {
    return 'The confirmation named no tool, so it was refused.';
  }
  return null;
}
