/**
 * Card 1a38270d, AZ-A13 stage 2 follow-ups: owner rulings E148 and E149 (12 Oct
 * 2026), over a REAL PostgreSQL and the PRODUCTION router and MCP ingress.
 *
 * E148, "extend the residual rule". Clause 6j's residual rule ("the scopes it
 * added are removed") is extended to a credential's transport, a warrant's
 * transport pin and a grant's selector. When the owning Account (for a grant,
 * root, its only editor) legitimately narrowed a widened field between the
 * widening and the task's end, what remains at the end is a RESIDUAL: the
 * revert keeps it (its behaviour is unchanged: a revert only narrows, and a
 * field a later edit moved is left as it is), and the closing record names it
 * truthfully instead of "nothing the widening added is still present". The
 * naming covers every field a later edit moved while it still exceeds its value
 * before the widening, so the closing reason is never untrue.
 *
 * E149, "bind edits too". Answer E2 (an Agent credential carries
 * knowledge-contents:write only when its mint requests it explicitly, inside the
 * parent's grants, never inherited) governs EDITS as well as mints. Adding the
 * scope to an Agent credential is refused by name, AGENT_SCOPE_MINT_ONLY, ahead
 * of the general clause 9e refusal, with a durable denied audit row, on every
 * door: the session door (root included), the decide of a filed request, and
 * the agent's door over REST and MCP.
 *
 * Groups: (R) E148, one test per ruled field (transport, pin, selector), the
 * other fields, and the unchanged cases; (E) E149, one test per door and the
 * unchanged cases. Each control in scripts/authority-edit-mutations.py
 * (--suite followups) withdraws one of these rules and must redden exactly
 * its declared tests.
 *
 * DESTRUCTIVE: writes principals, credentials, services, warrants, grants,
 * approvals, projects, tasks, step-up tokens and audit rows. It refuses any
 * deployment database and any non-local host, and FAILS - never skips -
 * without a disposable one.
 */

/* eslint-disable @typescript-eslint/no-var-requires */

import http from 'http';
import crypto from 'crypto';

const TEST_DB_URL = process.env.RELAYHALL_TEST_DB_URL;
if (!TEST_DB_URL) {
  throw new Error('RELAYHALL_TEST_DB_URL is required: the edit-in-place follow-ups measure stored credential, warrant, grant, '
    + 'approval and audit rows, so they never skip. Load database/init.sql into a disposable database, run '
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
  throw new Error('Edit-in-place follow-ups refuse a non-disposable database target');
}

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
const { loginSessionService, SESSION_COOKIE_NAME } = require('../services/LoginSessionService');
const { stepUpService } = require('../services/StepUpService');
const mcpRoutes = require('../mcp/httpRoute').default;
const { MCP_ROUTE_PATH } = require('../mcp/httpRoute');

jest.setTimeout(240_000);

let server: http.Server;
let origin: string;

function buildApp(): any {
  const app = express();
  app.use(express.json(jsonBodyOptions));
  app.use(express.urlencoded({ extended: true }));
  app.use(MCP_ROUTE_PATH, mcpRoutes);
  registerProtectedRoutes((mountPath: string, ...handlers: any[]) => {
    app.use(mountPath, authMiddleware, sharedAuthorizationMiddleware, ...handlers);
  });
  app.use(apiErrorHandler);
  return app;
}

interface Caller { label: string; principalId: string; headers: Record<string, string> }
interface Bearer extends Caller { credentialId: string; scopes: string[] }
interface Answer { status: number; json: any; text: string }

async function call(who: Caller, method: string, routePath: string, body?: unknown): Promise<Answer> {
  const response = await fetch(`${origin}${routePath}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...who.headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let json: any = null;
  try { json = JSON.parse(text); } catch { json = null; }
  return { status: response.status, json, text };
}

async function mcpCall(who: Bearer, name: string, args: Record<string, unknown> = {}): Promise<Answer> {
  const response = await fetch(`${origin}${MCP_ROUTE_PATH}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      Authorization: who.headers.Authorization,
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
  });
  const text = await response.text();
  let json: any = null;
  try { json = JSON.parse(text); } catch { json = null; }
  return { status: response.status, json, text };
}
const mcpText = (answer: Answer): string => String(answer.json?.result?.content?.[0]?.text ?? '');
const mcpFailed = (answer: Answer): boolean => Boolean(answer.json?.result?.isError) || Boolean(answer.json?.error);

const tag = (): string => crypto.randomBytes(5).toString('hex');
const parseJson = (value: unknown): any => (typeof value === 'string' ? JSON.parse(value) : value);
const sorted = (values: string[]): string[] => [...values].sort();
const REASON = 'AZ-A13 follow-ups drill: the run needs this access to finish the handover.';
const BASE_SCOPES = ['tasks:read', 'tasks:write', 'projects:read', 'principals:read'];
const WRITE = 'knowledge-contents:write';
const KEEP = { choice: 'keep' };
/** The closing reason a revert wrote before E148 whatever a later edit had left. */
const NOTHING_REMAINS = 'nothing the widening added is still present';

