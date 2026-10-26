/**
 * Notifications and Timeline, Slice A (card 5854f0d6; owner ruling E394), over
 * a REAL PostgreSQL and the PRODUCTION router: `GET /notifications/actions`,
 * `GET /notifications/timeline` and `POST /notifications/timeline/seen` behind
 * the real authentication and the real shared-authorization middleware. The
 * test list is the design's section 7:
 *
 *   (1) two Accounts: A never sees B's Task, Report (promoted, outpost and
 *       deleted included), Phase, Project, Skill draft or approval rows in the
 *       Timeline or the action list; a bearer holding only tasks:read sees no
 *       report, phase, project or skill row; pages are never short; an
 *       outside-anchor read (the objects' own point routes) proves it; the
 *       report builder and filterVisibleReports return the same id set;
 *   (2) action items: each kind appears while its condition holds and leaves
 *       when it ends; Verify with no Verifier reaches the account owner; Stuck
 *       follows the sweep's activity clock, a linked Report included; skill
 *       reviews are not counted as Decisions; neither reaches a bearer; the
 *       bell's count is the actions total;
 *   (3) keyset paging: no feed row repeats or goes missing while rows are
 *       written between page reads; each approval and skill-version row is on
 *       exactly one page, past a feed row older than the next page (R2-B1); the
 *       late row appears after a refresh; capped mode (R2-N1); filters with
 *       paging;
 *   (4) filters: each one, with EXPLAIN on a seeded table for the index each
 *       uses, and the report arm for a non-administrator; (4b) the query on a
 *       realistic board (100,000 feed rows, seeded in a transaction that is
 *       rolled back): each filter's index, no sequential feed read, a p95
 *       budget, a bounded date window; (4c) the Timeline transaction: JIT off
 *       and a statement ceiling;
 *   (5) payloads: field names, never values; a public authored append yields
 *       exactly one feed row, an append referencing an assigned-only entry
 *       none, finish one; and the RUNTIME actor census: every route-level
 *       writer of a row the Timeline shows (REST, and the Phase create over
 *       the in-process MCP ingress) stores the acting principal, and the
 *       person-filtered Timeline finds that row;
 *   (6) the last-seen cursor: own row only, clamped, never backwards, never
 *       written by a GET;
 *   (7) the Action Center's text search (owner ruling E453): titles and labels,
 *       any case, the caller's wildcards taken literally; an object the caller
 *       cannot see never matches (two Accounts, the outside anchor), an approval
 *       row's hidden Task title never matches, and a searched page is never
 *       short (in-query, never after the LIMIT); (4b) measures it on the
 *       realistic board;
 *   (8) the seen mark on action items (owner ruling E455): a seen item stays
 *       listed and seen until resolved and the bell counts only the unseen; a
 *       new occurrence is unseen again; a key the caller cannot see is ignored
 *       without a trace; the mark is per caller.
 *
 * DESTRUCTIVE: writes principals, sessions, projects, phases, tasks, reports,
 * skills, approvals and feed rows (and a block of feed rows naming no object,
 * for the EXPLAIN tests). It refuses any deployment database and any non-local
 * host, and FAILS - never skips - without a disposable one. It is also
 * SELF-ISOLATING: it asserts only on the principals and rows it creates, so it
 * reads the same on a fresh database and on a full-tier job database that
 * earlier steps filled.
 */

/* eslint-disable @typescript-eslint/no-var-requires */

import http from 'http';
import crypto from 'crypto';

const TEST_DB_URL = process.env.RELAYHALL_TEST_DB_URL;
if (!TEST_DB_URL) {
  throw new Error('RELAYHALL_TEST_DB_URL is required: the Timeline drill measures stored rows, so it never skips. '
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
  throw new Error('Timeline drill refuses a non-disposable database target');
}

Object.assign(process.env, {
  DB_HOST: parsed.hostname, DB_PORT: parsed.port || '5432', DB_NAME: TEST_DB_NAME,
  DB_USER: decodeURIComponent(parsed.username), DB_PASSWORD: decodeURIComponent(parsed.password),
  NODE_ENV: 'test', RELAYHALL_SESSIONS: 'on', JWT_SECRET: crypto.randomBytes(32).toString('hex'),
});

jest.setTimeout(240_000);

interface App { server: http.Server; origin: string; pool: any; modules: Record<string, any> }

async function startApp(): Promise<App> {
  let modules: Record<string, any> = {};
  jest.isolateModules(() => {
    modules = {
      express: require('express'),
      connection: require('../db/connection'),
      routeRegistry: require('../routeRegistry'),
      auth: require('../middleware/auth'),
      shared: require('../middleware/sharedAuthorization'),
      apiErrors: require('../utils/apiErrors'),
      jsonBodyTypes: require('../utils/jsonBodyTypes'),
      sessions: require('../services/LoginSessionService'),
      stepUp: require('../services/StepUpService'),
      feed: require('../services/FeedEventService'),
      timeline: require('../services/TimelineService'),
      notificationsRoute: require('../routes/notifications'),
      reportVisibility: require('../services/ReportVisibility'),
      identityScopes: require('../utils/identityScopes'),
      mcpHttp: require('../mcp/httpRoute'),
    };
  });
  const app = modules.express();
  app.use(modules.express.json(modules.jsonBodyTypes.jsonBodyOptions));
  // The in-process MCP ingress: every tool dispatches through the same routers.
  app.use(modules.mcpHttp.MCP_ROUTE_PATH, modules.mcpHttp.default);
  modules.routeRegistry.registerProtectedRoutes((mountPath: string, ...handlers: any[]) => {
    app.use(mountPath, modules.auth.authMiddleware, modules.shared.sharedAuthorizationMiddleware, ...handlers);
  });
  app.use(modules.apiErrors.apiErrorHandler);
  const server: http.Server = await new Promise((resolve) => {
    const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
  });
  return {
    server, pool: modules.connection.pool, modules,
    origin: `http://127.0.0.1:${(server.address() as { port: number }).port}`,
  };
}

let APP: App;
const pool = () => APP.pool;

interface Caller { label: string; principalId: string; handle: string; role: string; headers: Record<string, string> }
interface Answer { status: number; json: any }

async function call(who: Caller, method: string, routePath: string, body?: unknown, extra: Record<string, string> = {}): Promise<Answer> {
  const response = await fetch(`${APP.origin}${routePath}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...who.headers, ...extra },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let json: any = null;
  try { json = JSON.parse(text); } catch { json = null; }
  return { status: response.status, json };
}
const skillMd = (name: string): string => ['---', `name: ${name}`, 'description: Timeline drill skill', '---', '', 'A drill skill.', ''].join('\n');
const idem = (): Record<string, string> => ({ 'Idempotency-Key': `nt-${crypto.randomUUID()}` });
const tag = (): string => crypto.randomBytes(5).toString('hex');

async function makeAccount(role: string, label: string): Promise<{ id: string; handle: string }> {
  const handle = `nt-${label}-${tag()}`;
  const result = await pool().query(
    `INSERT INTO principals (kind, handle, display_name, status, role) VALUES ('human', $1, $1, 'active', $2) RETURNING id`,
    [handle, role]);
  return { id: String(result.rows[0].id), handle };
}

async function sessionFor(label: string, role: string): Promise<Caller> {
  const account = await makeAccount(role, label);
  const minted = await APP.modules.sessions.loginSessionService.mint({ principalId: account.id });
  return {
    label, principalId: account.id, handle: account.handle, role,
    headers: { Cookie: `${APP.modules.sessions.SESSION_COOKIE_NAME}=${minted.token}` },
  };
}

/** A Connector of `owner` with exactly `scopes`, as a bearer caller. */
async function bearerFor(owner: Caller, scopes: string[]): Promise<Caller> {
  const slug = `nt-connector-${tag()}`;
  const registered = await call(owner, 'POST', '/services', {
    slug, name: slug, description: 'Timeline drill connector.', kind: 'connector',
    issueCredential: { scopes, label: slug, transport: 'api' },
  });
  expect(registered.status).toBe(201);
  const principal = (await pool().query('SELECT principal_id FROM services WHERE slug = $1', [slug])).rows[0].principal_id;
  return {
    label: slug, principalId: String(principal), handle: slug, role: 'service',
    headers: { Authorization: `Bearer ${registered.json.onboarding.credential.secretOnce}` },
  };
}

async function makeTask(owner: Caller, title: string, extra: Record<string, unknown> = {}): Promise<string> {
  const created = await call(owner, 'POST', '/tasks', { title, description: 'timeline drill', status: 'todo', ...extra });
  expect(created.status).toBe(201);
  return String(created.json?.task?.id);
}

async function makeProject(owner: Caller, name: string): Promise<string> {
  const created = await call(owner, 'POST', '/projects', { name }, idem());
  expect(created.status).toBe(201);
  return String(created.json.project.id);
}

/** Append a feed row exactly as an emitting write does: in a transaction, through the feed service. */
async function emit(input: {
  name: string; objectType: string; objectId: string; actor?: Caller | null; projectId?: string | null;
  ownerPrincipalId?: string | null; payload?: Record<string, unknown>;
}): Promise<string> {
  const client = await pool().connect();
  try {
    await client.query('BEGIN');
    await APP.modules.feed.feedEventService.emit(client, {
      name: input.name, objectType: input.objectType, objectId: input.objectId,
      actorPrincipalId: input.actor?.principalId ?? null, actorHandle: input.actor?.handle ?? null,
      projectId: input.projectId ?? null, ownerPrincipalId: input.ownerPrincipalId ?? null, payload: input.payload ?? {},
    });
    const cursor = (await client.query('SELECT max(cursor)::text AS c FROM feed_events')).rows[0].c;
    await client.query('COMMIT');
    return String(cursor);
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

async function timeline(who: Caller, query = ''): Promise<Answer> {
  return call(who, 'GET', `/notifications/timeline${query ? `?${query}` : ''}`);
}

/** Every Timeline row under a query, page by page (an ABSENCE is checked over every page, never the first). */
async function allPages(who: Caller, query: string, limit = 100, between?: (page: number) => Promise<void>): Promise<{ items: any[]; pages: any[][] }> {
  const items: any[] = [];
  const pages: any[][] = [];
  let before: string | null = null;
  for (let guard = 0; guard < 400; guard += 1) {
    const answer = await timeline(who, `${query}${query ? '&' : ''}limit=${limit}${before ? `&before=${encodeURIComponent(before)}` : ''}`);
    expect(answer.status).toBe(200);
    items.push(...answer.json.items);
    pages.push(answer.json.items);
    if (!answer.json.hasMore) return { items, pages };
    before = answer.json.nextCursor;
    if (between) await between(guard);
  }
  // An assertion, not a crash: a keyset that re-admits its last row never ends.
  expect('paging terminated within 400 pages: false').toBe('paging terminated within 400 pages: true');
  throw new Error('unreachable');
}

/** One MCP tools/call over the in-process ingress, as an rh_ bearer. */
async function mcpCall(token: string, name: string, args: Record<string, unknown>): Promise<Answer> {
  const response = await fetch(`${APP.origin}${APP.modules.mcpHttp.MCP_ROUTE_PATH}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
  });
  const text = await response.text();
  let json: any = null;
  try { json = JSON.parse(text); } catch { json = null; }
  return { status: response.status, json };
}

async function actions(who: Caller): Promise<Answer> {
  return call(who, 'GET', '/notifications/actions');
}

/** A request shape the shared middleware would hand a route, for the in-process builders (parity, EXPLAIN). */
function requestOf(who: Caller): any {
  return {
    principal: { id: who.principalId, handle: who.handle, kind: 'human', role: who.role },
    userId: who.handle, authMethod: 'session', sessionRole: who.role,
    scopes: APP.modules.identityScopes.scopesForRole(who.role),
  };
}

let A: Caller;        // an ordinary Account
let B: Caller;        // another ordinary Account
let ROOT: Caller;     // role admin: root
let A_READ: Caller;   // A's Connector holding ONLY tasks:read
let C: Caller;        // a third Account granted read on B's Task, and nothing of its assignment
let B_BEARER: Caller; // B's Connector holding tasks:read and tasks:write

// A's objects.
let PA: string; let TA: string; let PHA: string; let RA: string;
// B's objects: one of each type the Timeline lists.
let PB: string; let TB: string; let PHB: string; let RB: string; let RB_PROMOTED: string; let RB_OUTPOST: string;
let RB_DELETED: string; let SB: string; let APPROVAL_B: string;
const bObjectIds = new Set<string>();

