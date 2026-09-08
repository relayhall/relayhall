/**
 * TelemetryPrincipalService — §4.1 / §5.1 principal derivation for envelope
 * ingest (RH-TW1a candidate B, card `beac9c79`).
 *
 * THE HIGHEST-RISK SURFACE OF THIS CARD. Everything stored about an envelope
 * event is attributed by what this module returns, and design `7d5c0cdc` §4.1
 * is explicit that identity here is CREDENTIAL-DERIVED, NEVER CLIENT-ASSERTED:
 *
 *   > Any identity fields *inside* the payload are advisory, stored under
 *   > `attributes.*` subject to the §4.5 tier rules, never trusted for
 *   > authorization or attribution.
 *
 * This module therefore never sees an envelope. It is handed the authenticated
 * chain the auth middleware already resolved and nothing else, so there is no
 * code path by which a payload value could reach a binding.
 *
 * THE TWO ACCEPTED PRINCIPAL CLASSES (§5.1):
 *
 *   1. a **Connector credential** — the acting principal is itself a Connector
 *      by the registry. `agent_id` is NULL: any Agent or user identifier such a
 *      writer observes is an advisory, tier-governed *observed-by-intermediary*
 *      attribute, never an authoritative attribution.
 *   2. an **Agent-layer credential whose chain has a Connector ancestor**
 *      (`Account -> Connector -> ... -> Agent`). `agent_id` is the acting
 *      principal; `connector_id` is the Connector ancestor; `account_id` is the
 *      Account at the head of the chain. All three derive together, from the
 *      chain.
 *
 * AND THE REFUSAL THAT MAKES THE REST TOTAL: a **direct `Account -> Agent`**
 * presenter — AUTHZ's other legal chain shape — is REFUSED with a distinct,
 * audited error. Its chain contains no Connector, so it cannot satisfy the
 * total `connector_id` requirement of §4.3 event identity and §5.3 source keys.
 * Sitting ruling TS-3 additionally rules that `telemetry:write` is not minted
 * onto such chains; ingest refuses defensively regardless, so the restriction
 * is reachable either way.
 *
 * CONNECTOR-NESS IS A REGISTRY QUESTION, AND THERE IS ONE PREDICATE FOR IT.
 * `utils/connectorRegistry.ts` was made the ratified predicate by owner ruling
 * `4ae7ce53` and is REQUIRED to be reused rather than re-derived — three review
 * rounds on another card each added a principal-column condition to an
 * approximation of this question, and the class of defect never changed. This
 * module composes that predicate with the chain the middleware resolved via
 * `DelegationService.resolveChain()`. **A third derivation is a REJECT by
 * ruling, not by taste**, so nothing here looks at `principals.kind`, at a
 * handle, or at the chain's shape to decide Connector-ness.
 */
import type { Pool } from 'pg';
import { pool as defaultPool } from '../db/connection';
import type { DelegationActorLink } from './AuthorizationService';
import { isRegistryConnector, type RegistryQueryable } from '../utils/connectorRegistry';
import type { TelemetryPolicyTier, TelemetryPrincipalBinding } from '../types/TelemetryEnvelope';
import { resolveTelemetryTier, type TelemetryDescriptorPolicy } from './TelemetryDescriptorPolicy';

/** Distinct, audited refusal codes. Each names exactly one reason. */
export type TelemetryPrincipalRefusal =
  /** The chain contains no Connector — a direct Account -> Agent presenter (§5.1). */
  | 'TELEMETRY_PRINCIPAL_NO_CONNECTOR'
  /** No resolved principal at all: the request never authenticated an identity. */
  | 'TELEMETRY_PRINCIPAL_REQUIRED'
  /** The owning Connector's current descriptor declares no telemetry tier (D3). */
  | 'TELEMETRY_TIER_NOT_DECLARED'
  /** The declared tier is not one TW1a accepts (TS-5, D9: Tier 0 only). */
  | 'TELEMETRY_TIER_UNAVAILABLE'
  /**
   * The presenter has no Account in its authenticated chain, so `account_id`
   * would have to be invented (review `29874574` F1).
   */
  | 'TELEMETRY_PRINCIPAL_NO_ACCOUNT';

export interface TelemetryPrincipalSuccess {
  ok: true;
  binding: TelemetryPrincipalBinding;
  /** Which of the two §5.1 classes this was, for the audit trail and the tests. */
  principalClass: 'connector' | 'connector_descended_agent';
  /** The descriptor policy the tier and product allowlist came from. */
  descriptor: TelemetryDescriptorPolicy;
}

export interface TelemetryPrincipalFailure {
  ok: false;
  code: TelemetryPrincipalRefusal;
  message: string;
  /** Metadata for the audit row. Identifiers only — never payload bytes. */
  audit: Record<string, unknown>;
}

export type TelemetryPrincipalResult = TelemetryPrincipalSuccess | TelemetryPrincipalFailure;

export interface TelemetryPrincipalInput {
  /** The authenticated acting principal. */
  actingPrincipalId: string | undefined;
  /**
   * The middleware-resolved delegation chain, ACTING FIRST and Account last
   * (`middleware/auth.ts` builds it from `DelegationService.resolveChain`).
   * `null`/absent means the credential is Account-plane: no delegation, and
   * therefore no Connector ancestor.
   */
  delegationLinks: DelegationActorLink[] | null | undefined;
}

export class TelemetryPrincipalService {
  constructor(private readonly pool: Pool = defaultPool) {}

