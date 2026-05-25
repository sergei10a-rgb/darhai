/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

import { getSkillsDir, getBuiltinSkillsCopyDir, loadSkillsContent } from '@process/utils/initStorage';
import { AcpSkillManager, buildSkillsIndexText, type SkillIndex } from './AcpSkillManager';
import { SkillLibrary } from '@process/services/skills/SkillLibrary';
import { getTeamGuidePrompt } from '@process/team/prompts/teamGuidePrompt.ts';
import { resolveLeaderAssistantLabel } from '@process/team/prompts/teamGuideAssistant.ts';
import { composePrompt } from '@process/services/constitution/composePrompt';
import { composeWorkflowSystemPrompt } from '@process/services/workflow/composeWorkflowSystemPrompt';
import { getWorkflowSessionService } from '@process/services/workflow/workflowSessionServiceSingleton';

/**
 * One-line advertisement for the wayland_search_skills MCP tool.
 * Injected into every backend's system prompt when the skill library is non-empty.
 * Single source of truth — do not copy-paste into individual managers.
 */
export function searchSkillsAdvertText(): string {
  return 'Use the `wayland_search_skills` tool to discover skills from the full library on demand.';
}

/**
 * Returns true when the SkillLibrary singleton has at least one entry loaded.
 * Checks the in-memory state only (no I/O) — safe to call on every message.
 */
async function libraryIsNonEmpty(): Promise<boolean> {
  try {
    const lib = SkillLibrary.getInstance();
    const entries = await lib.list();
    return entries.length > 0;
  } catch {
    return false;
  }
}

/**
 * First message processing configuration
 */
export interface FirstMessageConfig {
  /** Preset context/rules */
  presetContext?: string;
  /** Enabled skills list */
  enabledSkills?: string[];
  /** Builtin auto-injected skills to exclude */
  excludeBuiltinSkills?: string[];
  /** Inject Team mode guidance prompt when agent has aion_create_team capability */
  enableTeamGuide?: boolean;
  /** Agent backend type (e.g. 'claude', 'codex') — used to populate team guide prompt */
  backend?: string;
  /**
   * Preset assistant id backing this conversation (e.g. 'builtin-word-creator').
   * When set, the team guide prompt shows the assistant's display name on the
   * Leader row instead of the raw backend key.
   */
  presetAssistantId?: string;
  /**
   * Workflow Launch Surface (v0.6.0) — id of the live `WorkflowSession` this
   * conversation is bound to. When set, the static `WORKFLOW_PROTOCOL` block
   * (SPEC §7.1) is appended to the END of system instructions per the
   * "primacy at the end" rule (SPEC §7.3). Soft-fails if the live service is
   * unavailable or the session id no longer resolves.
   */
  workflowSessionId?: string;
}

/**
 * Resolves the workflow session for `workflowSessionId` and returns the static
 * `WORKFLOW_PROTOCOL` system block (SPEC §7.1). Returns `null` when:
 *   - no id was provided,
 *   - the singleton service is not yet wired (cold start race),
 *   - no session exists for the id,
 *   - any error is thrown during lookup (soft-fail — the first-message build
 *     must never break because of workflow plumbing).
 *
 * Callers append the returned string to the END of the assembled instructions
 * so it cannot be diluted by earlier preset/skill content.
 */
async function tryComposeWorkflowProtocol(
  workflowSessionId: string | undefined
): Promise<string | null> {
  if (!workflowSessionId) return null;
  try {
    const service = getWorkflowSessionService();
    if (service === null) return null;
    const session = await service.findById(workflowSessionId);
    if (session === null) return null;
    return composeWorkflowSystemPrompt(session);
  } catch (err) {
    console.warn('[agentUtils] failed to inject WORKFLOW_PROTOCOL:', err);
    return null;
  }
}

/**
 * Build system instructions content (full skills content injection - for Gemini)
 *
 * @param config - First message configuration
 * @returns System instructions string or undefined
 */
