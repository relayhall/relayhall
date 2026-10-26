/**
 * otlpTranslation — OTLP records into `rh.ai.telemetry/1.0` envelopes
 * (RH-TW1b slice 1, card `dac2ca71`; TELEMETRY-DESIGN `7d5c0cdc` §3.1 item 1,
 * §3.3, §4.5, §8.1).
 *
 * THREE TRANSLATIONS, chosen per record, most specific first:
 *
 *   1. `otlp.claude-code` — a PRODUCT PROFILE for Claude Code's own OTLP export
 *      (`service.name = claude-code`). Its log EVENTS are the one channel it
 *      carries: `api_request` is a model call with tokens, cost and duration;
 *      `tool_result` a tool call; `api_error` an error; `user_prompt` and
 *      `assistant_response` turn boundaries; `tool_decision` an audit record;
 *      `mcp_server_connection` a health record. Claude Code reports the SAME
 *      request three times — as that log event, as an `llm_request` span and
 *      inside `claude_code.token.usage` / `cost.usage` metric points — so its
 *      metric points and spans are REFUSED BY NAME rather than translated: a
 *      receiver that stored all three would triple every token and every cent
 *      the Stats rollups sum, and one that silently dropped two would be
 *      acknowledging data it discarded.
 *   2. `otlp.openinference` — spans carrying `openinference.span.kind`.
 *   3. `otlp.genai` — spans carrying GenAI semantic-convention attributes
 *      (`gen_ai.*`), and the `gen_ai.client.token.usage` histogram.
 *
 * Anything else is refused by name (`OTLP_NO_TRANSLATION`), and counted.
 *
 * EVERY MAPPING IS ALL-OR-NOTHING PER ATTRIBUTE ENTRY. An entry is either
 * mapped whole into one envelope field — and recorded in `carried` with that
 * field's path in the STORED record — or not mapped at all. The receiver counts
 * an entry as carried only if that path is present in the record the store
 * returns; everything else the decoder counted is dropped. No translation
 * keeps a list of what it "consumed".
 *
 * NUMBERS ARE CARRIED, NEVER RENDERED (round-3 finding X1-R3). A measurement
 * goes into a NUMERIC envelope field as the exact double the wire carried. An
 * int64 outside the exactly-representable range, a NaN or an infinity, or a
 * decimal string that does not round-trip, cannot be carried exactly — and a
 * record whose measurement cannot be carried exactly is REFUSED by name, never
 * acknowledged with a nearby value.
 *
 * NO IDENTITY IS BUILT HERE. A translation emits no `event_id`, no stream
 * sequence and no digest: the store derives the §4.3 key from the record it
 * stores (`telemetryRecordIdentity`). There is no parameter through which a
 * dropped value could reach it.
 */
import {
  EXCEPTION_TYPE_RE, PRODUCT_RE, TELEMETRY_FINISH_REASONS, VERSION_RE,
} from '../../utils/telemetryEnvelopeValidator';
import {
  TELEMETRY_ENVELOPE_SCHEMA_VERSION,
  type TelemetryEnvelope,
  type TelemetryEnvelopeKind,
  type TelemetryModelOperation,
  type TelemetryOutcomeStatus,
} from '../../types/TelemetryEnvelope';
import { TELEMETRY_ADVISORY_ATTRIBUTE_PREFIX, type TelemetryAttributeProfile } from '../TelemetryPolicyEngine';
import type {
  OtlpAttribute, OtlpAttributes, OtlpItem, OtlpLogItem, OtlpMetricItem, OtlpSpanItem, OtlpValue,
} from '../../utils/otlp/otlpDecode';

/** The closed set of translation ids. `session_adapter_health` keys never grow past it. */
export const OTLP_TRANSLATIONS = ['otlp.claude-code', 'otlp.openinference', 'otlp.genai'] as const;
export type OtlpTranslationId = (typeof OTLP_TRANSLATIONS)[number];

/** Each translation's §8.2 rung. None is advertised beyond `experimental` in this slice. */
export const OTLP_TRANSLATION_SUPPORT: Readonly<Record<OtlpTranslationId, 'experimental'>> = {
  'otlp.claude-code': 'experimental',
  'otlp.openinference': 'experimental',
  'otlp.genai': 'experimental',
};

