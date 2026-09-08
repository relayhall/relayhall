// KnowledgeSourcePolicy.ts — RH-KW1 candidate A (card `0b4b779b`).
//
// The PURE half of the knowledge source plane: the knowledge-capability
// predicate, the §4.2 outbound (SSRF) policy, and the value validators the
// owner-plane act uses. Nothing here opens a socket or touches the database,
// which is what lets `ServiceRegistry` (set time) and `KnowledgeDialClient`
// (dial time) enforce the SAME rules from the SAME statements instead of two
// implementations that drift.
//
// Contract: ratified KNOWLEDGE-DESIGN v1.4 = `94747de9` §4.2/§4.3/§9; run
// packet `9dbb9fa3`; breakdown record `abc71ffb` v4 §1 candidate A.
//
// ── WHY THIS FILE IS NOT UNDER `backend/src/mcp/` ──
//
// The C4 posture gate censuses `backend/src/mcp/` only
// (`__tests__/c4McpPostureGate.test.ts`, `mcpDir`). Breakdown §4.3 rules that
// the dial client, the executors and this policy live under
// `backend/src/services/` so the gate's module-scope census stays true of the
// MCP surface it was written for. Nothing here is process state: every export
// is a pure function or a frozen constant.

import net from 'net';
import { outboundAddressVerdict, type AddressRejection } from '../utils/outboundAddressPolicy';
import { ipv4CarrierForm, parseCarrierPrefixes } from '../utils/ipv4CarrierForms';

/** §4.2 — whether core signs and sends caller-context assertions. */
export const KNOWLEDGE_CLAIMS_MODES = ['asserted', 'none'] as const;
export type KnowledgeClaimsMode = (typeof KNOWLEDGE_CLAIMS_MODES)[number];

/** §4.2 — how `sub` is derived. `pairwise` is the ruled default. */
export const KNOWLEDGE_SUBJECT_MODES = ['pairwise', 'direct'] as const;
export type KnowledgeSubjectMode = (typeof KNOWLEDGE_SUBJECT_MODES)[number];

/**
 * §9 — the reserved slug of the in-process board pseudo-source.
 *
 * The knowledge-capability predicate below carries the reserved arm because
 * §4.2 says the predicate is stated ONCE and a second statement is the defect
 * the design names. The board ROW and its adapter ship with the executor
 * (candidate C, breakdown §1). What ships HERE with the arm is the
 * RESERVATION (`RESERVED_SERVICE_SLUGS`, enforced at the registration
 * surface): an arm that admits a row nothing protects would let any
 * `services:write` holder register a Service called `board` and become
 * knowledge-capable with no owner-plane act at all — the exact trust boundary
 * §4.2 exists to be. Census finding `abc71ffb` F8 records that no reserved
 * slug mechanism existed before this candidate.
 */
export const KNOWLEDGE_BOARD_SOURCE_SLUG = 'board';

/**
 * Slugs no write surface may claim. Rows bearing them are created by the
 * migration chain (candidate C for `board`), never by `POST /services`.
 */
export const RESERVED_SERVICE_SLUGS: ReadonlySet<string> = new Set([
  KNOWLEDGE_BOARD_SOURCE_SLUG,
]);

export const KNOWLEDGE_MAX_RELEVANT_GROUPS = 64;
export const KNOWLEDGE_MAX_ALLOWED_NETWORKS = 32;
export const KNOWLEDGE_MAX_ENDPOINT_LENGTH = 2048;
export const KNOWLEDGE_MAX_CREDENTIAL_REF_LENGTH = 200;

/** A Bitwarden-style reference NAME (§4.2), never secret bytes. */
const CREDENTIAL_REF_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:\-/]{0,199}$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class KnowledgePolicyError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly field?: string,
  ) {
    super(message);
    this.name = 'KnowledgePolicyError';
  }
}

const refuse = (code: string, message: string, field?: string): never => {
  throw new KnowledgePolicyError(code, message, field);
};

