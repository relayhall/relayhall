/**
 * The validate stage of the one normalization entry point (RH-TW1a).
 *
 * The structural allowlist is what makes §6.1's "no prompts, responses, file
 * paths, command arguments, or raw exception messages" ENFORCEABLE: there is
 * no top-level field prose can ride in on. These tests attack that claim from
 * both directions — a legal envelope must pass, and every free-text shape must
 * be refused by NAME, not merely dropped later.
 */
import {
  canonicalJson,
  canonicalPayloadHash,
  parseTelemetrySchemaVersion,
  telemetryAcceptedMajorsAdvertisement,
  telemetryEventIdentityKey,
  validateTelemetryEnvelope,
} from '../utils/telemetryEnvelopeValidator';
import { TELEMETRY_ENVELOPE_MAX_BYTES } from '../types/TelemetryEnvelope';

const CONNECTOR_A = '11111111-1111-4111-8111-111111111111';
const CONNECTOR_B = '22222222-2222-4222-8222-222222222222';

function legal(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schema_version: 'rh.ai.telemetry/1.0',
    event_id: 'evt-0001',
    occurred_at: '2026-09-03T10:00:00Z',
    source: { product: 'claude-code', adapter: 'otlp', adapter_version: '1.2.3', mechanism: 'push' },
    kind: 'model_call',
    phase: 'completed',
    model: { provider: 'anthropic', requested: 'claude-opus-5', operation: 'chat' },
    usage: { input_tokens: 10, output_tokens: 20, cost: { amount: '0.01', currency: 'USD', basis: 'provider' } },
    timing: { duration_ms: 1200 },
    outcome: { status: 'ok' },
    ...overrides,
  };
}

function expectRejected(input: unknown, code: string, field: string) {
  const result = validateTelemetryEnvelope(input);
  expect(result.ok).toBe(false);
  if (result.ok) return;
  expect(result.code).toBe(code);
  expect(result.field).toBe(field);
}