/** Version of the translation rules; carried as nothing, reported on adapter health. */
export const OTLP_TRANSLATION_VERSION = '1.0.0';

/** Refusal codes a translation can name. A closed set, so health counters stay bounded. */
export const OTLP_REJECTION_CODES = [
  'OTLP_PRODUCT_NOT_DECLARED',
  'OTLP_NO_TRANSLATION',
  'OTLP_CHANNEL_NOT_TRANSLATED',
  'OTLP_EVENT_NOT_TRANSLATED',
  'OTLP_METRIC_NOT_TRANSLATED',
  'OTLP_TEMPORALITY_NOT_TRANSLATED',
  'OTLP_MEASUREMENT_NOT_EXACT',
] as const;
export type OtlpRejectionCode = (typeof OTLP_REJECTION_CODES)[number];

/**
 * The §4.5 CERTIFIED PROFILE for translated records: the only `attributes`
 * keys a translation emits, each with the value class it is certified for.
 * A tool or agent NAME is §6.1 Tier-0 metadata; the class admits identifier
 * characters only, so no sentence, path or argument fits.
 */
const NAME_CLASS = /^[A-Za-z0-9_.:\-]{1,64}$/;
export const OTLP_ATTRIBUTE_PROFILE: TelemetryAttributeProfile = new Map<string, RegExp>([
  ['tool.name', NAME_CLASS],
  ['agent.name', NAME_CLASS],
]);

/** A path into the STORED Tier-0 record. Arrays, because attribute keys contain dots. */
export type RecordPath = readonly string[];

export interface OtlpCarriedEntry {
  readonly id: number;
  readonly path: RecordPath;
}

export type OtlpTranslationResult =
  | {
      ok: true;
      translation: OtlpTranslationId;
      envelope: TelemetryEnvelope;
      /** Producer attribute entries mapped into the envelope, with where they land. */
      carried: readonly OtlpCarriedEntry[];
      /** The record's source timestamp, for clock-skew health. */
      occurredNs: bigint | null;
    }
  | {
      ok: false;
      translation: OtlpTranslationId | null;
      code: OtlpRejectionCode;
      message: string;
    };

// ───────────────────────────── value helpers ────────────────────────────────

/**
 * An attribute value as an EXACT JS number, or a reason it is not one.
 *
 * `absent` — no value of a numeric shape (the field is simply not mapped);
 * `inexact` — a measurement was sent but cannot be carried exactly.
 */
type Exact = { ok: true; value: number } | { ok: false; reason: 'absent' | 'inexact' };

function exactNumber(value: OtlpValue | undefined): Exact {
  if (!value) return { ok: false, reason: 'absent' };
  switch (value.kind) {
    case 'double':
      return Number.isFinite(value.value) ? { ok: true, value: value.value } : { ok: false, reason: 'inexact' };
    case 'int':
      if (value.value === null) return { ok: false, reason: 'inexact' };
      return value.value >= BigInt(Number.MIN_SAFE_INTEGER) && value.value <= BigInt(Number.MAX_SAFE_INTEGER)
        ? { ok: true, value: Number(value.value) } : { ok: false, reason: 'inexact' };
    case 'string': {
      // Some producers send a count as a decimal STRING (Claude Code's
      // `duration_ms` on several events). It is carried only when the number
      // renders back to exactly the string sent — never "close enough".
      if (!/^-?\d{1,17}(\.\d{1,17})?(e-?\d{1,3})?$/i.test(value.value)) return { ok: false, reason: 'absent' };
      const parsed = Number(value.value);
      return Number.isFinite(parsed) && String(parsed) === value.value
        ? { ok: true, value: parsed } : { ok: false, reason: 'inexact' };
    }
    default:
      return { ok: false, reason: 'absent' };
  }
}

function stringOf(value: OtlpValue | undefined): string | null {
  return value && value.kind === 'string' && value.value.length > 0 ? value.value : null;
}

function boolOf(value: OtlpValue | undefined): boolean | null {
  if (!value) return null;
  if (value.kind === 'bool') return value.value;
  if (value.kind === 'string' && (value.value === 'true' || value.value === 'false')) return value.value === 'true';
  return null;
}

