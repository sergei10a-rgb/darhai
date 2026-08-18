// @vitest-environment jsdom

import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  appendSpeechTranscript,
  applySpeechLiveTranscript,
  createSpeechLiveTranscriptHandler,
  getSpeechInputAvailabilityForEnvironment,
  mapSpeechInputError,
  pickRecordingMimeType,
  useSpeechInput,
} from '@/renderer/hooks/system/useSpeechInput';

const mockTranscribeAudioBlob = vi.fn();

vi.mock('@/renderer/services/SpeechToTextService', () => ({
  transcribeAudioBlob: (...args: unknown[]) => mockTranscribeAudioBlob(...args),
}));

vi.mock('@/renderer/utils/platform', () => ({
  isElectronDesktop: () => false,
}));

// The hook imports ipcBridge for the live-dictation path. This file only
// exercises the batch path + pure helpers, so an inert stub is enough (the
// real barrel drags Electron-facing modules into jsdom).
vi.mock('@/common', () => ({
  ipcBridge: {
    sttLive: {
      start: { invoke: vi.fn(async () => undefined) },
      chunk: { invoke: vi.fn(async () => undefined) },
      stop: { invoke: vi.fn(async () => ({ text: '' })) },
      cancel: { invoke: vi.fn(async () => undefined) },
      onDelta: { on: vi.fn(() => () => undefined) },
    },
  },
}));

vi.mock('@/common/config/storage', () => ({
  ConfigStorage: {
    get: vi.fn(async () => ({ enabled: true, provider: 'openai' })),
  },
}));

const installRecordingEnvironment = ({ getUserMedia }: { getUserMedia: () => Promise<MediaStream> }) => {
  Object.defineProperty(navigator, 'mediaDevices', {
    configurable: true,
    value: {
      getUserMedia,
    },
  });

  class MockMediaRecorder {
    static isTypeSupported(mimeType: string) {
      return mimeType === 'audio/webm';
    }

    public mimeType: string;
    public ondataavailable: ((event: { data: Blob }) => void) | null = null;
    public onerror: (() => void) | null = null;
    public onstop: (() => void) | null = null;
    public state = 'inactive';

    constructor(_stream: MediaStream, options?: { mimeType?: string }) {
      this.mimeType = options?.mimeType ?? 'audio/webm';
    }

    start() {
      this.state = 'recording';
    }

    stop() {
      this.state = 'inactive';
      this.ondataavailable?.({
        data: new Blob(['recorded-audio'], { type: this.mimeType }),
      });
      this.onstop?.();
    }
  }

  vi.stubGlobal('MediaRecorder', MockMediaRecorder);
};

describe('appendSpeechTranscript', () => {
  it('appends trimmed speech text on a new line when base content exists', () => {
    expect(appendSpeechTranscript('hello', '  world  ')).toBe('hello\nworld');
  });

  it('ignores empty speech text', () => {
    expect(appendSpeechTranscript('hello', '   ')).toBe('hello');
  });
});

describe('mapSpeechInputError', () => {
  // Typed codes travel across IPC as the error MESSAGE prefix (`${code}: ...`).
  it.each([
    ['NEMOTRON_MN_NOT_INSTALLED: the audio.cpp STT runtime is not installed', 'nemotron-not-installed'],
    ['NEMOTRON_MN_START_FAILED: process exited before ready', 'nemotron-start-failed'],
    ['NEMOTRON_MN_START_TIMEOUT: no answer within 30000ms', 'nemotron-start-failed'],
    ['NEMOTRON_MN_REQUEST_FAILED: audio.cpp answered HTTP 500', 'transcription-failed'],
    ['NEMOTRON_MN_FFMPEG_MISSING: ffmpeg was not found on PATH', 'transcription-failed'],
    ['NEMOTRON_MN_AUDIO_CONVERT_FAILED: ffmpeg failed', 'transcription-failed'],
    ['NEMOTRON_MN_LIVE_FAILED: live websocket dropped mid-stream', 'transcription-failed'],
    ['NEMOTRON_MN_LIVE_NOT_ACTIVE: no live session is open', 'transcription-failed'],
    ['STT_DISABLED: speech to text is switched off', 'not-configured'],
    ['STT_OPENAI_NOT_CONFIGURED: no key', 'not-configured'],
    ['STT_REQUEST_FAILED: upstream 500', 'transcription-failed'],
  ])('maps %s -> %s', (message, expected) => {
    expect(mapSpeechInputError(new Error(message))).toBe(expected);
  });

  it('falls back to unknown for unrecognized failures', () => {
    expect(mapSpeechInputError(new Error('boom'))).toBe('unknown');
  });
});

