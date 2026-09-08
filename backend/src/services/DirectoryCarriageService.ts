/**
 * DirectoryCarriageService — THE SINGLE SEAM through which remote group
 * membership enters the board.
 *
 * RH-LENSES-a (card `74e02a05`); design RH-DESIGN.LENSES v7.1 (record
 * `96f0bd3d`, ANNEX `d6637a92`), normative mechanism text design v5
 * `07764243` §3.1–§3.5 and §5.4; migration 126.
 *
 * ── THE INVARIANT THIS FILE EXISTS TO HOLD ────────────────────────────────
 *
 * **I-L1.** For each (Identity provider `P`, Account `A`), the `group_members`
 * rows with `source='directory'` concerning `A` are exactly the image of `A`'s
 * reference carriage under `P`'s bindings — **recomputed from carriage at
 * every write, never patched incrementally**, and computed **inside the same
 * transaction that changed the carriage or the binding, under a lock that
 * serialises the two producers and the binding path**.
 *
 * Two producers observe carriage (an OIDC claim at login; a SCIM `/Groups`
 * push) and one act creates bindings (*Use this group*). Before this file they
 * would have been three independent writers of derived membership. They are
 * one: every carriage-changing act in the estate is a method BELOW, each opens
 * exactly one transaction, and derived membership is only ever written by
 * `recomputeDerivedMembership` calling `GroupService.applyAccountDirectorySnapshot`.
 * `backend/src/__tests__/directoryCarriageSeamCensus.test.ts` measures that
 * over the source rather than trusting this paragraph.
 *
 * ── NEITHER TABLE HOLDS AUTHORITY ─────────────────────────────────────────
 *
 * A reference and its carriage are OBSERVATIONS. They confer nothing until an
 * administrator binds a reference to a Group by an owner-plane act, and even
 * then the authority is the Group's, through `group_members`, exactly as it is
 * today. The census control asserts that NO reader of any class reads either
 * table — the structural half is migration 126's refusal of a foreign key to
 * `groups`, and this is the source half.
 *
 * ── THE THREE-LEVEL LOCK ORDER, AND THE PHANTOM IT CLOSES ─────────────────
 *
 * The defect two design rounds found is this: *a set was discovered before the
 * lock that would have made the discovery complete*. A login inserts carriage
 * for reference `R` and has not committed; *Use this group* on `R` asks who
 * carries `R`, sees nobody, takes nobody's Account lock, and commits a binding
 * with no derived membership. Nothing is wrong with either transaction; the
 * schedule is the defect.
 *
 * The repair is a lock **at the level the discovery ranges over**, taken
 * **before** the discovery:
 *
 *   provider  `rh.dir.provider:<id>`                 shared for every carriage
 *                                                    and binding act, EXCLUSIVE
 *                                                    for provider removal
 *   reference `rh.dir.ref:<providerId>:<ref>`        exclusive; taken by every
 *                                                    act that INSERTS carriage
 *                                                    for a reference, creates or
 *                                                    removes its binding, or
 *                                                    ENUMERATES its carriers
 *   account   `rh.dir.acct:<providerId>:<accountId>` exclusive; taken by every
 *                                                    act that recomputes an
 *                                                    Account's derived membership
 *
 * **Acquisition order is always provider → reference(s) → account(s)**, each
 * level in ascending key order, and no lock is acquired at a level after a
 * discovery query has ranged over that level. `LockLedger` below enforces all
 * three of those sentences at runtime rather than leaving them to review: a
 * write helper called without its lock throws, and so does a lock taken out of
 * order or after its level's discovery.
 *
 * **Every call is the single-`bigint` overload.** `hashtextextended(text,
 * bigint)` returns `bigint` and PostgreSQL exposes `pg_advisory_xact_lock(bigint)`
 * and `(integer, integer)` — **not** `(bigint, bigint)`. An earlier design
 * revision wrote the two-argument form and could not have executed at all.
 *
 * ── WHY A REMOVAL NEEDS NO REFERENCE LOCK, STATED RATHER THAN ASSUMED ─────
 *
 * `applyAccountCarriage` locks the references it may INSERT carriage for, and
 * not the ones it removes the Account from. That asymmetry is deliberate and
 * it is the phantom argument read in both directions:
 *
 *   * an INSERT makes a carrier that a concurrent binding act's discovery
 *     cannot see, so the binding act would never take that Account's lock —
 *     the reference lock is what makes the discovery complete;
 *   * a REMOVAL takes away a carrier the binding act's discovery CAN see. If
 *     it sees it, it takes that Account's lock, and this act holds it, so one
 *     of the two serialises behind the other and the loser recomputes from
 *     CURRENT carriage. If it does not see it (because this act committed
 *     first), there is nothing to recompute. Both schedules end at the image.
 *
 * The removal set is therefore covered by the ACCOUNT lock, which this act
 * holds and which every recomputing act takes. `A-L2` is the acceptance row
 * that measures it and `R-4`'s schedules `S2` and `S4` are the drill.
 *
 * ── THE WATERMARK IS AN OBSERVATION, NOT A SIDE EFFECT ────────────────────
 *
 * `applyAccountDirectorySnapshot` unconditionally advanced
 * `directory_sync_state.last_success_at`. Reusing it for a BINDING
 * recomputation would refresh a provider's "last successful snapshot" when
 * nothing was received, suppressing AZ-30's staleness alarm — a contradiction
 * of SS-13's fail-closed observability contract. So every call below passes
 * `advanceWatermark` explicitly: **true only for a claim login and a SCIM
 * push**, false for a bind, a rebind, a housekeeping delete and a provider
 * removal. A stale retained reference bound by an administrator does not
 * silence the alarm.
 */
import type { PoolClient } from 'pg';

import { pool } from '../db/connection';
import { auditService, type AuditActor } from './AuditService';
import {
  GroupError,
  groupService,
  validateGroupDescription,
  validateGroupName,
} from './GroupService';
import { resolveGroupBindings } from './identity/ssoGroupBinding';
import { directoryCarriageBounds } from '../config/directoryCarriage';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const CARRIAGE_SOURCES = ['claim', 'scim'] as const;
export type CarriageSource = (typeof CARRIAGE_SOURCES)[number];

/** A typed refusal, in the estate's shape (`GroupError`'s sibling). */
export class DirectoryCarriageError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly field?: string,
  ) {
    super(message);
    this.name = 'DirectoryCarriageError';
  }
}

const err = (status: number, code: string, message: string, field?: string) =>
  new DirectoryCarriageError(status, code, message, field);

/**
 * Re-raise a `GroupService` refusal in THIS service's vocabulary.
 *
 * Reusing another service's validator -- which SF-1's repair does, and
 * should -- means adopting its ERROR TYPE too, and the catalog routes map
 * carriage refusals. Without this, an explicitly over-long Group name
 * answered 500 with an error id: the validator refused correctly and the
 * refusal never reached the caller. The status, the code, the message and
 * the field are carried through unchanged, because they are the right
 * answer; only the envelope changes.
 */
