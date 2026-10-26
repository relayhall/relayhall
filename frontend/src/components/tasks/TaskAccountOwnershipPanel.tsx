import { useRef, useState } from 'react';
import { authenticatedFetch } from '../../utils/auth';
import { Button } from '../Button';
import { Select } from '../ui/Select';
import { PrincipalName, usePrincipalDirectory } from '../principals/principalDirectory';
import { useStepUpRetry } from '../access/useStepUpRetry';
import { readStepUpChallenge, sendWithStepUpRetry } from '../../utils/stepUpChallenge';

/** AZ-A12 clause 9(e): a transfer whose current owner or target is a Group
 * asks for a single-use step-up bound to (ownership.transfer, this Task). */
const GROUP_TRANSFER_DESCRIPTION = 'Confirm it is you to transfer this Task\u2019s ownership to or from a Group.';

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL || '/api';
interface Ownership {
  taskId: string;
  accountOwnerPrincipalId: string | null;
  explicitAccountOwnerPrincipalId?: string | null;
  updatedAt: string;
  changed?: boolean;
  /** AZ-A12 clause 12: the effective owner's kind and name, joined by the server (absent on an older server). */
  ownerKind?: 'human' | 'group' | null;
  ownerDisplayName?: string | null;
}

/** A Group owner is named from the server's own field: Group principals are not in the person directory. */
function groupOwnerLabel(ownership: Ownership): string | null {
  return ownership.ownerKind === 'group' ? `${ownership.ownerDisplayName || 'A Group'} (Group)` : null;
}

/** Mount with a Task id key: a pending response must never become another
 * Task's transfer precondition. No background refresh or automatic write retry. */
export function TaskAccountOwnershipPanel({ taskId }: { taskId: string }) {
  const { directory, loading } = usePrincipalDirectory();
  const [snapshot, setSnapshot] = useState<Ownership | null>(null);
  const [target, setTarget] = useState('');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const pending = useRef(false);
  const [error, setError] = useState('');
  const [receipt, setReceipt] = useState<Ownership | null>(null);
  const { askForToken, retryDialog } = useStepUpRetry(GROUP_TRANSFER_DESCRIPTION);
  const endpoint = `${API_BASE_URL}/tasks/${encodeURIComponent(taskId)}/account-owner`;
  async function load() {
    if (pending.current) return;
    pending.current = true; setBusy(true); setError(''); setSnapshot(null); setReceipt(null);
    try {
      const response = await authenticatedFetch(endpoint);
      const data = await response.json();
      if (!response.ok || !data.success) throw new Error(data.message || data.error || 'Account owner could not be loaded.');
      if (data.ownership?.taskId !== taskId || typeof data.ownership.updatedAt !== 'string') throw new Error('Invalid ownership response.');
      setSnapshot(data.ownership); setTarget(''); setReason('');
    } catch (err) { setError(err instanceof Error ? err.message : 'Account owner could not be loaded.'); }
    finally { pending.current = false; setBusy(false); }
  }
  async function transfer() {
    if (!snapshot || !target || !reason.trim() || pending.current) return;
    pending.current = true; setBusy(true); setError('');
    try {
      const change = { accountOwnerPrincipalId: target,
        expectedAccountOwnerPrincipalId: snapshot.accountOwnerPrincipalId,
        expectedUpdatedAt: snapshot.updatedAt, reason: reason.trim() };
      const send = (stepUpToken?: string) => authenticatedFetch(endpoint, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(stepUpToken === undefined ? change : { ...change, stepUpToken }),
      });
      let response = await send();
      let data = await response.json().catch(() => null);
      // A Group source asks for the step-up the act names in its challenge;
      // the act is repeated once with the collected token, never more.
      const challenge = readStepUpChallenge(response.status, data);
      if (challenge && challenge.targetId === taskId) {
        const token = await askForToken(challenge);
        if (token) {
          const attempt = await sendWithStepUpRetry(send, token, challenge, askForToken);
          response = attempt.response;
          data = attempt.body;
        }
      }
      if (!data) throw new Error('Ownership change was refused.');
      if (!response.ok || !data.success) throw new Error(data.message || data.error || 'Ownership change was refused.');
      if (data.ownership?.taskId !== taskId || data.ownership.accountOwnerPrincipalId !== target) throw new Error('Unexpected ownership receipt. Reload to check the outcome.');
      setReceipt(data.ownership);
    } catch (err) { setError(err instanceof Error ? err.message : 'The outcome is unknown. Reload to check ownership.'); }
    finally {
      // A failed/uncertain request is never replayed against old evidence.
      setSnapshot(null); pending.current = false; setBusy(false);
    }
  }
  // E387(4): the panel lives in the Details rail's Advanced section, inside a
  // disclosure whose summary already reads "Account ownership"; its heading
  // sits under the Advanced h3 and is named for assistive technology only.
  return <section className="task-detail-ownership" aria-labelledby="task-account-owner-heading">
    <h4 id="task-account-owner-heading" className="sr-only">Account ownership</h4>
    <p>The account owner and their appointed Main connectors control this Task. Changing ownership may remove your access. Assignment and independent verification stay unchanged.</p>
    <Button variant="secondary" disabled={busy} onClick={() => void load()}>Load current account owner</Button>
    {busy && <p role="status">Checking account ownership…</p>}
    {error && <p role="alert">{error} Load the current account owner before trying again.</p>}
    {receipt && <p role="status">{receipt.changed === false ? 'Account ownership was already set to' : 'Account ownership changed to'} <PrincipalName id={receipt.accountOwnerPrincipalId} directory={directory} />. Reload the Task to refresh your access and details.</p>}
    {snapshot && <form onSubmit={event => { event.preventDefault(); void transfer(); }}>
      <p>Current account owner: {groupOwnerLabel(snapshot) ?? (snapshot.accountOwnerPrincipalId ? <PrincipalName id={snapshot.accountOwnerPrincipalId} directory={directory} /> : 'Unassigned')}{snapshot.explicitAccountOwnerPrincipalId === null && snapshot.accountOwnerPrincipalId ? ' (inherited from Project)' : ''}</p>
      <label>New account owner<Select required disabled={busy || loading} value={target} onChange={event => setTarget(event.target.value)}>
        <option value="">Select a human account</option>
        {Array.from(directory?.values() || []).filter(p => p.kind === 'human' && p.status === 'active').map(p => <option key={p.id} value={p.id}>{p.displayName || p.handle} ({p.handle})</option>)}
      </Select></label>
      {!loading && !directory && <p role="alert">The account directory is unavailable. Reload this page to try again.</p>}
      <label>Reason for ownership change<textarea required maxLength={2000} disabled={busy} value={reason} onChange={event => setReason(event.target.value)} /></label>
      <p>This is an audited ownership change. Only the current owner, their appointed Main, or an authorized signed-in administrator can submit it.</p>
      <Button type="submit" disabled={busy || !target || !reason.trim()}>Change account owner</Button>
    </form>}
    {retryDialog}
  </section>;
}
