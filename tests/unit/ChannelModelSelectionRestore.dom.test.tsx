import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React from 'react';
import { render, act, cleanup } from '@testing-library/react';

// Mock window.matchMedia for Arco Design responsive observer
Object.defineProperty(window, 'matchMedia', {
  writable: true,
  value: vi.fn().mockImplementation((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
  })),
});

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
    i18n: { language: 'en-US' },
  }),
  initReactI18next: { type: '3rdParty', init: () => {} },
}));

vi.mock('@arco-design/web-react', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@arco-design/web-react')>();
  return {
    ...actual,
    Message: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() },
  };
});

vi.mock('@icon-park/react', () => ({
  CheckOne: () => <span data-testid='check-icon' />,
}));

// Track ConfigStorage.get call count to verify retry behavior
const mockConfigStorageGet = vi.fn();
const mockConfigStorageSet = vi.fn();

vi.mock('@/common/config/storage', () => ({
  ConfigStorage: {
    get: (...args: unknown[]) => mockConfigStorageGet(...args),
    set: (...args: unknown[]) => mockConfigStorageSet(...args),
  },
}));

// Control the providers returned by the hook
let mockProviders: Array<{ id: string; name: string; model: string[]; platform?: string }> = [];

vi.mock('@/renderer/hooks/agent/useModelProviderList', () => ({
  useModelProviderList: () => ({
    providers: mockProviders,
    geminiModeLookup: new Map(),
    getAvailableModels: () => [],
    formatModelLabel: (_p: unknown, m?: string) => m || '',
  }),
}));

vi.mock('@/renderer/pages/conversation/platforms/gemini/useGeminiModelSelection', () => ({
  useGeminiModelSelection: ({ initialModel }: { initialModel: unknown }) => ({
    currentModel: initialModel,
    providers: mockProviders,
    geminiModeLookup: new Map(),
    formatModelLabel: () => '',
    getDisplayModelName: () => '',
    getAvailableModels: () => [],
    handleSelectModel: vi.fn(),
  }),
}));

vi.mock('@/common/adapter/ipcBridge', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/common/adapter/ipcBridge')>();
  return {
    ...actual,
    channel: {
      getPluginStatus: { invoke: vi.fn().mockResolvedValue({ success: true, data: [] }) },
      pluginStatusChanged: { on: vi.fn().mockReturnValue(() => {}) },
    },
    webui: {
      getStatus: { invoke: vi.fn().mockResolvedValue({ success: false }) },
    },
  };
});

