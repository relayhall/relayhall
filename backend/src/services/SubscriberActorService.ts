/**
 * SubscriberActorService — RH-P3.C2: the delivery worker's authorization actor.
 *
 * Both delivery planes (ruling ccd53781 R1) resolve an actor here:
 *
 *   - the WORK plane addresses an ASSIGNEE — a Connector registry row — and
 *     selects that Connector's delivery credential (packet c17ebfff, D7);
 *   - the OBSERVATION plane addresses a SUBSCRIPTION, which names its
 *     subscriber Connector and the credential it observes as.
 *
 * Either way the actor is rebuilt through the SAME sequence the auth
 * middleware runs for a real request:
 *
 *     credential row (live) -> shared acceptance predicate
 *       -> credential.scopes -> delegationService.resolveChain -> liveness
 *       -> scopesForRole(Account) -> delegationService.effectiveScopes -> actor
 *
 * ── Why the credential, and not the principal's role (review r1, B2) ──
 *
 * The first candidate derived scopes from `scopesForRole(principal.role)` — the
 * principal's role MAXIMUM — on the reasoning that the worker holds no
 * credential of its own. That widens authority, and the reviewer reproduced it:
 * a live delegated Connector whose only credential holds ['reports:read'] is
 * refused GET /events (it needs tasks:read), yet the worker's role-derived
 * actor cleared the ceiling and the subscription disclosed private task IDs.
 * A role default may never stand in for credential scopes.
 *
 * ── Why the SHARED predicate, and not equivalent checks (review r2, B2) ──
 *
 * Round 2 found the repair still incomplete: the worker read scopes,
 * revocation and expiry but not `credential_type`, secret usability,
 * `grace_until` or the §7.5 TRANSPORT PIN, so an `mcp`-pinned credential that
 * REST ingress answers with 403 TRANSPORT_MISMATCH was accepted here and
 * cleared `tasks:read`. Re-listing the gates in this file would have left two
 * implementations to drift apart, which is precisely the AZ-S3 lesson
 * (verdict 87fec3e2 B1: a synthetic actor passed its tests while the real
 * derivation returned empty authority). So the gates live in
 * `utils/credentialAcceptance`, and `middleware/auth.ts` +
 * `PrincipalService.authenticatePrincipalKey` call the same functions. Parity
 * is by CONSTRUCTION: push authority cannot exceed pull authority because
 * both ask the same predicate.
 *
 * Every failure path is FAIL-CLOSED: an unresolvable, dead, revoked, expired,
 * graced-out, mis-typed, transport-pinned, disabled or ineligible subscriber
 * yields no actor, and the worker delivers nothing rather than falling back to
 * a wider identity.
 */
import type { Pool } from 'pg';
import { pool as defaultPool } from '../db/connection';
import type { AuthorizationActor } from './AuthorizationService';
import { delegationService } from './DelegationService';
import { scopesForRole } from '../utils/identityScopes';
import { connectorRegistryPredicateSql } from '../utils/connectorRegistry';
import { resolveActorRole } from '../utils/taskAutomationRole';
import {
  evaluateCredentialAcceptance,
  evaluateTransportPin,
  DELIVERY_MIRRORED_PATH,
  DELIVERY_MIRRORED_TRANSPORT,
} from '../utils/credentialAcceptance';

export type SubscriberRefusal =
  | 'SUBSCRIBER_NOT_FOUND'
  | 'SUBSCRIBER_NOT_ACTIVE'
  | 'SUBSCRIBER_LAYER_INELIGIBLE'
  | 'SUBSCRIBER_CREDENTIAL_MISSING'
  | 'SUBSCRIBER_CREDENTIAL_NOT_LIVE'
  | 'SUBSCRIBER_CREDENTIAL_FOREIGN'
  | 'SUBSCRIBER_CREDENTIAL_TYPE'
  | 'SUBSCRIBER_CREDENTIAL_SECRET_UNUSABLE'
  | 'SUBSCRIBER_CREDENTIAL_GRACE_ELAPSED'
  | 'SUBSCRIBER_TRANSPORT_MISMATCH'
  | 'SUBSCRIBER_CHAIN_DEAD'
  | 'SUBSCRIBER_EVALUATOR_FAILED';

export type SubscriberActorResult =
  | { ok: true; actor: AuthorizationActor; credentialId: string }
  | { ok: false; refusal: SubscriberRefusal };