function throughGroupValidator<T>(validate: () => T): T {
  try {
    return validate();
  } catch (error) {
    if (error instanceof GroupError) {
      throw err(error.status, error.code, error.message, error.field);
    }
    throw error;
  }
}

// Permits are private to this module. The exported operation only consumes one;
// callers cannot mint a permit or substitute a transaction or derived set.
const membershipPermits = new WeakMap<PoolClient, {
  provider: string; account: string; groups: readonly string[]; observation: boolean;
}>();

export function consumeDirectoryMembershipPermit(
  client: PoolClient | undefined, provider: string, account: string,
  groups: readonly string[], observation: boolean,
): PoolClient {
  const permit = client && membershipPermits.get(client);
  if (!client || !permit || permit.provider !== provider || permit.account !== account
    || permit.observation !== observation || permit.groups.length !== groups.length
    || permit.groups.some((id, index) => id !== groups[index])) {
    throw new GroupError(409, 'DIRECTORY_MEMBERSHIP_MANAGED',
      'Directory membership requires the carriage transaction and its derived result set.');
  }
  membershipPermits.delete(client);
  return client;
}

// ── The lock ledger ────────────────────────────────────────────────────────

type ProviderMode = 'shared' | 'exclusive';

/**
 * What locks this transaction holds, and what it has already discovered.
 *
 * This is the part that makes the lock order a MECHANISM rather than a
 * convention. Every private write helper asserts against it, so a future
 * editor who adds a carriage writer without its locks gets an exception on the
 * first run, not a phantom under contention six months later. `B-L15` asks for
 * a source census over every carriage and binding writer; this is the runtime
 * half of the same claim, and the two fail independently.
 */
interface LockLedger {
  providerId: string;
  provider: ProviderMode | null;
  /** External refs whose reference lock is held, in acquisition order. */
  references: string[];
  /** Account principal ids whose account lock is held, in acquisition order. */
  accounts: string[];
  /** A discovery query has ranged over the carriers of a reference. */
  discoveredCarriers: boolean;
}

function ledgerFor(providerId: string): LockLedger {
  return {
    providerId,
    provider: null,
    references: [],
    accounts: [],
    discoveredCarriers: false,
  };
}

/**
 * The advisory-lock key for one level, exported so a drill can take the SAME
 * key from OUTSIDE the service.
 *
 * A concurrency drill that computed its own key would be measuring its own
 * arithmetic; taking the key from here means a change to the key scheme
 * changes the drill with it.
 */
export function carriageLockKey(level: 'provider' | 'ref' | 'acct', ...parts: string[]): string {
  return `rh.dir.${level}:${parts.join(':')}`;
}

async function lockKey(client: PoolClient, key: string, mode: ProviderMode): Promise<void> {
  // `hashtextextended(text, bigint)` returns bigint, and the single-argument
  // `pg_advisory_xact_lock(bigint)` is the overload that exists. The seed is 0
  // so the key is a pure function of the string.
  const fn = mode === 'shared' ? 'pg_advisory_xact_lock_shared' : 'pg_advisory_xact_lock';
  await client.query(`SELECT ${fn}(hashtextextended($1, 0))`, [key]);
}

async function takeProviderLock(client: PoolClient, ledger: LockLedger, mode: ProviderMode): Promise<void> {
  if (ledger.provider !== null) {
    throw new Error('carriage lock order: the provider lock is taken once, first');
  }
  if (ledger.references.length > 0 || ledger.accounts.length > 0) {
    throw new Error('carriage lock order: the provider lock precedes every reference and account lock');
  }
  await lockKey(client, carriageLockKey('provider', ledger.providerId), mode);
  ledger.provider = mode;
}

async function takeReferenceLocks(
  client: PoolClient,
  ledger: LockLedger,
  refs: readonly string[],
): Promise<void> {
  if (ledger.provider === null) {
    throw new Error('carriage lock order: a reference lock requires the provider lock');
  }
  if (ledger.accounts.length > 0) {
    throw new Error('carriage lock order: every reference lock precedes every account lock');
  }
  if (ledger.discoveredCarriers) {
    throw new Error('carriage lock order: a reference lock may not follow a carrier discovery');
  }
  // Ascending key order, deduplicated. Two acts touching the same pair of
  // references in OPPOSITE orders deadlock; sorting is what makes the order
  // total and therefore deadlock-free. `R-4` asserts both halves: ascending
  // serialises, and arrival order produces an observable deadlock rather than
  // a wrong image.
  const ordered = [...new Set(refs)].sort();
  for (const ref of ordered) {
    if (ledger.references.includes(ref)) continue;
    const last = ledger.references[ledger.references.length - 1];
    if (last !== undefined && ref < last) {
      throw new Error(`carriage lock order: reference locks ascend (${last} then ${ref})`);
    }
    await lockKey(client, carriageLockKey('ref', ledger.providerId, ref), 'exclusive');
    ledger.references.push(ref);
  }
}

async function takeAccountLocks(
  client: PoolClient,
  ledger: LockLedger,
  accountPrincipalIds: readonly string[],
): Promise<void> {
  if (ledger.provider === null) {
    throw new Error('carriage lock order: an account lock requires the provider lock');
  }
  const ordered = [...new Set(accountPrincipalIds)].sort();
  for (const accountPrincipalId of ordered) {
    if (ledger.accounts.includes(accountPrincipalId)) continue;
    const last = ledger.accounts[ledger.accounts.length - 1];
    if (last !== undefined && accountPrincipalId < last) {
      throw new Error(`carriage lock order: account locks ascend (${last} then ${accountPrincipalId})`);
    }
    await lockKey(client, carriageLockKey('acct', ledger.providerId, accountPrincipalId), 'exclusive');
    ledger.accounts.push(accountPrincipalId);
  }
}

function requireReferenceLock(ledger: LockLedger, ref: string): void {
  if (!ledger.references.includes(ref)) {
    throw new Error(`carriage write without the reference lock for ${ref}`);
  }
}

function requireAccountLock(ledger: LockLedger, accountPrincipalId: string): void {
  if (!ledger.accounts.includes(accountPrincipalId)) {
    throw new Error(`derived-membership write without the account lock for ${accountPrincipalId}`);
  }
}

// ── Records ────────────────────────────────────────────────────────────────

export interface DirectoryGroupReferenceRecord {
  id: string;
  identityProviderId: string;
  externalGroupRef: string;
  displayName: string | null;
  scimExternalId: string | null;
  firstSeenAt: string;
  lastSeenAt: string;
  updatedAt: string;
}

