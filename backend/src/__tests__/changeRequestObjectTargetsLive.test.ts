/**
 * Card 9ce0b0b0, train T2 slice S5 — the OBJECT targets of the universal
 * change request (kind `change`; design ratified by owner ruling E325,
 * sections 3, 4.1-4.3, 5.1-5.5, 6, 7.1 and 11 T2 S5), over a REAL PostgreSQL
 * and the PRODUCTION router.
 *
 * It measures, on stored rows (the "object" section of the T2 change-request
 * suites; the identity section is changeRequestTargetsLive.test.ts):
 *
 *   (O) ownership: project.owner through the transfer act its direct PUT runs
 *       (a person owner decides a move to another person on its stored
 *       session; into a Group only root or an administrator, the Group
 *       transfer taking the decision's ONE step-up as its evidence);
 *       task.account_owner (root or an administrator files and decides);
 *       report.account_owner through the new executor; forged evidence is
 *       refused by both seams that accept it (section 5.3).
 *   (V) the default Verifier through the lifted seam (the first use: a
 *       default Verifier changed by request), E311's 403 on BOTH direct
 *       routes, task.roles with its holders re-checked at decide.
 *   (G) charter.revision approved from the hub with one sign-in (a person
 *       owner; a Group owner through LENSES-c gate (i) with the decision's
 *       step-up); phase.goal.
 *   (A) task.access and phase.access with their first audit_events row;
 *       report.visibility's opening transition only.
 *   (R) authority never widens: the decider's own reach on the object at the
 *       action its direct door asks, checked per target; the decider's own
 *       session facts, or nothing is applied; the principal a change puts on
 *       the object never decides it (section 5.5 (d)); a stale preview never
 *       applies (the object's state and its owner re-read at decide).
 *   (P) the preview answers the object targets and writes nothing.
 *
 * DESTRUCTIVE: writes principals, credentials, login sessions, projects,
 * phases, tasks, reports, Groups, charters, approvals, step-up tokens and
 * audit rows. It refuses any deployment database and any non-local host, and
 * FAILS — never skips — without a disposable one.
 */

/* eslint-disable @typescript-eslint/no-var-requires */

import http from 'http';
import crypto from 'crypto';

