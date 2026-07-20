/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Ingress-gating tests for the email-imap plugin - the DRAFT-ONLY safety seam.
 *
 * When triage is ENABLED, an inbound email is triaged and `emitMessage` is NEVER
 * called: the email never becomes an agent turn, so it can never trigger an SMTP
 * auto-reply. When triage is DISABLED, the legacy path is unchanged and
 * `emitMessage` IS called. We drive the private `handleInbound` directly (no
 * worker fork) and mock the triage singleton so no DB / LLM is touched.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const { triageInbound } = vi.hoisted(() => ({ triageInbound: vi.fn() }));

vi.mock('@process/services/emailTriage/emailTriageServiceSingleton', () => ({
  emailTriageService: { triageInbound },
  emailTriageRepository: { getByMessageId: vi.fn(), upsert: vi.fn(), listByPlugin: vi.fn() },
}));

import { EmailImapPlugin } from '@process/channels/plugins/tier1/email-imap/EmailImapPlugin';
import type { IUnifiedIncomingMessage } from '@process/channels/types';

function makeMessage(): IUnifiedIncomingMessage {
  return {
    id: '<m1@x>',
    platform: 'email-imap',
    chatId: 'sender@ext.com',
    user: { id: 'sender@ext.com', displayName: 'Sender' },
    content: { type: 'text', text: 'hello' },
    timestamp: 1,
    email: { from: 'sender@ext.com', to: 'me@co.com', subject: 'Hi', messageId: '<m1@x>' },
  } as IUnifiedIncomingMessage;
}

/** Seed the protected config/creds the ingress path reads (runtime access). */
function seed(plugin: EmailImapPlugin, triageConfig: Record<string, unknown>): void {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (plugin as any).config = { id: 'email-imap_default', config: triageConfig };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (plugin as any).creds = { imap: { user: 'me@co.com' } };
}

describe('EmailImapPlugin ingress triage gating', () => {
  beforeEach(() => {
    triageInbound.mockReset();
    triageInbound.mockResolvedValue(null);
  });

  it('triage ON: triages the email and does NOT call emitMessage (draft-only seam)', async () => {
    const plugin = new EmailImapPlugin();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const emitSpy = vi.spyOn(plugin as any, 'emitMessage').mockResolvedValue(undefined);
    seed(plugin, { triageEnabled: true, triageSummary: true });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (plugin as any).handleInbound(makeMessage());

    expect(triageInbound).toHaveBeenCalledTimes(1);
    expect(emitSpy).not.toHaveBeenCalled();
  });

  it('triage OFF: does NOT triage and DOES call emitMessage (legacy path unchanged)', async () => {
    const plugin = new EmailImapPlugin();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const emitSpy = vi.spyOn(plugin as any, 'emitMessage').mockResolvedValue(undefined);
    seed(plugin, {});

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (plugin as any).handleInbound(makeMessage());

    expect(triageInbound).not.toHaveBeenCalled();
    expect(emitSpy).toHaveBeenCalledTimes(1);
    expect(emitSpy).toHaveBeenCalledWith(makeMessage());
  });

  it('triage ON still tracks the sender in the active-user set', async () => {
    const plugin = new EmailImapPlugin();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    vi.spyOn(plugin as any, 'emitMessage').mockResolvedValue(undefined);
    seed(plugin, { triageEnabled: true });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (plugin as any).handleInbound(makeMessage());
    expect(plugin.getActiveUserCount()).toBe(1);
  });
});
