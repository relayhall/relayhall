/**
 * IdentityProviderService — the Identity provider as configuration
 * (vocabulary A23.1; design `d95136d7` §4.1, §4.4; SS-3, SS-7, SS-21;
 * owner ruling D3 for SS-14a).
 *
 * ── EVERY FIELD IS A VALUE, NOT A BRANCH ──
 *
 * Nothing in this service asks WHICH product it is talking to. The eight shape
 * classes of annex `e6dcadb9` §10a are absorbed by configuration — a dotted
 * `groups_claim` path, an opaque `external_group_ref`, an enumerated
 * `client_auth_method`, a per-provider private-address flag — and the §4.5(b)
 * gate proves no vendor-identifying literal reaches this source.
 *
 * ── THE RULES THAT CANNOT BE LEFT TO THE SCHEMA ALONE ──
 *
 * Migration 104 makes each forbidden state unrepresentable, which is the floor.
 * This service adds the NAMED ERROR the design asks for at configuration time,
 * so an operator learns which rule they hit rather than reading a constraint
 * name out of a 500:
 *
 *   * SS-21 — a provider declaring `subject_immutable=false` cannot be
 *     activated; and flipping a LIVE provider true -> false disables it in the
 *     same statement, which is what "stops new linking rather than leaving it
 *     quietly usable" means in practice;
 *   * SS-14a (owner D3) — exactly one ENABLED Identity provider in v1,
 *     enforced at the write. SSO-R5's claim-matching conditions depend on it,
 *     so W2 enforces it and W3 discharges its acceptance row;
 *   * SS-22 — `directory` provisioning mode cannot be activated until W4
 *     supplies the producer that writes `expected` links.
 *
 * ── SECRETS (SS-7) ──
 *
 * `client_secret` and `client_private_key` are stored as ciphertext under the
 * AUTHZ `4d961e37` §7.2 envelope keyset — the SAME keyset, canary and rotation
 * as every other credential secret. A second envelope would be a second
 * rotation story. REVEAL IS NEVER OFFERED: an operator who loses the client
 * secret rotates it at the Identity provider, not by reading it back from the
 * board. The row id is generated here rather than by the database so the AEAD
 * additional data can bind the ciphertext to its row before the INSERT.
 */
import crypto from 'crypto';
import type { PoolClient } from 'pg';
import { pool } from '../../db/connection';
import { auditService, type AuditActor } from '../AuditService';
import { directoryCarriageService } from '../DirectoryCarriageService';
import { encryptCredentialSecret } from '../../utils/credentialCrypto';
import { registryConnectorsOf } from '../../utils/connectorRegistry';

/**
 * SSO-R8: the `directory_sync_state` key prefix for SCIM push watermarks.
 * Spelled here as well as in `ScimProvisioningService` (which exports it)
 * because that module imports THIS one, and a cycle between the two would
 * make the import order decide which constant is undefined at load.
 */
const SCIM_HEARTBEAT_KEY_PREFIX = 'scim:';

export const IDENTITY_PROVIDER_ERRORS = [
  'PROVIDER_NOT_FOUND',
  'PROVIDER_SUBJECT_NOT_IMMUTABLE',
  'PROVIDER_SECOND_ACTIVE',
  'PROVIDER_DIRECTORY_MODE_UNAVAILABLE',
  'PROVIDER_ISSUER_INVALID',
  'PROVIDER_ISSUER_TAKEN',
  'PROVIDER_CLAIM_MATCHING_REQUIRES_VERIFIED_EMAIL',
  'PROVIDER_HAS_IDENTITY_LINKS',
  // RH-P5.SSO.W4 (A24): naming this Identity provider's SCIM client is an
  // owner-plane act with its own refusals — the target must exist, must be
  // the parentless service Account shape A17.2 describes, and must not
  // already provision for another provider.
  'PROVIDER_SCIM_CLIENT_NOT_FOUND',
  'PROVIDER_SCIM_CLIENT_INVALID',
  'PROVIDER_SCIM_CLIENT_TAKEN',
  // Owner ruling 4ae7ce53 §1.4: a service Account paired with no registry
  // Connector (A17.2) cannot be named as the SCIM client — the act-time
  // rule asks the registry, so the binding must have asked it first.
  'PROVIDER_SCIM_CLIENT_UNPAIRED',
  // SSO-R8 (RH-P5.SSO.W4 candidate B): the expected-heartbeat interval is a
  // positive whole number of hours, or null for claim-sync semantics.
  'PROVIDER_SCIM_HEARTBEAT_INTERVAL_INVALID',
  // RH-LENSES-a (card 74e02a05): which pushed SCIM attribute carries the
  // group reference is a closed two-value declaration; an unknown value is
  // refused at the boundary rather than at the CHECK constraint, so the
  // operator gets a sentence naming both admitted values.
  'INVALID_SCIM_GROUP_REF_ATTRIBUTE',
  'LOGIN_GROUP_NOT_FOUND',
  'LOGIN_GROUP_NOT_LISTED',
] as const;
export type IdentityProviderErrorCode = (typeof IDENTITY_PROVIDER_ERRORS)[number];

export class IdentityProviderError extends Error {
  constructor(public readonly code: IdentityProviderErrorCode, message: string) {
    super(message);
    this.name = 'IdentityProviderError';
  }
}

export type ProviderStatus = 'active' | 'disabled';
export type ProvisioningMode = 'invited' | 'directory' | 'jit';
export type GroupBindingMode = 'off' | 'claim';
export type ClientAuthMethod = 'client_secret_basic' | 'client_secret_post' | 'private_key_jwt' | 'none';

/**
 * The Identity provider as every caller sees it. There is no `clientSecret`
 * field on this type, which is how SS-7's "no surface returns it" survives a
 * future route that serialises the whole object.
 */
