/**
 * TelemetryPolicyEngine — the Tier-0 policy engine (RH-TW1a, card
 * `beac9c79`; TELEMETRY-DESIGN `7d5c0cdc` §6, sitting ruling TS-5, owner
 * decision D9 of run packet `bb83d616`).
 *
 * A PURE MODULE. It touches no database, no clock, no request. Everything it
 * needs arrives as an argument, and its whole output is a value — so the
 * privacy property can be tested directly, without a server, and TW1b's OTLP
 * translators can run the identical stage on translated envelopes.
 *
 * DENY BY DEFAULT over the FULL translated surface. The engine does not
 * "remove bad fields"; it BUILDS the output record from an allowlist, so a
 * field nobody thought about is absent because it was never copied. That is
 * the only shape in which §6.1's hard rule is enforceable:
 *
 *   > No prompts, responses, file paths, command arguments, or raw exception
 *   > messages.
 *
 * TIER 1 AND TIER 2 REFUSE. Sitting ruling TS-5: "Tier timing (§12.5): Tier 0
 * ONLY in TW1a. Tier 1 waits for demand." / "Tier 2 arrives with TW5,
 * post-publication." Owner decision D9 requires the restriction to be
 * FALSIFIABLE rather than a comment, so `applyTelemetryPolicy` THROWS for
 * tiers 1 and 2 and a test drives both arms.
 *
 * THE ADVISORY IDENTITY RULE (§4.1 + §6.1 + §6.2), stated here because it is
 * the one place two paragraphs meet:
 *   - `identity.user_id` is a payload-borne HUMAN identifier. §6.1 keeps it
 *     at Tier 0 AS A KEYED-HMAC PSEUDONYM, never raw.
 *   - `identity.tenant_id` / `project_id` / `workspace_id` are structural
 *     labels. §6.2 places "repo/project labels" at TIER 1, which TS-5 does not
 *     ship. They are therefore DROPPED and counted at Tier 0.
 * Both outcomes are counted, so the drop is visible in adapter health rather
 * than silent (§4.5).
 */
import {
  TELEMETRY_ENVELOPE_KIND_TO_EVENT_KIND,
  type TelemetryEnvelope,
  type TelemetryPolicyTier,
} from '../types/TelemetryEnvelope';
import {
  activeTelemetryPepperId, telemetryPseudonym,
  TELEMETRY_PSEUDONYM_DOMAINS,
} from '../utils/telemetryPepper';
import {
  EXCEPTION_TYPE_RE, PRODUCT_RE, TELEMETRY_FINISH_REASONS,
} from '../utils/telemetryEnvelopeValidator';

/** Bumped whenever the redaction RULES change; stored on every row. */
export const TELEMETRY_TIER0_POLICY_VERSION = 'rh.telemetry.tier0/1.0';

/** Reserved attribute prefix for the pseudonymized advisory identity (§4.1). */
export const TELEMETRY_ADVISORY_ATTRIBUTE_PREFIX = 'advisory.identity.';

export class TelemetryPolicyError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = 'TelemetryPolicyError';
  }
}

export interface TelemetryRedactionCounts {
  /** Entries of `attributes` dropped because no Tier-0 profile allowlists them (§4.5). */
  attributesDropped: number;
  /** Advisory identity values replaced by a keyed-HMAC pseudonym (§6.1). */
  identifiersPseudonymized: number;
  /** Advisory structural labels dropped because they are a Tier-1 surface (§6.2). */
  structuralLabelsDropped: number;
  /** Content references nulled because Tier 0 stores no content (§6.3 default OFF). */
  contentReferencesDropped: number;
  /** Fields dropped by the allowlist for failing their Tier-0 shape. */
  fieldsDropped: number;
}

