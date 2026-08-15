/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * The one press, and the things it is not allowed to lie about.
 *
 * The product claim is that a person installs Darhai and nothing else, presses
 * the button next to a model, and it runs. That makes this cell the place where
 * these honesty rules are either kept or broken:
 *
 *   1. The user is never told to go install llama.cpp, and no string names it,
 *      a build variant or a quant. The verb stays "Serve".
 *   2. If the machine is about to be handed a CPU build, it is told BEFORE the
 *      download - so `plan()` must run and be rendered before `install()` is
 *      ever called, and the copy must carry the size AND what the hardware gets.
 *   3. No percentage is shown that was not measured against the work left. The
 *      verify/unpack/install tail is 14.3 s of the reference machine's 20.6 s
 *      install, and a bar driven by download bytes reads 100% through all of it.
 *   4. Both stages of the wait are labelled as themselves, and any stage that
 *      offers Cancel is a stage where Cancel does something.
 *   5. A failure says what happened in the user's terms. An ALL-CAPS English
 *      error constant is not a sentence, and it is identical in all 13 locales.
 *   6. "No build for this machine" renders as that sentence, with no progress
 *      bar and no spinner. A spinner there is the bug this test exists for.
 *
 * The `t` mock resolves against the SHIPPED en-US bundle rather than a table
 * written here, so a key that never landed in the locale resolves to its own
 * name and the assertions fail. The last blocks extend that to all 13 locales
 * and to every key this component can reach - including the ones built from a
 * union, which is how `workflows.count` shipped rendering its own key name.
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type {
  CookbookDownloadInfo,
  CookbookDownloadProgress,
  CookbookServeStatus,
} from '../../../src/common/types/cookbook';
import type { LlamaRuntimePlan, LlamaRuntimeProgress, LlamaRuntimeStatus } from '../../../src/common/types/llamacpp';
import { LLAMA_RUNTIME_FALLBACK_CODES, LLAMA_RUNTIME_NOTE_CODES } from '../../../src/common/types/llamacpp';

const LOCALES_DIR = join(process.cwd(), 'src/renderer/services/i18n/locales');
const COMPONENT_PATH = join(process.cwd(), 'src/renderer/pages/model-advisor/CookbookServeControls.tsx');

/** `t`, backed by the real English bundle (see the module note). */
vi.mock('react-i18next', async () => {
  const { readFileSync: read, existsSync: exists } = await import('node:fs');
  const { join: joinPath } = await import('node:path');
  const dir = joinPath(process.cwd(), 'src/renderer/services/i18n/locales/en-US');

  return {
    useTranslation: () => ({
      t: (key: string, options?: Record<string, unknown>) => {
        const [namespace, ...path] = key.split('.');
        const file = joinPath(dir, `${namespace}.json`);
        let node: unknown = exists(file) ? JSON.parse(read(file, 'utf-8')) : undefined;
        for (const segment of path) {
          node = node && typeof node === 'object' ? (node as Record<string, unknown>)[segment] : undefined;
        }
        let out = typeof node === 'string' ? node : key;
        for (const [name, value] of Object.entries(options ?? {})) {
          out = out.replace(new RegExp(`{{${name}}}`, 'g'), String(value));
        }
        return out;
      },
    }),
  };
});

// FileService drags in the IPC bridge and the CSRF client; only the byte
// formatter is used here, and it is re-stated rather than stubbed to a
// placeholder so the rendered size is a real formatting of real bytes.
vi.mock('../../../src/renderer/services/FileService', () => ({
  formatFileSize: (bytes: number) => {
    if (bytes === 0) return '0 Bytes';
    const units = ['Bytes', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(1024));
    return `${parseFloat((bytes / Math.pow(1024, i)).toFixed(2))} ${units[i]}`;
  },
}));

import CookbookServeControls, {
  ACCEL_LABEL_KEY,
  FALLBACK_LABEL_KEY,
  NOTE_LABEL_KEY,
  PHASE_LABEL_KEY,
  PROBLEM_KEY,
  PROBLEM_UNKNOWN_KEY,
} from '../../../src/renderer/pages/model-advisor/CookbookServeControls';
import type { CookbookController } from '../../../src/renderer/pages/model-advisor/useCookbookServe';
import type { LlamaRuntimeUiController } from '../../../src/renderer/pages/model-advisor/useLlamaRuntime';

const MODEL = 'org/Model-7B';
const SUPPORTED_LOCALES = [
  'en-US',
  'es-ES',
  'fr-FR',
  'de-DE',
  'pt-BR',
  'zh-CN',
  'zh-TW',
  'ja-JP',
  'ko-KR',
  'ru-RU',
  'uk-UA',
  'tr-TR',
  'mn-MN',
];

/** The same lookup the mock does, for assertions. */
function en(key: string): string {
  const [namespace, ...path] = key.split('.');
  const file = join(LOCALES_DIR, 'en-US', `${namespace}.json`);
  let node: unknown = existsSync(file) ? JSON.parse(readFileSync(file, 'utf-8')) : undefined;
  for (const segment of path) {
    node = node && typeof node === 'object' ? (node as Record<string, unknown>)[segment] : undefined;
  }
  if (typeof node !== 'string') throw new Error(`en-US has no string at "${key}"`);
  return node;
}

const IDLE_SERVE: CookbookServeStatus = {
  state: 'idle',
  modelId: null,
  backend: 'none',
  port: null,
  providerId: null,
  servedModel: null,
};

const MISSING_RUNTIME: LlamaRuntimeStatus = {
  state: 'missing',
  tag: null,
  serverPath: null,
  acceleration: null,
  fallbackCode: null,
  progress: null,
  errorCode: null,
  errorMessage: null,
};

const READY_RUNTIME: LlamaRuntimeStatus = { ...MISSING_RUNTIME, state: 'ready', tag: 'b10437' };

/** A runtime progress frame in one phase, with the byte totals it would carry. */
function progressAt(over: Partial<LlamaRuntimeProgress>): LlamaRuntimeProgress {
  return {
    phase: 'downloading',
    assetName: 'llama-b10437-bin-win-cuda-x64.zip',
    assetIndex: 1,
    assetCount: 1,
    bytesDone: 0,
    bytesTotal: null,
    totalBytesDone: 0,
    totalBytesTotal: null,
    ...over,
  };
}

