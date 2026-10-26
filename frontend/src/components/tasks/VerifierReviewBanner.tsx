import { Button } from '../Button';
import type { Task, VerifierFailedArm } from '../../types/task';

/**
 * The Review banner (card 41e24358, design ba22fd01 Part 5; owner ruling
 * E284): a card in Review whose Verifier cannot judge it says so. It reads
 * the server's live predicate from the Task read (`verifierUsability`), so it
 * also shows on cards that were already in Review. It never blocks anything;
 * "Set Verifier" opens the Verifier editor for those the roles route admits
 * (the Task's Shepherd or an administrator), and the server decides.
 */
export function verifierBannerText(arm: VerifierFailedArm, name: string | null): string {
  const who = name || 'the Verifier';
  switch (arm) {
    case 'none': return 'No usable Verifier: none set';
    case 'principal': return `No usable Verifier: ${who} is not active`;
    case 'chain': return `No usable Verifier: ${who} is disabled or has no live credential`;
    case 'scope': return `No usable Verifier: ${who} lacks tasks:write`;
    case 'independence': return `No usable Verifier: ${who} is also the Assignee`;
    default: return 'No usable Verifier';
  }
}

interface VerifierReviewBannerProps {
  task: Pick<Task, 'status' | 'verifierUsability'>;
  /** The display name of the current Verifier, when one is set. */
  verifierName?: string | null;
  /** Present only for those the roles route admits. */
  onSetVerifier?: () => void;
}

export function VerifierReviewBanner({ task, verifierName, onSetVerifier }: VerifierReviewBannerProps) {
  const usability = task.verifierUsability;
  if (task.status !== 'review' || !usability || usability.usable) return null;
  return (
    <p className="task-detail-inline-warning" role="status">
      {verifierBannerText(usability.failedArm ?? 'none', verifierName ?? null)}
      {onSetVerifier ? (
        <>
          {' '}
          <Button variant="secondary" size="compact" onClick={onSetVerifier}>Set Verifier</Button>
        </>
      ) : null}
    </p>
  );
}