beforeAll(async () => {
  APP = await startApp();
  A = await sessionFor('alice', 'user');
  B = await sessionFor('bob', 'user');
  ROOT = await sessionFor('root', 'admin');
  A_READ = await bearerFor(A, ['tasks:read']);
  B_BEARER = await bearerFor(B, ['tasks:read', 'tasks:write']);
  C = await sessionFor('carol', 'user');

  // ── A's world ──
  PA = await makeProject(A, `NT alpha ${tag()}`);
  TA = await makeTask(A, `NT alpha task ${tag()}`, { project: PA });
  const phaseA = await call(A, 'POST', '/phases', { projectId: PA, name: `NT alpha phase ${tag()}` }, idem());
  expect(phaseA.status).toBe(201);
  PHA = String(phaseA.json.phase.id);
  const reportA = await call(A, 'POST', '/reports', { title: `NT alpha report ${tag()}`, content: 'alpha evidence', project_id: PA, task_ids: [TA] }, idem());
  expect(reportA.status).toBe(201);
  RA = String(reportA.json.report.id);
  await emit({ name: 'project.updated', objectType: 'project', objectId: PA, actor: A, projectId: PA });
  // A published Skill of A's: a skill row and a skill-version row A's session
  // reads, so the per-kind bearer test below has something to withhold.
  const alphaSkill = `nt-alpha-${tag()}`;
  const published = await call(A, 'POST', '/skills', { name: alphaSkill, skill_md: skillMd(alphaSkill), description: 'alpha published' });
  expect(published.status).toBe(201);
  const alphaSkillId = String(published.json.skill.id);
  const alphaRevision = async (): Promise<string> =>
    String((await pool().query('SELECT revision::text AS r FROM skills WHERE id = $1', [alphaSkillId])).rows[0].r);
  expect((await call(A, 'POST', `/skills/${alphaSkillId}/versions/1/submit-review`, {}, { 'If-Match': await alphaRevision() })).status).toBe(200);
  expect((await call(ROOT, 'POST', `/skills/${alphaSkillId}/versions/1/publish`, {}, { 'If-Match': await alphaRevision() })).status).toBe(200);

  // ── B's world: one row of every type ──
  PB = await makeProject(B, `NT bravo SECRET ${tag()}`);
  // B's world is private to B: no other Account reads it through any arm.
  await pool().query("UPDATE projects SET visibility = 'private' WHERE id = $1", [PB]);
  TB = await makeTask(B, `NT bravo SECRET task ${tag()}`, { project: PB });
  const phaseB = await call(B, 'POST', '/phases', { projectId: PB, name: `NT bravo SECRET phase ${tag()}` }, idem());
  expect(phaseB.status).toBe(201);
  PHB = String(phaseB.json.phase.id);
  await emit({ name: 'phase.updated', objectType: 'phase', objectId: PHB, actor: B, projectId: PB });
  await emit({ name: 'project.updated', objectType: 'project', objectId: PB, actor: B, projectId: PB });
  const reportB = await call(B, 'POST', '/reports', { title: `NT bravo SECRET report ${tag()}`, content: 'bravo evidence', project_id: PB, task_ids: [TB], visibility: 'private' }, idem());
  expect(reportB.status).toBe(201);
  RB = String(reportB.json.report.id);
  // A promoted Report from B's Task, an assigned-only outpost Report, and a
  // soft-deleted one: written as the finish surface writes them, announced.
  const insertReport = async (title: string, fields: Record<string, unknown>): Promise<string> => {
    const id = crypto.randomUUID();
    await pool().query(
      `INSERT INTO reports (id, title, content, summary, project_id, task_ids, author, author_actor_id, author_principal_id,
                            origin, auto_promoted, source_task_id, source_outpost_visibility_tier)
       VALUES ($1, $2, 'bravo content', 'bravo', $3, ARRAY[$4]::uuid[], $5, $6::text, $6::uuid, 'task-finish', $7, $4, $8)`,
      [id, title, PB, TB, B.handle, B.principalId, fields.autoPromoted === true, fields.tier ?? null]);
    await emit({ name: 'report.created', objectType: 'report', objectId: id, actor: B, projectId: PB, ownerPrincipalId: B.principalId });
    return id;
  };
  RB_PROMOTED = await insertReport(`NT bravo SECRET promoted ${tag()}`, { autoPromoted: true });
  RB_OUTPOST = await insertReport(`NT bravo SECRET outpost ${tag()}`, { autoPromoted: true, tier: 'assigned-only' });
  RB_DELETED = await insertReport(`NT bravo SECRET deleted ${tag()}`, {});
  await pool().query('UPDATE reports SET deleted_at = now() WHERE id = $1', [RB_DELETED]);
  // B's unpublished Skill, submitted and RETURNED (a skill-version row).
  const bravoSkill = `nt-bravo-${tag()}`;
  const skill = await call(B, 'POST', '/skills', { name: bravoSkill, skill_md: skillMd(bravoSkill), description: 'bravo draft' });
  expect(skill.status).toBe(201);
  SB = String(skill.json.skill.id);
  const revisionOf = async (): Promise<string> => String((await pool().query('SELECT revision::text AS r FROM skills WHERE id = $1', [SB])).rows[0].r);
  expect((await call(B, 'POST', `/skills/${SB}/versions/1/submit-review`, {}, { 'If-Match': await revisionOf() })).status).toBe(200);
  expect((await call(ROOT, 'POST', `/skills/${SB}/versions/1/reject`, { note: 'returned by the drill' }, { 'If-Match': await revisionOf() })).status).toBe(200);
  // An approval of B's: its Connector asks to mint an Agent on B's Task.
  const requested = await call({ ...B_BEARER, headers: { ...B_BEARER.headers, 'Idempotency-Key': `nt-mint-${crypto.randomUUID()}` } },
    'POST', '/delegation/agent-mints', { targetTaskId: TB, requestedScopes: ['tasks:read'], via: 'approval' });
  expect([requested.status, requested.json?.path]).toEqual([202, 'approval']);
  APPROVAL_B = String(requested.json.approval.id);
  for (const id of [PB, TB, PHB, RB, RB_PROMOTED, RB_OUTPOST, RB_DELETED, SB, APPROVAL_B]) bObjectIds.add(id);
  // C reads B's Task through a grant, and holds no role in its assignment.
  await pool().query(`INSERT INTO grants (grantee_type, grantee_id, resource_type, resource_id, verb) VALUES ('principal', $1, 'task', $2, 'read')`,
    [C.principalId, TB]);
});

afterAll(async () => {
  if (APP) {
    await new Promise<void>((resolve) => APP.server.close(() => resolve()));
    await APP.pool.end();
  }
});

const objectIds = (items: any[]): Set<string> => new Set(items.map((item) => String(item.object.id)));
const titlesOf = (items: any[]): string => JSON.stringify(items);

describe('(1) two Accounts: A never sees what B owns', () => {
  it("A's Timeline holds none of B's Task, Report (promoted, outpost, deleted), Phase, Project, Skill draft or approval rows, on any page", async () => {
    const { items } = await allPages(A, 'acl=true');
    const leaked = items.filter((item) => bObjectIds.has(String(item.object.id))).map((item) => `${item.kind} ${item.object.type} ${item.object.id}`);
    expect(leaked).toEqual([]);
    expect(titlesOf(items)).not.toContain('bravo SECRET');
    expect(items.filter((item) => item.kind === 'approval' && item.object.id === APPROVAL_B)).toEqual([]);
    expect(items.filter((item) => item.kind === 'skill-version' && item.object.id === SB)).toEqual([]);
    // A's own rows are there: the read is not vacuously empty.
    for (const id of [TA, RA, PHA, PA]) expect(`${id}: ${objectIds(items).has(id)}`).toBe(`${id}: true`);
  });

  it("B's own Timeline lists its Task, Report, promoted and outpost Report, Phase, Project, returned skill version and approval (the negative control)", async () => {
    const { items } = await allPages(B, '');
    const seen = objectIds(items);
    for (const id of [TB, RB, RB_PROMOTED, RB_OUTPOST, PHB, PB, SB, APPROVAL_B]) expect(`${id}: ${seen.has(id)}`).toBe(`${id}: true`);
    expect(items.some((item) => item.kind === 'skill-version' && item.object.id === SB && item.detail.decision === 'returned')).toBe(true);
    // A soft-deleted Report is listed to nobody, its author included.
    expect(seen.has(RB_DELETED)).toBe(false);
  });

  it("A's action list holds none of B's items, and B's holds its own Decision", async () => {
    const forA = await actions(A);
    expect(forA.status).toBe(200);
    expect(forA.json.items.filter((item: any) => bObjectIds.has(String(item.object.id)))).toEqual([]);
    const forB = await actions(B);
    expect(forB.json.items.filter((item: any) => item.kind === 'decision' && item.object.id === APPROVAL_B)).toHaveLength(1);
  });

  it("a bearer holding only tasks:read reads its Account's task rows", async () => {
    const { items } = await allPages(A_READ, 'acl=true');
    expect(items.some((item) => item.object.id === TA)).toBe(true);
  });

  it.each(['report', 'phase', 'project', 'skill', 'skill-version'])('a bearer holding only tasks:read sees no %s row', async (kind) => {
    // By kind: a skill-version row names a Skill object, but has its own arm and ceiling.
    const ofKind = (items: any[]) => items.filter((item) => item.kind === kind || (kind !== 'skill' && item.object.type === kind));
    // Not vacuous: A's own session reads rows of this kind.
    expect(`${kind} rows for A's session: ${ofKind((await allPages(A, 'acl=true')).items).length > 0}`)
      .toBe(`${kind} rows for A's session: true`);
    const { items } = await allPages(A_READ, 'acl=true');
    expect(ofKind(items).map((item) => item.key)).toEqual([]);
  });

  it("a bearer never reads approval rows, even its own request's", async () => {
    const { items } = await allPages(B_BEARER, 'type=approval');
    expect(items).toEqual([]);
    expect((await allPages(B, 'type=approval')).items.some((item) => item.object.id === APPROVAL_B)).toBe(true);
  });

  it('an Account that reads the source Task reads the promoted Report and never the assigned-only outpost Report', async () => {
    const seen = objectIds((await allPages(C, 'type=report')).items);
    expect([seen.has(RB_PROMOTED), seen.has(RB_OUTPOST), seen.has(RB_DELETED)]).toEqual([true, false, false]);
  });

  it("A never sees the catalogue row of B's unpublished Skill", async () => {
    const { items } = await allPages(A, 'type=skill');
    expect(items.filter((item) => item.object.id === SB)).toEqual([]);
    expect((await allPages(B, 'type=skill')).items.some((item) => item.object.id === SB)).toBe(true);
  });

  it('pages are never short: every page before the last holds exactly the limit', async () => {
    for (const who of [A, B, C]) {
      const { pages } = await allPages(who, 'acl=true', 3);
      for (const page of pages.slice(0, -1)) expect(page.length).toBeGreaterThanOrEqual(3);
      expect(pages.reduce((n, page) => n + page.length, 0)).toBeGreaterThan(0);
    }
  });

  it("the outside anchor: every task, report, phase and project row A's Timeline names is readable at its own point route", async () => {
    const { items } = await allPages(A, 'acl=true');
    const routes: Record<string, string> = { task: '/tasks/', report: '/reports/', phase: '/phases/', project: '/projects/' };
    const checked = new Set<string>();
    for (const item of items) {
      const prefix = routes[item.object.type];
      if (!prefix || checked.has(item.object.id)) continue;
      checked.add(item.object.id);
      const point = await call(A, 'GET', `${prefix}${item.object.id}`);
      expect(`${item.object.type} ${item.object.id} -> ${point.status}`).toBe(`${item.object.type} ${item.object.id} -> 200`);
    }
    expect(checked.size).toBeGreaterThanOrEqual(4);
    // And B's own objects are concealed at those same routes for A.
    for (const [type, id] of [['tasks', TB], ['reports', RB], ['phases', PHB], ['projects', PB]]) {
      expect((await call(A, 'GET', `/${type}/${id}`)).status).toBe(404);
    }
  });

  it('the report list-scope builder and filterVisibleReports return the same id set for A and for B', async () => {
    const ids = [RA, RB, RB_PROMOTED, RB_OUTPOST, RB_DELETED];
    const rows = (await pool().query(
      `SELECT id::text AS id, auto_promoted, source_task_id::text AS source_task_id, source_outpost_visibility_tier, deleted_at
         FROM reports WHERE id = ANY($1::uuid[])`, [ids])).rows;
    for (const who of [A, B, C]) {
      const req = requestOf(who);
      const viaFilter = (await APP.modules.reportVisibility.filterVisibleReports(req, rows.filter((row: any) => row.deleted_at === null)))
        .map((row: any) => row.id).sort();
      const scope = APP.modules.shared.authorizedListScope(req, 'report', 'read');
      const params: unknown[] = [ids];
      const narrowing = scope.render(params.length + 1);
      params.push(...narrowing.params);
      const visibility = APP.modules.reportVisibility.reportVisibilitySql('r', APP.modules.reportVisibility.reportVisibilityInput(req), params);
      const viaBuilder = (await pool().query(
        `SELECT r.id::text AS id FROM ${scope.from} WHERE r.id = ANY($1::uuid[]) AND ${narrowing.sql} AND ${visibility}`, params))
        .rows.map((row: any) => row.id).sort();
      expect({ who: who.label, ids: viaBuilder }).toEqual({ who: who.label, ids: viaFilter });
      expect(viaBuilder).not.toContain(RB_DELETED);
    }
  });

  it("a non-administrator skills:write holder never sees another owner's returned version of an unpublished Skill", async () => {
    const { items } = await allPages(A, 'type=skill-version');
    expect(items.filter((item) => item.object.id === SB)).toEqual([]);
    const forRoot = await allPages(ROOT, 'type=skill-version');
    expect(forRoot.items.filter((item) => item.object.id === SB).length).toBeGreaterThan(0);
  });

  it('a requester filtering by the decider learns nothing: the withheld actor never matches (R2-B3)', async () => {
    const stepUp = await APP.modules.stepUp.stepUpService.mint(ROOT.principalId, 'approval.decide', APPROVAL_B, 'password');
    const denied = await call(ROOT, 'POST', `/approvals/${APPROVAL_B}/deny`, { stepUpToken: stepUp.token, reason: 'timeline drill' });
    expect(denied.status).toBe(200);
    const all = (await allPages(B, 'type=approval')).items.filter((item) => item.object.id === APPROVAL_B);
    expect(all.map((item) => item.detail.action).sort()).toEqual(['approval.denied', 'approval.requested']);
    expect(all.find((item) => item.detail.action === 'approval.denied').actor.handle).toBeNull();
    const byDecider = (await allPages(B, `type=approval&person=${ROOT.principalId}`)).items;
    expect(byDecider.filter((item) => item.object.id === APPROVAL_B)).toEqual([]);
    // The decider itself sees its act under its own person filter.
    const forRoot = (await allPages(ROOT, `type=approval&person=${ROOT.principalId}`)).items;
    expect(forRoot.filter((item) => item.object.id === APPROVAL_B && item.detail.action === 'approval.denied')).toHaveLength(1);
  });
});

