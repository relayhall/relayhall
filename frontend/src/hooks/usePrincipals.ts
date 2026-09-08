import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { authenticatedFetch } from '../utils/auth';
import type { Principal } from '../types/task';
import type { SettingsSurfaceVisibility } from '../config/settingsNavigation';

const API_BASE = import.meta.env.VITE_API_BASE_URL || '/api';

interface PrincipalsResponse {
  success?: boolean;
  principals?: Principal[];
}

/**
 * Principal directory for attribution surfaces (card 60558599).
 *
 * The whole set is small and bounded (seeds + one row per spawned task), so a
 * single fetch and an id/handle index beats per-card lookups. Every consumer
 * must tolerate an empty map: `/principals` answers 503 until migrations
 * 062/063 apply, and the board has to render exactly as it did before
 * identity existed rather than showing an error.
 */
export function usePrincipals() {
  const [principals, setPrincipals] = useState<Principal[]>([]);
  const [loading, setLoading] = useState(true);
  /** True when the substrate is not available (pre-migration) — not an error. */
  const [unavailable, setUnavailable] = useState(false);
  /** True when the lookup failed. Distinct from "the directory is empty". */
  const [failed, setFailed] = useState(false);
  const mounted = useRef(true);
  /** Generation counter: only the newest request may write state, so a slow
   *  failure landing after a fast success cannot wipe a loaded directory. */
  const requestSeq = useRef(0);

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  const load = useCallback(async () => {
    const seq = ++requestSeq.current;
    // Each outcome sets ALL three flags. Leaving one stale is how `unavailable`
    // (which renders a "not migrated" message with no retry) ended up masking a
    // later ordinary failure.
    const settle = (next: { principals?: Principal[]; unavailable: boolean; failed: boolean }) => {
      if (!mounted.current || seq !== requestSeq.current) return false;
      if (next.principals) setPrincipals(next.principals);
      setUnavailable(next.unavailable);
      setFailed(next.failed);
      return true;
    };

    try {
      const res = await authenticatedFetch(`${API_BASE}/principals`);
      if (res.status === 503) {
        settle({ principals: [], unavailable: true, failed: false });
        return;
      }
      if (!res.ok) {
        settle({ unavailable: false, failed: true });
        return;
      }
      const data: PrincipalsResponse = await res.json();
      settle({
        principals: Array.isArray(data.principals) ? data.principals : [],
        unavailable: false,
        failed: false,
      });
    } catch {
      // Attribution is decoration: a failed lookup must never break the board.
      // But it must not masquerade as an empty directory either.
      settle({ principals: [], unavailable: false, failed: true });
    } finally {
      if (mounted.current && seq === requestSeq.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const byId = useMemo(() => {
    const map = new Map<string, Principal>();
    for (const p of principals) map.set(p.id, p);
    return map;
  }, [principals]);

  const byHandle = useMemo(() => {
    const map = new Map<string, Principal>();
    for (const p of principals) map.set(p.handle, p);
    return map;
  }, [principals]);

  return { principals, byId, byHandle, loading, unavailable, failed, reload: load };
}

/** The caller's own principal, or null while unresolved / pre-migration. */
export function useMyPrincipal() {
  const [me, setMe] = useState<Principal | null>(null);
  const [scopes, setScopes] = useState<string[] | null | undefined>(undefined);
  /**
   * What this session may hand to a bearer credential — the server's answer
   * (`GET /principals/me` -> `delegableScopes`, card 6e25ae48), never derived
   * here. `undefined` means the field has not been read yet; `null` means the
   * board answered without one, which is the shape an older board returns and
   * which every caller must handle rather than treating as an empty set.
   */
  const [delegable, setDelegable] = useState<string[] | null | undefined>(undefined);
  /**
   * WHICH SETTINGS NAVIGATION ENTRIES THIS SESSION MAY SEE — the server's
   * answer (`GET /principals/me` -> `settingsSurfaces`, card d0f030a9),
   * computed by the Access-surface arm itself and never derived here. Same
   * contract as `delegableScopes` above: `undefined` until read, `null` when
   * the board answered without one, which is what an older board and a board
   * whose catalogue read failed both return — and which the shell must handle
   * by falling back rather than by treating as an empty set.
   */
  const [settingsSurfaces, setSettingsSurfaces] = useState<SettingsSurfaceVisibility[] | null | undefined>(undefined);
  const [loading, setLoading] = useState(true);

  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const pending = useRef(true);
  const reload = useCallback(() => {
    if (pending.current) return;
    pending.current = true;
    setLoading(true);
    setFailed(false);
    setMe(null);
    setScopes(undefined);
    setDelegable(undefined);
    setSettingsSurfaces(undefined);
    setAttempt(value => value + 1);
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await authenticatedFetch(`${API_BASE}/principals/me`);
        // 404 is the documented answer for an identity with no principal row
        // (legacy JWT, or pre-migration) — a valid state, not a failure.
        if (res.status === 404) return;
        if (!res.ok) throw new Error('Principal lookup failed');
        const data = await res.json();
        if (!cancelled && data?.principal) {
          setMe(data.principal);
          setScopes(Array.isArray(data.scopes) ? data.scopes : null);
          setDelegable(Array.isArray(data.delegableScopes) ? data.delegableScopes : null);
          setSettingsSurfaces(
            Array.isArray(data.settingsSurfaces)
              ? (data.settingsSurfaces as SettingsSurfaceVisibility[])
              : null,
          );
        }
      } catch {
        if (!cancelled) setFailed(true);
      } finally {
        if (!cancelled) {
          pending.current = false;
          setLoading(false);
        }
      }
    })();
    return () => { cancelled = true; };
  }, [attempt]);

  return { me, scopes, delegableScopes: delegable, settingsSurfaces, loading, failed, reload };
}
