/**
 * Card 20f40e40 — AZ-A12 build 1: "Groups become principals" (RATIFIED
 * 2026-10-10, ruling E72; AUTHZ AMENDMENTS COMPANION 2 003511f6, clauses 1-3
 * and 15 M-a), over a REAL PostgreSQL, the PRODUCTION router and the MCP
 * ingress.
 *
 * A Group is also a principal of kind 'group' with the same id. This suite
 * measures, on stored rows:
 *
 *   (M) migration 146: it re-applies cleanly; on a database holding Groups,
 *       members, grants, home pointers and login gates from before it, it
 *       writes exactly one kind=group principal per Group with the canonical
 *       handle and nothing else, and a second run is a no-op; its self-checks
 *       and post-check stop it by name. Each of those runs inside a
 *       transaction this suite rolls back.
 *   (5) drill 5: every clause-3 refusal, through the router, the MCP ingress
 *       and raw SQL, BOTH directions (a person or service id answers as it did
 *       before); each of the seven /principals/:id mutations refuses a Group
 *       with GROUP_PRINCIPAL_MANAGED_BY_GROUPS, first, with both rows
 *       byte-unchanged and a durable audit row; the directory lists no Group
 *       unless asked; a Group token is 401 on both JWT paths.
 *   (7) drill 7: GROUP_OWNS_OBJECTS answers counts and never ids; a cleared
 *       Group deletes with its principal terminated (terminated_at stamped),
 *       its row and its grants gone; the three existing refusals still answer
 *       first; a raw-SQL Group project owner gives its member the use tier
 *       only (the evaluator arm is AZ-A12 build 2's, card ee81ee0f).
 *  (12) drill 12: PUT /groups/:id/ownership-status, both directions: the root
 *       ceiling, the login-session test, the step-up bound to
 *       (group.ownership_status, canonical id) and never spent by a refusal
 *       that precedes it, the audit rows, note N3, and an uppercase path id.
 *   (W) the two writers create the principal in the same statement, a rename
 *       carries the display name, and the Group read carries ownershipStatus.
 *
 * Every probe that a defect could turn into a stored bad row runs inside a
 * transaction that is rolled back, so a mutation drill run against this
 * suite never leaves residue for the next run.
 *
 * DESTRUCTIVE: writes principals, groups, grants, projects, tasks, reports,
 * step-up tokens and audit rows. It refuses any deployment database and any
 * non-local host, and FAILS - never skips - without a disposable one.
 */

/* eslint-disable @typescript-eslint/no-var-requires */

import http from 'http';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

