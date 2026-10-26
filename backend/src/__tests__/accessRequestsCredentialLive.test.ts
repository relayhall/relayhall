/**
 * Card 785e1eed P1-B-2: AZ-A9 "Credential requests" (ratified 2026-10-10, E43),
 * kind `credential` (clause 13), over a REAL PostgreSQL and the PRODUCTION
 * router and MCP ingress.
 *
 * A Connector FILES a request for ONE credential on itself carrying scopes it
 * lacks, on the bearer route `POST /delegation/access-requests` (clause 9) or
 * the tool `relayhall_access_request` (clause 10). Root or an administrator
 * login session DECIDES it on `/approvals` under step-up, possibly narrowed;
 * approval records the authorization only. The SAME credential COLLECTS it
 * within 24 hours and receives the secret once; the board issues it through
 * `executeConnectorCredentialIssue`, capped by the DECIDER's authority, and
 * clause 12a revokes it at the related task's or phase's terminal. Every number
 * below is measured on the rows the board wrote, and the new key is USED.
 *
 *   (1) filing: one pending Approval of kind credential, the requester its
 *       target, its own pin by default, nothing issued;
 *   (2) filing refusals by name {code, rule, subject, clause} with a durable
 *       audit: root, *:admin, an unknown or inert scope, ALREADY_HELD naming
 *       the covering credential, an Agent requester, another target, bundled
 *       rows, a bad pin or label, a requester in rotation grace (not live),
 *       the quota shared with grant requests, an unreadable related task;
 *   (3) who decides: SESSION_ONLY, the non-administrator owner refused without
 *       spending its step-up, a stranger 404, no step-up refused;
 *   (4) narrowing: every widening refused EDIT_ONLY_NARROWS; dropped scopes, a
 *       shorter expiry and a narrower pin are what is stored; the database
 *       refuses a widened approval written behind the service;
 *   (5) approve issues nothing;
 *   (6) collect: another credential is answered as absent; the requesting one
 *       receives the secret once; the new key works where the old one is
 *       refused; the old key stays live; a repeat is refused;
 *   (7) the secret is in no row, event, audit row or log line;
 *   (8) TTLs: pending 7 days, collect 24 hours, the requested expiry (sweep);
 *   (9) clause 12a: the task and phase terminals revoke the issued credential
 *       and lapse what waits; reopening restores nothing; AZ-31c rotation;
 *  (10) what the decider sees; (11) what the requester sees (E49);
 *  (12) the decider's ceiling: a forged row, a decider that lost standing, and
 *       the executor's own ceiling (the edit-in-place entry point, card
 *       3c2db4b7 — a direct call BY DESIGN: that lane has no route yet);
 *  (13) the MCP tool end to end.
 *
 * DESTRUCTIVE: writes principals, credentials, services, approvals, projects,
 * phases, tasks, step-up tokens and audit rows. It refuses any deployment
 * database and any non-local host, and FAILS - never skips - without a
 * disposable one.
 */

/* eslint-disable @typescript-eslint/no-var-requires */

import http from 'http';
import crypto from 'crypto';