/**
 * The catalog row of design §5.2. `memberCount` is a COUNT and never an
 * identity list, and `boundGroupId` is computed by the byte-exact join against
 * `groups`, never stored.
 *
 * THE ROW SHIPS WITHOUT `featured`, AND THAT IS A DECLARED NARROWING, NOT AN
 * OMISSION. §5.2 lists `featured` on the row; `groups.featured` is
 * **RH-LENSES-b's** column (design §7.1) and does not exist at this branch's
 * base. A lane's migration must not depend on another lane's schema (RESERVED
 * ledger, owner ruling PARALLEL-WRITERS `0464ad54` §2), so this card cannot add
 * it and must not read it. LENSES-b adds the field and the leading sort key
 * with the column; nothing here has to change for it to.
 */
export interface DirectoryGroupReferenceCatalogRow extends DirectoryGroupReferenceRecord {
  memberCount: number;
  sources: CarriageSource[];
  boundGroupId: string | null;
  boundGroupName: string | null;
}

/** The caller's OWN carriage — their profile's "Directory groups (N)". */
export interface OwnCarriageRow {
  referenceId: string;
  identityProviderId: string;
  externalGroupRef: string;
  displayName: string | null;
  sources: CarriageSource[];
  firstSeenAt: string;
  lastSeenAt: string;
  boundGroupId: string | null;
  boundGroupName: string | null;
}

function mapReference(row: Record<string, unknown>): DirectoryGroupReferenceRecord {
  return {
    id: String(row.id),
    identityProviderId: String(row.identity_provider_id),
    externalGroupRef: String(row.external_group_ref),
    displayName: row.display_name === null || row.display_name === undefined ? null : String(row.display_name),
    scimExternalId:
      row.scim_external_id === null || row.scim_external_id === undefined ? null : String(row.scim_external_id),
    firstSeenAt: new Date(row.first_seen_at as string).toISOString(),
    lastSeenAt: new Date(row.last_seen_at as string).toISOString(),
    updatedAt: new Date(row.updated_at as string).toISOString(),
  };
}

// ── Validation ─────────────────────────────────────────────────────────────

/**
 * The ref is OPAQUE. It is never trimmed, never case-folded, never
 * NFC/NFD-folded, never split on a separator. It is refused only for being
 * unusable as a key at all — empty, or past the octet bound the schema
 * enforces. Everything else is the provider's business, and SS-12's whole
 * point is that the code does not know what it is looking at.
 */
export const EXTERNAL_GROUP_REF_MAX_OCTETS = 1024;
export const DISPLAY_NAME_MAX_OCTETS = 1024;
export const SCIM_EXTERNAL_ID_MAX_OCTETS = 255;

function octets(value: string): number {
  return Buffer.byteLength(value, 'utf8');
}

export function validateExternalGroupRef(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw err(422, 'INVALID_DIRECTORY_GROUP_REF', 'externalGroupRef must be a non-empty string', 'externalGroupRef');
  }
  if (octets(value) > EXTERNAL_GROUP_REF_MAX_OCTETS) {
    throw err(
      422,
      'INVALID_DIRECTORY_GROUP_REF',
      `externalGroupRef must be at most ${EXTERNAL_GROUP_REF_MAX_OCTETS} octets`,
      'externalGroupRef',
    );
  }
  return value;
}

function validateOptionalText(value: unknown, field: string, maxOctets: number): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') throw err(422, 'INVALID_DIRECTORY_GROUP_REF', `${field} must be a string`, field);
  if (value.length === 0) return null;
  if (octets(value) > maxOctets) {
    throw err(422, 'INVALID_DIRECTORY_GROUP_REF', `${field} must be at most ${maxOctets} octets`, field);
  }
  return value;
}

function requireUuid(value: unknown, field: string): string {
  if (typeof value !== 'string' || !UUID_PATTERN.test(value)) {
    throw err(422, 'INVALID_DIRECTORY_GROUP_REF', `${field} must be a full UUID`, field);
  }
  return value;
}

// ── The service ────────────────────────────────────────────────────────────

export interface CarriageWriteResult {
  /** References observed by this act, whether newly created or refreshed. */
  referencesObserved: number;
  /** Carriage rows this act created. */
  carriageAdded: number;
  /** Carriage rows this act removed. */
  carriageRemoved: number;
  /** Accounts whose derived membership was recomputed. */
  accountsRecomputed: number;
}

export class DirectoryCarriageService {
  // ── The private core: recomputation ─────────────────────────────────────

  /**
   * Rewrite `A`'s derived membership from `A`'s CURRENT carriage at `P`.
   *
   * It contains no `group_members` DML of its own: it resolves carriage
   * through the UNMODIFIED `resolveGroupBindings` and hands the result to
   * `GroupService.applyAccountDirectorySnapshot`, which is the one writer of
   * `source='directory'` rows in the estate. That is the whole reason
   * "recomputed from carriage, never patched incrementally" is true rather
   * than asserted: there is no incremental path to take.
   *
   * `observation` decides the watermark: a claim login and a SCIM push are
   * observations of the directory, so they advance it; a bind, a delete and a
   * provider removal are the board's own acts and move nothing.
   */
  private async recomputeDerivedMembership(
    client: PoolClient,
    ledger: LockLedger,
    accountPrincipalId: string,
    observation: boolean,
    actor: AuditActor,
  ): Promise<void> {
    requireAccountLock(ledger, accountPrincipalId);
    // The Account's carriage FOR THIS PROVIDER, across ALL sources. The two
    // producers write disjoint row sets; the derived image is their union.
    const carried = await client.query(
      `SELECT dgr.external_group_ref
         FROM account_directory_group_references adgr
         JOIN directory_group_references dgr ON dgr.id = adgr.directory_group_reference_id
        WHERE adgr.account_principal_id = $1
          AND dgr.identity_provider_id = $2`,
      [accountPrincipalId, ledger.providerId],
    );
    const refs = carried.rows.map((row) => String(row.external_group_ref));
    const bindings = await resolveGroupBindings(ledger.providerId, refs, client);
    const groups = bindings.map((binding) => binding.groupId);
    membershipPermits.set(client, {
      provider: ledger.providerId, account: accountPrincipalId, groups, observation,
    });
    try {
      await groupService.applyAccountDirectorySnapshot(
        ledger.providerId, accountPrincipalId, groups, actor,
        { client, advanceWatermark: observation },
      );
    } finally {
      membershipPermits.delete(client);
    }
  }

