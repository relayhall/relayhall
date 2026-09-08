/**
 * ScimGroupProvisioning — the SCIM `/Groups` rung (RFC 7643 §4.2, RFC 7644
 * §3.4–§3.5), RH-LENSES-a card `74e02a05`, design v5 `07764243` §4.1–§4.7.
 *
 * ── A SCIM GROUP RESOURCE IS A DIRECTORY GROUP REFERENCE, NOT A GROUP ─────
 *
 * `POST /scim/v2/Groups` does not mint a `groups` row and **cannot**:
 * `groups.id` is board-minted and immutable (A17.6, `094_groups.sql:88-101`),
 * Group creation is rule-4 act A-4, and `/groups` non-GET is root-session-only
 * (`utils/scopeMap.ts`). A directory that could create Groups would be a
 * directory that creates authority objects. What it creates is an OBSERVATION,
 * and an administrator turns an observation into a Group by an owner-plane act
 * (*Use this group*).
 *
 * ── THE AMENDMENT THIS RUNG NEEDS, AND WHY IT IS AN AMENDMENT ─────────────
 *
 * Vocabulary **A24** reads *"It authorizes EXACTLY: …"* and enumerates four
 * write classes, of which none is a persistent reference store. **"EXACTLY"
 * closes the set**, so this rung does not fall inside A24 and a design that
 * read the store into that sentence would be laundering. **A24.1** is the
 * smallest expressible widening — one write class, no new scope, no new verb —
 * split into two clauses because `POST /Groups` with `members: []` must create
 * a reference NO ACCOUNT CARRIES:
 *
 *   **A24.1(a)** the reference resource;  **A24.1(b)** the carriage.
 *
 * A24.1 was **ALLOWED** at the owner sitting of 2026-09-04 (ruling `60307311`;
 * register `9d07f5fe` 23:20 UTC) and folds into vocabulary companion
 * `0c321078` at ratification. `A-L34` is the build gate that proves the
 * folding happened, and it lives in
 * `backend/src/__tests__/scimGroupsRung.test.ts`.
 *
 * ── WHAT THE RUNG REFUSES, ON PURPOSE ────────────────────────────────────
 *
 *   NG-1  nested groups (`members[].type = 'Group'`) -> `400 invalidValue`.
 *         Derived membership would become a transitive closure, changing
 *         invariant I-L1 from a JOIN into a fixpoint over a graph the board
 *         does not own -- cycle handling, depth bounds and a new staleness
 *         story. That is a design, not a slice.
 *   NG-2  creating, renaming, binding or deleting a **Group** -- rule-4 acts
 *         A-4…A-6, root-session only.
 *   NG-3  membership of a Group with no binding to this provider -- there is
 *         no such membership to write; carriage is retained instead.
 *   NG-4  members that are not `directory_provisioned_accounts` of THIS
 *         provider -> `400 invalidValue`, NAMING the value. A24's "scoped to
 *         its own Identity provider".
 *   NG-5  any change to `groups.featured`, stewardship or home groups -- none
 *         is a directory fact.
 *   NG-6  `source='local'` membership -- T33: local rows are the board's
 *         explicit, audited exceptions.
 */
import { pool } from '../../db/connection';
import type { AuditActor } from '../AuditService';
import {
  DirectoryCarriageError,
  directoryCarriageService,
  validateExternalGroupRef,
  type DirectoryGroupReferenceRecord,
} from '../DirectoryCarriageService';
import { directoryCarriageBounds } from '../../config/directoryCarriage';
import { ScimError, SCIM_BASE_PATH } from './ScimProvisioningService';
import { ssoPublicApiUrl } from './ssoRedirectUri';
import type { IdentityProvider } from './IdentityProviderService';

export const SCIM_GROUP_SCHEMA = 'urn:ietf:params:scim:schemas:core:2.0:Group';

/**
 * The attributes this rung honours, as data.
 *
 * `routes/scim.ts` renders the Group schema from THIS list, on the standing
 * rule the file already states: *"A schema advertising attributes the endpoint
 * ignores is a false statement a client would act on"*. A schema written out
 * by hand beside a handler that honours something else is exactly that false
 * statement, so there is one list and both read it.
 */
