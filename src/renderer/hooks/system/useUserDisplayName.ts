/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Resolves the user's display name for the new-chat greeting.
 *
 * The desktop runtime has no authenticated user, so the name defaults to the
 * OS account name (`application.systemInfo.userName`). The user can override it
 * in Settings; the override is persisted in the `user.displayName` config key.
 */

import { useCallback, useEffect, useState } from 'react';
import { ipcBridge } from '@/common';
import { ConfigStorage } from '@/common/config/storage';

/**
 * Longest display name the greeting will render.
 *
 * The greeting inlines the name into an h1 ("<phrase>, <name>"), so an
 * oversized value takes the whole home screen over. A live install had a
 * 140-character automation prompt stored here and the home screen rendered it
 * verbatim as the user's "name". Names are short; anything longer is either a
 * mistake or a paste accident, so it is clamped on both read and write.
 */
export const MAX_DISPLAY_NAME_LENGTH = 40;

/**
 * Collapse newlines/tabs, squeeze runs of whitespace and clamp to
 * {@link MAX_DISPLAY_NAME_LENGTH}. Exported for tests and for the Settings
 * field to share one definition of "a usable name".
 */
export const sanitizeDisplayName = (raw: string): string =>
  raw.replace(/\s+/g, ' ').trim().slice(0, MAX_DISPLAY_NAME_LENGTH).trim();

export type UserDisplayName = {
  /** Name to show - the configured override, or the OS account name. */
  resolvedName: string;
  /** OS account name (the default). Used as the Settings placeholder. */
  osName: string;
  /** The user's explicit override, or '' when unset. */
  configuredName: string;
  /** Persist a new override. An empty string clears it back to the OS default. */
  save: (name: string) => Promise<void>;
  /** True once both the OS name and the stored override have loaded. */
  loaded: boolean;
};

export function useUserDisplayName(): UserDisplayName {
  const [osName, setOsName] = useState('');
  const [configuredName, setConfiguredName] = useState('');
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const [info, stored] = await Promise.all([
        ipcBridge.application.systemInfo.invoke().catch((): null => null),
        ConfigStorage.get('user.displayName').catch((): undefined => undefined),
      ]);
      if (cancelled) return;
      setOsName(info?.userName ?? '');
      setConfiguredName(stored ?? '');
      setLoaded(true);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const save = useCallback(async (name: string) => {
    const trimmed = sanitizeDisplayName(name);
    await ConfigStorage.set('user.displayName', trimmed);
    setConfiguredName(trimmed);
  }, []);

  return {
    // Sanitized on READ too: a value persisted before the clamp existed (or
    // written by any other path) must not be able to blow up the greeting.
    resolvedName: sanitizeDisplayName(configuredName || osName),
    osName,
    configuredName,
    save,
    loaded,
  };
}
