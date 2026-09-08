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
  'task.create': ['/tasks', 'post'],
  'task.patch': ['/tasks/{id}', 'patch'],
  'task.note.append': ['/tasks/{id}/notes', 'post'],
  'task.stream.append': ['/tasks/{id}/stream', 'post'],
  'task.reference.create': ['/tasks/{id}/references', 'post'],
  'report.create': ['/reports', 'post'],
  'project.create': ['/projects', 'post'],
  'project.resource.create': ['/projects/{id}/resources', 'post'],
  'agent.mint.request': ['/delegation/agent-mints', 'post'],
  'agent.mint.collect': ['/delegation/agent-mints/{approvalId}/collect', 'post'],
};

const RETRY_HEADER_PARAMETER = {
  name: 'Idempotency-Key', in: 'header', required: false,
  schema: { type: 'string', minLength: 16, maxLength: 128 },
  description: 'OPTIONAL over REST, REQUIRED on the MCP tool surface. Send the same 16-128 character value on every retry of the same call: the first answer is stored and returned again byte-for-byte under Retry-Replayed: true, with Retry-Request-Id naming the committed act. Without it a retried create is a second create. Agent minting never returns a stored answer (see 409 below).',
};

const RETRY_RESPONSES: Record<string, string> = {
  '400': 'IDEMPOTENCY_KEY_INVALID (not 16-128 characters) / IDEMPOTENCY_SCOPE_UNAVAILABLE (no identity to scope the token to)',
  '409': 'IDEMPOTENCY_KEY_REUSED (same token, different request) / IDEMPOTENCY_KEY_IN_FLIGHT (the first call is still running) / IDEMPOTENCY_REPLAY_UNAVAILABLE (agent minting: committed under that token, and the one-time pack is never stored)',
};

