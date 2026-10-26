/**
 * KnowledgeSourceRegistration.ts — two-way registration of a knowledge source,
 * the CORE half (card 08792425, member N6; the default-store design's choice C7,
 * "two-way registration, no new credential type").
 *
 * ── THE ACT ──
 *
 *  1. An installer prints a REGISTRATION BUNDLE: the endpoint, a descriptor
 *     carrying a protocol_version 2 knowledgeSource block, and the sha256
 *     fingerprint of the endpoint's TLS certificate.
 *  2. An administrator, signed in, uploads it on the Services page, confirms the
 *     fingerprint against the installer's console, and spends a single-use
 *     step-up bound to (`knowledge.source.register`, that fingerprint). The core
 *     then, in ONE transaction: creates the Service, publishes the descriptor,
 *     publishes the Service, records the endpoints, the allowed networks for a
 *     private endpoint and the credential reference NAME on the owner plane,
 *     records the confirmed fingerprint, and writes one audit row.
 *  3. The page offers a RETURN BUNDLE: the Service id (the audience), the
 *     issuer, the core's assertion public keys and the lifecycle public key.
 *     Public material only, never a secret.
 *  4. The operator places the channel bearer in the core's environment under
 *     the reference name and restarts the core. Until then every dial of this
 *     source is refused `unavailable:transport`, exactly as today, and the page
 *     says so.
 *
 * ── THE REFERENCE NAME MUST BE FREE ──
 *
 * Step 4 is the operator placing THIS source's bearer. A fresh registration
 * cannot have had it yet, so a derived reference name that is already in use
 * would hand this new endpoint a bearer placed for something else. The act
 * refuses REGISTRATION_CREDENTIAL_REFERENCE_TAKEN, by name and before anything
 * is written or the step-up is spent, when the derived name (from the slug the
 * administrator gave, or from the bundle's name) collides, after
 * `credentialReferenceKey` folds case, Unicode compatibility forms, marks,
 * invisible characters, whitespace and separators, with:
 *   (a) a reference that RESOLVES now in RELAYHALL_KNOWLEDGE_SOURCE_CREDENTIALS
 *       (reason `resolves`, checked on the exact name);
 *   (b) any ENTRY name in that variable, resolving or not (reason
 *       `environment-entry`);
 *   (c) the `knowledge_core_credential_ref` of ANY Service row, draft,
 *       published or retired (reason `service-reference`). A hard-deleted
 *       Service leaves no row; its old entry, if still in the environment, is
 *       caught by (a) or (b).
 *
 * ── WHAT THIS DOES NOT DO ──
 *
 * It adds no trust. The core dials a knowledge source only through Node's
 * default trust store (owner decision D7(a); KnowledgeDialClient leaves `ca`
 * undefined outside the test-only seam). The fingerprint is an upload-time
 * check by a person and is NEVER read at dial time: nothing here is consulted by
 * the dial path. No new credential type, no new authority path: the grants the
 * source needs are filed and decided through the existing change-request flow
 * on /approvals, and the channel credential is the existing reference-name
 * mechanism of `KnowledgeChannelAuth`.
 */
import crypto from 'crypto';
import type { PoolClient } from 'pg';
import { pool } from '../db/connection';
import { serviceRegistry, ServiceRegistryError, type ServiceRecord } from './ServiceRegistry';
import { validateDescriptor, DescriptorError, type ServiceDescriptor } from '../utils/serviceDescriptor';
import {
  KnowledgePolicyError, validateAllowedNetworks, validateCoreCredentialRef, validateKnowledgeEndpoint,
} from './KnowledgeSourcePolicy';
import { stepUpRequiredError, stepUpService } from './StepUpService';
import { auditService, type AuditActor } from './AuditService';
import { KNOWLEDGE_CHANNEL_CREDENTIALS_ENV, resolveChannelCredential } from './KnowledgeChannelAuth';
import { knowledgeAssertionJwks, knowledgeAssertionKeysetConfigured } from './KnowledgeAssertionSigner';
import { lifecyclePublicKeyFor, lifecycleSelectionFor } from './KnowledgeLifecycleExporter';

