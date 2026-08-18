/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button, Message, Progress, Select, Space, Tag, Tooltip } from '@arco-design/web-react';
import { Attention, Copy, Download, FolderOpen, Loading, PlayOne, Power } from '@icon-park/react';
import type { CookbookBackend, CookbookBackendSelection } from '@/common/types/cookbook';
import { LLAMACPP_DISCLOSURE_EXPIRED } from '@/common/types/llamacpp';
import type {
  LlamaRuntimeAcceleration,
  LlamaRuntimeFallbackCode,
  LlamaRuntimeNoteCode,
  LlamaRuntimePhase,
  LlamaRuntimePlan,
} from '@/common/types/llamacpp';
import { formatFileSize } from '@/renderer/services/FileService';
import type { I18nKey } from '@/renderer/services/i18n/i18n-keys';
import type { CookbookController } from './useCookbookServe';
import type { LlamaRuntimeUiController } from './useLlamaRuntime';
import styles from './ModelAdvisor.module.css';

type CookbookServeControlsProps = {
  modelId: string;
  controller: CookbookController;
  runtime: LlamaRuntimeUiController;
};

/**
 * i18n key per backend (the value is DATA, never interpolated into a command).
 *
 * TWO things are compiler-enforced here, and they are different guarantees.
 * `Record<CookbookBackend, …>` demands an ENTRY for every backend, so a new
 * union member cannot be label-less. Typing the VALUE as `I18nKey` - the
 * generated union of every key that actually exists in the locale files -
 * additionally demands that the entry names a real key, which `string` did not:
 * a typo, or a key added to the map before it was added to the 13 locale files,
 * used to compile and render the key itself as screen text, because i18next
 * falls back to the key.
 *
 * `backendSurfaceCoverage.dom.test.tsx` still iterates this map. It is now a
 * second line rather than the only one: `I18nKey` is regenerated from the
 * locale files by `scripts/generate-i18n-types.js`, so a stale checked-in
 * `i18n-keys.d.ts` could in principle vouch for a key that has since been
 * deleted, and the test reads the live files.
 */
export const BACKEND_LABEL_KEY: Record<CookbookBackend, I18nKey> = {
  vllm: 'modelAdvisor.cookbook.backend.vllm',
  ollama: 'modelAdvisor.cookbook.backend.ollama',
  'lm-studio': 'modelAdvisor.cookbook.backend.lmStudio',
  'llama-server': 'modelAdvisor.cookbook.backend.llamaServer',
  none: 'modelAdvisor.cookbook.backend.none',
};

/**
 * Cancelling is a choice, not a fault: after `runtime.cancel()` the status goes
 * to `failed` with this code, and the row must go back to offering the button
 * rather than accusing the user of an error.
 */
const CANCELLED_CODE = 'LLAMACPP_CANCELLED';

/**
 * Phase -> label key.
 *
 * Two compiler guarantees, and every other map below follows the same shape.
 *
 * `Record` over the union, not a `phase.${p}` template: adding a phase to
 * `LlamaRuntimePhase` fails `tsc` right here instead of shipping a cell that
 * renders its own key name in 13 languages. This repo has already shipped that
 * bug once as `workflows.count`, and a template string cannot be checked.
 *
 * `I18nKey` rather than `string` as the VALUE: the entry must name a key that
 * exists. `string` accepted a typo, and accepted a key written here before it
 * was added to the locale files - both of which compile, pass lint, and render
 * the key itself on screen, because i18next falls back to the key when it
 * cannot resolve one. Same failure as above, reached by a different route.
 */
export const PHASE_LABEL_KEY: Record<LlamaRuntimePhase, I18nKey> = {
  resolving: 'modelAdvisor.runtime.phase.resolving',
  downloading: 'modelAdvisor.runtime.phase.downloading',
  verifying: 'modelAdvisor.runtime.phase.verifying',
  extracting: 'modelAdvisor.runtime.phase.extracting',
  installing: 'modelAdvisor.runtime.phase.installing',
  done: 'modelAdvisor.runtime.phase.done',
};

/**
 * What the acceleration MEANS for the person reading it (see PHASE_LABEL_KEY
 * for why this is a Record). "NVIDIA CUDA" names a build variant; the copy
 * behind these keys says what it does to their models instead.
 */
export const ACCEL_LABEL_KEY: Record<LlamaRuntimeAcceleration, I18nKey> = {
  cuda: 'modelAdvisor.runtime.accel.cuda',
  rocm: 'modelAdvisor.runtime.accel.rocm',
  metal: 'modelAdvisor.runtime.accel.metal',
  vulkan: 'modelAdvisor.runtime.accel.vulkan',
  cpu: 'modelAdvisor.runtime.accel.cpu',
};

/** Why this machine is not getting its GPU (see PHASE_LABEL_KEY). */
export const FALLBACK_LABEL_KEY: Record<LlamaRuntimeFallbackCode, I18nKey> = {
  METAL_NOT_ON_THIS_PLATFORM: 'modelAdvisor.runtime.fallback.METAL_NOT_ON_THIS_PLATFORM',
  METAL_REQUIRES_APPLE_SILICON: 'modelAdvisor.runtime.fallback.METAL_REQUIRES_APPLE_SILICON',
  NO_GPU_BUILD_FOR_TARGET: 'modelAdvisor.runtime.fallback.NO_GPU_BUILD_FOR_TARGET',
  CUDA_RUNTIME_UNAVAILABLE: 'modelAdvisor.runtime.fallback.CUDA_RUNTIME_UNAVAILABLE',
  CUDA_DRIVER_TOO_OLD: 'modelAdvisor.runtime.fallback.CUDA_DRIVER_TOO_OLD',
};

