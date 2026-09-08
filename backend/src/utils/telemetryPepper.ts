/**
 * telemetryPepper — the rotating keyed-HMAC pepper behind Tier-0
 * pseudonymization (TELEMETRY-DESIGN `7d5c0cdc` §6.1, RH-TW1a).
 *
 * PRECEDENT, DELIBERATELY FOLLOWED: `utils/credentialCrypto.ts` (AZ-S3,
 * AUTHZ design §7.2). The pepper set lives in the ENVIRONMENT, never in the
 * database — a database dump must not let its holder re-link pseudonyms to
 * the identifiers they stand for. An active id names the pepper used for NEW
 * writes; rotation adds a new id and retires the old one when no row
 * references it, so pseudonyms stay stable per pepper generation.
 *
 * OWNER DECISION D4 (run packet `bb83d616` §3, a declared narrowing of §6.1):
 * TW1a ships the pepper and the HMAC and NOTHING ELSE — **no custody mapping
 * store and no reversal act**. The delivered-v1 acceptance is design criterion
 * 4, "a Tier-0-only deployment renders ... with ZERO CONTENT STORED", and a
 * pseudonym -> identifier mapping is content. §6.1 states independently that
 * "no delegated reveal capability exists in v1". There is therefore no
 * `reverse()` in this module, and its absence is the point: a reversal act
 * arrives, if ever, as its own declared object-scoped capability.
 *
 * A pseudonym is NOT reversible from this module even by its own holder: the
 * HMAC is one-way and nothing here retains the preimage.
 */
import crypto from 'crypto';

export class TelemetryPepperError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = 'TelemetryPepperError';
  }
}

export interface TelemetryPepperSet {
  peppers: Map<string, Buffer>;
  activePepperId: string;
}

/**
 * Pseudonym DOMAINS (review `bfac1dd5` finding F3).
 *
 * One domain string for every use collapses distinct namespaces: with a single
 * domain and callers merely prefixing their own text, an `identity.user_id`
 * literally equal to `session|<product>|<id>` produced the SAME pseudonym as
 * the session reference for that product and id. A person and a session became
 * one value.
 *
 * The domain is now a REQUIRED argument, mixed into the HMAC as its own
 * length-prefixed field, so no caller-supplied text can imitate another
 * domain. The set is closed: a new use adds a member here and is reviewed.
 */
export const TELEMETRY_PSEUDONYM_DOMAINS = {
  /**
   * An EMAIL ADDRESS. Case- and NFKC-folded, because an address genuinely is
   * case-insensitive in practice and `Alice@Example.com` is one person.
   */
  emailAddress: 'rh.telemetry.pseudonym.email/1',
  /**
   * A payload-borne human identifier that is NOT an address — a username, a
   * provider member id. **Bytes are preserved exactly.**
   *
   * Round-2 review `696bff8c` finding R2-F3: the previous single
   * `humanIdentifier` domain was documented as covering "email, username,
   * member id" AND was case-folded, so `MemberABC` and `memberabc` still
   * became one pseudonym — the exact round-1 collision class, repaired only
   * for the address half. Splitting the domain is the terminating fix: an
   * address is folded because its contract says so, and an opaque identifier
   * is not folded because nothing says it may be.
   */
  humanIdentifier: 'rh.telemetry.pseudonym.human/2',
  /** The source's conversation/session identifier → the opaque `session_ref`. */
  sessionRef: 'rh.telemetry.pseudonym.session/1',
  /** The reporter's `source.instance_id` → the opaque instance reference. */
  instanceRef: 'rh.telemetry.pseudonym.instance/1',
  /**
   * A value that CONTAINS an address but is not one (belt-and-braces scan
   * over retained fields). NOT folded — review `bc03054d` R3-F2: folding a
   * whole opaque identifier because it contains an address merges ids that
   * differ only in case or Unicode form. A value that IS an address is
   * routed to `emailAddress` instead, which folds.
   */
  embeddedAddress: 'rh.telemetry.pseudonym.embedded/2',
  /**
   * A provider request id (§9.1 reconciliation). Round-2 finding R2-F1: these
   * were retained RAW on the false premise that "a one-way hash cannot link"
   * across feeds. It can — if BOTH feeds pseudonymize under the same domain
   * and pepper, equality is preserved and neither feed's raw id is stored.
   * TW3's accounting ingestion MUST use this domain for the same purpose.
   */
  reconciliationId: 'rh.telemetry.pseudonym.reconciliation/1',
  /** A tool-call id (§9.1 tool-call correlation), same reasoning. */
  toolCallId: 'rh.telemetry.pseudonym.toolcall/1',
} as const;
export type TelemetryPseudonymDomain =
  (typeof TELEMETRY_PSEUDONYM_DOMAINS)[keyof typeof TELEMETRY_PSEUDONYM_DOMAINS];