export const REGISTRATION_BUNDLE_SCHEMA = 'rh.knowledge-source.registration/1';
export const RETURN_BUNDLE_SCHEMA = 'rh.knowledge-source.return/1';
export const REGISTRATION_STATE_SCHEMA = 'rh.knowledge-source.registration-state/1';
/** The step-up action; its target is the bundle's certificate fingerprint. */
export const KNOWLEDGE_SOURCE_REGISTER_STEP_UP_ACTION = 'knowledge.source.register';
/** The audit action of the act, success or denied. */
export const KNOWLEDGE_SOURCE_REGISTER_AUDIT_ACTION = 'knowledge.source.register';
/** A refusal before a Service exists is audited against the bundle's fingerprint. */
export const KNOWLEDGE_SOURCE_REGISTRATION_RESOURCE_TYPE = 'knowledge_source_registration';
/** The prefix of the reference name the core proposes for the channel bearer. */
export const CREDENTIAL_REFERENCE_PREFIX = 'knowledge-source/';
/** The serialized bundle bound: the descriptor's own bound plus room for the envelope. */
export const REGISTRATION_BUNDLE_MAX_BYTES = 300 * 1024;

const BUNDLE_FIELDS = ['schema', 'name', 'slug', 'description', 'endpoint', 'getEndpoint', 'writeEndpoint', 'descriptor', 'certificateSha256'];
export const REGISTRATION_REQUEST_FIELDS = ['bundle', 'confirmedFingerprint', 'confirmation', 'allowedNetworks', 'slug', 'stepUpToken'];
const CONFIRMATIONS = ['checked', 'typed'] as const;
export type FingerprintConfirmation = (typeof CONFIRMATIONS)[number];

/** The members a public JWK may carry in a return bundle; anything else is dropped. */
export const RETURN_BUNDLE_JWK_MEMBERS = ['kty', 'crv', 'x', 'kid', 'alg', 'use'] as const;

export class KnowledgeSourceRegistrationError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly field?: string,
    /** Extra named members of the refusal body (e.g. the `reason` of a taken reference). */
    public readonly details?: Record<string, string>,
  ) {
    super(message);
    this.name = 'KnowledgeSourceRegistrationError';
  }
}

function refuse(status: number, code: string, message: string, field?: string): never {
  throw new KnowledgeSourceRegistrationError(status, code, message, field);
}

/** A parsed, validated registration bundle. */
export interface RegistrationBundle {
  name: string;
  slug: string;
  description: string;
  endpoint: string;
  getEndpoint: string | null;
  writeEndpoint: string | null;
  descriptor: ServiceDescriptor;
  certificateSha256: string;
  bundleSha256: string;
}

/**
 * A certificate fingerprint as an installer may print it: 64 hex digits, upper
 * or lower case, optionally in colon-separated pairs, optionally prefixed
 * `sha256:` or `SHA256 Fingerprint=`. Normalized to 64 lower-case hex digits,
 * or null when it is not one.
 */
export function normalizeFingerprint(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > 200) return null;
  let text = value.trim();
  text = text.replace(/^sha256\s*(fingerprint)?\s*[:=]\s*/i, '');
  const compact = /^[0-9a-fA-F]{2}(:[0-9a-fA-F]{2}){31}$/.test(text) ? text.replace(/:/g, '') : text;
  return /^[0-9a-fA-F]{64}$/.test(compact) ? compact.toLowerCase() : null;
}

/** The fingerprint as a person compares it: upper-case colon-separated pairs. */
export function displayFingerprint(sha256: string): string {
  return (sha256.toUpperCase().match(/.{2}/g) ?? []).join(':');
}

/** A slug the Service registry accepts, derived from the bundle's name when it names none. */
export function slugFrom(name: string): string {
  const slug = name.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 64)
    .replace(/-+$/g, '');
  return slug.length > 0 ? slug : 'knowledge-source';
}

