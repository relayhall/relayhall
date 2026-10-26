/**
 * Card a9b1e69c — AZ-A12 build 5 (amendment AZ-A12 clauses 12 and 13, and
 * D-16; ratified E72): the hub ownership class order, the owner fields and the
 * feed fan-out, over a REAL migrated PostgreSQL and the PRODUCTION router.
 *
 *   (1) the hub (`GET /approvals?view=hub`): the OWNER COLUMN decides `group`
 *       first — a Group-owned project lists under its owning Group, marked
 *       basis `owner`, that Group first; a live Group grant is the FALLBACK
 *       for a person-owned project, basis `grant`; shared, private and board
 *       are unchanged; every class carries the owner's kind;
 *   (2) the AZ-A9 decider view (`GET /approvals/:id`, D-16) orders its class
 *       the same way: Group-owned with no Group grant → `group` by its owner;
 *       person-owned with a live exact-id Group grant → `group` by the
 *       fallback; neither → `private`;
 *   (3) `ownerKind` and `ownerDisplayName` on the Project record (point and
 *       list), on the Task account-owner read (the EFFECTIVE owner) and in the
 *       OpenAPI, whose Project schema the answer matches key for key;
 *   (4) the feed's transition-event owner basis resolves a Group owner through
 *       active membership (the clause-6 use-tier fragment): its members and
 *       managers read the event, a non-member does not, and a disabled Group
 *       reaches nobody; the owner-change socket hint fans out to the active
 *       members of the Group, and a person-to-person transfer still tells
 *       exactly the two owners;
 *   (5) the bell's "My work" counts Group ownership at the EDIT tier only: a
 *       manager's My work lists a status move on a Group-owned Task, a plain
 *       member's does not (it is under "Everything I can see"), and the unread
 *       count follows;
 *   (6) build 4 (card 1942926f, M-c): G.2 drill 1's SKILL rows on a
 *       fixture-written Group owner — member reads and uses, manager and
 *       owner-role holder write and submit, nobody here publishes or sets the
 *       audience, a non-member gets nothing, a viewer manager never writes.
 *
 * Group ownership is written by fixture where the act is not under test, as
 * the build 2 suite does; the transfers in (4) run through the real act.
 *
 * DESTRUCTIVE: writes principals, sessions, services, credentials, groups,
 * members, steward rows, projects, tasks, grants, approvals, step-up tokens and
 * feed rows. It refuses any deployment database and any non-local host, and
 * FAILS - never skips - without a disposable one.
 */

/* eslint-disable @typescript-eslint/no-var-requires */

import http from 'http';
import crypto from 'crypto';

const TEST_DB_URL = process.env.RELAYHALL_TEST_DB_URL;
if (!TEST_DB_URL) {
  throw new Error('RELAYHALL_TEST_DB_URL is required: the Group ownership hub drill measures stored rows, so it never skips. '
    + 'Load database/init.sql into a disposable database, run npm run migrate, and point RELAYHALL_TEST_DB_URL at it.');
}
const parsed = new URL(TEST_DB_URL);
const TEST_DB_NAME = decodeURIComponent(parsed.pathname.slice(1));
const localDisposable = ['127.0.0.1', 'localhost', '[::1]'].includes(parsed.hostname)
  && /test|contract|fixture/.test(TEST_DB_NAME);
const ciService = process.env.CI === 'true' && parsed.hostname === 'postgres' && TEST_DB_NAME === 'relayhall_ci';
if (!['postgres:', 'postgresql:'].includes(parsed.protocol)
  || ['relayhall', 'relayhall_dev', 'relayhall_tst', 'relayhall_prod'].includes(TEST_DB_NAME)
  || (!localDisposable && !ciService)) {
  throw new Error('Group ownership hub drill refuses a non-disposable database target');
}