async function makeAccount(role: string, label: string): Promise<string> {
  const result = await pool.query(
    `INSERT INTO principals (kind, handle, display_name, status, role)
     VALUES ('human', $1, $1, 'active', $2) RETURNING id`,
    [`az13fu-${label}-${tag()}`, role],
  );
  return String(result.rows[0].id);
}

async function sessionFor(label: string, principalId: string): Promise<Caller> {
  const minted = await loginSessionService.mint({ principalId });
  return { label, principalId, headers: { Cookie: `${SESSION_COOKIE_NAME}=${minted.token}` } };
}

function bearer(label: string, principalId: string, credentialId: string, scopes: string[], secret: string): Bearer {
  return { label, principalId, credentialId, scopes, headers: { Authorization: `Bearer ${secret}` } };
}

/** A Connector registered through the owner's wizard path (the registry shape: own() 'parent'). */
async function registerConnector(owner: Caller, scopes: string[], transport: 'api' | 'any' | 'mcp'): Promise<Bearer> {
  const slug = `az13fu-connector-${tag()}`;
  const registered = await call(owner, 'POST', '/services', {
    slug, name: slug, description: 'Edit-in-place follow-ups connector.', kind: 'connector',
    issueCredential: { scopes, label: slug, transport },
  });
  expect([registered.status, registered.json?.code]).toEqual([201, undefined]);
  const row = await pool.query('SELECT principal_id FROM services WHERE slug = $1', [slug]);
  return bearer(slug, String(row.rows[0].principal_id), String(registered.json.onboarding.credential.credentialId),
    scopes, String(registered.json.onboarding.credential.secretOnce));
}

async function stepUp(who: Caller, action: string, id: string): Promise<string> {
  return (await stepUpService.mint(who.principalId, action, id.toLowerCase(), 'password')).token;
}

const ROUTE: Record<string, string> = { credential: '/credentials', warrant: '/warrants', grant: '/grants' };
async function edit(who: Caller, type: 'credential' | 'warrant' | 'grant', id: string, body: Record<string, unknown>): Promise<Answer> {
  return call(who, 'PATCH', `${ROUTE[type]}/${id}`, body);
}
/** The one-act widening: a step-up bound to (<object>.edit, id), and a lifetime. */
async function widen(who: Caller, type: 'credential' | 'warrant' | 'grant', id: string, body: Record<string, unknown>,
  lifetime: Record<string, unknown> = KEEP): Promise<Answer> {
  return edit(who, type, id, { ...body, lifetime, stepUpToken: await stepUp(who, `${type}.edit`, id) });
}

async function credentialRow(id: string): Promise<any> {
  return (await pool.query('SELECT * FROM principal_credentials WHERE id = $1', [id])).rows[0];
}
async function scopesOf(id: string): Promise<string[]> {
  return parseJson((await credentialRow(id)).scopes);
}
async function warrantRow(id: string): Promise<any> {
  return (await pool.query(
    `SELECT ceiling_profile_version_id, ceiling_scopes, max_concurrent, max_total, transport_pin FROM warrants WHERE id = $1`,
    [id])).rows[0];
}
async function approvalRow(id: string): Promise<any> {
  return (await pool.query('SELECT * FROM approvals WHERE id = $1', [id])).rows[0];
}
async function editApprovals(objectId: string): Promise<any[]> {
  return (await pool.query(`SELECT * FROM approvals WHERE kind = 'authority-edit' AND edit_object_id = $1 ORDER BY requested_at`, [objectId])).rows;
}
/** The edit audit rows of one object, as metadata. */
async function edits(objectId: string, outcome = 'success'): Promise<any[]> {
  return (await pool.query(
    `SELECT metadata FROM audit_events WHERE resource_id = $1 AND action IN ('credential.edit', 'warrant.edit', 'grant.edit')
        AND outcome = $2 ORDER BY occurred_at, id`, [objectId, outcome])).rows.map((row: any) => parseJson(row.metadata));
}
/** The record a revert closes: the approval's approval.revoked ledger rows. */
async function closings(approvalId: string): Promise<any[]> {
  return (await pool.query(
    `SELECT metadata FROM approval_events WHERE approval_id = $1 AND action = 'approval.revoked' ORDER BY occurred_at, id`,
    [approvalId])).rows.map((row: any) => parseJson(row.metadata));
}
/** Whether each step-up minted for (who, action, id) was consumed. */
async function stepUpSpent(who: Caller, action: string, id: string): Promise<boolean[]> {
  return (await pool.query(
    'SELECT consumed_at FROM step_up_tokens WHERE principal_id = $1 AND action = $2 AND target_id = $3 ORDER BY created_at',
    [who.principalId, action, id.toLowerCase()])).rows.map((row: any) => row.consumed_at !== null);
}
/** The denied audit rows of one act on one resource, as their refusal codes. */
async function deniedRefusals(action: string, resourceId: string): Promise<Array<{ refusal: string; chained: boolean }>> {
  return (await pool.query(
    `SELECT metadata FROM audit_events WHERE action = $1 AND resource_id = $2 AND outcome = 'denied' ORDER BY occurred_at, id`,
    [action, resourceId])).rows.map((row: any) => {
    const metadata = parseJson(row.metadata);
    return { refusal: metadata.refusal, chained: Array.isArray(metadata.chain) && metadata.chain.length > 0 };
  });
}

