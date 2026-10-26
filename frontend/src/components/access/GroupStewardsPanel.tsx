import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Loader2, UsersRound } from 'lucide-react';
import { Button } from '../Button';
import { Select } from '../ui/Select';
import { ConfirmationModal } from '../ConfirmationModal';
import { principalLabel } from './accessShared';
import type { Principal } from '../../types/task';
import { authenticatedFetch } from '../../utils/auth';
import { formatDateTime } from '../../utils/dateFormat';

/**
 * The Group roles sub-panel (LENSES-c c1-A, card 46cfbd1d; design delta C.3
 * and AZ-A12 card item 3): a Group's owners and managers, each with its holder
 * and its LIVE or INERT flag and the reason, read from GET /groups/{id}/stewards
 * (principals:read) exactly as the server derives it. The panel never decides
 * liveness itself.
 *
 * Appointing and removing are ROOT LOGIN-SESSION acts on the server, and the
 * panel offers them to a root session only. Every other reader sees the list
 * and nothing to press. There is no step-up on this path: the design rules
 * none for root, so the panel asks for a confirmation before a removal and
 * sends nothing else. There is no owner control here (an owner's removal of a
 * manager row, and any lens, belong to later slices).
 *
 * A refusal is shown as the server words it, with its code, because the codes
 * (STEWARD_INELIGIBLE, ALREADY_A_STEWARD, REQUIRES_LOGIN_SESSION, ...) are
 * what an administrator acts on.
 */

const API_BASE = import.meta.env.VITE_API_BASE_URL || '/api';

/** The two Group roles; the server is the authority on every other value. */
export const GROUP_STEWARD_ROLES = ['owner', 'manager'] as const;

/** The roles that make a row inert (display only; the server decides). */
const ELEVATED_ROLES = new Set(['admin', 'operator', 'orchestrator']);

export interface GroupStewardRow {
  accountPrincipalId: string;
  handle: string;
  kind: string;
  status: string;
  role: string;
  appointedByPrincipalId: string | null;
  appointedAt: string;
  live: boolean;
  inertReason: string | null;
}

interface GroupOption { id: string; name: string }

export const INERT_REASON_TEXT: Record<string, string> = {
  principal_inactive: 'The holder is not active (disabled or terminated).',
  elevated_role: 'The holder now holds an elevated role (admin, operator or orchestrator).',
  not_a_member: 'The holder is not a member of this Group.',
};

/** Read a JSON envelope; a refusal becomes an Error carrying the server's
 * message and its code, verbatim. */
async function readEnvelope(response: Response): Promise<any> {
  const data = await response.json().catch(() => ({}));
  if (!response.ok || data.success === false) {
    const message = data.message || data.error || `Request failed (${response.status})`;
    throw new Error(data.code ? `${message} (${data.code})` : message);
  }
  return data;
}

