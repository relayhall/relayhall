/**
 * RH-LENSES-a (card `74e02a05`) — THE CARRIAGE SEAM, LIVE.
 *
 * Controls `R-1`, `R-2`, `R-4`, `R-10`, `R-12`; acceptance `A-L1`…`A-L7`,
 * `A-L10`…`A-L18`, `A-L31`…`A-L33`, `A-L35-v1`, `A-L44`…`A-L46`.
 *
 * ── WHY IT IS NOT IN THE DEFAULT JEST RUN ────────────────────────────────
 *
 * Every claim here is about what happens to ROWS, under LOCKS, in
 * TRANSACTIONS. A mocked pool answers what it was told to answer and has no
 * advisory locks, no deadlock detector and no CHECK constraints, so a suite
 * built on one would be measuring its own fixtures. It connects to
 * `RELAYHALL_TEST_DB_URL` and **FAILS — never skips — when the variable is
 * unset**, runs from `npm run test:carriage` on the VM gate chain and
 * UNCONDITIONALLY in CI against the `services: postgres` block, with no `if:`
 * guard.
 *
 * ── THE DESTRUCTIVE CONTRACT, STATED ─────────────────────────────────────
 *
 * This suite WRITES to `principals`, `identity_providers`, `groups`,
 * `group_members`, `directory_group_references`,
 * `account_directory_group_references`, `directory_provisioned_accounts`,
 * `directory_sync_state`, `services`, `principal_credentials`, `auth_sessions`
 * and `audit_events`, and it DELETES an Identity provider. It refuses any URL
 * naming a deployment database. Bring the database up with `database/init.sql`
 * and `npm run migrate`, and throw it away afterwards.
 *
 * ── WHERE THE ORACLE COMES FROM ──────────────────────────────────────────
 *
 * `I-L1` is measured against a **schema-wide query written independently of
 * the service** — a join from carriage to references to Groups on the
 * byte-exact pair, taken over the whole database rather than over a list this
 * suite maintains. Nothing here recomputes the service's logic; both sides are
 * measured, and the oracle is the SCHEMA's own answer to *"who should be a
 * derived member?"*.
 *
 * ── ONE STATED GAP, NAMED RATHER THAN HIDDEN ─────────────────────────────
 *
 * `R-4` asks for the claim producer to be driven through **a real SSO
 * callback**. That needs a live Identity provider and a browser; the estate's
 * SSO login drill is a Playwright script against a deployed board
 * (`scripts/sso-login-live-drill.mjs`) and cannot run in CI. So the SCIM
 * producer and the binding act ARE driven over real HTTP through the
 * production router, and the CLAIM producer is driven at
 * `DirectoryCarriageService.applyAccountCarriage` — the exact entry point the
 * SSO path calls — with `theClaimCallSite` below binding that call site to it
 * over the SOURCE, including the fact that the FULL claim goes in and not the
 * bound subset. The gap is that no assertion here crosses the OIDC boundary
 * itself; it is recorded in this card's handover as a stated limitation rather
 * than papered over.
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
    'RELAYHALL_TEST_DB_URL is not set. This gate measures rows, locks and transactions against a '
    + 'REAL PostgreSQL and refuses to skip: a mocked pool has no advisory locks, no deadlock '
    + 'detector and no CHECK constraints. Create a disposable database, load database/init.sql, run '
    + 'npm run migrate, and set RELAYHALL_TEST_DB_URL to it.',
  );
}

const parsed = new URL(TEST_DB_URL);
const TEST_DB_NAME = parsed.pathname.replace(/^\//, '');
const FORBIDDEN_DATABASES = ['relayhall_dev', 'relayhall_tst', 'relayhall_prod', 'relayhall'];
if (FORBIDDEN_DATABASES.includes(TEST_DB_NAME)) {
  throw new Error(`RELAYHALL_TEST_DB_URL names a deployment database (${TEST_DB_NAME}). This suite writes and deletes; point it at a disposable database.`);
}

// The production pool reads DB_* at import time, so the environment is pinned
// BEFORE anything is required — which is why everything below uses `require`.
process.env.DB_HOST = parsed.hostname;
process.env.DB_PORT = parsed.port || '5432';
process.env.DB_NAME = TEST_DB_NAME;
process.env.DB_USER = decodeURIComponent(parsed.username);
process.env.DB_PASSWORD = decodeURIComponent(parsed.password);
process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'carriage-suite-secret-0123456789abcdef';
process.env.RELAYHALL_SESSIONS = 'on';
/** The legacy service key: a ROOT-scoped-by-name machine credential that is
 *  NOT a login session, which is the caller DBD-14's projection must answer
 *  with an empty list however it is scoped. */
process.env.RELAYHALL_API_KEY = process.env.RELAYHALL_API_KEY || `carriage-suite-${crypto.randomBytes(16).toString('hex')}`;

const express = require('express');
const { Client } = require('pg');

const { pool } = require('../db/connection');
const { registerProtectedRoutes } = require('../routeRegistry');
const { authMiddleware } = require('../middleware/auth');
const { sharedAuthorizationMiddleware } = require('../middleware/sharedAuthorization');
const { apiErrorHandler } = require('../utils/apiErrors');
const { jsonBodyOptions } = require('../utils/jsonBodyTypes');
const { loginSessionService, SESSION_COOKIE_NAME } = require('../services/LoginSessionService');
const { directoryCarriageService, carriageLockKey } = require('../services/DirectoryCarriageService');
const { groupService } = require('../services/GroupService');
const { readGroupClaim } = require('../services/identity/ssoGroupClaims');
const { principalService } = require('../services/PrincipalService');

jest.setTimeout(300_000);

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

interface Answer { status: number; json: any; text: string; contentType: string | null }
interface Caller { label: string; principalId: string; headers: Record<string, string> }