/** The reference NAME the core records for the channel bearer. A name, never a value. */
export function credentialReferenceFor(slug: string): string {
  return `${CREDENTIAL_REFERENCE_PREFIX}${slug}`;
}

/**
 * The form two reference names are compared in: two names with the same key
 * are one name to a person reading the environment. It folds Unicode
 * compatibility forms (NFKD), drops combining marks and invisible format
 * characters, lower-cases, and reads every run of whitespace, '.', '_', ':' and
 * '-' as one separator and every run of '/' as one '/', trimmed at each '/'.
 */
export function credentialReferenceKey(reference: string): string {
  return reference.normalize('NFKD').replace(/[\p{M}\p{Cf}]/gu, '').toLowerCase()
    .replace(/[\s._:\-]+/gu, '-').replace(/\/+/g, '/')
    .split('/').map((segment) => segment.replace(/^-+|-+$/g, '')).join('/')
    .replace(/^\/+|\/+$/g, '');
}

/** Why a derived reference name is not free (the `reason` of REGISTRATION_CREDENTIAL_REFERENCE_TAKEN). */
export type CredentialReferenceTakenReason = 'resolves' | 'environment-entry' | 'service-reference';
export const CREDENTIAL_REFERENCE_TAKEN = 'REGISTRATION_CREDENTIAL_REFERENCE_TAKEN';

/** The entry NAMES of the channel-credential variable; never a value. Empty when it is absent or not a JSON object. */
function channelCredentialEntryNames(env: NodeJS.ProcessEnv = process.env): string[] {
  const raw = env[KNOWLEDGE_CHANNEL_CREDENTIALS_ENV];
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? Object.keys(parsed as object) : [];
  } catch {
    return [];
  }
}

function referenceTaken(reason: CredentialReferenceTakenReason, reference: string, detail: string): never {
  throw new KnowledgeSourceRegistrationError(409, CREDENTIAL_REFERENCE_TAKEN,
    `The channel credential reference '${reference}' this registration would record is already in use: ${detail}. `
    + 'A new source must get a name nobody has placed a bearer under yet: register it with another slug.',
    'slug', { reason });
}

/**
 * Refuse a derived reference name that is not free (see the header). Runs
 * inside the act's transaction, under its lock, before the step-up is spent
 * and before anything is written. Names only, never a value.
 */
export async function assertCredentialReferenceFree(queryable: Queryable, reference: string): Promise<void> {
  const key = credentialReferenceKey(reference);
  // (a) the exact name resolves now: a bearer is already placed under it.
  if (resolveChannelCredential(reference) !== null) {
    referenceTaken('resolves', reference, `${KNOWLEDGE_CHANNEL_CREDENTIALS_ENV} already holds a channel credential under this name`);
  }
  // (b) any entry, resolving or not, whose name is this name to a person.
  const entry = channelCredentialEntryNames().find((name) => credentialReferenceKey(name) === key);
  if (entry !== undefined) {
    referenceTaken('environment-entry', reference, `${KNOWLEDGE_CHANNEL_CREDENTIALS_ENV} already has an entry named '${entry}'`);
  }
  // (c) any Service row, retired included, that records this name.
  const recorded = await queryable.query(
    `SELECT id, status, knowledge_core_credential_ref AS ref FROM services
      WHERE knowledge_core_credential_ref IS NOT NULL ORDER BY created_at, id`);
  const holder = recorded.rows.find((row) => credentialReferenceKey(String(row.ref)) === key);
  if (holder) {
    referenceTaken('service-reference', reference,
      `Service ${holder.id} (${holder.status}) records the reference '${holder.ref}'`);
  }
}

function policy<T>(work: () => T): T {
  try {
    return work();
  } catch (e) {
    if (e instanceof KnowledgePolicyError) refuse(422, e.code, e.message, `bundle.${e.field}`);
    throw e;
  }
}

