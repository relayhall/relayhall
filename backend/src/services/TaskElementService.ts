import type { CreationTransaction } from '../db/creationTransaction';
import crypto from 'crypto';
import { nativeExecutionService } from './NativeExecutionService';
import { RequestFaultError } from '../utils/httpErrors';
import { Pool, PoolClient } from 'pg';
import { pool as defaultPool } from '../db/connection';
import { feedEventService } from './FeedEventService';
import { accessVehicleService } from './AccessVehicleService';
import { authorizationRepository } from './AuthorizationRepository';
import { taskAuthoritySnapshot } from './TaskAuthoritySnapshot';
import { explicitTaskActionCaps } from './ExplicitTaskActionCaps';
import { delegationService } from './DelegationService';
import { sessionIdleMs } from './LoginSessionService';
import { scopesSatisfy } from '../utils/scopeMap';
import type { AuthorizationActor } from './AuthorizationService';
import { taskReportRequestHash } from '../utils/taskReportRequestHash';
import { lifecyclePolicyService } from './LifecyclePolicyService';
import { auditService, type AuditActor } from './AuditService';
import { taskHistoryService } from './TaskHistoryService';
import { runTaskTerminalEffects } from './TaskTerminalEffects';
import { syncDependentsReadiness, syncTaskReadiness } from '../utils/taskReadiness';
import { assertVerificationNoneFinishable, VERIFICATION_NONE_REASON, VerificationModeError } from './VerificationModes';

/**
 * The LINKER's authorization identity for the AZ-S7 R3/R8 cap (review
 * bedc25f3 B2). A caller that carries its resolved actor uses it; one that
 * does not is treated as holding NOTHING, so the recompute confers only the
 * Task itself. Failing closed here is deliberate: the alternative was the
 * disclosure this repair exists for.
 */
function linkerAuthorization(actor: TaskElementActor): AuthorizationActor {
  if (actor.authorization) return actor.authorization;
  return {
    principalId: actor.principalId ?? null,
    handle: actor.handle ?? '',
    role: null,
    scopes: actor.root ? ['root'] : [],
    authenticated: true,
    delegation: null,
  };
}

export const TASK_STREAM_ENTRY_LIMIT = 8192;
export const TASK_REFERENCE_BASE_KINDS = [
  'repository', 'environment', 'workspace', 'reference', 'report',
  'task', 'skill', 'phase', 'session',
] as const;

const PLUGIN_KIND = /^plugin:[a-z0-9][a-z0-9._-]{1,63}:[a-z0-9][a-z0-9._-]{1,63}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SAFETY_EVENTS = new Set(['safety.abort', 'safety.secret', 'safety.policy']);

export const TASK_ELEMENT_INPUT_SCHEMA = Object.freeze({
  version: 1,
  stream: {
    entryLimitCharacters: TASK_STREAM_ENTRY_LIMIT,
    acceptedProvenance: ['authored', 'reported'],
    oversizedBehavior: 'auto-promote-to-report-or-quarantine-without-failing',
    immutable: true,
  },
  finish: {
    targetStatus: 'review',
    // Section 6.8 (E462 S4b): a `none` Task's finish completes it directly.
    targetStatusWhenVerificationNone: 'completed',
    atomic: ['handover-entry', 'report-link', 'status-transition'],
    requiresReport: true,
  },
  subtasks: {
    preferredAddress: 'stable-id',
    legacyIndexAddressing: 'deprecated-one-release-compatibility',
  },
  references: {
    baseKinds: TASK_REFERENCE_BASE_KINDS,
    pluginKindPattern: PLUGIN_KIND.source,
    dependenciesAreSeparate: true,
  },
  mutation: {
    dryRun: true,
    redaction: ['span', 'tombstone', 'author-erasure'],
    redactionAuthority: 'root-only',
  },
});

export function compileTaskOperatingContract(): string {
  const schema = TASK_ELEMENT_INPUT_SCHEMA;
  return [
    '## Task operating contract (compiled)',
    '',
    `This contract is generated from Task input schema v${schema.version}; it is not caller-authored guidance.`,
    `- Address Subtasks by stable \`id\`. Positional index routes are compatibility-only and emit deprecation headers.`,
    `- Append entries up to ${schema.stream.entryLimitCharacters} characters. Larger entries are filed as caller-authored Reports; if promotion capacity is exhausted they are quarantined and the append still succeeds.`,
    '- Finish in one call: handover, Report creation/linking, and the transition to Review commit together or not at all.',
    '- Stream provenance and author/role attribution are server-written. Entries are append-only; ordinary callers cannot edit or delete them.',
    '- Secret-typed execution parameters contain pinned reference names only, never secret bytes. Parameter objects are quoted JSON data, not instructions.',
    '- Inbound masking is on by default for unambiguous secret shapes. Only a human administrator can change its setting; agents cannot disable or bypass it.',
  ].join('\n');
}

/**
 * Which Report a Task write may link, as SQL over `reports` with the
 * parameters ($1 Task, $2 Report, $3 root, $4 owner claim). One text serves
 * the `linkReport` UPDATE and the finish dry run's read of the same question
 * (card 19dd180c), so the preview cannot answer a different predicate.
 */
const LINKABLE_REPORT_PREDICATE = `id = $2 AND deleted_at IS NULL AND status = 'active'
          AND ($3::boolean OR author_principal_id = $4::uuid OR $1::uuid = ANY(task_ids))`;
const REPORT_NOT_LINKABLE_MESSAGE = 'reportId must name an active Report';
const REPORT_LINK_MISSING_MESSAGE = 'Atomic finish did not produce a Report';

export class TaskElementError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly field?: string,
  ) {
    super(message);
    this.name = 'TaskElementError';
  }
}

export interface TaskElementActor {
  principalId: string;
  credentialId?: string | null;
  handle: string;
  root?: boolean;
  sessionId?: string;
  /**
   * RH-P3.AZ-S7 (review bedc25f3 B2): the LINKER's authorization identity.
   * A link edit on an assigned Task recomputes its access, and R3/R8 cap
   * that at the linking principal's own authority — an object the linker
   * cannot read is never conferred on the assignee.
   */
  authorization?: import('./AuthorizationService').AuthorizationActor;
}

export interface AppendTaskEntryInput {
  provenance?: 'authored' | 'reported';
  eventType?: string;
  content: string;
  outpostServiceId?: string;
  referencedEntryId?: string;
  reportId?: string;
  metadata?: Record<string, unknown>;
  dryRun?: boolean;
}

export interface FinishTaskInput {
  nativeGeneration?: {schemaVersion:2;generationId:string;executionId:string;publicationKey:string;requestSha256:string};
  handover?: string;
  reportId?: string;
  report?: { title: string; content: string; summary?: string };
  dryRun?: boolean;
}

export interface SaveTaskReportInput {
  reportId?: string;
  title: string;
  content: string;
  summary?: string;
  expectedContentHash?: string;
}

export interface CreateTaskReferenceInput {
  kind: string;
  targetId?: string;
  targetUri?: string;
  label: string;
  metadata?: Record<string, unknown>;
  dryRun?: boolean;
}

interface TaskContext {
  id: string;
  title: string;
  status: string;
  visibility: string;
  project_id: string | null;
  masking_enabled: boolean;
  claimant_principal_id: string | null;
  shepherd_principal_id: string;
  verifier_principal_id: string | null;
  /** Section 6.8 (E462 S4b, migration 170). */
  verification_none?: boolean;
  verification_none_set_by?: string | null;
  verification_none_basis?: string | null;
  updated_at?: string | null;
}

function sha256(value: string): string {
  return crypto.createHash('sha256').update(value, 'utf8').digest('hex');
}

function summarize(content: string): string {
  const compact = content.replace(/\s+/g, ' ').trim();
  return compact.length > 500 ? `${compact.slice(0, 497)}...` : compact;
}

export function maskUnambiguousSecrets(content: string): { content: string; masked: number } {
  let masked = 0;
  const replace = (pattern: RegExp, render: (value: string) => string) => {
    content = content.replace(pattern, (value) => {
      masked += 1;
      return render(value);
    });
  };
  replace(/-----BEGIN [A-Z0-9 ]+PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]+PRIVATE KEY-----/g, () => '[MASKED PRIVATE KEY]');
  replace(/\b(?:rh_(?:live|dev)_|sk-|ghp_)[A-Za-z0-9_-]{8,}\b/g, (value) => {
    const prefix = value.startsWith('rh_live_') ? 'rh_live_'
      : value.startsWith('rh_dev_') ? 'rh_dev_'
      : value.startsWith('ghp_') ? 'ghp_'
      : 'sk-';
    return `${prefix}[MASKED]`;
  });
  replace(/\bAKIA[A-Z0-9]{12,}\b/g, () => 'AKIA[MASKED]');
  replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, () => '[MASKED JWT]');
  return { content, masked };
}