export async function buildSystemInstructions(config: FirstMessageConfig): Promise<string | undefined> {
  const instructions: string[] = [];

  // Add preset context
  if (config.presetContext) {
    instructions.push(config.presetContext);
  }

  // Load and add skills content
  if (config.enabledSkills && config.enabledSkills.length > 0) {
    const skillsContent = await loadSkillsContent(config.enabledSkills);
    if (skillsContent) {
      instructions.push(skillsContent);
    }
  }

  // Inject Team Guide prompt when agent has team guide capability
  if (config.enableTeamGuide) {
    const leaderLabel = await resolveLeaderAssistantLabel(config.presetAssistantId);
    instructions.push(getTeamGuidePrompt({ backend: config.backend, leaderLabel }));
  }

  // Workflow Launch Surface — append WORKFLOW_PROTOCOL LAST so it sits at the
  // end of the assembled system content (SPEC §7.3 "primacy at the end").
  const workflowProtocol = await tryComposeWorkflowProtocol(config.workflowSessionId);
  if (workflowProtocol !== null) {
    instructions.push(workflowProtocol);
  }

  const basePrompt = instructions.length === 0 ? '' : instructions.join('\n\n');
  // Prepend Wayland Constitution + optional specialist overlay (stable across
  // turns so Anthropic/OpenAI prompt caches hit). composePrompt returns ''
  // when no Constitution file exists, so this is a no-op for fresh installs
  // and we preserve the previous "return undefined" behaviour.
  const composed = composePrompt({ assistantId: config.presetAssistantId, basePrompt }).text;
  return composed.length === 0 ? undefined : composed;
}

/**
 * Inject system instructions for first message (full skills content - for Gemini)
 *
 * Note: Use direct prefix instead of XML tags to ensure external agents like Claude Code CLI can recognize it
 *
 * @param content - Original message content
 * @param config - First message configuration
 * @returns Message content with system instructions injected
 */
export async function prepareFirstMessage(content: string, config: FirstMessageConfig): Promise<string> {
  const systemInstructions = await buildSystemInstructions(config);

  if (!systemInstructions) {
    return content;
  }

  // Use direct prefix format similar to Gemini Agent to ensure Claude/Codex can recognize it
  return `[Assistant Rules - You MUST follow these instructions]\n${systemInstructions}\n\n[User Request]\n${content}`;
}

/**
 * Prepare first message: inject rules + skills INDEX (not full content)
 *
 * Used for ACP agents (Claude/OpenCode) and Codex; Agent reads skill files on-demand using Read tool.
 *
 * Note: Builtin skills (in _builtin/ directory) are auto-injected, no need to specify in enabledSkills
 *
 * @param content - Original message content
 * @param config - First message configuration
 * @returns Message content with injected instructions and loaded skills list
 */
export async function prepareFirstMessageWithSkillsIndex(
  content: string,
  config: FirstMessageConfig
): Promise<{ content: string; loadedSkills: SkillIndex[] }> {
  const instructions: string[] = [];
  let loadedSkills: SkillIndex[] = [];

  // 1. Add preset rules
  if (config.presetContext) {
    instructions.push(config.presetContext);
  }

  // 2. Load skills INDEX (always-on set only: builtin + pinned + assistant enabledSkills)
  // Use singleton to avoid repeated filesystem scans
  const skillManager = AcpSkillManager.getInstance(config.enabledSkills);
  // discoverSkills auto-loads builtin skills first
  await skillManager.discoverSkills(config.enabledSkills, config.excludeBuiltinSkills);

  const hasLib = await libraryIsNonEmpty();

  // Only inject if there are any skills or a library advert is needed
  if (skillManager.hasAnySkills() || hasLib) {
    const excludeSet = new Set(config.excludeBuiltinSkills ?? []);
    // Filter out excluded builtin skills — the singleton cache may not reflect excludeBuiltinSkills
    const skillsIndex = skillManager.getSkillsIndex().filter((s) => !excludeSet.has(s.name));
    loadedSkills = skillsIndex;
    // getSkillsDir() already returns CLI-safe path (symlink on macOS)
    const skillsDir = getSkillsDir();
    const builtinSkillsCopyDir = getBuiltinSkillsCopyDir();
    const builtinSkillsDir = builtinSkillsCopyDir + '/_builtin';
    // Pass hasLib so the index text includes the wayland_search_skills discovery note
    const indexText = buildSkillsIndexText(skillsIndex, hasLib);

    // Tell Agent where skills files are located for on-demand reading
    const skillsInstruction = `${indexText}

[Skills Location]
Skills are stored in three locations:
- Builtin skills (auto-enabled): ${builtinSkillsDir}/{skill-name}/SKILL.md
- Bundled skills: ${builtinSkillsCopyDir}/{skill-name}/SKILL.md
- User custom skills: ${skillsDir}/{skill-name}/SKILL.md

Each skill has a SKILL.md file containing detailed instructions.
To use a skill, read its SKILL.md file when needed.

For example:
- Builtin "cron" skill: ${builtinSkillsDir}/cron/SKILL.md
- Bundled "pptx" skill: ${builtinSkillsCopyDir}/pptx/SKILL.md`;

    instructions.push(skillsInstruction);
  }

  // 3. Inject Team Guide prompt when agent has team guide capability
  if (config.enableTeamGuide) {
    const leaderLabel = await resolveLeaderAssistantLabel(config.presetAssistantId);
    instructions.push(getTeamGuidePrompt({ backend: config.backend, leaderLabel }));
  }

  // 4. Workflow Launch Surface — append WORKFLOW_PROTOCOL LAST so it sits at
  // the end of the rules content (SPEC §7.3 "primacy at the end").
  const workflowProtocol = await tryComposeWorkflowProtocol(config.workflowSessionId);
  if (workflowProtocol !== null) {
    instructions.push(workflowProtocol);
  }

  const basePrompt = instructions.length === 0 ? '' : instructions.join('\n\n');
  // Prepend Wayland Constitution + optional specialist overlay above the
  // existing rules content. Composer returns '' when no Constitution exists,
  // preserving the previous "skip rules block entirely" behaviour.
  const systemInstructions = composePrompt({ assistantId: config.presetAssistantId, basePrompt }).text;
  if (systemInstructions.length === 0) {
    return { content, loadedSkills };
  }
  return {
    content: `[Assistant Rules - You MUST follow these instructions]\n${systemInstructions}\n\n[User Request]\n${content}`,
    loadedSkills,
  };
}

