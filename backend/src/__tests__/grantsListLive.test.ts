/**
 * grantsListLive.test.ts — owner ruling E407 item 1 (card ff410dc4, SQ-4 +
 * SQ-5): the Access page's grants list, read ONE PAGE at a time, against a
 * REAL PostgreSQL through the production router, auth and route ceiling.
 *
 * What it holds: keyset paging returns every row present throughout exactly
 * once while rows are written and revoked between pages, under every sort;
 * the origin of each row (hand-made, system-made, unknown) is derived from
 * data the board already keeps and never guessed; every filter, sort and the
 * search run inside the statement; the read keeps its root ceiling (two
 * Accounts that are not administrators see nothing, before and after); and
 * the default query's plan on a seeded table uses the audit ledger's existing
 * resource index.
 *
 * Disposable database only: a local `relayhall_grants_list_test`, or the CI
 * job's own `relayhall_ci` service.
 */
import http from 'http';
import crypto from 'crypto';
const url = process.env.RELAYHALL_TEST_DB_URL;
if (!url) throw new Error('RELAYHALL_TEST_DB_URL is required');
const parsed = new URL(url), database = decodeURIComponent(parsed.pathname.slice(1));
if (!['postgres:', 'postgresql:'].includes(parsed.protocol)
  || !(['localhost', '127.0.0.1'].includes(parsed.hostname) || (process.env.CI === 'true' && parsed.hostname === 'postgres'))
  || !(database === 'relayhall_grants_list_test' || (process.env.CI === 'true' && database === 'relayhall_ci'))) {
  throw new Error('Disposable grants list database only');
}
Object.assign(process.env, {
  DB_HOST: parsed.hostname, DB_PORT: parsed.port, DB_NAME: database,
  DB_USER: decodeURIComponent(parsed.username), DB_PASSWORD: decodeURIComponent(parsed.password),
  NODE_ENV: 'test', RELAYHALL_SESSIONS: 'on', JWT_SECRET: crypto.randomBytes(32).toString('hex'),
});
const express = require('express');
const { pool } = require('../db/connection');
const { registerProtectedRoutes } = require('../routeRegistry');
const { authMiddleware } = require('../middleware/auth');
const { sharedAuthorizationMiddleware } = require('../middleware/sharedAuthorization');
const { apiErrorHandler } = require('../utils/apiErrors');
const { loginSessionService, SESSION_COOKIE_NAME } = require('../services/LoginSessionService');
const { principalService } = require('../services/PrincipalService');
const { groupService } = require('../services/GroupService');

jest.setTimeout(240000);

let server: http.Server, origin: string;
type Caller = { id: string; headers: Record<string, string> };
const tag = (prefix = 'gl') => `${prefix}-${crypto.randomBytes(6).toString('hex')}`;