vi.mock('@/renderer/components/base/DarhaiScrollArea', () => ({
  default: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

vi.mock('../../src/renderer/components/settings/SettingsModal/settingsViewContext', () => ({
  useSettingsViewMode: () => 'modal',
}));

vi.mock('../../src/renderer/components/settings/SettingsModal/contents/channels/ChannelItem', () => ({
  default: ({ channel }: { channel: { id: string; title: string } }) => (
    <div data-testid={`channel-${channel.id}`}>{channel.title}</div>
  ),
}));

vi.mock('../../src/renderer/components/settings/SettingsModal/contents/channels/TelegramConfigForm', () => ({
  default: () => <div>TelegramForm</div>,
}));
vi.mock('../../src/renderer/components/settings/SettingsModal/contents/channels/LarkConfigForm', () => ({
  default: () => <div>LarkForm</div>,
}));
vi.mock('../../src/renderer/components/settings/SettingsModal/contents/channels/DingTalkConfigForm', () => ({
  default: () => <div>DingTalkForm</div>,
}));
vi.mock('../../src/renderer/components/settings/SettingsModal/contents/channels/WeixinConfigForm', () => ({
  default: () => <div>WeixinForm</div>,
}));
vi.mock('../../src/renderer/components/settings/SettingsModal/contents/channels/WecomConfigForm', () => ({
  default: () => <div>WecomForm</div>,
}));

describe('useChannelModelSelection restore retry limit', () => {
  // ConfigStorage.get is also read once at module init by unrelated hooks
  // (useTheme -> 'theme', useColorScheme -> 'colorScheme'). Those fire in
  // whichever test loads the modules first, so count only the channel model
  // restore reads to keep the retry-cap assertions precise and order-independent.
  const restoreGetCount = () =>
    mockConfigStorageGet.mock.calls.filter(
      ([key]) => typeof key === 'string' && (key as string).endsWith('.defaultModel')
    ).length;

  beforeEach(() => {
    // Guard against a prior test file leaving fake timers active in the shared
    // worker: async act() and the React scheduler rely on real setTimeout, and
    // frozen timers would hang every act() call in this file.
    vi.useRealTimers();
    vi.clearAllMocks();
    mockProviders = [];
  });

  // Unmount the previous test's component so its retry effects can't leak calls
  // into the next test. vi.clearAllMocks resets call counts, not the mounted DOM.
  //
  // Unmounting is not on its own enough: `restore()` is async, so a chain that
  // was already in flight when the component went away still resolves and still
  // calls ConfigStorage.get - just *after* the next test's `vi.clearAllMocks()`
  // has zeroed the counter. That is how "should restore successfully" came to
  // observe 10 reads instead of 5 once the preceding test ran long enough to be
  // cut short. Draining the macrotask queue here forces those stragglers to
  // land while they still belong to this test.
  afterEach(async () => {
    cleanup();
    for (let i = 0; i < 10; i++) {
      // eslint-disable-next-line no-await-in-loop
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  });

  it(
    'should stop retrying ConfigStorage.get after MAX_RESTORE_RETRIES when provider is stale',
    { timeout: 60_000 },
    async () => {
      // Simulate a stale saved model referencing a provider that no longer exists
      mockConfigStorageGet.mockResolvedValue({ id: 'deleted-provider', useModel: 'some-model' });

      // Providers are loaded but don't include the saved provider
      mockProviders = [{ id: 'provider-1', name: 'Provider One', model: ['model-a', 'model-b'] }];

      const { default: ChannelModalContent } =
        await import('@/renderer/components/settings/SettingsModal/contents/channels/ChannelModalContent');

      // Render with the SYNCHRONOUS act form. The async `await act(async ...)`
      // form parks on the React scheduler's macrotask queue, which can starve for
      // longer than the test timeout when the full suite saturates the workers -
      // that is exactly how this test used to hang. The sync form flushes effects
      // on exit, and vi.waitFor below absorbs the async restore() continuations
      // without depending on scheduler latency.
      let rerender: (ui: React.ReactElement) => void = () => {};
      act(() => {
        ({ rerender } = render(<ChannelModalContent />));
      });

      // The hook runs for 5 channels (telegram, lark, dingtalk, weixin, wecom).
      // Initial render triggers the first attempt for each channel.
      // The saved provider 'deleted-provider' won't be found in mockProviders.
      await vi.waitFor(() => expect(restoreGetCount()).toBeGreaterThan(0), { timeout: 30_000 });

      // Simulate repeated SWR revalidations. Each revalidation yields a fresh
      // `providers` array reference, which is a dependency of the restore effect,
      // so the effect genuinely re-runs on every re-render. A stale saved provider
      // is never found, so without the retry cap this would call ConfigStorage.get
      // on every one of these re-renders (5 channels x 10 = 50+ extra calls).
      //
      // Drive the re-render with a synchronous act() and flush the resulting
      // restore() microtask with `await Promise.resolve()`. Using the async
      // act(async () => ...) form here relies on the React scheduler's macrotask
      // queue, which does not settle within the test timeout under full-suite
      // worker load - that is what hung this test.
      for (let i = 0; i < 10; i++) {
        // A new providers array reference is what a real SWR revalidation produces.
        mockProviders = [{ id: 'provider-1', name: 'Provider One', model: ['model-a', 'model-b'] }];
        act(() => {
          rerender(<ChannelModalContent />);
        });
        // eslint-disable-next-line no-await-in-loop
        await Promise.resolve();
      }

      // After MAX_RESTORE_RETRIES (5), the effect should stop calling ConfigStorage.get.
      // With 5 channels × at most 5 retries each = at most 25 calls.
      // Without the cap, this would be 5 × 10+ = 50+ calls.
      const totalCalls = restoreGetCount();
      expect(totalCalls).toBeLessThanOrEqual(5 * 5);
    }
  );

  it('should restore successfully when provider exists', { timeout: 60_000 }, async () => {
    mockConfigStorageGet.mockResolvedValue({ id: 'provider-1', useModel: 'model-a' });

    mockProviders = [{ id: 'provider-1', name: 'Provider One', model: ['model-a', 'model-b'] }];

    const { default: ChannelModalContent } =
      await import('@/renderer/components/settings/SettingsModal/contents/channels/ChannelModalContent');

    // Sync act + waitFor: see the comment in the stale-provider test above for
    // why the async act form is off-limits here.
    let rerender: (ui: React.ReactElement) => void = () => {};
    act(() => {
      ({ rerender } = render(<ChannelModalContent />));
    });

    // Each of the 5 channels should call ConfigStorage.get exactly once
    // (restored=true after finding the provider, so no retries)
    await vi.waitFor(() => expect(restoreGetCount()).toBe(5), { timeout: 30_000 });

    // Idempotence: a fresh providers array reference (what a real SWR
    // revalidation produces) must NOT trigger another read once every channel
    // has settled.
    mockProviders = [{ id: 'provider-1', name: 'Provider One', model: ['model-a', 'model-b'] }];
    act(() => {
      rerender(<ChannelModalContent />);
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(restoreGetCount()).toBe(5);
  });
});
