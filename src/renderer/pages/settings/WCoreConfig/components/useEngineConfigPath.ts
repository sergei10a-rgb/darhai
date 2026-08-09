/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

import { useEffect, useState } from 'react';

import { ipcBridge } from '@/common';

/**
 * The absolute path of the config.toml the ACTIVE engine profile reads.
 *
 * Every pane used to print a hardcoded `~/.wayland-core/config.toml`. That path
 * is wrong on every platform the app ships to - Windows resolves under
 * `%APPDATA%`, macOS under `~/Library/Application Support` - and wrong again for
 * anyone on a named profile, whose config lives under `~/.darhai/profiles/`.
 * Telling a user to open a file that is not there is worse than saying nothing,
 * so ask the main process instead of guessing.
 *
 * Returns `null` until the answer arrives (and if the call fails), so callers
 * render the surrounding sentence without a path rather than a wrong one.
 */
export function useEngineConfigPath(): string | null {
  const [path, setPath] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    ipcBridge.wcoreConfig.getConfigPath
      .invoke()
      .then((value) => {
        if (alive && typeof value === 'string' && value.length > 0) setPath(value);
      })
      .catch(() => {
        // Leave it null - the label degrades to its path-free form.
      });
    return () => {
      alive = false;
    };
  }, []);

  return path;
}
