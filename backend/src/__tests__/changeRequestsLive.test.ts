/**
 * Card 502fb19e, train T1 slice S1 — the universal change request (kind
 * `change`; design ratified by owner ruling E325; migration 158), over a REAL
 * PostgreSQL and the PRODUCTION router.
 *
 * It measures, on stored rows:
 *
 *   (M) migration 158: it re-applies inside a transaction and changes nothing;
 *       the change arm admits a well-formed change row and the other kinds
 *       refuse the change columns; the agent-mint, authority-edit and ELSE
 *       arms are 148's byte for byte; the five restated arms equal the file by
 *       deparse (and the grant and credential conjuncts stay 145's, the M-2
 *       oracle's reading); every 148 rule of the stamps and the three trigger
 *       functions is restated; grants_approval_shape admits a manual Group row;
 *       a decided change never changes and an applied one is terminal.
 *   (F) filing on the bearer door by every tier — root, a non-root
 *       administrator, an ordinary user and a viewer — one child row per
 *       object with the owner value the evaluator's owner arm reads, and the
 *       refusals by name, each audited as denied with nothing written;
 *       CHANGE_PENDING per requester.
 *   (D) deciding and applying every S1 target with ONE step-up: grant.rows for
 *       an Account and for a Group (and narrowing), grant.edit and
 *       grant.revoke by a root session only, credential.scopes on another
 *       Connector's credential, credential.issue collected by the TARGET
 *       Connector, knowledge.compartment and knowledge.shared_writer; the
 *       stale check; self-decision; the export selection re-checked at decide.
 *   (S) slice S2 — standing, deciders and the hub: the session door and its
 *       withdraw, the owner tier read from the owner sources alone (a write
 *       grantee naming another grantee is REQUEST_STANDING_NONE, F4), a set
 *       spanning two owners TARGET_OUT_OF_SCOPE (F2), the preview that writes
 *       nothing, the scoped decider's view (its own objects only, 404
 *       elsewhere; a two-owner item invisible to each; a Group manager, a
 *       Report author and a Task's own account owner, B1), one control per
 *       self-approval case (a)-(d), the root-only targets, the relationship
 *       diff, the evidence check of an executor and the decider's liveness.
 *   (C) slice S3 — the surfaces for the first use: relayhall_access_request
 *       through the MCP ingress (the preview that writes nothing, a change
 *       filed for another grantee, CHANGE_PENDING naming the caller's own
 *       request, the named refusals, `status` listing every kind with the
 *       agent-mint requests beside the default list, which keeps its bytes),
 *       and the requester's notification history, which never names the
 *       decider while a decider's history does.
 *   (X) the lifecycle exporter reads the core tables: the configuration
 *       carry-over with its byte-equal read-back recorded as
 *       knowledge.lifecycle.import, the refusal when the read-back differs,
 *       the E299 F3 filter on table rows, and approval.applied stamped by the
 *       generation that first carries a row, once.
 *
 * DESTRUCTIVE: writes principals, credentials, services, projects, tasks,
 * grants, approvals, compartment rows, writer rows, step-up tokens and audit
 * rows. It refuses any deployment database and any non-local host, and FAILS —
 * never skips — without a disposable one.
 */

/* eslint-disable @typescript-eslint/no-var-requires */

import http from 'http';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