// ───────────────────────── address normalization ─────────────────────────
//
// §4.2 requires validating every resolved record "after normalizing
// IPv6-mapped/compat and integer/octal/hex literal forms". Both halves are
// real attacks against a naive check:
//
//   * `https://2130706433/` and `https://0177.0.0.1/` are loopback to
//     `inet_aton`, which is what glibc's resolver applies, but they are not
//     recognised by `net.isIP` — a check that only inspects dotted-quad text
//     lets them through and the socket still lands on 127.0.0.1.
//   * `::ffff:127.0.0.1` and `::127.0.0.1` are loopback to the kernel and are
//     valid IPv6 text; a v6 range table that does not fold them to their v4
//     meaning classifies them as ordinary global unicast.
//
// So every address — from a URL host, from a resolver record, or from a
// connected socket — passes through `normalizeAddress` before it is
// classified, and the classifier only ever sees a canonical dotted quad or a
// canonical v6 address.

/**
 * Parse every `inet_aton` spelling of an IPv4 address: dotted quad, dotted
 * triple/pair/single, and each part in decimal, octal (leading `0`) or hex
 * (leading `0x`). Returns the canonical dotted quad, or null if the text is
 * not an IPv4 literal in any of those forms (i.e. it is a real hostname).
 */
export function parseIpv4Literal(text: string): string | null {
  if (text.length === 0 || /[^0-9a-fA-Fx.]/.test(text)) return null;
  const parts = text.split('.');
  if (parts.length < 1 || parts.length > 4) return null;

  const values: number[] = [];
  for (const part of parts) {
    if (part.length === 0) return null;
    let value: number;
    if (/^0[xX][0-9a-fA-F]+$/.test(part)) {
      value = parseInt(part.slice(2), 16);
    } else if (/^0[0-7]+$/.test(part)) {
      value = parseInt(part.slice(1), 8);
    } else if (/^[0-9]+$/.test(part)) {
      value = parseInt(part, 10);
    } else {
      return null;
    }
    if (!Number.isFinite(value) || value < 0) return null;
    values.push(value);
  }

  // inet_aton: the LAST part absorbs the remaining bytes.
  const leading = values.slice(0, -1);
  const last = values[values.length - 1];
  if (leading.some((v) => v > 255)) return null;
  const remainingBytes = 4 - leading.length;
  const maxLast = remainingBytes >= 4 ? 4294967295 : Math.pow(256, remainingBytes) - 1;
  if (last > maxLast) return null;

  let packed = 0;
  for (const v of leading) packed = packed * 256 + v;
  packed = packed * Math.pow(256, remainingBytes) + last;

  return [
    Math.floor(packed / 16777216) % 256,
    Math.floor(packed / 65536) % 256,
    Math.floor(packed / 256) % 256,
    packed % 256,
  ].join('.');
}

/**
 * Canonicalize any address text to either a dotted-quad IPv4 or a lower-case
 * IPv6, folding IPv4-mapped (`::ffff:a.b.c.d`) and IPv4-compatible
 * (`::a.b.c.d`) forms down to their IPv4 meaning. Returns null when the text
 * is not an address at all.
 */
export function normalizeAddress(raw: string): string | null {
  let text = raw.trim();
  if (text.startsWith('[') && text.endsWith(']')) text = text.slice(1, -1);
  if (text.length === 0) return null;
  // A zone index (`fe80::1%eth0`) never changes which range an address is in.
  const zoneAt = text.indexOf('%');
  if (zoneAt >= 0) text = text.slice(0, zoneAt);

  // NOTE: this NO LONGER FOLDS an IPv4 out of an IPv6 carrier, and that is
  // the point (owner ruling `623632b0` option (a)). Four review rounds each
  // found a defect in the previous round's decoder — first which carriers
  // exist, then the ORDER they are tried in, then the bit layout of one
  // extraction. Decoding is now gone: a carrier is REFUSED by
  // `classifyAddress`, never decoded, so there is no ordering and no
  // arithmetic left to get wrong.
  if (net.isIPv6(text)) return text.toLowerCase();

  return parseIpv4Literal(text);
}

// ───────────────────────── address classification ─────────────────────────

/**
 * The IPv6 forms that CARRY an IPv4 destination live in
 * `utils/ipv4CarrierForms`, shared with RH-P3.C6's `outboundAddressPolicy`.
 *
 * They MOVED there under card `837fe75b`, which closed the same gap on C6's
 * own path. Two copies of this list would be two security decisions that can
 * drift apart silently — the objection this suite already raises against a
 * second RANGE table, and it applies harder here: the list is the whole of
 * owner ruling `623632b0` option (a), and that ruling cost four review
 * rounds. The rationale, the closure and the accepted over-refusal cost
 * travel with the code, in that module.
 *
 * Re-exported so this module keeps the surface its own suite reads.
 */