describe('(2) action items', () => {
  const kinds = async (who: Caller, kind: string, id: string): Promise<any[]> =>
    (await actions(who)).json.items.filter((item: any) => item.kind === kind && item.object.id === id);

  it('Decision: B decides its own Connector\'s mint request while it is pending, and it leaves when decided', async () => {
    const pending = await call({ ...B_BEARER, headers: { ...B_BEARER.headers, 'Idempotency-Key': `nt-mint-${crypto.randomUUID()}` } },
      'POST', '/delegation/agent-mints', { targetTaskId: TB, requestedScopes: ['tasks:read'], via: 'approval' });
    expect(pending.status).toBe(202);
    const id = String(pending.json.approval.id);
    expect(await kinds(B, 'decision', id)).toHaveLength(1);
    expect(await kinds(A, 'decision', id)).toHaveLength(0);
    const stepUp = await APP.modules.stepUp.stepUpService.mint(ROOT.principalId, 'approval.decide', id, 'password');
    expect((await call(ROOT, 'POST', `/approvals/${id}/deny`, { stepUpToken: stepUp.token, reason: 'drill' })).status).toBe(200);
    expect(await kinds(B, 'decision', id)).toHaveLength(0);
  });

  it('a pending item this session cannot decide is not a Decision: a grant request waits on an administrator', async () => {
    const mint = await call({ ...B_BEARER, headers: { ...B_BEARER.headers, 'Idempotency-Key': `nt-mint-${crypto.randomUUID()}` } },
      'POST', '/delegation/agent-mints', { targetTaskId: TB, requestedScopes: ['tasks:read'], via: 'approval' });
    expect(mint.status).toBe(202);
    const mintId = String(mint.json.approval.id);
    const stepUp = await APP.modules.stepUp.stepUpService.mint(B.principalId, 'approval.decide', mintId, 'password');
    expect((await call(B, 'POST', `/approvals/${mintId}/approve`, { stepUpToken: stepUp.token })).status).toBe(200);
    const collected = await call(B_BEARER, 'POST', `/delegation/agent-mints/${mintId}/collect`, {}, { 'Idempotency-Key': `nt-collect-${crypto.randomUUID()}` });
    expect(collected.status).toBe(201);
    const agent: Caller = { label: 'agent', principalId: '', handle: 'agent', role: 'agent', headers: { Authorization: `Bearer ${collected.json.pack.secretOnce}` } };
    const filed = await call(agent, 'POST', '/delegation/access-requests', {
      kind: 'grant', reason: 'Timeline drill: a grant request waits on an administrator.', relatedTaskId: TB,
      requestedRules: [{ resourceType: 'task', selectorForm: 'exact', selectorIds: [TA], verbs: ['read'] }],
    });
    expect(filed.status).toBe(202);
    const grantRequest = String(filed.json.approval.id);
    // Self-isolating: an administrator decides every pending request on the
    // board, and the job database may already hold hundreds from earlier
    // steps. Each kind lists the items that have waited LONGEST, oldest first,
    // up to ACTIONS_KIND_CAP (design section 3.2/3.3), so this request is made
    // the longest-waiting one by moving its own filing time; no other row is
    // touched, and the list's own order and cap decide the rest.
    await pool().query(
      `UPDATE approvals SET requested_at = (SELECT min(requested_at) FROM approvals WHERE status = 'pending') - interval '1 minute'
        WHERE id = $1`, [grantRequest]);
    expect(await kinds(B, 'decision', grantRequest)).toEqual([]);
    expect(await kinds(ROOT, 'decision', grantRequest)).toHaveLength(1);
  });

  it('Verify: a Task in Review whose Verifier is the caller is listed, and leaves when it is no longer in Review', async () => {
    const task = await makeTask(B, `NT verify ${tag()}`);
    await pool().query("UPDATE tasks SET status = 'review', verifier_principal_id = $2 WHERE id = $1", [task, A.principalId]);
    await pool().query(`INSERT INTO grants (grantee_type, grantee_id, resource_type, resource_id, verb) VALUES ('principal', $1, 'task', $2, 'read')`,
      [A.principalId, task]);
    const listed = await kinds(A, 'verify', task);
    expect(listed).toHaveLength(1);
    expect(listed[0].reasons).toContain('verifier');
    await pool().query("UPDATE tasks SET status = 'completed' WHERE id = $1", [task]);
    expect(await kinds(A, 'verify', task)).toHaveLength(0);
  });

  it('Verify (no Verifier) reaches the account owner, and leaves when a usable Verifier is set', async () => {
    const task = await makeTask(B, `NT no verifier ${tag()}`);
    await pool().query("UPDATE tasks SET status = 'review', verifier_principal_id = NULL, account_owner_principal_id = $2 WHERE id = $1", [task, B.principalId]);
    const listed = await kinds(B, 'verify', task);
    expect(listed).toHaveLength(1);
    expect(listed[0].reasons).toEqual(['no-verifier']);
    expect(await kinds(A, 'verify', task)).toHaveLength(0);
    await pool().query('UPDATE tasks SET verifier_principal_id = $2 WHERE id = $1', [task, ROOT.principalId]);
    expect(await kinds(B, 'verify', task)).toHaveLength(0);
  });

  it("Stuck follows the sweep's activity clock: a status, an announced episode, and a linked Report that re-arms it", async () => {
    const task = await makeTask(B, `NT stuck ${tag()}`);
    await pool().query("UPDATE tasks SET status = 'stuck', shepherd_principal_id = $2 WHERE id = $1", [task, B.principalId]);
    expect((await kinds(B, 'stuck', task))[0]?.reasons).toEqual(['status']);
    // In progress with no announced episode: nothing.
    await pool().query("UPDATE tasks SET status = 'in-progress' WHERE id = $1", [task]);
    expect(await kinds(B, 'stuck', task)).toHaveLength(0);
    // The sweep announces an episode (its own clock is the Task's start).
    await pool().query("UPDATE tasks SET started_at = now() - interval '2 hours' WHERE id = $1", [task]);
    await emit({ name: 'task.stuck', objectType: 'task', objectId: task, payload: { reason: 'status_stale' } });
    const open = await kinds(B, 'stuck', task);
    expect(open.map((item: any) => [item.reasons, item.detail.reason])).toEqual([[['episode'], 'status_stale']]);
    // A is not the addressee and reads nothing of it.
    expect(await kinds(A, 'stuck', task)).toHaveLength(0);
    // A newly linked Report is qualifying activity: the episode is over.
    await pool().query(
      `INSERT INTO reports (id, title, content, task_ids, author_principal_id, origin) VALUES (gen_random_uuid(), 'fresh', 'fresh activity', ARRAY[$1]::uuid[], $2, 'api')`,
      [task, B.principalId]);
    expect(await kinds(B, 'stuck', task)).toHaveLength(0);
  });

  it('Skill review: a human administrator who did not write the version lists it, never as a Decision, until it is published', async () => {
    const reviewSkill = `nt-review-${tag()}`;
    const skill = await call(A, 'POST', '/skills', { name: reviewSkill, skill_md: skillMd(reviewSkill), description: 'review' });
    expect(skill.status).toBe(201);
    const id = String(skill.json.skill.id);
    const revisionOf = async (): Promise<string> => String((await pool().query('SELECT revision::text AS r FROM skills WHERE id = $1', [id])).rows[0].r);
    expect((await call(A, 'POST', `/skills/${id}/versions/1/submit-review`, {}, { 'If-Match': await revisionOf() })).status).toBe(200);
    const forRoot = await actions(ROOT);
    expect(forRoot.json.items.filter((item: any) => item.kind === 'skill' && item.object.id === id)).toHaveLength(1);
    expect(forRoot.json.items.filter((item: any) => item.kind === 'decision' && item.reasons.includes('skill-publish'))).toEqual([]);
    // The author holds no skills:admin and wrote it: never listed to A.
    expect(await kinds(A, 'skill', id)).toHaveLength(0);
    expect((await call(ROOT, 'POST', `/skills/${id}/versions/1/publish`, {}, { 'If-Match': await revisionOf() })).status).toBe(200);
    expect(await kinds(ROOT, 'skill', id)).toHaveLength(0);
  });

  it("Decisions and Skill reviews never reach a bearer, even its own Account's", async () => {
    const still = await call({ ...B_BEARER, headers: { ...B_BEARER.headers, 'Idempotency-Key': `nt-mint-${crypto.randomUUID()}` } },
      'POST', '/delegation/agent-mints', { targetTaskId: TB, requestedScopes: ['tasks:read'], via: 'approval' });
    expect(still.status).toBe(202);
    expect((await actions(B)).json.counts.decision).toBeGreaterThan(0);
    for (const bearer of [B_BEARER, A_READ]) {
      const answer = await actions(bearer);
      expect(answer.status).toBe(200);
      expect([answer.json.counts.decision, answer.json.counts.skill]).toEqual([0, 0]);
      expect(answer.json.items.filter((item: any) => item.kind === 'decision' || item.kind === 'skill')).toEqual([]);
    }
  });

  it("the bell's count is the actions total: every item counted once, by kind", async () => {
    for (const who of [A, B, ROOT, B_BEARER]) {
      const answer = (await actions(who)).json;
      const byKind = (kind: string) => answer.items.filter((item: any) => item.kind === kind).length;
      expect(answer.counts).toEqual({
        decision: byKind('decision'), verify: byKind('verify'), stuck: byKind('stuck'), skill: byKind('skill'),
        total: answer.items.length,
        unseen: answer.items.filter((item: any) => item.seen !== true).length,
      });
      expect(new Set(answer.items.map((item: any) => item.key)).size).toBe(answer.items.length);
    }
  });
});

