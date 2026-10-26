/**
 * Card c3880767: every column of `tasks` is a PUBLIC request field or a
 * SERVER-WRITTEN one, and there is no third kind.
 *
 * Card 7c77fcf3 refused the two internal execution keys by name. Its census
 * found the class they belonged to. PATCH /tasks/:id spread the whole request
 * body into TaskManagerDB.updateTask, which honours a string key for every
 * column it knows, so any Task writer could set the reviewer retry budget
 * (attemptCount, maxRetries), the review state (needsReview, reviewHistory),
 * the reviewer and runtime metadata
 * (discordThreadId and thinkingAutoEstimated). POST /tasks forwarded five of them into
 * the INSERT. Refusing those names would close twelve fields and leave the
 * next column open, so this module closes the class instead:
 *
 *  - TASK_COLUMN_CONTRACT classifies EVERY column of the live `tasks` table.
 *    taskServerWrittenColumnsLive reads information_schema on a real
 *    PostgreSQL and fails until a column a later migration adds is classified
 *    here, so a new column cannot become a request field by default.
 *  - A PUBLIC column lists the request key that writes it. Those keys, with
 *    the non-column request fields below, are the whole body PATCH
 *    /tasks/:id forwards to the write (publicTaskBody). Any other key is
 *    dropped before the write, as an unknown key always was: real clients
 *    send keys that are no column (the Task detail page's agentInstructions,
 *    the CLI's role and blockedBy) and rely on that.
 *  - A SERVER-WRITTEN column lists every key a caller could use to name it:
 *    its Task READ name(s) and the column's own name. POST /tasks and PATCH
 *    /tasks/:id refuse a body carrying any of them with 400
 *    SERVER_WRITTEN_FIELD, naming the key in details.field, which is the
 *    refusal the role identifiers and the execution keys already get.
 *
 * Server-side writers are unaffected. The reviewer, the review-attempt
 * recorder, Discord threads, Blueprint instantiation and setup, the lifecycle
 * transitions and the role, access, ownership and assignment routes call
 * TaskManagerDB or SQL with their own payloads, never with a request body.
 */
import { ROLE_GRANT_EXPIRY_FIELD } from './roleGrantExpiry';

export type TaskColumnClass = 'public' | 'server-written';

export interface TaskColumnEntry {
  readonly class: TaskColumnClass;
  /** The request keys that write (public) or name (server-written) the column. */
  readonly keys: readonly string[];
}

const publicColumn = (...keys: string[]): TaskColumnEntry => Object.freeze({ class: 'public', keys: Object.freeze(keys) });
const serverWritten = (...keys: string[]): TaskColumnEntry => Object.freeze({ class: 'server-written', keys: Object.freeze(keys) });

