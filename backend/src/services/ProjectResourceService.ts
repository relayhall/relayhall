// ProjectResourceService.ts — canonical typed Project Resources (task 47ef04a2).
//
// Implements the owner-approved contract: reports 21a04c23 + c1895aa8
// (canonical schema 28b76f54). Exactly four kinds, active-only uniqueness,
// revision-bound mutation, one atomic idempotent kind-replacement
// transaction, and archived-Project immutability. All Resource text is
// quoted untrusted data: it is never interpreted, never concatenated into
// instructions, and descriptions never enter default agent projection.
import { pool } from '../db/connection';
import { v4 as uuidv4 } from 'uuid';
import crypto from 'crypto';
import { lifecyclePolicyService } from './LifecyclePolicyService';
// One canonical request serializer for 067 and for the generic retry contract
// (card fb06c930, design bf8928ee v5 §3.4). Behaviour is unchanged: the
// validator has already removed unknown fields and materialised every default,
// so this stays a semantic request identity rather than caller JSON formatting.
import { stableJson } from '../utils/stableJson';

export type ResourceKind = 'repository' | 'environment' | 'workspace' | 'reference';
export type ResourceState = 'active' | 'archived';
export type AgentVisibility = 'hidden' | 'available';
export type ExportPolicy = 'installation-only' | 'portable';

export const RESOURCE_KINDS: ResourceKind[] = ['repository', 'environment', 'workspace', 'reference'];

export interface ProjectResource {
  id: string;
  projectId: string;
  kind: ResourceKind;
  name: string;
  description: string | null;
  state: ResourceState;
  agentVisibility: AgentVisibility;
  exportPolicy: ExportPolicy;
  details: Record<string, unknown>;
  revision: string;
  createdAt: string;
  updatedAt: string;
  archivedAt: string | null;
}

export interface CreateResourceInput {
  kind: ResourceKind;
  name: string;
  description?: string | null;
  agentVisibility?: AgentVisibility;
  exportPolicy?: ExportPolicy;
  details: Record<string, unknown>;
}

export interface PatchResourceInput {
  name?: string;
  description?: string | null;
  agentVisibility?: AgentVisibility;
  exportPolicy?: ExportPolicy;
  details?: Record<string, unknown>;
}

/**
 * Stable-coded error for the shared Project/Resource contract. Routes map
 * `status`/`code` straight into the house API envelope. Messages never echo
 * stored URLs, paths, descriptions or unauthorized identities.
 */
export class ResourceContractError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly field?: string,
  ) {
    super(message);
    this.name = 'ResourceContractError';
  }
}

const err = (status: number, code: string, message: string, field?: string) =>
  new ResourceContractError(status, code, message, field);

// ---------------------------------------------------------------------------
// Validation — every value is untrusted data; failures are 422 with stable
// codes and never echo the offending value.
// ---------------------------------------------------------------------------

const KIND_DETAIL_KEYS: Record<ResourceKind, string[]> = {
  repository: ['url', 'role', 'defaultBranch'],
  environment: ['url', 'stage'],
  workspace: ['path', 'purpose'],
  reference: ['url', 'category'],
};

const ENVIRONMENT_STAGES = ['development', 'test', 'staging', 'production', 'other'];
const WORKSPACE_PURPOSES = ['source', 'build', 'data', 'backup', 'other'];
const REFERENCE_CATEGORIES = ['documentation', 'research', 'tool', 'other'];
const REPOSITORY_ROLES = ['primary', 'additional'];

/** Human text: bounded, and no NUL or C0 control characters other than newline/tab. */
function requireText(value: unknown, field: string, maxLen: number): string {
  if (typeof value !== 'string') {
    throw err(422, 'INVALID_RESOURCE_VALUE', `${field} must be a string`, field);
  }
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)) {
    throw err(422, 'INVALID_RESOURCE_VALUE', `${field} contains a forbidden control character`, field);
  }
  if (value.length < 1 || value.length > maxLen) {
    throw err(422, 'INVALID_RESOURCE_VALUE', `${field} must be 1..${maxLen} characters`, field);
  }
  return value;
}

