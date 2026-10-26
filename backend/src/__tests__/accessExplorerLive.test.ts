/**
 * Card 1e56dbef — AZ-A12 build 6: the Access Explorer read model (amendment
 * AZ-A12 clause 12 and E45 (3), RATIFIED 2026-10-10, ruling E72; SR-3 of
 * LENSES v5 §6.4, built here as LENSES-c delta LC-DD-2 directs).
 *
 * Over a REAL PostgreSQL and the PRODUCTION router it measures:
 *
 *   (M)  THE MATRIX (G.2 drill 8's parity, reused): over a generated estate of
 *        principal kinds (Accounts of five roles, Group members, managers and
 *        owner-role holders, an inert role row, a disabled member, grantees of
 *        live and expired exact grants, a typed-wildcard grantee, a member of a
 *        granted Group, a profile assignee, Task role holders, Connectors with
 *        a parent and an explicit own() cap, an Agent minted under a Warrant,
 *        a dead Agent, and a Group principal) x object kinds (Group-owned and
 *        person-owned Projects, Phases, restricted Phases, Tasks on both clause
 *        7 paths, restricted Tasks, Reports, Skills, a Service) x every action
 *        in AUTHORIZATION_ACTIONS:
 *          - the read model's verdict equals the POINT decision
 *            (`authorizePoint`) for the actor the production middleware builds
 *            for that principal on a real request;
 *          - the HTTP object hop (as root) lists every principal the evaluator
 *            admits beyond the board-wide classes, directly or under its
 *            parent's principal hop, with exactly that verdict;
 *        and a NEGATIVE CONTROL: a second rule set (the in-memory fast path,
 *        which never reads a Group owner or a stored grant) evaluated over the
 *        same matrix disagrees with the enforcing evaluator, so the comparison
 *        can fail.
 *   (C)  concealment: an object the caller cannot read answers exactly as an
 *        absent one; malformed input is refused by name.
 *   (P)  the projections (design 4d961e37 §5.3 as AZ-A12 D-7 amends it): a
 *        non-root reader sees ownership, Groups and its own verdict, never
 *        another principal's authority; root sees every holder (a grantee, a
 *        granted Group's member, a profile assignee) and the grant rows naming
 *        the object, live and expired.
 *   (G)  the Group hop: members with their tier from the clause-6 fragment,
 *        source and role; inert role rows flagged; a disabled Group gives no
 *        tier.
 *   (A)  the principal hop: an Account's Connectors, a Connector's own() cap,
 *        grants and warrants, an Agent under the Warrant; root, self and the
 *        login-session subtree see the authority, anyone else the directory.
 *   (S)  SR-3: only the authority reaching one member through one Group, to a
 *        root login session or a steward holding the Group's edit tier on a
 *        login session; everyone else the empty answer.
 *   And the r1 concealment class (review LEAK A and LEAK B): a hop discloses
 *   nothing its caller's own read surfaces would not - a principal the caller
 *   may not see the authority of is the GET /principals record under that
 *   list's filter; a bound Task only to a reader of that Task; warrant data
 *   only where the warrant registry shows it; an Agent's verdict only where its
 *   authority may be seen; a disabled Group has no steward; an owned object
 *   only to a reader of it.
 *
 * DESTRUCTIVE: writes principals, credentials, sessions, groups, members, role
 * rows, projects, phases, tasks, reports, skills, a service, grants, profiles
 * and a warrant. It refuses any deployment database and any non-local host,
 * and FAILS - never skips - without a disposable one.
 */

/* eslint-disable @typescript-eslint/no-var-requires */

import http from 'http';
import crypto from 'crypto';

const TEST_DB_URL = process.env.RELAYHALL_TEST_DB_URL;
if (!TEST_DB_URL) {
  throw new Error('RELAYHALL_TEST_DB_URL is required: the Access Explorer drill compares the read model with the enforcing '
    + 'evaluator over stored principals, grants and objects, so it never skips. Load database/init.sql into a disposable '
    + 'database, run npm run migrate, and point RELAYHALL_TEST_DB_URL at it.');
}
const parsed = new URL(TEST_DB_URL);
const TEST_DB_NAME = decodeURIComponent(parsed.pathname.slice(1));
const localDisposable = ['127.0.0.1', 'localhost', '[::1]'].includes(parsed.hostname)
  && /test|contract|fixture/.test(TEST_DB_NAME);
