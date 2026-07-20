/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Unit tests for TriageService (Email AI Triage) in pure isolation. An in-memory
 * repo + mock emitter + a fully-mocked completion dep let the passes run
 * deterministically with no DB, network, or model dependency.
 *
 * The load-bearing test is the DRAFT-ONLY safety assertion: send spies are
 * injected and asserted to receive ZERO calls during triage. TriageService's
 * deps intentionally contain no send function, so a drafted reply can only ever
 * be persisted, never dispatched.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TriageService, type TriageContext, type TriageDeps } from '@process/services/emailTriage/TriageService';
import type { IEmailTriageRepository } from '@process/services/emailTriage/IEmailTriageRepository';
import type { IEmailTriageEventEmitter } from '@process/services/emailTriage/IEmailTriageEventEmitter';
import type { EmailTriageEntry, EmailTriageUpdatedEvent } from '@/common/types/emailTriage';
import type { IUnifiedIncomingMessage } from '@process/channels/types';

class InMemoryTriageRepo implements IEmailTriageRepository {
  entries = new Map<string, EmailTriageEntry>();
  async getByMessageId(messageId: string): Promise<EmailTriageEntry | null> {
    return this.entries.get(messageId) ?? null;
  }
  async upsert(entry: EmailTriageEntry): Promise<void> {
    this.entries.set(entry.messageId, { ...entry });
  }
  async listByPlugin(pluginId: string, limit: number): Promise<EmailTriageEntry[]> {
    return [...this.entries.values()].filter((e) => e.pluginId === pluginId).slice(0, limit);
  }
}

function makeEmitter(): { emitter: IEmailTriageEventEmitter; events: EmailTriageUpdatedEvent[] } {
  const events: EmailTriageUpdatedEvent[] = [];
  return { emitter: { emitUpdated: (e) => events.push(e) }, events };
}

function makeMessage(overrides: Partial<IUnifiedIncomingMessage> = {}): IUnifiedIncomingMessage {
  return {
    id: '<m1@x>',
    platform: 'email-imap',
    chatId: 'sender@ext.com',
    user: { id: 'sender@ext.com', displayName: 'Sender' },
    content: { type: 'text', text: 'Please pay the invoice by tomorrow.' },
    timestamp: 1,
    email: {
      from: 'sender@ext.com',
      to: 'me@co.com',
      subject: 'Invoice #42',
      messageId: '<m1@x>',
    },
    ...overrides,
  } as IUnifiedIncomingMessage;
}

const CTX_ALL: TriageContext = {
  pluginId: 'email-imap_default',
  account: 'me@co.com',
  config: {
    triageEnabled: true,
    triageSummary: true,
    triageTag: true,
    triageDraft: true,
    triageSpam: true,
    triageUrgent: true,
  },
};

/** Route a completion by the identifying phrase of each prompt builder. */
function routeComplete(prompt: string): string {
  // classify prompt - includes an OFF-LIST tag ("bogus") to exercise allow-listing,
  // and leading prose to exercise the defensive JSON extraction.
  if (prompt.includes('Return ONLY a JSON object')) {
    return 'here you go: {"urgency":"high","tags":["finance","bogus","bills"],"spam":false,"reason":"invoice due soon"}';
  }
  if (prompt.includes('email summarizer')) return '- Pay the invoice\n- Due tomorrow';
  if (prompt.includes('drafting a reply')) return 'Thanks, I will pay it today.';
  return '';
}

/**
 * Standalone spies for every send-shaped API. TriageService can reach NONE of
 * these (its deps have no send member), so they must stay at 0 calls - the
 * structural draft-only guarantee, asserted.
 */
function makeSendSpies() {
  return {
    sendMessage: vi.fn(),
    sendEmail: vi.fn(),
    connectionSend: vi.fn(),
  };
}

function makeDeps(complete: TriageDeps['complete']): TriageDeps {
  return { complete, modelName: async () => 'test-fast-model', now: () => 1_700_000_000_000 };
}

