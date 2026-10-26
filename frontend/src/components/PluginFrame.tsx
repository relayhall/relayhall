import { useState, useRef, useEffect, useCallback } from 'react';
import { AlertTriangle, RefreshCw, Loader2 } from 'lucide-react';
import { usePlugins } from '../contexts/PluginContext';
import { attachOrbStatusForwarder } from '../utils/orbStatus';
import { attachPluginBridge, trustedPluginMessage } from '../utils/pluginBridge';
import './PluginFrame.css';
import { useBrowserSession } from '../utils/browserSession';

interface PluginFrameProps {
  /** Plugin name (e.g., "claw-journal") */
  pluginName: string;
  /** Plugin's internal proxy path (e.g., "/ui/") */
  proxyPath: string;
  /** API base URL */
  apiBase: string;
  /**
   * WHICH SURFACE THIS FRAME IS. Required, and deliberately not defaulted: the
   * host reserves space for its own floating mobile chrome on the frame that IS
   * the route's page, and that reservation is a hole in the page anywhere else.
   * A new call site that has not decided does not compile.
   */
  surface: PluginFrameSurface;
}

/**
 * `route` — this frame is the whole page behind a plugin's route (App.tsx).
 * `embedded` — this frame sits inside a page the host lays out, such as the
 * plugin settings hub, which reserves nothing because nothing floats over it.
 */
export type PluginFrameSurface = 'route' | 'embedded';

/**
 * PluginFrame renders a plugin's UI in an iframe
 * 
 * The iframe loads from the backend's plugin proxy:
 * {API_BASE}/plugins/{pluginName}/ui{proxyPath}
 * 
 * The backend proxies this request to the plugin's container.
 */