/**
 * RH-LENSES-a: the two attributes a SCIM Group may declare its ref in.
 *
 * `'id'` IS DELIBERATELY ABSENT. RFC 7643 §3.1 makes `id` the SERVICE
 * PROVIDER's to assign and the design maps SCIM `id` onto the board's own
 * the board's own server-assigned reference id; admitting it here would
 * either make a
 * conforming POST -- which supplies no `id` -- unusable under the
 * "declared attribute absent -> 400" rule, or create a client-controlled
 * shadow field with the same name as a server-owned one. Two owners for
 * one attribute is a wire-contract defect.
 */
export const SCIM_GROUP_REF_ATTRIBUTES = ['externalId', 'displayName'] as const;
export type ScimGroupRefAttribute = (typeof SCIM_GROUP_REF_ATTRIBUTES)[number];

export interface IdentityProvider {
  id: string;
  name: string;
  status: ProviderStatus;
  issuer: string;
  discoveryUrl: string;
  clientId: string;
  clientAuthMethod: ClientAuthMethod;
  /** Presence only — never the value. */
  hasClientSecret: boolean;
  hasClientPrivateKey: boolean;
  scopesRequested: string;
  extraAuthorizeParams: Record<string, string>;
  additionalEndpointOrigins: string[];
  handleClaim: string;
  displayNameClaim: string;
  emailClaim: string;
  groupsClaim: string | null;
  requiredClaims: Record<string, string | string[]>;
  subjectImmutable: boolean;
  provisioningMode: ProvisioningMode;
  groupBindingMode: GroupBindingMode;
  /**
   * RH-LENSES-a (card `74e02a05`, design v5 §4.4): WHICH attribute of a
   * SCIM Group pushed to `/scim/v2/Groups` becomes `external_group_ref`,
   * taken from the pushed resource VERBATIM and never normalised.
   *
   * The provider declares it because SCIM and OIDC need not agree on the
   * identifier, and pretending they do is the defect this field avoids: a
   * directory sending `/path` names sets `displayName`, one sending GUIDs
   * leaves `externalId`. A MISCONFIGURED attribute produces carriage that
   * binds NOTHING -- it never produces wrong bindings, because the join is
   * byte-exact and simply misses -- and the failure is visible in the
   * catalog as two rows for one real group with different refs and
   * different sources. That is the honest cost of not parsing.
   */
  scimGroupRefAttribute: ScimGroupRefAttribute;
  /** A24 (RH-P5.SSO.W4): the service Account whose Connector is this Identity
   *  provider's SCIM client, or null when it does not provision by SCIM. */
  scimClientPrincipalId: string | null;
  /**
   * SSO-R8 / AZ-A4 clause 4 (owner ruling `6bdcc16c` §2): the expected-heartbeat
   * interval for this Identity provider's SCIM pushes. NULL keeps claim-sync
   * semantics; a value means the `scim:<id>` row of `directory_sync_state`
   * is "last push received" and silence past this many hours is stale.
   */
  scimHeartbeatIntervalHours: number | null;
  /**
   * SSO-R4: gate federated login on Group membership. Enabled with an EMPTY
   * allowed-Group list refuses every federated login — fail closed (W3-D2).
   * Never consulted on the local password path.
   */
  loginGroupWhitelistEnabled: boolean;
  allowPrivateIssuerAddress: boolean;
  allowClaimMatching: boolean;
  retainIdToken: boolean;
  providerOwnsProfile: boolean;
  clockSkewSeconds: number;
  sessionTtlSeconds: number | null;
  authenticationRequestTtlSeconds: number;
  backchannelLogoutEnabled: boolean;
  lastDiscoveryAt: Date | null;
  lastDiscoveryErrorPresent: boolean;
  jwksRefreshedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

const SELECT_COLUMNS = `
  id, name, status, issuer, discovery_url, client_id, client_auth_method,
  client_secret_ct IS NOT NULL AS has_client_secret,
  client_private_key_ct IS NOT NULL AS has_client_private_key,
  scopes_requested, extra_authorize_params, additional_endpoint_origins,
  handle_claim, display_name_claim, email_claim, groups_claim, required_claims,
  subject_immutable, provisioning_mode, group_binding_mode,
  scim_group_ref_attribute,
  scim_client_principal_id, scim_heartbeat_interval_hours,
  login_group_whitelist_enabled,
  allow_private_issuer_address, allow_claim_matching, retain_id_token,
  provider_owns_profile, clock_skew_seconds, session_ttl_seconds,
  authentication_request_ttl_seconds, backchannel_logout_enabled,
  last_discovery_at, last_discovery_error_present, jwks_refreshed_at,
  created_at, updated_at`;

function mapRow(row: Record<string, unknown>): IdentityProvider {
  return {
    id: String(row.id),
    name: String(row.name),
    status: row.status as ProviderStatus,
    issuer: String(row.issuer),
    discoveryUrl: String(row.discovery_url),
    clientId: String(row.client_id),
    clientAuthMethod: row.client_auth_method as ClientAuthMethod,
    hasClientSecret: row.has_client_secret === true,
    hasClientPrivateKey: row.has_client_private_key === true,
    scopesRequested: String(row.scopes_requested),
    extraAuthorizeParams: (row.extra_authorize_params ?? {}) as Record<string, string>,
    additionalEndpointOrigins: (row.additional_endpoint_origins ?? []) as string[],
    handleClaim: String(row.handle_claim),
    displayNameClaim: String(row.display_name_claim),
    emailClaim: String(row.email_claim),
    groupsClaim: row.groups_claim === null || row.groups_claim === undefined ? null : String(row.groups_claim),
    requiredClaims: (row.required_claims ?? {}) as Record<string, string | string[]>,
    subjectImmutable: row.subject_immutable === true,
    provisioningMode: row.provisioning_mode as ProvisioningMode,
    groupBindingMode: row.group_binding_mode as GroupBindingMode,
    scimGroupRefAttribute: (row.scim_group_ref_attribute ?? 'externalId') as ScimGroupRefAttribute,
    scimClientPrincipalId: row.scim_client_principal_id === null || row.scim_client_principal_id === undefined
      ? null
      : String(row.scim_client_principal_id),
    scimHeartbeatIntervalHours: row.scim_heartbeat_interval_hours === null || row.scim_heartbeat_interval_hours === undefined
      ? null
      : Number(row.scim_heartbeat_interval_hours),
    loginGroupWhitelistEnabled: row.login_group_whitelist_enabled === true,
    allowPrivateIssuerAddress: row.allow_private_issuer_address === true,
    allowClaimMatching: row.allow_claim_matching === true,
    retainIdToken: row.retain_id_token === true,
    providerOwnsProfile: row.provider_owns_profile === true,
    clockSkewSeconds: Number(row.clock_skew_seconds),
    sessionTtlSeconds: row.session_ttl_seconds === null || row.session_ttl_seconds === undefined
      ? null
      : Number(row.session_ttl_seconds),
    authenticationRequestTtlSeconds: Number(row.authentication_request_ttl_seconds),
    backchannelLogoutEnabled: row.backchannel_logout_enabled === true,
    lastDiscoveryAt: (row.last_discovery_at as Date | null) ?? null,
    lastDiscoveryErrorPresent: row.last_discovery_error_present === true,
    jwksRefreshedAt: (row.jwks_refreshed_at as Date | null) ?? null,
    createdAt: row.created_at as Date,
    updatedAt: row.updated_at as Date,
  };
}

export interface CreateIdentityProviderInput {
  name: string;
  issuer: string;
  discoveryUrl?: string;
  clientId: string;
  clientAuthMethod?: ClientAuthMethod;
  clientSecret?: string | null;
  clientPrivateKey?: string | null;
  /** SS-21: the operator MUST declare it. There is no default. */
  subjectImmutable: boolean;
  status?: ProviderStatus;
  scopesRequested?: string;
  extraAuthorizeParams?: Record<string, string>;
  additionalEndpointOrigins?: string[];
  handleClaim?: string;
  displayNameClaim?: string;
  emailClaim?: string;
  groupsClaim?: string | null;
  requiredClaims?: Record<string, string | string[]>;
  provisioningMode?: ProvisioningMode;
  groupBindingMode?: GroupBindingMode;
  /** RH-LENSES-a: `externalId` (the default) or `displayName`. */
  scimGroupRefAttribute?: ScimGroupRefAttribute;
  loginGroupWhitelistEnabled?: boolean;
  allowPrivateIssuerAddress?: boolean;
  allowClaimMatching?: boolean;
  retainIdToken?: boolean;
  providerOwnsProfile?: boolean;
  clockSkewSeconds?: number;
  sessionTtlSeconds?: number | null;
  authenticationRequestTtlSeconds?: number;
  backchannelLogoutEnabled?: boolean;
  /** SSO-R8: `null` is a value (claim-sync semantics), `undefined` is "unset". */
  scimHeartbeatIntervalHours?: number | null;
}

export type UpdateIdentityProviderInput = Partial<Omit<CreateIdentityProviderInput, 'subjectImmutable'>> & {
  subjectImmutable?: boolean;
};

/**
 * RH-LENSES-a: refuse an unknown ref attribute at the boundary rather than
 * at the CHECK constraint, so an operator gets a sentence naming the two
 * admitted values instead of a constraint violation.
 */
function validateScimGroupRefAttribute(value: unknown): ScimGroupRefAttribute | null {
  if (value === undefined || value === null) return null;
  if (!(SCIM_GROUP_REF_ATTRIBUTES as readonly unknown[]).includes(value)) {
    throw new IdentityProviderError(
      'INVALID_SCIM_GROUP_REF_ATTRIBUTE',
      `scimGroupRefAttribute must be one of ${SCIM_GROUP_REF_ATTRIBUTES.join(', ')}`,
    );
  }
  return value as ScimGroupRefAttribute;
}

/** The default discovery path, overridable because not every issuer sits there. */
function defaultDiscoveryUrl(issuer: string): string {
  return `${issuer.replace(/\/+$/, '')}/.well-known/openid-configuration`;
}

/**
 * SSO-R8: the heartbeat interval, validated at the boundary the PATCH route
 * hands straight through. `undefined` = not mentioned; `null` = claim-sync
 * semantics; otherwise a positive whole number of hours. Migration 107's
 * CHECK is the floor; this is the named refusal above it.
 */
function heartbeatIntervalOf(value: unknown): number | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value === 'number' && Number.isInteger(value) && value > 0) return value;
  throw new IdentityProviderError(
    'PROVIDER_SCIM_HEARTBEAT_INTERVAL_INVALID',
    'scimHeartbeatIntervalHours must be a positive whole number of hours, or null to keep claim-sync semantics (SSO-R8)',
  );
}