describe('schema version and the accepted-majors advertisement', () => {
  it('accepts the frozen version', () => {
    expect(parseTelemetrySchemaVersion('rh.ai.telemetry/1.0')).toEqual({ major: 1, minor: 0 });
  });

  it('accepts an additive v1.x minor (§4.8 additive-only)', () => {
    const result = validateTelemetryEnvelope(legal({ schema_version: 'rh.ai.telemetry/1.7' }));
    expect(result.ok).toBe(true);
  });

  it('rejects an unknown MAJOR with the advertisement attached (§3.1/§4.8)', () => {
    const result = validateTelemetryEnvelope(legal({ schema_version: 'rh.ai.telemetry/2.0' }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('UNSUPPORTED_SCHEMA_MAJOR');
    expect(result.acceptedMajors).toEqual([1]);
    expect(result.acceptedMajors).toEqual(telemetryAcceptedMajorsAdvertisement().acceptedMajors);
  });

  it('rejects a FOREIGN schema family as invalid, not as an unsupported major', () => {
    // Advertising OUR majors to a sender that meant a different schema would
    // send it round a loop it can never exit.
    expectRejected(legal({ schema_version: 'com.example.telemetry/1.0' }), 'INVALID_ENVELOPE', 'schema_version');
  });
});

describe('the closed structural allowlist', () => {
  it('accepts a legal envelope', () => {
    const result = validateTelemetryEnvelope(legal());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.identityArm).toBe('event_id');
  });

  it('rejects an unknown TOP-LEVEL field', () => {
    expectRejected(legal({ prompt: 'write me a poem about secrets' }), 'INVALID_ENVELOPE', '(root)');
  });

  it('rejects an unknown field inside every nested block', () => {
    expectRejected(legal({ source: { product: 'p', adapter: 'a', command: 'rm -rf /' } }), 'INVALID_ENVELOPE', 'source');
    expectRejected(legal({ outcome: { status: 'error', message: 'ENOENT /home/operator/.ssh/id_ed25519' } }), 'INVALID_ENVELOPE', 'outcome');
    expectRejected(legal({ correlation: { file: '/etc/passwd' } }), 'INVALID_ENVELOPE', 'correlation');
    expectRejected(legal({ timing: { wall_clock: 5 } }), 'INVALID_ENVELOPE', 'timing');
    expectRejected(legal({ context: { transcript: 'x' } }), 'INVALID_ENVELOPE', 'context');
    expectRejected(legal({ model: { system_prompt: 'x' } }), 'INVALID_ENVELOPE', 'model');
    expectRejected(legal({ usage: { tokens: 5 } }), 'INVALID_ENVELOPE', 'usage');
    expectRejected(legal({ identity: { email: 'a@b.com' } }), 'INVALID_ENVELOPE', 'identity');
    expectRejected(legal({ content: { prompt: 'x' } }), 'INVALID_ENVELOPE', 'content');
  });

  it('refuses free text in the identifier-shaped fields', () => {
    // Each of these is a real leak shape: a path, a command line, a message.
    expectRejected(legal({ event_id: '/home/operator/work/session.jsonl' }), 'INVALID_ENVELOPE', 'event_id');
    expectRejected(legal({ source: { product: 'git commit -m "fix the auth bug"', adapter: 'a' } }), 'INVALID_ENVELOPE', 'source.product');
    expectRejected(legal({ outcome: { status: 'error', error_type: 'Error: ENOENT, open /etc/shadow' } }), 'INVALID_ENVELOPE', 'outcome.error_type');
    expectRejected(legal({ correlation: { trace_id: 'here is the user question about their salary' } }), 'INVALID_ENVELOPE', 'correlation.trace_id');
  });

  it('refuses the fingerprint AND its frames input (reviews 696bff8c R2-F2, bc03054d R3-F1)', () => {
    // Round 1 stored a reporter digest verbatim and round 2 re-keyed it; both
    // left the stored value a function of reporter-chosen message bytes. The
    // mechanism is withdrawn: the receiver computes the fingerprint or stores
    // none, so even a well-formed digest is now refused.
    expectRejected(legal({ outcome: { status: 'error', error_fingerprint: 'TypeError: cannot read x of undefined' } }), 'INVALID_ENVELOPE', 'outcome.error_fingerprint');
    expectRejected(legal({ outcome: { status: 'error', error_fingerprint: 'a'.repeat(64) } }), 'INVALID_ENVELOPE', 'outcome.error_fingerprint');
    // R3-F1: `error_frames` existed only to feed the receiver-computed
    // fingerprint, and that mechanism is withdrawn too — so it is refused.
    expectRejected(legal({ outcome: { status: 'error', error_type: 'TypeError', error_frames: ['at f (a.ts:1:1)'] } }),
      'INVALID_ENVELOPE', 'outcome.error_frames');
    // What a reporter CAN still send about an error is the class name.
    const ok = validateTelemetryEnvelope(legal({ outcome: { status: 'error', error_type: 'TypeError' } }));
    expect(ok.ok).toBe(true);
  });

  it('refuses receiver-assigned references supplied by a reporter (§6.5.1)', () => {
    expectRejected(legal({ source: { product: 'p', adapter: 'a', raw_ref: 'blob-of-another-connector' } }), 'INVALID_ENVELOPE', 'source.raw_ref');
    expectRejected(legal({ content: { prompt_ref: 'blob-1' } }), 'INVALID_ENVELOPE', 'content.prompt_ref');
    expectRejected(legal({ content: { tool_output_ref: 'blob-1' } }), 'INVALID_ENVELOPE', 'content.tool_output_ref');
  });

  it("refuses a cost basis of 'reconciled' — receipts are the only path (§4.7)", () => {
    expectRejected(legal({ usage: { cost: { amount: 1, basis: 'reconciled' } } }), 'INVALID_ENVELOPE', 'usage.cost.basis');
  });

  it('refuses an oversized record on its canonical serialization', () => {
    const big = legal({ attributes: { blob: 'x'.repeat(TELEMETRY_ENVELOPE_MAX_BYTES) } });
    expectRejected(big, 'ENVELOPE_TOO_LARGE', '(root)');
  });

  it('accepts the advisory identity block but never promotes it', () => {
    // §4.1: payload identity is ADVISORY. It must be ACCEPTED (real reporters
    // send it) — the refusal to trust it lives in the policy engine and the
    // store, which is where the next two suites check it.
    const result = validateTelemetryEnvelope(legal({ identity: { user_id: 'operator@example.com', project_id: 'relayhall' } }));
    expect(result.ok).toBe(true);
  });
});

describe('§4.3 event identity', () => {
  it('demands a stream sequence when the source has no stable event id', () => {
    const { event_id, ...withoutId } = legal();
    void event_id;
    expectRejected(withoutId, 'MISSING_EVENT_IDENTITY', 'event_id');
    const withSeq = validateTelemetryEnvelope({ ...withoutId, stream_generation: 'gen-7', source_sequence: 42 });
    expect(withSeq.ok).toBe(true);
    if (!withSeq.ok) return;
    expect(withSeq.identityArm).toBe('stream_sequence');
  });

  it('NEVER merges across connectors — the key is connector-namespaced', () => {
    const envelope = validateTelemetryEnvelope(legal());
    expect(envelope.ok).toBe(true);
    if (!envelope.ok) return;
    const a = telemetryEventIdentityKey(CONNECTOR_A, envelope.envelope);
    const b = telemetryEventIdentityKey(CONNECTOR_B, envelope.envelope);
    expect(a.key).not.toBe(b.key);
    expect(a.key.startsWith(`rh.telemetry/1|${CONNECTOR_A}|`)).toBe(true);
    expect(b.key.startsWith(`rh.telemetry/1|${CONNECTOR_B}|`)).toBe(true);
  });

  it('separates two products of the SAME connector', () => {
    const one = validateTelemetryEnvelope(legal());
    const two = validateTelemetryEnvelope(legal({ source: { product: 'gemini-cli', adapter: 'otlp' } }));
    expect(one.ok && two.ok).toBe(true);
    if (!one.ok || !two.ok) return;
    expect(telemetryEventIdentityKey(CONNECTOR_A, one.envelope).key)
      .not.toBe(telemetryEventIdentityKey(CONNECTOR_A, two.envelope).key);
  });

  it('keys the same record identically twice (dedupe is deterministic)', () => {
    const one = validateTelemetryEnvelope(legal());
    const two = validateTelemetryEnvelope(legal());
    expect(one.ok && two.ok).toBe(true);
    if (!one.ok || !two.ok) return;
    expect(telemetryEventIdentityKey(CONNECTOR_A, one.envelope).key)
      .toBe(telemetryEventIdentityKey(CONNECTOR_A, two.envelope).key);
  });

  it('cannot collide the event-id arm with the sequence arm', () => {
    const byId = validateTelemetryEnvelope(legal({ event_id: 'seq' }));
    const bySeq = validateTelemetryEnvelope(legal({ event_id: null, stream_generation: 'gen', source_sequence: 1 }));
    expect(byId.ok && bySeq.ok).toBe(true);
    if (!byId.ok || !bySeq.ok) return;
    expect(telemetryEventIdentityKey(CONNECTOR_A, byId.envelope).key)
      .not.toBe(telemetryEventIdentityKey(CONNECTOR_A, bySeq.envelope).key);
  });
});

describe('canonical hashing', () => {
  it('is stable under key reordering and sensitive to values', () => {
    expect(canonicalJson({ b: 1, a: { d: 2, c: 3 } })).toBe(canonicalJson({ a: { c: 3, d: 2 }, b: 1 }));
    expect(canonicalPayloadHash({ b: 1, a: 2 })).toBe(canonicalPayloadHash({ a: 2, b: 1 }));
    expect(canonicalPayloadHash({ a: 2 })).not.toBe(canonicalPayloadHash({ a: 3 }));
    expect(canonicalPayloadHash({ a: 1 })).toMatch(/^[0-9a-f]{64}$/);
  });
});
