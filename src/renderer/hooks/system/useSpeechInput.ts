/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ipcBridge } from '@/common';
import { ConfigStorage } from '@/common/config/storage';
import { useLatestRef } from '@/renderer/hooks/ui/useLatestRef';
import { transcribeAudioBlob } from '@/renderer/services/SpeechToTextService';
import { startLivePcmCapture, type LivePcmCaptureSession } from '@/renderer/services/voice/livePcmCapture';
import { isElectronDesktop } from '@/renderer/utils/platform';

export type SpeechInputAvailability = 'record' | 'file' | 'unsupported';
/** `connecting` = live dictation is booting the local STT server (first boot can take seconds). */
export type SpeechInputStatus = 'idle' | 'connecting' | 'recording' | 'transcribing' | 'error';
/** Live dictation phases: partials REPLACE the live region; `final` commits it. */
export type SpeechLivePhase = 'partial' | 'final';
export type SpeechInputErrorCode =
  | 'aborted'
  | 'audio-capture'
  | 'empty-transcript'
  | 'file-too-large'
  | 'nemotron-not-installed'
  | 'nemotron-start-failed'
  | 'network'
  | 'not-configured'
  | 'permission-denied'
  | 'recording-unsupported'
  | 'transcription-failed'
  | 'unknown';

type SpeechInputEnvironment = {
  hasFileInput: boolean;
  hasMediaDevices: boolean;
  hasMediaRecorder: boolean;
  hostname: string;
  isElectronDesktop: boolean;
  isSecureContext: boolean;
};

type UseSpeechInputOptions = {
  locale?: string;
  onTranscript: (transcript: string) => void;
  /**
   * Live dictation stream (nemotron-mn only). Each `partial` carries the FULL
   * accumulated text so far - consumers must REPLACE their live region, never
   * append. `final` carries the cleaned stop text. When absent, the hook
   * falls back to a single `onTranscript` call at stop time.
   */
  onLiveTranscript?: (transcript: string, phase: SpeechLivePhase) => void;
};

const LOCAL_HOSTNAMES = new Set(['localhost', '127.0.0.1', '::1']);
const RECORDING_MIME_TYPES = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg;codecs=opus'];
const SPEECH_WAVEFORM_SAMPLE_COUNT = 40;
const SPEECH_WAVEFORM_MIN_LEVEL = 0.015;
const SPEECH_WAVEFORM_MAX_LEVEL = 1;
const SPEECH_VISUALIZER_INTERVAL_MS = 80;

const createInitialWaveformLevels = (): number[] =>
  Array.from({ length: SPEECH_WAVEFORM_SAMPLE_COUNT }, (_, index) => ((index + 1) % 6 === 0 ? 0.04 : 0.015));

const clampWaveformLevel = (value: number): number =>
  Math.max(SPEECH_WAVEFORM_MIN_LEVEL, Math.min(SPEECH_WAVEFORM_MAX_LEVEL, value));

const createNextWaveformLevels = (previous: number[], nextLevel: number): number[] => [
  ...previous.slice(1),
  clampWaveformLevel(nextLevel),
];

export const appendSpeechTranscript = (base: string, transcript: string): string => {
  const normalizedTranscript = transcript.trim();
  if (!normalizedTranscript) {
    return base;
  }

  const normalizedBase = base.trimEnd();
  if (!normalizedBase) {
    return normalizedTranscript;
  }

  return `${normalizedBase}\n${normalizedTranscript}`;
};

/**
 * Tracks WHERE the live-dictation text sits inside the input so each partial
 * can REPLACE it without touching text the user typed around it.
 */
export type SpeechLiveInsertState = {
  /** Text before the live region (separator included). */
  prefix: string;
  /** Text after the live region (anything the user typed behind it). */
  suffix: string;
  /** The live transcript last written into the input. */
  transcript: string;
  /** The full input value this helper last produced. */
  appliedValue: string;
};

/**
 * Compute the next input value for a live-dictation partial/final.
 *
 * Contract (mirrors sttLive.onDelta): `nextTranscript` is the FULL
 * accumulated text - it REPLACES the live region, never appends to it.
 * User edits made while streaming are preserved: if the current value no
 * longer matches what we last wrote, the live region is re-located via
 * `lastIndexOf` (keeping the user's prefix/suffix), and if the user deleted
 * the streamed text entirely we re-append at the end - the same separator
 * rule as {@link appendSpeechTranscript}.
 */