describe('(3) keyset paging', () => {
  it('no feed row repeats or goes missing across pages while rows are written between page reads', async () => {
    const task = await makeTask(A, `NT paging ${tag()}`);
    for (let i = 0; i < 23; i += 1) await emit({ name: 'task.updated', objectType: 'task', objectId: task, actor: A, payload: { fields: ['notes'] } });
    const snapshot = (await allPages(A, 'type=update', 100)).items.filter((item) => item.object.id === task).map((item) => item.key);
    expect(snapshot).toHaveLength(23);
    let written = 0;
    const paged = (await allPages(A, 'type=update', 5, async () => {
      written += 1;
      await emit({ name: 'task.updated', objectType: 'task', objectId: task, actor: A, payload: { fields: ['notes'] } });
    })).items.filter((item) => item.object.id === task).map((item) => item.key);
    expect(written).toBeGreaterThan(3);
    expect(paged).toEqual(snapshot);
    expect(new Set(paged).size).toBe(paged.length);
  });

  it('each approval and skill-version row is on exactly one page, past a feed row older than the next page (R2-B1)', async () => {
    // B's own rows: its approvals and its returned skill version are windowed.
    const task = await makeTask(B, `NT windows ${tag()}`);
    // A long transaction's row: committed late, with an OLD occurred_at.
    await pool().query(
      `INSERT INTO feed_events (name, object_type, object_id, occurred_at, payload)
       VALUES ('task.updated', 'task', $1, now() - interval '400 days', '{"fields":["notes"]}')`, [task]);
    for (let i = 0; i < 6; i += 1) await emit({ name: 'task.updated', objectType: 'task', objectId: task, payload: { fields: ['title'] } });
    const everything = await allPages(B, '', 100);
    const keyed = (items: any[]) => items.filter((item) => item.kind === 'approval' || item.kind === 'skill-version').map((item) => item.key);
    const reference = keyed(everything.items);
    expect(reference.length).toBeGreaterThan(0);
    for (const limit of [1, 2, 3, 7]) {
      const paged = keyed((await allPages(B, '', limit)).items);
      expect(new Set(paged).size).toBe(paged.length);
      expect([...paged].sort()).toEqual([...reference].sort());
    }
  });

  it('a window holds at most a page of each windowed source, and paging on below a cut lists every row once', async () => {
    // Twelve approval rows of B's inside one feed page's window: the window
    // is cut at the page size and the next page continues below the cut.
    const task = await makeTask(B, `NT cut ${tag()}`);
    for (let i = 0; i < 12; i += 1) {
      await pool().query(
        `INSERT INTO approval_events (approval_id, action, actor_principal_id, actor_handle, occurred_at)
         VALUES ($1, 'approval.requested', $2, $3, now() - interval '1 second' * $4)`,
        [APPROVAL_B, B.principalId, B.handle, i]);
    }
    for (let i = 0; i < 4; i += 1) await emit({ name: 'task.updated', objectType: 'task', objectId: task, actor: B, payload: { fields: ['title'] } });
    const reference = (await allPages(B, '', 100)).items.filter((item) => item.kind === 'approval').map((item) => item.key);
    expect(reference.length).toBeGreaterThanOrEqual(12);
    for (const limit of [2, 5]) {
      const { pages } = await allPages(B, '', limit);
      for (const page of pages) {
        expect(page.filter((item) => item.kind === 'approval').length).toBeLessThanOrEqual(limit);
        expect(page.filter((item) => item.kind === 'skill-version').length).toBeLessThanOrEqual(limit);
      }
      const paged = pages.flat().filter((item) => item.kind === 'approval').map((item) => item.key);
      expect(new Set(paged).size).toBe(paged.length);
      expect([...paged].sort()).toEqual([...reference].sort());
    }
  });

  it('a row committed after page 1 inside a window already served appears after a refresh, never mid-scroll', async () => {
    const first = await timeline(B, 'limit=2');
    expect(first.json.hasMore).toBe(true);
    // An approval event of B's stamped inside page 1's window, committed now.
    const late = (await pool().query(
      `INSERT INTO approval_events (approval_id, action, actor_principal_id, actor_handle, occurred_at)
       VALUES ($1, 'approval.requested', $2, $3, now() + interval '1 day') RETURNING id::text AS id`,
      [APPROVAL_B, B.principalId, B.handle])).rows[0].id;
    let rest: any[] = [];
    let before = first.json.nextCursor;
    for (let guard = 0; guard < 400 && before; guard += 1) {
      const page = await timeline(B, `limit=50&before=${encodeURIComponent(before)}`);
      rest = rest.concat(page.json.items);
      before = page.json.hasMore ? page.json.nextCursor : null;
    }
    expect(rest.filter((item) => item.key === `approval-event:${late}`)).toEqual([]);
    const refreshed = await timeline(B, 'limit=2');
    expect(refreshed.json.items.filter((item: any) => item.key === `approval-event:${late}`)).toHaveLength(1);
    expect(refreshed.json.headCursor.approvals > first.json.headCursor.approvals).toBe(true);
  });

  it('capped mode: a type filter of approvals only pages that arm on its own keyset, capped at the page size (R2-N1)', async () => {
    const all = (await allPages(B, 'type=approval', 100)).items.map((item) => item.key);
    expect(all.length).toBeGreaterThan(3);
    const { items, pages } = await allPages(B, 'type=approval', 2);
    for (const page of pages) expect(page.length).toBeLessThanOrEqual(2);
    expect(items.map((item) => item.key)).toEqual(all);
  });

  it('capped mode: a type filter of skill versions only pages that arm on its own keyset, capped at the page size (R2-N1)', async () => {
    // Four more returned versions of one of B's Skills: the arm has rows enough
    // to page two at a time, and a keyset that re-admits its last row repeats one.
    const name = `nt-bravo-capped-${tag()}`;
    const created = await call(B, 'POST', '/skills', { name, skill_md: skillMd(name), description: 'bravo capped draft' });
    expect(created.status).toBe(201);
    const skill = String(created.json.skill.id);
    const revision = async (): Promise<string> => String((await pool().query('SELECT revision::text AS r FROM skills WHERE id = $1', [skill])).rows[0].r);
    for (let round = 0; round < 4; round += 1) {
      expect((await call(B, 'POST', `/skills/${skill}/versions/1/submit-review`, {}, { 'If-Match': await revision() })).status).toBe(200);
      expect((await call(ROOT, 'POST', `/skills/${skill}/versions/1/reject`, { note: `returned ${round}` }, { 'If-Match': await revision() })).status).toBe(200);
    }
    const all = (await allPages(B, 'type=skill-version', 100)).items.map((item) => item.key);
    expect(all.length).toBeGreaterThan(3);
    const { items, pages } = await allPages(B, 'type=skill-version', 2);
    for (const page of pages) expect(page.length).toBeLessThanOrEqual(2);
    expect(items.map((item) => item.key)).toEqual(all);
  });

  it('filters combine with paging: a project filter paged three at a time equals the unpaged filtered set', async () => {
    for (let i = 0; i < 5; i += 1) await emit({ name: 'task.updated', objectType: 'task', objectId: TA, actor: A, projectId: PA, payload: { fields: ['title'] } });
    const whole = (await allPages(A, `project=${PA}`, 100)).items.map((item) => item.key);
    const paged = (await allPages(A, `project=${PA}`, 3)).items.map((item) => item.key);
    expect(paged).toEqual(whole);
    expect(whole.length).toBeGreaterThan(5);
  });
});

describe('(4) filters', () => {
  it('type: a single type and a list of types return exactly those kinds', async () => {
    const single = (await allPages(A, 'type=report')).items;
    expect(single.length).toBeGreaterThan(0);
    expect(new Set(single.map((item) => item.kind))).toEqual(new Set(['report']));
    const multi = (await allPages(A, 'type=report,project')).items;
    expect(new Set(multi.map((item) => item.kind))).toEqual(new Set(['report', 'project']));
    expect((await timeline(A, 'type=nonsense')).status).toBe(400);
  });

  it('project and phase: only rows of that Project, or of Tasks currently in that Phase and the Phase itself', async () => {
    const projectRows = (await allPages(A, `project=${PA}`)).items;
    expect(projectRows.length).toBeGreaterThan(0);
    expect(projectRows.every((item) => item.project === null || item.project.id === PA)).toBe(true);
    const phaseTask = await makeTask(A, `NT phase member ${tag()}`, { project: PA });
    await pool().query('UPDATE tasks SET phase_id = $2 WHERE id = $1', [phaseTask, PHA]);
    await emit({ name: 'task.updated', objectType: 'task', objectId: phaseTask, actor: A, projectId: PA, payload: { fields: ['phaseId'] } });
    const phaseRows = (await allPages(A, `phase=${PHA}`)).items;
    expect(phaseRows.some((item) => item.object.id === phaseTask)).toBe(true);
    expect(phaseRows.every((item) => item.object.id === phaseTask || item.object.id === PHA)).toBe(true);
  });

  it('person: only rows that person did; a row the board wrote itself never matches', async () => {
    const rows = (await allPages(B, `person=${B.principalId}`)).items;
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((item) => item.actor.handle === B.handle)).toBe(true);
    const boardRows = (await allPages(B, '')).items.filter((item) => item.actor.handle === null && item.kind !== 'approval');
    for (const row of boardRows) expect(rows.map((item) => item.key)).not.toContain(row.key);
  });

  it('since and until bound every arm by its own time', async () => {
    const until = new Date(Date.now() - 300 * 86400_000).toISOString();
    const old = (await allPages(B, `until=${until}`)).items;
    expect(old.length).toBeGreaterThan(0);
    expect(old.every((item) => item.at < until)).toBe(true);
    const since = new Date(Date.now() - 3600_000).toISOString();
    expect((await allPages(B, `since=${since}`)).items.every((item) => item.at >= since)).toBe(true);
  });

  it('scope=mine keeps My work; access changes appear only when asked for', async () => {
    const mine = (await allPages(A, 'scope=mine&type=task,status,update')).items;
    expect(mine.some((item) => item.object.id === TA)).toBe(true);
    const access = await emit({ name: 'task.acl_changed', objectType: 'task', objectId: TA, actor: A });
    expect((await allPages(A, '')).items.some((item) => item.key === `feed:${access}`)).toBe(false);
    expect((await allPages(A, 'acl=true')).items.some((item) => item.key === `feed:${access}`)).toBe(true);
  });

  describe('EXPLAIN on a seeded table: each filter reads its index', () => {
    beforeAll(async () => {
      // A block of rows naming no object: no arm admits them, so they are
      // invisible to every reader, but they give the planner a real table.
      // Seeded ONCE per database (a re-run on the same database, as the full
      // tier and the mutation drill do, finds the block and keeps it).
      const seeded = Number((await pool().query(
        `SELECT count(*)::int AS n FROM feed_events WHERE payload @> '{"ntExplainSeed": true}'::jsonb`)).rows[0].n);
      if (seeded < 12000) {
        await pool().query(
          `INSERT INTO feed_events (name, object_type, object_id, occurred_at, payload)
           SELECT CASE WHEN g % 50 = 0 THEN 'task.stuck' WHEN g % 53 = 0 THEN 'task.review_requested' ELSE 'task.updated' END,
                  'task', gen_random_uuid(), now() - (g || ' minutes')::interval, '{"ntExplainSeed": true}'::jsonb
             FROM generate_series(1, 12000) g`);
      }
      await pool().query('ANALYZE feed_events');
      await pool().query('ANALYZE approval_events');
    });

    const plan = async (who: Caller, query: Record<string, unknown>): Promise<string> => {
      const viewer = APP.modules.notificationsRoute.timelineViewer(requestOf(who));
      const built = APP.modules.timeline.timelineService.buildFeedQuery(viewer, {
        types: [], acl: false, project: null, phase: null, person: null, since: null, until: null, scope: 'all',
        before: null, limit: 51, ...query,
      }, { before: null, limit: 51 });
      const client = await pool().connect();
      try {
        await client.query('BEGIN');
        await client.query('SET LOCAL enable_seqscan = off');
        const rows = (await client.query(`EXPLAIN ${built.sql}`, built.params)).rows;
        return rows.map((row: any) => row['QUERY PLAN']).join('\n');
      } finally {
        await client.query('ROLLBACK');
        client.release();
      }
    };

    it('type, single: the (name, cursor) index', async () => {
      expect(await plan(A, { types: ['stuck'] })).toContain('ix_feed_events_name_cursor');
    });
    it('type, multi: the (name, cursor) index under a bitmap scan or an ordered scan', async () => {
      expect(await plan(A, { types: ['stuck', 'review'] })).toContain('ix_feed_events_name_cursor');
    });
    it('project: the (project_id, cursor) index', async () => {
      expect(await plan(A, { project: PB })).toContain('ix_feed_events_project');
    });
    it('person: the (actor_principal_id, cursor) index', async () => {
      expect(await plan(A, { person: B.principalId })).toContain('ix_feed_events_actor_cursor');
    });
    it('date: the (occurred_at, cursor) index', async () => {
      const since = new Date(Date.now() - 30 * 60_000).toISOString();
      const until = new Date(Date.now() - 20 * 60_000).toISOString();
      expect(await plan(A, { since, until })).toContain('ix_feed_events_occurred');
    });
    it('the report arm for a non-administrator is a correlated per-row check, not a hash over every Report', async () => {
      const text = await plan(A, { types: ['report'] });
      expect(text).toMatch(/SubPlan|Nested Loop|Semi Join/);
      expect(text).not.toContain('Hashed SubPlan');
    });
  });
});

/**
 * (4b) The query on a REALISTIC board (the fix-forward after the full tier, card
 * 5854f0d6): a board of 100,000 feed rows over 90 days, most of them on another
 * Account's Tasks (archived ones included) and Reports, and a dense block of
 * 36,000 rows in the last half hour, the shape of a full-tier job database
 * after earlier steps (there the 30-to-20-minutes window held a large share of
 * the table, and the window was planned as a walk of the primary key from its
 * newest end). Everything is seeded
 * INSIDE ONE TRANSACTION that is rolled back at the end, so the suite leaves no
 * row behind and reads the same on a fresh database and a full-tier one. The
 * pages run through `pageWith` on that transaction, under the Timeline's own
 * transaction settings.
 */