const ciService = process.env.CI === 'true' && parsed.hostname === 'postgres' && TEST_DB_NAME === 'relayhall_ci';
if (!['postgres:', 'postgresql:'].includes(parsed.protocol)
  || ['relayhall', 'relayhall_dev', 'relayhall_tst', 'relayhall_prod'].includes(TEST_DB_NAME)
  || (!localDisposable && !ciService)) {
  throw new Error('Access Explorer drill refuses a non-disposable database target');
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
const { sharedAuthorizationMiddleware, actorFromRequest } = require('../middleware/sharedAuthorization');
const { apiErrorHandler } = require('../utils/apiErrors');
const { jsonBodyOptions } = require('../utils/jsonBodyTypes');
const { loginSessionService, SESSION_COOKIE_NAME } = require('../services/LoginSessionService');
const { principalService } = require('../services/PrincipalService');
const { authorizationRepository } = require('../services/AuthorizationRepository');
const { authorizationService, AUTHORIZATION_ACTIONS, ADMINISTRATOR_ROLES } = require('../services/AuthorizationService');
const { accessExplorerService } = require('../services/AccessExplorerService');
const { insertGroupRow } = require('./support/groupRows');

jest.setTimeout(600_000);

type Caller = { label: string; id: string; headers: Record<string, string>; role?: string | null; parentId?: string | null };
type Answer = { status: number; json: any };
type Obj = { label: string; type: string; id: string };

let server: http.Server;
let origin: string;
const captured = new Map<string, any>();
const tag = (): string => crypto.randomBytes(5).toString('hex');
const SYSTEM = { handle: 'access-explorer-live-fixture', authMethod: 'system' as const };
const sorted = (list: readonly string[]): string[] => [...list].sort();

async function call(who: Caller | null, method: string, routePath: string, body?: unknown): Promise<Answer> {
  const response = await fetch(`${origin}${routePath}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(who ? who.headers : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let json: any = null;
  try { json = JSON.parse(text); } catch { json = null; }
  return { status: response.status, json };
}

async function account(label: string, role: string | null = 'editor'): Promise<Caller> {
  const row = await pool.query(
    `INSERT INTO principals (kind, handle, display_name, status, role) VALUES ('human', $1, $1, 'active', $2) RETURNING id`,
    [`aza12b6-${label}-${tag()}`, role],
  );
  const id = String(row.rows[0].id);
  const session = await loginSessionService.mint({ principalId: id });
  return { label, id, role, headers: { Cookie: `${SESSION_COOKIE_NAME}=${session.token}` } };
}

async function connectorOf(parent: Caller, label: string, objects: unknown = 'parent'): Promise<Caller> {
  const row = await pool.query(
    `INSERT INTO principals (kind, handle, display_name, status, role, parent_principal_id, purpose, own_expression)
     VALUES ('service', $1, $1, 'active', 'user', $2, 'AZ-A12 build 6 drill connector', $3::jsonb) RETURNING id`,
    [`aza12b6-${label}-${tag()}`, parent.id, JSON.stringify({ scopes: 'parent', objects })],
  );
  const id = String(row.rows[0].id);
  const credential = await principalService.issueCredential({
    principalId: id, transport: 'any',
    scopes: ['tasks:read', 'tasks:write', 'projects:read', 'projects:write', 'reports:read', 'principals:read'],
  }, SYSTEM);
  return { label, id, role: 'user', parentId: parent.id, headers: { Authorization: `Bearer ${credential.fullKey}` } };
}

async function agentOf(parent: Caller, label: string, boundTaskId: string, warrantId: string | null): Promise<Caller> {
  const row = await pool.query(
    `INSERT INTO principals (kind, handle, display_name, status, parent_principal_id, bound_task_id, own_expression,
                             source_tag, minted_under_warrant_id)
     VALUES ('agent', $1, $1, 'active', $2, $3, $4::jsonb, $1, $5) RETURNING id`,
    [`aza12b6-${label}-${tag()}`, parent.id, boundTaskId, JSON.stringify({ scopes: ['tasks:read', 'tasks:write'], objects: [] }),
      warrantId],
  );
  const id = String(row.rows[0].id);
  const credential = await principalService.issueCredential({
    principalId: id, scopes: ['tasks:read', 'tasks:write'], expiresAt: new Date(Date.now() + 3600_000), transport: 'any',
  }, SYSTEM);
  return { label, id, role: null, parentId: parent.id, headers: { Authorization: `Bearer ${credential.fullKey}` } };
}

/** The actor the production middleware builds for this caller, captured on a real request; null when it is refused. */
async function actorOf(who: Caller): Promise<any | null> {
  captured.delete(who.id);
  await call(who, 'GET', '/tasks?limit=1');
  return captured.get(who.id) ?? null;
}

const newGroup = (label: string): Promise<string> =>
  insertGroupRow(pool, { name: `aza12b6 ${label} ${tag()}`, description: 'AZ-A12 build 6 drill', featured: false });
async function join(groupId: string, accountId: string, source: 'local' | 'directory' = 'local'): Promise<void> {
  await pool.query('INSERT INTO group_members (group_id, account_principal_id, source) VALUES ($1, $2, $3)', [groupId, accountId, source]);
}
async function appoint(groupId: string, accountId: string, role: 'owner' | 'manager'): Promise<void> {
  await pool.query('INSERT INTO group_stewards (group_id, account_principal_id, role) VALUES ($1, $2, $3)', [groupId, accountId, role]);
}
async function project(owner: string | null): Promise<string> {
  return String((await pool.query(
    `INSERT INTO projects (name, status, visibility, owner_principal_id) VALUES ($1, 'active', 'private', $2) RETURNING id`,
    [`aza12b6 project ${tag()}`, owner])).rows[0].id);
}
async function phase(projectId: string, restricted = false): Promise<string> {
  return String((await pool.query('INSERT INTO phases (project_id, name, restricted_access) VALUES ($1, $2, $3) RETURNING id',
    [projectId, `aza12b6 phase ${tag()}`, restricted])).rows[0].id);
}
async function task(projectId: string, fields: {
  accountOwner?: string | null; restricted?: boolean; phaseId?: string | null; creator?: string;
  claimant?: string | null; shepherd?: string | null; verifier?: string | null;
} = {}): Promise<string> {
  return String((await pool.query(
    `INSERT INTO tasks (title, status, visibility, project_id, phase_id, restricted_access, creator_principal_id,
                        account_owner_principal_id, owner_principal_id, shepherd_principal_id, verifier_principal_id)
     VALUES ($1, 'todo', 'private', $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id`,
    [`aza12b6 task ${tag()}`, projectId, fields.phaseId ?? null, fields.restricted ?? false, fields.creator ?? CREATOR.id,
      fields.accountOwner ?? null, fields.claimant ?? null, fields.shepherd ?? null, fields.verifier ?? null],
  )).rows[0].id);
}
async function report(accountOwner: string, author: string): Promise<string> {
  return String((await pool.query(
    `INSERT INTO reports (title, content, author, author_actor_id, author_principal_id, visibility, account_owner_principal_id)
     VALUES ($1, 'AZ-A12 build 6 drill report', 'aza12b6', 'aza12b6', $2, 'private', $3) RETURNING id`,
    [`aza12b6 report ${tag()}`, author, accountOwner])).rows[0].id);
}
async function skill(owner: string): Promise<string> {
  return String((await pool.query('INSERT INTO skills (name, owner_principal_id) VALUES ($1, $2) RETURNING id',
    [`aza12b6-skill-${tag()}`, owner])).rows[0].id);
}
async function grant(granteeType: 'principal' | 'group', granteeId: string, resourceType: string, resourceId: string | null,
  verb: string, expired = false): Promise<string> {
  return String((await pool.query(
    `INSERT INTO grants (grantee_type, grantee_id, resource_type, resource_id, verb, origin, expires_at)
     VALUES ($1, $2, $3, $4, $5, 'manual', ${expired ? "NOW() - INTERVAL '1 hour'" : 'NULL'}) RETURNING id`,
    [granteeType, granteeId, resourceType, resourceId, verb])).rows[0].id);
}
async function profileOn(assigneeId: string, resourceType: string, ids: string[], verbs: string[]): Promise<string> {
  const profileId = String((await pool.query('INSERT INTO access_profiles (name, description) VALUES ($1, $2) RETURNING id',
    [`aza12b6-profile-${tag()}`, 'AZ-A12 build 6 drill'])).rows[0].id);
  const versionId = String((await pool.query(
    'INSERT INTO access_profile_versions (profile_id, version_number) VALUES ($1, 1) RETURNING id', [profileId])).rows[0].id);
  await pool.query(`INSERT INTO access_profile_rules (version_id, resource_type, selector_form, selector_ids, verbs)
                    VALUES ($1, $2, 'exact', $3::uuid[], $4::text[])`, [versionId, resourceType, ids, verbs]);
  await pool.query('UPDATE access_profiles SET published_version_id = $1 WHERE id = $2', [versionId, profileId]);
  await pool.query(`INSERT INTO access_profile_assignments (profile_id, assignee_type, assignee_id) VALUES ($1, 'principal', $2)`,
    [profileId, assigneeId]);
  return profileId;
}
async function warrantFor(holderId: string, anchorTaskId: string): Promise<string> {
  const profile = String((await pool.query('INSERT INTO access_profiles (name, description) VALUES ($1, $2) RETURNING id',
    [`aza12b6-ceiling-${tag()}`, 'AZ-A12 build 6 warrant ceiling'])).rows[0].id);
  const version = String((await pool.query(
    'INSERT INTO access_profile_versions (profile_id, version_number) VALUES ($1, 1) RETURNING id', [profile])).rows[0].id);
  await pool.query('UPDATE access_profiles SET published_version_id = $1 WHERE id = $2', [version, profile]);
  const warrant = String((await pool.query(
    `INSERT INTO warrants (name, holder_principal_id, created_by_principal_id, ceiling_profile_version_id, expires_at)
     VALUES ($1, $2, $3, $4, NOW() + INTERVAL '1 day') RETURNING id`,
    [`aza12b6 warrant ${tag()}`, holderId, ADMIN.id, version])).rows[0].id);
  await pool.query(`INSERT INTO warrant_anchors (warrant_id, anchor_type, anchor_id) VALUES ($1, 'task', $2)`, [warrant, anchorTaskId]);
  return warrant;
}

/** The point decision for every action, for the actor the middleware built (none when it refused the caller). */
async function pointActions(actor: any | null, obj: Obj): Promise<string[]> {
  if (!actor) return [];
  const out: string[] = [];
  for (const action of AUTHORIZATION_ACTIONS) {
    if ((await authorizationRepository.authorizePoint(actor, obj.type, obj.id, action)).allowed) out.push(action);
  }
  return out;
}

let CREATOR: Caller;
let ADMIN: Caller;
let OPERATOR: Caller;
const P: Record<string, Caller> = {};
const O: Record<string, string> = {};
let G = '';
let G2 = '';
let G3 = '';
let WARRANT = '';
let MATRIX_PRINCIPALS: Caller[] = [];
let MATRIX_OBJECTS: Obj[] = [];
const EXPECTED = new Map<string, string[]>();
const MIDDLEWARE_ACTOR = new Map<string, any | null>();

beforeAll(async () => {
  const app = express();
  app.use(express.json(jsonBodyOptions));
  app.use(express.urlencoded({ extended: true }));
  registerProtectedRoutes((mountPath: string, ...handlers: any[]) => {
    app.use(mountPath, authMiddleware, (req: any, _res: any, next: any) => {
      const actor = actorFromRequest(req);
      if (actor.principalId) captured.set(actor.principalId, actor);
      next();
    }, sharedAuthorizationMiddleware, ...handlers);
  });
  app.use(apiErrorHandler);
  await new Promise<void>((resolve) => { server = app.listen(0, '127.0.0.1', resolve); });
  origin = `http://127.0.0.1:${(server.address() as any).port}`;

  CREATOR = await account('creator');
  ADMIN = await account('admin', 'admin');
  OPERATOR = await account('operator', 'operator');
  for (const [label, role] of [
    ['personOwner', 'editor'], ['member', 'editor'], ['manager', 'editor'], ['ownerRole', 'editor'], ['viewerMember', 'viewer'],
    ['inertSteward', 'editor'], ['stranger', 'editor'], ['liveGrantee', 'editor'], ['expiredGrantee', 'editor'],
    ['wildcardGrantee', 'editor'], ['g2Member', 'editor'], ['profileAssignee', 'editor'], ['claimant', 'editor'],
    ['shepherd', 'editor'], ['verifier', 'editor'], ['disabledMember', 'editor'], ['g3Member', 'editor'],
  ] as Array<[string, string]>) {
    P[label] = await account(label, role);
  }
  G = await newGroup('owning');
  G2 = await newGroup('granted');
  G3 = await newGroup('disabled');
  for (const label of ['member', 'manager', 'ownerRole', 'viewerMember', 'disabledMember']) await join(G, P[label].id);
  await join(G, P.g2Member.id, 'directory');
  await appoint(G, P.manager.id, 'manager');
  await appoint(G, P.ownerRole.id, 'owner');
  await appoint(G, P.inertSteward.id, 'manager'); // not a member: inert
  await join(G2, P.g2Member.id);
  await join(G3, P.g3Member.id);

  // Group-owned estate (clause 7's paths) and a person-owned estate.
  O.P = await project(G);
  O.PH = await phase(O.P);
  O.PHR = await phase(O.P, true);
  O.TA = await task(O.P);
  O.TB = await task(O.P, { accountOwner: P.personOwner.id });
  O.TR = await task(O.P, { restricted: true });
  O.TPH = await task(O.P, { phaseId: O.PHR });
  O.R = await report(G, CREATOR.id);
  O.S = await skill(G);
  O.P2 = await project(P.personOwner.id);
  O.T2 = await task(O.P2, { claimant: P.claimant.id, shepherd: P.shepherd.id, verifier: P.verifier.id });
  O.R2 = await report(P.personOwner.id, CREATOR.id);
  O.S2 = await skill(P.personOwner.id);
  O.P3 = await project(G3);
  O.SV = String((await pool.query(
    `INSERT INTO services (slug, name, description, kind, status) VALUES ($1, 'aza12b6 service', 'AZ-A12 build 6', 'service', 'published')
     RETURNING id`, [`aza12b6-service-${tag()}`])).rows[0].id);

  O.grantLive = await grant('principal', P.liveGrantee.id, 'project', O.P2, 'write');
  O.grantExpired = await grant('principal', P.expiredGrantee.id, 'project', O.P2, 'write', true);
  O.grantWildcard = await grant('principal', P.wildcardGrantee.id, 'report', null, 'read');
  O.grantGroup = await grant('group', G2, 'project', O.P2, 'read');
  O.grantGroupExpired = await grant('group', G, 'project', O.P2, 'write', true);
  O.grantGroupToG = await grant('group', G, 'report', O.R2, 'read');
  O.grantMemberPersonal = await grant('principal', P.member.id, 'task', O.T2, 'read');
  O.profile = await profileOn(P.profileAssignee.id, 'task', [O.T2], ['read', 'write']);

  // The chain: Connectors under the manager and the person owner, an Agent under a Warrant, a dead Agent.
  P.managerConnector = await connectorOf(P.manager, 'manager-connector');
  P.narrowConnector = await connectorOf(P.manager, 'narrow-connector',
    [{ resourceType: 'task', selectorForm: 'exact', selectorIds: [O.TA], verbs: ['read'] }]);
  P.ownerConnector = await connectorOf(P.personOwner, 'owner-connector');
  WARRANT = await warrantFor(P.managerConnector.id, O.TA);
  P.warrantAgent = await agentOf(P.managerConnector, 'warrant-agent', O.TA, WARRANT);
  P.deadAgent = await agentOf(P.managerConnector, 'dead-agent', O.TB, null);
  await pool.query('UPDATE principal_credentials SET revoked_at = NOW() WHERE principal_id = $1', [P.deadAgent.id]);
  await pool.query("UPDATE principals SET status = 'disabled' WHERE id = $1", [P.disabledMember.id]);
  await pool.query("UPDATE principals SET status = 'disabled' WHERE id = $1", [G3]);

  MATRIX_PRINCIPALS = [ADMIN, OPERATOR, CREATOR, ...Object.values(P)];
  MATRIX_OBJECTS = [
    ['P', 'project'], ['PH', 'phase'], ['PHR', 'phase'], ['TA', 'task'], ['TB', 'task'], ['TR', 'task'], ['TPH', 'task'],
    ['R', 'report'], ['S', 'skill'], ['P2', 'project'], ['T2', 'task'], ['R2', 'report'], ['S2', 'skill'], ['P3', 'project'],
    ['SV', 'service'],
  ].map(([label, type]) => ({ label, type, id: O[label] }));
  for (const who of MATRIX_PRINCIPALS) MIDDLEWARE_ACTOR.set(who.id, await actorOf(who));
  for (const who of MATRIX_PRINCIPALS) {
    for (const obj of MATRIX_OBJECTS) EXPECTED.set(`${who.id}:${obj.id}`, await pointActions(MIDDLEWARE_ACTOR.get(who.id), obj));
  }
});

afterAll(async () => {
  if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  await pool.end();
});

const expected = (who: Caller, obj: Obj): string[] => EXPECTED.get(`${who.id}:${obj.id}`) ?? [];

describe('(M) the matrix: the read model agrees with the enforcing evaluator', () => {
  it('the generated estate exercises every kind of source (the matrix is not vacuous)', () => {
    const at = (label: string, object: string): string[] => expected(P[label], MATRIX_OBJECTS.find((o) => o.label === object)!);
    expect(MIDDLEWARE_ACTOR.get(P.deadAgent.id)).toBeNull();
    expect(MIDDLEWARE_ACTOR.get(P.disabledMember.id)).toBeNull();
    expect(sorted(at('member', 'P'))).toEqual(sorted(['read', 'use', 'invoke']));
    expect(sorted(at('manager', 'TB'))).toEqual(sorted(['read', 'write', 'claim', 'finish', 'release']));
    expect(at('member', 'TR')).toEqual([]);
    expect(sorted(at('liveGrantee', 'P2'))).toEqual(sorted(['read', 'write', 'claim', 'finish', 'release']));
    expect(at('expiredGrantee', 'P2')).toEqual([]);
    expect(at('g2Member', 'P2')).toEqual(['read']);
    expect(at('wildcardGrantee', 'R2')).toEqual(['read']);
    expect(sorted(at('profileAssignee', 'T2'))).toEqual(sorted(['read', 'write', 'claim', 'finish', 'release']));
    expect(at('shepherd', 'T2')).toEqual(expect.arrayContaining(['shepherd']));
    expect(at('g3Member', 'P3')).toEqual([]);
    expect(at('warrantAgent', 'TA').length).toBeGreaterThan(0);
    expect(at('narrowConnector', 'TA')).toEqual(['read']);
    expect(at('narrowConnector', 'TB')).toEqual([]);
    expect(sorted(at('managerConnector', 'TB'))).toEqual(sorted(['read', 'write', 'claim', 'finish', 'release']));
  });

  it("the read model's verdict equals the point decision for every principal, object and action", async () => {
    const disagreements: unknown[] = [];
    for (const who of MATRIX_PRINCIPALS) {
      const actor = await accessExplorerService.actorFor(who.id);
      for (const obj of MATRIX_OBJECTS) {
        const verdict = actor ? (await accessExplorerService.verdict(actor, obj.type, obj.id)).map((entry: any) => entry.action) : [];
        if (JSON.stringify(sorted(verdict)) !== JSON.stringify(sorted(expected(who, obj)))) {
          disagreements.push({ who: who.label, object: obj.label, explorer: sorted(verdict), enforced: sorted(expected(who, obj)) });
        }
      }
    }
    expect(disagreements).toEqual([]);
  });

  it('a dead delegated identity gets an unauthenticated actor, as the middleware refuses it', async () => {
    expect(MIDDLEWARE_ACTOR.get(P.deadAgent.id)).toBeNull();
    const dead = await accessExplorerService.actorFor(P.deadAgent.id);
    expect(dead.authenticated).toBe(false);
    expect((await accessExplorerService.actorFor(P.warrantAgent.id)).authenticated).toBe(true);
    expect(await accessExplorerService.verdict(dead, 'task', O.TB)).toEqual([]);
  });

  it('a Group principal is never an actor and never a holder', async () => {
    expect(await accessExplorerService.actorFor(G)).toBeNull();
    for (const obj of MATRIX_OBJECTS) {
      const hop = await call(ADMIN, 'GET', `/access-explorer/objects/${obj.type}/${obj.id}`);
      expect(hop.json.explorer.holders.filter((holder: any) => holder.kind === 'group')).toEqual([]);
    }
  });

  it('the HTTP object hop (root) lists every principal admitted beyond the board-wide classes, with exactly its verdict', async () => {
    const problems: unknown[] = [];
    const hops = new Map<string, any>();
    for (const obj of MATRIX_OBJECTS) {
      const hop = await call(ADMIN, 'GET', `/access-explorer/objects/${obj.type}/${obj.id}`);
      expect([obj.label, hop.status, hop.json?.explorer?.projection]).toEqual([obj.label, 200, 'root']);
      hops.set(obj.id, hop.json.explorer);
    }
    const childVerdicts = new Map<string, Map<string, string[]>>();
    const childrenOf = async (parentId: string, obj: Obj): Promise<Map<string, string[]>> => {
      const key = `${parentId}:${obj.id}`;
      if (!childVerdicts.has(key)) {
        const hop = await call(ADMIN, 'GET', `/access-explorer/principals/${parentId}?objectType=${obj.type}&objectId=${obj.id}`);
        expect([hop.status]).toEqual([200]);
        childVerdicts.set(key, new Map(hop.json.explorer.children.map((child: any) =>
          [child.principalId, child.actions.map((entry: any) => entry.action)])));
      }
      return childVerdicts.get(key)!;
    };
    for (const obj of MATRIX_OBJECTS) {
      const explorer = hops.get(obj.id);
      const listed = new Map<string, string[]>(explorer.holders.map((holder: any) =>
        [holder.principalId, holder.actions.map((entry: any) => entry.action)]));
      for (const who of MATRIX_PRINCIPALS) {
        const want = sorted(expected(who, obj));
        let got = listed.get(who.id);
        if (got === undefined && who.parentId) got = (await childrenOf(who.parentId, obj)).get(who.id);
        if (got !== undefined) {
          if (JSON.stringify(sorted(got)) !== JSON.stringify(want)) problems.push({ who: who.label, object: obj.label, listed: sorted(got), want });
          continue;
        }
        const administrator = ADMINISTRATOR_ROLES.has(String(who.role ?? ''));
        const boardWide = administrator ? [...AUTHORIZATION_ACTIONS]
          : explorer.boardWide.readableByEveryAuthenticatedPrincipal ? ['read'] : [];
        const unexplained = want.filter((action) => !boardWide.includes(action));
        if (unexplained.length > 0) problems.push({ who: who.label, object: obj.label, missing: unexplained });
      }
    }
    expect(problems).toEqual([]);
  });

  it('NEGATIVE CONTROL: a second rule set (the in-memory fast path) disagrees on the same matrix', async () => {
    const disagreements: unknown[] = [];
    for (const who of MATRIX_PRINCIPALS) {
      const actor = MIDDLEWARE_ACTOR.get(who.id);
      if (!actor) continue;
      for (const obj of MATRIX_OBJECTS) {
        const resource = await (authorizationRepository as any).resolve(obj.type, obj.id);
        const second = AUTHORIZATION_ACTIONS.filter((action: string) =>
          authorizationService.authorizeResource(actor, action, resource, []).allowed);
        if (JSON.stringify(sorted(second)) !== JSON.stringify(sorted(expected(who, obj)))) {
          disagreements.push({ who: who.label, object: obj.label });
        }
      }
    }
    // The comparison can fail: the Group-owner cells alone already disagree.
    expect(disagreements).toEqual(expect.arrayContaining([{ who: 'member', object: 'P' }, { who: 'liveGrantee', object: 'P2' }]));
  });
});

describe('(C) concealment and refusals', () => {
  it('an object the caller cannot read answers exactly as an absent one', async () => {
    const hidden = await call(P.stranger, 'GET', `/access-explorer/objects/project/${O.P}`);
    const absent = await call(P.stranger, 'GET', `/access-explorer/objects/project/${crypto.randomUUID()}`);
    expect(hidden.status).toBe(404);
    expect(hidden).toEqual(absent);
    expect(hidden.json.code).toBe('RESOURCE_NOT_FOUND');
    const viaGroup = await call(P.stranger, 'GET', `/access-explorer/groups/${G}?objectType=task&objectId=${O.TA}`);
    expect([viaGroup.status, viaGroup.json.code]).toEqual([404, 'RESOURCE_NOT_FOUND']);
    const viaPrincipal = await call(P.stranger, 'GET', `/access-explorer/principals/${P.stranger.id}?objectType=report&objectId=${O.R}`);
    expect([viaPrincipal.status, viaPrincipal.json.code]).toEqual([404, 'RESOURCE_NOT_FOUND']);
  });

  it('malformed input is refused by name', async () => {
    expect((await call(ADMIN, 'GET', `/access-explorer/objects/charter/${O.P}`)).json.code).toBe('INVALID_EXPLORER_TYPE');
    expect((await call(ADMIN, 'GET', '/access-explorer/objects/project/not-a-uuid')).json.code).toBe('INVALID_EXPLORER_OBJECT_ID');
    expect((await call(ADMIN, 'GET', `/access-explorer/groups/${G}?objectType=task`)).json.code).toBe('INVALID_EXPLORER_QUERY');
    expect((await call(ADMIN, 'GET', `/access-explorer/principals/${G}`)).json.code).toBe('GROUP_PRINCIPAL_USE_GROUP_VIEW');
    expect((await call(ADMIN, 'GET', `/access-explorer/principals/${crypto.randomUUID()}`)).json.code).toBe('PRINCIPAL_NOT_FOUND');
  });

  it('a credential without principals:read is refused at the family ceiling', async () => {
    const row = await pool.query(
      `INSERT INTO principals (kind, handle, display_name, status, role, parent_principal_id, purpose, own_expression)
       VALUES ('service', $1, $1, 'active', 'user', $2, 'ceiling probe', '{"scopes":"parent","objects":"parent"}'::jsonb) RETURNING id`,
      [`aza12b6-noscope-${tag()}`, CREATOR.id]);
    const credential = await principalService.issueCredential({ principalId: String(row.rows[0].id), scopes: ['tasks:read'], transport: 'any' }, SYSTEM);
    const answer = await call({ label: 'noscope', id: String(row.rows[0].id), headers: { Authorization: `Bearer ${credential.fullKey}` } },
      'GET', `/access-explorer/objects/task/${O.TA}`);
    expect(answer.status).toBe(403);
  });
});

describe('(P) the projections', () => {
  it("a member reads ownership, the owning Group and its own verdict, never another principal's authority", async () => {
    const hop = await call(P.member, 'GET', `/access-explorer/objects/project/${O.P}`);
    expect(hop.status).toBe(200);
    const explorer = hop.json.explorer;
    expect(explorer.projection).toBe('self');
    expect(explorer.owner).toEqual({ principalId: G, kind: 'group', displayName: expect.any(String) });
    expect(explorer.groups.map((group: any) => [group.groupId, group.relation])).toEqual([[G, 'owner']]);
    expect(explorer.holders.map((holder: any) => holder.principalId)).toEqual([P.member.id]);
    expect(sorted(explorer.holders[0].actions.map((entry: any) => entry.action))).toEqual(sorted(['read', 'use', 'invoke']));
    expect(explorer.holders[0].actions).toEqual(expect.arrayContaining([{ action: 'read', sources: ['group-owner'] }]));
    expect([explorer.grants, 'profiles' in explorer]).toEqual([null, false]);
  });

  it('a Task on clause 7 path (b) names its explicit owner, and its Project owner only to a Project reader', async () => {
    const hop = await call(P.manager, 'GET', `/access-explorer/objects/task/${O.TB}`);
    expect(hop.json.explorer.owner.principalId).toBe(P.personOwner.id);
    expect(hop.json.explorer.projectOwner.principalId).toBe(G);
    expect(hop.json.explorer.holders).toEqual([expect.objectContaining({
      principalId: P.manager.id,
      actions: expect.arrayContaining([{ action: 'write', sources: ['group-project-owner'] }]),
    })]);
  });

  it("a Task's Project owner is hidden from a Task reader who cannot read the Project", async () => {
    const actor = MIDDLEWARE_ACTOR.get(P.personOwner.id);
    expect((await authorizationRepository.authorizePoint(actor, 'task', O.TB, 'read')).allowed).toBe(true);
    expect((await authorizationRepository.authorizePoint(actor, 'project', O.P, 'read')).allowed).toBe(false);
    const hop = await call(P.personOwner, 'GET', `/access-explorer/objects/task/${O.TB}`);
    expect(hop.status).toBe(200);
    expect(hop.json.explorer.owner.principalId).toBe(P.personOwner.id);
    expect(hop.json.explorer.projectOwner).toBeNull();
    expect(hop.json.explorer.groups).toEqual([]);
    expect(JSON.stringify(hop.json)).not.toContain(G);
  });

  it('root sees every grant holder and the grant rows naming the object, live and expired', async () => {
    const hop = await call(ADMIN, 'GET', `/access-explorer/objects/project/${O.P2}`);
    const explorer = hop.json.explorer;
    expect(explorer.projection).toBe('root');
    const grants = new Map(explorer.grants.map((entry: any) => [entry.grantId, entry]));
    expect((grants.get(O.grantLive) as any).live).toBe(true);
    expect((grants.get(O.grantExpired) as any).live).toBe(false);
    expect((grants.get(O.grantGroup) as any)).toEqual(expect.objectContaining({ granteeType: 'group', granteeId: G2, live: true }));
    expect(explorer.groups.map((group: any) => [group.groupId, group.relations])).toEqual(expect.arrayContaining([[G2, ['grantee']]]));
    const holders = new Map(explorer.holders.map((holder: any) => [holder.principalId, holder]));
    expect(holders.get(P.expiredGrantee.id)).toEqual(expect.objectContaining({ actions: [] }));
    expect(holders.get(P.liveGrantee.id)).toEqual(expect.objectContaining({ via: [{ source: 'grant', id: O.grantLive }] }));
    const t2 = (await call(ADMIN, 'GET', `/access-explorer/objects/task/${O.T2}`)).json.explorer;
    expect(t2.grants.map((entry: any) => [entry.grantId, entry.selector])).toEqual(expect.arrayContaining([[O.grantLive, 'project']]));
    expect(t2.boardWide.readableByEveryAuthenticatedPrincipal).toBe(false);
    const assignee = t2.holders.find((holder: any) => holder.principalId === P.profileAssignee.id);
    expect(assignee).toEqual(expect.objectContaining({
      via: [{ source: 'profile', id: O.profile }],
      actions: expect.arrayContaining([{ action: 'write', sources: ['profile'] }]),
    }));
    expect('profiles' in t2).toBe(false);
    const service = (await call(ADMIN, 'GET', `/access-explorer/objects/service/${O.SV}`)).json.explorer;
    expect(service.boardWide.readableByEveryAuthenticatedPrincipal).toBe(true);
  });

  it("root lists a granted Group's members as holders through that Group", async () => {
    const explorer = (await call(ADMIN, 'GET', `/access-explorer/objects/project/${O.P2}`)).json.explorer;
    const holders = new Map(explorer.holders.map((holder: any) => [holder.principalId, holder]));
    expect(holders.get(P.g2Member.id)).toEqual(expect.objectContaining({
      via: expect.arrayContaining([{ source: 'group-member', id: G2 }]),
      actions: [{ action: 'read', sources: ['grant'] }],
    }));
  });
});

describe('(G) the Group hop', () => {
  it('lists members with the tier the clause-6 fragment gives, their source and role, and flags inert role rows', async () => {
    const hop = await call(P.stranger, 'GET', `/access-explorer/groups/${G}`);
    expect(hop.status).toBe(200);
    const members = new Map(hop.json.explorer.members.map((member: any) => [member.principalId, member]));
    const tier = (label: string): string | undefined => (members.get(P[label].id) as any)?.tier;
    expect([tier('member'), tier('manager'), tier('ownerRole'), tier('viewerMember'), tier('disabledMember'), tier('g2Member')])
      .toEqual(['use', 'edit', 'edit', 'use', 'none', 'use']);
    expect((members.get(P.ownerRole.id) as any)).toEqual(expect.objectContaining({ role: 'owner', roleLive: true }));
    expect((members.get(P.manager.id) as any)).toEqual(expect.objectContaining({ role: 'manager', roleLive: true }));
    expect((members.get(P.member.id) as any)).toEqual(expect.objectContaining({ role: 'member', roleLive: null }));
    expect((members.get(P.g2Member.id) as any).source).toBe('directory');
    expect(hop.json.explorer.inertRoles).toEqual([expect.objectContaining({
      principalId: P.inertSteward.id, role: 'manager', inertReason: 'not_a_member', member: false,
    })]);
    expect(hop.json.explorer.members.some((member: any) => 'actions' in member)).toBe(false);
  });

  it('a disabled Group gives no tier to anyone', async () => {
    const hop = await call(ADMIN, 'GET', `/access-explorer/groups/${G3}`);
    expect(hop.json.explorer.group.ownershipStatus).toBe('disabled');
    expect(hop.json.explorer.members.map((member: any) => member.tier)).toEqual(['none']);
  });

  it("with an object, root sees each member's verdict and a member only its own", async () => {
    const rootHop = await call(ADMIN, 'GET', `/access-explorer/groups/${G}?objectType=task&objectId=${O.TA}`);
    const rootRows = new Map(rootHop.json.explorer.members.map((member: any) => [member.principalId, member.actions.map((a: any) => a.action)]));
    expect(sorted(rootRows.get(P.manager.id) as string[])).toEqual(sorted(expected(P.manager, { label: 'TA', type: 'task', id: O.TA })));
    const memberHop = await call(P.member, 'GET', `/access-explorer/groups/${G}?objectType=task&objectId=${O.TA}`);
    const withActions = memberHop.json.explorer.members.filter((member: any) => 'actions' in member);
    expect(withActions.map((member: any) => member.principalId)).toEqual([P.member.id]);
  });
});

describe('(A) the principal hop', () => {
  it("an Account's Connectors are listed to anyone; their authority only to root, itself and its Account's session", async () => {
    const stranger = await call(P.stranger, 'GET', `/access-explorer/principals/${P.manager.id}`);
    expect(stranger.json.explorer.projection).toBe('directory');
    expect(stranger.json.explorer.authority).toBeNull();
    expect(stranger.json.explorer.children.map((child: any) => child.id).sort())
      .toEqual([P.managerConnector.id, P.narrowConnector.id].sort());
    const owner = await call(P.manager, 'GET', `/access-explorer/principals/${P.narrowConnector.id}`);
    expect(owner.json.explorer.projection).toBe('self');
    expect(owner.json.explorer.authority.ownCap.objects).toEqual([
      { resourceType: 'task', selectorForm: 'exact', selectorIds: [O.TA], verbs: ['read'] }]);
    const bearer = await call(P.narrowConnector, 'GET', `/access-explorer/principals/${P.managerConnector.id}`);
    expect(bearer.json.explorer.authority).toBeNull();
    const self = await call(P.narrowConnector, 'GET', `/access-explorer/principals/${P.narrowConnector.id}`);
    expect(self.json.explorer.authority).not.toBeNull();
  });

  it("root sees a Connector's warrants and its Agent minted under one, with their verdicts on an object", async () => {
    const hop = await call(ADMIN, 'GET', `/access-explorer/principals/${P.managerConnector.id}?objectType=task&objectId=${O.TA}`);
    const explorer = hop.json.explorer;
    expect(explorer.authority.warrants.map((warrant: any) => [warrant.warrantId, warrant.anchors])).toEqual([
      [WARRANT, [{ type: 'task', id: O.TA }]]]);
    const agent = explorer.children.find((child: any) => child.principalId === P.warrantAgent.id);
    expect(agent.mintedUnderWarrantId).toBe(WARRANT);
    expect(sorted(agent.actions.map((entry: any) => entry.action))).toEqual(sorted(expected(P.warrantAgent, { label: 'TA', type: 'task', id: O.TA })));
    const dead = explorer.children.find((child: any) => child.principalId === P.deadAgent.id);
    expect(dead.actions).toEqual([]);
    expect(sorted(explorer.authority.actions.map((entry: any) => entry.action)))
      .toEqual(sorted(expected(P.managerConnector, { label: 'TA', type: 'task', id: O.TA })));
  });

  it('a principal whose authority the caller may not see is shown exactly as GET /principals shows it: no bound Task, no Warrant', async () => {
    // Review r1 LEAK A, its exact shape: a stranger (login session, and a
    // bearer of its own Connector) reads the manager's Connector, whose Agents
    // are bound to a Task the stranger cannot read, one minted under a Warrant.
    const strangerBearer = await connectorOf(P.stranger, 'stranger-connector');
    for (const viewer of [P.stranger, strangerBearer]) {
      expect([viewer.label, (await call(viewer, 'GET', `/tasks/${O.TA}`)).status]).toEqual([viewer.label, 404]);
      const directory = new Map((await call(viewer, 'GET', '/principals')).json.principals.map((entry: any) => [entry.id, entry]));
      const hop = await call(viewer, 'GET', `/access-explorer/principals/${P.managerConnector.id}`);
      expect([viewer.label, hop.status, hop.json.explorer.projection, hop.json.explorer.authority])
        .toEqual([viewer.label, 200, 'directory', null]);
      expect(hop.json.explorer.principal).toEqual(directory.get(P.managerConnector.id));
      expect(hop.json.explorer.children.map((child: any) => child.id).sort()).toEqual([P.warrantAgent.id, P.deadAgent.id].sort());
      for (const child of hop.json.explorer.children) expect(child).toEqual(directory.get(child.id));
      const text = JSON.stringify(hop.json);
      expect([viewer.label, text.includes(O.TA), text.includes(WARRANT), text.includes('boundTaskId'), text.includes('mintedUnderWarrantId')])
        .toEqual([viewer.label, false, false, false, false]);
    }
  });

  it('a hidden principal is filtered as GET /principals filters it, and answered as an absent one', async () => {
    const hidden = String((await pool.query(
      `INSERT INTO principals (kind, handle, display_name, status, role, parent_principal_id, purpose, own_expression, metadata)
       VALUES ('service', $1, $1, 'active', 'user', $2, 'AZ-A12 build 6 hidden child', '{"scopes":"parent","objects":"parent"}'::jsonb,
               '{"internal":true}'::jsonb) RETURNING id`,
      [`aza12b6-hidden-${tag()}`, P.manager.id])).rows[0].id);
    const listed = (await call(P.stranger, 'GET', '/principals')).json.principals.map((entry: any) => entry.id);
    expect(listed).not.toContain(hidden);
    const stranger = await call(P.stranger, 'GET', `/access-explorer/principals/${P.manager.id}`);
    expect(stranger.json.explorer.children.map((child: any) => child.id)).not.toContain(hidden);
    const direct = await call(P.stranger, 'GET', `/access-explorer/principals/${hidden}`);
    const absent = await call(P.stranger, 'GET', `/access-explorer/principals/${crypto.randomUUID()}`);
    expect(direct.status).toBe(404);
    expect(direct).toEqual(absent);
    const root = await call(ADMIN, 'GET', `/access-explorer/principals/${P.manager.id}`);
    expect(root.json.explorer.children.map((child: any) => child.principalId)).toContain(hidden);
  });

  it("a login session's own subtree shows an Agent's bound Task only where the session reads that Task", async () => {
    const foreignAgent = await agentOf(P.ownerConnector, 'foreign-bound-agent', O.TA, null);
    expect((await call(P.personOwner, 'GET', `/tasks/${O.TA}`)).status).toBe(404);
    const own = await call(P.personOwner, 'GET', `/access-explorer/principals/${P.ownerConnector.id}`);
    expect(own.json.explorer.projection).toBe('self');
    const child = own.json.explorer.children.find((entry: any) => entry.principalId === foreignAgent.id);
    expect(child).toEqual(expect.objectContaining({ kind: 'agent', boundTaskId: null }));
    expect(JSON.stringify(own.json)).not.toContain(O.TA);
    const root = await call(ADMIN, 'GET', `/access-explorer/principals/${P.ownerConnector.id}`);
    expect(root.json.explorer.children.find((entry: any) => entry.principalId === foreignAgent.id).boundTaskId).toBe(O.TA);
  });

  it('a bearer reading itself sees no warrant registry data, which no bearer surface shows', async () => {
    expect((await call(P.managerConnector, 'GET', '/warrants')).status).toBe(403);
    const self = (await call(P.managerConnector, 'GET', `/access-explorer/principals/${P.managerConnector.id}`)).json.explorer;
    expect(self.projection).toBe('self');
    expect(self.authority.warrants).toBeNull();
    const agent = self.children.find((entry: any) => entry.principalId === P.warrantAgent.id);
    expect(agent.mintedUnderWarrantId).toBeNull();
    expect(agent.boundTaskId).toBe(O.TA);
    const session = (await call(P.manager, 'GET', `/access-explorer/principals/${P.managerConnector.id}`)).json.explorer;
    expect(session.authority.warrants.map((warrant: any) => warrant.warrantId)).toEqual([WARRANT]);
    expect(session.children.find((entry: any) => entry.principalId === P.warrantAgent.id).mintedUnderWarrantId).toBe(WARRANT);
  });

  it("a bearer reading itself sees no Agent's verdict: an Agent's authority is not its parent Connector's to see", async () => {
    const self = (await call(P.managerConnector, 'GET',
      `/access-explorer/principals/${P.managerConnector.id}?objectType=task&objectId=${O.TA}`)).json.explorer;
    expect(self.authority.actions.length).toBeGreaterThan(0);
    expect(self.children.length).toBeGreaterThan(0);
    expect(self.children.filter((entry: any) => 'actions' in entry)).toEqual([]);
    const session = (await call(P.manager, 'GET',
      `/access-explorer/principals/${P.managerConnector.id}?objectType=task&objectId=${O.TA}`)).json.explorer;
    expect(session.children.every((entry: any) => Array.isArray(entry.actions))).toBe(true);
  });
});

describe('(S) SR-3: the authority reaching one member through one Group', () => {
  it('root and a live steward on a login session see only what reaches the member through the Group', async () => {
    for (const viewer of [ADMIN, P.manager]) {
      const answer = await call(viewer, 'GET', `/groups/${G}/members/${P.member.id}/access`);
      expect(answer.status).toBe(200);
      const access = answer.json.access;
      expect(access.member).toEqual(expect.objectContaining({ tier: 'use', source: 'local' }));
      expect(access.grants.map((entry: any) => [entry.grantId, entry.reachesMember]).sort())
        .toEqual([[O.grantGroupExpired, false], [O.grantGroupToG, true]].sort());
      expect(access.grants.map((entry: any) => entry.grantId)).not.toContain(O.grantMemberPersonal);
      const owned = new Map(access.owned.map((entry: any) => [`${entry.type}:${entry.id}`, entry.actions]));
      expect(sorted((owned.get(`project:${O.P}`) as any[]).map((entry) => entry.action))).toEqual(sorted(['read', 'use', 'invoke']));
      expect((owned.get(`report:${O.R}`) as any[]).every((entry) => entry.sources.every((source: string) => source === 'group-owner'))).toBe(true);
      // A Skill is shared-visibility: the member also reads it board-wide, which is not through the Group.
      expect(owned.get(`skill:${O.S}`)).toEqual(expect.arrayContaining([{ action: 'read', sources: ['group-owner'] }]));
    }
  });

  it('a plain member, a bearer and a stranger get the empty answer', async () => {
    for (const viewer of [P.member, P.managerConnector, P.stranger]) {
      const answer = await call(viewer, 'GET', `/groups/${G}/members/${P.manager.id}/access`);
      expect([viewer.label, answer.status, answer.json.access.member, answer.json.access.grants, answer.json.access.owned])
        .toEqual([viewer.label, 200, null, [], []]);
    }
  });

  it('a non-member has nothing through the Group', async () => {
    const answer = await call(ADMIN, 'GET', `/groups/${G}/members/${P.stranger.id}/access`);
    expect([answer.json.access.member, answer.json.access.owned]).toEqual([null, []]);
  });

  it('a live steward of a disabled Group gets the empty answer, and none of the objects that Group owns', async () => {
    // Review r1 LEAK B, its exact shape: a live manager of the DISABLED Group
    // G3, which owns a Project and a Task the manager cannot read.
    const steward = await account('g3Steward');
    await join(G3, steward.id);
    await appoint(G3, steward.id, 'manager');
    const t3 = await task(O.P3, { accountOwner: G3 });
    const actor = await actorOf(steward);
    expect((await authorizationRepository.authorizePoint(actor, 'project', O.P3, 'read')).allowed).toBe(false);
    expect((await authorizationRepository.authorizePoint(actor, 'task', t3, 'read')).allowed).toBe(false);
    expect((await call(steward, 'GET', `/projects/${O.P3}`)).status).toBe(404);
    expect((await call(steward, 'GET', `/groups/${G3}/stewards`)).json.stewards
      .find((row: any) => row.accountPrincipalId === steward.id)).toEqual(expect.objectContaining({ live: true }));
    const answer = await call(steward, 'GET', `/groups/${G3}/members/${P.g3Member.id}/access`);
    expect([answer.status, answer.json.access.member, answer.json.access.grants, answer.json.access.owned])
      .toEqual([200, null, [], []]);
    expect(JSON.stringify(answer.json)).not.toContain(O.P3);
    expect(JSON.stringify(answer.json)).not.toContain(t3);
    const root = (await call(ADMIN, 'GET', `/groups/${G3}/members/${P.g3Member.id}/access`)).json.access;
    expect(root.owned.map((entry: any) => [entry.type, entry.id, entry.actions]))
      .toEqual(expect.arrayContaining([['project', O.P3, []], ['task', t3, []]]));
  });

  it("an owned object is listed to a non-root viewer only where that viewer's own point read admits it", async () => {
    const rows = MATRIX_OBJECTS.map((obj) => ({ type: obj.type, id: obj.id }));
    for (const who of [P.stranger, P.manager, P.member]) {
      const viewer = { actor: MIDDLEWARE_ACTOR.get(who.id), root: false, loginSession: true };
      const kept = (await accessExplorerService.readableBy(viewer, rows)).map((row: any) => row.id);
      const want = MATRIX_OBJECTS.filter((obj) => expected(who, obj).includes('read')).map((obj) => obj.id);
      expect([who.label, kept]).toEqual([who.label, want]);
      expect(kept.length).toBeGreaterThan(0);
      expect(kept.length).toBeLessThan(rows.length);
    }
  });
});
