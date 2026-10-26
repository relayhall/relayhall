import React, { useCallback, useEffect, useId, useState } from 'react';
import { Loader2, RefreshCw, Send, Undo2 } from 'lucide-react';
import { Button } from '../Button';
import { Select } from '../ui/Select';
import { authenticatedFetch } from '../../utils/auth';
import { formatDateTime } from '../../utils/dateFormat';
import { useMyPrincipal } from '../../hooks/usePrincipals';
import { BeforeAndAfter, changeTargetLabel } from './ChangeRequestDetail';
import type { ApprovalItem } from './approvals';
import '../../pages/AccessManagerPage.css';
import './ChangeRequests.css';

const API_BASE = import.meta.env.VITE_API_BASE_URL || '/api';

type ListState = { status: 'loading' } | { status: 'failed' } | { status: 'ready'; items: ApprovalItem[] };

/** The roles a person may ask for its own Account (design section 12 Q4 (a)): up to the editor class, never an elevated role. */
export const SELF_REQUESTABLE_ROLES = ['editor', 'user', 'reviewer', 'qa', 'viewer'];
const REASON_MIN = 20;
const REASON_MAX = 2000;

/**
 * ASK FOR A DIFFERENT ROLE (change-request design section 3 `identity.role`,
 * section 12 Q4 (a); card 9ce0b0b0, slice S4): files an identity.role change
 * for the signed-in Account on `POST /approvals/requests`. It changes nothing
 * itself: an administrator decides it on the approvals hub with step-up. The
 * server refuses an elevated role, the role already held, or a pending
 * request of the same kind, by name.
 */
export const RequestRoleChange: React.FC<{ principalId: string; onFiled: () => void }> = ({ principalId, onFiled }) => {
  const idBase = useId();
  const [role, setRole] = useState(SELF_REQUESTABLE_ROLES[0]);
  const [reason, setReason] = useState('');
  const [state, setState] = useState<{ status: 'idle' | 'sending' } | { status: 'filed' } | { status: 'refused'; text: string }>({ status: 'idle' });
  const length = [...reason.trim()].length;
  const file = async () => {
    setState({ status: 'sending' });
    try {
      const response = await authenticatedFetch(`${API_BASE}/approvals/requests`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ targetType: 'identity.role', targetId: principalId, change: { role }, reason: reason.trim() }),
      });
      const body = await response.json().catch(() => null);
      if (response.status === 202) {
        setState({ status: 'filed' });
        setReason('');
        onFiled();
        return;
      }
      const code = typeof body?.code === 'string' ? body.code : `HTTP_${response.status}`;
      setState({ status: 'refused', text: `${code}: ${typeof body?.message === 'string' ? body.message : 'The board refused the request.'}` });
    } catch {
      setState({ status: 'refused', text: 'The request could not be sent.' });
    }
  };
  return (
    <details className="change-request-item">
      <summary>Ask for a different role</summary>
      <p className="change-request-muted">An administrator decides it on the approvals hub. You may ask for a role up to editor.</p>
      <div className="form-group">
        <label htmlFor={`${idBase}-role`}>Role</label>
        <Select id={`${idBase}-role`} value={role} onChange={(event) => setRole(event.target.value)}>
          {SELF_REQUESTABLE_ROLES.map((value) => <option key={value} value={value}>{value}</option>)}
        </Select>
      </div>
      <div className="form-group">
        <label htmlFor={`${idBase}-reason`}>Reason <span className="change-request-muted">{REASON_MIN}-{REASON_MAX} characters</span></label>
        <textarea id={`${idBase}-reason`} className="form-input" value={reason} onChange={(event) => setReason(event.target.value)} />
      </div>
      {state.status === 'filed' && <p role="status">Filed. It is listed below until a person decides it.</p>}
      {state.status === 'refused' && <p role="alert">{state.text}</p>}
      <div className="change-request-actions">
        <Button variant="primary" size="compact" icon={<Send size={16} />}
          disabled={state.status === 'sending' || length < REASON_MIN || length > REASON_MAX}
          onClick={() => { void file(); }}>
          {state.status === 'sending' ? 'Working…' : 'Ask for this role'}
        </Button>
      </div>
    </details>
  );
};

/**
 * MY REQUESTS (change-request design section 9.4; card 502fb19e, slice S3): a
 * tab of the notification centre beside Approvals, listing the change requests
 * this session's Account or an identity under it filed — read from the hub's
 * own view, where the server marks the requester's items (`view: requester`)
 * and sends them the field diff only, never the relationship diff and never
 * who decided. A pending request the Account filed itself is withdrawn here
 * (`POST /approvals/{id}/withdraw`); a Connector's filing is withdrawn by that
 * Connector.
 */