/** A host with NO backend installed - the machine this whole feature is for. */
function makeCookbook(over: Partial<CookbookController> = {}): CookbookController {
  return {
    backend: 'none',
    // A bare machine: nothing installed, and Darhai's own llama.cpp installable.
    selection: { chosen: 'none', viable: [], provisionable: ['llama-server'] },
    serveStatus: IDLE_SERVE,
    downloads: {},
    progress: {},
    download: vi.fn(async () => undefined),
    cancelDownload: vi.fn(async () => undefined),
    serve: vi.fn(async () => undefined),
    stopServe: vi.fn(async () => undefined),
    locateBackend: vi.fn(async () => undefined),
    refreshBackends: vi.fn(async () => undefined),
    ...over,
  };
}

function makeRuntime(over: Partial<LlamaRuntimeUiController> = {}): LlamaRuntimeUiController {
  return {
    status: MISSING_RUNTIME,
    fetchPlan: vi.fn(async () => ({ kind: 'unsupported', reason: 'unset' }) as LlamaRuntimePlan),
    install: vi.fn(async () => MISSING_RUNTIME),
    cancel: vi.fn(async () => true),
    ...over,
  };
}

const CPU_PLAN: LlamaRuntimePlan = {
  kind: 'ok',
  tag: 'b10437',
  acceleration: 'cpu',
  fallbackCode: 'NO_GPU_BUILD_FOR_TARGET',
  noteCodes: [],
  assetCount: 1,
  downloadBytes: 30 * 1024 * 1024,
  alreadyInstalled: false,
};

function renderCell(cookbook: CookbookController, runtime: LlamaRuntimeUiController): void {
  render(<CookbookServeControls modelId={MODEL} controller={cookbook} runtime={runtime} />);
}

/** Press Serve, then confirm the disclosure. Leaves the row mid-install. */
async function pressServeAndConfirm(): Promise<void> {
  await userEvent.click(screen.getByRole('button', { name: en('modelAdvisor.cookbook.serve') }));
  await waitFor(() => screen.getByRole('button', { name: en('modelAdvisor.runtime.confirm') }));
  await userEvent.click(screen.getByRole('button', { name: en('modelAdvisor.runtime.confirm') }));
}

/** A promise that never settles - holds the row in whichever stage awaits it. */
function pending<T>(): Promise<T> {
  return new Promise<T>(() => undefined);
}

/** Placeholder until the harness below captures the real rejector. */
const NOT_YET_REJECTABLE = (): void => undefined;

/** Placeholder until the harness below captures the real resolver. */
const NOT_YET_RESOLVABLE = (): void => undefined;

/** A GGUF already sitting in the cache, so the press goes straight to serve. */
const CACHED_GGUF: CookbookDownloadInfo = {
  modelId: MODEL,
  status: 'downloaded',
  bytesDownloaded: 4_000_000,
  totalBytes: 4_000_000,
  filePath: '/models/Model-7B.gguf',
};

/**
 * A cell whose serve status arrives the way the real one does: idle until the
 * serve starts, then `downloading` with live byte progress, pushed from main.
 * A static prop cannot express that transition, and it is the transition - not
 * either end of it - that the two-stage surface is about.
 */
function renderWithLiveServe(runtime: LlamaRuntimeUiController): {
  cancelDownload: ReturnType<typeof vi.fn>;
  /** Reject the in-flight serve, the way a cancelled download makes it reject. */
  failServe: (reason: Error) => void;
} {
  const cancelDownload = vi.fn(async () => undefined);
  let reject: (reason: Error) => void = NOT_YET_REJECTABLE;
  const Harness: React.FC = () => {
    const [serving, setServing] = React.useState(false);
    const cookbook = makeCookbook({
      serveStatus: serving
        ? { ...IDLE_SERVE, state: 'downloading', modelId: MODEL, backend: 'llama-server' }
        : IDLE_SERVE,
      progress: serving
        ? { [MODEL]: { modelId: MODEL, bytesDownloaded: 1_000_000, totalBytes: 4_000_000 } as CookbookDownloadProgress }
        : {},
      serve: vi.fn(async () => {
        setServing(true);
        return new Promise<void>((_resolve, rej) => {
          reject = rej;
        });
      }),
      cancelDownload,
    });
    return <CookbookServeControls modelId={MODEL} controller={cookbook} runtime={runtime} />;
  };
  render(<Harness />);
  return { cancelDownload, failServe: (reason) => reject(reason) };
}

/**
 * A cell whose serve ends the way the MAIN PROCESS really ends one.
 *
 * `CookbookServeService.serve()` is documented "Never throws - a failure is
 * reflected in the returned status" (CookbookServeService.ts:211); its catch
 * calls `fail()`, which sets `state: 'error'`, and `cookbookBridge.ts:86`
 * RETURNS that status instead of throwing. So an aborted model download reaches
 * this component as a RESOLVED serve carrying `state:'error'` - never as a
 * rejection. `renderWithLiveServe` above rejects, which is a path production
 * cannot take, so a cancel test built on it passes against broken code.
 */
function renderWithResolvedServeError(over: { runtime?: LlamaRuntimeUiController; cached?: boolean } = {}): {
  cancelDownload: ReturnType<typeof vi.fn>;
  serve: ReturnType<typeof vi.fn>;
  /** Main answers the serve with an error nobody asked for. */
  breakServe: () => void;
} {
  const cancelDownload = vi.fn(async (_id: string) => undefined);
  const serve = vi.fn(async (_id: string) => undefined);
  const runtime =
    over.runtime ?? makeRuntime({ fetchPlan: vi.fn(async () => CPU_PLAN), install: vi.fn(async () => READY_RUNTIME) });
  let stop: () => void = NOT_YET_RESOLVABLE;
  const Harness: React.FC = () => {
    const [phase, setPhase] = React.useState<'idle' | 'downloading' | 'error'>('idle');
    const finish = React.useRef<() => void>(NOT_YET_RESOLVABLE);
    const toError = (): void => {
      // Main aborts the transfer, then `serve()` RESOLVES with state:'error'.
      setPhase('error');
      finish.current();
    };
    stop = toError;
    const serving = phase === 'downloading';
    const cookbook = makeCookbook({
      downloads: over.cached === true ? { [MODEL]: CACHED_GGUF } : {},
      serveStatus:
        serving === true
          ? { ...IDLE_SERVE, state: 'downloading', modelId: MODEL, backend: 'llama-server' }
          : phase === 'error'
            ? { ...IDLE_SERVE, state: 'error', modelId: MODEL, backend: 'llama-server', error: 'download cancelled' }
            : IDLE_SERVE,
      progress: serving
        ? { [MODEL]: { modelId: MODEL, bytesDownloaded: 1_000_000, totalBytes: 4_000_000 } as CookbookDownloadProgress }
        : {},
      serve: vi.fn(async (id: string) => {
        await serve(id);
        setPhase('downloading');
        return new Promise<void>((resolve) => {
          finish.current = resolve;
        });
      }),
      cancelDownload: vi.fn(async (id: string) => {
        await cancelDownload(id);
        toError();
      }),
    });
    return <CookbookServeControls modelId={MODEL} controller={cookbook} runtime={runtime} />;
  };
  render(<Harness />);
  return {
    cancelDownload,
    serve,
    breakServe: () => {
      act(() => stop());
    },
  };
}

