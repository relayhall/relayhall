/**
 * Card ee81ee0f — AZ-A12 build 2: the evaluator's owner arm resolves a Group
 * owner by tier, and a Group-owned Project reaches its Phases and Tasks
 * (amendment AZ-A12 clauses 6-8, RATIFIED 2026-10-10, ruling E72; the edit tier
 * composes LENSES-c's live-steward fragment, design delta C.2, ruling E98).
 *
 * Over a REAL PostgreSQL and the PRODUCTION router it measures the G.2 drills
 * this build owns:
 *
 *   (1)  drill 1, tiers: on a Group-owned Project, Phase, Task and Report a
 *        member reads and uses but never writes; a manager writes, claims,
 *        finishes and releases but gets no admin, shepherd or verify; an
 *        owner-role holder gets exactly the manager's tier; a non-member gets
 *        nothing; a viewer member (and a viewer manager) never writes; a member
 *        with no live role row gets only the member tier.
 *   (2)  drill 2, liveness: a disabled member, a terminated member, a directory
 *        membership removed, a disabled Group principal and an inert role row
 *        (holder not a member) each lose the tier on the next request; a
 *        disabled Group principal's Group grants still work (N3).
 *   (3)  drill 3, inheritance: clause 7 paths (a) and (b); an archived Project
 *        fails path (b) closed; restriction (a restricted Task, a Task under a
 *        restricted Phase, a restricted Phase itself); the negatives (a person
 *        Project owner never reaches a Task someone else owns, N1; Group
 *        ownership never activates the exact-Project-Grant arm; a delegated
 *        link gains path (b) only through its Account side).
 *   (4)  drill 4, the chain: a Connector under a manager is capped by its
 *        own(); an Agent is capped to its bound Task (T36); the mint ceiling
 *        admits rows inside the Group-owned Project and refuses rows outside.
 *   (8)  drill 8, parity: for every action in AUTHORIZATION_ACTIONS the point
 *        decision equals the list decision over the same fixture, and the
 *        in-memory fast path never allows on a Group owner value.
 *   (10) drill 10, the Charter: on a Group-owned Project a manager and an
 *        owner-role holder are refused CHARTER_APPROVAL_FORBIDDEN and an
 *        administrator is allowed (the declared v1 behaviour, R50, N2, E57).
 *
 * The Skill rows of drill 1 belong to build 4 (the skill owner column, M-c,
 * card 1942926f); this build renders no Group arm for a skill.
 *
 * DESTRUCTIVE: writes principals, groups, members, steward rows, projects,
 * phases, tasks, reports, grants and Charter rows. It refuses any deployment
 * database and any non-local host, and FAILS - never skips - without a
 * disposable one.
 */

/* eslint-disable @typescript-eslint/no-var-requires */

import http from 'http';
import crypto from 'crypto';

