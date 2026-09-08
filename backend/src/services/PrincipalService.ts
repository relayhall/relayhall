// PrincipalService.ts — identity anchor resolution, spawn principals, and
// rh_ credential validation/issuance (epic 60558599, spec b48bb799 §2/§3; prefix per A13.1).
//
// Pre-migration tolerance is a hard contract here: this code deploys BEFORE
// migrations 062/063 apply in production, so every lookup degrades to legacy
// behaviour on undefined_table/undefined_column instead of crashing or 500ing.
import crypto from 'crypto';
import { pool } from '../db/connection';
import { presenceWriter } from '../db/boundedPresenceWrites';
import type { PoolClient } from 'pg';
import { auditService, type AuditActor } from './AuditService';
import { encryptCredentialSecret } from '../utils/credentialCrypto';
import { evaluateCredentialAcceptance, isUsableBearerKeyMaterial } from '../utils/credentialAcceptance';
import { auditChainFor } from '../utils/auditChain';
import { invalidateApprovalsForCredentials } from '../utils/approvalInvalidation';

export interface Principal {
  id: string;
  kind: 'human' | 'agent' | 'service';
  handle: string;
  displayName: string | null;
  status: 'active' | 'disabled' | 'terminated';
  role: string | null;
  boundTaskId: string | null;
  purpose: string | null;
  legacyIdentity: boolean;
  ownExpression: unknown | null;
  sourceTag: string | null;
  harness: string | null;
  personalityId: string | null;
  parentPrincipalId: string | null;
  lastSeenAt: string | null;
  metadata: Record<string, unknown>;
}

export interface PrincipalCredential {
  id: string;
  principalId: string;
  credentialType: string;
  keyId: string | null;
  scopes: string[];
  expiresAt: string | null;
  revokedAt: string | null;
  transport: 'any' | 'mcp' | 'api';
  graceUntil: string | null;
  metadata: Record<string, unknown>;
}

/**
 * THE NAME OF THE `root` REFUSAL, so the two doors onto it cannot drift.
 *
 * `issueCredential` below refuses a `root` scope request outright (§5.2 rule 2
 * / AZ-18), and `routes/services.ts` refuses the same request one step EARLIER
 * so that a refused Connector registration writes nothing at all (card
 * 6e25ae48). Two doors onto one rule is deliberate and is the shape the role
 * act next door already uses; two spellings of the code would not be, because
 * the wizard enumerates the codes it can explain and an unrecognised one falls
 * back to the generic sentence. Both doors import this constant.
 */
export const ROOT_NOT_MINTABLE = 'ROOT_NOT_MINTABLE';

/** Typed refusals for the §5.2/§7 credential policy (AZ-S3). */
export class CredentialPolicyError extends Error {
  constructor(public readonly status: number, public readonly code: string, message: string) {
    super(message);
    this.name = 'CredentialPolicyError';
  }
}

export interface PrincipalKeyParts {
  env: 'live' | 'dev';
  keyId: string;
  secret: string;
}

/** Postgres error codes the pre-migration tolerance contract keys on. */
export function isMissingRelationError(err: unknown): boolean {
  return Boolean(err && typeof err === 'object' && (err as { code?: string }).code === '42P01');
}
export function isMissingColumnError(err: unknown): boolean {
  return Boolean(err && typeof err === 'object' && (err as { code?: string }).code === '42703');
}

const CACHE_TTL_MS = 60_000;

/** Expected rh_ env prefix for this deployment (distinct DBs + JWT secrets per env already). */
export function expectedKeyEnv(): 'live' | 'dev' {
  return process.env.NODE_ENV === 'production' ? 'live' : 'dev';
}

/**
 * Parse `rh_(live|dev)_<key_id>.<secret>`. Returns null for anything that is
 * not structurally an rh_ key; callers reject with the generic invalid-token
 * 401 so the response is indistinguishable from any other bad bearer value.
 */
export function parsePrincipalKey(token: string): PrincipalKeyParts | null {
  const match = /^rh_(live|dev)_([A-Za-z0-9]{6,64})\.([A-Za-z0-9_-]{20,128})$/.exec(token);
  if (!match) return null;
  return { env: match[1] as 'live' | 'dev', keyId: match[2], secret: match[3] };
}

export function sha256Hex(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function rowToPrincipal(row: Record<string, unknown>): Principal {
  return {
    id: String(row.id),
    kind: row.kind as Principal['kind'],
    handle: String(row.handle),
    displayName: (row.display_name as string | null) ?? null,
    status: row.status as Principal['status'],
    role: (row.role as string | null) ?? null,
    sourceTag: (row.source_tag as string | null) ?? null,
    harness: (row.harness as string | null) ?? null,
    personalityId: (row.personality_id as string | null) ?? null,
    parentPrincipalId: (row.parent_principal_id as string | null) ?? null,
    boundTaskId: (row.bound_task_id as string | null) ?? null,
    purpose: (row.purpose as string | null) ?? null,
    legacyIdentity: Boolean(row.legacy_identity),
    ownExpression: (row.own_expression as unknown) ?? null,
    lastSeenAt: row.last_seen_at ? new Date(row.last_seen_at as string).toISOString() : null,
    metadata: (row.metadata as Record<string, unknown>) ?? {},
  };
}

function parseScopes(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(String);
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? parsed.map(String) : [];
    } catch {
      return [];
    }
  }
  return [];
}

