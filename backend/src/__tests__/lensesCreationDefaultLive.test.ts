/**
 * RH-LENSES-b (card 4287af8a) — FEATURED, THE HOME GROUP AND THE CREATION
 * DEFAULT, MEASURED LIVE.
 *
 * Design 96f0bd3d §7.1/§7.2/§7.3 with ANNEX d6637a92 §A7.4 and §A8.2. This file
 * is control **R-11-v1** and the schema/data halves of **R-7**, plus acceptance
 * rows **A-L19**, **A-L20**, **A-L21**, **A-L22**, **A-L23**, **A-L38** and
 * **A-L50**.
 *
 * ── WHY IT CANNOT BE A UNIT SUITE ──────────────────────────────────────────
 *
 * Every claim R-11-v1 makes is about SERVER STATE re-read inside a
 * transaction: that `SELECT ... FOR SHARE` on the Group row actually BLOCKS a
 * concurrent `PATCH /groups/{id}`, that a clause flipped while the act waits on
 * that lock is the value the act decides on, and that a failed second grant
 * insert takes the project row with it. A mocked pool has no locks, no
 * transactions and no constraints; it can only replay whatever the test told it
 * to. So this drives the PRODUCTION router against a REAL PostgreSQL, and the
 * clause flips are real BARRIER SCHEDULES on a second connection — never a
 * repetition count, and never a fixture that pre-commits the state it claims to
 * have raced.
 *
 * ── THE FOUR CLAUSE FLIPS, AS SCHEDULES ────────────────────────────────────
 *
 * Each is the same shape, and it is the shape that makes the flip HAPPEN
 * between resolution and write rather than before it:
 *
 *   1. a writer locks the specific clause row (Group, principal, pointer or membership);
 *   2. in that same transaction it flips ONE clause — `featured`, the
 *      membership row, the Account's status, or the home pointer;
 *   3. `POST /projects` is fired and BLOCKS on its own `FOR SHARE` of that row
 *      (asserted: the request is still outstanding while the writer holds it —
 *      an act that never waited took no lock, and the drill says so);
 *   4. the writer commits, the act proceeds, and it must decide on the value
 *      the writer committed, not on the one it could have read before.
 *
 * Each schedule flips exactly ONE clause, because R-11-v1's whole claim is that
 * each clause refuses INDEPENDENTLY; a schedule flipping two would prove only
 * that some clause refused.
 *
 * ── WHERE THE ASSERTIONS LIVE ──────────────────────────────────────────────
 *
 * In `acceptance/lensesDrillOracles.ts`, shared with
 * `lensesCreationDefaultMutations.test.ts`, which proves at build time that
 * each of them goes RED for its own defect and green for every other — build
 * obligation B-L10b. They are not written twice; a second copy would make the
 * mutation proof a proof about the copy.
 *
 * ── WHY IT IS NOT IN THE DEFAULT JEST RUN ──────────────────────────────────
 *
 * It connects to `RELAYHALL_TEST_DB_URL` and FAILS — never skips — when the
 * variable is unset. Excluded by `testPathIgnorePatterns`, run by
 * `npm run test:lenses-home-group` on the VM gate chain and UNCONDITIONALLY in
 * CI against the `services: postgres` block, with no `if:` guard.
 *
 * ── THE DESTRUCTIVE CONTRACT, STATED ───────────────────────────────────────
 *
 * This suite WRITES to principals, principal_credentials, auth_sessions,
 * groups, group_members, account_home_groups, projects, grants, feed_events and
 * audit_events, it DISABLES and re-enables one principal, and it ADDS AND DROPS
 * one CHECK constraint on `grants`. It refuses any URL naming a deployment
 * database (`relayhall_dev`, `relayhall_tst`, `relayhall_prod`, `relayhall`).
 * Bring the database up with `database/init.sql` and `npm run migrate`, and
 * throw it away afterwards.
 */

/* eslint-disable @typescript-eslint/no-var-requires */

import http from 'http';
import crypto from 'crypto';
// TYPES ONLY: a value import here would be HOISTED above the
// `process.env.DB_*` assignments below, and it reaches `db/connection`
// through `HomeGroupService` - so the production pool would be built against
// the ambient environment instead of RELAYHALL_TEST_DB_URL. `import type` is
// erased; the functions come in through `require` once the environment is
// pinned, like every other symbol in this file.
import type {
  AuditRow,
  DrillInput,
  GrantRow,
  Observation,
  SchemaObservation,
  SerialisationObservation,
} from './acceptance/lensesDrillOracles';

// ─────────────────────────── the database contract ───────────────────────────