/** Locator text (URLs, paths, branch names): human-text rules plus no whitespace. */
function requireLocator(value: unknown, field: string, maxLen: number): string {
  const raw = requireText(value, field, maxLen);
  if (/\s/.test(raw)) {
    throw err(422, 'INVALID_RESOURCE_VALUE', `${field} must not contain whitespace`, field);
  }
  return raw;
}

/** http/https URL, absolute, no user-info, no embedded credential material. */
function validateHttpUrl(value: unknown, field: string): string {
  const raw = requireLocator(value, field, 2000);
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw err(422, 'INVALID_RESOURCE_VALUE', `${field} is not a valid absolute URL`, field);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw err(422, 'UNSUPPORTED_SCHEME', `${field} must use http or https`, field);
  }
  if (parsed.username || parsed.password) {
    throw err(422, 'EMBEDDED_CREDENTIAL_FORBIDDEN', `${field} must not carry user-info`, field);
  }
  return raw;
}

/** Git URL: https, ssh:// or canonical SCP-like syntax. No embedded credentials
 * beyond the conventional bare git user in SCP syntax. */
function validateGitUrl(value: unknown, field: string): string {
  const raw = requireLocator(value, field, 2000);
  const scpLike = /^[A-Za-z0-9._-]+@[A-Za-z0-9.-]+:[^\s]+$/;
  if (scpLike.test(raw)) {
    return raw;
  }
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw err(422, 'INVALID_RESOURCE_VALUE', `${field} is not a valid Git URL`, field);
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'ssh:') {
    throw err(422, 'UNSUPPORTED_SCHEME', `${field} must use https, ssh or SCP-like Git syntax`, field);
  }
  if (parsed.password || (parsed.protocol === 'https:' && parsed.username)) {
    throw err(422, 'EMBEDDED_CREDENTIAL_FORBIDDEN', `${field} must not carry credentials`, field);
  }
  return raw;
}

function validateAbsolutePath(value: unknown, field: string): string {
  const raw = requireLocator(value, field, 2000);
  if (!raw.startsWith('/')) {
    throw err(422, 'INVALID_RESOURCE_VALUE', `${field} must be an absolute path`, field);
  }
  const segments = raw.split('/');
  if (segments.includes('..') || segments.includes('~')) {
    throw err(422, 'INVALID_RESOURCE_VALUE', `${field} must not contain traversal segments`, field);
  }
  return raw;
}

function validateEnum(value: unknown, allowed: string[], field: string): string {
  if (typeof value !== 'string' || !allowed.includes(value)) {
    throw err(422, 'INVALID_RESOURCE_VALUE', `${field} must be one of: ${allowed.join(', ')}`, field);
  }
  return value;
}

function rejectUnknownKeys(obj: Record<string, unknown>, allowed: string[], where: string): void {
  for (const key of Object.keys(obj)) {
    if (!allowed.includes(key)) {
      throw err(400, 'UNKNOWN_FIELD', `Unknown field '${key}' in ${where}`, key);
    }
  }
}

export function validateDetails(kind: ResourceKind, details: unknown): Record<string, unknown> {
  if (typeof details !== 'object' || details === null || Array.isArray(details)) {
    throw err(422, 'INVALID_RESOURCE_VALUE', 'details must be an object', 'details');
  }
  const d = details as Record<string, unknown>;
  rejectUnknownKeys(d, KIND_DETAIL_KEYS[kind], `${kind} details`);
  switch (kind) {
    case 'repository': {
      const url = validateGitUrl(d.url, 'details.url');
      const role = validateEnum(d.role ?? 'additional', REPOSITORY_ROLES, 'details.role');
      let defaultBranch: string | null = null;
      if (d.defaultBranch !== undefined && d.defaultBranch !== null) {
        defaultBranch = requireLocator(d.defaultBranch, 'details.defaultBranch', 200);
      }
      return { url, role, defaultBranch };
    }
    case 'environment': {
      const url = validateHttpUrl(d.url, 'details.url');
      const stage = validateEnum(d.stage, ENVIRONMENT_STAGES, 'details.stage');
      return { url, stage };
    }
    case 'workspace': {
      const path = validateAbsolutePath(d.path, 'details.path');
      const purpose = validateEnum(d.purpose, WORKSPACE_PURPOSES, 'details.purpose');
      return { path, purpose };
    }
    case 'reference': {
      const url = validateHttpUrl(d.url, 'details.url');
      const category = validateEnum(d.category, REFERENCE_CATEGORIES, 'details.category');
      return { url, category };
    }
  }
}

