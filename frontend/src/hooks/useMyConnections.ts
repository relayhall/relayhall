import { useCallback, useEffect, useRef, useState } from 'react';
import { authenticatedFetch } from '../utils/auth';
import type { BootstrapInstructions, Connection } from '../types/connections';

const API_BASE = import.meta.env.VITE_API_BASE_URL || '/api';

/**
 * The caller's OWN Connector chain (card 653be44f; owner record 99d6b0ad §3.1).
 *
 * One read, `GET /principals/me/connectors`, which is own-chain by construction
 * — there is no id to pass, so this hook cannot be pointed at anyone else.
 *
 * The three outcomes are kept apart on purpose, the way `usePrincipals` learned
 * to keep them apart: `unavailable` is the pre-migration 503 (a valid state
 * with no retry), `failed` is an ordinary failure (retryable), and an empty
 * `connections` array is the real, meaningful EMPTY STATE the day-one card
 * hangs off. Collapsing any two of them would either hide the card from a
 * person who has no connection or show it to someone whose lookup merely broke.
 */
export function useMyConnections() {
  const [connections, setConnections] = useState<Connection[]>([]);
  const [instructions, setInstructions] = useState<BootstrapInstructions | null>(null);
  const [loading, setLoading] = useState(true);
  const [unavailable, setUnavailable] = useState(false);
  const [failed, setFailed] = useState(false);
  const mounted = useRef(true);
  const requestSeq = useRef(0);

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  const load = useCallback(async () => {
    const seq = ++requestSeq.current;
    const settle = (next: {
      connections?: Connection[];
      instructions?: BootstrapInstructions | null;
      unavailable: boolean;
      failed: boolean;
    }) => {
      if (!mounted.current || seq !== requestSeq.current) return;
      if (next.connections) setConnections(next.connections);
      if (next.instructions !== undefined) setInstructions(next.instructions);
      setUnavailable(next.unavailable);
      setFailed(next.failed);
    };

    try {
      const response = await authenticatedFetch(`${API_BASE}/principals/me/connectors`);
      if (response.status === 503) {
        settle({ connections: [], instructions: null, unavailable: true, failed: false });
        return;
      }
      // 404 is the documented answer for a session with no principal row. It is
      // not an error and it is not an empty chain either: a page must not offer
      // to create a connection for an identity the board cannot resolve.
      if (!response.ok) {
        settle({ connections: [], instructions: null, unavailable: false, failed: true });
        return;
      }
      const data = await response.json();
      settle({
        connections: Array.isArray(data?.connectors) ? data.connectors : [],
        instructions: data?.instructions ?? null,
        unavailable: false,
        failed: false,
      });
    } catch {
      settle({ connections: [], instructions: null, unavailable: false, failed: true });
    } finally {
      if (mounted.current && seq === requestSeq.current) setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  return { connections, instructions, loading, unavailable, failed, reload: load };
}
