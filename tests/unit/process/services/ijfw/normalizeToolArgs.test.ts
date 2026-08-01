/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * `ijfw_memory_recall` requires `context_hint`; the bridge and renderer speak
 * `query`. Live A/B against the installed server: `{query:'Дархай'}` came back
 * `{ok:true, data:"No memories matching: undefined"}` - a recall that returned
 * nothing while reporting success - whereas `{context_hint:'Дархай'}` applied
 * the query. The mapping below is what makes the declared contract reach the
 * server intact.
 */

import { describe, it, expect } from 'vitest';
import { normalizeToolArgs } from '@process/services/ijfw/ijfwMcpClient';

describe('normalizeToolArgs', () => {
  it('maps memory_recall {query} onto the server-required context_hint', () => {
    expect(normalizeToolArgs('memory_recall', { query: 'Дархай' })).toEqual({ context_hint: 'Дархай' });
  });

  it('keeps an explicit context_hint and drops the redundant query alias', () => {
    expect(normalizeToolArgs('memory_recall', { query: 'ignored', context_hint: 'session_start' })).toEqual({
      context_hint: 'session_start',
    });
  });

  it('preserves the other recall arguments', () => {
    expect(
      normalizeToolArgs('memory_recall', { query: 'Дархай', detail_level: 'full', from_project: 'darhai' })
    ).toEqual({ context_hint: 'Дархай', detail_level: 'full', from_project: 'darhai' });
  });

  it('leaves other verbs untouched', () => {
    const args = { query: 'Дархай', k: 5 };
    expect(normalizeToolArgs('memory_search', args)).toBe(args);
  });

  it('leaves args untouched when there is no usable hint', () => {
    const args = { limit: 5 };
    expect(normalizeToolArgs('memory_recall', args)).toBe(args);
  });
});
