/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

import { ChevronDown, HelpCircle, Plus } from 'lucide-react';
import {
  ConfigStorage,
  type IConfigStorageRefer,
  type IMcpServer,
  BUILTIN_IMAGE_GEN_ID,
} from '@/common/config/storage';
import type { KittenVoiceOption } from '@/common/types/mongolVoice';
import type { SpeechToTextConfig, SpeechToTextProvider } from '@/common/types/speech';
import type { TextToSpeechConfig, TextToSpeechProvider } from '@/common/types/ttsTypes';
import { DEFAULT_TTS_CONFIG, normalizeTextToSpeechConfig } from '@/common/types/ttsTypes';
import { mongolVoice } from '@/common/adapter/ipcBridge';
import {
  Divider,
  Form,
  Tooltip,
  Message,
  Button,
  Dropdown,
  Menu,
  Modal,
  Switch,
  Input,
  Slider,
} from '@arco-design/web-react';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import useConfigModelListWithImage from '@/renderer/hooks/agent/useConfigModelListWithImage';
import DarhaiScrollArea from '@/renderer/components/base/DarhaiScrollArea';
import DarhaiSelect from '@/renderer/components/base/DarhaiSelect';
import McpAgentStatusDisplay from '@/renderer/pages/settings/ToolsSettings/McpAgentStatusDisplay';
import { useMcpServers, useMcpAgentStatus, useMcpOperations } from '@/renderer/hooks/mcp';
import classNames from 'classnames';
import { useNavigate } from 'react-router-dom';
import { useSettingsViewMode } from '../settingsViewContext';
import MicrophoneCheck from '@/renderer/pages/settings/VoiceSettings/MicrophoneCheck';
import MongolVoiceInstallCard, {
  NemotronInstallHint,
} from '@/renderer/pages/settings/VoiceSettings/MongolVoiceInstallCard';
import { useMongolVoice } from '@/renderer/pages/settings/VoiceSettings/useMongolVoice';
import { TTS_CONFIG_CHANGED_EVENT } from '@/renderer/services/voice/ttsConfig';
import { speakText, ttsErrorMessageKey } from '@/renderer/services/voice/ttsPlayback';
import { isMacOS } from '@/renderer/utils/platform';

// Re-exported so existing importers (VoiceSettings page) keep working; the
// constant itself now lives beside the renderer TTS config reader it gates.
export { TTS_CONFIG_CHANGED_EVENT };

type MessageInstance = ReturnType<typeof Message.useMessage>[0];

const isBuiltinImageGenServer = (server: IMcpServer) => server.builtin === true && server.id === BUILTIN_IMAGE_GEN_ID;
export const SPEECH_TO_TEXT_CONFIG_CHANGED_EVENT = 'wayland:speech-to-text-config-changed';
export const DEFAULT_SPEECH_TO_TEXT_CONFIG: SpeechToTextConfig = {
  enabled: false,
  // The documented local-first default (docs/architecture/mongolian-voice.md):
  // offline, keyless, and the only provider tuned for Mongolian. `enabled` is
  // false by default, so no key prompt and no download happens until the user
  // opts in - hosted providers remain one select away.
  provider: 'nemotron-mn',
  openai: {
    apiKey: '',
    baseUrl: '',
    language: '',
    model: 'whisper-1',
  },
  deepgram: {
    apiKey: '',
    baseUrl: '',
    detectLanguage: true,
    language: '',
    model: 'nova-2',
    punctuate: true,
    smartFormat: true,
  },
};

export const normalizeSpeechToTextConfig = (config?: SpeechToTextConfig): SpeechToTextConfig => {
  const merged: SpeechToTextConfig = {
    ...DEFAULT_SPEECH_TO_TEXT_CONFIG,
    ...config,
    openai: {
      ...DEFAULT_SPEECH_TO_TEXT_CONFIG.openai,
      ...config?.openai,
    },
    deepgram: {
      ...DEFAULT_SPEECH_TO_TEXT_CONFIG.deepgram,
      ...config?.deepgram,
    },
  };
  // 'whisper-local' never transcribed anything - its pinned binary downloads
  // all 404 (docs/architecture/mongolian-voice.md) - so a stored selection of
  // it carries no working intent to preserve. Upgrade it to the local default
  // instead of surfacing a provider the UI no longer offers.
  if (merged.provider === 'whisper-local') {
    merged.provider = 'nemotron-mn';
  }
  return merged;
};