class PrincipalService {
  // handle/id → cached principal (null = confirmed miss, cached to keep
  // unknown-handle JWTs from hammering the DB once per request).
  private byHandle = new Map<string, { principal: Principal | null; at: number }>();
  private byId = new Map<string, { principal: Principal | null; at: number }>();
  private substrateWarnedAt = 0;

  /** Log the missing-substrate condition at most once a minute — it is
   *  expected in the deploy-before-migrate window, not an incident. */
  private warnSubstrateMissing(context: string, err: unknown): void {
    const now = Date.now();
    if (now - this.substrateWarnedAt > 60_000) {
      this.substrateWarnedAt = now;
      const code = (err as { code?: string })?.code || 'error';
      console.warn(`[PrincipalService] ${context} degraded to legacy behaviour (${code}) — identity substrate unavailable`);
    }
  }

  clearCacheForTests(): void {
    this.byHandle.clear();
    this.byId.clear();
    // The presence throttle now lives in the shared bounded writer, so the
    // reset that used to clear this service's own map clears that instead —
    // otherwise a suite's first bump would be coalesced by the previous one.
    presenceWriter.reset();
  }

  /**
   * Resolve a principal by exact handle. Returns undefined on miss OR on any
   * DB error (tolerance): the caller must treat undefined as "no principal"
   * and preserve legacy behaviour.
   */
  async getPrincipalByHandle(handle: string): Promise<Principal | undefined> {
    const cached = this.byHandle.get(handle);
    if (cached && Date.now() - cached.at < CACHE_TTL_MS) {
      return cached.principal ?? undefined;
    }
    try {
      const result = await pool.query('SELECT * FROM principals WHERE handle = $1', [handle]);
      const principal = result.rows[0] ? rowToPrincipal(result.rows[0]) : null;
      this.byHandle.set(handle, { principal, at: Date.now() });
      if (principal) this.byId.set(principal.id, { principal, at: Date.now() });
      return principal ?? undefined;
    } catch (err) {
      this.warnSubstrateMissing(`handle lookup '${handle}'`, err);
      return undefined;
    }
  }

  /**
   * Handle lookup that distinguishes a confirmed miss from an unreadable
   * substrate. Returned per call rather than held on the service, because
   * concurrent requests would race a shared flag.
   *
   * The unknown-handle telemetry feed gates the CB-8 REQUIRE_PRINCIPAL flip,
   * so "the DB was briefly unhappy" must never be recorded as "this identity
   * has no principal row".
   */
  async resolveHandle(handle: string): Promise<{ principal?: Principal; degraded: boolean }> {
    const cached = this.byHandle.get(handle);
    if (cached && Date.now() - cached.at < CACHE_TTL_MS) {
      return { principal: cached.principal ?? undefined, degraded: false };
    }
    try {
      const result = await pool.query('SELECT * FROM principals WHERE handle = $1', [handle]);
      const principal = result.rows[0] ? rowToPrincipal(result.rows[0]) : null;
      this.byHandle.set(handle, { principal, at: Date.now() });
      if (principal) this.byId.set(principal.id, { principal, at: Date.now() });
      return { principal: principal ?? undefined, degraded: false };
    } catch (err) {
      this.warnSubstrateMissing(`handle lookup '${handle}'`, err);
      return { degraded: true };
    }
  }

  async getPrincipalById(id: string): Promise<Principal | undefined> {
    const cached = this.byId.get(id);
    if (cached && Date.now() - cached.at < CACHE_TTL_MS) {
      return cached.principal ?? undefined;
    }
    try {
      const result = await pool.query('SELECT * FROM principals WHERE id = $1', [id]);
      const principal = result.rows[0] ? rowToPrincipal(result.rows[0]) : null;
      this.byId.set(id, { principal, at: Date.now() });
      if (principal) this.byHandle.set(principal.handle, { principal, at: Date.now() });
      return principal ?? undefined;
    } catch (err) {
      this.warnSubstrateMissing(`id lookup '${id}'`, err);
      return undefined;
    }
  }

  async listPrincipals(includeHidden = false): Promise<Principal[]> {
    const result = await pool.query(
      `SELECT * FROM principals
        ${includeHidden ? '' : `WHERE COALESCE((metadata->>'internal')::boolean, false) = false
          AND COALESCE((metadata->>'hidden_until_configured')::boolean, false) = false`}
        ORDER BY kind, handle`
    );
    return result.rows.map(rowToPrincipal);
  }

  /**
   * Fire-and-forget presence bump; never throws.
   *
   * Throttled per principal (same budget as credential telemetry): this runs
   * on every authenticated rh_ request, and an unthrottled UPDATE per request
   * would be pure write amplification on a hot table for a field only ever
   * read at minute granularity.
   */
  bumpLastSeen(principalId: string): void {
    presenceWriter.submit(
      `principal:${principalId}`,
      () => pool
        .query('UPDATE principals SET last_seen_at = now() WHERE id = $1', [principalId])
        .catch((err) => this.warnSubstrateMissing('last_seen bump', err)),
    );
  }

