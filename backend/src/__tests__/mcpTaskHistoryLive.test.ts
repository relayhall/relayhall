/** P2-C: real PostgreSQL, real MCP in-process ingress and shared authorization. */
import crypto from 'crypto';

const url = process.env.RELAYHALL_TEST_DB_URL;
if (!url) throw new Error('RELAYHALL_TEST_DB_URL is required');
const parsed = new URL(url);
const database = decodeURIComponent(parsed.pathname.slice(1));
const localFixture = ['localhost', '127.0.0.1'].includes(parsed.hostname)
  && database === 'relayhall_native_review_test';
const ciFixture = process.env.CI === 'true' && parsed.hostname === 'postgres'
  && database === 'relayhall_ci' && parsed.username === 'relayhall_ci';
if (!['postgres:', 'postgresql:'].includes(parsed.protocol) || !(localFixture || ciFixture)) {
  throw new Error('Disposable local or CI test database only');
}
Object.assign(process.env, {
  DB_HOST: parsed.hostname, DB_PORT: parsed.port, DB_NAME: database,
  DB_USER: decodeURIComponent(parsed.username), DB_PASSWORD: decodeURIComponent(parsed.password),
  NODE_ENV: 'test', JWT_SECRET: crypto.randomBytes(32).toString('hex'),
});

const { pool } = require('../db/connection');
const { principalService } = require('../services/PrincipalService');
const { toolByName } = require('../mcp/registry');
const tag = () => `p2c-${crypto.randomBytes(6).toString('hex')}`;
// Real credential issuance (password hashing) and PostgreSQL in beforeAll: the
// default 5 s hook budget fails on a loaded runner before any assertion runs.
jest.setTimeout(180_000);

let taskId: string;
let owner: string;
let shepherd: string;
let verifier: string;
let limited: string;
let outsider: string;
let noScope: string;
let revocable: string;
let revocableCredentialId: string;

async function caller(scopes: string[]) {
  const account = (await pool.query(
    "INSERT INTO principals(kind,handle,display_name,status,role) VALUES('human',$1,$1,'active','user') RETURNING id", [tag()],
  )).rows[0];
  const principal = (await pool.query(
    "INSERT INTO principals(kind,handle,status,parent_principal_id,purpose,own_expression) VALUES('service',$1,'active',$2,'Disposable P2-C history proof',$3) RETURNING id",
    [tag(), account.id, JSON.stringify({ scopes: 'parent', objects: 'parent' })],
  )).rows[0];
  const issued = await principalService.issueCredential(
    { principalId: principal.id, scopes, transport: 'any' },
    { handle: 'p2c-disposable', authMethod: 'system' },
  );
  return { id: principal.id as string, accountId: account.id as string, bearer: `Bearer ${issued.fullKey}`, credentialId: issued.credentialId as string };
}

function call(tool: string, bearer: string, args: Record<string, unknown> = {}) {
  return toolByName(tool).handler({ task: taskId, ...args }, { authorization: bearer, toolName: tool });
}