/**
 * Hint under an EMPTY kitten-mn voice picker. Which hint depends on why it is
 * empty: bundle not installed -> point at the install card; bundle installed
 * but its server idle -> explain that the list appears after the first speak
 * (listing voices deliberately never starts the server, see mongolVoiceBridge).
 */
const KittenVoiceListHint: React.FC = () => {
  const { t } = useTranslation();
  const { status } = useMongolVoice();
  if (status === null) return null;
  return (
    <span className='text-12px text-t-tertiary'>
      {status.ttsReady === true
        ? t('settings.textToSpeechVoiceListAfterFirstSpeak')
        : t('settings.textToSpeechVoiceInstallFirst')}
    </span>
  );
};

export const TextToSpeechSettingsSection: React.FC<{
  config: TextToSpeechConfig;
  onChange: (updater: (current: TextToSpeechConfig) => TextToSpeechConfig) => void;
}> = ({ config, onChange }) => {
  const { t } = useTranslation();
  // Voices the installed kitten-mn bundle offers. Null = not fetched yet;
  // [] = fetched and the bundle has nothing to offer (not installed / down),
  // which renders as an "install first" hint rather than an error - an empty
  // picker is the normal not-installed state on this surface.
  const [kittenVoices, setKittenVoices] = useState<KittenVoiceOption[] | null>(null);
  // True from pressing "Test voice" until the audio starts (or fails). The
  // first kitten-mn start can take ~10-30 s (cold server + AV scan), so the
  // button shows a spinner and refuses re-entry instead of looking dead.
  const [isTestingVoice, setIsTestingVoice] = useState(false);

  useEffect(() => {
    if (config.provider !== 'kitten-mn') return;
    let cancelled = false;
    void mongolVoice.ttsVoices
      .invoke()
      .then((r) => {
        if (!cancelled) setKittenVoices(Array.isArray(r?.voices) ? r.voices : []);
      })
      .catch(() => {
        if (!cancelled) setKittenVoices([]);
      });
    return () => {
      cancelled = true;
    };
  }, [config.provider]);

  const handleProviderChange = useCallback(
    (value: string) => {
      onChange((current) => ({ ...current, provider: value as TextToSpeechProvider }));
    },
    [onChange]
  );

  const handleTestVoice = useCallback(() => {
    if (config.provider === 'kitten-mn') {
      // Test with the REAL engine: the phrase goes through voiceSynth.speak,
      // so the user hears the actual kitten-mn output (voice, speed, quality),
      // not the browser's built-in speechSynthesis stand-in.
      if (isTestingVoice) return;
      setIsTestingVoice(true);
      void (async () => {
        try {
          await speakText(
            t('settings.textToSpeechTestPhraseKittenMn', 'Сайн байна уу! Энэ бол монгол дуу хоолойн туршилт.')
          );
        } catch (err) {
          Message.error(t(ttsErrorMessageKey(err)));
        } finally {
          setIsTestingVoice(false);
        }
      })();
      return;
    }
    // system-native (macOS-gated in the picker): keep the browser
    // speechSynthesis sanity check - a "does my output device work" test that
    // needs no local model.
    if (typeof window === 'undefined' || !window.speechSynthesis) return;
    window.speechSynthesis.cancel();
    const utterance = new SpeechSynthesisUtterance(t('settings.textToSpeechTestPhrase', 'Voice check.'));
    if (typeof config.speed === 'number' && config.speed > 0) {
      utterance.rate = config.speed;
    }
    window.speechSynthesis.speak(utterance);
  }, [config.provider, config.speed, isTestingVoice, t]);

  return (
    <div className='px-[12px] md:px-[32px] py-[24px] bg-[var(--color-bg-2)] rd-12px border-2 border-solid border-[var(--color-border-2)]'>
      <div className='flex items-center justify-between gap-12px mb-8px'>
        <div className='flex flex-col gap-4px'>
          <span className='text-14px text-t-primary'>{t('settings.textToSpeech')}</span>
          <span className='text-13px text-t-secondary'>{t('settings.textToSpeechDescription')}</span>
        </div>
        <Switch
          checked={config.enabled}
          onChange={(checked) => {
            onChange((current) => ({ ...current, enabled: checked }));
          }}
        />
      </div>

      <Divider className='mt-0px mb-20px' />

      <Form layout='horizontal' labelAlign='left' className='space-y-12px'>
        <Form.Item label={t('settings.textToSpeechProvider')}>
          <div className='flex items-center gap-8px'>
            <DarhaiSelect value={config.provider} onChange={handleProviderChange} className='flex-1'>
              <DarhaiSelect.Option value='kitten-mn'>{t('settings.textToSpeechProviderKittenMn')}</DarhaiSelect.Option>
              {/* macOS `say` only: on other platforms it returns silent empty
                  audio, so the option is gated instead of shipped broken. */}
              {isMacOS() && (
                <DarhaiSelect.Option value='system-native'>
                  {t('settings.textToSpeechProviderSystemNative')}
                </DarhaiSelect.Option>
              )}
            </DarhaiSelect>
            <Button size='small' onClick={handleTestVoice} loading={isTestingVoice} disabled={isTestingVoice}>
              {t('settings.textToSpeechTestVoice', 'Test voice')}
            </Button>
          </div>
        </Form.Item>

        <Form.Item label={t('settings.textToSpeechVoice')}>
          {config.provider === 'kitten-mn' ? (
            <div className='flex flex-col gap-4px'>
              <DarhaiSelect
                value={config.voice}
                onChange={(value) => onChange((current) => ({ ...current, voice: value as string }))}
              >
                {/* 'default' = the bundle's own default voice (the speak call
                    omits the field), so a bundle update can rename its default
                    without breaking stored configs. */}
                <DarhaiSelect.Option value='default'>{t('settings.textToSpeechVoiceDefault')}</DarhaiSelect.Option>
                {(kittenVoices ?? []).map((voice) => (
                  <DarhaiSelect.Option key={voice.name} value={voice.name}>
                    {voice.label}
                  </DarhaiSelect.Option>
                ))}
              </DarhaiSelect>
              {kittenVoices !== null && kittenVoices.length === 0 && <KittenVoiceListHint />}
            </div>
          ) : (
            <Input value={config.voice} onChange={(value) => onChange((current) => ({ ...current, voice: value }))} />
          )}
        </Form.Item>

        <Form.Item label={t('settings.textToSpeechSpeed')}>
          {/* Reserve the same horizontal gutter on both sides as the
              widest tick label, so Arco's translateX(-50%) centering on
              the leftmost (0.5×) and rightmost (2×) marks doesn't push
              the label past the form container. 20px is enough for "0.5×"
              (~24px wide, half = 12px) with a small visual breather. */}
          <div className='px-20px'>
            <Slider
              min={0.5}
              max={2.0}
              step={0.1}
              value={config.speed}
              onChange={(value) => onChange((current) => ({ ...current, speed: value as number }))}
              marks={{ 0.5: '0.5×', 1: '1×', 1.5: '1.5×', 2: '2×' }}
              className='w-full'
            />
          </div>
        </Form.Item>

        <Form.Item label={t('settings.textToSpeechAutoRead')}>
          <Switch
            checked={config.autoReadResponses}
            onChange={(checked) => onChange((current) => ({ ...current, autoReadResponses: checked }))}
          />
        </Form.Item>
      </Form>
    </div>
  );
};