  /** Upsert the reference rows this act observed, and return them by ref. */
  private async upsertReferences(
    client: PoolClient,
    ledger: LockLedger,
    refs: readonly string[],
    meta: { displayName?: string | null; scimExternalId?: string | null } = {},
  ): Promise<Map<string, DirectoryGroupReferenceRecord>> {
    const byRef = new Map<string, DirectoryGroupReferenceRecord>();
    for (const ref of [...new Set(refs)].sort()) {
      requireReferenceLock(ledger, ref);
      // COALESCE on update: the claim producer never supplies a display name,
      // and a login must not erase the one a SCIM push recorded. A caller that
      // means to clear it passes an explicit empty string, which
      // `validateOptionalText` turns into null and which this statement then
      // ignores — clearing a display name is not an act this rung offers.
      const result = await client.query(
        `INSERT INTO directory_group_references
           (identity_provider_id, external_group_ref, display_name, scim_external_id)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (identity_provider_id, external_group_ref) DO UPDATE
           SET last_seen_at = now(),
               updated_at = now(),
               display_name = COALESCE(EXCLUDED.display_name, directory_group_references.display_name),
               scim_external_id = COALESCE(EXCLUDED.scim_external_id, directory_group_references.scim_external_id)
         RETURNING *`,
        [ledger.providerId, ref, meta.displayName ?? null, meta.scimExternalId ?? null],
      ).catch((error: unknown) => {
        // SF-2. The ON CONFLICT clause resolves the (provider, ref) key; it
        // does NOT resolve `ux_directory_group_references_scim_external`, so a
        // second reference carrying an `externalId` another one already holds
        // raised an unhandled unique violation and answered 500 with an error
        // id. RFC 7644 §3.3 has a word for this and it is `uniqueness`.
        if ((error as { code?: string } | null)?.code === '23505') {
          throw err(
            409,
            'DIRECTORY_GROUP_REFERENCE_EXTERNAL_ID_TAKEN',
            'another directory group reference at this Identity provider already carries that '
              + 'externalId; it identifies one resource, so reconcile against that one rather '
              + 'than creating a second',
            'externalId',
          );
        }
        throw error;
      });
      byRef.set(ref, mapReference(result.rows[0]));
    }
    return byRef;
  }

  // ── Producer 1: the OIDC claim path (design §3.3, §3.4) ─────────────────