beforeAll(async () => {
  await pool.query("INSERT INTO principals(kind,handle,display_name,role) VALUES('human','dashboard_user','Owner','orchestrator') ON CONFLICT(handle) DO NOTHING");
  const ownerActor = await caller(['tasks:read']);
  const shepherdActor = await caller(['tasks:read']);
  const verifierActor = await caller(['tasks:read']);
  const limitedActor = await caller(['tasks:read']);
  const outsiderActor = await caller(['tasks:read']);
  const noScopeActor = await caller(['principals:read']);
  const revocableActor = await caller(['tasks:read']);
  owner = ownerActor.bearer; shepherd = shepherdActor.bearer; verifier = verifierActor.bearer;
  limited = limitedActor.bearer;
  outsider = outsiderActor.bearer; noScope = noScopeActor.bearer;
  revocable = revocableActor.bearer; revocableCredentialId = revocableActor.credentialId;

  taskId = (await pool.query(
    "INSERT INTO tasks(title,status,owner_principal_id,shepherd_principal_id,verifier_principal_id,creator_principal_id) VALUES($1,'in-progress',$2,$3,$4,$2) RETURNING id",
    [tag(), ownerActor.id, shepherdActor.id, verifierActor.id],
  )).rows[0].id;
  for (const grantee of [ownerActor.accountId, shepherdActor.accountId, shepherdActor.id, verifierActor.accountId, verifierActor.id, limitedActor.accountId, limitedActor.id, revocableActor.accountId, revocableActor.id]) await pool.query(
    "INSERT INTO grants(grantee_type,grantee_id,resource_type,resource_id,verb,granted_by_principal_id) VALUES('principal',$1,'task',$2,'read',$3)",
    [grantee, taskId, ownerActor.id],
  );
  const ordinary = (await pool.query(
    "INSERT INTO task_stream_entries(task_id,event_type,provenance,content,author_principal_id,author_handle,author_role) VALUES($1,'activity','authored','VISIBLE_P2C',$2,'owner','claimant') RETURNING id",
    [taskId, ownerActor.id],
  )).rows[0].id;
  const restricted = (await pool.query(
    "INSERT INTO task_stream_entries(task_id,event_type,provenance,content,author_principal_id,author_handle,author_role,outpost_visibility_tier) VALUES($1,'activity','authored','RESTRICTED_P2C',$2,'owner','claimant','assigned-only') RETURNING id",
    [taskId, ownerActor.id],
  )).rows[0].id;
  await pool.query(
    "INSERT INTO task_stream_entries(task_id,event_type,provenance,content,author_principal_id,author_handle,author_role,referenced_entry_id) VALUES($1,'activity','authored','CHILD_P2C',$2,'owner','claimant',$3)",
    [taskId, ownerActor.id, restricted],
  );
  expect(ordinary).toBeTruthy();
});
afterAll(async () => { await pool.end(); });

test('Task owner, shepherd and verifier see all; limited reader loses assigned-only ancestor and child', async () => {
  for (const name of ['relayhall_task_stream_list', 'relayhall_task_timeline_get']) {
    for (const actor of [owner, shepherd, verifier]) {
      const full = await call(name, actor, { response_format: 'detailed' });
      expect(full).toContain('VISIBLE_P2C');
      expect(full).toContain('RESTRICTED_P2C');
      expect(full).toContain('CHILD_P2C');
    }
    const narrowed = await call(name, limited, { response_format: 'detailed' });
    expect(narrowed).toContain('VISIBLE_P2C');
    expect(narrowed).not.toContain('RESTRICTED_P2C');
    expect(narrowed).not.toContain('CHILD_P2C');
  }
});

test('missing scope, unreadable Task, and revoked credential refuse both readers without payload', async () => {
  for (const name of ['relayhall_task_stream_list', 'relayhall_task_timeline_get']) {
    await expect(call(name, noScope)).rejects.toThrow(/HTTP 403/);
    await expect(call(name, outsider)).rejects.toThrow(/HTTP 404/);
  }
  await pool.query('UPDATE principal_credentials SET revoked_at=NOW() WHERE id=$1', [revocableCredentialId]);
  for (const name of ['relayhall_task_stream_list', 'relayhall_task_timeline_get']) {
    await expect(call(name, revocable)).rejects.toThrow(/HTTP 401|HTTP 403/);
  }
});

test('timeline reader preserves route-level typed filter and cursor validation', async () => {
  await expect(call('relayhall_task_timeline_get', owner, { filter: 'bogus' }))
    .rejects.toThrow(/HTTP 400.*INVALID_FILTER/);
  await expect(call('relayhall_task_timeline_get', owner, { before: 'not-a-cursor' }))
    .rejects.toThrow(/HTTP 400.*INVALID_CURSOR/);
});
