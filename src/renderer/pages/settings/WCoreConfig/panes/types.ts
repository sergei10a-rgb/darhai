/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * The Wayland Core left-rail sections, in display order.
 *
 * NOTE: Constitution is deliberately NOT here. The engine has no constitution
 * of its own (it is a Desktop concept), so the standalone Constitution entry
 * lives in the Desktop settings nav, not the Core rail.
 */
export type WCoreRailKey = 'overview' | 'services' | 'tools' | 'memory' | 'security' | 'profiles' | 'runtime';

/*
 * ---------------------------------------------------------------------------
 * Engine capability frames, as the RENDERER receives them.
 * ---------------------------------------------------------------------------
 *
 * These mirror the payloads the main-process capability handlers emit
 * (`src/process/agent/wcore/capabilities/handlers/{capabilityActivation,
 * runtimeDiagnostics}.ts`) and that `WCoreManager` forwards verbatim on
 * `ipcBridge.conversation.responseStream` as `{ type, data, msg_id,
 * conversation_id }`.
 *
 * WHY MIRRORED RATHER THAN IMPORTED. `src/renderer` must not import from
 * `src/process` - the process boundary is a project rule, and the diagnostics
 * handler pulls in `node:crypto`. A `import type` would erase at runtime but
 * would still put a main-process module in the renderer's type graph and invite
 * the first non-type import.
 *
 * WHY THE UNIONS ARE COPIED EXACTLY rather than widened to `string`. The
 * handlers already reject any value outside these sets at the decode boundary
 * (an unrecognised member arrives as an `unreadable` entry, never as a row), so
 * nothing wider can reach here. Copying them exactly is what makes the two label
 * maps in `RuntimePane` - `Record<McpExecutableReadiness, string>` and
 * `Record<McpRemediation, string>` - exhaustive: adding a member here without
 * writing its i18n label is a type error in that file, which is the only place
 * the UI would otherwise print a raw engine token at a user.
 *
 * DRIFT AGAINST THE HANDLER is caught at RUNTIME, not by the compiler:
 * `tsconfig.json` does not include `tests/`, so nothing type-checks a test's
 * imports. `tests/unit/renderer/settings/EngineCapabilityPanes.dom.test.tsx`
 * therefore builds every payload by driving the contract fixtures through the
 * real handler and asserting on what these panes render - a renamed field breaks
 * the render assertion rather than passing silently.
 */

/** How this host grades a capability's activation stage. */
export type EngineCapabilityHealth = 'ok' | 'declined' | 'changed';

/** What a host may honestly tell the user about a stated reason. */
export type EngineCapabilityRemedy = 'config' | 'not_configurable' | 'unknown';

/** One `capability_activation` frame, post-decode. */
export type EngineCapabilityFrame = {
  capability: string;
  stage: string;
  /** Null when the engine stated none - never invented. */
  reason: string | null;
  health: EngineCapabilityHealth;
  remedy: EngineCapabilityRemedy;
};

/**
 * One row of the Overview readiness table: the latest frame per capability.
 *
 * It carries no frame COUNT, and deliberately so. The fold used to maintain one
 * on every frame that no JSX ever read - an array copy per frame, 24 per engine
 * start, for a number nothing displayed. The count is also not the renderer's
 * to keep: the main process holds the authoritative one
 * (`IWcoreCapabilityRow.frames`), the mount-time snapshot seeds this table from
 * that record, and a second locally-derived number would disagree with it for
 * every pane that mounted after the engine started - which is every pane.
 */
export type EngineCapabilityRow = EngineCapabilityFrame;

export type RuntimeProfileBinding = 'unknown' | 'default_home' | 'explicit_home' | 'bound_profile' | 'unbound_profile';

export type RuntimeEngineMode = 'unknown' | 'standard' | 'raw';

export type RuntimeWorkspaceKind = 'unknown' | 'none' | 'project' | 'temporary' | 'profile_home';

export type ConfigSourceRole =
  | 'global'
  | 'project'
  | 'profile'
  | 'cli'
  | 'environment'
  | 'credential_store'
  | 'desktop_launch';

export type ConfigDisposition =
  | 'loaded'
  | 'absent'
  | 'ignored'
  | 'unreadable'
  | 'invalid'
  | 'overridden'
  | 'restricted';

export type McpOrigin =
  | 'effective_config'
  | 'global_config'
  | 'project_config'
  | 'profile_config'
  | 'runtime_command'
  | 'plugin';

export type McpTransport = 'stdio' | 'sse' | 'streamable_http';

export type McpConnection =
  | 'configured'
  | 'deferred'
  | 'connecting'
  | 'ready'
  | 'failed'
  | 'timed_out'
  | 'skipped'
  | 'stopping'
  | 'stopped';

