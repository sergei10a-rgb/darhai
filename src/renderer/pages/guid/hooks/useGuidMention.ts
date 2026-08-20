/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

import { getAgentLogo } from '@/renderer/utils/model/agentLogo';
import { getBackendLabel } from '@/renderer/utils/model/backendLabel';
import { CUSTOM_AVATAR_IMAGE_MAP } from '../constants';
import type { AvailableAgent, MentionOption } from '../types';
import { getAgentKey } from './agentSelectionUtils';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

export type GuidMentionResult = {
  mentionQuery: string | null;
  setMentionQuery: React.Dispatch<React.SetStateAction<string | null>>;
  mentionOpen: boolean;
  setMentionOpen: React.Dispatch<React.SetStateAction<boolean>>;
  mentionSelectorVisible: boolean;
  setMentionSelectorVisible: React.Dispatch<React.SetStateAction<boolean>>;
  mentionSelectorOpen: boolean;
  setMentionSelectorOpen: React.Dispatch<React.SetStateAction<boolean>>;
  mentionActiveIndex: number;
  setMentionActiveIndex: React.Dispatch<React.SetStateAction<number>>;
  mentionOptions: MentionOption[];
  filteredMentionOptions: MentionOption[];
  selectMentionAgent: (key: string) => void;
  mentionMenuRef: React.RefObject<HTMLDivElement>;
  mentionMatchRegex: RegExp;
  selectedAgentLabel: string;
  mentionMenuSelectedKey: string;
};

type UseGuidMentionOptions = {
  availableAgents: AvailableAgent[] | undefined;
  customAgentAvatarMap: Map<string, string | undefined>;
  selectedAgentKey: string;
  setSelectedAgentKey: (key: string) => void;
  setInput: React.Dispatch<React.SetStateAction<string>>;
  selectedAgentInfo: AvailableAgent | undefined;
};

/**
 * Display label for an agent key.
 *
 * `getAgentKey` yields either a bare backend id ("wcore", "claude") or a
 * composite "custom:<uuid>" / "remote:<uuid>". Only the backend segment carries
 * display meaning, so the id suffix is dropped before the shared label map is
 * consulted - otherwise a custom agent would render its uuid.
 *
 * `getBackendLabel` capitalizes anything it does not know, so an unrecognized
 * backend still produces readable text rather than an empty string. The final
 * `|| agentKey` keeps the result no worse than the raw key if the map ever
 * returns empty for a non-empty key.
 */
const getAgentKeyLabel = (agentKey: string): string => {
  const backendId = agentKey.split(':')[0] ?? '';
  return getBackendLabel(backendId) || agentKey;
};

/**
 * Hook that manages the @ mention system for agent selection.
 */
