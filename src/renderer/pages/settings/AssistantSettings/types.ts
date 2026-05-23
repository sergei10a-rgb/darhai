import type { AcpBackendConfig } from '@/common/types/acpTypes';

// Skill info type
export type SkillSource = 'builtin' | 'custom' | 'extension';

export type SkillInfo = {
  name: string;
  description: string;
  location: string;
  isCustom: boolean;
  source: SkillSource;
};

// External source type
export type ExternalSource = {
  name: string;
  path: string;
  source: string;
  skills: Array<{ name: string; description: string; path: string }>;
};

// Pending skill to import
export type PendingSkill = {
  path: string;
  name: string;
  description: string;
};

// Builtin auto-injected skill info
export type BuiltinAutoSkill = {
  name: string;
  description: string;
};

export type AssistantListItem = AcpBackendConfig & {
  _source?: string;
  _extensionName?: string;
  _kind?: string;
  /** W1a — Roster of specialist assistant IDs that compose this launcher (kind==='team' only). */
  _teammates?: string[];
  /** W1a — Recurring rituals declared by the launcher (e.g. weekly standup). */
  _rituals?: Array<{ name: string; cadence: string }>;
  /** W1a / TRIAGE C4 — True only for the 5 Standing Companies. */
  _standing?: boolean;
};
