/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

// @vitest-environment jsdom

/**
 * Integration test for the chat-redesign /assistants library page.
 *
 * Verifies the page wires the lifted AssistantEditDrawer + grouping +
 * URL-synced filters together end-to-end, without re-creating the
 * Settings page's state shape.
 */

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import React from 'react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';

const mockEditor = vi.hoisted(() => ({
  editVisible: false,
  setEditVisible: vi.fn(),
  isCreating: false,
  editName: '',
  setEditName: vi.fn(),
  editDescription: '',
  setEditDescription: vi.fn(),
  editAvatar: '',
  setEditAvatar: vi.fn(),
  editAgent: 'gemini',
  setEditAgent: vi.fn(),
  editContext: '',
  setEditContext: vi.fn(),
  promptViewMode: 'preview' as 'preview' | 'edit',
  setPromptViewMode: vi.fn(),
  availableSkills: [],
  selectedSkills: [],
  setSelectedSkills: vi.fn(),
  pendingSkills: [],
  setPendingSkills: vi.fn(),
  customSkills: [],
  setCustomSkills: vi.fn(),
  deletePendingSkillName: null,
  setDeletePendingSkillName: vi.fn(),
  deleteCustomSkillName: null,
  setDeleteCustomSkillName: vi.fn(),
  skillsModalVisible: false,
  setSkillsModalVisible: vi.fn(),
  builtinAutoSkills: [],
  disabledBuiltinSkills: [],
  setDisabledBuiltinSkills: vi.fn(),
  deleteConfirmVisible: false,
  setDeleteConfirmVisible: vi.fn(),
  handleSave: vi.fn(),
  handleDeleteClick: vi.fn(),
  handleDeleteConfirm: vi.fn(),
  handleEdit: vi.fn().mockResolvedValue(undefined),
  handleCreate: vi.fn().mockResolvedValue(undefined),
  handleDuplicate: vi.fn(),
  handleToggleEnabled: vi.fn(),
}));

const mockAssistants = vi.hoisted(() => [
  {
    id: 'builtin-word-creator',
    name: 'Word Creator',
    nameI18n: { 'en-US': 'Word Creator' },
    descriptionI18n: { 'en-US': 'Build Word docs' },
    isBuiltin: true,
    isPreset: true,
    presetAgentType: 'gemini',
  },
  {
    id: 'ext-fire-sales',
    name: 'Fire Sales',
    nameI18n: { 'en-US': 'Fire Sales' },
    descriptionI18n: { 'en-US': 'Sells things' },
    isBuiltin: false,
    isPreset: true,
    presetAgentType: 'gemini',
    _source: 'extension',
  },
  {
    id: 'ext-doc-helper',
    name: 'Doc Helper',
    nameI18n: { 'en-US': 'Doc Helper' },
    descriptionI18n: { 'en-US': 'Helps with docs' },
    isBuiltin: false,
    isPreset: true,
    presetAgentType: 'claude',
    _source: 'extension',
  },
]);

const setSelectedAgentMock = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (_key: string, opts?: { defaultValue?: string; count?: number; backend?: string; name?: string }) => {
      const fallback = opts?.defaultValue ?? _key;
      if (opts?.count !== undefined) return fallback.replace('{{count}}', String(opts.count));
      if (opts?.backend) return fallback.replace('{{backend}}', opts.backend);
      if (opts?.name) return fallback.replace('{{name}}', opts.name);
      return fallback;
    },
  }),
}));

vi.mock('@/renderer/utils/platform', () => ({
  resolveExtensionAssetUrl: (v: string) => v,
}));

vi.mock('@/renderer/hooks/assistant', () => ({
  useAssistantList: () => ({
    assistants: mockAssistants,
    activeAssistantId: null,
    setActiveAssistantId: vi.fn(),
    activeAssistant: null,
    isExtensionAssistant: (a: { _source?: string }) => a?._source === 'extension',
    loadAssistants: vi.fn().mockResolvedValue(undefined),
    localeKey: 'en-US',
  }),
  useDetectedAgents: () => ({
    availableBackends: [{ id: 'gemini', name: 'Gemini' }],
    refreshAgentDetection: vi.fn().mockResolvedValue(undefined),
  }),
  useAssistantEditor: () => mockEditor,
  useAssistantSkills: () => ({
    externalSources: [],
    activeSourceTab: '',
    setActiveSourceTab: vi.fn(),
    activeSource: null,
    filteredExternalSkills: [],
    externalSkillsLoading: false,
    searchExternalQuery: '',
    setSearchExternalQuery: vi.fn(),
    refreshing: false,
    handleRefreshExternal: vi.fn(),
    showAddPathModal: false,
    setShowAddPathModal: vi.fn(),
    customPathName: '',
    setCustomPathName: vi.fn(),
    customPathValue: '',
    setCustomPathValue: vi.fn(),
    handleAddCustomPath: vi.fn(),
    handleAddFoundSkills: vi.fn(),
  }),
}));

vi.mock('@/common/config/storage', () => ({
  ConfigStorage: {
    get: vi.fn().mockResolvedValue(null),
    set: setSelectedAgentMock,
  },
}));

vi.mock('@/common', () => ({
  ipcBridge: {
    extensions: {
      getAssistants: {
        invoke: vi
          .fn()
          .mockResolvedValue([
            { id: 'ext-fire-sales', category: 'sell' },
            { id: 'ext-doc-helper', category: 'write' },
          ]),
      },
    },
  },
}));

