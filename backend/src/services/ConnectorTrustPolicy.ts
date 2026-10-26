/**
 * ConnectorTrustPolicy — the board's override of the connector trust policy,
 * NARROW-ONLY (universal harness connector design v1.5 section 4.3, choice C5,
 * check finding B3; owner rulings E456 and E462, slice S3).
 *
 * The connector release ships the CEILING (`connectorTrustCeiling.ts`, the
 * same bytes as `cli/connector_trust_policy.json`): which publishers, package
 * identities and issuing chains a harness binary must verify to. The board may
 * serve an override at GET /connectors/trust-policy, and that override can
 * only NARROW the ceiling:
 *
 *   minimumVersion     raised, never lowered
 *   denyVersions       added
 *   removePublishers   a publisher the ceiling names, taken away
 *
 * Nothing else is expressible. An entry that would widen (a publisher, an
 * issuing chain, a signer, a lower minimum, a product the release does not
 * trust) is refused here BEFORE anything is served, and named in `rejected`
 * by path and code, never by value. The connector applies the same rule
 * against its own release's ceiling, so a board that served a widening entry
 * anyway, or a party in between, still cannot widen what a connector trusts.
 * `cli/connector_trust_override_cases.json` holds the cases both suites run.
 *
 * WHERE THE OVERRIDE COMES FROM in this release: the deployment's operator
 * configuration, `connectorTrustPolicy` in relayhall.config.json. An
 * administrator edit on the board with step-up and audit (design 4.3) is not
 * part of slice S3 and is not built here.
 */
import { relayhallConfig } from '../config/relayhall';
import { CONNECTOR_TRUST_CEILING, CONNECTOR_TRUST_CEILING_SHA256 } from './connectorTrustCeiling';

export const CONNECTOR_TRUST_OVERRIDE_SCHEMA = 'rh.connector-trust-override/1';
export const CONNECTOR_TRUST_POLICY_RESPONSE_SCHEMA = 'rh.connector-trust-policy/1';
const OVERRIDE_FIELDS = ['minimumVersion', 'denyVersions', 'removePublishers'] as const;

export type OverrideRejectionCode =
  | 'OVERRIDE_MALFORMED' | 'OVERRIDE_UNKNOWN_FIELD' | 'OVERRIDE_UNKNOWN_PRODUCT'
  | 'OVERRIDE_WIDENING_FIELD' | 'OVERRIDE_LOWERS_MINIMUM' | 'OVERRIDE_UNKNOWN_PUBLISHER';

export interface OverrideRejection { path: string; code: OverrideRejectionCode }
export interface OverrideEntry { minimumVersion?: string; denyVersions?: string[]; removePublishers?: string[] }
export type AcceptedOverride = Record<string, Record<string, OverrideEntry>>;

interface CeilingRule { kind: string; minimumVersion: string; publishers: ReadonlyArray<{ id: string }> }
type Ceiling = { products: Record<string, Record<string, CeilingRule>> };

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

/** The connector's version grammar per package kind; null when malformed. */
export function versionTuple(kind: string, value: unknown): number[] | null {
  if (typeof value !== 'string') return null;
  if (kind === 'msix') {
    if (!/^(0|[1-9][0-9]{0,4})(\.(0|[1-9][0-9]{0,4})){3}$/.test(value)) return null;
    const parts = value.split('.').map(Number);
    return parts.every((part) => part <= 65535) ? parts : null;
  }
  if (!/^(0|[1-9][0-9]{0,5})(\.(0|[1-9][0-9]{0,5})){2}$/.test(value)) return null;
  return value.split('.').map(Number);
}

