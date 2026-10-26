import { SUBTASK_ID_PATTERN, SUBTASK_ID_ERROR } from '../utils/taskIds';
import { blueprintPaths } from './blueprints';
/**
 * OpenAPI 3.0 spec for RelayHall's core API surface (task 3c7da35b).
 * Hand-maintained next to the code it describes; served at GET /openapi.json.
 * Coverage: the endpoints agents and integrations actually use. Anything not
 * listed here is internal/unstable — check the route source before relying on it.
 */

import { routeTransportClassFor } from '../utils/transportMap';
import { IDEMPOTENT_OPERATIONS, IdempotentOperation } from '../middleware/idempotency';
import { RELAYHALL_VERSION } from '../version';

/**
 * Card fb06c930 — the retry contract, published rather than described twice.
 *
 * The header parameter and the five error codes are injected into exactly the
 * operations the middleware is mounted on, DERIVED from the one declaration
 * table in `middleware/idempotency.ts`. A hand-copied list in this file would
 * be a second source of truth to be found wrong; the exhaustiveness assertion
 * below turns an undeclared or unmapped operation into a build failure.
 */
const IDEMPOTENT_OPENAPI_MOUNTS: Record<IdempotentOperation, readonly [string, string]> = {
  'task.report.save': ['/tasks/{id}/reports', 'post'],
  'task.create': ['/tasks', 'post'],
  'task.patch': ['/tasks/{id}', 'patch'],
  'task.note.append': ['/tasks/{id}/notes', 'post'],
  'task.stream.append': ['/tasks/{id}/stream', 'post'],
  'task.reference.create': ['/tasks/{id}/references', 'post'],
  'report.create': ['/reports', 'post'],
  'project.create': ['/projects', 'post'],
  'project.resource.create': ['/projects/{id}/resources', 'post'],
  'phase.create': ['/phases', 'post'],
  'agent.mint.request': ['/delegation/agent-mints', 'post'],
  'agent.mint.collect': ['/delegation/agent-mints/{approvalId}/collect', 'post'],
  'knowledge.note.commit': ['/knowledge-writes/commit', 'post'],
  // The Group-owned create shape of POST /projects (AZ-A12 clause 10(b)): its
  // own credential-scoped operation on the same documented path.
  'project.groupowned.create': ['/projects', 'post'],
  'knowledge.sharedwriter.add': ['/knowledge-shared-writers', 'post'],
  'knowledge.sharedwriter.remove': ['/knowledge-shared-writers/remove', 'post'],
  'task.subtask.create': ['/tasks/{id}/subtasks', 'post'],
  'task.subtask.reorder': ['/tasks/{id}/subtasks/reorder', 'post'],
  'task.subtask.text': ['/tasks/{id}/subtasks/by-id/{subtaskId}/text', 'patch'],
  // Card bedf50cc (plugin availability and settings, E380).
  'plugin.settings.account.put': ['/plugin-host/{name}/settings/account', 'put'],
  'plugin.choice.put': ['/plugin-host/{name}/choice', 'put'],
  'plugin.policy.put': ['/plugin-admin/{name}/policy', 'put'],
  'plugin.settings.deployment.put': ['/plugin-admin/{name}/settings', 'put'],
  'plugin.settings.cleanup': ['/plugin-admin/{name}/settings/cleanup', 'post'],
};

const RETRY_HEADER_PARAMETER = {
  name: 'Idempotency-Key', in: 'header', required: false,
  schema: { type: 'string', minLength: 16, maxLength: 128 },
  description: 'OPTIONAL over REST, REQUIRED on the MCP tool surface. Send the same 16-128 character value on every retry of the same call: the first answer is stored and returned again byte-for-byte under Retry-Replayed: true, with Retry-Request-Id naming the committed act. Without it a retried create is a second create. Agent minting never returns a stored answer (see 409 below).',
};

const RETRY_RESPONSES: Record<string, string> = {
  '400': 'IDEMPOTENCY_KEY_INVALID (not 16-128 characters) / IDEMPOTENCY_SCOPE_UNAVAILABLE (no identity to scope the token to)',
  '409': 'IDEMPOTENCY_KEY_REUSED (same token, different request) / IDEMPOTENCY_KEY_IN_FLIGHT (the first call is still running) / IDEMPOTENCY_REPLAY_UNAVAILABLE (agent minting: committed under that token, and the one-time pack is never stored; Task Report saves: committed under that token and never repeated, recovered through GET /tasks/{id}/report-operations/{key}?requestHash= named in the refusal)',
};

function applyRetryContract(paths: Record<string, Record<string, unknown>>): void {
  const declared = Object.keys(IDEMPOTENT_OPERATIONS).sort();
  const mapped = Object.keys(IDEMPOTENT_OPENAPI_MOUNTS).sort();
  if (declared.join('|') !== mapped.join('|')) {
    throw new Error('openapi: the retry-contract mount map and the operation declaration table disagree');
  }
  const documented = new Set<string>();
  for (const [path, method] of Object.values(IDEMPOTENT_OPENAPI_MOUNTS)) {
    // Two operations may share one documented route (POST /projects: the plain
    // and the Group-owned create); the header and the codes are added once.
    if (documented.has(`${method} ${path}`)) continue;
    documented.add(`${method} ${path}`);
    const entry = paths[path];
    if (!entry) throw new Error(`openapi: retry-contract path ${path} is not documented`);
    const operation = entry[method] as { parameters?: unknown[]; responses?: Record<string, { description: string }> } | undefined;
    if (!operation) throw new Error(`openapi: retry-contract operation ${method.toUpperCase()} ${path} is not documented`);
    operation.parameters = [...(operation.parameters ?? []), path.endsWith('/reports') && path.startsWith('/tasks/') ? { ...RETRY_HEADER_PARAMETER, required:true, description: 'Required logical save key at REST, MCP and CLI. A committed replay is refused. Unknown create outcome requires exact read reconciliation, never blind retry.' } : RETRY_HEADER_PARAMETER];
    const responses = operation.responses ?? (operation.responses = {});
    for (const [status, text] of Object.entries(RETRY_RESPONSES)) {
      responses[status] = responses[status]
        ? { ...responses[status], description: `${responses[status].description} / ${text}` }
        : { description: text };
    }
  }
}

const errorEnvelope = {
  type: 'object',
  properties: {
    success: { type: 'boolean', enum: [false] },
    error: { type: 'string' },
    code: { type: 'string' },
    message: { type: 'string' },
    suggestion: { type: 'string' },
    details: {},
  },
  required: ['success', 'code', 'message'],
};

const reportHandover = {
  type: 'object',
  description: 'Optional normalized machine-readable Report handover. Missing categories normalize to empty arrays.',
  properties: {
    schema_version: { type: 'integer', enum: [1], default: 1 },
    decisions: { type: 'array', maxItems: 50, items: { type: 'string', minLength: 1, maxLength: 2000 } },
    assumptions: { type: 'array', maxItems: 50, items: { type: 'string', minLength: 1, maxLength: 2000 } },
    alternatives_rejected: { type: 'array', maxItems: 50, items: { type: 'string', minLength: 1, maxLength: 2000 } },
    unresolved_questions: { type: 'array', maxItems: 50, items: { type: 'string', minLength: 1, maxLength: 2000 } },
  },
  additionalProperties: false,
};

const reportWriteProperties = {
  title: { type: 'string', maxLength: 500 },
  content: { type: 'string' },
  summary: { type: 'string', nullable: true, maxLength: 500 },
  tags: { type: 'array', items: { type: 'string' } },
  project_id: { type: 'string', format: 'uuid', nullable: true },
  task_ids: { type: 'array', items: { type: 'string', format: 'uuid' } },
  author: { type: 'string', maxLength: 100, description: 'Unverified display label.' },
  visibility: { type: 'string', pattern: '^[a-z0-9_-]{1,32}$' },
  handover: { ...reportHandover, nullable: true },
  pinned: { type: 'boolean' },
};

const reportCreateBody = {
  type: 'object',
  properties: reportWriteProperties,
  required: ['title', 'content'],
};

const reportPatchBody = {
  type: 'object',
  properties: reportWriteProperties,
};

// Canonical typed Project Resource (task 47ef04a2; contract c1895aa8).
// Values are quoted untrusted data: URLs and paths are facts and grant no
// filesystem, network, checkout, deployment or publication authority.
const repositoryDetails = {
  type: 'object',
  properties: {
    url: { type: 'string', description: 'Git URL (https, ssh or SCP-like). Embedded credentials are rejected.' },
    role: { type: 'string', enum: ['primary', 'additional'] },
    defaultBranch: { type: 'string', nullable: true },
  },
  required: ['url'],
  additionalProperties: false,
};

const environmentDetails = {
  type: 'object',
  properties: {
    url: { type: 'string', description: 'Absolute http/https URL without user-info.' },
    stage: { type: 'string', enum: ['development', 'test', 'staging', 'production', 'other'] },
  },
  required: ['url', 'stage'],
  additionalProperties: false,
};

const workspaceDetails = {
  type: 'object',
  properties: {
    path: { type: 'string', description: 'Absolute installation-local path. No traversal segments.' },
    purpose: { type: 'string', enum: ['source', 'build', 'data', 'backup', 'other'] },
  },
  required: ['path', 'purpose'],
  additionalProperties: false,
};

const referenceDetails = {
  type: 'object',
  properties: {
    url: { type: 'string', description: 'Absolute http/https URL without user-info.' },
    category: { type: 'string', enum: ['documentation', 'research', 'tool', 'other'] },
  },
  required: ['url', 'category'],
  additionalProperties: false,
};

const projectResource = {
  type: 'object',
  properties: {
    id: { type: 'string', format: 'uuid' },
    projectId: { type: 'string', format: 'uuid' },
    kind: { type: 'string', enum: ['repository', 'environment', 'workspace', 'reference'] },
    name: { type: 'string', minLength: 1, maxLength: 120 },
    description: { type: 'string', nullable: true, maxLength: 1000 },
    state: { type: 'string', enum: ['active', 'archived'] },
    agentVisibility: { type: 'string', enum: ['hidden', 'available'], description: 'Default hidden.' },
    exportPolicy: { type: 'string', enum: ['installation-only', 'portable'], description: 'Default installation-only. Workspace is always installation-only.' },
    details: {
      oneOf: [
        { $ref: '#/components/schemas/RepositoryDetails' },
        { $ref: '#/components/schemas/EnvironmentDetails' },
        { $ref: '#/components/schemas/WorkspaceDetails' },
        { $ref: '#/components/schemas/ReferenceDetails' },
      ],
    },
    revision: { type: 'string', description: 'Opaque; send back via If-Match on mutation.' },
    createdAt: { type: 'string', format: 'date-time' },
    updatedAt: { type: 'string', format: 'date-time' },
    archivedAt: { type: 'string', format: 'date-time', nullable: true },
  },
  required: ['id', 'projectId', 'kind', 'name', 'state', 'agentVisibility', 'exportPolicy', 'details', 'revision'],
};

// Discriminated write body (review 6fd3b9e0 finding 5): one variant per kind,
// each pinning its exact details schema, so cross-kind combinations are
// inexpressible in the schema itself.
function resourceWriteVariant(kind: string, detailsRef: string, extra: Record<string, unknown> = {}) {
  return {
    type: 'object',
    properties: {
      kind: { type: 'string', enum: [kind] },
      name: { type: 'string', minLength: 1, maxLength: 120 },
      description: { type: 'string', nullable: true, maxLength: 1000 },
      agentVisibility: { type: 'string', enum: ['hidden', 'available'] },
      exportPolicy: { type: 'string', enum: ['installation-only', 'portable'] },
      details: { $ref: detailsRef },
      ...extra,
    },
    required: ['kind', 'name', 'details'],
    additionalProperties: false,
  };
}

const resourceWriteBody = {
  oneOf: [
    resourceWriteVariant('repository', '#/components/schemas/RepositoryDetails'),
    resourceWriteVariant('environment', '#/components/schemas/EnvironmentDetails'),
    {
      ...resourceWriteVariant('workspace', '#/components/schemas/WorkspaceDetails'),
      properties: {
        ...resourceWriteVariant('workspace', '#/components/schemas/WorkspaceDetails').properties as Record<string, unknown>,
        exportPolicy: { type: 'string', enum: ['installation-only'], description: 'Workspace is always installation-only.' },
      },
    },
    resourceWriteVariant('reference', '#/components/schemas/ReferenceDetails'),
  ],
  discriminator: { propertyName: 'kind' },
};

// Canonical bounded Project record (review c99117a1 findings 1/7): ordinary
// reads expose exactly these fields; compatibility-held legacy bytes surface
// only as management counts via /projects/{id}/compatibility.
const project = {
  type: 'object',
  properties: {
    id: { type: 'string', format: 'uuid' },
    name: { type: 'string', minLength: 1, maxLength: 120 },
    description: { type: 'string', nullable: true, maxLength: 4000 },
    goal: { type: 'string', nullable: true, maxLength: 8192, description: "The project's outcome statement (RH-P2.4). A PROPERTY at two altitudes with the phase goal — never an object, page or table (vocabulary D-6)." },
    status: { type: 'string', enum: ['active', 'archived'] },
    ownerPrincipalId: { type: 'string', format: 'uuid', nullable: true, description: 'Explicit owner: a human Account or, since AZ-A12, a Group principal; or null. Creation records the creator; a Group owner is set only by the transfer act or the create form Group selector (root or an administrator login session with a step-up). Owner-derived authority remains bounded by current role and scopes.' },
    ownerKind: { type: 'string', enum: ['human', 'group'], nullable: true, description: "AZ-A12 clause 12: the owner's kind, joined server-side; null when there is no owner (or for a legacy owner of another kind)." },
    ownerDisplayName: { type: 'string', nullable: true, description: "AZ-A12 clause 12: the owner's name, joined server-side (a Group's name, else the person's display name, else the handle), so a client names a Group owner without listing Group principals; null when there is no owner." },
    inboxPhaseId: { type: 'string', format: 'uuid', nullable: true, description: "The Project's inbox phase (card b13e5ac9, migration 141): a Task created without an explicit phaseId lands there with status Ideas unless the request names a status; an explicit phaseId or status wins. null = no inbox phase, and creation behaves as before. The default is suspended while the Phase is archived or restricted." },
    defaultVerifierPrincipalId: { type: 'string', format: 'uuid', nullable: true, description: "The Project's default Verifier (card 41e24358, migration 155): a new Task inherits it when neither the request nor its landing Phase names one. Written only by PUT /projects/{id}/default-verifier; null = no default." },
    revision: { type: 'string', description: 'Opaque; send back via If-Match on mutation.' },
    is_hidden: { type: 'boolean' },
    created_at: { type: 'string', format: 'date-time' },
    updated_at: { type: 'string', format: 'date-time' },
  },
  required: ['id', 'name', 'description', 'goal', 'status', 'ownerPrincipalId', 'ownerKind', 'ownerDisplayName', 'inboxPhaseId', 'defaultVerifierPrincipalId', 'revision', 'is_hidden', 'created_at', 'updated_at'],
  additionalProperties: false,
};

// List items may carry an aggregate `stats` object when includeStats=true;
// stats is derived read-only data, not part of the canonical record.
const projectListItem = {
  type: 'object',
  properties: {
    ...(project.properties as Record<string, unknown>),
    stats: { type: 'object', nullable: true, description: 'Present only with includeStats=true; derived aggregate, shape unstable.' },
  },
  required: project.required,
  additionalProperties: false,
};

const projectCreateBody = {
  type: 'object',
  properties: {
    name: { type: 'string', minLength: 1, maxLength: 120, description: 'Non-blank after trimming; unique among active projects (case-insensitive).' },
    description: { type: 'string', nullable: true, maxLength: 4000 },
    goal: { type: 'string', nullable: true, maxLength: 8192 },
    status: { type: 'string', enum: ['active'] },
    is_hidden: { type: 'boolean' },
    ownerPrincipalId: { type: 'string', format: 'uuid', description: 'AZ-A12 clause 10(b): a Group to own the new Project, set in the same transaction as the creation. Sent with projectId and stepUpToken, all three or none. Root or an administrator login session only.' },
    projectId: { type: 'string', format: 'uuid', description: 'With ownerPrincipalId: the version-4 id the caller allocates for the new Project, so the step-up can be bound to (ownership.transfer, projectId) before the Project exists.' },
    stepUpToken: { type: 'string', description: 'With ownerPrincipalId: a single-use step-up bound to (ownership.transfer, projectId).' },
  },
  required: ['name'],
  additionalProperties: false,
};

const projectPatchBody = {
  type: 'object',
  properties: {
    name: { type: 'string', minLength: 1, maxLength: 120 },
    description: { type: 'string', nullable: true, maxLength: 4000 },
    goal: { type: 'string', nullable: true, maxLength: 8192, description: 'null or empty clears the goal.' },
    status: { type: 'string', enum: ['active'], description: 'archived is set only via POST /projects/{id}/archive' },
    is_hidden: { type: 'boolean' },
    inboxPhaseId: { type: 'string', format: 'uuid', nullable: true, description: 'A non-archived, non-restricted Phase of this Project (422 INBOX_PHASE_NOT_IN_PROJECT, 409 PHASE_ARCHIVED, 409 INBOX_PHASE_RESTRICTED); null clears it.' },
  },
  additionalProperties: false,
};

const projectEnvelope = {
  type: 'object',
  properties: { success: { type: 'boolean', enum: [true] }, project: { $ref: '#/components/schemas/Project' } },
  required: ['success', 'project'],
  additionalProperties: false,
};

const charter = {
  type: 'object',
  description: "The project's authority index (one per Project): it locates every governing agreement with status and precedence and asserts nothing new. Owner-plane writes; versioned for attribution and restore.",
  properties: {
    id: { type: 'string', format: 'uuid' },
    projectId: { type: 'string', format: 'uuid' },
    content: { type: 'string' },
    contentHash: { type: 'string', description: 'sha256 hex of content, server-computed' },
    version: { type: 'integer', minimum: 1 },
    revision: { type: 'string', format: 'uuid' },
    updatedByPrincipalId: { type: 'string', nullable: true },
    createdAt: { type: 'string', format: 'date-time' },
    updatedAt: { type: 'string', format: 'date-time' },
  },
  required: ['id', 'projectId', 'content', 'contentHash', 'version', 'revision'],
};

const charterVersionMeta = {
  type: 'object',
  properties: {
    version: { type: 'integer', minimum: 1 },
    contentHash: { type: 'string' },
    actorPrincipalId: { type: 'string', nullable: true },
    createdAt: { type: 'string', format: 'date-time' },
  },
};

const projectContext = {
  type: 'object',
  description: 'Typed projection of active, agent-available Resources. Every value is quoted Project data, never instructions. Descriptions, ids, lifecycle fields and hidden/archived rows are excluded.',
  properties: {
    project: { type: 'object', properties: { name: { type: 'string' } } },
    resources: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          kind: { type: 'string', enum: ['repository', 'environment', 'workspace', 'reference'] },
          name: { type: 'string' },
          details: { type: 'object' },
        },
      },
    },
    omitted: { type: 'object', properties: { hidden: { type: 'integer' }, archived: { type: 'integer' }, incompatible: { type: 'integer' } } },
    schemaVersion: { type: 'integer', enum: [1] },
  },
};