/**
 * Parse and validate an uploaded bundle. Every refusal is NAMED and points at
 * the field: REGISTRATION_BUNDLE_INVALID, REGISTRATION_BUNDLE_SCHEMA_UNSUPPORTED,
 * REGISTRATION_BUNDLE_TOO_LARGE, REGISTRATION_DESCRIPTOR_NOT_V2,
 * REGISTRATION_FINGERPRINT_INVALID, the descriptor's own DESCRIPTOR_* codes and
 * the outbound policy's own endpoint codes.
 */
export function parseRegistrationBundle(raw: unknown, allowedNetworks: readonly string[]): RegistrationBundle {
  let value = raw;
  if (typeof value === 'string') {
    if (Buffer.byteLength(value, 'utf8') > REGISTRATION_BUNDLE_MAX_BYTES) {
      refuse(413, 'REGISTRATION_BUNDLE_TOO_LARGE', `The bundle exceeds ${REGISTRATION_BUNDLE_MAX_BYTES} bytes`, 'bundle');
    }
    try {
      value = JSON.parse(value);
    } catch {
      refuse(422, 'REGISTRATION_BUNDLE_INVALID', 'The bundle is not valid JSON', 'bundle');
    }
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    refuse(422, 'REGISTRATION_BUNDLE_INVALID', 'The bundle must be a JSON object', 'bundle');
  }
  const bundle = value as Record<string, unknown>;
  const canonical = JSON.stringify(bundle);
  if (Buffer.byteLength(canonical, 'utf8') > REGISTRATION_BUNDLE_MAX_BYTES) {
    refuse(413, 'REGISTRATION_BUNDLE_TOO_LARGE', `The bundle exceeds ${REGISTRATION_BUNDLE_MAX_BYTES} bytes`, 'bundle');
  }
  const unknown = Object.keys(bundle).filter((key) => !BUNDLE_FIELDS.includes(key)).sort();
  if (unknown.length > 0) {
    refuse(422, 'REGISTRATION_BUNDLE_INVALID', `Unknown bundle fields: ${unknown.join(', ')}`, `bundle.${unknown[0]}`);
  }
  if (bundle.schema !== REGISTRATION_BUNDLE_SCHEMA) {
    refuse(422, 'REGISTRATION_BUNDLE_SCHEMA_UNSUPPORTED', `The bundle schema must be '${REGISTRATION_BUNDLE_SCHEMA}'`, 'bundle.schema');
  }
  if (typeof bundle.name !== 'string' || bundle.name.trim().length === 0 || bundle.name.length > 128) {
    refuse(422, 'REGISTRATION_BUNDLE_INVALID', 'The bundle name must be a non-empty string of at most 128 characters', 'bundle.name');
  }
  const name = (bundle.name as string).trim();
  if (bundle.description !== undefined && (typeof bundle.description !== 'string' || bundle.description.length > 4096)) {
    refuse(422, 'REGISTRATION_BUNDLE_INVALID', 'The bundle description must be a string of at most 4096 characters', 'bundle.description');
  }
  if (bundle.slug !== undefined && typeof bundle.slug !== 'string') {
    refuse(422, 'REGISTRATION_BUNDLE_INVALID', 'The bundle slug must be a string', 'bundle.slug');
  }
  const certificateSha256 = normalizeFingerprint(bundle.certificateSha256);
  if (!certificateSha256) {
    refuse(422, 'REGISTRATION_FINGERPRINT_INVALID',
      'certificateSha256 must be the sha256 fingerprint of the endpoint certificate: 64 hex digits, optionally in colon-separated pairs',
      'bundle.certificateSha256');
  }
  const endpoint = policy(() => validateKnowledgeEndpoint(bundle.endpoint, 'endpoint', allowedNetworks));
  const getEndpoint = bundle.getEndpoint === undefined || bundle.getEndpoint === null
    ? null : policy(() => validateKnowledgeEndpoint(bundle.getEndpoint, 'getEndpoint', allowedNetworks));
  const writeEndpoint = bundle.writeEndpoint === undefined || bundle.writeEndpoint === null
    ? null : policy(() => validateKnowledgeEndpoint(bundle.writeEndpoint, 'writeEndpoint', allowedNetworks));
  let descriptor: ServiceDescriptor;
  try {
    descriptor = validateDescriptor(bundle.descriptor);
  } catch (e) {
    if (e instanceof DescriptorError) refuse(422, e.code, e.message, `bundle.${e.field}`);
    throw e;
  }
  // Descriptor v2 (§9.2 step 1): the dynamic-opaque knowledge block the
  // default store serves. A v1 static block is registered by hand on the owner
  // plane, as today; this act is for v2 sources only.
  if (descriptor!.knowledgeSource?.protocol_version !== 2) {
    refuse(422, 'REGISTRATION_DESCRIPTOR_NOT_V2',
      'The bundle descriptor must carry a knowledgeSource block with protocol_version 2', 'bundle.descriptor.knowledgeSource');
  }
  return {
    name,
    slug: typeof bundle.slug === 'string' && bundle.slug.length > 0 ? bundle.slug : slugFrom(name),
    description: typeof bundle.description === 'string' ? bundle.description : '',
    endpoint,
    getEndpoint,
    writeEndpoint,
    descriptor: descriptor!,
    certificateSha256: certificateSha256!,
    bundleSha256: crypto.createHash('sha256').update(canonical).digest('hex'),
  };
}

