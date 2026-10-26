/**
 * Card 549cc51f — the shared-area writer list (owner rulings E298, E299 with
 * the F1 repair, E310), over a REAL PostgreSQL, the PRODUCTION router and the
 * MCP ingress.
 *
 * It measures, on stored rows:
 *
 *   (M) migration 157: it re-applies cleanly and a rerun changes nothing; its
 *       CHECKs, UNIQUE, foreign keys and trigger are pinned BY NAME; the
 *       Accounts-only trigger refuses every other kind; the "Shared-area
 *       writers" surface is always-self, has no menu entry, is in no Access
 *       bundle, and the boot census names nothing of it.
 *   (L) the list: a services:read disclosure with Account labels and the
 *       caller's own youCanWrite (through a Connector too); the administration
 *       view only for a root or an administrator login session.
 *   (G) the gate on a change, every refusal named and audited as denied with
 *       nothing written and no step-up spent: an rh_ bearer holding root, the
 *       legacy API key, a non-administrator session, a non-Account target, a
 *       disabled Account, a missing, wrong-act, wrong-Account or replayed
 *       step-up, a duplicate add and a remove of an unlisted Account.
 *   (A) the acts: root and an administrator session add and remove, one audit
 *       row each with the before and after list, the reason and the step-up
 *       token id; the id-only notice; the retry contract.
 *   (E) expiry: the list and the snapshot drop a passed row at once; the sweep
 *       removes it, audited as actor system.
 *   (S) the snapshot element after an add and after a remove, and THE E299
 *       TEST: a listed Account outside the export selection does not deny the
 *       snapshot.
 *   (P) MCP: the one read tool through the ingress, and no write path.
 *
 * DESTRUCTIVE: writes principals, services, writer rows, step-up tokens,
 * notification endpoints and audit rows. It refuses any deployment database
 * and any non-local host, and FAILS — never skips — without a disposable one.
 */

/* eslint-disable @typescript-eslint/no-var-requires */

import http from 'http';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { replayInRolledBackTransaction, setAsideRowsOnlyLaterMigrationsAdmit, type Queryable } from './support/migrationReplay';

const TEST_DB_URL = process.env.RELAYHALL_TEST_DB_URL;
if (!TEST_DB_URL) {
  throw new Error('RELAYHALL_TEST_DB_URL is required: the shared-area writer list is measured on stored writer, '
    + 'step-up and audit rows, so this suite never skips. Load database/init.sql into a disposable database, run '
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
  throw new Error('The shared-area writer suite refuses a non-disposable database target');
}

Object.assign(process.env, {
  DB_HOST: parsed.hostname, DB_PORT: parsed.port || '5432', DB_NAME: TEST_DB_NAME,
  DB_USER: decodeURIComponent(parsed.username), DB_PASSWORD: decodeURIComponent(parsed.password),
  NODE_ENV: 'test', RELAYHALL_SESSIONS: 'on', JWT_SECRET: crypto.randomBytes(32).toString('hex'),
});
// The legacy service key, so its refusal is measured on a real request.
process.env.RELAYHALL_API_KEY = process.env.RELAYHALL_API_KEY || `shared-writers-suite-${crypto.randomBytes(16).toString('hex')}`;
// Every admitted MCP tools/call writes the caller's own session telemetry.
process.env.RELAYHALL_TELEMETRY_PEPPERS = process.env.RELAYHALL_TELEMETRY_PEPPERS
  || JSON.stringify({ testpepper: Buffer.alloc(32, 23).toString('base64') });
process.env.RELAYHALL_TELEMETRY_ACTIVE_PEPPER = process.env.RELAYHALL_TELEMETRY_ACTIVE_PEPPER || 'testpepper';

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
const { accessSurfaceService } = require('../services/AccessSurfaceService');
const { knowledgeSharedWriterService } = require('../services/KnowledgeSharedWriterService');
const {
  createLifecyclePayload, validateLifecycleConfig, readLifecycleSharedWriters,
} = require('../services/KnowledgeLifecycleExporter');
const { MCP_TOOLS } = require('../mcp/registry');
const { insertGroupRow } = require('./support/groupRows');
const mcpRoutes = require('../mcp/httpRoute').default;
const { MCP_ROUTE_PATH } = require('../mcp/httpRoute');

jest.setTimeout(180_000);

const MIGRATION_FILE = path.join(__dirname, '..', 'migrations', '157_knowledge_shared_writers.sql');
const ADD = 'knowledge.shared-writer.add';
const REMOVE = 'knowledge.shared-writer.remove';
const AUDIT_ADD = 'knowledge.shared_writer.add';
const AUDIT_REMOVE = 'knowledge.shared_writer.remove';
const AUDIT_EXPIRE = 'knowledge.shared_writer.expire';
const REASON = 'Maintains the organisation rules and runbooks.';

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

interface Caller { label: string; principalId: string; headers: Record<string, string>; token?: string }
interface Answer { status: number; json: any; text: string; headers: Headers }

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
  return { status: response.status, json, text, headers: response.headers };
}