const TEST_DB_URL = process.env.RELAYHALL_TEST_DB_URL;
if (!TEST_DB_URL) {
  throw new Error('RELAYHALL_TEST_DB_URL is required: the Group principal drill measures stored principal, group, '
    + 'grant, task and audit rows, so it never skips. Load database/init.sql into a disposable database, run '
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
  throw new Error('Group principal drill refuses a non-disposable database target');
}

const JWT_SECRET = crypto.randomBytes(32).toString('hex');
Object.assign(process.env, {
  DB_HOST: parsed.hostname, DB_PORT: parsed.port || '5432', DB_NAME: TEST_DB_NAME,
  DB_USER: decodeURIComponent(parsed.username), DB_PASSWORD: decodeURIComponent(parsed.password),
  NODE_ENV: 'test', RELAYHALL_SESSIONS: 'on', JWT_SECRET,
});

const express = require('express');
const jwt = require('jsonwebtoken');
const { pool } = require('../db/connection');
const { registerProtectedRoutes } = require('../routeRegistry');
const { authMiddleware } = require('../middleware/auth');
const { sharedAuthorizationMiddleware } = require('../middleware/sharedAuthorization');
const { apiErrorHandler } = require('../utils/apiErrors');
const { jsonBodyOptions } = require('../utils/jsonBodyTypes');
const { loginSessionService, SESSION_COOKIE_NAME } = require('../services/LoginSessionService');
const { stepUpService } = require('../services/StepUpService');
const { principalService } = require('../services/PrincipalService');
const { accessProfileService } = require('../services/AccessProfileService');
const { directoryCarriageService } = require('../services/DirectoryCarriageService');
const { accessSurfaceService, UNGOVERNED_ROOT_FAMILIES } = require('../services/AccessSurfaceService');
const { insertGroupRow } = require('./support/groupRows');
const mcpRoutes = require('../mcp/httpRoute').default;
const { MCP_ROUTE_PATH } = require('../mcp/httpRoute');

jest.setTimeout(180_000);

const MIGRATION_FILE = path.join(__dirname, '..', 'migrations', '146_group_principal_kind.sql');
const OWNERSHIP_ACT = 'group.ownership_status';
const MANAGED = 'GROUP_PRINCIPAL_MANAGED_BY_GROUPS';
const SYSTEM = { principalId: null, handle: 'az12-b1-drill', authMethod: 'system' };

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

async function mcpCall(who: Caller, name: string, args: Record<string, unknown> = {}): Promise<Answer> {
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

const tag = (): string => crypto.randomBytes(5).toString('hex');

async function makeAccount(role: string | null, label: string, kind: 'human' | 'service' = 'human'): Promise<string> {
  const result = await pool.query(
    `INSERT INTO principals (kind, handle, display_name, status, role, purpose)
     VALUES ($1, $2, $2, 'active', $3, $4) RETURNING id`,
    [kind, `az12-${label}-${tag()}`, role, kind === 'service' ? 'AZ-A12 build 1 drill service Account' : null],
  );
  return String(result.rows[0].id);
}

async function sessionFor(label: string, principalId: string): Promise<Caller> {
  const minted = await loginSessionService.mint({ principalId });
  return { label, principalId, headers: { Cookie: `${SESSION_COOKIE_NAME}=${minted.token}` } };
}

/** A principal_api_key bearer HOLDING root: unmintable through any door
 * (ROOT_NOT_MINTABLE, rule 2), so it is minted narrow and widened in raw SQL,
 * exactly as the lenses-b drill builds one. It is the bearer the ownership-
 * status act must refuse by its acting channel, not by its scopes. */
async function rootBearerFor(label: string, accountId: string): Promise<Caller> {
  const created = await pool.query(
    `INSERT INTO principals (kind, handle, display_name, status, role, parent_principal_id)
     VALUES ('service', $1, $1, 'active', 'user', $2) RETURNING id`,
    [`az12-bearer-${tag()}`, accountId],
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

async function registerConnector(owner: Caller, scopes: string[]): Promise<Caller> {
  const slug = `az12-connector-${tag()}`;
  const registered = await call(owner, 'POST', '/services', {
    slug, name: slug, description: 'AZ-A12 build 1 drill connector.', kind: 'connector',
    issueCredential: { scopes, label: slug, transport: 'any' },
  });
  expect(registered.status).toBe(201);
  const row = await pool.query('SELECT principal_id FROM services WHERE slug = $1', [slug]);
  return {
    label: slug, principalId: String(row.rows[0].principal_id),
    headers: { Authorization: `Bearer ${registered.json.onboarding.credential.secretOnce}` },
  };
}

/** A Group written in raw SQL through the one shared fixture. */
async function group(label: string, featured = false): Promise<string> {
  return insertGroupRow(pool, { name: `az12 ${label} ${tag()}`, description: 'AZ-A12 build 1 drill', featured });
}

async function project(owner: Caller, label: string): Promise<string> {
  const created = await call(owner, 'POST', '/projects', { name: `AZ12 ${label} ${tag()}` });
  expect(created.status).toBe(201);
  return String(created.json.project.id);
}

async function task(owner: Caller, title: string, projectId?: string): Promise<string> {
  const created = await call(owner, 'POST', '/tasks', {
    title, description: 'AZ-A12 build 1 drill', status: 'todo', ...(projectId ? { project: projectId } : {}),
  });
  expect(created.status).toBe(201);
  return String(created.json.task.id);
}

async function report(authorId: string, taskId: string): Promise<string> {
  const row = await pool.query(
    `INSERT INTO reports (title, content, summary, task_ids, author_principal_id, author_actor_id, origin)
     VALUES ('AZ12 drill report', 'AZ-A12 build 1 drill evidence.', 'drill', $1, $2::uuid, $2::uuid::text, 'api')
     RETURNING id`,
    [[taskId], authorId],
  );
  return String(row.rows[0].id);
}

/** Run one statement inside a transaction that is ALWAYS rolled back, and say
 * whether the database admitted it. A refusal is reported with its message. */
async function probe(sql: string, params: unknown[] = []): Promise<{ admitted: boolean; message: string; constraint: string | null }> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    try {
      await client.query(sql, params);
      return { admitted: true, message: '', constraint: null };
    } catch (error: any) {
      return { admitted: false, message: String(error?.message ?? error), constraint: error?.constraint ?? null };
    }
  } finally {
    await client.query('ROLLBACK').catch(() => undefined);
    client.release();
  }
}

/** Run `body` inside a transaction that is ALWAYS rolled back. */
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

const migrationSql = (): string => fs.readFileSync(MIGRATION_FILE, 'utf8');

async function rowOf(table: 'principals' | 'groups', id: string): Promise<string | null> {
  const row = await pool.query(`SELECT row_to_json(t)::text AS j FROM ${table} t WHERE id = $1`, [id]);
  return row.rows[0]?.j ?? null;
}

async function tokenConsumed(tokenValue: string): Promise<boolean> {
  const hash = crypto.createHash('sha256').update(tokenValue).digest('hex');
  const row = await pool.query('SELECT consumed_at FROM step_up_tokens WHERE token_hash = $1', [hash]);
  return row.rows[0]?.consumed_at != null;
}

async function deniedAudit(action: string, refusal: string, resourceId: string): Promise<number> {
  const rows = await pool.query(
    `SELECT count(*)::int AS n FROM audit_events
      WHERE action = $1 AND outcome = 'denied' AND resource_id = $2 AND metadata->>'refusal' = $3`,
    [action, resourceId, refusal],
  );
  return Number(rows.rows[0].n);
}

const signV2 = (principalId: string, handle: string, kind: string): string =>
  jwt.sign({ v: 2, sub: principalId, handle, kind }, JWT_SECRET, { expiresIn: '10m' });
const signLegacy = (handle: string): string => jwt.sign({ userId: handle }, JWT_SECRET, { expiresIn: '10m' });

let ROOT: Caller;
let OPERATOR: Caller;
let PERSON: Caller;
let MEMBER: Caller;
let ROOT_BEARER: Caller;
let READER: Caller;          // a Connector holding principals:read, for the MCP ingress
let PERSON_HANDLE: string;
let SERVICE_ACCOUNT: string; // a parentless service Account
let G_REFUSALS: string;      // the Group every refusal probe names
let G_OTHER: string;         // a second Group
let G_FEATURED: string;      // a featured Group PERSON is a member of
let PROFILE_ID: string;
let PROJECT_ID: string;
let TASK_ID: string;
let REPORT_ID: string;
let PROVIDER_ID: string;

beforeAll(async () => {
  await new Promise<void>((resolve) => { server = buildApp().listen(0, '127.0.0.1', resolve); });
  origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  ROOT = await sessionFor('root', await makeAccount('admin', 'root'));
  OPERATOR = await sessionFor('operator', await makeAccount('operator', 'operator'));
  PERSON = await sessionFor('person', await makeAccount('user', 'person'));
  MEMBER = await sessionFor('member', await makeAccount('user', 'member'));
  PERSON_HANDLE = String((await pool.query('SELECT handle FROM principals WHERE id = $1', [PERSON.principalId])).rows[0].handle);
  ROOT_BEARER = await rootBearerFor('az12-root-bearer', ROOT.principalId);
  READER = await registerConnector(PERSON, ['principals:read']);
  SERVICE_ACCOUNT = await makeAccount('user', 'svc-account', 'service');

  G_REFUSALS = await group('refusals');
  G_OTHER = await group('other');
  G_FEATURED = await group('featured', true);
  await pool.query(`INSERT INTO group_members (group_id, account_principal_id, source) VALUES ($1, $2, 'local')`,
    [G_FEATURED, PERSON.principalId]);

  const profile = await accessProfileService.create({ name: `az12-profile-${tag()}` }, SYSTEM);
  const version = await accessProfileService.createVersion(profile.id,
    [{ resourceType: 'project', selectorForm: 'all-of-type', selectorIds: [], verbs: ['read'] }], SYSTEM);
  await accessProfileService.publish(profile.id, version.id, SYSTEM);
  PROFILE_ID = String(profile.id);

  PROJECT_ID = await project(ROOT, 'refusals');
  TASK_ID = await task(ROOT, `AZ12 refusals ${tag()}`, PROJECT_ID);
  REPORT_ID = await report(ROOT.principalId, TASK_ID);

  const provider = await pool.query(
    `INSERT INTO identity_providers
       (name, status, issuer, discovery_url, client_id, subject_immutable, group_binding_mode, groups_claim)
     VALUES ($1, 'disabled', $2, $3, 'az12-drill', TRUE, 'claim', 'groups') RETURNING id`,
    [`az12 ${tag()}`, `https://issuer.invalid/az12/${tag()}`, `https://issuer.invalid/az12/${tag()}/.well-known/openid-configuration`],
  );
  PROVIDER_ID = String(provider.rows[0].id);
});

afterAll(async () => {
  if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  await pool.end();
});

// ═════════════════════ (M) migration 146 ═════════════════════

describe('(M) migration 146 - additive, idempotent, fresh-replay safe', () => {
  it('migration 146 re-applies cleanly on the migrated database', async () => {
    await pool.query(migrationSql());
    const catalog = await pool.query(
      `SELECT conname FROM pg_constraint
        WHERE conname IN ('principals_kind_check', 'principals_group_shape', 'principals_group_handle', 'groups_id_principal_fkey')
        ORDER BY conname`);
    expect(catalog.rows.map((row: any) => row.conname)).toEqual(expect.arrayContaining(['principals_kind_check']));
  });

  it('backfill: Groups from before 146 gain exactly one kind=group principal each with the canonical handle, and a second run is a no-op', async () => {
    await inRolledBackTransaction(async (client) => {
      // "Before 146": Group rows with no principal, which only a database that
      // has not run 146 can hold, so the key 146 adds is lifted for the length
      // of this rolled-back transaction.
      await client.query('ALTER TABLE groups DROP CONSTRAINT IF EXISTS groups_id_principal_fkey');
      const person = await makeAccountOn(client, 'backfill-person');
      const ids: string[] = [];
      for (const name of [`az12 pre-146 alpha ${tag()}`, `az12 pre-146 beta ${tag()}`]) {
        const row = await client.query('INSERT INTO groups (name, featured) VALUES ($1, true) RETURNING id', [name]);
        ids.push(String(row.rows[0].id));
      }
      await client.query(`INSERT INTO group_members (group_id, account_principal_id, source) VALUES ($1, $2, 'local')`, [ids[0], person]);
      await client.query(`INSERT INTO grants (grantee_type, grantee_id, resource_type, resource_id, verb)
                          VALUES ('group', $1, 'project', $2, 'read')`, [ids[0], PROJECT_ID]);
      await client.query(`INSERT INTO account_home_groups (account_principal_id, group_id, source) VALUES ($1, $2, 'self')`, [person, ids[0]]);
      await client.query('INSERT INTO identity_provider_login_groups (identity_provider_id, group_id) VALUES ($1, $2)', [PROVIDER_ID, ids[1]]);
      const counts = async () => (await client.query(
        `SELECT (SELECT count(*)::int FROM principals) AS principals,
                (SELECT count(*)::int FROM group_members) AS members,
                (SELECT count(*)::int FROM grants) AS grants,
                (SELECT count(*)::int FROM account_home_groups) AS homes,
                (SELECT count(*)::int FROM identity_provider_login_groups) AS gates`)).rows[0];
      const before = await counts();

      expect(await applyOn(client)).toBe('applied');
      const after = await counts();
      expect(after).toEqual({ ...before, principals: before.principals + 2 });
      for (const id of ids) {
        const rows = await client.query('SELECT p.*, g.name FROM principals p JOIN groups g ON g.id = p.id WHERE p.id = $1', [id]);
        expect(rows.rows).toHaveLength(1);
        expect(rows.rows[0]).toMatchObject({
          kind: 'group', handle: `group:${id}`, status: 'active', role: null, parent_principal_id: null,
          legacy_identity: false, terminated_at: null,
        });
        expect(rows.rows[0].display_name).toBe(rows.rows[0].name);
      }
      // No ownership is inferred (clause 4): no ownership column names a Group.
      const owners = await client.query(
        `SELECT (SELECT count(*)::int FROM projects WHERE owner_principal_id = ANY($1::uuid[]))
              + (SELECT count(*)::int FROM tasks WHERE account_owner_principal_id = ANY($1::uuid[]))
              + (SELECT count(*)::int FROM reports WHERE account_owner_principal_id = ANY($1::uuid[])) AS n`, [ids]);
      expect(owners.rows[0].n).toBe(0);

      expect(await applyOn(client)).toBe('applied');
      expect(await counts()).toEqual(after);
    });
  });

  it('self-check: a non-Group principal holding a group: handle stops the migration, naming the count', async () => {
    const outcome = await inRolledBackTransaction(async (client) => {
      await client.query('ALTER TABLE principals DROP CONSTRAINT IF EXISTS principals_group_handle');
      await client.query(`INSERT INTO principals (kind, handle, display_name, status, role)
                          VALUES ('human', $1, 'seeded', 'active', 'user')`, [`group:seeded-${tag()}`]);
      try { await client.query(migrationSql()); return 'applied'; } catch (error: any) { return String(error.message); }
    });
    expect(outcome).toMatch(/self-check: 1 existing non-Group principal handle\(s\) start with the reserved prefix group:/);
  });

  it('self-check: a non-Group principal sharing an id with a Group stops the migration, naming the count', async () => {
    const outcome = await inRolledBackTransaction(async (client) => {
      await client.query('ALTER TABLE groups DROP CONSTRAINT IF EXISTS groups_id_principal_fkey');
      const person = await makeAccountOn(client, 'shared-id');
      await client.query('INSERT INTO groups (id, name) VALUES ($1, $2)', [person, `az12 shared id ${tag()}`]);
      try { await client.query(migrationSql()); return 'applied'; } catch (error: any) { return String(error.message); }
    });
    expect(outcome).toMatch(/self-check: 1 principal row\(s\) share an id with a Group and are not of kind group/);
  });

  it('post-check: a Group whose principal lacks the canonical handle stops the migration', async () => {
    const outcome = await inRolledBackTransaction(async (client) => {
      await client.query('ALTER TABLE groups DROP CONSTRAINT IF EXISTS groups_id_principal_fkey');
      const id = crypto.randomUUID();
      await client.query(`INSERT INTO principals (id, kind, handle, display_name, status)
                          VALUES ($1, 'group', $2, 'misnamed', 'active')`, [id, `group:misnamed-${tag()}`]);
      await client.query('INSERT INTO groups (id, name) VALUES ($1, $2)', [id, `az12 misnamed ${tag()}`]);
      try { await client.query(migrationSql()); return 'applied'; } catch (error: any) { return String(error.message); }
    });
    expect(outcome).toMatch(/post-check: 1 Group\(s\) lack a kind=group principal with the handle group:<id>/);
  });
});

/** Apply migration 146 on `client`, answering 'applied' or the error text. */
async function applyOn(client: any): Promise<string> {
  try { await client.query(migrationSql()); return 'applied'; } catch (error: any) { return String(error?.message ?? error); }
}

async function makeAccountOn(client: any, label: string): Promise<string> {
  const row = await client.query(
    `INSERT INTO principals (kind, handle, display_name, status, role) VALUES ('human', $1, $1, 'active', 'user') RETURNING id`,
    [`az12-${label}-${tag()}`]);
  return String(row.rows[0].id);
}

// ═════════════════════ (W) the writers and the read model ═════════════════════

describe('(W) the Group writers create the principal; the read carries ownershipStatus', () => {
  it('POST /groups writes the Group principal in the same statement: kind group, canonical handle, display name, active, no role, no parent', async () => {
    const name = `az12 writer ${tag()}`;
    const created = await call(ROOT, 'POST', '/groups', { name });
    expect(created.status).toBe(201);
    const id = String(created.json.group.id);
    expect(id).toBe(id.toLowerCase());
    const principal = await pool.query('SELECT * FROM principals WHERE id = $1', [id]);
    expect(principal.rows[0]).toMatchObject({
      kind: 'group', handle: `group:${id}`, display_name: name, status: 'active', role: null,
      parent_principal_id: null, purpose: null, legacy_identity: false,
    });
    expect(created.json.group.ownershipStatus).toBe('active');
  });

  it('a name collision is GROUP_NAME_EXISTS, matched by the index name', async () => {
    const name = `az12 collide ${tag()}`;
    expect((await call(ROOT, 'POST', '/groups', { name })).status).toBe(201);
    const again = await call(ROOT, 'POST', '/groups', { name: name.toUpperCase() });
    expect([again.status, again.json?.code]).toEqual([409, 'GROUP_NAME_EXISTS']);
  });

  it('Use this group (the directory reference bind) writes the Group principal too', async () => {
    const reference = await directoryCarriageService.recordReference(PROVIDER_ID, `az12-ref-${tag()}`, SYSTEM);
    const used = await call(ROOT, 'POST', `/directory-group-references/${reference.id}/use`, { name: `az12 bound ${tag()}` });
    expect(used.status).toBe(201);
    const id = String(used.json.groupId);
    const principal = await pool.query('SELECT kind, handle, status, display_name FROM principals WHERE id = $1', [id]);
    expect(principal.rows[0]).toMatchObject({ kind: 'group', handle: `group:${id}`, status: 'active' });
    expect(principal.rows[0].display_name).toBe(used.json.groupName);
  });

  it('renaming a Group carries the Group principal display name in the same transaction', async () => {
    const id = await group('rename');
    const name = `az12 renamed ${tag()}`;
    const renamed = await call(ROOT, 'PATCH', `/groups/${id}`, { name });
    expect(renamed.status).toBe(200);
    const principal = await pool.query('SELECT display_name FROM principals WHERE id = $1', [id]);
    expect(principal.rows[0].display_name).toBe(name);
  });

  it('GET /groups and GET /groups/:id read ownershipStatus from the Group principal', async () => {
    const id = await group('read-model');
    await pool.query(`UPDATE principals SET status = 'disabled' WHERE id = $1`, [id]);
    const one = await call(ROOT, 'GET', `/groups/${id}`);
    expect([one.status, one.json.group.ownershipStatus]).toEqual([200, 'disabled']);
    const all = await call(ROOT, 'GET', '/groups');
    expect(all.json.groups.find((row: any) => row.id === id)?.ownershipStatus).toBe('disabled');
  });
});

// ═════════════════════ (5) drill 5: what a Group principal never is ═════════════════════

describe('(5) drill 5 - clause 3, both directions', () => {
  it('principals_group_shape: a Group principal carrying a role or an Agent column is refused; a person with a role is admitted', async () => {
    for (const [column, value] of [['role', 'user'], ['purpose', 'x'], ['source_tag', `az12-${tag()}`], ['harness', 'hermes']] as const) {
      const refused = await probe(
        `INSERT INTO principals (id, kind, handle, status, ${column}) SELECT g, 'group', 'group:' || g::text, 'active', $1
           FROM (SELECT gen_random_uuid() AS g) x`, [value]);
      expect({ column, admitted: refused.admitted, constraint: refused.constraint })
        .toEqual({ column, admitted: false, constraint: 'principals_group_shape' });
    }
    const person = await probe(`INSERT INTO principals (kind, handle, status, role) VALUES ('human', $1, 'active', 'user')`, [`az12-shape-${tag()}`]);
    expect(person.admitted).toBe(true);
  });

  it('principals_group_handle: the group: prefix belongs to kind group alone', async () => {
    const human = await probe(`INSERT INTO principals (kind, handle, status) VALUES ('human', $1, 'active')`, [`group:${tag()}`]);
    expect([human.admitted, human.constraint]).toEqual([false, 'principals_group_handle']);
    const unprefixed = await probe(`INSERT INTO principals (kind, handle, status) VALUES ('group', $1, 'active')`, [`az12-unprefixed-${tag()}`]);
    expect([unprefixed.admitted, unprefixed.constraint]).toEqual([false, 'principals_group_handle']);
    const person = await probe(`INSERT INTO principals (kind, handle, status) VALUES ('human', $1, 'active')`, [`az12-handle-${tag()}`]);
    expect(person.admitted).toBe(true);
  });

  it('principal_credentials refuses a Group principal in raw SQL; a person row is admitted', async () => {
    // A password row: the one credential type a parentless Account holds.
    const sql = `INSERT INTO principal_credentials (principal_id, credential_type, secret_hash) VALUES ($1, 'password', $2)`;
    const hash = `$2b$10$${crypto.randomBytes(40).toString('base64url').slice(0, 53)}`;
    const refused = await probe(sql, [G_REFUSALS, hash]);
    expect(refused.admitted).toBe(false);
    expect(refused.message).toMatch(/principal_credentials\.principal_id cannot name one/);
    expect((await probe(sql, [PERSON.principalId, hash])).admitted).toBe(true);
  });

  it('auth_sessions refuses a Group principal in raw SQL; a person row is admitted', async () => {
    const sql = `INSERT INTO auth_sessions (principal_id, token_hash, expires_at) VALUES ($1, $2, now() + interval '1 hour')`;
    const refused = await probe(sql, [G_REFUSALS, tag()]);
    expect(refused.admitted).toBe(false);
    expect(refused.message).toMatch(/auth_sessions\.principal_id cannot name one/);
    expect((await probe(sql, [PERSON.principalId, tag()])).admitted).toBe(true);
  });

  it('identity_links refuses a Group principal in raw SQL; a person row is admitted', async () => {
    const sql = `INSERT INTO identity_links (account_principal_id, link_kind, state, promoted_at, platform_provider, workspace_id, external_user_id)
                 VALUES ($1, 'platform', 'proven', now(), 'az12', $2, $3)`;
    const refused = await probe(sql, [G_REFUSALS, tag(), tag()]);
    expect(refused.admitted).toBe(false);
    expect(refused.message).toMatch(/identity_links\.account_principal_id cannot name one/);
    expect((await probe(sql, [PERSON.principalId, tag(), tag()])).admitted).toBe(true);
  });

  it('account_home_groups refuses a Group principal as the Account in raw SQL; a person row is admitted', async () => {
    const sql = `INSERT INTO account_home_groups (account_principal_id, group_id, source) VALUES ($1, $2, 'admin')`;
    const refused = await probe(sql, [G_REFUSALS, G_FEATURED]);
    expect(refused.admitted).toBe(false);
    expect(refused.message).toMatch(/account_home_groups\.account_principal_id cannot name one/);
    expect((await probe(sql, [MEMBER.principalId, G_FEATURED])).admitted).toBe(true);
  });

  it('a Group is never a member of a Group: POST /groups/:id/members refuses MEMBER_NOT_ACCOUNT; a person is added', async () => {
    const target = await group('member-route');
    const refused = await call(ROOT, 'POST', `/groups/${target}/members`, { accountPrincipalId: G_REFUSALS });
    expect([refused.status, refused.json?.code]).toEqual([422, 'MEMBER_NOT_ACCOUNT']);
    const added = await call(ROOT, 'POST', `/groups/${target}/members`, { accountPrincipalId: MEMBER.principalId });
    expect(added.status).toBe(201);
    const service = await call(ROOT, 'POST', `/groups/${target}/members`, { accountPrincipalId: SERVICE_ACCOUNT });
    expect(service.status).toBe(201);
  });

  it('a Group is never a member of a Group: the member trigger refuses it in raw SQL; a person row is admitted', async () => {
    const sql = `INSERT INTO group_members (group_id, account_principal_id, source) VALUES ($1, $2, 'local')`;
    const refused = await probe(sql, [G_OTHER, G_REFUSALS]);
    expect(refused.admitted).toBe(false);
    expect(refused.message).toMatch(/a Group is never a member of a Group/);
    expect((await probe(sql, [G_OTHER, MEMBER.principalId])).admitted).toBe(true);
  });

  it('a Group principal is never a chain parent: raw SQL refuses a Connector and an Agent under one; a Connector under a person is admitted', async () => {
    const connector = await probe(
      `INSERT INTO principals (kind, handle, status, parent_principal_id, purpose) VALUES ('service', $1, 'active', $2, 'drill')`,
      [`az12-conn-${tag()}`, G_REFUSALS]);
    expect(connector.admitted).toBe(false);
    expect(connector.message).toMatch(/a Group principal is never a parent/);
    const agent = await probe(
      `INSERT INTO principals (kind, handle, status, parent_principal_id, bound_task_id) VALUES ('agent', $1, 'active', $2, $3)`,
      [`az12-agent-${tag()}`, G_REFUSALS, TASK_ID]);
    expect(agent.admitted).toBe(false);
    expect(agent.message).toMatch(/a Group principal is never a parent/);
    const person = await probe(
      `INSERT INTO principals (kind, handle, status, parent_principal_id, purpose) VALUES ('service', $1, 'active', $2, 'drill')`,
      [`az12-conn-${tag()}`, PERSON.principalId]);
    expect(person.admitted).toBe(true);
  });

  it('a parented Group principal is refused by the chain trigger by name', async () => {
    const refused = await probe(
      `INSERT INTO principals (id, kind, handle, status, parent_principal_id)
       SELECT g, 'group', 'group:' || g::text, 'active', $1 FROM (SELECT gen_random_uuid() AS g) x`, [PERSON.principalId]);
    expect(refused.admitted).toBe(false);
    expect(refused.message).toMatch(/a Group principal is parentless/);
  });

  it('Connector registration under a Group owner is refused CONNECTOR_NEEDS_ACCOUNT; under a person it registers', async () => {
    const slug = `az12-group-owned-${tag()}`;
    const refused = await call(ROOT, 'POST', '/services', {
      slug, name: slug, description: 'AZ-A12 drill.', kind: 'connector', ownerAccountId: G_REFUSALS,
    });
    expect([refused.status, refused.json?.code]).toEqual([422, 'CONNECTOR_NEEDS_ACCOUNT']);
    expect((await pool.query('SELECT count(*)::int AS n FROM services WHERE slug = $1', [slug])).rows[0].n).toBe(0);
    const allowedSlug = `az12-person-owned-${tag()}`;
    const registered = await call(ROOT, 'POST', '/services', {
      slug: allowedSlug, name: allowedSlug, description: 'AZ-A12 drill.', kind: 'connector', ownerAccountId: PERSON.principalId,
    });
    expect(registered.status).toBe(201);
  });

  it("grants: granteeType 'principal' naming a Group is refused GROUP_PRINCIPAL_NOT_A_GRANTEE; granteeType 'group' and a person still work", async () => {
    const base = { resourceType: 'project', resourceId: PROJECT_ID, verb: 'read' };
    const refused = await call(ROOT, 'POST', '/grants', { ...base, granteeType: 'principal', granteeId: G_REFUSALS });
    expect([refused.status, refused.json?.code]).toEqual([422, 'GROUP_PRINCIPAL_NOT_A_GRANTEE']);
    expect(refused.json.message).toMatch(/granteeType 'group'/);
    const asGroup = await call(ROOT, 'POST', '/grants', { ...base, granteeType: 'group', granteeId: G_REFUSALS });
    expect(asGroup.status).toBe(201);
    const asPerson = await call(ROOT, 'POST', '/grants', { ...base, granteeType: 'principal', granteeId: await makeAccount('user', 'grantee') });
    expect(asPerson.status).toBe(201);
  });

  it("profiles: assigneeType 'principal' naming a Group is refused GROUP_PRINCIPAL_NOT_A_GRANTEE; assigneeType 'group' and a person still work", async () => {
    const refused = await call(ROOT, 'POST', `/access-profiles/${PROFILE_ID}/assignments`, { assigneeType: 'principal', assigneeId: G_REFUSALS });
    expect([refused.status, refused.json?.code]).toEqual([422, 'GROUP_PRINCIPAL_NOT_A_GRANTEE']);
    const asGroup = await call(ROOT, 'POST', `/access-profiles/${PROFILE_ID}/assignments`, { assigneeType: 'group', assigneeId: G_REFUSALS });
    expect(asGroup.status).toBe(201);
    const asPerson = await call(ROOT, 'POST', `/access-profiles/${PROFILE_ID}/assignments`, { assigneeType: 'principal', assigneeId: await makeAccount('user', 'assignee') });
    expect(asPerson.status).toBe(201);
  });

  it('a Group is never a warrant holder: the unchanged holder rule refuses it INVALID_HOLDER_SHAPE', async () => {
    const minted = await stepUpService.mint(ROOT.principalId, 'warrant.create', G_REFUSALS, 'password');
    const refused = await call(ROOT, 'POST', '/warrants', {
      name: `az12 ${tag()}`, holderPrincipalId: G_REFUSALS, stepUpToken: minted.token,
      anchors: [{ anchorType: 'project', anchorId: PROJECT_ID }],
    });
    expect([refused.status, refused.json?.code]).toEqual([422, 'INVALID_HOLDER_SHAPE']);
  });

  for (const column of ['owner_principal_id', 'shepherd_principal_id', 'verifier_principal_id', 'creator_principal_id']) {
    it(`tasks.${column} refuses a Group principal; a person is admitted`, async () => {
      const refused = await probe(`UPDATE tasks SET ${column} = $1 WHERE id = $2`, [G_REFUSALS, TASK_ID]);
      expect(refused.admitted).toBe(false);
      expect(refused.message).toMatch(new RegExp(`tasks\\.${column} cannot name one`));
      expect((await probe(`UPDATE tasks SET ${column} = $1 WHERE id = $2`, [PERSON.principalId, TASK_ID])).admitted).toBe(true);
    });
  }

  it('reports.author_principal_id refuses a Group principal; a person is admitted', async () => {
    const refused = await probe('UPDATE reports SET author_principal_id = $1 WHERE id = $2', [G_REFUSALS, REPORT_ID]);
    expect(refused.admitted).toBe(false);
    expect(refused.message).toMatch(/reports\.author_principal_id cannot name one/);
    expect((await probe('UPDATE reports SET author_principal_id = $1 WHERE id = $2', [PERSON.principalId, REPORT_ID])).admitted).toBe(true);
  });

  it('the tasks backstop fires after trg_tasks_shepherd_fallback (BEFORE triggers fire in name order)', async () => {
    const triggers = await pool.query(
      `SELECT t.tgname, p.proname FROM pg_trigger t JOIN pg_proc p ON p.oid = t.tgfoid
        WHERE t.tgrelid = 'tasks'::regclass AND NOT t.tgisinternal AND (t.tgtype & 2) = 2
        ORDER BY t.tgname`);
    const names = triggers.rows.map((row: any) => String(row.tgname));
    const fallback = names.indexOf('trg_tasks_shepherd_fallback');
    const backstops = triggers.rows.filter((row: any) => row.proname === 'refuse_group_principal_actor').map((row: any) => String(row.tgname));
    expect(fallback).toBeGreaterThanOrEqual(0);
    expect(backstops).toEqual(['trg_tasks_unassignable_group_principal']);
    expect(names.indexOf(backstops[0])).toBeGreaterThan(fallback);
  });

  it('the Group backstop functions write nothing: they read NEW and raise or return it', async () => {
    const functions = await pool.query(
      `SELECT proname, prosrc FROM pg_proc
        WHERE proname IN ('refuse_group_principal_actor', 'refuse_group_principal_reference') ORDER BY proname`);
    expect(functions.rows.map((row: any) => row.proname)).toEqual(['refuse_group_principal_actor', 'refuse_group_principal_reference']);
    for (const row of functions.rows) {
      expect({ fn: row.proname, writes: /\b(INSERT|UPDATE|DELETE)\b|NEW\.[a-z_]+\s*:=/i.test(String(row.prosrc)) })
        .toEqual({ fn: row.proname, writes: false });
    }
  });

  it('PATCH /tasks/:id/roles refuses a Group Shepherd or Verifier by name; a person is assigned', async () => {
    for (const field of ['shepherdPrincipalId', 'verifierPrincipalId']) {
      const refused = await call(ROOT, 'PATCH', `/tasks/${TASK_ID}/roles`, { [field]: G_REFUSALS });
      expect({ field, status: refused.status, code: refused.json?.code })
        .toEqual({ field, status: 422, code: 'TASK_ROLE_GROUP_PRINCIPAL' });
    }
    const assigned = await call(ROOT, 'PATCH', `/tasks/${TASK_ID}/roles`, { verifierPrincipalId: MEMBER.principalId });
    expect(assigned.status).toBe(200);
  });

  // ── the seven /principals/:id mutations (clause 2, R61-R67) ──

  interface RouteCase { route: string; method: string; suffix: string; body: () => Promise<Record<string, unknown>>; person: () => Promise<string>; personStatus: number }
  const ROUTES: RouteCase[] = [
    { route: 'PUT /principals/:id/home-group', method: 'PUT', suffix: '/home-group',
      body: async () => ({ groupId: G_FEATURED }), person: async () => PERSON.principalId, personStatus: 200 },
    { route: 'PATCH /principals/:id', method: 'PATCH', suffix: '',
      body: async () => ({ displayName: `az12 renamed ${tag()}` }), person: async () => makeAccount('user', 'patch'), personStatus: 200 },
    { route: 'POST /principals/:id/role', method: 'POST', suffix: '/role',
      body: async () => ({ role: 'viewer' }), person: async () => makeAccount('user', 'role'), personStatus: 200 },
    { route: 'POST /principals/:id/credentials', method: 'POST', suffix: '/credentials',
      body: async () => ({ scopes: ['tasks:read'], label: 'az12' }), person: async () => makeAccount('user', 'cred'), personStatus: 422 },
    { route: 'PUT /principals/:id/password', method: 'PUT', suffix: '/password',
      body: async () => ({ password: `az12-${crypto.randomBytes(12).toString('hex')}` }), person: async () => makeAccount('user', 'pwset'), personStatus: 200 },
    { route: 'DELETE /principals/:id/password', method: 'DELETE', suffix: '/password',
      body: async () => ({}), person: async () => makeAccount('user', 'pwclear'), personStatus: 200 },
    { route: 'POST /principals/:id/terminate', method: 'POST', suffix: '/terminate',
      body: async () => ({}), person: async () => makeAccount('user', 'terminate'), personStatus: 200 },
  ];

  for (const routeCase of ROUTES) {
    it(`${MANAGED} on ${routeCase.route}: refused first, both rows unchanged, audited; a person id answers as before`, async () => {
      const target = await group(`managed ${routeCase.method}${routeCase.suffix}`);
      const principalBefore = await rowOf('principals', target);
      const groupBefore = await rowOf('groups', target);
      // An UPPERCASE path id reaches the same guard: kind is resolved by uuid.
      for (const spelled of [target, target.toUpperCase()]) {
        const refused = await call(ROOT, routeCase.method, `/principals/${spelled}${routeCase.suffix}`, await routeCase.body());
        expect({ spelled, status: refused.status, code: refused.json?.code })
          .toEqual({ spelled, status: 422, code: MANAGED });
      }
      expect(await rowOf('principals', target)).toBe(principalBefore);
      expect(await rowOf('groups', target)).toBe(groupBefore);
      const audited = await pool.query(
        `SELECT metadata FROM audit_events
          WHERE action = 'principal.mutation_refused' AND outcome = 'denied' AND resource_id = $1`, [target]);
      expect(audited.rows).toHaveLength(2);
      expect(audited.rows[0].metadata).toEqual({ refusal: MANAGED, route: routeCase.route, targetPrincipalId: target });
      const person = await routeCase.person();
      const answered = await call(ROOT, routeCase.method, `/principals/${person}${routeCase.suffix}`, await routeCase.body());
      expect({ route: routeCase.route, status: answered.status }).toEqual({ route: routeCase.route, status: routeCase.personStatus });
      if (routeCase.route === 'POST /principals/:id/terminate') {
        // Throughout: also once the Group is deleted and its principal terminated.
        expect((await call(ROOT, 'DELETE', `/groups/${target}`)).status).toBe(200);
        const after = await call(ROOT, 'POST', `/principals/${target}/terminate`, {});
        expect([after.status, after.json?.code]).toEqual([422, MANAGED]);
      }
    });
  }

  it('GET /principals lists no Group; kind=group lists them; kind filters; an unknown kind is 400; includeHidden adds no Group', async () => {
    const listed = await call(ROOT, 'GET', '/principals');
    expect(listed.status).toBe(200);
    const kinds = new Set(listed.json.principals.map((row: any) => row.kind));
    expect(kinds.has('group')).toBe(false);
    expect(listed.json.principals.some((row: any) => row.id === PERSON.principalId)).toBe(true);
    const hidden = await call(ROOT, 'GET', '/principals?includeHidden=true');
    expect(hidden.json.principals.some((row: any) => row.kind === 'group')).toBe(false);
    const groups = await call(ROOT, 'GET', '/principals?kind=group');
    expect(groups.status).toBe(200);
    expect(groups.json.principals.length).toBeGreaterThan(0);
    expect(groups.json.principals.every((row: any) => row.kind === 'group')).toBe(true);
    expect(groups.json.principals.some((row: any) => row.id === G_REFUSALS)).toBe(true);
    const humans = await call(ROOT, 'GET', '/principals?kind=human');
    expect(humans.json.principals.every((row: any) => row.kind === 'human')).toBe(true);
    const unknown = await call(ROOT, 'GET', '/principals?kind=team');
    expect([unknown.status, unknown.json?.code]).toEqual([400, 'INVALID_PRINCIPAL_KIND']);
  });

  it('relayhall_principal_list through the MCP ingress lists no Group, and still lists people', async () => {
    const rows: any[] = [];
    for (let offset = 0; offset < 20_000; offset += 50) {
      const listed = await mcpCall(READER, 'relayhall_principal_list', { response_format: 'detailed', limit: 50, offset });
      expect(listed.status).toBe(200);
      const text = mcpText(listed);
      const body = JSON.parse(text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1));
      rows.push(...body.principals);
      if (!body.pagination?.hasMore) break;
    }
    expect(rows.filter((row) => row.kind === 'group' || row.id === G_REFUSALS)).toEqual([]);
    expect(rows.some((row) => row.id === PERSON.principalId)).toBe(true);
  });

  it('POST /principals refuses a group: handle by name and still refuses kind group; a person is created', async () => {
    const prefixed = await call(ROOT, 'POST', '/principals', { handle: `group:${tag()}`, kind: 'human' });
    expect(prefixed.status).toBe(400);
    expect(prefixed.json?.message).toBe('The group: prefix is reserved for Group principals');
    const kind = await call(ROOT, 'POST', '/principals', { handle: `az12-kind-${tag()}`, kind: 'group' });
    expect([kind.status, kind.json?.message]).toEqual([400, "kind must be 'human', 'service' or 'agent'"]);
    const person = await call(ROOT, 'POST', '/principals', { handle: `az12-created-${tag()}`, kind: 'human' });
    expect(person.status).toBe(201);
  });

  it('createPrincipal refuses kind group: only the Group writers create a Group principal', async () => {
    const handle = `group:${crypto.randomUUID()}`;
    let code: unknown = null;
    try {
      await principalService.createPrincipal({ handle, kind: 'group' as any });
    } catch (error: any) {
      code = error?.code ?? error?.message;
    }
    expect(code).toBe('GROUP_PRINCIPAL_WRITER_ONLY');
    expect((await pool.query('SELECT count(*)::int AS n FROM principals WHERE handle = $1', [handle])).rows[0].n).toBe(0);
  });

  it('a JWT naming a Group is refused 401 on the principal-id path; a person JWT is admitted', async () => {
    const groupHandle = `group:${G_REFUSALS}`;
    const refused = await call({ label: 'jwt', principalId: G_REFUSALS, headers: { Authorization: `Bearer ${signV2(G_REFUSALS, groupHandle, 'group')}` } }, 'GET', '/principals/me');
    expect(refused.status).toBe(401);
    const person = await call({ label: 'jwt', principalId: PERSON.principalId, headers: { Authorization: `Bearer ${signV2(PERSON.principalId, PERSON_HANDLE, 'human')}` } }, 'GET', '/principals/me');
    expect([person.status, person.json?.principal?.id]).toEqual([200, PERSON.principalId]);
  });

  it('a legacy handle JWT naming a Group is refused 401; a person handle JWT is admitted', async () => {
    const refused = await call({ label: 'jwt', principalId: '', headers: { Authorization: `Bearer ${signLegacy(`group:${G_REFUSALS}`)}` } }, 'GET', '/principals/me');
    expect(refused.status).toBe(401);
    const person = await call({ label: 'jwt', principalId: '', headers: { Authorization: `Bearer ${signLegacy(PERSON_HANDLE)}` } }, 'GET', '/principals/me');
    expect([person.status, person.json?.principal?.id]).toEqual([200, PERSON.principalId]);
  });
});

// ═════════════════════ (7) drill 7: deletion ═════════════════════

describe('(7) drill 7 - GROUP_OWNS_OBJECTS and the terminated principal', () => {
  it('GROUP_OWNS_OBJECTS answers a count per object type and never an id', async () => {
    const owner = await group('owns');
    const projectId = await project(ROOT, 'group-owned');
    const taskId = await task(ROOT, `AZ12 group-owned ${tag()}`, projectId);
    const reportId = await report(ROOT.principalId, taskId);
    // No route writes a Group owner before build 3, so the owner columns are set in raw SQL.
    await pool.query('UPDATE projects SET owner_principal_id = $1 WHERE id = $2', [owner, projectId]);
    await pool.query('UPDATE tasks SET account_owner_principal_id = $1 WHERE id = $2', [owner, taskId]);
    await pool.query('UPDATE reports SET account_owner_principal_id = $1 WHERE id = $2', [owner, reportId]);
    const refused = await call(ROOT, 'DELETE', `/groups/${owner}`);
    expect([refused.status, refused.json?.code]).toEqual([409, 'GROUP_OWNS_OBJECTS']);
    // Card d67e6990: the Skill owner column joined the counts (none owned here).
    expect(refused.json.details).toEqual({ owned: { projects: 1, tasks: 1, reports: 1, skills: 0 } });
    for (const id of [projectId, taskId, reportId]) expect(refused.text).not.toContain(id);
    expect(await rowOf('groups', owner)).not.toBeNull();
    expect((await pool.query('SELECT status FROM principals WHERE id = $1', [owner])).rows[0].status).toBe('active');
  });

  it('a cleared Group deletes: principal terminated with terminated_at, groups row gone, Group grants deleted, audited', async () => {
    const doomed = await group('doomed');
    await pool.query(`INSERT INTO grants (grantee_type, grantee_id, resource_type, resource_id, verb)
                      VALUES ('group', $1, 'project', $2, 'read')`, [doomed, PROJECT_ID]);
    const deleted = await call(ROOT, 'DELETE', `/groups/${doomed}`);
    expect(deleted.status).toBe(200);
    expect(deleted.json.group.ownershipStatus).toBe('terminated');
    const principal = await pool.query('SELECT kind, status, terminated_at FROM principals WHERE id = $1', [doomed]);
    expect(principal.rows[0]).toMatchObject({ kind: 'group', status: 'terminated' });
    expect(principal.rows[0].terminated_at).not.toBeNull();
    expect(await rowOf('groups', doomed)).toBeNull();
    expect((await pool.query(`SELECT count(*)::int AS n FROM grants WHERE grantee_type = 'group' AND grantee_id = $1`, [doomed])).rows[0].n).toBe(0);
    const audit = await pool.query(`SELECT metadata FROM audit_events WHERE action = 'group.delete' AND resource_id = $1`, [doomed]);
    expect(audit.rows[0].metadata).toMatchObject({ revokedGrantRows: 1, principalTerminated: true });
  });

  it('GROUP_NOT_EMPTY, GROUP_GATES_LOGIN and GROUP_IS_A_HOME_GROUP still answer, and before GROUP_OWNS_OBJECTS', async () => {
    const projectId = await project(ROOT, 'precedence');
    const populated = await group('populated');
    await pool.query(`INSERT INTO group_members (group_id, account_principal_id, source) VALUES ($1, $2, 'local')`, [populated, MEMBER.principalId]);
    await pool.query('UPDATE projects SET owner_principal_id = $1 WHERE id = $2', [populated, projectId]);
    const notEmpty = await call(ROOT, 'DELETE', `/groups/${populated}`);
    expect([notEmpty.status, notEmpty.json?.code]).toEqual([409, 'GROUP_NOT_EMPTY']);

    const gating = await group('gating');
    await pool.query('INSERT INTO identity_provider_login_groups (identity_provider_id, group_id) VALUES ($1, $2)', [PROVIDER_ID, gating]);
    await pool.query('UPDATE projects SET owner_principal_id = $1 WHERE id = $2', [gating, projectId]);
    const gates = await call(ROOT, 'DELETE', `/groups/${gating}`);
    expect([gates.status, gates.json?.code]).toEqual([409, 'GROUP_GATES_LOGIN']);

    const home = await group('home', true);
    const pointer = await makeAccount('user', 'pointer');
    await pool.query(`INSERT INTO account_home_groups (account_principal_id, group_id, source) VALUES ($1, $2, 'admin')`, [pointer, home]);
    await pool.query('UPDATE projects SET owner_principal_id = $1 WHERE id = $2', [home, projectId]);
    const homed = await call(ROOT, 'DELETE', `/groups/${home}`);
    expect([homed.status, homed.json?.code]).toEqual([409, 'GROUP_IS_A_HOME_GROUP']);
  });

  // Repaired by name for AZ-A12 build 2 (card ee81ee0f): build 1 pinned the
  // fail-closed state (a member did not reach a Group-owned project) until the
  // evaluator arm landed. Build 2 is that arm, so the oracle now pins its use
  // tier: a plain member reads the project and is refused a write.
  it('a raw-SQL Group project owner gives a plain member the use tier only (build 2): reads, never writes', async () => {
    const owner = await group('owner-use-tier');
    await pool.query(`INSERT INTO group_members (group_id, account_principal_id, source) VALUES ($1, $2, 'local')`, [owner, MEMBER.principalId]);
    const projectId = await project(ROOT, 'group-owned-use');
    await pool.query('UPDATE projects SET owner_principal_id = $1 WHERE id = $2', [owner, projectId]);
    const read = await call(MEMBER, 'GET', `/projects/${projectId}`);
    expect(read.status).toBe(200);
    // The shared authorization stage refuses before the route reads If-Match.
    const write = await call(MEMBER, 'PATCH', `/projects/${projectId}`, { description: 'member write' });
    expect(write.status).toBe(403);
  });
});

// ═════════════════════ (12) drill 12: ownership status ═════════════════════

describe('(12) drill 12 - PUT /groups/:id/ownership-status, enable and disable', () => {
  const put = (who: Caller, id: string, body: Record<string, unknown>) => call(who, 'PUT', `/groups/${id}/ownership-status`, body);
  const REASON = 'AZ-A12 drill: the team was reorganised and its ownership is suspended for review.';

  it('the Access-surface boot census classifies PUT /groups/:id/ownership-status as an UNGOVERNED root-session act', async () => {
    // A full boot runs this census over the live catalogue and REFUSES TO
    // SERVE on any finding; the boot check does not reach it. Measured here
    // over the real catalogue, as the compiled process does at boot.
    const findings: string[] = await accessSurfaceService.auditCatalogue();
    expect(findings.filter((finding) => finding.includes('/groups'))).toEqual([]);
    expect(UNGOVERNED_ROOT_FAMILIES.map((entry: { family: string }) => entry.family)).toContain('PUT /groups/:id/ownership-status');
  });

  it('an operator login session is refused at the /groups root ceiling, and its step-up survives', async () => {
    const target = await group('operator');
    const minted = await stepUpService.mint(OPERATOR.principalId, OWNERSHIP_ACT, target, 'password');
    const refused = await put(OPERATOR, target, { enabled: false, reason: REASON, stepUpToken: minted.token });
    expect([refused.status, refused.json?.code]).toEqual([403, 'FORBIDDEN']);
    expect(await tokenConsumed(minted.token)).toBe(false);
    expect((await pool.query('SELECT status FROM principals WHERE id = $1', [target])).rows[0].status).toBe('active');
  });

  it('a bearer credential holding root is refused REQUIRES_LOGIN_SESSION, audited, and spends nothing', async () => {
    const target = await group('bearer');
    const minted = await stepUpService.mint(ROOT_BEARER.principalId, OWNERSHIP_ACT, target, 'password');
    const refused = await put(ROOT_BEARER, target, { enabled: false, reason: REASON, stepUpToken: minted.token });
    expect([refused.status, refused.json?.code]).toEqual([403, 'REQUIRES_LOGIN_SESSION']);
    expect(await tokenConsumed(minted.token)).toBe(false);
    expect(await deniedAudit('group.principal_disable', 'REQUIRES_LOGIN_SESSION', target)).toBe(1);
    expect((await pool.query('SELECT status FROM principals WHERE id = $1', [target])).rows[0].status).toBe('active');
  });

  it('a root login session without a valid step-up is refused STEP_UP_REQUIRED, and no refusal before the consume spends the token', async () => {
    const target = await group('step-up');
    const other = await group('step-up-other');
    const noToken = await put(ROOT, target, { enabled: false, reason: REASON });
    expect([noToken.status, noToken.json?.code]).toEqual([403, 'STEP_UP_REQUIRED']);
    // Card 72b8fb97: the Group service no longer drops the SU-14 challenge
    // when it re-raises the refusal: what to step up for (the canonical
    // Group id), and which proofs this root Account can give (none here: no
    // password credential and no Identity link).
    expect(noToken.json?.stepUp).toEqual({
      error: 'insufficient_user_authentication', action: OWNERSHIP_ACT, targetId: target.toLowerCase(), max_age: 0, methods: [],
    });
    const wrongAct = await stepUpService.mint(ROOT.principalId, 'approval.decide', target, 'password');
    const actRefused = await put(ROOT, target, { enabled: false, reason: REASON, stepUpToken: wrongAct.token });
    expect([actRefused.status, actRefused.json?.code]).toEqual([403, 'STEP_UP_REQUIRED']);
    expect(actRefused.json?.stepUp).toMatchObject({ action: OWNERSHIP_ACT, targetId: target.toLowerCase() });
    expect(await tokenConsumed(wrongAct.token)).toBe(false);
    const wrongGroup = await stepUpService.mint(ROOT.principalId, OWNERSHIP_ACT, other, 'password');
    const groupRefused = await put(ROOT, target, { enabled: false, reason: REASON, stepUpToken: wrongGroup.token });
    expect([groupRefused.status, groupRefused.json?.code]).toEqual([403, 'STEP_UP_REQUIRED']);
    expect(await tokenConsumed(wrongGroup.token)).toBe(false);
    // Refusals that precede the consume leave a VALID token unspent.
    const valid = await stepUpService.mint(ROOT.principalId, OWNERSHIP_ACT, target, 'password');
    const unknownField = await put(ROOT, target, { enabled: false, reason: REASON, stepUpToken: valid.token, extra: 1 });
    expect([unknownField.status, unknownField.json?.code]).toEqual([400, 'UNKNOWN_FIELD']);
    expect(unknownField.json?.stepUp).toBeUndefined();
    const noReason = await put(ROOT, target, { enabled: false, reason: '   ', stepUpToken: valid.token });
    expect([noReason.status, noReason.json?.code]).toEqual([422, 'INVALID_GROUP_VALUE']);
    const unchanged = await put(ROOT, target, { enabled: true, reason: REASON, stepUpToken: valid.token });
    expect([unchanged.status, unchanged.json?.code]).toEqual([409, 'GROUP_OWNERSHIP_STATUS_UNCHANGED']);
    expect(await tokenConsumed(valid.token)).toBe(false);
    expect((await pool.query('SELECT status FROM principals WHERE id = $1', [target])).rows[0].status).toBe('active');
    // Every refusal is durably audited.
    expect(await deniedAudit('group.principal_disable', 'STEP_UP_REQUIRED', target)).toBe(3);
    expect(await deniedAudit('group.principal_disable', 'UNKNOWN_FIELD', target)).toBe(1);
    expect(await deniedAudit('group.principal_disable', 'INVALID_GROUP_VALUE', target)).toBe(1);
    expect(await deniedAudit('group.principal_enable', 'GROUP_OWNERSHIP_STATUS_UNCHANGED', target)).toBe(1);
  });

  let G12: string;
  let G12_PROJECT: string;
  let N3_MEMBER: Caller;

  it('a root login session with a step-up disables the Group principal: audited with from, to, reason and stepUpTokenId; the token is spent', async () => {
    G12 = await group('disable');
    N3_MEMBER = await sessionFor('n3 member', await makeAccount('user', 'n3-member'));
    await pool.query(`INSERT INTO group_members (group_id, account_principal_id, source) VALUES ($1, $2, 'local')`, [G12, N3_MEMBER.principalId]);
    G12_PROJECT = await project(ROOT, 'n3');
    await pool.query(`INSERT INTO grants (grantee_type, grantee_id, resource_type, resource_id, verb)
                      VALUES ('group', $1, 'project', $2, 'read')`, [G12, G12_PROJECT]);
    const members = await pool.query('SELECT count(*)::int AS n FROM group_members WHERE group_id = $1', [G12]);
    const minted = await stepUpService.mint(ROOT.principalId, OWNERSHIP_ACT, G12, 'password');
    const disabled = await put(ROOT, G12, { enabled: false, reason: REASON, stepUpToken: minted.token });
    expect(disabled.status).toBe(200);
    expect(disabled.json.group.ownershipStatus).toBe('disabled');
    expect(await tokenConsumed(minted.token)).toBe(true);
    expect((await pool.query('SELECT status FROM principals WHERE id = $1', [G12])).rows[0].status).toBe('disabled');
    const audit = await pool.query(
      `SELECT metadata FROM audit_events WHERE action = 'group.principal_disable' AND outcome = 'success' AND resource_id = $1`, [G12]);
    expect(audit.rows).toHaveLength(1);
    expect(audit.rows[0].metadata).toEqual({ groupId: G12, from: 'active', to: 'disabled', reason: REASON, stepUpTokenId: minted.tokenId });
    expect((await pool.query('SELECT count(*)::int AS n FROM group_members WHERE group_id = $1', [G12])).rows[0].n).toBe(members.rows[0].n);
    const replay = await put(ROOT, G12, { enabled: true, reason: REASON, stepUpToken: minted.token });
    expect([replay.status, replay.json?.code]).toEqual([403, 'STEP_UP_REQUIRED']);
  });

  it("while disabled, the Group's grants still admit its members (N3), and a person's own grant is unchanged", async () => {
    expect((await pool.query('SELECT status FROM principals WHERE id = $1', [G12])).rows[0].status).toBe('disabled');
    const read = await call(N3_MEMBER, 'GET', `/projects/${G12_PROJECT}`);
    expect(read.status).toBe(200);
    const stranger = await sessionFor('stranger', await makeAccount('user', 'stranger'));
    expect((await call(stranger, 'GET', `/projects/${G12_PROJECT}`)).status).toBe(404);
    await pool.query(`INSERT INTO grants (grantee_type, grantee_id, resource_type, resource_id, verb)
                      VALUES ('principal', $1, 'project', $2, 'read')`, [stranger.principalId, G12_PROJECT]);
    expect((await call(stranger, 'GET', `/projects/${G12_PROJECT}`)).status).toBe(200);
  });

  it('a root login session with a step-up enables it again: audited group.principal_enable', async () => {
    const minted = await stepUpService.mint(ROOT.principalId, OWNERSHIP_ACT, G12, 'password');
    const enabled = await put(ROOT, G12, { enabled: true, reason: REASON, stepUpToken: minted.token });
    expect(enabled.status).toBe(200);
    expect(enabled.json.group.ownershipStatus).toBe('active');
    const audit = await pool.query(
      `SELECT metadata FROM audit_events WHERE action = 'group.principal_enable' AND outcome = 'success' AND resource_id = $1`, [G12]);
    expect(audit.rows).toHaveLength(1);
    expect(audit.rows[0].metadata).toEqual({ groupId: G12, from: 'disabled', to: 'active', reason: REASON, stepUpTokenId: minted.tokenId });
  });

  it('an uppercase path id behaves identically: the step-up minted for the canonical id is spent through it', async () => {
    const target = await group('uppercase');
    const minted = await stepUpService.mint(ROOT.principalId, OWNERSHIP_ACT, target, 'password');
    const disabled = await put(ROOT, target.toUpperCase(), { enabled: false, reason: REASON, stepUpToken: minted.token });
    expect([disabled.status, disabled.json?.group?.id]).toEqual([200, target]);
    expect(await tokenConsumed(minted.token)).toBe(true);
    const audit = await pool.query(
      `SELECT metadata->>'groupId' AS id FROM audit_events WHERE action = 'group.principal_disable' AND outcome = 'success' AND resource_id = $1`, [target]);
    expect(audit.rows.map((row: any) => row.id)).toEqual([target]);
  });
});

// ═════════════════════ card 9cdc6b27: a non-UUID principal id is refused by name ═════════════════════

describe('card 9cdc6b27 - a non-UUID principal id never reaches a uuid-typed read', () => {
  it('GET /principals/:id/credentials and POST /principals/:id/terminate refuse a handle 400 INVALID_PRINCIPAL_ID; an unknown UUID answers as before', async () => {
    const person = await makeAccount('user', 'id-shape');
    const handle = String((await pool.query('SELECT handle FROM principals WHERE id = $1', [person])).rows[0].handle);
    for (const [method, suffix] of [['GET', '/credentials'], ['POST', '/terminate']] as const) {
      const refused = await call(ROOT, method, `/principals/${handle}${suffix}`, method === 'POST' ? {} : undefined);
      // On main: 500 CREDENTIALS_READ_FAILED and 500 TERMINATE_FAILED.
      expect({ method, status: refused.status, code: refused.json?.code })
        .toEqual({ method, status: 400, code: 'INVALID_PRINCIPAL_ID' });
    }
    expect((await pool.query('SELECT status FROM principals WHERE id = $1', [person])).rows[0].status).toBe('active');
    const unknown = crypto.randomUUID();
    const listed = await call(ROOT, 'GET', `/principals/${unknown}/credentials`);
    expect([listed.status, listed.json?.credentials]).toEqual([200, []]);
    const missing = await call(ROOT, 'POST', `/principals/${unknown}/terminate`, {});
    expect([missing.status, missing.json?.code]).toEqual([404, 'PRINCIPAL_NOT_FOUND']);
  });
});
