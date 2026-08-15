/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Deterministic visual-regression fixture for the real Electron app.
 *
 * Visual baselines are only useful if a passing run means "the UI is unchanged"
 * and a failing run means "the UI changed". Anything that varies between runs
 * (clock, machine, animation timing) turns the suite into noise that people
 * learn to ignore, so every source of variance is pinned here rather than in
 * individual specs.
 *
 * What is pinned, and why (each was observed drifting on a real run):
 *
 *  1. **Profile isolation.** `configureChromium.ts` rewrites userData in dev to
 *     `dirname(userData)/<devAppName>`. Passing `--user-data-dir=<tmp>` alone
 *     therefore lands every run in the SHARED `<tmp>/Darhai-Dev`. We pass a
 *     NESTED path (`<unique>/profile`) so the rewrite resolves to
 *     `<unique>/Darhai-Dev` - genuinely per-run.
 *  2. **Device scale + window size.** A raw launch inherited the host display
 *     (dpr 1.5, 1365x816), which would make baselines machine-specific.
 *  3. **Animations/transitions.** One CSS animation and ~69 transitions were
 *     live on the main screen; two screenshots 1.5s apart differed by ~20KB.
 *  4. **Clock.** The home greeting is time-of-day dependent ("Сайхан өглөө" vs
 *     "Орой хүртэл сэрүүн"), so the clock is frozen to a fixed instant.
 *  5. **Async settle.** Agent/health lists populate after first paint and shift
 *     layout by ~14 lines, so we wait for the DOM to stop changing rather than
 *     sleeping a guessed amount.
 */
import { _electron as electron, type ElectronApplication, type Page } from 'playwright';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** Repo root, resolved from this file rather than cwd so callers can't skew it. */
export const PROJECT_ROOT = path.resolve(__dirname, '..', '..', '..');

/** Fixed content size for every visual run. Baselines are only valid at this size. */
export const VIEWPORT = { width: 1280, height: 800 } as const;

/**
 * The instant the app clock is frozen to for every visual run.
 * Chosen mid-morning UTC so time-of-day copy lands on a stable branch.
 */
export const FROZEN_TIME = new Date('2026-01-15T09:30:00.000Z');

/**
 * The build outputs a visual run actually executes.
 *
 * All three, not just the renderer: `package.json` `main` points at
 * `out/main/index.js`, and a half-finished build that refreshed one and not the
 * others is exactly the state a single-file check would wave through.
 */
const BUNDLE_OUTPUTS = ['out/main/index.js', 'out/preload/index.js', 'out/renderer/index.html'] as const;

/** How many stale files to name before the message stops being readable. */
const STALE_SAMPLE = 8;

/** Directories created for launched apps, removed on {@link closeVisualApp}. */
const runRoots = new Set<string>();

/** Every file under `dir`, walked once. */
function walkFiles(dir: string, out: string[]): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walkFiles(full, out);
    } else {
      out.push(full);
    }
  }
  return out;
}

/**
 * Refuse to run when the built app predates the source a spec claims to be
 * looking at.
 *
 * WHY EVERY DOM ASSERTION IN THIS SUITE NEEDS THIS
 * ------------------------------------------------
 * `electron .` with no `ELECTRON_RENDERER_URL` loads `out/renderer/index.html`
 * (`package.json` `main` -> the built main's `fallbackFile`). That is a build
 * ARTIFACT. Everything a spec reads off the screen therefore describes whatever
 * was last built, while everything it imports from `@process/...` or
 * `@renderer/...` runs from CURRENT source inside the test process. Unchecked,
 * those are two different snapshots of the repo - and the consequence is not
 * academic: deleting the single line that gives the budget dialog its own
 * footer left `budgetGrantDialog.visual.ts` fully green, because the running
 * renderer had never seen the deletion.
 *
 * A component is not under test if changing it cannot change the result, so
 * this is a hard stop, not a warning. The remedy is one command and it is
 * printed.
 *
 * SCOPED ON PURPOSE
 * -----------------
 * Callers pass the files they actually assert about rather than getting a blanket
 * `src/**` check. Two reasons, both practical: a repo-wide check reddens every
 * visual spec the moment anyone edits an unrelated module, and - more usefully -
 * the argument list becomes the spec's own written claim about which source
 * files it is photographing. Directories are accepted and walked, so
 * `src/renderer/components/base` covers a component and its neighbours.
 */
