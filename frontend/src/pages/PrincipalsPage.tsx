import React, { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { Users, RefreshCw, Search, Plus, X } from 'lucide-react';
import { usePrincipals, useMyPrincipal } from '../hooks/usePrincipals';
import { PrincipalAvatar } from '../components/PrincipalAvatar';
import { Button } from '../components/Button';
import { CreateIdentityWizard } from '../components/identity/CreateIdentityWizard';
import type { Principal, PrincipalKind } from '../types/task';
import { authenticatedFetch } from '../utils/auth';
import './PrincipalsPage.css';

const KIND_ORDER: PrincipalKind[] = ['human', 'service', 'agent'];
const API_BASE_URL = import.meta.env.VITE_API_BASE_URL || '/api';

/* Presentational mirror of the server rules in routes/principals.ts: the
   `system` principal backs internal writes and the owner (`dashboard_user`)
   must never be locked out, so both refuse disabling with a 400. Showing a
   live button that can only fail helps nobody. The server stays the gate. */
const PROTECTED_HANDLES: Record<string, string> = {
  system: 'The system principal backs internal writes and cannot be disabled.',
  dashboard_user: 'The owner principal cannot be disabled through the API.',
};

function formatLastSeen(value?: string | null): string {
  if (!value) return '—';
  const seen = new Date(value).getTime();
  if (Number.isNaN(seen)) return '—';
  const minutes = Math.floor((Date.now() - seen) / 60000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

/** Configured identity directory and bounded lifecycle controls. */
export const PrincipalsPage: React.FC = () => {
  const { principals, loading, unavailable, failed, reload } = usePrincipals();
  const { me } = useMyPrincipal();
  const [query, setQuery] = useState('');
  const [kindFilter, setKindFilter] = useState<PrincipalKind | 'all'>('all');
  const [showCreate, setShowCreate] = useState(false);
  const [togglingId, setTogglingId] = useState<string | null>(null);
  const [mutationError, setMutationError] = useState<string | null>(null);

  const togglePrincipal = async (principal: Principal) => {
    if (togglingId) return;
    setMutationError(null);
    setTogglingId(principal.id);
    const status = principal.status === 'active' ? 'disabled' : 'active';
    try {
      const response = await authenticatedFetch(`${API_BASE_URL}/principals/${principal.id}`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status }),
      });
      const data = await response.json();
      if (!response.ok || !data.success) { setMutationError(data.message || data.error || 'Failed to update principal'); return; }
      reload();
    } catch {
      setMutationError('Failed to connect to the RelayHall API');
    } finally {
      setTogglingId(null);
    }
  };

  const grouped = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const matches = principals.filter(p => {
      if (kindFilter !== 'all' && p.kind !== kindFilter) return false;
      if (!needle) return true;
      return (
        p.handle.toLowerCase().includes(needle) ||
        (p.displayName || '').toLowerCase().includes(needle) ||
        (p.role || '').toLowerCase().includes(needle)
      );
    });

    return KIND_ORDER.map(kind => ({
      kind,
      rows: matches
        .filter(p => p.kind === kind)
        .sort((a, b) => a.handle.localeCompare(b.handle)),
    })).filter(group => group.rows.length > 0);
  }, [principals, query, kindFilter]);

  const counts = useMemo(() => {
    const byKind = new Map<PrincipalKind, number>();
    for (const p of principals) byKind.set(p.kind, (byKind.get(p.kind) || 0) + 1);
    return byKind;
  }, [principals]);

  const filtersActive = Boolean(query.trim() || kindFilter !== 'all');

  return (
    <div className="principals-page">
      <div className="principals-header">
        <div className="principals-title">
          <Users size={20} />
          <h1>Principals</h1>
          <span className="principals-count">{principals.length}</span>
        </div>
        <div className="principals-header-actions">
          <Button variant="primary" icon={<Plus size={16} />} onClick={() => setShowCreate(value => !value)}>
            Create identity
          </Button>
          <button className="principals-refresh" onClick={reload} aria-label="Refresh principals">
            <RefreshCw size={16} />
          </button>
        </div>
      </div>

      <p className="principals-intro">
        People, agents and services RelayHall can attribute work to. <strong>Create identity</strong>
        {' '}makes any of the three in one flow — a colleague who signs in, a service that declares
        what it is for, or an agent connected to this board — and mints its credential in the same
        act when one is wanted. Your own agents are also listed, and connected, on{' '}
        <Link to="/settings/connections">My connections</Link>. Identities are disabled here;
        credentials remain separately scoped and revocable.
      </p>

      {showCreate && (
        <CreateIdentityWizard
          onCreated={reload}
          onClose={() => { setShowCreate(false); reload(); }}
        />
      )}
      {mutationError && <div className="principals-error" role="alert">{mutationError}</div>}

      {unavailable ? (
        <div className="principals-empty">
          The identity substrate is not migrated on this environment yet, so there are no
          principals to show.
        </div>
      ) : loading ? (
        <div className="principals-empty">Loading…</div>
      ) : failed ? (
        // A failed lookup must not read as "there are no principals".
        <div className="principals-error" role="alert">
          Could not load principals. <button className="principals-inline-retry" onClick={reload}>Retry</button>
        </div>
      ) : principals.length === 0 ? (
        <div className="principals-empty">No principals found.</div>
      ) : (
        <>
          <div className="principals-controls">
            <div className="principals-search">
              <Search size={16} />
              <input
                type="text"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search handle, name or role…"
                aria-label="Search principals"
              />
              {query && (
                <button
                  type="button"
                  className="principals-search-clear"
                  aria-label="Clear search"
                  onClick={() => setQuery('')}
                >
                  <X size={16} />
                </button>
              )}
            </div>
            <div className="principals-kind-filters">
              <button
                type="button"
                className={`principals-kind-filter ${kindFilter === 'all' ? 'principals-kind-filter--active' : ''}`}
                onClick={() => setKindFilter('all')}
              >
                All ({principals.length})
              </button>
              {KIND_ORDER.map(kind => (
                <button
                  type="button"
                  key={kind}
                  className={`principals-kind-filter ${kindFilter === kind ? 'principals-kind-filter--active' : ''}`}
                  onClick={() => setKindFilter(kind)}
                >
                  {kind} ({counts.get(kind) || 0})
                </button>
              ))}
            </div>
          </div>

          {grouped.length === 0 && filtersActive ? (
            <div className="principals-empty">
              No principals match the current filters.{' '}
              <button
                className="principals-inline-retry"
                onClick={() => { setQuery(''); setKindFilter('all'); }}
              >
                Clear filters
              </button>
            </div>
          ) : null}

          {grouped.map(group => (
            <section key={group.kind} className="principals-group">
              <h2 className="principals-group-title">{group.kind}</h2>
              {/* Scrolls horizontally at narrow widths, so it is reachable
                  from the keyboard and named (walkthrough item R14). */}
              <div className="principals-table" role="table" aria-label="Accounts" tabIndex={0}>
                <div className="principals-row principals-row--head" role="row">
                  <span role="columnheader">Identity</span>
                  <span role="columnheader">Role</span>
                  <span role="columnheader">Harness</span>
                  <span role="columnheader">Status</span>
                  <span role="columnheader">Last seen</span>
                </div>
                {group.rows.map((p: Principal) => (
                  <div
                    key={p.id}
                    className={`principals-row${me?.id === p.id ? ' principals-row--me' : ''}`}
                    role="row"
                  >
                    {/* Handle, not display name: this is the directory you
                        search and filter by handle, so showing "Owner" here
                        while the Assignee filter offers "dashboard_user" would
                        make the two halves of the UI disagree. */}
                    <span role="cell" className="principals-identity">
                      <PrincipalAvatar principal={p} size="sm" preferHandle />
                      {p.displayName && <span className="principals-muted">{p.displayName}</span>}
                      {me?.id === p.id && <span className="principals-you">you</span>}
                      {p.provenance && <span className="principals-provenance">{p.provenance}</span>}
                    </span>
                    <span role="cell">{p.role || <em className="principals-muted">inherited</em>}</span>
                    <span role="cell">{p.harness || '—'}</span>
                    <span role="cell" className="principals-status-cell">
                      <span className={`principals-status principals-status--${p.status}`}>{p.status}</span>
                      {me?.id !== p.id && (
                        PROTECTED_HANDLES[p.handle] ? (
                          <button
                            type="button"
                            className="principals-toggle"
                            disabled
                            title={PROTECTED_HANDLES[p.handle]}
                          >
                            Disable
                          </button>
                        ) : (
                          <button
                            type="button"
                            className="principals-toggle"
                            disabled={togglingId === p.id}
                            aria-busy={togglingId === p.id}
                            onClick={() => togglePrincipal(p)}
                          >
                            {p.status === 'active' ? 'Disable' : 'Enable'}
                          </button>
                        )
                      )}
                    </span>
                    <span role="cell" className="principals-muted">{formatLastSeen(p.lastSeenAt)}</span>
                  </div>
                ))}
              </div>
            </section>
          ))}
        </>
      )}
    </div>
  );
};

export default PrincipalsPage;