export interface TelemetryTier0Record {
  schema_version: string;
  event_id: string | null;
  observed_at: string;
  occurred_at: string | null;
  stream_generation: string | null;
  source_sequence: string | null;
  kind: string;
  phase: string | null;
  source: {
    product: string;
    instance_ref: string | null;
    adapter: string;
    adapter_version: string | null;
    mechanism: string | null;
    support_level: string | null;
    last_verified: string | null;
    /**
     * §6.5.1. The ENGINE always emits null — a redactor has no business
     * minting a pointer — and `TelemetryEnvelopeStore` assigns the key of
     * the governed blob it wrote in the same statement. The type is widened
     * so that assignment does not need a cast; the engine's own value is
     * still `null` and the validator still REFUSES a reporter-supplied one.
     */
    raw_ref: string | null;
  };
  correlation: Record<string, string>;
  model: Record<string, string>;
  usage: Record<string, unknown>;
  timing: Record<string, number>;
  outcome: Record<string, unknown>;
  context: Record<string, number>;
  content: {
    policy_tier: 0;
    prompt_ref: null;
    response_ref: null;
    tool_input_ref: null;
    tool_output_ref: null;
    redactions: Array<{ rule: string; count: number }>;
  };
  attributes: Record<string, string>;
  policy: {
    tier: 0;
    version: string;
    pepper_id: string;
  };
}

export interface TelemetryPolicyResult {
  record: TelemetryTier0Record;
  counts: TelemetryRedactionCounts;
  policyVersion: string;
  /** The opaque, Tier-0-safe grouping key TW1c's timeline groups by (§10.1). */
  sessionRef: string | null;
  eventKind: string;
}

export interface TelemetryPolicyOptions {
  /** Receiver clock, injected so the module stays pure and testable. */
  observedAt: Date;
  /**
   * §4.5: "a certified adapter profile may allowlist specific known-safe
   * attributes into Tier 0/1". EMPTY at TW1a — the certification ladder is
   * §8, which the §11 TW1a line does not name. The parameter exists so TW1b
   * can supply a profile without reopening this module.
   */
  attributeAllowlist?: TelemetryAttributeProfile;
}

/**
 * A certified adapter profile (§4.5): each allowlisted attribute key maps to
 * the VALUE CLASS it is certified for. A `Set<string>` — key only — was the
 * defect the reviewer found: it let arbitrary content through under an
 * approved name.
 */
export type TelemetryAttributeProfile = ReadonlyMap<string, RegExp>;

/** The default class for an allowlisted attribute whose profile names no tighter one. */
export const TELEMETRY_ATTRIBUTE_DEFAULT_RE = /^[A-Za-z0-9._:@+\-]{1,64}$/;

/** Tier-0 closed vocabularies, checked by value rather than by shape. */
const TELEMETRY_OUTCOME_STATUSES_TIER0: readonly string[] =
  ['ok', 'error', 'throttled', 'blocked', 'cancelled', 'unknown'];
const TELEMETRY_MODEL_OPERATIONS_TIER0: readonly string[] =
  ['chat', 'responses', 'embedding', 'rerank', 'image', 'audio', 'other'];
const TELEMETRY_MECHANISMS_TIER0: readonly string[] = ['push', 'pull', 'scrape'];
const TELEMETRY_PHASES_TIER0: readonly string[] =
  ['started', 'running', 'waiting', 'completed', 'failed', 'cancelled', 'unknown'];
const TELEMETRY_SUPPORT_LEVELS_TIER0: readonly string[] = ['supported', 'tested', 'experimental'];

/**
 * An email address anywhere in a RETAINED string is pseudonymized rather than
 * stored. The structural allowlist already makes prose unreachable; this is a
 * second, independent control on the fields that DO survive, so a reporter
 * that puts a user's address in `model.provider` does not defeat §6.1 by
 * choosing an unexpected field.
 */
/**
 * Does a retained value CONTAIN an address? Unanchored on purpose — this is
 * the belt-and-braces scan over fields that are stored verbatim.
 */
const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/;

/**
 * Is this value, IN ITS ENTIRETY, an address? (review `bc03054d`, R3-F2.)
 *
 * Routing used the unanchored test above, so an opaque identifier that merely
 * CONTAINED an address — `acct:Member@example.com:A` — was classified as an
 * address and case/NFKC-folded, collapsing four distinct member ids into one
 * pseudonym. Containing an address is not being one. Only a whole-value match
 * justifies applying an address's case-insensitivity contract.
 */
const EMAIL_WHOLE_RE = /^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/;

/**
 * PER-FIELD Tier-0 guards (review `bfac1dd5` finding F1).
 *
 * The engine previously ran ONE broad class over every retained string, which
 * the reviewer defeated by supplying identifier-shaped content — a prompt
 * without spaces, an SSN in `request_id`, an exception message in a finish
 * reason. Each retained field now carries the tightest class its contract
 * allows, mirroring the validator's own table, and the fields whose values are
 * opaque BY CONTRACT are pseudonymized instead of retained (below).
 */