const TEST_DB_URL = process.env.RELAYHALL_TEST_DB_URL;
if (!TEST_DB_URL) {
  throw new Error('RELAYHALL_TEST_DB_URL is required: the Group-owner drill measures decisions over stored principals, '
    + 'members, role rows and owned objects, so it never skips. Load database/init.sql into a disposable database, '
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
  throw new Error('Group-owner drill refuses a non-disposable database target');
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
const { delegationService } = require('../services/DelegationService');
const { agentMintService } = require('../services/AgentMintService');
const { authorizationRepository } = require('../services/AuthorizationRepository');
const { authorizationService, AUTHORIZATION_ACTIONS } = require('../services/AuthorizationService');
const { insertGroupRow } = require('./support/groupRows');

jest.setTimeout(240_000);

type Caller = { label: string; id: string; headers: Record<string, string> };
type Answer = { status: number; json: any };

let server: http.Server;
let origin: string;
const captured = new Map<string, any>();
const tag = (): string => crypto.randomBytes(5).toString('hex');
const SYSTEM = { handle: 'group-owner-arm-live-fixture', authMethod: 'system' as const };
const USE = ['read', 'use', 'invoke'];
const EDIT = ['read', 'write', 'claim', 'finish', 'release', 'use', 'invoke'];
const NONE: string[] = [];

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

async function account(label: string, role: string | null = 'editor'): Promise<Caller> {
  const row = await pool.query(
    `INSERT INTO principals (kind, handle, display_name, status, role) VALUES ('human', $1, $1, 'active', $2) RETURNING id`,
    [`aza12b2-${label}-${tag()}`, role],
  );
  const id = String(row.rows[0].id);
  const session = await loginSessionService.mint({ principalId: id });
  return { label, id, headers: { Cookie: `${SESSION_COOKIE_NAME}=${session.token}` } };
}

/** The actor the production middleware builds for this caller, captured on a real request. */
async function actorOf(who: Caller): Promise<any> {
  captured.delete(who.id);
  await call(who, 'GET', '/tasks?limit=1');
  const actor = captured.get(who.id);
  expect(actor).toBeDefined();
  return actor;
}

async function connectorOf(parent: Caller, objects: unknown = 'parent'): Promise<Caller> {
  const row = await pool.query(
    `INSERT INTO principals (kind, handle, display_name, status, role, parent_principal_id, purpose, own_expression)
     VALUES ('service', $1, $1, 'active', 'user', $2, 'AZ-A12 build 2 drill connector', $3::jsonb) RETURNING id`,
    [`aza12b2-connector-${tag()}`, parent.id, JSON.stringify({ scopes: 'parent', objects })],
  );
  const id = String(row.rows[0].id);
  const credential = await principalService.issueCredential({
    principalId: id, scopes: ['tasks:read', 'tasks:write', 'projects:read', 'projects:write'], transport: 'any',
  }, SYSTEM);
  return { label: 'connector', id, headers: { Authorization: `Bearer ${credential.fullKey}` } };
}

/** The live actor of a fixture Agent, from its stored chain. */
async function agentActor(parentId: string, boundTaskId: string, objects: unknown): Promise<any> {
  const row = await pool.query(
    `INSERT INTO principals (kind, handle, display_name, status, parent_principal_id, bound_task_id, own_expression, source_tag)
     VALUES ('agent', $1, $1, 'active', $2, $3, $4::jsonb, $1) RETURNING id`,
    [`aza12b2-agent-${tag()}`, parentId, boundTaskId,
      JSON.stringify({ scopes: ['tasks:read', 'tasks:write'], objects })],
  );
  const principalId = String(row.rows[0].id);
  await principalService.issueCredential({
    principalId, scopes: ['tasks:read', 'tasks:write'], expiresAt: new Date(Date.now() + 3600_000), transport: 'any',
  }, SYSTEM);
  const chain = await delegationService.resolveChain(principalId);
  expect(chain.alive).toBe(true);
  return {
    principalId, handle: 'aza12b2-agent', role: null, scopes: ['tasks:read', 'tasks:write'], authenticated: true,
    delegation: { links: chain.links.map((link: any) => ({
      principalId: link.principalId, kind: link.kind, role: link.role, parentPrincipalId: link.parentPrincipalId,
      boundTaskId: link.boundTaskId, legacyIdentity: link.legacyIdentity, ownExpression: link.ownExpression,
    })) },
  };
}

const newGroup = (label: string): Promise<string> =>
  insertGroupRow(pool, { name: `aza12b2 ${label} ${tag()}`, description: 'AZ-A12 build 2 drill', featured: false });

async function join(groupId: string, accountId: string, source: 'local' | 'directory' = 'local'): Promise<void> {
  await pool.query('INSERT INTO group_members (group_id, account_principal_id, source) VALUES ($1, $2, $3)',
    [groupId, accountId, source]);
}
async function leave(groupId: string, accountId: string): Promise<void> {
  await pool.query('DELETE FROM group_members WHERE group_id = $1 AND account_principal_id = $2', [groupId, accountId]);
}
async function appoint(groupId: string, accountId: string, role: 'owner' | 'manager'): Promise<void> {
  await pool.query('INSERT INTO group_stewards (group_id, account_principal_id, role) VALUES ($1, $2, $3)',
    [groupId, accountId, role]);
}

async function project(owner: string | null, status = 'active'): Promise<string> {
  const row = await pool.query(
    `INSERT INTO projects (name, status, visibility, owner_principal_id) VALUES ($1, $2, 'private', $3) RETURNING id`,
    [`aza12b2 project ${tag()}`, status, owner],
  );
  return String(row.rows[0].id);
}
async function phase(projectId: string, restricted = false): Promise<string> {
  const row = await pool.query('INSERT INTO phases (project_id, name, restricted_access) VALUES ($1, $2, $3) RETURNING id',
    [projectId, `aza12b2 phase ${tag()}`, restricted]);
  return String(row.rows[0].id);
}
async function task(projectId: string | null, fields: { accountOwner?: string | null; restricted?: boolean; phaseId?: string | null } = {})
  : Promise<string> {
  const row = await pool.query(
    `INSERT INTO tasks (title, status, visibility, project_id, phase_id, restricted_access, creator_principal_id, account_owner_principal_id)
     VALUES ($1, 'todo', 'private', $2, $3, $4, $5, $6) RETURNING id`,
    [`aza12b2 task ${tag()}`, projectId, fields.phaseId ?? null, fields.restricted ?? false, FIXTURE_CREATOR.id,
      fields.accountOwner ?? null],
  );
  return String(row.rows[0].id);
}
async function report(accountOwner: string): Promise<string> {
  const row = await pool.query(
    `INSERT INTO reports (title, content, author, author_actor_id, author_principal_id, visibility, account_owner_principal_id)
     VALUES ($1, 'AZ-A12 build 2 drill report', 'aza12b2', 'aza12b2', $2, 'private', $3) RETURNING id`,
    [`aza12b2 report ${tag()}`, FIXTURE_CREATOR.id, accountOwner],
  );
  return String(row.rows[0].id);
}

/** The actions the shared predicate admits for this caller on this object, via the POINT decision. */
async function admitted(actor: any, type: string, id: string): Promise<string[]> {
  const out: string[] = [];
  for (const action of AUTHORIZATION_ACTIONS) {
    if ((await authorizationRepository.authorizePoint(actor, type, id, action)).allowed) out.push(action);
  }
  return out;
}
const sorted = (list: readonly string[]): string[] => [...list].sort();

/** PATCH a Project under its current If-Match revision, read by the same caller. */
async function patchProject(who: Caller, projectId: string): Promise<Answer> {
  const current = await call(who, 'GET', `/projects/${projectId}`);
  if (current.status !== 200) return current;
  return call(who, 'PATCH', `/projects/${projectId}`, { description: `drill ${tag()}` },
    { 'If-Match': String(current.json.project.revision) });
}

/** PATCH a Phase under its current revision, read by the same caller. */
async function patchPhase(who: Caller, phaseId: string): Promise<Answer> {
  const current = await call(who, 'GET', `/phases/${phaseId}`);
  if (current.status !== 200) return current;
  return call(who, 'PATCH', `/phases/${phaseId}`, { goal: `drill ${tag()}`, revision: String(current.json.phase.revision) });
}

let FIXTURE_CREATOR: Caller;
let ADMIN: Caller;

interface Estate {
  G: string; owner: Caller; manager: Caller; member: Caller; viewer: Caller; viewerManager: Caller; stranger: Caller;
  person: Caller; P: string; PH: string; PHR: string;
  TA: string; TB: string; TR: string; TRB: string; TPHA: string; TPHB: string; R: string;
}
let E: Estate;

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

  FIXTURE_CREATOR = await account('creator', 'editor');
  ADMIN = await account('admin', 'admin');
  const G = await newGroup('estate');
  const owner = await account('owner');
  const manager = await account('manager');
  const member = await account('member');
  const viewer = await account('viewer', 'viewer');
  const viewerManager = await account('viewer-manager', 'viewer');
  const stranger = await account('stranger');
  const person = await account('person');
  for (const who of [owner, manager, member, viewer, viewerManager]) await join(G, who.id);
  await appoint(G, owner.id, 'owner');
  await appoint(G, manager.id, 'manager');
  await appoint(G, viewerManager.id, 'manager');
  const P = await project(G);
  const PH = await phase(P);
  const PHR = await phase(P, true);
  E = {
    G, owner, manager, member, viewer, viewerManager, stranger, person, P, PH, PHR,
    TA: await task(P),                                            // path (a): no explicit account owner
    TB: await task(P, { accountOwner: person.id }),               // path (b): someone else owns it
    TR: await task(P, { restricted: true }),                      // restricted, path (a)
    TRB: await task(P, { restricted: true, accountOwner: person.id }), // restricted, path (b)
    TPHA: await task(P, { phaseId: PHR }),                        // under a restricted Phase, path (a)
    TPHB: await task(P, { phaseId: PHR, accountOwner: person.id }), // under a restricted Phase, path (b)
    R: await report(G),
  };
});