/** The confirmation the administrator gave, checked against the bundle. */
export function checkFingerprintConfirmation(bundle: RegistrationBundle, confirmed: unknown, method: unknown): FingerprintConfirmation {
  if (!(CONFIRMATIONS as readonly unknown[]).includes(method)) {
    refuse(422, 'REGISTRATION_CONFIRMATION_INVALID', "confirmation must be 'checked' or 'typed'", 'confirmation');
  }
  if (normalizeFingerprint(confirmed) !== bundle.certificateSha256) {
    refuse(422, 'REGISTRATION_FINGERPRINT_NOT_CONFIRMED',
      "The confirmed fingerprint does not match the bundle's certificate fingerprint: compare it with the installer's console again",
      'confirmedFingerprint');
  }
  return method as FingerprintConfirmation;
}

/**
 * A JWK cut down to its public members. A private member can never pass. Only
 * an Ed25519 OKP key is carried: its whole public half is `x`. Any other key
 * type would lose public members here (an EC key's `y`, an RSA key's `n` and
 * `e`), so it is REFUSED by name rather than handed over mangled.
 */
export function publicJwk(jwk: Record<string, unknown>): Record<string, string> {
  if (jwk.kty !== 'OKP' || jwk.crv !== 'Ed25519' || typeof jwk.x !== 'string' || jwk.x.length === 0) {
    refuse(503, 'RETURN_BUNDLE_KEY_UNSUPPORTED',
      `The return bundle carries Ed25519 (OKP) public keys only; key '${String(jwk.kid ?? 'unnamed')}' is `
      + `${String(jwk.kty ?? 'untyped')}${jwk.crv ? ` ${String(jwk.crv)}` : ''}. Configure an Ed25519 key for it.`);
  }
  const out: Record<string, string> = {};
  for (const member of RETURN_BUNDLE_JWK_MEMBERS) {
    if (typeof jwk[member] === 'string') out[member] = jwk[member] as string;
  }
  return out;
}

export interface RegistrationRow {
  service_id: string;
  certificate_sha256: string;
  fingerprint_confirmation: FingerprintConfirmation;
  confirmed_by: string;
  confirmed_at: Date | string;
  bundle_sha256: string;
  step_up_token_id: string;
}

type Queryable = { query: (text: string, params?: unknown[]) => Promise<{ rows: any[] }> };

async function registrationRow(queryable: Queryable, serviceId: string): Promise<RegistrationRow | null> {
  const result = await queryable.query('SELECT * FROM knowledge_source_registrations WHERE service_id = $1', [serviceId]);
  return (result.rows[0] as RegistrationRow | undefined) ?? null;
}

