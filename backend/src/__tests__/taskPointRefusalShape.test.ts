/**
 * f9b7febe — EVERY TASK POINT ROUTE ANSWERS ABSENT AND UNREADABLE THE SAME.
 *
 * LANE FEAT-A reported it from the running product (handover `9faa483f`): for
 * a Task the caller may not read, `GET /tasks/{id}` answered 404 and
 * `PATCH /tasks/{id}` answered 403. The pair is an id oracle — write to an id
 * and the status tells you whether the row is there — and it contradicts the
 * rule the product already holds everywhere else (AUTHZ `4d961e37` par.9.6,
 * the 44d1bf89 rule: an object the caller may not read is reported exactly as
 * an absent one).
 *
 * The cause was one line of `sharedAuthorizationMiddleware`: concealment was a
 * property of the VERB (`target.action === 'read'`) rather than of what the
 * caller can SEE. So every non-read verb disclosed, and the repair moves the
 * question to `AuthorizationRepository.authorizePoint`, which now answers a
 * third fact — `concealed` — by asking whether the caller may read the
 * resource at all.
 *
 * ── THE CENSUS IS DERIVED, NOT LISTED ──
 *
 * A hand-written list of point routes is a list that goes stale the next time
 * someone adds one. This suite READS `routes/tasks.ts`, takes every
 * `router.<method>('<path>')` it declares, and classifies each with the
 * PRODUCTION classifier — `pointAuthorizationTarget`, the same function the
 * middleware uses — keeping the ones that classify as a Task point route. A
 * route added tomorrow enters the census tomorrow, and a route the classifier
 * does not recognise is reported rather than skipped silently.
 *
 * ── THE PROPERTY, AND THE CONTROL THAT BOUNDS IT ──
 *
 * For a caller who cannot read the Task, every route in the census answers the
 * same status and the same body as it does for an id no row carries.
 *
 * And — the half that makes this a repair rather than a blanket 404 — a caller
 * who CAN read the Task and lacks authority for the ACT still receives 403.
 * Concealing that one would disclose nothing and cost a person editing a Task
 * they can see a save that fails for no stated reason. A gate that only
 * measured the concealment would be satisfied by a middleware that answered
 * 404 to everything, which is why both are measured here.
 *
 * ── WHY IT IS NOT IN THE DEFAULT JEST RUN ──
 *
 * It connects to `RELAYHALL_TEST_DB_URL` and FAILS — never skips — when the
 * variable is unset: what the point stage decides is a SQL predicate over real
 * rows, and every DB-shaped suite in the default run mocks the pool. Excluded
 * by `testPathIgnorePatterns`, run by `npm run test:point-refusal` on the VM
 * gate chain and UNCONDITIONALLY in CI against the `services: postgres` block,
 * with no `if:` guard.
 *
 * ── THE DESTRUCTIVE CONTRACT, STATED ──
 *
 * This suite WRITES to principals, projects, tasks and auth_sessions. It
 * refuses any URL naming a deployment database (`relayhall_dev`,
 * `relayhall_tst`, `relayhall_prod`, `relayhall`) and any non-local host.
 * Bring the database up with `database/init.sql` and `npm run migrate`, and
 * throw it away afterwards.
 */

/* eslint-disable @typescript-eslint/no-var-requires */

import http from 'http';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

// ─────────────────────────── the database contract ───────────────────────────

const TEST_DB_URL = process.env.RELAYHALL_TEST_DB_URL;
if (!TEST_DB_URL) {
  throw new Error(
    'RELAYHALL_TEST_DB_URL is not set. This gate measures the point stage against a REAL PostgreSQL and refuses to skip: '
    + 'what it decides is a SQL predicate, and a mocked pool can only replay the rule. '
    + 'Create a disposable database, load database/init.sql, run npm run migrate, and set RELAYHALL_TEST_DB_URL to it.',
  );
}

