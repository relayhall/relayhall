/**
 * Card 46cfbd1d — LENSES-c slice c1-A: the Group roles relation and the acts
 * built on it (design delta LENSES-C steward tier, RATIFIED 2026-10-11, ruling
 * E98; AUTHZ amendment AZ-A12 clause 5, ruling E57), over a REAL PostgreSQL,
 * the PRODUCTION router and the MCP ingress.
 *
 * It measures, on stored rows:
 *
 *   (M)  migration 152: it re-applies cleanly and a rerun changes nothing; the
 *        CHECK, the primary key, both RESTRICT foreign keys and both triggers
 *        are pinned BY NAME (LC-C4).
 *   (1)  drill 1, the relation: the role CHECK, the holder trigger's positive
 *        allowlist and its three named refusals, the UPDATE refusal, and
 *        GROUP_HAS_STEWARDS (a count, never ids) on Group deletion.
 *   (2)  drill 2, the root acts: a root login session appoints and removes both
 *        roles; a legacy root bearer is REQUIRES_LOGIN_SESSION; an operator and
 *        an editor session stop at the /groups root ceiling; every refusal is
 *        named and audited as denied.
 *   (3)  drill 3, liveness: leave, disable, promotion to operator by an
 *        operator session (and back), promotion to admin or orchestrator, and
 *        termination by a legacy root bearer and by a root login session, each
 *        asserted on the stewards read, the catalog, SR-2 and owner removal.
 *   (O)  owner removal of a MANAGER row (C.4, E98 Q3): the admitted case, then
 *        each step flipped alone; no refusal spends the step-up.
 *   (9)  drill 9: the catalog's steward row (A-L35-c, A-L36) and SR-2.
 *   (10) drill 10, c1-A legs: nothing wider than E57.
 *   (U)  U-6: an owner removal against a concurrent member removal, a
 *        directory snapshot delete and a catalog read.
 *
 * Every probe that a defect could turn into a stored bad row runs inside a
 * transaction that is rolled back.
 *
 * DESTRUCTIVE: writes principals, groups, members, steward rows, grants,
 * directory references, step-up tokens and audit rows. It refuses any
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
  throw new Error('RELAYHALL_TEST_DB_URL is required: the Group roles drill measures stored steward, member, grant, '
    + 'step-up and audit rows, so it never skips. Load database/init.sql into a disposable database, run '
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
  throw new Error('Group roles drill refuses a non-disposable database target');
}

const JWT_SECRET = crypto.randomBytes(32).toString('hex');
Object.assign(process.env, {
  DB_HOST: parsed.hostname, DB_PORT: parsed.port || '5432', DB_NAME: TEST_DB_NAME,
  DB_USER: decodeURIComponent(parsed.username), DB_PASSWORD: decodeURIComponent(parsed.password),
  NODE_ENV: 'test', RELAYHALL_SESSIONS: 'on', JWT_SECRET,
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
const { directoryCarriageService } = require('../services/DirectoryCarriageService');
const { groupStewardService } = require('../services/GroupStewardService');
const { accountPasswordService } = require('../services/AccountPasswordService');
const { MCP_TOOLS } = require('../mcp/registry');
const { insertGroupRow } = require('./support/groupRows');
const mcpRoutes = require('../mcp/httpRoute').default;
const { MCP_ROUTE_PATH } = require('../mcp/httpRoute');

jest.setTimeout(180_000);

const MIGRATION_FILE = path.join(__dirname, '..', 'migrations', '152_lenses_c_group_stewards.sql');
const REMOVE_ACT = 'group.manager_remove';
const SESSION_CODE = 'GROUP_MANAGER_REMOVE_REQUIRES_SESSION';
const OWNER_CODE = 'GROUP_MANAGER_REMOVE_REQUIRES_OWNER';

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

const tag = (): string => crypto.randomBytes(5).toString('hex');

async function makeAccount(role: string | null, label: string, kind: 'human' | 'service' = 'human'): Promise<string> {
  const result = await pool.query(
    `INSERT INTO principals (kind, handle, display_name, status, role, purpose)
     VALUES ($1, $2, $2, 'active', $3, $4) RETURNING id`,
    [kind, `c1a-${label}-${tag()}`, role, kind === 'service' ? 'LENSES-c c1-A drill service Account' : null],
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

/** A principal_api_key bearer HOLDING root, built as the build-1 drill builds
 * one: minted narrow, widened in raw SQL. */
async function rootBearerFor(label: string, accountId: string): Promise<Caller> {
  const created = await pool.query(
    `INSERT INTO principals (kind, handle, display_name, status, role, parent_principal_id)
     VALUES ('service', $1, $1, 'active', 'user', $2) RETURNING id`,
    [`c1a-bearer-${tag()}`, accountId],
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

/** A Connector registered by `owner`, holding principals:read. */
async function connectorOf(owner: Caller): Promise<Caller> {
  const slug = `c1a-connector-${tag()}`;
  const registered = await call(owner, 'POST', '/services', {
    slug, name: slug, description: 'LENSES-c c1-A drill connector.', kind: 'connector',
    issueCredential: { scopes: ['principals:read'], label: slug, transport: 'any' },
  });
  expect(registered.status).toBe(201);
  const row = await pool.query('SELECT principal_id FROM services WHERE slug = $1', [slug]);
  return {
    label: slug, principalId: String(row.rows[0].principal_id),
    headers: { Authorization: `Bearer ${registered.json.onboarding.credential.secretOnce}` },
  };
}

async function group(label: string): Promise<string> {
  return insertGroupRow(pool, { name: `c1a ${label} ${tag()}`, description: 'LENSES-c c1-A drill', featured: false });
}

async function join(groupId: string, accountId: string): Promise<void> {
  await pool.query(`INSERT INTO group_members (group_id, account_principal_id, source) VALUES ($1, $2, 'local')`,
    [groupId, accountId]);
}

async function leave(groupId: string, accountId: string): Promise<void> {
  await pool.query('DELETE FROM group_members WHERE group_id = $1 AND account_principal_id = $2', [groupId, accountId]);
}

/** A steward row written in raw SQL (the 152 trigger still applies). */
async function steward(groupId: string, accountId: string, role: 'owner' | 'manager'): Promise<void> {
  await pool.query(
    `INSERT INTO group_stewards (group_id, account_principal_id, role, appointed_by_principal_id) VALUES ($1, $2, $3, $4)`,
    [groupId, accountId, role, ROOT.principalId],
  );
}

interface Team { G: string; owner: Caller; manager: Caller; member: string }

/** A Group with a live owner, a live manager and one plain member. */
async function team(label: string): Promise<Team> {
  const G = await group(label);
  const owner = await person(`${label}-owner`);
  const manager = await person(`${label}-manager`);
  const member = await makeAccount('editor', `${label}-member`);
  for (const id of [owner.principalId, manager.principalId, member]) await join(G, id);
  await steward(G, owner.principalId, 'owner');
  await steward(G, manager.principalId, 'manager');
  return { G, owner, manager, member };
}

async function stepUp(principalId: string, groupId: string, action = REMOVE_ACT): Promise<string> {
  return (await stepUpService.mint(principalId, action, groupId, 'password')).token;
}

async function tokenConsumed(tokenValue: string): Promise<boolean> {
  const hash = crypto.createHash('sha256').update(tokenValue).digest('hex');
  const row = await pool.query('SELECT consumed_at FROM step_up_tokens WHERE token_hash = $1', [hash]);
  return row.rows[0]?.consumed_at != null;
}

async function deniedAudit(action: string, refusal: string, groupId: string): Promise<number> {
  const rows = await pool.query(
    `SELECT count(*)::int AS n FROM audit_events
      WHERE action = $1 AND outcome = 'denied' AND resource_id = $2 AND metadata->>'refusal' = $3`,
    [action, groupId, refusal],
  );
  return Number(rows.rows[0].n);
}

async function successAudits(action: string, groupId: string): Promise<any[]> {
  const rows = await pool.query(
    `SELECT metadata FROM audit_events WHERE action = $1 AND outcome = 'success' AND resource_id = $2
      ORDER BY occurred_at, id`, [action, groupId]);
  return rows.rows.map((row: any) => row.metadata);
}

async function stewardRow(groupId: string, accountId: string): Promise<any | null> {
  const row = await pool.query(
    'SELECT role, appointed_by_principal_id FROM group_stewards WHERE group_id = $1 AND account_principal_id = $2',
    [groupId, accountId]);
  return row.rows[0] ?? null;
}

async function stewardsOf(groupId: string, reader: Caller = EDITOR): Promise<any[]> {
  const answer = await call(reader, 'GET', `/groups/${groupId}/stewards`);
  expect(answer.status).toBe(200);
  return answer.json.stewards;
}

async function inertReasonOf(groupId: string, accountId: string): Promise<string | null | undefined> {
  const row = (await stewardsOf(groupId)).find((s: any) => s.accountPrincipalId === accountId);
  return row === undefined ? undefined : row.inertReason;
}

/** Run one statement inside a transaction that is ALWAYS rolled back. */
async function probe(sql: string, params: unknown[] = []): Promise<{ admitted: boolean; message: string }> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    try {
      await client.query(sql, params);
      return { admitted: true, message: '' };
    } catch (error: any) {
      return { admitted: false, message: String(error?.message ?? error) };
    }
  } finally {
    await client.query('ROLLBACK').catch(() => undefined);
    client.release();
  }
}

