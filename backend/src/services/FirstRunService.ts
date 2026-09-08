/**
 * THE FIRST-RUN LOCAL ADMINISTRATOR (owner ruling `60307311` §1.1).
 *
 * A deployment with no administrator Account has no in-band way to make one:
 * `POST /principals` bounds the role axis with `canAssignRole`, and only an
 * `admin` issuer may assign `admin` — which nobody is yet. The break-glass
 * password login resolves to `orchestrator`, so it cannot mint the first
 * administrator either. That circle is the bootstrapping problem the ruling
 * names, and this is the one act that cuts it.
 *
 * ── THE STATE ──
 *
 * "No administrator exists" is ONE query: no ACTIVE, PARENTLESS, HUMAN
 * Account holds `admin` or `operator` (`utils/administratorSession.ts`).
 * `parent_principal_id IS NULL` is not decoration — `principals_human_parentless`
 * and `principals_elevated_parentless` (migration `096:100-108`) already make
 * a parented elevated row unrepresentable for new rows, and the predicate says
 * the same thing the schema does rather than trusting it silently.
 *
 * The POSITIVE answer is cached for the life of the process and the NEGATIVE
 * one never is. That asymmetry is the fail-closed direction: a cached "an
 * administrator exists" can only ever CLOSE the step, while a cached "none
 * exists" would hold the step open after somebody walked through it. The cost
 * is one indexed lookup per pre-login `/config` on a deployment that has not
 * been set up yet, and none at all afterwards.
 *
 * ── THE ACT ──
 *
 * The Account, its password credential and its audit row commit TOGETHER or
 * not at all, under a transaction-scoped advisory lock. Two callers racing the
 * step therefore produce one administrator and one 409, never two
 * administrators; and a crash between the row and the password can never leave
 * a deployment holding an administrator nobody can log in as — which would
 * close the step permanently and lock the owner out. Locking the owner out is
 * the worst outcome this surface can produce (R11), so it is made
 * unrepresentable at the WRITE rather than checked for afterwards.
 */
import bcrypt from 'bcrypt';
import type { PoolClient } from 'pg';
import { pool } from '../db/connection';
import { auditService } from './AuditService';
import { principalService, Principal, isMissingRelationError } from './PrincipalService';
import { ADMINISTRATOR_ROLES } from '../utils/administratorSession';
import { BCRYPT_ROUNDS, PasswordPolicyRefusal, checkPasswordPolicy } from './AccountPasswordService';
import { isFlagOn, FLAG_SESSIONS } from '../utils/featureFlags';

/**
 * The advisory-lock key. `pg_advisory_xact_lock` takes an application-chosen
 * bigint; a fixed literal in the signed 32-bit range keeps it readable in
 * `pg_locks` and collides with nothing else in the tree (no other call site
 * takes an advisory lock).
 */
export const FIRST_RUN_ADVISORY_LOCK = 273220;

/** The role the first administrator is created with — the ruling's word. */
export const FIRST_ADMINISTRATOR_ROLE = 'admin';

/** The audited act (`087`'s CHECK admits `[a-z][a-z0-9_.]{2,127}`). */
export const FIRST_RUN_AUDIT_ACTION = 'first_run.administrator_created';

/** Typed refusals; the route maps each to its status and body. */
export class FirstRunError extends Error {
  constructor(public readonly status: number, public readonly code: string, message: string) {
    super(message);
    this.name = 'FirstRunError';
  }
}

export interface FirstAdministrator {
  principal: Principal;
  /** The `principal_credentials` row that will carry the new session's FK. */
  credentialId: string;
}

const ADMINISTRATOR_EXISTS_SQL = `
  SELECT 1 FROM principals
   WHERE kind = 'human'
     AND status = 'active'
     AND parent_principal_id IS NULL
     AND role = ANY($1::text[])
   LIMIT 1`;

export class FirstRunService {
  /** Set once an administrator has been SEEN; never unset. See the header. */
  private administratorSeen = false;

  /** Test seam only — no production path calls this. */
  resetForTests(): void {
    this.administratorSeen = false;
  }

  /**
   * Does this deployment already have an administrator Account?
   *
   * Throws on an unreadable substrate rather than answering: the two callers
   * want DIFFERENT fail-closed directions — the public `/config` boolean must
   * not advertise a step it cannot verify, and the act itself must refuse with
   * a 503 rather than proceed — so neither direction is chosen here.
   */
  async administratorExists(queryable: { query: (t: string, p?: unknown[]) => Promise<{ rows: unknown[] }> } = pool): Promise<boolean> {
    if (this.administratorSeen) return true;
    const result = await queryable.query(ADMINISTRATOR_EXISTS_SQL, [[...ADMINISTRATOR_ROLES]]);
    const exists = result.rows.length > 0;
    if (exists) this.administratorSeen = true;
    return exists;
  }