/**
 * Keep the `scim:<id>` watermark row in step with the Identity provider's
 * interval — in the SAME transaction as the write that changed it.
 *
 * A value creates the row (with no `last_success_at`, so the existing AZ-30
 * read reports it stale until the first push arrives — an Identity provider
 * that is expected to push and has not is exactly what the alarm is for) or
 * moves its threshold. NULL removes the row: claim-sync semantics have no
 * push watermark, and a row left behind would keep alarming against a
 * threshold nobody holds any more. The push itself (`recordPush`) copies the
 * same interval on every arrival, so the two writers cannot disagree for
 * longer than one push.
 */
async function syncHeartbeatRow(client: PoolClient, identityProviderId: string, intervalHours: number | null): Promise<void> {
  const key = `${SCIM_HEARTBEAT_KEY_PREFIX}${identityProviderId}`;
  if (intervalHours === null) {
    await client.query('DELETE FROM directory_sync_state WHERE provider = $1', [key]);
    return;
  }
  await client.query(
    `INSERT INTO directory_sync_state (provider, staleness_threshold_hours)
     VALUES ($1, $2)
     ON CONFLICT (provider) DO UPDATE SET staleness_threshold_hours = EXCLUDED.staleness_threshold_hours`,
    [key, intervalHours],
  );
}

