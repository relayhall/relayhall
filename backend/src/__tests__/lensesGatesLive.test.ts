/**
 * Card b5c83682 - LENSES-c build c1-B: the owner-only gates and the manager
 * lens (design delta LENSES-C steward tier, RATIFIED 2026-10-11, ruling E98;
 * clauses C.4 to C.8; AUTHZ amendment AZ-A12 clauses 5, 9 and 14 as the delta
 * declares them), over a REAL PostgreSQL and the PRODUCTION router.
 *
 * It measures, on stored rows:
 *
 *   (4)  drill 4, gate (iii): a live owner-role holder (an editor) appoints a
 *        MANAGER in their own Group with a login session and a step-up bound to
 *        ('group.manager_appoint', the Group id); each condition flipped alone
 *        refuses with its own code; no refusal spends the token; the audit row
 *        carries standing group-owner and stepUpTokenId.
 *   (5)  drill 5, gate (i): an owner-role holder of the owning ACTIVE Group
 *        approves the Charter of a Group-owned Project with a step-up bound to
 *        ('charter.approve', the Project id), and only after the administrator
 *        test has refused; managers, inert owners and a disabled Group stay
 *        CHARTER_APPROVAL_FORBIDDEN; administrators and person owners unchanged.
 *   (6)  drill 6, gate (ii): PUT /projects/:id/owner/steward and
 *        PUT /tasks/:id/account-owner/steward move a Group-owned object OUT to
 *        an active member, with a step-up bound to ('ownership.transfer', the
 *        object id); the audit row says deciderStanding group-owner.
 *   (7)  drill 7, DD-5: the current person owner, holding the owner role in G,
 *        moves the object INTO G on the same routes.
 *   (8)  drill 8, the manager lens: A-L51 with its admin and inert negatives;
 *        A-L53 for a caller with no live row.
 *   (3)  drill 3's gate and lens legs: promotion to operator (and back), and
 *        promotion to admin or orchestrator by an admin session.
 *   Named refusals and their audit rows (round-2 repairs): two concurrent
 *        appointments of one Account never answer a raw database error (C.3,
 *        C.4); every refusal of the steward routes is audited denied (C.6);
 *        the Charter arm's refusals carry {refusal} and the standing (C.5).
 *   (10) drill 10: nothing wider than E57.
 *   (U)  U-6: the gates hold their locks against a concurrent member removal.
 *
 * DESTRUCTIVE: writes principals, groups, members, steward rows, projects,
 * tasks, charters, grants, step-up tokens and audit rows. It refuses any
 * deployment database and any non-local host, and FAILS - never skips -
 * without a disposable one.
 */

/* eslint-disable @typescript-eslint/no-var-requires */

import http from 'http';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

