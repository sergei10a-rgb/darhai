/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

import { acpDetector } from '@process/agent/acp/AcpDetector';
import { resolveWCoreBinary } from '@process/agent/wcore/binaryResolver';
import { readEngineContract } from '@process/agent/wcore/capabilities/engineContractStore';
import type {
  AcpDetectedAgent,
  WCoreDetectedAgent,
  DetectedAgent,
  GeminiDetectedAgent,
  NanobotDetectedAgent,
  OpenClawDetectedAgent,
  RemoteDetectedAgent,
} from '@/common/types/detectedAgent';
import { isAgentKind } from '@/common/types/detectedAgent';
import type { RemoteAgentConfig } from '@process/agent/remote/types';

/**
 * Central registry for ALL detected execution engines.
 *
 * Coordinates sub-detectors, owns merged state, and provides the unified
 * `getDetectedAgents()` API consumed by IPC bridges.
 *
 * Sources:
 *   - Gemini       - always present (no CLI detection)
 *   - ACP builtin  - CLI agents on PATH (claude, qwen, codex, …)
 *   - ACP extension - contributed by hub extensions
 *   - Remote       - user-configured WebSocket agents (from DB)
 *   - Aionrs       - always present (Rust binary, availability resolved at runtime)
 *   - OpenClaw GW  - detected via `openclaw` CLI on PATH
 *   - Nanobot      - detected via `nanobot` CLI on PATH
 *   - Custom ACP   - user-defined ACP CLIs from ConfigStorage 'assistants'
 *
 * Preset assistants (prompt-only presets with no CLI binary) are NOT
 * execution engines - they live in the configuration layer and reference
 * execution engines by backend type.
 */
class AgentRegistry {
  private detectedAgents: DetectedAgent[] = [];
  private isInitialized = false;
  private mutationQueue: Promise<void> = Promise.resolve();
  /**
   * Memoized first detection pass. Every caller shares this one promise, so a
   * renderer query that arrives while boot-time detection is still running
   * awaits the SAME pass instead of observing the still-empty snapshot.
   */
  private initialDetection: Promise<void> | null = null;

  // Cache sub-detector results for partial refresh
  private builtinAgents: AcpDetectedAgent[] = [];
  private extensionAgents: AcpDetectedAgent[] = [];
  private remoteAgents: RemoteDetectedAgent[] = [];
  private otherAgents: DetectedAgent[] = [];
  private customAgents: AcpDetectedAgent[] = [];

  /**
   * Resolved path of the Darhai Core engine binary, or null when none is
   * installed. Refreshed only on the detection passes that also re-scan PATH,
   * because that is the only thing that can change the answer.
   *
   * CACHED BECAUSE THE MISS IS EXPENSIVE, not because the hit is. Measured on
   * Windows 11 by timing the real `resolveWCoreBinary()`, 4 runs of 1 cold +
   * 5 warm calls each:
   *
   *   bundled hit (steps 1-2, existsSync only)       0.2ms cold /    0.1ms warm
   *   PATH miss   (step 3, 2x execFileSync)    2275-3967ms cold / 1507-2935ms warm
   *
   * THE MISS IS THE BRANCH THIS FIELD EXISTS TO REPORT - a machine with no
   * engine installed - and every one of those milliseconds blocks the Electron
   * main process, because the resolver is synchronous (it has to be: the same
   * function backs `WCoreAgent.start()`). Resolving per read would put a second
   * or more on every `getDetectedAgents()` call. An earlier version of this
   * comment quoted only the ~1ms hit, which made the caching look like a
   * micro-optimisation instead of the thing keeping the UI responsive.
   *
   * The 5000ms per-lookup timeout in `binaryResolver` is NOT slack either: that
   * is ~1.1-2.0s per spawn in the runs above, and the slowest single run
   * observed was 7078ms for the pair (~3.5s each). Lowering it to match
   * `AcpDetector`'s 3000ms budget would turn a cold first run into a false
   * "not installed". Measured before assuming otherwise.
   */
  private wcoreBinaryPath: string | null = null;

  /**
   * Caught errors from sub-detector loading paths (e.g. remote agent DB read).
   * Surfaced via `getLoadErrors()` so the renderer can distinguish
   * "no agents configured" from "agent loading failed". Cleared on every
   * full re-detection (initialize/refreshAll) and on the targeted refresh
   * for the affected source (e.g. refreshRemoteAgents clears remote errors).
   */
  loadErrors: string[] = [];