async function inRolledBackTransaction<T>(body: (client: any) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    return await body(client);
  } finally {
    await client.query('ROLLBACK').catch(() => undefined);
    client.release();
  }
}

const INSERT_STEWARD = `INSERT INTO group_stewards (group_id, account_principal_id, role) VALUES ($1, $2, $3)`;

// ── the catalog fixture: one provider, references carried by chosen Accounts ──

async function reference(label: string, carriers: string[]): Promise<string> {
  const row = await pool.query(
    `INSERT INTO directory_group_references (identity_provider_id, external_group_ref, display_name)
     VALUES ($1, $2, $3) RETURNING id`, [PROVIDER_ID, `c1a-${label}-${tag()}`, `c1a ${label}`]);
  const id = String(row.rows[0].id);
  for (const account of carriers) {
    await pool.query(
      `INSERT INTO account_directory_group_references (directory_group_reference_id, account_principal_id, source)
       VALUES ($1, $2, 'claim')`, [id, account]);
  }
  return id;
}

async function catalogIds(who: Caller): Promise<string[]> {
  const answer = await call(who, 'GET', '/directory-group-references');
  expect(answer.status).toBe(200);
  return answer.json.references.map((r: any) => r.id).sort();
}

async function grantsSeenBy(who: Caller, groupId: string): Promise<any[]> {
  const answer = await call(who, 'GET', `/groups/${groupId}/grants`);
  expect(answer.status).toBe(200);
  return answer.json.grants;
}

async function groupGrant(groupId: string, grantedBy: string): Promise<string> {
  const row = await pool.query(
    `INSERT INTO grants (grantee_type, grantee_id, resource_type, resource_id, verb, granted_by_principal_id)
     VALUES ('group', $1, 'project', NULL, 'read', $2) RETURNING id`, [groupId, grantedBy]);
  return String(row.rows[0].id);
}

const removeManager = (who: Caller, groupId: string, principalId: string, body: Record<string, unknown>) =>
  call(who, 'DELETE', `/groups/${groupId}/managers/${principalId}`, body);

/**
 * A parentless SERVICE Account that holds a live manager row in G and ALSO
 * presents a bearer credential of its own (minted narrow under a parent, then
 * detached, as the root-bearer fixture is built): the one caller whose bearer
 * principal IS a live steward. The catalog and SR-2 must still answer it [],
 * because the steward row is a login-session row.
 */
async function stewardBearer(G: string): Promise<{ session: Caller; bearer: Caller }> {
  const parent = await makeAccount('editor', 'steward-bearer-parent');
  const created = await pool.query(
    `INSERT INTO principals (kind, handle, display_name, status, role, parent_principal_id, purpose)
     VALUES ('service', $1, $1, 'active', 'user', $2, 'LENSES-c c1-A drill steward bearer') RETURNING id`,
    [`c1a-steward-bearer-${tag()}`, parent]);
  const id = String(created.rows[0].id);
  const issued = await principalService.issueCredential({
    principalId: id, scopes: ['principals:read'], label: `c1a-steward-bearer-${tag()}`, transport: 'api',
  });
  await pool.query('UPDATE principals SET parent_principal_id = NULL WHERE id = $1', [id]);
  principalService.invalidatePrincipals([id]);
  await join(G, id);
  await steward(G, id, 'manager');
  return {
    session: await sessionFor('steward-bearer-session', id),
    bearer: { label: 'steward-bearer', principalId: id, headers: { Authorization: `Bearer ${issued.fullKey}` } },
  };
}

/** Every UUID-shaped string anywhere in a JSON value. */
function uuidsIn(value: unknown): string[] {
  return (JSON.stringify(value).match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi) ?? [])
    .map((id) => id.toLowerCase());
}

let ROOT: Caller;
let OPERATOR: Caller;
let EDITOR: Caller;
let ROOT_BEARER: Caller;
let PROVIDER_ID: string;

beforeAll(async () => {
  await new Promise<void>((resolve) => { server = buildApp().listen(0, '127.0.0.1', resolve); });
  origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  ROOT = await person('root', 'admin');
  OPERATOR = await person('operator', 'operator');
  EDITOR = await person('editor');
  ROOT_BEARER = await rootBearerFor('c1a-root-bearer', ROOT.principalId);
  const provider = await pool.query(
    `INSERT INTO identity_providers
       (name, status, issuer, discovery_url, client_id, subject_immutable, group_binding_mode, groups_claim)
     VALUES ($1, 'disabled', $2, $3, 'c1a-drill', TRUE, 'claim', 'groups') RETURNING id`,
    [`c1a ${tag()}`, `https://issuer.invalid/c1a/${tag()}`, `https://issuer.invalid/c1a/${tag()}/.well-known/openid-configuration`],
  );
  PROVIDER_ID = String(provider.rows[0].id);
});

afterAll(async () => {
  if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  await pool.end();
});

// ═════════════════════ (M) migration 152 ═════════════════════

async function catalogSnapshot(): Promise<string> {
  const rows = await pool.query(
    `SELECT 'c:' || conname || ':' || pg_get_constraintdef(oid) AS item FROM pg_constraint
      WHERE conrelid = 'group_stewards'::regclass
     UNION ALL
     SELECT 't:' || tgname || ':' || pg_get_triggerdef(oid) FROM pg_trigger
      WHERE tgrelid = 'group_stewards'::regclass AND NOT tgisinternal
     UNION ALL
     SELECT 'i:' || indexname || ':' || indexdef FROM pg_indexes WHERE tablename = 'group_stewards'
     UNION ALL
     SELECT 'f:' || p.proname || ':' || md5(p.prosrc) FROM pg_proc p
      WHERE p.proname IN ('enforce_group_steward_holder', 'enforce_group_steward_no_update')
     ORDER BY 1`);
  return rows.rows.map((row: any) => row.item).join('\n');
}

describe('(M) migration 152 - idempotent, fresh-replay safe, pinned by name', () => {
  it('migration 152 re-applies cleanly and a rerun changes nothing', async () => {
    const sql = fs.readFileSync(MIGRATION_FILE, 'utf8');
    await pool.query(sql);
    const once = await catalogSnapshot();
    const rows = (await pool.query('SELECT count(*)::int AS n FROM group_stewards')).rows[0].n;
    await pool.query(sql);
    expect(await catalogSnapshot()).toBe(once);
    expect((await pool.query('SELECT count(*)::int AS n FROM group_stewards')).rows[0].n).toBe(rows);
    // One implicit transaction: no statement (comments aside) opens or ends one.
    expect(sql.replace(/--[^\n]*/g, '')).not.toMatch(/\bCOMMIT\b|\bBEGIN\s*;|\bROLLBACK\b/i);
  });

  it('pinning: group_stewards_role_check, the primary key and both RESTRICT foreign keys are present by name', async () => {
    const rows = await pool.query(
      `SELECT conname, contype, confdeltype, pg_get_constraintdef(oid) AS def FROM pg_constraint
        WHERE conrelid = 'group_stewards'::regclass ORDER BY conname`);
    const byName = new Map<string, any>(rows.rows.map((row: any) => [row.conname, row]));
    expect(byName.get('group_stewards_role_check')).toMatchObject({ contype: 'c' });
    expect(String(byName.get('group_stewards_role_check')?.def)).toMatch(/'owner'.*'manager'/);
    expect(byName.get('group_stewards_pkey')).toMatchObject({ contype: 'p' });
    expect(String(byName.get('group_stewards_pkey')?.def)).toBe('PRIMARY KEY (group_id, account_principal_id)');
    expect(byName.get('group_stewards_group_id_fkey')).toMatchObject({ contype: 'f', confdeltype: 'r' });
    expect(byName.get('group_stewards_account_principal_id_fkey')).toMatchObject({ contype: 'f', confdeltype: 'r' });
  });

  it('pinning: both triggers are present by name, BEFORE INSERT and BEFORE UPDATE', async () => {
    const rows = await pool.query(
      `SELECT tgname, pg_get_triggerdef(oid) AS def FROM pg_trigger
        WHERE tgrelid = 'group_stewards'::regclass AND NOT tgisinternal ORDER BY tgname`);
    expect(rows.rows.map((row: any) => row.tgname)).toEqual(['enforce_group_steward_holder', 'enforce_group_steward_no_update']);
    expect(rows.rows[0].def).toMatch(/BEFORE INSERT ON public\.group_stewards FOR EACH ROW/);
    expect(rows.rows[1].def).toMatch(/BEFORE UPDATE ON public\.group_stewards FOR EACH ROW/);
  });
});