/**
 * Remarks about HOW the build was chosen (see PHASE_LABEL_KEY).
 *
 * These are not fallbacks - the plan is what the machine gets - but each names
 * a way the download can end up slower than the user expects, so the main
 * process computing them and the transport dropping them on the floor is the
 * same silence as no message at all.
 */
export const NOTE_LABEL_KEY: Record<LlamaRuntimeNoteCode, I18nKey> = {
  CUDA_LINE_OLDER_FOR_DRIVER: 'modelAdvisor.runtime.note.CUDA_LINE_OLDER_FOR_DRIVER',
  CUDA_LINE_UNVERIFIED: 'modelAdvisor.runtime.note.CUDA_LINE_UNVERIFIED',
  VULKAN_BUILD_NOT_REQUESTABLE: 'modelAdvisor.runtime.note.VULKAN_BUILD_NOT_REQUESTABLE',
};

/**
 * Error code -> the sentence the user actually reads.
 *
 * The code is NOT the message. `LLAMACPP_DOWNLOAD_FAILED` is an English
 * identifier, byte-identical in all 13 locales, that means nothing to the
 * person who pressed the button - and the single most likely failure here is a
 * connection that drops mid-download, which deserves to say so. The code is
 * still rendered, small and separate, because a bug report needs it.
 */
export const PROBLEM_KEY: Record<string, I18nKey> = {
  LLAMACPP_DOWNLOAD_FAILED: 'modelAdvisor.runtime.problem.download',
  LLAMACPP_OFFLINE: 'modelAdvisor.runtime.problem.offline',
  LLAMACPP_RELEASE_FETCH_FAILED: 'modelAdvisor.runtime.problem.offline',
  LLAMACPP_RELEASE_MALFORMED: 'modelAdvisor.runtime.problem.server',
  LLAMACPP_DIGEST_MISMATCH: 'modelAdvisor.runtime.problem.damaged',
  LLAMACPP_NO_DIGEST: 'modelAdvisor.runtime.problem.unverified',
  LLAMACPP_EXTRACT_FAILED: 'modelAdvisor.runtime.problem.unpack',
  ARCHIVE_MALFORMED: 'modelAdvisor.runtime.problem.archive',
  ARCHIVE_UNSUPPORTED_METHOD: 'modelAdvisor.runtime.problem.archive',
  ARCHIVE_UNSUPPORTED_ENTRY: 'modelAdvisor.runtime.problem.archive',
  ARCHIVE_UNSAFE_ENTRY: 'modelAdvisor.runtime.problem.archive',
  ARCHIVE_INCOMPLETE: 'modelAdvisor.runtime.problem.archive',
  LLAMACPP_SERVER_MISSING: 'modelAdvisor.runtime.problem.incomplete',
  LLAMACPP_INSTALL_INCOMPLETE: 'modelAdvisor.runtime.problem.incomplete',
  LLAMACPP_UNSUPPORTED: 'modelAdvisor.runtime.problem.unsupported',
  LLAMACPP_NO_ASSET: 'modelAdvisor.runtime.problem.unsupported',
  LLAMACPP_UNKNOWN: 'modelAdvisor.runtime.problem.unknown',
  // Normally intercepted by `provisionAndServe`, which re-plans and shows the
  // fresh card instead of a failure block; kept here so the code still reads
  // as its own sentence if it ever surfaces through the generic problem path.
  [LLAMACPP_DISCLOSURE_EXPIRED]: 'modelAdvisor.runtime.expired',
};

/** Used for a code no copy was written for, and for a bare failure with none. */
export const PROBLEM_UNKNOWN_KEY: I18nKey = 'modelAdvisor.runtime.problem.unknown';

/** Codes where pressing the button again cannot help, so no retry is offered. */
export const PROBLEM_TERMINAL_CODES: readonly string[] = ['LLAMACPP_UNSUPPORTED', 'LLAMACPP_NO_ASSET'];

/** What the row is telling the user went wrong with the runtime. */
type RuntimeProblem = { messageKey: string; code: string; retryable: boolean };

/**
 * Which half of the two-stage wait this row is driving.
 *
 * `'runtime'` is Darhai's own llama.cpp (seconds to a minute); `'model'` is the
 * GGUF (measured at 13,153.7 MB / 365.2 s for gpt-oss-20b in
 * docs/architecture/local-models.md). They are separate because they have
 * separate progress and separate cancels - a single boolean spanning both is
 * how six minutes of model transfer came to be labelled "getting ready" under
 * a Cancel button that could not stop it.
 */
type ProvisionStage = 'runtime' | 'model';

/**
 * What this row has to say about an LM Studio whose own server is not up.
 *
 * Three states and not a boolean, because they are three different facts and a
 * user acts on each of them differently:
 *  - `'off'`         we have not asked it to be started yet. An instruction.
 *  - `'stillOff'`    the user said they started it and it is still not
 *                    answering - so the instruction did not take, and repeating
 *                    the first sentence verbatim would read as a dead button.
 *  - `'checkFailed'` Darhai could not find out either way. Saying "still off"
 *                    here would be a claim about LM Studio that was never
 *                    measured; this is the one honest thing left to say.
 */
