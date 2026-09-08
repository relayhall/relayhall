/**
 * c8OpsFloor.test.ts — RH-P3.C8: the ops floor (strategy §2.12).
 *
 * What these pin:
 *  - API-wide per-source rate limiting (the generalized reviewed design):
 *    fixed-window budget, typed 429 + Retry-After, probe exemption,
 *    per-source independence, bounded state;
 *  - the functional probe FAILS when DB, auth, or the feed cannot actually
 *    work — an HTTP 200 is not health — with coarse details only;
 *  - human notification endpoints are SUBSCRIPTION-CLASS: the whole route
 *    family resolves to the root sentinel, every mutation is audited,
 *    hostile bodies are refused typed;
 *  - exception delivery: an announced task.stuck reaches the UI
 *    notification surface and enabled webhook endpoints with an ID-ONLY
 *    payload, loop-guarded, post-commit and non-authoritative.
 */
import express from 'express';
import type { AddressInfo } from 'net';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const db = {
  statements: [] as Array<{ text: string; params?: unknown[] }>,
  endpointRows: [] as any[],
  failDb: false,
  failFeed: false,
  upsertError: null as null | { code: string },
};
const audits: any[] = [];
const auditBehavior = { fail: false };

jest.mock('../db/connection', () => ({
  pool: {
    connect: jest.fn(async () => ({
      query: (text: string, params?: unknown[]) => (jest.requireMock('../db/connection') as any).pool.query(text, params),
      release: jest.fn(),
    })),
    query: jest.fn(async (text: string, params?: unknown[]) => {
      db.statements.push({ text, params });
      if (text === 'BEGIN' || text === 'COMMIT' || text === 'ROLLBACK') return { rows: [] };
      if (/SELECT 1/.test(text) && db.failDb) throw new Error('db down');
      if (/FROM feed_events/.test(text) && db.failFeed) throw new Error('feed down');
      if (/INSERT INTO notification_endpoints/.test(text)) {
        if (db.upsertError) { const e: any = new Error('fk'); e.code = db.upsertError.code; throw e; }
        return { rows: [{ id: '55555555-5555-4555-8555-555555555555', principal_id: params?.[0], kind: params?.[1], target: params?.[2], enabled: params?.[3], created_at: new Date(), updated_at: new Date() }] };
      }
      if (/DELETE FROM notification_endpoints/.test(text)) {
        return { rows: db.endpointRows.length ? [{ id: params?.[0], principal_id: db.endpointRows[0].principal_id, kind: db.endpointRows[0].kind, target: db.endpointRows[0].target, enabled: db.endpointRows[0].enabled }] : [] };
      }
      if (/FROM notification_endpoints/.test(text)) return { rows: db.endpointRows };
      return { rows: [], rowCount: 0 };
    }),
  },
}));
jest.mock('../services/AuditService', () => ({
  auditService: {
    record: jest.fn(async (entry: unknown, _client?: unknown) => {
      if (auditBehavior.fail) throw new Error('audit refused');
      audits.push(entry);
    }),
  },
}));

import {
  ApiRateLimiter,
  apiRateLimit,
  API_RATE_LIMIT_MAX_REQUESTS,
  API_RATE_LIMIT_EXEMPT,
} from '../middleware/apiRateLimit';
import { runFunctionalProbe } from '../utils/functionalProbe';
import notificationEndpointsRouter from '../routes/notificationEndpoints';
import {
  NotificationEndpointService,
  NOTIFICATION_DISPATCH_MIN_INTERVAL_MS,
} from '../services/NotificationEndpointService';
import { requiredScopeFor } from '../utils/scopeMap';

const PRINCIPAL = '99999999-9999-4999-8999-999999999999';

beforeEach(() => {
  db.statements.length = 0;
  db.endpointRows = [];
  db.failDb = false;
  db.failFeed = false;
  db.upsertError = null;
  audits.length = 0;
  auditBehavior.fail = false;
  // Assembled low-entropy fixture: a credential-shaped literal here would
  // (rightly) trip the publication gitleaks gate.
  process.env.JWT_SECRET = ['c8', 'probe', 'jwt', 'fixture', 'value'].join('-');
  process.env.DASHBOARD_PASSWORD_HASH = '$2b$10$c8probe';
});

