/**
 * Card 76369965 — `relayhall_lease_claim` over MCP, measured against a REAL
 * PostgreSQL through the PRODUCTION MCP route and the PRODUCTION router.
 *
 * The defect: the tool sent only `{leaseSeconds}` to
 * `POST /tasks/orchestration/:id/claim`, a route that requires
 * `snapshotUpdatedAt`, `harness` and `resourceKey` and reads the duration as
 * `ttlSeconds`, so no call through the tool could ever take a Lease. The
 * repair gives the tool the route's own arguments; the route stays the one
 * place that decides who may claim and when.
 *
 * WHAT IS MEASURED, by test, every call a JSON-RPC `tools/call` on `/mcp`
 * with a bootstrapped `rh_` bearer:
 *  (a) the advertised schema carries the route's three required fields;
 *  (b) a Connector an administrator gave the `reviewer` role (the role act,
 *      `POST /principals/:id/role`, through a login session) reads the Task
 *      snapshot through `relayhall_task_get`, claims it, and gets the Lease:
 *      the Task is In Progress, the stored Lease names the key and harness it
 *      was sent, and its duration is the one `leaseSeconds` asked for; an
 *      exact retry answers the SAME Lease with acquired=false (the retry
 *      sentence);
 *  (c) renew and release round-trip on that Lease through their tools;
 *  (d) a `qa`-role Connector, the route's other admitted bearer, claims too;
 *  (e) the route's refusals reach the caller by name and change nothing: a
 *      Connector without a role and an Agent without a role (Task-lifecycle
 *      role `agent`) get the 403 implementation-agent refusal, the Task's own
 *      Verifier CLAIMANT_VERIFIER_CONFLICT, a stale snapshot
 *      STALE_TASK_SNAPSHOT, and a call missing a field the route's own 400;
 *  (f) the boundary is the role, not the layer: an Agent an administrator
 *      gave the `reviewer` role claims, and a role-less Agent of the same
 *      shape under the same Connector is refused with 403;
 *  (g) a `leaseSeconds` that is not a whole number of at least 1 is refused
 *      by the tool as LEASE_SECONDS_INVALID before the route is called, and
 *      nothing is written.
 *
 * WHO MAY CLAIM. The route admits a caller whose Task-lifecycle role
 * (`resolveTaskLifecycleRole`) is `reviewer`, `qa` or `orchestrator` and
 * refuses `agent`. Over MCP every caller is an `rh_` bearer, and bearers exist
 * only at the Connector and Agent layers (Accounts are keyless,
 * `assertCredentialPolicy`); `orchestrator` and `admin` belong only to a
 * parentless human Account (migration 096 `principals_elevated_parentless`),
 * so they never reach this surface. The role therefore comes from the role
 * act on the Connector or the Agent (`reviewer` or `qa`), or, for a principal
 * whose role is NULL, from the legacy handle mapping in `resolveActorRole`
 * (utils/taskAutomationRole.ts), which resolves a few fixed handles to
 * `reviewer` or `qa`. A Connector or Agent with no role and no mapped handle
 * resolves to `agent`. Every fixture here has a generated handle, so the
 * mapping never applies to it.
 *
 * RED PROOF ON MAIN. Before the repair the tool's own argument check refused
 * every field the route needs, so (a), (b), (c) and (d) fail at their
 * assertions; the refusal tests then pass only where the refusal does not
 * depend on the tool reaching the route.
 *
 * NEVER SKIPS. Without RELAYHALL_TEST_DB_URL it throws, and it refuses a
 * deployment database: this suite writes. Bring the database up with
 * `database/init.sql` and `npm run migrate`, and throw it away afterwards.
 */

/* eslint-disable @typescript-eslint/no-var-requires */

import http from 'http';
import crypto from 'crypto';

