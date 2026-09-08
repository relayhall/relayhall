// AccessProfileService.ts — Access profiles (RH-P3.AZ-S2, card 559393f5;
// AUTHZ design 4d961e37 §4, vocabulary amendment A17.4).
//
// An Access profile is a NAMED, VERSIONED, REUSABLE bundle of object
// authority (selectors → verbs). Versions are immutable (trigger-enforced
// in 095); exactly ONE published version per profile via
// published_version_id; assignments store profile_id ONLY and the
// evaluator joins through the published pointer — republish re-targets
// every assignment atomically and there is no per-assignment pointer to go
// stale (T14 by construction). An UNPUBLISHED profile yields EMPTY
// authority in the evaluator and may not be assigned (T35): fail closed,
// never an error in the hot path.
//
// LIVE EVALUATION (AZ-4): activeProfileCondition() is the ONE SQL seam the
// shared authorization predicate composes as a new arm (after the
// wildcard-grant arm, before visibility). Nothing compiles into grants
// rows; revoking an assignment is one delete, effective on the next
// request. Preview (§9.5) = the same tables queried on demand, self on the
// agent plane and what-if on the owner plane.
//
// ASSIGNEES: Accounts and Groups today. The AZ-S2 SEQUENCING GUARD refuses
// parented principals (and agent-kind rows — task-bounded identities are
// never profile assignees at S2) until AZ-S3's cap machinery lands; S3
// lifts the guard in code, no migration. Group assignees resolve by the
// SAME active-member membership join as the group grant arm (T34's
// mechanism, shared shape with 094).
//
// SELECTOR FORMS (§4, four since RH-AZ.PROJ-b): 'exact' (pinned ids),
// 'all-of-type' (every object of the type, future included), 'all-except'
// (all-of-type minus a pinned exclusion list) and 'all-in-project' (every
// object of the type inside the named Projects, future included). See
// SELECTOR_FORMS below for which types admit which.
//
// ROLLBACK is REPUBLISH: the publish pointer only moves forward
// (version_number monotonic). Restoring older authority = create a NEW
// version with the prior content and publish it — history stays intact in
// the append-only events (§4 "republish prior content as a NEW version").
import { pool } from '../db/connection';
import { auditService, type AuditActor } from './AuditService';
import { GRANT_RESOURCE_TYPES, GRANT_VERBS, type GrantResourceType, type GrantVerb } from './GrantService';
import {
  auditAuthorityMutationRefusal,
  authorityMutationRefusalMessage,
  isAuthorityMutationSurfaceKey,
} from '../utils/authorityMutationSurfaces';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// THE RATIFIED SELECTOR FORMS (AUTHZ design 4d961e37 §4). Three until
// RH-AZ.PROJ-b (card 95572530) added the PROJECT-BOUNDED fourth.
//
// The `all-` prefix marks the FUTURE-INCLUSIVE forms and `exact` is the only
// pinned one, so the fourth form is spelled `all-in-project`: all objects of
// the rule's type that live in the named Projects, INCLUDING objects created
// there later. It is the bounded middle of the family — `exact` never grows,
// `all-of-type` grows without bound, `all-in-project` grows only inside a
// perimeter the author named.
//
// `selector_ids` for `all-in-project` holds PROJECT ids, never ids of the
// rule's own resource type. That is the one place in the family where the
// list is read against a different table, which is why the admissibility
// table below exists rather than a fourth `if`.
export const SELECTOR_FORMS = ['exact', 'all-of-type', 'all-except', 'all-in-project'] as const;
export type SelectorForm = (typeof SELECTOR_FORMS)[number];

/** The forms whose `selector_ids` name PROJECTS rather than objects of the
 * rule's own resource type. Exported so no consumer has to know the spelling
 * to ask the question. */
export const PROJECT_BOUNDED_SELECTOR_FORMS: readonly SelectorForm[] = ['all-in-project'] as const;

export interface SelectorFormAdmission {
  /** The forms this resource type may carry, closed. */
  readonly forms: readonly SelectorForm[];
  /** Why, in one sentence the refusal quotes back to the caller. */
  readonly because: string;
}

/**
 * WHICH SELECTOR FORMS EACH RESOURCE TYPE ADMITS — one table, not a third
 * bespoke `if`.
 *
 * AZ-A5 clause 3 closed `surface` to `exact` alone with a hand-written check,
 * and this card owed a second, differently-shaped closure. Two special cases
 * beside one another is the shape that goes stale: a resource type added later
 * gets whichever branch its author remembered. `Record<GrantResourceType, …>`
 * makes the table TOTAL — a new grantable resource type does not compile until
 * someone decides what it admits — and both halves of the closure (the
 * synchronous validator, and the cross-check that the SQL shapes agree with
 * it) read THIS, never a copy.
 *
 * `project` deliberately does NOT admit `all-in-project`: a Project's project
 * coordinate is its own id, so the form would be a second spelling of `exact`,
 * and a closed set with two spellings for one authority is the thing the
 * closed set exists to prevent.
 */
export const SELECTOR_FORM_ADMISSIBILITY: Readonly<Record<GrantResourceType, SelectorFormAdmission>> = {
  task: {
    forms: ['exact', 'all-of-type', 'all-except', 'all-in-project'],
    because: 'a Task carries a project coordinate (tasks.project_id)',
  },
  phase: {
    forms: ['exact', 'all-of-type', 'all-except', 'all-in-project'],
    because: 'a Phase carries a project coordinate (phases.project_id)',
  },
  project: {
    forms: ['exact', 'all-of-type', 'all-except'],
    because: "a Project IS its own project coordinate, so 'all-in-project' would be a second spelling of 'exact'",
  },
  report: { forms: ['exact', 'all-of-type', 'all-except'], because: 'a Report carries no project coordinate' },
  skill: { forms: ['exact', 'all-of-type', 'all-except'], because: 'a Skill carries no project coordinate' },
  personality: { forms: ['exact', 'all-of-type', 'all-except'], because: 'a Personality carries no project coordinate' },
  service: { forms: ['exact', 'all-of-type', 'all-except'], because: 'a Service carries no project coordinate' },
  plugin: { forms: ['exact', 'all-of-type', 'all-except'], because: 'a Plugin carries no project coordinate' },
  blueprint: { forms: ['exact', 'all-of-type', 'all-except'], because: 'a Blueprint carries no project coordinate' },
  surface: { forms: ['exact'], because: 'AUTHZ amendment AZ-A5 clause 3' },
};