export const applySpeechLiveTranscript = (
  state: SpeechLiveInsertState | null,
  currentValue: string,
  nextTranscript: string
): { nextValue: string; nextState: SpeechLiveInsertState | null } => {
  const transcript = nextTranscript.trim();
  if (!transcript) {
    // Nothing recognized yet - leave the input untouched and let the first
    // non-empty partial anchor the live region.
    return { nextValue: currentValue, nextState: state };
  }

  let prefix: string;
  let suffix: string;
  if (state && currentValue === state.appliedValue) {
    // Fast path: nobody touched the input since our last write.
    prefix = state.prefix;
    suffix = state.suffix;
  } else if (state && state.transcript && currentValue.lastIndexOf(state.transcript) >= 0) {
    // The user edited around the live region - re-locate it.
    const index = currentValue.lastIndexOf(state.transcript);
    prefix = currentValue.slice(0, index);
    suffix = currentValue.slice(index + state.transcript.length);
  } else {
    // New session, or the user deleted the streamed text - append at the end.
    const base = currentValue.trimEnd();
    prefix = base ? `${base}\n` : '';
    suffix = '';
  }

  const nextValue = `${prefix}${transcript}${suffix}`;
  return { nextValue, nextState: { prefix, suffix, transcript, appliedValue: nextValue } };
};

/**
 * Build a stateful `(transcript, phase)` handler that wires
 * {@link applySpeechLiveTranscript} to an input's read/write pair. `final`
 * commits the region: the internal state resets so the next dictation
 * session can never overwrite previously committed text.
 */
export const createSpeechLiveTranscriptHandler = (deps: {
  getCurrentValue: () => string;
  setValue: (value: string) => void;
}): ((transcript: string, phase: SpeechLivePhase) => void) => {
  let state: SpeechLiveInsertState | null = null;
  return (transcript, phase) => {
    const currentValue = deps.getCurrentValue();
    const result = applySpeechLiveTranscript(state, currentValue, transcript);
    state = phase === 'final' ? null : result.nextState;
    if (result.nextValue !== currentValue) {
      deps.setValue(result.nextValue);
    }
  };
};

const getSpeechInputEnvironment = (): SpeechInputEnvironment => {
  if (typeof window === 'undefined' || typeof document === 'undefined') {
    return {
      hasFileInput: false,
      hasMediaDevices: false,
      hasMediaRecorder: false,
      hostname: '',
      isElectronDesktop: false,
      isSecureContext: false,
    };
  }

  return {
    hasFileInput: typeof document.createElement === 'function',
    hasMediaDevices: typeof navigator !== 'undefined' && Boolean(navigator.mediaDevices?.getUserMedia),
    hasMediaRecorder: typeof MediaRecorder !== 'undefined',
    hostname: window.location.hostname,
    isElectronDesktop: isElectronDesktop(),
    isSecureContext: window.isSecureContext,
  };
};

export const getSpeechInputAvailabilityForEnvironment = (
  environment: SpeechInputEnvironment
): SpeechInputAvailability => {
  const canUseLiveRecording =
    environment.hasMediaDevices &&
    environment.hasMediaRecorder &&
    (environment.isElectronDesktop || environment.isSecureContext || LOCAL_HOSTNAMES.has(environment.hostname));

  if (canUseLiveRecording) {
    return 'record';
  }

  if (environment.hasFileInput) {
    return 'file';
  }

  return 'unsupported';
};

export const getSpeechInputAvailability = (): SpeechInputAvailability => {
  return getSpeechInputAvailabilityForEnvironment(getSpeechInputEnvironment());
};

export const pickRecordingMimeType = (): string => {
  if (typeof MediaRecorder === 'undefined' || typeof MediaRecorder.isTypeSupported !== 'function') {
    return '';
  }

  return RECORDING_MIME_TYPES.find((mimeType) => MediaRecorder.isTypeSupported(mimeType)) || '';
};

/**
 * Serialized STT error -> stable UI code. Typed codes travel across IPC as
 * the error MESSAGE prefix (`${code}: ${detail}`), so substring matching is
 * the contract. Exported for direct unit testing of the mapping table.
 */
