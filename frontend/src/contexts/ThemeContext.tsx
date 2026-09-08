/**
 * The theme engine, mounted (RH-DESIGN.6 §5.5, task 07113036).
 *
 * Responsibilities, and deliberately no more:
 *   - resolve the chain (principal -> deployment -> relay-dark) and write
 *     `data-theme` on the document element;
 *   - keep the boot cache in step, so the FOUC guard resolves the same Theme
 *     on the next load without waiting for a fetch;
 *   - re-resolve when the operating system's colour scheme changes and the
 *     principal chose `system`;
 *   - apply the motion preference.
 *
 * The preferences fetch is best-effort. A deployment where the request fails
 * (offline, mid-deploy, a principal-less credential) still renders in the
 * cached or default Theme rather than blocking the app on a display setting.
 */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  ReactNode,
} from 'react';
import {
  BuiltInTheme,
  DEFAULT_PREFERENCES,
  PrincipalPreferences,
  applyReducedMotion,
  applyTheme,
  isBuiltInTheme,
  readCachedPreferences,
  resolveTheme,
  systemPrefersLight,
  writeCachedPreferences,
} from '../utils/theme';
import { fetchPreferences, savePreferences } from '../utils/preferences';
import { auth } from '../utils/auth';

interface ThemeContextValue {
  /** The principal's stored preferences (defaults until they load). */
  preferences: PrincipalPreferences;
  /** The Theme actually applied to the document right now. */
  resolvedTheme: BuiltInTheme;
  /** True until the first preferences fetch settles. */
  loading: boolean;
  /** Persist a change and apply it immediately. Throws on a rejected value. */
  updatePreferences: (patch: Partial<PrincipalPreferences>) => Promise<void>;
}

const ThemeContext = createContext<ThemeContextValue>({
  preferences: DEFAULT_PREFERENCES,
  resolvedTheme: 'relay-dark',
  loading: true,
  updatePreferences: async () => undefined,
});

export function useTheme(): ThemeContextValue {
  return useContext(ThemeContext);
}

interface ThemeProviderProps {
  children: ReactNode;
  /**
   * The deployment's default Theme — the middle link of the chain. Appearance
   * (RH-UI.4) is its source; until then it is unset and the chain runs
   * principal -> relay-dark, which is the same code path.
   */
  deploymentTheme?: string | null;
  /** Uploaded Appearance favicon. When set it supersedes built-in variants. */
  deploymentFavicon?: string | null;
  /**
   * Whether a principal is authenticated RIGHT NOW. This is a prop and not a
   * call to `auth.isAuthenticated()` because logging in does not reload the
   * document: `App` swaps the login page for the shell by changing state, the
   * provider stays mounted, and a one-shot effect reading the token at mount
   * would never learn that anyone signed in. That defect shipped in the first
   * RH-UI.2 candidate — a principal's stored Theme only appeared after a
   * manual reload (review 241ce388 F1). Authentication is a value that
   * changes, so it is modelled as one.
   */
  authenticated?: boolean;
}

export function ThemeProvider({
  children,
  deploymentTheme = null,
  deploymentFavicon = null,
  authenticated,
}: ThemeProviderProps) {
  const cached = useRef(readCachedPreferences()).current;
  const [preferences, setPreferences] = useState<PrincipalPreferences>({
    theme: cached.theme,
    reducedMotion: cached.reducedMotion,
  });
  const [loading, setLoading] = useState(true);
  const [prefersLight, setPrefersLight] = useState(systemPrefersLight);

  const deploymentDefault = isBuiltInTheme(deploymentTheme) ? deploymentTheme : cached.deploymentTheme;

  const resolvedTheme = useMemo(
    () => resolveTheme({ preference: preferences.theme, deploymentDefault, prefersLight }),
    [preferences.theme, deploymentDefault, prefersLight]
  );

  // Apply. The boot snippet has already done this for the first paint; doing
  // it again is idempotent and covers every later change.
  useEffect(() => { applyTheme(resolvedTheme); }, [resolvedTheme]);
  useEffect(() => {
    if (!deploymentFavicon || typeof document === 'undefined') return;
    const link = document.querySelector<HTMLLinkElement>('link[rel="icon"]');
    if (link) link.href = deploymentFavicon;
  }, [resolvedTheme, deploymentFavicon]);
  useEffect(() => { applyReducedMotion(preferences.reducedMotion); }, [preferences.reducedMotion]);

  // Keep the boot cache current, so the next load resolves without a fetch.
  useEffect(() => {
    writeCachedPreferences({ ...preferences, deploymentTheme: deploymentDefault });
  }, [preferences, deploymentDefault]);

  // Follow the operating system while the preference is `system`. The listener
  // is always attached: the preference can change without a remount, and a
  // media-query listener is cheaper than the bookkeeping to attach it lazily.
  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;
    const query = window.matchMedia('(prefers-color-scheme: light)');
    const onChange = (event: MediaQueryListEvent) => setPrefersLight(event.matches);
    // Safari < 14 has no addEventListener on MediaQueryList.
    if (typeof query.addEventListener === 'function') {
      query.addEventListener('change', onChange);
      return () => query.removeEventListener('change', onChange);
    }
    query.addListener(onChange);
    return () => query.removeListener(onChange);
  }, []);

  // `authenticated` unset means "ask the token store" — the provider is usable
  // on its own, and callers that know (App does) pass the live value.
  const signedIn = authenticated ?? auth.isAuthenticated();

  // One fetch per authentication transition. Keyed on `signedIn`, so signing in
  // without a reload loads the newly authenticated principal's row.
  useEffect(() => {
    let cancelled = false;
    if (!signedIn) {
      setLoading(false);
      return () => { cancelled = true; };
    }
    setLoading(true);
    fetchPreferences()
      .then((loaded) => { if (!cancelled) setPreferences(loaded); })
      .catch(() => undefined)
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [signedIn]);

  const updatePreferences = useCallback(async (patch: Partial<PrincipalPreferences>) => {
    const saved = await savePreferences(patch);
    setPreferences(saved);
  }, []);

  const value = useMemo(
    () => ({ preferences, resolvedTheme, loading, updatePreferences }),
    [preferences, resolvedTheme, loading, updatePreferences]
  );

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}
