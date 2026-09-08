import type { CreationTransaction } from '../db/creationTransaction';
import crypto from 'crypto';
import { Pool, PoolClient } from 'pg';
import { pool as defaultPool } from '../db/connection';
import { feedEventService } from './FeedEventService';
import { accessVehicleService } from './AccessVehicleService';
import type { AuthorizationActor } from './AuthorizationService';

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
  handle: string;
  root?: boolean;
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
  handover?: string;
  reportId?: string;
  report?: { title: string; content: string; summary?: string };
  dryRun?: boolean;
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

export class TaskElementService {
  constructor(private readonly pool: Pool = defaultPool) {}

  private async taskContext(client: PoolClient, taskId: string): Promise<TaskContext> {
    const result = await client.query(
      `SELECT t.id, t.title, t.status, t.visibility, t.project_id,
              COALESCE(p.task_stream_masking_enabled, TRUE) AS masking_enabled,
              a.claimant_principal_id, a.shepherd_principal_id, a.verifier_principal_id
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
    // announces itself in the creating transaction.
    await feedEventService.emit(client, {
      name: 'report.created',
      objectType: 'report',
      objectId: result.rows[0].id,
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
        WHERE id = $2 AND deleted_at IS NULL AND status = 'active'
          AND ($3::boolean OR author_principal_id = $4::uuid OR $1::uuid = ANY(task_ids))
        RETURNING id, project_id, author_principal_id`,
      [task.id, reportId, actor.root === true, this.ownerClaim(actor)],
    );
    if (report.rows.length === 0) throw new TaskElementError(400, 'REPORT_NOT_LINKABLE', 'reportId must name an active Report', 'reportId');
    await feedEventService.emit(client, {
      name: 'report.updated',
      objectType: 'report',
      objectId: reportId,
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
    if (input.dryRun) return { valid: true, dryRun: true, targetStatus: 'review' };

    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const task = await this.taskContext(client, taskId);
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
      if (!reportId) throw new TaskElementError(500, 'REPORT_LINK_MISSING', 'Atomic finish did not produce a Report');
      await this.linkReport(client, task, reportId, actor);
      const reviewed = await client.query(
        `UPDATE tasks SET status = 'review', updated_at = NOW() WHERE id = $1
         RETURNING project_id, owner_principal_id`,
        [task.id],
      );
      await feedEventService.emit(client, {
        name: 'task.updated',
        objectType: 'task',
        objectId: task.id,
        projectId: reviewed.rows[0]?.project_id ?? null,
        ownerPrincipalId: reviewed.rows[0]?.owner_principal_id ?? null,
        payload: { status: 'review', previousStatus: 'in-progress' },
      });
      await client.query(
        `INSERT INTO task_stream_entries (task_id, provenance, event_type, content, report_id, metadata)
         VALUES ($1,'system','task.transitioned','in-progress -> review',$2,$3)`,
        [task.id, reportId, { from: 'in-progress', to: 'review', authoredEntryId: appended.entry.id }],
      );
      await client.query('COMMIT');
      return { success: true, taskId: task.id, status: 'review', reportId, entry: appended.entry };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
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
