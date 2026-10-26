import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { Loader2, X } from 'lucide-react';
import { Button } from '../Button';
import { IconButton } from '../ui/IconButton';
import { authenticatedFetch } from '../../utils/auth';
import { formatDateTime, formatInstantUtc } from '../../utils/dateFormat';
import { isIntentionalAbort } from '../../utils/fetchAbort';
import { useFocusTrap } from '../../hooks/useFocusTrap';
import { approvalKind, approvalKindLabel, type ApprovalEvent, type ApprovalItem } from './approvals';
import './ApprovalDrawer.css';

const API_BASE = import.meta.env.VITE_API_BASE_URL || '/api';

type DrawerState =
  | { status: 'loading' }
  | { status: 'missing' }
  | { status: 'failed' }
  | { status: 'ready'; approval: ApprovalItem; events: ApprovalEvent[] };

/**
 * The ledger's own action words (`approval_events.action`: migration 098's
 * CHECK, widened by 142 with `approval.revoked` and by 158 with the change
 * ledger rows `approval.applied`, `approval.export_stalled` and
 * `approval.reverted`). Lane L1 keyed this map by
 * the bare words ("requested") the server never stores, so every row rendered
 * its raw action name; the keys are now the stored values, pinned against the
 * backend literal set in ApprovalDrawer.test.tsx.
 */
export const ACTION_LABELS: Record<string, string> = {
  'approval.requested': 'Requested',
  'approval.approved': 'Approved',
  'approval.denied': 'Denied',
  'approval.collected': 'Collected',
  'approval.lapsed': 'Lapsed',
  // AZ-A9 clause 12a: what a request made was revoked at the related task's
  // or phase's terminal.
  'approval.revoked': 'Revoked',
  // Migration 158, change requests: the approved change took effect (for
  // plugin state, the export generation that first carried it; for a
  // two-step secret, its collect).
  'approval.applied': 'Applied',
  // The exporter has not carried the approved row 20 generations after its
  // decide: the subject or Project left the exporter's selection.
  'approval.export_stalled': 'Not exported',
  // The change was undone at the end of its approved lifetime.
  'approval.reverted': 'Reverted',
};

/** An action this page has not learned reads as itself, never as another. */
export function actionLabel(action: string): string {
  return ACTION_LABELS[action] ?? action;
}

function hasDetail(metadata: ApprovalEvent['metadata']): metadata is Record<string, unknown> {
  return metadata !== null && typeof metadata === 'object' && Object.keys(metadata).length > 0;
}

/**
 * THE ITEM DRAWER (design T11; card b1e3b16d, lane L1).
 *
 * `GET /approvals/:id` has always returned the approval's own ledger
 * (`approval_events`: requested, approved, denied, collected, lapsed) and no
 * screen ever showed it — the Access manager calls only the list and the
 * decide routes. This drawer is that ledger, newest first, with who did each
 * step and when. Related audit rows and the resulting objects (grants, the
 * minted identity) are lane L3's server-side merge; the drawer says which
 * ledger it reads rather than implying a complete history.
 *
 * CONCEALMENT. The route answers 404 for an item outside this session's
 * self-scope exactly as for one that does not exist, and the drawer renders
 * both the same way — it gives no hint that a concealed item is real.
 */