  /**
   * Validate a parsed rh_ bearer key. Returns undefined for ANY failure —
   * unknown key id, revoked, expired, bad secret, disabled principal, or an
   * unavailable substrate — so the middleware maps every failure to the same
   * generic 401 the pre-change code returned for a malformed bearer.
   */
  async authenticatePrincipalKey(parts: PrincipalKeyParts): Promise<{ principal: Principal; credential: PrincipalCredential } | undefined> {
    if (parts.env !== expectedKeyEnv()) return undefined;
    try {
      const result = await pool.query(
        `SELECT c.id AS credential_id, c.principal_id, c.credential_type, c.key_id, c.secret_hash,
                c.scopes, c.expires_at, c.revoked_at, c.transport, c.grace_until,
                c.metadata AS credential_metadata, p.*
           FROM principal_credentials c
           JOIN principals p ON p.id = c.principal_id
          WHERE c.key_id = $1 AND c.revoked_at IS NULL AND c.credential_type = 'api_key'`,
        [parts.keyId]
      );
      const row = result.rows[0];
      // The SAME usability question the delivery worker asks (review r3, B3):
      // an unaddressable key id or a malformed digest is not authenticable
      // here and must not be deliverable there.
      if (!row || !isUsableBearerKeyMaterial(row.key_id, row.secret_hash)) return undefined;
      // §7.2 + §10 (review a9e0e07d B1): NEW non-legacy credentials hash the
      // FULL token (rh_<env>_<keyId>.<secret>). PRE-096 legacy rows were
      // written by the Phase-2 code as SHA256(secret suffix) and cannot be
      // recomputed without plaintext — the §10 compatibility arm preserves
      // them, so a legacy_identity row authenticates against the suffix
      // hash exactly as before, until the Phase-5 estate transition retires
      // the arm. The discriminator is the stored legacy flag, not caller
      // input, so it cannot be gamed.
      const fullToken = `rh_${parts.env}_${parts.keyId}.${parts.secret}`;
      const candidateHash = row.legacy_identity ? sha256Hex(parts.secret) : sha256Hex(fullToken);
      const digest = Buffer.from(candidateHash, 'hex');
      const stored = Buffer.from(String(row.secret_hash), 'hex');
      if (digest.length !== stored.length || !crypto.timingSafeEqual(digest, stored)) return undefined;
      // Everything past possession-of-secret is the ONE shared acceptance
      // predicate (utils/credentialAcceptance) — credential type, a usable
      // stored secret, revocation, expiry, the §7.3 live grace watermark and
      // principal status, in the production order. The webhook delivery
      // worker evaluates the identical predicate, which is what makes push
      // authority incapable of exceeding pull authority (C2, review r2 B2).
      // Unchanged behaviour: any denial returns undefined, exactly as the
      // three inline checks it replaces did.
      const acceptance = evaluateCredentialAcceptance({
        credentialType: row.credential_type,
        keyId: row.key_id,
        secretHash: row.secret_hash,
        revokedAt: row.revoked_at,
        expiresAt: row.expires_at,
        graceUntil: row.grace_until,
        principalStatus: row.status,
      });
      if (!acceptance.ok) return undefined;
      const principal = rowToPrincipal(row);
      const credential: PrincipalCredential = {
        id: String(row.credential_id),
        principalId: String(row.principal_id),
        credentialType: String(row.credential_type),
        keyId: row.key_id ? String(row.key_id) : null,
        scopes: parseScopes(row.scopes),
        expiresAt: row.expires_at ? new Date(row.expires_at).toISOString() : null,
        revokedAt: null,
        transport: (row.transport as 'any' | 'mcp' | 'api') ?? 'any',
        graceUntil: row.grace_until ? new Date(row.grace_until).toISOString() : null,
        metadata: (row.credential_metadata as Record<string, unknown>) ?? {},
      };
      this.bumpCredentialLastUsed(credential.id);
      return { principal, credential };
    } catch (err) {
      this.warnSubstrateMissing(`rh_ key auth ${parts.keyId}`, err);
      return undefined;
    }
  }