function assertIssuerShape(issuer: string): void {
  let url: URL;
  try {
    url = new URL(issuer);
  } catch {
    throw new IdentityProviderError('PROVIDER_ISSUER_INVALID', 'the issuer must be an absolute https URL');
  }
  if (url.protocol !== 'https:') {
    throw new IdentityProviderError('PROVIDER_ISSUER_INVALID', 'the issuer must use https');
  }
  if (url.hash !== '' || url.search !== '') {
    throw new IdentityProviderError('PROVIDER_ISSUER_INVALID', 'the issuer must not carry a query or fragment');
  }
}

export class IdentityProviderService {
  async list(): Promise<IdentityProvider[]> {
    const result = await pool.query(`SELECT ${SELECT_COLUMNS} FROM identity_providers ORDER BY created_at`);
    return result.rows.map(mapRow);
  }

  async get(id: string): Promise<IdentityProvider | undefined> {
    const result = await pool.query(`SELECT ${SELECT_COLUMNS} FROM identity_providers WHERE id = $1`, [id]);
    return result.rows[0] ? mapRow(result.rows[0]) : undefined;
  }

  async require(id: string): Promise<IdentityProvider> {
    const found = await this.get(id);
    if (!found) throw new IdentityProviderError('PROVIDER_NOT_FOUND', 'no such Identity provider');
    return found;
  }

  /**
   * The ONE active Identity provider, or undefined.
   *
   * SS-14a makes this a total function rather than a convention: the partial
   * unique index in migration 104 admits at most one row with `status='active'`,
   * so "the active provider" is well defined and the `/config` presence block
   * and the login button can rely on it.
   */
  async activeProvider(): Promise<IdentityProvider | undefined> {
    const result = await pool.query(
      `SELECT ${SELECT_COLUMNS} FROM identity_providers WHERE status = 'active' LIMIT 1`,
    );
    return result.rows[0] ? mapRow(result.rows[0]) : undefined;
  }

  /**
   * The ENABLED Identity provider whose SCIM client is this Account, if any.
   *
   * A24 scopes every provisioning act to "its own Identity provider", and
   * this is where that scoping value comes from: the caller's own identity,
   * never a path segment or a header. `status = 'active'` is part of the
   * predicate rather than a later check — a disabled provider has no SCIM
   * client, so a disabled provider's client resolves to nothing and is
   * refused by the same arm that refuses an unbound caller.
   *
   * Migration 106's partial unique index makes this a FUNCTION and not a
   * choice: one service Account is the SCIM client of at most one Identity
   * provider.
   */
  async findByScimClientPrincipal(principalId: string): Promise<IdentityProvider | undefined> {
    const result = await pool.query(
      `SELECT ${SELECT_COLUMNS} FROM identity_providers
        WHERE scim_client_principal_id = $1 AND status = 'active' LIMIT 1`,
      [principalId],
    );
    return result.rows[0] ? mapRow(result.rows[0]) : undefined;
  }

  /**
   * Name (or clear) this Identity provider's SCIM client — an owner-plane act.
   *
   * The eligibility rules are A17.2's shape read literally: the SCIM client
   * is "a service Account's Connector", so the binding names the parentless
   * SERVICE ACCOUNT and the Connector under it presents the credential. It
   * is the Account rather than the Connector because a Connector is
   * rotatable and a binding that dies with a rotation would make credential
   * hygiene an outage.
   *
   * The binding REQUIRES the registry pairing (owner ruling `4ae7ce53`
   * §1.4). A24's "Connector" is the registry object paired with its
   * delegated identity (A17.2), and the SCIM act asks the REGISTRY whether
   * the acting principal is one; a binding that never asked would make
   * eligibility depend on registry state the owner plane never saw. So the
   * named Account must have at least one registry Connector beneath it,
   * asked through the SAME predicate the act-time rule uses. A parentless
   * service Account that merely LOOKS like the shape is refused by name.
   *
   * A HUMAN principal is refused, and that refusal is what makes the route
   * ceiling's breadth harmless: `directory-provisioning:write` is derived by
   * every working role (see `identityScopes`), but a login session's own
   * principal can never be a SCIM client, so it can never resolve an Identity
   * provider
   * and can never provision. The bound is structural, not a scope string.
   */
  async setScimClient(
    id: string,
    principalId: string | null,
    actor: AuditActor,
  ): Promise<IdentityProvider> {
    const provider = await this.require(id);
    if (principalId === null && provider.status === 'active' && provider.provisioningMode === 'directory') {
      // SS-22 on the other edge: clearing the producer of an ENABLED
      // directory-mode Identity provider would leave it enabled and unable
      // to admit anyone. Same named refusal, same floor (migration 108).
      throw new IdentityProviderError(
        'PROVIDER_DIRECTORY_MODE_UNAVAILABLE',
        'this Identity provider is enabled in directory mode, which binds only through the expected Identity links its SCIM client writes (SS-22): switch it to invited or jit, or disable it, before clearing the SCIM client',
      );
    }
    if (principalId !== null) {
      const target = await pool.query(
        'SELECT kind, status, legacy_identity, parent_principal_id FROM principals WHERE id = $1',
        [principalId],
      );
      const row = target.rows[0];
      if (!row) {
        throw new IdentityProviderError('PROVIDER_SCIM_CLIENT_NOT_FOUND', 'that principalId resolves to no principal');
      }
      if (row.kind !== 'service' || row.parent_principal_id !== null) {
        throw new IdentityProviderError(
          'PROVIDER_SCIM_CLIENT_INVALID',
          "the SCIM client is a parentless service Account, whose Connector presents the credential (A17.2/A24). A human Account, an Agent or a Connector itself is refused here.",
        );
      }
      if (row.status !== 'active' || row.legacy_identity === true) {
        throw new IdentityProviderError(
          'PROVIDER_SCIM_CLIENT_INVALID',
          'the SCIM client must be an active, non-legacy service Account',
        );
      }
      if ((await registryConnectorsOf(pool, principalId)).length === 0) {
        throw new IdentityProviderError(
          'PROVIDER_SCIM_CLIENT_UNPAIRED',
          'that service Account is paired with no registry Connector (A17.2): register a Connector under it before naming it as the SCIM client',
        );
      }
    }
    let result;
    try {
      result = await pool.query(
        `UPDATE identity_providers SET scim_client_principal_id = $2, updated_at = now()
          WHERE id = $1 RETURNING ${SELECT_COLUMNS}`,
        [id, principalId],
      );
    } catch (error) {
      if ((error as { code?: string }).code === '23505') {
        throw new IdentityProviderError(
          'PROVIDER_SCIM_CLIENT_TAKEN',
          'that service Account is already the SCIM client of another Identity provider; one Account provisions for one provider, so that resolution stays a function',
        );
      }
      if ((error as { code?: string }).code === '23514') {
        // Migration 108's floor, reached past the check above (a concurrent
        // mode switch): the same sentence, from the database's answer.
        throw new IdentityProviderError(
          'PROVIDER_DIRECTORY_MODE_UNAVAILABLE',
          'this Identity provider is enabled in directory mode, which binds only through the expected Identity links its SCIM client writes (SS-22): switch it to invited or jit, or disable it, before clearing the SCIM client',
        );
      }
      throw error;
    }
    const updated = mapRow(result.rows[0]);
    await auditService.record({
      action: principalId === null ? 'identity_provider.scim_client.clear' : 'identity_provider.scim_client.set',
      actor,
      resourceType: 'identity_provider',
      resourceId: id,
      metadata: {
        previous_scim_client_principal_id: provider.scimClientPrincipalId,
        scim_client_principal_id: principalId,
      },
    });
    return updated;
  }

