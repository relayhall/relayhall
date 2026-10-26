import React, { useState } from 'react';
import { Eraser, Loader2 } from 'lucide-react';
import { Button } from '../Button';
import { StepUpDialog } from './StepUpDialog';
import { authenticatedFetch } from '../../utils/auth';

const API_BASE = import.meta.env.VITE_API_BASE_URL || '/api';

/** The server's cap per call (owner ruling E413). */
export const BULK_REVOKE_BATCH = 500;
/** The grants list's own page cap (GET /grants `limit`). */
export const CLEANUP_LIST_PAGE = 200;

export type CleanupVerdict = 'redundant' | 'effective' | 'unevaluable' | 'assignment' | 'missing' | 'expired';
const VERDICTS: CleanupVerdict[] = ['redundant', 'effective', 'unevaluable', 'assignment', 'missing', 'expired'];
const VERDICT_LABELS: Record<CleanupVerdict, string> = {
  redundant: 'Change nobody’s access (will be revoked)',
  effective: 'Still give access (kept)',
  unevaluable: 'Cannot be checked (kept)',
  assignment: 'Carry an assignment (kept)',
  missing: 'No longer exist',
  expired: 'Expired (kept)',
};

interface CleanupResult {
  id: string;
  verdict: CleanupVerdict;
  reason: string;
  grant?: { granteeId: string; resourceType: string; resourceId: string | null; verb: string };
}
interface CheckedBatch { results: CleanupResult[]; redundantIds: string[]; redundantIdSetHash: string | null }
interface RunOutcome { batch: number; removed: number; kept: number; rolledBack: boolean }

interface GrantCleanupProps {
  /** The grants list URL for the CURRENT filter, one page after `cursor`. */
  pageUrl: (cursor: string | null, limit: number) => string;
  /** Called after the last batch ran, so the list is read again. */
  onFinished: () => void;
}

async function readJson(response: Response): Promise<any> {
  return response.json().catch(() => ({}));
}

function failure(data: any, fallback: string): string {
  return `${data?.code ? `${data.code}: ` : ''}${data?.message || data?.error || fallback}`;
}

/**
 * Owner ruling E413: "Clean up redundant grants" on the Access page. It reads
 * the ids the current filter shows (page by page), asks the board for a DRY
 * RUN of at most 500 at a time (the authorization engine decides, nothing is
 * written), shows the counts by verdict and a sample, and only then runs the
 * real batches, each after its own step-up bound to exactly the ids that
 * batch revokes. Every answer is shown as the board gave it; nothing is
 * retried automatically.
 */
