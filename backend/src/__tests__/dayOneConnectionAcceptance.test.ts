/**
 * THE DAY-ONE CONNECTION FLOW, MEASURED (cards 6e25ae48 and 3f145fa3).
 *
 * BETA-SMOKE walked a first-time operator through a fresh board and found that
 * "Connect your agent" — the headline card on the dashboard of an empty
 * install, and the only documented day-one flow — could not succeed for the
 * person who had just created the deployment. `scopesForRole` derives
 * `['root']` for `admin` and `orchestrator`, `issueCredential` refuses `root`
 * outright (AUTHZ §5.2 rule 2 / AZ-18), and the refusal reached the caller as
 * `500 INTERNAL_ERROR — Failed to register the service` while the registry row,
 * its Connector principal and the globally unique slug were left behind.
 *
 * ── WHY THIS SUITE EXISTS AND THE UNIT TESTS DO NOT COVER IT ──
 *
 * Both defects are properties of a SEQUENCE OF WRITES seen from outside:
 *
 *   - "the credential a role receives actually authenticates" cannot be
 *     answered by a mocked pool, because the thing that would be wrong is the
 *     row that was stored;
 *   - "a refused connection leaves nothing behind" is a statement about what is
 *     in the database AFTER the request, and a recording double that treats
 *     BEGIN/COMMIT/ROLLBACK as no-ops proves only statement order. Card
 *     `1ff5f133` is open against exactly that mistake in a neighbouring
 *     suite, and this file must not repeat it.
 *
 * So this runs against a REAL PostgreSQL, through the PRODUCTION router with
 * the guard chain `server.ts` mounts, with real login sessions of three
 * different roles — and it FAILS rather than skips when it has no database.
 *
 * ── THE DESTRUCTIVE CONTRACT, STATED ──
 *
 * This suite WRITES to principals, principal_credentials, services,
 * auth_sessions and audit_events. It refuses any URL naming a deployment
 * database and any non-local host. Bring a disposable database up with
 * `database/init.sql` and `npm run migrate`, and throw it away afterwards.
 */

/* eslint-disable @typescript-eslint/no-var-requires */

import http from 'http';
import crypto from 'crypto';

// ─────────────────────────── the database contract ───────────────────────────

const TEST_DB_URL = process.env.RELAYHALL_TEST_DB_URL;
if (!TEST_DB_URL) {
  throw new Error(
    'RELAYHALL_TEST_DB_URL is not set. This gate measures what a refused connection LEAVES BEHIND and whether an '
    + 'issued credential authenticates, and it refuses to skip: both are properties of stored rows, and a mocked pool '
    + 'can only replay the rule. Create a disposable database, load database/init.sql, run npm run migrate, and point '
    + 'RELAYHALL_TEST_DB_URL at it.',
  );
}

