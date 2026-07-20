/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Map each backend's tool shape into the shared {@link NormalizedTool} so a
 * single ruleset evaluates identically for WCore and ACP. Pure functions, no
 * I/O: they only re-key fields and coerce untrusted values to `string`.
 */

import type { NormalizedTool } from './types';

/** ACP permission-request tool-call shape (subset of `AcpPermissionRequest`). */
export type AcpToolCallLike = {
  toolCallId?: string;
  title?: string;
  kind?: string;
  rawInput?: {
    command?: string;
    file_path?: unknown;
    path?: unknown;
    content?: unknown;
    [key: string]: unknown;
  };
};

/** WCore `tool_request` tool shape (subset of `ToolInfo`, args made optional). */
export type WCoreToolLike = {
  name: string;
  category?: string;
  args?: Record<string, unknown>;
  description?: string;
};

/** Return `value` only when it is a non-empty string, else `undefined`. */
function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/**
 * Normalize an ACP permission-request tool call. Maps `title -> toolName`,
 * `kind`, and pulls `command` / `file_path`|`path` / `content` out of
 * `rawInput`. Tolerant of a missing `rawInput` or non-string values.
 */
export function normalizeAcp(toolCall: AcpToolCallLike | undefined | null): NormalizedTool {
  const raw = toolCall?.rawInput ?? {};
  return {
    toolName: asString(toolCall?.title) ?? '',
    kind: asString(toolCall?.kind),
    command: asString(raw.command),
    filePath: asString(raw.file_path) ?? asString(raw.path),
    content: asString(raw.content),
  };
}

/**
 * Normalize a WCore tool request. Maps `name -> toolName`, `category`, and
 * pulls `command` / `file_path`|`path` / `content` out of `args`. Tolerant of
 * missing `args` or non-string values.
 */
export function normalizeWcore(tool: WCoreToolLike | undefined | null): NormalizedTool {
  const args = tool?.args ?? {};
  return {
    toolName: asString(tool?.name) ?? '',
    category: asString(tool?.category),
    command: asString(args.command),
    filePath: asString(args.file_path) ?? asString(args.path),
    content: asString(args.content),
  };
}