export const GrantCleanup: React.FC<GrantCleanupProps> = ({ pageUrl, onFinished }) => {
  const [phase, setPhase] = useState<'idle' | 'checking' | 'checked' | 'running'>('idle');
  const [progress, setProgress] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [batches, setBatches] = useState<CheckedBatch[]>([]);
  const [outcomes, setOutcomes] = useState<RunOutcome[]>([]);
  const [asking, setAsking] = useState<number | null>(null);

  const runnable = batches.map((batch, index) => ({ batch, index })).filter(({ batch }) => batch.redundantIds.length > 0);
  const nextRunnable = runnable.find(({ index }) => !outcomes.some((outcome) => outcome.batch === index));
  const counts = VERDICTS.map((verdict) => [verdict, batches.reduce((sum, batch) => sum + batch.results.filter((r) => r.verdict === verdict).length, 0)] as const);
  const checkedTotal = batches.reduce((sum, batch) => sum + batch.results.length, 0);
  const sample = batches.flatMap((batch) => batch.results).filter((r) => r.verdict === 'redundant').slice(0, 8);
  const kept = batches.flatMap((batch) => batch.results).filter((r) => r.verdict !== 'redundant' && r.verdict !== 'missing').slice(0, 4);

  const dryRun = async (ids: string[]): Promise<CheckedBatch> => {
    const response = await authenticatedFetch(`${API_BASE}/grants/bulk-revoke`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ids, dryRun: true }),
    });
    const data = await readJson(response);
    if (!response.ok || !data.success) throw new Error(failure(data, 'The dry run failed'));
    const results: CleanupResult[] = Array.isArray(data.results) ? data.results : [];
    return {
      results,
      redundantIds: results.filter((r) => r.verdict === 'redundant').map((r) => r.id),
      redundantIdSetHash: typeof data.redundantIdSetHash === 'string' ? data.redundantIdSetHash : null,
    };
  };

  const check = async () => {
    setPhase('checking'); setError(null); setBatches([]); setOutcomes([]);
    const found: CheckedBatch[] = [];
    let pending: string[] = [];
    let cursor: string | null = null;
    let read = 0;
    try {
      do {
        const response = await authenticatedFetch(pageUrl(cursor, CLEANUP_LIST_PAGE));
        const data = await readJson(response);
        if (!response.ok || !data.success) throw new Error(failure(data, 'Could not read the grants in this view'));
        const ids: string[] = (Array.isArray(data.grants) ? data.grants : []).map((g: { id: string }) => g.id);
        read += ids.length;
        pending.push(...ids);
        cursor = data.pagination?.nextCursor ?? null;
        while (pending.length >= BULK_REVOKE_BATCH || (cursor === null && pending.length > 0)) {
          const chunk = pending.slice(0, BULK_REVOKE_BATCH);
          pending = pending.slice(BULK_REVOKE_BATCH);
          found.push(await dryRun(chunk));
          setProgress(`Checked ${found.reduce((sum, b) => sum + b.results.length, 0)} of ${read} grants read so far…`);
        }
      } while (cursor !== null);
      setBatches(found);
      setPhase('checked');
    } catch (caught) {
      setBatches(found);
      setError(caught instanceof Error ? caught.message : 'The dry run failed');
      setPhase(found.length > 0 ? 'checked' : 'idle');
    }
  };

  const runBatch = async (index: number, stepUpToken: string) => {
    setAsking(null); setPhase('running'); setError(null);
    const batch = batches[index];
    try {
      const response = await authenticatedFetch(`${API_BASE}/grants/bulk-revoke`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids: batch.redundantIds, dryRun: false, stepUpToken }),
      });
      const data = await readJson(response);
      if (!response.ok || !data.success) throw new Error(failure(data, 'The batch was not run'));
      const outcome: RunOutcome = {
        batch: index, removed: Number(data.removed ?? 0), rolledBack: data.rolledBack === true,
        kept: Array.isArray(data.results) ? data.results.filter((r: CleanupResult & { removed?: boolean }) => !r.removed).length : 0,
      };
      const done = [...outcomes, outcome];
      setOutcomes(done);
      if (runnable.every(({ index: i }) => done.some((o) => o.batch === i))) onFinished();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'The batch was not run');
    } finally {
      setPhase('checked');
    }
  };

  const batchNumber = (index: number) => runnable.findIndex(({ index: i }) => i === index) + 1;

  return (
    <section className="grants-cleanup" aria-labelledby="grants-cleanup-heading">
      <h3 id="grants-cleanup-heading">Clean up redundant grants</h3>
      <p className="grants-intro">
        Checks every grant in the current view with the authorization engine and revokes only those that change nobody’s access.
        The check writes nothing; each revoke batch of up to {BULK_REVOKE_BATCH} grants asks you to confirm it is you, is audited per grant,
        and is rolled back whole if anyone’s access would change.
      </p>
      {error && <div className="grants-error" role="alert">{error}</div>}
      <div className="grants-cleanup-actions">
        <Button type="button" variant="secondary" icon={phase === 'checking' ? <Loader2 size={16} className="grants-spin" aria-hidden="true" /> : <Eraser size={16} aria-hidden="true" />}
          disabled={phase === 'checking' || phase === 'running'} onClick={() => { void check(); }}>
          {phase === 'checking' ? 'Checking…' : batches.length > 0 ? 'Check this view again' : 'Check this view (dry run)'}
        </Button>
        {nextRunnable && phase !== 'checking' && (
          <Button type="button" variant="danger" disabled={phase === 'running' || asking !== null} onClick={() => setAsking(nextRunnable.index)}>
            {`Revoke batch ${batchNumber(nextRunnable.index)} of ${runnable.length} (${nextRunnable.batch.redundantIds.length} grant${nextRunnable.batch.redundantIds.length === 1 ? "" : "s"})`}
          </Button>
        )}
      </div>
      <p className="grants-list-summary" aria-live="polite">
        {phase === 'checking' ? progress : phase === 'running' ? 'Revoking one batch…' : ''}
      </p>
      {batches.length > 0 && (
        <div className="grants-cleanup-result">
          <h4>Dry run: {checkedTotal} grants checked</h4>
          <dl className="grants-cleanup-counts">
            {counts.map(([verdict, n]) => (
              <div key={verdict}><dt>{VERDICT_LABELS[verdict]}</dt><dd>{n}</dd></div>
            ))}
          </dl>
          {sample.length > 0 && (
            <>
              <h4>Sample of grants to revoke</h4>
              <ul className="grants-cleanup-sample">
                {sample.map((r) => (
                  <li key={r.id}><code>{r.id}</code> {r.grant ? `${r.grant.verb} · ${r.grant.resourceType} · ${r.grant.resourceId ?? 'every resource'}` : ''}<small>{r.reason}</small></li>
                ))}
              </ul>
            </>
          )}
          {kept.length > 0 && (
            <>
              <h4>Sample of grants kept</h4>
              <ul className="grants-cleanup-sample">
                {kept.map((r) => (<li key={r.id}><code>{r.id}</code> {VERDICT_LABELS[r.verdict]}<small>{r.reason}</small></li>))}
              </ul>
            </>
          )}
          {outcomes.length > 0 && (
            <ul className="grants-cleanup-outcomes" aria-label="Revoke batches run">
              {outcomes.map((o) => (
                <li key={o.batch}>
                  {`Batch ${batchNumber(o.batch)}: `}
                  {o.rolledBack
                    ? 'rolled back — someone’s access would have changed, so nothing was revoked'
                    : `${o.removed} revoked, ${o.kept} kept after the live re-check`}
                </li>
              ))}
            </ul>
          )}
          {runnable.length === 0 && phase === 'checked' && <p className="grants-notice" role="status">Nothing in this view can be revoked: every grant still changes someone’s access or cannot be checked.</p>}
        </div>
      )}
      {asking !== null && batches[asking]?.redundantIdSetHash && (
        <StepUpDialog
          action="grant.bulk_revoke"
          targetId={batches[asking].redundantIdSetHash as string}
          description={`Revoke ${batches[asking].redundantIds.length} grants that change nobody’s access (batch ${batchNumber(asking)} of ${runnable.length}).`}
          onToken={(token) => { void runBatch(asking, token); }}
          onCancel={() => setAsking(null)}
        />
      )}
    </section>
  );
};
