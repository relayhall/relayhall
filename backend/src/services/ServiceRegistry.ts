// ServiceRegistry.ts — the Service and Connector registry (RH-P2.1, task a4af8cf2).
//
// A Service is a registered external system; a Connector is a kind of Service
// that pulls and executes work (D-5: one registry, one table). Capability
// descriptors are IMMUTABLE versioned records (strategy §2.1): publishing is
// an append + head bump in one transaction; nothing edits a published
// version; version-level retirement stops new consumers while existing pins
// keep resolving (§4.2), and the execution-profile paths fail closed on
// retired pins (RH-DESIGN.5 R5, wired by RH-P2.2).
//
// Authority split (§2.6.4/§2.9, deliberate): metadata and descriptor
// publishing are agent-plane services:write; retirement/delete are
// services:admin; delivery configuration, visibility tier and runtime mode
// are SUBSCRIPTION-CLASS — writable only through the owner plane (root at
// v1) via the separate owner-plane method, so a prompt-injected connector
// holding services:write structurally cannot repoint its own delivery.
//
// Attribution is server-written (created_by/updated_by principal ids and the
// append-only version record). These events join the board-wide audit log
// when RH-P2.7 builds it; the contract is documented in docs/services.md.
import type { PoolClient } from 'pg';
import { pool } from '../db/connection';
import { lifecyclePolicyService } from './LifecyclePolicyService';
import crypto from 'crypto';
import { principalService } from './PrincipalService';
import { auditService, type AuditActor } from './AuditService';
import {
  ServiceDescriptor,
  validateDescriptor,
} from '../utils/serviceDescriptor';
import {
  isKnowledgeCapable,
  KnowledgePolicyError,
  RESERVED_SERVICE_SLUGS,
  validateAllowedNetworks,
  validateClaimsMode,
  validateCoreCredentialRef,
  validateKnowledgeEndpoint,
  validateRelevantGroups,
  validateSubjectMode,
  type KnowledgeClaimsMode,
  type KnowledgeSubjectMode,
} from './KnowledgeSourcePolicy';

export const SERVICE_KINDS = ['service', 'connector'] as const;
export type ServiceKind = (typeof SERVICE_KINDS)[number];

export const SERVICE_STATUSES = ['draft', 'published', 'retired'] as const;
export type ServiceStatus = (typeof SERVICE_STATUSES)[number];

export const VISIBILITY_TIERS = ['assigned-only', 'unrestricted'] as const;
export const DELIVERY_MODES = ['webhook', 'poll', 'none'] as const;
export const TELEMETRY_TIERS = ['none', 'presence', 'full'] as const;
export const RUNTIME_MODES = ['direct', 'brokered'] as const;

export const SERVICE_SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;
export const MIN_POLL_INTERVAL_SECONDS = 30;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface ServiceRecord {
  id: string;
  slug: string;
  name: string;
  description: string;
  kind: ServiceKind;
  runtimeMode: (typeof RUNTIME_MODES)[number];
  status: ServiceStatus;
  visibilityTier: (typeof VISIBILITY_TIERS)[number];
  deliveryMode: (typeof DELIVERY_MODES)[number];
  deliveryEndpoint: string | null;
  /**
   * Whether a signing secret is configured. The SECRET ITSELF is never
   * returned by any read path — a delivery secret that round-trips through a
   * list response is a secret in every log and cache between here and the
   * caller.
   */
  deliveryHasSecret: boolean;
  deliveryPollIntervalSeconds: number | null;
  telemetryTier: (typeof TELEMETRY_TIERS)[number];
  currentDescriptorVersion: number | null;
  /**
   * KNOWLEDGE-DESIGN `94747de9` §4.2 — the owner-plane knowledge
   * configuration. Written ONLY through `updateOwnerPlane` (root sentinel);
   * `services:write` cannot reach any of them, which is the trust surface
   * §4.2 is. `knowledgeCoreCredentialRef` is a reference NAME and never a
   * secret value (§4.2), so unlike `deliverySecret` it reads back.
   */
  knowledgeQueryEndpoint: string | null;
  knowledgeGetEndpoint: string | null;
  knowledgeCoreCredentialRef: string | null;
  knowledgeClaimsMode: KnowledgeClaimsMode;
  knowledgeSubjectMode: KnowledgeSubjectMode;
  knowledgeRelevantGroups: string[];
  knowledgeAllowedNetworks: string[];
  revision: string;
  createdByPrincipalId: string | null;
  updatedByPrincipalId: string | null;
  createdAt: string;
  updatedAt: string;
  retiredAt: string | null;
}

export interface DescriptorVersionMeta {
  version: number;
  contentHash: string;
  createdByPrincipalId: string | null;
  createdAt: string;
  retiredAt: string | null;
}

export interface DescriptorVersion extends DescriptorVersionMeta {
  descriptor: ServiceDescriptor;
}

export class ServiceRegistryError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly field?: string,
  ) {
    super(message);
    this.name = 'ServiceRegistryError';
  }
}

const err = (status: number, code: string, message: string, field?: string) =>
  new ServiceRegistryError(status, code, message, field);

function sha256Hex(content: string): string {
  return crypto.createHash('sha256').update(content, 'utf8').digest('hex');
}

/** Stable serialization so content-hash equality means semantic equality. */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(',')}]`;
  }
  if (typeof value === 'object' && value !== null) {
    const entries = Object.keys(value as Record<string, unknown>)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonicalJson((value as Record<string, unknown>)[k])}`);
    return `{${entries.join(',')}}`;
  }
  return JSON.stringify(value);
}

