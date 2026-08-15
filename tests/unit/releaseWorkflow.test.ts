/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * `git push origin vX.Y.Z` must publish a release every platform can update
 * from.
 *
 * It never has. Measured on 2026-08-14: `build-and-release.yml` has zero runs
 * in this fork, every release was assembled by hand, and the release job could
 * not have succeeded anyway - it called `prepare-release-assets.sh`, which
 * hard-requires `latest-mac.yml`, a file `--publish=never` guarantees
 * electron-builder never writes.
 *
 * Then the repair shipped its own hole: three feeds for ten installers, so five
 * of the six platform/arch pairs could not update by either path (that is what
 * every release up to v0.9.7-mn.10 published too). The assertions below are
 * therefore about the release *contract*, not YAML style, and the two that
 * matter most run the real thing rather than reading it:
 *
 *   - the feed writer is executed over mock installers and the resulting
 *     digests are resolved with `pickRecommendedAsset` plus updateBridge's own
 *     lookup rule, for all six platform/arch pairs;
 *   - the overwrite guard is executed across its four states, so raising its
 *     threshold - the mutation that previously left the suite green - fails a
 *     named test.
 *
 * Nothing here hard-codes "three feeds" or "thirteen assets". Counts are
 * derived from the writer, because a constant that must be edited in lockstep
 * before a missing feed can be added is a guard against the fix, not the bug.
 */

import { execFileSync } from 'node:child_process';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import yaml from 'js-yaml';
import { afterAll, describe, expect, it, vi } from 'vitest';

vi.mock('@office-ai/platform', () => ({
  bridge: {
    buildProvider: vi.fn(() => ({ provider: vi.fn(), invoke: vi.fn() })),
    buildEmitter: vi.fn(() => ({ emit: vi.fn(), on: vi.fn() })),
  },
  storage: {
    buildStorage: () => ({
      getSync: (): unknown => undefined,
      setSync: (): void => {},
      get: (): Promise<unknown> => Promise.resolve(undefined),
      set: (): Promise<void> => Promise.resolve(),
    }),
  },
}));

vi.mock('electron', () => ({
  app: { getVersion: vi.fn(() => '1.0.0'), getPath: vi.fn(() => '/test/path'), isPackaged: true },
}));

vi.mock('electron-updater', () => ({
  autoUpdater: {
    logger: null,
    autoDownload: false,
    autoInstallOnAppQuit: true,
    allowPrerelease: false,
    allowDowngrade: false,
    on: vi.fn(),
    removeListener: vi.fn(),
    checkForUpdates: vi.fn(),
    downloadUpdate: vi.fn(),
    quitAndInstall: vi.fn(),
    checkForUpdatesAndNotify: vi.fn(),
  },
}));

vi.mock('electron-log', () => ({
  default: { transports: { file: { level: 'info' } }, info: vi.fn(), error: vi.fn(), warn: vi.fn() },
}));

import { pickRecommendedAsset } from '@process/bridge/desktop/updateBridge';
import { getUpdateChannel } from '@process/services/autoUpdaterService';

type Step = { name?: string; run?: string; uses?: string; with?: Record<string, unknown> };
type Job = { environment?: unknown; steps?: Step[]; with?: Record<string, unknown> };
type Workflow = { on?: unknown; jobs: Record<string, Job>; concurrency?: { group?: string } };

const REPO_ROOT = path.resolve(__dirname, '../..');
const WORKFLOW_PATH = path.join(REPO_ROOT, '.github/workflows/build-and-release.yml');
const PR_CHECKS_PATH = path.join(REPO_ROOT, '.github/workflows/pr-checks.yml');
const BUILDER_CONFIG_PATH = path.join(REPO_ROOT, 'electron-builder.yml');
const FEED_SCRIPT = path.join(REPO_ROOT, 'scripts/make-updater-feeds.mjs');
const GUARD_SCRIPT = path.join(REPO_ROOT, 'scripts/check-release-overwrite.mjs');

const WORKFLOW_SRC = fs.readFileSync(WORKFLOW_PATH, 'utf-8');
const workflow = yaml.load(WORKFLOW_SRC) as Workflow;

/** YAML 1.1 parses a bare `on:` key as the boolean true. */
const triggers = (workflow as Record<string, unknown>)['true'] ?? workflow.on;

const releaseJob = workflow.jobs.release;
const releaseSteps = releaseJob.steps ?? [];
const releaseText = releaseSteps.map((s) => `${s.run ?? ''}\n${JSON.stringify(s.with ?? {})}`).join('\n');