export const SpeechToTextSettingsSection: React.FC<{
  config: SpeechToTextConfig;
  onChange: (updater: (current: SpeechToTextConfig) => SpeechToTextConfig) => void;
}> = ({ config, onChange }) => {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const handleOpenProvidersPage = useCallback(() => {
    try {
      navigate('/settings/models');
    } catch {
      // Settings modal context may not have a router - fall back to hash route.
      if (typeof window !== 'undefined') {
        window.location.hash = '#/settings/models';
      }
    }
  }, [navigate]);
  const renderSpeechToTextFieldLabel = useCallback(
    (labelKey: string, requirement: 'required' | 'optional') => (
      <span className='inline-flex items-center gap-6px'>
        <span>{t(labelKey)}</span>
        <span aria-hidden='true' className='text-12px text-t-tertiary'>
          ({t(requirement === 'required' ? 'settings.speechToTextRequired' : 'settings.speechToTextOptional')})
        </span>
      </span>
    ),
    [t]
  );

  const handleProviderChange = useCallback(
    (value: string) => {
      onChange((current) => ({
        ...current,
        provider: value as SpeechToTextProvider,
      }));
    },
    [onChange]
  );

  const handleOpenAIChange = useCallback(
    (field: keyof NonNullable<SpeechToTextConfig['openai']>, value: string) => {
      onChange((current) => ({
        ...current,
        openai: {
          ...current.openai,
          [field]: value,
        },
      }));
    },
    [onChange]
  );

  const handleDeepgramChange = useCallback(
    (field: keyof NonNullable<SpeechToTextConfig['deepgram']>, value: string | boolean) => {
      onChange((current) => ({
        ...current,
        deepgram: {
          ...current.deepgram,
          [field]: value,
        },
      }));
    },
    [onChange]
  );

  return (
    <div className='px-[12px] md:px-[32px] py-[24px] bg-[var(--color-bg-2)] rd-12px border-2 border-solid border-[var(--color-border-2)]'>
      <div className='flex items-center justify-between gap-12px mb-8px'>
        <div className='flex flex-col gap-4px'>
          <span className='text-14px text-t-primary'>{t('settings.speechToText')}</span>
          <span className='text-13px text-t-secondary'>{t('settings.speechToTextDescription')}</span>
        </div>
        <Switch
          checked={config.enabled}
          onChange={(checked) => {
            onChange((current) => ({
              ...current,
              enabled: checked,
            }));
          }}
        />
      </div>

      <Divider className='mt-0px mb-20px' />

      <Form layout='horizontal' labelAlign='left' className='space-y-12px'>
        <Form.Item label={t('settings.speechToTextProvider')}>
          <DarhaiSelect value={config.provider} onChange={handleProviderChange}>
            <DarhaiSelect.Option value='nemotron-mn'>
              {t('settings.speechToTextProviderNemotronMn')}
            </DarhaiSelect.Option>
            <DarhaiSelect.Option value='openai'>{t('settings.speechToTextProviderOpenAI')}</DarhaiSelect.Option>
            <DarhaiSelect.Option value='deepgram'>{t('settings.speechToTextProviderDeepgram')}</DarhaiSelect.Option>
            {/* 'whisper-local' is deliberately absent: its pinned binary
                downloads all 404 (docs/architecture/mongolian-voice.md), so
                offering it would sell a provider that cannot run. */}
          </DarhaiSelect>
        </Form.Item>

        <Form.Item label={t('settings.voiceMicCheckLabel', 'Microphone')}>
          <MicrophoneCheck />
        </Form.Item>

        {config.provider === 'openai' ? (
          <>
            <Form.Item label={renderSpeechToTextFieldLabel('settings.speechToTextApiKey', 'required')}>
              <div className='rounded-12px bg-[var(--color-fill-2)] p-12px flex items-center justify-between gap-12px'>
                <div>
                  <div className='text-13px font-medium text-t-primary'>
                    {t('settings.voiceProviderKeyDeferTitle', 'Configure your OpenAI key in Providers')}
                  </div>
                  <div className='text-12px text-t-secondary'>
                    {t(
                      'settings.voiceProviderKeyDeferBody',
                      'Provider keys live in one place so every feature can use them.'
                    )}
                  </div>
                </div>
                <Button size='small' className='' onClick={handleOpenProvidersPage}>
                  {t('settings.voiceProviderKeyDeferCTA', 'Open Providers →')}
                </Button>
              </div>
            </Form.Item>
            <Form.Item label={renderSpeechToTextFieldLabel('settings.speechToTextBaseUrl', 'optional')}>
              <Input value={config.openai?.baseUrl} onChange={(value) => handleOpenAIChange('baseUrl', value)} />
            </Form.Item>
            <Form.Item label={renderSpeechToTextFieldLabel('settings.speechToTextModel', 'optional')}>
              <Input value={config.openai?.model} onChange={(value) => handleOpenAIChange('model', value)} />
            </Form.Item>
            <Form.Item label={renderSpeechToTextFieldLabel('settings.speechToTextLanguage', 'optional')}>
              <Input value={config.openai?.language} onChange={(value) => handleOpenAIChange('language', value)} />
            </Form.Item>
          </>
        ) : config.provider === 'nemotron-mn' ? (
          <Form.Item label={t('settings.speechToTextModel')}>
            <div className='flex flex-col gap-6px'>
              <span className='text-13px text-t-secondary'>{t('settings.speechToTextNemotronDescription')}</span>
              {/* Points at the install card while the runtime + model are missing. */}
              <NemotronInstallHint />
            </div>
          </Form.Item>
        ) : config.provider === 'deepgram' ? (
          <>
            <Form.Item label={renderSpeechToTextFieldLabel('settings.speechToTextApiKey', 'required')}>
              <Input.Password
                value={config.deepgram?.apiKey}
                visibilityToggle
                onChange={(value) => handleDeepgramChange('apiKey', value)}
              />
            </Form.Item>
            <Form.Item label={renderSpeechToTextFieldLabel('settings.speechToTextBaseUrl', 'optional')}>
              <Input value={config.deepgram?.baseUrl} onChange={(value) => handleDeepgramChange('baseUrl', value)} />
            </Form.Item>
            <Form.Item label={renderSpeechToTextFieldLabel('settings.speechToTextModel', 'optional')}>
              <Input value={config.deepgram?.model} onChange={(value) => handleDeepgramChange('model', value)} />
            </Form.Item>
            <Form.Item label={renderSpeechToTextFieldLabel('settings.speechToTextLanguage', 'optional')}>
              <Input value={config.deepgram?.language} onChange={(value) => handleDeepgramChange('language', value)} />
            </Form.Item>
            <Form.Item label={renderSpeechToTextFieldLabel('settings.speechToTextDetectLanguage', 'optional')}>
              <Switch
                checked={config.deepgram?.detectLanguage !== false}
                onChange={(checked) => handleDeepgramChange('detectLanguage', checked)}
              />
            </Form.Item>
            <Form.Item label={renderSpeechToTextFieldLabel('settings.speechToTextPunctuate', 'optional')}>
              <Switch
                checked={config.deepgram?.punctuate !== false}
                onChange={(checked) => handleDeepgramChange('punctuate', checked)}
              />
            </Form.Item>
            <Form.Item label={renderSpeechToTextFieldLabel('settings.speechToTextSmartFormat', 'optional')}>
              <Switch
                checked={config.deepgram?.smartFormat !== false}
                onChange={(checked) => handleDeepgramChange('smartFormat', checked)}
              />
            </Form.Item>
          </>
        ) : null}
      </Form>
    </div>
  );
};