describe('API-wide rate limiting (the generalized reviewed design)', () => {
  test('a source spends its window budget, then gets a typed 429 with Retry-After; the window resets', () => {
    let at = 1_000_000;
    const limiter = new ApiRateLimiter(3, 60_000, () => at);
    expect(limiter.check('s1').allowed).toBe(true);
    expect(limiter.check('s1').allowed).toBe(true);
    expect(limiter.check('s1').allowed).toBe(true);
    const denied = limiter.check('s1');
    expect(denied.allowed).toBe(false);
    expect(denied.retryAfterSeconds).toBeGreaterThan(0);
    // Another source is untouched; the window turnover restores the first.
    expect(limiter.check('s2').allowed).toBe(true);
    at += 60_001;
    expect(limiter.check('s1').allowed).toBe(true);
  });

  test('the middleware enforces the ceiling over HTTP and exempts the probes', async () => {
    const app = express();
    app.use(apiRateLimit);
    app.get('/health', (_req, res) => { res.json({ ok: true }); });
    app.get('/api-thing', (_req, res) => { res.json({ ok: true }); });
    const server = app.listen(0);
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      let denied: Response | null = null;
      for (let i = 0; i < API_RATE_LIMIT_MAX_REQUESTS + 5; i += 1) {
        const response = await fetch(`${base}/api-thing`);
        if (response.status === 429) { denied = response; break; }
      }
      expect(denied).not.toBeNull();
      expect(denied!.headers.get('retry-after')).toMatch(/^\d+$/);
      expect(((await denied!.json()) as any).code).toBe('RATE_LIMITED');
      // The probes stay reachable from the same throttled source.
      for (const path of API_RATE_LIMIT_EXEMPT) {
        if (path !== '/health') continue;
        const probe = await fetch(`${base}${path}`);
        expect(probe.status).toBe(200);
      }
    } finally {
      server.close();
    }
  });

  test('the exemption set is exactly the probe surfaces', () => {
    expect([...API_RATE_LIMIT_EXEMPT].sort()).toEqual(['/health', '/health/functional', '/health/orchestration', '/readiness']);
  });
});

describe('the functional probe — an HTTP 200 is not health', () => {
  test('all three subsystems answering → ok', async () => {
    const result = await runFunctionalProbe();
    expect(result.ok).toBe(true);
    expect(result.checks).toMatchObject({
      db: { ok: true }, auth: { ok: true }, feed: { ok: true },
    });
  });

  test('a broken DB fails the probe with a coarse detail word only', async () => {
    db.failDb = true;
    const result = await runFunctionalProbe();
    expect(result.ok).toBe(false);
    expect(result.checks.db).toEqual({ ok: false, detail: 'query-failed' });
  });

  test('an unreadable feed fails the probe even while plain HTTP would answer', async () => {
    db.failFeed = true;
    const result = await runFunctionalProbe();
    expect(result.ok).toBe(false);
    expect(result.checks.feed).toEqual({ ok: false, detail: 'read-failed' });
  });

  test('auth without a configured password hash fails the probe', async () => {
    delete process.env.DASHBOARD_PASSWORD_HASH;
    const result = await runFunctionalProbe();
    expect(result.ok).toBe(false);
    expect(result.checks.auth).toEqual({ ok: false, detail: 'password-hash-missing' });
  });

  test('server.ts wires the probe surfaces and the ceiling in front of the routes', () => {
    const src = readFileSync(join(__dirname, '../server.ts'), 'utf8');
    expect(src).toContain('app.use(apiRateLimit);');
    expect(src).toContain("app.get('/readiness'");
    expect(src).toContain("app.get('/health/functional'");
    // RH-P3.C4: the mount list moved into routeRegistry, so the ordering is
    // asserted against the sweep that mounts it — and against the new
    // in-process MCP ingress, which is a real ingress and must sit behind the
    // same per-source ceiling.
    expect(src.indexOf('app.use(apiRateLimit);')).toBeLessThan(src.indexOf('registerProtectedRoutes(protectedRouter);'));
    expect(src.indexOf('app.use(apiRateLimit);')).toBeLessThan(src.indexOf('app.use(MCP_ROUTE_PATH, mcpRoutes);'));
    expect(src).toContain('result.ok ? 200 : 503');
  });
});