export const ApprovalDrawer: React.FC<{ approvalId: string; onClose: () => void }> = ({ approvalId, onClose }) => {
  const [state, setState] = useState<DrawerState>({ status: 'loading' });
  const [attempt, setAttempt] = useState(0);
  const drawerRef = useRef<HTMLDivElement>(null);
  useFocusTrap(drawerRef);

  useEffect(() => {
    const controller = new AbortController();
    setState({ status: 'loading' });
    (async () => {
      try {
        const response = await authenticatedFetch(`${API_BASE}/approvals/${encodeURIComponent(approvalId)}`, { signal: controller.signal });
        if (response.status === 404) { setState({ status: 'missing' }); return; }
        const data = response.ok ? await response.json().catch(() => null) : null;
        if (!data || !data.approval || !Array.isArray(data.events)) { setState({ status: 'failed' }); return; }
        setState({ status: 'ready', approval: data.approval as ApprovalItem, events: data.events as ApprovalEvent[] });
      } catch (caught) {
        if (!isIntentionalAbort(caught, controller.signal)) setState({ status: 'failed' });
      }
    })();
    return () => controller.abort();
  }, [approvalId, attempt]);

  const retry = useCallback(() => setAttempt((value) => value + 1), []);

  return (
    <div className="approval-drawer-scrim" onClick={onClose} data-testid="approval-drawer-scrim">
      <div
        className="approval-drawer"
        role="dialog"
        aria-modal="true"
        aria-labelledby="approval-drawer-heading"
        tabIndex={-1}
        ref={drawerRef}
        onClick={(event) => event.stopPropagation()}
        onKeyDown={(event) => { if (event.key === 'Escape') { event.stopPropagation(); onClose(); } }}
      >
        <div className="approval-drawer-head">
          <h2 id="approval-drawer-heading">Approval history</h2>
          <IconButton icon={<X size={16} aria-hidden="true" />} ariaLabel="Close approval history" onClick={onClose} />
        </div>

        {state.status === 'loading' && (
          <div className="approval-drawer-state" role="status"><Loader2 className="axm-spin" aria-hidden="true" /> Loading the approval…</div>
        )}
        {state.status === 'missing' && (
          <p className="approval-drawer-state" role="status">No such approval.</p>
        )}
        {state.status === 'failed' && (
          <div className="approval-drawer-failed" role="alert">
            <span>Couldn&rsquo;t load this approval.</span>
            <Button variant="secondary" size="compact" onClick={retry}>Retry</Button>
          </div>
        )}
        {state.status === 'ready' && (
          <>
            <dl className="approval-drawer-facts">
              <dt>Kind</dt>
              <dd>{state.approval.authorityEdit?.objectKindLabel ?? approvalKindLabel(approvalKind(state.approval))}</dd>
              <dt>Status</dt>
              <dd><span className={`axm-status axm-status--${state.approval.status}`}>{state.approval.status}</span></dd>
              <dt>Requested by</dt>
              <dd>{state.approval.requesterHandle ?? state.approval.requesterPrincipalId}</dd>
              {state.approval.targetTaskId && (
                <>
                  <dt>Task</dt>
                  <dd>
                    <Link className="approval-drawer-link" to={`/tasks/${encodeURIComponent(state.approval.targetTaskId)}`}>
                      {state.approval.targetTaskTitle ?? state.approval.targetTaskId}
                    </Link>
                  </dd>
                </>
              )}
              {/* A grant or credential request (AZ-A9) names no mint target:
                  its grantee Account and the task it is for; a credential
                  request also the scopes it asks for. */}
              {state.approval.accessRequest && (
                <>
                  <dt>Grantee Account</dt>
                  <dd>{state.approval.accessRequest.granteeHandle ?? state.approval.accessRequest.granteePrincipalId}</dd>
                  {approvalKind(state.approval) === 'credential' && (
                    <>
                      <dt>Scopes requested</dt>
                      <dd>{state.approval.requestedScopes.join(', ')}</dd>
                    </>
                  )}
                  {state.approval.accessRequest.relatedTaskId && (
                    <>
                      <dt>Related task</dt>
                      <dd>
                        <Link className="approval-drawer-link" to={`/tasks/${encodeURIComponent(state.approval.accessRequest.relatedTaskId)}`}>
                          {state.approval.accessRequest.relatedTaskTitle ?? state.approval.accessRequest.relatedTaskId}
                        </Link>
                      </dd>
                    </>
                  )}
                </>
              )}
              {state.approval.authorityEdit && (
                <>
                  <dt>Amended object</dt><dd>{state.approval.authorityEdit.objectId}</dd>
                  {state.approval.authorityEdit.diff.map(({ field, before, after }) => (
                    <React.Fragment key={field}>
                      <dt>{field}</dt>
                      <dd>{JSON.stringify(before) ?? 'none'} → {JSON.stringify(after) ?? 'none'}</dd>
                    </React.Fragment>
                  ))}
                  {state.approval.authorityEdit.lifetime && (
                    <><dt>Chosen lifetime</dt><dd>{state.approval.authorityEdit.lifetime.label}{state.approval.authorityEdit.lifetime.revertAt ? `; reverts at ${formatInstantUtc(state.approval.authorityEdit.lifetime.revertAt)}` : ''}</dd></>
                  )}
                </>
              )}
              <dt>Requested</dt>
              <dd><time dateTime={state.approval.requestedAt}>{formatDateTime(state.approval.requestedAt, state.approval.requestedAt)}</time></dd>
              {state.approval.status === 'pending' && state.approval.pendingExpiresAt && (
                <>
                  <dt>Lapses</dt>
                  <dd><time dateTime={state.approval.pendingExpiresAt}>{formatDateTime(state.approval.pendingExpiresAt, state.approval.pendingExpiresAt)}</time></dd>
                </>
              )}
              {state.approval.denialReason && (<><dt>Denial reason</dt><dd>{state.approval.denialReason}</dd></>)}
              {state.approval.lapseReason && (<><dt>Lapse reason</dt><dd>{state.approval.lapseReason}</dd></>)}
            </dl>

            <h3 className="approval-drawer-history-heading">Who did what</h3>
            <p className="approval-drawer-source">From the approval&rsquo;s own ledger, newest first.</p>
            {state.events.length === 0 ? (
              <p className="approval-drawer-state">The ledger has no entries for this approval.</p>
            ) : (
              <ol className="approval-drawer-history">
                {state.events.map((event) => (
                  <li key={String(event.id)} className="approval-drawer-event">
                    <span className="approval-drawer-event-action">{actionLabel(event.action)}</span>
                    <span className="approval-drawer-event-actor">by {event.actorHandle ?? event.actorPrincipalId ?? 'unknown'}</span>
                    <time className="approval-drawer-event-time" dateTime={event.occurredAt}>
                      {formatDateTime(event.occurredAt, event.occurredAt)}
                    </time>
                    {hasDetail(event.metadata) && (
                      <details className="approval-drawer-event-detail">
                        <summary>Recorded detail</summary>
                        <pre>{JSON.stringify(event.metadata, null, 2)}</pre>
                      </details>
                    )}
                  </li>
                ))}
              </ol>
            )}
          </>
        )}
      </div>
    </div>
  );
};
