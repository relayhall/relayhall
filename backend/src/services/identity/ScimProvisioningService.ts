/**
 * ScimProvisioningService — the inbound SCIM 2.0 rung (RFC 7643/7644).
 *
 * Contract: design `d95136d7` §7.4 (SS-15 rung 2), vocabulary **A24**,
 * AUTHZ `4d961e37` **AZ-A4 clause 3**, sitting `5a7fd9af` **SSO-R7**, through
 * wave brief `4bbfe967` §2.1–§2.3. Candidate design record `c49e0037`.
 *
 * ── ONE ENDPOINT FAMILY, NO VENDOR BRANCHES ──
 *
 * §7.4 chose inbound SCIM over an outbound directory API precisely because, of
 * every Identity provider, "the endpoint is identical for every provider that
 * can reach it" — the ratified sentence, quoted as written. Nothing in
 * this file may key on a vendor: there is no provider name, no issuer
 * substring and no product switch anywhere in it, and `ssoVendorLiteralGate`
 * is the standing instrument that keeps it that way — this file and
 * `routes/scim.ts` are both inside its scan.
 *
 * Support for outbound SCIM is uneven across products, and §7.4 says so: for
 * one of them it is an extension rather than a core capability, and such a
 * deployment runs the login-time rung alone. That is a DEPLOYMENT-shaped
 * limitation, which is exactly why it must not appear here as code — and why
 * the product is not named here either.
 *
 * ── THE IDENTITY PROVIDER IS RESOLVED FROM THE CREDENTIAL, NOT THE URL ──
 *
 * A24 authorizes every act "scoped to its own Identity provider". A path
 * segment naming the provider would make that scoping value caller-supplied,
 * and the scoping would become one more authorization check over input. So the
 * binding lives on the provider row (`scim_client_principal_id`, migration
 * 106): the caller's principal resolves to at most ONE active provider, by a
 * partial unique index, and a caller that resolves to none is refused before
 * its body is read. This is the same structural device `ssoRedirectUri` uses
 * for T-SS13 — the value cannot be influenced because the influencing input is
 * not reachable from here.
 *
 * ── WHAT THIS RUNG WRITES, AND WHAT IT REFUSES TO ──
 *
 * It creates parentless HUMAN Accounts at the fixed minimal role and records
 * their provenance (candidate A). On a `directory`-mode Identity provider it
 * also writes the `expected` Identity link — the SS-22 vehicle, candidate B —
 * whose subject is the push's `externalId` by owner ruling `6bdcc16c` §1:
 * REQUIRED on such a push, refused by name when absent, and never inferred
 * from `userName` or an email (SS-20). Under `invited` or `jit` no link is
 * written: brief §2.4 rules that an Account "created by sync and carrying no
 * link yet" is NOT a binding, so nothing can authenticate as one of those
 * Accounts through this rung, and SS-20 is untouched.
 *
 * It carries the LIFECYCLE rung (candidate B): PUT, PATCH and DELETE on
 * `/Users/:id`. The two deprovision signals of design §7.5 — `active=false`
 * and removal from the provisioning scope (DELETE) — auto-disable the Account
 * by AZ-A4 clause 2 as amended 2026-09-01: reversible disable, never
 * terminate, the flag raised beside it, and the status written ONLY through
 * `PrincipalService.updatePrincipal` so the cached principal row is refreshed
 * in the same act (see `applyLifecycle`). Group-claim shrinkage is never a
 * deprovision signal (SS-13) — nothing in this file touches `group_members`,
 * and the suite asserts that no lifecycle act issues such a statement.
 *
 * It records the HEARTBEAT (SSO-R8, candidate B): every authenticated act on
 * the family is "a push received" for its Identity provider (`recordPush`).
 *
 * It refuses, rather than ignores, any attribute that would be an AUTHORITY
 * claim (`roles`, `entitlements`, `groups`, `password`, `id`). RFC 7644 §3.3
 * permits a server to ignore attributes it does not support, and this file
 * does ignore the merely-unmapped ones — but silently ignoring `roles` is how
 * an operator comes to believe the board honours directory roles, and SS-9
 * settles that it never does: "No external claim derives a board role in v1."
 * A refusal is the only answer that leaves the operator correctly informed.
 *
 * The role itself is not read from the body at all. It is the constant in
 * `accountProvisioning`, written by this file into the INSERT, so an elevated
 * Account is unrepresentable at the WRITE rather than filtered at the read —
 * the shape C2 paid four review rounds to learn.
 */
import { pool } from '../../db/connection';
import { auditService, type AuditActor } from '../AuditService';
import { principalService } from '../PrincipalService';
import { loginSessionService } from '../LoginSessionService';
import { identityProviderService, type IdentityProvider } from './IdentityProviderService';
import { identityLinkService } from './IdentityLinkService';
import { FIXED_MINIMAL_ACCOUNT_ROLE, normalizeAccountHandle } from './accountProvisioning';
import { ssoPublicApiUrl } from './ssoRedirectUri';
import { isRegistryConnector } from '../../utils/connectorRegistry';

/** RFC 7644 §3.12 error URN and the schema URNs this rung serves. */
export const SCIM_ERROR_SCHEMA = 'urn:ietf:params:scim:api:messages:2.0:Error';
export const SCIM_LIST_RESPONSE_SCHEMA = 'urn:ietf:params:scim:api:messages:2.0:ListResponse';
export const SCIM_USER_SCHEMA = 'urn:ietf:params:scim:schemas:core:2.0:User';

/** The mount path this rung is served at, in ONE place (the route census and
 *  `meta.location` both read it, so they cannot disagree). */
export const SCIM_BASE_PATH = '/scim/v2';

/** RFC 7644 §3.5.2 — the schema a PATCH message declares. */
export const SCIM_PATCH_OP_SCHEMA = 'urn:ietf:params:scim:api:messages:2.0:PatchOp';

