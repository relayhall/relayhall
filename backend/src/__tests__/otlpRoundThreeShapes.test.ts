/**
 * The four round-3 PRODUCTION findings against TW1b candidate A (evidence
 * `aec6ab9f` §13), each made unrepresentable by a terminating shape (§14), and
 * each drilled here with the reviewer's own counterexample. Driven through the
 * PRODUCTION receiver and the PRODUCTION envelope store; only the pool is a
 * double, and it models the one property dedupe rests on — the UNIQUE
 * `idempotency_key`.
 *
 *   X1-R3  a measurement acknowledged must carry its ACTUAL value: no
 *          `toFixed` rounding, no refusal of a value that is exactly storable.
 *   B2-R3  a value the translation DROPS may not influence identity — the key
 *          is derived from the BUILT record (`telemetryRecordIdentity`).
 *   M1-R3  dropped-and-counted is a SUBTRACTION from the decoder's raw count,
 *          so a duplicate key is counted.
 *   M4-R3  the migration replaces only the EXACT predecessor, or raises —
 *          pinned here on the migration text; measured against a real
 *          PostgreSQL by `scripts/test-telemetry-otlp-surfaces-migration.ts`.
 */
import fs from 'fs';
import path from 'path';

const keys = new Set<string>();
const inserts: Array<{ key: string; payload: any }> = [];