/** RFC 3339 with all nine fractional digits — exact, never rounded to milliseconds. */
export function rfc3339FromNanos(ns: bigint | null): string | null {
  if (ns === null || ns <= 0n) return null;
  const date = new Date(Number(ns / 1_000_000n));
  if (Number.isNaN(date.getTime()) || date.getUTCFullYear() > 9999) return null;
  return `${date.toISOString().slice(0, 19)}.${(ns % 1_000_000_000n).toString().padStart(9, '0')}Z`;
}

/** A span duration in milliseconds, only when the nanosecond difference is exact. */
function durationMs(startNs: bigint | null, endNs: bigint | null): number | null {
  if (startNs === null || endNs === null || endNs < startNs) return null;
  const diff = endNs - startNs;
  if (diff > BigInt(Number.MAX_SAFE_INTEGER)) return null;
  return Number(diff) / 1e6;
}

/**
 * Builds one envelope and records, for every producer attribute it maps,
 * where that value lands in the STORED record.
 */
class EnvelopeBuilder {
  readonly envelope: Record<string, unknown>;
  readonly carried: OtlpCarriedEntry[] = [];
  inexact: string | null = null;

  constructor(product: string, translation: OtlpTranslationId, kind: TelemetryEnvelopeKind) {
    this.envelope = {
      schema_version: TELEMETRY_ENVELOPE_SCHEMA_VERSION,
      kind,
      source: { product, adapter: translation, mechanism: 'push', support_level: OTLP_TRANSLATION_SUPPORT[translation] },
    };
  }

  private put(path: readonly string[], value: unknown): void {
    let node = this.envelope;
    for (const segment of path.slice(0, -1)) {
      if (typeof node[segment] !== 'object' || node[segment] === null) node[segment] = {};
      node = node[segment] as Record<string, unknown>;
    }
    node[path[path.length - 1]] = value;
  }

  /** A value the translation decided, not a producer attribute (no provenance). */
  fixed(path: readonly string[], value: unknown): this {
    this.put(path, value);
    return this;
  }

  /**
   * Map one producer attribute. `storedAt` is where it lands in the Tier-0
   * record when that differs from the envelope path (pseudonymized identity).
   */
  map(attribute: OtlpAttribute | undefined, path: readonly string[], value: unknown, storedAt?: RecordPath): this {
    if (!attribute || value === null || value === undefined) return this;
    this.put(path, value);
    this.carried.push({ id: attribute.id, path: storedAt ?? path });
    return this;
  }

  /** Map a string attribute only when it satisfies `re`; otherwise it is dropped (and counted). */
  string(attribute: OtlpAttribute | undefined, path: readonly string[], re: RegExp, storedAt?: RecordPath): this {
    const text = stringOf(attribute?.value);
    if (text !== null && re.test(text)) this.map(attribute, path, text, storedAt);
    return this;
  }

  /**
   * Map a NON-NEGATIVE measurement EXACTLY. A measurement that was sent but
   * cannot be carried exactly marks the whole record inexact, and the record
   * is then refused by name rather than acknowledged with a nearby value.
   */
  measurement(attribute: OtlpAttribute | undefined, path: readonly string[], key: string): this {
    if (!attribute) return this;
    const exact = exactNumber(attribute.value);
    if (exact.ok && exact.value >= 0) return this.map(attribute, path, exact.value);
    if (!exact.ok && exact.reason === 'absent') return this;
    this.inexact = this.inexact ?? key;
    return this;
  }
}

/** One record's attributes, item first, then scope, then resource. */
class Attrs {
  constructor(private readonly layers: readonly OtlpAttributes[]) {}
  get(key: string): OtlpAttribute | undefined {
    for (const layer of this.layers) {
      const found = layer.get(key);
      if (found) return found;
    }
    return undefined;
  }
  has(prefix: string): boolean {
    return this.layers.some((layer) => [...layer.keys()].some((key) => key.startsWith(prefix)));
  }
  str(key: string): string | null { return stringOf(this.get(key)?.value); }
}

const MODEL_RE = /^[A-Za-z0-9._:+\-/]{1,80}$/;
const CORRELATION_RE = /^[A-Za-z0-9._:@+\-]{1,128}$/;
const INSTANCE_RE = /^[A-Za-z0-9._:@+\-]{1,200}$/;