  /**
   * `available: true` is UNCONDITIONAL here and that is the honest answer, not
   * a leftover: Gemini is an API-key backend with no local binary to find, so
   * there is no prerequisite for detection to check. A missing/invalid key
   * fails at request time, which detection cannot see. See the `available`
   * contract on `acpConversation.getAvailableAgents` for the full producer list.
   */
  private createGeminiAgent(): GeminiDetectedAgent {
    return {
      id: 'gemini',
      name: 'Gemini CLI',
      kind: 'gemini',
      available: true,
      backend: 'gemini',
    };
  }

  /**
   * The Darhai Core entry, with an `available` that means something.
   *
   * IT USED TO BE `available: true` UNCONDITIONALLY, with no `version`. That
   * made the entry answer "does Darhai SHIP the Core backend" - always yes -
   * while every caller reads the field as "can I use this engine". The Settings
   * panes were moved off it to `wcoreEngine.liveness`, but the producer stayed
   * wrong, so the next caller inherited the same lie.
   *
   * `available` NOW MEANS: a Core binary resolves on this machine. That is the
   * predicate the callers actually need - `WCoreAgent.start()` fails outright
   * when `resolveWCoreBinary()` returns null (wcore/index.ts:322), and both go
   * through that ONE resolver over the same enhanced PATH, so the two answers
   * cannot disagree. (They could before: the resolver used the raw
   * `process.env.PATH`, which at boot has not yet been merged with the login
   * shell's - see the note in `binaryResolver.lookupOnPath`.)
   *
   * It is still not a promise that the chat will succeed - the binary can be
   * present and refuse to start - only that it will not fail for want of one.
   *
   * It is deliberately NOT "an engine process is running". That question is
   * per-process, not per-backend, and `wcoreEngine.liveness` already answers it
   * from `liveEngines`. A list of installed backends cannot carry a running
   * count without the two disagreeing.
   *
   * `version` is the semver from the last engine `ready`, which is the build
   * that ACTUALLY RAN. Absent until some engine publishes one - an honest gap,
   * not a placeholder. The binary's own `--version` was rejected as the source:
   * measured 1678ms cold / 136ms warm, and it would run on every `merge()`.
   */
  private createWCoreAgent(): WCoreDetectedAgent {
    const { contract, known } = readEngineContract();
    // `=== true` and an explicit empty-string check: this repo compiles without
    // strictNullChecks, so nothing narrows on truthiness alone. `NO_CONTRACT`
    // carries `engineVersion: ''`, which must read as "not reported yet".
    const reported = known === true && typeof contract?.engineVersion === 'string' ? contract.engineVersion : '';
    return {
      id: 'wcore',
      name: 'Darhai Core',
      kind: 'wcore',
      available: this.wcoreBinaryPath !== null,
      backend: 'wcore',
      cliPath: this.wcoreBinaryPath === null ? undefined : this.wcoreBinaryPath,
      version: reported === '' ? undefined : reported,
    };
  }

  /**
   * Re-resolve the Core binary. Runs beside `detectOtherCliAgents()`, on the
   * same passes, because both answer "what is installed on this machine right
   * now" and both go stale for the same reason.
   */
  private detectWCoreBinary(): void {
    this.wcoreBinaryPath = resolveWCoreBinary();
  }

  /**
   * Detect non-ACP CLI agents (openclaw-gateway, nanobot) via CLI availability.
   * Uses the same `which`/`where` check as AcpDetector.
   */
  private detectOtherCliAgents(): DetectedAgent[] {
    const agents: DetectedAgent[] = [];

    if (acpDetector.isCliAvailable('openclaw')) {
      agents.push({
        id: 'openclaw-gateway',
        name: 'OpenClaw Gateway',
        kind: 'openclaw-gateway',
        available: true,
        backend: 'openclaw-gateway',
        cliPath: 'openclaw',
      } satisfies OpenClawDetectedAgent);
    }

    if (acpDetector.isCliAvailable('nanobot')) {
      agents.push({
        id: 'nanobot',
        name: 'Nanobot',
        kind: 'nanobot',
        available: true,
        backend: 'nanobot',
        cliPath: 'nanobot',
      } satisfies NanobotDetectedAgent);
    }

    return agents;
  }

