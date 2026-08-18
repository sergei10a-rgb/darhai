/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Raw-PCM microphone capture for live Mongolian dictation.
 *
 * MediaRecorder is deliberately NOT used here: it emits opus-compressed
 * containers, while the `ipcBridge.sttLive.chunk` contract wants raw
 * 16 kHz mono s16le bytes. Instead an AudioWorklet taps the microphone
 * graph and posts Float32 sample batches to the main thread, where they
 * are (linearly) resampled to 16 kHz and converted to s16le.
 *
 * The worklet itself is registered from an inline Blob URL - it stays a
 * dumb sample forwarder so ALL numeric processing lives in this module
 * where it is unit-testable (the worklet scope cannot import from the
 * renderer bundle).
 *
 * Native-rate fallback: `new AudioContext({ sampleRate: 16000 })` is
 * attempted first (Chromium resamples internally); if the platform
 * refuses or reports a different rate, the context's real rate is used
 * as the resampler source rate.
 */

export const LIVE_TARGET_SAMPLE_RATE = 16000;
/** One IPC chunk every ~200 ms keeps latency low without spamming the bridge. */
export const LIVE_CHUNK_MS = 200;

export const PCM_CAPTURE_WORKLET_NAME = 'darhai-pcm-capture';

/**
 * AudioWorklet processor source (worklet global scope - plain JS string).
 * Collects 128-frame render quanta and posts ~50 ms Float32 batches so the
 * port traffic stays low. All resampling/int16 conversion happens on the
 * receiving side.
 */
export const PCM_CAPTURE_WORKLET_SOURCE = `
class DarhaiPcmCaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this._parts = [];
    this._length = 0;
    // ~50ms of samples at the context rate ("sampleRate" is a worklet global).
    this._batchSize = Math.max(128, Math.round(sampleRate / 20));
  }
  process(inputs) {
    const channel = inputs[0] && inputs[0][0];
    if (channel && channel.length > 0) {
      this._parts.push(new Float32Array(channel));
      this._length += channel.length;
      if (this._length >= this._batchSize) {
        const joined = new Float32Array(this._length);
        let offset = 0;
        for (const part of this._parts) {
          joined.set(part, offset);
          offset += part.length;
        }
        this._parts = [];
        this._length = 0;
        this.port.postMessage(joined, [joined.buffer]);
      }
    }
    return true;
  }
}
registerProcessor('${PCM_CAPTURE_WORKLET_NAME}', DarhaiPcmCaptureProcessor);
`;

/**
 * Linear-interpolation resampler. Identity when the rates already match.
 * Quality is sufficient for speech ASR input (the Дуут бичээч lesson:
 * a correct native-rate fallback beats a perfect but absent one).
 */
export const resampleLinearFloat32 = (input: Float32Array, sourceRate: number, targetRate: number): Float32Array => {
  if (sourceRate === targetRate || input.length === 0) {
    return input;
  }
  const outputLength = Math.max(1, Math.round((input.length * targetRate) / sourceRate));
  const output = new Float32Array(outputLength);
  const step = outputLength > 1 ? (input.length - 1) / (outputLength - 1) : 0;
  for (let i = 0; i < outputLength; i++) {
    const position = i * step;
    const index = Math.floor(position);
    const fraction = position - index;
    const nextIndex = Math.min(index + 1, input.length - 1);
    output[i] = (input[index] ?? 0) * (1 - fraction) + (input[nextIndex] ?? 0) * fraction;
  }
  return output;
};

/** Float32 [-1, 1] samples -> little-endian signed 16-bit PCM bytes (s16le). */
export const float32ToInt16LeBytes = (samples: Float32Array): Uint8Array => {
  const bytes = new Uint8Array(samples.length * 2);
  const view = new DataView(bytes.buffer);
  for (let i = 0; i < samples.length; i++) {
    const clamped = Math.max(-1, Math.min(1, samples[i] ?? 0));
    const value = clamped < 0 ? Math.round(clamped * 0x8000) : Math.round(clamped * 0x7fff);
    view.setInt16(i * 2, value, true);
  }
  return bytes;
};

