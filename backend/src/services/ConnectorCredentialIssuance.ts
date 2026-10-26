// ConnectorCredentialIssuance.ts — the ONE mechanism that issues a Connector
// credential on a decider's authority (AZ-A9 clause 13, ratified 2026-10-10,
// E43; card 785e1eed slice P1-B-2; owner ruling E73 for card 3c2db4b7).
//
// ONE IMPLEMENTATION, TWO DOORS (E73: "delivered with and sharing the mechanism
// of P1-B-2's credential-request kind"; AUTHZ amendment AZ-A13 clause 7,
// ratified 2026-10-11, E95). This module ISSUES a new Connector credential; its
// caller is the collect of an approved credential request
// (`ApprovalService.collectAccessRequest`), which passes the DECIDER's authority
// and the Approval id. The in-place EDIT of an existing credential (AZ-A13) does
// NOT come through here: clause 9a declares the edit an UPDATE of the existing
// row, and clause 9b rejects "an additional credential on the same connection"
// as the edit's mechanism. What the two doors share is the credential half of
// clause 7, which lives where both reach it:
//   - the policy every credential's scopes and pin must pass is
//     `PrincipalService.assertCredentialPolicy` (root, keyless Accounts,
//     legacy, terminated, *:admin to an Agent, the transport vocabulary),
//     called here before anything is written and by `issueCredential`, and
//     called by `AuthorityEditExecutor` on the state after an edit;
//   - the decider-ceiling check is `issuingCeiling` below, which decide, collect
//     and the edit executor all call (clause 7 P-3).
// It is deliberately free of HTTP: it takes a transaction, the input and the
// audit actor, and returns the issued credential once. It never reads a
// request, a header or a session.
//
// WHAT IT DOES, in the caller's transaction:
//   1. the closures (clause 11: "validateRequestedScopes rules 2-3 for
//      credentials"; clause 13: "scopes (never root or *:admin)"), stated ONCE
//      in `assertConnectorCredentialScopes`, which filing and decide also call;
//   2. the credential policy (`assertCredentialPolicy`, above), then the one
//      rule of its own: the target is an ACTIVE Connector (a service
//      principal), inside the authority's reach;
//   3. the ceiling (clause 11: "The approved rows must lie within the decider's
//      effective authority"): the scopes lie within what the authority may put
//      on a bearer credential — `delegableScopes`, the rule the Connector
//      wizard's session issuance (`routes/services.ts`, ISSUE_EXCEEDS_SESSION)
//      and `GET /principals/me` already state. For a root session that is every
//      mintable scope but root; for any other session, the mintable scopes it
//      holds. The vocabulary check is `credentialAuthority.validateRequestedScopes`,
//      the one `POST /principals/:id/credentials` runs, with that ceiling as the
//      grantable set;
//   4. the expiry is in the future and at most 90 days out (E15);
//   5. `PrincipalService.issueCredential` — the SAME core every issuance path
//      ends in (`POST /principals/:id/credentials`, `POST /services`, the agent
//      mint) — inside the caller's transaction, so nothing exists unless the
//      caller commits. It writes the hash and the ciphertext and audits
//      `credential.mint` with the keyId and scopes, never the secret.
//
// WHAT IT NEVER DOES: retire, rotate, narrow or edit an existing credential.
// The ratified text issues ONE credential (clause 13) and keeps rotation human
// (clause 15), so the requester's previous credential stays live. Editing a
// credential in place is AZ-A13's executor (`AuthorityEditExecutor`), which
// writes the existing row and never issues one.
//
// THE SECRET. `fullKey` is in the return value and nowhere else: no log line,
// no audit row, no refusal. The caller renders it once (§7.4).
import type { PoolClient } from 'pg';
import type { AuditActor } from './AuditService';
import { principalService, CredentialPolicyError } from './PrincipalService';
import { validateRequestedScopes as validateIssuableScopes } from '../utils/credentialAuthority';
import { delegableScopes } from '../utils/identityScopes';
import { isScope, isMintableScope } from '../utils/scopeMap';

const DAY_MS = 24 * 60 * 60 * 1000;
/** E15: a request-made authority expires at most 90 days out. */
export const CONNECTOR_CREDENTIAL_MAX_EXPIRY_MS = 90 * DAY_MS;
export const CONNECTOR_CREDENTIAL_TRANSPORTS = ['any', 'mcp', 'api'] as const;
export type ConnectorCredentialTransport = (typeof CONNECTOR_CREDENTIAL_TRANSPORTS)[number];

export type IssueRefusalSubject = 'requester' | 'grantee' | 'decider';

/**
 * A refusal of this mechanism, in the AZ-A9 shape (clause 11: "Every refusal
 * names the failing rule: body {code, rule, subject, clause}"). The approval
 * paths re-raise it as an `ApprovalError` with the same fields; an owner-plane
 * caller can do the same with its own error type.
 */