/** The return bundle (§9.2 step 2): public material only, never a secret. */
export interface ReturnBundle {
  schema: typeof RETURN_BUNDLE_SCHEMA;
  serviceId: string;
  audience: string;
  issuer: string;
  certificateSha256: string;
  credentialReference: string | null;
  assertionKeys: { keys: Array<Record<string, string>> };
  lifecycleKey: { kid: string; jwk: Record<string, string> } | null;
}

export function buildReturnBundle(service: ServiceRecord, registration: RegistrationRow, issuer: string): ReturnBundle {
  const assertionKeys = knowledgeAssertionKeysetConfigured()
    ? knowledgeAssertionJwks().keys.map((jwk) => publicJwk(jwk))
    : [];
  const lifecycle = lifecyclePublicKeyFor(service.id);
  return {
    schema: RETURN_BUNDLE_SCHEMA,
    serviceId: service.id,
    audience: service.id,
    issuer,
    certificateSha256: registration.certificate_sha256,
    credentialReference: service.knowledgeCoreCredentialRef,
    assertionKeys: { keys: assertionKeys },
    lifecycleKey: lifecycle ? { kid: lifecycle.kid, jwk: publicJwk(lifecycle.jwk) } : null,
  };
}

/** What the page shows for one registered source: its state, honestly, and the operator's step by NAME. */
export interface RegistrationState {
  schemaVersion: typeof REGISTRATION_STATE_SCHEMA;
  service: { id: string; slug: string; name: string; status: string; currentDescriptorVersion: number | null };
  endpoints: { query: string | null; get: string | null; write: string | null; allowedNetworks: string[] };
  fingerprint: { sha256: string; display: string; confirmation: FingerprintConfirmation; confirmedBy: string; confirmedAt: string };
  channel: {
    credentialReference: string | null;
    environmentVariable: typeof KNOWLEDGE_CHANNEL_CREDENTIALS_ENV;
    /** Whether the reference resolves in THIS process's environment. Never the value. */
    resolves: boolean;
    /** What a dial of this source answers now. */
    dial: 'refused' | 'ready';
    refusal: 'unavailable:transport' | null;
  };
  operatorSteps: Array<{ id: string; done: boolean; text: string }>;
  lifecycleExport: { configured: boolean; keyRecorded: boolean };
  assertionKeysConfigured: boolean;
  grantsForApproval: {
    scope: 'knowledge-contents:read';
    targetType: 'grant.rows';
    change: { rules: Array<{ resourceType: 'service'; selectorForm: 'exact'; selectorIds: string[]; verbs: ['read'] }> };
    decidedOn: '/approvals';
    /**
     * The same grant made directly on the owner plane (Settings > Access grants,
     * `POST /grants`): its ceiling is the `root` scope, so root or an `admin` or
     * `orchestrator` login session makes it; an `operator` session is refused.
     */
    direct: { surface: '/settings/access'; granteeType: 'principal'; resourceType: 'service'; resourceId: string; verb: 'read' };
  };
}