/**
 * Build system instructions with skills INDEX only (no full content - for Gemini)
 *
 * Gemini has no file read tool and cannot read SKILL.md files on its own.
 * When Gemini needs detailed instructions for a skill, it outputs [LOAD_SKILL: skill-name],
 * and the system intercepts it and sends back the full skill content as [System Response].
 *
 * @param config - First message configuration
 * @returns System instructions string or undefined
 */
export async function buildSystemInstructionsWithSkillsIndex(config: FirstMessageConfig): Promise<string | undefined> {
  const instructions: string[] = [];

  // Add preset context
  if (config.presetContext) {
    instructions.push(config.presetContext);
  }

  // Load skills INDEX (always-on set only: builtin + pinned + assistant enabledSkills)
  const skillManager = AcpSkillManager.getInstance(config.enabledSkills);
  await skillManager.discoverSkills(config.enabledSkills, config.excludeBuiltinSkills);

  const hasLib = await libraryIsNonEmpty();

  if (skillManager.hasAnySkills() || hasLib) {
    const excludeSet = new Set(config.excludeBuiltinSkills ?? []);
    const skillsIndex = skillManager.getSkillsIndex().filter((s) => !excludeSet.has(s.name));
    // Pass hasLib so the index text includes the wayland_search_skills discovery note
    const indexText = buildSkillsIndexText(skillsIndex, hasLib);
    if (indexText.length > 0) {
      instructions.push(indexText);
    }
  }

  // Inject Team Guide prompt when agent has team guide capability
  if (config.enableTeamGuide) {
    const leaderLabel = await resolveLeaderAssistantLabel(config.presetAssistantId);
    instructions.push(getTeamGuidePrompt({ backend: config.backend, leaderLabel }));
  }

  // Workflow Launch Surface — append WORKFLOW_PROTOCOL LAST so it sits at the
  // end of the assembled system content (SPEC §7.3 "primacy at the end").
  const workflowProtocol = await tryComposeWorkflowProtocol(config.workflowSessionId);
  if (workflowProtocol !== null) {
    instructions.push(workflowProtocol);
  }

  const basePrompt = instructions.length === 0 ? '' : instructions.join('\n\n');
  // Prepend Wayland Constitution + optional specialist overlay (stable
  // turn-to-turn for prompt-cache reuse). Returns '' when no Constitution
  // is configured, preserving the previous "return undefined" behaviour.
  const composed = composePrompt({ assistantId: config.presetAssistantId, basePrompt }).text;
  return composed.length === 0 ? undefined : composed;
}