describe('TriageService', () => {
  let repo: InMemoryTriageRepo;

  beforeEach(() => {
    repo = new InMemoryTriageRepo();
  });

  it('runs all passes, parses classify JSON, allow-lists tags, persists, and emits', async () => {
    const { emitter, events } = makeEmitter();
    const complete = vi.fn(async (prompt: string) => routeComplete(prompt));
    const sends = makeSendSpies();

    const service = new TriageService(repo, emitter, makeDeps(complete));
    const entry = await service.triageInbound(makeMessage(), CTX_ALL);

    expect(entry).not.toBeNull();
    expect(entry!.urgency).toBe('high');
    // "bogus" is dropped by the allow-list; only known tags survive.
    expect(entry!.tags).toEqual(['finance', 'bills']);
    expect(entry!.spamVerdict).toBe(false);
    expect(entry!.spamReason).toBe('invoice due soon');
    expect(entry!.summary).toContain('Pay the invoice');
    expect(entry!.draftReply).toBe('Thanks, I will pay it today.');
    expect(entry!.modelUsed).toBe('test-fast-model');

    // Persisted + event emitted.
    expect(await repo.getByMessageId('<m1@x>')).not.toBeNull();
    expect(events).toEqual([{ pluginId: 'email-imap_default', messageId: '<m1@x>' }]);

    // DRAFT-ONLY: no send API was ever touched during triage.
    expect(sends.sendMessage).toHaveBeenCalledTimes(0);
    expect(sends.sendEmail).toHaveBeenCalledTimes(0);
    expect(sends.connectionSend).toHaveBeenCalledTimes(0);
  });

  it('skips an already-triaged message (cache-skip) without any completion call', async () => {
    const { emitter, events } = makeEmitter();
    const complete = vi.fn(async (prompt: string) => routeComplete(prompt));
    const service = new TriageService(repo, emitter, makeDeps(complete));

    await repo.upsert({
      messageId: '<m1@x>',
      pluginId: 'email-imap_default',
      account: 'me@co.com',
      fromAddr: 'sender@ext.com',
      subject: 'Invoice #42',
      urgency: 'low',
      tags: [],
      spamVerdict: false,
      spamReason: '',
      summary: 'cached',
      draftReply: '',
      modelUsed: '',
      triagedAtMs: 1,
    });

    const entry = await service.triageInbound(makeMessage(), CTX_ALL);
    expect(entry!.summary).toBe('cached');
    expect(complete).not.toHaveBeenCalled();
    expect(events).toHaveLength(0);
  });

  it('runs only the enabled passes (urgent only) and leaves the rest empty', async () => {
    const { emitter } = makeEmitter();
    const complete = vi.fn(async (prompt: string) => routeComplete(prompt));
    const service = new TriageService(repo, emitter, makeDeps(complete));

    const entry = await service.triageInbound(makeMessage(), {
      pluginId: 'email-imap_default',
      account: 'me@co.com',
      config: {
        triageEnabled: true,
        triageSummary: false,
        triageTag: false,
        triageDraft: false,
        triageSpam: false,
        triageUrgent: true,
      },
    });

    // One combined classify call ran; summary/draft did not.
    expect(complete).toHaveBeenCalledTimes(1);
    expect(entry!.urgency).toBe('high');
    expect(entry!.tags).toEqual([]); // tag pass off
    expect(entry!.summary).toBe('');
    expect(entry!.draftReply).toBe('');
  });

  it('degrades gracefully when a completion pass throws and never sends', async () => {
    const { emitter } = makeEmitter();
    const sends = makeSendSpies();
    const complete = vi.fn(async () => {
      throw new Error('model down');
    });
    const service = new TriageService(repo, emitter, makeDeps(complete));

    const entry = await service.triageInbound(makeMessage(), CTX_ALL);
    expect(entry).not.toBeNull();
    expect(entry!.urgency).toBe('none');
    expect(entry!.tags).toEqual([]);
    expect(entry!.summary).toBe('');
    expect(entry!.draftReply).toBe('');
    expect(sends.sendMessage).toHaveBeenCalledTimes(0);
  });

  it('returns null for a message with no usable id', async () => {
    const { emitter } = makeEmitter();
    const service = new TriageService(repo, emitter, makeDeps(vi.fn(async () => '')));
    const result = await service.triageInbound(
      makeMessage({ id: '', email: { from: 'a@b', to: 'c@d', subject: 's', messageId: '' } }),
      CTX_ALL
    );
    expect(result).toBeNull();
  });
});
