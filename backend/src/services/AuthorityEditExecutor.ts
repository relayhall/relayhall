// AuthorityEditExecutor.ts — AUTHZ amendment AZ-A13 "Edit in place for authority
// objects" (RATIFIED 2026-10-11, ruling E95, with the answers E93 and E94; card
// 1a38270d, stage 2).
//
// ONE EXECUTOR, FOUR PATHS (clause 7, E73). A Connector credential, a warrant
// and a grant are changed by EDITING the existing row: it keeps its id, a
// credential keeps its secret (key_id, secret_hash, secret_ciphertext and
// encryption_key_id are never written, clause 1), and the object's history
// gains one entry per edit carrying the value before and after (clause 14).
// `apply` is the one writer of the edited columns (register C-1 in the census
// suite): it locks the row, runs the stale check, re-runs the object's own
// validators and the caps (clause 8), writes the row, and writes the audit and,
// for a warrant, the `warrant.amended` event, in ONE transaction. Its callers:
//   1. the owner's direct NARROWING (clause 4a): root, an administrator login
//      session (AUTHORITY_EDIT_ACT, D-10) or the owning Account, no step-up;
//   2. the one-act WIDENING (clause 4b): root, an administrator, or the owning
//      Account within the access it holds itself (E94), with a single-use
//      step-up bound to (`<object>.edit`, object id) (D-10a): an Approval of
//      kind `authority-edit` is created APPROVED and the edit applied, in one
//      transaction;
//   3. a decided PENDING widening an agent filed (clause 6c), applied inside
//      the decide transaction on /approvals (AZ-A9 clause 6, unchanged);
//   4. the REVERT of a widening approved "until this task ends" (clause 6j,
//      E94), as a narrowing.
//
// DIRECTION (clause 3) is computed here from the stored state, never taken from
// the caller. A narrowing saves; anything else is a widening.
//
// THE SECRET is never read, written or recorded: the edit selects no secret
// column, the audit before/after are built from allowlists (clause 14), and no
// response carries a key.
import type { PoolClient } from 'pg';
import { randomUUID } from 'crypto';
import { pool } from '../db/connection';
import { auditService, type AuditActor } from './AuditService';
import { auditChainFor } from '../utils/auditChain';
import { principalService, CredentialPolicyError } from './PrincipalService';
import { warrantService, WarrantError, type WarrantAnchorInput } from './WarrantService';
import { grantService, GrantError, type GrantVerb } from './GrantService';
import { accessVehicleService } from './AccessVehicleService';
import { delegationService } from './DelegationService';
import { stepUpService, StepUpError, stepUpChallengeBody } from './StepUpService';
import { feedEventService, type FeedObjectType } from './FeedEventService';
import { AUTHORIZATION_ACTIONS, grantAllows } from './AuthorizationService';
import { issuingCeiling } from './ConnectorCredentialIssuance';
import type { ProfileRule } from './AccessProfileService';
import { validateRequestedScopes as validateIssuableScopes } from '../utils/credentialAuthority';
import { delegableScopes, scopesForRole } from '../utils/identityScopes';
import { rulesCovered, sourcesFromRules } from '../utils/authorityContainment';
import { logCaughtWarning } from '../utils/secretSafeLog';
import type { Scope } from '../utils/scopeMap';
import { assertDecisionEvidence, type DecisionEvidence } from '../utils/decisionEvidence';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DAY_MS = 24 * 60 * 60 * 1000;
/** clause 11d (E15): an approval-made grant row expires at most 90 days out. */
export const APPROVAL_GRANT_MAX_EXPIRY_MS = 90 * DAY_MS;
/** clause 9f: the revoke reason of a graced predecessor, and of an Agent the
 * narrow-all act empties (clause 9h). */
export const NARROWING_REVOKE_REASON = 'superseded by an AZ-A13 narrowing';

export const EDIT_OBJECT_TYPES = ['credential', 'warrant', 'grant'] as const;
export type EditObjectType = (typeof EDIT_OBJECT_TYPES)[number];
export type EditDirection = 'narrowing' | 'widening';
export type EditPath = 'direct' | 'approval-atomic' | 'approval-decided' | 'revert' | 'narrow-all';
export type EditEntryPoint = 'session' | 'mcp' | 'sweep';
export type EditorStanding = 'root' | 'administrator' | 'owning-account';
export type Transport = 'any' | 'mcp' | 'api';
export const TRANSPORTS: readonly Transport[] = ['any', 'mcp', 'api'];

/** clause 6h: every authority-edit item names, in words, the kind of object amended. */
export const OBJECT_KIND_LABELS: Record<EditObjectType, string> = {
  credential: 'Connector configuration',
  warrant: 'Warrant',
  grant: 'Grant',
};
/** clause 6h: and, once decided, the lifetime chosen. */
export const LIFETIME_LABELS: Record<'keep' | 'until-task', string> = {
  keep: 'Keep (until narrowed)',
  'until-task': 'Until this task ends',
};
/** clause 2: the editable fields, per object. Name and description of a
 * warrant keep their existing path; nothing else is editable in v1. */
export const EDITABLE_FIELDS: Record<EditObjectType, readonly string[]> = {
  credential: ['scopes', 'transport'],
  warrant: ['ceilingProfileId', 'ceilingRules', 'ceilingScopes', 'maxConcurrent', 'maxTotal', 'expiresAt', 'transportPin'],
  grant: ['verb', 'expiresAt', 'resourceId'],
};
/** The step-up action each object's one-act door binds to (D-10a). */
export const EDIT_STEP_UP_ACTIONS: Record<EditObjectType, string> = {
  credential: 'credential.edit',
  warrant: 'warrant.edit',
  grant: 'grant.edit',
};

export interface EditRefusal {
  rule: string;
  subject: 'editor' | 'decider' | 'requester' | 'target';
  clause: string;
  [detail: string]: unknown;
}

/** clause 13: `{error:'Refused', code, message, rule, subject, clause}`. */
export class AuthorityEditError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly refusal: EditRefusal,
  ) {
    super(message);
    this.name = 'AuthorityEditError';
  }
}

function refuse(
  status: number, code: string, message: string, subject: EditRefusal['subject'], clause: string | number, rule: string,
  detail: Record<string, unknown> = {},
): AuthorityEditError {
  return new AuthorityEditError(status, code, message, { rule, subject, clause: `AZ-A13 clause ${clause}`, ...detail });
}

/** A refusal raised by an object's OWN validator (a warrant's, a grant's, the
 * credential policy, the step-up store), re-raised in the AZ-A13 shape with the
 * same code and status, so a refusal names its rule whichever path raised it. */
function asEditRefusal(e: unknown, subject: EditRefusal['subject'], clause: string | number, rule: string): unknown {
  if (e instanceof AuthorityEditError) return e;
  if (e instanceof WarrantError || e instanceof GrantError || e instanceof CredentialPolicyError || e instanceof StepUpError) {
    // Card 7a99d63e (SU-14): a refused step-up keeps its challenge.
    return refuse(e.status, e.code, e.message, subject, clause, rule,
      e instanceof GrantError && e.field ? { field: e.field } : stepUpChallengeBody(e));
  }
  return e;
}

/**
 * E149 (owner ruling, 12 Oct 2026, "bind edits too"): answer E2 - an Agent
 * credential carries `knowledge-contents:write` only when its mint requests it
 * EXPLICITLY, inside the parent's own grants, never inherited
 * (`AgentMintService`'s request list plus the T2 ceiling) - governs EDITS as
 * well as mints. The scopes below are the edit-time twin of the Agent
 * exclusion list (`AGENT_EXCLUDED_SCOPES`): mintable onto an Agent, by an
 * explicit request at mint only. No edit adds one to an Agent credential,
 * whoever edits (root included, as E2 binds root at mint), on every door: the
 * session door, the decide of a filed request and the agent's door. The
 * refusal is named and sits AHEAD of the general clause 9e refusal
 * (AGENT_CREDENTIAL_NOT_EDITABLE), so the bind stands on its own even if an
 * Agent credential ever becomes editable for something else. The record E2
 * requires is the mint itself: a fresh mint that asks for the scope.
 */
export const AGENT_MINT_ONLY_SCOPES: ReadonlySet<Scope> = new Set<Scope>(['knowledge-contents:write']);

/** E149: the named refusal of an edit that would add a mint-only scope to an
 * Agent credential, or null. `adding` is what the edit or the filing adds. */
export function agentMintOnlyRefusal(principalKind: unknown, adding: unknown, subject: EditRefusal['subject']): AuthorityEditError | null {
  if (String(principalKind) !== 'agent' || !Array.isArray(adding)) return null;
  const mintOnly = [...new Set(adding.filter((scope): scope is string => typeof scope === 'string'
    && AGENT_MINT_ONLY_SCOPES.has(scope as Scope)))].sort();
  if (mintOnly.length === 0) return null;
  return refuse(422, 'AGENT_SCOPE_MINT_ONLY',
    `${mintOnly.join(', ')} reaches an Agent only when its mint requests it explicitly, inside the parent's grants (answer E2); an edit never adds it to an Agent credential, root included (E149): mint a fresh Agent that asks for it`,
    subject, '9e', 'knowledge-contents:write reaches an Agent credential only through an explicit request at mint (E2, E149), never by an edit',
    { mintOnly });
}

// ── states ─────────────────────────────────────────────────────────────────

export interface CredentialState { scopes: string[]; transport: Transport }
export interface WarrantState {
  ceilingProfileVersionId: string | null;
  ceilingScopes: string[] | null;
  maxConcurrent: number | null;
  maxTotal: number | null;
  expiresAt: string | null;
  transportPin: Transport;
}
export interface GrantState { verb: GrantVerb; expiresAt: string | null; resourceId: string | null }
export type EditState = CredentialState | WarrantState | GrantState;

/** A requested warrant state may name a ceiling the edit publishes (clause 10b). */
interface WarrantTarget extends WarrantState {
  /** Present when the edit publishes a NEW profile from inline rules. */
  ceilingRules?: ProfileRule[];
  /** The rules the target ceiling carries, for the direction and the caps. */
  ceilingRulesForCheck?: ProfileRule[];
}

export interface EditLifetime { choice: 'keep' | 'until-task'; taskId: string | null; revertAt: string | null }

/** clause 6j: a revert, field by field (`revertPlan`). */
export interface RevertPlan {
  /** The state the revert writes; every field it changes moves down. Null: nothing to write. */
  next: Record<string, unknown> | null;
  /** The fields where authority the widening added is still present and no narrowing removes it. */
  residual: string[];
  /** E148: the residuals the revert KEEPS, named in its records (`KeptResidual`). */
  kept: KeptResidual[];
}

/**
 * E148 (owner ruling, 12 Oct 2026, "extend the residual rule"): clause 6j's
 * residual rule, "the scopes it added are removed", extends to a credential's
 * transport, a warrant's transport pin and a grant's selector. A field the
 * widening moved up and a LATER edit moved again (the owning Account's
 * legitimate narrowing, say `any` -> `api` after `mcp` -> `any`), whose value
 * at the revert still exceeds its value before the widening, is a RESIDUAL: the
 * revert keeps it - it only narrows, and leaves a field a later edit moved as
 * it is, so nothing in its behaviour changes - and its records NAME it (the
 * closing ledger row and, when the revert writes, its edit audit row), so the
 * closing reason is never "nothing the widening added is still present" while
 * something is. The same naming covers every field, so the reason is true
 * whichever field a later edit moved.
 */
export interface KeptResidual {
  field: string;
  /** The value before the widening, the value it approved, and the value kept. */
  before: unknown;
  approved: unknown;
  now: unknown;
}

/** clause 6j: the closing reason when nothing the widening added is still present. */
export const NOTHING_REMAINS = 'nothing the widening added is still present';

/** A kept value in words, for the closing reason. */
function residualValue(field: string, value: unknown): string {
  if (value === null || value === undefined) {
    if (field === 'resourceId') return 'every object';
    if (field === 'expiresAt') return 'no expiry';
    if (field === 'ceilingScopes') return 'no scope cap';
    if (field === 'maxConcurrent' || field === 'maxTotal') return 'unlimited';
    return 'none';
  }
  return Array.isArray(value) ? `[${value.join(', ')}]` : String(value);
}

