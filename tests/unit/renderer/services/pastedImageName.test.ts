/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Pasting a second screenshot used to hand the agent the first one.
 *
 * Chromium names every clipboard image `image.png`. That name was kept as-is.
 * On disk a `_wayland_<ms>` suffix keeps the files apart - but that suffix is
 * stripped again before the path reaches the agent, so `image_wayland_A.png`
 * and `image_wayland_B.png` both arrive as `image.png` and the agent reads
 * whichever one it saw first. Nothing on screen suggested the wrong picture had
 * been read.
 *
 * Drag-drop was never affected: dropped files carry real names.
 */

import { describe, expect, it } from 'vitest';
import { buildPastedImageName, uniqueName } from '@renderer/services/PasteService';

describe('buildPastedImageName', () => {
  it('renames the generic clipboard name so two pastes cannot collapse', () => {
    const first = buildPastedImageName('image.png', '.png', '143000123', false);
    const second = buildPastedImageName('image.png', '.png', '143000456', false);

    expect(first).not.toBe('image.png');
    expect(first).not.toBe(second);
  });

  it('treats every generic image extension the same, in any case', () => {
    for (const name of ['image.png', 'image.jpg', 'image.webp', 'IMAGE.PNG']) {
      expect(buildPastedImageName(name, '.png', '143000123', false)).toBe('pasted_image_143000123.png');
    }
  });

  it('keeps a real name a dropped or copied file brought with it', () => {
    // This is the case that always worked; it has to keep working, or a
    // deliberate filename turns into an opaque timestamp.
    expect(buildPastedImageName('quarterly-chart.png', '.png', '143000123', false)).toBe('quarterly-chart.png');
    expect(buildPastedImageName('imagery.png', '.png', '143000123', false)).toBe('imagery.png');
    expect(buildPastedImageName('image-2.png', '.png', '143000123', false)).toBe('image-2.png');
  });

  it('still renames a screenshot tool name and a missing name', () => {
    expect(buildPastedImageName('Screenshot_2026-08-05_14-30-00.png', '.png', '143000123', true)).toBe(
      'pasted_image_143000123.png'
    );
    expect(buildPastedImageName(undefined, '.png', '143000123', false)).toBe('pasted_image_143000123.png');
    expect(buildPastedImageName('', '.png', '143000123', false)).toBe('pasted_image_143000123.png');
  });

  it('carries a millisecond stamp, so two pastes in one second differ', () => {
    // Seconds alone were not enough: a double paste lands inside one second.
    expect(buildPastedImageName('image.png', '.png', '143000123', false)).toBe('pasted_image_143000123.png');
  });
});

describe('uniqueName', () => {
  it('leaves a free name alone', () => {
    expect(uniqueName('a.png', '.png', new Set())).toBe('a.png');
  });

  it('suffixes until the name is free', () => {
    expect(uniqueName('a.png', '.png', new Set(['a.png']))).toBe('a_2.png');
    expect(uniqueName('a.png', '.png', new Set(['a.png', 'a_2.png', 'a_3.png']))).toBe('a_4.png');
  });

  it('handles a name with no extension of its own', () => {
    expect(uniqueName('README', '.txt', new Set(['README']))).toBe('README_2.txt');
  });

  it('does not treat a leading dot as an extension boundary', () => {
    // `.gitignore` is all name, no extension - splitting at index 0 would give
    // an empty base and produce `_2.gitignore`.
    expect(uniqueName('.gitignore', '.txt', new Set(['.gitignore']))).toBe('.gitignore_2.txt');
  });
});