// ═════════════════════ (1) the relation ═════════════════════

describe('(1) drill 1 - the relation and its triggers', () => {
  it('the role CHECK refuses any value but owner and manager; both are admitted', async () => {
    const G = await group('check');
    const holder = await makeAccount('editor', 'check');
    const refused = await probe(INSERT_STEWARD, [G, holder, 'steward']);
    expect(refused.admitted).toBe(false);
    expect(refused.message).toMatch(/group_stewards_role_check/);
    expect((await probe(INSERT_STEWARD, [G, holder, 'owner'])).admitted).toBe(true);
    expect((await probe(INSERT_STEWARD, [G, holder, 'manager'])).admitted).toBe(true);
  });

  it('the holder trigger refuses group and agent kinds by its allowlist rule; human and service Accounts are admitted', async () => {
    const G = await group('kinds');
    const other = await group('kinds-other');
    const asGroup = await probe(INSERT_STEWARD, [G, other, 'manager']);
    expect(asGroup.admitted).toBe(false);
    expect(asGroup.message).toMatch(/kind allowlist\): kind group is refused/);
    const owner = await makeAccount('editor', 'agent-owner');
    const task = await call(ROOT, 'POST', '/tasks', { title: `c1a agent ${tag()}`, description: 'LENSES-c c1-A drill', status: 'todo' });
    expect(task.status).toBe(201);
    await inRolledBackTransaction(async (client) => {
      const connector = await client.query(
        `INSERT INTO principals (kind, handle, status, parent_principal_id, purpose) VALUES ('service', $1, 'active', $2, 'drill') RETURNING id`,
        [`c1a-conn-${tag()}`, owner]);
      const agent = await client.query(
        `INSERT INTO principals (kind, handle, status, parent_principal_id, bound_task_id) VALUES ('agent', $1, 'active', $2, $3) RETURNING id`,
        [`c1a-agent-${tag()}`, String(connector.rows[0].id), String(task.json.task.id)]);
      await client.query('SAVEPOINT agent_probe');
      await expect(client.query(INSERT_STEWARD, [G, String(agent.rows[0].id), 'manager']))
        .rejects.toThrow(/kind allowlist\): kind agent is refused/);
      await client.query('ROLLBACK TO SAVEPOINT agent_probe');
    });
    expect((await probe(INSERT_STEWARD, [G, await makeAccount('editor', 'human'), 'manager'])).admitted).toBe(true);
    expect((await probe(INSERT_STEWARD, [G, await makeAccount('user', 'service', 'service'), 'owner'])).admitted).toBe(true);
  });

  it('the holder trigger refuses parented, legacy and elevated-role holders, each by its rule', async () => {
    const G = await group('holder');
    const parent = await makeAccount('editor', 'parent');
    const child = await pool.query(
      `INSERT INTO principals (kind, handle, status, parent_principal_id, purpose) VALUES ('service', $1, 'active', $2, 'drill') RETURNING id`,
      [`c1a-child-${tag()}`, parent]);
    const parented = await probe(INSERT_STEWARD, [G, String(child.rows[0].id), 'manager']);
    expect(parented.message).toMatch(/LENSES-c C\.1, parented/);
    const legacy = await pool.query(
      `INSERT INTO principals (kind, handle, status, legacy_identity) VALUES ('human', $1, 'active', TRUE) RETURNING id`,
      [`c1a-legacy-${tag()}`]);
    expect((await probe(INSERT_STEWARD, [G, String(legacy.rows[0].id), 'manager'])).message).toMatch(/LENSES-c C\.1, legacy/);
    for (const role of ['admin', 'operator', 'orchestrator']) {
      const elevated = await probe(INSERT_STEWARD, [G, await makeAccount(role, `elevated-${role}`), 'owner']);
      expect(elevated.admitted).toBe(false);
      expect(elevated.message).toMatch(new RegExp(`LENSES-c C\\.1, elevated_role\\): ${role} is refused`));
    }
    const missing = await probe(INSERT_STEWARD, [G, crypto.randomUUID(), 'manager']);
    expect(missing.admitted).toBe(false);
    expect(missing.message).toMatch(/names no principal/);
  });

  it('every UPDATE of a steward row is refused', async () => {
    const G = await group('update');
    const holder = await makeAccount('editor', 'update');
    await steward(G, holder, 'manager');
    for (const set of ["role = 'owner'", 'appointed_at = now()', 'appointed_by_principal_id = NULL']) {
      const refused = await probe(`UPDATE group_stewards SET ${set} WHERE group_id = $1`, [G]);
      expect(refused.admitted).toBe(false);
      expect(refused.message).toMatch(/group steward rows are never edited/);
    }
    expect(await stewardRow(G, holder)).toMatchObject({ role: 'manager' });
  });

  it('deleting a Group with a steward row answers GROUP_HAS_STEWARDS with a count and no ids; after the root removal it deletes', async () => {
    const G = await group('has-stewards');
    const holder = await makeAccount('editor', 'has-stewards');
    await steward(G, holder, 'owner');
    const refused = await call(ROOT, 'DELETE', `/groups/${G}`);
    expect([refused.status, refused.json?.code]).toEqual([409, 'GROUP_HAS_STEWARDS']);
    expect(refused.json.details).toEqual({ stewards: 1 });
    expect(refused.text).toContain('GET /groups/{id}/stewards');
    expect(refused.text).not.toContain(holder);
    const removed = await call(ROOT, 'DELETE', `/groups/${G}/stewards/${holder}`);
    expect(removed.status).toBe(200);
    const deleted = await call(ROOT, 'DELETE', `/groups/${G}`);
    expect(deleted.status).toBe(200);
  });

  it('GROUP_HAS_STEWARDS answers after GROUP_OWNS_OBJECTS and before the grants delete', async () => {
    const G = await group('order');
    const holder = await makeAccount('editor', 'order');
    await steward(G, holder, 'manager');
    const grant = await groupGrant(G, ROOT.principalId);
    const project = await call(ROOT, 'POST', '/projects', { name: `c1a order ${tag()}` });
    const projectId = String(project.json.project.id);
    await pool.query('UPDATE projects SET owner_principal_id = $1 WHERE id = $2', [G, projectId]);
    const owns = await call(ROOT, 'DELETE', `/groups/${G}`);
    expect(owns.json?.code).toBe('GROUP_OWNS_OBJECTS');
    await pool.query('UPDATE projects SET owner_principal_id = NULL WHERE id = $1', [projectId]);
    const stewards = await call(ROOT, 'DELETE', `/groups/${G}`);
    expect(stewards.json?.code).toBe('GROUP_HAS_STEWARDS');
    expect((await pool.query('SELECT count(*)::int AS n FROM grants WHERE id = $1', [grant])).rows[0].n).toBe(1);
  });
});

// ═════════════════════ (2) the root acts ═════════════════════

