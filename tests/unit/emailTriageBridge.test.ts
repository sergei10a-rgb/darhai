/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Tests for the email-triage bridge, focused on the single send seam: `sendDraft`
 * must route a reviewed draft through the EXISTING EmailImapPlugin.sendMessage
 * SMTP path, and it must do so ONLY when explicitly invoked (never during the
 * read verbs). We capture the registered providers by mocking ipcBridge, and
 * stub the plugin manager + repository.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { EmailTriageEntry, SendDraftParams } from '@/common/types/emailTriage';

const { providers, sendMessage, getPlugin, getAllPlugins, repoGet } = vi.hoisted(() => ({
  providers: {} as Record<string, (params: unknown) => Promise<unknown>>,
  sendMessage: vi.fn(async () => '<sent@x>'),
  getPlugin: vi.fn(() => undefined as unknown),
  getAllPlugins: vi.fn(() => [] as unknown[]),
  repoGet: vi.fn(),
}));

vi.mock('@/common', () => ({
  ipcBridge: {
    emailTriage: {
      list: { provider: (fn: (p: unknown) => Promise<unknown>) => (providers.list = fn) },
      get: { provider: (fn: (p: unknown) => Promise<unknown>) => (providers.get = fn) },
      sendDraft: { provider: (fn: (p: unknown) => Promise<unknown>) => (providers.sendDraft = fn) },
      onUpdated: { emit: vi.fn() },
    },
  },
}));

vi.mock('@process/channels/core/ChannelManager', () => ({
  getChannelManager: () => ({ getPluginManager: () => ({ getPlugin, getAllPlugins }) }),
}));

vi.mock('@process/services/emailTriage/emailTriageServiceSingleton', () => ({
  emailTriageRepository: { getByMessageId: repoGet, listByPlugin: vi.fn(async () => []) },
}));

import { initEmailTriageBridge } from '@process/bridge/knowledge/records/emailTriageBridge';

const ENTRY: EmailTriageEntry = {
  messageId: '<m@x>',
  pluginId: 'email-imap_default',
  account: 'me@co.com',
  fromAddr: 'sender@ext.com',
  subject: 'Invoice #42',
  urgency: 'high',
  tags: ['finance'],
  spamVerdict: false,
  spamReason: '',
  summary: '',
  draftReply: 'Thanks, paying today.',
  modelUsed: 'm',
  triagedAtMs: 1,
};

describe('emailTriageBridge.sendDraft', () => {
  beforeEach(() => {
    sendMessage.mockClear();
    getPlugin.mockReturnValue(undefined);
    getAllPlugins.mockReturnValue([{ type: 'email-imap', sendMessage }]);
    repoGet.mockReset();
    initEmailTriageBridge();
  });

  it('routes the stored draft through EmailImapPlugin.sendMessage with reply threading', async () => {
    repoGet.mockResolvedValue(ENTRY);
    const result = await providers.sendDraft({ pluginId: 'email-imap_default', messageId: '<m@x>' } as SendDraftParams);

    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(sendMessage).toHaveBeenCalledWith('sender@ext.com', {
      type: 'text',
      text: 'Thanks, paying today.',
      subject: 'Re: Invoice #42',
      replyToMessageId: '<m@x>',
    });
    expect(result).toEqual({ messageId: '<sent@x>' });
  });

  it('sends the edited body verbatim when the user tweaked the draft', async () => {
    repoGet.mockResolvedValue(ENTRY);
    await providers.sendDraft({
      pluginId: 'email-imap_default',
      messageId: '<m@x>',
      editedBody: 'Edited reply text',
    } as SendDraftParams);

    expect(sendMessage).toHaveBeenCalledWith('sender@ext.com', expect.objectContaining({ text: 'Edited reply text' }));
  });

  it('throws and never sends when there is no triage entry', async () => {
    repoGet.mockResolvedValue(null);
    await expect(providers.sendDraft({ pluginId: 'x', messageId: '<gone@x>' } as SendDraftParams)).rejects.toThrow(
      /no triage entry/i
    );
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it('does NOT send when the read verbs run (send is explicit-only)', async () => {
    await providers.list({ pluginId: 'email-imap_default' });
    await providers.get({ messageId: '<m@x>' });
    expect(sendMessage).not.toHaveBeenCalled();
  });
});
