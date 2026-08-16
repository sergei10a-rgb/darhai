/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { IMessageText } from '@/common/chat/chatLib';

// Read-aloud collaborators: config gate + playback surface, both mocked so the
// button's render condition and click action are directly assertable.
const ttsState = vi.hoisted(() => ({
  enabled: false,
  speakTextMock: vi.fn(),
  stopTtsPlaybackMock: vi.fn(),
}));

vi.mock('@/renderer/services/voice/ttsConfig', () => ({
  TTS_CONFIG_CHANGED_EVENT: 'wayland:tts-config-changed',
  getTtsConfig: vi.fn(async () => ({
    enabled: ttsState.enabled,
    provider: 'kitten-mn',
    voice: 'default',
    speed: 1,
    autoReadResponses: false,
  })),
}));

vi.mock('@/renderer/services/voice/ttsPlayback', () => ({
  onTtsPlaybackStopped: vi.fn(() => () => {}),
  prepareTextForSpeech: (text: string) => text.trim(),
  speakText: (...args: unknown[]) => ttsState.speakTextMock(...args),
  stopTtsPlayback: (...args: unknown[]) => ttsState.stopTtsPlaybackMock(...args),
  ttsErrorMessageKey: () => 'conversation.chat.tts.genericError',
}));

const markdownViewMock = vi.hoisted(() =>
  vi.fn(({ children }: { children: React.ReactNode }) => <div data-testid='markdown-view'>{children}</div>)
);

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: { defaultValue?: string }) => opts?.defaultValue ?? key,
  }),
}));

vi.mock('@arco-design/web-react', () => ({
  Alert: ({ content }: { content: React.ReactNode }) => <div>{content}</div>,
  Message: {
    error: vi.fn(),
  },
  Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

vi.mock('@icon-park/react', () => ({
  Copy: () => <span data-testid='copy-icon' />,
}));

vi.mock('@renderer/components/chat/CollapsibleContent', () => ({
  default: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

vi.mock('@renderer/components/media/FilePreview', () => ({
  default: () => <div data-testid='file-preview' />,
}));

vi.mock('@renderer/components/media/HorizontalFileList', () => ({
  default: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

vi.mock('@renderer/components/Markdown', () => ({
  default: markdownViewMock,
}));

vi.mock('@/renderer/utils/ui/clipboard', () => ({
  copyText: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@/renderer/utils/model/agentLogo', () => ({
  getAgentLogo: vi.fn((type?: string) => (type ? '/backend-logo.svg' : null)),
}));

vi.mock('@/renderer/pages/conversation/Messages/components/cron/MessageCronBadge', () => ({
  default: () => <div data-testid='message-cron-badge' />,
}));

const mockPresetInfo = vi.hoisted(() => ({ value: null as { name: string; logo: string; isEmoji: boolean } | null }));
vi.mock('@renderer/hooks/agent/usePresetAssistantInfo', () => ({
  usePresetAssistantInfo: () => ({ info: mockPresetInfo.value, isLoading: false }),
}));

vi.mock('swr', () => ({
  default: () => ({ data: undefined, error: undefined, isLoading: false, mutate: vi.fn() }),
}));

vi.mock('@/common', () => ({
  ipcBridge: {
    conversation: {
      get: { invoke: vi.fn(async () => null) },
    },
  },
}));

import MessageText from '@/renderer/pages/conversation/Messages/components/text/MessageText';

const createMessage = (overrides?: Partial<IMessageText>): IMessageText => ({
  id: 'message-1',
  conversation_id: 'conversation-1',
  type: 'text',
  position: 'left',
  ...overrides,
  content: {
    content: 'default message',
    ...overrides?.content,
  },
});

describe('MessageText', () => {
  beforeEach(() => {
    mockPresetInfo.value = null;
    ttsState.enabled = false;
    ttsState.speakTextMock.mockReset().mockResolvedValue(undefined);
    ttsState.stopTtsPlaybackMock.mockReset();
  });

  it('renders user-authored markdown-looking text as plain text instead of using MarkdownView', () => {
    render(
      <MessageText
        message={createMessage({
          position: 'right',
          content: {
            content: '~tilde~ **bold** `code`',
          },
        })}
      />
    );

    expect(screen.queryByTestId('markdown-view')).not.toBeInTheDocument();
    expect(screen.getByText('~tilde~ **bold** `code`')).toBeInTheDocument();
    expect(markdownViewMock).not.toHaveBeenCalled();
  });

  it('continues to use MarkdownView for assistant messages', () => {
    render(
      <MessageText
        message={createMessage({
          position: 'left',
          content: {
            content: '~tilde~ **bold** `code`',
          },
        })}
      />
    );

    expect(screen.getByTestId('markdown-view')).toBeInTheDocument();
    expect(markdownViewMock).toHaveBeenCalledOnce();
  });

  it('shows the preset emoji instead of the backend logo for teammate messages from preset senders', () => {
    mockPresetInfo.value = { name: 'Word Creator', logo: '📝', isEmoji: true };

    render(
      <MessageText
        message={createMessage({
          position: 'left',
          content: {
            content: 'hello from preset',
            teammateMessage: true,
            senderName: 'Writer',
            senderAgentType: 'gemini',
            senderConversationId: 'conv-preset',
          },
        })}
      />
    );

    expect(screen.getByText('📝')).toBeInTheDocument();
    // Backend logo must not render when a preset avatar is available
    expect(screen.queryByAltText('Writer')).not.toBeInTheDocument();
  });

  it('falls back to the backend logo for teammate messages from non-preset senders', () => {
    mockPresetInfo.value = null;

    render(
      <MessageText
        message={createMessage({
          position: 'left',
          content: {
            content: 'hello from cli agent',
            teammateMessage: true,
            senderName: 'Coder',
            senderAgentType: 'claude',
            senderConversationId: 'conv-cli',
          },
        })}
      />
    );

    const logo = screen.getByAltText('Coder') as HTMLImageElement;
    expect(logo.src).toContain('/backend-logo.svg');
  });

  it('renders no read-aloud affordance while TTS is disabled', async () => {
    ttsState.enabled = false;
    render(<MessageText message={createMessage({ position: 'left' })} />);
    // The enabled check is async - assert the button STAYS absent after it.
    await waitFor(() => {
      expect(screen.queryByTestId('message-read-aloud')).not.toBeInTheDocument();
    });
  });

  it('assistant rows get a read-aloud button that speaks the message text', async () => {
    ttsState.enabled = true;
    render(
      <MessageText
        message={createMessage({
          position: 'left',
          content: { content: 'Сайн байна уу' },
        })}
      />
    );

    const button = await screen.findByTestId('message-read-aloud');
    fireEvent.click(button);
    await waitFor(() => {
      expect(ttsState.speakTextMock).toHaveBeenCalledWith('Сайн байна уу');
    });
  });

  it('user rows never get the read-aloud button even with TTS enabled', async () => {
    ttsState.enabled = true;
    render(<MessageText message={createMessage({ position: 'right' })} />);
    await waitFor(() => {
      expect(screen.queryByTestId('message-read-aloud')).not.toBeInTheDocument();
    });
  });
});
