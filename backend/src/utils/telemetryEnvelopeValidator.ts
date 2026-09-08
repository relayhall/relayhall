/**
 * telemetryEnvelopeValidator — the FIRST stage of the one normalization entry
 * point `validate -> dedupe -> redact -> store` (RH-TW1a; the seam TW1b
 * `dac2ca71` reuses so that OTLP translators produce envelopes and share the
 * identical write path — a second write path is the defect, run packet §8).
 *
 * Deny-by-default at the STRUCTURE level: the top-level field set is a closed
 * allowlist, every vocabulary is closed, and every retained free-form string
 * is bounded by an identifier character class. That is what makes the §6.1
 * hard rule — "no prompts, responses, file paths, command arguments, or raw
 * exception messages" — enforceable rather than aspirational: there is no
 * top-level field a reporter can pour prose into, and the one open map
 * (`attributes`) is dropped wholesale by the Tier-0 policy engine.
 *
 * The validator does NOT redact. Redaction is the policy engine's stage and
 * runs after this one, on a structurally known record.
 */
import crypto from 'crypto';
import {
  TELEMETRY_ENVELOPE_ACCEPTED_MAJORS,
  TELEMETRY_ENVELOPE_KINDS,
  TELEMETRY_ENVELOPE_MAX_BYTES,
  TELEMETRY_ENVELOPE_PHASES,
  TELEMETRY_ENVELOPE_SCHEMA_FAMILY,
  TELEMETRY_INGESTIBLE_COST_BASES,
  TELEMETRY_MODEL_OPERATIONS,
  TELEMETRY_OUTCOME_STATUSES,
  TELEMETRY_SOURCE_MECHANISMS,
  TELEMETRY_SUPPORT_LEVELS,
  type TelemetryEnvelope,
} from '../types/TelemetryEnvelope';

export type TelemetryValidationCode =
  | 'INVALID_ENVELOPE'
  | 'UNSUPPORTED_SCHEMA_MAJOR'
  | 'ENVELOPE_TOO_LARGE'
  | 'MISSING_EVENT_IDENTITY';

export interface TelemetryValidationFailure {
  ok: false;
  code: TelemetryValidationCode;
  field: string;
  message: string;
  /** Present on UNSUPPORTED_SCHEMA_MAJOR — the §3.1/§4.8 advertisement. */
  acceptedMajors?: readonly number[];
}

export interface TelemetryValidationSuccess {
  ok: true;
  envelope: TelemetryEnvelope;
  /** Which §4.3 identity arm this record can be keyed on. */
  identityArm: 'event_id' | 'stream_sequence' | 'content_hash';
}

export type TelemetryValidationResult = TelemetryValidationSuccess | TelemetryValidationFailure;

/**
 * PER-FIELD value classes (review `bfac1dd5` finding F1).
 *
 * One broad "identifier" class for every retained string was NOT a content
 * boundary. The reviewer put `RawPromptWithoutSpaces` in `source.adapter_version`,
 * `CustomerSSN123456789` in `correlation.request_id` and a whitespace-free
 * exception message in `outcome.finish_reasons`, and all three survived: none
 * of those classes of content needs a space or a slash.
 *
 * Each retained field now carries the TIGHTEST class its contract allows, and
 * the table below is the single inventory that the policy engine and the
 * hostile-marker control are both driven from. Widening a class here is a
 * visible, reviewable act.
 *
 * Where no tight class exists because the value is opaque BY CONTRACT, the
 * field is not retained raw at all — it is pseudonymized (see
 * `TELEMETRY_TIER0_PSEUDONYMIZED_FIELDS` in the policy engine). The residual
 * risk that is NOT closed by shape — an adapter that mis-maps content into a
 * genuinely opaque identifier field — is a certification concern (§8, TW1b)
 * and is stated in docs/observability.md rather than pretended away.
 */
