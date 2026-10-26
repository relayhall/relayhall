/**
 * Card 6dea3cca — the Connector wake dispatcher and its receipt, measured
 * without a database: retry/backoff, receipt shaping, truthful model identity
 * and the negative outcomes. The real-PostgreSQL rows are proven by
 * connectorWakeDb.integration.test.ts, and the real server process by
 * connectorWakeProcess.integration.test.ts.
 */
import { WebSocket } from 'ws';
import {
  ConnectorWakeService, DEFAULT_WAKE_CONFIG, buildWakeReceipt, modelIdentityOf, reportedIdentityOf,
  wakeAuditWrite, wakeBackoffMs, wakeBudgetMs, wakeStreamContent,
  type PendingWake, type WakeAckIdentity,
} from '../services/ConnectorWakeService';
import { parseWakeAck, WAKE_ACK_MAX_BYTES, WAKE_ACK_QUEUE_LIMIT } from '../utils/connectorWakeProtocol';

const SERVICE = '00000000-0000-4000-8000-0000000000aa';
const PRINCIPAL = '00000000-0000-4000-8000-0000000000bb';
const TASK = '00000000-0000-4000-8000-0000000000cc';
const OTHER_TASK = '00000000-0000-4000-8000-0000000000cd';

describe('backoff and budget', () => {
  test('doubles from the base and caps, so four attempts spend about fifteen seconds', () => {
    expect([1, 2, 3, 4, 5, 9].map((n) => wakeBackoffMs(n))).toEqual([1000, 2000, 4000, 8000, 8000, 8000]);
    expect(wakeBudgetMs()).toBe(15000);
    expect(wakeBackoffMs(0)).toBe(1000);
    expect(wakeBackoffMs(Number.NaN)).toBe(1000);
  });
});

describe('the acknowledgement frame', () => {
  const wakeId = '7f1c2a9e-3b4d-4e5f-8a6b-1c2d3e4f5a6b';
  test('accepts exactly the closed wake.ack shape', () => {
    expect(parseWakeAck(JSON.stringify({ type: 'wake.ack', wakeId }))).toEqual({ wakeId, telemetry: null });
    expect(parseWakeAck(JSON.stringify({ type: 'wake.ack', wakeId, telemetry: { kind: 'session' } })))
      .toEqual({ wakeId, telemetry: { kind: 'session' } });
  });
  test.each([
    ['not json', 'nope'],
    ['an array', JSON.stringify([])],
    ['another type', JSON.stringify({ type: 'events', wakeId })],
    ['an extra key', JSON.stringify({ type: 'wake.ack', wakeId, cursor: '0' })],
    ['an upper-case id', JSON.stringify({ type: 'wake.ack', wakeId: wakeId.toUpperCase() })],
    ['a non-uuid id', JSON.stringify({ type: 'wake.ack', wakeId: 'wake-1' })],
    ['array telemetry', JSON.stringify({ type: 'wake.ack', wakeId, telemetry: [] })],
    ['string telemetry', JSON.stringify({ type: 'wake.ack', wakeId, telemetry: 'x' })],
    ['an oversized frame', JSON.stringify({ type: 'wake.ack', wakeId, telemetry: { pad: 'x'.repeat(WAKE_ACK_MAX_BYTES) } })],
  ])('refuses %s', (_label, raw) => {
    expect(parseWakeAck(raw)).toBeNull();
  });
  test('a wake socket holds at least as many acknowledgements as a Connector can have wakes in flight', () => {
    expect(WAKE_ACK_QUEUE_LIMIT).toBeGreaterThanOrEqual(DEFAULT_WAKE_CONFIG.maxPendingPerEndpoint);
  });
});

