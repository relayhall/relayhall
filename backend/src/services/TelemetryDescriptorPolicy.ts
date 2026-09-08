/**
 * TelemetryDescriptorPolicy — owner decision D3, the ingest half.
 *
 * A Connector's telemetry policy is declared in its **immutable versioned
 * descriptor**, not in a mutable column: `service_descriptor_versions` is
 * append-only (migration 076), so declaring a tier means publishing a NEW
 * descriptor version and never editing one. This module reads the CURRENT
 * version of the owning Connector's descriptor and answers two questions the
 * ingest path must ask before it stores anything:
 *
 *   1. **What policy tier may this source write at?** D3 is deny-by-default:
 *      *"DENY-BY-DEFAULT for connectors declaring no tier."* A Connector whose
 *      current descriptor declares no `telemetryTier` cannot write envelopes at
 *      all — not at Tier 0, not silently, not "until configured".
 *   2. **Is this `source.product` one the Connector declared?** §5.2, ratified
 *      as TS-3: *"one Connector credential per installed outpost with
 *      descriptor-declared, ingest-enforced product allowlists"*. A multi-tool
 *      outpost reports several products under one credential, and the
 *      descriptor is what bounds which.
 *
 * THE TIER MAPPING (§6, the table). The descriptor tier says what the connector
 * SENDS; the policy tier says what the board ACCEPTS AND STORES. They are not
 * the same axis, and the mapping is enforced here rather than assumed:
 *
 *   `none`     → no telemetry at all; envelope writes are refused.
 *   `presence` → Tier 0. The shipped frame contract already enforces a closed
 *                status vocabulary, and any free-text frame field passes the
 *                Tier-0 redactor.
 *   `full`     → Tier 0 by default. §6 allows Tier 1/2 "by explicit per-source
 *                policy", but TS-5 ships neither at TW1a, so `full` resolves to
 *                Tier 0 and the caller refuses anything else.
 *
 * **C7 FRAMES ARE UNTOUCHED BY THIS** (owner decision D3, final sentence). The
 * frame contract — `heartbeat|status`, pushed `active|idle`, derived `stale`,
 * zero server-side effect, short retention — is exactly as reviewed and
 * integrated. Nothing in this module is consulted by `POST /telemetry/frames`.
 */
import type { Pool } from 'pg';
import type { TelemetryDescriptorTier, TelemetryPolicyTier } from '../types/TelemetryEnvelope';

export interface TelemetryDescriptorPolicy {
  /** False when the current descriptor declares no `telemetryTier` at all (D3). */
  declared: boolean;
  /** The declared descriptor tier, or null when none is declared. */
  descriptorTier: TelemetryDescriptorTier | null;
  /** The policy tier that descriptor tier maps to, or null when none is declared. */
  policyTier: TelemetryPolicyTier | null;
  /**
   * The declared product list (§5.2). `null` means the descriptor declared a
   * tier but no product list — which is NOT a wildcard: the caller refuses
   * every product, because an unbounded allowlist is not an allowlist.
   */
  products: readonly string[] | null;
  /** The descriptor version these answers came from, for the audit trail. */
  descriptorVersion: number | null;
}

const NOT_DECLARED: TelemetryDescriptorPolicy = {
  declared: false,
  descriptorTier: null,
  policyTier: null,
  products: null,
  descriptorVersion: null,
};

/** §6's descriptor-tier → maximum-policy-tier mapping, enforced not assumed. */
export function policyTierForDescriptorTier(tier: TelemetryDescriptorTier): TelemetryPolicyTier | null {
  switch (tier) {
    case 'none':
      // "no telemetry — liveness only via lease activity". Not a tier-0 source.
      return null;
    case 'presence':
    case 'full':
      // Both cap at Tier 0 while TS-5 stands. `full` becomes 1 or 2 only by an
      // explicit per-source policy that TW1a does not ship.
      return 0;
    default:
      return null;
  }
}

interface DescriptorRow {
  descriptor: unknown;
  version: number;
}

/**
 * Read the CURRENT descriptor version for the Connector owning `connectorId`
 * and resolve its telemetry policy.
 *
 * The Connector is identified by its acting PRINCIPAL id, which is how the
 * registry stores the relationship (`services.principal_id`, migration 097's
 * `services_connector_principal_required`) and how `connectorRegistry.ts` asks
 * the same question. A service row with no current version, a retired version,
 * or a descriptor with no `telemetryTier` all resolve to NOT DECLARED — three
 * different ways of not having said anything, and D3 treats them alike.
 */
export async function resolveTelemetryTier(
  pool: Pool, connectorPrincipalId: string,
): Promise<TelemetryDescriptorPolicy> {
  const result = await pool.query(
    `SELECT v.descriptor, v.version
       FROM services s
       JOIN service_descriptor_versions v
         ON v.service_id = s.id AND v.version = s.current_descriptor_version
      WHERE s.principal_id = $1
        AND s.kind = 'connector'
        AND v.retired_at IS NULL
      LIMIT 1`,
    [connectorPrincipalId],
  );
  const row = result.rows[0] as DescriptorRow | undefined;
  if (!row) return NOT_DECLARED;

  const descriptor = row.descriptor;
  if (typeof descriptor !== 'object' || descriptor === null || Array.isArray(descriptor)) {
    return NOT_DECLARED;
  }
  const telemetry = (descriptor as Record<string, unknown>).telemetry;
  if (typeof telemetry !== 'object' || telemetry === null || Array.isArray(telemetry)) {
    return NOT_DECLARED;
  }
  const declaredTier = (telemetry as Record<string, unknown>).tier;
  if (declaredTier !== 'none' && declaredTier !== 'presence' && declaredTier !== 'full') {
    return NOT_DECLARED;
  }

  const rawProducts = (telemetry as Record<string, unknown>).products;
  const products = Array.isArray(rawProducts)
    ? rawProducts.filter((p): p is string => typeof p === 'string')
    : null;

  return {
    declared: true,
    descriptorTier: declaredTier,
    policyTier: policyTierForDescriptorTier(declaredTier),
    products,
    descriptorVersion: row.version,
  };
}

/**
 * §5.2 / TS-3: is this `source.product` one the Connector declared?
 *
 * An undeclared product list is NOT a wildcard. A descriptor that names a tier
 * but no products has said which products it reports: none. Treating the
 * absence as "allow everything" would make the allowlist opt-in, and an
 * allowlist nobody opts into is decoration.
 */
export function productIsDeclared(policy: TelemetryDescriptorPolicy, product: string): boolean {
  if (!policy.declared) return false;
  if (!policy.products || policy.products.length === 0) return false;
  return policy.products.includes(product);
}
