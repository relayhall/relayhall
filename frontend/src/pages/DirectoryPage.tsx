import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { Loader2, Network } from 'lucide-react';
import { Button } from '../components/Button';
import { authenticatedFetch } from '../utils/auth';
import { readJson } from '../components/access/accessShared';
import { useMyLenses } from '../hooks/useMyLenses';
import { formatDateTime } from '../utils/dateFormat';
import './AdministrationPages.css';

const API_BASE = import.meta.env.VITE_API_BASE_URL || '/api';

/**
 * DIRECTORY - the admin lens's first section (RH-LENSES-d, card 4e159741;
 * design 96f0bd3d s8.4; owner design record 99d6b0ad s3.3 and s4).
 *
 * Three things an administrator needs in the first week, on one page: which
 * Identity providers are connected, whether their directory sync is healthy,
 * and the REMOTE-GROUP CATALOG - every group the directory has shown, with a
 * member count - with one-click *Use this group*.
 *
 * NOTHING HERE DECIDES AUTHORITY. Each read is the server's own projection:
 * the catalog is everything for a root login session and an empty list for
 * everyone else; the provider list and the sync read carry the root ceiling
 * and refuse anyone else, which this page renders as the section being absent,
 * never as an error. *Use this group* is offered to the admin lens and decided
 * by the route's own root ceiling.
 */

interface CatalogRow {
  id: string;
  identityProviderId: string;
  externalGroupRef: string;
  displayName: string | null;
  memberCount: number;
  sources: string[];
  lastSeenAt: string;
  boundGroupId: string | null;
  boundGroupName: string | null;
}

interface ProviderRow {
  id: string;
  name: string;
  status: string;
}

interface SyncRow {
  provider: string;
  lastSuccessAt: string | null;
  lastErrorPresent: boolean;
  stalenessThresholdHours: number;
  stale: boolean;
}

/** A section the server answered, refused (root ceiling: not shown), or failed to answer. */
type Section<T> = { state: 'loading' } | { state: 'ready'; rows: T[] } | { state: 'refused' } | { state: 'failed'; message: string };

async function readSection<T>(path: string, field: string): Promise<Section<T>> {
  try {
    const response = await authenticatedFetch(`${API_BASE}${path}`);
    if (response.status === 403 || response.status === 404) return { state: 'refused' };
    const data = await readJson(response);
    return { state: 'ready', rows: Array.isArray(data[field]) ? data[field] as T[] : [] };
  } catch (caught) {
    return { state: 'failed', message: caught instanceof Error ? caught.message : 'The board did not answer' };
  }
}

const when = (value: string | null): string => (value ? formatDateTime(value, 'never') : 'never');