async function call(who: Caller, method: string, routePath: string, body?: unknown): Promise<Answer> {
  const response = await fetch(`${origin}${routePath}`, {
    method,
    // `Connection: close` because `server.close()` WAITS for keep-alive
    // sockets, and a suite that hangs at teardown reports nothing at all --
    // indistinguishable, from the outside, from a suite that found a defect
    // and could not say so.
    headers: { 'Content-Type': 'application/json', Connection: 'close', ...who.headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  let json: any = null;
  try { json = JSON.parse(text); } catch { json = null; }
  return { status: response.status, json, text, contentType: response.headers.get('content-type') };
}

// ────────────────────────────── the fixtures ─────────────────────────────────

const SYSTEM_ACTOR = { principalId: null, handle: 'carriage-suite', authMethod: 'system' as const };
const tag = (): string => crypto.randomBytes(6).toString('hex');

let PROVIDER_ID: string;
/** An administrator on a LOGIN SESSION: the one caller DBD-14's v1 projection
 *  answers with the whole store. */
let ROOT: Caller;
/** An ordinary Account on a login session. */
let MEMBER: Caller;
/** The legacy service key — authenticated, NOT a login session. */
let MACHINE: Caller;
/** The Identity provider's SCIM client: a real registry Connector presenting a
 *  real `rh_` credential, resolved to the provider the way production does. */
let SCIM: Caller;

async function makeAccount(role: string, prefix = 'carriage'): Promise<string> {
  const handle = `${prefix}-${role}-${tag()}`;
  const result = await pool.query(
    `INSERT INTO principals (kind, handle, display_name, status, role)
     VALUES ('human', $1, $2, 'active', $3) RETURNING id`,
    [handle, `carriage ${handle}`, role],
  );
  return String(result.rows[0].id);
}

async function sessionFor(label: string, principalId: string): Promise<Caller> {
  const minted = await loginSessionService.mint({ principalId });
  return { label, principalId, headers: { Cookie: `${SESSION_COOKIE_NAME}=${minted.token}` } };
}

/** An Account this Identity provider provisioned — the only thing a SCIM
 *  `members[].value` may name (NG-4). */
async function provisionedAccount(prefix: string): Promise<string> {
  const id = await makeAccount('user', prefix);
  await pool.query(
    `INSERT INTO directory_provisioned_accounts (account_principal_id, identity_provider_id, external_id, user_name)
     VALUES ($1, $2, $3, $4)`,
    [id, PROVIDER_ID, `ext-${tag()}`, `un-${tag()}`],
  );
  return id;
}

// ───────────────────────── the oracle: I-L1, schema-wide ─────────────────────

/**
 * What derived membership SHOULD be, computed from the schema and not from the
 * service: every (Account, Group) pair reachable by joining carriage to its
 * reference and the reference to a Group on the byte-exact
 * (provider, ref) pair.
 *
 * It ranges over the WHOLE database rather than over a fixture list, so a row
 * this suite never created still has to satisfy it.
 */
async function expectedImage(): Promise<string[]> {
  const result = await pool.query(
    `SELECT DISTINCT adgr.account_principal_id || ':' || g.id AS pair
       FROM account_directory_group_references adgr
       JOIN directory_group_references dgr ON dgr.id = adgr.directory_group_reference_id
       JOIN groups g
         ON g.identity_provider_id = dgr.identity_provider_id
        AND g.external_group_ref = dgr.external_group_ref
      ORDER BY 1`,
  );
  return result.rows.map((row: any) => String(row.pair));
}

async function actualImage(): Promise<string[]> {
  const result = await pool.query(
    `SELECT DISTINCT account_principal_id || ':' || group_id AS pair
       FROM group_members WHERE source = 'directory' ORDER BY 1`,
  );
  return result.rows.map((row: any) => String(row.pair));
}

/**
 * `R-1` — carriage is not membership, and derived membership is a FUNCTION of
 * carriage at every writer, with no drift in either direction.
 *
 * Called after every write path in this file. A drift in one direction is an
 * Account holding authority no directory gave it; in the other, a person whose
 * directory group reaches nothing.
 */
async function assertImageHolds(where: string): Promise<void> {
  const [expected, actual] = await Promise.all([expectedImage(), actualImage()]);
  expect({ where, image: actual }).toEqual({ where, image: expected });
}

async function watermark(): Promise<string | null> {
  const result = await pool.query(
    'SELECT last_success_at FROM directory_sync_state WHERE provider = $1', [PROVIDER_ID],
  );
  // ISO, not `String(aDate)`: the default rendering is whole SECONDS, so two
  // writes inside one second read as one value and this control would pass
  // over a watermark that never moved.
  return result.rows.length === 0 ? null : new Date(result.rows[0].last_success_at).toISOString();
}

async function membersOfGroup(groupId: string): Promise<string[]> {
  const result = await pool.query(
    "SELECT account_principal_id FROM group_members WHERE group_id = $1 AND source = 'directory' ORDER BY 1",
    [groupId],
  );
  return result.rows.map((row: any) => String(row.account_principal_id));
}

/** Bind through the same carriage act used by the root catalog. */
async function boundGroup(name: string, ref: string): Promise<string> {
  const reference = await directoryCarriageService.recordReference(PROVIDER_ID, ref, SYSTEM_ACTOR);
  const bound = await directoryCarriageService.bindReferenceToGroup(reference.id,
    { name: `${name} ${tag()}` }, SYSTEM_ACTOR);
  return bound.groupId;
}

async function carriageRefs(accountPrincipalId: string, source?: string): Promise<string[]> {
  const result = await pool.query(
    `SELECT dgr.external_group_ref AS ref
       FROM account_directory_group_references adgr
       JOIN directory_group_references dgr ON dgr.id = adgr.directory_group_reference_id
      WHERE adgr.account_principal_id = $1
        AND ($2::text IS NULL OR adgr.source = $2)
      ORDER BY 1`,
    [accountPrincipalId, source ?? null],
  );
  // Sorted in JAVASCRIPT, not left in the database's order: PostgreSQL
  // orders by the cluster collation and JavaScript by UTF-16 code units,
  // and for precisely the case/whitespace/NFD variants R-2 draws, the two
  // disagree -- so a passing comparison would depend on the collation of
  // whatever database this ran against.
  return result.rows.map((row: any) => String(row.ref)).sort();
}

async function referenceIdFor(ref: string): Promise<string | null> {
  const result = await pool.query(
    'SELECT id FROM directory_group_references WHERE identity_provider_id = $1 AND external_group_ref = $2',
    [PROVIDER_ID, ref],
  );
  return result.rows.length === 0 ? null : String(result.rows[0].id);
}

// ────────────────────────────────── setup ────────────────────────────────────

beforeAll(async () => {
  await new Promise<void>((resolve) => {
    server = buildApp().listen(0, '127.0.0.1', () => {
      const address = server.address() as any;
      origin = `http://127.0.0.1:${address.port}`;
      resolve();
    });
  });

  // ONE active Identity provider: `ux_identity_providers_single_active`
  // (104:184-189) enforces SS-14a, and the account-scoped removal loop this
  // design composes with is sound only under it (DBD-4).
  await pool.query("UPDATE identity_providers SET status = 'disabled' WHERE status = 'active'");
  const providerRow = await pool.query(
    `INSERT INTO identity_providers
       (name, status, issuer, discovery_url, client_id, subject_immutable, group_binding_mode, groups_claim)
     VALUES ($1, 'active', $2, $3, 'carriage-suite', TRUE, 'claim', 'groups') RETURNING id`,
    [`carriage ${tag()}`, `https://issuer.invalid/${tag()}`, `https://issuer.invalid/${tag()}/.well-known/openid-configuration`],
  );
  PROVIDER_ID = String(providerRow.rows[0].id);

  const rootId = await makeAccount('admin');
  ROOT = await sessionFor('root session', rootId);
  MEMBER = await sessionFor('member session', await makeAccount('user'));
  MACHINE = {
    label: 'legacy service key',
    principalId: '',
    headers: { 'x-api-key': String(process.env.RELAYHALL_API_KEY) },
  };

  // The SCIM client, in the shape A17.2 and A24 require and the estate
  // enforces: a PARENTLESS SERVICE Account, a Connector principal beneath
  // it, and a `services` registry row of kind `connector` naming that
  // principal. `setScimClient` refuses a human Account by name, and it asks
  // the registry through the SAME predicate the act-time rule uses -- so a
  // fixture that skipped the registry row would be refused here rather than
  // quietly proving something weaker.
  const scimAccount = await pool.query(
    // 'service' is a KIND, not a role: `principals_role_check` admits nine
    // values and 'service' is not among them. The role still has to be a
    // WRITING one, because the Connector beneath this Account declares
    // `scopes: 'parent'` -- a ROLE-LESS Account derives the empty scope set,
    // so its Connector would hold nothing and every SCIM call would answer 403
    // at the route ceiling before a handler ever ran.
    `INSERT INTO principals (kind, handle, display_name, status, role)
     VALUES ('service', $1, 'carriage scim account', 'active', 'editor') RETURNING id`,
    [`carriage-scim-account-${tag()}`],
  );
  const scimAccountId = String(scimAccount.rows[0].id);
  const scimConnector = await pool.query(
    `INSERT INTO principals (kind, handle, display_name, status, parent_principal_id, purpose, own_expression)
     VALUES ('service', $1, 'carriage scim connector', 'active', $2, $3, $4::jsonb) RETURNING id`,
    [`carriage-scim-connector-${tag()}`, scimAccountId, 'carriage suite SCIM client',
      JSON.stringify({ scopes: 'parent', objects: 'parent' })],
  );
  const scimConnectorId = String(scimConnector.rows[0].id);
  const slug = `carriage-scim-${tag()}`;
  await pool.query(
    `INSERT INTO services (slug, name, description, kind, status, principal_id)
     VALUES ($1, $1, 'carriage suite SCIM client', 'connector', 'published', $2)`,
    [slug, scimConnectorId],
  );
  const issued = await principalService.issueCredential(
    { principalId: scimConnectorId, scopes: ['directory-provisioning:write'], transport: 'any' },
    SYSTEM_ACTOR,
  );
  SCIM = {
    label: 'scim connector',
    principalId: scimConnectorId,
    headers: { Authorization: `Bearer ${issued.fullKey}` },
  };
  // The binding IS the switch: an owner naming a SCIM client for an Identity
  // provider is the owner enabling SCIM for it.
  const bound = await call(ROOT, 'PUT', `/identity-providers/${PROVIDER_ID}/scim-client`,
    { principalId: scimAccountId });
  expect({ status: bound.status, body: bound.text.slice(0, 300) })
    .toEqual({ status: 200, body: bound.text.slice(0, 300) });
});

// Each assertion owns its fixtures. Clean only after its verdict, so a red
// mutation cannot leave residue that masquerades as another control failure.
afterEach(async () => {
  await pool.query('TRUNCATE account_directory_group_references, directory_group_references, '
    + 'group_members, groups, directory_sync_state CASCADE');
});

afterAll(async () => {
  // Both halves are BOUNDED. A teardown that can block forever turns any
  // failure in this file into a timeout with no output at all.
  (server as any).closeAllConnections?.();
  await Promise.race([
    new Promise<void>((resolve) => server.close(() => resolve())),
    new Promise<void>((resolve) => setTimeout(resolve, 5000)),
  ]);
  await Promise.race([
    pool.end(),
    new Promise<void>((resolve) => setTimeout(resolve, 5000)),
  ]);
});

// ═══════════════════════ 1. the claim producer ═══════════════════════════════

describe('A-L1…A-L4 — the claim producer records CARRIAGE and derives membership', () => {
  it('A-L1: three values, one bound -> one membership row and THREE carriage rows', async () => {
    const account = await makeAccount('user');
    const refs = [`c1-${tag()}`, `c2-${tag()}`, `c3-${tag()}`];
    const group = await boundGroup('A-L1', refs[1]);

    await directoryCarriageService.applyAccountCarriage(PROVIDER_ID, account, refs, 'claim', SYSTEM_ACTOR);

    // THREE carriage rows: a value that binds nothing today is exactly what the
    // catalog exists to show an administrator, and it is why *Use this group*
    // can populate a Group at once instead of at everyone's next login.
    expect(await carriageRefs(account, 'claim')).toEqual([...refs].sort());
    expect(await membersOfGroup(group)).toEqual([account]);
    await assertImageHolds('A-L1');
  });

  it('A-L2: removing the middle value leaves two carriage rows and RETAINS the reference', async () => {
    const account = await makeAccount('user');
    const refs = [`d1-${tag()}`, `d2-${tag()}`, `d3-${tag()}`];
    const group = await boundGroup('A-L2', refs[0]);
    await directoryCarriageService.applyAccountCarriage(PROVIDER_ID, account, refs, 'claim', SYSTEM_ACTOR);

    await directoryCarriageService.applyAccountCarriage(
      PROVIDER_ID, account, [refs[0], refs[2]], 'claim', SYSTEM_ACTOR,
    );
    expect(await carriageRefs(account, 'claim')).toEqual([refs[0], refs[2]].sort());
    // THE ORPHAN IS RETAINED. A catalog that forgets a group the moment its
    // last member leaves cannot answer "is this the group I bound last month?".
    expect(await referenceIdFor(refs[1])).not.toBeNull();
    expect(await membersOfGroup(group)).toEqual([account]);
    await assertImageHolds('A-L2');
  });

  it('A-L4: an EMPTY claim clears claim carriage and leaves SCIM carriage untouched', async () => {
    const account = await provisionedAccount('empty');
    const shared = `e-shared-${tag()}`;
    const claimOnly = `e-claim-${tag()}`;
    const group = await boundGroup('A-L4', shared);

    await directoryCarriageService.applyReferenceCarriage(
      PROVIDER_ID, shared, [account], 'scim', SYSTEM_ACTOR,
    );
    await directoryCarriageService.applyAccountCarriage(
      PROVIDER_ID, account, [shared, claimOnly], 'claim', SYSTEM_ACTOR,
    );
    expect(await carriageRefs(account)).toEqual([claimOnly, shared, shared].sort());

    await directoryCarriageService.applyAccountCarriage(PROVIDER_ID, account, [], 'claim', SYSTEM_ACTOR);
    // `source` is part of the primary key, so the two producers replace
    // DISJOINT row sets: a login never deletes what a push observed.
    expect(await carriageRefs(account, 'claim')).toEqual([]);
    expect(await carriageRefs(account, 'scim')).toEqual([shared]);
    // And the derived membership survives, because the SCIM carriage does.
    expect(await membersOfGroup(group)).toEqual([account]);
    await assertImageHolds('A-L4');
  });

  it('A-L3 / A-L5: an overage, unparseable or absent claim never reaches the seam', async () => {
    // The verdict is the boundary. SS-13's fail-closed rule lives in the guard
    // on the caller's `if`, so these three write no carriage, delete no
    // carriage and move no watermark — measured as the VERDICT, because that
    // is what the guard reads.
    expect(readGroupClaim({}, 'groups').verdict).toBe('claim_absent');
    expect(readGroupClaim({ groups: 42 }, 'groups').verdict).toBe('unparseable');
    expect(readGroupClaim({ groups: ['a', ''] }, 'groups').verdict).toBe('unparseable');
    expect(readGroupClaim({ _claim_names: { groups: 'src1' }, groups: ['a'] }, 'groups').verdict).toBe('overage');
    // A-L5: an oversized claim takes the EXISTING overage path — same verdict,
    // same behaviour, NO new refusal code.
    const oversized = Array.from({ length: 4 }, (_value, index) => `o${index}`);
    expect(readGroupClaim({ groups: oversized }, 'groups', 3).verdict).toBe('overage');
    expect(readGroupClaim({ groups: oversized }, 'groups', 4).verdict).toBe('claim_present');
  });

  it('the SSO call site hands the seam the FULL claim, inside the claim_present guard', () => {
    // `theClaimCallSite`: the one binding between this suite and the OIDC
    // boundary it cannot cross in CI. It asserts the three things a rewrite
    // could get wrong -- that the producer is called at all, that it is called
    // with the WHOLE claim rather than the bound subset, and that it is inside
    // the fail-closed guard.
    const source = fs.readFileSync(
      path.resolve(__dirname, '..', 'services', 'identity', 'SsoAuthenticationService.ts'), 'utf8',
    );
    const guard = source.indexOf("groupClaim.verdict === 'claim_present'");
    const producer = source.indexOf('directoryCarriageService.applyAccountCarriage(');
    expect(guard).toBeGreaterThanOrEqual(0);
    expect(producer).toBeGreaterThan(guard);
    const callText = source.slice(producer, producer + 400);
    expect(callText).toContain('groupClaim.values');
    expect(callText).toContain("'claim'");
    // And no second membership writer survives beside it: the file may still
    // DESCRIBE the account-scoped seam in prose -- it is the seam the carriage
    // service now calls -- but it must no longer CALL it.
    expect(source).not.toContain('groupService.applyAccountDirectorySnapshot(');
  });
});

// ═══════════════════ 2. R-2 — nothing normalises ═════════════════════════════

describe('R-2 / A-L6 — an opaque provider value is opaque, at the BOUNDARY', () => {
  it('refs differing by case, whitespace, a trailing slash or NFC/NFD are DISTINCT', async () => {
    const stem = `n-${tag()}`;
    // Drawn to include the pairs a "helpful" normaliser folds: case, a
    // trailing slash, surrounding whitespace, and the two Unicode
    // normalisation forms of one visible string. `café` in NFC is 5 code
    // points; in NFD it is 6. They look identical and are different bytes.
    const variants = [
      `${stem}/eng`,
      `${stem}/ENG`,
      `${stem}/eng/`,
      ` ${stem}/eng`,
      `${stem}/café`,
      `${stem}/café`,
    ];
    const account = await makeAccount('user');
    await directoryCarriageService.applyAccountCarriage(
      PROVIDER_ID, account, variants, 'claim', SYSTEM_ACTOR,
    );
    const stored = await carriageRefs(account, 'claim');
    expect(stored).toEqual([...variants].sort());
    expect(new Set(stored).size).toBe(variants.length);

    // AND THEY BIND DISTINCTLY. A Group bound to one variant receives the
    // Account through that variant only — the join is byte-exact, so a
    // normalising build would bind all six and this assertion is where it
    // would show.
    const group = await boundGroup('R-2', variants[0]);
    await directoryCarriageService.applyAccountCarriage(
      PROVIDER_ID, account, variants, 'claim', SYSTEM_ACTOR,
    );
    expect(await membersOfGroup(group)).toEqual([account]);
    const other = await boundGroup('R-2 other', `${stem}/nobody`);
    expect(await membersOfGroup(other)).toEqual([]);
    await assertImageHolds('R-2 variants');
  });

  it('draws the 1024-OCTET boundary, not a sample from the interior', async () => {
    // A propagation proof that samples the interior is satisfied by a constant
    // or a clamp. The bound is on OCTETS, so the multi-byte case is drawn too:
    // 512 two-byte code points are 1024 octets and 512 characters.
    const account = await makeAccount('user');
    const filler = (n: number) => 'a'.repeat(n);
    const at = `${filler(1024)}`;
    const over = `${filler(1025)}`;
    const multiByteAt = 'é'.repeat(512);
    const multiByteOver = 'é'.repeat(513);

    for (const admitted of [at, multiByteAt]) {
      await directoryCarriageService.applyAccountCarriage(
        PROVIDER_ID, account, [admitted], 'claim', SYSTEM_ACTOR,
      );
      expect(await referenceIdFor(admitted)).not.toBeNull();
    }
    for (const refused of [over, multiByteOver]) {
      await expect(directoryCarriageService.applyAccountCarriage(
        PROVIDER_ID, account, [refused], 'claim', SYSTEM_ACTOR,
      )).rejects.toMatchObject({ code: 'INVALID_DIRECTORY_GROUP_REF' });
      expect(await referenceIdFor(refused)).toBeNull();
    }
    // The empty ref is refused too: an empty string would bind on every
    // Identity provider that omits the claim value.
    await expect(directoryCarriageService.applyAccountCarriage(
      PROVIDER_ID, account, [''], 'claim', SYSTEM_ACTOR,
    )).rejects.toMatchObject({ code: 'INVALID_DIRECTORY_GROUP_REF' });
    await assertImageHolds('R-2 boundary');
  });

  it('the DATABASE refuses the oversized ref too, for a caller writing raw SQL', async () => {
    // The service validator is one half; the CHECK constraint is the other,
    // and either may be removed without the other failing. That is what makes
    // them two halves and not one control counted twice.
    await expect(pool.query(
      'INSERT INTO directory_group_references (identity_provider_id, external_group_ref) VALUES ($1, $2)',
      [PROVIDER_ID, 'b'.repeat(1025)],
    )).rejects.toMatchObject({ code: '23514' });
  });
});

// ═══════════════ 3. atomicity, the seam options and the watermark ════════════

describe('A-L31 / A-L33 / A-L46 / R-12 — the transaction and the watermark', () => {
  it('A-L31: a failed membership write rolls the CARRIAGE back with it', async () => {
    // The failure is made by the SCHEMA, not by a stub: 094's trigger refuses
    // a PARENTED principal as a Group member, so the membership insert raises
    // inside the carriage transaction. A build that wrote carriage in one
    // transaction and membership in another would leave the carriage behind.
    const parent = await makeAccount('user');
    const child = await pool.query(
      `INSERT INTO principals (kind, handle, display_name, status, role, parent_principal_id)
       VALUES ('service', $1, 'child', 'active', NULL, $2) RETURNING id`,
      [`carriage-child-${tag()}`, parent],
    );
    const childId = String(child.rows[0].id);
    const ref = `atomic-${tag()}`;
    await boundGroup('A-L31', ref);

    await expect(directoryCarriageService.applyAccountCarriage(
      PROVIDER_ID, childId, [ref], 'claim', SYSTEM_ACTOR,
    )).rejects.toBeDefined();

    expect(await carriageRefs(childId)).toEqual([]);
    await assertImageHolds('A-L31');
  });

  it('A-L33 / B-L13: the admitted sink shares its transaction and refuses standalone snapshots', async () => {
    const account = await makeAccount('user');
    const ref = `transaction-${tag()}`;
    await directoryCarriageService.applyAccountCarriage(PROVIDER_ID, account, [ref], 'claim', SYSTEM_ACTOR);
    const issued: string[] = [];
    let releases = 0;
    const original = groupService.applyAccountDirectorySnapshot.bind(groupService);
    const spy = jest.spyOn(groupService, 'applyAccountDirectorySnapshot').mockImplementation(async (...args: any[]) => {
      const client = args[4].client;
      const query = client.query;
      const release = client.release;
      client.release = () => { releases += 1; };
      client.query = function(sql: any, ...rest: any[]) {
        issued.push(String(sql).trim());
        return query.call(this, sql, ...rest);
      };
      try { return await original(...args); }
      finally { client.query = query; client.release = release; }
    });
    try {
      await directoryCarriageService.bindReferenceToGroup(await referenceIdFor(ref),
        { name: `transaction ${tag()}` }, SYSTEM_ACTOR);
    } finally { spy.mockRestore(); }
    expect(issued.some(sql => /group_members/.test(sql))).toBe(true);
    expect(releases).toBe(0);
    expect(issued.filter(sql => /^(BEGIN|COMMIT|ROLLBACK)\b/i.test(sql))).toEqual([]);
    await expect(groupService.applyAccountDirectorySnapshot(PROVIDER_ID, account, [], SYSTEM_ACTOR))
      .rejects.toMatchObject({ code: 'DIRECTORY_MEMBERSHIP_MANAGED' });
    const raw = await pool.connect();
    try {
      await raw.query('BEGIN');
      await expect(groupService.applyAccountDirectorySnapshot(PROVIDER_ID, account, [], SYSTEM_ACTOR,
        { client: raw, advanceWatermark: false })).rejects.toMatchObject({ code: 'DIRECTORY_MEMBERSHIP_MANAGED' });
    } finally {
      // A mutation deliberately fails the assertion above. Roll back even
      // then: returning an open transaction can block later fixture cleanup.
      try { await raw.query('ROLLBACK'); }
      finally { raw.release(); }
    }
    await expect(groupService.applyDirectorySnapshot(PROVIDER_ID, [], SYSTEM_ACTOR))
      .rejects.toMatchObject({ code: 'DIRECTORY_MEMBERSHIP_MANAGED' });
    await assertImageHolds('A-L33');
  });

  it('A-L46 / R-12: a bind moves NO watermark; a claim login and a SCIM push do', async () => {
    const account = await provisionedAccount('watermark');
    const ref = `wm-${tag()}`;

    const beforeClaim = await watermark();
    await new Promise((resolve) => setTimeout(resolve, 25));
    await directoryCarriageService.applyAccountCarriage(PROVIDER_ID, account, [ref], 'claim', SYSTEM_ACTOR);
    const afterClaim = await watermark();
    expect(afterClaim).not.toBe(beforeClaim);

    await new Promise((resolve) => setTimeout(resolve, 25));
    await directoryCarriageService.applyReferenceCarriage(PROVIDER_ID, ref, [account], 'scim', SYSTEM_ACTOR);
    const afterPush = await watermark();
    expect(afterPush).not.toBe(afterClaim);

    // THE BIND, AND THE REBIND. A stale retained reference bound by an
    // administrator must not silence the AZ-30 staleness alarm: nothing was
    // received, so nothing about "last successful snapshot" is true.
    const referenceId = await referenceIdFor(ref);
    await new Promise((resolve) => setTimeout(resolve, 25));
    const used = await call(ROOT, 'POST', `/directory-group-references/${referenceId}/use`, {});
    expect(used.status).toBe(201);
    expect(await watermark()).toBe(afterPush);

    // And the housekeeping delete of a DIFFERENT, unbound reference likewise.
    const spare = `wm-spare-${tag()}`;
    await directoryCarriageService.applyAccountCarriage(PROVIDER_ID, account, [ref, spare], 'claim', SYSTEM_ACTOR);
    const spareId = await referenceIdFor(spare);
    const afterSecondClaim = await watermark();
    await new Promise((resolve) => setTimeout(resolve, 25));
    const removed = await call(ROOT, 'DELETE', `/directory-group-references/${spareId}`);
    expect(removed.status).toBe(200);
    expect(await watermark()).toBe(afterSecondClaim);
    await assertImageHolds('A-L46');
  });
});

// ═══════════════════ 4. R-4 — the seam under concurrency ═════════════════════

/** A second connection, outside the pool, so a barrier here cannot be starved
 *  by the pool the service is using. */
async function barrierClient(): Promise<any> {
  const client = new Client({
    host: process.env.DB_HOST,
    port: Number(process.env.DB_PORT),
    database: process.env.DB_NAME,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
  });
  await client.connect();
  return client;
}

const settled = async (promise: Promise<unknown>): Promise<boolean> => {
  const marker = Symbol('pending');
  const outcome = await Promise.race([
    promise.then(() => 'done').catch(() => 'done'),
    new Promise((resolve) => setTimeout(() => resolve(marker), 400)),
  ]);
  return outcome !== marker;
};

describe('R-4 / A-L44 / A-L32 — the lock order, on named barrier schedules', () => {
  it('S1: the DISCOVERY PHANTOM is closed — a bind blocks on the reference lock', async () => {
    // The schedule, exactly as A-L44 names it:
    //   (1) a login takes reference R's lock and inserts previously-absent
    //       carriage for Account A, UNCOMMITTED;
    //   (2) *Use this group* on R starts and BLOCKS on R's reference lock
    //       before it can enumerate carriers;
    //   (3) the login commits;
    //   (4) the bind proceeds, sees A, takes A's lock and recomputes.
    // Asserted with real barriers on two connections, NOT with repetition:
    // ">=50 interleavings" is repetition and not coverage, and a fixture that
    // pre-commits the carriage never reaches the phantom at all.
    const account = await provisionedAccount('phantom');
    const ref = `phantom-${tag()}`;
    // The reference exists and is CARRIED BY NOBODY. That is what makes the
    // window real: a bind starting now would find no carrier.
    await directoryCarriageService.applyReferenceCarriage(PROVIDER_ID, ref, [], 'scim', SYSTEM_ACTOR);
    const referenceId = await referenceIdFor(ref);
    expect(referenceId).not.toBeNull();

    const login = await barrierClient();
    let bind: Promise<Answer>;
    try {
      await login.query('BEGIN');
      await login.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))',
        [carriageLockKey('ref', PROVIDER_ID, ref)]);
      await login.query(
        `INSERT INTO account_directory_group_references
           (directory_group_reference_id, account_principal_id, source)
         VALUES ($1, $2, 'claim')`,
        [referenceId, account],
      );

      bind = call(ROOT, 'POST', `/directory-group-references/${referenceId}/use`, {});
      // (2) It must BLOCK. If it does not, it is enumerating carriers without
      // the lock that makes the enumeration complete, and the phantom is open.
      const completedBeforeCommit = await settled(bind);
      await login.query('COMMIT');
      const used = await bind;
      try {
        expect(completedBeforeCommit).toBe(false);
        expect(used.status).toBe(201);
        expect(used.json.memberCountApplied).toBe(1);
        expect(await membersOfGroup(used.json.groupId)).toEqual([account]);
        await assertImageHolds('S1');
      } finally {
        // Retire this fixture after its assertions, including a red drill.
        // The point under test has already been observed; no later test may
        // inherit a phantom deliberately introduced by this barrier schedule.
        await directoryCarriageService.applyAccountCarriage(PROVIDER_ID, account, [], 'claim', SYSTEM_ACTOR);
      }
    } finally {
      await login.end();
    }

  });

  it('S2: the MIRROR schedule — bind first, then the login — also holds', async () => {
    const account = await provisionedAccount('mirror');
    const ref = `mirror-${tag()}`;
    await directoryCarriageService.applyReferenceCarriage(PROVIDER_ID, ref, [], 'scim', SYSTEM_ACTOR);
    const referenceId = await referenceIdFor(ref);

    const holder = await barrierClient();
    let login: Promise<unknown>;
    try {
      await holder.query('BEGIN');
      await holder.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))',
        [carriageLockKey('ref', PROVIDER_ID, ref)]);
      // The bind is represented by the reference lock a bind would hold; the
      // login must wait for it rather than inserting carriage the bind's
      // already-taken snapshot would miss.
      login = directoryCarriageService.applyAccountCarriage(
        PROVIDER_ID, account, [ref], 'claim', SYSTEM_ACTOR,
      );
      expect(await settled(login)).toBe(false);
      await holder.query('COMMIT');
    } finally {
      await holder.end();
    }
    await login!;
    const used = await call(ROOT, 'POST', `/directory-group-references/${referenceId}/use`, {});
    expect(used.status).toBe(201);
    expect(await membersOfGroup(used.json.groupId)).toEqual([account]);
    await assertImageHolds('S2');
  });

  it('S3 / S4: a SCIM write and a login on one Account serialise on the ACCOUNT lock', async () => {
    const account = await provisionedAccount('serialise');
    const scimRef = `s3-scim-${tag()}`;
    const claimRef = `s3-claim-${tag()}`;
    const holder = await barrierClient();
    let push: Promise<unknown>;
    try {
      await holder.query('BEGIN');
      await holder.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))',
        [carriageLockKey('acct', PROVIDER_ID, account)]);
      push = directoryCarriageService.applyReferenceCarriage(
        PROVIDER_ID, scimRef, [account], 'scim', SYSTEM_ACTOR,
      );
      expect(await settled(push)).toBe(false);
      await holder.query('COMMIT');
    } finally {
      await holder.end();
    }
    await push!;
    await directoryCarriageService.applyAccountCarriage(
      PROVIDER_ID, account, [claimRef], 'claim', SYSTEM_ACTOR,
    );
    // The two producers replace disjoint row sets and the final image is their
    // union, whichever order they landed in.
    expect(await carriageRefs(account)).toEqual([claimRef, scimRef].sort());
    await assertImageHolds('S3/S4');
  });

  it('S5: provider deletion cannot interleave — its provider lock is EXCLUSIVE', async () => {
    // Every carriage and binding act holds the provider key SHARED; the delete
    // holds it EXCLUSIVELY, so the two cannot both proceed. The barrier holds
    // the shared side and the exclusive waiter must block.
    const holder = await barrierClient();
    try {
      await holder.query('BEGIN');
      await holder.query('SELECT pg_advisory_xact_lock_shared(hashtextextended($1, 0))',
        [carriageLockKey('provider', PROVIDER_ID)]);
      const waiter = await barrierClient();
      try {
        const exclusive = waiter.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))',
          [carriageLockKey('provider', PROVIDER_ID)]);
        expect(await settled(exclusive)).toBe(false);
        await holder.query('COMMIT');
        await exclusive;
      } finally {
        await waiter.end();
      }
    } finally {
      await holder.end();
    }
  });

  it('S6: locks taken in ARRIVAL order DEADLOCK — an observable, distinct failure', async () => {
    // The positive half of the lock ORDER, and the reason ascending order is
    // not decoration. A wrong image and a correct one are indistinguishable to
    // a test that only checks the happy path, so the claim is made against the
    // failure mode instead: PostgreSQL's own deadlock detector, error 40P01.
    //
    // The keys come from `carriageLockKey` — the seam's own builder — so a
    // change to the key scheme changes this drill with it rather than leaving
    // it measuring its own arithmetic.
    const first = carriageLockKey('ref', PROVIDER_ID, `dl-a-${tag()}`);
    const second = carriageLockKey('ref', PROVIDER_ID, `dl-b-${tag()}`);
    const left = await barrierClient();
    const right = await barrierClient();
    try {
      await left.query('BEGIN');
      await right.query('BEGIN');
      await left.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [first]);
      await right.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [second]);
      const leftWaits = left.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [second])
        .then(() => null).catch((error: any) => error);
      const rightWaits = right.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [first])
        .then(() => null).catch((error: any) => error);
      const outcomes = await Promise.all([leftWaits, rightWaits]);
      const deadlocks = outcomes.filter((outcome: any) => outcome && outcome.code === '40P01');
      expect(deadlocks.length).toBe(1);
    } finally {
      await left.query('ROLLBACK').catch(() => undefined);
      await right.query('ROLLBACK').catch(() => undefined);
      await left.end();
      await right.end();
    }
  });
});