function applyRetryContract(paths: Record<string, Record<string, unknown>>): void {
  const declared = Object.keys(IDEMPOTENT_OPERATIONS).sort();
  const mapped = Object.keys(IDEMPOTENT_OPENAPI_MOUNTS).sort();
  if (declared.join('|') !== mapped.join('|')) {
    throw new Error('openapi: the retry-contract mount map and the operation declaration table disagree');
  }
  for (const [path, method] of Object.values(IDEMPOTENT_OPENAPI_MOUNTS)) {
    const entry = paths[path];
    if (!entry) throw new Error(`openapi: retry-contract path ${path} is not documented`);
    const operation = entry[method] as { parameters?: unknown[]; responses?: Record<string, { description: string }> } | undefined;
    if (!operation) throw new Error(`openapi: retry-contract operation ${method.toUpperCase()} ${path} is not documented`);
    operation.parameters = [...(operation.parameters ?? []), RETRY_HEADER_PARAMETER];
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
    revision: { type: 'string', description: 'Opaque; send back via If-Match on mutation.' },
    is_hidden: { type: 'boolean' },
    created_at: { type: 'string', format: 'date-time' },
    updated_at: { type: 'string', format: 'date-time' },
  },
  // The runtime record carries exactly these nine keys, always (goal joined
  // the canonical bounded record with migration 079).
  required: ['id', 'name', 'description', 'goal', 'status', 'revision', 'is_hidden', 'created_at', 'updated_at'],
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
        ], responses: { '200': { description: 'OK' }, '503': { description: 'Assignee filters unavailable (identity substrate not migrated)' } } },
        post: { summary: 'Create task (personality optional; autoStart defaults false). `notes` is accepted and stored verbatim, validated by the same rule PATCH /tasks/{id} applies (a string, or null to leave the column empty) - a non-string answers 400 INVALID_TASK_NOTES. `dueAt` is when the Task is due, as an ISO-8601 instant (or null for no deadline, the ordinary state); a past instant is accepted deliberately - the board records deadlines, it does not police them - and anything that does not name an instant answers 400 INVALID_DUE_AT, and more than six fractional-second digits answers 400 INVALID_DUE_AT_PRECISION - the column keeps microseconds and nothing is silently rounded. executionProfile = { serviceId, descriptorVersion?, options, parameters? } validated against the pinned capability descriptor — targeting a service requires services:invoke; the retired mode/harness/accessProfile shape and executionMode answer 400 FIELD_RETIRED.', requestBody: taskSharedWriteBody, responses: { '201': { description: 'Created', ...taskEnvelopeResponse }, '400': { description: 'Validation failed / FIELD_RETIRED / INVALID_TASK_NOTES / INVALID_DUE_AT / INVALID_DUE_AT_PRECISION / INVALID_DUE_AT_RANGE / INVALID_DUE_AT_ZONE / INVALID_DUE_AT_LOCAL_TIME', content: { 'application/json': { schema: { $ref: '#/components/schemas/ApiError' } } } }, '403': { description: 'PROFILE_INVOKE_REQUIRED' }, '409': { description: 'PROFILE_DESCRIPTOR_RETIRED (pin a live version)' }, '422': { description: 'PROFILE_* validation failures naming the exact field' } } },
      },
      '/tasks/{id}': {
        get: { summary: 'Get task (full UUID; includes discordThreadUrl and dueAt, the Task deadline as an ISO-8601 instant or null)', parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }], responses: { '200': { description: 'OK', ...taskEnvelopeResponse }, '400': { description: 'INVALID_TASK_ID (8-char prefixes are CLI-only)' }, '404': { description: 'Not found' } } },
        patch: { summary: 'Update task. `notes` is validated by the same rule POST /tasks applies (a string, or null to clear it); a non-string answers 400 INVALID_TASK_NOTES. `dueAt` follows the POST /tasks contract: an ISO-8601 instant, or null to clear the deadline; anything else answers 400 INVALID_DUE_AT. Implementers may hand off to review/stuck; only an independent Verifier may complete it, and only after every subtask is completed or skipped. executionProfile follows the POST /tasks contract (connector-first; null clears; targeting a service requires services:invoke).', requestBody: taskSharedWriteBody, responses: { '200': { description: 'OK', ...taskEnvelopeResponse }, '400': { description: 'INVALID_TASK_NOTES / INVALID_DUE_AT / INVALID_DUE_AT_PRECISION / INVALID_DUE_AT_RANGE / INVALID_DUE_AT_ZONE / INVALID_DUE_AT_LOCAL_TIME', content: { 'application/json': { schema: { $ref: '#/components/schemas/ApiError' } } } }, '403': { description: 'Caller lacks lifecycle authority / PROFILE_INVOKE_REQUIRED' }, '409': { description: 'Completion blocked by unfinished subtasks / PROFILE_DESCRIPTOR_RETIRED' } } },
        delete: { summary: 'Delete task', responses: { '200': { description: 'OK' } } },
      },
      '/tasks/operating-contract': {
        get: { summary: 'Generated Task operating contract and validation schema (single source for Brief/REST/CLI/MCP)', responses: { '200': { description: 'Compiled contract' } } },
      },
      '/tasks/{id}/stream': {
        get: { summary: 'Read the authorized Task Timeline stream; reported entries apply Task visibility intersected with the Outpost tier', responses: { '200': { description: 'Ordered entries' } } },
        post: { summary: 'Append an attributed immutable Task stream entry. More than 8192 characters auto-promotes to a caller-authored Report, or quarantines without failing when capacity is exhausted. dryRun validates without writing.', responses: { '201': { description: 'Appended' }, '400': { description: 'Rich field validation error' }, '403': { description: 'Reported provenance requires Service write authority' } } },
      },
      '/tasks/{id}/finish': {
        post: { summary: 'Atomic finish: append Handover, create/link a Report, and transition in-progress -> review together or not at all. dryRun validates without writing.', responses: { '200': { description: 'Handed over for review' }, '400': { description: 'Report or field validation failed' }, '403': { description: 'Only the Task claimant, Shepherd or Verifier may finish' }, '409': { description: 'Task or Subtasks are not ready for handover' } } },
      },
      '/tasks/{id}/assignment-access': {
        get: { summary: 'RH-P3.AZ-S7 (ruling 7440b579 R5): what carries this Task assignment’s access — the Warrant if one does, and the grant / access-profile-assignment rows it depends on. Each row reports whether this machinery CREATED it: a row it did not create is one it will never delete (owner default D4), and the owner plane keeps full control of those. Read-only; the shared point predicate authorizes read on the Task first, so no new scope string.', parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }], responses: { '200': { description: 'OK — { success, assignment, links }. assignment.carriedBy is warrant | grant, or null when the Task is unassigned; each link reports createdByAssignment, which is what decides whether the assignment may ever remove that row.' }, '404': { description: 'TASK_NOT_FOUND' }, '503': { description: 'ASSIGNMENT_ACCESS_UNAVAILABLE' } } },
      },
      '/tasks/{id}/references': {
        get: { summary: 'List typed Task References (dependencies remain a separate relation)', responses: { '200': { description: 'References' } } },
        post: { summary: 'Create a typed sibling Reference. Base kinds are closed; namespaced plugin kinds degrade to inert rows. dryRun validates without writing.', responses: { '201': { description: 'Created' }, '400': { description: 'Rich field validation error' } } },
      },
      '/tasks/{id}/stream/{entryId}/redact': {
        post: { summary: 'Root-only licensed stream mutation: span, tombstone or author erasure with attributed keyed-HMAC audit and auto-promoted Report cascade. No CLI/MCP/agent surface.', responses: { '200': { description: 'Redacted' }, '403': { description: 'Root required' }, '409': { description: 'Entry already redacted' }, '503': { description: 'Owner-held HMAC key unavailable' } } },
      },
      '/tasks/{id}/roles': {
        patch: {
          summary: 'Assign the server-controlled Shepherd and independent Verifier roles for a Task. The Assignee remains controlled by claim and release.',
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
                  },
                },
              },
            },
          },
          responses: {
            '200': { description: 'Task roles assigned' },
            '403': { description: 'Shepherd or administrator authority required; assigning a Service Shepherd additionally requires services:invoke' },
            '404': { description: 'Task not found or concealed by authorization policy' },
            '409': { description: 'CLAIMANT_VERIFIER_CONFLICT' },
            '422': { description: 'Invalid role field or unavailable Principal' },
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
      '/telemetry/frames': { post: { summary: 'Ingest one presence/telemetry frame (RH-P3.C7, §2.6.5 C5/F11 trim: heartbeat or coarse status only). Requires telemetry:write (AUTHZ design 4d961e37 A17.7/§9.1, the status:write successor); each service writes only its own frames — the owner is always the calling principal, recorded server-side, and the body cannot name one. Zero server-side effect; rate- and size-limited; short retention.', responses: { '200': { description: 'OK' }, '400': { description: 'INVALID_FRAME / PRINCIPAL_REQUIRED / TASK_NOT_FOUND' }, '403': { description: 'telemetry:write required' }, '413': { description: 'PAYLOAD_TOO_LARGE' }, '429': { description: 'RATE_LIMITED (one frame per interval per principal)' } } } },
      '/telemetry/events': { post: { summary: 'Ingest ONE rh.ai.telemetry/1.0 envelope record (RH-TW1a, TELEMETRY-DESIGN 7d5c0cdc §3.1; owner decision D11). Requires telemetry:write. The reporting identity is derived from the authenticated credential chain (§4.1/§5.1) and the body cannot name one; the source product must appear in the owning Connector descriptor declared list (§5.2). Tier-0 deny-by-default redaction runs BEFORE storage, and the redacted payload is content-addressed into the §6.5.1 governed raw store in the same statement.', responses: { '200': { description: 'OK - accepted, possibly a duplicate' }, '400': { description: 'INVALID_ENVELOPE / UNSUPPORTED_SCHEMA_MAJOR (carries acceptedMajors) / TELEMETRY_PRINCIPAL_REQUIRED' }, '403': { description: 'telemetry:write required, or TELEMETRY_PRINCIPAL_NO_CONNECTOR / TELEMETRY_PRODUCT_NOT_DECLARED / TELEMETRY_TIER_NOT_DECLARED' }, '413': { description: 'ENVELOPE_TOO_LARGE' }, '429': { description: 'RATE_LIMITED (one accepted event per interval per principal)' } } } },
      '/telemetry/events/batch': { post: { summary: 'Ingest a BATCH of rh.ai.telemetry/1.0 records - the ratified home of canonical batch ingest (owner decisions D2 and D11). Body is JSONL (application/x-ndjson or application/jsonl): one full record per line, at most 500 records and 1 MiB. Integrity rides the authenticated transport at upload; there is deliberately NO separate payload signature in v1. Each record is validated, redacted and stored on its own merits, so PARTIAL SUCCESS is normal and the response carries a per-record result; malformed lines go to the §6.5.2 quarantine under the per-connector quota and are never echoed back. The receiver limit is spent ONCE per batch, on the events_batch surface.', responses: { '200': { description: 'OK - per-record results; accepted, duplicates and refused counts' }, '400': { description: 'EMPTY_BATCH / TELEMETRY_PRINCIPAL_REQUIRED' }, '403': { description: 'telemetry:write required, or a principal refusal (§5.1)' }, '413': { description: 'BATCH_TOO_LARGE, or the body exceeded the byte limit' }, '415': { description: 'UNSUPPORTED_MEDIA_TYPE - the batch surface reads JSONL' }, '429': { description: 'RATE_LIMITED (one accepted batch per interval per principal)' } } } },
      '/tasks/{id}/brief': { post: { summary: 'Compile the full agent Brief for a task — the TASK altitude of the Brief family (generation only; the product never executes agents). RH-P3.C4 (ii) / D4 retired the pre-A7 /tasks/{id}/prompt spelling and its `prompt` response key; neither is aliased. Body options: inlineReports (opt-in full-content inlining of readable referenced Reports), tokenBudget (caller-declared inlining budget), format (markdown | agentsmd).', responses: { '200': { description: 'OK — { brief, model, thinking, taskId, format, tokenEstimate }' } } } },
      '/tasks/{id}/claim': { post: { summary: 'Claim an armed, dependency-ready task — become its Assignee (idempotent for the current Assignee)', responses: { '200': { description: 'Claimed' }, '400': { description: 'No principal resolved for caller' }, '409': { description: 'Task is parked, dependency-blocked, assigned elsewhere, or conflicts with the Verifier role' }, '503': { description: 'Identity substrate not migrated' } } } },
      '/tasks/{id}/release': { post: { summary: 'Release a task — clear its Assignee (the Assignee always may; orchestrator may force)', responses: { '200': { description: 'Released' }, '400': { description: 'No principal resolved for caller' }, '409': { description: 'Another principal is the Assignee' }, '503': { description: 'Identity substrate not migrated' } } } },
      '/principals': {
        get: { summary: 'List configured principals (identity metadata never exposed)', parameters: [
          { name: 'includeHidden', in: 'query', schema: { type: 'boolean' }, description: 'Admin-only: include hidden compatibility identities' },
        ], responses: { '200': { description: 'OK' }, '403': { description: 'includeHidden requires management authority' }, '503': { description: 'Identity substrate not migrated' } } },
        post: { summary: 'Create an ACCOUNT — a parentless human or service principal (design 4d961e37 A17.1; root scope or orchestrator/admin role; reserved handles and the agent: prefix are refused). Service Accounts MUST declare a purpose. kind=agent is REFUSED: Agent identities arrive only through the delegation machinery (AZ-S5).', responses: { '201': { description: 'Created' }, '400': { description: 'Invalid handle/kind' }, '403': { description: 'Not permitted' }, '409': { description: 'Handle already exists' }, '422': { description: 'AGENT_MINT_ONLY / PURPOSE_REQUIRED / INVALID_PURPOSE' } } },
      },
      '/principals/{id}': {
        patch: { summary: 'Update display name or status. Disabling invalidates every credential the principal holds.', parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }], responses: { '200': { description: 'OK' }, '400': { description: 'Invalid status, or the system principal' }, '403': { description: 'Not permitted' }, '404': { description: 'Not found' } } },
      },
      '/principals/{id}/credentials': {
        get: { summary: 'List a principal\'s credentials. Secrets are never included.', parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }], responses: { '200': { description: 'OK' }, '403': { description: 'Not permitted' } } },
        post: { summary: 'Issue an rh_ credential to a Connector/Agent-layer principal (Accounts are keyless — 422 ACCOUNTS_ARE_KEYLESS). secretOnce is returned in this response and never logged; since AZ-S3 the secret is stored encrypted at rest and is re-revealable under the /credentials/{id}/reveal lineage/step-up rules. Accepts transport (any|mcp|api, §7.5). root is never mintable; *:admin never mints onto Agents.', parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }], responses: { '201': { description: 'Created — body carries secretOnce' }, '400': { description: 'Unknown/escalating scope, disabled principal, the system principal, or an invalid transport' }, '403': { description: 'Not permitted' }, '404': { description: 'Principal not found' }, '422': { description: 'ACCOUNTS_ARE_KEYLESS / ROOT_NOT_MINTABLE / ADMIN_NOT_AGENT_DELEGABLE' }, '409': { description: 'LEGACY_FROZEN / PRINCIPAL_TERMINATED' } } },
      },
      '/credentials/{id}/revoke': {
        post: { summary: 'Revoke a credential. Effective on the next request; idempotent.', parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }], responses: { '200': { description: 'Revoked (or already revoked)' }, '403': { description: 'Not permitted' }, '404': { description: 'Not found' } } },
      },
      '/credentials/{id}/rotate': {
        post: { summary: 'Rotate: mint an EXACT COPY (scope set and transport inherited verbatim — §7.3; any scope/transport change in the body is 422 ROTATION_IS_EXACT_COPY); the predecessor gets a live-evaluated grace window (default 24h, 0–7d) that only ever shortens its life. Revoked/graced sources refuse (409 ROTATE_FROM_RETIRED); Agents never rotate.', parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }], responses: { '201': { description: 'Rotated — body carries secretOnce' }, '400': { description: 'Disabled principal' }, '403': { description: 'Not permitted' }, '404': { description: 'Not found' }, '409': { description: 'ROTATE_FROM_RETIRED / AGENTS_NEVER_ROTATE' }, '422': { description: 'ROTATION_IS_EXACT_COPY / INVALID_GRACE' } } },
      },
      '/tasks/{id}/notes': {
        post: { summary: 'Append a timestamped, attributed note server-side (avoids the read-modify-write race on the single notes column)', parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }], responses: { '200': { description: 'Appended' }, '400': { description: 'Missing or oversized text' }, '404': { description: 'Task not found' } } },
      },
      '/principals/me': { get: { summary: 'The caller\'s resolved principal and scopes (404 until a principal resolves)', responses: { '200': { description: 'OK' }, '404': { description: 'No principal for this identity' } } } },
      '/tasks/{id}/subtasks/by-id/{subtaskId}/status': { patch: { summary: 'Set Subtask status by stable id (preferred address)', parameters: [{ name: 'subtaskId', in: 'path', required: true, schema: { type: 'string', pattern: '^[0-9]+$' } }], responses: { '200': { description: 'OK' }, '403': { description: 'Only independent Verifier identities may complete subtasks' } } } },
      '/tasks/{id}/subtasks/{index}/status': { patch: { deprecated: true, summary: 'Compatibility-only positional Subtask update; emits Deprecation and Warning headers', parameters: [{ name: 'index', in: 'path', required: true, schema: { type: 'integer' } }], responses: { '200': { description: 'OK (deprecated)' }, '403': { description: 'Only independent Verifier identities may complete subtasks' } } } },
      '/tasks/{id}/subtasks/{index}/approve': { post: { summary: 'Independent Verifier approves subtask -> completed', responses: { '200': { description: 'OK' }, '403': { description: 'Independent Verifier authority required' } } } },
      '/tasks/{id}/subtasks/{index}/reject': { post: { summary: 'Reject subtask -> empty with note', responses: { '200': { description: 'OK' } } } },
      '/tasks/{id}/subtasks/{index}/skip': { post: { summary: 'Skip subtask (counts as done)', responses: { '200': { description: 'OK' } } } },
      '/tasks/{id}/subtasks/{index}': { put: { summary: 'Replace subtask text/status (legacy)', responses: { '200': { description: 'OK' } } } },
      '/projects': {
        get: { summary: 'List projects. Default EXCLUDES archived; includeArchived=true (or status=archived) is the explicit archived view.', parameters: [
          { name: 'status', in: 'query', schema: { type: 'string' } },
          { name: 'includeArchived', in: 'query', schema: { type: 'boolean' } },
          { name: 'includeHidden', in: 'query', schema: { type: 'boolean' } },
          { name: 'includeStats', in: 'query', schema: { type: 'boolean' } },
        ], responses: { '200': { description: 'OK — { success, projects: Project[] } (canonical bounded records; compatibility-held legacy bytes are NEVER embedded)', content: { 'application/json': { schema: { type: 'object', properties: { success: { type: 'boolean' }, projects: { type: 'array', items: { $ref: '#/components/schemas/ProjectListItem' } } } } } } }, '400': { description: 'UNKNOWN_FIELD / INVALID_QUERY_VALUE' } } },
        post: { summary: 'Create project (board state only — never creates filesystem paths). Name is unique among active projects. RH-LENSES-b (design 96f0bd3d s7.3): this act is ACTOR-AWARE. When - and ONLY when - the request arrives on a ROOT LOGIN SESSION whose Account has a RESOLVING home group, the same transaction also writes two grants to that Group over this project (read and write, origin=creation-default) and audits `project.access_default_apply`. All of it or none of it: a forced failure on either grant leaves NO project row. EVERY OTHER CREATOR gets the project and NO grant, with `project.access_default_skip { reason }` naming which clause refused - actor_channel_unavailable (a bearer credential however scoped, a non-root login session, a delegated Connector), no_home_group, not_featured, not_a_member or actor_inactive. The last four are re-derived INSIDE this transaction under a lock on the Group row, so a pointer that resolved a moment ago is not trusted here.', requestBody: { required: true, content: { 'application/json': { schema: { $ref: '#/components/schemas/ProjectCreateBody' } } } }, responses: { '201': { description: 'Created — { success, project }', content: { 'application/json': { schema: { $ref: '#/components/schemas/ProjectEnvelope' } } } }, '400': { description: 'UNKNOWN_FIELD / name required' }, '409': { description: 'PROJECT_NAME_CONFLICT / LEGACY_COMPATIBILITY_ONLY (links)' }, '422': { description: 'INVALID_PROJECT_VALUE' } } },
      },
      '/projects/{id}': {
        get: { summary: 'Read one canonical bounded project (includes revision; legacy compatibility bytes are never embedded — see /compatibility for counts)', parameters: [projectIdParam], responses: { '200': { description: 'OK — { success, project }', content: { 'application/json': { schema: { $ref: '#/components/schemas/ProjectEnvelope' } } } }, '404': { description: 'PROJECT_NOT_FOUND' } } },
        patch: { summary: 'Update project details; revision-bound. Archived projects refuse every detail mutation (restore only); status archived is set via /archive, not PATCH.', parameters: [projectIdParam, ifMatchParam], requestBody: { content: { 'application/json': { schema: { $ref: '#/components/schemas/ProjectPatchBody' } } } }, responses: { '200': { description: 'OK — { success, project }', content: { 'application/json': { schema: { $ref: '#/components/schemas/ProjectEnvelope' } } } }, '400': { description: 'REVISION_REQUIRED / UNKNOWN_FIELD' }, '404': { description: 'PROJECT_NOT_FOUND' }, '409': { description: 'PROJECT_ARCHIVED / PROJECT_NAME_CONFLICT' }, '412': { description: 'REVISION_MISMATCH' }, '422': { description: 'INVALID_PROJECT_VALUE' } } },
      },
      '/projects/{id}/archive': {
        post: { summary: 'Archive (reversible; ordinary removal — there is no owner-facing deletion); revision-bound', parameters: [projectIdParam, ifMatchParam], responses: { '200': { description: 'OK' }, '400': { description: 'REVISION_REQUIRED' }, '404': { description: 'PROJECT_NOT_FOUND' }, '412': { description: 'REVISION_MISMATCH' } } },
      },
      '/projects/{id}/unarchive': {
        post: { summary: 'Restore — the only ordinary mutation of an archived project. Rechecks active-name uniqueness atomically.', parameters: [projectIdParam, ifMatchParam], responses: { '200': { description: 'OK' }, '400': { description: 'REVISION_REQUIRED' }, '404': { description: 'PROJECT_NOT_FOUND' }, '409': { description: 'PROJECT_NAME_CONFLICT' }, '412': { description: 'REVISION_MISMATCH' } } },
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
          responses: { '200': { description: 'OK — { resources, nextCursor }' }, '400': { description: 'UNKNOWN_FIELD / INVALID_QUERY_VALUE / INVALID_CURSOR' }, '404': { description: 'PROJECT_NOT_FOUND (absence and denial are indistinguishable)' } },
        },
        post: {
          summary: 'Create one typed Resource (defaults: hidden, installation-only)',
          requestBody: { content: { 'application/json': { schema: { $ref: '#/components/schemas/ResourceWriteBody' } } } },
          responses: { '201': { description: 'Created — { resource }' }, '400': { description: 'UNKNOWN_FIELD' }, '404': { description: 'PROJECT_NOT_FOUND' }, '409': { description: 'PROJECT_ARCHIVED / RESOURCE_NAME_CONFLICT / PRIMARY_REPOSITORY_CONFLICT' }, '422': { description: 'INVALID_RESOURCE_VALUE / UNSUPPORTED_SCHEME / EMBEDDED_CREDENTIAL_FORBIDDEN / WORKSPACE_MUST_BE_INSTALLATION_ONLY' } },
        },
        patch: { summary: 'Deprecated legacy JSONB writer — always 409 LEGACY_COMPATIBILITY_ONLY', responses: { '409': { description: 'LEGACY_COMPATIBILITY_ONLY' } } },
        put: { summary: 'Deprecated legacy JSONB writer — always 409 LEGACY_COMPATIBILITY_ONLY', responses: { '409': { description: 'LEGACY_COMPATIBILITY_ONLY' } } },
      },
      '/projects/{id}/resources/{resourceId}': {
        get: { summary: 'Read one child-bound Resource (cross-project ids are concealed 404s)', parameters: [projectIdParam, resourceIdParam], responses: { '200': { description: 'OK — { resource }' }, '404': { description: 'RESOURCE_NOT_FOUND' } } },
        patch: {
          summary: 'Merge-patch mutable fields (kind immutable — use /replace); revision-bound',
          parameters: [projectIdParam, resourceIdParam, ifMatchParam],
          responses: { '200': { description: 'OK — { resource }' }, '400': { description: 'UNKNOWN_FIELD / REVISION_REQUIRED' }, '404': { description: 'Concealed absence' }, '409': { description: 'PROJECT_ARCHIVED / RESOURCE_ARCHIVED / RESOURCE_NAME_CONFLICT / PRIMARY_REPOSITORY_CONFLICT' }, '412': { description: 'REVISION_MISMATCH' }, '422': { description: 'Validation failure (stable codes)' } },
        },
      },
      '/projects/{id}/resources/{resourceId}/archive': {
        post: { summary: 'Archive (ordinary removal; bytes retained; revision-bound; idempotent under matching revision)', parameters: [projectIdParam, resourceIdParam, ifMatchParam], responses: { '200': { description: 'OK — { resource } with state=archived' }, '404': { description: 'Concealed absence' }, '409': { description: 'PROJECT_ARCHIVED' }, '412': { description: 'REVISION_MISMATCH' } } },
      },
      '/projects/{id}/resources/{resourceId}/restore': {
        post: { summary: 'Restore after active-uniqueness checks (atomic failure on collision)', parameters: [projectIdParam, resourceIdParam, ifMatchParam], responses: { '200': { description: 'OK — { resource } with state=active' }, '404': { description: 'Concealed absence' }, '409': { description: 'PROJECT_ARCHIVED / RESOURCE_NAME_CONFLICT / PRIMARY_REPOSITORY_CONFLICT' }, '412': { description: 'REVISION_MISMATCH' } } },
      },
      '/projects/{id}/resources/{resourceId}/replace': {
        post: {
          summary: 'Atomic kind replacement: archives the old Resource and creates the new identity in one transaction. The only kind-change operation. Idempotent per caller/project/key.',
          parameters: [projectIdParam, resourceIdParam, ifMatchParam,
            { name: 'Idempotency-Key', in: 'header', required: true, schema: { type: 'string', minLength: 16, maxLength: 128 }, description: 'Retry with the SAME key to recover a lost response; a different request under the same key is 409 IDEMPOTENCY_KEY_REUSED.' },
          ],
          requestBody: { content: { 'application/json': { schema: { $ref: '#/components/schemas/ResourceWriteBody' } } } },
          responses: { '201': { description: 'Created — { replacement, replaced, requestId }' }, '400': { description: 'UNKNOWN_FIELD / REVISION_REQUIRED / IDEMPOTENCY_KEY_REQUIRED' }, '404': { description: 'Concealed absence' }, '409': { description: 'PROJECT_ARCHIVED (checked before replay) / RESOURCE_ARCHIVED / RESOURCE_REPLACEMENT_KIND_UNCHANGED / IDEMPOTENCY_KEY_REUSED / uniqueness conflicts' }, '412': { description: 'REVISION_MISMATCH' }, '422': { description: 'Validation failure' } },
        },
      },
      '/projects/{id}/context': {
        get: { summary: 'Typed structured context projection (active + available Resources only; descriptions excluded)', parameters: [projectIdParam], responses: { '200': { description: 'OK — { context }', content: { 'application/json': { schema: { type: 'object', properties: { success: { type: 'boolean' }, context: { $ref: '#/components/schemas/ProjectContext' } } } } } }, '404': { description: 'PROJECT_NOT_FOUND' }, '409': { description: 'PROJECT_ARCHIVED — archived Projects generate no context' } } },
      },
      '/projects/{id}/compatibility': {
        get: { summary: 'Management-only migration counts (mapped/held per legacy surface; never raw legacy values). Requires admin authority.', parameters: [projectIdParam], responses: { '200': { description: 'OK — { compatibility }' }, '403': { description: 'Admin authority required' }, '404': { description: 'PROJECT_NOT_FOUND' } } },
      },
      '/projects/{id}/charter': {
        get: { summary: "The project's authority index (head). Reads serve archived projects too — archived means read-only, not invisible.", parameters: [projectIdParam], responses: { '200': { description: 'OK — { charter }', content: { 'application/json': { schema: { type: 'object', properties: { success: { type: 'boolean' }, charter: { $ref: '#/components/schemas/Charter' } } } } } }, '404': { description: 'PROJECT_NOT_FOUND / CHARTER_NOT_FOUND' } } },
        put: {
          summary: 'Create or replace the Charter content. OWNER-PLANE write (root sentinel): agents propose amendments through Reports, never by writing the object. Create needs no If-Match; replace is revision-bound; identical content is a no-op.',
          parameters: [projectIdParam, { ...ifMatchParam, required: false, description: 'Required when a Charter already exists. 412 REVISION_MISMATCH when stale; 400 REVISION_REQUIRED when absent on replace.' }],
          requestBody: { content: { 'application/json': { schema: { type: 'object', properties: { content: { type: 'string', maxLength: 131072 } }, required: ['content'], additionalProperties: false } } } },
          responses: { '200': { description: 'OK — { charter, created: false, changed }' }, '201': { description: 'Created — { charter, created: true }' }, '400': { description: 'UNKNOWN_FIELD / REVISION_REQUIRED / VALUE_TOO_LONG' }, '404': { description: 'PROJECT_NOT_FOUND (concealed before validation)' }, '409': { description: 'PROJECT_ARCHIVED' }, '412': { description: 'REVISION_MISMATCH' }, '422': { description: 'INVALID_CHARTER_VALUE' } },
        },
      },
      '/projects/{id}/charter/versions': {
        get: { summary: 'Charter version metadata, newest first. Restore = PUT an old version\'s content back to the head.', parameters: [projectIdParam], responses: { '200': { description: 'OK — { versions: [CharterVersionMeta] }' }, '404': { description: 'PROJECT_NOT_FOUND / CHARTER_NOT_FOUND' } } },
      },
      '/projects/{id}/charter/versions/{version}': {
        get: { summary: 'One Charter version, including content.', parameters: [projectIdParam, { name: 'version', in: 'path', required: true, schema: { type: 'integer', minimum: 1 } }], responses: { '200': { description: 'OK — { version }' }, '400': { description: 'INVALID_QUERY_VALUE' }, '404': { description: 'PROJECT_NOT_FOUND / CHARTER_NOT_FOUND / CHARTER_VERSION_NOT_FOUND' } } },
      },
      '/projects/{id}/brief': {
        post: { summary: 'Compile a task Brief at the PROJECT altitude. The task in the body must belong to this project — cross-project ids are concealed 404s. RH-P3.C4 (ii) / D4 retired the generate-brief spelling; it is not aliased.', parameters: [projectIdParam], responses: { '200': { description: 'OK — { brief, tokenEstimate }' }, '400': { description: 'UNKNOWN_FIELD / taskId required' }, '404': { description: 'PROJECT_NOT_FOUND / TASK_NOT_FOUND (concealed)' }, '503': { description: 'CHARTER_LOOKUP_FAILED / GOAL_LOOKUP_FAILED / PHASE_LOOKUP_FAILED — a lookup failure is not confirmed absence; the compile fails closed rather than omitting required context' } } },
      },
      '/personalities': crudPath('List personalities', 'Create a board-managed personality'),
      '/personalities/{id}': {
        get: { summary: 'Get personality by UUID or slug', responses: { '200': { description: 'OK' }, '404': { description: 'Not found' } } },
        patch: { summary: 'Update an active board-managed personality', responses: { '200': { description: 'OK' }, '400': { description: 'Invalid or empty field' }, '404': { description: 'Not found' }, '409': { description: 'Built-in and imported personalities are read-only' } } },
        delete: { summary: 'Soft-retire a board-managed personality while preserving history', responses: { '200': { description: 'Retired' }, '404': { description: 'Not found' }, '409': { description: 'Built-in, imported, and generalist personalities are protected' } } },
      },
      '/skills': {
        get: { summary: 'List Agent Skills catalog and visible immutable Version metadata (skills:read)', parameters: [
          { name: 'category', in: 'query', schema: { type: 'string' } },
          { name: 'tag', in: 'query', schema: { type: 'string' } },
          { name: 'search', in: 'query', schema: { type: 'string' }, description: 'Matches name and description' },
        ], responses: { '200': { description: 'OK — { success, skills }' } } },
        post: { summary: 'Create a stable Skill identity and immutable draft Version (skills:write; resolved Principal required)', responses: { '201': { description: 'Created — { success, skill }' }, '400': { description: 'UNKNOWN_FIELD / VALUE_TOO_LONG' }, '403': { description: 'PRINCIPAL_REQUIRED' }, '409': { description: 'SKILL_NAME_TAKEN' }, '422': { description: 'INVALID_SKILL_VALUE / INVALID_SKILL_DOCUMENT' } } },
      },
      '/skills/{id}': {
        get: { summary: 'Get skill by UUID', parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }], responses: { '200': { description: 'OK — { success, skill }' }, '404': { description: 'Not found' } } },
        put: { summary: 'Create the next immutable draft Version; never mutate prior content (skills:write, revision-bound)', parameters: [{ ...ifMatchParam, required: true }], responses: { '201': { description: 'Draft created — { success, skill }' }, '400': { description: 'UNKNOWN_FIELD / REVISION_REQUIRED / VALUE_TOO_LONG' }, '403': { description: 'PRINCIPAL_REQUIRED' }, '404': { description: 'SKILL_NOT_FOUND' }, '412': { description: 'REVISION_MISMATCH' }, '422': { description: 'INVALID_SKILL_VALUE / INVALID_SKILL_DOCUMENT' } } },
        delete: { summary: 'Restricted hard delete (skills:admin); refused while history or pins exist', parameters: [{ ...ifMatchParam, required: true }], responses: { '200': { description: 'Deleted' }, '400': { description: 'UNKNOWN_FIELD / REVISION_REQUIRED' }, '404': { description: 'SKILL_NOT_FOUND' }, '409': { description: 'SKILL_HAS_HISTORY' }, '412': { description: 'REVISION_MISMATCH' } } },
      },
      '/skills/{id}/versions': {
        get: { summary: 'List immutable Version metadata newest first (skills:read)', responses: { '200': { description: 'OK — { success, versions }' }, '404': { description: 'SKILL_NOT_FOUND' } } },
      },
      '/skills/{id}/versions/{version}': {
        get: { summary: 'Get exact immutable Version metadata by number or UUID (skills:read)', responses: { '200': { description: 'OK — { success, version }' }, '404': { description: 'SKILL_VERSION_NOT_FOUND' } } },
      },
      '/skills/{id}/versions/{version}/content': {
        get: { summary: 'Fetch exact full SKILL.md with digest ETag (skills:use)', responses: { '200': { description: 'OK — { success, version.skill_md }' }, '404': { description: 'SKILL_VERSION_NOT_FOUND' } } },
      },
      '/skills/{id}/versions/{version}/submit-review': {
        post: { summary: 'Move draft to review (skills:write; revision-bound)', responses: { '200': { description: 'Review requested' }, '409': { description: 'SKILL_LIFECYCLE_CONFLICT' }, '412': { description: 'REVISION_MISMATCH' } } },
      },
      '/skills/{id}/versions/{version}/reject': {
        post: { summary: 'Return review to draft with an optional note (skills:write; revision-bound)', responses: { '200': { description: 'Returned to draft' }, '409': { description: 'SKILL_LIFECYCLE_CONFLICT' }, '412': { description: 'REVISION_MISMATCH' } } },
      },
      '/skills/{id}/versions/{version}/publish': {
        post: { summary: 'Publish after independent human-admin review (skills:admin; revision-bound)', responses: { '200': { description: 'Published' }, '403': { description: 'HUMAN_REVIEW_REQUIRED' }, '409': { description: 'INDEPENDENT_REVIEW_REQUIRED / SKILL_LIFECYCLE_CONFLICT' }, '412': { description: 'REVISION_MISMATCH' } } },
      },
      '/skills/{id}/versions/{version}/retire': {
        post: { summary: 'Terminal retirement (skills:admin); existing exact pins keep resolving', responses: { '200': { description: 'Retired' }, '409': { description: 'SKILL_LIFECYCLE_CONFLICT' }, '412': { description: 'REVISION_MISMATCH' } } },
      },
      '/skills/{id}/audience': {
        patch: { summary: 'Set or remove broad global audience (skills:admin; current publication required)', responses: { '200': { description: 'Audience changed' }, '412': { description: 'REVISION_MISMATCH' }, '422': { description: 'INVALID_SKILL_VALUE' } } },
      },
      '/projects/{id}/skills': {
        get: { summary: 'List exact immutable Skill Version pins. Legacy /projects/{id}/tools answers 409 LEGACY_COMPATIBILITY_ONLY.', parameters: [projectIdParam], responses: { '200': { description: 'OK — { success, skills }' }, '404': { description: 'PROJECT_NOT_FOUND' } } },
      },
      '/projects/{id}/skills/{skillId}': {
        put: { summary: 'Create or replace an exact pin; target Version must currently be published', responses: { '200': { description: 'Pinned' }, '409': { description: 'PROJECT_ARCHIVED / PUBLISHED_VERSION_REQUIRED' } } },
        delete: { summary: 'Remove an exact Project Skill pin', responses: { '200': { description: 'Pin removed' }, '404': { description: 'SKILL_PIN_NOT_FOUND' }, '409': { description: 'PROJECT_ARCHIVED' } } },
      },
      '/services': {
        get: { summary: 'List registered services (a Connector is a kind of Service that pulls and executes work; retired services excluded by default)', parameters: [
          { name: 'kind', in: 'query', schema: { type: 'string', enum: ['service', 'connector'] } },
          { name: 'status', in: 'query', schema: { type: 'string', enum: ['draft', 'published', 'retired'] } },
          { name: 'includeRetired', in: 'query', schema: { type: 'boolean' } },
        ], responses: { '200': { description: 'OK — { success, services }' } } },
        post: { summary: 'Register a service (services:write; starts draft, direct mode, assigned-only tier). Subscription-class fields (delivery, visibility tier) are owner-plane only — see /services/{id}/owner-plane. CONNECTOR registrations by an authenticated LOGIN SESSION may pass issueCredential {scopes, label?, transport?} to mint the first credential in the same call and receive the ONE-TIME §7.4 onboarding pack (AZ-S5; non-root sessions: scopes ⊆ the session\'s current effective set — §5.2 rule 1; bearer callers issue through POST /principals/{id}/credentials, whose connector responses also carry the pack).', responses: { '201': { description: 'Created — { success, service, onboarding? }' }, '409': { description: 'SERVICE_SLUG_TAKEN' }, '422': { description: 'INVALID_SERVICE_VALUE / BROKERED_MODE_NOT_AVAILABLE (v1 runs direct-mode services only, C5)' } } },
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
        get: { summary: 'One descriptor version, including content — the exact bytes an execution-profile pin resolves to', parameters: [{ name: 'version', in: 'path', required: true, schema: { type: 'integer', minimum: 1 } }], responses: { '200': { description: 'OK — { success, descriptorVersion }' }, '404': { description: 'SERVICE_NOT_FOUND / DESCRIPTOR_VERSION_NOT_FOUND' } } },
      },
      '/services/{id}/retire': {
        post: { summary: 'Retire the service (services:admin; irreversible §4.4): stops new consumers, record and versions stay', responses: { '200': { description: 'OK' }, '404': { description: 'SERVICE_NOT_FOUND' }, '409': { description: 'SERVICE_RETIRED' }, '412': { description: 'REVISION_MISMATCH' } } },
      },
      '/services/{id}/descriptor/versions/{version}/retire': {
        post: { summary: 'Retire ONE descriptor version (services:admin; RH-DESIGN.5 R5 staged retirement): existing pins keep resolving, profile paths refuse retired pins', parameters: [{ name: 'version', in: 'path', required: true, schema: { type: 'integer', minimum: 1 } }], responses: { '200': { description: 'OK — { success, version }' }, '404': { description: 'SERVICE_NOT_FOUND / DESCRIPTOR_VERSION_NOT_FOUND' }, '409': { description: 'DESCRIPTOR_VERSION_RETIRED' } } },
      },
      '/phases': {
        get: { summary: 'List Phases — the grouping object between Project and Task (phases:read). Ordered by (position, created_at, id); position orders but does not exclude, because Phases may overlap. Archived Phases are excluded unless includeArchived=true or status=archived.', parameters: [
          { name: 'projectId', in: 'query', schema: { type: 'string', format: 'uuid' } },
          { name: 'status', in: 'query', schema: { type: 'string', enum: ['todo', 'in-progress', 'completed', 'archived'] } },
          { name: 'includeArchived', in: 'query', schema: { type: 'boolean' } },
        ], responses: { '200': { description: 'OK — { success, phases }' }, '400': { description: 'INVALID_QUERY_VALUE / UNKNOWN_FIELD' } } },
        post: { summary: 'Create a Phase under an ACTIVE Project (phases:write). Body: { projectId, name, goal?, status?, position? }. goal is the outcome PROPERTY (never a table). status accepts todo | in-progress | completed — archiving has its own verb.', responses: { '201': { description: 'Created — { success, phase }' }, '404': { description: 'PROJECT_NOT_FOUND' }, '409': { description: 'PROJECT_ARCHIVED' }, '422': { description: 'INVALID_PHASE_VALUE' } } },
      },
      '/phases/{id}': {
        get: { summary: 'Get one Phase (phases:read). Absence and denial are the same concealed 404.', parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }], responses: { '200': { description: 'OK — { success, phase }' }, '404': { description: 'PHASE_NOT_FOUND' } } },
        patch: { summary: 'Update a Phase (phases:write). revision is the If-Match guard. Archived Phases are read-only — unarchive first.', parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }], responses: { '200': { description: 'OK — { success, phase }' }, '404': { description: 'PHASE_NOT_FOUND' }, '409': { description: 'REVISION_MISMATCH / PHASE_ARCHIVED' }, '422': { description: 'INVALID_PHASE_VALUE' } } },
        delete: { summary: 'Hard-delete a Phase (phases:admin — the restricted verb, §4.4). Refused while Tasks still reference it (PHASE_IN_USE); prefer archive.', parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }], responses: { '200': { description: 'OK — { success, phase }' }, '404': { description: 'PHASE_NOT_FOUND' }, '409': { description: 'PHASE_IN_USE' } } },
      },
      '/phases/{id}/tasks': {
        get: { summary: "A Phase's member Tasks (phases:read AND tasks:read — it discloses Task content, exactly like the brief), id + title + status only: a phase-altitude view is a reading artifact; the machine path is the per-task Brief.", parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }], responses: { '200': { description: 'OK — { success, tasks }' }, '403': { description: 'BRIEF_TASKS_READ_REQUIRED' }, '404': { description: 'PHASE_NOT_FOUND' } } },
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
        get: { summary: "A Project's Phases (projects:read), the same rows as /phases?projectId= but reached through the Project family.", parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }, { name: 'includeArchived', in: 'query', schema: { type: 'boolean' } }], responses: { '200': { description: 'OK — { success, phases }' }, '404': { description: 'PROJECT_NOT_FOUND' } } },
      },
      '/groups': {
        get: { summary: 'List Groups with member counts (principals:read — directory disclosure, A12.5). Groups are board-minted, immutable-id member sets of Accounts (A17.6); mutation is owner-plane.', responses: { '200': { description: 'OK — { success, groups }' } } },
        post: { summary: 'Create a Group (owner plane, root — §9.1, T13). Names are unique case-insensitively.', responses: { '201': { description: 'Created — { success, group }' }, '409': { description: 'GROUP_NAME_EXISTS' }, '422': { description: 'INVALID_GROUP_VALUE' } } },
      },
      '/groups/directory-sync': {
        get: { summary: 'Directory-sync staleness read (root; AZ-30 seam): per-provider snapshot watermark, error flag and stale verdict past the threshold (default 24h). The provider binding itself is Phase 5 (task 2ae39bda).', responses: { '200': { description: 'OK — { success, providers }' } } },
      },
      '/groups/{id}': {
        get: { summary: 'One Group with member count (principals:read).', parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }], responses: { '200': { description: 'OK — { success, group }' }, '404': { description: 'GROUP_NOT_FOUND' } } },
        patch: { summary: 'Rename / redescribe / FEATURE a Group (owner plane, root; REST only, never MCP). The id is immutable (A17.6). RH-LENSES-b (design 96f0bd3d s7.1): `featured` is presentation-level promotion - it GRANTS NOTHING, no authorization predicate reads it, and an unfeatured Group keeps every member and grant it has. It decides which Groups a person may choose as a home group, and a change is audited as `group.feature_set` with old and new. Accepted fields: name, description, featured. Directory binding fields are NOT written here: the directory group reference catalog is the single seam that binds a Group, inside its carriage transaction.', parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }], responses: { '200': { description: 'OK — { success, group }' }, '404': { description: 'GROUP_NOT_FOUND' }, '409': { description: 'GROUP_NAME_EXISTS / DIRECTORY_BINDING_MANAGED (binding fields require the directory group reference catalog)' } } },
        delete: { summary: 'Delete an EMPTY Group (owner plane, root); its group-grant rows are deleted in the same transaction — grants are live configuration.', parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }], responses: { '200': { description: 'OK — { success, group }' }, '404': { description: 'GROUP_NOT_FOUND' }, '409': { description: 'GROUP_NOT_EMPTY; GROUP_GATES_LOGIN; GROUP_IS_A_HOME_GROUP - RH-LENSES-b (A-L38): some Accounts still have this Group as their home group. The refusal names the COUNT and never the identities; clear them with DELETE /groups/{id}/home-pointers first.' } } },
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
            + 'disclosure); the in-handler projection narrows FURTHER and is not the ceiling: in v1 a '
            + 'ROOT LOGIN SESSION sees every row and EVERY OTHER CALLER -- bearer or session, however '
            + 'scoped -- receives 200 with an EMPTY LIST. A 403 on a list route would disclose that the '
            + 'surface exists and is populated.',
          responses: {
            '200': { description: 'OK - { success, references }. An empty list for every caller outside the projection.' },
          },
        },
      },
      '/directory-group-references/{id}': {
        get: {
          summary:
            'One catalog row. A reference OUTSIDE the caller projection answers 404 '
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
        get: { summary: 'What-if preview of ANOTHER principal\'s effective object authority (owner plane, root — §9.5): grants, group grants and published profile rules, from the same tables the evaluator consults. The SELF preview is GET /principals/me/effective-access.', parameters: [{ name: 'principalId', in: 'query', required: true, schema: { type: 'string', format: 'uuid' } }], responses: { '200': { description: 'OK — { success, access }' }, '400': { description: 'INVALID_QUERY_VALUE' } } },
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
        patch: { summary: 'Name/description only. Warrant AUTHORITY is immutable (422 WARRANT_AUTHORITY_IMMUTABLE): widening is a NEW warrant under a fresh approval act; narrowing is revocation.', parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }], responses: { '200': { description: 'OK' }, '404': { description: 'WARRANT_NOT_FOUND' }, '422': { description: 'WARRANT_AUTHORITY_IMMUTABLE / INVALID_WARRANT_VALUE' } } },
      },
      '/warrants/{id}/revoke': {
        post: { summary: 'Revoke (§6.4): keeps the record (status + events), stops new mints NOW and blocks further lease-driven extensions for minted Agents. The protective direction — session, no step-up. Idempotent. RH-P3.AZ-S7 (ruling 7440b579 R4): revocation first WARNS — without body { acknowledgeDependents: true } it refuses 409 WARRANT_HAS_DEPENDENT_TASKS and ENUMERATES the not-yet-terminal Tasks riding the warrant; with the acknowledgement it proceeds and AUTO-UNASSIGNS them, which also silences their delivery (ccd53781 R2). Work already in flight finishes on its own task-bounded credentials; force-release remains the hard stop.', parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }], requestBody: { required: false, content: { 'application/json': { schema: { type: 'object', additionalProperties: false, properties: { reason: { type: 'string', maxLength: 500 }, acknowledgeDependents: { type: 'boolean', description: 'Proceed after seeing the dependent-task warning; the dependent Tasks are auto-unassigned.' } } } } } }, responses: { '200': { description: 'OK — { success, warrant }' }, '404': { description: 'WARRANT_NOT_FOUND' }, '409': { description: 'WARRANT_EXPIRED — expiry is one-way (§6.2) / WARRANT_HAS_DEPENDENT_TASKS — the R4 warning, listing what a proceed would unassign' } } },
      },
      '/warrants/{id}/resume': {
        post: { summary: 'Resume a SUSPENDED warrant (§6.4 — suspension is resumable only by this re-approval act): session + step-up bound to (warrant.resume, id); the AZ-31a creator live-cap re-proves first (409 CREATOR_CAP_UNMET otherwise). Revoked/expired warrants never resume.', parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }], responses: { '200': { description: 'OK — { success, warrant }' }, '403': { description: 'STEP_UP_REQUIRED' }, '404': { description: 'WARRANT_NOT_FOUND' }, '409': { description: 'WARRANT_NOT_SUSPENDED / CREATOR_CAP_UNMET' } } },
      },
      '/approvals': {
        get: { summary: 'The Approval queue (AZ-S4, design 4d961e37 §6.1, A17.11). SESSION-ONLY with the self-scope arm (AZ-16): a non-root session sees only items whose requester lies in its own subtree; root sees all. ?status= filters the pending·approved·denied·collected·lapsed lifecycle.', parameters: [{ name: 'status', in: 'query', schema: { type: 'string', enum: ['pending', 'approved', 'denied', 'collected', 'lapsed'] } }], responses: { '200': { description: 'OK — { success, approvals }' }, '403': { description: 'SESSION_ONLY' } } },
      },
      '/approvals/{id}': {
        get: { summary: 'One approval with its append-only event ledger. 404-concealed outside the self-scope arm.', parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }], responses: { '200': { description: 'OK — { success, approval, events }' }, '404': { description: 'APPROVAL_NOT_FOUND (foreign approvals concealed)' } } },
      },
      '/approvals/{id}/approve': {
        post: { summary: 'Approve a pending mint request (§6.1, T7 board-only): session + single-use step-up bound to (approval.decide, id). The approver may EDIT the authority DOWN — body { stepUpToken, editedScopes?, editedRules? } within the request (422 EDIT_ONLY_NARROWS otherwise). The decision re-runs the FULL mint validation (requester live, BOUND credential live and un-graced — AZ-31c, task mintable, authority ⊆ the requester\'s CURRENT effective set) and refuses loudly on failure, leaving the item pending. Approval arms a SINGLE-USE authorization: collect within 24 hours or it lapses.', parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }], responses: { '200': { description: 'OK — { success, approval }' }, '403': { description: 'SESSION_ONLY / STEP_UP_REQUIRED / MINT_EXCEEDS_REQUESTER' }, '404': { description: 'APPROVAL_NOT_FOUND' }, '409': { description: 'APPROVAL_NOT_PENDING / APPROVAL_LAPSED / TASK_TERMINAL / CREDENTIAL_ROTATED…' }, '422': { description: 'EDIT_ONLY_NARROWS' } } },
      },
      '/approvals/{id}/deny': {
        post: { summary: 'Deny a pending mint request (§6.1): session + step-up bound to (approval.decide, id). Body { stepUpToken, reason? }.', parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }], responses: { '200': { description: 'OK — { success, approval }' }, '403': { description: 'SESSION_ONLY / STEP_UP_REQUIRED' }, '404': { description: 'APPROVAL_NOT_FOUND' }, '409': { description: 'APPROVAL_NOT_PENDING' } } },
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
      '/delegation/agent-mints/{approvalId}/collect': {
        post: { summary: 'COLLECT an approved authorization (§6.1, AZ-31c): SINGLE-USE, by the SAME connector credential that requested (foreign credentials 404-conceal), within the 24h TTL. Re-runs the COMPLETE mint validation transactionally with Approval consumption and Principal/Credential creation (T27: approve-after-rotate refuses by construction; narrow/disable/task-terminal between decide and collect refuse here). A TERMINAL failure lapses the Approval with an audited reason; a TRANSIENT failure (e.g. WRITER_SLOT_TAKEN) refuses WITHOUT consuming it.', parameters: [{ name: 'approvalId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }], responses: { '201': { description: 'Minted — { success, pack } (the pack renders once, never stored)' }, '403': { description: 'CREDENTIAL_BOUND / MINT_EXCEEDS_REQUESTER' }, '404': { description: 'APPROVAL_NOT_FOUND (wrong credential concealed)' }, '409': { description: 'APPROVAL_NOT_COLLECTABLE / APPROVAL_LAPSED / WRITER_SLOT_TAKEN' } } },
      },
      '/principals/remediation-queue': {
        get: { summary: 'The §10 Access-manager remediation queue (AZ-S4; owner plane, root): every legacy_identity row (frozen out of the new machinery, evaluated under the Phase-2 arms until the owner-executed Phase-5 transition) and every parentless service Account whose purpose is still the sol-M9 backfill text, each with its live-credential count and replacement guidance.', responses: { '200': { description: 'OK — { success, queue }' } } },
      },
      '/principals/me/brief': {
        post: { summary: 'Compile the SESSION Brief for the identity this credential acts as — the fourth altitude of the Brief family (vocabulary b94dd86e §3; strategy §2.10). Personality inlined, the bound Task\'s attached Reports, the caller\'s granted skill index and the board-workflow doctrine, assembled server-side as one payload. This call is also what records the credential as bootstrapped: until it has, MCP work-plane tool calls are refused with "bootstrap first". Requires principals:read. Body options: inlineReports, tokenBudget.', responses: { '200': { description: 'OK — { success, brief, principalId, credentialId, bootstrappedUntil, tokenEstimate }' }, '400': { description: 'INVALID_COMPILE_OPTION' }, '404': { description: 'No principal or credential resolved for this identity' }, '503': { description: 'REPORT_REFERENCE_LOOKUP_FAILED — a lookup failure is not confirmed absence; the compile fails closed and the credential is NOT recorded as bootstrapped' } } },
      },
      '/principals/me/effective-access': {
        get: { summary: 'The caller\'s OWN effective object authority (principals:read — §9.2): direct grants, group grants, and published profile rules reached directly or through group assignment. Scope ceilings are the route plane and are not repeated here.', responses: { '200': { description: 'OK — { success, access }' }, '404': { description: 'No principal resolved' } } },
      },
      '/principals/me/home-group': {
        get: { summary: 'RH-LENSES-b (card 4287af8a; design 96f0bd3d s7.2): the caller OWN home group (authenticated - the route has no target identifier, so authentication plus the resolved caller principal is the whole boundary; the D-5 precedent). The stored row is a POINTER and the answer is DERIVED at read (derivation D-L2): it resolves only while the Group is featured, the Account is a member of it, and the Account is active. The payload carries all three - the resolved value, the raw pointer that SURVIVES an unresolving state, and `unresolvedReason` in { no_home_group, not_featured, not_a_member, actor_inactive } saying which clause failed. Restoring any of the three makes it resolve again with NO re-write.', responses: { '200': { description: 'OK - { success, homeGroup: { groupId, groupName, pointer, unresolvedReason } }' }, '404': { description: 'No principal resolved for this identity' } } },
        put: { summary: 'Choose a home group (authenticated; owner decision 3 - "the person may switch among their featured groups"). Body { groupId }. The Group must be FEATURED and the caller a MEMBER of it; otherwise the named refusal below. THE ACT CONFERS NOTHING: authority moves at one later act, the creation default of s7.3, which re-derives featured, membership and active status at its own write under a lock rather than trusting this pointer. Writes source=self and audits `home_group.set`; a refusal is a durable audited denial.', responses: { '200': { description: 'OK - { success, homeGroup }' }, '400': { description: 'UNKNOWN_FIELD - accepted fields are: groupId' }, '404': { description: 'GROUP_NOT_FOUND, or no principal resolved for this identity' }, '422': { description: 'GROUP_NOT_FEATURED - a home group is chosen from the featured groups; NOT_A_GROUP_MEMBER - a home group is one the Account belongs to; HOME_GROUP_ACCOUNT_INACTIVE - the target Account is absent or inactive; INVALID_HOME_GROUP_VALUE - groupId must be a full UUID' } } },
        delete: { summary: 'Clear the caller OWN home-group pointer (authenticated). Clearing an absent pointer is a no-op and answers 200, not 404: the caller stated end state is reached. Audits `home_group.clear`.', responses: { '200': { description: 'OK - { success, homeGroup }' }, '404': { description: 'No principal resolved for this identity' } } },
      },
      '/principals/{id}/home-group': {
        put: { summary: 'RH-LENSES-b: an administrator sets a home group FOR an Account (owner decision 3), writing source=admin. Body { groupId }. CEILING: principals:admin from the /principals family rule, NARROWED in the handler to a ROOT LOGIN SESSION - the session-versus-bearer classification is IMPORTED from utils/administratorSession and never re-implemented (AZ-18: machine credentials do not perform session acts). The target Account must remain active under a principal row lock until commit; the same featured + membership admission rules apply, and the act confers nothing.', parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }], responses: { '200': { description: 'OK - { success, homeGroup }' }, '400': { description: 'UNKNOWN_FIELD - accepted fields are: groupId' }, '403': { description: 'REQUIRES_LOGIN_SESSION - a bearer credential never performs this act; ROOT_SESSION_REQUIRED - a non-root login session is refused' }, '404': { description: 'GROUP_NOT_FOUND' }, '422': { description: 'GROUP_NOT_FEATURED / NOT_A_GROUP_MEMBER / HOME_GROUP_ACCOUNT_INACTIVE / INVALID_HOME_GROUP_VALUE / INVALID_PRINCIPAL_ID' } } },
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
        post: { summary: 'Re-reveal a stored credential secret (AZ-S3, design 4d961e37 §7.1/§7.2, AZ-20). AUTHORIZATION AND CONCEALMENT COME FIRST: any target outside a non-root caller lineage answers 404 — existence and lifecycle state are never confirmed. Bearer callers: own descendant lineage only, and the revealed authority must lie within the PRESENTING credential effective scopes (403 REVEAL_EXCEEDS_PRESENTING — T20). Session callers: single-use step-up token bound to exactly this reveal (body {stepUpToken}; §7.6, T16 — a replayed, expired or re-targeted token answers 403 STEP_UP_REQUIRED). Graced/revoked/expired credentials never reveal; the decrypt is hash-verified before returning (T30); reveals are rate-limited with an audited alert and every reveal is audited with layer + step-up evidence + the full chain.', parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }], responses: { '200': { description: 'OK — { success, keyId, secret }' }, '403': { description: 'STEP_UP_REQUIRED / REVEAL_EXCEEDS_PRESENTING' }, '404': { description: 'CREDENTIAL_NOT_FOUND — includes 404-concealed foreign targets in ANY lifecycle state' }, '409': { description: 'CREDENTIAL_REVOKED / CREDENTIAL_EXPIRED / CREDENTIAL_GRACED / CREDENTIAL_NOT_REVEALABLE / LEGACY_FROZEN (in-lineage targets only)' }, '429': { description: 'REVEAL_RATE_LIMITED (alert audited)' } } },
      },
      '/principals/{id}/terminate': {
        post: { summary: 'Irreversible offboarding (A17.10, T24): the principal AND its descendant subtree get the durable terminated status; every credential in the subtree is revoked permanently; re-enable and issuance refuse terminated principals. Idempotent. Owner-plane (manage gate).', parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }], responses: { '200': { description: 'OK — { success, terminated[], revokedCredentials }' }, '404': { description: 'PRINCIPAL_NOT_FOUND' } } },
      },
      '/auth/step-up': {
        post: { summary: 'Mint a SINGLE-USE elevation token (AZ-S3, design 4d961e37 §7.6, AZ-23): bound to ONE named action + target id, ~5-minute TTL, minted only after password re-entry on a LOGIN SESSION (bearer credentials never step up — AZ-18); the consuming endpoint burns it. Step-up authorizes the act and never widens any ceiling.', responses: { '200': { description: 'OK — { success, stepUpToken, expiresAt }' }, '400': { description: 'action/targetId/password required' }, '401': { description: 'Invalid password or non-session caller' } } },
      },
      '/grants': {
        get: { summary: 'List object-level grants (owner plane, root). Filters: ?granteeId=, ?resourceType=. A grant is (grantee, resource, verb) with a typed NULL wildcard and optional expiry.', parameters: [
          { name: 'granteeId', in: 'query', schema: { type: 'string', format: 'uuid' } },
          { name: 'resourceType', in: 'query', schema: { type: 'string', enum: ['task', 'phase', 'project', 'report', 'skill', 'personality', 'service', 'plugin', 'surface'] } },
        ], responses: { '200': { description: 'OK — { success, grants }' }, '400': { description: 'INVALID_QUERY_VALUE' } } },
        post: { summary: 'Create a grant (owner plane, root; §2.9 — grant mutation stays out of the agent plane). Grantees are principals or Groups (AZ-S1, design 4d961e37 §3): a group grant reaches ACTIVE member Accounts by membership join at query time. resourceId omitted/null = the type-wide wildcard.', responses: { '201': { description: 'Created — { success, grant }' }, '409': { description: 'GRANT_EXISTS' }, '422': { description: 'INVALID_GRANT_VALUE / GRANTEE_NOT_FOUND / GRANTEE_DISABLED' } } },
      },
      '/grants/{id}': {
        delete: { summary: 'Revoke a grant (owner plane, root). Revocation is deletion — grants are live authority configuration, not history.', parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }], responses: { '200': { description: 'OK — { success, grant }' }, '400': { description: 'INVALID_GRANT_ID' }, '404': { description: 'GRANT_NOT_FOUND' } } },
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