const step = (name: string): Step => {
  const found = releaseSteps.find((s) => s.name === name);
  if (!found) throw new Error(`release job has no step named "${name}"`);
  return found;
};

const TEST_VERSION = '9.9.9-test.1';

/** Run one of the release scripts the way the workflow runs it. */
const runScript = (script: string, args: string[], input?: string): string =>
  execFileSync(process.execPath, [script, ...args], { cwd: REPO_ROOT, encoding: 'utf-8', input });

/** Same, but for the failure path: returns the process exit code. */
const runScriptStatus = (script: string, args: string[], input?: string): number => {
  try {
    execFileSync(process.execPath, [script, ...args], { cwd: REPO_ROOT, encoding: 'utf-8', input, stdio: 'pipe' });
    return 0;
  } catch (err) {
    const status = (err as { status?: number }).status;
    return typeof status === 'number' ? status : -1;
  }
};

const lines = (out: string): string[] =>
  out
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);

const FEED_NAMES = lines(runScript(FEED_SCRIPT, ['--list-feeds']));
const INSTALLERS = lines(runScript(FEED_SCRIPT, ['--list-installers', '--version', TEST_VERSION]));

// ── Generate a real release directory once, then measure against it ──────────
const assetsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'darhai-release-'));
for (const name of INSTALLERS) {
  // Distinct bytes per file so a feed that copied the wrong digest is visible.
  fs.writeFileSync(path.join(assetsDir, name), `mock installer for ${name}`, 'utf-8');
}
runScript(FEED_SCRIPT, [assetsDir, '--version', TEST_VERSION]);

type FeedYml = { path?: string; sha512?: string; files?: { url?: string; sha512?: string; size?: number }[] };

const feeds = new Map<string, FeedYml>();
for (const entry of fs.readdirSync(assetsDir)) {
  if (!entry.startsWith('latest') || !entry.endsWith('.yml')) continue;
  feeds.set(entry, (yaml.load(fs.readFileSync(path.join(assetsDir, entry), 'utf-8')) as FeedYml) ?? {});
}

afterAll(() => {
  fs.rmSync(assetsDir, { recursive: true, force: true });
});

/**
 * updateBridge.ts's own lookup, replicated exactly: it collects every
 * `latest*.yml` on the release and takes the first `files[].url === name`, then
 * falls back to a top-level `path === name` (updateBridge.ts:355-390).
 */
const digestFor = (assetName: string): string | undefined => {
  for (const feed of feeds.values()) {
    const fromFiles = (feed.files ?? []).find((f) => f.url === assetName)?.sha512;
    const fromTop = feed.path === assetName ? feed.sha512 : undefined;
    const sha = fromFiles || fromTop;
    if (sha) return sha;
  }
  return undefined;
};

const sha512OnDisk = (assetName: string): string =>
  crypto
    .createHash('sha512')
    .update(fs.readFileSync(path.join(assetsDir, assetName)))
    .digest('base64');

/**
 * The extension allowlist `mapRelease` applies before `pickRecommendedAsset`
 * ever sees the assets (updateBridge.ts:61). `.AppImage` is deliberately absent
 * there, which is why the Linux `.deb`/`.rpm` - not the AppImage - are what the
 * in-app updater downloads and therefore what needs a digest.
 */
const ALLOWED_ASSET_EXTS = new Set(['.exe', '.msi', '.dmg', '.zip', '.deb', '.rpm']);

const releaseAssets = INSTALLERS.filter((name) => ALLOWED_ASSET_EXTS.has(path.extname(name))).map((name) => ({
  name,
  url: `https://github.com/sergei10a-rgb/darhai/releases/download/v${TEST_VERSION}/${name}`,
  size: 1,
}));

/** Every platform/arch the build matrix produces. */
const RUNTIMES: { platform: NodeJS.Platform; arch: string; label: string }[] = [
  { platform: 'win32', arch: 'x64', label: 'Windows x64' },
  { platform: 'win32', arch: 'arm64', label: 'Windows arm64' },
  { platform: 'darwin', arch: 'x64', label: 'macOS x64' },
  { platform: 'darwin', arch: 'arm64', label: 'macOS arm64' },
  { platform: 'linux', arch: 'x64', label: 'Linux x64' },
  { platform: 'linux', arch: 'arm64', label: 'Linux arm64' },
];