export const mapSpeechInputError = (error: unknown): SpeechInputErrorCode => {
  if (error instanceof DOMException) {
    switch (error.name) {
      case 'NotAllowedError':
      case 'SecurityError':
        return 'permission-denied';
      case 'NotFoundError':
      case 'DevicesNotFoundError':
        return 'audio-capture';
      case 'AbortError':
        return 'aborted';
      default:
        return 'unknown';
    }
  }

  const message = error instanceof Error ? error.message : String(error);

  if (
    message.includes('STT_OPENAI_NOT_CONFIGURED') ||
    message.includes('STT_DEEPGRAM_NOT_CONFIGURED') ||
    message.includes('STT_DISABLED')
  ) {
    return 'not-configured';
  }
  // Nemotron Mongolian STT (AudioCppServer / NemotronStt typed codes): the
  // missing-install case gets its own code so the toast can point at the
  // install card instead of a generic "voice input failed".
  if (message.includes('NEMOTRON_MN_NOT_INSTALLED')) {
    return 'nemotron-not-installed';
  }
  if (message.includes('NEMOTRON_MN_START_FAILED') || message.includes('NEMOTRON_MN_START_TIMEOUT')) {
    return 'nemotron-start-failed';
  }
  if (
    message.includes('NEMOTRON_MN_REQUEST_FAILED') ||
    message.includes('NEMOTRON_MN_FFMPEG_MISSING') ||
    message.includes('NEMOTRON_MN_AUDIO_CONVERT_FAILED') ||
    // Live-dictation session errors (sttLive bridge): the stream dropped or a
    // verb hit a session that is no longer open. Both surface as a normal
    // "transcription failed" toast - the partial text already shown is kept.
    message.includes('NEMOTRON_MN_LIVE_FAILED') ||
    message.includes('NEMOTRON_MN_LIVE_NOT_ACTIVE')
  ) {
    return 'transcription-failed';
  }
  if (message.includes('STT_FILE_TOO_LARGE')) {
    return 'file-too-large';
  }
  if (message.includes('STT_NETWORK_ERROR')) {
    return 'network';
  }
  if (message.includes('STT_ABORTED')) {
    return 'aborted';
  }
  if (message.includes('STT_REQUEST_FAILED')) {
    return 'transcription-failed';
  }

  return 'unknown';
};

/** One in-flight live dictation session (nemotron-mn path). */
type LiveDictationSession = {
  stream: MediaStream;
  capture: LivePcmCaptureSession | null;
  offDelta: (() => void) | null;
  /** Last partial pushed through onDelta - the stop-failure fallback text. */
  lastPartial: string;
  /** Set once the session is cancelled/stopped so late awaits become no-ops. */
  finished: boolean;
};