async function call(who: Caller, method: string, path: string, body?: unknown) {
  const response = await fetch(origin + path, {
    method, headers: { 'Content-Type': 'application/json', ...who.headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() as any };
}
async function human(role = 'admin', handle = tag('acct')): Promise<Caller> {
  const row = (await pool.query(
    "INSERT INTO principals(kind,handle,display_name,status,role) VALUES('human',$1,$1,'active',$2) RETURNING id", [handle, role])).rows[0];
  const session = await loginSessionService.mint({ principalId: row.id });
  return { id: row.id, headers: { Cookie: `${SESSION_COOKIE_NAME}=${session.token}` } };
}
async function grantee(handle = tag('holder')): Promise<string> {
  return (await pool.query(
    "INSERT INTO principals(kind,handle,display_name,status,role) VALUES('service',$1,$1,'active',NULL) RETURNING id", [handle])).rows[0].id;
}
async function audit(action: string, resourceType: string, resourceId: string, metadata: Record<string, unknown>) {
  await pool.query(
    `INSERT INTO audit_events(action, actor_handle, auth_method, outcome, resource_type, resource_id, metadata)
     VALUES ($1, 'fixture', 'system', 'success', $2, $3, $4::jsonb)`, [action, resourceType, resourceId, JSON.stringify(metadata)]);
}

interface Seed {
  granteeId: string; granteeType?: 'principal' | 'group'; resourceType?: string; resourceId?: string | null; verb?: string;
  expiresAt?: string | null; createdAt?: string; provenance?: string | null; origin?: string; approvalId?: string | null;
  /** 'hand' writes a plain grant.create row; a policy action adds it; 'automatic' an automatic grant.create; 'none' nothing. */
  evidence?: 'hand' | 'automatic' | 'none' | keyof typeof POLICY;
}
const POLICY = {
  'task.creator_access': 'task', 'task.sponsor_access': 'task', 'report.creator_access': 'report',
  'report.sponsor_access': 'report', 'project.creator_access': 'project',
} as const;

async function seed(input: Seed): Promise<string> {
  const policyType = input.evidence && input.evidence in POLICY ? POLICY[input.evidence as keyof typeof POLICY] : null;
  const resourceType = input.resourceType ?? policyType ?? 'task';
  const resourceId = input.resourceId === undefined ? crypto.randomUUID() : input.resourceId;
  const row = (await pool.query(
    `INSERT INTO grants (grantee_type, grantee_id, resource_type, resource_id, verb, expires_at, created_at, provenance, origin, approval_id)
     VALUES ($1, $2, $3, $4, $5, $6, COALESCE($7::timestamptz, NOW()), $8, $9, $10) RETURNING id`,
    [input.granteeType ?? 'principal', input.granteeId, resourceType, resourceId, input.verb ?? 'read',
      input.expiresAt ?? null, input.createdAt ?? null, input.provenance ?? null, input.origin ?? 'manual', input.approvalId ?? null])).rows[0];
  const id = String(row.id);
  const evidence = input.evidence ?? 'hand';
  if (evidence !== 'none') {
    await audit('grant.create', 'grant', id, { granteeId: input.granteeId, resourceType, resourceId, verb: input.verb ?? 'read', ...(evidence === 'automatic' ? { automatic: true } : {}) });
  }
  if (policyType) await audit(evidence as string, resourceType, String(resourceId), { grantId: id, granteePrincipalId: input.granteeId });
  return id;
}

async function pageAll(who: Caller, query: string, limit: number, between?: (page: number) => Promise<void>) {
  const ids: string[] = [];
  let cursor: string | null = null, page = 0;
  do {
    const answer = await call(who, 'GET', `/grants?${query}&limit=${limit}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`);
    expect(answer.status).toBe(200);
    expect(answer.body.grants.length).toBeLessThanOrEqual(limit);
    ids.push(...answer.body.grants.map((g: any) => g.id));
    cursor = answer.body.pagination.nextCursor;
    expect(answer.body.pagination.hasMore).toBe(cursor !== null);
    page += 1;
    if (between && cursor) await between(page);
  } while (cursor && page < 500);
  return ids;
}

let root: Caller;
beforeAll(async () => {
  await pool.query("INSERT INTO principals(kind,handle,display_name,role) VALUES('human','dashboard_user','Owner','orchestrator') ON CONFLICT(handle) DO NOTHING");
  const app = express(); app.use(express.json());
  registerProtectedRoutes((mount: string, ...handlers: any[]) => app.use(mount, authMiddleware, sharedAuthorizationMiddleware, ...handlers));
  app.use(apiErrorHandler);
  await new Promise<void>(resolve => { server = app.listen(0, '127.0.0.1', resolve); });
  origin = `http://127.0.0.1:${(server.address() as any).port}`;
  root = await human('admin');
});
afterAll(async () => { if (server) await new Promise<void>(resolve => server.close(() => resolve())); await pool.end(); });

describe('origin is derived from data the board keeps, never guessed', () => {
  test('a person-made grant, a Task creator grant and a Report creator grant through the real routes', async () => {
    const user = await human('user');
    const holder = await grantee();
    const made = await call(root, 'POST', '/grants', { granteeType: 'principal', granteeId: holder, resourceType: 'project', verb: 'read' });
    expect(made.status).toBe(201);
    const task = await call(user, 'POST', '/tasks', { title: tag('task'), status: 'todo' });
    expect(task.status).toBe(201);
    const report = await call(user, 'POST', '/reports', { title: tag('report'), content: 'body', summary: 'summary' });
    expect([200, 201]).toContain(report.status);
    const reportId = report.body.report?.id ?? report.body.id;

    const byHolder = await call(root, 'GET', `/grants?limit=50&granteeId=${holder}`);
    expect(byHolder.body.grants.map((g: any) => [g.madeBy.class, g.madeBy.via, g.madeBy.evidence]))
      .toEqual([['hand', 'direct', 'audit']]);
    expect(byHolder.body.grants[0].grantedBy.id).toBe(root.id);

    const byUser = await call(root, 'GET', `/grants?limit=50&granteeId=${user.id}&sort=resource`);
    const views = byUser.body.grants.map((g: any) => `${g.resourceType}:${g.verb}:${g.madeBy.class}:${g.madeBy.via}`).sort();
    expect(views).toEqual([
      'report:read:system:report-creator', 'report:write:system:report-creator',
      'task:read:system:task-creator', 'task:write:system:task-creator',
    ]);
    const taskRow = byUser.body.grants.find((g: any) => g.resourceType === 'task');
    expect(taskRow.target).toMatchObject({ state: 'live', label: task.body.task.title });
    const reportRow = byUser.body.grants.find((g: any) => g.resourceType === 'report');
    expect(reportRow.resourceId).toBe(reportId);
  });

  test('every marker classifies by name; a row with no evidence is unknown', async () => {
    const holder = await grantee();
    const group = (await groupService.create({ name: tag('group') }, { handle: 'fixture', authMethod: 'system' })).id;
    const requester = await human('user');
    const taskId = (await call(requester, 'POST', '/tasks', { title: tag('task'), status: 'todo' })).body.task.id;
    const approval = (await pool.query(
      `INSERT INTO approvals (requester_principal_id, target_task_id, requested_scopes, session_evidence, pending_expires_at)
       VALUES ($1, $2, '[]'::jsonb, '{"fixture": true}'::jsonb, NOW() + interval '1 day') RETURNING id`, [requester.id, taskId])).rows[0].id;
    const expected: Array<[string, string, string | null, string]> = [];
    const add = async (seedInput: Seed, cls: string, via: string | null, evidence: string) => {
      const id = await seed(seedInput);
      expected.push([id, cls, via, evidence]);
    };
    await add({ granteeId: holder }, 'hand', 'direct', 'audit');
    await add({ granteeId: holder, approvalId: approval, expiresAt: new Date(Date.now() + 86400000).toISOString() }, 'hand', 'approval', 'column');
    await add({ granteeId: holder, evidence: 'none' }, 'unknown', null, 'none');
    await add({ granteeId: holder, evidence: 'automatic' }, 'system', 'automatic', 'audit');
    await add({ granteeId: holder, provenance: 'assignment:grant', evidence: 'automatic' }, 'system', 'assignment', 'column');
    await add({ granteeId: holder, provenance: 'assignment:warrant', evidence: 'none' }, 'system', 'warrant', 'column');
    for (const [action, via] of [['task.creator_access', 'task-creator'], ['task.sponsor_access', 'task-sponsor'],
      ['report.creator_access', 'report-creator'], ['report.sponsor_access', 'report-sponsor'],
      ['project.creator_access', 'project-creator']] as const) {
      await add({ granteeId: holder, evidence: action }, 'system', via, 'audit');
    }
    const groupRow = await seed({ granteeId: group, granteeType: 'group', resourceType: 'project', origin: 'creation-default', evidence: 'none' });

    const rows = (await call(root, 'GET', `/grants?limit=200&granteeId=${holder}`)).body.grants;
    const seen = new Map(rows.map((g: any) => [g.id, [g.madeBy.class, g.madeBy.via, g.madeBy.evidence]]));
    for (const [id, cls, via, evidence] of expected) expect([id, ...(seen.get(id) as unknown[])]).toEqual([id, cls, via, evidence]);
    const groupView = (await call(root, 'GET', `/grants?limit=200&granteeId=${group}`)).body.grants;
    expect(groupView.map((g: any) => [g.id, g.madeBy.class, g.madeBy.via])).toEqual([[groupRow, 'system', 'project-default']]);
    // A policy row that names ANOTHER grant marks nothing here.
    const stray = await seed({ granteeId: holder });
    await audit('task.creator_access', 'task', crypto.randomUUID(), { grantId: stray });
    const strayView = (await call(root, 'GET', `/grants?limit=200&granteeId=${holder}&made=hand`)).body.grants.map((g: any) => g.id);
    expect(strayView).toContain(stray);
  });
});

describe('paging: no duplicates and no gaps while rows are written', () => {
  for (const sort of ['-created', 'created', 'grantee', '-grantee', 'resource', '-resource', 'verb', '-verb', 'expires', '-expires']) {
    test(`sort ${sort}`, async () => {
      const holder = await grantee();
      const tie = new Date(Date.now() - 3600000).toISOString();
      const initial: string[] = [];
      for (let i = 0; i < 61; i += 1) {
        initial.push(await seed({
          granteeId: holder, verb: ['read', 'write', 'use'][i % 3], resourceType: ['task', 'report', 'skill'][i % 3],
          // Every fifth row shares one instant: the id breaks the tie.
          createdAt: i % 5 === 0 ? tie : new Date(Date.now() - (i + 1) * 60000).toISOString(),
          expiresAt: i % 4 === 0 ? null : new Date(Date.now() + (i + 2) * 86400000).toISOString(),
        }));
      }
      const deleted = new Set<string>();
      const ids = await pageAll(root, `granteeId=${holder}&made=hand&sort=${encodeURIComponent(sort)}`, 7, async (page) => {
        // Between pages: two new rows land and one not-yet-served row is revoked.
        await seed({ granteeId: holder, resourceType: 'task' });
        await seed({ granteeId: holder, resourceType: 'skill', createdAt: new Date(Date.now() - 7200000).toISOString() });
        const victim = initial[(page * 13) % initial.length];
        if (!deleted.has(victim)) {
          deleted.add(victim);
          await pool.query('DELETE FROM grants WHERE id = $1', [victim]);
        }
      });
      expect(new Set(ids).size).toBe(ids.length);
      for (const id of initial) if (!deleted.has(id)) expect(ids).toContain(id);
    });
  }

  test('pages agree with one ordered read, and the cursor is bound to its sort', async () => {
    const holder = await grantee();
    for (let i = 0; i < 25; i += 1) await seed({ granteeId: holder, verb: i % 2 ? 'read' : 'write' });
    const whole = (await call(root, 'GET', `/grants?granteeId=${holder}&limit=200&sort=verb`)).body.grants.map((g: any) => g.id);
    expect(await pageAll(root, `granteeId=${holder}&sort=verb`, 4)).toEqual(whole);
    const first = await call(root, 'GET', `/grants?granteeId=${holder}&limit=4&sort=verb`);
    const crossed = await call(root, 'GET', `/grants?granteeId=${holder}&limit=4&sort=-created&cursor=${encodeURIComponent(first.body.pagination.nextCursor)}`);
    expect(crossed.status).toBe(400);
    expect(crossed.body.code).toBe('INVALID_QUERY_VALUE');
    expect(first.body.pagination).toMatchObject({ limit: 4, total: 25, returned: 4, hasMore: true, sort: 'verb' });
  });
});

// Round-1 review of card ff410dc4 (the blocker): a 500-character Task title
// gave a 750-character nextCursor that the server itself refused, so Load more
// and the CLI's --cursor stopped under sort=resource. Here every sort walks,
// one row per page, across keys at and past every length the board allows:
// 500-character Task and Report titles (the varchar(500) limit), a 255-
// character Project name, and Phase and Group names (no length limit) that
// share their first 600 characters, all multibyte, so the walk crosses the
// key bound and its id tiebreak.
describe('paging across long, multibyte sort keys', () => {
  const fill = (n: number, unit: string) => {
    const out: string[] = [];
    while (out.length < n) out.push(...Array.from(unit));
    return out.slice(0, n).join('');
  };
  const chars = (text: string) => Array.from(text).length;

  test('every sort pages to the end with no gap and no duplicate, and every issued cursor is accepted', async () => {
    const { GRANT_CURSOR_MAX_LENGTH } = require('../services/GrantListService');
    const marker = tag('longkey');
    const named = (n: number, unit: string) => `${marker} ${fill(n - chars(marker) - 1, unit)}`;
    const user = await human('user');
    const taskTitle = named(500, 'Zażółć gęślą jaźń 東京 task ');
    const task = await call(user, 'POST', '/tasks', { title: taskTitle, status: 'todo' });
    expect(task.status).toBe(201);
    expect(chars(task.body.task.title)).toBe(500);
    const report = await call(user, 'POST', '/reports', { title: named(500, 'Łódź 名古屋 report '), content: 'body', summary: 'summary' });
    expect([200, 201]).toContain(report.status);
    const reportId = report.body.report?.id ?? report.body.id;
    const project = (await pool.query('INSERT INTO projects (name) VALUES ($1) RETURNING id', [named(255, 'Kraków 大阪 project ')])).rows[0].id;
    // Phase and Group names have no length limit: two of each share their
    // first 600 characters (past the key bound), with astral and control
    // characters, and differ only after it.
    const shared = named(600, 'Gdańsk \u{1F600} 札幌 \u0007 ');
    const phaseIds: string[] = [];
    for (const tail of ['A', 'B']) {
      phaseIds.push((await pool.query('INSERT INTO phases (project_id, name) VALUES ($1, $2) RETURNING id',
        [project, `${shared}${fill(100, `${tail} 終 `)}`])).rows[0].id);
    }
    const groupIds: string[] = [];
    for (const tail of ['a', 'b']) {
      const id = (await groupService.create({ name: tag('lkgroup') }, { handle: 'fixture', authMethod: 'system' })).id;
      await pool.query('UPDATE groups SET name = $2 WHERE id = $1', [id, `${shared}${fill(100, `${tail} 終 `)}`]);
      groupIds.push(id);
    }
    const holder = await grantee(`${marker}-holder`);
    const seeds: Seed[] = [
      ...['read', 'write', 'admin'].map(verb => ({ granteeId: holder, resourceType: 'task', resourceId: task.body.task.id, verb })),
      ...['read', 'write'].map(verb => ({ granteeId: holder, resourceType: 'report', resourceId: reportId, verb })),
      { granteeId: holder, resourceType: 'project', resourceId: project },
      { granteeId: holder, resourceType: 'phase', resourceId: phaseIds[0] },
      { granteeId: holder, resourceType: 'phase', resourceId: phaseIds[0], verb: 'write' },
      { granteeId: holder, resourceType: 'phase', resourceId: phaseIds[1] },
      { granteeId: groupIds[0], granteeType: 'group', resourceType: 'task', resourceId: task.body.task.id },
      { granteeId: groupIds[0], granteeType: 'group', resourceType: 'phase', resourceId: phaseIds[0], verb: 'use' },
      { granteeId: groupIds[1], granteeType: 'group', resourceType: 'phase', resourceId: phaseIds[1] },
    ];
    for (const input of seeds) await seed(input);
    // Every grant on these objects or held by these grantees, the Task and
    // Report creator grants included: all of them match the search.
    const expected = (await pool.query(
      'SELECT id FROM grants WHERE resource_id = ANY($1::uuid[]) OR grantee_id = ANY($2::uuid[])',
      [[task.body.task.id, reportId, project, ...phaseIds], [holder, ...groupIds]])).rows.map((row: any) => String(row.id)).sort();
    expect(expected.length).toBeGreaterThanOrEqual(seeds.length + 4);

    for (const sort of ['resource', '-resource', 'grantee', '-grantee', 'verb', '-verb', 'created', '-created', 'expires', '-expires']) {
      const query = `q=${encodeURIComponent(marker)}&made=all&sort=${encodeURIComponent(sort)}`;
      const whole = (await call(root, 'GET', `/grants?${query}&limit=200`)).body.grants.map((g: any) => g.id);
      expect([sort, [...whole].sort()]).toEqual([sort, expected]);
      const walked: string[] = [];
      const lengths: number[] = [];
      let cursor: string | null = null;
      for (let page = 0; page <= expected.length; page += 1) {
        const answer = await call(root, 'GET', `/grants?${query}&limit=1${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`);
        expect([sort, page, answer.status, answer.body.code]).toEqual([sort, page, 200, undefined]);
        walked.push(...answer.body.grants.map((g: any) => g.id));
        cursor = answer.body.pagination.nextCursor;
        if (!cursor) break;
        lengths.push(cursor.length);
      }
      expect([sort, cursor]).toEqual([sort, null]);
      // The one-row pages, end to end, ARE the one ordered read.
      expect([sort, walked]).toEqual([sort, whole]);
      for (const length of lengths) expect([sort, length <= GRANT_CURSOR_MAX_LENGTH]).toEqual([sort, true]);
      // The text sorts carried a key past the old fixed cap: the walk above
      // crossed exactly the cursors round 1 refused.
      if (/^-?(resource|grantee)$/.test(sort)) expect([sort, Math.max(...lengths) > 600]).toEqual([sort, true]);
    }
  });

  test('a cursor the list did not issue is refused by name, never answered 500', async () => {
    const { encodeGrantCursor, GRANT_SORT_KEY_MAX_CHARS, GRANT_CURSOR_MAX_LENGTH } = require('../services/GrantListService');
    const id = crypto.randomUUID();
    const forged: Array<[string, string]> = [
      ['resource', encodeGrantCursor('resource', 'a'.repeat(GRANT_SORT_KEY_MAX_CHARS + 1), id)],
      ['-grantee', encodeGrantCursor('-grantee', 'é'.repeat(GRANT_SORT_KEY_MAX_CHARS + 1), id)],
      ['resource', `gc1.${'A'.repeat(GRANT_CURSOR_MAX_LENGTH)}`],
      ['created', encodeGrantCursor('created', 'not a time', id)],
      ['-expires', encodeGrantCursor('-expires', '2026-13-45 99:00:00+00', id)],
      ['grantee', encodeGrantCursor('grantee', 'nul \u0000 inside', id)],
    ];
    for (const [sort, cursor] of forged) {
      const answer = await call(root, 'GET', `/grants?limit=5&sort=${encodeURIComponent(sort)}&cursor=${encodeURIComponent(cursor)}`);
      expect([sort, cursor.slice(0, 24), answer.status, answer.body.code, answer.body.details?.field])
        .toEqual([sort, cursor.slice(0, 24), 400, 'INVALID_QUERY_VALUE', 'cursor']);
    }
  });
});

describe('the default view, filters, sort and search', () => {
  test('made=hand is the hand-made set, with per-class counts of what it hides', async () => {
    const holder = await grantee();
    const hand = [await seed({ granteeId: holder }), await seed({ granteeId: holder })];
    await seed({ granteeId: holder, evidence: 'task.creator_access' });
    await seed({ granteeId: holder, evidence: 'report.creator_access' });
    await seed({ granteeId: holder, evidence: 'none' });
    const answer = await call(root, 'GET', `/grants?granteeId=${holder}&made=hand&limit=50`);
    expect(answer.body.grants.map((g: any) => g.id).sort()).toEqual([...hand].sort());
    expect(answer.body.madeCounts).toEqual({ hand: 2, system: 2, unknown: 1 });
    expect(answer.body.pagination.total).toBe(2);
  });

  test('each filter narrows inside the statement', async () => {
    const holder = await grantee(tag('needle'));
    const user = await human('user');
    const live = (await call(user, 'POST', '/tasks', { title: tag('Quarterly') + ' 100%_done', status: 'todo' })).body.task;
    const archived = (await call(user, 'POST', '/tasks', { title: tag('archived'), status: 'todo' })).body.task;
    await pool.query("UPDATE tasks SET status = 'archived' WHERE id = $1", [archived.id]);
    const day = 86400000;
    const ids = {
      liveTask: await seed({ granteeId: holder, resourceType: 'task', resourceId: live.id, verb: 'write' }),
      archivedTask: await seed({ granteeId: holder, resourceType: 'task', resourceId: archived.id }),
      missingTask: await seed({ granteeId: holder, resourceType: 'task' }),
      wildcard: await seed({ granteeId: holder, resourceType: 'skill', resourceId: null, verb: 'use' }),
      expired: await seed({ granteeId: holder, resourceType: 'report', verb: 'read' }),
      expiring: await seed({ granteeId: holder, resourceType: 'report', expiresAt: new Date(Date.now() + 3 * day).toISOString() }),
      later: await seed({ granteeId: holder, resourceType: 'report', expiresAt: new Date(Date.now() + 60 * day).toISOString() }),
    };
    await pool.query("UPDATE grants SET expires_at = NOW() - interval '1 hour' WHERE id = $1", [ids.expired]);
    const ask = async (query: string) => (await call(root, 'GET', `/grants?granteeId=${holder}&limit=200&${query}`)).body.grants.map((g: any) => g.id).sort();
    const of = (...names: Array<keyof typeof ids>) => names.map(n => ids[n]).sort();
    expect(await ask('target=archived')).toEqual(of('archivedTask'));
    expect(await ask('target=missing')).toEqual(of('missingTask', 'expired', 'expiring', 'later'));
    expect(await ask('target=wildcard')).toEqual(of('wildcard'));
    expect(await ask('target=live')).toEqual(of('liveTask'));
    expect(await ask('expiry=expired')).toEqual(of('expired'));
    expect(await ask('expiry=expiring')).toEqual(of('expiring'));
    expect(await ask('expiry=none')).toEqual(of('liveTask', 'archivedTask', 'missingTask', 'wildcard'));
    expect(await ask('expiry=live')).toEqual(of('liveTask', 'archivedTask', 'missingTask', 'wildcard', 'expiring', 'later'));
    expect(await ask('verb=write')).toEqual(of('liveTask'));
    expect(await ask('resourceType=skill')).toEqual(of('wildcard'));
    // Search: the Task title (with LIKE metacharacters taken literally) and the grantee handle.
    expect(await ask(`q=${encodeURIComponent('100%_done')}`)).toEqual(of('liveTask'));
    expect(await ask(`q=${encodeURIComponent('0%_d')}`)).toEqual(of('liveTask'));
    expect(await ask(`q=${encodeURIComponent('%')}`)).toEqual(of('liveTask'));
    expect((await ask('q=needle')).length).toBe(7);
    expect(await ask(`q=${ids.wildcard.slice(0, 13)}`)).toEqual(of('wildcard'));
    const archivedRow = (await call(root, 'GET', `/grants?granteeId=${holder}&limit=5&target=archived`)).body.grants[0];
    expect(archivedRow.target).toMatchObject({ state: 'archived', status: 'archived', label: archived.title });
  });

  test('each sort orders as the rows say it should', async () => {
    const holder = await grantee();
    const day = 86400000;
    for (let i = 0; i < 9; i += 1) {
      await seed({ granteeId: holder, verb: ['admin', 'read', 'write'][i % 3], resourceType: ['task', 'project', 'report'][i % 3],
        expiresAt: i % 3 === 0 ? null : new Date(Date.now() + (10 - i) * day).toISOString(),
        createdAt: new Date(Date.now() - i * 1000).toISOString() });
    }
    const rows = async (sort: string) => (await call(root, 'GET', `/grants?granteeId=${holder}&limit=50&sort=${encodeURIComponent(sort)}`)).body.grants;
    const created = (await rows('-created')).map((g: any) => Date.parse(g.createdAt));
    expect(created).toEqual([...created].sort((a, b) => b - a));
    const verbs = (await rows('verb')).map((g: any) => g.verb);
    expect(verbs).toEqual([...verbs].sort());
    const types = (await rows('-resource')).map((g: any) => g.resourceType);
    expect(types).toEqual([...types].sort().reverse());
    const expiries = (await rows('expires')).map((g: any) => g.expiresAt ? Date.parse(g.expiresAt) : Infinity);
    expect(expiries).toEqual([...expiries].sort((a, b) => a - b));
    expect(expiries[expiries.length - 1]).toBe(Infinity);
  });

  test('the legacy read without limit or cursor is unchanged in shape: every row, creation order, no pagination', async () => {
    const holder = await grantee();
    const a = await seed({ granteeId: holder, createdAt: new Date(Date.now() - 5000).toISOString() });
    const b = await seed({ granteeId: holder, createdAt: new Date(Date.now() - 1000).toISOString() });
    const legacy = await call(root, 'GET', `/grants?granteeId=${holder}`);
    expect(legacy.status).toBe(200);
    expect(legacy.body.grants.map((g: any) => g.id)).toEqual([a, b]);
    expect(legacy.body).not.toHaveProperty('pagination');
  });

  test('a malformed parameter is refused by name, never answered with an empty page', async () => {
    for (const query of ['limit=0', 'limit=201', 'limit=x', 'made=person', 'sort=title', 'expiry=soon', 'target=gone', 'verb=own', 'cursor=gc1.bm9wZQ', 'granteeId=abc']) {
      const answer = await call(root, 'GET', `/grants?${query}`);
      expect([query, answer.status, answer.body.code]).toEqual([query, 400, 'INVALID_QUERY_VALUE']);
    }
  });
});

describe('authorization of the paged read is unchanged', () => {
  test('two Accounts without root see no grant, paged or not; a root Account does', async () => {
    const holder = await grantee();
    await seed({ granteeId: holder });
    for (const role of ['user', 'viewer']) {
      const account = await human(role);
      await seed({ granteeId: account.id });
      for (const path of ['/grants', '/grants?limit=10', `/grants?limit=10&granteeId=${account.id}`, '/grants?limit=10&made=all']) {
        const answer = await call(account, 'GET', path);
        expect([role, path, answer.status]).toEqual([role, path, 403]);
        expect(answer.body.grants).toBeUndefined();
      }
    }
    const parent = await human('admin');
    const service = (await pool.query(
      "INSERT INTO principals(kind,handle,status,parent_principal_id,purpose,own_expression) VALUES('service',$1,'active',$2,'Grants list fixture',$3) RETURNING id",
      [tag('svc'), parent.id, JSON.stringify({ scopes: 'parent', objects: 'parent' })])).rows[0].id;
    const issued = await principalService.issueCredential({ principalId: service, scopes: ['tasks:read', 'principals:read', 'audit:read'], transport: 'any' }, { handle: 'fixture', authMethod: 'system' });
    const bearer = { id: service, headers: { Authorization: `Bearer ${issued.fullKey}` } };
    expect((await call(bearer, 'GET', '/grants?limit=10')).status).toBe(403);
    expect((await call(root, 'GET', `/grants?limit=10&granteeId=${holder}`)).body.grants).toHaveLength(1);
  });
});

describe('the default query on a seeded table', () => {
  test('EXPLAIN: the audit lookups use the existing resource index, and one page is fast', async () => {
    const holders = [await grantee(), await grantee(), await grantee()];
    // About four thousand grants, the census's size, most of them creator rows.
    await pool.query(`
      WITH made AS (
        INSERT INTO grants (grantee_type, grantee_id, resource_type, resource_id, verb, created_at)
        SELECT 'principal', ($1::uuid[])[1 + (n % 3)], CASE WHEN n % 3 = 0 THEN 'task' ELSE 'report' END,
               gen_random_uuid(), CASE WHEN n % 2 = 0 THEN 'read' ELSE 'write' END, NOW() - (n || ' seconds')::interval
          FROM generate_series(1, 4000) AS n
        RETURNING id, resource_type, resource_id, grantee_id
      ), created AS (
        INSERT INTO audit_events (action, actor_handle, auth_method, outcome, resource_type, resource_id, metadata)
        SELECT 'grant.create', 'fixture', 'system', 'success', 'grant', id::text, '{}'::jsonb FROM made
      )
      INSERT INTO audit_events (action, actor_handle, auth_method, outcome, resource_type, resource_id, metadata)
      SELECT CASE WHEN resource_type = 'task' THEN 'task.creator_access' ELSE 'report.creator_access' END,
             'fixture', 'system', 'success', resource_type, resource_id::text, jsonb_build_object('grantId', id::text)
        FROM made WHERE right(id::text, 1) <> '0'`, [holders]);
    await pool.query('ANALYZE grants'); await pool.query('ANALYZE audit_events');
    // Required here, not at the top: every other case measures the ROUTE, so
    // it can be run against a build that predates this service (red-first).
    const { buildGrantPageStatement, parseGrantListQuery } = require('../services/GrantListService');
    const statement = buildGrantPageStatement(parseGrantListQuery({ limit: '50', made: 'hand' }));
    const explained = (await pool.query(`EXPLAIN (ANALYZE, FORMAT JSON) ${statement.sql}`, statement.params)).rows[0]['QUERY PLAN'][0];
    const nodes: any[] = [];
    const walk = (node: any) => { nodes.push(node); (node.Plans ?? []).forEach(walk); };
    walk(explained.Plan);
    const auditScans = nodes.filter(n => n['Relation Name'] === 'audit_events');
    // eslint-disable-next-line no-console
    console.log(`grants list EXPLAIN: ${explained['Execution Time']} ms; audit_events scans: ${auditScans.map(n => `${n['Node Type']}(${n['Index Name'] ?? '-'})`).join(', ')}`);
    expect(auditScans.length).toBeGreaterThan(0);
    for (const scan of auditScans) expect(scan['Node Type']).not.toBe('Seq Scan');
    expect(auditScans.some(n => n['Index Name'] === 'ix_audit_events_resource_order')).toBe(true);
    expect(explained['Execution Time']).toBeLessThan(5000);
    const answer = await call(root, 'GET', '/grants?limit=50&made=hand');
    expect(answer.status).toBe(200);
    expect(answer.body.grants.length).toBeLessThanOrEqual(50);
  });
});