export const TASK_COLUMN_CONTRACT: Readonly<Record<string, TaskColumnEntry>> = Object.freeze({
  id: serverWritten('id'),
  title: publicColumn('title'),
  description: publicColumn('description'),
  // Lifecycle gates decide which transitions a caller may make.
  status: publicColumn('status'),
  priority: publicColumn('priority'),
  // The key writes the task_tags rows; nothing writes this legacy column.
  tags: publicColumn('tags'),
  // A Project name or id, resolved through the authorized target decision.
  project_id: publicColumn('project'),
  auto_start: publicColumn('autoStart'),
  started_at: serverWritten('startedAt', 'started_at'),
  archived_at: serverWritten('archivedAt', 'archived_at'),
  blocked_reason: publicColumn('blockedReason'),
  // The key writes the task_links rows; nothing writes this legacy column.
  links: publicColumn('links'),
  created_at: serverWritten('created', 'createdAt', 'created_at'),
  updated_at: serverWritten('updated', 'updatedAt', 'updated_at'),
  personality_id: publicColumn('personalityId'),
  thinking_budget: publicColumn('thinking'),
  thinking_auto_estimated: serverWritten('thinkingAutoEstimated', 'thinking_auto_estimated'),
  model: publicColumn('model'),
  // Retired with D-15. The camelCase key executionMode keeps its own
  // 400 FIELD_RETIRED from the execution-profile pipeline.
  execution_mode: serverWritten('execution_mode'),
  // Requires services:invoke and validation against the pinned descriptor.
  execution_profile: publicColumn('executionProfile'),
  status_reason: serverWritten('statusReason', 'status_reason'),
  attempt_count: serverWritten('attemptCount', 'attempt_count'),
  parent_id: publicColumn('parentId'),
  // `completed` is the Task READ's legacy completion timestamp.
  completed_at: serverWritten('completed', 'completedAt', 'completed_at'),
  discord_thread_id: serverWritten('discordThreadId', 'discord_thread_id'),
  success_criteria: serverWritten('successCriteria', 'success_criteria'),
  review_history: serverWritten('reviewHistory', 'review_history'),
  // The reviewer retry budget. Authored by a Blueprint's task defaults.
  max_retries: serverWritten('maxRetries', 'max_retries'),
  review_status: serverWritten('reviewStatus', 'review_status'),
  reviewer_session_key: serverWritten('reviewerSessionKey', 'reviewer_session_key'),
  reviewer_last_run_at: serverWritten('reviewerLastRunAt', 'reviewer_last_run_at'),
  reviewer_timeout_seconds: serverWritten('reviewerTimeoutSeconds', 'reviewer_timeout_seconds'),
  definition_of_done: publicColumn('definitionOfDone'),
  constraints: publicColumn('constraints'),
  last_reviewed_at: serverWritten('lastReviewedAt', 'last_reviewed_at'),
  needs_review: serverWritten('needsReview', 'needs_review'),
  archive_disposition: serverWritten('archiveDisposition', 'archive_disposition'),
  notes: publicColumn('notes'),
  // Role and ownership columns: claim and release, PATCH /tasks/:id/roles,
  // PUT /tasks/:id/account-owner and the create itself write them.
  owner_principal_id: serverWritten('ownerPrincipalId', 'owner_principal_id'),
  creator_principal_id: serverWritten('creatorPrincipalId', 'creator_principal_id'),
  visibility: serverWritten('visibility'),
  // Derived from a validated executionProfile (card 7c77fcf3).
  execution_service_id: serverWritten('executionServiceId', 'execution_service_id'),
  execution_descriptor_version: serverWritten('executionDescriptorVersion', 'execution_descriptor_version'),
  phase_id: publicColumn('phaseId'),
  shepherd_principal_id: serverWritten('shepherdPrincipalId', 'shepherd_principal_id'),
  verifier_principal_id: serverWritten('verifierPrincipalId', 'verifier_principal_id'),
  // Card 41e24358: where the Verifier came from (explicit, inherited-phase,
  // inherited-project, assigned). Written by the create and the roles writer.
  verifier_source: serverWritten('verifierSource', 'verifier_source'),
  // Section 6.8 (E462 S4b, migration 170): `none`, set at creation or on
  // PATCH /tasks/:id/roles; who set it, when, under which basis, and when it
  // was cleared are written by that act alone.
  verification_none: serverWritten('verificationNone', 'verification_none'),
  verification_none_set_by: serverWritten('verificationNoneSetByPrincipalId', 'verification_none_set_by'),
  verification_none_basis: serverWritten('verificationNoneBasis', 'verification_none_basis'),
  verification_none_set_at: serverWritten('verificationNoneSetAt', 'verification_none_set_at'),
  verification_none_cleared_at: serverWritten('verificationNoneClearedAt', 'verification_none_cleared_at'),
  // Accepted only beside a non-null executionProfile.
  execution_warrant_id: publicColumn('executionWarrantId'),
  // Its own route: PATCH /tasks/:id/access.
  restricted_access: serverWritten('restrictedAccess', 'restricted_access'),
  // Blueprint provenance, written by instantiation.
  blueprint_key: serverWritten('blueprintKey', 'blueprint_key'),
  blueprint_version: serverWritten('blueprintVersion', 'blueprint_version'),
  blueprint_content_sha256: serverWritten('blueprintContentSha256', 'blueprint_content_sha256'),
  blueprint_identity_sha256: serverWritten('blueprintIdentitySha256', 'blueprint_identity_sha256'),
  instantiation_id: serverWritten('instantiationId', 'instantiation_id'),
  due_at: publicColumn('dueAt'),
  account_owner_principal_id: serverWritten('accountOwnerPrincipalId', 'account_owner_principal_id'),
});

/**
 * Request fields that are no `tasks` column. subtasks and dependsOn write
 * their own tables; archiveReason is appended to the notes of an archiving
 * write; roleGrantExpiresAt dates the grant rows of an execution assignment
 * (AZ-A10 clause 6); executionMode is forwarded only so the execution-profile
 * pipeline keeps refusing it 400 FIELD_RETIRED by name.
 */
export const NON_COLUMN_TASK_REQUEST_KEYS: readonly string[] = Object.freeze([
  'subtasks', 'dependsOn', 'archiveReason', ROLE_GRANT_EXPIRY_FIELD, 'executionMode',
]);

const keysOfClass = (cls: TaskColumnClass): string[] => Object.values(TASK_COLUMN_CONTRACT)
  .filter((entry) => entry.class === cls)
  .flatMap((entry) => entry.keys);

/** Every key a create or edit body may carry to the write. */
export const PUBLIC_TASK_REQUEST_KEYS: ReadonlySet<string> = new Set([
  ...keysOfClass('public'), ...NON_COLUMN_TASK_REQUEST_KEYS,
]);

/** Every key that names a server-written column: refused by name. */
export const SERVER_WRITTEN_TASK_COLUMN_KEYS: ReadonlySet<string> = new Set(keysOfClass('server-written'));

/**
 * The part of a PATCH /tasks/:id body the write may see: the caller's own
 * public keys, in the caller's order, with explicit nulls kept (null clears
 * phaseId, dueAt, executionProfile, model, thinking and personalityId).
 *
 * The result is a PLAIN object literal on purpose. The completion, archive
 * and planning classifiers accept only Object.prototype objects, and the
 * execution-profile pipeline attaches the assigning act's date to this object
 * under a Symbol key, so it must run on the result, never before it.
 */
export function publicTaskBody(body: unknown): Record<string, unknown> {
  const picked: Record<string, unknown> = {};
  if (!body || typeof body !== 'object' || Array.isArray(body)) return picked;
  for (const key of Object.keys(body)) {
    if (PUBLIC_TASK_REQUEST_KEYS.has(key)) picked[key] = (body as Record<string, unknown>)[key];
  }
  return picked;
}
