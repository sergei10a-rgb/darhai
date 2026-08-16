/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

// Tests for the app-wide auto-read hook:
//   - a turn's `content` frames accumulate and the `finish` frame triggers ONE
//     speak with the markdown-stripped text (config enabled + autoRead on)
//   - nothing is spoken when autoReadResponses (or enabled) is off
//   - consecutive turns each speak (interrupting is the player's job)
//   - a repeating failure toasts once, not once per turn

import { renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { IResponseMessage } from '@/common/adapter/ipcBridge';

type StreamListener = (message: IResponseMessage) => void;

const state = vi.hoisted(() => ({
  listeners: [] as Array<(message: unknown) => void>,
  speakTextMock: vi.fn(),
  getTtsConfigMock: vi.fn(),
  messageWarningMock: vi.fn(),
}));

vi.mock('@/common', () => ({
  ipcBridge: {
    conversation: {
      responseStream: {
        on: (listener: (message: unknown) => void) => {
          state.listeners.push(listener);
          return () => {
            state.listeners = state.listeners.filter((l) => l !== listener);
          };
        },
      },
    },
  },
}));

vi.mock('@/renderer/services/voice/ttsConfig', () => ({
  getTtsConfig: (...args: unknown[]) => state.getTtsConfigMock(...args),
}));

vi.mock('@/renderer/services/voice/ttsPlayback', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/renderer/services/voice/ttsPlayback')>();
  return {
    ...actual,
    speakText: (...args: unknown[]) => state.speakTextMock(...args),
  };
});

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock('@arco-design/web-react', () => ({
  Message: {
    warning: (...args: unknown[]) => state.messageWarningMock(...args),
    error: vi.fn(),
  },
}));

import { useAutoReadResponses } from '@/renderer/hooks/chat/useAutoReadResponses';

const emit = (message: Partial<IResponseMessage>): void => {
  for (const listener of [...state.listeners] as StreamListener[]) {
    listener({ msg_id: 'm1', conversation_id: 'c1', type: 'content', data: '', ...message } as IResponseMessage);
  }
};

const ttsConfig = (overrides: Record<string, unknown> = {}) => ({
  enabled: true,
  provider: 'kitten-mn',
  voice: 'default',
  speed: 1,
  autoReadResponses: true,
  ...overrides,
});

beforeEach(() => {
  state.listeners = [];
  state.speakTextMock.mockReset().mockResolvedValue(undefined);
  state.getTtsConfigMock.mockReset().mockResolvedValue(ttsConfig());
  state.messageWarningMock.mockReset();
});

describe('useAutoReadResponses', () => {
  it('speaks the accumulated, markdown-stripped turn text on finish', async () => {
    renderHook(() => useAutoReadResponses());
    emit({ type: 'content', data: 'Сайн байна уу, ' });
    emit({ type: 'content', data: { content: '**дэлхий**!' } });
    emit({ type: 'finish', data: {} });

    await waitFor(() => {
      expect(state.speakTextMock).toHaveBeenCalledTimes(1);
    });
    expect(state.speakTextMock).toHaveBeenCalledWith('Сайн байна уу, дэлхий!');
  });

  it('does NOT speak when autoReadResponses is off', async () => {
    state.getTtsConfigMock.mockResolvedValue(ttsConfig({ autoReadResponses: false }));
    renderHook(() => useAutoReadResponses());
    emit({ type: 'content', data: 'юу ч биш' });
    emit({ type: 'finish', data: {} });

    // The config read is async - give the pipeline a tick to (not) act.
    await waitFor(() => {
      expect(state.getTtsConfigMock).toHaveBeenCalled();
    });
    expect(state.speakTextMock).not.toHaveBeenCalled();
  });

  it('does NOT speak when TTS itself is disabled', async () => {
    state.getTtsConfigMock.mockResolvedValue(ttsConfig({ enabled: false }));
    renderHook(() => useAutoReadResponses());
    emit({ type: 'content', data: 'юу ч биш' });
    emit({ type: 'finish', data: {} });

    await waitFor(() => {
      expect(state.getTtsConfigMock).toHaveBeenCalled();
    });
    expect(state.speakTextMock).not.toHaveBeenCalled();
  });

  it('a finish without any content frames speaks nothing', async () => {
    renderHook(() => useAutoReadResponses());
    emit({ type: 'finish', data: {} });
    // No buffered text -> the config is never even read.
    await Promise.resolve();
    expect(state.speakTextMock).not.toHaveBeenCalled();
  });

  it('keeps conversations separate and speaks each finished turn', async () => {
    renderHook(() => useAutoReadResponses());
    emit({ type: 'content', data: 'нэгдүгээр', conversation_id: 'c1' });
    emit({ type: 'content', data: 'хоёрдугаар', conversation_id: 'c2' });
    emit({ type: 'finish', data: {}, conversation_id: 'c1' });
    await waitFor(() => {
      expect(state.speakTextMock).toHaveBeenCalledTimes(1);
    });
    expect(state.speakTextMock).toHaveBeenLastCalledWith('нэгдүгээр');

    emit({ type: 'finish', data: {}, conversation_id: 'c2' });
    await waitFor(() => {
      expect(state.speakTextMock).toHaveBeenCalledTimes(2);
    });
    expect(state.speakTextMock).toHaveBeenLastCalledWith('хоёрдугаар');
  });

  it('toasts a failure once, not on every turn with the same failure', async () => {
    state.speakTextMock.mockRejectedValue(new Error('KITTEN_MN_NOT_INSTALLED: bundle missing'));
    renderHook(() => useAutoReadResponses());

    emit({ type: 'content', data: 'нэг' });
    emit({ type: 'finish', data: {} });
    await waitFor(() => {
      expect(state.messageWarningMock).toHaveBeenCalledTimes(1);
    });
    expect(state.messageWarningMock).toHaveBeenCalledWith('conversation.chat.tts.notInstalled');

    emit({ type: 'content', data: 'хоёр' });
    emit({ type: 'finish', data: {} });
    await waitFor(() => {
      expect(state.speakTextMock).toHaveBeenCalledTimes(2);
    });
    // Same failure again -> still just one toast.
    expect(state.messageWarningMock).toHaveBeenCalledTimes(1);
  });

  it('unsubscribes from the stream on unmount', () => {
    const { unmount } = renderHook(() => useAutoReadResponses());
    expect(state.listeners).toHaveLength(1);
    unmount();
    expect(state.listeners).toHaveLength(0);
  });
});
