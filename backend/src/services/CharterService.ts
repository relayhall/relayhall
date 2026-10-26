// CharterService.ts — the Charter as a first-class object (task f2735f1b).
//
// A Charter is a Project's authority index (vocabulary amendment A9): it
// locates every governing agreement with status and precedence and asserts
// nothing new — conflicts always resolve to the underlying document. One
// Charter per Project; root-only direct PUT and a named human Project
// approval action; versioned so every content state is
// attributable and restorable. Charter content is authored governance text,
// but the compiler still renders it under an explicit heading rather than
// interpolating it into instructions it did not write.
import { pool } from '../db/connection';
import crypto from 'crypto';
import { authorizationService, type AuthorizationActor } from './AuthorizationService';
import { authorizationRepository } from './AuthorizationRepository';
import { scopesForRole } from '../utils/identityScopes';
import { isLoginSessionKind } from '../utils/administratorSession';
import { auditService, type AuditActor } from './AuditService';
import { stepUpService, StepUpError, type StepUpChallenge } from './StepUpService';
import { assertDecisionEvidence, DecisionEvidenceError, type DecisionEvidence } from '../utils/decisionEvidence';
import { liveStewardRows } from '../utils/liveStewardCondition';
import { logCaughtFailure } from '../utils/secretSafeLog';

export interface CharterApprovalActor {
  authorization: AuthorizationActor;
  authMethod?: string;
  audit: AuditActor;
  /**
   * LENSES-c gate (i) (c1-B, card b5c83682; design delta C.5): the body's
   * `stepUpToken`, read ONLY by the Group-owner arm, which runs only after the
   * administrator test has refused. The person-owner and administrator arms
   * never read it.
   */
  stepUpToken?: string;
  /**
   * Change-request design section 5.3 (T2 S5, card 9ce0b0b0): an approved
   * `charter.revision` applies this act inside its decide transaction, whose
   * ONE step-up was consumed for (`approval.decide`, approval id). The
   * Group-owner arm reads that consumed token in place of consuming a second
   * one, only when `assertDecisionEvidence` holds it on this transaction for
   * this decider; anything else is STEP_UP_REQUIRED. Set only by the decide
   * transaction, never from a request body.
   */
  decisionEvidence?: DecisionEvidence | null;
}

/** The step-up act gate (i) consumes, with the Project id (§7.6). */
export const CHARTER_APPROVE_ACT = 'charter.approve';

/** What the Group-owner arm adds to the approval's audit row (C.5). */
export interface CharterGroupOwnerEvidence {
  projectId: string;
  owningGroupId: string;
  standing: 'group-owner';
  stepUpTokenId: string;
}

/**
 * GATE (i), the Group-owner arm (LENSES-c C.5; E57 (i); c1-B, card b5c83682).
 * Reached ONLY after `requireCharterApprover`'s administrator test has refused,
 * so it never routes through the admin verb. It applies when the Project's
 * owner is an ACTIVE Group principal G (a disabled Group suspends every
 * ownership tier, AZ-A12 clause 2) and the acting Account holds a LIVE
 * owner-role row on G, read through the shared fragment with its row locks,
 * inside the write transaction that already holds the Project lock. Then, and
 * only then, a step-up bound to ('charter.approve', the Project id) is
 * consumed on the transaction client. Where the arm does not apply - a
 * manager, an inert owner, a non-member, a disabled Group, a person-owned
 * Project - the refusal is today's CHARTER_APPROVAL_FORBIDDEN. On a
 * Group-owned Project (a disabled Group included) its denied charter.approve
 * row names the arm's refusal: {refusal, projectId, owningGroupId, standing:
 * 'group-owner'} (C.5), the fields the step-up refusal carries too. On any
 * other Project the arm never applied, and the row is today's.
 */