/**
 * The channel file electron-updater will actually GET for a runtime: the app's
 * own `getUpdateChannel()` (autoUpdaterService.ts:25-49) plus electron-updater's
 * `Provider.getChannelFilePrefix()` (node_modules/electron-updater/out/providers
 * /Provider.js:30-38). Deriving it from the app's function rather than restating
 * it means a change to the channel mapping that the feeds do not follow turns
 * this red.
 */
const channelFileFor = (platform: NodeJS.Platform, arch: string): string => {
  const originalPlatform = process.platform;
  const originalArch = process.arch;
  Object.defineProperty(process, 'platform', { value: platform, configurable: true });
  Object.defineProperty(process, 'arch', { value: arch, configurable: true });
  try {
    const channel = getUpdateChannel() ?? 'latest';
    const prefix =
      platform === 'linux' ? (arch === 'x64' ? '-linux' : `-linux-${arch}`) : platform === 'darwin' ? '-mac' : '';
    return `${channel}${prefix}.yml`;
  } finally {
    Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true });
    Object.defineProperty(process, 'arch', { value: originalArch, configurable: true });
  }
};

describe('build-and-release: the tag is the entry point', () => {
  it('triggers on any pushed tag', () => {
    const push = (triggers as { push?: { tags?: string[] } }).push;
    expect(push?.tags).toContain('*');
  });

  it('serialises runs per ref so two runs cannot race to upload the same assets', () => {
    expect(workflow.concurrency?.group).toContain('github.ref');
  });
});

describe('build-and-release: the release job can actually run here', () => {
  it('requires no Actions environment', () => {
    // This fork has zero environments (`gh api .../environments` -> total 0).
    // Naming one adds a deployment gate with no secret and no protection behind it.
    expect(releaseJob.environment).toBeUndefined();
  });

  it('depends on no repository secret', () => {
    // Measured: `gh api .../actions/secrets` -> total 0. A `secrets.GH_TOKEN`
    // reference resolves to the empty string and fails at use, not at parse.
    expect(releaseText).not.toContain('secrets.GH_TOKEN');
  });
});

describe('build-and-release: every platform can update from what it publishes', () => {
  it('writes one channel file for each platform/arch electron-updater will ask for', () => {
    const wanted = RUNTIMES.map((r) => channelFileFor(r.platform, r.arch));

    // Absence is not a degraded update: GitHubProvider raises
    // ERR_UPDATER_CHANNEL_FILE_NOT_FOUND on every check for that platform.
    expect(FEED_NAMES.toSorted()).toEqual(wanted.toSorted());
  });

  it('gives every recommended asset a digest, for every platform/arch', () => {
    const missing: string[] = [];

    for (const runtime of RUNTIMES) {
      const picked = pickRecommendedAsset(releaseAssets, { platform: runtime.platform, arch: runtime.arch });
      if (!picked) {
        missing.push(`${runtime.label}: no compatible asset at all`);
        continue;
      }
      const digest = digestFor(picked.name);
      if (!digest) {
        // updateBridge.ts:393 throws assetNotInMetadata here, and :655-669
        // deletes the download and reports an error - fail closed by design.
        missing.push(`${runtime.label}: ${picked.name} has no digest in any feed`);
        continue;
      }
      if (digest !== sha512OnDisk(picked.name)) {
        missing.push(`${runtime.label}: ${picked.name} digest does not match the file`);
      }
    }

    expect(missing).toEqual([]);
  });

  it('gives every published installer a digest, not only the recommended one', () => {
    // electron-updater's Linux updaters pick by extension - DebUpdater wants the
    // .deb, RpmUpdater the .rpm, AppImageUpdater the .AppImage - so all three
    // formats have to carry a digest, not just whichever one is "primary".
    const uncovered = INSTALLERS.filter((name) => !digestFor(name));
    expect(uncovered).toEqual([]);
  });

  it('records the same release timestamp in every feed', () => {
    const dates = new Set(
      [...feeds.keys()].map((name) => {
        const match = /releaseDate: '([^']+)'/.exec(fs.readFileSync(path.join(assetsDir, name), 'utf-8'));
        return match?.[1] ?? '';
      })
    );
    expect(dates.size).toBe(1);
  });
});

