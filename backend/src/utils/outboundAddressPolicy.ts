/**
 * outboundAddressPolicy — which IP addresses the board is allowed to open an
 * outbound connection to (RH-P3.C6).
 *
 * ── WHY THIS EXISTS ──
 *
 * Client ID Metadata Documents make the authorization server fetch a document
 * from a URL the CALLER supplies. That is a server-side request forgery
 * primitive by construction: without a policy, any unauthenticated caller
 * could point `client_id` at `http://169.254.169.254/…`, at a container-network
 * neighbour, or at the board's own admin surface, and use the AS as a proxy
 * into the deployment's private network.
 *
 * The policy is therefore FAIL-CLOSED on address, not on name: a name check is
 * defeated by DNS, and a name that resolves publicly today can resolve to
 * 127.0.0.1 tomorrow. Every literal below is a range that must never be
 * reachable from a caller-supplied URL.
 *
 * DNS REBINDING is closed separately, in the fetch itself: the caller of this
 * module resolves ONCE, validates every returned address here, and then pins
 * the connection to the validated address, so the agent never performs a
 * second resolution that could answer differently.
 */
import net from 'net';
import { ipv4CarrierForm, parseCarrierPrefixes } from './ipv4CarrierForms';

export type AddressRejection =
  | 'NOT_AN_IP'
  | 'LOOPBACK'
  | 'PRIVATE'
  | 'LINK_LOCAL'
  | 'SHARED_ADDRESS_SPACE'
  | 'MULTICAST'
  | 'RESERVED'
  | 'UNSPECIFIED'
  | 'IPV4_MAPPED'
  | 'IPV4_CARRIER';

export type AddressVerdict =
  | { allowed: true }
  /**
   * `carrier` is set ONLY on an `IPV4_CARRIER` refusal, and names the form
   * from `ipv4CarrierForms`. It is diagnostic: the refusal is decided by the
   * reason, and no caller may branch on the form.
   */
  | { allowed: false; reason: AddressRejection; carrier?: string };

const ALLOWED: AddressVerdict = { allowed: true };
const deny = (reason: AddressRejection): AddressVerdict => ({ allowed: false, reason });

/** Parse dotted-quad into its four octets, or null. */
function octets(address: string): [number, number, number, number] | null {
  if (!net.isIPv4(address)) return null;
  const parts = address.split('.').map((part) => Number(part));
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return null;
  return parts as [number, number, number, number];
}

/**
 * IPv4 ranges that are never a legitimate destination for a caller-supplied
 * URL. Ordered so the most specific classification wins the report.
 */
function verdictForIPv4(address: string): AddressVerdict {
  const parsed = octets(address);
  if (!parsed) return deny('NOT_AN_IP');
  const [a, b] = parsed;
  if (a === 0) return deny('UNSPECIFIED');                  // 0.0.0.0/8 "this network"
  if (a === 127) return deny('LOOPBACK');                   // 127.0.0.0/8
  if (a === 10) return deny('PRIVATE');                     // 10.0.0.0/8
  if (a === 172 && b >= 16 && b <= 31) return deny('PRIVATE');   // 172.16.0.0/12
  if (a === 192 && b === 168) return deny('PRIVATE');        // 192.168.0.0/16
  if (a === 169 && b === 254) return deny('LINK_LOCAL');     // 169.254.0.0/16 — cloud metadata
  if (a === 100 && b >= 64 && b <= 127) return deny('SHARED_ADDRESS_SPACE'); // 100.64.0.0/10 CGNAT
  if (a === 198 && (b === 18 || b === 19)) return deny('RESERVED');          // 198.18.0.0/15 benchmarking
  if (a === 192 && b === 0) return deny('RESERVED');         // 192.0.0.0/24 + 192.0.2.0/24 (TEST-NET-1)
  if (a === 198 && b === 51) return deny('RESERVED');        // 198.51.100.0/24 TEST-NET-2
  if (a === 203 && b === 0) return deny('RESERVED');         // 203.0.113.0/24 TEST-NET-3
  if (a >= 224 && a <= 239) return deny('MULTICAST');        // 224.0.0.0/4
  if (a >= 240) return deny('RESERVED');                     // 240.0.0.0/4 incl. broadcast
  return ALLOWED;
}

/** Expand an IPv6 address to its eight 16-bit groups, or null. */
function groups(address: string): number[] | null {
  if (!net.isIPv6(address)) return null;
  const zoneless = address.split('%')[0];
  const [head, tail] = zoneless.split('::') as [string, string | undefined];
  // An embedded dotted quad (::ffff:1.2.3.4) contributes two groups.
  const expand = (chunk: string): number[] => {
    const parts = chunk.length === 0 ? [] : chunk.split(':');
    const out: number[] = [];
    for (const part of parts) {
      if (part.includes('.')) {
        const quad = octets(part);
        if (!quad) return [Number.NaN];
        out.push((quad[0] << 8) | quad[1], (quad[2] << 8) | quad[3]);
      } else {
        out.push(Number.parseInt(part, 16));
      }
    }
    return out;
  };
  const left = expand(head);
  const right = tail === undefined ? [] : expand(tail);
  if ([...left, ...right].some((value) => !Number.isInteger(value) || value < 0 || value > 0xffff)) return null;
  if (tail === undefined) return left.length === 8 ? left : null;
  const fill = 8 - left.length - right.length;
  if (fill < 0) return null;
  return [...left, ...new Array<number>(fill).fill(0), ...right];
}