  /**
   * Configuration-time rules, as NAMED errors. The schema is the floor.
   *
   * SS-22, LIFTED by RH-P5.SSO.W4 candidate C exactly as far as the producer
   * exists: `directory` mode binds only through the `expected` Identity
   * links THIS Identity provider's SCIM client writes, so it can be enabled
   * where that client is named (migration 106) and nowhere else. The named
   * refusal stays for the misconfiguration a naive lift would admit — an
   * enabled directory-mode Identity provider with no producer, on which
   * every first login is refused `SSO_ACCOUNT_UNAVAILABLE` and nobody can
   * tell why. Migration 108's CHECK is the floor under this arm.
   */
  private assertActivatable(candidate: {
    subjectImmutable: boolean;
    provisioningMode: ProvisioningMode;
    scimClientPrincipalId: string | null;
  }): void {
    if (!candidate.subjectImmutable) {
      throw new IdentityProviderError(
        'PROVIDER_SUBJECT_NOT_IMMUTABLE',
        'an Identity provider that cannot declare immutable, never-recycled subjects cannot be enabled (SS-21). Linking is refused for it rather than bounded by a re-proof interval that has no mechanism behind it.',
      );
    }
    if (candidate.provisioningMode === 'directory' && candidate.scimClientPrincipalId === null) {
      throw new IdentityProviderError(
        'PROVIDER_DIRECTORY_MODE_UNAVAILABLE',
        'directory provisioning mode binds only through the expected Identity links its SCIM client writes (SS-22): name the SCIM client of this Identity provider first, then enable directory mode. Use invited or jit otherwise.',
      );
    }
  }

  private async assertNoOtherActive(exceptId: string | null): Promise<void> {
    const result = await pool.query(
      `SELECT id FROM identity_providers WHERE status = 'active' AND ($1::uuid IS NULL OR id <> $1::uuid) LIMIT 1`,
      [exceptId],
    );
    if (result.rows.length > 0) {
      throw new IdentityProviderError(
        'PROVIDER_SECOND_ACTIVE',
        'exactly one Identity provider may be enabled (SS-14a). Disable the current one first.',
      );
    }
  }