describe('(2) drill 2 - appointment and removal by a root login session', () => {
  it('a root login session appoints an owner and a manager: 201, rows carry role and appointer, audited standing root', async () => {
    const G = await group('appoint');
    const owner = await makeAccount('editor', 'appoint-owner');
    const manager = await makeAccount('user', 'appoint-manager', 'service');
    await join(G, owner);
    const first = await call(ROOT, 'POST', `/groups/${G}/stewards`, { accountPrincipalId: owner, role: 'owner' });
    expect(first.status).toBe(201);
    expect(first.json.steward).toMatchObject({ accountPrincipalId: owner, role: 'owner', live: true, inertReason: null,
      appointedByPrincipalId: ROOT.principalId });
    const second = await call(ROOT, 'POST', `/groups/${G}/stewards`, { accountPrincipalId: manager, role: 'manager' });
    expect(second.status).toBe(201);
    expect(second.json.steward).toMatchObject({ role: 'manager', live: false, inertReason: 'not_a_member' });
    expect(await stewardRow(G, owner)).toMatchObject({ role: 'owner', appointed_by_principal_id: ROOT.principalId });
    const audits = await successAudits('group.steward_appoint', G);
    expect(audits).toHaveLength(2);
    expect(audits[0]).toMatchObject({ groupId: G, accountPrincipalId: owner, role: 'owner', appointedBy: ROOT.principalId,
      standing: 'root', liveAtWrite: true, via: 'rest' });
    expect(audits[0].chain[0]).toMatchObject({ principalId: ROOT.principalId });
    expect(audits[1]).toMatchObject({ role: 'manager', liveAtWrite: false });
  });

  it('a root login session removes both roles, live or inert, audited; an absent row is STEWARD_NOT_FOUND', async () => {
    const { G, owner, manager } = await team('remove');
    await leave(G, manager.principalId);
    for (const [holder, role] of [[owner.principalId, 'owner'], [manager.principalId, 'manager']]) {
      const removed = await call(ROOT, 'DELETE', `/groups/${G}/stewards/${holder}`);
      expect(removed.status).toBe(200);
      expect(removed.json.removed).toEqual({ accountPrincipalId: holder, role });
      expect(await stewardRow(G, holder)).toBeNull();
    }
    const audits = await successAudits('group.steward_remove', G);
    expect(audits.map((a: any) => [a.role, a.standing, a.liveAtWrite])).toEqual([['owner', 'root', true], ['manager', 'root', false]]);
    const absent = await call(ROOT, 'DELETE', `/groups/${G}/stewards/${owner.principalId}`);
    expect([absent.status, absent.json?.code]).toEqual([404, 'STEWARD_NOT_FOUND']);
    expect(await deniedAudit('group.steward_remove', 'STEWARD_NOT_FOUND', G)).toBe(1);
  });

  it('a legacy root bearer is refused REQUIRES_LOGIN_SESSION on appoint and remove, audited, nothing written', async () => {
    const { G, manager } = await team('bearer');
    const holder = await makeAccount('editor', 'bearer-holder');
    const appoint = await call(ROOT_BEARER, 'POST', `/groups/${G}/stewards`, { accountPrincipalId: holder, role: 'manager' });
    expect([appoint.status, appoint.json?.code]).toEqual([403, 'REQUIRES_LOGIN_SESSION']);
    expect(await stewardRow(G, holder)).toBeNull();
    const remove = await call(ROOT_BEARER, 'DELETE', `/groups/${G}/stewards/${manager.principalId}`);
    expect([remove.status, remove.json?.code]).toEqual([403, 'REQUIRES_LOGIN_SESSION']);
    expect(await stewardRow(G, manager.principalId)).not.toBeNull();
    expect(await deniedAudit('group.steward_appoint', 'REQUIRES_LOGIN_SESSION', G)).toBe(1);
    expect(await deniedAudit('group.steward_remove', 'REQUIRES_LOGIN_SESSION', G)).toBe(1);
  });

  it('an operator login session and an editor session are refused at the /groups root ceiling', async () => {
    const { G, manager } = await team('ceiling');
    const holder = await makeAccount('editor', 'ceiling-holder');
    for (const who of [OPERATOR, EDITOR]) {
      const appoint = await call(who, 'POST', `/groups/${G}/stewards`, { accountPrincipalId: holder, role: 'manager' });
      expect([appoint.status, appoint.json?.code]).toEqual([403, 'FORBIDDEN']);
      const remove = await call(who, 'DELETE', `/groups/${G}/stewards/${manager.principalId}`);
      expect([remove.status, remove.json?.code]).toEqual([403, 'FORBIDDEN']);
    }
    expect(await stewardRow(G, holder)).toBeNull();
    expect(await stewardRow(G, manager.principalId)).not.toBeNull();
  });

  it('POST validation: both fields are required, role is owner or manager, unknown fields are refused, each named and audited', async () => {
    const G = await group('validation');
    const holder = await makeAccount('editor', 'validation');
    const cases: Array<[Record<string, unknown>, number, string]> = [
      [{ role: 'manager' }, 422, 'INVALID_GROUP_VALUE'],
      [{ accountPrincipalId: holder }, 422, 'INVALID_GROUP_VALUE'],
      [{ accountPrincipalId: holder, role: 'steward' }, 422, 'INVALID_GROUP_VALUE'],
      [{ accountPrincipalId: 'not-a-uuid', role: 'manager' }, 422, 'INVALID_GROUP_VALUE'],
      [{ accountPrincipalId: holder, role: 'manager', stepUpToken: 'x' }, 400, 'UNKNOWN_FIELD'],
    ];
    for (const [body, status, code] of cases) {
      const answer = await call(ROOT, 'POST', `/groups/${G}/stewards`, body);
      expect([answer.status, answer.json?.code]).toEqual([status, code]);
    }
    expect(await deniedAudit('group.steward_appoint', 'INVALID_GROUP_VALUE', G)).toBe(4);
    expect(await deniedAudit('group.steward_appoint', 'UNKNOWN_FIELD', G)).toBe(1);
    expect(await stewardRow(G, holder)).toBeNull();
  });

  it('STEWARD_NOT_FOUND (422) for a principal that does not exist; GROUP_NOT_FOUND (404) for an absent Group', async () => {
    const G = await group('not-found');
    const missing = await call(ROOT, 'POST', `/groups/${G}/stewards`, { accountPrincipalId: crypto.randomUUID(), role: 'owner' });
    expect([missing.status, missing.json?.code]).toEqual([422, 'STEWARD_NOT_FOUND']);
    const ghost = crypto.randomUUID();
    const noGroup = await call(ROOT, 'POST', `/groups/${ghost}/stewards`, { accountPrincipalId: EDITOR.principalId, role: 'owner' });
    expect([noGroup.status, noGroup.json?.code]).toEqual([404, 'GROUP_NOT_FOUND']);
    const noGroupRemove = await call(ROOT, 'DELETE', `/groups/${ghost}/stewards/${EDITOR.principalId}`);
    expect([noGroupRemove.status, noGroupRemove.json?.code]).toEqual([404, 'GROUP_NOT_FOUND']);
  });

  it('STEWARD_INELIGIBLE names its reason: kind, parented, legacy and elevated_role', async () => {
    const G = await group('ineligible');
    const other = await group('ineligible-other');
    const connector = await connectorOf(EDITOR);
    const legacy = await pool.query(
      `INSERT INTO principals (kind, handle, status, legacy_identity) VALUES ('human', $1, 'active', TRUE) RETURNING id`,
      [`c1a-legacy-route-${tag()}`]);
    const cases: Array<[string, string]> = [
      [other, 'kind'],
      [connector.principalId, 'parented'],
      [String(legacy.rows[0].id), 'legacy'],
      [await makeAccount('admin', 'route-admin'), 'elevated_role'],
      [await makeAccount('operator', 'route-operator'), 'elevated_role'],
      [await makeAccount('orchestrator', 'route-orchestrator'), 'elevated_role'],
    ];
    for (const [holder, reason] of cases) {
      const answer = await call(ROOT, 'POST', `/groups/${G}/stewards`, { accountPrincipalId: holder, role: 'manager' });
      expect([answer.status, answer.json?.code, answer.json?.details?.reason]).toEqual([422, 'STEWARD_INELIGIBLE', reason]);
    }
    expect((await pool.query('SELECT count(*)::int AS n FROM group_stewards WHERE group_id = $1', [G])).rows[0].n).toBe(0);
    expect(await deniedAudit('group.steward_appoint', 'STEWARD_INELIGIBLE', G)).toBe(cases.length);
  });

  it('ALREADY_A_STEWARD (409) names the existing role; membership is not required at appointment', async () => {
    const G = await group('already');
    const outsider = await makeAccount('editor', 'outsider');
    const first = await call(ROOT, 'POST', `/groups/${G}/stewards`, { accountPrincipalId: outsider, role: 'manager' });
    expect(first.status).toBe(201);
    expect(await inertReasonOf(G, outsider)).toBe('not_a_member');
    for (const role of ['manager', 'owner']) {
      const again = await call(ROOT, 'POST', `/groups/${G}/stewards`, { accountPrincipalId: outsider, role });
      expect([again.status, again.json?.code, again.json?.details?.role]).toEqual([409, 'ALREADY_A_STEWARD', 'manager']);
    }
    await join(G, outsider);
    expect(await inertReasonOf(G, outsider)).toBeNull();
  });

  it('an uppercase Group id behaves identically and a non-UUID id is 400 INVALID_GROUP_ID', async () => {
    const G = await group('upper');
    const holder = await makeAccount('editor', 'upper');
    const appointed = await call(ROOT, 'POST', `/groups/${G.toUpperCase()}/stewards`, { accountPrincipalId: holder.toUpperCase(), role: 'owner' });
    expect(appointed.status).toBe(201);
    expect(await stewardRow(G, holder)).toMatchObject({ role: 'owner' });
    for (const [method, route] of [['POST', '/groups/not-a-uuid/stewards'], ['DELETE', `/groups/not-a-uuid/stewards/${holder}`],
      ['GET', '/groups/not-a-uuid/stewards'], ['GET', '/groups/not-a-uuid/grants']] as const) {
      const answer = await call(ROOT, method, route, method === 'POST' ? { accountPrincipalId: holder, role: 'owner' } : undefined);
      expect([answer.status, answer.json?.code]).toEqual([400, 'INVALID_GROUP_ID']);
    }
    const removed = await call(ROOT, 'DELETE', `/groups/${G.toUpperCase()}/stewards/${holder.toUpperCase()}`);
    expect(removed.status).toBe(200);
    expect(await stewardRow(G, holder)).toBeNull();
  });
});

// ═════════════════════ the stewards read ═════════════════════