  private async loadRemoteAgents(): Promise<RemoteDetectedAgent[]> {
    try {
      // Dynamic import to avoid circular dependency at module load time
      const { getDatabase } = await import('@process/services/database');
      const db = await getDatabase();
      const configs: RemoteAgentConfig[] = db.getRemoteAgents();
      // `available: true` is unconditional: a remote agent is a configured
      // endpoint, and whether it answers is a live probe, not a detection-time
      // fact. Reachability belongs to `acp.check-agent-health`, not here.
      return configs.map((config) => ({
        id: `remote:${config.id}`,
        name: config.name,
        kind: 'remote' as const,
        available: true,
        backend: 'remote',
        remoteAgentId: config.id,
        url: config.url,
        protocol: config.protocol,
        authType: config.authType,
      }));
    } catch (error) {
      const message = `[remote] ${String((error as { message?: unknown })?.message ?? error)}`;
      console.error('[AgentRegistry] Failed to load remote agents:', error);
      this.loadErrors.push(message);
      // NOTE: Sentry is not currently imported in this file; capture deferred
      // to a follow-up slice that wires Sentry into the main process modules.
      return [];
    }
  }

  /**
   * Deduplicate agents by backend ID. First occurrence wins - merge order
   * determines priority: Aionrs > Gemini > Builtin > Other > Remote > Extension > Custom.
   * When an extension contributes the same backend as a builtin, the builtin wins.
   *
   * Remote and custom agents share their `backend` string but are individually
   * addressable via their unique `id`, so they skip backend dedup.
   */
  private deduplicate(agents: DetectedAgent[]): DetectedAgent[] {
    const seen = new Set<string>();
    const result: DetectedAgent[] = [];

    for (const agent of agents) {
      const key = agent.kind === 'remote' || agent.backend === 'custom' ? agent.id : agent.backend;
      if (seen.has(key)) continue;
      seen.add(key);
      result.push(agent);
    }

    return result;
  }

  // prettier-ignore
  private merge(): void {
    this.detectedAgents = this.deduplicate([
      this.createWCoreAgent(),
      this.createGeminiAgent(),
      ...this.builtinAgents,
      ...this.otherAgents,
      ...this.remoteAgents,
      ...this.extensionAgents,
      ...this.customAgents,
    ]);
  }

  private async runExclusiveMutation<T>(task: () => Promise<T>): Promise<T> {
    const previousMutation = this.mutationQueue;
    let releaseCurrentMutation: (() => void) | undefined;

    this.mutationQueue = new Promise<void>((resolve) => {
      releaseCurrentMutation = resolve;
    });

    await previousMutation;

    try {
      return await task();
    } finally {
      releaseCurrentMutation?.();
    }
  }