  /**
   * Issue an api_key credential and return the full key exactly once.
   * Never logged; only the sha256 of the secret is stored.
   */
  async issueCredential(input: {
    principalId: string;
    scopes: string[];
    label?: string | null;
    expiresAt?: Date | null;
    transport?: 'any' | 'mcp' | 'api';
    rotatedFromId?: string | null;
    metadata?: Record<string, unknown>;
    createdByPrincipalId?: string | null;
  }, actor: AuditActor = { handle: 'system', authMethod: 'system' }, transaction?: PoolClient): Promise<{ fullKey: string; credentialId: string; keyId: string }> {
    // §5.2 rule 8 (review 6c7d68d2 B3): every policy REFUSAL below writes
    // a durable denied audit row with the reason and the full
    // server-resolved chain of the target.
    const refuse = async (status: number, code: string, message: string): Promise<never> => {
      await auditService.record({
        action: 'credential.mint', actor, outcome: 'denied',
        resourceType: 'principal', resourceId: input.principalId,
        metadata: {
          refusal: code,
          scopes: input.scopes,
          chain: await auditChainFor(pool, input.principalId),
        },
      }).catch(() => undefined);
      throw new CredentialPolicyError(status, code, message);
    };
    // §5.2 rule 2 (AZ-18): no NEW bearer credential carries root — the
    // owner plane is reachable only by authenticated login sessions.
    // Pre-096 legacy root bearers keep their §10 compatibility behavior;
    // nothing new joins them.
    if (input.scopes.includes('root')) {
      await refuse(422, ROOT_NOT_MINTABLE,
        'root is never delegable to a bearer credential (design 4d961e37 §5.2 rule 2 / AZ-18)');
    }
    // AZ-S4: the lookup rides the caller's transaction when one is given —
    // the agent-mint paths create the principal and its credential in ONE
    // transaction (§6.1 collect contract), so the fresh row is visible only
    // on that connection.
    const targetRow = await (transaction ?? pool).query(
      'SELECT kind, status, legacy_identity, parent_principal_id FROM principals WHERE id = $1', [input.principalId]);
    const target = targetRow.rows[0];
    if (!target) {
      await refuse(422, 'PRINCIPAL_NOT_FOUND', 'principalId resolves to no principal');
    }
    if (!target.parent_principal_id && !target.legacy_identity) {
      // A17.1/§7.1 (AZ-12/AZ-18, review 94aad5aa B4): Accounts are KEYLESS.
      // Humans and owner-plane automation act through login sessions;
      // service Accounts act through their Connectors. Bearer credentials
      // exist only at the Connector/Agent layers (legacy shapes keep their
      // §10 compatibility behavior; nothing new joins them).
      await refuse(422, 'ACCOUNTS_ARE_KEYLESS',
        'Accounts hold no bearer credentials (design 4d961e37 A17.1/§7.1): register a Connector for this Account and issue its credential instead');
    }
    if (target.legacy_identity) {
      // T37: legacy identities are frozen out of the new machinery; the
      // refusal itself is audited.
      await auditService.record({
        action: 'legacy.refused', actor, outcome: 'denied',
        resourceType: 'principal', resourceId: input.principalId,
        metadata: { act: 'credential.mint', reason: 'legacy_identity frozen out (§10, T37)',
          chain: await auditChainFor(pool, input.principalId) },
      });
      throw new CredentialPolicyError(409, 'LEGACY_FROZEN',
        'Legacy identities are frozen out of new credential issuance (§10, T37)');
    }
    if (target.status === 'terminated') {
      await refuse(409, 'PRINCIPAL_TERMINATED',
        'Credential issuance refuses terminated principals (A17.10)');
    }
    if (target.kind === 'agent' && input.scopes.some((scope) => scope.endsWith(':admin'))) {
      // §5.2 rule 3: *:admin verbs are delegable to Connectors, never Agents.
      await refuse(422, 'ADMIN_NOT_AGENT_DELEGABLE',
        '*:admin scopes never reach the Agent layer (design 4d961e37 §5.2 rule 3)');
    }
    const transport = input.transport ?? 'any';
    if (!['any', 'mcp', 'api'].includes(transport)) {
      await refuse(422, 'INVALID_TRANSPORT', "transport must be 'any', 'mcp' or 'api'");
    }
    const client = transaction ?? await pool.connect();
    const ownsTransaction = transaction === undefined;
    const keyId = crypto.randomBytes(9).toString('base64').replace(/[^A-Za-z0-9]/g, '').slice(0, 12).padEnd(12, '0');
    const secret = crypto.randomBytes(32).toString('base64url');
    const fullKey = `rh_${expectedKeyEnv()}_${keyId}.${secret}`;
    try {
      if (ownsTransaction) await client.query('BEGIN');
      // §7.2 (T9/T30): hash and ciphertext written in ONE transaction from
      // the same plaintext. A deployment without the envelope keyset cannot
      // mint — fail closed, never store an unrevealable secret silently.
      const credentialRowId = crypto.randomUUID();
      // §7.2 (review e5e437a0 B1): the ciphertext AND the hash cover the
      // FULL token (rh_<env>_<keyId>.<secret>), not just the suffix — so
      // reveal returns the exact token issued and any prefix/key-id/env
      // tamper fails authentication and the canary.
      const { ciphertext, encryptionKeyId } = encryptCredentialSecret(fullKey, credentialRowId);
      const result = await client.query(
        `INSERT INTO principal_credentials
           (id, principal_id, credential_type, key_id, secret_hash, label, scopes, expires_at,
            transport, secret_ciphertext, encryption_key_id, rotated_from_id,
            created_by_principal_id, metadata)
         VALUES ($1, $2, 'api_key', $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
         RETURNING id`,
        [
          credentialRowId,
          input.principalId,
          keyId,
          sha256Hex(fullKey),
          input.label ?? null,
          JSON.stringify(input.scopes),
          input.expiresAt ?? null,
          transport,
          ciphertext,
          encryptionKeyId,
          input.rotatedFromId ?? null,
          input.createdByPrincipalId ?? actor.principalId ?? null,
          JSON.stringify(input.metadata ?? {}),
        ]
      );
      const credentialId = String(result.rows[0].id);
      // §5.2 rule 8: every lifecycle audit carries the FULL resolved chain.
      const chain = await auditChainFor(client, input.principalId);
      await auditService.record({
        action: 'credential.mint', actor,
        resourceType: 'credential', resourceId: credentialId,
        metadata: {
          principalId: input.principalId,
          keyId,
          scopes: input.scopes,
          expiresAt: input.expiresAt?.toISOString() ?? null,
          rotatedFrom: input.metadata?.rotated_from ?? null,
          chain,
        },
      }, client);
      if (ownsTransaction) await client.query('COMMIT');
      return { fullKey, credentialId, keyId };
    } catch (error) {
      if (ownsTransaction) await client.query('ROLLBACK');
      throw error;
    } finally {
      if (ownsTransaction) client.release();
    }
  }

