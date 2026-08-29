import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import { getRegisteredShadowRoots } from '@renderer/utils/shadowSelection';

vi.mock('@office-ai/platform', () => ({
  theme: { Color: { PrimaryColor: '#3370ff' } },
}));

vi.mock('@renderer/utils/theme/customCssProcessor', () => ({
  addImportantToAll: (css: string) => css,
}));

vi.mock('@/common/config/storage', () => ({
  ConfigStorage: { get: vi.fn(async () => '') },
}));

const importShadowView = async () => (await import('@renderer/components/Markdown/ShadowView')).default;

afterEach(() => {
  cleanup();
});

describe('ShadowView shadow-root registration', () => {
  it('registers its shadow root so selection readers can see past the boundary', async () => {
    const ShadowView = await importShadowView();
    const before = getRegisteredShadowRoots().length;

    const { container } = render(<ShadowView>text inside the shadow root</ShadowView>);
    const host = container.querySelector('.markdown-shadow') as HTMLElement;

    expect(host.shadowRoot).toBeTruthy();
    expect(getRegisteredShadowRoots()).toContain(host.shadowRoot);
    expect(getRegisteredShadowRoots().length).toBe(before + 1);
  });

  it('drops the registration on unmount so stale roots do not pile up', async () => {
    const ShadowView = await importShadowView();

    const { container, unmount } = render(<ShadowView>text inside the shadow root</ShadowView>);
    const shadowRoot = (container.querySelector('.markdown-shadow') as HTMLElement).shadowRoot;
    expect(getRegisteredShadowRoots()).toContain(shadowRoot);

    unmount();

    expect(getRegisteredShadowRoots()).not.toContain(shadowRoot);
  });
});