const TRACE_ID_RE = /^[0-9a-f]{8,64}$/;
const CORRELATION_ID_RE = /^[A-Za-z0-9._:@+\-]{1,128}$/;
const MODEL_NAME_RE = /^[A-Za-z0-9._:+\-/]{1,80}$/;
const VERSION_RE = /^v?\d{1,6}(\.\d{1,6}){0,3}([.\-+][A-Za-z0-9.\-]{1,24})?$/;
// `PRODUCT_RE` is IMPORTED from the validator, never re-declared here: the
// engine and the validator have to admit the same product keys, and an equal-
// looking copy is exactly how two of them stop being equal.

/**
 * THE RESIDUAL, STATED RATHER THAN PRETENDED AWAY (reviews `bfac1dd5` F1,
 * `696bff8c` R2-F1, `bc03054d` R3-F5 — this text has been wrong before, so it
 * is now written to match the code beside it and `docs/observability.md`).
 *
 * Shape closes every field that HAS a shape: versions, dates, currencies, W3C
 * trace ids, and the closed vocabularies (phase, status, mechanism, support
 * level, model operation, finish reasons). Those are unreachable by prose.
 *
 * THREE groups remain free-form, because their contract makes them so and no
 * regular expression can tell an opaque identifier from content shaped like
 * one:
 *
 *   1. `source.product` / `source.adapter` — names. NOT closed by shape here,
 *      but closed by ENFORCEMENT: candidate B rejects an envelope whose
 *      `source.product` is absent from the Connector descriptor's declared
 *      product list (§5.2, ratified TS-3). The allowlist is the control; the
 *      class is only a bound.
 *   2. `model.provider` / `model.requested` / `model.resolved` — model names,
 *      which §6.1 explicitly KEEPS at Tier 0. Bounded and space-free.
 *   3. `event_id` / `stream_generation` — §4.3 identity. Required to be
 *      stored; bounded and space-free.
 *
 * Everything else that used to be on this list is gone rather than excused:
 * the correlation identifiers (`conversation_id`, `session_id`, `attempt_id`,
 * `request_id`, `tool_call_id`) are all PSEUDONYMIZED — R2-F1 correctly showed
 * the claim that reconciliation needed them raw was false — and the error
 * fingerprint is WITHDRAWN entirely under the §6.1 narrowing above.
 *
 * An adapter that mis-maps content into one of the three remaining fields
 * defeats Tier 0 for that field. That is an ADAPTER CERTIFICATION concern
 * (§8.2, TW1b), it is counted and visible in the redaction counts when a value
 * fails its class, and it is documented in `docs/observability.md`. It is not
 * closed by this candidate, and this comment exists so nobody believes it is.
 */
const CURRENCY_RE = /^[A-Z]{3}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Correlation fields RETAINED RAW — now only the W3C trace-context triple.
 *
 * These are hex by specification (`TRACE_ID_RE`), so they cannot carry prose, a
 * path, an argument or a message: the shape closes them completely. They are
 * also the identifiers an external OTLP consumer must see unchanged for the
 * §3.7 export to mean anything.
 */
const CORRELATION_RETAINED = ['trace_id', 'span_id', 'parent_span_id'] as const;

/**
 * Correlation fields PSEUDONYMIZED at Tier 0, each in its own domain.
 *
 * `conversation_id` / `session_id` / `attempt_id` were pseudonymized in round 1
 * because they are opaque and only ever needed for grouping.
 *
 * `request_id` and `tool_call_id` JOIN them here, per round-2 review `696bff8c`
 * finding R2-F1. They were retained raw on the stated premise that "§9.1
 * reconciliation matches them against the same identifiers arriving on the
 * accounting feed, which a one-way hash cannot do". **That premise was false**,
 * and the reviewer was right to call it unsound: if BOTH feeds apply the same
 * domain-separated keyed HMAC, equality — and therefore reconciliation — is
 * preserved exactly, while neither feed's raw identifier is ever stored. An
 * avoidable raw channel is withdrawn rather than bounded.
 *
 * **SEAM OBLIGATION FOR TW3** (accounting pull connectors): provider request
 * ids arriving on the accounting feed MUST be pseudonymized with
 * `TELEMETRY_PSEUDONYM_DOMAINS.reconciliationId` under the same pepper before
 * being compared. Reconciling a raw id against a pseudonym matches nothing,
 * silently.
 */