describe('notification endpoints — subscription-class, audited', () => {
  let server: ReturnType<typeof express.application.listen>;
  let base = '';
  beforeAll((done) => {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      (req as any).principal = { id: PRINCIPAL, handle: 'owner' };
      (req as any).userId = 'owner';
      (req as any).authMethod = 'jwt';
      next();
    });
    app.use('/notification-endpoints', notificationEndpointsRouter);
    server = app.listen(0, () => {
      base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      done();
    });
  });
  afterAll((done) => { server.close(() => done()); });

  const put = async (body: unknown) => {
    const response = await fetch(`${base}/notification-endpoints`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    return { status: response.status, body: (await response.json()) as any };
  };

  test('the whole family resolves to the root sentinel — agent-plane-unwritable by scope', () => {
    expect(requiredScopeFor('GET', '/notification-endpoints')).toBe('root');
    expect(requiredScopeFor('PUT', '/notification-endpoints')).toBe('root');
    expect(requiredScopeFor('DELETE', '/notification-endpoints/abc')).toBe('root');
  });

  test('a valid upsert lands, is AUDITED in the SAME transaction, and records a secret-safe destination', async () => {
    const { status, body } = await put({ principalId: PRINCIPAL, kind: 'webhook', target: 'https://example.test/hook?token=hooksecret123', enabled: true });
    expect(status).toBe(200);
    expect(body.endpoint.kind).toBe('webhook');
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      action: 'notification_endpoint.set',
      resourceType: 'principal',
      resourceId: PRINCIPAL,
    });
    // The destination identity is the HOST — credential-bearing URL
    // material (paths, query strings, userinfo) never reaches the audit row.
    expect(audits[0].metadata.destination).toBe('example.test');
    expect(JSON.stringify(audits[0])).not.toContain('hooksecret123');
    // Atomicity: BEGIN precedes the mutation, COMMIT follows the audit call.
    const texts = db.statements.map(s => s.text);
    const begin = texts.indexOf('BEGIN');
    const insert = texts.findIndex(t => /INSERT INTO notification_endpoints/.test(t));
    const commit = texts.indexOf('COMMIT');
    expect(begin).toBeGreaterThanOrEqual(0);
    expect(insert).toBeGreaterThan(begin);
    expect(commit).toBeGreaterThan(insert);
  });

  test('an audit failure rolls the ENDPOINT MUTATION back — no unaudited subscription-class change (4243b06e B2)', async () => {
    auditBehavior.fail = true;
    const { status } = await put({ principalId: PRINCIPAL, kind: 'webhook', target: 'https://example.test/hook' });
    expect(status).toBe(500);
    const texts = db.statements.map(s => s.text);
    expect(texts.findIndex(t => /INSERT INTO notification_endpoints/.test(t))).toBeGreaterThan(-1);
    expect(texts).toContain('ROLLBACK');
    expect(texts).not.toContain('COMMIT');
    expect(audits).toHaveLength(0);
  });

  test('an audit failure rolls the REMOVAL back too (4243b06e B2)', async () => {
    db.endpointRows = [{ principal_id: PRINCIPAL, kind: 'webhook', target: 'https://example.test/hook' }];
    auditBehavior.fail = true;
    const response = await fetch(`${base}/notification-endpoints/55555555-5555-4555-8555-555555555555`, { method: 'DELETE' });
    expect(response.status).toBe(500);
    const texts = db.statements.map(s => s.text);
    expect(texts).toContain('ROLLBACK');
    expect(texts).not.toContain('COMMIT');
  });

  test('hostile bodies are refused with typed 400s', async () => {
    for (const body of [
      { principalId: PRINCIPAL, kind: 'webhook', target: 'https://x.test', extra: 1 },
      { principalId: 'nope', kind: 'webhook', target: 'https://x.test' },
      { principalId: PRINCIPAL, kind: 'carrier-pigeon', target: 'https://x.test' },
      { principalId: PRINCIPAL, kind: 'webhook', target: 'ftp://x.test' },
      { principalId: PRINCIPAL, kind: 'webhook', target: 'https://x.test', enabled: 'yes' },
    ]) {
      const { status, body: out } = await put(body);
      expect(status).toBe(400);
      expect(out.code).toBe('INVALID_ENDPOINT');
    }
    expect(audits).toHaveLength(0);
  });

  test('a malformed target is a typed 400 at the surface and NO mutation or audit row lands', async () => {
    for (const body of [
      { principalId: PRINCIPAL, kind: 'email', target: 'private-address-secret' },
      { principalId: PRINCIPAL, kind: 'email', target: 'two@ats@example.test' },
      { principalId: PRINCIPAL, kind: 'webhook', target: 'https://' },
    ]) {
      db.statements.length = 0;
      const { status, body: out } = await put(body);
      expect(status).toBe(400);
      expect(out.code).toBe('INVALID_ENDPOINT');
      expect(db.statements.some(s => /INSERT INTO notification_endpoints/.test(s.text))).toBe(false);
    }
    expect(audits).toHaveLength(0);
  });

  test('an unknown principal maps the FK refusal to a typed 400', async () => {
    db.upsertError = { code: '23503' };
    const { status, body } = await put({ principalId: PRINCIPAL, kind: 'webhook', target: 'https://x.test' });
    expect(status).toBe(400);
    expect(body.error).toContain('names no principal');
  });

  test('removal is audited with COMPLETE metadata; a missing endpoint is a 404 without an audit row', async () => {
    db.endpointRows = [{ principal_id: PRINCIPAL, kind: 'webhook', target: 'https://receiver.test/hook?token=zz', enabled: true }];
    const ok = await fetch(`${base}/notification-endpoints/55555555-5555-4555-8555-555555555555`, { method: 'DELETE' });
    expect(ok.status).toBe(200);
    expect(audits).toHaveLength(1);
    expect(audits[0].action).toBe('notification_endpoint.removed');
    // Round-1 B2's full metadata contract, on removal too (f6a94595 R2-B1):
    // actor, principal, endpoint id, kind, ENABLED state, and the
    // secret-safe destination.
    expect(audits[0]).toMatchObject({
      resourceType: 'principal',
      resourceId: PRINCIPAL,
      metadata: {
        kind: 'webhook',
        enabled: true,
        endpointId: '55555555-5555-4555-8555-555555555555',
        destination: 'receiver.test',
      },
    });
    expect(JSON.stringify(audits[0])).not.toContain('token=zz');
    audits.length = 0;
    db.endpointRows = [];
    const missing = await fetch(`${base}/notification-endpoints/55555555-5555-4555-8555-555555555555`, { method: 'DELETE' });
    expect(missing.status).toBe(404);
    expect(audits).toHaveLength(0);
  });
});

