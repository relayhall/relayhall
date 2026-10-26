/**
 * Card d67e6990 (D24 part 1) and AZ-A12 build 4 (M-c, card 1942926f): a Skill
 * has an owner, and the registry shows a Skill's drafts to its owner.
 *
 * Every assertion drives the PRODUCTION routers over a real PostgreSQL with
 * real login sessions and real bearer credentials. It fails, never skips,
 * without a disposable database.
 *
 *   M   migration 162's first assignment, applied again inside a transaction
 *       that is rolled back: the 27 listed Skill ids go to the second Account,
 *       every other unowned Skill to the first, an owned Skill keeps its owner,
 *       nothing is assigned where the two Accounts do not exist, a re-run is a
 *       no-op, and the owner trigger refuses an Agent, a Connector or an
 *       unknown id.
 *   A   two Accounts: the first (an administrator) and the second (a Skill
 *       author, `editor`). The second Account's imported drafts are assigned to
 *       it by the owner act; afterwards the first Account's GET /skills and
 *       session brief (session and Connector) no longer carry them, and the
 *       second Account's do (its brief under `yourDrafts`). `owner=all` lists
 *       them for the administrator and is refused to the author; a third
 *       Account sees neither list nor point read; the review queue reaches the
 *       administrator once the author submits.
 *   W   the authoring flow, once ownership exists: create (owned by the
 *       creator), version, submit, see the rejection, revise, and publication
 *       only by an independent human administrator. An unowned Skill the author
 *       created before ownership refuses the author's new Version; after the
 *       owner act it is admitted.
 *   O   the owner act: one `skill.owner.change` audit row; revision-bound;
 *       a non-Account target refused; a Group target only through clause 9(e)
 *       (session, administrator, step-up), with the clause 9(f) fields; a Group
 *       owner's members see its drafts; a Group that owns a Skill cannot be
 *       deleted (GROUP_OWNS_OBJECTS counts skills).
 */
import crypto from 'crypto';
import fs from 'fs';
import http from 'http';
import path from 'path';

const raw = process.env.RELAYHALL_TEST_DB_URL;
if (!raw) throw new Error('Skill ownership proof requires an explicit disposable database (RELAYHALL_TEST_DB_URL)');
const url = new URL(raw);
const dbName = decodeURIComponent(url.pathname.slice(1));
if (!['postgres:', 'postgresql:'].includes(url.protocol)
    || !(/^skill_ownership_[a-z0-9_]+$/.test(dbName) || (dbName === 'relayhall_ci' && process.env.CI === 'true'))
    || !(['127.0.0.1', 'localhost'].includes(url.hostname) || (url.hostname === 'postgres' && process.env.CI === 'true'))) {
  throw new Error('Skill ownership proof refuses a non-contract database/host');
}
Object.assign(process.env, {
  DB_HOST: url.hostname, DB_PORT: url.port || '5432', DB_NAME: dbName,
  DB_USER: decodeURIComponent(url.username), DB_PASSWORD: decodeURIComponent(url.password),
  NODE_ENV: 'test', JWT_SECRET: crypto.randomBytes(32).toString('hex'), RELAYHALL_SESSIONS: 'on',
});
const express = require('express');
const { pool } = require('../db/connection');
const { registerProtectedRoutes } = require('../routeRegistry');
const { authMiddleware } = require('../middleware/auth');
const { sharedAuthorizationMiddleware } = require('../middleware/sharedAuthorization');
const { apiErrorHandler } = require('../utils/apiErrors');
const { loginSessionService, SESSION_COOKIE_NAME } = require('../services/LoginSessionService');
const { principalService } = require('../services/PrincipalService');
const { stepUpService } = require('../services/StepUpService');
const { insertGroupRow } = require('./support/groupRows');

jest.setTimeout(120_000);

type Caller = { id: string; headers: Record<string, string> };
let server: http.Server;
let origin: string;
let first: Caller;          // the administrator Account
let firstConnector: Caller; // its Connector (skills:read, skills:write)
let second: Caller;         // the Skill author Account (editor)
let secondConnector: Caller;
let third: Caller;          // an unrelated author Account (editor)

const tag = () => crypto.randomBytes(5).toString('hex');
const SYSTEM = { handle: 'skill-ownership-live-fixture', authMethod: 'system' as const };
const MIGRATION = fs.readFileSync(path.join(__dirname, '..', 'migrations', '162_skill_owner.sql'), 'utf8');
const FIRST_ACCOUNT = '15e4255b-3dc9-42da-a892-b5f0a95293b4';
const SECOND_ACCOUNT = '731c8872-6773-48cb-bc46-e3a364d1c316';