export { ipv4CarrierForm, IPV4_CARRIER_FORM_NAMES } from '../utils/ipv4CarrierForms';

/**
 * The 128-bit value of `text` if it is IPv6 in any spelling, else null.
 * Bracket- and zone-tolerant, because a URL host arrives either way.
 */
export function asIpv6Value(text: string): bigint | null {
  let candidate = text.trim();
  if (candidate.startsWith('[') && candidate.endsWith(']')) candidate = candidate.slice(1, -1);
  const zoneAt = candidate.indexOf('%');
  if (zoneAt >= 0) candidate = candidate.slice(0, zoneAt);
  if (!net.isIPv6(candidate)) return null;
  return ipv6ToBigInt(candidate.toLowerCase());
}


function ipv4ToBigInt(address: string): bigint {
  return address
    .split('.')
    .reduce((acc, part) => (acc << 8n) + BigInt(Number(part)), 0n);
}

/**
 * Expand one `:`-separated run into 16-bit groups.
 *
 * An EMBEDDED DOTTED QUAD contributes TWO groups, not one. Getting that wrong
 * is not cosmetic: `parseInt('127.0.0.1', 16)` is `0x127`, so `::ffff:127.0.0.1`
 * would parse as a completely different address and every range test built on
 * it would answer about that other address. The shipped
 * `outboundAddressPolicy.groups()` expands the same way, deliberately.
 */
function expandHextetRun(run: string): string[] {
  if (run.length === 0) return [];
  const out: string[] = [];
  for (const part of run.split(':')) {
    if (part.length === 0) continue;
    if (part.includes('.')) {
      const quad = part.split('.').map((octet) => Number(octet));
      if (quad.length !== 4 || quad.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) {
        // Not a well-formed quad; contribute two zero groups rather than a
        // NaN that would silently become 0 later and read as `::`.
        out.push('0', '0');
        continue;
      }
      out.push(
        ((quad[0] << 8) | quad[1]).toString(16),
        ((quad[2] << 8) | quad[3]).toString(16),
      );
      continue;
    }
    out.push(part);
  }
  return out;
}

function ipv6ToBigInt(address: string): bigint {
  const [headText, tailText] = address.split('::');
  const head = expandHextetRun(headText ?? '');
  const tail = expandHextetRun(tailText ?? '');
  const missing = 8 - head.length - tail.length;
  const hextets = [...head, ...Array(Math.max(missing, 0)).fill('0'), ...tail];
  return hextets.reduce((acc, part) => (acc << 16n) + BigInt(parseInt(part || '0', 16)), 0n);
}

export function addressToBigInt(address: string): bigint {
  return net.isIPv4(address) ? ipv4ToBigInt(address) : ipv6ToBigInt(address);
}

interface Range {
  family: 4 | 6;
  base: bigint;
  bits: number;
}

function inRange(address: string, r: Range): boolean {
  const family: 4 | 6 = net.isIPv4(address) ? 4 : 6;
  if (family !== r.family) return false;
  const width = family === 4 ? 32 : 128;
  const shift = BigInt(width - r.bits);
  return (addressToBigInt(address) >> shift) === (r.base >> shift);
}

/**
 * §4.2, refused UNCONDITIONALLY — "even when `knowledge_allowed_networks`
 * names a private range".
 *
 * These are REASONS reported by the shipped classifier, not a second range
 * table. `169.254.169.254` — the cloud-metadata address acceptance item 5
 * names by value — is inside `169.254.0.0/16` and so arrives here as
 * `LINK_LOCAL`; `0.0.0.0` and `[::]` arrive as `UNSPECIFIED`.
 *
 * `IPV4_MAPPED` cannot occur on this path because `normalizeAddress` folds
 * mapped and compatible forms to their IPv4 meaning before the classifier
 * sees them. It is listed anyway: a reason that can never fire is cheap, and
 * a reason silently reclassified as allow-listable would not be.
 */
const NEVER_ADMISSIBLE_REASONS: ReadonlySet<AddressRejection> = new Set<AddressRejection>([
  'LOOPBACK',
  'LINK_LOCAL',
  'UNSPECIFIED',
  'IPV4_MAPPED',
  // Card `837fe75b`: C6 now refuses the IPv4-CARRYING forms itself. Like
  // `IPV4_MAPPED` above, this reason cannot fire on THIS path — the carrier
  // check below runs before the shipped verdict and answers
  // `ipv4-carrier-refused` first. It is listed for the same reason
  // `IPV4_MAPPED` is: a reason that can never fire is cheap, and a reason
  // silently reclassified as allow-listable would not be.
  'IPV4_CARRIER',
  'NOT_AN_IP',
]);