afterAll(async () => {
  if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  await pool.end();
});

describe('drill 1: the tiers on a Group-owned Project, Phase, Task and Report', () => {
  it('a member reads and uses but does not write, on every Group-owned type', async () => {
    const actor = await actorOf(E.member);
    for (const [type, id] of [['project', E.P], ['phase', E.PH], ['task', E.TA], ['report', E.R]]) {
      expect([type, sorted(await admitted(actor, type, id))]).toEqual([type, sorted(USE)]);
    }
    expect((await call(E.member, 'GET', `/projects/${E.P}`)).status).toBe(200);
    expect((await call(E.member, 'GET', `/tasks/${E.TA}`)).status).toBe(200);
    expect((await call(E.member, 'GET', `/reports/${E.R}`)).status).toBe(200);
    expect((await call(E.member, 'PATCH', `/tasks/${E.TA}`, { title: `member ${tag()}` })).status).toBe(403);
    expect((await patchProject(E.member, E.P)).status).toBe(403);
  });

  it('a manager writes, claims, finishes and releases but gets no admin, shepherd or verify', async () => {
    const actor = await actorOf(E.manager);
    for (const [type, id] of [['project', E.P], ['phase', E.PH], ['task', E.TA], ['report', E.R]]) {
      expect([type, sorted(await admitted(actor, type, id))]).toEqual([type, sorted(EDIT)]);
    }
    expect((await call(E.manager, 'PATCH', `/tasks/${E.TA}`, { title: `manager ${tag()}` })).status).toBe(200);
    expect((await patchProject(E.manager, E.P)).status).toBe(200);
  });

  it('an owner-role holder gets exactly the manager tier: admin on the object is refused', async () => {
    const owner = await actorOf(E.owner);
    const manager = await actorOf(E.manager);
    for (const [type, id] of [['project', E.P], ['phase', E.PH], ['task', E.TA], ['report', E.R]]) {
      expect(await admitted(owner, type, id)).toEqual(await admitted(manager, type, id));
      expect((await authorizationRepository.authorizePoint(owner, type, id, 'admin')).allowed).toBe(false);
    }
  });

  it('a non-member gets nothing, and the object is concealed from it', async () => {
    const actor = await actorOf(E.stranger);
    for (const [type, id] of [['project', E.P], ['phase', E.PH], ['task', E.TA], ['report', E.R]]) {
      expect([type, await admitted(actor, type, id)]).toEqual([type, NONE]);
    }
    expect((await call(E.stranger, 'GET', `/tasks/${E.TA}`)).status).toBe(404);
  });

  it('a viewer member, and a viewer holding a manager row, never write (the role ceiling decides first)', async () => {
    for (const who of [E.viewer, E.viewerManager]) {
      const actor = await actorOf(who);
      // The viewer ceiling admits `read` alone (use and invoke sit at the write ceiling).
      expect(await admitted(actor, 'task', E.TA)).toEqual(['read']);
      expect((await call(who, 'PATCH', `/tasks/${E.TA}`, { title: `viewer ${tag()}` })).status).toBe(403);
    }
  });

  it('a member with no live role row gets only the member tier', async () => {
    const G = await newGroup('no-role');
    const would = await account('would-be-manager');
    await join(G, would.id);
    const P = await project(G);
    const T = await task(P);
    expect(sorted(await admitted(await actorOf(would), 'task', T))).toEqual(sorted(USE));
  });
});