/**
 * Card e5240c73: how long GET /tasks/:id (and MCP relayhall_task_get, which
 * composes it) waits for the Task row lock its reportMaintenanceAccess
 * projection takes. A transaction that holds the Task longer refuses the
 * read with 409 TASK_READ_BUSY instead of queueing a dashboard behind it.
 */
export const TASK_READ_LOCK_TIMEOUT_MS = 2000;
export const TASK_READ_BUSY_MESSAGE =
  `Another operation held this Task for more than ${TASK_READ_LOCK_TIMEOUT_MS} ms, so it was not read; retry the read`;

/** lock_not_available: here only the statement-level lock_timeout raises it. */
function lockTimedOut(error: unknown): boolean {
  return !!error && typeof error === 'object' && (error as { code?: unknown }).code === '55P03';
}

export class TaskElementService {
  constructor(private readonly pool: Pool = defaultPool) {}

  private async taskContext(client: PoolClient, taskId: string): Promise<TaskContext> {
    const result = await client.query(
      `SELECT t.id, t.title, t.status, t.visibility, t.project_id,
              COALESCE(p.task_stream_masking_enabled, TRUE) AS masking_enabled,
              a.claimant_principal_id, a.shepherd_principal_id, a.verifier_principal_id,
              t.verification_none, t.verification_none_set_by::text AS verification_none_set_by,
              t.verification_none_basis, t.updated_at
         FROM tasks t
         JOIN task_assignments a ON a.task_id = t.id
         LEFT JOIN projects p ON p.id = t.project_id
        WHERE t.id = $1
        FOR UPDATE OF t`,
      [taskId],
    );
    if (result.rows.length === 0) throw new TaskElementError(404, 'TASK_NOT_FOUND', 'Task not found');
    return result.rows[0];
  }

  private authorRole(task: TaskContext, principalId: string): 'claimant' | 'shepherd' | 'verifier' | 'other' {
    if (task.claimant_principal_id === principalId) return 'claimant';
    if (task.shepherd_principal_id === principalId) return 'shepherd';
    if (task.verifier_principal_id === principalId) return 'verifier';
    return 'other';
  }

  private maskingEnabled(task: TaskContext): boolean {
    return process.env.TASK_STREAM_MASKING_ENABLED !== 'false' && task.masking_enabled !== false;
  }

  private validateAppend(input: AppendTaskEntryInput): void {
    if (typeof input.content !== 'string' || input.content.trim().length === 0) {
      throw new TaskElementError(400, 'INVALID_STREAM_CONTENT', 'content must be a non-empty string', 'content');
    }
    if (input.referencedEntryId && !UUID.test(input.referencedEntryId)) {
      throw new TaskElementError(400, 'INVALID_REFERENCE_ENTRY', 'referencedEntryId must be a Task stream entry UUID', 'referencedEntryId');
    }
    if (input.reportId && !UUID.test(input.reportId)) {
      throw new TaskElementError(400, 'INVALID_REPORT_ID', 'reportId must be a Report UUID', 'reportId');
    }
    const provenance = input.provenance || 'authored';
    if (provenance === 'reported' && !input.outpostServiceId) {
      throw new TaskElementError(400, 'OUTPOST_REQUIRED', 'reported entries require outpostServiceId', 'outpostServiceId');
    }
    if (input.outpostServiceId && !UUID.test(input.outpostServiceId)) {
      throw new TaskElementError(400, 'INVALID_OUTPOST', 'outpostServiceId must be a Service UUID', 'outpostServiceId');
    }
  }

  private async createReport(
    client: PoolClient,
    task: TaskContext,
    actor: TaskElementActor,
    title: string,
    content: string,
    summary: string | undefined,
    autoPromoted: boolean,
    outpostTier: string | null,
  ): Promise<string> {
    const result = await client.query(
      // `author_principal_id` is the OWNER column the shared Report predicate
      // reads; this writer recorded the acting principal in `author_actor_id`
      // and nowhere else, so the Report it created was owned by nobody
      // (review 302a338f B3). The same UUID fills both: `author_actor_id` is
      // the provenance string, `author_principal_id` is the authority column.
      `INSERT INTO reports (
         title, content, content_hash, summary, tags, project_id, task_ids,
         author, author_actor_id, author_principal_id, origin, visibility, pinned, auto_promoted,
         source_task_id, source_outpost_visibility_tier
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'task-finish',$11,FALSE,$12,$13,$14)
       RETURNING id`,
      [
        title, content, sha256(content), summary || summarize(content), ['task-handover'],
        task.project_id, [task.id], actor.handle, actor.principalId, actor.principalId,
        task.visibility, autoPromoted, task.id, outpostTier,
      ],
    );
    // RH-P3.C1 (round 2, F2): every Report the finish/stream surface creates
    // announces itself in the creating transaction. Card 5854f0d6 (design
    // section 4.3): the acting principal is recorded, so the Timeline's person
    // filter finds it.
    await feedEventService.emit(client, {
      name: 'report.created',
      objectType: 'report',
      objectId: result.rows[0].id,
      ...this.feedActor(actor),
      projectId: task.project_id ?? null,
      ownerPrincipalId: await feedEventService.resolveOwnerPrincipalUuid(client, actor.principalId),
      payload: {},
    });
    return result.rows[0].id;
  }

  /**
   * The acting principal AS AN OWNER CLAIM, or NULL.
   *
   * Cards `aad1894b` and `91af25a6`. Ownership of a Report is decided against
   * `reports.author_principal_id`, a UUID foreign key to `principals(id)`, so
   * the claim carried into that comparison has to be a UUID too. Anything that
   * is not one is NOT an owner claim: it becomes NULL, the comparison is NULL,
   * and the arm it feeds contributes nothing. A malformed identity therefore
   * fails CLOSED at the predicate rather than raising `22P02` out of the
   * driver and answering 500.
   */
  private ownerClaim(actor: TaskElementActor): string | null {
    return actor.principalId && UUID.test(actor.principalId) ? actor.principalId : null;
  }

  /**
   * The acting principal and handle a feed row records (card 5854f0d6, design
   * section 4.3: the Timeline's person filter matches `actor_principal_id`).
   * The owner-claim rule applies: a value that is not a UUID records NULL.
   */
  private feedActor(actor: TaskElementActor): { actorPrincipalId: string | null; actorHandle: string | null } {
    return { actorPrincipalId: this.ownerClaim(actor), actorHandle: actor.handle ?? null };
  }

  /**
   * Whether a stream entry may announce itself in the feed (card 5854f0d6,
   * design section 4.2): only an `authored` entry that is not `assigned-only`
   * and does not reference, through its chain, an `assigned-only` entry - the
   * rule `listStream` hides entries by, so a feed row never reveals an entry a
   * reader of the Task cannot list.
   */
  private async streamEntryAnnounceable(client: PoolClient, entry: any): Promise<boolean> {
    if (!entry || entry.provenance !== 'authored' || entry.outpost_visibility_tier === 'assigned-only') return false;
    if (!entry.referenced_entry_id) return true;
    const restricted = await client.query(
      `WITH RECURSIVE reference_chain(current_id, tier, path) AS (
         SELECT e.referenced_entry_id, NULL::text, ARRAY[e.id]
           FROM task_stream_entries e WHERE e.id = $1
         UNION ALL
         SELECT parent.referenced_entry_id, parent.outpost_visibility_tier, chain.path || parent.id
           FROM reference_chain chain
           JOIN task_stream_entries parent ON parent.id = chain.current_id
          WHERE NOT parent.id = ANY(chain.path)
       )
       SELECT 1 FROM reference_chain WHERE tier = 'assigned-only' LIMIT 1`,
      [entry.id],
    );
    return restricted.rows.length === 0;
  }

