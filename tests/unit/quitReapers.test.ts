/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Regression guard for the synchronous quit reapers.
 *
 * The `will-quit` barrier gives the async cleanup its time, but it can only do
 * that on the ORDINARY quit path. `app.exit()` emits neither `before-quit` nor
 * `will-quit`, and the app calls it on the `uncaughtException` handler, on the
 * init-failure path, and from outside (the E2E fixture). On every one of those
 * the SQLite handle was simply abandoned: in WAL mode the `-wal`/`-shm`
 * sidecars survive with un-checkpointed pages, which is the state in which a
 * power loss costs the user data.
 *
 * `closeDatabase()` is synchronous by design (its own comment says it is safe
 * to call from `process.on('exit')`), so the guarantee is one blocking
 * checkpoint at the very end of the process's life.
 */
import { describe, test, expect, vi, beforeEach } from 'vitest';

const closeDatabase = vi.fn();
const reapAgentChildrenSync = vi.fn(() => 0);
const appHandlers = new Map<string, () => void>();

vi.mock('electron', () => ({
  app: {
    on: (event: string, handler: () => void) => {
      appHandlers.set(event, handler);
    },
  },
}));

vi.mock('@process/services/database/export', () => ({
  closeDatabase: () => closeDatabase(),
}));

vi.mock('@process/agent/childRegistry', () => ({
  reapAgentChildrenSync: () => reapAgentChildrenSync(),
}));

/** Import fresh each time so the module's "registered once" latch is reset. */
async function loadModule(): Promise<typeof import('../../src/process/utils/quitReapers')> {
  vi.resetModules();
  return import('../../src/process/utils/quitReapers');
}

/** Every `process.on('exit')` listener the module under test installed. */
function processExitHandlers(before: ReadonlyArray<unknown>): Array<() => void> {
  return (process.listeners('exit') as Array<() => void>).filter((fn) => !before.includes(fn));
}

describe('registerSyncQuitReapers', () => {
  beforeEach(() => {
    closeDatabase.mockClear();
    reapAgentChildrenSync.mockClear();
    reapAgentChildrenSync.mockReturnValue(0);
    appHandlers.clear();
  });

  test("closes the database from process 'exit', which app.exit() reaches and will-quit does not", async () => {
    const before = process.listeners('exit');
    const { registerSyncQuitReapers } = await loadModule();
    registerSyncQuitReapers();

    const installed = processExitHandlers(before);
    try {
      expect(installed, "no process 'exit' handler was installed").toHaveLength(1);
      installed[0]();
      expect(closeDatabase).toHaveBeenCalledTimes(1);
    } finally {
      for (const fn of installed) process.off('exit', fn);
    }
  });

  test("also closes it from app 'quit', so the ordinary path is covered twice", async () => {
    const before = process.listeners('exit');
    const { registerSyncQuitReapers } = await loadModule();
    registerSyncQuitReapers();
    const installed = processExitHandlers(before);

    try {
      const onQuit = appHandlers.get('quit');
      expect(onQuit, "no app 'quit' handler was installed").toBeDefined();
      onQuit?.();
      expect(closeDatabase).toHaveBeenCalledTimes(1);
    } finally {
      for (const fn of installed) process.off('exit', fn);
    }
  });

  test("reaps engine children from process 'exit', the path app.exit() takes", async () => {
    // wcore / ACP / the OpenClaw gateway outlive an app.exit() for exactly the
    // reason the database handle did: nothing on that path tears them down. On
    // Windows a survivor holds files in the install directory, which is what
    // makes the next update or uninstall fail.
    const before = process.listeners('exit');
    reapAgentChildrenSync.mockReturnValue(2);
    const warns = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { registerSyncQuitReapers } = await loadModule();
    registerSyncQuitReapers();

    const installed = processExitHandlers(before);
    try {
      installed[0]();
      expect(reapAgentChildrenSync).toHaveBeenCalledTimes(1);
      expect(warns).toHaveBeenCalled();
    } finally {
      warns.mockRestore();
      for (const fn of installed) process.off('exit', fn);
    }
  });

  test('reaps engine children even when closing the database throws first', async () => {
    // The two reapers are independent; one failing must not skip the other.
    const before = process.listeners('exit');
    closeDatabase.mockImplementation(() => {
      throw new Error('database is locked');
    });
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { registerSyncQuitReapers } = await loadModule();
    registerSyncQuitReapers();

    const installed = processExitHandlers(before);
    try {
      installed[0]();
      expect(reapAgentChildrenSync).toHaveBeenCalledTimes(1);
    } finally {
      errors.mockRestore();
      closeDatabase.mockReset();
      for (const fn of installed) process.off('exit', fn);
    }
  });

  test('never throws out of an exit handler when the child reap fails', async () => {
    const before = process.listeners('exit');
    reapAgentChildrenSync.mockImplementation(() => {
      throw new Error('taskkill exploded');
    });
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { registerSyncQuitReapers } = await loadModule();
    registerSyncQuitReapers();

    const installed = processExitHandlers(before);
    try {
      expect(() => installed[0]()).not.toThrow();
      expect(errors).toHaveBeenCalled();
    } finally {
      errors.mockRestore();
      reapAgentChildrenSync.mockReset();
      reapAgentChildrenSync.mockReturnValue(0);
      for (const fn of installed) process.off('exit', fn);
    }
  });

  test('registers once, however many times it is called', async () => {
    const before = process.listeners('exit');
    const { registerSyncQuitReapers } = await loadModule();
    registerSyncQuitReapers();
    registerSyncQuitReapers();
    registerSyncQuitReapers();

    const installed = processExitHandlers(before);
    try {
      expect(installed).toHaveLength(1);
    } finally {
      for (const fn of installed) process.off('exit', fn);
    }
  });

  test('never throws out of an exit handler, even when the close fails', async () => {
    const before = process.listeners('exit');
    closeDatabase.mockImplementation(() => {
      throw new Error('database is locked');
    });
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { registerSyncQuitReapers } = await loadModule();
    registerSyncQuitReapers();
    const installed = processExitHandlers(before);

    try {
      // A throw here would replace the real exit reason with this one.
      expect(() => installed[0]()).not.toThrow();
      expect(errors).toHaveBeenCalled();
    } finally {
      for (const fn of installed) process.off('exit', fn);
      errors.mockRestore();
      closeDatabase.mockReset();
    }
  });
});
