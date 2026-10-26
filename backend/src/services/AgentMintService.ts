// AgentMintService.ts — the shared Agent-mint validation and execution core
// (RH-P3.AZ-S4, card aa48fb12; AUTHZ design 4d961e37 §6, §8.1; AZ-28,
// T2/T4/T17/T18/T27).
//
// EXACTLY THREE mint paths exist (§8.1) and all of them end here:
// approval-collect (§6.1), warrant-mint (§6.2–6.3) and the atomic SESSION
// MINT (§6.1a). The FULL validation below runs on EVERY path, at the moment
// authority is exercised — request time, decision time, collect time and
// warrant-mint time all re-run it (§6.1 "COLLECT re-runs the COMPLETE mint
// validation"):
//   · requester live: chainAlive over the acting principal (AZ-9);
//   · the BOUND credential live and un-graced where one exists (AZ-31c);
//   · target Task exists and is in a MINTABLE state (not completed or
//     archived — the ratified terminal set, review B6);
//   · one-writer slot free for write-capable requests (AZ-28: exactly ONE
//     write-bound Agent per task; read+reports siblings mint freely);
//   · requested scopes are mintable, carry no root (rule 2) and no *:admin
//     (rule 3 — also re-refused at issuance), and lie within the
//     requester's CURRENT effective scope set (the mint-time ⊆ half of
//     T2 — the live chain cap is the other half, and both bind);
//   · requested object rules lie within the requester's CURRENT effective
//     object authority, judged by the LIVE predicate itself wherever it can
//     decide (card 785e1eed P1-C): an `exact` rule is asked of
//     `AuthorizationService.sqlCondition` — the chain intersection the minted
//     Agent will be evaluated under — for every action its verbs confer, so
//     the ceiling is neither wider nor narrower than what the Agent can then
//     do. See `assertObjectAuthorityCovers`.
//
// The minted Agent (§8.1): kind='agent', FIXED minimal role (NULL — never
// settable through any delegation surface), parent = the ACTING
// credential's principal (AZ-RT5) or the Account for a session mint,
// bound_task_id set, provenance FK when a warrant produced it. The
// credential: mandatory expiry (max-age fixed at mint, default 24h, a
// warrant may set), transport pinned by the warrant where one applies.
// Every mint and refusal is audited with the FULL chain (§5.2 rule 8).
import crypto from 'crypto';
import type { PoolClient } from 'pg';
import { pool } from '../db/connection';
import { auditService, type AuditActor } from './AuditService';
import { auditChainFor } from '../utils/auditChain';
import { principalService } from './PrincipalService';
import { delegationService } from './DelegationService';
import { accessProfileService, type ProfileRule } from './AccessProfileService';
import { authorizationRepository } from './AuthorizationRepository';
import {
  ADMINISTRATOR_ROLES, AUTHORIZATION_ACTIONS, grantAllows,
  type AuthorizationAction, type AuthorizationActor,
} from './AuthorizationService';
import type { ChainLink } from './DelegationService';
import { GRANT_VERBS, type GrantVerb } from './GrantService';
import { isMintableScope } from '../utils/scopeMap';
import { scopesForRole } from '../utils/identityScopes';
import { accessVehicleService, AssignmentAccessError, type TaskGrantRole } from './AccessVehicleService';
import {
  rulesCovered, scopesWithin, sourcesFromEffectiveAccess, sourcesFromRules,
  type AuthoritySource,
} from '../utils/authorityContainment';

export const AGENT_CREDENTIAL_DEFAULT_MAX_AGE_HOURS = 24;

export class AgentMintError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    /** T27 (§6.1): terminal failures LAPSE a bound Approval; transient
     * failures refuse WITHOUT consuming it. */
    public readonly disposition: 'terminal' | 'transient' = 'transient',
  ) {
    super(message);
    this.name = 'AgentMintError';
  }
}

const err = (
  status: number, code: string, message: string,
  disposition: 'terminal' | 'transient' = 'transient',
) => new AgentMintError(status, code, message, disposition);

type Queryable = { query: (text: string, params?: any[]) => Promise<{ rows: any[] }> };

