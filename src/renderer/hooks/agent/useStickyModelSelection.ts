/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * The selection state both model pickers share.
 *
 * The wcore and Gemini pickers had byte-identical copies of this: local state,
 * an effect that re-synced it from `initialModel`, and a select handler that
 * wrote through and then updated local state. They also had the same bug - the
 * sync was unconditional, so a read already in flight when the user clicked
 * would land afterwards and put the old model back.
 *
 * Both now share this, so the guard exists once and is tested once. See
 * `stickyModelPick.ts` for how a stale sync is told from a real one.
 */

import { useCallback, useRef, useState } from 'react';
import type { IProvider, TProviderWithModel } from '@/common/config/storage';
import type { ModelKey, PickGuard } from './stickyModelPick';
import { guardAfterSync, guardForPick, modelKeyOf, shouldAcceptSync } from './stickyModelPick';

export type StickyModelSelection = {
  currentModel?: TProviderWithModel;
  /** Select a model and write it through. Resolves once the write has settled. */
  selectModel: (provider: IProvider, modelName: string) => Promise<void>;
};

export type UseStickyModelSelectionOptions = {
  initialModel: TProviderWithModel | undefined;
  /** Persist the choice. Returning false means the write failed. */
  onSelectModel: (provider: IProvider, modelName: string) => Promise<boolean>;
};

export function useStickyModelSelection({
  initialModel,
  onSelectModel,
}: UseStickyModelSelectionOptions): StickyModelSelection {
  const [currentModel, setCurrentModel] = useState<TProviderWithModel | undefined>(initialModel);

  const guardRef = useRef<PickGuard>(null);
  // What `initialModel` was last time we looked, so a sync is only handled when
  // the prop actually changed. `undefined` means "never looked" - distinct from
  // the `null` key of an absent model.
  const lastSyncedRef = useRef<ModelKey | undefined>(undefined);
  // Mirror of the rendered selection, readable from the async select handler
  // without capturing a stale closure.
  const currentRef = useRef<TProviderWithModel | undefined>(currentModel);
  currentRef.current = currentModel;

  // Adjusting state during render rather than in an effect: an effect would
  // paint the stale model for a frame and then correct it, which is the flicker
  // this whole guard exists to remove.
  const incomingKey = modelKeyOf(initialModel);
  if (lastSyncedRef.current !== incomingKey) {
    lastSyncedRef.current = incomingKey;
    if (shouldAcceptSync(incomingKey, guardRef.current)) {
      setCurrentModel(initialModel);
      currentRef.current = initialModel;
    }
    guardRef.current = guardAfterSync(incomingKey, guardRef.current);
  }

  const selectModel = useCallback(
    async (provider: IProvider, modelName: string) => {
      const selected = { ...(provider as unknown as TProviderWithModel), useModel: modelName };
      const replaced = currentRef.current;

      // Arm the guard and show the choice BEFORE awaiting the write. The write
      // can take a second - the conversation picker stops the running agent
      // first - and a read landing inside that window is exactly the one that
      // used to undo the click.
      guardRef.current = guardForPick(modelKeyOf(selected), modelKeyOf(replaced));
      currentRef.current = selected;
      setCurrentModel(selected);

      let ok = false;
      try {
        ok = await onSelectModel(provider, modelName);
      } finally {
        if (!ok) {
          // The write failed, so the picker must not go on claiming the new
          // model - the next message would still go to the old one.
          guardRef.current = null;
          // Forget what we last synced too, so the unchanged `initialModel`
          // still counts as a change and can restore the truth.
          lastSyncedRef.current = undefined;
          currentRef.current = replaced;
          setCurrentModel(replaced);
        }
      }
    },
    [onSelectModel]
  );

  return { currentModel, selectModel };
}