async function charterGroupOwnerArm(
  executor: Queryable, projectId: string, actorId: string, stepUpToken: string | undefined,
  forbidden: () => CharterError, decisionEvidence: DecisionEvidence | null = null,
): Promise<CharterGroupOwnerEvidence> {
  const owners = await executor.query(
    `SELECT p.id::text AS project_id, owner.id::text AS id, owner.kind, owner.status
       FROM projects p JOIN principals owner ON owner.id = p.owner_principal_id
      WHERE p.id = $1`,
    [projectId],
  );
  const owner = owners.rows[0];
  // Today's code and message; on a Group-owned Project, with the arm's audit fields.
  const refuse = (): CharterError => {
    const base = forbidden();
    if (owner?.kind !== 'group') return base;
    return new CharterError(base.status, base.code, base.message, base.field, null, {
      refusal: base.code, projectId: String(owner.project_id), owningGroupId: String(owner.id), standing: 'group-owner',
    });
  };
  if (!owner || owner.kind !== 'group' || owner.status !== 'active') throw refuse();
  const live = await executor.query(
    liveStewardRows({ group: '$1', account: '$2', roles: "ARRAY['owner']::text[]", lock: true }),
    [owner.id, actorId],
  );
  if (live.rows.length === 0) throw refuse();
  // The canonical (lowercase) id as the Project row spells it: the step-up names it.
  const canonicalProjectId = String(owner.project_id);
  if (decisionEvidence) {
    // Section 5.3: the decision's own consumed step-up, for this decider, on this transaction.
    try {
      if (String(decisionEvidence.deciderPrincipalId).toLowerCase() !== String(actorId).toLowerCase()) {
        throw new DecisionEvidenceError('the evidence names another decider');
      }
      await assertDecisionEvidence(executor, decisionEvidence);
    } catch (e) {
      if (e instanceof DecisionEvidenceError) {
        throw new CharterError(e.status, e.code, e.message, undefined, null,
          { refusal: e.code, projectId: canonicalProjectId, owningGroupId: String(owner.id), standing: 'group-owner' });
      }
      throw e;
    }
    return {
      projectId: canonicalProjectId, owningGroupId: String(owner.id), standing: 'group-owner', stepUpTokenId: decisionEvidence.tokenId,
    };
  }
  try {
    const evidence = await stepUpService.consume(executor, {
      token: stepUpToken ?? '',
      principalId: actorId,
      action: CHARTER_APPROVE_ACT,
      targetId: canonicalProjectId,
    });
    return {
      projectId: canonicalProjectId, owningGroupId: String(owner.id), standing: 'group-owner', stepUpTokenId: evidence.tokenId,
    };
  } catch (e) {
    if (e instanceof StepUpError) {
      throw new CharterError(e.status, e.code, e.message, undefined, e.challenge,
        { refusal: e.code, projectId: canonicalProjectId, owningGroupId: String(owner.id), standing: 'group-owner' });
    }
    throw e;
  }
}

/** A named human approval act; neither a write Grant nor a Connector token
 * substitutes for the current project owner or project administrator.
 * Answers the Group-owner arm's evidence when gate (i) admitted the act, and
 * null for the person-owner and administrator arms (unchanged). */
