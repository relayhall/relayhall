/**
 * Owner ruling E462 (universal harness connector design, sections 6.1-6.3 and
 * 6.7): wake protocol 2 measured without a database. The `verify` and `stuck`
 * kinds, their per-kind withdrawal and dedupe, the protocol gate that keeps
 * `?wake=1` exactly as it was, the acknowledgement on a protocol-2 socket and
 * the `wake.outcome` frame. The real-PostgreSQL predicates are proven by
 * connectorWakeKindsDb.integration.test.ts.
 */
import { WebSocket } from 'ws';
import {
  ConnectorWakeService, DEFAULT_WAKE_CONFIG, buildWakeReceipt, triggerAuditWrite, triggerStreamContent,
  wakeKindsOpenedBy, wakeStreamContent, type PendingWake, type WakeAckIdentity,
} from '../services/ConnectorWakeService';
import {
  parseWakeClientFrame, parseWakeOutcome, parseWakeProtocol, WAKE_ACK_MAX_BYTES, WAKE_TRIGGER_REASON,
} from '../utils/connectorWakeProtocol';

const SERVICE = '00000000-0000-4000-8000-0000000000aa';
const PRINCIPAL = '00000000-0000-4000-8000-0000000000bb';
const TASK = '00000000-0000-4000-8000-0000000000cc';
const OTHER_TASK = '00000000-0000-4000-8000-0000000000cd';
const VERIFIER = '00000000-0000-4000-8000-0000000000ee';
const OTHER_VERIFIER = '00000000-0000-4000-8000-0000000000ef';
const WAKE_ID = '7f1c2a9e-3b4d-4e5f-8a6b-1c2d3e4f5a6b';

describe('the protocol', () => {
  test('wake= accepts exactly 1 and 2', () => {
    expect(parseWakeProtocol('1')).toBe(1);
    expect(parseWakeProtocol('2')).toBe(2);
    for (const value of ['0', '3', '02', '2 ', 'true', '']) expect(parseWakeProtocol(value)).toBeNull();
  });

  test('wake.outcome is a closed object with a known outcome and a code reason; refused must say why', () => {
    expect(parseWakeOutcome(JSON.stringify({ type: 'wake.outcome', wakeId: WAKE_ID, outcome: 'started' })))
      .toEqual({ wakeId: WAKE_ID, outcome: 'started', reason: null });
    expect(parseWakeOutcome(JSON.stringify({ type: 'wake.outcome', wakeId: WAKE_ID, outcome: 'refused', reason: 'HARNESS_CONFIG_NOT_ISOLATED' })))
      .toEqual({ wakeId: WAKE_ID, outcome: 'refused', reason: 'HARNESS_CONFIG_NOT_ISOLATED' });
    expect(parseWakeOutcome(JSON.stringify({ type: 'wake.outcome', wakeId: WAKE_ID, outcome: 'finished', reason: null })))
      .toEqual({ wakeId: WAKE_ID, outcome: 'finished', reason: null });
    for (const bad of [
      { type: 'wake.outcome', wakeId: WAKE_ID, outcome: 'refused' },
      { type: 'wake.outcome', wakeId: WAKE_ID, outcome: 'done' },
      { type: 'wake.outcome', wakeId: WAKE_ID, outcome: 'started', reason: 'the harness said: run rm -rf' },
      { type: 'wake.outcome', wakeId: WAKE_ID, outcome: 'started', reason: 'lower_case' },
      { type: 'wake.outcome', wakeId: WAKE_ID, outcome: 'started', extra: 1 },
      { type: 'wake.outcome', wakeId: WAKE_ID.toUpperCase(), outcome: 'started' },
      { type: 'wake.ack', wakeId: WAKE_ID, outcome: 'started' },
    ]) expect(parseWakeOutcome(JSON.stringify(bad))).toBeNull();
    expect(parseWakeOutcome(JSON.stringify({ type: 'wake.outcome', wakeId: WAKE_ID, outcome: 'started', reason: 'A'.repeat(WAKE_ACK_MAX_BYTES) }))).toBeNull();
    expect(WAKE_TRIGGER_REASON.test('A'.repeat(64))).toBe(true);
    expect(WAKE_TRIGGER_REASON.test('A'.repeat(65))).toBe(false);
  });

  test('protocol 1 accepts wake.ack only; protocol 2 also wake.outcome', () => {
    const outcome = JSON.stringify({ type: 'wake.outcome', wakeId: WAKE_ID, outcome: 'started' });
    const ack = JSON.stringify({ type: 'wake.ack', wakeId: WAKE_ID });
    expect(parseWakeClientFrame(outcome, 1)).toBeNull();
    expect(parseWakeClientFrame(outcome, 2)).toEqual({ type: 'wake.outcome', report: { wakeId: WAKE_ID, outcome: 'started', reason: null } });
    expect(parseWakeClientFrame(ack, 1)).toEqual({ type: 'wake.ack', ack: { wakeId: WAKE_ID, telemetry: null } });
    expect(parseWakeClientFrame(ack, 2)).toEqual({ type: 'wake.ack', ack: { wakeId: WAKE_ID, telemetry: null } });
  });
});