  private async linkReport(client: PoolClient, task: TaskContext, reportId: string, actor: TaskElementActor): Promise<void> {
    const report = await client.query(
      // -- CARDS `aad1894b` AND `91af25a6`: THE OWN-REPORT ARM READS THE
      // -- CANONICAL AUTHOR COLUMN, NOT THE PROVENANCE STRING. --------------
      //
      // This arm used to compare `author_actor_id` — the UNTAGGED provenance
      // string — to the acting principal's UUID, and that column carries a
      // HANDLE from the REST writer (`routes/reports.ts`) and a principal UUID
      // from the task-finish writer above. One predicate, two encodings, and
      // it got BOTH of its answers wrong:
      //
      //   * the author was refused (`91af25a6`). A principal that filed a
      //     Report through `POST /reports` could not then name it while
      //     appending to or finishing its own Task: the row spells its author
      //     as a handle and the comparison offered a UUID, so the own-Report
      //     arm never matched and the caller got 400 `REPORT_NOT_LINKABLE` on
      //     its own Report.
      //
      //   * a stranger was admitted (`aad1894b`). `HANDLE_PATTERN`
      //     (`utils/credentialAuthority.ts`) admits a UUID-shaped handle, so
      //     principal A's handle can BE principal B's id. A Report A wrote
      //     through REST then carries `author_actor_id = A.handle = B.id`, and
      //     B passed the own-Report arm on A's Report — attaching another
      //     principal's Report to a Task of B's own choosing, which is a write
      //     to A's row and, through the access-vehicle recompute below, a
      //     conferral.
      //
      // `author_principal_id` is a UUID from BOTH writers and a foreign key to
      // `principals(id)`, so it cannot collide with a handle and it is the
      // column `AuthorizationRepository.sqlResource('report')` already reads as
      // owner and creator. Where it is NULL — a historical row migration 063
      // could not attribute — the comparison is NULL, the arm does not match,
      // and the Report is owned by NOBODY: not-own, fail-closed, never a guess
      // resolved out of the ambiguous column (review `99ba9444` B1).
      //
      // The other two arms are untouched: root still links anything, and a
      // Report already carried by this Task stays linkable by anyone who may
      // write the Task.
      `UPDATE reports
          SET task_ids = CASE WHEN $1::uuid = ANY(task_ids) THEN task_ids ELSE array_append(task_ids, $1::uuid) END,
              updated_at = NOW()
        WHERE ${LINKABLE_REPORT_PREDICATE}
        RETURNING id, project_id, author_principal_id`,
      [task.id, reportId, actor.root === true, this.ownerClaim(actor)],
    );
    if (report.rows.length === 0) throw new TaskElementError(400, 'REPORT_NOT_LINKABLE', REPORT_NOT_LINKABLE_MESSAGE, 'reportId');
    await feedEventService.emit(client, {
      name: 'report.updated',
      objectType: 'report',
      objectId: reportId,
      ...this.feedActor(actor),
      projectId: report.rows[0].project_id ?? null,
      // Review `99ba9444` B1: the owner is the canonical author column, not
      // the untagged provenance string. Absent, it is NULL - never a guess.
      ownerPrincipalId: report.rows[0].author_principal_id ?? null,
      payload: {},
    });
    await client.query(
      `INSERT INTO task_references (task_id, kind, target_id, target_uri, label, metadata, created_by_principal_id)
       SELECT $1, 'report', r.id, '/reports/' || r.id::text, r.title,
              jsonb_build_object('source', 'atomic-finish'), $3
         FROM reports r
        WHERE r.id = $2
          AND NOT EXISTS (
            SELECT 1 FROM task_references tr
             WHERE tr.task_id = $1 AND tr.kind = 'report' AND tr.target_id = $2
          )`,
      [task.id, reportId, actor.principalId],
    );
    // RH-P3.AZ-S7 (R2(b)): same-transaction recompute — this link edit
    // rides the caller's open transaction, and so does the vehicle. The
    // linker's own authority caps what the recompute may confer.
    await accessVehicleService.recompute(
      client, task.id,
      { principalId: actor.principalId ?? null, handle: actor.handle ?? 'system', authMethod: 'system' },
      linkerAuthorization(actor),
    );
  }

  private async promotionAllowed(client: PoolClient, actor: TaskElementActor): Promise<boolean> {
    const configured = Number(process.env.TASK_STREAM_AUTO_PROMOTION_PER_HOUR || 20);
    const cap = Number.isFinite(configured) && configured > 0 ? configured : 20;
    // Same class, same census (cards `aad1894b` / `91af25a6`): this cap is an
    // OWNERSHIP decision — "how many auto-promoted Reports are THIS
    // principal's" — and it too read the untagged provenance string. It now
    // reads the canonical author column.
    //
    // What the change is, exactly: `auto_promoted = TRUE` has ONE writer in
    // the tree, `createReport` above, and that writer puts the SAME principal
    // UUID into `author_actor_id` and `author_principal_id`. So on every row
    // this count can meet, the two columns agree and the swap preserves the
    // number. It removes an ambiguous read rather than repairing a reachable
    // miscount, and this comment is the whole of the claim — the suite that
    // covers it measures that an auto-promoted Report is owned by the
    // promoting principal and that the cap counts that principal's own rows,
    // not that the swap changed an answer.
    //
    // An unidentifiable principal gets no promotion at all: the oversized
    // entry goes to quarantine and the append still succeeds, which is the
    // fail-closed direction for a cap.
    const owner = this.ownerClaim(actor);
    if (!owner) return false;
    const result = await client.query(
      `SELECT COUNT(*)::int AS count FROM reports
        WHERE auto_promoted = TRUE AND author_principal_id = $1::uuid
          AND created_at >= NOW() - INTERVAL '1 hour'`,
      [owner],
    );
    return Number(result.rows[0]?.count || 0) < cap;
  }

  private async appendWithClient(
    client: PoolClient,
    task: TaskContext,
    input: AppendTaskEntryInput,
    actor: TaskElementActor,
  ): Promise<{ entry: any; reportId?: string; quarantineId?: string }> {
    this.validateAppend(input);
    const provenance = input.provenance || 'authored';
    let outpostTier: string | null = null;
    if (provenance === 'reported') {
      const service = await client.query(
        `SELECT visibility_tier FROM services WHERE id = $1 AND status <> 'retired'`,
        [input.outpostServiceId],
      );
      if (service.rows.length === 0) throw new TaskElementError(400, 'OUTPOST_NOT_ACTIVE', 'outpostServiceId must name an active Service', 'outpostServiceId');
      outpostTier = service.rows[0].visibility_tier || 'unrestricted';
    }
    if (input.referencedEntryId) {
      const referenced = await client.query(
        `SELECT id FROM task_stream_entries WHERE id = $1 AND task_id = $2`,
        [input.referencedEntryId, task.id],
      );
      if (referenced.rows.length === 0) {
        throw new TaskElementError(
          400,
          'REFERENCE_ENTRY_NOT_IN_TASK',
          'referencedEntryId must name an earlier stream entry on this Task',
          'referencedEntryId',
        );
      }
    }

    const masked = this.maskingEnabled(task) ? maskUnambiguousSecrets(input.content) : { content: input.content, masked: 0 };
    let streamContent = masked.content;
    let reportId: string | undefined = input.reportId;
    let quarantineId: string | undefined;
    let autoPromoted = false;
    if (streamContent.length > TASK_STREAM_ENTRY_LIMIT && !reportId) {
      autoPromoted = true;
      if (await this.promotionAllowed(client, actor)) {
        reportId = await this.createReport(
          client, task, actor, `Task handover: ${task.title}`, streamContent, undefined, true, outpostTier,
        );
        streamContent = `Auto-promoted to Report ${reportId}; needs review.`;
      } else {
        const quarantine = await client.query(
          `INSERT INTO task_stream_quarantine (
             task_id, author_principal_id, provenance, content, content_sha256,
             reason, effective_visibility
           ) VALUES ($1,$2,$3,$4,$5,'rate-cap',$6) RETURNING id`,
          [task.id, actor.principalId, provenance, streamContent, sha256(streamContent), `${task.visibility}:${outpostTier || 'task'}`],
        );
        quarantineId = quarantine.rows[0].id;
        streamContent = `Oversized entry accepted into quarantine ${quarantineId}; needs review.`;
      }
    }

    const role = this.authorRole(task, actor.principalId);
    const inserted = await client.query(
      `INSERT INTO task_stream_entries (
         task_id, provenance, event_type, content, author_principal_id,
         author_handle, author_role, outpost_service_id, outpost_visibility_tier,
         referenced_entry_id, report_id, quarantine_id, auto_promoted, safety_signal, metadata
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
       RETURNING *`,
      [
        task.id, provenance, input.eventType || (provenance === 'reported' ? 'outpost.reported' : 'handover.note'),
        streamContent, actor.principalId, actor.handle, role,
        provenance === 'reported' ? input.outpostServiceId : null, outpostTier,
        input.referencedEntryId || null, reportId || null, quarantineId || null, autoPromoted,
        provenance === 'reported' && SAFETY_EVENTS.has(input.eventType || ''),
        { ...(input.metadata || {}), ...(masked.masked ? { inboundMaskedCount: masked.masked } : {}) },
      ],
    );
    const entry = inserted.rows[0];

    if (reportId) {
      const linked = await client.query(
        `UPDATE reports SET source_stream_entry_id = $2 WHERE id = $1
         RETURNING project_id, author_principal_id`,
        [reportId, entry.id],
      );
      if ((linked.rowCount ?? 0) > 0) {
        await feedEventService.emit(client, {
          name: 'report.updated',
          objectType: 'report',
          objectId: reportId,
          ...this.feedActor(actor),
          projectId: linked.rows[0].project_id ?? null,
          // Review `99ba9444` B1: the canonical author column, or NULL.
          ownerPrincipalId: linked.rows[0].author_principal_id ?? null,
          payload: {},
        });
      }
      await this.linkReport(client, task, reportId, actor);
    }

    if (provenance === 'reported' && SAFETY_EVENTS.has(input.eventType || '')) {
      await client.query(
        `INSERT INTO task_stream_entries (
           task_id, provenance, event_type, content, safety_signal, metadata
         ) VALUES ($1,'system',$2,$3,TRUE,$4)`,
        [task.id, input.eventType, streamContent, { mirroredReportedEntryId: entry.id }],
      );
    }
    return { entry, ...(reportId ? { reportId } : {}), ...(quarantineId ? { quarantineId } : {}) };
  }

