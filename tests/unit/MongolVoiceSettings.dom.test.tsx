/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

// DOM tests for the Mongolian-voice settings surfaces:
//   - TTS provider options: 'kitten-mn' offered, 'kokoro-local' GONE (it never
//     worked), 'system-native' gated to macOS
//   - kitten-mn voice picker shows the "install first" hint while the bundle
//     offers no voices
//   - STT provider options: 'nemotron-mn' offered, 'whisper-local' GONE (404
//     dependencies), openai/deepgram unchanged
//   - nemotron-mn shows the install pointer while its components are missing
//   - the install card states the TOTAL download size BEFORE installing, and
//     collapses to "all installed" when everything is on disk

import { describe, it, expect, vi, beforeEach } from 'vitest';
import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { MongolVoiceComponentStatus, MongolVoiceStatusView } from '@/common/types/mongolVoice';
import type { SpeechToTextConfig } from '@/common/types/speech';
import type { TextToSpeechConfig } from '@/common/types/ttsTypes';

const mockIsMacOS = vi.fn(() => false);

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

// === Mocking Dependencies === //

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    // Render interpolation values so size assertions can see the numbers.
    t: (key: string, opts?: Record<string, unknown>) =>
      opts && typeof opts === 'object' && 'size' in opts ? `${key}[${String(opts.size)}]` : key,
    i18n: { language: 'en-US' },
  }),
  initReactI18next: { type: '3rdParty', init: () => {} },
}));

// Options rendered flat (no popup) so presence/absence is assertable directly.
vi.mock('@/renderer/components/base/DarhaiSelect', () => {
  // oxlint-disable-next-line unicorn/consistent-function-scoping -- vi.mock factories are hoisted; the component cannot live outside
  const Select = ({ children }: { children?: React.ReactNode }) => <div data-testid='darhai-select'>{children}</div>;
  (Select as unknown as Record<string, unknown>).Option = ({
    children,
    value,
  }: {
    children?: React.ReactNode;
    value?: unknown;
  }) => <div data-testid={`option-${String(value)}`}>{children}</div>;
  (Select as unknown as Record<string, unknown>).OptGroup = ({ children }: { children?: React.ReactNode }) => (
    <div>{children}</div>
  );
  return { default: Select };
});

vi.mock('@/renderer/components/base/DarhaiScrollArea', () => ({
  default: ({ children }: { children?: React.ReactNode }) => <div data-testid='scroll-area'>{children}</div>,
}));

vi.mock('@/renderer/components/settings/SettingsModal/settingsViewContext', () => ({
  useSettingsViewMode: () => 'modal',
}));

vi.mock('@/renderer/pages/settings/VoiceSettings/MicrophoneCheck', () => ({
  default: () => <div data-testid='microphone-check' />,
}));

vi.mock('@/renderer/pages/settings/ToolsSettings/McpAgentStatusDisplay', () => ({
  default: () => <div data-testid='mcp-agent-status' />,
}));

vi.mock('@/renderer/hooks/agent/useConfigModelListWithImage', () => ({
  default: () => ({ modelListWithImage: [] as never[] }),
}));

vi.mock('@/renderer/hooks/mcp', () => ({
  useMcpServers: () => ({ mcpServers: [] as never[], saveMcpServers: vi.fn() }),
  useMcpAgentStatus: () => ({
    agentInstallStatus: {},
    setAgentInstallStatus: vi.fn(),
    isServerLoading: () => false,
    checkSingleServerInstallStatus: vi.fn(),
  }),
  useMcpOperations: () => ({ syncMcpToAgents: vi.fn(), removeMcpFromAgents: vi.fn() }),
}));

vi.mock('react-router-dom', () => ({
  useNavigate: () => vi.fn(),
}));

vi.mock('@/common/config/storage', () => ({
  BUILTIN_IMAGE_GEN_ID: 'builtin-image-gen',
  ConfigStorage: {
    get: vi.fn().mockResolvedValue(undefined),
    set: vi.fn().mockResolvedValue(undefined),
    remove: vi.fn().mockResolvedValue(undefined),
  },
}));

vi.mock('@/renderer/utils/platform', () => ({
  isMacOS: () => mockIsMacOS(),
  isElectronDesktop: () => true,
}));

// IPC bridge: the mongolVoice namespace the sections + card talk to, plus the
// voiceSynth surface the "Test voice" button routes through.
const mockStatusInvoke = vi.fn();
const mockInstallInvoke = vi.fn();
const mockCancelInvoke = vi.fn();
const mockTtsVoicesInvoke = vi.fn();
const mockOnProgressOn = vi.fn(() => vi.fn());
const mockVoiceSynthSpeak = vi.fn();