/** The seam placeholders a caller must substitute. `renderAuthoritySeam` is
 * the ONLY sanctioned substituter; it refuses to hand back text that still
 * carries one. */
export const SEAM_RESOURCE_ID_TOKEN = '<RESOURCE_ID_COLUMN>';
export const SEAM_PROJECT_BOUNDED_TOKEN = '<PROJECT_BOUNDED_ARM>';

/**
 * Render ONE authority-seam fragment (`activeGrantCondition`,
 * `activeProfileCondition`) against ONE resource shape.
 *
 * The project-bounded arm needs a column the seam cannot know — the resource
 * shape's PROJECT coordinate — and most shapes have none. A shape with no
 * project coordinate gets the literal `FALSE`, so an `all-in-project` row
 * written straight into `access_profile_rules` in SQL, bypassing every
 * validator, changes no decision for those types. That is a STATED property
 * of the predicate, not an emergent consequence of `NULL = ANY(...)`; the
 * arm states the NULL case too, for the same reason.
 *
 * The leftover-placeholder check is the control that makes this function
 * mandatory: a caller that hand-substituted one token and missed the other
 * used to ship SQL with a literal `<PROJECT_BOUNDED_ARM>` in it, which
 * PostgreSQL reports as a syntax error at request time. It fails here, loudly,
 * at compose time instead.
 */
export function renderAuthoritySeam(sql: string, resourceIdColumn: string, projectColumn?: string): string {
  const projectBoundedArm = projectColumn
    ? `(apr.selector_form = 'all-in-project' AND ${projectColumn} IS NOT NULL`
      + ` AND ${projectColumn} = ANY(apr.selector_ids))`
    : 'FALSE';
  const rendered = sql
    .split(SEAM_RESOURCE_ID_TOKEN).join(resourceIdColumn)
    .split(SEAM_PROJECT_BOUNDED_TOKEN).join(projectBoundedArm);
  const leftover = rendered.match(/<[A-Z_]+>/);
  if (leftover) {
    throw new Error(`authority seam rendered with an unsubstituted placeholder ${leftover[0]}`);
  }
  return rendered;
}

export interface ProfileRuleInput {
  resourceType?: unknown;
  selectorForm?: unknown;
  selectorIds?: unknown;
  verbs?: unknown;
}

export interface ProfileRule {
  resourceType: GrantResourceType;
  selectorForm: SelectorForm;
  selectorIds: string[];
  verbs: GrantVerb[];
}

export interface ProfileRecord {
  id: string;
  name: string;
  description: string;
  publishedVersionId: string | null;
  publishedVersionNumber: number | null;
  versionCount: number;
  assignmentCount: number;
  createdByPrincipalId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ProfileVersionRecord {
  id: string;
  profileId: string;
  versionNumber: number;
  createdByPrincipalId: string | null;
  createdAt: string;
  rules: ProfileRule[];
}

export interface ProfileAssignmentRecord {
  id: string;
  profileId: string;
  assigneeType: 'principal' | 'group';
  assigneeId: string;
  assignedByPrincipalId: string | null;
  createdAt: string;
}

export class AccessProfileError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly field?: string,
  ) {
    super(message);
    this.name = 'AccessProfileError';
  }
}

const err = (status: number, code: string, message: string, field?: string) =>
  new AccessProfileError(status, code, message, field);

function requireUuid(value: unknown, code: string, what: string): string {
  if (typeof value !== 'string' || !UUID_PATTERN.test(value)) {
    throw err(400, code, `${what} must be a full UUID`);
  }
  return value;
}

function validateName(name: unknown): string {
  if (typeof name !== 'string' || name.trim() === '') {
    throw err(422, 'INVALID_PROFILE_VALUE', 'name must be a non-empty string', 'name');
  }
  if (name.trim().length > 120) {
    throw err(422, 'INVALID_PROFILE_VALUE', 'name must be at most 120 characters', 'name');
  }
  return name.trim();
}

function validateDescription(description: unknown): string {
  if (description === undefined || description === null) return '';
  if (typeof description !== 'string' || description.length > 2000) {
    throw err(422, 'INVALID_PROFILE_VALUE', 'description must be a string of at most 2000 characters', 'description');
  }
  return description;
}

/**
 * AZ-A5 clause 3: a `surface` rule's selector ids must name `governable`
 * Access surfaces. Kept beside `validateRules` because it is the other half of
 * the same closure, and separate from it because governance is a row rather
 * than a shape. The EVALUATOR half is the middleware's
 * `governance !== 'governable'` short-circuit, which refuses before the arm
 * for `locked` and `always-self` surfaces (design §3.3, I2/I3, annex D10) -
 * either control may be removed without the other failing, which is why the
 * annex drills both.
 */
export async function assertGovernableSurfaceSelectors(
  rules: ProfileRule[],
  queryable: { query: (text: string, params?: any[]) => Promise<{ rows: any[] }> },
  // REQUIRED, not optional: ruling `70af4d82` §1.1 says the refusal below is
  // AUDITED, and an optional actor would let a future caller take the refusal
  // without the ledger row — the shape D21 clause (ii) exists to refuse.
  actor: AuditActor,
): Promise<void> {
  const ids = [...new Set(rules.filter((rule) => rule.resourceType === 'surface').flatMap((rule) => rule.selectorIds))];
  if (ids.length === 0) return;
  const found = await queryable.query(
    'SELECT id::text AS id, key, governance FROM access_surfaces WHERE id = ANY($1::uuid[])',
    [ids],
  );
  const byId = new Map(found.rows.map((row: any) => [String(row.id), row]));
  for (const id of ids) {
    const row = byId.get(id);
    if (!row) {
      throw err(422, 'INVALID_PROFILE_VALUE', `rules name Access surface ${id}, which does not exist`, 'rules');
    }
    if (row.governance !== 'governable') {
      throw err(422, 'INVALID_PROFILE_VALUE', `rules name Access surface '${row.key}', whose governance class is '${row.governance}' - only governable surfaces may be selected (AUTHZ amendment AZ-A5 clause 3)`, 'rules');
    }
    // THE AUTHORITY-MUTATION CLOSURE, `access_profile_rules` half (owner
    // ruling `70af4d82` §1.1; annex `85a2218d` D21 clause (ii), which is
    // D9's family: "a profile-rule selector naming a ... id ... refused
    // with an audited denial"). This is where an Access-bundle MATRIX
    // write lands: §3.4 makes a bundle's profile pair the PROJECTION of
    // its membership, so refusing the projection refuses the membership
    // whichever route writes it - candidate B's `/access-bundles` included.
    if (isAuthorityMutationSurfaceKey(String(row.key))) {
      await auditAuthorityMutationRefusal(actor, String(row.key), 'profile.version.create');
      throw err(422, 'AUTHORITY_MUTATION_SURFACE', authorityMutationRefusalMessage(String(row.key)), 'rules');
    }
  }
}