  /**
   * Run all detection paths and update cached results.
   * Shared by initialize() and refreshAll().
   */
  private async detectAll(): Promise<void> {
    acpDetector.clearEnvCache();
    this.loadErrors = [];

    const [builtinAgents, extensionAgents, remoteAgents, customAgents] = await Promise.all([
      acpDetector.detectBuiltinAgents(),
      acpDetector.detectExtensionAgents(),
      this.loadRemoteAgents(),
      acpDetector.detectCustomAgents(),
    ]);

    this.builtinAgents = builtinAgents;
    this.extensionAgents = extensionAgents;
    this.remoteAgents = remoteAgents;
    this.customAgents = customAgents;
    this.otherAgents = this.detectOtherCliAgents();
    this.detectWCoreBinary();
    this.merge();
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  async initialize(): Promise<void> {
    if (this.isInitialized) return;
    this.initialDetection ??= this.runInitialDetection();
    await this.initialDetection;
  }

  private async runInitialDetection(): Promise<void> {
    await this.runExclusiveMutation(async () => {
      if (this.isInitialized) return;

      console.log('[AgentRegistry] Starting agent detection...');
      const startTime = Date.now();

      await this.detectAll();
      this.isInitialized = true;

      const elapsed = Date.now() - startTime;
      const agentSummary = this.detectedAgents.map((a) => a.name).join(', ');
      console.log(
        `[AgentRegistry] Completed in ${elapsed}ms, found ${this.detectedAgents.length} agents: ${agentSummary}`
      );
    });
  }

  /**
   * Await the first detection pass, starting it when nothing else has.
   *
   * Every reader of {@link getDetectedAgents} that can be reached from the
   * renderer must go through this. Detection is kicked off fire-and-forget at
   * boot (`src/index.ts`), so a query that lands before it finishes used to get
   * an empty array back and cache it - which is exactly how the agent picker
   * ended up with zero pills. Awaiting here makes the answer correct rather
   * than merely early, and self-starting detection removes the dependency on
   * boot-hook ordering entirely.
   */
  async whenReady(): Promise<void> {
    await this.initialize();
  }

  /** True once the first detection pass has completed. */
  get initialized(): boolean {
    return this.isInitialized;
  }

  /**
   * The merged snapshot, with the Core entry rebuilt on the way out.
   *
   * The rebuild is not cosmetic. `version` comes from the engine's `ready`,
   * which lands when the user opens a Core chat - long after the `merge()` that
   * built this snapshot, and nothing re-merges afterwards. Frozen at merge time
   * the field would stay absent for the whole session on the common path
   * (open a chat, then open Settings), which is the same "answer that went
   * stale and nobody noticed" class of defect this change exists to remove.
   *
   * Cheap enough to do per read: the binary path is already cached, so this is
   * a field read plus a module-variable read.
   */
  getDetectedAgents(): DetectedAgent[] {
    return this.detectedAgents.map((agent) => (agent.kind === 'wcore' ? this.createWCoreAgent() : agent));
  }

  /**
   * Returns errors caught during sub-detector loading (e.g. remote agent DB
   * read failures). Surfaced separately from `getDetectedAgents()` so the
   * existing array return shape (consumed by 10+ sites) is unchanged.
   *
   * Renderer should display these alongside the agent list so the user can
   * tell "no remote agents configured" apart from "remote loading failed".
   */
  getLoadErrors(): string[] {
    return [...this.loadErrors];
  }

  getAcpAgents(): AcpDetectedAgent[] {
    return this.detectedAgents.filter((a): a is AcpDetectedAgent => isAgentKind(a, 'acp'));
  }

  hasAgents(): boolean {
    return this.detectedAgents.length > 0;
  }

  /**
   * Refresh builtin CLI agents only (called when system PATH may have changed).
   * Clears cached env so newly installed/removed CLIs are detected.
   */
  async refreshBuiltinAgents(): Promise<void> {
    await this.runExclusiveMutation(async () => {
      acpDetector.clearEnvCache();

      const oldBuiltins = this.builtinAgents.map((a) => a.backend);
      this.builtinAgents = await acpDetector.detectBuiltinAgents();
      this.otherAgents = this.detectOtherCliAgents();
      this.detectWCoreBinary();
      const newBuiltins = this.builtinAgents.map((a) => a.backend);
      this.merge();

      const added = newBuiltins.filter((b) => !oldBuiltins.includes(b));
      const removed = oldBuiltins.filter((b) => !newBuiltins.includes(b));
      if (added.length > 0 || removed.length > 0) {
        console.log(`[AgentRegistry] Builtin agents changed: +[${added.join(', ')}] -[${removed.join(', ')}]`);
      }
    });
  }

  /**
   * Refresh extension-contributed agents (called after ExtensionRegistry.hotReload).
   * Clears cached env so newly installed CLIs are discoverable.
   */
  async refreshExtensionAgents(): Promise<void> {
    await this.runExclusiveMutation(async () => {
      acpDetector.clearEnvCache();
      this.extensionAgents = await acpDetector.detectExtensionAgents();
      this.merge();
    });
  }

  /**
   * Refresh remote agents from the database.
   * Called when remote agent config changes (create/update/delete).
   */
  async refreshRemoteAgents(): Promise<void> {
    await this.runExclusiveMutation(async () => {
      // Drop only the [remote]-prefixed errors so a successful reload clears
      // a previously surfaced failure without losing errors from other sources.
      this.loadErrors = this.loadErrors.filter((e) => !e.startsWith('[remote]'));
      this.remoteAgents = await this.loadRemoteAgents();
      this.merge();
    });
  }

  /**
   * Refresh custom ACP agents from ConfigStorage 'assistants'.
   * Called after the user adds/edits/deletes a custom agent in Settings.
   */
  async refreshCustomAgents(): Promise<void> {
    await this.runExclusiveMutation(async () => {
      this.customAgents = await acpDetector.detectCustomAgents();
      this.merge();
    });
  }

  /**
   * Re-run all detection paths from scratch.
   * Called after hub install since onInstall hooks may have installed new CLIs.
   */
  async refreshAll(): Promise<void> {
    await this.runExclusiveMutation(() => this.detectAll());
  }
}

export const agentRegistry = new AgentRegistry();