export function registrationState(service: ServiceRecord, registration: RegistrationRow): RegistrationState {
  const reference = service.knowledgeCoreCredentialRef;
  const resolves = resolveChannelCredential(reference) !== null;
  const lifecycleConfigured = lifecycleSelectionFor(service.id) !== null;
  return {
    schemaVersion: REGISTRATION_STATE_SCHEMA,
    service: {
      id: service.id, slug: service.slug, name: service.name, status: service.status,
      currentDescriptorVersion: service.currentDescriptorVersion,
    },
    endpoints: {
      query: service.knowledgeQueryEndpoint, get: service.knowledgeGetEndpoint, write: service.knowledgeWriteEndpoint,
      allowedNetworks: service.knowledgeAllowedNetworks,
    },
    fingerprint: {
      sha256: registration.certificate_sha256,
      display: displayFingerprint(registration.certificate_sha256),
      confirmation: registration.fingerprint_confirmation,
      confirmedBy: String(registration.confirmed_by),
      confirmedAt: new Date(registration.confirmed_at).toISOString(),
    },
    channel: {
      credentialReference: reference,
      environmentVariable: KNOWLEDGE_CHANNEL_CREDENTIALS_ENV,
      resolves,
      dial: resolves ? 'ready' : 'refused',
      refusal: resolves ? null : 'unavailable:transport',
    },
    // NAMES ONLY. The value is printed by the installer on its own host and is
    // never shown, sent or stored here.
    operatorSteps: [
      {
        id: 'place-channel-bearer',
        done: resolves,
        text: `On the core host, as root: add an entry named "${reference}" to the JSON in ${KNOWLEDGE_CHANNEL_CREDENTIALS_ENV}, `
          + 'of the form {"bearer": <the channel bearer the installer printed>}. Keep every other entry.',
      },
      {
        id: 'restart-core',
        done: resolves,
        text: 'Restart the core so it reads the new environment. Until then every search of this source answers unavailable:transport.',
      },
    ],
    lifecycleExport: { configured: lifecycleConfigured, keyRecorded: lifecyclePublicKeyFor(service.id) !== null },
    assertionKeysConfigured: knowledgeAssertionKeysetConfigured(),
    grantsForApproval: {
      scope: 'knowledge-contents:read',
      targetType: 'grant.rows',
      change: { rules: [{ resourceType: 'service', selectorForm: 'exact', selectorIds: [service.id], verbs: ['read'] }] },
      decidedOn: '/approvals',
      direct: { surface: '/settings/access', granteeType: 'principal', resourceType: 'service', resourceId: service.id, verb: 'read' },
    },
  };
}

export interface RegisterInput {
  bundle: RegistrationBundle;
  confirmation: FingerprintConfirmation;
  allowedNetworks: string[];
  stepUpToken: unknown;
  principalId: string;
  actor: AuditActor;
}

/** Validate the allowed networks the administrator gave for a private endpoint. */
export function parseAllowedNetworks(value: unknown): string[] {
  if (value === undefined || value === null) return [];
  return policy(() => validateAllowedNetworks(value, 'allowedNetworks'));
}

async function burnStepUp(client: PoolClient, input: { stepUpToken: unknown; principalId: string; fingerprint: string }):
  Promise<{ tokenId: string; method: string }> {
  if (typeof input.stepUpToken !== 'string' || input.stepUpToken.length === 0) {
    throw await stepUpRequiredError(input.principalId, KNOWLEDGE_SOURCE_REGISTER_STEP_UP_ACTION, input.fingerprint,
      'Registering a knowledge source needs a single-use step-up bound to (knowledge.source.register, the certificate fingerprint)', client);
  }
  return stepUpService.consume(client, {
    token: input.stepUpToken, principalId: input.principalId,
    action: KNOWLEDGE_SOURCE_REGISTER_STEP_UP_ACTION, targetId: input.fingerprint,
  });
}

/**
 * THE ACT, in one transaction. A taken credential reference is refused first,
 * before the step-up is spent. A refusal anywhere rolls everything back,
 * including the step-up's consumption, so a refused registration leaves no
 * Service, no row and no spent step-up behind. The serialization lock makes
 * the duplicate checks and the writes one decision.
 */
