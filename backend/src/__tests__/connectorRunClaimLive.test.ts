/**
 * Owner ruling E462, universal harness connector design v1.5 section 6.5 step 4,
 * N14 (slice S5): can a task-bounded implementer Agent, minted by a Connector
 * under a Warrant, claim and finish a Task ASSIGNED to that Connector
 * (`tasks.execution_service_id` = the Connector's published service)?
 *
 * The design leaves it unverified because `assignedClaimCaps` admits only a
 * chain whose first link is the service itself (`AssignedClaimAuthority.ts`),
 * and names the fallback: the Connector claims, the Agent does the work and the
 * finish. This suite SETTLES it over a real PostgreSQL and the production
 * router, through the very route sequence the connector daemon
 * (`cli/relayhall_connector_ring.py`) drives: the Connector's bearer mints at
 * `POST /delegation/agent-mints` under its Warrant, then one claimant claims
 * with the assignment epoch, and the Agent moves the Task to in-progress, saves
 * its progress Report and finishes into Review. Most cases name the Warrant
 * (`via: 'warrant'` and its id) to pin the fixture; one sends the daemon's
 * EXACT implement body (`DAEMON_IMPLEMENT_MINT`, which names neither, so the
 * board auto-selects the one Warrant containing the Task) and proves the same
 * claim and finish (S5 review leftover, owner ruling E462).
 *
 * Two parent Accounts, because the claim admission differs between them:
 *   - an ADMINISTRATOR Account (the shape of a person's own connector on a
 *     board they administer);
 *   - an ordinary Account that holds only the READ assignment vehicle (the
 *     `assignedClaimLive` shape).
 * The assertions below are what the board does; the header of each test says
 * which path holds.
 *
 * DESTRUCTIVE: writes principals, credentials, services, warrants, tasks,
 * reports and audit rows. It refuses any deployment database and any non-local
 * host, and FAILS - never skips - without a disposable one.
 */

/* eslint-disable @typescript-eslint/no-var-requires */

import http from 'http';
import crypto from 'crypto';

const TEST_DB_URL = process.env.RELAYHALL_TEST_DB_URL;
if (!TEST_DB_URL) {
  throw new Error('RELAYHALL_TEST_DB_URL is required: the connector run claim drill measures stored claim, Report and '
    + 'credential rows, so it never skips. Load database/init.sql into a disposable database, run npm run migrate, '
    + 'and point RELAYHALL_TEST_DB_URL at it.');
}
const parsed = new URL(TEST_DB_URL);
const TEST_DB_NAME = decodeURIComponent(parsed.pathname.slice(1));
const localDisposable = ['127.0.0.1', 'localhost', '[::1]'].includes(parsed.hostname)
  && /test|contract|fixture/.test(TEST_DB_NAME);
const ciService = process.env.CI === 'true' && parsed.hostname === 'postgres' && TEST_DB_NAME === 'relayhall_ci';
if (!['postgres:', 'postgresql:'].includes(parsed.protocol)
  || ['relayhall', 'relayhall_dev', 'relayhall_tst', 'relayhall_prod'].includes(TEST_DB_NAME)
  || (!localDisposable && !ciService)) {
  throw new Error('Connector run claim drill refuses a non-disposable database target');
}

Object.assign(process.env, {
  DB_HOST: parsed.hostname, DB_PORT: parsed.port || '5432', DB_NAME: TEST_DB_NAME,
  DB_USER: decodeURIComponent(parsed.username), DB_PASSWORD: decodeURIComponent(parsed.password),
  NODE_ENV: 'test', RELAYHALL_SESSIONS: 'on', JWT_SECRET: crypto.randomBytes(32).toString('hex'),
  RELAYHALL_TELEMETRY_PEPPERS: JSON.stringify({ test: crypto.randomBytes(32).toString('base64') }),
  RELAYHALL_TELEMETRY_ACTIVE_PEPPER: 'test',
});

const express = require('express');
const { pool } = require('../db/connection');
const { registerProtectedRoutes } = require('../routeRegistry');
const { authMiddleware } = require('../middleware/auth');
const { sharedAuthorizationMiddleware } = require('../middleware/sharedAuthorization');
const { apiErrorHandler } = require('../utils/apiErrors');
const { jsonBodyOptions } = require('../utils/jsonBodyTypes');
const { principalService } = require('../services/PrincipalService');
const { warrantService } = require('../services/WarrantService');