/**
 * The live ACTIONS a set of rule verbs confers, read from `grantAllows` — the
 * mapping the evaluator applies to an own() rule (`ownRuleSql`) and to every
 * grant — so the mint ceiling asks about exactly what the minted rule would
 * let its Agent do: `write` confers read, write, claim, finish and release;
 * `admin` confers every action.
 */
export function actionsConferredBy(verbs: readonly GrantVerb[]): AuthorizationAction[] {
  return AUTHORIZATION_ACTIONS.filter((action) => verbs.some((verb) => grantAllows(verb, action)));
}

/**
 * Verb implication for the ALGEBRA arm of the ceiling (selector forms the live
 * predicate cannot decide object by object): a held source verb covers a
 * requested verb when every action the requested verb confers is conferred by
 * a held one. Derived from `grantAllows`, so `write` covers `read` and `admin`
 * covers every verb exactly as the evaluator reads them, with no table to keep
 * in step. The shared containment algebra is untouched: Warrant ceilings,
 * approval edit-down and assignment non-escalation keep their own semantics.
 */
function withImpliedVerbs(sources: AuthoritySource[]): AuthoritySource[] {
  return sources.map((source) => ({
    ...source,
    verbs: GRANT_VERBS.filter((requested) => actionsConferredBy([requested])
      .every((action) => source.verbs.some((held) => grantAllows(held, action)))),
  }));
}

/** The id the ceiling probe link carries. It names no principal; its own()
 * is 'parent' on both halves, so its side of the intersection is TRUE and
 * nothing bound to this id can contribute or remove authority. */
const CEILING_PROBE_PRINCIPAL_ID = '00000000-0000-0000-0000-000000000000';

/**
 * The actor whose live decision IS the requester's delegable object authority:
 * the requester's resolved chain with one neutral child link in front — the
 * position the minted Agent will occupy.
 *
 * Every arm of `sqlCondition` that stays live here is one the minted Agent is
 * evaluated under: the requester chain's own() caps (read through
 * `ownObjectsFor`, verb implication included) and the Account side — the
 * administrator superset, the account-owner arm
 * `COALESCE(t.account_owner_principal_id, p.owner_principal_id)`, grants,
 * group grants, profile rules, exact Project Grants and the read-visibility
 * union.
 *
 * Every arm that goes dark is one the Agent never receives:
 *   - `principalId` is null, so no Task-ROLE, initiator or assigned-Connector
 *     claim arm fires — those evaluate on the ACTING identity alone and never
 *     inherit down a chain (AZ-26), so a Connector that is a Task's claimant
 *     cannot hand that to an Agent;
 *   - the probe link is a parented NON-agent link, so the §8.2 bound-Task
 *     context read and the bound-Task write cap — arms of the Agent's own
 *     identity, not authority the requester holds — do not apply.
 */
function delegableAuthorityActor(chain: ChainLink[]): AuthorizationActor {
  return {
    principalId: null,
    handle: 'agent-mint-ceiling',
    role: null,
    scopes: null,
    authenticated: true,
    delegation: {
      links: [
        {
          principalId: CEILING_PROBE_PRINCIPAL_ID, kind: 'service', role: null,
          parentPrincipalId: chain[0].principalId, boundTaskId: null, legacyIdentity: false,
          ownExpression: { scopes: 'parent', objects: 'parent' },
        },
        ...chain.map((link) => ({
          principalId: link.principalId, kind: link.kind, role: link.role,
          parentPrincipalId: link.parentPrincipalId, boundTaskId: link.boundTaskId,
          legacyIdentity: link.legacyIdentity, ownExpression: link.ownExpression,
        })),
      ],
    },
  };
}

/** Does the live predicate have a point shape for this resource type? Read
 * from `sqlResource` itself (it throws for a type with none — today `plugin`
 * and `surface`), never from a copied list. */
function hasLiveShape(resourceType: ProfileRule['resourceType']): boolean {
  try {
    authorizationRepository.sqlResource(resourceType);
    return true;
  } catch {
    return false;
  }
}