type LmStudioPrompt = 'off' | 'stillOff' | 'checkFailed';

/**
 * Prompt -> the sentence the user reads (see {@link PHASE_LABEL_KEY} for why
 * this is an exhaustive `Record` and not a `lmStudio.${prompt}` template).
 *
 * Exported so the locale suites can iterate it: `Record` makes tsc demand an
 * entry per state, but nothing in the type system demands the string that entry
 * NAMES exists in thirteen files, and a missing one renders as its own key.
 */
export const LM_STUDIO_PROMPT_KEY: Record<LmStudioPrompt, string> = {
  off: 'modelAdvisor.cookbook.lmStudio.off',
  stillOff: 'modelAdvisor.cookbook.lmStudio.stillOff',
  checkFailed: 'modelAdvisor.cookbook.lmStudio.checkFailed',
};

/**
 * Per-row download + serve controls for a GGUF-capable model.
 *
 * The promise this component keeps is that ONE press does whatever it takes.
 * On a machine with nothing installed that is: fetch the llama.cpp release plan,
 * state what it costs, download the runtime, re-probe the backends, download the
 * model, start the server. The user is never told to go install llama.cpp - and
 * no string here names it, or a build variant, or a quant: they ARE told, before
 * the first byte, what their hardware gets and how large the download is, and a
 * machine with no build at all is told that instead of being left with a spinner.
 *
 * Two honesty rules govern what it renders while working:
 *  - a percentage is shown only for bytes that were counted against a stated
 *    total, so the verify/unpack/install tail gets its name and a spinner
 *    rather than a bar frozen at 100%;
 *  - every stage that offers Cancel is a stage where Cancel does something.
 *
 * That promise is about the machine with NOTHING on it. The machine that
 * already has something gets a different promise, and the chooser is where the
 * two meet: a user who knows Ollama or LM Studio picks it by name and Darhai
 * downloads nothing. LM Studio is the one entry there that Darhai cannot start
 * itself, so it is also the one that can be present-but-silent - see
 * {@link LmStudioPrompt}.
 *
 * Renders one of:
 *  - a backend chooser + Serve/Download button (idle),
 *  - the pre-download disclosure + confirm/decline (runtime missing, plan known),
 *  - the "start LM Studio's server" instruction + continue/decline,
 *  - a two-stage progress surface, labelled runtime or model (working),
 *  - a status pill + Stop (this model is serving),
 *  - a problem block saying what failed and what can be done about it,
 *  - the degraded copy-command + locate-binary affordance (last resort).
 */
