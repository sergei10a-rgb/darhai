/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Handlers registered through `.provider(fn)`, keyed by provider key.
// `ipcBridge.*.provider` is no longer the platform's own mock - it is the
// error-propagation wrapper (src/common/adapter/bridgeError.ts) - so the
// registered handler is captured here at the platform seam instead.
const { registeredProviderHandlers } = vi.hoisted(() => ({
  registeredProviderHandlers: new Map<string, Function>(),
}));

vi.mock('@office-ai/platform', () => ({
  bridge: {
    buildProvider: vi.fn((key: string) => ({
      provider: vi.fn((handler: Function) => {
        registeredProviderHandlers.set(key, handler);
        return vi.fn();
      }),
      invoke: vi.fn(),
    })),
    buildEmitter: vi.fn(() => ({
      emit: vi.fn(),
      on: vi.fn(),
    })),
  },
  storage: {
    buildStorage: () => ({
      getSync: () => undefined,
      setSync: () => {},
      get: () => Promise.resolve(undefined),
      set: () => Promise.resolve(),
    }),
  },
}));

vi.mock('electron', () => ({
  app: {
    getVersion: vi.fn(() => '1.0.0'),
    getPath: vi.fn(() => '/test/path'),
    isPackaged: true,
  },
}));

vi.mock('electron-updater', () => ({
  autoUpdater: {
    logger: null,
    autoDownload: false,
    autoInstallOnAppQuit: true,
    allowPrerelease: false,
    allowDowngrade: false,
    on: vi.fn(),
    removeListener: vi.fn(),
    checkForUpdates: vi.fn(),
    downloadUpdate: vi.fn(),
    quitAndInstall: vi.fn(),
    checkForUpdatesAndNotify: vi.fn(),
  },
}));

vi.mock('electron-log', () => ({
  default: {
    transports: { file: { level: 'info' } },
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
  },
}));

const makeGitHubReleaseResponse = () => [
  {
    tag_name: 'v1.9.22',
    name: 'v1.9.22',
    body: 'release notes',
    html_url: 'https://github.com/sergei10a-rgb/darhai/releases/tag/v1.9.22',
    published_at: '2026-04-29T00:00:00Z',
    prerelease: false,
    draft: false,
    assets: [
      {
        name: 'Wayland-1.9.22-mac-arm64.dmg',
        browser_download_url:
          'https://github.com/sergei10a-rgb/darhai/releases/download/v1.9.22/Wayland-1.9.22-mac-arm64.dmg',
        size: 123,
        content_type: 'application/x-apple-diskimage',
      },
      {
        name: 'Wayland-1.9.22-win-x64.exe',
        browser_download_url:
          'https://github.com/sergei10a-rgb/darhai/releases/download/v1.9.22/Wayland-1.9.22-win-x64.exe',
        size: 456,
        content_type: 'application/vnd.microsoft.portable-executable',
      },
      {
        name: 'Wayland-1.9.22-linux-amd64.deb',
        browser_download_url:
          'https://github.com/sergei10a-rgb/darhai/releases/download/v1.9.22/Wayland-1.9.22-linux-amd64.deb',
        size: 789,
      },
    ],
  },
];

/** Handler signatures, taken straight from the bridge declaration (type-only). */
type UpdateBridge = (typeof import('@/common'))['ipcBridge']['update'];
type CheckHandler = Parameters<UpdateBridge['check']['provider']>[0];
type DownloadHandler = Parameters<UpdateBridge['download']['provider']>[0];

const getCheckHandler = async (): Promise<CheckHandler> => {
  vi.resetModules();
  const { initUpdateBridge } = await import('@process/bridge/desktop/updateBridge');
  await import('@/common');

  initUpdateBridge();

  const handler = registeredProviderHandlers.get('update.check');
  if (!handler) throw new Error('update.check handler not registered');
  return handler as CheckHandler;
};

const getDownloadHandler = (): DownloadHandler => {
  const handler = registeredProviderHandlers.get('update.download');
  if (!handler) throw new Error('update.download handler not registered');
  return handler as DownloadHandler;
};

describe('updateBridge GitHub asset URLs', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('uses the GitHub release download URL directly for asset.url (no CDN rewrite)', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => makeGitHubReleaseResponse(),
    });
    vi.stubGlobal('fetch', fetchMock);

    try {
      const handler = await getCheckHandler();
      const result = await handler({ repo: 'sergei10a-rgb/darhai' });

      expect(result.success).toBe(true);
      const assets = result.data?.latest?.assets ?? [];
      expect(assets.length).toBe(3);

      const macGithubUrl =
        'https://github.com/sergei10a-rgb/darhai/releases/download/v1.9.22/Wayland-1.9.22-mac-arm64.dmg';
      const macAsset = assets.find((a: { name: string }) => a.name === 'Wayland-1.9.22-mac-arm64.dmg');
      expect(macAsset).toBeDefined();
      expect(macAsset?.url).toBe(macGithubUrl);
      expect(macAsset?.fallbackUrl).toBe(macGithubUrl);

      const linuxAsset = assets.find((a: { name: string }) => a.name === 'Wayland-1.9.22-linux-amd64.deb');
      expect(linuxAsset?.url).toBe(
        'https://github.com/sergei10a-rgb/darhai/releases/download/v1.9.22/Wayland-1.9.22-linux-amd64.deb'
      );
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe('updateBridge download allowlist', () => {
  it('accepts github.com release URLs for download', async () => {
    vi.resetModules();
    vi.clearAllMocks();

    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      headers: new Headers({ 'content-length': '0' }),
      body: {
        getReader: () => ({
          read: async () => ({ done: true, value: undefined }),
        }),
      },
    });
    vi.stubGlobal('fetch', fetchMock);

    try {
      const { initUpdateBridge } = await import('@process/bridge/desktop/updateBridge');
      await import('@/common');

      initUpdateBridge();

      const handler = getDownloadHandler();

      // UPD-02: the secure download path requires `tagName` so the downloaded
      // bytes can be sha512-verified against the signed GitHub release metadata
      // before the file is openable. Without it the handler fails closed.
      const result = await handler({
        url: 'https://github.com/sergei10a-rgb/darhai/releases/download/v1.9.22/Wayland-1.9.22-mac-arm64.dmg',
        fileName: 'Wayland-1.9.22-mac-arm64.dmg',
        tagName: 'v1.9.22',
        repo: 'sergei10a-rgb/darhai',
      });

      expect(result.success).toBe(true);
      expect(result.data?.downloadId).toBeTruthy();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('rejects non-allowlisted hosts', async () => {
    vi.resetModules();
    vi.clearAllMocks();

    const { initUpdateBridge } = await import('@process/bridge/desktop/updateBridge');
    await import('@/common');

    initUpdateBridge();

    const handler = getDownloadHandler();

    const result = await handler({
      url: 'https://evil.example.com/fake.dmg',
      fileName: 'fake.dmg',
    });

    // Download is refused before any network I/O; exact error text comes from i18n and isn't asserted here.
    expect(result.success).toBe(false);
  });
});