describe('applySpeechLiveTranscript', () => {
  it('starts a live region by appending on a new line after existing text', () => {
    const { nextValue, nextState } = applySpeechLiveTranscript(null, 'typed before', 'сайн');

    expect(nextValue).toBe('typed before\nсайн');
    expect(nextState).not.toBeNull();
  });

  it('inserts directly into an empty input without a separator', () => {
    const { nextValue } = applySpeechLiveTranscript(null, '', 'сайн байна уу');

    expect(nextValue).toBe('сайн байна уу');
  });

  it('REPLACES the live region on each delta instead of appending (duplication regression)', () => {
    const first = applySpeechLiveTranscript(null, '', 'сайн');
    const second = applySpeechLiveTranscript(first.nextState, first.nextValue, 'сайн байна');
    const third = applySpeechLiveTranscript(second.nextState, second.nextValue, 'сайн байна уу');

    expect(second.nextValue).toBe('сайн байна');
    expect(third.nextValue).toBe('сайн байна уу');
    // The partial prefix must appear exactly once - an append bug would
    // produce 'сайн\nсайн байна\nсайн байна уу'.
    expect(third.nextValue.match(/сайн/g)).toHaveLength(1);
  });

  it('keeps text the user typed after the live region while streaming continues', () => {
    const first = applySpeechLiveTranscript(null, 'base', 'сайн');
    // User typed ' гараар' at the end while dictating.
    const editedValue = `${first.nextValue} гараар`;
    const second = applySpeechLiveTranscript(first.nextState, editedValue, 'сайн байна');

    expect(second.nextValue).toBe('base\nсайн байна гараар');
  });

  it('re-appends when the user deleted the streamed text entirely', () => {
    const first = applySpeechLiveTranscript(null, '', 'сайн байна');
    const second = applySpeechLiveTranscript(first.nextState, 'something else', 'дараагийн');

    expect(second.nextValue).toBe('something else\nдараагийн');
  });

  it('treats an empty partial as a no-op', () => {
    const result = applySpeechLiveTranscript(null, 'unchanged', '   ');

    expect(result.nextValue).toBe('unchanged');
    expect(result.nextState).toBeNull();
  });
});

describe('createSpeechLiveTranscriptHandler', () => {
  const createHarness = (initial: string) => {
    let value = initial;
    const setValue = vi.fn((next: string) => {
      value = next;
    });
    const handler = createSpeechLiveTranscriptHandler({
      getCurrentValue: () => value,
      setValue,
    });
    return { handler, setValue, getValue: () => value };
  };

  it('replaces successive partials and finalizes with the stop text', () => {
    const harness = createHarness('hello');

    harness.handler('сайн', 'partial');
    harness.handler('сайн байна', 'partial');
    harness.handler('сайн байна уу', 'final');

    expect(harness.getValue()).toBe('hello\nсайн байна уу');
    expect(harness.getValue().match(/сайн/g)).toHaveLength(1);
  });

  it('starts a fresh live region after a final (no overwrite of committed text)', () => {
    const harness = createHarness('');

    harness.handler('эхний өгүүлбэр', 'partial');
    harness.handler('эхний өгүүлбэр', 'final');
    harness.handler('хоёр дахь', 'partial');

    expect(harness.getValue()).toBe('эхний өгүүлбэр\nхоёр дахь');
  });

  it('does not call setValue when the composed value is unchanged', () => {
    const harness = createHarness('');

    harness.handler('адил', 'partial');
    const callsAfterFirst = harness.setValue.mock.calls.length;
    harness.handler('адил', 'partial');

    expect(harness.setValue.mock.calls.length).toBe(callsAfterFirst);
  });
});

describe('getSpeechInputAvailabilityForEnvironment', () => {
  it('returns record when recording APIs are available in a secure context', () => {
    expect(
      getSpeechInputAvailabilityForEnvironment({
        hasFileInput: true,
        hasMediaDevices: true,
        hasMediaRecorder: true,
        hostname: 'example.com',
        isElectronDesktop: false,
        isSecureContext: true,
      })
    ).toBe('record');
  });

  it('falls back to file when live recording is unavailable', () => {
    expect(
      getSpeechInputAvailabilityForEnvironment({
        hasFileInput: true,
        hasMediaDevices: false,
        hasMediaRecorder: false,
        hostname: 'example.com',
        isElectronDesktop: false,
        isSecureContext: false,
      })
    ).toBe('file');
  });
});

