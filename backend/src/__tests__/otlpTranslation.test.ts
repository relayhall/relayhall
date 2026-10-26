/**
 * GenAI-semconv, OpenInference and Claude Code translation, replayed from real
 * producer captures (card `dac2ca71`, slice 1; design `7d5c0cdc` §11 TW1b:
 * "validated against Claude Code live AND a second OTLP producer via replayed
 * fixture captures — receiver generality is not proven by one producer").
 *
 * Every expectation that names a measurement READS IT FROM THE CAPTURE — the
 * test never restates a number the producer sent — and every translated
 * envelope is then run through the production validator and the production
 * Tier-0 policy engine, so what is asserted is what would be STORED.
 */
import { decodeOtlpJson, decodeOtlpProtobuf, type OtlpItem } from '../utils/otlp/otlpDecode';
import {
  OTLP_ATTRIBUTE_PROFILE, OTLP_REJECTION_CODES, OTLP_TRANSLATIONS, otlpProductOf, translateOtlpItem,
  type OtlpTranslationResult,
} from '../services/otlp/otlpTranslation';
import { applyTelemetryPolicy, type TelemetryTier0Record } from '../services/TelemetryPolicyEngine';
import { validateTelemetryEnvelope } from '../utils/telemetryEnvelopeValidator';
import { loadOtlpFixtures, type OtlpFixture } from './support/otlpFixtures';
import { isTelemetryPseudonym } from '../utils/telemetryPepper';

beforeAll(() => {
  process.env.RELAYHALL_TELEMETRY_PEPPERS = JSON.stringify({ t: Buffer.alloc(32, 9).toString('base64') });
  process.env.RELAYHALL_TELEMETRY_ACTIVE_PEPPER = 't';
});
afterAll(() => {
  delete process.env.RELAYHALL_TELEMETRY_PEPPERS;
  delete process.env.RELAYHALL_TELEMETRY_ACTIVE_PEPPER;
});

const fixtures = loadOtlpFixtures();
const OBSERVED = new Date('2026-10-19T12:00:00.000Z');

function decode(fixture: OtlpFixture): OtlpItem[] {
  return [...(fixture.json ? decodeOtlpJson(fixture.signal, fixture.json) : decodeOtlpProtobuf(fixture.signal, fixture.body)).items];
}

type Stored =
  | { ok: true; record: TelemetryTier0Record; translated: Extract<OtlpTranslationResult, { ok: true }> }
  | { ok: false; refused: string; translation: string | null };

/** Translate, validate and redact exactly as the receiver does; return the stored record or the refusal. */
function store(item: OtlpItem): Stored {
  const product = otlpProductOf(item);
  if (!product) throw new Error('every capture names its service');
  const translated = translateOtlpItem(item, product);
  if (!translated.ok) return { ok: false, refused: translated.code, translation: translated.translation };
  const valid = validateTelemetryEnvelope(translated.envelope, { identity: 'content_hash' });
  if (!valid.ok) throw new Error(`a translation produced an invalid envelope: ${valid.field} ${valid.message}`);
  const policy = applyTelemetryPolicy(0, translated.envelope, { observedAt: OBSERVED, attributeAllowlist: OTLP_ATTRIBUTE_PROFILE });
  return { ok: true, record: policy.record, translated };
}

const attr = (item: OtlpItem, key: string) => item.attributes.get(key)?.value;
const numberOf = (item: OtlpItem, key: string): number => {
  const value = attr(item, key);
  if (value?.kind === 'double') return value.value;
  if (value?.kind === 'int' && value.value !== null) return Number(value.value);
  if (value?.kind === 'string') return Number(value.value);
  throw new Error(`capture has no number at ${key}`);
};
const stringAt = (item: OtlpItem, key: string): string => {
  const value = attr(item, key);
  if (value?.kind !== 'string') throw new Error(`capture has no string at ${key}`);
  return value.value;
};

