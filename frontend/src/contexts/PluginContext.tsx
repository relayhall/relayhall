import { createContext, useContext, useEffect, useState, useCallback, ReactNode, useRef } from 'react';
import { authenticatedFetch } from '../utils/auth';
import { PluginInfo, PluginNavItem, PluginsResponse, PluginRoute } from '../types/plugin';
import { isIntentionalAbort, markDocumentAlive } from '../utils/fetchAbort';

const API_BASE = import.meta.env.VITE_API_BASE_URL || '/api';
const REFRESH_INTERVAL_MS = 60000; // 60 seconds

interface PluginContextType {
  /** All loaded plugins */
  plugins: PluginInfo[];
  /** Merged sidebar items from all healthy plugins */
  pluginSidebarItems: PluginNavItem[];
  /** All routes from all healthy plugins, with plugin metadata */
  pluginRoutes: Array<PluginRoute & { pluginName: string }>;
  /** Whether plugins are currently loading */
  loading: boolean;
  /** Error if plugin loading failed */
  error: Error | null;
  /** Manually refresh plugins */
  refresh: () => Promise<void>;
}

const PluginContext = createContext<PluginContextType>({
  plugins: [],
  pluginSidebarItems: [],
  pluginRoutes: [],
  loading: true,
  error: null,
  refresh: async () => {},
});

/**
 * Hook to access plugin data
 */
export function usePlugins() {
  return useContext(PluginContext);
}

interface PluginProviderProps {
  children: ReactNode;
}

/**
 * Plugin provider that fetches and manages plugin data
 *
 * Polls the /api/plugins endpoint every 60 seconds to detect
 * plugin health changes and new plugins.
 */
export function PluginProvider({ children }: PluginProviderProps) {
  const [plugins, setPlugins] = useState<PluginInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);
  const lastPluginsSnapshotRef = useRef<string>('[]');
  // The provider is mounted. Guards the writes on the success path, which the
  // AbortController cannot reach once a response has already arrived.
  const activeRef = useRef(true);

  /**
   * How a fetch ended, when the CALLER has to behave differently (card
   * 85014317). `'refused'` means the board answered "not for you", which is a
   * decision about this session and not a transient zero to retry; every other
   * ending is `undefined` and the caller treats them alike.
   */
  type PluginFetchOutcome = 'refused' | undefined;

  // Fetch plugins from API
  const fetchPlugins = useCallback(async (signal?: AbortSignal): Promise<PluginFetchOutcome> => {
    try {
      const response = await authenticatedFetch(`${API_BASE}/plugins`, signal ? { signal } : {});

      // A REFUSAL IS AN ANSWER, NOT A FAILURE (card 85014317).
      //
      // The registry sits behind an administrator scope, so every non-admin
      // Account is refused here — correctly. Treating that as an error put a
      // red pair in the console on every page load, three or more times per
      // navigation, for every ordinary beta user: exactly the noise that makes
      // a real error unfindable in a bug report. What the refusal MEANS is
      // "there are no plugin routes for you", which is an empty list, and it is
      // recorded as one rather than left to the caller to infer from a thrown
      // Error. Neither the gate nor the route changes: the board remains the
      // authority on who may read the registry, and this only stops the client
      // shouting about being told.
      if (response.status === 401 || response.status === 403) {
        markDocumentAlive();
        if (!activeRef.current) return undefined;
        if (lastPluginsSnapshotRef.current !== '[]') {
          lastPluginsSnapshotRef.current = '[]';
          setPlugins([]);
        }
        setError(prev => (prev ? null : prev));
        setLoading(false);
        return 'refused';
      }

      if (!response.ok) {
        throw new Error(`Failed to fetch plugins: ${response.status}`);
      }

      const data: PluginsResponse = await response.json();
      // A response we actually read proves the document is alive, whatever
      // `pagehide` claimed (see utils/fetchAbort).
      markDocumentAlive();
      const nextPlugins = data.plugins || [];
      const nextSnapshot = JSON.stringify(nextPlugins);
      if (!activeRef.current) return;
      console.log('Plugins loaded:', nextPlugins.length, nextPlugins.map(p => p.name));

      if (nextSnapshot !== lastPluginsSnapshotRef.current) {
        lastPluginsSnapshotRef.current = nextSnapshot;
        setPlugins(nextPlugins);
      }

      setError(prev => (prev ? null : prev));
    } catch (err) {
      // A deliberate abort is not a failure. Say nothing, change nothing, and
      // leave the last good plugin list on screen: the poll that follows the
      // navigation is the one that matters.
      if (isIntentionalAbort(err, signal)) return;
      if (!activeRef.current) return;
      console.error('Error fetching plugins:', err);
      setError(err instanceof Error ? err : new Error('Failed to fetch plugins'));
      // Don't clear existing plugins on error - keep showing what we had
    }
    setLoading(false);
  }, []);

  // Initial fetch and polling
  useEffect(() => {
    activeRef.current = true;
    const controller = new AbortController();
    let retryTimeout: ReturnType<typeof setTimeout> | null = null;

    const initialFetch = async () => {
      const outcome = await fetchPlugins(controller.signal);
      // If initial fetch returned 0 plugins, retry once after 3s (backend may still be
      // initializing the plugin loader when the first request arrives on startup).
      //
      // Except when the board REFUSED us (card 85014317). That zero is a
      // decision about this session's authority, not a startup race, and
      // retrying it is how one page load became three or more identical
      // refusals. The 60-second poll below deliberately continues: a role
      // change bites on the target's next request, so a promoted Account
      // should not have to reload the page to see the registry appear.
      if (outcome !== 'refused' && plugins.length === 0) {
        retryTimeout = setTimeout(() => fetchPlugins(controller.signal), 3000);
      }
    };

    initialFetch();

    // Set up polling interval
    const intervalId = setInterval(() => fetchPlugins(controller.signal), REFRESH_INTERVAL_MS);

    return () => {
      activeRef.current = false;
      clearInterval(intervalId);
      if (retryTimeout) clearTimeout(retryTimeout);
      controller.abort();
    };
  }, [fetchPlugins]); // eslint-disable-line react-hooks/exhaustive-deps

  // Wrapped rather than passed through: `fetchPlugins` takes an AbortSignal in
  // its first parameter, so a future `onClick={refresh}` would otherwise hand
  // it a MouseEvent and every manual refresh would throw.
  // The `void` is not decoration: the context's `refresh` promises nothing back
  // (`() => Promise<void>`), while `fetchPlugins` now reports whether the board
  // refused. A manual refresh has nobody to report that to, so the value is
  // dropped here deliberately rather than by widening the published contract.
  const refresh = useCallback(async () => { await fetchPlugins(); }, [fetchPlugins]);

  // Derive sidebar items from healthy plugins
  const pluginSidebarItems: PluginNavItem[] = plugins
    .filter(plugin => plugin.sidebar.length > 0)
    .flatMap(plugin =>
      plugin.sidebar.map(item => ({
        ...item,
        pluginName: plugin.name,
        healthy: plugin.healthy,
      }))
    );

  // Derive routes from healthy plugins
  const pluginRoutes = plugins
    .filter(plugin => plugin.routes.length > 0)
    .flatMap(plugin =>
      plugin.routes.map(route => ({
        ...route,
        pluginName: plugin.name,
      }))
    );

  const value: PluginContextType = {
    plugins,
    pluginSidebarItems,
    pluginRoutes,
    loading,
    error,
    refresh,
  };

  return (
    <PluginContext.Provider value={value}>
      {children}
    </PluginContext.Provider>
  );
}
