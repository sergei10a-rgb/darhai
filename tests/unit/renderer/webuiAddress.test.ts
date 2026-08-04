/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * The WebUI settings panel showed an address nobody could reach.
 *
 * `startWebServer` walks 25808..25818 when the default port is taken - a second
 * Darhai instance is enough - and reports the port it actually bound. The panel
 * held a single `WEBUI_DEFAULT_PORT` constant and used it for two different
 * jobs: the port to REQUEST, and the port to PRINT. Once the server moved, the
 * panel kept printing 25808, and the copy button handed the user a dead URL.
 *
 * These tests pin the rule that fixes it: a running server's own report wins.
 */

import { describe, expect, it } from 'vitest';
import {
  resolveActivePort,
  resolveWebuiDisplayUrl,
} from '@/renderer/components/settings/SettingsModal/contents/webuiAddress';

const DEFAULT_PORT = 25808;

describe('resolveActivePort', () => {
  it('uses the port the server reports, not the one we asked for', () => {
    expect(resolveActivePort({ running: true, port: 25811 }, DEFAULT_PORT)).toBe(25811);
  });

  it('falls back to the default only before the server has answered', () => {
    expect(resolveActivePort(null, DEFAULT_PORT)).toBe(DEFAULT_PORT);
    expect(resolveActivePort({}, DEFAULT_PORT)).toBe(DEFAULT_PORT);
  });
});

describe('resolveWebuiDisplayUrl', () => {
  it('shows the URL the running server reported', () => {
    const url = resolveWebuiDisplayUrl(
      { running: true, port: 25811, allowRemote: false, localUrl: 'http://localhost:25811' },
      { defaultPort: DEFAULT_PORT }
    );
    expect(url).toBe('http://localhost:25811');
  });

  it('never shows the default port when the server bound a different one', () => {
    // The regression itself: the server is on 25811, and every string the user
    // can read or copy must say so.
    const url = resolveWebuiDisplayUrl(
      { running: true, port: 25811, allowRemote: false },
      { defaultPort: DEFAULT_PORT }
    );
    expect(url).not.toContain(String(DEFAULT_PORT));
    expect(url).toBe('http://localhost:25811');
  });

  it('shows the reported network URL when remote access is on', () => {
    const url = resolveWebuiDisplayUrl(
      {
        running: true,
        port: 25811,
        allowRemote: true,
        localUrl: 'http://localhost:25811',
        networkUrl: 'http://192.168.1.5:25811',
      },
      { defaultPort: DEFAULT_PORT, lanIP: '192.168.1.5' }
    );
    expect(url).toBe('http://192.168.1.5:25811');
  });

  it('composes a LAN URL on the reported port when the server sent no networkUrl', () => {
    const url = resolveWebuiDisplayUrl(
      { running: true, port: 25811, allowRemote: true },
      { defaultPort: DEFAULT_PORT, lanIP: '192.168.1.5' }
    );
    expect(url).toBe('http://192.168.1.5:25811');
  });

  it('reads the running server, not the toggle, for which URL to show', () => {
    // The user has flipped the remote switch but not restarted: the server is
    // still local-only, so the local address is what actually works.
    const url = resolveWebuiDisplayUrl(
      { running: true, port: 25808, allowRemote: false, localUrl: 'http://localhost:25808' },
      { defaultPort: DEFAULT_PORT, lanIP: '192.168.1.5', preferRemote: true }
    );
    expect(url).toBe('http://localhost:25808');
  });

  it('previews an address before the server is running', () => {
    expect(resolveWebuiDisplayUrl(null, { defaultPort: DEFAULT_PORT })).toBe('http://localhost:25808');
    expect(resolveWebuiDisplayUrl(null, { defaultPort: DEFAULT_PORT, lanIP: '192.168.1.5', preferRemote: true })).toBe(
      'http://192.168.1.5:25808'
    );
  });

  it('ignores a stale reported URL once the server has stopped', () => {
    // Status lingers after a stop; the preview must come from the preference
    // again, not from the address the dead server used to serve.
    const url = resolveWebuiDisplayUrl(
      { running: false, port: 25811, allowRemote: true, networkUrl: 'http://192.168.1.5:25811' },
      { defaultPort: DEFAULT_PORT, lanIP: '192.168.1.5', preferRemote: false }
    );
    expect(url).toBe('http://localhost:25811');
  });
});