/** Common resource facts every translation carries the same way. */
function sourceFacts(builder: EnvelopeBuilder, item: OtlpItem): void {
  const resource = item.resource.attributes;
  builder.map(resource.get('service.name'), ['source', 'product'], stringOf(resource.get('service.name')?.value));
  builder.string(resource.get('service.version'), ['source', 'adapter_version'], VERSION_RE);
  builder.string(resource.get('service.instance.id'), ['source', 'instance_id'], INSTANCE_RE, ['source', 'instance_ref']);
}

/** Finish reasons, ALL or NOTHING: an entry with one unknown reason is dropped whole. */
const FINISH_REASON_SYNONYMS: Readonly<Record<string, string>> = {
  end_turn: 'stop', stop_sequence: 'stop', max_tokens: 'length', tool_use: 'tool_calls', pause_turn: 'stop',
};
function finishReasons(attribute: OtlpAttribute | undefined): string[] | null {
  if (!attribute || attribute.value.kind !== 'array' || attribute.value.values.length === 0) return null;
  const mapped: string[] = [];
  for (const value of attribute.value.values) {
    const text = stringOf(value);
    const reason = text === null ? null : (FINISH_REASON_SYNONYMS[text] ?? text);
    if (reason === null || !TELEMETRY_FINISH_REASONS.includes(reason as never)) return null;
    mapped.push(reason);
  }
  return mapped.length > 8 ? null : mapped;
}

function spanStatus(item: OtlpSpanItem): TelemetryOutcomeStatus | null {
  return item.statusCode === 2 ? 'error' : item.statusCode === 1 ? 'ok' : null;
}

/** Span facts shared by both span translations: ids, timing, status, exception type. */
function spanFacts(builder: EnvelopeBuilder, item: OtlpSpanItem, attrs: Attrs): void {
  if (item.traceId) builder.fixed(['correlation', 'trace_id'], item.traceId);
  if (item.spanId) builder.fixed(['correlation', 'span_id'], item.spanId);
  if (item.parentSpanId) builder.fixed(['correlation', 'parent_span_id'], item.parentSpanId);
  const occurred = rfc3339FromNanos(item.startNs);
  if (occurred) builder.fixed(['occurred_at'], occurred);
  const duration = durationMs(item.startNs, item.endNs);
  if (duration !== null) builder.fixed(['timing', 'duration_ms'], duration);
  const status = spanStatus(item);
  if (status) builder.fixed(['outcome', 'status'], status);
  builder.fixed(['phase'], status === 'error' ? 'failed' : 'completed');
  // The exception TYPE (a class name) is Tier-0 metadata; its message never is.
  const errorType = attrs.get('error.type');
  if (stringOf(errorType?.value) && EXCEPTION_TYPE_RE.test(stringOf(errorType?.value) as string)) {
    builder.string(errorType, ['outcome', 'error_type'], EXCEPTION_TYPE_RE);
  } else {
    for (const event of item.events) {
      const type = event.attributes.get('exception.type');
      if (stringOf(type?.value) && EXCEPTION_TYPE_RE.test(stringOf(type?.value) as string)) {
        builder.string(type, ['outcome', 'error_type'], EXCEPTION_TYPE_RE);
        break;
      }
    }
  }
}

function finish(
  builder: EnvelopeBuilder, translation: OtlpTranslationId, occurredNs: bigint | null,
): OtlpTranslationResult {
  if (builder.inexact) {
    return {
      ok: false, translation, code: 'OTLP_MEASUREMENT_NOT_EXACT',
      message: `${builder.inexact} carries a measurement this receiver cannot store exactly; the record is refused rather than rounded`,
    };
  }
  return {
    ok: true, translation, envelope: builder.envelope as unknown as TelemetryEnvelope,
    carried: builder.carried,
    // Only a timestamp that renders as a real instant is reported for clock skew.
    occurredNs: rfc3339FromNanos(occurredNs) === null ? null : occurredNs,
  };
}

function refuse(translation: OtlpTranslationId | null, code: OtlpRejectionCode, message: string): OtlpTranslationResult {
  return { ok: false, translation, code, message };
}

// ─────────────────────────── otlp.claude-code ───────────────────────────────

const CLAUDE_CODE = 'otlp.claude-code' as const;