/** E148: the closing reason of a revert that wrote nothing and keeps a residual. */
export function residualReason(kept: KeptResidual[]): string {
  const named = kept.map((r) => `${r.field} ${residualValue(r.field, r.now)} (before the widening: `
    + `${residualValue(r.field, r.before)}; approved: ${residualValue(r.field, r.approved)})`).join('; ');
  return `kept as a residual: a later edit moved ${named}; each value kept still exceeds its value before the `
    + 'widening, and a revert only narrows and leaves a field a later edit moved as it is (AZ-A13 clause 6j, E148); '
    + 'nothing else the widening added is still present';
}

export interface EditorContext {
  principalId: string;
  standing: EditorStanding;
  /** The session's scope set NOW (req.scopes): the delegable ceiling is read
   * from it (clause 8a). */
  sessionScopes: string[];
  /** The editor's principal role (for the owning Account's role set, E94). */
  role?: string | null;
}

export interface EditResult {
  objectType: EditObjectType;
  objectId: string;
  direction: EditDirection;
  changed: string[];
  before: Record<string, unknown>;
  after: Record<string, unknown>;
  approvalId: string | null;
  auditId: string;
  lifetime: EditLifetime | null;
  narrowedAgents: Array<{ principalId: string; credentialId: string; scopes: string[] }>;
  revokedAgents: Array<{ principalId: string; credentialId: string }>;
  revokedPredecessorIds: string[];
  releasedTaskIds: string[];
}

type Queryable = { query: (text: string, params?: unknown[]) => Promise<{ rows: any[]; rowCount?: number | null }> };

const parseJson = <T>(value: unknown, fallback: T): T => {
  if (value === null || value === undefined) return fallback;
  if (typeof value === 'string') {
    try { return JSON.parse(value) as T; } catch { return fallback; }
  }
  return value as T;
};
const iso = (value: unknown): string | null => (value ? new Date(value as string).toISOString() : null);
const sameSet = (a: string[], b: string[]): boolean => a.length === b.length && a.every((x) => b.includes(x))
  && b.every((x) => a.includes(x));
const subset = (a: string[], b: string[]): boolean => a.every((x) => b.includes(x));
const canonicalId = (id: string): string => (UUID_PATTERN.test(id) ? id.toLowerCase() : id);

// ── clause 3: the direction, field by field ────────────────────────────────

export type FieldMove = 'same' | 'down' | 'up';

/** clause 3: "An edit is NARROWING when every field it changes moves down or
 * stays. Any other edit is WIDENING: one that moves a field up, one that moves
 * fields in both directions, and one that moves a field to a value not
 * comparable with the old." Incomparable is reported as `up`. */
export function transportMove(before: Transport, after: Transport): FieldMove {
  if (before === after) return 'same';
  if (before === 'any') return 'down';
  return 'up'; // mcp|api -> any, and mcp <-> api (not comparable)
}

export function scopeSetMove(before: string[], after: string[]): FieldMove {
  if (sameSet(before, after)) return 'same';
  return subset(after, before) ? 'down' : 'up';
}

/** `null` = no scope cap (authorityContainment.ts scopesWithin). */
export function scopeCeilingMove(before: string[] | null, after: string[] | null): FieldMove {
  if (before === null && after === null) return 'same';
  if (before === null) return 'down';
  if (after === null) return 'up';
  return scopeSetMove(before, after);
}

/** `null` = unlimited. */
export function capMove(before: number | null, after: number | null): FieldMove {
  if (before === after) return 'same';
  if (before === null) return 'down';
  if (after === null) return 'up';
  return after < before ? 'down' : 'up';
}

/** `null` = no expiry. */
export function expiryMove(before: string | null, after: string | null): FieldMove {
  const b = before ? new Date(before).getTime() : null;
  const a = after ? new Date(after).getTime() : null;
  if (b === a) return 'same';
  if (b === null) return 'down';
  if (a === null) return 'up';
  return a < b ? 'down' : 'up';
}

/** clause 3: "narrowing when every action the new verb allows, the old verb
 * allows too (grantAllows)". */
export function verbMove(before: GrantVerb, after: GrantVerb): FieldMove {
  if (before === after) return 'same';
  return AUTHORIZATION_ACTIONS.every((action) => !grantAllows(after, action) || grantAllows(before, action)) ? 'down' : 'up';
}

/** One id -> null (every object) is widening; null -> one id narrowing; A -> B
 * not comparable (widening). */
export function selectorMove(before: string | null, after: string | null): FieldMove {
  const b = before ? before.toLowerCase() : null;
  const a = after ? after.toLowerCase() : null;
  if (b === a) return 'same';
  if (b === null) return 'down';
  return 'up';
}

/** clause 3, the warrant ceiling: "narrowing when
 * rulesCovered(sourcesFromRules(before), after) holds". */
export function ceilingMove(beforeVersion: string | null, afterVersion: string | null, beforeRules: ProfileRule[],
  afterRules: ProfileRule[], republished: boolean): FieldMove {
  if (!republished && beforeVersion === afterVersion) return 'same';
  return rulesCovered(sourcesFromRules(beforeRules), afterRules).covered ? 'down' : 'up';
}

export interface Classification { direction: EditDirection; changed: string[]; moves: Record<string, FieldMove> }

function classification(moves: Record<string, FieldMove>): Classification {
  const changed = Object.entries(moves).filter(([, move]) => move !== 'same').map(([field]) => field);
  const widening = Object.values(moves).some((move) => move === 'up');
  return { direction: widening ? 'widening' : 'narrowing', changed, moves };
}

export function classifyCredential(before: CredentialState, after: CredentialState): Classification {
  return classification({
    scopes: scopeSetMove(before.scopes, after.scopes),
    transport: transportMove(before.transport, after.transport),
  });
}

export function classifyGrant(before: GrantState, after: GrantState): Classification {
  return classification({
    verb: verbMove(before.verb, after.verb),
    expiresAt: expiryMove(before.expiresAt, after.expiresAt),
    resourceId: selectorMove(before.resourceId, after.resourceId),
  });
}

function classifyWarrant(before: WarrantState, after: WarrantTarget, beforeRules: ProfileRule[]): Classification {
  return classification({
    ceiling: ceilingMove(before.ceilingProfileVersionId, after.ceilingProfileVersionId, beforeRules,
      after.ceilingRulesForCheck ?? beforeRules, Boolean(after.ceilingRules)),
    ceilingScopes: scopeCeilingMove(before.ceilingScopes, after.ceilingScopes),
    maxConcurrent: capMove(before.maxConcurrent, after.maxConcurrent),
    maxTotal: capMove(before.maxTotal, after.maxTotal),
    expiresAt: expiryMove(before.expiresAt, after.expiresAt),
    transportPin: transportMove(before.transportPin, after.transportPin),
  });
}

/** clause 6e: the object's editable fields equal the snapshot taken at filing. */
export function statesEqual(type: EditObjectType, a: Record<string, unknown>, b: Record<string, unknown>): boolean {
  if (type === 'credential') {
    return sameSet((a.scopes as string[]) ?? [], (b.scopes as string[]) ?? []) && a.transport === b.transport;
  }
  if (type === 'warrant') {
    const scopesA = (a.ceilingScopes as string[] | null) ?? null;
    const scopesB = (b.ceilingScopes as string[] | null) ?? null;
    return (a.ceilingProfileVersionId ?? null) === (b.ceilingProfileVersionId ?? null)
      && ((scopesA === null && scopesB === null) || (scopesA !== null && scopesB !== null && sameSet(scopesA, scopesB)))
      && (a.maxConcurrent ?? null) === (b.maxConcurrent ?? null)
      && (a.maxTotal ?? null) === (b.maxTotal ?? null)
      && expiryMove((a.expiresAt as string | null) ?? null, (b.expiresAt as string | null) ?? null) === 'same'
      && a.transportPin === b.transportPin;
  }
  return a.verb === b.verb
    && expiryMove((a.expiresAt as string | null) ?? null, (b.expiresAt as string | null) ?? null) === 'same'
    && selectorMove((a.resourceId as string | null) ?? null, (b.resourceId as string | null) ?? null) === 'same';
}

// ── the locked object ──────────────────────────────────────────────────────

interface LockedObject {
  type: EditObjectType;
  id: string;
  row: any;
  state: EditState;
  /** The principal that holds it: the Connector, the warrant holder, a grant's
   * principal grantee (null for a Group grantee). */
  holderPrincipalId: string | null;
  /** The allowlisted fields clause 14 records beside the state. */
  identity: Record<string, unknown>;
  /** A warrant's anchors and the rules of its pinned ceiling. */
  anchors?: WarrantAnchorInput[];
  ceilingRules?: ProfileRule[];
}

/** clause 14's allowlist: the state plus the identity fields, nothing else. */
function snapshot(object: LockedObject, state: Record<string, unknown>, extra: Record<string, unknown> = {}): Record<string, unknown> {
  if (object.type === 'credential') {
    const s = state as unknown as CredentialState;
    return { scopes: [...s.scopes], transport: s.transport, keyId: object.identity.keyId ?? null };
  }
  if (object.type === 'warrant') {
    const s = state as unknown as WarrantState;
    return {
      ceilingProfileVersionId: s.ceilingProfileVersionId, ceilingScopes: s.ceilingScopes ? [...s.ceilingScopes] : null,
      maxConcurrent: s.maxConcurrent, maxTotal: s.maxTotal, expiresAt: s.expiresAt, transportPin: s.transportPin,
      releasedTaskIds: (extra.releasedTaskIds as string[] | undefined) ?? [],
    };
  }
  const s = state as unknown as GrantState;
  return {
    verb: s.verb, expiresAt: s.expiresAt, resourceId: s.resourceId,
    resourceType: object.identity.resourceType, granteeType: object.identity.granteeType, granteeId: object.identity.granteeId,
  };
}

function credentialState(row: any): CredentialState {
  return { scopes: parseJson<string[]>(row.scopes, []), transport: (row.transport ?? 'any') as Transport };
}

function warrantState(row: any): WarrantState {
  return {
    ceilingProfileVersionId: row.ceiling_profile_version_id ? String(row.ceiling_profile_version_id) : null,
    ceilingScopes: parseJson<string[] | null>(row.ceiling_scopes, null),
    maxConcurrent: row.max_concurrent === null || row.max_concurrent === undefined ? null : Number(row.max_concurrent),
    maxTotal: row.max_total === null || row.max_total === undefined ? null : Number(row.max_total),
    expiresAt: iso(row.expires_at),
    transportPin: (row.transport_pin ?? 'any') as Transport,
  };
}

function grantState(row: any): GrantState {
  return {
    verb: row.verb as GrantVerb,
    expiresAt: iso(row.expires_at),
    resourceId: row.resource_id ? String(row.resource_id).toLowerCase() : null,
  };
}

export class AuthorityEditExecutor {
  /** The holder of an object, unlocked, for a route's standing test (clause
   * 4a: the owning Account's subtree). Null when no such object exists. */
  async resolveHolder(type: EditObjectType, id: string): Promise<{ holderPrincipalId: string | null } | null> {
    if (!UUID_PATTERN.test(id ?? '')) return null;
    if (type === 'credential') {
      const row = (await pool.query('SELECT principal_id FROM principal_credentials WHERE id = $1', [id])).rows[0];
      return row ? { holderPrincipalId: String(row.principal_id) } : null;
    }
    if (type === 'warrant') {
      const row = (await pool.query('SELECT holder_principal_id FROM warrants WHERE id = $1', [id])).rows[0];
      return row ? { holderPrincipalId: String(row.holder_principal_id) } : null;
    }
    const row = (await pool.query('SELECT grantee_type, grantee_id FROM grants WHERE id = $1', [id])).rows[0];
    return row ? { holderPrincipalId: row.grantee_type === 'principal' ? String(row.grantee_id) : null } : null;
  }