function mapRow(row: any): ServiceRecord {
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    description: row.description,
    kind: row.kind,
    runtimeMode: row.runtime_mode,
    status: row.status,
    visibilityTier: row.visibility_tier,
    deliveryMode: row.delivery_mode,
    deliveryEndpoint: row.delivery_endpoint ?? null,
    deliveryHasSecret: Boolean(row.delivery_secret),
    deliveryPollIntervalSeconds: row.delivery_poll_interval_seconds ?? null,
    telemetryTier: row.telemetry_tier,
    currentDescriptorVersion: row.current_descriptor_version ?? null,
    knowledgeQueryEndpoint: row.knowledge_query_endpoint ?? null,
    knowledgeGetEndpoint: row.knowledge_get_endpoint ?? null,
    knowledgeCoreCredentialRef: row.knowledge_core_credential_ref ?? null,
    knowledgeClaimsMode: row.knowledge_claims_mode ?? 'asserted',
    knowledgeSubjectMode: row.knowledge_subject_mode ?? 'pairwise',
    knowledgeRelevantGroups: row.knowledge_relevant_groups ?? [],
    knowledgeAllowedNetworks: row.knowledge_allowed_networks ?? [],
    revision: row.revision,
    createdByPrincipalId: row.created_by_principal_id ?? null,
    updatedByPrincipalId: row.updated_by_principal_id ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    retiredAt: row.retired_at ?? null,
  };
}

function mapVersionMeta(row: any): DescriptorVersionMeta {
  return {
    version: row.version,
    contentHash: row.content_hash,
    createdByPrincipalId: row.created_by_principal_id ?? null,
    createdAt: row.created_at,
    retiredAt: row.retired_at ?? null,
  };
}

function validateName(value: unknown): string {
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > 128) {
    throw err(422, 'INVALID_SERVICE_VALUE', 'name must be a non-empty string of at most 128 characters', 'name');
  }
  return value.trim();
}

function validateSlug(value: unknown): string {
  // KNOWLEDGE-DESIGN §9 / census `abc71ffb` F8: `board` is the reserved slug
  // of the in-process pseudo-source, and the knowledge-capability predicate
  // admits it with NO owner-plane endpoint. A write surface that could claim
  // it would let any `services:write` holder become knowledge-capable
  // without the owner-plane act §4.2 exists to be. Reserved rows are written
  // by the migration chain and by nothing else.
  if (typeof value === 'string' && RESERVED_SERVICE_SLUGS.has(value)) {
    throw err(
      422,
      'RESERVED_SERVICE_SLUG',
      `slug '${value}' is reserved for a core-managed source and cannot be registered (design 94747de9 §9)`,
      'slug',
    );
  }
  if (typeof value !== 'string' || !SERVICE_SLUG_PATTERN.test(value)) {
    throw err(
      422,
      'INVALID_SERVICE_VALUE',
      `slug must match ${SERVICE_SLUG_PATTERN} (lowercase letters, digits and '-', max 64 chars)`,
      'slug',
    );
  }
  return value;
}

function validateDescription(value: unknown): string {
  if (value === undefined) return '';
  if (typeof value !== 'string' || value.length > 4096) {
    throw err(422, 'INVALID_SERVICE_VALUE', 'description must be a string of at most 4096 characters', 'description');
  }
  return value;
}

function validateChoice<T extends readonly string[]>(
  value: unknown,
  choices: T,
  field: string,
): T[number] {
  if (typeof value !== 'string' || !(choices as readonly string[]).includes(value)) {
    throw err(
      422,
      'INVALID_SERVICE_VALUE',
      `${field} must be one of: ${choices.join(', ')}`,
      field,
    );
  }
  return value as T[number];
}

function refuseBrokered(runtimeMode: string): void {
  if (runtimeMode === 'brokered') {
    // C5 v1 cut: the brokered-mode machinery (per-request mint authority)
    // does not ship in v1. The field stays in the contract as the seam;
    // storing 'brokered' before the machinery exists would misdescribe the
    // deployment, so the write surface refuses it explicitly.
    throw err(
      422,
      'BROKERED_MODE_NOT_AVAILABLE',
      "runtime mode 'brokered' is a post-v1 capability (C5 v1 cut): v1 deployments run direct-mode services only",
      'runtimeMode',
    );
  }
}

export interface RegisterServiceInput {
  slug: unknown;
  name: unknown;
  description?: unknown;
  kind?: unknown;
  runtimeMode?: unknown;
  telemetryTier?: unknown;
  /** AZ-S3 (review 87fec3e2 B2): the parentless Account the Connector
   * belongs to. Service Accounts are keyless and cannot authenticate to
   * bootstrap their own first Connector, so a ROOT caller names the owner
   * explicitly; non-root callers may only target themselves (the route
   * enforces that split). Defaults to the acting principal. */
  ownerAccountId?: unknown;
}

export interface UpdateServiceInput {
  name?: unknown;
  description?: unknown;
  status?: unknown;
  telemetryTier?: unknown;
}

export interface OwnerPlaneInput {
  runtimeMode?: unknown;
  visibilityTier?: unknown;
  deliveryMode?: unknown;
  deliveryEndpoint?: unknown;
  /** Subscription-class, owner-plane only; write-only (never read back). */
  deliverySecret?: unknown;
  deliveryPollIntervalSeconds?: unknown;
  /** KNOWLEDGE-DESIGN `94747de9` §4.2 — subscription-class, root only. */
  knowledgeQueryEndpoint?: unknown;
  knowledgeGetEndpoint?: unknown;
  knowledgeCoreCredentialRef?: unknown;
  knowledgeClaimsMode?: unknown;
  knowledgeSubjectMode?: unknown;
  knowledgeRelevantGroups?: unknown;
  knowledgeAllowedNetworks?: unknown;
}

/**
 * The seven §4.2 fields, declared ONCE. The owner-plane route's body-key
 * allowlist and the branch below both read this list, so a field cannot be
 * accepted by the route and ignored by the act, or the reverse.
 */
