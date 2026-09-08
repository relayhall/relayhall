/**
 * 45e7110a — WHAT A MINT MAY TARGET IS WHAT ITS CALLER MAY READ, AND A REFUSAL
 * NEVER SAYS WHICH KIND OF REFUSAL IT IS.
 *
 * The card recorded a pre-mint EXISTENCE ORACLE: `compileBriefForMint` resolved
 * the target Task before any authorization, so "no such Task" and "a Task you
 * may not mint against" answered differently for any id. Building the control
 * for it found the larger defect underneath, on the session dispatch:
 *
 *   a signed-in human Account with role `user`, for which `GET /tasks/:id`
 *   answered 404, minted an Agent bound to that Task and received the Task's
 *   COMPILED BRIEF — title, Project, and the whole operating contract — in the
 *   201 response, along with a live credential bound to it.
 *
 * `sessionMint` enforced §5.2 rule 1 ("base = the Account's OWN effective
 * authority") for the requested SCOPES and for the requested object RULES, and
 * for nothing at all about the TARGET. The step-up token is no obstacle:
 * `/auth/step-up` mints one for any target id on password re-entry alone, and
 * is deliberately an act check rather than an authority check.
 *
 * ── THE PROPERTY, AND ITS OUTSIDE ANCHOR ──
 *
 * Over the matrix this suite builds — three human callers (an owner, an
 * outsider and an administrator who owns nothing) against a private Task, a
 * shared Task and an id that names no row — the session mint succeeds if and
 * only if `GET /tasks/:id` answers 200 for that caller. It is a MATRIX, not a
 * universal quantifier: Access Profiles, explicit grants and group membership
 * are authority arms this suite does not build fixtures for, and the claim is
 * bounded accordingly (round-1 review C2). The expected set is
 * never computed from the authorization rules — it is READ BACK from the point
 * route, the surface whose refusal the bypass contradicted. A test that
 * re-derived the predicate could be edited into agreement with a broken one;
 * this one cannot, because both sides are measured.
 *
 * Two further properties, because closing a bypass can open a leak:
 *
 *   INDISTINGUISHABILITY — a Task the caller may not read and an id that names
 *   no Task answer with the same status, code and message. Byte-for-byte: the
 *   original defect was two refusals that merely LOOKED alike drifting apart.
 *
 *   NON-VACUITY — an authorized caller still mints, and still receives a Brief
 *   carrying its Task's title. Refusing everyone satisfies every assertion
 *   above, and is the repair this suite must reject as firmly as the bypass.
 *
 *   THE DURABLE ACT RE-DECIDES — round-1 review finding P2. The route
 *   authorizes the target, then the Task is read and its Brief compiled, and
 *   only then does the mint transaction open. An authority change landing in
 *   that window was minted straight through. The last section of this file
 *   stages exactly that sequence and proves the transaction refuses it. The
 *   actor it hands the service is not hand-built: it is CAPTURED from the
 *   production middleware chain on a real request, so the test cannot pass by
 *   describing an actor the product would never construct.
 *
 * ── WHY IT IS NOT IN THE DEFAULT JEST RUN ──
 *
 * It connects to `RELAYHALL_TEST_DB_URL` and FAILS — never skips — when the
 * variable is unset. The predicate under test is SQL and the disclosure is a
 * row; every DB-shaped suite in the default run mocks the pool, and a mocked
 * pool can only replay the rule this gate exists to measure. Excluded by
 * `testPathIgnorePatterns`, run by `npm run test:mint-target` on the VM gate
 * chain and UNCONDITIONALLY in CI against the `services: postgres` block.
 *
 * ── THE DESTRUCTIVE CONTRACT, STATED ──
 *
 * This suite WRITES to principals, projects, tasks, step_up_tokens, approvals
 * and principal_credentials. It refuses any URL naming a deployment database
 * (`relayhall_dev`, `relayhall_tst`, `relayhall_prod`, `relayhall`). Bring the
 * database up with `database/init.sql` and `npm run migrate`, and throw it away
 * afterwards.
 */

/* eslint-disable @typescript-eslint/no-var-requires */

import http from 'http';
import crypto from 'crypto';

// ─────────────────────────── the database contract ───────────────────────────