const TEST_DB_URL = process.env.RELAYHALL_TEST_DB_URL;
if (!TEST_DB_URL) {
  throw new Error('RELAYHALL_TEST_DB_URL is required: the owner-only gates drill measures stored steward, owner, '
    + 'Charter, step-up and audit rows, so it never skips. Load database/init.sql into a disposable database, run '
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
  throw new Error('Owner-only gates drill refuses a non-disposable database target');
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
const { groupService } = require('../services/GroupService');
const { groupStewardService } = require('../services/GroupStewardService');
const { stewardTransferStanding } = require('../services/GroupOwnerStewardTransfer');
const { MCP_TOOLS } = require('../mcp/registry');
const { insertGroupRow } = require('./support/groupRows');
const mcpRoutes = require('../mcp/httpRoute').default;
const { MCP_ROUTE_PATH } = require('../mcp/httpRoute');

jest.setTimeout(240_000);

const APPOINT_ACT = 'group.manager_appoint';
const REMOVE_ACT = 'group.manager_remove';
const CHARTER_ACT = 'charter.approve';
const TRANSFER_ACT = 'ownership.transfer';
const APPOINT_SESSION = 'GROUP_MANAGER_APPOINT_REQUIRES_SESSION';
const APPOINT_OWNER = 'GROUP_MANAGER_APPOINT_REQUIRES_OWNER';

let server: http.Server;
let origin: string;

interface Caller { label: string; principalId: string; headers: Record<string, string> }
interface Answer { status: number; json: any; text: string }

async function call(who: Caller, method: string, routePath: string, body?: unknown, extra: Record<string, string> = {}): Promise<Answer> {
  const response = await fetch(`${origin}${routePath}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...who.headers, ...extra },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let json: any = null;
  try { json = JSON.parse(text); } catch { json = null; }
  return { status: response.status, json, text };
}

const tag = (): string => crypto.randomBytes(5).toString('hex');

async function makeAccount(role: string | null, label: string, kind: 'human' | 'service' = 'human'): Promise<string> {
  const result = await pool.query(
    `INSERT INTO principals (kind, handle, display_name, status, role, purpose)
     VALUES ($1, $2, $2, 'active', $3, $4) RETURNING id`,
    [kind, `c1b-${label}-${tag()}`, role, kind === 'service' ? 'LENSES-c c1-B drill service Account' : null],
  );
  return String(result.rows[0].id);
}

async function sessionFor(label: string, principalId: string): Promise<Caller> {
  const minted = await loginSessionService.mint({ principalId });
  return { label, principalId, headers: { Cookie: `${SESSION_COOKIE_NAME}=${minted.token}` } };
}

async function person(label: string, role = 'editor'): Promise<Caller> {
  return sessionFor(label, await makeAccount(role, label));
}

/** A principal_api_key bearer HOLDING root (minted narrow, widened in raw SQL). */
async function rootBearerFor(label: string, accountId: string): Promise<Caller> {
  const created = await pool.query(
    `INSERT INTO principals (kind, handle, display_name, status, role, parent_principal_id)
     VALUES ('service', $1, $1, 'active', 'user', $2) RETURNING id`,
    [`c1b-bearer-${tag()}`, accountId],
  );
  const bearerId = String(created.rows[0].id);
  const issued = await principalService.issueCredential({
    principalId: bearerId, scopes: ['principals:read'], label, transport: 'api',
  });
  await pool.query('UPDATE principals SET parent_principal_id = NULL WHERE id = $1', [bearerId]);
  await pool.query('UPDATE principal_credentials SET scopes = $2::jsonb WHERE id = $1',
    [issued.credentialId, JSON.stringify(['root'])]);
  principalService.invalidatePrincipals([bearerId]);
  return { label, principalId: bearerId, headers: { Authorization: `Bearer ${issued.fullKey}` } };
}

/** A Connector under `owner` inheriting the owner's scopes and objects, with write scopes on its credential. */
async function connectorOf(owner: Caller): Promise<Caller> {
  const row = await pool.query(
    `INSERT INTO principals (kind, handle, display_name, status, role, parent_principal_id, purpose, own_expression)
     VALUES ('service', $1, $1, 'active', 'user', $2, 'LENSES-c c1-B drill connector', $3::jsonb) RETURNING id`,
    [`c1b-connector-${tag()}`, owner.principalId, JSON.stringify({ scopes: 'parent', objects: 'parent' })],
  );
  const id = String(row.rows[0].id);
  const credential = await principalService.issueCredential({
    principalId: id, transport: 'any',
    scopes: ['principals:read', 'projects:read', 'projects:write', 'tasks:read', 'tasks:write'],
  }, { handle: 'c1b-fixture', authMethod: 'system' });
  return { label: 'connector', principalId: id, headers: { Authorization: `Bearer ${credential.fullKey}` } };
}

async function group(label: string, featured = false): Promise<string> {
  return insertGroupRow(pool, { name: `c1b ${label} ${tag()}`, description: 'LENSES-c c1-B drill', featured });
}

async function join(groupId: string, accountId: string): Promise<void> {
  await pool.query(`INSERT INTO group_members (group_id, account_principal_id, source) VALUES ($1, $2, 'local')`,
    [groupId, accountId]);
}

async function leave(groupId: string, accountId: string): Promise<void> {
  await pool.query('DELETE FROM group_members WHERE group_id = $1 AND account_principal_id = $2', [groupId, accountId]);
}

async function steward(groupId: string, accountId: string, role: 'owner' | 'manager'): Promise<void> {
  await pool.query(
    `INSERT INTO group_stewards (group_id, account_principal_id, role, appointed_by_principal_id) VALUES ($1, $2, $3, $4)`,
    [groupId, accountId, role, ROOT.principalId],
  );
}

async function writeGrant(principalId: string, projectId: string): Promise<void> {
  await pool.query(`INSERT INTO grants (grantee_type, grantee_id, resource_type, resource_id, verb, granted_by_principal_id)
    VALUES ('principal', $1, 'project', $2, 'write', $3)`, [principalId, projectId, ROOT.principalId]);
}

async function setGroupStatus(groupId: string, status: 'active' | 'disabled'): Promise<void> {
  await pool.query(`UPDATE principals SET status = $2 WHERE id = $1 AND kind = 'group'`, [groupId, status]);
}

interface Team { G: string; owner: Caller; manager: Caller; member: Caller; outsider: Caller }

/** A Group with a live owner, a live manager, one plain member and one non-member (all editors). */
async function team(label: string): Promise<Team> {
  const G = await group(label);
  const owner = await person(`${label}-owner`);
  const manager = await person(`${label}-manager`);
  const member = await person(`${label}-member`);
  const outsider = await person(`${label}-outsider`);
  for (const id of [owner.principalId, manager.principalId, member.principalId]) await join(G, id);
  await steward(G, owner.principalId, 'owner');
  await steward(G, manager.principalId, 'manager');
  return { G, owner, manager, member, outsider };
}

async function stepUp(principalId: string, action: string, targetId: string): Promise<{ token: string; tokenId: string }> {
  const minted = await stepUpService.mint(principalId, action, targetId, 'password');
  return { token: minted.token, tokenId: minted.tokenId };
}

async function tokenLive(tokenId: string): Promise<boolean> {
  const row = await pool.query('SELECT consumed_at FROM step_up_tokens WHERE id = $1', [tokenId]);
  return row.rows.length === 1 && row.rows[0].consumed_at === null;
}

async function audits(action: string, resourceId: string, outcome: 'success' | 'denied'): Promise<any[]> {
  const rows = await pool.query(
    `SELECT metadata FROM audit_events WHERE action = $1 AND outcome = $2 AND resource_id = $3 ORDER BY occurred_at, id`,
    [action, outcome, resourceId]);
  return rows.rows.map((row: any) => row.metadata);
}

async function deniedWith(action: string, resourceId: string, refusal: string): Promise<number> {
  return (await audits(action, resourceId, 'denied')).filter((m) => m?.refusal === refusal).length;
}

async function stewardRow(groupId: string, accountId: string): Promise<any | null> {
  const row = await pool.query(
    'SELECT role, appointed_by_principal_id FROM group_stewards WHERE group_id = $1 AND account_principal_id = $2',
    [groupId, accountId]);
  return row.rows[0] ?? null;
}

const appoint = (who: Caller, groupId: string, body: Record<string, unknown>) =>
  call(who, 'POST', `/groups/${groupId}/managers`, body);

async function project(owner: string | null, label = 'project'): Promise<string> {
  const row = await pool.query(
    `INSERT INTO projects (name, status, visibility, owner_principal_id) VALUES ($1, 'active', 'private', $2) RETURNING id`,
    [`c1b ${label} ${tag()}`, owner]);
  return String(row.rows[0].id);
}

async function task(projectId: string | null, accountOwner: string | null = null): Promise<string> {
  const row = await pool.query(
    `INSERT INTO tasks (title, status, visibility, project_id, creator_principal_id, account_owner_principal_id)
     VALUES ($1, 'todo', 'private', $2, $3, $4) RETURNING id`,
    [`c1b task ${tag()}`, projectId, ROOT.principalId, accountOwner]);
  return String(row.rows[0].id);
}

async function projectOwner(projectId: string): Promise<string | null> {
  const row = await pool.query('SELECT owner_principal_id FROM projects WHERE id = $1', [projectId]);
  return row.rows[0]?.owner_principal_id ? String(row.rows[0].owner_principal_id) : null;
}

async function taskOwner(taskId: string): Promise<{ explicit: string | null; effective: string | null; updatedAt: string }> {
  const row = await pool.query(`SELECT t.account_owner_principal_id AS explicit,
      COALESCE(t.account_owner_principal_id, p.owner_principal_id) AS effective, t.updated_at::text AS updated_at
     FROM tasks t LEFT JOIN projects p ON p.id = t.project_id WHERE t.id = $1`, [taskId]);
  const r = row.rows[0];
  return { explicit: r.explicit ? String(r.explicit) : null, effective: r.effective ? String(r.effective) : null, updatedAt: String(r.updated_at) };
}

async function moveProject(who: Caller, projectId: string, ownerId: string | null, token?: string, extraBody: Record<string, unknown> = {}): Promise<Answer> {
  const revision = (await pool.query('SELECT revision FROM projects WHERE id = $1', [projectId])).rows[0].revision;
  return call(who, 'PUT', `/projects/${projectId}/owner/steward`,
    { ownerPrincipalId: ownerId, ...(token === undefined ? {} : { stepUpToken: token }), ...extraBody },
    { 'If-Match': String(revision) });
}

async function moveTask(who: Caller, taskId: string, target: string | null, token?: string): Promise<Answer> {
  const state = await taskOwner(taskId);
  return call(who, 'PUT', `/tasks/${taskId}/account-owner/steward`, {
    accountOwnerPrincipalId: target, expectedAccountOwnerPrincipalId: state.effective,
    expectedUpdatedAt: state.updatedAt, reason: 'LENSES-c c1-B drill transfer',
    ...(token === undefined ? {} : { stepUpToken: token }),
  });
}

async function approve(who: Caller, projectId: string, content: string, token?: string): Promise<Answer> {
  return call(who, 'POST', `/projects/${projectId}/charter/approve`,
    { content, ...(token === undefined ? {} : { stepUpToken: token }) });
}

async function charterContent(projectId: string): Promise<string | null> {
  const row = await pool.query('SELECT content FROM project_charters WHERE project_id = $1', [projectId]);
  return row.rows[0]?.content ?? null;
}

async function lensOf(who: Caller): Promise<Answer> {
  return call(who, 'GET', '/principals/me/lenses');
}

/** Whether some backend of this database came to wait on a lock, within 10 s, while running a statement that names `table`. */
async function lockWaiterOn(table: string): Promise<boolean> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const waiting = await pool.query(
      `SELECT count(*)::int AS n FROM pg_stat_activity
        WHERE datname = current_database() AND wait_event_type = 'Lock' AND query LIKE '%' || $1 || '%'`, [table]);
    if (waiting.rows[0].n > 0) return true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return false;
}

let ROOT: Caller;        // an admin-role login session: derives root
let OPERATOR: Caller;    // an operator-role login session: an administrator, not root
let ROOT_BEARER: Caller; // a bearer credential holding root

beforeAll(async () => {
  const app = express();
  app.use(express.json(jsonBodyOptions));
  app.use(express.urlencoded({ extended: true }));
  app.use(MCP_ROUTE_PATH, mcpRoutes);
  registerProtectedRoutes((mountPath: string, ...handlers: any[]) => {
    app.use(mountPath, authMiddleware, sharedAuthorizationMiddleware, ...handlers);
  });
  app.use(apiErrorHandler);
  await new Promise<void>((resolve) => { server = app.listen(0, '127.0.0.1', resolve); });
  origin = `http://127.0.0.1:${(server.address() as any).port}`;
  ROOT = await person('root', 'admin');
  OPERATOR = await person('operator', 'operator');
  ROOT_BEARER = await rootBearerFor('c1b-root-bearer', ROOT.principalId);
});

afterAll(async () => {
  if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  await pool.end();
});

// ═════════════════════ (4) gate (iii): an owner appoints a manager ═════════════════════

describe('(4) gate (iii) - an owner appoints a manager in their own Group', () => {
  it('admitted: a live owner (an editor) appoints a member as manager with a step-up; a live manager row appointed by the owner; audited standing group-owner with stepUpTokenId; the token is spent', async () => {
    const { G, owner, member } = await team('appoint-ok');
    const { token, tokenId } = await stepUp(owner.principalId, APPOINT_ACT, G);
    const answer = await appoint(owner, G, { accountPrincipalId: member.principalId, stepUpToken: token });
    expect(answer.status).toBe(201);
    expect(answer.json.steward).toMatchObject({
      accountPrincipalId: member.principalId, role: 'manager', appointedByPrincipalId: owner.principalId, live: true, inertReason: null,
    });
    expect(answer.json.stepUpTokenId).toBe(tokenId);
    expect(await stewardRow(G, member.principalId)).toEqual({ role: 'manager', appointed_by_principal_id: owner.principalId });
    expect(await tokenLive(tokenId)).toBe(false);
    const audit = (await audits('group.steward_appoint', G, 'success')).pop();
    expect(audit).toMatchObject({
      groupId: G, accountPrincipalId: member.principalId, role: 'manager', appointedBy: owner.principalId,
      standing: 'group-owner', stepUpTokenId: tokenId, liveAtWrite: true, via: 'rest',
    });
  });

  it('a bearer credential holding root and the owner\'s own Connector are refused GROUP_MANAGER_APPOINT_REQUIRES_SESSION, audited, nothing written, the token live', async () => {
    const { G, owner, member } = await team('appoint-bearer');
    const { token, tokenId } = await stepUp(owner.principalId, APPOINT_ACT, G);
    for (const who of [ROOT_BEARER, await connectorOf(owner)]) {
      const refused = await appoint(who, G, { accountPrincipalId: member.principalId, stepUpToken: token });
      expect({ who: who.label, status: refused.status, code: refused.json?.code })
        .toEqual({ who: who.label, status: 403, code: APPOINT_SESSION });
    }
    expect(await deniedWith('group.steward_appoint', G, APPOINT_SESSION)).toBe(2);
    expect(await stewardRow(G, member.principalId)).toBeNull();
    expect(await tokenLive(tokenId)).toBe(true);
  });

  it('a manager caller, an owner of another Group, a plain member and an admin or operator session holding no owner row are refused GROUP_MANAGER_APPOINT_REQUIRES_OWNER, the token live', async () => {
    const { G, manager, member, outsider } = await team('appoint-not-owner');
    const other = await team('appoint-other-group');
    for (const who of [manager, other.owner, member, ROOT, OPERATOR]) {
      const { token, tokenId } = await stepUp(who.principalId, APPOINT_ACT, G);
      const refused = await appoint(who, G, { accountPrincipalId: outsider.principalId, stepUpToken: token });
      expect({ who: who.label, status: refused.status, code: refused.json?.code, live: await tokenLive(tokenId) })
        .toEqual({ who: who.label, status: 403, code: APPOINT_OWNER, live: true });
    }
    expect(await deniedWith('group.steward_appoint', G, APPOINT_OWNER)).toBe(5);
    expect((await audits('group.steward_appoint', G, 'denied'))[0]).toMatchObject({ standing: 'group-owner' });
  });

  it('an inert owner (left the Group) is refused GROUP_MANAGER_APPOINT_REQUIRES_OWNER; back in the Group, the same owner appoints', async () => {
    const { G, owner, member } = await team('appoint-inert');
    await leave(G, owner.principalId);
    const first = await stepUp(owner.principalId, APPOINT_ACT, G);
    const refused = await appoint(owner, G, { accountPrincipalId: member.principalId, stepUpToken: first.token });
    expect([refused.status, refused.json?.code]).toEqual([403, APPOINT_OWNER]);
    expect(await tokenLive(first.tokenId)).toBe(true);
    await join(G, owner.principalId);
    const admitted = await appoint(owner, G, { accountPrincipalId: member.principalId, stepUpToken: first.token });
    expect(admitted.status).toBe(201);
  });

  it('an appointee who is not an active member - an outsider, a disabled member, an absent principal - is MANAGER_NOT_A_GROUP_MEMBER, the token live', async () => {
    const { G, owner, outsider } = await team('appoint-nonmember');
    const disabled = await makeAccount('editor', 'appoint-disabled');
    await join(G, disabled);
    await pool.query(`UPDATE principals SET status = 'disabled' WHERE id = $1`, [disabled]);
    const { token, tokenId } = await stepUp(owner.principalId, APPOINT_ACT, G);
    for (const target of [outsider.principalId, disabled, crypto.randomUUID()]) {
      const refused = await appoint(owner, G, { accountPrincipalId: target, stepUpToken: token });
      expect({ target, status: refused.status, code: refused.json?.code })
        .toEqual({ target, status: 422, code: 'MANAGER_NOT_A_GROUP_MEMBER' });
    }
    expect(await tokenLive(tokenId)).toBe(true);
  });

  it('an appointee who already holds a role - a manager, another owner, the caller - is ALREADY_A_STEWARD naming the role', async () => {
    const { G, owner, manager } = await team('appoint-already');
    const coOwner = await person('appoint-co-owner');
    await join(G, coOwner.principalId);
    await steward(G, coOwner.principalId, 'owner');
    const { token, tokenId } = await stepUp(owner.principalId, APPOINT_ACT, G);
    for (const [target, role] of [[manager.principalId, 'manager'], [coOwner.principalId, 'owner'], [owner.principalId, 'owner']]) {
      const refused = await appoint(owner, G, { accountPrincipalId: target, stepUpToken: token });
      expect({ target, status: refused.status, code: refused.json?.code, role: refused.json?.details?.role })
        .toEqual({ target, status: 409, code: 'ALREADY_A_STEWARD', role });
    }
    expect(await tokenLive(tokenId)).toBe(true);
  });

  it('two concurrent appointments of one Account never answer a raw 500: the one that commits second is ALREADY_A_STEWARD naming the role, audited, its token live', async () => {
    const { G, owner, member } = await team('appoint-race');
    const coOwner = await person('appoint-race-co-owner');
    await join(G, coOwner.principalId);
    await steward(G, coOwner.principalId, 'owner');
    // A forced interleaving: B passes every check, then waits on its own token
    // row (held here), while C appoints the same member and commits.
    const b = await stepUp(owner.principalId, APPOINT_ACT, G);
    const c = await stepUp(coOwner.principalId, APPOINT_ACT, G);
    const holder = await pool.connect();
    let late: Answer | undefined;
    try {
      await holder.query('BEGIN');
      await holder.query('SELECT 1 FROM step_up_tokens WHERE id = $1 FOR UPDATE', [b.tokenId]);
      const pending = appoint(owner, G, { accountPrincipalId: member.principalId, stepUpToken: b.token });
      expect(await lockWaiterOn('step_up_tokens')).toBe(true);
      const first = await appoint(coOwner, G, { accountPrincipalId: member.principalId, stepUpToken: c.token });
      expect(first.status).toBe(201);
      await holder.query('COMMIT');
      late = await pending;
    } finally {
      await holder.query('ROLLBACK').catch(() => undefined);
      holder.release();
    }
    expect({ status: late?.status, code: late?.json?.code, role: late?.json?.details?.role })
      .toEqual({ status: 409, code: 'ALREADY_A_STEWARD', role: 'manager' });
    expect(await tokenLive(b.tokenId)).toBe(true);
    expect(await tokenLive(c.tokenId)).toBe(false);
    expect(await deniedWith('group.steward_appoint', G, 'ALREADY_A_STEWARD')).toBe(1);
    expect(await stewardRow(G, member.principalId)).toEqual({ role: 'manager', appointed_by_principal_id: coOwner.principalId });
    // An unforced race of both owners over one more member: one 201, one named 409, never a 500.
    const second = await person('appoint-race-second');
    await join(G, second.principalId);
    const tokens = [await stepUp(owner.principalId, APPOINT_ACT, G), await stepUp(coOwner.principalId, APPOINT_ACT, G)];
    const answers = await Promise.all([owner, coOwner].map((who, index) =>
      appoint(who, G, { accountPrincipalId: second.principalId, stepUpToken: tokens[index].token })));
    expect(answers.map((answer) => answer.status).sort()).toEqual([201, 409]);
    expect(answers.find((answer) => answer.status === 409)?.json?.code).toBe('ALREADY_A_STEWARD');
  });

  it('an ineligible member appointee - a legacy identity, an operator - is STEWARD_INELIGIBLE with its reason; a service Account member is admitted', async () => {
    const { G, owner } = await team('appoint-ineligible');
    const legacy = await makeAccount('editor', 'appoint-legacy');
    await pool.query('UPDATE principals SET legacy_identity = true WHERE id = $1', [legacy]);
    const operator = await makeAccount('operator', 'appoint-operator');
    const service = await makeAccount(null, 'appoint-service', 'service');
    for (const id of [legacy, operator, service]) await join(G, id);
    const { token, tokenId } = await stepUp(owner.principalId, APPOINT_ACT, G);
    for (const [target, reason] of [[legacy, 'legacy'], [operator, 'elevated_role']]) {
      const refused = await appoint(owner, G, { accountPrincipalId: target, stepUpToken: token });
      expect({ status: refused.status, code: refused.json?.code, reason: refused.json?.details?.reason })
        .toEqual({ status: 422, code: 'STEWARD_INELIGIBLE', reason });
    }
    expect(await tokenLive(tokenId)).toBe(true);
    // The service checks the holder rules BEFORE the step-up (the 152 trigger is
    // only the backstop): with no token at all the answer is still the rule's.
    const tokenless = await appoint(owner, G, { accountPrincipalId: legacy });
    expect([tokenless.status, tokenless.json?.code, tokenless.json?.details?.reason]).toEqual([422, 'STEWARD_INELIGIBLE', 'legacy']);
    const admitted = await appoint(owner, G, { accountPrincipalId: service, stepUpToken: token });
    expect(admitted.status).toBe(201);
    expect(await stewardRow(G, service)).toMatchObject({ role: 'manager' });
  });

  it('a body role key is refused UNKNOWN_FIELD and audited, so the route never writes an owner; the token stays live', async () => {
    const { G, owner, member } = await team('appoint-role-key');
    const { token, tokenId } = await stepUp(owner.principalId, APPOINT_ACT, G);
    for (const role of ['owner', 'manager']) {
      const refused = await appoint(owner, G, { accountPrincipalId: member.principalId, role, stepUpToken: token });
      expect([refused.status, refused.json?.code]).toEqual([400, 'UNKNOWN_FIELD']);
    }
    expect(await deniedWith('group.steward_appoint', G, 'UNKNOWN_FIELD')).toBe(2);
    expect(await stewardRow(G, member.principalId)).toBeNull();
    expect(await tokenLive(tokenId)).toBe(true);
  });

  it('a missing, replayed, other-Group or removal-bound token is STEP_UP_REQUIRED with the SU-14 challenge, and nothing is written', async () => {
    const { G, owner, member } = await team('appoint-tokens');
    const other = await group('appoint-tokens-other');
    const missing = await appoint(owner, G, { accountPrincipalId: member.principalId });
    expect([missing.status, missing.json?.code]).toEqual([403, 'STEP_UP_REQUIRED']);
    expect(missing.json?.stepUp).toMatchObject({ error: 'insufficient_user_authentication', action: APPOINT_ACT, targetId: G });
    for (const [action, target] of [[APPOINT_ACT, other], [REMOVE_ACT, G]]) {
      const { token, tokenId } = await stepUp(owner.principalId, action, target);
      const refused = await appoint(owner, G, { accountPrincipalId: member.principalId, stepUpToken: token });
      expect({ action, status: refused.status, code: refused.json?.code }).toEqual({ action, status: 403, code: 'STEP_UP_REQUIRED' });
      expect(await tokenLive(tokenId)).toBe(true);
    }
    const spent = await stepUp(owner.principalId, APPOINT_ACT, G);
    expect((await appoint(owner, G, { accountPrincipalId: member.principalId, stepUpToken: spent.token })).status).toBe(201);
    const second = await person('appoint-tokens-second');
    await join(G, second.principalId);
    const replay = await appoint(owner, G, { accountPrincipalId: second.principalId, stepUpToken: spent.token });
    expect([replay.status, replay.json?.code]).toEqual([403, 'STEP_UP_REQUIRED']);
    expect(await stewardRow(G, second.principalId)).toBeNull();
  });

  it('no refusal spends the token: ONE token survives a body refusal, a non-member, an already-steward and an ineligible appointee, then appoints', async () => {
    const { G, owner, manager, member, outsider } = await team('appoint-survives');
    const operator = await makeAccount('operator', 'appoint-survives-operator');
    await join(G, operator);
    const { token, tokenId } = await stepUp(owner.principalId, APPOINT_ACT, G);
    expect((await appoint(owner, G, { accountPrincipalId: member.principalId, role: 'manager', stepUpToken: token })).status).toBe(400);
    expect((await appoint(owner, G, { accountPrincipalId: outsider.principalId, stepUpToken: token })).status).toBe(422);
    expect((await appoint(owner, G, { accountPrincipalId: manager.principalId, stepUpToken: token })).status).toBe(409);
    expect((await appoint(owner, G, { accountPrincipalId: operator, stepUpToken: token })).status).toBe(422);
    expect(await tokenLive(tokenId)).toBe(true);
    expect((await appoint(owner, G, { accountPrincipalId: member.principalId, stepUpToken: token })).status).toBe(201);
    expect(await tokenLive(tokenId)).toBe(false);
  });

  it('a step-up is answered after the appointee: an absent appointee with no token is MANAGER_NOT_A_GROUP_MEMBER, never STEP_UP_REQUIRED', async () => {
    const { G, owner, manager, outsider } = await team('appoint-order');
    expect((await appoint(owner, G, { accountPrincipalId: outsider.principalId })).json?.code).toBe('MANAGER_NOT_A_GROUP_MEMBER');
    expect((await appoint(owner, G, { accountPrincipalId: manager.principalId, stepUpToken: 'rhsu_not-a-token' })).json?.code)
      .toBe('ALREADY_A_STEWARD');
  });

  it('an uppercase Group id appoints with a token minted for the lowercase id; a non-UUID Group id is 400 before anything', async () => {
    const { G, owner, member } = await team('appoint-upper');
    const { token } = await stepUp(owner.principalId, APPOINT_ACT, G);
    const answer = await appoint(owner, G.toUpperCase(), { accountPrincipalId: member.principalId.toUpperCase(), stepUpToken: token });
    expect(answer.status).toBe(201);
    expect(await stewardRow(G, member.principalId)).toMatchObject({ role: 'manager' });
    const bad = await appoint(owner, 'not-a-group', { accountPrincipalId: member.principalId, stepUpToken: token });
    expect(bad.status).toBe(400);
  });
});

// ═════════════════════ (5) gate (i): Charter approve on a Group-owned Project ═════════════════════

describe('(5) gate (i) - Charter approve on a Group-owned Project', () => {
  it('admitted: an owner-role holder (an editor) approves the Charter of a Group-owned project with a step-up; audited standing group-owner with owningGroupId and stepUpTokenId; the token is spent', async () => {
    const { G, owner } = await team('charter-ok');
    const P = await project(G, 'charter-ok');
    const { token, tokenId } = await stepUp(owner.principalId, CHARTER_ACT, P);
    const answer = await approve(owner, P, 'c1-B Charter v1', token);
    expect(answer.status).toBe(201);
    expect(await charterContent(P)).toBe('c1-B Charter v1');
    expect(await tokenLive(tokenId)).toBe(false);
    const audit = (await audits(CHARTER_ACT, P, 'success')).pop();
    expect(audit).toMatchObject({ projectId: P, owningGroupId: G, standing: 'group-owner', stepUpTokenId: tokenId, charterVersion: 1 });
  });

  it('without a step-up, or with one bound to another project or another act, the owner-role holder is STEP_UP_REQUIRED with the SU-14 challenge; nothing written; audited denied with the refusal', async () => {
    const { G, owner } = await team('charter-tokens');
    const P = await project(G, 'charter-tokens');
    const Q = await project(G, 'charter-tokens-other');
    const missing = await approve(owner, P, 'c1-B Charter');
    expect([missing.status, missing.json?.code]).toEqual([403, 'STEP_UP_REQUIRED']);
    expect(missing.json?.stepUp).toMatchObject({ action: CHARTER_ACT, targetId: P });
    for (const [action, target] of [[CHARTER_ACT, Q], [TRANSFER_ACT, P]]) {
      const { token, tokenId } = await stepUp(owner.principalId, action, target);
      const refused = await approve(owner, P, 'c1-B Charter', token);
      expect({ action, status: refused.status, code: refused.json?.code }).toEqual({ action, status: 403, code: 'STEP_UP_REQUIRED' });
      expect(await tokenLive(tokenId)).toBe(true);
    }
    expect(await charterContent(P)).toBeNull();
    const denied = await audits(CHARTER_ACT, P, 'denied');
    expect(denied.filter((m) => m?.refusal === 'STEP_UP_REQUIRED' && m?.standing === 'group-owner')).toHaveLength(3);
  });

  it('a manager is CHARTER_APPROVAL_FORBIDDEN, and a presented token stays live', async () => {
    const { G, manager } = await team('charter-manager');
    const P = await project(G, 'charter-manager');
    const asManager = await stepUp(manager.principalId, CHARTER_ACT, P);
    const refusedManager = await approve(manager, P, 'c1-B Charter', asManager.token);
    expect([refusedManager.status, refusedManager.json?.code]).toEqual([403, 'CHARTER_APPROVAL_FORBIDDEN']);
    expect(await tokenLive(asManager.tokenId)).toBe(true);
    expect(await charterContent(P)).toBeNull();
  });

  // The inert owner and the disabled Group keep write through a direct grant,
  // so the request reaches the gate and the gate's own liveness is measured.
  it('an inert owner (left the Group) holding write another way is CHARTER_APPROVAL_FORBIDDEN, and a presented token stays live', async () => {
    const inert = await team('charter-inert');
    const PI = await project(inert.G, 'charter-inert');
    await writeGrant(inert.owner.principalId, PI);
    await leave(inert.G, inert.owner.principalId);
    const asInert = await stepUp(inert.owner.principalId, CHARTER_ACT, PI);
    const refusedInert = await approve(inert.owner, PI, 'c1-B Charter', asInert.token);
    expect([refusedInert.status, refusedInert.json?.code]).toEqual([403, 'CHARTER_APPROVAL_FORBIDDEN']);
    expect(await tokenLive(asInert.tokenId)).toBe(true);
    expect(await charterContent(PI)).toBeNull();
  });

  it('an owner under a disabled Group principal holding write another way is CHARTER_APPROVAL_FORBIDDEN, and a presented token stays live', async () => {
    const { G, owner } = await team('charter-disabled');
    const P = await project(G, 'charter-disabled');
    await writeGrant(owner.principalId, P);
    await setGroupStatus(G, 'disabled');
    try {
      const asOwner = await stepUp(owner.principalId, CHARTER_ACT, P);
      const refusedDisabled = await approve(owner, P, 'c1-B Charter', asOwner.token);
      expect([refusedDisabled.status, refusedDisabled.json?.code]).toEqual([403, 'CHARTER_APPROVAL_FORBIDDEN']);
      expect(await tokenLive(asOwner.tokenId)).toBe(true);
    } finally {
      await setGroupStatus(G, 'active');
    }
    expect(await charterContent(P)).toBeNull();
  });

  it('an inert owner with no other path is concealed (404): the project is not readable through the Group at all', async () => {
    const { G, owner } = await team('charter-concealed');
    const P = await project(G, 'charter-concealed');
    await leave(G, owner.principalId);
    const { token, tokenId } = await stepUp(owner.principalId, CHARTER_ACT, P);
    expect((await approve(owner, P, 'c1-B Charter', token)).status).toBe(404);
    expect(await tokenLive(tokenId)).toBe(true);
  });

  it('a viewer-role owner-role holder is refused before the gate (no write tier), and the token stays live', async () => {
    const G = await group('charter-viewer');
    const viewer = await person('charter-viewer', 'viewer');
    await join(G, viewer.principalId);
    await steward(G, viewer.principalId, 'owner');
    const P = await project(G, 'charter-viewer');
    const { token, tokenId } = await stepUp(viewer.principalId, CHARTER_ACT, P);
    const refused = await approve(viewer, P, 'c1-B Charter', token);
    expect(refused.status).toBe(403);
    expect(await tokenLive(tokenId)).toBe(true);
    expect(await charterContent(P)).toBeNull();
  });

  it("the arm's own refusals - a manager, an inert owner, a disabled Group - are audited denied with the refusal, owningGroupId and the group-owner standing; a person-owned refusal keeps today's row", async () => {
    const { G, owner, manager } = await team('charter-arm-audit');
    const asManager = await project(G, 'charter-arm-audit-manager');
    expect((await approve(manager, asManager, 'c1-B', (await stepUp(manager.principalId, CHARTER_ACT, asManager)).token)).json?.code)
      .toBe('CHARTER_APPROVAL_FORBIDDEN');
    const disabled = await project(G, 'charter-arm-audit-disabled');
    await writeGrant(owner.principalId, disabled);
    await setGroupStatus(G, 'disabled');
    try {
      expect((await approve(owner, disabled, 'c1-B', (await stepUp(owner.principalId, CHARTER_ACT, disabled)).token)).json?.code)
        .toBe('CHARTER_APPROVAL_FORBIDDEN');
    } finally {
      await setGroupStatus(G, 'active');
    }
    const inert = await project(G, 'charter-arm-audit-inert');
    await writeGrant(owner.principalId, inert);
    await leave(G, owner.principalId);
    expect((await approve(owner, inert, 'c1-B', (await stepUp(owner.principalId, CHARTER_ACT, inert)).token)).json?.code)
      .toBe('CHARTER_APPROVAL_FORBIDDEN');
    for (const P of [asManager, disabled, inert]) {
      expect({ P, rows: await audits(CHARTER_ACT, P, 'denied') }).toEqual({ P, rows: [expect.objectContaining({
        refusal: 'CHARTER_APPROVAL_FORBIDDEN', projectId: P, owningGroupId: G, standing: 'group-owner',
      })] });
    }
    // Both directions: on a person-owned Project the arm never applied, and the row is today's.
    const someone = await person('charter-arm-audit-person');
    const theirs = await project(someone.principalId, 'charter-arm-audit-person');
    await writeGrant(owner.principalId, theirs);
    expect((await approve(owner, theirs, 'c1-B')).json?.code).toBe('CHARTER_APPROVAL_FORBIDDEN');
    expect(await audits(CHARTER_ACT, theirs, 'denied')).toEqual([{ charterVersion: null, sha: null, previousVersion: null }]);
  });

  it('a refusal after the arm admitted (no If-Match on an existing Charter) is still the arm\'s denied row, with the refusal and the standing; the token stays live', async () => {
    const { G, owner } = await team('charter-after-arm');
    const P = await project(G, 'charter-after-arm');
    expect((await approve(owner, P, 'c1-B v1', (await stepUp(owner.principalId, CHARTER_ACT, P)).token)).status).toBe(201);
    const { token, tokenId } = await stepUp(owner.principalId, CHARTER_ACT, P);
    const refused = await approve(owner, P, 'c1-B v2', token);
    expect([refused.status, refused.json?.code]).toEqual([400, 'REVISION_REQUIRED']);
    expect(await tokenLive(tokenId)).toBe(true);
    expect(await charterContent(P)).toBe('c1-B v1');
    expect(await audits(CHARTER_ACT, P, 'denied')).toEqual([expect.objectContaining({
      refusal: 'REVISION_REQUIRED', projectId: P, owningGroupId: G, standing: 'group-owner',
    })]);
  });

  it('an administrator approves a Group-owned project without a step-up, unchanged, and its audit row carries no group-owner standing', async () => {
    const { G } = await team('charter-admin');
    const P = await project(G, 'charter-admin');
    const answer = await approve(ROOT, P, 'c1-B Charter by root');
    expect(answer.status).toBe(201);
    const audit = (await audits(CHARTER_ACT, P, 'success')).pop();
    expect(audit).toEqual({ charterVersion: 1, sha: expect.any(String), previousVersion: null });
  });

  it('on a person-owned project the person owner approves without a step-up, unchanged', async () => {
    const owner = await person('charter-person');
    const P = await project(owner.principalId, 'charter-person');
    const answer = await approve(owner, P, 'c1-B person Charter');
    expect(answer.status).toBe(201);
    expect((await audits(CHARTER_ACT, P, 'success')).pop()).toEqual({ charterVersion: 1, sha: expect.any(String), previousVersion: null });
  });

});

// ═════════════════════ (6) gate (ii): Group -> member ═════════════════════

describe('(6) gate (ii) - an owner moves a Group-owned object out to a member', () => {
  it('admitted: a live owner moves a Group-owned project to an active member with a step-up; audited deciderStanding group-owner; grants preserved; the token is spent', async () => {
    const { G, owner, member } = await team('out-project');
    const P = await project(G, 'out-project');
    await pool.query(`INSERT INTO grants (grantee_type, grantee_id, resource_type, resource_id, verb, granted_by_principal_id)
      VALUES ('group', $1, 'project', $2, 'read', $3)`, [G, P, ROOT.principalId]);
    const before = (await pool.query('SELECT count(*)::int AS n FROM grants WHERE resource_id = $1', [P])).rows[0].n;
    const { token, tokenId } = await stepUp(owner.principalId, TRANSFER_ACT, P);
    const answer = await moveProject(owner, P, member.principalId, token);
    expect(answer.status).toBe(200);
    expect(await projectOwner(P)).toBe(member.principalId);
    expect(await tokenLive(tokenId)).toBe(false);
    expect((await pool.query('SELECT count(*)::int AS n FROM grants WHERE resource_id = $1', [P])).rows[0].n).toBe(before);
    const audit = (await audits('project.owner.change', P, 'success')).pop();
    expect(audit).toMatchObject({
      oldOwnerPrincipalId: G, newOwnerPrincipalId: member.principalId, oldOwnerKind: 'group', newOwnerKind: 'human',
      deciderStanding: 'group-owner', stepUpTokenId: tokenId, groupMemberCountAtTransfer: 3,
    });
  });

  it('admitted for a task: a NULL-explicit task inheriting the Group owner is moved to a member, who is pinned as the explicit owner', async () => {
    const { G, owner, member } = await team('out-task');
    const P = await project(G, 'out-task');
    const T = await task(P, null);
    const { token, tokenId } = await stepUp(owner.principalId, TRANSFER_ACT, T);
    const answer = await moveTask(owner, T, member.principalId, token);
    expect(answer.status).toBe(200);
    expect(await taskOwner(T)).toMatchObject({ explicit: member.principalId, effective: member.principalId });
    expect(await tokenLive(tokenId)).toBe(false);
    expect((await audits('task.account_owner.change', T, 'success')).pop()).toMatchObject({
      oldAccountOwnerPrincipalId: G, newAccountOwnerPrincipalId: member.principalId, deciderStanding: 'group-owner', stepUpTokenId: tokenId,
    });
  });

  it('a target who is not a member of the Group is TARGET_NOT_A_GROUP_MEMBER, audited, the token live', async () => {
    const { G, owner, outsider } = await team('out-nonmember');
    const P = await project(G, 'out-nonmember');
    const { token, tokenId } = await stepUp(owner.principalId, TRANSFER_ACT, P);
    const refused = await moveProject(owner, P, outsider.principalId, token);
    expect([refused.status, refused.json?.code]).toEqual([422, 'TARGET_NOT_A_GROUP_MEMBER']);
    expect(await deniedWith('project.owner.change', P, 'TARGET_NOT_A_GROUP_MEMBER')).toBe(1);
    expect(await tokenLive(tokenId)).toBe(true);
    expect(await projectOwner(P)).toBe(G);
  });

  it('a manager caller, an inert owner and an owner of a disabled Group (both holding write another way) are refused GROUP_OWNER_ROLE_REQUIRED, the token live', async () => {
    const { G, owner, manager, member } = await team('out-not-owner');
    const P = await project(G, 'out-not-owner');
    const T = await task(P, G);
    for (const [object, move] of [[P, (t: string) => moveProject(manager, P, member.principalId, t)], [T, (t: string) => moveTask(manager, T, member.principalId, t)]] as const) {
      const { token, tokenId } = await stepUp(manager.principalId, TRANSFER_ACT, object);
      const refused = await move(token);
      expect({ object, status: refused.status, code: refused.json?.code, live: await tokenLive(tokenId) })
        .toEqual({ object, status: 403, code: 'GROUP_OWNER_ROLE_REQUIRED', live: true });
    }
    await writeGrant(owner.principalId, P);
    await setGroupStatus(G, 'disabled');
    try {
      const { token, tokenId } = await stepUp(owner.principalId, TRANSFER_ACT, P);
      const disabled = await moveProject(owner, P, member.principalId, token);
      expect([disabled.status, disabled.json?.code, await tokenLive(tokenId)]).toEqual([403, 'GROUP_OWNER_ROLE_REQUIRED', true]);
    } finally {
      await setGroupStatus(G, 'active');
    }
    await leave(G, owner.principalId);
    const { token, tokenId } = await stepUp(owner.principalId, TRANSFER_ACT, P);
    const inert = await moveProject(owner, P, member.principalId, token);
    expect([inert.status, inert.json?.code, await tokenLive(tokenId)]).toEqual([403, 'GROUP_OWNER_ROLE_REQUIRED', true]);
    expect(await deniedWith('project.owner.change', P, 'GROUP_OWNER_ROLE_REQUIRED')).toBe(3);
    expect(await projectOwner(P)).toBe(G);
  });

  it('a person-to-person move, a Group-to-Group move and a clear are STEWARD_TRANSFER_SHAPE_REFUSED', async () => {
    const { G, owner, member } = await team('out-shape');
    const H = await group('out-shape-other');
    await join(H, owner.principalId);
    await steward(H, owner.principalId, 'owner');
    const P = await project(G, 'out-shape');
    const mine = await project(owner.principalId, 'out-shape-mine');
    const cases: Array<[string, () => Promise<Answer>]> = [
      ['person-to-person', async () => moveProject(owner, mine, member.principalId, (await stepUp(owner.principalId, TRANSFER_ACT, mine)).token)],
      ['group-to-group', async () => moveProject(owner, P, H, (await stepUp(owner.principalId, TRANSFER_ACT, P)).token)],
      ['clear', async () => moveProject(owner, P, null, (await stepUp(owner.principalId, TRANSFER_ACT, P)).token)],
    ];
    for (const [shape, run] of cases) {
      const refused = await run();
      expect({ shape, status: refused.status, code: refused.json?.code }).toEqual({ shape, status: 422, code: 'STEWARD_TRANSFER_SHAPE_REFUSED' });
    }
    expect(await projectOwner(P)).toBe(G);
    expect(await projectOwner(mine)).toBe(owner.principalId);
  });

  it("the owner's own Connector and a Main-appointed Connector are refused GROUP_OWNER_SESSION_ONLY, the token live", async () => {
    const { G, owner } = await team('out-bearer');
    // The person owner's Project (the DD-5 shape): its Connectors reach it
    // through the owner arm, so the request reaches the gate's step 1.
    const P = await project(owner.principalId, 'out-bearer');
    const own = await connectorOf(owner);
    const main = await connectorOf(owner);
    await pool.query('UPDATE principals SET owner_control_account_id = $2 WHERE id = $1', [main.principalId, owner.principalId]);
    const { token, tokenId } = await stepUp(owner.principalId, TRANSFER_ACT, P);
    for (const who of [own, main]) {
      const refused = await moveProject(who, P, G, token);
      expect({ who: who.label, status: refused.status, code: refused.json?.code })
        .toEqual({ who: who.label, status: 403, code: 'GROUP_OWNER_SESSION_ONLY' });
    }
    expect(await deniedWith('project.owner.change', P, 'GROUP_OWNER_SESSION_ONLY')).toBe(2);
    expect(await tokenLive(tokenId)).toBe(true);
    expect(await projectOwner(P)).toBe(owner.principalId);
  });

  it('a missing or foreign-object step-up is STEP_UP_REQUIRED with the challenge; the owner is unchanged', async () => {
    const { G, owner, member } = await team('out-tokens');
    const P = await project(G, 'out-tokens');
    const missing = await moveProject(owner, P, member.principalId);
    expect([missing.status, missing.json?.code]).toEqual([403, 'STEP_UP_REQUIRED']);
    expect(missing.json?.stepUp).toMatchObject({ action: TRANSFER_ACT, targetId: P });
    const foreign = await stepUp(owner.principalId, TRANSFER_ACT, crypto.randomUUID());
    const refused = await moveProject(owner, P, member.principalId, foreign.token);
    expect([refused.status, refused.json?.code]).toEqual([403, 'STEP_UP_REQUIRED']);
    expect(await tokenLive(foreign.tokenId)).toBe(true);
    expect(await projectOwner(P)).toBe(G);
  });

  it('a stale If-Match revision is refused before the step-up is spent', async () => {
    const { G, owner, member } = await team('out-revision');
    const P = await project(G, 'out-revision');
    const { token, tokenId } = await stepUp(owner.principalId, TRANSFER_ACT, P);
    const refused = await call(owner, 'PUT', `/projects/${P}/owner/steward`,
      { ownerPrincipalId: member.principalId, stepUpToken: token }, { 'If-Match': crypto.randomUUID() });
    expect([refused.status, refused.json?.code]).toEqual([412, 'REVISION_MISMATCH']);
    expect(await tokenLive(tokenId)).toBe(true);
  });

  it("every refusal of the project steward route is audited denied with its code and the group-owner standing - the route's query and body, the act's target, revision and person-target checks - and no token is spent", async () => {
    const { G, owner, member } = await team('audit-project');
    const service = await makeAccount(null, 'audit-project-service', 'service');
    const viewer = await makeAccount('viewer', 'audit-project-viewer');
    for (const id of [service, viewer]) await join(G, id);
    const cases: Array<[string, number, (P: string, token: string) => Promise<Answer>]> = [
      ['UNKNOWN_FIELD', 400, async (P, token) => {
        const revision = (await pool.query('SELECT revision FROM projects WHERE id = $1', [P])).rows[0].revision;
        return call(owner, 'PUT', `/projects/${P}/owner/steward?force=1`, { ownerPrincipalId: member.principalId, stepUpToken: token },
          { 'If-Match': String(revision) });
      }],
      ['INVALID_OWNER', 422, (P, token) => moveProject(owner, P, member.principalId, token, { reason: 'not a key here' })],
      ['INVALID_OWNER', 422, (P, token) => moveProject(owner, P, 'not-a-uuid', token)],
      ['INVALID_OWNER', 422, (P, token) => moveProject(owner, P, service, token)],
      ['INEFFECTIVE_OWNER', 422, (P, token) => moveProject(owner, P, viewer, token)],
      ['REVISION_REQUIRED', 400, (P, token) => call(owner, 'PUT', `/projects/${P}/owner/steward`,
        { ownerPrincipalId: member.principalId, stepUpToken: token })],
      ['REVISION_MISMATCH', 412, (P, token) => call(owner, 'PUT', `/projects/${P}/owner/steward`,
        { ownerPrincipalId: member.principalId, stepUpToken: token }, { 'If-Match': crypto.randomUUID() })],
    ];
    for (const [code, status, run] of cases) {
      const P = await project(G, `audit-project-${code}`);
      const { token, tokenId } = await stepUp(owner.principalId, TRANSFER_ACT, P);
      const refused = await run(P, token);
      const denied = await audits('project.owner.change', P, 'denied');
      expect({ code, status: refused.status, answered: refused.json?.code, live: await tokenLive(tokenId), owner: await projectOwner(P),
        denied: denied.map((m) => [m?.refusal, m?.standing, m?.clause]) })
        .toEqual({ code, status, answered: code, live: true, owner: G, denied: [[code, 'group-owner', 'LENSES-c C.6']] });
    }
  });

  it("every refusal of the task steward route is audited denied with its code and the group-owner standing - the route's body, the act's malformed change, person-target and state checks - and no token is spent", async () => {
    const { G, owner, member } = await team('audit-task');
    const service = await makeAccount(null, 'audit-task-service', 'service');
    await join(G, service);
    const P = await project(G, 'audit-task');
    const put = async (T: string, body: Record<string, unknown>) => call(owner, 'PUT', `/tasks/${T}/account-owner/steward`, body);
    const fields = async (T: string, target: string, token: string) => {
      const state = await taskOwner(T);
      return { accountOwnerPrincipalId: target, expectedAccountOwnerPrincipalId: state.effective,
        expectedUpdatedAt: state.updatedAt, reason: 'LENSES-c c1-B audit drill', stepUpToken: token };
    };
    const cases: Array<[string, number, (T: string, token: string) => Promise<Answer>]> = [
      ['INVALID_ACCOUNT_OWNER_CHANGE', 422, async (T, token) => put(T, { ...(await fields(T, member.principalId, token)), force: true })],
      ['INVALID_ACCOUNT_OWNER_CHANGE', 422, async (T, token) => put(T, { ...(await fields(T, member.principalId, token)), reason: '   ' })],
      ['INVALID_ACCOUNT_OWNER', 422, async (T, token) => put(T, await fields(T, service, token))],
      ['ACCOUNT_OWNER_STATE_CHANGED', 412, async (T, token) => put(T, { ...(await fields(T, member.principalId, token)),
        expectedUpdatedAt: '2001-01-01 00:00:00+00' })],
    ];
    for (const [code, status, run] of cases) {
      const T = await task(P, null);
      const { token, tokenId } = await stepUp(owner.principalId, TRANSFER_ACT, T);
      const refused = await run(T, token);
      const denied = await audits('task.account_owner.change', T, 'denied');
      expect({ code, status: refused.status, answered: refused.json?.code, live: await tokenLive(tokenId), owner: (await taskOwner(T)).effective,
        denied: denied.map((m) => [m?.refusal, m?.standing, m?.clause]) })
        .toEqual({ code, status, answered: code, live: true, owner: G, denied: [[code, 'group-owner', 'LENSES-c C.6']] });
    }
  });

  it('the existing administrator route still serves root and administrators: an operator session moves the project back into the Group through PUT /projects/:id/owner', async () => {
    const { G, owner, member } = await team('out-admin-route');
    const P = await project(G, 'out-admin-route');
    expect((await moveProject(owner, P, member.principalId, (await stepUp(owner.principalId, TRANSFER_ACT, P)).token)).status).toBe(200);
    const revision = (await pool.query('SELECT revision FROM projects WHERE id = $1', [P])).rows[0].revision;
    const back = await call(OPERATOR, 'PUT', `/projects/${P}/owner`,
      { ownerPrincipalId: G, stepUpToken: (await stepUp(OPERATOR.principalId, TRANSFER_ACT, P)).token }, { 'If-Match': String(revision) });
    expect(back.status).toBe(200);
    expect(await projectOwner(P)).toBe(G);
    expect((await audits('project.owner.change', P, 'success')).pop()).toMatchObject({ deciderStanding: 'administrator' });
  });

  it('the steward route is not the administrator route: an editor owner-role holder is refused PUT /projects/:id/owner, and the steward route admits the same act', async () => {
    const { G, owner, member } = await team('out-not-admin');
    const P = await project(G, 'out-not-admin');
    const revision = (await pool.query('SELECT revision FROM projects WHERE id = $1', [P])).rows[0].revision;
    const viaAdmin = await call(owner, 'PUT', `/projects/${P}/owner`,
      { ownerPrincipalId: member.principalId, stepUpToken: (await stepUp(owner.principalId, TRANSFER_ACT, P)).token }, { 'If-Match': String(revision) });
    expect(viaAdmin.status).toBe(403);
    expect(await projectOwner(P)).toBe(G);
    expect((await moveProject(owner, P, member.principalId, (await stepUp(owner.principalId, TRANSFER_ACT, P)).token)).status).toBe(200);
  });
});

// ═════════════════════ (7) DD-5: person -> Group ═════════════════════

describe('(7) DD-5 - the person owner moves an object into a Group they own', () => {
  it('admitted: the person owner of a project, holding the owner role in G, moves it into G with a step-up; audited deciderStanding group-owner', async () => {
    const { G, owner } = await team('in-project');
    const P = await project(owner.principalId, 'in-project');
    const { token, tokenId } = await stepUp(owner.principalId, TRANSFER_ACT, P);
    const answer = await moveProject(owner, P, G, token);
    expect(answer.status).toBe(200);
    expect(await projectOwner(P)).toBe(G);
    expect(await tokenLive(tokenId)).toBe(false);
    expect((await audits('project.owner.change', P, 'success')).pop()).toMatchObject({
      oldOwnerPrincipalId: owner.principalId, newOwnerPrincipalId: G, oldOwnerKind: 'human', newOwnerKind: 'group',
      deciderStanding: 'group-owner', stepUpTokenId: tokenId,
    });
  });

  it('admitted for a task: the effective person owner moves a task into G', async () => {
    const { G, owner } = await team('in-task');
    const P = await project(owner.principalId, 'in-task');
    const T = await task(P, null);
    const { token } = await stepUp(owner.principalId, TRANSFER_ACT, T);
    const answer = await moveTask(owner, T, G, token);
    expect(answer.status).toBe(200);
    expect(await taskOwner(T)).toMatchObject({ explicit: G, effective: G });
  });

  it('a caller who is not the current owner is NOT_THE_CURRENT_OWNER, the token live', async () => {
    const { G, owner } = await team('in-not-owner');
    const someone = await person('in-someone');
    const P = await project(someone.principalId, 'in-not-owner');
    await pool.query(`INSERT INTO grants (grantee_type, grantee_id, resource_type, resource_id, verb, granted_by_principal_id)
      VALUES ('principal', $1, 'project', $2, 'write', $3)`, [owner.principalId, P, ROOT.principalId]);
    const { token, tokenId } = await stepUp(owner.principalId, TRANSFER_ACT, P);
    const refused = await moveProject(owner, P, G, token);
    expect([refused.status, refused.json?.code]).toEqual([403, 'NOT_THE_CURRENT_OWNER']);
    expect(await tokenLive(tokenId)).toBe(true);
    expect(await projectOwner(P)).toBe(someone.principalId);
  });

  it('a manager of G and an owner of another Group are GROUP_OWNER_ROLE_REQUIRED, the token live', async () => {
    const { G, manager } = await team('in-manager');
    const other = await team('in-other');
    for (const who of [manager, other.owner]) {
      const P = await project(who.principalId, 'in-manager');
      const { token, tokenId } = await stepUp(who.principalId, TRANSFER_ACT, P);
      const refused = await moveProject(who, P, G, token);
      expect({ who: who.label, status: refused.status, code: refused.json?.code, live: await tokenLive(tokenId) })
        .toEqual({ who: who.label, status: 403, code: 'GROUP_OWNER_ROLE_REQUIRED', live: true });
      expect(await projectOwner(P)).toBe(who.principalId);
    }
  });

  it('a disabled Group as target is INVALID_OWNER, the token live', async () => {
    const { G, owner } = await team('in-disabled');
    const P = await project(owner.principalId, 'in-disabled');
    await setGroupStatus(G, 'disabled');
    try {
      const { token, tokenId } = await stepUp(owner.principalId, TRANSFER_ACT, P);
      const refused = await moveProject(owner, P, G, token);
      expect([refused.status, refused.json?.code]).toEqual([422, 'INVALID_OWNER']);
      expect(await tokenLive(tokenId)).toBe(true);
    } finally {
      await setGroupStatus(G, 'active');
    }
    expect(await projectOwner(P)).toBe(owner.principalId);
  });
});

// ═════════════════════ (8) the manager lens ═════════════════════

describe('(8) the manager lens - A-L51 and A-L53', () => {
  it('A-L51: a live owner and a live manager get the manager arm with their stewarded Groups, owners first, with the active memberCount, featured and role', async () => {
    const holder = await person('lens-holder');
    const G1 = await group('zz lens owned', true);
    const G2 = await group('aa lens managed', false);
    const m1 = await makeAccount('editor', 'lens-m1');
    const m2 = await makeAccount('editor', 'lens-m2');
    const gone = await makeAccount('editor', 'lens-disabled');
    for (const id of [holder.principalId, m1, m2, gone]) await join(G1, id);
    await join(G2, holder.principalId);
    await pool.query(`UPDATE principals SET status = 'disabled' WHERE id = $1`, [gone]);
    await steward(G1, holder.principalId, 'owner');
    await steward(G2, holder.principalId, 'manager');
    const answer = await lensOf(holder);
    expect(answer.status).toBe(200);
    const names = (await pool.query('SELECT id::text AS id, name FROM groups WHERE id = ANY($1::uuid[])', [[G1, G2]])).rows;
    const nameOf = (id: string) => names.find((row: any) => row.id === id).name;
    expect(answer.json).toStrictEqual({
      lenses: ['member', 'manager'], admin: false,
      manager: { stewardedGroups: [
        { id: G1, name: nameOf(G1), memberCount: 3, featured: true, role: 'owner' },
        { id: G2, name: nameOf(G2), memberCount: 1, featured: false, role: 'manager' },
      ] },
    });
  });

  it('A-L51: removing the row removes the arm on the next request, with no cache to invalidate', async () => {
    const { G, manager } = await team('lens-remove');
    expect((await lensOf(manager)).json.lenses).toEqual(['member', 'manager']);
    expect((await call(ROOT, 'DELETE', `/groups/${G}/stewards/${manager.principalId}`)).status).toBe(200);
    const after = await lensOf(manager);
    expect(after.json).toStrictEqual({ lenses: ['member'], admin: false });
    expect(after.text).not.toContain('manager');
  });

  it('A-L51 admin negative: an admin session that stewards no Group gets no manager arm, so the arm is not derived from principals.role', async () => {
    const answer = await lensOf(ROOT);
    expect(answer.json).toStrictEqual({ lenses: ['member', 'admin'], admin: true });
    expect(answer.text).not.toContain('manager');
  });

  it('A-L51 inert negative: an inert row (the holder left the Group) gives no arm; back in the Group, it returns', async () => {
    const { G, owner } = await team('lens-inert');
    await leave(G, owner.principalId);
    expect((await lensOf(owner)).json).toStrictEqual({ lenses: ['member'], admin: false });
    await join(G, owner.principalId);
    expect((await lensOf(owner)).json.manager.stewardedGroups.map((g: any) => [g.id, g.role])).toEqual([[G, 'owner']]);
  });

  it('A-L53: a caller with no live row still gets exactly { lenses: [member], admin: false } and no manager key', async () => {
    const { member } = await team('lens-plain');
    const answer = await lensOf(member);
    expect(answer.json).toStrictEqual({ lenses: ['member'], admin: false });
    expect(answer.text).not.toContain('manager');
  });

  it('the lens read with a manager arm writes nothing: no audit row', async () => {
    const { owner, manager } = await team('lens-noaudit');
    const before = Number((await pool.query('SELECT count(*)::int AS n FROM audit_events')).rows[0].n);
    await lensOf(owner);
    await lensOf(manager);
    expect(Number((await pool.query('SELECT count(*)::int AS n FROM audit_events')).rows[0].n)).toBe(before);
  });
});

// ═════════════════════ (3) liveness on the next request: promotion ═════════════════════

describe('(3) liveness - promotion to operator and back, for the gates and the lens', () => {
  it('promotion: an operator session promotes a live owner to operator; gate (iii), both steward routes and gate (i) refuse and no manager key; demoted to editor, each returns', async () => {
    const { G, owner, member } = await team('promote');
    const P = await project(G, 'promote');
    const T = await task(P, null);
    const mine = await project(owner.principalId, 'promote-mine');
    const promoted = await call(OPERATOR, 'POST', `/principals/${owner.principalId}/role`, { role: 'operator' });
    expect(promoted.status).toBe(200);
    const asOperator = await sessionFor('promoted-owner', owner.principalId);
    const appointToken = await stepUp(owner.principalId, APPOINT_ACT, G);
    expect((await appoint(asOperator, G, { accountPrincipalId: member.principalId, stepUpToken: appointToken.token })).json?.code)
      .toBe(APPOINT_OWNER);
    // An operator reaches every object as an administrator; the steward routes still refuse its standing.
    expect((await moveProject(asOperator, P, member.principalId, (await stepUp(owner.principalId, TRANSFER_ACT, P)).token)).json?.code)
      .toBe('GROUP_OWNER_ROLE_REQUIRED');
    expect((await moveTask(asOperator, T, member.principalId, (await stepUp(owner.principalId, TRANSFER_ACT, T)).token)).json?.code)
      .toBe('GROUP_OWNER_ROLE_REQUIRED');
    expect((await moveProject(asOperator, mine, G, (await stepUp(owner.principalId, TRANSFER_ACT, mine)).token)).json?.code)
      .toBe('GROUP_OWNER_ROLE_REQUIRED');
    const lens = await lensOf(asOperator);
    expect(lens.text).not.toContain('manager');
    expect(await tokenLive(appointToken.tokenId)).toBe(true);

    const demoted = await call(OPERATOR, 'POST', `/principals/${owner.principalId}/role`, { role: 'editor' });
    expect(demoted.status).toBe(200);
    const back = await sessionFor('demoted-owner', owner.principalId);
    expect((await lensOf(back)).json.lenses).toEqual(['member', 'manager']);
    expect((await appoint(back, G, { accountPrincipalId: member.principalId, stepUpToken: appointToken.token })).status).toBe(201);
    expect((await approve(back, P, 'c1-B after demotion', (await stepUp(owner.principalId, CHARTER_ACT, P)).token)).status).toBe(201);
  });
});

describe('(3) liveness - promotion to admin or orchestrator by an admin session', () => {
  it('promotion to admin or orchestrator by an admin session: gate (iii) and both steward routes refuse, and no manager key; SR-2 then answers that holder through the root arm, not the steward arm', async () => {
    for (const role of ['admin', 'orchestrator']) {
      const { G, owner, member } = await team(`promote-${role}`);
      const P = await project(G, `promote-${role}`);
      const T = await task(P, null);
      const mine = await project(owner.principalId, `promote-${role}-mine`);
      await pool.query(`INSERT INTO grants (grantee_type, grantee_id, resource_type, resource_id, verb, granted_by_principal_id)
        VALUES ('group', $1, 'project', $2, 'read', $3)`, [G, P, ROOT.principalId]);
      // Before: the steward arm of SR-2, which never names the grantor.
      const asSteward = await call(owner, 'GET', `/groups/${G}/grants`);
      expect(asSteward.json.grants.map((grant: any) => 'grantedByPrincipalId' in grant)).toEqual([false]);
      const promoted = await call(ROOT, 'POST', `/principals/${owner.principalId}/role`, { role });
      expect({ role, status: promoted.status }).toEqual({ role, status: 200 });
      const elevated = await sessionFor(`promoted-${role}`, owner.principalId);
      const appointToken = await stepUp(owner.principalId, APPOINT_ACT, G);
      const refusals = {
        appoint: (await appoint(elevated, G, { accountPrincipalId: member.principalId, stepUpToken: appointToken.token })).json?.code,
        out: (await moveProject(elevated, P, member.principalId, (await stepUp(owner.principalId, TRANSFER_ACT, P)).token)).json?.code,
        outTask: (await moveTask(elevated, T, member.principalId, (await stepUp(owner.principalId, TRANSFER_ACT, T)).token)).json?.code,
        into: (await moveProject(elevated, mine, G, (await stepUp(owner.principalId, TRANSFER_ACT, mine)).token)).json?.code,
      };
      expect({ role, ...refusals }).toEqual({
        role, appoint: APPOINT_OWNER, out: 'GROUP_OWNER_ROLE_REQUIRED', outTask: 'GROUP_OWNER_ROLE_REQUIRED', into: 'GROUP_OWNER_ROLE_REQUIRED',
      });
      expect(await tokenLive(appointToken.tokenId)).toBe(true);
      expect(await stewardRow(G, member.principalId)).toBeNull();
      expect(await projectOwner(P)).toBe(G);
      const lens = await lensOf(elevated);
      expect({ role, status: lens.status, manager: 'manager' in (lens.json ?? {}), lenses: lens.json?.lenses })
        .toEqual({ role, status: 200, manager: false, lenses: expect.not.arrayContaining(['manager']) });
      // After: the root arm of SR-2, which names the grantor.
      const asRoot = await call(elevated, 'GET', `/groups/${G}/grants`);
      expect(asRoot.json.grants).toEqual([expect.objectContaining({ grantedByPrincipalId: ROOT.principalId })]);
    }
  });
});

// ═════════════════════ (10) nothing wider than E57 ═════════════════════

describe('(10) nothing wider than E57', () => {
  it('no owner appoints an owner: the appointed row is always a manager row, and POST /groups/:id/stewards stops an owner session at the root ceiling', async () => {
    const { G, owner, member } = await team('wider-owner');
    const viaStewards = await call(owner, 'POST', `/groups/${G}/stewards`, { accountPrincipalId: member.principalId, role: 'owner' });
    expect([viaStewards.status, viaStewards.json?.code]).toEqual([403, 'FORBIDDEN']);
    const answer = await appoint(owner, G, { accountPrincipalId: member.principalId, stepUpToken: (await stepUp(owner.principalId, APPOINT_ACT, G)).token });
    expect(answer.json?.steward?.role).toBe('manager');
  });

  it('no gate admits through the admin verb: the admitted editor holds no admin on the objects it moves', async () => {
    const { G, owner } = await team('wider-admin');
    const P = await project(G, 'wider-admin');
    const { authorizationRepository } = require('../services/AuthorizationRepository');
    const { scopesForRole } = require('../utils/identityScopes');
    const actor = { authenticated: true, principalId: owner.principalId, role: 'editor', scopes: scopesForRole('editor') };
    expect((await authorizationRepository.authorizedIds(actor, 'project', [P], 'admin')).has(P)).toBe(false);
    expect((await authorizationRepository.authorizedIds(actor, 'project', [P], 'write')).has(P)).toBe(true);
  });

  it('no MCP tool reaches a gate: no tool names a manager appointment or a steward transfer route', () => {
    const names = MCP_TOOLS.map((tool: { name: string }) => tool.name);
    expect(names.length).toBeGreaterThan(20);
    expect(names.filter((name: string) => /steward|manager|group_role/.test(name))).toEqual([]);
    const registry = fs.readFileSync(path.join(__dirname, '..', 'mcp', 'registry.ts'), 'utf8');
    expect(registry).not.toMatch(/owner\/steward|account-owner\/steward|\/managers/);
  });
});

// ═════════════════════ (U) concurrency (U-6) ═════════════════════

describe('(U) U-6 - the gates hold their locks against a concurrent member removal', () => {
  it("gate (iii) holds the appointee's member row: removeMember waits until the appointment's checks commit", async () => {
    const { G, owner, member } = await team('u6-appoint');
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await groupStewardService.requireGroupOwnerStanding(client, G,
        { authMethod: 'session', principalId: owner.principalId, chainLength: 1 },
        { requiresSession: APPOINT_SESSION, requiresOwner: APPOINT_OWNER, act: 'Appointing a Group manager' });
      await groupStewardService.requireEligibleManagerAppointee(client, G, member.principalId);
      let settled = false;
      const removal = groupService.removeMember(G, member.principalId,
        { principalId: ROOT.principalId, handle: 'c1b-u6', authMethod: 'session' }).then(() => { settled = true; });
      await new Promise((resolve) => setTimeout(resolve, 750));
      expect(settled).toBe(false);
      await client.query('COMMIT');
      await removal;
      expect(settled).toBe(true);
    } finally {
      await client.query('ROLLBACK').catch(() => undefined);
      client.release();
    }
  });

  it("gate (ii) holds the owner's and the target's member rows: a concurrent removal of the target waits", async () => {
    const { G, owner, member } = await team('u6-out');
    const P = await project(G, 'u6-out');
    const client = await pool.connect();
    const other = await pool.connect();
    try {
      await client.query('BEGIN');
      const standing = await stewardTransferStanding(client, {
        objectType: 'project', objectId: P, currentOwnerId: G, targetOwnerId: member.principalId,
        caller: { authMethod: 'session', principalId: owner.principalId, chainLength: 1, scopes: ['projects:read', 'projects:write'] },
        writeScope: 'projects:write',
      }).catch((error: unknown) => error);
      // A refused standing is an ASSERTION here, not a thrown fixture error.
      expect(standing).toMatchObject({ shape: 'out', groupId: G });
      await other.query('BEGIN');
      await other.query(`SET LOCAL lock_timeout = '500ms'`);
      await expect(other.query('DELETE FROM group_members WHERE group_id = $1 AND account_principal_id = $2', [G, member.principalId]))
        .rejects.toThrow(/lock timeout/);
      await other.query('ROLLBACK');
      await other.query('BEGIN');
      await other.query(`SET LOCAL lock_timeout = '500ms'`);
      await expect(other.query('DELETE FROM group_members WHERE group_id = $1 AND account_principal_id = $2', [G, owner.principalId]))
        .rejects.toThrow(/lock timeout/);
      await other.query('ROLLBACK');
      await client.query('COMMIT');
    } finally {
      await client.query('ROLLBACK').catch(() => undefined);
      await other.query('ROLLBACK').catch(() => undefined);
      client.release();
      other.release();
    }
  });
});