/** One JSON-RPC tools/call over the REAL `/mcp` route, as a stock client makes it. */
async function mcp(token: string, name: string, args: Record<string, unknown> = {}): Promise<{ text: string; isError: boolean }> {
  const response = await fetch(`${origin}${MCP_ROUTE_PATH}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
  });
  const json: any = JSON.parse(await response.text());
  return {
    text: String(json?.result?.content?.[0]?.text ?? JSON.stringify(json?.error ?? json)),
    isError: Boolean(json?.result?.isError) || Boolean(json?.error),
  };
}

const tag = (): string => crypto.randomBytes(5).toString('hex');

async function makeAccount(role: string | null, label: string, kind: 'human' | 'service' = 'human'): Promise<string> {
  const result = await pool.query(
    `INSERT INTO principals (kind, handle, display_name, status, role, purpose)
     VALUES ($1, $2, $3, 'active', $4, $5) RETURNING id`,
    [kind, `sw-${label}-${tag()}`, `SW ${label}`, role, kind === 'service' ? 'shared-writer drill service identity' : null],
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

/** A Connector of `accountId` (a parented service principal) with its own bearer credential. */
async function connectorOf(accountId: string, scopes: string[]): Promise<Caller> {
  const created = await pool.query(
    `INSERT INTO principals (kind, handle, display_name, status, parent_principal_id, purpose, own_expression)
     VALUES ('service', $1, $1, 'active', $2, 'shared-writer drill connector', $3::jsonb) RETURNING id`,
    [`sw-connector-${tag()}`, accountId, JSON.stringify({ scopes: 'parent', objects: 'parent' })],
  );
  const id = String(created.rows[0].id);
  const issued = await principalService.issueCredential({ principalId: id, scopes, label: `sw-${tag()}`, transport: 'any' });
  return { label: 'connector', principalId: id, headers: { Authorization: `Bearer ${issued.fullKey}` }, token: issued.fullKey };
}

/** A principal_api_key bearer HOLDING root (minted narrow, widened in raw SQL), as the build-1 drill builds one. */
async function rootBearerFor(accountId: string): Promise<Caller> {
  const created = await pool.query(
    `INSERT INTO principals (kind, handle, display_name, status, role, parent_principal_id)
     VALUES ('service', $1, $1, 'active', 'user', $2) RETURNING id`, [`sw-bearer-${tag()}`, accountId]);
  const bearerId = String(created.rows[0].id);
  const issued = await principalService.issueCredential({ principalId: bearerId, scopes: ['principals:read'], label: 'sw', transport: 'api' });
  await pool.query('UPDATE principals SET parent_principal_id = NULL WHERE id = $1', [bearerId]);
  await pool.query('UPDATE principal_credentials SET scopes = $2::jsonb WHERE id = $1', [issued.credentialId, JSON.stringify(['root'])]);
  principalService.invalidatePrincipals([bearerId]);
  return { label: 'root-bearer', principalId: bearerId, headers: { Authorization: `Bearer ${issued.fullKey}` }, token: issued.fullKey };
}

/** A bearer credential whose principal IS the Account (issued to a carrier, then rebound), for the retry-scope case. */
async function bearerOfAccount(accountId: string): Promise<Caller> {
  const carrier = await connectorOf(accountId, ['services:read']);
  await pool.query(
    'UPDATE principal_credentials SET principal_id = $2 WHERE principal_id = $1', [carrier.principalId, accountId]);
  principalService.invalidatePrincipals([carrier.principalId, accountId]);
  return { ...carrier, label: 'account-bearer', principalId: accountId };
}

/** A knowledge source that accepts writes (`write`) or reads only. */
async function makeSource(label: string, write = true): Promise<string> {
  const slug = `sw-${label}-${tag()}`;
  const row = await pool.query(
    `INSERT INTO services (slug, name, description, kind, status, runtime_mode, knowledge_query_endpoint,
                           knowledge_write_endpoint, knowledge_claims_mode, knowledge_subject_mode,
                           knowledge_core_credential_ref)
     VALUES ($1, $2, '', 'service', 'published', 'direct', 'https://source.invalid/knowledge/search', $3,
             'asserted', 'pairwise', 'shared-writer-drill/core') RETURNING id`,
    [slug, `SW ${label}`, write ? 'https://source.invalid/knowledge/write' : null]);
  return String(row.rows[0].id);
}

async function stepUp(principalId: string, action: string, accountId: string): Promise<string> {
  return (await stepUpService.mint(principalId, action, accountId, 'password')).token;
}

async function tokenConsumed(token: string): Promise<boolean> {
  const hash = crypto.createHash('sha256').update(token).digest('hex');
  const row = await pool.query('SELECT consumed_at FROM step_up_tokens WHERE token_hash = $1', [hash]);
  return row.rows[0]?.consumed_at != null;
}

async function writers(sourceId: string): Promise<string[]> {
  const rows = await pool.query(
    'SELECT account_id FROM knowledge_shared_writers WHERE source_id = $1 ORDER BY account_id', [sourceId]);
  return rows.rows.map((row: any) => String(row.account_id));
}

async function audits(action: string, accountId: string, outcome: 'success' | 'denied'): Promise<any[]> {
  const rows = await pool.query(
    `SELECT actor_handle, auth_method, actor_principal_id, metadata FROM audit_events
      WHERE action = $1 AND resource_type = 'knowledge_shared_writer' AND resource_id = $2 AND outcome = $3
      ORDER BY occurred_at, id`, [action, accountId, outcome]);
  return rows.rows;
}

const add = (who: Caller, body: Record<string, unknown>, extra: Record<string, string> = {}) =>
  call(who, 'POST', '/knowledge-shared-writers', body, extra);
const remove = (who: Caller, body: Record<string, unknown>) => call(who, 'POST', '/knowledge-shared-writers/remove', body);

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

/** The snapshot element the exporter would sign for `exported` Accounts, read from the database. */
const REVISION = '12121212-1212-4212-8212-121212121212';
async function snapshotElement(sourceId: string, exported: string[]): Promise<any> {
  const accounts = await pool.query(
    'SELECT id, display_name, handle, status, kind FROM principals WHERE id = ANY($1::uuid[]) ORDER BY id', [exported]);
  const config = validateLifecycleConfig({
    enabled: true, sourceId, sourceConfigVersion: 'v1', expectedServiceRevision: REVISION, issuer: 'relayhall-core',
    actorRef: 'shared-writer-drill', accountIds: exported, projectIds: [], projectGrants: [], personalConsents: [],
    keyRef: 'file:/nonexistent/key', kid: 'k', outputPath: '/nonexistent/snapshot', generationPath: '/nonexistent/generation',
  });
  const source = {
    id: sourceId, slug: 'drill', status: 'published', retired_at: null, revision: REVISION,
    knowledge_query_endpoint: 'https://source.invalid/knowledge/search', knowledge_claims_mode: 'asserted',
    knowledge_subject_mode: 'direct', knowledge_relevant_groups: [],
    descriptor: { knowledgeSource: { protocol_version: 2, compartment_mode: 'dynamic-opaque', contentKinds: ['docs'], categories: ['drill:note'], compartments: [] } },
  };
  const payload = createLifecyclePayload(config, {
    source, accounts: accounts.rows, projects: [], groups: [], sharedWriters: await readLifecycleSharedWriters(pool, sourceId),
  }, 1, Math.floor(Date.now() / 1000));
  return payload.shared_writers;
}

let ROOT: Caller;
let OPERATOR: Caller;
let EDITOR: Caller;
let ROOT_BEARER: Caller;
let LEGACY: Caller;

beforeAll(async () => {
  await new Promise<void>((resolve) => { server = buildApp().listen(0, '127.0.0.1', resolve); });
  origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  ROOT = await person('root', 'admin');
  OPERATOR = await person('operator', 'operator');
  EDITOR = await person('editor', 'editor');
  ROOT_BEARER = await rootBearerFor(ROOT.principalId);
  LEGACY = { label: 'legacy', principalId: '', headers: { 'x-api-key': String(process.env.RELAYHALL_API_KEY) } };
});

afterAll(async () => {
  if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  await pool.end();
});

// ═════════════════════ (M) migration 157 ═════════════════════

async function catalogSnapshot(q: Queryable = pool): Promise<string> {
  const rows = await q.query(
    `SELECT 'c:' || conname || ':' || pg_get_constraintdef(oid) AS item FROM pg_constraint
      WHERE conrelid = 'knowledge_shared_writers'::regclass
     UNION ALL
     SELECT 't:' || tgname || ':' || pg_get_triggerdef(oid) FROM pg_trigger
      WHERE tgrelid = 'knowledge_shared_writers'::regclass AND NOT tgisinternal
     UNION ALL
     SELECT 'i:' || indexname || ':' || indexdef FROM pg_indexes WHERE tablename = 'knowledge_shared_writers'
     UNION ALL
     SELECT 'f:' || p.proname || ':' || md5(p.prosrc) FROM pg_proc p WHERE p.proname = 'enforce_knowledge_shared_writer_is_account'
     UNION ALL
     SELECT 's:' || key || ':' || governance || ':' || coalesce(menu_path, '-') || ':' || array_to_string(read_families, ',')
            || ':' || array_to_string(write_families, ',') FROM access_surfaces WHERE key = 'settings.shared-writers'
     UNION ALL
     SELECT 'o:' || conname || ':' || pg_get_constraintdef(oid) FROM pg_constraint
      WHERE conrelid = 'operation_idempotency_records'::regclass
        AND conname IN ('operation_idempotency_operation_policy', 'operation_idempotency_operation_scope')
     ORDER BY 1`);
  return rows.rows.map((row: any) => row.item).join('\n');
}

describe('(M) migration 157 - replay-safe, pinned by name, Accounts only', () => {
  it('migration 157 re-applies cleanly and a rerun changes nothing', async () => {
    const sql = fs.readFileSync(MIGRATION_FILE, 'utf8');
    // 157 redefines the two retry-contract CHECKs with ITS closed set, and 164
    // and 166 widened them since. Every live suite of the full tier shares one
    // database, so a committed replay here narrowed them under the suites that
    // run next (machinery queue 9b761f09). The replay runs in a transaction
    // that is always rolled back, and the helper proves the schema afterwards
    // is exactly the schema it found. An earlier suite may also have committed
    // rows only that wider set admits (task.subtask.* retry records, which 164
    // added); re-adding 157's CHECK would reject them, so inside the same
    // transaction the rows 157's own CHECKs reject are set aside first, and
    // only where a later migration, named by file, redefines that constraint.
    await replayInRolledBackTransaction(pool, 'the replay of migration 157', async (client) => {
      await setAsideRowsOnlyLaterMigrationsAdmit(client, path.basename(MIGRATION_FILE));
      await client.query(sql);
      const once = await catalogSnapshot(client);
      const count = (await client.query('SELECT count(*)::int AS n FROM knowledge_shared_writers')).rows[0].n;
      await client.query(sql);
      expect(await catalogSnapshot(client)).toBe(once);
      expect((await client.query('SELECT count(*)::int AS n FROM knowledge_shared_writers')).rows[0].n).toBe(count);
    });
    // One implicit transaction: no STATEMENT (comments aside) opens or ends
    // one. A plpgsql body (dollar-quoted, so stripped first) and an operation
    // name such as 'knowledge.note.commit' are not transaction statements.
    expect(sql.replace(/--[^\n]*/g, '').replace(/\$\$[\s\S]*?\$\$/g, ''))
      .not.toMatch(/^\s*(COMMIT|BEGIN|ROLLBACK|START\s+TRANSACTION|END)\s*;/im);
    // E310: no approval kind, approval CHECK or access-request kind is touched.
    expect(sql.replace(/--[^\n]*/g, '')).not.toMatch(/approvals_kind_check|ALTER TABLE approvals/i);
  });

  it('pinning: the scope, reason and expiry CHECKs, the one-row UNIQUE and the three foreign keys are present by name', async () => {
    const rows = await pool.query(
      `SELECT conname, contype, confdeltype, pg_get_constraintdef(oid) AS def FROM pg_constraint
        WHERE conrelid = 'knowledge_shared_writers'::regclass ORDER BY conname`);
    const byName = new Map<string, any>(rows.rows.map((row: any) => [row.conname, row]));
    expect(String(byName.get('knowledge_shared_writers_scope_check')?.def)).toMatch(/scope = 'organisation'/);
    expect(String(byName.get('knowledge_shared_writers_reason_length')?.def)).toMatch(/char_length\(reason\) >= 20.*char_length\(reason\) <= 2000/);
    expect(String(byName.get('knowledge_shared_writers_expiry_after_add')?.def)).toMatch(/\(?expires_at IS NULL\)? OR \(?expires_at > added_at\)?/);
    expect(String(byName.get('knowledge_shared_writers_one_row')?.def)).toBe('UNIQUE (source_id, scope, account_id)');
    expect(byName.get('knowledge_shared_writers_source_id_fkey')).toMatchObject({ contype: 'f', confdeltype: 'c' });
    expect(byName.get('knowledge_shared_writers_account_id_fkey')).toMatchObject({ contype: 'f', confdeltype: 'c' });
    expect(byName.get('knowledge_shared_writers_added_by_fkey')).toMatchObject({ contype: 'f', confdeltype: 'n' });
    const trigger = await pool.query(
      `SELECT tgname, pg_get_triggerdef(oid) AS def FROM pg_trigger
        WHERE tgrelid = 'knowledge_shared_writers'::regclass AND NOT tgisinternal`);
    expect(trigger.rows.map((row: any) => row.tgname)).toEqual(['trg_knowledge_shared_writer_is_account']);
    expect(trigger.rows[0].def).toMatch(/BEFORE INSERT OR UPDATE OF account_id ON public\.knowledge_shared_writers FOR EACH ROW/);
  });

  it('the Accounts-only trigger refuses a Group, an Agent, a Connector, a service identity and a parented id; a human Account is admitted', async () => {
    const source = await makeSource('trigger');
    const human = await makeAccount('editor', 'trigger-human');
    const service = await makeAccount(null, 'trigger-service', 'service');
    const connector = await connectorOf(human, ['services:read']);
    const group = await insertGroupRow(pool, { name: `sw trigger ${tag()}`, description: 'shared-writer drill', featured: false });
    const INSERT = `INSERT INTO knowledge_shared_writers (source_id, scope, account_id, reason) VALUES ($1, 'organisation', $2, $3)`;
    expect((await probe(INSERT, [source, group, REASON])).message).toMatch(/a principal of kind group is never a writer/);
    expect((await probe(INSERT, [source, service, REASON])).message).toMatch(/a principal of kind service is never a writer/);
    expect((await probe(INSERT, [source, connector.principalId, REASON])).message).toMatch(/a principal of kind service is never a writer/);
    const task = await call(ROOT, 'POST', '/tasks', { title: `sw agent ${tag()}`, description: 'shared-writer drill', status: 'todo' });
    expect(task.status).toBe(201);
    const agent = await pool.query(
      `INSERT INTO principals (kind, handle, status, parent_principal_id, bound_task_id) VALUES ('agent', $1, 'active', $2, $3) RETURNING id`,
      [`sw-agent-${tag()}`, connector.principalId, String(task.json.task.id)]);
    expect((await probe(INSERT, [source, String(agent.rows[0].id), REASON])).message).toMatch(/a principal of kind agent is never a writer/);
    expect((await probe(INSERT, [source, human, REASON])).admitted).toBe(true);
    // The scope CHECK and the reason bounds hold for a writer that skipped the handler.
    expect((await probe(`INSERT INTO knowledge_shared_writers (source_id, scope, account_id, reason) VALUES ($1, 'group:x', $2, $3)`,
      [source, human, REASON])).message).toMatch(/knowledge_shared_writers_scope_check/);
    expect((await probe(INSERT, [source, human, 'too short'])).message).toMatch(/knowledge_shared_writers_reason_length/);
  });

  it('the Shared-area writers surface is registered always-self with no menu entry, in no Access bundle, and the boot census names nothing of it', async () => {
    const row = await pool.query(
      `SELECT label, governance, locked_reference, read_families, write_families, menu_path, origin
         FROM access_surfaces WHERE key = 'settings.shared-writers'`);
    expect(row.rows).toHaveLength(1);
    expect(row.rows[0]).toMatchObject({
      label: 'Shared-area writers', governance: 'always-self', locked_reference: null, menu_path: null, origin: 'core',
      read_families: ['GET /knowledge-shared-writers'],
      write_families: ['POST /knowledge-shared-writers', 'POST /knowledge-shared-writers/remove'],
    });
    const members = await pool.query(
      `SELECT count(*)::int AS n FROM access_bundle_members m JOIN access_surfaces s ON s.id = m.surface_id
        WHERE s.key = 'settings.shared-writers'`);
    expect(members.rows[0].n).toBe(0);
    const findings: string[] = await accessSurfaceService.auditCatalogue(pool);
    expect(findings.filter((finding) => /shared-writers/.test(finding))).toEqual([]);
  });
});

// ═════════════════════ (L) the list ═════════════════════

describe('(L) the list - a services:read disclosure; the administration view for administrators only', () => {
  it("any services:read caller reads the list with Account labels; youCanWrite answers for the caller's own Account, through a Connector too", async () => {
    const source = await makeSource('list');
    const writer = await makeAccount('editor', 'list-writer');
    await add(ROOT, { source, accountId: writer, reason: REASON, stepUpToken: await stepUp(ROOT.principalId, ADD, writer) });
    const seen = await call(EDITOR, 'GET', `/knowledge-shared-writers?source=${source}`);
    expect(seen.status).toBe(200);
    expect(seen.json).toMatchObject({ success: true, scope: 'organisation', youCanWrite: false, source: { id: source } });
    expect(seen.json.writers).toEqual([{ accountId: writer, label: 'SW list-writer' }]);
    // The default view carries no provenance: no reason, no adder, no expiry.
    expect(Object.keys(seen.json.writers[0]).sort()).toEqual(['accountId', 'label']);
    const own = await sessionFor('list-writer', writer);
    expect((await call(own, 'GET', `/knowledge-shared-writers?source=${source}`)).json.youCanWrite).toBe(true);
    const viaConnector = await connectorOf(writer, ['services:read']);
    expect((await call(viaConnector, 'GET', `/knowledge-shared-writers?source=${source}`)).json.youCanWrite).toBe(true);
  });

  it('a caller without services:read is refused at the route ceiling', async () => {
    const source = await makeSource('ceiling');
    const narrow = await connectorOf(await makeAccount('editor', 'ceiling'), ['tasks:read']);
    const answer = await call(narrow, 'GET', `/knowledge-shared-writers?source=${source}`);
    expect(answer.status).toBe(403);
  });

  it('the administration view is answered to a root or an administrator session only: an editor session, a bearer and an API key are refused by name', async () => {
    const source = await makeSource('admin-view');
    const writer = await makeAccount('editor', 'admin-view');
    await add(ROOT, { source, accountId: writer, reason: REASON, expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
      stepUpToken: await stepUp(ROOT.principalId, ADD, writer) });
    const query = `/knowledge-shared-writers?source=${source}&view=administration`;
    for (const who of [ROOT, OPERATOR]) {
      const answer = await call(who, 'GET', query);
      expect({ who: who.label, status: answer.status }).toEqual({ who: who.label, status: 200 });
      expect(answer.json.writers[0]).toMatchObject({
        accountId: writer, active: true, reason: REASON, origin: 'direct', approvalId: null,
        addedBy: { id: ROOT.principalId, label: 'SW root' },
      });
      expect(Date.parse(answer.json.writers[0].expiresAt)).toBeGreaterThan(Date.now());
    }
    const refused = [
      [EDITOR, 'SHARED_WRITER_REQUIRES_ADMINISTRATOR'],
      [ROOT_BEARER, 'SHARED_WRITER_REQUIRES_SESSION'],
      [LEGACY, 'SHARED_WRITER_REQUIRES_SESSION'],
    ] as const;
    for (const [who, code] of refused) {
      const answer = await call(who, 'GET', query);
      expect({ who: who.label, status: answer.status, code: answer.json?.code }).toEqual({ who: who.label, status: 403, code });
    }
    expect((await call(ROOT, 'GET', `/knowledge-shared-writers?source=${source}&view=everything`)).json.code).toBe('SHARED_WRITER_INVALID');
  });

  it('an unknown source is 404, a malformed one is 400, and an unnamed source is SHARED_WRITER_SOURCE_REQUIRED when two accept writes', async () => {
    await makeSource('two-a');
    await makeSource('two-b');
    expect((await call(EDITOR, 'GET', `/knowledge-shared-writers?source=${crypto.randomUUID()}`)).json?.code)
      .toBe('SHARED_WRITER_SOURCE_NOT_FOUND');
    expect((await call(EDITOR, 'GET', '/knowledge-shared-writers?source=brain')).json?.code).toBe('SHARED_WRITER_INVALID');
    const unnamed = await call(EDITOR, 'GET', '/knowledge-shared-writers');
    expect({ status: unnamed.status, code: unnamed.json?.code }).toEqual({ status: 400, code: 'SHARED_WRITER_SOURCE_REQUIRED' });
    // A read-only knowledge source has a list too, when it is named.
    const readOnly = await makeSource('read-only', false);
    expect((await call(EDITOR, 'GET', `/knowledge-shared-writers?source=${readOnly}`)).status).toBe(200);
  });
});

// ═════════════════════ (G) the gate on a change ═════════════════════

describe('(G) the gate on a change - every refusal named, audited, nothing written, no step-up spent', () => {
  it('an rh_ bearer holding root is refused SHARED_WRITER_REQUIRES_SESSION, audited, nothing written, its step-up unspent', async () => {
    const source = await makeSource('bearer');
    const target = await makeAccount('editor', 'bearer-target');
    const token = await stepUp(ROOT_BEARER.principalId, ADD, target);
    const answer = await add(ROOT_BEARER, { source, accountId: target, reason: REASON, stepUpToken: token });
    expect({ status: answer.status, code: answer.json?.code }).toEqual({ status: 403, code: 'SHARED_WRITER_REQUIRES_SESSION' });
    expect(answer.json.message).toMatch(/login-session act/);
    expect(await writers(source)).toEqual([]);
    expect(await tokenConsumed(token)).toBe(false);
    const denied = await audits(AUDIT_ADD, target, 'denied');
    expect(denied.map((row: any) => [row.metadata.refusal, row.auth_method])).toEqual([['SHARED_WRITER_REQUIRES_SESSION', 'principal_api_key']]);
  });

  it('the legacy API key is refused SHARED_WRITER_REQUIRES_SESSION, audited, nothing written', async () => {
    const source = await makeSource('legacy');
    const target = await makeAccount('editor', 'legacy-target');
    const answer = await add(LEGACY, { source, accountId: target, reason: REASON, stepUpToken: 'rhsu_not_a_token' });
    expect({ status: answer.status, code: answer.json?.code }).toEqual({ status: 403, code: 'SHARED_WRITER_REQUIRES_SESSION' });
    expect(await writers(source)).toEqual([]);
    expect((await audits(AUDIT_ADD, target, 'denied')).map((row: any) => row.auth_method)).toEqual(['legacy_api_key']);
    const removal = await remove(LEGACY, { source, accountId: target, reason: REASON, stepUpToken: 'rhsu_not_a_token' });
    expect(removal.json?.code).toBe('SHARED_WRITER_REQUIRES_SESSION');
  });

  it('a non-administrator session is refused SHARED_WRITER_REQUIRES_ADMINISTRATOR, audited, nothing written, its step-up unspent', async () => {
    const source = await makeSource('editor');
    const target = await makeAccount('editor', 'editor-target');
    const token = await stepUp(EDITOR.principalId, ADD, target);
    const answer = await add(EDITOR, { source, accountId: target, reason: REASON, stepUpToken: token });
    expect({ status: answer.status, code: answer.json?.code }).toEqual({ status: 403, code: 'SHARED_WRITER_REQUIRES_ADMINISTRATOR' });
    expect(await writers(source)).toEqual([]);
    expect(await tokenConsumed(token)).toBe(false);
    expect((await audits(AUDIT_ADD, target, 'denied')).map((row: any) => row.metadata.refusal))
      .toEqual(['SHARED_WRITER_REQUIRES_ADMINISTRATOR']);
  });

  it('a Connector, an Agent, a Group and a service identity are refused SHARED_WRITER_NOT_AN_ACCOUNT before the step-up is spent', async () => {
    const source = await makeSource('kinds');
    const owner = await makeAccount('editor', 'kinds-owner');
    const connector = await connectorOf(owner, ['services:read']);
    const task = await call(ROOT, 'POST', '/tasks', { title: `sw kinds ${tag()}`, description: 'shared-writer drill', status: 'todo' });
    const agent = await pool.query(
      `INSERT INTO principals (kind, handle, status, parent_principal_id, bound_task_id) VALUES ('agent', $1, 'active', $2, $3) RETURNING id`,
      [`sw-agent-${tag()}`, connector.principalId, String(task.json.task.id)]);
    const group = await insertGroupRow(pool, { name: `sw kinds ${tag()}`, description: 'shared-writer drill', featured: false });
    const service = await makeAccount(null, 'kinds-service', 'service');
    for (const [label, id] of [['connector', connector.principalId], ['agent', String(agent.rows[0].id)], ['group', group], ['service', service]]) {
      const token = await stepUp(ROOT.principalId, ADD, id);
      const answer = await add(ROOT, { source, accountId: id, reason: REASON, stepUpToken: token });
      expect({ label, status: answer.status, code: answer.json?.code }).toEqual({ label, status: 422, code: 'SHARED_WRITER_NOT_AN_ACCOUNT' });
      expect({ label, consumed: await tokenConsumed(token) }).toEqual({ label, consumed: false });
    }
    expect(await writers(source)).toEqual([]);
  });

  it('a disabled Account is refused SHARED_WRITER_ACCOUNT_INACTIVE; an unknown id SHARED_WRITER_ACCOUNT_NOT_FOUND', async () => {
    const source = await makeSource('inactive');
    const disabled = await makeAccount('editor', 'inactive');
    await pool.query(`UPDATE principals SET status = 'disabled' WHERE id = $1`, [disabled]);
    const inactive = await add(ROOT, { source, accountId: disabled, reason: REASON, stepUpToken: await stepUp(ROOT.principalId, ADD, disabled) });
    expect(inactive.json?.code).toBe('SHARED_WRITER_ACCOUNT_INACTIVE');
    const unknown = crypto.randomUUID();
    const missing = await add(ROOT, { source, accountId: unknown, reason: REASON, stepUpToken: await stepUp(ROOT.principalId, ADD, unknown) });
    expect({ status: missing.status, code: missing.json?.code }).toEqual({ status: 404, code: 'SHARED_WRITER_ACCOUNT_NOT_FOUND' });
    expect(await writers(source)).toEqual([]);
  });

  it('a missing step-up is refused STEP_UP_REQUIRED with the challenge, audited, nothing written', async () => {
    const source = await makeSource('no-step-up');
    const target = await makeAccount('editor', 'no-step-up');
    const answer = await add(ROOT, { source, accountId: target, reason: REASON });
    expect({ status: answer.status, code: answer.json?.code }).toEqual({ status: 403, code: 'STEP_UP_REQUIRED' });
    expect(answer.json.stepUp).toMatchObject({ error: 'insufficient_user_authentication', action: ADD, targetId: target, max_age: 0 });
    expect(await writers(source)).toEqual([]);
    expect((await audits(AUDIT_ADD, target, 'denied')).map((row: any) => row.metadata.refusal)).toEqual(['STEP_UP_REQUIRED']);
  });

  it('a step-up minted for the other act, or for another Account, is refused STEP_UP_REQUIRED and stays unspent', async () => {
    const source = await makeSource('wrong-step-up');
    const target = await makeAccount('editor', 'wrong-step-up');
    const other = await makeAccount('editor', 'wrong-step-up-other');
    const wrongAct = await stepUp(ROOT.principalId, REMOVE, target);
    const wrongAccount = await stepUp(ROOT.principalId, ADD, other);
    for (const token of [wrongAct, wrongAccount]) {
      const answer = await add(ROOT, { source, accountId: target, reason: REASON, stepUpToken: token });
      expect(answer.json?.code).toBe('STEP_UP_REQUIRED');
      expect(await tokenConsumed(token)).toBe(false);
    }
    // Another principal's token never serves this session.
    const foreign = await stepUp(OPERATOR.principalId, ADD, target);
    expect((await add(ROOT, { source, accountId: target, reason: REASON, stepUpToken: foreign })).json?.code).toBe('STEP_UP_REQUIRED');
    expect(await writers(source)).toEqual([]);
  });

  it('a replayed step-up is refused: the token is single-use', async () => {
    const source = await makeSource('replay');
    const target = await makeAccount('editor', 'replay');
    const token = await stepUp(ROOT.principalId, ADD, target);
    expect((await add(ROOT, { source, accountId: target, reason: REASON, stepUpToken: token })).status).toBe(200);
    await pool.query('DELETE FROM knowledge_shared_writers WHERE source_id = $1', [source]);
    const replayed = await add(ROOT, { source, accountId: target, reason: REASON, stepUpToken: token });
    expect({ status: replayed.status, code: replayed.json?.code }).toEqual({ status: 403, code: 'STEP_UP_REQUIRED' });
    expect(await writers(source)).toEqual([]);
  });

  it('an Account already listed is ALREADY_LISTED, one not listed is NOT_LISTED, both before the step-up is spent', async () => {
    const source = await makeSource('listed');
    const target = await makeAccount('editor', 'listed');
    await add(ROOT, { source, accountId: target, reason: REASON, stepUpToken: await stepUp(ROOT.principalId, ADD, target) });
    const again = await stepUp(ROOT.principalId, ADD, target);
    const duplicate = await add(ROOT, { source, accountId: target, reason: REASON, stepUpToken: again });
    expect({ status: duplicate.status, code: duplicate.json?.code }).toEqual({ status: 409, code: 'SHARED_WRITER_ALREADY_LISTED' });
    expect(await tokenConsumed(again)).toBe(false);
    const stranger = await makeAccount('editor', 'not-listed');
    const removeToken = await stepUp(ROOT.principalId, REMOVE, stranger);
    const absent = await remove(ROOT, { source, accountId: stranger, reason: REASON, stepUpToken: removeToken });
    expect({ status: absent.status, code: absent.json?.code }).toEqual({ status: 404, code: 'SHARED_WRITER_NOT_LISTED' });
    expect(await tokenConsumed(removeToken)).toBe(false);
  });

  it('a reason outside 20-2000 characters, an expiry in the past and a malformed Account are refused by name', async () => {
    const source = await makeSource('input');
    const target = await makeAccount('editor', 'input');
    const token = await stepUp(ROOT.principalId, ADD, target);
    const cases: Array<[Record<string, unknown>, string]> = [
      [{ reason: 'too short' }, 'reason'],
      [{ reason: 'x'.repeat(2001) }, 'reason'],
      [{ reason: REASON, expiresAt: new Date(Date.now() - 60_000).toISOString() }, 'expiresAt'],
      [{ reason: REASON, expiresAt: 'tomorrow' }, 'expiresAt'],
    ];
    for (const [body, field] of cases) {
      const answer = await add(ROOT, { source, accountId: target, stepUpToken: token, ...body });
      expect({ field, status: answer.status, code: answer.json?.code, got: answer.json?.field })
        .toEqual({ field, status: 400, code: 'SHARED_WRITER_INVALID', got: field });
    }
    const malformed = await add(ROOT, { source, accountId: 'grace', reason: REASON, stepUpToken: token });
    expect(malformed.json).toMatchObject({ code: 'SHARED_WRITER_INVALID', field: 'accountId' });
    expect(await tokenConsumed(token)).toBe(false);
    expect(await writers(source)).toEqual([]);
  });
});

// ═════════════════════ (A) the acts and their audit ═════════════════════

describe('(A) the acts - one transaction, one audit row each, the step-up burned with the write', () => {
  it('a root session adds and removes; each act writes one audit row with the before and after list, the reason and the step-up token id', async () => {
    const source = await makeSource('acts');
    const first = await makeAccount('editor', 'acts-first');
    const second = await makeAccount('editor', 'acts-second');
    const tokenFirst = await stepUp(ROOT.principalId, ADD, first);
    const added = await add(ROOT, { source, accountId: first.toUpperCase(), reason: REASON, stepUpToken: tokenFirst });
    expect(added.status).toBe(200);
    expect(added.json).toMatchObject({ success: true, action: 'add', accountId: first, before: [], after: [first], expiresAt: null });
    expect(await tokenConsumed(tokenFirst)).toBe(true);
    await add(ROOT, { source, accountId: second, reason: REASON, stepUpToken: await stepUp(ROOT.principalId, ADD, second) });
    expect(await writers(source)).toEqual([first, second].sort());

    const tokenRemove = await stepUp(ROOT.principalId, REMOVE, first);
    const removed = await remove(ROOT, { source, accountId: first, reason: 'Left the documentation group this week.', stepUpToken: tokenRemove });
    expect(removed.json).toMatchObject({ success: true, action: 'remove', before: [first, second].sort(), after: [second] });
    expect(await writers(source)).toEqual([second]);

    const [addAudit] = await audits(AUDIT_ADD, first, 'success');
    expect(addAudit.actor_principal_id).toBe(ROOT.principalId);
    expect(addAudit.auth_method).toBe('session');
    expect(addAudit.metadata).toMatchObject({
      source, scope: 'organisation', accountId: first, before: [], after: [first], reason: REASON,
      standing: 'root', stepUpMethod: 'password', expiresAt: null,
    });
    expect(addAudit.metadata.stepUpTokenId).toMatch(/^[0-9a-f-]{36}$/);
    const [removeAudit] = await audits(AUDIT_REMOVE, first, 'success');
    expect(removeAudit.metadata).toMatchObject({
      source, accountId: first, before: [first, second].sort(), after: [second], reason: 'Left the documentation group this week.',
    });
    expect(removed.json.auditId).toBeTruthy();
  });

  it('an administrator (operator) session adds with standing administrator', async () => {
    const source = await makeSource('operator');
    const target = await makeAccount('editor', 'operator-target');
    const token = await stepUp(OPERATOR.principalId, ADD, target);
    const answer = await add(OPERATOR, { source, accountId: target, reason: REASON, stepUpToken: token });
    expect(answer.status).toBe(200);
    expect(await tokenConsumed(token)).toBe(true);
    expect((await audits(AUDIT_ADD, target, 'success'))[0].metadata.standing).toBe('administrator');
  });

  it('the change is noticed to the enabled notification endpoints, by id only', async () => {
    const received: any[] = [];
    const hook = http.createServer((req, res) => {
      let body = '';
      req.on('data', (chunk) => { body += chunk; });
      req.on('end', () => { try { received.push(JSON.parse(body)); } catch { received.push(body); } res.end('ok'); });
    });
    await new Promise<void>((resolve) => hook.listen(0, '127.0.0.1', resolve));
    const listener = await makeAccount('admin', 'notice');
    const endpoint = await pool.query(
      `INSERT INTO notification_endpoints (principal_id, kind, target, enabled) VALUES ($1, 'webhook', $2, true) RETURNING id`,
      [listener, `http://127.0.0.1:${(hook.address() as { port: number }).port}/notice`]);
    try {
      const source = await makeSource('notice');
      const target = await makeAccount('editor', 'notice-target');
      expect((await add(ROOT, { source, accountId: target, reason: REASON, stepUpToken: await stepUp(ROOT.principalId, ADD, target) })).status).toBe(200);
      for (let i = 0; i < 50 && !received.some((n) => n?.objectId === target); i += 1) await new Promise((r) => setTimeout(r, 100));
      const notice = received.find((n) => n?.objectId === target);
      expect(notice).toMatchObject({ name: 'knowledge.shared_writer.changed', objectType: 'knowledge_shared_writer', objectId: target });
      // Id-only: the reason the administrator typed never leaves in a notice.
      expect(JSON.stringify(notice)).not.toContain(REASON);
    } finally {
      await pool.query('DELETE FROM notification_endpoints WHERE id = $1', [String(endpoint.rows[0].id)]);
      await new Promise<void>((resolve) => hook.close(() => resolve()));
    }
  });

  it('a keyed retry of an add replays the stored answer; the same key from a bearer of the same Account is refused, not replayed', async () => {
    const source = await makeSource('retry');
    const target = await makeAccount('editor', 'retry');
    const body = { source, accountId: target, reason: REASON, stepUpToken: await stepUp(ROOT.principalId, ADD, target) };
    const key = `sw-retry-${crypto.randomUUID()}`;
    const first = await add(ROOT, body, { 'Idempotency-Key': key });
    expect(first.status).toBe(200);
    const again = await add(ROOT, body, { 'Idempotency-Key': key });
    expect(again.status).toBe(200);
    expect(again.headers.get('retry-replayed')).toBe('true');
    expect(again.text).toBe(first.text);
    expect(await audits(AUDIT_ADD, target, 'success')).toHaveLength(1);
    const stored = await pool.query(
      'SELECT operation, scope FROM operation_idempotency_records WHERE idempotency_key = $1', [key]);
    expect(stored.rows).toEqual([{ operation: 'knowledge.sharedwriter.add', scope: expect.stringMatching(/^user:/) }]);
    const bearer = await bearerOfAccount(ROOT.principalId);
    const crossed = await add(bearer, body, { 'Idempotency-Key': key });
    expect({ status: crossed.status, code: crossed.json?.code, replayed: crossed.headers.get('retry-replayed') })
      .toEqual({ status: 403, code: 'SHARED_WRITER_REQUIRES_SESSION', replayed: null });
  });
});

