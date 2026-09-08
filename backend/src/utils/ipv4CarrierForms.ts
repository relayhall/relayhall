/**
 * ipv4CarrierForms — the IPv6 forms that CARRY an IPv4 destination, as a
 * REFUSAL LIST shared by every outbound policy on the board.
 *
 * ── WHY THIS IS ONE MODULE AND NOT ONE PER POLICY ──
 *
 * Two policies decide whether the board may open an outbound connection:
 * `utils/outboundAddressPolicy` (RH-P3.C6 — the authorization server fetching
 * a caller-supplied Client ID Metadata Document) and
 * `services/KnowledgeSourcePolicy` (RH-KW1 §4.2 — the knowledge plane dialling
 * an owner-configured source). Both must answer the same question about the
 * same class of address, and a second copy of the answer is a second security
 * decision that can drift from the first silently. The KW1 suite already
 * forbids a second RANGE table for exactly that reason; this module is the
 * same argument applied to the carrier list, which is the harder half.
 *
 * The list lives HERE, in `utils`, because `KnowledgeSourcePolicy` already
 * imports `outboundAddressPolicy` — the dependency runs services → utils, so
 * a shared table anywhere in `services` would be a cycle. Nothing in this file
 * imports anything: it is arithmetic over a 128-bit value, and each policy
 * hands it the value using the address parser it already ships and already
 * drills.
 *
 * ── THE STABLE NAMES, FOR EVERY OUTBOUND CALLER ──
 *
 * A new outbound surface should NOT import this file. The address-level
 * entry point is `outboundAddressVerdict(address)` in
 * `utils/outboundAddressPolicy` (with `isOutboundAddressAllowed` for the
 * boolean): it takes an address STRING, applies the full range table AND the
 * carrier list below, and answers `{ allowed: false, reason: 'IPV4_CARRIER',
 * carrier }` for a carrier. That is what `ssoOutbound`,
 * `OAuthClientMetadataService` and the telemetry exporter all use, and it is
 * the name to keep stable.
 *
 * This module's own surface — `ipv4CarrierForm(value: bigint)` and
 * `IPV4_CARRIER_FORM_NAMES` — is for a policy that has ALREADY parsed the
 * address into a 128-bit value and needs the membership question on its own,
 * which today is `KnowledgeSourcePolicy` and its drills. Anything holding a
 * string wants `outboundAddressVerdict` instead.
 *
 * ── WHY A REFUSAL LIST AND NOT A DECODER (owner ruling `623632b0` (a)) ──
 *
 * This text is KW1's, kept with the code it explains. Four review rounds each
 * found a defect in the previous round's repair, all on this one class. The
 * first two were about WHICH carriers exist (IPv4-translated, then
 * 6to4/Teredo, then ISATAP). The last two were about DECODING the ones already
 * listed: the branches returned on first match when a single address can carry
 * two different IPv4s (`2002:...:0:5efe:7f00:1` carries a public address in
 * its 6to4 prefix and loopback in its ISATAP interface identifier), and the
 * RFC 6052 `/48` NAT64 extraction read the low 32 bits when that format splits
 * the IPv4 around the reserved `u` octet.
 *
 * Both defects live in machinery that only exists to answer "which IPv4 does
 * this carry". So the machinery is gone. The question is now "IS this a
 * carrier", which is membership: no ordering, no bit layouts, no RFC formats,
 * no union logic. A fifth round cannot find a decoding defect in a module that
 * does not decode.
 *
 * ── THE CLOSURE, AND EXACTLY WHAT IT DOES NOT COVER ──
 *
 * The REGISTERED half is the IANA IPv6 Special-Purpose Address Registry's
 * IPv4-carrying entries, which is finite and enumerable, rather than a list
 * of SPELLINGS:
 *
 *   ::/64            -- the IPv4-compatible, -mapped and -translated forms
 *                       (RFC 4291, RFC 2765)
 *   64:ff9b::/96     -- NAT64 well-known prefix (RFC 6052)
 *   64:ff9b:1::/48   -- NAT64 local-use prefix (RFC 8215)
 *   2002::/16        -- 6to4 (RFC 3056), IPv4 in the 32 bits after the prefix
 *   2001::/32        -- Teredo (RFC 4380), which carries TWO: the server in
 *                       bits 32..63 and the client in the low 32 bits, XORed
 *                       with all-ones
 *   any prefix + an
 *   ISATAP interface
 *   identifier        -- ISATAP (RFC 5214). The one carrier that is NOT keyed
 *                       on a prefix: the IPv4 rides in the IID, so it appears
 *                       under a GLOBAL prefix and reads as ordinary global
 *                       unicast until the IID is decoded
 *
 * That list is complete for the REGISTRY. It is NOT complete for "every IPv6
 * form that carries an IPv4 destination", and an earlier version of this
 * header said it was. Round-1 review finding P1 (verdict
 * `VERDICT-hermes-20260905T193030Z`) proved the difference with
 * `2606:4700:1234:5600:7f:0:100:0`: under RFC 6052 §2.2 an organisation may
 * choose its OWN NAT64 prefix at /32, /40, /48, /56, /64 or /96, and RFC 5969
 * 6rd lets a service provider do the same. Those prefixes are
 * DEPLOYMENT-SPECIFIC — globally unenumerable by construction — so a static
 * list cannot contain them and no amount of care would have made it complete.
 * The witness above reads as ordinary global unicast and carries loopback.
 *
 * ── THE DEPLOYMENT-DECLARED HALF ──
 *
 * So the deployment declares them, in `RELAYHALL_IPV4_CARRIER_PREFIXES`: a
 * comma-separated list of `<ipv6>/<bits>` an operator sets when the board sits
 * behind a translator that maps one of these prefixes onto IPv4. It is EMPTY
 * by default, so a deployment that declares nothing behaves exactly as this
 * module did before the declaration existed — the repair adds a way to close
 * the hole, it does not change anyone's answers on its own.
 *
 * It stays a MEMBERSHIP question. A declared prefix refuses everything under
 * it, which is right by construction: every address under a translator prefix
 * IS an IPv4 destination. Nothing is decoded, so RFC 6052's `u` octet and the
 * six permitted lengths never have to be read correctly — the length only has
 * to be compared.
 *
 * PARSING IS THE CALLER'S. `parseCarrierPrefixes` takes the value function as
 * an argument, so each policy converts the configured text with the parser it
 * already ships and already drills. A third parser in this module is exactly
 * the drift the shared list exists to avoid. Malformed configuration THROWS
 * at module load — a security control whose configuration is half-understood
 * must not start, and an operator who mistyped a prefix needs to be told, not
 * quietly given the empty list.
 *
 * ── THE COST, ACCEPTED BY BOTH CALLERS, FOR DIFFERENT REASONS ──
 *
 * This OVER-REFUSES: a 6to4 or ISATAP address wrapping a perfectly public
 * IPv4 is refused too, and so is every RFC 6052 NAT64 layout regardless of
 * what it maps.
 *
 * KW1 accepts that because §4.2's outbound targets are NAMED HOSTS an owner
 * configures, and an owner who wants a transition destination writes its
 * hostname or its plain IPv4.
 *
 * RH-P3.C6 accepts it too, and card `837fe75b` asked it to decide that for
 * itself rather than inherit the answer. It decides the same way, and more
 * easily: C6's URL comes from an UNAUTHENTICATED caller, so the address is
 * adversary-chosen rather than owner-chosen and the benefit of the doubt runs
 * the other way. A `client_id` is a document URL a client publishes for the
 * world to fetch, which in practice is a hostname; nobody publishes one at a
 * 6to4 or ISATAP literal. And C6 has already made this exact trade once: the
 * shipped `IPV4_MAPPED` reason refuses `::ffff:<public v4>` outright rather
 * than admit a mapped form of an allowed address. Refusing the rest of the
 * carrier family is that decision applied consistently, not a new one.
 */