// ═══════════════════════ 5. SCIM /Groups, over HTTP ══════════════════════════

describe('A-L10…A-L15 — the SCIM Groups rung, through the production router', () => {
  const SCIM_JSON = 'application/scim+json';

  async function scimCall(method: string, routePath: string, body?: unknown): Promise<Answer> {
    return call(SCIM, method, routePath, body);
  }

  it('A-L10: POST creates carriage and derived membership, and NO groups row', async () => {
    const ref = `scim-${tag()}`;
    const account = await provisionedAccount('scim-post');
    const group = await boundGroup('A-L10', ref);
    await directoryCarriageService.deleteReferenceFromDirectory(PROVIDER_ID, await referenceIdFor(ref), SYSTEM_ACTOR);
    const before = await pool.query('SELECT count(*)::int AS n FROM groups');

    const created = await scimCall('POST', '/scim/v2/Groups', {
      schemas: ['urn:ietf:params:scim:schemas:core:2.0:Group'],
      displayName: 'Engineering',
      externalId: ref,
      members: [{ value: account, type: 'User' }],
    });
    expect(created.status).toBe(201);
    expect(created.contentType).toContain(SCIM_JSON);
    expect(created.json.id).toBeTruthy();

    const after = await pool.query('SELECT count(*)::int AS n FROM groups');
    // A directory that could create Groups would be a directory that creates
    // authority objects. The count before and after is equal.
    expect(after.rows[0].n).toBe(before.rows[0].n);
    expect(await membersOfGroup(group)).toEqual([account]);
    await assertImageHolds('A-L10');
  });

  it('A-L11: a repeat POST is 409 uniqueness; a changed ref on PUT is 400 mutability', async () => {
    const ref = `scim-dup-${tag()}`;
    const created = await scimCall('POST', '/scim/v2/Groups',
      { displayName: 'Dup', externalId: ref, members: [] });
    expect(created.status).toBe(201);

    const repeat = await scimCall('POST', '/scim/v2/Groups',
      { displayName: 'Dup again', externalId: ref, members: [] });
    expect(repeat.status).toBe(409);
    expect(repeat.json.scimType).toBe('uniqueness');
    // The refusal points at the resource to reconcile against, so a client
    // that lost track reconciles instead of forking.
    expect(repeat.json.detail).toContain(created.json.id);

    const moved = await scimCall('PUT', `/scim/v2/Groups/${created.json.id}`,
      { id: created.json.id, displayName: 'Dup', externalId: `${ref}-moved`, members: [] });
    expect(moved.status).toBe(400);
    expect(moved.json.scimType).toBe('mutability');

    // The echoed readOnly `id` is ACCEPTED AND IGNORED — refusing it would
    // break conforming clients over a field that is the server's anyway.
    const kept = await scimCall('PUT', `/scim/v2/Groups/${created.json.id}`,
      { id: created.json.id, displayName: 'Renamed', externalId: ref, members: [] });
    expect(kept.status).toBe(200);
    expect(kept.json.displayName).toBe('Renamed');
  });

  it('A-L11: members[].type = Group is 400 invalidValue (NG-1)', async () => {
    const refused = await scimCall('POST', '/scim/v2/Groups', {
      displayName: 'Nested', externalId: `nest-${tag()}`,
      members: [{ value: 'anything', type: 'Group' }],
    });
    expect(refused.status).toBe(400);
    expect(refused.json.scimType).toBe('invalidValue');
    expect(refused.json.detail).toContain('nested groups');
  });

  it('A-L12: a PATCH path outside the enumerated set is 400 invalidPath', async () => {
    const created = await scimCall('POST', '/scim/v2/Groups',
      { displayName: 'Patchable', externalId: `patch-${tag()}`, members: [] });
    expect(created.status).toBe(201);
    const refused = await scimCall('PATCH', `/scim/v2/Groups/${created.json.id}`, {
      schemas: ['urn:ietf:params:scim:api:messages:2.0:PatchOp'],
      Operations: [{ op: 'replace', path: 'externalId', value: 'x' }],
    });
    expect(refused.status).toBe(400);
    expect(refused.json.scimType).toBe('invalidPath');
  });

  it('A-L12: the admitted PATCH paths reach the seam and recompute membership', async () => {
    const ref = `patch-ok-${tag()}`;
    const group = await boundGroup('A-L12', ref);
    await directoryCarriageService.deleteReferenceFromDirectory(PROVIDER_ID, await referenceIdFor(ref), SYSTEM_ACTOR);
    const one = await provisionedAccount('patch-1');
    const two = await provisionedAccount('patch-2');
    const created = await scimCall('POST', '/scim/v2/Groups',
      { displayName: 'Team', externalId: ref, members: [{ value: one }] });
    expect(created.status).toBe(201);
    expect(await membersOfGroup(group)).toEqual([one]);

    const added = await scimCall('PATCH', `/scim/v2/Groups/${created.json.id}`, {
      Operations: [{ op: 'add', path: 'members', value: [{ value: two }] }],
    });
    expect(added.status).toBe(200);
    expect(await membersOfGroup(group)).toEqual([one, two].sort());

    const removed = await scimCall('PATCH', `/scim/v2/Groups/${created.json.id}`, {
      Operations: [{ op: 'remove', path: `members[value eq "${one}"]` }],
    });
    expect(removed.status).toBe(200);
    // The member REMOVED by the push loses derived membership in the same
    // transaction that removed the carriage.
    expect(await membersOfGroup(group)).toEqual([two]);
    await assertImageHolds('A-L12');
  });

  it('A-L13: DELETE leaves groups and the binding untouched and recomputes the carriers', async () => {
    const ref = `del-${tag()}`;
    const group = await boundGroup('A-L13', ref);
    await directoryCarriageService.deleteReferenceFromDirectory(PROVIDER_ID, await referenceIdFor(ref), SYSTEM_ACTOR);
    const account = await provisionedAccount('del');
    const created = await scimCall('POST', '/scim/v2/Groups',
      { displayName: 'Doomed', externalId: ref, members: [{ value: account }] });
    expect(created.status).toBe(201);
    expect(await membersOfGroup(group)).toEqual([account]);

    const gone = await scimCall('DELETE', `/scim/v2/Groups/${created.json.id}`);
    expect(gone.status).toBe(204);

    const binding = await pool.query(
      'SELECT identity_provider_id, external_group_ref FROM groups WHERE id = $1', [group],
    );
    // The Group and its BINDING survive: a bound Group whose reference is
    // deleted keeps its binding and stops receiving members, which is the
    // dangling-ref state the design already tolerates when a claim stops
    // arriving. The alternative -- letting the directory delete a board Group
    // -- is NG-2.
    expect(String(binding.rows[0].identity_provider_id)).toBe(PROVIDER_ID);
    expect(String(binding.rows[0].external_group_ref)).toBe(ref);
    expect(await membersOfGroup(group)).toEqual([]);
    await assertImageHolds('A-L13');
  });

  it('A-L14: a member of a DIFFERENT provider is 400 invalidValue, naming the value', async () => {
    const stranger = await makeAccount('user', 'stranger');
    const refused = await scimCall('POST', '/scim/v2/Groups', {
      displayName: 'Foreign', externalId: `foreign-${tag()}`,
      members: [{ value: stranger }],
    });
    expect(refused.status).toBe(400);
    expect(refused.json.scimType).toBe('invalidValue');
    expect(refused.json.detail).toContain(stranger);
    // Nothing was written: the reference does not exist either.
    expect(await referenceIdFor(`foreign-${stranger}`)).toBeNull();
  });

  it('A-L15: an unrouted /scim/v2 path is a SCIM-shaped 404, not a transport failure', async () => {
    const answer = await scimCall('GET', '/scim/v2/Nope');
    expect(answer.status).toBe(404);
    expect(answer.contentType).toContain(SCIM_JSON);
    expect(answer.json.schemas).toEqual(['urn:ietf:params:scim:api:messages:2.0:Error']);
    // RFC 7644 §3.12: `status` is a STRING in the SCIM error object.
    expect(answer.json.status).toBe('404');
  });

  it('A-L9: discovery advertises Group, with only the attributes the endpoint maps', async () => {
    const types = await scimCall('GET', '/scim/v2/ResourceTypes');
    expect(types.status).toBe(200);
    expect(types.json.totalResults).toBe(2);
    expect(types.json.Resources.map((r: any) => r.id).sort()).toEqual(['Group', 'User']);

    const schemas = await scimCall('GET', '/scim/v2/Schemas');
    const groupSchema = schemas.json.Resources
      .find((r: any) => r.id === 'urn:ietf:params:scim:schemas:core:2.0:Group');
    expect(groupSchema).toBeTruthy();
    expect(groupSchema.attributes.map((a: any) => a.name)).toEqual(['displayName', 'externalId', 'members']);
  });

  it('the rung is bound to its provider — a reference of another provider is 404-concealed', async () => {
    const other = await pool.query(
      `INSERT INTO identity_providers
         (name, status, issuer, discovery_url, client_id, subject_immutable)
       VALUES ($1, 'disabled', $2, $3, 'other', TRUE) RETURNING id`,
      [`other ${tag()}`, `https://other.invalid/${tag()}`, `https://other.invalid/${tag()}/c`],
    );
    const foreign = await pool.query(
      `INSERT INTO directory_group_references (identity_provider_id, external_group_ref)
       VALUES ($1, $2) RETURNING id`,
      [String(other.rows[0].id), `other-${tag()}`],
    );
    const answer = await scimCall('GET', `/scim/v2/Groups/${String(foreign.rows[0].id)}`);
    expect(answer.status).toBe(404);
    // A reference THIS Identity provider did not record is indistinguishable
    // from one that does not exist — A24's read boundary.
    const missing = await scimCall('GET', '/scim/v2/Groups/00000000-0000-4000-8000-000000000000');
    expect(missing.status).toBe(404);
    expect(missing.json.detail).toBe(answer.json.detail);
  });
});