// ═════════════════════ (E) expiry ═════════════════════

describe('(E) expiry - honoured at once, persisted by the sweep as actor system', () => {
  it('a row past its expiry is gone from the list and the snapshot at once, and the sweep removes it audited as actor system', async () => {
    const source = await makeSource('expiry');
    const target = await makeAccount('editor', 'expiry');
    const later = new Date(Date.now() + 3_600_000).toISOString();
    const added = await add(ROOT, { source, accountId: target, reason: REASON, expiresAt: later, stepUpToken: await stepUp(ROOT.principalId, ADD, target) });
    expect(added.json.expiresAt).toBe(later);
    expect(await snapshotElement(source, [target])).toEqual([{ scope: 'organisation', accounts: [target] }]);
    await pool.query(
      `UPDATE knowledge_shared_writers SET added_at = now() - interval '2 hours', expires_at = now() - interval '1 hour'
        WHERE source_id = $1`, [source]);
    expect((await call(EDITOR, 'GET', `/knowledge-shared-writers?source=${source}`)).json.writers).toEqual([]);
    expect(await snapshotElement(source, [target])).toEqual([{ scope: 'organisation', accounts: [] }]);
    expect(await writers(source)).toEqual([target]);
    expect(await knowledgeSharedWriterService.sweepExpired()).toBeGreaterThanOrEqual(1);
    expect(await writers(source)).toEqual([]);
    const [expired] = await audits(AUDIT_EXPIRE, target, 'success');
    expect({ handle: expired.actor_handle, method: expired.auth_method, principal: expired.actor_principal_id })
      .toEqual({ handle: 'system', method: 'system', principal: null });
    expect(expired.metadata).toMatchObject({ source, accountId: target, before: [target], after: [] });
  });
});

