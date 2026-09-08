/**
 * telemetryFrames.test.ts — RH-P3.C7: presence/telemetry ingest and the
 * liveness/stuck derivations (strategy §2.6.5, the C5/F11 trim).
 *
 * What these pin, driving the PRODUCTION routes where it matters:
 *  - ZERO SERVER-SIDE EFFECT: an accepted frame writes telemetry_frames
 *    (plus the retention prune) and NOTHING else — no task writes, no lease
 *    renewal, no feed emission;
 *  - each principal writes only its own frames (owner recorded server-side);
 *  - rate and size limits with typed refusals; short retention pruned at
 *    ingest; hostile frames refused with typed 400s;
 *  - liveness derives from frame age on the board clock ('stale' is never
 *    pushed) and the session-status surface prefers fresh frames while
 *    degrading to the canonical runtime signal;
 *  - task.stuck derives from lease expiry OR status staleness, episode-
 *    deduplicated, emitted into the cursor feed in its own transaction;
 *  - ingest requires the ratified `telemetry:write` scope (AUTHZ design
 *    4d961e37, A17.7 / §9.1 — the A12.2 successor, minted at AZ-S6):
 *    structural pins on the scope string, the scope-map rule and the
 *    MINTABLE_SCOPES entry, with every other /telemetry path failing
 *    closed to `root`, plus two-principal self-frames enforcement.
 */
import express from 'express';
import type { AddressInfo } from 'net';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const db = {
  statements: [] as Array<{ text: string; params?: unknown[] }>,
  frameRows: [] as any[],
  insertError: null as null | { code: string },
  /**
   * D6: the interval gate moved OUT of a per-process Map and into
   * `telemetry_rate_limits`, so this double now models that table. The gate is
   * one conditional upsert that returns a row only when it wins — which is
   * exactly what is modelled here, keyed by (principal, surface) so the
   * "a different principal is unaffected" case still means what it meant.
   *
   * A double decides only what it is told to. The property that MATTERS about
   * the real gate — that two concurrent clients cannot both win — cannot be
   * shown here at all, and is proven instead against a real PostgreSQL by
   * `backend/scripts/test-telemetry-receiver-limits.ts`.
   */
  rateLimits: new Map<string, number>(),
};