export type AddressDisposition =
  | { admissible: true; reason: 'public' | 'allow-listed' }
  | {
    admissible: false;
    reason: 'never-admissible' | 'private-not-allow-listed' | 'not-an-address'
    | 'ipv4-carrier-refused';
  };

/**
 * The ONE address decision. `allowedNetworks` are the owner-set CIDRs of
 * `knowledge_allowed_networks`; an EMPTY list means public addresses only,
 * which is §4.2's stated default.
 *
 * ── WHY THIS COMPOSES `outboundAddressPolicy` RATHER THAN RESTATING IT ──
 *
 * RH-P3.C6 already ships a reviewed range table for exactly this question:
 * which addresses the board may open an outbound connection to. A second
 * table would drift from it, and the drift would be silent and
 * security-relevant. So the shipped verdict decides WHICH RANGE an address is
 * in, and this function adds the one thing §4.2 needs that C6 has no notion
 * of: an owner-set allow-list, which may readmit an ordinarily-refused
 * private range but can never readmit loopback, link-local or the
 * unspecified address.
 *
 * ── THE ONE THING THIS ADDS BEFORE THE SHIPPED VERDICT, AND WHY ──
 *
 * `normalizeAddress` runs FIRST. `outboundAddressVerdict` folds the
 * IPv4-MAPPED form (`::ffff:127.0.0.1`) but not the IPv4-COMPATIBLE form
 * (`::127.0.0.1`), which reaches its IPv6 arm, matches no range there, and is
 * reported ALLOWED. Folding first closes that on this path. The same gap on
 * C6's own path is a finding this candidate REPORTS and does not repair: it
 * belongs to the authorization server's security surface and to its own
 * authz-reviewed change, not to a knowledge-plane candidate's diff.
 */
/**
 * The deployment's own translator prefixes (card `837fe75b` round-1 finding
 * P1), parsed with THIS module's parser from the same variable RH-P3.C6
 * reads. Both planes answer one question about one configuration; a prefix
 * either policy cannot parse stops the process rather than being honoured by
 * one plane and ignored by the other.
 */
const DECLARED_CARRIER_PREFIXES = parseCarrierPrefixes(
  process.env.RELAYHALL_IPV4_CARRIER_PREFIXES,
  (text) => asIpv6Value(text),
);

export function classifyAddress(raw: string, allowedNetworks: readonly string[]): AddressDisposition {
  const address = normalizeAddress(raw);
  if (address === null) return { admissible: false, reason: 'not-an-address' };

  // An IPv6 form that CARRIES an IPv4 destination is refused OUTRIGHT, with
  // no extraction (owner ruling `623632b0` option (a)). It is checked before
  // the shipped verdict and it cannot be readmitted by an allow-list: a
  // carrier is a carrier whatever it wraps.
  const value = asIpv6Value(raw);
  if (value !== null && ipv4CarrierForm(value, DECLARED_CARRIER_PREFIXES) !== null) {
    return { admissible: false, reason: 'ipv4-carrier-refused' };
  }

  const verdict = outboundAddressVerdict(address);
  if (verdict.allowed) return { admissible: true, reason: 'public' };

  // Checked BEFORE the allow-list and with no escape: an allow-list entry can
  // never reach these, which is the whole content of "refused
  // UNCONDITIONALLY, even when knowledge_allowed_networks names a private
  // range".
  if (NEVER_ADMISSIBLE_REASONS.has(verdict.reason)) {
    return { admissible: false, reason: 'never-admissible' };
  }

  for (const entry of allowedNetworks) {
    const parsed = parseAllowedNetwork(entry);
    if (parsed && inRange(address, parsed)) return { admissible: true, reason: 'allow-listed' };
  }
  return { admissible: false, reason: 'private-not-allow-listed' };
}