describe('destination identity — fail-closed, secret-safe (f6a94595 R2-B1)', () => {
  const derive = NotificationEndpointService.destinationIdentity;

  test.each([
    ['webhook', 'https://receiver.test/hook?token=secret99', 'receiver.test'],
    ['webhook', 'https://user:pass@receiver.test/x', 'receiver.test'],
    ['webhook', 'https://[2001:db8::1]:8443/hook', '[2001:db8::1]:8443'],
    ['email', 'owner@example.test', 'example.test'],
  ] as const)('%s %s → %s (identity only, never private material)', (kind, target, expected) => {
    const identity = derive(kind, target);
    expect(identity).toBe(expected);
    expect(String(identity)).not.toContain('secret99');
    expect(String(identity)).not.toContain('pass');
    expect(String(identity)).not.toContain('owner@');
  });

  test.each([
    ['webhook', 'https://'],
    ['webhook', 'not a url at all'],
    ['webhook', 'ftp://receiver.test/x'],
    ['email', 'private-address-secret'],
    ['email', 'two@ats@example.test'],
    ['email', 'nobody@nodot'],
    ['email', '@example.test'],
  ] as const)('%s %s derives NOTHING — refused, never committed', (kind, target) => {
    expect(derive(kind, target)).toBeNull();
  });

  test('the upsert path derives once and can never commit a null destination (source pin)', () => {
    const source = readFileSync(join(__dirname, '../services/NotificationEndpointService.ts'), 'utf8');
    const deriveAt = source.indexOf('destinationIdentity(input.kind, input.target)');
    const connectAt = source.indexOf('await this.pool.connect();', source.indexOf('async upsert('));
    expect(deriveAt).toBeGreaterThan(-1);
    expect(deriveAt).toBeLessThan(connectAt);
    expect(source).toContain('NotificationEndpointValidationError');
  });
});

