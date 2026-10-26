import React, { useCallback, useEffect, useState } from 'react';
import { Loader2, UsersRound } from 'lucide-react';
import { Button } from '../components/Button';
import { authenticatedFetch } from '../utils/auth';
import { readJson } from '../components/access/accessShared';
import { useStepUpRetry } from '../components/access/useStepUpRetry';
import { readStepUpChallenge, type StepUpChallenge } from '../utils/stepUpChallenge';
import { useMyLenses } from '../hooks/useMyLenses';
import type { StewardedGroup } from '../types/lenses';
import './AdministrationPages.css';

const API_BASE = import.meta.env.VITE_API_BASE_URL || '/api';

/**
 * MY TEAM - the manager lens's section (LENSES-c c1-B, card b5c83682; design
 * delta C.8, LENSES v7 s8.4 "My team").
 *
 * Every Group the person holds a LIVE owner or manager role in, as the lens
 * answer lists them (owners first): its members (`GET /groups/{id}/members`),
 * its roles with the live or inert flag (`GET /groups/{id}/stewards`) and its
 * team grants (`GET /groups/{id}/grants`, which answers a live steward on a
 * login session). For a Group the person OWNS it also offers gate (iii):
 * appoint a manager from the Group's members and remove a manager row, each
 * with a fresh step-up. The lens only decides that this page is OFFERED: every
 * request here is decided by its own route, and a refusal is shown in the
 * board's words.
 */

interface Member { accountPrincipalId: string; handle: string; kind: string; status: string; source: string }
interface Steward { accountPrincipalId: string; handle: string; role: 'owner' | 'manager'; live: boolean; inertReason: string | null }
interface TeamGrant { id: string; resourceType: string; resourceId: string | null; verb: string; expiresAt: string | null }

type Load =
  | { state: 'loading' }
  | { state: 'ready'; members: Member[]; stewards: Steward[]; grants: TeamGrant[] }
  | { state: 'failed'; message: string };

const INERT_TEXT: Record<string, string> = {
  principal_inactive: 'inactive account',
  elevated_role: 'holds an administrator role',
  not_a_member: 'not a member',
};

const APPOINT_DESCRIPTION = 'Confirm it is you to appoint this manager.';
const REMOVE_DESCRIPTION = 'Confirm it is you to remove this manager.';

async function sendWithStepUp(
  send: (stepUpToken: string) => Promise<Response>,
  binding: StepUpChallenge,
  askForToken: (challenge: StepUpChallenge) => Promise<string | null>,
): Promise<{ response: Response | null; body: any }> {
  const first = await askForToken(binding);
  if (!first) return { response: null, body: null };
  let response = await send(first);
  let body = await response.json().catch(() => null);
  const challenge = readStepUpChallenge(response.status, body);
  if (challenge && challenge.action === binding.action && challenge.targetId === binding.targetId) {
    const second = await askForToken(challenge);
    if (!second) return { response, body };
    response = await send(second);
    body = await response.json().catch(() => null);
  }
  return { response, body };
}