/** Opaque machine identifier: no whitespace, no quotes, no slashes, short. */
const IDENTIFIER_RE = /^[A-Za-z0-9._:@+\-]{1,200}$/;
/** W3C trace context: lowercase hex of a fixed width. */
const TRACE_ID_RE = /^[0-9a-f]{8,64}$/;
/** A correlation identifier that is retained RAW. Tight and short. */
const CORRELATION_ID_RE = /^[A-Za-z0-9._:@+\-]{1,128}$/;
/** A model or provider name: no spaces, so a sentence cannot ride in. */
const MODEL_NAME_RE = /^[A-Za-z0-9._:+\-/]{1,80}$/;
/**
 * A version string that is actually a VERSION. `[A-Za-z0-9._+-]{1,40}` was not
 * enough: the reviewer's attack value (`RawPromptWithoutSpaces`) is
 * letters-only and passed it. The envelope reference calls this field semver,
 * so requiring a leading numeric component is not a narrowing of the contract —
 * it is the contract, and it excludes prose by construction.
 */
const VERSION_RE = /^v?\d{1,6}(\.\d{1,6}){0,3}([.\-+][A-Za-z0-9.\-]{1,24})?$/;
/**
 * A product / adapter key — THE INGEST PRODUCT GRAMMAR, and the one copy of it.
 *
 * Exported because it is now asked twice: at ingest, where a product that does
 * not match is not stored, and at the READ routes, where `sourceProduct` is
 * half of a telemetry source's identity. Review `a4a748d5` (MINOR) found the
 * read route checking presence and length only while its own comment claimed
 * it refused malformed keys before any row was read. Two hand-written copies
 * of a grammar are two grammars; the projection route imports this one.
 */
export const PRODUCT_RE = /^[A-Za-z0-9._\-]{1,64}$/;

/**
 * §4.2 finish reasons, CLOSED (F1). An open string here was a free-text
 * channel wearing an enum's clothes. The vocabulary is the union of the OTel
 * GenAI finish reasons and the outcomes this plane already names; an
 * unrecognized reason is dropped and counted, never stored.
 */
export const TELEMETRY_FINISH_REASONS = [
  'stop', 'length', 'content_filter', 'tool_calls', 'function_call',
  'error', 'cancelled', 'timeout', 'refusal', 'other',
] as const;

/**
 * Exception TYPE class (F2). Strict enough that `Error: ENOENT /etc/shadow`
 * cannot pass as a "type": no spaces, no colons, no slashes — a class name.
 */
export const EXCEPTION_TYPE_RE = /^[A-Za-z_$][A-Za-z0-9_$.]{0,79}$/;
const RFC3339_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?(Z|[+-]\d{2}:\d{2})$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const TOP_LEVEL_FIELDS = new Set([
  'schema_version', 'event_id', 'observed_at', 'occurred_at',
  'stream_generation', 'source_sequence', 'source', 'identity',
  'correlation', 'kind', 'phase', 'model', 'usage', 'timing',
  'outcome', 'context', 'content', 'attributes',
]);

const SOURCE_FIELDS = new Set([
  'product', 'instance_id', 'adapter', 'adapter_version',
  'mechanism', 'support_level', 'last_verified', 'raw_ref',
]);
const IDENTITY_FIELDS = new Set(['tenant_id', 'user_id', 'project_id', 'workspace_id']);
const CORRELATION_FIELDS = new Set([
  'trace_id', 'span_id', 'parent_span_id', 'conversation_id',
  'session_id', 'attempt_id', 'request_id', 'tool_call_id',
]);
/** W3C trace-context fields, which are hex by specification. */
const TRACE_FIELDS: ReadonlySet<string> = new Set(['trace_id', 'span_id', 'parent_span_id']);
const MODEL_FIELDS = new Set(['provider', 'requested', 'resolved', 'operation']);
const USAGE_FIELDS = new Set([
  'input_tokens', 'output_tokens', 'cached_read_tokens', 'cached_write_tokens',
  'reasoning_tokens', 'tool_tokens', 'requests', 'cost',
]);
const COST_FIELDS = new Set(['amount', 'currency', 'basis']);
const TIMING_FIELDS = new Set(['duration_ms', 'queue_ms', 'time_to_first_token_ms', 'inter_token_ms']);
/**
 * Outcome fields a reporter may actually SEND and have stored. This is the
 * accepted contract, and `TelemetryEnvelopeOutcome` must match it exactly —
 * asserted by `telemetryEnvelopeFreeze.test.ts` (review `bc03054d`, R3-F4:
 * the validator once accepted a field the frozen interface did not declare,
 * and a cast hid the drift from the compiler).
 */