describe('pickRecordingMimeType', () => {
  afterEach(() => {
    mockTranscribeAudioBlob.mockReset();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('returns the first supported recording mime type', () => {
    vi.stubGlobal('MediaRecorder', {
      isTypeSupported: vi.fn((mimeType: string) => mimeType === 'audio/webm'),
    });

    expect(pickRecordingMimeType()).toBe('audio/webm');
  });

  it('returns an empty string when MediaRecorder is unavailable', () => {
    vi.stubGlobal('MediaRecorder', undefined);

    expect(pickRecordingMimeType()).toBe('');
  });
});

describe('useSpeechInput', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('starts in file mode when live recording APIs are unavailable', () => {
    const { result } = renderHook(() =>
      useSpeechInput({
        locale: 'en-US',
        onTranscript: vi.fn(),
      })
    );

    expect(result.current.availability).toBe('file');
    expect(result.current.status).toBe('idle');
  });

  it('returns the transcript and clears transient error state after a successful file transcription', async () => {
    const onTranscript = vi.fn();
    mockTranscribeAudioBlob.mockResolvedValueOnce({ text: 'hello from speech' });

    const { result } = renderHook(() =>
      useSpeechInput({
        locale: 'en-US',
        onTranscript,
      })
    );

    await act(async () => {
      await result.current.transcribeFile(new Blob(['audio'], { type: 'audio/webm' }));
    });

    expect(onTranscript).toHaveBeenCalledWith('hello from speech');
    expect(result.current.status).toBe('idle');
    expect(result.current.errorCode).toBeNull();
    expect(result.current.errorMessage).toBeNull();
  });

  it('surfaces an empty transcript as a recoverable warning state', async () => {
    mockTranscribeAudioBlob.mockResolvedValueOnce({ text: '   ' });

    const { result } = renderHook(() =>
      useSpeechInput({
        locale: 'en-US',
        onTranscript: vi.fn(),
      })
    );

    await act(async () => {
      await result.current.transcribeFile(new Blob(['audio'], { type: 'audio/webm' }));
    });

    expect(result.current.status).toBe('error');
    expect(result.current.errorCode).toBe('empty-transcript');
    expect(result.current.errorMessage).toBeNull();
  });

  it('extracts a concrete provider message when transcription requests fail', async () => {
    mockTranscribeAudioBlob.mockRejectedValueOnce(new Error('STT_REQUEST_FAILED: model overloaded'));

    const { result } = renderHook(() =>
      useSpeechInput({
        locale: 'en-US',
        onTranscript: vi.fn(),
      })
    );

    await act(async () => {
      await result.current.transcribeFile(new Blob(['audio'], { type: 'audio/webm' }));
    });

    expect(result.current.status).toBe('error');
    expect(result.current.errorCode).toBe('transcription-failed');
    expect(result.current.errorMessage).toBe('model overloaded');

    act(() => {
      result.current.clearError();
    });

    expect(result.current.status).toBe('idle');
    expect(result.current.errorCode).toBeNull();
    expect(result.current.errorMessage).toBeNull();
  });

  it('keeps the detailed error empty for generic transcription failures', async () => {
    mockTranscribeAudioBlob.mockRejectedValueOnce(new Error('STT_NETWORK_ERROR'));

    const { result } = renderHook(() =>
      useSpeechInput({
        locale: 'en-US',
        onTranscript: vi.fn(),
      })
    );

    await act(async () => {
      await result.current.transcribeFile(new Blob(['audio'], { type: 'audio/webm' }));
    });

    expect(result.current.status).toBe('error');
    expect(result.current.errorCode).toBe('network');
    expect(result.current.errorMessage).toBeNull();
  });

  it('reports recording unsupported when recording is requested without live capture support', async () => {
    const { result } = renderHook(() =>
      useSpeechInput({
        locale: 'en-US',
        onTranscript: vi.fn(),
      })
    );

    await act(async () => {
      await result.current.startRecording();
    });

    await waitFor(() => {
      expect(result.current.status).toBe('error');
    });
    expect(result.current.errorCode).toBe('recording-unsupported');
    expect(result.current.errorMessage).toBeNull();
  });

  it('records audio and transcribes it when live recording is available', async () => {
    vi.useFakeTimers();
    const stopTrack = vi.fn();
    const onTranscript = vi.fn();
    mockTranscribeAudioBlob.mockResolvedValueOnce({ text: 'recorded result' });
    installRecordingEnvironment({
      getUserMedia: vi.fn(async () => ({
        getTracks: () => [{ stop: stopTrack }],
      })) as unknown as () => Promise<MediaStream>,
    });

    const { result } = renderHook(() =>
      useSpeechInput({
        locale: 'en-US',
        onTranscript,
      })
    );

    await act(async () => {
      await result.current.startRecording();
    });

    expect(result.current.availability).toBe('record');
    expect(result.current.status).toBe('recording');
    act(() => {
      vi.advanceTimersByTime(320);
    });
    expect(result.current.recordingDurationMs).toBeGreaterThan(0);
    expect(result.current.recordingLevels).toHaveLength(40);

    await act(async () => {
      result.current.stopRecording();
    });

    await act(async () => {
      await Promise.resolve();
    });
    expect(onTranscript).toHaveBeenCalledWith('recorded result');
    expect(result.current.status).toBe('idle');
    expect(result.current.errorMessage).toBeNull();
    expect(stopTrack).toHaveBeenCalled();
  });

  it('maps recording permission failures without exposing a stale detail message', async () => {
    installRecordingEnvironment({
      getUserMedia: vi.fn(async () => {
        throw new DOMException('Permission denied', 'NotAllowedError');
      }) as unknown as () => Promise<MediaStream>,
    });

    const { result } = renderHook(() =>
      useSpeechInput({
        locale: 'en-US',
        onTranscript: vi.fn(),
      })
    );

    await act(async () => {
      await result.current.startRecording();
    });

    await waitFor(() => {
      expect(result.current.status).toBe('error');
    });
    expect(result.current.errorCode).toBe('permission-denied');
    expect(result.current.errorMessage).toBeNull();
  });
});