/**
 * `all-in-project` selector ids must name PROJECTS THAT EXIST — the async half
 * of the project-bounded closure, and the sibling of
 * `assertGovernableSurfaceSelectors` above.
 *
 * It is separate from `validateRules` for the same reason that one is: it
 * needs a ROW. It is separate from `assertGovernableSurfaceSelectors` because
 * it refuses a SHAPE, not an authority-mutation attempt, so it carries no
 * audited denial — there is no privileged act to attribute.
 *
 * A selector naming a project that does not exist is not a security hole: the
 * arm matches nothing and the rule yields empty authority. It is refused
 * anyway because the alternative is a profile that silently grants nothing,
 * and this design's delivery model is to make the bad state unrepresentable at
 * the WRITE rather than harmless downstream.
 *
 * ── THE LOCK (round-1 review F3) ──
 *
 * This ran as a plain SELECT and the comment at the call site claimed that
 * sharing the version's transaction stopped a Project being deleted between
 * the check and the write. It does not: under READ COMMITTED a concurrent
 * DELETE can commit in that window, and `selector_ids` is a UUID ARRAY, so no
 * foreign key catches it either. Being inside one transaction is not a lock;
 * a lock is a lock.
 *
 * `FOR KEY SHARE` is the right strength. What must hold at COMMIT is that the
 * row still EXISTS, and `FOR KEY SHARE` blocks exactly the statements that
 * could end that — DELETE, and an UPDATE of the key — while leaving ordinary
 * Project edits (a rename, a status change, a visibility change) free to
 * proceed. `ProjectResourceService` takes the stronger `FOR SHARE` because it
 * goes on to READ the row's `status` and needs it stable; this validator reads
 * nothing but existence, so the weaker lock is the correct one and blocks less.
 */
export async function assertProjectBoundedSelectors(
  rules: ProfileRule[],
  queryable: { query: (text: string, params?: any[]) => Promise<{ rows: any[] }> },
): Promise<void> {
  const ids = [...new Set(
    rules
      .filter((rule) => PROJECT_BOUNDED_SELECTOR_FORMS.includes(rule.selectorForm))
      .flatMap((rule) => rule.selectorIds),
  )];
  if (ids.length === 0) return;
  const found = await queryable.query(
    'SELECT id::text AS id FROM projects WHERE id = ANY($1::uuid[]) FOR KEY SHARE',
    [ids],
  );
  const present = new Set(found.rows.map((row: any) => String(row.id)));
  for (const id of ids) {
    if (!present.has(id)) {
      throw err(422, 'INVALID_PROFILE_VALUE', `rules name Project ${id} in an 'all-in-project' selector, which does not exist`, 'rules');
    }
  }
}

