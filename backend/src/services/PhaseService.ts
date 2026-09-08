import { blueprintProvenanceOf, type BlueprintProvenanceFields } from '../utils/blueprintProvenance';
import type { CreationTransaction } from '../db/creationTransaction';
// PhaseService.ts — the Phase object (RH-P2.4, task 8be358d2).
//
// A Phase is the grouping object between Project and Task (strategy §2.3 as
// amended by vocabulary A3/D-6; design report 32346910). It is ordered
// within its Project, MAY OVERLAP with other Phases, and carries a goal —
// an outcome PROPERTY, never a table (D-6). A Task's Phase is optional:
// unphased Tasks are the project backlog, which is a normal state and not
// an error.
//
// LIFECYCLE is exactly the Phase subset of the work-object vocabulary
// (§4.1): todo · in-progress · completed · archived. `archive` is the
// routine reversible verb (§4.4); `delete` is the restricted admin-only
// path and the database refuses it while Tasks still point at the Phase.
//
// NOTHING HERE ENFORCES AUTHORIZATION BEYOND CONCEALMENT. Phases are
// grantable resources whose visibility derives from their Project, with
// additive explicit grants. The exceptional restricted-access flag is changed
// only through the attributed owner-plane method below; adding a grant never
// changes inheritance policy (owner ruling 44ee41f2).
import { pool } from '../db/connection';
import { v4 as uuidv4 } from 'uuid';
import { feedEventService } from './FeedEventService';
import { lifecyclePolicyService } from './LifecyclePolicyService';

export const PHASE_STATUSES = ['todo', 'in-progress', 'completed', 'archived'] as const;
export type PhaseStatus = (typeof PHASE_STATUSES)[number];

/** Statuses a caller may set directly. `archived` is reached only through
 *  the archive verb, so archiving is never an incidental side effect of a
 *  content update (§4.4 keeps the deactivation verbs distinct on purpose). */
export const PHASE_SETTABLE_STATUSES: PhaseStatus[] = ['todo', 'in-progress', 'completed'];

export const PHASE_NAME_MAX_LENGTH = 200;
export const PHASE_GOAL_MAX_LENGTH = 8192;
export const PHASE_POSITION_MAX = 100000;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface Phase extends BlueprintProvenanceFields {
  id: string;
  projectId: string;
  name: string;
  goal: string | null;
  status: PhaseStatus;
  position: number;
  restrictedAccess: boolean;
  revision: string;
  createdAt: string;
  updatedAt: string;
}

/**
 * A Phase or Goal LOOKUP FAILURE is not confirmed absence — the same rule the
 * Charter compile path was rejected for missing (review 6fa91e28 F1), and the
 * one review 1a786ae4 F2 caught this candidate breaking for goals.
 *
 * A Task with a NULL phase_id genuinely has no Phase, and a Brief compiled for
 * it is complete. A Task BOUND to a Phase whose lookup failed is a Brief that
 * would silently omit context the ratified design requires (e20a12d6 §4, E-12:
 * the Brief shows the Project and Phase goal). The compile surfaces map this
 * to a fixed 503 rather than returning a plausible, incomplete Brief.
 *
 * It deliberately carries NO adapter detail: the caught value can hold
 * credentials or private topology, and the safety floor covers logs as well as
 * responses (review b45fb44e F1).
 */
export class PhaseLookupError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PhaseLookupError';
  }
}

export class PhaseError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly field?: string,
  ) {
    super(message);
    this.name = 'PhaseError';
  }
}

const err = (status: number, code: string, message: string, field?: string) =>
  new PhaseError(status, code, message, field);

interface Queryable {
  query: (text: string, params?: unknown[]) => Promise<{ rows: any[]; rowCount?: number | null }>;
}