let ROOT: Caller;           // role admin: derives root
let OPERATOR: Caller;       // an administrator (role operator), not root
let OWNER: Caller;          // a non-administrator owning Account (role editor)
let ROOT_PROJECT: string;
let OWNER_PROJECT: string;

async function taskIn(owner: Caller, project: string): Promise<string> {
  const created = await call(owner, 'POST', '/tasks', { title: `AZ-A13 follow-up ${tag()}`, description: 'edit-in-place follow-ups', status: 'todo', project });
  expect(created.status).toBe(201);
  return String(created.json?.task?.id);
}

async function complete(task: string): Promise<void> {
  expect((await call(ROOT, 'PATCH', `/tasks/${task}`, { status: 'completed' })).status).toBe(200);
}

async function fileEdit(who: Bearer, body: Record<string, unknown>): Promise<Answer> {
  return call(who, 'POST', '/delegation/access-requests', {
    kind: 'authority-edit', object: { type: 'credential' }, reason: REASON, ...body,
  });
}

async function decide(decider: Caller, approvalId: string, body: Record<string, unknown> = {}): Promise<Answer> {
  const token = await stepUp(decider, 'approval.decide', approvalId);
  return call(decider, 'POST', `/approvals/${approvalId}/approve`, { stepUpToken: token, ...body });
}

const ceiling = (ids: string[]) => [{ resourceType: 'task', selectorForm: 'exact', selectorIds: ids, verbs: ['read', 'write'] }];

/** A warrant held by `holder`, created by root with step-up, anchored to `task`. */
async function warrantFor(holder: Bearer, task: string, extra: Record<string, unknown> = {}): Promise<string> {
  const created = await call(ROOT, 'POST', '/warrants', {
    name: `AZ-A13 follow-up warrant ${tag()}`, holderPrincipalId: holder.principalId,
    anchors: [{ anchorType: 'task', anchorId: task }],
    ceilingRules: ceiling([task]),
    stepUpToken: await stepUp(ROOT, 'warrant.create', holder.principalId),
    ...extra,
  });
  expect([created.status, created.json?.code]).toEqual([201, undefined]);
  return String(created.json.warrant.id);
}

/** An Agent minted by `connector` under `warrant` on `task` (§6.3), with its credential. */
async function mintAgent(connector: Bearer, warrant: string, task: string, scopes: string[]): Promise<Bearer> {
  const minted = await call(connector, 'POST', '/delegation/agent-mints', {
    targetTaskId: task, via: 'warrant', warrantId: warrant, requestedScopes: scopes, requestedRules: [],
  });
  expect([minted.status, minted.json?.code]).toEqual([201, undefined]);
  const pack = minted.json.pack;
  const principal = (await pool.query('SELECT principal_id FROM principal_credentials WHERE id = $1', [pack.credentialId])).rows[0];
  return bearer(`agent-${tag()}`, String(principal.principal_id), String(pack.credentialId), scopes, String(pack.secretOnce));
}

beforeAll(async () => {
  await new Promise<void>((resolve) => { server = buildApp().listen(0, '127.0.0.1', resolve); });
  origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  ROOT = await sessionFor('root', await makeAccount('admin', 'root'));
  OPERATOR = await sessionFor('operator', await makeAccount('operator', 'operator'));
  OWNER = await sessionFor('owner', await makeAccount('editor', 'owner'));
  const rootProject = await call(ROOT, 'POST', '/projects', { name: `AZ-A13 follow-ups root ${tag()}` });
  expect(rootProject.status).toBe(201);
  ROOT_PROJECT = String(rootProject.json.project.id);
  const ownerProject = await call(OWNER, 'POST', '/projects', { name: `AZ-A13 follow-ups owner ${tag()}` });
  expect(ownerProject.status).toBe(201);
  OWNER_PROJECT = String(ownerProject.json.project.id);
});

afterAll(async () => {
  if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  await pool.end();
});