export const useSpeechInput = ({ locale, onTranscript, onLiveTranscript }: UseSpeechInputOptions) => {
  const [status, setStatus] = useState<SpeechInputStatus>('idle');
  const [errorCode, setErrorCode] = useState<SpeechInputErrorCode | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [recordingDurationMs, setRecordingDurationMs] = useState(0);
  const [recordingLevels, setRecordingLevels] = useState<number[]>(() => createInitialWaveformLevels());
  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const liveSessionRef = useRef<LiveDictationSession | null>(null);
  const recordingStartedAtRef = useRef<number | null>(null);
  const visualizerIntervalRef = useRef<number | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const mediaSourceRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const analyserDataRef = useRef<Uint8Array<ArrayBuffer> | null>(null);
  const onTranscriptRef = useLatestRef(onTranscript);
  const onLiveTranscriptRef = useLatestRef(onLiveTranscript);
  const availability = useMemo(() => getSpeechInputAvailability(), []);

  const recognitionLocale = locale?.trim() || 'en-US';

  const pauseSpeechVisualizer = useCallback(() => {
    if (visualizerIntervalRef.current !== null) {
      window.clearInterval(visualizerIntervalRef.current);
      visualizerIntervalRef.current = null;
    }
  }, []);

  const resetSpeechVisualizer = useCallback(() => {
    pauseSpeechVisualizer();
    recordingStartedAtRef.current = null;
    setRecordingDurationMs(0);
    setRecordingLevels(createInitialWaveformLevels());
  }, [pauseSpeechVisualizer]);

  const cleanupAudioAnalysis = useCallback(async () => {
    if (mediaSourceRef.current) {
      try {
        mediaSourceRef.current.disconnect();
      } catch {
        // Ignore disconnect failures during teardown.
      }
      mediaSourceRef.current = null;
    }

    if (analyserRef.current) {
      try {
        analyserRef.current.disconnect();
      } catch {
        // Ignore disconnect failures during teardown.
      }
      analyserRef.current = null;
    }

    analyserDataRef.current = null;

    if (audioContextRef.current) {
      try {
        await audioContextRef.current.close();
      } catch {
        // Ignore close failures during teardown.
      }
      audioContextRef.current = null;
    }
  }, []);

  const startSpeechVisualizer = useCallback(
    async (stream: MediaStream) => {
      resetSpeechVisualizer();
      recordingStartedAtRef.current = Date.now();

      const AudioContextCtor =
        typeof AudioContext !== 'undefined'
          ? AudioContext
          : typeof window !== 'undefined'
            ? (window as Window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
            : undefined;

      if (AudioContextCtor) {
        try {
          const audioContext = new AudioContextCtor();
          const analyser = audioContext.createAnalyser();
          analyser.fftSize = 128;
          analyser.smoothingTimeConstant = 0.82;
          const source = audioContext.createMediaStreamSource(stream);
          source.connect(analyser);
          audioContextRef.current = audioContext;
          analyserRef.current = analyser;
          mediaSourceRef.current = source;
          analyserDataRef.current = new Uint8Array(analyser.fftSize);
        } catch {
          void cleanupAudioAnalysis();
        }
      }

      visualizerIntervalRef.current = window.setInterval(() => {
        const startedAt = recordingStartedAtRef.current;
        if (startedAt) {
          setRecordingDurationMs(Date.now() - startedAt);
        }

        const analyser = analyserRef.current;
        const analyserData = analyserDataRef.current;
        if (!analyser || !analyserData) {
          setRecordingLevels((previous) => createNextWaveformLevels(previous, SPEECH_WAVEFORM_MIN_LEVEL));
          return;
        }

        analyser.getByteTimeDomainData(analyserData);
        let sum = 0;
        for (const sample of analyserData) {
          const normalized = (sample - 128) / 128;
          sum += normalized * normalized;
        }

        const rms = Math.sqrt(sum / analyserData.length);
        const scaledLevel = clampWaveformLevel(rms * 5.6);
        setRecordingLevels((previous) => createNextWaveformLevels(previous, scaledLevel));
      }, SPEECH_VISUALIZER_INTERVAL_MS);
    },
    [cleanupAudioAnalysis, resetSpeechVisualizer]
  );

  const cleanupRecorder = useCallback(() => {
    pauseSpeechVisualizer();
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((track) => track.stop());
      streamRef.current = null;
    }
    recorderRef.current = null;
    chunksRef.current = [];
    void cleanupAudioAnalysis();
  }, [cleanupAudioAnalysis, pauseSpeechVisualizer]);

  const clearError = useCallback(() => {
    setErrorCode(null);
    setErrorMessage(null);
    setStatus('idle');
    resetSpeechVisualizer();
  }, [resetSpeechVisualizer]);

  const transcribeBlob = useCallback(
    async (blob: Blob) => {
      try {
        setStatus('transcribing');
        setErrorCode(null);
        setErrorMessage(null);
        const result = await transcribeAudioBlob(blob, recognitionLocale);
        const transcript = result.text.trim();
        if (!transcript) {
          setErrorCode('empty-transcript');
          setErrorMessage(null);
          setStatus('error');
          resetSpeechVisualizer();
          return;
        }
        onTranscriptRef.current(transcript);
        setStatus('idle');
        resetSpeechVisualizer();
      } catch (error) {
        setErrorCode(mapSpeechInputError(error));
        const message = error instanceof Error ? error.message : String(error);
        setErrorMessage(
          message.startsWith('STT_REQUEST_FAILED:') ? message.replace('STT_REQUEST_FAILED:', '').trim() : null
        );
        setStatus('error');
        resetSpeechVisualizer();
      }
    },
    [onTranscriptRef, recognitionLocale, resetSpeechVisualizer]
  );

  /** Commit the final live text: replace the live region, or append when no live consumer is wired. */
  const emitFinalLiveTranscript = useCallback(
    (transcript: string) => {
      if (onLiveTranscriptRef.current) {
        onLiveTranscriptRef.current(transcript, 'final');
      } else {
        onTranscriptRef.current(transcript);
      }
    },
    [onLiveTranscriptRef, onTranscriptRef]
  );

  /** Release renderer-side live resources (mic, delta subscription, visualizer). */
  const releaseLiveSessionMedia = useCallback(
    (session: LiveDictationSession) => {
      session.finished = true;
      if (liveSessionRef.current === session) {
        liveSessionRef.current = null;
      }
      session.offDelta?.();
      session.offDelta = null;
      session.stream.getTracks().forEach((track) => track.stop());
      if (streamRef.current === session.stream) {
        streamRef.current = null;
      }
      pauseSpeechVisualizer();
      void cleanupAudioAnalysis();
    },
    [cleanupAudioAnalysis, pauseSpeechVisualizer]
  );

  /**
   * Live dictation (nemotron-mn): raw 16 kHz mono s16le PCM streams over
   * `ipcBridge.sttLive` while partials replace the input's live region.
   * MediaRecorder is not used - it compresses to opus (see livePcmCapture).
   */
  const startLiveDictation = useCallback(async () => {
    setErrorCode(null);
    setErrorMessage(null);
    setStatus('connecting');

    const session: LiveDictationSession = {
      stream: null as unknown as MediaStream,
      capture: null,
      offDelta: null,
      lastPartial: '',
      finished: false,
    };

    try {
      // Mic first: a denied permission must not boot the STT server.
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      session.stream = stream;
      streamRef.current = stream;
      liveSessionRef.current = session;

      // First boot can take seconds - the 'connecting' spinner covers it.
      // A new start cancels any stale session on the main side by contract.
      await ipcBridge.sttLive.start.invoke();
      if (session.finished) {
        // Unmounted / cancelled while the server was booting.
        void ipcBridge.sttLive.cancel.invoke().catch((): undefined => undefined);
        return;
      }

      session.offDelta = ipcBridge.sttLive.onDelta.on(({ text }) => {
        if (session.finished) {
          return;
        }
        // FULL accumulated partial - consumers replace, never append.
        session.lastPartial = text;
        onLiveTranscriptRef.current?.(text, 'partial');
      });

      session.capture = await startLivePcmCapture({
        stream,
        onChunk: (pcmBytes) => {
          if (session.finished) {
            return;
          }
          ipcBridge.sttLive.chunk.invoke({ data: Array.from(pcmBytes) }).catch((error) => {
            // Do not kill the session here: stop() resolves with the main
            // process's batch fallback even when the live stream degraded.
            console.warn('[speech-live] chunk delivery failed', error);
          });
        },
      });
      if (session.finished) {
        void session.capture.stop().catch((): undefined => undefined);
        void ipcBridge.sttLive.cancel.invoke().catch((): undefined => undefined);
        return;
      }

      await startSpeechVisualizer(stream);
      setStatus('recording');
    } catch (error) {
      if (session.capture) {
        void session.capture.stop().catch((): undefined => undefined);
        session.capture = null;
      }
      if (session.stream) {
        releaseLiveSessionMedia(session);
      } else if (liveSessionRef.current === session) {
        liveSessionRef.current = null;
      }
      void ipcBridge.sttLive.cancel.invoke().catch((): undefined => undefined);
      setErrorCode(mapSpeechInputError(error));
      setErrorMessage(null);
      setStatus('error');
      resetSpeechVisualizer();
    }
  }, [onLiveTranscriptRef, releaseLiveSessionMedia, resetSpeechVisualizer, startSpeechVisualizer]);

  const stopLiveDictation = useCallback(async () => {
    const session = liveSessionRef.current;
    if (!session) {
      return;
    }
    liveSessionRef.current = null;
    setStatus('transcribing');
    pauseSpeechVisualizer();

    try {
      // Flush the buffered tail BEFORE the stop verb so the final chunks
      // precede it on the (FIFO) bridge.
      if (session.capture) {
        await session.capture.stop().catch((): undefined => undefined);
        session.capture = null;
      }
      const { text } = await ipcBridge.sttLive.stop.invoke();
      releaseLiveSessionMedia(session);

      const transcript = text.trim();
      const fallback = session.lastPartial.trim();
      if (transcript) {
        emitFinalLiveTranscript(transcript);
      } else if (fallback) {
        // Stop returned nothing - keep what streaming already showed, and
        // commit it so the next session cannot overwrite it.
        emitFinalLiveTranscript(fallback);
      } else {
        setErrorCode('empty-transcript');
        setErrorMessage(null);
        setStatus('error');
        resetSpeechVisualizer();
        return;
      }
      setStatus('idle');
      resetSpeechVisualizer();
    } catch (error) {
      releaseLiveSessionMedia(session);
      // Anchor the partial text already in the input so the next session
      // cannot overwrite it, then surface the failure as a toast.
      const fallback = session.lastPartial.trim();
      if (fallback && onLiveTranscriptRef.current) {
        onLiveTranscriptRef.current(fallback, 'final');
      }
      setErrorCode(mapSpeechInputError(error));
      setErrorMessage(null);
      setStatus('error');
      resetSpeechVisualizer();
    }
  }, [
    emitFinalLiveTranscript,
    onLiveTranscriptRef,
    pauseSpeechVisualizer,
    releaseLiveSessionMedia,
    resetSpeechVisualizer,
  ]);

  const startRecording = useCallback(async () => {
    if (availability !== 'record') {
      setErrorCode('recording-unsupported');
      setStatus('error');
      return;
    }

    // nemotron-mn on desktop takes the live-dictation path; every other
    // provider (openai / deepgram / whisper-local) keeps the batch path
    // EXACTLY as before. The web build also stays on batch: sttLive needs
    // the local audio server, which only the desktop main process owns.
    if (isElectronDesktop()) {
      const sttConfig = await ConfigStorage.get('tools.speechToText').catch((): undefined => undefined);
      if (sttConfig?.provider === 'nemotron-mn') {
        await startLiveDictation();
        return;
      }
    }

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mimeType = pickRecordingMimeType();
      const recorder = mimeType ? new MediaRecorder(stream, { mimeType }) : new MediaRecorder(stream);

      streamRef.current = stream;
      recorderRef.current = recorder;
      chunksRef.current = [];
      await startSpeechVisualizer(stream);

      recorder.ondataavailable = (event) => {
        if (event.data.size > 0) {
          chunksRef.current.push(event.data);
        }
      };

      recorder.onerror = () => {
        cleanupRecorder();
        setErrorCode('unknown');
        setStatus('error');
      };

      recorder.onstop = () => {
        const audioBlob = new Blob(chunksRef.current, {
          type: recorder.mimeType || mimeType || 'audio/webm',
        });
        cleanupRecorder();
        void transcribeBlob(audioBlob);
      };

      setErrorCode(null);
      setErrorMessage(null);
      setStatus('recording');
      recorder.start();
    } catch (error) {
      cleanupRecorder();
      setErrorCode(mapSpeechInputError(error));
      setErrorMessage(null);
      setStatus('error');
      resetSpeechVisualizer();
    }
  }, [availability, cleanupRecorder, resetSpeechVisualizer, startLiveDictation, startSpeechVisualizer, transcribeBlob]);

  const stopRecording = useCallback(() => {
    if (liveSessionRef.current) {
      if (status === 'recording') {
        void stopLiveDictation();
      }
      return;
    }

    const recorder = recorderRef.current;
    if (!recorder || status !== 'recording') {
      return;
    }

    setStatus('transcribing');
    recorder.stop();
  }, [status, stopLiveDictation]);

  const transcribeFile = useCallback(
    async (file: Blob) => {
      await transcribeBlob(file);
    },
    [transcribeBlob]
  );

  useEffect(() => {
    return () => {
      // Live dictation: abort the session and discard buffered audio. The mic
      // tracks and AudioContext are released; main drops its session state.
      const liveSession = liveSessionRef.current;
      if (liveSession) {
        liveSessionRef.current = null;
        liveSession.finished = true;
        liveSession.offDelta?.();
        if (liveSession.capture) {
          void liveSession.capture.stop().catch((): undefined => undefined);
        }
        liveSession.stream?.getTracks().forEach((track) => track.stop());
        void ipcBridge.sttLive.cancel.invoke().catch((): undefined => undefined);
      }

      const recorder = recorderRef.current;
      if (recorder) {
        recorder.ondataavailable = null;
        recorder.onerror = null;
        recorder.onstop = null;
      }
      if (recorder?.state !== 'inactive') {
        try {
          recorder.stop();
        } catch {
          // Ignore teardown failures from partially started recording sessions.
        }
      }
      cleanupRecorder();
    };
  }, [cleanupRecorder]);

  return {
    availability,
    clearError,
    errorCode,
    errorMessage,
    recordingDurationMs,
    recordingLevels,
    startRecording,
    status,
    stopRecording,
    transcribeFile,
  };
};
