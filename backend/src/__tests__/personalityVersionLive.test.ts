/** Real PostgreSQL and production-router contract. No deployment database is admitted. */
import crypto from 'crypto';
import http from 'http';
import fs from 'fs';
import path from 'path';

const raw = process.env.RELAYHALL_TEST_DB_URL;
if (!raw) throw new Error('Personality version proof requires an explicit disposable database');
const url = new URL(raw);
const dbName = url.pathname.slice(1);
if (!(/^personality_contract_[a-z0-9_]+$/.test(dbName) || (dbName === 'relayhall_ci' && process.env.CI === 'true'))
    || !(['127.0.0.1', 'localhost'].includes(url.hostname)
      || (url.hostname === 'postgres' && process.env.CI === 'true'))) {
  throw new Error('Personality version proof refuses a non-contract database/host');
}
Object.assign(process.env, { DB_HOST: url.hostname, DB_PORT: url.port || '5432', DB_NAME: dbName,
  DB_USER: decodeURIComponent(url.username), DB_PASSWORD: decodeURIComponent(url.password),
  NODE_ENV: 'test', JWT_SECRET: crypto.randomBytes(32).toString('hex'), RELAYHALL_SESSIONS: 'on' });
const { pool } = require('../db/connection');
const { personalityService } = require('../services/PersonalityService');
const { feedEventService } = require('../services/FeedEventService');
const { registerProtectedRoutes } = require('../routeRegistry');
const { authMiddleware } = require('../middleware/auth');
const { sharedAuthorizationMiddleware } = require('../middleware/sharedAuthorization');
const { apiErrorHandler } = require('../utils/apiErrors');
const { loginSessionService, SESSION_COOKIE_NAME } = require('../services/LoginSessionService');
const express = require('express');
jest.setTimeout(60_000);
let server: http.Server, origin: string;
let rootCookie: string, memberCookie: string;
const unique = () => 'pv-' + crypto.randomBytes(8).toString('hex');
async function create() { return personalityService.create({ slug: unique(), name: 'Version probe', content: 'initial bytes' }); }
async function state(id: string) {
  return (await pool.query(`SELECT p.*, (SELECT jsonb_agg(to_jsonb(v) ORDER BY v.version)
    FROM personality_versions v WHERE v.personality_id=p.id) AS history
    FROM personalities p WHERE p.id=$1`, [id])).rows[0];
}
async function call(cookie: string, method: string, route: string, body?: any) {
  const response = await fetch(origin + route, { method, headers: { Cookie: cookie, 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return { status: response.status, body: await response.json() as any };
}
async function waitBlocked(pid: number) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const row = (await pool.query('SELECT wait_event_type FROM pg_stat_activity WHERE pid=$1', [pid])).rows[0];
    if (row?.wait_event_type === 'Lock') return;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error('The competing writer did not reach an observed PostgreSQL lock wait');
}
beforeAll(async () => {
  const app = express(); app.use(express.json());
  registerProtectedRoutes((mount: string, ...handlers: any[]) => app.use(mount, authMiddleware, sharedAuthorizationMiddleware, ...handlers));
  app.use(apiErrorHandler);
  server = app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  origin = `http://127.0.0.1:${(server.address() as any).port}`;
  const cookies: string[] = [];
  for (const role of ['admin', 'user']) {
    const result = await pool.query(`INSERT INTO principals(kind,handle,display_name,status,role)
      VALUES('human',$1,$1,'active',$2) RETURNING id`, [unique(), role]);
    const session = await loginSessionService.mint({ principalId: result.rows[0].id });
    cookies.push(`${SESSION_COOKIE_NAME}=${session.token}`);
  }
  [rootCookie, memberCookie] = cookies;
});
afterAll(async () => { if (server) await new Promise<void>(resolve => server.close(() => resolve())); await pool.end(); });

test('PV-L1 current detail and summary expose actual version without snapshot leakage', async () => {
  const p = await create(); expect(p.version).toBe(1);
  const detail = await personalityService.getById(p.id);
  const summary = (await personalityService.list()).find((x: any) => x.id === p.id);
  expect(detail.content).toBe('initial bytes'); expect(summary.version).toBe(1);
  expect(summary).not.toHaveProperty('content'); expect(summary).not.toHaveProperty('version_snapshot');
  expect(detail).not.toHaveProperty('current_version');
  const stored = await state(p.id); expect(stored.history).toHaveLength(1);
  expect(stored.history[0].snapshot.content).toBe(p.content);
});
test('PV-L2 every snapshot field advances once and preserves all earlier bytes', async () => {
  const p = await create(); let version = 1;
  for (const [field, value] of Object.entries({ slug: unique(), name: 'Next name', description: '',
    category: 'review', color: 'teal', content: 'next\nbytes', source_file: 'import.md', is_custom: false, source: 'git' })) {
    const before = await state(p.id);
    await pool.query(`UPDATE personalities SET ${field}=$2 WHERE id=$1`, [p.id, value]);
    const after = await state(p.id); expect(after.current_version).toBe(++version);
    expect(after.history.slice(0, -1)).toEqual(before.history);
    expect(after.history.at(-1).snapshot[field]).toEqual(value);
    expect((await personalityService.getById(p.id)).version).toBe(version);
  }
});
test('PV-L3 identical writes and lifecycle retirement preserve the content version', async () => {
  const p = await create(); const before = await state(p.id);
  await personalityService.update(p.id, { content: p.content });
  await personalityService.retire(p.id, 'test retirement');
  const after = await state(p.id); expect(after.current_version).toBe(1);
  expect(after.history).toEqual(before.history); expect(after.retired_at).not.toBeNull();
  expect(await personalityService.update(p.id, { content: 'refused' })).toBeNull();
});
test('PV-L4 direct history update delete insert and truncate are refused', async () => {
  const p = await create(); await personalityService.update(p.id, { content: 'second snapshot' });
  const before = await state(p.id);
  for (const sql of [
    `UPDATE personality_versions SET snapshot=jsonb_set(snapshot,'{content}','"changed history"') WHERE personality_id=$1 AND version=1`,
    `DELETE FROM personality_versions WHERE personality_id=$1 AND version=1`,
    `INSERT INTO personality_versions(personality_id,version,snapshot) SELECT personality_id,999,snapshot FROM personality_versions WHERE personality_id=$1 AND version=1`,
  ]) await expect(pool.query(sql, [p.id])).rejects.toThrow();
  const truncate = await pool.connect();
  try {
    await truncate.query('BEGIN');
    // Isolate this history guard from unrelated CASCADE truncation guards.
    // The disposable transaction restores the reference before returning.
    await truncate.query('ALTER TABLE personalities DROP CONSTRAINT personality_current_version_identity');
    await expect(truncate.query('TRUNCATE personality_versions')).rejects.toThrow('Personality version history is immutable');
  } finally { await truncate.query('ROLLBACK'); truncate.release(); }
  expect(await state(p.id)).toEqual(before);
});
test('PV-L5 pointer identity and parent history cannot be redirected or removed', async () => {
  const p = await create(); const q = await create(); const before = await state(p.id);
  await expect(pool.query('UPDATE personalities SET current_version=999 WHERE id=$1', [p.id])).rejects.toThrow();
  await expect(pool.query('UPDATE personalities SET id=$2 WHERE id=$1', [p.id, crypto.randomUUID()])).rejects.toThrow();
  await expect(pool.query('DELETE FROM personalities WHERE id=$1', [p.id])).rejects.toThrow();
  expect(await state(p.id)).toEqual(before); expect((await state(q.id)).current_version).toBe(1);
});
test('PV-L6 competing writers serialize their version sequence', async () => {
  const p = await create();
  const a = await pool.connect(), b = await pool.connect();
  try {
    const pid = (await b.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
    await a.query('BEGIN'); await b.query('BEGIN');
    await a.query('UPDATE personalities SET content=$2 WHERE id=$1', [p.id, 'first']);
    const waiting = b.query('UPDATE personalities SET content=$2 WHERE id=$1', [p.id, 'second']);
    await waitBlocked(pid);
    await a.query('COMMIT'); await waiting; await b.query('COMMIT');
    const after = await state(p.id); expect(after.current_version).toBe(3);
    expect(after.history.map((v: any) => v.snapshot.content)).toEqual(['initial bytes', 'first', 'second']);
  } finally { await a.query('ROLLBACK'); await b.query('ROLLBACK'); a.release(); b.release(); }
});
test('PV-L7 a writer queued behind retirement cannot change retired content', async () => {
  const p = await create(); const a = await pool.connect(); const b = await pool.connect();
  const pid = (await b.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
  try {
    await a.query('BEGIN'); await a.query('UPDATE personalities SET retired_at=now() WHERE id=$1', [p.id]);
    const connection = jest.spyOn(pool, 'connect').mockResolvedValueOnce(b);
    const waiting = personalityService.update(p.id, { content: 'late content' });
    connection.mockRestore();
    await waitBlocked(pid);
    await a.query('COMMIT'); expect(await waiting).toBeNull();
    const after = await state(p.id); expect(after.current_version).toBe(1); expect(after.content).toBe('initial bytes');
  } finally { await a.query('ROLLBACK'); a.release(); }
});
test('PV-L8 feed failure rolls back create content pointer history and retirement', async () => {
  const p = await create(); const before = await state(p.id); const slug = unique();
  const spy = jest.spyOn(feedEventService, 'emit').mockRejectedValue(new Error('injected feed refusal'));
  try {
    await expect(personalityService.create({ slug, name: 'fail' })).rejects.toThrow('injected feed refusal');
    await expect(personalityService.update(p.id, { content: 'fail' })).rejects.toThrow('injected feed refusal');
    await expect(personalityService.retire(p.id)).rejects.toThrow('injected feed refusal');
  } finally { spy.mockRestore(); }
  expect(await personalityService.getBySlug(slug)).toBeNull(); expect(await state(p.id)).toEqual(before);
});
test('PV-L9 migration replay preserves recorded history exactly', async () => {
  const p = await create(); await personalityService.update(p.id, { name: 'recorded change' });
  const before = await state(p.id);
  await pool.query(fs.readFileSync(path.join(__dirname, '../migrations/130_personality_versions.sql'), 'utf8'));
  expect(await state(p.id)).toEqual(before);
});
test('PV-L10 production routes retain scope and management checks with current versions', async () => {
  const created = await call(rootCookie, 'POST', '/personalities', { slug: unique(), name: 'Router version', content: 'private content' });
  expect(created.status).toBe(201); expect(created.body.personality.version).toBe(1);
  const id = created.body.personality.id;
  const rootDetail = await call(rootCookie, 'GET', '/personalities/' + id);
  expect(rootDetail.status).toBe(200); expect(rootDetail.body.personality.version).toBe(1);
  const memberBefore = await call(memberCookie, 'GET', '/personalities/' + id);
  const memberList = await call(memberCookie, 'GET', '/personalities');
  const memberIds = memberList.body.personalities?.map((x: any) => x.id) || [];
  expect(memberIds.includes(id)).toBe(memberBefore.status === 200);
  expect((await call(memberCookie, 'PATCH', '/personalities/' + id, { content: 'not permitted' })).status).toBe(403);
  const changed = await call(rootCookie, 'PATCH', '/personalities/' + id, { content: 'next bytes' });
  expect(changed.status).toBe(200); expect(changed.body.personality.version).toBe(2);
  expect((await call(memberCookie, 'GET', '/personalities/' + id)).status).toBe(memberBefore.status);
  const retired = await call(rootCookie, 'DELETE', '/personalities/' + id);
  expect(retired.status).toBe(200); expect(retired.body.personality.version).toBe(2);
  expect((await call(rootCookie, 'GET', '/personalities')).body.personalities.some((x: any) => x.id === id)).toBe(false);
});
test('PV-L11 snapshot append failure leaves compatibility pointer history and feed unchanged', async () => {
  const p = await create(); const before = await state(p.id);
  const feedBefore = (await pool.query('SELECT count(*)::int AS n FROM feed_events WHERE object_id=$1', [p.id])).rows[0].n;
  await pool.query(`CREATE FUNCTION pv_contract_refuse_append() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN RAISE EXCEPTION 'injected snapshot refusal'; END $$;
    CREATE TRIGGER pv_contract_refuse_append BEFORE INSERT ON personality_versions
    FOR EACH ROW EXECUTE FUNCTION pv_contract_refuse_append()`);
  try { await expect(personalityService.update(p.id, { content: 'refused snapshot' })).rejects.toThrow(); }
  finally { await pool.query('DROP TRIGGER pv_contract_refuse_append ON personality_versions; DROP FUNCTION pv_contract_refuse_append()'); }
  expect(await state(p.id)).toEqual(before);
  expect((await pool.query('SELECT count(*)::int AS n FROM feed_events WHERE object_id=$1', [p.id])).rows[0].n).toBe(feedBefore);
});
test('PV-L12 an exhausted integer sequence refuses atomically', async () => {
  const p = await create(); const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // Only this disposable transaction disables guards to place the boundary
    // fixture. The guards are restored before exercising the production write.
    await client.query('ALTER TABLE personalities DISABLE TRIGGER personality_version_prepare');
    await client.query('ALTER TABLE personalities DISABLE TRIGGER personality_version_append');
    await client.query('ALTER TABLE personality_versions DISABLE TRIGGER personality_versions_immutable');
    await client.query(`INSERT INTO personality_versions(personality_id,version,snapshot)
      SELECT personality_id,2147483647,snapshot FROM personality_versions WHERE personality_id=$1 AND version=1`, [p.id]);
    await client.query('UPDATE personalities SET current_version=2147483647 WHERE id=$1', [p.id]);
    await client.query('SET CONSTRAINTS ALL IMMEDIATE');
    await client.query('ALTER TABLE personalities ENABLE TRIGGER personality_version_prepare');
    await client.query('ALTER TABLE personalities ENABLE TRIGGER personality_version_append');
    await client.query('ALTER TABLE personality_versions ENABLE TRIGGER personality_versions_immutable');
    await client.query('SAVEPOINT boundary');
    await expect(client.query('UPDATE personalities SET content=$2 WHERE id=$1', [p.id, 'overflow'])).rejects.toThrow();
    await client.query('ROLLBACK TO SAVEPOINT boundary');
    const row = (await client.query('SELECT current_version,content FROM personalities WHERE id=$1', [p.id])).rows[0];
    expect(row).toEqual({ current_version: 2147483647, content: 'initial bytes' });
  } finally { await client.query('ROLLBACK'); client.release(); }
  expect((await state(p.id)).current_version).toBe(1);
});
