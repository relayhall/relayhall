/**
 * TelemetryEnvelope — the FROZEN canonical envelope `rh.ai.telemetry/1.0`
 * (RH-TW1a, card `beac9c79`).
 *
 * FREEZE AUTHORITY: TELEMETRY-DESIGN v1.4 `7d5c0cdc` §4 declares the freeze
 * conditional on both TW1 entry conditions; ratification sitting `7e7eeca3`
 * satisfied both — TS-3 (the §5.2 outpost credential model, which shapes the
 * `source` block) and TS-5 (Tier 0 only at TW1a, which shapes the policy
 * engine) — and states: "the `rh.ai.telemetry/1.0` envelope freeze is
 * AUTHORIZED." This module is that freeze.
 *
 * VERSIONING (§4.8): v1.x additions are ADDITIVE ONLY. Removing a field,
 * narrowing a vocabulary, or changing a field's meaning is a MAJOR bump and
 * needs its own design act. An unknown MAJOR is rejected at ingest with the
 * accepted-majors advertisement.
 *
 * IDENTITY IS CREDENTIAL-DERIVED, NOT CLIENT-ASSERTED (§4.1). The reference
 * shape in findings `93325601` §4 carries a generic `identity` block; the
 * ratified normative delta REPLACES it with the server-derived principal
 * binding. The block therefore survives here as `identity`, but it is
 * ADVISORY ONLY: it is never trusted for authorization or attribution, and
 * the Tier-0 policy engine keeps only what §6.1 permits of it (pseudonymized
 * human identifiers) and drops the rest. `TelemetryPrincipalBinding` — the
 * authoritative half — is derived from the authenticated chain and is a
 * SEPARATE type on purpose, so that no code path can accidentally read an
 * identifier out of the envelope and into the binding.
 */

/** The frozen schema identifier. */
export const TELEMETRY_ENVELOPE_SCHEMA_VERSION = 'rh.ai.telemetry/1.0';
/** The schema family; a `schema_version` naming a different family is rejected. */
export const TELEMETRY_ENVELOPE_SCHEMA_FAMILY = 'rh.ai.telemetry';
/** Majors this receiver accepts. Advertised in rejections and in discovery (§3.1). */
export const TELEMETRY_ENVELOPE_ACCEPTED_MAJORS: readonly number[] = [1];

/**
 * Byte ceiling for ONE serialized envelope record. Distinct from the C7 frame
 * cap `TELEMETRY_MAX_PAYLOAD_BYTES` (4096) — an envelope legitimately carries
 * usage, timing, correlation and attribute blocks a presence frame never has,
 * and the frame contract is unchanged by this card (design §2.1 item 5).
 */
export const TELEMETRY_ENVELOPE_MAX_BYTES = 65_536;

/** §4.2 kinds. Presence frames are NOT envelope events (§2.1 item 5). */
export const TELEMETRY_ENVELOPE_KINDS = [
  'session', 'turn', 'model_call', 'tool_call', 'agent_step',
  'usage', 'metric', 'audit', 'health', 'error', 'feedback',
] as const;
export type TelemetryEnvelopeKind = (typeof TELEMETRY_ENVELOPE_KINDS)[number];

/**
 * §2.2.2 kind-vocabulary mapping onto the stored `session_events.event_kind`
 * spellings. THREE kinds coincide with the 055 vocabulary and map onto the
 * existing spelling; the other eight get their own spelling, added to the
 * CHECK by migration 111. Nothing maps to `'other'` — funnelling the taxonomy
 * through `'other'` is exactly what §2.2.2 forbids, and
 * `telemetryEnvelope.test.ts` asserts it of every entry.
 */
export const TELEMETRY_ENVELOPE_KIND_TO_EVENT_KIND: Readonly<Record<TelemetryEnvelopeKind, string>> = Object.freeze({
  session: 'session',
  turn: 'turn',
  model_call: 'model_call',
  tool_call: 'tool_call',      // coincides with the 055 spelling
  agent_step: 'agent_step',
  usage: 'usage',              // coincides with the 055 spelling
  metric: 'metric',
  audit: 'audit',
  health: 'health',
  error: 'error',              // coincides with the 055 spelling
  feedback: 'feedback',
});