export const KNOWLEDGE_OWNER_PLANE_FIELDS = [
  'knowledgeQueryEndpoint',
  'knowledgeGetEndpoint',
  'knowledgeCoreCredentialRef',
  'knowledgeClaimsMode',
  'knowledgeSubjectMode',
  'knowledgeRelevantGroups',
  'knowledgeAllowedNetworks',
] as const;

interface Queryable {
  query: (text: string, params?: unknown[]) => Promise<{ rows: any[] }>;
}

/**
 * E-11: every mutating surface takes a dry-run that validates without
 * writing. Implemented as a real transaction that ROLLBACKs at the commit
 * point, so a dry run exercises exactly the checks a live call would —
 * slug uniqueness, revision binding, descriptor validation — and writes
 * nothing.
 */
export interface MutationOptions {
  dryRun?: boolean;
  auditActor?: AuditActor;
  /**
   * A transaction the CALLER owns (card 3f145fa3).
   *
   * `register` writes a connector-kind registry row and its Connector
   * principal together, which is right as far as it goes — but the FIRST
   * CREDENTIAL is a separate act on `routes/services.ts`, and until this
   * existed the two committed separately. A refused credential therefore left
   * a permanent "no credential" Connector holding the GLOBALLY unique slug
   * (migration 076), with no affordance anywhere in the product to clear it or
   * to issue against it, so even the retry the caller was told to make
   * collided with the wreckage of the attempt before it.
   *
   * When this is supplied the caller owns BEGIN, COMMIT, ROLLBACK and the
   * release; `register` does none of them. `PrincipalService.issueCredential`
   * already takes a caller transaction for exactly this reason (AZ-S4), so the
   * pair can now be one act.
   */
  transaction?: PoolClient;
}

const finish = (client: Queryable, dryRun: boolean | undefined) =>
  client.query(dryRun ? 'ROLLBACK' : 'COMMIT');

async function lockService(executor: Queryable, id: string): Promise<any> {
  const result = await executor.query('SELECT * FROM services WHERE id = $1 FOR UPDATE', [id]);
  if (result.rows.length === 0) {
    throw err(404, 'SERVICE_NOT_FOUND', 'Service not found');
  }
  return result.rows[0];
}

function requireRevision(revision: string | undefined, head: any): void {
  if (typeof revision !== 'string' || revision.length === 0) {
    throw err(400, 'REVISION_REQUIRED', 'The last observed revision is required (If-Match)');
  }
  if (revision !== head.revision) {
    throw err(412, 'REVISION_MISMATCH', 'The service changed since it was last read; reload and retry');
  }
}

function refuseRetired(head: any): void {
  if (head.status === 'retired') {
    throw err(409, 'SERVICE_RETIRED', 'This service is retired; retirement is not reversible (§4.4)');
  }
}

export class ServiceRegistry {
  async list(filters: {
    kind?: string;
    status?: string;
    includeRetired?: boolean;
  } = {}): Promise<ServiceRecord[]> {
    const clauses: string[] = [];
    const params: unknown[] = [];
    if (filters.kind !== undefined) {
      clauses.push(`kind = $${params.length + 1}`);
      params.push(validateChoice(filters.kind, SERVICE_KINDS, 'kind'));
    }
    if (filters.status !== undefined) {
      clauses.push(`status = $${params.length + 1}`);
      params.push(validateChoice(filters.status, SERVICE_STATUSES, 'status'));
    } else if (!filters.includeRetired) {
      clauses.push(`status <> 'retired'`);
    }
    const where = clauses.length > 0 ? ` WHERE ${clauses.join(' AND ')}` : '';
    const result = await pool.query(
      `SELECT * FROM services${where} ORDER BY name ASC`,
      params,
    );
    return result.rows.map(mapRow);
  }

  /** Resolve by UUID or slug (the personalities-registry precedent). */
  async getByIdOrSlug(idOrSlug: string): Promise<ServiceRecord> {
    const bySlug = !UUID_PATTERN.test(idOrSlug);
    const result = await pool.query(
      `SELECT * FROM services WHERE ${bySlug ? 'slug' : 'id'} = $1`,
      [idOrSlug],
    );
    if (result.rows.length === 0) {
      throw err(404, 'SERVICE_NOT_FOUND', 'Service not found');
    }
    return mapRow(result.rows[0]);
  }

