/**
 * Card e220be94 (owner ruling E353): the plugin bridge's board metrics, proven
 * over a REAL PostgreSQL through the PRODUCTION protected router, with real
 * session and bearer authentication:
 *
 *   (Q) queue = the caller Account's armed `todo` Tasks, by the effective
 *       Account owner; another Account's Tasks are never counted;
 *   (T) throughput = the caller Account's `handover.finish` entries in the
 *       rolling hour; a REST handback moves its own Account's count only;
 *   (U) what cannot be computed is `unknown` with a null value, never 0: a
 *       statement that cannot complete, a caller whose object reach is
 *       narrower than its Account, and a caller without tasks:read;
 *   (F) every reported metric is freshness-stamped by the server, and the
 *       existing `metrics` / `metricsSources` fields are unchanged.
 *
 * The plugin installation is a stub loader holding one rh.plugin/1 manifest
 * (the installation registry is not under test); everything behind it is the
 * production code path. Mutation controls (scripts/board-metrics-mutations.py)
 * name the tests here that each control must turn red.
 *
 * DESTRUCTIVE: writes principals, credentials, sessions, projects, tasks and
 * stream entries (stream entries are immutable, so their Tasks stay). It
 * refuses any deployment database and any non-local host, and FAILS - never
 * skips - without a disposable one.
 */

/* eslint-disable @typescript-eslint/no-var-requires */

import http from 'http';
import crypto from 'crypto';

const TEST_DB_URL = process.env.RELAYHALL_TEST_DB_URL;
if (!TEST_DB_URL) {
  throw new Error('RELAYHALL_TEST_DB_URL is required: the board-metrics drill measures stored task and stream rows, '
    + 'so it never skips. Load database/init.sql into a disposable database, run npm run migrate, and point '
    + 'RELAYHALL_TEST_DB_URL at it.');
}
const parsed = new URL(TEST_DB_URL);
const TEST_DB_NAME = decodeURIComponent(parsed.pathname.slice(1));
const localDisposable = ['127.0.0.1', 'localhost', '[::1]'].includes(parsed.hostname)
  && /test|contract|fixture/.test(TEST_DB_NAME);
const ciService = process.env.CI === 'true' && parsed.hostname === 'postgres' && TEST_DB_NAME === 'relayhall_ci';
if (!['postgres:', 'postgresql:'].includes(parsed.protocol)
  || ['relayhall', 'relayhall_dev', 'relayhall_tst', 'relayhall_prod'].includes(TEST_DB_NAME)
  || (!localDisposable && !ciService)) {
  throw new Error('Board-metrics drill refuses a non-disposable database target');
}

Object.assign(process.env, {
  DB_HOST: parsed.hostname, DB_PORT: parsed.port || '5432', DB_NAME: TEST_DB_NAME,
  DB_USER: decodeURIComponent(parsed.username), DB_PASSWORD: decodeURIComponent(parsed.password),
  NODE_ENV: 'test', RELAYHALL_SESSIONS: 'on', JWT_SECRET: crypto.randomBytes(32).toString('hex'),
});

const express = require('express');
const { Pool } = require('pg');
const { pool } = require('../db/connection');
const { registerProtectedRoutes } = require('../routeRegistry');
const { authMiddleware } = require('../middleware/auth');
const { sharedAuthorizationMiddleware } = require('../middleware/sharedAuthorization');
const { apiErrorHandler } = require('../utils/apiErrors');
const { jsonBodyOptions } = require('../utils/jsonBodyTypes');
const { loginSessionService, SESSION_COOKIE_NAME } = require('../services/LoginSessionService');
const { principalService } = require('../services/PrincipalService');
const { setPluginHostLoader } = require('../routes/pluginHost');

jest.setTimeout(120_000);

const PLUGIN = 'board-metrics-probe';
let server: http.Server;
let origin: string;
const accounts: string[] = [];

interface Caller { principalId: string; headers: Record<string, string> }
interface Answer { status: number; json: any }
const tag = (): string => crypto.randomBytes(5).toString('hex');