/**
 * SSO-R8 / AZ-A4 clause 4: the `directory_sync_state` key under which an
 * Identity provider's SCIM pushes are watermarked. The bare Identity provider
 * id is the claim-sync key and keeps its meaning (owner ruling `6bdcc16c` §2);
 * the prefix is what makes the two producers two rows rather than one row
 * with two meanings.
 */
export const SCIM_HEARTBEAT_KEY_PREFIX = 'scim:';
export function scimHeartbeatKey(identityProviderId: string): string {
  return `${SCIM_HEARTBEAT_KEY_PREFIX}${identityProviderId}`;
}

/**
 * AZ-30 / design §7.5: the two ratified deprovision signals, and no third.
 * `inactive` = SCIM `active=false`; `removed` = removal from the provisioning
 * scope (DELETE). Migration 107's CHECK is the floor under this list.
 */
export const DEPROVISION_SIGNALS = ['inactive', 'removed'] as const;
export type DeprovisionSignal = (typeof DEPROVISION_SIGNALS)[number];

/**
 * A typed refusal carrying the RFC 7644 §3.12 triple.
 *
 * `scimType` is the protocol's own enumerated reason — `uniqueness`,
 * `invalidValue`, `invalidFilter`, `mutability` — and a conforming client
 * branches on it, so it is part of the contract rather than decoration.
 */
export class ScimError extends Error {
  constructor(
    public readonly status: number,
    public readonly scimType: string | null,
    message: string,
  ) {
    super(message);
    this.name = 'ScimError';
  }
}

/**
 * Attributes that are an AUTHORITY claim, refused rather than ignored.
 *
 * Enumerated, never a pattern: widening this set has to be a visible diff.
 * `id` and `meta` are server-assigned (RFC 7643 §3.1 makes both readOnly), and
 * a client that supplies them is asking to choose a resource identity.
 */
const REFUSED_USER_ATTRIBUTES = [
  'roles',
  'entitlements',
  'groups',
  'password',
  'id',
  'meta',
] as const;

/** The attributes this rung MAPS. Everything outside both sets is ignored per
 *  RFC 7644 §3.3, and the response echoes only what was honoured, so a client
 *  can see exactly which of its attributes survived. */
const MAPPED_USER_ATTRIBUTES = [
  'schemas', 'userName', 'externalId', 'name', 'displayName', 'emails', 'active',
] as const;

export interface ScimUserRecord {
  id: string;
  externalId: string | null;
  userName: string;
  displayName: string | null;
  email: string | null;
  active: boolean;
  /** The board's own status behind `active` — read by the lifecycle rung,
   *  never rendered: `terminated` is final (A17.10) and provisioning must
   *  know that, while a SCIM client only ever sees `active: false`. */
  principalStatus: 'active' | 'disabled' | 'terminated';
  /** The deprovision-detected flag (AZ-30), NULL when no signal stands. */
  deprovisionSignal: DeprovisionSignal | null;
  createdAt: Date;
  updatedAt: Date;
}

const SELECT_USER_COLUMNS = `
  d.account_principal_id AS id,
  d.external_id,
  d.user_name,
  d.deprovision_signal,
  d.created_at,
  d.updated_at,
  p.display_name,
  p.status,
  p.metadata`;

function mapUserRow(row: Record<string, unknown>): ScimUserRecord {
  const metadata = (row.metadata ?? {}) as Record<string, unknown>;
  const email = typeof metadata.email === 'string' && metadata.email !== '' ? metadata.email : null;
  const status = String(row.status);
  return {
    id: String(row.id),
    externalId: row.external_id === null || row.external_id === undefined ? null : String(row.external_id),
    userName: String(row.user_name),
    displayName: (row.display_name as string | null) ?? null,
    email,
    // RFC 7643 §4.1.1 `active` is the SCIM view of `principals.status`. Only
    // 'active' is active; 'disabled' and 'terminated' are both inactive, and
    // the difference between them is a board concept SCIM has no word for.
    active: status === 'active',
    principalStatus: status === 'active' || status === 'disabled' ? status : 'terminated',
    deprovisionSignal: row.deprovision_signal === 'inactive' || row.deprovision_signal === 'removed'
      ? row.deprovision_signal
      : null,
    createdAt: row.created_at as Date,
    updatedAt: row.updated_at as Date,
  };
}

function isUniqueViolation(error: unknown, constraint?: string): boolean {
  const code = (error as { code?: string } | null)?.code;
  if (code !== '23505') return false;
  if (!constraint) return true;
  return (error as { constraint?: string }).constraint === constraint;
}

function claimedString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
}

/**
 * RFC 7643 §4.1.2: `emails` is multi-valued. The primary one wins; failing
 * that the first entry carrying a value. Nothing here invents an address.
 */
function primaryEmail(value: unknown): string | null {
  if (!Array.isArray(value)) return null;
  const entries = value.filter((entry): entry is Record<string, unknown> =>
    Boolean(entry) && typeof entry === 'object' && !Array.isArray(entry));
  const primary = entries.find((entry) => entry.primary === true);
  return claimedString((primary ?? entries[0])?.value);
}

/** RFC 7643 §4.1.1: `displayName`, else the assembled `name.formatted`. */
function claimedDisplayName(body: Record<string, unknown>): string | null {
  const direct = claimedString(body.displayName);
  if (direct) return direct;
  const name = body.name;
  if (name && typeof name === 'object' && !Array.isArray(name)) {
    return claimedString((name as Record<string, unknown>).formatted);
  }
  return null;
}

/**
 * RFC 7643 §4.1.1 `active` is a boolean. A conforming client sends one; the
 * string forms `"true"` / `"false"` are also accepted, case-insensitively,
 * because a PATCH value travels as text in more than one shipped client and
 * refusing a deprovision signal over its spelling would leave an offboarded
 * person ENABLED — the failure direction AZ-A4 clause 2 exists to prevent.
 * Anything else is refused by name rather than coerced.
 */
