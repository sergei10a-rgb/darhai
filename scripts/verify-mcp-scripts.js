#!/usr/bin/env node
/**
 * Mechanical guard: every builtin MCP stdio script the app ADVERTISES - to
 * agents AND to users - must exist in the build output.
 *
 * Two passes, because there are two independent ways to advertise a server:
 *   1. `MCP_STDIO_SCRIPT_NAMES` - what the CODE hands to agents in `session/new`.
 *   2. `src/renderer/mcp-catalog/entries/*.json` - what the USER reads in the
 *      MCP library. See `readCatalogBundledPackages()` for the four-server
 *      regression that pass 2 exists to prevent.
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
const CATALOG_ENTRIES_DIR = path.join(ROOT, 'src/renderer/mcp-catalog/entries');

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

/**
 * Read every bundle the USER-FACING CATALOG claims ships inside the installer.
 *
 * Why this second source exists
 * -----------------------------
 * `MCP_STDIO_SCRIPT_NAMES` is what the CODE advertises. The MCP library page
 * renders `src/renderer/mcp-catalog/entries/*.json`, which is what the USER is
 * shown. Those two lists drifted for the entire life of the product: four
 * `com.darhai/*` entries told users "bundled with Дархай - nothing to download"
 * while the build emitted nothing for them, because the build step that was
 * supposed to produce them looked for a sibling repository that exists nowhere
 * and only WARNED when it could not find it.
 *
 * The claim is machine-detectable: a package with `registryType: "binary"` and
 * `runtimeHint: "native"` is exactly the shape `McpLibrary/DetailPage.tsx`
 * installs as `{ command: 'node', args: [identifier] }` against our own bundle
 * dir. So the check is derived from the catalog itself - deliberately NOT from
 * a second hand-maintained list, since two hand-maintained lists is the bug
 * being fixed.
 *
 * @returns {Array<{entry: string, id: string, identifier: string}>}
 */
function readCatalogBundledPackages() {
  const claims = [];
  let files;
  try {
    files = fs.readdirSync(CATALOG_ENTRIES_DIR).filter((f) => f.endsWith('.json'));
  } catch (err) {
    throw new Error(
      `[verify-mcp-scripts] Could not read the MCP catalog at ${CATALOG_ENTRIES_DIR}: ${err.message}. ` +
        'If the catalog moved, update this guard - do not delete it.'
    );
  }
  if (files.length === 0) {
    throw new Error('[verify-mcp-scripts] MCP catalog has no entries - refusing to pass vacuously.');
  }

  for (const file of files) {
    let parsed;
    try {
      parsed = JSON.parse(fs.readFileSync(path.join(CATALOG_ENTRIES_DIR, file), 'utf-8'));
    } catch (err) {
      throw new Error(`[verify-mcp-scripts] ${file} is not valid JSON: ${err.message}`);
    }
    for (const pkg of parsed.packages ?? []) {
      if (pkg.registryType !== 'binary' || pkg.runtimeHint !== 'native') continue;
      if (typeof pkg.identifier !== 'string' || pkg.identifier.length === 0) {
        throw new Error(`[verify-mcp-scripts] ${file} declares a bundled package with no identifier.`);
      }
      claims.push({ entry: file, id: parsed.name ?? file, identifier: pkg.identifier });
    }
  }
  return claims;
}

/** @returns {string[]} human-readable problems, empty when everything is present. */
function checkPresent(names) {
  const problems = [];
  for (const name of names) {
    const file = path.join(OUT_MAIN, name);
    if (!fs.existsSync(file)) {
      problems.push(`${name} (missing)`);
      continue;
    }
    if (fs.statSync(file).size === 0) problems.push(`${name} (present but 0 bytes)`);
  }
  return problems;
}

function fail(headline, lines) {
  let dirContents = [];
  try {
    dirContents = fs.readdirSync(OUT_MAIN).sort();
  } catch {
    dirContents = ['<unreadable>'];
  }
  console.error(`[verify-mcp-scripts] FAILED - ${headline}`);
  console.error(`  Expected dir: ${OUT_MAIN}`);
  for (const line of lines) console.error(`  ${line}`);
  console.error(`  Dir contents: ${dirContents.length > 0 ? dirContents.join(', ') : '(empty)'}`);
  console.error("  Fix: run 'node scripts/build-mcp-servers.js' (it runs automatically from electron.vite.config.ts).");
  process.exit(1);
}

function main() {
  // Pass 1 - what the CODE advertises to every agent in `session/new`.
  const names = readAdvertisedScriptNames();
  const codeProblems = checkPresent(names);
  if (codeProblems.length > 0) {
    fail('the build advertises MCP servers it did not emit.', [`Broken: ${codeProblems.join(', ')}`]);
  }

  // Pass 2 - what the USER is shown in the MCP library.
  const claims = readCatalogBundledPackages();
  const catalogProblems = [];
  for (const claim of claims) {
    const broken = checkPresent([claim.identifier]);
    if (broken.length > 0) catalogProblems.push(`${claim.id} -> ${broken[0]} [${claim.entry}]`);
  }
  if (catalogProblems.length > 0) {
    fail(
      'the MCP catalog tells users a server is bundled, but the build did not emit it.\n' +
        '  A catalog entry with registryType "binary" + runtimeHint "native" renders as\n' +
        '  "bundled - nothing to download" and installs as `node <identifier>` against out/main/.\n' +
        '  Either build the bundle or stop advertising it.',
      catalogProblems
    );
  }

  console.log(
    `[verify-mcp-scripts] OK - all ${names.length} advertised MCP stdio scripts and ` +
      `${claims.length} catalog-bundled server(s) present in out/main/`
  );
}

main();
