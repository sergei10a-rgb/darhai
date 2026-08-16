/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

// Unit tests for the renderer TTS playback service:
//   - markdown stripping: code blocks dropped, link labels kept, markers gone
//   - clamping: prepareTextForSpeech caps at TTS_MAX_SPEAK_CHARS (kitten's
//     server 413s over-long text; the clamp is what keeps auto-read alive)
//   - error code -> i18n key mapping (codes travel as message prefixes)
//   - speakText: sends the text over voiceSynth.speak and plays the bytes,
//     interrupting the previous clip (the app-wide singleton contract)

import { beforeEach, describe, expect, it, vi } from 'vitest';

const speakInvokeMock = vi.fn();

vi.mock('@/common/adapter/ipcBridge', () => ({
  voiceSynth: {
    speak: { invoke: (...args: unknown[]) => speakInvokeMock(...args) },
    stop: { invoke: vi.fn() },
  },
}));

import {
  TTS_MAX_SPEAK_CHARS,
  isTtsPlaying,
  onTtsPlaybackStopped,
  playTtsBytes,
  prepareTextForSpeech,
  speakText,
  stopTtsPlayback,
  stripMarkdownForSpeech,
  ttsErrorMessageKey,
} from '@/renderer/services/voice/ttsPlayback';

// ---------------------------------------------------------------------------
// Audio / URL stubs (jsdom has no working Audio.play or createObjectURL)
// ---------------------------------------------------------------------------

class FakeAudio {
  static instances: FakeAudio[] = [];
  src: string;
  paused = false;
  private listeners = new Map<string, Array<() => void>>();

  constructor(src: string) {
    this.src = src;
    FakeAudio.instances.push(this);
  }

  addEventListener(event: string, cb: () => void): void {
    const list = this.listeners.get(event) ?? [];
    list.push(cb);
    this.listeners.set(event, list);
  }

  removeEventListener(): void {}

  dispatch(event: string): void {
    for (const cb of this.listeners.get(event) ?? []) cb();
  }

  pause(): void {
    this.paused = true;
  }

  play(): Promise<void> {
    return Promise.resolve();
  }
}

beforeEach(() => {
  FakeAudio.instances = [];
  speakInvokeMock.mockReset();
  speakInvokeMock.mockResolvedValue({ data: [82, 73, 70, 70], mimeType: 'audio/wav' });
  vi.stubGlobal('Audio', FakeAudio);
  vi.stubGlobal('URL', {
    createObjectURL: vi.fn(() => `blob:fake-${FakeAudio.instances.length}`),
    revokeObjectURL: vi.fn(),
  });
  stopTtsPlayback();
});

// ---------------------------------------------------------------------------
// stripMarkdownForSpeech / prepareTextForSpeech
// ---------------------------------------------------------------------------

describe('stripMarkdownForSpeech', () => {
  it('drops fenced code blocks entirely', () => {
    const out = stripMarkdownForSpeech('Өмнө нь.\n```ts\nconst x = 1;\n```\nДараа нь.');
    expect(out).not.toContain('const x');
    expect(out).toContain('Өмнө нь.');
    expect(out).toContain('Дараа нь.');
  });

  it('keeps link labels and inline code content, drops the mechanics', () => {
    const out = stripMarkdownForSpeech('Үзнэ үү: [Дархай](https://example.com) ба `bun run test`.');
    expect(out).toContain('Дархай');
    expect(out).not.toContain('https://example.com');
    expect(out).toContain('bun run test');
    expect(out).not.toContain('`');
  });

  it('removes heading, list, emphasis and image markers', () => {
    const out = stripMarkdownForSpeech('## Гарчиг\n- **чухал** зүйл\n![alt](img.png)\n*налуу* үг');
    expect(out).toContain('Гарчиг');
    expect(out).toContain('чухал зүйл');
    expect(out).toContain('налуу үг');
    expect(out).not.toContain('#');
    expect(out).not.toContain('*');
    expect(out).not.toContain('img.png');
  });
});

