import React, { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Loader2, UsersRound } from 'lucide-react';
import { authenticatedFetch } from '../utils/auth';
import { readJson } from '../components/access/accessShared';
import { useMyLenses } from '../hooks/useMyLenses';
import './AdministrationPages.css';

const API_BASE = import.meta.env.VITE_API_BASE_URL || '/api';

/**
 * GROUPS - the admin lens's group section (RH-LENSES-d, card 4e159741;
 * design 96f0bd3d s8.4: "Groups (bindings, featured)").
 *
 * Every board Group with its member count, whether it follows a directory
 * group, and its FEATURED flag - which decides what pickers offer first and
 * which groups a person may choose as a home group. Featuring a group grants
 * nothing (design s7.1).
 *
 * The list is `GET /groups` under its own `principals:read` ceiling, exactly
 * as every other Groups reader sees it. The featured switch is OFFERED to the
 * admin lens and DECIDED by `PATCH /groups/{id}`'s root ceiling: a session the
 * route refuses sees the refusal in words, and nothing changes.
 */

interface GroupRow {
  id: string;
  name: string;
  description: string;
  memberCount: number;
  identityProviderId: string | null;
  externalGroupRef: string | null;
  featured: boolean;
}

type Load = { state: 'loading' } | { state: 'ready'; groups: GroupRow[] } | { state: 'failed'; message: string };

export const GroupsPage: React.FC = () => {
  const { lenses } = useMyLenses();
  const [load, setLoad] = useState<Load>({ state: 'loading' });
  const [busyId, setBusyId] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    try {
      const data = await readJson(await authenticatedFetch(`${API_BASE}/groups`));
      setLoad({ state: 'ready', groups: Array.isArray(data.groups) ? data.groups : [] });
    } catch (caught) {
      setLoad({ state: 'failed', message: caught instanceof Error ? caught.message : 'The board did not answer' });
    }
  }, []);

  useEffect(() => { reload(); }, [reload]);

  const setFeatured = async (group: GroupRow, featured: boolean) => {
    setBusyId(group.id);
    setNotice(null);
    setError(null);
    try {
      await readJson(await authenticatedFetch(`${API_BASE}/groups/${group.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ featured }),
      }));
      setNotice(featured ? `"${group.name}" is now featured.` : `"${group.name}" is no longer featured.`);
      await reload();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'The group could not be changed');
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div className="admin-page">
      <header className="admin-page-header">
        <UsersRound aria-hidden="true" />
        <h1>Groups</h1>
      </header>
      <p className="admin-page-intro">
        Board groups, how many people are in each, and whether a group follows a directory group. A featured group is
        offered first in pickers and can be chosen as a home group; featuring grants nothing by itself.
      </p>
      {notice && <div className="admin-page-notice" role="status">{notice}</div>}
      {error && <div className="admin-page-error" role="alert">{error}</div>}

      <section className="admin-page-panel" aria-labelledby="groups-list-heading">
        <h2 id="groups-list-heading">All groups</h2>
        {load.state === 'loading' && <p className="admin-page-muted"><Loader2 className="admin-page-spin" aria-hidden="true" /> Loading…</p>}
        {load.state === 'failed' && <p className="admin-page-error" role="alert">{load.message}</p>}
        {load.state === 'ready' && load.groups.length === 0 && (
          <div className="admin-page-empty">
            <p><strong>No groups yet.</strong></p>
            <p>
              Start from the <Link to="/directory">Directory</Link>: using a directory group creates a board group that
              follows the directory&apos;s membership. Local groups are created under{' '}
              <Link to="/settings/access-manager">Advanced</Link>.
            </p>
          </div>
        )}
        {load.state === 'ready' && load.groups.length > 0 && (
          <table className="admin-page-table">
            <caption className="admin-page-caption">Every board group</caption>
            <thead>
              <tr>
                <th scope="col">Group</th>
                <th scope="col">Members</th>
                <th scope="col">Follows</th>
                <th scope="col">Featured</th>
              </tr>
            </thead>
            <tbody>
              {load.groups.map((group) => (
                <tr key={group.id}>
                  <td>
                    <span className="admin-page-name">{group.name}</span>
                    {group.description && <span className="admin-page-muted">{group.description}</span>}
                  </td>
                  <td>{group.memberCount}</td>
                  <td>
                    {group.externalGroupRef
                      ? <code className="admin-page-ref">{group.externalGroupRef}</code>
                      : <span className="admin-page-muted">Local group</span>}
                  </td>
                  <td>
                    {lenses.admin
                      ? (
                        <label className="admin-page-switch">
                          <input
                            type="checkbox"
                            checked={group.featured}
                            disabled={busyId === group.id}
                            onChange={(event) => setFeatured(group, event.target.checked)}
                          />
                          <span>{group.featured ? 'Featured' : 'Not featured'}</span>
                          <span className="admin-page-visually-hidden"> ({group.name})</span>
                        </label>
                      )
                      : <span>{group.featured ? 'Featured' : 'Not featured'}</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </div>
  );
};

export default GroupsPage;