export const SCIM_GROUP_MAPPED_ATTRIBUTES = ['displayName', 'externalId', 'members'] as const;

export interface ScimGroupRecord extends DirectoryGroupReferenceRecord {
  members: string[];
}

/**
 * The public API origin, or `null` when the deployment has not declared one.
 *
 * `scimResourceLocation` in the User rung takes the same try/catch, and for
 * the same reason: a deployment with no declared public URL still serves SCIM,
 * a `meta` block without `location` is a conforming response, and a thrown
 * configuration error on a read path is not.
 */
function publicApiBase(): string | null {
  try {
    return ssoPublicApiUrl();
  } catch {
    return null;
  }
}

/** RFC 7643 §4.2 — the resource as a conforming client reads it. */
export function scimGroupResource(record: ScimGroupRecord): Record<string, unknown> {
  const base = publicApiBase();
  const resource: Record<string, unknown> = {
    schemas: [SCIM_GROUP_SCHEMA],
    id: record.id,
    displayName: record.displayName ?? record.externalGroupRef,
    members: record.members.map((value) => ({
      value,
      type: 'User',
      // `$ref` and `.display` are RENDERED on read and IGNORED on write: a
      // client that echoes them back is not making a second assertion about
      // the member, and treating it as one would refuse conforming clients.
      ...(base ? { $ref: `${base}${SCIM_BASE_PATH}/Users/${value}` } : {}),
    })),
    meta: {
      resourceType: 'Group',
      created: record.firstSeenAt,
      lastModified: record.updatedAt,
      ...(base ? { location: `${base}${SCIM_BASE_PATH}/Groups/${record.id}` } : {}),
    },
  };
  if (record.scimExternalId) resource.externalId = record.scimExternalId;
  return resource;
}

/**
 * Translate a carriage refusal into the wire format THIS layer owns.
 *
 * **SF-3, found by this build.** `sendScimError` maps only `ScimError`;
 * everything else becomes a 500 with an error id. So every refusal the seam
 * raises — an oversized group reference, a bound the deployment configured,
 * an `externalId` collision — reached a conforming client as *"the request
 * could not be completed"*, which tells it to retry something it must not
 * retry. The seam is right to refuse in its own vocabulary; translating is
 * this layer's job, and doing it in ONE place is why a second copy of the
 * mapping cannot drift from the first.
 */
function asScimError(error: unknown): unknown {
  if (!(error instanceof DirectoryCarriageError)) return error;
  const scimType = error.status === 409 ? 'uniqueness'
    : error.status === 413 ? 'tooMany'
      : 'invalidValue';
  // A 422 from the seam is a 400 on the wire: RFC 7644 §3.12's table has no
  // 422, and a status a conforming client does not branch on is a status it
  // treats as a transport failure.
  const status = error.status === 422 ? 400 : error.status;
  return new ScimError(status, scimType, error.message);
}

/** Run a carriage act and translate whatever it refuses with. */
async function throughSeam<T>(act: () => Promise<T>): Promise<T> {
  try {
    return await act();
  } catch (error) {
    throw asScimError(error);
  }
}

function asObject(value: unknown, detail: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new ScimError(400, 'invalidValue', detail);
  }
  return value as Record<string, unknown>;
}

function optionalString(body: Record<string, unknown>, name: string): string | null {
  const value = body[name];
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') {
    throw new ScimError(400, 'invalidValue', `${name} must be a string`);
  }
  return value;
}

/**
 * The `members` array, read into Account principal ids.
 *
 * NG-1 and the type check come FIRST, before any lookup: a nested-group member
 * must be refused as a nested group, not as "an Account I cannot find", or the
 * refusal tells a client to go and provision a User that does not exist.
 */
