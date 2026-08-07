/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * The model the user picked, undone about a second later.
 *
 * Both pickers held the selection in local state and re-synced it from an
 * `initialModel` prop whenever that prop changed. The sync was unconditional,
 * so a read already in flight when the user clicked landed afterwards and put
 * the old model back. The user watched their choice apply and then revert - and
 * the next message went to a model they had not chosen, at a price they had not
 * agreed to.
 *
 * The reproducible case is the channel settings modal, and it is the first
 * hook test below: `initialModel` starts undefined there, the restore resolves
 * the saved model against the provider list, and the Google Auth provider takes
 * one or two SWR cycles to appear - so the restore lands a beat after the modal
 * opens and overwrites whatever was picked in the meantime.
 */

import { act, renderHook, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { IProvider, TProviderWithModel } from '@/common/config/storage';
import { guardAfterSync, guardForPick, modelKeyOf, shouldAcceptSync } from '@renderer/hooks/agent/stickyModelPick';
import { useStickyModelSelection } from '@renderer/hooks/agent/useStickyModelSelection';

const provider = (id: string): IProvider => ({ id, name: id, platform: id, model: [] }) as unknown as IProvider;
const model = (id: string, useModel: string): TProviderWithModel =>
  ({ ...provider(id), useModel }) as unknown as TProviderWithModel;

const CHEAP = model('openai', 'gpt-5-mini');
const PRICEY = model('anthropic', 'claude-opus-5');
const THIRD = model('google', 'gemini-3-pro');

describe('modelKeyOf', () => {
  it('identifies a selection by provider AND model', () => {
    // The same model name can be served by two providers at different prices,
    // so the model name alone is not an identity.
    expect(modelKeyOf(model('openai', 'gpt-5'))).not.toBe(modelKeyOf(model('azure', 'gpt-5')));
  });

  it('has no key for an absent or half-formed selection', () => {
    expect(modelKeyOf(undefined)).toBeNull();
    expect(modelKeyOf(null)).toBeNull();
    expect(modelKeyOf({ id: 'openai' })).toBeNull();
    expect(modelKeyOf({ useModel: 'gpt-5' })).toBeNull();
  });
});

describe('shouldAcceptSync', () => {
  const guard = guardForPick('anthropic:claude-opus-5', 'openai:gpt-5-mini');

  it('accepts anything when no pick is waiting to be confirmed', () => {
    expect(shouldAcceptSync('openai:gpt-5-mini', null)).toBe(true);
    expect(shouldAcceptSync(null, null)).toBe(true);
  });

  it('accepts the pick itself, since the two sides now agree', () => {
    expect(shouldAcceptSync('anthropic:claude-opus-5', guard)).toBe(true);
  });

  it('refuses the value the pick replaced - that is the slow read catching up', () => {
    expect(shouldAcceptSync('openai:gpt-5-mini', guard)).toBe(false);
  });

  it('refuses a value that was never selected either', () => {
    // The channel-settings restore resolves a saved model that may match
    // neither side, and it must not win over the click that preceded it.
    expect(shouldAcceptSync('google:gemini-3-pro', guard)).toBe(false);
  });

  it('refuses an empty sync, which is a load in progress and never a choice', () => {
    expect(shouldAcceptSync(null, guard)).toBe(false);
  });
});

describe('guardForPick', () => {
  it('guards nothing when the pick is what was already selected', () => {
    // Re-picking the current model replaces nothing, so no older value exists
    // for a late read to restore.
    expect(guardForPick('openai:gpt-5', 'openai:gpt-5')).toBeNull();
  });

  it('guards a pick made when nothing was selected yet', () => {
    // This is the channel-settings case. A guard keyed on "what it replaced"
    // would have nothing to recognise here, which is why the rule is keyed on
    // the pick instead.
    expect(guardForPick('openai:gpt-5', null)).toEqual({ pick: 'openai:gpt-5' });
  });
});

describe('guardAfterSync', () => {
  const guard = guardForPick('b:2', 'a:1');

  it('keeps guarding until a sync confirms the pick', () => {
    expect(guardAfterSync('a:1', guard)).toBe(guard);
    expect(guardAfterSync('c:3', guard)).toBe(guard);
    expect(guardAfterSync(null, guard)).toBe(guard);
  });

  it('stops guarding once the two sides agree', () => {
    expect(guardAfterSync('b:2', guard)).toBeNull();
  });
});

describe('useStickyModelSelection', () => {
  const setup = (initialModel: TProviderWithModel | undefined, ok = true) => {
    const onSelectModel = vi.fn(async () => ok);
    const view = renderHook(
      ({ m }: { m: TProviderWithModel | undefined }) => useStickyModelSelection({ initialModel: m, onSelectModel }),
      { initialProps: { m: initialModel } }
    );
    return { view, onSelectModel };
  };

  it('survives the late restore in the channel settings modal', async () => {
    // THE bug: nothing is selected yet, the user picks, and the restore that
    // was already reading the saved model lands afterwards.
    const { view } = setup(undefined);

    await act(async () => {
      await view.result.current.selectModel(provider('anthropic'), 'claude-opus-5');
    });
    view.rerender({ m: CHEAP }); // restore resolves with the previously saved model

    expect(view.result.current.currentModel?.useModel).toBe('claude-opus-5');
  });

  it('starts on the model it was given', () => {
    const { view } = setup(CHEAP);
    expect(view.result.current.currentModel).toBe(CHEAP);
  });

  it('shows the pick immediately, before the write has settled', async () => {
    let release!: (ok: boolean) => void;
    const onSelectModel = vi.fn(() => new Promise<boolean>((resolve) => (release = resolve)));
    const view = renderHook(() => useStickyModelSelection({ initialModel: CHEAP, onSelectModel }));

    act(() => {
      void view.result.current.selectModel(provider('anthropic'), 'claude-opus-5');
    });

    // The write can take a second - the conversation picker stops the running
    // agent first - and the button must not sit on the old label until then.
    expect(view.result.current.currentModel?.useModel).toBe('claude-opus-5');
    await act(async () => {
      release(true);
    });
  });

  it('keeps the pick when the replaced value is read back', async () => {
    const { view } = setup(CHEAP);

    await act(async () => {
      await view.result.current.selectModel(provider('anthropic'), 'claude-opus-5');
    });
    view.rerender({ m: undefined });
    view.rerender({ m: CHEAP });

    expect(view.result.current.currentModel?.useModel).toBe('claude-opus-5');
  });

  it('keeps the pick through a loading blip', async () => {
    const { view } = setup(CHEAP);

    await act(async () => {
      await view.result.current.selectModel(provider('anthropic'), 'claude-opus-5');
    });
    view.rerender({ m: undefined });

    expect(view.result.current.currentModel?.useModel).toBe('claude-opus-5');
  });

  it('follows the prop again once a sync has confirmed the pick', async () => {
    const { view } = setup(CHEAP);

    await act(async () => {
      await view.result.current.selectModel(provider('anthropic'), 'claude-opus-5');
    });
    view.rerender({ m: PRICEY }); // the write landed; the read now agrees
    view.rerender({ m: THIRD }); // a genuine later change

    // The guard protects one pick until it is confirmed - it must not freeze
    // the picker for the rest of the session.
    expect(view.result.current.currentModel?.useModel).toBe('gemini-3-pro');
  });

  it('rolls back when the write fails, so it cannot claim a model the app will not use', async () => {
    const { view } = setup(CHEAP, false);

    await act(async () => {
      await view.result.current.selectModel(provider('anthropic'), 'claude-opus-5');
    });

    await waitFor(() => expect(view.result.current.currentModel?.useModel).toBe('gpt-5-mini'));
  });

  it('accepts syncs again after a failed write', async () => {
    const { view } = setup(CHEAP, false);

    await act(async () => {
      await view.result.current.selectModel(provider('anthropic'), 'claude-opus-5');
    });
    view.rerender({ m: THIRD });

    expect(view.result.current.currentModel?.useModel).toBe('gemini-3-pro');
  });

  it('still writes through on every pick', async () => {
    const { view, onSelectModel } = setup(CHEAP);

    await act(async () => {
      await view.result.current.selectModel(provider('anthropic'), 'claude-opus-5');
    });

    expect(onSelectModel).toHaveBeenCalledWith(expect.objectContaining({ id: 'anthropic' }), 'claude-opus-5');
  });

  it('follows the prop before the user has picked anything', () => {
    const { view } = setup(undefined);
    view.rerender({ m: CHEAP });
    expect(view.result.current.currentModel).toBe(CHEAP);
  });
});