describe('(4b) a realistic board: every filter reads its index, and every page is fast and bounded', () => {
  const FEED_ROWS = 100_000;
  const RECENT_ROWS = 36_000;
  /**
   * The test budget. Design choice C8 names 300 ms at p95, MEASURED ON
   * PRODUCTION, as the trigger for a materialized timeline; that measurement is
   * the dispatcher's post-release probe. Here the board is adversarial (2 % of
   * the rows readable by A) and the full-tier job database on a shared runner
   * is heavier and noisier (there the window page took about 450 ms, against
   * 50 to 150 ms on a fresh database), so the budget is generous: it still
   * fails by an order of magnitude for a JIT compile (seconds per statement)
   * or a walk of the whole feed.
   */
  const PAGE_BUDGET_MS = 1000;
  let client: any;
  let ZULU: string;
  const base = {
    types: [] as any[], acl: false, project: null, phase: null, person: null, since: null, until: null,
    scope: 'all' as const, before: null, limit: 50,
  };
  // The board's clock runs a day ahead of the database's, so no row an earlier
  // step (or earlier test) wrote falls inside its windows: the board reads the
  // same on a fresh database and on a full-tier job database.
  const BOARD_NOW = Date.now() + 86400_000;
  const minutesAgo = (minutes: number): string => new Date(BOARD_NOW - minutes * 60_000).toISOString();
  const cases = (): Array<[string, Record<string, unknown>, string]> => [
    ['the default page', {}, 'feed_events_pkey'],
    ['a single type', { types: ['stuck'] }, 'ix_feed_events_name_cursor'],
    ['a project', { project: PA }, 'ix_feed_events_project'],
    ['a person', { person: A.principalId }, 'ix_feed_events_actor_cursor'],
    ['the 30-to-20-minutes window', { since: minutesAgo(30), until: minutesAgo(20) }, 'ix_feed_events_occurred'],
    ['a window 61 to 60 days ago', { since: minutesAgo(61 * 1440), until: minutesAgo(60 * 1440) }, 'ix_feed_events_occurred'],
  ];

  beforeAll(async () => {
    client = await pool().connect();
    await client.query('BEGIN');
    for (const setting of APP.modules.timeline.TIMELINE_TRANSACTION_SETTINGS) await client.query(setting);
    // The Timeline's own statements get its ceiling; the seed needs longer.
    await client.query("SET LOCAL statement_timeout = '300s'");
    // The seed below draws each row's kind from random(). A fixed seed for this
    // session makes it the SAME board on every run (the clock is BOARD_NOW, a
    // constant), so which rows a window's first page holds never depends on
    // the draw. Without it a mutation that widens what A reads (the drill's
    // task-arm control) reddened the window test on some draws and not others
    // (machinery queue 9b761f09).
    await client.query('SELECT setseed(0.5)');
    ZULU = String((await client.query(
      `INSERT INTO principals (kind, handle, display_name, status, role) VALUES ('human', $1, $1, 'active', 'user') RETURNING id`,
      [`nt-zulu-${tag()}`])).rows[0].id);
    // 800 Tasks of another Account, outside every Project, one in seven archived.
    await client.query(
      `INSERT INTO tasks
       SELECT (jsonb_populate_record(NULL::tasks, to_jsonb(t) || jsonb_build_object(
                 'id', gen_random_uuid(), 'title', 'NT plan ' || g, 'project_id', NULL, 'phase_id', NULL,
                 'owner_principal_id', $2::uuid, 'creator_principal_id', $2::uuid, 'account_owner_principal_id', $2::uuid,
                 'shepherd_principal_id', NULL, 'verifier_principal_id', NULL,
                 'status', CASE WHEN g % 7 = 0 THEN 'archived' ELSE 'todo' END))).*
         FROM tasks t, generate_series(1, 800) g WHERE t.id = $1::uuid`, [TB, ZULU]);
    // One seed for random(): the same board on every run, so what a mutation
    // control reddens on it is the same on every run.
    await client.query('SELECT setseed(0.453)');
    // The feed: 100,000 rows over 90 days in commit order, then a dense last
    // hour. 2 % are A's own Task (A reads them), 10 % B's Reports (the report
    // arm's per-row check), the rest the other Account's Tasks; a quarter of
    // all rows are access changes, as on the board.
    const seed = (count: number, from: string, span: string) => client.query(
      `WITH zulu AS (SELECT array_agg(id) AS ids FROM tasks WHERE owner_principal_id = $1::uuid),
            g AS (SELECT g, random() AS r FROM generate_series(1, $2::int) g)
       INSERT INTO feed_events (name, object_type, object_id, occurred_at, actor_principal_id, project_id, owner_principal_id, payload)
       SELECT CASE WHEN g.r < 0.02 THEN 'task.updated' WHEN g.r < 0.12 THEN 'report.created'
                   WHEN g.r < 0.37 THEN 'task.acl_changed' WHEN g.r < 0.39 THEN 'task.stuck'
                   WHEN g.r < 0.45 THEN 'task.created' ELSE 'task.updated' END,
              CASE WHEN g.r >= 0.02 AND g.r < 0.12 THEN 'report' ELSE 'task' END,
              CASE WHEN g.r < 0.02 THEN $3::uuid
                   WHEN g.r < 0.12 THEN (ARRAY[$4::uuid, $5::uuid, $6::uuid])[1 + g.g % 3]
                   ELSE zulu.ids[1 + g.g % cardinality(zulu.ids)] END,
              $7::timestamptz + (g.g::float8 / $2::int) * $8::interval,
              CASE WHEN g.r < 0.02 THEN $9::uuid WHEN g.r < 0.95 THEN $1::uuid END,
              CASE WHEN g.r < 0.02 THEN $10::uuid WHEN g.r < 0.12 THEN $11::uuid END,
              CASE WHEN g.r < 0.02 THEN $9::uuid ELSE $1::uuid END,
              CASE WHEN g.r >= 0.12 AND g.r < 0.37 THEN '{}'::jsonb
                   WHEN g.r >= 0.45 AND g.r < 0.65 THEN '{"status":"in-progress","previousStatus":"todo"}'::jsonb
                   ELSE '{"fields":["title"]}'::jsonb END
         FROM g, zulu ORDER BY g.g`,
      [ZULU, count, TA, RB, RB_PROMOTED, RB_OUTPOST, from, span, A.principalId, PA, PB]);
    await seed(FEED_ROWS, minutesAgo(90 * 1440), '89 days');
    await seed(RECENT_ROWS, minutesAgo(31), '30 minutes');
    await client.query('ANALYZE feed_events');
    await client.query('ANALYZE tasks');
    await client.query(`SET LOCAL statement_timeout = '${APP.modules.timeline.TIMELINE_STATEMENT_TIMEOUT_MS}ms'`);
  });

  afterAll(async () => {
    if (client) {
      await client.query('ROLLBACK');
      client.release();
    }
  });

  const viewerOf = (who: Caller) => APP.modules.notificationsRoute.timelineViewer(requestOf(who));
  const explain = async (who: Caller, query: Record<string, unknown>, analyze = false): Promise<string> => {
    const built = APP.modules.timeline.timelineService.buildFeedQuery(viewerOf(who), { ...base, ...query }, { before: null, limit: 51 });
    const rows = (await client.query(`EXPLAIN ${analyze ? '(ANALYZE, BUFFERS) ' : ''}${built.sql}`, built.params)).rows;
    return rows.map((row: any) => row['QUERY PLAN']).join('\n');
  };

  it('the seeded board is the size the plans are measured on', async () => {
    const counted = (await client.query(
      `SELECT count(*)::int AS n, count(*) FILTER (WHERE occurred_at >= $1)::int AS recent FROM feed_events`, [minutesAgo(60)])).rows[0];
    expect(counted.n).toBeGreaterThanOrEqual(FEED_ROWS + RECENT_ROWS);
    expect(counted.recent).toBeGreaterThanOrEqual(RECENT_ROWS);
  });

  it('every filter reads its index on a realistic board, and no page reads the feed sequentially', async () => {
    const seen: string[] = [];
    for (const [label, query, index] of cases()) {
      for (const who of [A, ROOT]) {
        const text = await explain(who, query);
        seen.push(`${label} as ${who.label}: ${text.includes(index) ? index : 'NOT ' + index}${/Seq Scan on feed_events/.test(text) ? ', Seq Scan' : ''}`);
      }
    }
    expect(seen).toEqual(cases().flatMap(([label, , index]) => [A, ROOT].map((who) => `${label} as ${who.label}: ${index}`)));
  });

  it(`every page answers within ${PAGE_BUDGET_MS} ms at p95, as an ordinary Account and as an administrator`, async () => {
    const samples: Array<{ label: string; ms: number }> = [];
    for (let round = 0; round < 3; round += 1) {
      for (const [label, query] of cases()) {
        for (const who of [A, ROOT]) {
          const started = process.hrtime.bigint();
          await APP.modules.timeline.timelineService.pageWith(client, viewerOf(who), { ...base, ...query });
          samples.push({ label: `${label} as ${who.label}`, ms: Number(process.hrtime.bigint() - started) / 1e6 });
        }
      }
    }
    const sorted = samples.map((sample) => sample.ms).sort((x, y) => x - y);
    const p95 = sorted[Math.ceil(sorted.length * 0.95) - 1];
    expect(p95).toBeLessThan(PAGE_BUDGET_MS);
  });

  it('the text search on a realistic board: bounded, never a sequential feed read, and a hidden title matches nothing', async () => {
    // Three searches: A's own Task title (2 % of the board), a title only the
    // other Account's archived and open Tasks carry (A may read none of them:
    // the worst case, nothing on any page), and a text every Task title holds.
    const taTitle = String((await client.query('SELECT title FROM tasks WHERE id = $1', [TA])).rows[0].title);
    const searches: Array<[string, string]> = [['A\'s own title', taTitle], ['a hidden title', 'NT plan 77'], ['a common text', 'NT ']];
    const samples: Array<{ label: string; ms: number }> = [];
    const plans: string[] = [];
    for (const [label, q] of searches) {
      for (const who of [A, ROOT]) {
        const text = await explain(who, { q });
        plans.push(`${label} as ${who.label}: ${/Seq Scan on feed_events/.test(text) ? 'Seq Scan' : 'no Seq Scan'}`);
        for (let round = 0; round < 3; round += 1) {
          const started = process.hrtime.bigint();
          await APP.modules.timeline.timelineService.pageWith(client, viewerOf(who), { ...base, q });
          samples.push({ label: `${label} as ${who.label}`, ms: Number(process.hrtime.bigint() - started) / 1e6 });
        }
      }
    }
    console.log(`E453 realistic-board search samples (ms): ${JSON.stringify(samples.map((s) => [s.label, Math.round(s.ms)]))}`);
    expect(plans).toEqual(searches.flatMap(([label]) => [A, ROOT].map((who) => `${label} as ${who.label}: no Seq Scan`)));
    const sorted = samples.map((sample) => sample.ms).sort((x, y) => x - y);
    expect(sorted[Math.ceil(sorted.length * 0.95) - 1]).toBeLessThan(PAGE_BUDGET_MS);
    // The hidden title: nothing for A, the other Account's rows for root.
    const hidden = await APP.modules.timeline.timelineService.pageWith(client, viewerOf(A), { ...base, q: 'NT plan 77' });
    expect(hidden.items).toEqual([]);
    expect(hidden.hasMore).toBe(false);
    const forRoot = await APP.modules.timeline.timelineService.pageWith(client, viewerOf(ROOT), { ...base, q: 'NT plan 77' });
    expect(forRoot.items.length).toBeGreaterThan(0);
    expect(forRoot.items.every((item: any) => /NT plan 77/.test(String(item.object.title)))).toBe(true);
    // A's own title: A's rows only, a full page.
    const own = await APP.modules.timeline.timelineService.pageWith(client, viewerOf(A), { ...base, q: taTitle });
    expect(own.items.length).toBe(base.limit);
    expect(own.items.every((item: any) => item.object.id === TA)).toBe(true);
  });

  it('the 30-to-20-minutes window returns quickly past a dense last half hour and 90 days of earlier rows', async () => {
    const query = { since: minutesAgo(30), until: minutesAgo(20) };
    const started = process.hrtime.bigint();
    const page = await APP.modules.timeline.timelineService.pageWith(client, viewerOf(A), { ...base, ...query });
    const ms = Number(process.hrtime.bigint() - started) / 1e6;
    expect(page.items.every((item: any) => item.at >= query.since && item.at < query.until)).toBe(true);
    // A's own rows in the window are there: the answer is not vacuously fast.
    expect(page.items.some((item: any) => item.object.id === TA)).toBe(true);
    // Bounded: the scan visits only rows inside the window, never the rows
    // above it or the 90 days below it.
    const windowRows = Number((await client.query(
      'SELECT count(*)::int AS n FROM feed_events WHERE occurred_at >= $1 AND occurred_at < $2', [query.since, query.until])).rows[0].n);
    // The feed rows the main scan visits are the rows it returns plus the rows
    // its own filter (the arms, the window) removes.
    const lines = (await explain(A, query, true)).split('\n');
    let visited = 0;
    lines.forEach((line, at) => {
      const node = /on feed_events fe\b.*actual time=[0-9.]+\.\.[0-9.]+ rows=(\d+) loops=(\d+)/.exec(line);
      if (!node) return;
      visited += Number(node[1]) * Number(node[2]);
      for (let next = at + 1; next < lines.length && !lines[next].includes('->'); next += 1) {
        const removed = /Rows Removed by (?:Filter|Index Recheck): (\d+)/.exec(lines[next]);
        if (removed) visited += Number(removed[1]) * Number(node[2]);
      }
    });
    expect(visited).toBeGreaterThan(0);
    expect(visited).toBeLessThanOrEqual(windowRows);
    expect(ms).toBeLessThan(PAGE_BUDGET_MS);
  });
});

describe('(4c) the Timeline transaction', () => {
  it('compiles nothing: a Timeline read runs read-only with JIT off', async () => {
    const settings = await APP.modules.timeline.timelineService.transaction('read', async (db: any) => (await db.query(
      `SELECT current_setting('jit') AS jit, current_setting('transaction_read_only') AS read_only`)).rows[0]);
    expect(settings).toEqual({ jit: 'off', read_only: 'on' });
  });

  it('a runaway statement is cancelled at the ceiling', async () => {
    const ceiling = APP.modules.timeline.TIMELINE_STATEMENT_TIMEOUT_MS;
    const started = Date.now();
    const failure = await APP.modules.timeline.timelineService.transaction('read', async (db: any) => {
      await db.query('SELECT pg_sleep($1)', [ceiling / 1000 + 3]);
      return null;
    }).catch((error: unknown) => error);
    expect(APP.modules.timeline.isTimelineTimeout(failure)).toBe(true);
    expect(Date.now() - started).toBeLessThan(ceiling + 2500);
  });
});

