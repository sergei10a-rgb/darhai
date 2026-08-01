/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * The gate's only job is to be impossible to talk into a yes.
 *
 * Every test here is a way the gate could plausibly be made to approve
 * something the user never pressed: nobody is watching, nobody answered, the
 * app is closing, the delivery failed, a reply arrives for a request that
 * already settled, two dialogs are open at once. All of them must land on a
 * denial, and the denial must carry a reason a tool can report honestly.
 */

import { describe, expect, it, vi } from 'vitest';
import { ToolConfirmationService } from '@process/services/toolConfirmation/ToolConfirmationService';
import type { ToolConfirmationDeps } from '@process/services/toolConfirmation/ToolConfirmationService';
import type { ToolConfirmationRequest } from '@process/services/toolConfirmation/types';

type Harness = {
  service: ToolConfirmationService;
  seen: ToolConfirmationRequest[];
  cancelled: string[];
};

function harness(overrides: Partial<ToolConfirmationDeps> = {}): Harness {
  const seen: ToolConfirmationRequest[] = [];
  const cancelled: string[] = [];
  const service = new ToolConfirmationService({
    hasWindow: () => true,
    emitRequest: (request) => {
      seen.push(request);
    },
    emitCancel: (id) => {
      cancelled.push(id);
    },
    timeoutMs: 50,
    ...overrides,
  });
  return { service, seen, cancelled };
}

const REQUEST = {
  kind: 'email.send',
  toolName: 'email_send',
  title: 'Send this email?',
  summary: 'summary',
  confirmLabel: 'Send',
  fingerprint: 'fp-abc',
  details: [{ label: 'To', value: 'ganbat@example.mn' }],
} as const;

describe('ToolConfirmationService - refuses by default', () => {
  it('refuses when the user presses Cancel', async () => {
    const { service, seen } = harness();
    const pending = service.requestUserConfirmation(REQUEST);
    await vi.waitFor(() => expect(seen).toHaveLength(1));

    service.respond({ requestId: seen[0].requestId, approved: false });

    const outcome = await pending;
    expect(outcome.approved).toBe(false);
    if (outcome.approved === false) {
      expect(outcome.reason).toBe('declined');
      expect(outcome.message).toContain('nothing was done');
    }
  });

  it('refuses when nobody answers before the timeout, and takes the dialog down', async () => {
    const { service, cancelled, seen } = harness({ timeoutMs: 20 });
    const outcome = await service.requestUserConfirmation(REQUEST);
    expect(outcome.approved).toBe(false);
    if (outcome.approved === false) expect(outcome.reason).toBe('timeout');
    // The dialog must be dismissed too - a window left showing a question
    // nobody is listening to is how a later press finds nowhere to go.
    expect(cancelled).toEqual([seen[0].requestId]);
  });

  it('refuses when there is no window to show the dialog in', async () => {
    const { service, seen } = harness({ hasWindow: () => false });
    const outcome = await service.requestUserConfirmation(REQUEST);
    expect(outcome.approved).toBe(false);
    if (outcome.approved === false) {
      expect(outcome.reason).toBe('no-window');
      expect(outcome.message).toContain('nothing was done');
    }
    // Nothing was even offered, so nothing could have been pressed.
    expect(seen).toHaveLength(0);
  });

  it('refuses when the app is shutting down', async () => {
    const { service } = harness();
    service.shutdown();
    const outcome = await service.requestUserConfirmation(REQUEST);
    expect(outcome.approved).toBe(false);
    if (outcome.approved === false) expect(outcome.reason).toBe('shutting-down');
  });

  it('refuses everything still open when the app quits', async () => {
    const { service, seen } = harness({ timeoutMs: 60_000 });
    const pending = service.requestUserConfirmation(REQUEST);
    await vi.waitFor(() => expect(seen).toHaveLength(1));

    service.shutdown();

    const outcome = await pending;
    expect(outcome.approved).toBe(false);
    if (outcome.approved === false) expect(outcome.reason).toBe('shutting-down');
  });

  it('refuses when the dialog could not be delivered', async () => {
    const { service } = harness({
      emitRequest: () => {
        throw new Error('renderer is gone');
      },
    });
    const outcome = await service.requestUserConfirmation(REQUEST);
    expect(outcome.approved).toBe(false);
    if (outcome.approved === false) {
      expect(outcome.reason).toBe('transport-error');
      expect(outcome.message).toContain('renderer is gone');
    }
  });

  it('refuses a request with nothing to show or nothing to bind to', async () => {
    const { service } = harness();
    const noDetails = await service.requestUserConfirmation({ ...REQUEST, details: [] });
    const noFingerprint = await service.requestUserConfirmation({ ...REQUEST, fingerprint: '' });
    expect(noDetails.approved).toBe(false);
    expect(noFingerprint.approved).toBe(false);
    if (noDetails.approved === false) expect(noDetails.reason).toBe('invalid-request');
    if (noFingerprint.approved === false) expect(noFingerprint.reason).toBe('invalid-request');
  });

  it('approves only on an explicit press, and returns the fingerprint it showed', async () => {
    const { service, seen } = harness({ timeoutMs: 60_000 });
    const pending = service.requestUserConfirmation(REQUEST);
    await vi.waitFor(() => expect(seen).toHaveLength(1));

    expect(service.respond({ requestId: seen[0].requestId, approved: true })).toBe(true);

    const outcome = await pending;
    expect(outcome.approved).toBe(true);
    if (outcome.approved === true) expect(outcome.fingerprint).toBe('fp-abc');
  });
});

