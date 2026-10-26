/**
 * Card b1e3b16d: the approvals hub's read, `GET /approvals?view=hub`, over a
 * REAL PostgreSQL and the PRODUCTION router (the brief's "L4"; design draft
 * section C.2 and E; owner rulings E15, E16, E44 Q2/Q3, E45).
 *
 *   (1) grouping (E45): five projects — a creation-default Group grant beside a
 *       manual one, a manual Group grant, private, shared, and no project at all
 *       — classify as group / group / private / shared / board; several Groups
 *       list under the creation-default one first;
 *   (2) the self-scope and the 404 concealment are exactly `GET /approvals`':
 *       a stranger lists nothing of them and reads none of them;
 *   (3) a title is concealed where the session cannot read the object — the
 *       hub's answer carries it nowhere — and shown to the decider of a grant
 *       request (AZ-A9 clause 7);
 *   (4) `decidable` is the route's own rule: for every listed item, deciding
 *       through the EXISTING route succeeds exactly where the hub said it may;
 *   (5) the skill-review read adapter (E44 Q2) lists a version in review only
 *       to a session that may publish it — not its creator, not a session
 *       without skills:admin — and its decideVia publishes it;
 *   (6) filters: kind, group (class word or Group id), status; anything else is
 *       a 400, never a wider list;
 *   (7) CONTROLS: the default `GET /approvals` answer is unchanged (no hub field
 *       on any item, the same rows the service lists), and the approvals router
 *       still mounts exactly GET /, GET /:id, POST /:id/approve and
 *       POST /:id/deny as its decision routes — the hub added none, and the
 *       change-request doors of card 502fb19e slice S2 (POST /requests,
 *       GET /requests/preview, POST /:id/withdraw) decide nothing;
 *   (8) native verification requests WAITING ON A VERIFIER (review round 2,
 *       blocker B1), filed and leased through the REAL native-review routes:
 *       listed read-only — who asked, which task, when, the assigned verifier
 *       — never decidable, with no decide route, only while active, and only
 *       on a task the session may read.
 *
 * DESTRUCTIVE: writes principals, sessions, services, credentials, projects,
 * tasks, reports, native review requests, groups, grants, approvals, skills and
 * step-up tokens. It refuses any
 * deployment database and any non-local host, and FAILS - never skips -
 * without a disposable one.
 */

/* eslint-disable @typescript-eslint/no-var-requires */

import http from 'http';
import crypto from 'crypto';

