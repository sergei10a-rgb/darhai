// @vitest-environment jsdom

/**
 * Live Mongolian dictation path of useSpeechInput (`nemotron-mn` provider):
 * raw PCM streams over ipcBridge.sttLive while onDelta partials REPLACE the
 * consumer's live region. The batch (MediaRecorder -> transcribe) path must
 * stay untouched for every other provider.
 */

import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

type DeltaHandler = (payload: { text: string }) => void;

// vi.mock factories are hoisted above imports, so every value they touch must
// come from vi.hoisted().
const mocks = vi.hoisted(() => {
  const fn = vi.fn;
  return {
    transcribeAudioBlob: fn(),
    sttLive: {
      start: { invoke: fn() },
      chunk: { invoke: fn() },
      stop: { invoke: fn() },
      cancel: { invoke: fn() },
      onDelta: { on: fn() },
    },
    startLivePcmCapture: fn(),
    state: { provider: 'nemotron-mn' },
  };
});

const mockTranscribeAudioBlob = mocks.transcribeAudioBlob;
const sttLiveMock = mocks.sttLive;
const mockStartLivePcmCapture = mocks.startLivePcmCapture;

let deltaHandlers: DeltaHandler[] = [];
const offDeltaSpy = vi.fn();

const mockCaptureStop = vi.fn();
let capturedOnChunk: ((pcmBytes: Uint8Array) => void) | null = null;

vi.mock('@/common', () => ({
  ipcBridge: { sttLive: mocks.sttLive },
}));

vi.mock('@/common/config/storage', () => ({
  ConfigStorage: {
    get: async (key: string) => {
      if (key === 'tools.speechToText') {
        return { enabled: true, provider: mocks.state.provider };
      }
      return undefined;
    },
  },
}));

vi.mock('@/renderer/utils/platform', () => ({
  isElectronDesktop: () => true,
}));

vi.mock('@/renderer/services/SpeechToTextService', () => ({
  transcribeAudioBlob: (...args: unknown[]) => mocks.transcribeAudioBlob(...args),
}));

vi.mock('@/renderer/services/voice/livePcmCapture', () => ({
  startLivePcmCapture: (...args: unknown[]) => mocks.startLivePcmCapture(...args),
}));

import { useSpeechInput } from '@/renderer/hooks/system/useSpeechInput';

const stopTrack = vi.fn();

class MockMediaRecorder {
  static instances: MockMediaRecorder[] = [];

  static isTypeSupported(mimeType: string) {
    return mimeType === 'audio/webm';
  }

  public mimeType = 'audio/webm';
  public ondataavailable: ((event: { data: Blob }) => void) | null = null;
  public onerror: (() => void) | null = null;
  public onstop: (() => void) | null = null;
  public state = 'inactive';

  constructor() {
    MockMediaRecorder.instances.push(this);
  }

  start() {
    this.state = 'recording';
  }

  stop() {
    this.state = 'inactive';
    this.ondataavailable?.({ data: new Blob(['recorded-audio'], { type: this.mimeType }) });
    this.onstop?.();
  }
}

const installEnvironment = () => {
  Object.defineProperty(navigator, 'mediaDevices', {
    configurable: true,
    value: {
      getUserMedia: vi.fn(async () => ({
        getTracks: () => [{ stop: stopTrack }],
      })),
    },
  });
  vi.stubGlobal('MediaRecorder', MockMediaRecorder);
};

const renderSpeechInput = (options?: {
  onTranscript?: (transcript: string) => void;
  onLiveTranscript?: (transcript: string, phase: 'partial' | 'final') => void;
}) =>
  renderHook(() =>
    useSpeechInput({
      locale: 'mn-MN',
      onTranscript: options?.onTranscript ?? vi.fn(),
      onLiveTranscript: options?.onLiveTranscript,
    })
  );