const TEST_DB_URL = process.env.RELAYHALL_TEST_DB_URL;
if (!TEST_DB_URL) {
  throw new Error('RELAYHALL_TEST_DB_URL is required: change-request object targets are measured on stored project, task, report, '
    + 'approval and audit rows, so this suite never skips. Load database/init.sql into a disposable database, '
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
  throw new Error('The change-request object-target suite refuses a non-disposable database target');
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
const { approvalService } = require('../services/ApprovalService');
const { groupOwnershipStandingTest } = require('../services/GroupOwnershipTransfer');
const { charterService } = require('../services/CharterService');
const { scopesForRole } = require('../utils/identityScopes');
const { insertGroupRow } = require('./support/groupRows');

jest.setTimeout(240_000);

const REASON = 'Change-request drill: the run needs this change to finish its handover.';
const tag = (): string => crypto.randomBytes(5).toString('hex');
const parseJson = (value: unknown): any => (typeof value === 'string' ? JSON.parse(value) : value);

// ──────────────────────────────── the app ────────────────────────────────────

let server: http.Server;
let origin: string;

function buildApp(): any {
  const app = express();
  app.use(express.json(jsonBodyOptions));
  app.use(express.urlencoded({ extended: true }));
  registerProtectedRoutes((mountPath: string, ...handlers: any[]) => {
    app.use(mountPath, authMiddleware, sharedAuthorizationMiddleware, ...handlers);
  });
  app.use(apiErrorHandler);
  return app;
}

interface Caller { label: string; principalId: string; role: string; headers: Record<string, string> }
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
     VALUES ('human', $1, $1, 'active', $2) RETURNING id`, [`ucr-t2o-${label}-${tag()}`, role]);
  return String(result.rows[0].id);
}

async function person(label: string, role: string): Promise<Caller> {
  const principalId = await makeAccount(role, label);
  const minted = await loginSessionService.mint({ principalId });
  return { label, principalId, role, headers: { Cookie: `${SESSION_COOKIE_NAME}=${minted.token}` } };
}

const CONNECTOR_SCOPES = ['tasks:read', 'tasks:write', 'projects:read', 'projects:write', 'phases:read', 'phases:write',
  'reports:read', 'reports:write', 'principals:read'];

/** A Connector of `accountId` with its own bearer credential (own() = parent). */
async function connectorOf(account: Caller): Promise<Bearer> {
  const created = await pool.query(
    `INSERT INTO principals (kind, handle, display_name, status, parent_principal_id, purpose, own_expression)
     VALUES ('service', $1, $1, 'active', $2, 'change-request drill connector', $3::jsonb) RETURNING id`,
    [`ucr-t2o-connector-${tag()}`, account.principalId, JSON.stringify({ scopes: 'parent', objects: 'parent' })]);
  const id = String(created.rows[0].id);
  const issued = await principalService.issueCredential({ principalId: id, scopes: CONNECTOR_SCOPES, label: `ucr-t2o-${tag()}`, transport: 'any' });
  return { label: 'connector', principalId: id, role: 'service', credentialId: String(issued.credentialId), headers: { Authorization: `Bearer ${issued.fullKey}` } };
}

type Filed = { ok: true; id: string; record: any } | { ok: false; status: number; code: string; body: any };

async function fileBearer(who: Bearer, body: Record<string, unknown>): Promise<Filed> {
  const answered = await call(who, 'POST', '/delegation/access-requests', { kind: 'change', reason: REASON, ...body });
  if (answered.status === 202) return { ok: true, id: String(answered.json.approval.id), record: answered.json.approval };
  if (!answered.json?.code) throw new Error(`filing answered ${answered.status} without a code: ${JSON.stringify(answered.json)}`);
  return { ok: false, status: answered.status, code: String(answered.json.code), body: answered.json };
}

async function fileSession(who: Caller, body: Record<string, unknown>): Promise<Filed> {
  const answered = await call(who, 'POST', '/approvals/requests', { reason: REASON, ...body });
  if (answered.status === 202) return { ok: true, id: String(answered.json.approval.id), record: answered.json.approval };
  if (!answered.json?.code) throw new Error(`session filing answered ${answered.status} without a code: ${JSON.stringify(answered.json)}`);
  return { ok: false, status: answered.status, code: String(answered.json.code), body: answered.json };
}

async function filedId(filing: Promise<Filed>): Promise<string> {
  const filed = await filing;
  if (!filed.ok) throw new Error(`expected the filing to succeed, got ${filed.code}: ${JSON.stringify(filed.body)}`);
  return filed.id;
}

const codeOf = (filed: Filed): [number, string] => (filed.ok ? [202, 'FILED'] : [filed.status, filed.code]);

async function decide(decider: Caller, approvalId: string, decision: 'approve' | 'deny' = 'approve', body: Record<string, unknown> = {}):
  Promise<Answer & { tokenId: string }> {
  const stepUp = await stepUpService.mint(decider.principalId, 'approval.decide', approvalId, 'password');
  const answered = await call(decider, 'POST', `/approvals/${approvalId}/${decision}`, { stepUpToken: stepUp.token, ...body });
  return { ...answered, tokenId: stepUp.tokenId };
}

async function approvalRow(id: string): Promise<any> {
  return (await pool.query('SELECT * FROM approvals WHERE id = $1', [id])).rows[0];
}

async function tokenConsumed(tokenId: string): Promise<boolean> {
  return (await pool.query('SELECT consumed_at FROM step_up_tokens WHERE id = $1', [tokenId])).rows[0]?.consumed_at != null;
}

async function auditRows(action: string, resourceId: string): Promise<any[]> {
  return (await pool.query(
    `SELECT * FROM audit_events WHERE action = $1 AND resource_id = $2 AND outcome = 'success' ORDER BY occurred_at, id`,
    [action, resourceId])).rows.map((row: any) => ({ ...row, metadata: parseJson(row.metadata) }));
}

/** A decision step-up of `who` for `approvalId`, marked consumed as the decide would leave it. */
async function consumedToken(who: Caller, approvalId: string): Promise<string> {
  const minted = await stepUpService.mint(who.principalId, 'approval.decide', approvalId, 'password');
  await pool.query('UPDATE step_up_tokens SET consumed_at = NOW() WHERE id = $1', [minted.tokenId]);
  return minted.tokenId;
}

/** The newest success row of `action` on `resourceId`, asserted to exist (so its absence is an assertion, never a crash). */
async function lastAudit(action: string, resourceId: string): Promise<any> {
  const rows = await auditRows(action, resourceId);
  expect({ action, rows: rows.length > 0 }).toEqual({ action, rows: true });
  return rows[rows.length - 1];
}

async function hubItem(who: Caller, id: string): Promise<any> {
  const answer = await call(who, 'GET', '/approvals?view=hub&status=all');
  expect(answer.status).toBe(200);
  return answer.json.approvals.find((item: any) => String(item.id) === id) ?? null;
}

async function approvalCount(): Promise<number> {
  return (await pool.query('SELECT COUNT(*)::int AS n FROM approvals')).rows[0].n;
}

async function column(table: string, field: string, id: string): Promise<any> {
  return (await pool.query(`SELECT ${field} AS value FROM ${table} WHERE id = $1`, [id])).rows[0]?.value ?? null;
}

async function project(owner: Caller, name = `UCR T2O project ${tag()}`): Promise<string> {
  const created = await call(owner, 'POST', '/projects', { name });
  expect(created.status).toBe(201);
  return String(created.json.project.id);
}

async function phase(owner: Caller, projectId: string): Promise<string> {
  const created = await call(owner, 'POST', '/phases', { projectId, name: `UCR T2O phase ${tag()}`, goal: 'the first goal' });
  expect(created.status).toBe(201);
  return String(created.json.phase.id);
}

async function task(owner: Caller, projectId: string): Promise<string> {
  const created = await call(owner, 'POST', '/tasks', { title: `UCR T2O task ${tag()}`, description: 'change-request drill', status: 'todo', project: projectId });
  expect(created.status).toBe(201);
  return String(created.json.task.id);
}

async function report(owner: Caller, visibility = 'private'): Promise<string> {
  const created = await call(owner, 'POST', '/reports', { title: `UCR T2O report ${tag()}`, content: 'change-request drill evidence', visibility });
  expect(created.status).toBe(201);
  return String(created.json.report?.id ?? created.json.data?.id ?? created.json.id);
}

/** A Group with `holder` as a member and a live owner steward row. */
async function ownedGroup(holder: Caller): Promise<string> {
  const group = await insertGroupRow(pool, { name: `ucr-t2o-group-${tag()}` });
  await pool.query(`INSERT INTO group_members (group_id, account_principal_id, source) VALUES ($1, $2, 'local')`, [group, holder.principalId]);
  await pool.query(`INSERT INTO group_stewards (group_id, account_principal_id, role) VALUES ($1, $2, 'owner')`, [group, holder.principalId]);
  return group;
}

/** A fresh administrator session that files: the request quota (5 pending) is per requester. */
const filer = (label: string): Promise<Caller> => person(label, 'operator');

/** The login-session authorization actor of a person, as the router builds it. */
const sessionActor = (who: Caller) => ({
  authenticated: true, principalId: who.principalId, handle: who.label, role: who.role, scopes: scopesForRole(who.role),
});

// ─────────────────────────────── fixtures ────────────────────────────────────

let ROOT: Caller;        // role admin: root
let OPERATOR: Caller;    // a non-root administrator
let OPERATOR2: Caller;   // a second non-root administrator
let OWNER: Caller;       // an ordinary user who owns the objects below
let OTHER: Caller;       // an ordinary user
let OTHER2: Caller;      // an ordinary user
let VIEWER: Caller;      // a viewer, made the owner of objects by SQL (its role cannot write them)

beforeAll(async () => {
  await new Promise<void>((resolve) => { server = buildApp().listen(0, '127.0.0.1', resolve); });
  origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  ROOT = await person('root', 'admin');
  OPERATOR = await person('operator', 'operator');
  OPERATOR2 = await person('operator2', 'operator');
  OWNER = await person('owner', 'user');
  OTHER = await person('other', 'user');
  OTHER2 = await person('other2', 'user');
  VIEWER = await person('viewer', 'viewer');
});

afterAll(async () => {
  if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  await pool.end();
});

// ═══════════════════════════════ (O) ownership ═══════════════════════════════

describe('(O) ownership targets (slice S5)', () => {
  it("O1: the owner's Connector files a project.owner move; the owner never decides its own Account's filing; an administrator applies it through the transfer act with the decision on its row", async () => {
    const P = await project(OWNER);
    const conn = await connectorOf(OWNER);
    const id = await filedId(fileBearer(conn, { targetType: 'project.owner', targetId: P, change: { ownerPrincipalId: OTHER.principalId } }));
    const row = await approvalRow(id);
    const spec = parseJson(row.change_spec);
    expect([row.target_type, String(row.target_id), row.grantee_principal_id, spec.before, spec.requested]).toEqual([
      'project.owner', P, null, { ownerPrincipalId: OWNER.principalId, ownerKind: 'human' },
      { ownerPrincipalId: OTHER.principalId, ownerKind: 'human' }]);
    expect(await column('projects', 'owner_principal_id', P)).toBe(OWNER.principalId);
    const self = await decide(OWNER, id);
    expect([self.status, self.json?.code, self.json?.cases, await tokenConsumed(self.tokenId)]).toEqual([403, 'SELF_DECISION_REFUSED', ['a'], false]);
    const approved = await decide(OPERATOR, id);
    expect([approved.status, approved.json?.approval?.status]).toEqual([200, 'approved']);
    expect(await column('projects', 'owner_principal_id', P)).toBe(OTHER.principalId);
    const ledger = await lastAudit('project.owner.change', P);
    expect(ledger.metadata).toMatchObject({ oldOwnerPrincipalId: OWNER.principalId, newOwnerPrincipalId: OTHER.principalId,
      approvalId: id, kind: 'change', targetType: 'project.owner', deciderStanding: 'administrator' });
    expect(ledger.metadata.stepUp).toMatchObject({ tokenId: approved.tokenId });
    const decided = parseJson((await approvalRow(id)).change_spec).diff;
    expect(decided.fields).toEqual([{ field: 'ownerPrincipalId', before: OWNER.principalId, after: OTHER.principalId }]);
    expect(decided.relationships.map((e: any) => [e.principal.id, e.action, e.state]))
      .toEqual([[OWNER.principalId, 'owner', 'removed'], [OTHER.principalId, 'owner', 'added']]);
  });

  it('O2: an administrator files a person move and the PERSON owner decides it on its stored session; the new owner, a stranger to the request, is answered as absent', async () => {
    const P = await project(OWNER);
    const id = await filedId(fileSession(OPERATOR, { targetType: 'project.owner', targetId: P, change: { ownerPrincipalId: OTHER2.principalId } }));
    expect(await hubItem(OWNER, id)).toMatchObject({ decidable: true });
    const named = await decide(OTHER2, id);
    expect([named.status, named.json?.code]).toEqual([404, 'APPROVAL_NOT_FOUND']);
    const approved = await decide(OWNER, id);
    expect([approved.status, (await approvalRow(id)).decider_standing]).toEqual([200, 'owner']);
    expect(await column('projects', 'owner_principal_id', P)).toBe(OTHER2.principalId);
  });

  it('O3: a move into a Group is decided by root or an administrator only; the Group transfer takes the decision\'s ONE step-up as its evidence', async () => {
    const P = await project(OWNER);
    const G = await ownedGroup(OTHER);
    const id = await filedId(fileSession(OPERATOR, { targetType: 'project.owner', targetId: P, change: { ownerPrincipalId: G } }));
    expect(parseJson((await approvalRow(id)).change_spec).requested).toEqual({ ownerPrincipalId: G, ownerKind: 'group' });
    const owner = await decide(OWNER, id);
    expect([owner.status, owner.json?.code, await tokenConsumed(owner.tokenId)]).toEqual([403, 'APPROVAL_DECIDE_REQUIRES_ADMINISTRATOR', false]);
    const approved = await decide(OPERATOR2, id);
    expect(approved.status).toBe(200);
    expect(await column('projects', 'owner_principal_id', P)).toBe(G);
    const ledger = await lastAudit('project.owner.change', P);
    expect(ledger.metadata).toMatchObject({ newOwnerKind: 'group', stepUpTokenId: approved.tokenId, deciderStanding: 'administrator', approvalId: id });
    // ONE token: no ownership.transfer token was minted or consumed for this act.
    const transfer = (await pool.query(`SELECT COUNT(*)::int AS n FROM step_up_tokens WHERE action = 'ownership.transfer' AND target_id = $1`, [P])).rows[0].n;
    expect(transfer).toBe(0);
  });

  it('O4: forged evidence is refused by the Group transfer seam: an unconsumed token, or another decider\'s, answers STEP_UP_REQUIRED', async () => {
    const P = await project(OWNER);
    const G = await ownedGroup(OTHER);
    const id = await filedId(fileSession(OPERATOR, { targetType: 'project.owner', targetId: P, change: { ownerPrincipalId: G } }));
    const unconsumed = await stepUpService.mint(OPERATOR2.principalId, 'approval.decide', id, 'password');
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT id FROM approvals WHERE id = $1 FOR UPDATE', [id]);
      const attempt = (evidence: Record<string, unknown>) => groupOwnershipStandingTest(client, {
        objectType: 'project', objectId: P, currentOwnerId: OWNER.principalId, targetOwnerId: G,
        standing: { authMethod: 'session', handle: OPERATOR2.label, principalId: OPERATOR2.principalId, principalRole: 'operator',
          scopes: scopesForRole('operator'), stepUpToken: '', decisionEvidence: evidence },
        audit: { principalId: OPERATOR2.principalId, handle: OPERATOR2.label, authMethod: 'session' }, auditAction: 'project.owner.change',
      }).then(() => 'ADMITTED', (e: any) => String(e?.code));
      expect(await attempt({ tokenId: unconsumed.tokenId, method: 'password', approvalId: id, deciderPrincipalId: OPERATOR2.principalId })).toBe('STEP_UP_REQUIRED');
      expect(await attempt({ tokenId: unconsumed.tokenId, method: 'password', approvalId: id, deciderPrincipalId: OPERATOR.principalId })).toBe('STEP_UP_REQUIRED');
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
    expect(await column('projects', 'owner_principal_id', P)).toBe(OWNER.principalId);
  });

  it("O4b: the Group transfer seam takes evidence only for its own decider: another person's consumed decision token answers STEP_UP_REQUIRED", async () => {
    const P = await project(OWNER);
    const G = await ownedGroup(OTHER);
    const id = await filedId(fileSession(OPERATOR, { targetType: 'project.owner', targetId: P, change: { ownerPrincipalId: G } }));
    const foreign = await consumedToken(OPERATOR2, id);
    const client = await pool.connect();
    let outcome = 'ADMITTED';
    try {
      await client.query('BEGIN');
      await client.query('SELECT id FROM approvals WHERE id = $1 FOR UPDATE', [id]);
      outcome = await groupOwnershipStandingTest(client, {
        objectType: 'project', objectId: P, currentOwnerId: OWNER.principalId, targetOwnerId: G,
        standing: { authMethod: 'session', handle: OPERATOR.label, principalId: OPERATOR.principalId, principalRole: 'operator',
          scopes: scopesForRole('operator'), stepUpToken: '',
          decisionEvidence: { tokenId: foreign, method: 'password', approvalId: id, deciderPrincipalId: OPERATOR2.principalId } },
        audit: { principalId: OPERATOR.principalId, handle: OPERATOR.label, authMethod: 'session' }, auditAction: 'project.owner.change',
      }).then(() => 'ADMITTED', (e: any) => String(e?.code));
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
    expect(outcome).toBe('STEP_UP_REQUIRED');
  });

  it('O7: a Group-owned Project moved to a person is decided by root or an administrator; its Group owner has no tier here', async () => {
    const P = await project(OWNER);
    const G = await ownedGroup(OTHER);
    await pool.query('UPDATE projects SET owner_principal_id = $2 WHERE id = $1', [P, G]);
    const id = await filedId(fileSession(await filer('o7-filer'), { targetType: 'project.owner', targetId: P, change: { ownerPrincipalId: OTHER2.principalId } }));
    const steward = await decide(OTHER, id);
    expect([steward.status, steward.json?.code, await tokenConsumed(steward.tokenId)]).toEqual([403, 'APPROVAL_DECIDE_REQUIRES_ADMINISTRATOR', false]);
    expect(String(steward.json?.message)).toContain('no Group tier reaches it');
    expect((await decide(ROOT, id)).status).toBe(200);
    expect(await column('projects', 'owner_principal_id', P)).toBe(OTHER2.principalId);
  });

  /** The new Report executor refuses on its own, behind the filing checks (a direct call on a transaction, rolled back). */
  const reportMove = async (reportId: string, to: string, expected: string | null): Promise<string> => {
    const { reportAccountOwnershipService } = require('../services/ReportAccountOwnershipService');
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      return await reportAccountOwnershipService.changeWithin(client, {
        reportId, accountOwnerPrincipalId: to, expectedAccountOwnerPrincipalId: expected,
        actor: { principalId: ROOT.principalId, handle: ROOT.label, authMethod: 'session' }, ledger: {},
      }).then(() => 'MOVED', (e: any) => String(e?.code));
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
  };

  it('O8a: the Report executor moves a Report to an active human Account only', async () => {
    const R = await report(OWNER);
    const conn = await connectorOf(OWNER);
    expect([await reportMove(R, conn.principalId, OWNER.principalId), await reportMove(R, OTHER.principalId, OWNER.principalId)])
      .toEqual(['INVALID_ACCOUNT_OWNER', 'MOVED']);
  });

  it('O8b: the Report executor never moves a task-bound Report', async () => {
    const R = await report(OWNER);
    await pool.query(`UPDATE reports SET origin = 'task-report', source_task_id = $2 WHERE id = $1`, [R, await task(OWNER, await project(OWNER))]);
    expect(await reportMove(R, OTHER.principalId, OWNER.principalId)).toBe('REPORT_TASK_BOUND');
  });

  it('O8c: the Report executor refuses a move whose current owner is not the one the decision approved against', async () => {
    const R = await report(OWNER);
    expect([await reportMove(R, OTHER.principalId, OTHER2.principalId), await reportMove(R, OTHER.principalId, OWNER.principalId)])
      .toEqual(['ACCOUNT_OWNER_STATE_CHANGED', 'MOVED']);
  });

  it('O5: task.account_owner is filed and decided by root or an administrator; an ordinary user, even its owner, has no standing to ask', async () => {
    const P = await project(OWNER);
    const T = await task(OWNER, P);
    const conn = await connectorOf(OWNER);
    expect(codeOf(await fileBearer(conn, { targetType: 'task.account_owner', targetId: T, change: { accountOwnerPrincipalId: OTHER.principalId } })))
      .toEqual([403, 'REQUEST_STANDING_NONE']);
    const id = await filedId(fileSession(OPERATOR, { targetType: 'task.account_owner', targetId: T, change: { accountOwnerPrincipalId: OTHER.principalId } }));
    const owner = await decide(OWNER, id);
    expect([owner.status, owner.json?.code, await tokenConsumed(owner.tokenId)]).toEqual([403, 'APPROVAL_DECIDE_REQUIRES_ADMINISTRATOR', false]);
    const approved = await decide(ROOT, id);
    expect(approved.status).toBe(200);
    expect(await column('tasks', 'account_owner_principal_id', T)).toBe(OTHER.principalId);
    const ledger = await lastAudit('task.account_owner.change', T);
    expect(ledger.metadata).toMatchObject({ oldAccountOwnerPrincipalId: OWNER.principalId, newAccountOwnerPrincipalId: OTHER.principalId,
      approvalId: id, targetType: 'task.account_owner', deciderStanding: 'root' });
  });

  it("O6: report.account_owner moves a standalone Report through the new executor; a task-bound Report and a Connector owner are refused at filing", async () => {
    const R = await report(OWNER);
    const conn = await connectorOf(OWNER);
    const count = await approvalCount();
    expect(codeOf(await fileSession(OWNER, { targetType: 'report.account_owner', targetId: R, change: { accountOwnerPrincipalId: conn.principalId } })))
      .toEqual([422, 'INVALID_OWNER']);
    const bound = await report(OWNER);
    await pool.query(`UPDATE reports SET origin = 'task-report', source_task_id = $2 WHERE id = $1`, [bound, await task(OWNER, await project(OWNER))]);
    expect(codeOf(await fileSession(OPERATOR, { targetType: 'report.account_owner', targetId: bound, change: { accountOwnerPrincipalId: OTHER.principalId } })))
      .toEqual([422, 'REPORT_TASK_BOUND']);
    expect(await approvalCount()).toBe(count);
    const id = await filedId(fileSession(OWNER, { targetType: 'report.account_owner', targetId: R, change: { accountOwnerPrincipalId: OTHER.principalId } }));
    const approved = await decide(OPERATOR, id);
    expect(approved.status).toBe(200);
    expect(await column('reports', 'account_owner_principal_id', R)).toBe(OTHER.principalId);
    const ledger = await lastAudit('report.account_owner.change', R);
    expect(ledger.metadata).toMatchObject({ oldAccountOwnerPrincipalId: OWNER.principalId, newAccountOwnerPrincipalId: OTHER.principalId,
      approvalId: id, targetType: 'report.account_owner', deciderStanding: 'administrator' });
  });
});

// ═══════════════════════════ (V) Verifiers and roles ═════════════════════════

describe('(V) Verifier and role targets (slice S5)', () => {
  it('V1: a default Verifier changed by request: an administrator files, the person owner decides with one step-up through the lifted seam', async () => {
    const P = await project(OWNER);
    const id = await filedId(fileSession(OPERATOR, { targetType: 'project.default_verifier', targetId: P, change: { defaultVerifierPrincipalId: OTHER.principalId } }));
    expect(await hubItem(OWNER, id)).toMatchObject({ decidable: true });
    const approved = await decide(OWNER, id);
    expect(approved.status).toBe(200);
    expect(await column('projects', 'default_verifier_principal_id', P)).toBe(OTHER.principalId);
    const ledger = await lastAudit('project.default_verifier.set', P);
    expect(ledger.metadata).toMatchObject({ previous: null, next: OTHER.principalId, standing: 'owner', approvalId: id,
      targetType: 'project.default_verifier', deciderStanding: 'owner' });
    expect(ledger.metadata.stepUp).toMatchObject({ tokenId: approved.tokenId });
  });

  it("V2a: E311's 403 binds the Project default-Verifier route for a non-owner write-grantee, through the lifted seam", async () => {
    const P = await project(OWNER);
    // E311's caller: a Project write-grantee who is not its owner.
    expect((await call(ROOT, 'POST', '/grants', { granteeId: OTHER.principalId, resourceType: 'project', resourceId: P, verb: 'write' })).status).toBe(201);
    const onProject = await call(OTHER, 'PUT', `/projects/${P}/default-verifier`, { principalId: OTHER2.principalId },
      { 'If-Match': String(await column('projects', 'revision', P)) });
    expect([onProject.status, onProject.json?.code, await column('projects', 'default_verifier_principal_id', P)])
      .toEqual([403, 'DEFAULT_VERIFIER_REQUIRES_OWNER', null]);
    // The direct route still writes for its person owner, through the same seam.
    const own = await call(OWNER, 'PUT', `/projects/${P}/default-verifier`, { principalId: OTHER2.principalId },
      { 'If-Match': String(await column('projects', 'revision', P)) });
    expect([own.status, await column('projects', 'default_verifier_principal_id', P)]).toEqual([200, OTHER2.principalId]);
  });

  it("V2b: E311's 403 binds the Phase default-Verifier route for a caller who reads the Phase; a Group value is refused at filing", async () => {
    const P = await project(OWNER);
    const PH = await phase(OWNER, P);
    // The Project write grant lends read on its Phase: the Phase route answers by name, never concealed.
    expect((await call(ROOT, 'POST', '/grants', { granteeId: OTHER.principalId, resourceType: 'project', resourceId: P, verb: 'write' })).status).toBe(201);
    const onPhase = await call(OTHER, 'PUT', `/phases/${PH}/default-verifier`, { principalId: OTHER2.principalId },
      { 'If-Match': String(await column('phases', 'revision', PH)) });
    expect([onPhase.status, onPhase.json?.code, await column('phases', 'default_verifier_principal_id', PH)])
      .toEqual([403, 'DEFAULT_VERIFIER_REQUIRES_OWNER', null]);
    const G = await ownedGroup(OTHER2);
    expect(codeOf(await fileSession(OPERATOR, { targetType: 'phase.default_verifier', targetId: PH, change: { defaultVerifierPrincipalId: G } })))
      .toEqual([422, 'DEFAULT_VERIFIER_GROUP_PRINCIPAL']);
    const own = await call(OWNER, 'PUT', `/phases/${PH}/default-verifier`, { principalId: OTHER2.principalId },
      { 'If-Match': String(await column('phases', 'revision', PH)) });
    expect([own.status, await column('phases', 'default_verifier_principal_id', PH)]).toEqual([200, OTHER2.principalId]);
  });

  it('V3: task.roles names a Verifier on the owner\'s Task; an administrator applies it with the decision on the roles audit row', async () => {
    const P = await project(OWNER);
    const T = await task(OWNER, P);
    const id = await filedId(fileSession(OWNER, { targetType: 'task.roles', targetId: T, change: { verifierPrincipalId: OTHER.principalId } }));
    const approved = await decide(OPERATOR, id);
    expect(approved.status).toBe(200);
    expect(await column('tasks', 'verifier_principal_id', T)).toBe(OTHER.principalId);
    const ledger = await lastAudit('task.lifecycle_override.roles', T);
    expect(ledger.metadata).toMatchObject({ verifierPrincipalId: OTHER.principalId, approvalId: id, targetType: 'task.roles', deciderStanding: 'administrator' });
  });

  it('V4: task.roles re-checks its holders at decide: a Verifier disabled after filing is refused and nothing is applied', async () => {
    const P = await project(OWNER);
    const T = await task(OWNER, P);
    const holder = await person('v4-holder', 'user');
    const id = await filedId(fileSession(OWNER, { targetType: 'task.roles', targetId: T, change: { verifierPrincipalId: holder.principalId } }));
    await pool.query(`UPDATE principals SET status = 'disabled' WHERE id = $1`, [holder.principalId]);
    const refused = await decide(OPERATOR, id);
    expect([refused.status, refused.json?.code, await tokenConsumed(refused.tokenId)]).toEqual([422, 'TASK_ROLE_PRINCIPAL_UNAVAILABLE', false]);
    expect(await column('tasks', 'verifier_principal_id', T)).toBe(null);
  });
});

// ════════════════════════ (G) Charter and Phase goal ═════════════════════════

describe('(G) Charter and Phase goal targets (slice S5)', () => {
  it('G1: a Charter revision approved from the hub with one sign-in: the person owner is the approver of content and approval in one act', async () => {
    const P = await project(OWNER);
    const id = await filedId(fileSession(OPERATOR, { targetType: 'charter.revision', targetId: P, change: { content: '# Charter\n\n1. The first authority.' } }));
    const spec = parseJson((await approvalRow(id)).change_spec);
    expect(spec.before).toEqual({ version: null, contentHash: null, content: null });
    expect(spec.requested.contentHash).toBe(crypto.createHash('sha256').update('# Charter\n\n1. The first authority.', 'utf8').digest('hex'));
    expect(await hubItem(OWNER, id)).toMatchObject({ decidable: true });
    const approved = await decide(OWNER, id);
    expect(approved.status).toBe(200);
    const head = (await pool.query('SELECT version, content_hash, updated_by_principal_id FROM project_charters WHERE project_id = $1', [P])).rows[0];
    expect([head.version, head.content_hash, String(head.updated_by_principal_id)]).toEqual([1, spec.requested.contentHash, OWNER.principalId]);
    const ledger = await lastAudit('charter.approve', P);
    expect(ledger.metadata).toMatchObject({ charterVersion: 1, sha: spec.requested.contentHash, approvalId: id, targetType: 'charter.revision', deciderStanding: 'owner' });
  });

  it("G2: on a Group-owned Project the Group's owner approves the Charter through gate (i) with the decision's step-up; forged evidence is refused", async () => {
    const P = await project(OWNER);
    const G = await ownedGroup(OTHER);
    await pool.query('UPDATE projects SET owner_principal_id = $2 WHERE id = $1', [P, G]);
    const id = await filedId(fileSession(OPERATOR, { targetType: 'charter.revision', targetId: P, change: { content: 'The Group Charter.' } }));
    // Forged evidence (an unconsumed token) on the approval seam itself is STEP_UP_REQUIRED.
    const unconsumed = await stepUpService.mint(OTHER.principalId, 'approval.decide', id, 'password');
    const client = await pool.connect();
    let forged = 'ADMITTED';
    try {
      await client.query('BEGIN');
      await client.query('SELECT id FROM approvals WHERE id = $1 FOR UPDATE', [id]);
      forged = await charterService.approveWithin(client, P, 'Forged.', {
        authorization: sessionActor(OTHER), authMethod: 'session', audit: { principalId: OTHER.principalId, handle: OTHER.label, authMethod: 'session' },
        decisionEvidence: { tokenId: unconsumed.tokenId, method: 'password', approvalId: id, deciderPrincipalId: OTHER.principalId },
      }, {}).then(() => 'ADMITTED', (e: any) => String(e?.code));
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
    expect(forged).toBe('STEP_UP_REQUIRED');
    const approved = await decide(OTHER, id);
    expect([approved.status, (await approvalRow(id)).decider_standing]).toEqual([200, 'group-owner']);
    const ledger = await lastAudit('charter.approve', P);
    expect(ledger.metadata).toMatchObject({ standing: 'group-owner', owningGroupId: G, stepUpTokenId: approved.tokenId, approvalId: id });
  });

  it("G2b: the Charter gate (i) takes evidence only for its own decider: another person's consumed decision token answers STEP_UP_REQUIRED", async () => {
    const P = await project(OWNER);
    const G = await ownedGroup(OTHER);
    await pool.query('UPDATE projects SET owner_principal_id = $2 WHERE id = $1', [P, G]);
    const id = await filedId(fileSession(await filer('g2b-filer'), { targetType: 'charter.revision', targetId: P, change: { content: 'The Group Charter, again.' } }));
    const foreign = await consumedToken(OTHER2, id);
    const client = await pool.connect();
    let outcome = 'ADMITTED';
    try {
      await client.query('BEGIN');
      await client.query('SELECT id FROM approvals WHERE id = $1 FOR UPDATE', [id]);
      outcome = await charterService.approveWithin(client, P, 'Foreign.', {
        authorization: sessionActor(OTHER), authMethod: 'session', audit: { principalId: OTHER.principalId, handle: OTHER.label, authMethod: 'session' },
        decisionEvidence: { tokenId: foreign, method: 'password', approvalId: id, deciderPrincipalId: OTHER2.principalId },
      }, {}).then(() => 'ADMITTED', (e: any) => String(e?.code));
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
    expect(outcome).toBe('STEP_UP_REQUIRED');
  });

  it("G3: phase.goal filed by the owner's Connector is applied by an administrator through PhaseService.update", async () => {
    const P = await project(OWNER);
    const PH = await phase(OWNER, P);
    const conn = await connectorOf(OWNER);
    const id = await filedId(fileBearer(conn, { targetType: 'phase.goal', targetId: PH, change: { goal: 'the agreed outcome' } }));
    const approved = await decide(OPERATOR, id);
    expect(approved.status).toBe(200);
    expect(await column('phases', 'goal', PH)).toBe('the agreed outcome');
    expect(parseJson((await approvalRow(id)).change_spec).diff.fields).toEqual([{ field: 'goal', before: 'the first goal', after: 'the agreed outcome' }]);
  });
});

// ═══════════════════════ (A) access and visibility ═══════════════════════════

describe('(A) access and visibility targets (slice S5)', () => {
  it('A1: task.access is applied by an administrator with its first audit_events row beside the trigger ledger', async () => {
    const P = await project(OWNER);
    const T = await task(OWNER, P);
    const id = await filedId(fileSession(OWNER, { targetType: 'task.access', targetId: T, change: { restricted: true } }));
    const approved = await decide(OPERATOR, id);
    expect(approved.status).toBe(200);
    expect(await column('tasks', 'restricted_access', T)).toBe(true);
    const ledger = await lastAudit('task.access.set', T);
    expect(ledger.metadata).toMatchObject({ before: { restricted: false }, after: { restricted: true }, approvalId: id, deciderStanding: 'administrator' });
    const trigger = (await pool.query('SELECT COUNT(*)::int AS n FROM task_access_events WHERE task_id = $1', [T])).rows[0].n;
    expect(trigger).toBe(1);
  });

  it('A2: phase.access is applied by an administrator with its first audit_events row', async () => {
    const P = await project(OWNER);
    const PH = await phase(OWNER, P);
    const id = await filedId(fileSession(OWNER, { targetType: 'phase.access', targetId: PH, change: { restricted: true } }));
    const approved = await decide(OPERATOR, id);
    expect(approved.status).toBe(200);
    expect(await column('phases', 'restricted_access', PH)).toBe(true);
    const ledger = await lastAudit('phase.access.set', PH);
    expect(ledger.metadata).toMatchObject({ before: { restricted: false }, after: { restricted: true }, approvalId: id });
  });

  it('A3: report.visibility requests only the opening transition; a closed Report opened by request is read by every authenticated principal', async () => {
    const R = await report(OWNER, 'private');
    expect((await call(OTHER, 'GET', `/reports/${R}`)).status).toBe(404);
    expect(codeOf(await fileSession(OWNER, { targetType: 'report.visibility', targetId: R, change: { visibility: 'team' } })))
      .toEqual([422, 'VISIBILITY_NOT_OPENING']);
    const open = await report(OWNER, 'default');
    expect(codeOf(await fileSession(OWNER, { targetType: 'report.visibility', targetId: open, change: { visibility: 'public' } })))
      .toEqual([422, 'VISIBILITY_NOT_OPENING']);
    const id = await filedId(fileSession(OWNER, { targetType: 'report.visibility', targetId: R, change: { visibility: 'shared' } }));
    const approved = await decide(OPERATOR, id);
    expect(approved.status).toBe(200);
    expect(await column('reports', 'visibility', R)).toBe('shared');
    expect((await call(OTHER, 'GET', `/reports/${R}`)).status).toBe(200);
    const ledger = await lastAudit('report.visibility.set', R);
    expect(ledger.metadata).toMatchObject({ before: { visibility: 'private' }, after: { visibility: 'shared' }, approvalId: id });
  });
});

// ═════════════════════════ (R) authority never widens ════════════════════════

describe('(R) authority never widens (slice S5)', () => {
  /**
   * The decider's own reach on the object, per target (section 5.1 (5)): a
   * person owner whose role cannot act on the object at the direct door's
   * action passes the owner arm, and is refused DECIDER_CEILING_EXCEEDED
   * without spending its step-up, nothing applied.
   */
  const ceilingCases: Array<[string, string, () => Promise<{ id: string; check: () => Promise<unknown>; was: unknown }>]> = [
    ['R1 phase.goal', 'VIEWER', async () => {
      const P = await project(OWNER); const PH = await phase(OWNER, P);
      await pool.query('UPDATE projects SET owner_principal_id = $2 WHERE id = $1', [P, VIEWER.principalId]);
      const id = await filedId(fileSession(await filer('r-filer'), { targetType: 'phase.goal', targetId: PH, change: { goal: 'widened' } }));
      return { id, check: () => column('phases', 'goal', PH), was: 'the first goal' };
    }],
    ['R2 task.roles', 'VIEWER', async () => {
      const P = await project(OWNER); const T = await task(OWNER, P);
      await pool.query('UPDATE tasks SET account_owner_principal_id = $2 WHERE id = $1', [T, VIEWER.principalId]);
      const id = await filedId(fileSession(await filer('r-filer'), { targetType: 'task.roles', targetId: T, change: { verifierPrincipalId: OTHER.principalId } }));
      return { id, check: () => column('tasks', 'verifier_principal_id', T), was: null };
    }],
    ['R3 task.access', 'OWNER', async () => {
      const P = await project(OWNER); const T = await task(OWNER, P);
      const id = await filedId(fileSession(await filer('r-filer'), { targetType: 'task.access', targetId: T, change: { restricted: true } }));
      return { id, check: () => column('tasks', 'restricted_access', T), was: false };
    }],
    ['R4 project.default_verifier', 'VIEWER', async () => {
      const P = await project(OWNER);
      await pool.query('UPDATE projects SET owner_principal_id = $2 WHERE id = $1', [P, VIEWER.principalId]);
      const id = await filedId(fileSession(await filer('r-filer'), { targetType: 'project.default_verifier', targetId: P, change: { defaultVerifierPrincipalId: OTHER.principalId } }));
      return { id, check: () => column('projects', 'default_verifier_principal_id', P), was: null };
    }],
    ['R5 report.visibility', 'VIEWER', async () => {
      const R = await report(OWNER, 'private');
      await pool.query('UPDATE reports SET account_owner_principal_id = $2 WHERE id = $1', [R, VIEWER.principalId]);
      const id = await filedId(fileSession(await filer('r-filer'), { targetType: 'report.visibility', targetId: R, change: { visibility: 'shared' } }));
      return { id, check: () => column('reports', 'visibility', R), was: 'private' };
    }],
    ['R6 report.account_owner', 'VIEWER', async () => {
      const R = await report(OWNER, 'private');
      await pool.query('UPDATE reports SET account_owner_principal_id = $2 WHERE id = $1', [R, VIEWER.principalId]);
      const id = await filedId(fileSession(await filer('r-filer'), { targetType: 'report.account_owner', targetId: R, change: { accountOwnerPrincipalId: OTHER.principalId } }));
      return { id, check: () => column('reports', 'account_owner_principal_id', R), was: VIEWER.principalId };
    }],
    ['R13 phase.default_verifier', 'VIEWER', async () => {
      const P = await project(OWNER); const PH = await phase(OWNER, P);
      await pool.query('UPDATE projects SET owner_principal_id = $2 WHERE id = $1', [P, VIEWER.principalId]);
      const id = await filedId(fileSession(await filer('r-filer'), { targetType: 'phase.default_verifier', targetId: PH, change: { defaultVerifierPrincipalId: OTHER.principalId } }));
      return { id, check: () => column('phases', 'default_verifier_principal_id', PH), was: null };
    }],
    ['R14 phase.access', 'OWNER', async () => {
      const P = await project(OWNER); const PH = await phase(OWNER, P);
      const id = await filedId(fileSession(await filer('r-filer'), { targetType: 'phase.access', targetId: PH, change: { restricted: true } }));
      return { id, check: () => column('phases', 'restricted_access', PH), was: false };
    }],
    // The Charter approval act's own gate also refuses such a decider (by its own code): this
    // case pins that the reach check runs first, so the refusal is the ceiling's, step-up unspent.
    ['R15 charter.revision', 'VIEWER', async () => {
      const P = await project(OWNER);
      await pool.query('UPDATE projects SET owner_principal_id = $2 WHERE id = $1', [P, VIEWER.principalId]);
      const id = await filedId(fileSession(await filer('r-filer'), { targetType: 'charter.revision', targetId: P, change: { content: 'A viewer owner approves.' } }));
      const charters = async () => (await pool.query('SELECT COUNT(*)::int AS n FROM project_charters WHERE project_id = $1', [P])).rows[0].n;
      return { id, check: charters, was: 0 };
    }],
  ];
  for (const [title, who, setup] of ceilingCases) {
    it(`${title}: a person owner whose role cannot act on the object at the direct door's action is refused DECIDER_CEILING_EXCEEDED, its step-up unspent`, async () => {
      const decider = who === 'VIEWER' ? VIEWER : OWNER;
      const { id, check, was } = await setup();
      const refused = await decide(decider, id);
      expect([refused.status, refused.json?.code, await tokenConsumed(refused.tokenId)]).toEqual([403, 'DECIDER_CEILING_EXCEEDED', false]);
      expect([await check(), (await approvalRow(id)).status]).toEqual([was, 'pending']);
    });
  }

  it("R7: a decision that does not carry the deciding session's own facts applies nothing", async () => {
    const P = await project(OWNER);
    const PH = await phase(OWNER, P);
    const id = await filedId(fileSession(OWNER, { targetType: 'phase.goal', targetId: PH, change: { goal: 'no facts' } }));
    const stepUp = await stepUpService.mint(OPERATOR.principalId, 'approval.decide', id, 'password');
    const outcome = await approvalService.decide({
      approvalId: id, decision: 'approve', deciderPrincipalId: OPERATOR.principalId,
      deciderViewer: { principalId: OPERATOR.principalId, isRoot: false, administratorOk: true, authMethod: 'session' },
      deciderScopes: scopesForRole('operator'), stepUpToken: stepUp.token,
    }, { principalId: OPERATOR.principalId, handle: OPERATOR.label, authMethod: 'session' }).then(() => 'APPLIED', (e: any) => String(e?.code));
    expect([outcome, await tokenConsumed(stepUp.tokenId), await column('phases', 'goal', PH)])
      .toEqual(['APPROVAL_DECIDE_REQUIRES_ADMINISTRATOR', false, 'the first goal']);
  });

  it('R8: the principal a change puts on the object never decides it (section 5.5 (d)): a named default Verifier, a named Shepherd', async () => {
    const P = await project(OWNER);
    const id = await filedId(fileSession(OWNER, { targetType: 'project.default_verifier', targetId: P, change: { defaultVerifierPrincipalId: OPERATOR2.principalId } }));
    const named = await decide(OPERATOR2, id);
    expect([named.status, named.json?.code, named.json?.cases, await tokenConsumed(named.tokenId)]).toEqual([403, 'SELF_DECISION_REFUSED', ['d'], false]);
    const T = await task(OWNER, P);
    const roles = await filedId(fileSession(OWNER, { targetType: 'task.roles', targetId: T, change: { shepherdPrincipalId: OPERATOR2.principalId } }));
    const shepherd = await decide(OPERATOR2, roles);
    expect([shepherd.status, shepherd.json?.code, shepherd.json?.cases]).toEqual([403, 'SELF_DECISION_REFUSED', ['d']]);
    expect((await decide(OPERATOR, id)).status).toBe(200);
  });

  it('R9: a stale preview never applies: an object whose state moved after filing lapses the request TARGET_CHANGED', async () => {
    const P = await project(OWNER);
    const PH = await phase(OWNER, P);
    const id = await filedId(fileSession(OWNER, { targetType: 'phase.goal', targetId: PH, change: { goal: 'filed goal' } }));
    const revision = String(await column('phases', 'revision', PH));
    expect((await call(OWNER, 'PATCH', `/phases/${PH}`, { revision, goal: 'moved meanwhile' })).status).toBe(200);
    const stale = await decide(OPERATOR, id);
    expect([stale.status, stale.json?.code, (await approvalRow(id)).lapse_reason]).toEqual([409, 'EDIT_STALE', 'TARGET_CHANGED']);
    expect(await column('phases', 'goal', PH)).toBe('moved meanwhile');
  });

  it("R10: a stale preview never applies: an object whose OWNER moved after filing lapses the request, so a former owner never decides it", async () => {
    const P = await project(OWNER);
    const T = await task(OWNER, P);
    const id = await filedId(fileSession(await filer('r-filer'), { targetType: 'task.roles', targetId: T, change: { verifierPrincipalId: OTHER.principalId } }));
    await pool.query('UPDATE tasks SET account_owner_principal_id = $2 WHERE id = $1', [T, OTHER2.principalId]);
    const stale = await decide(OWNER, id);
    expect([stale.status, stale.json?.code, (await approvalRow(id)).lapse_reason]).toEqual([409, 'EDIT_STALE', 'TARGET_CHANGED']);
    expect(await column('tasks', 'verifier_principal_id', T)).toBe(null);
  });
  it('R11: an ordinary user who reads an object but does not own it has no standing to ask for its object targets', async () => {
    const P = await project(OWNER);
    expect((await call(ROOT, 'POST', '/grants', { granteeId: OTHER.principalId, resourceType: 'project', resourceId: P, verb: 'write' })).status).toBe(201);
    const count = await approvalCount();
    expect([
      codeOf(await fileSession(OTHER, { targetType: 'charter.revision', targetId: P, change: { content: 'A write-grantee asks.' } })),
      codeOf(await fileSession(OTHER, { targetType: 'project.default_verifier', targetId: P, change: { defaultVerifierPrincipalId: OTHER.principalId } })),
    ]).toEqual([[403, 'REQUEST_STANDING_NONE'], [403, 'REQUEST_STANDING_NONE']]);
    expect(await approvalCount()).toBe(count);
  });

  it('R12: an object target names its object and no grantee', async () => {
    const P = await project(OWNER);
    const count = await approvalCount();
    expect(codeOf(await fileSession(OPERATOR, { targetType: 'project.owner', targetId: P, granteePrincipalId: OTHER.principalId,
      change: { ownerPrincipalId: OTHER.principalId } }))).toEqual([422, 'GRANTEE_NOT_ADMISSIBLE']);
    expect(await approvalCount()).toBe(count);
  });
});

