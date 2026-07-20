/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

// Keep these constants local to avoid pulling in common/config/storage side effects
// when a built-in MCP server boots in a standalone stdio process.
export const BUILTIN_IMAGE_GEN_ID = 'builtin-image-gen';
export const BUILTIN_IMAGE_GEN_NAME = 'darhai-image-generation';
// Legacy display names that existing (shipped) user configs may still carry.
// Kept so `isBuiltinImageGenName` and the catalog migration resolve old entries
// to the current name instead of duplicating them. Do NOT rename these strings.
export const BUILTIN_IMAGE_GEN_LEGACY_NAMES = [
  'Wayland Image Generation',
  'wayland-image-generation',
  BUILTIN_IMAGE_GEN_ID,
] as const;

export const BUILTIN_SEARCH_SKILLS_ID = 'builtin-search-skills';
export const BUILTIN_SEARCH_SKILLS_NAME = 'darhai-search-skills';
export const BUILTIN_SEARCH_SKILLS_TOOL_NAME = 'darhai_search_skills';
// Legacy display names carried by shipped user configs. Do NOT rename these
// strings - they exist to match pre-rename entries during catalog migration.
export const BUILTIN_SEARCH_SKILLS_LEGACY_NAMES = ['wayland-search-skills', BUILTIN_SEARCH_SKILLS_ID] as const;

export const BUILTIN_WEB_SEARCH_ID = 'builtin-web-search';
export const BUILTIN_WEB_SEARCH_NAME = 'darhai-web-search';
export const BUILTIN_WEB_SEARCH_TOOL_NAME = 'web_search';

// Bundled @darhai MCP servers shipped with the installer (no npm publish).
// Each catalog entry's transport stores the bare filename as args[0]; the
// spawn layer rewrites it to an absolute path via `getMcpScriptPath()`.
export const BUILTIN_DARHAI_APPLE_NAME = 'com.darhai/apple-mcp';
export const BUILTIN_DARHAI_APPLE_FILE = 'builtin-mcp-apple.mjs';
export const BUILTIN_DARHAI_IMAP_NAME = 'com.darhai/imap-mcp';
export const BUILTIN_DARHAI_IMAP_FILE = 'builtin-mcp-imap.mjs';
export const BUILTIN_DARHAI_NEWS_NAME = 'com.darhai/news-mcp';
export const BUILTIN_DARHAI_NEWS_FILE = 'builtin-mcp-news.mjs';
export const BUILTIN_DARHAI_CAL_COM_NAME = 'com.darhai/cal-com-mcp';
export const BUILTIN_DARHAI_CAL_COM_FILE = 'builtin-mcp-cal-com.mjs';

export const BUILTIN_DARHAI_MCP_FILES = [
  BUILTIN_DARHAI_APPLE_FILE,
  BUILTIN_DARHAI_IMAP_FILE,
  BUILTIN_DARHAI_NEWS_FILE,
  BUILTIN_DARHAI_CAL_COM_FILE,
] as const;

export type BuiltinDarhaiMcpFile = (typeof BUILTIN_DARHAI_MCP_FILES)[number];

/** True if `arg` is a bare filename matching a bundled @darhai MCP. */
export function isBuiltinDarhaiMcpArg(arg: string | undefined | null): arg is BuiltinDarhaiMcpFile {
  if (!arg) return false;
  return (BUILTIN_DARHAI_MCP_FILES as readonly string[]).includes(arg);
}

/**
 * True if the transport is a bundled @darhai MCP spawn (node + bare filename
 * args[0] matching one of the four built-ins).
 */
export function isBuiltinDarhaiMcpTransport(transport?: {
  type?: string;
  command?: string;
  args?: string[] | null;
}): boolean {
  if (!transport || transport.type !== 'stdio' || transport.command !== 'node') return false;
  const first = (transport.args ?? [])[0];
  return isBuiltinDarhaiMcpArg(first);
}

export function isBuiltinImageGenName(name?: string | null): boolean {
  if (!name) return false;
  return (
    name === BUILTIN_IMAGE_GEN_NAME ||
    BUILTIN_IMAGE_GEN_LEGACY_NAMES.includes(name as (typeof BUILTIN_IMAGE_GEN_LEGACY_NAMES)[number])
  );
}

export function isBuiltinImageGenTransport(transport?: {
  type?: string;
  command?: string;
  args?: string[] | null;
}): boolean {
  if (!transport || transport.type !== 'stdio' || transport.command !== 'node') {
    return false;
  }

  return (transport.args || []).some((arg) => typeof arg === 'string' && arg.includes('builtin-mcp-image-gen.js'));
}

export function isBuiltinSearchSkillsName(name?: string | null): boolean {
  if (!name) return false;
  return (
    name === BUILTIN_SEARCH_SKILLS_NAME ||
    BUILTIN_SEARCH_SKILLS_LEGACY_NAMES.includes(name as (typeof BUILTIN_SEARCH_SKILLS_LEGACY_NAMES)[number])
  );
}

export function isBuiltinSearchSkillsTransport(transport?: {
  type?: string;
  command?: string;
  args?: string[] | null;
}): boolean {
  if (!transport || transport.type !== 'stdio' || transport.command !== 'node') {
    return false;
  }

  return (transport.args || []).some((arg) => typeof arg === 'string' && arg.includes('builtin-mcp-search-skills.js'));
}

export function isBuiltinWebSearchName(name?: string | null): boolean {
  if (!name) return false;
  return name === BUILTIN_WEB_SEARCH_NAME;
}

export function isBuiltinWebSearchTransport(transport?: {
  type?: string;
  command?: string;
  args?: string[] | null;
}): boolean {
  if (!transport || transport.type !== 'stdio' || transport.command !== 'node') {
    return false;
  }

  return (transport.args || []).some((arg) => typeof arg === 'string' && arg.includes('builtin-mcp-web-search.js'));
}