const TEST_DB_URL = process.env.RELAYHALL_TEST_DB_URL;
if (!TEST_DB_URL) {
  throw new Error('RELAYHALL_TEST_DB_URL is required: the Lease claim is a stored row written through the '
    + 'production router, so this suite never skips. Load database/init.sql into a disposable database, run '
    + 'npm run migrate, and point RELAYHALL_TEST_DB_URL at it.');
}
const parsed = new URL(TEST_DB_URL);
const TEST_DB_NAME = decodeURIComponent(parsed.pathname.slice(1));
const localDisposable = ['127.0.0.1', 'localhost', '[::1]'].includes(parsed.hostname)
  && /test|contract|fixture/.test(TEST_DB_NAME);
const ciService = process.env.CI === 'true' && parsed.hostname === 'postgres' && TEST_DB_NAME === 'relayhall_ci';
if (!['postgres:', 'postgresql:'].includes(parsed.protocol)
  || ['relayhall', 'relayhall_dev', 'relayhall_tst', 'relayhall_prod'].includes(TEST_DB_NAME)
  || (!localDisposable && !ciService)) {
  throw new Error('The MCP Lease claim suite refuses a non-disposable database target');
}

// The production pool reads DB_* at import time, so the environment is pinned
// BEFORE anything is required.
Object.assign(process.env, {
  DB_HOST: parsed.hostname, DB_PORT: parsed.port || '5432', DB_NAME: TEST_DB_NAME,
  DB_USER: decodeURIComponent(parsed.username), DB_PASSWORD: decodeURIComponent(parsed.password),
  NODE_ENV: 'test', RELAYHALL_SESSIONS: 'on', JWT_SECRET: crypto.randomBytes(32).toString('hex'),
});

const express = require('express');
const { pool } = require('../db/connection');
const { registerProtectedRoutes } = require('../routeRegistry');
const { authMiddleware } = require('../middleware/auth');
const { sharedAuthorizationMiddleware } = require('../middleware/sharedAuthorization');
const { apiErrorHandler } = require('../utils/apiErrors');
const { jsonBodyOptions } = require('../utils/jsonBodyTypes');
const { principalService } = require('../services/PrincipalService');
const { loginSessionService, SESSION_COOKIE_NAME } = require('../services/LoginSessionService');
const mcpRoutes = require('../mcp/httpRoute').default;
const { MCP_ROUTE_PATH } = require('../mcp/httpRoute');

// Real credential issuance and PostgreSQL in beforeAll: the default 5 s hook
// budget fails on a loaded runner before any assertion runs.
jest.setTimeout(180_000);

let server: http.Server;
let origin: string;

function buildApp(): any {
  const app = express();
  app.use(express.json(jsonBodyOptions));
  app.use(express.urlencoded({ extended: true }));
  // The MCP ingress outside the REST funnel, exactly as server.ts mounts it.
  app.use(MCP_ROUTE_PATH, mcpRoutes);
  registerProtectedRoutes((mountPath: string, ...handlers: any[]) => {
    app.use(mountPath, authMiddleware, sharedAuthorizationMiddleware, ...handlers);
  });
  app.use(apiErrorHandler);
  return app;
}