export async function registerKnowledgeSource(input: RegisterInput): Promise<{ service: ServiceRecord; registration: RegistrationRow }> {
  const { bundle } = input;
  const credentialReference = policy(() => validateCoreCredentialRef(credentialReferenceFor(bundle.slug), 'credentialReference'));
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended('knowledge-source-registration', 0))");
    // The derived reference name must be free: refused before the step-up is
    // spent and before anything is written (see the header).
    await assertCredentialReferenceFree(client, credentialReference);
    const stepUp = await burnStepUp(client, { stepUpToken: input.stepUpToken, principalId: input.principalId, fingerprint: bundle.certificateSha256 });

    // Duplicates, by name. A Service that is retired no longer holds its
    // endpoint or its fingerprint; a published or draft one does.
    const endpointTaken = await client.query(
      `SELECT id FROM services WHERE status <> 'retired' AND knowledge_query_endpoint = $1 LIMIT 1`, [bundle.endpoint]);
    if (endpointTaken.rows.length > 0) {
      refuse(409, 'REGISTRATION_ENDPOINT_TAKEN',
        `A registered knowledge source already uses this endpoint (Service ${endpointTaken.rows[0].id})`, 'bundle.endpoint');
    }
    const fingerprintTaken = await client.query(
      `SELECT r.service_id FROM knowledge_source_registrations r JOIN services s ON s.id = r.service_id
        WHERE r.certificate_sha256 = $1 AND s.status <> 'retired' LIMIT 1`, [bundle.certificateSha256]);
    if (fingerprintTaken.rows.length > 0) {
      refuse(409, 'REGISTRATION_FINGERPRINT_TAKEN',
        `A registered knowledge source already presents this certificate (Service ${fingerprintTaken.rows[0].service_id})`,
        'bundle.certificateSha256');
    }

    const options = { transaction: client };
    let service = await serviceRegistry.register(
      { slug: bundle.slug, name: bundle.name, description: bundle.description, kind: 'service' }, input.principalId, options);
    service = (await serviceRegistry.publishDescriptor(service.id, bundle.descriptor, service.revision, input.principalId, options)).service;
    service = await serviceRegistry.update(service.id, { status: 'published' }, service.revision, input.principalId, options);
    service = await serviceRegistry.updateOwnerPlane(service.id, {
      knowledgeQueryEndpoint: bundle.endpoint,
      ...(bundle.getEndpoint ? { knowledgeGetEndpoint: bundle.getEndpoint } : {}),
      ...(bundle.writeEndpoint ? { knowledgeWriteEndpoint: bundle.writeEndpoint } : {}),
      knowledgeCoreCredentialRef: credentialReference,
      knowledgeAllowedNetworks: input.allowedNetworks,
    }, service.revision, input.principalId, { ...options, auditActor: input.actor });

    const inserted = await client.query(
      `INSERT INTO knowledge_source_registrations
         (service_id, certificate_sha256, fingerprint_confirmation, confirmed_by, bundle_sha256, step_up_token_id)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
      [service.id, bundle.certificateSha256, input.confirmation, input.principalId, bundle.bundleSha256, stepUp.tokenId]);
    const registration = inserted.rows[0] as RegistrationRow;

    // ONE row for the act, carrying the fingerprint exactly as confirmed.
    await auditService.record({
      action: KNOWLEDGE_SOURCE_REGISTER_AUDIT_ACTION,
      actor: input.actor,
      resourceType: 'service',
      resourceId: service.id,
      metadata: {
        certificateSha256: bundle.certificateSha256,
        fingerprintConfirmation: input.confirmation,
        bundleSha256: bundle.bundleSha256,
        endpoint: bundle.endpoint,
        allowedNetworks: input.allowedNetworks,
        credentialReference,
        descriptorVersion: service.currentDescriptorVersion,
        stepUpTokenId: stepUp.tokenId,
        stepUpMethod: stepUp.method,
      },
    }, client);
    await client.query('COMMIT');
    return { service, registration };
  } catch (e) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw e;
  } finally {
    client.release();
  }
}

/** One registered source with its registration row, or null when the Service was not registered by this act. */
export async function readRegistration(serviceId: string): Promise<{ service: ServiceRecord; registration: RegistrationRow } | null> {
  let service: ServiceRecord;
  try {
    service = await serviceRegistry.getByIdOrSlug(serviceId);
  } catch (e) {
    if (e instanceof ServiceRegistryError && e.status === 404) return null;
    throw e;
  }
  const registration = await registrationRow(pool, service.id);
  return registration ? { service, registration } : null;
}

/** Every registered source, newest first. */
export async function listRegistrations(): Promise<Array<{ service: ServiceRecord; registration: RegistrationRow }>> {
  const rows = await pool.query('SELECT service_id FROM knowledge_source_registrations ORDER BY confirmed_at DESC, service_id');
  const out: Array<{ service: ServiceRecord; registration: RegistrationRow }> = [];
  for (const row of rows.rows) {
    const one = await readRegistration(String(row.service_id));
    if (one) out.push(one);
  }
  return out;
}