// ═══════════════════════ 6. the catalog and *Use this group* ═════════════════

describe('A-L16…A-L18, A-L35-v1, R-10 — the catalog and its projection', () => {
  it('A-L16: a non-root caller gets 200 and an EMPTY LIST — never 403', async () => {
    const ref = `cat-${tag()}`;
    await directoryCarriageService.applyReferenceCarriage(PROVIDER_ID, ref, [], 'scim', SYSTEM_ACTOR);

    const asRoot = await call(ROOT, 'GET', '/directory-group-references');
    expect(asRoot.status).toBe(200);
    expect(asRoot.json.references.length).toBeGreaterThan(0);

    for (const who of [MEMBER, MACHINE]) {
      const answer = await call(who, 'GET', '/directory-group-references');
      // A 403 on a list route discloses that the surface exists and is
      // populated. An empty list discloses that this caller has nothing here.
      expect({ who: who.label, status: answer.status }).toEqual({ who: who.label, status: 200 });
      expect({ who: who.label, rows: answer.json.references }).toEqual({ who: who.label, rows: [] });
    }
  });

  it('A-L35-v1: no route returns member IDENTITIES, and no catalog row carries one', async () => {
    const account = await provisionedAccount('identities');
    const ref = `ident-${tag()}`;
    await directoryCarriageService.applyReferenceCarriage(PROVIDER_ID, ref, [account], 'scim', SYSTEM_ACTOR);

    // The route census: `/directory-group-references/:id/members` does not
    // exist. Design round 1 gave stewards one, and it would have rendered the
    // membership list of unrelated directory groups.
    const members = await call(ROOT, 'GET', `/directory-group-references/${await referenceIdFor(ref)}/members`);
    expect([404, 405]).toContain(members.status);

    const listed = await call(ROOT, 'GET', '/directory-group-references');
    const row = listed.json.references.find((r: any) => r.externalGroupRef === ref);
    expect(row.memberCount).toBe(1);
    // No principal id, handle or email AT ANY DEPTH — asserted over the
    // serialised body, so a nested field cannot hide from a shallow check.
    expect(JSON.stringify(listed.json)).not.toContain(account);
    expect(JSON.stringify(listed.json)).not.toMatch(/"handle"|"email"/);

    // A non-root caller's response likewise, and it carries no row at all.
    const asMember = await call(MEMBER, 'GET', '/directory-group-references');
    expect(JSON.stringify(asMember.json)).not.toContain(account);
  });

  it('A-L17 / R-10: outside the projection is BYTE-IDENTICAL to does-not-exist', async () => {
    const ref = `conceal-${tag()}`;
    await directoryCarriageService.applyReferenceCarriage(PROVIDER_ID, ref, [], 'scim', SYSTEM_ACTOR);
    const existing = await referenceIdFor(ref);
    const absent = '00000000-0000-4000-8000-000000000000';

    for (const who of [MEMBER, MACHINE]) {
      const outside = await call(who, 'GET', `/directory-group-references/${existing}`);
      const missing = await call(who, 'GET', `/directory-group-references/${absent}`);
      // Status, code AND body. Produced from ONE branch, which is what makes
      // "the same words" a property rather than a coincidence -- the estate
      // standard FIX-C landed at 21daf85.
      expect({ who: who.label, status: outside.status, body: outside.text })
        .toEqual({ who: who.label, status: missing.status, body: missing.text });
      expect(outside.status).toBe(404);
      expect(outside.json.code).toBe('DIRECTORY_GROUP_REFERENCE_NOT_FOUND');
    }

    // And a malformed id answers the same thing, so the shape of the id is not
    // an oracle either.
    const malformed = await call(MEMBER, 'GET', '/directory-group-references/not-a-uuid');
    expect(malformed.status).toBe(404);
    expect(malformed.json.code).toBe('DIRECTORY_GROUP_REFERENCE_NOT_FOUND');

    // The positive control: root DOES see it, so the assertions above are not
    // satisfied by a route that answers everybody 404.
    const asRoot = await call(ROOT, 'GET', `/directory-group-references/${existing}`);
    expect(asRoot.status).toBe(200);
    expect(asRoot.json.reference.externalGroupRef).toBe(ref);
  });

  it('A-L18: *Use this group* is refused for a non-root caller and is ALL-OR-NOTHING', async () => {
    const account = await provisionedAccount('use');
    const ref = `use-${tag()}`;
    await directoryCarriageService.applyReferenceCarriage(PROVIDER_ID, ref, [account], 'scim', SYSTEM_ACTOR);
    const referenceId = await referenceIdFor(ref);

    for (const who of [MEMBER, MACHINE]) {
      const refused = await call(who, 'POST', `/directory-group-references/${referenceId}/use`, {});
      expect({ who: who.label, status: refused.status }).toEqual({ who: who.label, status: 403 });
    }
    const groupsBefore = await pool.query('SELECT count(*)::int AS n FROM groups');

    const used = await call(ROOT, 'POST', `/directory-group-references/${referenceId}/use`, {});
    expect(used.status).toBe(201);
    expect(used.json.memberCountApplied).toBe(1);
    expect(await membersOfGroup(used.json.groupId)).toEqual([account]);
    await assertImageHolds('A-L18');

    // A SECOND bind of the same reference is refused, and writes no Group: the
    // all-or-nothing property, drilled at the step that can fail.
    const again = await call(ROOT, 'POST', `/directory-group-references/${referenceId}/use`, {});
    expect(again.status).toBe(409);
    expect(again.json.code).toBe('DIRECTORY_GROUP_REFERENCE_ALREADY_BOUND');
    const groupsAfter = await pool.query('SELECT count(*)::int AS n FROM groups');
    expect(groupsAfter.rows[0].n).toBe(groupsBefore.rows[0].n + 1);
  });

  it('A-L18: a forced failure in the MEMBERSHIP step leaves no groups row', async () => {
    // The membership step is made to fail by the SCHEMA: a parented principal
    // carrying the reference cannot be a Group member (094's trigger). If the
    // Group insert and the membership write were not one transaction, the
    // Group would survive with nobody in it and no error anybody saw.
    const parent = await makeAccount('user');
    const child = await pool.query(
      `INSERT INTO principals (kind, handle, display_name, status, role, parent_principal_id)
       VALUES ('service', $1, 'child', 'active', NULL, $2) RETURNING id`,
      [`use-child-${tag()}`, parent],
    );
    const ref = `use-fail-${tag()}`;
    const reference = await pool.query(
      `INSERT INTO directory_group_references (identity_provider_id, external_group_ref)
       VALUES ($1, $2) RETURNING id`, [PROVIDER_ID, ref],
    );
    await pool.query(
      `INSERT INTO account_directory_group_references
         (directory_group_reference_id, account_principal_id, source) VALUES ($1, $2, 'scim')`,
      [String(reference.rows[0].id), String(child.rows[0].id)],
    );
    const before = await pool.query('SELECT count(*)::int AS n FROM groups');

    const failed = await call(ROOT, 'POST', `/directory-group-references/${String(reference.rows[0].id)}/use`, {});
    expect(failed.status).toBe(500);
    const after = await pool.query('SELECT count(*)::int AS n FROM groups');
    expect(after.rows[0].n).toBe(before.rows[0].n);
    expect(await pool.query(
      'SELECT 1 FROM groups WHERE identity_provider_id = $1 AND external_group_ref = $2',
      [PROVIDER_ID, ref],
    ).then((r: any) => r.rows.length)).toBe(0);
  });

  it("a person's OWN carriage is self-only and carries nobody else", async () => {
    const ref = `own-${tag()}`;
    await directoryCarriageService.applyAccountCarriage(
      PROVIDER_ID, MEMBER.principalId, [ref], 'claim', SYSTEM_ACTOR,
    );
    const mine = await call(MEMBER, 'GET', '/principals/me/directory-group-references');
    expect(mine.status).toBe(200);
    expect(mine.json.references.map((r: any) => r.externalGroupRef)).toEqual([ref]);
    // The route takes no identifier, so there is nothing to guess: another
    // Account's list is unreachable by construction rather than by a check.
    const theirs = await call(ROOT, 'GET', '/principals/me/directory-group-references');
    expect(theirs.json.references.map((r: any) => r.externalGroupRef)).not.toContain(ref);
  });

  it('the housekeeping delete is REFUSED while the reference is bound', async () => {
    const ref = `keep-${tag()}`;
    await directoryCarriageService.applyReferenceCarriage(PROVIDER_ID, ref, [], 'scim', SYSTEM_ACTOR);
    const referenceId = await referenceIdFor(ref);
    const used = await call(ROOT, 'POST', `/directory-group-references/${referenceId}/use`, {});
    expect(used.status).toBe(201);

    const refused = await call(ROOT, 'DELETE', `/directory-group-references/${referenceId}`);
    expect(refused.status).toBe(409);
    expect(refused.json.code).toBe('DIRECTORY_GROUP_REFERENCE_BOUND');
    expect(await referenceIdFor(ref)).toBe(referenceId);
  });
});