vi.mock('@/common/adapter/ipcBridge', () => ({
  mongolVoice: {
    status: { invoke: (...args: unknown[]) => mockStatusInvoke(...args) },
    install: { invoke: (...args: unknown[]) => mockInstallInvoke(...args) },
    cancel: { invoke: (...args: unknown[]) => mockCancelInvoke(...args) },
    ttsVoices: { invoke: (...args: unknown[]) => mockTtsVoicesInvoke(...args) },
    onProgress: { on: (..._args: unknown[]) => mockOnProgressOn() },
  },
  voiceSynth: {
    speak: { invoke: (...args: unknown[]) => mockVoiceSynthSpeak(...args) },
    stop: { invoke: vi.fn() },
  },
}));

// jsdom has no working Audio.play / URL.createObjectURL - stub the playback
// substrate so the speak path can complete after the IPC invoke resolves.
class FakeAudio {
  addEventListener(): void {}
  removeEventListener(): void {}
  pause(): void {}
  play(): Promise<void> {
    return Promise.resolve();
  }
}
vi.stubGlobal('Audio', FakeAudio);
// Augment (not replace) jsdom's URL: other code still constructs `new URL(...)`.
(URL as unknown as { createObjectURL: () => string }).createObjectURL = vi.fn(() => 'blob:fake');
(URL as unknown as { revokeObjectURL: () => void }).revokeObjectURL = vi.fn();

import {
  DEFAULT_SPEECH_TO_TEXT_CONFIG,
  SpeechToTextSettingsSection,
  TextToSpeechSettingsSection,
  normalizeSpeechToTextConfig,
} from '@/renderer/components/settings/SettingsModal/contents/ToolsModalContent';
import { normalizeRendererTextToSpeechConfig } from '@/renderer/services/voice/ttsConfig';
import MongolVoiceInstallCard from '@/renderer/pages/settings/VoiceSettings/MongolVoiceInstallCard';

const TTS_CONFIG: TextToSpeechConfig = {
  enabled: true,
  provider: 'kitten-mn',
  voice: 'default',
  speed: 1.0,
  autoReadResponses: false,
};

const STT_CONFIG: SpeechToTextConfig = {
  enabled: true,
  provider: 'nemotron-mn',
};

function component(overrides: Partial<MongolVoiceComponentStatus> = {}): MongolVoiceComponentStatus {
  return { supported: true, pinned: true, installed: false, tag: 'tag', bytes: 0, ...overrides };
}

/** The real pinned sizes, so the total-download assertion checks real math. */
function statusView(installed: boolean): MongolVoiceStatusView {
  return {
    components: {
      sttRuntime: component({ installed, bytes: 24_231_095 }),
      sttModel: component({ installed, bytes: 931_233_056 }),
      ttsBundle: component({ installed, bytes: 726_089_788 }),
    },
    sttReady: installed,
    ttsReady: installed,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockIsMacOS.mockReturnValue(false);
  mockStatusInvoke.mockResolvedValue(statusView(false));
  mockTtsVoicesInvoke.mockResolvedValue({ voices: [] });
  mockInstallInvoke.mockResolvedValue({ ok: true, errorCode: null, errorMessage: null });
  mockCancelInvoke.mockResolvedValue({ cancelled: false });
  mockOnProgressOn.mockReturnValue(vi.fn());
  mockVoiceSynthSpeak.mockResolvedValue({ data: [82, 73, 70, 70], mimeType: 'audio/wav' });
});