/**
 * Domains whose values are case- and NFKC-folded BY CONTRACT. Everything else
 * keeps its bytes EXACTLY — no case folding and no Unicode normalization.
 *
 * R2-F3 also caught the second half of this: NFKC ran unconditionally, so
 * full-width `Ａ` collided with `A` even in the opaque `sessionRef` domain.
 * Normalization is an equivalence claim, and it is only made where a contract
 * actually makes it.
 */
const CASE_FOLDED_DOMAINS: ReadonlySet<string> = new Set<string>([
  TELEMETRY_PSEUDONYM_DOMAINS.emailAddress,
]);

/** Pseudonyms are prefixed so a reader can never mistake one for a raw identifier. */
export const TELEMETRY_PSEUDONYM_PREFIX = 'rhp_';
/** Base64url characters retained from the 32-byte HMAC. 160 bits of the digest. */
export const TELEMETRY_PSEUDONYM_CHARS = 27;
const PSEUDONYM_CHARS = TELEMETRY_PSEUDONYM_CHARS;

/**
 * The pseudonym SHAPE, as one predicate.
 *
 * TW1c reads a `session_ref` out of a URL path and must refuse anything that
 * is not a pseudonym before it reaches a query. The shape was already written
 * once — inside `telemetryPepperCanary` — and a second copy in a route is the
 * defect class this estate keeps finding: two spellings of one question that
 * drift. So the canary now calls THIS, and the route calls THIS, and the
 * producer above is the only place the shape is decided.
 *
 * base64url is the digest alphabet: `[A-Za-z0-9_-]`. The length is exact, so a
 * longer string with a valid prefix is refused rather than truncated into one.
 */
export function isTelemetryPseudonym(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  if (value.length !== TELEMETRY_PSEUDONYM_PREFIX.length + TELEMETRY_PSEUDONYM_CHARS) return false;
  if (!value.startsWith(TELEMETRY_PSEUDONYM_PREFIX)) return false;
  return /^[A-Za-z0-9_-]+$/.test(value.slice(TELEMETRY_PSEUDONYM_PREFIX.length));
}

let cached: TelemetryPepperSet | null = null;

export function loadTelemetryPepperSet(env: NodeJS.ProcessEnv = process.env): TelemetryPepperSet {
  const raw = env.RELAYHALL_TELEMETRY_PEPPERS;
  const activePepperId = env.RELAYHALL_TELEMETRY_ACTIVE_PEPPER || '';
  if (!raw || !activePepperId) {
    throw new TelemetryPepperError(
      'TELEMETRY_PEPPER_MISSING',
      'RELAYHALL_TELEMETRY_PEPPERS and RELAYHALL_TELEMETRY_ACTIVE_PEPPER must be set (design 7d5c0cdc §6.1)',
    );
  }
  let parsed: Record<string, string>;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new TelemetryPepperError('TELEMETRY_PEPPER_INVALID', 'RELAYHALL_TELEMETRY_PEPPERS is not valid JSON');
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new TelemetryPepperError('TELEMETRY_PEPPER_INVALID', 'RELAYHALL_TELEMETRY_PEPPERS must be a JSON object of { pepperId: base64 }');
  }
  const peppers = new Map<string, Buffer>();
  for (const [pepperId, value] of Object.entries(parsed)) {
    const pepper = Buffer.from(String(value), 'base64');
    if (pepper.length !== 32) {
      throw new TelemetryPepperError('TELEMETRY_PEPPER_INVALID', `pepper entry '${pepperId}' is not 32 bytes`);
    }
    peppers.set(pepperId, pepper);
  }
  if (!peppers.has(activePepperId)) {
    throw new TelemetryPepperError('TELEMETRY_PEPPER_INVALID', 'RELAYHALL_TELEMETRY_ACTIVE_PEPPER names no pepper entry');
  }
  return { peppers, activePepperId };
}