jest.mock('../db/connection', () => ({
  pool: {
    query: ((globalThis as any).__telemetryPoolQuery = jest.fn(async (text: string, params?: unknown[]) => {
      db.statements.push({ text, params });
      // ---- the D6 gate, now a CTE INSIDE the frame INSERT --------------
      // One statement: the gate and the write are the same query, so this
      // double answers them together. It is a MODEL of PostgreSQL, not
      // PostgreSQL — it cannot show the atomicity, or the absence of a lock
      // outliving the statement, that the shape actually buys. Those are
      // proven against a real database by
      // backend/scripts/test-telemetry-receiver-limits.ts, which drives
      // TelemetryService.ingest itself under a bounded timeout.
      const gateDecision = (): { accepted: boolean; key: string; now: number } => {
        const [principalId, surface, nowIso, intervalMs] = (params ?? []) as string[];
        const key = `${principalId}|${surface}`;
        const at = new Date(nowIso).getTime();
        const last = db.rateLimits.get(key);
        return { accepted: !(last !== undefined && at - last < Number(intervalMs)), key, now: at };
      };

      if (/gate AS/.test(text) && /INSERT INTO telemetry_frames/.test(text)) {
        const d = gateDecision();
        if (!d.accepted) return { rows: [], rowCount: 0 };   // refused: nothing written
        if (db.insertError) {
          // The whole statement aborts, so the gate update goes with it —
          // which is precisely why the budget must be untouched afterwards.
          const err: any = new Error('fk');
          err.code = db.insertError.code;
          throw err;
        }
        db.rateLimits.set(d.key, d.now);
        return { rows: [{ received_at: '2026-08-22T02:00:00.000Z' }], rowCount: 1 };
      }
      if (/gate AS/.test(text)) {                    // the standalone gate
        const d = gateDecision();
        if (!d.accepted) return { rows: [], rowCount: 0 };
        db.rateLimits.set(d.key, d.now);
        return { rows: [{ won: 1 }], rowCount: 1 };
      }
      if (/FROM telemetry_frames/.test(text)) return { rows: db.frameRows };
      if (/UPDATE telemetry_rate_limits/.test(text)) {
        const [principalId, surface] = (params ?? []) as string[];
        const last = db.rateLimits.get(`${principalId}|${surface}`);
        return {
          rows: last === undefined ? [] : [{ last_accepted_at: new Date(last).toISOString() }],
          rowCount: last === undefined ? 0 : 1,
        };
      }
      if (/DELETE FROM telemetry_rate_limits/.test(text)) return { rows: [], rowCount: 0 };

      return { rows: [], rowCount: 0 };
    })),
    // No client is handed out any more: the gate and the write are ONE
    // statement on the pool, so `ingest` never opens a transaction (R3-B1).
    connect: jest.fn(),
  },
}));
jest.mock('../services/CanonicalRuntimeSignalService', () => ({
  canonicalRuntimeSignalService: { listTaskSignals: jest.fn(async () => [{ state: 'idle' }]) },
}));
jest.mock('../services/TaskManagerDB', () => {
  const actual = jest.requireActual('../services/TaskManagerDB');
  return {
    ...actual,
    taskManagerDB: {
      getTask: jest.fn(async (id: string) => ({
        id, title: 'Liveness probe', status: 'in-progress',
        created: '2026-08-01T00:00:00.000Z', updatedAt: '2026-08-21T00:00:00.000Z',
        subtasks: [], tags: [],
      })),
      queryLinkedReports: jest.fn(async () => []),
      getBlockingTasks: jest.fn(async () => []),
    },
  };
});
jest.mock('../services/ReportManager', () => ({ reportManager: { getBriefProjections: jest.fn(async () => []) } }));
jest.mock('../services/AuthorizationRepository', () => ({
  authorizationRepository: { authorizedIds: jest.fn(async () => new Set()) },
}));
jest.mock('../services/taskAnalyzer', () => ({ taskAnalyzer: {} }));
jest.mock('../services/NotificationManager', () => ({ notificationManager: {} }));
jest.mock('../services/TaskReviewerService', () => ({ taskReviewerService: {} }));
jest.mock('../services/TaskOrchestrationService', () => ({
  taskOrchestrationService: {},
  OrchestrationConflictError: class extends Error { },
}));
jest.mock('../services/DiscordThreadService', () => ({ discordThreadService: {} }));
jest.mock('../services/TaskHistoryService', () => ({ taskHistoryService: { recordChange: jest.fn() } }));
jest.mock('../services/TaskNotificationService', () => ({ taskNotificationService: {} }));
jest.mock('../services/PrincipalService', () => ({ principalService: {} }));
jest.mock('../services/UnifiedTaskTimeline', () => ({ unifiedTaskTimeline: {}, decodeCursor: jest.fn() }));
jest.mock('../middleware/sharedAuthorization', () => ({
  filterAuthorizedResources: jest.fn(async (_req: unknown, _verb: unknown, rows: unknown[]) => rows),
  actorFromRequest: jest.fn((req: any) => ({
    principalId: req.principal?.id ?? null, handle: req.userId ?? '', role: null,
    scopes: req.scopes ?? null, authenticated: Boolean(req.userId),
  })),
}));

import telemetryRouter from '../routes/telemetry';
import tasksRouter from '../routes/tasks';
import {
  TelemetryService,
  telemetryService,
  deriveStuckReason,
  TELEMETRY_STALE_MS,
  TASK_STUCK_STALE_MINUTES,
} from '../services/TelemetryService';
import { requiredScopeFor, scopesSatisfy, ALL_SCOPES, MINTABLE_SCOPES } from '../utils/scopeMap';

const TASK_ID = '11111111-1111-4111-8111-111111111111';
const PRINCIPAL = { id: '99999999-9999-4999-8999-999999999999', handle: 'reporter-svc' };
const identity = { principal: { ...PRINCIPAL } };

let server: ReturnType<typeof express.application.listen>;
let base: string;