  /** Lock the object (FOR UPDATE) and read its editable state (clause 7 step 1). */
  async lockObject(client: Queryable, type: EditObjectType, id: string, lock = true): Promise<LockedObject | null> {
    if (!UUID_PATTERN.test(id ?? '')) return null;
    const forUpdate = lock ? ' FOR UPDATE' : '';
    if (type === 'credential') {
      // Never a secret column (clause 14).
      const row = (await client.query(
        `SELECT id, principal_id, credential_type, key_id, label, scopes, transport, expires_at, revoked_at,
                grace_until, rotated_from_id, metadata
           FROM principal_credentials WHERE id = $1${forUpdate}`,
        [id])).rows[0];
      if (!row) return null;
      return {
        type, id: String(row.id), row, state: credentialState(row), holderPrincipalId: String(row.principal_id),
        identity: { keyId: row.key_id ?? null },
      };
    }
    if (type === 'warrant') {
      const row = (await client.query(`SELECT * FROM warrants WHERE id = $1${forUpdate}`, [id])).rows[0];
      if (!row) return null;
      const anchors = (await client.query(
        'SELECT anchor_type, anchor_id FROM warrant_anchors WHERE warrant_id = $1 ORDER BY anchor_type, anchor_id', [id]))
        .rows.map((a) => ({ anchorType: a.anchor_type, anchorId: String(a.anchor_id) })) as WarrantAnchorInput[];
      const ceilingRules = row.ceiling_profile_version_id
        ? await warrantService.rulesOfVersion(String(row.ceiling_profile_version_id))
        : parseJson<ProfileRule[]>(row.ceiling_rules, []);
      return {
        type, id: String(row.id), row, state: warrantState(row), holderPrincipalId: String(row.holder_principal_id),
        identity: {}, anchors, ceilingRules,
      };
    }
    const row = (await client.query(`SELECT * FROM grants WHERE id = $1${forUpdate}`, [id])).rows[0];
    if (!row) return null;
    return {
      type, id: String(row.id), row, state: grantState(row),
      holderPrincipalId: row.grantee_type === 'principal' ? String(row.grantee_id) : null,
      identity: { resourceType: row.resource_type, granteeType: row.grantee_type, granteeId: String(row.grantee_id) },
    };
  }

  /** clause 2 and 9e: the targets an edit refuses. `liveOnly` false is the
   * revert's reading: a dead object closes its record instead. `adding` is
   * what the edit adds to a credential's scopes (E149). */
  async editableProblem(client: Queryable, object: LockedObject, adding: string[] = []): Promise<AuthorityEditError | null> {
    if (object.type === 'credential') {
      const row = object.row;
      const principal = (await client.query(
        'SELECT id, kind, status, legacy_identity, parent_principal_id FROM principals WHERE id = $1',
        [row.principal_id])).rows[0];
      if (principal?.legacy_identity || row.credential_type === 'legacy_env') {
        return refuse(409, 'LEGACY_FROZEN', 'a legacy credential is frozen and is not edited (§10, T37)', 'target', '9e',
          'a legacy credential is never edited');
      }
      if (row.credential_type !== 'api_key' || !principal || !principal.parent_principal_id) {
        return refuse(422, 'ACCOUNTS_ARE_KEYLESS',
          'only a Connector credential is edited in place: an Account holds no bearer credential (A17.1/§7.1)', 'target', 2,
          "the edited credential is a Connector's api_key credential");
      }
      const mintOnly = agentMintOnlyRefusal(principal.kind, adding, 'target');
      if (mintOnly) return mintOnly;
      if (String(principal.kind) === 'agent') {
        return refuse(422, 'AGENT_CREDENTIAL_NOT_EDITABLE',
          'an Agent credential is never edited: a fresh Agent is a fresh mint (§7.3); narrow it through its Connector or warrant, or revoke it',
          'target', '9e', 'an Agent credential is never the target of an edit');
      }
      if (parseJson<Record<string, unknown>>(row.metadata, {}).issued_by === 'oauth') {
        return refuse(409, 'OAUTH_CREDENTIAL_RECONSENT',
          'a connection made by OAuth sign-in is changed by re-authorizing the application: its own() holds the consented scopes (DD-6)',
          'target', '9e', 'an OAuth-issued credential is re-authorized, not edited');
      }
      const now = Date.now();
      if (row.revoked_at || row.grace_until || (row.expires_at && new Date(row.expires_at).getTime() <= now)
        || String(principal.status) !== 'active' || String(principal.kind) !== 'service') {
        return refuse(409, 'CREDENTIAL_NOT_LIVE',
          'the credential is revoked, in rotation grace or expired, or its Connector is not active, so it is not edited',
          'target', '9e', 'only a live credential of an active Connector is edited');
      }
      return null;
    }
    if (object.type === 'warrant') {
      if (['revoked', 'expired'].includes(String(object.row.status))) {
        return refuse(409, 'WARRANT_NOT_EDITABLE', `a ${object.row.status} warrant is one-way (§6.2) and is not edited`,
          'target', '10d', 'revoked and expired warrants refuse every edit');
      }
      return null;
    }
    if (object.row.provenance) {
      return refuse(409, 'GRANT_CARRIES_ASSIGNMENT',
        'this grant carries an execution assignment’s access (ruling 7440b579 R1) — change it by unassigning the task, or through the warrant that carries it',
        'target', '11c', 'a grant with provenance set is never edited');
    }
    if (String(object.row.origin ?? 'manual') !== 'manual') {
      return refuse(422, 'GRANT_ORIGIN_NOT_EDITABLE',
        `a ${object.row.origin} grant records an act; change it through the act that owns it (DD-4)`,
        'target', '11c', 'only a manual grant row is edited');
    }
    return null;
  }

  // ── reading a request into the target state ─────────────────────────────

  /** clause 2: the fields a body may name. Anything else is refused by name. */
  private assertEditableFields(type: EditObjectType, fields: Record<string, unknown>): void {
    const allowed = EDITABLE_FIELDS[type];
    const outside = Object.keys(fields).filter((field) => !allowed.includes(field)).sort();
    if (outside.length > 0) {
      throw refuse(422, 'EDIT_FIELD_NOT_EDITABLE',
        `${outside.join(', ')} ${outside.length > 1 ? 'are' : 'is'} not editable in place on a ${type} (AZ-A13 clause 2); editable: ${allowed.join(', ')}`,
        'editor', 2, `a ${type} edit changes only ${allowed.join(', ')}`, { fields: outside });
    }
  }

  private credentialTarget(object: LockedObject, fields: Record<string, unknown>): CredentialState {
    const before = object.state as CredentialState;
    let scopes = before.scopes;
    if (fields.scopes !== undefined) {
      if (!Array.isArray(fields.scopes) || fields.scopes.length === 0 || fields.scopes.some((s) => typeof s !== 'string')) {
        throw refuse(422, 'INVALID_SCOPES',
          'scopes must be a non-empty array of scope strings: a credential that should carry nothing is disabled, not edited',
          'editor', 2, 'the scope set is a non-empty array');
      }
      const vocabulary = validateIssuableScopes(fields.scopes, { canManage: true, grantableScopes: null });
      if (!vocabulary.ok) {
        throw refuse(422, 'INVALID_SCOPES', vocabulary.error, 'editor', '8a', 'every scope is in the vocabulary and mintable');
      }
      scopes = vocabulary.scopes;
    }
    let transport = before.transport;
    if (fields.transport !== undefined) {
      if (typeof fields.transport !== 'string' || !(TRANSPORTS as readonly string[]).includes(fields.transport)) {
        throw refuse(422, 'INVALID_TRANSPORT', "transport must be 'any', 'mcp' or 'api'", 'editor', '8a',
          'the transport pin is any, mcp or api');
      }
      transport = fields.transport as Transport;
    }
    return { scopes, transport };
  }

  private async warrantTarget(object: LockedObject, fields: Record<string, unknown>): Promise<WarrantTarget> {
    const before = object.state as WarrantState;
    const pick = (field: string, current: unknown) => (fields[field] !== undefined ? fields[field] : current);
    let prepared;
    try {
      prepared = await warrantService.prepareAuthorityFields({
        ceilingProfileId: fields.ceilingProfileId,
        ceilingRules: fields.ceilingRules,
        ceilingScopes: pick('ceilingScopes', before.ceilingScopes),
        expiresAt: pick('expiresAt', before.expiresAt),
        transportPin: pick('transportPin', before.transportPin),
        maxConcurrent: pick('maxConcurrent', before.maxConcurrent),
        maxTotal: pick('maxTotal', before.maxTotal),
      }, object.anchors ?? [], {
        currentCeiling: { versionId: before.ceilingProfileVersionId, rules: object.ceilingRules ?? [] },
      });
    } catch (e) {
      throw asEditRefusal(e, 'editor', '8b', 'the creation validators re-run on the state after the edit');
    }
    const republish = fields.ceilingRules !== undefined && fields.ceilingRules !== null;
    return {
      ceilingProfileVersionId: republish ? null : prepared.ceilingProfileVersionId,
      ceilingScopes: prepared.ceilingScopes,
      maxConcurrent: prepared.maxConcurrent,
      maxTotal: prepared.maxTotal,
      expiresAt: prepared.expiresAt ? prepared.expiresAt.toISOString() : null,
      transportPin: prepared.transportPin as Transport,
      ...(republish ? { ceilingRules: prepared.ceilingRulesForCheck } : {}),
      ceilingRulesForCheck: prepared.ceilingRulesForCheck,
    };
  }

  private async grantTarget(object: LockedObject, fields: Record<string, unknown>, actor: AuditActor): Promise<GrantState> {
    const before = object.state as GrantState;
    const verb = fields.verb !== undefined ? fields.verb : before.verb;
    const expiresAt = fields.expiresAt !== undefined ? fields.expiresAt : before.expiresAt;
    const resourceId = fields.resourceId !== undefined ? fields.resourceId : before.resourceId;
    let validated: { resourceId: string | null; expiresAt: string | null };
    try {
      validated = await grantService.validateGrantFields(
        { resourceType: object.row.resource_type, resourceId, verb, expiresAt }, actor, 'grant.edit');
    } catch (e) {
      throw asEditRefusal(e, 'editor', '8c', "GrantService.create's validators re-run on the state after the edit");
    }
    // clause 11d (E15): a row an approval made keeps the 142 shape and a
    // later expiry is capped at the edit's time plus 90 days.
    if (object.row.approval_id) {
      if (!validated.expiresAt) {
        throw refuse(422, 'EXPIRY_REQUIRED', 'a grant row an approval made always expires (migration 142; E15)', 'editor', '11d',
          'an approval-made row keeps expires_at NOT NULL');
      }
      if (new Date(validated.expiresAt).getTime() > Date.now() + APPROVAL_GRANT_MAX_EXPIRY_MS
        && expiryMove(before.expiresAt, validated.expiresAt) === 'up') {
        throw refuse(422, 'EXPIRY_TOO_LONG', 'an approval-made grant row expires at most 90 days from the edit (E15)', 'editor', '11d',
          'a later expiry is capped at the edit time plus 90 days');
      }
    }
    return {
      verb: verb as GrantVerb,
      expiresAt: validated.expiresAt,
      resourceId: validated.resourceId ? validated.resourceId.toLowerCase() : null,
    };
  }

  /** Read a body into the full target state of `object`, and classify it. */
  async target(object: LockedObject, fields: Record<string, unknown>, actor: AuditActor): Promise<{ after: Record<string, unknown>; classification: Classification }> {
    this.assertEditableFields(object.type, fields);
    if (object.type === 'credential') {
      const after = this.credentialTarget(object, fields);
      return { after: after as unknown as Record<string, unknown>, classification: classifyCredential(object.state as CredentialState, after) };
    }
    if (object.type === 'warrant') {
      const after = await this.warrantTarget(object, fields);
      return {
        after: after as unknown as Record<string, unknown>,
        classification: classifyWarrant(object.state as WarrantState, after, object.ceilingRules ?? []),
      };
    }
    const after = await this.grantTarget(object, fields, actor);
    return { after: after as unknown as Record<string, unknown>, classification: classifyGrant(object.state as GrantState, after) };
  }

  // ── clause 8: the caps ───────────────────────────────────────────────────