describe('which feed events can open an item', () => {
  const task = (name: string, payload: Record<string, unknown> = {}) => ({ name, objectType: 'task' as const, payload });
  test('a move to review, a Verifier change and a review request open Verify; a move to stuck and task.stuck open Stuck', () => {
    expect(wakeKindsOpenedBy(task('task.updated', { status: 'review', previousStatus: 'in-progress', fields: ['status'] }))).toEqual(['verify']);
    expect(wakeKindsOpenedBy(task('task.updated', { fields: ['verifierPrincipalId'] }))).toEqual(['verify']);
    expect(wakeKindsOpenedBy(task('task.review_requested', { reviewId: 'r' }))).toEqual(['verify']);
    expect(wakeKindsOpenedBy(task('task.updated', { status: 'stuck', fields: ['status'] }))).toEqual(['stuck']);
    expect(wakeKindsOpenedBy(task('task.stuck', { reason: 'lease-expired' }))).toEqual(['stuck']);
    expect(wakeKindsOpenedBy(task('task.created', { status: 'review' }))).toEqual(['verify']);
  });
  test('everything else opens nothing', () => {
    expect(wakeKindsOpenedBy(task('task.updated', { fields: ['title'] }))).toEqual([]);
    expect(wakeKindsOpenedBy(task('task.updated', { status: 'completed', fields: ['status'] }))).toEqual([]);
    expect(wakeKindsOpenedBy(task('task.ready'))).toEqual([]);
    expect(wakeKindsOpenedBy({ name: 'report.created', objectType: 'report', payload: {} } as any)).toEqual([]);
  });
});

function wakeOf(overrides: Partial<PendingWake> = {}): PendingWake {
  return {
    wakeId: '11111111-1111-4111-8111-111111111111', kind: 'verify', serviceId: SERVICE, principalId: PRINCIPAL,
    taskId: TASK, feedCursor: '41', attempts: 1, sends: 1, firstSentAt: Date.parse('2026-10-24T12:00:00.000Z'),
    nextAttemptAt: 0, settling: false, occurrence: 'x', verifierPrincipalId: VERIFIER, ...overrides,
  };
}

describe('receipts and entries name the kind', () => {
  const at = Date.parse('2026-10-24T12:00:00.250Z');
  test('a receipt carries its kind, and the implement texts are unchanged', () => {
    expect(buildWakeReceipt(wakeOf(), 'offline', at).kind).toBe('verify');
    expect(wakeStreamContent(buildWakeReceipt(wakeOf({ kind: 'implement' }), 'offline', at)))
      .toBe('The assigned connector had no open notification socket across 1 wake attempts; the task falls back to polling.');
    expect(wakeStreamContent(buildWakeReceipt(wakeOf(), 'acknowledged', at, { acknowledgedAt: at })))
      .toBe('Verify wake acknowledged by the Verifier connector after 1 send in 250 ms; no model identity reported.');
    expect(wakeStreamContent(buildWakeReceipt(wakeOf({ kind: 'stuck' }), 'superseded', at, { taskStatus: 'in-progress' })))
      .toBe('Stuck wake withdrawn before an acknowledgement: the Stuck item closed (status in-progress).');
    expect(wakeStreamContent(buildWakeReceipt(wakeOf(), 'offline', at)))
      .toBe('The Verifier connector had no open wake=2 socket across 1 verify wake attempts; the item stays on its action list.');
  });
  test('a trigger outcome is board text around a code, and its audit row is named by outcome', () => {
    const receipt = {
      wakeId: WAKE_ID, kind: 'implement' as const, outcome: 'refused' as const, reason: 'HARNESS_CONFIG_NOT_ISOLATED',
      serviceId: SERVICE, connectorPrincipalId: PRINCIPAL, taskId: TASK, reportedAt: '2026-10-24T12:00:00.000Z',
    };
    expect(triggerStreamContent(receipt)).toBe('The connector reported that it refused to act on its implement wake (HARNESS_CONFIG_NOT_ISOLATED).');
    expect(triggerAuditWrite(receipt, { handle: 'c', authMethod: 'principal_api_key' })).toEqual({
      action: 'connector.trigger.refused', actor: { handle: 'c', authMethod: 'principal_api_key' },
      resourceType: 'task', resourceId: TASK, outcome: 'success', metadata: { ...receipt },
    });
  });
});