function parseActive(value: unknown): boolean {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    const folded = value.trim().toLowerCase();
    if (folded === 'true') return true;
    if (folded === 'false') return false;
  }
  throw new ScimError(400, 'invalidValue', 'active must be a boolean (RFC 7643 §4.1.1)');
}

/**
 * The PATCH paths this rung honours, enumerated (RFC 7644 §3.5.2).
 *
 * `userName` and `externalId` are listed so a client re-sending the values
 * it already sent is not refused, and are then held to EQUALITY: the handle
 * was derived from the one at creation, and the other is the subject an
 * `expected` link records (SS-4) — neither is re-bindable through
 * provisioning. A filtered path (`emails[type eq "work"].value`) is not
 * honoured; the enumerated form is the whole grammar, for the reason
 * `parseUserFilter` gives.
 */
const PATCHABLE_PATHS = ['active', 'displayName', 'name', 'name.formatted', 'emails', 'userName', 'externalId'] as const;
const USER_SCHEMA_PATH_PREFIX = `${SCIM_USER_SCHEMA}:`;

function normalisePatchPath(raw: string): string {
  const trimmed = raw.trim();
  const unprefixed = trimmed.toLowerCase().startsWith(USER_SCHEMA_PATH_PREFIX.toLowerCase())
    ? trimmed.slice(USER_SCHEMA_PATH_PREFIX.length)
    : trimmed;
  const canonical = PATCHABLE_PATHS.find((candidate) => candidate.toLowerCase() === unprefixed.toLowerCase());
  return canonical ?? unprefixed;
}

/** What a PUT body or a PATCH operation set CLAIMS about a provisioned Account. */
interface ClaimedUserAttributes {
  userName?: string | null;
  externalId?: string | null;
  displayName?: string | null;
  email?: string | null;
  active?: boolean;
}

/** What actually changes, after the claims were held against the record. */
interface UserChanges {
  displayName?: string;
  email?: string | null;
  active?: boolean;
}

/**
 * The ONLY two filters this rung answers, enumerated.
 *
 * RFC 7644 §3.4.2.2 defines a whole filter grammar, and a partial
 * implementation of a grammar is worse than none: a client whose expression
 * silently matches the wrong subset gets a wrong answer rather than an error.
 * These two `eq` forms are the ones a provisioning client actually issues —
 * the pre-create existence check — and everything else is refused with the
 * protocol's own `invalidFilter`.
 */
const USER_NAME_FILTER = /^userName\s+eq\s+"((?:[^"\\]|\\.)*)"$/i;
const EXTERNAL_ID_FILTER = /^externalId\s+eq\s+"((?:[^"\\]|\\.)*)"$/i;

export interface ScimUserFilter {
  attribute: 'userName' | 'externalId';
  value: string;
}

export function parseUserFilter(filter: string): ScimUserFilter {
  const trimmed = filter.trim();
  const byUserName = USER_NAME_FILTER.exec(trimmed);
  if (byUserName) return { attribute: 'userName', value: byUserName[1].replace(/\\(.)/g, '$1') };
  const byExternalId = EXTERNAL_ID_FILTER.exec(trimmed);
  if (byExternalId) return { attribute: 'externalId', value: byExternalId[1].replace(/\\(.)/g, '$1') };
  throw new ScimError(
    400,
    'invalidFilter',
    'this endpoint answers `userName eq "..."` and `externalId eq "..."` only; no other filter expression is supported',
  );
}

/**
 * What `routes/scim` hands the resolver: the acting principal (the link the
 * credential authenticated AS) and the Account at the root of its live
 * delegation chain. Shape is decided by the route; the registry and the
 * binding are asked here.
 */
export interface ScimActingChain {
  actingPrincipalId: string;
  accountPrincipalId: string;
}

export class ScimProvisioningService {
  /**
   * The Identity provider this caller provisions for — or a refusal.
   *
   * Owner ruling `4ae7ce53` §1.2 — the actor rule is three conditions. The
   * chain shape (conditions 1 and 3's "parentless") arrives decided by
   * `routes/scim`; this method decides the two that need the database:
   *
   *   2. the acting principal is a Connector BY THE REGISTRY — a `services`
   *      row with kind='connector' names it. Asked through the ONE predicate
   *      in `utils/connectorRegistry`, never re-derived from principal
   *      columns, which is what three review rounds were spent on;
   *   3. the chain root is the BOUND parentless Account — the A24 scoping
   *      value, resolved from the caller's own chain.
   *
   * One refusal shape for every failed condition, deliberately: which of the
   * three a caller failed is not something this surface tells an
   * unauthorised credential.
   *
   * Note what is NOT consulted: the URL, any header, and the Identity provider's
   * `provisioning_mode`. Mode governs how a LOGIN binds (SS-22), which is a
   * different question from whether a directory may push: an
   * Identity provider in `jit` or `invited` mode may still be pushed to
   * (arrival and lifecycle happen; no expectation is written), and gating the family on
   * the mode would have made it unreachable before candidate C. The binding
   * IS the switch: an owner naming a SCIM client for an Identity provider is
   * the owner enabling SCIM for it — and, since migration 108, the
   * precondition for enabling `directory` mode at all.
   */
  async resolveProviderForClient(chain: ScimActingChain | null): Promise<IdentityProvider> {
    const refusal = () => new ScimError(
      403,
      null,
      'this credential is not the SCIM client of any enabled Identity provider',
    );
    if (!chain) throw refusal();
    if (!(await isRegistryConnector(pool, chain.actingPrincipalId))) throw refusal();
    const provider = await identityProviderService.findByScimClientPrincipal(chain.accountPrincipalId);
    if (!provider) throw refusal();
    return provider;
  }