describe('drill 2: liveness, on the next request', () => {
  async function team() {
    const G = await newGroup('liveness');
    const manager = await account('live-manager');
    const member = await account('live-member');
    await join(G, manager.id);
    await join(G, member.id, 'directory');
    await appoint(G, manager.id, 'manager');
    const P = await project(G);
    const T = await task(P);
    return { G, manager, member, P, T };
  }

  it('a disabled member and a terminated member lose the tier', async () => {
    const t = await team();
    const actor = await actorOf(t.manager);
    expect(await admitted(actor, 'task', t.T)).toContain('write');
    await pool.query("UPDATE principals SET status = 'disabled' WHERE id = $1", [t.manager.id]);
    principalService.invalidatePrincipals([t.manager.id]);
    // The stored actor is reused on purpose: the tier is read from the rows, not from the actor.
    expect(await admitted(actor, 'task', t.T)).toEqual(NONE);
    await pool.query("UPDATE principals SET status = 'active' WHERE id = $1", [t.manager.id]);
    expect(await admitted(actor, 'task', t.T)).toContain('write');
    await pool.query("UPDATE principals SET status = 'terminated', terminated_at = clock_timestamp() WHERE id = $1", [t.manager.id]);
    expect(await admitted(actor, 'task', t.T)).toEqual(NONE);
  });

  it('a directory membership removed by the sync loses the member tier', async () => {
    const t = await team();
    const actor = await actorOf(t.member);
    expect(sorted(await admitted(actor, 'task', t.T))).toEqual(sorted(USE));
    await leave(t.G, t.member.id);
    expect(await admitted(actor, 'task', t.T)).toEqual(NONE);
  });

  it('a disabled Group principal suspends every tier; its Group grants still work (N3)', async () => {
    const t = await team();
    const granted = await project(FIXTURE_CREATOR.id);
    await pool.query(
      `INSERT INTO grants (grantee_type, grantee_id, resource_type, resource_id, verb, granted_by_principal_id)
       VALUES ('group', $1, 'project', $2, 'read', $3)`, [t.G, granted, FIXTURE_CREATOR.id]);
    const member = await actorOf(t.member);
    const manager = await actorOf(t.manager);
    await pool.query("UPDATE principals SET status = 'disabled' WHERE id = $1", [t.G]);
    expect(await admitted(member, 'task', t.T)).toEqual(NONE);
    expect(await admitted(manager, 'task', t.T)).toEqual(NONE);
    expect((await authorizationRepository.authorizePoint(member, 'project', granted, 'read')).allowed).toBe(true);
    await pool.query("UPDATE principals SET status = 'active' WHERE id = $1", [t.G]);
    expect(await admitted(manager, 'task', t.T)).toContain('write');
  });

  it('an inert role row (holder not a member) confers nothing; joining makes it live', async () => {
    const t = await team();
    const outsider = await account('inert-holder');
    await appoint(t.G, outsider.id, 'manager');
    const actor = await actorOf(outsider);
    expect(await admitted(actor, 'task', t.T)).toEqual(NONE);
    await join(t.G, outsider.id);
    expect(sorted(await admitted(actor, 'task', t.T))).toEqual(sorted(EDIT));
  });
});