  /** Drop cached rows for the given principal ids (A17.10, review
   * ab857740 B5): every status mutation that must bite on the NEXT request
   * — termination above all — clears the id/handle caches so the login-JWT
   * plane cannot ride a stale active row for up to the cache TTL. */
  invalidatePrincipals(principalIds: string[]): void {
    for (const id of principalIds) {
      const cached = this.byId.get(id);
      if (cached?.principal?.handle) this.byHandle.delete(cached.principal.handle);
      this.byId.delete(id);
    }
    // Handle-cache rows can exist without an id-cache twin: sweep them too.
    for (const [handle, entry] of this.byHandle) {
      if (entry.principal && principalIds.includes(entry.principal.id)) {
        this.byHandle.delete(handle);
      }
    }
  }

  /**
   * Drop cached rows for the given HANDLES, whatever they resolved to.
   *
   * `invalidatePrincipals` above sweeps by principal id, so it can only reach
   * entries that HAVE a principal. The handle cache also stores NEGATIVE
   * answers (`{ principal: null }`, populated by a lookup for a handle that
   * did not exist yet), and a negative entry survives the row being created —
   * for up to the TTL the login that follows a first-run creation would be
   * told there is no such Account. This is the only invalidation that reaches
   * those.
   */
  invalidateHandles(handles: string[]): void {
    for (const handle of handles) {
      const cached = this.byHandle.get(handle);
      if (cached?.principal?.id) this.byId.delete(cached.principal.id);
      this.byHandle.delete(handle);
    }
  }

  /**
   * Create a principal. Returns undefined when the handle already exists.
   *
   * `client` lets a caller run this inside ITS OWN transaction, which the
   * SCIM provisioning rung needs: the Account and the provenance row that
   * decides who may read it have to commit together or not at all
   * (A24/AZ-A4 clause 3). The read caches are populated only on the
   * pool path — a row created inside a caller's transaction is not
   * committed yet, and caching it would publish a principal that may still
   * roll back. On that path the caller's next read populates the caches
   * through the ordinary miss.
   */
  async createPrincipal(input: {
    handle: string;
    kind: 'human' | 'agent' | 'service';
    displayName?: string | null;
    role?: string | null;
    purpose?: string | null;
  }, client: PoolClient | typeof pool = pool): Promise<Principal | undefined> {
    const result = await client.query(
      `INSERT INTO principals (kind, handle, display_name, role, purpose)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (handle) DO NOTHING
       RETURNING *`,
      [input.kind, input.handle, input.displayName ?? null, input.role ?? null, input.purpose ?? null]
    );
    if (!result.rows[0]) return undefined;
    const principal = rowToPrincipal(result.rows[0]);
    if (client === pool) {
      this.byHandle.set(principal.handle, { principal, at: Date.now() });
      this.byId.set(principal.id, { principal, at: Date.now() });
    }
    return principal;
  }

  /** Update display name, status and/or role. Invalidates the caches it touches.
   *
   * `role` joins the update set at the role-change act (owner ruling
   * `60307311` §1.2). The VALUE is never caller data by the time it arrives:
   * every caller has already passed it through `canAssignRole`, whose
   * `ASSIGNABLE_ROLES` set is the same vocabulary `principals_role_check`
   * enforces, so a value this method could not have written is refused twice
   * before it reaches the statement and a third time by the CHECK.
   */
  async updatePrincipal(
    principalId: string,
    updates: { displayName?: string; status?: 'active' | 'disabled'; role?: string },
    client: PoolClient | typeof pool = pool,
  ): Promise<Principal | undefined> {
    const sets: string[] = [];
    const params: unknown[] = [principalId];
    if (updates.displayName !== undefined) {
      params.push(updates.displayName);
      sets.push(`display_name = $${params.length}`);
    }
    if (updates.status !== undefined) {
      params.push(updates.status);
      sets.push(`status = $${params.length}`);
    }
    if (updates.role !== undefined) {
      params.push(updates.role);
      sets.push(`role = $${params.length}`);
    }
    if (sets.length === 0) return this.getPrincipalById(principalId);

    const result = await client.query(
      `UPDATE principals SET ${sets.join(', ')}, updated_at = now() WHERE id = $1 RETURNING *`,
      params
    );
    if (!result.rows[0]) return undefined;
    const principal = rowToPrincipal(result.rows[0]);
    // Refresh rather than invalidate. The rh_ auth path reads status live from
    // its own JOIN, so disabling takes effect on the next request regardless;
    // this keeps the read caches from serving a stale display name or status
    // to the board for up to their TTL.
    //
    // ONLY on the pool path, for the same reason `createPrincipal` populates no
    // cache inside a caller's transaction: an uncommitted row cached here would
    // publish a change that may still roll back. A transactional caller
    // refreshes the caches itself, AFTER its COMMIT.
    if (client === pool) {
      this.byId.set(principal.id, { principal, at: Date.now() });
      this.byHandle.set(principal.handle, { principal, at: Date.now() });
    }
    return principal;
  }

  /** Publish a committed row into the read caches (the transactional path's
   *  other half — see `updatePrincipal`). */
  cachePrincipal(principal: Principal): void {
    this.byId.set(principal.id, { principal, at: Date.now() });
    this.byHandle.set(principal.handle, { principal, at: Date.now() });
  }