export const TELEMETRY_ACCEPTED_OUTCOME_FIELDS: readonly string[] =
  ['status', 'finish_reasons', 'error_type'];

/**
 * Outcome fields that are RECOGNIZED ONLY TO BE REFUSED, each with the reason.
 * They stay in the allowlist so a reporter sending one gets a message naming
 * the rule rather than a bare "unknown field" — and so this file states, in
 * one place, exactly what is not honoured.
 */
export const TELEMETRY_REFUSED_OUTCOME_FIELDS: Readonly<Record<string, string>> = {
  error_fingerprint: 'outcome.error_fingerprint is not stored at TW1a: the error fingerprint is a DECLARED NARROWING of design 7d5c0cdc §6.1 (owner ruling 2026-09-03), because no fingerprint derived from reporter-chosen input can satisfy "containing no message-derived bytes". It returns in TW2 with a trusted first-party capture path.',
  error_frames: 'outcome.error_frames is not accepted at TW1a: it existed only to let the receiver compute a fingerprint, and that mechanism is withdrawn (see outcome.error_fingerprint).',
};

const OUTCOME_FIELDS = new Set([
  ...TELEMETRY_ACCEPTED_OUTCOME_FIELDS,
  ...Object.keys(TELEMETRY_REFUSED_OUTCOME_FIELDS),
]);
const CONTEXT_FIELDS = new Set(['max_tokens', 'used_tokens', 'utilization', 'compaction_count']);
const CONTENT_FIELDS = new Set([
  'policy_tier', 'prompt_ref', 'response_ref', 'tool_input_ref', 'tool_output_ref', 'redactions',
]);

const MAX_FINISH_REASONS = 8;
const MAX_ATTRIBUTE_KEYS = 128;

/**
 * THE FROZEN REPORTER SURFACE, as one inventory (review finding F5).
 *
 * The hostile-marker control generates its envelope from this table, and a
 * completeness assertion fails whenever a field is added to a validator
 * allowlist without gaining a hostile value. That is what stops the control
 * from staying green while a newly added field leaks.
 */
export const TELEMETRY_REPORTER_STRING_FIELDS: readonly string[] = [
  'event_id', 'stream_generation',
  'source.product', 'source.adapter', 'source.instance_id', 'source.adapter_version',
  'source.mechanism', 'source.support_level', 'source.last_verified',
  'identity.tenant_id', 'identity.user_id', 'identity.project_id', 'identity.workspace_id',
  'correlation.trace_id', 'correlation.span_id', 'correlation.parent_span_id',
  'correlation.conversation_id', 'correlation.session_id', 'correlation.attempt_id',
  'correlation.request_id', 'correlation.tool_call_id',
  'model.provider', 'model.requested', 'model.resolved', 'model.operation',
  'usage.cost.amount', 'usage.cost.currency', 'usage.cost.basis',
  'outcome.status', 'outcome.error_type', 'outcome.error_fingerprint', 'outcome.error_frames',
  'outcome.finish_reasons',
  'phase', 'attributes',
];