  /**
   * Replace `A`'s CLAIM-sourced carriage at `P` with exactly `refs`.
   *
   * An EMPTY `refs` under a `claim_present` verdict clears the Account's
   * claim-sourced carriage and, through the recomputation, its derived
   * membership — which is what the tree does today. `source='scim'` carriage
   * is untouched, because `source` is part of the primary key and the two
   * producers replace disjoint row sets.
   *
   * SS-13's fail-closed rule is unchanged and lives at the CALLER: an absent,
   * unparseable or overage-indicated claim never reaches this method, so it
   * writes no carriage, deletes no carriage and moves no watermark.
   */
  async applyAccountCarriage(
    identityProviderId: string,
    accountPrincipalId: string,
    refs: readonly string[],
    source: CarriageSource,
    actor: AuditActor,
  ): Promise<CarriageWriteResult> {
    requireUuid(identityProviderId, 'identityProviderId');
    requireUuid(accountPrincipalId, 'accountPrincipalId');
    const validated = refs.map((ref) => validateExternalGroupRef(ref));
    const distinct = [...new Set(validated)];

    const client = await pool.connect();
    const ledger = ledgerFor(identityProviderId);
    try {
      await client.query('BEGIN');
      await takeProviderLock(client, ledger, 'shared');
      // Every reference this act may INSERT carriage for. Removals are covered
      // by the account lock — see the header's asymmetry argument.
      await takeReferenceLocks(client, ledger, distinct);
      await takeAccountLocks(client, ledger, [accountPrincipalId]);

      const references = await this.upsertReferences(client, ledger, distinct);

      const removed = await client.query(
        `DELETE FROM account_directory_group_references adgr
          USING directory_group_references dgr
          WHERE adgr.directory_group_reference_id = dgr.id
            AND adgr.account_principal_id = $1
            AND adgr.source = $2
            AND dgr.identity_provider_id = $3
            AND NOT (dgr.external_group_ref = ANY($4::text[]))`,
        [accountPrincipalId, source, identityProviderId, distinct],
      );

      let added = 0;
      for (const ref of distinct) {
        const reference = references.get(ref);
        if (!reference) continue;
        const inserted = await client.query(
          `INSERT INTO account_directory_group_references
             (directory_group_reference_id, account_principal_id, source)
           VALUES ($1, $2, $3)
           ON CONFLICT (directory_group_reference_id, account_principal_id, source) DO UPDATE
             SET last_seen_at = now()
           RETURNING (xmax = 0) AS created`,
          [reference.id, accountPrincipalId, source],
        );
        if (inserted.rows[0]?.created === true) added += 1;
      }

      await this.recomputeDerivedMembership(client, ledger, accountPrincipalId, true, actor);

      // ONE audit row per sync act, never one per reference: a login carrying
      // 60 refs must not write 60 rows (`4d961e37` §9.7's read-noise rule).
      await auditService.record(
        {
          action: 'directory_group_reference.observe',
          actor,
          resourceType: 'identity_provider',
          resourceId: identityProviderId,
          metadata: {
            provider: identityProviderId,
            source,
            scope: 'account',
            accountPrincipalId,
            referencesObserved: distinct.length,
            carriageAdded: added,
            carriageRemoved: removed.rowCount ?? 0,
          },
        },
        client,
      );

      await client.query('COMMIT');
      return {
        referencesObserved: distinct.length,
        carriageAdded: added,
        carriageRemoved: removed.rowCount ?? 0,
        accountsRecomputed: 1,
      };
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  // ── Producer 2: SCIM /Groups (design §4.5) ──────────────────────────────

  /**
   * Replace the carriage of ONE reference, at ONE source, with exactly
   * `accountPrincipalIds`.
   *
   * The affected set is (old carriers ∪ new carriers), and every one of them
   * is recomputed: a member removed from a pushed Group loses the derived
   * membership in the same transaction that removed the carriage, which is
   * what makes "derived membership is a function of carriage" true at the SCIM
   * writer and not only at the login writer.
   */
  async applyReferenceCarriage(
    identityProviderId: string,
    externalGroupRef: string,
    accountPrincipalIds: readonly string[],
    source: CarriageSource,
    actor: AuditActor,
    meta: { displayName?: string | null; scimExternalId?: string | null } = {},
  ): Promise<CarriageWriteResult & { reference: DirectoryGroupReferenceRecord }> {
    requireUuid(identityProviderId, 'identityProviderId');
    const ref = validateExternalGroupRef(externalGroupRef);
    // The two optional texts are bounded HERE and not left to the CHECK
    // constraints: a constraint violation surfaces as a 500 a SCIM client
    // cannot act on, and the bound is the board's statement about what it
    // will carry, so it is the board that should say it.
    const displayName = validateOptionalText(meta.displayName, 'displayName', DISPLAY_NAME_MAX_OCTETS);
    const scimExternalId = validateOptionalText(
      meta.scimExternalId, 'externalId', SCIM_EXTERNAL_ID_MAX_OCTETS,
    );
    const wanted = [...new Set(accountPrincipalIds.map((id) => requireUuid(id, 'members')))];
    const bounds = directoryCarriageBounds();
    if (wanted.length > bounds.scimMaxMembers) {
      throw err(
        413,
        'DIRECTORY_SCIM_MEMBERS_TOO_MANY',
        `this Group carries ${wanted.length} members and DIRECTORY_SCIM_MAX_MEMBERS is ${bounds.scimMaxMembers}: `
          + 'the push is refused rather than truncated, because a truncated membership is a silent access change. '
          + 'Raise the bound deliberately, or split the group at the directory.',
      );
    }

    const client = await pool.connect();
    const ledger = ledgerFor(identityProviderId);
    try {
      await client.query('BEGIN');
      await takeProviderLock(client, ledger, 'shared');
      await takeReferenceLocks(client, ledger, [ref]);

      const references = await this.upsertReferences(client, ledger, [ref], { displayName, scimExternalId });
      const reference = references.get(ref)!;

      // Only NOW are the carriers discovered — the reference lock is held, so
      // no insert can be in flight that this enumeration would miss.
      const existing = await client.query(
        `SELECT account_principal_id FROM account_directory_group_references
          WHERE directory_group_reference_id = $1 AND source = $2`,
        [reference.id, source],
      );
      ledger.discoveredCarriers = true;
      const carriers = existing.rows.map((row) => String(row.account_principal_id));
      const affected = [...new Set([...carriers, ...wanted])];
      await takeAccountLocks(client, ledger, affected);

      const removed = await client.query(
        `DELETE FROM account_directory_group_references
          WHERE directory_group_reference_id = $1 AND source = $2
            AND NOT (account_principal_id = ANY($3::uuid[]))`,
        [reference.id, source, wanted],
      );
      let added = 0;
      for (const accountPrincipalId of [...wanted].sort()) {
        const inserted = await client.query(
          `INSERT INTO account_directory_group_references
             (directory_group_reference_id, account_principal_id, source)
           VALUES ($1, $2, $3)
           ON CONFLICT (directory_group_reference_id, account_principal_id, source) DO UPDATE
             SET last_seen_at = now()
           RETURNING (xmax = 0) AS created`,
          [reference.id, accountPrincipalId, source],
        );
        if (inserted.rows[0]?.created === true) added += 1;
      }

      for (const accountPrincipalId of [...affected].sort()) {
        await this.recomputeDerivedMembership(client, ledger, accountPrincipalId, true, actor);
      }

      await auditService.record(
        {
          action: 'directory_group_reference.observe',
          actor,
          resourceType: 'identity_provider',
          resourceId: identityProviderId,
          metadata: {
            provider: identityProviderId,
            source,
            scope: 'reference',
            referenceId: reference.id,
            ref,
            referencesObserved: 1,
            carriageAdded: added,
            carriageRemoved: removed.rowCount ?? 0,
            accountsRecomputed: affected.length,
          },
        },
        client,
      );

      await client.query('COMMIT');
      return {
        reference,
        referencesObserved: 1,
        carriageAdded: added,
        carriageRemoved: removed.rowCount ?? 0,
        accountsRecomputed: affected.length,
      };
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Create a reference that no Account carries — `POST /Groups` with an empty
   * `members`, which is the case amendment **A24.1(a)** exists to authorise
   * separately from the carriage of A24.1(b).
   */
  async recordReference(
    identityProviderId: string,
    externalGroupRef: string,
    actor: AuditActor,
    meta: { displayName?: string | null; scimExternalId?: string | null } = {},
  ): Promise<DirectoryGroupReferenceRecord> {
    const result = await this.applyReferenceCarriage(
      identityProviderId, externalGroupRef, [], 'scim', actor, meta,
    );
    return result.reference;
  }

  // ── The binding act: *Use this group* (design §5.4) ─────────────────────

  /**
   * Create a Group bound to this reference and populate it — ONE click, ONE
   * transaction.
   *
   * Root-session only at the route, because steps 2 and 3 are rule-4 acts A-4
   * and A-5. Step 4 is why one click is worth designing: today an
   * administrator types the ref by hand and members arrive only at their next
   * login.
   */
  async bindReferenceToGroup(
    referenceId: string,
    input: { name?: unknown; description?: unknown },
    actor: AuditActor,
  ): Promise<{ groupId: string; groupName: string; memberCountApplied: number; reference: DirectoryGroupReferenceRecord }> {
    requireUuid(referenceId, 'referenceId');
    const head = await pool.query('SELECT identity_provider_id FROM directory_group_references WHERE id = $1', [referenceId]);
    if (head.rows.length === 0) {
      throw err(404, 'DIRECTORY_GROUP_REFERENCE_NOT_FOUND', 'No such directory group reference');
    }
    const identityProviderId = String(head.rows[0].identity_provider_id);
    const bounds = directoryCarriageBounds();

    const client = await pool.connect();
    const ledger = ledgerFor(identityProviderId);
    try {
      await client.query('BEGIN');
      await takeProviderLock(client, ledger, 'shared');

      // Re-read the reference INSIDE the transaction: the row read above was a
      // pool read taken to learn which provider to lock, and a decision taken
      // from it would be a decision from a value read before the lock.
      const current = await client.query(
        'SELECT * FROM directory_group_references WHERE id = $1 AND identity_provider_id = $2',
        [referenceId, identityProviderId],
      );
      if (current.rows.length === 0) {
        throw err(404, 'DIRECTORY_GROUP_REFERENCE_NOT_FOUND', 'No such directory group reference');
      }
      const reference = mapReference(current.rows[0]);
      await takeReferenceLocks(client, ledger, [reference.externalGroupRef]);

      const bound = await client.query(
        'SELECT id, name FROM groups WHERE identity_provider_id = $1 AND external_group_ref = $2',
        [identityProviderId, reference.externalGroupRef],
      );
      if (bound.rows.length > 0) {
        throw err(
          409,
          'DIRECTORY_GROUP_REFERENCE_ALREADY_BOUND',
          `a Group ("${String(bound.rows[0].name)}") is already bound to this reference at this Identity provider`,
        );
      }

      const carriers = await client.query(
        `SELECT DISTINCT account_principal_id FROM account_directory_group_references
          WHERE directory_group_reference_id = $1`,
        [reference.id],
      );
      ledger.discoveredCarriers = true;
      const accounts = carriers.rows.map((row) => String(row.account_principal_id));
      if (accounts.length > bounds.bindMaxAccounts) {
        throw err(
          409,
          'DIRECTORY_BIND_TOO_MANY_ACCOUNTS',
          `this reference is carried by ${accounts.length} Accounts and DIRECTORY_BIND_MAX_ACCOUNTS is `
            + `${bounds.bindMaxAccounts}: binding it in one transaction would lock that many rows at once. `
            + 'Raise the bound deliberately if that is what you mean.',
        );
      }
      await takeAccountLocks(client, ledger, accounts);

      const name = this.groupNameFor(input.name, reference);
      const description = throughGroupValidator(() => validateGroupDescription(input.description));
      let groupRow;
      try {
        groupRow = await client.query(
          `INSERT INTO groups (name, description, created_by_principal_id, identity_provider_id, external_group_ref)
           VALUES ($1, $2, $3, $4, $5) RETURNING id, name`,
          [name, description, actor.principalId ?? null, identityProviderId, reference.externalGroupRef],
        );
      } catch (e) {
        if (e instanceof Error && e.message.includes('duplicate key')) {
          if (e.message.includes('ux_groups_directory_binding')) {
            throw err(
              409,
              'DIRECTORY_GROUP_REFERENCE_ALREADY_BOUND',
              'another Group is already bound to that external group reference at this Identity provider',
            );
          }
          throw err(
            409,
            'GROUP_NAME_EXISTS',
            `a Group named "${name}" already exists (names are case-insensitive): pass an explicit name`,
          );
        }
        throw e;
      }
      const groupId = String(groupRow.rows[0].id);
      const groupName = String(groupRow.rows[0].name);

      await auditService.record(
        {
          action: 'group.create',
          actor,
          resourceType: 'group',
          resourceId: groupId,
          metadata: { name: groupName, via: 'directory-group-reference' },
        },
        client,
      );

      // A BIND IS NOT AN OBSERVATION: `advanceWatermark` is false, so binding a
      // stale retained reference does not refresh the provider's "last
      // successful snapshot" and does not silence AZ-30's staleness alarm.
      for (const accountPrincipalId of [...accounts].sort()) {
        await this.recomputeDerivedMembership(client, ledger, accountPrincipalId, false, actor);
      }

      await auditService.record(
        {
          action: 'directory_group_reference.bind',
          actor,
          resourceType: 'directory_group_reference',
          resourceId: reference.id,
          metadata: {
            referenceId: reference.id,
            groupId,
            externalGroupRef: reference.externalGroupRef,
            memberCountApplied: accounts.length,
          },
        },
        client,
      );

      await client.query('COMMIT');
      return { groupId, groupName, memberCountApplied: accounts.length, reference };
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * `name` defaults to the display name, else the ref itself — and it goes
   * through the SAME validator every other `groups` writer uses.
   *
   * **SF-1, found by this build's own probe.** Writing the row directly meant
   * the name never met `GroupService.validateName`, so a DIRECTORY-CONTROLLED
   * value crossed a board bound: migration 127 bounds `display_name` at 1024
   * octets, and a 400-character one produced a 400-character board Group
   * name, where every other path refuses past 120. Measured, not suspected.
   *
   * The DEFAULT is refused with a sentence rather than truncated. A truncated
   * name is a Group nobody can find by the name the directory shows, and the
   * administrator is the one person who can decide what it should be called
   * instead — so the refusal names the field to pass, exactly as the
   * case-insensitive collision below does.
   */
  private groupNameFor(name: unknown, reference: DirectoryGroupReferenceRecord): string {
    if (name !== undefined && name !== null) {
      return throughGroupValidator(() => validateGroupName(name));
    }
    const derived = reference.displayName ?? reference.externalGroupRef;
    try {
      return validateGroupName(derived);
    } catch {
      throw err(
        422,
        'DIRECTORY_GROUP_REFERENCE_NAME_UNUSABLE',
        'this reference\'s default name is outside the Group name bound. Pass an explicit name.',
        'name',
      );
    }
  }

  // ── Housekeeping: the root delete (design §3.5) ─────────────────────────

  /**
   * Delete a retained reference and its carriage.
   *
   * Refused while the ref is BOUND to a Group, on the
   * `identity_provider_login_groups` ON DELETE RESTRICT precedent: remove the
   * binding first, which is itself an audited act. Deleting a reference out
   * from under a live binding would leave a Group whose membership silently
   * emptied with nothing in the ledger naming the cause.
   */
  async deleteReference(referenceId: string, actor: AuditActor): Promise<{ carriageRowsRemoved: number }> {
    requireUuid(referenceId, 'referenceId');
    const head = await pool.query('SELECT identity_provider_id FROM directory_group_references WHERE id = $1', [referenceId]);
    if (head.rows.length === 0) {
      throw err(404, 'DIRECTORY_GROUP_REFERENCE_NOT_FOUND', 'No such directory group reference');
    }
    const identityProviderId = String(head.rows[0].identity_provider_id);

    const client = await pool.connect();
    const ledger = ledgerFor(identityProviderId);
    try {
      await client.query('BEGIN');
      await takeProviderLock(client, ledger, 'shared');
      const current = await client.query(
        'SELECT * FROM directory_group_references WHERE id = $1 AND identity_provider_id = $2',
        [referenceId, identityProviderId],
      );
      if (current.rows.length === 0) {
        throw err(404, 'DIRECTORY_GROUP_REFERENCE_NOT_FOUND', 'No such directory group reference');
      }
      const reference = mapReference(current.rows[0]);
      await takeReferenceLocks(client, ledger, [reference.externalGroupRef]);

      const bound = await client.query(
        'SELECT id, name FROM groups WHERE identity_provider_id = $1 AND external_group_ref = $2',
        [identityProviderId, reference.externalGroupRef],
      );
      if (bound.rows.length > 0) {
        throw err(
          409,
          'DIRECTORY_GROUP_REFERENCE_BOUND',
          `this reference is bound to Group "${String(bound.rows[0].name)}": unbind the Group first, `
            + 'which is an audited act, and then delete the reference',
        );
      }

      const carriers = await client.query(
        'SELECT DISTINCT account_principal_id FROM account_directory_group_references WHERE directory_group_reference_id = $1',
        [reference.id],
      );
      ledger.discoveredCarriers = true;
      const accounts = carriers.rows.map((row) => String(row.account_principal_id));
      await takeAccountLocks(client, ledger, accounts);

      const removed = await client.query(
        'DELETE FROM account_directory_group_references WHERE directory_group_reference_id = $1',
        [reference.id],
      );
      await client.query('DELETE FROM directory_group_references WHERE id = $1', [reference.id]);

      for (const accountPrincipalId of [...accounts].sort()) {
        await this.recomputeDerivedMembership(client, ledger, accountPrincipalId, false, actor);
      }

      await auditService.record(
        {
          action: 'directory_group_reference.delete',
          actor,
          resourceType: 'directory_group_reference',
          resourceId: reference.id,
          metadata: {
            referenceId: reference.id,
            ref: reference.externalGroupRef,
            carriageRowsRemoved: removed.rowCount ?? 0,
          },
        },
        client,
      );

      await client.query('COMMIT');
      return { carriageRowsRemoved: removed.rowCount ?? 0 };
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * `DELETE /Groups/:id` — the SCIM half of the same housekeeping.
   *
   * It never touches `groups`, `group_members` directly, or a binding: a bound
   * Group whose reference is deleted KEEPS its binding and stops receiving
   * members, which is the dangling-ref state the design already tolerates when
   * a claim stops arriving. So unlike the root act above it does not refuse on
   * a live binding — the directory is entitled to say the group is gone, and
   * the board is entitled to keep the Group it minted.
   */
  async deleteReferenceFromDirectory(
    identityProviderId: string,
    referenceId: string,
    actor: AuditActor,
  ): Promise<{ carriageRowsRemoved: number } | null> {
    requireUuid(identityProviderId, 'identityProviderId');
    if (!UUID_PATTERN.test(String(referenceId))) return null;

    const client = await pool.connect();
    const ledger = ledgerFor(identityProviderId);
    try {
      await client.query('BEGIN');
      await takeProviderLock(client, ledger, 'shared');
      const current = await client.query(
        'SELECT * FROM directory_group_references WHERE id = $1 AND identity_provider_id = $2',
        [referenceId, identityProviderId],
      );
      if (current.rows.length === 0) {
        await client.query('ROLLBACK');
        return null;
      }
      const reference = mapReference(current.rows[0]);
      await takeReferenceLocks(client, ledger, [reference.externalGroupRef]);

      const carriers = await client.query(
        'SELECT DISTINCT account_principal_id FROM account_directory_group_references WHERE directory_group_reference_id = $1',
        [reference.id],
      );
      ledger.discoveredCarriers = true;
      const accounts = carriers.rows.map((row) => String(row.account_principal_id));
      await takeAccountLocks(client, ledger, accounts);

      const removed = await client.query(
        'DELETE FROM account_directory_group_references WHERE directory_group_reference_id = $1',
        [reference.id],
      );
      await client.query('DELETE FROM directory_group_references WHERE id = $1', [reference.id]);

      // A directory saying "this group is gone" IS an observation, so this one
      // advances the watermark: the push arrived and was applied.
      for (const accountPrincipalId of [...accounts].sort()) {
        await this.recomputeDerivedMembership(client, ledger, accountPrincipalId, true, actor);
      }

      await auditService.record(
        {
          action: 'directory_group_reference.delete',
          actor,
          resourceType: 'directory_group_reference',
          resourceId: reference.id,
          metadata: {
            referenceId: reference.id,
            ref: reference.externalGroupRef,
            carriageRowsRemoved: removed.rowCount ?? 0,
            via: 'scim',
          },
        },
        client,
      );

      await client.query('COMMIT');
      return { carriageRowsRemoved: removed.rowCount ?? 0 };
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  // ── Provider removal ────────────────────────────────────────────────────

  /**
   * Run `perform` — the caller's provider DELETE — with the provider lock held
   * EXCLUSIVELY, and rewrite the derived membership of every Account the
   * provider's carriage reached.
   *
   * The exclusive provider lock is what makes provider removal unable to
   * interleave with any carriage or binding act at all: every one of those
   * holds the same key SHARED. That closes the second phantom — a carriage
   * insert in flight while the provider row disappears.
   *
   * The recomputation happens AFTER `perform`, because that is when the
   * CASCADE has removed the references and migration 104's
   * `trg_identity_providers_unbind_groups` has unbound the Groups. Recomputing
   * from the state that then exists is what leaves no `group_members` row
   * behind for the provider's bound Groups (`A-L45`).
   *
   * The affected set is discovered from BOTH the carriage and the surviving
   * `source='directory'` membership of the provider's bound Groups: a
   * deployment that ran directory sync before migration 126 has memberships
   * whose carriage was never recorded, and leaving those behind would be a
   * silent authority residue.
   */
  async withProviderRemoval<T>(
    client: PoolClient,
    identityProviderId: string,
    actor: AuditActor,
    perform: () => Promise<T>,
  ): Promise<T> {
    const ledger = ledgerFor(identityProviderId);
    await takeProviderLock(client, ledger, 'exclusive');
    const affected = await client.query(
      `SELECT DISTINCT account_principal_id FROM (
         SELECT adgr.account_principal_id
           FROM account_directory_group_references adgr
           JOIN directory_group_references dgr ON dgr.id = adgr.directory_group_reference_id
          WHERE dgr.identity_provider_id = $1
         UNION
         SELECT gm.account_principal_id
           FROM group_members gm
           JOIN groups g ON g.id = gm.group_id
          WHERE gm.source = 'directory' AND g.identity_provider_id = $1
       ) AS reached`,
      [identityProviderId],
    );
    ledger.discoveredCarriers = true;
    const accounts = affected.rows.map((row) => String(row.account_principal_id));
    await takeAccountLocks(client, ledger, accounts);

    const outcome = await perform();

    for (const accountPrincipalId of [...accounts].sort()) {
      await this.recomputeDerivedMembership(client, ledger, accountPrincipalId, false, actor);
    }
    return outcome;
  }

  // ── The catalog read model (design §5.1–§5.3, narrowed by DBD-14) ───────

  /**
   * The v1 projection.
   *
   * §5.3's visibility table has three live rows; with `group_stewards`
   * deferred to LENSES-c the STEWARD row has no subject in v1, so v1 is:
   * **root login session -> everything; every other caller, bearer or session,
   * -> `200` with an EMPTY LIST** (register row **DBD-14**). That is NARROWER
   * than the design and than owner decision 5, never wider.
   *
   * An empty list rather than a 403: a 403 on a list discloses that the
   * surface exists and is populated.
   */
  async listReferences(scope: { rootSession: boolean }): Promise<DirectoryGroupReferenceCatalogRow[]> {
    if (!scope.rootSession) return [];
    const result = await pool.query(`${CATALOG_SELECT} ORDER BY ${CATALOG_ORDER}`);
    return result.rows.map(mapCatalogRow);
  }

  /**
   * One catalog row, or `null` when it is outside the projection.
   *
   * The caller answers `null` with the SAME 404 it answers for an id that does
   * not exist — one branch, the same words. The estate standard is FIX-C at
   * `21daf85`: *"refused in the same words, from ONE branch, so closing the
   * bypass does not open an oracle in its place"*.
   */
  async getReference(id: string, scope: { rootSession: boolean }): Promise<DirectoryGroupReferenceCatalogRow | null> {
    if (!UUID_PATTERN.test(String(id))) return null;
    if (!scope.rootSession) return null;
    const result = await pool.query(`${CATALOG_SELECT} WHERE dgr.id = $1`, [id]);
    if (result.rows.length === 0) return null;
    return mapCatalogRow(result.rows[0]);
  }

  /**
   * The caller's OWN carriage — their profile's "Directory groups (N)".
   *
   * Self-only and no identifier in the path, so members never learn other
   * people's group lists. It is the second half of owner decision 5.
   */
  async listOwnCarriage(accountPrincipalId: string): Promise<OwnCarriageRow[]> {
    requireUuid(accountPrincipalId, 'accountPrincipalId');
    const result = await pool.query(
      `SELECT dgr.id, dgr.identity_provider_id, dgr.external_group_ref, dgr.display_name,
              min(adgr.first_seen_at) AS first_seen_at,
              max(adgr.last_seen_at)  AS last_seen_at,
              array_agg(DISTINCT adgr.source ORDER BY adgr.source) AS sources,
              g.id AS bound_group_id, g.name AS bound_group_name
         FROM account_directory_group_references adgr
         JOIN directory_group_references dgr ON dgr.id = adgr.directory_group_reference_id
         LEFT JOIN groups g
           ON g.identity_provider_id = dgr.identity_provider_id
          AND g.external_group_ref = dgr.external_group_ref
        WHERE adgr.account_principal_id = $1
        GROUP BY dgr.id, dgr.identity_provider_id, dgr.external_group_ref, dgr.display_name, g.id, g.name
        ORDER BY dgr.display_name NULLS LAST, dgr.external_group_ref`,
      [accountPrincipalId],
    );
    return result.rows.map((row) => ({
      referenceId: String(row.id),
      identityProviderId: String(row.identity_provider_id),
      externalGroupRef: String(row.external_group_ref),
      displayName: row.display_name === null || row.display_name === undefined ? null : String(row.display_name),
      sources: (row.sources ?? []) as CarriageSource[],
      firstSeenAt: new Date(row.first_seen_at as string).toISOString(),
      lastSeenAt: new Date(row.last_seen_at as string).toISOString(),
      boundGroupId: row.bound_group_id === null || row.bound_group_id === undefined ? null : String(row.bound_group_id),
      boundGroupName:
        row.bound_group_name === null || row.bound_group_name === undefined ? null : String(row.bound_group_name),
    }));
  }

  // ── SCIM read model ─────────────────────────────────────────────────────

  async getReferenceForProvider(
    identityProviderId: string,
    id: string,
  ): Promise<(DirectoryGroupReferenceRecord & { members: string[] }) | null> {
    if (!UUID_PATTERN.test(String(id))) return null;
    const result = await pool.query(
      'SELECT * FROM directory_group_references WHERE id = $1 AND identity_provider_id = $2',
      [id, identityProviderId],
    );
    if (result.rows.length === 0) return null;
    const reference = mapReference(result.rows[0]);
    return { ...reference, members: await this.membersOf(reference.id) };
  }

  async findReferenceByRef(
    identityProviderId: string,
    externalGroupRef: string,
  ): Promise<DirectoryGroupReferenceRecord | null> {
    const result = await pool.query(
      'SELECT * FROM directory_group_references WHERE identity_provider_id = $1 AND external_group_ref = $2',
      [identityProviderId, externalGroupRef],
    );
    return result.rows.length === 0 ? null : mapReference(result.rows[0]);
  }

  async listReferencesForProvider(
    identityProviderId: string,
    page: { startIndex: number; count: number },
  ): Promise<{ totalResults: number; resources: Array<DirectoryGroupReferenceRecord & { members: string[] }> }> {
    const total = await pool.query(
      'SELECT count(*)::int AS n FROM directory_group_references WHERE identity_provider_id = $1',
      [identityProviderId],
    );
    const rows = await pool.query(
      `SELECT * FROM directory_group_references
        WHERE identity_provider_id = $1
        ORDER BY external_group_ref
        LIMIT $2 OFFSET $3`,
      [identityProviderId, page.count, Math.max(page.startIndex - 1, 0)],
    );
    const resources = [];
    for (const row of rows.rows) {
      const reference = mapReference(row);
      resources.push({ ...reference, members: await this.membersOf(reference.id) });
    }
    return { totalResults: Number(total.rows[0]?.n ?? 0), resources };
  }

  /** The Account ids carrying a reference, from the SCIM source only: `members`
   *  on a SCIM resource is what the DIRECTORY pushed, and rendering a login's
   *  observation there would tell the client its own push had changed. */
  async membersOf(referenceId: string): Promise<string[]> {
    const result = await pool.query(
      `SELECT account_principal_id FROM account_directory_group_references
        WHERE directory_group_reference_id = $1 AND source = 'scim'
        ORDER BY account_principal_id`,
      [referenceId],
    );
    return result.rows.map((row) => String(row.account_principal_id));
  }
}

/**
 * The catalog projection's SELECT.
 *
 * `boundGroupId` is the BYTE-EXACT join against `groups` — computed here, never
 * stored, and the only relation between a reference and a Group there is.
 * `memberCount` is a COUNT and never an identity list: no principal id, handle
 * or email appears at any depth of a catalog row, which is what `A-L35-v1`
 * asserts and `[B6]` is about.
 */
const CATALOG_SELECT = `
  SELECT dgr.id, dgr.identity_provider_id, dgr.external_group_ref, dgr.display_name,
         dgr.scim_external_id, dgr.first_seen_at, dgr.last_seen_at, dgr.updated_at,
         (SELECT count(DISTINCT adgr.account_principal_id)::int
            FROM account_directory_group_references adgr
           WHERE adgr.directory_group_reference_id = dgr.id) AS member_count,
         COALESCE((SELECT array_agg(DISTINCT adgr.source ORDER BY adgr.source)
                     FROM account_directory_group_references adgr
                    WHERE adgr.directory_group_reference_id = dgr.id), '{}') AS sources,
         g.id AS bound_group_id, g.name AS bound_group_name
    FROM directory_group_references dgr
    LEFT JOIN groups g
      ON g.identity_provider_id = dgr.identity_provider_id
     AND g.external_group_ref = dgr.external_group_ref`;

/** Sort at READ, on (display_name NULLS LAST, ref): the provider's own order is
 *  not ours to keep, and there is no `ordinal` column to keep it in. The
 *  design's leading `featured DESC` key arrives with LENSES-b's column. */
const CATALOG_ORDER = 'dgr.display_name NULLS LAST, dgr.external_group_ref';

function mapCatalogRow(row: Record<string, unknown>): DirectoryGroupReferenceCatalogRow {
  return {
    ...mapReference(row),
    memberCount: Number(row.member_count ?? 0),
    sources: (row.sources ?? []) as CarriageSource[],
    boundGroupId: row.bound_group_id === null || row.bound_group_id === undefined ? null : String(row.bound_group_id),
    boundGroupName:
      row.bound_group_name === null || row.bound_group_name === undefined ? null : String(row.bound_group_name),
  };
}

export const directoryCarriageService = new DirectoryCarriageService();