describe('drill 3: a Group-owned Project reaches its Phases and Tasks', () => {
  it('path (a): a Task with no explicit account owner takes its Project\'s Group tiers', async () => {
    expect(sorted(await admitted(await actorOf(E.member), 'task', E.TA))).toEqual(sorted(USE));
    expect(sorted(await admitted(await actorOf(E.manager), 'task', E.TA))).toEqual(sorted(EDIT));
  });

  it('path (b): a Task someone else owns is read by members and written (task write subset only) by managers', async () => {
    expect(await admitted(await actorOf(E.member), 'task', E.TB)).toEqual(['read']);
    expect(sorted(await admitted(await actorOf(E.manager), 'task', E.TB)))
      .toEqual(sorted(['read', 'write', 'claim', 'finish', 'release']));
    expect((await call(E.manager, 'PATCH', `/tasks/${E.TB}`, { title: `path b ${tag()}` })).status).toBe(200);
    expect((await call(E.member, 'PATCH', `/tasks/${E.TB}`, { title: `path b ${tag()}` })).status).toBe(403);
  });

  it('an archived Project fails path (b) closed', async () => {
    const P = await project(E.G, 'archived');
    const T = await task(P, { accountOwner: E.person.id });
    expect(await admitted(await actorOf(E.member), 'task', T)).toEqual(NONE);
    expect(await admitted(await actorOf(E.manager), 'task', T)).toEqual(NONE);
  });

  it('restriction: a restricted Task and a Task under a restricted Phase suppress path (b) for every tier and path (a)\'s use tier', async () => {
    const member = await actorOf(E.member);
    const manager = await actorOf(E.manager);
    for (const id of [E.TRB, E.TPHB]) {
      expect(await admitted(member, 'task', id)).toEqual(NONE);
      expect(await admitted(manager, 'task', id)).toEqual(NONE);
    }
    for (const id of [E.TR, E.TPHA]) {
      expect(await admitted(member, 'task', id)).toEqual(NONE);
      expect(sorted(await admitted(manager, 'task', id))).toEqual(sorted(EDIT));
    }
  });

  it('a restricted Phase is not readable by a member and stays writable by managers and owners', async () => {
    expect(await admitted(await actorOf(E.member), 'phase', E.PHR)).toEqual(NONE);
    for (const who of [E.manager, E.owner]) {
      expect(sorted(await admitted(await actorOf(who), 'phase', E.PHR))).toEqual(sorted(EDIT));
    }
    expect((await patchPhase(E.manager, E.PHR)).status).toBe(200);
    expect((await call(E.member, 'GET', `/phases/${E.PHR}`)).status).toBe(404);
  });

  it('N1: a PERSON Project owner does not reach a Task whose explicit account owner is someone else', async () => {
    const owner = await account('person-owner');
    const P = await project(owner.id);
    const T = await task(P, { accountOwner: E.person.id });
    expect(await admitted(await actorOf(owner), 'task', T)).toEqual(NONE);
  });

  it('Group ownership never activates the exact-Project-Grant arm (0e6f09a0 stays green)', async () => {
    const sources = authorizationService.sqlCondition(await actorOf(E.member), 'read',
      authorizationRepository.sqlResource('task').resource, 1, { includeSources: true }).sources;
    const inherited = sources.filter((s: any) => s.basis === 'inherited-project-grant');
    expect(inherited.length).toBeGreaterThan(0);
    for (const source of inherited) expect(source.sql).not.toContain('owning_group');
    const { rows } = await pool.query(
      `SELECT count(*)::int AS n FROM grants WHERE resource_type = 'project' AND resource_id = $1`, [E.P]);
    expect(rows[0].n).toBe(0);
  });

  it('a delegated link gains path (b) only through its Account side', async () => {
    const memberConnector = await connectorOf(E.member);
    const strangerConnector = await connectorOf(E.stranger);
    expect((await call(memberConnector, 'GET', `/tasks/${E.TB}`)).status).toBe(200);
    expect((await call(strangerConnector, 'GET', `/tasks/${E.TB}`)).status).toBe(404);
    const chainSources = authorizationService.sqlCondition(await actorOf(memberConnector), 'read',
      authorizationRepository.sqlResource('task').resource, 1, { includeSources: true }).sources;
    const groupSources = chainSources.filter((s: any) => String(s.basis).includes('group-'));
    expect(groupSources.map((s: any) => s.basis).sort()).toEqual(['account-group-owner', 'account-group-project-owner']);
  });
});