export const GroupStewardsPanel: React.FC<{
  isRoot: boolean;
  principals: Principal[];
  surface: (kind: 'notice' | 'error', message: string) => void;
}> = ({ isRoot, principals, surface }) => {
  const [groups, setGroups] = useState<GroupOption[]>([]);
  const [groupsState, setGroupsState] = useState<'loading' | 'ready' | 'failed'>('loading');
  const [groupsError, setGroupsError] = useState<string | null>(null);
  const [groupId, setGroupId] = useState('');
  const [stewards, setStewards] = useState<GroupStewardRow[]>([]);
  const [stewardsState, setStewardsState] = useState<'idle' | 'loading' | 'ready' | 'failed'>('idle');
  const [stewardsError, setStewardsError] = useState<string | null>(null);
  const [accountId, setAccountId] = useState('');
  const [role, setRole] = useState('');
  const [busy, setBusy] = useState(false);
  const [removing, setRemoving] = useState<GroupStewardRow | null>(null);

  const principalById = useMemo(() => new Map(principals.map((p) => [p.id, p])), [principals]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const data = await readEnvelope(await authenticatedFetch(`${API_BASE}/groups`));
        if (cancelled) return;
        const rows: GroupOption[] = Array.isArray(data.groups)
          ? data.groups.map((group: GroupOption) => ({ id: String(group.id), name: String(group.name) }))
          : [];
        setGroups(rows);
        setGroupsState('ready');
      } catch (caught) {
        if (cancelled) return;
        setGroupsError(caught instanceof Error ? caught.message : 'Could not load Groups');
        setGroupsState('failed');
      }
    })();
    return () => { cancelled = true; };
  }, []);

  const loadStewards = useCallback(async (id: string) => {
    if (!id) { setStewards([]); setStewardsState('idle'); return; }
    setStewardsState('loading');
    setStewardsError(null);
    try {
      const data = await readEnvelope(await authenticatedFetch(`${API_BASE}/groups/${id}/stewards`));
      setStewards(Array.isArray(data.stewards) ? data.stewards : []);
      setStewardsState('ready');
    } catch (caught) {
      setStewards([]);
      setStewardsError(caught instanceof Error ? caught.message : 'Could not load the Group roles');
      setStewardsState('failed');
    }
  }, []);

  useEffect(() => { void loadStewards(groupId); }, [groupId, loadStewards]);

  /**
   * Who the appointment form OFFERS: a parentless human or service Account
   * holding no elevated role and not terminated, and not already holding a
   * role here. That is the display half of the server's refusals
   * (STEWARD_INELIGIBLE, ALREADY_A_STEWARD); the server still decides, and
   * its refusal is shown verbatim if the list is stale.
   */
  const candidates = useMemo(() => {
    const holding = new Set(stewards.map((row) => row.accountPrincipalId));
    return principals.filter((p) => (p.kind === 'human' || p.kind === 'service')
      && !p.parentPrincipalId
      && !ELEVATED_ROLES.has(p.role ?? '')
      && String(p.status) !== 'terminated'
      && p.handle !== 'system'
      && p.handle !== 'dashboard_user'
      && !holding.has(p.id));
  }, [principals, stewards]);

  const groupName = groups.find((group) => group.id === groupId)?.name ?? 'this Group';

  const holderLabel = (row: GroupStewardRow): string => {
    const known = principalById.get(row.accountPrincipalId);
    return known ? principalLabel(known) : row.handle;
  };

  const appoint = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!isRoot || !groupId || !accountId || !role) return;
    setBusy(true);
    try {
      const data = await readEnvelope(await authenticatedFetch(`${API_BASE}/groups/${groupId}/stewards`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ accountPrincipalId: accountId, role }),
      }));
      const steward: GroupStewardRow | undefined = data.steward;
      surface('notice', steward && !steward.live
        ? `Appointed ${role} in ${groupName}. The row is inert until its holder qualifies: ${INERT_REASON_TEXT[steward.inertReason ?? ''] ?? steward.inertReason}`
        : `Appointed ${role} in ${groupName}.`);
      setAccountId('');
      setRole('');
      await loadStewards(groupId);
    } catch (caught) {
      surface('error', caught instanceof Error ? caught.message : 'The Group role could not be appointed');
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    const row = removing;
    setRemoving(null);
    if (!isRoot || !row || !groupId) return;
    setBusy(true);
    try {
      await readEnvelope(await authenticatedFetch(
        `${API_BASE}/groups/${groupId}/stewards/${row.accountPrincipalId}`, { method: 'DELETE' }));
      surface('notice', `Removed the ${row.role} role of ${holderLabel(row)} in ${groupName}.`);
      await loadStewards(groupId);
    } catch (caught) {
      surface('error', caught instanceof Error ? caught.message : 'The Group role could not be removed');
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="axm-section" aria-labelledby="axm-stewards-heading">
      <div className="axm-section-head">
        <h2 id="axm-stewards-heading"><UsersRound aria-hidden="true" /> Group roles</h2>
      </div>
      <p className="axm-section-intro">
        A Group&apos;s owners and managers. A role is live only while its holder is active, is a
        member of the Group and holds no elevated role; otherwise it is inert, flagged with the
        reason, and confers nothing. Roles do not yet grant any edit right.
        {isRoot
          ? ' Appointing and removing are root login-session acts, recorded in the audit ledger.'
          : ' Only a root login session appoints or removes a role.'}
      </p>

      {groupsState === 'loading' && (
        <div className="axm-state"><Loader2 className="axm-spin" aria-hidden="true" /> Loading Groups…</div>
      )}
      {groupsState === 'failed' && <div className="axm-empty" role="status">{groupsError}</div>}
      {groupsState === 'ready' && groups.length === 0 && <div className="axm-empty">No Groups exist yet.</div>}
      {groupsState === 'ready' && groups.length > 0 && (
        <>
          <div className="axm-filter axm-filter--wide">
            <label htmlFor="axm-stewards-group">Group</label>
            <Select
              id="axm-stewards-group"
              value={groupId}
              onChange={(event) => { setGroupId(event.target.value); setAccountId(''); setRole(''); }}
            >
              <option value="">Choose a Group&hellip;</option>
              {groups.map((group) => (
                <option key={group.id} value={group.id}>{group.name}</option>
              ))}
            </Select>
          </div>

          {stewardsState === 'loading' && (
            <div className="axm-state"><Loader2 className="axm-spin" aria-hidden="true" /> Loading roles…</div>
          )}
          {stewardsState === 'failed' && <div className="axm-empty" role="status">{stewardsError}</div>}
          {stewardsState === 'ready' && stewards.length === 0 && (
            <div className="axm-empty">No owner or manager in {groupName}.</div>
          )}
          {stewardsState === 'ready' && stewards.length > 0 && (
            <div className="axm-table" role="table" aria-label={`Group roles in ${groupName}`}>
              <div className="axm-trow axm-trow--head" role="row">
                <span role="columnheader">Holder</span>
                <span role="columnheader">Role</span>
                <span role="columnheader">State</span>
                <span role="columnheader">Appointed</span>
                <span role="columnheader">Action</span>
              </div>
              {stewards.map((row) => (
                <div className="axm-trow" role="row" key={row.accountPrincipalId}>
                  <span role="cell">
                    <strong>{holderLabel(row)}</strong>
                    <small>{row.kind} &middot; {row.status}</small>
                  </span>
                  <span role="cell">{row.role}</span>
                  <span role="cell">
                    {row.live ? (
                      <span className="axm-badge">Live</span>
                    ) : (
                      <>
                        <span className="axm-badge axm-badge--warn">Inert</span>
                        <small>{INERT_REASON_TEXT[row.inertReason ?? ''] ?? row.inertReason ?? 'Inert.'}</small>
                      </>
                    )}
                  </span>
                  <span role="cell">{formatDateTime(row.appointedAt, '—')}</span>
                  <span role="cell">
                    {isRoot ? (
                      <Button
                        variant="secondary"
                        size="compact"
                        disabled={busy}
                        ariaLabel={`Remove the ${row.role} role of ${holderLabel(row)}`}
                        onClick={() => setRemoving(row)}
                      >
                        Remove
                      </Button>
                    ) : <span className="axm-muted">Root only</span>}
                  </span>
                </div>
              ))}
            </div>
          )}

          {isRoot && groupId && stewardsState === 'ready' && (
            <form className="axm-editor" onSubmit={appoint} aria-label="Appoint a Group role">
              <div className="axm-editor-grid">
                <div className="form-group">
                  <label htmlFor="axm-stewards-account">Account</label>
                  <Select
                    id="axm-stewards-account"
                    required
                    value={accountId}
                    onChange={(event) => setAccountId(event.target.value)}
                  >
                    <option value="">Choose an Account&hellip;</option>
                    {candidates.map((principal) => (
                      <option key={principal.id} value={principal.id}>
                        {principalLabel(principal)} &middot; {principal.kind}
                      </option>
                    ))}
                  </Select>
                </div>
                <div className="form-group">
                  <label htmlFor="axm-stewards-role">Role</label>
                  <Select
                    id="axm-stewards-role"
                    required
                    value={role}
                    onChange={(event) => setRole(event.target.value)}
                  >
                    <option value="">Choose a role&hellip;</option>
                    {GROUP_STEWARD_ROLES.map((value) => (
                      <option key={value} value={value}>{value}</option>
                    ))}
                  </Select>
                </div>
              </div>
              <div className="axm-decide-actions">
                <span className="axm-muted">
                  Membership is not required: an Account outside the Group is appointed inert.
                </span>
                <Button type="submit" variant="primary" disabled={busy || !accountId || !role}>
                  {busy ? 'Appointing…' : 'Appoint'}
                </Button>
              </div>
            </form>
          )}
        </>
      )}

      {removing && (
        <ConfirmationModal
          danger
          title="Remove this Group role?"
          confirmLabel="Remove role"
          message={`${holderLabel(removing)} stops holding the ${removing.role} role in ${groupName}. The removal is audited.`}
          onConfirm={remove}
          onCancel={() => setRemoving(null)}
        />
      )}
    </section>
  );
};