  async append(taskId: string, input: AppendTaskEntryInput, actor: TaskElementActor): Promise<any> {
    this.validateAppend(input);
    if (input.dryRun) return { valid: true, dryRun: true, schemaVersion: TASK_ELEMENT_INPUT_SCHEMA.version };
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const task = await this.taskContext(client, taskId);
      const result = await this.appendWithClient(client, task, input, actor);
      // Card 5854f0d6 (design section 4.2, choice C6): the PUBLIC append
      // announces an authored, non-restricted entry as ONE task.updated naming
      // the entry TYPE, never its content. System entries (claim, recovery,
      // wake receipts, the safety mirror) are not written through here.
      if (await this.streamEntryAnnounceable(client, result.entry)) {
        await feedEventService.emit(client, {
          name: 'task.updated',
          objectType: 'task',
          objectId: task.id,
          ...this.feedActor(actor),
          projectId: task.project_id ?? null,
          ownerPrincipalId: task.claimant_principal_id ?? null,
          payload: { stream: { entryType: String(result.entry.event_type) } },
        });
      }
      await client.query('COMMIT');
      return { valid: true, ...result };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async finish(taskId: string, input: FinishTaskInput, actor: TaskElementActor): Promise<any> {
    const handover = typeof input.handover === 'string' ? input.handover.trim() : '';
    if (input.reportId && input.report) throw new TaskElementError(400, 'AMBIGUOUS_REPORT', 'Supply reportId or report, not both');
    if (input.reportId && !UUID.test(input.reportId)) throw new TaskElementError(400, 'INVALID_REPORT_ID', 'reportId must be a Report UUID', 'reportId');
    if (input.report && (!input.report.title?.trim() || !input.report.content?.trim())) {
      throw new TaskElementError(400, 'INVALID_REPORT', 'report.title and report.content are required', 'report');
    }
    if (!input.reportId && !input.report && handover.length <= TASK_STREAM_ENTRY_LIMIT) {
      throw new TaskElementError(400, 'REPORT_REQUIRED', 'Finish requires a Report reference/content, or an oversized handover that can be auto-promoted', 'reportId');
    }
    if ((input.reportId || input.report) && handover.length > TASK_STREAM_ENTRY_LIMIT) {
      throw new TaskElementError(400, 'HANDOVER_TOO_LARGE', `handover must be at most ${TASK_STREAM_ENTRY_LIMIT} characters when a Report is supplied`, 'handover');
    }
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const task = await this.taskContext(client, taskId);
      await this.assertFinishable(client, task, input, actor, taskId);
      // Card 19dd180c: a dry run is the SAME finish up to its first write. It
      // used to answer valid straight after the input-shape checks above, so
      // an assigned Verifier, a principal with no Task role, a Task that was
      // not In Progress and a Task with open Subtasks were all told "valid"
      // by the preview while the identical real call was refused. It now
      // reads the same locked Task, runs every refusal above, then asks the
      // write path's own remaining refusals as reads, and rolls back.
      if (input.dryRun) {
        await this.previewFinishWrites(client, task, input, actor, handover, taskId);
        await client.query('ROLLBACK');
        return { valid: true, dryRun: true, targetStatus: task.verification_none === true ? 'completed' : 'review' };
      }

      let reportId = input.reportId;
      if (input.report) {
        const content = this.maskingEnabled(task) ? maskUnambiguousSecrets(input.report.content).content : input.report.content;
        reportId = await this.createReport(client, task, actor, input.report.title.trim(), content, input.report.summary, false, null);
      }

      const appended = await this.appendWithClient(
        client,
        task,
        {
          content: handover || (reportId ? `Report filed: ${reportId}` : input.handover || ''),
          eventType: 'handover.finish',
          provenance: 'authored',
          reportId,
        },
        actor,
      );
      reportId = reportId || appended.reportId;
      if (!reportId) throw new TaskElementError(500, 'REPORT_LINK_MISSING', REPORT_LINK_MISSING_MESSAGE);
      try {
        await nativeExecutionService.finishGenerationWithClient(client,taskId,reportId,input.nativeGeneration,actor);
      } catch(error) {
        if(error instanceof RequestFaultError) throw new TaskElementError(error.status,error.code,error.message);
        throw error;
      }
      await this.linkReport(client, task, reportId, actor);
      if (task.verification_none === true) {
        const completed = await this.completeWithoutVerification(client, task, actor, reportId, appended.entry);
        if (input.nativeGeneration) await this.assertNativeGenerationFinal(client, task.id, input.nativeGeneration.generationId);
        await client.query('COMMIT');
        return { success: true, taskId: task.id, status: 'completed', reportId, entry: appended.entry,
          verification: 'none', subtasksCompleted: completed.subtasksCompleted };
      }
      const reviewed = await client.query(
        `UPDATE tasks SET status = 'review', updated_at = NOW() WHERE id = $1
         RETURNING project_id, owner_principal_id`,
        [task.id],
      );
      // Card 5854f0d6 (design sections 4.2 and 4.3): the finish's handover
      // rides THIS status move as `stream` (never a second row), with the field
      // name and the acting principal.
      const handoverAnnounced = await this.streamEntryAnnounceable(client, appended.entry);
      await feedEventService.emit(client, {
        name: 'task.updated',
        objectType: 'task',
        objectId: task.id,
        ...this.feedActor(actor),
        projectId: reviewed.rows[0]?.project_id ?? null,
        ownerPrincipalId: reviewed.rows[0]?.owner_principal_id ?? null,
        payload: {
          status: 'review',
          previousStatus: 'in-progress',
          fields: ['status'],
          ...(handoverAnnounced ? { stream: { entryType: String(appended.entry.event_type) } } : {}),
        },
      });
      await client.query(
        `INSERT INTO task_stream_entries (task_id, provenance, event_type, content, report_id, metadata)
         VALUES ($1,'system','task.transitioned','in-progress -> review',$2,$3)`,
        [task.id, reportId, { from: 'in-progress', to: 'review', authoredEntryId: appended.entry.id }],
      );
      if (input.nativeGeneration) await this.assertNativeGenerationFinal(client, task.id, input.nativeGeneration.generationId);
      await client.query('COMMIT');
      return { success: true, taskId: task.id, status: 'review', reportId, entry: appended.entry };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  private async assertNativeGenerationFinal(client: PoolClient, taskId: string, generationId: string): Promise<void> {
    const finalAuthority=await client.query(`SELECT 1 FROM task_native_generations g JOIN task_native_executions e ON e.id=g.execution_id
      WHERE g.id=$1 AND g.task_id=$2 AND g.state='finished' AND clock_timestamp()<g.expires_at AND clock_timestamp()<e.hard_deadline`,[generationId,taskId]);
    if(finalAuthority.rowCount!==1) throw new TaskElementError(409,'NATIVE_GENERATION_EXPIRED','Original generation authority expired before joint commit');
  }

  /**
   * Section 6.8 (E462 S4b, check VM-B4/VM-B5): a `none` Task's finish
   * completes it in the finish's own transaction. Subtasks in Review are
   * completed with the reason `verification: none`; the Task moves straight
   * to `completed` with the same terminal effects a status move to
   * `completed` has (`runTaskTerminalEffects`, `announceStatusMove`: the
   * dependents get `task.ready` and the `implement` ring), the lifecycle
   * policy is asked, and the completion is recorded with its reason in the
   * stream, the audit log and the history.
   */
  private async completeWithoutVerification(client: PoolClient, task: TaskContext, actor: TaskElementActor,
    reportId: string, entry: any): Promise<{ subtasksCompleted: string[] }> {
    await lifecyclePolicyService.evaluate(client, {
      action: 'task.transition',
      subject: { kind: 'task', id: task.id, revision: task.updated_at ?? null },
      current: { status: 'in-progress', archived: false },
      proposed: { status: 'completed', archived: false },
    });
    const subtasks = await client.query(
      `UPDATE subtasks SET status = 'completed', completed_at = COALESCE(completed_at, NOW())
        WHERE task_id = $1 AND status = 'review' RETURNING id`, [task.id]);
    const subtasksCompleted = subtasks.rows.map((row: any) => String(row.id));
    const completed = await client.query(
      `UPDATE tasks SET status = 'completed', completed_at = COALESCE(completed_at, NOW()), updated_at = NOW()
        WHERE id = $1 AND verification_none AND verifier_principal_id IS NULL
        RETURNING project_id, owner_principal_id, title`,
      [task.id],
    );
    if (completed.rows.length !== 1) {
      throw new TaskElementError(409, 'VERIFICATION_NONE_CHANGED', 'The verification mode of this Task changed during finish');
    }
    const auditActor: AuditActor = { principalId: actor.principalId, handle: actor.handle,
      authMethod: actor.credentialId ? 'principal_api_key' : actor.sessionId ? 'session' : 'unknown', credentialId: actor.credentialId ?? null };
    await runTaskTerminalEffects(client, { taskId: task.id, to: 'completed', via: 'finish', actor: auditActor, detachVehicle: true });
    const handoverAnnounced = await this.streamEntryAnnounceable(client, entry);
    await feedEventService.emit(client, {
      name: 'task.updated',
      objectType: 'task',
      objectId: task.id,
      ...this.feedActor(actor),
      projectId: completed.rows[0]?.project_id ?? null,
      ownerPrincipalId: completed.rows[0]?.owner_principal_id ?? null,
      payload: {
        status: 'completed',
        previousStatus: 'in-progress',
        fields: ['status'],
        verification: 'none',
        ...(handoverAnnounced ? { stream: { entryType: String(entry.event_type) } } : {}),
      },
    });
    await client.query(
      `INSERT INTO task_stream_entries (task_id, provenance, event_type, content, report_id, metadata)
       VALUES ($1,'system','task.transitioned','in-progress -> completed (verification: none)',$2,$3)`,
      [task.id, reportId, { from: 'in-progress', to: 'completed', authoredEntryId: entry.id,
        reason: VERIFICATION_NONE_REASON, subtasksCompleted }],
    );
    await auditService.record({
      action: 'task.complete', actor: auditActor, resourceType: 'task', resourceId: task.id,
      metadata: { reason: VERIFICATION_NONE_REASON, basis: 'verification-none', reportId,
        setByPrincipalId: task.verification_none_set_by ?? null, setterBasis: task.verification_none_basis ?? null,
        subtasksCompleted, independentVerification: false },
    }, client);
    await taskHistoryService.recordChange(task.id, String(completed.rows[0]?.title ?? task.title), 'status', 'in-progress',
      'completed', actor.handle || 'user', actor.principalId ?? null, client);
    // The readiness boundary, as updateTask crosses it on a status move: this
    // Task, then its dependents (they get `task.ready` and the implement ring).
    const readinessActor = { principalId: actor.principalId, handle: actor.handle };
    await syncTaskReadiness(client, task.id, readinessActor);
    await syncDependentsReadiness(client, task.id, readinessActor);
    return { subtasksCompleted };
  }

  /**
   * Every refusal finish makes before its first write, in finish order, under
   * the Task row lock `taskContext` took. Execution and the dry run both run
   * exactly this (card 19dd180c), so the preview cannot drift from the act.
   */
  private async assertFinishable(
    client: PoolClient, task: TaskContext, input: FinishTaskInput, actor: TaskElementActor, taskId: string,
  ): Promise<void> {
      // RH-P3.C3: never-self-review at the FINISH altitude.
      //
      // Strategy 4e40f06f §2.6.4 hands lifecycle moves to the claimant
      // (claim = todo->in-progress; finish = ->review with report) and to
      // the shepherd (force-release, reassign, park). It hands the Verifier
      // nothing of the kind, and the shared predicate agrees literally: the
      // verifier arm in AuthorizationService allows `read` and `verify` and
      // no other action. Vocabulary b94dd86e §5.3 states the rule as
      // "the server refuses claimant == verifier — never-self-review,
      // enforced rather than advised".
      //
      // The pre-C3 gate was `authorRole(...) === 'other'`, which admitted
      // the Verifier along with the claimant and the shepherd: the identity
      // that must judge the work could hand it to itself for judgment. That
      // is the same doctrine failing that the orchestration claim plane
      // shows at claim time, one altitude later.
      if (this.authorRole(task, actor.principalId) === 'other') {
        throw new TaskElementError(403, 'TASK_ROLE_REQUIRED', 'Only the Task claimant or shepherd may finish this Task');
      }
      // Asked of the FIELD, not of authorRole's first match. authorRole
      // resolves claimant -> shepherd -> verifier and returns the first hit,
      // so a principal holding the shepherd role AS WELL AS the verifier
      // role answers "shepherd" and would walk past this refusal — which is
      // exactly what live QA on DEV caught. `tasks_claimant_verifier_separation`
      // makes claimant+verifier unrepresentable; shepherd+verifier is not,
      // and that identity finishing the Task is self-review just the same.
      if (task.verifier_principal_id && task.verifier_principal_id === actor.principalId) {
        throw new TaskElementError(403, 'CLAIMANT_VERIFIER_CONFLICT', 'The assigned Verifier cannot finish the Task it must judge');
      }
      if (task.status !== 'in-progress') {
        throw new TaskElementError(409, 'TASK_NOT_FINISHABLE', `Task must be in-progress before finish (current: ${task.status})`);
      }
      // Section 6.8 (E462 S4b): a `none` Task re-runs the chain guard between
      // the stored setter and the finishing actor, the claimer and the
      // execution connector (VERIFICATION_NONE_SELF_SET).
      if (task.verification_none === true) {
        try {
          await assertVerificationNoneFinishable(client, task, actor.principalId);
        } catch (error) {
          if (error instanceof VerificationModeError) throw new TaskElementError(error.status, error.code, error.message);
          throw error;
        }
      }
      // Only the new Task-report producer has this immutable provenance and
      // transactional operation mapping. Legacy inline/API finish is unchanged.
      if (input.reportId) {
        const saved=(await client.query('SELECT origin,source_task_id,author_principal_id,content_hash,status,deleted_at FROM reports WHERE id=$1',[input.reportId])).rows[0];
        if (saved?.origin==='task-report') {
          const mapped=await client.query(`SELECT 1 FROM task_report_operations WHERE task_id=$1 AND author_principal_id=$2
            AND report_id=$3 AND content_hash=$4 LIMIT 1`,[taskId,actor.principalId,input.reportId,saved.content_hash]);
          if (saved.source_task_id!==taskId || saved.author_principal_id!==actor.principalId
            || saved.status!=='active' || saved.deleted_at || mapped.rows.length!==1)
            throw new TaskElementError(409,'TASK_REPORT_HANDOFF_PROVENANCE','Saved Task Report provenance or current operation mapping changed');
          if (!actor.authorization) throw new TaskElementError(403,'TASK_REPORT_AUTHORITY_REVOKED','Saved Task Report handoff requires current authenticated authority');
          await this.currentReportAuthority(client,taskId,actor,'write');
        }
      }
      const unfinished = await client.query(
        `SELECT id, index, status FROM subtasks
          WHERE task_id = $1 AND status NOT IN ('review','completed','skipped')
          ORDER BY index LIMIT 1`,
        [task.id],
      );
      if (unfinished.rows.length > 0) {
        const row = unfinished.rows[0];
        throw new TaskElementError(409, 'SUBTASK_NOT_HANDED_BACK', `Subtask ${row.id} (display index ${row.index}) is ${row.status}; every Subtask must be in review, completed, or skipped`);
      }
  }

  /**
   * The refusals finish's WRITE path can still make after `assertFinishable`,
   * asked as reads, in the order the writes would meet them (card 19dd180c).
   * Nothing here inserts, updates or deletes; the caller rolls back.
   *
   *   1. a named `reportId` must pass `linkReport`'s predicate - the same
   *      SQL text, `LINKABLE_REPORT_PREDICATE`, read instead of written;
   *   2. with no Report named or inline, the handover must auto-promote: a
   *      masked handover at or under the stream limit, or one the hourly
   *      promotion cap sends to quarantine, leaves finish without a Report and
   *      the real call answers REPORT_LINK_MISSING, so the dry run does too;
   *   3. the native-generation gate runs in its own dry-run mode, which stops
   *      before its one UPDATE and reads that UPDATE's deadline predicate.
   *      A Report the dry run would create has no id yet, so the gate meets
   *      `null` where the real call meets an id no publication can name;
   *      both are refused alike.
   *
   * Not rehearsed: the access-vehicle recompute `linkReport` runs after it
   * links. It recomputes the Task's role Grants rather than deciding whether
   * this principal may finish, and it writes as it goes.
   */
  private async previewFinishWrites(
    client: PoolClient, task: TaskContext, input: FinishTaskInput, actor: TaskElementActor, handover: string, taskId: string,
  ): Promise<void> {
    if (input.reportId) {
      const linkable = await client.query(
        `SELECT 1 FROM reports WHERE ${LINKABLE_REPORT_PREDICATE}`,
        [task.id, input.reportId, actor.root === true, this.ownerClaim(actor)],
      );
      if (linkable.rows.length === 0) throw new TaskElementError(400, 'REPORT_NOT_LINKABLE', REPORT_NOT_LINKABLE_MESSAGE, 'reportId');
    } else if (!input.report) {
      const streamContent = this.maskingEnabled(task) ? maskUnambiguousSecrets(handover).content : handover;
      if (streamContent.length <= TASK_STREAM_ENTRY_LIMIT || !(await this.promotionAllowed(client, actor))) {
        throw new TaskElementError(500, 'REPORT_LINK_MISSING', REPORT_LINK_MISSING_MESSAGE);
      }
    }
    try {
      await nativeExecutionService.finishGenerationWithClient(
        client, taskId, input.reportId ?? null, input.nativeGeneration, actor, { dryRun: true },
      );
    } catch (error) {
      if (error instanceof RequestFaultError) throw new TaskElementError(error.status, error.code, error.message);
      throw error;
    }
  }

  private async currentReportAuthority(client: PoolClient, taskId: string, actor: TaskElementActor, action: 'read' | 'write'): Promise<void> {
    if (!actor.authorization) return; // Internal server callers still require the locked claimant below.
    const chain = await delegationService.resolveChain(actor.principalId, client);
    if (!chain.alive) throw new TaskElementError(403, 'TASK_REPORT_AUTHORITY_REVOKED', 'Current Report authority is no longer live');
    for (const link of chain.links) if (link.parentPrincipalId) {
      const live = await client.query(`SELECT 1 FROM principal_credentials WHERE principal_id=$1 AND revoked_at IS NULL
        AND (expires_at IS NULL OR expires_at>clock_timestamp()) AND (grace_until IS NULL OR grace_until>clock_timestamp()) LIMIT 1`, [link.principalId]);
      if (!live.rows.length) throw new TaskElementError(403,'TASK_REPORT_AUTHORITY_REVOKED','Delegation authority expired');
    }
    if (actor.credentialId) {
      const credential = await client.query(`SELECT scopes FROM principal_credentials WHERE id=$1 AND principal_id=$2 AND revoked_at IS NULL
        AND (expires_at IS NULL OR expires_at>clock_timestamp()) AND (grace_until IS NULL OR grace_until>clock_timestamp())`,[actor.credentialId,actor.principalId]);
      if (!credential.rows.length || !scopesSatisfy(credential.rows[0].scopes, action==='write'?'tasks:write':'tasks:read'))
        throw new TaskElementError(403,'TASK_REPORT_AUTHORITY_REVOKED','Credential authority changed');
    }
    if (actor.sessionId) {
      const session = await client.query(`SELECT 1 FROM auth_sessions WHERE id=$1 AND principal_id=$2 AND revoked_at IS NULL
        AND expires_at>clock_timestamp() AND last_seen_at>clock_timestamp()-($3::bigint*INTERVAL '1 millisecond')`,[actor.sessionId,actor.principalId,sessionIdleMs()]);
      if (!session.rows.length) throw new TaskElementError(403,'TASK_REPORT_AUTHORITY_REVOKED','Session authority changed');
    }
    const snapshots=await taskAuthoritySnapshot(client,actor,taskId,action==='write'?'tasks:write':'tasks:read');
    if(!snapshots)throw new TaskElementError(403,'TASK_REPORT_AUTHORITY_REVOKED','Current identity or delegation scope changed');
    const capTask=(await client.query('SELECT project_id FROM tasks WHERE id=$1',[taskId])).rows[0];
    if (!capTask) throw new TaskElementError(403,'TASK_REPORT_AUTHORITY_REVOKED','Task authority changed');
    for(const snapshot of snapshots)if (!explicitTaskActionCaps(snapshot,{type:'task',id:taskId,projectId:capTask.project_id},action)
      || !(await authorizationRepository.authorizedIds(snapshot,'task',[taskId],action,client)).has(taskId))
      throw new TaskElementError(403,'TASK_REPORT_AUTHORITY_REVOKED','Task authority changed');
  }

  private assertReportClaimant(task: TaskContext, actor: TaskElementActor): void {
    if (!this.ownerClaim(actor) || task.claimant_principal_id !== actor.principalId || task.verifier_principal_id === actor.principalId)
      throw new TaskElementError(403, "TASK_CLAIMANT_REQUIRED", "Only the current independent claimant may maintain its Task Report");
    if (task.status !== "in-progress") throw new TaskElementError(409, "TASK_REPORT_FROZEN", "Task Reports may be maintained only while the Task is in progress");
  }

  /** Display-only snapshot of the same locked policy as save. No grant or mutation.
   * Missing identity and unexpected errors are denied; saves always check again.
   * The Task lock is waited for at most TASK_READ_LOCK_TIMEOUT_MS (card e5240c73):
   * when that expires the read is refused with TASK_READ_BUSY rather than shown
   * a decision this projection could not take. */
  async taskReportMaintenanceAccess(taskId: string, actor: TaskElementActor): Promise<{allowed: boolean; reason: string | null}> {
    if (!actor.authorization?.authenticated || actor.authorization.principalId !== actor.principalId || !this.ownerClaim(actor))
      return {allowed: false, reason: "TASK_REPORT_AUTHORITY_REVOKED"};
    let client: PoolClient | undefined;
    let decision: {allowed: boolean; reason: string | null} = {allowed: false, reason: "TASK_REPORT_ACCESS_UNAVAILABLE"};
    let busy = false;
    try {
      client = await this.pool.connect();
      await client.query("BEGIN");
      await client.query(`SET LOCAL lock_timeout = '${TASK_READ_LOCK_TIMEOUT_MS}ms'`);
      const task = await this.taskContext(client, taskId);
      this.assertReportClaimant(task, actor);
      await this.currentReportAuthority(client, taskId, actor, "write");
      await client.query("COMMIT");
      decision = {allowed: true, reason: null};
    } catch (error) {
      busy = lockTimedOut(error);
      decision = {allowed: false, reason: error instanceof TaskElementError ? error.code : "TASK_REPORT_ACCESS_UNAVAILABLE"};
      if (client) {
        try { await client.query("ROLLBACK"); } catch { /* Display-only cleanup cannot break a readable Task. */ }
      }
    } finally {
      if (client) {
        try { client.release(); } catch {
          // Even a successful lookup is not an enable signal when cleanup fails.
          if (decision.allowed) decision = {allowed: false, reason: "TASK_REPORT_ACCESS_UNAVAILABLE"};
        }
      }
    }
    if (busy) throw new TaskElementError(409, "TASK_READ_BUSY", TASK_READ_BUSY_MESSAGE);
    return decision;
  }

  private reportRequestHash(input: SaveTaskReportInput): string {
    return taskReportRequestHash(input);
  }

  private async operationResult(client: PoolClient, taskId: string, key: string, actor: TaskElementActor, expectedHash?: string): Promise<any | null> {
    const operation=(await client.query('SELECT * FROM task_report_operations WHERE task_id=$1 AND author_principal_id=$2 AND operation_key=$3',[taskId,actor.principalId,key])).rows[0];
    if (!operation) return null;
    if (expectedHash && operation.request_hash!==expectedHash) throw new TaskElementError(409,'TASK_REPORT_OPERATION_CHANGED','The logical operation names different input');
    const report=(await client.query(`SELECT * FROM reports WHERE id=$1 AND source_task_id=$2 AND author_principal_id=$3 AND origin='task-report' AND status='active' AND deleted_at IS NULL`,[operation.report_id,taskId,actor.principalId])).rows[0];
    if (!report || report.content_hash!==operation.content_hash) throw new TaskElementError(409,'TASK_REPORT_RESULT_CHANGED','The committed Report changed; read its current state');
    return {success:true,taskId,report,operation:{key,requestHash:operation.request_hash,contentHash:operation.content_hash}};
  }

  async readTaskReportOperation(taskId: string, key: string, actor: TaskElementActor, expectedHash: string): Promise<any> {
    const client=await this.pool.connect();
    try {
      await client.query('BEGIN');const task=await this.taskContext(client,taskId);
      if (!this.ownerClaim(actor) || task.claimant_principal_id!==actor.principalId || task.verifier_principal_id===actor.principalId || task.status!=='in-progress')
        throw new TaskElementError(403,'TASK_CLAIMANT_REQUIRED','Exact operation reconciliation requires the current independent claimant');
      await this.currentReportAuthority(client,taskId,actor,'read');
      const result=await this.operationResult(client,taskId,key,actor,expectedHash);
      if (!result) throw new TaskElementError(404,'TASK_REPORT_OPERATION_UNKNOWN','No committed operation is known; do not blindly create again');
      await client.query('COMMIT');return result;
    } catch(error) {await client.query('ROLLBACK');throw error;} finally {client.release();}
  }

  /** A claimant's mutable progress Report; finish freezes it by moving the Task to Review.
   * Authority and assignment are checked again under the same Task row lock as finish. */
  async saveTaskReport(taskId: string, input: SaveTaskReportInput, actor: TaskElementActor, operationKey?: string): Promise<any> {
    const allowed = new Set(['reportId', 'title', 'content', 'summary', 'expectedContentHash']);
    if (!input || typeof input !== 'object' || Array.isArray(input)
      || Object.keys(input).some(key => !allowed.has(key))
      || typeof input.title !== 'string' || !input.title.trim() || input.title.length > 500
      || typeof input.content !== 'string' || !input.content.trim()
      || (input.summary !== undefined && (typeof input.summary !== 'string' || input.summary.length > 500))
      || (input.reportId !== undefined && !UUID.test(input.reportId))
      || (input.reportId && !/^[a-f0-9]{64}$/.test(input.expectedContentHash || ''))) {
      throw new TaskElementError(400, 'INVALID_TASK_REPORT', 'Provide title/content and the current content hash when editing');
    }
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const task = await this.taskContext(client, taskId);
      this.assertReportClaimant(task, actor);
      await this.currentReportAuthority(client,taskId,actor,'write');
      const requestHash=this.reportRequestHash(input);
      if (operationKey) {
        const known=await this.operationResult(client,taskId,operationKey,actor,requestHash);
        if (known) {await client.query('COMMIT');return known;}
      }
      const content = this.maskingEnabled(task) ? maskUnambiguousSecrets(input.content).content : input.content;
      // Source binding is server-written; task_ids is never used as editing authority.
      let reportId = input.reportId;
      if (reportId) {
        const updated = await client.query(
          `UPDATE reports SET title=$3, content=$4, content_hash=$5, summary=$6, updated_at=NOW()
             WHERE id=$1 AND source_task_id=$2 AND origin='task-report'
               AND author_principal_id=$7 AND status='active' AND deleted_at IS NULL
               AND content_hash=$8 RETURNING id`,
          [reportId, task.id, input.title.trim(), content, sha256(content), input.summary || summarize(content), actor.principalId, input.expectedContentHash],
        );
        if (!updated.rows.length) throw new TaskElementError(409, 'TASK_REPORT_CONFLICT', 'The Report is foreign, frozen, or changed; read it before editing');
      } else {
        reportId = await this.createReport(client, task, actor, input.title.trim(), content, input.summary, false, null);
        await client.query("UPDATE reports SET origin='task-report', visibility='private' WHERE id=$1", [reportId]);
      }
      await this.linkReport(client, task, reportId!, actor);
      const report = await client.query('SELECT * FROM reports WHERE id=$1', [reportId]);
      if (operationKey) await client.query('INSERT INTO task_report_operations(task_id,author_principal_id,operation_key,request_hash,report_id,content_hash) VALUES($1,$2,$3,$4,$5,$6)',[taskId,actor.principalId,operationKey,requestHash,reportId,report.rows[0].content_hash]);
      await client.query('COMMIT');
      return { success: true, taskId: task.id, report: report.rows[0], operation: operationKey ? {key:operationKey,requestHash,contentHash:report.rows[0].content_hash} : undefined };
    } catch (error) { await client.query('ROLLBACK'); throw error; }
    finally { client.release(); }
  }

  /**
   * The candidate set of the `progress` Report context scope: server-bound
   * task progress Reports of this Task that carry their genuine Reference.
   * Ids only — the bounded context (`TaskReportContext`) authorizes, orders,
   * pages and summarises them, so this read never returns a Report body.
   */
  async taskReportIds(taskId: string): Promise<string[]> {
    const result = await this.pool.query(
      `SELECT r.id::text AS id FROM reports r WHERE r.source_task_id=$1 AND r.origin='task-report'
         AND r.deleted_at IS NULL AND EXISTS (SELECT 1 FROM task_references tr
           WHERE tr.task_id=$1 AND tr.kind='report' AND tr.target_id=r.id)`, [taskId]);
    return result.rows.map(row => String(row.id));
  }

  /**
   * One server-bound task progress Report of this Task — the same binding as
   * `taskReportIds` — as the full row the save answers with: body and
   * content_hash included. Binding only, no authorization:
   * `TaskReportContext.readTaskProgressReport` decides first whether the
   * caller may read it (card 50b5e9c4 round-1 B1).
   */
  async taskProgressReport(taskId: string, reportId: string): Promise<Record<string, unknown> | null> {
    const result = await this.pool.query(
      `SELECT r.* FROM reports r WHERE r.id=$2 AND r.source_task_id=$1 AND r.origin='task-report'
         AND r.deleted_at IS NULL AND EXISTS (SELECT 1 FROM task_references tr
           WHERE tr.task_id=$1 AND tr.kind='report' AND tr.target_id=r.id)`, [taskId, reportId]);
    return result.rows[0] ?? null;
  }

  async listStream(taskId: string, actor: TaskElementActor): Promise<any[]> {
    const result = await this.pool.query(
      `WITH RECURSIVE reference_chain(origin_id, current_id, tier, path) AS (
         SELECT e.id, e.referenced_entry_id, e.outpost_visibility_tier, ARRAY[e.id]
           FROM task_stream_entries e
          WHERE e.task_id = $1
         UNION ALL
         SELECT chain.origin_id, parent.referenced_entry_id,
                parent.outpost_visibility_tier, chain.path || parent.id
           FROM reference_chain chain
           JOIN task_stream_entries parent ON parent.id = chain.current_id
          WHERE NOT parent.id = ANY(chain.path)
       ), restricted AS (
         SELECT DISTINCT origin_id FROM reference_chain WHERE tier = 'assigned-only'
       )
       SELECT e.*
         FROM task_stream_entries e
         JOIN tasks t ON t.id = e.task_id
        WHERE e.task_id = $1
          AND (
            $2::boolean
            OR $3::uuid IN (t.owner_principal_id, t.shepherd_principal_id, t.verifier_principal_id)
            OR e.id NOT IN (SELECT origin_id FROM restricted)
          )
        ORDER BY e.stream_offset`,
      [taskId, actor.root === true, actor.principalId],
    );
    return result.rows;
  }

  private validateReference(input: CreateTaskReferenceInput): void {
    if (!TASK_REFERENCE_BASE_KINDS.includes(input.kind as any) && !PLUGIN_KIND.test(input.kind || '')) {
      throw new TaskElementError(400, 'INVALID_REFERENCE_KIND', 'kind must be a base Task Reference kind or a namespaced plugin kind', 'kind');
    }
    if (!input.targetId && !input.targetUri?.trim()) {
      throw new TaskElementError(400, 'REFERENCE_TARGET_REQUIRED', 'targetId or targetUri is required', 'targetId');
    }
    if (input.targetId && !UUID.test(input.targetId)) {
      throw new TaskElementError(400, 'INVALID_REFERENCE_TARGET', 'targetId must be a UUID', 'targetId');
    }
    if (!input.label?.trim()) throw new TaskElementError(400, 'REFERENCE_LABEL_REQUIRED', 'label is required', 'label');
  }

  async createReference(taskId: string, input: CreateTaskReferenceInput, actor: TaskElementActor, transaction?: CreationTransaction): Promise<any> {
    if (transaction && actor.principalId !== transaction.actor.principalId) throw new Error('Creation actor mismatch');
    this.validateReference(input);
    if (input.dryRun) return { valid: true, dryRun: true, kind: input.kind };
    // RH-P3.AZ-S7 (ruling 7440b579 R2(b)): "recomputed in the SAME
    // transaction as any link edit while assigned". Linked reports and
    // referenced skills are part of the D5 reference set, so this write
    // takes a transaction it did not need before — the recompute has to
    // commit with the reference or not at all.
    const client = transaction?.client ?? await this.pool.connect();
    try {
      if (!transaction) await client.query('BEGIN');
      const result = await client.query(
        `INSERT INTO task_references (
           task_id, kind, target_id, target_uri, label, metadata, created_by_principal_id
         ) SELECT $1,$2,$3,$4,$5,$6,$7
            WHERE EXISTS (SELECT 1 FROM tasks WHERE id = $1)
         RETURNING *`,
        [
          taskId, input.kind, input.targetId || null, input.targetUri?.trim() || null,
          input.label.trim(), { ...(input.metadata || {}), ...(PLUGIN_KIND.test(input.kind) ? { inertUntilPluginAvailable: true } : {}) },
          actor.principalId,
        ],
      );
      if (result.rows.length === 0) throw new TaskElementError(404, 'TASK_NOT_FOUND', 'Task not found');
      await accessVehicleService.recompute(
        client, taskId,
        { principalId: actor.principalId ?? null, handle: actor.handle ?? 'system', authMethod: transaction?.actor.authMethod ?? 'system' },
        linkerAuthorization(actor),
      );
      if (!transaction) await client.query('COMMIT');
      return result.rows[0];
    } catch (e) {
      if (!transaction) await client.query('ROLLBACK').catch(() => undefined);
      throw e;
    } finally {
      if (!transaction) client.release();
    }
  }

  async listReferences(taskId: string): Promise<any[]> {
    const result = await this.pool.query(
      `SELECT * FROM task_references WHERE task_id = $1 ORDER BY created_at, id`,
      [taskId],
    );
    return result.rows;
  }

  /** Additional R4 intersection filter applied after ordinary Report access. */
  async filterPromotedReports<T extends {
    auto_promoted?: boolean;
    source_task_id?: string | null;
    source_outpost_visibility_tier?: string | null;
  }>(reports: T[], actor: TaskElementActor): Promise<T[]> {
    if (actor.root) return reports;
    const restrictedTaskIds = [...new Set(
      reports
        .filter((report) => report.auto_promoted && report.source_outpost_visibility_tier === 'assigned-only' && report.source_task_id)
        .map((report) => report.source_task_id as string),
    )];
    if (restrictedTaskIds.length === 0) return reports;
    const allowed = await this.pool.query(
      `SELECT task_id FROM task_assignments
        WHERE task_id = ANY($1::uuid[])
          AND $2::uuid IN (claimant_principal_id, shepherd_principal_id, verifier_principal_id)`,
      [restrictedTaskIds, actor.principalId],
    );
    const allowedIds = new Set(allowed.rows.map((row) => row.task_id));
    return reports.filter((report) =>
      !report.auto_promoted
      || report.source_outpost_visibility_tier !== 'assigned-only'
      || (report.source_task_id ? allowedIds.has(report.source_task_id) : false),
    );
  }

  async redact(
    taskId: string,
    entryId: string,
    input: { mode: 'span' | 'tombstone' | 'author-erasure'; reason: 'secret-hygiene' | 'personal-data' | 'owner-order'; target?: string; dryRun?: boolean },
    actor: TaskElementActor,
  ): Promise<any> {
    if (!actor.root) throw new TaskElementError(403, 'ROOT_REQUIRED', 'Task stream redaction is root-only');
    if (!UUID.test(entryId)) throw new TaskElementError(400, 'INVALID_STREAM_ENTRY', 'entryId must be a UUID', 'entryId');
    if (!['span', 'tombstone', 'author-erasure'].includes(input.mode)) throw new TaskElementError(400, 'INVALID_REDACTION_MODE', 'Invalid redaction mode', 'mode');
    if (!['secret-hygiene', 'personal-data', 'owner-order'].includes(input.reason)) throw new TaskElementError(400, 'INVALID_REDACTION_REASON', 'Invalid redaction reason', 'reason');
    if (input.mode === 'span' && !input.target) throw new TaskElementError(400, 'REDACTION_TARGET_REQUIRED', 'span redaction requires target', 'target');
    if (input.dryRun) return { valid: true, dryRun: true };
    const hmacKey = process.env.TASK_STREAM_REDACTION_HMAC_KEY;
    if (!hmacKey) throw new TaskElementError(503, 'REDACTION_KEY_UNAVAILABLE', 'The owner-held stream redaction key is not configured');

    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await client.query(
        `SELECT * FROM task_stream_entries WHERE id = $1 AND task_id = $2 FOR UPDATE`,
        [entryId, taskId],
      );
      if (result.rows.length === 0) throw new TaskElementError(404, 'STREAM_ENTRY_NOT_FOUND', 'Task stream entry not found');
      const entry = result.rows[0];
      if (entry.redacted_at) throw new TaskElementError(409, 'ALREADY_REDACTED', 'Task stream entry is already redacted');

      let content = entry.content as string;
      let authorPrincipalId = entry.author_principal_id;
      let authorHandle = entry.author_handle;
      let authorRole = entry.author_role;
      const destroyed: string[] = [];
      if (input.mode === 'span') {
        if (!content.includes(input.target!)) throw new TaskElementError(400, 'REDACTION_TARGET_NOT_FOUND', 'target does not occur in the stream entry', 'target');
        const occurrenceCount = content.split(input.target!).length - 1;
        destroyed.push(...Array(occurrenceCount).fill(input.target!));
        content = content.split(input.target!).join('[REDACTED]');
      } else if (input.mode === 'tombstone') {
        destroyed.push(content);
        content = `[REDACTED ENTRY: ${input.reason}]`;
      } else {
        destroyed.push(`${authorPrincipalId || ''}|${authorHandle || ''}|${authorRole || ''}`);
        authorPrincipalId = null;
        authorHandle = '[erased]';
        authorRole = null;
      }

      if (entry.report_id && entry.auto_promoted) {
        const report = await client.query(`SELECT * FROM reports WHERE id = $1 FOR UPDATE`, [entry.report_id]);
        if (report.rows.length > 0) {
          const row = report.rows[0];
          let reportContent = row.content as string;
          let reportSummary = row.summary as string | null;
          let reportAuthor = row.author as string;
          let reportActor = row.author_actor_id;
          let reportPrincipal = row.author_principal_id;
          if (input.mode === 'span') {
            if (reportContent.includes(input.target!)) {
              const occurrenceCount = reportContent.split(input.target!).length - 1;
              destroyed.push(...Array(occurrenceCount).fill(input.target!));
              reportContent = reportContent.split(input.target!).join('[REDACTED]');
              if (reportSummary) reportSummary = reportSummary.split(input.target!).join('[REDACTED]');
            }
          } else if (input.mode === 'tombstone') {
            destroyed.push(reportContent);
            reportContent = `[REDACTED REPORT: ${input.reason}]`;
            reportSummary = reportContent;
          } else {
            // ROUND 1 FINDING P1. Author-erasure used to clear the provenance
            // string and the unverified label and leave `author_principal_id`
            // standing, which was harmless only while nothing read that
            // column. It is now the column the Report's verified attribution
            // and its feed owner are BOTH resolved from, so an erased Report
            // was rendered under the erased author's name again.
            //
            // An erasure erases the author. The canonical column goes with the
            // rest of it, is destroyed under the same HMAC fingerprint, and
            // the event below therefore emits no owner. This also withdraws
            // the erased principal's OWNERSHIP of the Report — that is the
            // intended reading of a root-ordered author-erasure, and it fails
            // closed: a private Report so erased is readable by root alone.
            destroyed.push(`${reportActor || ''}|${reportAuthor || ''}|${row.author_principal_id || ''}`);
            reportActor = null;
            reportAuthor = '[erased]';
            reportPrincipal = null;
          }
          const redacted = await client.query(
            `UPDATE reports SET content = $2, content_hash = $3, summary = $4,
                                author = $5, author_actor_id = $6,
                                author_principal_id = $7, updated_at = NOW()
              WHERE id = $1
              RETURNING project_id, author_principal_id`,
            [entry.report_id, reportContent, sha256(reportContent), reportSummary, reportAuthor, reportActor, reportPrincipal],
          );
          if ((redacted.rowCount ?? 0) > 0) {
            await feedEventService.emit(client, {
              name: 'report.updated',
              objectType: 'report',
              objectId: entry.report_id,
              // Card 5854f0d6: a redaction records NO acting principal. An
              // author-erasure ordered by the author would otherwise re-attach
              // the erased person to the Report it was erased from.
              projectId: redacted.rows[0].project_id ?? null,
              // Review `99ba9444` B1: the canonical author column, or NULL.
              ownerPrincipalId: redacted.rows[0].author_principal_id ?? null,
              payload: {},
            });
          }
        }
      }

      const fingerprint = crypto.createHmac('sha256', hmacKey).update(destroyed.join('\u0000'), 'utf8').digest('hex');
      await client.query(`SELECT set_config('relayhall.stream_redaction_actor', $1, TRUE)`, [actor.principalId]);
      await client.query(`SELECT set_config('relayhall.stream_redaction_mode', $1, TRUE)`, [input.mode]);
      await client.query(`SELECT set_config('relayhall.stream_redaction_reason', $1, TRUE)`, [input.reason]);
      await client.query(`SELECT set_config('relayhall.stream_redaction_hmac', $1, TRUE)`, [fingerprint]);
      const updated = await client.query(
        `UPDATE task_stream_entries
            SET content = $3, author_principal_id = $4, author_handle = $5, author_role = $6
          WHERE id = $1 AND task_id = $2
        RETURNING *`,
        [entryId, taskId, content, authorPrincipalId, authorHandle, authorRole],
      );
      await client.query('COMMIT');
      return updated.rows[0];
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
}

export const taskElementService = new TaskElementService();