  async create(input: CreateIdentityProviderInput, actor: AuditActor): Promise<IdentityProvider> {
    assertIssuerShape(input.issuer);
    const status = input.status ?? 'disabled';
    const provisioningMode = input.provisioningMode ?? 'invited';
    if (status === 'active') {
      // A SCIM client is named AFTER creation (`setScimClient`), so a row
      // created enabled in directory mode has no producer yet and is refused
      // by name: create it disabled, name the client, then enable it.
      this.assertActivatable({ subjectImmutable: input.subjectImmutable, provisioningMode, scimClientPrincipalId: null });
      await this.assertNoOtherActive(null);
    }

    const heartbeatIntervalHours = heartbeatIntervalOf(input.scimHeartbeatIntervalHours) ?? null;

    // The id is minted here so the AEAD additional data can bind each
    // ciphertext to its row before the row exists (§7.2: a ciphertext copied
    // onto another row must fail authentication, not reveal a foreign secret).
    const id = crypto.randomUUID();
    const secret = input.clientSecret ? encryptCredentialSecret(input.clientSecret, id) : null;
    const privateKey = input.clientPrivateKey ? encryptCredentialSecret(input.clientPrivateKey, id) : null;

    // The row and its heartbeat watermark (SSO-R8) commit together: an
    // Identity provider declared to push must be stale until it does, and
    // that can only be true if the watermark row exists the moment the
    // interval does.
    const client = await pool.connect();
    let created: IdentityProvider;
    try {
      await client.query('BEGIN');
      const result = await client.query(
      `INSERT INTO identity_providers (
         id, name, status, issuer, discovery_url, client_id, client_auth_method,
         client_secret_ct, client_secret_key_id, client_private_key_ct, client_private_key_key_id,
         scopes_requested, extra_authorize_params, additional_endpoint_origins,
         handle_claim, display_name_claim, email_claim, groups_claim, required_claims,
         subject_immutable, provisioning_mode, group_binding_mode,
         scim_group_ref_attribute,
         login_group_whitelist_enabled,
         allow_private_issuer_address, allow_claim_matching, retain_id_token,
         provider_owns_profile, clock_skew_seconds, session_ttl_seconds,
         authentication_request_ttl_seconds, backchannel_logout_enabled, created_by_principal_id,
         scim_heartbeat_interval_hours)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb,$14::jsonb,$15,$16,$17,$18,$19::jsonb,
               $20,$21,$22,$34,$23,$24,$25,$26,$27,$28,$29,$30,$31,$32,$33)
       RETURNING ${SELECT_COLUMNS}`,
      [
        id,
        input.name,
        status,
        input.issuer,
        input.discoveryUrl ?? defaultDiscoveryUrl(input.issuer),
        input.clientId,
        input.clientAuthMethod ?? 'client_secret_basic',
        secret?.ciphertext ?? null,
        secret?.encryptionKeyId ?? null,
        privateKey?.ciphertext ?? null,
        privateKey?.encryptionKeyId ?? null,
        input.scopesRequested ?? 'openid profile email',
        JSON.stringify(input.extraAuthorizeParams ?? {}),
        JSON.stringify(input.additionalEndpointOrigins ?? []),
        input.handleClaim ?? 'preferred_username',
        input.displayNameClaim ?? 'name',
        input.emailClaim ?? 'email',
        input.groupsClaim ?? null,
        JSON.stringify(input.requiredClaims ?? {}),
        input.subjectImmutable,
        provisioningMode,
        input.groupBindingMode ?? 'off',
        input.loginGroupWhitelistEnabled ?? false,
        input.allowPrivateIssuerAddress ?? false,
        input.allowClaimMatching ?? false,
        input.retainIdToken ?? false,
        input.providerOwnsProfile ?? false,
        input.clockSkewSeconds ?? 60,
        input.sessionTtlSeconds ?? null,
        input.authenticationRequestTtlSeconds ?? 600,
        input.backchannelLogoutEnabled ?? false,
        actor.principalId ?? null,
        heartbeatIntervalHours,
        validateScimGroupRefAttribute(input.scimGroupRefAttribute) ?? 'externalId',
      ],
      ).catch((error: unknown) => {
        if (isUniqueViolation(error, 'ux_identity_providers_issuer')) {
          throw new IdentityProviderError('PROVIDER_ISSUER_TAKEN', 'an Identity provider is already configured for that issuer');
        }
        throw error;
      });
      created = mapRow(result.rows[0]);
      await syncHeartbeatRow(client, created.id, created.scimHeartbeatIntervalHours);
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }

    // Every owner-plane act is audited, and the declaration is part of the
    // record — SS-21 calls it "an audited owner-plane act".
    await auditService.record({
      action: 'identity_provider.create',
      actor,
      resourceType: 'identity_provider',
      resourceId: created.id,
      metadata: {
        issuer: created.issuer,
        status: created.status,
        subject_immutable: created.subjectImmutable,
        provisioning_mode: created.provisioningMode,
        allow_private_issuer_address: created.allowPrivateIssuerAddress,
        allow_claim_matching: created.allowClaimMatching,
        retain_id_token: created.retainIdToken,
        scim_heartbeat_interval_hours: created.scimHeartbeatIntervalHours,
      },
    });
    return created;
  }

