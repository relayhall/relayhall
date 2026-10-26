/**
 * Card 1a38270d: AUTHZ amendment AZ-A13 "Edit in place for authority objects"
 * (RATIFIED 2026-10-11, ruling E95, with the answers E93 and E94), stage 2,
 * over a REAL PostgreSQL and the PRODUCTION router and MCP ingress.
 *
 * A Connector credential, a warrant and a grant are EDITED as the existing
 * object: each keeps its id, a credential keeps its secret, and the object's
 * history gains one entry per edit carrying the value before and after. A
 * narrowing saves; a widening is an Approval of kind authority-edit, applied
 * by ONE executor through four paths: the direct narrowing, the one-act
 * widening with step-up (root, an administrator, or the owning Account within
 * the access it holds itself), the decide of an agent-filed request on
 * /approvals, and the revert of a widening approved "until this task ends".
 * Every number below is measured on the rows the board wrote, and the edited
 * credential is USED with the same token.
 *
 * The groups: (M) migration 148; (C) the credential's owner door; (A) the
 * agent's door; (L) the lifetime (L-1..L-6); (N) the narrow-all act
 * (N-1..N-4); (W) warrants, O-1; (G) grants; (R) the red-proof drills R-1..R-4
 * and drills 1-8, spread over the groups and named in each title.
 *
 * DESTRUCTIVE: writes principals, credentials, services, warrants, grants,
 * groups, approvals, projects, phases, tasks, step-up tokens, triggers and
 * audit rows. It refuses any deployment database and any non-local host, and
 * FAILS - never skips - without a disposable one.
 */

/* eslint-disable @typescript-eslint/no-var-requires */

import http from 'http';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