Object.assign(process.env, {
  DB_HOST: parsed.hostname, DB_PORT: parsed.port || '5432', DB_NAME: TEST_DB_NAME,
  DB_USER: decodeURIComponent(parsed.username), DB_PASSWORD: decodeURIComponent(parsed.password),
  NODE_ENV: 'test', RELAYHALL_SESSIONS: 'on', JWT_SECRET: crypto.randomBytes(32).toString('hex'),
  // Several pending requests from one connector: lift the per-connector quota
  // (read at import) so the drill measures the classes, not the quota.
  RELAYHALL_APPROVAL_QUOTA_PENDING: '50', RELAYHALL_APPROVAL_QUOTA_DAILY: '200',
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
const { feedEventService } = require('../services/FeedEventService');
const { setProjectOwnerInvalidationSink } = require('../services/ProjectOwnershipService');
const { buildOpenApiSpec } = require('../openapi/spec');
const { insertGroupRow } = require('./support/groupRows');

jest.setTimeout(180_000);

let server: http.Server;
let origin: string;

function buildApp(): any {
  const app = express();
  app.use(express.json(jsonBodyOptions));
  registerProtectedRoutes((mountPath: string, ...handlers: any[]) => {
    app.use(mountPath, authMiddleware, sharedAuthorizationMiddleware, ...handlers);
  });
  app.use(apiErrorHandler);
  return app;
}

interface Caller { label: string; principalId: string; headers: Record<string, string> }
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

const tag = (): string => crypto.randomBytes(5).toString('hex');
const FOUR_SCOPES = ['tasks:read', 'tasks:write', 'reports:read', 'reports:write'];
const REASON = 'Group owner hub drill: the run needs to read the referenced card to finish its handover.';

async function makeAccount(role: string, label: string): Promise<string> {
  const result = await pool.query(
    `INSERT INTO principals (kind, handle, display_name, status, role) VALUES ('human', $1, $2, 'active', $3) RETURNING id`,
    [`aza12b5-${label}-${tag()}`, `AZ-A12 b5 ${label}`, role],
  );
  return String(result.rows[0].id);
}

async function sessionFor(label: string, principalId: string): Promise<Caller> {
  const minted = await loginSessionService.mint({ principalId });
  return { label, principalId, headers: { Cookie: `${SESSION_COOKIE_NAME}=${minted.token}` } };
}

async function registerConnector(owner: Caller): Promise<Caller> {
  const slug = `aza12b5-connector-${tag()}`;
  const registered = await call(owner, 'POST', '/services', {
    slug, name: slug, description: 'Group owner hub drill connector.', kind: 'connector',
    issueCredential: { scopes: FOUR_SCOPES, label: slug, transport: 'api' },
  });
  expect(registered.status).toBe(201);
  const row = await pool.query('SELECT principal_id FROM services WHERE slug = $1', [slug]);
  return {
    label: slug, principalId: String(row.rows[0].principal_id),
    headers: { Authorization: `Bearer ${registered.json.onboarding.credential.secretOnce}` },
  };
}

async function requestMint(connector: Caller, targetTaskId: string): Promise<string> {
  const requested = await call(connector, 'POST', '/delegation/agent-mints',
    { targetTaskId, requestedScopes: FOUR_SCOPES, via: 'approval' }, { 'Idempotency-Key': `aza12b5-mint-${crypto.randomUUID()}` });
  expect([requested.status, requested.json?.path]).toEqual([202, 'approval']);
  return String(requested.json.approval.id);
}

async function requestGrant(connector: Caller, relatedTaskId: string, askedFor: string): Promise<string> {
  const filed = await call(connector, 'POST', '/delegation/access-requests', {
    kind: 'grant', reason: REASON, relatedTaskId,
    requestedRules: [{ resourceType: 'task', selectorForm: 'exact', selectorIds: [askedFor], verbs: ['read'] }],
  });
  expect(filed.status).toBe(202);
  return String(filed.json.approval.id);
}

async function project(owner: Caller, label: string): Promise<string> {
  const created = await call(owner, 'POST', '/projects', { name: `AZ-A12 b5 ${label} ${tag()}` });
  expect(created.status).toBe(201);
  return String(created.json.project.id);
}

async function task(owner: Caller, title: string, projectId?: string): Promise<string> {
  const created = await call(owner, 'POST', '/tasks', { title, description: 'group owner hub drill', status: 'todo', ...(projectId ? { project: projectId } : {}) });
  expect(created.status).toBe(201);
  return String(created.json.task.id);
}

/** The fixture write of a Group owner (the transfer act is not under test here). */
async function ownBy(projectId: string, ownerId: string | null): Promise<void> {
  await pool.query('UPDATE projects SET owner_principal_id = $2 WHERE id = $1', [projectId, ownerId]);
}

async function groupGrant(groupId: string, projectId: string): Promise<void> {
  await pool.query(
    `INSERT INTO grants (grantee_type, grantee_id, resource_type, resource_id, verb, origin)
     VALUES ('group', $1, 'project', $2, 'read', 'manual')`,
    [groupId, projectId],
  );
}

async function join(groupId: string, accountId: string): Promise<void> {
  await pool.query("INSERT INTO group_members (group_id, account_principal_id, source) VALUES ($1, $2, 'local')", [groupId, accountId]);
}

/** Append a status move exactly as an emitting write does: inside a transaction, through the feed service. */
async function moveStatus(taskId: string, projectId: string, actor: Caller): Promise<string> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await feedEventService.emit(client, {
      name: 'task.updated', objectType: 'task', objectId: taskId, projectId,
      payload: { status: 'in-progress', previousStatus: 'todo' },
      actorPrincipalId: actor.principalId, actorHandle: actor.label,
    });
    const cursor = await client.query(
      `SELECT max(cursor)::text AS cursor FROM feed_events WHERE object_id = $1 AND name = 'task.updated'`, [taskId]);
    await client.query('COMMIT');
    return `feed:${cursor.rows[0].cursor}`;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

async function moveProject(who: Caller, projectId: string, ownerId: string | null, stepUp: boolean): Promise<Answer> {
  const revision = (await pool.query('SELECT revision FROM projects WHERE id = $1', [projectId])).rows[0].revision;
  const token = stepUp ? (await stepUpService.mint(who.principalId, 'ownership.transfer', projectId, 'password')).token : undefined;
  return call(who, 'PUT', `/projects/${projectId}/owner`,
    token === undefined ? { ownerPrincipalId: ownerId } : { ownerPrincipalId: ownerId, stepUpToken: token },
    { 'If-Match': String(revision) });
}

const hub = (who: Caller, query = '') => call(who, 'GET', `/approvals?view=hub${query ? `&${query}` : ''}`);
const byId = (answer: Answer, id: string) => answer.json.approvals.find((item: any) => item.id === id);
const history = (who: Caller, query: string) => call(who, 'GET', `/tasks/notifications?${query}`);
/** Every feed event this caller may read after `cursor`, page by page. */
const feedSince = async (who: Caller, cursor: string): Promise<any[]> => {
  const events: any[] = [];
  let after = cursor;
  for (;;) {
    const answer = await call(who, 'GET', `/events?cursor=${after}&limit=500`);
    expect(answer.status).toBe(200);
    events.push(...answer.json.events);
    if (answer.json.nextCursor === after) return events;
    after = answer.json.nextCursor;
  }
};

let OWNER: Caller;
let OTHER: Caller;
let MEMBER: Caller;
let MANAGER: Caller;
let OUTSIDER: Caller;
let ROOT: Caller;
let CONNECTOR: Caller;
let INACTIVE_ID: string;
let G: string;            // the owning Group (MEMBER, MANAGER as manager, INACTIVE disabled)
let G_NAME: string;
let H: string;            // a Group with grants only
let H_NAME: string;
let G_OFF: string;        // a Group whose principal is disabled after its project moves out
let P_OWNED: string;      // owned by G, and a live H grant
let P_OWNED_ONLY: string; // owned by G, no Group grant
let P_GRANTED: string;    // owned by OWNER, a live H grant
let P_SHARED: string;     // owned by OWNER, shared
let P_PRIVATE: string;    // owned by OWNER
let P_UNOWNED: string;    // no owner at all
let T_OWNED_ONLY: string; // a Task in P_OWNED_ONLY with no explicit account owner
let T_PRIVATE: string;
const MINT: Record<'owned' | 'granted' | 'shared' | 'private' | 'board', string> = {} as any;
const GRANT: Record<'ownedOnly' | 'granted' | 'private', string> = {} as any;

// (4): the transfers through the real act, and what each told.
let FEED_CURSOR: string;
let P_FEED: string;       // moved out of G to OWNER by root
let P_OFF: string;        // moved out of G_OFF to OWNER by root; then G_OFF is disabled
let P_PERSON: string;     // moved from OWNER to OTHER by root
const TOLD: Array<{ projectId: string; recipients: string[] }> = [];

beforeAll(async () => {
  await new Promise<void>((resolve) => { server = buildApp().listen(0, '127.0.0.1', resolve); });
  origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  OWNER = await sessionFor('owner', await makeAccount('user', 'owner'));
  OTHER = await sessionFor('other', await makeAccount('user', 'other'));
  MEMBER = await sessionFor('member', await makeAccount('user', 'member'));
  MANAGER = await sessionFor('manager', await makeAccount('user', 'manager'));
  OUTSIDER = await sessionFor('outsider', await makeAccount('user', 'outsider'));
  ROOT = await sessionFor('root', await makeAccount('admin', 'root'));
  INACTIVE_ID = await makeAccount('user', 'inactive');
  CONNECTOR = await registerConnector(OWNER);

  G_NAME = `aza12b5 owning ${tag()}`;
  G = await insertGroupRow(pool, { name: G_NAME, description: 'AZ-A12 build 5 drill', featured: false });
  H_NAME = `aza12b5 granted ${tag()}`;
  H = await insertGroupRow(pool, { name: H_NAME, description: 'AZ-A12 build 5 drill', featured: false });
  G_OFF = await insertGroupRow(pool, { name: `aza12b5 disabled ${tag()}`, description: 'AZ-A12 build 5 drill', featured: false });
  for (const account of [MEMBER.principalId, MANAGER.principalId, INACTIVE_ID]) await join(G, account);
  await join(G_OFF, MEMBER.principalId);
  await pool.query('INSERT INTO group_stewards (group_id, account_principal_id, role) VALUES ($1, $2, $3)', [G, MANAGER.principalId, 'manager']);
  await pool.query(`UPDATE principals SET status = 'disabled' WHERE id = $1`, [INACTIVE_ID]);

  P_OWNED = await project(OWNER, 'owned');
  P_OWNED_ONLY = await project(OWNER, 'owned-only');
  P_GRANTED = await project(OWNER, 'granted');
  P_SHARED = await project(OWNER, 'shared');
  P_PRIVATE = await project(OWNER, 'private');
  P_UNOWNED = await project(OWNER, 'unowned');
  await pool.query(`UPDATE projects SET visibility = 'shared' WHERE id = $1`, [P_SHARED]);
  await groupGrant(H, P_OWNED);
  await groupGrant(H, P_GRANTED);

  const tOwned = await task(OWNER, `b5 owned ${tag()}`, P_OWNED);
  T_OWNED_ONLY = await task(OWNER, `b5 owned-only ${tag()}`, P_OWNED_ONLY);
  const tGranted = await task(OWNER, `b5 granted ${tag()}`, P_GRANTED);
  const tShared = await task(OWNER, `b5 shared ${tag()}`, P_SHARED);
  T_PRIVATE = await task(OWNER, `b5 private ${tag()}`, P_PRIVATE);
  const tBoard = await task(OWNER, `b5 board ${tag()}`);
  const askedFor = await task(OUTSIDER, `b5 asked-for ${tag()}`);

  MINT.owned = await requestMint(CONNECTOR, tOwned);
  MINT.granted = await requestMint(CONNECTOR, tGranted);
  MINT.shared = await requestMint(CONNECTOR, tShared);
  MINT.private = await requestMint(CONNECTOR, T_PRIVATE);
  MINT.board = await requestMint(CONNECTOR, tBoard);
  GRANT.ownedOnly = await requestGrant(CONNECTOR, T_OWNED_ONLY, askedFor);
  GRANT.granted = await requestGrant(CONNECTOR, tGranted, askedFor);
  GRANT.private = await requestGrant(CONNECTOR, T_PRIVATE, askedFor);

  // Ownership by fixture, after the requests were filed through the creator's own access.
  await ownBy(P_OWNED, G);
  await ownBy(P_OWNED_ONLY, G);
  await ownBy(P_UNOWNED, null);
  // A Task with no explicit account owner (as every Task created before the
  // creation-account record), so it takes its Project's owner: clause 7(a).
  await pool.query('UPDATE tasks SET account_owner_principal_id = NULL WHERE id = $1', [T_OWNED_ONLY]);

  // (4) The transfers, through the real act, with the socket hint captured.
  setProjectOwnerInvalidationSink((recipients: string[]) => {
    TOLD.push({ projectId: '', recipients: [...recipients] });
  });
  FEED_CURSOR = String((await pool.query('SELECT COALESCE(max(cursor), 0)::text AS c FROM feed_events')).rows[0].c);
  P_FEED = await project(OWNER, 'feed');
  P_OFF = await project(OWNER, 'feed-off');
  P_PERSON = await project(OWNER, 'feed-person');
  await ownBy(P_FEED, G);
  await ownBy(P_OFF, G_OFF);
  for (const [projectId, target, stepUp] of [[P_FEED, OWNER.principalId, true], [P_OFF, OWNER.principalId, true],
    [P_PERSON, OTHER.principalId, false]] as Array<[string, string, boolean]>) {
    const moved = await moveProject(ROOT, projectId, target, stepUp);
    expect([projectId, moved.status]).toEqual([projectId, 200]);
    TOLD[TOLD.length - 1].projectId = projectId;
  }
  await pool.query(`UPDATE principals SET status = 'disabled' WHERE id = $1`, [G_OFF]);
});

afterAll(async () => {
  setProjectOwnerInvalidationSink(() => undefined);
  if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  await pool.end();
});

describe('(1) the hub: the owner column decides group first (clause 12, D-16)', () => {
  it('a Group-owned project lists under its owning Group, marked owner, before any granted Group', async () => {
    const item = byId(await hub(OWNER), MINT.owned);
    expect(item.ownership).toEqual({
      class: 'group', basis: 'owner', ownerKind: 'group', ownerHandle: null, ownerIsViewer: false,
      groups: [{ id: G, name: G_NAME, basis: 'owner' }, { id: H, name: H_NAME, basis: 'grant' }],
    });
  });

  it('a person-owned project with a live Group grant is group by the fallback, marked grant', async () => {
    const item = byId(await hub(OWNER), MINT.granted);
    expect(item.ownership).toEqual({
      class: 'group', basis: 'grant', ownerKind: 'human', ownerHandle: null, ownerIsViewer: false,
      groups: [{ id: H, name: H_NAME, basis: 'grant' }],
    });
  });

  it('shared, private and board are unchanged, each carrying the owner kind', async () => {
    const answer = await hub(OWNER);
    expect(byId(answer, MINT.shared).ownership).toEqual({
      class: 'shared', basis: null, ownerKind: 'human', groups: [], ownerHandle: null, ownerIsViewer: false,
    });
    expect(byId(answer, MINT.private).ownership).toMatchObject({
      class: 'private', basis: null, ownerKind: 'human', groups: [], ownerIsViewer: true,
    });
    expect(byId(answer, MINT.board).ownership).toEqual({
      class: 'board', basis: null, ownerKind: null, groups: [], ownerHandle: null, ownerIsViewer: false,
    });
  });

  it('the group filter by the owning Group id finds the Group-owned item and no other', async () => {
    const answer = await hub(OWNER, `group=${G}`);
    expect(answer.status).toBe(200);
    const ids = answer.json.approvals.map((item: any) => item.id);
    expect(ids).toContain(MINT.owned);
    expect(ids).not.toContain(MINT.granted);
    expect(ids).not.toContain(MINT.private);
  });
});

describe('(2) the AZ-A9 decider view orders its class the same way (D-16)', () => {
  const related = async (approvalId: string) => {
    const answer = await call(ROOT, 'GET', `/approvals/${approvalId}`);
    expect(answer.status).toBe(200);
    return answer.json.decision.related.project;
  };

  it('a Group-owned project with no Group grant on it is group by its owner', async () => {
    expect(await related(GRANT.ownedOnly)).toEqual({
      id: P_OWNED_ONLY, title: expect.any(String), ownerPrincipalId: G, ownerKind: 'group', ownerDisplayName: G_NAME,
      ownershipClass: 'group', ownershipBasis: 'owner', groups: [{ id: G, name: G_NAME, basis: 'owner' }],
    });
  });

  it('a person-owned project with a live exact-id Group grant is group by the fallback', async () => {
    expect(await related(GRANT.granted)).toEqual({
      id: P_GRANTED, title: expect.any(String), ownerPrincipalId: OWNER.principalId, ownerKind: 'human',
      ownerDisplayName: 'AZ-A12 b5 owner', ownershipClass: 'group', ownershipBasis: 'grant',
      groups: [{ id: H, name: H_NAME, basis: 'grant' }],
    });
  });

  it('a person-owned project with neither is private', async () => {
    expect(await related(GRANT.private)).toMatchObject({
      id: P_PRIVATE, ownerKind: 'human', ownershipClass: 'private', ownershipBasis: null, groups: [],
    });
  });
});

describe('(3) owner fields on the Project, the Task account-owner read and the OpenAPI (clause 12)', () => {
  it('GET /projects/:id names a Group owner by kind and name, a person by kind and display name, and no owner by nulls', async () => {
    const read = async (id: string) => {
      const answer = await call(ROOT, 'GET', `/projects/${id}`);
      expect(answer.status).toBe(200);
      const p = answer.json.project;
      return [p.ownerPrincipalId, p.ownerKind, p.ownerDisplayName];
    };
    expect(await read(P_OWNED)).toEqual([G, 'group', G_NAME]);
    expect(await read(P_PRIVATE)).toEqual([OWNER.principalId, 'human', 'AZ-A12 b5 owner']);
    expect(await read(P_UNOWNED)).toEqual([null, null, null]);
  });

  it('the project list carries the same owner fields', async () => {
    const answer = await call(ROOT, 'GET', '/projects');
    expect(answer.status).toBe(200);
    const listed = (answer.json.projects as any[]).filter((p) => [P_OWNED, P_PRIVATE, P_UNOWNED].includes(p.id))
      .map((p) => [p.id, p.ownerKind, p.ownerDisplayName]).sort();
    expect(listed).toEqual([
      [P_OWNED, 'group', G_NAME], [P_PRIVATE, 'human', 'AZ-A12 b5 owner'], [P_UNOWNED, null, null],
    ].sort());
  });

  it('the Task account-owner read names the effective owner: a Group through its Project, a person explicitly', async () => {
    const owned = await call(MANAGER, 'GET', `/tasks/${T_OWNED_ONLY}/account-owner`);
    expect(owned.status).toBe(200);
    expect(owned.json.ownership).toMatchObject({
      taskId: T_OWNED_ONLY, accountOwnerPrincipalId: G, explicitAccountOwnerPrincipalId: null,
      ownerKind: 'group', ownerDisplayName: G_NAME,
    });
    const person = await call(OWNER, 'GET', `/tasks/${T_PRIVATE}/account-owner`);
    expect(person.json.ownership).toMatchObject({ accountOwnerPrincipalId: OWNER.principalId, ownerKind: 'human', ownerDisplayName: 'AZ-A12 b5 owner' });
  });

  it('the OpenAPI Project schema and the account-owner read require ownerKind and ownerDisplayName, and a Project answer has exactly the schema keys', async () => {
    const spec = buildOpenApiSpec() as any;
    const schema = spec.components.schemas.Project;
    expect(schema.required).toEqual(expect.arrayContaining(['ownerKind', 'ownerDisplayName']));
    expect(schema.properties.ownerKind).toMatchObject({ enum: ['human', 'group'], nullable: true });
    const read = spec.paths['/tasks/{id}/account-owner'].get.responses['200'].content['application/json'].schema;
    expect(read.properties.ownership.required).toEqual(expect.arrayContaining(['ownerKind', 'ownerDisplayName']));
    const answer = await call(ROOT, 'GET', `/projects/${P_OWNED}`);
    const keys = Object.keys(answer.json.project).filter((key) => !/^blueprint|^instantiat/.test(key)).sort();
    expect(keys).toEqual(Object.keys(schema.properties).filter((key) => !/^blueprint|^instantiat/.test(key)).sort());
  });
});

describe('(4) the feed owner basis and the owner-change socket fan out to members (clause 13)', () => {
  const aclEvents = (events: any[], projectId: string) =>
    events.filter((event) => event.name === 'project.acl_changed' && event.objectId === projectId);

  it('a Group-owner transition event reaches the Group\'s members and managers, never a non-member', async () => {
    for (const who of [MEMBER, MANAGER]) {
      const seen = aclEvents(await feedSince(who, FEED_CURSOR), P_FEED);
      expect([who.label, seen.map((event) => event.ownerPrincipalId)]).toEqual([who.label, [G]]);
    }
    expect(aclEvents(await feedSince(OUTSIDER, FEED_CURSOR), P_FEED)).toEqual([]);
  });

  it('a disabled Group principal reaches nobody through its recorded ownership', async () => {
    expect(aclEvents(await feedSince(MEMBER, FEED_CURSOR), P_OFF)).toEqual([]);
    // The new owner reads the transfer's event on the live object, as before.
    const owner = aclEvents(await feedSince(OWNER, FEED_CURSOR), P_OFF).filter((event) => event.ownerPrincipalId === G_OFF);
    expect(owner).toHaveLength(1);
  });

  it('the owner-change socket hint fans out to the active members of the prior owning Group', async () => {
    const told = TOLD.find((entry) => entry.projectId === P_FEED);
    expect(told?.recipients).toEqual(expect.arrayContaining([G, OWNER.principalId, MEMBER.principalId, MANAGER.principalId]));
    expect(told?.recipients).not.toContain(OUTSIDER.principalId);
  });

  it('an inactive member of the prior owning Group is not told', async () => {
    const told = TOLD.find((entry) => entry.projectId === P_FEED);
    expect(told?.recipients ?? []).not.toContain(INACTIVE_ID);
  });

  it('a transfer between persons tells exactly the two owners', async () => {
    const told = TOLD.find((entry) => entry.projectId === P_PERSON);
    expect([...(told?.recipients ?? [])].sort()).toEqual([OWNER.principalId, OTHER.principalId].sort());
  });
});

describe('(5) the bell counts Group ownership at the edit tier only (clause 13)', () => {
  let KEY: string;
  beforeAll(async () => {
    KEY = await moveStatus(T_OWNED_ONLY, P_OWNED_ONLY, OWNER);
  });
  const keys = (answer: Answer): string[] => answer.json.notifications.map((n: any) => n.id);

  it('My work lists a status move on a Group-owned Task to its manager', async () => {
    const mine = await history(MANAGER, 'type=status');
    expect(mine.status).toBe(200);
    expect(keys(mine)).toContain(KEY);
  });

  it('a plain member\'s My work leaves it out', async () => {
    expect(keys(await history(MEMBER, 'type=status'))).not.toContain(KEY);
  });

  it('the member still sees it under Everything I can see, and a non-member nowhere', async () => {
    expect(keys(await history(MEMBER, 'type=status&who=all'))).toContain(KEY);
    expect(keys(await history(OUTSIDER, 'type=status&who=all'))).not.toContain(KEY);
    expect(keys(await history(OUTSIDER, 'type=status'))).not.toContain(KEY);
  });

  it('the unread count follows My work: the manager counts it, the member does not', async () => {
    const manager = await history(MANAGER, 'type=status&unread=true');
    expect(keys(manager)).toContain(KEY);
    expect(manager.json.unreadCount).toBe(keys(manager).length);
    const member = await history(MEMBER, 'type=status&unread=true');
    expect(keys(member)).not.toContain(KEY);
    expect(member.json.unreadCount).toBe(0);
  });
});

/**
 * Build 4 (card 1942926f; clause 15 M-c and clause 6's skill row): the column
 * shipped with migration 162 (card d67e6990), and G.2 drill 1's SKILL rows are
 * drilled here, on a fixture-written Group owner, through the real routes:
 * the use tier reads and uses (full SKILL.md), the edit tier writes Versions
 * and submits them for review, nothing reaches publication or the audience
 * (skills:admin), an owner-role holder gets exactly the manager tier, a
 * non-member gets nothing, and a viewer holding a manager row never writes.
 */
describe('(6) drill 1\'s skill rows: a Group-owned Skill by tier (build 4, M-c)', () => {
  let SKILL: string;
  let SKILL_NAME: string;
  let OWNER_ROLE: Caller;
  let VIEWER_MANAGER: Caller;
  const md = (name: string, body: string): string =>
    ['---', `name: ${name}`, 'description: AZ-A12 build 4 drill', '---', '', body, ''].join('\n');
  const revisionOf = async (): Promise<string> =>
    String((await pool.query('SELECT revision::text AS r FROM skills WHERE id = $1', [SKILL])).rows[0].r);
  const newVersion = async (who: Caller, body: string): Promise<Answer> =>
    call(who, 'PUT', `/skills/${SKILL}`, { skill_md: md(SKILL_NAME, body) }, { 'If-Match': await revisionOf() });

  beforeAll(async () => {
    OWNER_ROLE = await sessionFor('owner-role', await makeAccount('user', 'owner-role'));
    VIEWER_MANAGER = await sessionFor('viewer-manager', await makeAccount('viewer', 'viewer-manager'));
    for (const who of [OWNER_ROLE, VIEWER_MANAGER]) await join(G, who.principalId);
    await pool.query('INSERT INTO group_stewards (group_id, account_principal_id, role) VALUES ($1, $2, $3)', [G, OWNER_ROLE.principalId, 'owner']);
    await pool.query('INSERT INTO group_stewards (group_id, account_principal_id, role) VALUES ($1, $2, $3)', [G, VIEWER_MANAGER.principalId, 'manager']);
    SKILL_NAME = `aza12b4-skill-${tag()}`;
    SKILL = String((await pool.query('INSERT INTO skills (name, owner_principal_id) VALUES ($1, $2) RETURNING id', [SKILL_NAME, G])).rows[0].id);
    const version = await pool.query(
      `INSERT INTO skill_versions (skill_id, version, skill_md, description, provenance, source_uri, created_by_principal_id)
       VALUES ($1, 1, $2, 'AZ-A12 build 4 drill', 'imported', 'urn:example:aza12-build4', $3) RETURNING id`,
      [SKILL, md(SKILL_NAME, 'v1'), OWNER.principalId]);
    await pool.query(`INSERT INTO skill_version_events (skill_version_id, status, actor_principal_id, note)
      VALUES ($1, 'draft', $2, 'fixture import')`, [version.rows[0].id, OWNER.principalId]);
  });

  it('drill 1 (skill rows): a member reads the Group-owned Skill and uses its draft content, but writes no Version', async () => {
    const read = await call(MEMBER, 'GET', `/skills/${SKILL}`);
    expect([read.status, read.json?.skill?.owner_kind, read.json?.skill?.owner_display_name]).toEqual([200, 'group', G_NAME]);
    const content = await call(MEMBER, 'GET', `/skills/${SKILL}/versions/1/content`);
    expect([content.status, content.json?.version?.skill_md]).toEqual([200, md(SKILL_NAME, 'v1')]);
    expect([403, 404]).toContain((await newVersion(MEMBER, 'member write')).status);
  });

  it('drill 1 (skill rows): a manager writes a Version and submits it for review, but never publishes', async () => {
    const written = await newVersion(MANAGER, 'manager v2');
    expect(written.status).toBe(201);
    const version = Number((await pool.query('SELECT max(version)::int AS v FROM skill_versions WHERE skill_id = $1', [SKILL])).rows[0].v);
    expect(version).toBe(2);
    const submitted = await call(MANAGER, 'POST', `/skills/${SKILL}/versions/${version}/submit-review`, {}, { 'If-Match': await revisionOf() });
    expect(submitted.status).toBe(200);
    const publish = await call(MANAGER, 'POST', `/skills/${SKILL}/versions/${version}/publish`, {}, { 'If-Match': await revisionOf() });
    expect(publish.status).toBe(403);
  });

  it('drill 1 (skill rows): an owner-role holder gets exactly the manager tier, and the admin acts stay refused', async () => {
    expect((await newVersion(OWNER_ROLE, 'owner-role v3')).status).toBe(201);
    const audience = await call(OWNER_ROLE, 'PATCH', `/skills/${SKILL}/audience`, { audience: 'everyone' }, { 'If-Match': await revisionOf() });
    expect(audience.status).toBe(403);
    const owner = await call(OWNER_ROLE, 'PUT', `/skills/${SKILL}/owner`, { ownerPrincipalId: OWNER_ROLE.principalId, reason: 'take it' },
      { 'If-Match': await revisionOf() });
    expect(owner.status).toBe(403);
  });

  it('drill 1 (skill rows): a non-member gets nothing of the draft, and a viewer holding a manager row never writes', async () => {
    expect([403, 404]).toContain((await call(OUTSIDER, 'GET', `/skills/${SKILL}/versions/1/content`)).status);
    expect([403, 404]).toContain((await newVersion(OUTSIDER, 'outsider write')).status);
    expect((await newVersion(VIEWER_MANAGER, 'viewer write')).status).toBe(403);
    // Nothing of the refused writes landed.
    const versions = await pool.query('SELECT count(*)::int AS n FROM skill_versions WHERE skill_id = $1', [SKILL]);
    expect(versions.rows[0].n).toBe(3);
  });
});
