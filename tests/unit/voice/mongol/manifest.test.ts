/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * The Mongolian voice platform matrix.
 *
 * `mongolVoiceSupport` used to be a hardcoded `platform === 'win32' && arch ===
 * 'x64'` test; it is now derived from the platform-keyed asset table, so adding
 * macOS/Linux support is a manifest ROW, not a code change. These tests pin two
 * things: the win32-x64 answer is byte-for-byte what it was before the
 * refactor, and every unlisted platform stays an explicit "not yet".
 */

import { describe, expect, it } from 'vitest';
import {
  MONGOL_VOICE_ASSETS,
  MONGOL_VOICE_ASSETS_BY_PLATFORM,
  mongolVoiceSupport,
} from '@process/services/voice/mongol/manifest';

describe('mongolVoiceSupport - platform matrix', () => {
  it('answers stt+tts for win32/x64, exactly as before the refactor', () => {
    expect(mongolVoiceSupport('win32', 'x64')).toEqual({ stt: true, tts: true });
  });

  it('answers unsupported for every platform without a manifest row', () => {
    const unlisted: Array<[string, string]> = [
      ['win32', 'arm64'],
      ['darwin', 'arm64'],
      ['darwin', 'x64'],
      ['linux', 'x64'],
      ['linux', 'arm64'],
      ['freebsd', 'x64'],
    ];
    for (const [platform, arch] of unlisted) {
      expect(mongolVoiceSupport(platform, arch), `${platform}/${arch}`).toEqual({ stt: false, tts: false });
    }
  });

  it('derives support FROM the table, so a new row widens it without code', () => {
    // The win32-x64 row is the same object the provisioner installs from - one
    // source of truth, no second list that can drift.
    expect(MONGOL_VOICE_ASSETS_BY_PLATFORM['win32-x64']).toBe(MONGOL_VOICE_ASSETS);
  });

  it('keeps every published asset pinned: sha256 + size + url', () => {
    for (const row of Object.values(MONGOL_VOICE_ASSETS_BY_PLATFORM)) {
      for (const asset of row) {
        expect(asset.sha256, asset.tag).toMatch(/^[0-9a-f]{64}$/);
        expect(asset.bytes, asset.tag).toBeGreaterThan(0);
        expect(asset.url, asset.tag).toMatch(/^https:\/\//);
      }
    }
  });

  it('lists a complete voice core in every row: STT runtime + STT model + TTS bundle', () => {
    // A row missing a component would answer `stt: true` for a platform that
    // cannot actually transcribe - the table's shape is the guarantee.
    for (const [key, row] of Object.entries(MONGOL_VOICE_ASSETS_BY_PLATFORM)) {
      const components = row.map((a) => a.component);
      expect(components, key).toContain('stt-runtime');
      expect(components, key).toContain('stt-model');
      expect(components, key).toContain('tts-bundle');
    }
  });
});