interface SubscriberRow {
  id: string;
  handle: string;
  role: string | null;
  status: string;
  kind: string;
  parent_principal_id: string | null;
  legacy_identity: boolean;
  is_connector: boolean;
  credential_id: string | null;
  credential_principal_id: string | null;
  credential_scopes: unknown;
  credential_type: string | null;
  credential_key_id: string | null;
  credential_secret_hash: string | null;
  credential_revoked_at: string | null;
  credential_expires_at: string | null;
  credential_grace_until: string | null;
  credential_transport: string | null;
}

/**
 * The columns the acceptance predicate needs, selected in ONE statement with
 * the principal so the two cannot be observed at different instants — a
 * credential revoked between two reads would otherwise still deliver once.
 */
const SUBSCRIBER_SELECT = `
  SELECT p.id, p.handle, p.role, p.status, p.kind,
         p.parent_principal_id, p.legacy_identity,
         (${connectorRegistryPredicateSql('p.id')}) AS is_connector,
         c.id AS credential_id,
         c.principal_id AS credential_principal_id,
         c.scopes AS credential_scopes,
         c.credential_type AS credential_type,
         -- The ROW, not a boolean: usability means addressable by key id AND
         -- a digest a presented token could match (review r3, B3).
         c.key_id AS credential_key_id,
         c.secret_hash AS credential_secret_hash,
         c.revoked_at AS credential_revoked_at,
         c.expires_at AS credential_expires_at,
         c.grace_until AS credential_grace_until,
         c.transport AS credential_transport
    FROM principals p
    LEFT JOIN principal_credentials c ON c.id = $2
   WHERE p.id = $1`;

/**
 * D7 (run packet c17ebfff) — how the WORK plane picks the credential it
 * delivers as, when no subscription named one.
 *
 * Deterministic and narrow: an `api_key` credential of THIS Connector, with a
 * usable secret, not revoked, not expired, inside its rotation grace, and
 * whose transport pin permits the surface the delivery mirrors. Ordered
 * most-recently-issued first so a rotation moves delivery onto the successor
 * credential without an operator edit, and `id` breaks ties so the choice is
 * stable rather than whatever the planner returns.
 *
 * The predicate here is a PRE-FILTER for choosing among candidates; the chosen
 * row is then put through the full shared acceptance predicate in `actorFor`,
 * so this SQL can never be the only thing standing between a bad credential
 * and a delivery.
 */
const WORK_CREDENTIAL_SELECT = `
  SELECT c.id
    FROM principal_credentials c
   WHERE c.principal_id = $1
     AND c.credential_type = 'api_key'
     -- Addressable and matchable, mirroring isUsableBearerKeyMaterial: a NULL
     -- key id can never be addressed by a token and a non-SHA-256 digest can
     -- never match one (review r3, B3). The chosen row is re-judged by the
     -- shared predicate regardless, so this is a pre-filter, not the gate.
     AND c.key_id IS NOT NULL AND length(trim(c.key_id)) > 0
     AND c.secret_hash ~* '^[0-9a-f]{64}$'
     AND c.revoked_at IS NULL
     AND (c.expires_at IS NULL OR c.expires_at > NOW())
     AND (c.grace_until IS NULL OR c.grace_until > NOW())
     AND COALESCE(c.transport, 'any') IN ('any', $2)
   ORDER BY c.created_at DESC, c.id DESC
   LIMIT 1`;

export class SubscriberActorService {
  constructor(private readonly pool: Pool = defaultPool) {}