beforeAll((done) => {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).principal = identity.principal;
    (req as any).scopes = ['root'];
    (req as any).userId = identity.principal?.handle;
    next();
  });
  app.use('/telemetry', telemetryRouter);
  app.use('/tasks', tasksRouter);
  server = app.listen(0, () => {
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    done();
  });
});
afterAll((done) => { server.close(() => done()); });
beforeEach(() => {
  db.statements.length = 0;
    db.rateLimits.clear();
  db.frameRows = [];
  db.insertError = null;
  identity.principal = { ...PRINCIPAL };
});

const postFrame = async (body: unknown) => {
  const response = await fetch(`${base}/telemetry/frames`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  return { status: response.status, body: (await response.json()) as any };
};

describe('POST /telemetry/frames — ingest', () => {
  test('an accepted heartbeat writes ONLY telemetry_frames (+ the retention prune) — zero server-side effect', async () => {
    const { status, body } = await postFrame({ kind: 'heartbeat', taskId: TASK_ID });
    expect(status).toBe(200);
    expect(body.accepted).toBe(true);
    const writes = db.statements.filter(s => /INSERT|UPDATE|DELETE/i.test(s.text));
    expect(writes.some(s => /INSERT INTO telemetry_frames/.test(s.text))).toBe(true);
    // Nothing else moved: no task write, no lease renewal, no feed emission.
    expect(writes.filter(s =>
      /tasks|task_execution_leases|feed_events/i.test(s.text)
      && !/telemetry_frames/.test(s.text))).toEqual([]);
    // The frame's owner is the CALLING principal, recorded server-side.
    const insert = db.statements.find(s => /INSERT INTO telemetry_frames/.test(s.text))!;
    expect(insert.params?.[0]).toBe(PRINCIPAL.id);
    // Short retention pruned opportunistically at ingest.
    expect(db.statements.some(s => /DELETE FROM telemetry_frames/.test(s.text))).toBe(true);
  });

  test('hostile frames are refused with typed 400s', async () => {
    for (const frame of [
      { kind: 'bogus' },
      { kind: 'status' },                                  // status missing
      { kind: 'status', status: 'stale' },                 // derived words cannot be pushed
      { kind: 'heartbeat', status: 'active' },             // heartbeat carries no status
      { kind: 'heartbeat', extra: 'field' },
      { kind: 'heartbeat', taskId: 'not-a-uuid' },
      { kind: 'heartbeat', payload: ['array'] },
    ]) {
      const { status, body } = await postFrame(frame);
      expect(status).toBe(400);
      expect(body.code).toMatch(/INVALID_FRAME|PRINCIPAL_REQUIRED/);
    }
  });

  test('an oversized payload is a typed 413 and never lands', async () => {
    const { status, body } = await postFrame({ kind: 'heartbeat', payload: { blob: 'x'.repeat(5000) } });
    expect(status).toBe(413);
    expect(body.code).toBe('PAYLOAD_TOO_LARGE');
    expect(db.statements.some(s => /INSERT INTO telemetry_frames/.test(s.text))).toBe(false);
  });

  test('the per-principal rate limit answers 429; a different principal is unaffected', async () => {
    // A fresh principal: the singleton's rate map is per-principal state.
    identity.principal = { id: '66666666-6666-4666-8666-666666666666', handle: 'rate-svc' };
    const first = await postFrame({ kind: 'heartbeat' });
    expect(first.status).toBe(200);
    const second = await postFrame({ kind: 'heartbeat' });
    expect(second.status).toBe(429);
    expect(second.body.code).toBe('RATE_LIMITED');
    identity.principal = { id: '88888888-8888-4888-8888-888888888888', handle: 'other-svc' };
    const other = await postFrame({ kind: 'heartbeat' });
    expect(other.status).toBe(200);
  });

  test('a frame naming no Task is a typed 400, mapped from the FK refusal', async () => {
    identity.principal = { id: '77777777-7777-4777-8777-777777777777', handle: 'fk-svc' };
    db.insertError = { code: '23503' };
    const { status, body } = await postFrame({ kind: 'heartbeat', taskId: TASK_ID });
    expect(status).toBe(400);
    expect(body.code).toBe('TASK_NOT_FOUND');
  });

  test('an unresolved principal cannot file frames', async () => {
    identity.principal = null as never;
    const { status, body } = await postFrame({ kind: 'heartbeat' });
    expect(status).toBe(400);
    expect(body.code).toBe('PRINCIPAL_REQUIRED');
  });

  test('ingest requires telemetry:write; every other /telemetry path fails closed to root (A17.7/§9.1 structural pins)', () => {
    // The scope string is ratified vocabulary AND mintable at AZ-S6.
    expect((ALL_SCOPES as string[]).includes('telemetry:write')).toBe(true);
    expect((MINTABLE_SCOPES as string[]).includes('telemetry:write')).toBe(true);
    // No telemetry:read exists until a dedicated read surface does.
    expect((ALL_SCOPES as string[]).includes('telemetry:read')).toBe(false);
    // The scope-map rule: exactly the ingest route, spelling-immune.
    expect(requiredScopeFor('POST', '/telemetry/frames')).toBe('telemetry:write');
    expect(requiredScopeFor('POST', '/telemetry/frames/')).toBe('telemetry:write');
    expect(requiredScopeFor('POST', '/telemetry/FRAMES')).toBe('telemetry:write');
    // Everything else in the family is unmapped and fails closed.
    expect(requiredScopeFor('GET', '/telemetry/frames')).toBe('root');
    expect(requiredScopeFor('GET', '/telemetry')).toBe('root');
    expect(requiredScopeFor('POST', '/telemetry')).toBe('root');
    expect(requiredScopeFor('DELETE', '/telemetry/frames')).toBe('root');
    expect(requiredScopeFor('POST', '/telemetry/frames/sub')).toBe('root');
    // Satisfaction is exact: telemetry:write or root, never a neighbour verb.
    expect(scopesSatisfy(['telemetry:write'], 'telemetry:write')).toBe(true);
    expect(scopesSatisfy(['root'], 'telemetry:write')).toBe(true);
    for (const held of ['tasks:write', 'tasks:read', 'services:write', 'services:invoke', 'audit:read']) {
      expect(scopesSatisfy([held], 'telemetry:write')).toBe(false);
    }
    expect(scopesSatisfy(['telemetry:write'], 'tasks:write')).toBe(false);
    expect(scopesSatisfy(['telemetry:write'], 'root')).toBe(false);
  });
});

describe('POST /telemetry/frames — two-principal self-frames enforcement (A17.7)', () => {
  const PRINCIPAL_B = { id: '55555555-5555-4555-8555-555555555555', handle: 'second-svc' };

  test('each caller’s frame is recorded under ITS OWN principal id, never another', async () => {
    identity.principal = { id: '44444444-4444-4444-8444-444444444444', handle: 'first-svc' };
    await postFrame({ kind: 'heartbeat' });
    const firstInsert = db.statements.find(s => /INSERT INTO telemetry_frames/.test(s.text))!;
    expect(firstInsert.params?.[0]).toBe('44444444-4444-4444-8444-444444444444');

    db.statements.length = 0;
    identity.principal = { ...PRINCIPAL_B };
    await postFrame({ kind: 'status', status: 'active' });
    const secondInsert = db.statements.find(s => /INSERT INTO telemetry_frames/.test(s.text))!;
    expect(secondInsert.params?.[0]).toBe(PRINCIPAL_B.id);
    expect(secondInsert.params).not.toContain('44444444-4444-4444-8444-444444444444');
  });

  test('a frame trying to NAME an owner is refused as INVALID_FRAME and never lands', async () => {
    identity.principal = { id: '33333333-3333-4333-8333-333333333333', handle: 'spoof-svc' };
    for (const spoof of [
      { kind: 'heartbeat', principalId: PRINCIPAL_B.id },
      { kind: 'heartbeat', principal_id: PRINCIPAL_B.id },
      { kind: 'heartbeat', ownerId: PRINCIPAL_B.id },
      { kind: 'heartbeat', owner: PRINCIPAL_B.handle },
    ]) {
      const { status, body } = await postFrame(spoof);
      expect(status).toBe(400);
      expect(body.code).toBe('INVALID_FRAME');
    }
    expect(db.statements.some(s => /INSERT INTO telemetry_frames/.test(s.text))).toBe(false);
  });
});

describe('liveness derivation (board clock, never pushed)', () => {
  const freshAt = () => new Date(Date.now() - 1000).toISOString();
  const staleAt = () => new Date(Date.now() - TELEMETRY_STALE_MS - 1000).toISOString();

  test('a fresh status frame IS its coarse status; a fresh heartbeat proves active', async () => {
    const service = new TelemetryService();
    db.frameRows = [{ kind: 'status', status: 'idle', received_at: freshAt() }];
    await expect(service.livenessForTask(TASK_ID)).resolves.toMatchObject({ state: 'idle' });
    db.frameRows = [{ kind: 'heartbeat', status: null, received_at: freshAt() }];
    await expect(service.livenessForTask(TASK_ID)).resolves.toMatchObject({ state: 'active' });
  });

  test('an old frame derives stale; no frames derive nothing (canonical fallback)', async () => {
    const service = new TelemetryService();
    db.frameRows = [{ kind: 'status', status: 'active', received_at: staleAt() }];
    await expect(service.livenessForTask(TASK_ID)).resolves.toMatchObject({ state: 'stale' });
    db.frameRows = [];
    await expect(service.livenessForTask(TASK_ID)).resolves.toBeNull();
  });

  test('GET /tasks/:id/session-status prefers a fresh frame and degrades to the canonical signal', async () => {
    const spy = jest.spyOn(telemetryService, 'livenessForTask');
    spy.mockResolvedValueOnce({ state: 'active', kind: 'heartbeat', receivedAt: freshAt() });
    let response = await fetch(`${base}/tasks/${TASK_ID}/session-status`);
    let body = (await response.json()) as any;
    expect(body.data.state).toBe('active');
    expect(body.data.telemetry).toMatchObject({ state: 'active' });

    spy.mockResolvedValueOnce(null);
    response = await fetch(`${base}/tasks/${TASK_ID}/session-status`);
    body = (await response.json()) as any;
    expect(body.data.state).toBe('idle'); // the canonical runtime signal
    expect(body.data.telemetry).toBeNull();

    spy.mockRejectedValueOnce(new Error('telemetry down'));
    response = await fetch(`${base}/tasks/${TASK_ID}/session-status`);
    body = (await response.json()) as any;
    expect(response.status).toBe(200);
    expect(body.data.state).toBe('idle'); // display, never authority: absence must not break the surface
    spy.mockRestore();
  });
});

describe('task.stuck derivation (lease expiry OR status staleness)', () => {
  const NOW = new Date('2026-08-22T02:00:00.000Z');
  const minutesAgo = (m: number) => new Date(NOW.getTime() - m * 60_000);

  test('deriveStuckReason: the pure board-clock rules', () => {
    expect(deriveStuckReason(NOW, { status: 'in-progress', activityAt: minutesAgo(5) },
      { status: 'expired', expiresAt: minutesAgo(1) })).toBe('lease_expired');
    expect(deriveStuckReason(NOW, { status: 'in-progress', activityAt: minutesAgo(5) },
      { status: 'active', expiresAt: minutesAgo(1) })).toBe('lease_expired'); // past expiry, even if unmarked
    expect(deriveStuckReason(NOW, { status: 'in-progress', activityAt: minutesAgo(TASK_STUCK_STALE_MINUTES + 1) },
      null)).toBe('status_stale');
    expect(deriveStuckReason(NOW, { status: 'in-progress', activityAt: minutesAgo(5) },
      { status: 'active', expiresAt: new Date(NOW.getTime() + 60_000) })).toBeNull();
    expect(deriveStuckReason(NOW, { status: 'review', activityAt: minutesAgo(500) }, null)).toBeNull();
  });

  test('a current renewed lease WINS over lease history; the backstop still catches silent claimants (79261f77 B1)', () => {
    // The SQL hands the derivation the ONE newest lease. A recovered Task's
    // newest lease is the current active one — never falsely stuck.
    expect(deriveStuckReason(NOW, { status: 'in-progress', activityAt: minutesAgo(5) },
      { status: 'active', expiresAt: new Date(NOW.getTime() + 10 * 60_000) })).toBeNull();
    // Heartbeating-but-dead: a dutifully renewed lease with NO qualifying
    // activity for the stale window still surfaces to the shepherd.
    expect(deriveStuckReason(NOW, { status: 'in-progress', activityAt: minutesAgo(TASK_STUCK_STALE_MINUTES + 1) },
      { status: 'active', expiresAt: new Date(NOW.getTime() + 10 * 60_000) })).toBe('status_stale');
  });

  test('the candidate SQL: one authoritative lease per Task, the qualifying-activity clock, in-SQL dedup (79261f77 B1+B2)', async () => {
    let candidateSql = '';
    const pool = {
      query: jest.fn(async (text: string) => { candidateSql = text; return { rows: [] }; }),
      connect: jest.fn(),
    };
    await new TelemetryService(pool as never).sweepStuckTasks(NOW);
    // B1: exactly one newest lease row per Task — LATERAL, newest-first, LIMIT 1.
    expect(candidateSql).toContain('LEFT JOIN LATERAL');
    expect(candidateSql).toContain('ORDER BY l.acquired_at DESC, l.id DESC');
    expect(candidateSql).toContain('LIMIT 1');
    // B2: the clock is status transitions (the feed's status-bearing task
    // events) and linked-Report activity via BOTH ratified linkage arms —
    // never generic updated_at.
    expect(candidateSql).toContain("fe.payload ? 'status'");
    expect(candidateSql).toContain('unnest(r.task_ids)');
    expect(candidateSql).toContain("tr.kind = 'report'");
    expect(candidateSql).toContain('GREATEST(');
    expect(candidateSql).not.toContain('t.updated_at');
    // Dedup is episode-scoped against the SAME activity clock, in SQL.
    expect(candidateSql).toContain("fe.name = 'task.stuck'");
    expect(candidateSql).toContain('fe.occurred_at >= c.activity_at');
  });

  test('the sweep emits task.stuck into the feed in its own transaction; fresh activity suppresses (79261f77 B2)', async () => {
    const statements: string[] = [];
    const client = {
      query: jest.fn(async (text: string) => { statements.push(text); return { rows: [] }; }),
      release: jest.fn(),
    };
    const pool = {
      query: jest.fn(async (text: string) => {
        if (/WITH candidates AS/.test(text)) {
          return { rows: [
            // Genuinely stale episode → announce once.
            { id: TASK_ID, status: 'in-progress', activity_at: minutesAgo(TASK_STUCK_STALE_MINUTES + 5), project_id: null, owner_principal_id: null, lease_status: null, lease_expires_at: null },
            // Fresh qualifying activity (e.g. a just-linked handover Report):
            // not stuck, nothing emitted.
            { id: '22222222-2222-4222-8222-222222222222', status: 'in-progress', activity_at: minutesAgo(1), project_id: null, owner_principal_id: null, lease_status: null, lease_expires_at: null },
            // Recovered Task: newest lease is current and active → not stuck.
            { id: '33333333-3333-4333-8333-333333333333', status: 'in-progress', activity_at: minutesAgo(5), project_id: null, owner_principal_id: null, lease_status: 'active', lease_expires_at: new Date(NOW.getTime() + 60_000) },
          ] };
        }
        return { rows: [] };
      }),
      connect: jest.fn(async () => client),
    };
    const service = new TelemetryService(pool as never);
    const emitted = await service.sweepStuckTasks(NOW);
    expect(emitted).toBe(1);
    const feed = statements.findIndex(s => s.includes('INSERT INTO feed_events'));
    const commit = statements.lastIndexOf('COMMIT');
    expect(feed).toBeGreaterThan(-1);
    expect(commit).toBeGreaterThan(feed);
  });
});

describe('migration 092 — the frame contract lives in constraints', () => {
  const sql = readFileSync(join(__dirname, '../migrations/092_telemetry_frames.sql'), 'utf8');

  test('kinds and coarse statuses are CHECKed; heartbeat carries no status; not baseline-stamped', () => {
    expect(sql).toContain("kind IN ('heartbeat', 'status')");
    expect(sql).toContain("status IN ('active', 'idle')");
    expect(sql).toContain('telemetry_frames_status_shape');
    const baseline = readFileSync(join(__dirname, '../migrations/BASELINE'), 'utf8');
    expect(baseline).not.toContain('092_telemetry_frames.sql');
  });

  test('deliberately NOT append-only: expiry-by-deletion is the contract', () => {
    expect(sql).toContain('NOT append-only-protected');
    expect(sql).not.toMatch(/CREATE TRIGGER/);
    expect(sql).toContain('pruned opportunistically at ingest');
  });
});
  describe('F4 — a frame that is NOT accepted must not consume the accepted-frame budget', () => {
    it('a TASK_NOT_FOUND frame leaves the budget untouched, and an immediate retry is accepted', async () => {
      // Review `29874574` F4 (BLOCKER). The deployment-wide gate replaced
      // candidate A's per-process Map, but the Map had a property worth
      // keeping: it was set only AFTER a successful insert. Committing the
      // acceptance first meant a frame refused by the Task foreign key
      // consumed the "minimum interval between ACCEPTED frames", so a
      // corrected retry got 429 although nothing was ever accepted — a change
      // to the C7 frame CONTRACT, not merely to where its state lives.
      db.insertError = { code: '23503' };
      identity.principal = { id: '66666666-6666-4666-8666-666666666666', handle: 'f4-svc' };
      const first = await postFrame({ kind: 'heartbeat', taskId: TASK_ID });
      expect(first.status).toBe(400);
      expect(first.body.code).toBe('TASK_NOT_FOUND');

      // The gate ran inside the transaction the failed insert rolled back, so
      // the limiter row must be exactly as it was.
      expect(db.rateLimits.size).toBe(0);

      // …and the corrected retry, immediately, is ACCEPTED.
      db.insertError = null;
      const retry = await postFrame({ kind: 'heartbeat' });
      expect(retry.status).toBe(200);
      expect(retry.body.accepted).toBe(true);
    });

    it('opens NO TRANSACTION at all — the gate and the write are one statement', async () => {
      // R3-B1: the previous repair wrapped both in a transaction, and the
      // refusal counter on a second connection then deadlocked against the row
      // that transaction held. One statement makes that cycle unrepresentable,
      // so the ABSENCE of BEGIN/COMMIT/ROLLBACK is the property to pin.
      identity.principal = { id: '55555555-5555-4555-8555-555555555555', handle: 'f4b-svc' };
      db.insertError = { code: '23503' };
      await postFrame({ kind: 'heartbeat', taskId: TASK_ID });
      const issued = db.statements.map((s) => s.text.trim().split(/\s+/)[0].toUpperCase());
      expect(issued).not.toContain('BEGIN');
      expect(issued).not.toContain('COMMIT');
      expect(issued).not.toContain('ROLLBACK');
      // …and the gate travelled INSIDE the frame INSERT, not before it.
      expect(db.statements.some((s) => /gate AS/.test(s.text)
        && /INSERT INTO telemetry_frames/.test(s.text))).toBe(true);
    });

    it('a rate-limited frame counts its refusal AFTER the gate statement', async () => {
      // The ordering R3-B1 made impossible: the counter runs once the statement
      // has ended and released everything it held.
      identity.principal = { id: '33333333-3333-4333-8333-333333333333', handle: 'f4d-svc' };
      expect((await postFrame({ kind: 'heartbeat' })).status).toBe(200);
      db.statements.length = 0;
      const second = await postFrame({ kind: 'heartbeat' });
      expect(second.status).toBe(429);
      const order = db.statements.map((s) => s.text);
      const gateAt = order.findIndex((t) => /gate AS/.test(t));
      const countAt = order.findIndex((t) => /UPDATE telemetry_rate_limits/.test(t));
      expect(gateAt).toBeGreaterThanOrEqual(0);
      expect(countAt).toBeGreaterThan(gateAt);
    });

    it('an ACCEPTED frame commits and DOES consume the budget — the control', () => {
      // Without this, the two assertions above would pass on a gate that never
      // recorded anything at all.
      identity.principal = { id: '44444444-4444-4444-8444-444444444444', handle: 'f4c-svc' };
      return postFrame({ kind: 'heartbeat' }).then(async (res: any) => {
        expect(res.status).toBe(200);
        expect(db.rateLimits.size).toBe(1);
      });
    });
  });