/** The failing rule, named in one fixed key order wherever T2 refuses. */
function namedRule(rule: ProfileRule): ProfileRule {
  return {
    resourceType: rule.resourceType, selectorForm: rule.selectorForm,
    selectorIds: [...rule.selectorIds], verbs: [...rule.verbs],
  };
}

export interface MintAuthorityRequest {
  scopes: string[];
  rules: ProfileRule[];
}

export function normalizeMintRole(value: unknown, scopes: string[]): TaskGrantRole {
  const role = value === undefined || value === null
    ? (scopes.includes('tasks:write') ? 'implementer' : 'verifier') : value;
  if (role !== 'implementer' && role !== 'verifier' && role !== 'shepherd') {
    throw err(422, 'INVALID_MINT_ROLE', 'role must be implementer, verifier or shepherd', 'terminal');
  }
  if (role === 'implementer' && !scopes.includes('tasks:write')) {
    throw err(422, 'ROLE_SCOPE_MISMATCH', 'an implementer requires tasks:write', 'terminal');
  }
  if (role === 'shepherd' && scopes.includes('tasks:write')) {
    throw err(422, 'ROLE_SCOPE_MISMATCH', 'a shepherd-role Agent has no tasks:write', 'terminal');
  }
  return role;
}

export interface MintExecutionInput {
  targetTaskId: string;
  authority: MintAuthorityRequest;
  /** The principal the minted Agent hangs under: the ACTING credential's
   * principal (bearer paths, AZ-RT5) or the Account (session mint). */
  parentPrincipalId: string;
  mintedUnderWarrantId?: string | null;
  transport?: 'any' | 'mcp' | 'api';
  maxAgeHours?: number;
  label?: string | null;
  role?: TaskGrantRole;
}

export interface MintedAgentPack {
  principalId: string;
  handle: string;
  credentialId: string;
  keyId: string;
  /** Shown exactly once, never stored server-side (§7.4). */
  secretOnce: string;
  boundTaskId: string;
  scopes: string[];
  rules: ProfileRule[];
  expiresAt: string;
  transport: string;
  mintedUnderWarrantId: string | null;
  role: TaskGrantRole;
}

/**
 * §5.2 rule 4 — scopes that are MINTABLE onto a credential but are never
 * delegated to the Agent layer by default.
 *
 * Vocabulary amendment A21 says `knowledge-contents:read` is "excluded
 * from Agent-layer mints by default". Before RH-KW1 that sentence had no
 * mechanism anywhere in this tree: it was copied word for word from A18,
 * whose `telemetry-contents:read` is unbuilt, and nothing implemented a
 * per-scope Agent exclusion — so the clause said nothing that was not
 * already true of every scope. A control nothing can make fail is not a
 * control, and this project has been told that twice.
 *
 * THE PRECEDENT THIS SETS. The A18 telemetry lane reuses this set and
 * this error code when `telemetry-contents:read` ships its surface; the
 * shape is deliberately identical to rules 2 and 3 above it.
 *
 * WHY THE CHECK SITS BEFORE `isMintableScope`. The refusal must carry
 * its OWN code. A drill that only asserted "the mint fails" would be
 * satisfied by the generic `INVALID_MINT_SCOPES` branch if the scope
 * were ever dropped from `MINTABLE_SCOPES`, and would prove nothing
 * about this check. With the scope mintable and this check deleted, the
 * mint SUCCEEDS outright — which is the red proof the mutation drill in
 * `__tests__/kw1AgentScopeExclusion.test.ts` takes.
 *
 * E149 (owner ruling, 12 Oct 2026, "bind edits too"). `knowledge-contents:write`
 * is absent from this set: it reaches an Agent only through an explicit
 * request at mint, inside the parent's grants (answer E2). Its edit-time twin,
 * `AGENT_MINT_ONLY_SCOPES` in `AuthorityEditExecutor`, refuses adding it to an
 * Agent credential by any edit (`AGENT_SCOPE_MINT_ONLY`), root included.
 */
export const AGENT_EXCLUDED_SCOPES: ReadonlySet<string> = new Set([
  'knowledge-contents:read',
]);

