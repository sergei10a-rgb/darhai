import { defineConfig } from 'vitest/config';
import path from 'path';
import { OS_RESOURCE_TESTS } from './tests/osResourceTests';

const aliases = {
  '@/': path.resolve(__dirname, './src') + '/',
  '@process/': path.resolve(__dirname, './src/process') + '/',
  '@renderer/': path.resolve(__dirname, './src/renderer') + '/',
  '@worker/': path.resolve(__dirname, './src/process/worker') + '/',
  '@mcp/models/': path.resolve(__dirname, './src/common/models') + '/',
  '@mcp/types/': path.resolve(__dirname, './src/common') + '/',
  '@mcp/': path.resolve(__dirname, './src/common') + '/',
};

/**
 * Test files that drive REAL operating-system resources: they bind loopback
 * TCP/HTTP sockets, or spawn/exec real child processes, rather than mocking
 * those boundaries.
 *
 * Why they need their own lane
 * ----------------------------
 * The default pool runs one fork per logical CPU (24 here), and each fork also
 * transforms its own module graph - a full run of this suite spends ~1500 s of
 * CPU inside ~80 s of wall clock, i.e. the host is ~19x oversubscribed for the
 * whole run. Pure-JS tests only get slower under that; tests that talk to the
 * kernel start *failing*, because their deadlines stop being met:
 *
 *   - `tests/integration/team-stress-tcp.test.ts` failed every test in the file
 *     with `Error: connect ETIMEDOUT 127.0.0.1:<port>` - a loopback connect that
 *     normally completes in microseconds never completing at all.
 *   - `tests/unit/omnirouteGateway/killProcessTree.test.ts` reported a port it
 *     had just proved was listening as unserved, because its connect probe gave
 *     up first.
 *
 * Those runs are indistinguishable from a real regression, and they came and
 * went run to run (measured: 20 failures, then 2, then 0, then 0 on the same
 * commit). `sequence.groupOrder` puts this project in its own group, so it runs
 * only after every other project has finished, and `fileParallelism: false`
 * keeps it to one file at a time. These files then measure the code under test
 * on a quiet machine instead of measuring the scheduler.
 *
 * Adding a test that binds a socket or spawns a process? Add it to
 * `tests/osResourceTests.ts`. `tests/unit/vitestIoLane.test.ts` fails the build
 * if you forget.
 */

export default defineConfig({
  resolve: {
    alias: aliases,
  },
  test: {
    globals: true,
    /**
     * 60 s. Raised from 30 s, which had itself been raised from 10 s.
     *
     * This budget is not "how long may this behaviour take" - almost every test
     * here finishes in milliseconds. It is "how long may this fork wait to be
     * scheduled". A full run of this suite spends 1500-3000 s of CPU inside
     * 80-230 s of wall clock across 24 forks, and most of that is Vite
     * transforming and importing module graphs, so a single `await import(...)`
     * inside a test body can sit for tens of seconds behind other forks doing
     * the same thing. At 10 s that surfaced as `Test timed out in 10000ms` in
     * whichever import-heavy file lost the draw that run - which is
     * indistinguishable from a real hang and moves from run to run.
     *
     * MEASURED, not raised by feel. Two consecutive full runs failed exactly
     * four tests - the same four both times, all `Test timed out in 30000ms` -
     * and all four passed in ~5 s when their files ran alone. Re-running the
     * whole suite with the ceiling temporarily at 300 s, to observe what the
     * work actually costs rather than when it gives up:
     *
     *   ChannelModelSelectionRestore.dom  16.6 s   <- slowest test in the suite
     *   skillLibraryRescan                15.8 s   <- had timed out at 30 s
     *   skillResolverSync                 15.6 s   <- had timed out at 30 s
     *   skillRecall                       15.1 s
     *   autoUpdate.integration             9.6 s   <- had timed out at 30 s
     *   updateBridgeCdnRewrite             9.4 s   <- had timed out at 30 s
     *
     * The same work therefore varies about 2x with scheduling luck: 15.8 s on a
     * lucky run, past 30 s on an unlucky one. 30 s left the slowest files under
     * 2x of headroom, which cannot absorb a 2x spread - and the suite only
     * grows (1122 -> 1126 files, 13,586 tests at the time of measuring). 60 s
     * is ~3.6x the slowest measured test, and is what the `io` project below
     * already uses for the same reason.
     *
     * Raising it changes no assertion: a test that genuinely never completes
     * still fails, 30 s later. It only stops the suite from reporting the
     * machine's load as a product defect. If four tests time out again at 60 s,
     * that is a real regression - re-measure rather than raise it again.
     */
    testTimeout: 60_000,
    hookTimeout: 60_000,
    // Use projects to run different environments (Vitest 4+)
    projects: [
      // Node environment tests (existing tests)
      {
        extends: true,
        test: {
          name: 'node',
          environment: 'node',
          include: [
            'tests/unit/**/*.test.ts',
            'tests/unit/**/test_*.ts',
            'tests/integration/**/*.test.ts',
            'tests/regression/**/*.test.ts',
          ],
          exclude: ['tests/unit/**/*.dom.test.ts', 'tests/unit/**/*.dom.test.tsx', ...OS_RESOURCE_TESTS],
          setupFiles: ['./tests/vitest.setup.ts'],
        },
      },
      // Real-OS-resource tests: own group, one file at a time. See OS_RESOURCE_TESTS.
      {
        extends: true,
        test: {
          name: 'io',
          environment: 'node',
          include: [...OS_RESOURCE_TESTS],
          setupFiles: ['./tests/vitest.setup.ts'],
          fileParallelism: false,
          sequence: { groupOrder: 1 },
          // These tests wait on the OS, not on JS. The default 10 s encodes an
          // idle machine; a starved fork blows through it while the server is
          // perfectly healthy. Assertions are unchanged - only the patience is.
          testTimeout: 60_000,
          hookTimeout: 60_000,
        },
      },
      // jsdom environment tests (React component/hook tests)
      {
        extends: true,
        test: {
          name: 'dom',
          environment: 'jsdom',
          include: [
            'tests/unit/**/*.dom.test.ts',
            'tests/unit/**/*.dom.test.tsx',
            'src/renderer/components/layout/PageShell/PageShell.test.tsx',
          ],
          setupFiles: ['./tests/vitest.dom.setup.ts'],
        },
      },
    ],
    benchmark: {
      include: ['tests/bench/**/*.bench.ts'],
      outputFile: './bench-results.json',
    },
    coverage: {
      provider: 'v8',
      reporter: ['text', 'text-summary', 'html', 'lcov'],
      reportsDirectory: './coverage',
      // Cover ALL source code by default - new files are automatically included.
      // Only exclude files that genuinely cannot be unit-tested (entry points,
      // type-only files, static assets, etc.).
      include: ['src/**/*.{ts,tsx}', 'scripts/prepareBundledBun.js'],
      exclude: [
        // Type declaration files (no runtime code)
        'src/**/*.d.ts',

        // Electron entry points (require Electron runtime)
        'src/index.ts',
        'src/preload.ts',

        // Shims / polyfills
        'src/common/utils/shims/**',

        // Pure type / constant files
        'src/common/types/**',

        // Static assets and i18n JSON (no logic)
        'src/renderer/**/*.json',
        'src/renderer/**/*.svg',
        'src/renderer/**/*.css',

        // i18n config (JSON-only)
        'src/common/config/i18n-config.json',
      ],
      // Thresholds apply to the included file set.
      // Keeping them informational until coverage ramps up across all files.
      thresholds: {
        statements: 0,
        branches: 0,
        functions: 0,
        lines: 0,
      },
    },
  },
});