export type McpExposure =
  | 'not_attempted'
  | 'not_applicable'
  | 'exposed'
  | 'resource_only'
  | 'resource_only_unavailable'
  | 'hidden_no_tools'
  | 'blocked';

/** Why an MCP server's executable did or did not resolve. Every value is labelled. */
export type McpExecutableReadiness =
  | 'not_applicable'
  | 'unchecked'
  | 'resolved'
  | 'missing_effective_path'
  | 'not_found'
  | 'invalid_absolute_path'
  | 'invalid_executable'
  | 'invalid_effective_environment'
  | 'permission_denied'
  | 'not_executable'
  | 'probe_timed_out'
  | 'unsupported_transport';

export type McpWorkingDirectory = 'inherited_process' | 'project_root' | 'profile_home' | 'explicit';

/** The engine's own machine-readable "what to do about it". Every value is labelled. */
export type McpRemediation =
  | 'open_active_config'
  | 'restart_desktop'
  | 'fix_gui_launch_path'
  | 'install_executable'
  | 'fix_executable_permissions'
  | 'review_server_config'
  | 'retry_connection'
  | 'retry_diagnostics'
  | 'check_assistant_scope'
  | 'restart_to_load_resources';

export type McpFailure =
  | 'missing_executable'
  | 'launch_failed'
  | 'connection_refused'
  | 'timeout'
  | 'protocol_mismatch'
  | 'authentication_required'
  | 'authorization_denied'
  | 'invalid_configuration'
  | 'transport_closed'
  | 'unknown';

export type DiagnosticsUnavailableReason = 'unsupported_version' | 'invalid_request';

/** `snapshot.process` - how this engine process is bound. */
export type RuntimeProcessBinding = {
  profile_binding: RuntimeProfileBinding;
  engine_mode: RuntimeEngineMode;
  workspace_kind: RuntimeWorkspaceKind;
  /** Absent when no profile is named. The row is omitted rather than guessed. */
  profile_name?: string;
};

/** One entry of the config-source precedence chain. */
export type RuntimeConfigSource = {
  role: ConfigSourceRole;
  disposition: ConfigDisposition;
  precedence: number;
  content_digest?: string;
  display_path?: string;
};

/** An environment override the engine did NOT honour. */
export type RuntimeUnsupportedOverride = {
  name: string;
  disposition: ConfigDisposition;
};

/** The engine's own view of one MCP server. */
export type RuntimeMcpServer = {
  name: string;
  origin: McpOrigin;
  transport: McpTransport;
  connection: McpConnection;
  exposure: McpExposure;
  deferred: boolean;
  tool_count: number;
  resources_declared: boolean;
  resources_exposed: boolean;
  assistant_scoped: boolean;
  executable_readiness: McpExecutableReadiness;
  working_directory: McpWorkingDirectory;
  remediation: McpRemediation[];
  executable_basename?: string;
  failure?: McpFailure;
};

export type RuntimeDiagnosticsSnapshot = {
  process: RuntimeProcessBinding;
  config_sources: RuntimeConfigSource[];
  unsupported_overrides: RuntimeUnsupportedOverride[];
  mcp_servers: RuntimeMcpServer[];
};

/**
 * One list entry the host could not read.
 *
 * Kept as an explicit hole rather than dropped: a configured server missing
 * from the list would read as "not configured", which is the quiet lie the
 * whole diagnostics readout exists to remove.
 */
export type UnreadableSnapshotEntry = {
  list: 'config_sources' | 'unsupported_overrides' | 'mcp_servers';
  index: number;
  name: string | null;
  reason: string;
  offending?: string;
};

/** What the renderer receives for a diagnostics round-trip. */
export type RuntimeDiagnosticsFrame =
  | {
      status: 'snapshot';
      requestId: string;
      snapshot: RuntimeDiagnosticsSnapshot;
      unreadable: UnreadableSnapshotEntry[];
    }
  | {
      status: 'unavailable';
      requestId: string;
      /** What THIS HOST sent, from the ledger - not an echo. */
      requestedVersion: number;
      echoedVersion: number;
      /** True when the engine answered about a version Darhai never asked for. */
      echoMismatch: boolean;
      supportedVersion: number;
      reason: DiagnosticsUnavailableReason;
    }
  | { status: 'undecodable'; requestId: string; detail: string; offending?: string };

/** What the renderer receives for an MCP removal. */
export type McpRemovalFrame =
  | {
      status: 'result';
      requestId: string;
      name: string;
      /**
       * Free-form in the contract - the only value it exhibits is `removed`.
       * Rendered verbatim; never compared against a literal.
       */
      outcome: string;
      removedTools: string[];
      removedToolCount: number;
      toolsTruncated: boolean;
    }
  | { status: 'name_mismatch'; requestId: string; requestedName: string; reportedName: string; outcome: string }
  | { status: 'undecodable'; requestId: string; detail: string; offending?: string };
