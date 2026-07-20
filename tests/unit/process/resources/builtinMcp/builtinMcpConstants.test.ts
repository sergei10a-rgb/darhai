/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import {
  BUILTIN_SEARCH_SKILLS_ID,
  BUILTIN_SEARCH_SKILLS_NAME,
  BUILTIN_SEARCH_SKILLS_TOOL_NAME,
  BUILTIN_WEB_SEARCH_ID,
  BUILTIN_WEB_SEARCH_NAME,
  BUILTIN_WEB_SEARCH_TOOL_NAME,
  isBuiltinSearchSkillsName,
  isBuiltinSearchSkillsTransport,
  isBuiltinWebSearchName,
  isBuiltinWebSearchTransport,
} from '@process/resources/builtinMcp/constants';
import { WEB_SEARCH_PROVIDER_ENV_VAR } from '@process/resources/builtinMcp/webSearchServer';
import { TOOL_KEY_ENV_MAP } from '@process/agent/wcore/toolKeyStore';

describe('builtinMcp/constants - search-skills', () => {
  it('exposes the canonical id, server name, and MCP tool name', () => {
    expect(BUILTIN_SEARCH_SKILLS_ID).toBe('builtin-search-skills');
    expect(BUILTIN_SEARCH_SKILLS_NAME).toBe('wayland-search-skills');
    expect(BUILTIN_SEARCH_SKILLS_TOOL_NAME).toBe('wayland_search_skills');
  });

  describe('isBuiltinSearchSkillsName', () => {
    it('matches the canonical name', () => {
      expect(isBuiltinSearchSkillsName(BUILTIN_SEARCH_SKILLS_NAME)).toBe(true);
    });

    it('rejects other names', () => {
      expect(isBuiltinSearchSkillsName('wayland-image-generation')).toBe(false);
      expect(isBuiltinSearchSkillsName('some-user-mcp')).toBe(false);
      expect(isBuiltinSearchSkillsName(undefined)).toBe(false);
      expect(isBuiltinSearchSkillsName(null)).toBe(false);
      expect(isBuiltinSearchSkillsName('')).toBe(false);
    });
  });

  describe('isBuiltinSearchSkillsTransport', () => {
    it('matches a stdio node transport whose args include the bundle path', () => {
      expect(
        isBuiltinSearchSkillsTransport({
          type: 'stdio',
          command: 'node',
          args: ['/abs/path/to/out/main/builtin-mcp-search-skills.js'],
        })
      ).toBe(true);
    });

    it('rejects transports that target a different builtin bundle', () => {
      expect(
        isBuiltinSearchSkillsTransport({
          type: 'stdio',
          command: 'node',
          args: ['/abs/path/to/out/main/builtin-mcp-image-gen.js'],
        })
      ).toBe(false);
    });

    it('rejects http transports and non-node commands', () => {
      expect(
        isBuiltinSearchSkillsTransport({
          type: 'http',
          command: 'node',
          args: ['/whatever/builtin-mcp-search-skills.js'],
        })
      ).toBe(false);

      expect(
        isBuiltinSearchSkillsTransport({
          type: 'stdio',
          command: 'bun',
          args: ['/whatever/builtin-mcp-search-skills.js'],
        })
      ).toBe(false);
    });

    it('handles missing or empty args defensively', () => {
      expect(isBuiltinSearchSkillsTransport({ type: 'stdio', command: 'node' })).toBe(false);
      expect(isBuiltinSearchSkillsTransport({ type: 'stdio', command: 'node', args: [] })).toBe(false);
      expect(isBuiltinSearchSkillsTransport({ type: 'stdio', command: 'node', args: null })).toBe(false);
      expect(isBuiltinSearchSkillsTransport(undefined)).toBe(false);
    });
  });
});

describe('builtinMcp/constants - web-search', () => {
  it('exposes the canonical id, server name, and MCP tool name', () => {
    expect(BUILTIN_WEB_SEARCH_ID).toBe('builtin-web-search');
    expect(BUILTIN_WEB_SEARCH_NAME).toBe('wayland-web-search');
    expect(BUILTIN_WEB_SEARCH_TOOL_NAME).toBe('web_search');
  });

  describe('isBuiltinWebSearchName', () => {
    it('matches the canonical name and rejects others', () => {
      expect(isBuiltinWebSearchName(BUILTIN_WEB_SEARCH_NAME)).toBe(true);
      expect(isBuiltinWebSearchName('wayland-search-skills')).toBe(false);
      expect(isBuiltinWebSearchName(undefined)).toBe(false);
      expect(isBuiltinWebSearchName(null)).toBe(false);
      expect(isBuiltinWebSearchName('')).toBe(false);
    });
  });

  describe('isBuiltinWebSearchTransport', () => {
    it('matches a stdio node transport whose args include the bundle path', () => {
      expect(
        isBuiltinWebSearchTransport({
          type: 'stdio',
          command: 'node',
          args: ['/abs/path/to/out/main/builtin-mcp-web-search.js'],
        })
      ).toBe(true);
    });

    it('rejects other builtin bundles, non-node commands, and http transports', () => {
      expect(
        isBuiltinWebSearchTransport({
          type: 'stdio',
          command: 'node',
          args: ['/abs/path/to/out/main/builtin-mcp-search-skills.js'],
        })
      ).toBe(false);
      expect(
        isBuiltinWebSearchTransport({ type: 'stdio', command: 'bun', args: ['/x/builtin-mcp-web-search.js'] })
      ).toBe(false);
      expect(
        isBuiltinWebSearchTransport({ type: 'http', command: 'node', args: ['/x/builtin-mcp-web-search.js'] })
      ).toBe(false);
      expect(isBuiltinWebSearchTransport(undefined)).toBe(false);
    });
  });

  describe('provider env-var names do not drift from the tool-key store', () => {
    it('each web-search provider env var matches TOOL_KEY_ENV_MAP', () => {
      expect(WEB_SEARCH_PROVIDER_ENV_VAR.tavily).toBe(TOOL_KEY_ENV_MAP.tavily);
      expect(WEB_SEARCH_PROVIDER_ENV_VAR.brave).toBe(TOOL_KEY_ENV_MAP.brave);
      expect(WEB_SEARCH_PROVIDER_ENV_VAR.exa).toBe(TOOL_KEY_ENV_MAP.exa);
    });
  });
});