export const MyRequests: React.FC = () => {
  const { me } = useMyPrincipal();
  const [list, setList] = useState<ListState>({ status: 'loading' });
  const [busyId, setBusyId] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);

  const load = useCallback(async () => {
    setList({ status: 'loading' });
    try {
      const response = await authenticatedFetch(`${API_BASE}/approvals?view=hub&status=all&kind=change`);
      const body = response.ok ? await response.json().catch(() => null) : null;
      if (!body || !Array.isArray(body.approvals)) { setList({ status: 'failed' }); return; }
      setList({ status: 'ready', items: (body.approvals as ApprovalItem[]).filter((item) => item.view === 'requester') });
    } catch {
      setList({ status: 'failed' });
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const withdraw = async (item: ApprovalItem) => {
    setBusyId(item.id);
    setFailure(null);
    try {
      const response = await authenticatedFetch(`${API_BASE}/approvals/${encodeURIComponent(item.id)}/withdraw`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
      });
      if (!response.ok) {
        const body = await response.json().catch(() => null);
        setFailure(typeof body?.message === 'string' ? body.message : `Withdrawing failed (${response.status}).`);
      }
      await load();
    } finally {
      setBusyId(null);
    }
  };

  return (
    <section className="notifications-page-panel" aria-labelledby="my-requests-heading">
      <div className="notifications-page-toolbar">
        <h2 id="my-requests-heading">My requests</h2>
        <Button variant="secondary" size="compact" icon={<RefreshCw size={16} />} onClick={() => { void load(); }} ariaLabel="Refresh my requests">Refresh</Button>
      </div>
      <p className="change-request-muted">
        The changes you asked for, newest first, with what each would change. A person who may make a change decides
        it; who decided is not shown here.
      </p>
      {me?.id && <RequestRoleChange principalId={me.id} onFiled={() => { void load(); }} />}
      {failure && <p role="alert">{failure}</p>}
      {list.status === 'loading' && (
        <div className="notifications-page-state" role="status"><Loader2 className="axm-spin" aria-hidden="true" /> Loading your requests…</div>
      )}
      {list.status === 'failed' && (
        <div className="notifications-page-failed" role="alert">
          <span>Couldn&rsquo;t load your requests.</span>
          <Button variant="secondary" size="compact" onClick={() => { void load(); }}>Retry</Button>
        </div>
      )}
      {list.status === 'ready' && list.items.length === 0 && <p className="notifications-page-state">You have no change requests.</p>}
      {list.status === 'ready' && list.items.length > 0 && (
        <ul className="change-request-list">
          {list.items.map((item) => {
            const targetType = item.change?.targetType ?? '';
            const own = me?.id === item.requesterPrincipalId;
            return (
              <li key={item.id} className="change-request-item">
                <div className="change-request-item-head">
                  <span className={`axm-status axm-status--${item.status}`}>{item.status}</span>
                  <strong>{changeTargetLabel(targetType)}</strong>
                  {item.change?.granteePrincipalId && item.change.granteePrincipalId !== item.requesterPrincipalId && (
                    <span>for {item.change.granteeHandle ?? item.change.granteePrincipalId}</span>
                  )}
                  <time dateTime={item.requestedAt}>{formatDateTime(item.requestedAt, item.requestedAt)}</time>
                </div>
                <BeforeAndAfter fields={item.fieldDiff ?? []} headingLevel={3} />
                {item.lapseReason && <p className="change-request-muted">Lapsed: {item.lapseReason}</p>}
                {item.denialReason && <p className="change-request-muted">Denied: {item.denialReason}</p>}
                {item.change?.appliedAt && <p className="change-request-muted">Applied {formatDateTime(item.change.appliedAt, item.change.appliedAt)}.</p>}
                {item.status === 'pending' && own && (
                  <div className="change-request-actions">
                    <Button variant="secondary" size="compact" icon={<Undo2 size={16} />} disabled={busyId !== null}
                      ariaLabel={`Withdraw: ${changeTargetLabel(targetType)}, ${formatDateTime(item.requestedAt, item.requestedAt)}`}
                      onClick={() => { void withdraw(item); }}>
                      {busyId === item.id ? 'Working…' : 'Withdraw'}
                    </Button>
                  </div>
                )}
                {item.status === 'pending' && !own && (
                  <p className="change-request-muted">Filed by one of your connectors: it withdraws it.</p>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
};
