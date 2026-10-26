/**
 * The client half of the Connector wake protocol on `/events/ws?wake=1` and
 * `?wake=2` (card 6dea3cca; the universal harness connector design, owner
 * ruling E462, section 6). Kept apart from ConnectorWakeService so the socket
 * layer can parse frames without importing the wake dispatcher and its stores.
 *
 * Protocol 1 is exactly what it always was: `implement` wakes only, framed
 * without a kind, and one client frame, `wake.ack`. Protocol 2 adds the wake
 * kinds `verify` and `stuck`, a `kind` field on every wake frame, and one more
 * client frame, `wake.outcome`: what the Connector did with a wake it had
 * already acknowledged (design section 6.7).
 */

/** Largest client frame the socket accepts (an acknowledgement's envelope must fit). */
export const WAKE_ACK_MAX_BYTES = 8192;

/**
 * Client frames one wake socket may hold at once: the one being processed
 * and those waiting behind it. Never below the dispatcher's in-flight wakes
 * per Connector (DEFAULT_WAKE_CONFIG.maxPendingPerEndpoint, asserted in
 * connectorWake.test.ts), so a Connector that answers every outstanding wake
 * at once is not closed for it. One more closes the socket with 1008.
 */
export const WAKE_ACK_QUEUE_LIMIT = 64;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** The wake protocol versions `/events/ws?wake=<n>` accepts. */
export const WAKE_PROTOCOLS = [1, 2] as const;
export type WakeProtocol = (typeof WAKE_PROTOCOLS)[number];

/** Parse the `wake` query value: exactly `1` or `2`, nothing else. */
export function parseWakeProtocol(value: string): WakeProtocol | null {
  if (value === '1') return 1;
  if (value === '2') return 2;
  return null;
}

/**
 * The wake kinds (design section 6.1, choice C7): `implement` is today's go
 * signal; `verify` and `stuck` ring when a Verify or Stuck action item opens
 * for the Connector. Protocol 1 carries `implement` only.
 */
export const WAKE_KINDS = ['implement', 'verify', 'stuck'] as const;
export type WakeKind = (typeof WAKE_KINDS)[number];

/** What a Connector may report it did with an acknowledged wake (section 6.7). */
export const WAKE_TRIGGER_OUTCOMES = ['started', 'refused', 'notified', 'finished'] as const;
export type WakeTriggerOutcome = (typeof WAKE_TRIGGER_OUTCOMES)[number];

/**
 * A trigger reason is a code, never prose: the board writes it into a Task
 * stream entry, so it is held to an upper-case identifier such as
 * `HARNESS_CONFIG_NOT_ISOLATED`.
 */
export const WAKE_TRIGGER_REASON = /^[A-Z][A-Z0-9_]{0,63}$/;

export interface WakeAck {
  wakeId: string;
  telemetry: Record<string, unknown> | null;
}

export interface WakeOutcomeReport {
  wakeId: string;
  outcome: WakeTriggerOutcome;
  /** A code (WAKE_TRIGGER_REASON); required for `refused`, optional otherwise. */
  reason: string | null;
}

export type WakeClientFrame =
  | { type: 'wake.ack'; ack: WakeAck }
  | { type: 'wake.outcome'; report: WakeOutcomeReport };

function closedRecord(raw: string, keys: readonly string[]): Record<string, unknown> | null {
  if (Buffer.byteLength(raw, 'utf8') > WAKE_ACK_MAX_BYTES) return null;
  let value: unknown;
  try { value = JSON.parse(raw); } catch { return null; }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (Object.keys(record).some((key) => !keys.includes(key))) return null;
  return record;
}

/**
 * Parse one client frame. The socket accepts exactly this shape and nothing
 * else: a closed object, `type: "wake.ack"`, a lower-case UUID wake id, and an
 * optional telemetry envelope (validated later by the envelope validator).
 */
export function parseWakeAck(raw: string): WakeAck | null {
  const record = closedRecord(raw, ['type', 'wakeId', 'telemetry']);
  if (!record) return null;
  if (record.type !== 'wake.ack' || typeof record.wakeId !== 'string' || !UUID_RE.test(record.wakeId)) return null;
  const telemetry = record.telemetry;
  if (telemetry !== undefined && telemetry !== null
    && (typeof telemetry !== 'object' || Array.isArray(telemetry))) return null;
  return { wakeId: record.wakeId, telemetry: (telemetry ?? null) as Record<string, unknown> | null };
}

/**
 * Parse a `wake.outcome` frame (protocol 2 only): a closed object,
 * `type: "wake.outcome"`, a lower-case UUID wake id, one of the four outcomes,
 * and a reason code. `refused` must say why; the others may carry a reason or
 * none (absent or null).
 */
export function parseWakeOutcome(raw: string): WakeOutcomeReport | null {
  const record = closedRecord(raw, ['type', 'wakeId', 'outcome', 'reason']);
  if (!record) return null;
  if (record.type !== 'wake.outcome' || typeof record.wakeId !== 'string' || !UUID_RE.test(record.wakeId)) return null;
  if (typeof record.outcome !== 'string'
    || !(WAKE_TRIGGER_OUTCOMES as readonly string[]).includes(record.outcome)) return null;
  const reason = record.reason;
  if (reason !== undefined && reason !== null
    && (typeof reason !== 'string' || !WAKE_TRIGGER_REASON.test(reason))) return null;
  if (record.outcome === 'refused' && (reason === undefined || reason === null)) return null;
  return { wakeId: record.wakeId, outcome: record.outcome as WakeTriggerOutcome, reason: (reason ?? null) as string | null };
}

/** The client frames a wake socket of this protocol accepts: `wake.ack`, and on protocol 2 also `wake.outcome`. */
export function parseWakeClientFrame(raw: string, protocol: WakeProtocol): WakeClientFrame | null {
  const ack = parseWakeAck(raw);
  if (ack) return { type: 'wake.ack', ack };
  if (protocol !== 2) return null;
  const report = parseWakeOutcome(raw);
  return report ? { type: 'wake.outcome', report } : null;
}