const TEST_DB_URL = process.env.RELAYHALL_TEST_DB_URL;
if (!TEST_DB_URL) {
  throw new Error('RELAYHALL_TEST_DB_URL is required: the credential-request drill measures stored approval, credential, '
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
  throw new Error('Credential-request drill refuses a non-disposable database target');
}

Object.assign(process.env, {
  DB_HOST: parsed.hostname, DB_PORT: parsed.port || '5432', DB_NAME: TEST_DB_NAME,
  DB_USER: decodeURIComponent(parsed.username), DB_PASSWORD: decodeURIComponent(parsed.password),
  NODE_ENV: 'test', RELAYHALL_SESSIONS: 'on', JWT_SECRET: crypto.randomBytes(32).toString('hex'),
});

// Every console line the process writes, so (7) can prove the secret is in none.
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
const { approvalService } = require('../services/ApprovalService');
const { invalidateApprovalsForCredentials } = require('../utils/approvalInvalidation');
const { notificationEndpointService } = require('../services/NotificationEndpointService');
const { executeConnectorCredentialIssue } = require('../services/ConnectorCredentialIssuance');
const { scopesForRole } = require('../utils/identityScopes');
const mcpRoutes = require('../mcp/httpRoute').default;
const { MCP_ROUTE_PATH } = require('../mcp/httpRoute');

jest.setTimeout(180_000);

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
interface Bearer extends Caller { credentialId: string; scopes: string[]; secret: string }
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
const key = (label: string): string => `p1b2-${label}-${crypto.randomUUID()}`;
const parseJson = (value: unknown): any => (typeof value === 'string' ? JSON.parse(value) : value);
const DAY = 24 * 60 * 60 * 1000;
const inDays = (days: number): string => new Date(Date.now() + days * DAY).toISOString();
const REASON = 'P1-B-2 drill: the run must open and edit phases to finish the release handover.';
const FOUR_SCOPES = ['tasks:read', 'tasks:write', 'reports:read', 'reports:write'];
const SYSTEM = { handle: 'p1b2-drill', authMethod: 'system' };

async function makeAccount(role: string, label = 'acct'): Promise<string> {
  const result = await pool.query(
    `INSERT INTO principals (kind, handle, display_name, status, role)
     VALUES ('human', $1, $1, 'active', $2) RETURNING id`,
    [`p1b2-${label}-${tag()}`, role],
  );
  return String(result.rows[0].id);
}

async function sessionFor(label: string, principalId: string): Promise<Caller> {
  const minted = await loginSessionService.mint({ principalId });
  return { label, principalId, headers: { Cookie: `${SESSION_COOKIE_NAME}=${minted.token}` } };
}

function bearer(label: string, principalId: string, credentialId: string, scopes: string[], secret: string): Bearer {
  return { label, principalId, credentialId, scopes, secret, headers: { Authorization: `Bearer ${secret}` } };
}

/** A Connector registered through the owner's wizard path. */
async function registerConnector(owner: Caller, scopes: string[] = FOUR_SCOPES, transport: 'api' | 'any' = 'api'): Promise<Bearer> {
  const slug = `p1b2-connector-${tag()}`;
  const registered = await call(owner, 'POST', '/services', {
    slug, name: slug, description: 'Credential-request drill connector.', kind: 'connector',
    issueCredential: { scopes, label: slug, transport },
  });
  expect(registered.status).toBe(201);
  const row = await pool.query('SELECT principal_id FROM services WHERE slug = $1', [slug]);
  return bearer(slug, String(row.rows[0].principal_id), String(registered.json.onboarding.credential.credentialId),
    scopes, String(registered.json.onboarding.credential.secretOnce));
}

type Filed = { ok: true; record: any } | { ok: false; status: number; code: string; body: any };

/** FILE a credential request as `who` through the BEARER route (clause 9). */
async function file(who: Bearer, body: Record<string, unknown>): Promise<Filed> {
  const answered = await call(who, 'POST', '/delegation/access-requests', { kind: 'credential', reason: REASON, ...body });
  if (answered.status === 202) {
    expect(answered.json?.success).toBe(true);
    return { ok: true, record: answered.json.approval };
  }
  if (!answered.json?.code) throw new Error(`filing answered ${answered.status} without a code: ${answered.text}`);
  return { ok: false, status: answered.status, code: String(answered.json.code), body: answered.json };
}

async function fileOk(who: Bearer, body: Record<string, unknown>): Promise<any> {
  const filed = await file(who, body);
  if (!filed.ok) throw new Error(`expected the filing to succeed, got ${filed.code}: ${JSON.stringify(filed.body)}`);
  return filed.record;
}

async function decide(decider: Caller, approvalId: string, decision: 'approve' | 'deny', body: Record<string, unknown> = {}): Promise<Answer> {
  const stepUp = await stepUpService.mint(decider.principalId, 'approval.decide', approvalId, 'password');
  return call(decider, 'POST', `/approvals/${approvalId}/${decision}`, { stepUpToken: stepUp.token, ...body });
}

async function collect(who: Bearer, approvalId: string): Promise<Answer> {
  return call(who, 'POST', `/delegation/access-requests/${approvalId}/collect`, {});
}

async function approvalRow(id: string): Promise<any> {
  return (await pool.query('SELECT * FROM approvals WHERE id = $1', [id])).rows[0];
}

async function credentialRow(id: string): Promise<any> {
  return (await pool.query('SELECT * FROM principal_credentials WHERE id = $1', [id])).rows[0];
}

async function credentialCount(principalId: string): Promise<number> {
  return (await pool.query('SELECT COUNT(*)::int AS n FROM principal_credentials WHERE principal_id = $1', [principalId])).rows[0].n;
}

async function events(approvalId: string, action: string): Promise<any[]> {
  return (await pool.query('SELECT * FROM approval_events WHERE approval_id = $1 AND action = $2 ORDER BY occurred_at', [approvalId, action])).rows;
}

async function createsPhase(who: Caller): Promise<number> {
  return (await call(who, 'POST', '/phases', { projectId: PROJECT_ID, name: `P1-B-2 phase ${tag()}` },
    { 'Idempotency-Key': key('phase') })).status;
}

let OWNER: Caller;          // Account A: an ordinary owner, role user
let OTHER: Caller;          // Account B
let STRANGER: Caller;       // an unrelated ordinary Account
let OPERATOR: Caller;       // an administrator Account (role operator) — not root
let ROOT: Caller;           // role admin: derives root
let PROJECT_ID: string;

async function ownerTask(owner: Caller, title: string, project?: string): Promise<string> {
  const created = await call(owner, 'POST', '/tasks', {
    title, description: 'credential-request drill', status: 'todo', ...(project ? { project } : {}),
  });
  expect(created.status).toBe(201);
  return String(created.json?.task?.id);
}

/** A pending request, approved by `decider` (narrowed by `edits`), ready to collect. */
async function approvedRequest(connector: Bearer, decider: Caller, related: Record<string, unknown>, edits: Record<string, unknown> = {},
  body: Record<string, unknown> = {}): Promise<any> {
  const filed = await fileOk(connector, { requestedScopes: ['phases:read', 'phases:write'], ...related, ...body });
  const answered = await decide(decider, filed.id, 'approve', edits);
  expect([answered.status, answered.json?.approval?.status]).toEqual([200, 'approved']);
  return filed;
}

beforeAll(async () => {
  await new Promise<void>((resolve) => { server = buildApp().listen(0, '127.0.0.1', resolve); });
  origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  OWNER = await sessionFor('owner', await makeAccount('user', 'owner'));
  OTHER = await sessionFor('other', await makeAccount('user', 'other'));
  STRANGER = await sessionFor('stranger', await makeAccount('user', 'stranger'));
  OPERATOR = await sessionFor('operator', await makeAccount('operator', 'operator'));
  ROOT = await sessionFor('root', await makeAccount('admin', 'root'));
  const project = await call(OWNER, 'POST', '/projects', { name: `P1-B-2 drill ${tag()}` });
  expect(project.status).toBe(201);
  PROJECT_ID = String(project.json.project.id);
});

afterAll(async () => {
  if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  await pool.end();
});

// ─────────────────────────────── the drill ───────────────────────────────────

describe('(1) a Connector files a credential request: pending, kind credential, the requester its target, nothing issued', () => {
  let CONNECTOR: Bearer;
  let RELATED: string;
  let RECORD: any;
  let CREDENTIALS_BEFORE: number;

  beforeAll(async () => {
    CONNECTOR = await registerConnector(OWNER);
    RELATED = await ownerTask(OWNER, `P1-B-2 related ${tag()}`, PROJECT_ID);
    CREDENTIALS_BEFORE = await credentialCount(CONNECTOR.principalId);
    RECORD = await fileOk(CONNECTOR, { requestedScopes: ['tasks:read', 'phases:write'], relatedTaskId: RELATED });
  });

  it('stores one pending Approval of kind credential: the scopes, the filing credential\'s pin, the chain-root grantee, no rows', async () => {
    const row = await approvalRow(RECORD.id);
    expect({
      kind: row.kind, status: row.status, requester: String(row.requester_principal_id),
      credential: String(row.requesting_credential_id), grantee: String(row.grantee_principal_id),
      scopes: parseJson(row.requested_scopes), rules: parseJson(row.requested_rules), transport: row.requested_transport,
      label: row.credential_label, issued: row.issued_credential_id, minted: row.minted_principal_id,
      related: String(row.related_task_id), target: row.target_task_id,
    }).toEqual({
      kind: 'credential', status: 'pending', requester: CONNECTOR.principalId, credential: CONNECTOR.credentialId,
      grantee: OWNER.principalId, scopes: ['tasks:read', 'phases:write'], rules: [], transport: 'api',
      label: null, issued: null, minted: null, related: RELATED, target: null,
    });
    expect(Math.abs(new Date(row.requested_expires_at).getTime() - (new Date(row.requested_at).getTime() + 14 * DAY))).toBeLessThan(5000);
    expect(RECORD).toMatchObject({
      id: row.id, kind: 'credential', status: 'pending', requestedScopes: ['tasks:read', 'phases:write'],
      requestedTransport: 'api', label: null, issuedCredentialId: null, issuedCredential: null, revokedAt: null,
    });
    for (const withheld of ['decidedByPrincipalId', 'decisionStepUp', 'sessionEvidence', 'requestingCredentialId', 'secretOnce']) {
      expect(Object.keys(RECORD)).not.toContain(withheld);
    }
  });

  it('records approval.requested and the approval.request audit with kind credential, and issues NOTHING', async () => {
    const requested = await events(RECORD.id, 'approval.requested');
    expect(parseJson(requested[0].metadata)).toMatchObject({
      kind: 'credential', scopes: ['tasks:read', 'phases:write'], transport: 'api', targetPrincipalId: CONNECTOR.principalId,
    });
    const audit = await pool.query(`SELECT outcome, metadata FROM audit_events WHERE action = 'approval.request' AND resource_id = $1`, [RECORD.id]);
    expect(audit.rows.map((r: any) => [r.outcome, parseJson(r.metadata).kind])).toEqual([['success', 'credential']]);
    expect(await credentialCount(CONNECTOR.principalId)).toBe(CREDENTIALS_BEFORE);
  });

  it('an explicit pin and label are stored as asked, and naming yourself as the target is admitted', async () => {
    const filed = await fileOk(CONNECTOR, {
      requestedScopes: ['phases:read'], requestedTransport: 'mcp', label: 'release handover', relatedTaskId: RELATED,
      targetPrincipalId: CONNECTOR.principalId,
    });
    const row = await approvalRow(filed.id);
    expect([row.requested_transport, row.credential_label]).toEqual(['mcp', 'release handover']);
  });

  it('the endpoint notice names the credential kind', async () => {
    const spy = jest.spyOn(notificationEndpointService, 'dispatchException').mockResolvedValue(undefined as any);
    try {
      const FRESH = await registerConnector(OWNER);
      const filed = await fileOk(FRESH, { requestedScopes: ['phases:read'], relatedTaskId: RELATED });
      const notices = spy.mock.calls.map((args: any[]) => args[0]).filter((notice: any) => notice.objectId === filed.id);
      expect(notices.map((notice: any) => notice.reason)).toEqual([
        `credential approval requested by connector-${FRESH.label}; decide on the board: /dashboard/settings/access-manager?approval=${filed.id}`]);
    } finally {
      spy.mockRestore();
    }
  });
});

describe('(2) filing refuses by name, with {code, rule, subject, clause} and a durable audit', () => {
  let CONNECTOR: Bearer;
  let RELATED: string;

  beforeAll(async () => {
    CONNECTOR = await registerConnector(OWNER);
    RELATED = await ownerTask(OWNER, `P1-B-2 related ${tag()}`, PROJECT_ID);
  });

  const base = () => ({ requestedScopes: ['phases:write'], relatedTaskId: RELATED });

  async function refusedAudit(who: Bearer, code: string): Promise<any[]> {
    const rows = await pool.query(
      `SELECT metadata FROM audit_events WHERE action = 'approval.request' AND outcome = 'denied'
          AND metadata->>'refusal' = $1 AND resource_id = $2`, [code, who.principalId]);
    return rows.rows.map((row: any) => parseJson(row.metadata));
  }

  it.each([
    ['root', ['root'], 422, 'ROOT_NOT_MINTABLE', 'AZ-A9 clause 11'],
    ['a *:admin scope', ['phases:write', 'tasks:admin'], 422, 'ADMIN_SCOPE_NOT_ADMISSIBLE', 'AZ-A9 clause 11'],
    ['an unknown scope', ['flux:read'], 422, 'INVALID_SCOPES', 'AZ-A9 clause 13'],
    ['an inert (not yet mintable) scope', ['tools:read'], 422, 'INVALID_SCOPES', 'AZ-A9 clause 13'],
    ['no scope', [], 422, 'SCOPES_REQUIRED', 'AZ-A9 clause 13'],
  ])('%s is refused by name and audited with the requester chain', async (_label, scopes, status, code, clause) => {
    const filed = await file(CONNECTOR, { ...base(), requestedScopes: scopes });
    expect(filed.ok ? null : [filed.status, filed.body.code, filed.body.subject, filed.body.clause, filed.body.kind])
      .toEqual([status, code, 'requester', clause, 'credential']);
    const audits = await refusedAudit(CONNECTOR, String(code));
    expect(audits.length).toBeGreaterThan(0);
    expect(audits[audits.length - 1]).toMatchObject({ kind: 'credential', subject: 'requester', clause });
    expect(audits[audits.length - 1].chain.length).toBeGreaterThan(1);
  });

  it('ALREADY_HELD: scopes a live credential already carries are refused, naming that credential — never a secret', async () => {
    const filed = await file(CONNECTOR, { ...base(), requestedScopes: ['tasks:read', 'reports:write'] });
    expect(filed.ok ? null : [filed.status, filed.body.code, filed.body.subject, filed.body.clause])
      .toEqual([409, 'ALREADY_HELD', 'requester', 'AZ-A9 clause 13']);
    expect(filed.ok ? null : filed.body.coveringCredential).toMatchObject({
      credentialId: CONNECTOR.credentialId, label: CONNECTOR.label, transport: 'api',
    });
    expect(filed.ok ? '' : JSON.stringify(filed.body)).not.toContain(CONNECTOR.secret);
    expect(filed.ok ? [] : Object.keys(filed.body.coveringCredential).sort()).toEqual(['credentialId', 'expiresAt', 'keyId', 'label', 'transport']);
  });

  it.each([
    ['another target', () => ({ targetPrincipalId: crypto.randomUUID() }), 'TARGET_NOT_AVAILABLE', 'AZ-A9 clause 13'],
    ['bundled grant rows', () => ({ requestedRules: [{ resourceType: 'task', selectorForm: 'exact', selectorIds: [RELATED], verbs: ['read'] }] }),
      'BUNDLED_ROWS_NOT_AVAILABLE', 'AZ-A9 clause 13'],
    ['a pin outside the vocabulary', () => ({ requestedTransport: 'ssh' }), 'INVALID_TRANSPORT', 'AZ-A9 clause 13'],
    ['an over-long label', () => ({ label: 'x'.repeat(101) }), 'INVALID_LABEL', 'AZ-A9 clause 13'],
    ['an expiry past 90 days', () => ({ requestedExpiresAt: inDays(91) }), 'EXPIRY_TOO_LONG', 'AZ-A9 clause 3'],
  ])('%s is refused by name', async (_label, extra, code, clause) => {
    const filed = await file(CONNECTOR, { ...base(), ...(extra as () => Record<string, unknown>)() });
    expect(filed.ok ? null : [filed.status, filed.body.code, filed.body.clause]).toEqual([422, code, clause]);
  });

  it('an unreadable related task is 404-concealed exactly as an absent one', async () => {
    const X = await ownerTask(OTHER, `P1-B-2 X ${tag()}`);
    const unreadable = await file(CONNECTOR, { ...base(), relatedTaskId: X });
    const absent = await file(CONNECTOR, { ...base(), relatedTaskId: crypto.randomUUID() });
    expect(unreadable.ok ? null : [unreadable.status, unreadable.body]).toEqual(absent.ok ? 'absent filed' : [absent.status, absent.body]);
    expect(unreadable.ok ? null : unreadable.body.code).toBe('TASK_NOT_FOUND');
  });

  it('an Agent is refused CREDENTIAL_REQUESTER_NOT_CONNECTOR: its credential is its Connector\'s mint', async () => {
    const target = await ownerTask(OWNER, `P1-B-2 bound ${tag()}`, PROJECT_ID);
    const requested = await call(CONNECTOR, 'POST', '/delegation/agent-mints',
      { targetTaskId: target, requestedScopes: FOUR_SCOPES, via: 'approval' }, { 'Idempotency-Key': key('mint') });
    const mintId = String(requested.json.approval.id);
    expect((await decide(OWNER, mintId, 'approve')).status).toBe(200);
    const collected = await call(CONNECTOR, 'POST', `/delegation/agent-mints/${mintId}/collect`, {}, { 'Idempotency-Key': key('collect') });
    expect(collected.status).toBe(201);
    const pack = collected.json.pack;
    const agentRow = await credentialRow(String(pack.credentialId));
    const AGENT = bearer('agent', String(agentRow.principal_id), String(pack.credentialId), FOUR_SCOPES, String(pack.secretOnce));
    const filed = await file(AGENT, { ...base(), relatedTaskId: target });
    expect(filed.ok ? null : [filed.status, filed.body.code, filed.body.subject, filed.body.clause])
      .toEqual([422, 'CREDENTIAL_REQUESTER_NOT_CONNECTOR', 'requester', 'AZ-A9 clause 13']);
  });

  it('a requester whose filing credential is in rotation grace is not live: refused CREDENTIAL_ROTATED', async () => {
    const GRACED = await registerConnector(OWNER);
    await pool.query(`UPDATE principal_credentials SET grace_until = NOW() + INTERVAL '1 hour' WHERE id = $1`, [GRACED.credentialId]);
    const filed = await file(GRACED, base());
    expect(filed.ok ? null : [filed.status, filed.body.code, filed.body.subject, filed.body.clause])
      .toEqual([409, 'CREDENTIAL_ROTATED', 'requester', 'AZ-A9 clause 11']);
    expect(await refusedAudit(GRACED, 'CREDENTIAL_ROTATED')).toHaveLength(1);
  });

  it('filed nothing: every refusal above left no approval row', async () => {
    const rows = await pool.query(
      `SELECT COUNT(*)::int AS n FROM approvals WHERE requester_principal_id = $1 AND kind = 'credential'`, [CONNECTOR.principalId]);
    expect(rows.rows[0].n).toBe(0);
  });

  it('one quota across kinds: three grant and two credential requests fill it, and a sixth credential request is refused', async () => {
    const QUOTA = await registerConnector(OWNER);
    const X = await ownerTask(OTHER, `P1-B-2 quota X ${tag()}`);
    for (let i = 0; i < 3; i += 1) {
      const grant = await call(QUOTA, 'POST', '/delegation/access-requests', {
        kind: 'grant', reason: REASON, relatedTaskId: RELATED,
        requestedRules: [{ resourceType: 'task', selectorForm: 'exact', selectorIds: [X], verbs: ['read'] }],
      });
      expect(grant.status).toBe(202);
    }
    await fileOk(QUOTA, base());
    await fileOk(QUOTA, { ...base(), requestedScopes: ['phases:read'] });
    const sixth = await file(QUOTA, base());
    expect(sixth.ok ? null : [sixth.status, sixth.body.code, sixth.body.pending, sixth.body.kind, sixth.body.clause])
      .toEqual([429, 'REQUEST_QUOTA_EXCEEDED', 5, 'credential', 'AZ-A9 clause 11']);
  });
});

describe('(3) who decides: root or an administrator session with step-up', () => {
  let CONNECTOR: Bearer;
  let RELATED: string;
  let C1: any;

  beforeAll(async () => {
    CONNECTOR = await registerConnector(OWNER);
    RELATED = await ownerTask(OWNER, `P1-B-2 related ${tag()}`, PROJECT_ID);
    C1 = await fileOk(CONNECTOR, { requestedScopes: ['phases:write'], relatedTaskId: RELATED });
  });

  it('a bearer caller is refused SESSION_ONLY', async () => {
    const answered = await call(CONNECTOR, 'POST', `/approvals/${C1.id}/approve`, { stepUpToken: 'x' });
    expect([answered.status, answered.json?.code]).toEqual([403, 'SESSION_ONLY']);
  });

  it('the non-administrator owning Account lists the item, and its approve is refused APPROVAL_DECIDE_REQUIRES_ADMINISTRATOR without spending its step-up', async () => {
    // Its own request, so a decide that slipped through consumes nothing the
    // tests below decide.
    const OWN = await fileOk(CONNECTOR, { requestedScopes: ['skills:read'], relatedTaskId: RELATED });
    const listed = await call(OWNER, 'GET', '/approvals?kind=credential');
    expect(listed.json.approvals.map((a: any) => a.id)).toEqual(expect.arrayContaining([C1.id, OWN.id]));
    expect(listed.json.viewer).toEqual({ isRoot: false, isAdministrator: false });
    const stepUp = await stepUpService.mint(OWNER.principalId, 'approval.decide', OWN.id, 'password');
    const answered = await call(OWNER, 'POST', `/approvals/${OWN.id}/approve`, { stepUpToken: stepUp.token });
    expect([answered.status, answered.json?.code, answered.json?.subject, answered.json?.clause, answered.json?.kind])
      .toEqual([403, 'APPROVAL_DECIDE_REQUIRES_ADMINISTRATOR', 'decider', 'AZ-A9 clause 6', 'credential']);
    const token = await pool.query('SELECT consumed_at FROM step_up_tokens WHERE id = $1', [stepUp.tokenId]);
    expect(token.rows[0].consumed_at).toBeNull();
    expect((await approvalRow(OWN.id)).status).toBe('pending');
  });

  it('a stranger Account is 404-concealed', async () => {
    const answered = await call(STRANGER, 'GET', `/approvals/${C1.id}`);
    expect([answered.status, answered.json?.code]).toEqual([404, 'APPROVAL_NOT_FOUND']);
  });

  it('an administrator approving WITHOUT a step-up token is refused and the request stays pending', async () => {
    const answered = await call(OPERATOR, 'POST', `/approvals/${C1.id}/approve`, {});
    expect([answered.status, answered.json?.code]).toEqual([403, 'STEP_UP_REQUIRED']);
    const forged = await call(OPERATOR, 'POST', `/approvals/${C1.id}/approve`, { stepUpToken: 'rhsu_forged_token_value' });
    expect(forged.status).toBe(403);
    expect((await approvalRow(C1.id)).status).toBe('pending');
  });

  it('the administrator (operator) session approves; the event and audit carry the kind, the standing and the step-up', async () => {
    const answered = await decide(OPERATOR, C1.id, 'approve');
    expect([answered.status, answered.json?.approval?.status]).toEqual([200, 'approved']);
    const approved = parseJson((await events(C1.id, 'approval.approved'))[0].metadata);
    expect(approved).toMatchObject({ kind: 'credential', approvedScopes: ['phases:write'], approvedTransport: 'api', edited: false, deciderStanding: 'administrator' });
    expect(approved.stepUp.tokenId).toEqual(expect.any(String));
    const audit = await pool.query(`SELECT metadata FROM audit_events WHERE action = 'approval.approve' AND resource_id = $1`, [C1.id]);
    expect(parseJson(audit.rows[0].metadata)).toMatchObject({ kind: 'credential', deciderStanding: 'administrator' });
  });

  it('root denies another with a reason', async () => {
    const C2 = await fileOk(CONNECTOR, { requestedScopes: ['phases:read'], relatedTaskId: RELATED });
    const answered = await decide(ROOT, C2.id, 'deny', { reason: 'not this week' });
    expect([answered.status, answered.json?.approval?.status, answered.json?.approval?.denialReason]).toEqual([200, 'denied', 'not this week']);
    expect(parseJson((await events(C2.id, 'approval.denied'))[0].metadata)).toMatchObject({ kind: 'credential', deciderStanding: 'root' });
  });
});

describe('(4)-(7) narrow, approve, collect, use — and the secret is shown once and stored nowhere', () => {
  let CONNECTOR: Bearer;
  let OTHER_CONNECTOR: Bearer;
  let RELATED: string;
  let R: any;
  let COLLECTED: Answer;
  let NEW_KEY: Bearer;
  let CREDENTIALS_BEFORE: number;
  const SHORTER = inDays(10);

  beforeAll(async () => {
    CONNECTOR = await registerConnector(OWNER, FOUR_SCOPES, 'any');
    OTHER_CONNECTOR = await registerConnector(OTHER);
    RELATED = await ownerTask(OWNER, `P1-B-2 related ${tag()}`, PROJECT_ID);
    R = await fileOk(CONNECTOR, {
      requestedScopes: ['tasks:read', 'projects:read', 'phases:read', 'phases:write'],
      requestedTransport: 'any', requestedExpiresAt: inDays(30), label: 'phase editor', relatedTaskId: RELATED,
    });
  });

  it.each([
    ['a scope never requested', () => ({ editedScopes: ['phases:read', 'phases:write', 'projects:write'] }), 'EDIT_ONLY_NARROWS'],
    ['a later expiry', () => ({ editedExpiresAt: inDays(40) }), 'EDIT_ONLY_NARROWS'],
    ['grant rows', () => ({ editedRules: [{ resourceType: 'task', selectorForm: 'exact', selectorIds: [RELATED], verbs: ['read'] }] }), 'EDIT_ONLY_NARROWS'],
    ['another kind', () => ({ editedKind: 'grant' }), 'EDIT_ONLY_NARROWS'],
    ['another grantee', () => ({ editedGranteePrincipalId: STRANGER.principalId }), 'EDIT_ONLY_NARROWS'],
    ['another target', () => ({ editedTargetPrincipalId: OTHER_CONNECTOR.principalId }), 'EDIT_ONLY_NARROWS'],
    ['every scope unticked', () => ({ editedScopes: [] }), 'APPROVAL_WRITES_NOTHING'],
    ['root slipped in', () => ({ editedScopes: ['root'] }), 'ROOT_NOT_MINTABLE'],
  ])('widening by %s is refused and the request stays pending', async (_label, body, code) => {
    const answered = await decide(ROOT, R.id, 'approve', (body as () => Record<string, unknown>)());
    expect([answered.status, answered.json?.code, answered.json?.subject]).toEqual([422, code, 'decider']);
    expect((await approvalRow(R.id)).status).toBe('pending');
  });

  it('a wider pin is refused EDIT_ONLY_NARROWS: an api-pinned request is never approved as any', async () => {
    // OTHER's Connector files against a task of its own Account.
    const related = await ownerTask(OTHER, `P1-B-2 other ${tag()}`);
    const filed = await fileOk(OTHER_CONNECTOR, { requestedScopes: ['phases:write'], relatedTaskId: related });
    expect((await approvalRow(filed.id)).requested_transport).toBe('api');
    const answered = await decide(ROOT, filed.id, 'approve', { editedTransport: 'any' });
    expect([answered.status, answered.json?.code, answered.json?.clause]).toEqual([422, 'EDIT_ONLY_NARROWS', 'AZ-A9 clause 8']);
  });

  it('(4) dropping scopes, shortening the expiry and narrowing any to api stores exactly that, and (5) issues nothing', async () => {
    CREDENTIALS_BEFORE = await credentialCount(CONNECTOR.principalId);
    const answered = await decide(OPERATOR, R.id, 'approve', {
      editedScopes: ['projects:read', 'phases:read', 'phases:write'], editedExpiresAt: SHORTER, editedTransport: 'api',
    });
    expect([answered.status, answered.json?.approval?.status]).toEqual([200, 'approved']);
    const row = await approvalRow(R.id);
    expect({
      scopes: parseJson(row.approved_scopes), transport: row.approved_transport,
      expires: new Date(row.approved_expires_at).toISOString(), decider: String(row.decided_by_principal_id),
      issued: row.issued_credential_id,
    }).toEqual({
      scopes: ['projects:read', 'phases:read', 'phases:write'], transport: 'api',
      expires: new Date(SHORTER).toISOString(), decider: OPERATOR.principalId, issued: null,
    });
    expect(Math.abs(new Date(row.collect_expires_at).getTime() - (Date.now() + DAY))).toBeLessThan(60_000);
    expect(parseJson((await events(R.id, 'approval.approved'))[0].metadata)).toMatchObject({ edited: true, approvedTransport: 'api' });
    // (5) Approval records the authorization only (clause 13).
    expect(await credentialCount(CONNECTOR.principalId)).toBe(CREDENTIALS_BEFORE);
  });

  it('the database refuses a widened approval or a changed request written behind the service', async () => {
    await expect(pool.query(
      `UPDATE approvals SET approved_scopes = '["projects:read","phases:read","phases:write","projects:write"]'::jsonb WHERE id = $1`, [R.id]))
      .rejects.toMatchObject({ code: '23514' });
    await expect(pool.query(`UPDATE approvals SET approved_scopes = '["root"]'::jsonb WHERE id = $1`, [R.id]))
      .rejects.toMatchObject({ code: '23514' });
    await expect(pool.query(`UPDATE approvals SET requested_scopes = '["phases:admin"]'::jsonb WHERE id = $1`, [R.id]))
      .rejects.toMatchObject({ code: '23514' });
    await expect(pool.query(`UPDATE approvals SET requested_scopes = '["tasks:read"]'::jsonb WHERE id = $1`, [R.id]))
      .rejects.toMatchObject({ code: '23514' });
    // An issued credential is named only on a COLLECTED request: collect is its one writer.
    await expect(pool.query(`UPDATE approvals SET issued_credential_id = $2 WHERE id = $1`, [R.id, CONNECTOR.credentialId]))
      .rejects.toMatchObject({ code: '23514' });
    expect(parseJson((await approvalRow(R.id)).approved_scopes)).toEqual(['projects:read', 'phases:read', 'phases:write']);
  });

  it('(6) another credential of the same Connector, and another Connector, are answered exactly as an absent id', async () => {
    // Its own Connector, credentials and approved request, so a failure here
    // issues and consumes nothing the tests below count or collect.
    const OWN = await registerConnector(OWNER, FOUR_SCOPES, 'any');
    const second = await call(ROOT, 'POST', `/principals/${OWN.principalId}/credentials`, { scopes: FOUR_SCOPES, label: 'second' });
    expect(second.status).toBe(201);
    const SIBLING = bearer('sibling', OWN.principalId, String(second.json.id), FOUR_SCOPES, String(second.json.secretOnce));
    const B = await approvedRequest(OWN, ROOT, { relatedTaskId: RELATED }, {}, { requestedScopes: ['skills:read'] });
    const sibling = await collect(SIBLING, B.id);
    const foreign = await collect(OTHER_CONNECTOR, B.id);
    const absent = await collect(OWN, crypto.randomUUID());
    expect([sibling.status, sibling.json]).toEqual([absent.status, absent.json]);
    expect([foreign.status, foreign.json]).toEqual([absent.status, absent.json]);
    expect([absent.status, absent.json?.code]).toEqual([404, 'APPROVAL_NOT_FOUND']);
    expect((await approvalRow(B.id)).status).toBe('approved');
  });

  it('(6) the requesting credential collects: 201 with the secret ONCE, the credential as approved, recorded on the approval', async () => {
    COLLECTED = await collect(CONNECTOR, R.id);
    expect(COLLECTED.status).toBe(201);
    const body = COLLECTED.json;
    // Held first, so a failed assertion below never starves the tests that use the key.
    NEW_KEY = bearer('new-key', CONNECTOR.principalId, String(body.credential.id), body.credential.scopes, String(body.secretOnce));
    expect(body.secretOnce).toMatch(/^rh_[a-z]+_[A-Za-z0-9]{12}\./);
    expect(body.onboarding.credential.secretOnce).toBe(body.secretOnce);
    expect(body.credential).toMatchObject({
      principalId: CONNECTOR.principalId, scopes: ['projects:read', 'phases:read', 'phases:write'], transport: 'api',
      expiresAt: new Date(SHORTER).toISOString(), label: 'phase editor',
    });
    expect(body.warning).toMatch(/only time the full key is shown/);
    const row = await approvalRow(R.id);
    expect([row.status, String(row.issued_credential_id), String(row.minted_principal_id)])
      .toEqual(['collected', body.credential.id, CONNECTOR.principalId]);
    const issued = await credentialRow(body.credential.id);
    expect({
      principal: String(issued.principal_id), scopes: parseJson(issued.scopes), transport: issued.transport,
      expires: new Date(issued.expires_at).toISOString(), label: issued.label, by: String(issued.created_by_principal_id),
      via: parseJson(issued.metadata).issued_via, approval: parseJson(issued.metadata).approval_id,
    }).toEqual({
      principal: CONNECTOR.principalId, scopes: ['projects:read', 'phases:read', 'phases:write'], transport: 'api',
      expires: new Date(SHORTER).toISOString(), label: 'phase editor', by: OPERATOR.principalId,
      via: 'access-request', approval: R.id,
    });
    const collectedEvent = parseJson((await events(R.id, 'approval.collected'))[0].metadata);
    expect(collectedEvent).toMatchObject({ kind: 'credential', issuedCredentialId: body.credential.id, keyId: body.credential.keyId });
    expect(body.approval).toMatchObject({ status: 'collected', issuedCredential: { id: body.credential.id, revokedAt: null } });
  });

  it('(6) the new key does what the old one is refused, and the old key stays live', async () => {
    expect(await createsPhase(NEW_KEY)).toBe(201);
    expect(await createsPhase(CONNECTOR)).toBe(403);
    expect((await call(CONNECTOR, 'GET', '/delegation/access-requests')).status).toBe(200);
    expect((await credentialRow(CONNECTOR.credentialId)).revoked_at).toBeNull();
  });

  it('(6) a repeated collect is refused APPROVAL_NOT_COLLECTABLE and returns no secret', async () => {
    const again = await collect(CONNECTOR, R.id);
    expect([again.status, again.json?.code, again.json?.clause]).toEqual([409, 'APPROVAL_NOT_COLLECTABLE', 'AZ-A9 clause 13']);
    expect(again.text).not.toContain(NEW_KEY.secret);
    expect(await credentialCount(CONNECTOR.principalId)).toBe(CREDENTIALS_BEFORE + 1);
  });

  it('(7) the secret is in no approval row, event, audit row, idempotency record or log line', async () => {
    const secret = NEW_KEY.secret;
    const secretTail = secret.split('.')[1];
    const approvals = await pool.query(`SELECT to_jsonb(a)::text AS t FROM approvals a WHERE id = $1`, [R.id]);
    const ledger = await pool.query(`SELECT metadata::text AS t FROM approval_events WHERE approval_id = $1`, [R.id]);
    const audit = await pool.query(`SELECT metadata::text AS t FROM audit_events WHERE metadata::text LIKE '%' || $1 || '%'`, [secretTail]);
    const records = await pool.query(
      `SELECT COUNT(*)::int AS n FROM operation_idempotency_records WHERE response_body LIKE '%' || $1 || '%'`, [secretTail]);
    expect(approvals.rows[0].t).not.toContain(secretTail);
    expect(ledger.rows.length).toBeGreaterThan(0);
    for (const row of ledger.rows) expect(row.t).not.toContain(secretTail);
    expect(audit.rows).toEqual([]);
    expect(records.rows[0].n).toBe(0);
    expect(CONSOLE_LINES.filter((line) => line.includes(secretTail))).toEqual([]);
    // Negative control: the scan sees the secret where it IS — the response.
    expect(COLLECTED.text).toContain(secretTail);
    // The decider's and requester's reads carry no secret column.
    const decider = await call(ROOT, 'GET', `/approvals/${R.id}`);
    const requester = await call(CONNECTOR, 'GET', `/delegation/access-requests/${R.id}`);
    for (const text of [decider.text, requester.text]) {
      expect(text).not.toContain(secretTail);
      expect(text).not.toMatch(/secret_hash|secret_ciphertext|secretHash|ciphertext/);
    }
  });
});

describe('(8) the lifetimes: 7 days pending, 24 hours to collect, and the requested expiry', () => {
  let CONNECTOR: Bearer;
  let RELATED: string;

  beforeAll(async () => {
    CONNECTOR = await registerConnector(OWNER);
    RELATED = await ownerTask(OWNER, `P1-B-2 related ${tag()}`, PROJECT_ID);
  });

  it('a request past its 7-day pending TTL lapses PENDING_EXPIRED at decide', async () => {
    const filed = await fileOk(CONNECTOR, { requestedScopes: ['phases:write'], relatedTaskId: RELATED });
    await pool.query(`UPDATE approvals SET pending_expires_at = NOW() - INTERVAL '1 second' WHERE id = $1`, [filed.id]);
    const answered = await decide(ROOT, filed.id, 'approve');
    expect([answered.status, answered.json?.code]).toEqual([409, 'APPROVAL_LAPSED']);
    const row = await approvalRow(filed.id);
    expect([row.status, row.lapse_reason]).toEqual(['lapsed', 'PENDING_EXPIRED']);
  });

  it('an approval not collected within 24 hours lapses COLLECT_TTL_EXPIRED at collect, and nothing is issued', async () => {
    const filed = await approvedRequest(CONNECTOR, ROOT, { relatedTaskId: RELATED });
    const before = await credentialCount(CONNECTOR.principalId);
    await pool.query(`UPDATE approvals SET collect_expires_at = NOW() - INTERVAL '1 second' WHERE id = $1`, [filed.id]);
    const answered = await collect(CONNECTOR, filed.id);
    expect([answered.status, answered.json?.code, answered.json?.lapseReason]).toEqual([409, 'APPROVAL_LAPSED', 'COLLECT_TTL_EXPIRED']);
    expect([(await approvalRow(filed.id)).status, (await approvalRow(filed.id)).lapse_reason]).toEqual(['lapsed', 'COLLECT_TTL_EXPIRED']);
    expect(await credentialCount(CONNECTOR.principalId)).toBe(before);
  });

  it('the TTL sweep lapses an uncollected approval past its window, and a pending request past its own expiry', async () => {
    const approved = await approvedRequest(CONNECTOR, ROOT, { relatedTaskId: RELATED }, {}, { requestedScopes: ['projects:read'] });
    await pool.query(`UPDATE approvals SET collect_expires_at = NOW() - INTERVAL '1 second' WHERE id = $1`, [approved.id]);
    const inserted = await pool.query(
      `INSERT INTO approvals (kind, requester_principal_id, requesting_credential_id, grantee_principal_id,
         requested_scopes, requested_rules, requested_transport, requested_expires_at, reason, related_task_id,
         requested_at, pending_expires_at)
       VALUES ('credential', $1, $2, $3, '["phases:read"]'::jsonb, '[]'::jsonb, 'api', NOW() - INTERVAL '1 day', $4, $5,
               NOW() - INTERVAL '2 days', NOW() + INTERVAL '5 days')
       RETURNING id`,
      [CONNECTOR.principalId, CONNECTOR.credentialId, OWNER.principalId, REASON, RELATED],
    );
    const stale = String(inserted.rows[0].id);
    await approvalService.sweepTtls(SYSTEM);
    expect([(await approvalRow(approved.id)).status, (await approvalRow(approved.id)).lapse_reason]).toEqual(['lapsed', 'COLLECT_TTL_EXPIRED']);
    expect([(await approvalRow(stale)).status, (await approvalRow(stale)).lapse_reason]).toEqual(['lapsed', 'PENDING_EXPIRED']);
  });
});

describe('(9) clause 12a: the issued credential is revoked at task-terminal and phase-terminal, never reused', () => {
  it('completing the related task revokes the issued credential (the next request is refused), lapses what waits, and reopening restores nothing', async () => {
    const CONNECTOR = await registerConnector(OWNER);
    const RELATED = await ownerTask(OWNER, `P1-B-2 terminal ${tag()}`, PROJECT_ID);
    const issuedReq = await approvedRequest(CONNECTOR, ROOT, { relatedTaskId: RELATED });
    const collected = await collect(CONNECTOR, issuedReq.id);
    expect(collected.status).toBe(201);
    const NEW_KEY = bearer('new', CONNECTOR.principalId, String(collected.json.credential.id), ['phases:read', 'phases:write'], String(collected.json.secretOnce));
    expect(await createsPhase(NEW_KEY)).toBe(201);
    // Scopes the new key does not already carry (else ALREADY_HELD).
    const uncollected = await approvedRequest(CONNECTOR, ROOT, { relatedTaskId: RELATED }, {}, { requestedScopes: ['projects:write'] });
    const pending = await fileOk(CONNECTOR, { requestedScopes: ['skills:read'], relatedTaskId: RELATED });

    const completed = await call(OWNER, 'PATCH', `/tasks/${RELATED}`, { status: 'completed' }, { 'Idempotency-Key': key('complete') });
    expect(completed.status).toBe(200);

    expect((await credentialRow(NEW_KEY.credentialId)).revoked_at).not.toBeNull();
    expect(parseJson((await credentialRow(NEW_KEY.credentialId)).metadata).revoke_reason).toBe('TASK_TERMINAL');
    expect([401, 403]).toContain(await createsPhase(NEW_KEY));
    const row = await approvalRow(issuedReq.id);
    expect(row.status).toBe('collected');
    const revoked = await events(issuedReq.id, 'approval.revoked');
    expect(revoked.map((e: any) => parseJson(e.metadata))).toEqual([expect.objectContaining({
      kind: 'credential', reason: 'TASK_TERMINAL', via: 'updateTask', revokedCredentialIds: [NEW_KEY.credentialId],
    })]);
    const credentialRevoke = await pool.query(
      `SELECT metadata FROM audit_events WHERE action = 'credential.revoke' AND resource_id = $1`, [NEW_KEY.credentialId]);
    expect(credentialRevoke.rows.map((r: any) => parseJson(r.metadata).reason)).toEqual(['TASK_TERMINAL']);
    for (const waiting of [uncollected, pending]) {
      expect([(await approvalRow(waiting.id)).status, (await approvalRow(waiting.id)).lapse_reason]).toEqual(['lapsed', 'TASK_TERMINAL']);
    }
    const late = await collect(CONNECTOR, uncollected.id);
    expect([late.status, late.json?.code]).toEqual([409, 'APPROVAL_NOT_COLLECTABLE']);
    // The requesting credential was never part of the request: it stays live.
    expect((await credentialRow(CONNECTOR.credentialId)).revoked_at).toBeNull();

    const reopened = await call(OWNER, 'PATCH', `/tasks/${RELATED}`, { status: 'todo' }, { 'Idempotency-Key': key('reopen') });
    expect(reopened.status).toBe(200);
    expect((await credentialRow(NEW_KEY.credentialId)).revoked_at).not.toBeNull();
    expect((await approvalRow(issuedReq.id)).status).toBe('collected');
    // (11) E49: the requester sees what became of it.
    const view = await call(CONNECTOR, 'GET', `/delegation/access-requests/${issuedReq.id}`);
    expect(view.json.approval).toMatchObject({ status: 'collected', issuedCredential: { id: NEW_KEY.credentialId } });
    expect(typeof view.json.approval.revokedAt).toBe('string');
    expect(typeof view.json.approval.issuedCredential.revokedAt).toBe('string');
  });

  it('phase arm: a phase-only request\'s credential is revoked when the phase completes; an approved-uncollected one lapses at archive', async () => {
    const CONNECTOR = await registerConnector(OWNER);
    const created = await call(OWNER, 'POST', '/phases', { projectId: PROJECT_ID, name: `P1-B-2 phase ${tag()}` }, { 'Idempotency-Key': key('phase') });
    const phase = created.json.phase;
    const issuedReq = await approvedRequest(CONNECTOR, ROOT, { relatedPhaseId: String(phase.id) });
    const collected = await collect(CONNECTOR, issuedReq.id);
    expect(collected.status).toBe(201);
    const issuedId = String(collected.json.credential.id);
    const done = await call(OWNER, 'PATCH', `/phases/${phase.id}`, { revision: phase.revision, status: 'completed' });
    expect(done.status).toBe(200);
    expect((await credentialRow(issuedId)).revoked_at).not.toBeNull();
    expect(parseJson((await events(issuedReq.id, 'approval.revoked'))[0].metadata)).toMatchObject({
      kind: 'credential', reason: 'PHASE_TERMINAL', via: 'phase.update', revokedCredentialIds: [issuedId],
    });

    const second = await call(OWNER, 'POST', '/phases', { projectId: PROJECT_ID, name: `P1-B-2 phase ${tag()}` }, { 'Idempotency-Key': key('phase') });
    const phase2 = second.json.phase;
    const waiting = await approvedRequest(CONNECTOR, ROOT, { relatedPhaseId: String(phase2.id) }, {}, { requestedScopes: ['projects:read'] });
    const archived = await call(OWNER, 'POST', `/phases/${phase2.id}/archive`, { revision: phase2.revision });
    expect(archived.status).toBe(200);
    expect([(await approvalRow(waiting.id)).status, (await approvalRow(waiting.id)).lapse_reason]).toEqual(['lapsed', 'PHASE_TERMINAL']);
  });

  it('AZ-31c: rotating the requesting credential lapses its pending and approved-uncollected credential requests CREDENTIAL_ROTATED', async () => {
    const CONNECTOR = await registerConnector(OWNER);
    const RELATED = await ownerTask(OWNER, `P1-B-2 rotated ${tag()}`, PROJECT_ID);
    const approved = await approvedRequest(CONNECTOR, ROOT, { relatedTaskId: RELATED });
    const pending = await fileOk(CONNECTOR, { requestedScopes: ['projects:read'], relatedTaskId: RELATED });
    const lapsed = await invalidateApprovalsForCredentials(pool, [CONNECTOR.credentialId], 'rotated', SYSTEM);
    expect(lapsed).toBe(2);
    for (const item of [approved, pending]) {
      expect([(await approvalRow(item.id)).status, (await approvalRow(item.id)).lapse_reason]).toEqual(['lapsed', 'CREDENTIAL_ROTATED']);
    }
  });
});

describe('(10) what the decider sees, as data on GET /approvals/:id', () => {
  let CONNECTOR: Bearer;
  let C: any;

  beforeAll(async () => {
    CONNECTOR = await registerConnector(OWNER);
    const RELATED = await ownerTask(OWNER, `P1-B-2 related ${tag()}`, PROJECT_ID);
    C = await fileOk(CONNECTOR, { requestedScopes: ['tasks:read', 'phases:write'], relatedTaskId: RELATED, label: 'phase writer' });
  });

  it('root reads the target and its live credentials, each scope held or new, the cap, the effective set, and that the old key stays', async () => {
    const answered = await call(ROOT, 'GET', `/approvals/${C.id}`);
    expect(answered.status).toBe(200);
    const decision = answered.json.decision;
    expect(decision.kind).toBe('credential');
    expect(decision.requestingCredential).toMatchObject({ id: CONNECTOR.credentialId, label: CONNECTOR.label, scopes: FOUR_SCOPES, transport: 'api', revoked: false });
    expect(decision.credential).toMatchObject({
      target: { principalId: CONNECTOR.principalId, kind: 'service', status: 'active' },
      requestedScopes: [
        { scope: 'tasks:read', heldByRequestingCredential: true, heldByAnyLiveCredential: true },
        { scope: 'phases:write', heldByRequestingCredential: false, heldByAnyLiveCredential: false },
      ],
      newScopes: ['phases:write'],
      requestedTransport: 'api', label: 'phase writer',
      effectiveAfterIssue: ['tasks:read', 'phases:write'], inertScopes: [],
      deciderCap: { standing: 'root', within: ['tasks:read', 'phases:write'], exceeding: [] },
      previousCredentialStays: true,
    });
    expect(decision.credential.liveCredentials).toEqual([expect.objectContaining({
      id: CONNECTOR.credentialId, scopes: FOUR_SCOPES, transport: 'api', requesting: true,
    })]);
    expect(decision.clause11).toMatchObject({ requesterLive: { ok: true }, deciderCeiling: { ok: true }, alreadyHeld: [] });
    expect(answered.json.viewer).toEqual({ isRoot: true, isAdministrator: true });
    expect(answered.text).not.toMatch(/secret_hash|secret_ciphertext|secretOnce/);
  });

  it('the operator reads it too; the non-administrator owning Account reads the item with no decision context', async () => {
    const operator = await call(OPERATOR, 'GET', `/approvals/${C.id}`);
    expect(operator.json.decision.credential.deciderCap).toMatchObject({ standing: 'administrator', exceeding: [] });
    const owner = await call(OWNER, 'GET', `/approvals/${C.id}`);
    expect([owner.status, owner.json.decision, owner.json.approval.kind]).toEqual([200, null, 'credential']);
  });
});

describe('(12) the decider\'s ceiling: at decide, at collect, and in the one executor', () => {
  it('a stored request no filing could produce (an inert scope) is refused at decide and stays pending', async () => {
    const CONNECTOR = await registerConnector(OWNER);
    const RELATED = await ownerTask(OWNER, `P1-B-2 forged ${tag()}`, PROJECT_ID);
    const inserted = await pool.query(
      `INSERT INTO approvals (kind, requester_principal_id, requesting_credential_id, grantee_principal_id,
         requested_scopes, requested_rules, requested_transport, requested_expires_at, reason, related_task_id, pending_expires_at)
       VALUES ('credential', $1, $2, $3, '["tools:read"]'::jsonb, '[]'::jsonb, 'api', NOW() + INTERVAL '5 days', $4, $5, NOW() + INTERVAL '5 days')
       RETURNING id`,
      [CONNECTOR.principalId, CONNECTOR.credentialId, OWNER.principalId, REASON, RELATED],
    );
    const id = String(inserted.rows[0].id);
    const answered = await decide(ROOT, id, 'approve');
    expect([answered.status, answered.json?.code, answered.json?.subject]).toEqual([422, 'INVALID_SCOPES', 'decider']);
    expect((await approvalRow(id)).status).toBe('pending');
    // …and root or *:admin cannot even be stored (the migration-145 CHECK).
    await expect(pool.query(
      `INSERT INTO approvals (kind, requester_principal_id, requesting_credential_id, grantee_principal_id,
         requested_scopes, requested_rules, requested_transport, requested_expires_at, reason, related_task_id, pending_expires_at)
       VALUES ('credential', $1, $2, $3, '["services:admin"]'::jsonb, '[]'::jsonb, 'api', NOW() + INTERVAL '5 days', $4, $5, NOW() + INTERVAL '5 days')`,
      [CONNECTOR.principalId, CONNECTOR.credentialId, OWNER.principalId, REASON, RELATED],
    )).rejects.toMatchObject({ code: '23514' });
  });

  it('the decide-time ceiling: approval refuses scopes beyond what the deciding session may put on a credential (a direct service call: no v1 decider session is narrower than a request can be)', async () => {
    const CONNECTOR = await registerConnector(OWNER);
    const RELATED = await ownerTask(OWNER, `P1-B-2 ceiling ${tag()}`, PROJECT_ID);
    const filed = await fileOk(CONNECTOR, { requestedScopes: ['phases:read', 'phases:write'], relatedTaskId: RELATED });
    const decideAs = (scopes: string[]) => approvalService.decide({
      approvalId: filed.id, decision: 'approve', deciderPrincipalId: OPERATOR.principalId,
      deciderStanding: 'administrator', deciderScopes: scopes,
      stepUp: { tokenId: crypto.randomUUID(), method: 'password' },
    }, SYSTEM);
    await expect(decideAs(scopesForRole('viewer'))).rejects.toMatchObject({
      code: 'DECIDER_CEILING_EXCEEDED', refusal: { subject: 'decider', clause: 'AZ-A9 clause 11', exceeding: ['phases:write'] },
    });
    await expect(decideAs([])).rejects.toMatchObject({ code: 'DECIDER_CEILING_EXCEEDED' });
    expect((await approvalRow(filed.id)).status).toBe('pending');
    const admitted = await decideAs(scopesForRole('operator'));
    expect(admitted.status).toBe('approved');
  });

  it('a decider that lost its standing between approve and collect issues nothing: DECIDER_NO_LONGER_ADMITTED, still approved', async () => {
    const DEMOTED = await sessionFor('demoted', await makeAccount('operator', 'demoted'));
    const CONNECTOR = await registerConnector(OWNER);
    const RELATED = await ownerTask(OWNER, `P1-B-2 demoted ${tag()}`, PROJECT_ID);
    const filed = await approvedRequest(CONNECTOR, DEMOTED, { relatedTaskId: RELATED });
    const before = await credentialCount(CONNECTOR.principalId);
    await pool.query(`UPDATE principals SET role = 'user' WHERE id = $1`, [DEMOTED.principalId]);
    const answered = await collect(CONNECTOR, filed.id);
    expect([answered.status, answered.json?.code, answered.json?.subject]).toEqual([403, 'DECIDER_NO_LONGER_ADMITTED', 'decider']);
    expect((await approvalRow(filed.id)).status).toBe('approved');
    expect(await credentialCount(CONNECTOR.principalId)).toBe(before);
  });

  it('the edit-in-place entry point (card 3c2db4b7; a direct call BY DESIGN, no route yet): the executor caps by the authority it is given', async () => {
    const CONNECTOR = await registerConnector(OWNER);
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const narrow = { principalId: OWNER.principalId, standing: 'owner', scopes: scopesForRole('viewer') };
      await expect(executeConnectorCredentialIssue(client, {
        connectorPrincipalId: CONNECTOR.principalId, scopes: ['phases:write'], transport: 'api',
        expiresAt: new Date(Date.now() + 5 * DAY), label: 'edit in place', authority: narrow, approvalId: null,
      }, SYSTEM)).rejects.toMatchObject({ code: 'DECIDER_CEILING_EXCEEDED', subject: 'decider', clause: 'AZ-A9 clause 11' });
      await client.query('ROLLBACK');
      await client.query('BEGIN');
      const issued = await executeConnectorCredentialIssue(client, {
        connectorPrincipalId: CONNECTOR.principalId, scopes: ['phases:read'], transport: 'api',
        expiresAt: new Date(Date.now() + 5 * DAY), label: 'edit in place', authority: narrow, approvalId: null,
      }, SYSTEM);
      expect(issued).toMatchObject({ principalId: CONNECTOR.principalId, scopes: ['phases:read'], transport: 'api' });
      await client.query('ROLLBACK');
      await client.query('BEGIN');
      await expect(executeConnectorCredentialIssue(client, {
        connectorPrincipalId: CONNECTOR.principalId, scopes: ['phases:read'], transport: 'api',
        expiresAt: new Date(Date.now() + 5 * DAY), label: null,
        authority: { principalId: STRANGER.principalId, standing: 'owner', scopes: scopesForRole('user') }, approvalId: null,
      }, SYSTEM)).rejects.toMatchObject({ code: 'CONNECTOR_NOT_ISSUABLE' });
      await client.query('ROLLBACK');
    } finally {
      client.release();
    }
    // Rolled back: nothing was issued.
    expect(await credentialCount(CONNECTOR.principalId)).toBe(1);
  });
});