  async register(
    input: RegisterServiceInput,
    actorPrincipalId: string | null,
    options: MutationOptions = {},
  ): Promise<ServiceRecord> {
    const slug = validateSlug(input.slug);
    const name = validateName(input.name);
    const description = validateDescription(input.description);
    const kind = input.kind === undefined ? 'service' : validateChoice(input.kind, SERVICE_KINDS, 'kind');
    const runtimeMode =
      input.runtimeMode === undefined
        ? 'direct'
        : validateChoice(input.runtimeMode, RUNTIME_MODES, 'runtimeMode');
    refuseBrokered(runtimeMode);
    const telemetryTier =
      input.telemetryTier === undefined
        ? 'none'
        : validateChoice(input.telemetryTier, TELEMETRY_TIERS, 'telemetryTier');

    // A caller transaction and a dry run are mutually exclusive by
    // construction: a dry run's whole mechanism is rolling back at the commit
    // point, and the commit point belongs to the caller here. Refused loudly
    // rather than silently choosing one of the two meanings.
    if (options.transaction && options.dryRun) {
      throw err(500, 'DRY_RUN_IN_CALLER_TRANSACTION',
        'A dry run cannot run inside a caller-owned transaction: the rollback that makes it dry is the caller\'s to issue');
    }
    const client = options.transaction ?? await pool.connect();
    const ownsTransaction = options.transaction === undefined;
    try {
      if (ownsTransaction) await client.query('BEGIN');
      // AZ-S3 (A17.2, 097): a connector-kind registry row and its Connector
      // principal are created together in ONE transaction. The Connector is
      // a delegated identity: its parent is the ACTING parentless Account,
      // its own() expression is the explicit wide default (recorded here
      // and on the audit trail; AZ-S5 refines the creation surface with
      // narrowing input), and its purpose names the registry row.
      let connectorPrincipalId: string | null = null;
      if (kind === 'connector') {
        const ownerAccountId = typeof input.ownerAccountId === 'string' && input.ownerAccountId
          ? input.ownerAccountId
          : actorPrincipalId;
        if (!ownerAccountId) {
          throw err(422, 'CONNECTOR_NEEDS_ACCOUNT', 'Connector registration requires an owning Account principal (A17.2)');
        }
        const actorRow = await client.query(
          'SELECT id, kind, status, parent_principal_id, legacy_identity FROM principals WHERE id = $1',
          [ownerAccountId]);
        const owner = actorRow.rows[0];
        if (!owner || owner.parent_principal_id || owner.kind === 'agent' || owner.status !== 'active' || owner.legacy_identity) {
          throw err(422, 'CONNECTOR_NEEDS_ACCOUNT', 'A Connector parent must be an active, non-legacy, parentless Account (design 4d961e37 §3)');
        }
        // The principals.handle column is VARCHAR(64) (062) while slugs run
        // to 64 chars (review 2fcd548c B4): the derivation keeps the plain
        // 'connector-<slug>' form whenever it fits and otherwise truncates
        // with an md5 suffix — deterministic, collision-safe, and shared
        // verbatim with the 097 backfill.
        const connectorHandle = connectorHandleFor(slug);
        const principalInsert = await client.query(
          `INSERT INTO principals (kind, handle, display_name, status, parent_principal_id, purpose, own_expression)
           VALUES ('service', $1, $2, 'active', $3, $4, $5::jsonb)
           RETURNING id`,
          [connectorHandle, name, owner.id,
           'Connector for service ' + slug,
           JSON.stringify({ scopes: 'parent', objects: 'parent' })],
        );
        connectorPrincipalId = String(principalInsert.rows[0].id);
      }
      const result = await client.query(
        `INSERT INTO services (slug, name, description, kind, runtime_mode, telemetry_tier,
                               principal_id, created_by_principal_id, updated_by_principal_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $8)
         RETURNING *`,
        [slug, name, description, kind, runtimeMode, telemetryTier, connectorPrincipalId, actorPrincipalId],
      );
      if (ownsTransaction) await finish(client, options.dryRun);
      return mapRow(result.rows[0]);
    } catch (e) {
      // The caller's transaction is the caller's to unwind: rolling it back
      // here would silently discard writes it made BEFORE calling us, and the
      // route that owns it rolls back on this same throw.
      if (ownsTransaction) await client.query('ROLLBACK');
      if (e instanceof Error && e.message.includes('duplicate key')) {
        throw err(409, 'SERVICE_SLUG_TAKEN', `A service with slug '${slug}' already exists`, 'slug');
      }
      throw e;
    } finally {
      if (ownsTransaction) client.release();
    }
  }

  async update(
    id: string,
    input: UpdateServiceInput,
    revision: string | undefined,
    actorPrincipalId: string | null,
    options: MutationOptions = {},
  ): Promise<ServiceRecord> {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const head = await lockService(client, id);
      requireRevision(revision, head);
      refuseRetired(head);

      const sets: string[] = [];
      const params: unknown[] = [id];
      const push = (column: string, value: unknown) => {
        params.push(value);
        sets.push(`${column} = $${params.length}`);
      };

      if (input.name !== undefined) push('name', validateName(input.name));
      if (input.description !== undefined) push('description', validateDescription(input.description));
      if (input.telemetryTier !== undefined) {
        push('telemetry_tier', validateChoice(input.telemetryTier, TELEMETRY_TIERS, 'telemetryTier'));
      }
      if (input.status !== undefined) {
        const status = validateChoice(input.status, SERVICE_STATUSES, 'status');
        if (status === 'retired') {
          // Retirement is the admin verb and has its own surface (§4.4, R5).
          throw err(
            422,
            'INVALID_SERVICE_VALUE',
            "status 'retired' is set through the retire surface (services:admin), not a metadata update",
            'status',
          );
        }
        if (status === 'published' && head.current_descriptor_version === null) {
          throw err(
            409,
            'SERVICE_HAS_NO_DESCRIPTOR',
            'A service cannot be published before its first capability-descriptor version',
            'status',
          );
        }
        push('status', status);
      }

      if (sets.length === 0) {
        throw err(400, 'NO_FIELDS_TO_UPDATE', 'No updatable field was supplied');
      }
      push('updated_by_principal_id', actorPrincipalId);

      const result = await client.query(
        `UPDATE services SET ${sets.join(', ')}, revision = gen_random_uuid(), updated_at = NOW()
         WHERE id = $1 RETURNING *`,
        params,
      );
      await finish(client, options.dryRun);
      return mapRow(result.rows[0]);
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
  }

