// DelegationService.ts — the delegation chain evaluator (RH-P3.AZ-S3, card
// 25e5fb92; AUTHZ design 4d961e37 §5, AZ-9/AZ-24/AZ-25/AZ-26/AZ-34).
//
// THREE LAYERS, ONE TABLE: effective(identity) = own(identity) ∩
// effective(parent), evaluated LIVE on every request — nothing is
// materialized, so narrowing an own() expression, disabling an ancestor or
// revoking an intermediate's last live credential takes effect on the very
// next request (T10).
//
// LIVENESS (AZ-9/AZ-25, sol B2): chainAlive(p) = p.status='active' AND, IF
// p is DELEGATED (parent set), p holds ≥1 live credential AND
// chainAlive(parent). Accounts are keyless by design — an Account link is
// live purely by active status. Live credential = not revoked, not
// expired, grace not elapsed.
// legacy_identity rows are EXEMPT (§10): they evaluate under the unchanged
// Phase-2 arms until the Phase-5 transition retires the compatibility arm.
//
// own() (AZ-24): a stored, live-evaluated selector expression —
//   { "scopes": "parent" | [scope strings],
//     "objects": "parent" | [ {resourceType, selectorForm, selectorIds?, verbs} ] }
// "parent" = full width of the parent (later parent gains flow through);
// an explicit list pins the set (later gains do NOT flow). Inheritance is
// NEVER implicit: a NON-legacy delegated principal whose own_expression is
// NULL evaluates to EMPTY authority — fail closed.
//
// FAILURE (AZ-34, T29): any evaluator error fails the WHOLE request (503),
// never a partial or empty-success list — the middleware maps
// DelegationEvaluatorError to 503.
import { pool } from '../db/connection';
import { ProfileRule, validateRules } from './AccessProfileService';
import { isScope } from '../utils/scopeMap';

export class DelegationEvaluatorError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DelegationEvaluatorError';
  }
}

export interface OwnExpression {
  scopes: 'parent' | string[];
  objects: 'parent' | ProfileRule[];
}

export interface ChainLink {
  principalId: string;
  kind: 'human' | 'agent' | 'service';
  role: string | null;
  status: string;
  parentPrincipalId: string | null;
  boundTaskId: string | null;
  legacyIdentity: boolean;
  ownExpression: OwnExpression | null;
  liveCredentialCount: number;
}

export interface DelegationChain {
  /** acting identity first, then ancestors up to the Account. */
  links: ChainLink[];
  alive: boolean;
  deadReason: string | null;
}

/**
 * The ratified chain depth (§5.1). EXPORTED so a second walk of
 * `parent_principal_id` cannot come to disagree with `resolveChain` about how
 * deep a chain goes: `TelemetryProjectionService` resolves a Connector's
 * current chain head in SQL and imports this rather than writing a 3.
 */
export const MAX_CHAIN_DEPTH = 3;

export function parseOwnExpression(raw: unknown): OwnExpression | null {
  if (raw === null || raw === undefined) return null;
  let value: unknown = raw;
  if (typeof raw === 'string') {
    try {
      value = JSON.parse(raw);
    } catch {
      throw new DelegationEvaluatorError('own_expression is not valid JSON');
    }
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new DelegationEvaluatorError('own_expression must be an object');
  }
  const scopes = (value as any).scopes;
  const objects = (value as any).objects;
  let parsedScopes: 'parent' | string[];
  if (scopes === 'parent') parsedScopes = 'parent';
  else if (Array.isArray(scopes) && scopes.every((s: unknown) => isScope(s) && s !== 'root')) {
    parsedScopes = scopes as string[];
  } else {
    throw new DelegationEvaluatorError("own_expression.scopes must be 'parent' or an array of non-root scopes");
  }
  let parsedObjects: 'parent' | ProfileRule[];
  if (objects === 'parent') parsedObjects = 'parent';
  // AZ-S4 (§6/§8.1): a minted Agent may carry ZERO extra object authority —
  // it then works purely through its bound-task role arms. An explicit
  // empty list is the fail-closed way to express that; validateRules keeps
  // refusing empties everywhere a non-empty rule set is the contract.
  else if (Array.isArray(objects) && objects.length === 0) parsedObjects = [];
  else parsedObjects = validateRules(objects);
  return { scopes: parsedScopes, objects: parsedObjects };
}