describe('the press never mentions llama.cpp', () => {
  it('offers Serve, not "install a backend first", when nothing is installed', () => {
    renderCell(makeCookbook(), makeRuntime());
    expect(screen.getByRole('button', { name: en('modelAdvisor.cookbook.serve') })).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/llama\.cpp/i);
  });

  it('does not offer a download before the runtime probe has answered', async () => {
    // `unknown` is the renderer's own first-frame value, not a fact from disk.
    // Reading it as "no runtime" opens the 512.8 MB disclosure - which says the
    // download is required - to a machine that may already have a backend.
    const runtime = makeRuntime({
      status: { ...MISSING_RUNTIME, state: 'unknown' },
      fetchPlan: vi.fn(async () => CPU_PLAN),
    });
    const cookbook = makeCookbook();
    renderCell(cookbook, runtime);

    await userEvent.click(screen.getByRole('button', { name: en('modelAdvisor.cookbook.serve') }));

    expect(runtime.fetchPlan).not.toHaveBeenCalled();
    expect(screen.queryByRole('button', { name: en('modelAdvisor.runtime.confirm') })).toBeNull();
  });

  it('never names llama.cpp in the disclosure, the progress or a failure', async () => {
    // Idle was the only state the old assertion covered, so five strings that
    // DID name it shipped unchecked. Walk the states a user actually reaches.
    const runtime = makeRuntime({
      fetchPlan: vi.fn(async () => CPU_PLAN),
      install: vi.fn(async () => ({
        ...MISSING_RUNTIME,
        state: 'failed' as const,
        errorCode: 'LLAMACPP_DOWNLOAD_FAILED',
        errorMessage: 'socket hang up',
      })),
    });
    renderCell(makeCookbook(), runtime);

    await userEvent.click(screen.getByRole('button', { name: en('modelAdvisor.cookbook.serve') }));
    await waitFor(() => screen.getByRole('button', { name: en('modelAdvisor.runtime.confirm') }));
    expect(document.body.textContent).not.toMatch(/llama\.cpp/i);

    await userEvent.click(screen.getByRole('button', { name: en('modelAdvisor.runtime.confirm') }));
    await waitFor(() => expect(document.body.textContent).toContain(en('modelAdvisor.runtime.problem.download')));
    // The code is still on screen for a bug report, but the SENTENCE is prose.
    expect(document.body.textContent).toContain('LLAMACPP_DOWNLOAD_FAILED');
    expect(document.body.textContent).not.toMatch(/llama\.cpp/i);
  });
});

describe('the CPU build is disclosed BEFORE the download', () => {
  it('renders what the hardware gets and the measured size, and has not installed yet', async () => {
    const runtime = makeRuntime({ fetchPlan: vi.fn(async () => CPU_PLAN) });
    renderCell(makeCookbook(), runtime);

    await userEvent.click(screen.getByRole('button', { name: en('modelAdvisor.cookbook.serve') }));

    await waitFor(() => expect(screen.getByText(/30 MB/)).toBeTruthy());
    expect(document.body.textContent).toContain(en('modelAdvisor.runtime.accel.cpu'));
    // The whole point: the disclosure is on screen and NOTHING was downloaded.
    expect(runtime.install).not.toHaveBeenCalled();
  });

  it('says the model is a second download before the first byte of the first', async () => {
    const runtime = makeRuntime({ fetchPlan: vi.fn(async () => CPU_PLAN) });
    renderCell(makeCookbook(), runtime);
    await userEvent.click(screen.getByRole('button', { name: en('modelAdvisor.cookbook.serve') }));
    await waitFor(() => expect(document.body.textContent).toContain(en('modelAdvisor.runtime.discloseNext')));
  });

  it('states why the hardware is not getting its GPU', async () => {
    const runtime = makeRuntime({ fetchPlan: vi.fn(async () => CPU_PLAN) });
    renderCell(makeCookbook(), runtime);
    await userEvent.click(screen.getByRole('button', { name: en('modelAdvisor.cookbook.serve') }));
    await waitFor(() =>
      expect(screen.getByText(en('modelAdvisor.runtime.fallback.NO_GPU_BUILD_FOR_TARGET'))).toBeTruthy()
    );
  });

  it('renders every note the plan carries, not just the fallback', async () => {
    const runtime = makeRuntime({
      fetchPlan: vi.fn(
        async (): Promise<LlamaRuntimePlan> => ({
          ...CPU_PLAN,
          fallbackCode: null,
          noteCodes: ['VULKAN_BUILD_NOT_REQUESTABLE', 'CUDA_LINE_UNVERIFIED'],
        })
      ),
    });
    renderCell(makeCookbook(), runtime);
    await userEvent.click(screen.getByRole('button', { name: en('modelAdvisor.cookbook.serve') }));
    await waitFor(() =>
      expect(document.body.textContent).toContain(en('modelAdvisor.runtime.note.VULKAN_BUILD_NOT_REQUESTABLE'))
    );
    expect(document.body.textContent).toContain(en('modelAdvisor.runtime.note.CUDA_LINE_UNVERIFIED'));
  });

  it('says the size is unstated rather than printing a number it does not have', async () => {
    const runtime = makeRuntime({ fetchPlan: vi.fn(async () => ({ ...CPU_PLAN, downloadBytes: null })) });
    renderCell(makeCookbook(), runtime);
    await userEvent.click(screen.getByRole('button', { name: en('modelAdvisor.cookbook.serve') }));
    await waitFor(() => expect(document.body.textContent).toContain(en('modelAdvisor.runtime.sizeUnknown')));
  });

  it('installs, re-probes the backends and serves - in that order - only after confirming', async () => {
    const order: string[] = [];
    const runtime = makeRuntime({
      fetchPlan: vi.fn(async () => CPU_PLAN),
      install: vi.fn(async () => {
        order.push('install');
        return READY_RUNTIME;
      }),
    });
    const cookbook = makeCookbook({
      refreshBackends: vi.fn(async () => {
        order.push('refresh');
      }),
      serve: vi.fn(async () => {
        order.push('serve');
      }),
    });
    renderCell(cookbook, runtime);

    await pressServeAndConfirm();

    await waitFor(() => expect(order).toEqual(['install', 'refresh', 'serve']));
  });

  it('downloads nothing when the user declines', async () => {
    const runtime = makeRuntime({ fetchPlan: vi.fn(async () => CPU_PLAN) });
    const cookbook = makeCookbook();
    renderCell(cookbook, runtime);

    await userEvent.click(screen.getByRole('button', { name: en('modelAdvisor.cookbook.serve') }));
    await waitFor(() => screen.getByRole('button', { name: en('modelAdvisor.runtime.decline') }));
    await userEvent.click(screen.getByRole('button', { name: en('modelAdvisor.runtime.decline') }));

    expect(runtime.install).not.toHaveBeenCalled();
    expect(cookbook.serve).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: en('modelAdvisor.cookbook.serve') })).toBeTruthy();
  });
});