async function call(who: Caller, method: string, routePath: string, body?: unknown): Promise<Answer> {
  const response = await fetch(`${origin}${routePath}`, {
    method, headers: { 'Content-Type': 'application/json', ...who.headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let json: any = null;
  try { json = JSON.parse(text); } catch { json = null; }
  return { status: response.status, json };
}
async function bridge(who: Caller): Promise<any> {
  const answer = await call(who, 'GET', `/plugin-host/${PLUGIN}/bridge`);
  expect(answer.status).toBe(200);
  return answer.json;
}

async function person(label: string): Promise<Caller> {
  const row = await pool.query(`INSERT INTO principals (kind, handle, display_name, status, role)
    VALUES ('human', $1, $1, 'active', 'user') RETURNING id`, [`bm-${label}-${tag()}`]);
  const principalId = String(row.rows[0].id);
  accounts.push(principalId);
  const minted = await loginSessionService.mint({ principalId });
  return { principalId, headers: { Cookie: `${SESSION_COOKIE_NAME}=${minted.token}` } };
}
/** The bridge needs services:read; the board metrics also need tasks:read. */
const BRIDGE_AND_TASKS = ['services:read', 'tasks:read'];
async function connector(owner: string, objects: 'parent' | unknown[], scopes: string[] = BRIDGE_AND_TASKS): Promise<Caller> {
  const row = await pool.query(`INSERT INTO principals (kind, handle, status, parent_principal_id, purpose, own_expression)
    VALUES ('service', $1, 'active', $2, 'Disposable board-metrics proof', $3) RETURNING id`,
  [`bm-connector-${tag()}`, owner, JSON.stringify({ scopes: 'parent', objects })]);
  const principalId = String(row.rows[0].id);
  const credential = await principalService.issueCredential({ principalId, scopes, transport: 'api',
    expiresAt: new Date(Date.now() + 3600_000) }, { handle: 'disposable-board-metrics-fixture', authMethod: 'system' });
  return { principalId, headers: { Authorization: `Bearer ${credential.fullKey}` } };
}
async function project(owner: string): Promise<string> {
  const row = await pool.query(`INSERT INTO projects (name, owner_principal_id, visibility) VALUES ($1, $2, 'private') RETURNING id`,
    [`bm-project-${tag()}`, owner]);
  return String(row.rows[0].id);
}
/** A Task row; `accountOwner` null leaves the effective owner to the Project. */
async function task(projectId: string, shepherd: string, status: string, armed: boolean,
  accountOwner: string | null = null): Promise<string> {
  const row = await pool.query(`INSERT INTO tasks (title, project_id, account_owner_principal_id, shepherd_principal_id,
      status, auto_start, visibility) VALUES ($1, $2, $3, $4, $5, $6, 'private') RETURNING id`,
  [`bm-task-${tag()}`, projectId, accountOwner, shepherd, status, armed]);
  return String(row.rows[0].id);
}
async function streamEntry(taskId: string, eventType: string, ageSeconds: number): Promise<void> {
  await pool.query(`INSERT INTO task_stream_entries (task_id, provenance, event_type, content, created_at)
    VALUES ($1, 'system', $2, 'board-metrics fixture', clock_timestamp() - make_interval(secs => $3))`,
  [taskId, eventType, ageSeconds]);
}
/** A real handback: a Task created in-progress over REST, finished over REST into Review. */
async function handback(who: Caller, projectId: string): Promise<void> {
  const created = await call(who, 'POST', '/tasks', { title: `bm handback ${tag()}`, project: projectId, status: 'in-progress' });
  expect([created.status, created.json?.code]).toEqual([201, undefined]);
  const finished = await call(who, 'POST', `/tasks/${created.json.task.id}/finish`,
    { report: { title: 'Board metrics handback', content: 'Handed back for the board-metrics drill.' } });
  expect(finished.status).toBe(200);
  expect(finished.json).toMatchObject({ status: 'review' });
}

beforeAll(async () => {
  const app = express();
  app.use(express.json(jsonBodyOptions));
  registerProtectedRoutes((mountPath: string, ...handlers: any[]) => {
    app.use(mountPath, authMiddleware, sharedAuthorizationMiddleware, ...handlers);
  });
  app.use(apiErrorHandler);
  await new Promise<void>((resolve) => { server = app.listen(0, '127.0.0.1', resolve); });
  origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  // Every Account this suite creates holds the installation's view grant.
  const accessAccounts = new Proxy({}, {
    get: (_t, key) => (typeof key === 'string' && accounts.includes(key) ? ['view'] : undefined),
  });
  const plugin = {
    manifest: { name: PLUGIN, schema_version: 'rh.plugin/1', relayhall: { api_version: 1, trust: 'installed',
      capabilities: ['telemetry.sessions'] } },
    config: { name: PLUGIN, enabled: true, access: { accounts: accessAccounts } },
  };
  setPluginHostLoader({ getPlugin: (name: string) => (name === PLUGIN ? plugin : undefined) } as any);
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await pool.end();
});

describe('(Q) queue: the caller Account\'s armed todo Tasks', () => {
  it('two Accounts each see only their own armed todo Tasks; another Account\'s Tasks are never counted', async () => {
    const a = await person('queue-a'), b = await person('queue-b');
    const before = [await bridge(a), await bridge(b)];
    for (const answer of before) expect(answer.boardMetrics.queue).toMatchObject({ status: 'reported', value: 0, unit: 'jobs' });
    const pa = await project(a.principalId), pb = await project(b.principalId);
    await task(pa, a.principalId, 'todo', true);                     // A by its Project
    await task(pb, b.principalId, 'todo', true, a.principalId);      // A explicitly, in B's Project
    await task(pb, b.principalId, 'todo', true);                     // B by its Project
    await task(pb, b.principalId, 'todo', true);                     // B by its Project
    await task(pa, a.principalId, 'todo', true, b.principalId);      // B explicitly, in A's Project
    expect((await bridge(a)).boardMetrics.queue).toMatchObject({ status: 'reported', value: 2 });
    expect((await bridge(b)).boardMetrics.queue).toMatchObject({ status: 'reported', value: 3 });
  });

  it('only armed todo Tasks wait: unarmed todo, ideas, in-progress, review, stuck, completed and archived are not counted', async () => {
    const c = await person('queue-c');
    const pc = await project(c.principalId);
    await task(pc, c.principalId, 'todo', true);
    await task(pc, c.principalId, 'todo', false);
    for (const status of ['ideas', 'in-progress', 'review', 'stuck', 'completed', 'archived']) {
      await task(pc, c.principalId, status, true);
    }
    expect((await bridge(c)).boardMetrics.queue).toMatchObject({ status: 'reported', value: 1, unit: 'jobs' });
  });
});

describe('(T) throughput: the caller Account\'s handbacks in the rolling hour', () => {
  it('a REST handback into Review moves its own Account\'s throughput by one and no other Account\'s', async () => {
    const d = await person('throughput-d'), e = await person('throughput-e');
    const pd = await project(d.principalId), pe = await project(e.principalId);
    for (const who of [d, e]) {
      expect((await bridge(who)).boardMetrics.throughput)
        .toMatchObject({ status: 'reported', value: 0, count: 0, unit: 'jobs/minute', windowSeconds: 3600 });
    }
    await handback(d, pd);
    expect((await bridge(d)).boardMetrics.throughput).toMatchObject({ status: 'reported', count: 1, value: 1 / 60 });
    expect((await bridge(e)).boardMetrics.throughput).toMatchObject({ status: 'reported', count: 0, value: 0 });
    await handback(e, pe);
    await handback(e, pe);
    expect((await bridge(e)).boardMetrics.throughput).toMatchObject({ status: 'reported', count: 2, value: 2 / 60 });
    expect((await bridge(d)).boardMetrics.throughput).toMatchObject({ status: 'reported', count: 1 });
  });

  it('only handover.finish entries inside the rolling hour count: an older handback and other entries do not', async () => {
    const f = await person('throughput-f');
    const pf = await project(f.principalId);
    const t = await task(pf, f.principalId, 'review', false);
    await streamEntry(t, 'handover.finish', 1800);      // inside the hour
    await streamEntry(t, 'handover.finish', 7200);      // two hours ago
    await streamEntry(t, 'handover.note', 60);          // not a handback
    await streamEntry(t, 'task.transitioned', 60);      // the system twin of a handback is not counted twice
    expect((await bridge(f)).boardMetrics.throughput).toMatchObject({ status: 'reported', count: 1, value: 1 / 60 });
  });
});

describe('(U) unknown is unknown, never 0', () => {
  it('a statement that cannot complete is unknown with a null value, and the bridge still answers', async () => {
    const g = await person('unknown-g');
    const pg = await project(g.principalId);
    await task(pg, g.principalId, 'todo', true);
    const locker = new Pool({ host: process.env.DB_HOST, port: Number(process.env.DB_PORT), database: process.env.DB_NAME,
      user: process.env.DB_USER, password: process.env.DB_PASSWORD, max: 1 });
    const client = await locker.connect();
    let answer: any;
    try {
      await client.query('BEGIN');
      await client.query('LOCK TABLE task_stream_entries IN ACCESS EXCLUSIVE MODE');
      answer = await bridge(g);
    } finally {
      await client.query('ROLLBACK').catch(() => {});
      client.release();
      await locker.end();
    }
    expect(answer.boardMetrics.throughput).toEqual({ status: 'unknown', value: null, unit: 'jobs/minute', windowSeconds: 3600,
      reason: 'unavailable', source: { kind: 'core', producer: 'board' } });
    expect(answer.boardMetrics.queue).toMatchObject({ status: 'reported', value: 1 });
    expect(Array.isArray(answer.sessions)).toBe(true);
    // Once the statement can complete, the same Account reads a measured 0.
    expect((await bridge(g)).boardMetrics.throughput).toMatchObject({ status: 'reported', value: 0, count: 0 });
  });

  it('a caller whose object reach is narrower than its Account is answered unknown; a full-reach Connector reads the count', async () => {
    const h = await person('unknown-h');
    const ph = await project(h.principalId);
    await task(ph, h.principalId, 'todo', true);
    const narrow = await connector(h.principalId, []);
    const full = await connector(h.principalId, 'parent');
    const narrowed = (await bridge(narrow)).boardMetrics;
    expect(narrowed.queue).toEqual({ status: 'unknown', value: null, unit: 'jobs', reason: 'caller-reach',
      source: { kind: 'core', producer: 'board' } });
    expect(narrowed.throughput).toMatchObject({ status: 'unknown', value: null, reason: 'caller-reach' });
    expect(narrowed.observedAt).toBeNull();
    expect((await bridge(full)).boardMetrics.queue).toMatchObject({ status: 'reported', value: 1 });
  });

  it('a credential with services:read alone is answered unknown; the same reach with tasks:read reads the count', async () => {
    const m = await person('unknown-m');
    const pm = await project(m.principalId);
    await task(pm, m.principalId, 'todo', true);
    const bridgeOnly = await connector(m.principalId, 'parent', ['services:read']);
    const withTasks = await connector(m.principalId, 'parent', ['services:read', 'tasks:read']);
    const withheld = await bridge(bridgeOnly);
    expect(withheld.boardMetrics.queue).toEqual({ status: 'unknown', value: null, unit: 'jobs', reason: 'caller-reach',
      source: { kind: 'core', producer: 'board' } });
    expect(withheld.boardMetrics.throughput).toMatchObject({ status: 'unknown', value: null, reason: 'caller-reach' });
    expect(withheld.boardMetrics.throughput).not.toHaveProperty('count');
    expect(Array.isArray(withheld.sessions)).toBe(true);
    const counted = (await bridge(withTasks)).boardMetrics;
    expect(counted.queue).toMatchObject({ status: 'reported', value: 1 });
    expect(counted.throughput).toMatchObject({ status: 'reported', count: 0 });
  });
});

describe('(F) freshness and the existing fields', () => {
  it('every reported metric carries a server observedAt from the read, and metrics and metricsSources are unchanged', async () => {
    const k = await person('fresh-k');
    const started = Date.now() - 1000;
    const answer = await bridge(k);
    const finished = Date.now() + 1000;
    const board = answer.boardMetrics;
    expect(board).toMatchObject({ schemaVersion: 'rh.plugin.board-metrics/1', freshnessSeconds: 90, stale: false,
      source: { kind: 'core', producer: 'board' } });
    for (const stamp of [board.observedAt, board.queue.observedAt, board.throughput.observedAt]) {
      expect(typeof stamp).toBe('string');
      expect(Date.parse(stamp)).toBeGreaterThanOrEqual(started);
      expect(Date.parse(stamp)).toBeLessThanOrEqual(finished);
    }
    expect(board.queue.stale).toBe(false);
    expect(board.throughput.stale).toBe(false);
    // The existing bridge contract, unchanged: no service reporter means null fields.
    expect(answer.schemaVersion).toBe('rh.plugin.bridge/1');
    expect(answer.metrics).toEqual({ schemaVersion: 'rh.plugin.metrics/1', queue: null, throughput: null });
    expect(answer.metricsSources).toEqual({ truncated: false, sources: [] });
    // Card bedf50cc (E380, C7): two ungated members join every bridge answer,
    // availability and settings; every other field is unchanged.
    expect(Object.keys(answer).sort()).toEqual(['availability', 'boardMetrics', 'metrics', 'metricsSources', 'observedAt', 'schemaVersion', 'sessions', 'settings']);
  });
});