describe('GET /groups/:id/stewards', () => {
  it('lists owners first with live and inertReason; principals:read admits an editor; live agrees with inertReason', async () => {
    const { G, owner, manager, member } = await team('read');
    const second = await person('read-owner-2');
    await steward(G, second.principalId, 'owner');
    await steward(G, member, 'manager');
    const listed = await stewardsOf(G, EDITOR);
    expect(listed.map((s: any) => s.role)).toEqual(['owner', 'owner', 'manager', 'manager']);
    for (const row of listed) {
      expect(Object.keys(row).sort()).toEqual(['accountPrincipalId', 'appointedAt', 'appointedByPrincipalId', 'handle',
        'inertReason', 'kind', 'live', 'role', 'status'].sort());
      expect(row.live).toBe(row.inertReason === null);
    }
    expect(listed.find((s: any) => s.accountPrincipalId === owner.principalId)).toMatchObject({ live: true });
    expect(listed.find((s: any) => s.accountPrincipalId === second.principalId)).toMatchObject({ live: false, inertReason: 'not_a_member' });
    expect(listed.find((s: any) => s.accountPrincipalId === manager.principalId)).toMatchObject({ live: true });
    const absent = await call(EDITOR, 'GET', `/groups/${crypto.randomUUID()}/stewards`);
    expect([absent.status, absent.json?.code]).toEqual([404, 'GROUP_NOT_FOUND']);
  });

  it('inertReason names the FIRST failing condition: principal_inactive before elevated_role before not_a_member', async () => {
    const G = await group('order-of-reasons');
    const holder = await makeAccount('editor', 'reasons');
    await steward(G, holder, 'manager');
    expect(await inertReasonOf(G, holder)).toBe('not_a_member');
    await pool.query(`UPDATE principals SET role = 'operator' WHERE id = $1`, [holder]);
    expect(await inertReasonOf(G, holder)).toBe('elevated_role');
    await pool.query(`UPDATE principals SET status = 'disabled' WHERE id = $1`, [holder]);
    expect(await inertReasonOf(G, holder)).toBe('principal_inactive');
  });
});

// ═════════════════════ (3) liveness ═════════════════════

/** What a steward reaches, measured four ways at once. The catalog and SR-2
 * are read through the service with the holder's id as a LOGIN SESSION would
 * pass it, so a holder whose own session is gone (disabled, terminated) is
 * still measured; the owner removal is the gate itself, rolled back. */
async function reach(G: string, holderId: string, referenceId: string): Promise<{
  inert: string | null | undefined; catalog: boolean; grants: number; removes: string;
}> {
  const projection = await directoryCarriageService.catalogProjection({ rootSession: false, stewardSessionPrincipalId: holderId });
  const catalog = projection !== null
    && (await directoryCarriageService.getReference(referenceId, { rootSession: false, stewardSessionPrincipalId: holderId })) !== null;
  const grants = (await groupStewardService.groupGrants(G, { rootSession: false, sessionPrincipalId: holderId })).length;
  const removes = await inRolledBackTransaction(async (client) => {
    try {
      await groupStewardService.requireGroupOwnerStanding(client, G, { authMethod: 'session', principalId: holderId, chainLength: 1 },
        { requiresSession: SESSION_CODE, requiresOwner: OWNER_CODE, act: 'Removing a Group manager' });
      return 'admitted';
    } catch (e: any) {
      return String(e?.code ?? e);
    }
  });
  return { inert: await inertReasonOf(G, holderId), catalog, grants, removes };
}

const LIVE_REACH = { inert: null, catalog: true, grants: 1, removes: 'admitted' };
const INERT_REACH = (reason: string) => ({ inert: reason, catalog: false, grants: 0, removes: OWNER_CODE });

async function liveTeam(label: string): Promise<Team & { ref: string }> {
  const t = await team(label);
  await groupGrant(t.G, ROOT.principalId);
  const ref = await reference(label, [t.member]);
  return { ...t, ref };
}

describe('(3) drill 3 - liveness, read at use', () => {
  it('a holder who leaves the Group is inert (not_a_member) and loses the catalog, SR-2 and owner removal; rejoining restores them', async () => {
    const { G, owner, ref } = await liveTeam('leave');
    expect(await reach(G, owner.principalId, ref)).toEqual(LIVE_REACH);
    await leave(G, owner.principalId);
    expect(await reach(G, owner.principalId, ref)).toEqual(INERT_REACH('not_a_member'));
    await join(G, owner.principalId);
    expect(await reach(G, owner.principalId, ref)).toEqual(LIVE_REACH);
  });

  it('a disabled holder is inert (principal_inactive) and loses them; re-enabled, they return', async () => {
    const { G, owner, ref } = await liveTeam('disable');
    await pool.query(`UPDATE principals SET status = 'disabled' WHERE id = $1`, [owner.principalId]);
    principalService.invalidatePrincipals([owner.principalId]);
    expect(await reach(G, owner.principalId, ref)).toEqual(INERT_REACH('principal_inactive'));
    await pool.query(`UPDATE principals SET status = 'active' WHERE id = $1`, [owner.principalId]);
    principalService.invalidatePrincipals([owner.principalId]);
    expect(await reach(G, owner.principalId, ref)).toEqual(LIVE_REACH);
  });

  it('promotion: an operator session promotes a live owner to operator; inert elevated_role everywhere; demoted to editor, each returns', async () => {
    const { G, owner, manager, ref } = await liveTeam('promote');
    const promoted = await call(OPERATOR, 'POST', `/principals/${owner.principalId}/role`, { role: 'operator' });
    expect(promoted.status).toBe(200);
    expect(await reach(G, owner.principalId, ref)).toEqual(INERT_REACH('elevated_role'));
    const fresh = await sessionFor('promoted-owner', owner.principalId);
    expect(await catalogIds(fresh)).toEqual([]);
    expect(await grantsSeenBy(fresh, G)).toEqual([]);
    const token = await stepUp(owner.principalId, G);
    const refused = await removeManager(fresh, G, manager.principalId, { stepUpToken: token });
    expect([refused.status, refused.json?.code]).toEqual([403, OWNER_CODE]);
    expect(await tokenConsumed(token)).toBe(false);
    const demoted = await call(OPERATOR, 'POST', `/principals/${owner.principalId}/role`, { role: 'editor' });
    expect(demoted.status).toBe(200);
    expect(await reach(G, owner.principalId, ref)).toEqual(LIVE_REACH);
    const back = await sessionFor('demoted-owner', owner.principalId);
    expect(await catalogIds(back)).toEqual([ref]);
  });

  it('promotion to admin or orchestrator by an admin session: inert elevated_role and no owner removal; the catalog and SR-2 answer through the root arm', async () => {
    for (const role of ['admin', 'orchestrator']) {
      const { G, owner, manager, ref } = await liveTeam(`promote-${role}`);
      const promoted = await call(ROOT, 'POST', `/principals/${owner.principalId}/role`, { role });
      expect(promoted.status).toBe(200);
      const steward = await reach(G, owner.principalId, ref);
      expect(steward).toEqual(INERT_REACH('elevated_role'));
      const asRoot = await sessionFor(`promoted-${role}`, owner.principalId);
      const refused = await removeManager(asRoot, G, manager.principalId, { stepUpToken: await stepUp(owner.principalId, G) });
      expect([refused.status, refused.json?.code]).toEqual([403, OWNER_CODE]);
      expect(await catalogIds(asRoot)).toContain(ref);
      const grants = await grantsSeenBy(asRoot, G);
      expect(grants).toHaveLength(1);
      expect(grants[0]).toHaveProperty('grantedByPrincipalId', ROOT.principalId);
    }
  });

  it('termination by a legacy root bearer leaves the row in place and inert, writes no steward removal, and GROUP_HAS_STEWARDS holds until root removes it', async () => {
    const { G, owner, manager, ref } = await liveTeam('terminate-bearer');
    const before = (await pool.query('SELECT count(*)::int AS n FROM group_stewards')).rows[0].n;
    const terminated = await call(ROOT_BEARER, 'POST', `/principals/${owner.principalId}/terminate`, {});
    expect(terminated.status).toBe(200);
    expect((await pool.query('SELECT count(*)::int AS n FROM group_stewards')).rows[0].n).toBe(before);
    expect(await successAudits('group.steward_remove', G)).toEqual([]);
    expect(await reach(G, owner.principalId, ref)).toEqual(INERT_REACH('principal_inactive'));
    const bearerRemove = await call(ROOT_BEARER, 'DELETE', `/groups/${G}/stewards/${owner.principalId}`);
    expect(bearerRemove.json?.code).toBe('REQUIRES_LOGIN_SESSION');
    for (const id of [manager.principalId]) await call(ROOT, 'DELETE', `/groups/${G}/stewards/${id}`);
    await pool.query('DELETE FROM group_members WHERE group_id = $1', [G]);
    expect((await call(ROOT, 'DELETE', `/groups/${G}`)).json?.code).toBe('GROUP_HAS_STEWARDS');
    expect((await call(ROOT, 'DELETE', `/groups/${G}/stewards/${owner.principalId}`)).status).toBe(200);
    expect((await call(ROOT, 'DELETE', `/groups/${G}`)).status).toBe(200);
  });

  it('termination by a root login session: the same - the row stays, inert, and no steward removal is written', async () => {
    const { G, owner, ref } = await liveTeam('terminate-session');
    const terminated = await call(ROOT, 'POST', `/principals/${owner.principalId}/terminate`, {});
    expect(terminated.status).toBe(200);
    expect(await stewardRow(G, owner.principalId)).toMatchObject({ role: 'owner' });
    expect(await successAudits('group.steward_remove', G)).toEqual([]);
    expect(await reach(G, owner.principalId, ref)).toEqual(INERT_REACH('principal_inactive'));
  });
});