// Drawer & modals — substitute minimal stubs to avoid pulling in their full
// dependency graph. The page wiring contract is "renders <AssistantEditDrawer>
// with editor + list + availableBackends + editAvatarImage props" — we
// assert that contract through the editor handlers being callable.
vi.mock('@/renderer/pages/settings/AssistantSettings/AssistantEditDrawer', () => ({
  default: ({ editor }: { editor: { editVisible: boolean } }) => (
    <div data-testid='mock-edit-drawer' data-visible={String(editor.editVisible)} />
  ),
}));
vi.mock('@/renderer/pages/settings/AssistantSettings/DeleteAssistantModal', () => ({
  default: () => null,
}));
vi.mock('@/renderer/pages/settings/AssistantSettings/AddSkillsModal', () => ({
  default: () => null,
}));
vi.mock('@/renderer/pages/settings/AssistantSettings/SkillConfirmModals', () => ({
  default: () => null,
}));
vi.mock('@/renderer/pages/settings/AssistantSettings/AddCustomPathModal', () => ({
  default: () => null,
}));
vi.mock('@/renderer/pages/settings/AssistantSettings/assistantUtils', () => ({
  resolveAvatarImageSrc: () => undefined,
}));

import AssistantsLibraryPage from '../../../../src/renderer/pages/assistants/AssistantsLibraryPage';

const renderPage = (initialRoute = '/assistants') =>
  render(
    <MemoryRouter initialEntries={[initialRoute]}>
      <AssistantsLibraryPage />
    </MemoryRouter>
  );

describe('AssistantsLibraryPage', () => {
  it('renders the three group headers and assistant cards', async () => {
    renderPage();

    await waitFor(() => {
      // Built-ins group always renders (BuildMyOwn lives at its tail).
      expect(screen.getByTestId('assistants-group-builtins')).toBeTruthy();
    });
    // Teams group exists when at least one sell/run extension assistant present.
    expect(screen.getByTestId('assistants-group-teams')).toBeTruthy();
    expect(screen.getByTestId('assistants-group-specialists')).toBeTruthy();
    // BuildMyOwnCard at end of Built-ins.
    expect(screen.getByTestId('assistant-card-build-my-own')).toBeTruthy();
    // Cards rendered for each assistant.
    expect(screen.getByTestId('assistant-card-builtin-word-creator')).toBeTruthy();
    expect(screen.getByTestId('assistant-card-ext-fire-sales')).toBeTruthy();
    expect(screen.getByTestId('assistant-card-ext-doc-helper')).toBeTruthy();
  });

  it('clicking a card persists the selected agent key and would route to /guid', async () => {
    setSelectedAgentMock.mockClear();
    renderPage();

    await waitFor(() => screen.getByTestId('assistant-card-builtin-word-creator'));
    fireEvent.click(screen.getByTestId('assistant-card-builtin-word-creator'));

    await waitFor(() => {
      expect(setSelectedAgentMock).toHaveBeenCalledWith('guid.lastSelectedAgent', 'custom:builtin-word-creator');
    });
  });

  it('clicking BuildMyOwnCard opens the drawer in create mode', async () => {
    mockEditor.handleCreate.mockClear();
    renderPage();

    await waitFor(() => screen.getByTestId('assistant-card-build-my-own'));
    fireEvent.click(screen.getByTestId('assistant-card-build-my-own'));

    await waitFor(() => {
      expect(mockEditor.handleCreate).toHaveBeenCalledTimes(1);
    });
  });

  it('clicking the action-bar CTA also opens the drawer in create mode', async () => {
    mockEditor.handleCreate.mockClear();
    renderPage();

    await waitFor(() => screen.getByTestId('assistants-build-my-own-cta'));
    fireEvent.click(screen.getByTestId('assistants-build-my-own-cta'));

    await waitFor(() => {
      expect(mockEditor.handleCreate).toHaveBeenCalledTimes(1);
    });
  });

  it('groups extension assistants with category=sell into Teams', async () => {
    renderPage();

    await waitFor(() => screen.getByTestId('assistants-group-teams'));
    const teamsGroup = screen.getByTestId('assistants-group-teams');
    // Fire Sales has category=sell from the mock manifest — should land in Teams.
    expect(teamsGroup.querySelector('[data-testid="assistant-card-ext-fire-sales"]')).not.toBeNull();
    // Doc Helper (category=write) lands in Specialists, not Teams.
    expect(teamsGroup.querySelector('[data-testid="assistant-card-ext-doc-helper"]')).toBeNull();
  });

  it('FilterRail type filter routes through URL and excludes non-matching cards', async () => {
    renderPage('/assistants?type=builtin');

    await waitFor(() => screen.getByTestId('assistants-group-builtins'));
    expect(screen.getByTestId('assistant-card-builtin-word-creator')).toBeTruthy();
    expect(screen.queryByTestId('assistant-card-ext-fire-sales')).toBeNull();
    expect(screen.queryByTestId('assistant-card-ext-doc-helper')).toBeNull();
  });

  it('FilterRail domain filter narrows by category via URL search param', async () => {
    renderPage('/assistants?domain=write');

    await waitFor(() => screen.getByTestId('assistants-group-specialists'));
    expect(screen.getByTestId('assistant-card-ext-doc-helper')).toBeTruthy();
    expect(screen.queryByTestId('assistant-card-ext-fire-sales')).toBeNull();
    expect(screen.queryByTestId('assistant-card-builtin-word-creator')).toBeNull();
  });
});