const TEST_DB_URL = process.env.RELAYHALL_TEST_DB_URL;
if (!TEST_DB_URL) {
  throw new Error(
    'RELAYHALL_TEST_DB_URL is not set. This gate measures who may mint against which Task, and what a '
    + 'refusal discloses, against a REAL PostgreSQL. It refuses to skip: the predicate under test is SQL '
    + 'and the disclosure is a row. Create a disposable database, load database/init.sql, run '
    + 'npm run migrate, and set RELAYHALL_TEST_DB_URL to it.',
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
process.env.JWT_SECRET = process.env.JWT_SECRET || 'mint-target-suite-secret-0123456789abcdef';
process.env.RELAYHALL_SESSIONS = 'on';

const express = require('express');

const { pool } = require('../db/connection');
const { registerProtectedRoutes } = require('../routeRegistry');
const { authMiddleware } = require('../middleware/auth');
const { sharedAuthorizationMiddleware } = require('../middleware/sharedAuthorization');
const { apiErrorHandler } = require('../utils/apiErrors');
const { jsonBodyOptions } = require('../utils/jsonBodyTypes');
const { principalService } = require('../services/PrincipalService');
const { loginSessionService, SESSION_COOKIE_NAME } = require('../services/LoginSessionService');
const { stepUpService } = require('../services/StepUpService');
const { approvalService } = require('../services/ApprovalService');

jest.setTimeout(180_000);

// ──────────────────────────────── the app ────────────────────────────────────

let server: http.Server;
let origin: string;

/**
 * The authorization actor the PRODUCTION chain built, per principal.
 *
 * The race section below hands an actor to `approvalService.sessionMint`
 * directly, because the window it is about opens between the route and the
 * service. An actor written out by hand there would be an oracle rebuilt
 * inside the test — it would pass against a product that constructs actors
 * differently. So this records what `sharedAuthorizationMiddleware` actually
 * produced on an ordinary request, and the race test uses that.
 */
const CAPTURED_ACTORS = new Map<string, any>();

function buildApp(): any {
  const app = express();
  app.use(express.json(jsonBodyOptions));
  app.use(express.urlencoded({ extended: true }));
  registerProtectedRoutes((mountPath: string, ...handlers: any[]) => {
    app.use(mountPath, authMiddleware, sharedAuthorizationMiddleware, (req: any, _res: any, next: any) => {
      // Observation only: it records what the guard chain resolved and calls
      // next(). It never decides anything, so the app under test is still the
      // app `server.ts` mounts.
      if (req.principal?.id && req.authorizationActor) {
        CAPTURED_ACTORS.set(String(req.principal.id), req.authorizationActor);
      }
      next();
    }, ...handlers);
  });
  app.use(apiErrorHandler);
  return app;
}

interface Answer { status: number; json: any; raw: string }

interface Caller {
  label: string;
  principalId: string;
  headers: Record<string, string>;
}

async function call(who: Caller, method: string, routePath: string, body?: unknown): Promise<Answer> {
  const response = await fetch(`${origin}${routePath}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...who.headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const raw = await response.text();
  let json: any = null;
  try { json = JSON.parse(raw); } catch { json = null; }
  return { status: response.status, json, raw };
}

// ────────────────────────────── the fixtures ─────────────────────────────────

const SYSTEM_ACTOR = { handle: 'mint-target-suite', authMethod: 'system' as const };
const tag = (): string => crypto.randomBytes(6).toString('hex');
const SCOPES = ['tasks:read', 'tasks:write', 'reports:read', 'projects:read'];

let OWNER: Caller;
let OUTSIDER: Caller;
/** Owns nothing. Present so the matrix is not two callers of one role. */
let ADMINISTRATOR: Caller;
let CONNECTOR: Caller;

/** Readable by OWNER (it owns the Project and the Task) and by nobody else. */
let PRIVATE_TASK: string;
let PRIVATE_TITLE: string;
/** A Task both human callers may read, so the ceiling is not simply "nothing". */
let SHARED_TASK: string;
let SHARED_TITLE: string;
/** Names no row, in canonical form. */
const ABSENT_TASK = crypto.randomUUID();

async function makeAccount(role: string): Promise<string> {
  const result = await pool.query(
    `INSERT INTO principals (kind, handle, display_name, status, role)
     VALUES ('human', $1, $2, 'active', $3) RETURNING id`,
    [`mint-human-${tag()}`, 'mint target suite account', role],
  );
  return String(result.rows[0].id);
}

/** A login session, exactly as the SSO return path mints one. */
async function sessionCallerFor(label: string, principalId: string): Promise<Caller> {
  const minted = await loginSessionService.mint({ principalId });
  return { label, principalId, headers: { Cookie: `${SESSION_COOKIE_NAME}=${minted.token}` } };
}

async function makeProject(name: string, visibility: 'private' | 'shared', owner: string): Promise<string> {
  const result = await pool.query(
    `INSERT INTO projects (name, status, visibility, owner_principal_id)
     VALUES ($1, 'active', $2, $3) RETURNING id`,
    [name, visibility, owner],
  );
  return String(result.rows[0].id);
}

async function makeTask(title: string, projectId: string, owner: string, visibility: 'private' | 'shared'): Promise<string> {
  const result = await pool.query(
    `INSERT INTO tasks (title, status, visibility, project_id, owner_principal_id,
                        creator_principal_id, shepherd_principal_id)
     VALUES ($1, 'todo', $2, $3, $4, $4, $4) RETURNING id`,
    [title, visibility, projectId, owner],
  );
  return String(result.rows[0].id);
}

/**
 * A step-up token for an arbitrary target, minted through the service.
 *
 * The `/auth/step-up` ROUTE re-enters a password these fixture Accounts do not
 * have — and that route performs NO authority check on `targetId`, which is
 * exactly the property that makes the target authorization matter. Minting
 * through the service is therefore the faithful stand-in for a real caller
 * that has just re-entered its own password, not a shortcut past a guard.
 */
async function stepUpFor(principalId: string, targetTaskId: string): Promise<string> {
  const minted = await stepUpService.mint(principalId, 'agent.mint', targetTaskId, 'password');
  return minted.token;
}

function sessionMintBody(targetTaskId: string, stepUpToken: string): Record<string, unknown> {
  return { targetTaskId, stepUpToken, requestedScopes: ['tasks:read'] };
}

beforeAll(async () => {
  const ownerId = await makeAccount('user');
  const outsiderId = await makeAccount('user');
  const administratorId = await makeAccount('admin');
  OWNER = await sessionCallerFor('owner', ownerId);
  OUTSIDER = await sessionCallerFor('outsider', outsiderId);
  ADMINISTRATOR = await sessionCallerFor('administrator', administratorId);

  const ownerProject = await makeProject(`mint private ${tag()}`, 'private', ownerId);
  PRIVATE_TITLE = `MINT PRIVATE TITLE ${tag()}`;
  PRIVATE_TASK = await makeTask(PRIVATE_TITLE, ownerProject, ownerId, 'private');

  const sharedProject = await makeProject(`mint shared ${tag()}`, 'shared', ownerId);
  SHARED_TITLE = `MINT SHARED TITLE ${tag()}`;
  SHARED_TASK = await makeTask(SHARED_TITLE, sharedProject, ownerId, 'shared');

  // A Connector in the shape the delegation contract admits, for the bearer
  // dispatch: parented under a service Account, roleless, explicit expression.
  const accountResult = await pool.query(
    `INSERT INTO principals (kind, handle, display_name, status, role, purpose)
     VALUES ('service', $1, 'mint target suite account', 'active', 'user', 'mint target suite') RETURNING id`,
    [`mint-account-${tag()}`],
  );
  const accountId = String(accountResult.rows[0].id);
  const connectorResult = await pool.query(
    `INSERT INTO principals (kind, handle, display_name, status, parent_principal_id, purpose, own_expression)
     VALUES ('service', $1, 'mint target suite connector', 'active', $2, $3, $4::jsonb) RETURNING id`,
    [`mint-connector-${tag()}`, accountId, 'mint target suite connector',
      JSON.stringify({ scopes: 'parent', objects: 'parent' })],
  );
  const connectorId = String(connectorResult.rows[0].id);
  const issued = await principalService.issueCredential(
    { principalId: connectorId, scopes: SCOPES, transport: 'any' }, SYSTEM_ACTOR);
  CONNECTOR = {
    label: 'connector', principalId: connectorId,
    headers: { Authorization: `Bearer ${issued.fullKey}` },
  };

  const app = buildApp();
  await new Promise<void>((resolve) => {
    server = app.listen(0, '127.0.0.1', () => resolve());
  });
  origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});

afterAll(async () => {
  if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  await pool.end();
});

// ───────────────────────── the ceiling, read back ────────────────────────────

describe('the session mint targets exactly what the point route grants', () => {
  /** Every (caller, task) pair, decided by the POINT ROUTE rather than by us. */
  const pairs = (): Array<{ caller: () => Caller; task: () => string; label: string }> => ([
    { caller: () => OWNER, task: () => PRIVATE_TASK, label: 'owner → its own private Task' },
    { caller: () => OWNER, task: () => SHARED_TASK, label: 'owner → a shared Task' },
    { caller: () => OUTSIDER, task: () => PRIVATE_TASK, label: 'outsider → a private Task it does not hold' },
    { caller: () => OUTSIDER, task: () => SHARED_TASK, label: 'outsider → a shared Task' },
    { caller: () => ADMINISTRATOR, task: () => PRIVATE_TASK, label: 'administrator → a Task it does not own' },
    { caller: () => ADMINISTRATOR, task: () => SHARED_TASK, label: 'administrator → a shared Task' },
  ]);

  it.each(pairs())('$label: the mint succeeds exactly when GET /tasks/:id answers 200', async ({ caller, task }) => {
    const who = caller();
    const taskId = task();

    // The expected side, measured on the surface the bypass contradicted.
    const point = await call(who, 'GET', `/tasks/${taskId}`);
    const mayRead = point.status === 200;

    const token = await stepUpFor(who.principalId, taskId);
    const mint = await call(who, 'POST', '/delegation/agent-mints', sessionMintBody(taskId, token));

    if (mayRead) {
      expect(mint.status).toBe(201);
    } else {
      expect(mint.status).toBe(404);
      expect(mint.json?.code).toBe('TASK_NOT_FOUND');
    }
  });

  it('covers both outcomes — a ceiling that refused everything would not', async () => {
    // The guard against a vacuous parameterisation: if every pair landed on the
    // same side, the assertion above would hold for a mint that always refuses
    // AND for one that never does.
    const ownerPoint = await call(OWNER, 'GET', `/tasks/${PRIVATE_TASK}`);
    const outsiderPoint = await call(OUTSIDER, 'GET', `/tasks/${PRIVATE_TASK}`);
    expect(ownerPoint.status).toBe(200);
    expect(outsiderPoint.status).toBe(404);
  });
});

// ─────────────────────────── the refusal discloses nothing ───────────────────

describe('a refusal never says which kind of refusal it is', () => {
  it('answers an unreadable Task and an absent id identically', async () => {
    const unreadableToken = await stepUpFor(OUTSIDER.principalId, PRIVATE_TASK);
    const absentToken = await stepUpFor(OUTSIDER.principalId, ABSENT_TASK);

    const unreadable = await call(OUTSIDER, 'POST', '/delegation/agent-mints',
      sessionMintBody(PRIVATE_TASK, unreadableToken));
    const absent = await call(OUTSIDER, 'POST', '/delegation/agent-mints',
      sessionMintBody(ABSENT_TASK, absentToken));

    expect(unreadable.status).toBe(absent.status);
    // Byte for byte: the defect was two refusals that looked alike drifting.
    expect(unreadable.raw).toBe(absent.raw);
    expect(unreadable.status).toBe(404);
  });

  it('answers an administrator an absent id the same way, with no state distinction', async () => {
    // An administrator resolves as allowed BEFORE existence is queried, so
    // absence is discovered later, by the Brief compile. Both paths must still
    // produce the one refusal object — otherwise closing the oracle for
    // ordinary callers would have left it open for privileged ones.
    const token = await stepUpFor(ADMINISTRATOR.principalId, ABSENT_TASK);
    const absent = await call(ADMINISTRATOR, 'POST', '/delegation/agent-mints',
      sessionMintBody(ABSENT_TASK, token));
    expect(absent.status).toBe(404);
    expect(absent.json?.code).toBe('TASK_NOT_FOUND');

    const outsiderToken = await stepUpFor(OUTSIDER.principalId, ABSENT_TASK);
    const outsiderAbsent = await call(OUTSIDER, 'POST', '/delegation/agent-mints',
      sessionMintBody(ABSENT_TASK, outsiderToken));
    expect(absent.raw).toBe(outsiderAbsent.raw);
  });

  it('never ships the Brief, the title or a credential to a caller the point route refuses', async () => {
    const token = await stepUpFor(OUTSIDER.principalId, PRIVATE_TASK);
    const refused = await call(OUTSIDER, 'POST', '/delegation/agent-mints',
      sessionMintBody(PRIVATE_TASK, token));

    expect(refused.status).toBe(404);
    expect(refused.raw).not.toContain(PRIVATE_TITLE);
    expect(refused.raw).not.toContain('onboarding');
    expect(refused.json?.pack).toBeUndefined();
  });

  it('creates no Agent bound to a Task the caller may not read', async () => {
    const bound = await pool.query(
      `SELECT p.id FROM principals p
        WHERE p.kind = 'agent' AND p.bound_task_id = $1 AND p.parent_principal_id = $2`,
      [PRIVATE_TASK, OUTSIDER.principalId],
    );
    expect(bound.rows).toEqual([]);
  });
});

// ───────────────────────────── non-vacuity ───────────────────────────────────

describe('the authorized mint still works', () => {
  it('mints for the holder and carries its Task title in the Brief', async () => {
    const token = await stepUpFor(OWNER.principalId, PRIVATE_TASK);
    const minted = await call(OWNER, 'POST', '/delegation/agent-mints',
      sessionMintBody(PRIVATE_TASK, token));

    // Refusing everyone satisfies every assertion above; this is what rejects it.
    expect(minted.status).toBe(201);
    expect(minted.json?.pack?.onboarding?.brief).toContain(PRIVATE_TITLE);
    expect(String(minted.json?.pack?.onboarding?.brief ?? '').length).toBeGreaterThan(100);
  });
});

// ─────────────────── the bearer dispatch: the card's own entry ───────────────

describe('the bearer dispatch does not distinguish absence from non-containment', () => {
  const warrantMintBody = (targetTaskId: string): Record<string, unknown> => ({
    targetTaskId, via: 'warrant', requestedScopes: ['tasks:read'],
  });

  it('answers an existing uncontained Task and an absent id identically', async () => {
    const existing = await call(CONNECTOR, 'POST', '/delegation/agent-mints',
      warrantMintBody(PRIVATE_TASK));
    const absent = await call(CONNECTOR, 'POST', '/delegation/agent-mints',
      warrantMintBody(ABSENT_TASK));

    // Before the repair the first answered 409 NO_CONTAINING_WARRANT and the
    // second 404 TASK_NOT_FOUND, which told any Connector whether an arbitrary
    // id named a Task. A Task that does not exist is contained in no warrant,
    // so both are the same authority outcome and now carry the same answer.
    expect(existing.status).toBe(409);
    expect(absent.status).toBe(409);
    expect(existing.raw).toBe(absent.raw);
  });

  it('discloses no Brief on either refusal', async () => {
    const existing = await call(CONNECTOR, 'POST', '/delegation/agent-mints',
      warrantMintBody(PRIVATE_TASK));
    expect(existing.raw).not.toContain(PRIVATE_TITLE);
    expect(existing.raw).not.toContain('onboarding');
  });
});

// ──────────────── P2: the durable act re-decides the target ──────────────────

describe('the mint transaction re-decides the target it was handed', () => {
  /**
   * Stage the window the finding is about, deterministically.
   *
   * The route authorizes, then the Task is read and its Brief compiled, and
   * only then does the mint transaction open. Rather than race a real request
   * against a clock — which would make this gate flaky and prove nothing on a
   * fast machine — the two halves are performed in order with the authority
   * change placed BETWEEN them, which is the sequence the race produces.
   */
  /**
   * Withdraw, or restore, this caller's read of SHARED_TASK.
   *
   * BOTH arms have to move. The Task carries its own 'shared' visibility AND
   * sits in a shared Project, so dropping one still leaves the other granting
   * the read - which is what the first two attempts at this fixture measured,
   * and why the revocation is asserted below rather than assumed.
   * 'restricted_access' is the arm that suppresses inherited visibility, and
   * migration 117 puts a ledger trigger on it: a change with no attributed
   * actor and reason RAISEs. The suite supplies both through the same session
   * settings production uses, rather than reaching around the trigger - a
   * fixture that disabled the ledger would stage a state the product cannot
   * reach.
   */
  async function setReadable(taskId: string, readable: boolean): Promise<void> {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query("SELECT set_config('relayhall.task_access_actor', $1, true)", [OWNER.principalId]);
      await client.query("SELECT set_config('relayhall.task_access_reason', $1, true)",
        ['mint-target suite: staging the authority window (review P2)']);
      await client.query(
        'UPDATE tasks SET visibility = $2, restricted_access = $3 WHERE id = $1',
        [taskId, readable ? 'shared' : 'private', !readable],
      );
      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
  }

  let actor: any;

  beforeAll(async () => {
    // An ordinary request, so the guard chain builds the actor the product
    // would build. Nothing about it is written by this test.
    await call(OUTSIDER, 'GET', `/tasks/${SHARED_TASK}`);
    actor = CAPTURED_ACTORS.get(OUTSIDER.principalId);
  });

  afterEach(async () => {
    await setReadable(SHARED_TASK, true);
  });

  it('captured a real actor from the production chain', () => {
    // If this is undefined every assertion below would be measuring nothing.
    expect(actor).toBeDefined();
    expect(String(actor.principalId)).toBe(String(OUTSIDER.principalId));
    expect(actor.authenticated).toBe(true);
  });

  it('refuses, and creates nothing, when the authority is withdrawn after the route decided', async () => {
    // 1 — the route's decision would pass right now.
    const before = await call(OUTSIDER, 'GET', `/tasks/${SHARED_TASK}`);
    expect(before.status).toBe(200);

    // 2 — the authority goes away in the window.
    await setReadable(SHARED_TASK, false);
    const after = await call(OUTSIDER, 'GET', `/tasks/${SHARED_TASK}`);
    expect(after.status).toBe(404);

    // 3 — the durable act runs with the decision the route already made.
    const stepUp = await stepUpService.mint(OUTSIDER.principalId, 'agent.mint', SHARED_TASK, 'password');
    const consumed = await stepUpService.consume(pool, {
      token: stepUp.token, principalId: OUTSIDER.principalId,
      action: 'agent.mint', targetId: SHARED_TASK,
    });

    const approvalsBefore = await pool.query(
      `SELECT count(*)::int AS n FROM approvals
        WHERE target_task_id = $1 AND requester_principal_id = $2`,
      [SHARED_TASK, OUTSIDER.principalId],
    );
    const agentsBefore = await pool.query(
      `SELECT count(*)::int AS n FROM principals WHERE kind = 'agent' AND bound_task_id = $1`,
      [SHARED_TASK],
    );

    await expect(approvalService.sessionMint({
      accountPrincipalId: OUTSIDER.principalId,
      sessionScopes: actor.scopes ?? [],
      targetTaskId: SHARED_TASK,
      requestedScopes: ['tasks:read'],
      label: null,
      stepUp: consumed,
      authorizationActor: actor,
    }, { handle: 'mint-target-suite', authMethod: 'system' })).rejects.toMatchObject({
      status: 404,
      code: 'TASK_NOT_FOUND',
    });

    // 4 — nothing durable exists: no Agent, no credential, no Approval row.
    const agentsAfter = await pool.query(
      `SELECT count(*)::int AS n FROM principals WHERE kind = 'agent' AND bound_task_id = $1`,
      [SHARED_TASK],
    );
    expect(agentsAfter.rows[0].n).toBe(agentsBefore.rows[0].n);

    const approvalsAfter = await pool.query(
      `SELECT count(*)::int AS n FROM approvals
        WHERE target_task_id = $1 AND requester_principal_id = $2`,
      [SHARED_TASK, OUTSIDER.principalId],
    );
    // A DELTA, not a zero: this caller legitimately minted against this Task
    // earlier in the run, so the number that matters is that the refused mint
    // added nothing.
    expect(approvalsAfter.rows[0].n).toBe(approvalsBefore.rows[0].n);
  });

  it('still mints when the authority is intact — the re-check is not simply refusing', async () => {
    // The vacuity half. A transaction that threw unconditionally would satisfy
    // the assertion above and destroy the feature.
    const stepUp = await stepUpService.mint(OUTSIDER.principalId, 'agent.mint', SHARED_TASK, 'password');
    const consumed = await stepUpService.consume(pool, {
      token: stepUp.token, principalId: OUTSIDER.principalId,
      action: 'agent.mint', targetId: SHARED_TASK,
    });

    const minted = await approvalService.sessionMint({
      accountPrincipalId: OUTSIDER.principalId,
      sessionScopes: actor.scopes ?? [],
      targetTaskId: SHARED_TASK,
      requestedScopes: ['tasks:read'],
      label: null,
      stepUp: consumed,
      authorizationActor: actor,
    }, { handle: 'mint-target-suite', authMethod: 'system' });

    expect(minted.pack?.boundTaskId).toBe(SHARED_TASK);
    expect(minted.approval?.id).toBeTruthy();
  });
});