beforeEach(() => {
  vi.clearAllMocks();
  vi.unstubAllGlobals();
  MockMediaRecorder.instances = [];
  deltaHandlers = [];
  capturedOnChunk = null;
  mocks.state.provider = 'nemotron-mn';

  sttLiveMock.start.invoke.mockResolvedValue(undefined);
  sttLiveMock.chunk.invoke.mockResolvedValue(undefined);
  sttLiveMock.stop.invoke.mockResolvedValue({ text: 'эцсийн цэвэр текст' });
  sttLiveMock.cancel.invoke.mockResolvedValue(undefined);
  sttLiveMock.onDelta.on.mockImplementation((handler: DeltaHandler) => {
    deltaHandlers.push(handler);
    return offDeltaSpy;
  });
  mockCaptureStop.mockResolvedValue(undefined);
  mockStartLivePcmCapture.mockImplementation(async (opts: { onChunk: (pcmBytes: Uint8Array) => void }) => {
    capturedOnChunk = opts.onChunk;
    return { stop: mockCaptureStop };
  });

  installEnvironment();
});

describe('useSpeechInput live dictation (nemotron-mn)', () => {
  it('takes the live path instead of MediaRecorder: start invoked, no batch transcription', async () => {
    const { result } = renderSpeechInput({ onLiveTranscript: vi.fn() });

    await act(async () => {
      await result.current.startRecording();
    });

    expect(sttLiveMock.start.invoke).toHaveBeenCalledTimes(1);
    expect(mockStartLivePcmCapture).toHaveBeenCalledTimes(1);
    expect(result.current.status).toBe('recording');
    // The batch machinery must stay cold on the live path.
    expect(MockMediaRecorder.instances).toHaveLength(0);
    expect(mockTranscribeAudioBlob).not.toHaveBeenCalled();
  });

  it('reports connecting while the STT server boots', async () => {
    let resolveStart: (() => void) | undefined;
    sttLiveMock.start.invoke.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          resolveStart = resolve;
        })
    );

    const { result } = renderSpeechInput({ onLiveTranscript: vi.fn() });

    let startPromise: Promise<void> = Promise.resolve();
    act(() => {
      startPromise = result.current.startRecording();
    });

    await waitFor(() => {
      expect(result.current.status).toBe('connecting');
    });

    await act(async () => {
      resolveStart?.();
      await startPromise;
    });
    expect(result.current.status).toBe('recording');
  });

  it('forwards PCM chunks to sttLive.chunk as plain byte arrays', async () => {
    const { result } = renderSpeechInput({ onLiveTranscript: vi.fn() });

    await act(async () => {
      await result.current.startRecording();
    });

    capturedOnChunk?.(new Uint8Array([1, 2, 255]));

    expect(sttLiveMock.chunk.invoke).toHaveBeenCalledWith({ data: [1, 2, 255] });
  });

  it('emits partials that carry the FULL accumulated text (replace semantics)', async () => {
    const onLiveTranscript = vi.fn();
    const { result } = renderSpeechInput({ onLiveTranscript });

    await act(async () => {
      await result.current.startRecording();
    });

    act(() => {
      deltaHandlers.forEach((handler) => handler({ text: 'сайн' }));
      deltaHandlers.forEach((handler) => handler({ text: 'сайн байна' }));
    });

    expect(onLiveTranscript).toHaveBeenNthCalledWith(1, 'сайн', 'partial');
    expect(onLiveTranscript).toHaveBeenNthCalledWith(2, 'сайн байна', 'partial');
  });

  it('stops the capture BEFORE the stop verb and commits the final text', async () => {
    const callOrder: string[] = [];
    mockCaptureStop.mockImplementation(async () => {
      callOrder.push('capture.stop');
    });
    sttLiveMock.stop.invoke.mockImplementation(async () => {
      callOrder.push('sttLive.stop');
      return { text: 'эцсийн цэвэр текст' };
    });

    const onLiveTranscript = vi.fn();
    const { result } = renderSpeechInput({ onLiveTranscript });

    await act(async () => {
      await result.current.startRecording();
    });
    await act(async () => {
      result.current.stopRecording();
    });

    await waitFor(() => {
      expect(result.current.status).toBe('idle');
    });
    expect(callOrder).toEqual(['capture.stop', 'sttLive.stop']);
    expect(onLiveTranscript).toHaveBeenLastCalledWith('эцсийн цэвэр текст', 'final');
    expect(offDeltaSpy).toHaveBeenCalled();
    expect(stopTrack).toHaveBeenCalled();
  });

  it('falls back to onTranscript at stop when no live consumer is wired', async () => {
    const onTranscript = vi.fn();
    const { result } = renderSpeechInput({ onTranscript });

    await act(async () => {
      await result.current.startRecording();
    });
    await act(async () => {
      result.current.stopRecording();
    });

    await waitFor(() => {
      expect(result.current.status).toBe('idle');
    });
    expect(onTranscript).toHaveBeenCalledWith('эцсийн цэвэр текст');
  });

  it('maps a missing install at start to its dedicated error and cleans up', async () => {
    sttLiveMock.start.invoke.mockRejectedValue(new Error('NEMOTRON_MN_NOT_INSTALLED: runtime missing'));

    const { result } = renderSpeechInput({ onLiveTranscript: vi.fn() });

    await act(async () => {
      await result.current.startRecording();
    });

    await waitFor(() => {
      expect(result.current.status).toBe('error');
    });
    expect(result.current.errorCode).toBe('nemotron-not-installed');
    expect(stopTrack).toHaveBeenCalled();
    expect(sttLiveMock.cancel.invoke).toHaveBeenCalled();
    // A later stop click must be a no-op - the session is gone.
    act(() => {
      result.current.stopRecording();
    });
    expect(sttLiveMock.stop.invoke).not.toHaveBeenCalled();
  });

  it('surfaces a live failure at stop as a toastable error and anchors the last partial', async () => {
    sttLiveMock.stop.invoke.mockRejectedValue(new Error('NEMOTRON_MN_LIVE_FAILED: stream dropped'));

    const onLiveTranscript = vi.fn();
    const { result } = renderSpeechInput({ onLiveTranscript });

    await act(async () => {
      await result.current.startRecording();
    });
    act(() => {
      deltaHandlers.forEach((handler) => handler({ text: 'дуусаагүй хэсэг' }));
    });
    await act(async () => {
      result.current.stopRecording();
    });

    await waitFor(() => {
      expect(result.current.status).toBe('error');
    });
    expect(result.current.errorCode).toBe('transcription-failed');
    // The partial the user already saw is committed, never lost.
    expect(onLiveTranscript).toHaveBeenLastCalledWith('дуусаагүй хэсэг', 'final');
    expect(stopTrack).toHaveBeenCalled();
  });

  it('reports an empty transcript when stop returns nothing and no partial arrived', async () => {
    sttLiveMock.stop.invoke.mockResolvedValue({ text: '   ' });

    const { result } = renderSpeechInput({ onLiveTranscript: vi.fn() });

    await act(async () => {
      await result.current.startRecording();
    });
    await act(async () => {
      result.current.stopRecording();
    });

    await waitFor(() => {
      expect(result.current.status).toBe('error');
    });
    expect(result.current.errorCode).toBe('empty-transcript');
  });

  it('cancels the live session on unmount: mic released, main-side session aborted', async () => {
    const { result, unmount } = renderSpeechInput({ onLiveTranscript: vi.fn() });

    await act(async () => {
      await result.current.startRecording();
    });

    unmount();

    expect(offDeltaSpy).toHaveBeenCalled();
    expect(mockCaptureStop).toHaveBeenCalled();
    expect(stopTrack).toHaveBeenCalled();
    expect(sttLiveMock.cancel.invoke).toHaveBeenCalled();
  });

  it('keeps the batch MediaRecorder path EXACTLY as before for other providers', async () => {
    mocks.state.provider = 'openai';
    mockTranscribeAudioBlob.mockResolvedValueOnce({ text: 'batch result' });
    const onTranscript = vi.fn();

    const { result } = renderSpeechInput({ onTranscript });

    await act(async () => {
      await result.current.startRecording();
    });

    expect(result.current.status).toBe('recording');
    expect(sttLiveMock.start.invoke).not.toHaveBeenCalled();
    expect(MockMediaRecorder.instances).toHaveLength(1);

    await act(async () => {
      result.current.stopRecording();
    });
    await act(async () => {
      await Promise.resolve();
    });

    expect(mockTranscribeAudioBlob).toHaveBeenCalledTimes(1);
    expect(onTranscript).toHaveBeenCalledWith('batch result');
    expect(sttLiveMock.chunk.invoke).not.toHaveBeenCalled();
  });
});