  /**
   * Credentials for a principal, secrets excluded (spec §3.3 listing shape).
   *
   * This is the BEARER-credential surface: rotation, reveal, transport pins.
   * SS-W1's `password` rows are excluded because none of that vocabulary
   * applies to them — a password is presented once at the login endpoint and
   * is never an `Authorization` value (design 4d961e37 §7.1) — and rendering
   * one here would offer the Access manager a rotate button that mints an
   * `rh_` key for a login secret.
   */
  async listCredentials(principalId: string): Promise<Array<Record<string, unknown>>> {
    const result = await pool.query(
      `SELECT id, key_id, label, scopes, credential_type,
              created_at, expires_at, revoked_at, last_used_at,
              reveal_count, grace_until, transport, secret_ciphertext IS NOT NULL AS revealable
         FROM principal_credentials
        WHERE principal_id = $1 AND credential_type <> 'password'
        ORDER BY created_at DESC`,
      [principalId]
    );
    return result.rows.map((row) => ({
      id: row.id,
      keyId: row.key_id,
      label: row.label,
      scopes: parseScopes(row.scopes),
      credentialType: row.credential_type,
      createdAt: row.created_at,
      expiresAt: row.expires_at,
      revokedAt: row.revoked_at,
      lastUsedAt: row.last_used_at,
      // §7.2 (AZ-S4): reveal counters are Access-manager surface data;
      // graced predecessors and pre-encryption rows show as unrevealable.
      revealCount: Number(row.reveal_count ?? 0),
      graceUntil: row.grace_until ?? null,
      transport: row.transport ?? 'any',
      revealable: Boolean(row.revealable) && !row.revoked_at && !row.grace_until,
    }));
  }

  /** A single credential with its principal, for authorisation decisions. */
  async getCredentialWithPrincipal(credentialId: string): Promise<
    { credential: Record<string, unknown>; principal: Principal } | undefined
  > {
    const result = await pool.query(
      `SELECT c.id AS cred_id, c.principal_id, c.key_id, c.label, c.scopes,
              c.credential_type, c.expires_at, c.revoked_at, c.transport, p.*
         FROM principal_credentials c
         JOIN principals p ON p.id = c.principal_id
        WHERE c.id = $1`,
      [credentialId]
    );
    const row = result.rows[0];
    if (!row) return undefined;
    return {
      credential: {
        id: row.cred_id,
        principalId: row.principal_id,
        keyId: row.key_id,
        label: row.label,
        scopes: parseScopes(row.scopes),
        credentialType: row.credential_type,
        expiresAt: row.expires_at,
        revokedAt: row.revoked_at,
        // RH-P3.C4 (ii): the session brief tells an identity which transport
        // its credential is pinned to. A caller that cannot see the pin
        // discovers it as an unexplained 403 on the other surface.
        transport: row.transport,
      },
      principal: rowToPrincipal(row),
    };
  }