describe('drill 4: the chain', () => {
  it('a Connector under a manager writes through own() = parent and is capped by an own() that excludes the Task', async () => {
    const open = await connectorOf(E.manager);
    expect((await call(open, 'PATCH', `/tasks/${E.TA}`, { title: `connector ${tag()}` })).status).toBe(200);
    const capped = await connectorOf(E.manager, [{ resourceType: 'task', selectorForm: 'exact', selectorIds: [E.TB], verbs: ['write'] }]);
    const actor = await actorOf(capped);
    expect((await authorizationRepository.authorizePoint(actor, 'task', E.TA, 'write')).allowed).toBe(false);
    expect((await authorizationRepository.authorizePoint(actor, 'task', E.TB, 'write')).allowed).toBe(true);
  });

  it('an Agent under a manager\'s Connector is capped to its bound Task (T36)', async () => {
    const connector = await connectorOf(E.manager);
    const rule = { resourceType: 'task', selectorForm: 'exact', selectorIds: [E.TA, E.TB], verbs: ['write'] };
    const agent = await agentActor(connector.id, E.TA, [rule]);
    expect((await authorizationRepository.authorizePoint(agent, 'task', E.TA, 'write')).allowed).toBe(true);
    expect((await authorizationRepository.authorizePoint(agent, 'task', E.TB, 'write')).allowed).toBe(false);
  });

  it('the mint ceiling admits rows inside the Group-owned Project and refuses rows outside it', async () => {
    const connector = await connectorOf(E.manager);
    await expect(agentMintService.assertObjectAuthorityCovers(connector.id,
      [{ resourceType: 'task', selectorForm: 'exact', selectorIds: [E.TA, E.TB], verbs: ['write'] }])).resolves.toBeUndefined();
    const outside = await task(await project(FIXTURE_CREATOR.id));
    await expect(agentMintService.assertObjectAuthorityCovers(connector.id,
      [{ resourceType: 'task', selectorForm: 'exact', selectorIds: [outside], verbs: ['read'] }]))
      .rejects.toMatchObject({ code: 'MINT_EXCEEDS_REQUESTER' });
    const memberConnector = await connectorOf(E.member);
    await expect(agentMintService.assertObjectAuthorityCovers(memberConnector.id,
      [{ resourceType: 'task', selectorForm: 'exact', selectorIds: [E.TA], verbs: ['read'] }])).resolves.toBeUndefined();
    await expect(agentMintService.assertObjectAuthorityCovers(memberConnector.id,
      [{ resourceType: 'task', selectorForm: 'exact', selectorIds: [E.TA], verbs: ['write'] }]))
      .rejects.toMatchObject({ code: 'MINT_EXCEEDS_REQUESTER' });
  });
});