const CORRELATION_PSEUDONYMIZED: ReadonlyArray<readonly [string, keyof typeof TELEMETRY_PSEUDONYM_DOMAINS]> = [
  ['conversation_id', 'sessionRef'],
  ['session_id', 'sessionRef'],
  ['attempt_id', 'sessionRef'],
  ['request_id', 'reconciliationId'],
  ['tool_call_id', 'toolCallId'],
] as const;

const USAGE_NUMERIC_KEYS = [
  'input_tokens', 'output_tokens', 'cached_read_tokens', 'cached_write_tokens',
  'reasoning_tokens', 'tool_tokens', 'requests',
] as const;
const TIMING_KEYS = ['duration_ms', 'queue_ms', 'time_to_first_token_ms', 'inter_token_ms'] as const;
const CONTEXT_KEYS = ['max_tokens', 'used_tokens', 'utilization', 'compaction_count'] as const;
/** §6.2 places these at Tier 1; TS-5 does not ship Tier 1. */
const STRUCTURAL_IDENTITY_KEYS = ['tenant_id', 'project_id', 'workspace_id'] as const;
/** §6.1 keeps this at Tier 0 — as a pseudonym. */
const HUMAN_IDENTITY_KEYS = ['user_id'] as const;

/**
 * WITHDRAWN-NARRATIVE: error_fingerprint, error_frames
 *
 * THE ERROR FINGERPRINT IS NOT COMPUTED AT TW1a — a DECLARED NARROWING of
 * design `7d5c0cdc` §6.1, ruled by the owner on 2026-09-03 in the shape of
 * decision D4.
 *
 * §6.1 lists an error fingerprint among Tier-0 metadata and defines it as "a
 * hash over exception type + stack-frame signature, containing no
 * message-derived bytes". Three mechanisms were tried and all three were
 * rejected by cross-family review:
 *
 *   1. store the reporter's digest verbatim  — round 1, finding F2: a reporter
 *      can send SHA-256(raw exception message), so the stored value IS
 *      message-derived and anyone with a candidate message can confirm it;
 *   2. re-key the reporter's digest under the pepper — round 2, finding R2-F2:
 *      still a deterministic function of reporter-chosen message bytes, so a
 *      pepper holder can confirm a guess;
 *   3. compute it receiver-side from reporter-supplied stack frames — round 3,
 *      finding R3-F1: identifier-shaped message text is accepted in a frame's
 *      function or basename slot and changes the digest. As that reviewer put
 *      it, **"syntax cannot establish semantic provenance"** — no grammar can
 *      prove a string is a real function name rather than message content.
 *
 * The common cause is structural, not a coding defect: §6.1's definition
 * presumes a TRUSTED capture path, and TW1a has none. Strategy F11 is that the
 * board never observes — every input at this seam is reporter-chosen — so no
 * fingerprint computed here can carry the guarantee §6.1 names.
 *
 * The narrowing, in the shape of D4: **TW1a stores NO error fingerprint at
 * all.** `outcome.error_type` (a validated class name) remains Tier-0
 * operational metadata and is stored; `outcome.error_fingerprint` and
 * `outcome.error_frames` are REFUSED at the validator so no caller can believe
 * either is being honoured. The fingerprint returns in **TW2**, where
 * OpenClaw/Hermes is first-party software whose runtime can supply exception
 * type and frame structure the reporter did not choose — a trusted capture
 * path, which is exactly what §6.1 assumes and TW1a lacks.
 *
 * Nothing in TW1a's acceptance depends on it: design criterion 4 is a
 * Tier-0-only deployment rendering chip, timeline, rollups and coverage view
 * with zero content stored, and none of those reads a fingerprint.
 */

/**
 * Apply the source's policy tier. Tier 0 redacts; tiers 1 and 2 REFUSE.
 *
 * @throws TelemetryPolicyError with code `TELEMETRY_TIER_UNAVAILABLE` for
 *   tiers 1 and 2 (sitting ruling TS-5, owner decision D9).
 */