describe('truthful model identity', () => {
  const envelope = (model?: Record<string, string>) => ({
    schema_version: 'rh.ai.telemetry/1.0', kind: 'session', phase: 'started', event_id: 'evt-1',
    source: { product: 'hermes', adapter: 'hermes-bridge', adapter_version: '1.2.0' },
    ...(model ? { model } : {}),
  }) as any;

  test('only model.resolved is a provider-reported identity', () => {
    expect(modelIdentityOf({ resolved: 'gpt-5.6-sol-2026-09-01' })).toBe('provider-reported');
    expect(modelIdentityOf({ requested: 'gpt-5.6-sol', provider: 'openai-codex' })).toBe('requested-only');
    expect(modelIdentityOf({ provider: 'openai-codex' })).toBe('not-reported');
    expect(modelIdentityOf(null)).toBe('not-reported');
  });

  test('the reported block copies the envelope and invents nothing', () => {
    expect(reportedIdentityOf(envelope({ provider: 'openai-codex', resolved: 'gpt-5.6-sol-2026-09-01' }))).toEqual({
      kind: 'session', phase: 'started', eventId: 'evt-1',
      source: { product: 'hermes', adapter: 'hermes-bridge', adapterVersion: '1.2.0' },
      model: { provider: 'openai-codex', resolved: 'gpt-5.6-sol-2026-09-01' },
    });
    expect(reportedIdentityOf(envelope()).model).toBeNull();
  });
});

function pendingWake(overrides: Partial<PendingWake> = {}): PendingWake {
  return {
    wakeId: '11111111-1111-4111-8111-111111111111', serviceId: SERVICE, principalId: PRINCIPAL, taskId: TASK,
    feedCursor: '41', attempts: 1, sends: 1, firstSentAt: Date.parse('2026-10-09T12:00:00.000Z'),
    nextAttemptAt: 0, settling: false, kind: 'implement', occurrence: null, verifierPrincipalId: null, ...overrides,
  };
}

describe('receipt shaping', () => {
  const settledAt = Date.parse('2026-10-09T12:00:00.420Z');
  test('an acknowledgement carries latency, the reported identity and the telemetry outcome', () => {
    const reported = {
      kind: 'session', phase: 'started', eventId: 'evt-1',
      source: { product: 'hermes', adapter: 'hermes-bridge', adapterVersion: null },
      model: { provider: 'openai-codex', resolved: 'gpt-5.6-sol-2026-09-01' },
    };
    const receipt = buildWakeReceipt(pendingWake(), 'acknowledged', settledAt, {
      acknowledgedAt: settledAt, reported, telemetry: { stored: true, eventId: 'evt-1', duplicate: false },
    });
    expect(receipt).toMatchObject({
      outcome: 'acknowledged', fallback: null, latencyMs: 420, modelIdentity: 'provider-reported',
      reported, telemetry: { stored: true, eventId: 'evt-1', duplicate: false },
      acknowledgedAt: '2026-10-09T12:00:00.420Z', firstSentAt: '2026-10-09T12:00:00.000Z',
    });
    expect(wakeStreamContent(receipt)).toBe(
      'Wake acknowledged by the assigned connector after 1 send in 420 ms; '
      + 'connector-reported provider model gpt-5.6-sol-2026-09-01 (openai-codex).');
  });

  test('an acknowledgement without telemetry says nothing was reported', () => {
    const receipt = buildWakeReceipt(pendingWake(), 'acknowledged', settledAt, { acknowledgedAt: settledAt });
    expect(receipt.modelIdentity).toBe('not-reported');
    expect(receipt.reported).toBeNull();
    expect(receipt.telemetry).toEqual({ stored: false, stage: 'ack', code: 'NOT_REPORTED' });
    expect(wakeStreamContent(receipt)).toContain('no model identity reported');
  });

  test.each(['unanswered', 'offline', 'superseded'] as const)(
    'a negative outcome (%s) falls back to polling and cannot carry a reported identity or telemetry',
    (outcome) => {
      const receipt = buildWakeReceipt(pendingWake(), outcome, settledAt, {
        // Even if a caller passed these, a negative receipt must not carry them.
        reported: { kind: 'session', phase: null, eventId: null, source: { product: 'x', adapter: 'y', adapterVersion: null }, model: { resolved: 'fabricated' } },
        telemetry: { stored: true, eventId: 'fabricated', duplicate: false },
        acknowledgedAt: settledAt,
        taskStatus: 'in-progress',
      });
      expect(receipt).toMatchObject({
        outcome, fallback: 'polling', reported: null, modelIdentity: 'not-reported', acknowledgedAt: null,
        latencyMs: null, telemetry: { stored: false, stage: 'wake', code: 'NOT_ACKNOWLEDGED' },
      });
      expect(receipt.taskStatus).toBe(outcome === 'superseded' ? 'in-progress' : null);
      expect(JSON.stringify(receipt)).not.toContain('fabricated');
    },
  );

  test('the audit write is attributed and named by outcome', () => {
    const receipt = buildWakeReceipt(pendingWake(), 'offline', settledAt);
    expect(wakeAuditWrite(receipt, { handle: 'system', authMethod: 'system' })).toEqual({
      action: 'connector.wake.offline', actor: { handle: 'system', authMethod: 'system' },
      resourceType: 'task', resourceId: TASK, outcome: 'success', metadata: { ...receipt },
    });
    expect(wakeStreamContent(receipt)).toBe(
      'The assigned connector had no open notification socket across 1 wake attempts; the task falls back to polling.');
  });
});

