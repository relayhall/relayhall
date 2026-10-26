import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { Loader2, PenLine } from 'lucide-react';
import { Button } from '../Button';
import { Select } from '../ui/Select';
import { principalLabel, type StepUpRequest } from './accessShared';
import type { Principal } from '../../types/task';
import { authenticatedFetch } from '../../utils/auth';
import { formatDateTime } from '../../utils/dateFormat';

const API_BASE = import.meta.env.VITE_API_BASE_URL || '/api';

/** The step-up actions the board binds an add and a remove to (card 549cc51f). */
export const SHARED_WRITER_STEP_UP_ACTIONS = {
  add: 'knowledge.shared-writer.add',
  remove: 'knowledge.shared-writer.remove',
} as const;

/** The audit action family, as the ledger spells it. */
export const SHARED_WRITER_AUDIT_PREFIX = 'knowledge.shared_writer';

export const SHARED_WRITER_REASON_MIN = 20;
export const SHARED_WRITER_REASON_MAX = 2000;

export interface SharedWriterRow {
  accountId: string;
  label: string;
  active: boolean;
  addedBy: { id: string; label: string } | null;
  addedAt: string;
  reason: string;
  expiresAt: string | null;
  approvalId: string | null;
  origin: 'direct' | 'approval';
}

interface ListAnswer {
  source: { id: string; slug: string; name: string };
  scope: string;
  writers: SharedWriterRow[];
}

type PanelState =
  | { kind: 'loading' }
  | { kind: 'hidden' }
  | { kind: 'ready'; list: ListAnswer }
  | { kind: 'needs-source'; message: string }
  | { kind: 'no-source'; message: string }
  | { kind: 'failed'; message: string };