describe('no percentage is shown that was not measured', () => {
  it('shows a bar while bytes move against a stated total', async () => {
    const runtime = makeRuntime({
      fetchPlan: vi.fn(async () => CPU_PLAN),
      install: pending,
      status: {
        ...MISSING_RUNTIME,
        state: 'downloading',
        progress: progressAt({ phase: 'downloading', totalBytesDone: 512, totalBytesTotal: 1024 }),
      },
    });
    renderCell(makeCookbook(), runtime);
    await pressServeAndConfirm();

    await waitFor(() => expect(document.querySelector('.arco-progress')).toBeTruthy());
    expect(document.body.textContent).toContain(en('modelAdvisor.runtime.phase.downloading'));
  });

  it.each([
    ['verifying', 'modelAdvisor.runtime.phase.verifying'],
    ['extracting', 'modelAdvisor.runtime.phase.extracting'],
    ['installing', 'modelAdvisor.runtime.phase.installing'],
  ] as const)('shows no bar while %s, because nothing measured that work', async (phase, labelKey) => {
    // The provisioner emits `totalBytesDone === totalBytesTotal` for all three
    // of these phases, so a bar fed by those numbers sits at 100% for 14.3 s of
    // a measured 20.6 s install - and for minutes on a slow disk.
    const runtime = makeRuntime({
      fetchPlan: vi.fn(async () => CPU_PLAN),
      install: pending,
      status: {
        ...MISSING_RUNTIME,
        state: 'downloading',
        progress: progressAt({ phase, totalBytesDone: 1024, totalBytesTotal: 1024 }),
      },
    });
    renderCell(makeCookbook(), runtime);
    await pressServeAndConfirm();

    await waitFor(() => expect(document.body.textContent).toContain(en(labelKey)));
    expect(document.querySelector('.arco-progress')).toBeNull();
    expect(document.body.textContent).not.toContain('100%');
  });
});

describe('the two stages are labelled as themselves and both cancels work', () => {
  it('labels the model download as the model, not as the runtime step', async () => {
    const runtime = makeRuntime({ fetchPlan: vi.fn(async () => CPU_PLAN), install: vi.fn(async () => READY_RUNTIME) });
    renderWithLiveServe(runtime);
    await pressServeAndConfirm();

    await waitFor(() => expect(document.body.textContent).toContain(en('modelAdvisor.runtime.stage.model')));
    // The measured bug: six minutes of GGUF transfer reported as stage one.
    expect(document.body.textContent).not.toContain(en('modelAdvisor.runtime.stage.runtime'));
    expect(document.body.textContent).not.toContain(en('modelAdvisor.runtime.phase.resolving'));
    expect(document.querySelector('.arco-progress')).toBeTruthy();
  });

  it('cancels the model download rather than an install that already finished', async () => {
    const runtime = makeRuntime({ fetchPlan: vi.fn(async () => CPU_PLAN), install: vi.fn(async () => READY_RUNTIME) });
    const { cancelDownload } = renderWithLiveServe(runtime);
    await pressServeAndConfirm();

    await waitFor(() => screen.getByRole('button', { name: en('modelAdvisor.cookbook.cancel') }));
    await userEvent.click(screen.getByRole('button', { name: en('modelAdvisor.cookbook.cancel') }));

    expect(cancelDownload).toHaveBeenCalledWith(MODEL);
    // `runtime.cancel()` here reaches a provisioner that has already returned,
    // so it would answer false and stop nothing. Measured as 1x before the fix.
    expect(runtime.cancel).not.toHaveBeenCalled();
  });

  it('does not accuse the user of an error after they cancel the model download', async () => {
    // The abort that follows a cancel arrives as a rejected serve. Reading the
    // "was this cancelled" flag out of state would read the value captured when
    // the press started - always false - and turn the user's own choice into a
    // failure block.
    const runtime = makeRuntime({ fetchPlan: vi.fn(async () => CPU_PLAN), install: vi.fn(async () => READY_RUNTIME) });
    const { failServe } = renderWithLiveServe(runtime);
    await pressServeAndConfirm();

    await waitFor(() => screen.getByRole('button', { name: en('modelAdvisor.cookbook.cancel') }));
    await userEvent.click(screen.getByRole('button', { name: en('modelAdvisor.cookbook.cancel') }));
    failServe(new Error('download cancelled'));

    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull());
    expect(document.body.textContent).not.toContain(en('modelAdvisor.runtime.problem.unknown'));
  });

  it('says so when the install cannot be stopped yet instead of a dead button', async () => {
    const runtime = makeRuntime({
      fetchPlan: vi.fn(async () => CPU_PLAN),
      install: pending,
      cancel: vi.fn(async () => false),
    });
    renderCell(makeCookbook(), runtime);
    await pressServeAndConfirm();

    await waitFor(() => screen.getByRole('button', { name: en('modelAdvisor.cookbook.cancel') }));
    await userEvent.click(screen.getByRole('button', { name: en('modelAdvisor.cookbook.cancel') }));

    await waitFor(() => expect(document.body.textContent).toContain(en('modelAdvisor.runtime.cancelNotYet')));
  });

  it('stays quiet when the install really was stopped', async () => {
    const runtime = makeRuntime({
      fetchPlan: vi.fn(async () => CPU_PLAN),
      install: pending,
      cancel: vi.fn(async () => true),
    });
    renderCell(makeCookbook(), runtime);
    await pressServeAndConfirm();

    await waitFor(() => screen.getByRole('button', { name: en('modelAdvisor.cookbook.cancel') }));
    await userEvent.click(screen.getByRole('button', { name: en('modelAdvisor.cookbook.cancel') }));

    await waitFor(() => expect(runtime.cancel).toHaveBeenCalled());
    expect(document.body.textContent).not.toContain(en('modelAdvisor.runtime.cancelNotYet'));
  });
});