function mapLink(row: any): ChainLink {
  return {
    principalId: String(row.id),
    kind: row.kind,
    role: row.role ?? null,
    status: String(row.status),
    parentPrincipalId: row.parent_principal_id ? String(row.parent_principal_id) : null,
    boundTaskId: row.bound_task_id ? String(row.bound_task_id) : null,
    legacyIdentity: Boolean(row.legacy_identity),
    ownExpression: parseOwnExpression(row.own_expression),
    liveCredentialCount: Number(row.live_credential_count ?? 0),
  };
}

export class DelegationService {
  /**
   * Resolve the acting principal's chain up to its Account (depth ≤ 3) with
   * per-link live-credential counts, in one query. Throws
   * DelegationEvaluatorError on any structural problem — the caller maps
   * that to a whole-request 503 (AZ-34, T29).
   */
  async resolveChain(principalId: string): Promise<DelegationChain> {
    const result = await pool.query(
      `WITH RECURSIVE chain AS (
         SELECT p.*, 0 AS depth FROM principals p WHERE p.id = $1
         UNION ALL
         SELECT parent.*, chain.depth + 1
           FROM principals parent
           JOIN chain ON parent.id = chain.parent_principal_id
          WHERE chain.depth < ${MAX_CHAIN_DEPTH + 1}
       )
       SELECT chain.*, (
         SELECT COUNT(*) FROM principal_credentials c
          WHERE c.principal_id = chain.id
            AND c.revoked_at IS NULL
            AND (c.expires_at IS NULL OR c.expires_at > NOW())
            AND (c.grace_until IS NULL OR c.grace_until > NOW())
       ) AS live_credential_count
       FROM chain ORDER BY depth ASC`,
      [principalId],
    );
    if (result.rows.length === 0) {
      throw new DelegationEvaluatorError(`principal ${principalId} resolved to no row`);
    }
    if (result.rows.length > MAX_CHAIN_DEPTH) {
      throw new DelegationEvaluatorError('delegation chain exceeds the ratified depth (§5.1)');
    }
    const links = result.rows.map(mapLink);
    const top = links[links.length - 1];
    if (top.parentPrincipalId && !top.legacyIdentity) {
      throw new DelegationEvaluatorError('delegation chain does not terminate at an Account');
    }

    // Liveness (§5.1). Legacy rows evaluate under the Phase-2 arms and are
    // exempt from chain liveness entirely.
    if (links[0].legacyIdentity) {
      return { links, alive: true, deadReason: null };
    }
    for (const link of links) {
      if (link.status !== 'active') {
        return { links, alive: false, deadReason: `principal ${link.principalId} is ${link.status}` };
      }
      if (link.parentPrincipalId && link.liveCredentialCount === 0) {
        return { links, alive: false, deadReason: `delegated principal ${link.principalId} holds no live credential` };
      }
    }
    return { links, alive: true, deadReason: null };
  }

  /**
   * Effective SCOPE ceiling for the acting identity presenting a credential
   * (§5.2 rule 1 + AZ-26): credential scopes ∩ ownScopes(acting) ∩
   * ownScopes(each delegated ancestor) ∩ scope authority of the Account
   * (its role-derived set). `root` never survives delegation (rule 2), and
   * `*:admin` never survives to an Agent (rule 3). Account-plane callers
   * (no parent) keep their credential/role scopes untouched here.
   */
  effectiveScopes(chain: DelegationChain, credentialScopes: string[], accountScopes: string[]): string[] {
    const acting = chain.links[0];
    if (!acting.parentPrincipalId || acting.legacyIdentity) {
      return credentialScopes;
    }
    let effective = new Set(credentialScopes);
    effective.delete('root'); // rule 2: root is never delegable.
    if (acting.kind === 'agent') {
      // rule 3: *:admin verbs never reach the Agent layer.
      effective = new Set([...effective].filter((scope) => !scope.endsWith(':admin')));
    }
    for (const link of chain.links) {
      if (!link.parentPrincipalId) {
        // The Account layer: its role-derived scope authority bounds the
        // whole chain (the base of §5.2 rule 1). A ROOT Account's sentinel
        // set means "everything" (review 87fec3e2 B1): the sentinel is the
        // Account-side SUPERSET, never a literal one-element intersection —
        // root itself was already stripped from the delegated result above,
        // so nothing delegable widens.
        if (!accountScopes.includes('root')) {
          effective = new Set([...effective].filter((scope) => accountScopes.includes(scope)));
        }
      } else {
        const own = link.ownExpression;
        if (!own) {
          // Inheritance is never implicit (AZ-24): no expression, no authority.
          return [];
        }
        if (own.scopes !== 'parent') {
          effective = new Set([...effective].filter((scope) => (own.scopes as string[]).includes(scope)));
        }
      }
    }
    return [...effective];
  }
}

export const delegationService = new DelegationService();