export function PluginFrame({ pluginName, proxyPath, apiBase, surface }: PluginFrameProps) {
  const { plugins } = usePlugins();
  // The modifier carries the mobile-chrome band (PluginFrame.css). Only the
  // route surface opts in; the shared class carries no geometry of its own.
  const containerClass = surface === 'route'
    ? 'plugin-frame-container plugin-frame-container--route'
    : 'plugin-frame-container';
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [, setIframeHeight] = useState<number | null>(null);
  const browserSessionReady = useBrowserSession();
  const iframeRef = useRef<HTMLIFrameElement | null>(null);

  // Find this plugin to check health status
  const plugin = plugins.find(p => p.name === pluginName);
  const isHealthy = plugin?.healthy ?? false;

  // Build the iframe URL
  // Consume the host-compiled namespace; the client must not normalize names.
  const iframeSrc = `${apiBase}${plugin?.api_base ?? ""}${proxyPath}`;

  // Reset loading/error state when URL changes
  useEffect(() => {
    setLoading(true);
    setError(null);
    setIframeHeight(null);
  }, [iframeSrc]);

  // Live status feed for the identity-widget (orb) plugin only (other plugins get neither the
  // messages nor the re-renders — the bus bypasses the memoized route tree).
  // Keyed off the iframe element itself via a callback ref: the unhealthy and
  // error branches unmount the iframe, so an effect keyed on props alone would
  // hold a detached node and silently stop feeding the orb after a recovery.
  const orbForwarderRef = useRef<(() => void) | null>(null);
  const attachIframe = useCallback((node: HTMLIFrameElement | null) => {
    iframeRef.current = node;
    orbForwarderRef.current?.();
    orbForwarderRef.current = null;
    if (node && plugin?.schema_version === 'rh.plugin/1') {
      orbForwarderRef.current = attachPluginBridge(node,pluginName,apiBase);
    } else if (node && pluginName === 'nim-orb') {
      orbForwarderRef.current = attachOrbStatusForwarder(node);
    }
  }, [pluginName,plugin?.schema_version,apiBase]);

  useEffect(() => () => {
    orbForwarderRef.current?.();
    orbForwarderRef.current = null;
  }, []);

  // Auto-resize iframe to its content height (mobile scrollability fix).
  // Uses two complementary mechanisms:
  //   1. Direct DOM polling via setInterval (same-origin access, reliable)
  //   2. postMessage listener (for plugins that send iframeResize events)
  useEffect(() => {
    // postMessage listener (kept for any plugin that sends it)
    const msgHandler = (e: MessageEvent) => {
      if (iframeRef.current && trustedPluginMessage(e,iframeRef.current) && e.data?.type === 'iframeResize' && Number.isFinite(e.data.height) && e.data.height >= 48 && e.data.height <= 4096) {
        setIframeHeight(h => Math.max(h ?? 0, e.data.height));
      }
    };
    window.addEventListener('message', msgHandler);

    // Direct DOM polling — reads iframe content scrollHeight directly.
    // Runs every 500ms, stops once height is stable for 4 cycles (~2s).
    let stableCount = 0;
    let lastHeight = 0;
    const poll = setInterval(() => {
      try {
        const body = iframeRef.current?.contentDocument?.body;
        if (!body) return;
        const h = body.scrollHeight;
        if (h > 0) {
          setIframeHeight(prev => Math.max(prev ?? 0, h));
          if (h === lastHeight) {
            stableCount++;
            if (stableCount >= 4) clearInterval(poll);
          } else {
            lastHeight = h;
            stableCount = 0;
          }
        }
      } catch {
        // Cross-origin iframe — stop polling
        clearInterval(poll);
      }
    }, 500);

    return () => {
      window.removeEventListener('message', msgHandler);
      clearInterval(poll);
    };
  }, [iframeSrc]);

  const handleLoad = () => {
    setLoading(false);
    setError(null);
  };

  const handleError = () => {
    setLoading(false);
    setError('Failed to load plugin UI');
  };

  const handleReload = () => {
    if (iframeRef.current) {
      setLoading(true);
      setError(null);
      iframeRef.current.src = iframeSrc;
    }
  };

  // Show unhealthy warning
  if (!isHealthy && plugin) {
    return (
      <div className={containerClass}>
        <div className="plugin-frame-error">
          <AlertTriangle size={48} className="error-icon" />
          <h2>Plugin unavailable</h2>
          <p>
            The <strong>{plugin.name}</strong> plugin is currently unhealthy.
          </p>
          <p className="error-hint">
            Check that the plugin container is running and healthy.
          </p>
          <button className="plugin-reload-button" onClick={handleReload}>
            <RefreshCw size={16} />
            Retry
          </button>
        </div>
      </div>
    );
  }

  // The proxy rejects the iframe without the capability cookie, so wait for it.
  if (!browserSessionReady) {
    return (
      <div className={containerClass}>
        <div className="plugin-frame-loading">
          <div className="plugin-frame-spinner" />
        </div>
      </div>
    );
  }

  return (
    <div className={containerClass}>
      {/* Loading overlay */}
      {loading && (
        <div className="plugin-frame-loading">
          <Loader2 size={32} className="loading-spinner plugin-frame-loading-spinner" />
          <span>Loading plugin...</span>
        </div>
      )}

      {/* Error state */}
      {error && (
        <div className="plugin-frame-error">
          <AlertTriangle size={48} className="error-icon" />
          <h2>Failed to Load Plugin</h2>
          <p>{error}</p>
          <button className="plugin-reload-button" onClick={handleReload}>
            <RefreshCw size={16} />
            Retry
          </button>
        </div>
      )}

      {/* Plugin iframe */}
      <iframe
        ref={attachIframe}
        src={iframeSrc}
        className={`plugin-iframe ${loading ? 'loading' : ''} ${error ? 'hidden' : ''}`}
        title={`${pluginName} plugin`}
        onLoad={handleLoad}
        onError={handleError}
        sandbox="allow-same-origin allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox"
        style={{ height: '100%' }}
      />
    </div>
  );
}