// ───────────── (R) E148: the residual a later narrowing leaves is kept and named ─────────────

describe('(R) E148: clause 6j, a residual a later narrowing leaves is kept, and the closing record names it', () => {
  it('E148 transport: root widens a credential mcp -> any with phases:read until the task ends; its owning Account narrows the pin to api; at the end phases:read is removed, api is KEPT (REST works, MCP is refused), and the revert audit row and the closing record name the residual', async () => {
    const connector = await registerConnector(OWNER, BASE_SCOPES, 'mcp');
    const ending = await taskIn(ROOT, ROOT_PROJECT);
    const widened = await widen(ROOT, 'credential', connector.credentialId,
      { scopes: [...BASE_SCOPES, 'phases:read'], transport: 'any' }, { choice: 'until-task', taskId: ending });
    expect([widened.status, widened.json?.edit?.direction, sorted(widened.json?.edit?.changed ?? [])]).toEqual([200, 'widening', ['scopes', 'transport']]);
    // The legitimate narrowing: the owning Account (an editor) may tighten a pin, never loosen it (clause 9d).
    const narrowed = await edit(OWNER, 'credential', connector.credentialId, { transport: 'api' });
    expect([narrowed.status, narrowed.json?.edit?.direction, narrowed.json?.edit?.changed]).toEqual([200, 'narrowing', ['transport']]);
    expect((await edits(connector.credentialId)).find((m) => m.path === 'direct'))
      .toMatchObject({ direction: 'narrowing', deciderStanding: 'owning-account', before: { transport: 'any' }, after: { transport: 'api' } });
    await complete(ending);

    const row = await credentialRow(connector.credentialId);
    expect([sorted(parseJson(row.scopes)), row.transport]).toEqual([sorted(BASE_SCOPES), 'api']);
    expect((await call(connector, 'GET', '/tasks')).status).toBe(200);
    expect((await mcpCall(connector, 'relayhall_principal_whoami')).text).toMatch(/TRANSPORT_MISMATCH|pinned to a different transport class/);

    const residual = [{ field: 'transport', before: 'mcp', approved: 'any', now: 'api' }];
    const approval = (await editApprovals(connector.credentialId))[0];
    expect((await approvalRow(approval.id)).edit_reverted_at).not.toBeNull();
    const revert = (await edits(connector.credentialId)).find((m) => m.path === 'revert');
    expect(revert).toMatchObject({ direction: 'narrowing', approvalId: approval.id, changed: ['scopes'], after: { transport: 'api' } });
    expect(revert?.residual).toEqual(residual);
    const closed = await closings(approval.id);
    expect(closed.map((m) => m.outcome)).toEqual(['reverted']);
    expect(closed[0].residual).toEqual(residual);
  });

  it('E148 pin: root widens a warrant transport pin mcp -> any until the task ends; its owning Account narrows it to api; at the end api is KEPT (the next Agent is minted api-pinned) and the closing record names the residual with a true reason', async () => {
    const connector = await registerConnector(OWNER, BASE_SCOPES, 'any');
    const anchor = await taskIn(OWNER, OWNER_PROJECT);
    const ending = await taskIn(ROOT, ROOT_PROJECT);
    const warrant = await warrantFor(connector, anchor, { transportPin: 'mcp' });
    const widened = await widen(ROOT, 'warrant', warrant, { transportPin: 'any' }, { choice: 'until-task', taskId: ending });
    expect([widened.status, widened.json?.edit?.direction, widened.json?.edit?.changed]).toEqual([200, 'widening', ['transportPin']]);
    const narrowed = await edit(OWNER, 'warrant', warrant, { transportPin: 'api' });
    expect([narrowed.status, narrowed.json?.edit?.direction, narrowed.json?.edit?.changed]).toEqual([200, 'narrowing', ['transportPin']]);
    expect((await edits(warrant)).find((m) => m.path === 'direct'))
      .toMatchObject({ direction: 'narrowing', deciderStanding: 'owning-account', before: { transportPin: 'any' }, after: { transportPin: 'api' } });
    await complete(ending);

    expect((await warrantRow(warrant)).transport_pin).toBe('api');
    const agent = await mintAgent(connector, warrant, anchor, ['tasks:read']);
    expect((await credentialRow(agent.credentialId)).transport).toBe('api');
    const approval = (await editApprovals(warrant))[0];
    expect((await approvalRow(approval.id)).edit_reverted_at).not.toBeNull();
    expect((await edits(warrant)).filter((m) => m.path === 'revert')).toEqual([]);
    const closed = await closings(approval.id);
    expect(closed.map((m) => m.outcome)).toEqual(['nothing']);
    expect(closed[0].residual).toEqual([{ field: 'transportPin', before: 'mcp', approved: 'any', now: 'api' }]);
    expect(closed[0].reason).not.toBe(NOTHING_REMAINS);
    expect(closed[0].reason).toContain('kept as a residual');
    expect(closed[0].reason).toContain('transportPin api');
  });

  it('E148 selector: root widens a grant from one task to every task until the task ends, then narrows it to another task; at the end that task is KEPT, still readable through the grant, and the closing record names the residual with a true reason', async () => {
    const holder = await sessionFor('holder', await makeAccount('editor', 'holder'));
    const x = await taskIn(ROOT, ROOT_PROJECT);
    const y = await taskIn(ROOT, ROOT_PROJECT);
    const ending = await taskIn(ROOT, ROOT_PROJECT);
    const created = await call(ROOT, 'POST', '/grants', { granteeId: holder.principalId, resourceType: 'task', resourceId: x, verb: 'read' });
    expect(created.status).toBe(201);
    const id = String(created.json.grant.id);
    const widened = await widen(ROOT, 'grant', id, { resourceId: null }, { choice: 'until-task', taskId: ending });
    expect([widened.status, widened.json?.edit?.direction, widened.json?.edit?.changed]).toEqual([200, 'widening', ['resourceId']]);
    // Root is a grant's only editor (clause 4a), so the legitimate narrowing is root's.
    const narrowed = await edit(ROOT, 'grant', id, { resourceId: y });
    expect([narrowed.status, narrowed.json?.edit?.direction, narrowed.json?.edit?.changed]).toEqual([200, 'narrowing', ['resourceId']]);
    expect((await edits(id)).find((m) => m.path === 'direct'))
      .toMatchObject({ direction: 'narrowing', before: { resourceId: null }, after: { resourceId: y } });
    await complete(ending);

    expect((await pool.query('SELECT resource_id FROM grants WHERE id = $1', [id])).rows[0].resource_id).toBe(y);
    expect((await call(holder, 'GET', `/tasks/${y}`)).status).toBe(200);
    const approval = (await editApprovals(id))[0];
    expect((await approvalRow(approval.id)).edit_reverted_at).not.toBeNull();
    const closed = await closings(approval.id);
    expect(closed.map((m) => m.outcome)).toEqual(['nothing']);
    expect(closed[0].residual).toEqual([{ field: 'resourceId', before: x, approved: null, now: y }]);
    expect(closed[0].reason).not.toBe(NOTHING_REMAINS);
    expect(closed[0].reason).toContain('kept as a residual');
    expect(closed[0].reason).toContain(`resourceId ${y}`);
  });

  it('E148 every other field: a warrant widened on its ceiling, maxTotal and maxConcurrent until the task ends, then narrowed on the ceiling and maxTotal to values still above the ones before; at the end maxConcurrent goes back, the ceiling and maxTotal are KEPT, and the revert audit row and the closing record name both', async () => {
    const connector = await registerConnector(OWNER, BASE_SCOPES, 'any');
    const a = await taskIn(OWNER, OWNER_PROJECT);
    const b = await taskIn(OWNER, OWNER_PROJECT);
    const ending = await taskIn(ROOT, ROOT_PROJECT);
    const warrant = await warrantFor(connector, a, { maxTotal: 5, maxConcurrent: 2 });
    const pinnedA = (await warrantRow(warrant)).ceiling_profile_version_id;
    const widened = await widen(ROOT, 'warrant', warrant, { ceilingRules: ceiling([a, b]), maxTotal: 10, maxConcurrent: 4 },
      { choice: 'until-task', taskId: ending });
    expect([widened.status, widened.json?.edit?.direction, sorted(widened.json?.edit?.changed ?? [])])
      .toEqual([200, 'widening', ['ceiling', 'maxConcurrent', 'maxTotal']]);
    const pinnedAB = widened.json.edit.after.ceilingProfileVersionId;
    const narrowed = await edit(OWNER, 'warrant', warrant, { ceilingRules: ceiling([b]), maxTotal: 7 });
    expect([narrowed.status, narrowed.json?.edit?.direction, sorted(narrowed.json?.edit?.changed ?? [])]).toEqual([200, 'narrowing', ['ceiling', 'maxTotal']]);
    const pinnedB = narrowed.json.edit.after.ceilingProfileVersionId;
    await complete(ending);

    const row = await warrantRow(warrant);
    expect([row.ceiling_profile_version_id, row.max_total, row.max_concurrent]).toEqual([pinnedB, 7, 2]);
    const residual = [
      { field: 'ceiling', before: pinnedA, approved: pinnedAB, now: pinnedB },
      { field: 'maxTotal', before: 5, approved: 10, now: 7 },
    ];
    const approval = (await editApprovals(warrant))[0];
    expect((await approvalRow(approval.id)).edit_reverted_at).not.toBeNull();
    const revert = (await edits(warrant)).find((m) => m.path === 'revert');
    expect(revert).toMatchObject({ direction: 'narrowing', approvalId: approval.id, changed: ['maxConcurrent'] });
    expect(revert?.residual).toEqual(residual);
    const closed = await closings(approval.id);
    expect(closed.map((m) => m.outcome)).toEqual(['reverted']);
    expect(closed[0].residual).toEqual(residual);
  });

  it('E148 scope ceiling: a warrant scope cap lifted until the task ends and then capped above the one before, and a cap widened until the task ends and then lifted by a later edit, are each KEPT and named with a true reason', async () => {
    const connector = await registerConnector(OWNER, BASE_SCOPES, 'any');
    const anchor = await taskIn(OWNER, OWNER_PROJECT);
    const ending = await taskIn(ROOT, ROOT_PROJECT);
    const lifted = await warrantFor(connector, anchor, { ceilingScopes: ['tasks:read'] });
    const widened = await widen(ROOT, 'warrant', lifted, { ceilingScopes: null }, { choice: 'until-task', taskId: ending });
    expect([widened.status, widened.json?.edit?.direction]).toEqual([200, 'widening']);
    const capped = await edit(OWNER, 'warrant', lifted, { ceilingScopes: ['tasks:read', 'projects:read'] });
    expect([capped.status, capped.json?.edit?.direction]).toEqual([200, 'narrowing']);

    const later = await warrantFor(connector, anchor, { ceilingScopes: ['tasks:read'] });
    const raised = await widen(ROOT, 'warrant', later, { ceilingScopes: ['tasks:read', 'projects:read'] }, { choice: 'until-task', taskId: ending });
    expect([raised.status, raised.json?.edit?.direction]).toEqual([200, 'widening']);
    const lift = await widen(ROOT, 'warrant', later, { ceilingScopes: null });
    expect([lift.status, lift.json?.edit?.direction]).toEqual([200, 'widening']);
    await complete(ending);

    expect(parseJson((await warrantRow(lifted)).ceiling_scopes)).toEqual(['tasks:read', 'projects:read']);
    expect((await warrantRow(later)).ceiling_scopes).toBeNull();
    const first = (await editApprovals(lifted))[0];
    const second = (await editApprovals(later)).find((r) => r.edit_lifetime === 'until-task');
    const firstClosed = await closings(first.id);
    const secondClosed = await closings(second.id);
    expect([firstClosed.map((m) => m.outcome), secondClosed.map((m) => m.outcome)]).toEqual([['nothing'], ['nothing']]);
    expect(firstClosed[0].residual).toEqual([{ field: 'ceilingScopes', before: ['tasks:read'], approved: null, now: ['tasks:read', 'projects:read'] }]);
    expect(secondClosed[0].residual).toEqual([{ field: 'ceilingScopes', before: ['tasks:read'], approved: ['tasks:read', 'projects:read'], now: null }]);
    for (const closing of [firstClosed[0], secondClosed[0]]) {
      expect(closing.reason).not.toBe(NOTHING_REMAINS);
      expect(closing.reason).toContain('kept as a residual');
    }
  });

  it('E148 unchanged: with no later edit a widening comes back field by field and the record says reverted with no residual; narrowed back to its value before, the record still says nothing the widening added is still present', async () => {
    const plain = await registerConnector(OWNER, BASE_SCOPES, 'mcp');
    const first = await taskIn(ROOT, ROOT_PROJECT);
    expect((await widen(ROOT, 'credential', plain.credentialId, { scopes: [...BASE_SCOPES, 'phases:read'], transport: 'any' },
      { choice: 'until-task', taskId: first })).status).toBe(200);
    await complete(first);
    const plainRow = await credentialRow(plain.credentialId);
    expect([sorted(parseJson(plainRow.scopes)), plainRow.transport]).toEqual([sorted(BASE_SCOPES), 'mcp']);
    const plainApproval = (await editApprovals(plain.credentialId))[0];
    const plainRevert = (await edits(plain.credentialId)).find((m) => m.path === 'revert');
    expect(plainRevert).toMatchObject({ direction: 'narrowing', approvalId: plainApproval.id, after: { transport: 'mcp' } });
    expect('residual' in plainRevert).toBe(false);
    const plainClosed = await closings(plainApproval.id);
    expect(plainClosed.map((m) => m.outcome)).toEqual(['reverted']);
    expect('residual' in plainClosed[0]).toBe(false);

    const back = await registerConnector(OWNER, BASE_SCOPES, 'mcp');
    const second = await taskIn(ROOT, ROOT_PROJECT);
    expect((await widen(ROOT, 'credential', back.credentialId, { transport: 'any' }, { choice: 'until-task', taskId: second })).status).toBe(200);
    expect((await edit(OWNER, 'credential', back.credentialId, { transport: 'mcp' })).status).toBe(200);
    await complete(second);
    expect((await credentialRow(back.credentialId)).transport).toBe('mcp');
    const backApproval = (await editApprovals(back.credentialId))[0];
    expect((await approvalRow(backApproval.id)).edit_reverted_at).not.toBeNull();
    const backClosed = await closings(backApproval.id);
    expect(backClosed.map((m) => [m.outcome, m.reason])).toEqual([['nothing', NOTHING_REMAINS]]);
    expect('residual' in backClosed[0]).toBe(false);
  });
});