export const useGuidMention = ({
  availableAgents,
  customAgentAvatarMap,
  selectedAgentKey,
  setSelectedAgentKey,
  setInput,
  selectedAgentInfo,
}: UseGuidMentionOptions): GuidMentionResult => {
  const [mentionQuery, setMentionQuery] = useState<string | null>(null);
  const [mentionOpen, setMentionOpen] = useState(false);
  const [mentionSelectorVisible, setMentionSelectorVisible] = useState(false);
  const [mentionSelectorOpen, setMentionSelectorOpen] = useState(false);
  const [mentionActiveIndex, setMentionActiveIndex] = useState(0);
  const mentionMenuRef = useRef<HTMLDivElement>(null);
  const mentionMatchRegex = useMemo(() => /(?:^|\s)@([^\s@]*)$/, []);

  const mentionOptions = useMemo(() => {
    const agents = availableAgents || [];
    return agents.map((agent) => {
      const key = getAgentKey(agent);
      // Same raw-id leak as `selectedAgentLabel` below: a detected agent that
      // arrives without a `name` used to render its bare backend id as the
      // dropdown row. The raw id stays in `tokens` further down, so typing
      // "@wcore" still matches the humanized row.
      const label = agent.name || getBackendLabel(agent.backend);
      const avatarValue = agent.customAgentId
        ? agent.avatar || customAgentAvatarMap.get(agent.customAgentId)
        : undefined;
      const avatar = avatarValue ? avatarValue.trim() : undefined;
      const tokens = new Set<string>();
      const normalizedLabel = label.toLowerCase();
      tokens.add(normalizedLabel);
      tokens.add(normalizedLabel.replace(/\s+/g, '-'));
      tokens.add(normalizedLabel.replace(/\s+/g, ''));
      tokens.add(agent.backend.toLowerCase());
      if (agent.customAgentId) {
        tokens.add(agent.customAgentId.toLowerCase());
      }
      const mappedAvatarImage = avatar ? CUSTOM_AVATAR_IMAGE_MAP[avatar] : undefined;
      const avatarImage =
        mappedAvatarImage || (avatar && /^(https?:|file:|data:|wayland-asset:|\/)/.test(avatar) ? avatar : undefined);
      return {
        key,
        label,
        tokens,
        avatar,
        avatarImage,
        logo: getAgentLogo(agent.backend) || undefined,
        isExtension: agent.isExtension,
      };
    });
  }, [availableAgents, customAgentAvatarMap]);

  const filteredMentionOptions = useMemo(() => {
    if (!mentionQuery) return mentionOptions;
    const query = mentionQuery.toLowerCase();
    return mentionOptions.filter((option) => Array.from(option.tokens).some((token) => token.startsWith(query)));
  }, [mentionOptions, mentionQuery]);

  const stripMentionToken = useCallback(
    (value: string) => {
      if (!mentionMatchRegex.test(value)) return value;
      return value.replace(mentionMatchRegex, (_match, _query) => '').trimEnd();
    },
    [mentionMatchRegex]
  );

  const selectMentionAgent = useCallback(
    (key: string) => {
      setSelectedAgentKey(key);
      setInput((prev) => stripMentionToken(prev));
      setMentionOpen(false);
      setMentionSelectorOpen(false);
      setMentionSelectorVisible(true);
      setMentionQuery(null);
      setMentionActiveIndex(0);
    },
    [stripMentionToken, setSelectedAgentKey, setInput]
  );

  // `availableAgents` arrives over SWR, so `selectedAgentInfo` is undefined on
  // the first frame and this fallback is what the user actually sees. Returning
  // the raw key leaked the internal engine id ("wcore") into three surfaces in
  // GuidPage.tsx: the composer placeholder, the mention badge and the hero
  // title. Route it through the shared label map so the first frame shows the
  // same user-facing name as every frame after it.
  const selectedAgentLabel = selectedAgentInfo?.name || getAgentKeyLabel(selectedAgentKey);
  const mentionMenuActiveOption = filteredMentionOptions[mentionActiveIndex] || filteredMentionOptions[0];
  const mentionMenuSelectedKey =
    mentionOpen || mentionSelectorOpen ? mentionMenuActiveOption?.key || selectedAgentKey : selectedAgentKey;

  // Reset active index on open/query change
  useEffect(() => {
    if (mentionOpen) {
      setMentionActiveIndex(0);
      return;
    }
    if (mentionSelectorOpen) {
      const selectedIndex = filteredMentionOptions.findIndex((option) => option.key === selectedAgentKey);
      setMentionActiveIndex(selectedIndex >= 0 ? selectedIndex : 0);
    }
  }, [filteredMentionOptions, mentionOpen, mentionQuery, mentionSelectorOpen, selectedAgentKey]);

  // Scroll active mention item into view
  useEffect(() => {
    if (!mentionOpen && !mentionSelectorOpen) return;
    const container = mentionMenuRef.current;
    if (!container) return;
    const target = container.querySelector<HTMLElement>(`[data-mention-index="${mentionActiveIndex}"]`);
    if (!target) return;
    target.scrollIntoView({ block: 'nearest' });
  }, [mentionActiveIndex, mentionOpen, mentionSelectorOpen]);

  return {
    mentionQuery,
    setMentionQuery,
    mentionOpen,
    setMentionOpen,
    mentionSelectorVisible,
    setMentionSelectorVisible,
    mentionSelectorOpen,
    setMentionSelectorOpen,
    mentionActiveIndex,
    setMentionActiveIndex,
    mentionOptions,
    filteredMentionOptions,
    selectMentionAgent,
    mentionMenuRef,
    mentionMatchRegex,
    selectedAgentLabel,
    mentionMenuSelectedKey,
  };
};