const TEST_DB_URL = process.env.RELAYHALL_TEST_DB_URL;
if (!TEST_DB_URL) {
  throw new Error(
    'RELAYHALL_TEST_DB_URL is not set. This gate measures whether a FOR SHARE lock blocks, whether a clause '
    + 'flipped between resolution and write is the value the act decides on, and whether a failed grant insert '
    + 'takes the project row with it. All three are properties of a real transaction, and a mocked pool has '
    + 'none of them, so this suite refuses to skip. Create a disposable database, load database/init.sql, run '
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
process.env.JWT_SECRET = crypto.randomBytes(32).toString('hex');
process.env.RELAYHALL_SESSIONS = 'on';

const express = require('express');

const { pool } = require('../db/connection');
const { registerProtectedRoutes } = require('../routeRegistry');
const { authMiddleware } = require('../middleware/auth');
const { sharedAuthorizationMiddleware } = require('../middleware/sharedAuthorization');
const { apiErrorHandler } = require('../utils/apiErrors');
const { jsonBodyOptions } = require('../utils/jsonBodyTypes');
const { loginSessionService, SESSION_COOKIE_NAME } = require('../services/LoginSessionService');
const { principalService } = require('../services/PrincipalService');
const { CREATION_DEFAULT_SKIP_REASONS } = require('../services/HomeGroupService');
const {
  REQUIRED_ASSERTIONS, assertSerialised, assertionSet,
} = require('./acceptance/lensesDrillOracles');

jest.setTimeout(240_000);

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
  authMethod: string;
  scopes: string[];
}

async function call(who: Caller, method: string, routePath: string, body?: unknown): Promise<Answer> {
  const response = await fetch(`${origin}${routePath}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...who.headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let json: any = null;
  try { json = JSON.parse(text); } catch { json = null; }
  return { status: response.status, json };
}

// ────────────────────────────── the fixtures ─────────────────────────────────

const tag = (): string => crypto.randomBytes(6).toString('hex');

/** A ROOT LOGIN SESSION — the ONE channel owner decision 6 admits. */
let ROOT: Caller;
/** The same Account's authority arriving on a BEARER credential holding root. */
let ROOT_BEARER: Caller;
/** A LOGIN SESSION that does not hold root, but may create projects. */
let PLAIN_SESSION: Caller;
/** A member of the home group who is NOT the creator: the principal whose
 *  readable set the creation default is supposed to change. */
let MEMBER: Caller;
/** Same shape, same role, same scopes, no group and no grant. If this caller
 *  ever reads a fixture, some other arm is firing. */
let STRANGER: Caller;

let HOME_GROUP: string;

async function makeAccount(role: string, prefix: string): Promise<string> {
  const handle = `lensb-${prefix}-${tag()}`;
  const result = await pool.query(
    `INSERT INTO principals (kind, handle, display_name, status, role)
     VALUES ('human', $1, $2, 'active', $3) RETURNING id`,
    [handle, `lenses-b ${handle}`, role],
  );
  return String(result.rows[0].id);
}

async function sessionFor(label: string, principalId: string, scopes: string[]): Promise<Caller> {
  const minted = await loginSessionService.mint({ principalId });
  return {
    label, principalId, authMethod: 'session', scopes,
    headers: { Cookie: `${SESSION_COOKIE_NAME}=${minted.token}` },
  };
}

/**
 * A `principal_api_key` bearer HOLDING root.
 *
 * `PrincipalService.issueCredential` refuses `root` outright (AZ-18: root is
 * never delegable to a bearer credential), so the credential is minted with an
 * ordinary scope and then WIDENED in raw SQL. That is deliberate: `A-L50` names
 * a bearer *holding* root as the caller the acting-channel test must refuse, so
 * the drill has to produce one the ordinary door will not mint. A weaker
 * fixture — a bearer with only `projects:write` — would pass a build whose only
 * test was `scopes.includes('root')`, which is exactly the defect the row
 * exists to catch.
 */
async function rootBearerFor(label: string, accountId: string): Promise<Caller> {
  // The role stays 'user': 'principals_elevated_parentless' refuses an elevated
  // role on a PARENTED row, and this principal is parented while it is minted.
  // The role is irrelevant to what follows - a parentless, non-legacy principal
  // keeps its CREDENTIAL's scopes, and no role-derived set is consulted.
  //
  // The bearer is its OWN parentless principal, minted while temporarily
  // parented so `issueCredential`'s A17.1 keyless-Account rule is satisfied by
  // the ordinary door, then detached. Detached and non-legacy, the
  // authentication path leaves `req.scopes` as the CREDENTIAL's scopes
  // (`middleware/auth.ts`: the chain branch runs only for a parented,
  // non-legacy principal, and `DelegationService.effectiveScopes` strips
  // `root` from every delegated chain by rule 2).
  //
  // The widening to `root` is raw SQL on purpose. Two shipped rules make a
  // root bearer unmintable through any surface - AZ-18's
  // `ROOT_NOT_MINTABLE` at the write, and rule 2's strip at the read - and a
  // drill that could only produce the bearers the doors admit would be
  // asserting the acting-channel test against a caller the scope map had
  // already stopped. `A-L50` names a bearer HOLDING root precisely because
  // `isBearerCredentialKind` must be the discriminator: a build whose only
  // test was `scopes.includes('root')` passes every other case in this file.
  const handle = `lensb-bearer-${tag()}`;
  const created = await pool.query(
    `INSERT INTO principals (kind, handle, display_name, status, role, parent_principal_id)
     VALUES ('service', $1, $2, 'active', 'user', $3) RETURNING id`,
    [handle, `lenses-b ${handle}`, accountId],
  );
  const bearerId = String(created.rows[0].id);
  const issued = await principalService.issueCredential({
    principalId: bearerId, scopes: ['projects:write', 'projects:read'], label, transport: 'api',
  });
  await pool.query('UPDATE principals SET parent_principal_id = NULL WHERE id = $1', [bearerId]);
  await pool.query(
    `UPDATE principal_credentials SET scopes = $2::jsonb WHERE id = $1`,
    [issued.credentialId, JSON.stringify(['root'])],
  );
  principalService.invalidatePrincipals?.([bearerId]);
  return {
    label, principalId: bearerId, authMethod: 'principal_api_key', scopes: ['root'],
    headers: { Authorization: `Bearer ${issued.fullKey}` },
  };
}

async function makeGroup(name: string, featured: boolean): Promise<string> {
  const result = await pool.query(
    'INSERT INTO groups (name, description, featured) VALUES ($1, $2, $3) RETURNING id',
    [name, 'lenses-b fixture', featured],
  );
  return String(result.rows[0].id);
}

async function addMember(groupId: string, principalId: string): Promise<void> {
  await pool.query(
    `INSERT INTO group_members (group_id, account_principal_id, source)
     VALUES ($1, $2, 'local') ON CONFLICT DO NOTHING`,
    [groupId, principalId],
  );
}

async function setPointer(principalId: string, groupId: string): Promise<void> {
  await pool.query(
    `INSERT INTO account_home_groups (account_principal_id, group_id, source)
     VALUES ($1, $2, 'self')
     ON CONFLICT (account_principal_id) DO UPDATE SET group_id = EXCLUDED.group_id`,
    [principalId, groupId],
  );
}

// ─────────────────────── reading the state back, honestly ────────────────────

/**
 * Owner contract B's project creator pair — the OTHER writer on this
 * transaction. `ProjectService.create` calls
 * `GrantService.createForProjectCreator` for every creation by a caller whose
 * principal resolved, so these two rows land whether the home-group act
 * applied or skipped. A skip is a statement about the home-group act alone,
 * which is why the cases below name the pair explicitly instead of expecting
 * an empty set or filtering it away.
 */
function creatorPairOf(projectId: string | null, principalId: string): GrantRow[] {
  return ['read', 'write'].map((verb) => ({
    granteeType: 'principal',
    granteeId: principalId,
    resourceType: 'project',
    resourceId: projectId,
    verb,
    origin: 'manual',
    provenance: null,
  }));
}

async function grantsFor(projectId: string | null): Promise<GrantRow[]> {
  if (!projectId) return [];
  const rows = await pool.query(
    `SELECT grantee_type, grantee_id, resource_type, resource_id, verb, origin, provenance
       FROM grants WHERE resource_type = 'project' AND resource_id = $1
       ORDER BY verb`,
    [projectId],
  );
  return rows.rows.map((row: any) => ({
    granteeType: String(row.grantee_type),
    granteeId: String(row.grantee_id),
    resourceType: String(row.resource_type),
    resourceId: row.resource_id === null ? null : String(row.resource_id),
    verb: String(row.verb),
    origin: String(row.origin),
    provenance: row.provenance === null ? null : String(row.provenance),
  }));
}

async function auditsFor(projectId: string | null): Promise<AuditRow[]> {
  if (!projectId) return [];
  const rows = await pool.query(
    `SELECT action, outcome, metadata FROM audit_events
      WHERE resource_type = 'project' AND resource_id = $1
        AND action LIKE 'project.access_default%'
      ORDER BY occurred_at`,
    [projectId],
  );
  return rows.rows.map((row: any) => ({
    action: String(row.action), outcome: String(row.outcome), metadata: row.metadata ?? {},
  }));
}

async function everyGrantRow(): Promise<GrantRow[]> {
  const rows = await pool.query(
    `SELECT grantee_type, grantee_id, resource_type, resource_id, verb, origin, provenance FROM grants`,
  );
  return rows.rows.map((row: any) => ({
    granteeType: String(row.grantee_type),
    granteeId: String(row.grantee_id),
    resourceType: String(row.resource_type),
    resourceId: row.resource_id === null ? null : String(row.resource_id),
    verb: String(row.verb),
    origin: String(row.origin),
    provenance: row.provenance === null ? null : String(row.provenance),
  }));
}

async function schemaObservation(): Promise<SchemaObservation> {
  const checks = await pool.query(
    `SELECT conname, pg_get_constraintdef(oid) AS def
       FROM pg_constraint
      WHERE conrelid = 'grants'::regclass AND contype = 'c'`,
  );
  const defs: string[] = checks.rows.map((row: any) => String(row.def));
  const nonManual = (await everyGrantRow()).filter((row) => row.origin !== 'manual');
  return {
    provenanceCheckDefs: defs.filter((def) => def.includes('provenance')),
    originGroupOnly: checks.rows.some((row: any) => String(row.conname) === 'grants_origin_group_only'),
    nonManualRows: nonManual,
    ...(await provenanceDomainProbe()),
  };
}

/**
 * ASK THE DATABASE what the `provenance` CHECK admits (round-1 review finding
 * B3).
 *
 * The oracle parses `pg_get_constraintdef`, which is a string this build read.
 * This is the constraint ANSWERING: an arbitrary, unratified token must be
 * REFUSED, and both ratified values must be ACCEPTED. The second half is the
 * vacuity guard - a CHECK that admitted nothing at all would satisfy a
 * refusal-only assertion perfectly, which is the same shape as the defect this
 * repair exists for.
 *
 * Every probe row is written and rolled back inside one transaction, so the
 * table is unchanged.
 */
async function provenanceDomainProbe(): Promise<{
  arbitraryProvenanceRefused: boolean; ratifiedProvenanceAccepted: string[];
}> {
  const probeProject = await pool.query(
    `INSERT INTO projects (name, status, visibility) VALUES ($1, 'active', 'private')
     RETURNING id`, [`lensb-provenance-probe ${tag()}`]);
  const projectId = String(probeProject.rows[0].id);
  const accepted: string[] = [];
  let refused = false;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const write = async (provenance: string, verb: string): Promise<boolean> => {
      await client.query('SAVEPOINT probe');
      try {
        await client.query(
          `INSERT INTO grants (grantee_type, grantee_id, resource_type, resource_id,
                               verb, origin, provenance)
           VALUES ('group', $1, 'project', $2, $3, 'manual', $4)`,
          [HOME_GROUP, projectId, verb, provenance]);
        await client.query('RELEASE SAVEPOINT probe');
        return true;
      } catch {
        await client.query('ROLLBACK TO SAVEPOINT probe');
        return false;
      }
    };
    for (const [index, value] of ['assignment:grant', 'assignment:warrant'].entries()) {
      if (await write(value, index === 0 ? 'read' : 'write')) accepted.push(value);
    }
    refused = !(await write('lensb-unratified-third-value', 'use'));
  } finally {
    await client.query('ROLLBACK').catch(() => undefined);
    client.release();
  }
  await pool.query('DELETE FROM projects WHERE id = $1', [projectId]);
  return { arbitraryProvenanceRefused: refused, ratifiedProvenanceAccepted: accepted };
}

/** Create a project through the production router and read back what landed. */
async function createProject(who: Caller): Promise<{ answer: Answer; projectId: string | null; name: string }> {
  // The NAME is carried out so a case that expected NO project row can prove
  // it: `projectId` is null both when the create was refused and when the
  // assertion simply never looked.
  const name = `lensb ${tag()}`;
  const answer = await call(who, 'POST', '/projects', { name });
  const projectId = answer.status === 201 ? String(answer.json.project.id) : null;
  return { answer, projectId, name };
}

async function observe(
  assertion: string, who: Caller, expectation: Observation['expectation'],
): Promise<Observation> {
  const { answer, projectId } = await createProject(who);
  expect(answer.status).toBe(201);
  return {
    assertion,
    actor: { authMethod: who.authMethod, scopes: who.scopes, principalId: who.principalId },
    expectation,
    projectId,
    grants: await grantsFor(projectId),
    audits: await auditsFor(projectId),
  };
}

// ─────────────────────── the barrier: one clause, held ───────────────────────

/**
 * Run `POST /projects` while a second connection holds the row ONE CLAUSE
 * lives in, and flips that clause inside the same transaction.
 *
 * -- WHY THE LOCK IS PER-CLAUSE (round-1 review finding B1) ------------------
 *
 * The first version took `groups ... FOR UPDATE` for EVERY flip. That
 * serialises writers production does not lock against, so it proved only
 * "the flip committed before the re-derivation" - never "the flip landed
 * after that clause was read and before the grant write", which is the window
 * `R-11-v1` is about. Each schedule now holds the clause's OWN row and
 * nothing else.
 *
 * `blockedWhileHeld` is therefore the assertion that matters: the act blocked
 * on THAT row, which is true only if the act locks it. A build that read the
 * clause without a lock answers immediately and the drill goes red. There is
 * no window to schedule a flip into, and this is how its absence is measured:
 * by watching the writer wait for it.
 */
async function underBarrier(
  who: Caller,
  lock: { sql: string; params: unknown[] },
  flip: (client: any) => Promise<void>,
): Promise<{ answer: Answer; projectId: string | null; name: string; blockedWhileHeld: boolean }> {
  const holder = await pool.connect();
  let settled = false;
  let pending: Promise<{ answer: Answer; projectId: string | null; name: string }>;
  try {
    await holder.query('BEGIN');
    // The clause's own row, FOR UPDATE, held until this transaction commits.
    await holder.query(lock.sql, lock.params);
    await flip(holder);

    pending = createProject(who).then((result) => { settled = true; return result; });
    // Long enough that a request which never took the lock has certainly
    // answered; short enough not to dominate the suite.
    await new Promise((resolve) => setTimeout(resolve, 1200));
    const blockedWhileHeld = !settled;

    await holder.query('COMMIT');
    const result = await pending;
    return { ...result, blockedWhileHeld };
  } catch (e) {
    await holder.query('ROLLBACK').catch(() => undefined);
    throw e;
  } finally {
    holder.release();
  }
}

// ───────────────────────────── the observations ──────────────────────────────

/**
 * Does this line WRITE `origin = 'steward'`?
 *
 * `[N3]`: the value ships as a DORMANT CHECK value with no v1 writer. A grep
 * for the literal cannot say that — `GrantService`'s `origin` type union
 * declares it, which is the whole point of declaring it. A write assigns it:
 * as a bound or inline value in a statement, or as an object property.
 */
function writesStewardOrigin(line: string): boolean {
  const literal = /['\"]steward['\"]/;
  if (!literal.test(line)) return false;
  if (/(INSERT|UPDATE|VALUES)/i.test(line)) return true;
  return /origin\s*[=:]\s*['\"]steward['\"]/.test(line);
}

const CASES: Observation[] = [];
let SERIALISATION: SerialisationObservation;
/** MEMBER's readable project set BEFORE any creation default exists. */
let MEMBER_BASELINE: string[];
const FIXTURE_PROJECTS: string[] = [];

async function readableByPointRoute(who: Caller): Promise<string[]> {
  const allowed: string[] = [];
  for (const projectId of FIXTURE_PROJECTS) {
    const answer = await call(who, 'GET', `/projects/${projectId}`);
    if (answer.status === 200) allowed.push(projectId);
    else expect([403, 404]).toContain(answer.status);
  }
  return allowed.sort();
}

beforeAll(async () => {
  await new Promise<void>((resolve) => { server = buildApp().listen(0, resolve); });
  origin = `http://127.0.0.1:${(server.address() as any).port}`;

  const rootId = await makeAccount('admin', 'root');
  ROOT = await sessionFor('root-session', rootId, ['root']);
  ROOT_BEARER = await rootBearerFor('root-bearer', rootId);
  PLAIN_SESSION = await sessionFor('plain-session', await makeAccount('user', 'plain'),
    ['projects:read', 'projects:write']);
  MEMBER = await sessionFor('member', await makeAccount('user', 'member'),
    ['projects:read', 'projects:write']);
  STRANGER = await sessionFor('stranger', await makeAccount('user', 'stranger'),
    ['projects:read', 'projects:write']);

  HOME_GROUP = await makeGroup(`lensb-home-${tag()}`, true);
  await addMember(HOME_GROUP, rootId);
  await addMember(HOME_GROUP, MEMBER.principalId);
  await setPointer(rootId, HOME_GROUP);
});

afterAll(async () => {
  await new Promise<void>((resolve) => { server.close(() => resolve()); });
  await pool.end();
});

// ═══════════════════════════════════════════════════════════════════════════
// 0 · VACUITY — the fixtures are real and nothing else can explain a read
// ═══════════════════════════════════════════════════════════════════════════

describe('0 · the fixtures are real', () => {
  it('a project created by the root session is PRIVATE, so only a grant can open it', async () => {
    const { projectId } = await createProject(ROOT);
    expect(projectId).not.toBeNull();
    FIXTURE_PROJECTS.push(projectId!);
    const row = await pool.query('SELECT visibility, owner_principal_id FROM projects WHERE id = $1', [projectId]);
    // Without this, every "the member can read it" assertion below could be
    // explained by the visibility arm and would say nothing about the grant.
    expect(row.rows[0].visibility).toBe('private');
    expect(row.rows[0].owner_principal_id).toBeNull();
  });

  it('the stranger reads NOTHING, before or after', async () => {
    expect(await readableByPointRoute(STRANGER)).toEqual([]);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 1 · A-L19 — PUT /principals/me/home-group
// ═══════════════════════════════════════════════════════════════════════════

describe('1 · A-L19 · choosing a home group', () => {
  let unfeatured: string;
  let featuredNotMine: string;

  beforeAll(async () => {
    unfeatured = await makeGroup(`lensb-unfeatured-${tag()}`, false);
    await addMember(unfeatured, MEMBER.principalId);
    featuredNotMine = await makeGroup(`lensb-notmine-${tag()}`, true);
  });

  it('an UNFEATURED group is refused with a named code', async () => {
    const answer = await call(MEMBER, 'PUT', '/principals/me/home-group', { groupId: unfeatured });
    expect(answer.status).toBe(422);
    expect(answer.json.code).toBe('GROUP_NOT_FEATURED');
  });

  it('a featured group the caller is NOT a member of is refused with a named code', async () => {
    const answer = await call(MEMBER, 'PUT', '/principals/me/home-group', { groupId: featuredNotMine });
    expect(answer.status).toBe(422);
    expect(answer.json.code).toBe('NOT_A_GROUP_MEMBER');
  });

  it('a refusal is a DURABLE audited denial — the rollback does not erase it', async () => {
    const rows = await pool.query(
      `SELECT metadata FROM audit_events
        WHERE action = 'home_group.set' AND outcome = 'denied' AND resource_id = $1`,
      [MEMBER.principalId],
    );
    expect(rows.rows.length).toBeGreaterThanOrEqual(2);
    expect(rows.rows.map((r: any) => r.metadata.refusal).sort())
      .toEqual(expect.arrayContaining(['GROUP_NOT_FEATURED', 'NOT_A_GROUP_MEMBER']));
  });

  it('a valid one writes source=self and audits the act', async () => {
    const answer = await call(MEMBER, 'PUT', '/principals/me/home-group', { groupId: HOME_GROUP });
    expect(answer.status).toBe(200);
    expect(answer.json.homeGroup.groupId).toBe(HOME_GROUP);
    const row = await pool.query(
      'SELECT source FROM account_home_groups WHERE account_principal_id = $1', [MEMBER.principalId]);
    expect(row.rows[0].source).toBe('self');
    const audit = await pool.query(
      `SELECT metadata FROM audit_events WHERE action = 'home_group.set' AND outcome = 'success'
        AND resource_id = $1`, [MEMBER.principalId]);
    expect(audit.rows[0].metadata.source).toBe('self');
  });

  it('an unknown body field is refused before anything is written', async () => {
    const answer = await call(MEMBER, 'PUT', '/principals/me/home-group',
      { groupId: HOME_GROUP, source: 'admin' });
    expect(answer.status).toBe(400);
    expect(answer.json.code).toBe('UNKNOWN_FIELD');
  });

  it('the ADMIN arm refuses a BEARER credential by name — it is a login-session act', async () => {
    const answer = await call(ROOT_BEARER, 'PUT', `/principals/${MEMBER.principalId}/home-group`,
      { groupId: HOME_GROUP });
    expect(answer.status).toBe(403);
    expect(answer.json.code).toBe('REQUIRES_LOGIN_SESSION');
  });

  it('the ADMIN arm accepts a login session and writes source=admin', async () => {
    const answer = await call(ROOT, 'PUT', `/principals/${MEMBER.principalId}/home-group`,
      { groupId: HOME_GROUP });
    expect(answer.status).toBe(200);
    const row = await pool.query(
      'SELECT source FROM account_home_groups WHERE account_principal_id = $1', [MEMBER.principalId]);
    expect(row.rows[0].source).toBe('admin');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 2 · A-L20 — the pointer SURVIVES; the answer is DERIVED
// ═══════════════════════════════════════════════════════════════════════════

describe('2 · A-L20 · derivation D-L2', () => {
  async function view(): Promise<any> {
    const answer = await call(MEMBER, 'GET', '/principals/me/home-group');
    expect(answer.status).toBe(200);
    return answer.json.homeGroup;
  }

  async function pointerRow(): Promise<any> {
    const rows = await pool.query(
      'SELECT group_id, set_at FROM account_home_groups WHERE account_principal_id = $1',
      [MEMBER.principalId]);
    return rows.rows[0];
  }

  it('resolves while all three conditions hold', async () => {
    const home = await view();
    expect(home.groupId).toBe(HOME_GROUP);
    expect(home.unresolvedReason).toBeNull();
  });

  it('losing FEATURED makes it resolve null while the pointer survives, and restoring it needs NO re-write', async () => {
    const before = await pointerRow();
    await pool.query('UPDATE groups SET featured = FALSE WHERE id = $1', [HOME_GROUP]);
    const broken = await view();
    expect(broken.groupId).toBeNull();
    expect(broken.unresolvedReason).toBe('not_featured');
    expect(broken.pointer.groupId).toBe(HOME_GROUP);

    await pool.query('UPDATE groups SET featured = TRUE WHERE id = $1', [HOME_GROUP]);
    expect((await view()).groupId).toBe(HOME_GROUP);
    // The pointer row was never rewritten: same row, same set_at.
    const after = await pointerRow();
    expect(after.set_at.toISOString()).toBe(before.set_at.toISOString());
  });

  it('losing MEMBERSHIP resolves null and names that clause', async () => {
    await pool.query('DELETE FROM group_members WHERE group_id = $1 AND account_principal_id = $2',
      [HOME_GROUP, MEMBER.principalId]);
    const broken = await view();
    expect(broken.groupId).toBeNull();
    expect(broken.unresolvedReason).toBe('not_a_member');
    await addMember(HOME_GROUP, MEMBER.principalId);
    expect((await view()).groupId).toBe(HOME_GROUP);
  });

  it('a DISABLED Account resolves null and names that clause', async () => {
    await pool.query("UPDATE principals SET status = 'disabled' WHERE id = $1", [MEMBER.principalId]);
    try {
      const rows = await pool.query(
        `SELECT 1 FROM account_home_groups WHERE account_principal_id = $1`, [MEMBER.principalId]);
      expect(rows.rows).toHaveLength(1);
      // Read through the SERVICE rather than the route: a disabled Account
      // cannot authenticate, which is exactly why the creation default
      // re-derives this clause INSIDE its own transaction rather than trusting
      // the session that got the request through the door.
      const { homeGroupService } = require('../services/HomeGroupService');
      const home = await homeGroupService.view(MEMBER.principalId);
      expect(home.groupId).toBeNull();
      expect(home.unresolvedReason).toBe('actor_inactive');
      expect(home.pointer.groupId).toBe(HOME_GROUP);
    } finally {
      await pool.query("UPDATE principals SET status = 'active' WHERE id = $1", [MEMBER.principalId]);
    }
  });

  it('a pointer at a DELETED group resolves null as no_home_group', async () => {
    const doomed = await makeGroup(`lensb-doomed-${tag()}`, true);
    await addMember(doomed, STRANGER.principalId);
    await setPointer(STRANGER.principalId, doomed);
    await pool.query('DELETE FROM account_home_groups WHERE group_id = $1', [doomed]);
    await pool.query('DELETE FROM group_members WHERE group_id = $1', [doomed]);
    await pool.query('DELETE FROM groups WHERE id = $1', [doomed]);
    const answer = await call(STRANGER, 'GET', '/principals/me/home-group');
    expect(answer.status).toBe(200);
    expect(answer.json.homeGroup.groupId).toBeNull();
    expect(answer.json.homeGroup.unresolvedReason).toBe('no_home_group');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 3 · A-L21 / R-11-v1 (i) — THE APPLY, AND ALL-OR-NOTHING
// ═══════════════════════════════════════════════════════════════════════════

describe('3 · A-L21 · a root login session with a resolving home group', () => {
  it('creates the project AND exactly two creation-default rows', async () => {
    MEMBER_BASELINE = await readableByPointRoute(MEMBER);
    const observation = await observe('apply:two-rows', ROOT, { kind: 'apply', groupId: HOME_GROUP });
    CASES.push(observation);
    FIXTURE_PROJECTS.push(observation.projectId!);
    expect(assertionSet({
      cases: [observation], schema: await schemaObservation(),
      serialisation: { blockedWhileHeld: true, featuredAfterHolderCommitted: true, grants: [], audits: [] },
      allGrantRows: [],
    })['apply:two-rows']).toEqual([]);
  });

  it('the grant is what OPENS the project: the member reads it, the stranger does not', async () => {
    // The expected set is read back from the POINT ROUTE, so nothing here
    // recomputes the authorization rule.
    const readable = await readableByPointRoute(MEMBER);
    const created = CASES.find((c) => c.assertion === 'apply:two-rows')!.projectId!;
    expect(readable).toEqual([...MEMBER_BASELINE, created].sort());
    expect(await readableByPointRoute(STRANGER)).toEqual([]);
  });

  it('NO WIDENING: the stranger is unchanged, and every creation-default row is in shape', async () => {
    expect(await readableByPointRoute(STRANGER)).toEqual([]);
    // The table-wide invariant, not a count: EVERY row this origin can
    // produce names a GROUP the creator resolved, a PROJECT, and one of the
    // two verbs. An act that granted to some other Group, over some other
    // resource type, or with a third verb would land here whatever else it
    // got right — and unlike a count it stays true on a database this suite
    // did not create from scratch.
    const rows = await pool.query(
      `SELECT grantee_id, resource_id, verb FROM grants
        WHERE origin = 'creation-default'`);
    expect(rows.rows.length).toBeGreaterThan(0);
    for (const row of rows.rows) {
      // Shape, of every row the origin can produce, whenever it was written.
      expect(['read', 'write']).toContain(row.verb);
      // Identity, of the rows THIS run produced. A database this suite did
      // not create from scratch carries another run's Groups, and asserting
      // their identity here would be asserting something about a fixture
      // that no longer exists.
      if (FIXTURE_PROJECTS.includes(String(row.resource_id))) {
        expect(row.grantee_id).toBe(HOME_GROUP);
      }
    }
    const shape = await pool.query(
      `SELECT count(*)::int AS n FROM grants
        WHERE origin = 'creation-default'
          AND (grantee_type <> 'group' OR resource_type <> 'project'
               OR resource_id IS NULL OR verb NOT IN ('read', 'write'))`);
    expect(shape.rows[0].n).toBe(0);
  });

  it('a forced failure on the SECOND grant insert leaves NO project row', async () => {
    // The failure is injected in SQL, not in the service: a CHECK that refuses
    // the `write` row. The `read` row is written first, so the act is
    // interrupted BETWEEN its two inserts - which is the state "best effort"
    // would have left half of.
    await pool.query(
      `ALTER TABLE grants ADD CONSTRAINT lensb_forced_failure
         CHECK (NOT (origin = 'creation-default' AND verb = 'write')) NOT VALID`);
    let projectCount: number;
    try {
      const before = await pool.query('SELECT count(*)::int AS n FROM projects');
      const answer = await call(ROOT, 'POST', '/projects', { name: `lensb-atomic ${tag()}` });
      expect(answer.status).toBe(500);
      const after = await pool.query('SELECT count(*)::int AS n FROM projects');
      projectCount = after.rows[0].n - before.rows[0].n;
    } finally {
      await pool.query('ALTER TABLE grants DROP CONSTRAINT lensb_forced_failure');
    }
    expect(projectCount).toBe(0);
    // AND NO ORPHAN GRANT ROW. `grants.resource_id` is polymorphic and carries
    // no foreign key, so a build that wrote its rows on the POOL instead of the
    // project's own client leaves a grant naming a project that does not exist
    // - and the project-count delta above is STILL zero, because the create's
    // own transaction rolls back either way. That orphan is the whole of what
    // 'best-effort attachment' looks like from outside, and this is the
    // assertion that sees it. (The live red proof found this gap: the
    // pool-writing mutant passed every other assertion in this file.)
    //
    // Scoped to THIS run's home Group, not the whole table: a database this
    // suite did not create carries every earlier run's rows, and a census
    // over all of them reports another run's defect as this one's. The
    // pool-writing mutant writes its orphan against exactly this Group, so
    // the narrowing costs the assertion nothing.
    const orphans = await pool.query(
      `SELECT count(*)::int AS n FROM grants g
        WHERE g.resource_type = 'project' AND g.resource_id IS NOT NULL
          AND g.grantee_id = $1
          AND NOT EXISTS (SELECT 1 FROM projects p WHERE p.id = g.resource_id)`,
      [HOME_GROUP]);
    expect(orphans.rows[0].n).toBe(0);
    CASES.push({
      assertion: 'apply:atomic',
      actor: { authMethod: ROOT.authMethod, scopes: ROOT.scopes, principalId: ROOT.principalId },
      expectation: { kind: 'apply', groupId: HOME_GROUP },
      projectId: null, grants: [], audits: [],
    });
  });

  it('...and the constraint really did refuse the row — the drill is not vacuous', async () => {
    // A forced-failure drill whose injected constraint never fired would report
    // "no project row" for a reason that has nothing to do with atomicity.
    await pool.query(
      `ALTER TABLE grants ADD CONSTRAINT lensb_forced_failure
         CHECK (NOT (origin = 'creation-default' AND verb = 'write')) NOT VALID`);
    try {
      await expect(pool.query(
        `INSERT INTO grants (grantee_type, grantee_id, resource_type, resource_id, verb, origin)
         VALUES ('group', $1, 'project', $2, 'write', 'creation-default')`,
        [HOME_GROUP, FIXTURE_PROJECTS[0]],
      )).rejects.toThrow(/lensb_forced_failure/);
    } finally {
      await pool.query('ALTER TABLE grants DROP CONSTRAINT lensb_forced_failure');
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 4 · A-L22 / R-11-v1 (ii) — EACH RE-DERIVED CLAUSE, FLIPPED ON ITS OWN
// ═══════════════════════════════════════════════════════════════════════════

describe('4 · A-L22 · the four clause flips, under a real barrier', () => {
  async function flipCase(
    assertion: string, reason: string,
    lock: { sql: string; params: unknown[] },
    flip: (client: any) => Promise<void>,
    restore: () => Promise<void>,
  ): Promise<void> {
    const { answer, projectId, blockedWhileHeld } = await underBarrier(ROOT, lock, flip);
    try {
      expect(answer.status).toBe(201);
      // The act WAITED on THIS CLAUSE'S OWN ROW. That is the whole assertion:
      // a build that read this clause without a lock would have answered
      // while the row was still held, and the window R-11-v1 forbids would be
      // open (round-1 review finding B1).
      expect(blockedWhileHeld).toBe(true);
      CASES.push({
        assertion,
        actor: { authMethod: ROOT.authMethod, scopes: ROOT.scopes, principalId: ROOT.principalId },
        expectation: { kind: 'skip', reason: reason as any },
        projectId,
        grants: await grantsFor(projectId),
        audits: await auditsFor(projectId),
      });
      if (projectId) FIXTURE_PROJECTS.push(projectId);
    } finally {
      await restore();
    }
  }

  it('featured cleared, holding ONLY the Group row → not_featured', async () => {
    await flipCase('skip:not_featured', 'not_featured',
      { sql: 'SELECT id FROM groups WHERE id = $1 FOR UPDATE', params: [HOME_GROUP] },
      async (client) => { await client.query('UPDATE groups SET featured = FALSE WHERE id = $1', [HOME_GROUP]); },
      async () => { await pool.query('UPDATE groups SET featured = TRUE WHERE id = $1', [HOME_GROUP]); });
  });

  it('membership removed, holding ONLY the group_members row → not_a_member', async () => {
    await flipCase('skip:not_a_member', 'not_a_member',
      {
        sql: 'SELECT 1 FROM group_members WHERE group_id = $1 AND account_principal_id = $2 FOR UPDATE',
        params: [HOME_GROUP, ROOT.principalId],
      },
      async (client) => {
        await client.query('DELETE FROM group_members WHERE group_id = $1 AND account_principal_id = $2',
          [HOME_GROUP, ROOT.principalId]);
      },
      async () => { await addMember(HOME_GROUP, ROOT.principalId); });
  });

  /**
   * THE ACCOUNT-STATUS CLAUSE, IN THE SHAPE OWNER CONTRACT B LEFT IT
   * (C9 composition ruling D1).
   *
   * This case asserted 201-with-a-skip, and that is no longer what the route
   * does: `GrantService.createForProjectCreator` refuses a creator chain that
   * is not live, and its 409 takes the whole creating transaction with it. A
   * disabled Account does not create a Project at all.
   *
   * The clause is still flipped on its own row, under the same barrier, and
   * the act still WAITS on that row - which is the property R-11-v1 (ii) and
   * (iv) actually claim. What is asserted at the end is the refusal: the
   * contract's own answer, and no project, grant or audit surviving it. The
   * `actor_inactive` derivation itself keeps its direct proof in
   * `lensesCreationDefaultMutations` (`classifyHomeGroup`, section 5).
   */
  it('the Account disabled, holding ONLY the principals row → contract B REFUSES the create', async () => {
    const { answer, projectId, name, blockedWhileHeld } = await underBarrier(
      ROOT,
      { sql: 'SELECT 1 FROM principals WHERE id = $1 FOR UPDATE', params: [ROOT.principalId] },
      async (client) => {
        await client.query("UPDATE principals SET status = 'disabled' WHERE id = $1", [ROOT.principalId]);
      },
    );
    try {
      expect(answer.status).toBe(409);
      expect(answer.json?.code).toBe('PROJECT_CREATOR_UNAVAILABLE');
      // The act WAITED on THIS CLAUSE'S OWN ROW, exactly as the three cases
      // above do: an act that read the Account without a lock would have
      // answered while the row was still held.
      expect(blockedWhileHeld).toBe(true);
      expect(projectId).toBeNull();
      // ...and the refusal took the whole transaction with it. Read from the
      // table by NAME, because there is no id to read it by - which is the
      // point: a build that created the project and merely reported a 409
      // would pass every assertion above this one.
      const survivors = await pool.query('SELECT id FROM projects WHERE name = $1', [name]);
      expect(survivors.rows).toEqual([]);
      CASES.push({
        assertion: 'refuse:actor_inactive',
        actor: { authMethod: ROOT.authMethod, scopes: ROOT.scopes, principalId: ROOT.principalId },
        expectation: {
          kind: 'refuse', clause: 'actor_inactive',
          status: 409, code: 'PROJECT_CREATOR_UNAVAILABLE',
        },
        refusal: { status: answer.status, code: String(answer.json?.code ?? '') },
        projectId: null, grants: [], audits: [],
      });
    } finally {
      await pool.query("UPDATE principals SET status = 'active' WHERE id = $1", [ROOT.principalId]);
      principalService.invalidatePrincipals?.([ROOT.principalId]);
    }
  });

  it('the pointer cleared, holding ONLY the account_home_groups row → no_home_group', async () => {
    await flipCase('skip:no_home_group', 'no_home_group',
      {
        sql: 'SELECT 1 FROM account_home_groups WHERE account_principal_id = $1 FOR UPDATE',
        params: [ROOT.principalId],
      },
      async (client) => {
        await client.query('DELETE FROM account_home_groups WHERE account_principal_id = $1',
          [ROOT.principalId]);
      },
      async () => { await setPointer(ROOT.principalId, HOME_GROUP); });
  });

  it('a root session with NO pointer at all also skips no_home_group — the ordinary path', async () => {
    const lonely = await sessionFor('lonely-root', await makeAccount('admin', 'lonely'), ['root']);
    const { projectId } = await createProject(lonely);
    expect(await grantsFor(projectId)).toEqual(creatorPairOf(projectId, lonely.principalId!));
    const audits = await auditsFor(projectId);
    expect(audits).toHaveLength(1);
    expect(audits[0].metadata.reason).toBe('no_home_group');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 5 · A-L50 / R-11-v1 (iii) — THE ACTING CHANNEL, BOTH HALVES
// ═══════════════════════════════════════════════════════════════════════════

describe('5 · A-L50 · every other channel skips', () => {
  it('a BEARER credential HOLDING root creates the project and writes no grant', async () => {
    // The bearer is given EVERYTHING the applying root session had: membership
    // of the featured home group and a pointer at it, so its home group
    // RESOLVES. The only thing that differs from section 3 is the door, which
    // is the whole content of owner decision 6 - and it is why the fixture is
    // built this way rather than left without a pointer, where the skip would
    // have been explained by `no_home_group` instead.
    await addMember(HOME_GROUP, ROOT_BEARER.principalId);
    await setPointer(ROOT_BEARER.principalId, HOME_GROUP);
    const { homeGroupService } = require('../services/HomeGroupService');
    expect((await homeGroupService.view(ROOT_BEARER.principalId)).groupId).toBe(HOME_GROUP);
    const observation = await observe('skip:actor_channel_unavailable:bearer', ROOT_BEARER,
      { kind: 'skip', reason: 'actor_channel_unavailable' });
    CASES.push(observation);
    FIXTURE_PROJECTS.push(observation.projectId!);
    expect(observation.grants).toEqual(
      creatorPairOf(observation.projectId, ROOT_BEARER.principalId!));
    expect(observation.audits[0].metadata.reason).toBe('actor_channel_unavailable');
  });

  it('a NON-ROOT login session creates the project and writes no grant', async () => {
    // Same construction, same reason: this caller's home group RESOLVES, so
    // `actor_channel_unavailable` is the only thing that can explain the skip.
    await addMember(HOME_GROUP, PLAIN_SESSION.principalId);
    await setPointer(PLAIN_SESSION.principalId, HOME_GROUP);
    const { homeGroupService } = require('../services/HomeGroupService');
    expect((await homeGroupService.view(PLAIN_SESSION.principalId)).groupId).toBe(HOME_GROUP);
    const observation = await observe('skip:actor_channel_unavailable:non-root-session', PLAIN_SESSION,
      { kind: 'skip', reason: 'actor_channel_unavailable' });
    CASES.push(observation);
    FIXTURE_PROJECTS.push(observation.projectId!);
    expect(observation.grants).toEqual(
      creatorPairOf(observation.projectId, PLAIN_SESSION.principalId!));
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 6 · R-11-v1 (iv) — THE FOR SHARE ACTUALLY BLOCKS
// ═══════════════════════════════════════════════════════════════════════════

describe('6 · R-11-v1 (iv) · serialisation', () => {
  it('a concurrent unfeature serialises BEFORE the resolution: the act skips', async () => {
    const { projectId, blockedWhileHeld } = await underBarrier(ROOT,
      { sql: 'SELECT id FROM groups WHERE id = $1 FOR UPDATE', params: [HOME_GROUP] },
      async (client) => {
        await client.query('UPDATE groups SET featured = FALSE WHERE id = $1', [HOME_GROUP]);
      });
    SERIALISATION = {
      blockedWhileHeld,
      featuredAfterHolderCommitted: false,
      grants: await grantsFor(projectId),
      audits: await auditsFor(projectId),
    };
    await pool.query('UPDATE groups SET featured = TRUE WHERE id = $1', [HOME_GROUP]);
    expect(assertSerialised(SERIALISATION)).toEqual([]);
  });

  it('a concurrent transaction that does NOT unfeature serialises the other way: two rows', async () => {
    const { projectId, blockedWhileHeld } = await underBarrier(ROOT,
      { sql: 'SELECT id FROM groups WHERE id = $1 FOR UPDATE', params: [HOME_GROUP] },
      async (client) => {
        // Touch the row and leave `featured` alone: the act must still have
        // waited (the lock is real) and must then apply.
        await client.query('UPDATE groups SET description = $2 WHERE id = $1', [HOME_GROUP, 'held']);
      });
    const mirror: SerialisationObservation = {
      blockedWhileHeld,
      featuredAfterHolderCommitted: true,
      grants: await grantsFor(projectId),
      audits: await auditsFor(projectId),
    };
    expect(assertSerialised(mirror)).toEqual([]);
    if (projectId) FIXTURE_PROJECTS.push(projectId);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 7 · A-L23 and R-7 — THE SQL CLOSURES
// ═══════════════════════════════════════════════════════════════════════════

describe('7 · A-L23 and R-7 · the closures in SQL', () => {
  it('a non-manual origin naming a PRINCIPAL grantee is refused in raw SQL', async () => {
    for (const origin of ['creation-default', 'steward']) {
      await expect(pool.query(
        `INSERT INTO grants (grantee_type, grantee_id, resource_type, resource_id, verb, origin)
         VALUES ('principal', $1, 'project', $2, 'read', $3)`,
        [ROOT.principalId, FIXTURE_PROJECTS[0], origin],
      )).rejects.toThrow(/grants_origin_group_only/);
    }
  });

  it('a manual PRINCIPAL grant is still perfectly writable — the closure is not a blanket', async () => {
    const result = await pool.query(
      `INSERT INTO grants (grantee_type, grantee_id, resource_type, resource_id, verb, origin)
       VALUES ('principal', $1, 'project', $2, 'read', 'manual') RETURNING id`,
      [STRANGER.principalId, FIXTURE_PROJECTS[0]],
    );
    expect(result.rows).toHaveLength(1);
    await pool.query('DELETE FROM grants WHERE id = $1', [result.rows[0].id]);
  });

  it('an unknown origin is refused', async () => {
    await expect(pool.query(
      `INSERT INTO grants (grantee_type, grantee_id, resource_type, resource_id, verb, origin)
       VALUES ('group', $1, 'project', $2, 'read', 'invented')`,
      [HOME_GROUP, FIXTURE_PROJECTS[0]],
    )).rejects.toThrow(/grants_origin_shape/);
  });

  it("'steward' is REPRESENTABLE and has no writer — declared dormant, not laundered", async () => {
    // A project of its own: the unique key on `grants` carries no `origin`
    // column, so probing on a project that already holds the creation
    // default's `read` row would collide with it and prove nothing about the
    // dormant value.
    const own = await pool.query(
      `INSERT INTO projects (name, status, visibility) VALUES ($1, 'active', 'private')
       RETURNING id`, [`lensb-steward-probe ${tag()}`]);
    const result = await pool.query(
      `INSERT INTO grants (grantee_type, grantee_id, resource_type, resource_id, verb, origin)
       VALUES ('group', $1, 'project', $2, 'read', 'steward') RETURNING id`,
      [HOME_GROUP, String(own.rows[0].id)],
    );
    await pool.query('DELETE FROM grants WHERE id = $1', [result.rows[0].id]);
    // ...and nothing in the shipped tree writes it.
    const fs = require('fs');
    const path = require('path');
    const src = path.join(__dirname, '..');
    const walk = (dir: string, found: string[] = []): string[] => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) { if (entry.name !== '__tests__') walk(full, found); }
        else if (entry.name.endsWith('.ts')) found.push(full);
      }
      return found;
    };
    // A grep for the literal is not a writer census: `GrantService` carries
    // it in the `origin` TYPE UNION, which is a declaration and not an act.
    // So enumerate the LINES that carry it and require none of them to be a
    // write — the property [N3] states is that the value ships DORMANT.
    const carrying: string[] = [];
    const writing: string[] = [];
    for (const file of walk(src)) {
      const relative = path.relative(src, file);
      fs.readFileSync(file, 'utf8').split('\n').forEach((line: string, index: number) => {
        if (!line.includes("'steward'")) return;
        carrying.push(`${relative}:${index + 1}`);
        // A write ASSIGNS the literal; a union DECLARES it. Both shapes are
        // proved on below, so this line is a detector and not a hope.
        if (writesStewardOrigin(line)) {
          writing.push(`${relative}:${index + 1} ${line.trim()}`);
        }
      });
    }
    // Not vacuous: the value IS declared in the tree, so a census finding
    // nothing would mean the walker is broken rather than that no writer
    // exists.
    expect(carrying.length).toBeGreaterThan(0);
    // ...and the detector fires on the shapes a writer would actually have,
    // and NOT on the declaration that is supposed to be there. Without this
    // pair, a detector that matched nothing would make the census pass by
    // looking at nothing.
    expect(writesStewardOrigin("origin: 'manual' | 'creation-default' | 'steward';")).toBe(false);
    expect(writesStewardOrigin("  * `steward` ships as a dormant CHECK value")).toBe(false);
    for (const planted of [
      "       VALUES ('group', $1, 'project', $2, $3, $4, 'steward')`,",
      "      await client.query(`UPDATE grants SET origin = 'steward' WHERE id = $1`);",
      "        origin: 'steward',",
      '        origin: "steward",',
    ]) {
      expect(writesStewardOrigin(planted)).toBe(true);
    }
    expect(writing).toEqual([]);
    // ...and nothing in the database carries it either, after a whole drill.
    const live = await pool.query(
      "SELECT count(*)::int AS n FROM grants WHERE origin = 'steward'");
    expect(live.rows[0].n).toBe(0);
  });

  it('R-7: the provenance CHECK admits EXACTLY the two ratified values', async () => {
    const schema = await schemaObservation();
    // The probe is not vacuous: the constraint accepted BOTH ratified values
    // and refused the arbitrary one. A CHECK that refused everything would
    // satisfy a refusal-only assertion, which is the shape of the defect this
    // control was rejected for in round 1.
    expect(schema.ratifiedProvenanceAccepted).toEqual(
      ['assignment:grant', 'assignment:warrant']);
    expect(schema.arbitraryProvenanceRefused).toBe(true);
    expect(assertionSet({
      cases: [], schema,
      serialisation: SERIALISATION, allGrantRows: await everyGrantRow(),
    })['R-7:provenance']).toEqual([]);
  });

  it('...and the oracle REDDENS for a widening it was never told to forbid', async () => {
    // The round-1 finding, reproduced verbatim as the control: the previous
    // oracle searched for two substrings and a named forbidden list, so a third
    // value nobody had thought of passed. This is that exact definition.
    const widened = await schemaObservation();
    widened.provenanceCheckDefs = [
      "CHECK (((provenance IS NULL) OR (provenance = ANY (ARRAY['assignment:grant'::text,"
      + " 'assignment:warrant'::text, 'unexpected-third-value'::text]))))",
    ];
    expect(assertionSet({
      cases: [], schema: widened,
      serialisation: SERIALISATION, allGrantRows: [],
    })['R-7:provenance']).not.toEqual([]);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 8 · A-L38 — GROUP_IS_A_HOME_GROUP, AND THE ROOT-PLANE CLEAR
// ═══════════════════════════════════════════════════════════════════════════

describe('8 · A-L38 · deleting a Group that is somebody home', () => {
  let doomed: string;
  let pointers: string[];

  beforeAll(async () => {
    doomed = await makeGroup(`lensb-delete-${tag()}`, true);
    pointers = [await makeAccount('user', 'ptr1'), await makeAccount('user', 'ptr2')];
    for (const id of pointers) {
      await addMember(doomed, id);
      await setPointer(id, doomed);
      await pool.query('DELETE FROM group_members WHERE group_id = $1 AND account_principal_id = $2',
        [doomed, id]);
    }
  });

  it('is refused by name, with a COUNT and no identities', async () => {
    const answer = await call(ROOT, 'DELETE', `/groups/${doomed}`);
    expect(answer.status).toBe(409);
    expect(answer.json.code).toBe('GROUP_IS_A_HOME_GROUP');
    expect(answer.json.message).toContain('2 Accounts');
    for (const id of pointers) expect(JSON.stringify(answer.json)).not.toContain(id);
  });

  it('the clear act is ROOT-PLANE: a non-root session cannot reach it', async () => {
    const answer = await call(PLAIN_SESSION, 'DELETE', `/groups/${doomed}/home-pointers`);
    expect([403, 404]).toContain(answer.status);
    const still = await pool.query(
      'SELECT count(*)::int AS n FROM account_home_groups WHERE group_id = $1', [doomed]);
    expect(still.rows[0].n).toBe(2);
  });

  it('the clear act clears them in ONE transaction and audits each one', async () => {
    const answer = await call(ROOT, 'DELETE', `/groups/${doomed}/home-pointers`);
    expect(answer.status).toBe(200);
    expect(answer.json.cleared).toBe(2);
    for (const id of pointers) {
      const audit = await pool.query(
        `SELECT metadata FROM audit_events WHERE action = 'home_group.clear' AND resource_id = $1`, [id]);
      expect(audit.rows).toHaveLength(1);
      expect(audit.rows[0].metadata.groupId).toBe(doomed);
    }
  });

  it('...and then the delete succeeds', async () => {
    const answer = await call(ROOT, 'DELETE', `/groups/${doomed}`);
    expect(answer.status).toBe(200);
  });

  /**
   * A second connection holding what a pointer-SET holds: the Group row
   * FOR SHARE, plus its pointer write, uncommitted.
   */
  async function whileAPointerIsBeingSet<T>(
    groupId: string, accountId: string, act: () => Promise<T>,
  ): Promise<{ result: T; blockedWhileHeld: boolean }> {
    const holder = await pool.connect();
    let settled = false;
    try {
      await holder.query('BEGIN');
      await holder.query('SELECT 1 FROM groups WHERE id = $1 FOR SHARE', [groupId]);
      await holder.query(
        `INSERT INTO account_home_groups (account_principal_id, group_id, source)
         VALUES ($1, $2, 'self')
         ON CONFLICT (account_principal_id) DO UPDATE SET group_id = EXCLUDED.group_id`,
        [accountId, groupId]);
      const pending = act().then((value) => { settled = true; return value; });
      await new Promise((resolve) => setTimeout(resolve, 1200));
      const blockedWhileHeld = !settled;
      await holder.query('COMMIT');
      return { result: await pending, blockedWhileHeld };
    } catch (e) {
      await holder.query('ROLLBACK').catch(() => undefined);
      throw e;
    } finally {
      holder.release();
    }
  }

  it('SET vs CLEAR: the clear WAITS, and then clears the pointer that arrived', async () => {
    // Round-1 finding B2. Without the protocol the clear reads the pointer set,
    // deletes the ids it saw, and returns success with the newcomer still
    // standing - while its own contract says "every pointer at this Group, in
    // ONE transaction".
    const group = await makeGroup(`lensb-setclear-${tag()}`, true);
    const latecomer = await makeAccount('user', 'latecomer');
    const { result, blockedWhileHeld } = await whileAPointerIsBeingSet(
      group, latecomer, () => call(ROOT, 'DELETE', `/groups/${group}/home-pointers`));
    expect(blockedWhileHeld).toBe(true);
    expect(result.status).toBe(200);
    const left = await pool.query(
      'SELECT count(*)::int AS n FROM account_home_groups WHERE group_id = $1', [group]);
    // The act's promise, measured: NOTHING is left, and the count it reported
    // is the count it actually removed.
    expect(left.rows[0].n).toBe(0);
    expect(result.json.cleared).toBe(1);
  });

  it('SET vs DELETE: the delete WAITS, then answers the NAMED count-only refusal', async () => {
    // The other half. Without the protocol the pointer lands after the count
    // and the delete fails as a raw foreign-key violation - a 500 naming a table
    // the operator has no reason to know about, which is the exact failure the
    // named refusal exists to replace.
    const group = await makeGroup(`lensb-setdelete-${tag()}`, true);
    const latecomer = await makeAccount('user', 'latecomer2');
    const { result, blockedWhileHeld } = await whileAPointerIsBeingSet(
      group, latecomer, () => call(ROOT, 'DELETE', `/groups/${group}`));
    expect(blockedWhileHeld).toBe(true);
    expect(result.status).toBe(409);
    expect(result.json.code).toBe('GROUP_IS_A_HOME_GROUP');
    expect(result.json.message).toContain('1 Account has');
    // Never a raw constraint error, and never the identity of the person.
    expect(JSON.stringify(result.json)).not.toContain('account_home_groups');
    expect(JSON.stringify(result.json)).not.toContain(latecomer);
    // ...and the Group is still there, so the refusal refused something.
    const alive = await pool.query('SELECT 1 FROM groups WHERE id = $1', [group]);
    expect(alive.rows).toHaveLength(1);
  });

  it('B-L7b: termination clears the offboarded Account home pointer, audited', async () => {
    const leaver = await makeAccount('user', 'leaver');
    await addMember(HOME_GROUP, leaver);
    await setPointer(leaver, HOME_GROUP);
    const answer = await call(ROOT, 'POST', `/principals/${leaver}/terminate`);
    expect(answer.status).toBe(200);
    const left = await pool.query(
      'SELECT count(*)::int AS n FROM account_home_groups WHERE account_principal_id = $1', [leaver]);
    expect(left.rows[0].n).toBe(0);
    const audit = await pool.query(
      `SELECT metadata FROM audit_events WHERE action = 'home_group.clear' AND resource_id = $1`, [leaver]);
    expect(audit.rows).toHaveLength(1);
    expect(audit.rows[0].metadata.via).toBe('principal.terminate');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 9 · B-L20 — an unenumerated reason FAILS the write
// ═══════════════════════════════════════════════════════════════════════════

describe('9 · B-L20 · the audit writer validates against the closed set', () => {
  it('refuses to record a reason the enumeration does not carry, and writes nothing', async () => {
    const { recordAccessDefaultSkip } = require('../services/HomeGroupService');
    const before = await pool.query(
      "SELECT count(*)::int AS n FROM audit_events WHERE action = 'project.access_default_skip'");
    await expect(recordAccessDefaultSkip(
      pool, { handle: 'drill', authMethod: 'system' }, FIXTURE_PROJECTS[0], 'because_i_said_so',
    )).rejects.toThrow(/ratified skip reasons/);
    const after = await pool.query(
      "SELECT count(*)::int AS n FROM audit_events WHERE action = 'project.access_default_skip'");
    expect(after.rows[0].n).toBe(before.rows[0].n);
  });

  it('every reason the drill actually observed is in the enumeration', async () => {
    // This run's projects only, for the same reason the orphan census above
    // is scoped: an earlier run against a mutant that skipped the validation
    // left its free string in this ledger, and it is not this run's finding.
    const rows = await pool.query(
      `SELECT DISTINCT metadata->>'reason' AS reason FROM audit_events
        WHERE action = 'project.access_default_skip'
          AND resource_id = ANY($1::text[])`, [FIXTURE_PROJECTS]);
    const observed = rows.rows.map((row: any) => String(row.reason)).sort();
    expect(observed.length).toBeGreaterThan(0);
    for (const reason of observed) {
      expect(CREATION_DEFAULT_SKIP_REASONS).toContain(reason);
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 10 · THE WHOLE ASSERTION SET, GREEN — and complete
// ═══════════════════════════════════════════════════════════════════════════

describe('10 · R-11-v1 and R-7, as one set', () => {
  it('every named assertion the drill owes is present', () => {
    // A case silently dropped would otherwise leave its assertion absent rather
    // than red, and an absent assertion is not a pass.
    const names = Object.keys(assertionSet({
      cases: CASES, schema: { provenanceCheckDefs: [], originGroupOnly: true, nonManualRows: [] },
      serialisation: SERIALISATION, allGrantRows: [],
    })).sort();
    expect(names).toEqual([...REQUIRED_ASSERTIONS].sort());
  });

  it('and every one of them is GREEN against the live measurements', async () => {
    const input: DrillInput = {
      cases: CASES,
      schema: await schemaObservation(),
      serialisation: SERIALISATION,
      allGrantRows: await everyGrantRow(),
    };
    const failures = Object.entries(assertionSet(input) as Record<string, string[]>)
      .filter(([, list]) => list.length > 0);
    // Named, not counted: a failure has to say WHICH assertion and WHY.
    expect(failures).toEqual([]);
  });
});

describe('11 · round-three home-pointer closure', () => {
  it('an operator login cannot set another Account home pointer', async () => {
    const operator = await sessionFor('operator', await makeAccount('operator', 'operator'), ['principals:admin']);
    const account = await makeAccount('user', 'operator-target');
    await addMember(HOME_GROUP, account);
    const target = await sessionFor('operator-target', account, ['projects:read']);
    const before = await call(target, 'GET', '/principals/me/home-group');
    expect(before.status).toBe(200);
    const refused = await call(operator, 'PUT', `/principals/${account}/home-group`, { groupId: HOME_GROUP });
    expect(refused.status).toBe(403);
    expect(refused.json.code).toBe('ROOT_SESSION_REQUIRED');
    const after = await call(target, 'GET', '/principals/me/home-group');
    expect(after.status).toBe(200);
    expect(after.json).toEqual(before.json);
  });

  it('an inactive target is refused even for a root session', async () => {
    const account = await makeAccount('user', 'inactive-target');
    await addMember(HOME_GROUP, account);
    expect((await call(ROOT, 'POST', `/principals/${account}/terminate`)).status).toBe(200);
    const answer = await call(ROOT, 'PUT', `/principals/${account}/home-group`, { groupId: HOME_GROUP });
    expect(answer.status).toBe(422);
    expect(answer.json.code).toBe('HOME_GROUP_ACCOUNT_INACTIVE');
    expect((await pool.query('SELECT 1 FROM account_home_groups WHERE account_principal_id = $1', [account])).rows).toHaveLength(0);
  });

  it.each(['set', 'terminate'] as const)('%s commits first: the production acts leave no offboarded pointer', async (first) => {
    const account = await makeAccount('user', 'set-terminate');
    await addMember(HOME_GROUP, account);
    const { auditService } = require('../services/AuditService');
    const original = auditService.record.bind(auditService);
    let enter!: () => void;
    let release!: () => void;
    let holderPid: number | null = null;
    const entered = new Promise<void>((resolve) => { enter = resolve; });
    const released = new Promise<void>((resolve) => { release = resolve; });
    const action = first === 'set' ? 'home_group.set' : 'principal.terminate';
    const spy = jest.spyOn(auditService, 'record').mockImplementation(async (...args: any[]) => {
      const [event, client] = args;
      const result = await original(...args);
      if (client && holderPid === null && event.action === action && event.resourceId === account && event.outcome !== 'denied') {
        holderPid = client.processID;
        enter();
        await released;
      }
      return result;
    });
    const set = () => call(ROOT, 'PUT', `/principals/${account}/home-group`, { groupId: HOME_GROUP });
    const terminate = () => call(ROOT, 'POST', `/principals/${account}/terminate`);
    const pending: Promise<Answer>[] = [];
    let timer: NodeJS.Timeout | undefined;
    try {
      pending.push(first === 'set' ? set() : terminate());
      await Promise.race([entered, new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('Production act did not reach its transaction audit barrier')), 10_000);
      })]);
      clearTimeout(timer);
      pending.push(first === 'set' ? terminate() : set());
      let blockedAtPrincipal = false;
      const deadline = Date.now() + 5000;
      // Inspect the actual competing SQL, not merely an unfinished HTTP request:
      // a missing principal lock could instead leave termination at pointer DELETE.
      while (Date.now() < deadline) {
        const waiting = await pool.query(
          'SELECT query FROM pg_stat_activity WHERE $1 = ANY(pg_blocking_pids(pid))', [holderPid]);
        blockedAtPrincipal = waiting.rows.some((row: any) => first === 'set'
          ? /^\s*UPDATE principals\s+SET status/.test(row.query)
          : /^SELECT id, status FROM principals WHERE id = \$1 FOR SHARE/.test(row.query));
        if (blockedAtPrincipal) break;
        await new Promise((resolve) => setTimeout(resolve, 30));
      }
      expect(blockedAtPrincipal).toBe(true);
      release();
      const [a, b] = await Promise.all(pending);
      expect(a.status).toBe(200);
      expect(b.status).toBe(first === 'set' ? 200 : 422);
      if (first === 'terminate') expect(b.json.code).toBe('HOME_GROUP_ACCOUNT_INACTIVE');
      // A terminated Account cannot use the self point route. Check stored
      // offboarding state directly; no administrator home-group GET exists.
      expect((await pool.query('SELECT status FROM principals WHERE id = $1', [account])).rows[0].status).toBe('terminated');
      expect((await pool.query('SELECT 1 FROM account_home_groups WHERE account_principal_id = $1', [account])).rows).toHaveLength(0);
    } finally {
      clearTimeout(timer);
      release();
      await Promise.allSettled(pending);
      spy.mockRestore();
    }
  });

  it.each(['absent', 'unvalidated', 'same-literal-narrowed', 'same-literal-widened', 'third-literal-widened', 'missing-literal-narrowed', 'extra-same-literal-check'] as const)('migration refuses an %s provenance constraint', async (state) => {
    const fs = require('fs');
    const path = require('path');
    const migration = fs.readFileSync(path.join(__dirname, '../migrations/128_lenses_featured_home_group_grant_origin.sql'), 'utf8');
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('ALTER TABLE grants DROP CONSTRAINT grants_provenance_shape');
      const canonical = "provenance IS NULL OR provenance IN ('assignment:grant', 'assignment:warrant')";
      const changed: Record<string, string> = {
        'same-literal-narrowed': "provenance IS NULL OR (provenance IN ('assignment:grant','assignment:warrant') AND provenance <> 'assignment:warrant')",
        'same-literal-widened': "provenance IS NULL OR provenance NOT IN ('assignment:grant','assignment:warrant')",
        'third-literal-widened': "provenance IS NULL OR provenance IN ('assignment:grant','assignment:warrant','unexpected')",
        'missing-literal-narrowed': "provenance IS NULL OR provenance IN ('assignment:grant')",
      };
      // These are schema predicates on an empty transactional fixture. A row
      // validation failure while installing the mutant must not count as the
      // migration's own named refusal.
      await client.query('DELETE FROM grants');
      if (state !== 'absent') await client.query(`ALTER TABLE grants ADD CONSTRAINT grants_provenance_shape CHECK (${changed[state] || canonical})${state === 'unvalidated' ? ' NOT VALID' : ''}`);
      if (state === 'extra-same-literal-check') await client.query(`ALTER TABLE grants ADD CONSTRAINT lenses_extra_provenance CHECK (${changed['same-literal-narrowed']})`);
      const installed = await client.query("SELECT conname, convalidated FROM pg_constraint WHERE conrelid='grants'::regclass AND conname IN ('grants_provenance_shape','lenses_extra_provenance') ORDER BY conname");
      expect(installed.rows).toHaveLength(state === 'absent' ? 0 : state === 'extra-same-literal-check' ? 2 : 1);
      if (state !== 'absent') expect(installed.rows.find((row: {conname:string}) => row.conname === 'grants_provenance_shape').convalidated).toBe(state !== 'unvalidated');
      await expect(client.query(migration)).rejects.toThrow('128: postcondition failed');
    } finally {
      try { await client.query('ROLLBACK'); } finally { client.release(); }
    }
  });

  it('migration accepts the canonical provenance expression twice and leaves no temporary reference', async () => {
    const fs = require('fs'); const path = require('path');
    const migration = fs.readFileSync(path.join(__dirname, '../migrations/128_lenses_featured_home_group_grant_origin.sql'), 'utf8');
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const before = (await client.query("SELECT pg_get_expr(conbin, conrelid, false) AS expression FROM pg_constraint WHERE conrelid='grants'::regclass AND conname='grants_provenance_shape'")).rows;
      await client.query(migration); await client.query(migration);
      const after = (await client.query("SELECT pg_get_expr(conbin, conrelid, false) AS expression FROM pg_constraint WHERE conrelid='grants'::regclass AND conname='grants_provenance_shape'")).rows;
      expect(after).toEqual(before);
      expect((await client.query("SELECT to_regclass('pg_temp.rh_lenses128_provenance_contract') AS reference")).rows[0].reference).toBeNull();
    } finally { try { await client.query('ROLLBACK'); } finally { client.release(); } }
  });
});

describe('12 · B-L4 · creation-default Project Grants reach contained Tasks', () => {
  it('B-L4: the home-group member reads and writes a new unrestricted Task, with live revocation and no Task Grant', async () => {
    const creator = await sessionFor('B-L4-root', await makeAccount('admin', 'bl4-root'), ['root']);
    const member = await sessionFor('B-L4-member', await makeAccount('user', 'bl4-member'),
      ['projects:read', 'projects:write', 'tasks:read', 'tasks:write']);
    const stranger = await sessionFor('B-L4-stranger', await makeAccount('user', 'bl4-stranger'),
      ['projects:read', 'projects:write', 'tasks:read', 'tasks:write']);
    const groupId = await makeGroup(`lensb-bl4-${tag()}`, true);
    await addMember(groupId, creator.principalId);
    await addMember(groupId, member.principalId);
    await setPointer(creator.principalId, groupId);
    const { answer, projectId } = await createProject(creator);
    expect(answer.status).toBe(201);
    expect(projectId).not.toBeNull();
    const created = await call(creator, 'POST', '/tasks', { title: `lensb-bl4-${tag()}`, project: projectId });
    expect(created.status).toBe(201);
    const taskId = String(created.json.task.id);
    const taskBefore = (await pool.query('SELECT owner_principal_id, visibility, restricted_access FROM tasks WHERE id=$1', [taskId])).rows[0];
    expect(taskBefore.visibility).toBe('private');
    expect(taskBefore.restricted_access).toBe(false);
    const defaults = (await pool.query(`SELECT id, verb, grantee_type, grantee_id FROM grants
      WHERE resource_type='project' AND resource_id=$1 AND origin='creation-default' ORDER BY verb`, [projectId])).rows;
    expect(defaults.map((row: any) => row.verb)).toEqual(['read', 'write']);
    expect(defaults.every((row: any) => row.grantee_type === 'group' && row.grantee_id === groupId)).toBe(true);
    expect((await call(member, 'GET', `/projects/${projectId}`)).status).toBe(200);
    expect((await call(stranger, 'GET', `/projects/${projectId}`)).status).toBe(404);
    expect((await call(member, 'GET', `/tasks/${taskId}`)).status).toBe(200);
    expect((await call(stranger, 'GET', `/tasks/${taskId}`)).status).toBe(404);
    expect((await call(member, 'PATCH', `/tasks/${taskId}`, { title: 'B-L4 member edit' })).status).toBe(200);
    expect((await call(stranger, 'PATCH', `/tasks/${taskId}`, { title: 'B-L4 concealed stranger edit' })).status).toBe(404);
    expect((await pool.query('SELECT owner_principal_id, title FROM tasks WHERE id=$1', [taskId])).rows[0])
      .toEqual({ owner_principal_id: taskBefore.owner_principal_id, title: 'B-L4 member edit' });
    expect((await pool.query("SELECT id FROM grants WHERE resource_type='task' AND resource_id=$1", [taskId])).rows).toEqual([]);
    // Revocation is a database input, and the next ordinary point/write calls
    // prove that no materialized Task authority survives the Project source.
    await pool.query('DELETE FROM grants WHERE id=$1', [defaults.find((row: any) => row.verb === 'write').id]);
    expect((await call(member, 'GET', `/tasks/${taskId}`)).status).toBe(200);
    expect((await call(member, 'PATCH', `/tasks/${taskId}`, { title: 'B-L4 revoked write' })).status).toBe(403);
    await pool.query('DELETE FROM grants WHERE id=$1', [defaults.find((row: any) => row.verb === 'read').id]);
    expect((await call(member, 'GET', `/tasks/${taskId}`)).status).toBe(404);
    expect((await call(member, 'PATCH', `/tasks/${taskId}`, { title: 'B-L4 revoked read' })).status).toBe(404);
  });
});