// ── The dispatcher, against fakes for everything but itself ──────────────

class FakeSocket {
  readyState: number = WebSocket.OPEN;
  bufferedAmount = 0;
  frames: any[] = [];
  send(data: string, cb?: () => void): void { this.frames.push(JSON.parse(data)); cb?.(); }
}

function harness(config: Partial<typeof DEFAULT_WAKE_CONFIG> = {}) {
  const now = { value: 1_000_000 };
  const state = {
    feedRows: [] as any[],
    verify: new Map<string, { reasons: string[]; since: string }>(),
    stuck: new Map<string, { status: string; since: string }>(),
    facts: new Map<string, { status: string; verifier_id: string | null; own_work: boolean }>(),
    readable: true,
    audits: [] as any[],
    streams: [] as any[],
    actionCalls: [] as string[][],
  };
  const client = {
    query: jest.fn(async (sql: string, params: any[]) => {
      if (/INSERT INTO task_stream_entries/.test(sql)) state.streams.push({ type: params[1], content: params[2], metadata: params[3] });
      return { rows: [] };
    }),
    release: jest.fn(),
  };
  const pool: any = {
    query: jest.fn(async (sql: string, params: any[]) => {
      // Owner ruling E462 S4b: the Task facts read the chain guard G(Task)
      // (whose SQL also joins services), so they are matched first, by their column.
      if (/AS own_work/.test(sql)) {
        return { rows: (params[0] as string[]).filter((id) => state.facts.has(id)).map((id) => ({ id, ...state.facts.get(id) })) };
      }
      if (/FROM services/.test(sql)) return { rows: [{ id: SERVICE }] };
      if (/FROM feed_events/.test(sql)) return { rows: [{ cursor: '40' }] };
      if (/connector_subtree/.test(sql)) {
        return { rows: (params[0] as string[]).filter((id) => state.facts.has(id)).map((id) => ({ id, ...state.facts.get(id) })) };
      }
      if (/FROM tasks WHERE id = ANY/.test(sql)) return { rows: [] };
      throw new Error(`unexpected query: ${sql}`);
    }),
    connect: jest.fn(async () => client),
  };
  const actor = { principalId: PRINCIPAL, handle: 'laptop', role: 'user', scopes: ['tasks:read'], authenticated: true };
  const service = new ConnectorWakeService(pool, { ...DEFAULT_WAKE_CONFIG, ...config }, {
    clock: () => now.value,
    feed: {
      listSince: async (_actor: any, cursor: string | number, limit = 200) => {
        const events = state.feedRows.filter((row: any) => BigInt(row.cursor) > BigInt(String(cursor))).slice(0, limit);
        return { events, nextCursor: events.length ? events[events.length - 1].cursor : String(cursor) };
      },
    },
    subscribers: { actorForConnector: async () => ({ ok: true, principalId: PRINCIPAL, credentialId: 'cred', actor }) as any },
    audit: { record: jest.fn(async (write: any) => { state.audits.push(write); return {} as any; }) },
    ingestTelemetry: jest.fn() as any,
    actions: {
      openTaskItems: async (_viewer: any, ids: string[]) => {
        state.actionCalls.push(ids);
        return {
          verify: new Map([...state.verify].filter(([id]) => ids.includes(id))),
          stuck: new Map([...state.stuck].filter(([id]) => ids.includes(id))),
        };
      },
    },
    taskScope: () => ({}) as any,
    canReadTask: async () => state.readable,
  });
  return { service, now, state };
}

