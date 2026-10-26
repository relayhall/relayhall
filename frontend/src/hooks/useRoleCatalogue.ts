import { useEffect, useState } from 'react';
import { authenticatedFetch } from '../utils/auth';
import type { RoleCatalogueEntry } from '../types/roleCatalogue';

const API_BASE = import.meta.env.VITE_API_BASE_URL || '/api';

export type RoleCatalogueState =
  | { state: 'loading'; roles: null }
  | { state: 'ready'; roles: RoleCatalogueEntry[] }
  | { state: 'failed'; roles: null };

function isEntry(value: unknown): value is RoleCatalogueEntry {
  const row = value as Partial<RoleCatalogueEntry> | null;
  return Boolean(row) && typeof row!.role === 'string' && typeof row!.purpose === 'string'
    && typeof row!.mayReach === 'string' && typeof row!.neverReaches === 'string'
    && typeof row!.meantForText === 'string' && Array.isArray(row!.meantFor);
}

/**
 * The role catalogue (card a2d1e317), read once per mount from
 * `GET /principals/roles`. Every role explanation on the dashboard renders
 * from this one answer; a failed read says so rather than inventing text.
 *
 * `enabled: false` defers the read until a surface actually shows a role
 * selector (Create identity's Agent arm, and My connections, never do).
 */
export function useRoleCatalogue(enabled = true): RoleCatalogueState {
  const [result, setResult] = useState<RoleCatalogueState>({ state: 'loading', roles: null });
  const settled = result.state !== 'loading';

  useEffect(() => {
    if (!enabled || settled) return undefined;
    let live = true;
    (async () => {
      try {
        const response = await authenticatedFetch(`${API_BASE}/principals/roles`);
        const data = response && response.ok ? await response.json() : null;
        const roles = Array.isArray(data?.roles) && data.roles.every(isEntry) ? data.roles as RoleCatalogueEntry[] : null;
        if (live) setResult(roles && roles.length > 0 ? { state: 'ready', roles } : { state: 'failed', roles: null });
      } catch {
        if (live) setResult({ state: 'failed', roles: null });
      }
    })();
    return () => { live = false; };
  }, [enabled, settled]);

  return result;
}

/** The entry for one role, when the catalogue has it. */
export function catalogueEntry(catalogue: RoleCatalogueState, role: string | null | undefined): RoleCatalogueEntry | null {
  if (catalogue.state !== 'ready' || !role) return null;
  return catalogue.roles.find((entry) => entry.role === role) ?? null;
}
