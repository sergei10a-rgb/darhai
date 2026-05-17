/**
 * @license
 * Copyright 2026 Wayland (tradecanyon.com)
 * SPDX-License-Identifier: Apache-2.0
 *
 * BluebubblesAdapter parse tests — incoming Socket.IO payload →
 * IUnifiedIncomingMessage. Covers: text message, own-message skip,
 * tapback skip, missing sender skip, chatGuid from chats array,
 * and timestamp normalisation.
 */

import { describe, expect, it } from 'vitest';

import {
  extractTapbackFromPayload,
  toUnifiedIncomingFromBluebubbles,
} from '@process/channels/plugins/tier3/bluebubbles/BluebubblesAdapter';

const PLUGIN_TYPE = 'bluebubbles';

// ── toUnifiedIncomingFromBluebubbles ─────────────────────────────────────────

describe('toUnifiedIncomingFromBluebubbles — text message', () => {
  it('converts a well-formed new-message payload to IUnifiedIncomingMessage', () => {
    const payload = {
      guid: 'msg-abc-123',
      text: 'Hello from iMessage',
      isFromMe: false,
      handle: { address: '+14155550100', displayName: 'Alice' },
      chatGuid: 'iMessage;-;+14155550100',
      dateCreated: 1_700_000_000_000,
    };

    const result = toUnifiedIncomingFromBluebubbles(payload, PLUGIN_TYPE);

    expect(result).not.toBeNull();
    expect(result!.id).toBe('msg-abc-123');
    expect(result!.platform).toBe(PLUGIN_TYPE);
    expect(result!.chatId).toBe('iMessage;-;+14155550100');
    expect(result!.user.id).toBe('+14155550100');
    expect(result!.user.displayName).toBe('Alice');
    expect(result!.content.text).toBe('Hello from iMessage');
    expect(result!.timestamp).toBe(1_700_000_000_000);
  });

  it('wraps payload in { data: <message> } envelope and still parses', () => {
    const payload = {
      data: {
        guid: 'msg-envelope',
        text: 'Envelope test',
        isFromMe: false,
        handle: { address: '+14155550101' },
        chatGuid: 'iMessage;-;+14155550101',
      },
    };

    const result = toUnifiedIncomingFromBluebubbles(payload, PLUGIN_TYPE);
    expect(result).not.toBeNull();
    expect(result!.content.text).toBe('Envelope test');
  });

  it('extracts chatGuid from chats[0].guid when top-level chatGuid absent', () => {
    const payload = {
      guid: 'msg-chats',
      text: 'Via chats array',
      isFromMe: false,
      handle: { address: '+14155550102' },
      chats: [{ guid: 'iMessage;-;+14155550102' }],
    };

    const result = toUnifiedIncomingFromBluebubbles(payload, PLUGIN_TYPE);
    expect(result).not.toBeNull();
    expect(result!.chatId).toBe('iMessage;-;+14155550102');
  });

  it('normalises unix-seconds timestamp to milliseconds', () => {
    const payload = {
      guid: 'msg-ts',
      text: 'Timestamp test',
      isFromMe: false,
      handle: { address: '+14155550103' },
      chatGuid: 'iMessage;-;+14155550103',
      dateCreated: 1_700_000_000, // seconds
    };

    const result = toUnifiedIncomingFromBluebubbles(payload, PLUGIN_TYPE);
    expect(result).not.toBeNull();
    expect(result!.timestamp).toBe(1_700_000_000_000);
  });
});

describe('toUnifiedIncomingFromBluebubbles — skip conditions', () => {
  it('returns null for own messages (isFromMe=true)', () => {
    const payload = {
      guid: 'my-msg',
      text: 'I sent this',
      isFromMe: true,
      handle: { address: '+14155550200' },
      chatGuid: 'iMessage;-;+14155550200',
    };

    expect(toUnifiedIncomingFromBluebubbles(payload, PLUGIN_TYPE)).toBeNull();
  });

  it('returns null for tapback events (associatedMessageType 2000-3005)', () => {
    for (const type of [2000, 2001, 2005, 3000, 3005]) {
      const payload = {
        guid: `tapback-${type}`,
        text: '',
        isFromMe: false,
        handle: { address: '+14155550201' },
        chatGuid: 'iMessage;-;+14155550201',
        associatedMessageType: type,
        associatedMessageGuid: 'original-guid',
      };
      expect(toUnifiedIncomingFromBluebubbles(payload, PLUGIN_TYPE)).toBeNull();
    }
  });

  it('returns null when sender address is absent', () => {
    const payload = {
      guid: 'no-sender',
      text: 'No handle',
      isFromMe: false,
      chatGuid: 'iMessage;-;unknown',
    };

    expect(toUnifiedIncomingFromBluebubbles(payload, PLUGIN_TYPE)).toBeNull();
  });

  it('returns null when chatGuid is absent', () => {
    const payload = {
      guid: 'no-chat',
      text: 'No chatGuid',
      isFromMe: false,
      handle: { address: '+14155550202' },
    };

    expect(toUnifiedIncomingFromBluebubbles(payload, PLUGIN_TYPE)).toBeNull();
  });

  it('returns null for non-object payload', () => {
    expect(toUnifiedIncomingFromBluebubbles(null, PLUGIN_TYPE)).toBeNull();
    expect(toUnifiedIncomingFromBluebubbles('string', PLUGIN_TYPE)).toBeNull();
    expect(toUnifiedIncomingFromBluebubbles(42, PLUGIN_TYPE)).toBeNull();
  });
});

// ── extractTapbackFromPayload ─────────────────────────────────────────────────

describe('extractTapbackFromPayload', () => {
  it('extracts a love tapback (type 2000)', () => {
    const payload = {
      associatedMessageType: 2000,
      associatedMessageGuid: 'target-guid-abc',
      isFromMe: false,
    };

    const result = extractTapbackFromPayload(payload);
    expect(result).not.toBeNull();
    expect(result!.emoji).toBe('❤️');
    expect(result!.action).toBe('added');
    expect(result!.targetMessageGuid).toBe('target-guid-abc');
  });

  it('extracts a removed like tapback (type 3001)', () => {
    const payload = {
      associatedMessageType: 3001,
      associatedMessageGuid: 'target-guid-xyz',
    };

    const result = extractTapbackFromPayload(payload);
    expect(result).not.toBeNull();
    expect(result!.emoji).toBe('👍');
    expect(result!.action).toBe('removed');
  });

  it('returns null for non-tapback payloads', () => {
    const payload = {
      guid: 'regular-msg',
      text: 'Hello',
    };

    expect(extractTapbackFromPayload(payload)).toBeNull();
  });

  it('returns null when associatedMessageGuid is absent', () => {
    const payload = { associatedMessageType: 2000 };
    expect(extractTapbackFromPayload(payload)).toBeNull();
  });
});
