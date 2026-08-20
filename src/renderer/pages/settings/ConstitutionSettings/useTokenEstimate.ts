/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

import { useEffect, useMemo, useState } from 'react';
import {
  estimateTokens,
  getLoadedTokenEncoder,
  loadTokenEncoder,
  type TokenEncoder,
  type TokenEstimate,
} from '@/common/utils/tokenCount';

/**
 * Token estimate for `text`, counted with the real tokenizer.
 *
 * Both editors on this page (the Constitution itself and each specialist
 * overlay) go through this hook, so there is exactly one place that decides
 * how a token is counted - the two of them used to inline
 * `Math.ceil(value.length / 4)` separately, which is how the renderer kept
 * showing a wrong number while the backend composer was "fixed".
 *
 * The tokenizer's rank table is 2.4 MB, so it is imported dynamically and lands
 * in its own bundle chunk instead of the startup path. Until it resolves the
 * hook returns the labelled `chars-div-4` fallback; the UI renders that label,
 * so a fallback number is never shown as if it were a real count.
 */
export function useTokenEstimate(text: string): TokenEstimate {
  const [encoder, setEncoder] = useState<TokenEncoder | null>(() => getLoadedTokenEncoder());

  useEffect(() => {
    let cancelled = false;
    void loadTokenEncoder().then((loaded) => {
      // `setState` treats a bare function as an updater, hence the wrapper.
      if (!cancelled && loaded) setEncoder(() => loaded);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  return useMemo(() => estimateTokens(text, encoder), [text, encoder]);
}

export default useTokenEstimate;