export const DirectoryPage: React.FC = () => {
  const { lenses } = useMyLenses();
  const [providers, setProviders] = useState<Section<ProviderRow>>({ state: 'loading' });
  const [sync, setSync] = useState<Section<SyncRow>>({ state: 'loading' });
  const [catalog, setCatalog] = useState<Section<CatalogRow>>({ state: 'loading' });
  const [using, setUsing] = useState<CatalogRow | null>(null);
  const [groupName, setGroupName] = useState('');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const [p, s, c] = await Promise.all([
      readSection<ProviderRow>('/identity-providers', 'identityProviders'),
      readSection<SyncRow>('/groups/directory-sync', 'providers'),
      readSection<CatalogRow>('/directory-group-references', 'references'),
    ]);
    setProviders(p);
    setSync(s);
    setCatalog(c);
  }, []);

  useEffect(() => { load(); }, [load]);

  const providerName = useMemo(() => {
    const names = new Map<string, string>();
    if (providers.state === 'ready') for (const provider of providers.rows) names.set(provider.id, provider.name);
    return (id: string): string => names.get(id) ?? names.get(id.replace(/^scim:/, '')) ?? id;
  }, [providers]);

  const startUsing = (row: CatalogRow) => {
    setUsing(row);
    setGroupName(row.displayName ?? row.externalGroupRef);
    setNotice(null);
    setError(null);
  };

  const bindReference = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!using) return;
    setBusy(true);
    setError(null);
    try {
      const name = groupName.trim();
      const data = await readJson(await authenticatedFetch(`${API_BASE}/directory-group-references/${using.id}/use`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(name ? { name } : {}),
      }));
      setNotice(`Created the group "${data.groupName}" from ${using.externalGroupRef}, with ${data.memberCountApplied} `
        + `${data.memberCountApplied === 1 ? 'member' : 'members'}.`);
      setUsing(null);
      await load();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'The group could not be created');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="admin-page">
      <header className="admin-page-header">
        <Network aria-hidden="true" />
        <h1>Directory</h1>
      </header>
      <p className="admin-page-intro">
        The Identity providers people sign in through, how recently each one synchronised, and every directory group
        the board has seen. Using a directory group creates a board group that follows the directory&apos;s membership.
      </p>
      {notice && <div className="admin-page-notice" role="status">{notice}</div>}
      {error && <div className="admin-page-error" role="alert">{error}</div>}

      {providers.state !== 'refused' && (
        <section className="admin-page-panel" aria-labelledby="directory-providers-heading">
          <h2 id="directory-providers-heading">Identity providers</h2>
          {providers.state === 'loading' && <p className="admin-page-muted"><Loader2 className="admin-page-spin" aria-hidden="true" /> Loading…</p>}
          {providers.state === 'failed' && <p className="admin-page-error" role="alert">{providers.message}</p>}
          {providers.state === 'ready' && providers.rows.length === 0 && (
            <div className="admin-page-empty">
              <p><strong>No Identity provider is connected yet.</strong></p>
              <p>
                People sign in with a board password until one is. Connect an Identity provider under{' '}
                <Link to="/settings/access-manager">Advanced</Link>; its groups then appear below as people sign in.
              </p>
            </div>
          )}
          {providers.state === 'ready' && providers.rows.length > 0 && (
            <ul className="admin-page-list">
              {providers.rows.map((provider) => (
                <li key={provider.id}><strong>{provider.name}</strong> <span className="admin-page-muted">{provider.status}</span></li>
              ))}
            </ul>
          )}
        </section>
      )}

      {sync.state !== 'refused' && (
        <section className="admin-page-panel" aria-labelledby="directory-sync-heading">
          <h2 id="directory-sync-heading">Sync health</h2>
          {sync.state === 'loading' && <p className="admin-page-muted"><Loader2 className="admin-page-spin" aria-hidden="true" /> Loading…</p>}
          {sync.state === 'failed' && <p className="admin-page-error" role="alert">{sync.message}</p>}
          {sync.state === 'ready' && sync.rows.length === 0 && (
            <p className="admin-page-empty">No directory has synchronised yet. A sign-in that carries groups, or a SCIM push, records the first sync.</p>
          )}
          {sync.state === 'ready' && sync.rows.length > 0 && (
            <table className="admin-page-table">
              <caption className="admin-page-caption">Last successful sync per directory</caption>
              <thead><tr><th scope="col">Directory</th><th scope="col">Last success</th><th scope="col">State</th></tr></thead>
              <tbody>
                {sync.rows.map((row) => (
                  <tr key={row.provider}>
                    <td>{providerName(row.provider)}</td>
                    <td>{when(row.lastSuccessAt)}</td>
                    <td>
                      {row.stale
                        ? <span className="admin-page-badge admin-page-badge--warning">Stale (over {row.stalenessThresholdHours} h)</span>
                        : <span className="admin-page-badge">Current</span>}
                      {row.lastErrorPresent && <span className="admin-page-badge admin-page-badge--warning">Last attempt failed</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>
      )}

      <section className="admin-page-panel" aria-labelledby="directory-catalog-heading">
        <h2 id="directory-catalog-heading">Directory groups</h2>
        {catalog.state === 'loading' && <p className="admin-page-muted"><Loader2 className="admin-page-spin" aria-hidden="true" /> Loading…</p>}
        {catalog.state === 'failed' && <p className="admin-page-error" role="alert">{catalog.message}</p>}
        {catalog.state === 'refused' && <p className="admin-page-empty">There are no directory groups to show here.</p>}
        {catalog.state === 'ready' && catalog.rows.length === 0 && (
          <div className="admin-page-empty">
            <p><strong>No directory groups to show.</strong></p>
            <p>
              Groups appear here once the directory has shown them: when someone signs in through an Identity provider
              that sends group claims, or when the directory pushes groups over SCIM. Only counts are shown, never the
              people in a group.
            </p>
          </div>
        )}
        {catalog.state === 'ready' && catalog.rows.length > 0 && (
          <table className="admin-page-table">
            <caption className="admin-page-caption">Every directory group the board has seen, with how many people carry it</caption>
            <thead>
              <tr>
                <th scope="col">Directory group</th>
                <th scope="col">Identity provider</th>
                <th scope="col">People</th>
                <th scope="col">Seen through</th>
                <th scope="col">Last seen</th>
                <th scope="col">Board group</th>
              </tr>
            </thead>
            <tbody>
              {catalog.rows.map((row) => (
                <tr key={row.id}>
                  <td>
                    {row.displayName && <span className="admin-page-name">{row.displayName}</span>}
                    <code className="admin-page-ref">{row.externalGroupRef}</code>
                  </td>
                  <td>{providerName(row.identityProviderId)}</td>
                  <td>{row.memberCount}</td>
                  <td>{row.sources.join(', ') || 'retained'}</td>
                  <td>{when(row.lastSeenAt)}</td>
                  <td>
                    {row.boundGroupName
                      ? <Link to="/groups">{row.boundGroupName}</Link>
                      : lenses.admin
                        ? (
                          <Button
                            size="compact"
                            variant="secondary"
                            onClick={() => startUsing(row)}
                            ariaLabel={`Use the directory group ${row.displayName ?? row.externalGroupRef}`}
                          >
                            Use this group
                          </Button>
                        )
                        : <span className="admin-page-muted">Not used</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {using && (
          <form className="admin-page-form" onSubmit={bindReference} aria-labelledby="directory-use-heading">
            <h3 id="directory-use-heading">Use {using.displayName ?? using.externalGroupRef}</h3>
            <p className="admin-page-muted">
              Creates a board group bound to this directory group and adds the {using.memberCount}{' '}
              {using.memberCount === 1 ? 'person' : 'people'} who carry it, in one step. It is not featured until you
              feature it.
            </p>
            <label className="admin-page-label" htmlFor="directory-use-name">Group name</label>
            <input
              id="directory-use-name"
              className="form-input"
              value={groupName}
              onChange={(event) => setGroupName(event.target.value)}
              maxLength={200}
            />
            <div className="admin-page-actions">
              <Button type="submit" disabled={busy}>{busy ? 'Creating…' : 'Create and bind'}</Button>
              <Button variant="secondary" onClick={() => setUsing(null)} disabled={busy}>Cancel</Button>
            </div>
          </form>
        )}
      </section>
    </div>
  );
};

export default DirectoryPage;