describe('ToolConfirmationService - a stale reply cannot approve anything', () => {
  it('ignores a reply for an id that is not pending', () => {
    const { service } = harness();
    expect(service.respond({ requestId: 'never-existed', approved: true })).toBe(false);
  });

  it('ignores a second reply to an already-settled request', async () => {
    const { service, seen } = harness({ timeoutMs: 60_000 });
    const pending = service.requestUserConfirmation(REQUEST);
    await vi.waitFor(() => expect(seen).toHaveLength(1));

    service.respond({ requestId: seen[0].requestId, approved: false });
    await expect(pending).resolves.toMatchObject({ approved: false });

    // A double-click, or a reply that raced the timeout, must change nothing.
    expect(service.respond({ requestId: seen[0].requestId, approved: true })).toBe(false);
  });

  it('cannot approve one request with the answer meant for another', async () => {
    const { service, seen } = harness({ timeoutMs: 60_000 });
    const first = service.requestUserConfirmation({ ...REQUEST, fingerprint: 'fp-first' });
    const second = service.requestUserConfirmation({ ...REQUEST, fingerprint: 'fp-second' });
    await vi.waitFor(() => expect(seen).toHaveLength(2));
    expect(seen[0].requestId).not.toBe(seen[1].requestId);

    // Answer the SECOND one only.
    service.respond({ requestId: seen[1].requestId, approved: true });
    await expect(second).resolves.toMatchObject({ approved: true, fingerprint: 'fp-second' });

    // The first is untouched, and settles as a denial on its own.
    expect(service.pendingCount).toBe(1);
    service.respond({ requestId: seen[0].requestId, approved: false });
    await expect(first).resolves.toMatchObject({ approved: false, reason: 'declined' });
  });

  it('answers a timed-out request with a denial even if the press arrives later', async () => {
    const { service, seen } = harness({ timeoutMs: 20 });
    const outcome = await service.requestUserConfirmation(REQUEST);
    expect(outcome.approved).toBe(false);
    // The user finally clicks Send, long after the gate gave up. It must not
    // resurrect anything.
    expect(service.respond({ requestId: seen[0].requestId, approved: true })).toBe(false);
  });
});

describe('ToolConfirmationService - there is no self-approval path', () => {
  it('has no way to reach approval except respond()', async () => {
    // Exhaustive over the public surface: call everything that is NOT
    // `respond`, then prove the request is still unanswered. If a future edit
    // adds an "approveAll" / "setAutoApprove" / options bag that approves, this
    // enumeration will include it and the pending count will drop.
    const { service, seen } = harness({ timeoutMs: 60_000 });
    void service.requestUserConfirmation(REQUEST);
    await vi.waitFor(() => expect(seen).toHaveLength(1));

    const surface = Object.getOwnPropertyNames(Object.getPrototypeOf(service)).filter(
      (name) => name !== 'constructor' && name !== 'respond' && name !== 'shutdown' && name !== 'denyAllPending'
    );
    for (const name of surface) {
      const member = (service as unknown as Record<string, unknown>)[name];
      if (typeof member !== 'function') continue;
      try {
        const returned = (member as (...args: unknown[]) => unknown).call(service);
        // A method that returns a rejected promise did not approve anything
        // either; swallow it so it cannot surface as an unhandled rejection.
        if (returned instanceof Promise) returned.catch((): void => undefined);
      } catch {
        // Same for a synchronous throw on an empty argument list.
      }
    }
    expect(service.pendingCount).toBe(1);
  });

  it('treats a non-boolean approval as a refusal', async () => {
    const { service, seen } = harness({ timeoutMs: 60_000 });
    const pending = service.requestUserConfirmation(REQUEST);
    await vi.waitFor(() => expect(seen).toHaveLength(1));

    // The bridge coerces with `approved === true`; this pins the service side
    // too, so a damaged caller sending "yes" or 1 cannot squeeze through.
    service.respond({ requestId: seen[0].requestId, approved: 'yes' as unknown as boolean });
    await expect(pending).resolves.toMatchObject({ approved: false, reason: 'declined' });
  });
});