jest.setTimeout(180_000);

let server: http.Server;
let origin: string;

interface Caller { label: string; principalId: string; headers: Record<string, string> }
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

const tag = (): string => `s5run-${crypto.randomBytes(5).toString('hex')}`;
const key = (label: string): string => `s5run-${label}-${crypto.randomUUID()}`;

// The scopes the connector daemon asks for on an implement run: the Agent working set plus telemetry:write
// (design 6.5 step 4, N16). cli/relayhall_connector_ring.py IMPLEMENT_SCOPES is the same list.
const IMPLEMENT_SCOPES = ['tasks:read', 'tasks:write', 'reports:read', 'reports:write', 'projects:read',
  'phases:read', 'skills:read', 'skills:use', 'telemetry:write'];
// The harness scope set a connector token carries (design 3.1).
const HARNESS_SCOPES = [...IMPLEMENT_SCOPES, 'services:read', 'principals:read'];
// The connector daemon's implement mint body, exactly as cli/relayhall_connector_ring.py mint_body builds it: no
// `via` and no `warrantId`, so the board auto-selects the one live Warrant that contains the Task (and files an
// Approval when none does). cli/test_connector_ring.py reads this literal and compares it with mint_body.
const DAEMON_IMPLEMENT_MINT = (taskId: string) => ({
  targetTaskId: taskId, requestedScopes: IMPLEMENT_SCOPES, role: 'implementer', label: 'relayhall-connector-implement-run',
});

interface Fixture {
  parent: string; verifier: string; connector: Caller; serviceId: string; taskId: string; epoch: string;
  warrantId: string;
}

async function human(role: string): Promise<string> {
  const row = await pool.query(
    "INSERT INTO principals(kind,handle,display_name,status,role) VALUES('human',$1,$1,'active',$2) RETURNING id",
    [tag(), role]);
  return String(row.rows[0].id);
}

/**
 * A published Connector under `parentRole`, one Task assigned to it (armed, todo, an independent human Verifier),
 * and a Warrant the Connector holds, anchored on that Task, whose ceiling is the implement scope set.
 * `readVehicleOnly`: the parent Account holds nothing on the Task but the READ assignment vehicle.
 */
async function assignedFixture(parentRole: string, readVehicleOnly: boolean): Promise<Fixture> {
  const parent = await human(parentRole);
  const verifier = await human('user');
  const principal = String((await pool.query(
    `INSERT INTO principals(kind,handle,status,parent_principal_id,purpose,own_expression)
     VALUES('service',$1,'active',$2,'Connector run claim fixture',$3) RETURNING id`,
    [tag(), parent, JSON.stringify({ scopes: 'parent', objects: 'parent' })])).rows[0].id);
  const serviceId = crypto.randomUUID();
  await pool.query(`INSERT INTO services(id,slug,name,kind,status,principal_id,current_descriptor_version)
    VALUES($1,$2,$2,'connector','published',$3,1)`, [serviceId, tag(), principal]);
  await pool.query(`INSERT INTO service_descriptor_versions(service_id,version,descriptor,content_hash)
    VALUES($1,1,'{"options":[]}'::jsonb,$2)`, [serviceId, 'a'.repeat(64)]);
  const profile = { serviceId, descriptorVersion: 1, options: {} };
  const taskId = String((await pool.query(
    `INSERT INTO tasks(title,status,auto_start,visibility,creator_principal_id,shepherd_principal_id,
       verifier_principal_id,execution_service_id,execution_descriptor_version,execution_profile)
     VALUES($1,'todo',true,'private',$2,$2,$3,$4,1,$5) RETURNING id`,
    [tag(), parent, verifier, serviceId, JSON.stringify(profile)])).rows[0].id);
  if (readVehicleOnly) {
    await pool.query(`INSERT INTO grants(grantee_type,grantee_id,resource_type,resource_id,verb,granted_by_principal_id)
      VALUES('principal',$1,'task',$2,'read',$1)`, [parent, taskId]);
  }
  const issued = await principalService.issueCredential(
    { principalId: principal, scopes: HARNESS_SCOPES, transport: 'any' }, { handle: 'fixture', authMethod: 'system' });
  const connector: Caller = { label: 'connector', principalId: principal,
    headers: { Authorization: `Bearer ${issued.fullKey}` } };
  const adminId = await human('admin');
  const warrant = await warrantService.create({
    name: `S5 run claim ${tag()}`, holderPrincipalId: principal,
    anchors: [{ anchorType: 'task', anchorId: taskId }],
    ceilingRules: [{ resourceType: 'task', selectorForm: 'exact', selectorIds: [taskId], verbs: ['read', 'write'] }],
    ceilingScopes: IMPLEMENT_SCOPES, expiresAt: new Date(Date.now() + 3600_000).toISOString(),
  }, { principalId: adminId, isRoot: true, stepUp: { tokenId: 'fixture', method: 'password' } },
  { principalId: adminId, handle: 's5-fixture', authMethod: 'system' });
  const epoch = String((await pool.query(
    'SELECT epoch::text FROM task_native_assignment_epochs WHERE task_id=$1', [taskId])).rows[0].epoch);
  return { parent, verifier, connector, serviceId, taskId, epoch, warrantId: String(warrant.id) };
}

