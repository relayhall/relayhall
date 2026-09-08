// @vitest-environment jsdom
import { render, screen, waitFor, cleanup } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import '@testing-library/jest-dom/vitest';

import { ThemeProvider } from '../contexts/ThemeContext';
import { fetchPreferences, savePreferences } from '../utils/preferences';
import { PreferencesPage } from './PreferencesPage';

vi.mock('../utils/auth', () => ({
  auth: { isAuthenticated: () => true },
  authenticatedFetch: vi.fn(),
}));
vi.mock('../utils/preferences', () => ({
  fetchPreferences: vi.fn(),
  savePreferences: vi.fn(),
}));

const mockFetch = vi.mocked(fetchPreferences);
const mockSave = vi.mocked(savePreferences);

function renderPage() {
  return render(
    <ThemeProvider>
      <PreferencesPage />
    </ThemeProvider>
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  document.documentElement.removeAttribute('data-theme');
  document.documentElement.removeAttribute('data-reduced-motion');
  mockFetch.mockResolvedValue({ theme: null, reducedMotion: 'system' });
  mockSave.mockImplementation(async (patch) => ({
    theme: 'theme' in patch ? (patch.theme ?? null) : null,
    reducedMotion: patch.reducedMotion ?? 'system',
  }));
});
afterEach(cleanup);

describe('the user config page', () => {
  test('offers the deployment default plus every declared value', async () => {
    renderPage();
    await waitFor(() => expect(mockFetch).toHaveBeenCalled());

    expect(screen.getByRole('radio', { name: /Use the deployment default/ })).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: /Relay dark/ })).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: /Relay light/ })).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: /High contrast/ })).toBeInTheDocument();
    // The `system` directive is offered as a Theme choice, per D10/G-M2 —
    // there is no separate mode control to keep in step with it.
    expect(screen.getByRole('radio', { name: /Match my system/i })).toBeInTheDocument();
  });

  test('starts on the deployment default when the principal has no preference', async () => {
    renderPage();
    await waitFor(() =>
      expect(screen.getByRole('radio', { name: /Use the deployment default/ })).toBeChecked());
  });

  test('applies a chosen Theme to the document without a reload', async () => {
    const user = userEvent.setup();
    renderPage();
    await waitFor(() => expect(mockFetch).toHaveBeenCalled());

    await user.click(screen.getByRole('radio', { name: /High contrast/ }));

    await waitFor(() =>
      expect(document.documentElement.getAttribute('data-theme')).toBe('high-contrast'));
    expect(mockSave).toHaveBeenCalledWith({ theme: 'high-contrast' });
  });

  test('sends an explicit null to hand the choice back to the deployment', async () => {
    const user = userEvent.setup();
    mockFetch.mockResolvedValue({ theme: 'relay-light', reducedMotion: 'system' });
    renderPage();
    await waitFor(() =>
      expect(screen.getByRole('radio', { name: /Relay light/ })).toBeChecked());

    await user.click(screen.getByRole('radio', { name: /Use the deployment default/ }));

    // Absence would mean "leave it alone"; only an explicit null clears it.
    expect(mockSave).toHaveBeenCalledWith({ theme: null });
    await waitFor(() =>
      expect(document.documentElement.getAttribute('data-theme')).toBe('relay-dark'));
  });

  test('writes the motion attribute only when it overrides the system', async () => {
    const user = userEvent.setup();
    renderPage();
    await waitFor(() => expect(mockFetch).toHaveBeenCalled());

    await user.click(screen.getByRole('radio', { name: /Reduce motion/ }));
    await waitFor(() =>
      expect(document.documentElement.getAttribute('data-reduced-motion')).toBe('reduce'));

    await user.click(screen.getByRole('radio', { name: /Use my system setting/ }));
    await waitFor(() =>
      expect(document.documentElement.hasAttribute('data-reduced-motion')).toBe(false));
  });

  test('surfaces a rejected value instead of pretending it saved', async () => {
    const user = userEvent.setup();
    mockSave.mockRejectedValueOnce(new Error('theme must be null or one of: relay-dark'));
    renderPage();
    await waitFor(() => expect(mockFetch).toHaveBeenCalled());

    await user.click(screen.getByRole('radio', { name: /Relay light/ }));

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(/theme must be null/);
  });

  test('names every control for a screen reader', async () => {
    renderPage();
    await waitFor(() => expect(mockFetch).toHaveBeenCalled());
    for (const radio of screen.getAllByRole('radio')) {
      expect(radio).toHaveAccessibleName();
    }
    expect(screen.getByRole('group', { name: /Choose a theme/ })).toBeInTheDocument();
    expect(screen.getByRole('group', { name: /Animations and transitions/ })).toBeInTheDocument();
  });
});