export function validateRequestedScopes(scopes: unknown): string[] {
  if (!Array.isArray(scopes) || scopes.length === 0) {
    throw err(422, 'INVALID_MINT_SCOPES', 'requested scopes must be a non-empty array of scope strings');
  }
  const cleaned = scopes.map(String);
  for (const scope of cleaned) {
    if (scope === 'root') {
      // §5.2 rule 2: root is never delegable.
      throw err(422, 'ROOT_NOT_MINTABLE', 'root is never delegable (design 4d961e37 §5.2 rule 2)', 'terminal');
    }
    if (scope.endsWith(':admin')) {
      // §5.2 rule 3: *:admin never reaches the Agent layer.
      throw err(422, 'ADMIN_NOT_AGENT_DELEGABLE', `${scope}: *:admin scopes never reach the Agent layer (design 4d961e37 §5.2 rule 3)`, 'terminal');
    }
    if (AGENT_EXCLUDED_SCOPES.has(scope)) {
      // §5.2 rule 4: excluded from Agent-layer mints by default (A21).
      throw err(422, 'AGENT_EXCLUDED_SCOPE', `${scope}: excluded from Agent-layer mints by default (vocabulary amendment A21)`, 'terminal');
    }
    if (!isMintableScope(scope)) {
      throw err(422, 'INVALID_MINT_SCOPES', `'${scope}' is not a mintable scope`, 'terminal');
    }
  }
  return [...new Set(cleaned)];
}

export class AgentMintService {
  /**
   * The mint-time ⊆ check, OBJECT half (T2): requested rules must lie within
   * the requester's CURRENT effective object authority (§5.2 rule 1, §6.1).
   *
   * CARD 785e1eed P1-C (census 82804ddf gap 3). This used to compare the
   * request against grant and profile ROWS with exact verb matching, which is
   * narrower than the predicate that decides every live act in three ways:
   * `grantAllows` maps `write` to read/write/claim/finish/release; the
   * account-owner arm counts the Task's or its Project's owner; and exact
   * Project Grants reach their Tasks. So an Account that owned the Task's
   * Project, or held only a `write` grant, or a Project grant, was refused
   * MINT_EXCEEDS_REQUESTER for authority it exercises every day.
   *
   * THE LIVE ARM — every `exact` rule on a type the predicate has a shape for.
   * The rule is asked of the production predicate (`authorizedIds` →
   * `sqlCondition`), as the actor `delegableAuthorityActor` builds, for every
   * action its verbs confer (`actionsConferredBy`) and every id it names. That
   * is the chain intersection the minted Agent is evaluated under, minus only
   * the arms of the Agent's own identity, so the ceiling equals what the
   * Agent can then do — never wider, never narrower. A named object that does
   * not exist is held by no one and refuses.
   *
   * THE ALGEBRA ARM — `all-of-type`, `all-except`, `all-in-project`, and the
   * two types with no point shape. A selector that covers objects not yet
   * created cannot be decided object by object, so containment is proven from
   * the Account's grant and profile rows and every own() cap, as before, with
   * two corrections that bring it to the predicate's own reading: verbs imply
   * as `grantAllows` maps them (`withImpliedVerbs`), and the administrator
   * superset is the predicate's `ADMINISTRATOR_ROLES` (the copy here lacked
   * 'operator'). It stays conservative — never wider than the predicate.
   *
   * One function serves every path that runs T2 — the request (filing),
   * decide, collect, the session mint and the warrant mint — so a refusal
   * names the same failing rule, `{resourceType, selectorForm, selectorIds,
   * verbs}`, wherever it is raised. `queryable` lets a path judge on its own
   * open transaction. Empty rule requests pass trivially: the Agent then
   * holds only its bound-Task default (card c334177b), itself evaluated live.
   */
  async assertObjectAuthorityCovers(
    requesterPrincipalId: string,
    rules: ProfileRule[],
    queryable: Queryable = pool,
  ): Promise<void> {
    if (rules.length === 0) return;
    const chain = await delegationService.resolveChain(requesterPrincipalId, queryable);
    if (chain.links.some((link) => link.parentPrincipalId && !link.ownExpression)) {
      throw err(403, 'MINT_EXCEEDS_REQUESTER',
        'the requester chain carries no own() expression — no delegable authority (AZ-24)');
    }
    const probe = delegableAuthorityActor(chain.links);
    for (const rule of rules) {
      const notHeld = rule.selectorForm === 'exact' && hasLiveShape(rule.resourceType)
        ? await this.liveCeilingMiss(probe, rule, queryable)
        : await this.algebraCeilingMiss(chain.links, rule);
      if (notHeld) {
        throw err(403, 'MINT_EXCEEDS_REQUESTER',
          `requested object authority exceeds what the requester may do live (T2): ${JSON.stringify(namedRule(rule))}; not held: ${notHeld}`);
      }
    }
  }