// ── The dispatcher, against fakes for everything but itself ──────────────

class FakeSocket {
  readyState: number = WebSocket.OPEN;
  bufferedAmount = 0;
  frames: any[] = [];
  send(data: string, cb?: () => void): void { this.frames.push(JSON.parse(data)); cb?.(); }
}

interface Harness {
  service: ConnectorWakeService;
  now: { value: number };
  feedRows: any[];
  task: { status: string; auto_start: boolean; execution_service_id: string | null };
  assigned: Set<string>;
  audits: any[];
  streams: any[];
  ingest: jest.Mock;
  actorOk: { value: boolean };
  listSinceLimits: number[];
}

function harness(config: Partial<typeof DEFAULT_WAKE_CONFIG> = {}): Harness {
  const now = { value: 1_000_000 };
  const state: any = {
    feedRows: [] as any[],
    task: { status: 'todo', auto_start: true, execution_service_id: SERVICE },
    assigned: new Set<string>([TASK, OTHER_TASK]),
    audits: [] as any[],
    streams: [] as any[],
    actorOk: { value: true },
    listSinceLimits: [] as number[],
  };
  const client = {
    query: jest.fn(async (sql: string, params: any[]) => {
      if (/INSERT INTO task_stream_entries/.test(sql)) state.streams.push({ params });
      return { rows: [] };
    }),
    release: jest.fn(),
  };
  const pool: any = {
    query: jest.fn(async (sql: string, params: any[]) => {
      if (/FROM services/.test(sql)) return { rows: [{ id: SERVICE }] };
      if (/FROM feed_events/.test(sql)) return { rows: [{ cursor: '40' }] };
      if (/FROM tasks WHERE id = ANY/.test(sql)) {
        return { rows: (params[0] as string[]).filter((id) => state.assigned.has(id)).map((id) => ({ id })) };
      }
      if (/FROM tasks WHERE id = \$1/.test(sql)) return { rows: [state.task] };
      throw new Error(`unexpected query: ${sql}`);
    }),
    connect: jest.fn(async () => client),
  };
  const ingest = jest.fn(async () => ({
    reported: {
      kind: 'session', phase: 'started', eventId: 'evt-9',
      source: { product: 'hermes', adapter: 'hermes-bridge', adapterVersion: null },
      model: { provider: 'openai-codex', requested: 'gpt-5.6-sol', resolved: 'gpt-5.6-sol-2026-09-01' },
    },
    telemetry: { stored: true, eventId: 'evt-9', duplicate: false },
  }));
  const service = new ConnectorWakeService(pool, { ...DEFAULT_WAKE_CONFIG, ...config }, {
    clock: () => now.value,
    feed: {
      listSince: async (_actor: any, cursor: string | number, limit = 200) => {
        state.listSinceLimits.push(limit);
        const events = state.feedRows.filter((row: any) => BigInt(row.cursor) > BigInt(String(cursor))).slice(0, limit);
        return { events, nextCursor: events.length ? events[events.length - 1].cursor : String(cursor) };
      },
    },
    subscribers: {
      actorForConnector: async () => (state.actorOk.value
        ? { ok: true, principalId: PRINCIPAL, credentialId: 'cred', actor: { principalId: PRINCIPAL, handle: 'hermes', role: 'user', scopes: ['tasks:read'], authenticated: true } }
        : { ok: false, refusal: 'SUBSCRIBER_CREDENTIAL_MISSING' }) as any,
    },
    audit: { record: jest.fn(async (write: any) => { state.audits.push(write); return {} as any; }) },
    ingestTelemetry: ingest as any,
  });
  return { service, now, ingest, ...state };
}