export function applyTelemetryPolicy(
  tier: TelemetryPolicyTier,
  envelope: TelemetryEnvelope,
  options: TelemetryPolicyOptions,
): TelemetryPolicyResult {
  if (tier === 1) {
    throw new TelemetryPolicyError(
      'TELEMETRY_TIER_UNAVAILABLE',
      'Tier 1 (structural context) is not available: ratification sitting 7e7eeca3 TS-5 — "Tier 0 ONLY in TW1a. Tier 1 waits for demand."',
    );
  }
  if (tier === 2) {
    throw new TelemetryPolicyError(
      'TELEMETRY_TIER_UNAVAILABLE',
      'Tier 2 (governed content) is not available: ratification sitting 7e7eeca3 TS-5 — "Tier 2 arrives with TW5, post-publication."',
    );
  }
  if (tier !== 0) {
    throw new TelemetryPolicyError('TELEMETRY_TIER_UNKNOWN', `unknown policy tier: ${String(tier)}`);
  }
  return applyTier0(envelope, options);
}

function applyTier0(envelope: TelemetryEnvelope, options: TelemetryPolicyOptions): TelemetryPolicyResult {
  const counts: TelemetryRedactionCounts = {
    attributesDropped: 0,
    identifiersPseudonymized: 0,
    structuralLabelsDropped: 0,
    contentReferencesDropped: 0,
    fieldsDropped: 0,
  };
  const allowlist: TelemetryAttributeProfile = options.attributeAllowlist ?? new Map<string, RegExp>();

  /**
   * Retain a string only if it satisfies THIS FIELD's class; pseudonymize an
   * address hiding inside it. A value that fails its class is dropped and
   * counted — never coerced, never truncated into something that looks valid.
   */
  const retainString = (value: unknown, re: RegExp): string | null => {
    if (typeof value !== 'string' || value.length === 0) {
      if (value !== undefined && value !== null) counts.fieldsDropped += 1;
      return null;
    }
    if (!re.test(value)) {
      counts.fieldsDropped += 1;
      return null;
    }
    if (EMAIL_RE.test(value)) {
      counts.identifiersPseudonymized += 1;
      // R3-F2, swept: a value that IS an address folds; a value that merely
      // contains one is pseudonymized BYTE-EXACTLY, because folding the whole
      // opaque string would merge ids that differ only in case or Unicode form.
      return EMAIL_WHOLE_RE.test(value.trim())
        ? telemetryPseudonym(TELEMETRY_PSEUDONYM_DOMAINS.emailAddress, value)
        : telemetryPseudonym(TELEMETRY_PSEUDONYM_DOMAINS.embeddedAddress, value);
    }
    return value;
  };

  /** Pseudonymize an opaque source-side identifier rather than storing it. */
  const pseudonymizeField = (value: unknown, domain: string): string | null => {
    if (typeof value !== 'string' || value.length === 0) return null;
    if (!CORRELATION_ID_RE.test(value)) { counts.fieldsDropped += 1; return null; }
    counts.identifiersPseudonymized += 1;
    return telemetryPseudonym(domain as never, `${envelope.source.product}|${value}`);
  };

  const retainNumber = (value: unknown): number | null => {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      if (value !== undefined && value !== null) counts.fieldsDropped += 1;
      return null;
    }
    return value;
  };

  const correlation: Record<string, string> = {};
  for (const key of CORRELATION_RETAINED) {
    const kept = retainString(envelope.correlation?.[key], TRACE_ID_RE);
    if (kept !== null) correlation[key] = kept;
  }
  for (const [key, domainName] of CORRELATION_PSEUDONYMIZED) {
    const kept = pseudonymizeField(
      (envelope.correlation as Record<string, unknown> | undefined)?.[key],
      TELEMETRY_PSEUDONYM_DOMAINS[domainName],
    );
    if (kept !== null) correlation[key] = kept;
  }

  const model: Record<string, string> = {};
  for (const key of ['provider', 'requested', 'resolved'] as const) {
    const kept = retainString(envelope.model?.[key], MODEL_NAME_RE);
    if (kept !== null) model[key] = kept;
  }
  if (typeof envelope.model?.operation === 'string'
    && TELEMETRY_MODEL_OPERATIONS_TIER0.includes(envelope.model.operation)) {
    model.operation = envelope.model.operation;
  } else if (envelope.model?.operation !== undefined && envelope.model?.operation !== null) {
    counts.fieldsDropped += 1;
  }

  const usage: Record<string, unknown> = {};
  for (const key of USAGE_NUMERIC_KEYS) {
    const kept = retainNumber(envelope.usage?.[key]);
    if (kept !== null) usage[key] = kept;
  }
  const cost = envelope.usage?.cost;
  if (cost) {
    const costOut: Record<string, unknown> = {};
    if (typeof cost.amount === 'number' && Number.isFinite(cost.amount)) costOut.amount = cost.amount;
    else if (typeof cost.amount === 'string') costOut.amount = cost.amount;
    const currency = retainString(cost.currency, CURRENCY_RE);
    if (currency !== null) costOut.currency = currency;
    // §4.7: an ingested envelope can never claim `reconciled`; the validator
    // refuses it, and the engine defaults an unstated basis to `estimated`
    // rather than inventing provider authority.
    costOut.basis = cost.basis === 'provider' ? 'provider' : 'estimated';
    if (Object.keys(costOut).length > 0) usage.cost = costOut;
  }

  const timing: Record<string, number> = {};
  for (const key of TIMING_KEYS) {
    const kept = retainNumber(envelope.timing?.[key]);
    if (kept !== null) timing[key] = kept;
  }

  const context: Record<string, number> = {};
  for (const key of CONTEXT_KEYS) {
    const kept = retainNumber(envelope.context?.[key]);
    if (kept !== null) context[key] = kept;
  }

  const outcome: Record<string, unknown> = {};
  if (typeof envelope.outcome?.status === 'string'
    && TELEMETRY_OUTCOME_STATUSES_TIER0.includes(envelope.outcome.status)) {
    outcome.status = envelope.outcome.status;
  } else if (envelope.outcome?.status !== undefined && envelope.outcome?.status !== null) {
    counts.fieldsDropped += 1;
  }
  // F2: an exception TYPE is a class name and nothing else. Anything that is
  // not one is dropped, so a message cannot ride in on this field.
  const errorType = retainString(envelope.outcome?.error_type, EXCEPTION_TYPE_RE);
  if (errorType !== null) outcome.error_type = errorType;
  const reasons = Array.isArray(envelope.outcome?.finish_reasons)
    ? envelope.outcome!.finish_reasons!.filter(
      (r): r is string => typeof r === 'string' && TELEMETRY_FINISH_REASONS.includes(r as never))
    : [];
  const droppedReasons = (envelope.outcome?.finish_reasons?.length ?? 0) - reasons.length;
  if (droppedReasons > 0) counts.fieldsDropped += droppedReasons;
  if (reasons.length > 0) outcome.finish_reasons = reasons;

  // ---- attributes: DENY BY DEFAULT (§4.5) --------------------------------
  // F1: the allowlist governed only the KEY, so a certified profile admitting
  // `safe_named_key` admitted whatever value a reporter put under it. A profile
  // entry is now a key AND the value class that key is certified for; a bare
  // string key means the default opaque-identifier class, never "anything".
  const attributes: Record<string, string> = {};
  for (const [key, value] of Object.entries(envelope.attributes ?? {})) {
    const rule = allowlist.get(key);
    if (!rule) { counts.attributesDropped += 1; continue; }
    const kept = retainString(value, rule);
    if (kept === null) { counts.attributesDropped += 1; continue; }
    attributes[key] = kept;
  }

  // ---- advisory identity (§4.1 / §6.1 / §6.2) ----------------------------
  for (const key of HUMAN_IDENTITY_KEYS) {
    const value = envelope.identity?.[key];
    if (typeof value !== 'string' || value.length === 0) continue;
    // R2-F3: an advisory human identifier is EITHER an address or an opaque
    // account id, and they have opposite normalization contracts. Routing by
    // shape is what lets `Alice@Example.com` fold to one person while
    // `MemberABC` and `memberabc` stay two accounts. One domain for both — the
    // round-2 state — could only be right for one of them.
    // R3-F2: whole-value, not "contains".
    const domain = EMAIL_WHOLE_RE.test(value.trim())
      ? TELEMETRY_PSEUDONYM_DOMAINS.emailAddress
      : TELEMETRY_PSEUDONYM_DOMAINS.humanIdentifier;
    attributes[`${TELEMETRY_ADVISORY_ATTRIBUTE_PREFIX}${key}`] = telemetryPseudonym(domain, value);
    counts.identifiersPseudonymized += 1;
  }
  for (const key of STRUCTURAL_IDENTITY_KEYS) {
    if (envelope.identity?.[key] !== undefined && envelope.identity?.[key] !== null) {
      counts.structuralLabelsDropped += 1;
    }
  }

  // ---- content: Tier 0 stores none (§6.3 "default OFF per source") -------
  for (const key of ['prompt_ref', 'response_ref', 'tool_input_ref', 'tool_output_ref'] as const) {
    if (envelope.content?.[key] !== undefined && envelope.content?.[key] !== null) {
      counts.contentReferencesDropped += 1;
    }
  }

  // ---- the opaque session grouping key (§10.1, TW1c) ---------------------
  // Derived from the SOURCE's own conversation/session identifier so that a
  // timeline can group a session's events, and pseudonymized so that the
  // grouping key itself carries no source-side identifier.
  const sessionSeed = envelope.correlation?.conversation_id ?? envelope.correlation?.session_id ?? null;
  const sessionRef = typeof sessionSeed === 'string' && sessionSeed.length > 0
    ? telemetryPseudonym(TELEMETRY_PSEUDONYM_DOMAINS.sessionRef, `${envelope.source.product}|${sessionSeed}`)
    : null;

  const instanceSeed = envelope.source.instance_id;
  const instanceRef = typeof instanceSeed === 'string' && instanceSeed.length > 0
    ? telemetryPseudonym(TELEMETRY_PSEUDONYM_DOMAINS.instanceRef, `${envelope.source.product}|${instanceSeed}`)
    : null;

  const redactions: Array<{ rule: string; count: number }> = [
    { rule: 'attributes_denied_by_default', count: counts.attributesDropped },
    { rule: 'identifiers_pseudonymized', count: counts.identifiersPseudonymized },
    { rule: 'structural_labels_tier1_unavailable', count: counts.structuralLabelsDropped },
    { rule: 'content_references_tier0', count: counts.contentReferencesDropped },
    { rule: 'fields_failed_tier0_shape', count: counts.fieldsDropped },
  ].filter((entry) => entry.count > 0);

  const record: TelemetryTier0Record = {
    schema_version: envelope.schema_version,
    event_id: retainString(envelope.event_id, CORRELATION_ID_RE),
    observed_at: options.observedAt.toISOString(),
    occurred_at: typeof envelope.occurred_at === 'string' ? envelope.occurred_at : null,
    stream_generation: retainString(envelope.stream_generation, CORRELATION_ID_RE),
    source_sequence: envelope.source_sequence === undefined || envelope.source_sequence === null
      ? null : String(envelope.source_sequence),
    kind: envelope.kind,
    phase: TELEMETRY_PHASES_TIER0.includes(String(envelope.phase)) ? String(envelope.phase) : null,
    source: {
      product: retainString(envelope.source.product, PRODUCT_RE) ?? 'unknown',
      instance_ref: instanceRef,
      adapter: retainString(envelope.source.adapter, PRODUCT_RE) ?? 'unknown',
      adapter_version: retainString(envelope.source.adapter_version, VERSION_RE),
      mechanism: TELEMETRY_MECHANISMS_TIER0.includes(String(envelope.source.mechanism))
        ? String(envelope.source.mechanism) : null,
      support_level: TELEMETRY_SUPPORT_LEVELS_TIER0.includes(String(envelope.source.support_level))
        ? String(envelope.source.support_level) : null,
      last_verified: retainString(envelope.source.last_verified, DATE_RE),
      raw_ref: null,
    },
    correlation,
    model,
    usage,
    timing,
    outcome,
    context,
    content: {
      policy_tier: 0,
      prompt_ref: null,
      response_ref: null,
      tool_input_ref: null,
      tool_output_ref: null,
      redactions,
    },
    attributes,
    policy: {
      tier: 0,
      version: TELEMETRY_TIER0_POLICY_VERSION,
      pepper_id: activeTelemetryPepperId(),
    },
  };

  return {
    record,
    counts,
    policyVersion: TELEMETRY_TIER0_POLICY_VERSION,
    sessionRef,
    eventKind: TELEMETRY_ENVELOPE_KIND_TO_EVENT_KIND[envelope.kind],
  };
}
