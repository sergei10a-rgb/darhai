/**
 * prepareIjfw.js
 *
 * Stages the IJFW (Memory) MCP server into resources/bundled-ijfw/mcp-server so
 * it ships inside the installer. On first run ijfwSystemService seeds it into
 * ~/.ijfw/mcp-server, so the Memory engine works with zero npm / zero network -
 * mirroring how bundled-bun and bundled-wayland-core are shipped.
 *
 * The IJFW mcp-server tree is pure JavaScript (no native .node binaries), so a
 * single ~8 MB copy is valid for every platform/arch - no per-target build.
 *
 * Called during the build pipeline before electron-builder runs.
 *
 * Environment variables:
 *   IJFW_SKIP        - Set to '1' to skip (PR/test builds); default: run
 *   IJFW_INSTALL_VER - @ijfw/install version to stage (default: PINNED below)
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const PROJECT_ROOT = path.resolve(__dirname, '..');
const OUT_DIR = path.join(PROJECT_ROOT, 'resources', 'bundled-ijfw');
const OUT_SERVER = path.join(OUT_DIR, 'mcp-server');

// Pinned installer version for reproducible builds. Bump deliberately.
const PINNED = process.env.IJFW_INSTALL_VER || '1.6.3';

// Top-level standalone test runners + git metadata are dead weight in a shipped
// seed. They are not required by the MCP server runtime, so pruning them keeps
// the installer lean without touching src/ bin/ data/ scripts/ templates/.
const PRUNE_DIRS = ['.git', '.github'];
const PRUNE_FILE_RE = /^test[-.].*\.js$/i;

function rmrf(p) {
  fs.rmSync(p, { recursive: true, force: true });
}

function main() {
  if (process.env.IJFW_SKIP === '1') {
    console.log('[ijfw] IJFW_SKIP=1 - skipping bundled Memory engine');
    return;
  }

  const staging = fs.mkdtempSync(path.join(os.tmpdir(), 'darhai-ijfw-'));
  try {
    console.log(`[ijfw] staging @ijfw/install@${PINNED} into ${staging}`);
    const res = spawnSync(
      'npx',
      [
        '-y',
        '--package',
        `@ijfw/install@${PINNED}`,
        'ijfw-install',
        '--dir',
        staging,
        '--no-marketplace',
        '--yes',
      ],
      { stdio: 'inherit', shell: process.platform === 'win32', env: process.env },
    );
    if (res.status !== 0) {
      throw new Error(`ijfw-install exited with status ${res.status}`);
    }

    const stagedServer = path.join(staging, 'mcp-server');
    if (!fs.existsSync(path.join(stagedServer, 'package.json'))) {
      throw new Error(`staged mcp-server missing package.json at ${stagedServer}`);
    }

    // Fresh copy into resources/.
    rmrf(OUT_DIR);
    fs.mkdirSync(OUT_DIR, { recursive: true });
    fs.cpSync(stagedServer, OUT_SERVER, { recursive: true });

    // Prune non-runtime files to slim the shipped seed.
    for (const d of PRUNE_DIRS) rmrf(path.join(OUT_SERVER, d));
    for (const entry of fs.readdirSync(OUT_SERVER)) {
      if (PRUNE_FILE_RE.test(entry)) rmrf(path.join(OUT_SERVER, entry));
    }

    const pkg = JSON.parse(fs.readFileSync(path.join(OUT_SERVER, 'package.json'), 'utf-8'));
    console.log(`[ijfw] bundled mcp-server ${pkg.name || ''}@${pkg.version || '?'} -> ${OUT_SERVER}`);
  } finally {
    rmrf(staging);
  }
}

main();