describe('B1 — owner-plane writes cannot bypass directory carriage', () => {
  it('B1: binding and directory membership refusals preserve point-route sets for two principals', async () => {
    const a = await makeAccount('user', 'b1-a');
    const b = await makeAccount('user', 'b1-b');
    const ref = `b1-${tag()}`;
    await directoryCarriageService.applyAccountCarriage(PROVIDER_ID, a, [ref], 'claim', SYSTEM_ACTOR);
    const gid = await boundGroup('B1', ref);
    const point = () => call(ROOT, 'GET', `/groups/${gid}/members`);
    const expected = (await point()).json.members;
    expect(expected.map((m: any) => m.accountPrincipalId)).toEqual([a]);
    const groupBefore = (await call(ROOT, 'GET', `/groups/${gid}`)).json.group;
    for (const who of [ROOT, MEMBER]) {
      for (const body of [
        { identityProviderId: PROVIDER_ID, externalGroupRef: `other-${tag()}` },
        { identityProviderId: null, externalGroupRef: null },
      ]) {
        const answer = await call(who, 'PATCH', `/groups/${gid}`, body);
        expect(answer.status).toBe(who === ROOT ? 409 : 403);
        expect((await call(ROOT, 'GET', `/groups/${gid}`)).json.group).toEqual(groupBefore);
      }
      const added = await call(who, 'POST', `/groups/${gid}/members`,
        { accountPrincipalId: b, source: 'directory' });
      expect(added.status).toBe(who === ROOT ? 409 : 403);
      const removed = await call(who, 'DELETE', `/groups/${gid}/members/${a}`);
      expect(removed.status).toBe(who === ROOT ? 404 : 403);
      const absent = await call(who, 'DELETE', `/groups/${gid}/members/${b}`);
      expect(removed.text).toBe(absent.text);
      expect((await point()).json.members).toEqual(expected);
    }
    const addedLocal = await call(ROOT, 'POST', `/groups/${gid}/members`, { accountPrincipalId: b, source: 'local' });
    expect(addedLocal.status).toBe(201);
    expect((await point()).json.members.map((m: any) => m.accountPrincipalId).sort()).toEqual([a,b].sort());
    expect((await call(ROOT, 'DELETE', `/groups/${gid}/members/${b}`)).status).toBe(200);
    expect((await point()).json.members).toEqual(expected);
    await assertImageHolds('B1');
  });
});

