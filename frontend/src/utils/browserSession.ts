import { useEffect, useState } from 'react';
import { authenticatedFetch } from './auth';

const API_BASE = import.meta.env.VITE_API_BASE_URL || '/api';

/**
 * Plugin frames and dashboard media require a capability cookie because an
 * <iframe src> or <img src> cannot carry an Authorization header. Login issues it, but a session that
 * authenticated before the cookie existed still holds a valid JWT and no
 * cookie — so ask for one before rendering any plugin frame or dashboard image.
 *
 * Cached at module scope: many frames mount, one request.
 */
let pending: Promise<void> | null = null;

export function ensureBrowserSession(): Promise<void> {
  if (!pending) {
    pending = authenticatedFetch(`${API_BASE}/auth/browser-session`, { method: 'POST' })
      .then(() => undefined)
      .catch(() => {
        // Let the next mount retry rather than caching a failure forever.
        pending = null;
      });
  }
  return pending;
}

/** Resolves once the browser capability cookie has been requested. */
export function useBrowserSession(): boolean {
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let active = true;
    ensureBrowserSession().then(() => {
      if (active) setReady(true);
    });
    return () => {
      active = false;
    };
  }, []);

  return ready;
}