/** Trimmed, Unicode case-folded (NFKC + lower) — the single server-side
 * normalization every interface submits to. */
export function normalizeResourceName(name: string): string {
  return name.trim().normalize('NFKC').toLowerCase();
}

function validateCommon(input: CreateResourceInput): {
  name: string;
  normalizedName: string;
  description: string | null;
  agentVisibility: AgentVisibility;
  exportPolicy: ExportPolicy;
  details: Record<string, unknown>;
} {
  if (!RESOURCE_KINDS.includes(input.kind)) {
    throw err(422, 'INVALID_RESOURCE_VALUE', 'kind must be repository, environment, workspace or reference', 'kind');
  }
  const name = requireText(input.name, 'name', 120);
  const normalizedName = normalizeResourceName(name);
  if (normalizedName.length === 0) {
    throw err(422, 'INVALID_RESOURCE_VALUE', 'name must contain at least one non-space character', 'name');
  }
  let description: string | null = null;
  if (input.description !== undefined && input.description !== null && input.description !== '') {
    description = requireText(input.description, 'description', 1000);
  }
  const agentVisibility = (input.agentVisibility ?? 'hidden') as AgentVisibility;
  if (!['hidden', 'available'].includes(agentVisibility)) {
    throw err(422, 'INVALID_RESOURCE_VALUE', 'agentVisibility must be hidden or available', 'agentVisibility');
  }
  const exportPolicy = (input.exportPolicy ?? 'installation-only') as ExportPolicy;
  if (!['installation-only', 'portable'].includes(exportPolicy)) {
    throw err(422, 'INVALID_RESOURCE_VALUE', 'exportPolicy must be installation-only or portable', 'exportPolicy');
  }
  if (input.kind === 'workspace' && exportPolicy === 'portable') {
    throw err(422, 'WORKSPACE_MUST_BE_INSTALLATION_ONLY', 'Workspace resources are always installation-only', 'exportPolicy');
  }
  const details = validateDetails(input.kind, input.details);
  return { name, normalizedName, description, agentVisibility, exportPolicy, details };
}


// ---------------------------------------------------------------------------
// Row mapping
// ---------------------------------------------------------------------------

function mapRow(row: any): ProjectResource {
  return {
    id: row.id,
    projectId: row.project_id,
    kind: row.kind,
    name: row.name,
    description: row.description ?? null,
    state: row.state,
    agentVisibility: row.agent_visibility,
    exportPolicy: row.export_policy,
    details: typeof row.details === 'string' ? JSON.parse(row.details) : row.details,
    revision: row.revision,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    archivedAt: row.archived_at ?? null,
  };
}

type Queryable = { query: (text: string, params?: any[]) => Promise<any> };

/**
 * Locks the Project row and returns its status. Concealed absence and
 * archived-Project immutability both begin here: PROJECT_NOT_FOUND is 404
 * regardless of why, and — when `requireActive` — PROJECT_ARCHIVED is raised
 * BEFORE any other outcome, including idempotency replay (review 20f6068c
 * blocker 1: a replay must never succeed against an archived Project).
 */
async function lockProject(
  executor: Queryable,
  projectId: string,
  requireActive: boolean,
): Promise<{ id: string; status: string }> {
  const result = await executor.query(
    'SELECT id, status FROM projects WHERE id = $1 FOR UPDATE',
    [projectId],
  );
  if (result.rows.length === 0) {
    throw err(404, 'PROJECT_NOT_FOUND', 'Project not found');
  }
  const project = result.rows[0];
  if (requireActive && project.status === 'archived') {
    throw err(409, 'PROJECT_ARCHIVED', 'Project is archived and read-only; restore it first');
  }
  return project;
}