const TEST_DB_URL = process.env.RELAYHALL_TEST_DB_URL;
if (!TEST_DB_URL) {
  throw new Error('RELAYHALL_TEST_DB_URL is required: the edit-in-place drill measures stored credential, warrant, grant, '
    + 'approval and audit rows, so it never skips. Load database/init.sql into a disposable database, run '
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
  throw new Error('Edit-in-place drill refuses a non-disposable database target');
}

Object.assign(process.env, {
  DB_HOST: parsed.hostname, DB_PORT: parsed.port || '5432', DB_NAME: TEST_DB_NAME,
  DB_USER: decodeURIComponent(parsed.username), DB_PASSWORD: decodeURIComponent(parsed.password),
  NODE_ENV: 'test', RELAYHALL_SESSIONS: 'on', JWT_SECRET: crypto.randomBytes(32).toString('hex'),
});

// Every console line the process writes, so R-4 can prove no secret is in one.
const CONSOLE_LINES: string[] = [];
for (const method of ['log', 'info', 'warn', 'error', 'debug'] as const) {
  const original = console[method].bind(console);
  (console as any)[method] = (...args: unknown[]) => {
    CONSOLE_LINES.push(args.map((arg) => {
      if (typeof arg === 'string') return arg;
      try { return JSON.stringify(arg); } catch { return String(arg); }
    }).join(' '));
    original(...args);
  };
}

const express = require('express');
const { pool } = require('../db/connection');
const { registerProtectedRoutes } = require('../routeRegistry');
const { authMiddleware } = require('../middleware/auth');
const { sharedAuthorizationMiddleware } = require('../middleware/sharedAuthorization');
const { apiErrorHandler } = require('../utils/apiErrors');
const { jsonBodyOptions } = require('../utils/jsonBodyTypes');
const { loginSessionService, SESSION_COOKIE_NAME } = require('../services/LoginSessionService');
const { stepUpService } = require('../services/StepUpService');
// Loaded tolerantly so the suite RUNS where the executor does not exist yet
// (the red proof on the base commit): each test then fails by its own
// assertion instead of the whole file failing to load.
let authorityEditExecutor: any = { sweepReverts: async () => ({ reverted: 0, waiting: 0 }) };
let classifyCredential: any = () => ({ direction: 'absent' });
let classifyGrant: any = () => ({ direction: 'absent' });
try {
  ({ authorityEditExecutor, classifyCredential, classifyGrant } = require('../services/AuthorityEditExecutor'));
} catch (e) {
  if ((e as { code?: string })?.code !== 'MODULE_NOT_FOUND') throw e;
}
const mcpRoutes = require('../mcp/httpRoute').default;
const { MCP_ROUTE_PATH } = require('../mcp/httpRoute');

jest.setTimeout(240_000);

let server: http.Server;
let origin: string;
const SUITE_START = new Date();
/** Every edit response body, so R-4 can scan them. */
const RESPONSES: string[] = [];
/** Every secret this suite saw, so R-4 can look for each one's suffix. */
const SECRETS: string[] = [];

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
interface Bearer extends Caller { credentialId: string; scopes: string[]; secret: string; serviceId?: string }
interface Answer { status: number; json: any; text: string }

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
const key = (label: string): string => `az13-${label}-${crypto.randomUUID()}`;
const parseJson = (value: unknown): any => (typeof value === 'string' ? JSON.parse(value) : value);
const DAY = 24 * 60 * 60 * 1000;
const inDays = (days: number): string => new Date(Date.now() + days * DAY).toISOString();
const REASON = 'AZ-A13 drill: the run must create phases on this project to finish the handover.';
const BASE_SCOPES = ['tasks:read', 'tasks:write', 'projects:read', 'principals:read'];
const KEEP = { choice: 'keep' };
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const sorted = (values: string[]): string[] => [...values].sort();

async function makeAccount(role: string, label = 'acct'): Promise<string> {
  const result = await pool.query(
    `INSERT INTO principals (kind, handle, display_name, status, role)
     VALUES ('human', $1, $1, 'active', $2) RETURNING id`,
    [`az13-${label}-${tag()}`, role],
  );
  return String(result.rows[0].id);
}

async function sessionFor(label: string, principalId: string): Promise<Caller> {
  const minted = await loginSessionService.mint({ principalId });
  return { label, principalId, headers: { Cookie: `${SESSION_COOKIE_NAME}=${minted.token}` } };
}

function bearer(label: string, principalId: string, credentialId: string, scopes: string[], secret: string): Bearer {
  SECRETS.push(secret);
  return { label, principalId, credentialId, scopes, secret, headers: { Authorization: `Bearer ${secret}` } };
}

/** A Connector registered through the owner's wizard path (the registry shape: own() 'parent'). */
async function registerConnector(owner: Caller, scopes: string[] = BASE_SCOPES, transport: 'api' | 'any' | 'mcp' = 'any'): Promise<Bearer> {
  const slug = `az13-connector-${tag()}`;
  const registered = await call(owner, 'POST', '/services', {
    slug, name: slug, description: 'Edit-in-place drill connector.', kind: 'connector',
    issueCredential: { scopes, label: slug, transport },
  });
  expect(registered.status).toBe(201);
  const row = await pool.query('SELECT id, principal_id FROM services WHERE slug = $1', [slug]);
  const made = bearer(slug, String(row.rows[0].principal_id), String(registered.json.onboarding.credential.credentialId),
    scopes, String(registered.json.onboarding.credential.secretOnce));
  made.serviceId = String(row.rows[0].id);
  return made;
}

async function stepUp(who: Caller, action: string, id: string): Promise<string> {
  return (await stepUpService.mint(who.principalId, action, id.toLowerCase(), 'password')).token;
}

const ROUTE: Record<string, string> = { credential: '/credentials', warrant: '/warrants', grant: '/grants' };
async function edit(who: Caller, type: 'credential' | 'warrant' | 'grant', id: string, body: Record<string, unknown>): Promise<Answer> {
  const answered = await call(who, 'PATCH', `${ROUTE[type]}/${id}`, body);
  RESPONSES.push(answered.text);
  return answered;
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
async function approvalRow(id: string): Promise<any> {
  return (await pool.query('SELECT * FROM approvals WHERE id = $1', [id])).rows[0];
}
async function editApprovals(objectId: string): Promise<any[]> {
  return (await pool.query(`SELECT * FROM approvals WHERE kind = 'authority-edit' AND edit_object_id = $1 ORDER BY requested_at`, [objectId])).rows;
}
async function edits(objectId: string, outcome = 'success'): Promise<any[]> {
  return (await pool.query(
    `SELECT * FROM audit_events WHERE resource_id = $1 AND action IN ('credential.edit', 'warrant.edit', 'grant.edit')
        AND outcome = $2 ORDER BY occurred_at, id`, [objectId, outcome])).rows;
}
/** The first successful edit audit row's metadata, asserted present. */
async function firstEdit(objectId: string): Promise<any> {
  const rows = await edits(objectId);
  expect(rows.length).toBeGreaterThan(0);
  return { id: rows[0]?.id, metadata: parseJson(rows[0]?.metadata ?? null) };
}
async function approvalEvents(approvalId: string, action: string): Promise<any[]> {
  return (await pool.query('SELECT * FROM approval_events WHERE approval_id = $1 AND action = $2 ORDER BY occurred_at', [approvalId, action])).rows;
}
async function warrantRow(id: string): Promise<any> {
  return (await pool.query(
    `SELECT ceiling_profile_version_id, ceiling_scopes, max_concurrent, max_total, expires_at, transport_pin, status
       FROM warrants WHERE id = $1`, [id])).rows[0];
}
/** Whether each step-up minted for (who, action, id) was consumed. */
async function stepUpSpent(who: Caller, action: string, id: string): Promise<boolean[]> {
  return (await pool.query(
    'SELECT consumed_at FROM step_up_tokens WHERE principal_id = $1 AND action = $2 AND target_id = $3 ORDER BY created_at',
    [who.principalId, action, id.toLowerCase()])).rows.map((row: any) => row.consumed_at !== null);
}

let ROOT: Caller;           // role admin: derives root
let OPERATOR: Caller;       // an administrator (role operator), not root
let OWNER: Caller;          // a non-administrator owning Account (role editor)
let STRANGER: Caller;       // an unrelated editor Account
let ROOT_PROJECT: string;   // owned by ROOT
let OWNER_PROJECT: string;  // owned by OWNER

async function taskIn(owner: Caller, project: string, title = `AZ-A13 task ${tag()}`): Promise<string> {
  const created = await call(owner, 'POST', '/tasks', { title, description: 'edit-in-place drill', status: 'todo', project });
  expect(created.status).toBe(201);
  return String(created.json?.task?.id);
}

async function phaseVia(who: Bearer, project: string): Promise<Answer> {
  return mcpCall(who, 'relayhall_phase_create', { projectId: project, name: `AZ-A13 phase ${tag()}`, idempotencyKey: key('phase') });
}

async function fileEdit(who: Bearer, body: Record<string, unknown>): Promise<Answer> {
  return call(who, 'POST', '/delegation/access-requests', {
    kind: 'authority-edit', object: { type: 'credential' }, reason: REASON, ...body,
  });
}

async function decide(decider: Caller, approvalId: string, decision: 'approve' | 'deny', body: Record<string, unknown> = {}): Promise<Answer> {
  const token = await stepUp(decider, 'approval.decide', approvalId);
  return call(decider, 'POST', `/approvals/${approvalId}/${decision}`, { stepUpToken: token, ...body });
}

/** A warrant held by `holder`, created by root with step-up, anchored to `task`. */
async function warrantFor(holder: Bearer, task: string, extra: Record<string, unknown> = {}): Promise<string> {
  const created = await call(ROOT, 'POST', '/warrants', {
    name: `AZ-A13 warrant ${tag()}`, holderPrincipalId: holder.principalId,
    anchors: [{ anchorType: 'task', anchorId: task }],
    ceilingRules: [{ resourceType: 'task', selectorForm: 'exact', selectorIds: [task], verbs: ['read', 'write'] }],
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

/** A task riding `warrant` through `connector`'s service (the assignment shape migration 128 admits). */
async function ride(taskId: string, connector: Bearer, warrant: string): Promise<void> {
  await pool.query(
    `UPDATE tasks SET execution_service_id = $2, execution_profile = $3, execution_descriptor_version = 1, execution_warrant_id = $4
      WHERE id = $1`,
    [taskId, connector.serviceId, { serviceId: connector.serviceId, descriptorVersion: 1, options: {} }, warrant]);
}

/** A route refusal names the scope the call lacks. */
function namesScope(answered: Answer, scope: string): boolean {
  return answered.status === 403 && answered.text.includes(scope);
}

beforeAll(async () => {
  await new Promise<void>((resolve) => { server = buildApp().listen(0, '127.0.0.1', resolve); });
  origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  ROOT = await sessionFor('root', await makeAccount('admin', 'root'));
  OPERATOR = await sessionFor('operator', await makeAccount('operator', 'operator'));
  OWNER = await sessionFor('owner', await makeAccount('editor', 'owner'));
  STRANGER = await sessionFor('stranger', await makeAccount('editor', 'stranger'));
  const rootProject = await call(ROOT, 'POST', '/projects', { name: `AZ-A13 root ${tag()}` });
  expect(rootProject.status).toBe(201);
  ROOT_PROJECT = String(rootProject.json.project.id);
  const ownerProject = await call(OWNER, 'POST', '/projects', { name: `AZ-A13 owner ${tag()}` });
  expect(ownerProject.status).toBe(201);
  OWNER_PROJECT = String(ownerProject.json.project.id);
});

afterAll(async () => {
  if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  await pool.end();
});

// ─────────────────────────────── (M) migration 148 ───────────────────────────

describe('(M) migration 148: the authority-edit kind at the database', () => {
  it('M-1: the kind CHECK admits authority-edit, and the shape refuses an edit row with both bindings, with neither, or with a requested expiry', async () => {
    const requester = OWNER.principalId;
    const objectId = crypto.randomUUID();
    const insert = (extra: string) => pool.query(
      `INSERT INTO approvals (kind, status, requester_principal_id, requested_scopes, pending_expires_at,
         edit_object_type, edit_object_id, edit_before, edit_requested, reason ${extra.split('|')[0]})
       VALUES ('authority-edit', 'pending', $1, '[]'::jsonb, NOW() + INTERVAL '1 day',
         'credential', $2, '{}'::jsonb, '{}'::jsonb, $3 ${extra.split('|')[1]})`,
      [requester, objectId, REASON]);
    // both bindings
    const credential = { id: (await registerConnector(ROOT, BASE_SCOPES, 'any')).credentialId };
    await expect(pool.query(
      `INSERT INTO approvals (kind, status, requester_principal_id, requesting_credential_id, session_evidence, requested_scopes,
         pending_expires_at, edit_object_type, edit_object_id, edit_before, edit_requested, reason)
       VALUES ('authority-edit', 'pending', $1, $2, '{}'::jsonb, '[]'::jsonb, NOW() + INTERVAL '1 day', 'credential', $3,
         '{}'::jsonb, '{}'::jsonb, $4)`, [requester, credential.id, objectId, REASON])).rejects.toMatchObject({ code: '23514' });
    // neither binding (approvals_binding_present)
    await expect(insert('|')).rejects.toMatchObject({ code: '23514' });
    // a requested expiry on an edit row
    await expect(pool.query(
      `INSERT INTO approvals (kind, status, requester_principal_id, session_evidence, requested_scopes, pending_expires_at,
         requested_expires_at, edit_object_type, edit_object_id, edit_before, edit_requested, reason)
       VALUES ('authority-edit', 'pending', $1, '{}'::jsonb, '[]'::jsonb, NOW() + INTERVAL '1 day', NOW() + INTERVAL '2 days',
         'credential', $2, '{}'::jsonb, '{}'::jsonb, $3)`, [requester, objectId, REASON])).rejects.toMatchObject({ code: '23514' });
    // an unknown object type
    await expect(pool.query(
      `INSERT INTO approvals (kind, status, requester_principal_id, session_evidence, requested_scopes, pending_expires_at,
         edit_object_type, edit_object_id, edit_before, edit_requested, reason)
       VALUES ('authority-edit', 'pending', $1, '{}'::jsonb, '[]'::jsonb, NOW() + INTERVAL '1 day',
         'profile', $2, '{}'::jsonb, '{}'::jsonb, $3)`, [requester, objectId, REASON])).rejects.toMatchObject({ code: '23514' });
    // the well-formed row is admitted, and the agent-mint and grant kinds still refuse the edit columns
    const ok = await pool.query(
      `INSERT INTO approvals (kind, status, requester_principal_id, session_evidence, requested_scopes, pending_expires_at,
         edit_object_type, edit_object_id, edit_before, edit_requested, reason)
       VALUES ('authority-edit', 'pending', $1, '{}'::jsonb, '[]'::jsonb, NOW() + INTERVAL '1 day',
         'credential', $2, '{}'::jsonb, '{}'::jsonb, $3) RETURNING id`, [requester, objectId, REASON]);
    expect(ok.rows.length).toBe(1);
    await pool.query(`UPDATE approvals SET status = 'lapsed', lapse_reason = 'DRILL' WHERE id = $1`, [ok.rows[0].id]);
  });

  it('M-2: the grant and credential conjuncts of approvals_kind_shape are 145\'s, by deparse (clause 7 P-1)', async () => {
    const file = fs.readFileSync(path.join(__dirname, '..', 'migrations', '145_access_requests_credential_kind.sql'), 'utf8');
    const start = file.indexOf('ALTER TABLE approvals ADD CONSTRAINT approvals_kind_shape CHECK (');
    const end = file.indexOf(');', start);
    const body = file.slice(start + 'ALTER TABLE approvals ADD CONSTRAINT approvals_kind_shape CHECK ('.length, end).trim();
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('CREATE TEMP TABLE az13_shape_probe (LIKE approvals INCLUDING DEFAULTS) ON COMMIT DROP');
      await client.query(`ALTER TABLE az13_shape_probe ADD CONSTRAINT probe_shape CHECK (${body})`);
      const probe = (await client.query(
        `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conname = 'probe_shape'`)).rows[0].def as string;
      const live = (await client.query(
        `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conname = 'approvals_kind_shape' AND conrelid = 'approvals'::regclass`)).rows[0].def as string;
      await client.query('ROLLBACK');
      // Each kind conjunct, as PostgreSQL deparses it, extracted by paren matching.
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
      for (const kind of ['grant', 'credential']) {
        expect(conjunct(live, kind)).toBe(conjunct(probe, kind));
      }
      expect(live).toContain("WHEN 'authority-edit'::text THEN");
    } finally {
      client.release();
    }
  });

  it('M-3: an approved edit is terminal; only its revert stamp is written, once; the request never changes', async () => {
    const objectId = crypto.randomUUID();
    const row = (await pool.query(
      `INSERT INTO approvals (kind, status, requester_principal_id, session_evidence, requested_scopes, pending_expires_at,
         decided_by_principal_id, decided_at, edit_object_type, edit_object_id, edit_before, edit_requested, edit_approved,
         edit_lifetime, edit_revert_at)
       VALUES ('authority-edit', 'approved', $1, '{}'::jsonb, '[]'::jsonb, NOW(), $1, NOW(), 'credential', $2,
         '{"scopes":[]}'::jsonb, '{"scopes":["tasks:read"]}'::jsonb, '{"scopes":["tasks:read"]}'::jsonb,
         'until-task', NOW() + INTERVAL '1 day') RETURNING id`, [ROOT.principalId, objectId])).rows[0];
    await expect(pool.query(`UPDATE approvals SET status = 'lapsed', lapse_reason = 'X' WHERE id = $1`, [row.id]))
      .rejects.toMatchObject({ code: '23514' });
    await expect(pool.query(`UPDATE approvals SET edit_approved = '{"scopes":[]}'::jsonb WHERE id = $1`, [row.id]))
      .rejects.toMatchObject({ code: '23514' });
    await expect(pool.query(`UPDATE approvals SET edit_before = '{"scopes":["x"]}'::jsonb WHERE id = $1`, [row.id]))
      .rejects.toMatchObject({ code: '23514' });
    await pool.query(`UPDATE approvals SET edit_reverted_at = NOW() WHERE id = $1`, [row.id]);
    await expect(pool.query(`UPDATE approvals SET edit_reverted_at = NOW() + INTERVAL '1 second' WHERE id = $1`, [row.id]))
      .rejects.toMatchObject({ code: '23514' });
  });

  it('M-4: until-task needs a task or a date at the approve transition, and the related task can still be deleted', async () => {
    const objectId = crypto.randomUUID();
    await expect(pool.query(
      `INSERT INTO approvals (kind, status, requester_principal_id, session_evidence, requested_scopes, pending_expires_at,
         decided_by_principal_id, decided_at, edit_object_type, edit_object_id, edit_before, edit_requested, edit_approved, edit_lifetime)
       VALUES ('authority-edit', 'approved', $1, '{}'::jsonb, '[]'::jsonb, NOW(), $1, NOW(), 'credential', $2,
         '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, 'until-task')`, [ROOT.principalId, objectId])).rejects.toMatchObject({ code: '23514' });
    const task = await taskIn(ROOT, ROOT_PROJECT);
    const row = (await pool.query(
      `INSERT INTO approvals (kind, status, requester_principal_id, session_evidence, requested_scopes, pending_expires_at,
         decided_by_principal_id, decided_at, edit_object_type, edit_object_id, edit_before, edit_requested, edit_approved,
         edit_lifetime, related_task_id, edit_reverted_at)
       VALUES ('authority-edit', 'approved', $1, '{}'::jsonb, '[]'::jsonb, NOW(), $1, NOW(), 'credential', $2,
         '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, 'until-task', $3, NOW()) RETURNING id`, [ROOT.principalId, objectId, task])).rows[0];
    expect((await call(ROOT, 'DELETE', `/tasks/${task}`)).status).toBeLessThan(300);
    expect((await approvalRow(row.id)).related_task_id).toBeNull();
  });

  it('M-5: one pending edit per object, and warrant_events admits warrant.amended, and the two route families are on their surfaces', async () => {
    const objectId = crypto.randomUUID();
    const pending = () => pool.query(
      `INSERT INTO approvals (kind, status, requester_principal_id, session_evidence, requested_scopes, pending_expires_at,
         edit_object_type, edit_object_id, edit_before, edit_requested, reason)
       VALUES ('authority-edit', 'pending', $1, '{}'::jsonb, '[]'::jsonb, NOW() + INTERVAL '1 day',
         'warrant', $2, '{}'::jsonb, '{}'::jsonb, $3) RETURNING id`, [OWNER.principalId, objectId, REASON]);
    const first = (await pending()).rows[0];
    await expect(pending()).rejects.toMatchObject({ code: '23505' });
    await pool.query(`UPDATE approvals SET status = 'lapsed', lapse_reason = 'DRILL' WHERE id = $1`, [first.id]);
    const event = await pool.query(
      `INSERT INTO warrant_events (warrant_id, action, actor_handle) VALUES ($1, 'warrant.amended', 'drill') RETURNING id`, [objectId]);
    expect(event.rows.length).toBe(1);
    const surfaces = await pool.query(
      `SELECT key, write_families FROM access_surfaces WHERE key IN ('settings.access-manager', 'settings.access-grants') ORDER BY key`);
    const families = Object.fromEntries(surfaces.rows.map((row: any) => [row.key, row.write_families]));
    expect(families['settings.access-manager']).toContain('PATCH /credentials/:id');
    expect(families['settings.access-grants']).toContain('PATCH /grants/:id');
  });
});

// ─────────────────────────── (C) a credential, the owner's door ───────────────

describe('(C) a Connector credential edited in place by its owner, an administrator or root', () => {
  it('drill 1 / E95 acceptance: root adds phases:read and phases:write in place with step-up; the SAME token then creates a phase through MCP; the id, key_id, secret and Main appointment are unchanged', async () => {
    const connector = await registerConnector(ROOT, BASE_SCOPES, 'mcp');
    const appoint = await call(ROOT, 'POST', `/principals/${connector.principalId}/owner-control`, { enabled: true, reason: 'AZ-A13 drill Main' });
    expect(appoint.status).toBe(200);
    const before = await credentialRow(connector.credentialId);
    const main = (await pool.query('SELECT owner_control_account_id FROM principals WHERE id = $1', [connector.principalId])).rows[0];
    expect(mcpFailed(await mcpCall(connector, 'relayhall_brief_compile', { session: true }))).toBe(false);
    const refused = await phaseVia(connector, ROOT_PROJECT);
    expect(mcpFailed(refused)).toBe(true);
    expect(mcpText(refused)).toContain('phases:write');

    const widened = await widen(ROOT, 'credential', connector.credentialId,
      { scopes: [...BASE_SCOPES, 'phases:read', 'phases:write'] });
    expect([widened.status, widened.json?.edit?.direction, widened.json?.edit?.changed]).toEqual([200, 'widening', ['scopes']]);

    const created = await phaseVia(connector, ROOT_PROJECT);
    expect(mcpFailed(created)).toBe(false);
    expect(mcpText(created)).toMatch(/phase/i);
    const after = await credentialRow(connector.credentialId);
    expect({
      id: after.id, keyId: after.key_id, hash: after.secret_hash, cipher: Buffer.from(after.secret_ciphertext ?? '').toString('hex'),
      encKey: after.encryption_key_id, revealCount: after.reveal_count, rotatedFrom: after.rotated_from_id, label: after.label,
      expires: after.expires_at, transport: after.transport,
    }).toEqual({
      id: before.id, keyId: before.key_id, hash: before.secret_hash, cipher: Buffer.from(before.secret_ciphertext ?? '').toString('hex'),
      encKey: before.encryption_key_id, revealCount: before.reveal_count, rotatedFrom: before.rotated_from_id, label: before.label,
      expires: before.expires_at, transport: 'mcp',
    });
    expect(sorted(parseJson(after.scopes))).toEqual(sorted([...BASE_SCOPES, 'phases:read', 'phases:write']));
    const mainAfter = (await pool.query('SELECT owner_control_account_id FROM principals WHERE id = $1', [connector.principalId])).rows[0];
    expect(mainAfter.owner_control_account_id).toBe(main.owner_control_account_id);
    expect(main.owner_control_account_id).toBe(ROOT.principalId);
    expect((await pool.query('SELECT COUNT(*)::int AS n FROM principal_credentials WHERE principal_id = $1', [connector.principalId])).rows[0].n).toBe(1);
  });

  it('R-2 (credential): a narrowing by the owning Account saves at once with ONE audit row carrying before, after and the chain, and the next call with the same token is refused the removed scope', async () => {
    const connector = await registerConnector(OWNER, [...BASE_SCOPES, 'phases:read'], 'any');
    expect((await call(connector, 'GET', `/phases?projectId=${OWNER_PROJECT}`)).status).toBe(200);
    const narrowed = await edit(OWNER, 'credential', connector.credentialId, { scopes: BASE_SCOPES });
    expect([narrowed.status, narrowed.json?.edit?.direction, narrowed.json?.edit?.approvalId]).toEqual([200, 'narrowing', null]);
    expect(sorted(await scopesOf(connector.credentialId))).toEqual(sorted(BASE_SCOPES));
    const rows = await edits(connector.credentialId);
    expect(rows.length).toBe(1);
    const metadata = parseJson(rows[0].metadata);
    expect(metadata).toMatchObject({
      clause: 'AZ-A13', direction: 'narrowing', path: 'direct', approvalId: null, entryPoint: 'session',
      changed: ['scopes'], deciderStanding: 'owning-account', stepUp: null, lifetime: null, follows: null,
    });
    expect(sorted(metadata.before.scopes)).toEqual(sorted([...BASE_SCOPES, 'phases:read']));
    expect(sorted(metadata.after.scopes)).toEqual(sorted(BASE_SCOPES));
    expect(metadata.before.keyId).toBe((await credentialRow(connector.credentialId)).key_id);
    expect(metadata.chain.map((link: any) => link.principalId)).toEqual([connector.principalId, OWNER.principalId]);
    expect(namesScope(await call(connector, 'GET', `/phases?projectId=${OWNER_PROJECT}`), 'phases:read')).toBe(true);
    expect((await editApprovals(connector.credentialId)).length).toBe(0);
  });

  it('clause 9f: a narrowing revokes the graced predecessor in the same transaction; a widening leaves it alone', async () => {
    const connector = await registerConnector(OWNER, [...BASE_SCOPES, 'phases:read'], 'any');
    const rotated = await call(ROOT, 'POST', `/credentials/${connector.credentialId}/rotate`, {});
    expect(rotated.status).toBe(201);
    SECRETS.push(String(rotated.json.secretOnce));
    const successor = String(rotated.json.id);
    expect((await credentialRow(connector.credentialId)).grace_until).not.toBeNull();
    const widened = await widen(ROOT, 'credential', successor, { scopes: [...BASE_SCOPES, 'phases:read', 'reports:read'] });
    expect(widened.status).toBe(200);
    expect((await credentialRow(connector.credentialId)).revoked_at).toBeNull();
    const narrowed = await edit(OWNER, 'credential', successor, { scopes: BASE_SCOPES });
    expect([narrowed.status, narrowed.json?.edit?.revokedPredecessorIds]).toEqual([200, [connector.credentialId]]);
    const predecessor = await credentialRow(connector.credentialId);
    expect(predecessor.revoked_at).not.toBeNull();
    expect(parseJson(predecessor.metadata).revoke_reason).toBe('superseded by an AZ-A13 narrowing');
  });

  it('R-1 (a): a root widening with no step-up, or one bound to another act or object, is STEP_UP_REQUIRED; the row is unchanged and no Approval exists', async () => {
    const connector = await registerConnector(ROOT, BASE_SCOPES, 'any');
    const other = await registerConnector(ROOT, BASE_SCOPES, 'any');
    const body = { scopes: [...BASE_SCOPES, 'phases:read'], lifetime: KEEP };
    const none = await edit(ROOT, 'credential', connector.credentialId, body);
    const wrongAct = await edit(ROOT, 'credential', connector.credentialId,
      { ...body, stepUpToken: await stepUp(ROOT, 'approval.decide', connector.credentialId) });
    const wrongObject = await edit(ROOT, 'credential', connector.credentialId,
      { ...body, stepUpToken: await stepUp(ROOT, 'credential.edit', other.credentialId) });
    for (const answered of [none, wrongAct, wrongObject]) {
      expect([answered.status, answered.json?.code, answered.json?.clause]).toEqual([403, 'STEP_UP_REQUIRED', 'AZ-A13 clause 4b']);
    }
    expect(sorted(await scopesOf(connector.credentialId))).toEqual(sorted(BASE_SCOPES));
    expect((await editApprovals(connector.credentialId)).length).toBe(0);
    expect((await edits(connector.credentialId, 'denied')).map((row) => parseJson(row.metadata).refusal))
      .toEqual(['STEP_UP_REQUIRED', 'STEP_UP_REQUIRED', 'STEP_UP_REQUIRED']);
  });

  it('R-1 (b), E94: the owning editor Account widens WITHIN its own access with step-up: applied at once, deciderStanding owning-account, an approved authority-edit, no pending item', async () => {
    const connector = await registerConnector(OWNER, BASE_SCOPES, 'any');
    const widened = await widen(OWNER, 'credential', connector.credentialId, { scopes: [...BASE_SCOPES, 'phases:read'] });
    expect([widened.status, widened.json?.edit?.direction]).toEqual([200, 'widening']);
    expect(sorted(await scopesOf(connector.credentialId))).toEqual(sorted([...BASE_SCOPES, 'phases:read']));
    const approvals = await editApprovals(connector.credentialId);
    expect(approvals.map((row) => [row.status, row.edit_lifetime, row.requesting_credential_id, String(row.decided_by_principal_id)]))
      .toEqual([['approved', 'keep', null, OWNER.principalId]]);
    expect(parseJson(approvals[0].session_evidence)).toMatchObject({ door: 'one-act', standing: 'owning-account', act: 'credential.edit' });
    expect((await firstEdit(connector.credentialId)).metadata).toMatchObject({
      path: 'approval-atomic', deciderStanding: 'owning-account', approvalId: approvals[0].id, lifetime: { choice: 'keep' },
    });
    expect((await approvalEvents(approvals[0].id, 'approval.requested')).length).toBe(1);
    expect((await approvalEvents(approvals[0].id, 'approval.approved')).length).toBe(1);
  });

  it('R-1 (b), E94: beyond its own access the owning Account is refused EXCEEDS_ACCOUNT_AUTHORITY: the row unchanged, no Approval filed, and without a step-up STEP_UP_REQUIRED', async () => {
    const connector = await registerConnector(OWNER, BASE_SCOPES, 'any');
    const beyond = await widen(OWNER, 'credential', connector.credentialId, { scopes: [...BASE_SCOPES, 'services:admin'] });
    expect([beyond.status, beyond.json?.code, beyond.json?.subject, beyond.json?.exceeding])
      .toEqual([403, 'EXCEEDS_ACCOUNT_AUTHORITY', 'editor', ['services:admin']]);
    const noStepUp = await edit(OWNER, 'credential', connector.credentialId, { scopes: [...BASE_SCOPES, 'phases:read'], lifetime: KEEP });
    expect([noStepUp.status, noStepUp.json?.code]).toEqual([403, 'STEP_UP_REQUIRED']);
    expect(sorted(await scopesOf(connector.credentialId))).toEqual(sorted(BASE_SCOPES));
    expect((await editApprovals(connector.credentialId)).length).toBe(0);
  });

  it('drill 2: transport - root loosens mcp to any with step-up and REST works; the owner tightens any to mcp and REST is TRANSPORT_MISMATCH; the owner loosening is AUTHORITY_EDIT_REQUIRES_ADMINISTRATOR; mcp to api is a widening', async () => {
    const pinned = await registerConnector(ROOT, BASE_SCOPES, 'mcp');
    expect((await call(pinned, 'GET', '/tasks')).json?.code).toBe('TRANSPORT_MISMATCH');
    const loosened = await widen(ROOT, 'credential', pinned.credentialId, { transport: 'any' });
    expect([loosened.status, loosened.json?.edit?.direction, loosened.json?.edit?.changed]).toEqual([200, 'widening', ['transport']]);
    expect((await call(pinned, 'GET', '/tasks')).status).toBe(200);

    const owned = await registerConnector(OWNER, BASE_SCOPES, 'any');
    const tightened = await edit(OWNER, 'credential', owned.credentialId, { transport: 'mcp' });
    expect([tightened.status, tightened.json?.edit?.direction]).toEqual([200, 'narrowing']);
    expect((await call(owned, 'GET', '/tasks')).json?.code).toBe('TRANSPORT_MISMATCH');
    const loosen = await widen(OWNER, 'credential', owned.credentialId, { transport: 'any' });
    expect([loosen.status, loosen.json?.code, loosen.json?.clause]).toEqual([403, 'AUTHORITY_EDIT_REQUIRES_ADMINISTRATOR', 'AZ-A13 clause 9d']);
    expect((await credentialRow(owned.credentialId)).transport).toBe('mcp');
    expect((await editApprovals(owned.credentialId)).length).toBe(0);
    expect(classifyCredential({ scopes: ['tasks:read'], transport: 'mcp' }, { scopes: ['tasks:read'], transport: 'api' }).direction).toBe('widening');
    expect(classifyCredential({ scopes: ['tasks:read'], transport: 'any' }, { scopes: ['tasks:read'], transport: 'api' }).direction).toBe('narrowing');
  });

  it('drill 3a: the Account cap and the root sentinel - *:admin under an editor Account is EXCEEDS_ACCOUNT_AUTHORITY, while a widening under an admin Account passes the Account cap', async () => {
    const owned = await registerConnector(OWNER, BASE_SCOPES, 'any');
    const adminScope = await widen(ROOT, 'credential', owned.credentialId, { scopes: [...BASE_SCOPES, 'services:admin'] });
    expect([adminScope.status, adminScope.json?.code, adminScope.json?.subject, adminScope.json?.exceeding])
      .toEqual([403, 'EXCEEDS_ACCOUNT_AUTHORITY', 'target', ['services:admin']]);
    expect(sorted(await scopesOf(owned.credentialId))).toEqual(sorted(BASE_SCOPES));
    const rootOwned = await registerConnector(ROOT, BASE_SCOPES, 'any');
    const sentinel = await widen(ROOT, 'credential', rootOwned.credentialId, { scopes: [...BASE_SCOPES, 'services:admin'] });
    expect([sentinel.status, sentinel.json?.edit?.direction]).toEqual([200, 'widening']);
  });

  it('drill 3b: EXCEEDS_CONNECTOR_OWN when the Connector own() is a list, and ROOT_NOT_MINTABLE from the one credential policy', async () => {
    const owned = await registerConnector(OWNER, BASE_SCOPES, 'any');
    const rootScope = await widen(ROOT, 'credential', owned.credentialId, { scopes: [...BASE_SCOPES, 'root'] });
    expect([rootScope.status, rootScope.json?.code]).toEqual([422, 'ROOT_NOT_MINTABLE']);
    const rootOwned = await registerConnector(ROOT, [...BASE_SCOPES, 'services:admin'], 'any');
    await pool.query(`UPDATE principals SET own_expression = '{"scopes":["tasks:read","tasks:write","projects:read","principals:read"],"objects":"parent"}'::jsonb WHERE id = $1`,
      [rootOwned.principalId]);
    const own = await widen(ROOT, 'credential', rootOwned.credentialId, { scopes: [...BASE_SCOPES, 'services:admin', 'reports:read'] });
    expect([own.status, own.json?.code, own.json?.exceeding]).toEqual([403, 'EXCEEDS_CONNECTOR_OWN', ['reports:read']]);
    expect(sorted(await scopesOf(owned.credentialId))).toEqual(sorted(BASE_SCOPES));
  });

  it('clause 9e: an Agent, an OAuth, a legacy and a revoked credential are refused by name, and EDIT_FIELD_NOT_EDITABLE and EDIT_NO_CHANGE', async () => {
    const connector = await registerConnector(ROOT, [...BASE_SCOPES, 'phases:read'], 'any');
    const task = await taskIn(ROOT, ROOT_PROJECT);
    const warrant = await warrantFor(connector, task, { ceilingScopes: ['tasks:read', 'phases:read'] });
    const agent = await mintAgent(connector, warrant, task, ['tasks:read']);
    expect((await edit(ROOT, 'credential', agent.credentialId, { scopes: ['tasks:read', 'phases:read'] })).json?.code)
      .toBe('AGENT_CREDENTIAL_NOT_EDITABLE');
    const oauth = await registerConnector(ROOT, BASE_SCOPES, 'any');
    await pool.query(`UPDATE principal_credentials SET metadata = metadata || '{"issued_by":"oauth"}'::jsonb WHERE id = $1`, [oauth.credentialId]);
    expect((await edit(ROOT, 'credential', oauth.credentialId, { scopes: ['tasks:read'] })).json?.code).toBe('OAUTH_CREDENTIAL_RECONSENT');
    const legacy = await registerConnector(ROOT, BASE_SCOPES, 'any');
    await pool.query(`UPDATE principals SET legacy_identity = TRUE WHERE id = $1`, [legacy.principalId]);
    expect((await edit(ROOT, 'credential', legacy.credentialId, { scopes: ['tasks:read'] })).json?.code).toBe('LEGACY_FROZEN');
    await pool.query(`UPDATE principals SET legacy_identity = FALSE WHERE id = $1`, [legacy.principalId]);
    const revoked = await registerConnector(ROOT, BASE_SCOPES, 'any');
    await call(ROOT, 'POST', `/credentials/${revoked.credentialId}/revoke`, { reason: 'drill' });
    expect((await edit(ROOT, 'credential', revoked.credentialId, { scopes: ['tasks:read'] })).json?.code).toBe('CREDENTIAL_NOT_LIVE');
    const label = await edit(ROOT, 'credential', connector.credentialId, { label: 'renamed', expiresAt: inDays(3) });
    expect([label.status, label.json?.code, label.json?.fields]).toEqual([422, 'EDIT_FIELD_NOT_EDITABLE', ['expiresAt', 'label']]);
    const same = await edit(ROOT, 'credential', connector.credentialId, { scopes: [...BASE_SCOPES, 'phases:read'] });
    expect([same.status, same.json?.code]).toEqual([422, 'EDIT_NO_CHANGE']);
  });

  it('drill 7, D-10/D-10a: an operator narrows and widens a FOREIGN Connector (a credential.edit token serves, an approval.decide token does not); an editor session on a foreign Connector is refused', async () => {
    const foreign = await registerConnector(OWNER, [...BASE_SCOPES, 'phases:read'], 'any');
    const narrowed = await edit(OPERATOR, 'credential', foreign.credentialId, { scopes: BASE_SCOPES });
    expect([narrowed.status, narrowed.json?.edit?.direction]).toEqual([200, 'narrowing']);
    expect((await firstEdit(foreign.credentialId)).metadata.deciderStanding).toBe('administrator');
    const wrongToken = await edit(OPERATOR, 'credential', foreign.credentialId,
      { scopes: [...BASE_SCOPES, 'phases:read'], lifetime: KEEP, stepUpToken: await stepUp(OPERATOR, 'approval.decide', foreign.credentialId) });
    expect([wrongToken.status, wrongToken.json?.code]).toEqual([403, 'STEP_UP_REQUIRED']);
    const widened = await widen(OPERATOR, 'credential', foreign.credentialId, { scopes: [...BASE_SCOPES, 'phases:read'] });
    expect([widened.status, widened.json?.edit?.direction]).toEqual([200, 'widening']);
    const strangerNarrow = await edit(STRANGER, 'credential', foreign.credentialId, { scopes: BASE_SCOPES });
    const strangerWiden = await widen(STRANGER, 'credential', foreign.credentialId, { scopes: [...BASE_SCOPES, 'phases:read', 'reports:read'] });
    for (const answered of [strangerNarrow, strangerWiden]) {
      expect([answered.status, answered.json?.code]).toEqual([403, 'AUTHORITY_EDIT_REQUIRES_ADMINISTRATOR']);
    }
    expect(sorted(await scopesOf(foreign.credentialId))).toEqual(sorted([...BASE_SCOPES, 'phases:read']));
  });

  it('R-3: a Connector calling for itself gets 403 SESSION_ONLY on PATCH /credentials, /warrants and /approvals/approve, and the /grants ceiling; rows unchanged; a durable denied audit each', async () => {
    const connector = await registerConnector(ROOT, [...BASE_SCOPES, 'phases:read'], 'any');
    const task = await taskIn(ROOT, ROOT_PROJECT);
    const warrant = await warrantFor(connector, task, { maxTotal: 5 });
    const grant = await call(ROOT, 'POST', '/grants', { granteeId: STRANGER.principalId, resourceType: 'task', resourceId: task, verb: 'read' });
    expect(grant.status).toBe(201);
    const filed = await fileEdit(connector, { addScopes: ['reports:read'] });
    expect(filed.status).toBe(202);
    const credential = await edit(connector, 'credential', connector.credentialId, { scopes: [...BASE_SCOPES, 'phases:read', 'reports:read'] });
    const warrantEdit = await edit(connector, 'warrant', warrant, { maxTotal: 50 });
    const grantEdit = await edit(connector, 'grant', grant.json.grant.id, { verb: 'write' });
    const approve = await call(connector, 'POST', `/approvals/${filed.json.approval.id}/approve`, { lifetime: KEEP });
    expect([credential.status, credential.json?.code]).toEqual([403, 'SESSION_ONLY']);
    expect([warrantEdit.status, warrantEdit.json?.code]).toEqual([403, 'SESSION_ONLY']);
    expect(grantEdit.status).toBe(403);
    expect([approve.status, approve.json?.code]).toEqual([403, 'SESSION_ONLY']);
    expect(sorted(await scopesOf(connector.credentialId))).toEqual(sorted([...BASE_SCOPES, 'phases:read']));
    expect((await pool.query('SELECT max_total FROM warrants WHERE id = $1', [warrant])).rows[0].max_total).toBe(5);
    expect((await pool.query('SELECT verb FROM grants WHERE id = $1', [grant.json.grant.id])).rows[0].verb).toBe('read');
    expect((await approvalRow(filed.json.approval.id)).status).toBe('pending');
    const denied = await pool.query(
      `SELECT action, metadata->>'refusal' AS refusal FROM audit_events
        WHERE actor_principal_id = $1 AND outcome = 'denied' AND occurred_at >= $2 ORDER BY occurred_at`,
      [connector.principalId, SUITE_START]);
    expect(denied.rows.filter((row: any) => row.refusal === 'SESSION_ONLY').map((row: any) => row.action).sort())
      .toEqual(['approval.refused', 'credential.edit', 'warrant.refused']);
  });
});

// ─────────────────────────── (A) the agent's door ──────────────────────────

describe('(A) the agent files an edit of its own credential; a person decides on /approvals', () => {
  it('R-1 (c): an agent files addScopes: pending, the row unchanged, and its next MCP call is still refused naming the scope', async () => {
    const connector = await registerConnector(OWNER, BASE_SCOPES, 'any');
    const filed = await fileEdit(connector, { addScopes: ['phases:read', 'phases:write'] });
    expect([filed.status, filed.json?.approval?.status, filed.json?.approval?.kind]).toEqual([202, 'pending', 'authority-edit']);
    const row = await approvalRow(filed.json.approval.id);
    expect({
      kind: row.kind, objectType: row.edit_object_type, objectId: String(row.edit_object_id),
      credential: String(row.requesting_credential_id), session: row.session_evidence, scopes: parseJson(row.requested_scopes),
      expires: row.requested_expires_at, grantee: String(row.grantee_principal_id),
    }).toEqual({
      kind: 'authority-edit', objectType: 'credential', objectId: connector.credentialId,
      credential: connector.credentialId, session: null, scopes: [], expires: null, grantee: OWNER.principalId,
    });
    expect(sorted(parseJson(row.edit_requested).scopes)).toEqual(sorted([...BASE_SCOPES, 'phases:read', 'phases:write']));
    expect(sorted(await scopesOf(connector.credentialId))).toEqual(sorted(BASE_SCOPES));
    expect(mcpFailed(await mcpCall(connector, 'relayhall_brief_compile', { session: true }))).toBe(false);
    const next = await phaseVia(connector, OWNER_PROJECT);
    expect(mcpFailed(next)).toBe(true);
    expect(mcpText(next)).toContain('phases:write');
  });

  it('clause 6c: the filing refusals by name - an Agent, a warrant or grant object, another credential, a transport, root, *:admin, ALREADY_HELD, EDIT_PENDING', async () => {
    const connector = await registerConnector(ROOT, [...BASE_SCOPES, 'phases:read'], 'any');
    const other = await registerConnector(ROOT, BASE_SCOPES, 'any');
    const task = await taskIn(ROOT, ROOT_PROJECT);
    const warrant = await warrantFor(connector, task, { ceilingScopes: ['tasks:read'] });
    const agent = await mintAgent(connector, warrant, task, ['tasks:read']);
    const cases: Array<[Bearer, Record<string, unknown>, string]> = [
      [agent, { addScopes: ['phases:read'] }, 'AGENT_CREDENTIAL_NOT_EDITABLE'],
      [connector, { object: { type: 'warrant' }, addScopes: ['phases:write'] }, 'EDIT_OBJECT_NOT_FILABLE'],
      [connector, { object: { type: 'grant' }, addScopes: ['phases:write'] }, 'EDIT_OBJECT_NOT_FILABLE'],
      [connector, { object: { type: 'credential', id: other.credentialId }, addScopes: ['phases:write'] }, 'EDIT_TARGET_NOT_OWN'],
      [connector, { addScopes: ['phases:write'], requestedTransport: 'any' }, 'TRANSPORT_NOT_REQUESTABLE'],
      [connector, { addScopes: ['root'] }, 'ROOT_NOT_MINTABLE'],
      [connector, { addScopes: ['services:admin'] }, 'ADMIN_SCOPE_NOT_ADMISSIBLE'],
      [connector, { addScopes: ['phases:read'] }, 'ALREADY_HELD'],
      [connector, { addScopes: ['phases:write'], requestedScopes: ['phases:write'] }, 'EDIT_FIELD_NOT_EDITABLE'],
    ];
    for (const [who, body, code] of cases) {
      const answered = await fileEdit(who, body);
      expect([answered.json?.code, answered.status >= 400]).toEqual([code, true]);
    }
    const first = await fileEdit(connector, { addScopes: ['phases:write'] });
    expect(first.status).toBe(202);
    const second = await fileEdit(connector, { addScopes: ['reports:read'] });
    expect([second.status, second.json?.code, second.json?.pendingApprovalId]).toEqual([409, 'EDIT_PENDING', first.json.approval.id]);
    expect((await editApprovals(connector.credentialId)).length).toBe(1);
  });

  it('R-1 (d): a non-administrator owner deciding is APPROVAL_DECIDE_REQUIRES_ADMINISTRATOR without spending its step-up', async () => {
    const connector = await registerConnector(OWNER, BASE_SCOPES, 'any');
    const filed = await fileEdit(connector, { addScopes: ['phases:read'] });
    const token = await stepUp(OWNER, 'approval.decide', filed.json.approval.id);
    const refused = await call(OWNER, 'POST', `/approvals/${filed.json.approval.id}/approve`, { stepUpToken: token, lifetime: KEEP });
    expect([refused.status, refused.json?.code]).toEqual([403, 'APPROVAL_DECIDE_REQUIRES_ADMINISTRATOR']);
    const spent = (await pool.query('SELECT consumed_at FROM step_up_tokens WHERE principal_id = $1 ORDER BY created_at DESC LIMIT 1', [OWNER.principalId])).rows[0];
    expect(spent.consumed_at).toBeNull();
    expect((await approvalRow(filed.json.approval.id)).status).toBe('pending');
  });

  it('drill 1 (agent door): the owner approves by deep link with step-up and keep; the same Connector\'s next call creates a phase; one approved row, edit_approved recorded', async () => {
    const connector = await registerConnector(ROOT, BASE_SCOPES, 'any');
    const filed = await fileEdit(connector, { addScopes: ['phases:read', 'phases:write'] });
    const approved = await decide(ROOT, filed.json.approval.id, 'approve', { lifetime: KEEP });
    expect([approved.status, approved.json?.approval?.status]).toEqual([200, 'approved']);
    expect(sorted(await scopesOf(connector.credentialId))).toEqual(sorted([...BASE_SCOPES, 'phases:read', 'phases:write']));
    expect((await call(connector, 'POST', '/phases', { projectId: ROOT_PROJECT, name: `AZ-A13 ${tag()}` }, { 'Idempotency-Key': key('p') })).status)
      .toBe(201);
    const row = await approvalRow(filed.json.approval.id);
    expect([row.status, row.edit_lifetime, row.collected_at, row.issued_credential_id]).toEqual(['approved', 'keep', null, null]);
    expect(sorted(parseJson(row.edit_approved).scopes)).toEqual(sorted([...BASE_SCOPES, 'phases:read', 'phases:write']));
    expect((await firstEdit(connector.credentialId)).metadata).toMatchObject({
      path: 'approval-decided', entryPoint: 'mcp', deciderStanding: 'root', approvalId: filed.json.approval.id,
    });
    const collect = await call(connector, 'POST', `/delegation/access-requests/${filed.json.approval.id}/collect`, {});
    expect([collect.status, collect.json?.code]).toEqual([409, 'NOT_COLLECTABLE']);
  });

  it('R-1 (e): the object changed between filing and decide: EDIT_STALE, the request lapsed TARGET_CHANGED, nothing applied', async () => {
    const connector = await registerConnector(OWNER, [...BASE_SCOPES, 'reports:read'], 'any');
    const filed = await fileEdit(connector, { addScopes: ['phases:read'] });
    await edit(OWNER, 'credential', connector.credentialId, { scopes: BASE_SCOPES });
    const stale = await decide(ROOT, filed.json.approval.id, 'approve', { lifetime: KEEP });
    expect([stale.status, stale.json?.code, stale.json?.lapseReason]).toEqual([409, 'EDIT_STALE', 'TARGET_CHANGED']);
    const row = await approvalRow(filed.json.approval.id);
    expect([row.status, row.lapse_reason]).toEqual(['lapsed', 'TARGET_CHANGED']);
    expect(sorted(await scopesOf(connector.credentialId))).toEqual(sorted(BASE_SCOPES));
  });

  it('R-1 (f): approving a subset applies only that subset; approving more than requested is EDIT_ONLY_NARROWS', async () => {
    const connector = await registerConnector(ROOT, BASE_SCOPES, 'any');
    const filed = await fileEdit(connector, { addScopes: ['phases:read', 'phases:write'] });
    const more = await decide(ROOT, filed.json.approval.id, 'approve',
      { lifetime: KEEP, editedScopes: [...BASE_SCOPES, 'phases:read', 'phases:write', 'reports:read'] });
    expect([more.status, more.json?.code]).toEqual([422, 'EDIT_ONLY_NARROWS']);
    const subset = await decide(ROOT, filed.json.approval.id, 'approve', { lifetime: KEEP, editedScopes: [...BASE_SCOPES, 'phases:read'] });
    expect([subset.status, subset.json?.approval?.status]).toEqual([200, 'approved']);
    expect(sorted(await scopesOf(connector.credentialId))).toEqual(sorted([...BASE_SCOPES, 'phases:read']));
  });

  it('L-4: an approve without a lifetime, or until-task with neither a task nor a future date, is EDIT_LIFETIME_REQUIRED and applies nothing', async () => {
    const connector = await registerConnector(ROOT, BASE_SCOPES, 'any');
    const filed = await fileEdit(connector, { addScopes: ['phases:read'] });
    const none = await decide(ROOT, filed.json.approval.id, 'approve', {});
    const bare = await decide(ROOT, filed.json.approval.id, 'approve', { lifetime: { choice: 'until-task' } });
    const past = await decide(ROOT, filed.json.approval.id, 'approve',
      { lifetime: { choice: 'until-task', revertAt: new Date(Date.now() - 60_000).toISOString() } });
    for (const answered of [none, bare, past]) {
      expect([answered.status, answered.json?.code, answered.json?.clause]).toEqual([422, 'EDIT_LIFETIME_REQUIRED', 'AZ-A13 clause 6j']);
    }
    const owned = await registerConnector(ROOT, BASE_SCOPES, 'any');
    const oneAct = await edit(ROOT, 'credential', owned.credentialId,
      { scopes: [...BASE_SCOPES, 'phases:read'], stepUpToken: await stepUp(ROOT, 'credential.edit', owned.credentialId) });
    expect([oneAct.status, oneAct.json?.code]).toEqual([422, 'EDIT_LIFETIME_REQUIRED']);
    expect(sorted(await scopesOf(connector.credentialId))).toEqual(sorted(BASE_SCOPES));
    expect(sorted(await scopesOf(owned.credentialId))).toEqual(sorted(BASE_SCOPES));
  });

  it('hub defect: a refused 422 decision leaves the same step-up available for a corrected approval', async () => {
    const connector = await registerConnector(ROOT, BASE_SCOPES, 'any');
    const filed = await fileEdit(connector, { addScopes: ['phases:read'] });
    const approvalId = filed.json.approval.id;
    const token = await stepUp(ROOT, 'approval.decide', approvalId);
    const refused = await call(ROOT, 'POST', `/approvals/${approvalId}/approve`, { stepUpToken: token });
    expect([refused.status, refused.json?.code]).toEqual([422, 'EDIT_LIFETIME_REQUIRED']);
    expect(await stepUpSpent(ROOT, 'approval.decide', approvalId)).toEqual([false]);
    expect((await approvalRow(approvalId)).status).toBe('pending');
    const accepted = await call(ROOT, 'POST', `/approvals/${approvalId}/approve`, {
      stepUpToken: token, lifetime: KEEP,
    });
    expect([accepted.status, accepted.json?.approval?.status]).toEqual([200, 'approved']);
    expect(await stepUpSpent(ROOT, 'approval.decide', approvalId)).toEqual([true]);
    expect(sorted(await scopesOf(connector.credentialId))).toEqual(sorted([...BASE_SCOPES, 'phases:read']));
  });

  it('N14: a direct human one-act widening is visible but does not use filed-request quota', async () => {
    const editor = await sessionFor('n14-editor', await makeAccount('admin', 'n14-editor'));
    const connector = await registerConnector(editor, BASE_SCOPES, 'any');
    const changed = await widen(editor, 'credential', connector.credentialId, {
      scopes: [...BASE_SCOPES, 'phases:read'],
    });
    expect(changed.status).toBe(200);
    const direct = (await editApprovals(connector.credentialId))[0];
    expect(parseJson(direct.session_evidence)).toMatchObject({ door: 'one-act' });
    const item = await call(ROOT, 'GET', `/approvals/${direct.id}`);
    expect(item.status).toBe(200);
    expect(item.json?.decision?.quota).toMatchObject({ pending: 0, daily: 0 });
  });

  it('drill 6: GET /approvals?kind=authority-edit lists it; the item view carries the diff and the decider context; the shared quota; a rotation lapses the pending request', async () => {
    const connector = await registerConnector(ROOT, BASE_SCOPES, 'any');
    const filed = await fileEdit(connector, { addScopes: ['phases:read'] });
    const listed = await call(ROOT, 'GET', '/approvals?kind=authority-edit&status=pending');
    expect(listed.json.approvals.some((approval: any) => approval.id === filed.json.approval.id)).toBe(true);
    expect(listed.json.approvals.every((approval: any) => approval.kind === 'authority-edit')).toBe(true);
    const item = await call(ROOT, 'GET', `/approvals/${filed.json.approval.id}`);
    expect(item.json.approval.authorityEdit).toMatchObject({
      objectType: 'credential', objectKindLabel: 'Connector configuration', objectId: connector.credentialId,
      diff: [{ field: 'scopes', before: BASE_SCOPES, after: [...BASE_SCOPES, 'phases:read'] }], lifetime: null,
    });
    expect(item.json.decision.authorityEdit).toMatchObject({ added: ['phases:read'], stale: false });
    expect(item.json.decision.clause11.deciderCeiling).toMatchObject({ ok: true });
    const hub = await call(ROOT, 'GET', '/approvals?view=hub&kind=authority-edit');
    expect(hub.json.approvals.find((approval: any) => approval.id === filed.json.approval.id)?.decidable).toBe(true);
    const rotated = await call(ROOT, 'POST', `/credentials/${connector.credentialId}/rotate`, {});
    SECRETS.push(String(rotated.json.secretOnce));
    const row = await approvalRow(filed.json.approval.id);
    expect([row.status, row.lapse_reason]).toEqual(['lapsed', 'CREDENTIAL_ROTATED']);
    // The quota is ONE across kinds (AZ-A9 clause 11): five pending of any kind refuse the sixth.
    const busy = await registerConnector(OWNER, BASE_SCOPES, 'any');
    for (let i = 0; i < 5; i += 1) {
      await pool.query(
        `INSERT INTO approvals (kind, requester_principal_id, requesting_credential_id, requested_scopes, pending_expires_at,
           edit_object_type, edit_object_id, edit_before, edit_requested, reason, grantee_principal_id)
         VALUES ('authority-edit', $1, $2, '[]'::jsonb, NOW() + INTERVAL '1 day', 'grant', $3, '{}'::jsonb, '{}'::jsonb, $4, $5)`,
        [busy.principalId, busy.credentialId, crypto.randomUUID(), REASON, OWNER.principalId]);
    }
    const quota = await fileEdit(busy, { addScopes: ['phases:read'] });
    expect([quota.status, quota.json?.code]).toEqual([429, 'REQUEST_QUOTA_EXCEEDED']);
  });
});

// ─────────────────────────── (L) the lifetime of a widening ───────────────────

describe('(L) the lifetime of an approved widening (clause 6j, E94)', () => {
  it('L-1: "keep" stands after the related task completes', async () => {
    const connector = await registerConnector(ROOT, BASE_SCOPES, 'any');
    const task = await taskIn(ROOT, ROOT_PROJECT);
    const filed = await fileEdit(connector, { addScopes: ['phases:read'], relatedTaskId: task });
    expect((await decide(ROOT, filed.json.approval.id, 'approve', { lifetime: KEEP })).status).toBe(200);
    expect((await call(ROOT, 'PATCH', `/tasks/${task}`, { status: 'completed' })).status).toBe(200);
    await authorityEditExecutor.sweepReverts();
    expect(sorted(await scopesOf(connector.credentialId))).toEqual(sorted([...BASE_SCOPES, 'phases:read']));
    expect((await approvalRow(filed.json.approval.id)).edit_reverted_at).toBeNull();
    // AZ-31c: rotating the bound credential lapses what WAITS on it; an approved
    // edit is terminal (clause 6f), so the rotation succeeds and leaves it approved.
    const rotated = await call(ROOT, 'POST', `/credentials/${connector.credentialId}/rotate`, {});
    expect(rotated.status).toBe(201);
    SECRETS.push(String(rotated.json.secretOnce));
    expect((await approvalRow(filed.json.approval.id)).status).toBe('approved');
  });

  it('clause 6a: a PENDING edit request is not lapsed when its related task ends - the related task is a reference only', async () => {
    const connector = await registerConnector(ROOT, BASE_SCOPES, 'any');
    const task = await taskIn(ROOT, ROOT_PROJECT);
    const filed = await fileEdit(connector, { addScopes: ['phases:read'], relatedTaskId: task });
    expect(filed.status).toBe(202);
    expect((await call(ROOT, 'PATCH', `/tasks/${task}`, { status: 'completed' })).status).toBe(200);
    expect((await approvalRow(filed.json.approval.id)).status).toBe('pending');
  });

  it('L-2: "until this task ends": completing the related task reverts ONLY what the widening added; a later narrowing is preserved; live Agents are not narrowed by the revert', async () => {
    const connector = await registerConnector(ROOT, [...BASE_SCOPES, 'reports:read'], 'any');
    const task = await taskIn(ROOT, ROOT_PROJECT);
    const anchor = await taskIn(ROOT, ROOT_PROJECT);
    const widened = await widen(ROOT, 'credential', connector.credentialId,
      { scopes: [...BASE_SCOPES, 'reports:read', 'phases:read', 'phases:write'] }, { choice: 'until-task', taskId: task });
    expect(widened.status).toBe(200);
    const warrant = await warrantFor(connector, anchor, { ceilingScopes: ['tasks:read', 'phases:read'] });
    const agent = await mintAgent(connector, warrant, anchor, ['tasks:read', 'phases:read']);
    // A later narrowing removes reports:read (held before the widening): the revert must not bring it back.
    expect((await edit(ROOT, 'credential', connector.credentialId, { scopes: [...BASE_SCOPES, 'phases:read', 'phases:write'] })).status).toBe(200);
    expect((await call(ROOT, 'PATCH', `/tasks/${task}`, { status: 'completed' })).status).toBe(200);
    expect(sorted(await scopesOf(connector.credentialId))).toEqual(sorted(BASE_SCOPES));
    const row = (await editApprovals(connector.credentialId))[0];
    expect(row.edit_reverted_at).not.toBeNull();
    const revert = (await edits(connector.credentialId)).map((r) => parseJson(r.metadata)).find((m) => m.path === 'revert');
    expect(revert).toMatchObject({ direction: 'narrowing', deciderStanding: null, approvalId: row?.id, entryPoint: 'sweep' });
    expect(revert?.follows).toBe((await firstEdit(connector.credentialId)).id);
    expect(sorted(await scopesOf(agent.credentialId))).toEqual(sorted(['tasks:read', 'phases:read']));
    expect((await approvalEvents(row.id, 'approval.revoked')).map((e) => parseJson(e.metadata).outcome)).toEqual(['reverted']);
  });

  it('L-2: archiving the related task reverts too, and a hard delete of the task reverts before the record is detached', async () => {
    const archived = await registerConnector(ROOT, BASE_SCOPES, 'any');
    const deleted = await registerConnector(ROOT, BASE_SCOPES, 'any');
    const task = await taskIn(ROOT, ROOT_PROJECT);
    const doomed = await taskIn(ROOT, ROOT_PROJECT);
    expect((await widen(ROOT, 'credential', archived.credentialId, { scopes: [...BASE_SCOPES, 'phases:read'] }, { choice: 'until-task', taskId: task })).status).toBe(200);
    expect((await widen(ROOT, 'credential', deleted.credentialId, { scopes: [...BASE_SCOPES, 'phases:read'] }, { choice: 'until-task', taskId: doomed })).status).toBe(200);
    expect((await call(ROOT, 'POST', `/tasks/${task}/archive`, {})).status).toBeLessThan(300);
    expect((await call(ROOT, 'DELETE', `/tasks/${doomed}`)).status).toBeLessThan(300);
    expect(sorted(await scopesOf(archived.credentialId))).toEqual(sorted(BASE_SCOPES));
    expect(sorted(await scopesOf(deleted.credentialId))).toEqual(sorted(BASE_SCOPES));
    expect((await editApprovals(deleted.credentialId))[0].edit_reverted_at).not.toBeNull();
  });

  it('L-3: a revert at its date, by the sweep', async () => {
    const connector = await registerConnector(ROOT, BASE_SCOPES, 'any');
    // The date sits far enough ahead that the first sweep still runs before it
    // on a loaded runner (with 2.5 s the date could pass before that sweep, and
    // the test failed at its first assertion), and the wait is measured to the
    // date itself instead of being fixed.
    const revertAt = new Date(Date.now() + 8000).toISOString();
    expect((await widen(ROOT, 'credential', connector.credentialId, { scopes: [...BASE_SCOPES, 'phases:read'] },
      { choice: 'until-task', revertAt })).status).toBe(200);
    await authorityEditExecutor.sweepReverts();
    expect(sorted(await scopesOf(connector.credentialId))).toEqual(sorted([...BASE_SCOPES, 'phases:read']));
    await sleep(Math.max(0, Date.parse(revertAt) - Date.now()) + 500);
    const swept = await authorityEditExecutor.sweepReverts();
    expect(swept.reverted).toBeGreaterThanOrEqual(1);
    expect(sorted(await scopesOf(connector.credentialId))).toEqual(sorted(BASE_SCOPES));
  });

  // ── card 0e07c0c7: the hub's lifetime options on a FILED request, decided on
  // /approvals exactly as the hub sends them (ApprovalsQueue `authorityEditLifetime`).
  // The shortest is a date, the middle is the related task, the longest is keep.
  // A credential edit carries no expiry of its own (clause 12a never reaches the
  // edited object): the lifetime is the approval's revert record, reverted by
  // the existing 60-second sweep as an audited narrowing.

  it('card 0e07c0c7 L-7 shortest (a date, no related task): the request records edit_revert_at; the sweep removes exactly the added scope at that instant, audited, once', async () => {
    const connector = await registerConnector(ROOT, BASE_SCOPES, 'any');
    const expiryBefore = (await credentialRow(connector.credentialId)).expires_at;
    const filed = await fileEdit(connector, { addScopes: ['phases:read'] });
    expect([filed.status, (await approvalRow(filed.json.approval.id)).related_task_id]).toEqual([202, null]);
    const revertAt = new Date(Math.ceil((Date.now() + 8000) / 1000) * 1000).toISOString();
    const approved = await decide(ROOT, filed.json.approval.id, 'approve', { lifetime: { choice: 'until-task', revertAt } });
    expect([approved.status, approved.json?.code]).toEqual([200, undefined]);
    const row = await approvalRow(filed.json.approval.id);
    expect([row.status, row.edit_lifetime, row.edit_revert_at && new Date(row.edit_revert_at).toISOString(), row.related_task_id, row.edit_reverted_at])
      .toEqual(['approved', 'until-task', revertAt, null, null]);
    expect(approved.json.approval.authorityEdit.lifetime).toMatchObject({ choice: 'until-task', taskId: null, revertAt, revertedAt: null, due: false });
    // The credential keeps its own expiry; the widening's end is the revert record.
    expect((await credentialRow(connector.credentialId)).expires_at).toEqual(expiryBefore);
    expect((await firstEdit(connector.credentialId)).metadata).toMatchObject({
      path: 'approval-decided', direction: 'widening', lifetime: { choice: 'until-task', taskId: null, revertAt },
    });
    await authorityEditExecutor.sweepReverts();
    expect(sorted(await scopesOf(connector.credentialId))).toEqual(sorted([...BASE_SCOPES, 'phases:read']));
    await sleep(Math.max(0, Date.parse(revertAt) - Date.now()) + 500);
    expect((await call(ROOT, 'GET', `/approvals/${filed.json.approval.id}`)).json.approval.authorityEdit.lifetime.due).toBe(true);
    expect((await authorityEditExecutor.sweepReverts()).reverted).toBeGreaterThanOrEqual(1);
    expect(sorted(await scopesOf(connector.credentialId))).toEqual(sorted(BASE_SCOPES));
    const closed = await approvalRow(filed.json.approval.id);
    expect(closed.edit_reverted_at).not.toBeNull();
    expect(new Date(closed.edit_reverted_at).getTime()).toBeGreaterThanOrEqual(Date.parse(revertAt));
    const reverts = (await edits(connector.credentialId)).map((r) => parseJson(r.metadata)).filter((m) => m.path === 'revert');
    expect(reverts).toHaveLength(1);
    expect(reverts[0]).toMatchObject({ direction: 'narrowing', entryPoint: 'sweep', deciderStanding: null, approvalId: filed.json.approval.id });
    expect(reverts[0].follows).toBe((await firstEdit(connector.credentialId)).id);
    // Idempotent: a second sweep writes nothing more.
    await authorityEditExecutor.sweepReverts();
    expect((await edits(connector.credentialId)).map((r) => parseJson(r.metadata)).filter((m) => m.path === 'revert')).toHaveLength(1);
    expect((await approvalRow(filed.json.approval.id)).edit_reverted_at).toEqual(closed.edit_reverted_at);
    expect((await approvalEvents(filed.json.approval.id, 'approval.revoked')).map((e) => parseJson(e.metadata).outcome)).toEqual(['reverted']);
  });

  it('card 0e07c0c7 L-7 middle (the related task, no date): the request records the task and no date; the task terminal reverts it', async () => {
    const connector = await registerConnector(ROOT, BASE_SCOPES, 'any');
    const task = await taskIn(ROOT, ROOT_PROJECT);
    const filed = await fileEdit(connector, { addScopes: ['phases:read'], relatedTaskId: task });
    const approved = await decide(ROOT, filed.json.approval.id, 'approve', { lifetime: { choice: 'until-task', taskId: task } });
    expect([approved.status, approved.json?.code]).toEqual([200, undefined]);
    const row = await approvalRow(filed.json.approval.id);
    expect([row.edit_lifetime, row.edit_revert_at, String(row.related_task_id)]).toEqual(['until-task', null, task]);
    expect(approved.json.approval.authorityEdit.lifetime).toMatchObject({ choice: 'until-task', label: 'Until this task ends', taskId: task, revertAt: null });
    await authorityEditExecutor.sweepReverts();
    expect(sorted(await scopesOf(connector.credentialId))).toEqual(sorted([...BASE_SCOPES, 'phases:read']));
    expect((await call(ROOT, 'PATCH', `/tasks/${task}`, { status: 'completed' })).status).toBe(200);
    expect(sorted(await scopesOf(connector.credentialId))).toEqual(sorted(BASE_SCOPES));
    expect((await approvalRow(filed.json.approval.id)).edit_reverted_at).not.toBeNull();
  });

  it('card 0e07c0c7 L-7 keep: "Keep (until narrowed)" records keep with no date, and no sweep reverts it', async () => {
    const connector = await registerConnector(ROOT, BASE_SCOPES, 'any');
    const filed = await fileEdit(connector, { addScopes: ['phases:read'] });
    const approved = await decide(ROOT, filed.json.approval.id, 'approve', { lifetime: KEEP });
    expect(approved.status).toBe(200);
    const row = await approvalRow(filed.json.approval.id);
    expect([row.edit_lifetime, row.edit_revert_at, row.related_task_id]).toEqual(['keep', null, null]);
    expect(approved.json.approval.authorityEdit.lifetime).toMatchObject({ choice: 'keep', label: 'Keep (until narrowed)', revertAt: null, due: false });
    await authorityEditExecutor.sweepReverts();
    expect(sorted(await scopesOf(connector.credentialId))).toEqual(sorted([...BASE_SCOPES, 'phases:read']));
    expect((await approvalRow(filed.json.approval.id)).edit_reverted_at).toBeNull();
  });

  it('L-5: a warrant-ceiling revert while tasks ride the warrant waits, shown as due, until a person acknowledges it', async () => {
    const connector = await registerConnector(ROOT, BASE_SCOPES, 'any');
    const anchor = await taskIn(ROOT, ROOT_PROJECT);
    const ending = await taskIn(ROOT, ROOT_PROJECT);
    const rider = await taskIn(ROOT, ROOT_PROJECT);
    const warrant = await warrantFor(connector, anchor);
    const before = (await pool.query('SELECT ceiling_profile_version_id FROM warrants WHERE id = $1', [warrant])).rows[0].ceiling_profile_version_id;
    const widened = await widen(ROOT, 'warrant', warrant, {
      ceilingRules: [{ resourceType: 'task', selectorForm: 'exact', selectorIds: [anchor, rider], verbs: ['read', 'write'] }],
    }, { choice: 'until-task', taskId: ending });
    expect([widened.status, widened.json?.edit?.direction]).toEqual([200, 'widening']);
    await ride(rider, connector, warrant);
    expect((await call(ROOT, 'PATCH', `/tasks/${ending}`, { status: 'completed' })).status).toBe(200);
    const row = (await editApprovals(warrant))[0];
    expect(row.edit_reverted_at).toBeNull();
    const item = await call(ROOT, 'GET', `/approvals/${row.id}`);
    expect(item.json.approval.authorityEdit.lifetime).toMatchObject({ choice: 'until-task', due: true, revertedAt: null });
    expect((await authorityEditExecutor.sweepReverts()).waiting).toBeGreaterThanOrEqual(1);
    const unacknowledged = await call(ROOT, 'PATCH', `/warrants/${warrant}`, { applyRevert: row.id });
    expect([unacknowledged.status, unacknowledged.json?.code]).toEqual([409, 'WARRANT_HAS_DEPENDENT_TASKS']);
    const acknowledged = await call(ROOT, 'PATCH', `/warrants/${warrant}`, { applyRevert: row.id, acknowledgeDependents: true });
    expect([acknowledged.status, acknowledged.json?.revert?.outcome]).toEqual([200, 'reverted']);
    expect((await pool.query('SELECT ceiling_profile_version_id FROM warrants WHERE id = $1', [warrant])).rows[0].ceiling_profile_version_id).toBe(before);
    expect((await pool.query('SELECT execution_warrant_id FROM tasks WHERE id = $1', [rider])).rows[0].execution_warrant_id).toBeNull();
  });

  it('L-6: every authority-edit item the API returns names the object kind and, once decided, the lifetime chosen', async () => {
    const connector = await registerConnector(ROOT, BASE_SCOPES, 'any');
    const task = await taskIn(ROOT, ROOT_PROJECT);
    expect((await widen(ROOT, 'credential', connector.credentialId, { scopes: [...BASE_SCOPES, 'phases:read'] }, { choice: 'until-task', taskId: task })).status).toBe(200);
    const listed = await call(ROOT, 'GET', '/approvals?kind=authority-edit');
    expect(listed.json.approvals.length).toBeGreaterThan(0);
    for (const approval of listed.json.approvals) {
      expect(['Connector configuration', 'Warrant', 'Grant']).toContain(approval.authorityEdit?.objectKindLabel);
      if (approval.status === 'approved') {
        expect(['Keep (until narrowed)', 'Until this task ends']).toContain(approval.authorityEdit?.lifetime?.label);
      }
    }
    const hub = await call(ROOT, 'GET', '/approvals?view=hub&status=all&kind=authority-edit');
    const mine = hub.json.approvals.find((approval: any) => approval.authorityEdit?.objectId === connector.credentialId);
    expect(mine?.authorityEdit).toMatchObject({ objectKindLabel: 'Connector configuration', lifetime: { label: 'Until this task ends', taskId: task } });
  });

  // ── review 1a38270d round 1, B1: an until-task widening is removed, field
  // by field, or its record stays due - never closed while what it added is
  // still present (clause 6j).

  it('clause 6j (r1 B1 a): a warrant ceiling moved to one not comparable with the old, with maxTotal 5 -> 10, is refused "until this task ends" EDIT_LIFETIME_REQUIRED naming the ceiling, nothing applied and the step-up unspent; keep applies it', async () => {
    const connector = await registerConnector(ROOT, BASE_SCOPES, 'any');
    const a = await taskIn(ROOT, ROOT_PROJECT);
    const b = await taskIn(ROOT, ROOT_PROJECT);
    const ending = await taskIn(ROOT, ROOT_PROJECT);
    const warrant = await warrantFor(connector, a, { maxTotal: 5 });
    const before = await warrantRow(warrant);
    const toB = { ceilingRules: [{ resourceType: 'task', selectorForm: 'exact', selectorIds: [b], verbs: ['read', 'write'] }], maxTotal: 10 };
    const token = await stepUp(ROOT, 'warrant.edit', warrant);
    const refused = await edit(ROOT, 'warrant', warrant, { ...toB, lifetime: { choice: 'until-task', taskId: ending }, stepUpToken: token });
    expect([refused.status, refused.json?.code, refused.json?.unrevertible, refused.json?.subject, refused.json?.clause])
      .toEqual([422, 'EDIT_LIFETIME_REQUIRED', ['ceiling'], 'decider', 'AZ-A13 clause 6j']);
    expect(await warrantRow(warrant)).toEqual(before);
    expect(await editApprovals(warrant)).toEqual([]);
    expect((await edits(warrant, 'denied')).map((r) => parseJson(r.metadata).refusal)).toEqual(['EDIT_LIFETIME_REQUIRED']);
    expect(await stepUpSpent(ROOT, 'warrant.edit', warrant)).toEqual([false]);
    const kept = await edit(ROOT, 'warrant', warrant, { ...toB, lifetime: KEEP, stepUpToken: token });
    expect([kept.status, kept.json?.edit?.direction, (await warrantRow(warrant)).max_total]).toEqual([200, 'widening', 10]);
  });

  it('clause 6j (r1 B1 a, at the revert): a record whose widening moved the ceiling A -> B and maxTotal 5 -> 10 takes maxTotal back at the task terminal, keeps B, and stays due and visible; a revoke then closes it', async () => {
    const connector = await registerConnector(ROOT, BASE_SCOPES, 'any');
    const a = await taskIn(ROOT, ROOT_PROJECT);
    const b = await taskIn(ROOT, ROOT_PROJECT);
    const ending = await taskIn(ROOT, ROOT_PROJECT);
    const warrant = await warrantFor(connector, a, { maxTotal: 5 });
    // The widening is applied through the real door ("keep"); the record a door
    // that admitted "until this task ends" would have written is then laid
    // beside it: the shape review round 1 reproduced.
    const kept = await widen(ROOT, 'warrant', warrant,
      { ceilingRules: [{ resourceType: 'task', selectorForm: 'exact', selectorIds: [b], verbs: ['read', 'write'] }], maxTotal: 10 });
    expect([kept.status, sorted(kept.json?.edit?.changed ?? [])]).toEqual([200, ['ceiling', 'maxTotal']]);
    const pinnedB = kept.json.edit.after.ceilingProfileVersionId;
    const source = (await editApprovals(warrant))[0];
    expect(source?.edit_lifetime).toBe('keep');
    const record = (await pool.query(
      `INSERT INTO approvals (kind, status, requester_principal_id, session_evidence, requested_scopes, pending_expires_at,
         decided_by_principal_id, decided_at, edit_object_type, edit_object_id, edit_before, edit_requested, edit_approved,
         edit_lifetime, related_task_id, grantee_principal_id, reason)
       VALUES ('authority-edit', 'approved', $1, '{}'::jsonb, '[]'::jsonb, NOW(), $1, NOW(), 'warrant', $2,
         $3::jsonb, $4::jsonb, $5::jsonb, 'until-task', $6, $7, $8) RETURNING id`,
      [ROOT.principalId, warrant, JSON.stringify(source.edit_before), JSON.stringify(source.edit_requested),
        JSON.stringify(source.edit_approved), ending, source.grantee_principal_id, REASON])).rows[0];
    expect((await call(ROOT, 'PATCH', `/tasks/${ending}`, { status: 'completed' })).status).toBe(200);
    const after = await warrantRow(warrant);
    expect([after.max_total, after.ceiling_profile_version_id]).toEqual([5, pinnedB]);
    expect((await approvalRow(record.id)).edit_reverted_at).toBeNull();
    expect(await approvalEvents(record.id, 'approval.revoked')).toEqual([]);
    const reverts = async () => (await edits(warrant)).map((r) => parseJson(r.metadata)).filter((m) => m.path === 'revert');
    expect((await reverts()).map((m) => [m.approvalId, m.direction, m.changed, m.after?.maxTotal])).toEqual([[record.id, 'narrowing', ['maxTotal'], 5]]);
    const item = await call(ROOT, 'GET', `/approvals/${record.id}`);
    expect(item.json?.approval?.authorityEdit?.lifetime).toMatchObject({ choice: 'until-task', due: true, revertedAt: null });
    expect((await authorityEditExecutor.sweepReverts()).blocked).toBeGreaterThanOrEqual(1);
    expect((await reverts()).length).toBe(1);
    expect((await approvalRow(record.id)).edit_reverted_at).toBeNull();
    expect((await call(ROOT, 'POST', `/warrants/${warrant}/revoke`, { acknowledgeDependents: true })).status).toBe(200);
    await authorityEditExecutor.sweepReverts();
    expect((await approvalRow(record.id)).edit_reverted_at).not.toBeNull();
    expect((await approvalEvents(record.id, 'approval.revoked')).map((e) => parseJson(e.metadata).outcome)).toEqual(['closed']);
  });

  it('clause 6j (r1 B1 b): a grant selector moved X -> Y is refused "until this task ends" EDIT_LIFETIME_REQUIRED naming resourceId, nothing applied; keep moves it', async () => {
    const holder = await sessionFor('holder6', await makeAccount('editor', 'holder6'));
    const x = await taskIn(ROOT, ROOT_PROJECT);
    const y = await taskIn(ROOT, ROOT_PROJECT);
    const ending = await taskIn(ROOT, ROOT_PROJECT);
    const grant = await call(ROOT, 'POST', '/grants', { granteeId: holder.principalId, resourceType: 'task', resourceId: x, verb: 'read' });
    expect(grant.status).toBe(201);
    const id = String(grant.json.grant.id);
    const refused = await widen(ROOT, 'grant', id, { resourceId: y }, { choice: 'until-task', taskId: ending });
    expect([refused.status, refused.json?.code, refused.json?.unrevertible]).toEqual([422, 'EDIT_LIFETIME_REQUIRED', ['resourceId']]);
    expect((await pool.query('SELECT resource_id FROM grants WHERE id = $1', [id])).rows[0].resource_id).toBe(x);
    expect(await editApprovals(id)).toEqual([]);
    const kept = await widen(ROOT, 'grant', id, { resourceId: y });
    expect([kept.status, kept.json?.edit?.direction]).toEqual([200, 'widening']);
    expect((await pool.query('SELECT resource_id FROM grants WHERE id = $1', [id])).rows[0].resource_id).toBe(y);
  });

  it('clause 6j (r1 B1 c): a credential transport moved mcp -> api is refused "until this task ends" EDIT_LIFETIME_REQUIRED naming transport, nothing applied; mcp -> any until the task ends comes back to mcp', async () => {
    const connector = await registerConnector(ROOT, BASE_SCOPES, 'mcp');
    const ending = await taskIn(ROOT, ROOT_PROJECT);
    const refused = await widen(ROOT, 'credential', connector.credentialId, { transport: 'api' }, { choice: 'until-task', taskId: ending });
    expect([refused.status, refused.json?.code, refused.json?.unrevertible]).toEqual([422, 'EDIT_LIFETIME_REQUIRED', ['transport']]);
    expect((await credentialRow(connector.credentialId)).transport).toBe('mcp');
    expect(await editApprovals(connector.credentialId)).toEqual([]);
    expect((await widen(ROOT, 'credential', connector.credentialId, { transport: 'any' }, { choice: 'until-task', taskId: ending })).status).toBe(200);
    expect((await call(ROOT, 'PATCH', `/tasks/${ending}`, { status: 'completed' })).status).toBe(200);
    expect((await credentialRow(connector.credentialId)).transport).toBe('mcp');
    expect((await editApprovals(connector.credentialId))[0]?.edit_reverted_at ?? null).not.toBeNull();
  });

  it('clause 6j (r1 B1 d): added scopes a later narrowing left alone in the set stay, and the record stays due and visible at the terminal, until a person takes them away; an edit replacing the whole set is refused "until this task ends"', async () => {
    const connector = await registerConnector(ROOT, ['tasks:read', 'projects:read'], 'any');
    const ending = await taskIn(ROOT, ROOT_PROJECT);
    const replaced = await widen(ROOT, 'credential', connector.credentialId, { scopes: ['phases:read'] }, { choice: 'until-task', taskId: ending });
    expect([replaced.status, replaced.json?.code, replaced.json?.unrevertible]).toEqual([422, 'EDIT_LIFETIME_REQUIRED', ['scopes']]);
    expect(sorted(await scopesOf(connector.credentialId))).toEqual(['projects:read', 'tasks:read']);
    expect((await widen(ROOT, 'credential', connector.credentialId, { scopes: ['tasks:read', 'projects:read', 'phases:read'] },
      { choice: 'until-task', taskId: ending })).status).toBe(200);
    expect((await edit(ROOT, 'credential', connector.credentialId, { scopes: ['phases:read'] })).status).toBe(200);
    expect((await call(ROOT, 'PATCH', `/tasks/${ending}`, { status: 'completed' })).status).toBe(200);
    expect(await scopesOf(connector.credentialId)).toEqual(['phases:read']);
    const row = (await editApprovals(connector.credentialId))[0];
    expect(row?.edit_lifetime).toBe('until-task');
    expect((await approvalRow(row.id)).edit_reverted_at).toBeNull();
    expect(await approvalEvents(row.id, 'approval.revoked')).toEqual([]);
    const item = await call(ROOT, 'GET', `/approvals/${row.id}`);
    expect(item.json?.approval?.authorityEdit?.lifetime).toMatchObject({ choice: 'until-task', due: true, revertedAt: null });
    expect((await authorityEditExecutor.sweepReverts()).blocked).toBeGreaterThanOrEqual(1);
    expect((await approvalRow(row.id)).edit_reverted_at).toBeNull();
    expect((await widen(ROOT, 'credential', connector.credentialId, { scopes: ['tasks:read'] })).status).toBe(200);
    await authorityEditExecutor.sweepReverts();
    expect((await approvalRow(row.id)).edit_reverted_at).not.toBeNull();
    expect((await approvalEvents(row.id, 'approval.revoked')).map((e) => parseJson(e.metadata).outcome)).toEqual(['nothing']);
  });

  it('clause 6j (r1 B1, per field): a widening that narrows the ceiling and raises maxTotal, until the task ends, takes maxTotal back at the terminal and leaves the narrower ceiling; the record is reverted', async () => {
    const connector = await registerConnector(ROOT, BASE_SCOPES, 'any');
    const a = await taskIn(ROOT, ROOT_PROJECT);
    const ending = await taskIn(ROOT, ROOT_PROJECT);
    const warrant = await warrantFor(connector, a, { maxTotal: 5 });
    const widened = await widen(ROOT, 'warrant', warrant, {
      ceilingRules: [{ resourceType: 'task', selectorForm: 'exact', selectorIds: [a], verbs: ['read'] }], maxTotal: 10,
    }, { choice: 'until-task', taskId: ending });
    expect([widened.status, widened.json?.edit?.direction, sorted(widened.json?.edit?.changed ?? [])]).toEqual([200, 'widening', ['ceiling', 'maxTotal']]);
    const narrower = widened.json.edit.after.ceilingProfileVersionId;
    expect((await call(ROOT, 'PATCH', `/tasks/${ending}`, { status: 'completed' })).status).toBe(200);
    const row = await warrantRow(warrant);
    expect([row.max_total, row.ceiling_profile_version_id]).toEqual([5, narrower]);
    const approval = (await editApprovals(warrant))[0];
    expect(approval?.edit_lifetime).toBe('until-task');
    expect((await approvalRow(approval.id)).edit_reverted_at).not.toBeNull();
    expect((await approvalEvents(approval.id, 'approval.revoked')).map((e) => parseJson(e.metadata).outcome)).toEqual(['reverted']);
  });

  it('clause 6j (r1 B1, scope ceiling): the scopes a warrant widening added to its scope ceiling are removed at the terminal, [tasks:read, projects:read] -> [tasks:read, phases:read] coming back to [tasks:read]', async () => {
    const connector = await registerConnector(ROOT, BASE_SCOPES, 'any');
    const anchor = await taskIn(ROOT, ROOT_PROJECT);
    const ending = await taskIn(ROOT, ROOT_PROJECT);
    const warrant = await warrantFor(connector, anchor, { ceilingScopes: ['tasks:read', 'projects:read'] });
    const widened = await widen(ROOT, 'warrant', warrant, { ceilingScopes: ['tasks:read', 'phases:read'] }, { choice: 'until-task', taskId: ending });
    expect([widened.status, widened.json?.edit?.direction]).toEqual([200, 'widening']);
    expect((await call(ROOT, 'PATCH', `/tasks/${ending}`, { status: 'completed' })).status).toBe(200);
    expect(parseJson((await warrantRow(warrant)).ceiling_scopes)).toEqual(['tasks:read']);
    expect((await editApprovals(warrant))[0]?.edit_reverted_at ?? null).not.toBeNull();
  });

  it('clause 6j (r1 B1, unpinned ceiling): a warrant ceiling with no pinned version is unrepresentable (migration 100), and a revert plan over a record naming none keeps the ceiling as a residual while maxTotal goes back', async () => {
    const connector = await registerConnector(ROOT, BASE_SCOPES, 'any');
    const a = await taskIn(ROOT, ROOT_PROJECT);
    const warrant = await warrantFor(connector, a, { maxTotal: 10 });
    const row = await warrantRow(warrant);
    await expect(pool.query(`UPDATE warrants SET ceiling_profile_version_id = NULL, ceiling_rules = '[]'::jsonb WHERE id = $1`, [warrant]))
      .rejects.toMatchObject({ code: '23514' });
    expect(typeof authorityEditExecutor.revertPlan).toBe('function');
    const state = {
      ceilingProfileVersionId: String(row.ceiling_profile_version_id), ceilingScopes: null, maxConcurrent: null, maxTotal: 10,
      expiresAt: row.expires_at ? new Date(row.expires_at).toISOString() : null, transportPin: 'any',
    };
    const plan = await authorityEditExecutor.revertPlan?.(
      { type: 'warrant', state, ceilingRules: [{ resourceType: 'task', selectorForm: 'exact', selectorIds: [a], verbs: ['read', 'write'] }] },
      { ...state, ceilingProfileVersionId: null, maxTotal: 5 }, state);
    expect([plan?.residual, plan?.next?.maxTotal, plan?.next?.ceilingProfileVersionId]).toEqual([['ceiling'], 5, state.ceilingProfileVersionId]);
  });
});

// ─────────────────────────── (N) the narrow-all act ────────────────────────

describe('(N) a narrowing reaches the live Agents minted under it (clauses 9h, 10g; E94, E113)', () => {
  it('N-1: per-agent Revoke still works', async () => {
    const connector = await registerConnector(ROOT, [...BASE_SCOPES, 'phases:read'], 'any');
    const task = await taskIn(ROOT, ROOT_PROJECT);
    const warrant = await warrantFor(connector, task, { ceilingScopes: ['tasks:read', 'phases:read'] });
    const agent = await mintAgent(connector, warrant, task, ['tasks:read']);
    const revoked = await call(connector, 'POST', `/credentials/${agent.credentialId}/revoke`, { reason: 'drill' });
    expect([revoked.status, revoked.json?.revoked]).toEqual([200, true]);
    expect((await credentialRow(agent.credentialId)).revoked_at).not.toBeNull();
  });

  it('N-2: the narrow-all act intersects each live Agent in the same transaction, one audit row per Agent, and an empty intersection REVOKES that Agent', async () => {
    const connector = await registerConnector(ROOT, [...BASE_SCOPES, 'phases:read', 'reports:read'], 'any');
    const task = await taskIn(ROOT, ROOT_PROJECT);
    const warrant = await warrantFor(connector, task, { ceilingScopes: ['tasks:read', 'phases:read', 'reports:read'] });
    const both = await mintAgent(connector, warrant, task, ['tasks:read', 'phases:read']);
    const only = await mintAgent(connector, warrant, task, ['reports:read']);
    const narrowed = await edit(ROOT, 'credential', connector.credentialId, { scopes: BASE_SCOPES, narrowAgents: true });
    expect([narrowed.status, narrowed.json?.edit?.narrowedAgents?.length, narrowed.json?.edit?.revokedAgents?.length]).toEqual([200, 1, 1]);
    expect(await scopesOf(both.credentialId)).toEqual(['tasks:read']);
    const emptied = await credentialRow(only.credentialId);
    expect(emptied.revoked_at).not.toBeNull();
    const main = await firstEdit(connector.credentialId);
    const agentRows = await pool.query(
      `SELECT resource_id, metadata FROM audit_events WHERE action = 'credential.edit' AND metadata->>'path' = 'narrow-all'
          AND metadata->>'follows' = $1 ORDER BY resource_id`, [main.id]);
    expect(agentRows.rows.map((row: any) => String(row.resource_id)).sort()).toEqual([both.credentialId, only.credentialId].sort());
    expect(agentRows.rows.find((row: any) => String(row.resource_id) === only.credentialId).metadata.after).toMatchObject({ scopes: [], revoked: true });
    // the warrant arm: narrowing the scope ceiling with narrowAgents narrows its live Agents too
    const next = await mintAgent(connector, warrant, task, ['tasks:read']);
    const warrantNarrowed = await edit(ROOT, 'warrant', warrant, { ceilingScopes: ['phases:read'], narrowAgents: true });
    expect([warrantNarrowed.status, warrantNarrowed.json?.edit?.revokedAgents?.map((a: any) => a.credentialId).sort()])
      .toEqual([200, [both.credentialId, next.credentialId].sort()]);
  });

  it('N-3: a narrowed Agent\'s next call is refused naming the removed scope', async () => {
    const connector = await registerConnector(ROOT, [...BASE_SCOPES, 'phases:read'], 'any');
    const task = await taskIn(ROOT, ROOT_PROJECT);
    const warrant = await warrantFor(connector, task, { ceilingScopes: ['tasks:read', 'phases:read'] });
    const agent = await mintAgent(connector, warrant, task, ['tasks:read', 'phases:read']);
    expect((await call(agent, 'GET', `/phases?projectId=${ROOT_PROJECT}`)).status).toBe(200);
    expect((await edit(ROOT, 'credential', connector.credentialId, { scopes: BASE_SCOPES, narrowAgents: true })).status).toBe(200);
    expect(namesScope(await call(agent, 'GET', `/phases?projectId=${ROOT_PROJECT}`), 'phases:read')).toBe(true);
  });

  it('N-4: a failed Agent write rolls the whole narrowing back', async () => {
    const connector = await registerConnector(ROOT, [...BASE_SCOPES, 'phases:read'], 'any');
    const task = await taskIn(ROOT, ROOT_PROJECT);
    const warrant = await warrantFor(connector, task, { ceilingScopes: ['tasks:read', 'phases:read'] });
    const agent = await mintAgent(connector, warrant, task, ['tasks:read', 'phases:read']);
    await pool.query(`CREATE OR REPLACE FUNCTION az13_drill_fail_agent_write() RETURNS trigger AS $$
      BEGIN IF NEW.id = '${agent.credentialId}'::uuid THEN RAISE EXCEPTION 'drill: the Agent write fails'; END IF; RETURN NEW; END;
      $$ LANGUAGE plpgsql`);
    await pool.query(`CREATE TRIGGER az13_drill_fail_agent_write BEFORE UPDATE OF scopes ON principal_credentials
      FOR EACH ROW EXECUTE FUNCTION az13_drill_fail_agent_write()`);
    try {
      const failed = await edit(ROOT, 'credential', connector.credentialId, { scopes: BASE_SCOPES, narrowAgents: true });
      expect(failed.status).toBe(500);
    } finally {
      await pool.query('DROP TRIGGER IF EXISTS az13_drill_fail_agent_write ON principal_credentials');
      await pool.query('DROP FUNCTION IF EXISTS az13_drill_fail_agent_write()');
    }
    expect(sorted(await scopesOf(connector.credentialId))).toEqual(sorted([...BASE_SCOPES, 'phases:read']));
    expect(sorted(await scopesOf(agent.credentialId))).toEqual(sorted(['tasks:read', 'phases:read']));
    expect((await edits(connector.credentialId)).length).toBe(0);
  });
});

// ─────────────────────────── (W) warrants ──────────────────────────────────

describe('(W) a warrant edited in place (clause 10)', () => {
  it('R-2 (warrant): the owning Account narrows the caps: one audit row and one warrant.amended event; the next mint above the new cap is WARRANT_CAP_EXHAUSTED', async () => {
    const connector = await registerConnector(OWNER, [...BASE_SCOPES, 'phases:read'], 'any');
    const task = await taskIn(OWNER, OWNER_PROJECT);
    const warrant = await warrantFor(connector, task, { maxTotal: 10, maxConcurrent: 10, ceilingScopes: ['tasks:read'] });
    await mintAgent(connector, warrant, task, ['tasks:read']);
    const narrowed = await edit(OWNER, 'warrant', warrant, { maxTotal: 1 });
    expect([narrowed.status, narrowed.json?.edit?.direction, narrowed.json?.edit?.changed]).toEqual([200, 'narrowing', ['maxTotal']]);
    expect((await edits(warrant)).length).toBe(1);
    const amended = await pool.query(`SELECT metadata FROM warrant_events WHERE warrant_id = $1 AND action = 'warrant.amended'`, [warrant]);
    expect(amended.rows.length).toBe(1);
    expect(amended.rows[0].metadata).toMatchObject({ before: { maxTotal: 10 }, after: { maxTotal: 1 }, direction: 'narrowing' });
    const over = await call(connector, 'POST', '/delegation/agent-mints', {
      targetTaskId: task, via: 'warrant', warrantId: warrant, requestedScopes: ['tasks:read'], requestedRules: [],
    });
    expect([over.status, over.json?.code]).toEqual([409, 'WARRANT_CAP_EXHAUSTED']);
  });

  it('clause 10b: a root widening given as ceilingRules publishes a NEW profile and pins it; the old version is unchanged; republishing the old profile does not widen the warrant', async () => {
    const connector = await registerConnector(ROOT, BASE_SCOPES, 'any');
    const task = await taskIn(ROOT, ROOT_PROJECT);
    const other = await taskIn(ROOT, ROOT_PROJECT);
    const warrant = await warrantFor(connector, task);
    const oldVersion = (await pool.query('SELECT ceiling_profile_version_id FROM warrants WHERE id = $1', [warrant])).rows[0].ceiling_profile_version_id;
    const oldRules = (await pool.query('SELECT selector_ids FROM access_profile_rules WHERE version_id = $1', [oldVersion])).rows;
    const widened = await widen(ROOT, 'warrant', warrant,
      { ceilingRules: [{ resourceType: 'task', selectorForm: 'exact', selectorIds: [task, other], verbs: ['read', 'write'] }] },
      { choice: 'until-task', taskId: task });
    expect([widened.status, widened.json?.edit?.changed]).toEqual([200, ['ceiling']]);
    const newVersion = (await pool.query('SELECT ceiling_profile_version_id FROM warrants WHERE id = $1', [warrant])).rows[0].ceiling_profile_version_id;
    expect(newVersion).not.toBe(oldVersion);
    expect((await pool.query('SELECT selector_ids FROM access_profile_rules WHERE version_id = $1', [oldVersion])).rows).toEqual(oldRules);
    expect(widened.json.edit.before.ceilingProfileVersionId).toBe(oldVersion);
    expect(widened.json.edit.after.ceilingProfileVersionId).toBe(newVersion);
    const profile = (await pool.query('SELECT profile_id FROM access_profile_versions WHERE id = $1', [oldVersion])).rows[0].profile_id;
    const description = (await pool.query('SELECT description FROM access_profiles WHERE id = $1', [profile])).rows[0].description;
    expect(description).not.toContain('Edit by creating a new warrant');
    expect((await pool.query('SELECT ceiling_profile_version_id FROM warrants WHERE id = $1', [warrant])).rows[0].ceiling_profile_version_id).toBe(newVersion);
  });

  it('clause 10c / Q2: a ceiling edit while tasks ride is WARRANT_HAS_DEPENDENT_TASKS without acknowledgement, and releases them with it', async () => {
    const connector = await registerConnector(ROOT, BASE_SCOPES, 'any');
    const task = await taskIn(ROOT, ROOT_PROJECT);
    const rider = await taskIn(ROOT, ROOT_PROJECT);
    const warrant = await warrantFor(connector, task);
    await ride(rider, connector, warrant);
    const rules = [{ resourceType: 'task', selectorForm: 'exact', selectorIds: [task], verbs: ['read'] }];
    const refused = await edit(ROOT, 'warrant', warrant, { ceilingRules: rules });
    expect([refused.status, refused.json?.code, refused.json?.dependentCount]).toEqual([409, 'WARRANT_HAS_DEPENDENT_TASKS', 1]);
    const released = await edit(ROOT, 'warrant', warrant, { ceilingRules: rules, acknowledgeDependents: true });
    expect([released.status, released.json?.edit?.direction, released.json?.edit?.releasedTaskIds]).toEqual([200, 'narrowing', [rider]]);
    expect((await pool.query('SELECT execution_warrant_id FROM tasks WHERE id = $1', [rider])).rows[0].execution_warrant_id).toBeNull();
    const caps = await edit(ROOT, 'warrant', warrant, { maxTotal: 3 });
    expect([caps.status, caps.json?.edit?.releasedTaskIds]).toEqual([200, []]);
  });

  it('clause 10d: a suspended warrant may be edited and stays suspended; a revoked one is WARRANT_NOT_EDITABLE; holder, anchors, agentMaxAgeHours and status stay WARRANT_AUTHORITY_IMMUTABLE', async () => {
    const connector = await registerConnector(ROOT, BASE_SCOPES, 'any');
    const task = await taskIn(ROOT, ROOT_PROJECT);
    const warrant = await warrantFor(connector, task, { maxTotal: 10 });
    await pool.query(`UPDATE warrants SET status = 'suspended', suspended_reason = 'drill', suspended_at = NOW() WHERE id = $1`, [warrant]);
    const edited = await edit(ROOT, 'warrant', warrant, { maxTotal: 5 });
    expect(edited.status).toBe(200);
    expect((await pool.query('SELECT status FROM warrants WHERE id = $1', [warrant])).rows[0].status).toBe('suspended');
    for (const field of ['holderPrincipalId', 'anchors', 'agentMaxAgeHours', 'status']) {
      const refused = await edit(ROOT, 'warrant', warrant, { [field]: field === 'anchors' ? [] : field === 'agentMaxAgeHours' ? 4 : 'x' });
      expect([refused.status, refused.json?.code]).toEqual([422, 'WARRANT_AUTHORITY_IMMUTABLE']);
    }
    await call(ROOT, 'POST', `/warrants/${warrant}/revoke`, { acknowledgeDependents: true });
    const dead = await edit(ROOT, 'warrant', warrant, { maxTotal: 4 });
    expect([dead.status, dead.json?.code]).toEqual([409, 'WARRANT_NOT_EDITABLE']);
  });

  it('clause 8b: a widening above a non-administrator creator\'s authority is CEILING_EXCEEDS_CREATOR', async () => {
    const creator = await sessionFor('creator', await makeAccount('editor', 'creator'));
    const connector = await registerConnector(creator, BASE_SCOPES, 'any');
    const task = await taskIn(ROOT, ROOT_PROJECT);
    const grant = await call(ROOT, 'POST', '/grants', { granteeId: creator.principalId, resourceType: 'task', resourceId: task, verb: 'read' });
    expect(grant.status).toBe(201);
    const created = await call(creator, 'POST', '/warrants', {
      name: `AZ-A13 creator ${tag()}`, holderPrincipalId: connector.principalId,
      anchors: [{ anchorType: 'task', anchorId: task }],
      ceilingRules: [{ resourceType: 'task', selectorForm: 'exact', selectorIds: [task], verbs: ['read'] }],
      stepUpToken: await stepUp(creator, 'warrant.create', connector.principalId),
    });
    expect(created.status).toBe(201);
    const widened = await widen(ROOT, 'warrant', created.json.warrant.id,
      { ceilingRules: [{ resourceType: 'task', selectorForm: 'exact', selectorIds: [task], verbs: ['read', 'write'] }] });
    expect([widened.status, widened.json?.code]).toEqual([403, 'CEILING_EXCEEDS_CREATOR']);
  });

  it('O-1: a Group member gives its agent\'s warrant a project it reaches through the Group (allowed, with step-up) and one it cannot reach (EXCEEDS_ACCOUNT_AUTHORITY)', async () => {
    const member = await sessionFor('member', await makeAccount('editor', 'member'));
    const group = await call(ROOT, 'POST', '/groups', { name: `AZ-A13 group ${tag()}` });
    expect(group.status).toBe(201);
    const groupId = String(group.json.group.id);
    expect((await call(ROOT, 'POST', `/groups/${groupId}/members`, { accountPrincipalId: member.principalId })).status).toBeLessThan(300);
    const reached = await call(ROOT, 'POST', '/projects', { name: `AZ-A13 reached ${tag()}` });
    const unreached = await call(ROOT, 'POST', '/projects', { name: `AZ-A13 unreached ${tag()}` });
    const reachedId = String(reached.json.project.id);
    for (const verb of ['read', 'write']) {
      expect((await call(ROOT, 'POST', '/grants', { granteeType: 'group', granteeId: groupId, resourceType: 'project', resourceId: reachedId, verb })).status).toBe(201);
    }
    const connector = await registerConnector(member, BASE_SCOPES, 'any');
    const task = await taskIn(ROOT, reachedId);
    const warrant = await warrantFor(connector, task, {
      ceilingRules: [{ resourceType: 'project', selectorForm: 'exact', selectorIds: [reachedId], verbs: ['read'] }],
    });
    const allowed = await widen(member, 'warrant', warrant,
      { ceilingRules: [{ resourceType: 'project', selectorForm: 'exact', selectorIds: [reachedId], verbs: ['read', 'write'] }] });
    expect([allowed.status, allowed.json?.edit?.direction]).toEqual([200, 'widening']);
    expect((await firstEdit(warrant)).metadata.deciderStanding).toBe('owning-account');
    const refused = await widen(member, 'warrant', warrant, {
      ceilingRules: [{ resourceType: 'project', selectorForm: 'exact', selectorIds: [reachedId, String(unreached.json.project.id)], verbs: ['read', 'write'] }],
    });
    expect([refused.status, refused.json?.code, refused.json?.subject]).toEqual([403, 'EXCEEDS_ACCOUNT_AUTHORITY', 'editor']);
    expect((await editApprovals(warrant)).length).toBe(1);
  });

  // ── review 1a38270d round 1, B2: every refusal of a warrant edit act writes
  // a durable denied audit with the chain, the 404 concealments included.

  it('clause 13 (r1 B2 i): a stranger\'s narrowing, and its widening carrying a valid warrant.edit step-up, on PATCH /warrants/:id are answered 404 and each writes a denied warrant.edit row with the chain; the step-up is unspent', async () => {
    const connector = await registerConnector(OWNER, BASE_SCOPES, 'any');
    const task = await taskIn(OWNER, OWNER_PROJECT);
    const warrant = await warrantFor(connector, task, { maxTotal: 10 });
    const narrowing = await edit(STRANGER, 'warrant', warrant, { maxTotal: 5 });
    expect([narrowing.status, narrowing.json?.code]).toEqual([404, 'WARRANT_NOT_FOUND']);
    const widening = await edit(STRANGER, 'warrant', warrant,
      { maxTotal: 20, lifetime: KEEP, stepUpToken: await stepUp(STRANGER, 'warrant.edit', warrant) });
    expect([widening.status, widening.json?.code]).toEqual([404, 'WARRANT_NOT_FOUND']);
    const denied = (await edits(warrant, 'denied')).filter((r) => r.actor_principal_id === STRANGER.principalId).map((r) => parseJson(r.metadata));
    expect(denied.map((m) => [m.refusal, m.answeredAs, m.clause, m.subject])).toEqual([
      ['AUTHORITY_EDIT_REQUIRES_ADMINISTRATOR', 'WARRANT_NOT_FOUND', 'AZ-A13 clause 4a', 'editor'],
      ['AUTHORITY_EDIT_REQUIRES_ADMINISTRATOR', 'WARRANT_NOT_FOUND', 'AZ-A13 clause 4a', 'editor'],
    ]);
    expect(denied.map((m) => m.chain?.[0]?.principalId)).toEqual([STRANGER.principalId, STRANGER.principalId]);
    expect((await warrantRow(warrant)).max_total).toBe(10);
    expect(await stepUpSpent(STRANGER, 'warrant.edit', warrant)).toEqual([false]);
  });

  it('clause 13 (r1 B2 ii): WARRANT_AUTHORITY_IMMUTABLE carries rule, subject and clause and writes a denied warrant.edit row with the chain; a stranger\'s attempt is answered 404 and audited too', async () => {
    const connector = await registerConnector(OWNER, BASE_SCOPES, 'any');
    const task = await taskIn(OWNER, OWNER_PROJECT);
    const warrant = await warrantFor(connector, task);
    const refused = await edit(OWNER, 'warrant', warrant, { status: 'revoked' });
    expect([refused.status, refused.json?.error, refused.json?.code, refused.json?.subject, refused.json?.clause, typeof refused.json?.rule])
      .toEqual([422, 'Refused', 'WARRANT_AUTHORITY_IMMUTABLE', 'editor', 'AZ-A13 clause 10a', 'string']);
    const foreign = await edit(STRANGER, 'warrant', warrant, { holderPrincipalId: STRANGER.principalId });
    expect([foreign.status, foreign.json?.code]).toEqual([404, 'WARRANT_NOT_FOUND']);
    const denied = (await edits(warrant, 'denied')).map((r) => parseJson(r.metadata));
    expect(denied.map((m) => [m.refusal, m.answeredAs ?? null, m.fields, m.chain?.[0]?.principalId])).toEqual([
      ['WARRANT_AUTHORITY_IMMUTABLE', null, ['status'], OWNER.principalId],
      ['WARRANT_AUTHORITY_IMMUTABLE', 'WARRANT_NOT_FOUND', ['holderPrincipalId'], STRANGER.principalId],
    ]);
    expect((await warrantRow(warrant)).status).toBe('active');
  });

  it('clause 13 (r1 B2): an edit of a warrant id that does not exist is answered 404 and writes a denied warrant.edit row', async () => {
    const ghost = crypto.randomUUID();
    const answered = await edit(STRANGER, 'warrant', ghost, { maxTotal: 1 });
    expect([answered.status, answered.json?.code]).toEqual([404, 'WARRANT_NOT_FOUND']);
    expect((await edits(ghost, 'denied')).map((r) => [parseJson(r.metadata).refusal, r.actor_principal_id]))
      .toEqual([['WARRANT_NOT_FOUND', STRANGER.principalId]]);
  });
});

// ─────────────────────────── (G) grants ────────────────────────────────────

describe('(G) a grant row edited in place (clause 11)', () => {
  it('R-2 (grant): root narrows write to read at once; the row keeps its id; the next write through it is refused', async () => {
    const holder = await sessionFor('holder', await makeAccount('editor', 'holder'));
    const task = await taskIn(ROOT, ROOT_PROJECT);
    const grant = await call(ROOT, 'POST', '/grants', { granteeId: holder.principalId, resourceType: 'task', resourceId: task, verb: 'write' });
    const id = String(grant.json.grant.id);
    expect((await call(holder, 'PATCH', `/tasks/${task}`, { description: 'written through the grant' })).status).toBe(200);
    const narrowed = await edit(ROOT, 'grant', id, { verb: 'read' });
    expect([narrowed.status, narrowed.json?.edit?.direction]).toEqual([200, 'narrowing']);
    expect((await pool.query('SELECT id, verb FROM grants WHERE id = $1', [id])).rows[0]).toEqual({ id, verb: 'read' });
    expect((await call(holder, 'PATCH', `/tasks/${task}`, { description: 'refused now' })).status).toBe(403);
    expect((await call(holder, 'GET', `/tasks/${task}`)).status).toBe(200);
    expect((await firstEdit(id)).metadata).toMatchObject({ before: { verb: 'write' }, after: { verb: 'read' }, deciderStanding: 'root' });
  });

  it('clause 11b/11f: a grant widening needs a step-up bound to grant.edit; moving the selector emits acl_changed for both objects', async () => {
    const holder = await sessionFor('holder2', await makeAccount('editor', 'holder2'));
    const first = await taskIn(ROOT, ROOT_PROJECT);
    const second = await taskIn(ROOT, ROOT_PROJECT);
    const grant = await call(ROOT, 'POST', '/grants', { granteeId: holder.principalId, resourceType: 'task', resourceId: first, verb: 'read' });
    const id = String(grant.json.grant.id);
    const noStepUp = await edit(ROOT, 'grant', id, { resourceId: second, lifetime: KEEP });
    expect([noStepUp.status, noStepUp.json?.code]).toEqual([403, 'STEP_UP_REQUIRED']);
    // Only what the EDIT emitted: creating the grant already announced `first`.
    const editStart = (await pool.query('SELECT clock_timestamp() AS at')).rows[0].at;
    const moved = await widen(ROOT, 'grant', id, { resourceId: second });
    expect([moved.status, moved.json?.edit?.direction]).toEqual([200, 'widening']);
    const feed = await pool.query(
      `SELECT object_id FROM feed_events WHERE name = 'task.acl_changed' AND object_id = ANY($1::uuid[]) AND occurred_at >= $2`,
      [[first, second], editStart]);
    expect(new Set(feed.rows.map((row: any) => String(row.object_id)))).toEqual(new Set([first, second]));
    expect(classifyGrant({ verb: 'read', expiresAt: null, resourceId: first }, { verb: 'read', expiresAt: null, resourceId: null }).direction).toBe('widening');
    expect(classifyGrant({ verb: 'admin', expiresAt: null, resourceId: first }, { verb: 'write', expiresAt: null, resourceId: first }).direction).toBe('narrowing');
    expect(classifyGrant({ verb: 'use', expiresAt: null, resourceId: first }, { verb: 'invoke', expiresAt: null, resourceId: first }).direction).toBe('widening');
  });

  it('clause 11e: GRANT_EXISTS names the live twin, and an expired identical row is replaced in the same act', async () => {
    const holder = await sessionFor('holder3', await makeAccount('editor', 'holder3'));
    const task = await taskIn(ROOT, ROOT_PROJECT);
    const read = await call(ROOT, 'POST', '/grants', { granteeId: holder.principalId, resourceType: 'task', resourceId: task, verb: 'read' });
    const write = await call(ROOT, 'POST', '/grants', { granteeId: holder.principalId, resourceType: 'task', resourceId: task, verb: 'write' });
    const clash = await edit(ROOT, 'grant', read.json.grant.id, { verb: 'write', lifetime: KEEP, stepUpToken: await stepUp(ROOT, 'grant.edit', read.json.grant.id) });
    expect([clash.status, clash.json?.code, clash.json?.existingGrantId]).toEqual([409, 'GRANT_EXISTS', write.json.grant.id]);
    expect((await pool.query('SELECT verb FROM grants WHERE id = $1', [read.json.grant.id])).rows[0].verb).toBe('read');
    await pool.query(`UPDATE grants SET expires_at = NOW() - INTERVAL '1 hour' WHERE id = $1`, [write.json.grant.id]);
    const replaced = await widen(ROOT, 'grant', read.json.grant.id, { verb: 'write' });
    expect(replaced.status).toBe(200);
    expect((await pool.query('SELECT COUNT(*)::int AS n FROM grants WHERE id = $1', [write.json.grant.id])).rows[0].n).toBe(0);
  });

  it('clause 11c: an assignment-carried row and a creation-default row are refused by name', async () => {
    const holder = await sessionFor('holder5', await makeAccount('editor', 'holder5'));
    const task = await taskIn(ROOT, ROOT_PROJECT);
    const read = await call(ROOT, 'POST', '/grants', { granteeId: holder.principalId, resourceType: 'task', resourceId: task, verb: 'read' });
    await pool.query(`UPDATE grants SET provenance = 'assignment:grant' WHERE id = $1`, [read.json.grant.id]);
    expect((await edit(ROOT, 'grant', read.json.grant.id, { verb: 'read' })).json?.code).toBe('GRANT_CARRIES_ASSIGNMENT');
    await pool.query(`UPDATE grants SET provenance = NULL WHERE id = $1`, [read.json.grant.id]);
    const defaults = await pool.query(`SELECT id FROM grants WHERE origin = 'creation-default' LIMIT 1`);
    if (defaults.rows.length > 0) {
      expect((await edit(ROOT, 'grant', String(defaults.rows[0].id), { verb: 'read' })).json?.code).toBe('GRANT_ORIGIN_NOT_EDITABLE');
    } else {
      const group = await call(ROOT, 'POST', '/groups', { name: `AZ-A13 origin ${tag()}` });
      const made = await pool.query(
        `INSERT INTO grants (grantee_type, grantee_id, resource_type, resource_id, verb, origin) VALUES ('group', $1, 'project', $2, 'read', 'creation-default') RETURNING id`,
        [group.json.group.id, ROOT_PROJECT]);
      expect((await edit(ROOT, 'grant', String(made.rows[0].id), { verb: 'write' })).json?.code).toBe('GRANT_ORIGIN_NOT_EDITABLE');
    }
  });

  it('clause 11d: an approval-made row keeps an expiry capped at 90 days, and is still revoked at its task\'s terminal; an operator is refused at the root ceiling; the surface closure re-applies', async () => {
    const connector = await registerConnector(OWNER, BASE_SCOPES, 'any');
    const related = await taskIn(OWNER, OWNER_PROJECT);
    const filed = await call(connector, 'POST', '/delegation/access-requests', {
      kind: 'grant', reason: REASON, relatedTaskId: related, requestedExpiresAt: inDays(10),
      requestedRules: [{ resourceType: 'project', selectorForm: 'exact', selectorIds: [ROOT_PROJECT], verbs: ['read'] }],
    });
    expect(filed.status).toBe(202);
    expect((await decide(ROOT, filed.json.approval.id, 'approve')).status).toBe(200);
    const row = (await pool.query('SELECT id FROM grants WHERE approval_id = $1', [filed.json.approval.id])).rows[0];
    const id = String(row.id);
    const tooLong = await widen(ROOT, 'grant', id, { expiresAt: inDays(120) });
    expect([tooLong.status, tooLong.json?.code]).toEqual([422, 'EXPIRY_TOO_LONG']);
    const forever = await widen(ROOT, 'grant', id, { expiresAt: null });
    expect([forever.status, forever.json?.code]).toEqual([422, 'EXPIRY_REQUIRED']);
    expect((await widen(ROOT, 'grant', id, { expiresAt: inDays(60) })).status).toBe(200);
    expect((await edit(OPERATOR, 'grant', id, { expiresAt: inDays(20) })).status).toBe(403);
    expect((await call(OWNER, 'PATCH', `/tasks/${related}`, { status: 'completed' })).status).toBe(200);
    expect((await pool.query('SELECT COUNT(*)::int AS n FROM grants WHERE id = $1', [id])).rows[0].n).toBe(0);
    const surface = (await pool.query(`SELECT id FROM access_surfaces WHERE key = 'settings.access-grants'`)).rows[0];
    const holder = await sessionFor('holder4', await makeAccount('editor', 'holder4'));
    const plain = (await pool.query(`SELECT id FROM access_surfaces WHERE key = 'settings.appearance'`)).rows[0];
    if (plain) {
      const made = await call(ROOT, 'POST', '/grants', { granteeId: holder.principalId, resourceType: 'surface', resourceId: plain.id, verb: 'read' });
      expect(made.status).toBe(201);
      const moved = await widen(ROOT, 'grant', made.json.grant.id, { resourceId: surface.id });
      expect([moved.status, moved.json?.code]).toEqual([422, 'AUTHORITY_MUTATION_SURFACE']);
    }
  });
});

// ─────────────────────────── (R) the secret is never recorded ─────────────

describe('(R) R-4: the secret is never in a record', () => {
  it('R-4: no token and no secret suffix in any audit, approval or warrant event metadata, any approvals JSON column, the server log or an edit response; an edited credential reveals the same token', async () => {
    const connector = await registerConnector(OWNER, BASE_SCOPES, 'any');
    const before = await credentialRow(connector.credentialId);
    expect((await widen(OWNER, 'credential', connector.credentialId, { scopes: [...BASE_SCOPES, 'phases:read'] })).status).toBe(200);
    expect((await edit(OWNER, 'credential', connector.credentialId, { scopes: BASE_SCOPES })).status).toBe(200);
    const after = await credentialRow(connector.credentialId);
    expect([after.secret_hash, Buffer.from(after.secret_ciphertext ?? '').toString('hex')])
      .toEqual([before.secret_hash, Buffer.from(before.secret_ciphertext ?? '').toString('hex')]);
    const revealed = await call(OWNER, 'POST', `/credentials/${connector.credentialId}/reveal`,
      { stepUpToken: await stepUp(OWNER, 'credential.reveal', connector.credentialId) });
    expect([revealed.status, revealed.json?.token]).toEqual([200, connector.secret]);

    const TOKEN = /rh_[a-z0-9]+_[A-Za-z0-9]{12}\./;
    const suffixes = SECRETS.map((secret) => secret.split('.').pop() as string).filter((suffix) => suffix.length >= 16);
    const dump = [
      ...(await pool.query(`SELECT metadata::text AS t FROM audit_events WHERE occurred_at >= $1`, [SUITE_START])).rows.map((r: any) => r.t),
      ...(await pool.query(`SELECT metadata::text AS t FROM approval_events WHERE occurred_at >= $1`, [SUITE_START])).rows.map((r: any) => r.t),
      ...(await pool.query(`SELECT metadata::text AS t FROM warrant_events WHERE occurred_at >= $1`, [SUITE_START])).rows.map((r: any) => r.t),
      ...(await pool.query(
        `SELECT concat_ws(' ', session_evidence::text, edit_before::text, edit_requested::text, edit_approved::text,
                decision_step_up::text, requested_scopes::text, approved_scopes::text) AS t
           FROM approvals WHERE requested_at >= $1`, [SUITE_START])).rows.map((r: any) => r.t),
      ...CONSOLE_LINES,
      ...RESPONSES,
    ].join('\n');
    expect(dump.match(TOKEN)).toBeNull();
    expect(suffixes.length).toBeGreaterThan(5);
    expect(suffixes.filter((suffix) => dump.includes(suffix))).toEqual([]);
  });
});
