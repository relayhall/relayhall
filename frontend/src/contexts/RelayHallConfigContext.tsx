import { createContext, useContext, useEffect, useState, ReactNode } from 'react';
import { setDeploymentAccentOverride } from '../utils/theme';
import { RelayHallPublicConfig, DEFAULT_CONFIG, fetchConfig } from '../config/relayhall';

interface RelayHallConfigContextType {
  config: RelayHallPublicConfig;
  loading: boolean;
  error: Error | null;
}

const RelayHallConfigContext = createContext<RelayHallConfigContextType>({
  config: DEFAULT_CONFIG,
  loading: true,
  error: null,
});

export function useRelayHallConfig() {
  return useContext(RelayHallConfigContext);
}

interface RelayHallConfigProviderProps {
  children: ReactNode;
}

export function RelayHallConfigProvider({ children }: RelayHallConfigProviderProps) {
  const [config, setConfig] = useState<RelayHallPublicConfig>(DEFAULT_CONFIG);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);

  useEffect(() => {
    async function loadConfig() {
      try {
        const fetchedConfig = await fetchConfig();
        setConfig(fetchedConfig);
        
        // Only an EXPLICIT deployment accent override reaches CSS, and it is
        // theme-aware (68b1e12f): applyTheme keeps it OUT of high-contrast,
        // whose accent is part of that Theme's contrast contract. null means
        // the Theme's own accent rules.
        if (typeof fetchedConfig.accentColor === 'string' && fetchedConfig.accentColor.startsWith('#')) {
          setDeploymentAccentOverride(fetchedConfig.accentColor);
        }
        
        setLoading(false);
      } catch (err) {
        console.error('Error loading config:', err);
        setError(err instanceof Error ? err : new Error('Unknown error'));
        setLoading(false);
      }
    }

    loadConfig();
  }, []);

  return (
    <RelayHallConfigContext.Provider value={{ config, loading, error }}>
      {children}
    </RelayHallConfigContext.Provider>
  );
}