function claudeCodeCommon(builder: EnvelopeBuilder, attrs: Attrs): void {
  builder.string(attrs.get('session.id'), ['correlation', 'session_id'], CORRELATION_RE);
  // ONE advisory human identifier, pseudonymized by the Tier-0 engine (§6.1).
  // The account uuid is preferred: an address would be folded, an opaque id is not.
  const user = attrs.get('user.account_uuid') ?? attrs.get('user.id');
  const userId = stringOf(user?.value);
  if (userId && userId.length <= 320) {
    builder.map(user, ['identity', 'user_id'], userId, ['attributes', `${TELEMETRY_ADVISORY_ATTRIBUTE_PREFIX}user_id`]);
  }
}

function translateClaudeCodeLog(item: OtlpLogItem, product: string): OtlpTranslationResult {
  const attrs = new Attrs([item.attributes, item.scope.attributes, item.resource.attributes]);
  const event = attrs.str('event.name');
  const kinds: Record<string, TelemetryEnvelopeKind> = {
    api_request: 'model_call', api_error: 'error', tool_result: 'tool_call', tool_decision: 'audit',
    user_prompt: 'turn', assistant_response: 'turn', mcp_server_connection: 'health',
  };
  const kind = event ? kinds[event] : undefined;
  if (!event || !kind) {
    return refuse(CLAUDE_CODE, 'OTLP_EVENT_NOT_TRANSLATED',
      'this Claude Code log event has no Tier-0 translation in this receiver');
  }
  const builder = new EnvelopeBuilder(product, CLAUDE_CODE, kind);
  sourceFacts(builder, item);
  builder.map(attrs.get('event.name'), ['kind'], kind);
  claudeCodeCommon(builder, attrs);
  const occurred = rfc3339FromNanos(item.timeNs ?? item.observedNs);
  if (occurred) builder.fixed(['occurred_at'], occurred);
  if (item.traceId) builder.fixed(['correlation', 'trace_id'], item.traceId);
  if (item.spanId) builder.fixed(['correlation', 'span_id'], item.spanId);

  switch (event) {
    case 'api_request':
      builder.fixed(['phase'], 'completed')
        .fixed(['model', 'provider'], 'anthropic')
        .fixed(['model', 'operation'], 'chat')
        .string(attrs.get('model'), ['model', 'resolved'], MODEL_RE)
        .measurement(attrs.get('input_tokens'), ['usage', 'input_tokens'], 'input_tokens')
        .measurement(attrs.get('output_tokens'), ['usage', 'output_tokens'], 'output_tokens')
        .measurement(attrs.get('cache_read_tokens'), ['usage', 'cached_read_tokens'], 'cache_read_tokens')
        .measurement(attrs.get('cache_creation_tokens'), ['usage', 'cached_write_tokens'], 'cache_creation_tokens')
        .fixed(['usage', 'requests'], 1)
        .measurement(attrs.get('cost_usd'), ['usage', 'cost', 'amount'], 'cost_usd')
        .measurement(attrs.get('duration_ms'), ['timing', 'duration_ms'], 'duration_ms')
        .string(attrs.get('request_id'), ['correlation', 'request_id'], CORRELATION_RE)
        .fixed(['outcome', 'status'], 'ok');
      if ((builder.envelope.usage as Record<string, unknown> | undefined)?.cost) {
        builder.fixed(['usage', 'cost', 'currency'], 'USD').fixed(['usage', 'cost', 'basis'], 'estimated');
      }
      break;
    case 'api_error': {
      const statusCode = exactNumber(attrs.get('status_code')?.value);
      builder.fixed(['phase'], 'failed')
        .fixed(['model', 'provider'], 'anthropic')
        .string(attrs.get('model'), ['model', 'resolved'], MODEL_RE)
        .measurement(attrs.get('duration_ms'), ['timing', 'duration_ms'], 'duration_ms')
        .string(attrs.get('request_id'), ['correlation', 'request_id'], CORRELATION_RE);
      builder.map(attrs.get('status_code'), ['outcome', 'status'],
        statusCode.ok && statusCode.value === 429 ? 'throttled' : statusCode.ok ? 'error' : null);
      if (!(builder.envelope.outcome as Record<string, unknown> | undefined)?.status) builder.fixed(['outcome', 'status'], 'error');
      break;
    }
    case 'tool_result': {
      const success = boolOf(attrs.get('success')?.value);
      builder.fixed(['phase'], success === false ? 'failed' : 'completed')
        .string(attrs.get('tool_name'), ['attributes', 'tool.name'], NAME_CLASS)
        .string(attrs.get('tool_use_id'), ['correlation', 'tool_call_id'], CORRELATION_RE)
        .measurement(attrs.get('duration_ms'), ['timing', 'duration_ms'], 'duration_ms')
        .map(attrs.get('success'), ['outcome', 'status'], success === null ? null : success ? 'ok' : 'error');
      break;
    }
    case 'tool_decision': {
      const decision = attrs.str('decision');
      builder.string(attrs.get('tool_name'), ['attributes', 'tool.name'], NAME_CLASS)
        .string(attrs.get('tool_use_id'), ['correlation', 'tool_call_id'], CORRELATION_RE)
        .map(attrs.get('decision'), ['outcome', 'status'],
          decision === 'accept' ? 'ok' : decision === 'reject' ? 'blocked' : null);
      break;
    }
    case 'user_prompt':
      builder.fixed(['phase'], 'started');
      break;
    case 'assistant_response':
      builder.fixed(['phase'], 'completed')
        .string(attrs.get('model'), ['model', 'resolved'], MODEL_RE)
        .string(attrs.get('request_id'), ['correlation', 'request_id'], CORRELATION_RE);
      break;
    case 'mcp_server_connection': {
      const status = attrs.str('status');
      builder.map(attrs.get('status'), ['phase'],
        status === 'connected' ? 'running' : status === 'disconnected' ? 'completed' : status === 'failed' ? 'failed' : null)
        .measurement(attrs.get('duration_ms'), ['timing', 'duration_ms'], 'duration_ms');
      break;
    }
    default:
      break;
  }
  return finish(builder, CLAUDE_CODE, item.timeNs ?? item.observedNs);
}