  /**
   * The caps a WIDENING must pass, by the decider's standing (clause 8). A
   * narrowing passes the object's own validators only (run while reading the
   * target), plus the credential policy.
   */
  private async assertCaps(client: Queryable, object: LockedObject, after: Record<string, unknown>,
    classification: Classification, decider: EditorContext | null, actor: AuditActor): Promise<void> {
    if (object.type === 'credential') {
      const target = after as unknown as CredentialState;
      // The policy, ONE copy (clause 7 P-2): both directions.
      try {
        await principalService.assertCredentialPolicy(
          { principalId: String(object.row.principal_id), scopes: target.scopes, transport: target.transport },
          actor, client as PoolClient, 'credential.edit', { type: 'credential', id: object.id });
      } catch (e) {
        throw asEditRefusal(e, 'target', '8a', 'PrincipalService.assertCredentialPolicy admits the state after the edit');
      }
      if (classification.direction !== 'widening' || !decider) return;
      const before = object.state as CredentialState;
      const added = target.scopes.filter((scope) => !before.scopes.includes(scope));
      // The chain: the Connector's own() and its chain-root Account's role set.
      const chain = await delegationService.resolveChain(String(object.row.principal_id), client);
      const account = chain.links[chain.links.length - 1];
      if (decider.standing === 'owning-account') {
        // E94: the owning Account widens within the access it holds itself —
        // its own delegable set and its own role set — or is REFUSED, never
        // routed as a request.
        const own: string[] = delegableScopes(decider.sessionScopes);
        const roleSet: string[] = scopesForRole(decider.role ?? null);
        const beyond = added.filter((scope) => !own.includes(scope)
          || (!roleSet.includes('root') && !roleSet.includes(scope)));
        if (beyond.length > 0) {
          throw refuse(403, 'EXCEEDS_ACCOUNT_AUTHORITY',
            `you can add only access you hold yourself (AZ-A13 clause 4b, E94): ${beyond.join(', ')} lies beyond it. Nothing was saved and no request was filed.`,
            'editor', '4b', 'an owning Account widens its own Connector within the access it holds itself; beyond it is refused, never filed',
            { exceeding: beyond });
        }
      } else {
        // clause 8a: within the decider's delegable set (AZ-A9 clause 11's
        // ceiling function, ONE copy: `issuingCeiling`).
        const { exceeding } = issuingCeiling({ scopes: decider.sessionScopes }, added);
        if (exceeding.length > 0) {
          throw refuse(403, 'DECIDER_CEILING_EXCEEDED',
            `the added scopes exceed what this decider may put on a credential: ${exceeding.join(', ')}`,
            'decider', '8a', "the added scopes lie within the decider's delegable set", { exceeding });
        }
      }
      // clause 8a: within the chain-root Account's role set; a root sentinel is
      // the SUPERSET, never a literal one-element intersection.
      const accountScopes: string[] = scopesForRole(account.role);
      if (!accountScopes.includes('root')) {
        const beyond = added.filter((scope) => !accountScopes.includes(scope));
        if (beyond.length > 0) {
          throw refuse(403, 'EXCEEDS_ACCOUNT_AUTHORITY',
            `the Connector's Account (role ${account.role ?? 'none'}) cannot exercise ${beyond.join(', ')}: the chain would intersect it away, so it is refused rather than saved as dead configuration`,
            'target', '8a', "the added scopes lie within the chain-root Account's role set", { exceeding: beyond });
        }
      }
      // clause 8a: within the Connector's own() when it is a list.
      const connector = chain.links[0];
      const own = connector.ownExpression;
      if (!own || (own.scopes !== 'parent' && added.some((scope) => !(own.scopes as string[]).includes(scope)))) {
        const beyond = own && own.scopes !== 'parent' ? added.filter((scope) => !(own.scopes as string[]).includes(scope)) : added;
        throw refuse(403, 'EXCEEDS_CONNECTOR_OWN',
          `the Connector's own() expression does not reach ${beyond.join(', ')}: widen own() or re-authorize the connection`,
          'target', '8a', "the added scopes lie within the Connector's own() when it is a list", { exceeding: beyond });
      }
      return;
    }
    if (object.type === 'warrant') {
      const target = after as unknown as WarrantTarget;
      if (classification.direction !== 'widening' || !decider) return;
      if (decider.standing === 'owning-account') {
        // clause 8b (E94): the owning Account's own authority, measured by the
        // creation containment test with the Account in the creator's place.
        const problem = await warrantService.ceilingContainmentProblem(
          decider.principalId, decider.sessionScopes, target.ceilingRulesForCheck ?? object.ceilingRules ?? [], target.ceilingScopes);
        if (problem) {
          throw refuse(403, 'EXCEEDS_ACCOUNT_AUTHORITY',
            `you can give a warrant only access you hold yourself (AZ-A13 clause 4b, E94): ${problem.exceedingScopes.length > 0 ? problem.exceedingScopes.join(', ') : JSON.stringify(problem.failing)}. Nothing was saved and no request was filed.`,
            'editor', '8b', 'an owning Account widens its own warrant within the access it holds itself',
            { exceeding: problem.exceedingScopes, failingRule: problem.failing ?? null });
        }
      }
      // clause 8b: the creator's live cap on the state after the edit (AZ-31a).
      const creatorProblem = await warrantService.creatorCapProblem(client, {
        ...object.row,
        ceiling_profile_version_id: target.ceilingRules ? null : target.ceilingProfileVersionId,
        ceiling_rules: target.ceilingRules ? JSON.stringify(target.ceilingRules) : object.row.ceiling_rules,
        ceiling_scopes: target.ceilingScopes ? JSON.stringify(target.ceilingScopes) : null,
      });
      if (creatorProblem) {
        throw refuse(403, 'CEILING_EXCEEDS_CREATOR',
          `the widened warrant would exceed its creator's current authority (AZ-31a), and would auto-suspend: ${creatorProblem}`,
          'target', '8b', "a widening keeps the ceiling within the creator's current authority");
      }
      return;
    }
    // Grants: root is the only editor (clause 4a), so the decider's ceiling
    // reduces to the closures, which ran while reading the target.
  }

  /** clause 9d: the transport pin is loosened by root or an administrator only. */
  private assertTransportStanding(object: LockedObject, classification: Classification, editor: EditorContext): void {
    const field = object.type === 'credential' ? 'transport' : object.type === 'warrant' ? 'transportPin' : null;
    if (!field || classification.moves[field] !== 'up') return;
    if (editor.standing === 'root' || editor.standing === 'administrator') return;
    throw refuse(403, 'AUTHORITY_EDIT_REQUIRES_ADMINISTRATOR',
      'only root or an administrator loosens a transport pin (AZ-A13 clause 9d): you may tighten it, never loosen it, and it is never filed as a request',
      'editor', '9d', 'the transport pin is loosened only by root or an administrator, with step-up');
  }

  // ── lifetime (clause 6j) ─────────────────────────────────────────────────