describe('exception dispatch — ID-only, loop-guarded, best-effort', () => {
  test('an enabled webhook endpoint receives IDs and coarse reason, nothing more', async () => {
    db.endpointRows = [{ id: 'e1', principal_id: PRINCIPAL, kind: 'webhook', target: 'https://receiver.test/hook', enabled: true, created_at: new Date(), updated_at: new Date() }];
    const sent: Array<{ url: string; body: any }> = [];
    const realFetch = global.fetch;
    (global as any).fetch = jest.fn(async (url: string, init: any) => {
      sent.push({ url: String(url), body: JSON.parse(init.body) });
      return { ok: true } as never;
    });
    try {
      const service = new NotificationEndpointService();
      const count = await service.dispatchException({
        name: 'task.stuck', objectType: 'task', objectId: 'task-1', reason: 'status_stale', occurredAt: '2026-08-22T03:00:00.000Z',
      });
      expect(count).toBe(1);
      expect(sent[0].url).toBe('https://receiver.test/hook');
      expect(Object.keys(sent[0].body).sort()).toEqual(['name', 'objectId', 'objectType', 'occurredAt', 'reason']);
      // Loop guard: an immediate second exception is held by the interval floor.
      const again = await service.dispatchException({
        name: 'task.stuck', objectType: 'task', objectId: 'task-2', occurredAt: '2026-08-22T03:00:05.000Z',
      });
      expect(again).toBe(0);
      expect(NOTIFICATION_DISPATCH_MIN_INTERVAL_MS).toBeGreaterThanOrEqual(60_000);
    } finally {
      (global as any).fetch = realFetch;
    }
  });

  test('only enabled webhook endpoints are even queried', async () => {
    const service = new NotificationEndpointService();
    await service.dispatchException({ name: 'task.stuck', objectType: 'task', objectId: 't', occurredAt: 'x' });
    const query = db.statements.find(s => /FROM notification_endpoints/.test(s.text))!;
    expect(query.text).toContain("kind = 'webhook'");
    expect(query.text).toContain('enabled');
  });

  test('the sweep wires the announced episode into BOTH human paths, post-commit', () => {
    const src = readFileSync(join(__dirname, '../services/TelemetryService.ts'), 'utf8');
    const commitAt = src.indexOf("await client.query('COMMIT');");
    const uiAt = src.indexOf('notificationManager.notifyException');
    const hookAt = src.indexOf('notificationEndpointService.dispatchException');
    expect(uiAt).toBeGreaterThan(commitAt);
    expect(hookAt).toBeGreaterThan(uiAt);
  });
});

describe('migration 093 — the endpoint contract lives in constraints', () => {
  const sql = readFileSync(join(__dirname, '../migrations/093_notification_endpoints.sql'), 'utf8');
  test('kinds CHECKed, one endpoint per (principal, kind), not baseline-stamped', () => {
    expect(sql).toContain("kind IN ('webhook', 'email')");
    expect(sql).toContain('uq_notification_endpoints_principal_kind');
    const baseline = readFileSync(join(__dirname, '../migrations/BASELINE'), 'utf8');
    expect(baseline).not.toContain('093_notification_endpoints.sql');
  });
});