describe('(13) clause 10: relayhall_access_request files, reads, collects and withdraws a credential request through the MCP ingress', () => {
  let CONNECTOR: Bearer;
  let RELATED: string;

  beforeAll(async () => {
    // transport 'any' (an api-pinned credential is refused at the MCP
    // ingress) and principals:read (the tool's scope, clause 10).
    CONNECTOR = await registerConnector(OWNER, [...FOUR_SCOPES, 'principals:read'], 'any');
    RELATED = await ownerTask(OWNER, `P1-B-2 related ${tag()}`, PROJECT_ID);
    const brief = await mcpCall(CONNECTOR, 'relayhall_brief_compile', { session: true });
    expect(mcpFailed(brief)).toBe(false);
  });

  it('file → status → (approved by root) → collect returns the credential once; withdraw lapses another', async () => {
    const filed = await mcpCall(CONNECTOR, 'relayhall_access_request', {
      action: 'file', kind: 'credential', requestedScopes: ['phases:read', 'phases:write'], reason: REASON, relatedTaskId: RELATED,
    });
    expect(mcpFailed(filed)).toBe(false);
    const id = String(JSON.parse(mcpText(filed)).approval.id);
    expect((await approvalRow(id)).requested_transport).toBe('any');
    const one = await mcpCall(CONNECTOR, 'relayhall_access_request', { action: 'status', approvalId: id });
    expect(JSON.parse(mcpText(one)).approval).toMatchObject({ id, kind: 'credential', status: 'pending', requestedScopes: ['phases:read', 'phases:write'] });
    expect((await decide(ROOT, id, 'approve', { editedTransport: 'mcp' })).status).toBe(200);
    const collected = await mcpCall(CONNECTOR, 'relayhall_access_request', { action: 'collect', approvalId: id });
    expect(mcpFailed(collected)).toBe(false);
    const body = JSON.parse(mcpText(collected));
    expect(body.credential).toMatchObject({ scopes: ['phases:read', 'phases:write'], transport: 'mcp' });
    expect(String(body.secretOnce)).toMatch(/^rh_/);
    expect((await approvalRow(id)).status).toBe('collected');
    const again = await mcpCall(CONNECTOR, 'relayhall_access_request', { action: 'collect', approvalId: id });
    expect([mcpFailed(again), mcpText(again).includes('APPROVAL_NOT_COLLECTABLE')]).toEqual([true, true]);

    const second = await mcpCall(CONNECTOR, 'relayhall_access_request', {
      action: 'file', kind: 'credential', requestedScopes: ['projects:read'], reason: REASON, relatedTaskId: RELATED,
    });
    const secondId = String(JSON.parse(mcpText(second)).approval.id);
    const withdrawn = await mcpCall(CONNECTOR, 'relayhall_access_request', { action: 'withdraw', approvalId: secondId });
    expect(mcpFailed(withdrawn)).toBe(false);
    expect([(await approvalRow(secondId)).status, (await approvalRow(secondId)).lapse_reason]).toEqual(['lapsed', 'WITHDRAWN']);
  });

  it('the same refusals by name through the tool: root, *:admin, ALREADY_HELD', async () => {
    for (const [scopes, code] of [[['root'], 'ROOT_NOT_MINTABLE'], [['tasks:admin'], 'ADMIN_SCOPE_NOT_ADMISSIBLE'], [['tasks:read'], 'ALREADY_HELD']] as const) {
      const refused = await mcpCall(CONNECTOR, 'relayhall_access_request', {
        action: 'file', kind: 'credential', requestedScopes: scopes, reason: REASON, relatedTaskId: RELATED,
      });
      expect([code, mcpFailed(refused), mcpText(refused).includes(code)]).toEqual([code, true, true]);
    }
  });
});
