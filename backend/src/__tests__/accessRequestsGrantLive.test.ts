/**
 * Card 785e1eed P1-B: AZ-A9 "Grant requests" (ratified 2026-10-10, E43), kind `grant`, over a
 * REAL PostgreSQL and the PRODUCTION router.
 *
 * An Agent or Connector FILES a request for authority on its chain-root Account
 * through the bearer route `POST /delegation/access-requests` (clause 9) and
 * the MCP tool `relayhall_access_request` (clause 10). Root or an administrator login
 * session DECIDES it on the existing `/approvals` routes under the existing
 * step-up, and approval writes expiring grant rows the live predicate then
 * reads. Every number below is measured on the rows the board wrote.
 *
 *   (1) filing: an Agent under Account A files {task exact X [read]} with a
 *       reason and a related task -> one pending Approval of kind grant, the
 *       grantee is A, the quota counts it, approval.requested carries the
 *       kind, and NO authority changed;
 *   (2) filing refusals, each by name with {code, rule, subject, clause} and a
 *       durable denied audit: GRANTEE_INERT, the admin verb, the surface type,
 *       a short reason, an expiry past 90 days, an unreadable related task
 *       (answered exactly as an absent one), ALREADY_HELD naming the covering
 *       grant, a credential-kind field set on a grant filing refused by
 *       name, and the quota shared by every kind (a sixth pending item, mint
 *       requests included);
 *   (3) deciding: a bearer is refused SESSION_ONLY; the non-administrator
 *       owning Account lists the item and is refused
 *       APPROVAL_DECIDE_REQUIRES_ADMINISTRATOR without its step-up being
 *       spent; a stranger gets 404; an administrator (operator) session sees
 *       the grant item in full and, by E43 Q1, the owner's mint items too, and
 *       decides one (the audit records standing administrator); it approves:
 *       the grant row carries approval_id, the approved expiry, origin manual
 *       and no provenance, created_grant_ids names it, grant.create names the
 *       approval, and the Account and its Connector now READ X through the
 *       router; root approves too;
 *   (4) narrowing: an extra verb, a longer expiry and a different grantee are
 *       each refused EDIT_ONLY_NARROWS; untick a row and a verb and shorten the
 *       expiry, and exactly that is written;
 *   (5) the duplicate tuple: an EXPIRED identical row is replaced in the
 *       decide transaction; a LIVE one refuses ALREADY_HELD by name, never as
 *       a unique violation, and the request stays pending;
 *   (6) clause 12a: completing the related task by PATCH (updateTask) and by
 *       the verifier's verdict (recordVerdict) each revoke the rows and lapse a
 *       pending sibling TASK_TERMINAL; reopening restores nothing; the phase
 *       arm (ratified, E43 Q3) does the same for a phase-only request at
 *       completed and at archived;
 *       a hard delete reaps before the row goes; and a row another task's
 *       assignment links is handed over to it, not deleted (ruling 7440b579
 *       R1), then reaped when that assignment ends;
 *   (7) agent-mint is unchanged: the mint approval is kind agent-mint, the
 *       kind filter separates the two, and a grant approval is neither
 *       collectable on the mint route nor through the service;
 *   plus the decide-time ceiling (clause 11 re-runs clause 5 on the rows as
 *       written), withdraw, and AZ-31c rotation lapsing a pending grant request
 *       while leaving an approved one terminal.
 *
 * BASE NOTE. Clause 11's containment function is
 * `AgentMintService.assertObjectAuthorityCovers`, which card 785e1eed P1-C
 * repairs in place (Batch 13). Every assertion here holds under the function
 * both before and after that repair: ALREADY_HELD is shown with a covering
 * GRANT, and the operator decider holds the row it approves (before P1-C the
 * function's administrator copy lacks 'operator').
 *
 * DESTRUCTIVE: writes principals, credentials, services, approvals, projects,
 * phases, tasks, grants, step-up tokens and audit rows. It refuses any
 * deployment database and any non-local host, and FAILS - never skips -
 * without a disposable one.
 */

/* eslint-disable @typescript-eslint/no-var-requires */

import http from 'http';
import crypto from 'crypto';