function ready(cursor: number, taskId = TASK): any {
  return { cursor: String(cursor), name: 'task.ready', objectType: 'task', objectId: taskId, occurredAt: '2026-10-09T12:00:00Z' };
}

const IDENTITY: WakeAckIdentity = {
  principalId: PRINCIPAL, handle: 'hermes', credentialId: 'cred-1', delegationLinks: null,
  actor: { principalId: PRINCIPAL, handle: 'hermes', role: 'user', scopes: ['tasks:read', 'telemetry:write'], authenticated: true },
};

async function advance(h: Harness, ms: number): Promise<void> {
  h.now.value += ms;
  await h.service.runPass();
}

describe('the wake dispatcher', () => {
  test('retries with bounded backoff, then records an unanswered receipt and falls back', async () => {
    const h = harness();
    const ws = new FakeSocket();
    expect(await h.service.attach(ws as any, PRINCIPAL)).toEqual({ enabled: true, serviceId: SERVICE });
    h.feedRows.push(ready(41));
    await h.service.runPass();
    for (const step of [999, 1, 1999, 1, 3999, 1, 7999]) await advance(h, step);
    expect(ws.frames.map((frame) => frame.attempt)).toEqual([1, 2, 3, 4]);
    expect(ws.frames[0]).toEqual({ type: 'wake', wakeId: expect.any(String), taskId: TASK, cursor: '41', attempt: 1 });
    expect(h.audits).toEqual([]);
    await advance(h, 1);
    expect(h.audits).toHaveLength(1);
    expect(h.audits[0]).toMatchObject({
      action: 'connector.wake.unanswered', actor: { handle: 'system', authMethod: 'system' },
      resourceType: 'task', resourceId: TASK,
      metadata: { outcome: 'unanswered', attempts: 4, sends: 4, fallback: 'polling', telemetry: { stored: false, code: 'NOT_ACKNOWLEDGED' } },
    });
    expect(h.streams).toHaveLength(1);
    expect(h.streams[0].params[1]).toBe('connector.wake');
    expect(h.streams[0].params[3]).toMatchObject({ outcome: 'unanswered' });
    expect(h.ingest).not.toHaveBeenCalled();
    expect(h.service.pendingWakes()).toEqual([]);
    // Settled means settled: nothing is re-sent afterwards.
    await advance(h, 60000);
    expect(ws.frames).toHaveLength(4);
  });

  test('an offline connector is never sent anything and gets an offline receipt, never telemetry', async () => {
    const h = harness();
    const ws = new FakeSocket();
    await h.service.attach(ws as any, PRINCIPAL);
    h.service.detach(ws as any, PRINCIPAL);
    h.feedRows.push(ready(41));
    await h.service.runPass();
    for (let i = 0; i < 6; i++) await advance(h, 8000);
    expect(ws.frames).toEqual([]);
    expect(h.audits.map((a) => a.action)).toEqual(['connector.wake.offline']);
    expect(h.audits[0].metadata).toMatchObject({ attempts: 4, sends: 0, firstSentAt: null, fallback: 'polling', reported: null });
    expect(h.ingest).not.toHaveBeenCalled();
  });

  test('a connector that reconnects inside the budget is woken on its new socket and acknowledges', async () => {
    const h = harness();
    const first = new FakeSocket();
    await h.service.attach(first as any, PRINCIPAL);
    h.service.detach(first as any, PRINCIPAL);
    h.feedRows.push(ready(41));
    await h.service.runPass();
    const second = new FakeSocket();
    await h.service.attach(second as any, PRINCIPAL);
    await advance(h, 1000);
    expect(second.frames).toHaveLength(1);
    expect(second.frames[0].attempt).toBe(2);
    h.now.value += 250;
    expect(await h.service.acknowledge(IDENTITY, { wakeId: second.frames[0].wakeId, telemetry: { any: 'envelope' } })).toBe(true);
    expect(h.ingest).toHaveBeenCalledWith(IDENTITY, { any: 'envelope' });
    expect(h.audits).toHaveLength(1);
    expect(h.audits[0]).toMatchObject({
      action: 'connector.wake.acknowledged',
      actor: { principalId: PRINCIPAL, handle: 'hermes', authMethod: 'principal_api_key', credentialId: 'cred-1' },
      metadata: {
        outcome: 'acknowledged', attempts: 2, sends: 1, latencyMs: 250, fallback: null,
        modelIdentity: 'provider-reported',
        reported: { model: { provider: 'openai-codex', requested: 'gpt-5.6-sol', resolved: 'gpt-5.6-sol-2026-09-01' } },
        telemetry: { stored: true, eventId: 'evt-9' },
      },
    });
    expect(first.frames).toEqual([]);
  });

  test('acknowledgements that name no wake this principal was sent settle nothing', async () => {
    const h = harness();
    const ws = new FakeSocket();
    await h.service.attach(ws as any, PRINCIPAL);
    h.feedRows.push(ready(41));
    await h.service.runPass();
    const wakeId = ws.frames[0].wakeId;
    expect(await h.service.acknowledge({ ...IDENTITY, principalId: 'someone-else' }, { wakeId, telemetry: null })).toBe(false);
    expect(await h.service.acknowledge(IDENTITY, { wakeId: '22222222-2222-4222-8222-222222222222', telemetry: null })).toBe(false);
    expect(h.audits).toEqual([]);
    expect(await h.service.acknowledge(IDENTITY, { wakeId, telemetry: null })).toBe(true);
    // A second acknowledgement of a settled wake is refused, not double-recorded.
    expect(await h.service.acknowledge(IDENTITY, { wakeId, telemetry: null })).toBe(false);
    expect(h.audits.map((a) => a.action)).toEqual(['connector.wake.acknowledged']);
    expect(h.audits[0].metadata).toMatchObject({ modelIdentity: 'not-reported', reported: null, telemetry: { code: 'NOT_REPORTED' } });
    expect(h.ingest).not.toHaveBeenCalled();
  });

  test('a wake is withdrawn as superseded when the task leaves the ready state for this connector', async () => {
    const h = harness();
    const ws = new FakeSocket();
    await h.service.attach(ws as any, PRINCIPAL);
    h.feedRows.push(ready(41));
    await h.service.runPass();
    h.task.status = 'in-progress';
    await advance(h, 1000);
    expect(h.audits.map((a) => a.action)).toEqual(['connector.wake.superseded']);
    expect(h.audits[0].metadata).toMatchObject({ taskStatus: 'in-progress', fallback: 'polling' });
    expect(ws.frames).toHaveLength(1);
  });

  test('push never exceeds pull: no actor, or no current assignment, rings nobody', async () => {
    const h = harness();
    const ws = new FakeSocket();
    await h.service.attach(ws as any, PRINCIPAL);
    h.actorOk.value = false;
    h.feedRows.push(ready(41));
    await h.service.runPass();
    expect(h.service.pendingWakes()).toEqual([]);
    h.actorOk.value = true;
    h.assigned.clear();
    await h.service.runPass();
    expect(h.service.pendingWakes()).toEqual([]);
    expect(ws.frames).toEqual([]);
    for (let i = 0; i < 4; i++) await advance(h, 8000);
    expect(h.audits).toEqual([]);
  });

  test('a new endpoint starts at the feed head and in-flight wakes apply backpressure, not loss', async () => {
    const h = harness({ maxPendingPerEndpoint: 1 });
    const ws = new FakeSocket();
    h.feedRows.push(ready(39, OTHER_TASK));
    await h.service.attach(ws as any, PRINCIPAL); // head = 40, so cursor 39 is never woken
    h.feedRows.push(ready(41), ready(42, OTHER_TASK));
    await h.service.runPass();
    expect(h.service.pendingWakes().map((w) => w.feedCursor)).toEqual(['41']);
    expect(h.listSinceLimits).toEqual([1]);
    await h.service.acknowledge(IDENTITY, { wakeId: ws.frames[0].wakeId, telemetry: null });
    await h.service.runPass();
    expect(h.service.pendingWakes().map((w) => w.feedCursor)).toEqual(['42']);
  });
});
