import { createHash } from 'crypto';
import { ConflictFault, InvalidRequestFault } from './httpErrors';

export const NATIVE_REVIEW_PROTOCOL = 'rh.native-review/1';
export const NATIVE_REVIEW_LEASE_SECONDS = 600;
/** A previous verifier's output remains attached for audit and UI, but is not
 * implicit implementation evidence for the next attempt. An explicit Report
 * reference opts it back in and retains the ordinary per-Report read gate. */
export const NATIVE_REVIEW_INPUT_REPORTS_SQL = `SELECT r.id,r.title,r.summary,r.content,r.author_principal_id,r.author_actor_id,r.origin
  FROM reports r
  WHERE r.deleted_at IS NULL AND (
    EXISTS (SELECT 1 FROM task_references tr
      WHERE tr.task_id=$1 AND tr.kind='report' AND tr.target_id=r.id)
    OR ($1::uuid=ANY(r.task_ids) AND NOT EXISTS (
      SELECT 1 FROM task_native_reviews prior
      WHERE prior.task_id=$1 AND prior.verdict->>'reportId'=r.id::text))
  )
  ORDER BY r.id`;
export interface ReviewCriterion { id: string; text: string }
export interface CriterionDecision { id: string; decision: 'pass' | 'reject'; evidence: string[]; rationale: string }

/** Canonical JSON hashes are independent of PostgreSQL JSONB key order. */
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object' && !(value instanceof Date)) {
    return '{' + Object.entries(value).sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => JSON.stringify(key) + ':' + canonical(item)).join(',') + '}';
  }
  return JSON.stringify(value);
}
export function reviewDigest(value: unknown): string {
  return createHash('sha256').update(canonical(value)).digest('hex');
}
export function exactFields(value: unknown, keys: string[]): asserts value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).some(key => !keys.includes(key))) throw new InvalidRequestFault('Unknown or malformed native review fields');
}
export function reviewCriteria(task: { definition_of_done?: unknown; description?: string }): ReviewCriterion[] {
  const dod = task.definition_of_done;
  const texts = Array.isArray(dod) && dod.length ? dod : typeof dod === 'string' && dod.trim() ? [dod] : [task.description];
  if (!texts.length || texts.length > 100 || texts.some(text => typeof text !== 'string' || !text.trim())) {
    throw new InvalidRequestFault('Native review requires nonempty Task criteria or description');
  }
  return texts.map((text, index) => ({ id: `criterion-${index + 1}`, text: text as string }));
}
export interface NativeReviewScope {
  kind: 'task_final' | 'subtask_slice' | 'terminal_slice_and_task';
  subtaskIds: string[];
  includesTaskCriteria: boolean;
}
/** Eligibility and criterion selection run before dispatch and again under the verdict barrier. */
export function nativeReviewScope(task: { definition_of_done?: unknown; description?: string },
  subtasks: Array<{ id: string; index: number; text: string; status: string }>): { scope: NativeReviewScope; criteria: ReviewCriterion[] } {
  if (subtasks.every(s => ['completed', 'skipped'].includes(s.status))) {
    return { scope: { kind: 'task_final', subtaskIds: [], includesTaskCriteria: true }, criteria: reviewCriteria(task) };
  }
  const first = subtasks.findIndex(s => s.status === 'review');
  if (first < 0 || subtasks.slice(0, first).some(s => !['completed', 'skipped'].includes(s.status))) {
    throw new ConflictFault('No contiguous subtask review is ready', 'NATIVE_REVIEW_NOT_READY');
  }
  let end = first;
  while (end < subtasks.length && subtasks[end].status === 'review') end++;
  const tail = subtasks.slice(end);
  if (tail.some(s => !['empty', 'completed', 'skipped'].includes(s.status))) {
    throw new ConflictFault('Review has gapped or active later work', 'NATIVE_REVIEW_NOT_READY');
  }
  const slice = subtasks.slice(first, end);
  if (slice.some(s => !s.text?.trim())) throw new ConflictFault('Subtask review criteria are missing');
  const terminal = tail.every(s => ['completed', 'skipped'].includes(s.status));
  const criteria = slice.map(s => ({ id: `subtask-${s.id}`, text: `Subtask ${s.index + 1}: ${s.text}` }));
  if (terminal) criteria.push(...reviewCriteria(task).map(c => ({ ...c, text: `Whole Task: ${c.text}` })));
  return { scope: { kind: terminal ? 'terminal_slice_and_task' : 'subtask_slice', subtaskIds: slice.map(s => String(s.id)), includesTaskCriteria: terminal }, criteria };
}
/** Model output is evidence, never a command, path, authority or criterion source. */
export function validateNativeVerdict(value: unknown, criteria: ReviewCriterion[], reportIds: string[]): {
  summary: string; criteria: CriterionDecision[]; decision: 'pass' | 'reject';
} {
  exactFields(value, ['summary', 'criteria']);
  if (typeof value.summary !== 'string' || !value.summary.trim() || value.summary.length > 4000
    || !Array.isArray(value.criteria) || value.criteria.length !== criteria.length) throw new InvalidRequestFault('Invalid native verdict');
  const seen = new Set<string>();
  const decisions = value.criteria.map(item => {
    exactFields(item, ['id', 'decision', 'evidence', 'rationale']);
    if (typeof item.id !== 'string' || !criteria.some(c => c.id === item.id) || seen.has(item.id)
      || !['pass', 'reject'].includes(String(item.decision)) || typeof item.rationale !== 'string'
      || !item.rationale.trim() || item.rationale.length > 8000 || !Array.isArray(item.evidence)
      || !item.evidence.length || item.evidence.some(id => typeof id !== 'string' || !reportIds.includes(id))) {
      throw new InvalidRequestFault('Verdict criteria and evidence must match the immutable request');
    }
    seen.add(item.id);
    return item as unknown as CriterionDecision;
  });
  return { summary: value.summary, criteria: decisions, decision: decisions.every(c => c.decision === 'pass') ? 'pass' : 'reject' };
}