export function validateRules(input: unknown): ProfileRule[] {
  if (!Array.isArray(input) || input.length === 0) {
    throw err(422, 'INVALID_PROFILE_VALUE', 'rules must be a non-empty array', 'rules');
  }
  if (input.length > 200) {
    throw err(422, 'INVALID_PROFILE_VALUE', 'rules must be at most 200 entries', 'rules');
  }
  return input.map((raw: ProfileRuleInput, index: number) => {
    const at = `rules[${index}]`;
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
      throw err(422, 'INVALID_PROFILE_VALUE', `${at} must be an object`, 'rules');
    }
    const allowed = new Set(['resourceType', 'selectorForm', 'selectorIds', 'verbs']);
    for (const key of Object.keys(raw)) {
      if (!allowed.has(key)) {
        throw err(422, 'INVALID_PROFILE_VALUE', `${at} has unknown field '${key}'`, 'rules');
      }
    }
    if (typeof raw.resourceType !== 'string'
      || !(GRANT_RESOURCE_TYPES as readonly string[]).includes(raw.resourceType)) {
      throw err(422, 'INVALID_PROFILE_VALUE', `${at}.resourceType must be one of: ${GRANT_RESOURCE_TYPES.join(', ')}`, 'rules');
    }
    if (typeof raw.selectorForm !== 'string'
      || !(SELECTOR_FORMS as readonly string[]).includes(raw.selectorForm)) {
      throw err(422, 'INVALID_PROFILE_VALUE', `${at}.selectorForm must be one of: ${SELECTOR_FORMS.join(', ')}`, 'rules');
    }
    const form = raw.selectorForm as SelectorForm;
    let ids: string[] = [];
    if (form === 'all-of-type') {
      if (raw.selectorIds !== undefined && (!Array.isArray(raw.selectorIds) || raw.selectorIds.length > 0)) {
        throw err(422, 'INVALID_PROFILE_VALUE', `${at}.selectorIds must be absent or empty for all-of-type`, 'rules');
      }
    } else {
      if (!Array.isArray(raw.selectorIds) || raw.selectorIds.length === 0) {
        throw err(422, 'INVALID_PROFILE_VALUE', `${at}.selectorIds must be a non-empty UUID array for ${form}`, 'rules');
      }
      if (raw.selectorIds.length > 500) {
        throw err(422, 'INVALID_PROFILE_VALUE', `${at}.selectorIds must be at most 500 entries`, 'rules');
      }
      ids = raw.selectorIds.map((value: unknown) => {
        if (typeof value !== 'string' || !UUID_PATTERN.test(value)) {
          throw err(422, 'INVALID_PROFILE_VALUE', `${at}.selectorIds entries must be full UUIDs`, 'rules');
        }
        return value;
      });
    }
    if (!Array.isArray(raw.verbs) || raw.verbs.length === 0
      || raw.verbs.some((verb: unknown) => typeof verb !== 'string' || !(GRANT_VERBS as readonly string[]).includes(verb))) {
      throw err(422, 'INVALID_PROFILE_VALUE', `${at}.verbs must be a non-empty array from: ${GRANT_VERBS.join(', ')}`, 'rules');
    }
    // THE PER-TYPE FORM CLOSURE, synchronous half — ONE table, every type.
    //
    // AZ-A5 clause 3 (design 7a9317b2 §3.4; acceptance annex 85a2218d D3, D9)
    // closed `surface` to `exact`: `all-of-type` is future-inclusive by its
    // ratified definition, so a newly registered Access surface would silently
    // join every Access bundle that used it - the opposite of fail-closed for a
    // VISIBILITY feature - and it would name the `locked` surfaces;
    // `all-except` is the same shape with an exclusion list. RH-AZ.PROJ-b owes
    // a second closure of the same kind — `all-in-project` reads its
    // `selector_ids` against `projects`, so it is meaningless on a type with no
    // project coordinate. Both are now the SAME check, driven by
    // SELECTOR_FORM_ADMISSIBILITY, refused here at EVERY write surface this
    // validator serves (profile versions, warrant ceilings, approval requests,
    // delegation objects), and separately closed by the evaluator (a resource
    // shape with no project coordinate renders the arm as `FALSE`) and by the
    // `access_profile_rules_project_bounded_types` CHECK in migration 125,
    // which refuses a row raw SQL would otherwise write.
    const admission = SELECTOR_FORM_ADMISSIBILITY[raw.resourceType as GrantResourceType];
    if (!admission.forms.includes(form)) {
      throw err(422, 'INVALID_PROFILE_VALUE', `${at}.selectorForm must be one of: ${admission.forms.join(', ')} for resourceType '${raw.resourceType}' (${admission.because})`, 'rules');
    }
    if (raw.resourceType === 'surface') {
      // Verbs are `read` and `write` only on this type; the access LEVEL named
      // `use` is not the ratified verb `use` (A25.4).
      if ((raw.verbs as string[]).some((verb) => verb !== 'read' && verb !== 'write')) {
        throw err(422, 'INVALID_PROFILE_VALUE', `${at}.verbs for resourceType 'surface' must be drawn from: read, write (AUTHZ amendment AZ-A5 clause 3)`, 'rules');
      }
    }
    return {
      resourceType: raw.resourceType as GrantResourceType,
      selectorForm: form,
      selectorIds: ids,
      verbs: [...new Set(raw.verbs)] as GrantVerb[],
    };
  });
}