describe('build-and-release: the installer list matches what electron-builder can build', () => {
  const builder = yaml.load(fs.readFileSync(BUILDER_CONFIG_PATH, 'utf-8')) as {
    productName?: string;
    win?: { target?: string[]; artifactName?: string };
    mac?: { target?: string[]; artifactName?: string };
    linux?: { target?: string[]; artifactName?: string };
  };

  /** electron-builder target -> the file extension that target emits. */
  const TARGET_EXT: Record<string, string> = {
    nsis: 'exe',
    msi: 'msi',
    zip: 'zip',
    dmg: 'dmg',
    AppImage: 'AppImage',
    deb: 'deb',
    rpm: 'rpm',
    pacman: 'pacman',
  };

  const OS_TOKEN: Record<string, 'win' | 'mac' | 'linux'> = { win: 'win', mac: 'mac', linux: 'linux' };

  const parseName = (name: string) => {
    // electron-builder's `${productName}-${version}-${os}-${arch}.${ext}`.
    const match = new RegExp(`^${builder.productName}-${TEST_VERSION}-(win|mac|linux)-(.+)\\.([^.]+)$`).exec(name);
    if (!match) throw new Error(`installer name does not match the artifactName template: ${name}`);
    return { os: OS_TOKEN[match[1]], arch: match[2], ext: match[3] };
  };

  it('names every installer with the artifactName template from electron-builder.yml', () => {
    const template = '${productName}-${version}-${os}-${arch}.${ext}';
    expect(builder.win?.artifactName).toBe(template);
    expect(builder.mac?.artifactName).toBe(template);
    expect(builder.linux?.artifactName).toBe(template);
    expect(INSTALLERS.every((name) => name.startsWith(`${builder.productName}-`))).toBe(true);
  });

  it('uses only extensions the configured targets actually produce', () => {
    // Catches a name electron-builder can never emit - e.g. `mac-arm64.pkg`,
    // which today only fails after a full six-platform build on a real tag.
    const allowed: Record<string, Set<string>> = {
      win: new Set((builder.win?.target ?? []).map((t) => TARGET_EXT[t])),
      mac: new Set((builder.mac?.target ?? []).map((t) => TARGET_EXT[t])),
      linux: new Set((builder.linux?.target ?? []).map((t) => TARGET_EXT[t])),
    };

    const wrong = INSTALLERS.filter((name) => {
      const parsed = parseName(name);
      return !allowed[parsed.os].has(parsed.ext);
    });
    expect(wrong).toEqual([]);
  });

  it('ships exactly one installer per configured target per matrix arch', () => {
    // The count is derived, not typed: every target electron-builder.yml
    // configures, for every arch the matrix builds, must appear exactly once.
    // A weaker "at least one installer per platform" check would let a whole
    // packaging format be dropped - the Linux .deb is what the in-app updater
    // recommends, so losing it silently is losing Debian/Ubuntu updates.
    const matrix = JSON.parse(String(workflow.jobs['build-pipeline'].with?.matrix)) as {
      include: { platform: string; arch: string }[];
    };
    // The arch spellings electron-builder uses per target: deb says amd64, rpm
    // says x86_64/aarch64, AppImage says x86_64, nsis and dmg say x64.
    const ARCH_TOKENS: Record<string, string[]> = {
      x64: ['x64', 'x86_64', 'amd64'],
      arm64: ['arm64', 'aarch64'],
    };
    const PLATFORM_TOKENS: Record<string, 'win' | 'mac' | 'linux'> = {
      macos: 'mac',
      windows: 'win',
      linux: 'linux',
    };
    // `upload_installers_only: true` runs `rm -f out/*.zip` in
    // _build-reusable.yml, so zip targets never reach the release. That is also
    // why macOS cannot self-update through electron-updater: MacUpdater.js:77
    // needs a zip and there is none.
    const stripped =
      workflow.jobs['build-pipeline'].with?.upload_installers_only === true ? new Set(['zip']) : new Set();

    const parsed = INSTALLERS.map((name) => ({ name, ...parseName(name) }));
    const problems: string[] = [];
    let expectedCount = 0;

    for (const entry of matrix.include) {
      const osToken = PLATFORM_TOKENS[entry.platform.split('-')[0]];
      const targets = (builder[osToken === 'mac' ? 'mac' : osToken === 'win' ? 'win' : 'linux']?.target ?? []).filter(
        (t) => !stripped.has(t)
      );
      for (const target of targets) {
        expectedCount += 1;
        const matches = parsed.filter(
          (p) => p.os === osToken && p.ext === TARGET_EXT[target] && ARCH_TOKENS[entry.arch].includes(p.arch)
        );
        if (matches.length !== 1) {
          problems.push(`${entry.platform} ${target}: expected 1 installer, found ${matches.length}`);
        }
      }
    }

    expect(problems).toEqual([]);
    expect(INSTALLERS.length).toBe(expectedCount);
  });
});