describe('TextToSpeechSettingsSection provider options', () => {
  it('offers kitten-mn and NEVER the retired kokoro-local', async () => {
    render(<TextToSpeechSettingsSection config={TTS_CONFIG} onChange={() => {}} />);
    expect(screen.getByTestId('option-kitten-mn')).toBeInTheDocument();
    expect(screen.queryByTestId('option-kokoro-local')).not.toBeInTheDocument();
  });

  it('hides system-native off macOS (it returns silent empty audio there)', () => {
    mockIsMacOS.mockReturnValue(false);
    render(<TextToSpeechSettingsSection config={TTS_CONFIG} onChange={() => {}} />);
    expect(screen.queryByTestId('option-system-native')).not.toBeInTheDocument();
  });

  it('offers system-native on macOS', () => {
    mockIsMacOS.mockReturnValue(true);
    render(<TextToSpeechSettingsSection config={TTS_CONFIG} onChange={() => {}} />);
    expect(screen.getByTestId('option-system-native')).toBeInTheDocument();
  });

  it('shows the install-first hint while the kitten bundle offers no voices', async () => {
    mockTtsVoicesInvoke.mockResolvedValue({ voices: [] });
    render(<TextToSpeechSettingsSection config={TTS_CONFIG} onChange={() => {}} />);
    await waitFor(() => {
      expect(screen.getByText('settings.textToSpeechVoiceInstallFirst')).toBeInTheDocument();
    });
  });

  it('lists the bundle voices (and no hint) once they exist', async () => {
    mockTtsVoicesInvoke.mockResolvedValue({ voices: [{ name: 'garav.wav', label: 'Гарав' }] });
    render(<TextToSpeechSettingsSection config={TTS_CONFIG} onChange={() => {}} />);
    await waitFor(() => {
      // The option VALUE is the wire name (what /api/speak accepts) while the
      // visible text is the human label - both halves of the contract matter.
      expect(screen.getByTestId('option-garav.wav')).toBeInTheDocument();
    });
    expect(screen.getByText('Гарав')).toBeInTheDocument();
    expect(screen.queryByText('settings.textToSpeechVoiceInstallFirst')).not.toBeInTheDocument();
  });

  it('shows the after-first-speak hint when the bundle IS installed but its server is idle', async () => {
    // Installed bundle + empty voice list = the server simply has not been
    // started yet (listing voices never starts it, by design).
    mockStatusInvoke.mockResolvedValue(statusView(true));
    mockTtsVoicesInvoke.mockResolvedValue({ voices: [] });
    render(<TextToSpeechSettingsSection config={TTS_CONFIG} onChange={() => {}} />);
    await waitFor(() => {
      expect(screen.getByText('settings.textToSpeechVoiceListAfterFirstSpeak')).toBeInTheDocument();
    });
    expect(screen.queryByText('settings.textToSpeechVoiceInstallFirst')).not.toBeInTheDocument();
  });
});

describe('TextToSpeechSettingsSection test voice button', () => {
  it('kitten-mn: routes the Mongolian test phrase through voiceSynth.speak (the real engine)', async () => {
    render(<TextToSpeechSettingsSection config={TTS_CONFIG} onChange={() => {}} />);
    fireEvent.click(screen.getByText('settings.textToSpeechTestVoice'));
    await waitFor(() => {
      expect(mockVoiceSynthSpeak).toHaveBeenCalledTimes(1);
    });
    // The i18n mock returns the key itself - what matters is that the phrase
    // is the dedicated kitten-mn (always-Mongolian) test phrase key.
    expect(mockVoiceSynthSpeak).toHaveBeenCalledWith({ text: 'settings.textToSpeechTestPhraseKittenMn' });
  });

  it('system-native (macOS) keeps the browser speechSynthesis sanity check', () => {
    mockIsMacOS.mockReturnValue(true);
    const speakSpy = vi.fn();
    const cancelSpy = vi.fn();
    vi.stubGlobal('speechSynthesis', { speak: speakSpy, cancel: cancelSpy });
    vi.stubGlobal(
      'SpeechSynthesisUtterance',
      class {
        rate = 1;
        constructor(public text: string) {}
      }
    );
    render(<TextToSpeechSettingsSection config={{ ...TTS_CONFIG, provider: 'system-native' }} onChange={() => {}} />);
    fireEvent.click(screen.getByText('settings.textToSpeechTestVoice'));
    expect(cancelSpy).toHaveBeenCalledTimes(1);
    expect(speakSpy).toHaveBeenCalledTimes(1);
    expect(mockVoiceSynthSpeak).not.toHaveBeenCalled();
  });
});

describe('speech-to-text config normalization', () => {
  it('defaults to the local nemotron-mn provider with STT disabled', () => {
    expect(DEFAULT_SPEECH_TO_TEXT_CONFIG.provider).toBe('nemotron-mn');
    expect(DEFAULT_SPEECH_TO_TEXT_CONFIG.enabled).toBe(false);
    expect(normalizeSpeechToTextConfig().provider).toBe('nemotron-mn');
  });

  it('migrates a stored whisper-local selection to nemotron-mn (whisper-local never ran - 404 binaries)', () => {
    const config = normalizeSpeechToTextConfig({ enabled: true, provider: 'whisper-local' });
    expect(config.provider).toBe('nemotron-mn');
    expect(config.enabled).toBe(true);
  });

  it('preserves stored hosted providers untouched', () => {
    expect(normalizeSpeechToTextConfig({ enabled: true, provider: 'openai' }).provider).toBe('openai');
    expect(normalizeSpeechToTextConfig({ enabled: true, provider: 'deepgram' }).provider).toBe('deepgram');
  });
});

