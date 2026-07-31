import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests/e2e',
  testMatch: '{specs,features}/**/*.e2e.ts',
  timeout: 60_000,
  expect: { timeout: 10_000 },
  fullyParallel: false, // Electron tests share one app instance
  retries: process.env.CI ? 1 : 0,
  workers: 1, // Must be 1: tests share a singleton Electron app instance
  // Visual baselines are OS-specific: font rasterisation, scrollbars and
  // control metrics differ per platform, so a Windows baseline can never match
  // a Linux run. Scoping the path by platform makes that explicit instead of
  // surfacing as a mystery diff on CI.
  snapshotPathTemplate: '{testDir}/visual/__baselines__/{platform}/{arg}{ext}',
  projects: [
    { name: 'e2e', testMatch: '{specs,features}/**/*.e2e.ts' },
    {
      name: 'visual',
      testMatch: 'visual/**/*.visual.ts',
      // Never retry a visual test: a pass-on-retry would hide exactly the
      // non-determinism this suite exists to catch.
      retries: 0,
      timeout: 300_000, // cold Electron launch is ~80s before any assertion
    },
  ],
  reporter: process.env.CI
    ? [['github'], ['html', { open: 'never', outputFolder: 'tests/e2e/report' }]]
    : [['list'], ['html', { open: 'never', outputFolder: 'tests/e2e/report' }]],
  use: {
    trace: 'on-first-retry',
    // screenshot/video are handled by our custom Electron fixture (see fixtures.ts)
    // since Playwright's built-in auto-screenshot requires its own `page` fixture.
    screenshot: 'only-on-failure',
    video: 'on-first-retry',
  },
  outputDir: 'tests/e2e/results',
});