describe('Claude Code captures (protobuf and JSON)', () => {
  const claude = fixtures.filter((f) => f.producer === 'claude-code');
  const logs = claude.filter((f) => f.signal === 'logs').flatMap(decode);

  it('has captures in both encodings', () => {
    expect(new Set(claude.map((f) => f.contentType)).size).toBe(2);
  });

  it('carries every api_request as a model_call with the EXACT tokens, cost and duration it sent', () => {
    const requests = logs.filter((item) => stringAt(item, 'event.name') === 'api_request');
    expect(requests.length).toBeGreaterThanOrEqual(4);
    for (const item of requests) {
      const out = store(item);
      if (!out.ok) throw new Error('an api_request was refused');
      const { record } = out;
      expect(record.kind).toBe('model_call');
      expect(record.source).toMatchObject({ product: 'claude-code', adapter: 'otlp.claude-code', mechanism: 'push' });
      expect(record.model).toMatchObject({ provider: 'anthropic', resolved: stringAt(item, 'model'), operation: 'chat' });
      expect(record.usage.input_tokens).toBe(numberOf(item, 'input_tokens'));
      expect(record.usage.output_tokens).toBe(numberOf(item, 'output_tokens'));
      expect(record.usage.cached_read_tokens).toBe(numberOf(item, 'cache_read_tokens'));
      expect(record.usage.cached_write_tokens).toBe(numberOf(item, 'cache_creation_tokens'));
      expect(record.usage.cost).toEqual({ amount: numberOf(item, 'cost_usd'), currency: 'USD', basis: 'estimated' });
      // The stored JSON round-trips the measurement exactly.
      expect(JSON.parse(JSON.stringify(record)).usage.cost.amount).toBe(numberOf(item, 'cost_usd'));
      expect(record.timing.duration_ms).toBe(numberOf(item, 'duration_ms'));
      expect(record.occurred_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{9}Z$/);
      expect(isTelemetryPseudonym(record.correlation.session_id)).toBe(true);
      expect(record.correlation.session_id).not.toBe(stringAt(item, 'session.id'));
    }
  });

  it('carries tool results, decisions, prompts, responses and connections as their own kinds', () => {
    const kinds = new Map<string, string>();
    for (const item of logs) {
      const out = store(item);
      if (out.ok) kinds.set(stringAt(item, 'event.name'), out.record.kind);
    }
    expect(Object.fromEntries(kinds)).toEqual({
      api_request: 'model_call',
      assistant_response: 'turn',
      mcp_server_connection: 'health',
      tool_decision: 'audit',
      tool_result: 'tool_call',
      user_prompt: 'turn',
    });
    const toolResult = logs.find((item) => stringAt(item, 'event.name') === 'tool_result') as OtlpItem;
    const out = store(toolResult);
    expect(out.ok && out.record.attributes['tool.name']).toBe(stringAt(toolResult, 'tool_name'));
  });

  it('refuses its metric points and spans BY NAME, so no request is counted twice', () => {
    const others = claude.filter((f) => f.signal !== 'logs').flatMap(decode);
    expect(others.length).toBeGreaterThan(10);
    for (const item of others) expect(store(item)).toEqual({ ok: false, refused: 'OTLP_CHANNEL_NOT_TRANSLATED', translation: 'otlp.claude-code' });
  });

  it('never stores the addresses, account ids, organization or redacted prompt markers it was sent', () => {
    const stored = JSON.stringify(logs.map(store).map((out) => (out.ok ? out.record : out)));
    for (const item of logs) {
      for (const key of ['user.email', 'user.account_uuid', 'user.account_id', 'organization.id', 'user.id', 'session.id', 'request_id', 'tool_use_id', 'prompt.id']) {
        const value = attr(item, key);
        if (value?.kind === 'string') expect(stored).not.toContain(value.value);
      }
    }
    expect(stored).not.toContain('<REDACTED>');
    expect(stored).not.toMatch(/@sample\.invalid/);
  });
});