function pepperSet(): TelemetryPepperSet {
  if (!cached) cached = loadTelemetryPepperSet();
  return cached;
}

/** Test hook: drop the cached pepper set (environment changed). */
export function resetTelemetryPepperCache(): void {
  cached = null;
}

export function telemetryPepperConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(env.RELAYHALL_TELEMETRY_PEPPERS && env.RELAYHALL_TELEMETRY_ACTIVE_PEPPER);
}

/** The pepper id NEW pseudonyms are computed under; stored beside every row. */
export function activeTelemetryPepperId(): string {
  return pepperSet().activePepperId;
}

/**
 * Keyed-HMAC pseudonym for one value, in one governed DOMAIN.
 *
 * DETERMINISTIC per (pepper, domain, value) so that a projection can group by
 * a pseudonym without ever holding the identifier; NOT deterministic across
 * peppers, which is what makes rotation meaningful; NOT deterministic across
 * domains, which is what stops a person colliding with a session (F3).
 *
 * The domain and the value are LENGTH-PREFIXED into the HMAC rather than
 * joined by a separator: with `domain|value`, a value containing the separator
 * could imitate a different domain. With a length prefix no value can.
 *
 * Case, whitespace and Unicode form are folded ONLY for `emailAddress` — a
 * value that IS, in its entirety, an address, whose contract makes it
 * case-insensitive. Everything else is hashed byte-for-byte, INCLUDING
 * `embeddedAddress`: a value that merely CONTAINS an address is an opaque
 * identifier, and folding it merged `acct:Member@…:A` with `acct:member@…:a`
 * (review `4c1eb429`, R4-F3 on the comment; `bc03054d` R3-F2 on the code).
 * `MemberABC` and `memberabc` — and full-width `Ａ` and `A` — may be different
 * accounts.
 */
export function telemetryPseudonym(
  domain: TelemetryPseudonymDomain, value: string, pepperId?: string,
): string {
  const { peppers, activePepperId } = pepperSet();
  const id = pepperId ?? activePepperId;
  const pepper = peppers.get(id);
  if (!pepper) {
    throw new TelemetryPepperError('TELEMETRY_PEPPER_UNKNOWN', `pepper set holds no pepper '${id}'`);
  }
  if (!Object.values(TELEMETRY_PSEUDONYM_DOMAINS).includes(domain)) {
    throw new TelemetryPepperError('TELEMETRY_PSEUDONYM_DOMAIN_UNKNOWN', `'${domain}' is not a governed pseudonym domain`);
  }
  // Folded domains normalize; every other domain is hashed BYTE-FOR-BYTE.
  const normalized = CASE_FOLDED_DOMAINS.has(domain)
    ? value.normalize('NFKC').trim().toLowerCase()
    : value;
  const hmac = crypto.createHmac('sha256', pepper);
  hmac.update(`${domain.length}:${domain}`, 'utf8');
  hmac.update(`${Buffer.byteLength(normalized, 'utf8')}:${normalized}`, 'utf8');
  return `${TELEMETRY_PSEUDONYM_PREFIX}${hmac.digest('base64url').slice(0, PSEUDONYM_CHARS)}`;
}

/**
 * Startup CANARY, in the shape `credentialCrypto`'s canary established: prove
 * at boot that the configured pepper set actually reaches this process and
 * produces a well-formed, pepper-dependent pseudonym. A misconfigured pepper
 * that only surfaced on the first telemetry write would silently degrade the
 * privacy property for every row written before someone noticed.
 *
 * Throws on failure; the caller decides whether that is fatal. Skipped in
 * boot-check mode by the caller, exactly as the credential canary is.
 */
export function telemetryPepperCanary(env: NodeJS.ProcessEnv = process.env): { activePepperId: string; pepperCount: number } {
  const set = loadTelemetryPepperSet(env);
  cached = set;
  const probe = telemetryPseudonym(TELEMETRY_PSEUDONYM_DOMAINS.emailAddress, 'canary@relayhall.invalid');
  if (!isTelemetryPseudonym(probe)) {
    throw new TelemetryPepperError('TELEMETRY_PEPPER_CANARY_FAILED', 'the pseudonymization canary produced a malformed pseudonym');
  }
  return { activePepperId: set.activePepperId, pepperCount: set.peppers.size };
}