// ═════════════════════ (O) owner removal of a manager row ═════════════════════

describe('(O) a Group owner removes a MANAGER row (C.4 removal, E98 Q3)', () => {
  it('admitted: a live owner on a login session with a step-up removes a manager row; audited standing group-owner with stepUpTokenId; the token is spent', async () => {
    const { G, owner, manager } = await team('owner-admitted');
    const token = await stepUp(owner.principalId, G);
    const removed = await removeManager(owner, G, manager.principalId, { stepUpToken: token });
    expect(removed.status).toBe(200);
    expect(removed.json.removed).toEqual({ accountPrincipalId: manager.principalId, role: 'manager' });
    expect(await stewardRow(G, manager.principalId)).toBeNull();
    expect(await tokenConsumed(token)).toBe(true);
    const audits = await successAudits('group.steward_remove', G);
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({ role: 'manager', standing: 'group-owner', via: 'rest', liveAtWrite: true,
      stepUpTokenId: removed.json.stepUpTokenId, accountPrincipalId: manager.principalId });
    expect(audits[0].chain[0]).toMatchObject({ principalId: owner.principalId });
  });

  it('an inert manager row (the manager left the Group) is removable by the owner', async () => {
    const { G, owner, manager } = await team('owner-inert-target');
    await leave(G, manager.principalId);
    const removed = await removeManager(owner, G, manager.principalId, { stepUpToken: await stepUp(owner.principalId, G) });
    expect(removed.status).toBe(200);
    expect((await successAudits('group.steward_remove', G))[0]).toMatchObject({ liveAtWrite: false, standing: 'group-owner' });
  });

  it('a bearer credential holding root is refused GROUP_MANAGER_REMOVE_REQUIRES_SESSION, audited, and spends nothing', async () => {
    const { G, manager } = await team('owner-bearer');
    const token = await stepUp(ROOT_BEARER.principalId, G);
    const refused = await removeManager(ROOT_BEARER, G, manager.principalId, { stepUpToken: token });
    expect([refused.status, refused.json?.code]).toEqual([403, SESSION_CODE]);
    expect(await deniedAudit('group.steward_remove', SESSION_CODE, G)).toBe(1);
    expect(await tokenConsumed(token)).toBe(false);
    expect(await stewardRow(G, manager.principalId)).not.toBeNull();
  });

  it("the owner's own Connector is refused GROUP_MANAGER_REMOVE_REQUIRES_SESSION", async () => {
    const { G, owner, manager } = await team('owner-connector');
    const connector = await connectorOf(owner);
    const token = await stepUp(owner.principalId, G);
    const refused = await removeManager(connector, G, manager.principalId, { stepUpToken: token });
    expect([refused.status, refused.json?.code]).toEqual([403, SESSION_CODE]);
    expect(await tokenConsumed(token)).toBe(false);
  });

  it('a manager caller, an owner of another Group and a root session holding no owner row are refused GROUP_MANAGER_REMOVE_REQUIRES_OWNER', async () => {
    const { G, manager, member } = await team('owner-not-owner');
    await steward(G, member, 'manager');
    const elsewhere = await team('owner-elsewhere');
    for (const who of [manager, elsewhere.owner, ROOT]) {
      const token = await stepUp(who.principalId, G);
      const refused = await removeManager(who, G, member, { stepUpToken: token });
      expect([refused.status, refused.json?.code]).toEqual([403, OWNER_CODE]);
      expect(await tokenConsumed(token)).toBe(false);
    }
    expect(await deniedAudit('group.steward_remove', OWNER_CODE, G)).toBe(3);
    expect(await stewardRow(G, member)).not.toBeNull();
  });

  it('an inert owner (left the Group) and an operator-promoted owner are refused GROUP_MANAGER_REMOVE_REQUIRES_OWNER', async () => {
    const left = await team('owner-left');
    await leave(left.G, left.owner.principalId);
    const t1 = await stepUp(left.owner.principalId, left.G);
    const refusedLeft = await removeManager(left.owner, left.G, left.manager.principalId, { stepUpToken: t1 });
    expect([refusedLeft.status, refusedLeft.json?.code]).toEqual([403, OWNER_CODE]);
    expect(await tokenConsumed(t1)).toBe(false);
    const promoted = await team('owner-promoted');
    expect((await call(OPERATOR, 'POST', `/principals/${promoted.owner.principalId}/role`, { role: 'operator' })).status).toBe(200);
    const session = await sessionFor('promoted', promoted.owner.principalId);
    const t2 = await stepUp(promoted.owner.principalId, promoted.G);
    const refusedPromoted = await removeManager(session, promoted.G, promoted.manager.principalId, { stepUpToken: t2 });
    expect([refusedPromoted.status, refusedPromoted.json?.code]).toEqual([403, OWNER_CODE]);
    expect(await tokenConsumed(t2)).toBe(false);
  });

  it("an owner row is STEWARD_OWNER_ROW_ROOT_ONLY, the caller's own included; an absent row is STEWARD_NOT_FOUND", async () => {
    const { G, owner, member } = await team('owner-row');
    const second = await person('owner-row-2');
    await join(G, second.principalId);
    await steward(G, second.principalId, 'owner');
    const token = await stepUp(owner.principalId, G);
    for (const target of [second.principalId, owner.principalId]) {
      const refused = await removeManager(owner, G, target, { stepUpToken: token });
      expect([refused.status, refused.json?.code]).toEqual([403, 'STEWARD_OWNER_ROW_ROOT_ONLY']);
    }
    const absent = await removeManager(owner, G, member, { stepUpToken: token });
    expect([absent.status, absent.json?.code]).toEqual([404, 'STEWARD_NOT_FOUND']);
    expect(await tokenConsumed(token)).toBe(false);
    expect(await deniedAudit('group.steward_remove', 'STEWARD_OWNER_ROW_ROOT_ONLY', G)).toBe(2);
    expect(await stewardRow(G, second.principalId)).toMatchObject({ role: 'owner' });
  });

  it('a missing or invalid step-up is answered after the target: an owner row is STEWARD_OWNER_ROW_ROOT_ONLY and an absent row STEWARD_NOT_FOUND, never STEP_UP_REQUIRED', async () => {
    // Review r1 R2: step 4 precedes step 5 for EVERY token, not only a valid one.
    const { G, owner, member } = await team('owner-target-first');
    const second = await person('owner-target-first-2');
    await join(G, second.principalId);
    await steward(G, second.principalId, 'owner');
    const other = await group('owner-target-first-other');
    const bodies: Array<Record<string, unknown>> = [
      {},
      { stepUpToken: 'not-a-step-up-token' },
      { stepUpToken: await stepUp(owner.principalId, other) },
    ];
    for (const body of bodies) {
      const ownerRow = await removeManager(owner, G, second.principalId, body);
      expect([ownerRow.status, ownerRow.json?.code]).toEqual([403, 'STEWARD_OWNER_ROW_ROOT_ONLY']);
      const absent = await removeManager(owner, G, member, body);
      expect([absent.status, absent.json?.code]).toEqual([404, 'STEWARD_NOT_FOUND']);
    }
    expect(await deniedAudit('group.steward_remove', 'STEWARD_OWNER_ROW_ROOT_ONLY', G)).toBe(bodies.length);
    expect(await deniedAudit('group.steward_remove', 'STEWARD_NOT_FOUND', G)).toBe(bodies.length);
    expect(await deniedAudit('group.steward_remove', 'STEP_UP_REQUIRED', G)).toBe(0);
    expect(await stewardRow(G, second.principalId)).toMatchObject({ role: 'owner' });
  });

  it('a missing, replayed, other-Group or appointment-bound token is STEP_UP_REQUIRED', async () => {
    const { G, owner, manager } = await team('owner-tokens');
    const other = await group('owner-tokens-other');
    const bad: Array<Record<string, unknown>> = [
      {},
      { stepUpToken: await stepUp(owner.principalId, other) },
      { stepUpToken: await stepUp(owner.principalId, G, 'group.manager_appoint') },
      { stepUpToken: await stepUp(manager.principalId, G) },
    ];
    for (const body of bad) {
      const refused = await removeManager(owner, G, manager.principalId, body);
      expect([refused.status, refused.json?.code]).toEqual([403, 'STEP_UP_REQUIRED']);
      // Card 72b8fb97 (found 15 Oct): the steward service no longer turns
      // the StepUpError into a bare Group error, so the SU-14 challenge
      // survives: the binding this act needs, and this owner's own proofs
      // (none: no password credential, no Identity link).
      expect(refused.json?.stepUp).toEqual({
        error: 'insufficient_user_authentication', action: REMOVE_ACT, targetId: G.toLowerCase(), max_age: 0, methods: [],
      });
    }
    const token = await stepUp(owner.principalId, G);
    expect((await removeManager(owner, G, manager.principalId, { stepUpToken: token })).status).toBe(200);
    await steward(G, manager.principalId, 'manager');
    const replayed = await removeManager(owner, G, manager.principalId, { stepUpToken: token });
    expect([replayed.status, replayed.json?.code]).toEqual([403, 'STEP_UP_REQUIRED']);
    expect(await stewardRow(G, manager.principalId)).not.toBeNull();
    expect(await deniedAudit('group.steward_remove', 'STEP_UP_REQUIRED', G)).toBe(5);
  });

  it('card 72b8fb97: the challenge names the methods of the OWNER acting, here a password credential', async () => {
    const { G, owner, manager } = await team('owner-challenge-password');
    await accountPasswordService.set(owner.principalId, `c1a-${tag()}-password`, { principalId: null, handle: 'c1a-suite', authMethod: 'system' });
    const refused = await removeManager(owner, G, manager.principalId, {});
    expect([refused.status, refused.json?.code]).toEqual([403, 'STEP_UP_REQUIRED']);
    expect(refused.json?.stepUp).toEqual({
      error: 'insufficient_user_authentication', action: REMOVE_ACT, targetId: G.toLowerCase(), max_age: 0, methods: ['password'],
    });
    expect(await stewardRow(G, manager.principalId)).not.toBeNull();
  });

  it('no refusal spends the token: ONE token survives a body refusal, an owner-row refusal and an absent row, then removes', async () => {
    const { G, owner, manager, member } = await team('owner-survives');
    const token = await stepUp(owner.principalId, G);
    expect((await removeManager(owner, G, manager.principalId, { stepUpToken: token, role: 'manager' })).json?.code).toBe('UNKNOWN_FIELD');
    expect((await removeManager(owner, G, owner.principalId, { stepUpToken: token })).json?.code).toBe('STEWARD_OWNER_ROW_ROOT_ONLY');
    expect((await removeManager(owner, G, member, { stepUpToken: token })).json?.code).toBe('STEWARD_NOT_FOUND');
    expect(await tokenConsumed(token)).toBe(false);
    expect((await removeManager(owner, G, manager.principalId, { stepUpToken: token })).status).toBe(200);
    expect(await tokenConsumed(token)).toBe(true);
  });

  it('an uppercase Group id removes with a token minted for the lowercase id; a non-UUID id is 400 before anything', async () => {
    const { G, owner, manager } = await team('owner-upper');
    const token = await stepUp(owner.principalId, G);
    const bad = await removeManager(owner, 'not-a-uuid', manager.principalId, { stepUpToken: token });
    expect([bad.status, bad.json?.code]).toEqual([400, 'INVALID_GROUP_ID']);
    const badTarget = await removeManager(owner, G, 'not-a-uuid', { stepUpToken: token });
    expect([badTarget.status, badTarget.json?.code]).toEqual([400, 'INVALID_GROUP_VALUE']);
    expect(await tokenConsumed(token)).toBe(false);
    const removed = await removeManager(owner, G.toUpperCase(), manager.principalId.toUpperCase(), { stepUpToken: token });
    expect(removed.status).toBe(200);
    expect(await stewardRow(G, manager.principalId)).toBeNull();
  });
});