  /**
   * Update, with the two transitions that are not simple field writes.
   *
   * SS-21's second sentence — "flipping a live provider true -> false stops new
   * linking rather than leaving it quietly usable" — is implemented as an
   * ACCOMPANYING DISABLE in the same statement, not as a refusal. A refusal
   * would leave an operator who has discovered their Identity provider recycles
   * subjects unable to record that fact at all.
   */
  async update(id: string, input: UpdateIdentityProviderInput, actor: AuditActor): Promise<IdentityProvider> {
    const current = await this.require(id);
    if (input.issuer !== undefined) assertIssuerShape(input.issuer);

    const next = {
      subjectImmutable: input.subjectImmutable ?? current.subjectImmutable,
      provisioningMode: input.provisioningMode ?? current.provisioningMode,
      // The binding is not a field of this update; it is read as it stands.
      scimClientPrincipalId: current.scimClientPrincipalId,
    };
    let status = input.status ?? current.status;
    let disabledBySubjectDeclaration = false;
    // The accompanying disable applies only where the operator did NOT also ask
    // for `active` in the same call. Asking to activate a provider while
    // declaring its subjects recyclable is a contradiction, and a contradiction
    // is refused by name rather than silently resolved in either direction.
    if (
      input.status === undefined &&
      input.subjectImmutable === false &&
      current.subjectImmutable &&
      status === 'active'
    ) {
      status = 'disabled';
      disabledBySubjectDeclaration = true;
    }
    if (status === 'active') {
      this.assertActivatable(next);
      await this.assertNoOtherActive(id);
    }

    const secret = input.clientSecret ? encryptCredentialSecret(input.clientSecret, id) : undefined;
    const privateKey = input.clientPrivateKey ? encryptCredentialSecret(input.clientPrivateKey, id) : undefined;
    const heartbeatIntervalHours = heartbeatIntervalOf(input.scimHeartbeatIntervalHours);

    const client = await pool.connect();
    let updated: IdentityProvider;
    try {
      await client.query('BEGIN');
      const result = await client.query(
      `UPDATE identity_providers SET
         name = COALESCE($2, name),
         status = $3,
         issuer = COALESCE($4, issuer),
         discovery_url = COALESCE($5, discovery_url),
         client_id = COALESCE($6, client_id),
         client_auth_method = COALESCE($7, client_auth_method),
         client_secret_ct = COALESCE($8, client_secret_ct),
         client_secret_key_id = COALESCE($9, client_secret_key_id),
         client_private_key_ct = COALESCE($10, client_private_key_ct),
         client_private_key_key_id = COALESCE($11, client_private_key_key_id),
         scopes_requested = COALESCE($12, scopes_requested),
         extra_authorize_params = COALESCE($13::jsonb, extra_authorize_params),
         additional_endpoint_origins = COALESCE($14::jsonb, additional_endpoint_origins),
         handle_claim = COALESCE($15, handle_claim),
         display_name_claim = COALESCE($16, display_name_claim),
         email_claim = COALESCE($17, email_claim),
         groups_claim = COALESCE($18, groups_claim),
         required_claims = COALESCE($19::jsonb, required_claims),
         subject_immutable = $20,
         provisioning_mode = $21,
         group_binding_mode = COALESCE($22, group_binding_mode),
         scim_group_ref_attribute = COALESCE($34, scim_group_ref_attribute),
         login_group_whitelist_enabled = COALESCE($31, login_group_whitelist_enabled),
         allow_private_issuer_address = COALESCE($23, allow_private_issuer_address),
         allow_claim_matching = COALESCE($24, allow_claim_matching),
         retain_id_token = COALESCE($25, retain_id_token),
         provider_owns_profile = COALESCE($26, provider_owns_profile),
         clock_skew_seconds = COALESCE($27, clock_skew_seconds),
         session_ttl_seconds = COALESCE($28, session_ttl_seconds),
         authentication_request_ttl_seconds = COALESCE($29, authentication_request_ttl_seconds),
         backchannel_logout_enabled = COALESCE($30, backchannel_logout_enabled),
         scim_heartbeat_interval_hours = CASE WHEN $32::boolean THEN $33::integer ELSE scim_heartbeat_interval_hours END,
         updated_at = now()
       WHERE id = $1
       RETURNING ${SELECT_COLUMNS}`,
      [
        id,
        input.name ?? null,
        status,
        input.issuer ?? null,
        input.discoveryUrl ?? null,
        input.clientId ?? null,
        input.clientAuthMethod ?? null,
        secret?.ciphertext ?? null,
        secret?.encryptionKeyId ?? null,
        privateKey?.ciphertext ?? null,
        privateKey?.encryptionKeyId ?? null,
        input.scopesRequested ?? null,
        input.extraAuthorizeParams === undefined ? null : JSON.stringify(input.extraAuthorizeParams),
        input.additionalEndpointOrigins === undefined ? null : JSON.stringify(input.additionalEndpointOrigins),
        input.handleClaim ?? null,
        input.displayNameClaim ?? null,
        input.emailClaim ?? null,
        input.groupsClaim ?? null,
        input.requiredClaims === undefined ? null : JSON.stringify(input.requiredClaims),
        next.subjectImmutable,
        next.provisioningMode,
        input.groupBindingMode ?? null,
        input.allowPrivateIssuerAddress ?? null,
        input.allowClaimMatching ?? null,
        input.retainIdToken ?? null,
        input.providerOwnsProfile ?? null,
        input.clockSkewSeconds ?? null,
        input.sessionTtlSeconds ?? null,
        input.authenticationRequestTtlSeconds ?? null,
        input.backchannelLogoutEnabled ?? null,
        input.loginGroupWhitelistEnabled ?? null,
        // SSO-R8: null is a value here, so presence and value travel apart.
        heartbeatIntervalHours !== undefined,
        heartbeatIntervalHours ?? null,
        validateScimGroupRefAttribute(input.scimGroupRefAttribute) ?? null,
      ],
      );
      updated = mapRow(result.rows[0]);
      if (heartbeatIntervalHours !== undefined && heartbeatIntervalHours !== current.scimHeartbeatIntervalHours) {
        await syncHeartbeatRow(client, id, updated.scimHeartbeatIntervalHours);
      }
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }

    await auditService.record({
      action: 'identity_provider.update',
      actor,
      resourceType: 'identity_provider',
      resourceId: id,
      metadata: {
        status_before: current.status,
        status_after: updated.status,
        subject_immutable_before: current.subjectImmutable,
        subject_immutable_after: updated.subjectImmutable,
        // Named in the ledger so the reason a provider went dark is legible
        // months later, which is the point of auditing the declaration.
        disabled_by_subject_declaration: disabledBySubjectDeclaration,
        // SSO-R4: turning the login gate on or off changes who may authenticate
        // at all, so the transition is legible in the ledger on both sides.
        login_group_whitelist_enabled_before: current.loginGroupWhitelistEnabled,
        login_group_whitelist_enabled_after: updated.loginGroupWhitelistEnabled,
        provisioning_mode: updated.provisioningMode,
        allow_claim_matching: updated.allowClaimMatching,
        retain_id_token: updated.retainIdToken,
        // SSO-R8: moving the interval changes when silence becomes an alarm.
        scim_heartbeat_interval_hours_before: current.scimHeartbeatIntervalHours,
        scim_heartbeat_interval_hours_after: updated.scimHeartbeatIntervalHours,
      },
    });
    return updated;
  }