// ═════════════ 6b. SF-1…SF-3 — three boundaries that did not translate ═══════

describe('SF-1…SF-3 — the self-found boundary defects, and their repairs', () => {
  it('SF-1: a DIRECTORY-CONTROLLED display name cannot cross the board name bound', () => {
    // The defect, measured before the repair by a direct-module probe: a
    // reference whose `display_name` is 400 characters produced a board Group
    // whose name is 400 characters, where every other `groups` writer refuses
    // past 120. Migration 127 bounds `display_name` at 1024 OCTETS, so the
    // directory could pick any length inside that and the board would take it.
    return (async () => {
      const ref = `sf1-${tag()}`;
      const long = 'D'.repeat(400);
      await directoryCarriageService.applyReferenceCarriage(
        PROVIDER_ID, ref, [], 'scim', SYSTEM_ACTOR, { displayName: long },
      );
      const referenceId = await referenceIdFor(ref);

      const refused = await call(ROOT, 'POST', `/directory-group-references/${referenceId}/use`, {});
      expect(refused.status).toBe(422);
      expect(refused.json.code).toBe('DIRECTORY_GROUP_REFERENCE_NAME_UNUSABLE');
      // REFUSED, NOT TRUNCATED: a truncated name is a Group nobody can find by
      // the name the directory shows, and the administrator is the one person
      // who can decide what it should be called instead. So the refusal names
      // the field to pass.
      expect(refused.json.message).toContain('explicit name');
      expect(await pool.query(
        'SELECT 1 FROM groups WHERE identity_provider_id = $1 AND external_group_ref = $2',
        [PROVIDER_ID, ref],
      ).then((r: any) => r.rows.length)).toBe(0);

      // And the named way through works, on the SAME reference.
      const named = await call(ROOT, 'POST', `/directory-group-references/${referenceId}/use`,
        { name: `SF-1 ${tag()}` });
      expect(named.status).toBe(201);
      const stored = await pool.query('SELECT name FROM groups WHERE id = $1', [named.json.groupId]);
      expect(String(stored.rows[0].name).length).toBeLessThanOrEqual(120);

      // An EXPLICIT over-long name is refused by the same validator every other
      // Group writer uses -- reused, not re-derived.
      const other = `sf1b-${tag()}`;
      await directoryCarriageService.applyReferenceCarriage(PROVIDER_ID, other, [], 'scim', SYSTEM_ACTOR);
      const otherId = await referenceIdFor(other);
      const tooLong = await call(ROOT, 'POST', `/directory-group-references/${otherId}/use`,
        { name: 'N'.repeat(121) });
      expect(tooLong.status).toBe(422);
      expect(tooLong.json.code).toBe('INVALID_GROUP_VALUE');

      // The description is bounded by the same reuse.
      const fat = await call(ROOT, 'POST', `/directory-group-references/${otherId}/use`,
        { name: `SF-1 desc ${tag()}`, description: 'x'.repeat(2001) });
      expect(fat.status).toBe(422);
      expect(fat.json.code).toBe('INVALID_GROUP_VALUE');
    })();
  });

  it('SF-2: a repeated externalId is 409 uniqueness on the wire, not a 500', async () => {
    // The ON CONFLICT clause resolves the (provider, ref) key and NOT
    // `ux_directory_group_references_scim_external`, so this raised an
    // unhandled unique violation and answered 500 with an error id.
    const shared = `sf2-ext-${tag()}`;
    const first = await call(SCIM, 'POST', '/scim/v2/Groups',
      { displayName: 'SF2 one', externalId: shared, members: [] });
    expect(first.status).toBe(201);

    // A DIFFERENT ref carrying the SAME externalId. The provider declares
    // `externalId` as the ref attribute by default, so this drill switches it
    // to `displayName` first -- otherwise the two would collide on the ref and
    // never reach the externalId index at all, and the control would pass for
    // the wrong reason.
    await pool.query(
      "UPDATE identity_providers SET scim_group_ref_attribute = 'displayName' WHERE id = $1",
      [PROVIDER_ID],
    );
    try {
      const second = await call(SCIM, 'POST', '/scim/v2/Groups',
        { displayName: `SF2 two ${tag()}`, externalId: shared, members: [] });
      expect(second.status).toBe(409);
      expect(second.json.scimType).toBe('uniqueness');
      expect(second.contentType).toContain('application/scim+json');
    } finally {
      await pool.query(
        "UPDATE identity_providers SET scim_group_ref_attribute = 'externalId' WHERE id = $1",
        [PROVIDER_ID],
      );
    }
  });

  it('SF-3: a seam refusal reaches a SCIM client as a SCIM error, not a 500', async () => {
    // `validateExternalGroupRef` refuses in the SEAM's vocabulary and
    // `sendScimError` maps only ScimError, so every refusal the seam raises
    // used to answer "the request could not be completed (error id ...)" --
    // which tells a conforming client to retry something it must not retry.
    const oversized = 'R'.repeat(1025);
    const refused = await call(SCIM, 'POST', '/scim/v2/Groups',
      { displayName: 'SF3', externalId: oversized, members: [] });
    expect(refused.status).toBe(400);
    expect(refused.json.scimType).toBe('invalidValue');
    expect(refused.contentType).toContain('application/scim+json');
    // The detail says what is wrong with the value, not that something failed.
    expect(refused.json.detail).toContain('octets');
    // 422 is NOT on the wire: RFC 7644 §3.12's table has no 422, and a status a
    // conforming client does not branch on is one it reads as a transport
    // failure.
    expect(refused.status).not.toBe(422);
    // Nothing was written.
    expect(await referenceIdFor(oversized)).toBeNull();
    await assertImageHolds('SF-3');
  });
});

