/**
 * Card 9ce0b0b0, train T2 slice S4 — the identity targets of the universal
 * change request (kind `change`; design ratified by owner ruling E325,
 * sections 3, 4.1, 5.1-5.5, 6, 7.1, 9.1 and 12 Q4, Q25, Q31), over a REAL
 * PostgreSQL and the PRODUCTION router and MCP ingress.
 *
 * It measures, on stored rows (the "identity" section of the change-request
 * suites; train T2's object targets join this file in slice S5):
 *
 *   (I) identity.role through the lifted role-change seam: a person asks for
 *       its own role on the session door and an administrator decides with
 *       one step-up (the first use); the role bites on the next request; the
 *       ordinary user's limits (its own Account, ceiling class 2), an elevated
 *       role decided only by an admin issuer, narrowing to a lower role only,
 *       the target's own Account refused (section 5.5 (c)), the stale check.
 *       identity.create decided by a root session only. identity.status on
 *       BOTH doors through the one account-status seam: a disable revokes the
 *       stored login sessions and lapses the requests naming the Account as
 *       grantee. credential.revoke of another principal's credential.
 *   (W) warrant.create filed over MCP (the R9:187 behavioural control: the
 *       filing writes no warrant and no MCP path reaches /warrants), created
 *       by the decider with the decision's step-up as the act's evidence;
 *       warrant.edit narrowed and applied in place, a pin never loosened
 *       through a request; warrant.revoke and warrant.resume; the holder's
 *       Account refused (section 5.5 (d)); the stale check on riding tasks.
 *   (P) the preview answers the identity targets with their deciders and
 *       writes nothing.
 *
 * DESTRUCTIVE: writes principals, credentials, login sessions, projects,
 * warrants, approvals, step-up tokens and audit rows. It refuses any
 * deployment database and any non-local host, and FAILS — never skips —
 * without a disposable one.
 */

/* eslint-disable @typescript-eslint/no-var-requires */

import http from 'http';
import crypto from 'crypto';

const TEST_DB_URL = process.env.RELAYHALL_TEST_DB_URL;
if (!TEST_DB_URL) {
  throw new Error('RELAYHALL_TEST_DB_URL is required: change-request targets are measured on stored principal, credential, '
    + 'warrant, approval and audit rows, so this suite never skips. Load database/init.sql into a disposable database, '
    + 'run npm run migrate, and point RELAYHALL_TEST_DB_URL at it.');
}
const parsed = new URL(TEST_DB_URL);
const TEST_DB_NAME = decodeURIComponent(parsed.pathname.slice(1));
const localDisposable = ['127.0.0.1', 'localhost', '[::1]'].includes(parsed.hostname)
  && /test|contract|fixture/.test(TEST_DB_NAME);
