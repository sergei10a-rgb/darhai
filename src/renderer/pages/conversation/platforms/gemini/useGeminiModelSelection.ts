import type { IProvider, TProviderWithModel } from '@/common/config/storage';
import type { GeminiModeOption } from '@/renderer/hooks/agent/useModeModeList';
import { useModelProviderList } from '@/renderer/hooks/agent/useModelProviderList';
import { useStickyModelSelection } from '@/renderer/hooks/agent/useStickyModelSelection';
import { useCallback } from 'react';

export interface GeminiModelSelection {
  currentModel?: TProviderWithModel;
  providers: IProvider[];
  geminiModeLookup: Map<string, GeminiModeOption>;
  formatModelLabel: (provider?: { platform?: string }, modelName?: string) => string;
  getDisplayModelName: (modelName?: string) => string;
  getAvailableModels: (provider: IProvider) => string[];
  handleSelectModel: (provider: IProvider, modelName: string) => Promise<void>;
}

export interface UseGeminiModelSelectionOptions {
  initialModel: TProviderWithModel | undefined;
  onSelectModel: (provider: IProvider, modelName: string) => Promise<boolean>;
}

// Centralize model selection logic for reuse across header, send box, and channel settings
export const useGeminiModelSelection = ({
  initialModel,
  onSelectModel,
}: UseGeminiModelSelectionOptions): GeminiModelSelection => {
  // Shared with the wcore picker so the "don't let a slow read undo the click"
  // guard lives in one place. See useStickyModelSelection.ts.
  const { currentModel, selectModel } = useStickyModelSelection({ initialModel, onSelectModel });

  const { providers, geminiModeLookup, getAvailableModels, formatModelLabel } = useModelProviderList();

  const getDisplayModelName = useCallback(
    (modelName?: string) => {
      if (!modelName) return '';
      const label = formatModelLabel(currentModel, modelName);
      const maxLength = 20;
      return label.length > maxLength ? `${label.slice(0, maxLength)}...` : label;
    },
    [currentModel, formatModelLabel]
  );

  return {
    currentModel,
    providers,
    geminiModeLookup,
    formatModelLabel,
    getDisplayModelName,
    getAvailableModels,
    handleSelectModel: selectModel,
  };
};