export function readMembers(body: Record<string, unknown>): string[] {
  const raw = body.members;
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) throw new ScimError(400, 'invalidValue', 'members must be an array');
  const bounds = directoryCarriageBounds();
  if (raw.length > bounds.scimMaxMembers) {
    throw new ScimError(
      413,
      'tooMany',
      `this Group carries ${raw.length} members and this deployment's DIRECTORY_SCIM_MAX_MEMBERS is `
        + `${bounds.scimMaxMembers}. The push is REFUSED rather than truncated: a truncated membership is a `
        + 'silent access change.',
    );
  }
  const values: string[] = [];
  for (const entry of raw) {
    const member = asObject(entry, 'each member must be an object with a value');
    if (member.type !== undefined && member.type !== 'User') {
      throw new ScimError(
        400,
        'invalidValue',
        `members[].type must be "User": this endpoint does not model nested groups, because derived `
          + 'membership would become a transitive closure over a graph the board does not own',
      );
    }
    const value = member.value;
    if (typeof value !== 'string' || value.length === 0) {
      throw new ScimError(400, 'invalidValue', 'each member must carry a non-empty value');
    }
    values.push(value);
  }
  return values;
}

export class ScimGroupProvisioningService {
  /**
   * Which value becomes `external_group_ref`, taken from the attribute the
   * PROVIDER declared, VERBATIM.
   *
   * A declared attribute that is ABSENT from the pushed resource is refused
   * `400 invalidValue` NAMING the attribute — never a silent fallback to the
   * other one, because a silent fallback is how two references for one real
   * group get created, each binding half the people.
   */
  refFor(provider: IdentityProvider, body: Record<string, unknown>): string {
    const attribute = provider.scimGroupRefAttribute;
    const value = optionalString(body, attribute);
    // SF-3: `validateExternalGroupRef` refuses in the SEAM's vocabulary, and
    // this is the boundary that owns the wire format.
    if (value === null || value === '') {
      throw new ScimError(
        400,
        'invalidValue',
        `this Identity provider declares "${attribute}" as the attribute that carries the group reference, `
          + 'and this resource does not carry it. The board takes that value verbatim and matches it '
          + 'byte-exactly against the OIDC groups claim; there is no fallback, because a fallback would '
          + 'create a second reference for one real group.',
      );
    }
    try {
      return validateExternalGroupRef(value);
    } catch (error) {
      throw asScimError(error);
    }
  }

  /**
   * Every member must be an Account THIS provider provisioned.
   *
   * A24 scopes the SCIM client to its own Identity provider, so a member
   * naming an Account of a different provider — or no Account at all — is
   * refused `400 invalidValue` naming the value. It names the value and not
   * the reason it failed: "not provisioned by you" and "does not exist" are
   * the same sentence here on purpose, because distinguishing them would make
   * this endpoint an existence oracle for the board's Accounts.
   */
  async requireProvisionedMembers(provider: IdentityProvider, values: readonly string[]): Promise<string[]> {
    const distinct = [...new Set(values)];
    if (distinct.length === 0) return [];
    const found = await pool.query(
      `SELECT account_principal_id FROM directory_provisioned_accounts
        WHERE identity_provider_id = $1 AND account_principal_id::text = ANY($2::text[])`,
      [provider.id, distinct],
    );
    const known = new Set(found.rows.map((row) => String(row.account_principal_id)));
    for (const value of distinct) {
      if (!known.has(value)) {
        throw new ScimError(
          400,
          'invalidValue',
          `members[].value "${value}" is not an Account provisioned by this Identity provider`,
        );
      }
    }
    return distinct;
  }

  async create(
    provider: IdentityProvider,
    actor: AuditActor,
    body: Record<string, unknown>,
  ): Promise<ScimGroupRecord> {
    const ref = this.refFor(provider, body);
    const members = await this.requireProvisionedMembers(provider, readMembers(body));

    // A REPEAT POST ON AN EXISTING REF IS 409 uniqueness (RFC 7644 §3.3), not
    // an upsert: a client that lost track reconciles rather than forks. An
    // upsert here would silently replace the members of a reference the client
    // believes it is creating for the first time.
    const existing = await directoryCarriageService.findReferenceByRef(provider.id, ref);
    if (existing) {
      throw new ScimError(
        409,
        'uniqueness',
        'a Group with that reference already exists at this Identity provider; '
          + `reconcile against ${SCIM_BASE_PATH}/Groups/${existing.id} instead of creating a second one`,
      );
    }

    const applied = await throughSeam(() => directoryCarriageService.applyReferenceCarriage(
      provider.id, ref, members, 'scim', actor,
      { displayName: optionalString(body, 'displayName'), scimExternalId: optionalString(body, 'externalId') },
    ));
    return { ...applied.reference, members: await directoryCarriageService.membersOf(applied.reference.id) };
  }