/** A CIDR or a bare address (treated as a single-host CIDR). Null if invalid. */
function parseAllowedNetwork(entry: string): Range | null {
  const slash = entry.indexOf('/');
  const addressText = slash >= 0 ? entry.slice(0, slash) : entry;
  const address = normalizeAddress(addressText);
  if (address === null) return null;
  const family: 4 | 6 = net.isIPv4(address) ? 4 : 6;
  const width = family === 4 ? 32 : 128;
  let bits = width;
  if (slash >= 0) {
    const prefix = entry.slice(slash + 1);
    if (!/^[0-9]{1,3}$/.test(prefix)) return null;
    bits = Number(prefix);
    if (bits > width) return null;
  }
  return { family, base: addressToBigInt(address), bits };
}

// ───────────────────────── value validators (SET time) ─────────────────────

/**
 * §4.2's outbound policy at SET time: `https` only — "stricter than the
 * shipped descriptor URL validator, which accepts http". A host that is
 * already a literal address is classified here too, so an operator cannot
 * store `https://127.0.0.1/` and discover at dial time that it is refused.
 */
export function validateKnowledgeEndpoint(
  value: unknown,
  field: string,
  allowedNetworks: readonly string[],
): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > KNOWLEDGE_MAX_ENDPOINT_LENGTH) {
    refuse('INVALID_KNOWLEDGE_ENDPOINT', `${field} must be an absolute https URL of at most ${KNOWLEDGE_MAX_ENDPOINT_LENGTH} characters`, field);
  }
  let parsed: URL;
  try {
    parsed = new URL(value as string);
  } catch {
    return refuse('INVALID_KNOWLEDGE_ENDPOINT', `${field} must be a valid absolute URL`, field);
  }
  if (parsed.protocol !== 'https:') {
    refuse('KNOWLEDGE_ENDPOINT_SCHEME_REFUSED', `${field} must use https — http is refused by the outbound policy (design 94747de9 §4.2)`, field);
  }
  if (parsed.username.length > 0 || parsed.password.length > 0) {
    refuse('INVALID_KNOWLEDGE_ENDPOINT', `${field} must not carry URL credentials`, field);
  }
  if (parsed.hash.length > 0) {
    refuse('INVALID_KNOWLEDGE_ENDPOINT', `${field} must not carry a fragment`, field);
  }
  if (parsed.hostname.length === 0) {
    refuse('INVALID_KNOWLEDGE_ENDPOINT', `${field} must name a host`, field);
  }
  // A literal host is decided now, under the same classifier the dial uses.
  if (normalizeAddress(parsed.hostname) !== null) {
    const disposition = classifyAddress(parsed.hostname, allowedNetworks);
    if (!disposition.admissible) {
      refuse(
        'KNOWLEDGE_ENDPOINT_ADDRESS_REFUSED',
        `${field} resolves to an address the outbound policy refuses (${disposition.reason})`,
        field,
      );
    }
  }
  return parsed.toString();
}

export function validateClaimsMode(value: unknown, field: string): KnowledgeClaimsMode {
  if (!(KNOWLEDGE_CLAIMS_MODES as readonly unknown[]).includes(value)) {
    refuse('INVALID_KNOWLEDGE_VALUE', `${field} must be one of: ${KNOWLEDGE_CLAIMS_MODES.join(', ')}`, field);
  }
  return value as KnowledgeClaimsMode;
}

export function validateSubjectMode(value: unknown, field: string): KnowledgeSubjectMode {
  if (!(KNOWLEDGE_SUBJECT_MODES as readonly unknown[]).includes(value)) {
    refuse('INVALID_KNOWLEDGE_VALUE', `${field} must be one of: ${KNOWLEDGE_SUBJECT_MODES.join(', ')}`, field);
  }
  return value as KnowledgeSubjectMode;
}

/** A reference NAME (§4.2). Secret bytes never reach the board. */
export function validateCoreCredentialRef(value: unknown, field: string): string {
  if (typeof value !== 'string' || !CREDENTIAL_REF_PATTERN.test(value)) {
    refuse(
      'INVALID_KNOWLEDGE_VALUE',
      `${field} must be a reference NAME of at most ${KNOWLEDGE_MAX_CREDENTIAL_REF_LENGTH} characters — never a secret value`,
      field,
    );
  }
  return value as string;
}