describe('prepareTextForSpeech', () => {
  it('clamps to TTS_MAX_SPEAK_CHARS so the kitten server never sees a 413-sized text', () => {
    const out = prepareTextForSpeech('а'.repeat(TTS_MAX_SPEAK_CHARS * 3));
    expect(out.length).toBe(TTS_MAX_SPEAK_CHARS);
  });

  it('returns plain short text unchanged', () => {
    expect(prepareTextForSpeech('Сайн байна уу')).toBe('Сайн байна уу');
  });
});

// ---------------------------------------------------------------------------
// ttsErrorMessageKey
// ---------------------------------------------------------------------------

describe('ttsErrorMessageKey', () => {
  it.each([
    ['KITTEN_MN_NOT_INSTALLED: bundle missing', 'conversation.chat.tts.notInstalled'],
    ['KITTEN_MN_TEXT_TOO_LONG: over max_chars', 'conversation.chat.tts.textTooLong'],
    ['KITTEN_MN_START_TIMEOUT: no answer in 30000ms', 'conversation.chat.tts.startTimeout'],
    ['KITTEN_MN_START_FAILED: process exited', 'conversation.chat.tts.startFailed'],
    ['KITTEN_MN_BUNDLE_INVALID: bad manifest', 'conversation.chat.tts.startFailed'],
    ['KITTEN_MN_REQUEST_FAILED: HTTP 500', 'conversation.chat.tts.requestFailed'],
    ['TTS_KOKORO_REMOVED: retired provider', 'conversation.chat.tts.kokoroRemoved'],
    ['TTS_SYSTEM_NATIVE_UNSUPPORTED: not darwin', 'conversation.chat.tts.systemNativeUnsupported'],
  ])('maps %s', (message, key) => {
    expect(ttsErrorMessageKey(new Error(message))).toBe(key);
  });

  it('falls back to the generic key for unknown failures', () => {
    expect(ttsErrorMessageKey(new Error('socket hang up'))).toBe('conversation.chat.tts.genericError');
    expect(ttsErrorMessageKey('weird non-error')).toBe('conversation.chat.tts.genericError');
  });
});

// ---------------------------------------------------------------------------
// speakText / playback singleton
// ---------------------------------------------------------------------------

describe('speakText', () => {
  it('invokes voiceSynth.speak with the text and starts playback', async () => {
    await speakText('Сайн байна уу');
    expect(speakInvokeMock).toHaveBeenCalledWith({ text: 'Сайн байна уу' });
    expect(FakeAudio.instances).toHaveLength(1);
    expect(isTtsPlaying()).toBe(true);
  });

  it('propagates typed bridge errors without creating an audio element', async () => {
    speakInvokeMock.mockRejectedValueOnce(new Error('KITTEN_MN_NOT_INSTALLED: bundle missing'));
    await expect(speakText('x')).rejects.toThrow('KITTEN_MN_NOT_INSTALLED');
    expect(FakeAudio.instances).toHaveLength(0);
  });
});

describe('playback singleton', () => {
  it('a new clip interrupts the previous one (pause + release)', async () => {
    await playTtsBytes([1], 'audio/wav');
    const first = FakeAudio.instances[0];
    await playTtsBytes([2], 'audio/wav');
    expect(first.paused).toBe(true);
    expect(FakeAudio.instances).toHaveLength(2);
    expect(isTtsPlaying()).toBe(true);
  });

  it('notifies subscribers when the clip ends or is stopped', async () => {
    const listener = vi.fn();
    const off = onTtsPlaybackStopped(listener);
    await playTtsBytes([1], 'audio/wav');
    FakeAudio.instances[0].dispatch('ended');
    expect(listener).toHaveBeenCalledTimes(1);
    expect(isTtsPlaying()).toBe(false);

    await playTtsBytes([2], 'audio/wav');
    stopTtsPlayback();
    expect(listener).toHaveBeenCalledTimes(2);
    off();
  });
});