  /**
   * `PUT` — a full replace of `displayName` and `members`.
   *
   * THE REF IS IMMUTABLE AFTER CREATION (`400 mutability`), for the reason
   * `groups.id` is: it is the join key that bindings and carriage both hang
   * on, and moving it would silently empty the Group an administrator bound.
   *
   * SOME DIRECTORY PRODUCTS ECHO THE readOnly `id` BACK ON `PUT`. It is
   * ACCEPTED AND IGNORED, never refused — refusing it would break conforming
   * clients over a field that is the server's anyway, since RFC 7643 §3.1
   * makes `id` the service provider's to assign in the first place.
   */
  async replace(
    provider: IdentityProvider,
    actor: AuditActor,
    id: string,
    body: Record<string, unknown>,
  ): Promise<ScimGroupRecord> {
    const current = await this.require(provider, id);
    const declared = optionalString(body, provider.scimGroupRefAttribute);
    if (declared !== null && declared !== current.externalGroupRef) {
      throw new ScimError(
        400,
        'mutability',
        `"${provider.scimGroupRefAttribute}" carries this Group's reference and is immutable after creation: `
          + 'it is the key the board matches byte-exactly against the OIDC groups claim, and against which '
          + 'an administrator may already have bound a Group. Delete this resource and create the new one.',
      );
    }
    const members = await this.requireProvisionedMembers(provider, readMembers(body));
    const applied = await throughSeam(() => directoryCarriageService.applyReferenceCarriage(
      provider.id, current.externalGroupRef, members, 'scim', actor,
      {
        displayName: optionalString(body, 'displayName'),
        // `externalId` is the client's own identifier and it may legitimately
        // set one later; it is not the ref unless the provider declared it to
        // be, and if it did the immutability check above has already run.
        scimExternalId: optionalString(body, 'externalId'),
      },
    ));
    return { ...applied.reference, members: await directoryCarriageService.membersOf(applied.reference.id) };
  }

  /**
   * `PATCH` — RFC 7644 §3.5.2 over an ENUMERATED path set only.
   *
   * `displayName`, `members` (`add` / `remove` / `replace`) and
   * `members[value eq "…"]`. Anything else is `400 invalidPath` — the same
   * discipline the User `PATCH` already applies, and for the same reason: a
   * path this endpoint silently ignores is a change a client believes it made.
   */
  async patch(
    provider: IdentityProvider,
    actor: AuditActor,
    id: string,
    body: Record<string, unknown>,
  ): Promise<ScimGroupRecord> {
    const current = await this.require(provider, id);
    const operations = body.Operations;
    if (!Array.isArray(operations) || operations.length === 0) {
      throw new ScimError(400, 'invalidValue', 'a PATCH carries a non-empty Operations array (RFC 7644 §3.5.2)');
    }

    let members = [...current.members];
    let displayName: string | null = current.displayName;

    for (const raw of operations) {
      const operation = asObject(raw, 'each PATCH operation is an object');
      const op = String(operation.op ?? '').toLowerCase();
      if (!['add', 'remove', 'replace'].includes(op)) {
        throw new ScimError(400, 'invalidValue', `unsupported PATCH op "${String(operation.op)}"`);
      }
      const path = operation.path === undefined || operation.path === null ? null : String(operation.path);
      const parsed = parsePatchPath(path);

      if (parsed.target === 'displayName') {
        if (op === 'remove') { displayName = null; continue; }
        const value = typeof operation.value === 'string' ? operation.value : null;
        if (value === null) throw new ScimError(400, 'invalidValue', 'displayName must be set to a string');
        displayName = value;
        continue;
      }

      if (parsed.target === 'members-filtered') {
        if (op !== 'remove') {
          throw new ScimError(
            400,
            'invalidPath',
            'a members[value eq "…"] path is supported for remove only; add and replace address members as a whole',
          );
        }
        members = members.filter((value) => value !== parsed.value);
        continue;
      }

      // parsed.target === 'members'
      const supplied = readMembers({ members: operation.value });
      if (op === 'add') members = [...new Set([...members, ...supplied])];
      else if (op === 'replace') members = supplied;
      else members = members.filter((value) => !supplied.includes(value));
    }

    const resolved = await this.requireProvisionedMembers(provider, members);
    const applied = await throughSeam(() => directoryCarriageService.applyReferenceCarriage(
      provider.id, current.externalGroupRef, resolved, 'scim', actor, { displayName },
    ));
    return { ...applied.reference, members: await directoryCarriageService.membersOf(applied.reference.id) };
  }