describe('a cancel the user pressed is never reported back as a failure', () => {
  it('returns to Serve when the cancelled download resolves as an error status', async () => {
    // The path the real bridge takes. Before the fix the row rendered the red
    // "Failed" tag plus Retry: the user pressed Cancel and was told they broke
    // something. `modelCancelled` was a ref, so the RENDER could not see it.
    const { cancelDownload } = renderWithResolvedServeError();
    await pressServeAndConfirm();

    await waitFor(() => screen.getByRole('button', { name: en('modelAdvisor.cookbook.cancel') }));
    await userEvent.click(screen.getByRole('button', { name: en('modelAdvisor.cookbook.cancel') }));

    expect(cancelDownload).toHaveBeenCalledWith(MODEL);
    await waitFor(() => expect(screen.getByRole('button', { name: en('modelAdvisor.cookbook.serve') })).toBeTruthy());
    expect(document.body.textContent, 'the row calls the user own cancel a failure').not.toContain(
      en('modelAdvisor.cookbook.status.error')
    );
    expect(screen.queryByRole('button', { name: en('modelAdvisor.cookbook.retry') })).toBeNull();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('still reports a serve that broke on its own, with its retry', async () => {
    // The other half: suppressing the tag unconditionally would hide every
    // real serve failure, so the same harness must still produce one.
    const { breakServe } = renderWithResolvedServeError();
    await pressServeAndConfirm();

    await waitFor(() => screen.getByRole('button', { name: en('modelAdvisor.cookbook.cancel') }));
    breakServe();

    await waitFor(() => expect(document.body.textContent).toContain(en('modelAdvisor.cookbook.status.error')));
    expect(screen.getByRole('button', { name: en('modelAdvisor.cookbook.retry') })).toBeTruthy();
  });

  it('reports the failure of the NEXT press after a cancel, not silence', async () => {
    // A cancelled row that is already installed and cached re-serves through
    // `primaryAction`, not the two-stage flow. If the cancel flag survived that
    // press, the row would go permanently deaf to its own serve failures.
    const runtime = makeRuntime({ status: READY_RUNTIME });
    const { breakServe } = renderWithResolvedServeError({ runtime, cached: true });

    await userEvent.click(screen.getByRole('button', { name: en('modelAdvisor.cookbook.serve') }));
    await waitFor(() => screen.getByRole('button', { name: en('modelAdvisor.cookbook.cancel') }));
    await userEvent.click(screen.getByRole('button', { name: en('modelAdvisor.cookbook.cancel') }));
    await waitFor(() => expect(screen.getByRole('button', { name: en('modelAdvisor.cookbook.serve') })).toBeTruthy());

    await userEvent.click(screen.getByRole('button', { name: en('modelAdvisor.cookbook.serve') }));
    await waitFor(() => screen.getByRole('button', { name: en('modelAdvisor.cookbook.cancel') }));
    breakServe();

    await waitFor(() => expect(document.body.textContent).toContain(en('modelAdvisor.cookbook.status.error')));
  });
});

describe('a retry shows the install it started, not the failure it is retrying', () => {
  it('renders the runtime stage while the shared status is still the old failure', async () => {
    // `useLlamaRuntime.install` leaves `status.state === 'failed'` after a
    // failed attempt and the next frame only arrives from main. `runtimeProblem`
    // ran before the stage guards, so the row re-rendered the OLD error - with
    // `role='alert'` re-announcing it and a Retry inviting a second install -
    // over a download that was already running.
    const runtime = makeRuntime({
      status: {
        ...MISSING_RUNTIME,
        state: 'failed',
        errorCode: 'LLAMACPP_DOWNLOAD_FAILED',
        errorMessage: 'ECONNRESET',
      },
      fetchPlan: vi.fn(async () => CPU_PLAN),
      install: pending,
    });
    renderCell(makeCookbook(), runtime);

    await pressServeAndConfirm();

    await waitFor(() => expect(document.body.textContent).toContain(en('modelAdvisor.runtime.stage.runtime')));
    expect(document.body.textContent, 'the row shows the failure it is retrying').not.toContain(
      en('modelAdvisor.runtime.problem.download')
    );
    expect(screen.queryByRole('alert')).toBeNull();
    // Every stage that offers Cancel is a stage where Cancel does something -
    // and the retried install is exactly such a stage.
    expect(screen.getByRole('button', { name: en('modelAdvisor.cookbook.cancel') })).toBeTruthy();
    expect(screen.queryByRole('button', { name: en('modelAdvisor.runtime.retry') })).toBeNull();
  });

  it('reports the retry own failure once it resolves', async () => {
    // The guard must hold only while the install is in flight: the attempt that
    // follows still has to be able to fail out loud.
    const runtime = makeRuntime({
      status: {
        ...MISSING_RUNTIME,
        state: 'failed',
        errorCode: 'LLAMACPP_DOWNLOAD_FAILED',
        errorMessage: 'ECONNRESET',
      },
      fetchPlan: vi.fn(async () => CPU_PLAN),
      install: vi.fn(async () => ({
        ...MISSING_RUNTIME,
        state: 'failed' as const,
        errorCode: 'LLAMACPP_DIGEST_MISMATCH',
        errorMessage: 'sha256 did not match',
      })),
    });
    renderCell(makeCookbook(), runtime);

    await pressServeAndConfirm();

    await waitFor(() => expect(document.body.textContent).toContain('LLAMACPP_DIGEST_MISMATCH'));
    expect(document.body.textContent).toContain(en('modelAdvisor.runtime.problem.damaged'));
    expect(await screen.findByRole('alert')).toBeTruthy();
  });
});

describe('a failure says what happened, in the user words', () => {
  it('names the connection when the download drops, which is the likeliest failure', async () => {
    const runtime = makeRuntime({
      fetchPlan: vi.fn(async () => CPU_PLAN),
      install: vi.fn(async () => ({
        ...MISSING_RUNTIME,
        state: 'failed' as const,
        errorCode: 'LLAMACPP_DOWNLOAD_FAILED',
        errorMessage: 'ECONNRESET',
      })),
    });
    renderCell(makeCookbook(), runtime);
    await pressServeAndConfirm();

    await waitFor(() => expect(document.body.textContent).toContain(en('modelAdvisor.runtime.problem.download')));
    // The old copy for this code said nothing about the connection and told the
    // user to "use a cloud provider" instead - i.e. to give up on the feature.
    expect(document.body.textContent).not.toContain(en('modelAdvisor.runtime.problem.unknown'));
  });

  it.each([
    ['LLAMACPP_DIGEST_MISMATCH', 'modelAdvisor.runtime.problem.damaged'],
    ['LLAMACPP_EXTRACT_FAILED', 'modelAdvisor.runtime.problem.unpack'],
    ['LLAMACPP_NO_DIGEST', 'modelAdvisor.runtime.problem.unverified'],
    ['LLAMACPP_SERVER_MISSING', 'modelAdvisor.runtime.problem.incomplete'],
    ['ARCHIVE_MALFORMED', 'modelAdvisor.runtime.problem.archive'],
  ])('renders its own sentence for %s', async (code, messageKey) => {
    const runtime = makeRuntime({
      fetchPlan: vi.fn(async () => CPU_PLAN),
      install: vi.fn(async () => ({
        ...MISSING_RUNTIME,
        state: 'failed' as const,
        errorCode: code,
        errorMessage: 'diagnostic',
      })),
    });
    renderCell(makeCookbook(), runtime);
    await pressServeAndConfirm();

    await waitFor(() => expect(document.body.textContent).toContain(en(messageKey)));
    expect(document.body.textContent).toContain(code);
  });

  it('announces the failure to a screen reader instead of changing text in place', async () => {
    const runtime = makeRuntime({
      fetchPlan: vi.fn(async () => CPU_PLAN),
      install: vi.fn(async () => ({
        ...MISSING_RUNTIME,
        state: 'failed' as const,
        errorCode: 'LLAMACPP_DOWNLOAD_FAILED',
        errorMessage: 'ECONNRESET',
      })),
    });
    renderCell(makeCookbook(), runtime);
    await pressServeAndConfirm();

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain(en('modelAdvisor.runtime.problem.download'));
  });

  it('ends in a sentence when the plan call itself rejects', async () => {
    // The controller normally converts errors into `{kind:'unavailable'}`; an
    // IPC-layer rejection used to un-busy the row into an empty cell.
    const runtime = makeRuntime({
      fetchPlan: vi.fn(async () => {
        throw new Error('bridge closed');
      }),
    });
    renderCell(makeCookbook(), runtime);
    await userEvent.click(screen.getByRole('button', { name: en('modelAdvisor.cookbook.serve') }));

    await waitFor(() => expect(document.body.textContent).toContain(en('modelAdvisor.runtime.problem.unknown')));
    expect(screen.getByRole('button', { name: en('modelAdvisor.runtime.retry') })).toBeTruthy();
  });

  it('has copy for every error code the provisioner can raise', () => {
    // Guards the class of bug where a new `LLAMACPP_*` code ships as ALL-CAPS
    // English screen text. `PROBLEM_KEY` is a plain map, so only this can.
    const dirs = [join(process.cwd(), 'src/process/services/llamacpp')];
    const files: string[] = [];
    while (dirs.length > 0) {
      const dir = dirs.pop() as string;
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) dirs.push(full);
        else if (entry.name.endsWith('.ts')) files.push(full);
      }
    }
    files.push(join(process.cwd(), 'src/process/bridge/engine/llamaRuntimeBridge.ts'));

    const codes = new Set<string>();
    for (const file of files) {
      const source = readFileSync(file, 'utf-8');
      for (const match of source.matchAll(/'(LLAMACPP_[A-Z_]+|ARCHIVE_[A-Z_]+)'/g)) codes.add(match[1]);
    }
    expect(codes.size).toBeGreaterThan(10);

    // Cancelling is the user's own choice and is deliberately not a problem.
    const NOT_A_PROBLEM = new Set(['LLAMACPP_CANCELLED']);
    const uncovered = [...codes].filter((c) => NOT_A_PROBLEM.has(c) === false && PROBLEM_KEY[c] === undefined);
    expect(uncovered, 'error codes with no user-facing copy').toEqual([]);
  });
});

