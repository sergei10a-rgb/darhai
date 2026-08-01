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

// ── Built-in personal-data MCP server ───────────────────────────────────────
// Exposes the user's OWN stores (calendar / notes / documents / memory) to any
// agent that speaks MCP. Unlike the other builtins the tool bodies do NOT run
// in the spawned subprocess: the subprocess is a thin TCP bridge onto an
// in-process server living in the Electron main process, which already owns the
// single SQLite connection, the local `users` row and the live services. See
// `personalData/PersonalDataMcpServer.ts` for why that split is mandatory.
export const BUILTIN_PERSONAL_DATA_ID = 'builtin-personal-data';
export const BUILTIN_PERSONAL_DATA_NAME = 'darhai-personal-data';
export const BUILTIN_PERSONAL_DATA_FILE = 'builtin-mcp-personal-data.js';

/** Loopback TCP port of the in-process personal-data server, injected at spawn. */
export const PERSONAL_DATA_PORT_ENV = 'DARHAI_PERSONAL_DATA_PORT';
/** Per-boot shared secret the bridge must present on every TCP request. */
export const PERSONAL_DATA_TOKEN_ENV = 'DARHAI_PERSONAL_DATA_TOKEN';

// ── Built-in news / RSS MCP server ──────────────────────────────────────────────
// Plain stdio server built from our own source in `news/`. Unlike the
// personal-data bridge it needs NOTHING from the Electron app: it only speaks
// HTTP to public feeds, so the tool bodies run inside the spawned subprocess
// exactly like `searchSkillsServer`.
export const BUILTIN_NEWS_NAME = 'com.darhai/news-mcp';
export const BUILTIN_NEWS_FILE = 'builtin-mcp-news.js';
/** Optional env var: newline/comma separated extra feed URLs added by the user. */
export const NEWS_FEEDS_ENV = 'DARHAI_NEWS_FEEDS';

// ── Built-in Email (IMAP/SMTP) MCP server ───────────────────────────────────
// READ, DRAFT, and ONE CONFIRMATION-GATED SEND. Speaks IMAP to the user's own
// mail host, saves drafts into their Drafts folder, and can send only after the
// user has read the complete message in a Дархай dialog and pressed Send. The
// model cannot approve its own request: the only module in `imap/` that imports
// an SMTP client is `smtpSender.ts`, its only importer is `sendGate.ts`, and
// that file calls the confirmation gate first (see
// `services/toolConfirmation/`). Credentials arrive as spawn env inside the
// subprocess and are never returned by a tool.
//
// History: catalog entries for `com.darhai/imap-mcp` and `com.darhai/cal-com-mcp`
// used to advertise `.mjs` bundles built from a sibling `waylandmcp` repo that
// does not exist in any checkout, on npm, or in upstream CI. Both servers are
// now built from source in this repository, so they are ordinary members of
// `MCP_STDIO_SCRIPT_NAMES` like the news server - and `scripts/verify-mcp-scripts.js`
// fails the build if either bundle goes missing again.
export const BUILTIN_IMAP_NAME = 'com.darhai/imap-mcp';
export const BUILTIN_IMAP_FILE = 'builtin-mcp-imap.js';

// ── Built-in Cal.com MCP server ─────────────────────────────────────────────
// READ-ONLY against the Cal.com v2 API. See `calCom/calComServer.ts` for the
// recorded reason there is no create / cancel / reschedule tool.
export const BUILTIN_CAL_COM_NAME = 'com.darhai/cal-com-mcp';
export const BUILTIN_CAL_COM_FILE = 'builtin-mcp-cal-com.js';

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

export function isBuiltinPersonalDataName(name?: string | null): boolean {
  if (!name) return false;
  return name === BUILTIN_PERSONAL_DATA_NAME;
}

export function isBuiltinPersonalDataTransport(transport?: {
  type?: string;
  command?: string;
  args?: string[] | null;
}): boolean {
  if (!transport || transport.type !== 'stdio' || transport.command !== 'node') {
    return false;
  }

  return (transport.args || []).some((arg) => typeof arg === 'string' && arg.includes(BUILTIN_PERSONAL_DATA_FILE));
}