  /**
   * `DELETE` — remove the reference and recompute for exactly the Accounts
   * that carried it.
   *
   * It never touches `groups`, never writes `group_members` directly and never
   * removes a binding: a bound Group whose reference is deleted KEEPS its
   * binding and stops receiving members. That is the dangling-ref state the
   * design already tolerates when a claim stops arriving, and the alternative
   * — letting the directory delete a board Group — is NG-2.
   */
  async remove(provider: IdentityProvider, actor: AuditActor, id: string): Promise<void> {
    await this.require(provider, id);
    await throughSeam(() => directoryCarriageService.deleteReferenceFromDirectory(provider.id, id, actor));
  }

  async get(provider: IdentityProvider, id: string): Promise<ScimGroupRecord | null> {
    return directoryCarriageService.getReferenceForProvider(provider.id, id);
  }

  async list(
    provider: IdentityProvider,
    page: { startIndex: number; count: number },
  ): Promise<{ totalResults: number; resources: ScimGroupRecord[] }> {
    return directoryCarriageService.listReferencesForProvider(provider.id, page);
  }

  /** A reference this Identity provider did not record is INDISTINGUISHABLE
   *  from one that does not exist — A24's read boundary, exactly as the User
   *  rung states it. */
  private async require(provider: IdentityProvider, id: string): Promise<ScimGroupRecord> {
    const record = await directoryCarriageService.getReferenceForProvider(provider.id, id);
    if (!record) throw new ScimError(404, null, 'no such Group');
    return record;
  }
}

interface ParsedPatchPath {
  target: 'displayName' | 'members' | 'members-filtered';
  value?: string;
}

/**
 * The enumerated path set, and NOTHING else.
 *
 * A `null` path is the RFC's whole-resource form; this rung admits it only
 * when the operation's value is an object naming the mapped attributes, which
 * is what `PATCH` clients that do not use paths actually send. Every other
 * shape is `400 invalidPath`.
 */
export function parsePatchPath(path: string | null): ParsedPatchPath {
  if (path === null || path === '') {
    throw new ScimError(
      400,
      'invalidPath',
      'this endpoint requires an explicit path on every PATCH operation: displayName, members, '
        + 'or members[value eq "…"]',
    );
  }
  if (path === 'displayName') return { target: 'displayName' };
  if (path === 'members') return { target: 'members' };
  // `members[value eq "x"]` — the one filtered form RFC 7644 §3.5.2 shows for
  // multi-valued removal, matched exactly rather than by a general filter
  // parser: a general parser here would be a second, weaker copy of the User
  // filter parser and would admit paths this rung does not honour.
  const filtered = /^members\[\s*value\s+eq\s+"([^"]*)"\s*\]$/.exec(path);
  if (filtered) return { target: 'members-filtered', value: filtered[1] };
  throw new ScimError(
    400,
    'invalidPath',
    `unsupported PATCH path "${path}": this endpoint honours displayName, members, and members[value eq "…"]`,
  );
}

export const scimGroupProvisioningService = new ScimGroupProvisioningService();
