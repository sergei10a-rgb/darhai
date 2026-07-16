/**
 * prepareEcc.js
 *
 * Stages the ECC agent harness (rules / skills / agents / commands + its
 * offline installer) into resources/bundled-ecc so it ships inside the
 * installer. On first run eccSystemService installs it into the user's
 * ~/.claude (namespaced under rules/ecc and skills/ecc), so every Darhai
 * user gets the pro harness with zero npm / zero network - mirroring how
 * bundled-ijfw is shipped.
 *
 * The ECC payload is plain markdown + Node scripts (no native binaries), so a
 * single ~8 MB copy is valid for every platform/arch. Its manual installer
 * (scripts/install-apply.js) runs offline with no node_modules - verified by
 * the build-time smoke install below.
 *
 * NOTE: the manual install path intentionally does NOT register hooks in the
 * user's GLOBAL ~/.claude/settings.json (asserted by the smoke install below).
 * Darhai activates the ECC hooks per conversation workspace instead
 * (eccSystemService.ensureWorkspaceEccHooks), so the quality machinery is on
 * by default inside Darhai without hijacking the user's standalone claude CLI.
 *
 * Environment variables:
 *   ECC_SKIP         - Set to '1' to skip (PR/test builds); default: run
 *   ECC_LOCAL_SOURCE - Path to a local ECC checkout to stage from (dev builds);
 *                      default: shallow-fetch the pinned commit from GitHub
 *   ECC_PIN_SHA      - Override the pinned commit (bump deliberately)
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const PROJECT_ROOT = path.resolve(__dirname, '..');
const OUT_DIR = path.join(PROJECT_ROOT, 'resources', 'bundled-ecc');

const ECC_REPO = 'https://github.com/affaan-m/ecc.git';
// Pinned commit for reproducible builds (v2.0.0 line; ECC has no git tags).
const PINNED_SHA = process.env.ECC_PIN_SHA || '34faa39bd3cd496a0aece0245f2b7e38b7923abc';

// The payload the offline installer needs. Everything else in the repo
// (node_modules 140MB, docs 13MB, assets 21MB, tests) is dead weight.
const PAYLOAD_DIRS = [
  'skills',
  'agents',
  'commands',
  'rules',
  'scripts',
  'hooks',
  'manifests',
  'mcp-configs',
  'config',
  'schemas',
  'contexts',
  'integrations',
  '.claude-plugin',
];
const PAYLOAD_FILES = ['package.json', 'VERSION', 'AGENTS.md', 'README.md', 'LICENSE'];

// Prune inside the staged payload: git metadata and nested node_modules.
const PRUNE_NAMES = new Set(['.git', '.github', 'node_modules']);

function rmrf(p) {
  fs.rmSync(p, { recursive: true, force: true });
}

function run(cmd, args, opts = {}) {
  const res = spawnSync(cmd, args, {
    stdio: 'inherit',
    shell: process.platform === 'win32' && cmd !== process.execPath,
    ...opts,
  });
  if (res.status !== 0) {
    throw new Error(`${cmd} ${args.join(' ')} exited with status ${res.status}`);
  }
}

/** Resolve the ECC source tree: local checkout (dev) or pinned shallow fetch. */
function resolveSource(staging) {
  const local = process.env.ECC_LOCAL_SOURCE;
  if (local) {
    if (!fs.existsSync(path.join(local, 'scripts', 'install-apply.js'))) {
      throw new Error(`ECC_LOCAL_SOURCE does not look like an ECC checkout: ${local}`);
    }
    console.log(`[ecc] using local source ${local}`);
    return local;
  }
  const cloneDir = path.join(staging, 'ecc-src');
  fs.mkdirSync(cloneDir, { recursive: true });
  console.log(`[ecc] fetching ${ECC_REPO} @ ${PINNED_SHA}`);
  run('git', ['init', '-q'], { cwd: cloneDir });
  run('git', ['remote', 'add', 'origin', ECC_REPO], { cwd: cloneDir });
  run('git', ['fetch', '-q', '--depth', '1', 'origin', PINNED_SHA], { cwd: cloneDir });
  run('git', ['checkout', '-q', 'FETCH_HEAD'], { cwd: cloneDir });
  return cloneDir;
}