  /** The live arm: the first action/id pair the predicate refuses, or null. */
  private async liveCeilingMiss(probe: AuthorizationActor, rule: ProfileRule, queryable: Queryable): Promise<string | null> {
    // The predicate compares canonical text; a stored own() rule compares as
    // `uuid`, so letter case never decides anything live and must not here.
    const ids = [...new Set(rule.selectorIds.map((id) => id.toLowerCase()))];
    for (const action of actionsConferredBy(rule.verbs)) {
      const held = await authorizationRepository.authorizedIds(probe, rule.resourceType, ids, action, queryable);
      const lacking = ids.find((id) => !held.has(id));
      if (lacking) return `'${action}' on ${rule.resourceType} ${lacking}`;
    }
    return null;
  }

  /** The algebra arm: which link fails to contain the rule, or null. */
  private async algebraCeilingMiss(links: ChainLink[], rule: ProfileRule): Promise<string | null> {
    for (const link of links) {
      if (!link.parentPrincipalId) {
        if (ADMINISTRATOR_ROLES.has(String(link.role || '').toLowerCase())) continue;
        const sources = withImpliedVerbs(sourcesFromEffectiveAccess(await accessProfileService.effectiveAccess(link.principalId)));
        if (!rulesCovered(sources, [rule]).covered) {
          return `no grant or profile rule of the Account contains this ${rule.selectorForm} selector`;
        }
      } else {
        const own = link.ownExpression;
        if (own && own.objects !== 'parent' && !rulesCovered(withImpliedVerbs(sourcesFromRules(own.objects)), [rule]).covered) {
          return `the own() cap of ${link.principalId} does not contain this ${rule.selectorForm} selector`;
        }
      }
    }
    return null;
  }

  /**
   * The requester's CURRENT effective scope set, computed with the SAME
   * production evaluator authentication uses (review 1897c959 B2):
   * credential scopes ∩ every own() scope cap down the chain ∩ the
   * Account's role-derived set. Decision-time revalidation (§6.1/T27)
   * consumes this, never the raw stored credential scopes.
   */
  async currentEffectiveScopes(principalId: string, credentialScopes: string[]): Promise<string[]> {
    const chain = await delegationService.resolveChain(principalId);
    const account = chain.links[chain.links.length - 1];
    return delegationService.effectiveScopes(chain, credentialScopes, scopesForRole(account.role));
  }

  /** The mint-time ⊆ check, SCOPE half (T2): requested scopes must lie
   * within the requester's CURRENT effective scope set. */
  assertScopesWithinEffective(effectiveScopes: string[] | null | undefined, requested: string[]): void {
    const held = effectiveScopes ?? [];
    if (held.includes('root')) return;
    const check = scopesWithin(held, requested);
    if (!check.within) {
      throw err(403, 'MINT_EXCEEDS_REQUESTER',
        `requested scopes exceed the requester's current effective set (T2): ${check.exceeding.join(', ')}`);
    }
  }

  /** Target Task must exist and be MINTABLE: not in the ratified terminal
   * set (completed | archived — review B6). Terminal = a T27 lapse. */
  async assertTaskMintable(queryable: { query: (t: string, p?: unknown[]) => Promise<{ rows: any[] }> }, taskId: string): Promise<void> {
    const result = await queryable.query('SELECT status FROM tasks WHERE id = $1', [taskId]);
    if (result.rows.length === 0) {
      throw err(404, 'TASK_NOT_FOUND', 'target task resolves to no row', 'terminal');
    }
    const status = String(result.rows[0].status);
    if (['completed', 'archived'].includes(status)) {
      throw err(409, 'TASK_TERMINAL', `target task is ${status} — not a mintable state`, 'terminal');
    }
  }