export function assertBundleShowsSource(sourcePaths: readonly string[]): void {
  const missing = BUNDLE_OUTPUTS.filter((rel) => !fs.existsSync(path.join(PROJECT_ROOT, rel)));
  if (missing.length > 0) {
    throw new Error(
      `visual fixture: no app bundle to look at - ${missing.join(', ')} ${missing.length === 1 ? 'is' : 'are'} ` +
        'missing. The visual suite launches the BUILT app. Run `bun run package` first.'
    );
  }

  // The OLDEST output is the honest reference: a build that refreshed the
  // renderer but died before the main process is still a stale bundle.
  let bundleMtime = Number.POSITIVE_INFINITY;
  let bundleFile = '';
  for (const rel of BUNDLE_OUTPUTS) {
    const mtime = fs.statSync(path.join(PROJECT_ROOT, rel)).mtimeMs;
    if (mtime < bundleMtime) {
      bundleMtime = mtime;
      bundleFile = rel;
    }
  }

  const inputs: string[] = [];
  for (const rel of sourcePaths) {
    const full = path.resolve(PROJECT_ROOT, rel);
    // A path that does not exist is a spec claiming to watch a file that is
    // gone - say so rather than silently watching nothing.
    if (!fs.existsSync(full)) {
      throw new Error(`visual fixture: ${rel} does not exist, so nothing is guarding the code this spec asserts about`);
    }
    if (fs.statSync(full).isDirectory()) {
      walkFiles(full, inputs);
    } else {
      inputs.push(full);
    }
  }

  const stale = inputs
    .filter((file) => fs.statSync(file).mtimeMs > bundleMtime)
    .map((file) => path.relative(PROJECT_ROOT, file));

  if (stale.length > 0) {
    const sample = stale.slice(0, STALE_SAMPLE).join('\n  ');
    const rest = stale.length > STALE_SAMPLE ? `\n  ...and ${stale.length - STALE_SAMPLE} more` : '';
    throw new Error(
      'visual fixture: the built app is older than the source this spec asserts about.\n' +
        `${stale.length} file(s) changed since ${bundleFile} was written ` +
        `(${new Date(bundleMtime).toISOString()}):\n  ${sample}${rest}\n` +
        'This suite launches the BUILT app, so every assertion below would describe the OLD code while ' +
        'anything imported from src/ runs the NEW code. Run `bun run package`, then re-run this spec.'
    );
  }
}

/**
 * Every app this module has launched and not yet proved dead.
 *
 * `quitVisualApp` used to fire `app.exit(0)` and `app.close()` with both results
 * swallowed, then return. The OS process was still alive for a moment
 * afterwards - and it still held `<runRoot>/Darhai-Dev/SingletonLock` (plus the
 * Windows lockfile) inside its `--user-data-dir`. A spec that relaunches against
 * the same `runRoot` (`localUserSurfaces`, `memoryRecall`) therefore raced the
 * corpse for its own profile: when it lost, Chromium refused the profile, the
 * new process exited before Playwright could attach, and the launch surfaced as
 * `Error: Process failed to launch!` - taking the whole file's `beforeAll` with
 * it and reporting the remaining tests as "did not run". A retry on a clean
 * machine then passed, which is exactly what made it look like noise.
 */
const liveApps = new Set<ElectronApplication>();

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Close an app and do not return until its OS process is genuinely gone.
 *
 * `ElectronApplication.close()` alone is not proof: once `app.exit(0)` has torn
 * the main process down, the CDP call it rides on can reject, and every earlier
 * caller swallowed that rejection. Here the child process itself is the source
 * of truth, and a process that ignores both is killed rather than left to
 * collide with the next launch.
 */
async function reapVisualApp(app: ElectronApplication, timeoutMs = 30_000): Promise<void> {
  const child = app.process();
  const exited = child
    ? new Promise<void>((resolve) => {
        if (child.exitCode !== null || child.signalCode !== null) return resolve();
        child.once('exit', () => resolve());
      })
    : Promise.resolve();

  await app.evaluate(({ app: electronApp }) => electronApp.exit(0)).catch(() => {});
  await app.close().catch(() => {});

  const deadline = Date.now() + timeoutMs;
  let alive = await Promise.race([exited.then(() => false), delay(timeoutMs).then(() => true)]);
  if (alive && child) {
    console.warn(`[visual] Electron pid ${child.pid} ignored exit(0); killing it before the next launch`);
    child.kill('SIGKILL');
    alive = await Promise.race([
      exited.then(() => false),
      delay(Math.max(1_000, deadline - Date.now())).then(() => true),
    ]);
  }
  if (alive) {
    throw new Error(
      `visual fixture: Electron process ${child?.pid ?? '(unknown)'} would not exit within ${timeoutMs}ms. ` +
        'Relaunching now would race it for its profile directory.'
    );
  }
  liveApps.delete(app);
}