describe('a machine with no build is told so, not left spinning', () => {
  it('renders the unsupported sentence, no progress bar, and never installs', async () => {
    const runtime = makeRuntime({
      fetchPlan: vi.fn(
        async (): Promise<LlamaRuntimePlan> => ({ kind: 'unsupported', reason: 'no asset for freebsd/x64' })
      ),
    });
    renderCell(makeCookbook(), runtime);

    await userEvent.click(screen.getByRole('button', { name: en('modelAdvisor.cookbook.serve') }));

    await waitFor(() => expect(screen.getByText(en('modelAdvisor.runtime.problem.unsupported'))).toBeTruthy());
    expect(runtime.install).not.toHaveBeenCalled();
    expect(document.querySelector('.arco-progress')).toBeNull();
    // Not retryable: retrying an unbuildable machine is a loop, not a fix.
    expect(screen.queryByRole('button', { name: en('modelAdvisor.runtime.retry') })).toBeNull();
  });

  it('offers a retry when the release list was merely unreachable', async () => {
    const runtime = makeRuntime({
      fetchPlan: vi.fn(
        async (): Promise<LlamaRuntimePlan> => ({ kind: 'unavailable', errorCode: 'LLAMACPP_RELEASE_FETCH_FAILED' })
      ),
    });
    renderCell(makeCookbook(), runtime);
    await userEvent.click(screen.getByRole('button', { name: en('modelAdvisor.cookbook.serve') }));

    await waitFor(() => expect(document.body.textContent).toContain(en('modelAdvisor.runtime.problem.offline')));
    expect(document.body.textContent).toContain('LLAMACPP_RELEASE_FETCH_FAILED');
    expect(screen.getByRole('button', { name: en('modelAdvisor.runtime.retry') })).toBeTruthy();
  });

  it('reports a failed install with its code instead of falling through to serve', async () => {
    const runtime = makeRuntime({
      fetchPlan: vi.fn(async () => CPU_PLAN),
      install: vi.fn(async () => ({
        ...MISSING_RUNTIME,
        state: 'failed' as const,
        errorCode: 'LLAMACPP_DIGEST_MISMATCH',
        errorMessage: 'sha256 did not match',
      })),
    });
    const cookbook = makeCookbook();
    renderCell(cookbook, runtime);

    await pressServeAndConfirm();

    await waitFor(() => expect(document.body.textContent).toContain('LLAMACPP_DIGEST_MISMATCH'));
    expect(cookbook.serve).not.toHaveBeenCalled();
  });
});