async function requireCharterApprover(
  executor: Queryable, projectId: string, input: CharterApprovalActor,
): Promise<CharterGroupOwnerEvidence | null> {
  const actor = input?.authorization;
  const refuse = () => err(403, 'CHARTER_APPROVAL_FORBIDDEN',
    'Charter approval requires the project owner or an authorized project administrator signed in as a human Account');
  if (!actor?.authenticated || !actor.principalId || !isLoginSessionKind(input.authMethod)) throw refuse();
  const principals = await executor.query(
    'SELECT id, handle, kind, status, role, parent_principal_id FROM principals WHERE id = $1 FOR SHARE',
    [actor.principalId],
  );
  const current = principals.rows[0];
  if (!current || current.kind !== 'human' || current.status !== 'active' || current.parent_principal_id
    || (actor.delegation?.links?.length ?? 0) > 1) throw refuse();
  const fresh: AuthorizationActor = {
    principalId: current.id, handle: current.handle, role: current.role,
    scopes: scopesForRole(current.role), authenticated: true,
  };
  // Both the authenticated session ceiling and current Account ceiling must
  // hold. A stale session can never retain a demoted Account's authority.
  for (const candidate of [actor, fresh]) {
    if (!authorizationService.authorizeRoute(candidate, 'projects:write').allowed
      || !(await authorizationRepository.authorizedIds(candidate, 'project', [projectId], 'write', executor)).has(projectId)) {
      throw refuse();
    }
  }
  const owners = await executor.query('SELECT owner_principal_id FROM projects WHERE id = $1', [projectId]);
  if (owners.rows[0]?.owner_principal_id === actor.principalId) return null;
  // The administrator test, first and unchanged: if it admits, the approval
  // proceeds with no step-up. Only if it refuses does gate (i) run (C.5).
  let administrator = true;
  for (const candidate of [actor, fresh]) {
    if (!(await authorizationRepository.authorizedIds(candidate, 'project', [projectId], 'admin', executor)).has(projectId)) {
      administrator = false;
      break;
    }
  }
  if (administrator) return null;
  return await charterGroupOwnerArm(executor, projectId, String(current.id), input.stepUpToken, refuse, input.decisionEvidence ?? null);
}


export const CHARTER_CONTENT_MAX_LENGTH = 131072;

export interface Charter {
  id: string;
  projectId: string;
  content: string;
  contentHash: string;
  version: number;
  revision: string;
  updatedByPrincipalId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CharterVersionMeta {
  version: number;
  contentHash: string;
  actorPrincipalId: string | null;
  createdAt: string;
}

export interface CharterVersion extends CharterVersionMeta {
  content: string;
}

/**
 * A Charter LOOKUP FAILURE is not confirmed absence (review 6fa91e28 F1):
 * when the compiler cannot establish whether a project has a Charter, the
 * Brief must fail closed rather than compile without the authority index.
 * This error is thrown by the compile paths for exactly that case, and the
 * compile surfaces map it to a non-2xx response.
 */
export class CharterLookupError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CharterLookupError';
  }
}

export class CharterError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly field?: string,
    /** The SU-14 challenge, on gate (i)'s STEP_UP_REQUIRED only (c1-B). */
    public readonly challenge: StepUpChallenge | null = null,
    /** What gate (i)'s refusal adds to its denied audit row (c1-B, C.5): the
     * refusal and the Group-owner standing. Absent for every other refusal. */
    public readonly auditMetadata: Record<string, unknown> | null = null,
  ) {
    super(message);
    this.name = 'CharterError';
  }
}

const err = (status: number, code: string, message: string, field?: string) =>
  new CharterError(status, code, message, field);

interface Queryable {
  query: (text: string, params?: unknown[]) => Promise<{ rows: any[] }>;
}

function sha256Hex(content: string): string {
  return crypto.createHash('sha256').update(content, 'utf8').digest('hex');
}