export class ConnectorCredentialIssueError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly subject: IssueRefusalSubject,
    public readonly clause: string,
    public readonly rule: string,
    public readonly detail: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = 'ConnectorCredentialIssueError';
  }
}

const refuse = (
  status: number, code: string, message: string, subject: IssueRefusalSubject, clause: number | string, rule: string,
  detail: Record<string, unknown> = {},
) => new ConnectorCredentialIssueError(status, code, message, subject, `AZ-A9 clause ${clause}`, rule, detail);

/**
 * The scope closures of a Connector credential, ONCE (clauses 11 and 13).
 * Filing, decide, collect and the executor all call this, so a mutation that
 * drops one closure is seen by every path. Returns the scopes de-duplicated in
 * their given order.
 *
 * Not `AgentMintService.validateRequestedScopes`: that function is the AGENT
 * layer's, and carries the Agent-only exclusion of `knowledge-contents:read`
 * (A21) and Agent-layer refusal wording. A Connector may hold that scope, so
 * the rules shared with it — root (§5.2 rule 2) and *:admin (rule 3, which
 * clause 11 applies to credential requests) — are restated here with codes of
 * their own.
 */
export function assertConnectorCredentialScopes(raw: unknown, subject: IssueRefusalSubject): string[] {
  if (!Array.isArray(raw) || raw.length === 0 || raw.some((scope) => typeof scope !== 'string')) {
    throw refuse(422, 'SCOPES_REQUIRED', 'requestedScopes must be a non-empty array of scope strings', subject, 13,
      'a credential request names at least one scope');
  }
  const scopes = [...new Set(raw as string[])];
  for (const scope of scopes) {
    if (scope === 'root') {
      throw refuse(422, 'ROOT_NOT_MINTABLE', 'root is never delegable to a bearer credential (design 4d961e37 §5.2 rule 2)',
        subject, 11, 'never root or *:admin (validateRequestedScopes rules 2-3 for credentials)', { failingScope: scope });
    }
    if (scope.endsWith(':admin')) {
      throw refuse(422, 'ADMIN_SCOPE_NOT_ADMISSIBLE',
        `${scope}: a *:admin scope is never asked for or approved through a request (AZ-A9 clauses 11 and 13); an owner issues it directly`,
        subject, 11, 'never root or *:admin (validateRequestedScopes rules 2-3 for credentials)', { failingScope: scope });
    }
    if (!isScope(scope) || !isMintableScope(scope)) {
      throw refuse(422, 'INVALID_SCOPES', `'${scope}' is not a scope a credential can carry today`, subject, 13,
        'every scope is in the ratified vocabulary and mintable', { failingScope: scope });
    }
  }
  return scopes;
}

/** The authority an issuance or an edit is capped by: the decider of an
 * approved request, or the signed-in owning Account of the Connector (AZ-A13
 * clause 4b, E94; `standing: 'owner'`). */
export interface IssuingAuthority {
  principalId: string;
  /** How the authority was admitted: root or an administrator login session
   * (AZ-A9 clause 6), or the Connector's owning Account (edit-in-place). */
  standing: 'root' | 'administrator' | 'owner';
  /** The scope set that authority holds NOW — a session's derived scopes. The
   * ceiling is what that set may delegate (`delegableScopes`). */
  scopes: string[];
}

export interface ConnectorCredentialIssueInput {
  connectorPrincipalId: string;
  scopes: string[];
  transport: ConnectorCredentialTransport;
  expiresAt: Date;
  label: string | null;
  authority: IssuingAuthority;
  /** The credential-kind Approval being collected; null for an owner-plane
   * issuance. Recorded in the credential's metadata, never as authority. */
  approvalId: string | null;
}

export interface IssuedConnectorCredential {
  credentialId: string;
  keyId: string;
  /** The full key, ONCE. Never logged, audited or stored by this module. */
  fullKey: string;
  principalId: string;
  scopes: string[];
  transport: ConnectorCredentialTransport;
  expiresAt: string;
  label: string | null;
}

/** clause 11: what the authority may put on a bearer credential, and what of
 * `scopes` lies outside it. */
export function issuingCeiling(authority: Pick<IssuingAuthority, 'scopes'>, scopes: string[]): { ceiling: string[]; exceeding: string[] } {
  const ceiling: string[] = delegableScopes(authority.scopes);
  return { ceiling, exceeding: scopes.filter((scope) => !ceiling.includes(scope)) };
}

/**
 * ISSUE one Connector credential, inside `client`'s transaction, capped by
 * `input.authority`. See the header for every check and what it never does.
 */
