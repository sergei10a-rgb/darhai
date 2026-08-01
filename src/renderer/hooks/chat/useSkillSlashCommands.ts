/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Offer the skill library in the `/` menu.
 *
 * Until now the 2,470 bundled skills were reachable only two ways: the model
 * guessed one per turn, or the model searched for one. A user who already knew
 * the name of the skill they wanted had no way to say so - the one case where
 * neither guessing nor searching is needed.
 *
 * Why this is a separate hook from `useSlashCommands`
 * --------------------------------------------------
 * That hook fetches a conversation's command list once and caches it. A skill
 * list cannot work that way: 2,470 entries is ~1.2 MB over IPC, too much to
 * hold in the menu and far too much to re-send per keystroke. So this queries
 * as the user types and returns only the top few, ranked by the same BM25
 * retriever the agent uses - one library, one ranking, whichever way you reach
 * it.
 */

import { useEffect, useRef, useState } from 'react';
import { ipcBridge } from '@/common';
/**
 * Read the `/word` the caret is sitting in, or null.
 *
 * Deliberately not imported from `useSlashCommandController`: several sendbox
 * test suites replace that whole module with a mock, and importing a helper
 * from it would make this hook fail wherever the menu itself is stubbed out.
 * The rule is small enough that a local copy costs less than that coupling.
 */
function matchSlashQuery(input: string): string | null {
  const match = /(?:^|\s)\/([^\s]*)$/.exec(input ?? '');
  return match ? match[1] : null;
}
import type { SlashCommandItem } from '@/common/chat/slash/types';

/**
 * Shortest prefix that triggers a lookup.
 *
 * One character against 2,470 entries returns whatever happens to sort first,
 * which reads as noise and pushes the real commands out of the menu. Two is
 * enough to be a deliberate act of naming something.
 */
const MIN_QUERY_CHARS = 2;

/** Menu space is finite, and a long list is a worse answer than a short one. */
const MAX_SKILL_SUGGESTIONS = 8;

export function useSkillSlashCommands(input: string): SlashCommandItem[] {
  const [items, setItems] = useState<SlashCommandItem[]>([]);
  const requestIdRef = useRef(0);

  const query = matchSlashQuery(input);

  useEffect(() => {
    const requestId = ++requestIdRef.current;

    const keyword = (query ?? '').trim();
    if (query === null || keyword.length < MIN_QUERY_CHARS) {
      setItems([]);
      return;
    }

    // The verb may be absent: a host that stubs the bridge, or a build where
    // the skills bridge has not registered yet. Skills are an addition to the
    // `/` menu, never a requirement for it - the agent's own commands must
    // keep working regardless.
    const search = ipcBridge.skills?.search;
    if (!search) {
      setItems([]);
      return;
    }

    let cancelled = false;
    void search
      .invoke({ query: keyword, limit: MAX_SKILL_SUGGESTIONS })
      .then((results) => {
        // Guard on both flags: `cancelled` covers unmount, `requestId` covers
        // an older keystroke's response arriving after a newer one.
        if (cancelled || requestId !== requestIdRef.current) return;
        setItems(
          (results ?? []).map((skill) => ({
            name: skill.name,
            description: skill.description,
            kind: 'builtin' as const,
            source: 'builtin' as const,
            // The badge is what tells the user this row inserts a skill rather
            // than running an agent command - both look like `/name` otherwise.
            hint: 'skill',
            selectionBehavior: 'execute' as const,
          }))
        );
      })
      .catch(() => {
        if (cancelled || requestId !== requestIdRef.current) return;
        // A failed lookup shows no skills; it must never blank the agent's own
        // commands, which live in a different list.
        setItems([]);
      });

    return () => {
      cancelled = true;
    };
  }, [query]);

  return items;
}
