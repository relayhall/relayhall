// @vitest-environment jsdom
/**
 * Regression suite for review 241ce388 F1 (RH-UI.2).
 *
 * Signing in does NOT reload the document — `App` swaps the login page for the
 * shell by changing state, and the ThemeProvider stays mounted throughout. The
 * first candidate fetched preferences in a `[]` effect, so a principal who
 * signed in normally never had their stored Theme loaded until they reloaded
 * by hand. These tests hold the authentication transition, because it is the
 * path every real login takes and no gate was watching it.
 */
import { render, screen, waitFor, cleanup } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import '@testing-library/jest-dom/vitest';

import { ThemeProvider, useTheme } from './ThemeContext';
import { fetchPreferences } from '../utils/preferences';
import { auth } from '../utils/auth';
import { preferencesCacheKey, writeCachedPreferences } from '../utils/theme';

vi.mock('../utils/preferences', () => ({
  fetchPreferences: vi.fn(),
  savePreferences: vi.fn(),
}));

const mockFetch = vi.mocked(fetchPreferences);

function Probe() {
  const { resolvedTheme, loading } = useTheme();
  return <span data-testid="probe">{loading ? 'loading' : resolvedTheme}</span>;
}

/** The shape App renders: one provider, children swapped on the auth flag. */
function App({ authenticated }: { authenticated: boolean }) {
  return (
    <ThemeProvider authenticated={authenticated}>
      {authenticated ? <Probe /> : <span data-testid="probe">login</span>}
    </ThemeProvider>
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  document.documentElement.removeAttribute('data-theme');
  document.documentElement.removeAttribute('data-reduced-motion');
  mockFetch.mockResolvedValue({ theme: 'relay-light', reducedMotion: 'reduce' });
});
afterEach(cleanup);

describe('the authentication transition', () => {
  test('fetches nothing while signed out', async () => {
    render(<App authenticated={false} />);
    await waitFor(() => expect(screen.getByTestId('probe')).toHaveTextContent('login'));
    expect(mockFetch).not.toHaveBeenCalled();
    expect(document.documentElement.getAttribute('data-theme')).toBe('relay-dark');
  });

  test('loads and applies the principal\'s row when they sign in, without a reload', async () => {
    const { rerender } = render(<App authenticated={false} />);
    await waitFor(() => expect(screen.getByTestId('probe')).toHaveTextContent('login'));

    // The login callback flips the flag. The provider is NOT remounted.
    rerender(<App authenticated />);

    await waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(1));
    await waitFor(() =>
      expect(document.documentElement.getAttribute('data-theme')).toBe('relay-light'));
    expect(document.documentElement.getAttribute('data-reduced-motion')).toBe('reduce');
  });

  test('fetches exactly once per transition, not once per render', async () => {
    const { rerender } = render(<App authenticated={false} />);
    rerender(<App authenticated />);
    await waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(1));
    rerender(<App authenticated />);
    rerender(<App authenticated />);
    await waitFor(() =>
      expect(document.documentElement.getAttribute('data-theme')).toBe('relay-light'));
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  test('a cached Theme is a first paint, never the authenticated answer', async () => {
    // The boot cache exists to avoid a flash. It must not decide what the
    // signed-in principal sees: the fetched row always wins.
    writeCachedPreferences({
      theme: 'high-contrast', reducedMotion: 'system', deploymentTheme: null,
    });
    render(<App authenticated />);
    await waitFor(() =>
      expect(document.documentElement.getAttribute('data-theme')).toBe('relay-light'));
  });

  test('signing out drops the cache, so the next principal never inherits it', () => {
    // The cache is keyed by ORIGIN, not by principal. Left behind, it would
    // show the next person to sign in on this browser the previous person's
    // Theme until their own row arrived.
    writeCachedPreferences({
      theme: 'high-contrast', reducedMotion: 'reduce', deploymentTheme: null,
    });
    expect(localStorage.getItem(preferencesCacheKey())).not.toBeNull();
    auth.clearToken();
    expect(localStorage.getItem(preferencesCacheKey())).toBeNull();
  });

  test('a failed fetch leaves the app usable in a real Theme', async () => {
    mockFetch.mockRejectedValueOnce(new Error('offline'));
    render(<App authenticated />);
    await waitFor(() => expect(screen.getByTestId('probe')).not.toHaveTextContent('loading'));
    expect(document.documentElement.getAttribute('data-theme')).toBe('relay-dark');
  });
});