// ═════════════════════ (9) the catalog steward row and SR-2 ═════════════════════

describe('(9) drill 9 - the catalog steward row (A-L35-c, A-L36) and SR-2', () => {
  it('A-L35-c: a live steward sees only the references carried by active members of its Groups, with no identities at any depth', async () => {
    const { G, owner, manager, member } = await team('catalog');
    const outsider = await makeAccount('editor', 'catalog-outsider');
    const inside = await reference('catalog-inside', [member]);
    const ownInside = await reference('catalog-own', [manager.principalId]);
    const outside = await reference('catalog-outside', [outsider]);
    for (const who of [owner, manager]) {
      const answer = await call(who, 'GET', '/directory-group-references');
      expect(answer.status).toBe(200);
      const ids = answer.json.references.map((r: any) => r.id).sort();
      expect(ids).toEqual([inside, ownInside].sort());
      expect(ids).not.toContain(outside);
      const people = [owner.principalId, manager.principalId, member, outsider, ROOT.principalId];
      expect(uuidsIn(answer.json).filter((id) => people.includes(id))).toEqual([]);
      expect(JSON.stringify(answer.json)).not.toMatch(/c1a-catalog-(owner|manager|member|outsider)-/);
    }
    void G;
  });

  it('A-L36: memberCount and sources are computed over the projected set, not the true count', async () => {
    const { owner, member } = await team('count');
    const outsiders = [await makeAccount('editor', 'count-a'), await makeAccount('editor', 'count-b')];
    const shared = await reference('count', [member, ...outsiders]);
    await pool.query(`INSERT INTO account_directory_group_references (directory_group_reference_id, account_principal_id, source)
                      VALUES ($1, $2, 'scim')`, [shared, outsiders[0]]);
    const asSteward = await call(owner, 'GET', `/directory-group-references/${shared}`);
    expect(asSteward.status).toBe(200);
    expect(asSteward.json.reference).toMatchObject({ memberCount: 1, sources: ['claim'] });
    const asRoot = await call(ROOT, 'GET', `/directory-group-references/${shared}`);
    expect(asRoot.json.reference).toMatchObject({ memberCount: 3, sources: ['claim', 'scim'] });
  });

  it('a disabled member carrier leaves the steward projection: what it alone carries is hidden, and counts exclude it; re-enabled, it returns', async () => {
    // Review r1 R1: the projection's carrier test (an ACTIVE member) is
    // load-bearing. The steward stays live throughout; only the carrier moves.
    const { G, owner, member } = await team('carrier-disabled');
    const second = await makeAccount('editor', 'carrier-second');
    await join(G, second);
    const solo = await reference('carrier-solo', [member]);
    const shared = await reference('carrier-shared', [member, second]);
    expect(await catalogIds(owner)).toEqual([solo, shared].sort());
    await pool.query(`UPDATE principals SET status = 'disabled' WHERE id = $1`, [member]);
    principalService.invalidatePrincipals([member]);
    expect(await inertReasonOf(G, owner.principalId)).toBeNull();
    expect(await catalogIds(owner)).toEqual([shared]);
    const hidden = await call(owner, 'GET', `/directory-group-references/${solo}`);
    const absent = await call(owner, 'GET', `/directory-group-references/${crypto.randomUUID()}`);
    expect([hidden.status, hidden.text]).toEqual([absent.status, absent.text]);
    const counted = await call(owner, 'GET', `/directory-group-references/${shared}`);
    expect(counted.status).toBe(200);
    expect(counted.json.reference).toMatchObject({ memberCount: 1 });
    expect((await call(ROOT, 'GET', `/directory-group-references/${shared}`)).json.reference).toMatchObject({ memberCount: 2 });
    await pool.query(`UPDATE principals SET status = 'active' WHERE id = $1`, [member]);
    principalService.invalidatePrincipals([member]);
    expect(await catalogIds(owner)).toEqual([solo, shared].sort());
  });

  it('outside the steward projection a point read is the same 404 as an absent id; inside it answers 200', async () => {
    const { owner, member } = await team('point');
    const inside = await reference('point-in', [member]);
    const outside = await reference('point-out', [await makeAccount('editor', 'point-out')]);
    expect((await call(owner, 'GET', `/directory-group-references/${inside}`)).status).toBe(200);
    const hidden = await call(owner, 'GET', `/directory-group-references/${outside}`);
    const absent = await call(owner, 'GET', `/directory-group-references/${crypto.randomUUID()}`);
    expect([hidden.status, hidden.text]).toEqual([absent.status, absent.text]);
    expect(hidden.status).toBe(404);
  });

  it("a bearer (the steward's own Connector) and an inert steward get []", async () => {
    const { G, owner, manager, member } = await team('catalog-bearer');
    const ref = await reference('catalog-bearer', [member]);
    const connector = await connectorOf(owner);
    expect(await catalogIds(connector)).toEqual([]);
    expect((await call(connector, 'GET', `/directory-group-references/${ref}`)).status).toBe(404);
    expect(await catalogIds(manager)).toEqual([ref]);
    await leave(G, manager.principalId);
    expect(await catalogIds(manager)).toEqual([]);
  });

  it('a bearer credential held by a live steward Account ITSELF gets [] from the catalog', async () => {
    const { G, member } = await team('steward-bearer-catalog');
    const ref = await reference('steward-bearer-catalog', [member]);
    const holder = await stewardBearer(G);
    expect(await catalogIds(holder.session)).toEqual([ref]);
    expect(await catalogIds(holder.bearer)).toEqual([]);
    expect((await call(holder.bearer, 'GET', `/directory-group-references/${ref}`)).status).toBe(404);
  });

  it('a bearer credential held by a live steward Account ITSELF gets [] from SR-2', async () => {
    const { G } = await team('steward-bearer-sr2');
    await groupGrant(G, ROOT.principalId);
    const holder = await stewardBearer(G);
    expect(await grantsSeenBy(holder.session, G)).toHaveLength(1);
    expect(await grantsSeenBy(holder.bearer, G)).toEqual([]);
  });

  it('a non-steward login session gets []; root sees every row as before', async () => {
    const { member } = await team('catalog-root');
    const ref = await reference('catalog-root', [member]);
    expect(await catalogIds(EDITOR)).toEqual([]);
    expect(await catalogIds(ROOT)).toContain(ref);
    expect(await catalogIds(ROOT_BEARER)).toEqual([]);
  });

  it('SR-2: a root login session sees the Group grants with grantedByPrincipalId', async () => {
    const { G } = await team('sr2-root');
    const grant = await groupGrant(G, ROOT.principalId);
    const grants = await grantsSeenBy(ROOT, G);
    expect(grants.map((g: any) => g.id)).toEqual([grant]);
    expect(grants[0]).toMatchObject({ granteeType: 'group', granteeId: G, grantedByPrincipalId: ROOT.principalId });
    const absent = await call(ROOT, 'GET', `/groups/${crypto.randomUUID()}/grants`);
    expect([absent.status, absent.json?.code]).toEqual([404, 'GROUP_NOT_FOUND']);
  });

  it('SR-2: a live owner and a live manager see them without grantedByPrincipalId', async () => {
    const { G, owner, manager } = await team('sr2-steward');
    const grant = await groupGrant(G, ROOT.principalId);
    for (const who of [owner, manager]) {
      const grants = await grantsSeenBy(who, G);
      expect(grants.map((g: any) => g.id)).toEqual([grant]);
      expect(grants[0]).not.toHaveProperty('grantedByPrincipalId');
      expect(JSON.stringify(grants)).not.toContain(ROOT.principalId);
    }
  });

  it('SR-2: a non-steward session, a steward of another Group, an inert steward and a bearer get 200 []', async () => {
    const { G, owner, manager } = await team('sr2-empty');
    await groupGrant(G, ROOT.principalId);
    const elsewhere = await team('sr2-elsewhere');
    const connector = await connectorOf(owner);
    await leave(G, manager.principalId);
    for (const who of [EDITOR, elsewhere.owner, manager, connector, ROOT_BEARER]) {
      expect(await grantsSeenBy(who, G)).toEqual([]);
    }
    expect((await call(EDITOR, 'GET', `/groups/${crypto.randomUUID()}/grants`)).json).toEqual({ success: true, grants: [] });
  });
});