function mapUniqueViolation(e: any): never {
  if (e && e.code === '23505') {
    const constraint = String(e.constraint || '');
    if (constraint.includes('primary_repository')) {
      throw err(409, 'PRIMARY_REPOSITORY_CONFLICT', 'An active primary repository already exists for this project');
    }
    if (constraint.includes('active_name')) {
      throw err(409, 'RESOURCE_NAME_CONFLICT', 'An active resource of that kind already uses that name', 'name');
    }
  }
  throw e;
}

export class ProjectResourceService {
  /**
   * List resources for a Project. Deterministic order: active before
   * archived, kind, case-folded name, then id. Cursor is an opaque
   * base64url of the last row's sort key.
   */
  async list(
    projectId: string,
    options: { includeArchived?: boolean; kind?: ResourceKind; limit?: number; cursor?: string } = {},
  ): Promise<{ resources: ProjectResource[]; nextCursor: string | null }> {
    await this.requireProject(projectId);
    const params: any[] = [projectId];
    const conditions = ['project_id = $1'];
    if (!options.includeArchived) {
      conditions.push(`state = 'active'`);
    }
    if (options.kind) {
      if (!RESOURCE_KINDS.includes(options.kind)) {
        throw err(400, 'UNKNOWN_FIELD', 'kind filter must be a valid resource kind', 'kind');
      }
      params.push(options.kind);
      conditions.push(`kind = $${params.length}`);
    }
    if (options.cursor) {
      let decoded: { state: string; kind: string; name: string; id: string };
      try {
        decoded = JSON.parse(Buffer.from(options.cursor, 'base64url').toString('utf8'));
        if (!decoded || typeof decoded.id !== 'string') throw new Error('bad cursor');
      } catch {
        throw err(400, 'INVALID_CURSOR', 'cursor is not valid');
      }
      params.push(decoded.state, decoded.kind, decoded.name, decoded.id);
      const base = params.length - 3;
      conditions.push(
        `(CASE state WHEN 'active' THEN 0 ELSE 1 END, kind, normalized_name, id) > ` +
        `(CASE $${base}::text WHEN 'active' THEN 0 ELSE 1 END, $${base + 1}::text, $${base + 2}::text, $${base + 3}::uuid)`,
      );
    }
    const limit = Math.min(Math.max(options.limit ?? 200, 1), 500);
    params.push(limit + 1);
    const result = await pool.query(
      `SELECT * FROM project_resources
       WHERE ${conditions.join(' AND ')}
       ORDER BY CASE state WHEN 'active' THEN 0 ELSE 1 END, kind, normalized_name, id
       LIMIT $${params.length}`,
      params,
    );
    const rows = result.rows.slice(0, limit);
    let nextCursor: string | null = null;
    if (result.rows.length > limit) {
      const last = rows[rows.length - 1];
      nextCursor = Buffer.from(JSON.stringify({
        state: last.state, kind: last.kind, name: last.normalized_name, id: last.id,
      })).toString('base64url');
    }
    return { resources: rows.map(mapRow), nextCursor };
  }

  /** Child-bound read: the storage predicate binds BOTH ids, so a resource
   * belonging to another Project is indistinguishable from absence. */
  async get(projectId: string, resourceId: string): Promise<ProjectResource> {
    await this.requireProject(projectId);
    const result = await pool.query(
      'SELECT * FROM project_resources WHERE id = $1 AND project_id = $2',
      [resourceId, projectId],
    );
    if (result.rows.length === 0) {
      throw err(404, 'RESOURCE_NOT_FOUND', 'Resource not found');
    }
    return mapRow(result.rows[0]);
  }

