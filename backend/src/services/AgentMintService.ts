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
//     archived — the ratified terminal set, sol B6);
//   · one-writer slot free for write-capable requests (AZ-28: exactly ONE
//     write-bound Agent per task; read+reports siblings mint freely);
//   · requested scopes are mintable, carry no root (rule 2) and no *:admin
//     (rule 3 — also re-refused at issuance), and lie within the
//     requester's CURRENT effective scope set (the mint-time ⊆ half of
//     T2 — the live chain cap is the other half, and both bind);
//   · requested object rules lie within the requester's CURRENT effective
//     object authority (Account sources ∩ own()-caps down the chain — the
//     same shape the S3 SQL intersection enforces live).
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
import { isMintableScope } from '../utils/scopeMap';
import { scopesForRole } from '../utils/identityScopes';
import {
  rulesCovered, scopesWithin, sourcesFromEffectiveAccess, sourcesFromRules,
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

const ADMINISTRATOR_ROLES = new Set(['admin', 'orchestrator']);

export interface MintAuthorityRequest {
  scopes: string[];
  rules: ProfileRule[];
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
   * The mint-time ⊆ check, OBJECT half (T2): requested rules must lie
   * within the requester's CURRENT effective object authority — the
   * Account's sources intersected with every own()-cap down the chain,
   * mirroring the live SQL intersection. Root/administrator Accounts are
   * the board-wide superset (§5.1). Empty rule requests pass trivially:
   * the Agent then works purely through its bound-task role arms.
   */
  async assertObjectAuthorityCovers(requesterPrincipalId: string, rules: ProfileRule[]): Promise<void> {
    if (rules.length === 0) return;
    const chain = await delegationService.resolveChain(requesterPrincipalId);
    for (const link of chain.links) {
      if (!link.parentPrincipalId) {
        if (ADMINISTRATOR_ROLES.has(String(link.role || '').toLowerCase())) continue;
        const sources = sourcesFromEffectiveAccess(await accessProfileService.effectiveAccess(link.principalId));
        const account = rulesCovered(sources, rules);
        if (!account.covered) {
          throw err(403, 'MINT_EXCEEDS_REQUESTER',
            `requested object authority exceeds the requester's Account sources (T2): ${JSON.stringify(account.failing)}`);
        }
      } else {
        const own = link.ownExpression;
        if (!own) {
          throw err(403, 'MINT_EXCEEDS_REQUESTER',
            'the requester chain carries no own() expression — no delegable authority (AZ-24)');
        }
        if (own.objects !== 'parent') {
          const capped = rulesCovered(sourcesFromRules(own.objects), rules);
          if (!capped.covered) {
            throw err(403, 'MINT_EXCEEDS_REQUESTER',
              `requested object authority exceeds the chain own() cap (T2): ${JSON.stringify(capped.failing)}`);
          }
        }
      }
    }
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
   * set (completed | archived — sol B6). Terminal = a T27 lapse. */
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
  async assertWriterSlotFree(queryable: { query: (t: string, p?: unknown[]) => Promise<{ rows: any[] }> }, taskId: string, scopes: string[]): Promise<void> {
    if (!scopes.includes('tasks:write')) return;
    const result = await queryable.query(
      `SELECT p.id FROM principals p
        WHERE p.kind = 'agent' AND p.bound_task_id = $1 AND p.status = 'active'
          AND NOT p.legacy_identity
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
    const handle = `agent-${crypto.randomBytes(5).toString('hex')}`;
    const maxAgeHours = input.maxAgeHours ?? AGENT_CREDENTIAL_DEFAULT_MAX_AGE_HOURS;
    const expiresAt = new Date(Date.now() + maxAgeHours * 60 * 60 * 1000);
    const created = await client.query(
      `INSERT INTO principals
         (kind, handle, display_name, role, status, parent_principal_id, bound_task_id,
          own_expression, minted_under_warrant_id, source_tag)
       VALUES ('agent', $1, $2, NULL, 'active', $3, $4, $5::jsonb, $6, $7)
       RETURNING id, handle`,
      [
        handle,
        input.label ?? null,
        input.parentPrincipalId,
        input.targetTaskId,
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
    await auditService.record({
      action: 'agent.minted', actor,
      resourceType: 'principal', resourceId: principalId,
      metadata: {
        boundTaskId: input.targetTaskId,
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
    };
  }
}

export const agentMintService = new AgentMintService();