  /**
   * Owner-plane fields (subscription-class, §2.6.4): delivery configuration,
   * visibility tier and runtime mode. The route for this method sits behind
   * the root sentinel; it deliberately shares no surface with update().
   */
  async updateOwnerPlane(
    id: string,
    input: OwnerPlaneInput,
    revision: string | undefined,
    actorPrincipalId: string | null,
    options: MutationOptions = {},
  ): Promise<ServiceRecord> {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const head = await lockService(client, id);
      requireRevision(revision, head);
      refuseRetired(head);

      const sets: string[] = [];
      const params: unknown[] = [id];
      const push = (column: string, value: unknown) => {
        params.push(value);
        sets.push(`${column} = $${params.length}`);
      };

      if (input.runtimeMode !== undefined) {
        const mode = validateChoice(input.runtimeMode, RUNTIME_MODES, 'runtimeMode');
        refuseBrokered(mode);
        push('runtime_mode', mode);
      }
      if (input.visibilityTier !== undefined) {
        push('visibility_tier', validateChoice(input.visibilityTier, VISIBILITY_TIERS, 'visibilityTier'));
      }

      const deliveryTouched =
        input.deliveryMode !== undefined ||
        input.deliveryEndpoint !== undefined ||
        input.deliverySecret !== undefined ||
        input.deliveryPollIntervalSeconds !== undefined;
      if (deliveryTouched) {
        const mode =
          input.deliveryMode !== undefined
            ? validateChoice(input.deliveryMode, DELIVERY_MODES, 'deliveryMode')
            : head.delivery_mode;
        let endpoint =
          input.deliveryEndpoint !== undefined ? input.deliveryEndpoint : head.delivery_endpoint;
        let pollInterval =
          input.deliveryPollIntervalSeconds !== undefined
            ? input.deliveryPollIntervalSeconds
            : head.delivery_poll_interval_seconds;
        let secret =
          input.deliverySecret !== undefined ? input.deliverySecret : head.delivery_secret;

        if (mode === 'webhook') {
          if (typeof endpoint !== 'string' || endpoint.length === 0) {
            throw err(422, 'INVALID_SERVICE_VALUE', "delivery mode 'webhook' requires deliveryEndpoint", 'deliveryEndpoint');
          }
          // Unsigned delivery is not representable (101 CHECK). Refused here
          // with a named field so the operator learns which half is missing
          // rather than reading a constraint name out of a 500.
          if (typeof secret !== 'string' || secret.length === 0) {
            throw err(422, 'INVALID_SERVICE_VALUE', "delivery mode 'webhook' requires deliverySecret — every delivery is HMAC-signed", 'deliverySecret');
          }
          if (secret.length > 200) {
            throw err(422, 'INVALID_SERVICE_VALUE', 'deliverySecret must be at most 200 characters', 'deliverySecret');
          }
          let parsed: URL;
          try {
            parsed = new URL(endpoint);
          } catch {
            throw err(422, 'INVALID_SERVICE_VALUE', 'deliveryEndpoint must be a valid absolute http(s) URL', 'deliveryEndpoint');
          }
          if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
            throw err(422, 'INVALID_SERVICE_VALUE', 'deliveryEndpoint scheme must be http or https', 'deliveryEndpoint');
          }
          pollInterval = null;
        } else if (mode === 'poll') {
          if (
            typeof pollInterval !== 'number' ||
            !Number.isInteger(pollInterval) ||
            pollInterval < MIN_POLL_INTERVAL_SECONDS
          ) {
            throw err(
              422,
              'INVALID_SERVICE_VALUE',
              `delivery mode 'poll' requires an integer deliveryPollIntervalSeconds >= ${MIN_POLL_INTERVAL_SECONDS}`,
              'deliveryPollIntervalSeconds',
            );
          }
          endpoint = null;
          secret = null;
        } else {
          endpoint = null;
          pollInterval = null;
          secret = null;
        }
        push('delivery_mode', mode);
        push('delivery_endpoint', endpoint);
        push('delivery_secret', secret);
        push('delivery_poll_interval_seconds', pollInterval);
      }