/** The allowlist SETS, exported so the inventory above can be proven complete. */
export const TELEMETRY_VALIDATOR_FIELD_SETS = {
  topLevel: () => TOP_LEVEL_FIELDS,
  source: () => SOURCE_FIELDS,
  identity: () => IDENTITY_FIELDS,
  correlation: () => CORRELATION_FIELDS,
  model: () => MODEL_FIELDS,
  usage: () => USAGE_FIELDS,
  cost: () => COST_FIELDS,
  outcome: () => OUTCOME_FIELDS,
  timing: () => TIMING_FIELDS,
  context: () => CONTEXT_FIELDS,
  content: () => CONTENT_FIELDS,
};

function fail(code: TelemetryValidationCode, field: string, message: string, acceptedMajors?: readonly number[]): TelemetryValidationFailure {
  return acceptedMajors ? { ok: false, code, field, message, acceptedMajors } : { ok: false, code, field, message };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Parse `rh.ai.telemetry/<major>.<minor>`. Returns null when the string does
 * not name this schema family at all — a different family is an
 * INVALID_ENVELOPE, not an unsupported major, because advertising OUR majors
 * to a sender that meant some other schema would be misleading.
 */
export function parseTelemetrySchemaVersion(value: unknown): { major: number; minor: number } | null {
  if (typeof value !== 'string') return null;
  const match = /^([A-Za-z0-9._-]+)\/(\d{1,4})\.(\d{1,4})$/.exec(value);
  if (!match || match[1] !== TELEMETRY_ENVELOPE_SCHEMA_FAMILY) return null;
  return { major: Number(match[2]), minor: Number(match[3]) };
}

/** §3.1 / §4.8 advertisement, exported so rejections and discovery agree. */
export function telemetryAcceptedMajorsAdvertisement(): { schemaFamily: string; acceptedMajors: readonly number[] } {
  return { schemaFamily: TELEMETRY_ENVELOPE_SCHEMA_FAMILY, acceptedMajors: TELEMETRY_ENVELOPE_ACCEPTED_MAJORS };
}

function checkClosedObject(
  value: unknown, allowed: Set<string>, field: string,
): TelemetryValidationFailure | null {
  if (!isPlainObject(value)) return fail('INVALID_ENVELOPE', field, `${field} must be a JSON object`);
  const unknown = Object.keys(value).filter((key) => !allowed.has(key));
  if (unknown.length > 0) {
    return fail('INVALID_ENVELOPE', field, `${field} carries unknown field(s): ${unknown.slice(0, 5).join(', ')}`);
  }
  return null;
}

function checkString(
  value: unknown, field: string, re: RegExp, required: boolean,
): TelemetryValidationFailure | null {
  if (value === undefined || value === null) {
    return required ? fail('INVALID_ENVELOPE', field, `${field} is required`) : null;
  }
  if (typeof value !== 'string' || !re.test(value)) {
    return fail('INVALID_ENVELOPE', field, `${field} must match the accepted identifier form`);
  }
  return null;
}

function checkEnum(value: unknown, field: string, allowed: readonly string[]): TelemetryValidationFailure | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string' || !allowed.includes(value)) {
    return fail('INVALID_ENVELOPE', field, `${field} must be one of: ${allowed.join(', ')}`);
  }
  return null;
}

function checkNumber(value: unknown, field: string, opts: { min?: number } = {}): TelemetryValidationFailure | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return fail('INVALID_ENVELOPE', field, `${field} must be a finite number`);
  }
  if (opts.min !== undefined && value < opts.min) {
    return fail('INVALID_ENVELOPE', field, `${field} must be >= ${opts.min}`);
  }
  return null;
}

function checkNumericBlock(
  block: unknown, allowed: Set<string>, field: string, numericKeys: string[],
): TelemetryValidationFailure | null {
  if (block === undefined || block === null) return null;
  const closed = checkClosedObject(block, allowed, field);
  if (closed) return closed;
  const obj = block as Record<string, unknown>;
  for (const key of numericKeys) {
    const err = checkNumber(obj[key], `${field}.${key}`, { min: 0 });
    if (err) return err;
  }
  return null;
}