  /**
   * Build the authorization actor for a delivery, or refuse with a typed
   * reason. Never throws for an ordinary refusal — the caller records the
   * reason and moves on.
   */
  async actorFor(
    subscriberPrincipalId: string,
    subscriberCredentialId: string | null,
  ): Promise<SubscriberActorResult> {
    if (!subscriberCredentialId) return { ok: false, refusal: 'SUBSCRIBER_CREDENTIAL_MISSING' };

    let row: SubscriberRow | undefined;
    try {
      const result = await this.pool.query<SubscriberRow>(
        SUBSCRIBER_SELECT, [subscriberPrincipalId, subscriberCredentialId],
      );
      row = result.rows[0];
    } catch {
      return { ok: false, refusal: 'SUBSCRIBER_EVALUATOR_FAILED' };
    }

    if (!row) return { ok: false, refusal: 'SUBSCRIBER_NOT_FOUND' };

    // Status is checked LIVE on every pass, so disabling a principal stops its
    // deliveries without touching any subscription row (A17.10 vocabulary:
    // active · disabled · terminated). The shared predicate checks it too;
    // this arm keeps the typed refusal specific.
    if (row.status !== 'active') return { ok: false, refusal: 'SUBSCRIBER_NOT_ACTIVE' };

    // Ruling ccd53781 R3: subscribers — and work-delivery assignees — are
    // CONNECTORS. Agent principals are task-bounded and expire with their task
    // (4d961e37 §5.2/§7.3); Accounts hold no bearer credentials at all (A17.1)
    // and act through login sessions, which a background worker must not
    // synthesize. The Connector is the durable credential-bearing layer.
    //
    // A Connector is NOT a principal kind — `principals.kind` is constrained
    // to human | agent | service. Per A17.2 it is a `services` row with
    // kind='connector' whose REQUIRED principal_id names the acting principal,
    // so eligibility is tested against the registry, not against the kind
    // column — through the ONE predicate in `utils/connectorRegistry`, which
    // the SCIM actor rule and the SCIM-client binding issue too (owner
    // ruling 4ae7ce53: reuse it, never re-derive it from principal columns).
    if (row.kind === 'agent') return { ok: false, refusal: 'SUBSCRIBER_LAYER_INELIGIBLE' };
    if (row.is_connector !== true) return { ok: false, refusal: 'SUBSCRIBER_LAYER_INELIGIBLE' };

    if (!row.credential_id) return { ok: false, refusal: 'SUBSCRIBER_CREDENTIAL_MISSING' };
    // A credential belonging to someone else would deliver one principal's
    // authority under another's subscription.
    if (String(row.credential_principal_id) !== String(row.id)) {
      return { ok: false, refusal: 'SUBSCRIBER_CREDENTIAL_FOREIGN' };
    }

    // ── The shared acceptance predicate — identical to the pull path ──
    const acceptance = evaluateCredentialAcceptance({
      credentialType: row.credential_type,
      keyId: row.credential_key_id,
      secretHash: row.credential_secret_hash,
      revokedAt: row.credential_revoked_at,
      expiresAt: row.credential_expires_at,
      graceUntil: row.credential_grace_until,
      principalStatus: row.status,
    });
    if (!acceptance.ok) {
      return { ok: false, refusal: SubscriberActorService.refusalFor(acceptance.denial) };
    }

    // ── The §7.5 transport pin, against the surface this delivery MIRRORS ──
    // A subscriber is only ever sent what it could have PULLED, and the pull
    // is GET /api/events over REST (stamped `api`). A credential pinned to
    // `mcp` is answered 403 TRANSPORT_MISMATCH there, so it receives nothing
    // here either — the exact disclosure review r2 reproduced.
    const pin = evaluateTransportPin(
      row.credential_transport, DELIVERY_MIRRORED_PATH, DELIVERY_MIRRORED_TRANSPORT,
    );
    if (!pin.allowed) return { ok: false, refusal: 'SUBSCRIBER_TRANSPORT_MISMATCH' };

    // The credential's OWN scopes — the exact input middleware/auth.ts uses.
    const credentialScopes = SubscriberActorService.readScopes(row.credential_scopes);

    // Parentless / legacy principals keep their Phase-2 arms unchanged
    // (4d961e37 §10 compatibility arm): the credential's scopes stand, and the
    // chain evaluator does not run — exactly as the middleware does.
    if (!row.parent_principal_id || row.legacy_identity) {
      return { ok: true, actor: this.assemble(row, credentialScopes, null), credentialId: String(row.credential_id) };
    }

    let chain;
    try {
      chain = await delegationService.resolveChain(row.id);
    } catch {
      return { ok: false, refusal: 'SUBSCRIBER_EVALUATOR_FAILED' };
    }
    if (!chain?.alive) return { ok: false, refusal: 'SUBSCRIBER_CHAIN_DEAD' };

    const account = chain.links[chain.links.length - 1];
    const accountScopes = scopesForRole(account.role);
    const effective = delegationService.effectiveScopes(chain, credentialScopes, accountScopes);

    return {
      ok: true,
      actor: this.assemble(row, effective, chain.links.length > 1 ? chain.links : null),
      credentialId: String(row.credential_id),
    };
  }