async function rpc(token: string, method: string, params: Record<string, unknown>): Promise<any> {
  const response = await fetch(`${origin}${MCP_ROUTE_PATH}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  return JSON.parse(await response.text());
}

/** One JSON-RPC tools/call over the REAL `/mcp` route, as a stock client makes it. */
async function mcp(token: string, name: string, args: Record<string, unknown> = {}): Promise<{ text: string; isError: boolean }> {
  const json = await rpc(token, 'tools/call', { name, arguments: args });
  return {
    text: String(json?.result?.content?.[0]?.text ?? JSON.stringify(json?.error ?? json)),
    isError: Boolean(json?.result?.isError) || Boolean(json?.error),
  };
}

const tag = (): string => crypto.randomBytes(5).toString('hex');
const SYSTEM_ACTOR = { handle: 'mcp-lease-claim-suite', authMethod: 'system' as const };
const SCOPES = ['tasks:read', 'tasks:write'];
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/;

interface Caller { label: string; principalId: string; token: string; grantees: string[] }

let adminCookie: string;

/** Give `principalId` a role through the administrator's role act, as the dashboard does. */
async function roleAct(principalId: string, role: string): Promise<void> {
  const response = await fetch(`${origin}/principals/${principalId}/role`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: adminCookie },
    body: JSON.stringify({ role }),
  });
  expect([role, response.status, response.status === 200 ? null : await response.text()]).toEqual([role, 200, null]);
}

/** A Connector (role NULL) under an ordinary `user` Account. */
async function connector(label: string): Promise<Caller & { accountId: string }> {
  const account = await pool.query(
    `INSERT INTO principals (kind, handle, display_name, status, role)
     VALUES ('human', $1, $1, 'active', 'user') RETURNING id`,
    [`mlc-${label}-account-${tag()}`],
  );
  const accountId = String(account.rows[0].id);
  const row = await pool.query(
    `INSERT INTO principals (kind, handle, display_name, status, parent_principal_id, purpose, own_expression)
     VALUES ('service', $1, $2, 'active', $3, 'MCP lease claim suite connector', $4::jsonb) RETURNING id`,
    [`mlc-${label}-${tag()}`, `Lease claim suite ${label}`, accountId, JSON.stringify({ scopes: 'parent', objects: 'parent' })],
  );
  const principalId = String(row.rows[0].id);
  const issued = await principalService.issueCredential({ principalId, scopes: SCOPES, transport: 'mcp' }, SYSTEM_ACTOR);
  return { label, principalId, accountId, token: issued.fullKey, grantees: [accountId, principalId] };
}

/** An Agent bound to `taskId` under `parent`, as the mint writes the row (role NULL). */
async function agent(parent: Caller & { accountId: string }, taskId: string): Promise<Caller> {
  const row = await pool.query(
    `INSERT INTO principals (kind, handle, display_name, role, status, parent_principal_id, bound_task_id,
                             bound_task_role, own_expression, source_tag)
     VALUES ('agent', $1, 'Lease claim suite agent', NULL, 'active', $2, $3, 'implementer', $4::jsonb, $5)
     RETURNING id, handle`,
    [`agent-${tag()}`, parent.principalId, taskId, JSON.stringify({ scopes: SCOPES, objects: 'parent' }), `agent-mint:mlc-${tag()}`],
  );
  const principalId = String(row.rows[0].id);
  const issued = await principalService.issueCredential({ principalId, scopes: SCOPES, transport: 'mcp' }, SYSTEM_ACTOR);
  return { label: 'agent', principalId, token: issued.fullKey, grantees: [parent.accountId, parent.principalId, principalId] };
}

/** An armed To-Do Task every named caller may write. */
async function readyTask(callers: Caller[], verifierPrincipalId: string | null = null): Promise<string> {
  const id = String((await pool.query(
    `INSERT INTO tasks (title, status, auto_start, verifier_principal_id)
     VALUES ($1, 'todo', TRUE, $2) RETURNING id`,
    [`Lease claim suite ${tag()}`, verifierPrincipalId],
  )).rows[0].id);
  for (const grantee of new Set(callers.flatMap((caller) => caller.grantees))) {
    await pool.query(
      `INSERT INTO grants (grantee_type, grantee_id, resource_type, resource_id, verb)
       VALUES ('principal', $1, 'task', $2, 'write')`,
      [grantee, id],
    );
  }
  return id;
}

async function grantWrite(principalId: string, taskId: string): Promise<void> {
  await pool.query(
    `INSERT INTO grants (grantee_type, grantee_id, resource_type, resource_id, verb)
     VALUES ('principal', $1, 'task', $2, 'write')`,
    [principalId, taskId],
  );
}

async function bootstrap(caller: Caller): Promise<void> {
  const brief = await mcp(caller.token, 'relayhall_brief_compile', { session: true });
  expect([caller.label, brief.isError]).toEqual([caller.label, false]);
}

/** The Task's `updated` exactly as `relayhall_task_get` (detailed) reports it. */
async function snapshot(caller: Caller, taskId: string): Promise<string> {
  const read = await mcp(caller.token, 'relayhall_task_get', { task: taskId, response_format: 'detailed' });
  expect(read.isError).toBe(false);
  const updated = JSON.parse(read.text)?.task?.updated;
  expect(typeof updated).toBe('string');
  return String(updated);
}

async function taskStatus(taskId: string): Promise<string> {
  return String((await pool.query('SELECT status FROM tasks WHERE id = $1', [taskId])).rows[0].status);
}

async function leases(taskId: string): Promise<any[]> {
  return (await pool.query(
    `SELECT id, status, harness, resource_key, heartbeat_at, expires_at, acquired_at,
            EXTRACT(EPOCH FROM (expires_at - acquired_at))::float AS ttl
       FROM task_execution_leases WHERE task_id = $1 ORDER BY acquired_at`,
    [taskId],
  )).rows;
}

let reviewerConnector: Caller;
let qaConnector: Caller;
let plainConnector: Caller & { accountId: string };

beforeAll(async () => {
  server = buildApp().listen(0);
  await new Promise<void>((resolve) => server.once('listening', () => resolve()));
  origin = `http://127.0.0.1:${(server.address() as any).port}`;
  const admin = await pool.query(
    `INSERT INTO principals (kind, handle, display_name, status, role)
     VALUES ('human', $1, $1, 'active', 'admin') RETURNING id`,
    [`mlc-admin-${tag()}`],
  );
  const minted = await loginSessionService.mint({ principalId: String(admin.rows[0].id) });
  adminCookie = `${SESSION_COOKIE_NAME}=${minted.token}`;
  reviewerConnector = await connector('reviewer');
  await roleAct(reviewerConnector.principalId, 'reviewer');
  qaConnector = await connector('qa');
  await roleAct(qaConnector.principalId, 'qa');
  plainConnector = await connector('connector');
  for (const caller of [reviewerConnector, qaConnector, plainConnector]) await bootstrap(caller);
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await pool.end();
});