  /**
   * Rotate: mint a replacement carrying the same label and scopes, and put the
   * old one on a bounded grace window so an in-flight consumer is not cut off
   * mid-request.
   *
   * The spec says to set the old row's expires_at to now()+72h flat. That is
   * wrong in one direction: a credential expiring sooner than 72h — or already
   * expired — would have its life EXTENDED by being rotated. Rotation must
   * only ever shorten, so the grace is the EARLIER of the existing expiry and
   * now()+72h.
   */
  async rotateCredential(credentialId: string, graceHours = 24, actor: AuditActor = { handle: 'system', authMethod: 'system' }): Promise<
    { fullKey: string; credentialId: string; keyId: string } | undefined
  > {
    // §5.2 rule 8 (review a9e0e07d B2): a DURABLE denied credential.rotate
    // audit for EVERY service-level refusal, written on the pool so it
    // survives the transaction rollback and reaches the ledger even for an
    // internal caller that never touches the HTTP route. Resolves the
    // affected principal's full chain when the credential resolves.
    const auditRotateRefusal = async (refusal: string): Promise<void> => {
      let principalId: string | null = null;
      try {
        const found = await pool.query('SELECT principal_id FROM principal_credentials WHERE id = $1', [credentialId]);
        principalId = found.rows[0]?.principal_id ? String(found.rows[0].principal_id) : null;
      } catch { principalId = null; }
      await auditService.record({
        action: 'credential.rotate', actor, outcome: 'denied',
        resourceType: 'credential', resourceId: credentialId,
        metadata: { refusal, chain: principalId ? await auditChainFor(pool, principalId) : [] },
      }).catch(() => undefined);
    };
    // §7.3: grace defaults to 24h, bounded 0–7d.
    if (!Number.isFinite(graceHours) || graceHours < 0 || graceHours > 168) {
      await auditRotateRefusal('INVALID_GRACE');
      throw new CredentialPolicyError(422, 'INVALID_GRACE', 'graceHours must be between 0 and 168 (§7.3)');
    }
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const result = await client.query(
        `SELECT c.id AS cred_id, c.principal_id, c.key_id, c.label, c.scopes, c.transport,
                c.credential_type, c.expires_at, c.revoked_at, c.grace_until, c.rotated_from_id, p.*
           FROM principal_credentials c JOIN principals p ON p.id = c.principal_id
          WHERE c.id = $1 FOR UPDATE OF c`,
        [credentialId],
      );
      const row = result.rows[0];
      if (!row) {
        await client.query('ROLLBACK');
        return undefined;
      }
      if (row.credential_type === 'password') {
        // SS-W1: a login password has no bearer successor to rotate into.
        // It is replaced through the password route, which re-hashes it.
        await client.query('ROLLBACK');
        await auditRotateRefusal('PASSWORD_NOT_ROTATABLE');
        throw new CredentialPolicyError(422, 'PASSWORD_NOT_ROTATABLE',
          'A login password is not a bearer credential and does not rotate (design 4d961e37 §7.1): set a new password instead');
      }
      if (row.revoked_at || row.grace_until) {
        // §7.3 (review 2fcd548c B5): a retired source never rotates —
        // rotating a graced predecessor a second time would fork the
        // lineage into a third live credential. Rotate the live successor.
        await client.query('ROLLBACK');
        await auditRotateRefusal('ROTATE_FROM_RETIRED');
        throw new CredentialPolicyError(409, 'ROTATE_FROM_RETIRED',
          'A revoked or graced credential cannot rotate (§7.3): rotate the live successor instead');
      }
      if (row.kind === 'agent' && !row.legacy_identity) {
        // §7.3: Agents never rotate — a fresh Agent is a fresh mint.
        await client.query('ROLLBACK');
        await auditRotateRefusal('AGENTS_NEVER_ROTATE');
        throw new CredentialPolicyError(409, 'AGENTS_NEVER_ROTATE',
          'Agent credentials never rotate (design 4d961e37 §7.3): mint a fresh Agent instead');
      }
      // At most two live credentials per chain: revoke any prior graced
      // ancestor of THIS lineage before grading the current token.
      await client.query(
        `WITH RECURSIVE lineage AS (
           SELECT id, rotated_from_id FROM principal_credentials WHERE id = $1
           UNION ALL
           SELECT c.id, c.rotated_from_id FROM principal_credentials c
             JOIN lineage l ON c.id = l.rotated_from_id
         )
         UPDATE principal_credentials
            SET revoked_at = now(),
                metadata = jsonb_set(metadata, '{revoke_reason}', to_jsonb('superseded by newer rotation (§7.3)'::text))
          WHERE id IN (SELECT id FROM lineage WHERE id <> $1)
            AND revoked_at IS NULL`,
        [credentialId],
      );
      // Rotation mints an EXACT COPY (§7.3, sol r2-F1): scope set and
      // transport class inherited verbatim — narrowing happens ONLY through
      // the live principal-level own() expression, never here.
      const issued = await this.issueCredential({
        principalId: String(row.principal_id),
        scopes: parseScopes(row.scopes),
        label: (row.label as string | null) ?? null,
        expiresAt: row.expires_at ? new Date(row.expires_at) : null,
        transport: (row.transport as 'any' | 'mcp' | 'api') ?? 'any',
        rotatedFromId: credentialId,
        metadata: { rotated_from: credentialId },
      }, actor, client);
      // Grace: only ever shortens. grace_until and the (legacy) expiry cap
      // are both evaluated LIVE in the auth path.
      await client.query(
        `UPDATE principal_credentials
            SET grace_until = LEAST(
                  COALESCE(expires_at, now() + make_interval(hours => $2::int)),
                  now() + make_interval(hours => $2::int)
                ),
                expires_at = LEAST(
                  COALESCE(expires_at, now() + make_interval(hours => $2::int)),
                  now() + make_interval(hours => $2::int)
                ),
                metadata = jsonb_set(metadata, '{rotated_to}', to_jsonb($3::text))
          WHERE id = $1`,
        [credentialId, graceHours, issued.credentialId]
      );
      // AZ-31c (AZ-S4, design §6.1): entering rotation grace INVALIDATES
      // every outstanding pending/approved Approval bound to the
      // predecessor — the successor credential must re-request (T27 by
      // construction). Same transaction: the lapse commits with the grace.
      await invalidateApprovalsForCredentials(client, [credentialId], 'rotated', actor);
      // §5.2 rule 8 / §9.7 (review 6c7d68d2 B3): rotation is a NAMED
      // audited act carrying predecessor, successor, grace and the full
      // server-resolved chain.
      await auditService.record({
        action: 'credential.rotate', actor,
        resourceType: 'credential', resourceId: issued.credentialId,
        metadata: {
          predecessorId: credentialId,
          successorId: issued.credentialId,
          graceHours,
          principalId: String(row.principal_id),
          chain: await auditChainFor(client, String(row.principal_id)),
        },
      }, client);
      await client.query('COMMIT');
      return issued;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Revoke one credential by id. Never throws.
   */
  async revokeCredentialById(
    credentialId: string,
    reason: string,
    actor: AuditActor = { handle: 'system', authMethod: 'system' },
  ): Promise<boolean> {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const result = await client.query(
        `UPDATE principal_credentials
            SET revoked_at = now(), metadata = jsonb_set(metadata, '{revoke_reason}', to_jsonb($2::text))
          WHERE id = $1 AND revoked_at IS NULL
          RETURNING principal_id, key_id`,
        [credentialId, reason]
      );
      if (!result.rowCount) {
        await client.query('ROLLBACK');
        return false;
      }
      // AZ-31c (AZ-S4): revocation invalidates every outstanding Approval
      // bound to this credential, in the same transaction.
      await invalidateApprovalsForCredentials(client, [credentialId], 'revoked', actor);
      await auditService.record({
        action: 'credential.revoke', actor,
        resourceType: 'credential', resourceId: credentialId,
        metadata: {
          principalId: result.rows[0].principal_id,
          keyId: result.rows[0].key_id,
          reason,
          // §5.2 rule 8: the FULL resolved chain rides every revocation.
          chain: await auditChainFor(client, String(result.rows[0].principal_id)),
        },
      }, client);
      await client.query('COMMIT');
      return true;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Retirement telemetry rows for the legacy env keys (spec §2.3). The env
   * compare in middleware steps 2-3 stays the ONLY validation path — these
   * rows exist for last_used_at telemetry and rehearsable revocation.
   * Catches every error (missing relation included): it must never crash the
   * container the migration runbook needs to exec into.
   */
  async syncLegacyEnvCredentials(): Promise<void> {
    // RELAYHALL_JOURNAL_PUBLISH_API_KEY left this list with the Journal plugin
    // (P1.3 ruling A7); the reports_reader grant no longer carries journal:read.
    const entries: Array<{ envName: string; handle: string; scopes: string[] }> = [
      { envName: 'RELAYHALL_API_KEY', handle: 'service_account', scopes: [] },
      { envName: 'RELAYHALL_REPORTS_READ_API_KEY', handle: 'reports_reader', scopes: ['reports:read'] },
    ];
    for (const entry of entries) {
      const value = process.env[entry.envName];
      if (!value) {
        try {
          const hidden = await pool.query(
            `UPDATE principals
                SET status = 'disabled',
                    metadata = (metadata - 'configured') || '{"hidden_until_configured":true}'::jsonb,
                    updated_at = now()
              WHERE handle = $1
                AND COALESCE((metadata->>'compatibility')::boolean, false) = true
              RETURNING id`,
            [entry.handle]
          );
          this.byHandle.delete(entry.handle);
          if (hidden.rows[0]?.id) this.byId.delete(String(hidden.rows[0].id));
        } catch (err) {
          this.warnSubstrateMissing(`legacy env hide ${entry.envName}`, err);
        }
        continue;
      }
      try {
        let principal = await this.getPrincipalByHandle(entry.handle);
        if (!principal) {
          principal = await this.createPrincipal({
            handle: entry.handle,
            kind: 'service',
            displayName: entry.handle === 'reports_reader' ? 'Reports reader' : 'Legacy API integration',
            role: entry.handle === 'service_account' ? 'agent' : null,
          });
        }
        if (!principal) continue;
        await pool.query(
          `UPDATE principals
              SET status = 'active',
                  metadata = (metadata - 'hidden_until_configured') || '{"configured":true}'::jsonb,
                  updated_at = now()
            WHERE id = $1`,
          [principal.id]
        );
        this.byHandle.delete(entry.handle);
        this.byId.delete(principal.id);

        // A revocation must survive a restart. The unique index this upsert
        // arbitrates on is PARTIAL (revoked_at IS NULL), so a revoked row does
        // not conflict and a naive insert would mint a fresh ACTIVE row —
        // silently lifting a deliberate fail-close during exactly the
        // retirement window it exists to rehearse. Skip loudly instead.
        const newest = await pool.query(
          `SELECT revoked_at FROM principal_credentials
            WHERE credential_type = 'legacy_env' AND key_id = $1
            ORDER BY created_at DESC LIMIT 1`,
          [entry.envName]
        );
        if (newest.rows[0]?.revoked_at) {
          console.warn(
            `[PrincipalService] ${entry.envName} has a REVOKED credential row — leaving it revoked. ` +
            `The env var is still set; remove it or clear revoked_at deliberately to restore the key.`
          );
          continue;
        }

        await pool.query(
          `INSERT INTO principal_credentials (principal_id, credential_type, key_id, secret_hash, label, scopes)
           VALUES ($1, 'legacy_env', $2, $3, $4, $5)
           ON CONFLICT (key_id) WHERE revoked_at IS NULL AND key_id IS NOT NULL
           DO UPDATE SET secret_hash = EXCLUDED.secret_hash
          WHERE principal_credentials.secret_hash IS DISTINCT FROM EXCLUDED.secret_hash`,
          [principal.id, entry.envName, sha256Hex(value), `env:${entry.envName}`, JSON.stringify(entry.scopes)]
        );
      } catch (err) {
        this.warnSubstrateMissing(`legacy env sync ${entry.envName}`, err);
      }
    }
  }

  /**
   * Read the explicit revocation marker for a legacy env key. Error semantics
   * are locked by the spec: only a SUCCESSFULLY-READ revoked_at fail-closes;
   * any lookup error degrades to env-compare-only so a DB blip can never
   * outage all three legacy keys at once.
   */
  async isLegacyEnvKeyRevoked(envName: string): Promise<boolean> {
    try {
      const result = await pool.query(
        `SELECT revoked_at FROM principal_credentials
          WHERE credential_type = 'legacy_env' AND key_id = $1
          ORDER BY created_at DESC LIMIT 1`,
        [envName]
      );
      return Boolean(result.rows[0]?.revoked_at);
    } catch (err) {
      this.warnSubstrateMissing(`legacy revocation read ${envName}`, err);
      return false;
    }
  }

  /**
   * Throttled last_used_at telemetry (≤1 write/60s per credential id or env
   * key name). Fire-and-forget; never throws, never blocks a request.
   */
  bumpCredentialLastUsed(credentialIdOrEnvName: string): void {
    const isEnvName = credentialIdOrEnvName.startsWith('RELAYHALL_');
    presenceWriter.submit(
      `credential:${credentialIdOrEnvName}`,
      () => (isEnvName
        ? pool.query(
            `UPDATE principal_credentials SET last_used_at = now() WHERE credential_type = 'legacy_env' AND key_id = $1`,
            [credentialIdOrEnvName]
          )
        : pool.query(`UPDATE principal_credentials SET last_used_at = now() WHERE id = $1`, [credentialIdOrEnvName])
      ).catch((err) => this.warnSubstrateMissing(`last_used bump ${credentialIdOrEnvName}`, err)),
    );
  }
}

export const principalService = new PrincipalService();