describe('(5) payloads and the acting principal', () => {
  const feedOf = async (task: string): Promise<any[]> => (await pool().query(
    'SELECT name, payload, actor_principal_id::text AS actor FROM feed_events WHERE object_type = $1 AND object_id = $2 ORDER BY cursor',
    ['task', task])).rows;

  it('a task.updated payload carries field names, sorted, and never a value', async () => {
    const task = await makeTask(A, `NT payload ${tag()}`);
    const before = (await feedOf(task)).length;
    const secretTitle = `NT payload VALUE-${tag()}`;
    const patched = await call(A, 'PATCH', `/tasks/${task}`, { title: secretTitle, description: 'VALUE-description', priority: 'high' }, idem());
    expect(patched.status).toBe(200);
    const rows = (await feedOf(task)).slice(before);
    expect(rows.map((row) => row.name)).toEqual(['task.updated']);
    expect(rows[0].payload).toEqual({ fields: ['description', 'priority', 'title'] });
    expect(rows[0].actor).toBe(A.principalId);
    expect(JSON.stringify(rows[0].payload)).not.toMatch(/VALUE|high/);
    const item = (await allPages(A, 'type=update')).items.find((entry) => entry.key.startsWith('feed:') && entry.object.id === task);
    expect(item.detail.fields).toEqual(['description', 'priority', 'title']);
  });

  it('a public authored non-restricted append yields exactly one feed row naming the entry type', async () => {
    const task = await makeTask(A, `NT append ${tag()}`);
    const before = (await feedOf(task)).length;
    const appended = await call(A, 'POST', `/tasks/${task}/stream`, { content: 'a handover note' }, idem());
    expect(appended.status).toBe(201);
    const rows = (await feedOf(task)).slice(before);
    expect(rows.map((row) => [row.name, row.payload, row.actor])).toEqual([
      ['task.updated', { stream: { entryType: 'handover.note' } }, A.principalId],
    ]);
  });

  it('an append referencing an assigned-only entry yields none', async () => {
    const task = await makeTask(A, `NT restricted ${tag()}`);
    const restricted = (await pool().query(
      `INSERT INTO task_stream_entries (task_id, provenance, event_type, content, outpost_service_id, outpost_visibility_tier)
       SELECT $1, 'reported', 'outpost.reported', 'restricted', se.id, 'assigned-only' FROM services se WHERE se.principal_id = $2
       RETURNING id::text AS id`, [task, A_READ.principalId])).rows[0].id;
    const before = (await feedOf(task)).length;
    const appended = await call(A, 'POST', `/tasks/${task}/stream`, { content: 'a reply', referencedEntryId: restricted }, idem());
    expect(appended.status).toBe(201);
    expect((await feedOf(task)).slice(before)).toEqual([]);
  });

  it('finish yields one task.updated: the status move carrying the handover, the field name and the actor', async () => {
    const task = await makeTask(A, `NT finish ${tag()}`);
    await pool().query("UPDATE tasks SET status = 'in-progress', owner_principal_id = $2 WHERE id = $1", [task, A.principalId]);
    await pool().query('UPDATE task_assignments SET claimant_principal_id = $2 WHERE task_id = $1', [task, A.principalId]);
    const before = (await feedOf(task)).length;
    const finished = await call(A, 'POST', `/tasks/${task}/finish`, { handover: 'done', report: { title: 'NT finish evidence', content: 'all done' } });
    expect(finished.status).toBe(200);
    const rows = (await feedOf(task)).slice(before).filter((row) => row.name === 'task.updated');
    expect(rows.map((row) => [row.payload, row.actor])).toEqual([[
      { status: 'review', previousStatus: 'in-progress', fields: ['status'], stream: { entryType: 'handover.finish' } }, A.principalId,
    ]]);
  });

});

/**
 * (5, continued) THE RUNTIME ACTOR CENSUS (section 4.3; round 1 blocker). The
 * person filter matches `actor_principal_id`, so every route-level writer of a
 * row the Timeline shows must store the acting principal. Each row below drives
 * one writer through its real route, then measures the STORED actor of the row
 * it wrote and finds that row in A's person-filtered Timeline. A source-text
 * census matched the text of an optional actor and passed while POST /phases
 * wrote NULL; this one cannot.
 */