  async create(projectId: string, input: CreateResourceInput): Promise<ProjectResource> {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      // Concealment precedes semantic validation (review 73df8efe finding 5):
      // an absent/denied Project must be a 404 regardless of body validity,
      // or body validity would disclose Project existence.
      await lockProject(client, projectId, true);
      const validated = validateCommon(input);
      const id = uuidv4();
      await lifecyclePolicyService.evaluate(client, {
        action: 'project-resource.create',
        subject: { kind: 'project-resource', id },
        proposed: { projectId, kind: input.kind, state: 'active' },
      });
      let result;
      try {
        result = await client.query(
          `INSERT INTO project_resources
             (id, project_id, kind, name, normalized_name, description, agent_visibility, export_policy, details)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
           RETURNING *`,
          [id, projectId, input.kind, validated.name, validated.normalizedName,
           validated.description, validated.agentVisibility, validated.exportPolicy,
           JSON.stringify(validated.details)],
        );
      } catch (e) {
        mapUniqueViolation(e);
      }
      await client.query('COMMIT');
      return mapRow(result.rows[0]);
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
  }

  /**
   * JSON-merge-patch of common fields and same-kind details. The complete
   * resulting entity is validated before commit; kind is immutable.
   */
  async patch(projectId: string, resourceId: string, revision: string, patch: PatchResourceInput): Promise<ProjectResource> {
    rejectUnknownKeys(patch as Record<string, unknown>,
      ['name', 'description', 'agentVisibility', 'exportPolicy', 'details'], 'resource patch');
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const project = await lockProject(client, projectId, false);
      const existing = await this.lockResource(client, projectId, resourceId);
      if (project.status === 'archived') {
        throw err(409, 'PROJECT_ARCHIVED', 'Project is archived and read-only; restore it first');
      }
      if (existing.state !== 'active') {
        throw err(409, 'RESOURCE_ARCHIVED', 'Resource is archived; restore it before editing');
      }
      this.checkRevision(existing, revision);
      const merged: CreateResourceInput = {
        kind: existing.kind,
        name: patch.name !== undefined ? patch.name : existing.name,
        description: patch.description !== undefined ? patch.description : existing.description,
        agentVisibility: patch.agentVisibility !== undefined ? patch.agentVisibility : existing.agentVisibility,
        exportPolicy: patch.exportPolicy !== undefined ? patch.exportPolicy : existing.exportPolicy,
        details: patch.details !== undefined
          ? { ...existing.details, ...patch.details }
          : existing.details,
      };
      const validated = validateCommon(merged);
      await lifecyclePolicyService.evaluate(client, {
        action: 'project-resource.update',
        subject: { kind: 'project-resource', id: resourceId, revision: existing.revision },
        current: { projectId, kind: existing.kind, state: existing.state },
        proposed: { projectId, kind: merged.kind, state: existing.state },
      });
      let result;
      try {
        result = await client.query(
          `UPDATE project_resources
           SET name = $1, normalized_name = $2, description = $3, agent_visibility = $4,
               export_policy = $5, details = $6, revision = gen_random_uuid(), updated_at = NOW()
           WHERE id = $7 AND project_id = $8
           RETURNING *`,
          [validated.name, validated.normalizedName, validated.description,
           validated.agentVisibility, validated.exportPolicy, JSON.stringify(validated.details),
           resourceId, projectId],
        );
      } catch (e) {
        mapUniqueViolation(e);
      }
      await client.query('COMMIT');
      return mapRow(result.rows[0]);
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
  }

  async archive(projectId: string, resourceId: string, revision: string): Promise<ProjectResource> {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const project = await lockProject(client, projectId, false);
      const existing = await this.lockResource(client, projectId, resourceId);
      if (project.status === 'archived') {
        throw err(409, 'PROJECT_ARCHIVED', 'Project is archived and read-only; restore it first');
      }
      this.checkRevision(existing, revision);
      if (existing.state === 'archived') {
        // Idempotent no-op only under a matching revision precondition.
        await client.query('COMMIT');
        return existing;
      }
      await lifecyclePolicyService.evaluate(client, {
        action: 'project-resource.archive',
        subject: { kind: 'project-resource', id: resourceId, revision: existing.revision },
        current: { projectId, kind: existing.kind, state: existing.state },
        proposed: { projectId, kind: existing.kind, state: 'archived' },
      });
      const result = await client.query(
        `UPDATE project_resources
         SET state = 'archived', archived_at = NOW(), revision = gen_random_uuid(), updated_at = NOW()
         WHERE id = $1 AND project_id = $2
         RETURNING *`,
        [resourceId, projectId],
      );
      await client.query('COMMIT');
      return mapRow(result.rows[0]);
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
  }

