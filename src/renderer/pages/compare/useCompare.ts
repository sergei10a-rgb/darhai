/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

import { useCallback, useState } from 'react';
import useSWR from 'swr';
import { ipcBridge } from '@/common';
import type { CompareModelRef, CompareResult } from '@/common/types/compare';

/** One selectable model in the picker (flattened from every connected provider). */
export type CompareModelOption = {
  providerId: string;
  modelId: string;
  label: string;
  providerLabel: string;
};

/** Stable option key for the Arco multi-select value list. */
export function modelOptionKey(option: Pick<CompareModelOption, 'providerId' | 'modelId'>): string {
  return `${option.providerId}::${option.modelId}`;
}

/**
 * Build the flat selectable-model list from the model registry: every connected
 * provider's curated + enabled models. Runs once (SWR-cached) - re-selecting the
 * page reuses it.
 */
async function loadModelOptions(): Promise<CompareModelOption[]> {
  const providers = await ipcBridge.modelRegistry.list.invoke();
  // `unverified` providers are usable (creds stored, catalog built) - only the
  // connection PROOF is missing, so they belong in the picker alongside
  // `connected`. `testing` / `error` stay out.
  const connected = providers.filter((p) => (p.state === 'connected' || p.state === 'unverified') && p.modelCount > 0);
  const lists = await Promise.all(
    connected.map(async (provider) => {
      const view = await ipcBridge.modelRegistry.getCatalog.invoke({ providerId: provider.providerId });
      const providerLabel = String(provider.providerId);
      return view.curated
        .filter((model) => model.enabled)
        .map<CompareModelOption>((model) => ({
          providerId: providerLabel,
          modelId: model.id,
          label: model.displayName || model.id,
          providerLabel,
        }));
    })
  );
  return lists.flat();
}

/**
 * Compare page data layer: loads the selectable models once, owns the prompt /
 * selection / blind state, and runs the fan-out through `compare.run`.
 */
export function useCompare() {
  const { data: models, isLoading: modelsLoading } = useSWR<CompareModelOption[]>('compare/models', loadModelOptions, {
    revalidateOnFocus: false,
  });

  const [prompt, setPrompt] = useState('');
  const [selectedKeys, setSelectedKeys] = useState<string[]>([]);
  const [blind, setBlind] = useState(false);
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<CompareResult | null>(null);

  const options = models ?? [];
  const canRun = prompt.trim().length > 0 && selectedKeys.length > 0 && !running;

  const run = useCallback(async (): Promise<void> => {
    const refs: CompareModelRef[] = selectedKeys
      .map((key) => options.find((option) => modelOptionKey(option) === key))
      .filter((option): option is CompareModelOption => Boolean(option))
      .map((option) => ({ providerId: option.providerId, modelId: option.modelId, label: option.label }));
    if (refs.length === 0 || prompt.trim().length === 0) return;
    setRunning(true);
    try {
      const next = await ipcBridge.compare.run.invoke({ prompt, modelRefs: refs, blind });
      setResult(next);
    } finally {
      setRunning(false);
    }
  }, [options, selectedKeys, prompt, blind]);

  return {
    models: options,
    modelsLoading,
    prompt,
    setPrompt,
    selectedKeys,
    setSelectedKeys,
    blind,
    setBlind,
    running,
    result,
    canRun,
    run,
  };
}