// ═════════════════════ (S) the snapshot element ═════════════════════

describe('(S) the snapshot element (E299 F3)', () => {
  it('the snapshot element names an Account after the add and not after the remove', async () => {
    const source = await makeSource('snapshot');
    const target = await makeAccount('editor', 'snapshot');
    expect(await snapshotElement(source, [target])).toEqual([{ scope: 'organisation', accounts: [] }]);
    await add(ROOT, { source, accountId: target, reason: REASON, stepUpToken: await stepUp(ROOT.principalId, ADD, target) });
    expect(await snapshotElement(source, [target])).toEqual([{ scope: 'organisation', accounts: [target] }]);
    await remove(ROOT, { source, accountId: target, reason: REASON, stepUpToken: await stepUp(ROOT.principalId, REMOVE, target) });
    expect(await snapshotElement(source, [target])).toEqual([{ scope: 'organisation', accounts: [] }]);
  });

  it('THE E299 TEST, live: a listed Account outside the export selection does not deny the snapshot; the element omits it', async () => {
    const source = await makeSource('e299');
    const exported = await makeAccount('editor', 'e299-exported');
    const outside = await makeAccount('editor', 'e299-outside');
    for (const id of [exported, outside]) {
      await add(ROOT, { source, accountId: id, reason: REASON, stepUpToken: await stepUp(ROOT.principalId, ADD, id) });
    }
    expect(await writers(source)).toEqual([exported, outside].sort());
    // The export selects `exported` only: the snapshot is built (no refusal)
    // and the element simply does not name the listed Account it does not carry.
    expect(await snapshotElement(source, [exported])).toEqual([{ scope: 'organisation', accounts: [exported] }]);
  });

  it('a disabled listed Account is dropped from the element at once', async () => {
    const source = await makeSource('disabled');
    const target = await makeAccount('editor', 'disabled');
    await add(ROOT, { source, accountId: target, reason: REASON, stepUpToken: await stepUp(ROOT.principalId, ADD, target) });
    await pool.query(`UPDATE principals SET status = 'disabled' WHERE id = $1`, [target]);
    principalService.invalidatePrincipals([target]);
    expect(await snapshotElement(source, [target])).toEqual([{ scope: 'organisation', accounts: [] }]);
    const view = await call(ROOT, 'GET', `/knowledge-shared-writers?source=${source}&view=administration`);
    expect(view.json.writers[0]).toMatchObject({ accountId: target, active: false });
  });
});