  /**
   * Create a parentless human Account at the fixed minimal role (AZ-A4
   * clause 3), and record its provenance — in ONE transaction.
   *
   * The transaction is load-bearing rather than tidy: the provenance row is
   * what A24's read boundary is decided by, so an Account that committed
   * without one would be a person on the board whom the directory that created
   * them can neither see nor reconcile, and whom nothing else knows the origin
   * of either.
   */
  async createUser(
    provider: IdentityProvider,
    actor: AuditActor,
    body: Record<string, unknown>,
  ): Promise<ScimUserRecord> {
    const refused = REFUSED_USER_ATTRIBUTES.filter((attribute) => body[attribute] !== undefined);
    if (refused.length > 0) {
      throw new ScimError(
        400,
        'invalidValue',
        `this endpoint provisions Accounts at a fixed minimal role and assigns no authority: ${refused.join(', ')} ${refused.length === 1 ? 'is' : 'are'} not accepted (A24; SS-9: no external claim derives a board role in v1)`,
      );
    }

    const userName = claimedString(body.userName);
    if (!userName) {
      throw new ScimError(400, 'invalidValue', 'userName is required (RFC 7643 §4.1.1)');
    }
    if (Buffer.byteLength(userName, 'utf8') > 255) {
      throw new ScimError(400, 'invalidValue', 'userName exceeds 255 bytes');
    }
    if (body.active !== undefined && body.active !== true) {
      // Deprovisioning is the lifecycle rung's act and carries AZ-A4 clause 2's
      // named mechanism with it. Creating an already-inactive Account here
      // would be that clause implemented by half a wave, so it is refused
      // rather than silently created-then-ignored.
      throw new ScimError(
        400,
        'invalidValue',
        'an Account is provisioned active; the lifecycle attribute is not settable at creation',
      );
    }

    const handle = normalizeAccountHandle(userName);
    if (handle === '') {
      throw new ScimError(
        400,
        'invalidValue',
        'userName contains no characters usable in a board handle; a substitute is not invented for it',
      );
    }

    const externalId = claimedString(body.externalId);
    if (externalId && Buffer.byteLength(externalId, 'utf8') > 255) {
      throw new ScimError(400, 'invalidValue', 'externalId exceeds 255 bytes');
    }
    // Owner ruling 6bdcc16c §1: on a directory-mode Identity provider the
    // `expected` link's subject IS `externalId`, so a push without one has no
    // subject to expect and is refused BY NAME. The subject is never derived
    // from `userName` or an email (SS-20): those are claim strings, and an
    // expectation keyed on a claim string would be the round-4 F3 defect with
    // the push's handle field standing in for the claim. Whether the
    // Identity provider's subject mode actually emits this value is a
    // documented operator requirement the estate script meets, not a fallback
    // this file supplies.
    if (provider.provisioningMode === 'directory' && !externalId) {
      throw new ScimError(
        400,
        'invalidValue',
        'externalId is required: this Identity provider provisions in directory mode, and the expected Identity link records externalId as the subject the first login must present (SS-4, SS-22); it is never derived from userName or an email (SS-20)',
      );
    }
    const displayName = claimedDisplayName(body);
    const email = primaryEmail(body.emails);

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const created = await principalService.createPrincipal(
        {
          handle,
          kind: 'human',
          displayName: displayName ?? handle,
          role: FIXED_MINIMAL_ACCOUNT_ROLE,
        },
        client,
      );
      if (!created) {
        await client.query('ROLLBACK');
        // Brief §2.3: "two people sharing a handle is an operator decision, not
        // a rounding error". No suffix is appended and no existing Account is
        // adopted — adopting one would be SS-20's forbidden claim-string match
        // with `userName` standing in for the claim.
        await this.auditRefusal(actor, provider, 'handle_collision', { userName, handle });
        throw new ScimError(
          409,
          'uniqueness',
          'that userName maps to a handle already in use; the collision is refused rather than suffixed, and resolving it is an operator decision',
        );
      }
      if (email) {
        await client.query(
          `UPDATE principals
              SET metadata = metadata || jsonb_build_object('email', $2::text), updated_at = now()
            WHERE id = $1`,
          [created.id, email],
        );
      }
      await client.query(
        `INSERT INTO directory_provisioned_accounts
           (account_principal_id, identity_provider_id, external_id, user_name, provisioned_by_principal_id)
         VALUES ($1, $2, $3, $4, $5)`,
        [created.id, provider.id, externalId, userName, actor.principalId ?? null],
      );
      // SS-22 / SS-24: the expectation, IN the same transaction as the
      // Account it names. Written only under `directory` mode — under
      // `invited` or `jit` the login path binds by invitation or provisions
      // just-in-time, and an expectation written beside those would be a
      // second binding vehicle nobody ratified. `externalId` is non-null
      // here by the refusal above; the type narrows it explicitly rather
      // than trusting the order of two statements.
      let expectedLinkId: string | null = null;
      if (provider.provisioningMode === 'directory' && externalId !== null) {
        const expected = await identityLinkService.establishExpected(
          {
            accountPrincipalId: created.id,
            identityProviderId: provider.id,
            subject: externalId,
            establishedByPrincipalId: actor.principalId ?? null,
          },
          client,
        );
        expectedLinkId = expected.id;
      }
      // A24: every act is audited — IN the transaction, so an Account that
      // exists without a ledger row is unrepresentable rather than merely
      // unlikely, and a ledger failure refuses the act instead of reporting
      // a 500 for one that already happened.
      await auditService.record({
        action: 'directory.account.provision',
        actor,
        resourceType: 'principal',
        resourceId: created.id,
        metadata: {
          identity_provider_id: provider.id,
          user_name: userName,
          external_id: externalId,
          handle,
          role: FIXED_MINIMAL_ACCOUNT_ROLE,
          provisioning_mode: provider.provisioningMode,
          expected_link_id: expectedLinkId,
        },
      }, client);
      await client.query('COMMIT');

      const record = await this.getUser(provider, created.id);
      if (!record) {
        // Unreachable: the row committed a statement ago. Stated rather than
        // returned as a partially-assembled resource.
        throw new ScimError(500, null, 'the provisioned Account could not be read back');
      }
      return record;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      if (error instanceof ScimError) throw error;
      if (isUniqueViolation(error, 'ux_directory_provisioned_accounts_user_name')) {
        await this.auditRefusal(actor, provider, 'user_name_already_provisioned', { userName });
        throw new ScimError(409, 'uniqueness', 'this Identity provider has already provisioned that userName');
      }
      if (isUniqueViolation(error, 'ux_directory_provisioned_accounts_external_id')) {
        await this.auditRefusal(actor, provider, 'external_id_already_provisioned', { externalId });
        throw new ScimError(409, 'uniqueness', 'this Identity provider has already provisioned that externalId');
      }
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * One provisioned Account — scoped to the Identity provider that provisioned
   * it.
   *
   * The Identity provider predicate is in the WHERE clause and not a
   * post-filter: an
   * Account this provider did not provision is INVISIBLE, which is A24's
   * "no read beyond provisioning reconciliation" enforced rather than
   * described. The owner's own Account is not addressable here at all.
   */
  async getUser(provider: IdentityProvider, accountPrincipalId: string): Promise<ScimUserRecord | undefined> {
    // A malformed id is a miss, not a 500: SCIM resource ids are opaque to the
    // client, so a client that has one at all got it from us.
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(accountPrincipalId)) {
      return undefined;
    }
    const result = await pool.query(
      `SELECT ${SELECT_USER_COLUMNS}
         FROM directory_provisioned_accounts d
         JOIN principals p ON p.id = d.account_principal_id
        WHERE d.account_principal_id = $1 AND d.identity_provider_id = $2`,
      [accountPrincipalId, provider.id],
    );
    return result.rows[0] ? mapUserRow(result.rows[0]) : undefined;
  }