// ─────────────────────────── otlp.openinference ─────────────────────────────

const OPENINFERENCE = 'otlp.openinference' as const;

const OPENINFERENCE_KINDS: Readonly<Record<string, { kind: TelemetryEnvelopeKind; operation?: TelemetryModelOperation }>> = {
  LLM: { kind: 'model_call', operation: 'chat' },
  EMBEDDING: { kind: 'model_call', operation: 'embedding' },
  RERANKER: { kind: 'model_call', operation: 'rerank' },
  TOOL: { kind: 'tool_call' },
  AGENT: { kind: 'agent_step' },
  CHAIN: { kind: 'agent_step' },
  RETRIEVER: { kind: 'agent_step' },
  GUARDRAIL: { kind: 'agent_step' },
  EVALUATOR: { kind: 'agent_step' },
};

function translateOpenInference(item: OtlpSpanItem, product: string): OtlpTranslationResult {
  const attrs = new Attrs([item.attributes, item.scope.attributes, item.resource.attributes]);
  const spanKind = attrs.str('openinference.span.kind');
  const mapping = spanKind ? OPENINFERENCE_KINDS[spanKind.toUpperCase()] : undefined;
  if (!mapping) return refuse(OPENINFERENCE, 'OTLP_NO_TRANSLATION', 'unknown OpenInference span kind');
  const builder = new EnvelopeBuilder(product, OPENINFERENCE, mapping.kind);
  sourceFacts(builder, item);
  builder.map(attrs.get('openinference.span.kind'), ['kind'], mapping.kind);
  spanFacts(builder, item, attrs);
  if (mapping.operation) builder.fixed(['model', 'operation'], mapping.operation);
  const provider = attrs.get('llm.provider') ?? attrs.get('llm.system');
  builder.string(provider, ['model', 'provider'], MODEL_RE)
    .string(attrs.get('llm.model_name'), ['model', 'resolved'], MODEL_RE)
    .measurement(attrs.get('llm.token_count.prompt'), ['usage', 'input_tokens'], 'llm.token_count.prompt')
    .measurement(attrs.get('llm.token_count.completion'), ['usage', 'output_tokens'], 'llm.token_count.completion')
    .measurement(attrs.get('llm.token_count.prompt_details.cache_read'), ['usage', 'cached_read_tokens'], 'llm.token_count.prompt_details.cache_read')
    .measurement(attrs.get('llm.token_count.prompt_details.cache_write'), ['usage', 'cached_write_tokens'], 'llm.token_count.prompt_details.cache_write')
    .measurement(attrs.get('llm.token_count.completion_details.reasoning'), ['usage', 'reasoning_tokens'], 'llm.token_count.completion_details.reasoning')
    .string(attrs.get('tool.name'), ['attributes', 'tool.name'], NAME_CLASS)
    .string(attrs.get('session.id'), ['correlation', 'session_id'], CORRELATION_RE);
  const user = attrs.get('user.id');
  const userId = stringOf(user?.value);
  if (userId && userId.length <= 320) {
    builder.map(user, ['identity', 'user_id'], userId, ['attributes', `${TELEMETRY_ADVISORY_ATTRIBUTE_PREFIX}user_id`]);
  }
  return finish(builder, OPENINFERENCE, item.startNs);
}

