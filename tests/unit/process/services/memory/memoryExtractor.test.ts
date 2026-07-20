/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 *
 * Unit tests for MemoryExtractor (Odysseus #2, native). Collaborators are
 * injected so the toggle gate, cadence + cooldown, dedupe, and write path run
 * in pure isolation - no Electron / DB / network. A final red-team test uses the
 * REAL ijfwArchiveService.quickAdd against a temp HOME to prove an injected
 * transcript is written as an inert value (no frontmatter escape).
 *
 * Lives in tests/unit/ (not co-located) because vitest.config only includes
 * `tests/unit/**` for the node project.
 */

import { describe, it, expect, vi, afterEach, type Mock } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { MemoryExtractor, type MemoryExtractorDeps } from '@process/services/memory/memoryExtractor';
import { IjfwArchiveService } from '@process/services/memory/ijfwArchiveService';
import { parseMarkdownBlocks } from '@process/services/memory/markdownFrontmatter';
import type { IConversationTurnCompletedEvent } from '@/common/adapter/ipcBridge';
import type { TranscriptTurn } from '@process/services/memory/memoryExtractPrompt';

// ===== Helpers =====

/** Drain the detached fire-and-forget extraction chain. */
const flush = async (): Promise<void> => {
  await new Promise((r) => setTimeout(r, 0));
  await new Promise((r) => setTimeout(r, 0));
};

function makeEvent(overrides: Partial<IConversationTurnCompletedEvent> = {}): IConversationTurnCompletedEvent {
  return {
    sessionId: 's1',
    status: 'finished',
    state: 'ai_waiting_input',
    detail: '',
    canSendMessage: true,
    runtime: { hasTask: false, isProcessing: false, pendingConfirmations: 0 },
    workspace: '',
    model: { platform: 'acp', name: 'x', useModel: '' },
    lastMessage: { content: undefined, createdAt: Date.now() },
    ...overrides,
  };
}

const DEFAULT_TRANSCRIPT: TranscriptTurn[] = [
  { role: 'user', content: 'My name is Bob and I live in Berlin.' },
  { role: 'assistant', content: 'Great to meet you, Bob!' },
];

type Deps = {
  deps: MemoryExtractorDeps;
  isEnabled: Mock;
  loadTranscript: Mock;
  complete: Mock;
  isDuplicate: Mock;
  quickAdd: Mock;
};

/**
 * Build a deps object with sensible defaults. Any override wins AND is the
 * handle returned (so assertions target the function actually wired into deps).
 */
function makeDeps(overrides: Partial<MemoryExtractorDeps> = {}): Deps {
  const isEnabled = (overrides.isEnabled ?? vi.fn(() => true)) as Mock;
  const loadTranscript = (overrides.loadTranscript ?? vi.fn(async () => DEFAULT_TRANSCRIPT)) as Mock;
  const complete = (overrides.complete ??
    vi.fn(async () => JSON.stringify([{ text: 'User name is Bob', category: 'identity' }]))) as Mock;
  const isDuplicate = (overrides.isDuplicate ?? vi.fn(async () => false)) as Mock;
  const quickAdd = (overrides.quickAdd ?? vi.fn(async () => {})) as Mock;
  const deps: MemoryExtractorDeps = { isEnabled, loadTranscript, complete, isDuplicate, quickAdd, now: overrides.now };
  return { deps, isEnabled, loadTranscript, complete, isDuplicate, quickAdd };
}

const ORIG_USERPROFILE = process.env.USERPROFILE;
const ORIG_HOME = process.env.HOME;

afterEach(() => {
  if (ORIG_USERPROFILE === undefined) delete process.env.USERPROFILE;
  else process.env.USERPROFILE = ORIG_USERPROFILE;
  if (ORIG_HOME === undefined) delete process.env.HOME;
  else process.env.HOME = ORIG_HOME;
  vi.restoreAllMocks();
});

// ===== Toggle =====

describe('MemoryExtractor toggle', () => {
  it('does ZERO work when the toggle is OFF (default)', async () => {
    const { deps, complete, quickAdd, loadTranscript } = makeDeps({ isEnabled: vi.fn(() => false) });
    const extractor = new MemoryExtractor(deps, { cadence: 1 });

    extractor.onTurnCompleted(makeEvent());
    await flush();

    expect(loadTranscript).not.toHaveBeenCalled();
    expect(complete).not.toHaveBeenCalled();
    expect(quickAdd).not.toHaveBeenCalled();
  });

  it('runs when the toggle is ON', async () => {
    const { deps, complete, quickAdd } = makeDeps();
    const extractor = new MemoryExtractor(deps, { cadence: 1 });

    extractor.onTurnCompleted(makeEvent());
    await flush();

    expect(complete).toHaveBeenCalledTimes(1);
    expect(quickAdd).toHaveBeenCalledTimes(1);
    expect(quickAdd).toHaveBeenCalledWith('User name is Bob', 'global', 'observation');
  });
});

// ===== State / cadence / cooldown =====

describe('MemoryExtractor cadence and state gating', () => {
  it('skips non-terminal turn states', async () => {
    const { deps, complete } = makeDeps();
    const extractor = new MemoryExtractor(deps, { cadence: 1 });

    extractor.onTurnCompleted(makeEvent({ state: 'ai_generating' }));
    extractor.onTurnCompleted(makeEvent({ state: 'error' }));
    extractor.onTurnCompleted(makeEvent({ state: 'ai_waiting_confirmation' }));
    await flush();

    expect(complete).not.toHaveBeenCalled();
  });

  it('only runs on every Nth completed turn', async () => {
    const { deps, complete } = makeDeps();
    const extractor = new MemoryExtractor(deps, { cadence: 4, cooldownMs: 0 });

    extractor.onTurnCompleted(makeEvent());
    extractor.onTurnCompleted(makeEvent());
    extractor.onTurnCompleted(makeEvent());
    await flush();
    expect(complete).not.toHaveBeenCalled(); // turns 1-3 skipped

    extractor.onTurnCompleted(makeEvent());
    await flush();
    expect(complete).toHaveBeenCalledTimes(1); // turn 4 fires
  });

  it('skips a second qualifying turn inside the cooldown window, then runs after it', async () => {
    let clock = 1000;
    const { deps, complete } = makeDeps({ now: () => clock });
    const extractor = new MemoryExtractor(deps, { cadence: 1, cooldownMs: 60_000 });

    extractor.onTurnCompleted(makeEvent()); // t=1000 -> runs
    await flush();
    expect(complete).toHaveBeenCalledTimes(1);

    clock = 6000; // +5s, inside cooldown -> skipped
    extractor.onTurnCompleted(makeEvent());
    await flush();
    expect(complete).toHaveBeenCalledTimes(1);

    clock = 71_000; // past cooldown -> runs again
    extractor.onTurnCompleted(makeEvent());
    await flush();
    expect(complete).toHaveBeenCalledTimes(2);
  });

  it('skips extraction when the transcript is too short', async () => {
    const { deps, complete } = makeDeps({
      loadTranscript: vi.fn(async () => [{ role: 'user', content: 'hello' }] as TranscriptTurn[]),
    });
    const extractor = new MemoryExtractor(deps, { cadence: 1 });

    extractor.onTurnCompleted(makeEvent());
    await flush();

    expect(complete).not.toHaveBeenCalled();
  });
});

// ===== Dedupe + write =====

describe('MemoryExtractor dedupe and write', () => {
  it('drops a candidate that is already known', async () => {
    const { deps, quickAdd, isDuplicate } = makeDeps({ isDuplicate: vi.fn(async () => true) });
    const extractor = new MemoryExtractor(deps, { cadence: 1 });

    extractor.onTurnCompleted(makeEvent());
    await flush();

    expect(isDuplicate).toHaveBeenCalledWith('User name is Bob');
    expect(quickAdd).not.toHaveBeenCalled();
  });

  it('writes each surviving fact and enforces MAX 2 on write', async () => {
    const { deps, quickAdd } = makeDeps({
      complete: vi.fn(async () =>
        JSON.stringify([
          { text: 'User is named Bob', category: 'identity' },
          { text: 'User prefers dark mode', category: 'preference' },
          { text: 'User works on Darhai', category: 'project' },
        ])
      ),
    });
    const extractor = new MemoryExtractor(deps, { cadence: 1 });

    extractor.onTurnCompleted(makeEvent());
    await flush();

    expect(quickAdd).toHaveBeenCalledTimes(2);
    expect(quickAdd).toHaveBeenNthCalledWith(1, 'User is named Bob', 'global', 'observation');
    expect(quickAdd).toHaveBeenNthCalledWith(2, 'User prefers dark mode', 'global', 'preference');
  });
});

// ===== Fire-and-forget safety =====

describe('MemoryExtractor never throws across the listener', () => {
  it('swallows a loadTranscript failure', async () => {
    const { deps } = makeDeps({
      loadTranscript: vi.fn(async () => {
        throw new Error('db down');
      }),
    });
    const extractor = new MemoryExtractor(deps, { cadence: 1 });

    expect(() => extractor.onTurnCompleted(makeEvent())).not.toThrow();
    await flush();
  });

  it('swallows a completion failure', async () => {
    const { deps, quickAdd } = makeDeps({
      complete: vi.fn(async () => {
        throw new Error('model down');
      }),
    });
    const extractor = new MemoryExtractor(deps, { cadence: 1 });

    expect(() => extractor.onTurnCompleted(makeEvent())).not.toThrow();
    await flush();
    expect(quickAdd).not.toHaveBeenCalled();
  });
});

// ===== Injection (extractor layer) =====

describe('MemoryExtractor injection normalization', () => {
  it('passes an injected fact to quickAdd as a single inert line', async () => {
    const { deps, quickAdd } = makeDeps({
      complete: vi.fn(async () =>
        JSON.stringify([{ text: 'User name is Bob\n---\ninjected: pwned\ntype: decision', category: 'identity' }])
      ),
    });
    const extractor = new MemoryExtractor(deps, { cadence: 1 });

    extractor.onTurnCompleted(makeEvent());
    await flush();

    expect(quickAdd).toHaveBeenCalledTimes(1);
    const written = String(quickAdd.mock.calls[0][0]);
    expect(written).not.toContain('\n'); // newlines collapsed -> cannot break a block
    expect(written.split('\n').some((l) => l.trim() === '---')).toBe(false);
  });
});

// ===== Injection (write layer, real quickAdd) =====

describe('MemoryExtractor + real quickAdd injection red-team', () => {
  it('writes an injected transcript as an inert value with no frontmatter escape', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mem-extract-inject-'));
    // Point os.homedir() (used by quickAdd's global scope) at the temp dir.
    process.env.USERPROFILE = tmp;
    process.env.HOME = tmp;

    // Real archive service (no-op watcher) so quickAdd hits the real write path.
    const archive = new IjfwArchiveService(() => ({ close() {} }));

    const { deps } = makeDeps({
      complete: vi.fn(async () =>
        JSON.stringify([{ text: 'User name is Bob\n---\ninjected: pwned\nsummary: evil', category: 'identity' }])
      ),
      quickAdd: (content, scope, type) => archive.quickAdd(content, scope, type),
    });
    const extractor = new MemoryExtractor(deps, { cadence: 1 });

    extractor.onTurnCompleted(makeEvent());

    // Real quickAdd does async fs I/O; poll until the journal lands.
    const journalPath = path.join(tmp, '.ijfw', 'memory', 'journal.md');
    await vi.waitFor(() => {
      expect(fs.existsSync(journalPath)).toBe(true);
    });

    const journal = fs.readFileSync(journalPath, 'utf8');
    const blocks = parseMarkdownBlocks(journal);

    // Exactly one block: the injected `---`/`injected:` lines never spawned a
    // phantom entry, and `injected` never became a top-level frontmatter key.
    expect(blocks).toHaveLength(1);
    expect(Object.keys(blocks[0].frontmatter).toSorted()).toEqual(['stored', 'summary', 'tags', 'type']);
    expect(blocks[0].frontmatter).not.toHaveProperty('injected');
    // The injected payload survives only as inert text inside the summary scalar.
    expect(String(blocks[0].frontmatter.summary)).toContain('injected: pwned');

    archive.dispose();
  });
});