/** The 055 event-kind vocabulary, as it stood before migration 111. */
export const SESSION_EVENT_KINDS_055 = [
  'message', 'tool_call', 'tool_result', 'usage', 'lifecycle', 'control', 'error', 'other',
] as const;

export const TELEMETRY_ENVELOPE_PHASES = [
  'started', 'running', 'waiting', 'completed', 'failed', 'cancelled', 'unknown',
] as const;
export type TelemetryEnvelopePhase = (typeof TELEMETRY_ENVELOPE_PHASES)[number];

export const TELEMETRY_MODEL_OPERATIONS = [
  'chat', 'responses', 'embedding', 'rerank', 'image', 'audio', 'other',
] as const;
export type TelemetryModelOperation = (typeof TELEMETRY_MODEL_OPERATIONS)[number];

export const TELEMETRY_OUTCOME_STATUSES = [
  'ok', 'error', 'throttled', 'blocked', 'cancelled', 'unknown',
] as const;
export type TelemetryOutcomeStatus = (typeof TELEMETRY_OUTCOME_STATUSES)[number];

/**
 * §4.7 — `reconciled` is reachable ONLY through a reconciliation receipt, so
 * an ingested envelope may never claim it. The validator refuses it.
 */
export const TELEMETRY_COST_BASES = ['provider', 'estimated', 'reconciled'] as const;
export type TelemetryCostBasis = (typeof TELEMETRY_COST_BASES)[number];
export const TELEMETRY_INGESTIBLE_COST_BASES: readonly TelemetryCostBasis[] = ['provider', 'estimated'];

export const TELEMETRY_SOURCE_MECHANISMS = ['push', 'pull', 'scrape'] as const;
export type TelemetrySourceMechanism = (typeof TELEMETRY_SOURCE_MECHANISMS)[number];

/** §8.2 certification ladder rungs; the ladder itself is TW1b/TW1c scope. */
export const TELEMETRY_SUPPORT_LEVELS = ['supported', 'tested', 'experimental'] as const;
export type TelemetrySupportLevel = (typeof TELEMETRY_SUPPORT_LEVELS)[number];

/** §6 policy tiers. TW1a accepts Tier 0 ONLY (sitting ruling TS-5, owner D9). */
export type TelemetryPolicyTier = 0 | 1 | 2;
export const TELEMETRY_TIERS_ACCEPTED_AT_TW1A: readonly TelemetryPolicyTier[] = [0];

/** Descriptor telemetry tiers (ratified strategy §2.6.5; enforced at ingest by candidate B). */
export const TELEMETRY_DESCRIPTOR_TIERS = ['none', 'presence', 'full'] as const;
export type TelemetryDescriptorTier = (typeof TELEMETRY_DESCRIPTOR_TIERS)[number];

export interface TelemetryEnvelopeSource {
  product: string;
  instance_id?: string | null;
  adapter: string;
  adapter_version?: string | null;
  mechanism?: TelemetrySourceMechanism | null;
  support_level?: TelemetrySupportLevel | null;
  last_verified?: string | null;
  /** §6.5.1 governed raw store pointer. Written by candidate C; never client-supplied. */
  raw_ref?: string | null;
}

/**
 * ADVISORY ONLY (§4.1). Never authorization, never attribution. At Tier 0 the
 * policy engine keeps a keyed-HMAC pseudonym of `user_id` and DROPS the
 * structural labels (`tenant_id`, `project_id`, `workspace_id`), which are a
 * Tier-1 surface per §6.2 and therefore unavailable at TW1a.
 */
export interface TelemetryEnvelopeIdentity {
  tenant_id?: string | null;
  user_id?: string | null;
  project_id?: string | null;
  workspace_id?: string | null;
}

export interface TelemetryEnvelopeCorrelation {
  trace_id?: string | null;
  span_id?: string | null;
  parent_span_id?: string | null;
  conversation_id?: string | null;
  session_id?: string | null;
  attempt_id?: string | null;
  request_id?: string | null;
  tool_call_id?: string | null;
}

export interface TelemetryEnvelopeModel {
  provider?: string | null;
  requested?: string | null;
  resolved?: string | null;
  operation?: TelemetryModelOperation | null;
}

export interface TelemetryEnvelopeCost {
  amount?: string | number | null;
  currency?: string | null;
  basis?: TelemetryCostBasis | null;
}