interface MintedAgent { caller: Caller; credentialId: string; role: string; boundTaskId: string; scopes: string[] }

/** The daemon's mint: the Connector's own bearer, under its Warrant, role implementer, the implement scope set. */
async function mint(f: Fixture): Promise<MintedAgent> {
  const minted = await call(f.connector, 'POST', '/delegation/agent-mints', {
    targetTaskId: f.taskId, requestedScopes: IMPLEMENT_SCOPES, role: 'implementer', via: 'warrant',
    warrantId: f.warrantId, label: 'relayhall-connector-run',
  }, { 'Idempotency-Key': key('mint') });
  expect([minted.status, minted.json?.path, minted.json?.code]).toEqual([201, 'warrant', undefined]);
  const pack = minted.json.pack;
  return {
    caller: { label: 'agent', principalId: String(pack.principalId),
      headers: { Authorization: `Bearer ${pack.secretOnce}` } },
    credentialId: String(pack.credentialId), role: String(pack.role), boundTaskId: String(pack.boundTaskId),
    scopes: [...pack.scopes].sort(),
  };
}

async function ownerOf(taskId: string): Promise<{ owner: string | null; status: string }> {
  const row = (await pool.query('SELECT owner_principal_id, status FROM tasks WHERE id=$1', [taskId])).rows[0];
  return { owner: row.owner_principal_id ? String(row.owner_principal_id) : null, status: String(row.status) };
}

interface Worked { move: number; report: number; finish: number; reportCode: string | null; finishCode: string | null }

/** The work an implement run does after the claim, under the Agent: move, Report, finish. */
async function work(agent: Caller, taskId: string): Promise<Worked> {
  const move = await call(agent, 'PATCH', `/tasks/${taskId}`, { status: 'in-progress' }, { 'Idempotency-Key': key('move') });
  const report = await call(agent, 'POST', `/tasks/${taskId}/reports`,
    { title: 'S5 run report', content: 'The connector run did the work.', summary: 'connector run' },
    { 'Idempotency-Key': key('report') });
  const reportId = report.json?.report?.id;
  const finish = await call(agent, 'POST', `/tasks/${taskId}/finish`, reportId
    ? { reportId, handover: 'Connector run: finished.' } : { handover: 'Connector run: finished.' });
  return { move: move.status, report: report.status, finish: finish.status,
    reportCode: report.json?.code ?? null, finishCode: finish.json?.code ?? null };
}

const observed: Record<string, unknown> = {};

beforeAll(async () => {
  // Schema-only disposable clones need the migration 062/084 fallback identity (no credential, never a caller).
  await pool.query("INSERT INTO principals(kind,handle,display_name,role) VALUES('human','dashboard_user','Owner','orchestrator') ON CONFLICT(handle) DO NOTHING");
  const app = express();
  app.use(express.json(jsonBodyOptions));
  registerProtectedRoutes((mountPath: string, ...handlers: any[]) => {
    app.use(mountPath, authMiddleware, sharedAuthorizationMiddleware, ...handlers);
  });
  app.use(apiErrorHandler);
  await new Promise<void>((resolve) => { server = app.listen(0, '127.0.0.1', resolve); });
  origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});