function mapRow(row: any): Charter {
  return {
    id: row.id,
    projectId: row.project_id,
    content: row.content,
    contentHash: row.content_hash,
    version: row.version,
    revision: row.revision,
    updatedByPrincipalId: row.updated_by_principal_id ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapVersionMeta(row: any): CharterVersionMeta {
  return {
    version: row.version,
    contentHash: row.content_hash,
    actorPrincipalId: row.actor_principal_id ?? null,
    createdAt: row.created_at,
  };
}

// Concealment before validation: an absent project must 404 identically
// whatever the body carries, or body validity leaks project existence.
async function lockProject(
  executor: Queryable,
  projectId: string,
  requireActive: boolean,
): Promise<void> {
  const result = await executor.query(
    'SELECT id, status FROM projects WHERE id = $1 FOR UPDATE',
    [projectId],
  );
  if (result.rows.length === 0) {
    throw err(404, 'PROJECT_NOT_FOUND', 'Project not found');
  }
  if (requireActive && result.rows[0].status === 'archived') {
    throw err(409, 'PROJECT_ARCHIVED', 'Project is archived and read-only; restore it first');
  }
}

async function requireProject(projectId: string): Promise<void> {
  const result = await pool.query('SELECT id FROM projects WHERE id = $1', [projectId]);
  if (result.rows.length === 0) {
    throw err(404, 'PROJECT_NOT_FOUND', 'Project not found');
  }
}

/** Exported for the change-request filing of charter.revision (T2 S5), which refuses content at filing as this write would. */
export function validateContent(content: unknown): string {
  if (typeof content !== 'string' || content.trim().length === 0) {
    throw err(422, 'INVALID_CHARTER_VALUE', 'Charter content must be a non-empty string', 'content');
  }
  if (content.length > CHARTER_CONTENT_MAX_LENGTH) {
    throw err(
      400,
      'VALUE_TOO_LONG',
      `Charter content exceeds ${CHARTER_CONTENT_MAX_LENGTH} characters — a Charter is an index, not a copy`,
      'content',
    );
  }
  return content;
}

export class CharterService {
  /** One audit writer for the approval act, with no Charter text or request
   * payload. A success uses the approval's transaction; a refusal changes no
   * Charter state and uses a separate append after any rollback. */
  private async recordApprovalAudit(
    projectId: string | null, actor: AuditActor, outcome: 'success' | 'denied',
    charterVersion: number | null, sha: string | null, previousVersion: number | null,
    executor: Queryable = pool,
    groupOwner: Record<string, unknown> | null = null,
  ): Promise<void> {
    if (!actor) throw new Error('Charter approval audit attribution is required');
    await auditService.record({ action: 'charter.approve', actor, outcome,
      resourceType: 'project', resourceId: projectId,
      // LENSES-c gate (i) (C.5): the Group-owner arm's fields join the row
      // for that arm only; the person-owner and administrator rows are unchanged.
      metadata: { charterVersion, sha, previousVersion, ...(groupOwner ?? {}) },
    }, executor);
  }

  async recordRefusedApproval(
    projectId: string | null, actor?: AuditActor, executor: Queryable = pool,
    groupOwner: Record<string, unknown> | null = null,
  ): Promise<void> {
    if (!actor || !actor.principalId && (!actor.handle || actor.handle === 'unknown')) return;
    // Preserve the existing refusal when the ledger is unavailable. The
    // failure is redacted and visible, never silently treated as a receipt.
    await this.recordApprovalAudit(projectId, actor, 'denied', null, null, null, executor, groupOwner)
      .catch(error => logCaughtFailure('[Charter] refusal audit unavailable:', error));
  }

  /** Read the head Charter for a project. Reads serve archived projects too. */
  async get(projectId: string): Promise<Charter> {
    await requireProject(projectId);
    const result = await pool.query(
      'SELECT * FROM project_charters WHERE project_id = $1',
      [projectId],
    );
    if (result.rows.length === 0) {
      throw err(404, 'CHARTER_NOT_FOUND', 'This project has no Charter yet');
    }
    return mapRow(result.rows[0]);
  }

  /** Head Charter or null, for callers that treat absence as ordinary (the Brief compiler). */
  async find(projectId: string): Promise<Charter | null> {
    const result = await pool.query(
      'SELECT * FROM project_charters WHERE project_id = $1',
      [projectId],
    );
    return result.rows.length === 0 ? null : mapRow(result.rows[0]);
  }

  /**
   * Create or replace the head content (the single write surface).
   * Create: no revision expected. Replace: revision-bound via If-Match.
   * Identical content is a no-op that bumps nothing. Every content change
   * appends a project_charter_versions row for attribution/restore.
   */
  async put(
    projectId: string,
    content: unknown,
    revision: string | undefined,
    actorPrincipalId: string | null,
  ): Promise<{ charter: Charter; created: boolean; changed: boolean }> {
    return this.write(projectId, content, revision, actorPrincipalId, { kind: 'root' });
  }

  /**
   * THE APPROVAL ACT ON A CHANGE-REQUEST DECISION (change-request design
   * section 3 `charter.revision`, AZ-A11's charter-revision folded; T2 S5,
   * card 9ce0b0b0): the content write and its approval are ONE act, applied
   * inside the decide transaction with the DECIDER as the approver through
   * the very gate the direct approval route runs (`requireCharterApprover`:
   * a human login session, projects:write and object write, the person
   * owner, else an object administrator, else LENSES-c gate (i) with the
   * decision's step-up as its evidence). The revision is read under the lock
   * (the decision's stale check held the head equal to the filed one).
   * `ledger` rides the act's own charter.approve row.
   */
  async approveWithin(
    client: Queryable, projectId: string, content: unknown, actor: CharterApprovalActor, ledger: Record<string, unknown>,
  ): Promise<{ charter: Charter; created: boolean; changed: boolean }> {
    const head = await client.query('SELECT revision FROM project_charters WHERE project_id = $1', [projectId]);
    const revision = head.rows[0] ? String(head.rows[0].revision) : undefined;
    return this.writeWithin(client, projectId, content, revision, actor?.authorization?.principalId ?? null,
      { kind: 'approval', actor }, ledger);
  }

  /** Separate from root-only PUT: a human approves a proposal as Project owner. */
  async approve(
    projectId: string, content: unknown, revision: string | undefined, actor: CharterApprovalActor,
  ): Promise<{ charter: Charter; created: boolean; changed: boolean }> {
    return this.write(projectId, content, revision, actor?.authorization?.principalId ?? null, { kind: 'approval', actor });
  }

  private async write(
    projectId: string, content: unknown, revision: string | undefined,
    actorPrincipalId: string | null, mode: { kind: 'root' } | { kind: 'approval'; actor: CharterApprovalActor },
  ): Promise<{ charter: Charter; created: boolean; changed: boolean }> {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const written = await this.writeWithin(client, projectId, content, revision, actorPrincipalId, mode, null);
      await client.query('COMMIT');
      return written;
    } catch (e) {
      await client.query('ROLLBACK');
      if (mode.kind === 'approval' && e instanceof CharterError) {
        // Reuse the rolled-back connection: taking a second pool slot while
        // every refused request holds its first would deadlock a full pool.
        // A refusal AFTER the Group-owner arm admitted (the content, the
        // If-Match revision) is still that arm's denied row (C.5): it names
        // the refusal and the standing; the rollback returned the step-up.
        await this.recordRefusedApproval(projectId, mode.actor?.audit, client, e.auditMetadata);
      }
      throw e;
    } finally {
      client.release();
    }
  }

  /**
   * The head write on the CALLER's transaction (its caller commits or rolls
   * back). A refusal raised after the Group-owner arm admitted carries that
   * arm's audit fields, so the caller's denied row names them (C.5).
   */
  private async writeWithin(
    client: Queryable, projectId: string, content: unknown, revision: string | undefined,
    actorPrincipalId: string | null, mode: { kind: 'root' } | { kind: 'approval'; actor: CharterApprovalActor },
    ledger: Record<string, unknown> | null,
  ): Promise<{ charter: Charter; created: boolean; changed: boolean }> {
    let groupOwner: CharterGroupOwnerEvidence | null = null;
    const auditSuccess = async (head: any, previousVersion: number | null) => {
      if (mode.kind === 'approval') await this.recordApprovalAudit(projectId, mode.actor.audit,
        'success', head.version, head.content_hash, previousVersion, client,
        // Section 7.1 (T2 S5): an approved change's decision rides the row beside the arm's fields.
        groupOwner || ledger ? { ...(ledger ?? {}), ...(groupOwner ?? {}) } : null);
    };
    try {
      await lockProject(client, projectId, true);
      if (mode.kind === 'approval') groupOwner = await requireCharterApprover(client, projectId, mode.actor);
      const validated = validateContent(content);
      const hash = sha256Hex(validated);

      const existing = await client.query(
        'SELECT * FROM project_charters WHERE project_id = $1 FOR UPDATE',
        [projectId],
      );

      if (existing.rows.length === 0) {
        const inserted = await client.query(
          `INSERT INTO project_charters (project_id, content, content_hash, version, updated_by_principal_id)
           VALUES ($1, $2, $3, 1, $4)
           RETURNING *`,
          [projectId, validated, hash, actorPrincipalId],
        );
        const head = inserted.rows[0];
        await client.query(
          `INSERT INTO project_charter_versions (charter_id, version, content, content_hash, actor_principal_id)
           VALUES ($1, 1, $2, $3, $4)`,
          [head.id, validated, hash, actorPrincipalId],
        );
        await auditSuccess(head, null);
        return { charter: mapRow(head), created: true, changed: true };
      }

      const head = existing.rows[0];
      if (typeof revision !== 'string' || revision.length === 0) {
        throw err(400, 'REVISION_REQUIRED', 'The last observed revision is required (If-Match)');
      }
      if (revision !== head.revision) {
        throw err(412, 'REVISION_MISMATCH', 'The Charter changed since it was last read; reload and retry');
      }

      if (head.content === validated) {
        await auditSuccess(head, head.version);
        return { charter: mapRow(head), created: false, changed: false };
      }

      const nextVersion = head.version + 1;
      const updated = await client.query(
        `UPDATE project_charters
         SET content = $2, content_hash = $3, version = $4,
             revision = gen_random_uuid(), updated_by_principal_id = $5, updated_at = NOW()
         WHERE id = $1
         RETURNING *`,
        [head.id, validated, hash, nextVersion, actorPrincipalId],
      );
      await client.query(
        `INSERT INTO project_charter_versions (charter_id, version, content, content_hash, actor_principal_id)
         VALUES ($1, $2, $3, $4, $5)`,
        [head.id, nextVersion, validated, hash, actorPrincipalId],
      );
      await auditSuccess(updated.rows[0], head.version);
      return { charter: mapRow(updated.rows[0]), created: false, changed: true };
    } catch (e) {
      if (e instanceof CharterError && !e.auditMetadata && groupOwner) {
        const admitted = groupOwner as CharterGroupOwnerEvidence;
        throw new CharterError(e.status, e.code, e.message, e.field, e.challenge,
          { refusal: e.code, projectId: admitted.projectId, owningGroupId: admitted.owningGroupId, standing: admitted.standing });
      }
      throw e;
    }
  }

  /** Version metadata, newest first. */
  async listVersions(projectId: string): Promise<CharterVersionMeta[]> {
    const charter = await this.get(projectId);
    const result = await pool.query(
      `SELECT version, content_hash, actor_principal_id, created_at
       FROM project_charter_versions
       WHERE charter_id = $1
       ORDER BY version DESC`,
      [charter.id],
    );
    return result.rows.map(mapVersionMeta);
  }

  /** One historical version, including content — restore = PUT it back. */
  async getVersion(projectId: string, version: number): Promise<CharterVersion> {
    if (!Number.isInteger(version) || version < 1) {
      throw err(400, 'INVALID_QUERY_VALUE', 'version must be a positive integer', 'version');
    }
    // Card bc847bd0: project_charter_versions.version is a PostgreSQL integer;
    // a number past it reached the read and answered 500 (22003).
    if (version > 2147483647) {
      throw err(400, 'INVALID_QUERY_VALUE', 'version must be a positive integer up to 2147483647', 'version');
    }
    const charter = await this.get(projectId);
    const result = await pool.query(
      `SELECT version, content, content_hash, actor_principal_id, created_at
       FROM project_charter_versions
       WHERE charter_id = $1 AND version = $2`,
      [charter.id, version],
    );
    if (result.rows.length === 0) {
      throw err(404, 'CHARTER_VERSION_NOT_FOUND', 'No such Charter version');
    }
    const row = result.rows[0];
    return { ...mapVersionMeta(row), content: row.content };
  }
}

export const charterService = new CharterService();