/**
 * Validate one untrusted record against the frozen `rh.ai.telemetry/1.0`
 * shape. Returns the record UNCHANGED on success (redaction is a later
 * stage), plus the §4.3 identity arm it can be keyed on.
 */
export function validateTelemetryEnvelope(input: unknown): TelemetryValidationResult {
  if (!isPlainObject(input)) {
    return fail('INVALID_ENVELOPE', '(root)', 'an envelope must be a JSON object');
  }

  // Size is checked on the CANONICAL serialization of the submitted record,
  // so a sender cannot buy headroom with whitespace.
  const serialized = JSON.stringify(input);
  if (Buffer.byteLength(serialized, 'utf8') > TELEMETRY_ENVELOPE_MAX_BYTES) {
    return fail('ENVELOPE_TOO_LARGE', '(root)', `an envelope may not exceed ${TELEMETRY_ENVELOPE_MAX_BYTES} bytes`);
  }

  const version = parseTelemetrySchemaVersion(input.schema_version);
  if (!version) {
    return fail('INVALID_ENVELOPE', 'schema_version', `schema_version must be '${TELEMETRY_ENVELOPE_SCHEMA_FAMILY}/<major>.<minor>'`);
  }
  if (!TELEMETRY_ENVELOPE_ACCEPTED_MAJORS.includes(version.major)) {
    return fail(
      'UNSUPPORTED_SCHEMA_MAJOR', 'schema_version',
      `schema major ${version.major} is not accepted`,
      TELEMETRY_ENVELOPE_ACCEPTED_MAJORS,
    );
  }

  const topLevel = checkClosedObject(input, TOP_LEVEL_FIELDS, '(root)');
  if (topLevel) return topLevel;

  const kindErr = checkEnum(input.kind, 'kind', TELEMETRY_ENVELOPE_KINDS);
  if (kindErr) return kindErr;
  if (input.kind === undefined || input.kind === null) {
    return fail('INVALID_ENVELOPE', 'kind', 'kind is required');
  }
  const phaseErr = checkEnum(input.phase, 'phase', TELEMETRY_ENVELOPE_PHASES);
  if (phaseErr) return phaseErr;

  for (const [field, re] of [['event_id', IDENTIFIER_RE], ['stream_generation', IDENTIFIER_RE]] as const) {
    const err = checkString(input[field], field, re, false);
    if (err) return err;
  }
  for (const field of ['observed_at', 'occurred_at'] as const) {
    const err = checkString(input[field], field, RFC3339_RE, false);
    if (err) return err;
  }
  if (input.source_sequence !== undefined && input.source_sequence !== null) {
    const seq = input.source_sequence;
    const seqOk = (typeof seq === 'number' && Number.isFinite(seq) && seq >= 0)
      || (typeof seq === 'string' && /^\d{1,38}$/.test(seq));
    if (!seqOk) {
      return fail('INVALID_ENVELOPE', 'source_sequence', 'source_sequence must be a non-negative integer or its decimal string');
    }
  }

  // ---- source ------------------------------------------------------------
  const sourceClosed = checkClosedObject(input.source, SOURCE_FIELDS, 'source');
  if (sourceClosed) return sourceClosed;
  const source = input.source as Record<string, unknown>;
  for (const [field, re, required] of [
    ['product', PRODUCT_RE, true],
    ['adapter', PRODUCT_RE, true],
    ['instance_id', IDENTIFIER_RE, false],
    ['adapter_version', VERSION_RE, false],
  ] as const) {
    const err = checkString(source[field], `source.${field}`, re, required);
    if (err) return err;
  }
  const mechErr = checkEnum(source.mechanism, 'source.mechanism', TELEMETRY_SOURCE_MECHANISMS);
  if (mechErr) return mechErr;
  const supportErr = checkEnum(source.support_level, 'source.support_level', TELEMETRY_SUPPORT_LEVELS);
  if (supportErr) return supportErr;
  const verifiedErr = checkString(source.last_verified, 'source.last_verified', DATE_RE, false);
  if (verifiedErr) return verifiedErr;
  // §6.5.1: `raw_ref` names a GOVERNED store entry the receiver writes. A
  // reporter cannot supply one — accepting a client-chosen pointer would let
  // one source name another's blob.
  if (source.raw_ref !== undefined && source.raw_ref !== null) {
    return fail('INVALID_ENVELOPE', 'source.raw_ref', 'source.raw_ref is receiver-assigned and may not be supplied by a reporter');
  }

  // ---- identity (ADVISORY, §4.1) ----------------------------------------
  if (input.identity !== undefined && input.identity !== null) {
    const closed = checkClosedObject(input.identity, IDENTITY_FIELDS, 'identity');
    if (closed) return closed;
    for (const field of IDENTITY_FIELDS) {
      const value = (input.identity as Record<string, unknown>)[field];
      if (value === undefined || value === null) continue;
      if (typeof value !== 'string' || value.length === 0 || value.length > 320) {
        return fail('INVALID_ENVELOPE', `identity.${field}`, `identity.${field} must be a string of at most 320 characters`);
      }
    }
  }

  // ---- correlation -------------------------------------------------------
  if (input.correlation !== undefined && input.correlation !== null) {
    const closed = checkClosedObject(input.correlation, CORRELATION_FIELDS, 'correlation');
    if (closed) return closed;
    for (const field of CORRELATION_FIELDS) {
      const re = TRACE_FIELDS.has(field) ? TRACE_ID_RE : CORRELATION_ID_RE;
      const err = checkString((input.correlation as Record<string, unknown>)[field], `correlation.${field}`, re, false);
      if (err) return err;
    }
  }

  // ---- model -------------------------------------------------------------
  if (input.model !== undefined && input.model !== null) {
    const closed = checkClosedObject(input.model, MODEL_FIELDS, 'model');
    if (closed) return closed;
    const model = input.model as Record<string, unknown>;
    for (const field of ['provider', 'requested', 'resolved'] as const) {
      const err = checkString(model[field], `model.${field}`, MODEL_NAME_RE, false);
      if (err) return err;
    }
    const opErr = checkEnum(model.operation, 'model.operation', TELEMETRY_MODEL_OPERATIONS);
    if (opErr) return opErr;
  }

  // ---- usage -------------------------------------------------------------
  if (input.usage !== undefined && input.usage !== null) {
    const closed = checkClosedObject(input.usage, USAGE_FIELDS, 'usage');
    if (closed) return closed;
    const usage = input.usage as Record<string, unknown>;
    for (const key of ['input_tokens', 'output_tokens', 'cached_read_tokens', 'cached_write_tokens', 'reasoning_tokens', 'tool_tokens', 'requests']) {
      const err = checkNumber(usage[key], `usage.${key}`, { min: 0 });
      if (err) return err;
    }
    if (usage.cost !== undefined && usage.cost !== null) {
      const costClosed = checkClosedObject(usage.cost, COST_FIELDS, 'usage.cost');
      if (costClosed) return costClosed;
      const cost = usage.cost as Record<string, unknown>;
      if (cost.amount !== undefined && cost.amount !== null) {
        const amountOk = (typeof cost.amount === 'number' && Number.isFinite(cost.amount) && cost.amount >= 0)
          || (typeof cost.amount === 'string' && /^\d{1,20}(\.\d{1,12})?$/.test(cost.amount));
        if (!amountOk) return fail('INVALID_ENVELOPE', 'usage.cost.amount', 'usage.cost.amount must be a non-negative decimal');
      }
      const currencyErr = checkString(cost.currency, 'usage.cost.currency', /^[A-Z]{3}$/, false);
      if (currencyErr) return currencyErr;
      if (cost.basis !== undefined && cost.basis !== null) {
        if (!TELEMETRY_INGESTIBLE_COST_BASES.includes(cost.basis as never)) {
          // §4.7: reconciliation receipts are the ONLY path to `reconciled`.
          return fail('INVALID_ENVELOPE', 'usage.cost.basis', `usage.cost.basis must be one of: ${TELEMETRY_INGESTIBLE_COST_BASES.join(', ')} — 'reconciled' is reachable only through a reconciliation receipt`);
        }
      }
    }
  }

  // ---- timing / context --------------------------------------------------
  const timingErr = checkNumericBlock(input.timing, TIMING_FIELDS, 'timing', [...TIMING_FIELDS]);
  if (timingErr) return timingErr;
  const contextErr = checkNumericBlock(input.context, CONTEXT_FIELDS, 'context', [...CONTEXT_FIELDS]);
  if (contextErr) return contextErr;

  // ---- outcome -----------------------------------------------------------
  if (input.outcome !== undefined && input.outcome !== null) {
    const closed = checkClosedObject(input.outcome, OUTCOME_FIELDS, 'outcome');
    if (closed) return closed;
    const outcome = input.outcome as Record<string, unknown>;
    const statusErr = checkEnum(outcome.status, 'outcome.status', TELEMETRY_OUTCOME_STATUSES);
    if (statusErr) return statusErr;
    // F2: an exception TYPE is a class name. The old identifier class admitted
    // `Error:ENOENT/etc/shadow`-shaped values, so the message could ride in on
    // the one field whose whole purpose was to be message-free.
    const typeErr = checkString(outcome.error_type, 'outcome.error_type', EXCEPTION_TYPE_RE, false);
    if (typeErr) return typeErr;
    // Fields recognized only to be refused (the §6.1 narrowing). Naming the
    // rule beats a bare "unknown field": a reporter must not be able to think
    // a fingerprint is being stored when none is.
    for (const [field, reason] of Object.entries(TELEMETRY_REFUSED_OUTCOME_FIELDS)) {
      if (outcome[field] !== undefined && outcome[field] !== null) {
        return fail('INVALID_ENVELOPE', `outcome.${field}`, reason);
      }
    }
    if (outcome.finish_reasons !== undefined && outcome.finish_reasons !== null) {
      if (!Array.isArray(outcome.finish_reasons) || outcome.finish_reasons.length > MAX_FINISH_REASONS) {
        return fail('INVALID_ENVELOPE', 'outcome.finish_reasons', `outcome.finish_reasons must be an array of at most ${MAX_FINISH_REASONS} entries`);
      }
      for (const reason of outcome.finish_reasons) {
        // F1: CLOSED vocabulary. An open string here was a free-text channel.
        if (typeof reason !== 'string' || !TELEMETRY_FINISH_REASONS.includes(reason as never)) {
          return fail('INVALID_ENVELOPE', 'outcome.finish_reasons[]', `each finish reason must be one of: ${TELEMETRY_FINISH_REASONS.join(', ')}`);
        }
      }
    }
  }

  // ---- content -----------------------------------------------------------
  if (input.content !== undefined && input.content !== null) {
    const closed = checkClosedObject(input.content, CONTENT_FIELDS, 'content');
    if (closed) return closed;
    const content = input.content as Record<string, unknown>;
    if (content.policy_tier !== undefined && content.policy_tier !== null
      && ![0, 1, 2].includes(content.policy_tier as number)) {
      return fail('INVALID_ENVELOPE', 'content.policy_tier', 'content.policy_tier must be 0, 1 or 2');
    }
    // Content REFERENCES are receiver-assigned exactly as raw_ref is: a
    // reporter-supplied pointer could name another source's governed blob.
    for (const field of ['prompt_ref', 'response_ref', 'tool_input_ref', 'tool_output_ref'] as const) {
      if (content[field] !== undefined && content[field] !== null) {
        return fail('INVALID_ENVELOPE', `content.${field}`, `content.${field} is receiver-assigned and may not be supplied by a reporter`);
      }
    }
  }

  // ---- attributes --------------------------------------------------------
  // Structurally an open map by design (§4.5). It is bounded here and DROPPED
  // WHOLESALE by the Tier-0 engine — the only reason to accept it at all at
  // TW1a is that rejecting it would make every real reporter unable to send.
  if (input.attributes !== undefined && input.attributes !== null) {
    if (!isPlainObject(input.attributes)) {
      return fail('INVALID_ENVELOPE', 'attributes', 'attributes must be a JSON object');
    }
    if (Object.keys(input.attributes).length > MAX_ATTRIBUTE_KEYS) {
      return fail('INVALID_ENVELOPE', 'attributes', `attributes may carry at most ${MAX_ATTRIBUTE_KEYS} keys`);
    }
  }

  // ---- §4.3 identity arm -------------------------------------------------
  const identityArm = telemetryEnvelopeIdentityArm(input as unknown as TelemetryEnvelope);
  if (identityArm === null) {
    return fail(
      'MISSING_EVENT_IDENTITY', 'event_id',
      'a source without a stable event_id MUST supply stream_generation and source_sequence (design 7d5c0cdc §4.3)',
    );
  }

  return { ok: true, envelope: input as unknown as TelemetryEnvelope, identityArm };
}