  /**
   * One-writer slot (AZ-28, §6.1 collect list): a WRITE-capable request
   * (tasks:write among the scopes) refuses while another Agent with live
   * write-capable credentials is bound to the same task. Read/report
   * siblings mint freely. Transient: the slot can free.
   */
  async assertWriterSlotFree(queryable: { query: (t: string, p?: unknown[]) => Promise<{ rows: any[] }> }, taskId: string, scopes: string[], role?: TaskGrantRole): Promise<void> {
    const resolvedRole = normalizeMintRole(role, scopes);
    if (resolvedRole !== 'implementer') return;
    const result = await queryable.query(
      `SELECT p.id FROM principals p
        WHERE p.kind = 'agent' AND p.bound_task_id = $1 AND p.status = 'active'
          AND NOT p.legacy_identity
          AND p.bound_task_role = 'implementer'
          AND EXISTS (SELECT 1 FROM principal_credentials c
                       WHERE c.principal_id = p.id
                         AND c.revoked_at IS NULL
                         AND (c.expires_at IS NULL OR c.expires_at > NOW())
                         AND (c.grace_until IS NULL OR c.grace_until > NOW())
                         AND c.scopes::jsonb ? 'tasks:write')
        LIMIT 1`,
      [taskId],
    );
    if (result.rows.length > 0) {
      throw err(409, 'WRITER_SLOT_TAKEN',
        'exactly ONE write-bound Agent per task (AZ-28): the writer slot is held — mint a read+reports sibling or wait for the slot');
    }
  }

  /** Requester liveness (chainAlive) + the bound credential where one
   * exists (AZ-31c: revoked/expired/graced credentials invalidate). */
  async assertRequesterLive(requesterPrincipalId: string, boundCredentialId: string | null): Promise<void> {
    const requester = await principalService.getPrincipalById(requesterPrincipalId);
    if (!requester) throw err(404, 'REQUESTER_NOT_FOUND', 'requester resolves to no principal', 'terminal');
    if (requester.status === 'terminated') {
      throw err(409, 'REQUESTER_TERMINATED', 'the requester is terminated (A17.10)', 'terminal');
    }
    if (requester.legacyIdentity) {
      throw err(409, 'LEGACY_FROZEN', 'legacy identities are frozen out of the mint machinery (§10, T37)', 'terminal');
    }
    const chain = await delegationService.resolveChain(requesterPrincipalId);
    if (!chain.alive) {
      throw err(409, 'REQUESTER_CHAIN_DEAD', `the requester chain is not live: ${chain.deadReason}`);
    }
    if (boundCredentialId) {
      const result = await pool.query(
        'SELECT revoked_at, expires_at, grace_until FROM principal_credentials WHERE id = $1',
        [boundCredentialId],
      );
      const row = result.rows[0];
      if (!row) throw err(409, 'CREDENTIAL_GONE', 'the bound requesting credential resolves to no row', 'terminal');
      if (row.revoked_at) throw err(409, 'CREDENTIAL_REVOKED', 'the bound requesting credential is revoked (AZ-31c)', 'terminal');
      if (row.expires_at && new Date(row.expires_at).getTime() <= Date.now()) {
        throw err(409, 'CREDENTIAL_EXPIRED', 'the bound requesting credential is expired (AZ-31c)', 'terminal');
      }
      if (row.grace_until) {
        throw err(409, 'CREDENTIAL_ROTATED', 'the bound requesting credential entered rotation grace (AZ-31c) — the successor must re-request', 'terminal');
      }
    }
  }