describe('(5) the runtime actor census: every route-level writer records who wrote', () => {
  let V: Caller;                 // an independent Verifier person
  let MCP_A: Caller;             // A's Connector over the MCP ingress
  let MCP_TOKEN: string;
  let PROJ: string;              // A's Project for Phases, Skills and defaults
  type Write = { type: string; id: string; name: string };

  const maxCursor = async (): Promise<string> =>
    String((await pool().query('SELECT COALESCE(max(cursor), 0)::text AS c FROM feed_events')).rows[0].c);
  const ok = (answer: Answer, ...statuses: number[]): Answer => {
    expect([answer.status, statuses.includes(answer.status), answer.json?.code ?? null])
      .toEqual([answer.status, true, answer.json?.code ?? null]);
    return answer;
  };
  const subtasksOf = async (task: string): Promise<string[]> => (await pool().query(
    'SELECT id::text AS id FROM subtasks WHERE task_id = $1 ORDER BY index', [task])).rows.map((row: any) => row.id);
  const taskWithSubtasks = async (title: string, count = 2): Promise<string> => {
    const task = await makeTask(A, title);
    for (let i = 0; i < count; i += 1) ok(await call(A, 'POST', `/tasks/${task}/subtasks`, { text: `step ${i}` }, idem()), 201);
    return task;
  };
  const verifiedBy = async (task: string, verifier: Caller): Promise<void> => {
    ok(await call(ROOT, 'PATCH', `/tasks/${task}/roles`, { verifierPrincipalId: verifier.principalId }), 200);
  };
  const inReview = async (task: string): Promise<void> => {
    await pool().query("UPDATE subtasks SET status = 'review' WHERE task_id = $1", [task]);
  };
  const projectRevision = async (project: string): Promise<string> =>
    String((await pool().query('SELECT revision::text AS r FROM projects WHERE id = $1', [project])).rows[0].r);
  const phaseRevision = async (phase: string): Promise<string> =>
    String((await pool().query('SELECT revision::text AS r FROM phases WHERE id = $1', [phase])).rows[0].r);
  const skillRevision = async (skill: string): Promise<string> =>
    String((await pool().query('SELECT revision::text AS r FROM skills WHERE id = $1', [skill])).rows[0].r);
  const makePhase = async (name: string): Promise<string> =>
    String(ok(await call(A, 'POST', '/phases', { projectId: PROJ, name }, idem()), 201).json.phase.id);
  const makeReport = async (title: string): Promise<string> =>
    String(ok(await call(A, 'POST', '/reports', { title, content: 'census evidence', project_id: PROJ }, idem()), 201).json.report.id);
  const makeSkill = async (): Promise<string> => {
    const name = `nt-census-${tag()}`;
    return String(ok(await call(A, 'POST', '/skills', { name, skill_md: skillMd(name), description: 'census skill' }), 201).json.skill.id);
  };
  const publishedSkill = async (): Promise<string> => {
    const skill = await makeSkill();
    ok(await call(A, 'POST', `/skills/${skill}/versions/1/submit-review`, {}, { 'If-Match': await skillRevision(skill) }), 200);
    ok(await call(ROOT, 'POST', `/skills/${skill}/versions/1/publish`, {}, { 'If-Match': await skillRevision(skill) }), 200);
    return skill;
  };

  beforeAll(async () => {
    V = await sessionFor('victor', 'user');
    PROJ = await makeProject(A, `NT census ${tag()}`);
    const slug = `nt-mcp-${tag()}`;
    const registered = await call(A, 'POST', '/services', {
      slug, name: slug, description: 'Timeline census MCP connector.', kind: 'connector',
      issueCredential: { scopes: ['tasks:read', 'tasks:write', 'projects:read', 'phases:read', 'phases:write'], label: slug, transport: 'any' },
    });
    expect(registered.status).toBe(201);
    MCP_TOKEN = String(registered.json.onboarding.credential.secretOnce);
    const principal = String((await pool().query('SELECT principal_id FROM services WHERE slug = $1', [slug])).rows[0].principal_id);
    MCP_A = { label: slug, principalId: principal, handle: slug, role: 'service', headers: { Authorization: `Bearer ${MCP_TOKEN}` } };
    const brief = await mcpCall(MCP_TOKEN, 'relayhall_brief_compile', { session: true });
    expect([brief.status, Boolean(brief.json?.result?.isError || brief.json?.error)]).toEqual([200, false]);
  });

  // [label, who writes, the write]. Every object is A's, so A's Timeline lists every row.
  const CENSUS: Array<[string, () => Caller, () => Promise<Write>]> = [
    // ── Tasks ──
    ['POST /tasks', () => A, async () => ({ type: 'task', id: await makeTask(A, `NT census create ${tag()}`), name: 'task.created' })],
    ['PATCH /tasks/:id', () => A, async () => {
      const task = await makeTask(A, `NT census patch ${tag()}`);
      ok(await call(A, 'PATCH', `/tasks/${task}`, { title: `NT census patched ${tag()}` }, idem()), 200);
      return { type: 'task', id: task, name: 'task.updated' };
    }],
    ['POST /tasks/:id/notes', () => A, async () => {
      const task = await makeTask(A, `NT census notes ${tag()}`);
      ok(await call(A, 'POST', `/tasks/${task}/notes`, { text: 'a census note' }, idem()), 200, 201);
      return { type: 'task', id: task, name: 'task.updated' };
    }],
    // The public append and finish are measured with their actor in (5) above.
    ['PATCH /tasks/:id/roles', () => ROOT, async () => {
      const task = await makeTask(A, `NT census roles ${tag()}`);
      await verifiedBy(task, V);
      return { type: 'task', id: task, name: 'task.updated' };
    }],
    ['PATCH /tasks/:id/success-criteria', () => A, async () => {
      const task = await makeTask(A, `NT census criteria ${tag()}`);
      ok(await call(A, 'PATCH', `/tasks/${task}/success-criteria`, { successCriteria: ['the census row carries its actor'] }), 200);
      return { type: 'task', id: task, name: 'task.updated' };
    }],
    ['PATCH /tasks/:id/access', () => A, async () => {
      const task = await makeTask(A, `NT census access ${tag()}`);
      ok(await call(A, 'PATCH', `/tasks/${task}/access`, { restricted: true, reason: 'census access change' }), 200);
      return { type: 'task', id: task, name: 'task.acl_changed' };
    }],
    ['POST /tasks/:id/archive', () => A, async () => {
      const task = await makeTask(A, `NT census archive ${tag()}`);
      ok(await call(A, 'POST', `/tasks/${task}/archive`, { reason: 'census archive' }), 200);
      return { type: 'task', id: task, name: 'task.archived' };
    }],
    ['POST /tasks/:id/unarchive', () => A, async () => {
      const task = await makeTask(A, `NT census unarchive ${tag()}`);
      ok(await call(A, 'POST', `/tasks/${task}/archive`, { reason: 'census archive' }), 200);
      ok(await call(A, 'POST', `/tasks/${task}/unarchive`, {}), 200);
      return { type: 'task', id: task, name: 'task.updated' };
    }],
    ['POST /tasks/bulk-archive', () => A, async () => {
      const task = await makeTask(A, `NT census bulk ${tag()}`);
      await pool().query("UPDATE tasks SET status = 'completed', completed_at = now() WHERE id = $1", [task]);
      const archived = ok(await call(A, 'POST', '/tasks/bulk-archive', { taskIds: [task], reason: 'census bulk archive' }), 200);
      expect(archived.json.archivedCount).toBe(1);
      return { type: 'task', id: task, name: 'task.archived' };
    }],
    ['POST /tasks/:id/dependencies', () => A, async () => {
      const task = await makeTask(A, `NT census dependent ${tag()}`);
      const parent = await makeTask(A, `NT census parent ${tag()}`);
      ok(await call(A, 'POST', `/tasks/${task}/dependencies`, { dependsOn: parent }), 200, 201);
      return { type: 'task', id: task, name: 'task.updated' };
    }],
    ['DELETE /tasks/:id/dependencies/:dep', () => A, async () => {
      const task = await makeTask(A, `NT census undepend ${tag()}`);
      const parent = await makeTask(A, `NT census old parent ${tag()}`);
      ok(await call(A, 'POST', `/tasks/${task}/dependencies`, { dependsOn: parent }), 200, 201);
      ok(await call(A, 'DELETE', `/tasks/${task}/dependencies/${parent}`), 200, 204);
      return { type: 'task', id: task, name: 'task.updated' };
    }],
    ['POST /tasks/:id/subtasks', () => A, async () => ({ type: 'task', id: await taskWithSubtasks(`NT census subtask ${tag()}`, 1), name: 'task.updated' })],
    ['POST /tasks/:id/subtasks/reorder', () => A, async () => {
      const task = await taskWithSubtasks(`NT census reorder ${tag()}`);
      ok(await call(A, 'POST', `/tasks/${task}/subtasks/reorder`, { order: (await subtasksOf(task)).reverse() }, idem()), 200);
      return { type: 'task', id: task, name: 'task.updated' };
    }],
    ['PATCH /tasks/:id/subtasks/by-id/:subtaskId/text', () => A, async () => {
      const task = await taskWithSubtasks(`NT census text ${tag()}`, 1);
      ok(await call(A, 'PATCH', `/tasks/${task}/subtasks/by-id/${(await subtasksOf(task))[0]}/text`, { text: 'renamed step' }, idem()), 200);
      return { type: 'task', id: task, name: 'task.updated' };
    }],
    ['PATCH /tasks/:id/subtasks/by-id/:subtaskId/status', () => A, async () => {
      const task = await taskWithSubtasks(`NT census status by id ${tag()}`, 1);
      ok(await call(A, 'PATCH', `/tasks/${task}/subtasks/by-id/${(await subtasksOf(task))[0]}/status`, { status: 'in-progress' }), 200);
      return { type: 'task', id: task, name: 'task.updated' };
    }],
    ['PUT /tasks/:id/subtasks/by-id/:subtaskId', () => A, async () => {
      const task = await taskWithSubtasks(`NT census put by id ${tag()}`, 1);
      ok(await call(A, 'PUT', `/tasks/${task}/subtasks/by-id/${(await subtasksOf(task))[0]}`, { status: 'in-progress' }), 200);
      return { type: 'task', id: task, name: 'task.updated' };
    }],
    ['PATCH /tasks/:id/subtasks/:index/status', () => A, async () => {
      const task = await taskWithSubtasks(`NT census status by index ${tag()}`, 1);
      ok(await call(A, 'PATCH', `/tasks/${task}/subtasks/0/status`, { status: 'in-progress' }), 200);
      return { type: 'task', id: task, name: 'task.updated' };
    }],
    ['PUT /tasks/:id/subtasks/:index', () => A, async () => {
      const task = await taskWithSubtasks(`NT census put by index ${tag()}`, 1);
      ok(await call(A, 'PUT', `/tasks/${task}/subtasks/0`, { status: 'in-progress' }), 200);
      return { type: 'task', id: task, name: 'task.updated' };
    }],
    ['POST /tasks/:id/subtasks/by-id/:subtaskId/approve', () => V, async () => {
      const task = await taskWithSubtasks(`NT census approve by id ${tag()}`, 1);
      await verifiedBy(task, V);
      await inReview(task);
      ok(await call(V, 'POST', `/tasks/${task}/subtasks/by-id/${(await subtasksOf(task))[0]}/approve`, {}), 200);
      return { type: 'task', id: task, name: 'task.updated' };
    }],
    ['POST /tasks/:id/subtasks/:index/approve', () => V, async () => {
      const task = await taskWithSubtasks(`NT census approve by index ${tag()}`, 1);
      await verifiedBy(task, V);
      await inReview(task);
      ok(await call(V, 'POST', `/tasks/${task}/subtasks/0/approve`, {}), 200);
      return { type: 'task', id: task, name: 'task.updated' };
    }],
    ['POST /tasks/:id/subtasks/by-id/:subtaskId/reject', () => ROOT, async () => {
      const task = await taskWithSubtasks(`NT census reject by id ${tag()}`, 1);
      await inReview(task);
      ok(await call(ROOT, 'POST', `/tasks/${task}/subtasks/by-id/${(await subtasksOf(task))[0]}/reject`, { note: 'not yet' }), 200);
      return { type: 'task', id: task, name: 'task.updated' };
    }],
    ['POST /tasks/:id/subtasks/:index/reject', () => ROOT, async () => {
      const task = await taskWithSubtasks(`NT census reject by index ${tag()}`, 1);
      await inReview(task);
      ok(await call(ROOT, 'POST', `/tasks/${task}/subtasks/0/reject`, { note: 'not yet' }), 200);
      return { type: 'task', id: task, name: 'task.updated' };
    }],
    ['POST /tasks/:id/subtasks/by-id/:subtaskId/skip', () => ROOT, async () => {
      const task = await taskWithSubtasks(`NT census skip by id ${tag()}`, 1);
      ok(await call(ROOT, 'POST', `/tasks/${task}/subtasks/by-id/${(await subtasksOf(task))[0]}/skip`, {}), 200);
      return { type: 'task', id: task, name: 'task.updated' };
    }],
    ['POST /tasks/:id/subtasks/:index/skip', () => ROOT, async () => {
      const task = await taskWithSubtasks(`NT census skip by index ${tag()}`, 1);
      ok(await call(ROOT, 'POST', `/tasks/${task}/subtasks/0/skip`, {}), 200);
      return { type: 'task', id: task, name: 'task.updated' };
    }],
    ['POST /tasks/reviewer/:id/reject', () => V, async () => {
      const task = await makeTask(A, `NT census verifier reject ${tag()}`);
      await verifiedBy(task, V);
      await pool().query("UPDATE tasks SET status = 'review' WHERE id = $1", [task]);
      ok(await call(V, 'POST', `/tasks/reviewer/${task}/reject`, { reason: 'the criteria are not met' }), 200);
      return { type: 'task', id: task, name: 'task.updated' };
    }],
    // ── Reports ──
    ['POST /reports', () => A, async () => ({ type: 'report', id: await makeReport(`NT census report ${tag()}`), name: 'report.created' })],
    ['PATCH /reports/:id', () => A, async () => {
      const report = await makeReport(`NT census report patch ${tag()}`);
      ok(await call(A, 'PATCH', `/reports/${report}`, { summary: 'revised by the census' }), 200);
      return { type: 'report', id: report, name: 'report.updated' };
    }],
    ['POST /reports/:id/archive', () => A, async () => {
      const report = await makeReport(`NT census report archive ${tag()}`);
      ok(await call(A, 'POST', `/reports/${report}/archive`, {}), 200);
      return { type: 'report', id: report, name: 'report.updated' };
    }],
    ['POST /reports/:id/unarchive', () => A, async () => {
      const report = await makeReport(`NT census report unarchive ${tag()}`);
      ok(await call(A, 'POST', `/reports/${report}/archive`, {}), 200);
      ok(await call(A, 'POST', `/reports/${report}/unarchive`, {}), 200);
      return { type: 'report', id: report, name: 'report.updated' };
    }],
    // ── Phases and the Project ──
    ['POST /phases', () => A, async () => ({ type: 'phase', id: await makePhase(`NT census phase ${tag()}`), name: 'phase.created' })],
    ['MCP relayhall_phase_create', () => MCP_A, async () => {
      const name = `NT census MCP phase ${tag()}`;
      const created = await mcpCall(MCP_TOKEN, 'relayhall_phase_create', { projectId: PROJ, name, idempotencyKey: `nt-${crypto.randomUUID()}` });
      expect([created.status, Boolean(created.json?.result?.isError || created.json?.error)]).toEqual([200, false]);
      const phase = (await pool().query('SELECT id::text AS id FROM phases WHERE name = $1', [name])).rows[0];
      return { type: 'phase', id: String(phase?.id), name: 'phase.created' };
    }],
    ['PATCH /phases/:id', () => A, async () => {
      const phase = await makePhase(`NT census phase patch ${tag()}`);
      ok(await call(A, 'PATCH', `/phases/${phase}`, { revision: await phaseRevision(phase), goal: 'a census goal' }), 200);
      return { type: 'phase', id: phase, name: 'phase.updated' };
    }],
    ['POST /phases/:id/archive', () => A, async () => {
      const phase = await makePhase(`NT census phase archive ${tag()}`);
      ok(await call(A, 'POST', `/phases/${phase}/archive`, { revision: await phaseRevision(phase) }), 200);
      return { type: 'phase', id: phase, name: 'phase.updated' };
    }],
    ['POST /phases/:id/unarchive', () => A, async () => {
      const phase = await makePhase(`NT census phase unarchive ${tag()}`);
      ok(await call(A, 'POST', `/phases/${phase}/archive`, { revision: await phaseRevision(phase) }), 200);
      ok(await call(A, 'POST', `/phases/${phase}/unarchive`, { revision: await phaseRevision(phase) }), 200);
      return { type: 'phase', id: phase, name: 'phase.updated' };
    }],
    ['PATCH /phases/:id/access', () => ROOT, async () => {
      const phase = await makePhase(`NT census phase access ${tag()}`);
      ok(await call(ROOT, 'PATCH', `/phases/${phase}/access`, { revision: await phaseRevision(phase), restricted: true, reason: 'census access change' }), 200);
      return { type: 'phase', id: phase, name: 'phase.acl_changed' };
    }],
    ['PUT /phases/:id/default-verifier', () => A, async () => {
      const phase = await makePhase(`NT census phase verifier ${tag()}`);
      ok(await call(A, 'PUT', `/phases/${phase}/default-verifier`, { principalId: V.principalId }, { 'If-Match': await phaseRevision(phase) }), 200);
      return { type: 'phase', id: phase, name: 'phase.updated' };
    }],
    ['PUT /projects/:id/default-verifier', () => A, async () => {
      ok(await call(A, 'PUT', `/projects/${PROJ}/default-verifier`, { principalId: V.principalId }, { 'If-Match': await projectRevision(PROJ) }), 200);
      return { type: 'project', id: PROJ, name: 'project.updated' };
    }],
    // ── Skills ──
    ['POST /skills', () => A, async () => ({ type: 'skill', id: await makeSkill(), name: 'skill.created' })],
    ['PUT /skills/:id', () => A, async () => {
      const skill = await makeSkill();
      ok(await call(A, 'PUT', `/skills/${skill}`, { description: 'revised census skill' }, { 'If-Match': await skillRevision(skill) }), 200, 201);
      return { type: 'skill', id: skill, name: 'skill.updated' };
    }],
    ['POST /skills/:id/versions/:version/submit-review', () => A, async () => {
      const skill = await makeSkill();
      ok(await call(A, 'POST', `/skills/${skill}/versions/1/submit-review`, {}, { 'If-Match': await skillRevision(skill) }), 200);
      return { type: 'skill', id: skill, name: 'skill.updated' };
    }],
    ['POST /skills/:id/versions/:version/publish', () => ROOT, async () => ({ type: 'skill', id: await publishedSkill(), name: 'skill.updated' })],
    ['PATCH /skills/:id/audience', () => ROOT, async () => {
      const skill = await publishedSkill();
      ok(await call(ROOT, 'PATCH', `/skills/${skill}/audience`, { is_global: true }, { 'If-Match': await skillRevision(skill) }), 200);
      return { type: 'skill', id: skill, name: 'skill.updated' };
    }],
    ['PUT /projects/:id/skills/:skillId', () => A, async () => {
      const skill = await publishedSkill();
      ok(await call(A, 'PUT', `/projects/${PROJ}/skills/${skill}`, { version: 1 }), 200, 201);
      return { type: 'skill', id: skill, name: 'skill.updated' };
    }],
    ['DELETE /projects/:id/skills/:skillId', () => A, async () => {
      const skill = await publishedSkill();
      ok(await call(A, 'PUT', `/projects/${PROJ}/skills/${skill}`, { version: 1 }), 200, 201);
      ok(await call(A, 'DELETE', `/projects/${PROJ}/skills/${skill}`), 200, 204);
      return { type: 'skill', id: skill, name: 'skill.updated' };
    }],
  ];

  it.each(CENSUS)('records the acting principal: %s', async (_label, whoOf, write) => {
    const who = whoOf();
    const mark = await maxCursor();
    const written = await write();
    const row = (await pool().query(
      `SELECT cursor::text AS cursor, actor_principal_id::text AS actor FROM feed_events
        WHERE object_type = $1 AND object_id = $2 AND name = $3 AND cursor > $4::bigint
        ORDER BY cursor DESC LIMIT 1`, [written.type, written.id, written.name, mark])).rows[0];
    expect(`${written.name} written: ${Boolean(row)}`).toBe(`${written.name} written: true`);
    expect(row.actor).toBe(who.principalId);
    // And the person filter finds it: the row is in A's Timeline under that person.
    const items = (await allPages(A, `person=${who.principalId}&acl=true`)).items;
    expect(items.map((item) => item.key)).toContain(`feed:${row.cursor}`);
  });
});

describe('(6) the last-seen cursor', () => {
  const markOf = async (who: Caller) => (await pool().query(
    'SELECT feed_cursor::text AS c FROM notification_read_marks WHERE principal_id = $1', [who.principalId])).rows[0]?.c ?? null;

  it('POST moves only the caller\'s own mark, clamped to the head and never backwards; a GET writes nothing', async () => {
    // The head is the newest row A may SEE, never the board's: a row of B's
    // written last is above it, and the echoed mark must not disclose it.
    const head = String((await timeline(A, 'acl=true&limit=1')).json.headCursor.feed);
    const hidden = await emit({ name: 'task.updated', objectType: 'task', objectId: TB, actor: B, projectId: PB, payload: { fields: ['title'] } });
    expect(BigInt(hidden) > BigInt(head)).toBe(true);
    expect(String((await timeline(A, 'acl=true&limit=1')).json.headCursor.feed)).toBe(head);
    const bMark = await markOf(B);
    const before = await markOf(A);
    await timeline(A, 'limit=1');
    expect(await markOf(A)).toBe(before);
    const seen = await call(A, 'POST', '/notifications/timeline/seen', { cursor: '9999999999999' });
    expect(seen.status).toBe(200);
    expect(seen.json.lastSeen).toBe(head);
    const back = await call(A, 'POST', '/notifications/timeline/seen', { cursor: '1' });
    expect(back.json.lastSeen).toBe(head);
    expect(await markOf(B)).toBe(bMark);
    expect((await timeline(A, 'limit=1')).json.lastSeen).toBe(head);
    expect((await call(A, 'POST', '/notifications/timeline/seen', { cursor: 'x' })).status).toBe(400);
    expect((await call(A, 'POST', '/notifications/timeline/seen', { cursor: '5', principalId: B.principalId })).status).toBe(400);
  });

  it('a malformed cursor or limit is a 400, and an unknown path under the mount is refused', async () => {
    expect((await timeline(A, 'before=not-a-cursor')).status).toBe(400);
    expect((await timeline(A, 'limit=0')).status).toBe(400);
    expect((await timeline(A, 'project=not-a-uuid')).status).toBe(400);
    expect((await call(A, 'DELETE', '/notifications/timeline')).status).toBe(403);
  });
});