const IDENTITY: WakeAckIdentity = {
  principalId: PRINCIPAL, handle: 'laptop', credentialId: 'cred-1', delegationLinks: null,
  actor: { principalId: PRINCIPAL, handle: 'laptop', role: 'user', scopes: ['tasks:read'], authenticated: true },
};
const toReview = (cursor: number, taskId = TASK) => ({
  cursor: String(cursor), name: 'task.updated', objectType: 'task', objectId: taskId, occurredAt: '2026-10-24T12:00:00Z',
  payload: { status: 'review', previousStatus: 'in-progress', fields: ['status'] },
});
const stuckEvent = (cursor: number, taskId = TASK) => ({
  cursor: String(cursor), name: 'task.stuck', objectType: 'task', objectId: taskId, occurredAt: '2026-10-24T12:00:00Z',
  payload: { reason: 'lease-expired' },
});
function openVerify(h: ReturnType<typeof harness>, taskId = TASK, verifier = VERIFIER, since = '2026-10-24T12:00:00.000Z') {
  h.state.verify.set(taskId, { reasons: ['verifier'], since });
  h.state.facts.set(taskId, { status: 'review', verifier_id: verifier, own_work: false });
}

describe('wake protocol 2 in the dispatcher', () => {
  test('a protocol-1 endpoint is never evaluated for verify or stuck, and gets no such wake', async () => {
    const h = harness();
    const ws = new FakeSocket();
    await h.service.attach(ws as any, PRINCIPAL);
    openVerify(h);
    h.state.feedRows.push(toReview(41));
    await h.service.runPass();
    expect(h.state.actionCalls).toEqual([]);
    expect(h.service.pendingWakes()).toEqual([]);
    expect(ws.frames).toEqual([]);
  });

  test('a Task entering Review rings its Verifier connector with a kind-bearing frame, on protocol-2 sockets only', async () => {
    const h = harness();
    const v1 = new FakeSocket();
    const v2 = new FakeSocket();
    await h.service.attach(v1 as any, PRINCIPAL, 1);
    await h.service.attach(v2 as any, PRINCIPAL, 2);
    openVerify(h);
    h.state.feedRows.push(toReview(41));
    await h.service.runPass();
    // The scan reads the item, and the attempt re-reads it before it sends (push never exceeds pull).
    expect(h.state.actionCalls).toEqual([[TASK], [TASK]]);
    expect(v2.frames).toEqual([{ type: 'wake', wakeId: expect.any(String), taskId: TASK, kind: 'verify', cursor: '41', attempt: 1 }]);
    expect(v1.frames).toEqual([]);
    // A protocol-1 acknowledgement cannot settle a verify wake.
    expect(await h.service.acknowledge(IDENTITY, { wakeId: v2.frames[0].wakeId, telemetry: null })).toBe(false);
    expect(await h.service.acknowledge(IDENTITY, { wakeId: v2.frames[0].wakeId, telemetry: null }, { socket: v1 as any })).toBe(false);
    expect(await h.service.acknowledge(IDENTITY, { wakeId: v2.frames[0].wakeId, telemetry: null }, { socket: v2 as any })).toBe(true);
    expect(h.state.audits.map((a) => a.action)).toEqual(['connector.wake.acknowledged']);
    expect(h.state.audits[0].metadata).toMatchObject({ kind: 'verify', outcome: 'acknowledged', taskId: TASK });
    expect(h.state.streams[0].content).toContain('Verify wake acknowledged by the Verifier connector');
  });

  test('implement on a protocol-2 endpoint: the v2 socket sees the kind, the v1 socket the unchanged frame', async () => {
    const h = harness();
    const v1 = new FakeSocket();
    const v2 = new FakeSocket();
    (h.service as any).pool.query.mockImplementation(async (sql: string, params: any[]) => {
      if (/FROM services/.test(sql)) return { rows: [{ id: SERVICE }] };
      if (/FROM feed_events/.test(sql)) return { rows: [{ cursor: '40' }] };
      if (/FROM tasks WHERE id = ANY/.test(sql)) return { rows: (params[0] as string[]).map((id) => ({ id })) };
      if (/FROM tasks WHERE id = \$1/.test(sql)) return { rows: [{ status: 'todo', auto_start: true, execution_service_id: SERVICE }] };
      throw new Error(`unexpected query: ${sql}`);
    });
    await h.service.attach(v1 as any, PRINCIPAL, 1);
    await h.service.attach(v2 as any, PRINCIPAL, 2);
    h.state.feedRows.push({ cursor: '41', name: 'task.ready', objectType: 'task', objectId: TASK, occurredAt: 'x', payload: {} });
    await h.service.runPass();
    expect(v1.frames).toEqual([{ type: 'wake', wakeId: expect.any(String), taskId: TASK, cursor: '41', attempt: 1 }]);
    expect(v2.frames).toEqual([{ type: 'wake', wakeId: v1.frames[0].wakeId, taskId: TASK, kind: 'implement', cursor: '41', attempt: 1 }]);
    // Either socket may acknowledge an implement wake, exactly as on protocol 1.
    expect(await h.service.acknowledge(IDENTITY, { wakeId: v1.frames[0].wakeId, telemetry: null })).toBe(true);
  });

  test('only the verifier and native-review reasons ring, and never the Connector\'s own work', async () => {
    const h = harness();
    const ws = new FakeSocket();
    await h.service.attach(ws as any, PRINCIPAL, 2);
    h.state.verify.set(TASK, { reasons: ['no-verifier'], since: '2026-10-24T12:00:00.000Z' });
    h.state.facts.set(TASK, { status: 'review', verifier_id: null, own_work: false });
    h.state.verify.set(OTHER_TASK, { reasons: ['verifier'], since: '2026-10-24T12:00:00.000Z' });
    h.state.facts.set(OTHER_TASK, { status: 'review', verifier_id: VERIFIER, own_work: true });
    h.state.feedRows.push(toReview(41), toReview(42, OTHER_TASK));
    await h.service.runPass();
    expect(h.service.pendingWakes()).toEqual([]);
    h.state.verify.set(TASK, { reasons: ['native-review'], since: '2026-10-24T12:00:01.000Z' });
    h.state.feedRows.push({ cursor: '43', name: 'task.review_requested', objectType: 'task', objectId: TASK, occurredAt: 'x', payload: {} });
    await h.service.runPass();
    expect(h.service.pendingWakes().map((w) => [w.taskId, w.kind])).toEqual([[TASK, 'verify']]);
  });

  test('one wake per (Task, kind, principal): an occurrence already rung is not rung again; a new one is', async () => {
    const h = harness();
    const ws = new FakeSocket();
    await h.service.attach(ws as any, PRINCIPAL, 2);
    openVerify(h);
    h.state.feedRows.push(toReview(41), { cursor: '42', name: 'task.review_requested', objectType: 'task', objectId: TASK, occurredAt: 'x', payload: {} });
    await h.service.runPass();
    expect(h.service.pendingWakes()).toHaveLength(1);
    await h.service.acknowledge(IDENTITY, { wakeId: ws.frames[0].wakeId, telemetry: null }, { socket: ws as any });
    h.state.feedRows.push({ cursor: '43', name: 'task.updated', objectType: 'task', objectId: TASK, occurredAt: 'x', payload: { fields: ['verifierPrincipalId'] } });
    await h.service.runPass();
    expect(h.service.pendingWakes()).toEqual([]);
    // The Task went back to work and returned to Review: a new occurrence rings again.
    openVerify(h, TASK, VERIFIER, '2026-10-24T13:00:00.000Z');
    h.state.feedRows.push(toReview(44));
    await h.service.runPass();
    expect(h.service.pendingWakes()).toHaveLength(1);
  });

  test('verify is withdrawn when the Verifier changes, and when the Task leaves Review', async () => {
    const h = harness();
    const ws = new FakeSocket();
    await h.service.attach(ws as any, PRINCIPAL, 2);
    openVerify(h);
    h.state.feedRows.push(toReview(41));
    await h.service.runPass();
    h.state.facts.set(TASK, { status: 'review', verifier_id: OTHER_VERIFIER, own_work: false });
    h.now.value += 1000;
    await h.service.runPass();
    expect(h.state.audits.map((a) => a.action)).toEqual(['connector.wake.superseded']);
    expect(h.state.audits[0].metadata).toMatchObject({ kind: 'verify', taskStatus: 'review' });
    expect(ws.frames).toHaveLength(1);

    openVerify(h, OTHER_TASK);
    h.state.feedRows.push(toReview(42, OTHER_TASK));
    await h.service.runPass();
    h.state.verify.delete(OTHER_TASK);
    h.state.facts.set(OTHER_TASK, { status: 'in-progress', verifier_id: VERIFIER, own_work: false });
    h.now.value += 1000;
    await h.service.runPass();
    expect(h.state.audits.map((a) => a.action)).toEqual(['connector.wake.superseded', 'connector.wake.superseded']);
    expect(h.state.audits[1].metadata).toMatchObject({ kind: 'verify', taskStatus: 'in-progress' });
  });

  test('stuck rings its addressee and is withdrawn when the item closes', async () => {
    const h = harness();
    const ws = new FakeSocket();
    await h.service.attach(ws as any, PRINCIPAL, 2);
    h.state.stuck.set(TASK, { status: 'in-progress', since: '2026-10-24T12:00:00.000Z' });
    h.state.facts.set(TASK, { status: 'in-progress', verifier_id: null, own_work: true });
    h.state.feedRows.push(stuckEvent(41));
    await h.service.runPass();
    expect(ws.frames).toEqual([{ type: 'wake', wakeId: expect.any(String), taskId: TASK, kind: 'stuck', cursor: '41', attempt: 1 }]);
    h.state.stuck.delete(TASK);
    h.now.value += 1000;
    await h.service.runPass();
    expect(h.state.audits.map((a) => a.action)).toEqual(['connector.wake.superseded']);
    expect(h.state.streams[0].content).toBe('Stuck wake withdrawn before an acknowledgement: the Stuck item closed (status in-progress).');
  });

  test('backpressure, not loss: an event with no room is read again on a later pass', async () => {
    const h = harness({ maxPendingPerEndpoint: 1 });
    const ws = new FakeSocket();
    await h.service.attach(ws as any, PRINCIPAL, 2);
    openVerify(h);
    openVerify(h, OTHER_TASK);
    h.state.feedRows.push(toReview(41), toReview(42, OTHER_TASK));
    await h.service.runPass();
    expect(h.service.pendingWakes().map((w) => w.taskId)).toEqual([TASK]);
    await h.service.acknowledge(IDENTITY, { wakeId: ws.frames[0].wakeId, telemetry: null }, { socket: ws as any });
    await h.service.runPass();
    expect(h.service.pendingWakes().map((w) => w.taskId)).toEqual([OTHER_TASK]);
  });
});