/**
 * The IPv6 forms that CARRY an IPv4 destination. Membership is the whole
 * decision: a carrier is REFUSED, never decoded.
 */
const IPV4_CARRIER_FORMS: ReadonlyArray<{ name: string; carries: (value: bigint) => boolean }> = [
  {
    // ::/64 -- IPv4-compatible, IPv4-mapped and IPv4-translated (RFC 4291,
    // RFC 2765). `::` and `::1` are excluded: they are the unspecified and
    // loopback addresses, not carriers, and the shipped RH-P3.C6 classifier
    // already refuses them with their own exact reasons.
    name: 'ipv4-compatible/mapped/translated',
    carries: (value) => (value >> 64n) === 0n && value > 1n,
  },
  { name: 'nat64-well-known', carries: (value) => (value >> 32n) === 0x0064ff9bn << 64n },
  { name: 'nat64-local-use', carries: (value) => (value >> 80n) === 0x0064ff9b0001n },
  { name: '6to4', carries: (value) => (value >> 112n) === 0x2002n },
  { name: 'teredo', carries: (value) => (value >> 96n) === 0x20010000n },
  {
    // ISATAP (RFC 5214) is the one carrier keyed on the INTERFACE IDENTIFIER
    // rather than a prefix, so it rides under any prefix at all. The IID is
    // `00-00-5E-FE` or `02-00-5E-FE`; the two differ only in the u/l bit.
    name: 'isatap',
    carries: (value) => ((value >> 32n) & 0xfdffffffn) === 0x00005efen,
  },
];