/** The 27 ids of the migration's list, read from the migration itself. */
function listedIds(): string[] {
  const block = MIGRATION.split('AND s.id IN (')[1].split(')')[0];
  return [...block.matchAll(/'([0-9a-f-]{36})'/g)].map((match) => match[1]);
}

async function call(who: Caller, method: string, route: string, body?: unknown, revision?: string) {
  const response = await fetch(origin + route, {
    method,
    headers: { 'Content-Type': 'application/json', ...who.headers, ...(revision ? { 'If-Match': revision } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  let json: any = null;
  try { json = JSON.parse(text); } catch { json = null; }
  return { status: response.status, body: json };
}

async function account(label: string, role: string): Promise<Caller> {
  const id = (await pool.query(
    `INSERT INTO principals(kind, handle, display_name, status, role)
     VALUES ('human', $1, $1, 'active', $2) RETURNING id`, [`skillown-${label}-${tag()}`, role],
  )).rows[0].id;
  const session = await loginSessionService.mint({ principalId: id });
  return { id, headers: { Cookie: `${SESSION_COOKIE_NAME}=${session.token}` } };
}

async function connectorOf(parent: Caller): Promise<Caller> {
  const id = (await pool.query(
    `INSERT INTO principals(kind, handle, status, parent_principal_id, purpose, own_expression)
     VALUES ('service', $1, 'active', $2, 'Skill ownership fixture', $3) RETURNING id`,
    [`skillown-connector-${tag()}`, parent.id, JSON.stringify({ scopes: 'parent', objects: 'parent' })],
  )).rows[0].id;
  const issued = await principalService.issueCredential(
    { principalId: id, scopes: ['skills:read', 'skills:use', 'skills:write', 'tasks:read'], transport: 'any' }, SYSTEM);
  return { id, headers: { Authorization: `Bearer ${issued.fullKey}` } };
}

function skillMd(name: string, body = 'Skill ownership proof body.'): string {
  return ['---', `name: ${name}`, 'description: Skill ownership proof', '---', '', body, ''].join('\n');
}

/** An imported draft written the way an import writes one: no owner, one draft Version by `creator`. */
async function importedDraft(creator: string, label: string): Promise<{ id: string; name: string }> {
  const name = `skillown-${label}-${tag()}`;
  const id = (await pool.query('INSERT INTO skills(name) VALUES ($1) RETURNING id', [name])).rows[0].id;
  const version = (await pool.query(
    `INSERT INTO skill_versions (skill_id, version, skill_md, description, provenance, source_uri, created_by_principal_id)
     VALUES ($1, 1, $2, 'Skill ownership proof', 'imported', 'urn:example:skill-ownership', $3) RETURNING id`,
    [id, skillMd(name), creator])).rows[0].id;
  await pool.query(`INSERT INTO skill_version_events (skill_version_id, status, actor_principal_id, note)
    VALUES ($1, 'draft', $2, 'fixture import')`, [version, creator]);
  return { id, name };
}

const revisionOf = async (id: string): Promise<string> =>
  (await pool.query('SELECT revision::text AS r FROM skills WHERE id = $1', [id])).rows[0].r;
const names = (body: any): string[] => (body?.skills ?? []).map((skill: any) => skill.name);
/** The session brief is a credential's (POST /principals/me/brief answers 404 to a login session). */
const briefOf = async (who: Caller): Promise<string> => {
  const answer = await call(who, 'POST', '/principals/me/brief', {});
  expect(answer.status).toBe(200);
  return JSON.stringify(answer.body);
};

beforeAll(async () => {
  await pool.query(`INSERT INTO principals(kind, handle, display_name, role)
    VALUES ('human', 'dashboard_user', 'Owner', 'orchestrator') ON CONFLICT (handle) DO NOTHING`);
  const app = express();
  app.use(express.json());
  registerProtectedRoutes((mount: string, ...handlers: any[]) => {
    app.use(mount, authMiddleware, sharedAuthorizationMiddleware, ...handlers);
  });
  app.use(apiErrorHandler);
  await new Promise<void>((resolve) => { server = app.listen(0, '127.0.0.1', resolve); });
  origin = `http://127.0.0.1:${(server.address() as any).port}`;
  first = await account('first', 'admin');
  firstConnector = await connectorOf(first);
  second = await account('second', 'editor');
  secondConnector = await connectorOf(second);
  third = await account('third', 'editor');
});

afterAll(async () => {
  if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  await pool.end();
});

describe('M: migration 162 assigns by its explicit list, in a rolled-back transaction', () => {
  it('lists exactly 27 distinct Skill ids', () => {
    const ids = listedIds();
    expect(ids).toHaveLength(27);
    expect(new Set(ids).size).toBe(27);
    expect([...ids].sort()).toEqual(ids);
  });

  it('assigns the 27 to the second Account, the rest to the first, keeps an owned Skill, and re-runs as a no-op', async () => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      for (const id of [FIRST_ACCOUNT, SECOND_ACCOUNT]) {
        await client.query(`INSERT INTO principals (id, kind, handle, display_name, status)
          VALUES ($1, 'human', $2, $2, 'active') ON CONFLICT (id) DO NOTHING`, [id, `skillown-fixed-${id.slice(0, 8)}`]);
      }
      for (const id of listedIds()) {
        await client.query('INSERT INTO skills (id, name) VALUES ($1, $2)', [id, `skillown-listed-${id.slice(0, 8)}`]);
      }
      const other = (await client.query("INSERT INTO skills (name) VALUES ($1) RETURNING id", [`skillown-other-${tag()}`])).rows[0].id;
      const kept = (await client.query('INSERT INTO skills (name, owner_principal_id) VALUES ($1, $2) RETURNING id',
        [`skillown-kept-${tag()}`, third.id])).rows[0].id;
      await client.query('UPDATE skills SET owner_principal_id = NULL WHERE id = ANY($1::uuid[])', [listedIds()]);
      await client.query(MIGRATION);
      const owners = await client.query(
        'SELECT id::text AS id, owner_principal_id::text AS owner FROM skills WHERE id = ANY($1::uuid[])',
        [[...listedIds(), other, kept]]);
      const byId = new Map(owners.rows.map((row: any) => [row.id, row.owner]));
      for (const id of listedIds()) expect(byId.get(id)).toBe(SECOND_ACCOUNT);
      expect(byId.get(other)).toBe(FIRST_ACCOUNT);
      expect(byId.get(kept)).toBe(third.id);
      expect((await client.query('SELECT count(*)::int AS n FROM skills WHERE owner_principal_id IS NULL')).rows[0].n).toBe(0);
      const before = (await client.query('SELECT id, owner_principal_id, revision FROM skills ORDER BY id')).rows;
      await client.query(MIGRATION);
      expect((await client.query('SELECT id, owner_principal_id, revision FROM skills ORDER BY id')).rows).toEqual(before);
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
  });

  it('assigns nothing where the two Accounts do not exist', async () => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      expect((await client.query('SELECT count(*)::int AS n FROM principals WHERE id = ANY($1::uuid[])',
        [[FIRST_ACCOUNT, SECOND_ACCOUNT]])).rows[0].n).toBe(0);
      const unowned = (await client.query("INSERT INTO skills (name) VALUES ($1) RETURNING id", [`skillown-none-${tag()}`])).rows[0].id;
      await client.query(MIGRATION);
      expect((await client.query('SELECT owner_principal_id FROM skills WHERE id = $1', [unowned])).rows[0].owner_principal_id).toBeNull();
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
  });

  it('refuses a Connector, an Agent-shaped principal or an unknown id as owner, and admits an Account or a Group', async () => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      // The migration's own trigger text, applied in this transaction (CREATE OR REPLACE).
      await client.query(MIGRATION);
      const skill = (await client.query("INSERT INTO skills (name) VALUES ($1) RETURNING id", [`skillown-shape-${tag()}`])).rows[0].id;
      for (const bad of [firstConnector.id, crypto.randomUUID()]) {
        await client.query('SAVEPOINT shape');
        await expect(client.query('UPDATE skills SET owner_principal_id = $2 WHERE id = $1', [skill, bad]))
          .rejects.toMatchObject({ code: expect.stringMatching(/^(23514|23503)$/) });
        await client.query('ROLLBACK TO SAVEPOINT shape');
      }
      await client.query('UPDATE skills SET owner_principal_id = $2 WHERE id = $1', [skill, second.id]);
      const group = await insertGroupRow(client, { name: `skillown shape ${tag()}` });
      await client.query('UPDATE skills SET owner_principal_id = $2 WHERE id = $1', [skill, group]);
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
  });
});

describe('A: two Accounts, after the assignment', () => {
  let drafts: Array<{ id: string; name: string }> = [];
  let published: { id: string; name: string };

  beforeAll(async () => {
    drafts = [await importedDraft(second.id, 'import-a'), await importedDraft(second.id, 'import-b'), await importedDraft(second.id, 'import-c')];
    // A shared, published Skill both Accounts must keep seeing.
    published = await importedDraft(first.id, 'shared');
    expect((await call(first, 'POST', `/skills/${published.id}/versions/1/submit-review`, {}, await revisionOf(published.id))).status).toBe(200);
    // Independent human publisher: an administrator who did not write the Version.
    const publisher = await account('publisher', 'admin');
    expect((await call(publisher, 'POST', `/skills/${published.id}/versions/1/publish`, {}, await revisionOf(published.id))).status).toBe(200);
  });

  it('before the assignment, unowned drafts are visible to every registry manager (the earlier behaviour)', async () => {
    const listed = await call(first, 'GET', '/skills');
    expect(listed.status).toBe(200);
    for (const draft of drafts) expect(names(listed.body)).toContain(draft.name);
  });

  it('the owner act assigns the drafts to the second Account and writes one audit row each', async () => {
    for (const draft of drafts) {
      const answer = await call(first, 'PUT', `/skills/${draft.id}/owner`,
        { ownerPrincipalId: second.id, reason: 'imported drafts belong to their author' }, await revisionOf(draft.id));
      expect(answer.status).toBe(200);
      expect(answer.body).toMatchObject({ success: true, changed: true,
        skill: { id: draft.id, owner_principal_id: second.id, owner_kind: 'human' } });
    }
    // The audit rows are read after every assignment, so a missing row reddens this test alone.
    for (const draft of drafts) {
      const audit = await pool.query(
        `SELECT actor_principal_id::text AS actor, outcome, metadata FROM audit_events
          WHERE action = 'skill.owner.change' AND resource_id = $1`, [draft.id]);
      expect(audit.rows).toHaveLength(1);
      expect(audit.rows[0]).toMatchObject({ actor: first.id, outcome: 'success',
        metadata: { oldOwnerPrincipalId: null, newOwnerPrincipalId: second.id, reason: 'imported drafts belong to their author' } });
    }
  });

  it("the first Account's list and briefs no longer carry the second Account's drafts", async () => {
    for (const who of [first, firstConnector]) {
      const listed = await call(who, 'GET', '/skills');
      expect(listed.status).toBe(200);
      for (const draft of drafts) expect(names(listed.body)).not.toContain(draft.name);
      expect(names(listed.body)).toContain(published.name);
    }
    const brief = await briefOf(firstConnector);
    expect(brief).toContain(published.name);
    expect(brief).not.toContain('yourDrafts');
    for (const draft of drafts) expect(brief).not.toContain(draft.name);
  });

  it("the second Account's list and briefs carry them, the brief under yourDrafts", async () => {
    for (const who of [second, secondConnector]) {
      const listed = await call(who, 'GET', '/skills');
      for (const draft of drafts) expect(names(listed.body)).toContain(draft.name);
      expect(names(listed.body)).toContain(published.name);
    }
    const brief = await briefOf(secondConnector);
    expect(brief).toContain('yourDrafts');
    for (const draft of drafts) expect(brief).toContain(draft.name);
  });

  it('owner=all lists every owner\'s drafts for an administrator only', async () => {
    const all = await call(first, 'GET', '/skills?owner=all');
    expect(all.status).toBe(200);
    for (const draft of drafts) expect(names(all.body)).toContain(draft.name);
    const refused = await call(second, 'GET', '/skills?owner=all');
    expect([refused.status, refused.body?.code]).toEqual([403, 'SKILLS_ADMIN_REQUIRED']);
    expect((await call(first, 'GET', '/skills?owner=mine')).status).toBe(400);
  });

  it('a third Account sees neither the list entry nor the draft by id; the administrator reads it by id', async () => {
    const listed = await call(third, 'GET', '/skills');
    for (const draft of drafts) expect(names(listed.body)).not.toContain(draft.name);
    expect((await call(third, 'GET', `/skills/${drafts[0].id}`)).status).toBe(404);
    expect((await call(third, 'GET', `/skills/${drafts[0].id}/versions/1`)).status).toBe(404);
    const point = await call(first, 'GET', `/skills/${drafts[0].id}`);
    expect([point.status, point.body?.skill?.status]).toEqual([200, 'draft']);
    expect((await call(first, 'GET', `/skills/${drafts[0].id}/versions/1/content`)).status).toBe(200);
  });

  it('a draft submitted for review reaches the administrator\'s default list (the review queue)', async () => {
    const submitted = await call(second, 'POST', `/skills/${drafts[1].id}/versions/1/submit-review`, {}, await revisionOf(drafts[1].id));
    expect(submitted.status).toBe(200);
    const listed = await call(first, 'GET', '/skills');
    expect(names(listed.body)).toContain(drafts[1].name);
    expect(names(listed.body)).not.toContain(drafts[0].name);
    // The connector holds no skills:admin, so the queue is not its view.
    expect(names((await call(firstConnector, 'GET', '/skills')).body)).not.toContain(drafts[1].name);
  });
});

describe('W: the authoring flow once ownership exists', () => {
  it('an unowned Skill refuses its author a new Version until the owner act; then the owner is admitted', async () => {
    const legacy = await importedDraft(second.id, 'legacy');
    const before = await call(second, 'PUT', `/skills/${legacy.id}`, { skill_md: skillMd(legacy.name, 'v2') }, await revisionOf(legacy.id));
    expect([403, 404]).toContain(before.status);
    expect((await call(first, 'PUT', `/skills/${legacy.id}/owner`, { ownerPrincipalId: second.id, reason: 'assign' },
      await revisionOf(legacy.id))).status).toBe(200);
    const after = await call(second, 'PUT', `/skills/${legacy.id}`, { skill_md: skillMd(legacy.name, 'v2') }, await revisionOf(legacy.id));
    expect(after.status).toBe(201);
  });

  it('create, version, submit, see the rejection, revise; publication stays independent and admin-only', async () => {
    const name = `skillown-author-${tag()}`;
    const created = await call(second, 'POST', '/skills', { name, description: 'Skill ownership proof', usage_instructions: 'v1' });
    expect(created.status).toBe(201);
    const id = created.body.skill.id;
    expect(created.body.skill).toMatchObject({ owner_principal_id: second.id, owner_kind: 'human' });
    const create = await pool.query(`SELECT metadata FROM audit_events WHERE action = 'skill.create' AND resource_id = $1`, [id]);
    expect(create.rows[0].metadata.ownerPrincipalId).toBe(second.id);
    expect((await call(second, 'PUT', `/skills/${id}`, { skill_md: skillMd(name, 'v2') }, await revisionOf(id))).status).toBe(201);
    expect((await call(second, 'POST', `/skills/${id}/versions/2/submit-review`, {}, await revisionOf(id))).status).toBe(200);
    expect((await call(first, 'POST', `/skills/${id}/versions/2/reject`, { note: 'tighten the safety section' }, await revisionOf(id))).status).toBe(200);
    const seen = await call(second, 'GET', `/skills/${id}/versions/2`);
    expect(seen.body.version).toMatchObject({ status: 'draft', status_note: 'tighten the safety section' });
    expect((await call(second, 'PUT', `/skills/${id}`, { skill_md: skillMd(name, 'v3') }, await revisionOf(id))).status).toBe(201);
    expect((await call(second, 'POST', `/skills/${id}/versions/3/submit-review`, {}, await revisionOf(id))).status).toBe(200);
    // The author cannot publish: no skills:admin on an editor session.
    expect((await call(second, 'POST', `/skills/${id}/versions/3/publish`, {}, await revisionOf(id))).status).toBe(403);
    // An administrator who wrote the Version cannot publish it either.
    const adminAuthored = await call(first, 'POST', '/skills', { name: `${name}-admin`, description: 'x', usage_instructions: 'x' });
    const adminId = adminAuthored.body.skill.id;
    expect((await call(first, 'POST', `/skills/${adminId}/versions/1/submit-review`, {}, await revisionOf(adminId))).status).toBe(200);
    const self = await call(first, 'POST', `/skills/${adminId}/versions/1/publish`, {}, await revisionOf(adminId));
    expect([self.status, self.body?.code]).toEqual([409, 'INDEPENDENT_REVIEW_REQUIRED']);
    // The independent administrator publishes the author's Version.
    const published = await call(first, 'POST', `/skills/${id}/versions/3/publish`, {}, await revisionOf(id));
    expect(published.status).toBe(200);
  });
});

describe('O: the owner act', () => {
  it('is revision-bound, refuses a non-Account target and a non-admin caller, and answers a no-op', async () => {
    const draft = await importedDraft(second.id, 'owner-act');
    expect((await call(first, 'PUT', `/skills/${draft.id}/owner`, { ownerPrincipalId: second.id, reason: 'r' })).status).toBe(400);
    expect((await call(first, 'PUT', `/skills/${draft.id}/owner`, { ownerPrincipalId: second.id, reason: 'r' },
      crypto.randomUUID())).status).toBe(412);
    const connector = await call(first, 'PUT', `/skills/${draft.id}/owner`, { ownerPrincipalId: firstConnector.id, reason: 'r' }, await revisionOf(draft.id));
    expect([connector.status, connector.body?.code]).toEqual([422, 'INVALID_SKILL_OWNER']);
    expect((await call(second, 'PUT', `/skills/${draft.id}/owner`, { ownerPrincipalId: second.id, reason: 'r' }, await revisionOf(draft.id))).status).toBe(403);
    expect((await call(first, 'PUT', `/skills/${draft.id}/owner`, { ownerPrincipalId: second.id, reason: 'r', extra: 1 }, await revisionOf(draft.id))).status).toBe(400);
    expect((await call(first, 'PUT', `/skills/${draft.id}/owner`, { ownerPrincipalId: second.id, reason: 'r' }, await revisionOf(draft.id))).status).toBe(200);
    const again = await call(first, 'PUT', `/skills/${draft.id}/owner`, { ownerPrincipalId: second.id, reason: 'r' }, await revisionOf(draft.id));
    expect([again.status, again.body?.changed]).toEqual([200, false]);
    const denied = await pool.query(`SELECT count(*)::int AS n FROM audit_events
      WHERE action = 'skill.owner.change' AND resource_id = $1 AND outcome = 'denied'`, [draft.id]);
    expect(denied.rows[0].n).toBeGreaterThanOrEqual(3);
  });

  it('moves a Skill into a Group only through clause 9(e), and the Group\'s members then see its drafts', async () => {
    const draft = await importedDraft(second.id, 'group');
    const group = await insertGroupRow(pool, { name: `skillown group ${tag()}` });
    await pool.query("INSERT INTO group_members (group_id, account_principal_id, source) VALUES ($1, $2, 'local')", [group, third.id]);
    const missing = await call(first, 'PUT', `/skills/${draft.id}/owner`, { ownerPrincipalId: group, reason: 'team skill' }, await revisionOf(draft.id));
    expect([missing.status, missing.body?.code, missing.body?.stepUp?.targetId]).toEqual([403, 'STEP_UP_REQUIRED', draft.id]);
    const minted = await stepUpService.mint(first.id, 'ownership.transfer', draft.id, 'password');
    const moved = await call(first, 'PUT', `/skills/${draft.id}/owner`,
      { ownerPrincipalId: group, reason: 'team skill', stepUpToken: minted.token }, await revisionOf(draft.id));
    expect(moved.status).toBe(200);
    expect(moved.body.skill).toMatchObject({ owner_principal_id: group, owner_kind: 'group' });
    const audit = await pool.query(`SELECT metadata FROM audit_events
      WHERE action = 'skill.owner.change' AND resource_id = $1 AND outcome = 'success'`, [draft.id]);
    expect(audit.rows[0].metadata).toMatchObject({ newOwnerPrincipalId: group, newOwnerKind: 'group',
      groupMemberCountAtTransfer: 1, deciderStanding: 'root' });
    expect(names((await call(third, 'GET', '/skills')).body)).toContain(draft.name);
    expect(names((await call(second, 'GET', '/skills')).body)).not.toContain(draft.name);
    // Membership is refused first (GROUP_NOT_EMPTY); with no member left the owned Skill refuses the delete.
    await pool.query('DELETE FROM group_members WHERE group_id = $1', [group]);
    const remove = await call(first, 'DELETE', `/groups/${group}`);
    expect(remove.status).toBe(409);
    expect([remove.body?.code, remove.body?.details?.owned?.skills]).toEqual(['GROUP_OWNS_OBJECTS', 1]);
  });
});