// ════════════════════════════════ (P) preview ════════════════════════════════

describe('(P) the preview answers the object targets (slice S5)', () => {
  it('P1: the preview names the object targets for each object, who may decide them, and writes nothing; an unreadable object answers as an absent one', async () => {
    const P = await project(OWNER);
    const T = await task(OWNER, P);
    const approvals = await approvalCount();
    const onProject = await call(OWNER, 'GET', `/approvals/requests/preview?objectType=project&targetId=${P}`);
    expect(onProject.status).toBe(200);
    const byType = (answer: Answer) => Object.fromEntries(answer.json.requestable.map((e: any) => [e.targetType, e]));
    const forProject = byType(onProject);
    // grant.rows for the owner itself is refused ALREADY_HELD; the object targets are requestable.
    expect(Object.keys(forProject).filter((type) => type !== 'grant.rows').sort()).toEqual(['charter.revision', 'project.default_verifier', 'project.owner']);
    expect(forProject['project.owner']).toMatchObject({ grantees: 'none', fields: ['ownerPrincipalId'], before: { ownerPrincipalId: OWNER.principalId, ownerKind: 'human' } });
    expect(forProject['project.owner'].deciders.map((d: any) => d.standing)).toEqual(['root', 'administrator', 'owner']);
    const onTask = await call(OWNER, 'GET', `/approvals/requests/preview?objectType=task&targetId=${T}`);
    expect(Object.keys(byType(onTask)).filter((type) => type !== 'grant.rows').sort()).toEqual(['task.access', 'task.roles']);
    expect(onTask.json.refused).toEqual(expect.arrayContaining([{ targetType: 'task.account_owner', code: 'REQUEST_STANDING_NONE' }]));
    const hidden = await task(OWNER, P);
    await pool.query(`UPDATE projects SET visibility = 'private' WHERE id = $1`, [P]);
    await pool.query(`UPDATE tasks SET visibility = 'private' WHERE id = $1`, [hidden]);
    const unreadable = await call(OTHER, 'GET', `/approvals/requests/preview?objectType=task&targetId=${hidden}`);
    const absent = await call(OTHER, 'GET', `/approvals/requests/preview?objectType=task&targetId=${crypto.randomUUID()}`);
    expect(unreadable.json).toEqual(absent.json);
    expect(await approvalCount()).toBe(approvals);
  });
});