const TEST_DB_URL = process.env.RELAYHALL_TEST_DB_URL;
if (!TEST_DB_URL) {
  throw new Error('RELAYHALL_TEST_DB_URL is required: change requests are measured on stored approval, grant, '
    + 'compartment and audit rows, so this suite never skips. Load database/init.sql into a disposable database, '
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
  throw new Error('The change-request suite refuses a non-disposable database target');
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
const { grantService } = require('../services/GrantService');
const {
  validateLifecycleConfig, createLifecyclePayload, recordLifecycleSelection, prepareLifecycleGeneration,
  commitLifecycleGeneration, lifecycleImportReadBack, readLifecycleCompartmentGrants,
} = require('../services/KnowledgeLifecycleExporter');
const { insertGroupRow } = require('./support/groupRows');
const mcpRoutes = require('../mcp/httpRoute').default;
const { MCP_ROUTE_PATH } = require('../mcp/httpRoute');

jest.setTimeout(240_000);

const MIGRATIONS = path.join(__dirname, '..', 'migrations');
const FILE_158 = path.join(MIGRATIONS, '158_universal_change_requests.sql');
const FILE_148 = path.join(MIGRATIONS, '148_authority_edit_in_place.sql');
const FILE_145 = path.join(MIGRATIONS, '145_access_requests_credential_kind.sql');
const REASON = 'Change-request drill: the run needs this access to finish its handover.';
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
  // The MCP ingress first and outside the REST funnel, exactly as server.ts
  // mounts it (slice S3): relayhall_access_request dispatches in-process to the
  // same /delegation/access-requests routes the REST callers below reach.
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
     VALUES ('human', $1, $1, 'active', $2) RETURNING id`, [`ucr-${label}-${tag()}`, role]);
  return String(result.rows[0].id);
}

async function sessionFor(label: string, principalId: string): Promise<Caller> {
  const minted = await loginSessionService.mint({ principalId });
  return { label, principalId, headers: { Cookie: `${SESSION_COOKIE_NAME}=${minted.token}` } };
}

async function person(label: string, role: string): Promise<Caller> {
  return sessionFor(label, await makeAccount(role, label));
}

const CONNECTOR_SCOPES = ['tasks:read', 'tasks:write', 'projects:read', 'phases:read', 'reports:read', 'principals:read'];

/** A Connector of `accountId` with its own bearer credential (own() = parent). */
async function connectorOf(accountId: string, scopes: string[] = CONNECTOR_SCOPES): Promise<Bearer> {
  const created = await pool.query(
    `INSERT INTO principals (kind, handle, display_name, status, parent_principal_id, purpose, own_expression)
     VALUES ('service', $1, $1, 'active', $2, 'change-request drill connector', $3::jsonb) RETURNING id`,
    [`ucr-connector-${tag()}`, accountId, JSON.stringify({ scopes: 'parent', objects: 'parent' })]);
  const id = String(created.rows[0].id);
  const issued = await principalService.issueCredential({ principalId: id, scopes, label: `ucr-${tag()}`, transport: 'any' });
  return { label: 'connector', principalId: id, credentialId: String(issued.credentialId), headers: { Authorization: `Bearer ${issued.fullKey}` } };
}

/** A Connector whose own() objects are exactly `objects`: it reads those and nothing else. */
async function narrowConnectorOf(accountId: string, objects: unknown[]): Promise<Bearer> {
  const conn = await connectorOf(accountId);
  await pool.query('UPDATE principals SET own_expression = $2::jsonb WHERE id = $1',
    [conn.principalId, JSON.stringify({ scopes: 'parent', objects })]);
  return conn;
}

type Filed = { ok: true; record: any } | { ok: false; status: number; code: string; body: any };

/** FILE a change on the bearer door (POST /delegation/access-requests, kind change). */
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

async function decide(decider: Caller, approvalId: string, decision: 'approve' | 'deny', body: Record<string, unknown> = {}):
  Promise<Answer & { tokenId: string }> {
  const stepUp = await stepUpService.mint(decider.principalId, 'approval.decide', approvalId, 'password');
  const answered = await call(decider, 'POST', `/approvals/${approvalId}/${decision}`, { stepUpToken: stepUp.token, ...body });
  return { ...answered, tokenId: stepUp.tokenId };
}

async function approvalRow(id: string): Promise<any> {
  return (await pool.query('SELECT * FROM approvals WHERE id = $1', [id])).rows[0];
}

async function children(id: string): Promise<any[]> {
  return (await pool.query('SELECT * FROM approval_change_objects WHERE approval_id = $1 ORDER BY ordinal', [id])).rows;
}

async function events(id: string, action: string): Promise<any[]> {
  return (await pool.query('SELECT * FROM approval_events WHERE approval_id = $1 AND action = $2 ORDER BY occurred_at, id', [id, action])).rows;
}

async function tokenConsumed(tokenId: string): Promise<boolean> {
  return (await pool.query('SELECT consumed_at FROM step_up_tokens WHERE id = $1', [tokenId])).rows[0]?.consumed_at != null;
}

const exactRule = (type: string, ids: string[], verbs: string[]) => ({ resourceType: type, selectorForm: 'exact', selectorIds: ids, verbs });
const uuidArray = (value: unknown): string[] => (Array.isArray(value) ? value.map(String)
  : String(value ?? '').replace(/[{}]/g, '').split(',').filter(Boolean));

async function ownerTask(owner: Caller, title: string, project: string): Promise<string> {
  const created = await call(owner, 'POST', '/tasks', { title, description: 'change-request drill', status: 'todo', project });
  expect(created.status).toBe(201);
  return String(created.json?.task?.id);
}

async function ownerProject(owner: Caller, name: string): Promise<string> {
  const created = await call(owner, 'POST', '/projects', { name });
  expect(created.status).toBe(201);
  return String(created.json.project.id);
}

/** A Project only its owner (and root) reads: visibility private, no grants. */
async function privateProject(owner: Caller, name: string): Promise<string> {
  const id = await ownerProject(owner, name);
  await pool.query(`UPDATE projects SET visibility = 'private' WHERE id = $1`, [id]);
  return id;
}

/** A published knowledge source with a protocol-2 descriptor, so the exporter emits for it. */
async function makeKnowledgeSource(label: string): Promise<{ id: string; revision: string }> {
  const slug = `ucr-${label}-${tag()}`;
  const row = await pool.query(
    `INSERT INTO services (slug, name, description, kind, status, runtime_mode, knowledge_query_endpoint,
                           knowledge_write_endpoint, knowledge_claims_mode, knowledge_subject_mode,
                           knowledge_core_credential_ref)
     VALUES ($1, $2, '', 'service', 'published', 'direct', 'https://source.invalid/knowledge/search',
             'https://source.invalid/knowledge/write', 'asserted', 'direct', 'change-request-drill/core') RETURNING id`,
    [slug, `UCR ${label}`]);
  const id = String(row.rows[0].id);
  await pool.query(
    `INSERT INTO service_descriptor_versions (service_id, version, descriptor, content_hash) VALUES ($1, 1, $2::jsonb, $3)`,
    [id, JSON.stringify({ knowledgeSource: { protocol_version: 2, compartment_mode: 'dynamic-opaque', contentKinds: ['docs'], categories: ['drill:note'], compartments: [] } }),
      'b'.repeat(64)]);
  await pool.query(`UPDATE services SET current_descriptor_version = 1 WHERE id = $1`, [id]);
  const revision = String((await pool.query('SELECT revision FROM services WHERE id = $1', [id])).rows[0].revision);
  return { id, revision };
}

function lifecycleConfig(source: { id: string; revision: string }, input: {
  accountIds: string[]; projectIds: string[]; projectGrants?: unknown[]; personalConsents?: unknown[];
}): any {
  return validateLifecycleConfig({
    enabled: true, sourceId: source.id, sourceConfigVersion: 'ucr-v1', expectedServiceRevision: source.revision,
    issuer: 'relayhall-core', actorRef: 'change-request-drill', accountIds: input.accountIds, projectIds: input.projectIds,
    projectGrants: input.projectGrants ?? [], personalConsents: input.personalConsents ?? [],
    keyRef: 'file:/nonexistent/key', kid: 'ucr', outputPath: '/nonexistent/snapshot', generationPath: '/nonexistent/generation',
  });
}

async function withClient<T>(fn: (client: any) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try { return await fn(client); } finally { client.release(); }
}

// ─────────────────────────────── fixtures ────────────────────────────────────

let ROOT: Caller;        // role admin: root
let ROOT2: Caller;       // a second root person, who decides root's own filings
let OPERATOR: Caller;    // a non-root administrator
let OPERATOR2: Caller;   // a non-root administrator and a member of GROUP
let OWNER: Caller;       // an ordinary user who owns P1 and P2
let OTHER: Caller;       // an ordinary user
let VIEWER: Caller;      // role viewer
let MEMBER: Caller;      // an ordinary user and a member of GROUP
let OUTSIDER: Caller;    // an ordinary user outside every export selection
let ROOT_CONN: Bearer;
let OP_CONN: Bearer;
let OWNER_CONN: Bearer;
let VIEWER_CONN: Bearer;
let OTHER_CONN: Bearer;
let P1: string;
let P2: string;
let TASK_X: string;
let TASK_Y: string;
let GROUP: string;
let SOURCE: { id: string; revision: string };
let MAIN_CONFIG: any;

beforeAll(async () => {
  await new Promise<void>((resolve) => { server = buildApp().listen(0, '127.0.0.1', resolve); });
  origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  ROOT = await person('root', 'admin');
  ROOT2 = await person('root2', 'admin');
  OPERATOR = await person('operator', 'operator');
  OPERATOR2 = await person('operator2', 'operator');
  OWNER = await person('owner', 'user');
  OTHER = await person('other', 'user');
  VIEWER = await person('viewer', 'viewer');
  MEMBER = await person('member', 'user');
  OUTSIDER = await person('outsider', 'user');
  ROOT_CONN = await connectorOf(ROOT.principalId);
  OP_CONN = await connectorOf(OPERATOR.principalId);
  OWNER_CONN = await connectorOf(OWNER.principalId);
  VIEWER_CONN = await connectorOf(VIEWER.principalId, ['tasks:read', 'projects:read']);
  OTHER_CONN = await connectorOf(OTHER.principalId, ['tasks:read']);
  P1 = await ownerProject(OWNER, `UCR P1 ${tag()}`);
  P2 = await ownerProject(OWNER, `UCR P2 ${tag()}`);
  TASK_X = await ownerTask(OWNER, `UCR X ${tag()}`, P1);
  TASK_Y = await ownerTask(OWNER, `UCR Y ${tag()}`, P1);
  GROUP = await insertGroupRow(pool, { name: `ucr-group-${tag()}` });
  for (const member of [MEMBER, OPERATOR2]) {
    await pool.query(`INSERT INTO group_members (group_id, account_principal_id, source) VALUES ($1, $2, 'local')`, [GROUP, member.principalId]);
  }
  // The administrator's own reach on P1 and P2: a bearer names only objects its
  // own live authority reads (the point-stage rule), and an administrator's
  // Connector does not inherit the Account's administrator arm.
  for (const project of [P1, P2]) {
    await grantService.create({ granteeId: OPERATOR.principalId, resourceType: 'project', resourceId: project, verb: 'read' },
      { handle: 'ucr-drill', authMethod: 'system' });
  }
  SOURCE = await makeKnowledgeSource('main');
  MAIN_CONFIG = lifecycleConfig(SOURCE, { accountIds: [OWNER.principalId, OTHER.principalId, MEMBER.principalId], projectIds: [P1, P2] });
  // The first generation for the source: the carry-over (nothing to carry) and
  // its read-back, after which the exporter records the live selection the
  // request door reads (section 4.2).
  await withClient(async (client: any) => {
    const first = await prepareLifecycleGeneration(client, MAIN_CONFIG, 1, Math.floor(Date.now() / 1000));
    await commitLifecycleGeneration(client, MAIN_CONFIG, 1, first);
  });
});

afterAll(async () => {
  if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  await pool.end();
});

// ═════════════════════════════ (M) migration 158 ═════════════════════════════

const RESTATED_CONSTRAINTS = [
  ['approvals', 'approvals_kind_check'], ['approvals', 'approvals_kind_shape'], ['approvals', 'approvals_lifecycle_stamps'],
  ['approvals', 'approvals_change_columns_only'], ['approvals', 'approvals_target_type_check'],
  ['approval_events', 'approval_events_action_check'], ['grants', 'grants_approval_shape'],
] as const;
const RESTATED_FUNCTIONS = ['enforce_access_request_relation', 'enforce_approval_request_immutable', 'enforce_approval_one_way'];

async function catalogue(client: any): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const [table, name] of RESTATED_CONSTRAINTS) {
    const row = (await client.query(
      `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conname = $1 AND conrelid = $2::regclass`, [name, table])).rows[0];
    out[name] = row ? String(row.def) : '(absent)';
  }
  for (const name of RESTATED_FUNCTIONS) {
    const row = (await client.query(`SELECT prosrc FROM pg_proc WHERE proname = $1`, [name])).rows[0];
    out[name] = row ? String(row.prosrc) : '(absent)';
  }
  const trigger = (await client.query(
    `SELECT pg_get_triggerdef(oid) AS def FROM pg_trigger WHERE tgname = 'trg_approvals_request_immutable'`)).rows[0];
  out.trg_approvals_request_immutable = trigger ? String(trigger.def) : '(absent)';
  return out;
}

/** Run `fn` on a client that has re-applied migration 158's text, then roll it all back.
 * The replay itself is an assertion: a file that no longer applies over the
 * rows this database holds is red here, by name, not as a crashed fixture. */
async function under158<T>(fn: (client: any) => Promise<T>): Promise<T | null> {
  return withClient(async (client) => {
    await client.query('BEGIN');
    try {
      let replay: string | null = null;
      try {
        await client.query(fs.readFileSync(FILE_158, 'utf8'));
      } catch (e: any) {
        replay = String(e?.message ?? e);
      }
      expect({ replay }).toEqual({ replay: null });
      if (replay !== null) return null;
      return await fn(client);
    } finally {
      await client.query('ROLLBACK');
    }
  });
}

/** The CHECK body of `name` as a migration file writes it (ADD CONSTRAINT name CHECK ( ... );). */
function checkBody(file: string, name: string): string {
  const text = fs.readFileSync(file, 'utf8');
  const head = `ALTER TABLE approvals ADD CONSTRAINT ${name} CHECK (`;
  const start = text.indexOf(head);
  if (start < 0) throw new Error(`${name} is not in ${path.basename(file)}`);
  const end = text.indexOf('\n);', start);
  return text.slice(start + head.length, end);
}

/** A plpgsql function body as a migration file writes it. */
function functionBody(file: string, name: string): string {
  const text = fs.readFileSync(file, 'utf8');
  const head = `CREATE OR REPLACE FUNCTION ${name}() RETURNS trigger AS $$`;
  const start = text.indexOf(head);
  if (start < 0) throw new Error(`${name} is not in ${path.basename(file)}`);
  const end = text.indexOf('$$ LANGUAGE plpgsql;', start);
  return text.slice(start + head.length, end);
}

describe('(M) migration 158', () => {
  it('M1: migration 158 re-applies inside a transaction and changes nothing it restates', async () => {
    const live = await withClient(catalogue);
    const replayed = await under158(catalogue);
    expect(replayed).toEqual(live);
    for (const value of Object.values(live)) expect(value).not.toBe('(absent)');
  });

  it('M2: the change arm admits a well-formed change row, and the other kinds refuse the change columns', async () => {
    const requester = await makeAccount('user', 'm2');
    await under158(async (client: any) => {
      const inserted = await client.query(
        `INSERT INTO approvals (kind, status, requester_principal_id, session_evidence, requested_scopes, pending_expires_at,
           target_type, target_objects, change_spec, reason)
         VALUES ('change', 'pending', $1, '{}'::jsonb, '[]'::jsonb, NOW() + INTERVAL '1 day', 'grant.rows',
           '[{"type":"task","id":null}]'::jsonb, '{"type":"grant.rows","before":{},"requested":{}}'::jsonb, $2) RETURNING id`,
        [requester, REASON]);
      const id = String(inserted.rows[0].id);
      await client.query(
        `INSERT INTO approval_change_objects (approval_id, ordinal, target_type, object_id, requester_account_id)
         VALUES ($1, 0, 'grant.rows', 'task:*', $2)`, [id, requester]);
      await client.query('SET CONSTRAINTS ALL IMMEDIATE');
      const refused = async (sql: string, params: unknown[]): Promise<string | null> => {
        await client.query('SAVEPOINT probe');
        try { await client.query(sql, params); return null; } catch (e: any) { return String(e?.code); } finally { await client.query('ROLLBACK TO SAVEPOINT probe'); }
      };
      // A grant-kind row carrying a change column, and a change row without a target type.
      expect(await refused(
        `INSERT INTO approvals (kind, status, requester_principal_id, requesting_credential_id, requested_scopes, pending_expires_at,
           grantee_principal_id, reason, requested_expires_at, requested_rules, related_task_id, target_type)
         VALUES ('grant', 'pending', $1, $2, '[]'::jsonb, NOW() + INTERVAL '1 day', $1, $3, NOW() + INTERVAL '2 days',
           '[{"resourceType":"task","selectorForm":"all-of-type","selectorIds":[],"verbs":["read"]}]'::jsonb, $4, 'grant.rows')`,
        [requester, OWNER_CONN.credentialId, REASON, TASK_X])).toBe('23514');
      expect(await refused(
        `INSERT INTO approvals (kind, status, requester_principal_id, session_evidence, requested_scopes, pending_expires_at, change_spec, target_id, reason)
         VALUES ('change', 'pending', $1, '{}'::jsonb, '[]'::jsonb, NOW() + INTERVAL '1 day', '{}'::jsonb, 'x', $2)`,
        [requester, REASON])).toBe('23514');
    });
  });

  it("M3: 158 restates 148's agent-mint, authority-edit and ELSE arms byte for byte: its text without the change arm is 148's", () => {
    const shape158 = checkBody(FILE_158, 'approvals_kind_shape');
    const start = shape158.indexOf("    WHEN 'change' THEN\n");
    const end = shape158.indexOf('    ELSE\n', start);
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    expect(shape158.slice(0, start) + shape158.slice(end)).toBe(checkBody(FILE_148, 'approvals_kind_shape'));
  });

  it('M4: the five restated arms equal 158 by deparse, and the grant and credential conjuncts stay 145\'s (the M-2 reading)', async () => {
    await withClient(async (client: any) => {
      await client.query('BEGIN');
      try {
        await client.query('CREATE TEMP TABLE ucr_shape_probe (LIKE approvals INCLUDING DEFAULTS) ON COMMIT DROP');
        const deparse = async (body: string, name: string): Promise<string> => {
          await client.query(`ALTER TABLE ucr_shape_probe ADD CONSTRAINT ${name} CHECK (${body})`);
          return String((await client.query(`SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conname = $1`, [name])).rows[0].def);
        };
        const live = async (name: string): Promise<string> => String((await client.query(
          `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conname = $1 AND conrelid = 'approvals'::regclass`, [name])).rows[0].def);
        expect(await live('approvals_kind_shape')).toBe(await deparse(checkBody(FILE_158, 'approvals_kind_shape'), 'probe_kind_shape'));
        expect(await live('approvals_lifecycle_stamps')).toBe(await deparse(checkBody(FILE_158, 'approvals_lifecycle_stamps'), 'probe_stamps'));
        const legacy = await deparse(checkBody(FILE_145, 'approvals_kind_shape'), 'probe_145_shape');
        const conjunct = (def: string, kind: string): string => {
          const at = def.indexOf(`((kind <> '${kind}'::text) OR`);
          expect(at).toBeGreaterThan(-1);
          let depth = 0;
          for (let i = at; i < def.length; i += 1) {
            if (def[i] === '(') depth += 1;
            if (def[i] === ')') { depth -= 1; if (depth === 0) return def.slice(at, i + 1); }
          }
          throw new Error('unbalanced');
        };
        const shape = await live('approvals_kind_shape');
        for (const kind of ['grant', 'credential']) expect(conjunct(shape, kind)).toBe(conjunct(legacy, kind));
        expect(shape).toContain("WHEN 'change'::text THEN");
        for (const name of RESTATED_FUNCTIONS) {
          const prosrc = String((await client.query('SELECT prosrc FROM pg_proc WHERE proname = $1', [name])).rows[0].prosrc);
          expect({ name, prosrc }).toEqual({ name, prosrc: functionBody(FILE_158, name) });
        }
      } finally {
        await client.query('ROLLBACK');
      }
    });
  });

  it('M5: every 148 rule of the lifecycle stamps and the three trigger functions is restated in 158 verbatim', () => {
    const stamps148 = checkBody(FILE_148, 'approvals_lifecycle_stamps').split('\n').slice(3).filter((line) => line.trim());
    const stamps158 = checkBody(FILE_158, 'approvals_lifecycle_stamps');
    for (const line of stamps148) expect(stamps158).toContain(line);
    for (const name of RESTATED_FUNCTIONS) {
      const body158 = functionBody(FILE_158, name);
      const rules148 = functionBody(FILE_148, name).split('\n')
        .filter((line) => /RAISE EXCEPTION|IF OLD|OR NEW|USING ERRCODE/.test(line) && !line.includes('NOT IN ('));
      for (const line of rules148) expect({ name, present: body158.includes(line), line }).toEqual({ name, present: true, line });
    }
  });

  it('M6: grants_approval_shape admits a manual Group row an approval made, and still refuses provenance or no expiry', async () => {
    await withClient(async (client: any) => {
      await client.query('BEGIN');
      try {
        const approval = (await client.query(
          `INSERT INTO approvals (kind, status, requester_principal_id, session_evidence, requested_scopes, pending_expires_at,
             target_type, target_objects, change_spec, reason)
           VALUES ('change', 'pending', $1, '{}'::jsonb, '[]'::jsonb, NOW() + INTERVAL '1 day', 'grant.rows',
             '[{"type":"task","id":null}]'::jsonb, '{"type":"grant.rows","before":{},"requested":{}}'::jsonb, $2) RETURNING id`,
          [OWNER.principalId, REASON])).rows[0];
        const probe = async (values: string): Promise<string | null> => {
          await client.query('SAVEPOINT p');
          try {
            await client.query(`INSERT INTO grants (grantee_type, grantee_id, resource_type, resource_id, verb, expires_at, approval_id, provenance)
                                VALUES ${values}`, [GROUP, TASK_X, approval.id]);
            return null;
          } catch (e: any) { return String(e?.code); } finally { await client.query('ROLLBACK TO SAVEPOINT p'); }
        };
        expect(await probe(`('group', $1, 'task', $2, 'read', NOW() + INTERVAL '1 day', $3, NULL)`)).toBeNull();
        expect(await probe(`('group', $1, 'task', $2, 'read', NULL, $3, NULL)`)).toBe('23514');
        expect(await probe(`('group', $1, 'task', $2, 'read', NOW() + INTERVAL '1 day', $3, 'assignment:grant')`)).toBe('23514');
      } finally {
        await client.query('ROLLBACK');
      }
    });
  });
});

// ═════════════════════════════ (F) filing ═════════════════════════════

describe('(F) filing on the bearer door, by tier', () => {
  it("F1: a root Account's Connector files grant.rows for another Account: pending, one child row per object with its owner value, nothing granted", async () => {
    const record = await fileOk(ROOT_CONN, {
      targetType: 'grant.rows', granteePrincipalId: OTHER.principalId,
      change: { rules: [exactRule('task', [TASK_X], ['read']), exactRule('project', [P1], ['read'])] },
    });
    const row = await approvalRow(record.id);
    expect([row.kind, row.status, row.target_type, row.grantee_type, String(row.grantee_principal_id), row.target_id])
      .toEqual(['change', 'pending', 'grant.rows', 'principal', OTHER.principalId, null]);
    expect(parseJson(row.target_objects)).toEqual([{ type: 'task', id: TASK_X }, { type: 'project', id: P1 }]);
    const objects = await children(record.id);
    expect(objects.map((o: any) => [o.object_id, uuidArray(o.owner_ids), o.pending, String(o.requester_account_id)])).toEqual([
      [`task:${TASK_X}`, [OWNER.principalId], true, ROOT.principalId],
      [`project:${P1}`, [OWNER.principalId], true, ROOT.principalId],
    ]);
    expect(uuidArray(row.scope_project_ids)).toEqual([P1]);
    expect(parseJson(row.change_spec)).toMatchObject({ type: 'grant.rows', before: { rows: [] } });
    expect(record).toMatchObject({ kind: 'change', status: 'pending', targetType: 'grant.rows', granteePrincipalId: OTHER.principalId });
    expect(Object.keys(record)).not.toContain('decidedByPrincipalId');
    expect((await pool.query('SELECT 1 FROM grants WHERE approval_id = $1', [record.id])).rows).toHaveLength(0);
    expect(await events(record.id, 'approval.requested')).toHaveLength(1);
    await call(ROOT_CONN, 'POST', `/delegation/access-requests/${record.id}/withdraw`, {});
  });

  it("F2: a non-root administrator's Connector files credential.scopes on another Account's Connector credential", async () => {
    const record = await fileOk(OP_CONN, {
      targetType: 'credential.scopes', targetId: OTHER_CONN.credentialId, change: { scopes: ['tasks:read', 'reports:read'] },
    });
    const row = await approvalRow(record.id);
    expect([row.target_type, row.target_id, row.grantee_principal_id]).toEqual(['credential.scopes', OTHER_CONN.credentialId, null]);
    expect(parseJson(row.change_spec).requested).toEqual({ scopes: ['tasks:read', 'reports:read'], transport: 'any' });
    expect((await children(record.id)).map((o: any) => [o.object_id, uuidArray(o.owner_ids)])).toEqual([[OTHER_CONN.credentialId, []]]);
    await call(OP_CONN, 'POST', `/delegation/access-requests/${record.id}/withdraw`, {});
  });

  it("F3: an ordinary user's Connector files grant.rows read for its own Account", async () => {
    const foreign = await ownerTask(OTHER, `UCR foreign ${tag()}`, await ownerProject(OTHER, `UCR other ${tag()}`));
    const record = await fileOk(OWNER_CONN, {
      targetType: 'grant.rows', change: { rules: [exactRule('task', [foreign], ['read'])] },
    });
    expect((await approvalRow(record.id)).grantee_principal_id).toBe(OWNER.principalId);
    expect((await children(record.id)).map((o: any) => uuidArray(o.owner_ids))).toEqual([[OTHER.principalId]]);
    const withdrawn = await call(OWNER_CONN, 'POST', `/delegation/access-requests/${record.id}/withdraw`, {});
    expect([withdrawn.status, withdrawn.json?.approval?.status]).toEqual([200, 'lapsed']);
    expect((await children(record.id)).every((o: any) => o.pending === false)).toBe(true);
  });

  it('F4: an ordinary user names another grantee: GRANTEE_NOT_ADMISSIBLE where the owner tier never reaches, REQUEST_STANDING_NONE on objects it does not own', async () => {
    // Slice S2: the owner tier (section 4.1 row 3) may name another grantee on
    // its OWN objects (the (S) section); on a writer-list target it never may,
    // and on another owner's object it has no standing.
    expect(await refusedCode(OWNER_CONN, {
      targetType: 'knowledge.shared_writer', targetId: `${SOURCE.id}:organisation`, granteePrincipalId: OTHER.principalId, change: {},
    })).toEqual([422, 'GRANTEE_NOT_ADMISSIBLE']);
    const foreign = await ownerTask(OTHER, `UCR F4 ${tag()}`, await ownerProject(OTHER, `UCR F4 other ${tag()}`));
    expect(await refusedCode(OWNER_CONN, {
      targetType: 'grant.rows', granteePrincipalId: MEMBER.principalId, change: { rules: [exactRule('task', [foreign], ['read'])] },
    })).toEqual([403, 'REQUEST_STANDING_NONE']);
  });

  it('F5: a viewer asks write and is refused EXCEEDS_ROLE_CEILING; read is admitted', async () => {
    expect(await refusedCode(VIEWER_CONN, {
      targetType: 'grant.rows', change: { rules: [exactRule('task', [TASK_Y], ['write'])] },
    })).toEqual([422, 'EXCEEDS_ROLE_CEILING']);
    const record = await fileOk(VIEWER_CONN, { targetType: 'grant.rows', change: { rules: [exactRule('task', [TASK_Y], ['read'])] } });
    await call(VIEWER_CONN, 'POST', `/delegation/access-requests/${record.id}/withdraw`, {});
  });

  it('F6: every refusal is named and audited as denied, and filed nothing', async () => {
    const conn = await connectorOf(OPERATOR.principalId);
    const before = (await pool.query('SELECT COUNT(*)::int AS n FROM approvals WHERE requester_principal_id = $1', [conn.principalId])).rows[0].n;
    const rule = { rules: [exactRule('task', [TASK_Y], ['read'])] };
    const cases: Array<[Record<string, unknown>, number, string]> = [
      [{ targetType: 'nothing.at.all', change: {} }, 422, 'TARGET_TYPE_UNKNOWN'],
      [{ targetType: 'credential.transport', change: {} }, 422, 'TARGET_NOT_REQUESTABLE'],
      // Slices S4 and S5 build the identity and object targets (card 9ce0b0b0):
      // the not-yet-built oracle is re-anchored BY NAME on a T3 S7 target.
      [{ targetType: 'group.member', change: {} }, 422, 'TARGET_NOT_AVAILABLE'],
      [{ targetType: 'grant.rows', granteePrincipalId: OWNER_CONN.principalId, change: rule }, 422, 'GRANTEE_INERT'],
      [{ targetType: 'grant.rows', granteePrincipalId: OTHER.principalId, change: { rules: [exactRule('task', [TASK_Y], ['admin'])] } }, 422, 'ADMIN_VERB_NOT_ADMISSIBLE'],
      [{ targetType: 'grant.rows', granteePrincipalId: OTHER.principalId, change: rule, reason: 'too short' }, 422, 'INVALID_REASON'],
      [{ targetType: 'credential.scopes', targetId: OTHER_CONN.credentialId, change: { scopes: ['tasks:read'], transport: 'mcp' } }, 422, 'TRANSPORT_NOT_REQUESTABLE'],
      [{ targetType: 'credential.scopes', targetId: crypto.randomUUID(), change: { scopes: ['tasks:read'] } }, 404, 'TARGET_NOT_FOUND'],
      [{ targetType: 'knowledge.compartment', granteeType: 'group', granteePrincipalId: GROUP, change: { sourceId: SOURCE.id, projectIds: [P1] } }, 422, 'GROUP_NOT_RELEVANT'],
      [{ targetType: 'knowledge.compartment', granteePrincipalId: OUTSIDER.principalId, change: { sourceId: SOURCE.id, projectIds: [P1] } }, 409, 'KNOWLEDGE_NOT_EXPORTED'],
      [{ targetType: 'grant.rows', granteePrincipalId: OTHER.principalId, change: rule, requestedRules: rule.rules }, 422, 'INVALID_ACCESS_REQUEST'],
    ];
    for (const [body, status, code] of cases) {
      expect({ code, got: await refusedCode(conn, body) }).toEqual({ code, got: [status, code] });
      const audit = await pool.query(
        `SELECT metadata FROM audit_events WHERE action = 'approval.request' AND outcome = 'denied' AND resource_id = $1
            AND metadata->>'refusal' = $2`, [conn.principalId, code]);
      expect({ code, audited: audit.rows.length > 0 }).toEqual({ code, audited: true });
      expect(parseJson(audit.rows[0].metadata)).toMatchObject({ kind: 'change', subject: expect.any(String), clause: expect.stringContaining('change requests section') });
    }
    // An ordinary user has no standing for a grant edit; a held row is refused naming it.
    const held = await grantService.create({ granteeId: OTHER.principalId, resourceType: 'task', resourceId: TASK_Y, verb: 'read' },
      { handle: 'ucr-drill', authMethod: 'system' });
    expect(await refusedCode(OWNER_CONN, { targetType: 'grant.edit', targetId: held.id, change: { verb: 'write' } })).toEqual([403, 'REQUEST_STANDING_NONE']);
    expect(await refusedCode(conn, { targetType: 'grant.rows', granteePrincipalId: OTHER.principalId, change: rule })).toEqual([409, 'ALREADY_HELD']);
    const after = (await pool.query('SELECT COUNT(*)::int AS n FROM approvals WHERE requester_principal_id = $1', [conn.principalId])).rows[0].n;
    expect(after).toBe(before);
    await grantService.remove(held.id, { handle: 'ucr-drill', authMethod: 'system' });
  });

  it("F7: a repeated filing converges on CHANGE_PENDING naming the caller's own request; another filer is not blocked", async () => {
    const body = { targetType: 'grant.rows', granteePrincipalId: OTHER.principalId, change: { rules: [exactRule('task', [TASK_Y], ['write'])] } };
    const conn = await connectorOf(OPERATOR.principalId);
    const first = await fileOk(conn, body);
    const again = await file(conn, body);
    expect(again.ok ? null : [again.status, again.code, again.body.approvalId]).toEqual([409, 'CHANGE_PENDING', first.id]);
    const sibling = await connectorOf(OPERATOR.principalId);
    const sameAccount = await file(sibling, body);
    expect(sameAccount.ok ? null : [sameAccount.code, sameAccount.body.approvalId]).toEqual(['CHANGE_PENDING', first.id]);
    const other = await fileOk(ROOT_CONN, body);
    expect(other.id).not.toBe(first.id);
    for (const [who, id] of [[conn, first.id], [ROOT_CONN, other.id]] as const) {
      await call(who, 'POST', `/delegation/access-requests/${id}/withdraw`, {});
    }
  });

  // ── the point-stage read at filing (section 4.2 TARGET_NOT_FOUND; section 4.3:
  //    nothing is disclosed about an object the filer cannot read) ──

  it('F8: a compartment naming a Project the filer cannot read is answered exactly as an absent one, audited; a readable one files', async () => {
    // An ordinary user's Connector asks read for its own Account (section 4.1 row 4: "on a Project it can read").
    const conn = await connectorOf(OWNER.principalId);
    const hidden = await privateProject(OTHER, `UCR hidden ${tag()}`);
    const body = (projectId: string) => ({
      targetType: 'knowledge.compartment', change: { sourceId: SOURCE.id, projectIds: [projectId] },
    });
    const unreadable = await file(conn, body(hidden));
    const absent = await file(conn, body(crypto.randomUUID()));
    expect(unreadable).toEqual(absent);
    expect(unreadable.ok ? null : [unreadable.status, unreadable.code]).toEqual([404, 'TARGET_NOT_FOUND']);
    expect(await deniedAudits(conn, 'TARGET_NOT_FOUND')).toBe(2);
    const readable = await fileOk(conn, body(P1));
    await call(conn, 'POST', `/delegation/access-requests/${readable.id}/withdraw`, {});
  });

  it('F9: a Group, an Account, a credential or a Connector the filer cannot read in the directory is answered exactly as an absent one; its own subtree and a reader file', async () => {
    // Without principals:read the directory is closed to this Connector.
    const blind = await connectorOf(OPERATOR.principalId, ['tasks:read', 'projects:read']);
    const rule = { rules: [exactRule('task', [TASK_Y], ['read'])] };
    const pairs: Array<[string, Record<string, unknown>, Record<string, unknown>, number, string]> = [
      ['a Group grantee', { targetType: 'grant.rows', granteeType: 'group', granteePrincipalId: GROUP, change: rule },
        { targetType: 'grant.rows', granteeType: 'group', granteePrincipalId: crypto.randomUUID(), change: rule }, 404, 'GRANTEE_NOT_FOUND'],
      ['an Account grantee', { targetType: 'grant.rows', granteePrincipalId: OTHER.principalId, change: rule },
        { targetType: 'grant.rows', granteePrincipalId: crypto.randomUUID(), change: rule }, 404, 'GRANTEE_NOT_FOUND'],
      ['a credential', { targetType: 'credential.scopes', targetId: OTHER_CONN.credentialId, change: { scopes: ['tasks:read', 'reports:read'] } },
        { targetType: 'credential.scopes', targetId: crypto.randomUUID(), change: { scopes: ['tasks:read', 'reports:read'] } }, 404, 'TARGET_NOT_FOUND'],
      ['a Connector', { targetType: 'credential.issue', targetId: OTHER_CONN.principalId, change: { scopes: ['tasks:read'] } },
        { targetType: 'credential.issue', targetId: crypto.randomUUID(), change: { scopes: ['tasks:read'] } }, 404, 'TARGET_NOT_FOUND'],
    ];
    for (const [what, hiddenBody, absentBody, status, code] of pairs) {
      const unreadable = await file(blind, hiddenBody);
      const absent = await file(blind, absentBody);
      expect({ what, unreadable }).toEqual({ what, unreadable: absent });
      expect({ what, got: unreadable.ok ? null : [unreadable.status, unreadable.code] }).toEqual({ what, got: [status, code] });
    }
    expect(await deniedAudits(blind, 'GRANTEE_NOT_FOUND')).toBe(4);
    expect(await deniedAudits(blind, 'TARGET_NOT_FOUND')).toBe(4);
    // Its own Account subtree needs no directory read: a sibling Connector and its credential.
    const sibling = await connectorOf(OPERATOR.principalId, ['tasks:read']);
    const own = await fileOk(blind, { targetType: 'credential.issue', targetId: sibling.principalId, change: { scopes: ['reports:read'] } });
    const ownCredential = await fileOk(blind, { targetType: 'credential.scopes', targetId: sibling.credentialId, change: { scopes: ['tasks:read', 'reports:read'] } });
    // A reader of the directory files the same Group and credential.
    const reader = await connectorOf(OPERATOR.principalId);
    const group = await fileOk(reader, { targetType: 'grant.rows', granteeType: 'group', granteePrincipalId: GROUP, change: rule });
    const credential = await fileOk(reader, { targetType: 'credential.scopes', targetId: OTHER_CONN.credentialId, change: { scopes: ['tasks:read', 'reports:read'] } });
    for (const [who, id] of [[blind, own.id], [blind, ownCredential.id], [reader, group.id], [reader, credential.id]] as const) {
      await call(who, 'POST', `/delegation/access-requests/${id}/withdraw`, {});
    }
  });

  it("F10: a grant edit or revoke naming a grant on an object the filer cannot read is answered exactly as an absent grant; a readable one files", async () => {
    const hidden = await privateProject(OTHER, `UCR hidden grant ${tag()}`);
    // An administrator's Connector whose own() objects reach P1 alone.
    const conn = await narrowConnectorOf(OPERATOR.principalId, [exactRule('project', [P1], ['read'])]);
    const holder = await makeAccount('user', 'holder');
    const system = { handle: 'ucr-drill', authMethod: 'system' };
    const onHidden = await grantService.create({ granteeId: holder, resourceType: 'project', resourceId: hidden, verb: 'read', expiresAt: inDays(20) }, system);
    const onP1 = await grantService.create({ granteeId: holder, resourceType: 'project', resourceId: P1, verb: 'read', expiresAt: inDays(20) }, system);
    for (const [targetType, change] of [['grant.revoke', {}], ['grant.edit', { expiresAt: inDays(10) }]] as const) {
      const unreadable = await file(conn, { targetType, targetId: onHidden.id, change });
      const absent = await file(conn, { targetType, targetId: crypto.randomUUID(), change });
      expect({ targetType, unreadable }).toEqual({ targetType, unreadable: absent });
      expect({ targetType, got: unreadable.ok ? null : [unreadable.status, unreadable.code] }).toEqual({ targetType, got: [404, 'TARGET_NOT_FOUND'] });
    }
    expect(await deniedAudits(conn, 'TARGET_NOT_FOUND')).toBe(4);
    const readable = await fileOk(conn, { targetType: 'grant.revoke', targetId: onP1.id, change: {} });
    await call(conn, 'POST', `/delegation/access-requests/${readable.id}/withdraw`, {});
    for (const grant of [onHidden, onP1]) await grantService.remove(grant.id, system);
  });

  it('F11: a bearer names another grantee only within its own authority: an object beyond own() is refused OWN_CAP_EXCEEDED exactly as an absent one; a self-request on an unreadable object files exactly as on an absent one', async () => {
    const hiddenProject = await privateProject(OTHER, `UCR hidden rows ${tag()}`);
    // An administrator's Connector whose own() objects reach TASK_Y alone.
    const conn = await narrowConnectorOf(OPERATOR.principalId, [exactRule('task', [TASK_Y], ['read'])]);
    const hiddenTask = await ownerTask(OTHER, `UCR hidden task ${tag()}`, hiddenProject);
    await pool.query(`UPDATE tasks SET visibility = 'private' WHERE id = $1`, [hiddenTask]);
    const absentTask = crypto.randomUUID();
    // Slice S2 (section 4.1 row 5): the Account's administrator tier is cut
    // to the credential's own() for another grantee. OTHER owns the hidden
    // Task, so a refusal naming ALREADY_HELD would confirm it exists: both
    // answer the same refusal, and nothing is filed.
    const answers = [];
    for (const id of [hiddenTask, absentTask]) {
      answers.push(await file(conn, { targetType: 'grant.rows', granteePrincipalId: OTHER.principalId, change: { rules: [exactRule('task', [id], ['read'])] } }));
    }
    expect(answers[0]).toEqual(answers[1]);
    expect(answers[0].ok ? null : [answers[0].status, answers[0].code]).toEqual([403, 'OWN_CAP_EXCEEDED']);
    expect(await deniedAudits(conn, 'OWN_CAP_EXCEEDED')).toBe(2);
    // A self-request (an ordinary user's own Account) is not cut by own(): the
    // unreadable and the absent object file alike, with the same empty
    // before-state, and the stored spec names the object the filer did not read.
    const self = await connectorOf(MEMBER.principalId);
    const filed = [];
    for (const id of [hiddenTask, absentTask]) {
      const record = await fileOk(self, { targetType: 'grant.rows', change: { rules: [exactRule('task', [id], ['read'])] } });
      expect({ id, before: record.before }).toEqual({ id, before: { rows: [] } });
      expect(parseJson((await approvalRow(record.id)).change_spec).filing).toEqual({ unreadByFiler: [`task:${id}`] });
      filed.push(record);
    }
    expect(Object.keys(filed[0]).sort()).toEqual(Object.keys(filed[1]).sort());
    // On an object the filer reads, the held row is still refused by name.
    const holder = await makeAccount('user', 'holder');
    const held = await grantService.create({ granteeId: holder, resourceType: 'task', resourceId: TASK_Y, verb: 'read' },
      { handle: 'ucr-drill', authMethod: 'system' });
    expect(await refusedCode(conn, { targetType: 'grant.rows', granteePrincipalId: holder, change: { rules: [exactRule('task', [TASK_Y], ['read'])] } }))
      .toEqual([409, 'ALREADY_HELD']);
    await grantService.remove(held.id, { handle: 'ucr-drill', authMethod: 'system' });
    for (const record of filed) await call(self, 'POST', `/delegation/access-requests/${record.id}/withdraw`, {});
  });
});

/** Denied approval.request audit rows of one filer carrying one refusal code. */
async function deniedAudits(filer: Bearer, code: string): Promise<number> {
  return (await pool.query(
    `SELECT COUNT(*)::int AS n FROM audit_events WHERE action = 'approval.request' AND outcome = 'denied' AND resource_id = $1
        AND metadata->>'refusal' = $2`, [filer.principalId, code])).rows[0].n;
}

// ═════════════════════════════ (D) deciding and applying ═════════════════════════════

describe('(D) deciding with ONE step-up and applying every S1 target', () => {
  it('D1: a bearer is refused SESSION_ONLY, and a non-administrator session is refused without spending its step-up', async () => {
    const record = await fileOk(ROOT_CONN, {
      targetType: 'grant.rows', granteePrincipalId: OTHER.principalId, change: { rules: [exactRule('task', [TASK_Y], ['read'])] },
    });
    const bearer = await call(ROOT_CONN, 'POST', `/approvals/${record.id}/approve`, { stepUpToken: 'x' });
    expect([bearer.status, bearer.json?.code]).toEqual([403, 'SESSION_ONLY']);
    // MEMBER owns nothing the request names (slice S2: TASK_Y's owner would decide it as the owner tier).
    const refused = await decide(MEMBER, record.id, 'approve');
    expect(refused.status).toBe(404);
    expect(await tokenConsumed(refused.tokenId)).toBe(false);
    const denied = await decide(OPERATOR, record.id, 'deny', { reason: 'not for this run' });
    expect([denied.status, denied.json?.approval?.status]).toEqual([200, 'denied']);
    expect((await approvalRow(record.id)).decider_standing).toBe('administrator');
  });

  it('D2: grant.rows for an Account: the administrator approves, one row per (object, verb), applied_at stamped, the Account now reads it', async () => {
    const record = await fileOk(ROOT_CONN, {
      targetType: 'grant.rows', granteePrincipalId: OTHER.principalId, change: { rules: [exactRule('task', [TASK_X], ['read'])] },
    });
    expect((await call(OTHER, 'GET', `/tasks/${TASK_X}`)).status).toBe(404);
    const approved = await decide(OPERATOR, record.id, 'approve');
    expect([approved.status, approved.json?.approval?.status]).toEqual([200, 'approved']);
    const row = await approvalRow(record.id);
    expect(row.applied_at).not.toBeNull();
    expect(row.decider_standing).toBe('administrator');
    const grants = (await pool.query('SELECT * FROM grants WHERE approval_id = $1', [record.id])).rows;
    expect(grants.map((g: any) => [g.grantee_type, String(g.grantee_id), g.resource_type, String(g.resource_id), g.verb, g.origin, g.provenance]))
      .toEqual([['principal', OTHER.principalId, 'task', TASK_X, 'read', 'manual', null]]);
    expect(parseJson(row.applied_effect).grantIds).toEqual([String(grants[0].id)]);
    expect(row.created_grant_ids).toBeNull();
    expect((await call(OTHER, 'GET', `/tasks/${TASK_X}`)).status).toBe(200);
    expect(await tokenConsumed(approved.tokenId)).toBe(true);
    expect((await children(record.id)).every((o: any) => o.pending === false)).toBe(true);
    // The decided change is terminal and its request never changes (migration 158 (f), (g)).
    await expect(pool.query(`UPDATE approvals SET status = 'lapsed', lapse_reason = 'X' WHERE id = $1`, [record.id])).rejects.toMatchObject({ code: '23514' });
    await expect(pool.query(`UPDATE approvals SET change_spec = change_spec || '{"approved":{}}'::jsonb WHERE id = $1`, [record.id])).rejects.toMatchObject({ code: '23514' });
    await expect(pool.query(`UPDATE approval_change_objects SET owner_ids = '{}' WHERE approval_id = $1`, [record.id])).rejects.toMatchObject({ code: '23514' });
  });

  it('D3: grant.rows for a Group: the row is written with grantee_type group, and a member now reads the object', async () => {
    const task = await ownerTask(OWNER, `UCR group ${tag()}`, P1);
    expect((await call(MEMBER, 'GET', `/tasks/${task}`)).status).toBe(404);
    const record = await fileOk(ROOT_CONN, {
      targetType: 'grant.rows', granteeType: 'group', granteePrincipalId: GROUP, change: { rules: [exactRule('task', [task], ['read'])] },
    });
    const approved = await decide(OPERATOR, record.id, 'approve');
    expect(approved.status).toBe(200);
    const grants = (await pool.query('SELECT grantee_type, grantee_id, expires_at FROM grants WHERE approval_id = $1', [record.id])).rows;
    expect(grants.map((g: any) => [g.grantee_type, String(g.grantee_id), g.expires_at !== null])).toEqual([['group', GROUP, true]]);
    expect((await call(MEMBER, 'GET', `/tasks/${task}`)).status).toBe(200);
  });

  it('D4: narrowing drops an object and a verb and shortens the expiry; widening is refused EDIT_ONLY_NARROWS', async () => {
    const t1 = await ownerTask(OWNER, `UCR n1 ${tag()}`, P2);
    const t2 = await ownerTask(OWNER, `UCR n2 ${tag()}`, P2);
    const record = await fileOk(ROOT_CONN, {
      targetType: 'grant.rows', granteePrincipalId: OTHER.principalId,
      change: { rules: [exactRule('task', [t1, t2], ['read', 'write'])], expiresAt: inDays(30) },
    });
    const wider = await decide(OPERATOR, record.id, 'approve', { editedChange: { rules: [exactRule('task', [t1], ['read', 'invoke'])] } });
    expect([wider.status, wider.json?.code]).toEqual([422, 'EDIT_ONLY_NARROWS']);
    expect(await tokenConsumed(wider.tokenId)).toBe(false);
    const later = await decide(OPERATOR, record.id, 'approve', { editedChange: { expiresAt: inDays(31) } });
    expect([later.status, later.json?.code]).toEqual([422, 'EDIT_ONLY_NARROWS']);
    const expiresAt = inDays(5);
    const narrowed = await decide(OPERATOR, record.id, 'approve', { editedChange: { rules: [exactRule('task', [t1], ['read'])], expiresAt } });
    expect(narrowed.status).toBe(200);
    const grants = (await pool.query('SELECT resource_id, verb, expires_at FROM grants WHERE approval_id = $1', [record.id])).rows;
    expect(grants.map((g: any) => [String(g.resource_id), g.verb, new Date(g.expires_at).toISOString()])).toEqual([[t1, 'read', expiresAt]]);
    expect(parseJson((await approvalRow(record.id)).change_spec).approved.rules).toEqual([exactRule('task', [t1], ['read'])]);
  });

  it('D5: grant.edit is decided by a root session only; root applies the edit in place', async () => {
    const grant = await grantService.create({ granteeId: OTHER.principalId, resourceType: 'task', resourceId: TASK_Y, verb: 'read', expiresAt: inDays(30) },
      { handle: 'ucr-drill', authMethod: 'system' });
    const record = await fileOk(ROOT_CONN, { targetType: 'grant.edit', targetId: grant.id, change: { expiresAt: inDays(10) } });
    const operator = await decide(OPERATOR, record.id, 'approve');
    expect([operator.status, operator.json?.code]).toEqual([403, 'APPROVAL_DECIDE_REQUIRES_ADMINISTRATOR']);
    expect(await tokenConsumed(operator.tokenId)).toBe(false);
    const hub = await call(OPERATOR, 'GET', '/approvals?view=hub&kind=change');
    expect(hub.json.approvals.find((item: any) => item.id === record.id)?.decidable).toBe(false);
    const root = await decide(ROOT2, record.id, 'approve');
    expect([root.status, root.json?.approval?.status]).toEqual([200, 'approved']);
    const after = (await pool.query('SELECT expires_at, verb FROM grants WHERE id = $1', [grant.id])).rows[0];
    expect(new Date(after.expires_at).getTime()).toBeLessThan(Date.now() + 11 * DAY);
    const audit = await pool.query(`SELECT metadata FROM audit_events WHERE action = 'grant.edit' AND resource_id = $1 AND outcome = 'success'`, [grant.id]);
    expect(parseJson(audit.rows[0].metadata)).toMatchObject({ approvalId: record.id, deciderStanding: 'root', path: 'approval-decided' });
    expect((await approvalRow(record.id)).decider_standing).toBe('root');
  });

  it('D6: grant.revoke removes the row, writes grant.revoke with the decision ledger, and the originating request records approval.revoked', async () => {
    const made = await fileOk(OP_CONN, {
      targetType: 'grant.rows', granteePrincipalId: OTHER.principalId, change: { rules: [exactRule('task', [TASK_Y], ['write'])] },
    });
    expect((await decide(ROOT, made.id, 'approve')).status).toBe(200);
    const grantId = String((await pool.query('SELECT id FROM grants WHERE approval_id = $1', [made.id])).rows[0].id);
    const record = await fileOk(OP_CONN, { targetType: 'grant.revoke', targetId: grantId, change: {} });
    expect((await decide(OPERATOR2, record.id, 'approve')).json?.code).toBe('APPROVAL_DECIDE_REQUIRES_ADMINISTRATOR');
    const root = await decide(ROOT, record.id, 'approve');
    expect([root.status, root.json?.approval?.status]).toEqual([200, 'approved']);
    expect((await pool.query('SELECT 1 FROM grants WHERE id = $1', [grantId])).rows).toHaveLength(0);
    expect((await events(made.id, 'approval.revoked')).map((e: any) => parseJson(e.metadata).byApprovalId)).toEqual([record.id]);
    // section 7.1: the target's EXISTING audit action carries the decision ledger.
    const audit = (await pool.query(
      `SELECT metadata FROM audit_events WHERE action = 'grant.revoke' AND resource_id = $1 AND outcome = 'success'`, [grantId])).rows;
    expect(audit).toHaveLength(1);
    const ledger = parseJson(audit[0].metadata);
    expect(ledger).toMatchObject({
      approvalId: record.id, kind: 'change', targetType: 'grant.revoke', deciderStanding: 'root',
      stepUp: { tokenId: root.tokenId }, before: { grant: { grantId, granteeId: OTHER.principalId, verb: 'write' } },
      after: { revoked: true }, granteeId: OTHER.principalId, verb: 'write',
    });
    expect(ledger.chain.map((link: any) => link.principalId)).toEqual([OP_CONN.principalId, OPERATOR.principalId]);
  });

  it("D7: credential.scopes: root approves and the other Connector's credential carries the scopes in place", async () => {
    const target = await connectorOf(OTHER.principalId, ['tasks:read']);
    const record = await fileOk(OP_CONN, { targetType: 'credential.scopes', targetId: target.credentialId, change: { scopes: ['tasks:read', 'reports:read'] } });
    const approved = await decide(ROOT, record.id, 'approve');
    expect([approved.status, approved.json?.approval?.status]).toEqual([200, 'approved']);
    const credential = (await pool.query('SELECT scopes, key_id FROM principal_credentials WHERE id = $1', [target.credentialId])).rows[0];
    expect(parseJson(credential.scopes).sort()).toEqual(['reports:read', 'tasks:read']);
    expect((await approvalRow(record.id)).applied_at).not.toBeNull();
  });

  it('D8: credential.issue: approve records, the requester cannot collect, the TARGET Connector collects once and its new key works', async () => {
    const target = await connectorOf(OTHER.principalId, ['tasks:read']);
    const record = await fileOk(OP_CONN, { targetType: 'credential.issue', targetId: target.principalId, change: { scopes: ['tasks:read', 'reports:read'], label: 'second harness' } });
    const approved = await decide(ROOT, record.id, 'approve', { editedChange: { transport: 'api' } });
    expect([approved.status, approved.json?.approval?.status]).toEqual([200, 'approved']);
    const pendingCollect = await approvalRow(record.id);
    expect([pendingCollect.applied_at, pendingCollect.collect_expires_at !== null]).toEqual([null, true]);
    const byRequester = await call(OP_CONN, 'POST', `/delegation/access-requests/${record.id}/collect`, {});
    expect([byRequester.status, byRequester.json?.code]).toEqual([404, 'APPROVAL_NOT_FOUND']);
    const collected = await call(target, 'POST', `/delegation/access-requests/${record.id}/collect`, {});
    expect(collected.status).toBe(201);
    expect(collected.json.credential).toMatchObject({ principalId: target.principalId, transport: 'api' });
    const again = await call(target, 'POST', `/delegation/access-requests/${record.id}/collect`, {});
    expect([again.status, again.json?.code]).toEqual([409, 'APPROVAL_NOT_COLLECTABLE']);
    const row = await approvalRow(record.id);
    expect([row.status, row.applied_at !== null, String(row.minted_principal_id), parseJson(row.applied_effect).credentialId])
      .toEqual(['collected', true, target.principalId, collected.json.credential.id]);
    expect(await events(record.id, 'approval.applied')).toHaveLength(1);
    const key = { label: 'new-key', principalId: target.principalId, headers: { Authorization: `Bearer ${collected.json.secretOnce}` } };
    expect((await call(key, 'GET', '/delegation/access-requests')).status).toBe(200);
    expect(JSON.stringify(await events(record.id, 'approval.collected'))).not.toContain(collected.json.secretOnce);
  });

  it('D9: knowledge.compartment: approve writes the core rows; the next generation carries them and stamps approval.applied once', async () => {
    const record = await fileOk(OWNER_CONN, {
      targetType: 'knowledge.compartment', change: { sourceId: SOURCE.id, operation: 'read', projectIds: [P1, P2] },
    });
    expect((await children(record.id)).map((o: any) => uuidArray(o.owner_ids))).toEqual([[OWNER.principalId], [OWNER.principalId]]);
    const approved = await decide(OPERATOR, record.id, 'approve', { editedChange: { projectIds: [P1] } });
    expect([approved.status, approved.json?.approval?.status]).toEqual([200, 'approved']);
    const rows = (await pool.query('SELECT * FROM knowledge_compartment_grants WHERE approval_id = $1', [record.id])).rows;
    expect(rows.map((r: any) => [String(r.project_id), r.subject_type, String(r.subject_id), r.operation, r.added_by, r.expires_at !== null]))
      .toEqual([[P1, 'user', OWNER.principalId, 'read', OPERATOR.principalId, true]]);
    expect((await approvalRow(record.id)).applied_at).not.toBeNull();
    await withClient(async (client: any) => {
      const now = Math.floor(Date.now() / 1000);
      const first = await prepareLifecycleGeneration(client, MAIN_CONFIG, 2, now);
      expect(first.importReadBack).toBeNull();
      expect(first.payload.projects.find((p: any) => p.id === P1).grants)
        .toContainEqual({ subject_type: 'user', subject_id: OWNER.principalId, operation: 'read', consent_ref: `approval:${record.id}` });
      expect(first.carriedApprovalIds).toContain(record.id);
      await commitLifecycleGeneration(client, MAIN_CONFIG, 2, first);
      const second = await prepareLifecycleGeneration(client, MAIN_CONFIG, 3, now + 15);
      await commitLifecycleGeneration(client, MAIN_CONFIG, 3, second);
    });
    const applied = await events(record.id, 'approval.applied');
    expect(applied.map((e: any) => parseJson(e.metadata).generation)).toEqual([2]);
    expect(parseJson((await approvalRow(record.id)).applied_effect)).toMatchObject({ generation: 2, sourceId: SOURCE.id });
  });

  it('D15: a compartment change filed beside a row the subject holds decides cleanly: the stale check compares by value, not by key order', async () => {
    const held = await fileOk(OP_CONN, {
      targetType: 'knowledge.compartment', granteePrincipalId: OTHER.principalId, change: { sourceId: SOURCE.id, operation: 'read', projectIds: [P1] },
    });
    expect((await decide(ROOT, held.id, 'approve')).status).toBe(200);
    const record = await fileOk(OP_CONN, {
      targetType: 'knowledge.compartment', granteePrincipalId: OTHER.principalId, change: { sourceId: SOURCE.id, operation: 'write', projectIds: [P1] },
    });
    expect(parseJson((await approvalRow(record.id)).change_spec).before.rows).toHaveLength(1);
    const approved = await decide(ROOT, record.id, 'approve');
    expect([approved.status, approved.json?.code ?? null]).toEqual([200, null]);
  });

  it('D10: knowledge.shared_writer: approve adds the writer row with the approval and the expiry, and ONE step-up is consumed', async () => {
    const record = await fileOk(OWNER_CONN, { targetType: 'knowledge.shared_writer', targetId: `${SOURCE.id}:organisation`, change: { expiresAt: inDays(20) } });
    const approved = await decide(OPERATOR, record.id, 'approve');
    expect([approved.status, approved.json?.approval?.status]).toEqual([200, 'approved']);
    const writer = (await pool.query('SELECT * FROM knowledge_shared_writers WHERE source_id = $1 AND account_id = $2', [SOURCE.id, OWNER.principalId])).rows[0];
    expect([String(writer.approval_id), writer.expires_at !== null, String(writer.added_by)]).toEqual([record.id, true, OPERATOR.principalId]);
    const consumed = await pool.query(
      `SELECT action, target_id FROM step_up_tokens WHERE principal_id = $1 AND consumed_at IS NOT NULL AND consumed_at > NOW() - INTERVAL '1 minute'
          AND (target_id = $2 OR target_id = $3)`, [OPERATOR.principalId, record.id, OWNER.principalId]);
    expect(consumed.rows.map((r: any) => [r.action, r.target_id])).toEqual([['approval.decide', record.id]]);
  });

  it('D11: the stale check: a target changed after filing lapses TARGET_CHANGED and refuses EDIT_STALE', async () => {
    const grant = await grantService.create({ granteeId: OTHER.principalId, resourceType: 'task', resourceId: TASK_X, verb: 'write', expiresAt: inDays(30) },
      { handle: 'ucr-drill', authMethod: 'system' });
    const record = await fileOk(ROOT_CONN, { targetType: 'grant.edit', targetId: grant.id, change: { expiresAt: inDays(10) } });
    await pool.query(`UPDATE grants SET expires_at = NOW() + INTERVAL '20 days' WHERE id = $1`, [grant.id]);
    const stale = await decide(ROOT2, record.id, 'approve');
    expect([stale.status, stale.json?.code]).toEqual([409, 'EDIT_STALE']);
    const row = await approvalRow(record.id);
    expect([row.status, row.lapse_reason]).toEqual(['lapsed', 'TARGET_CHANGED']);
  });

  it("D12: self-decision: the requester's own Account is refused SELF_DECISION_REFUSED without spending its step-up", async () => {
    const record = await fileOk(OP_CONN, {
      targetType: 'grant.rows', granteePrincipalId: OTHER.principalId, change: { rules: [exactRule('project', [P2], ['read'])] },
    });
    const self = await decide(OPERATOR, record.id, 'approve');
    expect([self.status, self.json?.code, self.json?.cases]).toEqual([403, 'SELF_DECISION_REFUSED', ['a']]);
    expect(await tokenConsumed(self.tokenId)).toBe(false);
    expect((await approvalRow(record.id)).status).toBe('pending');
    await call(OP_CONN, 'POST', `/delegation/access-requests/${record.id}/withdraw`, {});
  });

  it('D13: self-decision: a member of the Group grantee is refused SELF_DECISION_REFUSED', async () => {
    const record = await fileOk(ROOT_CONN, {
      targetType: 'grant.rows', granteeType: 'group', granteePrincipalId: GROUP, change: { rules: [exactRule('project', [P2], ['read'])] },
    });
    const member = await decide(OPERATOR2, record.id, 'approve');
    expect([member.status, member.json?.code, member.json?.cases]).toEqual([403, 'SELF_DECISION_REFUSED', ['b']]);
    expect(await tokenConsumed(member.tokenId)).toBe(false);
    await call(ROOT_CONN, 'POST', `/delegation/access-requests/${record.id}/withdraw`, {});
  });

  it('D14: KNOWLEDGE_NOT_EXPORTED is re-checked at decide: a selection that drops the subject after filing refuses the approval', async () => {
    const record = await fileOk(OWNER_CONN, {
      targetType: 'knowledge.compartment', change: { sourceId: SOURCE.id, operation: 'read', projectIds: [P2] },
    });
    recordLifecycleSelection(lifecycleConfig(SOURCE, { accountIds: [OTHER.principalId], projectIds: [P1, P2] }));
    try {
      const refused = await decide(OPERATOR, record.id, 'approve');
      expect([refused.status, refused.json?.code, refused.json?.account]).toEqual([409, 'KNOWLEDGE_NOT_EXPORTED', [OWNER.principalId]]);
      expect(await tokenConsumed(refused.tokenId)).toBe(false);
      expect((await pool.query('SELECT 1 FROM knowledge_compartment_grants WHERE approval_id = $1', [record.id])).rows).toHaveLength(0);
    } finally {
      recordLifecycleSelection(MAIN_CONFIG);
    }
    await call(OWNER_CONN, 'POST', `/delegation/access-requests/${record.id}/withdraw`, {});
  });
});

// ═════════════════════ (S) standing, deciders and the hub (slice S2) ═════════════════════

/** FILE a change on the SESSION door (POST /approvals/requests). */
async function fileSession(who: Caller, body: Record<string, unknown>): Promise<Filed> {
  const answered = await call(who, 'POST', '/approvals/requests', { reason: REASON, ...body });
  if (answered.status === 202) return { ok: true, record: answered.json.approval };
  if (!answered.json?.code) throw new Error(`session filing answered ${answered.status} without a code: ${JSON.stringify(answered.json)}`);
  return { ok: false, status: answered.status, code: String(answered.json.code), body: answered.json };
}

async function fileSessionOk(who: Caller, body: Record<string, unknown>): Promise<any> {
  const filed = await fileSession(who, body);
  if (!filed.ok) throw new Error(`expected the session filing to succeed, got ${filed.code}: ${JSON.stringify(filed.body)}`);
  return filed.record;
}

/** The hub items this session lists (GET /approvals?view=hub&status=all). */
async function hubIds(who: Caller): Promise<string[]> {
  const answer = await call(who, 'GET', '/approvals?view=hub&status=all');
  expect(answer.status).toBe(200);
  return answer.json.approvals.map((item: any) => String(item.id));
}

async function hubItem(who: Caller, id: string): Promise<any> {
  const answer = await call(who, 'GET', '/approvals?view=hub&status=all');
  return answer.json.approvals.find((item: any) => item.id === id) ?? null;
}

/** Whether this session reads one approval: the hub list, the point read and the notification history agree. */
async function sees(who: Caller, id: string): Promise<boolean> {
  const listed = (await hubIds(who)).includes(id);
  const point = (await call(who, 'GET', `/approvals/${id}`)).status;
  const notices = (await call(who, 'GET', '/tasks/notifications?who=all&type=approval')).json?.notifications ?? [];
  const noticed = notices.some((n: any) => n.approvalId === id);
  expect({ id, listed, point: point === 200, noticed }).toEqual({ id, listed, point: listed, noticed: listed });
  return listed;
}

/** Every audit row, of any action: the preview runs pool-bound validators, so S4 counts what ANY of them could write. */
async function auditCount(): Promise<number> {
  return (await pool.query('SELECT COUNT(*)::int AS n FROM audit_events')).rows[0].n;
}

/** The approval ledger rows: events and child rows. */
async function ledgerCount(): Promise<number> {
  return (await pool.query(
    'SELECT (SELECT COUNT(*) FROM approval_events)::int + (SELECT COUNT(*) FROM approval_change_objects)::int AS n')).rows[0].n;
}

async function approvalCount(): Promise<number> {
  return (await pool.query('SELECT COUNT(*)::int AS n FROM approvals')).rows[0].n;
}

/** A Group with `holder` as a member and a steward row of `role`. */
async function stewardedGroup(holder: string, role: 'owner' | 'manager'): Promise<string> {
  const group = await insertGroupRow(pool, { name: `ucr-s2-group-${tag()}` });
  await pool.query(`INSERT INTO group_members (group_id, account_principal_id, source) VALUES ($1, $2, 'local')`, [group, holder]);
  await pool.query('INSERT INTO group_stewards (group_id, account_principal_id, role) VALUES ($1, $2, $3)', [group, holder, role]);
  return group;
}

/** A pending change row of a target type no slice files yet, inserted directly with its one child row, for the decider arm. */
async function insertPendingChange(requester: Bearer, targetType: string, targetId: string, ownerIds: string[]): Promise<string> {
  const account = (await pool.query('SELECT parent_principal_id FROM principals WHERE id = $1', [requester.principalId])).rows[0].parent_principal_id;
  return withClient(async (client: any) => {
    // One transaction: migration 158 requires every change row to carry a child row at commit.
    await client.query('BEGIN');
    const row = await client.query(
      `INSERT INTO approvals (kind, requester_principal_id, requesting_credential_id, requested_scopes, requested_rules, reason,
                              pending_expires_at, target_type, target_id, change_spec)
       VALUES ('change', $1, $2, '[]'::jsonb, '[]'::jsonb, $3, NOW() + INTERVAL '7 days', $4, $5, $6::jsonb) RETURNING id`,
      [requester.principalId, requester.credentialId, REASON, targetType, targetId,
        JSON.stringify({ type: targetType, before: { restricted: false }, requested: { restricted: true } })]);
    const id = String(row.rows[0].id);
    await client.query(
      `INSERT INTO approval_change_objects (approval_id, ordinal, target_type, object_id, owner_ids, requester_account_id)
       VALUES ($1, 0, $2, $3, $4::uuid[], $5)`, [id, targetType, targetId, ownerIds, account]);
    await client.query(
      `INSERT INTO approval_events (approval_id, action, actor_principal_id, actor_handle, metadata)
       VALUES ($1, 'approval.requested', $2, 'ucr-drill', '{}'::jsonb)`, [id, requester.principalId]);
    await client.query('COMMIT');
    return id;
  });
}

/** A Connector of `accountId` that may write what it owns (the owner tier through a bearer needs the write scope). */
const WRITER_SCOPES = ['tasks:read', 'tasks:write', 'projects:read', 'projects:write', 'phases:read', 'reports:read', 'reports:write', 'principals:read'];

describe('(S) standing, deciders and the hub (slice S2)', () => {
  // A fresh root Connector per test: the requester quota (5 pending, 20 a day) is per filer.
  let RC: Bearer;
  // And a fresh Project of OWNER's per test, so no test reads authority another test's decision wrote.
  let PX: string;
  beforeEach(async () => { RC = await connectorOf(ROOT.principalId); PX = await ownerProject(OWNER, `UCR S PX ${tag()}`); });

  it('S1: a session files on POST /approvals/requests: the row binds session_evidence and no credential, and its own session withdraws it', async () => {
    const foreign = await ownerTask(OTHER, `UCR S1 ${tag()}`, await ownerProject(OTHER, `UCR S1 other ${tag()}`));
    const record = await fileSessionOk(OWNER, { targetType: 'grant.rows', change: { rules: [exactRule('task', [foreign], ['read'])] } });
    const row = await approvalRow(record.id);
    expect([row.kind, row.status, String(row.requester_principal_id), row.requesting_credential_id, parseJson(row.session_evidence)?.door,
      String(row.grantee_principal_id)]).toEqual(['change', 'pending', OWNER.principalId, null, 'request', OWNER.principalId]);
    expect(Object.keys(record)).not.toContain('decidedByPrincipalId');
    const bearer = await call(OWNER_CONN, 'POST', '/approvals/requests', { targetType: 'grant.rows', reason: REASON,
      change: { rules: [exactRule('task', [foreign], ['read'])] } });
    expect([bearer.status, bearer.json?.code]).toEqual([403, 'SESSION_ONLY']);
    const stranger = await call(OTHER, 'POST', `/approvals/${record.id}/withdraw`, {});
    expect([stranger.status, stranger.json?.code]).toEqual([404, 'APPROVAL_NOT_FOUND']);
    const withdrawn = await call(OWNER, 'POST', `/approvals/${record.id}/withdraw`, {});
    expect([withdrawn.status, withdrawn.json?.approval?.status, (await approvalRow(record.id)).lapse_reason]).toEqual([200, 'lapsed', 'WITHDRAWN']);
    expect((await children(record.id)).every((o: any) => o.pending === false)).toBe(true);
  });

  it('S2: the owner tier: a Project owner names another grantee on its own objects; a write grantee naming another grantee is refused REQUEST_STANDING_NONE (F4)', async () => {
    const S2T = await ownerTask(OWNER, `UCR S2 ${tag()}`, PX);
    const owned = await fileSessionOk(OWNER, { targetType: 'grant.rows', granteePrincipalId: OTHER.principalId,
      change: { rules: [exactRule('task', [S2T], ['read'])] } });
    expect(parseJson((await approvalRow(owned.id)).session_evidence)?.standing).toBe('owner');
    // Through a bearer the owner tier is evaluated on the chain itself: a Connector
    // whose own() reaches the Task files, one whose own() does not is refused.
    const writer = await connectorOf(OWNER.principalId, WRITER_SCOPES);
    const viaBearer = await fileOk(writer, { targetType: 'grant.rows', granteePrincipalId: MEMBER.principalId,
      change: { rules: [exactRule('task', [S2T], ['read'])] } });
    const capped = await connectorOf(OWNER.principalId, WRITER_SCOPES);
    await pool.query('UPDATE principals SET own_expression = $2::jsonb WHERE id = $1',
      [capped.principalId, JSON.stringify({ scopes: 'parent', objects: [exactRule('task', [TASK_Y], ['read', 'write'])] })]);
    expect(await refusedCode(capped, { targetType: 'grant.rows', granteePrincipalId: MEMBER.principalId,
      change: { rules: [exactRule('task', [S2T], ['read'])] } })).toEqual([403, 'REQUEST_STANDING_NONE']);
    // F4: a write grant on the object confers no standing to name another grantee.
    const grantee = await person('s2-writer', 'user');
    const held = await grantService.create({ granteeId: grantee.principalId, resourceType: 'task', resourceId: S2T, verb: 'write' },
      { handle: 'ucr-drill', authMethod: 'system' });
    const refused = await fileSession(grantee, { targetType: 'grant.rows', granteePrincipalId: MEMBER.principalId,
      change: { rules: [exactRule('task', [S2T], ['read'])] } });
    expect(refused.ok ? null : [refused.status, refused.code, refused.body.tier]).toEqual([403, 'REQUEST_STANDING_NONE', 'user']);
    await grantService.remove(held.id, { handle: 'ucr-drill', authMethod: 'system' });
    await call(OWNER, 'POST', `/approvals/${owned.id}/withdraw`, {});
    await call(writer, 'POST', `/delegation/access-requests/${viaBearer.id}/withdraw`, {});
  });

  it("S3: a target spanning two owners' Projects is refused TARGET_OUT_OF_SCOPE with the split-by-project hint (F2)", async () => {
    const theirs = await ownerProject(OTHER, `UCR S3 ${tag()}`);
    const refused = await fileSession(OWNER, { targetType: 'grant.rows', granteePrincipalId: MEMBER.principalId,
      change: { rules: [exactRule('project', [PX, theirs], ['read'])] } });
    expect(refused.ok ? null : [refused.status, refused.code, refused.body.objects, refused.body.hint])
      .toEqual([403, 'TARGET_OUT_OF_SCOPE', 1, 'split-by-project']);
  });

  it('S4: the preview answers what may be requested here and writes nothing; an unreadable object answers exactly as an absent one', async () => {
    const S4T = await ownerTask(OWNER, `UCR S4 task ${tag()}`, PX);
    const hidden = await ownerTask(OTHER, `UCR S4 hidden ${tag()}`, await privateProject(OTHER, `UCR S4 ${tag()}`));
    await pool.query(`UPDATE tasks SET visibility = 'private' WHERE id = $1`, [hidden]);
    const audits = await auditCount();
    const approvals = await approvalCount();
    const ledger = await ledgerCount();
    const preview = await call(OWNER, 'GET', `/approvals/requests/preview?objectType=task&targetId=${S4T}&granteePrincipalId=${MEMBER.principalId}`);
    expect(preview.status).toBe(200);
    const rows = preview.json.requestable.find((entry: any) => entry.targetType === 'grant.rows');
    expect(rows).toMatchObject({ grantees: 'any', fields: ['rules', 'expiresAt'] });
    expect(rows.deciders.map((d: any) => d.standing)).toEqual(['root', 'administrator', 'owner']);
    const unreadable = await call(MEMBER, 'GET', `/approvals/requests/preview?objectType=task&targetId=${hidden}`);
    const absent = await call(MEMBER, 'GET', `/approvals/requests/preview?objectType=task&targetId=${crypto.randomUUID()}`);
    expect(unreadable.status).toBe(200);
    expect(unreadable.json).toEqual(absent.json);
    const bearer = await call(OWNER_CONN, 'GET', `/delegation/access-requests/preview?targetType=grant.revoke&targetId=${crypto.randomUUID()}`);
    expect([bearer.status, bearer.json?.refused?.[0]?.code]).toEqual([200, 'REQUEST_STANDING_NONE']);
    expect([await auditCount(), await approvalCount(), await ledgerCount()]).toEqual([audits, approvals, ledger]);
  });

  it("S5: a scoped decider sees a stranger's request only on its own objects, 404 elsewhere, and decides it as the owner", async () => {
    const S5T = await ownerTask(OWNER, `UCR S5 task ${tag()}`, PX);
    const mine = await fileOk(RC, { targetType: 'grant.rows', granteePrincipalId: OTHER.principalId,
      change: { rules: [exactRule('task', [S5T], ['read'])] } });
    const elsewhere = await fileOk(RC, { targetType: 'grant.rows', granteePrincipalId: MEMBER.principalId,
      change: { rules: [exactRule('project', [await ownerProject(OTHER, `UCR S5 ${tag()}`)], ['read'])] } });
    expect(await sees(OWNER, mine.id)).toBe(true);
    expect(await sees(OWNER, elsewhere.id)).toBe(false);
    expect(await sees(MEMBER, mine.id)).toBe(false);
    expect(await hubItem(OWNER, mine.id)).toMatchObject({ decidable: true, deciders: { stepUp: true } });
    const decided = await decide(OWNER, mine.id, 'approve');
    expect([decided.status, decided.json?.approval?.status]).toEqual([200, 'approved']);
    expect((await approvalRow(mine.id)).decider_standing).toBe('owner');
    expect((await call(OTHER, 'GET', `/tasks/${S5T}`)).status).toBe(200);
    const foreign = await decide(OWNER, elsewhere.id, 'approve');
    expect(foreign.status).toBe(404);
    expect(await tokenConsumed(foreign.tokenId)).toBe(false);
    await call(RC, 'POST', `/delegation/access-requests/${elsewhere.id}/withdraw`, {});
  });

  it("S6: an item spanning two owners' Projects is invisible to each owner and decided by root (F2)", async () => {
    const theirs = await ownerProject(OTHER, `UCR S6 ${tag()}`);
    const both = await fileOk(RC, { targetType: 'grant.rows', granteePrincipalId: MEMBER.principalId,
      change: { rules: [exactRule('project', [PX, theirs], ['read'])] } });
    expect(await sees(OWNER, both.id)).toBe(false);
    expect(await sees(OTHER, both.id)).toBe(false);
    expect(await sees(ROOT2, both.id)).toBe(true);
    await call(RC, 'POST', `/delegation/access-requests/${both.id}/withdraw`, {});
  });

  it("S7: self-approval (a): the requester's own Account is refused, the owner tier included", async () => {
    const record = await fileSessionOk(OWNER, { targetType: 'grant.rows', granteePrincipalId: OTHER.principalId,
      change: { rules: [exactRule('project', [PX], ['read'])] } });
    const self = await decide(OWNER, record.id, 'approve');
    expect([self.status, self.json?.code, self.json?.cases]).toEqual([403, 'SELF_DECISION_REFUSED', ['a']]);
    expect(await tokenConsumed(self.tokenId)).toBe(false);
    await call(OWNER, 'POST', `/approvals/${record.id}/withdraw`, {});
  });

  it('S8: self-approval (b): the owner who is a member of the Group grantee is refused', async () => {
    const owner = await person('s8-owner', 'user');
    const group = await insertGroupRow(pool, { name: `ucr-s8-${tag()}` });
    await pool.query(`INSERT INTO group_members (group_id, account_principal_id, source) VALUES ($1, $2, 'local')`, [group, owner.principalId]);
    const project = await ownerProject(owner, `UCR S8 ${tag()}`);
    const record = await fileOk(RC, { targetType: 'grant.rows', granteeType: 'group', granteePrincipalId: group,
      change: { rules: [exactRule('project', [project], ['read'])] } });
    const member = await decide(owner, record.id, 'approve');
    expect([member.status, member.json?.code, member.json?.cases]).toEqual([403, 'SELF_DECISION_REFUSED', ['b']]);
    await call(RC, 'POST', `/delegation/access-requests/${record.id}/withdraw`, {});
  });

  it("S9: self-approval (c): the Account the target credential's holder lies under is refused", async () => {
    const target = await connectorOf(OPERATOR2.principalId, ['tasks:read']);
    const record = await fileOk(RC, { targetType: 'credential.scopes', targetId: target.credentialId, change: { scopes: ['tasks:read', 'reports:read'] } });
    const holder = await decide(OPERATOR2, record.id, 'approve');
    expect([holder.status, holder.json?.code, holder.json?.cases]).toEqual([403, 'SELF_DECISION_REFUSED', ['c']]);
    await call(RC, 'POST', `/delegation/access-requests/${record.id}/withdraw`, {});
  });

  it('S10: self-approval (d): an Account the approved change names is refused', async () => {
    recordLifecycleSelection(lifecycleConfig(SOURCE, {
      accountIds: [OWNER.principalId, OTHER.principalId, MEMBER.principalId, OPERATOR2.principalId], projectIds: [P1, P2],
    }));
    try {
      const record = await fileOk(RC, { targetType: 'knowledge.shared_writer', targetId: `${SOURCE.id}:organisation`,
        granteePrincipalId: OPERATOR2.principalId, change: {} });
      const named = await decide(OPERATOR2, record.id, 'approve');
      expect([named.status, named.json?.code, named.json?.cases]).toEqual([403, 'SELF_DECISION_REFUSED', ['b', 'd']]);
      await call(RC, 'POST', `/delegation/access-requests/${record.id}/withdraw`, {});
    } finally {
      recordLifecycleSelection(MAIN_CONFIG);
    }
  });

  it('S11: an operator-filed root-only target is decided by a root session only', async () => {
    const grant = await grantService.create({ granteeId: OTHER.principalId, resourceType: 'project', resourceId: PX, verb: 'read', expiresAt: inDays(30) },
      { handle: 'ucr-drill', authMethod: 'system' });
    const record = await fileOk(OP_CONN, { targetType: 'grant.revoke', targetId: grant.id, change: {} });
    expect(await hubItem(OPERATOR2, record.id)).toMatchObject({ decidable: false });
    const operator = await decide(OPERATOR2, record.id, 'approve');
    expect([operator.status, operator.json?.code]).toEqual([403, 'APPROVAL_DECIDE_REQUIRES_ADMINISTRATOR']);
    expect(await tokenConsumed(operator.tokenId)).toBe(false);
    const root = await decide(ROOT, record.id, 'approve');
    expect([root.status, root.json?.approval?.status, (await approvalRow(record.id)).decider_standing]).toEqual([200, 'approved', 'root']);
  });

  it("S12: a Group manager sees and decides grant.rows on its Group's Project, and is refused task.access on the same Project with the reason shown", async () => {
    const manager = await person('s12-manager', 'user');
    const group = await stewardedGroup(manager.principalId, 'manager');
    const project = await ownerProject(ROOT, `UCR S12 ${tag()}`);
    const task = await ownerTask(ROOT, `UCR S12 task ${tag()}`, project);
    await pool.query('UPDATE projects SET owner_principal_id = $2 WHERE id = $1', [project, group]);
    await pool.query('UPDATE tasks SET account_owner_principal_id = NULL WHERE id = $1', [task]);
    const rows = await fileOk(RC, { targetType: 'grant.rows', granteePrincipalId: OTHER.principalId,
      change: { rules: [exactRule('project', [project], ['read'])] } });
    expect(await sees(manager, rows.id)).toBe(true);
    expect(await hubItem(manager, rows.id)).toMatchObject({ decidable: true });
    const approved = await decide(manager, rows.id, 'approve');
    expect([approved.status, (await approvalRow(rows.id)).decider_standing]).toEqual([200, 'group-manager']);
    const access = await insertPendingChange(RC, 'task.access', task, [group]);
    expect(await sees(manager, access)).toBe(true);
    const item = await hubItem(manager, access);
    expect([item.decidable, item.decisionRefusal?.code]).toEqual([false, 'APPROVAL_DECIDE_REQUIRES_ADMINISTRATOR']);
    expect(item.decisionRefusal?.message).toMatch(/no Group tier reaches it|Group manager decides grant\.rows/);
    const refused = await decide(manager, access, 'approve');
    expect([refused.status, refused.json?.code, refused.json?.message]).toEqual([403, 'APPROVAL_DECIDE_REQUIRES_ADMINISTRATOR', item.decisionRefusal.message]);
    expect(await tokenConsumed(refused.tokenId)).toBe(false);
  });

  it("S13: a Report author sees its Report's item inside another owner's Project, and that Project's owner is 404-concealed (B1)", async () => {
    const author = await person('s13-author', 'user');
    const reportId = String((await pool.query(
      `INSERT INTO reports (title, content, author, author_actor_id, author_principal_id, visibility, project_id)
       VALUES ($1, 'change-request drill report', 'ucr', 'ucr', $2, 'private', $3) RETURNING id`,
      [`UCR S13 ${tag()}`, author.principalId, PX])).rows[0].id);
    const record = await fileOk(RC, { targetType: 'grant.rows', granteePrincipalId: MEMBER.principalId,
      change: { rules: [exactRule('report', [reportId], ['read'])] } });
    expect(uuidArray((await children(record.id))[0].owner_ids)).toEqual([author.principalId]);
    expect(await sees(author, record.id)).toBe(true);
    expect(await sees(OWNER, record.id)).toBe(false);
    await call(RC, 'POST', `/delegation/access-requests/${record.id}/withdraw`, {});
  });

  it("S14: a Task's own account owner sees that Task's item, and the Project owner is 404-concealed (B1)", async () => {
    const task = await ownerTask(OWNER, `UCR S14 ${tag()}`, PX);
    await pool.query('UPDATE tasks SET account_owner_principal_id = $2 WHERE id = $1', [task, OTHER.principalId]);
    const record = await fileOk(RC, { targetType: 'grant.rows', granteePrincipalId: MEMBER.principalId,
      change: { rules: [exactRule('task', [task], ['read'])] } });
    expect(await sees(OTHER, record.id)).toBe(true);
    expect(await sees(OWNER, record.id)).toBe(false);
    await call(RC, 'POST', `/delegation/access-requests/${record.id}/withdraw`, {});
  });

  it('S15: the decision stores the field and relationship diff; the requester view carries the field diff only', async () => {
    const task = await ownerTask(OWNER, `UCR S15 ${tag()}`, PX);
    const record = await fileOk(RC, { targetType: 'grant.rows', granteePrincipalId: MEMBER.principalId,
      change: { rules: [exactRule('task', [task], ['read', 'write'])] } });
    const pending = await call(OWNER, 'GET', `/approvals/${record.id}`);
    expect(pending.json?.decision?.change?.summary).toBe('1 principal gains read, write on 1 object; nothing is removed');
    expect(await decide(OWNER, record.id, 'approve')).toMatchObject({ status: 200 });
    const diff = parseJson((await approvalRow(record.id)).change_spec).diff;
    expect(diff.relationships.map((e: any) => [e.principal.id, e.object, e.action, e.state])).toEqual([
      [MEMBER.principalId, `task:${task}`, 'read', 'added'], [MEMBER.principalId, `task:${task}`, 'write', 'added'],
    ]);
    expect(diff.summary).toBe('1 principal gains read, write on 1 object; nothing is removed');
    const view = (await call(RC, 'GET', `/delegation/access-requests/${record.id}`)).json.approval;
    expect(Object.keys(view.diff ?? {})).toEqual(['fields']);
    expect(JSON.stringify(view)).not.toContain('"relationships"');
  });

  it('S16: a legacy-kind item reads through the projection with its relationship diff in the hub (F9)', async () => {
    const foreign = await ownerTask(OTHER, `UCR S16 ${tag()}`, await ownerProject(OTHER, `UCR S16 other ${tag()}`));
    const legacy = await call(OWNER_CONN, 'POST', '/delegation/access-requests', {
      kind: 'grant', reason: REASON, requestedRules: [exactRule('task', [foreign], ['read'])], relatedTaskId: TASK_X,
    });
    expect([legacy.status, legacy.json?.approval?.kind]).toEqual([202, 'grant']);
    const id = String(legacy.json.approval.id);
    const item = await hubItem(ROOT, id);
    expect(item.relationships.edges.map((e: any) => [e.principal.id, e.object, e.action, e.state]))
      .toEqual([[OWNER.principalId, `task:${foreign}`, 'read', 'added']]);
    expect(item.relationships.summary).toBe('1 principal gains read on 1 object; nothing is removed');
    expect((await approvalRow(id)).change_spec).toBeNull();
    await call(OWNER_CONN, 'POST', `/delegation/access-requests/${id}/withdraw`, {});
  });

  it('S17: an executor accepts only the decision\'s own consumed step-up as evidence: forged evidence is refused STEP_UP_REQUIRED', async () => {
    const S17T = await ownerTask(OWNER, `UCR S17 ${tag()}`, PX);
    const { authorityEditExecutor } = require('../services/AuthorityEditExecutor');
    const grant = await grantService.create({ granteeId: OTHER.principalId, resourceType: 'task', resourceId: S17T, verb: 'read', expiresAt: inDays(30) },
      { handle: 'ucr-drill', authMethod: 'system' });
    await withClient(async (client: any) => {
      await client.query('BEGIN');
      try {
        await expect(authorityEditExecutor.applyDecidedChange(client, {
          type: 'grant', id: grant.id, fields: { expiresAt: inDays(5) }, approvalId: crypto.randomUUID(),
          decider: { principalId: ROOT.principalId, standing: 'root', sessionScopes: ['root'] },
          stepUp: { tokenId: crypto.randomUUID(), method: 'password' },
          evidence: { tokenId: crypto.randomUUID(), method: 'password', approvalId: crypto.randomUUID(), deciderPrincipalId: ROOT.principalId },
        }, { handle: 'ucr-drill', authMethod: 'system' })).rejects.toMatchObject({ code: 'STEP_UP_REQUIRED' });
      } finally {
        await client.query('ROLLBACK');
      }
    });
    expect((await pool.query('SELECT expires_at FROM grants WHERE id = $1', [grant.id])).rows[0].expires_at).toEqual(new Date(grant.expiresAt));
    await grantService.remove(grant.id, { handle: 'ucr-drill', authMethod: 'system' });
  });

  it('S18: a legacy identity is refused DECIDER_NO_LONGER_ADMITTED at decide, for every kind, before the step-up is spent', async () => {
    const legacyOperator = await person('s18-operator', 'operator');
    const change = await fileOk(RC, { targetType: 'grant.rows', granteePrincipalId: OTHER.principalId,
      change: { rules: [exactRule('project', [PX], ['write'])] } });
    // A legacy kind too (section 12 Q20 (a): the rule is every kind's, not the change kind's alone).
    const foreign = await ownerTask(OTHER, `UCR S18 ${tag()}`, await ownerProject(OTHER, `UCR S18 other ${tag()}`));
    const grantKind = await call(OWNER_CONN, 'POST', '/delegation/access-requests', {
      kind: 'grant', reason: REASON, requestedRules: [exactRule('task', [foreign], ['read'])], relatedTaskId: TASK_X,
    });
    expect(grantKind.status).toBe(202);
    await pool.query('UPDATE principals SET legacy_identity = TRUE WHERE id = $1', [legacyOperator.principalId]);
    try {
      for (const id of [change.id, String(grantKind.json.approval.id)]) {
        const refused = await decide(legacyOperator, id, 'approve');
        expect({ id, got: [refused.status, refused.json?.code] }).toEqual({ id, got: [403, 'DECIDER_NO_LONGER_ADMITTED'] });
        expect(await tokenConsumed(refused.tokenId)).toBe(false);
        expect((await approvalRow(id)).status).toBe('pending');
      }
    } finally {
      await pool.query('UPDATE principals SET legacy_identity = FALSE WHERE id = $1', [legacyOperator.principalId]);
    }
    await call(RC, 'POST', `/delegation/access-requests/${change.id}/withdraw`, {});
    await call(OWNER_CONN, 'POST', `/delegation/access-requests/${grantKind.json.approval.id}/withdraw`, {});
  });

  it("S19: the requester's own status read, queue row and hub item carry the field diff only, never the relationship diff or the decider, on the session and the bearer door (B1)", async () => {
    // A person files on the session door; root decides.
    const record = await fileSessionOk(OWNER, { targetType: 'grant.rows', granteePrincipalId: OTHER.principalId,
      change: { rules: [exactRule('project', [PX], ['read'])] } });
    const pending = await call(OWNER, 'GET', `/approvals/${record.id}`);
    expect([pending.status, pending.json?.decision?.view, Object.keys(pending.json?.decision?.change ?? {}).sort()])
      .toEqual([200, 'requester', ['decided', 'fields']]);
    expect(await decide(ROOT, record.id, 'approve')).toMatchObject({ status: 200 });
    expect(parseJson((await approvalRow(record.id)).change_spec).diff.relationships).toHaveLength(1);
    // The decider reads the relationship diff and its own identity.
    const asDecider = await call(ROOT, 'GET', `/approvals/${record.id}`);
    expect([asDecider.json.decision.view, asDecider.json.decision.change.relationships.length, asDecider.json.approval.decidedByPrincipalId])
      .toEqual(['decider', 1, ROOT.principalId]);
    // Its requester reads the field diff only, on every surface it reads the item through.
    const read = await call(OWNER, 'GET', `/approvals/${record.id}`);
    const item = await hubItem(OWNER, record.id);
    const queued = (await call(OWNER, 'GET', '/approvals')).json.approvals.find((a: any) => a.id === record.id);
    expect([read.json.approval.status, read.json.decision.view, Object.keys(read.json.decision.change).sort()])
      .toEqual(['approved', 'requester', ['decided', 'fields']]);
    expect(Array.isArray(read.json.decision.change.fields) && read.json.decision.change.fields.length > 0).toBe(true);
    expect([item.view, item.relationships, Array.isArray(item.fieldDiff), item.decidedByPrincipalId, item.change.deciderStanding])
      .toEqual(['requester', null, true, null, null]);
    for (const [where, body] of [['point read', read.json], ['hub item', item], ['queue row', queued]] as const) {
      const text = JSON.stringify(body);
      expect({ where, decider: text.includes(ROOT.principalId), edges: /"relationships":[[{]|"edges"|"summary"/.test(text) })
        .toEqual({ where, decider: false, edges: false });
    }
    // A bearer filing: its Connector's status read and its Account's session read alike.
    const S19T = await ownerTask(OWNER, `UCR S19 ${tag()}`, PX);
    const filed = await fileOk(RC, { targetType: 'grant.rows', granteePrincipalId: MEMBER.principalId,
      change: { rules: [exactRule('task', [S19T], ['read'])] } });
    expect(await decide(ROOT2, filed.id, 'approve')).toMatchObject({ status: 200 });
    const bearer = (await call(RC, 'GET', `/delegation/access-requests/${filed.id}`)).json;
    const account = (await call(ROOT, 'GET', `/approvals/${filed.id}`)).json;
    expect(account.decision.view).toBe('requester');
    for (const [where, body] of [['bearer status read', bearer], ['session read of a bearer filing', account]] as const) {
      const text = JSON.stringify(body);
      expect({ where, decider: text.includes(ROOT2.principalId), edges: /"relationships":[[{]|"edges"|"summary"/.test(text) })
        .toEqual({ where, decider: false, edges: false });
    }
  });

  it('S20: a credential.scopes diff projects what the change reaches by the legacy projection: effectiveAfterEdit and identitiesReached (B2)', async () => {
    // The holder Connector of an ordinary user, with one live Agent under it.
    const holder = await connectorOf(OTHER.principalId, ['tasks:read']);
    const bound = await ownerTask(OTHER, `UCR S20 ${tag()}`, await ownerProject(OTHER, `UCR S20 ${tag()}`));
    const agent = String((await pool.query(
      `INSERT INTO principals (kind, handle, display_name, status, parent_principal_id, bound_task_id, own_expression)
       VALUES ('agent', $1, $1, 'active', $2, $3, '{"scopes":"parent","objects":[]}'::jsonb) RETURNING id`,
      [`ucr-s20-agent-${tag()}`, holder.principalId, bound])).rows[0].id);
    await principalService.issueCredential({ principalId: agent, scopes: ['tasks:read'], label: `ucr-${tag()}`, transport: 'any' });
    const record = await fileOk(RC, { targetType: 'credential.scopes', targetId: holder.credentialId, change: { scopes: ['tasks:read', 'reports:read'] } });
    // The projection the legacy edit decision block reads, called directly.
    const { credentialReach } = require('../services/ApprovalService');
    const reach = await credentialReach(holder.principalId, [['tasks:read'], ['tasks:read', 'reports:read']]);
    expect([reach.effective, reach.identitiesReached.map((i: any) => i.principalId)]).toEqual([[['tasks:read'], ['tasks:read', 'reports:read']], [agent]]);
    const projected = (edges: any[]) => edges.filter((e) => e.via === 'effectiveAfterEdit' || e.via === 'identitiesReached')
      .map((e) => [e.principal.id, e.object, e.action, e.state, e.via]);
    const expected = [
      [holder.principalId, `credential:${holder.credentialId}`, 'reports:read', 'added', 'effectiveAfterEdit'],
      [holder.principalId, `credential:${holder.credentialId}`, 'tasks:read', 'kept', 'effectiveAfterEdit'],
      [agent, `principal:${holder.principalId}`, 'reached', 'kept', 'identitiesReached'],
    ];
    const summary = '1 principal gains reports:read on 1 object; nothing is removed; the change reaches 1 identity';
    const pending = await call(ROOT2, 'GET', `/approvals/${record.id}`);
    expect([projected(pending.json.decision.change.relationships), pending.json.decision.change.summary]).toEqual([expected, summary]);
    expect(projected((await hubItem(ROOT2, record.id)).relationships.edges)).toEqual(expected);
    const decided = await decide(ROOT2, record.id, 'approve');
    expect([decided.status, decided.json?.code ?? null]).toEqual([200, null]);
    const stored = parseJson((await approvalRow(record.id)).change_spec).diff;
    expect([projected(stored.relationships), stored.summary]).toEqual([expected, summary]);
  });

  it("S21: the hub's decidable and refusal answer what decide answers: self-approval (a), the owner tier included", async () => {
    const S21T = await ownerTask(OWNER, `UCR S21 ${tag()}`, PX);
    const own = await fileOk(OWNER_CONN, { targetType: 'grant.rows', granteePrincipalId: MEMBER.principalId,
      change: { rules: [exactRule('task', [S21T], ['read'])] } });
    const item = await hubItem(OWNER, own.id);
    expect([item.decidable, item.decisionRefusal?.code]).toEqual([false, 'SELF_DECISION_REFUSED']);
    const self = await decide(OWNER, own.id, 'approve');
    expect([self.status, self.json?.code, self.json?.message]).toEqual([403, item.decisionRefusal.code, item.decisionRefusal.message]);
    expect(await tokenConsumed(self.tokenId)).toBe(false);
    await call(OWNER_CONN, 'POST', `/delegation/access-requests/${own.id}/withdraw`, {});
  });

  it("S22: the hub's decidable and refusal answer what decide answers: a decider no longer live", async () => {
    const operator = await person('s22-operator', 'operator');
    const change = await fileOk(RC, { targetType: 'grant.rows', granteePrincipalId: OTHER.principalId,
      change: { rules: [exactRule('project', [PX], ['read'])] } });
    expect(await hubItem(operator, change.id)).toMatchObject({ decidable: true, decisionRefusal: null });
    await pool.query('UPDATE principals SET legacy_identity = TRUE WHERE id = $1', [operator.principalId]);
    try {
      const stale = await hubItem(operator, change.id);
      expect([stale.decidable, stale.decisionRefusal?.code]).toEqual([false, 'DECIDER_NO_LONGER_ADMITTED']);
      const refused = await decide(operator, change.id, 'approve');
      expect([refused.status, refused.json?.code]).toEqual([403, stale.decisionRefusal.code]);
      expect(await tokenConsumed(refused.tokenId)).toBe(false);
    } finally {
      await pool.query('UPDATE principals SET legacy_identity = FALSE WHERE id = $1', [operator.principalId]);
    }
    await call(RC, 'POST', `/delegation/access-requests/${change.id}/withdraw`, {});
  });

  it("S23: section 4.1 row 5's scope half: a bearer without the type's write scope has no owner standing; one with it files", async () => {
    // OWNER_CONN carries projects:read but not projects:write.
    expect(await refusedCode(OWNER_CONN, { targetType: 'grant.rows', granteePrincipalId: MEMBER.principalId,
      change: { rules: [exactRule('project', [PX], ['read'])] } })).toEqual([403, 'REQUEST_STANDING_NONE']);
    const writer = await connectorOf(OWNER.principalId, WRITER_SCOPES);
    const filed = await fileOk(writer, { targetType: 'grant.rows', granteePrincipalId: MEMBER.principalId,
      change: { rules: [exactRule('project', [PX], ['read'])] } });
    await call(writer, 'POST', `/delegation/access-requests/${filed.id}/withdraw`, {});
  });

  it("S24: section 4.1 row 5's own() gate: an Account-side owner source counts only where the delegation chain holds", async () => {
    // The Connector claims the Task, so it reads and writes it through the
    // claimant arm, but its own() reaches another Task only: the Account's
    // owner source is gated on the chain, and the chain does not hold here.
    const S24T = await ownerTask(OWNER, `UCR S24 ${tag()}`, PX);
    const capped = await connectorOf(OWNER.principalId, WRITER_SCOPES);
    await pool.query('UPDATE principals SET own_expression = $2::jsonb WHERE id = $1',
      [capped.principalId, JSON.stringify({ scopes: 'parent', objects: [exactRule('task', [TASK_Y], ['read', 'write'])] })]);
    await pool.query('UPDATE tasks SET owner_principal_id = $2 WHERE id = $1', [S24T, capped.principalId]);
    expect((await call(capped, 'GET', `/tasks/${S24T}`)).status).toBe(200);
    expect(await refusedCode(capped, { targetType: 'grant.rows', granteePrincipalId: MEMBER.principalId,
      change: { rules: [exactRule('task', [S24T], ['read'])] } })).toEqual([403, 'REQUEST_STANDING_NONE']);
  });

  it("S25: a credential.issue diff projects what the new credential could exercise, as the credential request's block shows it, and no identity (B2)", async () => {
    // A Connector with one live Agent under it: a NEW credential changes no existing one, so no identity is reached.
    const holder = await connectorOf(OTHER.principalId, ['tasks:read']);
    const bound = await ownerTask(OTHER, `UCR S25 ${tag()}`, await ownerProject(OTHER, `UCR S25 ${tag()}`));
    const agent = String((await pool.query(
      `INSERT INTO principals (kind, handle, display_name, status, parent_principal_id, bound_task_id, own_expression)
       VALUES ('agent', $1, $1, 'active', $2, $3, '{"scopes":"parent","objects":[]}'::jsonb) RETURNING id`,
      [`ucr-s25-agent-${tag()}`, holder.principalId, bound])).rows[0].id);
    await principalService.issueCredential({ principalId: agent, scopes: ['tasks:read'], label: `ucr-${tag()}`, transport: 'any' });
    const { credentialReach } = require('../services/ApprovalService');
    expect((await credentialReach(holder.principalId, [['reports:read']], { identities: false })).effective).toEqual([['reports:read']]);
    const issue = await fileOk(RC, { targetType: 'credential.issue', targetId: holder.principalId, change: { scopes: ['reports:read'] } });
    const projected = (edges: any[]) => edges.filter((e) => e.via === 'effectiveAfterIssue' || e.via === 'identitiesReached')
      .map((e) => [e.principal.id, e.object, e.action, e.state, e.via]);
    const expected = [[holder.principalId, 'credential:new', 'reports:read', 'added', 'effectiveAfterIssue']];
    expect(projected((await call(ROOT2, 'GET', `/approvals/${issue.id}`)).json.decision.change.relationships)).toEqual(expected);
    expect(projected((await hubItem(ROOT2, issue.id)).relationships.edges)).toEqual(expected);
    await call(RC, 'POST', `/delegation/access-requests/${issue.id}/withdraw`, {});
  });
});

// ═════════════════════ (C) the surfaces for the first use (slice S3) ═════════════════════

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
/** The JSON a tool answered, with the server's untrusted-data marker left in place. */
const mcpJson = (answer: Answer): any => JSON.parse(mcpText(answer));

async function handleOf(principalId: string): Promise<string> {
  return String((await pool.query('SELECT handle FROM principals WHERE id = $1', [principalId])).rows[0].handle);
}

/** The approval rows of one approval in this session's history, oldest first. */
async function historyOf(who: Caller, approvalId: string): Promise<any[]> {
  const answer = await call(who, 'GET', '/tasks/notifications?who=all&type=approval&limit=100');
  expect(answer.status).toBe(200);
  return (answer.json.notifications as any[]).filter((n) => n.approvalId === approvalId).reverse();
}

describe('(C) the surfaces for the first use (slice S3)', () => {
  let WRITER: Bearer;
  let PC: string;
  beforeAll(async () => {
    // A Connector of the Project owner that may write what it owns: the owner tier through a bearer.
    WRITER = await connectorOf(OWNER.principalId, WRITER_SCOPES);
    PC = await ownerProject(OWNER, `UCR C ${tag()}`);
    const brief = await mcpCall(WRITER, 'relayhall_brief_compile', { session: true });
    expect(mcpFailed(brief)).toBe(false);
  });

  it('C1: preview over MCP answers what may be requested on a Project and writes nothing', async () => {
    const approvals = await approvalCount();
    const ledger = await ledgerCount();
    const requested = async () => (await pool.query(`SELECT COUNT(*)::int AS n FROM audit_events WHERE action = 'approval.request'`)).rows[0].n;
    const filings = await requested();
    const preview = await mcpCall(WRITER, 'relayhall_access_request', {
      action: 'preview', objectType: 'project', targetId: PC, granteePrincipalId: MEMBER.principalId,
    });
    expect(mcpFailed(preview)).toBe(false);
    // The preview's own shape (requestable and refused), never another route's answer.
    expect(Object.keys(mcpJson(preview)).filter((key) => key === 'requestable' || key === 'refused').sort()).toEqual(['refused', 'requestable']);
    const rows = mcpJson(preview).requestable.find((entry: any) => entry.targetType === 'grant.rows');
    expect(rows).toMatchObject({ grantees: 'any', fields: ['rules', 'expiresAt'] });
    expect(rows.deciders.map((d: any) => d.standing)).toEqual(['root', 'administrator', 'owner']);
    expect([await approvalCount(), await ledgerCount(), await requested()]).toEqual([approvals, ledger, filings]);
    // A preview naming an object nobody may read answers exactly as an absent one.
    const hidden = await privateProject(OTHER, `UCR C1 ${tag()}`);
    const absent = await mcpCall(WRITER, 'relayhall_access_request', { action: 'preview', objectType: 'project', targetId: crypto.randomUUID() });
    const unreadable = await mcpCall(WRITER, 'relayhall_access_request', { action: 'preview', objectType: 'project', targetId: hidden });
    const shape = (answer: Answer) => { const body = mcpJson(answer); return [body.requestable.map((e: any) => [e.targetType, e.grantees]), body.refused]; };
    expect(shape(unreadable)).toEqual(shape(absent));
  });

  it('C2: kind change files over MCP for another grantee; a repeat is refused CHANGE_PENDING naming the same request', async () => {
    const body = {
      action: 'file', kind: 'change', targetType: 'grant.rows', granteePrincipalId: MEMBER.principalId, reason: REASON,
      change: { rules: [exactRule('project', [PC], ['read'])] },
    };
    const filed = await mcpCall(WRITER, 'relayhall_access_request', body);
    expect(mcpFailed(filed)).toBe(false);
    const id = String(mcpJson(filed).approval.id);
    const row = await approvalRow(id);
    expect([row.kind, row.status, row.target_type, String(row.requesting_credential_id), String(row.grantee_principal_id)])
      .toEqual(['change', 'pending', 'grant.rows', WRITER.credentialId, MEMBER.principalId]);
    const again = await mcpCall(WRITER, 'relayhall_access_request', body);
    expect([mcpFailed(again), mcpText(again).includes('CHANGE_PENDING'), mcpText(again).includes(id)]).toEqual([true, true, true]);
    // The change fields are the change kind's only: a legacy field is refused before anything is dispatched.
    const mixed = await mcpCall(WRITER, 'relayhall_access_request', { ...body, requestedRules: [] });
    expect([mcpFailed(mixed), mcpText(mixed).includes('Unknown arguments: requestedRules')]).toEqual([true, true]);
    // The named refusals reach the model by name.
    // Re-anchored BY NAME on a T3 S7 target once slice S5 built project.owner (card 9ce0b0b0).
    const later = await mcpCall(WRITER, 'relayhall_access_request', { ...body, targetType: 'group.member', change: {} });
    expect([mcpFailed(later), mcpText(later).includes('TARGET_NOT_AVAILABLE')]).toEqual([true, true]);
    const inert = await mcpCall(WRITER, 'relayhall_access_request', { ...body, granteePrincipalId: OWNER_CONN.principalId });
    expect([mcpFailed(inert), mcpText(inert).includes('GRANTEE_INERT')]).toEqual([true, true]);
    // Deciding stays off MCP: there is no tool for it, and the bearer is refused on the decide route.
    const stepUp = await stepUpService.mint(OWNER.principalId, 'approval.decide', id, 'password');
    const bearerDecide = await call(WRITER, 'POST', `/approvals/${id}/approve`, { stepUpToken: stepUp.token });
    expect([bearerDecide.status, bearerDecide.json?.code]).toEqual([403, 'SESSION_ONLY']);
    const withdrawn = await mcpCall(WRITER, 'relayhall_access_request', { action: 'withdraw', approvalId: id });
    expect([mcpFailed(withdrawn), (await approvalRow(id)).lapse_reason]).toEqual([false, 'WITHDRAWN']);
  });

  it('C3: status lists every kind, the agent-mint requests included; the default REST list keeps its bytes', async () => {
    const task = await ownerTask(OWNER, `UCR C3 ${tag()}`, PC);
    const minted = await call(WRITER, 'POST', '/delegation/agent-mints',
      { targetTaskId: task, requestedScopes: ['tasks:read', 'tasks:write'], via: 'approval' }, { 'Idempotency-Key': `ucr-c3-${crypto.randomUUID()}` });
    expect([minted.status, minted.json?.path]).toEqual([202, 'approval']);
    const mint = String(minted.json.approval.id);
    const filedChange = await mcpCall(WRITER, 'relayhall_access_request', {
      action: 'file', kind: 'change', targetType: 'grant.rows', granteePrincipalId: MEMBER.principalId, reason: REASON,
      change: { rules: [exactRule('task', [task], ['read'])] },
    });
    expect(mcpFailed(filedChange)).toBe(false);
    const change = String(mcpJson(filedChange).approval.id);
    const every = mcpJson(await mcpCall(WRITER, 'relayhall_access_request', { action: 'status', status: 'pending' }));
    expect(every.approvals.map((a: any) => a.id)).toEqual(expect.arrayContaining([mint, change]));
    const mintView = every.approvals.find((a: any) => a.id === mint);
    expect([mintView.kind, mintView.targetTaskId, [...mintView.requestedScopes].sort()]).toEqual(['agent-mint', task, ['tasks:read', 'tasks:write']]);
    expect(JSON.stringify(mintView)).not.toMatch(/decidedByPrincipalId|decisionStepUp|secretOnce/);
    const mintsOnly = mcpJson(await mcpCall(WRITER, 'relayhall_access_request', { action: 'status', kind: 'agent-mint' }));
    expect(mintsOnly.approvals.map((a: any) => a.kind)).toEqual(mintsOnly.approvals.map(() => 'agent-mint'));
    expect(mintsOnly.approvals.map((a: any) => a.id)).toContain(mint);
    const changes = mcpJson(await mcpCall(WRITER, 'relayhall_access_request', { action: 'status', kind: 'change', status: 'pending' }));
    expect(changes.approvals.map((a: any) => a.id)).toEqual([change]);
    // The REST default (no kind) is exactly what it always was: every kind but agent-mint.
    const rest = await call(WRITER, 'GET', '/delegation/access-requests');
    expect(rest.json.approvals.map((a: any) => a.kind)).not.toContain('agent-mint');
    expect(rest.json.approvals.map((a: any) => a.id)).toContain(change);
    await call(WRITER, 'POST', `/delegation/access-requests/${change}/withdraw`, {});
  });

  it("C4: the requester's notification history never names the decider; the decider's does (sections 4.3 and 6)", async () => {
    const record = await fileSessionOk(OWNER, { targetType: 'grant.rows', granteePrincipalId: OTHER.principalId,
      change: { rules: [exactRule('project', [PC], ['read'])] } });
    expect(await decide(ROOT, record.id, 'approve')).toMatchObject({ status: 200 });
    const [ownerHandle, rootHandle] = [await handleOf(OWNER.principalId), await handleOf(ROOT.principalId)];
    const mine = await historyOf(OWNER, record.id);
    expect(mine.map((n) => [n.approvalAction, n.actorHandle])).toEqual([
      ['approval.requested', ownerHandle], ['approval.approved', null],
    ]);
    expect(JSON.stringify(mine)).not.toContain(rootHandle);
    const theirs = await historyOf(ROOT, record.id);
    expect(theirs.map((n) => [n.approvalAction, n.actorHandle])).toEqual([
      ['approval.requested', ownerHandle], ['approval.approved', rootHandle],
    ]);
    // Every kind alike: a grant request a Connector of OWNER filed, denied by root.
    const related = await ownerTask(OWNER, `UCR C4 ${tag()}`, PC);
    const foreign = await ownerTask(OTHER, `UCR C4 other ${tag()}`, await ownerProject(OTHER, `UCR C4 other ${tag()}`));
    const filer = await connectorOf(OWNER.principalId);
    const legacy = await call(filer, 'POST', '/delegation/access-requests', {
      kind: 'grant', requestedRules: [exactRule('task', [foreign], ['read'])], reason: REASON, relatedTaskId: related,
    });
    expect(legacy.status).toBe(202);
    const legacyId = String(legacy.json.approval.id);
    expect(await decide(ROOT, legacyId, 'deny', { reason: 'drill' })).toMatchObject({ status: 200 });
    const connectorHandle = await handleOf(filer.principalId);
    expect((await historyOf(OWNER, legacyId)).map((n) => [n.approvalAction, n.actorHandle])).toEqual([
      ['approval.requested', connectorHandle], ['approval.denied', null],
    ]);
    expect((await historyOf(ROOT, legacyId)).map((n) => n.actorHandle)).toEqual([connectorHandle, rootHandle]);
  });
});

// ═════════════════════════════ (X) the exporter reads core ═════════════════════════════

describe('(X) the lifecycle exporter reads the core tables', () => {
  it('X1: the carry-over keeps consent_ref with no approval and added_by system, and records the byte-equal read-back as knowledge.lifecycle.import', async () => {
    const source = await makeKnowledgeSource('import');
    const config = lifecycleConfig(source, {
      accountIds: [OWNER.principalId, OTHER.principalId], projectIds: [P1, P2],
      projectGrants: [
        { projectId: P1, grants: [
          { subject_type: 'user', subject_id: OTHER.principalId, operation: 'write', consent_ref: 'h-g4-1' },
          { subject_type: 'user', subject_id: OWNER.principalId, operation: 'read', consent_ref: 'h-g4-2' },
        ] },
        { projectId: P2, grants: [{ subject_type: 'user', subject_id: OWNER.principalId, operation: 'read', consent_ref: 'h-g4-3' }] },
      ],
      personalConsents: [{ owner_id: OWNER.principalId, reader_id: OTHER.principalId, consent_ref: 'pc-1' }],
    });
    await withClient(async (client: any) => {
      const now = Math.floor(Date.now() / 1000);
      const prepared = await prepareLifecycleGeneration(client, config, 7, now);
      expect(prepared.importReadBack).toMatchObject({ rowCount: 4, digest: expect.stringMatching(/^[0-9a-f]{64}$/) });
      await commitLifecycleGeneration(client, config, 7, prepared);
      const again = await prepareLifecycleGeneration(client, config, 8, now + 15);
      expect(again.importReadBack).toBeNull();
      expect(JSON.stringify(again.payload.projects)).toBe(JSON.stringify(prepared.payload.projects));
    });
    const rows = (await pool.query(
      `SELECT project_id, subject_id, operation, consent_ref, approval_id, added_by FROM knowledge_compartment_grants
        WHERE source_id = $1 ORDER BY consent_ref`, [source.id])).rows;
    expect(rows.map((r: any) => [String(r.project_id), String(r.subject_id), r.operation, r.consent_ref, r.approval_id, r.added_by])).toEqual([
      [P1, OTHER.principalId, 'write', 'h-g4-1', null, 'system'],
      [P1, OWNER.principalId, 'read', 'h-g4-2', null, 'system'],
      [P2, OWNER.principalId, 'read', 'h-g4-3', null, 'system'],
    ]);
    expect((await pool.query('SELECT consent_ref, added_by FROM knowledge_personal_consents WHERE source_id = $1', [source.id])).rows)
      .toEqual([{ consent_ref: 'pc-1', added_by: 'system' }]);
    const audit = (await pool.query(
      `SELECT metadata, auth_method FROM audit_events WHERE action = 'knowledge.lifecycle.import' AND resource_id = $1`, [source.id])).rows;
    expect(audit).toHaveLength(1);
    expect(parseJson(audit[0].metadata)).toMatchObject({
      generation: 7, rowCount: 4, selection: { accountSelection: 'explicit', projectSelection: 'explicit', accountCount: 2, projectCount: 2 },
    });
  });

  it('X2: the read-back refuses LIFECYCLE_EXPORT_REFUSED unless the table-derived grants equal the configuration byte for byte', async () => {
    const source = await makeKnowledgeSource('readback');
    const config = lifecycleConfig(source, {
      accountIds: [OWNER.principalId], projectIds: [P1],
      projectGrants: [{ projectId: P1, grants: [{ subject_type: 'user', subject_id: OWNER.principalId, operation: 'read', consent_ref: 'rb-1' }] }],
    });
    // A row already in the table that the configuration does not carry: the read-back must refuse.
    await pool.query(
      `INSERT INTO knowledge_compartment_grants (source_id, project_id, subject_type, subject_id, operation, consent_ref, added_by)
       VALUES ($1, $2, 'user', $3, 'write', 'rb-extra', 'system')`, [source.id, P1, OWNER.principalId]);
    await withClient(async (client: any) => {
      await expect(prepareLifecycleGeneration(client, config, 1, Math.floor(Date.now() / 1000))).rejects.toThrow('LIFECYCLE_EXPORT_REFUSED');
    });
    expect((await pool.query(`SELECT 1 FROM audit_events WHERE action = 'knowledge.lifecycle.import' AND resource_id = $1`, [source.id])).rows).toHaveLength(0);
    // The function itself: equal payloads give a digest, a changed consent_ref refuses.
    const payload = { projects: [{ id: P1, grants: [{ subject_type: 'user', subject_id: OWNER.principalId, operation: 'read', consent_ref: 'a' }] }], personal_consents: [] };
    expect(lifecycleImportReadBack(payload, JSON.parse(JSON.stringify(payload))).rowCount).toBe(1);
    expect(() => lifecycleImportReadBack(payload, { ...payload, projects: [{ ...payload.projects[0], grants: [{ ...payload.projects[0].grants[0], consent_ref: 'b' }] }] }))
      .toThrow('LIFECYCLE_EXPORT_REFUSED');
  });

  it('X3: E299 F3: a table row for a subject outside the export selection is filtered, never shipped', async () => {
    const source = await makeKnowledgeSource('f3');
    const config = lifecycleConfig(source, { accountIds: [OWNER.principalId], projectIds: [P1] });
    await withClient(async (client: any) => {
      const first = await prepareLifecycleGeneration(client, config, 1, Math.floor(Date.now() / 1000));
      await commitLifecycleGeneration(client, config, 1, first);
    });
    await pool.query(
      `INSERT INTO knowledge_compartment_grants (source_id, project_id, subject_type, subject_id, operation, consent_ref, added_by)
       VALUES ($1, $2, 'user', $3, 'read', 'f3-in', 'system'), ($1, $2, 'user', $4, 'read', 'f3-out', 'system')`,
      [source.id, P1, OWNER.principalId, OUTSIDER.principalId]);
    expect((await readLifecycleCompartmentGrants(pool, source.id)).map((r: any) => r.consent_ref).sort()).toEqual(['f3-in', 'f3-out']);
    await withClient(async (client: any) => {
      const prepared = await prepareLifecycleGeneration(client, config, 2, Math.floor(Date.now() / 1000) + 15);
      expect(prepared.payload.projects.find((p: any) => p.id === P1).grants.map((g: any) => g.consent_ref)).toEqual(['f3-in']);
    });
    // The same filter, through the pure payload function, for a Group that is not relevant.
    const rows = {
      source: { id: source.id, slug: 'x', status: 'published', retired_at: null, revision: source.revision, knowledge_query_endpoint: 'https://source.invalid/k',
        knowledge_claims_mode: 'asserted', knowledge_subject_mode: 'direct', knowledge_relevant_groups: [],
        descriptor: { knowledgeSource: { protocol_version: 2, compartment_mode: 'dynamic-opaque', contentKinds: ['docs'], categories: ['drill:note'], compartments: [] } } },
      accounts: [{ id: OWNER.principalId, display_name: 'o', handle: 'o', status: 'active', kind: 'human' }],
      projects: [{ id: P1, name: 'p', status: 'active' }], groups: [],
      compartmentGrants: [{ project_id: P1, subject_type: 'group', subject_id: GROUP, operation: 'read', consent_ref: 'g', approval_id: null }],
    };
    expect(createLifecyclePayload(config, rows, 1, 100).projects[0].grants).toEqual([]);
  });

  it('X4: a decided knowledge change no generation carried within 20 generations is marked export stalled, once', async () => {
    const record = await fileOk(OP_CONN, {
      targetType: 'knowledge.compartment', granteePrincipalId: OWNER.principalId, change: { sourceId: SOURCE.id, operation: 'write', projectIds: [P2] },
    });
    const approved = await decide(ROOT, record.id, 'approve');
    expect([approved.status, approved.json?.code ?? null]).toEqual([200, null]);
    // Nothing carries it: its subject leaves the selection, and its decide is older than 20 generations.
    await pool.query(`UPDATE approvals SET applied_at = NOW() - INTERVAL '10 minutes' WHERE id = $1`, [record.id]);
    const narrow = lifecycleConfig(SOURCE, { accountIds: [OTHER.principalId], projectIds: [P1, P2] });
    try {
      await withClient(async (client: any) => {
        for (const generation of [41, 42]) {
          const prepared = await prepareLifecycleGeneration(client, narrow, generation, Math.floor(Date.now() / 1000) + generation);
          expect(prepared.carriedApprovalIds).not.toContain(record.id);
          await commitLifecycleGeneration(client, narrow, generation, prepared);
        }
      });
    } finally {
      recordLifecycleSelection(MAIN_CONFIG);
    }
    expect((await events(record.id, 'approval.export_stalled')).map((e: any) => parseJson(e.metadata).generation)).toEqual([41]);
    expect(parseJson((await approvalRow(record.id)).applied_effect)).toMatchObject({ export: 'stalled' });
  });
});