  /**
   * Execute the mint INSIDE the caller's transaction: Agent principal +
   * credential + full-chain audit, one commit with whatever consumed the
   * authorization (Approval consumption, warrant counter). The caller has
   * already run every validation arm for its path.
   */
  async executeMint(client: PoolClient, input: MintExecutionInput, actor: AuditActor): Promise<MintedAgentPack> {
    const role = normalizeMintRole(input.role, input.authority.scopes);
    const handle = `agent-${crypto.randomBytes(5).toString('hex')}`;
    const maxAgeHours = input.maxAgeHours ?? AGENT_CREDENTIAL_DEFAULT_MAX_AGE_HOURS;
    const expiresAt = new Date(Date.now() + maxAgeHours * 60 * 60 * 1000);
    const created = await client.query(
      `INSERT INTO principals
         (kind, handle, display_name, role, status, parent_principal_id, bound_task_id, bound_task_role,
          own_expression, minted_under_warrant_id, source_tag)
       VALUES ('agent', $1, $2, NULL, 'active', $3, $4, $5, $6::jsonb, $7, $8)
       RETURNING id, handle`,
      [
        handle,
        input.label ?? null,
        input.parentPrincipalId,
        input.targetTaskId,
        role,
        JSON.stringify({ scopes: input.authority.scopes, objects: input.authority.rules }),
        input.mintedUnderWarrantId ?? null,
        // 062's ux_principals_source_tag is UNIQUE: the tag names THIS mint.
        `agent-mint:${handle}`,
      ],
    );
    const principalId = String(created.rows[0].id);
    const issued = await principalService.issueCredential({
      principalId,
      scopes: input.authority.scopes,
      label: input.label ?? null,
      expiresAt,
      transport: input.transport ?? 'any',
      createdByPrincipalId: input.parentPrincipalId,
      metadata: {
        mint_path: input.mintedUnderWarrantId ? 'warrant' : 'approval',
        max_age_hours: maxAgeHours,
      },
    }, actor, client);
    const assignerChain = await delegationService.resolveChain(input.parentPrincipalId, client);
    if (!assignerChain.alive) throw err(409, 'REQUESTER_CHAIN_DEAD', 'the mint requester chain is not live', 'terminal');
    const assigner: AuthorizationActor = {
      principalId: input.parentPrincipalId, handle: actor.handle,
      role: assignerChain.links[0].role, scopes: null, authenticated: true,
      delegation: assignerChain.links.length > 1 ? { links: assignerChain.links } : null,
    };
    let roleRows;
    try {
      roleRows = await accessVehicleService.materializeRole(client, {
        taskId: input.targetTaskId, principalId, role, actor, assigner,
        credentialExpiresAt: expiresAt.toISOString(),
      });
    } catch (error) {
      if (error instanceof AssignmentAccessError) throw err(error.status, error.code, error.message);
      throw error;
    }
    await auditService.record({
      action: 'agent.minted', actor,
      resourceType: 'principal', resourceId: principalId,
      metadata: {
        boundTaskId: input.targetTaskId,
        role, roleGrantIds: roleRows.map(row => row.targetId),
        // Historical context coordinates, read in the mint transaction. Live
        // previews resolve these again; this receipt never grants authority.
        derivedContext: (await client.query(
          `SELECT id AS "taskId",phase_id AS "phaseId",project_id AS "projectId",
            clock_timestamp() AS "observedAt" FROM tasks WHERE id=$1`, [input.targetTaskId])).rows[0],
        contextBasis: 'AZ-19 bound-task read context; AZ-A10 stored role rows',
        parentPrincipalId: input.parentPrincipalId,
        scopes: input.authority.scopes,
        rules: input.authority.rules,
        selectedWarrantId: input.mintedUnderWarrantId ?? null,
        transport: input.transport ?? 'any',
        expiresAt: expiresAt.toISOString(),
        chain: await auditChainFor(client, principalId),
      },
    }, client);
    return {
      principalId,
      handle: String(created.rows[0].handle),
      credentialId: issued.credentialId,
      keyId: issued.keyId,
      secretOnce: issued.fullKey,
      boundTaskId: input.targetTaskId,
      scopes: input.authority.scopes,
      rules: input.authority.rules,
      expiresAt: expiresAt.toISOString(),
      transport: input.transport ?? 'any',
      mintedUnderWarrantId: input.mintedUnderWarrantId ?? null,
      role,
    };
  }
}

export const agentMintService = new AgentMintService();