describe('the second producer: the OpenTelemetry Python SDK', () => {
  const python = fixtures.filter((f) => f.producer === 'otel-python-sdk');
  const spans = python.filter((f) => f.signal === 'traces').flatMap(decode);

  it('translates GenAI-semconv chat, tool and agent spans', () => {
    const chat = spans.find((item) => stringAt(item, 'gen_ai.operation.name') === 'chat' && attr(item, 'gen_ai.usage.input_tokens')) as OtlpItem;
    const out = store(chat);
    if (!out.ok) throw new Error('the GenAI chat span was refused');
    expect(out.translated.translation).toBe('otlp.genai');
    expect(out.record.kind).toBe('model_call');
    expect(out.record.model).toEqual({
      provider: stringAt(chat, 'gen_ai.provider.name'),
      requested: stringAt(chat, 'gen_ai.request.model'),
      resolved: stringAt(chat, 'gen_ai.response.model'),
      operation: 'chat',
    });
    expect(out.record.usage).toEqual({
      input_tokens: numberOf(chat, 'gen_ai.usage.input_tokens'),
      output_tokens: numberOf(chat, 'gen_ai.usage.output_tokens'),
    });
    expect(out.record.outcome.finish_reasons).toEqual(['stop']);
    expect(out.record.correlation.trace_id).toMatch(/^[0-9a-f]{32}$/);
    expect(out.record.correlation.span_id).toMatch(/^[0-9a-f]{16}$/);
    expect(typeof out.record.timing.duration_ms).toBe('number');

    const tool = store(spans.find((item) => stringAt(item, 'gen_ai.operation.name') === 'execute_tool') as OtlpItem);
    expect(tool.ok && tool.record.kind).toBe('tool_call');
    expect(tool.ok && tool.record.attributes['tool.name']).toBe('get_weather');

    const agent = store(spans.find((item) => stringAt(item, 'gen_ai.operation.name') === 'invoke_agent') as OtlpItem);
    expect(agent.ok && agent.record.kind).toBe('agent_step');
  });

  it('keeps an error span\'s exception TYPE and status, never its message', () => {
    const failed = spans.find((item) => item.signal === 'traces' && item.statusCode === 2) as OtlpItem;
    const out = store(failed);
    if (!out.ok) throw new Error('the failed span was refused');
    expect(out.record.outcome).toMatchObject({ status: 'error', error_type: 'RateLimitError' });
    expect(out.record.phase).toBe('failed');
    expect(JSON.stringify(out.record)).not.toMatch(/Rate limit reached|org-secret|Too many requests/);
  });

  it('translates OpenInference LLM, TOOL and CHAIN spans', () => {
    const llm = spans.find((item) => attr(item, 'openinference.span.kind')?.kind === 'string' && stringAt(item, 'openinference.span.kind') === 'LLM') as OtlpItem;
    const out = store(llm);
    if (!out.ok) throw new Error('the OpenInference LLM span was refused');
    expect(out.translated.translation).toBe('otlp.openinference');
    expect(out.record.kind).toBe('model_call');
    expect(out.record.model).toMatchObject({ resolved: stringAt(llm, 'llm.model_name'), provider: stringAt(llm, 'llm.provider') });
    expect(out.record.usage).toEqual({
      input_tokens: numberOf(llm, 'llm.token_count.prompt'),
      output_tokens: numberOf(llm, 'llm.token_count.completion'),
      cached_read_tokens: numberOf(llm, 'llm.token_count.prompt_details.cache_read'),
    });
    // The advisory user id is pseudonymized; the content attributes are not stored.
    expect(out.record.attributes['advisory.identity.user_id']).toBeDefined();
    expect(JSON.stringify(out.record)).not.toMatch(/secret prompt text|user-1234|temperature/);

    const kinds = spans.filter((item) => attr(item, 'openinference.span.kind')).map((item) => {
      const result = store(item);
      return result.ok ? result.record.kind : result.refused;
    }).sort();
    expect(kinds).toEqual(['agent_step', 'model_call', 'tool_call']);
  });

  it('never stores span names, input/output values, invocation parameters or server addresses', () => {
    const stored = JSON.stringify(spans.map(store).map((out) => (out.ok ? out.record : out)));
    expect(stored).not.toMatch(/What is the weather|Sunny\.|"city"|api\.example\.invalid|RunnableSequence|chat gpt-4o-mini|lookup_weather"\s*:/);
  });

  it('translates a DELTA gen_ai.client.token.usage histogram into usage, and refuses what has no home', () => {
    const points = python.filter((f) => f.signal === 'metrics').flatMap(decode);
    const results = points.map((item) => {
      const out = store(item);
      return out.ok ? { kind: out.record.kind, usage: out.record.usage } : { refused: out.refused };
    });
    expect(results).toEqual(expect.arrayContaining([
      { kind: 'usage', usage: { input_tokens: 412, requests: 1 } },
      { kind: 'usage', usage: { output_tokens: 57, requests: 1 } },
      { refused: 'OTLP_METRIC_NOT_TRANSLATED' },
    ]));
  });

  it('refuses a plain application log record by name', () => {
    const logs = python.filter((f) => f.signal === 'logs').flatMap(decode);
    expect(logs.map(store)).toEqual([{ ok: false, refused: 'OTLP_NO_TRANSLATION', translation: null }]);
  });
});

describe('closed vocabularies', () => {
  it('every refusal any capture produces is a declared code, and every translation a declared id', () => {
    for (const item of fixtures.flatMap(decode)) {
      const out = store(item);
      if (!out.ok) expect(OTLP_REJECTION_CODES).toContain(out.refused);
      else expect(OTLP_TRANSLATIONS).toContain(out.translated.translation);
    }
  });
});