jest.mock('../db/connection', () => ({
  pool: {
    query: jest.fn(async (text: string, params?: unknown[]) => {
      if (/INSERT INTO session_events/.test(text)) {
        const key = String((params ?? [])[19]);
        const payload = JSON.parse(String((params ?? [])[16]));
        inserts.push({ key, payload });
        if (keys.has(key)) return { rows: [{ event_id: null, raw_ref: null }], rowCount: 1 };
        keys.add(key);
        return { rows: [{ event_id: `evt-${keys.size}`, raw_ref: `blob-${keys.size}` }], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    }),
  },
}));

// eslint-disable-next-line import/first
import { TelemetryOtlpReceiver } from '../services/otlp/TelemetryOtlpReceiver';
import { telemetryRecordIdentity, telemetryEnvelopeStore } from '../services/TelemetryEnvelopeStore';
import { decodeOtlpJson, decodeOtlpProtobuf, type OtlpSignal } from '../utils/otlp/otlpDecode';
import { encodeOtlpJsonAsProtobuf, jsonLogsExport, jsonTracesExport, loadOtlpFixtures, s, i, d } from './support/otlpFixtures';
import type { TelemetryDescriptorPolicy } from '../services/TelemetryDescriptorPolicy';

const quarantine = { record: jest.fn(async () => ({ stored: true as const, quarantineId: 'q', occurrences: 1 })) };
const receiver = new TelemetryOtlpReceiver(telemetryEnvelopeStore, quarantine as never);
const BINDING = { accountId: 'acc-1', connectorId: '00000000-0000-4000-8000-0000000c0001', agentId: null, policyTier: 0 as const };
const DESCRIPTOR: TelemetryDescriptorPolicy = {
  declared: true, descriptorTier: 'full', policyTier: 0, descriptorVersion: 1,
  products: ['claude-code', 'genai-sample', 'otel-python-sample'],
};
const OBSERVED = new Date('2026-10-19T12:00:00.000Z');

beforeAll(() => {
  process.env.RELAYHALL_TELEMETRY_PEPPERS = JSON.stringify({ t: Buffer.alloc(32, 3).toString('base64') });
  process.env.RELAYHALL_TELEMETRY_ACTIVE_PEPPER = 't';
});
afterAll(() => {
  delete process.env.RELAYHALL_TELEMETRY_PEPPERS;
  delete process.env.RELAYHALL_TELEMETRY_ACTIVE_PEPPER;
});
beforeEach(() => { keys.clear(); inserts.length = 0; quarantine.record.mockClear(); });

async function ingest(signal: OtlpSignal, body: any, encoding: 'json' | 'protobuf' = 'json') {
  const decoded = encoding === 'json' ? decodeOtlpJson(signal, body) : decodeOtlpProtobuf(signal, encodeOtlpJsonAsProtobuf(signal, body));
  return receiver.ingest(BINDING, DESCRIPTOR, decoded, OBSERVED);
}

const apiRequest = (overrides: Array<{ key: string; value: unknown }> = [], extra: Array<{ key?: string; value: unknown }> = []) =>
  jsonLogsExport([
    ...overrides,
    { key: 'event.name', value: s('api_request') },
    { key: 'session.id', value: s('9b2f4c1e-0d3a-4e8b-9c7d-2a1b0c9d8e7f') },
    { key: 'model', value: s('claude-haiku-4-5-20251001') },
    { key: 'input_tokens', value: i(10) },
    { key: 'output_tokens', value: i(173) },
    { key: 'cost_usd', value: d(0.08976100000000001) },
    { key: 'duration_ms', value: i(3118) },
  ].filter((entry, index, all) => all.findIndex((other) => other.key === entry.key) === index).concat(extra as Array<{ key: string; value: unknown }>));

// ──────────────────────────────────── X1-R3 ─────────────────────────────────
describe('X1-R3 — an acknowledged measurement carries its actual value', () => {
  // The reviewer's four finite doubles: two were silently rounded and two were
  // refused purely because a profile chose ten fixed decimal places.
  const REVIEWER_VALUES = [0.1234567890123, 1.23456789015, 1e-11, 1e-20];

  it.each(REVIEWER_VALUES)('stores cost %p exactly, from JSON and from protobuf', async (value) => {
    for (const encoding of ['json', 'protobuf'] as const) {
      keys.clear(); inserts.length = 0;
      const outcome = await ingest('logs', apiRequest([{ key: 'cost_usd', value: d(value) }]), encoding);
      expect(outcome).toMatchObject({ accepted: 1, rejected: 0 });
      const stored = inserts[0].payload;
      expect(stored.usage.cost.amount).toBe(value);
      // The serialized row re-reads to the SAME double.
      expect(JSON.parse(JSON.stringify(stored)).usage.cost.amount).toBe(value);
    }
  });

  it('separates two records whose ONLY difference is a measurement past the tenth decimal', async () => {
    await ingest('logs', apiRequest([{ key: 'cost_usd', value: d(1e-11) }]));
    await ingest('logs', apiRequest([{ key: 'cost_usd', value: d(1e-20) }]));
    expect(new Set(inserts.map((row) => row.key)).size).toBe(2);
  });

  it.each([
    ['NaN', { doubleValue: 'NaN' }],
    ['Infinity', { doubleValue: 'Infinity' }],
    ['an int64 beyond 2^53', { intValue: '9007199254740993' }],
    ['a decimal string that does not round-trip', { stringValue: '0.10' }],
    ['a negative count', { intValue: -5 }],
  ])('REFUSES BY NAME, never rounds: %s', async (_label, value) => {
    const outcome = await ingest('logs', apiRequest([{ key: 'input_tokens', value }]));
    expect(outcome).toMatchObject({ accepted: 0, rejected: 1, rejectedBy: { OTLP_MEASUREMENT_NOT_EXACT: 1 } });
    expect(inserts).toHaveLength(0);
  });

  it('carries a decimal-string count only when it renders back to exactly what was sent', async () => {
    const outcome = await ingest('logs', apiRequest([{ key: 'duration_ms', value: s('242') }]));
    expect(outcome.accepted).toBe(1);
    expect(inserts[0].payload.timing.duration_ms).toBe(242);
  });
});

// ──────────────────────────────────── B2-R3 ─────────────────────────────────
describe('B2-R3 — a dropped value cannot move the identity', () => {
  const span = (overrides: Record<string, unknown>, attributes: Array<{ key: string; value: unknown }> = []) => jsonTracesExport({
    attributes: [
      { key: 'gen_ai.operation.name', value: s('chat') },
      { key: 'gen_ai.provider.name', value: s('openai') },
      { key: 'gen_ai.request.model', value: s('gpt-4o-mini') },
      { key: 'gen_ai.usage.input_tokens', value: i(412) },
      ...attributes,
    ],
    ...overrides,
  });

  // The reviewer's probes: producer NUMBERS whose distinction the translation
  // drops, each formerly passed raw into the id as a "structural part".
  it.each([
    ['span.kind 98 vs 99', 'traces', span({ kind: 98 }), span({ kind: 99 })],
    ['span status code 7 vs 8', 'traces', span({ status: { code: 7 } }), span({ status: { code: 8 } })],
    ['an uncertified attribute', 'traces', span({}, [{ key: 'x.custom', value: s('A') }]), span({}, [{ key: 'x.custom', value: s('B') }])],
    ['a status MESSAGE', 'traces', span({ status: { code: 2, message: 'one' } }), span({ status: { code: 2, message: 'two' } })],
    ['the span NAME', 'traces', span({ name: 'DROP ME A' }), span({ name: 'DROP ME B' })],
    ['a prompt the translation never keeps', 'logs',
      apiRequest([], [{ key: 'prompt', value: s('first secret') }]), apiRequest([], [{ key: 'prompt', value: s('second secret') }])],
    ['log severity 9 vs 10', 'logs',
      (() => { const b = apiRequest(); b.resourceLogs[0].scopeLogs[0].logRecords[0].severityNumber = 9; return b; })(),
      (() => { const b = apiRequest(); b.resourceLogs[0].scopeLogs[0].logRecords[0].severityNumber = 10; return b; })()],
    ['the instrumentation scope name', 'logs',
      (() => { const b = apiRequest(); b.resourceLogs[0].scopeLogs[0].scope.name = 'DROP ME A WITH SPACES'; return b; })(),
      (() => { const b = apiRequest(); b.resourceLogs[0].scopeLogs[0].scope.name = 'DROP ME B WITH SPACES'; return b; })()],
    ['the user ADDRESS (only the account uuid is carried)', 'logs',
      apiRequest([{ key: 'user.account_uuid', value: s('acct-1') }], [{ key: 'user.email', value: s('a@sample.invalid') }]),
      apiRequest([{ key: 'user.account_uuid', value: s('acct-1') }], [{ key: 'user.email', value: s('b@sample.invalid') }])],
  ] as Array<[string, OtlpSignal, any, any]>)('%s: ONE identity, the second is a duplicate', async (_label, signal, first, second) => {
    const a = await ingest(signal, first);
    const b = await ingest(signal, second);
    expect(a).toMatchObject({ accepted: 1, duplicates: 0 });
    expect(b).toMatchObject({ accepted: 0, duplicates: 1 });
    expect(inserts[0].key).toBe(inserts[1].key);
  });

  it.each([
    ['output tokens', 'traces', span({}, []), span({}, [{ key: 'gen_ai.usage.output_tokens', value: i(1) }])],
    ['a carried tool name', 'logs',
      jsonLogsExport([{ key: 'event.name', value: s('tool_result') }, { key: 'tool_name', value: s('Read') }]),
      jsonLogsExport([{ key: 'event.name', value: s('tool_result') }, { key: 'tool_name', value: s('Bash') }])],
    ['the source timestamp', 'logs',
      jsonLogsExport([{ key: 'event.name', value: s('user_prompt') }], { timeUnixNano: '1792414286321000001' }),
      jsonLogsExport([{ key: 'event.name', value: s('user_prompt') }], { timeUnixNano: '1792414286321000002' })],
  ] as Array<[string, OtlpSignal, any, any]>)('a CARRIED difference (%s) separates two records', async (_label, signal, first, second) => {
    await ingest(signal, first);
    await ingest(signal, second);
    expect(inserts).toHaveLength(2);
    expect(inserts[0].key).not.toBe(inserts[1].key);
  });

  it('derives the key from the stored record and nothing else (the signature IS the invariant)', async () => {
    await ingest('logs', apiRequest());
    const stored = inserts[0].payload;
    // Two arguments: the binding-derived connector and the record. No item, no attribute map.
    expect(telemetryRecordIdentity.length).toBe(2);
    expect(telemetryRecordIdentity(BINDING.connectorId, stored).key).toBe(inserts[0].key);
    // The receiver clock, the blob pointer, the redaction COUNTS and the policy
    // block are not facts about the event; changing them leaves the key alone.
    const perturbed = {
      ...stored,
      observed_at: '2030-01-01T00:00:00.000Z',
      source: { ...stored.source, raw_ref: 'another-blob' },
      content: { ...stored.content, redactions: [{ rule: 'attributes_denied_by_default', count: 99 }] },
      policy: { ...stored.policy, pepper_id: 'other' },
    };
    expect(telemetryRecordIdentity(BINDING.connectorId, perturbed).key).toBe(inserts[0].key);
    // ...while any stored FACT moves it.
    expect(telemetryRecordIdentity(BINDING.connectorId, { ...stored, usage: { ...stored.usage, input_tokens: 11 } }).key)
      .not.toBe(inserts[0].key);
  });

  it('is connector-namespaced: one record from two Connectors is two identities', () => {
    const record = { source: { product: 'p', raw_ref: null }, content: { redactions: [] } } as never;
    expect(telemetryRecordIdentity('c-1', record).key).not.toBe(telemetryRecordIdentity('c-2', record).key);
  });
});

// ──────────────────────────────────── M1-R3 ─────────────────────────────────
describe('M1-R3 — dropped and counted is a subtraction from the decoder\'s raw count', () => {
  it('counts a duplicated key within one container as dropped', async () => {
    const once = await ingest('logs', apiRequest());
    keys.clear();
    const twice = await ingest('logs', apiRequest([], [{ key: 'input_tokens', value: i(10) }]));
    // The second export carries the same fields, so `carried` is unchanged,
    // and the one extra producer entry is exactly one extra drop.
    expect(twice.attributesCarried).toBe(once.attributesCarried);
    expect(twice.attributeEntries).toBe(once.attributeEntries + 1);
    expect(twice.attributesDropped).toBe(once.attributesDropped + 1);
  });

  it('counts a keyless entry and a nested kvlist (and its two entries) as dropped', async () => {
    const body = apiRequest([], [
      { value: s('keyless') },
      { key: 'nested', value: { kvlistValue: { values: [{ key: 'a', value: s('x') }, { key: 'b', value: s('y') }] } } },
    ]);
    const outcome = await ingest('logs', body);
    const withoutExtras = await (async () => { keys.clear(); return ingest('logs', apiRequest()); })();
    expect(outcome.attributesCarried).toBe(withoutExtras.attributesCarried);
    expect(outcome.attributesDropped).toBe(withoutExtras.attributesDropped + 4);
  });

  it('counts a value that fails its Tier-0 class as dropped, not carried', async () => {
    // A model name with a space passes no Tier-0 class, so it is never stored.
    const outcome = await ingest('logs', apiRequest([{ key: 'model', value: s('a model with spaces') }]));
    expect(inserts[0].payload.model.resolved).toBeUndefined();
    keys.clear(); inserts.length = 0;
    const clean = await ingest('logs', apiRequest());
    expect(outcome.attributesCarried).toBe(clean.attributesCarried - 1);
  });

  it.each(loadOtlpFixtures().map((f) => [f.name, f] as const))('%s: carried + dropped = the decoder\'s count', async (_n, fixture) => {
    const decoded = fixture.json ? decodeOtlpJson(fixture.signal, fixture.json) : decodeOtlpProtobuf(fixture.signal, fixture.body);
    const outcome = await receiver.ingest(BINDING, DESCRIPTOR, decoded, OBSERVED);
    expect(outcome.attributesCarried + outcome.attributesDropped).toBe(decoded.attributeEntries);
    expect(outcome.attributesDropped).toBeGreaterThanOrEqual(0);
    expect(outcome.accepted + outcome.duplicates + outcome.rejected).toBe(decoded.items.length);
  });
});

// ──────────────────────────────────── M4-R3 ─────────────────────────────────
describe('M4-R3 — migration 163 replaces only the exact predecessor, or raises', () => {
  const sql = fs.readFileSync(path.join(__dirname, '..', 'migrations', '163_telemetry_otlp_rate_surfaces.sql'), 'utf8');
  const code = sql.split('\n').filter((line) => !line.trimStart().startsWith('--')).join('\n');

  it('selects its victim by EXACT definition equality, and by nothing else', () => {
    expect(code).toMatch(/pg_get_constraintdef\(c\.oid\) = predecessor/);
    expect(code).not.toMatch(/\bLIKE\b|\bILIKE\b|~\*?|conkey|attnum|array_length\(conkey/i);
    expect(code.match(/DROP CONSTRAINT/g)).toHaveLength(1);
  });

  it('names the migration-112 predecessor text exactly', () => {
    expect(code).toContain(
      "'CHECK ((surface = ANY (ARRAY[''frames''::text, ''events''::text, ''events_batch''::text])))'");
  });

  it('raises on zero or several matches instead of guessing', () => {
    expect(code).toMatch(/IF COALESCE\(array_length\(matches, 1\), 0\) <> 1 OR successors <> 0 THEN\s+RAISE EXCEPTION/);
  });
});