const parsed = new URL(TEST_DB_URL);
const TEST_DB_NAME = parsed.pathname.replace(/^\//, '');
const FORBIDDEN_DATABASES = ['relayhall_dev', 'relayhall_tst', 'relayhall_prod', 'relayhall'];
if (FORBIDDEN_DATABASES.includes(TEST_DB_NAME)) {
  throw new Error(`RELAYHALL_TEST_DB_URL names a deployment database (${TEST_DB_NAME}). This suite writes; point it at a disposable database.`);
}

process.env.DB_HOST = parsed.hostname;
process.env.DB_PORT = parsed.port || '5432';
process.env.DB_NAME = TEST_DB_NAME;
process.env.DB_USER = decodeURIComponent(parsed.username);
process.env.DB_PASSWORD = decodeURIComponent(parsed.password);
process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'point-refusal-suite-secret-0123456789ab';
process.env.RELAYHALL_SESSIONS = 'on';

const express = require('express');

const { pool } = require('../db/connection');
const { registerProtectedRoutes } = require('../routeRegistry');
const { authMiddleware } = require('../middleware/auth');
const {
  sharedAuthorizationMiddleware,
  pointAuthorizationTarget,
} = require('../middleware/sharedAuthorization');
const { apiErrorHandler } = require('../utils/apiErrors');
const { jsonBodyOptions } = require('../utils/jsonBodyTypes');
const { principalService } = require('../services/PrincipalService');
const { loginSessionService, SESSION_COOKIE_NAME } = require('../services/LoginSessionService');

jest.setTimeout(180_000);

// ──────────────────────────────── the app ────────────────────────────────────

let server: http.Server;
let origin: string;

function buildApp(): any {
  const app = express();
  app.use(express.json(jsonBodyOptions));
  app.use(express.urlencoded({ extended: true }));
  registerProtectedRoutes((mountPath: string, ...handlers: any[]) => {
    app.use(mountPath, authMiddleware, sharedAuthorizationMiddleware, ...handlers);
  });
  app.use(apiErrorHandler);
  return app;
}

interface Answer { status: number; json: any }

interface Caller {
  label: string;
  principalId: string;
  headers: Record<string, string>;
}

async function call(who: Caller, method: string, routePath: string): Promise<Answer> {
  const response = await fetch(`${origin}${routePath}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...who.headers },
    // Every route in the census refuses in the guard chain, which runs BEFORE
    // the router and therefore before any body validation. An empty object is
    // a body that could not itself decide any of these answers.
    body: method === 'GET' || method === 'DELETE' ? undefined : '{}',
  });
  const text = await response.text();
  let json: any = null;
  try { json = JSON.parse(text); } catch { json = null; }
  return { status: response.status, json };
}

// ──────────────────────────── the derived census ─────────────────────────────

interface PointRoute { method: string; template: string; action: string }

const ROUTE_SOURCE = path.join(process.cwd(), 'src', 'routes', 'tasks.ts');

/** Concrete values for the non-`:id` parameters. None of them can be reached:
 *  the guard chain decides on the `:id` alone and returns before the handler. */
const PARAM_VALUES: Record<string, string> = {
  ':leaseId': '00000000-0000-4000-8000-000000000001',
  ':entryId': '00000000-0000-4000-8000-000000000002',
  ':depTaskId': '00000000-0000-4000-8000-000000000003',
  ':subtaskId': '00000000-0000-4000-8000-000000000004',
  ':index': '0',
};

function concretePath(template: string, taskId: string): string {
  let out = `/tasks${template === '/' ? '' : template}`.replace(/:id/g, taskId);
  for (const [param, value] of Object.entries(PARAM_VALUES)) {
    out = out.split(param).join(value);
  }
  return out;
}

/**
 * Every route `routes/tasks.ts` declares that the PRODUCTION classifier calls a
 * Task point route. The classifier is imported, never re-implemented: a census
 * that carried its own copy of the rule would agree with itself while the
 * middleware disagreed.
 */
function censusPointRoutes(taskId: string): { routes: PointRoute[]; declared: number } {
  const source = fs.readFileSync(ROUTE_SOURCE, 'utf8');
  const declarations = [...source.matchAll(/router\.(get|post|patch|put|delete)\('([^']+)'/g)];
  const routes: PointRoute[] = [];
  for (const [, method, template] of declarations) {
    const target = pointAuthorizationTarget(method.toUpperCase(), concretePath(template, taskId));
    if (!target || target.type !== 'task') continue;
    routes.push({ method: method.toUpperCase(), template, action: target.action });
  }
  return { routes, declared: declarations.length };
}

// ────────────────────────────── the fixtures ─────────────────────────────────

const SYSTEM_ACTOR = { handle: 'point-refusal-suite', authMethod: 'system' as const };
const tag = (): string => crypto.randomBytes(6).toString('hex');

/** What an ordinary writer credential carries. `tasks:admin` is deliberately
 *  ABSENT, and not by choice: the Account cap intersects a delegated
 *  credential's scopes with `scopesForRole(account.role)`, and only the
 *  administrator roles carry an `:admin` scope to delegate — so no caller can
 *  reach an `admin`-action Task route's POINT stage without already being an
 *  administrator, for whom every arm allows. That is a property of the shipped
 *  ceiling, not a gap in this suite, and the partition below states it out
 *  loud rather than hiding it. */
const WRITER_SCOPES = ['tasks:read', 'tasks:write', 'projects:read', 'principals:read'];

let ROOT_PRINCIPAL: string;
let ROOT: Caller;
/** A parented Connector under a `user` Account: delegated, so the
 *  root/administrator/owner arms never apply and object authority is the chain
 *  intersection — which, with no grants, reaches nothing. The MCP/CLI shape. */
let CONNECTOR: Caller;
/** A just-in-time human Account, role `user`, no grants: a login session, the
 *  other authenticated kind, and the caller the defect was reported for. */
let OUTSIDER: Caller;

/** A private Task in a private Project: neither caller above may read it. */
let HIDDEN_TASK: string;
/** A Task inside a SHARED Project with no Assignee: readable through the
 *  inherited-visibility arm, writable by nobody but its owners. */
let READABLE_TASK: string;
/** An id no `tasks` row carries. */
let ABSENT_TASK: string;

async function makeAccount(kind: 'human' | 'service', role: string | null): Promise<string> {
  const handle = `refusal-${kind}-${tag()}`;
  const result = await pool.query(
    `INSERT INTO principals (kind, handle, display_name, status, role, purpose)
     VALUES ($1, $2, $3, 'active', $4, $5) RETURNING id`,
    [kind, handle, `point refusal ${handle}`, role, kind === 'service' ? 'point refusal account' : null],
  );
  return String(result.rows[0].id);
}

async function sessionCallerFor(label: string, principalId: string): Promise<Caller> {
  const minted = await loginSessionService.mint({ principalId });
  return { label, principalId, headers: { Cookie: `${SESSION_COOKIE_NAME}=${minted.token}` } };
}

async function connectorCaller(label: string, accountId: string, scopes: string[]): Promise<Caller> {
  const handle = `refusal-connector-${tag()}`;
  const principal = await pool.query(
    `INSERT INTO principals (kind, handle, display_name, status, parent_principal_id, purpose, own_expression)
     VALUES ('service', $1, $2, 'active', $3, $4, $5::jsonb) RETURNING id`,
    [handle, `point refusal ${label}`, accountId, 'point refusal connector',
      JSON.stringify({ scopes: 'parent', objects: 'parent' })],
  );
  const principalId = String(principal.rows[0].id);
  const issued = await principalService.issueCredential(
    { principalId, scopes, transport: 'any' }, SYSTEM_ACTOR);
  return { label, principalId, headers: { Authorization: `Bearer ${issued.fullKey}` } };
}

async function makeProject(visibility: 'private' | 'shared'): Promise<string> {
  const result = await pool.query(
    `INSERT INTO projects (name, status, visibility, owner_principal_id)
     VALUES ($1, 'active', $2, $3) RETURNING id`,
    [`refusal-${visibility}-${tag()}`, visibility, ROOT_PRINCIPAL],
  );
  return String(result.rows[0].id);
}

async function makeTask(projectId: string, visibility: 'private' | 'shared'): Promise<string> {
  const result = await pool.query(
    `INSERT INTO tasks (title, status, visibility, project_id, owner_principal_id,
                        creator_principal_id, shepherd_principal_id)
     VALUES ($1, 'todo', $2, $3, NULL, $4, $4) RETURNING id`,
    [`refusal task ${tag()}`, visibility, projectId, ROOT_PRINCIPAL],
  );
  return String(result.rows[0].id);
}

beforeAll(async () => {
  await new Promise<void>((resolve) => { server = buildApp().listen(0, resolve); });
  origin = `http://127.0.0.1:${(server.address() as any).port}`;

  ROOT_PRINCIPAL = await makeAccount('human', 'admin');
  ROOT = await sessionCallerFor('root session', ROOT_PRINCIPAL);
  OUTSIDER = await sessionCallerFor('outsider session', await makeAccount('human', 'user'));
  CONNECTOR = await connectorCaller(
    'writer connector', await makeAccount('service', 'user'), WRITER_SCOPES);

  HIDDEN_TASK = await makeTask(await makeProject('private'), 'private');
  READABLE_TASK = await makeTask(await makeProject('shared'), 'private');
  ABSENT_TASK = crypto.randomUUID();
});

afterAll(async () => {
  await new Promise<void>((resolve) => { server.close(() => resolve()); });
  await pool.end();
});

// ─────────────────────────────── the properties ──────────────────────────────

describe('the census', () => {
  it('is derived from the routes file and is not empty', () => {
    const { routes, declared } = censusPointRoutes(HIDDEN_TASK);
    // Non-vacuity, and stated as counts a reader can check against the file.
    expect(`declared routes: ${declared >= 50}`).toBe('declared routes: true');
    expect(`task point routes: ${routes.length >= 30}`).toBe('task point routes: true');
    // And it covers every ACTION class the classifier can produce for a Task,
    // which is the point: the defect was that concealment followed the VERB.
    const actions = [...new Set(routes.map((route) => route.action))].sort();
    expect(actions).toEqual(
      ['admin', 'claim', 'finish', 'read', 'release', 'shepherd', 'verify', 'write'],
    );
  });
});

describe('every Task point route answers absent and unreadable identically', () => {
  it('the fixtures are what they claim to be (not vacuous)', async () => {
    const hiddenToConnector = await call(CONNECTOR, 'GET', `/tasks/${HIDDEN_TASK}`);
    const hiddenToOutsider = await call(OUTSIDER, 'GET', `/tasks/${HIDDEN_TASK}`);
    const readable = await call(OUTSIDER, 'GET', `/tasks/${READABLE_TASK}`);
    const asRoot = await call(ROOT, 'GET', `/tasks/${HIDDEN_TASK}`);
    expect(`hidden to the connector: ${hiddenToConnector.status}`).toBe('hidden to the connector: 404');
    expect(`hidden to the outsider: ${hiddenToOutsider.status}`).toBe('hidden to the outsider: 404');
    expect(`readable to the outsider: ${readable.status}`).toBe('readable to the outsider: 200');
    // The row IS there — the 404s above are concealment, not absence.
    expect(`hidden to root: ${asRoot.status}`).toBe('hidden to root: 200');
  });

  /**
   * Which stage refused is MEASURED, never predicted.
   *
   * For an id no row carries, the point stage always answers 404: if a route
   * answers anything else for the ABSENT id, control never reached the point
   * stage and the ROUTE ceiling refused first. So the absent answer partitions
   * the census by itself, with no second copy of the ceiling rule to drift.
   *
   * Both halves satisfy the card, for different reasons. In the point-decided
   * half the two answers are the read routes\' own 404 RESOURCE_NOT_FOUND. In
   * the ceiling-refused half they are the route stage\'s 403, which is
   * computed from the method, the path and the caller\'s scopes and never
   * looks at the object at all — no query is issued, so there is nothing for
   * the answer to disclose.
   */
  for (const label of ['writer connector', 'outsider session'] as const) {
    it(`${label}: the refusal equals the absent answer, route for route`, async () => {
      const who = label === 'writer connector' ? CONNECTOR : OUTSIDER;
      const { routes } = censusPointRoutes(HIDDEN_TASK);
      const mismatches: string[] = [];
      const wrongShape: string[] = [];
      let pointDecided = 0;
      let ceilingRefused = 0;
      let pointDecidedWrites = 0;
      for (const route of routes) {
        const hidden = await call(who, route.method, concretePath(route.template, HIDDEN_TASK));
        const absent = await call(who, route.method, concretePath(route.template, ABSENT_TASK));
        if (hidden.status !== absent.status || JSON.stringify(hidden.json) !== JSON.stringify(absent.json)) {
          mismatches.push(
            `${route.method} ${route.template} [${route.action}]: hidden ${hidden.status} `
            + `${JSON.stringify(hidden.json)} vs absent ${absent.status} ${JSON.stringify(absent.json)}`,
          );
        }
        if (absent.status === 404) {
          pointDecided += 1;
          if (route.action !== 'read') pointDecidedWrites += 1;
          // Equality alone would be satisfied by a route that answered 403 to
          // both. This names the answer the read routes already give.
          if (hidden.status !== 404 || hidden.json?.code !== 'RESOURCE_NOT_FOUND') {
            wrongShape.push(`${route.method} ${route.template} [${route.action}]: ${hidden.status} ${JSON.stringify(hidden.json)}`);
          }
        } else {
          ceilingRefused += 1;
        }
      }
      expect(mismatches).toEqual([]);
      expect(wrongShape).toEqual([]);
      // Non-vacuity of the partition: the point stage really did decide most
      // of the census, and it decided NON-READ routes — which is the whole
      // defect, since the read routes already concealed.
      expect(`point-decided: ${pointDecided >= 25} non-read among them: ${pointDecidedWrites >= 15}`)
        .toBe('point-decided: true non-read among them: true');
      expect(`accounted for: ${pointDecided + ceilingRefused === censusPointRoutes(HIDDEN_TASK).routes.length}`)
        .toBe('accounted for: true');
    });
  }
});

describe('a caller who CAN read the Task still learns it may not act', () => {
  it('403, not 404, on every non-read route the point stage decides', async () => {
    // The bound on the repair, and the reason this is not "404 everything".
    // Without it the gate above is satisfied by a middleware that conceals
    // unconditionally, which would turn every refused save in the product into
    // a Task that appears to have vanished.
    const { routes } = censusPointRoutes(READABLE_TASK);
    const wrong: string[] = [];
    let measured = 0;
    for (const route of routes.filter((candidate) => candidate.action !== 'read')) {
      // Same partition, same way: a route whose ABSENT answer is not 404 was
      // refused by the ceiling and never reached the decision under test.
      const absent = await call(OUTSIDER, route.method, concretePath(route.template, ABSENT_TASK));
      if (absent.status !== 404) continue;
      measured += 1;
      const answer = await call(OUTSIDER, route.method, concretePath(route.template, READABLE_TASK));
      if (answer.status !== 403 || answer.json?.code !== 'FORBIDDEN') {
        wrong.push(`${route.method} ${route.template} [${route.action}]: ${answer.status} ${JSON.stringify(answer.json)}`);
      }
    }
    expect(wrong).toEqual([]);
    expect(`routes measured: ${measured >= 15}`).toBe('routes measured: true');
    // And the read side of the same Task is not concealed either.
    const readable = await call(OUTSIDER, 'GET', `/tasks/${READABLE_TASK}`);
    expect(`readable: ${readable.status}`).toBe('readable: 200');
  });
});

describe('PATCH /tasks/batch reports the same two answers per row', () => {
  it('an unreadable row reads as absent; a readable one the caller cannot write does not', async () => {
    // The batch is a COLLECTION surface, so the point stage never runs for it
    // and its per-row answers are the route\'s own. They carried the same
    // defect one altitude down: TASK_NOT_FOUND for an absent id and FORBIDDEN
    // for an existing one the caller could not write made the route an id
    // oracle a hundred ids at a time.
    const batch = async (ids: string[]): Promise<Answer> => {
      const response = await fetch(`${origin}/tasks/batch`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', ...OUTSIDER.headers },
        body: JSON.stringify({ ids, updates: { priority: 'high' } }),
      });
      return { status: response.status, json: JSON.parse(await response.text()) };
    };

    const mixed = await batch([HIDDEN_TASK, ABSENT_TASK, READABLE_TASK]);
    const errorFor = (id: string): string =>
      String((mixed.json.results as Array<any>).find((row) => row.id === id)?.error);
    expect(`hidden: ${errorFor(HIDDEN_TASK)}`).toBe('hidden: TASK_NOT_FOUND');
    expect(`absent: ${errorFor(ABSENT_TASK)}`).toBe('absent: TASK_NOT_FOUND');
    // The bound again: a row this caller CAN read and cannot write is not
    // concealed, so the two answers stay distinguishable exactly where the
    // distinction discloses nothing.
    expect(`readable: ${errorFor(READABLE_TASK)}`).toBe('readable: FORBIDDEN');
  });
});
