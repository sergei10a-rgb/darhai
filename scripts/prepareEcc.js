/**
 * prepareEcc.js
 *
 * The ECC agent harness ships as an INSEPARABLE, vendored part of Darhai: the
 * audited payload is committed to this repo under resources/bundled-ecc, and
 * electron-builder packs it into the installer. On first run eccSystemService
 * installs it into the user's ~/.claude (namespaced rules/ecc, skills/ecc) with
 * zero npm / zero network - mirroring bundled-ijfw.
 *
 * Vendoring (not build-time fetching) is deliberate: the exact reviewed bytes
 * are versioned in git and diffable in PRs, the build has no dependency on a
 * live third-party repo (which could change, be force-pushed, or disappear),
 * and builds are fully reproducible + offline.
 *
 * TWO MODES:
 *   default (build):  verify resources/bundled-ecc is present and installs
 *                     cleanly. Does NOT touch the network. Fails the build if
 *                     the vendored payload is missing.
 *   --refresh:        MAINTAINER-ONLY. Re-vendor resources/bundled-ecc from the
 *                     pinned ECC commit (or ECC_LOCAL_SOURCE), then commit the
 *                     result. This is the only path that fetches over the
 *                     network, and it is never run in CI/build.
 *
 * NOTE: the payload's manual installer does NOT register hooks in the user's
 * GLOBAL ~/.claude/settings.json (asserted by the smoke install below). Darhai
 * activates the ECC hooks per conversation workspace (eccSystemService.
 * ensureWorkspaceEccHooks), so the quality machinery is on by default inside
 * Darhai without hijacking the user's standalone claude CLI.
 *
 * Environment variables:
 *   ECC_SKIP         - Set to '1' to skip entirely (rare; the payload is vendored)
 *   ECC_REFRESH      - Set to '1' (or pass --refresh) to re-vendor from source
 *   ECC_LOCAL_SOURCE - Path to a local ECC checkout to vendor from (else the
 *                      pinned commit is shallow-fetched from GitHub)
 *   ECC_PIN_SHA      - Override the pinned commit to vendor (bump deliberately)
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const PROJECT_ROOT = path.resolve(__dirname, '..');
const OUT_DIR = path.join(PROJECT_ROOT, 'resources', 'bundled-ecc');

const ECC_REPO = 'https://github.com/affaan-m/ecc.git';
// Pinned commit for the vendored payload (v2.0.0 line; ECC has no git tags).
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

/** Resolve the ECC source tree: local checkout, or pinned shallow fetch. */
function resolveSource(staging) {
  const local = process.env.ECC_LOCAL_SOURCE;
  if (local) {
    if (!fs.existsSync(path.join(local, 'scripts', 'install-apply.js'))) {
      throw new Error(`ECC_LOCAL_SOURCE does not look like an ECC checkout: ${local}`);
    }
    console.log(`[ecc] vendoring from local source ${local}`);
    return local;
  }
  const cloneDir = path.join(staging, 'ecc-src');
  fs.mkdirSync(cloneDir, { recursive: true });
  console.log(`[ecc] fetching ${ECC_REPO} @ ${PINNED_SHA} (refresh only)`);
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

/** MAINTAINER: (re)stage resources/bundled-ecc from the resolved ECC source. */
function revendor(staging) {
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
  console.log('[ecc] re-vendored resources/bundled-ecc - review and commit the diff');
}

/**
 * Run a REAL install from the vendored bundle into a scratch HOME to prove the
 * committed payload is installable + carries the load-bearing artifacts.
 */
function smokeInstall(staging) {
  const fakeHome = path.join(staging, 'smoke-home');
  fs.mkdirSync(fakeHome, { recursive: true });
  const env = { ...process.env, HOME: fakeHome, USERPROFILE: fakeHome };
  run(
    process.execPath,
    [path.join(OUT_DIR, 'scripts', 'install-apply.js'), '--profile', 'full', '--target', 'claude'],
    { env, stdio: 'pipe' },
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
  // a future re-vendor cannot silently ship without it.
  const hooksDoc = JSON.parse(fs.readFileSync(hooksJsonPath, 'utf-8'));
  if (!hooksDoc.hooks || Object.keys(hooksDoc.hooks).length === 0) {
    throw new Error('smoke install produced an empty hooks/hooks.json');
  }
  // The manual install must NOT register hooks in the global settings.json -
  // Darhai activates them per workspace instead.
  if (fs.existsSync(path.join(fakeHome, '.claude', 'settings.json'))) {
    throw new Error('smoke install unexpectedly wrote a global settings.json');
  }
  console.log('[ecc] smoke install OK (skills/rules/agents/hooks present, no global settings.json)');
}

function main() {
  if (process.env.ECC_SKIP === '1') {
    console.log('[ecc] ECC_SKIP=1 - skipping bundled ECC harness');
    return;
  }

  const refresh = process.env.ECC_REFRESH === '1' || process.argv.includes('--refresh');
  const staging = fs.mkdtempSync(path.join(os.tmpdir(), 'darhai-ecc-'));
  try {
    if (refresh) {
      revendor(staging);
    }

    if (!fs.existsSync(path.join(OUT_DIR, 'scripts', 'install-apply.js'))) {
      throw new Error(
        'resources/bundled-ecc is not vendored. Run `node scripts/prepareEcc.js --refresh` ' +
          '(optionally with ECC_LOCAL_SOURCE=<checkout>) and commit the result.',
      );
    }

    smokeInstall(staging);

    const version = fs.existsSync(path.join(OUT_DIR, 'VERSION'))
      ? fs.readFileSync(path.join(OUT_DIR, 'VERSION'), 'utf-8').trim()
      : '?';
    console.log(`[ecc] vendored ECC harness v${version} verified -> ${OUT_DIR}`);
  } finally {
    rmrf(staging);
  }
}

main();
