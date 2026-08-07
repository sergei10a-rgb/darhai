import { test, expect } from 'vitest';
import React from 'react';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { BrowsePage } from '@renderer/pages/settings/McpLibrary/BrowsePage';

test('BrowsePage renders Recommended section + multiple category headings', () => {
  render(
    <MemoryRouter>
      <BrowsePage />
    </MemoryRouter>
  );
  expect(screen.getByText(/Recommended for you/)).toBeInTheDocument();
  expect(
    screen.getAllByText(/^Communication$|^Productivity|^Developer|^Search|^Personal/).length
  ).toBeGreaterThanOrEqual(3);
});

test('BrowsePage renders Google Workspace card', () => {
  render(
    <MemoryRouter>
      <BrowsePage />
    </MemoryRouter>
  );
  // Multiple cards may have the name (one in recommended, one in category) - getAllByText
  expect(screen.getAllByText('Google Workspace').length).toBeGreaterThan(0);
});

// 854c0c19e: the sidebar lands users on Browse, so the add-custom entry point
// must live here - it was previously only on the (unreachable) Installed page.
// The fix is the entry point's PRESENCE; the import modal itself is covered by
// the Installed page tests and needs a ThemeProvider we don't mount here.
test('BrowsePage exposes an add-custom-MCP entry point (was unreachable pre-854c0c19e)', () => {
  render(
    <MemoryRouter>
      <BrowsePage />
    </MemoryRouter>
  );
  // Fallback string is rendered because the test has no i18next instance.
  const addButton = screen.getByRole('button', { name: /Add custom MCP/i });
  expect(addButton).toBeInTheDocument();
  // The modal stays unmounted until the trigger is used - it must not render eagerly.
  expect(screen.queryByText(/Import.*JSON/i)).not.toBeInTheDocument();
});