describe('build-and-release: assets are assembled, not guessed', () => {
  it('does not call prepare-release-assets.sh', () => {
    // That script requires latest-mac.yml, which --publish=never never produces.
    expect(releaseText).not.toContain('prepare-release-assets.sh');
  });

  it('writes the updater feeds from the built files', () => {
    expect(step('Write electron-updater feeds').run).toContain('scripts/make-updater-feeds.mjs');
  });

  it('uploads installers only, so no zip or blockmap inflates the release', () => {
    expect(workflow.jobs['build-pipeline'].with?.upload_installers_only).toBe(true);
  });

  it('takes the installer list from the feed writer instead of restating it', () => {
    // A second copy of these names in YAML is how the feed table and the
    // uploaded set drifted apart; there must be exactly one list.
    const assemble = step('Assemble release assets').run ?? '';
    expect(assemble).toContain('make-updater-feeds.mjs --list-installers');
    expect(assemble).not.toMatch(/EXPECTED=\(/);
  });

  it('derives the asset count instead of hard-coding a total', () => {
    const verify = step('Verify the release is complete').run ?? '';
    expect(verify).toContain('make-updater-feeds.mjs --list-feeds');
    expect(verify).toContain('make-updater-feeds.mjs --list-installers');
    // A literal total has to be edited before a missing feed can be added,
    // which makes it a guard against the repair rather than against the bug.
    expect(verify).not.toMatch(/EXPECTED_TOTAL=\d/);
  });

  it('fails the job when an installer has no digest in any feed', () => {
    const verify = step('Verify the release is complete').run ?? '';
    expect(verify).toContain('No updater feed carries a digest for');
  });
});

describe('build-and-release: the push publishes', () => {
  const create = step('Create Release');

  it('publishes rather than drafting', () => {
    expect(create.with?.draft).toBe(false);
  });

  it('fails when an expected file is missing instead of publishing a short release', () => {
    expect(create.with?.fail_on_unmatched_files).toBe(true);
  });

  it('runs the overwrite guard through the tested script, not inline shell', () => {
    const guard = step('Refuse to overwrite a published release').run ?? '';
    // Both branches must invoke it - the existing-release one and the
    // no-release-yet one. Matching on `node <script>` rather than the bare path
    // keeps a mention in a comment from satisfying this.
    const invocations = guard.match(/node scripts\/check-release-overwrite\.mjs/g) ?? [];
    expect(invocations.length).toBe(2);
  });
});

describe('check-release-overwrite: the only thing making draft:false safe', () => {
  it('refuses a release that is already published with assets', () => {
    const status = runScriptStatus(GUARD_SCRIPT, ['v9.9.9'], '{"isDraft":false,"assets":[{"name":"a"}]}');
    expect(status).toBe(1);
  });

  it('allows a tag with no release yet', () => {
    expect(runScriptStatus(GUARD_SCRIPT, ['v9.9.9', '--missing'])).toBe(0);
  });

  it('allows completing a draft left by a failed earlier attempt', () => {
    const status = runScriptStatus(GUARD_SCRIPT, ['v9.9.9'], '{"isDraft":true,"assets":[{"name":"a"}]}');
    expect(status).toBe(0);
  });

  it('allows completing a published release that carries no assets', () => {
    expect(runScriptStatus(GUARD_SCRIPT, ['v9.9.9'], '{"isDraft":false,"assets":[]}')).toBe(0);
  });
});

describe('pr-checks: CI validates the release path that ships', () => {
  const prChecks = fs.readFileSync(PR_CHECKS_PATH, 'utf-8');

  it('no longer runs the abandoned release scripts', () => {
    // The release job stopped calling these; CI kept validating them against a
    // six-feed contract the shipping path did not satisfy, so the one enforced
    // contract was the dead one.
    expect(prChecks).not.toContain('bash scripts/prepare-release-assets.sh');
    expect(prChecks).not.toContain('bash scripts/verify-release-assets.sh');
  });

  it('exercises the live feed writer and the overwrite guard', () => {
    expect(prChecks).toContain('scripts/make-updater-feeds.mjs');
    expect(prChecks).toContain('scripts/check-release-overwrite.mjs');
  });

  it('keeps the branch-protection required check name', () => {
    expect(prChecks).toContain('name: Release Script Test');
  });
});