// ─────────────────────────────── otlp.genai ─────────────────────────────────

const GENAI = 'otlp.genai' as const;

const GENAI_OPERATIONS: Readonly<Record<string, { kind: TelemetryEnvelopeKind; operation?: TelemetryModelOperation }>> = {
  chat: { kind: 'model_call', operation: 'chat' },
  generate_content: { kind: 'model_call', operation: 'chat' },
  text_completion: { kind: 'model_call', operation: 'other' },
  embeddings: { kind: 'model_call', operation: 'embedding' },
  execute_tool: { kind: 'tool_call' },
  invoke_agent: { kind: 'agent_step' },
  create_agent: { kind: 'agent_step' },
};

function genAiModelFacts(builder: EnvelopeBuilder, attrs: Attrs): void {
  const provider = attrs.get('gen_ai.provider.name') ?? attrs.get('gen_ai.system');
  builder.string(provider, ['model', 'provider'], MODEL_RE)
    .string(attrs.get('gen_ai.request.model'), ['model', 'requested'], MODEL_RE)
    .string(attrs.get('gen_ai.response.model'), ['model', 'resolved'], MODEL_RE);
}

function translateGenAiSpan(item: OtlpSpanItem, product: string): OtlpTranslationResult {
  const attrs = new Attrs([item.attributes, item.scope.attributes, item.resource.attributes]);
  const operationName = attrs.str('gen_ai.operation.name');
  let mapping = operationName ? GENAI_OPERATIONS[operationName] : undefined;
  if (!mapping && attrs.get('gen_ai.request.model')) mapping = { kind: 'model_call', operation: 'other' };
  if (!mapping) return refuse(GENAI, 'OTLP_NO_TRANSLATION', 'a GenAI span with no translatable operation');
  const builder = new EnvelopeBuilder(product, GENAI, mapping.kind);
  sourceFacts(builder, item);
  builder.map(attrs.get('gen_ai.operation.name'), ['kind'], mapping.kind);
  spanFacts(builder, item, attrs);
  if (mapping.operation) builder.fixed(['model', 'operation'], mapping.operation);
  genAiModelFacts(builder, attrs);
  builder
    .measurement(attrs.get('gen_ai.usage.input_tokens'), ['usage', 'input_tokens'], 'gen_ai.usage.input_tokens')
    .measurement(attrs.get('gen_ai.usage.output_tokens'), ['usage', 'output_tokens'], 'gen_ai.usage.output_tokens')
    .measurement(attrs.get('gen_ai.usage.cache_read.input_tokens'), ['usage', 'cached_read_tokens'], 'gen_ai.usage.cache_read.input_tokens')
    .measurement(attrs.get('gen_ai.usage.cache_creation.input_tokens'), ['usage', 'cached_write_tokens'], 'gen_ai.usage.cache_creation.input_tokens')
    .map(attrs.get('gen_ai.response.finish_reasons'), ['outcome', 'finish_reasons'], finishReasons(attrs.get('gen_ai.response.finish_reasons')))
    .string(attrs.get('gen_ai.response.id'), ['correlation', 'request_id'], CORRELATION_RE)
    .string(attrs.get('gen_ai.conversation.id'), ['correlation', 'conversation_id'], CORRELATION_RE)
    .string(attrs.get('gen_ai.tool.name'), ['attributes', 'tool.name'], NAME_CLASS)
    .string(attrs.get('gen_ai.tool.call.id'), ['correlation', 'tool_call_id'], CORRELATION_RE)
    .string(attrs.get('gen_ai.agent.name'), ['attributes', 'agent.name'], NAME_CLASS);
  return finish(builder, GENAI, item.startNs);
}