/**
 * Which §4.3 arm keys this record. `content_hash` is deliberately NOT reached
 * by the validator: §4.3 makes it best-effort only, so ingest REQUIRES one of
 * the two real arms and refuses otherwise. The arm exists in the type because
 * TW1b's translators may key replayed fixtures on it under their own caveat.
 */
export function telemetryEnvelopeIdentityArm(envelope: TelemetryEnvelope): 'event_id' | 'stream_sequence' | null {
  if (typeof envelope.event_id === 'string' && envelope.event_id.length > 0) return 'event_id';
  const hasGeneration = typeof envelope.stream_generation === 'string' && envelope.stream_generation.length > 0;
  const hasSequence = envelope.source_sequence !== undefined && envelope.source_sequence !== null;
  return hasGeneration && hasSequence ? 'stream_sequence' : null;
}

/**
 * §4.3 EVENT IDENTITY — always connector-namespaced, never cross-principal.
 *
 * The returned string becomes `session_events.idempotency_key`, which migration
 * 055 already declares UNIQUE: dedupe reuses the foundation's own constraint
 * instead of inventing a second mechanism. The `connectorId` is the FIRST
 * segment of every arm, so two connectors sending the same `event_id` produce
 * different keys — "dedupe never merges events across connectors" is a
 * property of the key's shape, not of a caller remembering to filter.
 */