  /**
   * WORK PLANE (ruling ccd53781 R1): the actor for an ASSIGNEE Connector,
   * identified by its registry row. There is no subscription to name a
   * credential, so one is selected per D7 and then put through the very same
   * `actorFor` sequence — the selection changes which credential is used,
   * never how strictly it is judged.
   */
  async actorForConnector(
    serviceId: string,
  ): Promise<SubscriberActorResult & { principalId?: string }> {
    let principalId: string | null = null;
    try {
      const svc = await this.pool.query(
        `SELECT principal_id FROM services WHERE id = $1 AND kind = 'connector'`,
        [serviceId],
      );
      principalId = svc.rows[0]?.principal_id ? String(svc.rows[0].principal_id) : null;
    } catch {
      return { ok: false, refusal: 'SUBSCRIBER_EVALUATOR_FAILED' };
    }
    if (!principalId) return { ok: false, refusal: 'SUBSCRIBER_NOT_FOUND' };

    let credentialId: string | null = null;
    try {
      const cred = await this.pool.query(
        WORK_CREDENTIAL_SELECT, [principalId, DELIVERY_MIRRORED_TRANSPORT],
      );
      credentialId = cred.rows[0]?.id ? String(cred.rows[0].id) : null;
    } catch {
      return { ok: false, refusal: 'SUBSCRIBER_EVALUATOR_FAILED' };
    }
    // No usable credential is not an error: the Connector simply is not
    // deliverable this pass, and the worker records the reason (D7).
    if (!credentialId) return { ok: false, refusal: 'SUBSCRIBER_CREDENTIAL_MISSING' };

    const result = await this.actorFor(principalId, credentialId);
    return result.ok ? { ...result, principalId } : result;
  }

  /** Map a shared-predicate denial onto this service's typed refusals. */
  private static refusalFor(denial: string): SubscriberRefusal {
    switch (denial) {
      case 'CREDENTIAL_TYPE': return 'SUBSCRIBER_CREDENTIAL_TYPE';
      case 'CREDENTIAL_SECRET_UNUSABLE': return 'SUBSCRIBER_CREDENTIAL_SECRET_UNUSABLE';
      case 'CREDENTIAL_GRACE_ELAPSED': return 'SUBSCRIBER_CREDENTIAL_GRACE_ELAPSED';
      case 'PRINCIPAL_NOT_ACTIVE': return 'SUBSCRIBER_NOT_ACTIVE';
      default: return 'SUBSCRIBER_CREDENTIAL_NOT_LIVE';
    }
  }

  /** `scopes` is JSONB; tolerate both a parsed array and a JSON string. */
  private static readScopes(raw: unknown): string[] {
    if (Array.isArray(raw)) return raw.map(String);
    if (typeof raw === 'string') {
      try {
        const parsed = JSON.parse(raw);
        return Array.isArray(parsed) ? parsed.map(String) : [];
      } catch {
        return [];
      }
    }
    return [];
  }

  private assemble(row: SubscriberRow, scopes: string[], links: any[] | null): AuthorizationActor {
    return {
      principalId: row.id,
      handle: row.handle,
      role: resolveActorRole({ handle: row.handle, principalRole: row.role ?? undefined }),
      scopes,
      authenticated: true,
      delegation: links
        ? {
          links: links.map((link) => ({
            principalId: link.principalId,
            kind: link.kind,
            role: link.role,
            parentPrincipalId: link.parentPrincipalId,
            boundTaskId: link.boundTaskId,
            legacyIdentity: link.legacyIdentity,
            ownExpression: link.ownExpression,
          })),
        }
        : null,
    };
  }

  /**
   * Every principal in the subscriber's DESCENDANT subtree, plus the
   * subscriber itself — the causal set for the OBSERVATION loop guard.
   *
   * `resolveChain` walks ANCESTORS (acting identity up to the Account), which
   * is the wrong direction for causation: a subscriber acts through the
   * identities BELOW it. For a parentless Account subscriber the chain is null
   * entirely, so its Connector children were absent from the causal set and a
   * subscriber could still be delivered a write its own Connector performed
   * (review r1, B4). Chain depth is capped at 3 by design, so this recursion
   * is bounded.
   *
   * NOT applied to the work plane — see WebhookDeliveryWorker for why
   * suppressing an assignee's own-caused readiness would break the ratified
   * "chains advance by construction" clause of §2.6.4.
   */
  async causalSubtree(subscriberPrincipalId: string): Promise<Set<string>> {
    const causal = new Set<string>([String(subscriberPrincipalId)]);
    try {
      const result = await this.pool.query(
        `WITH RECURSIVE subtree AS (
           SELECT id FROM principals WHERE id = $1
           UNION ALL
           SELECT child.id
             FROM principals child
             JOIN subtree s ON child.parent_principal_id = s.id
         )
         SELECT id FROM subtree`,
        [subscriberPrincipalId],
      );
      for (const row of result.rows) causal.add(String(row.id));
    } catch {
      // Fail CLOSED for the guard's purpose: with an unresolvable subtree the
      // caller still suppresses the subscriber's own writes, and the event
      // rate ceiling remains as the structural bound.
    }
    return causal;
  }
}

export const subscriberActorService = new SubscriberActorService();
