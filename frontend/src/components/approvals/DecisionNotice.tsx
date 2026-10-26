import React from 'react';
import { Link } from 'react-router-dom';
import { AlertTriangle, Gavel } from 'lucide-react';
import { Button } from '../Button';
import { useMyPrincipal } from '../../hooks/usePrincipals';
import { usePolledResource } from '../../utils/polledResource';
import { approvalKind, approvalKindLabel, countLabel, pendingApprovals, waitingOnYou, type ApprovalItem } from './approvals';
import './DecisionNotice.css';

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

/** "3 h", "2 d", "under an hour" — how long the oldest item has waited. */
export function waitedFor(requestedAt: string, now: number): string {
  const waited = now - new Date(requestedAt).getTime();
  if (!Number.isFinite(waited) || waited < HOUR_MS) return 'under an hour';
  if (waited < DAY_MS) return `${Math.floor(waited / HOUR_MS)} h`;
  return `${Math.floor(waited / DAY_MS)} d`;
}

export interface DecisionSummary {
  count: number;
  byKind: Array<{ kind: string; count: number }>;
  oldestRequestedAt: string | null;
  lapsingWithinDay: number;
}

export function summarizeDecisions(approvals: ApprovalItem[], now: number): DecisionSummary {
  const kinds = new Map<string, number>();
  let oldest: string | null = null;
  let lapsing = 0;
  for (const approval of approvals) {
    const kind = approvalKind(approval);
    kinds.set(kind, (kinds.get(kind) ?? 0) + 1);
    if (oldest === null || new Date(approval.requestedAt).getTime() < new Date(oldest).getTime()) {
      oldest = approval.requestedAt;
    }
    if (approval.pendingExpiresAt) {
      const remaining = new Date(approval.pendingExpiresAt).getTime() - now;
      if (remaining > 0 && remaining <= DAY_MS) lapsing += 1;
    }
  }
  return {
    count: approvals.length,
    byKind: [...kinds.entries()].map(([kind, count]) => ({ kind, count })),
    oldestRequestedAt: oldest,
    lapsingWithinDay: lapsing,
  };
}

/**
 * T1, THE DECISION NOTICE (design B.3; card b1e3b16d, lane L1).
 *
 * "N decisions need you" at the top of the dashboard: the items waiting on
 * THIS session (`waitingOnYou` of the hub's pending read — what this session
 * may decide, skill versions it may publish included), the same read and the
 * same count the bell and the hub show, so the three never disagree. An item
 * someone else decides is not "needing you". Four states, and only one of them
 * is silent:
 *
 *  - loading: nothing, so the dashboard does not flash a count it lacks;
 *  - zero: nothing — there is nothing to decide;
 *  - N: the count, by kind, how long the oldest has waited, how many lapse
 *    within a day, and the way into the hub — the Approvals tab of the
 *    notification centre (owner E84; card e2dd52b8 Part A);
 *  - error (a refusal, a failure, an unreadable body): "Couldn't check pending
 *    decisions" with Retry. NEVER "0": an unknown count said as zero is the
 *    one wrong answer this notice exists to avoid.
 *
 * An identity with no resolved principal has no approval queue (the route
 * refuses it as PRINCIPAL_REQUIRED), so the notice does not ask for one.
 */
export const DecisionNotice: React.FC = () => {
  const { me } = useMyPrincipal();
  const state = usePolledResource(pendingApprovals, Boolean(me));

  if (!me || state.status === 'loading') return null;

  if (state.status === 'error') {
    return (
      <section className="decision-notice decision-notice--failed" aria-label="Pending decisions" role="alert">
        <AlertTriangle size={20} aria-hidden="true" />
        <p className="decision-notice-message">Couldn&rsquo;t check pending decisions.</p>
        <Button variant="secondary" size="compact" onClick={() => { void pendingApprovals.refresh(); }}>Retry</Button>
      </section>
    );
  }

  const summary = summarizeDecisions(waitingOnYou(state.value), Date.now());
  if (summary.count === 0) return null;

  return (
    <section className="decision-notice" aria-label="Pending decisions">
      <Gavel size={20} aria-hidden="true" />
      <div className="decision-notice-body">
        <p className="decision-notice-message">
          <strong>{countLabel(summary.count)} {summary.count === 1 ? 'decision needs' : 'decisions need'} you</strong>
        </p>
        <ul className="decision-notice-facts">
          {summary.byKind.map(({ kind, count }) => (
            <li key={kind}>{approvalKindLabel(kind)}: {count}</li>
          ))}
          {summary.oldestRequestedAt && (
            <li>Oldest waiting {waitedFor(summary.oldestRequestedAt, Date.now())}</li>
          )}
          {summary.lapsingWithinDay > 0 && (
            <li className="decision-notice-lapsing">{summary.lapsingWithinDay} {summary.lapsingWithinDay === 1 ? 'lapses' : 'lapse'} within 24 h</li>
          )}
        </ul>
      </div>
      <Link className="decision-notice-link" to="/action-center?tab=approvals">Review decisions</Link>
    </section>
  );
};