/**
 * MCP management in the legacy settings modal is now just a pointer at the
 * new full-page MCP Library. The old inline CRUD (browse / add / edit /
 * delete server rows) was removed in P8 in favor of `/settings/mcp-library`.
 * We keep a small CTA here so users opening Tools -> MCP from the modal land
 * somewhere useful.
 */
const ModalMcpLibraryLinkSection: React.FC = () => {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const handleOpenLibrary = useCallback(() => {
    try {
      navigate('/settings/mcp-library/installed');
    } catch {
      if (typeof window !== 'undefined') {
        window.location.hash = '#/settings/mcp-library/installed';
      }
    }
  }, [navigate]);

  return (
    <div className='flex flex-col gap-12px min-h-0'>
      <div className='flex items-center justify-between gap-12px'>
        <div className='flex flex-col gap-4px'>
          <span className='text-14px text-t-primary'>{t('settings.mcpSettings', { defaultValue: 'MCP Servers' })}</span>
          <span className='text-13px text-t-secondary'>
            {t('settings.mcpModalDeprecatedBody', 'Browse, install, and manage MCP servers in the new MCP Library.')}
          </span>
        </div>
        <Button type='outline' shape='round' onClick={handleOpenLibrary}>
          {t('settings.mcpModalOpenLibraryCTA', 'Open MCP Library')}
        </Button>
      </div>
    </div>
  );
};