const TEST_DB_URL = process.env.RELAYHALL_TEST_DB_URL;
if (!TEST_DB_URL) {
  throw new Error('RELAYHALL_TEST_DB_URL is required: the approvals hub drill measures stored rows, so it never skips. '
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
  throw new Error('Approvals hub drill refuses a non-disposable database target');
}

Object.assign(process.env, {
  DB_HOST: parsed.hostname, DB_PORT: parsed.port || '5432', DB_NAME: TEST_DB_NAME,
  DB_USER: decodeURIComponent(parsed.username), DB_PASSWORD: decodeURIComponent(parsed.password),
  NODE_ENV: 'test', RELAYHALL_SESSIONS: 'on', JWT_SECRET: crypto.randomBytes(32).toString('hex'),
  // Six pending mint requests from one connector: lift the per-connector
  // quota (read at import) so the drill measures the hub, not the quota.
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
const { approvalService, approvalDeepLinkPath, APPROVAL_KINDS } = require('../services/ApprovalService');
const { skillManager } = require('../services/SkillManager');
const { principalService } = require('../services/PrincipalService');
// AZ-A12 build 1: a raw Group row needs its kind='group' principal first.
const { insertGroupRow } = require('./support/groupRows');
const { reviewDigest } = require('../utils/nativeReview');
const approvalsRouter = require('../routes/approvals').default;

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
const REASON = 'Hub drill: the run needs to read the referenced card to finish its handover.';

async function makeAccount(role: string, label: string): Promise<string> {
  const result = await pool.query(
    `INSERT INTO principals (kind, handle, display_name, status, role) VALUES ('human', $1, $1, 'active', $2) RETURNING id`,
    [`hub-${label}-${tag()}`, role],
  );
  return String(result.rows[0].id);
}

async function sessionFor(label: string, principalId: string): Promise<Caller> {
  const minted = await loginSessionService.mint({ principalId });
  return { label, principalId, headers: { Cookie: `${SESSION_COOKIE_NAME}=${minted.token}` } };
}

async function registerConnector(owner: Caller): Promise<Caller> {
  const slug = `hub-connector-${tag()}`;
  const registered = await call(owner, 'POST', '/services', {
    slug, name: slug, description: 'Approvals hub drill connector.', kind: 'connector',
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
    { targetTaskId, requestedScopes: FOUR_SCOPES, via: 'approval' }, { 'Idempotency-Key': `hub-mint-${crypto.randomUUID()}` });
  expect([requested.status, requested.json?.path]).toEqual([202, 'approval']);
  return String(requested.json.approval.id);
}

async function decide(decider: Caller, approvalId: string, decision: 'approve' | 'deny'): Promise<Answer> {
  const stepUp = await stepUpService.mint(decider.principalId, 'approval.decide', approvalId, 'password');
  return call(decider, 'POST', `/approvals/${approvalId}/${decision}`, { stepUpToken: stepUp.token });
}

async function project(owner: Caller, label: string): Promise<string> {
  const created = await call(owner, 'POST', '/projects', { name: `Hub ${label} ${tag()}` });
  expect(created.status).toBe(201);
  return String(created.json.project.id);
}

async function task(owner: Caller, title: string, projectId?: string): Promise<string> {
  const created = await call(owner, 'POST', '/tasks', { title, description: 'hub drill', status: 'todo', ...(projectId ? { project: projectId } : {}) });
  expect(created.status).toBe(201);
  return String(created.json.task.id);
}

async function group(name: string): Promise<string> {
  return insertGroupRow(pool, { name, description: 'hub drill group', featured: false });
}

async function groupGrant(groupId: string, projectId: string, origin: 'manual' | 'creation-default', expiresAt: string | null = null): Promise<void> {
  await pool.query(
    `INSERT INTO grants (grantee_type, grantee_id, resource_type, resource_id, verb, origin, expires_at)
     VALUES ('group', $1, 'project', $2, 'read', $3, $4)`,
    [groupId, projectId, origin, expiresAt],
  );
}

const hub = (who: Caller, query = '') => call(who, 'GET', `/approvals?view=hub${query ? `&${query}` : ''}`);
const byId = (answer: Answer, id: string) => answer.json.approvals.find((item: any) => item.id === id);

let OWNER: Caller;
let OTHER: Caller;
let STRANGER: Caller;
let OPERATOR: Caller;
let ROOT: Caller;
let CONNECTOR: Caller;
let G_ALPHA: string;  // manual Group on P_DEFAULT; sorts first by name
let G_ZULU: string;   // the creation-default Group on P_DEFAULT
let G_MANUAL: string;
const MINT: Record<'creationDefault' | 'manual' | 'private' | 'shared' | 'board' | 'concealed', string> = {} as any;
let CONCEALED_TITLE: string;
let GRANT_REQUEST: string;
let GRANT_RELATED_TITLE: string;

beforeAll(async () => {
  await new Promise<void>((resolve) => { server = buildApp().listen(0, '127.0.0.1', resolve); });
  origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  OWNER = await sessionFor('owner', await makeAccount('user', 'owner'));
  OTHER = await sessionFor('other', await makeAccount('user', 'other'));
  STRANGER = await sessionFor('stranger', await makeAccount('user', 'stranger'));
  OPERATOR = await sessionFor('operator', await makeAccount('operator', 'operator'));
  ROOT = await sessionFor('root', await makeAccount('admin', 'root'));
  CONNECTOR = await registerConnector(OWNER);

  const P_DEFAULT = await project(OWNER, 'creation-default');
  const P_MANUAL = await project(OWNER, 'manual-group');
  const P_PRIVATE = await project(OWNER, 'private');
  const P_SHARED = await project(OWNER, 'shared');
  await pool.query(`UPDATE projects SET visibility = 'shared' WHERE id = $1`, [P_SHARED]);
  G_ALPHA = await group(`aaa-hub-alpha-${tag()}`);
  G_ZULU = await group(`zzz-hub-zulu-${tag()}`);
  G_MANUAL = await group(`hub-manual-${tag()}`);
  await groupGrant(G_ZULU, P_DEFAULT, 'creation-default');
  await groupGrant(G_ALPHA, P_DEFAULT, 'manual');
  await groupGrant(G_MANUAL, P_MANUAL, 'manual');
  // An EXPIRED Group grant does not make a project group-owned.
  await groupGrant(await group(`hub-expired-${tag()}`), P_PRIVATE, 'manual', new Date(Date.now() - 60_000).toISOString());

  MINT.creationDefault = await requestMint(CONNECTOR, await task(OWNER, `Hub default ${tag()}`, P_DEFAULT));
  MINT.manual = await requestMint(CONNECTOR, await task(OWNER, `Hub manual ${tag()}`, P_MANUAL));
  MINT.private = await requestMint(CONNECTOR, await task(OWNER, `Hub private ${tag()}`, P_PRIVATE));
  MINT.shared = await requestMint(CONNECTOR, await task(OWNER, `Hub shared ${tag()}`, P_SHARED));
  MINT.board = await requestMint(CONNECTOR, await task(OWNER, `Hub board ${tag()}`));

  // A task OTHER owns, readable by OWNER (and so by OWNER's connector) through
  // a grant while the request is filed, and NOT afterwards.
  CONCEALED_TITLE = `Hub SECRET concealed ${tag()}`;
  const hidden = await task(OTHER, CONCEALED_TITLE);
  const grant = await pool.query(
    `INSERT INTO grants (grantee_type, grantee_id, resource_type, resource_id, verb) VALUES ('principal', $1, 'task', $2, 'read') RETURNING id`,
    [OWNER.principalId, hidden]);
  MINT.concealed = await requestMint(CONNECTOR, hidden);
  await pool.query('DELETE FROM grants WHERE id = $1', [grant.rows[0].id]);

  // A grant request (AZ-A9): an Agent minted through the real approval path
  // files it, about a task OTHER owns that the requester's Account cannot read.
  GRANT_RELATED_TITLE = `Hub related ${tag()}`;
  const bound = await task(OWNER, GRANT_RELATED_TITLE, P_MANUAL);
  const mintId = await requestMint(CONNECTOR, bound);
  expect((await decide(OWNER, mintId, 'approve')).status).toBe(200);
  const collected = await call(CONNECTOR, 'POST', `/delegation/agent-mints/${mintId}/collect`, {}, { 'Idempotency-Key': `hub-collect-${crypto.randomUUID()}` });
  expect(collected.status).toBe(201);
  const agent: Caller = { label: 'agent', principalId: '', headers: { Authorization: `Bearer ${collected.json.pack.secretOnce}` } };
  const askedFor = await task(OTHER, `Hub asked-for ${tag()}`);
  const filed = await call(agent, 'POST', '/delegation/access-requests', {
    kind: 'grant', reason: REASON, relatedTaskId: bound,
    requestedRules: [{ resourceType: 'task', selectorForm: 'exact', selectorIds: [askedFor], verbs: ['read'] }],
  });
  expect(filed.status).toBe(202);
  GRANT_REQUEST = String(filed.json.approval.id);
});

afterAll(async () => {
  if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  await pool.end();
});

describe('(1) grouping: group / group / private / shared / board (E45)', () => {
  it('each mint request carries the class its project earns', async () => {
    const answer = await hub(OWNER);
    expect(answer.status).toBe(200);
    expect(answer.json.view).toBe('hub');
    const classOf = (id: string) => byId(answer, id).ownership;
    expect(classOf(MINT.creationDefault)).toMatchObject({ class: 'group' });
    expect(classOf(MINT.creationDefault).groups.map((g: any) => g.id).sort()).toEqual([G_ZULU, G_ALPHA].sort());
    expect(classOf(MINT.manual)).toMatchObject({ class: 'group', groups: [{ id: G_MANUAL }] });
    expect(classOf(MINT.private)).toMatchObject({ class: 'private', groups: [], ownerIsViewer: true });
    expect(classOf(MINT.private).ownerHandle).toMatch(/^hub-owner-/);
    expect(classOf(MINT.shared)).toMatchObject({ class: 'shared', groups: [] });
    expect(classOf(MINT.board)).toMatchObject({ class: 'board', groups: [] });
  });

  it('several Groups list under the creation-default Group first, then by name', async () => {
    const answer = await hub(OWNER);
    // creation-default first, although its name sorts last.
    expect(byId(answer, MINT.creationDefault).ownership.groups.map((g: any) => g.id)).toEqual([G_ZULU, G_ALPHA]);
  });

  it('every item names its task, and the project and phase it sits in', async () => {
    const answer = await hub(OWNER);
    const item = byId(answer, MINT.manual);
    expect(item.refs.task).toMatchObject({ id: item.targetTaskId, title: expect.stringMatching(/^Hub manual/) });
    expect(item.refs.project.title).toMatch(/^Hub manual-group/);
    expect(byId(answer, MINT.board).refs.project).toBeNull();
  });

  it('root sees another Account\'s private project as private to its owner', async () => {
    const item = byId(await hub(ROOT), MINT.private);
    expect(item.ownership).toMatchObject({ class: 'private', ownerIsViewer: false });
    expect(item.ownership.ownerHandle).toMatch(/^hub-owner-/);
  });
});

describe('(2) the self-scope and the concealment are GET /approvals\'', () => {
  it('a stranger lists none of them and reads none of them', async () => {
    const answer = await hub(STRANGER, 'status=all');
    expect(answer.status).toBe(200);
    expect(answer.json.approvals.filter((item: any) => Object.values(MINT).includes(item.id) || item.id === GRANT_REQUEST)).toEqual([]);
    expect((await call(STRANGER, 'GET', `/approvals/${MINT.private}`)).status).toBe(404);
  });

  it('the hub lists exactly the ids the default list does, for every session', async () => {
    for (const who of [OWNER, STRANGER, OPERATOR, ROOT]) {
      const answer = await call(who, 'GET', '/approvals?status=pending');
      expect(answer.status).toBe(200);
      expect(Array.isArray(answer.json?.approvals)).toBe(true);
      const plain = answer.json.approvals.map((item: any) => item.id).sort();
      // Every Approval kind: card 785e1eed P1-B-2 files credential requests, and
      // the credential live suite runs before this one on the same database.
      // Card 1a38270d (AZ-A13, migration 148) adds kind authority-edit, which the
      // edit-in-place suite files on the same database: the kinds are read from
      // APPROVAL_KINDS, so the plain list (every row, whatever its kind) stays
      // the outside anchor - a kind the hub cannot filter, or one missing from
      // APPROVAL_KINDS while rows of it exist, still turns this red.
      const viaHub: string[] = [];
      for (const kind of APPROVAL_KINDS as readonly string[]) {
        viaHub.push(...(await hub(who, `kind=${kind}`)).json.approvals.map((item: any) => item.id));
      }
      expect(viaHub.sort()).toEqual(plain);
    }
  });

  it('a bearer credential is refused SESSION_ONLY on the hub view too', async () => {
    const answer = await hub(CONNECTOR);
    expect([answer.status, answer.json?.code]).toEqual([403, 'SESSION_ONLY']);
  });
});

describe('(3) titles: concealed where unreadable, shown to the decider', () => {
  it('OWNER lists its connector\'s request about a task it can no longer read: the id, never the title', async () => {
    const answer = await hub(OWNER);
    const item = byId(answer, MINT.concealed);
    expect(item.refs.task).toEqual({ id: item.targetTaskId, title: null });
    expect(item.targetTaskTitle).toBeNull();
    expect(JSON.stringify(answer.json)).not.toContain('SECRET');
    // The default list is unchanged by this lane, and still names it there.
    const plain = await call(OWNER, 'GET', '/approvals?status=pending');
    expect(plain.json?.approvals?.find((row: any) => row.id === MINT.concealed)?.targetTaskTitle).toBe(CONCEALED_TITLE);
  });

  it('the administrator decider of a grant request sees the related task\'s title (AZ-A9 clause 7)', async () => {
    const item = byId(await hub(OPERATOR), GRANT_REQUEST);
    expect(item.kind).toBe('grant');
    expect(item.refs.task.title).toBe(GRANT_RELATED_TITLE);
    expect(item.accessRequest.relatedTaskTitle).toBe(GRANT_RELATED_TITLE);
    expect(item.ownership).toMatchObject({ class: 'group', groups: [{ id: G_MANUAL }] });
  });
});

describe('(4) decidable is the route\'s own rule', () => {
  it('OWNER: its connector\'s mint requests are decidable; the grant request waits on an administrator', async () => {
    const answer = await hub(OWNER);
    for (const id of Object.values(MINT)) {
      expect(byId(answer, id)).toMatchObject({ decidable: true, deciders: { stepUp: true } });
    }
    const grant = byId(answer, GRANT_REQUEST);
    expect(grant).toMatchObject({ decidable: false, deciders: { rule: expect.stringMatching(/administrator/), stepUp: true } });
    expect(grant.decideVia).toEqual({
      approve: `/approvals/${GRANT_REQUEST}/approve`, deny: `/approvals/${GRANT_REQUEST}/deny`, stepUpAction: 'approval.decide',
    });
  });

  it('OPERATOR: the grant request is decidable, and so are another Account\'s mint requests (E43 Q1)', async () => {
    // AZ-A9 as ratified (E43 Q1; card 785e1eed P1-B-2): an administrator
    // session sees and decides items of every kind, agent-mint included.
    const answer = await hub(OPERATOR);
    expect(byId(answer, GRANT_REQUEST).decidable).toBe(true);
    for (const id of Object.values(MINT)) {
      expect(byId(answer, id)).toMatchObject({ decidable: true, deciders: { stepUp: true } });
    }
  });

  it('the route agrees with the hub, item by item: refused where not decidable, decided where decidable', async () => {
    const forOwner = byId(await hub(OWNER), GRANT_REQUEST);
    expect(forOwner.decidable).toBe(false);
    const refused = await decide(OWNER, GRANT_REQUEST, 'deny');
    expect([refused.status, refused.json?.code]).toEqual([403, 'APPROVAL_DECIDE_REQUIRES_ADMINISTRATOR']);
    expect((await pool.query('SELECT status FROM approvals WHERE id = $1', [GRANT_REQUEST])).rows[0].status).toBe('pending');
    const forShared = byId(await hub(OWNER), MINT.shared);
    expect(forShared.decidable).toBe(true);
    const decided = await decide(OWNER, MINT.shared, 'deny');
    expect(decided.status).toBe(200);
    const after = byId(await hub(OWNER, 'status=decided'), MINT.shared);
    expect(after).toMatchObject({ status: 'denied', decidable: false });
    expect(byId(await hub(OWNER), MINT.shared)).toBeUndefined();
  });
});

/** A Skill whose version 1 its author has submitted for review. */
async function skillInReview(author: Caller, label: string): Promise<{ skillId: string; versionId: string }> {
  const skill = await skillManager.create({ name: `hub-${label}-${tag()}`, description: 'Hub drill skill.', usage_instructions: 'Body.' }, author.principalId);
  const revision = String((await pool.query('SELECT revision FROM skills WHERE id = $1', [skill.id])).rows[0].revision);
  const version = await skillManager.transition(skill.id, '1', 'review', author.principalId, undefined, revision);
  return { skillId: String(skill.id), versionId: String(version.id) };
}

let KEPT_VERSION: string;  // stays in review: the kind filter's evidence

describe('(5) the skill-review read adapter (E44 Q2)', () => {
  let SKILL_ID: string;
  let VERSION_ID: string;
  let ADMIN_AUTHOR: Caller;
  let ADMIN_VERSION: string;

  beforeAll(async () => {
    ({ skillId: SKILL_ID, versionId: VERSION_ID } = await skillInReview(OTHER, 'skill'));
    KEPT_VERSION = (await skillInReview(OTHER, 'kept')).versionId;
    // An author who HOLDS skills:admin: only the independent-review rule keeps
    // its own version off its hub.
    ADMIN_AUTHOR = await sessionFor('admin-author', await makeAccount('admin', 'admin-author'));
    ADMIN_VERSION = (await skillInReview(ADMIN_AUTHOR, 'own')).versionId;
  });

  it('root, a human with skills:admin who did not write it, lists it as a skill-publish item', async () => {
    const item = byId(await hub(ROOT), VERSION_ID);
    expect(item).toMatchObject({
      kind: 'skill-publish', status: 'pending', requesterPrincipalId: OTHER.principalId, decidable: true,
      skill: { id: SKILL_ID, version: 1 }, ownership: { class: 'board' }, deciders: { stepUp: false },
      decideVia: { publish: `/skills/${SKILL_ID}/versions/1/publish`, reject: `/skills/${SKILL_ID}/versions/1/reject`, stepUpAction: null },
    });
  });

  it('a session without skills:admin never lists it', async () => {
    expect(byId(await hub(OTHER), VERSION_ID)).toBeUndefined();
    expect(byId(await hub(OWNER), VERSION_ID)).toBeUndefined();
    expect(byId(await hub(STRANGER, 'kind=skill-publish'), VERSION_ID)).toBeUndefined();
  });

  it('a version is never listed to the author who wrote it, even one holding skills:admin', async () => {
    expect(byId(await hub(ADMIN_AUTHOR), ADMIN_VERSION)).toBeUndefined();
    expect(byId(await hub(ADMIN_AUTHOR), VERSION_ID)).toMatchObject({ kind: 'skill-publish', decidable: true });
    expect(byId(await hub(ROOT), ADMIN_VERSION)).toMatchObject({ kind: 'skill-publish', requesterPrincipalId: ADMIN_AUTHOR.principalId });
  });

  it('its decideVia publishes it through the EXISTING route, and it leaves the hub', async () => {
    const item = byId(await hub(ROOT), VERSION_ID);
    expect(item?.decideVia?.publish).toBe(`/skills/${SKILL_ID}/versions/1/publish`);
    const revision = String((await pool.query('SELECT revision FROM skills WHERE id = $1', [SKILL_ID])).rows[0].revision);
    const published = await call(ROOT, 'POST', item.decideVia.publish, {}, { 'If-Match': `"${revision}"` });
    expect(published.status).toBe(200);
    expect(byId(await hub(ROOT), VERSION_ID)).toBeUndefined();
  });
});

describe('(6) filters', () => {
  it('kind narrows to one kind; skill-publish narrows to the adapter', async () => {
    const mints = await hub(OWNER, 'kind=agent-mint');
    expect(mints.json.approvals.every((item: any) => item.kind === 'agent-mint')).toBe(true);
    expect(byId(mints, GRANT_REQUEST)).toBeUndefined();
    const skills = await hub(ROOT, 'kind=skill-publish');
    expect(byId(skills, KEPT_VERSION)).toMatchObject({ kind: 'skill-publish' });
    expect(skills.json.approvals.every((item: any) => item.kind === 'skill-publish')).toBe(true);
    expect(byId(await hub(ROOT, 'kind=agent-mint'), KEPT_VERSION)).toBeUndefined();
  });

  it('group narrows by class word or by Group id', async () => {
    const privateOnly = await hub(OWNER, 'group=private');
    expect(privateOnly.json.approvals.length).toBeGreaterThan(0);
    expect(privateOnly.json.approvals.every((item: any) => item.ownership.class === 'private')).toBe(true);
    expect(byId(privateOnly, MINT.private)).toBeDefined();
    const board = await hub(OWNER, 'group=board');
    expect(board.json.approvals.map((item: any) => item.id)).toContain(MINT.board);
    const alpha = await hub(OWNER, `group=${G_ALPHA}`);
    expect(alpha.json.approvals.map((item: any) => item.id)).toEqual([MINT.creationDefault]);
    const manual = await hub(OWNER, `group=${G_MANUAL}`);
    expect(manual.json.approvals.map((item: any) => item.id).sort()).toEqual([GRANT_REQUEST, MINT.manual].sort());
  });

  it('status=decided and status=all', async () => {
    const decided = await hub(OWNER, 'status=decided');
    expect(decided.json.approvals.every((item: any) => item.status !== 'pending')).toBe(true);
    const all = await hub(OWNER, 'status=all');
    expect(all.json.approvals.length).toBeGreaterThan(decided.json.approvals.length);
  });

  it('a value outside each grammar is a 400', async () => {
    for (const query of ['status=approved', 'kind=charter', 'group=everyone', 'group=1234']) {
      const answer = await hub(OWNER, query);
      expect([answer.status, answer.json?.code]).toEqual([400, 'APPROVAL_FILTER_INVALID']);
    }
    const view = await call(OWNER, 'GET', '/approvals?view=grid');
    expect([view.status, view.json?.code]).toEqual([400, 'APPROVAL_FILTER_INVALID']);
  });
});

describe('(7) controls', () => {
  const HUB_FIELDS = ['refs', 'ownership', 'deciders', 'decidable', 'decideVia', 'skill', 'relationships', 'decisionRefusal'];

  it('the default GET /approvals answer carries no hub field and the very rows the service lists', async () => {
    for (const who of [OWNER, OPERATOR, ROOT]) {
      const plain = await call(who, 'GET', '/approvals?status=pending');
      expect(plain.status).toBe(200);
      // `viewer` is card 785e1eed P1-B-2's (what this session may decide), not a hub field.
      expect(Object.keys(plain.json).sort()).toEqual(['approvals', 'success', 'viewer']);
      for (const item of plain.json.approvals) {
        for (const field of HUB_FIELDS) expect(Object.keys(item)).not.toContain(field);
      }
      const isRoot = who === ROOT;
      const isAdministrator = who === OPERATOR;
      const listed = await approvalService.list({ principalId: who.principalId, isRoot, isAdministrator }, 'pending');
      expect(plain.json.approvals.map((item: any) => item.id)).toEqual(listed.map((item: any) => item.id));
      expect(plain.json.approvals.filter((item: any) => item.kind === 'agent-mint'))
        .toEqual(JSON.parse(JSON.stringify(listed.filter((item: any) => item.kind === 'agent-mint'))));
    }
  });

  it('the approvals router mounts exactly the two decision routes beside the reads and the change-request doors, and no other', () => {
    const mounted = approvalsRouter.stack
      .filter((layer: any) => layer.route)
      .flatMap((layer: any) => Object.keys(layer.route.methods).map((method) => `${method.toUpperCase()} ${layer.route.path}`))
      .sort();
    // Card 502fb19e slice S2 (E325 section 9.2): the session door files and
    // withdraws a change request and previews one; none of them decides.
    expect(mounted).toEqual([
      'GET /', 'GET /:id', 'GET /requests/preview', 'POST /:id/approve', 'POST /:id/deny', 'POST /:id/withdraw', 'POST /requests',
    ]);
  });

  it('the published deep link is unchanged (Batch 14 keeps working)', () => {
    expect(approvalDeepLinkPath('abc')).toBe('/dashboard/settings/access-manager?approval=abc');
  });
});

/**
 * A verifier Connector the native-review routes accept (protocol 1), owned by
 * `parent`, with its own credential: the fixture `nativeReviewLive` uses.
 */
async function verifierConnector(parent: Caller): Promise<{ verifier: Caller; handle: string; serviceId: string; serviceName: string }> {
  const handle = `hub-verifier-${tag()}`;
  const verifierId = String((await pool.query(
    `INSERT INTO principals (kind, handle, display_name, status, parent_principal_id, purpose, own_expression)
     VALUES ('service', $1, $1, 'active', $2, 'hub drill verifier', $3) RETURNING id`,
    [handle, parent.principalId, JSON.stringify({ scopes: 'parent', objects: 'parent' })])).rows[0].id);
  const serviceId = crypto.randomUUID();
  const serviceName = `hub-verify-service-${tag()}`;
  const descriptor = { options: [], telemetry: { tier: 'presence', products: ['claude-code'] }, nativeReview: { protocolVersion: 1, sourceProduct: 'claude-code' } };
  await pool.query(
    `INSERT INTO services (id, slug, name, kind, status, principal_id, telemetry_tier, current_descriptor_version)
     VALUES ($1, $2, $2, 'connector', 'published', $3, 'presence', 1)`, [serviceId, serviceName, verifierId]);
  await pool.query('INSERT INTO service_descriptor_versions (service_id, version, descriptor, content_hash) VALUES ($1, 1, $2, $3)',
    [serviceId, JSON.stringify(descriptor), reviewDigest(descriptor)]);
  const issued = await principalService.issueCredential({
    principalId: verifierId, transport: 'any',
    scopes: ['tasks:read', 'tasks:write', 'services:read', 'services:invoke', 'reports:read', 'reports:write'],
  }, { handle: 'hub-verify-fixture', authMethod: 'system' });
  return { verifier: { label: handle, principalId: verifierId, headers: { Authorization: `Bearer ${issued.fullKey}` } }, handle, serviceId, serviceName };
}

describe('(8) native verification requests: listed read-only, waiting on the verifier', () => {
  let VPARENT: Caller;
  let VERIFIER: Caller;
  let VERIFIER_HANDLE: string;
  let SERVICE_ID: string;
  let SERVICE_NAME: string;
  let P_VERIFY: string;
  const TASK: Record<'pending' | 'leased' | 'lapsed' | 'finished' | 'hidden', string> = {} as any;
  const REVIEW: Record<'pending' | 'leased' | 'lapsed' | 'finished' | 'hidden', string> = {} as any;
  // Not the word (3) searches every hub answer for: an earlier run on the same database leaves active
  // requests behind, and a leak of THIS title is (8)'s finding, not (3)'s.
  const HIDDEN_TITLE = `Hub HIDDEN verification ${tag()}`;

  /** A task in Review with an independent verifier and one linked Report. */
  async function reviewTask(title: string, owner: Caller, projectId: string | null): Promise<string> {
    const taskId = String((await pool.query(
      `INSERT INTO tasks (title, description, status, visibility, creator_principal_id, owner_principal_id,
                          verifier_principal_id, shepherd_principal_id, definition_of_done, project_id)
       VALUES ($1, 'Verify exact evidence', 'review', 'private', $2, $3, $4, $2, $5, $6) RETURNING id`,
      [title, VPARENT.principalId, owner.principalId, VERIFIER.principalId, JSON.stringify(['Verify exact evidence']), projectId])).rows[0].id);
    await pool.query(
      `INSERT INTO reports (title, content, content_hash, summary, task_ids, author_principal_id, author_actor_id, origin, visibility)
       VALUES ($1, 'immutable receipt', $2, 'fixture', $3, $4, $5, 'api', 'shared')`,
      [`hub-evidence-${tag()}`, crypto.createHash('sha256').update('immutable receipt').digest('hex'), [taskId],
        VPARENT.principalId, VPARENT.principalId]);
    return taskId;
  }

  const DIGEST: Record<string, string> = {};
  /** Files a native verification request through the REAL route, as VPARENT (the shepherd). */
  async function requestVerification(taskId: string): Promise<string> {
    const path = `/tasks/${taskId}/native-reviews`;
    const input = await call(VERIFIER, 'GET', `${path}/inputs`);
    expect(input.status).toBe(200);
    const created = await call(VPARENT, 'POST', path, {
      serviceId: SERVICE_ID, descriptorVersion: 1, requestKey: crypto.randomUUID(), expectedInputDigest: input.json.result.inputDigest,
    });
    expect([created.status, created.json?.result?.state]).toEqual([200, 'pending']);
    DIGEST[String(created.json.result.id)] = String(input.json.result.inputDigest);
    return String(created.json.result.id);
  }

  beforeAll(async () => {
    VPARENT = await sessionFor('vparent', await makeAccount('admin', 'vparent'));
    ({ verifier: VERIFIER, handle: VERIFIER_HANDLE, serviceId: SERVICE_ID, serviceName: SERVICE_NAME } = await verifierConnector(VPARENT));
    P_VERIFY = await project(OWNER, 'verify');
    TASK.pending = await reviewTask(`Hub verify pending ${tag()}`, OWNER, P_VERIFY);
    TASK.leased = await reviewTask(`Hub verify leased ${tag()}`, OWNER, P_VERIFY);
    TASK.lapsed = await reviewTask(`Hub verify lapsed ${tag()}`, OWNER, P_VERIFY);
    TASK.finished = await reviewTask(`Hub verify finished ${tag()}`, OWNER, P_VERIFY);
    TASK.hidden = await reviewTask(HIDDEN_TITLE, OTHER, null);
    for (const key of Object.keys(TASK) as Array<keyof typeof TASK>) REVIEW[key] = await requestVerification(TASK[key]);
    const leased = await call(VERIFIER, 'POST', `/tasks/${TASK.leased}/native-reviews/${REVIEW.leased}/lease`, { leaseToken: crypto.randomBytes(32).toString('hex') });
    expect([leased.status, leased.json?.result?.state]).toEqual([200, 'leased']);
    // Past its request expiry: the routes report it expired, so it is not waiting on anyone.
    await pool.query(`UPDATE task_native_reviews SET request_expires_at = NOW() - INTERVAL '1 second' WHERE id = $1`, [REVIEW.lapsed]);
    // Finished: cancelled before any lease, through the real route.
    const cancelled = await call(VPARENT, 'POST', `/tasks/${TASK.finished}/native-reviews/${REVIEW.finished}/cancel`,
      { inputDigest: DIGEST[REVIEW.finished] });
    expect([cancelled.status, cancelled.json?.result?.state]).toEqual([200, 'cancelled']);
  });

  it('the task owner lists a pending request on its task: who asked, which task, when, and the verifier, never decidable', async () => {
    const answer = await hub(OWNER);
    expect(answer.status).toBe(200);
    const item = byId(answer, REVIEW.pending);
    expect(item).toBeDefined();
    const stored = (await pool.query('SELECT created_at, request_expires_at FROM task_native_reviews WHERE id = $1', [REVIEW.pending])).rows[0];
    expect(item).toMatchObject({
      kind: 'native-review', status: 'pending',
      requesterPrincipalId: VPARENT.principalId, requesterHandle: expect.stringMatching(/^hub-vparent-/),
      requestedAt: new Date(stored.created_at).toISOString(),
      pendingExpiresAt: new Date(stored.request_expires_at).toISOString(),
      targetTaskId: TASK.pending,
      refs: { task: { id: TASK.pending, title: expect.stringMatching(/^Hub verify pending/) }, project: { id: P_VERIFY, title: expect.stringMatching(/^Hub verify/) } },
      ownership: { class: 'private', ownerIsViewer: true },
      verification: {
        state: 'pending', serviceId: SERVICE_ID, descriptorVersion: 1,
        verifierPrincipalId: VERIFIER.principalId, verifierHandle: VERIFIER_HANDLE,
      },
      deciders: { stepUp: false },
      decidable: false,
    });
    expect(item.deciders.rule).toContain(VERIFIER_HANDLE);
    expect(item.deciders.rule).toMatch(/Nothing is decided on this page/);
    // No route decides it from the hub.
    expect(item.decideVia).toEqual({});
  });

  it('a leased request is listed as leased; a lapsed or finished one is not', async () => {
    const answer = await hub(OWNER);
    expect(byId(answer, REVIEW.leased)).toMatchObject({
      kind: 'native-review', decidable: false, pendingExpiresAt: null,
      verification: { state: 'leased', leaseExpiresAt: expect.any(String) },
    });
    expect(byId(answer, REVIEW.lapsed)).toBeUndefined();
    expect(byId(answer, REVIEW.finished)).toBeUndefined();
    expect(byId(await hub(OWNER, 'status=all'), REVIEW.lapsed)).toBeUndefined();
  });

  it('a request on a task the session cannot read is not listed, and its title appears nowhere; root lists it', async () => {
    const forOwner = await hub(OWNER, 'status=all');
    expect(byId(forOwner, REVIEW.hidden)).toBeUndefined();
    expect(JSON.stringify(forOwner.json)).not.toContain('HIDDEN verification');
    const forStranger = await hub(STRANGER, 'status=all');
    expect(forStranger.json.approvals.filter((item: any) => Object.values(REVIEW).includes(item.id))).toEqual([]);
    const forRoot = await hub(ROOT);
    expect(byId(forRoot, REVIEW.hidden)).toMatchObject({
      kind: 'native-review', decidable: false, refs: { task: { id: TASK.hidden, title: HIDDEN_TITLE } },
      ownership: { class: 'board' }, verification: { serviceName: SERVICE_NAME },
    });
  });

  it('kind=native-review lists only them; the other kinds and status=decided list none of them', async () => {
    const only = await hub(OWNER, 'kind=native-review');
    expect(only.status).toBe(200);
    expect(only.json.approvals.map((item: any) => item.id).sort()).toEqual([REVIEW.pending, REVIEW.leased].sort());
    for (const query of ['kind=agent-mint', 'kind=grant', 'kind=skill-publish', 'status=decided', 'kind=native-review&status=decided']) {
      const answer = await hub(OWNER, query);
      expect(answer.status).toBe(200);
      expect(answer.json.approvals.filter((item: any) => item.kind === 'native-review')).toEqual([]);
    }
  });

  it('nothing decides it here: the approvals routes answer 404 for its id, and the request is untouched', async () => {
    expect(byId(await hub(OWNER), REVIEW.pending)).toMatchObject({ decidable: false, decideVia: {} });
    for (const who of [OWNER, ROOT]) {
      expect((await call(who, 'GET', `/approvals/${REVIEW.pending}`)).status).toBe(404);
      for (const decision of ['approve', 'deny'] as const) {
        expect((await decide(who, REVIEW.pending, decision)).status).toBe(404);
      }
    }
    expect((await pool.query('SELECT state, finished_at FROM task_native_reviews WHERE id = $1', [REVIEW.pending])).rows[0])
      .toEqual({ state: 'pending', finished_at: null });
  });
});