function verdictForIPv6(address: string): AddressVerdict {
  const parts = groups(address);
  if (!parts) return deny('NOT_AN_IP');
  const [g0, g1, g2, g3, g4, g5] = parts;
  const allZeroButLast = parts.slice(0, 7).every((value) => value === 0);
  if (allZeroButLast && parts[7] === 0) return deny('UNSPECIFIED');   // ::
  if (allZeroButLast && parts[7] === 1) return deny('LOOPBACK');      // ::1
  // ::ffff:a.b.c.d — an IPv4 destination wearing an IPv6 coat. Classify the
  // embedded address rather than letting the coat launder it.
  if (g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0xffff) {
    const embedded = `${parts[6] >> 8}.${parts[6] & 0xff}.${parts[7] >> 8}.${parts[7] & 0xff}`;
    const inner = verdictForIPv4(embedded);
    return inner.allowed ? deny('IPV4_MAPPED') : inner;
  }
  // 64:ff9b::/96 NAT64 — translates to an arbitrary IPv4 destination.
  if (g0 === 0x0064 && g1 === 0xff9b) return deny('RESERVED');
  // 100::/64 discard-only.
  if (g0 === 0x0100 && g1 === 0 && g2 === 0 && g3 === 0) return deny('RESERVED');
  if ((g0 & 0xfe00) === 0xfc00) return deny('PRIVATE');               // fc00::/7 unique-local
  if ((g0 & 0xffc0) === 0xfe80) return deny('LINK_LOCAL');            // fe80::/10
  if ((g0 & 0xff00) === 0xff00) return deny('MULTICAST');             // ff00::/8
  if (g0 === 0x2001 && g1 === 0x0db8) return deny('RESERVED');        // 2001:db8::/32 documentation
  if (g0 === 0x2001 && g1 === 0x0000) return deny('RESERVED');        // 2001::/32 Teredo

  // ── the IPv4-CARRYING forms, refused OUTRIGHT and never decoded ──
  //
  // Everything above classified this address by the range it is IN. What is
  // left can still CARRY an IPv4 destination: `::127.0.0.1` (IPv4-compatible),
  // `::ffff:0:7f00:1` (IPv4-translated), `2002:7f00:1::` (6to4), and an ISATAP
  // interface identifier riding under ANY global prefix. Every one of those
  // was reported ALLOWED before card `837fe75b`, and `::127.0.0.1` was
  // probe-confirmed reachable through the Client ID Metadata Document fetch.
  //
  // The list is SHARED with the knowledge plane (`./ipv4CarrierForms`) so the
  // board holds one answer to this question, and it is a REFUSAL list:
  // membership is the whole decision, so there is nothing to extract and
  // nothing to get wrong. That module carries the ruling and the accepted
  // over-refusal cost.
  //
  // It is asked LAST on purpose. A carrier that is ALSO inside a range named
  // above keeps that range's more specific reason — `::ffff:169.254.169.254`
  // stays `LINK_LOCAL`, `::1` stays `LOOPBACK`, `64:ff9b::7f00:1` stays
  // `RESERVED` —
  // so this change is strictly NARROWING: nothing this module already refused
  // is allowed now, and no existing refusal changed its reason.
  const carrier = ipv4CarrierForm(valueOfGroups(parts), DECLARED_CARRIER_PREFIXES);
  if (carrier !== null) return { allowed: false, reason: 'IPV4_CARRIER', carrier };

  return ALLOWED;
}

/**
 * The deployment's own translator prefixes (round-1 finding P1).
 *
 * Read ONCE, at module load, and parsed with THIS module's own address
 * parser. Malformed configuration throws here, which means the process does
 * not start — the intended behaviour for a security control whose
 * configuration is half-understood. Empty by default.
 */
const DECLARED_CARRIER_PREFIXES = parseCarrierPrefixes(
  process.env.RELAYHALL_IPV4_CARRIER_PREFIXES,
  (text) => ipv6AddressValue(text),
);

/** The 128-bit value of eight 16-bit groups. */
function valueOfGroups(parts: readonly number[]): bigint {
  return parts.reduce((acc, group) => (acc << 16n) + BigInt(group), 0n);
}

/**
 * The 128-bit value of an IPv6 literal, or null if it is not one.
 *
 * Exported for ONE purpose: the carrier list is shared with
 * `services/KnowledgeSourcePolicy`, which hands it a value produced by its
 * OWN parser. A shared table read through two parsers is only one decision if
 * the two parsers agree about what an address IS, so the suite proves that
 * agreement directly rather than assuming it.
 */
export function ipv6AddressValue(address: string): bigint | null {
  const parts = groups(address);
  return parts === null ? null : valueOfGroups(parts);
}

/**
 * May the board open an outbound connection to this address?
 *
 * Anything that is not a parseable IP literal is refused: this function is
 * called on ADDRESSES the resolver returned, never on names, so an
 * unparseable value means the caller passed the wrong thing.
 */
export function outboundAddressVerdict(address: string): AddressVerdict {
  if (net.isIPv4(address)) return verdictForIPv4(address);
  if (net.isIPv6(address)) return verdictForIPv6(address);
  return deny('NOT_AN_IP');
}

export function isOutboundAddressAllowed(address: string): boolean {
  return outboundAddressVerdict(address).allowed;
}