/** Reap anything a previous spec left running, so a fresh launch starts clean. */
async function reapOutstandingApps(): Promise<void> {
  // Snapshot first: reapVisualApp deletes from the set it is iterating.
  const outstanding = Array.from(liveApps);
  for (const app of outstanding) {
    // eslint-disable-next-line no-await-in-loop
    await reapVisualApp(app).catch((err) => {
      console.warn('[visual] could not reap a previous app:', err instanceof Error ? err.message : err);
      liveApps.delete(app);
    });
  }
}

export type VisualApp = {
  app: ElectronApplication;
  page: Page;
  /** The per-run isolated profile root (parent of the app's userData). */
  runRoot: string;
};

/** Windows the app opens that are not the main renderer. */
function isAuxiliaryWindow(url: string): boolean {
  const u = url.toLowerCase();
  if (u.startsWith('devtools://')) return true;
  return ['/ambient/', '/pet/', 'ambient.html', 'pet.html', 'pet-hit.html', 'pet-confirm.html'].some((s) =>
    u.includes(s)
  );
}

/**
 * Launch the real Electron app against a fresh, isolated profile.
 *
 * Cold launch is slow (~80s observed on Windows dev mode); callers should share
 * one app across as many screens as possible rather than relaunching per test.
 */
export async function launchVisualApp(
  extraEnv: Record<string, string> = {},
  options: { reuseRunRoot?: string } = {}
): Promise<VisualApp> {
  // Passing a previous run's root relaunches against the SAME profile - the only
  // way a spec can prove that what the UI wrote is still there after a restart,
  // rather than only that it reached memory. Omit it for a genuinely fresh app.
  const runRoot = options.reuseRunRoot ?? fs.mkdtempSync(path.join(os.tmpdir(), 'darhai-visual-'));
  runRoots.add(runRoot);

  // Never launch alongside a process that still owns a profile directory.
  await reapOutstandingApps();

  const launchOptions = {
    args: [
      '.',
      // Nested on purpose - see note 1 in the file header.
      `--user-data-dir=${path.join(runRoot, 'profile')}`,
      '--force-device-scale-factor=1',
      '--disable-lcd-text',
      '--hide-scrollbars',
      '--disable-gpu-compositing',
    ],
    cwd: PROJECT_ROOT,
    env: {
      ...process.env,
      NODE_ENV: 'development',
      DARHAI_E2E_TEST: '1',
      DARHAI_DISABLE_AUTO_UPDATE: '1',
      DARHAI_DISABLE_DEVTOOLS: '1',
      DARHAI_DISABLE_IJFW: '1',
      DARHAI_CDP_PORT: '0',
      TZ: 'UTC',
      LANG: 'mn_MN.UTF-8',
      ...extraEnv,
    },
    timeout: 180_000,
  };

  // A launch that dies before Playwright can attach ("Process failed to launch!")
  // is almost always contention with a process that has not finished exiting,
  // not a broken build. Retry it - loudly, so a genuinely broken build still
  // reads as three identical failures rather than one mysterious one - instead
  // of letting a single lost race cascade into "N did not run".
  const ATTEMPTS = 3;
  let app: ElectronApplication | undefined;
  let lastError: unknown;
  for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
    try {
      app = await electron.launch(launchOptions);
      break;
    } catch (err) {
      lastError = err;
      const message = err instanceof Error ? err.message : String(err);
      console.warn(`[visual] Electron launch attempt ${attempt}/${ATTEMPTS} failed: ${message}`);
      await reapOutstandingApps();
      await delay(2_000 * attempt);
    }
  }
  if (!app) {
    throw new Error(
      `visual fixture: Electron failed to launch after ${ATTEMPTS} attempts (profile ${runRoot}). ` +
        `Last error: ${lastError instanceof Error ? lastError.message : String(lastError)}`
    );
  }
  liveApps.add(app);

  const page = await resolveMainWindow(app);
  await pinWindowGeometry(app);
  await waitForBridge(page);

  return { app, page, runRoot };
}

/** Resolve the main renderer window, ignoring devtools and satellite windows. */
async function resolveMainWindow(app: ElectronApplication): Promise<Page> {
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    const win = app.windows().find((w) => !isAuxiliaryWindow(w.url()));
    if (win) {
      await win.waitForLoadState('domcontentloaded').catch(() => {});
      return win;
    }
    await app.waitForEvent('window', { timeout: 2_000 }).catch(() => {});
  }
  throw new Error('visual fixture: main renderer window did not appear within 120s');
}