/** Recursively remove pruned directory names inside the staged payload. */
function pruneTree(dir) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const full = path.join(dir, entry.name);
    if (PRUNE_NAMES.has(entry.name)) {
      rmrf(full);
    } else {
      pruneTree(full);
    }
  }
}

/**
 * Build-time smoke: run a REAL install from the staged bundle into a scratch
 * HOME. Catches a payload dir missing from PAYLOAD_DIRS before it ships.
 */
function smokeInstall(staging) {
  const fakeHome = path.join(staging, 'smoke-home');
  fs.mkdirSync(fakeHome, { recursive: true });
  const env = { ...process.env, HOME: fakeHome, USERPROFILE: fakeHome };
  run(
    process.execPath,
    [path.join(OUT_DIR, 'scripts', 'install-apply.js'), '--profile', 'full', '--target', 'claude'],
    { env, stdio: 'pipe' }
  );
  const hooksJsonPath = path.join(fakeHome, '.claude', 'hooks', 'hooks.json');
  const mustExist = [
    path.join(fakeHome, '.claude', 'skills', 'ecc'),
    path.join(fakeHome, '.claude', 'rules', 'ecc'),
    path.join(fakeHome, '.claude', 'agents'),
    path.join(fakeHome, '.claude', 'ecc', 'install-state.json'),
    hooksJsonPath,
  ];
  for (const p of mustExist) {
    if (!fs.existsSync(p)) throw new Error(`smoke install missing ${p}`);
  }
  // hooks.json is the single artifact the runtime hooks-by-default feature
  // reads (ensureWorkspaceEccHooks) - assert it parses with a non-empty map so
  // a future ECC_PIN_SHA bump cannot silently ship without it.
  const hooksDoc = JSON.parse(fs.readFileSync(hooksJsonPath, 'utf-8'));
  if (!hooksDoc.hooks || Object.keys(hooksDoc.hooks).length === 0) {
    throw new Error('smoke install produced an empty hooks/hooks.json');
  }
  // The manual install must NOT register hooks - GateGuard stays opt-in.
  if (fs.existsSync(path.join(fakeHome, '.claude', 'settings.json'))) {
    throw new Error('smoke install unexpectedly wrote settings.json (hooks must stay inert)');
  }
  console.log('[ecc] smoke install OK (skills/rules/agents present, no settings.json)');
}

function main() {
  if (process.env.ECC_SKIP === '1') {
    console.log('[ecc] ECC_SKIP=1 - skipping bundled ECC harness');
    return;
  }

  const staging = fs.mkdtempSync(path.join(os.tmpdir(), 'darhai-ecc-'));
  try {
    const src = resolveSource(staging);

    rmrf(OUT_DIR);
    fs.mkdirSync(OUT_DIR, { recursive: true });
    for (const dir of PAYLOAD_DIRS) {
      const from = path.join(src, dir);
      if (!fs.existsSync(from)) {
        console.log(`[ecc] payload dir absent upstream, skipping: ${dir}`);
        continue;
      }
      fs.cpSync(from, path.join(OUT_DIR, dir), { recursive: true });
    }
    for (const file of PAYLOAD_FILES) {
      const from = path.join(src, file);
      if (fs.existsSync(from)) fs.copyFileSync(from, path.join(OUT_DIR, file));
    }
    pruneTree(OUT_DIR);

    smokeInstall(staging);

    const version = fs.existsSync(path.join(OUT_DIR, 'VERSION'))
      ? fs.readFileSync(path.join(OUT_DIR, 'VERSION'), 'utf-8').trim()
      : '?';
    console.log(`[ecc] bundled ECC harness v${version} @ ${PINNED_SHA.slice(0, 7)} -> ${OUT_DIR}`);
  } finally {
    rmrf(staging);
  }
}

main();
