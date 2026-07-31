#!/usr/bin/env node
/**
 * Mechanical guard: every builtin MCP stdio script the app ADVERTISES must
 * exist in the build output.
 *
 * Background
 * ----------
 * `initStorage.ensureBuiltinMcpServers()` seeds `mcp.config` with absolute
 * paths into `out/main/`, and two of those entries (`darhai-search-skills`,
 * `darhai-web-search`) are enabled by DEFAULT. Those exact paths are handed to
 * every agent in `session/new`. When the build did not emit the scripts, the
 * app kept advertising them and every spawn died with MODULE_NOT_FOUND - the
 * per-turn advert told the model to call `darhai_search_skills`, and the tool
 * could never start.
 *
 * The source of truth is `MCP_STDIO_SCRIPT_NAMES` in
 * `src/process/utils/mcpScriptDir.ts` - the same list the runtime resolver and
 * the startup canary use. `tests/unit/process/utils/mcpScriptDir.test.ts` pins
 * that list against the outfiles of `scripts/build-mcp-servers.js`, so the two
 * cannot drift apart silently.
 *
 * Exit code 1 (with the missing names) on any gap, so a build can never
 * succeed while shipping a dead builtin MCP registration.
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const OUT_MAIN = path.join(ROOT, 'out/main');
const SCRIPT_DIR_SOURCE = path.join(ROOT, 'src/process/utils/mcpScriptDir.ts');

/**
 * Read the advertised script names straight out of the runtime resolver so this
 * guard cannot check a stale hard-coded copy of the list.
 * @returns {string[]}
 */
function readAdvertisedScriptNames() {
  const source = fs.readFileSync(SCRIPT_DIR_SOURCE, 'utf-8');
  const block = source.match(/export const MCP_STDIO_SCRIPT_NAMES\s*=\s*\[([\s\S]*?)\]\s*as const;/);
  if (!block) {
    throw new Error(
      `[verify-mcp-scripts] Could not find MCP_STDIO_SCRIPT_NAMES in ${SCRIPT_DIR_SOURCE}. ` +
        'If the constant moved, update this guard - do not delete it.'
    );
  }
  const names = [...block[1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
  if (names.length === 0) {
    throw new Error('[verify-mcp-scripts] MCP_STDIO_SCRIPT_NAMES parsed as empty - refusing to pass vacuously.');
  }
  return names;
}

function main() {
  const names = readAdvertisedScriptNames();
  const missing = [];
  const empty = [];

  for (const name of names) {
    const file = path.join(OUT_MAIN, name);
    if (!fs.existsSync(file)) {
      missing.push(name);
      continue;
    }
    if (fs.statSync(file).size === 0) empty.push(name);
  }

  if (missing.length === 0 && empty.length === 0) {
    console.log(`[verify-mcp-scripts] OK - all ${names.length} advertised MCP stdio scripts present in out/main/`);
    return;
  }

  let dirContents = [];
  try {
    dirContents = fs.readdirSync(OUT_MAIN).sort();
  } catch {
    dirContents = ['<unreadable>'];
  }

  console.error('[verify-mcp-scripts] FAILED - the build advertises MCP servers it did not emit.');
  console.error(`  Expected dir: ${OUT_MAIN}`);
  if (missing.length > 0) console.error(`  Missing:      ${missing.join(', ')}`);
  if (empty.length > 0) console.error(`  Empty (0 B):  ${empty.join(', ')}`);
  console.error(`  Dir contents: ${dirContents.length > 0 ? dirContents.join(', ') : '(empty)'}`);
  console.error("  Fix: run 'node scripts/build-mcp-servers.js' (it runs automatically from electron.vite.config.ts).");
  process.exit(1);
}

main();