describe('relayhall_lease_claim over MCP (card 76369965)', () => {
  it('(a) advertises the route\'s required fields', async () => {
    const listed = await rpc(reviewerConnector.token, 'tools/list', {});
    const tool = (listed?.result?.tools ?? []).find((entry: any) => entry.name === 'relayhall_lease_claim');
    expect(tool?.inputSchema?.required).toEqual(['task', 'snapshotUpdatedAt', 'harness', 'resourceKey']);
    expect(tool?.inputSchema?.properties?.harness?.enum).toEqual(['hermes', 'openclaw']);
  });

  it('(b) a reviewer-role Connector claims a ready Task and gets the Lease; an exact retry answers the same Lease', async () => {
    const taskId = await readyTask([reviewerConnector]);
    const snapshotUpdatedAt = await snapshot(reviewerConnector, taskId);
    const resourceKey = `worktree-${tag()}`;
    const args = { task: taskId, snapshotUpdatedAt, harness: 'hermes', resourceKey, leaseSeconds: 120 };

    const claimed = await mcp(reviewerConnector.token, 'relayhall_lease_claim', args);
    expect([claimed.isError, claimed.text]).toEqual([false, expect.stringContaining('Claimed Task')]);
    const leaseId = claimed.text.match(UUID)?.[0];
    expect(await taskStatus(taskId)).toBe('in-progress');
    const stored = await leases(taskId);
    expect(stored.map((row) => [String(row.id), row.status, row.harness, row.resource_key]))
      .toEqual([[leaseId, 'active', 'hermes', resourceKey]]);
    // `leaseSeconds` reaches the route as `ttlSeconds`: 120 s, not the 900 s default.
    expect(Math.round(stored[0].ttl)).toBe(120);

    const retried = await mcp(reviewerConnector.token, 'relayhall_lease_claim', args);
    expect(retried.isError).toBe(false);
    expect(retried.text).toContain('acquired=false');
    expect(retried.text.match(UUID)?.[0]).toBe(leaseId);
    expect((await leases(taskId)).length).toBe(1);
  });

  it('(c) renew and release round-trip on the claimed Lease', async () => {
    const taskId = await readyTask([reviewerConnector]);
    const claimed = await mcp(reviewerConnector.token, 'relayhall_lease_claim', {
      task: taskId, snapshotUpdatedAt: await snapshot(reviewerConnector, taskId), harness: 'openclaw', resourceKey: `worktree-${tag()}`,
    });
    expect(claimed.isError).toBe(false);
    const leaseId = String(claimed.text.match(UUID)?.[0]);
    const before = (await leases(taskId))[0];

    const renewed = await mcp(reviewerConnector.token, 'relayhall_lease_renew', { task: taskId, leaseId });
    expect([renewed.isError, renewed.text]).toEqual([false, expect.stringContaining('renewed until')]);
    const after = (await leases(taskId))[0];
    expect(new Date(after.heartbeat_at).getTime()).toBeGreaterThan(new Date(before.heartbeat_at).getTime());

    const released = await mcp(reviewerConnector.token, 'relayhall_lease_release', { task: taskId, leaseId });
    expect([released.isError, released.text]).toEqual([false, expect.stringContaining('released')]);
    expect((await leases(taskId)).map((row) => row.status)).toEqual(['released']);
    const again = await mcp(reviewerConnector.token, 'relayhall_lease_release', { task: taskId, leaseId });
    expect(again.isError).toBe(false);
  });

  it('(d) a qa-role Connector, the route\'s other admitted bearer, claims too', async () => {
    const taskId = await readyTask([qaConnector]);
    const claimed = await mcp(qaConnector.token, 'relayhall_lease_claim', {
      task: taskId, snapshotUpdatedAt: await snapshot(qaConnector, taskId), harness: 'hermes', resourceKey: `worktree-${tag()}`,
    });
    expect([claimed.isError, claimed.text]).toEqual([false, expect.stringContaining('Claimed Task')]);
    expect(await taskStatus(taskId)).toBe('in-progress');
  });

  it('(e) the route\'s refusals reach the caller by name and change nothing', async () => {
    const boundAgentTask = await readyTask([plainConnector]);
    const boundAgent = await agent(plainConnector, boundAgentTask);
    await bootstrap(boundAgent);
    await pool.query(
      `INSERT INTO grants (grantee_type, grantee_id, resource_type, resource_id, verb)
       VALUES ('principal', $1, 'task', $2, 'write')`,
      [boundAgent.principalId, boundAgentTask],
    );
    const refusedAs = async (caller: Caller, taskId: string, extra: Record<string, unknown> = {}) => mcp(caller.token, 'relayhall_lease_claim', {
      task: taskId, snapshotUpdatedAt: await snapshot(caller, taskId), harness: 'hermes', resourceKey: `worktree-${tag()}`, ...extra,
    });

    // Task-lifecycle role `agent`: a Connector, and an Agent on its own bound Task.
    const connectorTask = await readyTask([plainConnector]);
    for (const [caller, taskId] of [[plainConnector, connectorTask], [boundAgent, boundAgentTask]] as Array<[Caller, string]>) {
      const refused = await refusedAs(caller, taskId);
      expect([caller.label, refused.isError]).toEqual([caller.label, true]);
      expect(refused.text).toContain('(HTTP 403)');
      expect(refused.text).toContain('Implementation agents cannot claim scheduler work');
      expect([caller.label, await taskStatus(taskId), (await leases(taskId)).length]).toEqual([caller.label, 'todo', 0]);
    }

    // The Task's own Verifier, though its role is admitted.
    const verifierTask = await readyTask([reviewerConnector], reviewerConnector.principalId);
    const ownVerifier = await refusedAs(reviewerConnector, verifierTask);
    expect([ownVerifier.isError, ownVerifier.text]).toEqual([true, expect.stringContaining('[CLAIMANT_VERIFIER_CONFLICT]')]);

    // A snapshot that is not the Task's current one.
    const staleTask = await readyTask([reviewerConnector]);
    const stale = await refusedAs(reviewerConnector, staleTask, { snapshotUpdatedAt: '2000-01-01T00:00:00.000Z' });
    expect([stale.isError, stale.text]).toEqual([true, expect.stringContaining('[STALE_TASK_SNAPSHOT]')]);

    // A call missing a field gets the route's own 400: the tool does not decide it.
    const missing = await mcp(reviewerConnector.token, 'relayhall_lease_claim', {
      task: staleTask, snapshotUpdatedAt: await snapshot(reviewerConnector, staleTask), harness: 'hermes',
    });
    expect([missing.isError, missing.text]).toEqual([true, expect.stringContaining('(HTTP 400)')]);
    expect(missing.text).toContain('snapshotUpdatedAt, harness, and resourceKey are required');

    for (const taskId of [verifierTask, staleTask]) {
      expect([await taskStatus(taskId), (await leases(taskId)).length]).toEqual(['todo', 0]);
    }
  });

  it('(f) an Agent an administrator gave the reviewer role claims; a role-less Agent of the same shape is refused', async () => {
    const parent = await connector('agent-parent');
    const reviewerTask = await readyTask([parent]);
    const plainTask = await readyTask([parent]);
    const reviewerAgent = { ...(await agent(parent, reviewerTask)), label: 'reviewer-agent' };
    const plainAgent = { ...(await agent(parent, plainTask)), label: 'role-less-agent' };
    await grantWrite(reviewerAgent.principalId, reviewerTask);
    await grantWrite(plainAgent.principalId, plainTask);
    await roleAct(reviewerAgent.principalId, 'reviewer');
    for (const caller of [reviewerAgent, plainAgent]) await bootstrap(caller);
    const roles = (await pool.query('SELECT id, kind, role FROM principals WHERE id = ANY($1::uuid[]) ORDER BY role NULLS LAST',
      [[reviewerAgent.principalId, plainAgent.principalId]])).rows.map((row: any) => [String(row.id), row.kind, row.role]);
    expect(roles).toEqual([[reviewerAgent.principalId, 'agent', 'reviewer'], [plainAgent.principalId, 'agent', null]]);

    const claimAs = async (caller: Caller, taskId: string) => mcp(caller.token, 'relayhall_lease_claim', {
      task: taskId, snapshotUpdatedAt: await snapshot(caller, taskId), harness: 'hermes', resourceKey: `worktree-${tag()}`,
    });

    const admitted = await claimAs(reviewerAgent, reviewerTask);
    expect([admitted.isError, admitted.text]).toEqual([false, expect.stringContaining('Claimed Task')]);
    expect(await taskStatus(reviewerTask)).toBe('in-progress');
    expect((await leases(reviewerTask)).map((row) => row.status)).toEqual(['active']);

    const refused = await claimAs(plainAgent, plainTask);
    expect([refused.isError, refused.text]).toEqual([true, expect.stringContaining('(HTTP 403)')]);
    expect(refused.text).toContain('Implementation agents cannot claim scheduler work');
    expect([await taskStatus(plainTask), (await leases(plainTask)).length]).toEqual(['todo', 0]);
  });

  it('(g) a leaseSeconds that is not a whole number of at least 1 is refused by name before the route is called', async () => {
    const taskId = await readyTask([reviewerConnector]);
    const snapshotUpdatedAt = await snapshot(reviewerConnector, taskId);
    for (const leaseSeconds of ['abc', 1.5, 0, -5, '60', null]) {
      const refused = await mcp(reviewerConnector.token, 'relayhall_lease_claim', {
        task: taskId, snapshotUpdatedAt, harness: 'hermes', resourceKey: `worktree-${tag()}`, leaseSeconds,
      });
      expect([leaseSeconds, refused.isError, refused.text]).toEqual([leaseSeconds, true, expect.stringContaining('[LEASE_SECONDS_INVALID]')]);
      // The tool's own refusal: the route never answered, so no HTTP status.
      expect(refused.text).not.toContain('(HTTP ');
    }
    expect([await taskStatus(taskId), (await leases(taskId)).length]).toEqual(['todo', 0]);
  });
});