  async restore(projectId: string, resourceId: string, revision: string): Promise<ProjectResource> {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const project = await lockProject(client, projectId, false);
      const existing = await this.lockResource(client, projectId, resourceId);
      if (project.status === 'archived') {
        throw err(409, 'PROJECT_ARCHIVED', 'Project is archived and read-only; restore it first');
      }
      this.checkRevision(existing, revision);
      if (existing.state === 'active') {
        await client.query('COMMIT');
        return existing;
      }
      await lifecyclePolicyService.evaluate(client, {
        action: 'project-resource.restore',
        subject: { kind: 'project-resource', id: resourceId, revision: existing.revision },
        current: { projectId, kind: existing.kind, state: existing.state },
        proposed: { projectId, kind: existing.kind, state: 'active' },
      });
      let result;
      try {
        result = await client.query(
          `UPDATE project_resources
           SET state = 'active', archived_at = NULL, revision = gen_random_uuid(), updated_at = NOW()
           WHERE id = $1 AND project_id = $2
           RETURNING *`,
          [resourceId, projectId],
        );
      } catch (e) {
        mapUniqueViolation(e);
      }
      await client.query('COMMIT');
      return mapRow(result.rows[0]);
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
  }

  /**
   * The canonical atomic kind replacement (contract c1895aa8 §2).
   *
   * Order inside the single transaction is contract-load-bearing:
   *   1. lock + bind the Project and REJECT if archived — before the
   *      idempotency lookup, so a replacement committed while active can
   *      never be replayed after the Project is archived (20f6068c #1);
   *   2. validate the complete replacement and hash its canonical,
   *      default-materialised representation;
   *   3. replay lookup (same caller/project/key + semantically equivalent
   *      request → the original committed pair; different request → 409);
   *   4. require the old Resource active, its If-Match revision, and a
   *      different replacement kind;
   *   5. insert replacement + archive old + idempotency record, one commit.
   */
  async replace(
    projectId: string,
    resourceId: string,
    revision: string,
    idempotencyKey: string,
    caller: string,
    input: CreateResourceInput,
  ): Promise<{ replacement: ProjectResource; replaced: ProjectResource; requestId: string }> {
    if (typeof idempotencyKey !== 'string' || idempotencyKey.length < 16 || idempotencyKey.length > 128) {
      throw err(400, 'IDEMPOTENCY_KEY_REQUIRED', 'Idempotency-Key header of 16..128 characters is required');
    }
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      // (1) bind + lock the Project row (concealed 404 when absent), then
      // (2) bind the child (concealed 404 — a foreign/absent resource id must
      //     conceal BEFORE any lifecycle state is disclosed; 666f69f2 #2),
      // (3) the archived-Project gate (409) BEFORE the replay lookup, so a
      //     committed replacement never replays after archive (20f6068c #1),
      // (4) the replay, returning the immutable stored snapshot (666f69f2 #1).
      const project = await lockProject(client, projectId, false);
      const existing = await this.lockResource(client, projectId, resourceId);
      if (project.status === 'archived') {
        throw err(409, 'PROJECT_ARCHIVED', 'Project is archived and read-only; restore it first');
      }

      // The child/project concealment and archived-Project gates stay ahead
      // of request validation. After those gates, validate once and hash only
      // the canonical values that would be persisted. Reordered keys,
      // omitted defaults and explicit equivalent defaults are one request.
      const validated = validateCommon(input);
      const canonicalInput = {
        kind: input.kind,
        name: validated.name,
        description: validated.description,
        agentVisibility: validated.agentVisibility,
        exportPolicy: validated.exportPolicy,
        details: validated.details,
      };
      const requestHash = crypto.createHash('sha256')
        .update(stableJson({ resourceId, revision, input: canonicalInput }))
        .digest('hex');

      const replay = await client.query(
        `SELECT * FROM project_resource_replacements
         WHERE caller = $1 AND project_id = $2 AND idempotency_key = $3`,
        [caller, projectId, idempotencyKey],
      );
      if (replay.rows.length > 0) {
        const record = replay.rows[0];
        if (record.request_hash !== requestHash) {
          throw err(409, 'IDEMPOTENCY_KEY_REUSED', 'Idempotency key was already used with a different request');
        }
        const snapshot = typeof record.response_snapshot === 'string'
          ? JSON.parse(record.response_snapshot)
          : record.response_snapshot;
        await client.query('COMMIT');
        return { replacement: snapshot.replacement, replaced: snapshot.replaced, requestId: record.request_id };
      }

      if (existing.state !== 'active') {
        throw err(409, 'RESOURCE_ARCHIVED', 'The resource being replaced is not active');
      }
      this.checkRevision(existing, revision);

      // (4) lifecycle/revision gates and the different-kind requirement stay
      // after replay, so an equivalent retry returns its immutable snapshot.
      if (input.kind === existing.kind) {
        throw err(409, 'RESOURCE_REPLACEMENT_KIND_UNCHANGED', 'Replacement kind equals the old kind; use PATCH instead');
      }

      // (5) archive old, insert new, record idempotency — one commit
      await lifecyclePolicyService.evaluate(client, {
        action: 'project-resource.replace',
        subject: { kind: 'project-resource', id: resourceId, revision: existing.revision },
        current: { projectId, kind: existing.kind, state: existing.state },
        proposed: { projectId, kind: input.kind, state: 'active' },
      });
      const archivedOld = await client.query(
        `UPDATE project_resources
         SET state = 'archived', archived_at = NOW(), revision = gen_random_uuid(), updated_at = NOW()
         WHERE id = $1 AND project_id = $2
         RETURNING *`,
        [resourceId, projectId],
      );
      const newId = uuidv4();
      const requestId = uuidv4();
      let inserted;
      try {
        inserted = await client.query(
          `INSERT INTO project_resources
             (id, project_id, kind, name, normalized_name, description, agent_visibility, export_policy, details)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
           RETURNING *`,
          [newId, projectId, input.kind, validated.name, validated.normalizedName,
           validated.description, validated.agentVisibility, validated.exportPolicy,
           JSON.stringify(validated.details)],
        );
      } catch (e) {
        mapUniqueViolation(e);
      }
      const replacement = mapRow(inserted.rows[0]);
      const replaced = mapRow(archivedOld.rows[0]);
      await client.query(
        `INSERT INTO project_resource_replacements
           (caller, project_id, idempotency_key, request_hash, replaced_resource_id, replacement_resource_id, response_snapshot, request_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [caller, projectId, idempotencyKey, requestHash, resourceId, newId,
         JSON.stringify({ replacement, replaced }), requestId],
      );
      await client.query('COMMIT');
      return { replacement, replaced, requestId };
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
  }

  /**
   * Typed agent-context projection (contract 21a04c23 §3.3): active +
   * available resources only; the projected fields are exactly the per-kind
   * allowlist; descriptions, ids, lifecycle, export policy and legacy data
   * are excluded. Archived Projects yield PROJECT_ARCHIVED with no payload.
   */
  async context(projectId: string): Promise<{
    project: { name: string };
    resources: Array<{ kind: ResourceKind; name: string; details: Record<string, unknown> }>;
    omitted: { hidden: number; archived: number; incompatible: number };
    schemaVersion: 1;
  }> {
    // One transaction with a shared lock on the Project row: an archive
    // cannot commit between the status check and the Resource read, so an
    // archived Project can never yield a context payload (666f69f2 #4).
    const client = await pool.connect();
    let project: any;
    let rows: any;
    try {
      await client.query('BEGIN');
      const projectResult = await client.query('SELECT id, name, status FROM projects WHERE id = $1 FOR SHARE', [projectId]);
      if (projectResult.rows.length === 0) {
        throw err(404, 'PROJECT_NOT_FOUND', 'Project not found');
      }
      project = projectResult.rows[0];
      if (project.status === 'archived') {
        throw err(409, 'PROJECT_ARCHIVED', 'Archived projects generate no context');
      }
      rows = await client.query('SELECT * FROM project_resources WHERE project_id = $1', [projectId]);
      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
    let hidden = 0;
    let archived = 0;
    const projected: Array<{ kind: ResourceKind; name: string; details: Record<string, unknown> }> = [];
    const ordered = rows.rows
      .slice()
      .sort((a: any, b: any) =>
        a.kind.localeCompare(b.kind) || a.normalized_name.localeCompare(b.normalized_name) || a.id.localeCompare(b.id));
    for (const row of ordered) {
      if (row.state === 'archived') { archived += 1; continue; }
      if (row.agent_visibility !== 'available') { hidden += 1; continue; }
      const resource = mapRow(row);
      projected.push({ kind: resource.kind, name: resource.name, details: this.projectDetails(resource) });
    }
    return {
      project: { name: project.name },
      resources: projected,
      omitted: { hidden, archived, incompatible: 0 },
      schemaVersion: 1,
    };
  }

  /** Per-kind projection allowlist — nothing else ever leaves the record. */
  private projectDetails(resource: ProjectResource): Record<string, unknown> {
    const d = resource.details as Record<string, unknown>;
    switch (resource.kind) {
      case 'repository':
        return { url: d.url, role: d.role, defaultBranch: d.defaultBranch ?? null };
      case 'environment':
        return { url: d.url, stage: d.stage };
      case 'workspace':
        return { path: d.path, purpose: d.purpose };
      case 'reference':
        return { url: d.url, category: d.category };
    }
  }

  /** Management-only counts; never raw legacy values. */
  async compatibility(projectId: string): Promise<{
    mapped: number;
    held: number;
    bySurface: Record<string, { mapped: number; held: number }>;
    migrationVersion: number;
  }> {
    await this.requireProject(projectId);
    const result = await pool.query(
      `SELECT source_surface, disposition, COUNT(*)::int AS count
       FROM project_resource_migration_items
       WHERE project_id = $1
         AND superseded_by_migration_version IS NULL
       GROUP BY source_surface, disposition`,
      [projectId],
    );
    // The current receipt version is independent of delta-item count. A v2
    // repair can legitimately plan zero new items while still proving that it
    // inspected and bound the source snapshot.
    const versionResult = await pool.query(
      `SELECT COALESCE(MAX(migration_version), 0)::int AS version
       FROM project_resource_migration_runs
       WHERE project_id = $1`,
      [projectId],
    );
    const bySurface: Record<string, { mapped: number; held: number }> = {};
    let mapped = 0;
    let held = 0;
    const migrationVersion = Number(versionResult.rows[0]?.version ?? 0);
    for (const row of result.rows) {
      if (!bySurface[row.source_surface]) bySurface[row.source_surface] = { mapped: 0, held: 0 };
      bySurface[row.source_surface][row.disposition as 'mapped' | 'held'] += row.count;
      if (row.disposition === 'mapped') mapped += row.count; else held += row.count;
    }
    return { mapped, held, bySurface, migrationVersion };
  }

  // -- helpers ------------------------------------------------------------

  private async requireProject(projectId: string): Promise<void> {
    const result = await pool.query('SELECT id FROM projects WHERE id = $1', [projectId]);
    if (result.rows.length === 0) {
      throw err(404, 'PROJECT_NOT_FOUND', 'Project not found');
    }
  }

  private async lockResource(executor: Queryable, projectId: string, resourceId: string): Promise<ProjectResource> {
    const result = await executor.query(
      'SELECT * FROM project_resources WHERE id = $1 AND project_id = $2 FOR UPDATE',
      [resourceId, projectId],
    );
    if (result.rows.length === 0) {
      throw err(404, 'RESOURCE_NOT_FOUND', 'Resource not found');
    }
    return mapRow(result.rows[0]);
  }

  private checkRevision(existing: ProjectResource, revision: string): void {
    if (typeof revision !== 'string' || revision.length === 0) {
      throw err(400, 'REVISION_REQUIRED', 'The last observed revision is required (If-Match)');
    }
    if (revision !== existing.revision) {
      throw err(412, 'REVISION_MISMATCH', 'The resource changed since it was last read; reload and retry');
    }
  }
}

export const projectResourceService = new ProjectResourceService();