      // ── KNOWLEDGE-DESIGN `94747de9` §4.2, the knowledge source plane ──
      //
      // Evaluated as ONE act over the EFFECTIVE row (the supplied value,
      // else the stored one) rather than field by field, because every rule
      // §4.2 states is a rule about a COMBINATION: an endpoint needs a
      // credential reference, a get endpoint needs a query endpoint, and an
      // endpoint needs a descriptor block with a non-empty compartment list.
      // Validating each field alone would admit a PATCH that clears the
      // credential reference and leaves the endpoint standing — precisely
      // the half-configured state §4.2 says cannot exist.
      const knowledgeTouched = KNOWLEDGE_OWNER_PLANE_FIELDS.some(
        (field) => (input as Record<string, unknown>)[field] !== undefined,
      );
      if (knowledgeTouched) {
        try {
          const allowedNetworks = input.knowledgeAllowedNetworks !== undefined
            ? validateAllowedNetworks(input.knowledgeAllowedNetworks, 'knowledgeAllowedNetworks')
            : ((head.knowledge_allowed_networks ?? []) as string[]);

          const queryEndpoint = input.knowledgeQueryEndpoint === undefined
            ? ((head.knowledge_query_endpoint ?? null) as string | null)
            : input.knowledgeQueryEndpoint === null
              ? null
              : validateKnowledgeEndpoint(input.knowledgeQueryEndpoint, 'knowledgeQueryEndpoint', allowedNetworks);
          const getEndpoint = input.knowledgeGetEndpoint === undefined
            ? ((head.knowledge_get_endpoint ?? null) as string | null)
            : input.knowledgeGetEndpoint === null
              ? null
              : validateKnowledgeEndpoint(input.knowledgeGetEndpoint, 'knowledgeGetEndpoint', allowedNetworks);
          const credentialRef = input.knowledgeCoreCredentialRef === undefined
            ? ((head.knowledge_core_credential_ref ?? null) as string | null)
            : input.knowledgeCoreCredentialRef === null
              ? null
              : validateCoreCredentialRef(input.knowledgeCoreCredentialRef, 'knowledgeCoreCredentialRef');
          const claimsMode = input.knowledgeClaimsMode === undefined
            ? ((head.knowledge_claims_mode ?? 'asserted') as KnowledgeClaimsMode)
            : validateClaimsMode(input.knowledgeClaimsMode, 'knowledgeClaimsMode');
          const subjectMode = input.knowledgeSubjectMode === undefined
            ? ((head.knowledge_subject_mode ?? 'pairwise') as KnowledgeSubjectMode)
            : validateSubjectMode(input.knowledgeSubjectMode, 'knowledgeSubjectMode');
          const relevantGroups = input.knowledgeRelevantGroups !== undefined
            ? validateRelevantGroups(input.knowledgeRelevantGroups, 'knowledgeRelevantGroups')
            : ((head.knowledge_relevant_groups ?? []) as string[]);

          // §4.2, sol R1-2: "REQUIRED for every external source in BOTH
          // claims modes ... a source with no core-credential arrangement
          // cannot be registered at all". The claims mode is deliberately
          // NOT consulted: what `claims_mode='none'` omits is the
          // ASSERTION, never the channel authentication this reference is.
          if (queryEndpoint !== null && credentialRef === null) {
            throw err(
              422,
              'KNOWLEDGE_CREDENTIAL_REQUIRED',
              'a knowledge source requires knowledgeCoreCredentialRef in BOTH claims modes — every dial authenticates core to the source before anything is read (design 94747de9 §4.2)',
              'knowledgeCoreCredentialRef',
            );
          }
          if (getEndpoint !== null && queryEndpoint === null) {
            throw err(
              422,
              'KNOWLEDGE_ENDPOINT_INCOMPLETE',
              'knowledgeGetEndpoint requires knowledgeQueryEndpoint — the get endpoint defaults to the query endpoint (design 94747de9 §4.2)',
              'knowledgeGetEndpoint',
            );
          }

          // §4.2, sol R1-1/R1-3: the owner-plane act REFUSES an endpoint set
          // against a descriptor with no block or an empty compartment list.
          // Read inside THIS transaction, under the row lock taken above, so
          // a concurrent descriptor publish cannot slip between check and
          // write.
          if (queryEndpoint !== null) {
            const descriptorRows = head.current_descriptor_version === null
              ? { rows: [] as Array<{ descriptor: ServiceDescriptor }> }
              : await client.query(
                'SELECT descriptor FROM service_descriptor_versions WHERE service_id = $1 AND version = $2',
                [id, head.current_descriptor_version],
              );
            const block = descriptorRows.rows[0]?.descriptor?.knowledgeSource ?? null;
            // The ONE capability predicate (KnowledgeSourcePolicy). The act
            // refuses exactly the states the predicate would refuse, so the
            // row can never hold a configuration the reader will not honour.
            if (!isKnowledgeCapable({ slug: head.slug, knowledgeQueryEndpoint: queryEndpoint }, block)) {
              throw err(
                422,
                'KNOWLEDGE_DESCRIPTOR_BLOCK_REQUIRED',
                'setting a knowledge endpoint requires the current descriptor to carry a knowledgeSource block with a NON-EMPTY compartment list (design 94747de9 §4.2; sol R1-1/R1-3)',
                'knowledgeQueryEndpoint',
              );
            }
          }

          push('knowledge_query_endpoint', queryEndpoint);
          push('knowledge_get_endpoint', getEndpoint);
          push('knowledge_core_credential_ref', credentialRef);
          push('knowledge_claims_mode', claimsMode);
          push('knowledge_subject_mode', subjectMode);
          push('knowledge_relevant_groups', relevantGroups);
          push('knowledge_allowed_networks', allowedNetworks);
        } catch (policyError) {
          // The policy module is deliberately free of registry imports (it
          // is shared with the dial client), so its refusals arrive as
          // KnowledgePolicyError and are re-raised in the registry's own
          // error class — otherwise a NAMED 422 would reach the caller as
          // an opaque 500 and the operator would learn nothing.
          if (policyError instanceof KnowledgePolicyError) {
            throw err(422, policyError.code, policyError.message, policyError.field);
          }
          throw policyError;
        }
      }

      if (sets.length === 0) {
        throw err(400, 'NO_FIELDS_TO_UPDATE', 'No owner-plane field was supplied');
      }
      push('updated_by_principal_id', actorPrincipalId);