const TeamGroup: React.FC<{ group: StewardedGroup }> = ({ group }) => {
  const [load, setLoad] = useState<Load>({ state: 'loading' });
  const [appointee, setAppointee] = useState('');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [description, setDescription] = useState(APPOINT_DESCRIPTION);
  const { askForToken, retryDialog } = useStepUpRetry(description);
  const groupId = group.id.toLowerCase();

  const reload = useCallback(async () => {
    try {
      const [members, stewards, grants] = await Promise.all([
        readJson(await authenticatedFetch(`${API_BASE}/groups/${groupId}/members`)),
        readJson(await authenticatedFetch(`${API_BASE}/groups/${groupId}/stewards`)),
        readJson(await authenticatedFetch(`${API_BASE}/groups/${groupId}/grants`)),
      ]);
      setLoad({
        state: 'ready',
        members: Array.isArray(members.members) ? members.members : [],
        stewards: Array.isArray(stewards.stewards) ? stewards.stewards : [],
        grants: Array.isArray(grants.grants) ? grants.grants : [],
      });
    } catch (caught) {
      setLoad({ state: 'failed', message: caught instanceof Error ? caught.message : 'The board did not answer' });
    }
  }, [groupId]);

  useEffect(() => { reload(); }, [reload]);

  const act = async (
    binding: StepUpChallenge, request: (stepUpToken: string) => Promise<Response>, done: string, prompt: string,
  ) => {
    setBusy(true);
    setNotice(null);
    setError(null);
    setDescription(prompt);
    try {
      const { response, body } = await sendWithStepUp(request, binding, askForToken);
      if (!response) return;
      if (!response.ok || body?.success === false) {
        setError(body?.message || body?.error || `The board refused the request (${response.status})`);
        return;
      }
      setNotice(done);
      setAppointee('');
      await reload();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'The request could not be sent');
    } finally {
      setBusy(false);
    }
  };

  const appoint = (event: React.FormEvent) => {
    event.preventDefault();
    if (!appointee) return;
    const member = load.state === 'ready' ? load.members.find((row) => row.accountPrincipalId === appointee) : undefined;
    void act(
      { action: 'group.manager_appoint', targetId: groupId },
      (stepUpToken) => authenticatedFetch(`${API_BASE}/groups/${groupId}/managers`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ accountPrincipalId: appointee, stepUpToken }),
      }),
      `${member?.handle ?? 'The member'} is now a manager of ${group.name}.`,
      APPOINT_DESCRIPTION,
    );
  };

  const remove = (steward: Steward) => {
    void act(
      { action: 'group.manager_remove', targetId: groupId },
      (stepUpToken) => authenticatedFetch(`${API_BASE}/groups/${groupId}/managers/${steward.accountPrincipalId}`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ stepUpToken }),
      }),
      `${steward.handle} is no longer a manager of ${group.name}.`,
      REMOVE_DESCRIPTION,
    );
  };

  const owner = group.role === 'owner';
  const holders = load.state === 'ready' ? new Set(load.stewards.map((row) => row.accountPrincipalId)) : new Set<string>();
  const candidates = load.state === 'ready'
    ? load.members.filter((row) => row.status === 'active' && !holders.has(row.accountPrincipalId))
    : [];
  const headingId = `team-${groupId}-heading`;

  return (
    <section className="admin-page-panel" aria-labelledby={headingId}>
      <h2 id={headingId}>
        {group.name}{' '}
        <span className="admin-page-badge">{owner ? 'Owner' : 'Manager'}</span>
        {group.featured && <span className="admin-page-badge">Featured</span>}
      </h2>
      <p className="admin-page-muted">
        {group.memberCount} active {group.memberCount === 1 ? 'member' : 'members'}.
        {owner
          ? ' As an owner you edit what this group owns, approve the Charter of its projects, and appoint and remove its managers.'
          : ' As a manager you edit what this group owns.'}
      </p>
      {notice && <div className="admin-page-notice" role="status">{notice}</div>}
      {error && <div className="admin-page-error" role="alert">{error}</div>}
      {load.state === 'loading' && <p className="admin-page-muted"><Loader2 className="admin-page-spin" aria-hidden="true" /> Loading…</p>}
      {load.state === 'failed' && <p className="admin-page-error" role="alert">{load.message}</p>}
      {load.state === 'ready' && (
        <>
          <table className="admin-page-table">
            <caption className="admin-page-caption">Roles in {group.name}</caption>
            <thead>
              <tr>
                <th scope="col">Person</th>
                <th scope="col">Role</th>
                <th scope="col">State</th>
                {owner && <th scope="col"><span className="admin-page-visually-hidden">Action</span></th>}
              </tr>
            </thead>
            <tbody>
              {load.stewards.map((row) => (
                <tr key={row.accountPrincipalId}>
                  <td><span className="admin-page-name">{row.handle}</span></td>
                  <td>{row.role === 'owner' ? 'Owner' : 'Manager'}</td>
                  <td>
                    {row.live
                      ? 'Active'
                      : <span className="admin-page-badge admin-page-badge--warning">Inactive: {INERT_TEXT[row.inertReason ?? ''] ?? 'inactive'}</span>}
                  </td>
                  {owner && (
                    <td>
                      {row.role === 'manager' && (
                        <Button
                          size="compact"
                          variant="secondary"
                          disabled={busy}
                          onClick={() => remove(row)}
                          ariaLabel={`Remove ${row.handle} as a manager of ${group.name}`}
                        >
                          Remove
                        </Button>
                      )}
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>

          {owner && (
            <form className="admin-page-form" onSubmit={appoint} aria-labelledby={`${headingId}-appoint`}>
              <h3 id={`${headingId}-appoint`}>Appoint a manager</h3>
              <p className="admin-page-muted">
                Managers are chosen from the group&apos;s members. Owners are appointed by an administrator.
              </p>
              {candidates.length === 0
                ? <p className="admin-page-muted">Every active member already holds a role here.</p>
                : (
                  <>
                    <label className="admin-page-label" htmlFor={`${headingId}-appointee`}>Member</label>
                    <select
                      id={`${headingId}-appointee`}
                      className="form-input"
                      value={appointee}
                      onChange={(event) => setAppointee(event.target.value)}
                    >
                      <option value="">Choose a member</option>
                      {candidates.map((row) => <option key={row.accountPrincipalId} value={row.accountPrincipalId}>{row.handle}</option>)}
                    </select>
                    <div className="admin-page-actions">
                      <Button type="submit" disabled={busy || !appointee}>{busy ? 'Appointing…' : 'Appoint manager'}</Button>
                    </div>
                  </>
                )}
            </form>
          )}

          <table className="admin-page-table">
            <caption className="admin-page-caption">Members of {group.name}</caption>
            <thead>
              <tr>
                <th scope="col">Member</th>
                <th scope="col">Kind</th>
                <th scope="col">From</th>
              </tr>
            </thead>
            <tbody>
              {load.members.map((row) => (
                <tr key={row.accountPrincipalId}>
                  <td>
                    <span className="admin-page-name">{row.handle}</span>
                    {row.status !== 'active' && <span className="admin-page-muted">Inactive account</span>}
                  </td>
                  <td>{row.kind === 'service' ? 'Service account' : 'Person'}</td>
                  <td>{row.source === 'directory' ? 'Directory' : 'Added on the board'}</td>
                </tr>
              ))}
            </tbody>
          </table>

          <table className="admin-page-table">
            <caption className="admin-page-caption">What {group.name} is granted</caption>
            <thead>
              <tr>
                <th scope="col">Object</th>
                <th scope="col">Permission</th>
                <th scope="col">Until</th>
              </tr>
            </thead>
            <tbody>
              {load.grants.length === 0 && (
                <tr><td colSpan={3}><span className="admin-page-muted">No grants name this group.</span></td></tr>
              )}
              {load.grants.map((row) => (
                <tr key={row.id}>
                  <td>{row.resourceId ? <code className="admin-page-ref">{row.resourceType} {row.resourceId}</code> : `Every ${row.resourceType}`}</td>
                  <td>{row.verb}</td>
                  <td>{row.expiresAt ?? 'No end date'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
      {retryDialog}
    </section>
  );
};

export const TeamPage: React.FC = () => {
  const { lenses, loading } = useMyLenses();
  const groups = lenses.manager?.stewardedGroups ?? [];
  return (
    <div className="admin-page">
      <header className="admin-page-header">
        <UsersRound aria-hidden="true" />
        <h1>My team</h1>
      </header>
      <p className="admin-page-intro">
        The groups you own or manage: who is in each, who holds a role, and what each group is granted. Holding a role
        lets you edit what the group owns; it grants nothing else.
      </p>
      {loading && <p className="admin-page-muted"><Loader2 className="admin-page-spin" aria-hidden="true" /> Loading…</p>}
      {!loading && groups.length === 0 && (
        <div className="admin-page-empty">
          <p><strong>You hold no role in a group.</strong></p>
          <p>An administrator appoints group owners; a group&apos;s owners appoint its managers.</p>
        </div>
      )}
      {groups.map((group) => <TeamGroup key={group.id} group={group} />)}
    </div>
  );
};

export default TeamPage;