function compare(a: number[], b: number[]): number {
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
    const d = (a[i] ?? 0) - (b[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

const unique = (values: string[]): string[] => [...new Set(values)].sort();

/** Narrow-only: the entries that narrow `ceiling`, and every refused entry by path and code. */
export function validateConnectorTrustOverride(
  override: unknown, ceiling: Ceiling = CONNECTOR_TRUST_CEILING as unknown as Ceiling,
): { accepted: AcceptedOverride; rejected: OverrideRejection[] } {
  const accepted: AcceptedOverride = {};
  const rejected: OverrideRejection[] = [];
  if (override === null || override === undefined) return { accepted, rejected };
  if (!isPlainObject(override) || override.schemaVersion !== CONNECTOR_TRUST_OVERRIDE_SCHEMA) {
    return { accepted: {}, rejected: [{ path: '', code: 'OVERRIDE_MALFORMED' }] };
  }
  for (const key of Object.keys(override)) {
    if (key !== 'schemaVersion' && key !== 'products') rejected.push({ path: key, code: 'OVERRIDE_UNKNOWN_FIELD' });
  }
  const products = Object.prototype.hasOwnProperty.call(override, 'products') ? override.products : {};
  if (!isPlainObject(products)) return { accepted: {}, rejected: [...rejected, { path: 'products', code: 'OVERRIDE_MALFORMED' }] };
  for (const [product, systems] of Object.entries(products)) {
    const base = `products.${product}`;
    if (!isPlainObject(systems)) { rejected.push({ path: base, code: 'OVERRIDE_MALFORMED' }); continue; }
    for (const [system, entry] of Object.entries(systems)) {
      const where = `${base}.${system}`;
      const rule = Object.prototype.hasOwnProperty.call(ceiling.products, product)
        && Object.prototype.hasOwnProperty.call(ceiling.products[product], system)
        ? ceiling.products[product][system] : undefined;
      if (!rule) { rejected.push({ path: where, code: 'OVERRIDE_UNKNOWN_PRODUCT' }); continue; }
      if (!isPlainObject(entry)) { rejected.push({ path: where, code: 'OVERRIDE_MALFORMED' }); continue; }
      const kept: OverrideEntry = {};
      for (const [field, value] of Object.entries(entry)) {
        const path = `${where}.${field}`;
        if (!(OVERRIDE_FIELDS as readonly string[]).includes(field)) {
          rejected.push({ path, code: 'OVERRIDE_WIDENING_FIELD' });
          continue;
        }
        if (field === 'minimumVersion') {
          const asked = versionTuple(rule.kind, value);
          const floor = versionTuple(rule.kind, rule.minimumVersion);
          if (!asked || !floor) { rejected.push({ path, code: 'OVERRIDE_MALFORMED' }); continue; }
          if (compare(asked, floor) < 0) { rejected.push({ path, code: 'OVERRIDE_LOWERS_MINIMUM' }); continue; }
          kept.minimumVersion = value as string;
        } else if (field === 'denyVersions') {
          if (!Array.isArray(value) || value.length > 256 || !value.every((v) => versionTuple(rule.kind, v))) {
            rejected.push({ path, code: 'OVERRIDE_MALFORMED' });
            continue;
          }
          kept.denyVersions = unique(value as string[]);
        } else {
          if (!Array.isArray(value) || !value.every((v) => typeof v === 'string')) {
            rejected.push({ path, code: 'OVERRIDE_MALFORMED' });
            continue;
          }
          const known = new Set(rule.publishers.map((p) => p.id));
          if ((value as string[]).some((v) => !known.has(v))) rejected.push({ path, code: 'OVERRIDE_UNKNOWN_PUBLISHER' });
          const present = unique((value as string[]).filter((v) => known.has(v)));
          if (present.length) kept.removePublishers = present;
        }
      }
      if (Object.keys(kept).length) {
        accepted[product] = accepted[product] ?? {};
        accepted[product][system] = kept;
      }
    }
  }
  return { accepted, rejected };
}

/** The answer GET /connectors/trust-policy serves. Identifiers and versions only. */
export function connectorTrustPolicyResponse(configured: unknown = configuredConnectorTrustOverride()) {
  const { accepted, rejected } = validateConnectorTrustOverride(configured);
  const hasOverride = configured !== undefined && configured !== null;
  return {
    schemaVersion: CONNECTOR_TRUST_POLICY_RESPONSE_SCHEMA,
    ceilingSha256: CONNECTOR_TRUST_CEILING_SHA256,
    source: hasOverride ? 'deployment' : 'none',
    override: Object.keys(accepted).length
      ? { schemaVersion: CONNECTOR_TRUST_OVERRIDE_SCHEMA, products: accepted } : null,
    rejected,
  };
}

/** The deployment's configured override (relayhall.config.json `connectorTrustPolicy`), or undefined. */
export function configuredConnectorTrustOverride(): unknown {
  return (relayhallConfig as unknown as Record<string, unknown>).connectorTrustPolicy;
}