  /** clause 6j (E94): every approved widening carries its decider's lifetime
   * choice; "until this task ends" names a related task or a future date. */
  async parseLifetime(client: Queryable, raw: unknown, relatedTaskId: string | null): Promise<EditLifetime> {
    const required = (message: string) => refuse(422, 'EDIT_LIFETIME_REQUIRED', message, 'decider', '6j',
      'every approved widening carries its lifetime: keep, or until this task ends (a related task or a future date)');
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      throw required('a widening needs its lifetime: lifetime {choice: "keep"} or {choice: "until-task", taskId and/or revertAt}');
    }
    const value = raw as Record<string, unknown>;
    if (value.choice === 'keep') return { choice: 'keep', taskId: null, revertAt: null };
    if (value.choice !== 'until-task') throw required('lifetime.choice is "keep" or "until-task"');
    let taskId: string | null = null;
    if (value.taskId !== undefined && value.taskId !== null) {
      if (typeof value.taskId !== 'string' || !UUID_PATTERN.test(value.taskId)) throw required('lifetime.taskId must be a full UUID');
      taskId = value.taskId.toLowerCase();
    } else if (relatedTaskId) {
      taskId = relatedTaskId.toLowerCase();
    }
    let revertAt: string | null = null;
    if (value.revertAt !== undefined && value.revertAt !== null) {
      const parsed = typeof value.revertAt === 'string' ? new Date(value.revertAt) : new Date(Number.NaN);
      if (Number.isNaN(parsed.getTime()) || parsed.getTime() <= Date.now()) {
        throw required('lifetime.revertAt must be a future ISO timestamp');
      }
      revertAt = parsed.toISOString();
    }
    if (taskId) {
      const task = (await client.query('SELECT status FROM tasks WHERE id = $1', [taskId])).rows[0];
      if (!task) throw required('lifetime.taskId resolves to no task');
      if (['completed', 'archived'].includes(String(task.status)) && !revertAt) {
        throw required(`the task is already ${task.status}: name an open task or a future revertAt`);
      }
    }
    if (!taskId && !revertAt) throw required('"until this task ends" names the task (lifetime.taskId) or a future date (lifetime.revertAt)');
    return { choice: 'until-task', taskId, revertAt };
  }

  // ── apply (clause 7 steps 3-5) ───────────────────────────────────────────

  /**
   * THE ONE WRITER of the edited columns. Runs inside `client`'s transaction,
   * on a row `lockObject` locked. Writes the row, the clause-14 audit (and, for
   * a warrant, `warrant.amended`), and for a narrowing the graced-predecessor
   * revoke (9f) and, when asked, the narrow-all act (9h, 10g).
   */
  private async apply(client: PoolClient, object: LockedObject, input: {
    after: Record<string, unknown>;
    classification: Classification;
    path: EditPath;
    approvalId: string | null;
    entryPoint: EditEntryPoint;
    deciderStanding: EditorStanding | null;
    stepUp: { tokenId: string; method: string } | null;
    lifetime: EditLifetime | null;
    follows: string | null;
    narrowAgents: boolean;
    acknowledgeDependents: boolean;
    creatorPrincipalId: string | null;
    /** E148: on a revert, the residuals it keeps, named in its audit row. */
    residual?: KeptResidual[];
  }, actor: AuditActor): Promise<EditResult> {
    const result: EditResult = {
      objectType: object.type, objectId: object.id, direction: input.classification.direction,
      changed: input.classification.changed, before: snapshot(object, object.state as unknown as Record<string, unknown>),
      after: {}, approvalId: input.approvalId, auditId: '', lifetime: input.lifetime,
      narrowedAgents: [], revokedAgents: [], revokedPredecessorIds: [], releasedTaskIds: [],
    };
    let finalState: Record<string, unknown> = input.after;
    if (object.type === 'credential') {
      const target = input.after as unknown as CredentialState;
      // clause 9a: the edit is made IN PLACE, on the credential's row, and
      // writes nothing but the scope set and the pin.
      await client.query(
        `UPDATE principal_credentials SET scopes = $2::jsonb, transport = $3 WHERE id = $1`,
        [object.id, JSON.stringify(target.scopes), target.transport],
      );
      finalState = { scopes: target.scopes, transport: target.transport };
    } else if (object.type === 'warrant') {
      const target = input.after as unknown as WarrantTarget;
      const ceilingMoves = input.classification.moves.ceiling !== 'same';
      if (ceilingMoves) {
        // clause 10c (ruling 7440b579 R4, Q2): tasks riding the warrant are
        // released, after acknowledgement, inside this transaction.
        const dependents = await accessVehicleService.dependentOpenTasks(object.id, client);
        if (dependents.length > 0 && !input.acknowledgeDependents) {
          throw refuse(409, 'WARRANT_HAS_DEPENDENT_TASKS',
            `editing this warrant's ceiling will UNASSIGN ${dependents.length} not-yet-terminal task(s) that ride it (ruling 7440b579 R4). Re-send with acknowledgeDependents to proceed`,
            'editor', '10c', 'a ceiling edit while tasks ride the warrant releases them only after acknowledgement',
            { dependentCount: dependents.length });
        }
      }
      let versionId = target.ceilingProfileVersionId;
      if (target.ceilingRules) {
        // clause 10b: the server publishes a NEW profile from the rules inside
        // the edit act and pins it; the old version stays immutable.
        versionId = await warrantService.publishCeilingProfile(
          client, String(object.row.name), target.ceilingRules, input.creatorPrincipalId ?? String(object.row.created_by_principal_id), actor);
      }
      await client.query(
        `UPDATE warrants
            SET ceiling_profile_version_id = $2, ceiling_rules = $3::jsonb, ceiling_scopes = $4::jsonb,
                max_concurrent = $5, max_total = $6, expires_at = $7, transport_pin = $8, updated_at = NOW()
          WHERE id = $1`,
        [
          object.id, versionId,
          versionId ? null : (object.row.ceiling_rules === null || object.row.ceiling_rules === undefined ? null : JSON.stringify(parseJson(object.row.ceiling_rules, null))),
          target.ceilingScopes ? JSON.stringify(target.ceilingScopes) : null,
          target.maxConcurrent, target.maxTotal, target.expiresAt, target.transportPin,
        ],
      );
      if (ceilingMoves) {
        const released = await accessVehicleService.releaseWarrant(client, object.id, actor,
          'AZ-A13: the carrying warrant’s ceiling was edited (clause 10c, ruling 7440b579 R4)');
        result.releasedTaskIds = released.unassignedTaskIds;
      }
      finalState = {
        ceilingProfileVersionId: versionId, ceilingScopes: target.ceilingScopes, maxConcurrent: target.maxConcurrent,
        maxTotal: target.maxTotal, expiresAt: target.expiresAt, transportPin: target.transportPin,
      };
    } else {
      const target = input.after as unknown as GrantState;
      // clause 11e: the edited tuple must not equal another live row; an
      // expired identical row is deleted in the same transaction.
      const clash = (await client.query(
        `SELECT id, expires_at FROM grants
          WHERE id <> $1 AND grantee_type = $2 AND grantee_id = $3 AND resource_type = $4
            AND resource_id IS NOT DISTINCT FROM $5::uuid AND verb = $6
          FOR UPDATE`,
        [object.id, object.row.grantee_type, object.row.grantee_id, object.row.resource_type, target.resourceId, target.verb])).rows[0];
      if (clash) {
        const live = !clash.expires_at || new Date(clash.expires_at).getTime() > Date.now();
        if (live) {
          throw refuse(409, 'GRANT_EXISTS', `an identical grant already exists: grant ${clash.id}`, 'editor', '11e',
            'the edited tuple must not equal another live row', { existingGrantId: String(clash.id) });
        }
        await client.query('DELETE FROM grants WHERE id = $1', [clash.id]);
        await auditService.record({
          action: 'grant.revoke', actor, resourceType: 'grant', resourceId: String(clash.id),
          metadata: { automatic: true, reason: 'EXPIRED_REPLACED', clause: 'AZ-A13 clause 11e', replacedBy: object.id },
        }, client);
      }
      await client.query(
        `UPDATE grants SET verb = $2, expires_at = $3, resource_id = $4::uuid WHERE id = $1`,
        [object.id, target.verb, target.expiresAt, target.resourceId],
      );
      finalState = { verb: target.verb, expiresAt: target.expiresAt, resourceId: target.resourceId };
    }
    result.after = snapshot(object, finalState, { releasedTaskIds: result.releasedTaskIds });

    const chain = object.holderPrincipalId ? await auditChainFor(client, object.holderPrincipalId) : [];
    const audit = await auditService.record({
      action: EDIT_STEP_UP_ACTIONS[object.type], actor, resourceType: object.type, resourceId: object.id,
      metadata: {
        clause: 'AZ-A13', direction: input.classification.direction, path: input.path, approvalId: input.approvalId,
        entryPoint: input.entryPoint, changed: input.classification.changed, before: result.before, after: result.after,
        deciderStanding: input.deciderStanding, stepUp: input.stepUp, lifetime: input.lifetime, follows: input.follows,
        ...(input.residual && input.residual.length > 0 ? { residual: input.residual } : {}),
        chain,
      },
    }, client);
    result.auditId = audit.id;
    if (object.type === 'warrant') {
      await client.query(
        `INSERT INTO warrant_events (warrant_id, action, actor_principal_id, actor_handle, metadata)
         VALUES ($1, 'warrant.amended', $2, $3, $4::jsonb)`,
        [object.id, actor.principalId ?? null, actor.handle || 'unknown', JSON.stringify({
          clause: 'AZ-A13', direction: input.classification.direction, path: input.path, approvalId: input.approvalId,
          changed: input.classification.changed, before: result.before, after: result.after, auditId: audit.id,
        })],
      );
    }
    if (object.type === 'grant') {
      // clause 11f: acl_changed for each concrete object whose entitlement
      // changed - the old one and the new one when the selector moves.
      const FEED = new Set(['task', 'phase', 'project', 'report', 'skill', 'personality']);
      const ids = [...new Set([(object.state as GrantState).resourceId, (finalState as unknown as GrantState).resourceId]
        .filter((id): id is string => Boolean(id)))];
      if (FEED.has(String(object.row.resource_type))) {
        for (const resourceId of ids) {
          await feedEventService.emit(client, {
            name: `${object.row.resource_type}.acl_changed`,
            objectType: String(object.row.resource_type) as FeedObjectType,
            objectId: resourceId,
            actorPrincipalId: actor.principalId ?? null,
            actorHandle: actor.handle ?? null,
            ownerPrincipalId: object.row.grantee_type === 'principal' ? String(object.row.grantee_id) : null,
            payload: {},
          });
        }
      }
    }
    if (input.classification.direction === 'narrowing' && object.type === 'credential') {
      // clause 9f: a narrowing reaches a live graced predecessor, so the old
      // token cannot bypass it during its grace window.
      const predecessors = await client.query(
        `WITH RECURSIVE lineage AS (
           SELECT id, rotated_from_id FROM principal_credentials WHERE id = $1
           UNION ALL
           SELECT c.id, c.rotated_from_id FROM principal_credentials c JOIN lineage l ON c.id = l.rotated_from_id
         )
         SELECT c.id FROM principal_credentials c
          WHERE c.id IN (SELECT id FROM lineage WHERE id <> $1)
            AND c.revoked_at IS NULL AND c.grace_until IS NOT NULL`,
        [object.id]);
      for (const row of predecessors.rows) {
        if (await principalService.revokeCredentialById(String(row.id), NARROWING_REVOKE_REASON, actor, client)) {
          result.revokedPredecessorIds.push(String(row.id));
        }
      }
    }
    if (input.narrowAgents) {
      await this.narrowAll(client, object, finalState, audit.id, input, actor, result);
    }
    return result;
  }

  /**
   * clauses 9h and 10g (E94): the one act that NARROWS every live Agent under
   * a narrowed connection or warrant to the new scopes, in the same
   * transaction: each live Agent credential's scopes become their
   * intersection with the new scopes; an Agent whose intersection would be
   * empty is REVOKED instead (E113). One clause-14 audit row per Agent, naming
   * the edit it follows. A failed Agent write rolls the whole edit back. This
   * is the only write to an Agent credential's scopes.
   */
  private async narrowAll(client: PoolClient, object: LockedObject, finalState: Record<string, unknown>, follows: string,
    input: { approvalId: string | null; entryPoint: EditEntryPoint; deciderStanding: EditorStanding | null; path: EditPath },
    actor: AuditActor, result: EditResult): Promise<void> {
    let scopes: string[] | null;
    let agents;
    if (object.type === 'credential') {
      scopes = (finalState as unknown as CredentialState).scopes;
      agents = await client.query(
        `SELECT p.id AS principal_id, c.id AS credential_id, c.scopes, c.key_id
           FROM principals p JOIN principal_credentials c ON c.principal_id = p.id
          WHERE p.parent_principal_id = $1 AND p.kind = 'agent' AND p.status = 'active'
            AND c.revoked_at IS NULL AND c.grace_until IS NULL
            AND (c.expires_at IS NULL OR c.expires_at > NOW())
          ORDER BY p.id, c.id FOR UPDATE OF c`,
        [object.holderPrincipalId]);
    } else if (object.type === 'warrant') {
      scopes = (finalState as unknown as WarrantState).ceilingScopes;
      agents = await client.query(
        `SELECT p.id AS principal_id, c.id AS credential_id, c.scopes, c.key_id
           FROM principals p JOIN principal_credentials c ON c.principal_id = p.id
          WHERE p.minted_under_warrant_id = $1 AND p.status = 'active'
            AND c.revoked_at IS NULL AND c.grace_until IS NULL
            AND (c.expires_at IS NULL OR c.expires_at > NOW())
          ORDER BY p.id, c.id FOR UPDATE OF c`,
        [object.id]);
    } else {
      return;
    }
    // A warrant without a scope ceiling caps no Agent scope: nothing to narrow
    // to (a narrowing of the ceiling's rules reaches live Agents through Revoke).
    if (!scopes) return;
    for (const agent of agents.rows) {
      const held = parseJson<string[]>(agent.scopes, []);
      const kept = held.filter((scope) => (scopes as string[]).includes(scope));
      if (sameSet(kept, held)) continue;
      const credentialId = String(agent.credential_id);
      const principalId = String(agent.principal_id);
      let revoked = false;
      if (kept.length === 0) {
        revoked = await principalService.revokeCredentialById(credentialId, NARROWING_REVOKE_REASON, actor, client);
        result.revokedAgents.push({ principalId, credentialId });
      } else {
        await client.query(
          `UPDATE principal_credentials SET scopes = $2::jsonb WHERE id = $1 AND revoked_at IS NULL`,
          [credentialId, JSON.stringify(kept)]);
        result.narrowedAgents.push({ principalId, credentialId, scopes: kept });
      }
      await auditService.record({
        action: 'credential.edit', actor, resourceType: 'credential', resourceId: credentialId,
        metadata: {
          clause: 'AZ-A13', direction: 'narrowing', path: 'narrow-all', approvalId: input.approvalId,
          entryPoint: input.entryPoint, changed: ['scopes'],
          before: { scopes: held, keyId: agent.key_id ?? null },
          after: { scopes: kept, keyId: agent.key_id ?? null, revoked: kept.length === 0 && revoked },
          deciderStanding: input.deciderStanding, stepUp: null, lifetime: null, follows,
          narrowedUnder: { objectType: object.type, objectId: object.id },
          chain: await auditChainFor(client, principalId),
        },
      }, client);
    }
  }

  /** The approval ledger rows for an applied edit (clause 14). */
  private async writeApprovalEvent(client: Queryable, approvalId: string, action: string, actor: AuditActor,
    metadata: Record<string, unknown>): Promise<void> {
    await client.query(
      `INSERT INTO approval_events (approval_id, action, actor_principal_id, actor_handle, metadata)
       VALUES ($1, $2, $3, $4, $5::jsonb)`,
      [approvalId, action, actor.principalId ?? null, actor.handle || 'unknown', JSON.stringify(metadata)]);
  }

  /** The chain-root Account of the object's holder (clause 6a's grantee). */
  async chainRootAccount(client: Queryable, holderPrincipalId: string | null): Promise<string | null> {
    if (!holderPrincipalId) return null;
    const result = await client.query(
      `WITH RECURSIVE up AS (
         SELECT id, parent_principal_id, 0 AS depth FROM principals WHERE id = $1
         UNION ALL
         SELECT p.id, p.parent_principal_id, up.depth + 1 FROM principals p JOIN up ON p.id = up.parent_principal_id
          WHERE up.depth < 8)
       SELECT id FROM up WHERE parent_principal_id IS NULL ORDER BY depth DESC LIMIT 1`,
      [holderPrincipalId]);
    return result.rows[0] ? String(result.rows[0].id) : null;
  }

  // ── paths 1 and 2: the owner's door ──────────────────────────────────────

  /**
   * The owner's door (clause 4a/4b, clause 15a routes). The ROUTE has refused
   * bearer callers (SESSION_ONLY) and established the editor's standing. A
   * NARROWING saves at once. A WIDENING needs the lifetime, passes the caps,
   * then consumes the single-use step-up bound to (`<object>.edit`, id) and is
   * created, decided and applied as ONE approved `authority-edit` Approval.
   * Every refusal writes a durable denied audit on the pool and leaves nothing.
   */
  async editObject(input: {
    type: EditObjectType;
    id: string;
    fields: Record<string, unknown>;
    editor: EditorContext;
    stepUpToken?: unknown;
    lifetime?: unknown;
    reason?: unknown;
    narrowAgents?: unknown;
    acknowledgeDependents?: unknown;
  }, actor: AuditActor): Promise<EditResult> {
    const objectId = canonicalId(String(input.id ?? ''));
    let holderForAudit: string | null = null;
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const object = await this.lockObject(client, input.type, objectId);
      if (!object) {
        throw refuse(404, `${input.type.toUpperCase()}_NOT_FOUND`, `No such ${input.type}`, 'target', 15, 'the edited object exists');
      }
      holderForAudit = object.holderPrincipalId;
      const problem = await this.editableProblem(client, object, this.scopesAdded(object, input.fields.scopes));
      if (problem) throw problem;
      const { after, classification } = await this.target(object, input.fields, actor);
      if (classification.changed.length === 0) {
        throw refuse(422, 'EDIT_NO_CHANGE', 'the edit changes nothing', 'editor', 2, 'an edit changes at least one field');
      }
      if (input.narrowAgents !== undefined && input.narrowAgents !== null && typeof input.narrowAgents !== 'boolean') {
        throw refuse(422, 'EDIT_FIELD_NOT_EDITABLE', 'narrowAgents is true or false', 'editor', '9h', 'narrowAgents is a boolean',
          { fields: ['narrowAgents'] });
      }
      const narrowAgents = input.narrowAgents === true;
      if (narrowAgents && (classification.direction !== 'narrowing' || object.type === 'grant')) {
        throw refuse(422, 'EDIT_FIELD_NOT_EDITABLE',
          'narrowAgents rides a narrowing of a Connector credential or a warrant (AZ-A13 clauses 9h, 10g)', 'editor', '9h',
          'the narrow-all act is offered by a narrowing only', { fields: ['narrowAgents'] });
      }
      const reason = this.optionalReason(input.reason);
      this.assertTransportStanding(object, classification, input.editor);
      const acknowledgeDependents = input.acknowledgeDependents === true;

      if (classification.direction === 'narrowing') {
        await this.assertCaps(client, object, after, classification, null, actor);
        const result = await this.apply(client, object, {
          after, classification, path: 'direct', approvalId: null, entryPoint: 'session',
          deciderStanding: input.editor.standing, stepUp: null, lifetime: null, follows: null, narrowAgents,
          acknowledgeDependents, creatorPrincipalId: input.editor.principalId,
        }, actor);
        await client.query('COMMIT');
        return result;
      }

      // WIDENING (clause 4b): the lifetime and the caps before the step-up is
      // spent (clause 13), then the one act.
      const lifetime = await this.parseLifetime(client, input.lifetime, null);
      await this.assertRevertible(object, after, lifetime);
      await this.assertCaps(client, object, after, classification, input.editor, actor);
      if (object.type === 'warrant' && classification.moves.ceiling !== 'same' && !acknowledgeDependents) {
        const dependents = await accessVehicleService.dependentOpenTasks(object.id, client);
        if (dependents.length > 0) {
          throw refuse(409, 'WARRANT_HAS_DEPENDENT_TASKS',
            `editing this warrant's ceiling will UNASSIGN ${dependents.length} not-yet-terminal task(s) that ride it (ruling 7440b579 R4). Re-send with acknowledgeDependents to proceed`,
            'editor', '10c', 'a ceiling edit while tasks ride the warrant releases them only after acknowledgement',
            { dependentCount: dependents.length });
        }
      }
      let stepUp: { tokenId: string; method: string };
      try {
        stepUp = await stepUpService.consume(client, {
          token: typeof input.stepUpToken === 'string' ? input.stepUpToken : '',
          principalId: input.editor.principalId,
          action: EDIT_STEP_UP_ACTIONS[object.type],
          targetId: object.id,
        });
      } catch (e) {
        throw asEditRefusal(e, 'editor', '4b', `a widening needs a single-use step-up bound to (${EDIT_STEP_UP_ACTIONS[object.type]}, ${object.id})`);
      }
      const requested = this.requestedRecord(object, after);
      const granteeId = await this.chainRootAccount(client, object.holderPrincipalId);
      // The Approval is created APPROVED in this transaction (§6.1a's pattern):
      // its id is drawn first so the edit's audit names it, and the row is
      // written once the edit has applied, with the state it applied — a
      // ceiling given as rules has its pinned version only after the publish.
      const approvalId = randomUUID();
      const result = await this.apply(client, object, {
        after, classification, path: 'approval-atomic', approvalId, entryPoint: 'session',
        deciderStanding: input.editor.standing, stepUp, lifetime, follows: null, narrowAgents: false,
        acknowledgeDependents, creatorPrincipalId: input.editor.principalId,
      }, actor);
      await client.query(
        `INSERT INTO approvals
           (id, kind, status, requester_principal_id, session_evidence, grantee_principal_id, reason,
            related_task_id, requested_scopes, requested_rules, pending_expires_at,
            decided_by_principal_id, decided_at, decision_step_up,
            edit_object_type, edit_object_id, edit_before, edit_requested, edit_approved,
            edit_lifetime, edit_revert_at)
         VALUES ($1, 'authority-edit', 'approved', $2, $3::jsonb, $4, $5, $6, '[]'::jsonb, '[]'::jsonb, NOW(),
                 $2, NOW(), $7::jsonb, $8, $9, $10::jsonb, $11::jsonb, $12::jsonb, $13, $14)`,
        [
          approvalId, input.editor.principalId,
          JSON.stringify({ door: 'one-act', standing: input.editor.standing, stepUp, act: EDIT_STEP_UP_ACTIONS[object.type] }),
          granteeId, reason, lifetime.taskId, JSON.stringify(stepUp),
          object.type, object.id, JSON.stringify(result.before), JSON.stringify(requested), JSON.stringify(result.after),
          lifetime.choice, lifetime.revertAt,
        ]);
      const ledger = { kind: 'authority-edit', objectType: object.type, objectId: object.id, before: result.before, after: result.after };
      await this.writeApprovalEvent(client, approvalId, 'approval.requested', actor, { ...ledger, door: 'one-act' });
      await this.writeApprovalEvent(client, approvalId, 'approval.approved', actor, {
        ...ledger, door: 'one-act', deciderStanding: input.editor.standing, stepUp, lifetime, auditId: result.auditId,
      });
      await auditService.record({
        action: 'approval.approve', actor, resourceType: 'approval', resourceId: approvalId,
        metadata: { ...ledger, door: 'one-act', deciderStanding: input.editor.standing, stepUp, lifetime,
          chain: object.holderPrincipalId ? await auditChainFor(client, object.holderPrincipalId) : [] },
      }, client);
      await client.query('COMMIT');
      return result;
    } catch (e) {
      await client.query('ROLLBACK').catch(() => undefined);
      await this.auditRefusal(e, input.type, objectId, holderForAudit, actor);
      throw e;
    } finally {
      client.release();
    }
  }

  /** E149: the scopes a body would add to a credential (none for another object). */
  private scopesAdded(object: LockedObject, scopes: unknown): string[] {
    if (object.type !== 'credential' || !Array.isArray(scopes)) return [];
    const held = (object.state as CredentialState).scopes;
    return scopes.filter((scope): scope is string => typeof scope === 'string' && !held.includes(scope));
  }

  /** clause 6b: on the one-act door the reason is optional, 20-2,000 characters when given. */
  private optionalReason(raw: unknown): string | null {
    if (raw === undefined || raw === null || raw === '') return null;
    const reason = typeof raw === 'string' ? raw.trim() : '';
    const length = [...reason].length;
    if (length < 20 || length > 2000) {
      throw refuse(422, 'INVALID_REASON', `reason is optional and, when given, 20-2,000 characters (got ${length})`, 'editor', '6b',
        'the reason is 20-2,000 characters');
    }
    return reason;
  }

  /** The requested state as the approval row records it (clause 6a). */
  private requestedRecord(object: LockedObject, after: Record<string, unknown>): Record<string, unknown> {
    if (object.type === 'warrant') {
      const target = after as unknown as WarrantTarget;
      return {
        ...snapshot(object, after),
        ...(target.ceilingRules ? { ceilingRules: target.ceilingRules } : {}),
      };
    }
    return snapshot(object, after);
  }

  /** §5.2 rule 8 / clause 13: a durable denied audit with the chain, on the
   * pool, so it survives the rollback. The credential policy audits its own. */
  private async auditRefusal(e: unknown, type: EditObjectType, id: string, holder: string | null, actor: AuditActor): Promise<void> {
    if (!(e instanceof AuthorityEditError)) return;
    if (['ROOT_NOT_MINTABLE', 'ACCOUNTS_ARE_KEYLESS', 'PRINCIPAL_TERMINATED', 'ADMIN_NOT_AGENT_DELEGABLE', 'PRINCIPAL_NOT_FOUND'].includes(e.code)
      && e.refusal.rule.startsWith('PrincipalService.assertCredentialPolicy')) return;
    await auditService.record({
      action: EDIT_STEP_UP_ACTIONS[type], actor, outcome: 'denied', resourceType: type,
      resourceId: UUID_PATTERN.test(id) ? id : null,
      metadata: { refusal: e.code, ...e.refusal, chain: holder ? await auditChainFor(pool, holder) : [] },
    }).catch(() => undefined);
  }

  // ── path 3: a decided pending widening (the agent's door) ────────────────

  /**
   * Decide an agent-filed `authority-edit` on /approvals (AZ-A9 clause 6; AZ-A13
   * clauses 6d, 6e, 6j), on the row `decide` locked, in its transaction. The
   * caller has admitted the decider (root or an administrator), refused a
   * dead requester, and handled deny. Here: the stale check (lapse
   * TARGET_CHANGED, refuse EDIT_STALE), the decider's narrowing
   * (EDIT_ONLY_NARROWS), the lifetime, the caps, and the edit itself.
   */
  async approveFiled(client: PoolClient, row: any, input: {
    deciderPrincipalId: string;
    deciderStanding: 'root' | 'administrator';
    deciderScopes: string[];
    stepUp: { tokenId: string; method: string };
    editedScopes?: unknown;
    editedKind?: unknown;
    editedTransport?: unknown;
    editedObject?: unknown;
    lifetime?: unknown;
  }, actor: AuditActor, lapse: (reason: string) => Promise<void>): Promise<EditResult> {
    const approvalId = String(row.id);
    const type = String(row.edit_object_type) as EditObjectType;
    const object = await this.lockObject(client, type, String(row.edit_object_id));
    const before = parseJson<Record<string, unknown>>(row.edit_before, {});
    const requested = parseJson<Record<string, unknown>>(row.edit_requested, {});
    const stale = async (why: string): Promise<never> => {
      await lapse('TARGET_CHANGED');
      await client.query('COMMIT');
      throw refuse(409, 'EDIT_STALE',
        `the ${type} changed after this request was filed (${why}), so the request lapsed TARGET_CHANGED and nothing was applied`,
        'decider', '6e', 'the object still equals the state the request was filed against, at decide and at execution',
        { lapseReason: 'TARGET_CHANGED' });
    };
    if (!object) return stale('it no longer exists');
    const problem = await this.editableProblem(client, object, this.scopesAdded(object, requested.scopes));
    if (problem) {
      if (['CREDENTIAL_NOT_LIVE', 'WARRANT_NOT_EDITABLE'].includes(problem.code)) return stale(problem.message);
      throw problem;
    }
    // clause 6e: the effect is bound to the diff the decider reviewed.
    if (!statesEqual(type, object.state as unknown as Record<string, unknown>, before)) return stale('its editable fields differ from the snapshot');

    // clause 6d: the decider narrows only — never a field, the object or the kind.
    const narrows = (what: string, detail: Record<string, unknown> = {}) => refuse(422, 'EDIT_ONLY_NARROWS',
      `the decider edits a request DOWN (AZ-A13 clause 6d): ${what}`, 'decider', '6d',
      'untick added scopes; never add a scope or a field, change the object or the kind, or take away what the credential held',
      detail);
    const present = (value: unknown) => value !== undefined && value !== null;
    if (present(input.editedKind) && input.editedKind !== 'authority-edit') throw narrows('the kind never changes');
    if (present(input.editedObject)) throw narrows('the object never changes');
    if (present(input.editedTransport)) throw narrows('an agent-filed edit carries no transport (clause 9d)');
    if (type !== 'credential') throw narrows('only a credential edit is filable in v1 (DD-5)');
    const beforeState = { scopes: parseJson<string[]>(before.scopes, []), transport: String(before.transport) as Transport };
    const requestedScopes = parseJson<string[]>(requested.scopes, []);
    let approvedScopes = requestedScopes;
    if (present(input.editedScopes)) {
      if (!Array.isArray(input.editedScopes) || input.editedScopes.some((scope) => typeof scope !== 'string')) {
        throw narrows('editedScopes is the full approved scope set, an array of scope strings');
      }
      const candidate = [...new Set(input.editedScopes as string[])];
      const extra = candidate.filter((scope) => !requestedScopes.includes(scope));
      if (extra.length > 0) throw narrows(`${extra.join(', ')} was never requested`, { exceeding: extra });
      const dropped = beforeState.scopes.filter((scope) => !candidate.includes(scope));
      if (dropped.length > 0) {
        throw narrows(`${dropped.join(', ')} is held by the credential now: the decider approves a subset of the ADDED scopes, and narrows a credential with its own edit`,
          { held: dropped });
      }
      approvedScopes = candidate;
    }
    const after: CredentialState = { scopes: approvedScopes, transport: beforeState.transport };
    const classification = classifyCredential(object.state as CredentialState, after);
    if (classification.changed.length === 0) {
      throw refuse(422, 'APPROVAL_WRITES_NOTHING', 'unticking every added scope applies nothing: deny the request instead',
        'decider', '6d', 'an approval applies at least one added scope');
    }
    // clause 6c: an agent never receives root or *:admin through a request.
    const added = approvedScopes.filter((scope) => !beforeState.scopes.includes(scope));
    if (added.some((scope) => scope === 'root' || scope.endsWith(':admin'))) {
      throw refuse(422, 'ADMIN_SCOPE_NOT_ADMISSIBLE', 'root and *:admin are never added through a request (AZ-A9 clause 11)',
        'decider', '6c', 'an agent may never file root or *:admin');
    }
    const lifetime = await this.parseLifetime(client, input.lifetime, row.related_task_id ? String(row.related_task_id) : null);
    if (lifetime.taskId && row.related_task_id && lifetime.taskId !== String(row.related_task_id).toLowerCase()) {
      throw refuse(422, 'EDIT_LIFETIME_REQUIRED', '"until this task ends" binds to the request\'s own related task',
        'decider', '6j', 'the until-task lifetime of a filed request is its related task');
    }
    await this.assertRevertible(object, after as unknown as Record<string, unknown>, lifetime);
    await this.assertCaps(client, object, after as unknown as Record<string, unknown>, classification, {
      principalId: input.deciderPrincipalId, standing: input.deciderStanding, sessionScopes: input.deciderScopes,
    }, actor);
    const result = await this.apply(client, object, {
      after: after as unknown as Record<string, unknown>, classification, path: 'approval-decided', approvalId,
      entryPoint: 'mcp', deciderStanding: input.deciderStanding, stepUp: input.stepUp, lifetime, follows: null,
      narrowAgents: false, acknowledgeDependents: false, creatorPrincipalId: input.deciderPrincipalId,
    }, actor);
    await client.query(
      `UPDATE approvals SET status = 'approved', edit_approved = $2::jsonb, edit_lifetime = $3, edit_revert_at = $4,
              related_task_id = COALESCE(related_task_id, $5::uuid),
              decided_by_principal_id = $6, decided_at = NOW(), decision_step_up = $7::jsonb, updated_at = NOW()
        WHERE id = $1`,
      [approvalId, JSON.stringify(result.after), lifetime.choice, lifetime.revertAt, lifetime.taskId,
        input.deciderPrincipalId, JSON.stringify(input.stepUp)]);
    return result;
  }

  // ── path 3b: a decided change request (card 502fb19e, E325) ──────────────

  /**
   * Apply an approved request of kind `change` (change-request design section
   * 3: `credential.scopes` on any credential, `grant.edit`) inside the decide
   * transaction, with the DECIDER as the standing principal. The caller has
   * admitted the decider, run the stale check against the snapshot the request
   * was filed with, and verified the decision's one step-up as evidence
   * (section 5.3), so no second token is consumed here: the executor accepts
   * that evidence only after re-checking it on the decide client itself (the
   * consumed approval.decide token of this decider for this approval, and the
   * approval row held by this transaction), so no other caller can pass forged
   * evidence (slice S2). The object's own
   * validators, the transport rule and the caps run on the approved state as
   * they run on the one-act door; the lifetime is keep (a later request, or
   * the direct door, reverses it).
   */
  async applyDecidedChange(client: PoolClient, input: {
    type: 'credential' | 'grant' | 'warrant';
    id: string;
    fields: Record<string, unknown>;
    approvalId: string;
    decider: EditorContext;
    stepUp: { tokenId: string; method: string };
    /** The decision's consumed step-up, the act's evidence (change-request design section 5.3). */
    evidence: DecisionEvidence;
    /** A warrant ceiling edit while tasks ride the warrant (clause 10c): the decider approved the
     * count the request showed, which the stale check holds equal to the count now (slice S4). */
    acknowledgeDependents?: boolean;
  }, actor: AuditActor): Promise<EditResult> {
    await assertDecisionEvidence(client, input.evidence);
    const object = await this.lockObject(client, input.type, canonicalId(input.id));
    if (!object) {
      throw refuse(404, `${input.type.toUpperCase()}_NOT_FOUND`, `No such ${input.type}`, 'target', 15, 'the edited object exists');
    }
    const problem = await this.editableProblem(client, object, this.scopesAdded(object, input.fields.scopes));
    if (problem) throw problem;
    const { after, classification } = await this.target(object, input.fields, actor);
    if (classification.changed.length === 0) {
      throw refuse(422, 'APPROVAL_WRITES_NOTHING', 'the approved change changes nothing: deny the request instead',
        'decider', '6d', 'an approval applies at least one change');
    }
    this.assertTransportStanding(object, classification, input.decider);
    await this.assertCaps(client, object, after, classification,
      classification.direction === 'widening' ? input.decider : null, actor);
    return this.apply(client, object, {
      after, classification, path: 'approval-decided', approvalId: input.approvalId, entryPoint: 'mcp',
      deciderStanding: input.decider.standing, stepUp: input.stepUp,
      lifetime: { choice: 'keep', taskId: null, revertAt: null }, follows: null,
      narrowAgents: false, acknowledgeDependents: input.acknowledgeDependents === true, creatorPrincipalId: input.decider.principalId,
    }, actor);
  }

  // ── path 4: the revert (clause 6j) ───────────────────────────────────────

  /**
   * What a revert of one widening does, FIELD BY FIELD (clause 6j): "A revert
   * removes only what its widening added and is still present. The scopes it
   * added are removed. Each other field that still holds its approved value
   * goes back to its edit_before value; a warrant ceiling goes back to the
   * version pinned before ... A field a later edit moved is left as it is. A
   * revert only narrows."
   *
   * `next` is the state the revert writes (null: nothing to write), and every
   * field it changes moves DOWN, the ceiling included. `residual` names each
   * field where authority the widening added is still present but no
   * narrowing removes it: a value not comparable with the one before (a
   * ceiling A -> B, a transport mcp -> api, a grant selector X -> Y), a scope
   * set the removal would leave empty, or a ceiling with no version pinned
   * before. A record with a residual is never closed as reverted (it stays
   * due, review 1a38270d r1 B1), and "until this task ends" is refused for an
   * edit whose revert would leave one (`assertRevertible`).
   *
   * `kept` (E148) names each field the widening moved up and a later edit
   * moved again, whose value still exceeds its value before the widening: the
   * revert leaves it as it is and closes the record, naming it.
   */
  async revertPlan(object: Pick<LockedObject, 'type' | 'state' | 'ceilingRules'>, before: Record<string, unknown>,
    approved: Record<string, unknown>, beforeCeilingRules?: ProfileRule[]): Promise<RevertPlan> {
    const current = object.state as unknown as Record<string, unknown>;
    const next: Record<string, unknown> = { ...current };
    const residual: string[] = [];
    const kept: KeptResidual[] = [];
    // A field other than a scope set or the ceiling: back to its edit_before
    // value when it still holds the approved one and the move back narrows.
    const field = (name: string, move: (a: any, b: any) => FieldMove) => {
      const cur = current[name] ?? null;
      const appr = approved[name] ?? null;
      const prior = before[name] ?? null;
      if (move(cur, appr) !== 'same') {
        // A later edit moved it: left as it is. E148: when the widening moved
        // it up and what it holds now still exceeds its value before the
        // widening, it is a residual the revert keeps, and names.
        if (move(prior, appr) === 'up' && move(prior, cur) === 'up') kept.push({ field: name, before: prior, approved: appr, now: cur });
        return;
      }
      const back = move(cur, prior);
      if (back === 'down') {
        next[name] = prior;
        return;
      }
      // Back would not narrow. Nothing was added when the widening narrowed
      // this field or left it; otherwise the value is not comparable with the
      // one before, and only a person can take back what it added.
      if (back !== 'same' && move(prior, cur) !== 'down') residual.push(name);
    };
    // A scope set: the scopes the widening added are removed where still
    // present; a removal that would leave the set empty is a residual.
    const removeAdded = (name: string, held: string[], added: string[]) => {
      const kept = held.filter((s) => !added.includes(s));
      if (kept.length === held.length) return;
      if (kept.length > 0) next[name] = kept;
      else residual.push(name);
    };
    if (object.type === 'credential') {
      const added = parseJson<string[]>(approved.scopes, []).filter((s) => !parseJson<string[]>(before.scopes, []).includes(s));
      removeAdded('scopes', current.scopes as string[], added);
      field('transport', transportMove);
      return { next: statesEqual('credential', next, current) ? null : next, residual, kept };
    }
    if (object.type === 'warrant') {
      // The ceiling goes back to the version pinned before, which stays
      // immutable (clause 10b), when it still holds the approved version and
      // the move back narrows.
      const priorVersion = (before.ceilingProfileVersionId as string | null) ?? null;
      const approvedVersion = (approved.ceilingProfileVersionId as string | null) ?? null;
      const currentVersion = (current.ceilingProfileVersionId as string | null) ?? null;
      if (approvedVersion !== priorVersion && currentVersion === approvedVersion) {
        const priorRules = priorVersion ? (beforeCeilingRules ?? await warrantService.rulesOfVersion(priorVersion)) : null;
        const currentRules = object.ceilingRules ?? [];
        if (!priorRules) {
          // No version was pinned before (unrepresentable since migration 100):
          // there is nothing to go back to.
          residual.push('ceiling');
        } else {
          const backNarrows = rulesCovered(sourcesFromRules(currentRules), priorRules).covered;
          const addedNothing = rulesCovered(sourcesFromRules(priorRules), currentRules).covered;
          if (backNarrows && !addedNothing) next.ceilingProfileVersionId = priorVersion;
          else if (!addedNothing) residual.push('ceiling');
        }
      } else if (approvedVersion && priorVersion && approvedVersion !== priorVersion) {
        // A later edit re-pinned the ceiling: left as it is. E148: when the
        // widening added to it and the ceiling pinned now still reaches
        // beyond the one before, it is a residual the revert keeps, and names.
        const priorRules = beforeCeilingRules ?? await warrantService.rulesOfVersion(priorVersion);
        const approvedRules = await warrantService.rulesOfVersion(approvedVersion);
        const widened = !rulesCovered(sourcesFromRules(priorRules), approvedRules).covered;
        const beyond = !rulesCovered(sourcesFromRules(priorRules), object.ceilingRules ?? []).covered;
        if (widened && beyond) kept.push({ field: 'ceiling', before: priorVersion, approved: approvedVersion, now: currentVersion });
      }
      const priorCap = parseJson<string[] | null>(before.ceilingScopes, null);
      const approvedCap = parseJson<string[] | null>(approved.ceilingScopes, null);
      const currentCap = (current.ceilingScopes as string[] | null) ?? null;
      if (approvedCap === null) {
        // The widening lifted the scope cap: it comes back while still lifted.
        if (priorCap !== null && currentCap === null) next.ceilingScopes = priorCap;
      } else if (priorCap !== null && currentCap !== null) {
        removeAdded('ceilingScopes', currentCap, approvedCap.filter((s) => !priorCap.includes(s)));
      }
      // E148: a later edit capped a lifted scope ceiling, or lifted a raised
      // one, so no removal applies: what it holds now, when it still exceeds
      // the cap before the widening, is a residual the revert keeps, and names.
      const capMovedLater = approvedCap === null ? currentCap !== null : currentCap === null;
      if (capMovedLater && scopeCeilingMove(priorCap, approvedCap) === 'up' && scopeCeilingMove(priorCap, currentCap) === 'up') {
        kept.push({ field: 'ceilingScopes', before: priorCap, approved: approvedCap, now: currentCap });
      }
      field('maxConcurrent', capMove);
      field('maxTotal', capMove);
      field('expiresAt', expiryMove);
      field('transportPin', transportMove);
      return { next: statesEqual('warrant', next, current) ? null : next, residual, kept };
    }
    field('verb', verbMove);
    field('expiresAt', expiryMove);
    field('resourceId', selectorMove);
    return { next: statesEqual('grant', next, current) ? null : next, residual, kept };
  }

  /**
   * clause 6j: "until this task ends" promises the widening is removed when
   * the task ends, and a revert only narrows. An edit whose revert could not
   * take back what it adds without giving back what it removes (a value not
   * comparable with the one before), or would leave a scope set empty, is
   * refused that lifetime, before any step-up is spent: the decider keeps it,
   * or makes it two edits, a narrowing and then a widening a revert can undo
   * (review 1a38270d r1 B1). The plan is the revert's own, run on the state
   * the edit would leave.
   */
  private async assertRevertible(object: LockedObject, after: Record<string, unknown>, lifetime: EditLifetime): Promise<void> {
    if (lifetime.choice !== 'until-task') return;
    const plan = await this.revertPlan({
      type: object.type,
      state: after as unknown as EditState,
      ceilingRules: (after as unknown as WarrantTarget).ceilingRulesForCheck ?? object.ceilingRules,
    }, snapshot(object, object.state as unknown as Record<string, unknown>), after, object.ceilingRules);
    if (plan.residual.length > 0) {
      throw refuse(422, 'EDIT_LIFETIME_REQUIRED',
        `"until this task ends" cannot undo this edit (AZ-A13 clause 6j): its revert could not remove what it adds to ${plan.residual.join(', ')} without giving back what it takes away, or would leave nothing. Choose keep, or make two edits: a narrowing, then a widening its revert can undo`,
        'decider', '6j', 'a widening approved "until this task ends" is one its revert removes by narrowing', { unrevertible: plan.residual });
    }
  }

  /**
   * Revert ONE approved until-task widening, on `client`'s transaction, with
   * the approval row locked by the caller. Returns what happened. A warrant
   * ceiling revert while tasks ride the warrant WAITS (clause 10c, Q2) unless
   * a person acknowledged it. The revert never narrows live Agents (fold item 5).
   * 'blocked': the fields a narrowing can take back went back, and authority
   * the widening added is still present, so the record stays due.
   */
  async revertOne(client: PoolClient, row: any, options: { acknowledgeDependents: boolean; entryPoint: EditEntryPoint },
    actor: AuditActor): Promise<'reverted' | 'closed' | 'nothing' | 'awaiting-acknowledgement' | 'blocked'> {
    const approvalId = String(row.id);
    const type = String(row.edit_object_type) as EditObjectType;
    const before = parseJson<Record<string, unknown>>(row.edit_before, {});
    const approved = parseJson<Record<string, unknown>>(row.edit_approved, {});
    const stamp = async (outcome: string, extra: Record<string, unknown>) => {
      await client.query(`UPDATE approvals SET edit_reverted_at = NOW(), updated_at = NOW() WHERE id = $1 AND edit_reverted_at IS NULL`, [approvalId]);
      await this.writeApprovalEvent(client, approvalId, 'approval.revoked', actor, {
        kind: 'authority-edit', path: 'revert', outcome, objectType: type, objectId: String(row.edit_object_id), ...extra,
      });
    };
    const object = await this.lockObject(client, type, String(row.edit_object_id));
    const dead = !object || (await this.editableProblem(client, object)) !== null;
    if (!object || dead) {
      // "A revert on an object that is no longer live closes its record with nothing to apply."
      await stamp('closed', { reason: 'the object is no longer live' });
      return 'closed';
    }
    const plan = await this.revertPlan(object, before, approved);
    // E148: the residuals the revert keeps are named in the record it closes.
    const named = plan.kept.length > 0 ? { residual: plan.kept } : {};
    if (!plan.next && plan.residual.length === 0) {
      await stamp('nothing', { reason: plan.kept.length > 0 ? residualReason(plan.kept) : NOTHING_REMAINS, ...named });
      return 'nothing';
    }
    let result: EditResult | null = null;
    let follows: string | null = null;
    if (plan.next) {
      const next = plan.next;
      let target: Record<string, unknown> = next;
      let classification: Classification;
      if (type === 'credential') {
        classification = classifyCredential(object.state as CredentialState, next as unknown as CredentialState);
      } else if (type === 'warrant') {
        const versionId = next.ceilingProfileVersionId as string | null;
        const rules = versionId && versionId !== (object.state as WarrantState).ceilingProfileVersionId
          ? await warrantService.rulesOfVersion(versionId) : (object.ceilingRules ?? []);
        const warrantNext: WarrantTarget = { ...(next as unknown as WarrantState), ceilingRulesForCheck: rules };
        target = warrantNext as unknown as Record<string, unknown>;
        classification = classifyWarrant(object.state as WarrantState, warrantNext, object.ceilingRules ?? []);
        if (classification.moves.ceiling !== 'same' && !options.acknowledgeDependents) {
          const dependents = await accessVehicleService.dependentOpenTasks(object.id, client);
          if (dependents.length > 0) return 'awaiting-acknowledgement';
        }
      } else {
        classification = classifyGrant(object.state as GrantState, next as unknown as GrantState);
      }
      if (classification.direction !== 'narrowing') {
        // A revert only narrows: a state that would widen is never written,
        // and the record is not closed - it stays due, for a person.
        return 'blocked';
      }
      const original = (await client.query(
        `SELECT id FROM audit_events WHERE resource_type = $1 AND resource_id = $2 AND outcome = 'success'
            AND metadata->>'approvalId' = $3 AND metadata->>'path' IN ('approval-atomic', 'approval-decided')
          ORDER BY occurred_at, id LIMIT 1`,
        [type, object.id, approvalId])).rows[0];
      follows = original ? String(original.id) : null;
      result = await this.apply(client, object, {
        after: target, classification, path: 'revert', approvalId, entryPoint: options.entryPoint,
        deciderStanding: null, stepUp: null, lifetime: null, follows,
        narrowAgents: false, acknowledgeDependents: options.acknowledgeDependents, creatorPrincipalId: null,
        residual: plan.kept,
      }, actor);
    }
    if (plan.residual.length > 0) {
      // Never closed as reverted while authority the widening added is still
      // present (review 1a38270d r1 B1): what a narrowing could take back went
      // back above, and the record stays due, shown in the hub, until a person
      // narrows or revokes what remains; the sweep then closes it.
      return 'blocked';
    }
    await stamp('reverted', { before: result?.before, after: result?.after, auditId: result?.auditId, follows, ...named });
    return 'reverted';
  }

  /**
   * clause 6j at the related task's terminal (completed, archived, or deleted):
   * every due revert, each under a SAVEPOINT inside the terminal transaction,
   * so a failed revert never blocks the task's completion; the periodic sweep
   * backstops it.
   */
  async revertAtTaskTerminal(client: Queryable, taskId: string, actor: AuditActor): Promise<string[]> {
    const due = await client.query(
      `SELECT * FROM approvals
        WHERE kind = 'authority-edit' AND status = 'approved' AND edit_lifetime = 'until-task'
          AND edit_reverted_at IS NULL AND related_task_id = $1
        ORDER BY id FOR UPDATE`,
      [taskId]);
    const reverted: string[] = [];
    for (const row of due.rows) {
      await client.query('SAVEPOINT az_a13_revert');
      try {
        const outcome = await this.revertOne(client as PoolClient, row, { acknowledgeDependents: false, entryPoint: 'sweep' }, actor);
        await client.query('RELEASE SAVEPOINT az_a13_revert');
        if (outcome !== 'awaiting-acknowledgement' && outcome !== 'blocked') reverted.push(String(row.id));
      } catch (e) {
        await client.query('ROLLBACK TO SAVEPOINT az_a13_revert');
        logCaughtWarning('[AuthorityEditExecutor] a revert at the task terminal failed; the periodic sweep retries it', e);
      }
    }
    return reverted;
  }

  /**
   * The periodic sweep (clause 6j): every until-task widening that is DUE —
   * its date has passed, its related task is completed or archived, or its
   * related task is gone and it names no date — reverted one transaction per
   * revert. A warrant ceiling revert while tasks ride the warrant stays due
   * until a person acknowledges it; a revert blocked by a residual stays due
   * until a person narrows or revokes what remains.
   */
  async sweepReverts(actor: AuditActor = { handle: 'system', authMethod: 'system' }): Promise<{ reverted: number; waiting: number; blocked: number }> {
    const due = await pool.query(
      `SELECT a.id FROM approvals a LEFT JOIN tasks t ON t.id = a.related_task_id
        WHERE a.kind = 'authority-edit' AND a.status = 'approved' AND a.edit_lifetime = 'until-task'
          AND a.edit_reverted_at IS NULL
          AND ((a.edit_revert_at IS NOT NULL AND a.edit_revert_at <= NOW())
               OR t.status IN ('completed', 'archived')
               OR (a.related_task_id IS NULL AND a.edit_revert_at IS NULL))
        ORDER BY a.edit_revert_at NULLS FIRST, a.id LIMIT 200`);
    let reverted = 0;
    let waiting = 0;
    let blocked = 0;
    for (const { id } of due.rows) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const row = (await client.query(
          `SELECT * FROM approvals WHERE id = $1 AND edit_reverted_at IS NULL FOR UPDATE SKIP LOCKED`, [id])).rows[0];
        if (!row) { await client.query('ROLLBACK'); continue; }
        const outcome = await this.revertOne(client, row, { acknowledgeDependents: false, entryPoint: 'sweep' }, actor);
        await client.query('COMMIT');
        if (outcome === 'awaiting-acknowledgement') waiting += 1;
        else if (outcome === 'blocked') blocked += 1;
        else reverted += 1;
      } catch (e) {
        await client.query('ROLLBACK').catch(() => undefined);
        logCaughtWarning('[AuthorityEditExecutor] revert sweep failed for one approval', e);
      } finally {
        client.release();
      }
    }
    return { reverted, waiting, blocked };
  }

  /**
   * A person acknowledges a DUE warrant-ceiling revert that waits on riding
   * tasks (clause 6j with 10c; OP-8: a body field on the declared
   * `PATCH /warrants/:id`, no new route). The route has established root, an
   * administrator or the owning Account (clause 4a).
   */
  async applyDueRevert(warrantId: string, approvalId: string, acknowledgeDependents: boolean, actor: AuditActor): Promise<{ outcome: string; approvalId: string }> {
    if (!UUID_PATTERN.test(approvalId ?? '')) {
      throw refuse(404, 'APPROVAL_NOT_FOUND', 'No such approval', 'editor', '6j', 'applyRevert names a due revert of this warrant');
    }
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const row = (await client.query(
        `SELECT a.*, t.status AS related_task_status FROM approvals a LEFT JOIN tasks t ON t.id = a.related_task_id
          WHERE a.id = $1 FOR UPDATE OF a`, [approvalId])).rows[0];
      if (!row || row.kind !== 'authority-edit' || row.edit_object_type !== 'warrant'
        || String(row.edit_object_id).toLowerCase() !== warrantId.toLowerCase()) {
        throw refuse(404, 'APPROVAL_NOT_FOUND', 'No such approval on this warrant', 'editor', '6j', 'applyRevert names a due revert of this warrant');
      }
      const due = row.status === 'approved' && row.edit_lifetime === 'until-task' && !row.edit_reverted_at
        && ((row.edit_revert_at && new Date(row.edit_revert_at).getTime() <= Date.now())
          || ['completed', 'archived'].includes(String(row.related_task_status))
          || (!row.related_task_id && !row.edit_revert_at));
      if (!due) {
        throw refuse(409, 'REVERT_NOT_DUE', 'this widening is not due for its revert', 'editor', '6j',
          'only a due until-task revert is applied');
      }
      if (!acknowledgeDependents) {
        const dependents = await accessVehicleService.dependentOpenTasks(warrantId, client);
        if (dependents.length > 0) {
          throw refuse(409, 'WARRANT_HAS_DEPENDENT_TASKS',
            `reverting this warrant's ceiling will UNASSIGN ${dependents.length} not-yet-terminal task(s) that ride it (ruling 7440b579 R4). Re-send with acknowledgeDependents to proceed`,
            'editor', '10c', 'a ceiling revert while tasks ride the warrant waits for acknowledgement', { dependentCount: dependents.length });
        }
      }
      const outcome = await this.revertOne(client, row, { acknowledgeDependents, entryPoint: 'session' }, actor);
      await client.query('COMMIT');
      return { outcome, approvalId };
    } catch (e) {
      await client.query('ROLLBACK').catch(() => undefined);
      await this.auditRefusal(e, 'warrant', warrantId, null, actor);
      throw e;
    } finally {
      client.release();
    }
  }
}

export const authorityEditExecutor = new AuthorityEditExecutor();