  /**
   * Derive the authoritative binding for an envelope write, or refuse.
   *
   * Ordering note: the Connector is located by walking the chain from the
   * ACTING principal upward and asking the registry about each link, so the
   * NEAREST Connector ancestor wins. That matters for a chain with more than
   * one — attributing to the furthest would let a broad parent Connector claim
   * events belonging to a narrower child.
   */
  async derive(input: TelemetryPrincipalInput): Promise<TelemetryPrincipalResult> {
    const actingPrincipalId = input.actingPrincipalId;
    if (!actingPrincipalId) {
      return {
        ok: false,
        code: 'TELEMETRY_PRINCIPAL_REQUIRED',
        message: 'Envelope ingest requires a resolved principal identity',
        audit: {},
      };
    }

    const db = this.pool as unknown as RegistryQueryable;
    const links = input.delegationLinks ?? [];

    // The acting principal first: a Connector credential is class 1 and needs
    // no chain at all.
    const actingIsConnector = await isRegistryConnector(db, actingPrincipalId);

    let connectorId: string | null = null;
    let agentId: string | null = null;

    if (actingIsConnector) {
      connectorId = actingPrincipalId;
      // §4.1: "Connector- or outpost-authenticated writes never carry an
      // authoritative agent_id." Explicit, not incidental.
      agentId = null;
    } else {
      // Class 2: walk upward for the NEAREST Connector ancestor. `links[0]` is
      // the acting principal itself, already tested above.
      for (const link of links.slice(1)) {
        if (await isRegistryConnector(db, link.principalId)) {
          connectorId = link.principalId;
          agentId = actingPrincipalId;
          break;
        }
      }
    }

    if (!connectorId) {
      // The §5.1 refusal. A direct Account -> Agent presenter lands here, and
      // so does an Account-plane credential with no chain at all.
      return {
        ok: false,
        code: 'TELEMETRY_PRINCIPAL_NO_CONNECTOR',
        message:
          'Envelope ingest requires a Connector credential, or an Agent credential whose chain has a Connector '
          + 'ancestor. A direct Account -> Agent chain has no owning Connector, so it cannot satisfy the total '
          + 'connector_id requirement of the event identity (design 7d5c0cdc §4.3) or the telemetry source key (§5.3).',
        audit: {
          actingPrincipalId,
          chainDepth: links.length,
          chainKinds: links.map((link) => link.kind),
        },
      };
    }

    // The Account is the head of the chain — and there must BE one.
    //
    // Review `29874574` F1 (BLOCKER): this used to fall back to
    // `accountId = actingPrincipalId` when the chain was empty, on the reading
    // that "a Connector with no chain is its own account". That reading was
    // wrong, and REACHABLE. Migration 097 backfills pre-096 Connectors as
    // PARENTLESS principals marked `legacy_identity = TRUE`, described in its
    // own header as "preserved, audited, FROZEN OUT OF THE NEW MACHINERY,
    // re-parented by the owner at the Phase-5 estate transition" — and
    // `middleware/auth.ts` sends legacy identities down the §10 compatibility
    // arm, which never calls `resolveChain` and so leaves `delegationLinks`
    // unset. Such a Connector therefore arrived here with no chain, and every
    // event it wrote was attributed to an Account that does not exist.
    //
    // §4.1 is that `account_id` comes FROM THE AUTHENTICATED CHAIN. A value
    // this service invented is not that, so the presenter is refused instead —
    // which is also exactly what 097 asks of frozen rows.
    const accountLink = links.length > 0 ? links[links.length - 1] : null;
    if (!accountLink || accountLink.principalId === connectorId) {
      return {
        ok: false,
        code: 'TELEMETRY_PRINCIPAL_NO_ACCOUNT',
        message:
          'The presenting Connector has no owning Account in its authenticated chain, so account_id cannot be '
          + 'derived (design 7d5c0cdc §4.1). A pre-096 Connector backfilled by migration 097 is parentless and '
          + 'frozen out of new machinery until the owner re-parents it.',
        audit: {
          actingPrincipalId,
          connectorId,
          chainDepth: links.length,
          legacyIdentity: links[0]?.legacyIdentity ?? null,
        },
      };
    }
    const accountId = accountLink.principalId;

    // D3: the owning Connector's CURRENT immutable descriptor version must
    // declare a telemetry tier. Deny-by-default — no declared tier, no writes.
    const descriptor = await resolveTelemetryTier(this.pool, connectorId);
    if (!descriptor.declared) {
      return {
        ok: false,
        code: 'TELEMETRY_TIER_NOT_DECLARED',
        message:
          'The owning Connector current descriptor version declares no telemetryTier. Envelope writes are '
          + 'denied by default until one is declared (owner decision D3).',
        audit: { actingPrincipalId, connectorId, accountId },
      };
    }

    const policyTier = descriptor.policyTier;
    if (policyTier !== 0) {
      // TS-5 / D9. The engine refuses these too; refusing here as well means a
      // Tier-1 source is turned away before anything is parsed or stored.
      return {
        ok: false,
        code: 'TELEMETRY_TIER_UNAVAILABLE',
        message:
          `The owning Connector declares telemetry tier '${descriptor.descriptorTier}', which TW1a does not accept. `
          + 'Ratification sitting 7e7eeca3 TS-5: Tier 0 ONLY in TW1a; Tier 1 waits for demand and Tier 2 arrives with TW5.',
        audit: { actingPrincipalId, connectorId, accountId, declaredTier: descriptor.descriptorTier },
      };
    }

    return {
      ok: true,
      principalClass: agentId ? 'connector_descended_agent' : 'connector',
      descriptor,
      binding: {
        accountId,
        connectorId,
        agentId,
        policyTier: policyTier as TelemetryPolicyTier,
      },
    };
  }
}

export const telemetryPrincipalService = new TelemetryPrincipalService();