const ToolsModalContent: React.FC = () => {
  const { t } = useTranslation();
  const [mcpMessage, mcpMessageContext] = Message.useMessage({ maxCount: 10 });
  const [imageGenerationModel, setImageGenerationModel] = useState<
    IConfigStorageRefer['tools.imageGenerationModel'] | undefined
  >();
  const [speechToTextConfig, setSpeechToTextConfig] = useState<SpeechToTextConfig>(DEFAULT_SPEECH_TO_TEXT_CONFIG);
  const [isUpdatingImageGeneration, setIsUpdatingImageGeneration] = useState(false);
  const { modelListWithImage: data } = useConfigModelListWithImage();
  const { mcpServers, saveMcpServers } = useMcpServers();
  const { agentInstallStatus, setAgentInstallStatus, isServerLoading, checkSingleServerInstallStatus } =
    useMcpAgentStatus();
  const { syncMcpToAgents, removeMcpFromAgents } = useMcpOperations(mcpServers, mcpMessage);
  const builtinImageGenServer = useMemo(() => mcpServers.find(isBuiltinImageGenServer), [mcpServers]);
  const skipNextImageGenerationAutoCheckRef = useRef(false);
  const imageGenerationInstalledAgents = builtinImageGenServer?.name
    ? (agentInstallStatus[builtinImageGenServer.name] ?? [])
    : [];

  const imageGenerationModelList = useMemo(() => {
    if (!data) return [];
    // Filter models that support image generation
    const isImageModel = (modelName: string) => {
      const name = modelName.toLowerCase();
      return name.includes('image') || name.includes('banana') || name.includes('imagine');
    };
    return (data || [])
      .filter((v) => {
        const filteredModels = v.model.filter(isImageModel);
        return filteredModels.length > 0;
      })
      .map((v) => {
        const filteredModels = v.model.filter(isImageModel);
        return Object.assign({}, v, { model: filteredModels });
      });
  }, [data]);

  useEffect(() => {
    const loadConfigs = async () => {
      try {
        const storedModel = await ConfigStorage.get('tools.imageGenerationModel');
        const storedSpeechToTextConfig = await ConfigStorage.get('tools.speechToText');
        if (storedModel) {
          setImageGenerationModel(storedModel);
        }
        setSpeechToTextConfig(normalizeSpeechToTextConfig(storedSpeechToTextConfig));
      } catch (error) {
        console.error('Failed to load tools config:', error);
      }
    };

    void loadConfigs();
  }, []);

  const updateSpeechToTextConfig = useCallback((updater: (current: SpeechToTextConfig) => SpeechToTextConfig) => {
    setSpeechToTextConfig((current) => {
      const next = normalizeSpeechToTextConfig(updater(current));
      ConfigStorage.set('tools.speechToText', next).catch((error) => {
        console.error('Failed to save speech-to-text config:', error);
      });
      if (typeof window !== 'undefined') {
        window.dispatchEvent(new CustomEvent(SPEECH_TO_TEXT_CONFIG_CHANGED_EVENT));
      }
      return next;
    });
  }, []);

  useEffect(() => {
    if (!builtinImageGenServer?.name || !builtinImageGenServer.enabled) return;
    if (skipNextImageGenerationAutoCheckRef.current) {
      skipNextImageGenerationAutoCheckRef.current = false;
      return;
    }
    void checkSingleServerInstallStatus(builtinImageGenServer.name);
  }, [builtinImageGenServer?.enabled, builtinImageGenServer?.name, checkSingleServerInstallStatus]);

  const clearImageGenerationAgentStatus = useCallback(
    (serverName: string) => {
      const updated = { ...agentInstallStatus };
      delete updated[serverName];
      setAgentInstallStatus(updated);
      void ConfigStorage.set('mcp.agentInstallStatus', updated).catch((error) => {
        console.error('Failed to clear image generation agent install status:', error);
      });
    },
    [setAgentInstallStatus, agentInstallStatus]
  );

  // Sync image generation model config to the built-in MCP server's transport.env
  const syncMcpServerEnv = useCallback(
    async (model: Partial<IConfigStorageRefer['tools.imageGenerationModel']>) => {
      const builtinServer = mcpServers.find(isBuiltinImageGenServer);
      if (!builtinServer || builtinServer.transport.type !== 'stdio') return;

      const env: Record<string, string> = { ...builtinServer.transport.env };
      if (model.platform) {
        env.DARHAI_IMG_PLATFORM = model.platform;
      } else {
        delete env.DARHAI_IMG_PLATFORM;
      }
      if (model.baseUrl) {
        env.DARHAI_IMG_BASE_URL = model.baseUrl;
      } else {
        delete env.DARHAI_IMG_BASE_URL;
      }
      if (model.apiKey) {
        env.DARHAI_IMG_API_KEY = model.apiKey;
      } else {
        delete env.DARHAI_IMG_API_KEY;
      }
      if (model.useModel) {
        env.DARHAI_IMG_MODEL = model.useModel;
      } else {
        delete env.DARHAI_IMG_MODEL;
      }

      const updatedServer: IMcpServer = {
        ...builtinServer,
        transport: { ...builtinServer.transport, env },
        updatedAt: Date.now(),
      };

      const updatedServers = mcpServers.map((s) => (s.id === BUILTIN_IMAGE_GEN_ID ? updatedServer : s));
      await saveMcpServers(updatedServers);
      if (updatedServer.enabled) {
        await syncMcpToAgents(updatedServer, true);
      }
    },
    [mcpServers, saveMcpServers, syncMcpToAgents]
  );

  // Sync imageGenerationModel apiKey when provider apiKey changes
  useEffect(() => {
    if (!imageGenerationModel || !data) return;

    const currentProvider = data.find((p) => p.id === imageGenerationModel.id);

    if (currentProvider && currentProvider.apiKey !== imageGenerationModel.apiKey) {
      const updatedModel = {
        ...imageGenerationModel,
        apiKey: currentProvider.apiKey,
      };

      setImageGenerationModel(updatedModel);
      ConfigStorage.set('tools.imageGenerationModel', updatedModel).catch((error) => {
        console.error('Failed to save image generation model config:', error);
      });
      void syncMcpServerEnv(updatedModel);
    } else if (!currentProvider) {
      setImageGenerationModel(undefined);
      ConfigStorage.remove('tools.imageGenerationModel').catch((error) => {
        console.error('Failed to remove image generation model config:', error);
      });
      void syncMcpServerEnv({});
    }
  }, [data, imageGenerationModel?.id, imageGenerationModel?.apiKey, syncMcpServerEnv]);

  const handleImageGenerationModelChange = useCallback(
    (value: Partial<IConfigStorageRefer['tools.imageGenerationModel']>) => {
      setImageGenerationModel((prev) => {
        const newImageGenerationModel = { ...prev, ...value };
        ConfigStorage.set('tools.imageGenerationModel', newImageGenerationModel).catch((error) => {
          console.error('Failed to update image generation model config:', error);
        });
        // Sync env vars to the built-in MCP server
        void syncMcpServerEnv(newImageGenerationModel);
        return newImageGenerationModel;
      });
    },
    [syncMcpServerEnv]
  );

  const handleImageGenerationToggle = useCallback(
    async (checked: boolean) => {
      if (!builtinImageGenServer) return;

      const updatedServer: IMcpServer = {
        ...builtinImageGenServer,
        enabled: checked,
        updatedAt: Date.now(),
      };

      setIsUpdatingImageGeneration(true);
      skipNextImageGenerationAutoCheckRef.current = checked;
      try {
        await saveMcpServers((prevServers) =>
          prevServers.map((server) => (isBuiltinImageGenServer(server) ? updatedServer : server))
        );

        setImageGenerationModel((prev) => {
          if (!prev) return prev;
          const next = { ...prev, switch: checked };
          ConfigStorage.set('tools.imageGenerationModel', next).catch((error) => {
            console.error('Failed to sync image generation switch state:', error);
          });
          return next;
        });

        if (checked) {
          clearImageGenerationAgentStatus(updatedServer.name);
          await syncMcpToAgents(updatedServer, true);
          await checkSingleServerInstallStatus(updatedServer.name);
        } else {
          await removeMcpFromAgents(updatedServer.name, undefined, updatedServer.transport.type);
          clearImageGenerationAgentStatus(updatedServer.name);
        }
      } catch (error) {
        skipNextImageGenerationAutoCheckRef.current = false;
        console.error('Failed to toggle image generation MCP server:', error);
      } finally {
        if (!checked) {
          skipNextImageGenerationAutoCheckRef.current = false;
        }
        setIsUpdatingImageGeneration(false);
      }
    },
    [
      builtinImageGenServer,
      checkSingleServerInstallStatus,
      clearImageGenerationAgentStatus,
      removeMcpFromAgents,
      saveMcpServers,
      syncMcpToAgents,
    ]
  );

  const viewMode = useSettingsViewMode();
  const isPageMode = viewMode === 'page';

  return (
    <div className='flex flex-col h-full w-full'>
      {mcpMessageContext}

      {/* Content Area */}
      <DarhaiScrollArea className='flex-1 min-h-0 pb-16px' disableOverflow={isPageMode}>
        <div className='space-y-16px'>
          {/* MCP tool configuration */}
          <div className='px-[12px] md:px-[32px] py-[24px] bg-2 rd-12px md:rd-16px flex flex-col min-h-0 border border-border-2'>
            <div className='flex-1 min-h-0'>
              <DarhaiScrollArea
                className={classNames('h-full', isPageMode && 'overflow-visible')}
                disableOverflow={isPageMode}
              >
                <ModalMcpLibraryLinkSection />
              </DarhaiScrollArea>
            </div>
          </div>
          {/* Image generation */}
          <div className='px-[12px] md:px-[32px] py-[24px] bg-[var(--color-bg-2)] rd-12px border-2 border-solid border-[var(--color-border-2)]'>
            <div className='flex items-center justify-between mb-16px'>
              <span className='text-14px text-t-primary'>{t('settings.imageGeneration')}</span>
              <div className='flex items-center gap-8px'>
                {builtinImageGenServer?.enabled && builtinImageGenServer.name && (
                  <McpAgentStatusDisplay
                    serverName={builtinImageGenServer.name}
                    agentInstallStatus={agentInstallStatus}
                    isLoadingAgentStatus={
                      isServerLoading(builtinImageGenServer.name) && imageGenerationInstalledAgents.length === 0
                    }
                    alwaysVisible
                  />
                )}
                <Switch
                  disabled={
                    isUpdatingImageGeneration ||
                    !builtinImageGenServer ||
                    !imageGenerationModelList.length ||
                    !imageGenerationModel?.useModel
                  }
                  checked={Boolean(builtinImageGenServer?.enabled)}
                  onChange={handleImageGenerationToggle}
                />
              </div>
            </div>

            <Divider className='mt-0px mb-20px' />

            <Form layout='horizontal' labelAlign='left' className='space-y-12px'>
              <Form.Item label={t('settings.imageGenerationModel')}>
                {imageGenerationModelList.length > 0 ? (
                  <DarhaiSelect
                    value={
                      imageGenerationModel?.id && imageGenerationModel?.useModel
                        ? `${imageGenerationModel.id}|${imageGenerationModel.useModel}`
                        : undefined
                    }
                    onChange={(value) => {
                      const [platformId, modelName] = value.split('|');
                      const platform = imageGenerationModelList.find((p) => p.id === platformId);
                      if (platform) {
                        handleImageGenerationModelChange({
                          ...platform,
                          useModel: modelName,
                        });
                      }
                    }}
                  >
                    {imageGenerationModelList.map(({ model, ...platform }) => (
                      <DarhaiSelect.OptGroup label={platform.name} key={platform.id}>
                        {model.map((modelName) => (
                          <DarhaiSelect.Option key={platform.id + modelName} value={platform.id + '|' + modelName}>
                            {modelName}
                          </DarhaiSelect.Option>
                        ))}
                      </DarhaiSelect.OptGroup>
                    ))}
                  </DarhaiSelect>
                ) : (
                  <div className='text-t-secondary flex items-center'>
                    {t('settings.noAvailable')}
                    <Tooltip
                      content={
                        <div>
                          {t('settings.needHelpTooltip')}
                          <a
                            href='https://github.com/sergei10a-rgb/darhai/wiki/Wayland-Image-Generation-Tool-Model-Configuration-Guide'
                            target='_blank'
                            rel='noopener noreferrer'
                            className='text-[rgb(var(--primary-6))] hover:text-[rgb(var(--primary-5))] underline ml-4px'
                            onClick={(e) => e.stopPropagation()}
                          >
                            {t('settings.configGuide')}
                          </a>
                        </div>
                      }
                    >
                      <a
                        href='https://github.com/sergei10a-rgb/darhai/wiki/Wayland-Image-Generation-Tool-Model-Configuration-Guide'
                        target='_blank'
                        rel='noopener noreferrer'
                        className='ml-8px text-[rgb(var(--primary-6))] hover:text-[rgb(var(--primary-5))] cursor-pointer'
                        onClick={(e) => e.stopPropagation()}
                      >
                        <HelpCircle size={14} />
                      </a>
                    </Tooltip>
                  </div>
                )}
              </Form.Item>
            </Form>
          </div>
          <SpeechToTextSettingsSection config={speechToTextConfig} onChange={updateSpeechToTextConfig} />
          {/* Mongolian voice core: the components both local providers above
              (nemotron-mn STT, kitten-mn TTS) need before they can run. */}
          <MongolVoiceInstallCard />
        </div>
      </DarhaiScrollArea>
    </div>
  );
};

export default ToolsModalContent;