describe('renderer TTS config normalization', () => {
  it('migrates system-native to kitten-mn off macOS (it can only emit silence there)', () => {
    mockIsMacOS.mockReturnValue(false);
    const config = normalizeRendererTextToSpeechConfig({ enabled: true, provider: 'system-native' });
    expect(config.provider).toBe('kitten-mn');
    expect(config.enabled).toBe(true);
  });

  it('keeps system-native on macOS', () => {
    mockIsMacOS.mockReturnValue(true);
    expect(normalizeRendererTextToSpeechConfig({ provider: 'system-native' }).provider).toBe('system-native');
  });

  it('still upgrades the retired kokoro-local via the shared normalize', () => {
    mockIsMacOS.mockReturnValue(true);
    expect(normalizeRendererTextToSpeechConfig({ provider: 'kokoro-local' }).provider).toBe('kitten-mn');
  });
});

describe('SpeechToTextSettingsSection provider options', () => {
  it('offers nemotron-mn alongside openai and deepgram, and NEVER whisper-local', () => {
    render(<SpeechToTextSettingsSection config={STT_CONFIG} onChange={() => {}} />);
    expect(screen.getByTestId('option-nemotron-mn')).toBeInTheDocument();
    expect(screen.getByTestId('option-openai')).toBeInTheDocument();
    expect(screen.getByTestId('option-deepgram')).toBeInTheDocument();
    expect(screen.queryByTestId('option-whisper-local')).not.toBeInTheDocument();
  });

  it('points at the install card while nemotron-mn components are missing', async () => {
    mockStatusInvoke.mockResolvedValue(statusView(false));
    render(<SpeechToTextSettingsSection config={STT_CONFIG} onChange={() => {}} />);
    await waitFor(() => {
      expect(screen.getByText('settings.speechToTextNemotronInstallHint')).toBeInTheDocument();
    });
  });

  it('drops the hint once STT is ready', async () => {
    mockStatusInvoke.mockResolvedValue(statusView(true));
    render(<SpeechToTextSettingsSection config={STT_CONFIG} onChange={() => {}} />);
    // The description renders synchronously; the hint must NOT appear after
    // the async status resolves.
    expect(screen.getByText('settings.speechToTextNemotronDescription')).toBeInTheDocument();
    await waitFor(() => {
      expect(mockStatusInvoke).toHaveBeenCalled();
    });
    expect(screen.queryByText('settings.speechToTextNemotronInstallHint')).not.toBeInTheDocument();
  });
});

describe('MongolVoiceInstallCard', () => {
  it('shows the install button WITH the total download size when nothing is installed', async () => {
    mockStatusInvoke.mockResolvedValue(statusView(false));
    render(<MongolVoiceInstallCard />);
    await waitFor(() => {
      expect(screen.getByText('settings.mongolVoice.installAll')).toBeInTheDocument();
    });
    // 24,231,095 + 931,233,056 + 726,089,788 bytes = 1,681,553,939 -> 1682 MB
    // (the SUM is rounded once, not each addend - the honest total).
    expect(
      screen.getByText(/settings\.mongolVoice\.totalDownload\[settings\.mongolVoice\.sizeMb\[1682\]\]/)
    ).toBeInTheDocument();
    // All three component rows are present, not-installed.
    expect(screen.getByText('settings.mongolVoice.componentSttRuntime')).toBeInTheDocument();
    expect(screen.getByText('settings.mongolVoice.componentSttModel')).toBeInTheDocument();
    expect(screen.getByText('settings.mongolVoice.componentTtsBundle')).toBeInTheDocument();
    expect(screen.getAllByText('settings.mongolVoice.stateNotInstalled')).toHaveLength(3);
  });

  it('collapses to "all installed" with no install button when everything is on disk', async () => {
    mockStatusInvoke.mockResolvedValue(statusView(true));
    render(<MongolVoiceInstallCard />);
    await waitFor(() => {
      expect(screen.getByText('settings.mongolVoice.installed')).toBeInTheDocument();
    });
    expect(screen.queryByText('settings.mongolVoice.installAll')).not.toBeInTheDocument();
    expect(screen.getAllByText('settings.mongolVoice.stateInstalled')).toHaveLength(3);
  });
});