// ═══════════════════ 7. A-L7 / A-L45 — provider removal ══════════════════════

describe('A-L7 / A-L45 — deleting an Identity provider leaves no residue', () => {
  it('removes references and carriage, UNBINDS its Groups, and leaves no derived membership', async () => {
    // A provider with any Identity link cannot be deleted at all (§7.3, SS-8),
    // so this drill uses a SCIM-provisioned provider with no links — which is
    // exactly the shape a directory-only deployment has.
    const doomed = await pool.query(
      `INSERT INTO identity_providers
         (name, status, issuer, discovery_url, client_id, subject_immutable)
       VALUES ($1, 'disabled', $2, $3, 'doomed', TRUE) RETURNING id`,
      [`doomed ${tag()}`, `https://doomed.invalid/${tag()}`, `https://doomed.invalid/${tag()}/c`],
    );
    const providerId = String(doomed.rows[0].id);
    const account = await makeAccount('user', 'doomed');
    const ref = `doomed-${tag()}`;

    const reference = await directoryCarriageService.recordReference(providerId, ref, SYSTEM_ACTOR);
    const binding = await directoryCarriageService.bindReferenceToGroup(reference.id,
      { name: `doomed ${tag()}` }, SYSTEM_ACTOR);
    const group = { id: binding.groupId };
    await directoryCarriageService.applyAccountCarriage(
      providerId, account, [ref], 'claim', SYSTEM_ACTOR,
    );
    expect(await membersOfGroup(group.id)).toEqual([account]);

    const removed = await call(ROOT, 'DELETE', `/identity-providers/${providerId}`);
    expect({ status: removed.status, body: removed.text }).toEqual({ status: 204, body: '' });

    // CASCADE took the references and their carriage.
    const references = await pool.query(
      'SELECT count(*)::int AS n FROM directory_group_references WHERE identity_provider_id = $1',
      [providerId],
    );
    expect(references.rows[0].n).toBe(0);
    // 104's trigger UNBOUND the Group rather than deleting it, and left no
    // half-bound row: both columns or neither.
    const groupRow = await pool.query(
      'SELECT identity_provider_id, external_group_ref FROM groups WHERE id = $1', [group.id],
    );
    expect(groupRow.rows[0].identity_provider_id).toBeNull();
    expect(groupRow.rows[0].external_group_ref).toBeNull();
    // A-L45: and NO derived membership survives. Without the explicit release
    // this would be authority residue with no source that could ever correct
    // it -- neither the trigger nor the CASCADE touches group_members.
    expect(await membersOfGroup(group.id)).toEqual([]);
    await assertImageHolds('A-L45');
  });

it('BOOT-A: the production Access-surface census accepts every mounted root family', async () => {
  const { accessSurfaceService } = require('../services/AccessSurfaceService');
  expect(await accessSurfaceService.auditCatalogue()).toEqual([]);
});
});