afterAll(async () => {
  // The settled answer, printed once for the slice's evidence (codes and statuses only).
  // eslint-disable-next-line no-console
  console.log(`N14 observed: ${JSON.stringify(observed)}`);
  if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  await pool.end();
});

describe('N14: an implementer Agent on a Task assigned to its parent Connector (E462 S5)', () => {
  it('the mint is what the daemon expects: role implementer, bound to the Task, exactly the implement scopes', async () => {
    const f = await assignedFixture('admin', false);
    const agent = await mint(f);
    expect([agent.role, agent.boundTaskId, agent.scopes]).toEqual(['implementer', f.taskId, [...IMPLEMENT_SCOPES].sort()]);
    const row = (await pool.query('SELECT kind, parent_principal_id, bound_task_id FROM principals WHERE id=$1',
      [agent.caller.principalId])).rows[0];
    expect([row.kind, String(row.parent_principal_id), String(row.bound_task_id)])
      .toEqual(['agent', f.connector.principalId, f.taskId]);
  });

  it('read-vehicle parent Account: the implementer mint itself is refused, so no run can start', async () => {
    const f = await assignedFixture('user', true);
    const minted = await call(f.connector, 'POST', '/delegation/agent-mints', {
      targetTaskId: f.taskId, requestedScopes: IMPLEMENT_SCOPES, role: 'implementer', via: 'warrant',
      warrantId: f.warrantId, label: 'relayhall-connector-run',
    }, { 'Idempotency-Key': key('mint') });
    observed['read-vehicle-mint'] = { status: minted.status, code: minted.json?.code ?? null };
    expect(observed['read-vehicle-mint']).toEqual(EXPECTED['read-vehicle-mint']);
  });

  it('administrator parent Account, the Agent claims: the epoch door refuses it, the WRITE door admits it', async () => {
    const f = await assignedFixture('admin', false);
    const agent = await mint(f);
    const view = await call(agent.caller, 'GET', `/tasks/${f.taskId}`);
    // With the epoch, the claim takes the assigned-Connector door, which admits only the Connector itself.
    const epochClaim = await call(agent.caller, 'POST', `/tasks/${f.taskId}/claim`, { expectedAssignmentEpoch: f.epoch });
    // Without it, the ordinary positive-WRITE contract on the Agent's live chain.
    const writeClaim = await call(agent.caller, 'POST', `/tasks/${f.taskId}/claim`, {});
    const record: Record<string, unknown> = {
      agentRead: view.status,
      epochClaim: epochClaim.status, epochClaimCode: epochClaim.json?.code ?? null,
      writeClaim: writeClaim.status, writeClaimCode: writeClaim.json?.code ?? null,
    };
    record.work = writeClaim.status === 200 ? await work(agent.caller, f.taskId) : null;
    const final = await ownerOf(f.taskId);
    record.final = { status: final.status, owner: final.owner === agent.caller.principalId ? 'agent' : 'other' };
    // The run's end (design 6.5 step 6): the Connector revokes its own descendant, and the Agent's next call fails.
    const revoked = await call(f.connector, 'POST', `/credentials/${agent.credentialId}/revoke`, { reason: 'connector run ended' });
    const after = await call(agent.caller, 'GET', `/tasks/${f.taskId}`);
    record.revoke = revoked.status;
    record.afterRevoke = after.status;
    observed['agent-claims'] = record;
    expect(record).toEqual(EXPECTED['agent-claims']);
  });

  it('the daemon\'s exact mint body (no via, no warrantId): the Warrant is auto-selected, the same claim and finish hold', async () => {
    const f = await assignedFixture('admin', false);
    const minted = await call(f.connector, 'POST', '/delegation/agent-mints', DAEMON_IMPLEMENT_MINT(f.taskId),
      { 'Idempotency-Key': `rh-connector-mint-${crypto.randomUUID()}` });
    const pack = minted.json?.pack ?? {};
    const agent: Caller = { label: 'agent', principalId: String(pack.principalId),
      headers: { Authorization: `Bearer ${pack.secretOnce}` } };
    const record: Record<string, unknown> = {
      mint: minted.status, path: minted.json?.path ?? null, code: minted.json?.code ?? null,
      selected: minted.json?.selectedWarrantId === f.warrantId ? 'the containing warrant' : (minted.json?.selectedWarrantId ?? null),
      role: pack.role ?? null, bound: pack.boundTaskId === f.taskId,
      scopes: Array.isArray(pack.scopes) ? [...pack.scopes].sort() : null,
    };
    // The daemon's claim: the Agent, an empty body (the WRITE door), then the run's work and the revoke.
    const claim = await call(agent, 'POST', `/tasks/${f.taskId}/claim`, {});
    record.claim = claim.status;
    record.claimCode = claim.json?.code ?? null;
    record.work = claim.status === 200 ? await work(agent, f.taskId) : null;
    const final = await ownerOf(f.taskId);
    record.final = { status: final.status, owner: final.owner === agent.principalId ? 'agent' : 'other' };
    const revoked = await call(f.connector, 'POST', `/credentials/${pack.credentialId}/revoke`, { reason: 'connector run ended' });
    const after = await call(agent, 'GET', `/tasks/${f.taskId}`);
    record.revoke = revoked.status;
    record.afterRevoke = after.status;
    observed['daemon-body'] = record;
    expect(record).toEqual(EXPECTED['daemon-body']);
  });

  it('administrator parent Account, the design fallback: the Connector claims, the Agent works', async () => {
    const f = await assignedFixture('admin', false);
    const agent = await mint(f);
    const connectorClaim = await call(f.connector, 'POST', `/tasks/${f.taskId}/claim`, { expectedAssignmentEpoch: f.epoch });
    const record: Record<string, unknown> = { connectorClaim: connectorClaim.status };
    record.work = await work(agent.caller, f.taskId);
    const inline = await call(agent.caller, 'POST', `/tasks/${f.taskId}/finish`,
      { report: { title: 'S5 inline', content: 'inline report' }, handover: 'Connector run: finished.' });
    record.inlineFinish = inline.status;
    record.inlineFinishCode = inline.json?.code ?? null;
    const final = await ownerOf(f.taskId);
    record.final = { status: final.status, owner: final.owner === f.connector.principalId ? 'connector' : 'other' };
    observed['connector-claims'] = record;
    expect(record).toEqual(EXPECTED['connector-claims']);
  });
});