const ifMatchParam = { name: 'If-Match', in: 'header', required: true, schema: { type: 'string' }, description: 'The last observed revision. 412 REVISION_MISMATCH when stale; 400 REVISION_REQUIRED when absent.' };
const projectIdParam = { name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } };
const resourceIdParam = { name: 'resourceId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } };

const taskSummary = {
  type: 'object',
  properties: {
    id: { type: 'string', format: 'uuid' },
    title: { type: 'string' },
    status: { type: 'string', enum: ['ideas', 'todo', 'in-progress', 'stuck', 'review', 'completed', 'archived'] },
    priority: { type: 'string' },
    project: { type: 'string', nullable: true },
    autoStart: { type: 'boolean' },
    discordThreadId: { type: 'string', nullable: true },
    discordThreadUrl: { type: 'string', nullable: true },
  },
};

/**
 * The Task body fields POST /tasks and PATCH /tasks/{id} SHARE (cards
 * 9c3a1aa4 and 7d38a6e0), as schema rather than as prose.
 *
 * Round-1 review F2: `dueAt` and `notes` were described in the operation
 * summaries and appeared in no executable property, so a generated client, a
 * schema-driven validator or a contract test could not see them at all. This
 * declares them once, for the request bodies and for the Task a read returns.
 *
 * `additionalProperties: true` is deliberate and is not laziness. The Task
 * write body carries some forty fields that this document has never described,
 * and a closed schema here would silently declare every one of them invalid.
 * What this fragment claims is exactly what it knows: these two fields exist,
 * with these types, on these operations.
 */
const taskSharedWriteFields = {
  type: 'object',
  additionalProperties: true,
  properties: {
    notes: {
      type: 'string',
      nullable: true,
      description: 'Free text stored verbatim. null clears the column. A non-string answers 400 INVALID_TASK_NOTES. One validator serves POST /tasks, PATCH /tasks/{id} and PATCH /tasks/batch, so the three surfaces cannot disagree about it.',
    },
    dueAt: {
      nullable: true,
      description: 'When the Task is due. Accepted in TWO forms and always RETURNED as one: a UTC ISO-8601 instant at MICROSECOND precision, which is what the underlying timestamptz column keeps. The canonical form always carries six fractional-second digits, so 2026-09-07T17:00:00Z reads back as 2026-09-07T17:00:00.000000Z and one instant has one spelling. One to six fractional digits are accepted and round-trip exactly; SEVEN OR MORE answer 400 INVALID_DUE_AT_PRECISION rather than being rounded to something the caller did not name. An instant outside 0001-01-01T00:00:00Z..9999-12-31T23:59:59.999999Z - including one carried past either end by its own offset - answers 400 INVALID_DUE_AT_RANGE rather than being stored as a year the column cannot spell. null is NO DEADLINE, which is the ordinary state rather than a missing value. A PAST instant is accepted deliberately: the board records deadlines, it does not police them. A value that does not name a real instant - a bare calendar date, an impossible calendar day such as 2026-02-31, hour 24, or a leap second - answers 400 INVALID_DUE_AT.',
      oneOf: [
        {
          type: 'string',
          format: 'date-time',
          description: 'An ISO-8601 instant with a zone designator: 2026-09-07T17:00:00Z or 2026-09-07T19:00:00+02:00.',
        },
        {
          type: 'object',
          required: ['local', 'zone'],
          additionalProperties: false,
          properties: {
            local: { type: 'string', description: 'A local wall clock with NO zone designator: 2026-09-07T19:00:00, optionally with one to six fractional-second digits.' },
            zone: { type: 'string', description: 'The IANA timezone name to read that clock in, as a browser reports it from Intl.DateTimeFormat().resolvedOptions().timeZone. A name this server does not know answers 400 INVALID_DUE_AT_ZONE, without echoing the name back.' },
          },
          description: 'A local wall clock plus the zone to read it in. The SERVER resolves the pair against its own IANA timezone database - the one the column is stored with - and never the client: a wall clock inside a daylight-saving gap (or on a day a zone skipped, such as Pacific/Apia on 30 December 2011) names NO instant and answers 400 INVALID_DUE_AT_LOCAL_TIME naming the zone; one inside a backward clock change is resolved by PostgreSQL AT TIME ZONE using the post-transition offset, and the complete canonical instant and selected offset are reported as dueAtResolution.',
        },
      ],
    },
    roleGrantExpiresAt: {
      description: 'AZ-A10 clause 6: when the grant rows this execution assignment writes expire. Accepted ONLY beside a non-null executionProfile (otherwise 422 ROLE_GRANT_EXPIRY_WITHOUT_ASSIGNMENT) and never with executionWarrantId (422 ROLE_GRANT_EXPIRY_WITH_WARRANT). Omitted: the default, three months after the assignment. Any EARLIER or later future instant is admitted, set by whoever performs the assigning act (E62); \'unlimited\' means until the task or the assignment ends. A past instant, or now, answers 422 INVALID_EXPIRY and writes nothing. The instant forms and their 400 refusals follow dueAt, renamed: INVALID_ROLE_GRANT_EXPIRY (a bare date, null or garbage), INVALID_ROLE_GRANT_EXPIRY_PRECISION, INVALID_ROLE_GRANT_EXPIRY_RANGE, INVALID_ROLE_GRANT_EXPIRY_ZONE, INVALID_ROLE_GRANT_EXPIRY_LOCAL_TIME. The write response echoes the applied date as roleGrantExpiresAt (and roleGrantExpiryResolution for a { local, zone } value).',
      oneOf: [
        { type: 'string', format: 'date-time', description: 'An ISO-8601 instant with a zone designator.' },
        { type: 'string', enum: ['unlimited'], description: 'Until the task or the assignment ends.' },
        {
          type: 'object',
          required: ['local', 'zone'],
          additionalProperties: false,
          properties: { local: { type: 'string' }, zone: { type: 'string' } },
          description: 'A local wall clock and the IANA timezone to read it in, resolved by the server exactly as dueAt is.',
        },
      ],
    },
  },
};

/**
 * What the server did with a `{ local, zone }` deadline, echoed on the write
 * response. A wall clock that happens twice is resolved deterministically and
 * NOT in silence: the offset and native PostgreSQL policy are stated for
 * every zoned write. The receipt does not claim to detect ambiguity.
 */
const dueAtResolutionShape = {
  type: 'object',
  required: ['zone', 'local', 'instant', 'offset', 'offsetSeconds', 'chosen'],
  properties: {
    zone: { type: 'string', description: 'The zone as the server\'s timezone database spells it.' },
    local: { type: 'string', description: 'The wall clock that was resolved, at the column\'s precision.' },
    instant: { type: 'string', format: 'date-time', description: 'The instant that was stored.' },
    offset: { type: 'string', description: 'The offset that was used: +02:00, or +00:09:21 in a historical zone whose offset carries seconds.' },
    offsetSeconds: { type: 'integer' },
    chosen: { type: 'string', enum: ['postgresql'], description: 'PostgreSQL AT TIME ZONE policy: the post-transition offset for a backward clock change.' },
  },
};

/** The Task a read returns, to the extent this document describes it. */
const taskReadShape = {
  type: 'object',
  additionalProperties: true,
  properties: {
    reportMaintenanceAccess: {
      type: "object", readOnly: true, additionalProperties: false, required: ["allowed", "reason"],
      description: "GET /tasks/{id} caller-scoped, point-in-time display decision sharing the locked Task Report save policy: independent current claimant, in-progress status, live identity/delegation/credential/session, trusted and fresh Task WRITE and explicit delegated Task caps. Not a grant; save repeats checks under lock. Absent or error must disable maintenance. Service invoke is not a Task claim.",
      properties: {allowed: {type: "boolean"}, reason: {type: "string", nullable: true}},
    },
    id: { type: 'string', format: 'uuid' },
    title: { type: 'string' },
    notes: { type: 'string', nullable: true },
    dueAt: { type: 'string', format: 'date-time', nullable: true, description: 'The deadline as a UTC ISO-8601 instant with six fractional-second digits (microseconds, the precision the column keeps), or null for no deadline.' },
  },
};

const taskEnvelope = {
  type: 'object',
  properties: {
    success: { type: 'boolean' },
    task: { $ref: '#/components/schemas/TaskReadShape' },
    dueAtResolution: { $ref: '#/components/schemas/DueAtResolution' },
  },
};

const taskSharedWriteBody = {
  content: { 'application/json': { schema: { $ref: '#/components/schemas/TaskSharedWriteFields' } } },
};

const taskEnvelopeResponse = {
  content: { 'application/json': { schema: { $ref: '#/components/schemas/TaskEnvelope' } } },
};

function crudPath(summaryGet: string, summaryMutate?: string) {
  const p: Record<string, unknown> = {
    get: { summary: summaryGet, responses: { '200': { description: 'OK' } } },
  };
  if (summaryMutate) {
    p.post = { summary: summaryMutate, responses: { '201': { description: 'Created' }, '400': { description: 'Validation failed', content: { 'application/json': { schema: { $ref: '#/components/schemas/ApiError' } } } } } };
  }
  return p;
}

export function buildOpenApiSpec(): Record<string, unknown> {
  const spec: Record<string, unknown> = {
    openapi: '3.0.3',
    info: {
      title: 'RelayHall API',
      version: RELAYHALL_VERSION,
      description: 'Core RelayHall surface. Authenticated routes accept an Authorization Bearer value containing either a dashboard JWT or a scoped rh_ credential. '
        + 'Nginx strips the public /api prefix (public https://your-domain/api/tasks → backend /tasks). '
        + 'Errors are JSON objects; consult each operation response for its status contract.',
    },
    servers: [{ url: '/api' }],
    components: {
      securitySchemes: {
        bearer: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT or rh_ credential', description: 'Authorization: Bearer <dashboard JWT or scoped rh_ credential>' },
        apiKey: { type: 'apiKey', in: 'header', name: 'x-api-key', description: 'Legacy deployment-wide automation key from RELAYHALL_API_KEY. Scoped rh_ credentials use the Bearer scheme instead.' },
      },
      schemas: {
        ApiError: errorEnvelope,
        ReportHandover: reportHandover,
        ReportCreateBody: reportCreateBody,
        ReportPatchBody: reportPatchBody,
        TaskSummary: taskSummary,
        TaskSharedWriteFields: taskSharedWriteFields,
        TaskReadShape: taskReadShape,
        TaskEnvelope: taskEnvelope,
        DueAtResolution: dueAtResolutionShape,
        ProjectResource: projectResource,
        ResourceWriteBody: resourceWriteBody,
        RepositoryDetails: repositoryDetails,
        EnvironmentDetails: environmentDetails,
        WorkspaceDetails: workspaceDetails,
        ReferenceDetails: referenceDetails,
        ProjectContext: projectContext,
        Project: project,
        ProjectListItem: projectListItem,
        ProjectCreateBody: projectCreateBody,
        ProjectPatchBody: projectPatchBody,
        ProjectEnvelope: projectEnvelope,
        Charter: charter,
        CharterVersionMeta: charterVersionMeta,
      },
    },
    security: [{ bearer: [] }, { apiKey: [] }],
    paths: {
      '/health': { get: { summary: 'Liveness (no auth)', security: [], responses: { '200': { description: 'OK' } } } },
      '/tasks': {
        get: { summary: 'List tasks (filters: status, project, limit, owner, mine, unassigned)', parameters: [
          { name: 'status', in: 'query', schema: { type: 'string' } },
          { name: 'project', in: 'query', schema: { type: 'string' } },
          { name: 'limit', in: 'query', schema: { type: 'integer' } },
          { name: 'owner', in: 'query', schema: { type: 'string' }, description: 'Tasks whose Assignee is the principal with this handle' },
          { name: 'mine', in: 'query', schema: { type: 'boolean' }, description: 'Tasks whose Assignee is the caller\'s principal (empty when no principal resolved)' },
          { name: 'unassigned', in: 'query', schema: { type: 'boolean' }, description: 'Tasks with no Assignee' },
          { name: 'verifierUnusable', in: 'query', schema: { type: 'boolean' }, description: 'Card 41e24358: Tasks without a usable Verifier - none set, or one that is not active or is a Group, has a dead chain, lacks tasks:write, or is the Assignee. The same filter is accepted by /tasks/board, /tasks/ids, /tasks/aggregates and /tasks/graph. The morning census is this filter over todo and review.' },
        ], responses: { '200': { description: 'OK' }, '503': { description: 'Assignee filters unavailable (identity substrate not migrated)' } } },
        post: { summary: 'Create task (personality optional; autoStart defaults false). Card 41e24358: the new Task inherits a Verifier - the landing Phase default, else the Project default (verifierSource inherited-phase / inherited-project); verifierPrincipalId may name one of those defaults explicitly (verifierSource explicit) and anything else answers 422 VERIFIER_NOT_ALLOWED with no Task created; an inherited default that cannot judge the Task is left unset and reported in warnings[] as DEFAULT_VERIFIER_UNUSABLE, and a Task created in review without a usable Verifier carries VERIFIER_NOT_USABLE. Owner ruling E462 S4b (verification modes): `verificationNone: true` creates the Task with no verification - no Verifier (an inherited default is displaced and audited) and its finish completes it; only its Shepherd (the creator), an administrator or the Account may set it, never an Agent or the implementing chain; beside verifierPrincipalId it answers 422 VERIFICATION_NONE_WITH_VERIFIER, and outside To Do or Ideas 409 VERIFICATION_NONE_TASK_STARTED. `notes` is accepted and stored verbatim, validated by the same rule PATCH /tasks/{id} applies (a string, or null to leave the column empty) - a non-string answers 400 INVALID_TASK_NOTES. `dueAt` is when the Task is due, as an ISO-8601 instant (or null for no deadline, the ordinary state); a past instant is accepted deliberately - the board records deadlines, it does not police them - and anything that does not name an instant answers 400 INVALID_DUE_AT, and more than six fractional-second digits answers 400 INVALID_DUE_AT_PRECISION - the column keeps microseconds and nothing is silently rounded. executionProfile = { serviceId, descriptorVersion?, options, parameters? } validated against the pinned capability descriptor — targeting a service requires services:invoke; the retired mode/harness/accessProfile shape and executionMode answer 400 FIELD_RETIRED. A key that names a server-written Task column (the retry budget, review state and evidence, runtime linkage, timestamps, roles and ownership, the execution assignment, Blueprint provenance; listed in docs/api.md) answers 400 SERVER_WRITTEN_FIELD naming the key in details.field, and nothing is written; any other undocumented key is ignored.', requestBody: taskSharedWriteBody, responses: { '201': { description: 'Created', ...taskEnvelopeResponse }, '400': { description: 'Validation failed / SERVER_WRITTEN_FIELD / FIELD_RETIRED / INVALID_TASK_NOTES / INVALID_DUE_AT / INVALID_DUE_AT_PRECISION / INVALID_DUE_AT_RANGE / INVALID_DUE_AT_ZONE / INVALID_DUE_AT_LOCAL_TIME', content: { 'application/json': { schema: { $ref: '#/components/schemas/ApiError' } } } }, '403': { description: 'PROFILE_INVOKE_REQUIRED' }, '409': { description: 'PROFILE_DESCRIPTOR_RETIRED (pin a live version)' }, '422': { description: 'PROFILE_* validation failures naming the exact field / ROLE_GRANT_EXPIRY_WITHOUT_ASSIGNMENT / ROLE_GRANT_EXPIRY_WITH_WARRANT / INVALID_EXPIRY (roleGrantExpiresAt is not in the future; nothing is written)' } } },
      },
      '/tasks/{id}': {
        get: { summary: 'Get task (full UUID; includes discordThreadUrl and dueAt, the Task deadline as an ISO-8601 instant or null, and reportContext: the default page of GET /tasks/{id}/reports, summaries only)', parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }], responses: { '200': { description: 'OK', ...taskEnvelopeResponse }, '400': { description: 'INVALID_TASK_ID (8-char prefixes are CLI-only)' }, '404': { description: 'Not found' }, '409': { description: 'TASK_READ_BUSY: another transaction held the Task row for longer than the 2 s lock wait of the reportMaintenanceAccess projection; nothing was read or changed. Retry-After: 1; details.lockTimeoutMs.' } } },
        patch: { summary: 'Update task. Card 41e24358: a move into review without a usable Verifier answers 200 with the reason folded into warning and a warnings[] VERIFIER_NOT_USABLE element; it is never refused for that. `notes` is validated by the same rule POST /tasks applies (a string, or null to clear it); a non-string answers 400 INVALID_TASK_NOTES. `dueAt` follows the POST /tasks contract: an ISO-8601 instant, or null to clear the deadline; anything else answers 400 INVALID_DUE_AT. Implementers may hand off to review/stuck; only an independent Verifier may complete it, and only after every subtask is completed or skipped. executionProfile follows the POST /tasks contract (connector-first; null clears; targeting a service requires services:invoke). executionWarrantId: null without an executionProfile, on a Task whose assignment a Warrant carries, drops the Warrant and carries the assignment on an auto-grant, so it also requires services:invoke: without it the answer is 403 WARRANT_DROP_INVOKE_REQUIRED naming executionWarrantId, and nothing is written; on a Task no Warrant carries the null changes nothing. A key that names a server-written Task column answers 400 SERVER_WRITTEN_FIELD naming the key in details.field, and nothing is written; only the documented request fields reach the write, and any other key is ignored.', requestBody: taskSharedWriteBody, responses: { '200': { description: 'OK', ...taskEnvelopeResponse }, '400': { description: 'SERVER_WRITTEN_FIELD / INVALID_TASK_NOTES / INVALID_DUE_AT / INVALID_DUE_AT_PRECISION / INVALID_DUE_AT_RANGE / INVALID_DUE_AT_ZONE / INVALID_DUE_AT_LOCAL_TIME / INVALID_TASK_ID', content: { 'application/json': { schema: { $ref: '#/components/schemas/ApiError' } } } }, '403': { description: 'Caller lacks lifecycle authority / PROFILE_INVOKE_REQUIRED / WARRANT_DROP_INVOKE_REQUIRED' }, '409': { description: 'Completion blocked by unfinished subtasks / PROFILE_DESCRIPTOR_RETIRED / ROLE_GRANT_EXPIRY_TASK_TERMINAL (a completed or archived Task holds no assignment rows to date)' }, '422': { description: 'ROLE_GRANT_EXPIRY_WITHOUT_ASSIGNMENT / ROLE_GRANT_EXPIRY_WITH_WARRANT / INVALID_EXPIRY. roleGrantExpiresAt with the executionProfile the Task already carries re-dates the rows of that assignment in place.' } } },
        delete: { summary: 'Delete task', responses: { '400': { description: 'INVALID_TASK_ID: the path id is not a full Task UUID (8-char prefixes are CLI-only)' }, '200': { description: 'OK' } } },
      },
      '/tasks/operating-contract': {
        get: { summary: 'Generated Task operating contract and validation schema (single source for Brief/REST/CLI/MCP)', responses: { '200': { description: 'Compiled contract' } } },
      },
      '/tasks/{id}/stream': {
        get: { summary: 'Read the authorized Task Timeline stream; reported entries apply Task visibility intersected with the Outpost tier', responses: { '400': { description: 'INVALID_TASK_ID: the path id is not a full Task UUID (8-char prefixes are CLI-only)' }, '200': { description: 'Ordered entries' } } },
        post: { summary: 'Append an attributed immutable Task stream entry. More than 8192 characters auto-promotes to a caller-authored Report, or quarantines without failing when capacity is exhausted. dryRun validates without writing.', responses: { '201': { description: 'Appended' }, '400': { description: 'Rich field validation error / INVALID_TASK_ID' }, '403': { description: 'Reported provenance requires Service write authority' } } },
      },
      '/tasks/{id}/reports': {
        get: { summary: 'Bounded Report context of a Task: summaries only, never bodies. Default: the 5 newest authorized Reports, at most 3 pinned Reports not already listed, the authorized total, hasMore and a keyset nextCursor. A Report the caller cannot read is neither listed nor counted; associations alone confer no access. A summary of one of this Task\'s own progress Reports carries its contentHash (null for every other Report). Bodies: GET /reports/{id} (reports:read), or GET /tasks/{id}/reports/{reportId} for this Task\'s progress Reports (tasks:read).', parameters: [
          { name: 'scope', in: 'query', schema: { type: 'string', enum: ['linked', 'progress'] }, description: 'linked (default): every associated Report; progress: server-bound task progress Reports only' },
          { name: 'limit', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 50 }, description: 'Page size (default 5)' },
          { name: 'cursor', in: 'query', schema: { type: 'string' }, description: 'pagination.nextCursor of a previous page; stable when Reports are added. Not with offset.' },
          { name: 'offset', in: 'query', schema: { type: 'integer', minimum: 0 }, description: 'Positional alternative to cursor' },
          { name: 'pinned', in: 'query', schema: { type: 'boolean' }, description: 'Only pinned Reports' },
        ], responses: { '200': { description: 'OK — { success, taskId, scope, pinnedOnly, reports[], pinned{reports,total,returned,hasMore}, pagination{limit,offset,total,returned,hasMore,nextCursor}, retrieval }' }, '400': { description: 'INVALID_REPORT_CURSOR / INVALID_REPORT_PAGE / INVALID_REPORT_SCOPE (details.field) / INVALID_TASK_ID' } } },
        post: { summary: 'Current independent claimant creates or edits its own Task progress Report. Source/author/reference are server-written; editing requires expectedContentHash. Review freezes editing. Unknown create outcome must be reconciled by reading; never blindly retry.', responses: { '400': { description: 'INVALID_TASK_ID: the path id is not a full Task UUID (8-char prefixes are CLI-only)' }, '200': { description: 'Updated' }, '201': { description: 'Created' }, '403': { description: 'TASK_CLAIMANT_REQUIRED' }, '409': { description: 'TASK_REPORT_FROZEN / TASK_REPORT_CONFLICT' } } },
      },
      '/tasks/{id}/reports/{reportId}': {
        get: { summary: 'One of this Task\'s server-bound progress Reports in full, body and content_hash included (the row shape the save answers with), under Task read authority (tasks:read). The current claimant continues its progress Report from here: an edit needs content_hash as expectedContentHash. Only progress Reports of this Task that the caller may read are served (the same READ predicate the Report context counts with); any other Report\'s body is GET /reports/{id} (reports:read).', parameters: [
          { name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } },
          { name: 'reportId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } },
        ], responses: { '200': { description: 'OK — { success, taskId, report }' }, '400': { description: 'INVALID_TASK_ID / INVALID_REPORT_ID (details.field)' }, '404': { description: 'TASK_REPORT_NOT_FOUND: not a progress Report of this Task, or not readable to the caller' } } },
      },
      '/tasks/{id}/report-operations/{key}': { get: { summary: 'Read exact committed Task Report operation under fresh current claimant authority. Changed request/output hash refuses.', parameters:[{name:'requestHash',in:'query',required:true,schema:{type:'string',pattern:'^[a-f0-9]{64}$'}}],responses:{'200':{description:'Exact committed Report'},'404':{description:'No committed operation known; same-key save requires current WRITE authority'},'409':{description:'Logical input or saved output changed'}} } },
      '/tasks/{id}/finish': {
        post: { summary: 'Atomic finish: append Handover, create/link a Report, and transition in-progress -> review together or not at all. dryRun runs every check the real finish runs (Task role, Verifier separation, In Progress state, saved Task Report provenance, Subtasks, Report linkability, Handover promotion, native-generation gate) under the same Task lock, answers { valid, dryRun, targetStatus: review } or the same refusal, and writes nothing; finish takes no Idempotency-Key, so a dry run reserves none (card 19dd180c). Card 41e24358: when the Task reaches Review without a usable Verifier the 200 answer carries warning (text) and warnings[] {code: VERIFIER_NOT_USABLE, failedArm: none | principal | chain | scope | independence, verifierPrincipalId, message}; it is never refused for that. Owner ruling E462 S4b: on a Task with verification none the finish completes it instead (status completed, verification: none; a dry run reports targetStatus completed), completes Subtasks in Review and makes dependents ready; it answers 409 VERIFICATION_NONE_SELF_SET when the setter shares the implementing chain.', responses: { '200': { description: 'Handed over for review, or completed for verification none' }, '400': { description: 'Report or field validation failed / INVALID_TASK_ID' }, '403': { description: 'TASK_ROLE_REQUIRED: only the Task claimant or Shepherd may finish / CLAIMANT_VERIFIER_CONFLICT: the assigned Verifier never may' }, '409': { description: 'Task or Subtasks are not ready for handover' } } },
      },
      '/tasks/{id}/assignment-access': {
        get: { summary: 'RH-P3.AZ-S7 (ruling 7440b579 R5): what carries this Task assignment’s access — the Warrant if one does, and the grant / access-profile-assignment rows it depends on. Each row reports whether this machinery CREATED it: a row it did not create is one it will never delete (owner default D4), and the owner plane keeps full control of those. Read-only; the shared point predicate authorizes read on the Task first, so no new scope string.', parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }], responses: { '400': { description: 'INVALID_TASK_ID: the path id is not a full Task UUID (8-char prefixes are CLI-only)' }, '200': { description: 'OK — { success, assignment, links }. assignment.carriedBy is warrant | grant, or null when the Task is unassigned; each link reports createdByAssignment, which is what decides whether the assignment may ever remove that row. AZ-A10 clauses 6 and 8: each link also reports roleGrantExpiresAt (the date the assigning act of this Task set for it; null = until the task or the assignment ends, and always null for a Warrant), expiresAt (the effective date of the row: the latest over every Task linking it, or the own date of an owner-plane row) and expired (decided by the database clock).' }, '404': { description: 'TASK_NOT_FOUND' }, '503': { description: 'ASSIGNMENT_ACCESS_UNAVAILABLE' } } },
      },
      '/tasks/{id}/references': {
        get: { summary: 'List typed Task References (dependencies remain a separate relation)', responses: { '400': { description: 'INVALID_TASK_ID: the path id is not a full Task UUID (8-char prefixes are CLI-only)' }, '200': { description: 'References' } } },
        post: { summary: 'Create a typed sibling Reference. Base kinds are closed; namespaced plugin kinds degrade to inert rows. dryRun validates without writing.', responses: { '201': { description: 'Created' }, '400': { description: 'Rich field validation error / INVALID_TASK_ID' } } },
      },
      '/tasks/{id}/stream/{entryId}/redact': {
        post: { summary: 'Root-only licensed stream mutation: span, tombstone or author erasure with attributed keyed-HMAC audit and auto-promoted Report cascade. No CLI/MCP/agent surface.', responses: { '400': { description: 'INVALID_TASK_ID: the path id is not a full Task UUID (8-char prefixes are CLI-only)' }, '200': { description: 'Redacted' }, '403': { description: 'Root required' }, '409': { description: 'Entry already redacted' }, '503': { description: 'Owner-held HMAC key unavailable' } } },
      },
      '/tasks/{id}/account-owner': {
        get: { summary: 'Read effective and explicit Task account owner with exact updatedAt revision. Requires Task read authority.', responses: { '400': { description: 'INVALID_TASK_ID: the path id is not a full Task UUID (8-char prefixes are CLI-only)' }, '200': { description: 'Ownership state for conditional transfer', content: { 'application/json': { schema: {
          type: 'object', required: ['success', 'ownership'],
          properties: {
            success: { type: 'boolean' },
            ownership: {
              type: 'object',
              required: ['taskId', 'accountOwnerPrincipalId', 'explicitAccountOwnerPrincipalId', 'updatedAt', 'ownerKind', 'ownerDisplayName'],
              properties: {
                taskId: { type: 'string', format: 'uuid' },
                accountOwnerPrincipalId: { type: 'string', format: 'uuid', nullable: true, description: 'The EFFECTIVE account owner: the explicit one, else the Project owner.' },
                explicitAccountOwnerPrincipalId: { type: 'string', format: 'uuid', nullable: true },
                updatedAt: { type: 'string', description: 'Exact revision to send back as expectedUpdatedAt.' },
                ownerKind: { type: 'string', enum: ['human', 'group'], nullable: true, description: "AZ-A12 clause 12: the effective owner's kind, joined server-side; null without an owner." },
                ownerDisplayName: { type: 'string', nullable: true, description: "AZ-A12 clause 12: the effective owner's name (a Group's name, else display name, else handle); null without an owner." },
              },
            },
          },
        } } } }, '404': { description: 'Absent or concealed Task' } } },
        put: {
          summary: 'Audited conditional ownership transfer by current owner, appointed Main or qualified human administrator. Preserves Task roles, authorship, grants and review evidence. AZ-A12 clause 9: when the effective owner or the target is a Group, the act is a login-session act of root or an administrator (admin, operator, orchestrator) with a single-use step-up bound to (ownership.transfer, task id) sent as stepUpToken; refusals GROUP_OWNER_SESSION_ONLY (bearer, appointed Main, MCP), GROUP_OWNER_REQUIRES_ADMINISTRATOR and STEP_UP_REQUIRED (with the stepUp challenge) come before the token is spent and are audited. A Task act always names a target, so undoing a move into a Group writes the person as the explicit owner.',
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
          requestBody: { required: true, content: { 'application/json': { schema: {
            type: 'object', additionalProperties: false,
            required: ['accountOwnerPrincipalId', 'expectedAccountOwnerPrincipalId', 'expectedUpdatedAt', 'reason'],
            properties: {
              accountOwnerPrincipalId: { type: 'string', format: 'uuid' },
              expectedAccountOwnerPrincipalId: { type: 'string', format: 'uuid', nullable: true },
              expectedUpdatedAt: { type: 'string', description: 'Exact updatedAt from account-owner GET, without timestamp normalization' },
              reason: { type: 'string', minLength: 1, maxLength: 2000 },
              stepUpToken: { type: 'string', description: 'AZ-A12 clause 9(e): required when the effective owner or the target is a Group; a single-use step-up bound to (ownership.transfer, task id).' },
            },
          } } } },
          responses: { '400': { description: 'INVALID_TASK_ID: the path id is not a full Task UUID (8-char prefixes are CLI-only)' }, '200': { description: 'Ownership receipt; no independent verification implied' },
            '403': { description: 'Current account-owner authority required; for a Group source or target GROUP_OWNER_SESSION_ONLY / GROUP_OWNER_REQUIRES_ADMINISTRATOR / STEP_UP_REQUIRED (with stepUp)' }, '404': { description: 'Absent or concealed Task' },
            '409': { description: 'Archived Task must be restored first' }, '412': { description: 'Ownership or Task revision changed; read back before deciding on another transfer' },
            '422': { description: 'Invalid change, or target not an active human account or an active Group (INVALID_ACCOUNT_OWNER)' }, '503': { description: 'Transfer unavailable; transaction rolled back' } },
        },
      },
      '/tasks/{id}/account-owner/steward': {
        put: {
          summary: 'LENSES-c c1-B (card b5c83682; design delta C.6): the steward transfer of a Task account owner, gate (ii) and DD-5. Ceiling tasks:write (its scope rule is listed before the /tasks family rules); the gate in the handler is the DECIDER (the account-owner route decider and the appointed Main are never consulted). The current owner is the EFFECTIVE one, COALESCE(explicit, the Project owner). It admits exactly two shapes: (ii) OUT, a Task whose effective owner is an ACTIVE Group G moves to an active member of G - written as the explicit owner - by a caller holding a LIVE owner row on G; DD-5 IN, the effective person owner moves the Task into an active Group G in which they hold a LIVE owner row. Every other move is STEWARD_TRANSFER_SHAPE_REFUSED. Refusals, in order and before the step-up is spent, audited task.account_owner.change denied: GROUP_OWNER_SESSION_ONLY; GROUP_OWNER_ROLE_REQUIRED; NOT_THE_CURRENT_OWNER; TARGET_NOT_A_GROUP_MEMBER; INVALID_ACCOUNT_OWNER; TASK_ARCHIVED; ACCOUNT_OWNER_STATE_CHANGED; then STEP_UP_REQUIRED for a step-up bound to (ownership.transfer, task id). REST only, never MCP.',
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
          requestBody: { required: true, content: { 'application/json': { schema: {
            type: 'object', additionalProperties: false,
            required: ['accountOwnerPrincipalId', 'expectedAccountOwnerPrincipalId', 'expectedUpdatedAt', 'reason'],
            properties: {
              accountOwnerPrincipalId: { type: 'string', format: 'uuid', nullable: true },
              expectedAccountOwnerPrincipalId: { type: 'string', format: 'uuid', nullable: true },
              expectedUpdatedAt: { type: 'string', description: 'Exact updatedAt from account-owner GET' },
              reason: { type: 'string', minLength: 1, maxLength: 2000 },
              stepUpToken: { type: 'string', description: 'A single-use step-up bound to (ownership.transfer, task id).' },
            },
          } } } },
          responses: { '200': { description: 'Ownership receipt' }, '400': { description: 'INVALID_TASK_ID' },
            '403': { description: 'GROUP_OWNER_SESSION_ONLY / GROUP_OWNER_ROLE_REQUIRED / NOT_THE_CURRENT_OWNER / STEP_UP_REQUIRED (with stepUp)' }, '404': { description: 'Absent or concealed Task' },
            '409': { description: 'TASK_ARCHIVED' }, '412': { description: 'ACCOUNT_OWNER_STATE_CHANGED' },
            '422': { description: 'INVALID_ACCOUNT_OWNER_CHANGE / INVALID_ACCOUNT_OWNER / TARGET_NOT_A_GROUP_MEMBER / STEWARD_TRANSFER_SHAPE_REFUSED / INVALID_OWNER' }, '503': { description: 'ACCOUNT_OWNER_CHANGE_UNAVAILABLE' } },
        },
      },
      '/tasks/{id}/roles': {
        patch: {
          summary: 'Assign the server-controlled Shepherd and independent Verifier roles for a Task. The Assignee remains controlled by claim and release. Owner ruling E462 S4b: `verificationNone` (on its own) sets or clears verification mode none; set only by the Account-control path or the Shepherd/administrator authority outside the implementing chain, never an Agent, while the Task is To Do and has never started; a current Verifier is cleared and audited as displaced; assigning a Verifier clears none, and once cleared it cannot be set again.',
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  additionalProperties: false,
                  minProperties: 1,
                  properties: {
                    shepherdPrincipalId: { type: 'string', format: 'uuid' },
                    verifierPrincipalId: { type: 'string', format: 'uuid', nullable: true },
                    verificationNone: { type: 'boolean', description: 'Owner ruling E462 S4b: set (true) or clear (false) verification mode none; never beside another field.' },
                  },
                },
              },
            },
          },
          responses: {
            '400': { description: 'INVALID_TASK_ID: the path id is not a full Task UUID (8-char prefixes are CLI-only)' },
            '200': { description: 'Task roles assigned' },
            '403': { description: 'Shepherd or administrator authority required; assigning a Service Shepherd additionally requires services:invoke / VERIFICATION_NONE_AGENT / VERIFICATION_NONE_CHAIN_GUARDED / VERIFICATION_NONE_FORBIDDEN' },
            '404': { description: 'Task not found or concealed by authorization policy' },
            '409': { description: 'CLAIMANT_VERIFIER_CONFLICT / VERIFICATION_NONE_TASK_STARTED / VERIFICATION_NONE_CLEARED' },
            '422': { description: 'Invalid role field or unavailable Principal / INVALID_VERIFICATION_NONE / VERIFICATION_NONE_EXCLUSIVE' },
            '503': { description: 'Task-role substrate unavailable' },
          },
        },
      },
      '/tasks/batch': {
        patch: { summary: 'Batch update up to 100 tasks (fields: status, priority, project, autoStart, tags, notes, blockedReason); per-id results, partial success = 200', responses: { '200': { description: 'At least one succeeded' }, '422': { description: 'All failed' } } },
      },
      '/tasks/next': { get: { summary: 'Next auto-start todo task', responses: { '200': { description: 'OK' } } } },
      '/notification-endpoints': { get: { summary: 'List human notification endpoints (RH-P3.C8, §2.12). Subscription-class: the whole family sits behind the root sentinel and every mutation is audited.', responses: { '200': { description: 'OK' } } }, put: { summary: 'Upsert one (principal, kind) notification endpoint — webhook (ID-only dispatch) or email (configuration-only until a mail transport exists). Root sentinel; audited.', responses: { '200': { description: 'OK' } } } },
      // RH-KW1 candidate A (KNOWLEDGE-DESIGN 94747de9 §5.5). Candidate D
      // adds the two MCP tools and the remaining knowledge paths beside it.
      '/knowledge-sources': { get: { summary: "List the caller's QUERYABLE SET of knowledge sources — the §5.5 (a AND b AND c) predicate: knowledge-configured, visible under the shared predicate, and inside the caller's knowledge-contents:read selector. Requires knowledge-contents:read (vocabulary amendment A21). Sources failing any limb are undisclosed absolutely: absent with no marker, no count and no reason, so an empty result and an empty registry are indistinguishable. Owner-plane configuration — the dialed endpoints, the core credential reference, the allowed networks and the relevant groups — is never returned here.", responses: { '200': { description: 'OK (an empty array when the caller may query nothing)' }, '403': { description: 'knowledge-contents:read required' } } } },
      // KNOWLEDGE-DESIGN 94747de9 §7 (candidate C) shipped this route without an
      // entry here; card 40e0e542 adds it with the default-scope field
      // (selector amendment v1.2, owner ruling E127 (5)).
      '/knowledge-queries': { post: { summary: "Search the caller's queryable set of knowledge sources (§7). Requires knowledge-contents:read. Body: q (1-1024 characters), optional protocol_version 2, sources (at most 16 ids, narrowing only; ids the caller cannot query are ignored silently), kinds (code, docs, data; default all), limitPerSource (1-25, default 8), timeoutMs (500-8000, default 8000); with protocol_version 2 only: categories (hard category narrowing) and includeArchive. THE DEFAULT SCOPE is current knowledge: unless includeArchive is true, the core subtracts the archive categories each source declares (descriptor knowledgeSource.archiveCategories) from the categories it asks that source to search, and a source left with nothing current is skipped with reason categories. includeArchive is never sent to a source and grants nothing. Answers 200 whatever the sources do: coverage first (consulted and its five-outcome partition, truncatedResults, invalidResults, partialSources, skipped, searchedCategories per consulted source, archive.included), then groups of results with sealed handles, and auditRef.", requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['q'], properties: { protocol_version: { type: 'integer', enum: [2] }, q: { type: 'string', minLength: 1, maxLength: 1024 }, sources: { type: 'array', minItems: 1, maxItems: 16, items: { type: 'string', format: 'uuid' } }, kinds: { type: 'array', minItems: 1, maxItems: 3, items: { type: 'string', enum: ['code', 'docs', 'data'] } }, categories: { type: 'array', minItems: 1, maxItems: 32, items: { type: 'string', maxLength: 128, pattern: '^[a-z][a-z0-9-]*:[a-z][a-z0-9._-]*$' }, description: 'protocol_version 2 only' }, limitPerSource: { type: 'integer', minimum: 1, maximum: 25 }, timeoutMs: { type: 'integer', minimum: 500, maximum: 8000 }, includeArchive: { type: 'boolean', description: 'protocol_version 2 only. Also search the archive categories sources declare; default false (current knowledge only). Never sent to a source; grants nothing.' } } } } } }, responses: { '200': { description: 'success, protocol_version (v2), coverage {consulted, answered, timedOut, unavailable, refusedBySource, refusedByPolicy, truncatedResults, invalidResults, skipped, partialSources?, searchedCategories, archive}, groups, auditRef' }, '400': { description: 'INVALID_SELECTOR: a malformed v2 selector, an unknown v2 key, a category no visible source declares, a non-boolean includeArchive, or categories/includeArchive without protocol_version 2' }, '403': { description: 'knowledge-contents:read required' }, '422': { description: 'KNOWLEDGE_QUERY_INVALID / KNOWLEDGE_KINDS_INVALID / KNOWLEDGE_SOURCES_INVALID / KNOWLEDGE_LIMIT_INVALID / KNOWLEDGE_TIMEOUT_INVALID (the caller input), or SOURCE_SELECTION_TOO_BROAD with auditRef only (more than 16 eligible v2 sources)' } } } },
      // RB-11 Governor v0 (card b796067e; design C.12, answer E1). The three
      // write verbs, door relays to the registered source's write surface.
      '/knowledge-writes/propose': { post: { summary: "Propose a note for a registered knowledge source to write (RB-11 Governor v0, C.2/C.12). Requires knowledge-contents:write — a separate grant that knowledge-contents:read never satisfies. Body: title (1-200 characters), content (UTF-8, at most 32768 bytes, not opening with a '---' frontmatter block), optional source (omitted = the one write-capable source the caller's arms admit, else source_required), noteType, tags (at most 16), target ('default' | 'personal' | {compartmentId}), taskId, basis (at most 25 sealed handles), revisionOf (a sealed handle of the same source) and expectedRevision ('absent' or the sha256 read). The core attests the task context (the bound Task of an Agent, else a taskId the caller may read) into the signed write assertion, unseals the handles, relays the proposal and answers with the source's answer unchanged under result: the exact bytes it would write (content_base64, content_sha256 recomputed by the core), the resolved audience, proposal_id, preview_digest and expires_at. Nothing is written yet; the core stores no note content, only a fail-closed audit row (auditRef).", responses: { '200': { description: 'success, source, auditRef and result: the source proposal answer, unchanged' }, '400': { description: 'see 403' }, '403': { description: '400: content_invalid / revision_of_invalid / source_required / a handle token (handle_malformed, handle_tampered, handle_key_retired, handle_key_unknown, handle_version_unsupported); 403: refused (the uniform core refusal: no reason is given, it is recorded in the audit row) / source_not_write_capable / knowledge-contents:write missing (details.requiredScopes); 422: task_context_mismatch; 502: source_protocol_error; 503: unavailable (the audit row could not be written, so nothing was sent) / source_unavailable; 504: source_timed_out. The source refusal codes pass through with their status and refusedBy: source — assertion_invalid, target_not_writable, no_private_scope, audience_exceeds_basis, basis_unreadable, not_own_note, content_invalid, content_secret_suspect, egress_blocked, reserved_name (403); audience_changed, preview_mismatch, revision_conflict (409); proposal_expired (410); daily_cap (429); internal_error (500); commit_unverified (502, with a sealed handle); unavailable (503).' } } } },
      '/knowledge-writes/preview': { post: { summary: 'Re-resolve an open proposal (RB-11 Governor v0, C.2/C.7). Requires knowledge-contents:write. Body: proposalId, optional source. Only the principal that proposed may preview; the task context is re-attested from the proposal. Answers with the source answer unchanged: the same bytes and the audience re-resolved against current grants, with a new preview_digest when the audience changed.', responses: { '200': { description: 'success, source, auditRef and result: the source preview answer, unchanged' }, '403': { description: 'refused (uniform) / source_not_write_capable / the source refusal codes listed on /knowledge-writes/propose' } } } },
      // Card 549cc51f (owner rulings E298, E299, E310): the shared-area writer
      // list of a knowledge source. GET is a services:read disclosure; the two
      // POSTs are 'authenticated' with the in-handler gate (a root or an
      // administrator login session, step-up on every change).
      '/knowledge-shared-writers': {
        get: { summary: "The shared-area writer list of a knowledge source (card 549cc51f). Requires services:read. Query: optional source (a knowledge source id; omitted = the one write-configured knowledge source, else SHARED_WRITER_SOURCE_REQUIRED) and optional view=administration. Answers the source {id, slug, name}, scope 'organisation', writers [{accountId, label}] (every Account on the list) and youCanWrite (whether the caller's own Account is on the list, active and unexpired). view=administration adds, per row, addedBy {id, label}, addedAt, reason, expiresAt, approvalId, active and origin ('direct' in this release), and is answered only to a root or an administrator login session.", responses: { '200': { description: 'success, source, scope, writers, youCanWrite' }, '400': { description: 'SHARED_WRITER_INVALID (source is not a UUID, or view is not administration) / SHARED_WRITER_SOURCE_REQUIRED (more than one write-configured knowledge source and none named)' }, '403': { description: 'services:read missing / SHARED_WRITER_REQUIRES_SESSION or SHARED_WRITER_REQUIRES_ADMINISTRATOR (view=administration only)' }, '404': { description: 'SHARED_WRITER_SOURCE_NOT_FOUND (no such knowledge source, or none is write-configured)' } } },
        post: { summary: "Add an Account to a knowledge source's shared-area writer list (card 549cc51f). A LOGIN-SESSION act: root, or an administrator session (admin, operator, orchestrator); an rh_ bearer credential or an API key is refused SHARED_WRITER_REQUIRES_SESSION. Body: accountId (an active, parentless human Account), reason (20-2000 characters), optional expiresAt (ISO-8601, in the future; omitted = never), optional source, and stepUpToken: a single-use token minted by POST /auth/step-up for action knowledge.shared-writer.add bound to the accountId, burned in the same transaction. Writes one audit_events row (knowledge.shared_writer.add) with the before and after membership, the reason and the step-up token id, and sends an id-only notice to the enabled notification endpoints. The source honours the change at its next snapshot (about 15 s plus its 5 s refresh).", responses: { '200': { description: 'success, source, scope, accountId, before (account ids), after (account ids), auditId' }, '400': { description: 'SHARED_WRITER_INVALID (field names the input) / SHARED_WRITER_SOURCE_REQUIRED' }, '403': { description: 'SHARED_WRITER_REQUIRES_SESSION / SHARED_WRITER_REQUIRES_ADMINISTRATOR / PRINCIPAL_REQUIRED / STEP_UP_REQUIRED (with the stepUp challenge)' }, '404': { description: 'SHARED_WRITER_SOURCE_NOT_FOUND / SHARED_WRITER_ACCOUNT_NOT_FOUND' }, '409': { description: 'SHARED_WRITER_ALREADY_LISTED (refused before any step-up is spent)' }, '422': { description: 'SHARED_WRITER_NOT_AN_ACCOUNT (a Connector, Agent, Group or service identity) / SHARED_WRITER_ACCOUNT_INACTIVE' } } },
      },
      '/knowledge-shared-writers/remove': {
        post: { summary: "Remove an Account from a knowledge source's shared-area writer list (card 549cc51f). The same login-session gate as the add. Body: accountId, reason (20-2000 characters), optional source, and stepUpToken minted for action knowledge.shared-writer.remove bound to the accountId. Writes one audit_events row (knowledge.shared_writer.remove) with the before and after membership, the reason and the step-up token id, and sends the id-only notice.", responses: { '200': { description: 'success, source, scope, accountId, before, after, auditId' }, '400': { description: 'SHARED_WRITER_INVALID / SHARED_WRITER_SOURCE_REQUIRED' }, '403': { description: 'SHARED_WRITER_REQUIRES_SESSION / SHARED_WRITER_REQUIRES_ADMINISTRATOR / PRINCIPAL_REQUIRED / STEP_UP_REQUIRED' }, '404': { description: 'SHARED_WRITER_SOURCE_NOT_FOUND / SHARED_WRITER_NOT_LISTED (refused before any step-up is spent)' } } },
      },
      // Card 08792425 (member N6, the default-store design C7): two-way
      // registration of a knowledge source. 'authenticated' with the in-handler
      // gate (root or an administrator login session; every bearer refused);
      // not exposed over MCP.
      '/knowledge-source-registrations': {
        get: { summary: "Every knowledge source registered from an installer bundle, each as its registration state (rh.knowledge-source.registration-state/1): the Service, its endpoints and allowed networks, the certificate fingerprint as the administrator confirmed it (an upload-time check, never pinned at dial time), the channel credential reference NAME with whether it resolves in the core's environment (never its value), what a dial answers now (refused, unavailable:transport, until the operator's root act), the operator's steps by name, the lifecycle export state, and the read grant the source's readers need (direct: POST /grants, whose ceiling is the root scope, so root or an admin or orchestrator login session; an operator is refused). A login-session act: root or an administrator session; every bearer credential, a root bearer included, is refused KNOWLEDGE_SOURCE_REGISTER_REQUIRES_SESSION. A refused read is not audited (by design: only the act's refusals are).", responses: { '200': { description: '{ success, schemaVersion, registrations }' }, '403': { description: 'KNOWLEDGE_SOURCE_REGISTER_REQUIRES_SESSION / KNOWLEDGE_SOURCE_REGISTER_REQUIRES_ADMINISTRATOR / PRINCIPAL_REQUIRED' } } },
        post: { summary: "Register a knowledge source from an installer's registration bundle (rh.knowledge-source.registration/1: name, optional slug and description, endpoint, optional getEndpoint and writeEndpoint, a descriptor whose knowledgeSource block is protocol_version 2, and certificateSha256, the sha256 fingerprint of the endpoint's TLS certificate). Body: bundle (the object, or its JSON text), confirmedFingerprint (the fingerprint the administrator compared with the installer's console), confirmation ('checked' or 'typed'), optional allowedNetworks (CIDRs for a private endpoint address), optional slug, and stepUpToken: a single-use token minted by POST /auth/step-up for action knowledge.source.register bound to the bundle's fingerprint (64 lower-case hex digits), burned in the same transaction. The channel credential reference name the act would record (knowledge-source/<slug>, the slug given or derived from the name) must be FREE, because a fresh source cannot have had its operator step yet: it is refused 409 REGISTRATION_CREDENTIAL_REFERENCE_TAKEN, field slug, with reason 'resolves' (the exact name already resolves in RELAYHALL_KNOWLEDGE_SOURCE_CREDENTIALS), 'environment-entry' (an entry of that variable is the same name after folding case, Unicode compatibility forms, marks, invisible characters, whitespace and separators) or 'service-reference' (any Service row, draft, published or retired, records the same folded name), before the step-up is spent and before anything is written. In ONE transaction the core creates and publishes the Service with the bundle's descriptor, records the endpoints, the allowed networks and the channel credential reference name (knowledge-source/<slug>) on the owner plane, records the confirmed fingerprint, and writes one audit_events row (knowledge.source.register) carrying the fingerprint and how it was confirmed. Any refusal leaves nothing behind and spends no step-up; every refusal after the gate is audited as denied by name. Not retry-keyed. The core dials the source only through its default trust store: the fingerprint is not pinned. Until the operator places the channel bearer under the reference name in RELAYHALL_KNOWLEDGE_SOURCE_CREDENTIALS and restarts the core, every dial answers unavailable:transport.", responses: { '201': { description: '{ success, registration (the registration state), returnBundle } (returnBundle null with returnBundleRefusal { code: RETURN_BUNDLE_KEY_UNSUPPORTED, message } when a key is not Ed25519)' }, '400': { description: 'UNKNOWN_FIELD' }, '403': { description: 'KNOWLEDGE_SOURCE_REGISTER_REQUIRES_SESSION / KNOWLEDGE_SOURCE_REGISTER_REQUIRES_ADMINISTRATOR / PRINCIPAL_REQUIRED / STEP_UP_REQUIRED (with the stepUp challenge; also for a token bound to another action or fingerprint, spent or expired)' }, '409': { description: 'REGISTRATION_CREDENTIAL_REFERENCE_TAKEN (with reason resolves / environment-entry / service-reference) / REGISTRATION_ENDPOINT_TAKEN / REGISTRATION_FINGERPRINT_TAKEN / SERVICE_SLUG_TAKEN' }, '413': { description: 'REGISTRATION_BUNDLE_TOO_LARGE' }, '422': { description: 'REGISTRATION_BUNDLE_INVALID / REGISTRATION_BUNDLE_SCHEMA_UNSUPPORTED / REGISTRATION_DESCRIPTOR_NOT_V2 / REGISTRATION_FINGERPRINT_INVALID / REGISTRATION_FINGERPRINT_NOT_CONFIRMED / REGISTRATION_CONFIRMATION_INVALID / a DESCRIPTOR_* code / the outbound policy codes (INVALID_KNOWLEDGE_ENDPOINT, KNOWLEDGE_ENDPOINT_SCHEME_REFUSED, KNOWLEDGE_ENDPOINT_ADDRESS_REFUSED, INVALID_KNOWLEDGE_VALUE, KNOWLEDGE_NETWORK_NEVER_ADMISSIBLE) / the owner-plane codes (KNOWLEDGE_WRITE_BLOCK_REQUIRED) / RESERVED_SERVICE_SLUG / INVALID_SERVICE_VALUE; field names the input' } } },
      },
      '/knowledge-source-registrations/{id}': {
        get: { summary: 'One registered knowledge source, by its Service id: its registration state, as listed. The same gate as the list.', parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }], responses: { '200': { description: '{ success, registration }' }, '400': { description: 'INVALID_REGISTRATION_ID' }, '403': { description: 'KNOWLEDGE_SOURCE_REGISTER_REQUIRES_SESSION / KNOWLEDGE_SOURCE_REGISTER_REQUIRES_ADMINISTRATOR / PRINCIPAL_REQUIRED' }, '404': { description: 'REGISTRATION_NOT_FOUND' } } },
      },
      '/knowledge-source-registrations/{id}/return-bundle': {
        get: { summary: "The return bundle the installer imports (rh.knowledge-source.return/1): serviceId and audience (the Service id), issuer (the issuer of the core's knowledge assertions), certificateSha256, credentialReference (the NAME only), assertionKeys (the public JWKs of the core's non-retired assertion keys) and lifecycleKey (the public JWK the core's lifecycle exporter signs this source's snapshot with, or null while the exporter is not configured for it). Public material only: no JWK carries a member other than kty, crv, x, kid, alg and use, and no credential value is ever included. Only Ed25519 (OKP) keys are carried: a key of another type is refused 503 RETURN_BUNDLE_KEY_UNSUPPORTED rather than cut down. The same gate as the list.", parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }], responses: { '200': { description: 'The return bundle' }, '400': { description: 'INVALID_REGISTRATION_ID' }, '403': { description: 'KNOWLEDGE_SOURCE_REGISTER_REQUIRES_SESSION / KNOWLEDGE_SOURCE_REGISTER_REQUIRES_ADMINISTRATOR / PRINCIPAL_REQUIRED' }, '404': { description: 'REGISTRATION_NOT_FOUND' }, '503': { description: 'RETURN_BUNDLE_KEY_UNSUPPORTED' } } },
      },
      // Card bedf50cc (owner ruling E380): plugin availability and layered
      // plugin settings, stage 1. Not exposed over MCP (C9).
      '/plugin-host/choices': { get: { summary: "The calling Account's eligible plugins (rh.plugin.choices/1): the v1 plugins the installation file lets it view whose availability is not disabled, each { name, label, state (required | default_on | available), enabled, userControlled, revision }. A switched-off default_on or available plugin is listed here and on PUT .../choice only. Requires services:read; the Account is derived (activePluginAccount), never named.", responses: { '200': { description: '{ schemaVersion, plugins }' }, '503': { description: 'PLUGIN_UNAVAILABLE' } } } },
      '/plugin-host/{name}/choice': { put: { summary: "Switch a plugin on or off for the calling Account, body { enabled }. Only for default_on and available plugins: required answers 409 CHOICE_NOT_ALLOWED; disabled, unknown, legacy and file-invisible plugins answer the byte-identical 404 PLUGIN_NOT_FOUND. The Account's own login session only (no bearer, no delegation link): anything else is 403 SESSION_ONLY. If-Match: the choice revision (0 before the first write). Audited plugin.choice.set.", parameters: [{ name: 'name', in: 'path', required: true, schema: { type: 'string' } }, ifMatchParam], responses: { '200': { description: '{ success, name, state, enabled, revision }' }, '400': { description: 'REVISION_REQUIRED / PLUGIN_CHOICE_INVALID' }, '403': { description: 'SESSION_ONLY' }, '404': { description: 'PLUGIN_NOT_FOUND' }, '409': { description: 'CHOICE_NOT_ALLOWED' }, '412': { description: 'REVISION_MISMATCH' } } } },
      '/plugin-host/{name}/settings': { get: { summary: "The calling Account's own effective plugin settings (rh.plugin.settings/1): the schema the plugin declares, values, per-key sources ({ source: account | deployment | default, locked }), the availability and its own revision. Values of deliver: backend keys are omitted (the key and its source are shown); secret settings never carry a value. Requires services:read. An unknown, legacy, invisible or switched-off plugin answers 404 PLUGIN_NOT_FOUND.", parameters: [{ name: 'name', in: 'path', required: true, schema: { type: 'string' } }], responses: { '200': { description: 'Settings view' }, '404': { description: 'PLUGIN_NOT_FOUND' } } } },
      '/plugin-host/{name}/settings/account': { put: { summary: "Replace the calling Account's own values, body { values }: account and unlocked account_overridable keys only. A stored deliver: backend value the body does not name is kept (the Account's own read never shows it); naming a key with null removes the Account's value for it. Unknown and wrong-scope keys, secret keys, locked keys (409), values outside the declared type or bounds and credential-shaped values are refused; 16 KiB, depth 8 and 4 KiB strings at most. The Account's own login session only (403 SESSION_ONLY). If-Match: the revision (0 before the first write). Audited plugin.settings.account.set with the changed keys, never the values.", parameters: [{ name: 'name', in: 'path', required: true, schema: { type: 'string' } }, ifMatchParam], responses: { '200': { description: '{ success, name, revision, changedKeys }' }, '400': { description: 'REVISION_REQUIRED / PLUGIN_SETTINGS_KEY_UNKNOWN / PLUGIN_SETTINGS_KEY_WRONG_SCOPE / PLUGIN_SETTINGS_SECRET_NOT_STORED / PLUGIN_SETTINGS_VALUE_INVALID / PLUGIN_SETTINGS_VALUE_SECRET / PLUGIN_SETTINGS_INVALID' }, '403': { description: 'SESSION_ONLY' }, '404': { description: 'PLUGIN_NOT_FOUND' }, '409': { description: 'PLUGIN_SETTINGS_KEY_LOCKED' }, '412': { description: 'REVISION_MISMATCH' }, '413': { description: 'PLUGIN_SETTINGS_TOO_LARGE' } } } },
      '/plugin-host/{name}/settings/effective': { get: { summary: "The PLUGIN BACKEND's read of one Account's effective non-secret settings, deliver: backend keys included (rh.plugin.settings.effective/1). Authenticated ONLY by the per-request plugin assertion in X-RelayHall-Assertion (HS256, issuer relayhall, audience = name, unexpired, a jti the core issued for that plugin and Account); Authorization is never read. Every verification failure answers 404 PLUGIN_NOT_FOUND.", parameters: [{ name: 'name', in: 'path', required: true, schema: { type: 'string' } }, { name: 'X-RelayHall-Assertion', in: 'header', required: true, schema: { type: 'string' } }], responses: { '200': { description: '{ schemaVersion, plugin, account, values, sources }' }, '404': { description: 'PLUGIN_NOT_FOUND' }, '503': { description: 'PLUGIN_SETTINGS_UNAVAILABLE (an internal failure, with errorId)' } } } },
      '/plugin-admin': { get: { summary: 'Administrators: the installed v1 plugins with their availability state and revision. An admin or operator login session (bearers, root bearers included, are refused PLUGIN_ADMIN_REQUIRES_SESSION).', responses: { '200': { description: '{ schemaVersion, plugins }' }, '403': { description: 'PLUGIN_ADMIN_REQUIRES_SESSION / PLUGIN_ADMIN_REQUIRES_ADMINISTRATOR / PRINCIPAL_REQUIRED' } } } },
      '/plugin-admin/{name}/policy': {
        get: { summary: "Administrators: one plugin's availability { availability, revision } (no row = default_on, revision 0).", parameters: [{ name: 'name', in: 'path', required: true, schema: { type: 'string' } }], responses: { '200': { description: 'Policy' }, '403': { description: 'PLUGIN_ADMIN_REQUIRES_SESSION / PLUGIN_ADMIN_REQUIRES_ADMINISTRATOR' }, '404': { description: 'PLUGIN_NOT_FOUND' } } },
        put: { summary: "Administrators: set availability, body { availability: required | default_on | available | disabled, clearChoices?, stepUpToken }. A single-use step-up bound to (plugin.admin, name) is burned in the same transaction; clearChoices removes every Account's choice for the plugin. Audited plugin.policy.set with the count of cleared choices.", parameters: [{ name: 'name', in: 'path', required: true, schema: { type: 'string' } }, ifMatchParam], responses: { '200': { description: '{ success, name, state, revision, clearedChoices }' }, '400': { description: 'REVISION_REQUIRED / PLUGIN_POLICY_INVALID' }, '403': { description: 'PLUGIN_ADMIN_REQUIRES_SESSION / PLUGIN_ADMIN_REQUIRES_ADMINISTRATOR / STEP_UP_REQUIRED (with stepUp)' }, '404': { description: 'PLUGIN_NOT_FOUND' }, '412': { description: 'REVISION_MISMATCH' } } },
      },
      '/plugin-admin/{name}/settings': {
        get: { summary: 'Administrators: the full schema, the deployment values (deliver: backend included), the locked keys, the revision and the stale keys.', parameters: [{ name: 'name', in: 'path', required: true, schema: { type: 'string' } }], responses: { '200': { description: 'Deployment settings' }, '403': { description: 'PLUGIN_ADMIN_REQUIRES_SESSION / PLUGIN_ADMIN_REQUIRES_ADMINISTRATOR' }, '404': { description: 'PLUGIN_NOT_FOUND' } } },
        put: { summary: 'Administrators: replace the deployment values and locks, body { values, lockedKeys?, stepUpToken }: deployment and account_overridable keys; locks name account_overridable keys. The same refusals as the Account write, and a step-up per write. Audited plugin.settings.deployment.set with the changed and locked keys, never the values.', parameters: [{ name: 'name', in: 'path', required: true, schema: { type: 'string' } }, ifMatchParam], responses: { '200': { description: '{ success, name, revision, changedKeys, lockedKeys }' }, '400': { description: 'REVISION_REQUIRED / PLUGIN_SETTINGS_KEY_UNKNOWN / PLUGIN_SETTINGS_KEY_WRONG_SCOPE / PLUGIN_SETTINGS_SECRET_NOT_STORED / PLUGIN_SETTINGS_VALUE_INVALID / PLUGIN_SETTINGS_VALUE_SECRET' }, '403': { description: 'PLUGIN_ADMIN_REQUIRES_SESSION / PLUGIN_ADMIN_REQUIRES_ADMINISTRATOR / STEP_UP_REQUIRED (with stepUp)' }, '404': { description: 'PLUGIN_NOT_FOUND' }, '412': { description: 'REVISION_MISMATCH' }, '413': { description: 'PLUGIN_SETTINGS_TOO_LARGE' } } },
      },
      '/plugin-admin/{name}/settings/cleanup': { post: { summary: 'Administrators: remove every stored value (deployment and every Account) and lock the current schema no longer accepts, body { stepUpToken }. Audited plugin.settings.cleanup with the removed keys and the count of rows changed.', parameters: [{ name: 'name', in: 'path', required: true, schema: { type: 'string' } }], responses: { '200': { description: '{ success, name, rowsChanged, keysRemoved }' }, '403': { description: 'PLUGIN_ADMIN_REQUIRES_SESSION / PLUGIN_ADMIN_REQUIRES_ADMINISTRATOR / STEP_UP_REQUIRED (with stepUp)' }, '404': { description: 'PLUGIN_NOT_FOUND' } } } },
      '/knowledge-writes/commit': { post: { summary: "Commit an open proposal (RB-11 Governor v0, C.8). Requires knowledge-contents:write. Body: proposalId, previewDigest (the digest of the preview shown), expectedRevision ('absent' to create, else the sha256 read), optional source. Only the principal that proposed may commit. Answers with the source commit answer with ONE substitution: the raw ref is sealed into a handle (read it back with GET /knowledge-contents), and sha256, compartment and committed_at are the source's own. The core stores the handle's digest, never note content.", responses: { '200': { description: 'success, source, auditRef and result {protocol_version, status: committed, handle, compartment, sha256, committed_at}' }, '403': { description: 'refused (uniform) / source_not_write_capable / the source refusal codes listed on /knowledge-writes/propose' } } } },
      '/telemetry/frames': { post: { summary: 'Ingest one presence/telemetry frame (RH-P3.C7, §2.6.5 C5/F11 trim: heartbeat or coarse status only). Requires telemetry:write (AUTHZ design 4d961e37 A17.7/§9.1, the status:write successor); each service writes only its own frames — the owner is always the calling principal, recorded server-side, and the body cannot name one. Zero server-side effect; rate- and size-limited; short retention.', responses: { '200': { description: 'OK' }, '400': { description: 'INVALID_FRAME / PRINCIPAL_REQUIRED / TASK_NOT_FOUND' }, '403': { description: 'telemetry:write required' }, '413': { description: 'PAYLOAD_TOO_LARGE' }, '429': { description: 'RATE_LIMITED (one frame per interval per principal)' } } } },
      '/telemetry/events': { post: { summary: 'Ingest ONE rh.ai.telemetry/1.0 envelope record (RH-TW1a, TELEMETRY-DESIGN 7d5c0cdc §3.1; owner decision D11). Requires telemetry:write. The reporting identity is derived from the authenticated credential chain (§4.1/§5.1) and the body cannot name one; the source product must appear in the owning Connector descriptor declared list (§5.2). Tier-0 deny-by-default redaction runs BEFORE storage, and the redacted payload is content-addressed into the §6.5.1 governed raw store in the same statement.', responses: { '200': { description: 'OK - accepted, possibly a duplicate' }, '400': { description: 'INVALID_ENVELOPE / UNSUPPORTED_SCHEMA_MAJOR (carries acceptedMajors) / TELEMETRY_PRINCIPAL_REQUIRED' }, '403': { description: 'telemetry:write required, or TELEMETRY_PRINCIPAL_NO_CONNECTOR / TELEMETRY_PRODUCT_NOT_DECLARED / TELEMETRY_TIER_NOT_DECLARED' }, '413': { description: 'ENVELOPE_TOO_LARGE' }, '429': { description: 'RATE_LIMITED (one accepted event per interval per principal)' } } } },
      '/telemetry/events/batch': { post: { summary: 'Ingest a BATCH of rh.ai.telemetry/1.0 records - the ratified home of canonical batch ingest (owner decisions D2 and D11). Body is JSONL (application/x-ndjson or application/jsonl): one full record per line, at most 500 records and 1 MiB. Integrity rides the authenticated transport at upload; there is deliberately NO separate payload signature in v1. Each record is validated, redacted and stored on its own merits, so PARTIAL SUCCESS is normal and the response carries a per-record result; malformed lines go to the §6.5.2 quarantine under the per-connector quota and are never echoed back. The receiver limit is spent ONCE per batch, on the events_batch surface.', responses: { '200': { description: 'OK - per-record results; accepted, duplicates and refused counts' }, '400': { description: 'EMPTY_BATCH / TELEMETRY_PRINCIPAL_REQUIRED' }, '403': { description: 'telemetry:write required, or a principal refusal (§5.1)' }, '413': { description: 'BATCH_TOO_LARGE, or the body exceeded the byte limit' }, '415': { description: 'UNSUPPORTED_MEDIA_TYPE - the batch surface reads JSONL' }, '429': { description: 'RATE_LIMITED (one accepted batch per interval per principal)' } } } },
      '/telemetry/otlp/v1/traces': { post: { summary: 'OTLP/HTTP export of traces (RH-TW1b, TELEMETRY-DESIGN 7d5c0cdc §3.1). Body is an ExportTraceServiceRequest as application/x-protobuf (up to 4 MiB after decompression) or OTLP/JSON (the deployment JSON body ceiling); at most 1000 records. Requires telemetry:write; the reporting identity is derived from the credential chain and each record\'s service.name must be a product the owning Connector descriptor declares. Every record is translated (Claude Code log events, OpenInference and GenAI semantic-convention spans, the delta gen_ai.client.token.usage histogram) into an rh.ai.telemetry/1.0 envelope and stored through the native pipeline; untranslatable records are refused by name in partial_success. The answer is in the request encoding.', responses: { '200': { description: 'ExportTraceServiceResponse, with partial_success when records were refused' }, '400': { description: 'google.rpc.Status - the body is not the message' }, '403': { description: 'telemetry:write required, or a principal refusal (§5.1)' }, '413': { description: 'more than 1000 records, or the body exceeded its byte limit' }, '415': { description: 'UNSUPPORTED_MEDIA_TYPE - application/x-protobuf or application/json' }, '429': { description: 'RATE_LIMITED with Retry-After (one export per signal per interval per principal)' }, '503': { description: 'TELEMETRY_INGEST_UNAVAILABLE with Retry-After - the whole export is refused; retry it intact' } } } },
      '/telemetry/otlp/v1/logs': { post: { summary: 'OTLP/HTTP export of logs (RH-TW1b, TELEMETRY-DESIGN 7d5c0cdc §3.1). Body is an ExportLogsServiceRequest as application/x-protobuf (up to 4 MiB after decompression) or OTLP/JSON (the deployment JSON body ceiling); at most 1000 records. Requires telemetry:write; the reporting identity is derived from the credential chain and each record\'s service.name must be a product the owning Connector descriptor declares. Every record is translated (Claude Code log events, OpenInference and GenAI semantic-convention spans, the delta gen_ai.client.token.usage histogram) into an rh.ai.telemetry/1.0 envelope and stored through the native pipeline; untranslatable records are refused by name in partial_success. The answer is in the request encoding.', responses: { '200': { description: 'ExportLogsServiceResponse, with partial_success when records were refused' }, '400': { description: 'google.rpc.Status - the body is not the message' }, '403': { description: 'telemetry:write required, or a principal refusal (§5.1)' }, '413': { description: 'more than 1000 records, or the body exceeded its byte limit' }, '415': { description: 'UNSUPPORTED_MEDIA_TYPE - application/x-protobuf or application/json' }, '429': { description: 'RATE_LIMITED with Retry-After (one export per signal per interval per principal)' }, '503': { description: 'TELEMETRY_INGEST_UNAVAILABLE with Retry-After - the whole export is refused; retry it intact' } } } },
      '/telemetry/otlp/v1/metrics': { post: { summary: 'OTLP/HTTP export of metrics (RH-TW1b, TELEMETRY-DESIGN 7d5c0cdc §3.1). Body is an ExportMetricsServiceRequest as application/x-protobuf (up to 4 MiB after decompression) or OTLP/JSON (the deployment JSON body ceiling); at most 1000 records. Requires telemetry:write; the reporting identity is derived from the credential chain and each record\'s service.name must be a product the owning Connector descriptor declares. Every record is translated (Claude Code log events, OpenInference and GenAI semantic-convention spans, the delta gen_ai.client.token.usage histogram) into an rh.ai.telemetry/1.0 envelope and stored through the native pipeline; untranslatable records are refused by name in partial_success. The answer is in the request encoding.', responses: { '200': { description: 'ExportMetricsServiceResponse, with partial_success when records were refused' }, '400': { description: 'google.rpc.Status - the body is not the message' }, '403': { description: 'telemetry:write required, or a principal refusal (§5.1)' }, '413': { description: 'more than 1000 records, or the body exceeded its byte limit' }, '415': { description: 'UNSUPPORTED_MEDIA_TYPE - application/x-protobuf or application/json' }, '429': { description: 'RATE_LIMITED with Retry-After (one export per signal per interval per principal)' }, '503': { description: 'TELEMETRY_INGEST_UNAVAILABLE with Retry-After - the whole export is refused; retry it intact' } } } },
      '/telemetry/otlp/{version}/{signal}': { post: { summary: 'Any OTLP version or signal this receiver does not serve. Refused with 404 and the advertisement (acceptedOtlpVersions, acceptedOtlpSignals, schemaFamily, acceptedMajors), and counted on the Connector adapter-health row. Requires telemetry:write.', responses: { '404': { description: 'OTLP_VERSION_NOT_ACCEPTED / OTLP_SIGNAL_NOT_ACCEPTED, with the advertisement' } } } },
      '/connectors/trust-policy': { get: { summary: 'E462 slice S3 (universal harness connector design v1.5 section 4.3, choice C5): the board\'s NARROW-ONLY override of the connector trust policy. The connector release ships the policy (which publishers, package identities and issuing chains a harness binary must verify to) and it is the CEILING; this answer can only narrow it: raise minimumVersion, add denyVersions, remove a publisher. A deployment entry that would widen it (a publisher, a chain, a signer, a lower minimum, a product the release does not trust) is never served: it is named in rejected, by path and code, never by value. The connector applies the same rule against its own release, so nothing served here can widen what it trusts. Requires services:read; session and bearer alike. Body: { schemaVersion: rh.connector-trust-policy/1, ceilingSha256, source: deployment|none, override: { schemaVersion: rh.connector-trust-override/1, products: { <product>: { <os>: { minimumVersion?, denyVersions?, removePublishers? } } } } | null, rejected: [{ path, code }] }.', responses: { '200': { description: 'OK - the accepted narrowing (or null) and every refused entry by code' }, '403': { description: 'services:read required' }, '503': { description: 'TRUST_POLICY_UNAVAILABLE' } } } },
      '/telemetry/discovery': { get: { summary: 'What the telemetry ingest surfaces accept (§3.1): the envelope schema family and accepted majors, the accepted OTLP versions and signals, every ingest path with its content types and bounds, and the OTLP translations with their support level. Protocol metadata, the same for every caller.', responses: { '200': { description: 'OK' } } } },
      '/tasks/{id}/brief': { post: { summary: 'Compile the full agent Brief for a task — the TASK altitude of the Brief family (generation only; the product never executes agents). RH-P3.C4 (ii) / D4 retired the pre-A7 /tasks/{id}/prompt spelling and its `prompt` response key; neither is aliased. Its Report section is bounded: the 5 newest authorized Report summaries, at most 3 pinned Reports, the authorized total and the next-page cursor; unreadable Reports are neither listed nor counted. Body options: inlineReports (opt-in full-content inlining of the Reports that section lists), tokenBudget (caller-declared inlining budget), format (markdown | agentsmd).', responses: { '400': { description: 'INVALID_TASK_ID: the path id is not a full Task UUID (8-char prefixes are CLI-only)' }, '200': { description: 'OK — { brief, model, thinking, taskId, format, tokenEstimate }' } } } },
      '/tasks/{id}/claim': { post: { summary: 'Claim an armed, dependency-ready task — become its Assignee (idempotent for the current Assignee). Every refusal carries details.reason in the lifecycleAccess.claim.reason vocabulary and writes a Refused task.claim audit row.', responses: { '200': { description: 'The caller is the Assignee; claim.outcome is claimed or already_assignee' }, '400': { description: 'No principal resolved for caller / INVALID_TASK_ID' }, '403': { description: 'TASK_CLAIM_AUTHORITY_CHANGED' }, '409': { description: 'TASK_NOT_ARMED / TASK_DEPENDENCY_BLOCKED / TASK_ALREADY_ASSIGNED / CLAIMANT_VERIFIER_CONFLICT / TASK_ASSIGNMENT_EPOCH_MISMATCH' }, '503': { description: 'Identity substrate not migrated' } } } },
      '/tasks/{id}/release': { post: { summary: 'Release a task — clear its Assignee (the Assignee always may; orchestrator may force)', responses: { '200': { description: 'Released' }, '400': { description: 'No principal resolved for caller / INVALID_TASK_ID' }, '409': { description: 'Another principal is the Assignee' }, '503': { description: 'Identity substrate not migrated' } } } },
      '/principals': {
        get: { summary: 'List configured principals (identity metadata never exposed)', parameters: [
          { name: 'includeHidden', in: 'query', schema: { type: 'boolean' }, description: 'Admin-only: include hidden compatibility identities (never adds Group principals)' },
          { name: 'kind', in: 'query', schema: { type: 'string', enum: ['human', 'agent', 'service', 'group'] }, description: 'AZ-A12 clause 3(h): list only this kind. Absent = every kind EXCEPT group: Group principals are listed only when asked for.' },
        ], responses: { '200': { description: 'OK' }, '400': { description: 'INVALID_PRINCIPAL_KIND - kind is not one of human, agent, service, group' }, '403': { description: 'includeHidden requires management authority' }, '503': { description: 'Identity substrate not migrated' } } },
        post: { summary: 'Create an ACCOUNT — a parentless human or service principal (design 4d961e37 A17.1; root scope or orchestrator/admin role; reserved handles and the agent: prefix are refused). Service Accounts MUST declare a purpose. kind=agent is REFUSED: Agent identities arrive only through the delegation machinery (AZ-S5).', responses: { '201': { description: 'Created' }, '400': { description: 'Invalid handle/kind' }, '403': { description: 'Not permitted' }, '409': { description: 'Handle already exists' }, '422': { description: 'AGENT_MINT_ONLY / PURPOSE_REQUIRED / INVALID_PURPOSE' } } },
      },
      '/principals/{id}': {
        patch: { summary: 'Update display name or status. Disabling invalidates every credential the principal holds.', parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }], responses: { '200': { description: 'OK' }, '400': { description: 'Invalid status, or the system principal' }, '403': { description: 'Not permitted' }, '404': { description: 'Not found' }, '422': { description: 'GROUP_PRINCIPAL_MANAGED_BY_GROUPS - the id names a Group principal (AZ-A12 clause 2): a Group principal is managed only through /groups. Refused before any other check and audited as principal.mutation_refused.' } } },
      },
      '/principals/{id}/owner-control': {
        post: {
          summary: 'The owning human login session appoints or revokes its direct Service connector as Main. Does not change credential scopes or selectors.',
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
          requestBody: { required: true, content: { 'application/json': { schema: {
            type: 'object', required: ['enabled', 'reason'],
            properties: { enabled: { type: 'boolean' }, reason: { type: 'string', minLength: 1, maxLength: 2000 } },
          } } } },
          responses: { '200': { description: 'Appointment updated and audited' },
            '400': { description: 'OWNER_CONTROL_INPUT_REQUIRED' },
            '403': { description: 'OWNER_SESSION_REQUIRED or OWN_CONNECTOR_REQUIRED' } },
        },
      },
      '/principals/{id}/credentials': {
        get: { summary: 'List a principal\'s credentials. Secrets are never included.', parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }], responses: { '200': { description: 'OK' }, '400': { description: 'INVALID_PRINCIPAL_ID: the path id is not a full UUID (checked after the authority check)' }, '403': { description: 'Not permitted' } } },
        post: { summary: 'Issue an rh_ credential to a Connector/Agent-layer principal (Accounts are keyless — 422 ACCOUNTS_ARE_KEYLESS). secretOnce is returned in this response and never logged; since AZ-S3 the secret is stored encrypted at rest and is re-revealable under the /credentials/{id}/reveal lineage/step-up rules. Accepts transport (any|mcp|api, §7.5). root is never mintable; *:admin never mints onto Agents.', parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }], responses: { '201': { description: 'Created — body carries secretOnce' }, '400': { description: 'Unknown/escalating scope, disabled principal, the system principal, or an invalid transport' }, '403': { description: 'Not permitted' }, '404': { description: 'Principal not found' }, '422': { description: 'ACCOUNTS_ARE_KEYLESS / ROOT_NOT_MINTABLE / ADMIN_NOT_AGENT_DELEGABLE; GROUP_PRINCIPAL_MANAGED_BY_GROUPS - the id names a Group principal (AZ-A12 clause 2), refused first and audited' }, '409': { description: 'LEGACY_FROZEN / PRINCIPAL_TERMINATED' } } },
      },
      '/credentials/{id}': {
        patch: { summary: 'EDIT a Connector credential IN PLACE (AUTHZ amendment AZ-A13, ratified 2026-10-11, E95; clauses 2, 3, 4, 9, 12). Body { scopes?, transport? (any|mcp|api), stepUpToken?, lifetime?, reason?, narrowAgents? }. The row keeps its id, key_id and secret; the very next request with the SAME token carries the new authority (no reconfiguration). SESSION-ONLY: a bearer caller is refused 403 SESSION_ONLY with a durable audit before any lookup. The editor is root, an administrator login session, or the owning Account whose subtree holds the Connector (else 403 AUTHORITY_EDIT_REQUIRES_ADMINISTRATOR). The server classifies the edit: a NARROWING (every field down or unchanged) saves at once with no step-up, revokes a graced predecessor (9f), and with narrowAgents: true narrows every live Agent under the Connector to the new scopes in the same transaction, revoking an Agent whose intersection is empty (9h). A WIDENING needs a single-use step-up bound to (credential.edit, id) and lifetime {choice: keep} or {choice: until-task, taskId?, revertAt?} (422 EDIT_LIFETIME_REQUIRED; until-task is refused too, naming unrevertible fields, for an edit no revert can undo by narrowing: transport mcp<->api, or a scope set replaced whole), and is applied as ONE approved authority-edit Approval; root or an administrator is capped by its delegable set, the chain-root Account role set (a root sentinel is the superset) and the Connector own(); an owning Account that is not an administrator is capped at the access it holds itself (403 EXCEEDS_ACCOUNT_AUTHORITY, nothing filed) and may only tighten the transport pin. An Agent, OAuth-issued, legacy or dead credential is refused by name. Never returns a secret.', parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }], responses: { '200': { description: 'OK - { success, edit: { objectType, objectId, direction, changed, before, after, approvalId, auditId, lifetime, narrowedAgents, revokedAgents, revokedPredecessorIds, releasedTaskIds } }' }, '403': { description: 'SESSION_ONLY / AUTHORITY_EDIT_REQUIRES_ADMINISTRATOR / STEP_UP_REQUIRED / EXCEEDS_ACCOUNT_AUTHORITY / EXCEEDS_CONNECTOR_OWN / DECIDER_CEILING_EXCEEDED' }, '404': { description: 'CREDENTIAL_NOT_FOUND' }, '409': { description: 'CREDENTIAL_NOT_LIVE / OAUTH_CREDENTIAL_RECONSENT / LEGACY_FROZEN' }, '422': { description: 'EDIT_FIELD_NOT_EDITABLE / EDIT_NO_CHANGE / EDIT_LIFETIME_REQUIRED / AGENT_SCOPE_MINT_ONLY (adding knowledge-contents:write to an Agent credential, E149) / AGENT_CREDENTIAL_NOT_EDITABLE / ROOT_NOT_MINTABLE / INVALID_SCOPES / INVALID_TRANSPORT' } } },
      },
      '/credentials/{id}/revoke': {
        post: { summary: 'Revoke a credential. Effective on the next request; idempotent.', parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }], responses: { '400': { description: 'INVALID_CREDENTIAL_ID: the path id is not a full UUID (checked after the authority check)' }, '200': { description: 'Revoked (or already revoked)' }, '403': { description: 'Not permitted' }, '404': { description: 'Not found' } } },
      },
      '/credentials/{id}/rotate': {
        post: { summary: 'Rotate: mint an EXACT COPY (scope set and transport inherited verbatim — §7.3; any scope/transport change in the body is 422 ROTATION_IS_EXACT_COPY: change them in place with PATCH /credentials/{id}, AZ-A13); the predecessor gets a live-evaluated grace window (default 24h, 0–7d) that only ever shortens its life. Revoked/graced sources refuse (409 ROTATE_FROM_RETIRED); Agents never rotate.', parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }], responses: { '201': { description: 'Rotated — body carries secretOnce' }, '400': { description: 'Disabled principal / INVALID_CREDENTIAL_ID' }, '403': { description: 'Not permitted' }, '404': { description: 'Not found' }, '409': { description: 'ROTATE_FROM_RETIRED / AGENTS_NEVER_ROTATE' }, '422': { description: 'ROTATION_IS_EXACT_COPY / INVALID_GRACE' } } },
      },
      '/tasks/{id}/notes': {
        post: { summary: 'Append a timestamped, attributed note server-side (avoids the read-modify-write race on the single notes column)', parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }], responses: { '200': { description: 'Appended' }, '400': { description: 'Missing or oversized text / INVALID_TASK_ID' }, '404': { description: 'Task not found' } } },
      },
      '/principals/me': { get: { summary: 'The caller\'s resolved principal and scopes (404 until a principal resolves)', responses: { '200': { description: 'OK' }, '404': { description: 'No principal for this identity' } } } },
      '/principals/roles': { get: { summary: 'The role catalogue (card a2d1e317; principals:read): one entry per assignable Account role with its one-line purpose, the identity kinds it is meant for, and its scope ceiling derived from the role-to-scope mapping (ceiling, mayReach, neverReaches, sameCeilingAs), whether it is elevated, and which administrator roles may assign it. The same for every caller; docs/roles.md is generated from it.', responses: { '200': { description: 'OK - { success, roles: [{ role, purpose, meantFor, meantForText, elevated, ceiling, mayReach, neverReaches, sameCeilingAs, assignedBy, assignedByText }] }' }, '401': { description: 'Unauthenticated' }, '403': { description: 'principals:read required' } } } },
      '/metrics': { get: { summary: 'Account-bound Prometheus text exposition. Requires a separate direct Connector credential carrying only metrics:read, ordinary expiry/revocation and live object narrowing; Main and broad credentials are refused. First core slice reports current task/project gauges, project-cap omission and unavailable source flags. No historical, plugin or Governor numbers until validated producers land.', responses: { '200': { description: 'Prometheus 0.0.4', content: { 'text/plain': { schema: { type: 'string' } } } }, '400': { description: 'Query parameters are unsupported' }, '401': { description: 'Unauthenticated or expired/revoked credential' }, '403': { description: 'Wrong scope or collector binding' }, '503': { description: 'Source or metrics configuration unavailable' } } } },
      '/tasks/{id}/subtasks': { post: { summary: 'Add one Subtask (card 2bc7b303)', description: 'Adds one Subtask at a 1-based position (default: append) and answers its stable id. Same authority as the Subtask status verb: tasks:write and Task write; a status other than empty meets the rule the status verb applies from empty, and completed needs actual account-owner or appointed Main authority. A completed Task refuses an unfinished Subtask (TASK_REOPEN_REQUIRED). Emits task.updated.', requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', additionalProperties: false, required: ['text'], properties: { text: { type: 'string', minLength: 1, maxLength: 1000 }, position: { type: 'integer', minimum: 1, description: '1-based; Subtasks at or after it move down one. Default: append.' }, status: { type: 'string', enum: ['empty', 'in-progress', 'review', 'stuck', 'skipped', 'completed'], default: 'empty' } } } } } }, responses: { '201': { description: 'Created: { success, task, subtaskId, position, subtask }' }, '400': { description: 'INVALID_SUBTASK_TEXT / INVALID_SUBTASK_POSITION / INVALID_SUBTASK_STATUS / UNKNOWN_FIELD / INVALID_TASK_ID' }, '403': { description: 'The identity may not set that Subtask state on this Task' }, '404': { description: 'Task not found, or Task concealed' }, '409': { description: 'TASK_REOPEN_REQUIRED / SUBTASK_COMPLETE_FROM_REVIEW' } } } },
      '/tasks/{id}/subtasks/reorder': { post: { summary: 'Reorder the Subtasks of a Task by stable id (card 2bc7b303)', description: 'order lists every current Subtask id of the Task exactly once. Ids, states and text are unchanged. Same authority as the Subtask status verb. Emits task.updated.', requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', additionalProperties: false, required: ['order'], properties: { order: { type: 'array', minItems: 1, uniqueItems: true, items: { type: 'string', pattern: SUBTASK_ID_PATTERN } } } } } } }, responses: { '200': { description: 'OK: { success, task, order }' }, '400': { description: 'INVALID_SUBTASK_ORDER / UNKNOWN_FIELD / INVALID_TASK_ID' }, '403': { description: 'Task write authority required' }, '404': { description: 'Task not found, or Task concealed' }, '409': { description: 'SUBTASK_ORDER_MISMATCH: order is not exactly the current Subtask ids of the Task' } } } },
      '/tasks/{id}/subtasks/by-id/{subtaskId}/text': { patch: { summary: 'Replace the text of one Subtask by stable id (card 2bc7b303)', description: 'The id, position and state of the Subtask are unchanged. Same authority as the Subtask status verb. Emits task.updated.', parameters: [{ name: 'subtaskId', in: 'path', required: true, schema: { type: 'string', pattern: SUBTASK_ID_PATTERN, description: SUBTASK_ID_ERROR } }], requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', additionalProperties: false, required: ['text'], properties: { text: { type: 'string', minLength: 1, maxLength: 1000 } } } } } }, responses: { '200': { description: 'OK: { success, task, subtaskId }' }, '400': { description: 'INVALID_SUBTASK_TEXT / INVALID_SUBTASK_ID / UNKNOWN_FIELD / INVALID_TASK_ID' }, '403': { description: 'Task write authority required' }, '404': { description: 'Task or Subtask not found, or Task concealed' } } } },
      '/tasks/{id}/subtasks/by-id/{subtaskId}/status': { patch: { summary: 'Set Subtask status by stable id (preferred address)', description: 'Optional completionMode=owner with status=completed requires actual account-owner or appointed Main authority under lock and records administrative disposition, never an independent Verifier verdict.', parameters: [{ name: 'subtaskId', in: 'path', required: true, schema: { type: 'string', pattern: SUBTASK_ID_PATTERN, description: SUBTASK_ID_ERROR } }], responses: { '200': { description: 'OK' }, '400': { description: 'INVALID_SUBTASK_ID: outside the unsigned PostgreSQL integer domain / INVALID_TASK_ID' }, '404': { description: 'Task or Subtask not found, or Task concealed' }, '403': { description: 'Completion authority missing; explicit owner mode requires actual account control (ACCOUNT_CONTROL_REQUIRED)' } } } },
      '/tasks/{id}/subtasks/{index}/status': { patch: { deprecated: true, summary: 'Compatibility-only positional Subtask update; emits Deprecation and Warning headers', parameters: [{ name: 'index', in: 'path', required: true, schema: { type: 'integer' } }], responses: { '400': { description: 'INVALID_TASK_ID: the path id is not a full Task UUID (8-char prefixes are CLI-only)' }, '200': { description: 'OK (deprecated)' }, '403': { description: 'Only independent Verifier identities may complete subtasks' } } } },
      '/tasks/{id}/subtasks/{index}/approve': { post: { summary: 'Independent Verifier approves subtask -> completed', responses: { '400': { description: 'INVALID_TASK_ID: the path id is not a full Task UUID (8-char prefixes are CLI-only)' }, '200': { description: 'OK' }, '403': { description: 'Independent Verifier authority required' } } } },
      '/tasks/{id}/subtasks/{index}/reject': { post: { summary: 'Reject subtask -> empty with note', responses: { '400': { description: 'INVALID_TASK_ID: the path id is not a full Task UUID (8-char prefixes are CLI-only)' }, '200': { description: 'OK' } } } },
      '/tasks/{id}/subtasks/{index}/skip': { post: { summary: 'Skip subtask (counts as done)', responses: { '400': { description: 'INVALID_TASK_ID: the path id is not a full Task UUID (8-char prefixes are CLI-only)' }, '200': { description: 'OK' } } } },
      '/tasks/{id}/subtasks/{index}': { put: { summary: 'Replace subtask text/status (legacy)', responses: { '400': { description: 'INVALID_TASK_ID: the path id is not a full Task UUID (8-char prefixes are CLI-only)' }, '200': { description: 'OK' } } } },
      '/projects': {
        get: { summary: 'List projects. Default EXCLUDES archived; includeArchived=true (or status=archived) is the explicit archived view.', parameters: [
          { name: 'status', in: 'query', schema: { type: 'string' } },
          { name: 'includeArchived', in: 'query', schema: { type: 'boolean' } },
          { name: 'includeHidden', in: 'query', schema: { type: 'boolean' } },
          { name: 'includeStats', in: 'query', schema: { type: 'boolean' } },
        ], responses: { '200': { description: 'OK — { success, projects: Project[] } (canonical bounded records; compatibility-held legacy bytes are NEVER embedded)', content: { 'application/json': { schema: { type: 'object', properties: { success: { type: 'boolean' }, projects: { type: 'array', items: { $ref: '#/components/schemas/ProjectListItem' } } } } } } }, '400': { description: 'UNKNOWN_FIELD / INVALID_QUERY_VALUE' } } },
        post: { summary: 'Create project (board state only — never creates filesystem paths). Name is unique among active projects. RH-LENSES-b (design 96f0bd3d s7.3): this act is ACTOR-AWARE. When - and ONLY when - the request arrives on a ROOT LOGIN SESSION whose Account has a RESOLVING home group, the same transaction also writes two grants to that Group over this project (read and write, origin=creation-default) and audits `project.access_default_apply`. All of it or none of it: a forced failure on either grant leaves NO project row. EVERY OTHER CREATOR gets the project and NO grant, with `project.access_default_skip { reason }` naming which clause refused - actor_channel_unavailable (a bearer credential however scoped, a non-root login session, a delegated Connector), no_home_group, not_featured, not_a_member or actor_inactive. The last four are re-derived INSIDE this transaction under a lock on the Group row, so a pointer that resolved a moment ago is not trusted here.', requestBody: { required: true, content: { 'application/json': { schema: { $ref: '#/components/schemas/ProjectCreateBody' } } } }, responses: { '201': { description: 'Created — { success, project }', content: { 'application/json': { schema: { $ref: '#/components/schemas/ProjectEnvelope' } } } }, '400': { description: 'UNKNOWN_FIELD / name required' }, '403': { description: 'With a Group owner (AZ-A12 clause 10(b)): GROUP_OWNER_SESSION_ONLY / GROUP_OWNER_REQUIRES_ADMINISTRATOR / STEP_UP_REQUIRED (with stepUp); nothing is created' }, '409': { description: 'PROJECT_NAME_CONFLICT / LEGACY_COMPATIBILITY_ONLY (links)' }, '422': { description: 'INVALID_PROJECT_VALUE / INVALID_OWNER / OWNER_AT_CREATE_GROUP_ONLY' } } },
      },
      '/projects/{id}': {
        get: { summary: 'Read one canonical bounded project (includes revision; legacy compatibility bytes are never embedded — see /compatibility for counts)', parameters: [projectIdParam], responses: { '400': { description: 'INVALID_PROJECT_ID: the path id is not a full UUID (a Project name is not an id)' }, '200': { description: 'OK — { success, project }', content: { 'application/json': { schema: { $ref: '#/components/schemas/ProjectEnvelope' } } } }, '404': { description: 'PROJECT_NOT_FOUND' } } },
        patch: { summary: 'Update project details; revision-bound. Archived projects refuse every detail mutation (restore only); status archived is set via /archive, not PATCH.', parameters: [projectIdParam, ifMatchParam], requestBody: { content: { 'application/json': { schema: { $ref: '#/components/schemas/ProjectPatchBody' } } } }, responses: { '200': { description: 'OK — { success, project }', content: { 'application/json': { schema: { $ref: '#/components/schemas/ProjectEnvelope' } } } }, '400': { description: 'REVISION_REQUIRED / UNKNOWN_FIELD / INVALID_PROJECT_ID' }, '404': { description: 'PROJECT_NOT_FOUND' }, '409': { description: 'PROJECT_ARCHIVED / PROJECT_NAME_CONFLICT' }, '412': { description: 'REVISION_MISMATCH' }, '422': { description: 'INVALID_PROJECT_VALUE' } } },
      },
      '/projects/{id}/owner-access': {
        get: {
          summary: 'Read current owner and explain whether this human login session can administer ownership. This is advisory; mutation checks fresh authority inside its transaction.',
          parameters: [projectIdParam],
          responses: { '400': { description: 'INVALID_PROJECT_ID: the path id is not a full UUID (a Project name is not an id)' }, '200': { description: 'Owner summary and allowed/reason. REQUIRES_HUMAN_LOGIN, SESSION_SCOPE_CEILING, CURRENT_ROLE_CEILING, NO_PROJECT_ADMIN are explanatory refusal reasons.' }, '404': { description: 'Project absent or concealed' }, '503': { description: 'OWNER_ACCESS_UNAVAILABLE' } },
        },
      },
      '/projects/{id}/owner-candidates': {
        get: {
          summary: 'List active parentless human Accounts eligible to receive bounded Project ownership, and (AZ-A12 clause 12) groups[]: the enabled Groups, featured first and then by name, listed only to a root or administrator login session (the deciders of a Group transfer); empty for everyone else. Requires current human Project administrator authority.',
          parameters: [projectIdParam],
          responses: { '400': { description: 'INVALID_PROJECT_ID: the path id is not a full UUID (a Project name is not an id)' }, '200': { description: '{ success, candidates: [{id, handle, displayName}], groups: [{id, name, featured}] }' }, '403': { description: 'Current human Project administrator authority required' }, '404': { description: 'Project absent or concealed' }, '503': { description: 'OWNER_CANDIDATES_UNAVAILABLE' } },
        },
      },
      '/projects/{id}/default-verifier': {
        put: {
          summary: "Card 41e24358: set or clear the Project's default Verifier, inherited by new Tasks (explicit, then the landing Phase's default, then this one). A login-session act (a bearer is refused SESSION_ONLY, audited) of root, an administrator session or the person owner of the Project; on a Group-owned Project only root or an administrator. The principal must be a person or a Connector that can judge cards (active, live chain, tasks:write). Existing Tasks are never changed. Audited project.default_verifier.set with previous and next.",
          parameters: [projectIdParam, ifMatchParam],
          requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', additionalProperties: false, required: ['principalId'], properties: { principalId: { type: 'string', format: 'uuid', nullable: true } } } } } },
          responses: { '200': { description: 'OK - { success, project: { id, defaultVerifierPrincipalId, revision }, previousDefaultVerifierPrincipalId }' }, '400': { description: 'REVISION_REQUIRED / UNKNOWN_FIELD / INVALID_PROJECT_ID' }, '403': { description: 'SESSION_ONLY / DEFAULT_VERIFIER_REQUIRES_OWNER' }, '404': { description: 'PROJECT_NOT_FOUND (absent or concealed)' }, '409': { description: 'PROJECT_ARCHIVED' }, '412': { description: 'REVISION_MISMATCH' }, '422': { description: 'INVALID_DEFAULT_VERIFIER / DEFAULT_VERIFIER_GROUP_PRINCIPAL / DEFAULT_VERIFIER_AGENT_PRINCIPAL / DEFAULT_VERIFIER_UNUSABLE (details.failedArm)' }, '503': { description: 'DEFAULT_VERIFIER_UNAVAILABLE' } },
        },
      },
      '/projects/{id}/default-verifier/candidates': {
        get: {
          summary: "Card 41e24358: the principals a default-Verifier picker may offer for this Project - active people and Connectors (never a Group or an Agent) that pass the usable predicate now (active, live chain, tasks:write). Requires read on the Project and principals:read.",
          parameters: [projectIdParam],
          responses: { '200': { description: 'OK - { success, candidates: [{ id, kind, handle, displayName }] }' }, '400': { description: 'INVALID_PROJECT_ID' }, '403': { description: 'DEFAULT_VERIFIER_CANDIDATES_PRINCIPALS_READ_REQUIRED' }, '404': { description: 'Project absent or concealed' }, '503': { description: 'DEFAULT_VERIFIER_UNAVAILABLE' } },
        },
      },
      '/projects/{id}/owner': {
        put: {
          summary: 'Explicitly assign, transfer or clear Project ownership. Requires a current human Project administrator login session and a matching Project revision; archived Projects refuse mutation. Independent Grants remain unchanged. AZ-A12 clause 9: a transfer into, out of or between Groups (clearing a Group-owned Project included) is a login-session act of root or an administrator (admin, operator, orchestrator) with a single-use step-up bound to (ownership.transfer, project id) sent as stepUpToken; the appointed Main never decides it. Refusals GROUP_OWNER_SESSION_ONLY, GROUP_OWNER_REQUIRES_ADMINISTRATOR and STEP_UP_REQUIRED (with the stepUp challenge) come before the token is spent and are audited.',
          parameters: [projectIdParam, ifMatchParam],
          requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', additionalProperties: false, required: ['ownerPrincipalId'], properties: { ownerPrincipalId: { type: 'string', format: 'uuid', nullable: true }, stepUpToken: { type: 'string', description: 'AZ-A12 clause 9(e): required when the current owner or the target is a Group.' } } } } } },
          responses: { '200': { description: 'Updated canonical Project, or unchanged current owner with no new audit/feed' }, '400': { description: 'REVISION_REQUIRED / UNKNOWN_FIELD / INVALID_PROJECT_ID' }, '403': { description: 'Human session, scope, role or Project administration ceiling; for a Group source or target GROUP_OWNER_SESSION_ONLY / GROUP_OWNER_REQUIRES_ADMINISTRATOR / STEP_UP_REQUIRED (with stepUp)' }, '404': { description: 'Project absent or concealed' }, '409': { description: 'PROJECT_ARCHIVED' }, '412': { description: 'REVISION_MISMATCH' }, '422': { description: 'INVALID_OWNER (including a disabled Group target) / INEFFECTIVE_OWNER' }, '503': { description: 'OWNER_CHANGE_UNAVAILABLE' } },
        },
      },
      '/projects/{id}/owner/steward': {
        put: {
          summary: 'LENSES-c c1-B (card b5c83682; design delta C.6): the steward transfer of a Project owner, gate (ii) and DD-5 (rulings E57 (ii), E58, E59). Ceiling projects:write; the gate in the handler is the DECIDER (the administrator route decider and the appointed Main are never consulted). It admits exactly two shapes: (ii) OUT, a Project owned by an ACTIVE Group G moves to an active member of G, by a caller holding a LIVE owner row on G; DD-5 IN, the caller own Project moves into an active Group G in which the caller holds a LIVE owner row. Every other move (person to person, Group to Group, a clear) is STEWARD_TRANSFER_SHAPE_REFUSED and stays with PUT /projects/{id}/owner. In order, every refusal before the step-up is spent and audited project.owner.change denied: GROUP_OWNER_SESSION_ONLY (not a login session); GROUP_OWNER_ROLE_REQUIRED (not a human Account acting as itself whose session and role derive projects:write, or no live owner row on the Group concerned, or a disabled source Group); NOT_THE_CURRENT_OWNER (DD-5); TARGET_NOT_A_GROUP_MEMBER (ii); INVALID_OWNER / INEFFECTIVE_OWNER; REVISION_REQUIRED / REVISION_MISMATCH; then STEP_UP_REQUIRED for a step-up bound to (ownership.transfer, project id). Grants are untouched; the audit row carries deciderStanding group-owner. REST only, never MCP.',
          parameters: [projectIdParam, ifMatchParam],
          requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', additionalProperties: false, required: ['ownerPrincipalId'], properties: { ownerPrincipalId: { type: 'string', format: 'uuid', nullable: true }, stepUpToken: { type: 'string', description: 'A single-use step-up bound to (ownership.transfer, project id).' } } } } } },
          responses: { '200': { description: 'Updated canonical Project' }, '400': { description: 'REVISION_REQUIRED / UNKNOWN_FIELD / INVALID_PROJECT_ID' }, '403': { description: 'GROUP_OWNER_SESSION_ONLY / GROUP_OWNER_ROLE_REQUIRED / NOT_THE_CURRENT_OWNER / STEP_UP_REQUIRED (with stepUp)' }, '404': { description: 'Project absent or concealed' }, '409': { description: 'PROJECT_ARCHIVED' }, '412': { description: 'REVISION_MISMATCH' }, '422': { description: 'INVALID_OWNER (including a disabled Group target) / INEFFECTIVE_OWNER / TARGET_NOT_A_GROUP_MEMBER / STEWARD_TRANSFER_SHAPE_REFUSED' }, '503': { description: 'OWNER_CHANGE_UNAVAILABLE' } },
        },
      },
      '/projects/{id}/archive': {
        post: { summary: 'Archive (reversible; ordinary removal — there is no owner-facing deletion); revision-bound', parameters: [projectIdParam, ifMatchParam], responses: { '200': { description: 'OK' }, '400': { description: 'REVISION_REQUIRED / INVALID_PROJECT_ID' }, '404': { description: 'PROJECT_NOT_FOUND' }, '412': { description: 'REVISION_MISMATCH' } } },
      },
      '/projects/{id}/unarchive': {
        post: { summary: 'Restore — the only ordinary mutation of an archived project. Rechecks active-name uniqueness atomically.', parameters: [projectIdParam, ifMatchParam], responses: { '200': { description: 'OK' }, '400': { description: 'REVISION_REQUIRED / INVALID_PROJECT_ID' }, '404': { description: 'PROJECT_NOT_FOUND' }, '409': { description: 'PROJECT_NAME_CONFLICT' }, '412': { description: 'REVISION_MISMATCH' } } },
      },
      '/projects/{id}/resources': {
        get: {
          summary: 'List typed Resources (active by default; deterministic order state,kind,name,id)',
          parameters: [projectIdParam,
            { name: 'includeArchived', in: 'query', schema: { type: 'boolean' }, description: 'Explicit archived view; archived rows carry state=archived' },
            { name: 'kind', in: 'query', schema: { type: 'string', enum: ['repository', 'environment', 'workspace', 'reference'] } },
            { name: 'limit', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 500 } },
            { name: 'cursor', in: 'query', schema: { type: 'string' }, description: 'Opaque cursor from nextCursor' },
          ],
          responses: { '200': { description: 'OK — { resources, nextCursor }' }, '400': { description: 'UNKNOWN_FIELD / INVALID_QUERY_VALUE / INVALID_CURSOR / INVALID_PROJECT_ID' }, '404': { description: 'PROJECT_NOT_FOUND (absence and denial are indistinguishable)' } },
        },
        post: {
          summary: 'Create one typed Resource (defaults: hidden, installation-only)',
          requestBody: { content: { 'application/json': { schema: { $ref: '#/components/schemas/ResourceWriteBody' } } } },
          responses: { '201': { description: 'Created — { resource }' }, '400': { description: 'UNKNOWN_FIELD / INVALID_PROJECT_ID' }, '404': { description: 'PROJECT_NOT_FOUND' }, '409': { description: 'PROJECT_ARCHIVED / RESOURCE_NAME_CONFLICT / PRIMARY_REPOSITORY_CONFLICT' }, '422': { description: 'INVALID_RESOURCE_VALUE / UNSUPPORTED_SCHEME / EMBEDDED_CREDENTIAL_FORBIDDEN / WORKSPACE_MUST_BE_INSTALLATION_ONLY' } },
        },
        patch: { summary: 'Deprecated legacy JSONB writer — always 409 LEGACY_COMPATIBILITY_ONLY', responses: { '400': { description: 'INVALID_PROJECT_ID: the path id is not a full UUID (a Project name is not an id)' }, '409': { description: 'LEGACY_COMPATIBILITY_ONLY' } } },
        put: { summary: 'Deprecated legacy JSONB writer — always 409 LEGACY_COMPATIBILITY_ONLY', responses: { '400': { description: 'INVALID_PROJECT_ID: the path id is not a full UUID (a Project name is not an id)' }, '409': { description: 'LEGACY_COMPATIBILITY_ONLY' } } },
      },
      '/projects/{id}/resources/{resourceId}': {
        get: { summary: 'Read one child-bound Resource (cross-project ids are concealed 404s)', parameters: [projectIdParam, resourceIdParam], responses: { '400': { description: 'INVALID_PROJECT_ID: the path id is not a full UUID (a Project name is not an id) / INVALID_RESOURCE_ID' }, '200': { description: 'OK — { resource }' }, '404': { description: 'RESOURCE_NOT_FOUND' } } },
        patch: {
          summary: 'Merge-patch mutable fields (kind immutable — use /replace); revision-bound',
          parameters: [projectIdParam, resourceIdParam, ifMatchParam],
          responses: { '200': { description: 'OK — { resource }' }, '400': { description: 'UNKNOWN_FIELD / REVISION_REQUIRED / INVALID_PROJECT_ID / INVALID_RESOURCE_ID' }, '404': { description: 'Concealed absence' }, '409': { description: 'PROJECT_ARCHIVED / RESOURCE_ARCHIVED / RESOURCE_NAME_CONFLICT / PRIMARY_REPOSITORY_CONFLICT' }, '412': { description: 'REVISION_MISMATCH' }, '422': { description: 'Validation failure (stable codes)' } },
        },
      },
      '/projects/{id}/resources/{resourceId}/archive': {
        post: { summary: 'Archive (ordinary removal; bytes retained; revision-bound; idempotent under matching revision)', parameters: [projectIdParam, resourceIdParam, ifMatchParam], responses: { '400': { description: 'INVALID_PROJECT_ID: the path id is not a full UUID (a Project name is not an id) / INVALID_RESOURCE_ID' }, '200': { description: 'OK — { resource } with state=archived' }, '404': { description: 'Concealed absence' }, '409': { description: 'PROJECT_ARCHIVED' }, '412': { description: 'REVISION_MISMATCH' } } },
      },
      '/projects/{id}/resources/{resourceId}/restore': {
        post: { summary: 'Restore after active-uniqueness checks (atomic failure on collision)', parameters: [projectIdParam, resourceIdParam, ifMatchParam], responses: { '400': { description: 'INVALID_PROJECT_ID: the path id is not a full UUID (a Project name is not an id) / INVALID_RESOURCE_ID' }, '200': { description: 'OK — { resource } with state=active' }, '404': { description: 'Concealed absence' }, '409': { description: 'PROJECT_ARCHIVED / RESOURCE_NAME_CONFLICT / PRIMARY_REPOSITORY_CONFLICT' }, '412': { description: 'REVISION_MISMATCH' } } },
      },
      '/projects/{id}/resources/{resourceId}/replace': {
        post: {
          summary: 'Atomic kind replacement: archives the old Resource and creates the new identity in one transaction. The only kind-change operation. Idempotent per caller/project/key.',
          parameters: [projectIdParam, resourceIdParam, ifMatchParam,
            { name: 'Idempotency-Key', in: 'header', required: true, schema: { type: 'string', minLength: 16, maxLength: 128 }, description: 'Retry with the SAME key to recover a lost response; a different request under the same key is 409 IDEMPOTENCY_KEY_REUSED.' },
          ],
          requestBody: { content: { 'application/json': { schema: { $ref: '#/components/schemas/ResourceWriteBody' } } } },
          responses: { '201': { description: 'Created — { replacement, replaced, requestId }' }, '400': { description: 'UNKNOWN_FIELD / REVISION_REQUIRED / IDEMPOTENCY_KEY_REQUIRED / INVALID_PROJECT_ID / INVALID_RESOURCE_ID' }, '404': { description: 'Concealed absence' }, '409': { description: 'PROJECT_ARCHIVED (checked before replay) / RESOURCE_ARCHIVED / RESOURCE_REPLACEMENT_KIND_UNCHANGED / IDEMPOTENCY_KEY_REUSED / uniqueness conflicts' }, '412': { description: 'REVISION_MISMATCH' }, '422': { description: 'Validation failure' } },
        },
      },
      '/projects/{id}/context': {
        get: { summary: 'Typed structured context projection (active + available Resources only; descriptions excluded)', parameters: [projectIdParam], responses: { '400': { description: 'INVALID_PROJECT_ID: the path id is not a full UUID (a Project name is not an id)' }, '200': { description: 'OK — { context }', content: { 'application/json': { schema: { type: 'object', properties: { success: { type: 'boolean' }, context: { $ref: '#/components/schemas/ProjectContext' } } } } } }, '404': { description: 'PROJECT_NOT_FOUND' }, '409': { description: 'PROJECT_ARCHIVED — archived Projects generate no context' } } },
      },
      '/projects/{id}/compatibility': {
        get: { summary: 'Management-only migration counts (mapped/held per legacy surface; never raw legacy values). Requires admin authority.', parameters: [projectIdParam], responses: { '400': { description: 'INVALID_PROJECT_ID: the path id is not a full UUID (a Project name is not an id)' }, '200': { description: 'OK — { compatibility }' }, '403': { description: 'Admin authority required' }, '404': { description: 'PROJECT_NOT_FOUND' } } },
      },
      '/projects/{id}/charter': {
        get: { summary: "The project's authority index (head). Reads serve archived projects too — archived means read-only, not invisible.", parameters: [projectIdParam], responses: { '400': { description: 'INVALID_PROJECT_ID: the path id is not a full UUID (a Project name is not an id)' }, '200': { description: 'OK — { charter }', content: { 'application/json': { schema: { type: 'object', properties: { success: { type: 'boolean' }, charter: { $ref: '#/components/schemas/Charter' } } } } } }, '404': { description: 'PROJECT_NOT_FOUND / CHARTER_NOT_FOUND' } } },
        put: {
          summary: 'Create or replace the Charter content. OWNER-PLANE write (root sentinel): agents propose amendments through Reports, never by writing the object. Create needs no If-Match; replace is revision-bound; identical content is a no-op.',
          parameters: [projectIdParam, { ...ifMatchParam, required: false, description: 'Required when a Charter already exists. 412 REVISION_MISMATCH when stale; 400 REVISION_REQUIRED when absent on replace.' }],
          requestBody: { content: { 'application/json': { schema: { type: 'object', properties: { content: { type: 'string', maxLength: 131072 } }, required: ['content'], additionalProperties: false } } } },
          responses: { '200': { description: 'OK — { charter, created: false, changed }' }, '201': { description: 'Created — { charter, created: true }' }, '400': { description: 'UNKNOWN_FIELD / REVISION_REQUIRED / VALUE_TOO_LONG / INVALID_PROJECT_ID' }, '404': { description: 'PROJECT_NOT_FOUND (concealed before validation)' }, '409': { description: 'PROJECT_ARCHIVED' }, '412': { description: 'REVISION_MISMATCH' }, '422': { description: 'INVALID_CHARTER_VALUE' } },
        },
      },
      '/projects/{id}/charter/approve': {
        post: {
          summary: 'Human Project owner or authorized Project administrator approves Charter content',
          parameters: [projectIdParam, { ...ifMatchParam, required: false, description: 'Required when a Charter already exists. 412 REVISION_MISMATCH when stale; 400 REVISION_REQUIRED when absent on replace.' }],
          requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', properties: { content: { type: 'string', maxLength: 131072 }, stepUpToken: { type: 'string', description: 'LENSES-c gate (i) (c1-B): read only by the Group-owner arm; a single-use step-up bound to (charter.approve, project id).' } }, required: ['content'], additionalProperties: false } } } },
          description: 'Requires projects:write and a login session for an active parentless human Account. Current ownership or canonical Project administration is checked in the write transaction. Connector/Agent bearer credentials and a generic Project write grant are insufficient. Existing content requires If-Match; archived Projects refuse approval. LENSES-c gate (i) (c1-B, card b5c83682; design delta C.5): only when the administrator test has refused, an owner-role holder of the owning Group - the Project owner is an ACTIVE Group principal and the caller holds a LIVE owner row on it - also approves, with a step-up minted for action "charter.approve" and the Project id, sent as stepUpToken; else STEP_UP_REQUIRED with the stepUp challenge. Managers, inert owners and owners of a disabled Group stay CHARTER_APPROVAL_FORBIDDEN; the person owner and administrators approve as before, without a step-up. The Group-owner arm audit row adds { projectId, owningGroupId, standing: group-owner, stepUpTokenId }; its refusal adds { refusal, standing }.',
          responses: {
            '200': { description: 'Approved replacement or unchanged content' },
            '201': { description: 'Approved first version' },
            '400': { description: 'UNKNOWN_FIELD / REVISION_REQUIRED / VALUE_TOO_LONG / INVALID_PROJECT_ID' },
            '403': { description: 'Human Project approval authority required (CHARTER_APPROVAL_FORBIDDEN); STEP_UP_REQUIRED (gate (i), with the stepUp challenge)' },
            '404': { description: 'PROJECT_NOT_FOUND' },
            '422': { description: 'INVALID_CHARTER_VALUE' },
            '409': { description: 'Project archived' },
            '412': { description: 'Revision mismatch' },
          },
        },
      },
      '/projects/{id}/charter/versions': {
        get: { summary: 'Charter version metadata, newest first. Restore = PUT an old version\'s content back to the head.', parameters: [projectIdParam], responses: { '400': { description: 'INVALID_PROJECT_ID: the path id is not a full UUID (a Project name is not an id)' }, '200': { description: 'OK — { versions: [CharterVersionMeta] }' }, '404': { description: 'PROJECT_NOT_FOUND / CHARTER_NOT_FOUND' } } },
      },
      '/projects/{id}/charter/versions/{version}': {
        get: { summary: 'One Charter version, including content.', parameters: [projectIdParam, { name: 'version', in: 'path', required: true, schema: { type: 'integer', minimum: 1 } }], responses: { '200': { description: 'OK — { version }' }, '400': { description: 'INVALID_QUERY_VALUE / INVALID_PROJECT_ID' }, '404': { description: 'PROJECT_NOT_FOUND / CHARTER_NOT_FOUND / CHARTER_VERSION_NOT_FOUND' } } },
      },
      '/projects/{id}/brief': {
        post: { summary: 'Compile bounded standalone project awareness with an empty body (projects:read and tasks:read). Optional taskId preserves the task-bound Brief; that task must belong to this project — cross-project ids are concealed 404s. RH-P3.C4 (ii) / D4 retired the generate-brief spelling; it is not aliased.', parameters: [projectIdParam], responses: { '200': { description: 'OK — { brief, tokenEstimate }' }, '400': { description: 'UNKNOWN_FIELD / INVALID_BODY / invalid supplied taskId / INVALID_PROJECT_ID' }, '404': { description: 'PROJECT_NOT_FOUND / TASK_NOT_FOUND (concealed)' }, '503': { description: 'CHARTER_LOOKUP_FAILED / GOAL_LOOKUP_FAILED / PHASE_LOOKUP_FAILED — a lookup failure is not confirmed absence; the compile fails closed rather than omitting required context' } } },
      },
      '/personalities': crudPath('List personalities', 'Create a board-managed personality'),
      '/personalities/{id}': {
        get: { summary: 'Get personality by UUID or slug', responses: { '200': { description: 'OK' }, '404': { description: 'Not found' } } },
        patch: { summary: 'Update an active board-managed personality', responses: { '200': { description: 'OK' }, '400': { description: 'Invalid or empty field / INVALID_PERSONALITY_ID' }, '404': { description: 'Not found' }, '409': { description: 'Built-in and imported personalities are read-only' } } },
        delete: { summary: 'Soft-retire a board-managed personality while preserving history', responses: { '400': { description: 'INVALID_PERSONALITY_ID: the path id is not a full UUID (address the Personality by its id; GET /personalities/{slug} returns it)' }, '200': { description: 'Retired' }, '404': { description: 'Not found' }, '409': { description: 'Built-in, imported, and generalist personalities are protected' } } },
      },
      '/skills': {
        get: { summary: 'List Agent Skills catalog and visible immutable Version metadata (skills:read). Card d67e6990: each Skill carries owner_principal_id, owner_kind (human | group) and owner_display_name. Published Versions are shared; an unpublished Version is listed to a registry manager (skills:write, skills:admin or root) only when the Skill is unowned, owned by the Account of the caller, or owned by a Group that Account is an active member of; a registry administrator (root or skills:admin) also sees Skills whose newest Version is in review, and the drafts of every owner with owner=all.', parameters: [
          { name: 'category', in: 'query', schema: { type: 'string' } },
          { name: 'tag', in: 'query', schema: { type: 'string' } },
          { name: 'search', in: 'query', schema: { type: 'string' }, description: 'Matches name and description' },
          { name: 'owner', in: 'query', schema: { type: 'string', enum: ['all'] }, description: 'all: the drafts of every owner (root or skills:admin only)' },
        ], responses: { '200': { description: 'OK — { success, skills, viewer: { administrator, allOwners } }' }, '400': { description: 'INVALID_QUERY_VALUE (owner must be all)' }, '403': { description: 'SKILLS_ADMIN_REQUIRED (owner=all without root or skills:admin)' } } },
        post: { summary: 'Create a stable Skill identity and immutable draft Version (skills:write; resolved Principal required)', responses: { '201': { description: 'Created — { success, skill }' }, '400': { description: 'UNKNOWN_FIELD / VALUE_TOO_LONG' }, '403': { description: 'PRINCIPAL_REQUIRED' }, '409': { description: 'SKILL_NAME_TAKEN' }, '422': { description: 'INVALID_SKILL_VALUE (details.field names the field; provenance must match the caller Principal kind: human -> human-authored or imported, agent/service -> agent-drafted or imported) / INVALID_SKILL_DOCUMENT' } } },
      },
      '/skills/{id}': {
        get: { summary: 'Get skill by UUID', parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }], responses: { '200': { description: 'OK — { success, skill }' }, '400': { description: 'INVALID_SKILL_ID: the path id is not a full UUID (a Skill name is not an id)' }, '404': { description: 'Not found' } } },
        put: { summary: 'Create the next immutable draft Version; never mutate prior content (skills:write, revision-bound)', parameters: [{ ...ifMatchParam, required: true }], responses: { '201': { description: 'Draft created — { success, skill }' }, '400': { description: 'UNKNOWN_FIELD / REVISION_REQUIRED / VALUE_TOO_LONG / INVALID_SKILL_ID' }, '403': { description: 'PRINCIPAL_REQUIRED' }, '404': { description: 'SKILL_NOT_FOUND' }, '412': { description: 'REVISION_MISMATCH' }, '422': { description: 'INVALID_SKILL_VALUE (details.field names the field; provenance must match the caller Principal kind: human -> human-authored or imported, agent/service -> agent-drafted or imported) / INVALID_SKILL_DOCUMENT' } } },
        delete: { summary: 'Restricted hard delete (skills:admin); refused while history or pins exist', parameters: [{ ...ifMatchParam, required: true }], responses: { '200': { description: 'Deleted' }, '400': { description: 'UNKNOWN_FIELD / REVISION_REQUIRED / INVALID_SKILL_ID' }, '404': { description: 'SKILL_NOT_FOUND' }, '409': { description: 'SKILL_HAS_HISTORY' }, '412': { description: 'REVISION_MISMATCH' } } },
      },
      '/skills/{id}/versions': {
        get: { summary: 'List immutable Version metadata newest first (skills:read)', responses: { '200': { description: 'OK — { success, versions }' }, '400': { description: 'INVALID_SKILL_ID: the path id is not a full UUID (a Skill name is not an id)' }, '404': { description: 'SKILL_NOT_FOUND' } } },
      },
      '/skills/{id}/versions/{version}': {
        get: { summary: 'Get exact immutable Version metadata by number or UUID (skills:read)', responses: { '200': { description: 'OK — { success, version }' }, '400': { description: 'INVALID_SKILL_ID / INVALID_SKILL_VERSION_ID: the path id is not a full UUID, or the Version reference is neither a Version UUID nor a Version number' }, '404': { description: 'SKILL_VERSION_NOT_FOUND' } } },
      },
      '/skills/{id}/versions/{version}/content': {
        get: { summary: 'Fetch exact full SKILL.md with digest ETag (skills:use)', responses: { '200': { description: 'OK — { success, version.skill_md }' }, '400': { description: 'INVALID_SKILL_ID / INVALID_SKILL_VERSION_ID: the path id is not a full UUID, or the Version reference is neither a Version UUID nor a Version number' }, '404': { description: 'SKILL_VERSION_NOT_FOUND' } } },
      },
      '/skills/{id}/versions/{version}/submit-review': {
        post: { summary: 'Move draft to review (skills:write; revision-bound)', responses: { '200': { description: 'Review requested' }, '400': { description: 'INVALID_SKILL_ID / INVALID_SKILL_VERSION_ID: the path id is not a full UUID, or the Version reference is neither a Version UUID nor a Version number' }, '409': { description: 'SKILL_LIFECYCLE_CONFLICT' }, '412': { description: 'REVISION_MISMATCH' } } },
      },
      '/skills/{id}/versions/{version}/reject': {
        post: { summary: 'Return review to draft with an optional note (skills:write; revision-bound)', responses: { '200': { description: 'Returned to draft' }, '400': { description: 'INVALID_SKILL_ID / INVALID_SKILL_VERSION_ID: the path id is not a full UUID, or the Version reference is neither a Version UUID nor a Version number' }, '409': { description: 'SKILL_LIFECYCLE_CONFLICT' }, '412': { description: 'REVISION_MISMATCH' } } },
      },
      '/skills/{id}/versions/{version}/publish': {
        post: { summary: 'Publish after independent human-admin review (skills:admin; revision-bound)', responses: { '200': { description: 'Published' }, '400': { description: 'INVALID_SKILL_ID / INVALID_SKILL_VERSION_ID: the path id is not a full UUID, or the Version reference is neither a Version UUID nor a Version number' }, '403': { description: 'HUMAN_REVIEW_REQUIRED' }, '409': { description: 'INDEPENDENT_REVIEW_REQUIRED / SKILL_LIFECYCLE_CONFLICT' }, '412': { description: 'REVISION_MISMATCH' } } },
      },
      '/skills/{id}/versions/{version}/retire': {
        post: { summary: 'Terminal retirement (skills:admin); existing exact pins keep resolving', responses: { '200': { description: 'Retired' }, '400': { description: 'INVALID_SKILL_ID / INVALID_SKILL_VERSION_ID: the path id is not a full UUID, or the Version reference is neither a Version UUID nor a Version number' }, '409': { description: 'SKILL_LIFECYCLE_CONFLICT' }, '412': { description: 'REVISION_MISMATCH' } } },
      },
      '/skills/{id}/owner': {
        put: { summary: 'Assign or change the Skill owner (card d67e6990; skills:admin, point action admin; revision-bound). The owner is an active person Account or, through AZ-A12 clause 9(e), an active Group: any transfer into, out of or between Groups is a login-session act by root or an administrator with a step-up bound to (ownership.transfer, skill id). Writes one skill.owner.change audit row. Publication is unchanged: the creator of a Version never publishes it (INDEPENDENT_REVIEW_REQUIRED).', parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }, { ...ifMatchParam, required: true }], requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', additionalProperties: false, required: ['ownerPrincipalId', 'reason'], properties: { ownerPrincipalId: { type: 'string', format: 'uuid' }, reason: { type: 'string', maxLength: 2000 }, stepUpToken: { type: 'string', description: 'Required only when the current or the new owner is a Group' } } } } } }, responses: { '200': { description: 'OK — { success, changed, skill }' }, '400': { description: 'UNKNOWN_FIELD / REVISION_REQUIRED / INVALID_SKILL_ID' }, '403': { description: 'Route ceiling (skills:admin) / GROUP_OWNER_SESSION_ONLY / GROUP_OWNER_REQUIRES_ADMINISTRATOR / STEP_UP_REQUIRED (with the stepUp challenge)' }, '404': { description: 'SKILL_NOT_FOUND / RESOURCE_NOT_FOUND' }, '412': { description: 'REVISION_MISMATCH' }, '422': { description: 'INVALID_SKILL_OWNER (not an active person Account or Group) / INVALID_SKILL_VALUE (reason)' } } },
      },
      '/skills/{id}/audience': {
        patch: { summary: 'Set or remove broad global audience (skills:admin; current publication required)', responses: { '200': { description: 'Audience changed' }, '400': { description: 'INVALID_SKILL_ID: the path id is not a full UUID (a Skill name is not an id)' }, '412': { description: 'REVISION_MISMATCH' }, '422': { description: 'INVALID_SKILL_VALUE' } } },
      },
      '/projects/{id}/skills': {
        get: { summary: 'List exact immutable Skill Version pins. Legacy /projects/{id}/tools answers 409 LEGACY_COMPATIBILITY_ONLY.', parameters: [projectIdParam], responses: { '400': { description: 'INVALID_PROJECT_ID: the path id is not a full UUID (a Project name is not an id)' }, '200': { description: 'OK — { success, skills }' }, '404': { description: 'PROJECT_NOT_FOUND' } } },
      },
      '/projects/{id}/skills/{skillId}': {
        put: { summary: 'Create or replace an exact pin; target Version must currently be published', responses: { '400': { description: 'INVALID_PROJECT_ID: the path id is not a full UUID (a Project name is not an id) / INVALID_SKILL_ID' }, '200': { description: 'Pinned' }, '409': { description: 'PROJECT_ARCHIVED / PUBLISHED_VERSION_REQUIRED' } } },
        delete: { summary: 'Remove an exact Project Skill pin', responses: { '400': { description: 'INVALID_PROJECT_ID: the path id is not a full UUID (a Project name is not an id) / INVALID_SKILL_ID' }, '200': { description: 'Pin removed' }, '404': { description: 'SKILL_PIN_NOT_FOUND' }, '409': { description: 'PROJECT_ARCHIVED' } } },
      },
      '/services': {
        get: { summary: 'List registered services (a Connector is a kind of Service that pulls and executes work; retired services excluded by default)', parameters: [
          { name: 'kind', in: 'query', schema: { type: 'string', enum: ['service', 'connector'] } },
          { name: 'status', in: 'query', schema: { type: 'string', enum: ['draft', 'published', 'retired'] } },
          { name: 'includeRetired', in: 'query', schema: { type: 'boolean' } },
        ], responses: { '200': { description: 'OK — { success, services }' } } },
        post: { summary: 'Register a service (services:write; starts draft, direct mode, assigned-only tier). Subscription-class fields (delivery, visibility tier) are owner-plane only — see /services/{id}/owner-plane. CONNECTOR registrations by an authenticated LOGIN SESSION may pass issueCredential {scopes, label?, transport?} to mint the first credential in the same call and receive the ONE-TIME §7.4 onboarding pack (AZ-S5; non-root sessions: scopes ⊆ the session\'s current effective set — §5.2 rule 1; bearer callers issue through POST /principals/{id}/credentials, whose connector responses also carry the pack). CONNECTOR registrations may also pass descriptor {options, telemetry?, ...}: the connector\'s FIRST capability descriptor, validated and published as version 1 in the same transaction, after which the service is published (the harness wizard\'s one-call registration; telemetryTier defaults to the descriptor\'s declared tier). A descriptor on a non-connector registration is refused.', responses: { '201': { description: 'Created — { success, service, onboarding? }' }, '409': { description: 'SERVICE_SLUG_TAKEN' }, '422': { description: 'INVALID_SERVICE_VALUE (incl. a descriptor on a non-connector registration) / DESCRIPTOR_* validation failures, each naming the exact field / BROKERED_MODE_NOT_AVAILABLE (v1 runs direct-mode services only, C5)' } } },
      },
      '/services/{id}': {
        get: { summary: 'Get service by UUID or slug', responses: { '200': { description: 'OK — { success, service }' }, '404': { description: 'SERVICE_NOT_FOUND' } } },
        patch: { summary: 'Update metadata (name/description/telemetryTier/status draft→published; revision-bound via If-Match). Publishing requires a descriptor version; retirement has its own admin surface.', responses: { '200': { description: 'OK' }, '400': { description: 'UNKNOWN_FIELD / REVISION_REQUIRED' }, '404': { description: 'SERVICE_NOT_FOUND' }, '409': { description: 'SERVICE_RETIRED / SERVICE_HAS_NO_DESCRIPTOR' }, '412': { description: 'REVISION_MISMATCH' } } },
        delete: { summary: 'Hard removal (services:admin) — restricted, never the routine path; retire is the ordinary end of life (§4.4)', responses: { '200': { description: 'Deleted' }, '404': { description: 'SERVICE_NOT_FOUND' } } },
      },
      '/services/{id}/owner-plane': {
        patch: { summary: 'Owner-plane (subscription-class §2.6.4) fields behind the root sentinel: deliveryMode/deliveryEndpoint/deliverySecret/deliveryPollIntervalSeconds, visibilityTier, runtimeMode. Never agent-plane writable — a prompt-injected connector must not repoint its own delivery. This descriptor is the SINGLE SOURCE OF TRUTH for delivery to this Connector on BOTH planes (ruling ccd53781 R1); deliveryMode=webhook requires deliveryEndpoint AND deliverySecret (unsigned delivery is not representable). deliverySecret is WRITE-ONLY — reads report deliveryHasSecret.', responses: { '200': { description: 'OK' }, '400': { description: 'UNKNOWN_FIELD / REVISION_REQUIRED' }, '404': { description: 'SERVICE_NOT_FOUND' }, '412': { description: 'REVISION_MISMATCH' }, '422': { description: 'INVALID_SERVICE_VALUE / BROKERED_MODE_NOT_AVAILABLE' } } },
      },
      '/services/{id}/descriptor': {
        get: { summary: 'The current capability-descriptor version (options, per-option E-17 parameter schemas, declared Tools, discovery/health seats)', responses: { '200': { description: 'OK — { success, descriptorVersion }' }, '404': { description: 'SERVICE_NOT_FOUND / DESCRIPTOR_NOT_FOUND' } } },
        put: { summary: 'Publish a NEW immutable descriptor version (services:write, revision-bound). Identical content is refused (DESCRIPTOR_UNCHANGED). secretReference entries carry connector-resolved reference NAMES, never secret material (RH-DESIGN.5 R5).', responses: { '201': { description: 'Published — { success, service, descriptorVersion }' }, '404': { description: 'SERVICE_NOT_FOUND' }, '409': { description: 'DESCRIPTOR_UNCHANGED / SERVICE_RETIRED' }, '412': { description: 'REVISION_MISMATCH' }, '422': { description: 'DESCRIPTOR_* validation failures, each naming the exact field' } } },
      },
      '/services/{id}/descriptor/versions': {
        get: { summary: 'Descriptor version metadata, newest first (immutable record; retired versions stay listed)', responses: { '200': { description: 'OK — { success, versions }' }, '404': { description: 'SERVICE_NOT_FOUND' } } },
      },
      '/services/{id}/descriptor/versions/{version}': {
        get: { summary: 'One descriptor version, including content — the exact bytes an execution-profile pin resolves to', parameters: [{ name: 'version', in: 'path', required: true, schema: { type: 'integer', minimum: 1 } }], responses: { '400': { description: 'INVALID_QUERY_VALUE: version is not a positive integer up to 2147483647' }, '200': { description: 'OK — { success, descriptorVersion }' }, '404': { description: 'SERVICE_NOT_FOUND / DESCRIPTOR_VERSION_NOT_FOUND' } } },
      },
      '/services/{id}/retire': {
        post: { summary: 'Retire the service (services:admin; irreversible §4.4): stops new consumers, record and versions stay', responses: { '200': { description: 'OK' }, '404': { description: 'SERVICE_NOT_FOUND' }, '409': { description: 'SERVICE_RETIRED' }, '412': { description: 'REVISION_MISMATCH' } } },
      },
      '/services/{id}/descriptor/versions/{version}/retire': {
        post: { summary: 'Retire ONE descriptor version (services:admin; RH-DESIGN.5 R5 staged retirement): existing pins keep resolving, profile paths refuse retired pins', parameters: [{ name: 'version', in: 'path', required: true, schema: { type: 'integer', minimum: 1 } }], responses: { '400': { description: 'INVALID_QUERY_VALUE: version is not a positive integer up to 2147483647' }, '200': { description: 'OK — { success, version }' }, '404': { description: 'SERVICE_NOT_FOUND / DESCRIPTOR_VERSION_NOT_FOUND' }, '409': { description: 'DESCRIPTOR_VERSION_RETIRED' } } },
      },
      '/phases': {
        get: { summary: 'List Phases — the grouping object between Project and Task (phases:read). Ordered by (position, created_at, id); position orders but does not exclude, because Phases may overlap. Archived Phases are excluded unless includeArchived=true or status=archived.', parameters: [
          { name: 'projectId', in: 'query', schema: { type: 'string', format: 'uuid' } },
          { name: 'status', in: 'query', schema: { type: 'string', enum: ['todo', 'in-progress', 'completed', 'archived'] } },
          { name: 'includeArchived', in: 'query', schema: { type: 'boolean' } },
        ], responses: { '200': { description: 'OK — { success, phases }' }, '400': { description: 'INVALID_QUERY_VALUE / UNKNOWN_FIELD' } } },
        post: { summary: 'Create a Phase under an ACTIVE, readable Project (phases:write plus parent Project read). Body: { projectId, name, goal?, status?, position? }. projectId is a full UUID; goal is the outcome PROPERTY. status accepts todo | in-progress | completed — archiving has its own verb. A retry checks Project readability again before returning a stored receipt.', responses: { '201': { description: 'Created — { success, phase }' }, '404': { description: 'PROJECT_NOT_FOUND for absent or unreadable Project' }, '409': { description: 'PROJECT_ARCHIVED' }, '422': { description: 'INVALID_PHASE_VALUE' }, '503': { description: 'AUTHORIZATION_UNAVAILABLE' } } },
      },
      '/phases/{id}': {
        get: { summary: 'Get one Phase (phases:read). Absence and denial are the same concealed 404.', parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }], responses: { '200': { description: 'OK — { success, phase }' }, '404': { description: 'PHASE_NOT_FOUND' } } },
        patch: { summary: 'Update a Phase (phases:write). revision is the If-Match guard. Archived Phases are read-only — unarchive first.', parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }], responses: { '200': { description: 'OK — { success, phase }' }, '404': { description: 'PHASE_NOT_FOUND' }, '409': { description: 'REVISION_MISMATCH / PHASE_ARCHIVED' }, '422': { description: 'INVALID_PHASE_VALUE' } } },
        delete: { summary: 'Hard-delete a Phase (phases:admin — the restricted verb, §4.4). Refused while Tasks still reference it (PHASE_IN_USE); prefer archive.', parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }], responses: { '200': { description: 'OK — { success, phase }' }, '404': { description: 'PHASE_NOT_FOUND' }, '409': { description: 'PHASE_IN_USE' } } },
      },
      '/phases/{id}/tasks': {
        get: { summary: "A Phase's member Tasks (phases:read AND tasks:read — it discloses Task content, exactly like the brief), id + title + status only: a phase-altitude view is a reading artifact; the machine path is the per-task Brief.", parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }], responses: { '200': { description: 'OK — { success, tasks }' }, '403': { description: 'BRIEF_TASKS_READ_REQUIRED' }, '404': { description: 'PHASE_NOT_FOUND' } } },
      },
      '/phases/{id}/default-verifier': {
        put: {
          summary: "Card 41e24358: set or clear the Phase's default Verifier, inherited by new Tasks landing in this Phase ahead of the Project default. The same gate as PUT /projects/{id}/default-verifier, resolved against the Phase's Project owner. Audited phase.default_verifier.set.",
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }, ifMatchParam],
          requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', additionalProperties: false, required: ['principalId'], properties: { principalId: { type: 'string', format: 'uuid', nullable: true } } } } } },
          responses: { '200': { description: 'OK - { success, phase: { id, projectId, defaultVerifierPrincipalId, revision }, previousDefaultVerifierPrincipalId }' }, '400': { description: 'REVISION_REQUIRED / UNKNOWN_FIELD' }, '403': { description: 'SESSION_ONLY / DEFAULT_VERIFIER_REQUIRES_OWNER' }, '404': { description: 'PHASE_NOT_FOUND' }, '409': { description: 'REVISION_MISMATCH / PHASE_ARCHIVED' }, '422': { description: 'INVALID_DEFAULT_VERIFIER / DEFAULT_VERIFIER_GROUP_PRINCIPAL / DEFAULT_VERIFIER_AGENT_PRINCIPAL / DEFAULT_VERIFIER_UNUSABLE' }, '503': { description: 'DEFAULT_VERIFIER_UNAVAILABLE' } },
        },
      },
      '/phases/{id}/access': {
        patch: { summary: 'Explicitly enable or disable exceptional restricted access (phases:admin). Body: { revision, restricted, reason }. Project visibility is inherited by default; grants remain additive and never toggle this mode. Every change is attributed in the append-only Phase access ledger.', parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }], responses: { '200': { description: 'OK — { success, phase }' }, '403': { description: 'PRINCIPAL_REQUIRED / FORBIDDEN' }, '404': { description: 'PHASE_NOT_FOUND' }, '409': { description: 'REVISION_MISMATCH / PHASE_ACCESS_UNCHANGED' }, '422': { description: 'INVALID_PHASE_ACCESS' } } },
      },
      '/phases/{id}/archive': {
        post: { summary: 'Archive a Phase (phases:write; reversible per §4.4). Body: { revision }.', parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }], responses: { '200': { description: 'OK — { success, phase }' }, '404': { description: 'PHASE_NOT_FOUND' }, '409': { description: 'REVISION_MISMATCH / PHASE_ALREADY_ARCHIVED' } } },
      },
      '/phases/{id}/unarchive': {
        post: { summary: 'Unarchive a Phase back to todo (phases:write). Body: { revision }.', parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }], responses: { '200': { description: 'OK — { success, phase }' }, '404': { description: 'PHASE_NOT_FOUND' }, '409': { description: 'REVISION_MISMATCH / PHASE_NOT_ARCHIVED' } } },
      },
      '/phases/{id}/brief': {
        post: { summary: 'Compile the phase-altitude Brief (phases:read AND tasks:read — the output discloses Task content). Carries the project Charter and fails closed if the Charter lookup fails. Member Tasks render as id + title + status inside a quoted-JSON block.', parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }], responses: { '200': { description: 'OK — { success, brief, tokenEstimate }' }, '403': { description: 'BRIEF_TASKS_READ_REQUIRED' }, '404': { description: 'PHASE_NOT_FOUND' }, '503': { description: 'CHARTER_LOOKUP_FAILED — a lookup failure is not confirmed absence; the compile fails closed' } } },
      },
      '/projects/{id}/phases': {
        get: { summary: "A Project's Phases (projects:read), the same rows as /phases?projectId= but reached through the Project family.", parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }, { name: 'includeArchived', in: 'query', schema: { type: 'boolean' } }], responses: { '400': { description: 'INVALID_PROJECT_ID: the path id is not a full UUID (a Project name is not an id)' }, '200': { description: 'OK — { success, phases }' }, '404': { description: 'PROJECT_NOT_FOUND' } } },
      },
      '/groups': {
        get: { summary: 'List Groups with member counts (principals:read — directory disclosure, A12.5). Groups are board-minted, immutable-id member sets of Accounts (A17.6); mutation is owner-plane.', responses: { '200': { description: 'OK — { success, groups } (each Group carries ownershipStatus: its Group principal status, AZ-A12)' } } },
        post: { summary: 'Create a Group (owner plane, root — §9.1, T13). Names are unique case-insensitively.', responses: { '201': { description: 'Created — { success, group }' }, '409': { description: 'GROUP_NAME_EXISTS' }, '422': { description: 'INVALID_GROUP_VALUE' } } },
      },
      '/groups/directory-sync': {
        get: { summary: 'Directory-sync staleness read (root; AZ-30 seam): per-provider snapshot watermark, error flag and stale verdict past the threshold (default 24h). The provider binding itself is Phase 5 (task 2ae39bda).', responses: { '200': { description: 'OK — { success, providers }' } } },
      },
      '/groups/{id}': {
        get: { summary: 'One Group with member count (principals:read).', parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }], responses: { '200': { description: 'OK — { success, group } (group.ownershipStatus: active | disabled, the Group principal status, AZ-A12 clause 2)' }, '404': { description: 'GROUP_NOT_FOUND' } } },
        patch: { summary: 'Rename / redescribe / FEATURE a Group (owner plane, root; REST only, never MCP). The id is immutable (A17.6). RH-LENSES-b (design 96f0bd3d s7.1): `featured` is presentation-level promotion - it GRANTS NOTHING, no authorization predicate reads it, and an unfeatured Group keeps every member and grant it has. It decides which Groups a person may choose as a home group, and a change is audited as `group.feature_set` with old and new. Accepted fields: name, description, featured. Directory binding fields are NOT written here: the directory group reference catalog is the single seam that binds a Group, inside its carriage transaction.', parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }], responses: { '200': { description: 'OK — { success, group }' }, '404': { description: 'GROUP_NOT_FOUND' }, '409': { description: 'GROUP_NAME_EXISTS / DIRECTORY_BINDING_MANAGED (binding fields require the directory group reference catalog)' } } },
        delete: { summary: 'Delete an EMPTY Group (owner plane, root); its group-grant rows are deleted in the same transaction — grants are live configuration.', parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }], responses: { '200': { description: 'OK — { success, group }' }, '404': { description: 'GROUP_NOT_FOUND' }, '409': { description: 'GROUP_NOT_EMPTY; GROUP_GATES_LOGIN; GROUP_IS_A_HOME_GROUP - RH-LENSES-b (A-L38): some Accounts still have this Group as their home group. The refusal names the COUNT and never the identities; clear them with DELETE /groups/{id}/home-pointers first. GROUP_OWNS_OBJECTS (AZ-A12 clause 2, checked after the three above): a Project owner, Task account owner, Report account owner or Skill owner still names this Group; details.owned = { projects, tasks, reports, skills } - counts, never ids. GROUP_HAS_STEWARDS (LENSES-c c1-A, checked next): steward rows, live or inert, remain; details.stewards is a count, never ids - see GET /groups/{id}/stewards and remove them first. A delete that passes also TERMINATES the Group principal (terminated_at stamped) in the same transaction; the principal row is kept.' } } },
      },
      '/groups/{id}/ownership-status': {
        put: {
          summary: 'AZ-A12 clause 2 (card 20f40e40): enable or disable the Group PRINCIPAL. A ROOT LOGIN-SESSION act with step-up (§5.2 rule 4, clause 14; DD-12): the /groups ceiling is root, a bearer credential is refused REQUIRES_LOGIN_SESSION, a non-root session ROOT_SESSION_REQUIRED. The step-up is minted through POST /auth/step-up for action "group.ownership_status" and the Group id in LOWERCASE; the path id may be any case. Refusals that precede the consume - including GROUP_OWNERSHIP_STATUS_UNCHANGED - never spend it. Disabling suspends ownership only: membership and the Group grants are untouched (note N3). Audited group.principal_enable / group.principal_disable { groupId, from, to, reason, stepUpTokenId }; every refusal is audited with outcome denied. REST only, never MCP.',
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
          requestBody: { required: true, content: { 'application/json': { schema: {
            type: 'object', required: ['enabled', 'reason', 'stepUpToken'], additionalProperties: false,
            properties: {
              enabled: { type: 'boolean' },
              reason: { type: 'string', minLength: 1, maxLength: 500, description: 'Trimmed; 1 to 500 characters.' },
              stepUpToken: { type: 'string', description: 'Single-use, bound to ("group.ownership_status", the lowercase Group id).' },
            },
          } } } },
          responses: {
            '200': { description: 'OK - { success, group, from, to }' },
            '400': { description: 'UNKNOWN_FIELD; INVALID_GROUP_ID' },
            '403': { description: 'FORBIDDEN (the root ceiling); REQUIRES_LOGIN_SESSION; ROOT_SESSION_REQUIRED; STEP_UP_REQUIRED' },
            '404': { description: 'GROUP_NOT_FOUND' },
            '409': { description: 'GROUP_OWNERSHIP_STATUS_UNCHANGED - the Group principal already has that status; the step-up is not spent' },
            '422': { description: 'INVALID_GROUP_VALUE - enabled must be a boolean; reason 1 to 500 characters' },
          },
        },
      },
      '/groups/{id}/stewards': {
        get: {
          summary: 'LENSES-c c1-A (card 46cfbd1d; design delta C.3): the Group ROLES (principals:read: Group roles are directory data, like membership). Owners first. Each row carries live and inertReason: a row is LIVE only while its holder is active, a member of the Group by any source, and holds no elevated role (admin, operator, orchestrator); otherwise inertReason names the first that fails, in the order principal_inactive, elevated_role, not_a_member. An inert row confers nothing. REST only, never MCP.',
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
          responses: {
            '200': { description: 'OK - { success, stewards: [{ accountPrincipalId, handle, kind, status, role: owner | manager, appointedByPrincipalId, appointedAt, live, inertReason }] }' },
            '400': { description: 'INVALID_GROUP_ID' },
            '404': { description: 'GROUP_NOT_FOUND' },
          },
        },
        post: {
          summary: 'LENSES-c c1-A (card 46cfbd1d; design delta C.3; E57): APPOINT a Group role. A ROOT LOGIN-SESSION act: the /groups ceiling is root (an operator or editor session is refused FORBIDDEN there), a bearer credential holding root is refused REQUIRES_LOGIN_SESSION. The handler also refuses a session without root ROOT_SESSION_REQUIRED, as defence in depth only: the root ceiling stops such a session with FORBIDDEN first, so that code is not reachable today. No step-up. Membership and active status are NOT required: such a row is appointed inert and flagged. The holder must be a parentless, non-legacy human or service Account holding no elevated role (STEWARD_INELIGIBLE names which rule). Audited group.steward_appoint { groupId, accountPrincipalId, role, appointedBy, standing: root, liveAtWrite, via, chain }; every refusal the handler makes is audited with outcome denied; the ceiling-stage FORBIDDEN is answered by the scope middleware before the handler runs and is NOT audited as group.steward_appoint. REST only, never MCP.',
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
          requestBody: { required: true, content: { 'application/json': { schema: {
            type: 'object', required: ['accountPrincipalId', 'role'], additionalProperties: false,
            properties: {
              accountPrincipalId: { type: 'string', format: 'uuid' },
              role: { type: 'string', enum: ['owner', 'manager'] },
            },
          } } } },
          responses: {
            '201': { description: 'Created - { success, steward }' },
            '400': { description: 'UNKNOWN_FIELD; INVALID_GROUP_ID' },
            '403': { description: 'FORBIDDEN (the root ceiling; not audited as a steward act); REQUIRES_LOGIN_SESSION; ROOT_SESSION_REQUIRED (defence in depth: unreachable behind the root ceiling)' },
            '404': { description: 'GROUP_NOT_FOUND' },
            '409': { description: 'ALREADY_A_STEWARD - details.role names the role the Account already holds in this Group' },
            '422': { description: 'INVALID_GROUP_VALUE (both fields are required; role is owner or manager); STEWARD_NOT_FOUND (no such principal); STEWARD_INELIGIBLE - details.reason is kind, parented, legacy or elevated_role' },
          },
        },
      },
      '/groups/{id}/stewards/{principalId}': {
        delete: {
          summary: 'LENSES-c c1-A (card 46cfbd1d; design delta C.3): REMOVE a Group role row, owner or manager, live or inert. A ROOT LOGIN-SESSION act, with the same two in-handler tests as the appointment (ROOT_SESSION_REQUIRED is defence in depth behind the root ceiling, which answers a session without root FORBIDDEN first). Termination never removes a steward row: a terminated holder keeps an inert row until this act removes it. Audited group.steward_remove { groupId, accountPrincipalId, role, appointedBy, standing: root, liveAtWrite, via, chain }; every refusal the handler makes is audited with outcome denied; the ceiling-stage FORBIDDEN is not audited. REST only, never MCP.',
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }, { name: 'principalId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
          responses: {
            '200': { description: 'OK - { success, removed: { accountPrincipalId, role } }' },
            '400': { description: 'INVALID_GROUP_ID; INVALID_GROUP_VALUE (principalId is not a UUID)' },
            '403': { description: 'FORBIDDEN (the root ceiling; not audited as a steward act); REQUIRES_LOGIN_SESSION; ROOT_SESSION_REQUIRED (defence in depth: unreachable behind the root ceiling)' },
            '404': { description: 'GROUP_NOT_FOUND; STEWARD_NOT_FOUND (the Account holds no role in this Group)' },
          },
        },
      },
      '/groups/{id}/managers': {
        post: {
          summary: 'LENSES-c c1-B (card b5c83682; design delta C.4, gate (iii); ruling E57 (iii)): a Group OWNER appoints a MANAGER in that Group. The route ceiling is authenticated; the boundary is the in-handler predicate, in order, in one transaction: (1) a login session, else GROUP_MANAGER_APPOINT_REQUIRES_SESSION; (2) a human Account acting as itself, else GROUP_MANAGER_APPOINT_REQUIRES_OWNER; (3) a LIVE owner row on this Group, else GROUP_MANAGER_APPOINT_REQUIRES_OWNER (also for a Group that does not exist); (4) the appointee: an ACTIVE member of this Group by any source, else MANAGER_NOT_A_GROUP_MEMBER; not already holding a role here, else ALREADY_A_STEWARD (naming the role; the caller own row refuses self-appointment); admitted by the holder rules, else STEWARD_INELIGIBLE with its reason; (5) a step-up minted through POST /auth/step-up for action "group.manager_appoint" and the Group id in LOWERCASE, else STEP_UP_REQUIRED. No refusal spends the token. The role is fixed to manager: a body role key is refused UNKNOWN_FIELD, and no owner ever appoints an owner (a root login session appoints owners through POST /groups/{id}/stewards). Root, administrators and operators never pass step (3). Audited group.steward_appoint { role: manager, standing: group-owner, stepUpTokenId, liveAtWrite, via, chain }; every refusal is audited with outcome denied. REST only, never MCP.',
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
          requestBody: { required: true, content: { 'application/json': { schema: {
            type: 'object', additionalProperties: false, required: ['accountPrincipalId'],
            properties: {
              accountPrincipalId: { type: 'string', format: 'uuid', description: 'The appointee: an active member of this Group.' },
              stepUpToken: { type: 'string', description: 'Single-use, bound to ("group.manager_appoint", the lowercase Group id). Steps (1)-(4) are answered first; once they pass, an absent or invalid token is 403 STEP_UP_REQUIRED.' },
            },
          } } } },
          responses: {
            '201': { description: 'Created - { success, steward: { accountPrincipalId, handle, kind, status, role: manager, appointedByPrincipalId, appointedAt, live, inertReason }, stepUpTokenId }' },
            '400': { description: 'UNKNOWN_FIELD (a role key included); INVALID_GROUP_ID' },
            '403': { description: 'GROUP_MANAGER_APPOINT_REQUIRES_SESSION; GROUP_MANAGER_APPOINT_REQUIRES_OWNER; STEP_UP_REQUIRED (with the stepUp challenge)' },
            '409': { description: 'ALREADY_A_STEWARD' },
            '422': { description: 'INVALID_GROUP_VALUE; MANAGER_NOT_A_GROUP_MEMBER; STEWARD_INELIGIBLE' },
          },
        },
      },
      '/groups/{id}/managers/{principalId}': {
        delete: {
          summary: 'LENSES-c c1-A (card 46cfbd1d; design delta C.4 removal, ruling E98 Q3): a Group OWNER removes a MANAGER row in that Group. The route ceiling is authenticated; the boundary is the in-handler predicate, in order, in one transaction: (1) a login session, else GROUP_MANAGER_REMOVE_REQUIRES_SESSION; (2) a human Account acting as itself, else GROUP_MANAGER_REMOVE_REQUIRES_OWNER; (3) a LIVE owner row on this Group, else GROUP_MANAGER_REMOVE_REQUIRES_OWNER (also for a Group that does not exist); (4) the target row: absent STEWARD_NOT_FOUND, an owner row STEWARD_OWNER_ROW_ROOT_ONLY (owner rows, the caller own included, are removed only by a root login session), a manager row admitted live or inert; (5) a step-up minted through POST /auth/step-up for action "group.manager_remove" and the Group id in LOWERCASE, else STEP_UP_REQUIRED. No refusal spends the token. Root, administrators and operators never pass step (3). Audited group.steward_remove { role: manager, standing: group-owner, stepUpTokenId, liveAtWrite, via, chain }; every refusal is audited with outcome denied. An owner appoints a manager through POST /groups/{id}/managers (c1-B); no owner appoints or removes an owner. REST only, never MCP.',
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }, { name: 'principalId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
          requestBody: { required: false, content: { 'application/json': { schema: {
            type: 'object', additionalProperties: false,
            properties: { stepUpToken: { type: 'string', description: 'Single-use, bound to ("group.manager_remove", the lowercase Group id). Optional in the schema: the body may omit it, and steps (1)-(4) are answered first; once they pass, an absent or invalid token is 403 STEP_UP_REQUIRED.' } },
          } } } },
          responses: {
            '200': { description: 'OK - { success, removed: { accountPrincipalId, role: manager }, stepUpTokenId }' },
            '400': { description: 'UNKNOWN_FIELD; INVALID_GROUP_ID; INVALID_GROUP_VALUE' },
            '403': { description: 'GROUP_MANAGER_REMOVE_REQUIRES_SESSION; GROUP_MANAGER_REMOVE_REQUIRES_OWNER; STEWARD_OWNER_ROW_ROOT_ONLY; STEP_UP_REQUIRED' },
            '404': { description: 'STEWARD_NOT_FOUND' },
          },
        },
      },
      '/groups/{id}/grants': {
        get: {
          summary: 'LENSES-c c1-A (card 46cfbd1d; design delta C.9, SR-2): the grants whose grantee is this Group (principals:read). A ROOT LOGIN SESSION sees the full rows; a LIVE steward of this Group (owner or manager) on a LOGIN SESSION sees them WITHOUT grantedByPrincipalId; every other caller - a bearer, a non-steward, an inert steward, a steward of another Group - receives 200 with an EMPTY LIST, never a 403. REST only, never MCP.',
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
          responses: {
            '200': { description: 'OK - { success, grants }' },
            '400': { description: 'INVALID_GROUP_ID' },
            '404': { description: 'GROUP_NOT_FOUND (root only; every other caller receives an empty list)' },
          },
        },
      },
      '/groups/{id}/members/{principalId}/access': {
        get: {
          summary: 'SR-3 (LENSES v5 section 6.4; AZ-A12 build 6, card 1e56dbef; principals:read): ONLY the authority reaching this member THROUGH this Group - the Group grants (each with live and reachesMember) and the objects whose owner value names the Group (Projects, Tasks, Reports and Skills), each with the actions the evaluator Group-owner arms give the member, and the member tier (edit, use or none). Never the member own grants, its Connectors or another Group reach. A ROOT LOGIN SESSION and a LIVE steward of this Group on a LOGIN SESSION see it; every other caller receives 200 with the empty answer (member null), never a 403. REST only, never MCP.',
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }, { name: 'principalId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
          responses: {
            '200': { description: 'OK - { success, access: { groupId, principalId, member, grants, owned, ownedTruncated } }' },
            '400': { description: 'INVALID_GROUP_ID / INVALID_PRINCIPAL_ID' },
            '404': { description: 'GROUP_NOT_FOUND' },
            '503': { description: 'ACCESS_EXPLORER_FAILED - the evaluation failed closed' },
          },
        },
      },
      '/access-explorer/objects/{type}/{id}': {
        get: {
          summary: 'AZ-A12 build 6 (card 1e56dbef; clause 12, E45 (3)): the Access Explorer object hop, read-only and derived at read (principals:read). The object, its owner (person or Group) and, for a Task, its Project owner; the board-wide classes (readable by every authenticated principal; the administrator roles; the root sentinel); and the holders of authority on it, each with the actions the enforcing evaluator admits and the arms that held (the object predicate, as the authority preview states it). An object the caller cannot read answers 404 RESOURCE_NOT_FOUND exactly as an absent one. A ROOT caller sees every holder, the grant rows naming the object (exact, typed wildcard, a Task Project rows; live and expired) (projection root): a grantee, a granted Group member and a profile assignee are listed as holders, and whether a profile rule covers the object is that holder verdict; any other caller sees the owner, the owning Groups and its OWN verdict only (projection self). REST only, never MCP.',
          parameters: [{ name: 'type', in: 'path', required: true, schema: { type: 'string', enum: ['task', 'phase', 'project', 'report', 'skill', 'personality', 'service'] } }, { name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
          responses: {
            '200': { description: 'OK - { success, explorer: { object, projection, owner, projectOwner, boardWide, groups, holders, holdersTruncated, grants, evaluatedAt, semantics } }' },
            '400': { description: 'INVALID_EXPLORER_TYPE / INVALID_EXPLORER_OBJECT_ID' },
            '403': { description: 'Route ceiling (principals:read)' },
            '404': { description: 'RESOURCE_NOT_FOUND - absent, or not readable by the caller' },
            '503': { description: 'ACCESS_EXPLORER_FAILED - the read fails closed' },
          },
        },
      },
      '/access-explorer/groups/{id}': {
        get: {
          summary: 'AZ-A12 build 6 (card 1e56dbef): the Access Explorer Group hop (principals:read; Groups, membership and Group roles are directory data). The Group (ownership status, member count) and its members, each with source (local or directory), Group role and whether the role row is live, and the tier the clause-6 fragment gives (edit, use or none; a disabled Group gives none); inert role rows are flagged with their reason. With objectType and objectId (an object the caller can read, else 404), a ROOT caller sees each member verdict on that object and any other caller only its own.',
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }, { name: 'objectType', in: 'query', schema: { type: 'string', enum: ['task', 'phase', 'project', 'report', 'skill', 'personality', 'service'] }, description: 'Given with objectId: add each listed principal verdict on that object' }, { name: 'objectId', in: 'query', schema: { type: 'string', format: 'uuid' } }],
          responses: {
            '200': { description: 'OK - { success, explorer: { group, object, projection, members, membersTruncated, inertRoles, evaluatedAt, semantics } }' },
            '400': { description: 'INVALID_GROUP_ID / INVALID_EXPLORER_QUERY / INVALID_EXPLORER_TYPE' },
            '404': { description: 'GROUP_NOT_FOUND / RESOURCE_NOT_FOUND' },
          },
        },
      },
      '/access-explorer/principals/{id}': {
        get: {
          summary: 'AZ-A12 build 6 (card 1e56dbef): the Access Explorer principal hop (principals:read). The principal and its children (an Account Connectors, a Connector Agents, each with its Warrant). Its authority - chain liveness, own() cap, grants (live and expired), Access profile assignments, Group memberships and the warrants it holds - is shown to a ROOT caller, to the principal itself and to a login session of an ancestor (the self-service subtree); every other caller gets the directory projection (authority null). With objectType and objectId, the principal and its children verdicts on that object. A Group principal is refused GROUP_PRINCIPAL_USE_GROUP_VIEW.',
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }, { name: 'objectType', in: 'query', schema: { type: 'string', enum: ['task', 'phase', 'project', 'report', 'skill', 'personality', 'service'] }, description: 'Given with objectId: add each listed principal verdict on that object' }, { name: 'objectId', in: 'query', schema: { type: 'string', format: 'uuid' } }],
          responses: {
            '200': { description: 'OK - { success, explorer: { principal, projection, children, childrenTruncated, object, authority, evaluatedAt, semantics } }' },
            '400': { description: 'INVALID_PRINCIPAL_ID / INVALID_EXPLORER_QUERY / INVALID_EXPLORER_TYPE' },
            '404': { description: 'PRINCIPAL_NOT_FOUND / RESOURCE_NOT_FOUND' },
            '422': { description: 'GROUP_PRINCIPAL_USE_GROUP_VIEW' },
            '503': { description: 'ACCESS_EXPLORER_FAILED - the read fails closed' },
          },
        },
      },
      '/groups/{id}/home-pointers': {
        delete: { summary: 'RH-LENSES-b (card 4287af8a; design 96f0bd3d s7.2): the ROOT-PLANE CLEAR ACT. Clears every home-group pointer at this Group in ONE transaction, one audited `home_group.clear` per Account, so a Group that GROUP_IS_A_HOME_GROUP refused can then be deleted. Owner plane, root; REST only, never MCP (B-L12). It clears a PREFERENCE and confers or removes no authority.', parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }], responses: { '200': { description: 'OK - { success, cleared }' }, '403': { description: 'FORBIDDEN - the route ceiling is the root sentinel, as it is for every non-GET /groups method' }, '404': { description: 'GROUP_NOT_FOUND' } } },
      },
      '/groups/{id}/members': {
        get: { summary: 'Kind-differentiated members with live principal status (principals:read; A17.6 — members are human and service Accounts only).', parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }], responses: { '200': { description: 'OK — { success, members }' }, '404': { description: 'GROUP_NOT_FOUND' } } },
        post: { summary: 'Add an ACTIVE Account member (owner plane, root — T13: agent credentials die at the route ceiling). Only source=local (default) is accepted; directory source is refused with 409 DIRECTORY_MEMBERSHIP_MANAGED. Local membership survives directory sync; delegated identities are never members (422/DB trigger).', parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }], responses: { '201': { description: 'Created — { success, member }' }, '404': { description: 'GROUP_NOT_FOUND' }, '409': { description: 'MEMBER_EXISTS / DIRECTORY_MEMBERSHIP_MANAGED' }, '422': { description: 'INVALID_GROUP_VALUE / MEMBER_NOT_FOUND / MEMBER_NOT_ACCOUNT / MEMBER_DISABLED' } } },
      },
      '/groups/{id}/members/{principalId}': {
        delete: { summary: 'Remove a member (owner plane, root). Only local membership can be removed here. A directory-derived row is concealed as MEMBER_NOT_FOUND; reconcile it through its directory producer.', parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }, { name: 'principalId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }], responses: { '200': { description: 'OK — { success }' }, '404': { description: 'GROUP_NOT_FOUND / MEMBER_NOT_FOUND' } } },
      },
      '/directory-group-references': {
        get: {
          summary:
            'The remote-group CATALOG (RH-LENSES-a, card 74e02a05): every external group value this '
            + 'board has OBSERVED at an Identity provider, with a member COUNT and never an identity '
            + 'list. A directory group reference holds NO authority and is read by NO authorization '
            + 'predicate; binding one to a Group is a separate owner-plane act. Route ceiling '
            + 'principals:read, for the reason GET /groups has it (group listings are directory '
            + 'disclosure); the in-handler projection narrows FURTHER and is not the ceiling: a ROOT '
            + 'LOGIN SESSION sees every row; a non-root LOGIN SESSION holding a LIVE Group role (owner or '
            + 'manager; LENSES-c c1-A, card 46cfbd1d) sees the rows carried by an active member of a Group '
            + 'it live-stewards, with memberCount and sources computed over that projected set and no '
            + 'identities at any depth; EVERY OTHER CALLER -- bearer or session, however scoped -- '
            + 'receives 200 with an EMPTY LIST. A 403 on a list route would disclose that the surface '
            + 'exists and is populated.',
          responses: {
            '200': { description: 'OK - { success, references }. An empty list for every caller outside the projection.' },
          },
        },
      },
      '/directory-group-references/{id}': {
        get: {
          summary:
            'One catalog row, under the same projection as the list (root login session, live steward '
            + 'login session, or nothing). A reference OUTSIDE the caller projection answers 404 '
            + 'DIRECTORY_GROUP_REFERENCE_NOT_FOUND, byte-identical in status, code and body to the answer '
            + 'for an id that does not exist, produced from ONE branch - so closing the disclosure does '
            + 'not open an oracle in its place.',
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
          responses: {
            '200': { description: 'OK - { success, reference }' },
            '404': { description: 'DIRECTORY_GROUP_REFERENCE_NOT_FOUND - no such reference, or none you may see. The two are deliberately indistinguishable.' },
          },
        },
        delete: {
          summary:
            'FORGET a retained reference and its carriage (owner plane, root). A reference whose carriage '
            + 'falls to zero is RETAINED rather than deleted -- a catalog that forgets a group the moment '
            + 'its last member leaves cannot answer "is this the group I bound last month?" -- so '
            + 'forgetting is an explicit, audited act. REFUSED while the reference is bound to a Group: '
            + 'unbind first, which is itself audited.',
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
          responses: {
            '200': { description: 'OK - { success, carriageRowsRemoved }' },
            '403': { description: 'The route requires the root scope: forgetting what the directory showed is an owner-plane act.' },
            '404': { description: 'DIRECTORY_GROUP_REFERENCE_NOT_FOUND' },
            '409': { description: 'DIRECTORY_GROUP_REFERENCE_BOUND - a Group is bound to this reference; remove the binding first.' },
          },
        },
      },
      '/directory-group-references/{id}/use': {
        post: {
          summary:
            'USE THIS GROUP - one click, ONE transaction (owner plane, root). Creates a board Group bound '
            + 'to this reference and populates it from the reference carriage, or does none of it. Creating '
            + 'and binding a Group are rule-4 acts A-4 and A-5, which no bound caller may perform. Optional '
            + 'body { name, description }; name defaults to the display name the directory sent, else the '
            + 'reference itself.',
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
          responses: {
            '201': { description: 'Created - { success, groupId, groupName, memberCountApplied, externalGroupRef }' },
            '400': { description: 'UNKNOWN_FIELD - the body accepts name and description and nothing else.' },
            '403': { description: 'The route requires the root scope: creating and binding a Group are owner-plane acts (rule-4 A-4/A-5).' },
            '404': { description: 'DIRECTORY_GROUP_REFERENCE_NOT_FOUND' },
            '409': { description: 'DIRECTORY_GROUP_REFERENCE_ALREADY_BOUND / GROUP_NAME_EXISTS / DIRECTORY_BIND_TOO_MANY_ACCOUNTS - the last names the bound, because a binding that silently locks thousands of rows is an availability incident.' },
          },
        },
      },
      '/access-profiles': {
        get: { summary: 'List Access profiles with published-version and assignment counts (principals:read — §9.1 introspection). A profile is a named, versioned, reusable bundle of object authority: selectors → verbs (A17.4).', responses: { '200': { description: 'OK — { success, profiles }' } } },
        post: { summary: 'Create an Access profile (owner plane, root). Names are unique case-insensitively.', responses: { '201': { description: 'Created — { success, profile }' }, '409': { description: 'PROFILE_NAME_EXISTS' }, '422': { description: 'INVALID_PROFILE_VALUE' } } },
      },
      '/access-profiles/what-if': {
        get: { summary: 'Root owner-plane current authority preview. Select one credential for a delegated principal; never unions keys. Object actions/sources use the live evaluator; actual transport, task-state, step-up and handler gates remain.', parameters: [
          { name: 'principalId', in: 'query', required: true, schema: { type: 'string', format: 'uuid' } },
          { name: 'credentialId', in: 'query', schema: { type: 'string', format: 'uuid' } },
          { name: 'resourceType', in: 'query', schema: { type: 'string', enum: ['task','phase','project','report','skill','personality','service'], default: 'task' } },
          { name: 'limit', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 50, default: 20 } },
          { name: 'after', in: 'query', schema: { type: 'string', format: 'uuid' } }], responses: { '200': { description: 'OK — { success, access: { grants, profiles, envelope, credentials, needsCredential, resources, hasMore, nextCursor } }' }, '400': { description: 'INVALID_PREVIEW_QUERY' }, '404': { description: 'Credential not found for this identity' }, '503': { description: 'Whole-request evaluator failure' } } },
      },
      '/access-profiles/{id}': {
        get: { summary: 'One Access profile (principals:read).', parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }], responses: { '200': { description: 'OK' }, '404': { description: 'PROFILE_NOT_FOUND' } } },
        patch: { summary: 'Rename / redescribe (owner plane, root).', parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }], responses: { '200': { description: 'OK' }, '404': { description: 'PROFILE_NOT_FOUND' }, '409': { description: 'PROFILE_NAME_EXISTS' } } },
        delete: { summary: 'Delete a never-used draft (owner plane, root). Profiles with versions are immutable history; assigned profiles must be unassigned first.', parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }], responses: { '200': { description: 'OK' }, '409': { description: 'PROFILE_HAS_VERSIONS / PROFILE_ASSIGNED' } } },
      },
      '/access-profiles/{id}/versions': {
        get: { summary: 'Immutable version history with selector→verbs rules (principals:read).', parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }], responses: { '200': { description: 'OK — { success, versions }' } } },
        post: { summary: 'Create an immutable version (owner plane, root). rules: [{resourceType, selectorForm: exact|all-of-type|all-except|all-in-project, selectorIds?, verbs}] — all-of-type, all-except and all-in-project are future-inclusive; exclusions stay pinned. For all-in-project, selectorIds names PROJECT ids and the form is admitted for resourceType task and phase only. Publication is a separate act.', parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }], responses: { '201': { description: 'Created — { success, version }' }, '422': { description: 'INVALID_PROFILE_VALUE' } } },
      },
      '/access-profiles/{id}/publish': {
        post: { summary: 'Transactional publish-swap (owner plane, root): the ONE published pointer moves to {versionId}; every assignment follows instantly (T14 by construction — assignments carry no version pointer). The pointer only moves FORWARD: rollback = republish prior content as a NEW version (409 ROLLBACK_IS_REPUBLISH otherwise).', parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }], responses: { '200': { description: 'OK' }, '409': { description: 'ROLLBACK_IS_REPUBLISH' }, '422': { description: 'VERSION_NOT_FOUND' } } },
      },
      '/access-profiles/{id}/assignments': {
        get: { summary: 'Assignments of this profile (principals:read).', parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }], responses: { '200': { description: 'OK — { success, assignments }' } } },
        post: { summary: 'Assign the profile to an Account, Group, Connector or Agent (owner plane, root; delegated assignees since AZ-S3 — their effective authority stays own ∩ parent, so assignment can never escalate). An UNPUBLISHED profile may not be assigned (409 PROFILE_UNPUBLISHED — T35); legacy identities are frozen out (409 LEGACY_FROZEN — T37).', parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }], responses: { '201': { description: 'Created' }, '409': { description: 'PROFILE_UNPUBLISHED / ASSIGNMENT_EXISTS / LEGACY_FROZEN' }, '422': { description: 'ASSIGNEE_NOT_FOUND / ASSIGNEE_NOT_ACCOUNT / ASSIGNEE_DISABLED' } } },
      },
      '/access-profiles/{id}/assignments/{assignmentId}': {
        delete: { summary: 'Unassign (owner plane, root): one delete, effective on the very next request (AZ-4).', parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }, { name: 'assignmentId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }], responses: { '200': { description: 'OK' }, '404': { description: 'ASSIGNMENT_NOT_FOUND' } } },
      },
      '/access-profiles/{id}/events': {
        get: { summary: 'Append-only provenance events (owner plane, root): profile/version/publish/assignment transitions with actor attribution.', parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }, { name: 'limit', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 500, default: 100 } }], responses: { '200': { description: 'OK — { success, events }' } } },
      },
      '/warrants': {
        get: { summary: 'The warrant registry (AZ-S4, design 4d961e37 §6.2/§9.5). SESSION-ONLY human surface with the §6.1 self-scope arm: a non-root session sees only warrants whose holder lies in its own subtree; root sees all; bearer credentials answer 403 SESSION_ONLY with a durable denied audit (T3).', responses: { '200': { description: 'OK — { success, warrants } (each with anchors, caps, liveMinted, suspension state)' }, '403': { description: 'SESSION_ONLY — bearer credentials are refused on this whole surface' } } },
        post: { summary: 'Create a Warrant (§6.2): a human-plane act — session + single-use step-up token bound to (warrant.create, holderPrincipalId); a Connector can never warrant itself (T3). Body: { name, holderPrincipalId (a Connector or service Account), anchors: [{anchorType: task|phase|project, anchorId}], EXACTLY ONE of ceilingProfileId (pins the version published NOW — AZ-21b, T23) or ceilingRules (inline selectors), optional ceilingScopes / expiresAt (REQUIRED unless the single anchor is one task — task-terminal expiry) / transportPin / agentMaxAgeHours / maxConcurrent / maxTotal, stepUpToken }. A non-root creator\'s ceiling must lie within its own authority.', responses: { '201': { description: 'Created — { success, warrant }' }, '403': { description: 'SESSION_ONLY / STEP_UP_REQUIRED / CEILING_EXCEEDS_CREATOR' }, '409': { description: 'PROFILE_UNPUBLISHED / HOLDER_NOT_ACTIVE / LEGACY_FROZEN' }, '422': { description: 'INVALID_WARRANT_VALUE / INVALID_HOLDER_SHAPE / CEILING_REQUIRED / EXPIRY_REQUIRED / ANCHOR_NOT_FOUND' } } },
      },
      '/warrants/suggestions': {
        get: { summary: 'RH-P3.AZ-S7 (ruling 7440b579 R5): the live warrants covering a Phase, so Task creation can SUGGEST one as the assignment’s access carrier. Suggestion only — nothing is auto-selected, and omitting the choice takes the R2(b) automatic-grant fallback (never zero access). SESSION-ONLY with the same §6.1 self-scope arm as the registry: a non-root session is only ever offered warrants whose holder lies in its own subtree.', parameters: [{ name: 'phaseId', in: 'query', required: true, schema: { type: 'string', format: 'uuid' } }], responses: { '200': { description: 'OK — { success, suggestions }' }, '400': { description: 'PHASE_REQUIRED' }, '403': { description: 'SESSION_ONLY' }, '503': { description: 'WARRANT_SUGGESTIONS_UNAVAILABLE' } } },
      },
      '/warrants/{id}/dependent-tasks': {
        get: { summary: 'RH-P3.AZ-S7 (ruling 7440b579 R4): the enumerated list of dependent NOT-YET-TERMINAL Tasks a revoke would auto-unassign. This IS the warning the revoke act owes; the board renders it as the confirmation dialog. 404-concealed outside the self-scope arm.', parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }], responses: { '200': { description: 'OK — { success, tasks }' }, '403': { description: 'SESSION_ONLY' }, '404': { description: 'WARRANT_NOT_FOUND' }, '503': { description: 'WARRANT_DEPENDENTS_UNAVAILABLE' } } },
      },
      '/warrants/{id}/linkage': {
        get: { summary: 'RH-P3.AZ-S7 (ruling 7440b579 R5): the warrant → anchored objects half of the two-way linkage, with the Task assignments the warrant currently carries. 404-concealed outside the self-scope arm.', parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }], responses: { '200': { description: 'OK — { success, anchors, carriedTasks }' }, '403': { description: 'SESSION_ONLY' }, '404': { description: 'WARRANT_NOT_FOUND' }, '503': { description: 'WARRANT_LINKAGE_UNAVAILABLE' } } },
      },
      '/warrants/{id}': {
        get: { summary: 'One warrant with its anchors, the §6.4 minted-identity registry (queryable provenance FK, liveness per identity) and its append-only event ledger. 404-concealed outside the self-scope arm.', parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }], responses: { '200': { description: 'OK — { success, warrant, mintedIdentities, events }' }, '404': { description: 'WARRANT_NOT_FOUND (foreign warrants concealed)' } } },
        patch: { summary: 'Name and description, and (AUTHZ amendment AZ-A13 clause 10, ratified 2026-10-11, E95) the warrant AUTHORITY edited IN PLACE: ceilingProfileId (pins the version published now) or ceilingRules (published as a NEW profile inside the act and pinned; the old version stays immutable), ceilingScopes, maxConcurrent, maxTotal, expiresAt, transportPin. Holder, anchors, agentMaxAgeHours and status stay 422 WARRANT_AUTHORITY_IMMUTABLE ({ code, rule, subject, clause, fields }). The editor is root, an administrator login session or the owning Account (else 404-concealed; every refusal, the concealed ones included, writes a denied warrant.edit audit row with the chain). A NARROWING saves at once (narrowAgents: true narrows the live minted Agents to the new ceilingScopes, revoking an empty one); a WIDENING needs a step-up bound to (warrant.edit, id) and a lifetime, passes the creation validators on the state after the edit and the creator live cap (403 CEILING_EXCEEDS_CREATOR), and an owning Account that is not an administrator only within its own access (403 EXCEEDS_ACCOUNT_AUTHORITY). A ceiling edit while tasks ride the warrant needs acknowledgeDependents (409 WARRANT_HAS_DEPENDENT_TASKS) and releases them. An edit never changes the status: a suspended warrant stays suspended. applyRevert: <approvalId> (with acknowledgeDependents) applies a DUE until-task ceiling revert that waits on riding tasks; its outcome is blocked when something the widening added stays present that no narrowing removes (the record stays due). lifetime until-task is 422 EDIT_LIFETIME_REQUIRED (unrevertible: [fields]) for an edit no revert can undo by narrowing (a ceiling neither wider nor narrower, a transport pin mcp<->api, a replaced scope set).', parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }], responses: { '200': { description: 'OK - { success, warrant } for a name/description edit; { success, edit, warrant } for an authority edit; { success, revert, warrant } for applyRevert' }, '403': { description: 'SESSION_ONLY / STEP_UP_REQUIRED / EXCEEDS_ACCOUNT_AUTHORITY / CEILING_EXCEEDS_CREATOR / AUTHORITY_EDIT_REQUIRES_ADMINISTRATOR' }, '404': { description: 'WARRANT_NOT_FOUND' }, '409': { description: 'WARRANT_NOT_EDITABLE / WARRANT_HAS_DEPENDENT_TASKS / PROFILE_UNPUBLISHED / REVERT_NOT_DUE' }, '422': { description: 'WARRANT_AUTHORITY_IMMUTABLE / EDIT_FIELD_NOT_EDITABLE / EDIT_NO_CHANGE / EDIT_LIFETIME_REQUIRED / EXPIRY_REQUIRED / CEILING_REQUIRED / INVALID_WARRANT_VALUE' } } },
      },
      '/warrants/{id}/revoke': {
        post: { summary: 'Revoke (§6.4): keeps the record (status + events), stops new mints NOW and blocks further lease-driven extensions for minted Agents. The protective direction — session, no step-up. Idempotent. RH-P3.AZ-S7 (ruling 7440b579 R4): revocation first WARNS — without body { acknowledgeDependents: true } it refuses 409 WARRANT_HAS_DEPENDENT_TASKS and ENUMERATES the not-yet-terminal Tasks riding the warrant; with the acknowledgement it proceeds and AUTO-UNASSIGNS them, which also silences their delivery (ccd53781 R2). Work already in flight finishes on its own task-bounded credentials; force-release remains the hard stop.', parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }], requestBody: { required: false, content: { 'application/json': { schema: { type: 'object', additionalProperties: false, properties: { reason: { type: 'string', maxLength: 500 }, acknowledgeDependents: { type: 'boolean', description: 'Proceed after seeing the dependent-task warning; the dependent Tasks are auto-unassigned.' } } } } } }, responses: { '200': { description: 'OK — { success, warrant }' }, '404': { description: 'WARRANT_NOT_FOUND' }, '409': { description: 'WARRANT_EXPIRED — expiry is one-way (§6.2) / WARRANT_HAS_DEPENDENT_TASKS — the R4 warning, listing what a proceed would unassign' } } },
      },
      '/warrants/{id}/resume': {
        post: { summary: 'Resume a SUSPENDED warrant (§6.4 — suspension is resumable only by this re-approval act): session + step-up bound to (warrant.resume, id); the AZ-31a creator live-cap re-proves first (409 CREATOR_CAP_UNMET otherwise). Revoked/expired warrants never resume.', parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }], responses: { '200': { description: 'OK — { success, warrant }' }, '403': { description: 'STEP_UP_REQUIRED' }, '404': { description: 'WARRANT_NOT_FOUND' }, '409': { description: 'WARRANT_NOT_SUSPENDED / CREATOR_CAP_UNMET' } } },
      },
      '/notifications/actions': {
        get: {
          summary: 'Card 5854f0d6 (Notifications and Timeline, E394): "Needs your action" - the open items that wait on the caller, derived at read time and never stored; an item leaves when its condition ends (no read state, no dismiss). Kinds: decision (a pending hub approval item this login session may decide, not skill-publish or native-review), verify (a Task in Review whose Verifier is in the caller\'s subtree, an active native review naming it, or a Task in Review with no usable Verifier, addressed to the Task\'s account owner; one item per Task), stuck (status stuck, or an announced episode on the stuck sweep\'s own activity clock, addressed to the shepherd, else the creator, else the Assignee) and skill (a version waiting for review this human skills:admin session may publish and did not write). Decisions and Skill reviews reach login sessions only. Ordered by kind, then oldest first; each kind capped at 200 (capped flags). Route ceiling tasks:read; every Task item rides the shared task predicate in the query. Not paged. Owner ruling E455 (the Action Center): each item carries seen, true while the caller\'s own seen mark names this occurrence (its since); a seen item stays listed until it is resolved, a new occurrence is unseen again; counts.unseen counts the items not seen, and the bell counts counts.unseen.',
          responses: {
            '200': { description: 'OK - { success, items: [{ key, kind, seen, reasons, since, object { type, id, title }, project { id, name } | null, href, detail }], counts { decision, verify, stuck, skill, total, unseen }, capped { decision, verify, stuck, skill } }' },
            '403': { description: 'Route ceiling (tasks:read) / PRINCIPAL_REQUIRED' },
          },
        },
      },
      '/notifications/actions/owner': {
        get: {
          summary: 'Owner ruling E467 (the Action Center for agents): the owner-queue form of GET /notifications/actions, READ ONLY. For a person\'s own Connector, or an Agent under it (a live delegation chain ending at an active human Account), it lists the items waiting on the owning Account (decision, verify, stuck, skill: the Account\'s own login-session list, through the same predicates and caps, with that Account\'s seen state) as well as the caller\'s own; for any other caller it is exactly the caller\'s own list. Each item: key, kind, seen, since, waitedSeconds, the Task or approval id (object.id), href, readable, waitingOn (account, caller or both). Only where the CALLER\'s own read scope reaches the object does an item carry its title, Project name, reasons and detail (the same decision a point read makes); every other item is kind, id, wait and link, with title null (readable false). A Decision is readable where its Task is and then gives that Task\'s title only: its reasons (the approval kind) and detail (the requester) are kept only where the caller passes the approval point read (GET /approvals/{id}, a login-session act, so never for a bearer credential). seen is the owning Account\'s own mark for an item on its list (waitingOn account or both) and the caller\'s own mark for an item only the caller holds (waitingOn caller). It never widens what the caller can read, marks nothing seen and decides nothing. Merged list capped at 200 per kind, oldest first (capped flags). Route ceiling tasks:read.',
          responses: {
            '200': { description: 'OK - { success, scope: owning-account | own, items: [{ key, kind, seen, reasons, since, waitedSeconds, readable, waitingOn, object { type, id, title }, project { id, name } | null, href, detail }], counts { decision, verify, stuck, skill, total, unseen }, capped { decision, verify, stuck, skill }, asOf }' },
            '403': { description: 'Route ceiling (tasks:read) / PRINCIPAL_REQUIRED' },
          },
        },
      },
      '/notifications/actions/seen': {
        post: {
          summary: 'Owner ruling E455 (the Action Center, card 5854f0d6): mark the caller\'s OWN action items seen, the named ones ({ keys }) or every item its list holds now ({ all: true }, "Mark all seen"). The list is read first through the same predicates as GET /notifications/actions, and only keys on it are marked; any other key (another principal\'s item, an object the caller cannot read, a resolved item, a key that never existed) is ignored alike, so nothing is stored for it and the answer says nothing about it. A mark records the item\'s since: a new occurrence of the same key reads as unseen again. A seen item is never dismissed: it stays listed until it is resolved. Route ceiling tasks:read, session and bearer alike, as the list itself. Answers the list as it now reads, with marked: how many of the caller\'s own items this call marked.',
          requestBody: { required: true, content: { 'application/json': { schema: { oneOf: [
            { type: 'object', required: ['keys'], additionalProperties: false, properties: { keys: { type: 'array', minItems: 1, maxItems: 800, items: { type: 'string', pattern: '^(decision|verify|stuck|skill):[0-9A-Za-z._-]{1,128}$' } } } },
            { type: 'object', required: ['all'], additionalProperties: false, properties: { all: { type: 'boolean', enum: [true] } } },
          ] } } } },
          responses: {
            '200': { description: 'OK - { success, marked, items, counts { decision, verify, stuck, skill, total, unseen }, capped }' },
            '400': { description: 'INVALID_ACTIONS_SEEN' },
            '403': { description: 'Route ceiling (tasks:read) / PRINCIPAL_REQUIRED' },
          },
        },
      },
      '/notifications/timeline': {
        get: {
          summary: 'Card 5854f0d6 (Notifications and Timeline, E394): every change the caller may see, newest first. The spine is the commit-ordered feed (a whitelist of feed names: no task.ready, no tombstone; access changes only with acl=true or type=access), joined by approval ledger rows (login sessions only, the approvals self-scope, the requester-side actor withheld) and skill version decisions (published, returned, retired; an unpublished Skill\'s only under the registry\'s own draft rule). Every arm carries its own read ceiling (reports, phases, projects, skills) and its list scope IN the query, so a page is never short and an unreadable object yields no row and no title. Paged by an opaque before token: the feed by cursor, the approval and skill-version rows by time windows carried in the token, so no row repeats or goes missing; a row committed into a window already served appears after a refresh. headCursor names the newest visible row of each source under the same filters; lastSeen is the caller\'s own last-seen feed cursor. Field changes are named, never valued. Owner ruling E453 (the Action Center): q is a text search over the titles and labels of what the caller may already see, any case, its own wildcards taken literally; it is a conjunct of the same query as the arms, before the limit (never a post-filter, so a searched page is never short), and an object the caller cannot read never matches (an approval row\'s only title is its Task\'s, matched only through the task list scope).',
          parameters: [
            { name: 'before', in: 'query', description: 'The nextCursor of the previous page (opaque)', schema: { type: 'string' } },
            { name: 'limit', in: 'query', description: '1 to 100, default 50', schema: { type: 'integer', minimum: 1, maximum: 100 } },
            { name: 'type', in: 'query', description: 'One or a comma-separated list: task, status, update, stuck, review, report, phase, project, skill, skill-version, approval, access (default every type but access)', schema: { type: 'string' } },
            { name: 'project', in: 'query', schema: { type: 'string', format: 'uuid' } },
            { name: 'phase', in: 'query', description: 'The Task\'s current phase (and the Phase itself)', schema: { type: 'string', format: 'uuid' } },
            { name: 'person', in: 'query', description: 'The acting principal; a row the board wrote itself and a withheld approval actor never match', schema: { type: 'string', format: 'uuid' } },
            { name: 'since', in: 'query', schema: { type: 'string', format: 'date-time' } },
            { name: 'until', in: 'query', schema: { type: 'string', format: 'date-time' } },
            { name: 'scope', in: 'query', description: 'all (default, everything I can see) or mine (My work)', schema: { type: 'string', enum: ['all', 'mine'] } },
            { name: 'acl', in: 'query', description: 'true adds access changes', schema: { type: 'boolean' } },
            { name: 'q', in: 'query', description: 'A text search over the titles and labels the caller may see (trimmed; at most 100 characters)', schema: { type: 'string', maxLength: 100 } },
          ],
          responses: {
            '200': { description: 'OK - { success, items: [{ key, at, kind, label, object { type, id, title }, project { id, name } | null, actor { handle }, detail }], nextCursor, hasMore, headCursor { feed, approvals, skills }, lastSeen }' },
            '400': { description: 'INVALID_TIMELINE_FILTER / INVALID_TIMELINE_CURSOR / INVALID_TIMELINE_LIMIT' },
            '403': { description: 'Route ceiling (tasks:read) / PRINCIPAL_REQUIRED' },
          },
        },
      },
      '/notifications/timeline/seen': {
        post: {
          summary: 'Card 5854f0d6: record the caller\'s OWN last-seen feed cursor ("new since your last visit"), clamped to the newest feed row the caller may see (never the board-wide head) and never moved backwards. Written only here, never by a GET. Route ceiling tasks:read.',
          requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['cursor'], additionalProperties: false, properties: { cursor: { type: 'string', pattern: '^[0-9]{1,19}$' } } } } } },
          responses: {
            '200': { description: 'OK - { success, lastSeen }' },
            '400': { description: 'INVALID_TIMELINE_SEEN' },
            '403': { description: 'Route ceiling (tasks:read) / PRINCIPAL_REQUIRED' },
          },
        },
      },
      '/approvals': {
        get: { summary: 'The Approval queue (AZ-S4, design 4d961e37 §6.1, A17.11). SESSION-ONLY with the self-scope arm (AZ-16): a non-root session sees only items whose requester lies in its own subtree; root sees all. AZ-A9 (ratified 2026-10-10, E43; card 785e1eed): every item carries `kind` (agent-mint, grant, credential, authority-edit, change); an ADMINISTRATOR session also sees every item of every kind, agent-mint included (E43 Q1); a grant or credential item carries `accessRequest` (grantee Account, reason as untrusted text, requested and approved expiry, related task, phase and project, the created grant ids, each row as the decider reads it, and for a credential item the requested and approved pin, the label and the issued credential id). The answer carries `viewer` { isRoot, isAdministrator }: what this session may decide. Without view=hub, ?status= takes the stored lifecycle pending·approved·denied·collected·lapsed; ?kind= filters the kind (agent-mint, grant, credential, authority-edit, change). THE HUB VIEW (card b1e3b16d, opt-in; without view= the answer is unchanged): ?view=hub lists the same self-scoped items plus skill versions waiting for review that this session may publish (kind skill-publish, read from the existing review queue) and native verification requests waiting on a verifier on tasks this session may read (kind native-review, read-only, never decidable), each with refs {task, phase, project} (ids always, titles only where readable or for the decider of a grant request), ownership {class group|shared|private|board, groups (each {id, name, basis owner|grant}), basis, ownerKind, ownerHandle, ownerIsViewer} (AZ-A12 clause 12: the owner column decides group first, basis owner, the owning Group listed first; a live Group grant is the fallback for a person-owned or unowned project, basis grant), deciders {rule, stepUp}, decidable (the decide route\'s own rule) and decideVia (the existing routes); with view=hub, status takes ONLY pending (default)·decided·all (a lifecycle word is 400), kind also takes skill-publish and native-review, and group takes shared·private·board or a Group id. A value outside a grammar is 400 APPROVAL_FILTER_INVALID.', parameters: [{ name: 'status', in: 'query', description: 'Without view: pending, approved, denied, collected or lapsed. With view=hub: pending (default), decided or all.', schema: { type: 'string', enum: ['pending', 'approved', 'denied', 'collected', 'lapsed', 'decided', 'all'] } }, { name: 'kind', in: 'query', schema: { type: 'string', enum: ['agent-mint', 'grant', 'credential', 'authority-edit', 'change', 'skill-publish', 'native-review'] } }, { name: 'view', in: 'query', schema: { type: 'string', enum: ['hub'] } }, { name: 'group', in: 'query', schema: { type: 'string' } }], responses: { '200': { description: 'OK — { success, approvals } (with view=hub: { success, view, approvals })' }, '400': { description: 'APPROVAL_FILTER_INVALID (view=hub only)' }, '403': { description: 'SESSION_ONLY' } } },
      },
      '/approvals/{id}': {
        get: { summary: 'One approval with its append-only event ledger. 404-concealed outside the self-scope arm. AZ-A9 clause 7: for a grant or credential item read by a DECIDER (root or an administrator session) the answer adds `decision` (for a credential item also `decision.credential`: the target Connector, its live credentials by label, keyId, scopes and pin — never a secret — each requested scope held or new, the scopes it could exercise after issue, what THIS decider may put on a credential, ALREADY_HELD, and that the previous credential stays live), and every answer carries `viewer`; the requester chain and requesting credential label, the grantee Account and every identity under it whose own() admits the rows, each row with its resolved object title (an all-of-type row reads as every current and future object of this type), the grantee holdings per (object, verb), the related task, phase and project with the project ownership class (AZ-A12 clause 12, D-16: the owner column decides group first, a live exact-id Group grant is the fallback; with ownershipBasis owner|grant, ownerKind, ownerDisplayName and groups each carrying its basis), the precomputed clause-11 result for this decider, the requester quota counters and the pending-TTL countdown. Agent-mint items answer exactly as before. A CHANGE item (E325 section 6) answers decision { view, change, deciders, decidable, standing, refusal }: a decider (view decider) reads the field diff, the relationship edges and the one-line summary (a credential.scopes change also what it reaches: the Connector effective scopes before and after and each live Agent under it; a credential.issue change what the new credential could exercise), and decidable and refusal follow the decide route order (session kind, liveness, self-approval, standing); its requester (view requester, section 5.5 case (a)) reads change { fields, decided } only, with approval.decidedByPrincipalId and change.deciderStanding null, change.spec.diff cut to { fields } and the events carrying the actor and metadata of its own acts only.', parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }], responses: { '200': { description: 'OK — { success, approval, events, decision? }' }, '404': { description: 'APPROVAL_NOT_FOUND (foreign approvals concealed)' } } },
      },
      '/approvals/{id}/approve': {
        post: { summary: 'Approve a pending request (§6.1, T7 board-only): session + single-use step-up bound to (approval.decide, id). For an EDIT request (kind authority-edit, AZ-A13 clauses 6d, 6e, 6j): root or an administrator decides; body { stepUpToken, lifetime: {choice: keep} | {choice: until-task, taskId?, revertAt?} (422 EDIT_LIFETIME_REQUIRED), editedScopes? (the full approved scope set: a subset of the requested one that keeps what the credential holds, else 422 EDIT_ONLY_NARROWS) }; an object that changed since filing lapses the request TARGET_CHANGED and answers 409 EDIT_STALE; the approval applies the edit to the credential in place and is never collected. For a mint request: The approver may EDIT the authority DOWN — body { stepUpToken, editedScopes?, editedRules? } within the request (422 EDIT_ONLY_NARROWS otherwise). The decision re-runs the FULL mint validation (requester live, BOUND credential live and un-graced — AZ-31c, task mintable, authority ⊆ the requester\'s CURRENT effective set) and refuses loudly on failure, leaving the item pending. Approval arms a SINGLE-USE authorization: collect within 24 hours or it lapses. AZ-A9 (ratified 2026-10-10, E43; card 785e1eed): an administrator login session decides items of EVERY kind (E43 Q1), agent-mint beside its owning Account and root, and the decision audit records which decided; a GRANT or CREDENTIAL item is decided by root or an administrator login session only (step-up as above). A grant body { stepUpToken, editedRules?, editedExpiresAt? } may only narrow it: drop rows or verbs, replace all-of-type with exact ids, shorten the expiry; never widen, lengthen, or change the grantee or kind. Approval writes each approved (row, verb) as a grant on the requester chain-root Account that expires at the approved time, in the decide transaction; an expired identical row is replaced, a live one refuses ALREADY_HELD. A credential body { stepUpToken, editedScopes?, editedExpiresAt?, editedTransport? } may only untick scopes, shorten the expiry and narrow the pin from any to mcp or api; the approved scopes must lie within what the deciding session may put on a credential (DECIDER_CEILING_EXCEEDED); approval records the authorization only and arms a 24-hour collect, issuing nothing. Every AZ-A9 refusal body is { code, rule, subject: requester|grantee|decider, clause }.', parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }], responses: { '200': { description: 'OK — { success, approval }' }, '403': { description: 'SESSION_ONLY / STEP_UP_REQUIRED / MINT_EXCEEDS_REQUESTER / APPROVAL_DECIDE_REQUIRES_ADMINISTRATOR (a grant or credential item decided by neither root nor an administrator session; refused before the step-up is spent) / DECIDER_CEILING_EXCEEDED' }, '404': { description: 'APPROVAL_NOT_FOUND' }, '409': { description: 'APPROVAL_NOT_PENDING / APPROVAL_LAPSED / TASK_TERMINAL / CREDENTIAL_ROTATED… / ALREADY_HELD (a grant row the grantee Account holds live, named; never a unique violation) / OBJECT_NOT_FOUND' }, '422': { description: 'EDIT_ONLY_NARROWS / APPROVAL_WRITES_NOTHING / INVALID_EXPIRY / INVALID_TRANSPORT / SURFACE_NOT_ADMISSIBLE / ADMIN_VERB_NOT_ADMISSIBLE / ROOT_NOT_MINTABLE / ADMIN_SCOPE_NOT_ADMISSIBLE / INVALID_SCOPES' } } },
      },
      '/approvals/requests': {
        post: { summary: 'FILE a change request on the SESSION door (the universal change request, owner ruling E325, section 9.2; card 502fb19e slice S2). SESSION-ONLY: a person files as its own Account (a bearer is refused SESSION_ONLY and files on POST /delegation/access-requests). Body { kind?: change, targetType, targetId?, change, granteePrincipalId?, granteeType? (principal or group), reason (20-2,000), lifetime?, relatedTaskId?, relatedPhaseId? }; any other field is 422 UNKNOWN_FIELD. Standing (section 4.1) is computed live: a root session or an administrator login session names any Account or Group; an ordinary user names its own Account within its role ceiling, or any Account or Group through the OWNER TIER when its live predicate reaches EVERY object through an owner source alone (Project owner, Report account owner or author, Group owner or manager) — a write grant, Task role or visibility confers none (403 REQUEST_STANDING_NONE), and a set partly outside the scope is 403 TARGET_OUT_OF_SCOPE {objects, hint: split-by-project}. The row binds session_evidence {door: request, authMethod, standing}, never a credential. Not retry-keyed: a repeat converges on 409 CHANGE_PENDING naming the caller own approvalId.', responses: { '202': { description: 'Filed: { success, approval } (the requester view: no decider identity, no step-up evidence)' }, '403': { description: 'SESSION_ONLY / REQUEST_STANDING_NONE / TARGET_OUT_OF_SCOPE' }, '404': { description: 'TARGET_NOT_FOUND / GRANTEE_NOT_FOUND (an unreadable object answers as an absent one)' }, '409': { description: 'ALREADY_HELD / CHANGE_PENDING / KNOWLEDGE_NOT_EXPORTED' }, '422': { description: 'UNKNOWN_FIELD / TARGET_TYPE_UNKNOWN / TARGET_NOT_REQUESTABLE / TARGET_NOT_AVAILABLE / GRANTEE_NOT_ADMISSIBLE / GRANTEE_INERT / INVALID_REASON / EXCEEDS_ROLE_CEILING' }, '429': { description: 'REQUEST_QUOTA_EXCEEDED' } } },
      },
      '/approvals/requests/preview': {
        get: { summary: 'WHAT MAY I REQUEST HERE (E325 section 4.3), session-only. ?targetType=&targetId= or ?objectType=&targetId= (objectType task, phase, project, report, skill, personality, service or blueprint), with optional granteePrincipalId, granteeType and sourceId (a compartment is previewed only for the knowledge source named; the registry is never enumerated). Runs the filing standing and validators and writes NOTHING: no audit row, no approval, no quota count. Answers { requestable: [{ targetType, grantees: self|any|none, fields, bound, deciders: [{ standing, rule }], before }], refused: [{ targetType, code, hint? }] }; an object the caller cannot read answers exactly as an absent one and shows no owner standing.', parameters: [{ name: 'targetType', in: 'query', schema: { type: 'string' } }, { name: 'targetId', in: 'query', schema: { type: 'string' } }, { name: 'objectType', in: 'query', schema: { type: 'string' } }, { name: 'sourceId', in: 'query', schema: { type: 'string', format: 'uuid' } }, { name: 'granteePrincipalId', in: 'query', schema: { type: 'string', format: 'uuid' } }, { name: 'granteeType', in: 'query', schema: { type: 'string', enum: ['principal', 'group'] } }], responses: { '200': { description: 'OK — { success, requestable, refused }' }, '403': { description: 'SESSION_ONLY' }, '422': { description: 'PREVIEW_TARGET_REQUIRED' } } },
      },
      '/approvals/{id}/withdraw': {
        post: { summary: 'Withdraw an OWN pending change request on the session door (E325 section 9.2): it lapses with reason WITHDRAWN. Another principal item answers exactly as an absent id; a request no longer pending is 409 APPROVAL_NOT_PENDING.', parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }], responses: { '200': { description: 'OK — { success, approval } (the requester view)' }, '403': { description: 'SESSION_ONLY' }, '404': { description: 'APPROVAL_NOT_FOUND' }, '409': { description: 'APPROVAL_NOT_PENDING' } } },
      },
      '/approvals/{id}/deny': {
        post: { summary: 'Deny a pending request of any kind (agent-mint, grant, credential, authority-edit, change; §6.1): a login session with a single-use step-up bound to (approval.decide, id), decided by the same standing that approves it (a change: the ordered predicate of E325 section 5.1). Body { stepUpToken, reason? }; the stored reason is its first 500 characters. Writes nothing but the decision and its ledger rows.', parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }], responses: { '200': { description: 'OK — { success, approval }' }, '403': { description: 'SESSION_ONLY / STEP_UP_REQUIRED' }, '404': { description: 'APPROVAL_NOT_FOUND' }, '409': { description: 'APPROVAL_NOT_PENDING' } } },
      },
      '/delegation/agent-mints': {
        post: { summary: 'THE one mint operation, dispatched by authentication kind (§9.2, sol r5-F1). BEARER (Connector) — body { targetTaskId, requestedScopes, requestedRules?, warrantId?, via?: approval|warrant, label? }: with warrantId (or a UNIQUE containing warrant when via is omitted) performs the §6.2–6.3 warrant-mint under SELECT FOR UPDATE serialization (T18) with anchor containment (T4), version-pinned ceiling (T23), loud audited cap refusals (T17), AZ-31a creator-cap auto-suspension and the mint-time ⊆ check (T2) → 201 { pack, selectedWarrantId }; with via:approval (or no containing warrant) creates a pending quota-bound Approval (AZ-21a: 5 pending / 20 per day per Connector, T21; coalesced deep-link notification, T8) → 202 { approval }. Multiple containing warrants refuse (409 AMBIGUOUS_WARRANT — sol M8: name the warrant). Agent-layer credentials refuse (AZ-28). SESSION (human Account) — body additionally { stepUpToken } bound to (agent.mint, targetTaskId): the §6.1a ATOMIC session mint (requester = approver; one transaction records the Approval created→approved→collected with session evidence, credential id NULL; the minted Agent\'s parent is the Account) → 201 { approval, pack }. Every pack renders exactly once and is never stored server-side. AZ-S5: mint/collect/session responses carry pack.onboarding — board endpoint, the §2.10 bootstrap line, per-harness MCP snippets, CLI env, the authority summary and the COMPILED BRIEF for the bound task (the Brief compiles FIRST as the caller\'s disclosure act and FAILS CLOSED: 503 BRIEF_COMPILE_FAILED mints nothing). The canonical CLI form is `relayhall agent mint` (interactive step-up); the Access manager carries the GUI dialog.', responses: { '201': { description: 'Minted — { success, path: warrant|session, pack, … }' }, '202': { description: 'Approval requested — { success, path: approval, approval }' }, '403': { description: 'MINT_EXCEEDS_REQUESTER / STEP_UP_REQUIRED / CEILING_EXCEEDED' }, '409': { description: 'AMBIGUOUS_WARRANT / NO_CONTAINING_WARRANT / ANCHOR_CONTAINMENT_FAILED / WARRANT_CAP_EXHAUSTED / WARRANT_SUSPENDED / WRITER_SLOT_TAKEN / TASK_TERMINAL' }, '422': { description: 'INVALID_MINT_SCOPES / AGENT_PLANE_REFUSED / SESSION_MINT_IS_HUMAN' }, '429': { description: 'MINT_QUOTA_EXCEEDED (T21, audited)' } } },
      },
      '/delegation/warrants': {
        get: { summary: 'The HOLDER-plane warrant view (AZ-S5, design 4d961e37 §9.3 relayhall_warrant_list): a BEARER Connector lists the warrants it may mint under — held by itself or by its parent service Account (exercised through its Connectors, AZ-RT5). Sessions answer 403 CREDENTIAL_BOUND (the management registry is /warrants); decider identities are never disclosed.', responses: { '200': { description: 'OK — { success, warrants }' }, '403': { description: 'CREDENTIAL_BOUND — bearer plane only' } } },
      },
      '/delegation/agent-mints/{approvalId}': {
        get: { summary: 'Requester-plane mint status (the §9.3 status surface, REST form): the BOUND credential\'s principal reads its own item\'s lifecycle — never the decider\'s identity or step-up evidence. Foreign items 404-conceal. The human queue lives at /approvals.', parameters: [{ name: 'approvalId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }], responses: { '200': { description: 'OK — { success, approval }' }, '403': { description: 'CREDENTIAL_BOUND' }, '404': { description: 'APPROVAL_NOT_FOUND' } } },
      },
      '/delegation/access-requests': {
        post: { summary: 'FILE an access request (AUTHZ amendment AZ-A9, ratified 2026-10-10 (E43); card 785e1eed). BEARER-ONLY: a Connector or Agent credential; a login session is refused 403 AGENT_PLANE_ONLY. A CHANGE request (the universal change request, owner ruling E325; card 502fb19e, migration 158): body { kind: change, targetType (grant.rows, grant.edit, grant.revoke, credential.scopes, credential.issue, knowledge.compartment, knowledge.shared_writer; and, from card 9ce0b0b0 slice S4, the identity targets identity.role, identity.create, identity.status, credential.revoke, warrant.create, warrant.edit, warrant.revoke and warrant.resume, each naming its object by targetId and no grantee; any other requestable type is 422 TARGET_NOT_AVAILABLE, a type kept out 422 TARGET_NOT_REQUESTABLE, an unknown one 422 TARGET_TYPE_UNKNOWN), targetId?, change (the requested change, typed by targetType), granteePrincipalId?, granteeType? (principal or group), reason (20-2,000), relatedTaskId?, relatedPhaseId? }; the grantee a filer may name follows requestStanding (section 4.1): its chain-root Account tier intersected with its own credential authority (an ordinary user names its own Account, or any Account or Group through the owner tier on every object, else 403 REQUEST_STANDING_NONE or TARGET_OUT_OF_SCOPE; a root or administrator Account Connector names another grantee only for rows its own authority covers, else 403 OWN_CAP_EXCEEDED), every object the filing names is read through the caller own live authority and one it cannot read is answered exactly as an absent one (404 TARGET_NOT_FOUND for a compartment Project, a grant, a credential, a target Connector or a knowledge source; 404 GRANTEE_NOT_FOUND for an Account or Group grantee; a principal-plane object outside the caller own Account subtree is read in the directory, principals:read), except that grant.rows files on an object the caller cannot read exactly as on an absent one and never answers ALREADY_HELD for it, a knowledge subject or Project outside the export selection 409 KNOWLEDGE_NOT_EXPORTED, a second pending change on the same object for the same grantee 409 CHANGE_PENDING naming the caller own approvalId; decided on /approvals with one step-up and applied there. An EDIT request (AZ-A13 clause 6c, ratified 2026-10-11): body { kind: authority-edit, object: {type: credential} (the presenting credential; naming another is 403 EDIT_TARGET_NOT_OWN), addScopes (never root or *:admin; a scope already held is 409 ALREADY_HELD), reason (20-2,000), relatedTaskId?, relatedPhaseId? }; an Agent is refused AGENT_CREDENTIAL_NOT_EDITABLE (AGENT_SCOPE_MINT_ONLY first when it asks for knowledge-contents:write, E149), a warrant or grant object EDIT_OBJECT_NOT_FILABLE, any transport TRANSPORT_NOT_REQUESTABLE, a second pending edit of the credential 409 EDIT_PENDING; approval adds the scopes to the SAME credential in place. A CREDENTIAL request (clause 13; Connectors only, an Agent is refused CREDENTIAL_REQUESTER_NOT_CONNECTOR) asks for ONE credential on the requester itself: body { kind: credential, requestedScopes (never root or *:admin; a live credential that already carries them all refuses ALREADY_HELD naming it), requestedTransport? (any, mcp, api; default the filing credential pin), label? (1-100 characters), targetPrincipalId? (omit, or yourself: TARGET_NOT_AVAILABLE otherwise), reason, relatedTaskId and/or relatedPhaseId, requestedExpiresAt? } and never requestedRules (BUNDLED_ROWS_NOT_AVAILABLE). A GRANT request: body { kind: grant, requestedRules: [{resourceType, selectorForm: exact or all-of-type, selectorIds, verbs}] (one rule per type; verbs read, write, use, invoke; never admin or the surface type), reason (20-2,000 characters, untrusted text), relatedTaskId and/or relatedPhaseId (readable by the caller, else 404-concealed exactly as an absent one), requestedExpiresAt? (default 14 days, at most 90), granteePrincipalId? (always the caller chain-root Account; a delegated one is refused GRANTEE_INERT) }. Filing changes no authority (clause 2): it writes one pending Approval of the filed kind under the per-requester quota shared with mint requests (5 pending, 20 per day). Every refusal names its rule as { code, rule, subject, clause } and is audited.', responses: { '202': { description: 'Filed: { success, approval } (the requester view, with no decider identity and no step-up evidence)' }, '403': { description: 'AGENT_PLANE_ONLY' }, '404': { description: 'TASK_NOT_FOUND / PHASE_NOT_FOUND / TARGET_NOT_FOUND / GRANTEE_NOT_FOUND (an unreadable object answers as an absent one)' }, '409': { description: 'ALREADY_HELD (names the covering source) / RELATED_TASK_TERMINAL / RELATED_PHASE_TERMINAL / GRANTEE_DISABLED' }, '422': { description: 'GRANTEE_INERT / GRANTEE_NOT_ADMISSIBLE / ADMIN_VERB_NOT_ADMISSIBLE / SURFACE_NOT_ADMISSIBLE / SELECTOR_FORM_NOT_ADMISSIBLE / ONE_RULE_PER_TYPE / RULES_REQUIRED / INVALID_REASON / INVALID_EXPIRY / EXPIRY_TOO_LONG / RELATED_REQUIRED / KIND_NOT_FILABLE_HERE / UNKNOWN_FIELD / SCOPES_REQUIRED / ROOT_NOT_MINTABLE / ADMIN_SCOPE_NOT_ADMISSIBLE / INVALID_SCOPES / INVALID_TRANSPORT / INVALID_LABEL / TARGET_NOT_AVAILABLE / BUNDLED_ROWS_NOT_AVAILABLE / CREDENTIAL_REQUESTER_NOT_CONNECTOR' }, '429': { description: 'REQUEST_QUOTA_EXCEEDED' } } },
        get: { summary: 'The caller OWN access requests (bearer-only), newest first; ?status= and ?kind= filter. Without kind: every kind but agent-mint; kind=agent-mint lists the caller OWN mint requests (E325 section 9.1: the tool status lists every kind) with their target task and scopes. The requester view: no decider identity, no step-up evidence, never a secret; it says what became of the authority (E49): revokedAt once clause 12a revoked it, each created grant row with its state (live, expired, revoked, handed-over), and a credential request issued credential with its own revokedAt.', parameters: [{ name: 'status', in: 'query', schema: { type: 'string', enum: ['pending', 'approved', 'denied', 'collected', 'lapsed'] } }, { name: 'kind', in: 'query', schema: { type: 'string', enum: ['grant', 'credential', 'authority-edit', 'change', 'agent-mint'] } }], responses: { '200': { description: 'OK: { success, approvals }' }, '403': { description: 'AGENT_PLANE_ONLY' } } },
      },
      '/delegation/access-requests/preview': {
        get: { summary: 'WHAT MAY I REQUEST HERE for a Connector or Agent (E325 section 4.3), bearer-only (a login session is refused AGENT_PLANE_ONLY; its preview is GET /approvals/requests/preview). The same query and answer as the session preview; the bearer standing is its chain-root Account tier intersected with its own credential authority (section 4.1 row 5). Writes nothing: no audit row, no approval, no quota count.', parameters: [{ name: 'targetType', in: 'query', schema: { type: 'string' } }, { name: 'targetId', in: 'query', schema: { type: 'string' } }, { name: 'objectType', in: 'query', schema: { type: 'string' } }, { name: 'sourceId', in: 'query', schema: { type: 'string', format: 'uuid' } }, { name: 'granteePrincipalId', in: 'query', schema: { type: 'string', format: 'uuid' } }, { name: 'granteeType', in: 'query', schema: { type: 'string', enum: ['principal', 'group'] } }], responses: { '200': { description: 'OK — { success, requestable, refused }' }, '403': { description: 'AGENT_PLANE_ONLY' }, '422': { description: 'PREVIEW_TARGET_REQUIRED' } } },
      },
      '/delegation/access-requests/{approvalId}': {
        get: { summary: 'One OWN access request (bearer-only). Any other principal item, and every agent-mint item, is 404-concealed.', parameters: [{ name: 'approvalId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }], responses: { '200': { description: 'OK: { success, approval }' }, '403': { description: 'AGENT_PLANE_ONLY' }, '404': { description: 'APPROVAL_NOT_FOUND' } } },
      },
      '/delegation/access-requests/{approvalId}/withdraw': {
        post: { summary: 'Withdraw an OWN pending access request (bearer-only): it lapses with reason WITHDRAWN. A request that is no longer pending is refused APPROVAL_NOT_PENDING.', parameters: [{ name: 'approvalId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }], responses: { '200': { description: 'OK: { success, approval }' }, '403': { description: 'AGENT_PLANE_ONLY' }, '404': { description: 'APPROVAL_NOT_FOUND' }, '409': { description: 'APPROVAL_NOT_PENDING' } } },
      },
      '/delegation/access-requests/{approvalId}/collect': {
        post: { summary: 'Collect an approved CREDENTIAL request (AZ-A9 clause 13), or an approved credential.issue CHANGE request (E325; card 502fb19e), which the TARGET Connector own live credential collects (the requester and every other caller are answered 404): BEARER-ONLY and credential-bound — the SAME credential that filed it (any other is answered 404 exactly as an absent id), once, within 24 hours of approval. Re-runs every check: a dead requester, a disabled grantee or a terminal related task or phase LAPSES it (CREDENTIAL_ROTATED, REQUESTER_CHAIN_DEAD, GRANTEE_DISABLED, TASK_TERMINAL, PHASE_TERMINAL; COLLECT_TTL_EXPIRED; PENDING_EXPIRED past the approved expiry); a decider that lost its standing, the scope closures or ALREADY_HELD refuse without consuming. Issues the credential through the one issuance mechanism, capped by the DECIDER authority, records it on the approval (issued_credential_id) and answers 201 { success, approval, credential, secretOnce, onboarding, warning }: the key renders ONCE and is stored nowhere. Not retry-keyed: a repeat answers APPROVAL_NOT_COLLECTABLE. The previous credential stays live. A grant request has nothing to collect, because its rows are written when it is approved, and is refused 409 NOT_COLLECTABLE.', parameters: [{ name: 'approvalId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }], responses: { '201': { description: 'Collected: { success, approval, credential, secretOnce, onboarding, warning }' }, '403': { description: 'AGENT_PLANE_ONLY / DECIDER_NO_LONGER_ADMITTED / DECIDER_CEILING_EXCEEDED' }, '404': { description: 'APPROVAL_NOT_FOUND' }, '409': { description: 'NOT_COLLECTABLE (grant) / APPROVAL_NOT_COLLECTABLE / APPROVAL_LAPSED / ALREADY_HELD' }, '422': { description: 'INVALID_SCOPES / ROOT_NOT_MINTABLE / ADMIN_SCOPE_NOT_ADMISSIBLE' } } },
      },
      '/delegation/agent-mints/{approvalId}/collect': {
        post: { summary: 'COLLECT an approved authorization (§6.1, AZ-31c): SINGLE-USE, by the SAME connector credential that requested (foreign credentials 404-conceal), within the 24h TTL. Re-runs the COMPLETE mint validation transactionally with Approval consumption and Principal/Credential creation (T27: approve-after-rotate refuses by construction; narrow/disable/task-terminal between decide and collect refuse here). A TERMINAL failure lapses the Approval with an audited reason; a TRANSIENT failure (e.g. WRITER_SLOT_TAKEN) refuses WITHOUT consuming it.', parameters: [{ name: 'approvalId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }], responses: { '201': { description: 'Minted — { success, pack } (the pack renders once, never stored)' }, '403': { description: 'CREDENTIAL_BOUND / MINT_EXCEEDS_REQUESTER' }, '404': { description: 'APPROVAL_NOT_FOUND (wrong credential concealed)' }, '409': { description: 'APPROVAL_NOT_COLLECTABLE / APPROVAL_LAPSED / WRITER_SLOT_TAKEN' } } },
      },
      '/principals/remediation-queue': {
        get: { summary: 'The §10 Access-manager remediation queue (AZ-S4; owner plane, root): every legacy_identity row (frozen out of the new machinery, evaluated under the Phase-2 arms until the owner-executed Phase-5 transition) and every parentless service Account whose purpose is still the sol-M9 backfill text, each with its live-credential count and replacement guidance.', responses: { '200': { description: 'OK — { success, queue }' } } },
      },
      '/principals/me/brief': {
        post: { summary: 'Compile the SESSION Brief for the identity this credential acts as — the fourth altitude of the Brief family (vocabulary b94dd86e §3; strategy §2.10). Personality inlined, the bound Task\'s attached Reports, the caller\'s granted skill index and the board-workflow doctrine, assembled server-side as one payload. This call is also what records the credential as bootstrapped: until it has, MCP work-plane tool calls are refused with "bootstrap first". Self-identity ceiling: any authenticated credential compiles its OWN session brief (card 1118fefa); the enclosed Task, Personality, Report and skill-index content additionally requires tasks:read or principals:read, plus the caller grants on each piece. Body options: inlineReports, tokenBudget.', responses: { '200': { description: 'OK — { success, brief, principalId, credentialId, bootstrappedUntil, tokenEstimate }' }, '400': { description: 'INVALID_COMPILE_OPTION' }, '404': { description: 'No principal or credential resolved for this identity' }, '503': { description: 'REPORT_REFERENCE_LOOKUP_FAILED — a lookup failure is not confirmed absence; the compile fails closed and the credential is NOT recorded as bootstrapped' } } },
      },
      '/principals/me/lenses': {
        get: {
          summary:
            'THE LENS CONTRACT (RH-LENSES-d, card 4e159741; design 96f0bd3d s8): which dashboard sections the '
            + 'caller is OFFERED. Ceiling authenticated (the /principals/me precedent: no target identifier, it '
            + 'discloses the caller to itself). member is always present; admin is present exactly when the '
            + 'request would pass a root ceiling AND arrived on a login session (the board session or the '
            + 'break-glass dashboard token) - a bearer credential never receives it, whatever it holds. A LENS '
            + 'GRANTS NOTHING: it is recomputed on every request, never stored, cached or written to a token, '
            + 'read by no other route, and every section it leads to keeps its own ceiling. Not audited. '
            + 'LENSES-c c1-B (card b5c83682; design delta C.8): manager is present, with the manager object, '
            + 'exactly when the caller holds at least one LIVE Group role row (owner or manager: the holder is '
            + 'active, a member of the Group and holds no admin, operator or orchestrator role); with none the '
            + 'answer carries NO manager key at all, not an empty object. The arm grants nothing either.',
          responses: {
            '200': {
              description: 'OK - { lenses, admin[, manager] }: { "lenses": ["member"], "admin": false }; { "lenses": ["member", "admin"], "admin": true }; or, for a live Group role holder, { "lenses": ["member", "manager"], "admin": false, "manager": { "stewardedGroups": [...] } }',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    required: ['lenses', 'admin'],
                    properties: {
                      lenses: {
                        type: 'array',
                        items: { type: 'string', enum: ['member', 'manager', 'admin'] },
                        description: 'The union of the caller lenses, in the order member, manager, admin; there is no lens switcher.',
                      },
                      admin: { type: 'boolean', description: 'True exactly when admin is in lenses.' },
                      manager: {
                        type: 'object',
                        description: 'The manager arm (c1-B): present exactly when manager is in lenses, and ABSENT otherwise (never an empty object). stewardedGroups lists every Group the caller LIVE-stewards, owners first, then by name; memberCount counts the Group active members.',
                        properties: {
                          stewardedGroups: {
                            type: 'array',
                            items: {
                              type: 'object',
                              properties: {
                                id: { type: 'string', format: 'uuid' },
                                name: { type: 'string' },
                                memberCount: { type: 'integer' },
                                featured: { type: 'boolean' },
                                role: { type: 'string', enum: ['owner', 'manager'] },
                              },
                            },
                          },
                        },
                      },
                    },
                  },
                },
              },
            },
            '404': { description: 'No principal resolved for this identity' },
          },
        },
      },
      '/principals/me/effective-access': {
        get: { summary: 'Authenticated SELF current authority preview. Bounded live object actions and evaluator sources under the presenting credential and chain; stored grants/profiles remain inventory. Actual transport, task-state, step-up and handler gates remain.', parameters: [
          { name: 'resourceType', in: 'query', schema: { type: 'string', enum: ['task','phase','project','report','skill','personality','service'], default: 'task' } },
          { name: 'limit', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 50, default: 20 } },
          { name: 'after', in: 'query', schema: { type: 'string', format: 'uuid' } }], responses: { '200': { description: 'OK — { success, access: { grants, profiles, envelope, resources, hasMore, nextCursor } }' }, '400': { description: 'INVALID_PREVIEW_QUERY' }, '404': { description: 'No principal resolved' }, '503': { description: 'Whole-request evaluator failure' } } },
      },
      '/principals/me/home-group': {
        get: { summary: 'RH-LENSES-b (card 4287af8a; design 96f0bd3d s7.2): the caller OWN home group (authenticated - the route has no target identifier, so authentication plus the resolved caller principal is the whole boundary; the D-5 precedent). The stored row is a POINTER and the answer is DERIVED at read (derivation D-L2): it resolves only while the Group is featured, the Account is a member of it, and the Account is active. The payload carries all three - the resolved value, the raw pointer that SURVIVES an unresolving state, and `unresolvedReason` in { no_home_group, not_featured, not_a_member, actor_inactive } saying which clause failed. Restoring any of the three makes it resolve again with NO re-write.', responses: { '200': { description: 'OK - { success, homeGroup: { groupId, groupName, pointer, unresolvedReason } }' }, '404': { description: 'No principal resolved for this identity' } } },
        put: { summary: 'Choose a home group (authenticated; owner decision 3 - "the person may switch among their featured groups"). Body { groupId }. The Group must be FEATURED and the caller a MEMBER of it; otherwise the named refusal below. THE ACT CONFERS NOTHING: authority moves at one later act, the creation default of s7.3, which re-derives featured, membership and active status at its own write under a lock rather than trusting this pointer. Writes source=self and audits `home_group.set`; a refusal is a durable audited denial.', responses: { '200': { description: 'OK - { success, homeGroup }' }, '400': { description: 'UNKNOWN_FIELD - accepted fields are: groupId' }, '404': { description: 'GROUP_NOT_FOUND, or no principal resolved for this identity' }, '422': { description: 'GROUP_NOT_FEATURED - a home group is chosen from the featured groups; NOT_A_GROUP_MEMBER - a home group is one the Account belongs to; HOME_GROUP_ACCOUNT_INACTIVE - the target Account is absent or inactive; INVALID_HOME_GROUP_VALUE - groupId must be a full UUID' } } },
        delete: { summary: 'Clear the caller OWN home-group pointer (authenticated). Clearing an absent pointer is a no-op and answers 200, not 404: the caller stated end state is reached. Audits `home_group.clear`.', responses: { '200': { description: 'OK - { success, homeGroup }' }, '404': { description: 'No principal resolved for this identity' } } },
      },
      '/principals/{id}/home-group': {
        put: { summary: 'RH-LENSES-b: an administrator sets a home group FOR an Account (owner decision 3), writing source=admin. Body { groupId }. CEILING: principals:admin from the /principals family rule, NARROWED in the handler to a ROOT LOGIN SESSION - the session-versus-bearer classification is IMPORTED from utils/administratorSession and never re-implemented (AZ-18: machine credentials do not perform session acts). The target Account must remain active under a principal row lock until commit; the same featured + membership admission rules apply, and the act confers nothing.', parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }], responses: { '200': { description: 'OK - { success, homeGroup }' }, '400': { description: 'UNKNOWN_FIELD - accepted fields are: groupId' }, '403': { description: 'REQUIRES_LOGIN_SESSION - a bearer credential never performs this act; ROOT_SESSION_REQUIRED - a non-root login session is refused' }, '404': { description: 'GROUP_NOT_FOUND' }, '422': { description: 'GROUP_NOT_FEATURED / NOT_A_GROUP_MEMBER / HOME_GROUP_ACCOUNT_INACTIVE / INVALID_HOME_GROUP_VALUE / INVALID_PRINCIPAL_ID; GROUP_PRINCIPAL_MANAGED_BY_GROUPS - the id names a Group principal (AZ-A12 clause 2), refused first and audited' } } },
      },
      '/principals/me/directory-group-references': {
        get: {
          summary:
            "The caller's OWN directory group references (RH-LENSES-a, card 74e02a05; ceiling "
            + 'authenticated, on the /principals/me precedent). What the Identity provider has said '
            + 'about THIS person, and whether each value reaches a board Group. Concealment is '
            + 'STRUCTURAL: the route takes no identifier and the query is anchored on the caller, so '
            + "another Account's list is unreachable rather than merely refused. It confers nothing "
            + 'and discloses nothing new: a carriage row is an observation about this very person.',
          responses: {
            '200': { description: 'OK - { success, references }' },
            '404': { description: 'No principal resolved for this identity' },
          },
        },
      },
      '/principals/me/connectors': {
        get: { summary: 'The caller\'s OWN Connector chain (card 653be44f; owner design record 99d6b0ad §3.1; principals:read). Every Connector this Account created, with its paired registry row, its credentials (metadata only — no secret, ciphertext or hash is selected) and the Agents minted beneath each. NO new authority: the same rows are already disclosed by GET /principals and the AZ-S4 own-subtree credential listing; this route narrows them to the caller. Concealment is STRUCTURAL — the route takes no id, and the query is anchored on parent_principal_id = the caller, so another Account subtree is unreachable rather than merely refused. The response also carries the RE-SHOWABLE instructions (§3.1: endpoints and instructions re-shown any time, not secret), rendered by the SAME composer as the one-time §7.4 onboarding pack with the credential replaced by a named placeholder.', responses: { '200': { description: 'OK — { success, connectors, instructions }' }, '404': { description: 'No principal resolved for this identity' }, '503': { description: 'Identity substrate is not migrated yet' } } },
      },
      '/credentials/{id}/reveal': {
        post: { summary: 'Re-reveal a stored credential secret (AZ-S3, design 4d961e37 §7.1/§7.2, AZ-20). AUTHORIZATION AND CONCEALMENT COME FIRST: any target outside a non-root caller lineage answers 404 — existence and lifecycle state are never confirmed. Bearer callers: own descendant lineage only, and the revealed authority must lie within the PRESENTING credential effective scopes (403 REVEAL_EXCEEDS_PRESENTING — T20). Session callers: single-use step-up token bound to exactly this reveal (body {stepUpToken}; §7.6, T16 — a replayed, expired or re-targeted token answers 403 STEP_UP_REQUIRED). Graced/revoked/expired credentials never reveal; the decrypt is hash-verified before returning (T30); reveals are rate-limited with an audited alert and every reveal is audited with layer + step-up evidence + the full chain.', parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }], responses: { '400': { description: 'INVALID_CREDENTIAL_ID: the path id is not a full UUID (checked after the authority check)' }, '200': { description: 'OK — { success, keyId, secret }' }, '403': { description: 'STEP_UP_REQUIRED / REVEAL_EXCEEDS_PRESENTING' }, '404': { description: 'CREDENTIAL_NOT_FOUND — includes 404-concealed foreign targets in ANY lifecycle state' }, '409': { description: 'CREDENTIAL_REVOKED / CREDENTIAL_EXPIRED / CREDENTIAL_GRACED / CREDENTIAL_NOT_REVEALABLE / LEGACY_FROZEN (in-lineage targets only)' }, '429': { description: 'REVEAL_RATE_LIMITED (alert audited)' } } },
      },
      '/principals/{id}/terminate': {
        post: { summary: 'Irreversible offboarding (A17.10, T24): the principal AND its descendant subtree get the durable terminated status; every credential in the subtree is revoked permanently; re-enable and issuance refuse terminated principals. Idempotent. Owner-plane (manage gate).', parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }], responses: { '200': { description: 'OK — { success, terminated[], revokedCredentials }' }, '400': { description: 'INVALID_PRINCIPAL_ID: the path id is not a full UUID (checked after the authority check)' }, '404': { description: 'PRINCIPAL_NOT_FOUND' }, '422': { description: 'GROUP_PRINCIPAL_MANAGED_BY_GROUPS - the id names a Group principal (AZ-A12 clause 2): a Group principal is managed only through /groups. Refused before any other check and audited as principal.mutation_refused.' } } },
      },
      '/auth/step-up': {
        post: { summary: 'Mint a SINGLE-USE elevation token (AZ-S3, design 4d961e37 §7.6, AZ-23): bound to ONE named action + target id, ~5-minute TTL, minted only after password re-entry on a LOGIN SESSION (bearer credentials never step up — AZ-18); the consuming endpoint burns it. Step-up authorizes the act and never widens any ceiling. Card a3e76724: body { method: "sso", action, targetId } instead STARTS a re-authentication at the Identity provider (prompt=login, max_age=0, or the standard parameters the provider stepUpPolicy names, card 7a99d63e; a prompt or max_age in extraAuthorizeParams never rides a step-up) bound to the session Account, action and target, and answers { success, method: "sso", authorizeUrl, requestId, expiresAt } with no token — collect it at /auth/step-up/collect. Any body without method "sso" takes the password arm unchanged. Card 7a99d63e (SU-14): a consumer that finds no live token answers 403 STEP_UP_REQUIRED whose body carries stepUp { error: "insufficient_user_authentication", action, targetId, max_age: 0, methods } (RFC 9470 vocabulary, no WWW-Authenticate header): the binding the act tried, no capability; card 72b8fb97: methods is the proofs the CALLER can give, the set GET /auth/step-up/methods answers.', responses: { '200': { description: 'OK — { success, stepUpToken, expiresAt } (password) or { success, method: "sso", authorizeUrl, requestId, expiresAt } (sso)' }, '400': { description: 'action/targetId/password required / STEP_UP_BINDING_INVALID / SSO_STEP_UP_UNAVAILABLE (no proven Identity link at an enabled provider, or its stepUpPolicy says sso_step_up disabled)' }, '401': { description: 'Invalid password or non-session caller' }, '503': { description: 'SSO_NOT_CONFIGURED / SSO_PROVIDER_INACTIVE' } } },
      },
      '/auth/sso/callback': {
        get: { summary: 'The registered redirect_uri for login and step-up (design d95136d7 §5.2). A refused STEP-UP callback (card 7a99d63e, SU-10) answers with a named cause: SSO_STEP_UP_NOT_FRESH (auth_time predates the request or is absent: the provider reused an earlier sign-in), SSO_STEP_UP_PROVIDER_DECLINED (provider error login_required, interaction_required, unmet_authentication_requirements or access_denied); every other ID-token refusal stays SSO_ID_TOKEN_REFUSED, and the LOGIN arm answers SSO_ID_TOKEN_REFUSED for every ID-token refusal, stale included. Every refused step-up writes auth.step_up.refused with reason and refusal_code. A browser (Accept prefers HTML) is redirected instead: login to /dashboard/?sso_refused=<CODE>, step-up to /dashboard/?step_up=refused&request=<id>&code=<CODE> (or step_up=complete).', responses: { '302': { description: 'Redirect to the dashboard (session minted for a login; a step-up mints nothing until collected)' }, '400': { description: 'SSO_STATE_MISSING / SSO_STATE_UNKNOWN / SSO_COOKIE_MISMATCH / SSO_ISSUER_MISMATCH / SSO_PROVIDER_ERROR / SSO_ID_TOKEN_REFUSED / SSO_STEP_UP_NOT_FRESH / SSO_STEP_UP_PROVIDER_DECLINED / SSO_STEP_UP_SUBJECT_MISMATCH / …' }, '502': { description: 'SSO_PROVIDER_UNREACHABLE' }, '503': { description: 'SSO_NOT_CONFIGURED / SSO_PROVIDER_INACTIVE' } } },
      },
      '/auth/step-up/methods': {
        get: { summary: 'Which step-up proofs THIS Account can give (card a3e76724): password (a password credential, or the named local administrator with the deployment hash) and/or sso (a proven Identity link at an enabled Identity provider). preferred is sso when the session came from the Identity provider and the Account has no password credential.', responses: { '200': { description: 'OK — { success, methods: (password|sso)[], preferred: password|sso|null }' }, '401': { description: 'Non-session caller' } } },
      },
      '/identity-providers/{id}': {
        get: { summary: 'Read one Identity provider (owner plane, root; design d95136d7 §3.2, SS-3). Never returns a client secret or private key. Card 7a99d63e: carries stepUpPolicy, how a step-up asks this provider for a fresh authentication ({ sso_step_up?: enabled|disabled, prompt_login?: boolean, max_age?: null|0|10..300 }), or null for the default request (prompt=login and max_age=0).', parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }], responses: { '200': { description: 'OK — { identityProvider: { …, stepUpPolicy }, health }' }, '403': { description: 'root ceiling' }, '404': { description: 'PROVIDER_NOT_FOUND' } } },
        patch: { summary: 'Update an Identity provider (owner plane, root; audited identity_provider.update with before/after). Card 7a99d63e (SU-17): body may carry stepUpPolicy (also accepted by POST /identity-providers): an object { sso_step_up?: "enabled"|"disabled", prompt_login?: boolean (default true: send prompt=login), max_age?: null (not sent) | 0 | 10..300 seconds (default 0) }, or null to restore the default request. It changes only what a step-up ASKS the provider; acceptance is unchanged (auth_time no earlier than the request, no skew). Validated server-side, refused by name: PROVIDER_STEP_UP_POLICY_INVALID (not an object, unknown key, wrong type, or a strength key a later release adds: acr_values, claims_request, required_acr, amr_rungs, required_claims_any, when_unproven, actions), PROVIDER_STEP_UP_MAX_AGE_INVALID (1-9 or above 300), PROVIDER_STEP_UP_ASKS_NOTHING (prompt_login false with max_age null).', parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }], responses: { '200': { description: 'OK — { identityProvider }' }, '400': { description: 'PROVIDER_STEP_UP_POLICY_INVALID / PROVIDER_STEP_UP_MAX_AGE_INVALID / PROVIDER_STEP_UP_ASKS_NOTHING / PROVIDER_ISSUER_INVALID / PROVIDER_SUBJECT_NOT_IMMUTABLE / PROVIDER_SECOND_ACTIVE / …' }, '403': { description: 'root ceiling' }, '404': { description: 'PROVIDER_NOT_FOUND' } } },
      },
      '/auth/step-up/collect': {
        post: { summary: 'Exchange a PROVEN Identity-provider re-authentication for the single-use step-up token (card a3e76724). Body { requestId } from the sso start. The callback proved it (auth_time no older than the request, the SAME Account through a proven Identity link); this mints for exactly the bound action and target with method oidc, once, within two minutes of the proof, for the same Account only.', responses: { '200': { description: 'OK — { success, method: "sso", stepUpToken, expiresAt, action, targetId }' }, '400': { description: 'STEP_UP_REQUEST_INVALID / STEP_UP_REFUSED / STEP_UP_EXPIRED' }, '401': { description: 'Non-session caller' }, '404': { description: 'STEP_UP_REQUEST_UNKNOWN — no such request for this Account' }, '409': { description: 'STEP_UP_PENDING / STEP_UP_ALREADY_COLLECTED' } } },
      },
      '/grants': {
        get: { summary: 'List object-level grants (owner plane, root; the ceiling is unchanged). A grant is (grantee, resource, verb) with a typed NULL wildcard and optional expiry. Card ff410dc4 (owner ruling E407 item 1): every parameter is ADDITIVE. Without limit or cursor the answer is every matching grant in creation order, { success, grants }. With either it is ONE keyset page, { success, grants, pagination: { limit, sort, returned, total, hasMore, nextCursor }, madeCounts? }, newest first by default; pass pagination.nextCursor as cursor (with the same sort) for the next page: rows present throughout are returned exactly once. madeCounts (first page only) counts hand, system and unknown rows under every filter except made. Each row carries madeBy { class: hand|system|unknown, via, evidence: column|audit|none } derived from the grants columns and the audit ledger (docs/grants.md), target { label, status, state: live|archived|missing|wildcard|unchecked } and, for a Group grantee, granteeGroup { id, name }. Every filter runs inside the one statement, before its LIMIT.', parameters: [
          { name: 'granteeId', in: 'query', schema: { type: 'string', format: 'uuid' } },
          { name: 'resourceType', in: 'query', schema: { type: 'string', enum: ['task', 'phase', 'project', 'report', 'skill', 'personality', 'service', 'plugin', 'surface', 'blueprint'] } },
          { name: 'verb', in: 'query', schema: { type: 'string', enum: ['read', 'write', 'use', 'invoke', 'admin'] } },
          { name: 'made', in: 'query', description: 'Origin class: hand (made by a person: the Access page, CLI, API or an approved request), system (written by a creation policy, an assignment, a Warrant or a Project default), unknown (no creation record), all.', schema: { type: 'string', enum: ['hand', 'system', 'unknown', 'all'], default: 'all' } },
          { name: 'expiry', in: 'query', description: 'none = no expiry; live = not expired; expired; expiring = a live expiry within 14 days.', schema: { type: 'string', enum: ['any', 'none', 'live', 'expired', 'expiring'], default: 'any' } },
          { name: 'target', in: 'query', description: 'The state of the granted object (Tasks, Reports, Projects and Phases are checked; wildcard = every object of the type).', schema: { type: 'string', enum: ['any', 'live', 'archived', 'missing', 'wildcard'], default: 'any' } },
          { name: 'q', in: 'query', description: 'Case-insensitive search over the grantee handle and name, the granter handle, the object title and the resource and grant ids (LIKE metacharacters match literally).', schema: { type: 'string', maxLength: 200 } },
          { name: 'sort', in: 'query', schema: { type: 'string', enum: ['-created', 'created', 'grantee', '-grantee', 'resource', '-resource', 'verb', '-verb', 'expires', '-expires'], description: 'Default -created for a page, created for the unpaged list.' } },
          { name: 'limit', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 200, default: 50 } },
          { name: 'cursor', in: 'query', description: 'A previous pagination.nextCursor; bound to the sort it was issued for.', schema: { type: 'string' } },
        ], responses: { '200': { description: 'OK — { success, grants } or, paged, { success, grants, pagination, madeCounts? }' }, '400': { description: 'INVALID_QUERY_VALUE / UNKNOWN_FIELD' } } },
        post: { summary: 'Create a grant (owner plane, root; §2.9 — grant mutation stays out of the agent plane). Grantees are principals or Groups (AZ-S1, design 4d961e37 §3): a group grant reaches ACTIVE member Accounts by membership join at query time. resourceId omitted/null = the type-wide wildcard.', responses: { '201': { description: 'Created — { success, grant }' }, '409': { description: 'GRANT_EXISTS' }, '422': { description: 'INVALID_GRANT_VALUE / GRANTEE_NOT_FOUND / GRANTEE_DISABLED' } } },
      },
      '/grants/{id}': {
        patch: { summary: 'EDIT a grant row IN PLACE (AUTHZ amendment AZ-A13 clause 11, ratified 2026-10-11, E95): body { verb?, expiresAt? (null = no expiry), resourceId? (null = every object of the type), stepUpToken?, lifetime?, reason? }. The row keeps its id. Owner plane: the root ceiling is unchanged, and the handler is session-only (a bearer is refused SESSION_ONLY). A narrowing saves at once; a widening needs a step-up bound to (grant.edit, id) and a lifetime (until-task is 422 EDIT_LIFETIME_REQUIRED, unrevertible [resourceId], for a move from one object to another). The surface closure re-applies (AUTHORITY_MUTATION_SURFACE); an edited tuple equal to a live row is 409 GRANT_EXISTS naming it, and an expired identical row is replaced. An assignment-carried row (GRANT_CARRIES_ASSIGNMENT) and a creation-default or steward row (GRANT_ORIGIN_NOT_EDITABLE) are refused; an approval-made row keeps an expiry at most 90 days out (EXPIRY_REQUIRED / EXPIRY_TOO_LONG). The feed emits acl_changed for the old and the new object.', parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }], responses: { '200': { description: 'OK - { success, edit }' }, '403': { description: 'SESSION_ONLY / STEP_UP_REQUIRED / root ceiling' }, '404': { description: 'GRANT_NOT_FOUND' }, '409': { description: 'GRANT_EXISTS / GRANT_CARRIES_ASSIGNMENT' }, '422': { description: 'EDIT_FIELD_NOT_EDITABLE / EDIT_NO_CHANGE / EDIT_LIFETIME_REQUIRED / GRANT_ORIGIN_NOT_EDITABLE / AUTHORITY_MUTATION_SURFACE / INVALID_GRANT_VALUE / EXPIRY_REQUIRED / EXPIRY_TOO_LONG' } } },
        delete: { summary: 'Revoke a grant (owner plane, root). Revocation is deletion — grants are live authority configuration, not history. Owner ruling E418(b): the same login-session and step-up requirement as PATCH on this router. A bearer (a root Connector included) is refused SESSION_ONLY; a session without a live single-use step-up bound to (grant.revoke, this grant id) is refused STEP_UP_REQUIRED with the step-up challenge; both refusals are audited as denied grant.revoke rows. Body { stepUpToken }; the token is burned in the revoke transaction, so a refused revoke never spends it, and the grant.revoke audit row records the step-up method. An assignment-carried row is refused GRANT_CARRIES_ASSIGNMENT.', parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }], requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', additionalProperties: false, required: ['stepUpToken'], properties: { stepUpToken: { type: 'string', description: 'Single-use step-up bound to (grant.revoke, the grant id)' } } } } } }, responses: { '200': { description: 'OK — { success, grant }' }, '400': { description: 'INVALID_GRANT_ID / UNKNOWN_FIELD' }, '403': { description: 'SESSION_ONLY / STEP_UP_REQUIRED (with stepUp challenge) / root ceiling' }, '404': { description: 'GRANT_NOT_FOUND' }, '409': { description: 'GRANT_CARRIES_ASSIGNMENT' } } },
      },
      '/grants/bulk-revoke': {
        post: { summary: 'Owner ruling E413: revoke, in ONE audited batch, the grants that change nobody\'s access, as the authorization engine itself decides (owner ruling E407 item 3). Owner plane: the root ceiling of every /grants route, and session-only (every bearer, a root Connector included, and every MCP call is refused SESSION_ONLY; not in the MCP registry). Body { ids: at most 500 grant ids, dryRun: default true, stepUpToken: required when dryRun is false }. For each id the engine evaluates the grantee (and the widest identity that could ever sit below it) on every action the verb confers, on the object (every object of the type for a wildcard) and, for a Project or Phase, its Tasks, with and without the grant, and whether the grant is the only source its holder has for delegating that object (the warrant, assignment R3 and mint ceilings read grants and profile rules); the verdict per id is redundant | effective | unevaluable (a Group grantee, plugin and surface grants, anything the engine cannot evaluate) | assignment (GRANT_CARRIES_ASSIGNMENT, never removed here) | missing | expired. A DRY RUN writes nothing (it also simulates the batch and reports readBack and wouldRollBack). A REAL RUN needs a single-use step-up bound to (grant.bulk_revoke, idSetHash), where idSetHash is the sha256 of the lower-cased ids sorted and joined by commas, prefixed grant-ids-v1: (every answer carries idSetHash and redundantIdSetHash, the hash of exactly the ids found redundant). It runs in one transaction holding the grants table: every id is re-checked live, ONLY ids still redundant are removed, each through the grant revoke path (its own grant.revoke audit row and acl_changed event), then every question the removed grants could influence is asked again and ANY difference rolls the whole batch back. One grant.bulk_revoke summary audit row per real call (counts, the id-set hash, the actor, rolled back or not); the step-up is spent either way. One call is one request for the rate limit.', requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', additionalProperties: false, required: ['ids'], properties: { ids: { type: 'array', minItems: 1, maxItems: 500, uniqueItems: true, items: { type: 'string', format: 'uuid' } }, dryRun: { type: 'boolean', default: true }, stepUpToken: { type: 'string', description: 'Single-use step-up bound to (grant.bulk_revoke, idSetHash); required when dryRun is false' } } } } } }, responses: { '200': { description: 'OK — { success, dryRun, idSetHash, redundantIdSetHash, results: [{ id, verdict, reason, removed, grant? }], removed, skipped: { redundant, effective, unevaluable, assignment, missing, expired }, readBack: { principals, checks, differences }, rolledBack, wouldRollBack? (dry run), summaryAuditId? (real run) }' }, '400': { description: 'BULK_REVOKE_IDS_REQUIRED / BULK_REVOKE_TOO_MANY / BULK_REVOKE_DUPLICATE_ID / INVALID_GRANT_ID / INVALID_FIELD / UNKNOWN_FIELD' }, '403': { description: 'SESSION_ONLY / STEP_UP_REQUIRED (with stepUp challenge) / root ceiling' }, '409': { description: 'GRANTS_BUSY — another grant change held the table; nothing was revoked' } } },
      },
      '/audit': {
        get: { summary: 'Read the indefinite append-only control-plane audit ledger (audit:read). Keyset pagination uses the returned nextCursor as ?before=. There is no mutation or purge route in v1.', parameters: [
          { name: 'limit', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 200, default: 100 } },
          { name: 'before', in: 'query', schema: { type: 'string', format: 'uuid' } },
          { name: 'action', in: 'query', schema: { type: 'string' } },
          { name: 'actorPrincipalId', in: 'query', schema: { type: 'string', format: 'uuid' } },
          { name: 'resourceType', in: 'query', schema: { type: 'string' } },
          { name: 'resourceId', in: 'query', schema: { type: 'string' } },
        ], responses: { '200': { description: 'OK — { success, events, nextCursor, retention: indefinite, purgeAvailable: false }' }, '400': { description: 'INVALID_QUERY_VALUE / UNKNOWN_FIELD' } } },
      },
      '/principals/{id}/grants': {
        get: { summary: "A principal's object-level grants. Own grants at principals:read; another principal's grants require the manage gate (A12.5 introspection split). Grant MUTATION lives on /grants (owner plane).", parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }], responses: { '200': { description: 'OK — { success, grants }' }, '503': { description: 'Grants substrate not migrated yet' } } },
      },
      '/sessions/pipeline-health': { get: { summary: 'Reporter-ingest pipeline health (unknown with no reporters; the Phase-3 telemetry health seed)', responses: { '200': { description: 'OK' } } } },
      '/reports': {
        get: { summary: 'List reports (q= full-text search; NOTE list items include full content — filter client-side or prefer limit; archived reports are excluded unless status=archived or include_archived=true)', parameters: [
          { name: 'q', in: 'query', schema: { type: 'string' }, description: 'Full-text search (the parameter is q — search= is ignored)' },
          { name: 'limit', in: 'query', schema: { type: 'integer' } },
          { name: 'status', in: 'query', schema: { type: 'string', enum: ['active', 'archived'] } },
          { name: 'include_archived', in: 'query', schema: { type: 'boolean' } },
        ], responses: { '200': { description: 'OK' } } },
        post: { summary: 'Create report with optional structured handover (pinning is human/on-demand only)', requestBody: { required: true, content: { 'application/json': { schema: { $ref: '#/components/schemas/ReportCreateBody' } } } }, responses: { '201': { description: 'Created' }, '400': { description: 'INVALID_REPORT_HANDOVER or field validation failed' } } },
      },
      '/reports/{id}': {
        get: { summary: 'Get report (full UUID; 8-char prefixes are CLI-only)', parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }], responses: { '200': { description: 'OK' }, '400': { description: 'INVALID_REPORT_ID' }, '404': { description: 'Not found' } } },
        patch: { summary: 'Update report; handover null clears structured context (archived reports are read-only)', requestBody: { required: true, content: { 'application/json': { schema: { $ref: '#/components/schemas/ReportPatchBody' } } } }, responses: { '200': { description: 'OK' }, '400': { description: 'INVALID_REPORT_ID / INVALID_REPORT_HANDOVER' }, '409': { description: 'REPORT_ARCHIVED — unarchive first' } } },
        delete: { summary: 'Delete report', responses: { '200': { description: 'OK' }, '400': { description: 'INVALID_REPORT_ID' } } },
      },
      '/reports/{id}/archive': { post: { summary: 'Archive report (read-only, out of default lists, still linkable; reversible)', responses: { '200': { description: 'OK' }, '404': { description: 'Not found or not active' } } } },
      '/reports/{id}/unarchive': { post: { summary: 'Return an archived report to active', responses: { '200': { description: 'OK' }, '404': { description: 'Not found or not archived' } } } },
      '/models/available': { get: { summary: 'Resolved model catalog (interim LiteLLM-backed read-only catalog; see docs/seams.md)', responses: { '200': { description: 'OK' } } } },
      '/litellm/models': {
        get: { summary: 'List LiteLLM DB-backed model deployments (secrets stripped)', responses: { '200': { description: 'OK' }, '502': { description: 'LiteLLM unavailable or inconsistent' }, '503': { description: 'Admin adapter not configured' } } },
        post: { summary: 'Create a LiteLLM model deployment using an environment credential reference (operator mutation gate required)', responses: { '201': { description: 'Created' }, '400': { description: 'Invalid or raw-secret input rejected' }, '409': { description: 'Mutations disabled' } } },
      },
      '/litellm/models/{id}': {
        delete: { summary: 'Delete a LiteLLM model deployment (operator mutation gate required)', parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }], responses: { '200': { description: 'Deleted' }, '409': { description: 'Mutations disabled' } } },
      },
      '/litellm/keys': {
        get: { summary: 'List LiteLLM virtual keys with credential fields stripped', responses: { '200': { description: 'OK' } } },
        post: { summary: 'Generate an agent/project-scoped virtual key with model and spend limits (operator mutation gate required)', responses: { '201': { description: 'Generated; key material is returned once' }, '400': { description: 'Invalid scope, budget, duration, or caller-supplied secret' }, '409': { description: 'Mutations disabled' } } },
      },
      '/litellm/keys/{id}': {
        delete: { summary: 'Delete a LiteLLM virtual key by token id/hash (operator mutation gate required)', parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }], responses: { '200': { description: 'Deleted' }, '409': { description: 'Mutations disabled' } } },
      },
      '/litellm/spend': {
        get: { summary: 'Aggregated LiteLLM spend by safe key identifier, user, and model (defaults to the last 30 UTC days)', parameters: [
          { name: 'startDate', in: 'query', schema: { type: 'string', format: 'date' } },
          { name: 'endDate', in: 'query', schema: { type: 'string', format: 'date' } },
        ], responses: { '200': { description: 'Aggregated spend summary' }, '400': { description: 'Invalid date range' } } },
      },
      '/litellm/health': {
        get: { summary: 'Check configured LiteLLM model deployments and return credential-safe endpoint health', responses: { '200': { description: 'Model health summary' }, '502': { description: 'LiteLLM unavailable or returned an invalid response' } } },
      },
      '/webhooks': {
        get: { summary: 'List OBSERVATION subscriptions (root sentinel, subscription-class). A subscription carries event-class filters and NO url of its own — endpoint, mode and signing secret are read from the subscriber Connector\'s registry row at dispatch time (ruling ccd53781 R1).', responses: { '200': { description: 'OK' } } },
        post: { summary: 'Register an OBSERVATION subscription (root). Body: events[], description?, active?, subscriberPrincipalId, subscriberCredentialId, deliveryCursor? (omit to start at the feed head; "0" replays the retained feed). Subscribers are CONNECTORS only (R3). GO SIGNALS are not observable — task.ready is delivered per-assignee by the work plane (R1). Deliveries are ID-only and HMAC-SHA256 signed with the Connector\'s services.delivery_secret (X-RelayHall-Signature, X-RelayHall-Plane, X-RelayHall-Channel-Id, X-RelayHall-Cursor).', responses: { '201': { description: 'Created' }, '400': { description: 'UNKNOWN_EVENT / GO_SIGNAL_NOT_OBSERVABLE / SUBSCRIPTION_UNATTRIBUTED / INVALID_SUBSCRIBER' } } },
      },
      '/webhooks/{id}': {
        patch: { summary: 'Update an observation subscription (root, audited)', responses: { '200': { description: 'OK' }, '400': { description: 'UNKNOWN_EVENT / GO_SIGNAL_NOT_OBSERVABLE / SUBSCRIPTION_NOT_ACTIVATABLE / INVALID_SUBSCRIBER' }, '404': { description: 'WEBHOOK_NOT_FOUND' } } },
        delete: { summary: 'Remove an observation subscription (root, audited)', responses: { '200': { description: 'OK' }, '404': { description: 'WEBHOOK_NOT_FOUND' } } },
      },
      '/tool-catalogue': { get: { summary: 'List built-in MCP tool metadata; authenticated reference, not execution permission', responses: { '200': { description: 'Object with success and tools: name, description, inputSchema, plane (bootstrap admission), effect (session, read or change: what the tool does), requiredScope' } } } },
      '/openapi.json': { get: { summary: 'This document', responses: { '200': { description: 'OK' } } } },
    },
  };
  // AZ-S3 §7.5/§9.8 (review 87fec3e2 B5): every path DECLARES its
  // transport class in the published contract, derived from the ONE
  // transportMap source of truth so spec and enforcement can never drift
  // (a structural test pins the parity). 'unclassified-fail-closed' means
  // the middleware rejects every non-'any' credential pin on that path
  // (T26); public unauthenticated paths carry no pin comparison at all.
  const paths = spec.paths as Record<string, Record<string, unknown>>;
  Object.assign(paths, blueprintPaths);
  applyRetryContract(paths);
  for (const specPath of Object.keys(paths)) {
    const mounted = specPath.replace(/\{[^}]+\}/g, 'x');
    paths[specPath]['x-transport-class'] = routeTransportClassFor(mounted) ?? 'unclassified-fail-closed';
  }
  return spec;
}
