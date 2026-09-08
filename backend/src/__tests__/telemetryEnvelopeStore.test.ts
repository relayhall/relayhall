/**
 * The envelope write path (RH-TW1a) — the ONE normalization entry point.
 *
 * The pool is a capture double, so these tests assert the SQL and the exact
 * parameter vector this module issues. That is enough to pin the properties
 * that live in the STATEMENT (attempt_id NULL, the binding columns, the
 * conflict target). It is NOT enough to prove the database agrees, which is
 * why `backend/scripts/test-telemetry-envelope-migration.js` runs the same
 * insert and the real `progress_sequence` LATERAL against a real PostgreSQL:
 * a double fails only as it is told to.
 */
import { TelemetryEnvelopeStore } from '../services/TelemetryEnvelopeStore';
import {
  resetTelemetryPepperCache, telemetryPseudonym, TELEMETRY_PSEUDONYM_DOMAINS,
} from '../utils/telemetryPepper';
import type { TelemetryPrincipalBinding } from '../types/TelemetryEnvelope';

const ACCOUNT = '00000000-0000-4000-8000-00000000acc7';
const CONNECTOR = '00000000-0000-4000-8000-0000000c0nn3';
const AGENT = '00000000-0000-4000-8000-00000000a63n';
const OBSERVED_AT = new Date('2026-09-03T12:00:00.000Z');

interface Captured { text: string; params: unknown[] }

/**
 * The statement's final `SELECT` always returns exactly ONE row; both columns
 * are NULL when the event lost its `ON CONFLICT`. Modelling that shape — rather
 * than an empty result — is what lets the duplicate arm be tested at all after
 * review `d9697a35` F1 inverted the CTEs.
 */
const WON = [{ event_id: 'evt-row-1', raw_ref: 'rhraw/1:blob' }];
const LOST = [{ event_id: null, raw_ref: null }];

function makeStore(returning: Array<Record<string, unknown>> = WON) {
  const captured: Captured[] = [];
  const pool = {
    query: jest.fn(async (text: string, params?: unknown[]) => {
      captured.push({ text, params: params ?? [] });
      return { rows: returning };
    }),
  };
  return { store: new TelemetryEnvelopeStore(pool as never), captured, pool };
}

function binding(overrides: Partial<TelemetryPrincipalBinding> = {}): TelemetryPrincipalBinding {
  return { accountId: ACCOUNT, connectorId: CONNECTOR, agentId: null, policyTier: 0, ...overrides };
}

function envelope(overrides: Record<string, unknown> = {}) {
  return {
    schema_version: 'rh.ai.telemetry/1.0',
    event_id: 'evt-1',
    kind: 'tool_call',
    source: { product: 'claude-code', adapter: 'otlp' },
    ...overrides,
  };
}

/** Column order of the INSERT, parsed from the statement rather than assumed. */
function columnsOf(text: string): string[] {
  const open = text.indexOf('(', text.indexOf('INSERT INTO session_events'));
  const close = text.indexOf(')', open);
  return text.slice(open + 1, close).split(',').map((c) => c.trim()).filter(Boolean);
}

/** The source list the INSERT draws from, in column order. */
function sourceItemsOf(text: string): string[] {
  const insert = text.indexOf('INSERT INTO session_events');
  expect(insert).toBeGreaterThanOrEqual(0);
  const from = text.indexOf('VALUES', insert);
  expect(from).toBeGreaterThan(insert);
  const open = text.indexOf('(', from);
  const close = text.indexOf(')', open);
  return text.slice(open + 1, close).split(',').map((c) => c.trim()).filter(Boolean);
}

/**
 * The value the statement actually binds to `column`.
 *
 * The mapping is READ OUT OF THE STATEMENT rather than modelled. The source
 * list is walked beside the column list and a `$n` item resolves through the
 * parameter array by its OWN number, so a literal (`NULL::uuid`) resolves to
 * itself and renumbering the parameters — which candidate C did when the
 * raw-blob CTE claimed $1..$9, and again when review `d9697a35` F1 inverted
 * which CTE depends on which — cannot make this helper read the wrong value.
 * The original version carried a hand-counted offset and did exactly that.
 */
function paramFor(captured: Captured, column: string): unknown {
  const columns = columnsOf(captured.text);
  const items = sourceItemsOf(captured.text);
  expect(items.length).toBe(columns.length);
  const index = columns.indexOf(column);
  expect(index).toBeGreaterThanOrEqual(0);
  const item = items[index];
  const placeholder = /^\$(\d+)$/.exec(item);
  if (!placeholder) return item;
  return captured.params[Number(placeholder[1]) - 1];
}