describe('drill 8: point/list parity and the in-memory fast path', () => {
  it('for every action, the point decision equals the list decision over the same fixture', async () => {
    const objects: Array<[string, string[]]> = [
      ['project', [E.P]], ['phase', [E.PH, E.PHR]], ['report', [E.R]],
      ['task', [E.TA, E.TB, E.TR, E.TRB, E.TPHA, E.TPHB]],
    ];
    for (const who of [E.owner, E.manager, E.member, E.viewer, E.viewerManager, E.stranger]) {
      const actor = await actorOf(who);
      for (const [type, ids] of objects) {
        for (const action of AUTHORIZATION_ACTIONS) {
          const list = await authorizationRepository.authorizedIds(actor, type, ids, action);
          const scope = authorizationRepository.listScope(actor, type, action);
          const rendered = scope.render(2);
          const listed = await pool.query(
            `SELECT ${scope.id}::text AS id FROM ${scope.from} WHERE ${scope.id}::text = ANY($1::text[]) AND ${rendered.sql}`,
            [ids, ...rendered.params]);
          const scoped = new Set(listed.rows.map((row: any) => String(row.id)));
          for (const id of ids) {
            const point = (await authorizationRepository.authorizePoint(actor, type, id, action)).allowed;
            expect([who.label, type, id, action, point]).toEqual([who.label, type, id, action, list.has(id)]);
            expect([who.label, type, id, action, point]).toEqual([who.label, type, id, action, scoped.has(id)]);
          }
        }
      }
    }
  });

  it('the in-memory fast path never allows on a Group owner value; the SQL adapter does', async () => {
    const actor = await actorOf(E.manager);
    const shapes = [
      { type: 'project', id: E.P, ownerPrincipalId: E.G },
      { type: 'report', id: E.R, accountOwnerPrincipalId: E.G },
      { type: 'task', id: E.TA, accountOwnerPrincipalId: E.G, projectId: E.P, inheritedProjectId: E.P },
    ];
    for (const resource of shapes) {
      for (const action of AUTHORIZATION_ACTIONS) {
        expect([resource.type, action, authorizationService.authorizeResource(actor, action, resource, []).allowed])
          .toEqual([resource.type, action, false]);
      }
      expect((await authorizationRepository.authorizePoint(actor, resource.type, resource.id, 'write')).allowed).toBe(true);
    }
  });
});

describe('drill 10: the Charter of a Group-owned Project', () => {
  async function approve(who: Caller, projectId: string): Promise<Answer> {
    return call(who, 'POST', `/projects/${projectId}/charter/approve`, { content: `# Group charter ${tag()}` });
  }

  // LENSES-c c1-B (card b5c83682): design delta D-11 replaces this drill with
  // gate (i)'s (lensesGatesLive.test.ts, drill 5). The owner-role holder now
  // reaches the Group-owner arm, which asks for a step-up; the manager stays
  // refused, and the administrator approves unchanged.
  it('a manager is refused CHARTER_APPROVAL_FORBIDDEN; an owner-role holder without a step-up is asked for one (gate (i), D-11); an administrator is allowed', async () => {
    const P = await project(E.G);
    const manager = await approve(E.manager, P);
    expect([manager.status, manager.json?.code]).toEqual([403, 'CHARTER_APPROVAL_FORBIDDEN']);
    const owner = await approve(E.owner, P);
    expect([owner.status, owner.json?.code, owner.json?.stepUp?.action]).toEqual([403, 'STEP_UP_REQUIRED', 'charter.approve']);
    expect((await approve(ADMIN, P)).status).toBe(201);
  });
});