/** One fresh retry token per act: the board stores the first answer under it. */
function retryKey(): string {
  return typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `shared-writer-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

/** A refusal keeps the server's own sentence and its code: the codes are what an administrator acts on. */
async function readAnswer(response: Response): Promise<any> {
  const data = await response.json().catch(() => ({}));
  if (!response.ok || data.success === false) {
    const message = data.message || data.error || `Request failed (${response.status})`;
    const error = new Error(data.code ? `${message} (${data.code})` : message) as Error & { status?: number; code?: string };
    error.status = response.status;
    error.code = data.code;
    throw error;
  }
  return data;
}

/**
 * THE SHARED-AREA WRITER LIST (card 549cc51f; owner rulings E298, E299, E310).
 *
 * A knowledge source's organisation-wide shared area is readable by everyone
 * the source admits and writable only by the Accounts on this list. Adding and
 * removing are administrator acts: a root or administrator login session, a
 * reason, and a step-up on EVERY change, each change audited with the before
 * and after list and delivered to the source in its next signed snapshot
 * (about 15 seconds, plus the source's 5-second refresh).
 *
 * WHO SEES IT. The page mounts this panel for administrator sessions only, and
 * the panel asks the board for the administration view of the list; a session
 * the board refuses that view to (403) renders NOTHING, not an error. The
 * board is the authority both ways: a panel shown by mistake can do nothing
 * the route refuses, and the route refuses every change but an
 * administrator's.
 *
 * WHAT IT OFFERS. The Account picker lists active, parentless human Accounts
 * not already on the list (the only identities the board accepts: Connectors,
 * Agents, Groups and service identities are refused by name), never the
 * internal `system` actor. Nothing is decided here that the board does not
 * decide again.
 */
export const SharedWritersPanel: React.FC<{
  principals: Principal[];
  requestStepUp: (request: StepUpRequest) => void;
  surface: (kind: 'notice' | 'error', message: string) => void;
  /** Whether this deployment serves the audit log page the trail link opens. */
  auditTrailAvailable: boolean;
}> = ({ principals, requestStepUp, surface, auditTrailAvailable }) => {
  const [state, setState] = useState<PanelState>({ kind: 'loading' });
  const [sourceId, setSourceId] = useState('');
  const [sourceDraft, setSourceDraft] = useState('');
  const [accountId, setAccountId] = useState('');
  const [reason, setReason] = useState('');
  const [expiresAt, setExpiresAt] = useState('');
  const [removing, setRemoving] = useState<SharedWriterRow | null>(null);
  const [removeReason, setRemoveReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<{ kind: 'notice' | 'error'; message: string } | null>(null);

  const load = useCallback(async () => {
    const query = new URLSearchParams({ view: 'administration' });
    if (sourceId) query.set('source', sourceId);
    try {
      const data = await readAnswer(await authenticatedFetch(`${API_BASE}/knowledge-shared-writers?${query.toString()}`));
      // An answer without the list's shape (no source object, no writers
      // array) is not the writer list: the panel renders nothing rather than
      // guess. The board always answers the shape; this keeps a page that
      // mounts the panel beside other requests from failing on a stray answer.
      if (!data || typeof data.source !== 'object' || data.source === null || !Array.isArray(data.writers)) {
        setState({ kind: 'hidden' });
        return;
      }
      setState({ kind: 'ready', list: { source: data.source, scope: data.scope, writers: data.writers } });
    } catch (err) {
      const failure = err as Error & { status?: number; code?: string };
      if (failure.status === 401 || failure.status === 403) { setState({ kind: 'hidden' }); return; }
      if (failure.code === 'SHARED_WRITER_SOURCE_REQUIRED') { setState({ kind: 'needs-source', message: failure.message }); return; }
      if (failure.code === 'SHARED_WRITER_SOURCE_NOT_FOUND') { setState({ kind: 'no-source', message: failure.message }); return; }
      setState({ kind: 'failed', message: failure.message || 'The writer list could not be read' });
    }
  }, [sourceId]);

  useEffect(() => { void load(); }, [load]);

  const listed = useMemo(
    () => new Set(state.kind === 'ready' ? state.list.writers.map((writer) => writer.accountId) : []),
    [state],
  );
  const candidates = useMemo(
    () => principals.filter((candidate) => candidate.kind === 'human'
      && candidate.status === 'active'
      && !candidate.parentPrincipalId
      && candidate.handle !== 'system'
      && !listed.has(candidate.id)),
    [principals, listed],
  );

  if (state.kind === 'hidden') return null;

  const source = state.kind === 'ready' ? state.list.source : null;
  const reasonProblem = (value: string): string | null => {
    const length = value.trim().length;
    if (length === 0) return null;
    if (length < SHARED_WRITER_REASON_MIN) return `A reason is at least ${SHARED_WRITER_REASON_MIN} characters.`;
    if (length > SHARED_WRITER_REASON_MAX) return `A reason is at most ${SHARED_WRITER_REASON_MAX} characters.`;
    return null;
  };
  const reasonOk = (value: string) => {
    const length = value.trim().length;
    return length >= SHARED_WRITER_REASON_MIN && length <= SHARED_WRITER_REASON_MAX;
  };

  const report = (kind: 'notice' | 'error', message: string) => {
    setOutcome({ kind, message });
    surface(kind, message);
  };

  const send = async (path: string, body: Record<string, unknown>) => readAnswer(await authenticatedFetch(`${API_BASE}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Idempotency-Key': retryKey() },
    body: JSON.stringify(body),
  }));

  const add = (event: React.FormEvent) => {
    event.preventDefault();
    if (!source || !accountId || !reasonOk(reason)) return;
    const target = candidates.find((candidate) => candidate.id === accountId);
    const label = target ? principalLabel(target) : accountId;
    let expiry: string | null = null;
    if (expiresAt) {
      const at = new Date(expiresAt);
      if (Number.isNaN(at.getTime())) { report('error', 'The expiry is not a date and time this page can read.'); return; }
      expiry = at.toISOString();
    }
    requestStepUp({
      action: SHARED_WRITER_STEP_UP_ACTIONS.add,
      targetId: accountId,
      description: `Add ${label} to the shared-area writer list of ${source.name}. They will be able to write notes everyone who can use this knowledge source reads. The change is audited and reaches the source within about 20 seconds.`,
      onToken: async (stepUpToken) => {
        setBusy(true);
        setOutcome(null);
        try {
          await send('/knowledge-shared-writers', {
            source: source.id, accountId, reason: reason.trim(), stepUpToken, ...(expiry ? { expiresAt: expiry } : {}),
          });
          report('notice', `${label} can now write the shared area of ${source.name}.`);
          setAccountId('');
          setReason('');
          setExpiresAt('');
          await load();
        } catch (err) {
          report('error', err instanceof Error ? err.message : 'The Account could not be added');
        } finally {
          setBusy(false);
        }
      },
    });
  };

  const remove = (event: React.FormEvent) => {
    event.preventDefault();
    if (!source || !removing || !reasonOk(removeReason)) return;
    const row = removing;
    requestStepUp({
      action: SHARED_WRITER_STEP_UP_ACTIONS.remove,
      targetId: row.accountId,
      description: `Remove ${row.label} from the shared-area writer list of ${source.name}. Notes they already wrote stay; they can no longer write there once the source reads its next snapshot.`,
      onToken: async (stepUpToken) => {
        setBusy(true);
        setOutcome(null);
        try {
          await send('/knowledge-shared-writers/remove', {
            source: source.id, accountId: row.accountId, reason: removeReason.trim(), stepUpToken,
          });
          report('notice', `${row.label} can no longer write the shared area of ${source.name}.`);
          setRemoving(null);
          setRemoveReason('');
          await load();
        } catch (err) {
          report('error', err instanceof Error ? err.message : 'The Account could not be removed');
        } finally {
          setBusy(false);
        }
      },
    });
  };

  const addReasonProblem = reasonProblem(reason);
  const removeReasonProblem = reasonProblem(removeReason);

  return (
    <section className="axm-section" aria-labelledby="axm-shared-writers-heading">
      <div className="axm-section-head">
        <h2 id="axm-shared-writers-heading"><PenLine aria-hidden="true" /> Shared-area writers</h2>
        {auditTrailAvailable && (
          <Link to={`/audit?actionPrefix=${SHARED_WRITER_AUDIT_PREFIX}`}>Audit trail of these changes</Link>
        )}
      </div>
      <p className="axm-section-intro">
        Everyone who can use a knowledge source can read its organisation-wide shared area; only the
        Accounts listed here can write it. Adding or removing an Account is an administrator act: it
        needs a reason and a step-up every time, it is audited with the list before and after, and the
        source applies it within about 20 seconds. Only people&rsquo;s Accounts can be listed &mdash;
        never a connection, an agent or a Group.
      </p>

      {state.kind === 'loading' && (
        <div className="axm-state" role="status"><Loader2 className="axm-spin" aria-hidden="true" /> Reading the writer list&hellip;</div>
      )}
      {state.kind === 'failed' && <div className="axm-error" role="alert">{state.message}</div>}
      {state.kind === 'no-source' && <p className="axm-muted" role="status">{state.message}. The writer list appears here once a knowledge source accepts writes.</p>}
      {state.kind === 'needs-source' && (
        <form
          className="axm-editor"
          aria-label="Choose a knowledge source"
          onSubmit={(event) => { event.preventDefault(); setSourceId(sourceDraft.trim()); }}
        >
          <p className="axm-muted" role="status">{state.message}</p>
          <div className="form-group">
            <label htmlFor="axm-shared-writers-source">Knowledge source id</label>
            <input
              id="axm-shared-writers-source"
              className="form-input"
              value={sourceDraft}
              onChange={(event) => setSourceDraft(event.target.value)}
              required
            />
          </div>
          <div className="axm-decide-actions">
            <Button type="submit" variant="secondary" disabled={!sourceDraft.trim()}>Show its writers</Button>
          </div>
        </form>
      )}

      {state.kind === 'ready' && (
        <>
          <p className="axm-muted">
            Knowledge source: <strong>{state.list.source.name}</strong> ({state.list.source.slug}) &middot; scope: {state.list.scope}
          </p>
          {state.list.writers.length === 0 ? (
            <p className="axm-empty" role="status">Nobody can write this shared area yet.</p>
          ) : (
            <ul className="axm-list" aria-label="Accounts that can write the shared area">
              {state.list.writers.map((writer) => (
                <li key={writer.accountId} className="axm-item">
                  <div className="axm-item-row">
                    <div className="axm-item-title">
                      <strong>{writer.label}</strong>
                      {!writer.active && <small> &middot; not active, so the source does not receive it</small>}
                    </div>
                    <Button
                      type="button"
                      variant="secondary"
                      onClick={() => { setRemoving(writer); setRemoveReason(''); setOutcome(null); }}
                      ariaLabel={`Remove ${writer.label}`}
                    >
                      Remove
                    </Button>
                  </div>
                  <p className="axm-item-meta">
                    Added by {writer.addedBy?.label ?? 'an identity that no longer exists'} on {formatDateTime(writer.addedAt)}
                    {' '}&middot; {writer.expiresAt ? `expires ${formatDateTime(writer.expiresAt)}` : 'does not expire'}
                    {' '}&middot; origin: {writer.origin === 'approval' ? 'an approved request' : 'added directly'}
                  </p>
                  <p className="axm-item-meta">Reason: {writer.reason}</p>
                </li>
              ))}
            </ul>
          )}

          {removing && (
            <form className="axm-editor" onSubmit={remove} aria-label={`Remove ${removing.label} from the writer list`}>
              <div className="form-group">
                <label htmlFor="axm-shared-writers-remove-reason">Why remove {removing.label}?</label>
                <textarea
                  id="axm-shared-writers-remove-reason"
                  className="form-input axm-deny-reason"
                  value={removeReason}
                  onChange={(event) => setRemoveReason(event.target.value)}
                  aria-describedby="axm-shared-writers-remove-reason-help"
                  required
                />
                <span id="axm-shared-writers-remove-reason-help" className="axm-muted">
                  {removeReasonProblem ?? `${SHARED_WRITER_REASON_MIN}-${SHARED_WRITER_REASON_MAX} characters, kept in the audit record.`}
                </span>
              </div>
              <div className="axm-decide-actions">
                <Button type="button" variant="secondary" onClick={() => setRemoving(null)}>Cancel</Button>
                <Button type="submit" variant="primary" disabled={busy || !reasonOk(removeReason)}>
                  {busy ? 'Removing…' : 'Remove with step-up'}
                </Button>
              </div>
            </form>
          )}

          <form className="axm-editor" onSubmit={add} aria-label="Add a shared-area writer">
            <div className="axm-editor-grid">
              <div className="form-group">
                <label htmlFor="axm-shared-writers-account">Account</label>
                <Select
                  id="axm-shared-writers-account"
                  required
                  value={accountId}
                  onChange={(event) => { setAccountId(event.target.value); setOutcome(null); }}
                >
                  <option value="">Choose an Account&hellip;</option>
                  {candidates.map((candidate) => (
                    <option key={candidate.id} value={candidate.id}>{principalLabel(candidate)}</option>
                  ))}
                </Select>
              </div>
              <div className="form-group">
                <label htmlFor="axm-shared-writers-expiry">
                  Expires{' '}<span className="axm-muted">optional; empty means never</span>
                </label>
                <input
                  id="axm-shared-writers-expiry"
                  className="form-input"
                  type="datetime-local"
                  value={expiresAt}
                  onChange={(event) => setExpiresAt(event.target.value)}
                />
              </div>
            </div>
            <div className="form-group">
              <label htmlFor="axm-shared-writers-reason">Why can this Account write the shared area?</label>
              <textarea
                id="axm-shared-writers-reason"
                className="form-input"
                value={reason}
                onChange={(event) => setReason(event.target.value)}
                aria-describedby="axm-shared-writers-reason-help"
                required
              />
              <span id="axm-shared-writers-reason-help" className="axm-muted">
                {addReasonProblem ?? `${SHARED_WRITER_REASON_MIN}-${SHARED_WRITER_REASON_MAX} characters, kept in the audit record.`}
              </span>
            </div>
            <div className="axm-decide-actions">
              <Button type="submit" variant="primary" disabled={busy || !accountId || !reasonOk(reason)}>
                {busy ? 'Adding…' : 'Add with step-up'}
              </Button>
            </div>
          </form>
        </>
      )}

      {outcome && (
        <div className={outcome.kind === 'error' ? 'axm-error' : 'axm-notice'} role={outcome.kind === 'error' ? 'alert' : 'status'}>
          {outcome.message}
        </div>
      )}
    </section>
  );
};