const TEST_DB_URL = process.env.RELAYHALL_TEST_DB_URL;
if (!TEST_DB_URL) {
  throw new Error('RELAYHALL_TEST_DB_URL is required: the grant-request drill measures stored approval, grant, '
    + 'audit and task rows, so it never skips. Load database/init.sql into a disposable database, run '
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
  throw new Error('Grant-request drill refuses a non-disposable database target');
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
const { loginSessionService, SESSION_COOKIE_NAME } = require('../services/LoginSessionService');
const { stepUpService } = require('../services/StepUpService');
const { approvalService } = require('../services/ApprovalService');
const { grantService } = require('../services/GrantService');
const { taskManagerDB } = require('../services/TaskManagerDB');
const { TaskReviewAttemptService, hashReviewReports } = require('../services/TaskReviewAttemptService');
const { invalidateApprovalsForCredentials } = require('../utils/approvalInvalidation');
const { accessVehicleService } = require('../services/AccessVehicleService');
const { accessSurfaceService } = require('../services/AccessSurfaceService');
const { notificationEndpointService } = require('../services/NotificationEndpointService');
const { requiredScopeFor } = require('../utils/scopeMap');
const mcpRoutes = require('../mcp/httpRoute').default;
const { MCP_ROUTE_PATH } = require('../mcp/httpRoute');

jest.setTimeout(180_000);

// ──────────────────────────────── the app ────────────────────────────────────

let server: http.Server;
let origin: string;

function buildApp(): any {
  const app = express();
  app.use(express.json(jsonBodyOptions));
  app.use(express.urlencoded({ extended: true }));
  // The MCP ingress first and outside the REST funnel, exactly as server.ts
  // mounts it: relayhall_access_request dispatches in-process to the same
  // /delegation/access-requests routes the REST callers below reach.
  app.use(MCP_ROUTE_PATH, mcpRoutes);
  registerProtectedRoutes((mountPath: string, ...handlers: any[]) => {
    app.use(mountPath, authMiddleware, sharedAuthorizationMiddleware, ...handlers);
  });
  app.use(apiErrorHandler);
  return app;
}

// ──────────────────────────────── callers ────────────────────────────────────

interface Caller { label: string; principalId: string; headers: Record<string, string> }
interface Bearer extends Caller { credentialId: string; scopes: string[] }
interface Answer { status: number; json: any }

async function call(who: Caller, method: string, routePath: string, body?: unknown,
  extra: Record<string, string> = {}): Promise<Answer> {
  const response = await fetch(`${origin}${routePath}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...who.headers, ...extra },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let json: any = null;
  try { json = JSON.parse(text); } catch { json = null; }
  return { status: response.status, json };
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
  return { status: response.status, json };
}
const mcpText = (answer: Answer): string => String(answer.json?.result?.content?.[0]?.text ?? '');
const mcpFailed = (answer: Answer): boolean => Boolean(answer.json?.result?.isError) || Boolean(answer.json?.error);

const tag = (): string => crypto.randomBytes(5).toString('hex');
const key = (label: string): string => `p1b-${label}-${crypto.randomUUID()}`;
const parseJson = (value: unknown): any => (typeof value === 'string' ? JSON.parse(value) : value);
const DAY = 24 * 60 * 60 * 1000;
const inDays = (days: number): string => new Date(Date.now() + days * DAY).toISOString();
const REASON = 'P1-B drill: the run needs to read the referenced card to finish its handover.';
const FOUR_SCOPES = ['tasks:read', 'tasks:write', 'reports:read', 'reports:write'];
const SYSTEM = { handle: 'p1b-drill', authMethod: 'system' };

async function makeAccount(role: string, label = 'acct'): Promise<string> {
  const result = await pool.query(
    `INSERT INTO principals (kind, handle, display_name, status, role)
     VALUES ('human', $1, $1, 'active', $2) RETURNING id`,
    [`p1b-${label}-${tag()}`, role],
  );
  return String(result.rows[0].id);
}

async function sessionFor(label: string, principalId: string): Promise<Caller> {
  const minted = await loginSessionService.mint({ principalId });
  return { label, principalId, headers: { Cookie: `${SESSION_COOKIE_NAME}=${minted.token}` } };
}

/** A Connector registered through the owner's wizard path. */
async function registerConnector(owner: Caller, scopes: string[] = FOUR_SCOPES, transport: 'api' | 'any' = 'api'): Promise<Bearer> {
  const slug = `p1b-connector-${tag()}`;
  const registered = await call(owner, 'POST', '/services', {
    slug, name: slug, description: 'Grant-request drill connector.', kind: 'connector',
    issueCredential: { scopes, label: slug, transport },
  });
  expect(registered.status).toBe(201);
  const row = await pool.query('SELECT principal_id FROM services WHERE slug = $1', [slug]);
  const principalId = String(row.rows[0].principal_id);
  return {
    label: slug, principalId, scopes,
    credentialId: String(registered.json.onboarding.credential.credentialId),
    headers: { Authorization: `Bearer ${registered.json.onboarding.credential.secretOnce}` },
  };
}

/** An Agent minted through the REAL approval path (request, owner approval
 * under step-up, collect), with no object rule. */
async function mintAgent(connector: Bearer, owner: Caller, targetTaskId: string): Promise<Bearer & { approvalId: string }> {
  const requested = await call(connector, 'POST', '/delegation/agent-mints',
    { targetTaskId, requestedScopes: FOUR_SCOPES, via: 'approval' }, { 'Idempotency-Key': key('mint') });
  expect([requested.status, requested.json?.path]).toEqual([202, 'approval']);
  const approvalId = String(requested.json.approval.id);
  const stepUp = await stepUpService.mint(owner.principalId, 'approval.decide', approvalId, 'password');
  const approved = await call(owner, 'POST', `/approvals/${approvalId}/approve`, { stepUpToken: stepUp.token });
  expect([approved.status, approved.json?.approval?.status]).toEqual([200, 'approved']);
  const collected = await call(connector, 'POST', `/delegation/agent-mints/${approvalId}/collect`, {},
    { 'Idempotency-Key': key('collect') });
  expect(collected.status).toBe(201);
  const pack = collected.json.pack;
  const credential = await pool.query('SELECT principal_id FROM principal_credentials WHERE id = $1', [pack.credentialId]);
  return {
    label: 'agent', principalId: String(credential.rows[0].principal_id), credentialId: String(pack.credentialId),
    scopes: FOUR_SCOPES, headers: { Authorization: `Bearer ${pack.secretOnce}` }, approvalId,
  };
}

type Filed = { ok: true; record: any } | { ok: false; status: number; code: string; body: any };

/** FILE a grant request as `who` through the BEARER route (clause 9):
 * POST /delegation/access-requests, the production router, the caller's own
 * credential. The refusal body is the route's own {code, rule, subject,
 * clause, ...}. */
async function file(who: Bearer, body: Record<string, unknown>): Promise<Filed> {
  const answered = await call(who, 'POST', '/delegation/access-requests', { kind: 'grant', reason: REASON, ...body });
  if (answered.status === 202) {
    expect(answered.json?.success).toBe(true);
    return { ok: true, record: answered.json.approval };
  }
  if (!answered.json?.code) throw new Error(`filing answered ${answered.status} without a code: ${JSON.stringify(answered.json)}`);
  return { ok: false, status: answered.status, code: String(answered.json.code), body: answered.json };
}

async function fileOk(who: Bearer, body: Record<string, unknown>): Promise<any> {
  const filed = await file(who, body);
  if (!filed.ok) throw new Error(`expected the filing to succeed, got ${filed.code}: ${JSON.stringify(filed.body)}`);
  return filed.record;
}

const exactRule = (type: string, ids: string[], verbs: string[]) => ({ resourceType: type, selectorForm: 'exact', selectorIds: ids, verbs });

async function decide(decider: Caller, approvalId: string, decision: 'approve' | 'deny', body: Record<string, unknown> = {}): Promise<Answer> {
  const stepUp = await stepUpService.mint(decider.principalId, 'approval.decide', approvalId, 'password');
  return call(decider, 'POST', `/approvals/${approvalId}/${decision}`, { stepUpToken: stepUp.token, ...body });
}

async function approvalRow(id: string): Promise<any> {
  return (await pool.query('SELECT * FROM approvals WHERE id = $1', [id])).rows[0];
}

async function grantsOf(approvalId: string): Promise<any[]> {
  return (await pool.query('SELECT * FROM grants WHERE approval_id = $1 ORDER BY resource_id, verb', [approvalId])).rows;
}

async function events(approvalId: string, action: string): Promise<any[]> {
  return (await pool.query('SELECT * FROM approval_events WHERE approval_id = $1 AND action = $2 ORDER BY occurred_at', [approvalId, action])).rows;
}

async function readsTask(who: Caller, taskId: string): Promise<number> {
  return (await call(who, 'GET', `/tasks/${taskId}`)).status;
}

// ─────────────────────────────── fixtures ────────────────────────────────────

let OWNER: Caller;          // Account A: an ordinary owner, role user
let OTHER: Caller;          // Account B: owns the objects A asks about
let STRANGER: Caller;       // an unrelated ordinary Account
let OPERATOR: Caller;       // an administrator Account (role operator) — not root
let ROOT: Caller;           // role admin: derives root
let PROJECT_ID: string;

async function ownerTask(owner: Caller, title: string, project?: string): Promise<string> {
  const created = await call(owner, 'POST', '/tasks', {
    title, description: 'grant-request drill', status: 'todo', ...(project ? { project } : {}),
  });
  expect(created.status).toBe(201);
  return String(created.json?.task?.id);
}

beforeAll(async () => {
  await new Promise<void>((resolve) => { server = buildApp().listen(0, '127.0.0.1', resolve); });
  origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  OWNER = await sessionFor('owner', await makeAccount('user', 'owner'));
  OTHER = await sessionFor('other', await makeAccount('user', 'other'));
  STRANGER = await sessionFor('stranger', await makeAccount('user', 'stranger'));
  OPERATOR = await sessionFor('operator', await makeAccount('operator', 'operator'));
  ROOT = await sessionFor('root', await makeAccount('admin', 'root'));
  const project = await call(OWNER, 'POST', '/projects', { name: `P1-B drill ${tag()}` });
  expect(project.status).toBe(201);
  PROJECT_ID = String(project.json.project.id);
});

afterAll(async () => {
  if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  await pool.end();
});

// ─────────────────────────────── the drill ───────────────────────────────────

describe('(1) an Agent under Account A files a grant request: pending, kind grant, grantee A, no authority changed', () => {
  let CONNECTOR: Bearer;
  let AGENT: Bearer & { approvalId: string };
  let BOUND: string;
  let X: string;
  let RECORD: any;

  beforeAll(async () => {
    CONNECTOR = await registerConnector(OWNER);
    BOUND = await ownerTask(OWNER, `P1-B bound ${tag()}`, PROJECT_ID);
    AGENT = await mintAgent(CONNECTOR, OWNER, BOUND);
    X = await ownerTask(OTHER, `P1-B X ${tag()}`);
    RECORD = await fileOk(AGENT, { requestedRules: [exactRule('task', [X], ['read'])], relatedTaskId: BOUND });
  });

  it('stores one pending Approval of kind grant whose grantee is the chain-root Account A', async () => {
    const row = await approvalRow(RECORD.id);
    expect({
      kind: row.kind, status: row.status, requester: String(row.requester_principal_id),
      credential: String(row.requesting_credential_id), grantee: String(row.grantee_principal_id),
      target: row.target_task_id, scopes: parseJson(row.requested_scopes),
      rules: parseJson(row.requested_rules), related: String(row.related_task_id), created: row.created_grant_ids,
    }).toEqual({
      kind: 'grant', status: 'pending', requester: AGENT.principalId, credential: AGENT.credentialId,
      grantee: OWNER.principalId, target: null, scopes: [],
      rules: [exactRule('task', [X], ['read'])], related: BOUND, created: null,
    });
    expect(row.reason).toBe(REASON);
    // E15: the default expiry is 14 days; the 7-day pending TTL is reused.
    expect(Math.abs(new Date(row.requested_expires_at).getTime() - (new Date(row.requested_at).getTime() + 14 * DAY))).toBeLessThan(5000);
    expect(Math.abs(new Date(row.pending_expires_at).getTime() - (new Date(row.requested_at).getTime() + 7 * DAY))).toBeLessThan(5000);
    // The requester view the route answers with (clause 9): its own
    // item's lifecycle, never the decider's identity or step-up evidence.
    expect(RECORD).toMatchObject({
      id: row.id, kind: 'grant', status: 'pending', granteePrincipalId: OWNER.principalId,
      relatedTaskId: BOUND, reason: REASON, requestedRules: [exactRule('task', [X], ['read'])], createdGrantIds: [],
    });
    for (const withheld of ['decidedByPrincipalId', 'decisionStepUp', 'sessionEvidence', 'requesterPrincipalId', 'requestingCredentialId']) {
      expect(Object.keys(RECORD)).not.toContain(withheld);
    }
  });

  it('records approval.requested and the approval.request audit, each carrying kind grant', async () => {
    const requested = await events(RECORD.id, 'approval.requested');
    expect(requested).toHaveLength(1);
    expect(parseJson(requested[0].metadata)).toMatchObject({ kind: 'grant', granteePrincipalId: OWNER.principalId, relatedTaskId: BOUND });
    const audit = await pool.query(
      `SELECT outcome, metadata FROM audit_events WHERE action = 'approval.request' AND resource_id = $1`, [RECORD.id]);
    expect(audit.rows).toHaveLength(1);
    expect(audit.rows[0].outcome).toBe('success');
    expect(parseJson(audit.rows[0].metadata)).toMatchObject({ kind: 'grant', requesterPrincipalId: AGENT.principalId });
  });

  it('counts against the requester quota and changes no authority: A still cannot read X', async () => {
    const pending = await pool.query(
      `SELECT COUNT(*)::int AS n FROM approvals WHERE requester_principal_id = $1 AND status = 'pending'`, [AGENT.principalId]);
    expect(pending.rows[0].n).toBe(1);
    const rows = await pool.query(`SELECT COUNT(*)::int AS n FROM grants WHERE grantee_id = $1 AND resource_id = $2`, [OWNER.principalId, X]);
    expect(rows.rows[0].n).toBe(0);
    expect(await readsTask(OWNER, X)).toBe(404);
  });

  it('(7) the Agent\'s own mint approval is kind agent-mint, unchanged', async () => {
    const mint = await approvalRow(AGENT.approvalId);
    expect([mint.kind, mint.status, String(mint.target_task_id), mint.grantee_principal_id, mint.reason])
      .toEqual(['agent-mint', 'collected', BOUND, null, null]);
  });
});

describe('(2) filing refuses by name, with {code, rule, subject, clause} and a durable audit', () => {
  let CONNECTOR: Bearer;
  let RELATED: string;
  let X: string;
  let Y: string;
  let HELD_GRANT: string;

  beforeAll(async () => {
    CONNECTOR = await registerConnector(OWNER);
    RELATED = await ownerTask(OWNER, `P1-B related ${tag()}`, PROJECT_ID);
    X = await ownerTask(OTHER, `P1-B X ${tag()}`);
    Y = await ownerTask(OTHER, `P1-B Y ${tag()}`);
    // Owner-plane: A already holds read on Y through a manual grant.
    HELD_GRANT = (await grantService.create({ granteeId: OWNER.principalId, resourceType: 'task', resourceId: Y, verb: 'read' }, SYSTEM)).id;
  });

  const base = () => ({ requestedRules: [exactRule('task', [X], ['read'])], relatedTaskId: RELATED });

  async function refusedAudit(code: string): Promise<any[]> {
    const rows = await pool.query(
      `SELECT metadata FROM audit_events WHERE action = 'approval.request' AND outcome = 'denied'
          AND metadata->>'refusal' = $1 AND resource_id = $2`, [code, CONNECTOR.principalId]);
    return rows.rows.map((row: any) => parseJson(row.metadata));
  }

  it('GRANTEE_INERT: an explicit delegated grantee (the Connector itself) is inert', async () => {
    const filed = await file(CONNECTOR, { ...base(), granteePrincipalId: CONNECTOR.principalId });
    expect(filed.ok).toBe(false);
    expect(filed.ok ? null : [filed.status, filed.body.code, filed.body.subject, filed.body.clause])
      .toEqual([422, 'GRANTEE_INERT', 'grantee', 'AZ-A9 clause 4']);
    const audits = await refusedAudit('GRANTEE_INERT');
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({ kind: 'grant', subject: 'grantee', clause: 'AZ-A9 clause 4' });
    expect(audits[0].chain.length).toBeGreaterThan(1);
  });

  it('the admin verb is never admissible', async () => {
    const filed = await file(CONNECTOR, { ...base(), requestedRules: [exactRule('task', [X], ['admin'])] });
    expect(filed.ok ? null : [filed.body.code, filed.body.subject, filed.body.clause])
      .toEqual(['ADMIN_VERB_NOT_ADMISSIBLE', 'requester', 'AZ-A9 clause 5']);
    expect(await refusedAudit('ADMIN_VERB_NOT_ADMISSIBLE')).toHaveLength(1);
  });

  it('the surface type is never admissible', async () => {
    const filed = await file(CONNECTOR, { ...base(), requestedRules: [exactRule('surface', [crypto.randomUUID()], ['read'])] });
    expect(filed.ok ? null : [filed.body.code, filed.body.clause]).toEqual(['SURFACE_NOT_ADMISSIBLE', 'AZ-A9 clause 5']);
  });

  it('a reason under 20 characters refuses INVALID_REASON', async () => {
    const filed = await file(CONNECTOR, { ...base(), reason: 'need it' });
    expect(filed.ok ? null : [filed.body.code, filed.body.clause]).toEqual(['INVALID_REASON', 'AZ-A9 clause 3']);
  });

  it('an expiry past 90 days refuses EXPIRY_TOO_LONG', async () => {
    const filed = await file(CONNECTOR, { ...base(), requestedExpiresAt: inDays(91) });
    expect(filed.ok ? null : [filed.body.code, filed.body.clause]).toEqual(['EXPIRY_TOO_LONG', 'AZ-A9 clause 3']);
  });

  it('an unreadable related task is 404-concealed exactly as an absent one', async () => {
    const unreadable = await file(CONNECTOR, { ...base(), relatedTaskId: X });
    const absent = await file(CONNECTOR, { ...base(), relatedTaskId: crypto.randomUUID() });
    expect(unreadable.ok ? null : [unreadable.status, unreadable.body]).toEqual(absent.ok ? 'absent filed' : [absent.status, absent.body]);
    expect(unreadable.ok ? null : [unreadable.status, unreadable.body.code]).toEqual([404, 'TASK_NOT_FOUND']);
  });

  it('ALREADY_HELD when A already covers the row, naming the covering grant', async () => {
    const filed = await file(CONNECTOR, { ...base(), requestedRules: [exactRule('task', [Y], ['read'])] });
    expect(filed.ok ? null : [filed.status, filed.body.code, filed.body.subject, filed.body.clause])
      .toEqual([409, 'ALREADY_HELD', 'grantee', 'AZ-A9 clause 5']);
    expect(filed.ok ? null : filed.body.coveringSource).toMatchObject({ kind: 'grant', grantId: HELD_GRANT });
    expect(filed.ok ? null : filed.body.failingRule).toEqual(exactRule('task', [Y], ['read']));
  });

  it('a credential-kind filing that carries grant rows refuses BUNDLED_ROWS_NOT_AVAILABLE by name (clause 13; P1-B-2)', async () => {
    const filed = await file(CONNECTOR, { ...base(), kind: 'credential', requestedScopes: ['phases:write'] });
    expect(filed.ok ? null : [filed.body.code, filed.body.subject, filed.body.clause])
      .toEqual(['BUNDLED_ROWS_NOT_AVAILABLE', 'requester', 'AZ-A9 clause 13']);
  });

  it('filed nothing: every refusal above left no approval row', async () => {
    const rows = await pool.query('SELECT COUNT(*)::int AS n FROM approvals WHERE requester_principal_id = $1', [CONNECTOR.principalId]);
    expect(rows.rows[0].n).toBe(0);
  });

  it('one quota across kinds: two pending mint requests and three grant requests fill it, and the sixth item of EITHER kind refuses', async () => {
    const QUOTA = await registerConnector(OWNER);
    for (let i = 0; i < 2; i += 1) {
      const target = await ownerTask(OWNER, `P1-B mint target ${tag()}`, PROJECT_ID);
      const minted = await call(QUOTA, 'POST', '/delegation/agent-mints',
        { targetTaskId: target, requestedScopes: ['tasks:read'], via: 'approval' }, { 'Idempotency-Key': key('quota-mint') });
      expect(minted.status).toBe(202);
    }
    for (let i = 0; i < 3; i += 1) {
      await fileOk(QUOTA, { ...base(), requestedRules: [exactRule('task', [X], ['read'])] });
    }
    const sixth = await file(QUOTA, base());
    expect(sixth.ok ? null : [sixth.status, sixth.body.code, sixth.body.pending, sixth.body.clause])
      .toEqual([429, 'REQUEST_QUOTA_EXCEEDED', 5, 'AZ-A9 clause 11']);
    const target = await ownerTask(OWNER, `P1-B mint target ${tag()}`, PROJECT_ID);
    const mintSixth = await call(QUOTA, 'POST', '/delegation/agent-mints',
      { targetTaskId: target, requestedScopes: ['tasks:read'], via: 'approval' }, { 'Idempotency-Key': key('quota-mint') });
    expect([mintSixth.status, mintSixth.json?.code]).toEqual([429, 'MINT_QUOTA_EXCEEDED']);
  });
});

describe('(3) who decides: root or an administrator session with step-up; the grant rows land and the predicate reads them', () => {
  let CONNECTOR: Bearer;
  let RELATED: string;
  let X: string;
  let X2: string;
  let G1: any;
  let G2: any;

  beforeAll(async () => {
    CONNECTOR = await registerConnector(OWNER);
    RELATED = await ownerTask(OWNER, `P1-B related ${tag()}`, PROJECT_ID);
    X = await ownerTask(OTHER, `P1-B X ${tag()}`);
    X2 = await ownerTask(OTHER, `P1-B X2 ${tag()}`);
    G1 = await fileOk(CONNECTOR, { requestedRules: [exactRule('task', [X], ['read'])], relatedTaskId: RELATED, requestedExpiresAt: inDays(20) });
    G2 = await fileOk(CONNECTOR, { requestedRules: [exactRule('task', [X2], ['read'])], relatedTaskId: RELATED });
    // BASE NOTE (header): the operator holds the row it approves, so the
    // clause-11 ceiling holds under the containment function before and after
    // P1-C. After P1-C an operator Account is the board-wide superset anyway.
    await grantService.create({ granteeId: OPERATOR.principalId, resourceType: 'task', resourceId: X, verb: 'read' }, SYSTEM);
  });

  it('a bearer caller is refused SESSION_ONLY', async () => {
    const answered = await call(CONNECTOR, 'POST', `/approvals/${G1.id}/approve`, { stepUpToken: 'x' });
    expect([answered.status, answered.json?.code]).toEqual([403, 'SESSION_ONLY']);
  });

  it('the non-administrator owning Account lists the item, and its approve is refused APPROVAL_DECIDE_REQUIRES_ADMINISTRATOR without spending its step-up', async () => {
    const listed = await call(OWNER, 'GET', '/approvals?kind=grant');
    expect(listed.status).toBe(200);
    expect(listed.json.approvals.map((a: any) => a.id)).toEqual(expect.arrayContaining([G1.id, G2.id]));
    const stepUp = await stepUpService.mint(OWNER.principalId, 'approval.decide', G1.id, 'password');
    const answered = await call(OWNER, 'POST', `/approvals/${G1.id}/approve`, { stepUpToken: stepUp.token });
    expect([answered.status, answered.json?.code, answered.json?.subject, answered.json?.clause])
      .toEqual([403, 'APPROVAL_DECIDE_REQUIRES_ADMINISTRATOR', 'decider', 'AZ-A9 clause 6']);
    const token = await pool.query('SELECT consumed_at FROM step_up_tokens WHERE id = $1', [stepUp.tokenId]);
    expect(token.rows[0].consumed_at).toBeNull();
    expect((await approvalRow(G1.id)).status).toBe('pending');
    const audit = await pool.query(
      `SELECT metadata FROM audit_events WHERE action = 'approval.decide' AND outcome = 'denied' AND resource_id = $1`, [G1.id]);
    expect(audit.rows.map((row: any) => parseJson(row.metadata).refusal)).toContain('APPROVAL_DECIDE_REQUIRES_ADMINISTRATOR');
  });

  it('a stranger Account is 404-concealed', async () => {
    const answered = await call(STRANGER, 'GET', `/approvals/${G1.id}`);
    expect([answered.status, answered.json?.code]).toEqual([404, 'APPROVAL_NOT_FOUND']);
  });

  it('E43 Q1: an administrator (operator) session sees grant items in full, and lists, opens and decides the owner\'s agent-mint item', async () => {
    const one = await call(OPERATOR, 'GET', `/approvals/${G1.id}`);
    expect([one.status, one.json?.approval?.kind]).toEqual([200, 'grant']);
    // A foreign agent-mint item: the owner's Connector asks for an Agent.
    const target = await ownerTask(OWNER, `P1-B foreign mint ${tag()}`, PROJECT_ID);
    const minted = await call(CONNECTOR, 'POST', '/delegation/agent-mints',
      { targetTaskId: target, requestedScopes: ['tasks:read'], via: 'approval' }, { 'Idempotency-Key': key('foreign-mint') });
    expect([minted.status, minted.json?.path]).toEqual([202, 'approval']);
    const mintId = String(minted.json.approval.id);
    const mints = await call(OPERATOR, 'GET', '/approvals?kind=agent-mint');
    expect(mints.status).toBe(200);
    expect(mints.json.approvals.map((a: any) => a.id)).toContain(mintId);
    const opened = await call(OPERATOR, 'GET', `/approvals/${mintId}`);
    expect([opened.status, opened.json?.approval?.kind, opened.json?.viewer]).toEqual([200, 'agent-mint', { isRoot: false, isAdministrator: true }]);
    const decided = await decide(OPERATOR, mintId, 'approve');
    expect([decided.status, decided.json?.approval?.status]).toEqual([200, 'approved']);
    const audit = await pool.query(
      `SELECT metadata FROM audit_events WHERE action = 'approval.approve' AND resource_id = $1`, [mintId]);
    expect(audit.rows.map((row: any) => parseJson(row.metadata).deciderStanding)).toEqual(['administrator']);
    // The approval_events ledger of a mint is unchanged (clause 16): no standing in it.
    expect(Object.keys(parseJson((await events(mintId, 'approval.approved'))[0].metadata)).sort())
      .toEqual(['approvedRules', 'approvedScopes', 'edited', 'stepUp']);
  });

  it('E43 Q1 keeps §6.1: a non-administrator Account still sees only its own subtree\'s agent-mint items, decides them as owner, and a stranger is 404-concealed', async () => {
    const target = await ownerTask(OWNER, `P1-B own mint ${tag()}`, PROJECT_ID);
    const minted = await call(CONNECTOR, 'POST', '/delegation/agent-mints',
      { targetTaskId: target, requestedScopes: ['tasks:read'], via: 'approval' }, { 'Idempotency-Key': key('own-mint') });
    const mintId = String(minted.json.approval.id);
    const strangers = await call(STRANGER, 'GET', '/approvals?kind=agent-mint');
    expect(strangers.json.approvals.map((a: any) => a.id)).not.toContain(mintId);
    expect((await call(STRANGER, 'GET', `/approvals/${mintId}`)).status).toBe(404);
    const own = await call(OWNER, 'GET', '/approvals?kind=agent-mint');
    expect(own.json.approvals.map((a: any) => a.id)).toContain(mintId);
    expect(own.json.viewer).toEqual({ isRoot: false, isAdministrator: false });
    const decided = await decide(OWNER, mintId, 'deny', { reason: 'P1-B drill: the owner decides its own subtree' });
    expect([decided.status, decided.json?.approval?.status]).toEqual([200, 'denied']);
    const audit = await pool.query(
      `SELECT metadata FROM audit_events WHERE action = 'approval.deny' AND resource_id = $1`, [mintId]);
    expect(audit.rows.map((row: any) => parseJson(row.metadata).deciderStanding)).toEqual(['owner']);
  });

  it('the administrator approves: one grant row with approval_id, the approved expiry, origin manual, no provenance', async () => {
    expect(await readsTask(OWNER, X)).toBe(404);
    expect(await readsTask(CONNECTOR, X)).toBe(404);
    const answered = await decide(OPERATOR, G1.id, 'approve');
    expect([answered.status, answered.json?.approval?.status]).toEqual([200, 'approved']);
    const row = await approvalRow(G1.id);
    const grants = await grantsOf(G1.id);
    expect(grants).toHaveLength(1);
    expect({
      grantee: String(grants[0].grantee_id), type: grants[0].resource_type, id: String(grants[0].resource_id),
      verb: grants[0].verb, origin: grants[0].origin, provenance: grants[0].provenance,
      expires: new Date(grants[0].expires_at).toISOString(),
    }).toEqual({
      grantee: OWNER.principalId, type: 'task', id: X, verb: 'read', origin: 'manual', provenance: null,
      expires: new Date(row.requested_expires_at).toISOString(),
    });
    expect(row.created_grant_ids.map(String)).toEqual([String(grants[0].id)]);
    expect(new Date(row.approved_expires_at).toISOString()).toBe(new Date(row.requested_expires_at).toISOString());
    expect(String(row.decided_by_principal_id)).toBe(OPERATOR.principalId);
    const created = await pool.query(`SELECT metadata FROM audit_events WHERE action = 'grant.create' AND resource_id = $1`, [grants[0].id]);
    expect(parseJson(created.rows[0].metadata)).toMatchObject({ approvalId: G1.id, requesterPrincipalId: CONNECTOR.principalId, kind: 'grant', origin: 'manual' });
    const approved = await events(G1.id, 'approval.approved');
    expect(parseJson(approved[0].metadata)).toMatchObject({ kind: 'grant', deciderStanding: 'administrator', createdGrantIds: [String(grants[0].id)] });
  });

  it('the live predicate now admits Account A on X — and its Connector, through the router', async () => {
    expect(await readsTask(OWNER, X)).toBe(200);
    expect(await readsTask(CONNECTOR, X)).toBe(200);
  });

  it('root approves too', async () => {
    const answered = await decide(ROOT, G2.id, 'approve');
    expect([answered.status, answered.json?.approval?.status]).toEqual([200, 'approved']);
    const approved = await events(G2.id, 'approval.approved');
    expect(parseJson(approved[0].metadata)).toMatchObject({ deciderStanding: 'root' });
    expect(await readsTask(OWNER, X2)).toBe(200);
  });

  it('(7) the kind filter separates the kinds, and a grant approval is not a mint to collect', async () => {
    const grants = await call(ROOT, 'GET', '/approvals?kind=grant');
    expect(grants.json.approvals.every((a: any) => a.kind === 'grant')).toBe(true);
    const mints = await call(ROOT, 'GET', '/approvals?kind=agent-mint');
    expect(mints.json.approvals.every((a: any) => a.kind === 'agent-mint' && a.accessRequest === undefined)).toBe(true);
    const collected = await call(CONNECTOR, 'POST', `/delegation/agent-mints/${G1.id}/collect`, {}, { 'Idempotency-Key': key('collect') });
    expect([collected.status, collected.json?.code]).toEqual([404, 'APPROVAL_NOT_FOUND']);
    await expect(approvalService.collect({
      approvalId: G1.id, presentingCredentialId: CONNECTOR.credentialId,
      presentingPrincipalId: CONNECTOR.principalId, presentingEffectiveScopes: CONNECTOR.scopes,
    }, SYSTEM)).rejects.toMatchObject({ code: 'NOT_COLLECTABLE' });
  });
});

describe('(4) narrowing: never wider, and exactly the narrowed rows are written', () => {
  let CONNECTOR: Bearer;
  let RELATED: string;
  let X2: string;
  let X3: string;
  let G: any;

  beforeAll(async () => {
    CONNECTOR = await registerConnector(OWNER);
    RELATED = await ownerTask(OWNER, `P1-B related ${tag()}`, PROJECT_ID);
    X2 = await ownerTask(OTHER, `P1-B X2 ${tag()}`);
    X3 = await ownerTask(OTHER, `P1-B X3 ${tag()}`);
    G = await fileOk(CONNECTOR, {
      requestedRules: [exactRule('task', [X2, X3], ['read', 'write'])], relatedTaskId: RELATED, requestedExpiresAt: inDays(30),
    });
  });

  it.each([
    ['an extra verb', () => ({ editedRules: [exactRule('task', [X2], ['read', 'use'])] })],
    ['a longer expiry', () => ({ editedExpiresAt: inDays(40) })],
    ['a different grantee', () => ({ editedGranteePrincipalId: STRANGER.principalId })],
  ])('widening by %s is refused EDIT_ONLY_NARROWS and the request stays pending', async (_label, body) => {
    const answered = await decide(ROOT, G.id, 'approve', (body as () => Record<string, unknown>)());
    expect([answered.status, answered.json?.code, answered.json?.subject, answered.json?.clause])
      .toEqual([422, 'EDIT_ONLY_NARROWS', 'decider', 'AZ-A9 clause 8']);
    expect((await approvalRow(G.id)).status).toBe('pending');
    expect(await grantsOf(G.id)).toEqual([]);
  });

  it('dropping a row and a verb and shortening the expiry writes exactly that', async () => {
    const shorter = inDays(10);
    const answered = await decide(ROOT, G.id, 'approve', { editedRules: [exactRule('task', [X2], ['read'])], editedExpiresAt: shorter });
    expect([answered.status, answered.json?.approval?.status]).toEqual([200, 'approved']);
    const grants = await grantsOf(G.id);
    expect(grants.map((g) => [String(g.resource_id), g.verb, new Date(g.expires_at).toISOString()]))
      .toEqual([[X2, 'read', new Date(shorter).toISOString()]]);
    const row = await approvalRow(G.id);
    expect(parseJson(row.approved_rules)).toEqual([exactRule('task', [X2], ['read'])]);
    expect(new Date(row.approved_expires_at).toISOString()).toBe(new Date(shorter).toISOString());
    expect(parseJson((await events(G.id, 'approval.approved'))[0].metadata).edited).toBe(true);
  });
});

describe('(5) the duplicate tuple is handled by name: expired replaced, live refused ALREADY_HELD', () => {
  let CONNECTOR: Bearer;
  let RELATED: string;

  beforeAll(async () => {
    CONNECTOR = await registerConnector(OWNER);
    RELATED = await ownerTask(OWNER, `P1-B related ${tag()}`, PROJECT_ID);
  });

  it('an EXPIRED identical row is replaced in the decide transaction', async () => {
    const X4 = await ownerTask(OTHER, `P1-B X4 ${tag()}`);
    const expired = await pool.query(
      `INSERT INTO grants (grantee_type, grantee_id, resource_type, resource_id, verb, expires_at)
       VALUES ('principal', $1, 'task', $2, 'read', NOW() - INTERVAL '1 day') RETURNING id`,
      [OWNER.principalId, X4],
    );
    const expiredId = String(expired.rows[0].id);
    const G = await fileOk(CONNECTOR, { requestedRules: [exactRule('task', [X4], ['read'])], relatedTaskId: RELATED });
    const answered = await decide(ROOT, G.id, 'approve');
    expect([answered.status, answered.json?.approval?.status]).toEqual([200, 'approved']);
    expect((await pool.query('SELECT id FROM grants WHERE id = $1', [expiredId])).rows).toEqual([]);
    const tuple = await pool.query(
      `SELECT id, approval_id FROM grants WHERE grantee_id = $1 AND resource_type = 'task' AND resource_id = $2 AND verb = 'read'`,
      [OWNER.principalId, X4]);
    expect(tuple.rows.map((row: any) => String(row.approval_id))).toEqual([G.id]);
    const replaced = await pool.query(
      `SELECT metadata FROM audit_events WHERE action = 'grant.revoke' AND resource_id = $1`, [expiredId]);
    expect(parseJson(replaced.rows[0].metadata)).toMatchObject({ reason: 'EXPIRED_REPLACED', approvalId: G.id });
  });

  it('a LIVE identical row refuses ALREADY_HELD naming it — never a unique violation — and the request stays pending', async () => {
    const X5 = await ownerTask(OTHER, `P1-B X5 ${tag()}`);
    const G = await fileOk(CONNECTOR, { requestedRules: [exactRule('task', [X5], ['read'])], relatedTaskId: RELATED });
    // Between filing and decide, the owner plane grants the same row.
    const live = await grantService.create({ granteeId: OWNER.principalId, resourceType: 'task', resourceId: X5, verb: 'read', expiresAt: inDays(5) }, SYSTEM);
    const answered = await decide(ROOT, G.id, 'approve');
    expect([answered.status, answered.json?.code, answered.json?.subject, answered.json?.coveringSource?.grantId])
      .toEqual([409, 'ALREADY_HELD', 'grantee', live.id]);
    expect((await approvalRow(G.id)).status).toBe('pending');
    const tuple = await pool.query(
      `SELECT COUNT(*)::int AS n FROM grants WHERE grantee_id = $1 AND resource_id = $2 AND verb = 'read'`, [OWNER.principalId, X5]);
    expect(tuple.rows[0].n).toBe(1);
  });
});

describe('(6) clause 12a: revoked at task-terminal by BOTH writers, never reused; the phase arm (ratified, E43 Q3)', () => {
  let CONNECTOR: Bearer;

  /** An approved request and a pending sibling, both related to `related`,
   * filed by a FRESH Connector: a failure in one test never leaves pending
   * requests behind that fill a later test's quota. */
  async function approvedAndPending(related: { relatedTaskId?: string; relatedPhaseId?: string }): Promise<{ approved: any; pending: any; x: string; y: string }> {
    CONNECTOR = await registerConnector(OWNER);
    const x = await ownerTask(OTHER, `P1-B terminal X ${tag()}`);
    const y = await ownerTask(OTHER, `P1-B terminal Y ${tag()}`);
    const approved = await fileOk(CONNECTOR, { requestedRules: [exactRule('task', [x], ['read'])], ...related });
    const pending = await fileOk(CONNECTOR, { requestedRules: [exactRule('task', [y], ['read'])], ...related });
    const answered = await decide(ROOT, approved.id, 'approve');
    expect(answered.status).toBe(200);
    expect(await grantsOf(approved.id)).toHaveLength(1);
    expect(await readsTask(OWNER, x)).toBe(200);
    return { approved, pending, x, y };
  }

  async function expectReaped(pair: { approved: any; pending: any; x: string }, reason: string, via: string): Promise<void> {
    expect(await grantsOf(pair.approved.id)).toEqual([]);
    expect(await readsTask(OWNER, pair.x)).toBe(404);
    const row = await approvalRow(pair.approved.id);
    expect(row.status).toBe('approved');
    const revoked = await events(pair.approved.id, 'approval.revoked');
    expect(revoked).toHaveLength(1);
    expect(parseJson(revoked[0].metadata)).toMatchObject({ kind: 'grant', reason, via });
    const grantRevoke = await pool.query(
      `SELECT metadata FROM audit_events WHERE action = 'grant.revoke' AND metadata->>'approvalId' = $1`, [pair.approved.id]);
    expect(grantRevoke.rows.map((r: any) => parseJson(r.metadata).reason)).toEqual([reason]);
    const lapsed = await approvalRow(pair.pending.id);
    expect([lapsed.status, lapsed.lapse_reason]).toEqual(['lapsed', reason]);
    expect(parseJson((await events(pair.pending.id, 'approval.lapsed'))[0].metadata)).toMatchObject({ kind: 'grant', reason });
  }

  it('updateTask: completing the related task by PATCH revokes the rows and lapses the pending sibling; reopening restores nothing', async () => {
    const R1 = await ownerTask(OWNER, `P1-B R1 ${tag()}`, PROJECT_ID);
    const pair = await approvedAndPending({ relatedTaskId: R1 });
    const completed = await call(OWNER, 'PATCH', `/tasks/${R1}`, { status: 'completed' }, { 'Idempotency-Key': key('complete') });
    expect(completed.status).toBe(200);
    await expectReaped(pair, 'TASK_TERMINAL', 'updateTask');
    const reopened = await call(OWNER, 'PATCH', `/tasks/${R1}`, { status: 'todo' }, { 'Idempotency-Key': key('reopen') });
    expect(reopened.status).toBe(200);
    expect(await grantsOf(pair.approved.id)).toEqual([]);
    expect(await readsTask(OWNER, pair.x)).toBe(404);
    expect((await approvalRow(pair.approved.id)).status).toBe('approved');
  });

  it('recordVerdict: the verifier\'s passing verdict on the related task does the same', async () => {
    const R2 = await ownerTask(OWNER, `P1-B R2 ${tag()}`, PROJECT_ID);
    const pair = await approvedAndPending({ relatedTaskId: R2 });
    await pool.query(`UPDATE tasks SET status = 'review' WHERE id = $1`, [R2]);
    const ledger = new TaskReviewAttemptService(pool);
    const attempt = await ledger.beginAttempt(await taskManagerDB.getTask(R2), { reportDigest: hashReviewReports([]) });
    const verdict = await ledger.recordVerdict(attempt.id, 'pass', [], { summary: 'P1-B drill verdict' }, undefined, false);
    expect(verdict).toMatchObject({ status: 'completed', applied: true });
    await expectReaped(pair, 'TASK_TERMINAL', 'recordVerdict');
  });

  it('phase arm: a phase-only request is revoked when its phase reaches completed', async () => {
    const created = await call(OWNER, 'POST', '/phases', { projectId: PROJECT_ID, name: `P1-B phase ${tag()}` }, { 'Idempotency-Key': key('phase') });
    expect(created.status).toBe(201);
    const phase = created.json.phase;
    const pair = await approvedAndPending({ relatedPhaseId: String(phase.id) });
    const done = await call(OWNER, 'PATCH', `/phases/${phase.id}`, { revision: phase.revision, status: 'completed' });
    expect(done.status).toBe(200);
    await expectReaped(pair, 'PHASE_TERMINAL', 'phase.update');
  });

  it('phase arm: and when its phase is archived', async () => {
    const created = await call(OWNER, 'POST', '/phases', { projectId: PROJECT_ID, name: `P1-B phase ${tag()}` }, { 'Idempotency-Key': key('phase') });
    expect(created.status).toBe(201);
    const phase = created.json.phase;
    const pair = await approvedAndPending({ relatedPhaseId: String(phase.id) });
    const archived = await call(OWNER, 'POST', `/phases/${phase.id}/archive`, { revision: phase.revision });
    expect(archived.status).toBe(200);
    await expectReaped(pair, 'PHASE_TERMINAL', 'phase.archive');
  });

  it('a row another task\'s assignment LINKS is handed over to that assignment, not deleted (ruling 7440b579 R1), and is reaped when that assignment ends', async () => {
    const R4 = await ownerTask(OWNER, `P1-B R4 ${tag()}`, PROJECT_ID);
    const ASSIGNED = await ownerTask(OWNER, `P1-B assigned ${tag()}`, PROJECT_ID);
    const pair = await approvedAndPending({ relatedTaskId: R4 });
    const [grant] = await grantsOf(pair.approved.id);
    // The assignment machinery LINKS an existing tuple instead of inserting a
    // second one (AccessVehicleService.ensureGrant: created_by_vehicle FALSE),
    // and lands on the chain-root Account — the row this approval wrote.
    await pool.query(
      `INSERT INTO access_vehicle_links (task_id, assignee_principal_id, landed_on_principal_id, vehicle_kind,
         target_kind, target_id, created_by_vehicle)
       VALUES ($1, $2, $3, 'auto-grant', 'grant', $4, FALSE)`,
      [ASSIGNED, CONNECTOR.principalId, OWNER.principalId, grant.id],
    );
    const completed = await call(OWNER, 'PATCH', `/tasks/${R4}`, { status: 'completed' }, { 'Idempotency-Key': key('complete') });
    expect(completed.status).toBe(200);
    const kept = await pool.query('SELECT approval_id, provenance FROM grants WHERE id = $1', [grant.id]);
    expect(kept.rows).toEqual([{ approval_id: null, provenance: 'assignment:grant' }]);
    expect(await readsTask(OWNER, pair.x)).toBe(200);
    const link = await pool.query('SELECT created_by_vehicle FROM access_vehicle_links WHERE target_id = $1', [grant.id]);
    expect(link.rows).toEqual([{ created_by_vehicle: true }]);
    const revoked = await events(pair.approved.id, 'approval.revoked');
    expect(parseJson(revoked[0].metadata)).toMatchObject({
      reason: 'TASK_TERMINAL', revokedGrantIds: [], handedOverGrantIds: [{ grantId: String(grant.id), taskIds: [ASSIGNED] }],
    });
    const handover = await pool.query(`SELECT metadata FROM audit_events WHERE action = 'grant.handover' AND resource_id = $1`, [grant.id]);
    expect(parseJson(handover.rows[0].metadata)).toMatchObject({ approvalId: pair.approved.id, reason: 'TASK_TERMINAL' });
    // The pending sibling still lapses, and the approval keeps nothing.
    expect((await approvalRow(pair.pending.id)).lapse_reason).toBe('TASK_TERMINAL');
    expect(await grantsOf(pair.approved.id)).toEqual([]);
    // When that assignment ends, the vehicle that now owns the row reaps it.
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await accessVehicleService.detach(client, ASSIGNED, SYSTEM, 'P1-B drill: the assignment ended');
      await client.query('COMMIT');
    } finally {
      client.release();
    }
    expect((await pool.query('SELECT id FROM grants WHERE id = $1', [grant.id])).rows).toEqual([]);
  });

  it('a hard delete of the related task reaps before the row goes', async () => {
    const R3 = await ownerTask(OWNER, `P1-B R3 ${tag()}`, PROJECT_ID);
    const pair = await approvedAndPending({ relatedTaskId: R3 });
    await taskManagerDB.deleteTask(R3, { handle: 'p1b-drill', role: 'orchestrator', principalId: null });
    await expectReaped(pair, 'TASK_TERMINAL', 'deleteTask');
    expect((await approvalRow(pair.approved.id)).related_task_id).toBeNull();
  });
});

describe('clause 11 at decide: the decider ceiling re-runs clause 5 on the rows as written', () => {
  it('a stored row no filing could produce (a surface rule) is refused at decide and writes nothing', async () => {
    const CONNECTOR = await registerConnector(OWNER);
    const RELATED = await ownerTask(OWNER, `P1-B related ${tag()}`, PROJECT_ID);
    const surface = crypto.randomUUID();
    const inserted = await pool.query(
      `INSERT INTO approvals (kind, requester_principal_id, requesting_credential_id, grantee_principal_id,
         requested_scopes, requested_rules, requested_expires_at, reason, related_task_id, pending_expires_at)
       VALUES ('grant', $1, $2, $3, '[]'::jsonb, $4::jsonb, NOW() + INTERVAL '5 days', $5, $6, NOW() + INTERVAL '5 days')
       RETURNING id`,
      [CONNECTOR.principalId, CONNECTOR.credentialId, OWNER.principalId,
        JSON.stringify([exactRule('surface', [surface], ['read'])]), REASON, RELATED],
    );
    const id = String(inserted.rows[0].id);
    const answered = await decide(ROOT, id, 'approve');
    expect([answered.status, answered.json?.code, answered.json?.subject]).toEqual([422, 'SURFACE_NOT_ADMISSIBLE', 'decider']);
    expect((await approvalRow(id)).status).toBe('pending');
    expect((await pool.query(`SELECT COUNT(*)::int AS n FROM grants WHERE resource_id = $1`, [surface])).rows[0].n).toBe(0);
  });
});

describe('(9) clause 9: five bearer-only routes under /delegation/access-requests', () => {
  let CONNECTOR: Bearer;
  let OTHER_CONNECTOR: Bearer;
  let RELATED: string;
  let X: string;
  let G: any;

  beforeAll(async () => {
    CONNECTOR = await registerConnector(OWNER);
    OTHER_CONNECTOR = await registerConnector(OTHER);
    RELATED = await ownerTask(OWNER, `P1-B related ${tag()}`, PROJECT_ID);
    X = await ownerTask(OTHER, `P1-B X ${tag()}`);
    G = await fileOk(CONNECTOR, { requestedRules: [exactRule('task', [X], ['read'])], relatedTaskId: RELATED });
  });

  it('the ceiling row is `authenticated` for every method on the family, and /grants stays root', () => {
    for (const [method, path] of [
      ['POST', '/delegation/access-requests'], ['GET', '/delegation/access-requests'],
      ['GET', `/delegation/access-requests/${crypto.randomUUID()}`],
      ['POST', `/delegation/access-requests/${crypto.randomUUID()}/withdraw`],
      ['POST', `/delegation/access-requests/${crypto.randomUUID()}/collect`],
    ]) {
      expect([method, path, requiredScopeFor(method, path)]).toEqual([method, path, 'authenticated']);
    }
    expect(requiredScopeFor('POST', '/grants')).toBe('root');
  });

  it.each([
    ['POST', '/delegation/access-requests'],
    ['GET', '/delegation/access-requests'],
    ['GET', '/delegation/access-requests/:id'],
    ['POST', '/delegation/access-requests/:id/withdraw'],
    ['POST', '/delegation/access-requests/:id/collect'],
  ])('a login session on %s %s is refused AGENT_PLANE_ONLY, with a durable audit', async (method, path) => {
    const before = await pool.query(
      `SELECT COUNT(*)::int AS n FROM audit_events WHERE outcome = 'denied' AND resource_id = $1
          AND metadata->>'refusal' = 'AGENT_PLANE_ONLY'`, [OWNER.principalId]);
    const answered = await call(OWNER, method, path.replace(':id', G.id),
      method === 'POST' ? { kind: 'grant', requestedRules: [exactRule('task', [X], ['read'])], relatedTaskId: RELATED } : undefined);
    expect([answered.status, answered.json?.code, answered.json?.subject, answered.json?.clause])
      .toEqual([403, 'AGENT_PLANE_ONLY', 'requester', 'AZ-A9 clause 9']);
    const after = await pool.query(
      `SELECT COUNT(*)::int AS n FROM audit_events WHERE outcome = 'denied' AND resource_id = $1
          AND metadata->>'refusal' = 'AGENT_PLANE_ONLY'`, [OWNER.principalId]);
    expect(after.rows[0].n).toBe(before.rows[0].n + 1);
    expect((await approvalRow(G.id)).status).toBe('pending');
    const filedBySession = await pool.query('SELECT COUNT(*)::int AS n FROM approvals WHERE requester_principal_id = $1', [OWNER.principalId]);
    expect(filedBySession.rows[0].n).toBe(0);
  });

  it('lists and reads ONLY the caller\'s own requests; another Connector\'s read is answered exactly as an absent id', async () => {
    const listed = await call(CONNECTOR, 'GET', '/delegation/access-requests?kind=grant');
    expect(listed.status).toBe(200);
    expect(listed.json.approvals.map((a: any) => a.id)).toEqual([G.id]);
    const own = await call(CONNECTOR, 'GET', `/delegation/access-requests/${G.id}`);
    expect([own.status, own.json?.approval?.id, own.json?.approval?.kind, own.json?.approval?.status])
      .toEqual([200, G.id, 'grant', 'pending']);
    const foreign = await call(OTHER_CONNECTOR, 'GET', `/delegation/access-requests/${G.id}`);
    const absent = await call(OTHER_CONNECTOR, 'GET', `/delegation/access-requests/${crypto.randomUUID()}`);
    expect([foreign.status, foreign.json]).toEqual([absent.status, absent.json]);
    expect([foreign.status, foreign.json?.code]).toEqual([404, 'APPROVAL_NOT_FOUND']);
    expect((await call(OTHER_CONNECTOR, 'GET', '/delegation/access-requests')).json.approvals).toEqual([]);
  });

  it('an agent-mint approval is not an access request: the read answers it as absent', async () => {
    const target = await ownerTask(OWNER, `P1-B mint target ${tag()}`, PROJECT_ID);
    const minted = await call(CONNECTOR, 'POST', '/delegation/agent-mints',
      { targetTaskId: target, requestedScopes: ['tasks:read'], via: 'approval' }, { 'Idempotency-Key': key('mint') });
    expect(minted.status).toBe(202);
    const read = await call(CONNECTOR, 'GET', `/delegation/access-requests/${minted.json.approval.id}`);
    expect([read.status, read.json?.code]).toEqual([404, 'APPROVAL_NOT_FOUND']);
    const listed = await call(CONNECTOR, 'GET', '/delegation/access-requests');
    expect(listed.json.approvals.map((a: any) => a.id)).not.toContain(minted.json.approval.id);
  });

  it('a body field outside clause 3 is refused UNKNOWN_FIELD by name, and files nothing', async () => {
    const before = await pool.query('SELECT COUNT(*)::int AS n FROM approvals WHERE requester_principal_id = $1', [CONNECTOR.principalId]);
    const filed = await file(CONNECTOR, { requestedRules: [exactRule('task', [X], ['read'])], relatedTaskId: RELATED, approvedRules: [] });
    expect(filed.ok ? null : [filed.status, filed.body.code, filed.body.clause]).toEqual([422, 'UNKNOWN_FIELD', 'AZ-A9 clause 3']);
    const after = await pool.query('SELECT COUNT(*)::int AS n FROM approvals WHERE requester_principal_id = $1', [CONNECTOR.principalId]);
    expect(after.rows[0].n).toBe(before.rows[0].n);
  });

  it('collect refuses a grant request 409 NOT_COLLECTABLE by name; another Connector gets 404', async () => {
    const collected = await call(CONNECTOR, 'POST', `/delegation/access-requests/${G.id}/collect`, {});
    expect([collected.status, collected.json?.code, collected.json?.subject, collected.json?.clause, collected.json?.kind])
      .toEqual([409, 'NOT_COLLECTABLE', 'requester', 'AZ-A9 clause 9', 'grant']);
    const foreign = await call(OTHER_CONNECTOR, 'POST', `/delegation/access-requests/${G.id}/collect`, {});
    expect([foreign.status, foreign.json?.code]).toEqual([404, 'APPROVAL_NOT_FOUND']);
    const audit = await pool.query(
      `SELECT COUNT(*)::int AS n FROM audit_events WHERE action = 'approval.collect' AND outcome = 'denied'
          AND resource_id = $1 AND metadata->>'refusal' = 'NOT_COLLECTABLE'`, [G.id]);
    expect(audit.rows[0].n).toBe(1);
    expect((await approvalRow(G.id)).status).toBe('pending');
  });

  it('withdraw lapses the caller\'s own pending request WITHDRAWN; a repeat is refused APPROVAL_NOT_PENDING; another Connector gets 404', async () => {
    const W = await fileOk(CONNECTOR, { requestedRules: [exactRule('task', [X], ['read'])], relatedTaskId: RELATED });
    const foreign = await call(OTHER_CONNECTOR, 'POST', `/delegation/access-requests/${W.id}/withdraw`, {});
    expect([foreign.status, foreign.json?.code]).toEqual([404, 'APPROVAL_NOT_FOUND']);
    const withdrawn = await call(CONNECTOR, 'POST', `/delegation/access-requests/${W.id}/withdraw`, {});
    expect([withdrawn.status, withdrawn.json?.approval?.status, withdrawn.json?.approval?.lapseReason])
      .toEqual([200, 'lapsed', 'WITHDRAWN']);
    expect(parseJson((await events(W.id, 'approval.lapsed'))[0].metadata)).toEqual({ reason: 'WITHDRAWN', kind: 'grant' });
    const again = await call(CONNECTOR, 'POST', `/delegation/access-requests/${W.id}/withdraw`, {});
    expect([again.status, again.json?.code, again.json?.clause]).toEqual([409, 'APPROVAL_NOT_PENDING', 'AZ-A9 clause 9']);
  });
});

describe('(10) clause 10: relayhall_access_request, through the MCP ingress to the same routes', () => {
  let CONNECTOR: Bearer;
  let RELATED: string;
  let X: string;

  beforeAll(async () => {
    // transport 'any': an api-pinned credential is refused at the MCP ingress.
    CONNECTOR = await registerConnector(OWNER, FOUR_SCOPES, 'any');
    RELATED = await ownerTask(OWNER, `P1-B related ${tag()}`, PROJECT_ID);
    X = await ownerTask(OTHER, `P1-B X ${tag()}`);
    const brief = await mcpCall(CONNECTOR, 'relayhall_brief_compile', { session: true });
    expect(mcpFailed(brief)).toBe(false);
  });

  it('action file: one pending Approval of kind grant, grantee the chain-root Account', async () => {
    const filed = await mcpCall(CONNECTOR, 'relayhall_access_request', {
      action: 'file', kind: 'grant', requestedRules: [exactRule('task', [X], ['read'])], reason: REASON, relatedTaskId: RELATED,
    });
    expect(mcpFailed(filed)).toBe(false);
    const id = String(JSON.parse(mcpText(filed)).approval.id);
    const row = await approvalRow(id);
    expect([row.kind, row.status, String(row.requester_principal_id), String(row.requesting_credential_id), String(row.grantee_principal_id)])
      .toEqual(['grant', 'pending', CONNECTOR.principalId, CONNECTOR.credentialId, OWNER.principalId]);
  });

  it('the same refusals by name through the tool: GRANTEE_INERT, the admin verb, and BUNDLED_ROWS_NOT_AVAILABLE for credential', async () => {
    const inert = await mcpCall(CONNECTOR, 'relayhall_access_request', {
      action: 'file', kind: 'grant', requestedRules: [exactRule('task', [X], ['read'])], reason: REASON, relatedTaskId: RELATED,
      granteePrincipalId: CONNECTOR.principalId,
    });
    expect([mcpFailed(inert), mcpText(inert).includes('GRANTEE_INERT')]).toEqual([true, true]);
    const admin = await mcpCall(CONNECTOR, 'relayhall_access_request', {
      action: 'file', kind: 'grant', requestedRules: [exactRule('task', [X], ['admin'])], reason: REASON, relatedTaskId: RELATED,
    });
    expect([mcpFailed(admin), mcpText(admin).includes('ADMIN_VERB_NOT_ADMISSIBLE')]).toEqual([true, true]);
    const credential = await mcpCall(CONNECTOR, 'relayhall_access_request', {
      action: 'file', kind: 'credential', requestedScopes: ['phases:write'], requestedRules: [exactRule('task', [X], ['read'])],
      reason: REASON, relatedTaskId: RELATED,
    });
    expect([mcpFailed(credential), mcpText(credential).includes('BUNDLED_ROWS_NOT_AVAILABLE')]).toEqual([true, true]);
  });

  it('action status lists and reads; withdraw lapses; collect is refused NOT_COLLECTABLE', async () => {
    const filed = await mcpCall(CONNECTOR, 'relayhall_access_request', {
      action: 'file', kind: 'grant', requestedRules: [exactRule('task', [X], ['read'])], reason: REASON, relatedTaskId: RELATED,
    });
    const id = String(JSON.parse(mcpText(filed)).approval.id);
    const listed = await mcpCall(CONNECTOR, 'relayhall_access_request', { action: 'status' });
    expect(JSON.parse(mcpText(listed)).approvals.map((a: any) => a.id)).toContain(id);
    const one = await mcpCall(CONNECTOR, 'relayhall_access_request', { action: 'status', approvalId: id });
    expect(JSON.parse(mcpText(one)).approval).toMatchObject({ id, kind: 'grant', status: 'pending' });
    const collected = await mcpCall(CONNECTOR, 'relayhall_access_request', { action: 'collect', approvalId: id });
    expect([mcpFailed(collected), mcpText(collected).includes('NOT_COLLECTABLE')]).toEqual([true, true]);
    const withdrawn = await mcpCall(CONNECTOR, 'relayhall_access_request', { action: 'withdraw', approvalId: id });
    expect(mcpFailed(withdrawn)).toBe(false);
    expect([(await approvalRow(id)).status, (await approvalRow(id)).lapse_reason]).toEqual(['lapsed', 'WITHDRAWN']);
  });
});

describe('(3b) clause 7: what the decider sees, as data on GET /approvals/:id and the queue', () => {
  let CONNECTOR: Bearer;
  let AGENT: Bearer & { approvalId: string };
  let BOUND: string;
  let BOUND_TITLE: string;
  let X: string;
  let X_TITLE: string;
  let G: any;

  beforeAll(async () => {
    CONNECTOR = await registerConnector(OWNER);
    BOUND_TITLE = `P1-B decision bound ${tag()}`;
    BOUND = await ownerTask(OWNER, BOUND_TITLE, PROJECT_ID);
    AGENT = await mintAgent(CONNECTOR, OWNER, BOUND);
    X_TITLE = `P1-B decision X ${tag()}`;
    X = await ownerTask(OTHER, X_TITLE);
    G = await fileOk(AGENT, {
      requestedRules: [
        exactRule('task', [X], ['read']),
        { resourceType: 'report', selectorForm: 'all-of-type', selectorIds: [], verbs: ['read'] },
      ],
      relatedTaskId: BOUND, requestedExpiresAt: inDays(21),
    });
  });

  it('root reads the requester chain and credential, the grantee, each row with its title, the holdings, the related task and project with its ownership class, the clause-11 preview, the quota and the TTL', async () => {
    const answered = await call(ROOT, 'GET', `/approvals/${G.id}`);
    expect(answered.status).toBe(200);
    const decision = answered.json.decision;
    expect(decision.requester.chain.map((link: any) => link.principalId))
      .toEqual([AGENT.principalId, CONNECTOR.principalId, OWNER.principalId]);
    const label = await pool.query('SELECT label FROM principal_credentials WHERE id = $1', [AGENT.credentialId]);
    expect(decision.requestingCredential).toMatchObject({ id: AGENT.credentialId, label: label.rows[0].label, revoked: false });
    expect(decision.grantee).toMatchObject({ principalId: OWNER.principalId, kind: 'human', status: 'active' });
    expect(decision.rules).toEqual([
      { resourceType: 'task', selectorForm: 'exact', verbs: ['read'], objects: [{ id: X, title: X_TITLE }], allOfType: null },
      { resourceType: 'report', selectorForm: 'all-of-type', verbs: ['read'], objects: [], allOfType: 'every current and future object of this type' },
    ]);
    expect(decision.holdings.map((h: any) => [h.resourceType, h.objectId, h.verb, h.held]))
      .toEqual([['task', X, 'read', false], ['report', null, 'read', false]]);
    expect(decision.reason).toBe(REASON);
    expect(decision.related.task).toMatchObject({ id: BOUND, title: BOUND_TITLE });
    expect(decision.related.project).toMatchObject({ id: PROJECT_ID, ownershipClass: 'private', groups: [] });
    expect(decision.clause11).toMatchObject({ requesterLive: { ok: true }, granteeActive: true, deciderCeiling: { ok: true }, alreadyHeld: [] });
    expect(decision.quota).toMatchObject({ pending: 1, quotaPending: 5, quotaDaily: 20 });
    expect(decision.pendingTtl.msRemaining).toBeGreaterThan(6 * DAY);
    expect(answered.json.events.map((e: any) => e.action)).toEqual(['approval.requested']);
  });

  it('the blast radius: the Connector (own() = parent) is in it for both rows; the Agent, capped to its bound Task, is not', async () => {
    const decision = (await call(ROOT, 'GET', `/approvals/${G.id}`)).json.decision;
    const byId = new Map(decision.affectedIdentities.map((identity: any) => [identity.principalId, identity]));
    expect((byId.get(CONNECTOR.principalId) as any)?.admitted).toEqual([
      { resourceType: 'task', objectId: X, verb: 'read', admits: true },
      { resourceType: 'report', objectId: null, verb: 'read', admits: true },
    ]);
    expect(byId.has(AGENT.principalId)).toBe(false);
    // Every identity named lies under the grantee Account.
    for (const identity of decision.affectedIdentities) {
      const chain = await pool.query(
        `WITH RECURSIVE up AS (SELECT id, parent_principal_id FROM principals WHERE id = $1
           UNION ALL SELECT p.id, p.parent_principal_id FROM principals p JOIN up ON p.id = up.parent_principal_id)
         SELECT id FROM up`, [identity.principalId]);
      expect(chain.rows.map((row: any) => String(row.id))).toContain(OWNER.principalId);
    }
  });

  it('a holding the grantee gains after filing shows up as held, naming its source, and in the clause-11 preview', async () => {
    const held = await grantService.create({ granteeId: OWNER.principalId, resourceType: 'report', resourceId: null, verb: 'read', expiresAt: inDays(3) }, SYSTEM);
    try {
      const decision = (await call(ROOT, 'GET', `/approvals/${G.id}`)).json.decision;
      const report = decision.holdings.find((h: any) => h.resourceType === 'report');
      expect([report.held, report.coveringSource?.grantId]).toEqual([true, held.id]);
      expect(decision.clause11.alreadyHeld.map((h: any) => h.resourceType)).toEqual(['report']);
    } finally {
      await pool.query('DELETE FROM grants WHERE id = $1', [held.id]);
    }
  });

  it('the non-administrator owning Account reads the item with ids only, and no decision context', async () => {
    const answered = await call(OWNER, 'GET', `/approvals/${G.id}`);
    expect(answered.status).toBe(200);
    expect(answered.json.decision).toBeNull();
    expect(answered.json.approval.accessRequest.ruleViews[0].objects).toEqual([{ id: X, title: null }]);
  });

  it('the queue list (?kind=grant) carries each row as the decider reads it; agent-mint rows carry none of it', async () => {
    const listed = await call(ROOT, 'GET', '/approvals?kind=grant&status=pending');
    const row = listed.json.approvals.find((a: any) => a.id === G.id);
    expect(row.kind).toBe('grant');
    expect(row.accessRequest.ruleViews[0].objects).toEqual([{ id: X, title: X_TITLE }]);
    expect(row.accessRequest.ruleViews[1].allOfType).toBe('every current and future object of this type');
    expect(row.accessRequest).toMatchObject({ relatedTaskId: BOUND, relatedTaskTitle: BOUND_TITLE, relatedProjectId: PROJECT_ID });
    const mints = await call(ROOT, 'GET', '/approvals?kind=agent-mint');
    expect(mints.json.approvals.length).toBeGreaterThan(0);
    for (const mint of mints.json.approvals) {
      expect(Object.keys(mint).sort()).toEqual([
        'approvedRules', 'approvedScopes', 'collectExpiresAt', 'collectedAt', 'decidedAt', 'decidedByPrincipalId',
        'denialReason', 'id', 'kind', 'lapseReason', 'mintedPrincipalId', 'pendingExpiresAt', 'requestedAt',
        // AZ-A10 clause 2: an agent-mint row carries the requested role (approvals.requested_role).
        'requestedRole', 'requestedRules', 'requestedScopes', 'requesterHandle', 'requesterPrincipalId', 'requestingCredentialId',
        'sessionEvidence', 'status', 'targetTaskId', 'targetTaskTitle',
      ]);
    }
  });
});

describe('(9b) the five families join settings.access-manager, and the Access-surface census (D15) stays green', () => {
  it('the access-manager row carries the two read and three write families', async () => {
    const row = (await pool.query(
      `SELECT read_families, write_families FROM access_surfaces WHERE key = 'settings.access-manager'`)).rows[0];
    expect(row.read_families).toEqual(expect.arrayContaining([
      'GET /delegation/access-requests', 'GET /delegation/access-requests/:approvalId']));
    expect(row.write_families).toEqual(expect.arrayContaining([
      'POST /delegation/access-requests', 'POST /delegation/access-requests/:approvalId/withdraw',
      'POST /delegation/access-requests/:approvalId/collect']));
    const elsewhere = await pool.query(
      `SELECT key FROM access_surfaces WHERE key <> 'settings.access-manager'
          AND EXISTS (SELECT 1 FROM unnest(read_families || write_families) f WHERE f LIKE '%/access-requests%')`);
    expect(elsewhere.rows).toEqual([]);
  });

  it('the boot census over the migrated catalogue finds nothing: no overlap, every family served', async () => {
    expect(await accessSurfaceService.auditCatalogue()).toEqual([]);
  });
});

describe('withdraw and AZ-31c rotation', () => {
  it('the requester withdraws its own pending request: lapsed WITHDRAWN, carrying the kind; a stranger cannot', async () => {
    const CONNECTOR = await registerConnector(OWNER);
    const OTHER_CONNECTOR = await registerConnector(OTHER);
    const RELATED = await ownerTask(OWNER, `P1-B related ${tag()}`, PROJECT_ID);
    const X = await ownerTask(OTHER, `P1-B X ${tag()}`);
    const G = await fileOk(CONNECTOR, { requestedRules: [exactRule('task', [X], ['read'])], relatedTaskId: RELATED });
    await expect(approvalService.withdrawAccessRequest({ approvalId: G.id, requesterPrincipalId: OTHER_CONNECTOR.principalId }, SYSTEM))
      .rejects.toMatchObject({ code: 'APPROVAL_NOT_FOUND' });
    const withdrawn = await approvalService.withdrawAccessRequest({ approvalId: G.id, requesterPrincipalId: CONNECTOR.principalId }, SYSTEM);
    expect([withdrawn.status, withdrawn.lapseReason]).toEqual(['lapsed', 'WITHDRAWN']);
    expect(parseJson((await events(G.id, 'approval.lapsed'))[0].metadata)).toEqual({ reason: 'WITHDRAWN', kind: 'grant' });
  });

  it('a rotated bound credential lapses the PENDING grant request and leaves the APPROVED one terminal', async () => {
    const CONNECTOR = await registerConnector(OWNER);
    const RELATED = await ownerTask(OWNER, `P1-B related ${tag()}`, PROJECT_ID);
    const X = await ownerTask(OTHER, `P1-B X ${tag()}`);
    const Y = await ownerTask(OTHER, `P1-B Y ${tag()}`);
    const approved = await fileOk(CONNECTOR, { requestedRules: [exactRule('task', [X], ['read'])], relatedTaskId: RELATED });
    const pending = await fileOk(CONNECTOR, { requestedRules: [exactRule('task', [Y], ['read'])], relatedTaskId: RELATED });
    expect((await decide(ROOT, approved.id, 'approve')).status).toBe(200);
    const lapsedCount = await invalidateApprovalsForCredentials(pool, [CONNECTOR.credentialId], 'rotated', SYSTEM);
    expect(lapsedCount).toBe(1);
    expect([(await approvalRow(pending.id)).status, (await approvalRow(pending.id)).lapse_reason]).toEqual(['lapsed', 'CREDENTIAL_ROTATED']);
    expect((await approvalRow(approved.id)).status).toBe('approved');
    expect(await grantsOf(approved.id)).toHaveLength(1);
  });
});

// ───────── slice P1-B-2: the deltas P1-B review carried, on the grant kind ─────────

describe('P1-B-2 deltas on the grant kind: the repoint, the sweep, the requester view (E49) and the notice text', () => {
  it('nice-to-have 2: an expired row a vehicle CREATED is replaced, and the link now names the approval\'s row with created_by_vehicle FALSE', async () => {
    const CONNECTOR = await registerConnector(OWNER);
    const RELATED = await ownerTask(OWNER, `P1-B-2 related ${tag()}`, PROJECT_ID);
    const ASSIGNED = await ownerTask(OWNER, `P1-B-2 assigned ${tag()}`, PROJECT_ID);
    const X = await ownerTask(OTHER, `P1-B-2 X ${tag()}`);
    const expired = await pool.query(
      `INSERT INTO grants (grantee_type, grantee_id, resource_type, resource_id, verb, expires_at, provenance)
       VALUES ('principal', $1, 'task', $2, 'read', NOW() - INTERVAL '1 day', 'assignment:grant') RETURNING id`,
      [OWNER.principalId, X],
    );
    const expiredId = String(expired.rows[0].id);
    await pool.query(
      `INSERT INTO access_vehicle_links (task_id, assignee_principal_id, landed_on_principal_id, vehicle_kind,
         target_kind, target_id, created_by_vehicle)
       VALUES ($1, $2, $3, 'auto-grant', 'grant', $4, TRUE)`,
      [ASSIGNED, CONNECTOR.principalId, OWNER.principalId, expiredId],
    );
    const G = await fileOk(CONNECTOR, { requestedRules: [exactRule('task', [X], ['read'])], relatedTaskId: RELATED });
    expect((await decide(ROOT, G.id, 'approve')).status).toBe(200);
    const [written] = await grantsOf(G.id);
    // AZ-A10 clause 1(d): creating ASSIGNED also linked the creator's shepherd role row; this
    // drill is about the auto-grant link the fixture wrote, so it reads that vehicle alone.
    const link = await pool.query(
      `SELECT target_id, created_by_vehicle FROM access_vehicle_links
        WHERE task_id = $1 AND target_kind = 'grant' AND vehicle_kind = 'auto-grant'`, [ASSIGNED]);
    expect(link.rows.map((row: any) => [String(row.target_id), row.created_by_vehicle])).toEqual([[String(written.id), false]]);
    // So the assignment ending never reaps the approval's row.
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await accessVehicleService.detach(client, ASSIGNED, SYSTEM, 'P1-B-2 drill: the assignment ended');
      await client.query('COMMIT');
    } finally {
      client.release();
    }
    expect((await pool.query('SELECT approval_id FROM grants WHERE id = $1', [written.id])).rows).toEqual([{ approval_id: G.id }]);
  });

  it('nice-to-have 3: the TTL sweep lapses a pending request whose own requested expiry has passed', async () => {
    const CONNECTOR = await registerConnector(OWNER);
    const RELATED = await ownerTask(OWNER, `P1-B-2 related ${tag()}`, PROJECT_ID);
    const X = await ownerTask(OTHER, `P1-B-2 X ${tag()}`);
    // A row filed two days ago that asked for one day: its expiry passed while
    // its 7-day pending TTL did not (no filing today could produce it).
    const inserted = await pool.query(
      `INSERT INTO approvals (kind, requester_principal_id, requesting_credential_id, grantee_principal_id,
         requested_scopes, requested_rules, requested_expires_at, reason, related_task_id, requested_at, pending_expires_at)
       VALUES ('grant', $1, $2, $3, '[]'::jsonb, $4::jsonb, NOW() - INTERVAL '1 day', $5, $6,
               NOW() - INTERVAL '2 days', NOW() + INTERVAL '5 days')
       RETURNING id`,
      [CONNECTOR.principalId, CONNECTOR.credentialId, OWNER.principalId,
        JSON.stringify([exactRule('task', [X], ['read'])]), REASON, RELATED],
    );
    const id = String(inserted.rows[0].id);
    await approvalService.sweepTtls(SYSTEM);
    const row = await approvalRow(id);
    expect([row.status, row.lapse_reason]).toEqual(['lapsed', 'PENDING_EXPIRED']);
    expect(parseJson((await events(id, 'approval.lapsed'))[0].metadata)).toEqual({ reason: 'PENDING_EXPIRED', kind: 'grant' });
  });

  it('E49 (a): the requester view names each created row and its state, and revokedAt once clause 12a revoked them', async () => {
    const CONNECTOR = await registerConnector(OWNER);
    const RELATED = await ownerTask(OWNER, `P1-B-2 related ${tag()}`, PROJECT_ID);
    const X = await ownerTask(OTHER, `P1-B-2 X ${tag()}`);
    const G = await fileOk(CONNECTOR, { requestedRules: [exactRule('task', [X], ['read'])], relatedTaskId: RELATED });
    expect(G).toMatchObject({ createdGrants: [], revokedAt: null });
    expect((await decide(ROOT, G.id, 'approve')).status).toBe(200);
    const [written] = await grantsOf(G.id);
    const before = await call(CONNECTOR, 'GET', `/delegation/access-requests/${G.id}`);
    expect(before.json.approval).toMatchObject({
      status: 'approved', revokedAt: null, createdGrants: [{ id: String(written.id), state: 'live' }],
    });
    const completed = await call(OWNER, 'PATCH', `/tasks/${RELATED}`, { status: 'completed' }, { 'Idempotency-Key': key('complete') });
    expect(completed.status).toBe(200);
    const after = await call(CONNECTOR, 'GET', `/delegation/access-requests/${G.id}`);
    expect(after.json.approval).toMatchObject({ status: 'approved', createdGrants: [{ id: String(written.id), state: 'revoked' }] });
    expect(typeof after.json.approval.revokedAt).toBe('string');
    const listed = await call(CONNECTOR, 'GET', '/delegation/access-requests');
    expect(listed.json.approvals.find((a: any) => a.id === G.id).createdGrants).toEqual([
      { id: String(written.id), state: 'revoked', expiresAt: null },
    ]);
    // Still never the decider's identity or step-up evidence.
    for (const withheld of ['decidedByPrincipalId', 'decisionStepUp', 'sessionEvidence']) {
      expect(Object.keys(after.json.approval)).not.toContain(withheld);
    }
  });

  it('nice-to-have 6: the endpoint notice names the kind it asks about', async () => {
    const spy = jest.spyOn(notificationEndpointService, 'dispatchException').mockResolvedValue(undefined as any);
    try {
      const CONNECTOR = await registerConnector(OWNER);
      const RELATED = await ownerTask(OWNER, `P1-B-2 related ${tag()}`, PROJECT_ID);
      const X = await ownerTask(OTHER, `P1-B-2 X ${tag()}`);
      const G = await fileOk(CONNECTOR, { requestedRules: [exactRule('task', [X], ['read'])], relatedTaskId: RELATED });
      const notices = spy.mock.calls.map((args: any[]) => args[0]).filter((notice: any) => notice.objectId === G.id);
      expect(notices).toHaveLength(1);
      expect(notices[0].reason).toBe(
        `grant approval requested by connector-${CONNECTOR.label}; decide on the board: /dashboard/settings/access-manager?approval=${G.id}`);
    } finally {
      spy.mockRestore();
    }
  });
});