describe('the wake.outcome frame', () => {
  async function acknowledged() {
    const h = harness();
    const ws = new FakeSocket();
    const other = new FakeSocket();
    await h.service.attach(ws as any, PRINCIPAL, 2);
    await h.service.attach(other as any, PRINCIPAL, 2);
    openVerify(h);
    h.state.feedRows.push(toReview(41));
    await h.service.runPass();
    const wakeId = ws.frames[0].wakeId;
    expect(await h.service.acknowledge(IDENTITY, { wakeId, telemetry: null }, { socket: ws as any })).toBe(true);
    h.state.audits.length = 0; h.state.streams.length = 0;
    return { h, ws, other, wakeId };
  }

  test('started then finished, on the acknowledging socket, each write a connector.trigger entry and audit row', async () => {
    const { h, ws, wakeId } = await acknowledged();
    expect(await h.service.recordOutcome(IDENTITY, { wakeId, outcome: 'started', reason: null }, ws as any)).toBe(true);
    expect(await h.service.recordOutcome(IDENTITY, { wakeId, outcome: 'finished', reason: null }, ws as any)).toBe(true);
    expect(h.state.audits.map((a) => [a.action, a.actor.principalId, a.actor.authMethod])).toEqual([
      ['connector.trigger.started', PRINCIPAL, 'principal_api_key'], ['connector.trigger.finished', PRINCIPAL, 'principal_api_key'],
    ]);
    expect(h.state.streams.map((s) => s.type)).toEqual(['connector.trigger', 'connector.trigger']);
    expect(h.state.streams[0].metadata).toMatchObject({ wakeId, kind: 'verify', outcome: 'started', reason: null, taskId: TASK });
    // The wake is over: nothing more is accepted for it.
    expect(await h.service.recordOutcome(IDENTITY, { wakeId, outcome: 'finished', reason: null }, ws as any)).toBe(false);
  });

  test('an outcome from another socket, another principal, out of order, or for an unacknowledged wake records nothing', async () => {
    const { h, ws, other, wakeId } = await acknowledged();
    expect(await h.service.recordOutcome(IDENTITY, { wakeId, outcome: 'started', reason: null }, other as any)).toBe(false);
    expect(await h.service.recordOutcome({ ...IDENTITY, principalId: 'someone-else' }, { wakeId, outcome: 'started', reason: null }, ws as any)).toBe(false);
    expect(await h.service.recordOutcome(IDENTITY, { wakeId, outcome: 'finished', reason: null }, ws as any)).toBe(false);
    expect(await h.service.recordOutcome(IDENTITY, { wakeId: WAKE_ID, outcome: 'started', reason: null }, ws as any)).toBe(false);
    expect(h.state.audits).toEqual([]);
    expect(await h.service.recordOutcome(IDENTITY, { wakeId, outcome: 'refused', reason: 'NO_WARRANT' }, ws as any)).toBe(true);
    expect(await h.service.recordOutcome(IDENTITY, { wakeId, outcome: 'started', reason: null }, ws as any)).toBe(false);
    expect(h.state.audits.map((a) => a.action)).toEqual(['connector.trigger.refused']);
  });

  test('a Connector that can no longer read the Task records nothing, and the wake is forgotten', async () => {
    const { h, ws, wakeId } = await acknowledged();
    h.state.readable = false;
    expect(await h.service.recordOutcome(IDENTITY, { wakeId, outcome: 'started', reason: null }, ws as any)).toBe(false);
    h.state.readable = true;
    expect(await h.service.recordOutcome(IDENTITY, { wakeId, outcome: 'started', reason: null }, ws as any)).toBe(false);
    expect(h.state.audits).toEqual([]);
  });

  test('a closed socket reports nothing for the wakes it acknowledged', async () => {
    const { h, ws, wakeId } = await acknowledged();
    h.service.detach(ws as any, PRINCIPAL);
    expect(await h.service.recordOutcome(IDENTITY, { wakeId, outcome: 'started', reason: null }, ws as any)).toBe(false);
  });
});