// What the board does, settled on a disposable PostgreSQL (24 Oct 2026). The connector daemon follows it: the
// Agent claims with an empty body (the WRITE door); the fallback is never taken, because it cannot hand back.
const EXPECTED: Record<string, unknown> = {
  // A parent Account that holds only the READ assignment vehicle cannot delegate an implementer at all.
  'read-vehicle-mint': { status: 403, code: 'ROLE_EXCEEDS_ASSIGNER' },
  // N14 holds: the minted implementer Agent claims its parent Connector's assigned Task and finishes it into Review.
  // The epoch door is the assigned-Connector door, which admits only the Connector itself.
  'agent-claims': {
    agentRead: 200, epochClaim: 403, epochClaimCode: 'TASK_CLAIM_AUTHORITY_CHANGED', writeClaim: 200, writeClaimCode: null,
    work: { move: 200, report: 201, finish: 200, reportCode: null, finishCode: null },
    final: { status: 'review', owner: 'agent' }, revoke: 200, afterRevoke: 401,
  },
  // The daemon's own body (no via, no warrantId) mints under the auto-selected Warrant, and the run's path holds.
  'daemon-body': {
    mint: 201, path: 'warrant', code: null, selected: 'the containing warrant', role: 'implementer', bound: true,
    scopes: [...IMPLEMENT_SCOPES].sort(), claim: 200, claimCode: null,
    work: { move: 200, report: 201, finish: 200, reportCode: null, finishCode: null },
    final: { status: 'review', owner: 'agent' }, revoke: 200, afterRevoke: 401,
  },
  // The design fallback does not hold: the Agent is not the claimant, so it can neither save the Task Report nor
  // finish, with or without an inline Report.
  'connector-claims': {
    connectorClaim: 200,
    work: { move: 200, report: 403, finish: 400, reportCode: 'TASK_CLAIMANT_REQUIRED', finishCode: 'REPORT_REQUIRED' },
    inlineFinish: 403, inlineFinishCode: 'TASK_ROLE_REQUIRED',
    final: { status: 'in-progress', owner: 'connector' },
  },
};