/** A pending grant request filed by `requester` (a Connector of `grantee`) that names `relatedTask`. */
async function pendingGrant(requester: Caller, grantee: Caller, relatedTask: string, readable: string): Promise<string> {
  const credential = String((await pool().query(
    'SELECT id FROM principal_credentials WHERE principal_id = $1 LIMIT 1', [requester.principalId])).rows[0].id);
  const id = String((await pool().query(
    `INSERT INTO approvals (kind, requester_principal_id, requesting_credential_id, grantee_principal_id,
       requested_scopes, requested_rules, requested_expires_at, reason, related_task_id, pending_expires_at)
     VALUES ('grant', $1, $2, $3, '[]'::jsonb, $4::jsonb, NOW() + INTERVAL '5 days',
             'Action Center drill: a grant request naming a Task.', $5, NOW() + INTERVAL '5 days')
     RETURNING id`,
    [requester.principalId, credential, grantee.principalId,
      JSON.stringify([{ resourceType: 'task', selectorForm: 'exact', selectorIds: [readable], verbs: ['read'] }]), relatedTask])).rows[0].id);
  await pool().query(
    `INSERT INTO approval_events (approval_id, action, actor_principal_id, actor_handle, occurred_at)
     VALUES ($1, 'approval.requested', $2, $3, now())`, [id, requester.principalId, requester.handle]);
  // Self-isolating: the longest-waiting pending request, so no earlier step's
  // requests push it past the action list's per-kind cap.
  await pool().query(
    `UPDATE approvals SET requested_at = (SELECT min(requested_at) FROM approvals WHERE status = 'pending') - interval '1 minute'
      WHERE id = $1`, [id]);
  return id;
}

describe('(7) the text search (E453)', () => {
  const search = (who: Caller, q: string, rest = '', limit = 100) => allPages(who, `q=${encodeURIComponent(q)}${rest ? `&${rest}` : ''}`, limit);

  it("the text search never matches an object the caller cannot see: B's titles find nothing for A, and B's own rows for B", async () => {
    const secret = String((await pool().query('SELECT title FROM tasks WHERE id = $1', [TB])).rows[0].title);
    for (const q of [secret, 'bravo SECRET', secret.toLowerCase()]) {
      const { items } = await search(A, q, 'acl=true');
      expect({ q, leaked: items.filter((item) => bObjectIds.has(String(item.object.id))).map((item) => item.key) }).toEqual({ q, leaked: [] });
      expect(titlesOf(items)).not.toContain('bravo SECRET');
    }
    // The negative control: B's own search finds B's Task, Report, Phase and Project rows.
    const forB = objectIds((await search(B, 'bravo SECRET', 'acl=true')).items);
    for (const id of [TB, RB, PHB, PB]) expect(`${id}: ${forB.has(id)}`).toBe(`${id}: true`);
    // The outside anchor: every object A's searches return is readable at its own point route.
    const own = (await search(A, 'NT alpha', 'acl=true')).items;
    const routes: Record<string, string> = { task: '/tasks/', report: '/reports/', phase: '/phases/', project: '/projects/' };
    const checked = new Set<string>();
    for (const item of own) {
      const prefix = routes[item.object.type];
      if (!prefix || checked.has(item.object.id)) continue;
      checked.add(item.object.id);
      const point = await call(A, 'GET', `${prefix}${item.object.id}`);
      expect(`${item.object.type} ${item.object.id} -> ${point.status}`).toBe(`${item.object.type} ${item.object.id} -> 200`);
    }
    expect(checked.size).toBeGreaterThanOrEqual(4);
  });

  it("an approval row whose Task the caller cannot read never matches that Task's title", async () => {
    // A's own Connector files a grant request naming B's Task: A reads the
    // approval row (its requester is in A's subtree) but never the Task.
    const approval = await pendingGrant(A_READ, A, TB, TA);
    const plain = (await allPages(A, 'type=approval')).items.filter((item) => item.object.id === approval);
    expect(plain.length).toBeGreaterThan(0);
    expect(plain.every((item) => item.object.title === null)).toBe(true);
    const secret = String((await pool().query('SELECT title FROM tasks WHERE id = $1', [TB])).rows[0].title);
    expect((await search(A, secret, 'type=approval')).items.filter((item) => item.object.id === approval)).toEqual([]);
    // Root reads the Task, so root's search for its title finds the approval row.
    expect((await search(ROOT, secret, 'type=approval')).items.some((item) => item.object.id === approval)).toBe(true);
  });

  it('the text search matches titles and labels in any case, and takes the caller\'s wildcards literally', async () => {
    const mark = tag();
    const needle = await makeTask(A, `NT search Needle-${mark} 100%_done`);
    const plain = await makeTask(A, `NT search Plain-${mark} 100 done`);
    const byTitle = (await search(A, `needle-${mark.toUpperCase()}`)).items;
    expect(byTitle.length).toBeGreaterThan(0);
    expect(byTitle.every((item) => item.object.id === needle)).toBe(true);
    // `%` and `_` are characters to find, never wildcards.
    const literal = objectIds((await search(A, `${mark} 100%_done`)).items);
    expect([literal.has(needle), literal.has(plain)]).toEqual([true, false]);
    const percent = (await search(A, '%', 'acl=true')).items;
    expect(percent.length).toBeGreaterThan(0);
    expect(percent.every((item) => String(item.object.title ?? '').includes('%') || item.label.includes('%'))).toBe(true);
    // A label: every row it finds carries that label (or a title holding the text).
    await emit({ name: 'task.review_requested', objectType: 'task', objectId: needle, actor: A });
    const labelled = (await search(A, 'REVIEW REQUESTED')).items;
    expect(labelled.some((item) => item.kind === 'review' && item.object.id === needle)).toBe(true);
    expect(labelled.every((item) => item.label === 'Review requested' || /review requested/i.test(String(item.object.title)))).toBe(true);
    expect((await timeline(A, `q=${'x'.repeat(101)}`)).status).toBe(400);
  });

  it('a searched page is never short: the search is in the query, before the limit, never after it', async () => {
    const mark = `pager-${tag()}`;
    const matching: string[] = [];
    for (let i = 0; i < 7; i += 1) {
      matching.push(await makeTask(A, `NT ${mark} ${i}`));
      // Rows that do not match, between the matching ones.
      await emit({ name: 'task.updated', objectType: 'task', objectId: TA, actor: A, projectId: PA, payload: { fields: ['notes'] } });
    }
    const whole = (await search(A, mark)).items.map((item) => item.key);
    expect(whole.length).toBeGreaterThanOrEqual(7);
    const { pages } = await search(A, mark, '', 2);
    for (const page of pages.slice(0, -1)) expect(page.length).toBe(2);
    expect(pages.flat().map((item) => item.key)).toEqual(whole);
    expect(new Set(pages.flat().map((item) => String(item.object.id)))).toEqual(new Set(matching));
  });
});

describe('(8) the seen mark on action items (E455)', () => {
  const listOf = async (who: Caller) => (await actions(who)).json;
  const itemOf = async (who: Caller, key: string) => (await listOf(who)).items.find((item: any) => item.key === key);
  const markSeen = (who: Caller, body: unknown) => call(who, 'POST', '/notifications/actions/seen', body);
  const stored = async (who: Caller, key: string) => Number((await pool().query(
    'SELECT count(*)::int AS n FROM notification_action_seen WHERE principal_id = $1 AND item_key = $2', [who.principalId, key])).rows[0].n);
  /** A Task of `owner` in Review with `verifier` as its Verifier (and a read grant for it). */
  const inReview = async (owner: Caller, verifier: Caller): Promise<string> => {
    const task = await makeTask(owner, `NT seen ${tag()}`);
    await pool().query("UPDATE tasks SET status = 'review', verifier_principal_id = $2 WHERE id = $1", [task, verifier.principalId]);
    await pool().query(`INSERT INTO grants (grantee_type, grantee_id, resource_type, resource_id, verb) VALUES ('principal', $1, 'task', $2, 'read')`,
      [verifier.principalId, task]);
    return task;
  };

  it('a seen item stays listed, shown as seen, until it is resolved, and the bell counts only the unseen ones', async () => {
    const first = await inReview(B, A);
    const second = await inReview(B, A);
    const before = await listOf(A);
    const unseenBefore = before.counts.unseen;
    expect([(await itemOf(A, `verify:${first}`)).seen, (await itemOf(A, `verify:${second}`)).seen]).toEqual([false, false]);
    expect(unseenBefore).toBe(before.items.filter((item: any) => !item.seen).length);
    const one = await markSeen(A, { keys: [`verify:${first}`] });
    expect([one.status, one.json.marked]).toEqual([200, 1]);
    const after = await listOf(A);
    expect([(await itemOf(A, `verify:${first}`))?.seen, (await itemOf(A, `verify:${second}`))?.seen]).toEqual([true, false]);
    expect(after.counts.total).toBe(before.counts.total);
    expect(after.counts.unseen).toBe(unseenBefore - 1);
    expect(after.counts.unseen).toBe(after.items.filter((item: any) => !item.seen).length);
    const all = await markSeen(A, { all: true });
    expect([all.status, all.json.marked]).toEqual([200, after.counts.total]);
    const everything = await listOf(A);
    expect(everything.counts.unseen).toBe(0);
    expect(everything.items.every((item: any) => item.seen === true)).toBe(true);
    expect(everything.counts.total).toBe(before.counts.total);
    // Resolved: it leaves the list, seen or not.
    await pool().query("UPDATE tasks SET status = 'completed' WHERE id = $1", [first]);
    expect(await itemOf(A, `verify:${first}`)).toBeUndefined();
  });

  it('a new occurrence of the same item reads as unseen again', async () => {
    const task = await inReview(B, A);
    const key = `verify:${task}`;
    expect((await markSeen(A, { keys: [key] })).json.marked).toBe(1);
    expect((await itemOf(A, key)).seen).toBe(true);
    expect((await itemOf(A, key)).seen).toBe(true);
    // The Task goes back to Review: a new review row is a new `since`.
    await new Promise((resolve) => setTimeout(resolve, 20));
    await emit({ name: 'task.updated', objectType: 'task', objectId: task, actor: B, payload: { status: 'review', previousStatus: 'in-progress' } });
    const again = await itemOf(A, key);
    expect(again.seen).toBe(false);
    expect((await markSeen(A, { keys: [key] })).json.marked).toBe(1);
    expect((await itemOf(A, key)).seen).toBe(true);
  });

  it('a key the caller cannot see is ignored without a trace: nothing is stored, and the answer is that of a key that never existed', async () => {
    const task = await makeTask(B, `NT seen hidden ${tag()}`);
    await pool().query("UPDATE tasks SET status = 'review', verifier_principal_id = NULL, account_owner_principal_id = $2 WHERE id = $1", [task, B.principalId]);
    const hidden = `verify:${task}`;
    expect((await itemOf(B, hidden))?.seen).toBe(false);
    const absent = `verify:${crypto.randomUUID()}`;
    const forHidden = await markSeen(A, { keys: [hidden] });
    const forAbsent = await markSeen(A, { keys: [absent] });
    expect([forHidden.status, forHidden.json.marked]).toEqual([200, 0]);
    expect({ marked: forHidden.json.marked, counts: forHidden.json.counts, items: forHidden.json.items.map((item: any) => item.key) })
      .toEqual({ marked: forAbsent.json.marked, counts: forAbsent.json.counts, items: forAbsent.json.items.map((item: any) => item.key) });
    expect([await stored(A, hidden), await stored(A, absent)]).toEqual([0, 0]);
    // The owner's own item is untouched by anyone else's request.
    expect((await itemOf(B, hidden))?.seen).toBe(false);
  });

  it('the mark is per caller: one administrator marking a Decision seen leaves it unseen for another', async () => {
    const other = await sessionFor('root2', 'admin');
    const approval = await pendingGrant(A_READ, A, TA, TA);
    const key = `decision:${approval}`;
    expect([(await itemOf(ROOT, key))?.seen, (await itemOf(other, key))?.seen]).toEqual([false, false]);
    expect((await markSeen(ROOT, { keys: [key] })).json.marked).toBe(1);
    expect([(await itemOf(ROOT, key))?.seen, (await itemOf(other, key))?.seen]).toEqual([true, false]);
    expect([await stored(ROOT, key), await stored(other, key)]).toEqual([1, 0]);
  });

  it('a bearer marks its own list; a malformed request is a 400 and writes nothing', async () => {
    const forBearer = await markSeen(B_BEARER, { all: true });
    expect(forBearer.status).toBe(200);
    expect(typeof forBearer.json.marked).toBe('number');
    const rows = async () => Number((await pool().query(
      'SELECT count(*)::int AS n FROM notification_action_seen WHERE principal_id = $1', [A.principalId])).rows[0].n);
    const before = await rows();
    for (const body of [{}, { all: false }, { keys: [] }, { keys: ['not a key'] }, { keys: ['verify:x'], principalId: B.principalId }]) {
      const refused = await markSeen(A, body);
      expect({ body, status: refused.status, code: refused.json?.code }).toEqual({ body, status: 400, code: 'INVALID_ACTIONS_SEEN' });
    }
    expect(await rows()).toBe(before);
    expect((await call(A, 'GET', '/notifications/actions/seen')).status).toBe(403);
  });
});