// ═════════════════════ (P) MCP ═════════════════════

describe('(P) MCP - one read tool, no write path', () => {
  it('MCP: relayhall_knowledge_shared_writers_list reads the list through the ingress, with youCanWrite for the caller', async () => {
    const source = await makeSource('mcp');
    const writer = await makeAccount('editor', 'mcp-writer');
    await add(ROOT, { source, accountId: writer, reason: REASON, stepUpToken: await stepUp(ROOT.principalId, ADD, writer) });
    const connector = await connectorOf(writer, ['services:read']);
    const answer = await mcp(String(connector.token), 'relayhall_knowledge_shared_writers_list', { source });
    expect(answer.isError).toBe(false);
    expect(answer.text).toContain('youCanWrite: true');
    expect(answer.text).toContain(`- SW mcp-writer (${writer})`);
    expect(answer.text).toContain('untrusted data');
    const detailed = await mcp(String(connector.token), 'relayhall_knowledge_shared_writers_list', { source, response_format: 'detailed' });
    expect(detailed.text).toContain(writer);
    // Without services:read the board refuses it, and says which scope.
    const narrow = await connectorOf(await makeAccount('editor', 'mcp-narrow'), ['tasks:read']);
    const refused = await mcp(String(narrow.token), 'relayhall_knowledge_shared_writers_list', { source });
    expect(refused.isError).toBe(true);
    expect(refused.text).toMatch(/services:read/);
  });

  it('MCP: no tool reaches the writer-list changes', () => {
    const names = MCP_TOOLS.map((tool: { name: string }) => tool.name);
    expect(names.filter((name: string) => /shared_writer/.test(name))).toEqual(['relayhall_knowledge_shared_writers_list']);
    const registry = fs.readFileSync(path.join(__dirname, '..', 'mcp', 'registry.ts'), 'utf8');
    expect(registry).not.toMatch(/knowledge-shared-writers\/remove/);
    expect(registry).not.toMatch(/method:\s*'POST',\s*path:\s*'\/knowledge-shared-writers'/);
  });
});