  /**
   * Delete an Identity provider — permitted ONLY where it has never linked an
   * Account (review round 2, R1 B1 / R3 B2).
   *
   * §7.3 keeps many provider rows precisely so one can be replaced "without
   * destroying links", and SS-8 gives a link one revocation story that RETAINS
   * the row. Deleting a provider that owns links would erase stored proof and
   * its revocation history, and — because the session bindings are
   * ON DELETE SET NULL — would leave the session that link authenticated alive
   * with null bindings, indistinguishable from a local password session.
   *
   * So: refuse, and say what to do instead. The database FK is RESTRICT, which
   * is the floor under this check; this refusal exists to turn that constraint
   * violation into a sentence an operator can act on.
   *
   * The delete and its audit record are ONE transaction. They used to be two
   * statements, so a failing audit write could leave a committed deletion
   * unrecorded.
   */
  async remove(id: string, actor: AuditActor): Promise<void> {
    const current = await this.require(id);
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const links = await client.query(
        'SELECT count(*)::int AS n FROM identity_links WHERE identity_provider_id = $1',
        [id],
      );
      const linkCount = Number(links.rows[0]?.n ?? 0);
      if (linkCount > 0) {
        await client.query('ROLLBACK');
        throw new IdentityProviderError(
          'PROVIDER_HAS_IDENTITY_LINKS',
          `this Identity provider has ${linkCount} Identity link(s) and cannot be deleted: `
            + 'disable it instead, which stops new linking and keeps every link and its '
            + 'revocation history (§7.3, SS-8)',
        );
      }
      // SSO-R8: the push watermark is this Identity provider's and goes with
      // it; a row left behind would alarm forever about nobody.
      await syncHeartbeatRow(client, id, null);
      // ── RH-LENSES-a: the carriage release (card 74e02a05, A-L7/A-L45) ──
      //
      // 104's `trg_identity_providers_unbind_groups` UNBINDS this provider's
      // Groups and migration 126 CASCADEs its references and their carriage
      // away. Neither touches `group_members`, so without this wrapper the
      // delete would leave every derived membership behind on a Group that
      // no directory can ever correct again -- authority residue with no
      // remaining source, which is the state AZ-30's whole snapshot
      // discipline exists to prevent.
      //
      // The wrapper takes the provider advisory lock EXCLUSIVELY, which every
      // carriage and binding act holds SHARED, so a carriage insert in flight
      // and this delete cannot interleave at all. It recomputes AFTER the
      // delete, from the state the CASCADE and the trigger have left.
      await directoryCarriageService.withProviderRemoval(client, id, actor, async () => {
        await client.query('DELETE FROM identity_providers WHERE id = $1', [id]);
      });
      await auditService.record({
        action: 'identity_provider.delete',
        actor,
        resourceType: 'identity_provider',
        resourceId: id,
        metadata: { issuer: current.issuer },
      }, client);
      await client.query('COMMIT');
    } catch (error) {
      try { await client.query('ROLLBACK'); } catch { /* the transaction may already be closed */ }
      throw error;
    } finally {
      client.release();
    }
  }

  // ── SSO-R4: the login group whitelist ───────────────────────────────────
  //
  // Owner-plane configuration of WHO MAY AUTHENTICATE at this Identity
  // Identity provider. It confers no authority: an admitted Account holds
  // grants it already held, resolved by the same query-time membership join a
  // password login resolves (T-SS18). Every mutation is audited, because
  // changing the set changes who can reach the board at all.

  /** The Groups whose membership admits a federated login here, in board order. */
  async listLoginGroups(providerId: string): Promise<Array<{ groupId: string; groupName: string; addedAt: Date }>> {
    const result = await pool.query(
      `SELECT w.group_id, g.name AS group_name, w.added_at
         FROM identity_provider_login_groups w
         JOIN groups g ON g.id = w.group_id
        WHERE w.identity_provider_id = $1
        ORDER BY w.added_at`,
      [providerId],
    );
    return result.rows.map((row) => ({
      groupId: String(row.group_id),
      groupName: String(row.group_name),
      addedAt: row.added_at as Date,
    }));
  }

  async addLoginGroup(providerId: string, groupId: string, actor: AuditActor): Promise<void> {
    await this.require(providerId);
    const inserted = await pool.query(
      `INSERT INTO identity_provider_login_groups (identity_provider_id, group_id, added_by_principal_id)
       VALUES ($1, $2, $3)
       ON CONFLICT (identity_provider_id, group_id) DO NOTHING
       RETURNING group_id`,
      [providerId, groupId, actor.principalId ?? null],
    ).catch((error: unknown) => {
      // A whitelist entry naming a Group that does not exist would be a gate
      // that can never admit anyone — refused by name rather than as a 500.
      if (typeof error === 'object' && error !== null && (error as { code?: unknown }).code === '23503') {
        throw new IdentityProviderError('LOGIN_GROUP_NOT_FOUND', 'no such Group');
      }
      throw error;
    });
    // A repeated add is not an error — the requested state is the state — but
    // it is not audited as a change either, because nothing changed.
    if (inserted.rows.length === 0) return;
    await auditService.record({
      action: 'identity_provider.login_group_add',
      actor,
      resourceType: 'identity_provider',
      resourceId: providerId,
      metadata: { group_id: groupId },
    });
  }

  async removeLoginGroup(providerId: string, groupId: string, actor: AuditActor): Promise<void> {
    await this.require(providerId);
    const removed = await pool.query(
      `DELETE FROM identity_provider_login_groups
        WHERE identity_provider_id = $1 AND group_id = $2
        RETURNING group_id`,
      [providerId, groupId],
    );
    if (removed.rows.length === 0) {
      throw new IdentityProviderError('LOGIN_GROUP_NOT_LISTED', 'that Group does not gate login at this Identity provider');
    }
    await auditService.record({
      action: 'identity_provider.login_group_remove',
      actor,
      resourceType: 'identity_provider',
      resourceId: providerId,
      // Recorded because removing the LAST entry from an ENABLED whitelist
      // refuses every subsequent federated login (W3-D2's fail-closed arm),
      // and an operator reading the ledger should see that moment.
      metadata: { group_id: groupId },
    });
  }

  /** Health write-back after a discovery read. Recorded, never retried. */
  async recordDiscoveryHealth(id: string, ok: boolean, jwksRefreshed: boolean): Promise<void> {
    await pool.query(
      `UPDATE identity_providers
          SET last_discovery_at = now(),
              last_discovery_error_present = $2,
              jwks_refreshed_at = CASE WHEN $3 THEN now() ELSE jwks_refreshed_at END
        WHERE id = $1`,
      [id, !ok, jwksRefreshed],
    );
  }
}

function isUniqueViolation(error: unknown, constraint: string): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { code?: unknown }).code === '23505' &&
    String((error as { constraint?: unknown }).constraint ?? '').includes(constraint)
  );
}

export const identityProviderService = new IdentityProviderService();