describe('every runtime string ships in all 13 locales', () => {
  /**
   * Every key this component can reach, gathered two ways so neither kind of
   * miss survives: the literals it passes to `t` directly, and the values of
   * the exhaustive Records it builds union-driven keys from. A template string
   * such as `phase.${p}` would be invisible to both - which is how
   * `workflows.count` shipped rendering its own key name.
   */
  function keysTheComponentCanRender(): string[] {
    const source = readFileSync(COMPONENT_PATH, 'utf-8');
    const literals = [...source.matchAll(/'(modelAdvisor\.runtime\.[A-Za-z0-9_.]+)'/g)].map((m) => m[1]);
    const fromRecords = [
      ...Object.values(PHASE_LABEL_KEY),
      ...Object.values(ACCEL_LABEL_KEY),
      ...Object.values(FALLBACK_LABEL_KEY),
      ...Object.values(NOTE_LABEL_KEY),
      ...Object.values(PROBLEM_KEY),
      PROBLEM_UNKNOWN_KEY,
    ];
    return [...new Set([...literals, ...fromRecords])];
  }

  /**
   * Sentences. English left in place here is the failure mode check-i18n
   * cannot see, so every locale must differ from en-US on all of them.
   */
  const SENTENCE_KEYS = [
    'disclose',
    'discloseNext',
    'sizeUnknown',
    'confirm',
    'decline',
    'retry',
    'cancelNotYet',
    'accel.cuda',
    'accel.rocm',
    'accel.metal',
    'accel.cpu',
    ...LLAMA_RUNTIME_FALLBACK_CODES.map((c) => `fallback.${c}`),
    ...LLAMA_RUNTIME_NOTE_CODES.map((c) => `note.${c}`),
    'problem.download',
    'problem.offline',
    'problem.server',
    'problem.damaged',
    'problem.unverified',
    'problem.unpack',
    'problem.archive',
    'problem.incomplete',
    'problem.unsupported',
    'problem.unknown',
  ];
  /**
   * Single-word UI labels. They must exist and be translated where the language
   * has its own word, but "Model" really is the Turkish for model - demanding
   * difference here would force a WORSE translation, so they are only checked
   * for presence.
   */
  const LABEL_KEYS = [
    'stage.runtime',
    'stage.model',
    'phase.resolving',
    'phase.downloading',
    'phase.verifying',
    'phase.extracting',
    'phase.installing',
    'phase.done',
  ];

  function lookup(locale: string, key: string): unknown {
    const file = join(LOCALES_DIR, locale, 'modelAdvisor.json');
    let node: unknown = JSON.parse(readFileSync(file, 'utf-8'));
    for (const part of key.split('.')) {
      node = node && typeof node === 'object' ? (node as Record<string, unknown>)[part] : undefined;
    }
    return node;
  }

  it('covers the whole locale set, so a new language cannot be missed', () => {
    expect(new Set(readdirSync(LOCALES_DIR))).toEqual(new Set(SUPPORTED_LOCALES));
  });

  it.each(SUPPORTED_LOCALES)('%s has every runtime key as a non-empty string', (locale) => {
    for (const key of [...SENTENCE_KEYS, ...LABEL_KEYS]) {
      const value = lookup(locale, `runtime.${key}`);
      expect(typeof value, `${locale} runtime.${key}`).toBe('string');
      expect((value as string).length, `${locale} runtime.${key}`).toBeGreaterThan(0);
    }
  });

  it.each(SUPPORTED_LOCALES)('%s resolves every key the component can render', (locale) => {
    for (const key of keysTheComponentCanRender()) {
      expect(typeof lookup(locale, key.replace(/^modelAdvisor\./, '')), `${locale} ${key}`).toBe('string');
    }
  });

  it.each(SUPPORTED_LOCALES.filter((l) => l !== 'en-US'))(
    '%s translates the sentences, not just copies them',
    (locale) => {
      for (const key of SENTENCE_KEYS) {
        expect(lookup(locale, `runtime.${key}`), `${locale} runtime.${key}`).not.toBe(
          lookup('en-US', `runtime.${key}`)
        );
      }
    }
  );

  it('keeps the interpolation placeholders every locale must carry', () => {
    for (const locale of SUPPORTED_LOCALES) {
      expect(lookup(locale, 'runtime.disclose'), locale).toContain('{{size}}');
    }
  });

  it('never puts an error constant inside a sentence', () => {
    // The code is rendered separately and quietly. A `{{code}}` back inside the
    // prose is the regression: an ALL-CAPS English token in 13 languages.
    for (const locale of SUPPORTED_LOCALES) {
      for (const key of SENTENCE_KEYS) {
        expect(lookup(locale, `runtime.${key}`), `${locale} runtime.${key}`).not.toContain('{{code}}');
      }
    }
  });

  it('introduces no counted noun without plural forms', () => {
    // `workflows.count` shipped rendering its own key name at count=1 because
    // a `{{count}}` key needs `_one`/`_other` siblings, not a single string.
    for (const locale of SUPPORTED_LOCALES) {
      const runtime = lookup(locale, 'runtime') as Record<string, unknown>;
      const walk = (node: unknown, path: string): void => {
        if (typeof node === 'string') {
          expect(node, `${locale} runtime.${path}`).not.toContain('{{count}}');
          return;
        }
        if (node && typeof node === 'object') {
          for (const [k, v] of Object.entries(node as Record<string, unknown>)) walk(v, `${path}.${k}`);
        }
      };
      walk(runtime, '');
    }
  });

  it('names no project, build variant or quant format in any language', () => {
    // The feature exists so a person who has never heard of llama.cpp can use
    // it. Five strings named it, its release feed or its build variants.
    const BANNED = [/llama\.cpp/i, /\bgguf\b/i, /\bCUDA\b/, /\bROCm\b/i, /\bQ[2-8]_K\b/i, /--?ngl\b/];
    for (const locale of SUPPORTED_LOCALES) {
      const runtime = lookup(locale, 'runtime') as Record<string, unknown>;
      const walk = (node: unknown, path: string): void => {
        if (typeof node === 'string') {
          for (const pattern of BANNED) {
            expect(pattern.test(node), `${locale} runtime${path} = ${node}`).toBe(false);
          }
          return;
        }
        if (node && typeof node === 'object') {
          for (const [k, v] of Object.entries(node as Record<string, unknown>)) walk(v, `${path}.${k}`);
        }
      };
      walk(runtime, '');
    }
  });

  it('writes mn-MN in Mongolian, not English spelled in Cyrillic', () => {
    // A Cyrillic-range check passes transliteration by construction, which is
    // how «релиз» - the English "release" - shipped in four strings that were
    // the only four occurrences of it in the entire mn-MN tree.
    const TRANSLITERATIONS = [
      'релиз',
      'рантайм',
      'билд',
      'даунлоад',
      'даунлоуд',
      'инсталл',
      'кэнсэл',
      'кансел',
      'эррор',
      'фэйл',
      'апдейт',
    ];
    for (const key of [...SENTENCE_KEYS, ...LABEL_KEYS]) {
      const value = (lookup('mn-MN', `runtime.${key}`) as string).toLowerCase();
      expect(/[Ѐ-ӿ]/.test(value), `mn-MN runtime.${key} has no Cyrillic: ${value}`).toBe(true);
      for (const word of TRANSLITERATIONS) {
        expect(value.includes(word), `mn-MN runtime.${key} transliterates "${word}": ${value}`).toBe(false);
      }
    }
  });

  it('does not reuse the mn-MN word for Darhai own AI engine', () => {
    // «хөдөлгүүр» is the established mn-MN word for Darhai's memory/AI engine
    // (memory.json, mcp.json, conversation.json). Reusing it for the local
    // model runner makes a correct sentence mean the wrong thing: the app
    // re-downloading itself. No automated locale check would ever catch that.
    for (const key of [...SENTENCE_KEYS, ...LABEL_KEYS]) {
      const value = (lookup('mn-MN', `runtime.${key}`) as string).toLowerCase();
      expect(value.includes('хөдөлгүүр'), `mn-MN runtime.${key} = ${value}`).toBe(false);
    }
  });
});