/** §4.2 `knowledge_relevant_groups` — group ids, bounded and de-duplicated. */
export function validateRelevantGroups(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || value.length > KNOWLEDGE_MAX_RELEVANT_GROUPS) {
    refuse('INVALID_KNOWLEDGE_VALUE', `${field} must be an array of at most ${KNOWLEDGE_MAX_RELEVANT_GROUPS} group ids`, field);
  }
  const out: string[] = [];
  for (const entry of value as unknown[]) {
    if (typeof entry !== 'string' || !UUID_PATTERN.test(entry)) {
      refuse('INVALID_KNOWLEDGE_VALUE', `${field} entries must be group ids`, field);
    }
    const id = (entry as string).toLowerCase();
    if (!out.includes(id)) out.push(id);
  }
  return out;
}

/**
 * §4.2 `knowledge_allowed_networks`. An entry naming a NEVER-admissible range
 * is refused HERE rather than silently ignored at dial time: an operator who
 * allow-lists a loopback range and is told nothing would reasonably believe the
 * source can be dialed on loopback, and would debug the wrong half.
 */
export function validateAllowedNetworks(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || value.length > KNOWLEDGE_MAX_ALLOWED_NETWORKS) {
    refuse('INVALID_KNOWLEDGE_VALUE', `${field} must be an array of at most ${KNOWLEDGE_MAX_ALLOWED_NETWORKS} CIDRs`, field);
  }
  const out: string[] = [];
  for (const entry of value as unknown[]) {
    if (typeof entry !== 'string' || entry.length === 0 || entry.length > 64) {
      refuse('INVALID_KNOWLEDGE_VALUE', `${field} entries must be CIDR strings`, field);
    }
    const parsed = parseAllowedNetwork(entry as string);
    if (!parsed) {
      refuse('INVALID_KNOWLEDGE_VALUE', `${field} entry '${entry}' is not a valid CIDR or address`, field);
    }
    const base = (entry as string).split('/')[0];
    const normalized = normalizeAddress(base);
    // The SAME decision the dial makes, asked of the entry's base address.
    if (normalized !== null && classifyAddress(normalized, []).reason === 'never-admissible') {
      refuse(
        'KNOWLEDGE_NETWORK_NEVER_ADMISSIBLE',
        `${field} entry '${entry}' names loopback, link-local or the unspecified address — those are refused unconditionally and cannot be allow-listed (design 94747de9 §4.2)`,
        field,
      );
    }
    if (!out.includes(entry as string)) out.push(entry as string);
  }
  return out;
}

// ───────────────────── the knowledge-capability predicate ─────────────────

/** The owner-plane half of the predicate, as stored on the Service row. */
export interface KnowledgeOwnerPlane {
  slug: string;
  knowledgeQueryEndpoint: string | null;
}

/** The descriptor half: the §4.3 block of the CURRENT descriptor version. */
export interface KnowledgeDescriptorBlock {
  compartments: string[];
}

/**
 * **The knowledge-capability predicate, stated ONCE** (§4.2).
 *
 * > "a Service is knowledge-capable iff (its owner-plane query endpoint is set
 * >  AND its current descriptor carries a `knowledgeSource` block with a
 * >  NON-EMPTY compartment list) OR it is the reserved board row under §9's
 * >  DECLARED exception."
 *
 * Every caller — the owner-plane act, `GET /knowledge-sources`, and the
 * candidate-C fan-out executor — asks THIS function. A second statement of
 * the predicate anywhere in the tree is the defect §4.2 names, and the
 * `knowledgeCapabilityPredicateStatedOnce` census in
 * `__tests__/kw1KnowledgeSourcePlane.test.ts` fails on one.
 *
 * The reserved arm is deliberately NOT "any row whose slug is `board`" in a
 * world where anything could claim that slug: `RESERVED_SERVICE_SLUGS` is
 * enforced at the registration surface in the same candidate, so the only row
 * that can hold it is one the migration chain wrote. BD-1 (breakdown §2)
 * mutation-drills the other direction — a NON-reserved row with no endpoints
 * must NOT become capable.
 */
export function isKnowledgeCapable(
  service: KnowledgeOwnerPlane,
  descriptorBlock: KnowledgeDescriptorBlock | null | undefined,
): boolean {
  if (service.slug === KNOWLEDGE_BOARD_SOURCE_SLUG) return true;
  return (
    typeof service.knowledgeQueryEndpoint === 'string' &&
    service.knowledgeQueryEndpoint.length > 0 &&
    Array.isArray(descriptorBlock?.compartments) &&
    (descriptorBlock as KnowledgeDescriptorBlock).compartments.length > 0
  );
}