const CookbookServeControls: React.FC<CookbookServeControlsProps> = ({ modelId, controller, runtime }) => {
  const { t } = useTranslation();
  const [busy, setBusy] = useState(false);
  const [override, setOverride] = useState<CookbookBackend | null>(null);
  /** The fetched plan awaiting the user's yes/no, or the reason there is none. */
  const [plan, setPlan] = useState<LlamaRuntimePlan | null>(null);
  /** True while `plan()` is in flight - honest "asking", not "downloading". */
  const [planning, setPlanning] = useState(false);
  /**
   * True when the card on screen exists because the previous Confirm found its
   * disclosure expired: main refused with {@link LLAMACPP_DISCLOSURE_EXPIRED},
   * this row re-planned, and the fresh card must SAY why it reappeared -
   * otherwise the user watches their Confirm apparently do nothing and the
   * same card come back, which reads as a dead button.
   */
  const [expired, setExpired] = useState(false);
  /** Non-null only in the row that started the install, so one row owns the surface. */
  const [stage, setStage] = useState<ProvisionStage | null>(null);
  /**
   * True once this row has actually asked for an install. The runtime is global,
   * so without this every visible row would report the same failure; only the
   * row the user pressed gets to.
   */
  const [attempted, setAttempted] = useState(false);
  /**
   * The failure THIS row's install resolved with. Kept locally as well as read
   * from `runtime.status`, because the resolved value is the authoritative
   * outcome of the press: relying on the shared status prop having been updated
   * by the time this row re-renders makes the error message depend on frame
   * ordering, which is how a failure becomes a silent fall-through to the
   * copy-a-command path.
   */
  const [failure, setFailure] = useState<{ code: string; message: string } | null>(null);
  /**
   * Set when Cancel was pressed and the provisioner answered "not yet" - it can
   * only abort once it owns the transfer. Without this the button is silently
   * dead for the whole release lookup, which is the one moment a user who has
   * just read "512.8 MB" is most likely to press it.
   */
  const [cancelRefused, setCancelRefused] = useState(false);
  /**
   * Set when the user cancelled the MODEL download, so the resulting abort is
   * not reported as a fault. A ref, not state: `provisionAndServe` is still
   * awaiting when Cancel is pressed, and its closure would keep reading the
   * value from the render that started it - which is always `false`.
   */
  const modelCancelled = useRef(false);
  /**
   * The same fact as `modelCancelled`, in state, because the RENDER needs it
   * too and a ref does not re-render.
   *
   * The ref alone only ever guarded a REJECTED `controller.serve()`, and the
   * main process does not produce one: `CookbookServeService.serve()` is
   * documented "Never throws - a failure is reflected in the returned status",
   * its catch calls `fail()` which sets `state:'error'`, and the bridge returns
   * that status. So a cancelled model download RESOLVES, `provisionAndServe`
   * falls through with no failure set, and the render below reaches the red
   * `status.state === 'error'` tag - reporting the user's own choice as a
   * fault, which is the one thing this surface is not allowed to do.
   */
  const [cancelledServe, setCancelledServe] = useState(false);
  /**
   * What this row is currently telling the user about LM Studio's own server,
   * or null when it is not telling them anything.
   *
   * Null until the press, and null again the moment the server answers: the
   * block that reads it is ALSO gated on the live `needsLmStudioStart`, so a
   * server that came up while the prompt was on screen removes the prompt by
   * itself rather than leaving stale copy behind a stale flag.
   */
  const [lmStudioPrompt, setLmStudioPrompt] = useState<LmStudioPrompt | null>(null);

  const dl = controller.downloads[modelId];
  const prog = controller.progress[modelId];
  const status = controller.serveStatus;
  const { viable, chosen } = controller.selection;
  /**
   * Backends Darhai can install on request. Separate from `viable` because
   * "installed" is the wrong test for the one backend that ships inside the
   * app: a host with Ollama on it saw `viable: ['ollama']`, so llama.cpp was
   * neither in the chooser nor reachable through the `'none'` disclosure, and
   * the machine had no route to Darhai's own runtime at all.
   */
  const provisionable = controller.selection.provisionable ?? [];
  /** Everything the user may pick: installed now, or installable on request. */
  const options: CookbookBackend[] = [...viable, ...provisionable.filter((b) => viable.includes(b) === false)];
  const selected: CookbookBackend = override && options.includes(override) ? override : chosen;
  const isServingThis = status.modelId === modelId;
  const isDownloading = dl?.status === 'downloading' || (!!prog && dl?.status !== 'downloaded');
  const isDownloaded = dl?.status === 'downloaded';
  // vLLM and ollama self-download; only llama.cpp needs a GGUF cached first.
  const needsGguf = selected === 'llama-server' || selected === 'none';
  const runtimeReady = runtime.status.state === 'ready';
  /**
   * `'unknown'` is the pre-probe value the renderer invents for its first
   * frame. Treating it as "no runtime" offers a half-gigabyte download, with
   * copy saying it is required, to a machine that may already have one - the
   * state exists precisely to tell "we know there is none" apart from "we have
   * not asked yet".
   */
  const runtimeProbed = runtime.status.state !== 'unknown';
  /**
   * The user picked LM Studio and it is not answering yet.
   *
   * `provisionable` carries TWO different offers now, and they are not the same
   * act. For llama.cpp it means "Darhai can download this for you"; for LM
   * Studio it means "LM Studio is already on this computer, its own server is
   * just switched off". Darhai does not spawn LM Studio - a person starts it
   * inside a GUI app - so the honest offer is an instruction plus a re-check,
   * and routing it through the llama.cpp disclosure would ask a user who already
   * has LM Studio to consent to a half-gigabyte download of something else
   * entirely, then serve them through that instead.
   */
  const needsLmStudioStart = selected === 'lm-studio' && provisionable.includes('lm-studio') === true;
  /**
   * This press must provision first. Two ways to get here, and they are the
   * same press: nothing is installed at all (`'none'`), or the user picked a
   * backend Darhai has yet to install. The second case is what a machine with
   * Ollama on it needs - the first alone left it with no path to llama.cpp.
   *
   * `needsLmStudioStart` is excluded rather than assumed away: a provisionable
   * LM Studio satisfies `provisionable.includes(selected)` exactly as llama.cpp
   * does, so without this the two offers would be the same branch.
   */
  const needsRuntime =
    needsLmStudioStart === false &&
    (selected === 'none' || provisionable.includes(selected)) &&
    runtimeProbed === true &&
    runtimeReady === false;

  /**
   * Record - or clear - "the user cancelled this model download" for BOTH
   * readers: the awaiting closure in `provisionAndServe` (ref) and the next
   * render (state). One call site so the two can never drift apart.
   */
  const markModelCancelled = (cancelled: boolean): void => {
    modelCancelled.current = cancelled;
    setCancelledServe(cancelled);
  };

  const run = async (fn: () => Promise<void>): Promise<void> => {
    setBusy(true);
    try {
      await fn();
    } finally {
      setBusy(false);
    }
  };

  const copyCommand = async (): Promise<void> => {
    if (!status.serveCommand) return;
    await navigator.clipboard.writeText(status.serveCommand);
    Message.success(t('modelAdvisor.cookbook.copied'));
  };

  /** Serve through the user's override when they set one; else let main decide. */
  const serveBackend = (): CookbookBackend | undefined => (selected === 'none' ? undefined : selected);

  /**
   * The Confirm found its disclosure expired: main installed NOTHING. Fetch the
   * fresh plan and put it back in front of the user with the reason it
   * reappeared - consent is per-card, so only a new Confirm may install.
   */
  const replanAfterExpiry = async (): Promise<void> => {
    // Not an attempt any more: the sticky `failed` status main keeps for this
    // refusal must not outrank the fresh card this row is about to show.
    setAttempted(false);
    let answer: LlamaRuntimePlan;
    setPlanning(true);
    try {
      answer = await runtime.fetchPlan();
    } catch {
      setPlan({ kind: 'unavailable', errorCode: 'LLAMACPP_UNKNOWN' });
      return;
    } finally {
      setPlanning(false);
    }
    setExpired(true);
    setPlan(answer);
  };

  /** Provision the runtime, then serve. The single press behind both stages. */
  const provisionAndServe = async (): Promise<void> => {
    setPlan(null);
    setExpired(false);
    setAttempted(true);
    setFailure(null);
    setCancelRefused(false);
    markModelCancelled(false);
    setStage('runtime');
    try {
      const final = await runtime.install();
      // The disclosure aged out between the card and this Confirm. Main
      // deliberately fetched nothing - see LLAMACPP_DISCLOSURE_EXPIRED - and
      // this is not a fault to report but a question to re-ask: show the fresh
      // card and wait for a new Confirm rather than install an unseen plan.
      if (final.state !== 'ready' && final.errorCode === LLAMACPP_DISCLOSURE_EXPIRED) {
        await replanAfterExpiry();
        return;
      }
      // Do NOT go on to serve after a failed install: that falls through to the
      // copy-a-command path and hides the real reason.
      if (final.state !== 'ready') {
        setFailure({ code: final.errorCode || '', message: final.errorMessage || '' });
        return;
      }
      // Hand the surface to stage 2 BEFORE the model download starts, so the
      // longer half of the wait is labelled as itself and gets its own cancel.
      setStage('model');
      await controller.refreshBackends();
      // The user's own pick, not `undefined`. Passing nothing lets main re-apply
      // its own preference order (vllm > ollama > llama-server) to a re-probe
      // that has just seen the newly installed runtime - so a user who chose
      // Darhai's llama.cpp on an Ollama box would be served through Ollama, by
      // the very install they asked for.
      await controller.serve(modelId, serveBackend());
    } catch (err) {
      // A rejected serve must still end in a sentence. Cancelling the model
      // download rejects too, and that is the user's own doing, not a fault.
      if (modelCancelled.current === false) {
        setFailure({ code: '', message: err instanceof Error ? err.message : String(err) });
      }
    } finally {
      setStage(null);
    }
  };

  /** Ask what an install would cost BEFORE anything is downloaded. */
  const askThenProvision = async (): Promise<void> => {
    // Clear the last answer AND the last attempt, so a retry shows the fresh
    // outcome rather than the failure it is retrying. The expiry notice goes
    // with them: it explained the PREVIOUS press, and a card opened afresh
    // must read as a first offer.
    setPlan(null);
    setExpired(false);
    setAttempted(false);
    setFailure(null);
    setCancelRefused(false);
    let answer: LlamaRuntimePlan;
    setPlanning(true);
    try {
      answer = await runtime.fetchPlan();
    } catch {
      // The controller normally turns errors into `{kind:'unavailable'}`, so
      // this is an IPC-layer failure - rare, and previously it un-busied the
      // row into a blank cell, the exact silent fall-through the rest of this
      // component is written to avoid.
      setPlan({ kind: 'unavailable', errorCode: 'LLAMACPP_UNKNOWN' });
      return;
    } finally {
      setPlanning(false);
    }
    // Nothing to disclose when the bytes are already on disk - go straight on.
    if (answer.kind === 'ok' && answer.alreadyInstalled === true) {
      await provisionAndServe();
      return;
    }
    setPlan(answer);
  };

  /**
   * The user says LM Studio's server is running now. Find out, then get on with
   * it - this is still the ONE press, it just had a person in the middle of it.
   *
   * The answer is READ FROM THE RESOLVED PROBE, not from `controller.selection`
   * after awaiting: this closure holds the selection from the render that began
   * the press, so re-reading the prop here would ask a question and then look at
   * the old answer. That is the shape that once reported a user's own cancel as
   * a failure, and it is why `refreshBackends` resolves with what it found.
   */
  const continueLmStudio = async (): Promise<void> => {
    let next: CookbookBackendSelection;
    try {
      next = await controller.refreshBackends();
    } catch {
      // The probe itself did not complete, so nothing is known about LM Studio.
      // Reporting "still off" here would be a measurement Darhai never made.
      setLmStudioPrompt('checkFailed');
      return;
    }
    if (next.viable.includes('lm-studio') === false) {
      setLmStudioPrompt('stillOff');
      return;
    }
    setLmStudioPrompt(null);
    // The user's OWN pick, exactly as the provisioned-runtime path does it:
    // `undefined` would hand the choice back to main, whose ranking puts ollama
    // above lm-studio, so the model would be served through a backend the user
    // did not just go and start by hand.
    await controller.serve(modelId, 'lm-studio');
  };

  const primaryAction = async (): Promise<void> => {
    // A fresh press is a fresh outcome: whatever the last cancel suppressed,
    // this attempt's failure is the user's to see.
    markModelCancelled(false);
    // `needsRuntime` FIRST, and it is the single place LM Studio is excluded.
    // Testing `needsLmStudioStart` ahead of it would make that exclusion
    // unreachable - the branch order would mask a broken gate, and no test
    // could tell a correct gate from a deleted one. Measured: with the LM
    // Studio branch first, removing `needsLmStudioStart === false` from
    // `needsRuntime` left all 127 tests green.
    if (needsRuntime === true) {
      await askThenProvision();
      return;
    }
    if (needsLmStudioStart === true) {
      // Nothing is fetched and nothing is spawned - this press only asks. The
      // llama.cpp attempt state is cleared with it, so a failure left over from
      // a previous pick cannot outrank the question this press is asking.
      setPlan(null);
      setAttempted(false);
      setFailure(null);
      setLmStudioPrompt('off');
      return;
    }
    if (needsGguf && !isDownloaded) {
      await controller.download(modelId);
      return;
    }
    await controller.serve(modelId, serveBackend());
  };

  /** Stop the runtime install, and say so when the provisioner cannot yet. */
  const cancelRuntime = async (): Promise<void> => {
    const stopped = await runtime.cancel();
    setCancelRefused(stopped === false);
  };

  /** Stop the model download. Unlike the runtime, this always has a target. */
  const cancelModel = async (): Promise<void> => {
    markModelCancelled(true);
    await controller.cancelDownload(modelId);
  };

  /** Map a `LLAMACPP_*`/`ARCHIVE_*` code onto copy a person can act on. */
  const describeProblem = (code: string): RuntimeProblem => ({
    messageKey: PROBLEM_KEY[code] ?? PROBLEM_UNKNOWN_KEY,
    code,
    retryable: PROBLEM_TERMINAL_CODES.includes(code) === false,
  });

  /** The runtime problem this row should report, or null when there is none. */
  const runtimeProblem = (): RuntimeProblem | null => {
    if (plan !== null && plan.kind === 'unsupported') {
      return { messageKey: PROBLEM_KEY.LLAMACPP_UNSUPPORTED, code: '', retryable: false };
    }
    if (plan !== null && plan.kind === 'unavailable') {
      return describeProblem(plan.errorCode);
    }
    // Only the row that pressed reports an install failure (the runtime is
    // global; every other row must stay quiet), and a cancellation is not one.
    if (attempted === false) return null;
    // The resolved outcome of THIS row's press is authoritative and needs no
    // corroboration from the shared status.
    const local = failure;
    if (local !== null) return local.code === CANCELLED_CODE ? null : describeProblem(local.code);
    // Everything below reads the SHARED `runtime.status`, which lags: it still
    // carries the previous frame until the main process pushes the next one.
    // `provisionAndServe` has already cleared `failure` and set `stage`
    // synchronously, so without this guard a press made while the last attempt
    // is still the newest frame re-renders the failure it is retrying - with
    // `role='alert'` re-announcing it, and a Retry button inviting a second
    // concurrent install - over a download that is already running.
    if (stage !== null) return null;
    const globalFailed = runtime.status.state === 'failed';
    if (globalFailed === false) return null;
    const code = runtime.status.errorCode || '';
    if (code === CANCELLED_CODE) return null;
    return describeProblem(code);
  };

  /**
   * The chosen-backend label, or an override Select when there is more than one
   * option. Options, not `viable`: a host with one installed backend still has a
   * real choice when Darhai can install another, and that choice is exactly the
   * one this row used to withhold.
   *
   * A host with NOTHING installed is deliberately untouched. Its only option
   * would be provisionable llama.cpp, and naming it in a chooser it cannot
   * choose away from teaches a word the one-press flow exists to spare it.
   */
  const backendChooser = (): React.ReactNode => {
    if (options.length > 1) {
      return (
        <Tooltip content={t('modelAdvisor.cookbook.backendTip')}>
          <Select
            size='mini'
            value={selected}
            onChange={(v) => {
              setOverride(v as CookbookBackend);
              // Switching backend retracts the question this row was asking.
              // The block below is gated on the live selection too, so this is
              // belt-and-braces - but without it, switching away and back would
              // re-open a "still not answering" the user never asked for again.
              setLmStudioPrompt(null);
            }}
            className={styles.backendSelect}
            aria-label={t('modelAdvisor.cookbook.backendTip')}
          >
            {options.map((b) => (
              <Select.Option key={b} value={b}>
                {t(BACKEND_LABEL_KEY[b])}
              </Select.Option>
            ))}
          </Select>
        </Tooltip>
      );
    }
    if (viable.length === 1) {
      return (
        <Tooltip content={t('modelAdvisor.cookbook.backendTip')}>
          <Tag color='arcoblue' size='small'>
            {t(BACKEND_LABEL_KEY[viable[0]])}
          </Tag>
        </Tooltip>
      );
    }
    return null;
  };

  /** Stage 1 of 2: fetching Darhai's own llama.cpp. */
  const runtimeStageBlock = (): React.ReactNode => {
    const p = runtime.status.progress;
    const phase: LlamaRuntimePhase = p === null ? 'resolving' : p.phase;
    // A percentage is shown ONLY while bytes are moving against a stated total.
    // Once the last byte lands, `totalBytesDone === totalBytesTotal` for the
    // whole verify -> unpack -> install tail (14.3 s of the reference machine's
    // 20.6 s install, minutes on a slow disk), so a bar driven by that number
    // reads 100% through work nothing has measured. Those phases get their name
    // and a spinner - which is what "unknown but running" honestly looks like.
    const counting = phase === 'downloading' && p !== null && p.totalBytesTotal > 0;
    const pct = counting === true ? Math.min(100, Math.round((p.totalBytesDone / p.totalBytesTotal) * 100)) : 0;
    return (
      <div className={styles.runtimeBlock}>
        <span className={styles.runtimeStage}>
          {t('modelAdvisor.runtime.stage.runtime')} · {t(PHASE_LABEL_KEY[phase])}
        </span>
        {counting === true ? (
          <Progress size='small' className={styles.dlProgress} percent={pct} status='normal' />
        ) : (
          <span className={styles.runtimeBytes}>
            <Loading className={styles.spin} />
            {/* No stated total means no percentage - show the bytes actually seen. */}
            {phase === 'downloading' && p !== null ? formatFileSize(p.totalBytesDone) : null}
          </span>
        )}
        {cancelRefused === true ? (
          <span className={styles.runtimeHint}>{t('modelAdvisor.runtime.cancelNotYet')}</span>
        ) : null}
        <Button size='mini' status='danger' onClick={() => void cancelRuntime()}>
          {t('modelAdvisor.cookbook.cancel')}
        </Button>
      </div>
    );
  };

  /**
   * Stage 2 of 2: the model's own GGUF - the long one. Its own bytes, its own
   * cancel, and its own name, so it is never reported as stage 1.
   */
  const modelStageBlock = (): React.ReactNode => {
    const fetching = isServingThis && status.state === 'downloading';
    const starting = isServingThis && status.state === 'starting';
    // One-time measured `--n-cpu-moe` calibration for a MoE model that does
    // not fit in VRAM. Its own label because the wait is minutes, not seconds,
    // and calling it "starting" for that long reads as a hang.
    const calibrating = isServingThis && status.state === 'calibrating';
    const counting = fetching === true && !!prog && prog.totalBytes > 0;
    const pct = counting === true ? Math.min(100, Math.round((prog.bytesDownloaded / prog.totalBytes) * 100)) : 0;
    const label = fetching
      ? 'modelAdvisor.cookbook.status.downloading'
      : calibrating
        ? 'modelAdvisor.cookbook.status.calibrating'
        : starting
          ? 'modelAdvisor.cookbook.status.starting'
          : PHASE_LABEL_KEY.resolving;
    return (
      <div className={styles.runtimeBlock}>
        <span className={styles.runtimeStage}>
          {t('modelAdvisor.runtime.stage.model')} · {t(label)}
        </span>
        {counting === true ? (
          <Progress size='small' className={styles.dlProgress} percent={pct} status='normal' />
        ) : (
          <span className={styles.runtimeBytes}>
            <Loading className={styles.spin} />
            {fetching === true && prog ? formatFileSize(prog.bytesDownloaded) : null}
          </span>
        )}
        {fetching === true ? (
          <Button size='mini' status='danger' onClick={() => void cancelModel()}>
            {t('modelAdvisor.cookbook.cancel')}
          </Button>
        ) : calibrating === true ? (
          // Every stage that offers Cancel is a stage where Cancel does
          // something - and calibration always had one in main (`stopServe`
          // bumps the stop epoch and aborts the bench child); only this button
          // was missing, leaving a 1-8 minute wait nothing could interrupt.
          // Its own label, not the generic Cancel: the user is cancelling the
          // one-time tuning, and the next press will simply run it again.
          <Button size='mini' status='danger' loading={busy} onClick={() => run(controller.stopServe)}>
            {t('modelAdvisor.cookbook.cancelCalibration')}
          </Button>
        ) : null}
      </div>
    );
  };

  // ── Runtime problem: say what happened, never spin on it ───────────────────
  const problem = runtimeProblem();
  if (problem !== null) {
    return (
      // role='alert' because this text replaces a progress surface in place: a
      // screen-reader user who pressed Serve and hit a failure was never told.
      <div className={styles.runtimeBlock} role='alert'>
        <span className={styles.runtimeProblem}>
          <Attention theme='filled' size={13} />
          {t(problem.messageKey)}
        </span>
        {problem.code === '' ? null : <span className={styles.runtimeCode}>{problem.code}</span>}
        {problem.retryable === true ? (
          <Button size='mini' loading={planning} onClick={() => void askThenProvision()}>
            {t('modelAdvisor.runtime.retry')}
          </Button>
        ) : null}
      </div>
    );
  }

  // ── The two stages of the one press ───────────────────────────────────────
  if (stage === 'runtime') return runtimeStageBlock();
  if (stage === 'model') return modelStageBlock();

  // ── LM Studio is here, its own server is not running ──────────────────────
  // Deliberately NOT the pre-download disclosure below: there is nothing to
  // download and nothing to consent to. Both halves of the gate are live, so
  // the moment `refreshBackends` reports LM Studio serving, this block stops
  // rendering on its own rather than waiting to be dismissed.
  if (needsLmStudioStart === true && lmStudioPrompt !== null) {
    return (
      // role='status', not 'alert': an installed LM Studio with its server off
      // is a step left to take, not a fault. It is still announced, because it
      // replaces the button the user just pressed and a silent swap tells a
      // screen-reader user nothing happened.
      <div className={styles.runtimeBlock} role='status'>
        <span className={styles.runtimeStage}>{t(LM_STUDIO_PROMPT_KEY[lmStudioPrompt])}</span>
        <Space size={6}>
          <Button size='mini' type='primary' icon={<PlayOne />} loading={busy} onClick={() => run(continueLmStudio)}>
            {t('modelAdvisor.cookbook.lmStudio.continue')}
          </Button>
          <Button size='mini' onClick={() => setLmStudioPrompt(null)}>
            {t('modelAdvisor.runtime.decline')}
          </Button>
        </Space>
      </div>
    );
  }

  // ── Pre-download disclosure: what this machine gets, and what it costs ─────
  if (plan !== null && plan.kind === 'ok') {
    const size =
      plan.downloadBytes === null ? t('modelAdvisor.runtime.sizeUnknown') : formatFileSize(plan.downloadBytes);
    return (
      // role='status' when the card reappeared after an expired Confirm: it
      // replaces the progress surface the press opened, and a silent swap
      // tells a screen-reader user their Confirm did nothing. Not 'alert' -
      // a refreshed offer is a step left to take, not a fault.
      <div className={styles.runtimeBlock} role={expired === true ? 'status' : undefined}>
        {expired === true ? <span className={styles.runtimeHint}>{t('modelAdvisor.runtime.expired')}</span> : null}
        <span className={styles.runtimeStage}>{t('modelAdvisor.runtime.disclose', { size })}</span>
        <span className={styles.runtimeHint}>{t(ACCEL_LABEL_KEY[plan.acceleration])}</span>
        {plan.fallbackCode === null ? null : (
          <span className={styles.runtimeHint}>{t(FALLBACK_LABEL_KEY[plan.fallbackCode])}</span>
        )}
        {plan.noteCodes.map((code) => (
          <span key={code} className={styles.runtimeHint}>
            {t(NOTE_LABEL_KEY[code])}
          </span>
        ))}
        {/* The model is a second, larger download. Consenting to the runtime is
            not consenting to that, so it is stated before the first byte. */}
        <span className={styles.runtimeHint}>{t('modelAdvisor.runtime.discloseNext')}</span>
        <Space size={6}>
          <Button size='mini' type='primary' icon={<Download />} onClick={() => void provisionAndServe()}>
            {t('modelAdvisor.runtime.confirm')}
          </Button>
          <Button
            size='mini'
            onClick={() => {
              setPlan(null);
              // The notice explains the card it sits on; do not let it haunt
              // the next one.
              setExpired(false);
            }}
          >
            {t('modelAdvisor.runtime.decline')}
          </Button>
        </Space>
      </div>
    );
  }

  // ── This model is the active serve ────────────────────────────────────────
  if (
    isServingThis &&
    (status.state === 'starting' || status.state === 'downloading' || status.state === 'calibrating')
  ) {
    return modelStageBlock();
  }

  if (isServingThis && status.state === 'ready') {
    return (
      <Space size={6}>
        <Tag color='green'>{t('modelAdvisor.cookbook.status.ready', { port: status.port })}</Tag>
        <Button size='mini' icon={<Power />} loading={busy} onClick={() => run(controller.stopServe)}>
          {t('modelAdvisor.cookbook.stop')}
        </Button>
      </Space>
    );
  }

  if (isServingThis && status.state === 'needs_backend') {
    return (
      <div className={styles.serveDegraded}>
        <span className={styles.serveHint}>{t('modelAdvisor.cookbook.needsBackend')}</span>
        <Space size={6}>
          <Button size='mini' icon={<Copy />} onClick={() => void copyCommand()}>
            {t('modelAdvisor.cookbook.copyCommand')}
          </Button>
          <Button size='mini' icon={<FolderOpen />} loading={busy} onClick={() => run(controller.locateBackend)}>
            {t('modelAdvisor.cookbook.locate')}
          </Button>
        </Space>
      </div>
    );
  }

  // `cancelledServe` and not `status.error`: the abort is reported through the
  // ordinary error status, so the status alone cannot tell "the transfer broke"
  // from "the user stopped it". Only this row knows which button was pressed.
  if (isServingThis && status.state === 'error' && cancelledServe === false) {
    return (
      <Space size={6}>
        <Tooltip content={status.error ?? ''}>
          <Tag color='red'>{t('modelAdvisor.cookbook.status.error')}</Tag>
        </Tooltip>
        <Button size='mini' type='primary' loading={busy} onClick={() => run(primaryAction)}>
          {t('modelAdvisor.cookbook.retry')}
        </Button>
      </Space>
    );
  }

  // ── Downloading the model's GGUF ──────────────────────────────────────────
  if (isDownloading) {
    const pct =
      prog && prog.totalBytes && prog.totalBytes > 0
        ? Math.min(100, Math.round((prog.bytesDownloaded / prog.totalBytes) * 100))
        : undefined;
    return (
      <Space size={6}>
        <Progress
          size='small'
          className={styles.dlProgress}
          percent={pct ?? 0}
          status='normal'
          showText={pct !== undefined}
        />
        <Button size='mini' status='danger' onClick={() => void controller.cancelDownload(modelId)}>
          {t('modelAdvisor.cookbook.cancel')}
        </Button>
      </Space>
    );
  }

  // ── Idle: backend chooser + primary action ────────────────────────────────
  // With a runtime to provision, or with llama.cpp already chosen, the primary
  // verb is still "Serve" - the user does not need to know llama.cpp exists.
  // Before the probe answers, the verb stays "Serve": flipping to "Download"
  // for one frame and back is a label that changes under the user's cursor.
  const primaryIsDownload = runtimeProbed === true && needsRuntime === false && needsGguf && !isDownloaded;
  const primary = primaryIsDownload ? (
    <Button size='mini' icon={<Download />} loading={busy} onClick={() => run(primaryAction)}>
      {t('modelAdvisor.cookbook.download')}
    </Button>
  ) : (
    <Button size='mini' type='primary' icon={<PlayOne />} loading={busy || planning} onClick={() => run(primaryAction)}>
      {t('modelAdvisor.cookbook.serve')}
    </Button>
  );

  return (
    <Space size={6}>
      {backendChooser()}
      {primary}
    </Space>
  );
};

export default CookbookServeControls;