// ───────────── (E) E149: knowledge-contents:write reaches an Agent only through its mint ─────────────

describe('(E) E149: an edit never adds knowledge-contents:write to an Agent credential', () => {
  it('E149 session door: root, an administrator and the owning Account adding knowledge-contents:write to an Agent credential are each refused AGENT_SCOPE_MINT_ONLY with a durable denied credential.edit row, the row unchanged, the step-up unspent and no Approval; an Agent whose mint requested it cannot get it back by edit once a narrowing removed it', async () => {
    const connector = await registerConnector(OWNER, [...BASE_SCOPES, WRITE], 'any');
    const task = await taskIn(OWNER, OWNER_PROJECT);
    const warrant = await warrantFor(connector, task, { ceilingScopes: ['tasks:read', 'principals:read', WRITE] });
    const agent = await mintAgent(connector, warrant, task, ['tasks:read', 'principals:read']);
    for (const who of [ROOT, OPERATOR, OWNER]) {
      const token = await stepUp(who, 'credential.edit', agent.credentialId);
      const refused = await edit(who, 'credential', agent.credentialId,
        { scopes: ['tasks:read', 'principals:read', WRITE], lifetime: KEEP, stepUpToken: token });
      expect([refused.status, refused.json?.code, refused.json?.subject, refused.json?.clause, refused.json?.mintOnly])
        .toEqual([422, 'AGENT_SCOPE_MINT_ONLY', 'target', 'AZ-A13 clause 9e', [WRITE]]);
      expect(await stepUpSpent(who, 'credential.edit', agent.credentialId)).toEqual([false]);
    }
    expect(sorted(await scopesOf(agent.credentialId))).toEqual(['principals:read', 'tasks:read']);
    expect(await editApprovals(agent.credentialId)).toEqual([]);
    expect(await deniedRefusals('credential.edit', agent.credentialId)).toEqual([
      { refusal: 'AGENT_SCOPE_MINT_ONLY', chained: true },
      { refusal: 'AGENT_SCOPE_MINT_ONLY', chained: true },
      { refusal: 'AGENT_SCOPE_MINT_ONLY', chained: true },
    ]);

    // The record E2 requires at mint does not open the edit route: once a
    // narrowing took the scope off a writer Agent, only a fresh mint carries it.
    const writer = await mintAgent(connector, warrant, task, ['tasks:read', WRITE]);
    expect(sorted(await scopesOf(writer.credentialId))).toEqual([WRITE, 'tasks:read']);
    const narrowed = await edit(OWNER, 'credential', connector.credentialId, { scopes: BASE_SCOPES, narrowAgents: true });
    expect([narrowed.status, narrowed.json?.edit?.direction]).toEqual([200, 'narrowing']);
    expect(await scopesOf(writer.credentialId)).toEqual(['tasks:read']);
    const back = await widen(ROOT, 'credential', writer.credentialId, { scopes: ['tasks:read', WRITE] });
    expect([back.status, back.json?.code]).toEqual([422, 'AGENT_SCOPE_MINT_ONLY']);
    expect(await scopesOf(writer.credentialId)).toEqual(['tasks:read']);
  });

  it('E149 the decide path: a filed widening that names an Agent credential (the agent\'s door never files one; written directly) is refused AGENT_SCOPE_MINT_ONLY at decide, nothing applied, the request still pending, a denied approval.decide row', async () => {
    const connector = await registerConnector(ROOT, BASE_SCOPES, 'any');
    const task = await taskIn(ROOT, ROOT_PROJECT);
    const warrant = await warrantFor(connector, task, { ceilingScopes: ['tasks:read'] });
    const agent = await mintAgent(connector, warrant, task, ['tasks:read']);
    const keyId = (await credentialRow(agent.credentialId)).key_id;
    const filed = (await pool.query(
      `INSERT INTO approvals (kind, status, requester_principal_id, requesting_credential_id, requested_scopes, pending_expires_at,
         edit_object_type, edit_object_id, edit_before, edit_requested, reason, related_task_id, grantee_principal_id)
       VALUES ('authority-edit', 'pending', $1, $2, '[]'::jsonb, NOW() + INTERVAL '1 day',
         'credential', $3, $4::jsonb, $5::jsonb, $6, $7, $8) RETURNING id`,
      [connector.principalId, connector.credentialId, agent.credentialId,
        JSON.stringify({ scopes: ['tasks:read'], transport: 'any', keyId }),
        JSON.stringify({ scopes: ['tasks:read', WRITE], transport: 'any', keyId }), REASON, task, ROOT.principalId])).rows[0];
    const decided = await decide(ROOT, filed.id, { lifetime: KEEP });
    expect([decided.status, decided.json?.code, decided.json?.mintOnly]).toEqual([422, 'AGENT_SCOPE_MINT_ONLY', [WRITE]]);
    expect(await scopesOf(agent.credentialId)).toEqual(['tasks:read']);
    expect((await approvalRow(filed.id)).status).toBe('pending');
    expect((await deniedRefusals('approval.decide', filed.id)).map((row) => row.refusal)).toEqual(['AGENT_SCOPE_MINT_ONLY']);
  });

  it('E149 the MCP twin: an Agent asking for knowledge-contents:write over relayhall_access_request, and over its REST route, is refused AGENT_SCOPE_MINT_ONLY each time with a denied approval.request row, and nothing is filed', async () => {
    const connector = await registerConnector(ROOT, BASE_SCOPES, 'any');
    const task = await taskIn(ROOT, ROOT_PROJECT);
    const warrant = await warrantFor(connector, task, { ceilingScopes: ['tasks:read', 'principals:read'] });
    const agent = await mintAgent(connector, warrant, task, ['tasks:read', 'principals:read']);
    expect(mcpFailed(await mcpCall(agent, 'relayhall_brief_compile', { session: true }))).toBe(false);
    const viaMcp = await mcpCall(agent, 'relayhall_access_request', {
      action: 'file', kind: 'authority-edit', object: { type: 'credential' }, addScopes: [WRITE], reason: REASON,
    });
    expect([mcpFailed(viaMcp), mcpText(viaMcp).includes('AGENT_SCOPE_MINT_ONLY')]).toEqual([true, true]);
    const viaRest = await fileEdit(agent, { addScopes: [WRITE] });
    expect([viaRest.status, viaRest.json?.code, viaRest.json?.mintOnly]).toEqual([422, 'AGENT_SCOPE_MINT_ONLY', [WRITE]]);
    expect((await deniedRefusals('approval.request', agent.principalId)).map((row) => row.refusal))
      .toEqual(['AGENT_SCOPE_MINT_ONLY', 'AGENT_SCOPE_MINT_ONLY']);
    expect((await pool.query('SELECT id FROM approvals WHERE requester_principal_id = $1', [agent.principalId])).rows).toEqual([]);
  });

  it('E149 unchanged: an Agent edit or filing that does not add the scope keeps AGENT_CREDENTIAL_NOT_EDITABLE; a Connector credential gains knowledge-contents:write by edit in place and files for it; an Agent whose mint names it explicitly carries it', async () => {
    const connector = await registerConnector(ROOT, [...BASE_SCOPES, 'phases:read', WRITE], 'any');
    const task = await taskIn(ROOT, ROOT_PROJECT);
    const warrant = await warrantFor(connector, task, { ceilingScopes: ['tasks:read', 'principals:read', 'phases:read', WRITE] });
    const plain = await mintAgent(connector, warrant, task, ['tasks:read', 'principals:read']);
    const general = await edit(ROOT, 'credential', plain.credentialId, { scopes: ['tasks:read', 'principals:read', 'phases:read'] });
    expect([general.status, general.json?.code]).toEqual([422, 'AGENT_CREDENTIAL_NOT_EDITABLE']);
    const generalFiling = await fileEdit(plain, { addScopes: ['phases:read'] });
    expect([generalFiling.status, generalFiling.json?.code]).toEqual([422, 'AGENT_CREDENTIAL_NOT_EDITABLE']);

    const writer = await mintAgent(connector, warrant, task, ['tasks:read', WRITE]);
    expect(sorted(await scopesOf(writer.credentialId))).toEqual([WRITE, 'tasks:read']);

    const edited = await registerConnector(ROOT, BASE_SCOPES, 'any');
    const added = await widen(ROOT, 'credential', edited.credentialId, { scopes: [...BASE_SCOPES, WRITE] });
    expect([added.status, added.json?.edit?.direction]).toEqual([200, 'widening']);
    expect(sorted(await scopesOf(edited.credentialId))).toEqual(sorted([...BASE_SCOPES, WRITE]));
    const filer = await registerConnector(ROOT, BASE_SCOPES, 'any');
    const filed = await fileEdit(filer, { addScopes: [WRITE] });
    expect([filed.status, filed.json?.approval?.status, filed.json?.approval?.kind]).toEqual([202, 'pending', 'authority-edit']);
  });
});
