/**
 * @license
 * Copyright 2026 Wayland (tradecanyon.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { toGoogleChatMessageBody } from '@process/channels/plugins/tier3/google-chat/GoogleChatAdapter';
import type { IUnifiedOutgoingMessage } from '@process/channels/types';

describe('toGoogleChatMessageBody — format', () => {
  it('converts a plain text message to a Chat API body', () => {
    const msg: IUnifiedOutgoingMessage = { type: 'text', text: 'Hello, Workspace!' };
    const body = toGoogleChatMessageBody(msg);
    expect(body).toEqual({ text: 'Hello, Workspace!' });
  });

  it('returns empty text when text is undefined', () => {
    const msg: IUnifiedOutgoingMessage = { type: 'text' };
    const body = toGoogleChatMessageBody(msg);
    expect(body).toEqual({ text: '' });
  });

  it('preserves leading/trailing whitespace (not trimmed by adapter)', () => {
    const msg: IUnifiedOutgoingMessage = { type: 'text', text: '  spaced  ' };
    const body = toGoogleChatMessageBody(msg);
    expect(body.text).toBe('  spaced  ');
  });

  it('handles long text without truncation', () => {
    const longText = 'A'.repeat(4000);
    const msg: IUnifiedOutgoingMessage = { type: 'text', text: longText };
    const body = toGoogleChatMessageBody(msg);
    expect(body.text).toHaveLength(4000);
  });

  it('handles multiline text', () => {
    const msg: IUnifiedOutgoingMessage = { type: 'text', text: 'Line 1\nLine 2\nLine 3' };
    const body = toGoogleChatMessageBody(msg);
    expect(body.text).toBe('Line 1\nLine 2\nLine 3');
  });

  it('ignores non-text message fields (image/file) and uses text field only', () => {
    const msg: IUnifiedOutgoingMessage = {
      type: 'image',
      text: 'caption',
      imageUrl: 'https://example.com/img.png',
    };
    const body = toGoogleChatMessageBody(msg);
    // Adapter only maps text — imageUrl handling is a future enhancement
    expect(body).toEqual({ text: 'caption' });
  });
});
