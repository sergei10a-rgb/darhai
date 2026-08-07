/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

import type { IProvider, TProviderWithModel } from '@/common/config/storage';
import { useModelProviderList } from '@/renderer/hooks/agent/useModelProviderList';
import { useStickyModelSelection } from '@/renderer/hooks/agent/useStickyModelSelection';
import { useCallback, useMemo } from 'react';

export type WCoreModelSelection = {
  currentModel?: TProviderWithModel;
  providers: IProvider[];
  getAvailableModels: (provider: IProvider) => string[];
  handleSelectModel: (provider: IProvider, modelName: string) => Promise<void>;
  getDisplayModelName: (modelName?: string) => string;
};

export type UseAionrsModelSelectionOptions = {
  initialModel: TProviderWithModel | undefined;
  onSelectModel: (provider: IProvider, modelName: string) => Promise<boolean>;
};

export const useWCoreModelSelection = ({
  initialModel,
  onSelectModel,
}: UseAionrsModelSelectionOptions): WCoreModelSelection => {
  // Shared with the Gemini picker so the "don't let a slow read undo the click"
  // guard lives in one place. See useStickyModelSelection.ts.
  const { currentModel, selectModel } = useStickyModelSelection({ initialModel, onSelectModel });

  const { providers: allProviders, getAvailableModels, formatModelLabel } = useModelProviderList();

  // WaylandCLI does not support Google Auth - filter it out
  const providers = useMemo(
    () => allProviders.filter((p) => !p.platform?.toLowerCase().includes('gemini-with-google-auth')),
    [allProviders]
  );

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
    getAvailableModels,
    handleSelectModel: selectModel,
    getDisplayModelName,
  };
};