beforeEach(() => {
  process.env.RELAYHALL_TELEMETRY_PEPPERS = JSON.stringify({ a: Buffer.alloc(32, 3).toString('base64') });
  process.env.RELAYHALL_TELEMETRY_ACTIVE_PEPPER = 'a';
  resetTelemetryPepperCache();
});
afterAll(() => {
  delete process.env.RELAYHALL_TELEMETRY_PEPPERS;
  delete process.env.RELAYHALL_TELEMETRY_ACTIVE_PEPPER;
  resetTelemetryPepperCache();
});

describe('the write is attempt-less by construction (§2.2.1, owner decision D1)', () => {
  it('writes attempt_id as a LITERAL NULL, not as a bindable parameter', () => {
    // A parameter could be given a value by a later caller; a literal cannot.
    const { store, captured } = makeStore();
    return store.store(binding(), envelope(), { observedAt: OBSERVED_AT }).then(() => {
      const text = captured[0].text;
      expect(columnsOf(text)[0]).toBe('attempt_id');
      // The property is unchanged and so is its point: `attempt_id` must be a
      // LITERAL, so no caller can ever bind an attempt to an envelope event.
      // The literal is read out of the statement's own source list, wherever
      // candidate C's CTE shuffling happens to have put it.
      expect(sourceItemsOf(text)[0]).toMatch(/^NULL(::uuid)?$/);
      expect(captured[0].params).not.toContain(undefined);
    });
  });

  it('emits an event_kind that CanonicalRuntimeSignalService would count if it were attempt-bound', async () => {
    // The control matters precisely because `tool_call` IS in the
    // progress_sequence kind filter: if a future edit ever supplied an
    // attempt_id here, the count WOULD move. The real-PostgreSQL half of this
    // control lives in scripts/test-telemetry-envelope-migration.js.
    const { store, captured } = makeStore();
    await store.store(binding(), envelope({ kind: 'tool_call' }), { observedAt: OBSERVED_AT });
    expect(paramFor(captured[0], 'event_kind')).toBe('tool_call');
  });
});

describe('identity comes from the BINDING, never from the payload (§4.1)', () => {
  it('ignores a forged payload identity block entirely', async () => {
    const { store, captured } = makeStore();
    await store.store(binding(), envelope({
      identity: { user_id: 'victim@example.com', tenant_id: 'not-my-tenant' },
    }), { observedAt: OBSERVED_AT });
    expect(paramFor(captured[0], 'connector_id')).toBe(CONNECTOR);
    expect(paramFor(captured[0], 'account_id')).toBe(ACCOUNT);
    expect(paramFor(captured[0], 'agent_id')).toBeNull();
    const payload = String(paramFor(captured[0], 'payload'));
    expect(payload).not.toContain('victim@example.com');
    expect(payload).not.toContain('not-my-tenant');
    // The advisory identifier survives ONLY as a pseudonym.
    // R2-F3: an ADDRESS-shaped advisory identifier is pseudonymized in the
    // address domain (folded); an opaque one keeps its bytes in the human
    // domain. The routing is by shape, so this fixture uses the address arm.
    expect(payload).toContain(telemetryPseudonym(TELEMETRY_PSEUDONYM_DOMAINS.emailAddress, 'victim@example.com'));
  });

  it('records agent_id only when the BINDING carries one', async () => {
    const { store, captured } = makeStore();
    await store.store(binding({ agentId: AGENT }), envelope(), { observedAt: OBSERVED_AT });
    expect(paramFor(captured[0], 'agent_id')).toBe(AGENT);
  });

  it('namespaces the idempotency key by the binding connector', async () => {
    const { store, captured } = makeStore();
    await store.store(binding(), envelope(), { observedAt: OBSERVED_AT });
    expect(String(paramFor(captured[0], 'idempotency_key'))).toContain(CONNECTOR);
  });
});