export interface TelemetryEnvelopeUsage {
  input_tokens?: number | null;
  output_tokens?: number | null;
  cached_read_tokens?: number | null;
  cached_write_tokens?: number | null;
  reasoning_tokens?: number | null;
  tool_tokens?: number | null;
  requests?: number | null;
  cost?: TelemetryEnvelopeCost | null;
}

export interface TelemetryEnvelopeTiming {
  duration_ms?: number | null;
  queue_ms?: number | null;
  time_to_first_token_ms?: number | null;
  inter_token_ms?: number | null;
}

export interface TelemetryEnvelopeOutcome {
  status?: TelemetryOutcomeStatus | null;
  finish_reasons?: string[] | null;
  error_type?: string | null;
  /*
   * WITHDRAWN-NARRATIVE: error_fingerprint, error_frames
   *
   * There is deliberately NO `error_fingerprint` and NO `error_frames` here.
   * The fingerprint is a DECLARED NARROWING of §6.1 at TW1a (owner ruling
   * 2026-09-03, in the shape of decision D4): no value derived from
   * reporter-chosen input can satisfy "containing no message-derived bytes",
   * and TW1a has no trusted capture path because the board never observes
   * (F11). Both field names are still RECOGNIZED by the validator so that
   * sending one is refused with the reason rather than silently ignored —
   * see `TELEMETRY_REFUSED_OUTCOME_FIELDS`. The fingerprint returns in TW2.
   */
}

/** §4.6 context accounting — the max-vs-occupied distinction, first-class. */
export interface TelemetryEnvelopeContext {
  max_tokens?: number | null;
  used_tokens?: number | null;
  utilization?: number | null;
  compaction_count?: number | null;
}

export interface TelemetryEnvelopeContent {
  policy_tier?: TelemetryPolicyTier | null;
  prompt_ref?: string | null;
  response_ref?: string | null;
  tool_input_ref?: string | null;
  tool_output_ref?: string | null;
  redactions?: unknown[] | null;
}

/**
 * One `rh.ai.telemetry/1.0` record as a REPORTER sends it. Everything here is
 * untrusted input until `validateTelemetryEnvelope` has run.
 */
export interface TelemetryEnvelope {
  schema_version: string;
  event_id?: string | null;
  /**
   * Receiver clock (§4.4). A reporter MAY send it; the receiver ALWAYS
   * overwrites it with its own clock, so it can never be forged forward.
   */
  observed_at?: string | null;
  /** Source clock, when trustworthy (§4.4). Never silently corrected. */
  occurred_at?: string | null;
  /** §4.3 fallback identity, required when the source has no stable event id. */
  stream_generation?: string | null;
  source_sequence?: string | number | null;
  source: TelemetryEnvelopeSource;
  identity?: TelemetryEnvelopeIdentity | null;
  correlation?: TelemetryEnvelopeCorrelation | null;
  kind: TelemetryEnvelopeKind;
  phase?: TelemetryEnvelopePhase | null;
  model?: TelemetryEnvelopeModel | null;
  usage?: TelemetryEnvelopeUsage | null;
  timing?: TelemetryEnvelopeTiming | null;
  outcome?: TelemetryEnvelopeOutcome | null;
  context?: TelemetryEnvelopeContext | null;
  content?: TelemetryEnvelopeContent | null;
  attributes?: Record<string, unknown> | null;
}

/**
 * The AUTHORITATIVE half of §4.1 — derived from the authenticated credential
 * chain, never from the envelope. Deliberately a different type from
 * `TelemetryEnvelopeIdentity` so that no assignment between the two type-checks.
 *
 * `connectorId` is TOTAL: §5.1 refuses a direct `Account -> Agent` presenter
 * at ingest precisely so that the §4.3 event identity and the §5.3 telemetry
 * source key are total with no fictitious Connector.
 */
export interface TelemetryPrincipalBinding {
  accountId: string;
  connectorId: string;
  /** Authoritative ONLY for a Connector-descended Agent presenter (§4.1 R1-B3). */
  agentId: string | null;
  /** The source's policy tier, resolved from its descriptor. TW1a: 0 only. */
  policyTier: TelemetryPolicyTier;
}
