/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * resolveExternalReferencePath - the scoped confinement relaxation for the
 * drag-drop reference feature (owner decision 2026-08-08). Reference files may
 * be dragged from ANY folder, but the residual guards must still block the
 * worst abuses: unsafe path forms, `..` traversal, and sensitive credential
 * directories. Exercises the REAL function (no mocks) so the guard logic itself
 * is verified.
 */

import { describe, it, expect } from 'vitest';
import path from 'path';
import { resolveExternalReferencePath } from '@process/bridge/workspace/pathConfinement';

describe('resolveExternalReferencePath', () => {
  it('accepts an ordinary out-of-root content file (the relaxation)', () => {
    const p = path.resolve('/home/user/Documents/notes/brief.pdf');
    expect(resolveExternalReferencePath(p)).toBe(p);
  });

  it('accepts a Downloads-style path outside every app root', () => {
    const p = path.resolve('/home/user/Downloads/dataset.csv');
    expect(resolveExternalReferencePath(p)).toBe(p);
  });

  it('rejects a path through a sensitive credential dir (.ssh)', () => {
    expect(resolveExternalReferencePath('/home/user/.ssh/id_rsa')).toBeNull();
  });

  it('rejects .aws/.gnupg/.kube credential dirs', () => {
    expect(resolveExternalReferencePath('/home/user/.aws/credentials')).toBeNull();
    expect(resolveExternalReferencePath('/home/user/.gnupg/secring.gpg')).toBeNull();
    expect(resolveExternalReferencePath('/home/user/.kube/config')).toBeNull();
  });

  it('normalizes `..` (path.resolve), so a plain traversal just yields a normal path', () => {
    // There is no authorized root to escape here - the relaxation allows any
    // folder - so a normalized traversal to an ordinary location is accepted.
    expect(resolveExternalReferencePath('/home/user/docs/../notes/brief.pdf')).toBe(
      path.resolve('/home/user/notes/brief.pdf')
    );
  });

  it('still catches a `..` that resolves INTO a sensitive dir', () => {
    // /home/user/x/../.ssh/id_rsa -> /home/user/.ssh/id_rsa -> refused.
    expect(resolveExternalReferencePath('/home/user/x/../.ssh/id_rsa')).toBeNull();
  });

  it('rejects unsafe path forms (NUL, UNC, ADS)', () => {
    expect(resolveExternalReferencePath('/home/user/a\0b')).toBeNull();
    expect(resolveExternalReferencePath('\\\\server\\share\\secret')).toBeNull();
    expect(resolveExternalReferencePath('C:\\file.txt:hidden')).toBeNull();
  });

  it('rejects a non-string input (fail closed)', () => {
    expect(resolveExternalReferencePath(undefined)).toBeNull();
    expect(resolveExternalReferencePath(42)).toBeNull();
    expect(resolveExternalReferencePath('')).toBeNull();
  });

  it('does NOT realpath-collapse, so the caller lstat can still catch symlinks', () => {
    // The returned path is the lexically-resolved form, not a realpath. (A
    // realpath collapse would dereference a symlink before the caller's lstat
    // could reject it.) We assert idempotence: resolving the resolved path
    // yields the same value, i.e. no filesystem dereference happened.
    const p = path.resolve('/tmp/reference/file.md');
    const once = resolveExternalReferencePath(p);
    expect(once).toBe(p);
    expect(resolveExternalReferencePath(once as string)).toBe(p);
  });
});