// ═════════════════════ (10) nothing wider than E57 ═════════════════════

describe('(10) drill 10, c1-A legs - nothing wider than E57', () => {
  it('no owner appoints an owner: POST /groups/:id/stewards stops an owner session at the root ceiling, and POST /groups/:id/managers writes nothing without its gate', async () => {
    const { G, owner, member } = await team('no-appoint');
    const viaStewards = await call(owner, 'POST', `/groups/${G}/stewards`, { accountPrincipalId: member, role: 'manager' });
    expect([viaStewards.status, viaStewards.json?.code]).toEqual([403, 'FORBIDDEN']);
    // LENSES-c c1-B (card b5c83682): the managers route exists now; without a
    // valid step-up the owner is refused, a role key is refused by name, and
    // root holding no owner row is no owner (lensesGatesLive.test.ts drills it).
    const viaManagers = await call(owner, 'POST', `/groups/${G}/managers`, { accountPrincipalId: member, stepUpToken: 'x' });
    expect([viaManagers.status, viaManagers.json?.code]).toEqual([403, 'STEP_UP_REQUIRED']);
    const asOwnerRole = await call(owner, 'POST', `/groups/${G}/managers`, { accountPrincipalId: member, role: 'owner' });
    expect([asOwnerRole.status, asOwnerRole.json?.code]).toEqual([400, 'UNKNOWN_FIELD']);
    const asRoot = await call(ROOT, 'POST', `/groups/${G}/managers`, { accountPrincipalId: member });
    expect([asRoot.status, asRoot.json?.code]).toEqual([403, 'GROUP_MANAGER_APPOINT_REQUIRES_OWNER']);
    expect(await stewardRow(G, member)).toBeNull();
  });

  it('MCP: no tool names a Group role or reaches /groups', () => {
    const names = MCP_TOOLS.map((tool: { name: string }) => tool.name);
    expect(names.length).toBeGreaterThan(20);
    expect(names.filter((name: string) => /steward|manager|group_role|_group_/.test(name))).toEqual([]);
    const registry = fs.readFileSync(path.join(__dirname, '..', 'mcp', 'registry.ts'), 'utf8');
    expect(registry).not.toMatch(/['`]\/groups/);
  });

  it("no act writes a grant: origin='steward' stays dormant after every steward act", async () => {
    const steward = await pool.query(`SELECT count(*)::int AS n FROM grants WHERE origin = 'steward'`);
    expect(steward.rows[0].n).toBe(0);
  });
});

// ═════════════════════ (U) concurrency (U-6) ═════════════════════

describe('(U) U-6 - the gate holds its locks against concurrent removals', () => {
  it("an owner's standing check holds the owner's member row: removeMember waits until the act commits", async () => {
    const { G, owner } = await team('u6-member');
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await groupStewardService.requireGroupOwnerStanding(client, G,
        { authMethod: 'session', principalId: owner.principalId, chainLength: 1 },
        { requiresSession: SESSION_CODE, requiresOwner: OWNER_CODE, act: 'Removing a Group manager' });
      let settled = false;
      const removal = groupService.removeMember(G, owner.principalId,
        { principalId: ROOT.principalId, handle: 'c1a-u6', authMethod: 'session' }).then(() => { settled = true; });
      await new Promise((resolve) => setTimeout(resolve, 750));
      expect(settled).toBe(false);
      const waiting = await pool.query(
        `SELECT count(*)::int AS n FROM pg_stat_activity WHERE wait_event_type = 'Lock' AND query LIKE 'DELETE FROM group_members%'`);
      expect(waiting.rows[0].n).toBeGreaterThanOrEqual(1);
      await client.query('COMMIT');
      await removal;
      expect(settled).toBe(true);
    } finally {
      await client.query('ROLLBACK').catch(() => undefined);
      client.release();
    }
    expect(await inertReasonOf(G, owner.principalId)).toBe('not_a_member');
  });

  it("a directory snapshot delete of the owner's member row waits on the same lock", async () => {
    const { G, owner } = await team('u6-snapshot');
    await pool.query(`UPDATE group_members SET source = 'directory' WHERE group_id = $1 AND account_principal_id = $2`, [G, owner.principalId]);
    const gate = await pool.connect();
    const other = await pool.connect();
    try {
      await gate.query('BEGIN');
      await groupStewardService.requireGroupOwnerStanding(gate, G,
        { authMethod: 'session', principalId: owner.principalId, chainLength: 1 },
        { requiresSession: SESSION_CODE, requiresOwner: OWNER_CODE, act: 'Removing a Group manager' });
      await other.query('BEGIN');
      await other.query(`SET LOCAL lock_timeout = '500ms'`);
      // The directory sink's own statement (GroupService.applyAccountDirectorySnapshot).
      await expect(other.query('DELETE FROM group_members WHERE group_id = $1 AND account_principal_id = $2', [G, owner.principalId]))
        .rejects.toThrow(/lock timeout/);
      await other.query('ROLLBACK');
      await gate.query('COMMIT');
      const after = await other.query('DELETE FROM group_members WHERE group_id = $1 AND account_principal_id = $2 RETURNING 1',
        [G, owner.principalId]);
      expect(after.rows).toHaveLength(1);
    } finally {
      await gate.query('ROLLBACK').catch(() => undefined);
      await other.query('ROLLBACK').catch(() => undefined);
      gate.release();
      other.release();
    }
  });

  it('a catalog read during an uncommitted owner removal neither blocks nor sees the removal; after the commit the manager is out', async () => {
    const { G, owner, manager, member } = await team('u6-catalog');
    const ref = await reference('u6-catalog', [member]);
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await groupStewardService.requireGroupOwnerStanding(client, G,
        { authMethod: 'session', principalId: owner.principalId, chainLength: 1 },
        { requiresSession: SESSION_CODE, requiresOwner: OWNER_CODE, act: 'Removing a Group manager' });
      await client.query('DELETE FROM group_stewards WHERE group_id = $1 AND account_principal_id = $2', [G, manager.principalId]);
      const started = Date.now();
      expect(await catalogIds(manager)).toEqual([ref]);
      expect(Date.now() - started).toBeLessThan(5000);
      await client.query('COMMIT');
    } finally {
      await client.query('ROLLBACK').catch(() => undefined);
      client.release();
    }
    expect(await catalogIds(manager)).toEqual([]);
  });
});