function mapProfile(row: any): ProfileRecord {
  return {
    id: row.id,
    name: row.name,
    description: row.description ?? '',
    publishedVersionId: row.published_version_id ?? null,
    publishedVersionNumber: row.published_version_number === null || row.published_version_number === undefined
      ? null : Number(row.published_version_number),
    versionCount: Number(row.version_count ?? 0),
    assignmentCount: Number(row.assignment_count ?? 0),
    createdByPrincipalId: row.created_by_principal_id ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapAssignment(row: any): ProfileAssignmentRecord {
  return {
    id: row.id,
    profileId: row.profile_id,
    assigneeType: row.assignee_type,
    assigneeId: row.assignee_id,
    assignedByPrincipalId: row.assigned_by_principal_id ?? null,
    createdAt: row.created_at,
  };
}

function mapRuleRow(row: any): ProfileRule {
  return {
    resourceType: row.resource_type,
    selectorForm: row.selector_form,
    selectorIds: row.selector_ids ?? [],
    verbs: row.verbs ?? [],
  };
}

const PROFILE_WITH_COUNTS = `
  SELECT ap.*,
         (SELECT v.version_number FROM access_profile_versions v WHERE v.id = ap.published_version_id) AS published_version_number,
         (SELECT COUNT(*) FROM access_profile_versions v WHERE v.profile_id = ap.id) AS version_count,
         (SELECT COUNT(*) FROM access_profile_assignments a WHERE a.profile_id = ap.id) AS assignment_count
    FROM access_profiles ap`;

interface Queryable {
  query: (text: string, params?: unknown[]) => Promise<{ rows: any[]; rowCount?: number | null }>;
}

async function writeEvent(
  queryable: Queryable,
  input: { profileId: string; versionId?: string | null; action: string; actor: AuditActor; metadata?: Record<string, unknown> },
): Promise<void> {
  await queryable.query(
    `INSERT INTO access_profile_events (profile_id, version_id, action, actor_principal_id, actor_handle, metadata)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb)`,
    [input.profileId, input.versionId ?? null, input.action, input.actor.principalId ?? null,
      input.actor.handle || 'unknown', JSON.stringify(input.metadata ?? {})],
  );
}

export class AccessProfileService {
  async list(): Promise<ProfileRecord[]> {
    const result = await pool.query(`${PROFILE_WITH_COUNTS} ORDER BY lower(ap.name) ASC, ap.id ASC`);
    return result.rows.map(mapProfile);
  }

  async get(id: string): Promise<ProfileRecord> {
    requireUuid(id, 'INVALID_PROFILE_ID', 'profile id');
    const result = await pool.query(`${PROFILE_WITH_COUNTS} WHERE ap.id = $1`, [id]);
    if (result.rows.length === 0) throw err(404, 'PROFILE_NOT_FOUND', 'No such access profile');
    return mapProfile(result.rows[0]);
  }

  async versions(profileId: string): Promise<ProfileVersionRecord[]> {
    await this.get(profileId);
    const result = await pool.query(
      `SELECT * FROM access_profile_versions WHERE profile_id = $1 ORDER BY version_number ASC`,
      [profileId],
    );
    const rules = await pool.query(
      `SELECT r.* FROM access_profile_rules r
        JOIN access_profile_versions v ON v.id = r.version_id
       WHERE v.profile_id = $1 ORDER BY r.resource_type ASC, r.id ASC`,
      [profileId],
    );
    return result.rows.map((row) => ({
      id: row.id,
      profileId: row.profile_id,
      versionNumber: Number(row.version_number),
      createdByPrincipalId: row.created_by_principal_id ?? null,
      createdAt: row.created_at,
      rules: rules.rows.filter((rule) => rule.version_id === row.id).map(mapRuleRow),
    }));
  }

  async create(input: { name?: unknown; description?: unknown }, actor: AuditActor): Promise<ProfileRecord> {
    const name = validateName(input.name);
    const description = validateDescription(input.description);
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const result = await client.query(
        `INSERT INTO access_profiles (name, description, created_by_principal_id)
         VALUES ($1, $2, $3)
         RETURNING *, NULL::int AS published_version_number, 0 AS version_count, 0 AS assignment_count`,
        [name, description, actor.principalId ?? null],
      );
      const profile = mapProfile(result.rows[0]);
      await writeEvent(client, { profileId: profile.id, action: 'profile.created', actor, metadata: { name } });
      await auditService.record({
        action: 'profile.create', actor, resourceType: 'access_profile', resourceId: profile.id,
        metadata: { name },
      }, client);
      await client.query('COMMIT');
      return profile;
    } catch (e) {
      await client.query('ROLLBACK');
      if (e instanceof Error && e.message.includes('duplicate key')) {
        throw err(409, 'PROFILE_NAME_EXISTS', 'An access profile with that name already exists (names are case-insensitive)');
      }
      throw e;
    } finally {
      client.release();
    }
  }

  async update(id: string, input: { name?: unknown; description?: unknown }, actor: AuditActor): Promise<ProfileRecord> {
    requireUuid(id, 'INVALID_PROFILE_ID', 'profile id');
    const sets: string[] = [];
    const params: unknown[] = [];
    const changed: Record<string, unknown> = {};
    if (input.name !== undefined) {
      const name = validateName(input.name);
      params.push(name); sets.push(`name = $${params.length}`); changed.name = name;
    }
    if (input.description !== undefined) {
      const description = validateDescription(input.description);
      params.push(description); sets.push(`description = $${params.length}`); changed.description = true;
    }
    if (sets.length === 0) {
      throw err(422, 'INVALID_PROFILE_VALUE', 'nothing to update: provide name and/or description');
    }
    params.push(id);
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const result = await client.query(
        `UPDATE access_profiles SET ${sets.join(', ')}, updated_at = NOW() WHERE id = $${params.length} RETURNING id`,
        params,
      );
      if (result.rows.length === 0) throw err(404, 'PROFILE_NOT_FOUND', 'No such access profile');
      await writeEvent(client, { profileId: id, action: 'profile.updated', actor, metadata: changed });
      await auditService.record({
        action: 'profile.update', actor, resourceType: 'access_profile', resourceId: id, metadata: changed,
      }, client);
      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK');
      if (e instanceof Error && e.message.includes('duplicate key')) {
        throw err(409, 'PROFILE_NAME_EXISTS', 'An access profile with that name already exists (names are case-insensitive)');
      }
      throw e;
    } finally {
      client.release();
    }
    return this.get(id);
  }

  /** Only a never-used draft can be deleted: versions are immutable history
   * and assignments are live authority — both refuse via typed errors
   * before any row is touched. */
  async remove(id: string, actor: AuditActor): Promise<void> {
    requireUuid(id, 'INVALID_PROFILE_ID', 'profile id');
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const versions = await client.query(
        'SELECT COUNT(*)::int AS n FROM access_profile_versions WHERE profile_id = $1', [id]);
      if ((versions.rows[0]?.n ?? 0) > 0) {
        throw err(409, 'PROFILE_HAS_VERSIONS', 'A profile with versions is immutable history; retire it by unassigning instead of deleting');
      }
      const assignments = await client.query(
        'SELECT COUNT(*)::int AS n FROM access_profile_assignments WHERE profile_id = $1', [id]);
      if ((assignments.rows[0]?.n ?? 0) > 0) {
        throw err(409, 'PROFILE_ASSIGNED', 'Unassign the profile everywhere before deleting it');
      }
      const result = await client.query('DELETE FROM access_profiles WHERE id = $1 RETURNING name', [id]);
      if (result.rows.length === 0) throw err(404, 'PROFILE_NOT_FOUND', 'No such access profile');
      await writeEvent(client, { profileId: id, action: 'profile.deleted', actor, metadata: { name: result.rows[0].name } });
      await auditService.record({
        action: 'profile.delete', actor, resourceType: 'access_profile', resourceId: id,
        metadata: { name: result.rows[0].name },
      }, client);
      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
  }

  /** Create an immutable version (next version_number) carrying the given
   * selector→verbs rules. Publication is a separate act. */
  async createVersion(profileId: string, rulesInput: unknown, actor: AuditActor): Promise<ProfileVersionRecord> {
    await this.get(profileId);
    const rules = validateRules(rulesInput);
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      // THE CLOSURE ON `surface`, asynchronous half: selector ids must name
      // `governable` Access surfaces (AZ-A5 clause 3). Governance is a ROW, so
      // this cannot live in the synchronous validator above; it runs inside the
      // version transaction, against the same client, so a surface retired
      // concurrently cannot slip between the check and the write.
      await assertGovernableSurfaceSelectors(rules, client, actor);
      // The project-bounded half of the same closure, on the same client so
      // that the row lock it takes is held until this version commits — being
      // in one transaction is not on its own a guard against a concurrent
      // delete (round-1 review F3), and the lock lives in the validator.
      await assertProjectBoundedSelectors(rules, client);
      // Serialize version numbering per profile.
      await client.query('SELECT id FROM access_profiles WHERE id = $1 FOR UPDATE', [profileId]);
      const next = await client.query(
        'SELECT COALESCE(MAX(version_number), 0) + 1 AS n FROM access_profile_versions WHERE profile_id = $1',
        [profileId],
      );
      const versionNumber = Number(next.rows[0].n);
      const version = await client.query(
        `INSERT INTO access_profile_versions (profile_id, version_number, created_by_principal_id)
         VALUES ($1, $2, $3) RETURNING *`,
        [profileId, versionNumber, actor.principalId ?? null],
      );
      const versionId = version.rows[0].id as string;
      for (const rule of rules) {
        await client.query(
          `INSERT INTO access_profile_rules (version_id, resource_type, selector_form, selector_ids, verbs)
           VALUES ($1, $2, $3, $4::uuid[], $5::text[])`,
          [versionId, rule.resourceType, rule.selectorForm, rule.selectorIds, rule.verbs],
        );
      }
      await writeEvent(client, {
        profileId, versionId, action: 'version.created', actor,
        metadata: { versionNumber, ruleCount: rules.length },
      });
      await client.query('COMMIT');
      return {
        id: versionId, profileId, versionNumber,
        createdByPrincipalId: actor.principalId ?? null,
        createdAt: version.rows[0].created_at, rules,
      };
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
  }

  /** Transactional publish-swap: the pointer moves to the named version in
   * ONE update; a failed publish leaves the prior version fully in force.
   * The pointer only moves FORWARD (§4): restoring older authority is
   * republishing that content as a NEW version, so history never rewrites. */
  async publish(profileId: string, versionIdInput: unknown, actor: AuditActor): Promise<ProfileRecord> {
    requireUuid(profileId, 'INVALID_PROFILE_ID', 'profile id');
    const versionId = requireUuid(versionIdInput, 'INVALID_PROFILE_VALUE', 'versionId');
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const profile = await client.query(
        'SELECT id, published_version_id FROM access_profiles WHERE id = $1 FOR UPDATE', [profileId]);
      if (profile.rows.length === 0) throw err(404, 'PROFILE_NOT_FOUND', 'No such access profile');
      const version = await client.query(
        'SELECT id, profile_id, version_number FROM access_profile_versions WHERE id = $1', [versionId]);
      if (version.rows.length === 0 || version.rows[0].profile_id !== profileId) {
        throw err(422, 'VERSION_NOT_FOUND', 'versionId names no version of this profile', 'versionId');
      }
      const current = profile.rows[0].published_version_id as string | null;
      if (current) {
        const currentNumber = await client.query(
          'SELECT version_number FROM access_profile_versions WHERE id = $1', [current]);
        if (Number(version.rows[0].version_number) <= Number(currentNumber.rows[0].version_number)) {
          throw err(409, 'ROLLBACK_IS_REPUBLISH',
            'The published pointer only moves forward: republish the prior content as a NEW version to roll back (§4)');
        }
      }
      await client.query(
        'UPDATE access_profiles SET published_version_id = $1, updated_at = NOW() WHERE id = $2',
        [versionId, profileId],
      );
      await writeEvent(client, {
        profileId, versionId, action: 'profile.published', actor,
        metadata: { versionNumber: Number(version.rows[0].version_number), previousVersionId: current },
      });
      await auditService.record({
        action: 'profile.publish', actor, resourceType: 'access_profile', resourceId: profileId,
        metadata: { versionId, versionNumber: Number(version.rows[0].version_number) },
      }, client);
      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
    return this.get(profileId);
  }

  async assignments(profileId: string): Promise<ProfileAssignmentRecord[]> {
    await this.get(profileId);
    const result = await pool.query(
      'SELECT * FROM access_profile_assignments WHERE profile_id = $1 ORDER BY created_at ASC, id ASC',
      [profileId],
    );
    return result.rows.map(mapAssignment);
  }

  /** Assign the profile. Refusals (all typed, fail closed):
   *  - unpublished profile (T35: a draft may not be assigned);
   *  - unknown assignee;
   *  - agent-kind or PARENTED principal (the AZ-S2 sequencing guard —
   *    Connectors and Agents become assignable when AZ-S3's cap machinery
   *    lands);
   *  - inactive principal assignee. */
  async assign(
    profileId: string,
    input: { assigneeType?: unknown; assigneeId?: unknown },
    actor: AuditActor,
  ): Promise<ProfileAssignmentRecord> {
    const profile = await this.get(profileId);
    if (!profile.publishedVersionId) {
      throw err(409, 'PROFILE_UNPUBLISHED', 'An unpublished profile may not be assigned (it would carry empty authority)');
    }
    const assigneeType = input.assigneeType === undefined ? 'principal' : input.assigneeType;
    if (assigneeType !== 'principal' && assigneeType !== 'group') {
      throw err(422, 'INVALID_PROFILE_VALUE', "assigneeType must be 'principal' or 'group'", 'assigneeType');
    }
    const assigneeId = requireUuid(input.assigneeId, 'INVALID_PROFILE_VALUE', 'assigneeId');
    if (assigneeType === 'principal') {
      const principal = await pool.query(
        'SELECT id, kind, status, parent_principal_id, legacy_identity FROM principals WHERE id = $1', [assigneeId]);
      if (principal.rows.length === 0) {
        throw err(422, 'ASSIGNEE_NOT_FOUND', 'assigneeId resolves to no principal', 'assigneeId');
      }
      const row = principal.rows[0];
      // AZ-S3 lifted the S2 sequencing guard (§4, review 94aad5aa B1):
      // Connectors and Agents are valid assignees within the §5 caps — a
      // profile assigned to a delegated identity contributes to its OWN
      // side and stays intersected with the parent chain live, so
      // assignment can never escalate past the parent's authority.
      if (row.kind === 'agent' && !row.parent_principal_id && !row.legacy_identity) {
        throw err(422, 'ASSIGNEE_NOT_ACCOUNT', 'a parentless agent-kind principal is not a valid identity shape (A17.3)', 'assigneeId');
      }
      if (row.status !== 'active') {
        throw err(422, 'ASSIGNEE_DISABLED', 'profiles cannot be assigned to a disabled principal', 'assigneeId');
      }
      if (row.legacy_identity) {
        // T37 (§10): legacy identities are frozen out; the refusal is audited.
        await auditService.record({
          action: 'legacy.refused', actor, outcome: 'denied',
          resourceType: 'principal', resourceId: assigneeId,
          metadata: { act: 'profile.assign', profileId },
        });
        throw err(409, 'LEGACY_FROZEN', 'legacy identities are frozen out of profile assignment (§10, T37)', 'assigneeId');
      }
      if (row.kind === 'agent') {
        // T36 (review ab857740 B3): the server REFUSES an assignment that
        // would record cross-bound task write authority on an Agent — the
        // SQL final cap already makes it inert, but the MUTATION itself
        // must reject, audited. Any task write/admin rule whose selector
        // can cover a task other than the bound one refuses:
        // all-of-type/all-except are open by construction; exact must be
        // a subset of {boundTaskId}.
        const boundRow = await pool.query('SELECT bound_task_id FROM principals WHERE id = $1', [assigneeId]);
        const boundTaskId = boundRow.rows[0]?.bound_task_id ? String(boundRow.rows[0].bound_task_id) : null;
        const published = await pool.query(
          `SELECT apr.selector_form, apr.selector_ids, apr.verbs
             FROM access_profiles ap
             JOIN access_profile_rules apr ON apr.version_id = ap.published_version_id
            WHERE ap.id = $1 AND apr.resource_type = 'task'`,
          [profileId],
        );
        const WRITE_CLASS = new Set(['write', 'admin']);
        const crossBound = published.rows.some((rule) => {
          const verbs: string[] = rule.verbs ?? [];
          if (!verbs.some((verb) => WRITE_CLASS.has(verb))) return false;
          if (rule.selector_form !== 'exact') return true;
          const ids: string[] = rule.selector_ids ?? [];
          return !boundTaskId || ids.some((id) => id !== boundTaskId);
        });
        if (crossBound) {
          await auditService.record({
            action: 'profile.assign', actor, outcome: 'denied',
            resourceType: 'access_profile', resourceId: profileId,
            metadata: { assigneeId, refusal: 'ASSIGNMENT_CROSS_BOUND', boundTaskId },
          });
          throw err(422, 'ASSIGNMENT_CROSS_BOUND',
            'An Agent assignment may not carry task write authority beyond its bound task (§8.2/T36): use exact selectors within the bound task', 'assigneeId');
        }
      }
    } else {
      const group = await pool.query('SELECT id FROM groups WHERE id = $1', [assigneeId]);
      if (group.rows.length === 0) {
        throw err(422, 'ASSIGNEE_NOT_FOUND', 'assigneeId resolves to no group', 'assigneeId');
      }
    }
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const result = await client.query(
        `INSERT INTO access_profile_assignments (profile_id, assignee_type, assignee_id, assigned_by_principal_id)
         VALUES ($1, $2, $3, $4) RETURNING *`,
        [profileId, assigneeType, assigneeId, actor.principalId ?? null],
      );
      const assignment = mapAssignment(result.rows[0]);
      await writeEvent(client, {
        profileId, action: 'profile.assigned', actor,
        metadata: { assignmentId: assignment.id, assigneeType, assigneeId },
      });
      await auditService.record({
        action: 'profile.assign', actor, resourceType: 'access_profile', resourceId: profileId,
        metadata: { assigneeType, assigneeId },
      }, client);
      await client.query('COMMIT');
      return assignment;
    } catch (e) {
      await client.query('ROLLBACK');
      if (e instanceof Error && e.message.includes('duplicate key')) {
        throw err(409, 'ASSIGNMENT_EXISTS', 'That assignee already holds this profile');
      }
      throw e;
    } finally {
      client.release();
    }
  }

  /** Unassignment is one delete, effective on the next request (AZ-4).
   *
   * RH-P3.AZ-S7 (ruling 7440b579 R1, owner default D4): an assignment row
   * that a warrant vehicle CREATED is not owner-plane configuration —
   * deleting it here would strip a live assignment of its access. It is
   * refused, naming the act that does remove it. An assignment the OWNER
   * made and a vehicle merely linked stays fully removable: the vehicle
   * never claimed it (created_by_vehicle = FALSE) and never deletes it. */
  async unassign(profileId: string, assignmentId: string, actor: AuditActor): Promise<void> {
    requireUuid(profileId, 'INVALID_PROFILE_ID', 'profile id');
    requireUuid(assignmentId, 'INVALID_PROFILE_VALUE', 'assignment id');
    const vehicleOwned = await pool.query(
      `SELECT 1 FROM access_vehicle_links
        WHERE target_kind = 'profile_assignment' AND target_id = $1 AND created_by_vehicle = TRUE LIMIT 1`,
      [assignmentId],
    );
    if (vehicleOwned.rows.length > 0) {
      await auditService.record({
        action: 'profile.unassign', actor, outcome: 'denied',
        resourceType: 'access_profile', resourceId: profileId,
        metadata: { refusal: 'PROFILE_CARRIES_ASSIGNMENT', assignmentId },
      });
      throw err(409, 'PROFILE_CARRIES_ASSIGNMENT',
        'this profile assignment carries an execution assignment\u2019s access (ruling 7440b579 R1) — remove it by unassigning the task, or by revoking the warrant that carries it');
    }
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const result = await client.query(
        'DELETE FROM access_profile_assignments WHERE id = $1 AND profile_id = $2 RETURNING assignee_type, assignee_id',
        [assignmentId, profileId],
      );
      if (result.rows.length === 0) {
        throw err(404, 'ASSIGNMENT_NOT_FOUND', 'No such assignment on this profile');
      }
      await writeEvent(client, {
        profileId, action: 'profile.unassigned', actor,
        metadata: { assignmentId, assigneeType: result.rows[0].assignee_type, assigneeId: result.rows[0].assignee_id },
      });
      await auditService.record({
        action: 'profile.unassign', actor, resourceType: 'access_profile', resourceId: profileId,
        metadata: { assignmentId, assigneeType: result.rows[0].assignee_type, assigneeId: result.rows[0].assignee_id },
      }, client);
      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
  }

  async events(profileId: string, limit = 100): Promise<any[]> {
    await this.get(profileId);
    const result = await pool.query(
      `SELECT * FROM access_profile_events WHERE profile_id = $1
       ORDER BY occurred_at DESC, id DESC LIMIT $2`,
      [profileId, Math.min(Math.max(limit, 1), 500)],
    );
    return result.rows.map((row) => ({
      id: row.id,
      occurredAt: row.occurred_at,
      profileId: row.profile_id,
      versionId: row.version_id ?? null,
      action: row.action,
      actorPrincipalId: row.actor_principal_id ?? null,
      actorHandle: row.actor_handle,
      metadata: row.metadata ?? {},
    }));
  }

  /**
   * THE PROFILE SEAM (AZ-4): the SQL-composable condition the shared
   * authorization predicate composes as its profile arm — assignments
   * joined through published_version_id (T14 by construction; an
   * unpublished profile contributes nothing — T35), rules matched by
   * selector form ('all-of-type' and 'all-except' are future-inclusive by
   * evaluating against the live resource id column), group assignees
   * resolved by the SAME active-member membership join as the group grant
   * arm (094). Point/list parity is structural: both paths compose THIS
   * text.
   */
  activeProfileCondition(paramOffset: number): {
    sql: string;
    bind: (principalId: string, resourceType: GrantResourceType, verb: GrantVerb) => unknown[];
  } {
    const p1 = `$${paramOffset}`;
    const p2 = `$${paramOffset + 1}`;
    const p3 = `$${paramOffset + 2}`;
    return {
      sql:
        `EXISTS (SELECT 1 FROM access_profile_assignments apa ` +
        `JOIN access_profiles ap ON ap.id = apa.profile_id AND ap.published_version_id IS NOT NULL ` +
        `JOIN access_profile_rules apr ON apr.version_id = ap.published_version_id ` +
        `WHERE ((apa.assignee_type = 'principal' AND apa.assignee_id = ${p1}) ` +
        `OR (apa.assignee_type = 'group' AND apa.assignee_id IN (` +
        `SELECT gm.group_id FROM group_members gm ` +
        `JOIN principals mp ON mp.id = gm.account_principal_id AND mp.status = 'active' ` +
        `WHERE gm.account_principal_id = ${p1}))) ` +
        `AND apr.resource_type = ${p2} AND ${p3} = ANY(apr.verbs) ` +
        // The three ratified selector forms are untouched for the eight object
        // types. For `surface` the evaluator honours `exact` ONLY (AZ-A5
        // clause 3, annex D3(b)): an `all-of-type` or `all-except` surface rule
        // inserted directly in SQL, bypassing `validateRules`, changes no
        // decision. The FOURTH form is closed the same way and one step
        // earlier: `<PROJECT_BOUNDED_ARM>` renders as the literal `FALSE` for
        // every resource shape that declares no project coordinate, so an
        // `all-in-project` row on those types changes no decision either.
        `AND ((apr.selector_form = 'all-of-type' AND apr.resource_type <> 'surface') ` +
        `OR (apr.selector_form = 'exact' AND <RESOURCE_ID_COLUMN> = ANY(apr.selector_ids)) ` +
        `OR (apr.selector_form = 'all-except' AND apr.resource_type <> 'surface' ` +
        `AND NOT (<RESOURCE_ID_COLUMN> = ANY(apr.selector_ids))) ` +
        `OR <PROJECT_BOUNDED_ARM>))`,
      bind: (principalId, resourceType, verb) => [principalId, resourceType, verb],
    };
  }

  /**
   * Effective-access preview (§9.5, AZ-4: "the same evaluator on demand"):
   * the object-authority sources for one principal — direct grants, group
   * grants, and published profile rules reached directly or through group
   * assignment. Scope ceilings and role are the ROUTE plane and are not
   * repeated here.
   */
  async effectiveAccess(principalId: string): Promise<{
    principalId: string;
    grants: Array<Record<string, unknown>>;
    profiles: Array<Record<string, unknown>>;
  }> {
    requireUuid(principalId, 'INVALID_PROFILE_VALUE', 'principalId');
    const grants = await pool.query(
      `SELECT g.id, g.grantee_type, g.grantee_id, g.resource_type, g.resource_id, g.verb, g.expires_at,
              gr.name AS group_name
         FROM grants g
         LEFT JOIN groups gr ON gr.id = g.grantee_id AND g.grantee_type = 'group'
        WHERE ((g.grantee_type = 'principal' AND g.grantee_id = $1)
           OR (g.grantee_type = 'group' AND g.grantee_id IN (
                SELECT gm.group_id FROM group_members gm
                  JOIN principals mp ON mp.id = gm.account_principal_id AND mp.status = 'active'
                 WHERE gm.account_principal_id = $1)))
          AND (g.expires_at IS NULL OR g.expires_at > NOW())
        ORDER BY g.resource_type, g.verb`,
      [principalId],
    );
    const profiles = await pool.query(
      `SELECT ap.id AS profile_id, ap.name, ap.published_version_id, v.version_number,
              apa.assignee_type, apa.assignee_id, gr.name AS group_name,
              apr.resource_type, apr.selector_form, apr.selector_ids, apr.verbs
         FROM access_profile_assignments apa
         JOIN access_profiles ap ON ap.id = apa.profile_id AND ap.published_version_id IS NOT NULL
         JOIN access_profile_versions v ON v.id = ap.published_version_id
         JOIN access_profile_rules apr ON apr.version_id = ap.published_version_id
         LEFT JOIN groups gr ON gr.id = apa.assignee_id AND apa.assignee_type = 'group'
        WHERE ((apa.assignee_type = 'principal' AND apa.assignee_id = $1)
           OR (apa.assignee_type = 'group' AND apa.assignee_id IN (
                SELECT gm.group_id FROM group_members gm
                  JOIN principals mp ON mp.id = gm.account_principal_id AND mp.status = 'active'
                 WHERE gm.account_principal_id = $1)))
        ORDER BY ap.name, apr.resource_type`,
      [principalId],
    );
    return {
      principalId,
      grants: grants.rows.map((row) => ({
        grantId: row.id,
        source: row.grantee_type === 'principal' ? 'grant' : 'group-grant',
        groupId: row.grantee_type === 'group' ? row.grantee_id : null,
        groupName: row.group_name ?? null,
        resourceType: row.resource_type,
        resourceId: row.resource_id ?? null,
        verb: row.verb,
        expiresAt: row.expires_at ?? null,
      })),
      profiles: profiles.rows.map((row) => ({
        profileId: row.profile_id,
        profileName: row.name,
        publishedVersionId: row.published_version_id,
        versionNumber: Number(row.version_number),
        source: row.assignee_type === 'principal' ? 'profile' : 'group-profile',
        groupId: row.assignee_type === 'group' ? row.assignee_id : null,
        groupName: row.group_name ?? null,
        resourceType: row.resource_type,
        selectorForm: row.selector_form,
        selectorIds: row.selector_ids ?? [],
        verbs: row.verbs ?? [],
      })),
    };
  }
}

export const accessProfileService = new AccessProfileService();
