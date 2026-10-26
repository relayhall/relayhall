import type { Principal } from '../../types/task';

/**
 * What the Access manager and the approvals hub share (card b1e3b16d, lane
 * L1). These moved here unchanged from `pages/AccessManagerPage.tsx` when the
 * approval queue was extracted into `components/approvals/ApprovalsQueue.tsx`:
 * the queue is mounted by two pages now, and a helper either of them owns
 * would make the other import a page.
 */

export interface ProfileRule {
  resourceType: string;
  selectorForm: 'exact' | 'all-of-type' | 'all-except' | 'all-in-project';
  selectorIds: string[];
  verbs: string[];
}

export interface StepUpRequest {
  action: string;
  targetId: string;
  description: string;
  onToken: (token: string) => void;
  /** Card 7a99d63e (SU-33): told when the person closes the dialog without a token. */
  onCancel?: () => void;
}

export function principalLabel(principal?: Principal): string {
  if (!principal) return 'Unknown identity';
  return principal.displayName ? `${principal.displayName} (${principal.handle})` : principal.handle;
}

/** One rule in words. EXHAUSTIVE over the ratified forms, and the fallback
 * describes what it does not recognise rather than mislabelling it: a form
 * added to the backend and not yet to this page must read as unknown, never as
 * `exact`, which is what the old trailing `:` branch made it. */
export function ruleSummary(rule: ProfileRule): string {
  const count = rule.selectorIds.length;
  let selector: string;
  if (rule.selectorForm === 'all-of-type') selector = 'every';
  else if (rule.selectorForm === 'all-except') selector = `all except ${count}`;
  else if (rule.selectorForm === 'exact') selector = `${count} exact`;
  else if (rule.selectorForm === 'all-in-project') {
    selector = `every (in ${count} ${count === 1 ? 'project' : 'projects'})`;
  } else selector = `${count} id(s) by an unrecognised selector (${String(rule.selectorForm)})`;
  return `${rule.verbs.join('/')} on ${selector} ${rule.resourceType}`;
}

export async function readJson(response: Response): Promise<any> {
  const data = await response.json().catch(() => ({}));
  if (!response.ok || data.success === false) {
    throw new Error(data.message || data.error || `Request failed (${response.status})`);
  }
  return data;
}
