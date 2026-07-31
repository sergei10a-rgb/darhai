/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import type { IMcpServer } from '../../src/common/config/storage';
import { buildClaudeStdioJsonConfig } from '../../src/process/services/mcpServices/agents/ClaudeMcpAgent';
import { getMcpScriptPath } from '../../src/process/utils/mcpScriptDir';

describe('ClaudeMcpAgent helpers', () => {
  it('builds stdio MCP JSON config including env vars', () => {
    const server: IMcpServer = {
      id: 'builtin-image-gen',
      name: 'wayland-image-generation',
      enabled: true,
      transport: {
        type: 'stdio',
        command: 'node',
        args: ['/abs/builtin-mcp-image-gen.js'],
        env: {
          DARHAI_IMG_PLATFORM: 'openai',
          DARHAI_IMG_MODEL: 'gpt-image-1',
        },
      },
      createdAt: 1,
      updatedAt: 1,
      originalJson: '{}',
    };

    expect(JSON.parse(buildClaudeStdioJsonConfig(server))).toEqual({
      command: 'node',
      // The stored path does not exist, so the shared spawn-arg resolver
      // re-points a known builtin script at the current bundle dir. Writing a
      // dead path into the CLI's own config is the failure this prevents.
      args: [getMcpScriptPath('builtin-mcp-image-gen.js')],
      env: {
        DARHAI_IMG_PLATFORM: 'openai',
        DARHAI_IMG_MODEL: 'gpt-image-1',
      },
    });
  });
});