/**
 * The user's right to pick Darhai's own runtime, on a machine that is not empty.
 *
 * The product rule the owner stated: users pick from the dropdown; anyone who
 * already knows Ollama or LM Studio must still be able to connect those; the
 * point of shipping llama.cpp inside Darhai is that a machine with NEITHER can
 * run a model immediately. The selector answered all of that from one question -
 * "which binaries are installed" - and llama.cpp is the one backend that
 * question is wrong for, because Darhai can install it. A host with Ollama on it
 * therefore got `viable: ['ollama']`: no llama.cpp in the chooser, and
 * `chosen !== 'none'` so the provisioning path never opened either. There was no
 * route to it at all, and no error to notice.
 *
 * Everything below is the ollama host. The empty machine is covered by the rest
 * of this file and must not move: it still sees no chooser and no name.
 */
describe('a host that already has a backend can still choose Darhai own runtime', () => {
  const OLLAMA_HOST = {
    chosen: 'ollama' as const,
    viable: ['ollama' as const],
    provisionable: ['llama-server' as const],
  };

  /** Open the backend chooser and return every option label it lists. */
  async function openChooser(): Promise<string[]> {
    const view = document.querySelector('.arco-select-view') as HTMLElement | null;
    expect(view, 'no backend chooser was rendered, so there was nothing to choose').toBeTruthy();
    await userEvent.click(view as HTMLElement);
    return Array.from(document.querySelectorAll('.arco-select-option')).map((o) => (o.textContent ?? '').trim());
  }

  /**
   * Open the chooser and pick the backend Darhai would have to install.
   *
   * `fireEvent` for the option, not `userEvent`: Arco's dropdown carries
   * `pointer-events: none` through its open transition, and jsdom never runs
   * the transition, so `userEvent`'s pointer check refuses a click a real user
   * makes without trouble. Same reason tests/unit/renderer/team does it here.
   */
  async function chooseLlamaCpp(): Promise<void> {
    const labels = await openChooser();
    const index = labels.indexOf(en('modelAdvisor.cookbook.backend.llamaServer'));
    expect(index, 'the runtime Darhai ships was not offered as an option').toBeGreaterThanOrEqual(0);
    fireEvent.click(document.querySelectorAll('.arco-select-option')[index] as HTMLElement);
    await waitFor(() =>
      expect(
        (document.querySelector('.arco-select-view-value') ?? document.querySelector('.arco-select-view'))?.textContent
      ).toContain(en('modelAdvisor.cookbook.backend.llamaServer'))
    );
  }

  it('lists the installed backend AND the one Darhai can install', async () => {
    renderCell(makeCookbook({ selection: OLLAMA_HOST }), makeRuntime());
    expect(await openChooser()).toEqual([
      en('modelAdvisor.cookbook.backend.ollama'),
      en('modelAdvisor.cookbook.backend.llamaServer'),
    ]);
  });

  it('discloses the cost before a byte moves when that backend is picked', async () => {
    const runtime = makeRuntime({ fetchPlan: vi.fn(async () => CPU_PLAN) });
    renderCell(makeCookbook({ selection: OLLAMA_HOST }), runtime);

    await chooseLlamaCpp();
    await userEvent.click(screen.getByRole('button', { name: en('modelAdvisor.cookbook.serve') }));

    // Same consent the empty machine gets: size, what the hardware gets, and
    // the fact that the model is a second download - before any install.
    await waitFor(() => expect(screen.getByText(/30 MB/)).toBeTruthy());
    expect(document.body.textContent).toContain(en('modelAdvisor.runtime.accel.cpu'));
    expect(runtime.install).not.toHaveBeenCalled();
  });

  it('downloads nothing when the user declines it', async () => {
    const runtime = makeRuntime({ fetchPlan: vi.fn(async () => CPU_PLAN) });
    const cookbook = makeCookbook({ selection: OLLAMA_HOST });
    renderCell(cookbook, runtime);

    await chooseLlamaCpp();
    await userEvent.click(screen.getByRole('button', { name: en('modelAdvisor.cookbook.serve') }));
    await waitFor(() => screen.getByRole('button', { name: en('modelAdvisor.runtime.decline') }));
    await userEvent.click(screen.getByRole('button', { name: en('modelAdvisor.runtime.decline') }));

    expect(runtime.install).not.toHaveBeenCalled();
    expect(cookbook.serve).not.toHaveBeenCalled();
  });

  it('serves through the backend the user picked, not the installed default', async () => {
    const runtime = makeRuntime({ fetchPlan: vi.fn(async () => CPU_PLAN), install: vi.fn(async () => READY_RUNTIME) });
    const cookbook = makeCookbook({ selection: OLLAMA_HOST });
    renderCell(cookbook, runtime);

    await chooseLlamaCpp();
    await pressServeAndConfirm();

    await waitFor(() => expect(runtime.install).toHaveBeenCalled());
    // `undefined` here would hand the decision back to main, which re-applies
    // its own order (vllm > ollama > llama-server) to a re-probe that has just
    // seen the new install - and would serve this model through Ollama using
    // the very runtime the user asked for.
    await waitFor(() => expect(cookbook.serve).toHaveBeenCalledWith(MODEL, 'llama-server'));
  });

  it('leaves the installed backend as the default press, with no install', async () => {
    const runtime = makeRuntime({ fetchPlan: vi.fn(async () => CPU_PLAN) });
    const cookbook = makeCookbook({ selection: OLLAMA_HOST });
    renderCell(cookbook, runtime);

    await userEvent.click(screen.getByRole('button', { name: en('modelAdvisor.cookbook.serve') }));

    await waitFor(() => expect(cookbook.serve).toHaveBeenCalledWith(MODEL, 'ollama'));
    expect(runtime.fetchPlan).not.toHaveBeenCalled();
    expect(runtime.install).not.toHaveBeenCalled();
  });
});