// Owner ruling E462 S4b (S4 review folds): the endpoint protocol is derived from
// its open sockets, and the native-review verify occurrence is its review id.
describe('S4b wake folds', () => {
  const { speaksProtocol2, verifyOccurrence } = require('../services/ConnectorWakeService');
  const { WebSocket: WS } = require('ws');
  const socket = (readyState: number) => ({ readyState }) as any;
  test('S4b an endpoint speaks protocol 2 while ANY open socket subscribed with it, whatever subscribed last', () => {
    expect(speaksProtocol2({ sockets: new Map([[socket(WS.OPEN), 2], [socket(WS.OPEN), 1]]) })).toBe(true);
    expect(speaksProtocol2({ sockets: new Map([[socket(WS.OPEN), 1], [socket(WS.OPEN), 2]]) })).toBe(true);
    expect(speaksProtocol2({ sockets: new Map([[socket(WS.OPEN), 1]]) })).toBe(false);
    expect(speaksProtocol2({ sockets: new Map([[socket(WS.CLOSED), 2], [socket(WS.OPEN), 1]]) })).toBe(false);
    expect(speaksProtocol2({ sockets: new Map() })).toBe(false);
  });
  test('S4b a native-review verify occurrence is keyed on its review ids; the Verifier arm keeps its own', () => {
    const since = '2026-10-24T10:00:00.000Z';
    expect(verifyOccurrence({ reasons: ['verifier'], since }, 'v')).toBe(`${since}|v`);
    expect(verifyOccurrence({ reasons: ['native-review'], since, nativeReviewIds: ['r1'] }, 'v')).toBe('review:r1');
    expect(verifyOccurrence({ reasons: ['native-review'], since, nativeReviewIds: ['r2'] }, 'v'))
      .not.toBe(verifyOccurrence({ reasons: ['native-review'], since, nativeReviewIds: ['r1'] }, 'v'));
    expect(verifyOccurrence({ reasons: ['native-review'], since: 'later', nativeReviewIds: ['r1'] }, 'v')).toBe('review:r1');
    expect(verifyOccurrence({ reasons: ['verifier', 'native-review'], since, nativeReviewIds: ['r1'] }, 'v')).toBe(`${since}|v#review:r1`);
  });
});