/** One deployment-declared IPv4-carrying prefix. */
export interface CarrierPrefix {
  /** The text an operator wrote, quoted back verbatim in the refusal. */
  readonly text: string;
  readonly value: bigint;
  readonly bits: number;
}

/** Configuration this module refuses to start with. */
export class CarrierPrefixConfigError extends Error {
  constructor(message: string) {
    super(`RELAYHALL_IPV4_CARRIER_PREFIXES: ${message}`);
    this.name = 'CarrierPrefixConfigError';
  }
}

/**
 * Parse the declared prefixes, or THROW.
 *
 * `toValue` is the caller's own address parser, so this module gains no
 * second opinion about what an address is. Every rejection below is a
 * configuration an operator can see and fix; none of them is a value this
 * function may quietly drop, because a dropped prefix is a hole that looks
 * like a closed one.
 *
 * ── THE TWO STATES, AND WHY THERE ARE ONLY TWO (round-2 finding P2) ──
 *
 * NOT CONFIGURED is `undefined` or a wholly blank value. That names
 * nothing, promises nothing, and is what every other unset setting in this
 * tree looks like.
 *
 * ANYTHING ELSE IS A LIST, and every entry in it must name a prefix. An
 * earlier version filtered empty entries out, so `,` and ` , ` loaded as NO
 * prefixes while looking configured — an operator typo that left the
 * translator prefix wide open, which is the exact exposure this setting
 * exists to close. There is no third state where a value is present and
 * means nothing: a value with a non-whitespace character in it either
 * yields at least one prefix or throws. That is the class, not the two
 * spellings the review happened to find.
 */
export function parseCarrierPrefixes(
  raw: string | undefined,
  toValue: (text: string) => bigint | null,
): readonly CarrierPrefix[] {
  if (raw === undefined || raw.trim().length === 0) return [];
  const entries = raw.split(',').map((entry) => entry.trim());
  return entries.map((entry, index) => {
    if (entry.length === 0) {
      throw new CarrierPrefixConfigError(
        `entry ${index + 1} of ${entries.length} is empty; every entry must name a prefix`,
      );
    }
    const slash = entry.lastIndexOf('/');
    if (slash < 0) throw new CarrierPrefixConfigError(`${entry} has no prefix length`);
    const bitsText = entry.slice(slash + 1);
    if (!/^[0-9]{1,3}$/.test(bitsText)) {
      throw new CarrierPrefixConfigError(`${entry} has a non-numeric prefix length`);
    }
    const bits = Number(bitsText);
    // Any length is accepted, not only RFC 6052's 32/40/48/56/64/96: 6rd
    // prefixes are service-provider chosen and are not on that list, and a
    // length this module refused to accept would be a prefix an operator
    // could not declare.
    if (bits < 1 || bits > 128) {
      throw new CarrierPrefixConfigError(`${entry} has a prefix length outside 1..128`);
    }
    const value = toValue(entry.slice(0, slash));
    if (value === null) throw new CarrierPrefixConfigError(`${entry} is not an IPv6 prefix`);
    // A prefix with bits set BELOW its length is a typo, and accepting it
    // would silently widen or narrow what the operator meant.
    if ((value & ((1n << BigInt(128 - bits)) - 1n)) !== 0n) {
      throw new CarrierPrefixConfigError(`${entry} has bits set below its prefix length`);
    }
    return { text: entry, value, bits };
  });
}

/**
 * The carrier form this address belongs to, or null. Membership only.
 *
 * `declared` are the deployment's own translator prefixes; they are asked
 * FIRST so a refusal names the operator's own configuration rather than a
 * registered form that happens to overlap it.
 */
export function ipv4CarrierForm(
  value: bigint,
  declared: readonly CarrierPrefix[] = [],
): string | null {
  for (const prefix of declared) {
    const shift = BigInt(128 - prefix.bits);
    if ((value >> shift) === (prefix.value >> shift)) return `declared:${prefix.text}`;
  }
  return IPV4_CARRIER_FORMS.find((form) => form.carries(value))?.name ?? null;
}

/** The carrier form names, for the drills that enumerate them. */
export const IPV4_CARRIER_FORM_NAMES: readonly string[] =
  IPV4_CARRIER_FORMS.map((form) => form.name);