export async function executeConnectorCredentialIssue(
  client: PoolClient,
  input: ConnectorCredentialIssueInput,
  actor: AuditActor,
): Promise<IssuedConnectorCredential> {
  const scopes = assertConnectorCredentialScopes(input.scopes, 'decider');
  // The credential policy, the ONE copy (AZ-A13 clause 7 P-2): root, keyless
  // Accounts, legacy, terminated, *:admin to an Agent, and the transport
  // vocabulary. Its refusals are audited on the pool and re-raised here in the
  // AZ-A9 shape.
  try {
    await principalService.assertCredentialPolicy(
      { principalId: input.connectorPrincipalId, scopes, transport: input.transport }, actor, client);
  } catch (e) {
    if (e instanceof CredentialPolicyError) {
      throw refuse(e.status, e.code, e.message, 'decider', 13, 'PrincipalService.assertCredentialPolicy admits the credential');
    }
    throw e;
  }

  // The one rule of this module's own: the target is an ACTIVE CONNECTOR (a
  // service principal; an Agent's credential is the mint's, §7.1). Keyless
  // Accounts and legacy rows were refused by the policy above.
  const target = (await client.query(
    `SELECT id, kind, status FROM principals WHERE id = $1`,
    [input.connectorPrincipalId],
  )).rows[0];
  if (!target || String(target.kind) !== 'service' || String(target.status) !== 'active') {
    throw refuse(409, 'CONNECTOR_NOT_ISSUABLE', 'the target is not an active Connector, so no credential is issued on it',
      'requester', 13, 'a credential request issues ONE Connector credential on a live Connector');
  }

  // Reach: root and an administrator session are the board-wide superset
  // (clause 6); an owner reaches only the Connectors under its own Account.
  if (input.authority.standing === 'owner') {
    const reach = await client.query(
      `WITH RECURSIVE up AS (
         SELECT id, parent_principal_id, 0 AS depth FROM principals WHERE id = $1
         UNION ALL
         SELECT p.id, p.parent_principal_id, up.depth + 1 FROM principals p JOIN up ON p.id = up.parent_principal_id
          WHERE up.depth < 8)
       SELECT 1 FROM up WHERE id = $2 AND depth > 0 LIMIT 1`,
      [input.connectorPrincipalId, input.authority.principalId],
    );
    if (reach.rows.length === 0) {
      throw refuse(404, 'CONNECTOR_NOT_ISSUABLE', 'the target is not a Connector under your Account',
        'decider', 13, 'an owner issues only on the Connectors under its own Account');
    }
  }

  // clause 11: the ceiling is the AUTHORITY's, not the requester's.
  const { ceiling, exceeding } = issuingCeiling(input.authority, scopes);
  if (exceeding.length > 0) {
    throw refuse(403, 'DECIDER_CEILING_EXCEEDED',
      `the scopes exceed what the deciding authority may put on a credential (AZ-A9 clause 11): ${exceeding.join(', ')}`,
      'decider', 11, "the approved scopes lie within the decider's effective authority", { exceeding });
  }
  const vocabulary = validateIssuableScopes(scopes, { canManage: true, grantableScopes: ceiling });
  if (!vocabulary.ok) {
    throw refuse(422, 'INVALID_SCOPES', vocabulary.error, 'decider', 13, 'every scope is in the ratified vocabulary and mintable');
  }

  const now = Date.now();
  if (!(input.expiresAt instanceof Date) || Number.isNaN(input.expiresAt.getTime()) || input.expiresAt.getTime() <= now) {
    throw refuse(422, 'INVALID_EXPIRY', 'the credential expiry must be in the future', 'decider', 13,
      'the credential carries a mandatory future expiry');
  }
  if (input.expiresAt.getTime() > now + CONNECTOR_CREDENTIAL_MAX_EXPIRY_MS) {
    throw refuse(422, 'EXPIRY_TOO_LONG', 'the credential expires at most 90 days out (E15)', 'decider', 13,
      'the credential expiry is at most 90 days out');
  }

  let issued: { fullKey: string; credentialId: string; keyId: string };
  try {
    issued = await principalService.issueCredential({
      principalId: input.connectorPrincipalId,
      scopes: vocabulary.scopes,
      label: input.label,
      expiresAt: input.expiresAt,
      transport: input.transport,
      createdByPrincipalId: input.authority.principalId,
      metadata: {
        issued_via: input.approvalId ? 'access-request' : 'owner-edit',
        approval_id: input.approvalId,
        authority_standing: input.authority.standing,
      },
    }, actor, client);
  } catch (e) {
    if (e instanceof CredentialPolicyError) {
      throw refuse(e.status, e.code, e.message, 'decider', 13, 'PrincipalService.issueCredential admits the credential');
    }
    throw e;
  }
  return {
    credentialId: issued.credentialId,
    keyId: issued.keyId,
    fullKey: issued.fullKey,
    principalId: input.connectorPrincipalId,
    scopes: vocabulary.scopes,
    transport: input.transport,
    expiresAt: input.expiresAt.toISOString(),
    label: input.label,
  };
}