const ciService = process.env.CI === 'true' && parsed.hostname === 'postgres' && TEST_DB_NAME === 'relayhall_ci';
if (!['postgres:', 'postgresql:'].includes(parsed.protocol)
  || ['relayhall', 'relayhall_dev', 'relayhall_tst', 'relayhall_prod'].includes(TEST_DB_NAME)
  || (!localDisposable && !ciService)) {
  throw new Error('The change-request target suite refuses a non-disposable database target');
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
const { principalService } = require('../services/PrincipalService');
const { insertGroupRow } = require('./support/groupRows');
const mcpRoutes = require('../mcp/httpRoute').default;
const { MCP_ROUTE_PATH } = require('../mcp/httpRoute');

jest.setTimeout(240_000);

const REASON = 'Change-request drill: the run needs this change to finish its handover.';
const DAY = 24 * 60 * 60 * 1000;
const inDays = (days: number): string => new Date(Date.now() + days * DAY).toISOString();
const tag = (): string => crypto.randomBytes(5).toString('hex');
const parseJson = (value: unknown): any => (typeof value === 'string' ? JSON.parse(value) : value);

// ──────────────────────────────── the app ────────────────────────────────────

let server: http.Server;
let origin: string;

function buildApp(): any {
  const app = express();
  app.use(express.json(jsonBodyOptions));
  app.use(express.urlencoded({ extended: true }));
  // The MCP ingress first and outside the REST funnel, exactly as server.ts mounts it.
  app.use(MCP_ROUTE_PATH, mcpRoutes);
  registerProtectedRoutes((mountPath: string, ...handlers: any[]) => {
    app.use(mountPath, authMiddleware, sharedAuthorizationMiddleware, ...handlers);
  });
  app.use(apiErrorHandler);
  return app;
}

interface Caller { label: string; principalId: string; headers: Record<string, string> }
interface Bearer extends Caller { credentialId: string }
interface Answer { status: number; json: any }

async function call(who: Caller, method: string, routePath: string, body?: unknown, extra: Record<string, string> = {}): Promise<Answer> {
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

async function makeAccount(role: string, label: string): Promise<string> {
  const result = await pool.query(
    `INSERT INTO principals (kind, handle, display_name, status, role)
     VALUES ('human', $1, $1, 'active', $2) RETURNING id`, [`ucr-t2-${label}-${tag()}`, role]);
  return String(result.rows[0].id);
}

async function sessionFor(label: string, principalId: string): Promise<Caller> {
  const minted = await loginSessionService.mint({ principalId });
  return { label, principalId, headers: { Cookie: `${SESSION_COOKIE_NAME}=${minted.token}` } };
}

async function person(label: string, role: string): Promise<Caller> {
  return sessionFor(label, await makeAccount(role, label));
}

const CONNECTOR_SCOPES = ['tasks:read', 'tasks:write', 'projects:read', 'projects:write', 'phases:read', 'reports:read', 'principals:read'];

/** A Connector of `accountId` with its own bearer credential (own() = parent). */
async function connectorOf(accountId: string, scopes: string[] = CONNECTOR_SCOPES): Promise<Bearer> {
  const created = await pool.query(
    `INSERT INTO principals (kind, handle, display_name, status, parent_principal_id, purpose, own_expression)
     VALUES ('service', $1, $1, 'active', $2, 'change-request drill connector', $3::jsonb) RETURNING id`,
    [`ucr-t2-connector-${tag()}`, accountId, JSON.stringify({ scopes: 'parent', objects: 'parent' })]);
  const id = String(created.rows[0].id);
  const issued = await principalService.issueCredential({ principalId: id, scopes, label: `ucr-t2-${tag()}`, transport: 'any' });
  return { label: 'connector', principalId: id, credentialId: String(issued.credentialId), headers: { Authorization: `Bearer ${issued.fullKey}` } };
}

type Filed = { ok: true; record: any } | { ok: false; status: number; code: string; body: any };

async function file(who: Bearer, body: Record<string, unknown>): Promise<Filed> {
  const answered = await call(who, 'POST', '/delegation/access-requests', { kind: 'change', reason: REASON, ...body });
  if (answered.status === 202) return { ok: true, record: answered.json.approval };
  if (!answered.json?.code) throw new Error(`filing answered ${answered.status} without a code: ${JSON.stringify(answered.json)}`);
  return { ok: false, status: answered.status, code: String(answered.json.code), body: answered.json };
}

async function fileOk(who: Bearer, body: Record<string, unknown>): Promise<any> {
  const filed = await file(who, body);
  if (!filed.ok) throw new Error(`expected the filing to succeed, got ${filed.code}: ${JSON.stringify(filed.body)}`);
  return filed.record;
}

async function refusedCode(who: Bearer, body: Record<string, unknown>): Promise<[number, string]> {
  const filed = await file(who, body);
  return filed.ok ? [202, 'FILED'] : [filed.status, filed.code];
}

async function fileSession(who: Caller, body: Record<string, unknown>): Promise<Filed> {
  const answered = await call(who, 'POST', '/approvals/requests', { reason: REASON, ...body });
  if (answered.status === 202) return { ok: true, record: answered.json.approval };
  if (!answered.json?.code) throw new Error(`session filing answered ${answered.status} without a code: ${JSON.stringify(answered.json)}`);
  return { ok: false, status: answered.status, code: String(answered.json.code), body: answered.json };
}

async function decide(decider: Caller, approvalId: string, decision: 'approve' | 'deny', body: Record<string, unknown> = {}):
  Promise<Answer & { tokenId: string }> {
  const stepUp = await stepUpService.mint(decider.principalId, 'approval.decide', approvalId, 'password');
  const answered = await call(decider, 'POST', `/approvals/${approvalId}/${decision}`, { stepUpToken: stepUp.token, ...body });
  return { ...answered, tokenId: stepUp.tokenId };
}

async function approvalRow(id: string): Promise<any> {
  return (await pool.query('SELECT * FROM approvals WHERE id = $1', [id])).rows[0];
}

async function events(id: string, action: string): Promise<any[]> {
  return (await pool.query('SELECT * FROM approval_events WHERE approval_id = $1 AND action = $2 ORDER BY occurred_at, id', [id, action])).rows;
}

async function tokenConsumed(tokenId: string): Promise<boolean> {
  return (await pool.query('SELECT consumed_at FROM step_up_tokens WHERE id = $1', [tokenId])).rows[0]?.consumed_at != null;
}

async function auditRows(action: string, resourceId: string): Promise<any[]> {
  return (await pool.query(
    `SELECT * FROM audit_events WHERE action = $1 AND resource_id = $2 AND outcome = 'success' ORDER BY occurred_at, id`,
    [action, resourceId])).rows.map((row: any) => ({ ...row, metadata: parseJson(row.metadata) }));
}

async function roleOf(principalId: string): Promise<string | null> {
  return (await pool.query('SELECT role FROM principals WHERE id = $1', [principalId])).rows[0]?.role ?? null;
}

async function statusOf(principalId: string): Promise<string> {
  return String((await pool.query('SELECT status FROM principals WHERE id = $1', [principalId])).rows[0]?.status);
}

async function hubItem(who: Caller, id: string): Promise<any> {
  const answer = await call(who, 'GET', '/approvals?view=hub&status=all');
  expect(answer.status).toBe(200);
  return answer.json.approvals.find((item: any) => String(item.id) === id) ?? null;
}

async function approvalCount(): Promise<number> {
  return (await pool.query('SELECT COUNT(*)::int AS n FROM approvals')).rows[0].n;
}

async function mcpCall(who: Bearer, name: string, args: Record<string, unknown> = {}): Promise<Answer> {
  const response = await fetch(`${origin}${MCP_ROUTE_PATH}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', Authorization: who.headers.Authorization },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
  });
  const text = await response.text();
  let json: any = null;
  try { json = JSON.parse(text); } catch { json = null; }
  return { status: response.status, json };
}
const mcpText = (answer: Answer): string => String(answer.json?.result?.content?.[0]?.text ?? '');
const mcpFailed = (answer: Answer): boolean => Boolean(answer.json?.result?.isError) || Boolean(answer.json?.error);
const mcpJson = (answer: Answer): any => JSON.parse(mcpText(answer));

async function ownerProject(owner: Caller, name: string): Promise<string> {
  const created = await call(owner, 'POST', '/projects', { name });
  expect(created.status).toBe(201);
  return String(created.json.project.id);
}

const exactRule = (type: string, ids: string[], verbs: string[]) => ({ resourceType: type, selectorForm: 'exact', selectorIds: ids, verbs });

/** A warrant.create spec on `holder`, anchored to `project`, its ceiling read on that Project. */
const warrantSpec = (holder: string, project: string, extra: Record<string, unknown> = {}) => ({
  name: `ucr-t2-warrant-${tag()}`, holderPrincipalId: holder, anchors: [{ anchorType: 'project', anchorId: project }],
  ceilingRules: [exactRule('project', [project], ['read'])], expiresAt: inDays(10), ...extra,
});

// ─────────────────────────────── fixtures ────────────────────────────────────

let ROOT: Caller;        // role admin: root
let ROOT2: Caller;       // a second root person
let OPERATOR: Caller;    // a non-root administrator
let OPERATOR2: Caller;   // a second non-root administrator
let USER: Caller;        // an ordinary user who owns PU
let OTHER: Caller;       // an ordinary user
let PU: string;          // a Project of USER

beforeAll(async () => {
  await new Promise<void>((resolve) => { server = buildApp().listen(0, '127.0.0.1', resolve); });
  origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  ROOT = await person('root', 'admin');
  ROOT2 = await person('root2', 'admin');
  OPERATOR = await person('operator', 'operator');
  OPERATOR2 = await person('operator2', 'operator');
  USER = await person('user', 'user');
  OTHER = await person('other', 'user');
  PU = await ownerProject(USER, `UCR T2 PU ${tag()}`);
});

afterAll(async () => {
  if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  await pool.end();
});

// ═══════════════════════════ (I) identity targets ═══════════════════════════

describe('(I) identity targets (slice S4)', () => {
  it('I1: a viewer asks for its own role on the session door; an administrator decides with one step-up and the role bites on the next request', async () => {
    const viewer = await person('i1-viewer', 'viewer');
    const before = await call(viewer, 'POST', '/projects', { name: `UCR I1 before ${tag()}` });
    expect(before.status).toBe(403);
    const filed = await fileSession(viewer, { targetType: 'identity.role', targetId: viewer.principalId, change: { role: 'editor' } });
    expect(filed.ok).toBe(true);
    const id = String((filed as any).record.id);
    const row = await approvalRow(id);
    expect([row.kind, row.target_type, String(row.target_id), row.grantee_principal_id, parseJson(row.change_spec).before.role,
      parseJson(row.change_spec).requested]).toEqual(['change', 'identity.role', viewer.principalId, null, 'viewer', { role: 'editor' }]);
    expect(await roleOf(viewer.principalId)).toBe('viewer');
    // The right human: an administrator sees it and may decide; the requester may not (section 5.5 (a) and (c)).
    expect(await hubItem(OPERATOR, id)).toMatchObject({ decidable: true });
    const self = await decide(viewer, id, 'approve');
    expect([self.status, self.json?.code, self.json?.cases, await tokenConsumed(self.tokenId)]).toEqual([403, 'SELF_DECISION_REFUSED', ['a', 'c'], false]);
    const approved = await decide(OPERATOR, id, 'approve');
    expect([approved.status, approved.json?.approval?.status]).toEqual([200, 'approved']);
    expect(await tokenConsumed(approved.tokenId)).toBe(true);
    const decided = await approvalRow(id);
    expect([decided.decider_standing, decided.applied_at !== null, parseJson(decided.applied_effect)])
      .toEqual(['administrator', true, { principalId: viewer.principalId, previousRole: 'viewer', role: 'editor' }]);
    expect(await roleOf(viewer.principalId)).toBe('editor');
    // The seam's own ledger row, with the decision beside it.
    const ledger = (await auditRows('principal.role.changed', viewer.principalId)).pop();
    expect(ledger.metadata).toMatchObject({ before: 'viewer', after: 'editor', issuerRole: 'operator', seam: 'change request identity.role',
      approvalId: id, kind: 'change', targetType: 'identity.role', deciderStanding: 'administrator' });
    expect(ledger.metadata.stepUp).toMatchObject({ tokenId: approved.tokenId });
    // The cache was published after COMMIT: the very next request carries the new role.
    const after = await call(viewer, 'POST', '/projects', { name: `UCR I1 after ${tag()}` });
    expect(after.status).toBe(201);
    const diff = parseJson(decided.change_spec).diff;
    expect(diff.fields).toEqual([{ field: 'role', before: 'viewer', after: 'editor' }]);
    expect(diff.relationships.map((e: any) => [e.action, e.state])).toEqual([['viewer', 'removed'], ['editor', 'added']]);
  });

  it("I2: an ordinary user asks for its own Account's role only, within ceiling class 2; every refusal is named and files nothing", async () => {
    const user = await person('i2-user', 'user');
    const conn = await connectorOf(user.principalId);
    const count = await approvalCount();
    const cases: Array<[Record<string, unknown>, number, string]> = [
      [{ targetType: 'identity.role', targetId: OTHER.principalId, change: { role: 'editor' } }, 404, 'TARGET_NOT_FOUND'],
      [{ targetType: 'identity.role', targetId: crypto.randomUUID(), change: { role: 'editor' } }, 404, 'TARGET_NOT_FOUND'],
      [{ targetType: 'identity.role', targetId: conn.principalId, change: { role: 'editor' } }, 422, 'GRANTEE_NOT_ADMISSIBLE'],
      [{ targetType: 'identity.role', targetId: user.principalId, change: { role: 'admin' } }, 422, 'EXCEEDS_ROLE_CEILING'],
      [{ targetType: 'identity.role', targetId: user.principalId, change: { role: 'operator' } }, 422, 'EXCEEDS_ROLE_CEILING'],
      [{ targetType: 'identity.role', targetId: user.principalId, change: { role: 'user' } }, 409, 'ALREADY_HELD'],
      [{ targetType: 'identity.role', targetId: user.principalId, change: { role: 'emperor' } }, 400, 'UNKNOWN_ROLE'],
      [{ targetType: 'identity.role', targetId: user.principalId, change: { role: 'editor', status: 'active' } }, 422, 'INVALID_ACCESS_REQUEST'],
      [{ targetType: 'identity.role', targetId: user.principalId, granteePrincipalId: user.principalId, change: { role: 'editor' } }, 422, 'GRANTEE_NOT_ADMISSIBLE'],
      [{ targetType: 'identity.create', change: { kind: 'human', handle: `ucr-t2-i2-${tag()}` } }, 403, 'REQUEST_STANDING_NONE'],
      [{ targetType: 'identity.status', targetId: OTHER.principalId, change: { status: 'disabled' } }, 403, 'REQUEST_STANDING_NONE'],
    ];
    const answers: Array<[number, string]> = [];
    for (const [body] of cases) answers.push(await refusedCode(conn, body));
    expect(answers).toEqual(cases.map(([, status, code]) => [status, code]));
    expect(await approvalCount()).toBe(count);
    // Each refusal is a durable denied approval.request row with its code.
    const denied = (await pool.query(
      `SELECT metadata->>'refusal' AS code FROM audit_events WHERE action = 'approval.request' AND outcome = 'denied'
          AND resource_id = $1 ORDER BY occurred_at, id`, [conn.principalId])).rows.map((r: any) => r.code);
    expect(denied).toEqual(cases.map(([, , code]) => code));
    // Its own role, within class 2, files.
    const own = await fileOk(conn, { targetType: 'identity.role', targetId: user.principalId, change: { role: 'editor' } });
    expect((await approvalRow(own.id)).status).toBe('pending');
  });

  it('I3: an elevated role is decided only by an admin issuer: an operator is refused DECIDER_CEILING_EXCEEDED without spending its step-up; root applies it', async () => {
    const target = await person('i3-target', 'user');
    const rc = await connectorOf(ROOT.principalId);
    const record = await fileOk(rc, { targetType: 'identity.role', targetId: target.principalId, change: { role: 'admin' } });
    const operator = await decide(OPERATOR, record.id, 'approve');
    expect([operator.status, operator.json?.code]).toEqual([403, 'DECIDER_CEILING_EXCEEDED']);
    expect([await tokenConsumed(operator.tokenId), (await approvalRow(record.id)).status, await roleOf(target.principalId)])
      .toEqual([false, 'pending', 'user']);
    const root = await decide(ROOT2, record.id, 'approve');
    expect([root.status, (await approvalRow(record.id)).decider_standing, await roleOf(target.principalId)]).toEqual([200, 'root', 'admin']);
    // An elevated role on a Connector is refused at filing, by the act's own rule.
    const conn = await connectorOf(target.principalId);
    expect(await refusedCode(rc, { targetType: 'identity.role', targetId: conn.principalId, change: { role: 'operator' } }))
      .toEqual([422, 'ELEVATED_ROLE_REQUIRES_ACCOUNT']);
  });

  it('I4: the decider narrows a role to a lower one, never a higher or a sideways one', async () => {
    const target = await person('i4-target', 'viewer');
    const rc = await connectorOf(ROOT.principalId);
    const record = await fileOk(rc, { targetType: 'identity.role', targetId: target.principalId, change: { role: 'operator' } });
    const wider = await decide(ROOT2, record.id, 'approve', { editedChange: { role: 'admin' } });
    expect([wider.status, wider.json?.code, await tokenConsumed(wider.tokenId)]).toEqual([422, 'EDIT_ONLY_NARROWS', false]);
    const nothing = await decide(ROOT2, record.id, 'approve', { editedChange: { role: 'viewer' } });
    expect([nothing.status, nothing.json?.code]).toEqual([422, 'APPROVAL_WRITES_NOTHING']);
    const lower = await decide(ROOT2, record.id, 'approve', { editedChange: { role: 'editor' } });
    expect([lower.status, await roleOf(target.principalId), parseJson((await approvalRow(record.id)).change_spec).approved])
      .toEqual([200, 'editor', { role: 'editor' }]);
    // Sideways within one class is not lower.
    const other = await person('i4-other', 'viewer');
    const second = await fileOk(rc, { targetType: 'identity.role', targetId: other.principalId, change: { role: 'editor' } });
    const sideways = await decide(ROOT2, second.id, 'approve', { editedChange: { role: 'reviewer' } });
    expect([sideways.status, sideways.json?.code]).toEqual([422, 'EDIT_ONLY_NARROWS']);
  });

  it("I5: the target principal's own Account never decides its role (section 5.5 (c)), root not exempt; another root does", async () => {
    const oc = await connectorOf(OPERATOR.principalId);
    const record = await fileOk(oc, { targetType: 'identity.role', targetId: ROOT2.principalId, change: { role: 'orchestrator' } });
    const self = await decide(ROOT2, record.id, 'approve');
    expect([self.status, self.json?.code, self.json?.cases, await tokenConsumed(self.tokenId)]).toEqual([403, 'SELF_DECISION_REFUSED', ['c'], false]);
    expect(await hubItem(ROOT2, record.id)).toMatchObject({ decidable: false });
    const other = await decide(ROOT, record.id, 'deny', { denialReason: 'not needed' });
    expect([other.status, (await approvalRow(record.id)).status, await roleOf(ROOT2.principalId)]).toEqual([200, 'denied', 'admin']);
  });

  it('I6: a role changed after filing lapses the request TARGET_CHANGED and applies nothing', async () => {
    const target = await person('i6-target', 'viewer');
    const rc = await connectorOf(ROOT.principalId);
    const record = await fileOk(rc, { targetType: 'identity.role', targetId: target.principalId, change: { role: 'editor' } });
    const direct = await call(OPERATOR, 'POST', `/principals/${target.principalId}/role`, { role: 'user' });
    expect(direct.status).toBe(200);
    const stale = await decide(ROOT2, record.id, 'approve');
    expect([stale.status, stale.json?.code, (await approvalRow(record.id)).status, (await approvalRow(record.id)).lapse_reason, await roleOf(target.principalId)])
      .toEqual([409, 'EDIT_STALE', 'lapsed', 'TARGET_CHANGED', 'user']);
  });

  it('I7: identity.create is filed by an administrator and created by a root session only, with the decision on principal.create', async () => {
    const oc = await connectorOf(OPERATOR.principalId);
    const handle = `ucr-t2-new-${tag()}`;
    const refusals: Array<[Record<string, unknown>, number, string]> = [
      [{ kind: 'agent', handle }, 422, 'AGENT_MINT_ONLY'],
      [{ kind: 'service', handle }, 422, 'PURPOSE_REQUIRED'],
      [{ kind: 'human', handle: 'Not A Handle' }, 422, 'INVALID_HANDLE'],
      [{ kind: 'human', handle: await pool.query('SELECT handle FROM principals WHERE id = $1', [OTHER.principalId]).then((r: any) => r.rows[0].handle) }, 409, 'ALREADY_HELD'],
      [{ kind: 'service', handle, purpose: 'drill', role: 'admin' }, 422, 'ELEVATED_ROLE_REQUIRES_ACCOUNT'],
    ];
    for (const [change, status, code] of refusals) {
      expect([change, await refusedCode(oc, { targetType: 'identity.create', change })]).toEqual([change, [status, code]]);
    }
    const record = await fileOk(oc, { targetType: 'identity.create', change: { kind: 'human', handle, displayName: 'Drill person', role: 'editor' } });
    expect([(await approvalRow(record.id)).target_id]).toEqual([`handle:${handle}`]);
    const operator = await decide(OPERATOR2, record.id, 'approve');
    expect([operator.status, operator.json?.code, await tokenConsumed(operator.tokenId)])
      .toEqual([403, 'APPROVAL_DECIDE_REQUIRES_ADMINISTRATOR', false]);
    const root = await decide(ROOT, record.id, 'approve');
    expect(root.status).toBe(200);
    const created = (await pool.query('SELECT id, kind, role, display_name, parent_principal_id FROM principals WHERE handle = $1', [handle])).rows[0];
    expect([created.kind, created.role, created.display_name, created.parent_principal_id]).toEqual(['human', 'editor', 'Drill person', null]);
    const ledger = (await auditRows('principal.create', String(created.id))).pop();
    expect(ledger.metadata).toMatchObject({ kind: 'human', handle, role: 'editor', approvalId: record.id, requestKind: 'change',
      targetType: 'identity.create', deciderStanding: 'root' });
    expect(parseJson((await approvalRow(record.id)).applied_effect)).toEqual({ principalId: String(created.id), handle });
    // A second request for the same handle files nothing: the handle is taken now.
    expect(await refusedCode(oc, { targetType: 'identity.create', change: { kind: 'human', handle } })).toEqual([409, 'ALREADY_HELD']);
  });

  it('I8: identity.status on the direct door: a disable revokes the stored login sessions in the same act, and an enable leaves them revoked', async () => {
    const target = await person('i8-target', 'user');
    expect((await call(target, 'GET', '/principals/me')).status).toBe(200);
    const disabled = await call(ROOT, 'PATCH', `/principals/${target.principalId}`, { status: 'disabled' });
    expect(disabled.status).toBe(200);
    const sessions = (await pool.query('SELECT revoked_at, revoke_reason FROM auth_sessions WHERE principal_id = $1', [target.principalId])).rows;
    expect(sessions.map((s: any) => [s.revoked_at !== null, s.revoke_reason])).toEqual([[true, 'disabled_user']]);
    const ledger = (await auditRows('principal.update', target.principalId)).pop();
    expect(ledger.metadata).toMatchObject({ changedFields: ['status'], previousStatus: 'active', status: 'disabled', sessionsRevoked: 1 });
    // Enabled again, the revoked session stays revoked: the disable was not shallow.
    expect((await call(ROOT, 'PATCH', `/principals/${target.principalId}`, { status: 'active' })).status).toBe(200);
    expect((await call(target, 'GET', '/principals/me')).status).toBe(401);
    const enabled = (await auditRows('principal.update', target.principalId)).pop();
    expect(enabled.metadata).toEqual({ changedFields: ['status'], previousStatus: 'disabled', status: 'active' });
  });

  it('I11: identity.status on the direct door: a disable lapses the PENDING requests naming the Account as grantee, and nothing else', async () => {
    const target = await person('i11-target', 'user');
    const rc = await connectorOf(ROOT.principalId);
    const pending = await fileOk(rc, { targetType: 'grant.rows', granteePrincipalId: target.principalId,
      change: { rules: [exactRule('project', [PU], ['read'])] } });
    const decidedFirst = await fileOk(rc, { targetType: 'identity.role', targetId: target.principalId, change: { role: 'editor' } });
    expect((await decide(ROOT2, decidedFirst.id, 'approve')).status).toBe(200);
    const group = await insertGroupRow(pool, { name: `ucr-t2-i11-${tag()}` });
    const forGroup = await fileOk(rc, { targetType: 'grant.rows', granteeType: 'group', granteePrincipalId: group,
      change: { rules: [exactRule('project', [PU], ['read'])] } });
    expect((await call(ROOT, 'PATCH', `/principals/${target.principalId}`, { status: 'disabled' })).status).toBe(200);
    const lapsed = await approvalRow(pending.id);
    expect([lapsed.status, lapsed.lapse_reason]).toEqual(['lapsed', 'GRANTEE_DISABLED']);
    expect((await events(pending.id, 'approval.lapsed')).map((e: any) => parseJson(e.metadata).reason)).toEqual(['GRANTEE_DISABLED']);
    expect([(await approvalRow(decidedFirst.id)).status, (await approvalRow(forGroup.id)).status]).toEqual(['approved', 'pending']);
    const ledger = (await auditRows('principal.update', target.principalId)).pop();
    expect(ledger.metadata).toMatchObject({ status: 'disabled', lapsedApprovalIds: [pending.id] });
  });

  it('I9: identity.status on the request door: an administrator files, a root session alone decides, and the same seam cascades', async () => {
    const target = await person('i9-target', 'user');
    const rc = await connectorOf(ROOT.principalId);
    const oc = await connectorOf(OPERATOR.principalId);
    const pending = await fileOk(rc, { targetType: 'grant.rows', granteePrincipalId: target.principalId,
      change: { rules: [exactRule('project', [PU], ['read'])] } });
    expect(await refusedCode(oc, { targetType: 'identity.status', targetId: target.principalId, change: { status: 'active' } })).toEqual([409, 'ALREADY_HELD']);
    expect(await refusedCode(oc, { targetType: 'identity.status', targetId: target.principalId, change: { status: 'gone' } })).toEqual([422, 'STATUS_REQUIRED']);
    const group = await insertGroupRow(pool, { name: `ucr-t2-group-${tag()}` });
    expect(await refusedCode(oc, { targetType: 'identity.status', targetId: group, change: { status: 'disabled' } }))
      .toEqual([422, 'GROUP_PRINCIPAL_MANAGED_BY_GROUPS']);
    const record = await fileOk(oc, { targetType: 'identity.status', targetId: target.principalId, change: { status: 'disabled' } });
    const operator = await decide(OPERATOR2, record.id, 'approve');
    expect([operator.status, operator.json?.code, await statusOf(target.principalId)]).toEqual([403, 'APPROVAL_DECIDE_REQUIRES_ADMINISTRATOR', 'active']);
    const root = await decide(ROOT, record.id, 'approve');
    expect([root.status, await statusOf(target.principalId)]).toEqual([200, 'disabled']);
    expect((await pool.query('SELECT revoke_reason FROM auth_sessions WHERE principal_id = $1', [target.principalId])).rows.map((r: any) => r.revoke_reason))
      .toEqual(['disabled_user']);
    expect([(await approvalRow(pending.id)).lapse_reason]).toEqual(['GRANTEE_DISABLED']);
    const ledger = (await auditRows('principal.update', target.principalId)).pop();
    expect(ledger.metadata).toMatchObject({ status: 'disabled', sessionsRevoked: 1, lapsedApprovalIds: [pending.id], approvalId: record.id,
      kind: 'change', targetType: 'identity.status', deciderStanding: 'root' });
    expect(await call(target, 'GET', '/principals/me').then((a) => a.status)).toBe(401);
    // An enable by request writes the status and nothing else.
    const enable = await fileOk(oc, { targetType: 'identity.status', targetId: target.principalId, change: { status: 'active' } });
    expect((await decide(ROOT2, enable.id, 'approve')).status).toBe(200);
    expect(await statusOf(target.principalId)).toBe('active');
    expect((await auditRows('principal.update', target.principalId)).pop().metadata).not.toHaveProperty('sessionsRevoked');
  });

  it("I10: credential.revoke: an administrator revokes another principal's credential by request; the holder's Account never decides it", async () => {
    const victim = await connectorOf(OTHER.principalId);
    expect((await call(victim, 'GET', '/principals/me')).status).toBe(200);
    const oc = await connectorOf(OPERATOR.principalId);
    expect(await refusedCode(oc, { targetType: 'credential.revoke', targetId: oc.credentialId, change: {} })).toEqual([422, 'KIND_NOT_FILABLE_HERE']);
    const userConn = await connectorOf(USER.principalId);
    const unreadable = await refusedCode(userConn, { targetType: 'credential.revoke', targetId: victim.credentialId, change: {} });
    const absent = await refusedCode(userConn, { targetType: 'credential.revoke', targetId: crypto.randomUUID(), change: {} });
    expect([unreadable, absent]).toEqual([[404, 'TARGET_NOT_FOUND'], [404, 'TARGET_NOT_FOUND']]);
    const record = await fileOk(oc, { targetType: 'credential.revoke', targetId: victim.credentialId, change: {} });
    const approved = await decide(OPERATOR2, record.id, 'approve');
    expect([approved.status, (await approvalRow(record.id)).decider_standing]).toEqual([200, 'administrator']);
    expect((await call(victim, 'GET', '/principals/me')).status).toBe(401);
    const ledger = (await auditRows('credential.revoke', victim.credentialId)).pop();
    expect(ledger.metadata).toMatchObject({ reason: `change request ${record.id}`, approvalId: record.id, targetType: 'credential.revoke' });
    // Case (c): a credential under ROOT2's Account is never decided by ROOT2.
    const rootCred = await connectorOf(ROOT2.principalId);
    const rc = await connectorOf(ROOT.principalId);
    const mine = await fileOk(rc, { targetType: 'credential.revoke', targetId: rootCred.credentialId, change: {} });
    const self = await decide(ROOT2, mine.id, 'approve');
    expect([self.status, self.json?.code, self.json?.cases, await tokenConsumed(self.tokenId)]).toEqual([403, 'SELF_DECISION_REFUSED', ['c'], false]);
    expect(await refusedCode(rc, { targetType: 'credential.revoke', targetId: victim.credentialId, change: {} })).toEqual([409, 'ALREADY_HELD']);
  });
});

// ═══════════════════════════════ (W) warrants ════════════════════════════════

describe('(W) warrant targets (slice S4)', () => {
  let WRITER: Bearer;       // a Connector of USER, over MCP
  let HOLDER: Bearer;       // a Connector of USER that holds warrants
  beforeAll(async () => {
    WRITER = await connectorOf(USER.principalId);
    HOLDER = await connectorOf(USER.principalId);
    const brief = await mcpCall(WRITER, 'relayhall_brief_compile', { session: true });
    expect(mcpFailed(brief)).toBe(false);
  });

  /** One warrant on HOLDER, created through an approved request. */
  async function decidedWarrant(extra: Record<string, unknown> = {}): Promise<string> {
    const rc = await connectorOf(ROOT.principalId);
    const record = await fileOk(rc, { targetType: 'warrant.create', targetId: HOLDER.principalId, change: warrantSpec(HOLDER.principalId, PU, extra) });
    expect((await decide(ROOT2, record.id, 'approve')).status).toBe(200);
    return String(parseJson((await approvalRow(record.id)).applied_effect).warrantId);
  }

  it('W1: warrant.create filed over MCP writes no warrant (R9:187: MCP files, never mutates /warrants); the decider creates it with the decision step-up', async () => {
    const warrants = async () => (await pool.query('SELECT COUNT(*)::int AS n FROM warrants WHERE holder_principal_id = $1', [HOLDER.principalId])).rows[0].n;
    const before = await warrants();
    const filed = await mcpCall(WRITER, 'relayhall_access_request', {
      action: 'file', kind: 'change', targetType: 'warrant.create', targetId: HOLDER.principalId, reason: REASON,
      change: warrantSpec(HOLDER.principalId, PU),
    });
    expect(mcpFailed(filed)).toBe(false);
    const id = String(mcpJson(filed).approval.id);
    expect([(await approvalRow(id)).status, await warrants()]).toEqual(['pending', before]);
    // The bearer's own door onto /warrants is refused: deciding and applying stay a person's acts.
    const direct = await call(WRITER, 'POST', '/warrants', { ...warrantSpec(HOLDER.principalId, PU) });
    expect([direct.status, direct.json?.code, await warrants()]).toEqual([403, 'SESSION_ONLY', before]);
    // The holder's own Account is the requester's Account here: it never decides (it is not an administrator either).
    const user = await decide(USER, id, 'approve');
    expect([user.status, user.json?.code, user.json?.cases, await warrants()]).toEqual([403, 'SELF_DECISION_REFUSED', ['a', 'd'], before]);
    const approved = await decide(ROOT, id, 'approve');
    expect(approved.status).toBe(200);
    const warrantId = String(parseJson((await approvalRow(id)).applied_effect).warrantId);
    const warrant = (await pool.query('SELECT * FROM warrants WHERE id = $1', [warrantId])).rows[0];
    expect([String(warrant.holder_principal_id), String(warrant.created_by_principal_id), warrant.status]).toEqual([HOLDER.principalId, ROOT.principalId, 'active']);
    const event = (await pool.query(`SELECT metadata FROM warrant_events WHERE warrant_id = $1 AND action = 'warrant.created'`, [warrantId])).rows[0];
    expect(parseJson(event.metadata).stepUp).toMatchObject({ tokenId: approved.tokenId });
    expect((await auditRows('warrant.create', warrantId)).pop().metadata).toMatchObject({ approvalId: id, targetType: 'warrant.create', deciderStanding: 'root' });
  });

  it("W2: a warrant on a holder under the decider's Account is never decided by it (section 5.5 (d)); a holder outside the filer's subtree is answered as absent", async () => {
    const rootHolder = await connectorOf(ROOT.principalId);
    const oc = await connectorOf(OPERATOR.principalId);
    const record = await fileOk(oc, { targetType: 'warrant.create', targetId: rootHolder.principalId, change: warrantSpec(rootHolder.principalId, PU) });
    const self = await decide(ROOT, record.id, 'approve');
    expect([self.status, self.json?.code, self.json?.cases, await tokenConsumed(self.tokenId)]).toEqual([403, 'SELF_DECISION_REFUSED', ['d'], false]);
    expect((await decide(ROOT2, record.id, 'approve')).status).toBe(200);
    const otherConn = await connectorOf(OTHER.principalId);
    const outside = await refusedCode(WRITER, { targetType: 'warrant.create', targetId: otherConn.principalId, change: warrantSpec(otherConn.principalId, PU) });
    const absent = await refusedCode(WRITER, { targetType: 'warrant.create', targetId: crypto.randomUUID(), change: {} });
    expect([outside, absent]).toEqual([[404, 'TARGET_NOT_FOUND'], [404, 'TARGET_NOT_FOUND']]);
    const hidden = await ownerProject(OTHER, `UCR W2 hidden ${tag()}`);
    await pool.query(`UPDATE projects SET visibility = 'private' WHERE id = $1`, [hidden]);
    expect(await refusedCode(WRITER, { targetType: 'warrant.create', targetId: HOLDER.principalId, change: warrantSpec(HOLDER.principalId, hidden) }))
      .toEqual([422, 'ANCHOR_NOT_FOUND']);
  });

  it('W6: a warrant pin is never loosened through a request, and a warrant edit names only the editable fields', async () => {
    const warrantId = await decidedWarrant({ transportPin: 'mcp' });
    expect(await refusedCode(WRITER, { targetType: 'warrant.edit', targetId: warrantId, change: { transportPin: 'any' } }))
      .toEqual([422, 'TRANSPORT_NOT_REQUESTABLE']);
    expect(await refusedCode(WRITER, { targetType: 'warrant.edit', targetId: warrantId, change: { transportPin: 'api' } }))
      .toEqual([422, 'TRANSPORT_NOT_REQUESTABLE']);
    expect(await refusedCode(WRITER, { targetType: 'warrant.edit', targetId: warrantId, change: { status: 'active' } }))
      .toEqual([422, 'INVALID_ACCESS_REQUEST']);
    expect((await pool.query('SELECT transport_pin FROM warrants WHERE id = $1', [warrantId])).rows[0].transport_pin).toBe('mcp');
  });

  it('W3: warrant.edit is narrowed (a lower cap, never a higher one) and applied in place', async () => {
    const warrantId = await decidedWarrant({ transportPin: 'mcp', maxTotal: 20 });
    const record = await fileOk(WRITER, { targetType: 'warrant.edit', targetId: warrantId, change: { maxTotal: 50, maxConcurrent: 4 } });
    const wider = await decide(ROOT, record.id, 'approve', { editedChange: { maxTotal: 60 } });
    expect([wider.status, wider.json?.code]).toEqual([422, 'EDIT_ONLY_NARROWS']);
    const narrowed = await decide(ROOT, record.id, 'approve', { editedChange: { maxTotal: 30 } });
    expect(narrowed.status).toBe(200);
    const warrant = (await pool.query('SELECT max_total, max_concurrent, transport_pin, status FROM warrants WHERE id = $1', [warrantId])).rows[0];
    expect([warrant.max_total, warrant.max_concurrent, warrant.transport_pin, warrant.status]).toEqual([30, 4, 'mcp', 'active']);
    const audit = (await pool.query(`SELECT metadata FROM audit_events WHERE action = 'warrant.edit' AND resource_id = $1 AND outcome = 'success'`, [warrantId])).rows;
    expect(audit.map((r: any) => parseJson(r.metadata).approvalId)).toContain(record.id);
  });

  it('W4: warrant.revoke and warrant.resume are applied by WarrantService in the decide transaction', async () => {
    const revokeId = await decidedWarrant();
    const revoke = await fileOk(WRITER, { targetType: 'warrant.revoke', targetId: revokeId, change: {} });
    expect((await decide(ROOT, revoke.id, 'approve')).status).toBe(200);
    expect((await pool.query('SELECT status FROM warrants WHERE id = $1', [revokeId])).rows[0].status).toBe('revoked');
    expect((await auditRows('warrant.revoke', revokeId)).pop().metadata).toMatchObject({ reason: `change request ${revoke.id}`, approvalId: revoke.id });
    expect(await refusedCode(WRITER, { targetType: 'warrant.revoke', targetId: revokeId, change: {} })).toEqual([409, 'ALREADY_HELD']);
    const resumeId = await decidedWarrant();
    expect(await refusedCode(WRITER, { targetType: 'warrant.resume', targetId: resumeId, change: {} })).toEqual([409, 'WARRANT_NOT_SUSPENDED']);
    await pool.query(`UPDATE warrants SET status = 'suspended', suspended_reason = 'drill', suspended_at = NOW() WHERE id = $1`, [resumeId]);
    const resume = await fileOk(WRITER, { targetType: 'warrant.resume', targetId: resumeId, change: {} });
    expect((await decide(OPERATOR, resume.id, 'approve')).status).toBe(200);
    expect((await pool.query('SELECT status FROM warrants WHERE id = $1', [resumeId])).rows[0].status).toBe('active');
    expect((await auditRows('warrant.resume', resumeId)).pop().metadata).toMatchObject({ approvalId: resume.id, deciderStanding: 'administrator' });
  });

  it('W5: a warrant whose status changed after filing lapses the request TARGET_CHANGED', async () => {
    const warrantId = await decidedWarrant();
    const record = await fileOk(WRITER, { targetType: 'warrant.revoke', targetId: warrantId, change: {} });
    await pool.query(`UPDATE warrants SET status = 'suspended', suspended_reason = 'drill', suspended_at = NOW() WHERE id = $1`, [warrantId]);
    const stale = await decide(ROOT, record.id, 'approve');
    expect([stale.status, stale.json?.code, (await approvalRow(record.id)).lapse_reason]).toEqual([409, 'EDIT_STALE', 'TARGET_CHANGED']);
    expect((await pool.query('SELECT status FROM warrants WHERE id = $1', [warrantId])).rows[0].status).toBe('suspended');
  });
});

// ═══════════════════════════════ (P) preview ═════════════════════════════════

describe('(P) the preview answers the identity targets (slice S4)', () => {
  it('P1: the preview names the identity targets, who may decide them, and writes nothing', async () => {
    const count = await approvalCount();
    const preview = async (who: Caller, query: string) => {
      const answer = await call(who, 'GET', `/approvals/requests/preview?${query}`);
      expect(answer.status).toBe(200);
      return answer.json.preview ?? answer.json;
    };
    const own = await preview(USER, `targetType=identity.role&targetId=${USER.principalId}`);
    expect(own.requestable.map((e: any) => [e.targetType, e.fields, e.deciders.map((d: any) => d.standing)]))
      .toEqual([['identity.role', ['role'], ['root', 'administrator']]]);
    const create = await preview(USER, 'targetType=identity.create');
    expect(create.refused.map((e: any) => [e.targetType, e.code])).toEqual([['identity.create', 'REQUEST_STANDING_NONE']]);
    const rootOnly = await preview(OPERATOR, 'targetType=identity.create');
    expect(rootOnly.requestable.map((e: any) => [e.targetType, e.deciders.map((d: any) => d.standing)])).toEqual([['identity.create', ['root']]]);
    const status = await preview(OPERATOR, `targetType=identity.status&targetId=${OTHER.principalId}`);
    expect(status.requestable.map((e: any) => [e.targetType, e.deciders.map((d: any) => d.standing)])).toEqual([['identity.status', ['root']]]);
    expect(await approvalCount()).toBe(count);
  });
});