/** Force a fixed, non-resizable content size so geometry is host-independent. */
async function pinWindowGeometry(app: ElectronApplication): Promise<void> {
  await app
    .evaluate(({ BrowserWindow }, size) => {
      const win = BrowserWindow.getAllWindows().find((w) => !w.isDestroyed());
      if (!win) return;
      win.setResizable(true);
      win.setContentSize(size.width, size.height);
      win.setResizable(false);
    }, VIEWPORT)
    .catch(() => {
      // Non-fatal: assertStableViewport below turns this into a loud failure.
    });
}

/** Wait until the preload bridge is present and has stopped being replaced. */
async function waitForBridge(page: Page): Promise<void> {
  const deadline = Date.now() + 90_000;
  let firstSeen = 0;
  while (Date.now() < deadline) {
    const ok = await page
      .evaluate(() => typeof (window as unknown as { electronAPI?: unknown }).electronAPI !== 'undefined')
      .catch(() => false);
    if (ok) {
      if (!firstSeen) firstSeen = Date.now();
      if (Date.now() - firstSeen >= 500) return;
    } else {
      firstSeen = 0;
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('visual fixture: window.electronAPI never stabilised within 90s');
}

/**
 * Fail loudly if the render surface is not the size baselines were captured at.
 * A silently-resized window would otherwise produce a confusing pixel diff.
 */
export async function assertStableViewport(page: Page): Promise<void> {
  const vp = await page.evaluate(() => ({
    w: window.innerWidth,
    h: window.innerHeight,
    dpr: window.devicePixelRatio,
  }));
  if (vp.dpr !== 1) {
    throw new Error(`visual fixture: devicePixelRatio is ${vp.dpr}, expected 1 (baselines are 1x)`);
  }
  if (vp.w !== VIEWPORT.width) {
    throw new Error(`visual fixture: innerWidth is ${vp.w}, expected ${VIEWPORT.width}`);
  }
}

/**
 * Pin the two clock-and-dice sources the UI reads during render.
 *
 * - **Clock**: the home greeting picks a bucket from `getHours()`
 *   (`Greeting.tsx:54`), so an unpinned run renders "Сайхан өглөө" or
 *   "Орой хүртэл сэрүүн" depending on when it happened to run.
 * - **`Math.random`**: the same greeting then picks one of three phrasings at
 *   random *per mount* (`Greeting.tsx:56`). Freezing only the clock leaves that
 *   1-in-3 flip live, which would fail a baseline roughly two runs in three.
 *   Replaced with a deterministic PRNG rather than a constant, so code that
 *   needs distinct values (React keys, request ids) still gets them.
 *
 * Installed as an init script, so it must be applied before the load whose
 * first render should see it (callers reload after calling this).
 */
export async function pinNondeterminism(page: Page, at: Date = FROZEN_TIME): Promise<void> {
  await page.addInitScript((iso: string) => {
    const fixed = new Date(iso).getTime();
    const RealDate = Date;
    // A Proxy rather than a subclass: it forwards every static, the prototype
    // and `instanceof` untouched, so only the two clock reads change behaviour.
    // `new Date()` with no args is pinned; every explicit form (parse,
    // timestamp, y/m/d) keeps working exactly as before.
    const FrozenDate = new Proxy(RealDate, {
      construct: (target, args) => Reflect.construct(target, args.length === 0 ? [fixed] : args),
      get: (target, prop, receiver) => (prop === 'now' ? () => fixed : Reflect.get(target, prop, receiver)),
    });
    globalThis.Date = FrozenDate;

    // mulberry32: tiny, fixed-seed PRNG. Same sequence on every run.
    let seed = 0x9e3779b9;
    Math.random = () => {
      seed |= 0;
      seed = (seed + 0x6d2b79f5) | 0;
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };

    if (globalThis.performance) {
      globalThis.performance.now = () => 0;
    }
  }, at.toISOString());
}

/**
 * Kill every animation, transition and caret so paint is a pure function of
 * state. Re-applied after each navigation because a new document drops it.
 */
export async function freezeMotion(page: Page): Promise<void> {
  await page.addStyleTag({
    content: `*, *::before, *::after {
        animation: none !important;
        animation-duration: 0s !important;
        animation-delay: 0s !important;
        animation-play-state: paused !important;
        transition: none !important;
        transition-duration: 0s !important;
        transition-delay: 0s !important;
        caret-color: transparent !important;
        scroll-behavior: auto !important;
      }
      video, canvas { visibility: hidden !important; }`,
  });
}

/**
 * A signature of everything on the page that can change what gets painted.
 *
 * `innerText` alone is not enough: the home input runs a typewriter effect that
 * fills the `placeholder` **attribute** one character at a time
 * (`useTypewriterPlaceholder.ts`). That is invisible to `innerText` but plainly
 * visible in pixels, so a settle check watching only text declares the page
 * quiet while it is still visibly typing - and the screenshot pair then
 * disagrees. Placeholders, field values and image load state are included for
 * that reason.
 */
async function paintSignature(page: Page): Promise<string> {
  return page
    .evaluate(() => {
      const text = document.body?.innerText ?? '';
      const fields = Array.from(document.querySelectorAll('input, textarea'))
        .map((el) => {
          const f = el as HTMLInputElement | HTMLTextAreaElement;
          return `${f.placeholder ?? ''}${f.value ?? ''}`;
        })
        .join('');
      const images = Array.from(document.images)
        .map((img) => `${img.currentSrc}:${img.complete ? 1 : 0}`)
        .join('');
      const scroll = `${window.scrollX},${window.scrollY}`;
      return [text, fields, images, scroll].join('');
    })
    .catch(() => '');
}

/**
 * Wait until nothing that affects paint has changed for `quietMs`, then until
 * webfonts are ready.
 *
 * Async data (agent lists, health pills) lands after first paint and shifts
 * layout, so we poll for a quiet period instead of sleeping a guessed amount.
 */
export async function waitForSettle(page: Page, quietMs = 1_500, timeoutMs = 90_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let previous = '';
  let quietSince = 0;

  while (Date.now() < deadline) {
    const current = await paintSignature(page);
    if (current === previous && current.length > 0) {
      if (!quietSince) quietSince = Date.now();
      if (Date.now() - quietSince >= quietMs) break;
    } else {
      quietSince = 0;
      previous = current;
    }
    await new Promise((r) => setTimeout(r, 200));
  }

  await page.evaluate(() => document.fonts?.ready).catch(() => {});
}

/**
 * Apply every stabilisation step in the order a screen needs them.
 * Call after navigating to (or forcing the state of) the screen under test.
 */
export async function stabilize(page: Page): Promise<void> {
  await assertStableViewport(page);
  await waitForSettle(page);
  await freezeMotion(page);
  // One more short settle: freezing motion can snap in-flight transitions to
  // their end state, which is itself a paint change.
  await new Promise((r) => setTimeout(r, 400));
}

/**
 * Screenshot twice and require the two to be byte-identical.
 *
 * This is a self-check on determinism: if a screen cannot reproduce itself
 * within a single run it can never be a stable baseline, and we want that
 * reported as "this screen is unstable" rather than as a spurious pixel diff.
 */
export async function stableScreenshot(page: Page, opts: { fullPage?: boolean } = {}): Promise<Buffer> {
  const first = await page.screenshot({ fullPage: opts.fullPage ?? false, animations: 'disabled' });
  await new Promise((r) => setTimeout(r, 700));
  const second = await page.screenshot({ fullPage: opts.fullPage ?? false, animations: 'disabled' });

  if (Buffer.compare(first, second) !== 0) {
    throw new Error(
      `visual fixture: screen is not self-reproducible - two screenshots 700ms apart differed ` +
        `(${first.length} vs ${second.length} bytes). Something on this screen is still animating, ` +
        `polling, or clock-dependent; pin it before capturing a baseline.`
    );
  }
  return first;
}

/**
 * Quit an app but leave its profile on disk, so it can be relaunched with
 * `launchVisualApp({}, { reuseRunRoot })`. Callers must still finish with
 * {@link closeVisualApp} to remove the directory.
 */
export async function quitVisualApp(visual: VisualApp): Promise<void> {
  await reapVisualApp(visual.app);
}

/** Close an app and remove its isolated profile. */
export async function closeVisualApp(visual: VisualApp): Promise<void> {
  await quitVisualApp(visual);
  runRoots.delete(visual.runRoot);
  // Windows keeps a directory busy for a moment after the last handle on it is
  // released, and an EBUSY here would fail `afterAll` - reporting a teardown
  // problem as a test failure. The directory lives under the OS temp dir, so
  // giving up on it is harmless; failing the spec over it is not.
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      fs.rmSync(visual.runRoot, { recursive: true, force: true });
      return;
    } catch {
      // eslint-disable-next-line no-await-in-loop
      await delay(500);
    }
  }
}