  /**
   * Whether the first-run step is on offer, as the login page asks it.
   *
   * Gated on `RELAYHALL_SESSIONS` as well as on the state: with the session
   * substrate dormant there is no per-Account login door at all, so an Account
   * created here could never be signed in as, and offering the step would be
   * offering a dead end. A deployment in that shape keeps the break-glass door
   * it has always had.
   *
   * Fails CLOSED in every direction: an unreadable substrate answers `false`,
   * because advertising a step whose admissibility cannot be established is
   * the dangerous half of the pair.
   */
  async firstRunAvailable(): Promise<boolean> {
    if (!isFlagOn(FLAG_SESSIONS)) return false;
    try {
      return !(await this.administratorExists());
    } catch {
      return false;
    }
  }

  /**
   * Create the first local administrator. See the header for why the whole act
   * is one transaction under one lock.
   *
   * The password is hashed BEFORE the transaction opens: bcrypt at 10 rounds
   * is ~100ms of CPU, and holding an advisory lock across it would serialise
   * concurrent attempts on the slowest possible step.
   */
  async createFirstAdministrator(input: {
    handle: string;
    displayName: string | null;
    password: string;
    ip?: string | null;
    userAgent?: string | null;
  }): Promise<FirstAdministrator> {
    const policy: PasswordPolicyRefusal | null = checkPasswordPolicy(input.password);
    if (policy) throw new FirstRunError(422, policy.code, policy.message);

    const secretHash = await bcrypt.hash(input.password, BCRYPT_ROUNDS);

    let client: PoolClient;
    try {
      client = await pool.connect();
    } catch {
      throw new FirstRunError(503, 'FIRST_RUN_UNAVAILABLE', 'The identity substrate could not be reached');
    }

    try {
      await client.query('BEGIN');
      // Serialise the whole check-then-create against every other attempt.
      // Transaction-scoped: it is released by COMMIT or ROLLBACK, so no path
      // out of this function can leak it.
      await client.query('SELECT pg_advisory_xact_lock($1)', [FIRST_RUN_ADVISORY_LOCK]);

      if (await this.administratorExists(client)) {
        throw new FirstRunError(
          409, 'FIRST_RUN_CLOSED',
          'This deployment already has an administrator Account; the first-run step is closed. '
          + 'An administrator changes roles from the Access manager or with `relayhall principal role`.',
        );
      }

      const created = await principalService.createPrincipal({
        handle: input.handle,
        kind: 'human',
        displayName: input.displayName,
        role: FIRST_ADMINISTRATOR_ROLE,
      }, client);
      if (!created) {
        throw new FirstRunError(409, 'HANDLE_TAKEN', 'An Account with that name already exists');
      }

      // The same row shape `AccountPasswordService.set` writes: `key_id` stays
      // NULL so a password never touches `ux_pcred_active_key_id`, and it can
      // never become an `Authorization: Bearer` value (AUTHZ §7.1).
      const credential = await client.query(
        `INSERT INTO principal_credentials
           (principal_id, credential_type, secret_hash, label, created_by_principal_id)
         VALUES ($1, 'password', $2, 'Login password', $1)
         RETURNING id`,
        [created.id, secretHash],
      );

      // Inside the transaction, so an administrator that reached no ledger is
      // never created at all — the fail-closed rule the break-glass door
      // applies (`routes/auth.ts:246-255`), kept without a compensating write.
      await auditService.record({
        action: FIRST_RUN_AUDIT_ACTION,
        actor: {
          principalId: created.id,
          handle: created.handle,
          authMethod: 'local_admin',
        },
        resourceType: 'principal',
        resourceId: created.id,
        metadata: {
          role: FIRST_ADMINISTRATOR_ROLE,
          ip: input.ip ?? null,
          userAgent: typeof input.userAgent === 'string' ? input.userAgent.slice(0, 255) : null,
        },
      }, client);

      await client.query('COMMIT');
      this.administratorSeen = true;
      // `createPrincipal` populates no cache on the transactional path, and a
      // NEGATIVE handle entry from a lookup before the row existed would
      // otherwise serve "no such Account" to the login that follows for up to
      // the cache TTL.
      principalService.invalidateHandles([created.handle]);
      return { principal: created, credentialId: String(credential.rows[0].id) };
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      if (err instanceof FirstRunError) throw err;
      if (isMissingRelationError(err)) {
        throw new FirstRunError(503, 'FIRST_RUN_UNAVAILABLE', 'Identity substrate is not migrated yet');
      }
      throw err;
    } finally {
      client.release();
    }
  }
}

export const firstRunService = new FirstRunService();