export function telemetryEventIdentityKey(
  connectorId: string,
  envelope: TelemetryEnvelope,
): { key: string; arm: 'event_id' | 'stream_sequence' } {
  const arm = telemetryEnvelopeIdentityArm(envelope);
  if (arm === null) {
    throw new Error('telemetryEventIdentityKey called on an envelope with no §4.3 identity arm — validate first');
  }
  const product = envelope.source.product;
  // Segments are joined with a separator no segment can contain: `product`
  // and `event_id` pass IDENTIFIER_RE, which excludes '|'.
  const prefix = `rh.telemetry/1|${connectorId}|${product}`;
  if (arm === 'event_id') {
    return { key: `${prefix}|eid|${envelope.event_id}`, arm };
  }
  return { key: `${prefix}|seq|${envelope.stream_generation}|${String(envelope.source_sequence)}`, arm };
}

/**
 * Canonical JSON — object keys sorted at every depth — so that a payload hash
 * is stable under key reordering. Used for `session_events.payload_hash`.
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value ?? null);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const entries = Object.keys(value as Record<string, unknown>).sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`);
  return `{${entries.join(',')}}`;
}

export function canonicalPayloadHash(value: unknown): string {
  return crypto.createHash('sha256').update(canonicalJson(value), 'utf8').digest('hex');
}