/** `gen_ai.client.token.usage` — a DELTA histogram's sum is the tokens of that window. */
function translateGenAiMetric(item: OtlpMetricItem, product: string): OtlpTranslationResult {
  if (item.metricName !== 'gen_ai.client.token.usage' || item.shape !== 'histogram') {
    return refuse(GENAI, 'OTLP_METRIC_NOT_TRANSLATED', 'this GenAI metric has no Tier-0 home in the envelope');
  }
  if (item.temporality !== 1) {
    return refuse(GENAI, 'OTLP_TEMPORALITY_NOT_TRANSLATED',
      'only DELTA token-usage points are translated; a cumulative point would be summed twice');
  }
  const attrs = new Attrs([item.attributes, item.scope.attributes, item.resource.attributes]);
  const tokenType = attrs.str('gen_ai.token.type');
  const field = tokenType === 'input' ? 'input_tokens' : tokenType === 'output' ? 'output_tokens' : null;
  if (!field) return refuse(GENAI, 'OTLP_METRIC_NOT_TRANSLATED', 'a token-usage point with no input/output token type');
  const builder = new EnvelopeBuilder(product, GENAI, 'usage');
  sourceFacts(builder, item);
  builder.map(attrs.get('gen_ai.token.type'), ['kind'], 'usage');
  genAiModelFacts(builder, attrs);
  const occurred = rfc3339FromNanos(item.timeNs);
  if (occurred) builder.fixed(['occurred_at'], occurred);
  const sum = item.aggregate?.sum;
  if (sum === null || sum === undefined || !Number.isFinite(sum) || sum < 0) {
    return refuse(GENAI, 'OTLP_MEASUREMENT_NOT_EXACT', 'a token-usage point without a finite, non-negative sum is refused');
  }
  builder.fixed(['usage', field], sum);
  const count = item.aggregate?.count;
  if (count !== null && count !== undefined && count <= BigInt(Number.MAX_SAFE_INTEGER)) {
    builder.fixed(['usage', 'requests'], Number(count));
  }
  return finish(builder, GENAI, item.timeNs);
}

// ─────────────────────────────── dispatch ───────────────────────────────────

/**
 * Translate one decoded record for a producer whose product is already known
 * to be declared by the presenting Connector.
 */
export function translateOtlpItem(item: OtlpItem, product: string): OtlpTranslationResult {
  if (product === 'claude-code') {
    if (item.signal === 'logs') return translateClaudeCodeLog(item, product);
    return refuse(CLAUDE_CODE, 'OTLP_CHANNEL_NOT_TRANSLATED',
      `Claude Code ${item.signal === 'metrics' ? 'metric points' : 'spans'} are not translated: its usage, cost and timing `
      + 'are carried by its log events, and storing them twice would double every rollup');
  }
  if (item.signal === 'traces') {
    const attrs = new Attrs([item.attributes]);
    if (attrs.get('openinference.span.kind')) return translateOpenInference(item, product);
    if (attrs.has('gen_ai.')) return translateGenAiSpan(item, product);
    return refuse(null, 'OTLP_NO_TRANSLATION', 'a span with no GenAI or OpenInference attributes');
  }
  if (item.signal === 'metrics') {
    if (item.metricName.startsWith('gen_ai.')) return translateGenAiMetric(item, product);
    return refuse(null, 'OTLP_NO_TRANSLATION', 'a metric with no GenAI translation');
  }
  return refuse(null, 'OTLP_NO_TRANSLATION', 'log records are translated only for a declared product profile');
}

/**
 * The producer's product key: the resource's `service.name`, when it is a
 * well-formed product key. Declared-ness is the receiver's check (§5.2).
 */
export function otlpProductOf(item: OtlpItem): string | null {
  const name = stringOf(item.resource.attributes.get('service.name')?.value);
  return name && PRODUCT_RE.test(name) ? name : null;
}

/** Read a path out of a stored record: present means non-null and, for arrays, non-empty. */
export function recordHas(record: unknown, path: RecordPath): boolean {
  let node: unknown = record;
  for (const segment of path) {
    if (typeof node !== 'object' || node === null) return false;
    node = (node as Record<string, unknown>)[segment];
  }
  if (node === null || node === undefined) return false;
  return !Array.isArray(node) || node.length > 0;
}