function mapRow(row: any): Phase {
  return {
      ...blueprintProvenanceOf(row),
    id: row.id,
    projectId: row.project_id,
    name: row.name,
    goal: row.goal ?? null,
    status: row.status,
    position: row.position,
    restrictedAccess: Boolean(row.restricted_access),
    revision: row.revision,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * Postgres raises 23503 for the composite FK (a Phase from another Project,
 * or a Phase that does not exist) and 23514 for the check constraint. The
 * task write paths translate both into typed 4xx rather than letting a
 * constraint name reach a 500 body.
 */
export function isPhaseBindingViolation(e: unknown): boolean {
  const code = (e as { code?: string } | null)?.code;
  const constraint = (e as { constraint?: string } | null)?.constraint;
  return (
    (code === '23503' && constraint === 'tasks_phase_project_fk') ||
    (code === '23514' && constraint === 'tasks_phase_requires_project')
  );
}

function requireUuid(value: unknown, field: string, message: string): string {
  if (typeof value !== 'string' || !UUID_PATTERN.test(value)) {
    throw err(422, 'INVALID_PHASE_VALUE', message, field);
  }
  return value;
}

function validateName(value: unknown): string {
  if (typeof value !== 'string') {
    throw err(422, 'INVALID_PHASE_VALUE', 'name must be a string', 'name');
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    throw err(422, 'INVALID_PHASE_VALUE', 'name must not be empty', 'name');
  }
  if (trimmed.length > PHASE_NAME_MAX_LENGTH) {
    throw err(422, 'INVALID_PHASE_VALUE', `name must be at most ${PHASE_NAME_MAX_LENGTH} characters`, 'name');
  }
  return trimmed;
}

function validateGoal(value: unknown): string | null {
  if (value === null) return null;
  if (typeof value !== 'string') {
    throw err(422, 'INVALID_PHASE_VALUE', 'goal must be a string or null', 'goal');
  }
  if (value.length > PHASE_GOAL_MAX_LENGTH) {
    throw err(422, 'INVALID_PHASE_VALUE', `goal must be at most ${PHASE_GOAL_MAX_LENGTH} characters`, 'goal');
  }
  return value.length === 0 ? null : value;
}

function validateSettableStatus(value: unknown): PhaseStatus {
  if (typeof value !== 'string' || !(PHASE_SETTABLE_STATUSES as string[]).includes(value)) {
    throw err(
      422,
      'INVALID_PHASE_VALUE',
      `status must be one of: ${PHASE_SETTABLE_STATUSES.join(', ')} (archive and unarchive are their own operations)`,
      'status',
    );
  }
  return value as PhaseStatus;
}

function validatePosition(value: unknown): number {
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    throw err(422, 'INVALID_PHASE_VALUE', 'position must be an integer', 'position');
  }
  if (value < 0 || value > PHASE_POSITION_MAX) {
    throw err(422, 'INVALID_PHASE_VALUE', `position must be between 0 and ${PHASE_POSITION_MAX}`, 'position');
  }
  return value;
}

/**
 * Concealment before validation, and BEFORE any private field is read: an
 * absent Project must 404 identically whatever the body carries, or body
 * validity leaks Project existence (the CharterService pattern).
 */
async function lockProject(executor: Queryable, projectId: string, requireActive: boolean): Promise<void> {
  const result = await executor.query('SELECT id, status FROM projects WHERE id = $1 FOR UPDATE', [projectId]);
  if (result.rows.length === 0) {
    throw err(404, 'PROJECT_NOT_FOUND', 'Project not found');
  }
  if (requireActive && result.rows[0].status === 'archived') {
    throw err(409, 'PROJECT_ARCHIVED', 'Project is archived and read-only; restore it first');
  }
}

export interface CreatePhaseInput {
  projectId?: unknown;
  name?: unknown;
  goal?: unknown;
  status?: unknown;
  position?: unknown;
}

export interface UpdatePhaseInput {
  revision?: unknown;
  name?: unknown;
  goal?: unknown;
  status?: unknown;
  position?: unknown;
}

export interface SetPhaseAccessInput {
  revision?: unknown;
  restricted?: unknown;
  reason?: unknown;
  actorPrincipalId?: unknown;
}

export interface ListPhaseFilters {
  projectId?: string;
  status?: string;
  includeArchived?: boolean;
}

export class PhaseService {
  /**
   * List Phases. Archived Phases are excluded by default (§4.4: "excluded
   * from default lists; still readable, linkable"). Order is
   * (position, created_at, id): position orders, it does not exclude —
   * Phases may overlap, so ties are legal and resolved deterministically.
   */
  async list(filters: ListPhaseFilters = {}): Promise<Phase[]> {
    const clauses: string[] = [];
    const params: unknown[] = [];
    if (filters.projectId !== undefined) {
      if (!UUID_PATTERN.test(filters.projectId)) {
        throw err(400, 'INVALID_QUERY_VALUE', 'projectId must be a full UUID', 'projectId');
      }
      params.push(filters.projectId);
      clauses.push(`project_id = $${params.length}`);
    }
    if (filters.status !== undefined) {
      if (!(PHASE_STATUSES as readonly string[]).includes(filters.status)) {
        throw err(400, 'INVALID_QUERY_VALUE', `status must be one of: ${PHASE_STATUSES.join(', ')}`, 'status');
      }
      params.push(filters.status);
      clauses.push(`status = $${params.length}`);
      // An explicit status filter is the caller asking for exactly that
      // status, including 'archived'; the default exclusion below would
      // otherwise make `?status=archived` always return nothing.
    } else if (!filters.includeArchived) {
      clauses.push(`status <> 'archived'`);
    }
    const where = clauses.length > 0 ? ` WHERE ${clauses.join(' AND ')}` : '';
    const result = await pool.query(
      `SELECT * FROM phases${where} ORDER BY position ASC, created_at ASC, id ASC`,
      params,
    );
    return result.rows.map(mapRow);
  }

  /** Read one Phase, or throw the concealed 404. */
  async get(id: string): Promise<Phase> {
    if (!UUID_PATTERN.test(id)) {
      throw err(404, 'PHASE_NOT_FOUND', 'Phase not found');
    }
    const result = await pool.query('SELECT * FROM phases WHERE id = $1', [id]);
    if (result.rows.length === 0) {
      throw err(404, 'PHASE_NOT_FOUND', 'Phase not found');
    }
    return mapRow(result.rows[0]);
  }

  /** Create a Phase under an ACTIVE Project. */
  async create(input: CreatePhaseInput, transaction?: CreationTransaction): Promise<Phase> {
    const projectId = requireUuid(input.projectId, 'projectId', 'projectId must be a project UUID');
    const client = transaction?.client ?? await pool.connect();
    try {
      if (!transaction) await client.query('BEGIN');
      // Existence and archived-state first: an unreadable Project must not
      // be distinguishable by how the body validates.
      await lockProject(client, projectId, true);
      const name = validateName(input.name);
      const goal = input.goal === undefined ? null : validateGoal(input.goal);
      const status = input.status === undefined ? 'todo' : validateSettableStatus(input.status);
      const position = input.position === undefined ? 0 : validatePosition(input.position);
      const phaseId = uuidv4();
      await lifecyclePolicyService.evaluate(client, {
        action: 'phase.create',
        subject: { kind: 'phase', id: phaseId },
        proposed: { projectId, status, restrictedAccess: false },
      });
      const result = await client.query(
        `INSERT INTO phases (id, project_id, name, goal, status, position)
         VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
        [phaseId, projectId, name, goal, status, position],
      );
      // RH-P3.C1: same-transaction feed emission.
      await feedEventService.emit(client, {
        name: 'phase.created',
        actorPrincipalId: transaction?.actor.principalId ?? null,
        actorHandle: transaction?.actor.handle ?? null,
        objectType: 'phase',
        objectId: phaseId,
        projectId,
        payload: { status },
      });
      if (!transaction) await client.query('COMMIT');
      return mapRow(result.rows[0]);
    } catch (e) {
      if (!transaction) await client.query('ROLLBACK');
      throw e;
    } finally {
      if (!transaction) client.release();
    }
  }

  /**
   * Update content fields under the If-Match revision guard. An archived
   * Phase is read-only (§4.4) — restore it first. `status` here may only be
   * one of the settable states; archiving has its own verb.
   */
  async update(id: string, input: UpdatePhaseInput): Promise<Phase> {
    const revision = requireUuid(input.revision, 'revision', 'revision is required and must be the current revision UUID');
    const fields: string[] = [];
    const params: unknown[] = [];
    const push = (column: string, value: unknown) => {
      params.push(value);
      fields.push(`${column} = $${params.length}`);
    };

    return this.withPhaseLock(id, revision, { requireActivePhase: true }, async (client, current) => {
      if (input.name !== undefined) push('name', validateName(input.name));
      if (input.goal !== undefined) push('goal', validateGoal(input.goal));
      if (input.status !== undefined) push('status', validateSettableStatus(input.status));
      if (input.position !== undefined) push('position', validatePosition(input.position));
      if (fields.length === 0) {
        throw err(422, 'INVALID_PHASE_VALUE', 'no updatable field was supplied');
      }
      await lifecyclePolicyService.evaluate(client, {
        action: 'phase.update',
        subject: { kind: 'phase', id, revision },
        current: { status: current.status, position: current.position },
        proposed: {
          status: input.status ?? current.status,
          position: input.position ?? current.position,
        },
      });
      params.push(id);
      const result = await client.query(
        `UPDATE phases SET ${fields.join(', ')}, revision = gen_random_uuid(), updated_at = NOW()
         WHERE id = $${params.length} RETURNING *`,
        params,
      );
      return mapRow(result.rows[0]);
    });
  }

  /**
   * Change the exceptional confidentiality mode and append its audit record
   * atomically. Ordinary content edits and grant creation cannot reach this
   * method, so neither can silently change inheritance semantics.
   */
  async setRestrictedAccess(id: string, input: SetPhaseAccessInput): Promise<Phase> {
    const revision = requireUuid(input.revision, 'revision', 'revision is required and must be the current revision UUID');
    const actorPrincipalId = requireUuid(
      input.actorPrincipalId, 'actorPrincipalId', 'a resolved Principal is required for access-policy changes',
    );
    if (typeof input.restricted !== 'boolean') {
      throw err(422, 'INVALID_PHASE_ACCESS', 'restricted must be a boolean', 'restricted');
    }
    if (typeof input.reason !== 'string' || input.reason.trim().length < 3 || input.reason.trim().length > 1000) {
      throw err(422, 'INVALID_PHASE_ACCESS', 'reason must be 3..1000 characters', 'reason');
    }
    const reason = input.reason.trim();
    return this.withPhaseLock(id, revision, { requireActivePhase: true }, async (client, current) => {
      if (current.restrictedAccess === input.restricted) {
        throw err(409, 'PHASE_ACCESS_UNCHANGED', 'Phase access policy already has the requested value');
      }
      await client.query(`SELECT set_config('relayhall.phase_access_actor', $1, TRUE)`, [actorPrincipalId]);
      await client.query(`SELECT set_config('relayhall.phase_access_reason', $1, TRUE)`, [reason]);
      const result = await client.query(
        `UPDATE phases SET restricted_access = $2, revision = gen_random_uuid(), updated_at = NOW()
         WHERE id = $1 RETURNING *`, [id, input.restricted],
      );
      // RH-P3.C1 (round 1, F5): flipping restricted access IS the ACL change
      // the contract names; announce it content-free, alongside the
      // phase.updated the lock helper emits for every guarded mutation.
      await feedEventService.emit(client, {
        name: 'phase.acl_changed',
        objectType: 'phase',
        objectId: id,
        projectId: current.projectId ?? null,
        payload: {},
      });
      return mapRow(result.rows[0]);
    });
  }

  /** Archive — reversible, and the routine way a Phase leaves the board. */
  async archive(id: string, revision: unknown): Promise<Phase> {
    const rev = requireUuid(revision, 'revision', 'revision is required and must be the current revision UUID');
    return this.withPhaseLock(id, rev, { requireActivePhase: false }, async (client, current) => {
      if (current.status === 'archived') {
        throw err(409, 'PHASE_ALREADY_ARCHIVED', 'Phase is already archived');
      }
      await lifecyclePolicyService.evaluate(client, {
        action: 'phase.archive',
        subject: { kind: 'phase', id, revision: current.revision },
        current: { status: current.status },
        proposed: { status: 'archived' },
      });
      const result = await client.query(
        `UPDATE phases SET status = 'archived', revision = gen_random_uuid(), updated_at = NOW()
         WHERE id = $1 RETURNING *`,
        [id],
      );
      return mapRow(result.rows[0]);
    });
  }

  /** Unarchive back to `todo` — the reversal §4.4 promises. */
  async unarchive(id: string, revision: unknown): Promise<Phase> {
    const rev = requireUuid(revision, 'revision', 'revision is required and must be the current revision UUID');
    return this.withPhaseLock(id, rev, { requireActivePhase: false }, async (client, current) => {
      if (current.status !== 'archived') {
        throw err(409, 'PHASE_NOT_ARCHIVED', 'Phase is not archived');
      }
      await lifecyclePolicyService.evaluate(client, {
        action: 'phase.restore',
        subject: { kind: 'phase', id, revision: current.revision },
        current: { status: current.status },
        proposed: { status: 'todo' },
      });
      const result = await client.query(
        `UPDATE phases SET status = 'todo', revision = gen_random_uuid(), updated_at = NOW()
         WHERE id = $1 RETURNING *`,
        [id],
      );
      return mapRow(result.rows[0]);
    });
  }

  /**
   * Hard delete — the `admin` verb, never the routine path (§4.4). The
   * database refuses it while Tasks reference the Phase (ON DELETE
   * RESTRICT); the count is read inside the same transaction so the typed
   * 409 can say how many, rather than surfacing a constraint name.
   */
  async remove(id: string): Promise<Phase> {
    if (!UUID_PATTERN.test(id)) {
      throw err(404, 'PHASE_NOT_FOUND', 'Phase not found');
    }
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const current = await client.query('SELECT * FROM phases WHERE id = $1 FOR UPDATE', [id]);
      if (current.rows.length === 0) {
        throw err(404, 'PHASE_NOT_FOUND', 'Phase not found');
      }
      const inUse = await client.query('SELECT COUNT(*)::int AS n FROM tasks WHERE phase_id = $1', [id]);
      if (inUse.rows[0].n > 0) {
        throw err(
          409,
          'PHASE_IN_USE',
          `Phase still holds ${inUse.rows[0].n} task(s); move or unphase them first, or archive the Phase instead`,
        );
      }
      await lifecyclePolicyService.evaluate(client, {
        action: 'phase.delete',
        subject: { kind: 'phase', id, revision: current.rows[0].revision },
        current: { status: current.rows[0].status },
        proposed: null,
      });
      const result = await client.query('DELETE FROM phases WHERE id = $1 RETURNING *', [id]);
      // RH-P3.C1: the content-free deletion tombstone rides the deleting
      // transaction; the event row keeps project_id so delivery can still be
      // authorized after the Phase is gone.
      await feedEventService.emit(client, {
        name: 'phase.deleted',
        objectType: 'phase',
        objectId: id,
        projectId: result.rows[0].project_id ?? null,
        payload: {},
      });
      await client.query('COMMIT');
      return mapRow(result.rows[0]);
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
  }

  /** The Phase's member Tasks, for the Brief and the GUI. Bounded columns
   *  by design: a Phase-altitude briefing is a human-reading artifact and
   *  the machine path stays the per-task Brief (§2.3 Brief output discipline),
   *  so descriptions are never carried here. */
  async members(id: string): Promise<Array<{ id: string; title: string; status: string }>> {
    const result = await pool.query(
      `SELECT id, title, status FROM tasks
       WHERE phase_id = $1
       ORDER BY created_at ASC, id ASC`,
      [id],
    );
    return result.rows.map((row) => ({ id: row.id, title: row.title, status: row.status }));
  }

  /** The bounded Project fields a phase Brief renders (id, name, goal).
   *  Read through the Phase's own project_id, never through a caller-supplied
   *  one, so the two can never disagree. */
  async projectSummary(projectId: string): Promise<{ id: string; name: string; goal: string | null }> {
    const result = await pool.query('SELECT id, name, goal FROM projects WHERE id = $1', [projectId]);
    if (result.rows.length === 0) {
      // A Phase cannot outlive its Project (ON DELETE CASCADE), so this is
      // unreachable in practice; concealing it keeps the invariant explicit
      // rather than surfacing an empty render.
      throw err(404, 'PHASE_NOT_FOUND', 'Phase not found');
    }
    const row = result.rows[0];
    return { id: row.id, name: row.name, goal: row.goal ?? null };
  }

  /**
   * Shared revision-guarded mutation frame: lock the row, prove the
   * revision, optionally refuse archived, then run the caller's statement.
   * Absence and a bad id are the same concealed 404, and a stale revision
   * is REVISION_MISMATCH — the 067 discipline, verbatim.
   */
  private async withPhaseLock<T>(
    id: string,
    revision: string,
    opts: { requireActivePhase: boolean },
    run: (client: Queryable, current: Phase) => Promise<T>,
  ): Promise<T> {
    if (!UUID_PATTERN.test(id)) {
      throw err(404, 'PHASE_NOT_FOUND', 'Phase not found');
    }
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const found = await client.query('SELECT * FROM phases WHERE id = $1 FOR UPDATE', [id]);
      if (found.rows.length === 0) {
        throw err(404, 'PHASE_NOT_FOUND', 'Phase not found');
      }
      const current = mapRow(found.rows[0]);
      if (current.revision !== revision) {
        throw err(409, 'REVISION_MISMATCH', 'The Phase changed since you read it; re-read and retry');
      }
      if (opts.requireActivePhase && current.status === 'archived') {
        throw err(409, 'PHASE_ARCHIVED', 'Phase is archived and read-only; unarchive it first');
      }
      const result = await run(client, current);
      // RH-P3.C1: every revision-guarded Phase mutation (update, archive,
      // restore) announces itself as phase.updated in the same transaction.
      await feedEventService.emit(client, {
        name: 'phase.updated',
        objectType: 'phase',
        objectId: id,
        projectId: current.projectId ?? null,
        payload: {},
      });
      await client.query('COMMIT');
      return result;
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
  }
}

export const phaseService = new PhaseService();