  /** A page of this Identity provider's own provisioned Accounts, filtered. */
  async listUsers(
    provider: IdentityProvider,
    options: { filter?: ScimUserFilter; startIndex: number; count: number },
  ): Promise<{ resources: ScimUserRecord[]; totalResults: number }> {
    const params: unknown[] = [provider.id];
    let predicate = 'd.identity_provider_id = $1';
    if (options.filter?.attribute === 'userName') {
      params.push(options.filter.value);
      predicate += ` AND d.user_name = $${params.length}`;
    } else if (options.filter?.attribute === 'externalId') {
      params.push(options.filter.value);
      predicate += ` AND d.external_id = $${params.length}`;
    }

    const total = await pool.query(
      `SELECT COUNT(*)::int AS total FROM directory_provisioned_accounts d WHERE ${predicate}`,
      params,
    );
    // RFC 7644 §3.4.2.4: `count=0` asks for the TOTAL and no resources. The
    // page query is skipped rather than issued with LIMIT 0 — there is no
    // page to fetch, and a query that cannot return rows should not run.
    if (options.count === 0) {
      return { resources: [], totalResults: Number(total.rows[0]?.total ?? 0) };
    }
    const page = await pool.query(
      `SELECT ${SELECT_USER_COLUMNS}
         FROM directory_provisioned_accounts d
         JOIN principals p ON p.id = d.account_principal_id
        WHERE ${predicate}
        ORDER BY d.created_at, d.account_principal_id
        LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, options.count, Math.max(options.startIndex - 1, 0)],
    );
    return {
      resources: page.rows.map(mapUserRow),
      totalResults: Number(total.rows[0]?.total ?? 0),
    };
  }

  // ── The lifecycle rung (candidate B): PUT, PATCH, DELETE ──────────────────

  /** RFC 7644 §3.5.1 — replace. */
  async replaceUser(
    provider: IdentityProvider,
    actor: AuditActor,
    accountPrincipalId: string,
    body: Record<string, unknown>,
  ): Promise<ScimUserRecord> {
    const record = await this.requireUser(provider, accountPrincipalId);
    // RFC 7644 §3.5.1: a PUT carries the resource as the client last READ it,
    // `id` and `meta` included — readOnly attributes the receiving side MUST
    // ignore on replace, and every shipped client sends them back. Found by
    // the first live push from the estate Identity provider: its PUT carried
    // the `id` it had been given and was refused as a client "choosing a
    // resource identity". An `id` naming ANOTHER resource is not ignorable —
    // that IS a client asking to re-identify — and is refused as `mutability`.
    const { id: bodyId, meta: _meta, ...attributes } = body;
    if (bodyId !== undefined && String(bodyId) !== record.id) {
      throw new ScimError(400, 'mutability', 'id is readOnly and names this resource; a body naming a different id is refused');
    }
    this.refuseAuthorityAttributes(attributes);
    const userName = claimedString(attributes.userName);
    if (!userName) {
      throw new ScimError(400, 'invalidValue', 'userName is required (RFC 7643 §4.1.1)');
    }
    // An attribute the body does not carry is left as it is. RFC 7644 §3.5.1
    // lets the receiving side treat attributes it owns that way, and the
    // alternative — reading absence as "remove the email" — would let a
    // client that sends only the attributes it manages strip the ones it
    // does not.
    const changes = this.changesAgainst(record, {
      userName,
      externalId: attributes.externalId === undefined ? undefined : claimedString(attributes.externalId),
      displayName: claimedDisplayName(attributes),
      email: attributes.emails === undefined ? undefined : primaryEmail(attributes.emails),
      active: attributes.active === undefined ? undefined : parseActive(attributes.active),
    });
    return this.applyChanges(provider, actor, record, changes, 'inactive');
  }

  /**
   * RFC 7644 §3.5.2 — PATCH, over the enumerated paths.
   *
   * `add` and `replace` are honoured (they mean the same thing for a
   * single-valued attribute the server already holds); `remove` is refused
   * by name, because the only removal this rung has a meaning for is
   * removal from the provisioning scope, and that is DELETE.
   */
  async patchUser(
    provider: IdentityProvider,
    actor: AuditActor,
    accountPrincipalId: string,
    body: Record<string, unknown>,
  ): Promise<ScimUserRecord> {
    const record = await this.requireUser(provider, accountPrincipalId);
    const schemas = Array.isArray(body.schemas) ? body.schemas : [];
    if (!schemas.includes(SCIM_PATCH_OP_SCHEMA)) {
      throw new ScimError(400, 'invalidValue', `a PATCH body declares schemas [${SCIM_PATCH_OP_SCHEMA}] (RFC 7644 §3.5.2)`);
    }
    const operations = body.Operations;
    if (!Array.isArray(operations) || operations.length === 0) {
      throw new ScimError(400, 'invalidValue', 'Operations must be a non-empty array (RFC 7644 §3.5.2)');
    }
    const claimed: ClaimedUserAttributes = {};
    for (const raw of operations) {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
        throw new ScimError(400, 'invalidValue', 'each operation is an object carrying op, and path or value');
      }
      const operation = raw as Record<string, unknown>;
      const op = typeof operation.op === 'string' ? operation.op.trim().toLowerCase() : '';
      if (op !== 'add' && op !== 'replace') {
        throw new ScimError(
          400,
          'invalidValue',
          `op "${String(operation.op)}" is not honoured here: the lifecycle is driven by active, and removal from the provisioning scope is DELETE`,
        );
      }
      if (operation.path === undefined) {
        const value = operation.value;
        if (!value || typeof value !== 'object' || Array.isArray(value)) {
          throw new ScimError(400, 'invalidValue', 'an operation without a path carries an object value');
        }
        const attributes = value as Record<string, unknown>;
        this.refuseAuthorityAttributes(attributes);
        if (attributes.userName !== undefined) claimed.userName = claimedString(attributes.userName);
        if (attributes.externalId !== undefined) claimed.externalId = claimedString(attributes.externalId);
        const displayName = claimedDisplayName(attributes);
        if (displayName !== null) claimed.displayName = displayName;
        if (attributes.emails !== undefined) claimed.email = primaryEmail(attributes.emails);
        if (attributes.active !== undefined) claimed.active = parseActive(attributes.active);
        continue;
      }
      if (typeof operation.path !== 'string') {
        throw new ScimError(400, 'invalidPath', 'path must be a string');
      }
      const path = normalisePatchPath(operation.path);
      switch (path) {
        case 'active':
          claimed.active = parseActive(operation.value);
          break;
        case 'displayName':
        case 'name.formatted':
          claimed.displayName = claimedString(operation.value);
          break;
        case 'name':
          claimed.displayName = claimedDisplayName({ name: operation.value });
          break;
        case 'emails':
          claimed.email = primaryEmail(operation.value);
          break;
        case 'userName':
          claimed.userName = claimedString(operation.value);
          break;
        case 'externalId':
          claimed.externalId = claimedString(operation.value);
          break;
        default:
          // An authority attribute addressed by path is refused with the same
          // sentence as one carried in a body; everything else is a path this
          // endpoint does not map, and a client is told so rather than having
          // its operation silently dropped.
          this.refuseAuthorityAttributes({ [path]: operation.value });
          throw new ScimError(
            400,
            'invalidPath',
            `path "${operation.path}" is not one this endpoint honours; it maps ${PATCHABLE_PATHS.join(', ')}`,
          );
      }
    }
    const changes = this.changesAgainst(record, claimed);
    return this.applyChanges(provider, actor, record, changes, 'inactive');
  }

  /**
   * RFC 7644 §3.6 — DELETE is the second deprovision signal of design §7.5:
   * "removal from the provisioning scope". The Account is disabled, never
   * deleted and never terminated, and its provenance row STAYS, so the same
   * Identity provider can still see it (`active: false`, flag `removed`),
   * find it by filter, and re-enable it with `active=true` when the person
   * returns to scope. That is a declared departure from §3.6's "SHALL return
   * 404" for a subsequent GET, and it is deliberate: a board Account is not a
   * resource the directory owns outright, and a client whose lookup 404s
   * would POST again into the uniqueness refusal.
   */
  async deleteUser(provider: IdentityProvider, actor: AuditActor, accountPrincipalId: string): Promise<void> {
    const record = await this.requireUser(provider, accountPrincipalId);
    await this.applyChanges(provider, actor, record, { active: false }, 'removed');
  }

  /**
   * SSO-R8 / AZ-A4 clause 4 — "last push received".
   *
   * Called for EVERY authenticated act on the family, reads included: an
   * Identity provider reconciling by `GET /Users?filter=` is alive and
   * pushing exactly as one sending POST is, and the alarm this feeds exists
   * to detect a directory that has gone SILENT, not one with nothing new to
   * say (design §7.4, question 3). Nothing is written when the
   * Identity provider carries no interval — NULL means claim-sync semantics
   * (owner ruling `6bdcc16c` §2), and a row under the push key for such an
   * Identity provider would be a watermark the alarm reads against a
   * threshold nobody set.
   *
   * The interval is copied into the row's `staleness_threshold_hours` on
   * every push, so the existing AZ-30 read (`GroupService.syncStatus`)
   * raises the alarm with no new arm: silence past the interval, on the
   * board's own clock. `last_error_present` is cleared for the same reason a
   * claim-sync success clears it — a push that authenticated and resolved
   * IS a success.
   */
  async recordPush(provider: IdentityProvider): Promise<void> {
    if (provider.scimHeartbeatIntervalHours === null) return;
    await pool.query(
      `INSERT INTO directory_sync_state
         (provider, last_success_at, last_attempt_at, last_error_present, staleness_threshold_hours)
       VALUES ($1, now(), now(), FALSE, $2)
       ON CONFLICT (provider) DO UPDATE
         SET last_success_at = now(), last_attempt_at = now(), last_error_present = FALSE,
             staleness_threshold_hours = EXCLUDED.staleness_threshold_hours`,
      [scimHeartbeatKey(provider.id), provider.scimHeartbeatIntervalHours],
    );
  }

  private async requireUser(provider: IdentityProvider, accountPrincipalId: string): Promise<ScimUserRecord> {
    const record = await this.getUser(provider, accountPrincipalId);
    if (!record) {
      // A24's read boundary, on the write side: an Account this
      // Identity provider did not provision is indistinguishable from one
      // that does not exist, so it can be neither read nor changed from here.
      throw new ScimError(404, null, 'no such provisioned Account');
    }
    return record;
  }

  /** The same refusal `createUser` makes, for the same attributes. */
  private refuseAuthorityAttributes(body: Record<string, unknown>): void {
    const refused = REFUSED_USER_ATTRIBUTES.filter((attribute) => body[attribute] !== undefined);
    if (refused.length > 0) {
      throw new ScimError(
        400,
        'invalidValue',
        `this endpoint provisions Accounts at a fixed minimal role and assigns no authority: ${refused.join(', ')} ${refused.length === 1 ? 'is' : 'are'} not accepted (A24; SS-9: no external claim derives a board role in v1)`,
      );
    }
  }

  /**
   * Hold the claims against the record and keep only what CHANGES.
   *
   * `userName` and `externalId` are held to equality and refused with the
   * protocol's own `mutability`: the handle was derived from the userName at
   * creation, and the externalId is the subject an `expected` link records
   * (SS-4). Re-binding either through provisioning would be a rename or a
   * re-keying nobody ratified; both are operator decisions on the board.
   */
  private changesAgainst(record: ScimUserRecord, claimed: ClaimedUserAttributes): UserChanges {
    if (claimed.userName !== undefined && claimed.userName !== record.userName) {
      throw new ScimError(
        400,
        'mutability',
        'userName is not re-bindable through provisioning: the board handle was derived from it at creation, and renaming an Account is an operator decision',
      );
    }
    if (claimed.externalId !== undefined && claimed.externalId !== null && claimed.externalId !== record.externalId) {
      throw new ScimError(
        400,
        'mutability',
        'externalId is not re-bindable through provisioning: it is the subject the expected Identity link records (SS-4), and re-keying a person is an operator decision',
      );
    }
    const changes: UserChanges = {};
    if (claimed.displayName !== undefined && claimed.displayName !== null && claimed.displayName !== record.displayName) {
      changes.displayName = claimed.displayName;
    }
    if (claimed.email !== undefined && claimed.email !== record.email) {
      changes.email = claimed.email;
    }
    if (claimed.active !== undefined) changes.active = claimed.active;
    return changes;
  }

  private async applyChanges(
    provider: IdentityProvider,
    actor: AuditActor,
    record: ScimUserRecord,
    changes: UserChanges,
    signal: DeprovisionSignal,
  ): Promise<ScimUserRecord> {
    if (changes.displayName !== undefined || changes.email !== undefined) {
      if (changes.displayName !== undefined) {
        await principalService.updatePrincipal(record.id, { displayName: changes.displayName });
      }
      if (changes.email !== undefined) {
        await pool.query(
          changes.email === null
            ? `UPDATE principals SET metadata = metadata - 'email', updated_at = now() WHERE id = $1`
            : `UPDATE principals
                  SET metadata = metadata || jsonb_build_object('email', $2::text), updated_at = now()
                WHERE id = $1`,
          changes.email === null ? [record.id] : [record.id, changes.email],
        );
      }
      await pool.query(
        'UPDATE directory_provisioned_accounts SET updated_at = now() WHERE account_principal_id = $1 AND identity_provider_id = $2',
        [record.id, provider.id],
      );
      await auditService.record({
        action: 'directory.account.update',
        actor,
        resourceType: 'principal',
        resourceId: record.id,
        metadata: {
          identity_provider_id: provider.id,
          display_name_changed: changes.displayName !== undefined,
          email_changed: changes.email !== undefined,
        },
      });
    }
    if (changes.active !== undefined) {
      await this.applyLifecycle(provider, actor, record, changes.active, signal);
    }
    const updated = await this.getUser(provider, record.id);
    if (!updated) {
      throw new ScimError(500, null, 'the provisioned Account could not be read back');
    }
    return updated;
  }

  /**
   * AZ-A4 clause 2 (amended 2026-09-01) — the auto-disable, and its reverse.
   *
   * ── THE MECHANISM IS THE CLAUSE ──
   *
   * The status is written through `PrincipalService.updatePrincipal` and
   * through NOTHING ELSE. That helper refreshes the cached principal row in
   * the same act, which is the clause's second half: "a status write must
   * also clear the cached principal row, so that an open dashboard
   * login session ends on its next request instead of surviving to the
   * read-cache TTL". A bulk deprovision is exactly the writer most tempted to issue
   * `UPDATE principals SET status` over many rows and skip the cache — brief
   * §2.6 names this path — so this file issues no status statement of its
   * own, and the suite asserts that it does not. The `rh_` plane needs no
   * help: it reads status in the statement that resolves the key, and the
   * delegation-chain liveness check reads every ancestor's status live, so a
   * disabled Account's Connector keys fail on the very next request by
   * construction.
   *
   * Login sessions are revoked as well, with `disabled_user`, so the
   * retained ID token (SSO-R16) is disposed with them rather than kept alive
   * on a login session that can no longer resolve.
   *
   * ── REVERSIBLE, NEVER TERMINATE ──
   *
   * `updatePrincipal`'s status parameter admits `active | disabled` and no
   * third value, so terminate is unrepresentable on this path rather than
   * avoided. A terminated Account (A17.10, final by migration 096's trigger)
   * reads as `active: false` and cannot be re-enabled from here.
   *
   * ── WHO MAY RE-ENABLE ──
   *
   * `active=true` re-enables an Account ONLY when the directory's own signal
   * disabled it (the flag stands). An Account disabled on the board by an
   * owner-plane act carries no flag, and the directory saying `active=true`
   * about it is refused by name: AZ-30's "flag, human acts" still governs
   * every signal that is not one of the two ratified ones, and a local
   * disable is a human act the directory does not get to reverse — the same
   * "local rows survive" instinct as T-SS14. The inverse holds too: an
   * inactive signal on an Account already disabled locally raises the flag
   * without a status write, so the Access manager sees both facts.
   */
  private async applyLifecycle(
    provider: IdentityProvider,
    actor: AuditActor,
    record: ScimUserRecord,
    active: boolean,
    signal: DeprovisionSignal,
  ): Promise<void> {
    if (record.principalStatus === 'terminated') {
      if (!active) return;
      throw new ScimError(
        400,
        'mutability',
        'this Account is terminated on the board (A17.10), which is final; provisioning cannot re-enable it',
      );
    }

    if (!active) {
      if (record.principalStatus === 'active') {
        const disabled = await principalService.updatePrincipal(record.id, { status: 'disabled' });
        if (!disabled) throw new ScimError(500, null, 'the Account could not be disabled');
        const sessionsRevoked = await loginSessionService.revokeAllForPrincipal(record.id, 'disabled_user');
        await this.writeFlag(provider, actor, record, signal, {
          status_before: 'active',
          status_after: 'disabled',
          login_sessions_revoked: sessionsRevoked,
        });
        return;
      }
      if (record.deprovisionSignal === null) {
        await this.writeFlag(provider, actor, record, signal, {
          status_before: 'disabled',
          status_after: 'disabled',
          disabled_on_the_board_already: true,
        });
      }
      return;
    }

    if (record.principalStatus === 'active') {
      if (record.deprovisionSignal !== null) await this.clearFlag(provider, actor, record, { status_before: 'active' });
      return;
    }
    if (record.deprovisionSignal === null) {
      throw new ScimError(
        400,
        'mutability',
        'this Account was disabled on the board, not by the directory; re-enabling it is an operator decision (AZ-30: flag, human acts)',
      );
    }
    const enabled = await principalService.updatePrincipal(record.id, { status: 'active' });
    if (!enabled) throw new ScimError(500, null, 'the Account could not be re-enabled');
    await this.clearFlag(provider, actor, record, { status_before: 'disabled' });
  }

  /** Raise the deprovision-detected flag and audit the signal — one transaction. */
  private async writeFlag(
    provider: IdentityProvider,
    actor: AuditActor,
    record: ScimUserRecord,
    signal: DeprovisionSignal,
    metadata: Record<string, unknown>,
  ): Promise<void> {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `UPDATE directory_provisioned_accounts
            SET deprovision_signal = $3, deprovisioned_at = now(), updated_at = now()
          WHERE account_principal_id = $1 AND identity_provider_id = $2`,
        [record.id, provider.id, signal],
      );
      await auditService.record({
        action: 'directory.account.deprovision',
        actor,
        resourceType: 'principal',
        resourceId: record.id,
        metadata: { identity_provider_id: provider.id, signal, ...metadata },
      }, client);
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  /** Clear the flag on the reverse signal and audit it — one transaction. */
  private async clearFlag(
    provider: IdentityProvider,
    actor: AuditActor,
    record: ScimUserRecord,
    metadata: Record<string, unknown>,
  ): Promise<void> {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `UPDATE directory_provisioned_accounts
            SET deprovision_signal = NULL, deprovisioned_at = NULL, updated_at = now()
          WHERE account_principal_id = $1 AND identity_provider_id = $2`,
        [record.id, provider.id],
      );
      await auditService.record({
        action: 'directory.account.reactivate',
        actor,
        resourceType: 'principal',
        resourceId: record.id,
        metadata: {
          identity_provider_id: provider.id,
          cleared_signal: record.deprovisionSignal,
          status_after: 'active',
          ...metadata,
        },
      }, client);
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  /** Every act is audited (A24), and a REFUSED act is an act. */
  private async auditRefusal(
    actor: AuditActor,
    provider: IdentityProvider,
    reason: string,
    metadata: Record<string, unknown>,
  ): Promise<void> {
    await auditService.record({
      action: 'directory.account.provision',
      actor,
      outcome: 'denied',
      resourceType: 'principal',
      metadata: { identity_provider_id: provider.id, refusal: reason, ...metadata },
    }).catch(() => undefined);
  }
}

/**
 * `meta.location` for a provisioned resource, or null.
 *
 * Built from the DECLARED public origin and from nothing else — the same
 * structural rule `ssoRedirectUri` enforces for T-SS13, and for the same
 * reason: a `Host`-derived location in a SCIM response tells the Identity
 * Identity provider to address whatever origin the last caller claimed. A deployment
 * that has not declared its origin gets NO location rather than a guessed one;
 * RFC 7643 §3.1 lets `meta` sub-attributes be absent, and inventing this one
 * would be the W2 defect (`Host` fallback on a security path) repeated.
 */
export function scimResourceLocation(accountPrincipalId: string): string | null {
  try {
    return `${ssoPublicApiUrl()}${SCIM_BASE_PATH}/Users/${accountPrincipalId}`;
  } catch {
    return null;
  }
}

/** RFC 7643 §3.1 — the resource as a conforming client reads it. */
export function scimUserResource(record: ScimUserRecord): Record<string, unknown> {
  const location = scimResourceLocation(record.id);
  const resource: Record<string, unknown> = {
    schemas: [SCIM_USER_SCHEMA],
    id: record.id,
    userName: record.userName,
    active: record.active,
    meta: {
      resourceType: 'User',
      created: record.createdAt.toISOString(),
      lastModified: record.updatedAt.toISOString(),
      ...(location ? { location } : {}),
    },
  };
  if (record.externalId) resource.externalId = record.externalId;
  if (record.displayName) resource.displayName = record.displayName;
  if (record.email) resource.emails = [{ value: record.email, primary: true }];
  return resource;
}

/** Exported for the attribute census: the two enumerated sets, as data. */
export const SCIM_USER_ATTRIBUTE_POLICY = {
  refused: REFUSED_USER_ATTRIBUTES,
  mapped: MAPPED_USER_ATTRIBUTES,
} as const;

export const scimProvisioningService = new ScimProvisioningService();