      const result = await client.query(
        `UPDATE services SET ${sets.join(', ')}, revision = gen_random_uuid(), updated_at = NOW()
         WHERE id = $1 RETURNING *`,
        params,
      );
      if (!options.dryRun) {
        await auditService.record({
          action: 'subscription.configuration.update',
          actor: options.auditActor ?? {
            principalId: actorPrincipalId,
            handle: actorPrincipalId ?? 'system',
            authMethod: actorPrincipalId ? 'unknown' : 'system',
          },
          resourceType: 'service',
          resourceId: id,
          metadata: {
            changedFields: Object.keys(input),
            deliveryEndpointChanged: input.deliveryEndpoint !== undefined,
            // The VALUE never enters the audit record — only the fact of a
            // change, exactly as the subscription plane audits secrets.
            deliverySecretChanged: input.deliverySecret !== undefined,
          },
        }, client);
      }
      await finish(client, options.dryRun);
      return mapRow(result.rows[0]);
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
  }

  /**
   * Publish a new immutable descriptor version: validate, append, bump the
   * head pointer — one transaction. Identical content (canonical-JSON hash)
   * is refused explicitly rather than silently bumping a version.
   */
  async publishDescriptor(
    id: string,
    rawDescriptor: unknown,
    revision: string | undefined,
    actorPrincipalId: string | null,
    options: MutationOptions = {},
  ): Promise<{ service: ServiceRecord; descriptorVersion: DescriptorVersion }> {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const head = await lockService(client, id);
      requireRevision(revision, head);
      refuseRetired(head);

      const descriptor = validateDescriptor(rawDescriptor);

      // §4.2's "no half-configured state can exist", the OTHER direction.
      // The owner-plane act refuses an endpoint without a block; without
      // this, an agent-plane `services:write` publish could DROP the block
      // from under a configured endpoint and reach the same forbidden state
      // from the other side. §4.3 binds the block to routing only — "never
      // where anything is sent" — and this is what makes that true: a
      // descriptor publish cannot silently decommission a configured source,
      // it can only narrow or widen which queries route to it.
      if (head.knowledge_query_endpoint && !isKnowledgeCapable(
        { slug: head.slug, knowledgeQueryEndpoint: head.knowledge_query_endpoint },
        descriptor.knowledgeSource ?? null,
      )) {
        throw err(
          422,
          'KNOWLEDGE_DESCRIPTOR_BLOCK_REQUIRED',
          'this Service has a knowledge endpoint configured on the owner plane, so its descriptor must keep a knowledgeSource block with a NON-EMPTY compartment list — clear the endpoint on the owner plane first (design 94747de9 §4.2)',
          'descriptor.knowledgeSource',
        );
      }

      const hash = sha256Hex(canonicalJson(descriptor));

      if (head.current_descriptor_version !== null) {
        const current = await client.query(
          'SELECT content_hash FROM service_descriptor_versions WHERE service_id = $1 AND version = $2',
          [id, head.current_descriptor_version],
        );
        if (current.rows.length > 0 && current.rows[0].content_hash === hash) {
          throw err(
            409,
            'DESCRIPTOR_UNCHANGED',
            'This descriptor is byte-identical to the current version; publishing it would bump the version without changing the contract',
          );
        }
      }

      const nextResult = await client.query(
        'SELECT COALESCE(MAX(version), 0) + 1 AS next FROM service_descriptor_versions WHERE service_id = $1',
        [id],
      );
      const nextVersion = Number(nextResult.rows[0].next);

      await lifecyclePolicyService.evaluate(client, {
        action: 'service-descriptor.publish',
        subject: { kind: 'service-descriptor', id: `${id}:${nextVersion}`, revision: head.revision },
        current: { serviceId: id, version: head.current_descriptor_version },
        proposed: { serviceId: id, version: nextVersion },
      });

      const inserted = await client.query(
        `INSERT INTO service_descriptor_versions (service_id, version, descriptor, content_hash, created_by_principal_id)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING *`,
        [id, nextVersion, JSON.stringify(descriptor), hash, actorPrincipalId],
      );
      const updated = await client.query(
        `UPDATE services
         SET current_descriptor_version = $2, revision = gen_random_uuid(),
             updated_by_principal_id = $3, updated_at = NOW()
         WHERE id = $1 RETURNING *`,
        [id, nextVersion, actorPrincipalId],
      );
      await finish(client, options.dryRun);
      const row = inserted.rows[0];
      return {
        service: mapRow(updated.rows[0]),
        descriptorVersion: { ...mapVersionMeta(row), descriptor },
      };
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
  }

  /** The current descriptor (head pointer), if any. */
  async getCurrentDescriptor(id: string): Promise<DescriptorVersion> {
    const service = await this.getByIdOrSlug(id);
    if (service.currentDescriptorVersion === null) {
      throw err(404, 'DESCRIPTOR_NOT_FOUND', 'This service has no capability descriptor yet');
    }
    return this.getDescriptorVersion(service.id, service.currentDescriptorVersion);
  }

  async listDescriptorVersions(id: string): Promise<DescriptorVersionMeta[]> {
    const service = await this.getByIdOrSlug(id);
    const result = await pool.query(
      `SELECT version, content_hash, created_by_principal_id, created_at, retired_at
       FROM service_descriptor_versions
       WHERE service_id = $1
       ORDER BY version DESC`,
      [service.id],
    );
    return result.rows.map(mapVersionMeta);
  }

  async getDescriptorVersion(id: string, version: number): Promise<DescriptorVersion> {
    if (!Number.isInteger(version) || version < 1) {
      throw err(400, 'INVALID_QUERY_VALUE', 'version must be a positive integer', 'version');
    }
    const service = await this.getByIdOrSlug(id);
    const result = await pool.query(
      `SELECT version, descriptor, content_hash, created_by_principal_id, created_at, retired_at
       FROM service_descriptor_versions
       WHERE service_id = $1 AND version = $2`,
      [service.id, version],
    );
    if (result.rows.length === 0) {
      throw err(404, 'DESCRIPTOR_VERSION_NOT_FOUND', 'No such descriptor version');
    }
    const row = result.rows[0];
    return { ...mapVersionMeta(row), descriptor: row.descriptor };
  }

  /** Retire a whole service (services:admin). Irreversible (§4.4). */
  async retireService(
    id: string,
    revision: string | undefined,
    actorPrincipalId: string | null,
    options: MutationOptions = {},
  ): Promise<ServiceRecord> {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const head = await lockService(client, id);
      requireRevision(revision, head);
      refuseRetired(head);
      await lifecyclePolicyService.evaluate(client, {
        action: 'service.retire',
        subject: { kind: 'service', id, revision: head.revision },
        current: { status: head.status },
        proposed: { status: 'retired' },
      });
      const result = await client.query(
        `UPDATE services
         SET status = 'retired', retired_at = NOW(), revision = gen_random_uuid(),
             updated_by_principal_id = $2, updated_at = NOW()
         WHERE id = $1 RETURNING *`,
        [id, actorPrincipalId],
      );
      // AZ-S3 (A17.2): retiring a connector-kind row suspends its Connector
      // principal and revokes its credentials in the SAME transaction.
      // (Cache invalidation after commit — B5.)
      if (result.rows[0]?.kind === 'connector' && result.rows[0]?.principal_id) {
        await client.query(
          `UPDATE principals SET status = 'disabled' WHERE id = $1 AND status = 'active'`,
          [result.rows[0].principal_id]);
        await client.query(
          `UPDATE principal_credentials
              SET revoked_at = COALESCE(revoked_at, NOW()),
                  metadata = jsonb_set(metadata, '{revoke_reason}', to_jsonb('connector retired (A17.2)'::text))
            WHERE principal_id = $1 AND revoked_at IS NULL`,
          [result.rows[0].principal_id]);
        principalService.invalidatePrincipals([String(result.rows[0].principal_id)]);
      }
      await finish(client, options.dryRun);
      return mapRow(result.rows[0]);
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
  }

  /**
   * Retire one descriptor version (services:admin; R5 staged retirement).
   * Existing pins keep resolving; the profile paths refuse retired pins.
   */
  async retireDescriptorVersion(
    id: string,
    version: number,
    actorPrincipalId: string | null,
    options: MutationOptions = {},
  ): Promise<DescriptorVersionMeta> {
    if (!Number.isInteger(version) || version < 1) {
      throw err(400, 'INVALID_QUERY_VALUE', 'version must be a positive integer', 'version');
    }
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await lockService(client, id);
      const existing = await client.query(
        'SELECT * FROM service_descriptor_versions WHERE service_id = $1 AND version = $2 FOR UPDATE',
        [id, version],
      );
      if (existing.rows.length === 0) {
        throw err(404, 'DESCRIPTOR_VERSION_NOT_FOUND', 'No such descriptor version');
      }
      if (existing.rows[0].retired_at !== null) {
        throw err(409, 'DESCRIPTOR_VERSION_RETIRED', 'This descriptor version is already retired');
      }
      await lifecyclePolicyService.evaluate(client, {
        action: 'service-descriptor.retire',
        subject: { kind: 'service-descriptor', id: `${id}:${version}` },
        current: { serviceId: id, version, retired: false },
        proposed: { serviceId: id, version, retired: true },
      });
      const result = await client.query(
        `UPDATE service_descriptor_versions SET retired_at = NOW()
         WHERE service_id = $1 AND version = $2 RETURNING *`,
        [id, version],
      );
      await client.query(
        `UPDATE services SET revision = gen_random_uuid(), updated_by_principal_id = $2, updated_at = NOW()
         WHERE id = $1`,
        [id, actorPrincipalId],
      );
      await finish(client, options.dryRun);
      return mapVersionMeta(result.rows[0]);
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
  }

  /** Hard removal — the admin verb, never the routine path (§4.4). */
  async delete(id: string, options: MutationOptions = {}): Promise<void> {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const current = await lockService(client, id);
      await lifecyclePolicyService.evaluate(client, {
        action: 'service.delete',
        subject: { kind: 'service', id, revision: current.revision },
        current: { status: current.status },
        proposed: null,
      });
      const result = await client.query('DELETE FROM services WHERE id = $1 RETURNING id, kind, principal_id', [id]);
      if (result.rows.length === 0) {
        throw err(404, 'SERVICE_NOT_FOUND', 'Service not found');
      }
      // AZ-S3 (A17.2): hard removal terminates the Connector principal (the
      // durable A17.10 status — provenance kept) and revokes its
      // credentials in the SAME transaction.
      if (result.rows[0].kind === 'connector' && result.rows[0].principal_id) {
        // A17.10 (review 2fcd548c B6): termination is a SUBTREE act — the
        // Connector's descendant Agents get the durable terminated status
        // and every descendant credential is permanently revoked, in this
        // same transaction.
        await client.query(
          `WITH RECURSIVE subtree AS (
             SELECT id FROM principals WHERE id = $1
             UNION ALL
             SELECT p.id FROM principals p JOIN subtree s ON p.parent_principal_id = s.id
           )
           UPDATE principals SET status = 'terminated', terminated_at = COALESCE(terminated_at, NOW())
            WHERE id IN (SELECT id FROM subtree) AND status <> 'terminated'`,
          [result.rows[0].principal_id]);
        await client.query(
          `WITH RECURSIVE subtree AS (
             SELECT id FROM principals WHERE id = $1
             UNION ALL
             SELECT p.id FROM principals p JOIN subtree s ON p.parent_principal_id = s.id
           )
           UPDATE principal_credentials
              SET revoked_at = COALESCE(revoked_at, NOW()),
                  metadata = jsonb_set(metadata, '{revoke_reason}', to_jsonb('connector deleted (A17.2/A17.10)'::text))
            WHERE principal_id IN (SELECT id FROM subtree) AND revoked_at IS NULL`,
          [result.rows[0].principal_id]);
        const subtreeIds = await client.query(
          `WITH RECURSIVE subtree AS (
             SELECT id FROM principals WHERE id = $1
             UNION ALL
             SELECT p.id FROM principals p JOIN subtree s ON p.parent_principal_id = s.id
           ) SELECT id FROM subtree`,
          [result.rows[0].principal_id]);
        principalService.invalidatePrincipals(subtreeIds.rows.map((r: any) => String(r.id)));
      }
      await finish(client, options.dryRun);
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
  }
}

/** B4 (review 2fcd548c): the ONE connector-handle derivation, shared with
 * migration 097 — plain when it fits VARCHAR(64), truncate+md5 otherwise. */
export function connectorHandleFor(slug: string): string {
  const plain = 'connector-' + slug;
  if (plain.length <= 64) return plain;
  const digest = crypto.createHash('md5').update(slug).digest('hex').slice(0, 8);
  return 'connector-' + slug.slice(0, 45) + '-' + digest;
}

export const serviceRegistry = new ServiceRegistry();
