/**
 * Pure DSP helpers behind the live-dictation PCM capture: linear resampling
 * to 16 kHz and Float32 -> s16le byte conversion. These feed the
 * `ipcBridge.sttLive.chunk` contract (raw 16 kHz mono s16le bytes), so the
 * byte-level shape is asserted here.
 */

import { describe, expect, it } from 'vitest';
import {
  LIVE_TARGET_SAMPLE_RATE,
  PCM_CAPTURE_WORKLET_NAME,
  PCM_CAPTURE_WORKLET_SOURCE,
  float32ToInt16LeBytes,
  resampleLinearFloat32,
} from '@/renderer/services/voice/livePcmCapture';

describe('resampleLinearFloat32', () => {
  it('returns the input untouched when rates already match (16k AudioContext fast path)', () => {
    const input = new Float32Array([0.1, -0.2, 0.3]);

    expect(resampleLinearFloat32(input, LIVE_TARGET_SAMPLE_RATE, LIVE_TARGET_SAMPLE_RATE)).toBe(input);
  });

  it('downsamples 48k -> 16k to one third the sample count (native-rate fallback)', () => {
    const input = new Float32Array(4800); // 100 ms at 48 kHz

    const output = resampleLinearFloat32(input, 48000, 16000);

    expect(output.length).toBe(1600); // 100 ms at 16 kHz
  });

  it('preserves the endpoints and interpolates between neighbours', () => {
    const input = new Float32Array([0, 1]);

    const output = resampleLinearFloat32(input, 2, 4);

    expect(output.length).toBe(4);
    expect(output[0]).toBeCloseTo(0);
    expect(output[output.length - 1]).toBeCloseTo(1);
    // Strictly increasing ramp - linear interpolation, not repetition.
    for (let i = 1; i < output.length; i++) {
      expect(output[i]).toBeGreaterThan(output[i - 1] ?? Number.POSITIVE_INFINITY);
    }
  });
});

describe('float32ToInt16LeBytes', () => {
  it('encodes little-endian signed 16-bit samples (the s16le wire contract)', () => {
    const bytes = float32ToInt16LeBytes(new Float32Array([0, 1, -1]));

    expect(bytes.length).toBe(6);
    const view = new DataView(bytes.buffer);
    expect(view.getInt16(0, true)).toBe(0);
    expect(view.getInt16(2, true)).toBe(0x7fff);
    expect(view.getInt16(4, true)).toBe(-0x8000);
  });

  it('clamps out-of-range samples instead of wrapping around', () => {
    const bytes = float32ToInt16LeBytes(new Float32Array([2.5, -2.5]));

    const view = new DataView(bytes.buffer);
    expect(view.getInt16(0, true)).toBe(0x7fff);
    expect(view.getInt16(2, true)).toBe(-0x8000);
  });

  it('is byte-order little-endian on the wire, not platform-dependent', () => {
    // 0.5 -> ~0x3FFF; low byte first proves explicit LE writes.
    const bytes = float32ToInt16LeBytes(new Float32Array([0.5]));

    const value = ((bytes[1] ?? 0) << 8) | (bytes[0] ?? 0);
    expect(value).toBe(Math.round(0.5 * 0x7fff));
  });
});

describe('PCM_CAPTURE_WORKLET_SOURCE', () => {
  it('registers the processor under the shared worklet name', () => {
    expect(PCM_CAPTURE_WORKLET_SOURCE).toContain(`registerProcessor('${PCM_CAPTURE_WORKLET_NAME}'`);
  });

  it('stays a dumb Float32 forwarder - no resampling or int16 math in worklet scope', () => {
    // All numeric processing must live renderer-side where it is testable.
    expect(PCM_CAPTURE_WORKLET_SOURCE).not.toContain('Int16');
    expect(PCM_CAPTURE_WORKLET_SOURCE).toContain('postMessage');
  });
});