const parsed = new URL(TEST_DB_URL);
const TEST_DB_NAME = parsed.pathname.replace(/^\//, '');
const FORBIDDEN_DATABASES = ['relayhall_dev', 'relayhall_tst', 'relayhall_prod', 'relayhall'];
if (FORBIDDEN_DATABASES.includes(TEST_DB_NAME)) {
  throw new Error(`RELAYHALL_TEST_DB_URL names a deployment database (${TEST_DB_NAME}). This suite writes; point it at a disposable database.`);
}

// The production pool reads DB_* at import time, so the environment is pinned
// BEFORE anything is required — which is why everything below uses `require`.
process.env.DB_HOST = parsed.hostname;
process.env.DB_PORT = parsed.port || '5432';
process.env.DB_NAME = TEST_DB_NAME;
process.env.DB_USER = decodeURIComponent(parsed.username);
process.env.DB_PASSWORD = decodeURIComponent(parsed.password);
process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'day-one-connection-suite-secret-0123456789';
// The wizard is a browser SESSION surface: `POST /services` refuses
// `issueCredential` from anything else (`SESSION_ONLY`). The session plane is a
// deployment flag, so the suite turns it on for itself rather than depending on
// how the machine that runs it happens to be configured.
process.env.RELAYHALL_SESSIONS = 'on';

const express = require('express');

const { pool } = require('../db/connection');
const { registerProtectedRoutes } = require('../routeRegistry');
const { authMiddleware } = require('../middleware/auth');
const { sharedAuthorizationMiddleware } = require('../middleware/sharedAuthorization');
const { apiErrorHandler } = require('../utils/apiErrors');
const { jsonBodyOptions } = require('../utils/jsonBodyTypes');
const { principalService, CredentialPolicyError } = require('../services/PrincipalService');
const { loginSessionService, SESSION_COOKIE_NAME } = require('../services/LoginSessionService');
const { MINTABLE_SCOPES, ROOT_SCOPE } = require('../utils/scopeMap');
const { scopesForRole } = require('../utils/identityScopes');
const mcpRoutes = require('../mcp/httpRoute').default;
const { MCP_ROUTE_PATH } = require('../mcp/httpRoute');
const { BOOTSTRAP_REFUSAL_MARKER, BOOTSTRAP_VERB } = require('../mcp/bootstrapGate');

jest.setTimeout(180_000);

// ──────────────────────────────── the app ────────────────────────────────────

let server: http.Server;
let origin: string;

function buildApp(): any {
  const app = express();
  app.use(express.json(jsonBodyOptions));
  app.use(express.urlencoded({ extended: true }));
  // The MCP ingress, mounted the way `server.ts` mounts it — deliberately NOT
  // through `registerProtectedRoutes`, because that installs `authMiddleware`,
  // which stamps `api`. This ingress stamps `mcp` after transport termination
  // (`mcp/provenance`), and the §7.5 transport pin is meaningless without that
  // difference. Card `07d09eaf` is a defect a REST probe cannot see: a wizard
  // credential is pinned `mcp`, so the only surface it can speak to is this one.
  app.use(MCP_ROUTE_PATH, mcpRoutes);
  registerProtectedRoutes((mountPath: string, ...handlers: any[]) => {
    app.use(mountPath, authMiddleware, sharedAuthorizationMiddleware, ...handlers);
  });
  app.use(apiErrorHandler);
  return app;
}

/**
 * One JSON-RPC `tools/call` against the mounted MCP endpoint, as a stock client
 * makes it: a bearer credential in the header and nothing else. Stateless by
 * construction (`sessionIdGenerator: undefined`), so there is no handshake to
 * carry and no session id to thread.
 */
async function mcpCall(token: string, name: string, args: Record<string, unknown> = {}): Promise<Answer> {
  const response = await fetch(`${origin}${MCP_ROUTE_PATH}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
  });
  const text = await response.text();
  let json: any = null;
  try { json = JSON.parse(text); } catch { json = null; }
  return { status: response.status, json };
}

/** What a tool answered, as the harness reads it. */
const mcpText = (answer: Answer): string => String(answer.json?.result?.content?.[0]?.text ?? '');
const mcpFailed = (answer: Answer): boolean => Boolean(answer.json?.result?.isError) || Boolean(answer.json?.error);

interface Answer { status: number; json: any }

/** One caller: a login-session cookie, or a bearer credential — never both. */
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
  const text = await response.text();
  let json: any = null;
  try { json = JSON.parse(text); } catch { json = null; }
  return { status: response.status, json };
}

// ────────────────────────────── the fixtures ─────────────────────────────────

const tag = (): string => crypto.randomBytes(5).toString('hex');

/**
 * The credential grammar, from the server that mints it
 * (`PrincipalService.parsePrincipalKey`). Written out so an assertion claiming
 * "a real token came back" can actually FAIL — a pattern that matches nothing
 * would make every such claim true by construction.
 */
const TOKEN = /^rh_(live|dev)_[A-Za-z0-9]{6,64}\.[A-Za-z0-9_-]{20,128}$/;

/** The three roles a person can be signed in as while running this flow. */
const ROLES = ['user', 'operator', 'admin'] as const;
type Role = typeof ROLES[number];

const SESSIONS: Record<Role, Caller> = {} as any;

async function makeAccount(role: string): Promise<string> {
  const handle = `dayone-${role}-${tag()}`;
  const result = await pool.query(
    `INSERT INTO principals (kind, handle, display_name, status, role)
     VALUES ('human', $1, $2, 'active', $3) RETURNING id`,
    [handle, `day one ${handle}`, role],
  );
  return String(result.rows[0].id);
}

/** A login session, exactly as the login and SSO return paths mint one: an
 *  httpOnly cookie, `role_snapshot` NULL, and no bearer credential anywhere. */
async function sessionFor(label: string, principalId: string): Promise<Caller> {
  const minted = await loginSessionService.mint({ principalId });
  return { label, principalId, headers: { Cookie: `${SESSION_COOKIE_NAME}=${minted.token}` } };
}

const bearer = (label: string, principalId: string, fullKey: string): Caller =>
  ({ label, principalId, headers: { Authorization: `Bearer ${fullKey}` } });

/**
 * What the wizard sends: registration and the first credential, in ONE call.
 *
 * The transport comes from the step-1 template and is a REAL pin, not a label:
 * an `mcp` credential is refused on every REST route with 403
 * TRANSPORT_MISMATCH (§7.5). The acceptance arms below therefore connect as the
 * API-script template, whose credential is the one a REST probe can speak to,
 * and a separate control connects as Claude Code and proves the `mcp` pin still
 * bites after the registration and the mint became one transaction.
 */
function connectBody(slug: string, scopes: string[], transport: 'any' | 'mcp' | 'api' = 'api') {
  return {
    slug,
    name: slug,
    description: transport === 'mcp'
      ? 'Claude Code, connected from the Connect your agent flow.'
      : 'An API script, connected from the Connect your agent flow.',
    kind: 'connector',
    issueCredential: { scopes, label: slug, transport },
  };
}

async function serviceRowsFor(slug: string): Promise<number> {
  const result = await pool.query('SELECT 1 FROM services WHERE slug = $1', [slug]);
  return result.rows.length;
}

async function connectorPrincipalsFor(slug: string): Promise<number> {
  // `ServiceRegistry.connectorHandleFor` derives `connector-<slug>` whenever it
  // fits, and every slug in this suite does. The `purpose` column names the
  // registry row outright, so the census below catches a row whose handle was
  // derived some other way rather than depending on one derivation.
  const result = await pool.query(
    `SELECT 1 FROM principals WHERE handle = $1 OR purpose = $2`,
    [`connector-${slug}`, `Connector for service ${slug}`],
  );
  return result.rows.length;
}

async function deniedMintRows(): Promise<any[]> {
  const result = await pool.query(
    `SELECT metadata FROM audit_events
      WHERE action = 'credential.mint' AND outcome = 'denied'
      ORDER BY occurred_at DESC LIMIT 20`,
  );
  return result.rows;
}

beforeAll(async () => {
  await new Promise<void>((resolve) => { server = buildApp().listen(0, resolve); });
  origin = `http://127.0.0.1:${(server.address() as any).port}`;
  for (const role of ROLES) {
    const id = await makeAccount(role);
    SESSIONS[role] = await sessionFor(`${role} session`, id);
  }
});

afterAll(async () => {
  await new Promise<void>((resolve) => { server.close(() => resolve()); });
  await pool.end();
});

// ─────────────────────────────────────────────────────────────────────────────

describe('the board tells a session what it may delegate (card 6e25ae48)', () => {
  it.each(ROLES)('GET /principals/me answers a non-empty, root-free delegable set for %s', async (role) => {
    const answer = await call(SESSIONS[role], 'GET', '/principals/me');
    expect(answer.status).toBe(200);
    const delegable: string[] = answer.json.delegableScopes;
    expect(Array.isArray(delegable)).toBe(true);
    // The property the wizard depends on, for EVERY role a person can hold:
    // there is always something concrete to offer, and it is never the sentinel.
    expect(delegable.length).toBeGreaterThan(0);
    expect(delegable).not.toContain(ROOT_SCOPE);
    for (const scope of delegable) expect(MINTABLE_SCOPES).toContain(scope);
  });

  it('a BEARER caller is told it may delegate nothing, and the board agrees (B3)', async () => {
    // Round-1 finding B3 (verdict `7cce6577`): this route answers bearer callers
    // too, and it was handing them a delegable set they could not use. Measured
    // through the production router on a real credential, because a pure helper
    // test is what missed it.
    const slug = `fixb-b3-${tag()}`;
    //  is on it deliberately: the scope map guards this route,
    // so a credential without it is refused by the MAP and the arm below would
    // be measuring the wrong gate. With it, the caller reaches the act itself.
    const created = await call(SESSIONS.user, 'POST', '/services',
      connectBody(slug, ['tasks:read', 'principals:read', 'services:write'], 'api'));
    expect(created.status).toBe(201);
    const machine = bearer('connector', '', created.json.onboarding.credential.secretOnce);

    const me = await call(machine, 'GET', '/principals/me');
    expect(me.status).toBe(200);
    // It REACHES things — so an empty delegable set is a decision, not a caller
    // that failed to authenticate.
    expect(me.json.scopes).toEqual(expect.arrayContaining(['tasks:read']));
    expect(me.json.delegableScopes).toEqual([]);

    // And the board keeps that promise: the only surface the wizard uses refuses
    // this caller before it looks at a scope at all.
    const refused = await call(machine, 'POST', '/services',
      connectBody(`fixb-b3b-${tag()}`, ['tasks:read'], 'api'));
    expect(refused.status).toBe(403);
    expect(refused.json.code).toBe('SESSION_ONLY');
  });

  it('NEGATIVE CONTROL: the same route answers a SESSION a non-empty set', async () => {
    // Without this, the arm above is satisfied by a route that answers everybody
    // nothing — which would break the wizard for the person it was fixed for.
    const me = await call(SESSIONS.user, 'GET', '/principals/me');
    expect(me.status).toBe(200);
    expect(me.json.delegableScopes.length).toBeGreaterThan(0);
  });

  it('the administrator arm is the one the defect lived on, and it is not a widening', async () => {
    const answer = await call(SESSIONS.admin, 'GET', '/principals/me');
    // The cause, restated against the live server: the session REACHES exactly
    // the sentinel and nothing else.
    expect(answer.json.scopes).toEqual([ROOT_SCOPE]);
    expect(scopesForRole('admin')).toEqual([ROOT_SCOPE]);
    // And what it may DELEGATE is the mintable catalogue without the sentinel —
    // which is precisely the set `POST /services` already accepts from a root
    // caller, since it skips its own ISSUE_EXCEEDS_SESSION check for one. The
    // arm below proves that by minting from it.
    expect(answer.json.delegableScopes).toEqual(MINTABLE_SCOPES.filter((s: string) => s !== ROOT_SCOPE));
  });
});

describe('a person of each role completes the flow and the credential works', () => {
  it.each(ROLES)('%s: connect, receive a pack, and authenticate with it', async (role) => {
    const caller = SESSIONS[role];
    const me = await call(caller, 'GET', '/principals/me');
    const delegable: string[] = me.json.delegableScopes;

    // What the wizard asks for: the template's working set, bounded by what the
    // board says this session may delegate. Derived from the SERVER's answer,
    // not from a list written here — a list would be a copy that rots.
    //
    // `principals:read` is in the set deliberately. The acceptance below probes
    // the credential's identity through `GET /principals/me`, which sits behind
    // that scope, and introspecting your OWN grants is agent-plane readable by
    // design (A12.5 / §5.2). Without it the probe would answer 403 — an
    // authorization refusal, not an authentication failure — and could no
    // longer tell the two apart, which is the whole point of the assertion.
    const wanted = ['tasks:read', 'tasks:write', 'reports:read', 'projects:read', 'principals:read']
      .filter((scope) => delegable.includes(scope));
    expect(wanted.length).toBeGreaterThan(0);

    const slug = `fixb-${role}-${tag()}`;
    const created = await call(caller, 'POST', '/services', connectBody(slug, wanted));

    expect(created.status).toBe(201);
    const pack = created.json.onboarding;
    expect(pack).toBeTruthy();
    const token: string = pack.credential.secretOnce;
    expect(token).toMatch(TOKEN);

    // THE ACCEPTANCE. A pack that renders is not a connection that works: the
    // defect this replaces produced no pack at all, and a repair that produced
    // an unusable one would be no better. So the credential is PRESENTED to the
    // production router, on a second caller shape, and has to be recognised.
    const asConnector = bearer(`${role} connector`, '', token);
    const whoami = await call(asConnector, 'GET', '/principals/me');
    expect(whoami.status).toBe(200);
    expect(whoami.json.principal.handle).toBe(`connector-${slug}`);
    expect(whoami.json.principal.kind).toBe('service');
    // It carries what was asked for, and — the point of the whole card — the
    // sentinel is not among it.
    expect(new Set(whoami.json.scopes)).toEqual(new Set(wanted));
    expect(whoami.json.scopes).not.toContain(ROOT_SCOPE);

    // And the rows are really there, which is what makes the refusal arms below
    // a measurement rather than a tautology about an always-empty database.
    expect(await serviceRowsFor(slug)).toBe(1);
    expect(await connectorPrincipalsFor(slug)).toBe(1);
  });

  it('the transport pin still bites: an MCP connection is refused on REST', async () => {
    // The Claude Code template pins `mcp`, and §7.5 pins mean a refusal on every
    // REST route. Measured here because the pin now travels through a
    // caller-owned transaction that did not exist before: a repair that lost it
    // would hand every MCP connection the run of the REST API and no other
    // assertion in this file would notice.
    const slug = `fixb-mcp-${tag()}`;
    const created = await call(SESSIONS.user, 'POST', '/services',
      connectBody(slug, ['tasks:read', 'principals:read'], 'mcp'));
    expect(created.status).toBe(201);

    const refused = await call(
      bearer('mcp connector', '', created.json.onboarding.credential.secretOnce),
      'GET', '/principals/me');
    expect(refused.status).toBe(403);
    expect(refused.json.code).toBe('TRANSPORT_MISMATCH');
  });
});

describe('a `root` request is refused by name and writes nothing (cards 6e25ae48, 3f145fa3)', () => {
  it('answers 422 ROOT_NOT_MINTABLE, not 500 INTERNAL_ERROR', async () => {
    const slug = `fixb-rootask-${tag()}`;
    const refused = await call(SESSIONS.admin, 'POST', '/services', connectBody(slug, [ROOT_SCOPE]));
    // The reported symptom, inverted. What the operator saw was a 500 whose
    // sentence claimed nothing had been created while three rows had been.
    expect(refused.status).toBe(422);
    expect(refused.json.code).toBe('ROOT_NOT_MINTABLE');
    expect(refused.json.code).not.toBe('INTERNAL_ERROR');
  });

  it('leaves no registry row, no Connector principal and no occupied slug', async () => {
    const slug = `fixb-rootleft-${tag()}`;
    await call(SESSIONS.admin, 'POST', '/services', connectBody(slug, [ROOT_SCOPE]));

    expect(await serviceRowsFor(slug)).toBe(0);
    expect(await connectorPrincipalsFor(slug)).toBe(0);

    // The operator's own recovery, measured: retrying the SAME NAME must work.
    // `services.slug` is globally unique (migration 076), so an orphan makes the
    // obvious retry collide — which is how the reported defect turned one
    // refusal into a permanently unusable name.
    const retry = await call(SESSIONS.admin, 'POST', '/services',
      connectBody(slug, ['tasks:read', 'tasks:write']));
    expect(retry.status).toBe(201);
    expect(retry.json.onboarding.credential.secretOnce).toMatch(TOKEN);
  });

  it('still writes the durable denied ledger row §5.2 rule 8 requires', async () => {
    // The rollback must not take the refusal's audit trail with it. A refused
    // act that leaves no trace is a worse outcome than the orphan rows.
    const slug = `fixb-rootaudit-${tag()}`;
    await call(SESSIONS.admin, 'POST', '/services', connectBody(slug, [ROOT_SCOPE]));
    const rows = await deniedMintRows();
    const mine = rows.filter((row) => row.metadata?.refusal === 'ROOT_NOT_MINTABLE');
    expect(mine.length).toBeGreaterThan(0);
  });
});

describe('ANY refusal from the issue step rolls the registration back (card 3f145fa3)', () => {
  /**
   * The `root` arm above is refused before `register` runs, so on its own it
   * would leave the transactional claim untested: it proves a door that opens
   * earlier, not that the two writes commit together.
   *
   * This arm therefore causes a refusal that can only happen AFTER the registry
   * row and its Connector principal exist, by making `issueCredential` refuse.
   * That is fault injection on the seam under test and nothing else — the route,
   * the registry, the transaction and the database are all the production ones,
   * and the assertion is made against stored rows.
   */
  const injected = () => new CredentialPolicyError(409, 'PRINCIPAL_TERMINATED',
    'Credential issuance refuses terminated principals (A17.10)');

  it('reports the refusal by name and leaves nothing behind', async () => {
    const slug = `fixb-rollback-${tag()}`;
    const spy = jest.spyOn(principalService, 'issueCredential').mockRejectedValueOnce(injected());
    try {
      const answer = await call(SESSIONS.user, 'POST', '/services', connectBody(slug, ['tasks:read']));
      expect(answer.status).toBe(409);
      expect(answer.json.code).toBe('PRINCIPAL_TERMINATED');
      expect(answer.json.code).not.toBe('INTERNAL_ERROR');
    } finally {
      spy.mockRestore();
    }
    // The registry row and the Connector principal were both written before the
    // refusal, on the caller's transaction. Neither survives it.
    expect(await serviceRowsFor(slug)).toBe(0);
    expect(await connectorPrincipalsFor(slug)).toBe(0);
  });

  it('NEGATIVE CONTROL: without the injected refusal the identical call succeeds', async () => {
    // Without this, the arm above is satisfied by a route that refuses every
    // connection — the rows would be absent for the wrong reason, and the
    // "nothing was left behind" assertion would be true by construction.
    const slug = `fixb-rollback-control-${tag()}`;
    const answer = await call(SESSIONS.user, 'POST', '/services', connectBody(slug, ['tasks:read']));
    expect(answer.status).toBe(201);
    expect(await serviceRowsFor(slug)).toBe(1);
    expect(await connectorPrincipalsFor(slug)).toBe(1);
  });

  it('a refusal cannot be reported as a generic 500 any more', async () => {
    // The class, not the coordinate: every `CredentialPolicyError` this route
    // can meet now leaves as its own status and code. Two unrelated refusals,
    // so the mapping cannot be a special case for one of them.
    for (const [status, code] of [[422, 'ACCOUNTS_ARE_KEYLESS'], [409, 'LEGACY_FROZEN']] as const) {
      const slug = `fixb-map-${tag()}`;
      const spy = jest.spyOn(principalService, 'issueCredential')
        .mockRejectedValueOnce(new CredentialPolicyError(status, code, 'injected'));
      try {
        const answer = await call(SESSIONS.user, 'POST', '/services', connectBody(slug, ['tasks:read']));
        expect(answer.status).toBe(status);
        expect(answer.json.code).toBe(code);
      } finally {
        spy.mockRestore();
      }
      expect(await serviceRowsFor(slug)).toBe(0);
    }
  });
});

describe('CONTROL — the transactional change did not break the plain paths', () => {
  it('a registration WITHOUT a credential request still commits', async () => {
    // `register` now branches on whether a caller transaction was supplied. The
    // branch with none is the one every other caller in the product uses.
    const slug = `fixb-plain-${tag()}`;
    const answer = await call(SESSIONS.admin, 'POST', '/services', {
      slug, name: slug, description: 'A plain service row.', kind: 'service',
    });
    expect(answer.status).toBe(201);
    expect(await serviceRowsFor(slug)).toBe(1);
  });

  it('a dry run still writes nothing', async () => {
    const slug = `fixb-dry-${tag()}`;
    const answer = await call(SESSIONS.admin, 'POST', '/services?dryRun=true', {
      slug, name: slug, description: 'A dry run.', kind: 'service',
    });
    expect(answer.status).toBe(201);
    expect(answer.json.dryRun).toBe(true);
    expect(await serviceRowsFor(slug)).toBe(0);
  });

  it('a session may still not ask for more than it holds (CONTROL for the catalogue arms below)', async () => {
    // ISSUE_EXCEEDS_SESSION (§5.2 rule 1) is the ceiling the delegable set sits
    // under. Widening it would be an authorization defect, so it is measured
    // here rather than assumed to be untouched.
    const slug = `fixb-exceeds-${tag()}`;
    const answer = await call(SESSIONS.user, 'POST', '/services',
      connectBody(slug, ['tasks:read', 'principals:admin']));
    expect(answer.status).toBe(403);
    expect(answer.json.code).toBe('ISSUE_EXCEEDS_SESSION');
    expect(await serviceRowsFor(slug)).toBe(0);
  });
});

/**
 * THE DAY-ONE DEFAULT MUST BE ABLE TO BOOTSTRAP (card `07d09eaf`).
 *
 * The owner minted a connection on TST with the wizard's day-one default and
 * the agent could do nothing at all. Every work-plane MCP tool is closed to a
 * credential until it calls `relayhall_brief_compile {session: true}`; that
 * call reads the caller's own principal and so sits behind `principals:read`;
 * and the template working set the wizard defaulted to does not carry it. The
 * flow ended in `403 FORBIDDEN: This call needs the principals:read scope` for
 * the exact person the flow exists for.
 *
 * The owner ruled the DEFAULT, not the check (2026-09-07): a new connection
 * starts with the whole delegable catalogue and narrows from there. So what is
 * measured below is the CATALOGUE, end to end — minted through the production
 * route the wizard calls, presented to the production MCP ingress, on a real
 * database.
 *
 * WHY IT IS HERE AND NOT IN A UNIT TEST. Three seams have to hold at once and
 * only one of them is a function: `POST /services` must accept the whole
 * catalogue from a first-run administrator; the stored credential must carry
 * it; and the MCP ingress must let that credential bootstrap and then reach the
 * work plane. A mocked pool answers the first and cannot answer the other two —
 * the thing that would be wrong is the row that was stored, and the gate is a
 * row in `mcp_bootstrap_records`.
 *
 * THE RED ARM IS THE DEFECT ITSELF, reproduced verbatim rather than described:
 * the same route, the same ingress, the same call, with the OLD default. If the
 * repair were undone, that arm goes green and the arm beside it goes red.
 */
describe('the wizard default bootstraps (card 07d09eaf)', () => {
  /**
   * The set the wizard used to mint — `AGENT_WORKING_SCOPES` in
   * `frontend/src/types/connections.ts`, and exactly the scope list the card
   * reports from the credential the owner minted on TST.
   *
   * It is written out because the frontend package cannot be imported from a
   * backend suite, and it is NOT trusted: the arm below asserts the PREMISE
   * (that this set omits the bootstrap scope) before it asserts the
   * consequence. If the frontend list ever drifts, this stops measuring "the
   * old default" and keeps measuring the property that matters — a credential
   * without `principals:read` cannot bootstrap — or fails outright.
   */
  const OLD_WIZARD_DEFAULT = [
    'tasks:read', 'tasks:write', 'reports:read', 'reports:write',
    'projects:read', 'phases:read', 'skills:read', 'skills:use',
  ];

  /** What `relayhall_brief_compile {session: true}` sits behind. */
  const BOOTSTRAP_SCOPE = 'principals:read';

  /**
   * A work-plane READ the bootstrap gate actually closes.
   *
   * The card says "and can then call `relayhall_task_list`", and that arm is
   * below — but `task_list` is bootstrap-EXEMPT by design, so on its own it
   * would pass against a board with no gate at all. `relayhall_blueprint_list`
   * is `plane: 'work'`, so it is the one that proves the gate opened.
   */
  const GATED_WORK_READ = 'relayhall_blueprint_list';

  async function connectAs(caller: Caller, scopes: string[], transport: 'mcp' | 'api' = 'mcp') {
    const slug = `dayone-boot-${tag()}`;
    const created = await call(caller, 'POST', '/services', connectBody(slug, scopes, transport));
    expect(created.status).toBe(201);
    const token: string = created.json.onboarding.credential.secretOnce;
    expect(token).toMatch(TOKEN);
    return { slug, token };
  }

  it('RED — the set the wizard used to default to cannot bootstrap, and the work plane stays shut', async () => {
    const me = await call(SESSIONS.admin, 'GET', '/principals/me');
    const delegable: string[] = me.json.delegableScopes;
    // The premise, asserted rather than assumed.
    expect(OLD_WIZARD_DEFAULT).not.toContain(BOOTSTRAP_SCOPE);
    expect(delegable).toContain(BOOTSTRAP_SCOPE);

    const { token } = await connectAs(SESSIONS.admin, OLD_WIZARD_DEFAULT);

    const boot = await mcpCall(token, BOOTSTRAP_VERB, { session: true });
    expect(mcpFailed(boot)).toBe(true);
    // The owner's own sentence, from the board rather than from this file.
    expect(mcpText(boot)).toContain(BOOTSTRAP_SCOPE);

    // And with the bootstrap refused, the work plane is closed — which is what
    // "the agent can call nothing that changes board state" meant.
    const work = await mcpCall(token, GATED_WORK_READ);
    expect(mcpText(work)).toContain(BOOTSTRAP_REFUSAL_MARKER);
  });

  it('GREEN — a credential carrying the ruled default bootstraps, then reaches the work plane', async () => {
    const me = await call(SESSIONS.admin, 'GET', '/principals/me');
    const delegable: string[] = me.json.delegableScopes;
    const { token } = await connectAs(SESSIONS.admin, delegable);

    const boot = await mcpCall(token, BOOTSTRAP_VERB, { session: true });
    expect(mcpFailed(boot)).toBe(false);
    expect(mcpText(boot)).not.toContain(BOOTSTRAP_REFUSAL_MARKER);
    // The tool says when the bootstrap lapses, which is the observable proof it
    // recorded one rather than merely answering.
    expect(mcpText(boot)).toContain('Bootstrapped');

    // The card's own next step.
    const tasks = await mcpCall(token, 'relayhall_task_list');
    expect(mcpFailed(tasks)).toBe(false);
    expect(mcpText(tasks)).not.toContain(BOOTSTRAP_REFUSAL_MARKER);

    // And a tool the gate genuinely closed a moment ago, so this is the gate
    // opening rather than a tool that was never shut.
    const work = await mcpCall(token, GATED_WORK_READ);
    expect(mcpText(work)).not.toContain(BOOTSTRAP_REFUSAL_MARKER);
    expect(mcpFailed(work)).toBe(false);
  });

  it('a first-run administrator mints the WHOLE delegable catalogue in one act', async () => {
    // The wizard sends one `POST /services`. The ruled default is the board's
    // own `delegableScopes` answer, so the route has to accept all of it — every
    // `:admin` family included — or the ruling names a button that 403s.
    const me = await call(SESSIONS.admin, 'GET', '/principals/me');
    const delegable: string[] = me.json.delegableScopes;
    expect(delegable).toEqual(MINTABLE_SCOPES.filter((scope: string) => scope !== ROOT_SCOPE));

    // `api` here, so the credential can be introspected over REST; the `mcp`
    // arms above cover the transport the wizard's agent templates actually pin.
    const { token } = await connectAs(SESSIONS.admin, delegable, 'api');
    const whoami = await call(bearer('catalogue connector', '', token), 'GET', '/principals/me');
    expect(whoami.status).toBe(200);
    expect(new Set(whoami.json.scopes)).toEqual(new Set(delegable));
    expect(whoami.json.scopes).not.toContain(ROOT_SCOPE);
    expect(whoami.json.scopes).toContain(BOOTSTRAP_SCOPE);
  });

  it('CONTROL — a Member mints THEIR whole delegable set, which is smaller', async () => {
    // The ruling widened the default, not the ceiling. Without this arm, the
    // one above is satisfied by a route that hands every caller everything.
    const me = await call(SESSIONS.user, 'GET', '/principals/me');
    const delegable: string[] = me.json.delegableScopes;
    expect(delegable.length).toBeGreaterThan(0);
    expect(delegable.length).toBeLessThan(MINTABLE_SCOPES.length - 1);

    const { token } = await connectAs(SESSIONS.user, delegable, 'api');
    const whoami = await call(bearer('member connector', '', token), 'GET', '/principals/me');
    expect(whoami.status).toBe(200);
    expect(new Set(whoami.json.scopes)).toEqual(new Set(delegable));
    expect(whoami.json.scopes).not.toContain(ROOT_SCOPE);
  });
});

// ─────────────────────────────────────────────────────────────────────────────

/**
 * THE UNIFIED CREATE-IDENTITY FLOW (card `5592baf6`, defect `43fcd071`).
 *
 * Access administration used to offer a four-field "New principal" form that
 * could not complete two of the three kinds it listed. Both refusals are
 * substrate rules, not form bugs, and the unified wizard is shaped by them —
 * so what the wizard does per kind is measured here, against the real routes
 * and a real database, in the order the wizard calls them.
 *
 * The arms below are the three kinds and the two refusals that decide their
 * shape. Together they answer: is the sequence the frontend performs actually
 * one the board admits?
 */
describe('Create identity — the sequence each kind actually performs (card 5592baf6)', () => {
  it('SERVICE step 2: a purpose is required, and the refusal is the sentence the form mirrors', async () => {
    const refusal = await call(SESSIONS.admin, 'POST', '/principals', {
      handle: `unify-nopurpose-${tag()}`, kind: 'service', role: 'agent',
    });
    expect(refusal.status).toBe(422);
    expect(refusal.json?.code).toBe('PURPOSE_REQUIRED');
    // The frontend refuses with this exact string before the request is made
    // (`frontend/src/types/identities.ts`), and `identityPurposeRuleDrift`
    // fails the build if the two stop agreeing.
    expect(refusal.json?.message).toBe(
      'service Accounts must declare a purpose at creation (design 4d961e37 A17.1)');
  });

  it('AGENT: the directory route refuses kind=agent, which is why that arm is a connection', async () => {
    const refusal = await call(SESSIONS.admin, 'POST', '/principals', {
      handle: `unify-agent-${tag()}`, kind: 'agent', role: 'agent',
    });
    expect(refusal.status).toBe(422);
    expect(refusal.json?.code).toBe('AGENT_MINT_ONLY');
  });

  it('SERVICE: create → the Account is keyless → its credential is a CONNECTOR under it', async () => {
    const handle = `unify-svc-${tag()}`;
    const created = await call(SESSIONS.admin, 'POST', '/principals', {
      handle, kind: 'service', role: 'agent', displayName: 'Unify service',
      purpose: 'Runs the nightly build and files its reports.',
    });
    expect(created.status).toBe(201);
    const accountId = String(created.json?.principal?.id);
    expect(accountId).toMatch(/^[0-9a-f-]{36}$/);

    // WHY THE WIZARD DOES NOT SIMPLY MINT. A parentless Account holds no bearer
    // key (A17.1/§7.1). A surface that offered one would be offering an act the
    // board refuses, which is exactly the class of defect this card is about.
    const direct = await call(SESSIONS.admin, 'POST', `/principals/${accountId}/credentials`, {
      scopes: ['tasks:read'], label: handle, transport: 'api',
    });
    expect(direct.status).toBe(422);
    expect(direct.json?.code).toBe('ACCOUNTS_ARE_KEYLESS');

    // So step 3 registers a Connector UNDER the Account it just made and issues
    // that Connector's credential — one transaction, §7.4's one-time pack.
    const delegable = await call(SESSIONS.admin, 'GET', '/principals/me');
    const scopes: string[] = delegable.json?.delegableScopes ?? [];
    expect(scopes.length).toBeGreaterThan(0);

    const connection = await call(SESSIONS.admin, 'POST', '/services', {
      slug: handle, name: 'Unify service', description: `Connection for the ${handle} service identity.`,
      kind: 'connector', ownerAccountId: accountId,
      issueCredential: { scopes, label: handle, transport: 'api' },
    });
    expect(connection.status).toBe(201);
    const secret = connection.json?.onboarding?.credential?.secretOnce;
    expect(secret).toMatch(TOKEN);

    // The Connector really is parented to the new Account — not to the
    // administrator who ran the flow, which is what `ownerAccountId` is for.
    const parentage = await pool.query(
      `SELECT p.parent_principal_id FROM services s
         JOIN principals p ON p.id = s.principal_id
        WHERE s.slug = $1`, [handle]);
    expect(String(parentage.rows[0]?.parent_principal_id)).toBe(accountId);

    // And the credential authenticates as that Connector, so the flow ends with
    // something that works rather than something that merely committed.
    const whoami = await call(bearer('new connector', 'unknown', secret), 'GET', '/principals/me');
    expect(whoami.status).toBe(200);
    expect(whoami.json?.principal?.kind).toBe('service');
  });

  it('HUMAN: the Account is created and stays keyless — a password, never a key', async () => {
    const handle = `unify-human-${tag()}`;
    const created = await call(SESSIONS.admin, 'POST', '/principals', {
      handle, kind: 'human', role: 'user', displayName: 'A colleague',
    });
    expect(created.status).toBe(201);
    const accountId = String(created.json?.principal?.id);
    const refusal = await call(SESSIONS.admin, 'POST', `/principals/${accountId}/credentials`, {
      scopes: ['tasks:read'], label: handle,
    });
    expect(refusal.status).toBe(422);
    expect(refusal.json?.code).toBe('ACCOUNTS_ARE_KEYLESS');
  });

  it('a Member reaches none of this: the directory act needs management authority', async () => {
    // The wizard lives behind a root-gated navigation entry. This is the reason
    // it may: the route itself refuses an ordinary session, so the gate is not
    // the only thing standing between a Member and the identity directory.
    const refusal = await call(SESSIONS.user, 'POST', '/principals', {
      handle: `unify-member-${tag()}`, kind: 'service', role: 'agent', purpose: 'Nothing.',
    });
    expect(refusal.status).toBe(403);
  });

  it('a Member cannot register a connection under somebody else’s Account (§9.1)', async () => {
    const refusal = await call(SESSIONS.user, 'POST', '/services', {
      slug: `unify-steal-${tag()}`, name: 'Not mine', description: 'x', kind: 'connector',
      ownerAccountId: SESSIONS.admin.principalId,
      issueCredential: { scopes: ['tasks:read'], label: 'x', transport: 'api' },
    });
    expect(refusal.status).toBe(403);
    expect(refusal.json?.code).toBe('OWNER_OUT_OF_SUBTREE');
  });
});