export type LivePcmCaptureSession = {
  /**
   * Tear down the capture graph. Flushes the buffered tail through
   * `onChunk` BEFORE resolving, so callers can order their final network
   * verb after the last audio chunk.
   */
  stop: () => Promise<void>;
};

type StartLivePcmCaptureOptions = {
  stream: MediaStream;
  /** Called with raw 16 kHz mono s16le bytes, ~every {@link LIVE_CHUNK_MS}. */
  onChunk: (pcmBytes: Uint8Array) => void;
};

/**
 * Start capturing raw PCM from a microphone stream.
 * Rejects when the platform has no AudioWorklet support.
 */
export const startLivePcmCapture = async (options: StartLivePcmCaptureOptions): Promise<LivePcmCaptureSession> => {
  let context: AudioContext;
  try {
    context = new AudioContext({ sampleRate: LIVE_TARGET_SAMPLE_RATE });
  } catch {
    // Some platforms refuse a forced rate - fall back to the native rate and
    // let the resampler bridge the difference.
    context = new AudioContext();
  }
  const sourceRate = context.sampleRate;

  const workletUrl = URL.createObjectURL(new Blob([PCM_CAPTURE_WORKLET_SOURCE], { type: 'application/javascript' }));
  try {
    await context.audioWorklet.addModule(workletUrl);
  } catch (error) {
    URL.revokeObjectURL(workletUrl);
    await context.close().catch((): undefined => undefined);
    throw error;
  }
  URL.revokeObjectURL(workletUrl);

  const source = context.createMediaStreamSource(options.stream);
  const workletNode = new AudioWorkletNode(context, PCM_CAPTURE_WORKLET_NAME, {
    numberOfInputs: 1,
    numberOfOutputs: 1,
    outputChannelCount: [1],
  });
  // A muted sink keeps the graph pulled without echoing the mic to speakers.
  const silentGain = context.createGain();
  silentGain.gain.value = 0;
  source.connect(workletNode);
  workletNode.connect(silentGain);
  silentGain.connect(context.destination);

  const chunkSamples = Math.max(1, Math.round((sourceRate * LIVE_CHUNK_MS) / 1000));
  let parts: Float32Array[] = [];
  let bufferedSamples = 0;
  let stopped = false;

  const flush = (includePartialTail: boolean) => {
    if (bufferedSamples === 0 || (!includePartialTail && bufferedSamples < chunkSamples)) {
      return;
    }
    const joined = new Float32Array(bufferedSamples);
    let offset = 0;
    for (const part of parts) {
      joined.set(part, offset);
      offset += part.length;
    }
    parts = [];
    bufferedSamples = 0;
    const resampled = resampleLinearFloat32(joined, sourceRate, LIVE_TARGET_SAMPLE_RATE);
    const bytes = float32ToInt16LeBytes(resampled);
    if (bytes.length > 0) {
      options.onChunk(bytes);
    }
  };

  const handlePortMessage = (event: MessageEvent) => {
    if (stopped) {
      return;
    }
    const samples: unknown = event.data;
    if (!(samples instanceof Float32Array) || samples.length === 0) {
      return;
    }
    parts.push(samples);
    bufferedSamples += samples.length;
    flush(false);
  };
  workletNode.port.addEventListener('message', handlePortMessage);
  // addEventListener (unlike onmessage) does not auto-start the port.
  workletNode.port.start();

  const stop = async (): Promise<void> => {
    if (stopped) {
      return;
    }
    stopped = true;
    workletNode.port.removeEventListener('message', handlePortMessage);
    // Flush the remaining tail synchronously so the last spoken word is not
    // dropped between the final chunk and the stop verb.
    flush(true);
    try {
      source.disconnect();
    } catch {
      // Ignore teardown failures from partially wired graphs.
    }
    try {
      workletNode.disconnect();
    } catch {
      // Ignore teardown failures from partially wired graphs.
    }
    try {
      silentGain.disconnect();
    } catch {
      // Ignore teardown failures from partially wired graphs.
    }
    await context.close().catch((): undefined => undefined);
  };

  return { stop };
};
