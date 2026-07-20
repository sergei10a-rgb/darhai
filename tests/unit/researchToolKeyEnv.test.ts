/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Drift-guard: the Deep Research loop reuses the `web_search` builtin + the
 * ToolKeyStore rail, so the tool ids it depends on (the search providers +
 * firecrawl) MUST stay valid keys of TOOL_KEY_ENV_MAP. If someone renames a tool
 * id in the store, this test fails instead of research silently losing its keys.
 */

import { describe, it, expect } from 'vitest';
import { TOOL_KEY_ENV_MAP } from '@process/agent/wcore/toolKeyStore';
import { WEB_SEARCH_PROVIDER_ENV_VAR, WEB_SEARCH_PROVIDER_ORDER } from '@process/resources/builtinMcp/webSearchServer';
import { RESEARCH_SCRAPE_KEY_ID, RESEARCH_SEARCH_KEY_IDS } from '@process/services/research/ResearchService';

describe('research tool-key ids stay in sync with TOOL_KEY_ENV_MAP', () => {
  it('every research search-key id is a valid ToolKeyStore id', () => {
    for (const id of RESEARCH_SEARCH_KEY_IDS) {
      expect(Object.prototype.hasOwnProperty.call(TOOL_KEY_ENV_MAP, id)).toBe(true);
    }
  });

  it('the firecrawl scrape id is a valid ToolKeyStore id', () => {
    expect(Object.prototype.hasOwnProperty.call(TOOL_KEY_ENV_MAP, RESEARCH_SCRAPE_KEY_ID)).toBe(true);
  });

  it('the research search ids match the web_search provider order exactly', () => {
    expect([...RESEARCH_SEARCH_KEY_IDS].toSorted()).toEqual([...WEB_SEARCH_PROVIDER_ORDER].toSorted());
  });

  it('each search id maps to the same env NAME in both maps (no drift)', () => {
    for (const id of RESEARCH_SEARCH_KEY_IDS) {
      expect(TOOL_KEY_ENV_MAP[id]).toBe(WEB_SEARCH_PROVIDER_ENV_VAR[id]);
    }
  });
});