describe('the stored row', () => {
  it('carries the envelope discriminator columns migration 111 requires', async () => {
    const { store, captured } = makeStore();
    await store.store(binding(), envelope({ correlation: { conversation_id: 'conv-9' } }), { observedAt: OBSERVED_AT });
    expect(paramFor(captured[0], 'schema_version')).toBe('rh.ai.telemetry/1.0');
    expect(paramFor(captured[0], 'source_product')).toBe('claude-code');
    expect(paramFor(captured[0], 'policy_tier')).toBe(0);
    expect(paramFor(captured[0], 'observed_at')).toBe(OBSERVED_AT.toISOString());
    expect(String(paramFor(captured[0], 'session_ref'))).toMatch(/^rhp_/);
    expect(paramFor(captured[0], 'redaction_policy_version')).toBe('rh.telemetry.tier0/1.0');
  });

  it('hashes the REDACTED payload it actually stores', async () => {
    const { store, captured } = makeStore();
    await store.store(binding(), envelope(), { observedAt: OBSERVED_AT });
    const hash = String(paramFor(captured[0], 'payload_hash'));
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    const { canonicalPayloadHash } = require('../utils/telemetryEnvelopeValidator');
    expect(hash).toBe(canonicalPayloadHash(JSON.parse(String(paramFor(captured[0], 'payload')))));
  });

  it('dedupes on migration 055\'s own UNIQUE constraint', async () => {
    const { store, captured } = makeStore(LOST);
    const outcome = await store.store(binding(), envelope(), { observedAt: OBSERVED_AT });
    expect(captured[0].text).toContain('ON CONFLICT (idempotency_key) DO NOTHING');
    expect(outcome).toMatchObject({
      accepted: true, duplicate: true, eventId: null, rawRef: null,
    });
  });

  it('reports a fresh insert as not-duplicate', async () => {
    const { store } = makeStore();
    const outcome = await store.store(binding(), envelope(), { observedAt: OBSERVED_AT });
    expect(outcome).toMatchObject({ accepted: true, duplicate: false, eventId: 'evt-row-1', identityArm: 'event_id' });
  });
});

/**
 * WHAT THE CAPTURE DOUBLE CANNOT PROVE (review `bfac1dd5` finding F6), stated
 * here so nobody reads this suite as cross-layer evidence:
 *
 *   - it accepts any statement, so it cannot show PostgreSQL parses it;
 *   - it enforces no constraint, no CHECK, no foreign key and no UNIQUE, so it
 *     cannot show the parameter vector fits the migrated schema;
 *   - its "conflict" is a hand-chosen empty result, not real ON CONFLICT;
 *   - it has no transaction and no concurrency.
 *
 * Every one of those is proven instead by
 * `backend/scripts/test-telemetry-envelope-migration.ts`, which runs THIS
 * store against a real PostgreSQL carrying migrations 055 + 111. What the
 * double is good for is exactly what it is used for below: pinning the SHAPE
 * of the statement and the parameter vector, including the properties a
 * database would happily accept — such as an identifier coming from the
 * binding rather than from the payload.
 */
describe('refusals never reach the database', () => {
  it('refuses a malformed envelope without issuing a query', async () => {
    const { store, pool } = makeStore();
    const outcome = await store.store(binding(), { schema_version: 'rh.ai.telemetry/1.0' }, { observedAt: OBSERVED_AT });
    expect(outcome).toMatchObject({ accepted: false, code: 'INVALID_ENVELOPE' });
    expect(pool.query).not.toHaveBeenCalled();
  });

  it('refuses an unsupported major and carries the advertisement out', async () => {
    const { store, pool } = makeStore();
    const outcome = await store.store(binding(), envelope({ schema_version: 'rh.ai.telemetry/3.0' }), { observedAt: OBSERVED_AT });
    expect(outcome).toMatchObject({ accepted: false, code: 'UNSUPPORTED_SCHEMA_MAJOR', acceptedMajors: [1] });
    expect(pool.query).not.toHaveBeenCalled();
  });

  it('refuses a Tier-1 binding without writing anything (TS-5)', async () => {
    const { store, pool } = makeStore();
    const outcome = await store.store(binding({ policyTier: 1 }), envelope(), { observedAt: OBSERVED_AT });
    expect(outcome).toMatchObject({ accepted: false, code: 'TELEMETRY_TIER_UNAVAILABLE', field: 'policy_tier' });
    expect(pool.query).not.toHaveBeenCalled();
  });

  it('refuses a Tier-2 binding without writing anything (TS-5)', async () => {
    const { store, pool } = makeStore();
    const outcome = await store.store(binding({ policyTier: 2 }), envelope(), { observedAt: OBSERVED_AT });
    expect(outcome).toMatchObject({ accepted: false, code: 'TELEMETRY_TIER_UNAVAILABLE' });
    expect(pool.query).not.toHaveBeenCalled();
  });

  it('redacts BEFORE storing — no unredacted bytes reach the statement', async () => {
    const { store, captured } = makeStore();
    await store.store(binding(), envelope({
      attributes: { 'gen_ai.prompt': 'SECRETPROMPTMARKER' },
    }), { observedAt: OBSERVED_AT });
    expect(JSON.stringify(captured[0].params)).not.toContain('SECRETPROMPTMARKER');
  });
});
